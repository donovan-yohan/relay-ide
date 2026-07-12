//! Relay-owned Claude Code PTY sessions.
//!
//! This module is intentionally a narrow one-node runtime, not a generic shell
//! service. It launches only the configured Claude Code executable in the
//! node-owner context, keeps the opaque Session handle server-side, and bounds
//! both the PTY-reader hand-off and retained scrollback. Browser clients poll a
//! cursor; they never receive a process handle or ambient shell authority.

use std::collections::{HashMap, VecDeque};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, TrySendError};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

#[cfg(target_os = "linux")]
use filedescriptor::FileDescriptor;
#[cfg(all(unix, test))]
use nix::{errno::Errno, sys::signal::kill};
#[cfg(unix)]
use nix::{
    sys::signal::{Signal, killpg},
    unistd::{Pid, getpgid, getsid, tcgetpgrp},
};
use portable_pty::{Child, CommandBuilder, MasterPty, PtySize, native_pty_system};
#[cfg(target_os = "linux")]
use std::os::fd::{AsRawFd, RawFd};

use crate::contract::SessionId;

/// Explicit owner home used by the first one-node Claude Session slice.
///
/// It is deliberately not derived from the worker process environment: a Relay
/// worker profile must never become the provider's runtime/auth context.
pub const NODE_OWNER_HOME: &str = "/home/donovanyohan";
/// Fixed installed Claude Code path for the node-owner runtime.
pub const NODE_OWNER_CLAUDE: &str = "/home/donovanyohan/.local/bin/claude";
/// Minimal owner-controlled lookup path needed by the fixed Claude launcher.
pub const NODE_OWNER_PATH: &str = "/home/donovanyohan/.local/bin:/usr/local/bin:/usr/bin:/bin";
/// Fixed shell descriptor supplied to PTY-aware programs.
pub const NODE_OWNER_SHELL: &str = "/bin/bash";

/// A browser-facing PTY read is bounded to this number of bytes.
pub const PTY_READ_BYTES: usize = 4 * 1024;
/// The reader keeps draining this many chunks even when no browser is polling.
pub const PTY_INBOUND_CAP: usize = 64;
/// Scrollback retained by Relay for one live Session. Older data is explicitly
/// truncated rather than making a disconnected browser able to consume memory.
pub const PTY_SCROLLBACK_BYTES: usize = 256 * 1024;
/// One browser poll receives at most this much source output. JSON escaping can
/// expand individual bytes, so this stays below the hub's response envelope
/// even for hostile terminal output.
pub const PTY_DELIVERY_BYTES: usize = 4 * 1024;
/// Input is a keystroke payload, not an unbounded upload channel.
pub const PTY_INPUT_BYTES: usize = 8 * 1024;
/// Input is staged before it reaches the potentially blocking PTY writer.
pub const PTY_INPUT_QUEUE_CAP: usize = 8;
/// Input is acknowledged only after it occupies the bounded Relay queue. A
/// full queue returns retryable backpressure rather than retaining unbounded
/// browser data in the hub request path.
const PTY_INPUT_POLL_INTERVAL: Duration = Duration::from_millis(5);
/// One small node runtime is deliberately capped before it becomes a terminal
/// platform or a hidden process farm.
pub const MAX_PTY_SESSIONS: usize = 8;
const MIN_ROWS: u16 = 4;
const MAX_ROWS: u16 = 300;
const MIN_COLS: u16 = 20;
const MAX_COLS: u16 = 500;
const PTY_TERMINATION_GRACE: Duration = Duration::from_millis(250);
const PTY_REAPER_POLL_INTERVAL: Duration = Duration::from_millis(10);
const PTY_REAPER_DEADLINE: Duration = Duration::from_secs(1);
const PTY_REAPER_MAX_ATTEMPTS: usize = 100;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NodeOwnerContext {
    home: PathBuf,
    claude_path: PathBuf,
}

impl NodeOwnerContext {
    pub fn fixed() -> Self {
        Self {
            home: PathBuf::from(NODE_OWNER_HOME),
            claude_path: PathBuf::from(NODE_OWNER_CLAUDE),
        }
    }

    pub fn home(&self) -> &Path {
        &self.home
    }

    pub fn claude_path(&self) -> &Path {
        &self.claude_path
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClaudePtyStatus {
    Starting,
    Running,
    Exited,
    Closed,
}

impl ClaudePtyStatus {
    pub const fn code(self) -> &'static str {
        match self {
            Self::Starting => "starting",
            Self::Running => "running",
            Self::Exited => "exited",
            Self::Closed => "closed",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ClaudePtyError {
    Unavailable,
    Capacity,
    StaleHandle,
    Forbidden,
    InvalidInput,
    InvalidResize,
    Backpressure,
    InputLost,
    Transport,
}

impl ClaudePtyError {
    pub const fn code(&self) -> &'static str {
        match self {
            Self::Unavailable => "claude_unavailable",
            Self::Capacity => "session_capacity",
            Self::StaleHandle => "stale_session",
            Self::Forbidden => "session_forbidden",
            Self::InvalidInput => "invalid_input",
            Self::InvalidResize => "invalid_resize",
            Self::Backpressure => "input_backpressure",
            Self::InputLost => "input_delivery_lost",
            Self::Transport => "pty_transport",
        }
    }
}

impl std::fmt::Display for ClaudePtyError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.code())
    }
}

impl std::error::Error for ClaudePtyError {}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TerminalOutput {
    pub sequence: u64,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TerminalSnapshot {
    pub session_id: SessionId,
    pub status: ClaudePtyStatus,
    pub output: Vec<TerminalOutput>,
    pub next_cursor: u64,
    pub has_more: bool,
    pub truncated: bool,
    pub dropped_chunks: u64,
}

#[derive(Debug)]
enum ReaderEvent {
    Output(Vec<u8>),
}

#[derive(Debug)]
struct ScrollbackChunk {
    sequence: u64,
    text: String,
    bytes: usize,
}

struct InputRequest {
    data: Vec<u8>,
}

struct PtyInput {
    sender: mpsc::SyncSender<InputRequest>,
    stop: Arc<AtomicBool>,
    delivery_failed: Arc<AtomicBool>,
    worker: JoinHandle<()>,
}

impl PtyInput {
    fn enqueue(&self, data: &[u8]) -> Result<(), ClaudePtyError> {
        if self.delivery_failed.load(Ordering::Acquire) {
            return Err(ClaudePtyError::InputLost);
        }
        let request = InputRequest {
            data: data.to_vec(),
        };
        match self.sender.try_send(request) {
            Ok(()) => Ok(()),
            Err(TrySendError::Full(_)) => Err(ClaudePtyError::Backpressure),
            Err(TrySendError::Disconnected(_)) if self.delivery_failed.load(Ordering::Acquire) => {
                Err(ClaudePtyError::InputLost)
            }
            Err(TrySendError::Disconnected(_)) => Err(ClaudePtyError::Transport),
        }
    }

    fn finish(self) {
        let Self {
            sender,
            stop,
            worker,
            ..
        } = self;
        stop.store(true, Ordering::Release);
        drop(sender);
        // A nonblocking writer observes `stop` between every retry. Never join
        // it on the runtime mutex path: a kernel or driver regression must not
        // turn close/revoke into an unbounded global PTY outage.
        if worker.is_finished() {
            let _ = worker.join();
        }
    }
}

/// Linux ownership for the PTY session created by portable-pty.
///
/// The direct child remains waitable until `ManagedSession::close` has
/// terminated its group, so its PID continues to reserve the original
/// process-group identity for the entire period Relay may call `killpg`. A
/// nonblocking duplicate of the master FD gives the input worker a cancellable
/// writer without consuming the reader.
#[cfg(target_os = "linux")]
struct PtyOwnership {
    process_group: i32,
    writer: FileDescriptor,
    #[cfg(test)]
    foreground_override: Option<ForegroundIdentity>,
}

#[cfg(target_os = "linux")]
struct MasterFd(RawFd);

#[cfg(target_os = "linux")]
impl AsRawFd for MasterFd {
    fn as_raw_fd(&self) -> RawFd {
        self.0
    }
}

#[cfg(target_os = "linux")]
#[derive(Clone, Copy)]
enum ForegroundIdentity {
    NoForegroundGroup,
    ProcessGroup(i32),
    Unavailable,
}

#[cfg(not(target_os = "linux"))]
struct PtyOwnership {
    process_group: i32,
}

struct ManagedSession {
    owner_device_id: String,
    status: ClaudePtyStatus,
    child: Option<Box<dyn Child + Send + Sync>>,
    process_group: Option<PtyOwnership>,
    master: Option<Box<dyn MasterPty + Send>>,
    input: Option<PtyInput>,
    reader: Option<JoinHandle<()>>,
    reader_rx: Receiver<ReaderEvent>,
    reader_stop: Arc<AtomicBool>,
    reader_terminal: Arc<AtomicBool>,
    reader_dropped: Arc<AtomicU64>,
    output: VecDeque<ScrollbackChunk>,
    output_bytes: usize,
    next_sequence: u64,
    pending_utf8: Vec<u8>,
    terminal_seen: bool,
    foreign_foreground_seen: bool,
}

/// A session removed from the runtime mutex before its bounded termination
/// grace begins. The hub finishes this outside the runtime lock so one slow
/// close cannot serialize unrelated terminal control requests.
pub struct PtyTermination {
    session_id: SessionId,
    child: Option<Box<dyn Child + Send + Sync>>,
    process_group: Option<PtyOwnership>,
    master: Option<Box<dyn MasterPty + Send>>,
    reader: Option<JoinHandle<()>>,
    next_cursor: u64,
    dropped_chunks: u64,
}

/// A create operation separates lock-bound runtime bookkeeping from any
/// bounded PTY teardown that the caller must finish after releasing the lock.
pub struct PtyCreate {
    result: Result<SessionId, ClaudePtyError>,
    terminations: Vec<PtyTermination>,
}

impl PtyCreate {
    fn failure(error: ClaudePtyError, terminations: Vec<PtyTermination>) -> Self {
        Self {
            result: Err(error),
            terminations,
        }
    }

    pub fn into_parts(self) -> (Result<SessionId, ClaudePtyError>, Vec<PtyTermination>) {
        (self.result, self.terminations)
    }
}

/// The outcome of selecting PTYs for owner invalidation cleanup.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OwnerSessionCloseDisposition {
    Complete,
    Retry,
}

pub struct OwnerSessionClosures {
    pub terminations: Vec<PtyTermination>,
    pub disposition: OwnerSessionCloseDisposition,
}

/// The node-local source of truth for Relay-owned Claude PTY Session handles.
///
/// It is expected to live behind the hub/node's internal mutex. The browser
/// receives only opaque IDs and bounded snapshots; it cannot name an arbitrary
/// command, cwd, PID, or environment.
pub struct NodePtyRuntime {
    owner: NodeOwnerContext,
    launch_directory: PathBuf,
    /// Empty in production. Tests may inject a fixed fixture argument vector;
    /// no browser/API request can influence this field.
    arguments: Vec<String>,
    sessions: HashMap<String, ManagedSession>,
    next_id: u64,
}

impl Default for NodePtyRuntime {
    fn default() -> Self {
        Self::new(NodeOwnerContext::fixed())
    }
}

impl NodePtyRuntime {
    pub fn new(owner: NodeOwnerContext) -> Self {
        let launch_directory = owner.home.clone();
        Self {
            owner,
            launch_directory,
            arguments: Vec::new(),
            sessions: HashMap::new(),
            next_id: 1,
        }
    }

    pub fn owner(&self) -> &NodeOwnerContext {
        &self.owner
    }

    /// Deterministic development fixture for browser integration tests.
    ///
    /// This is deliberately compiled only for debug builds and runs one fixed
    /// echo fixture with an explicit interrupt trap. It is not a configurable
    /// shell command surface and cannot be enabled in a release build.
    #[cfg(debug_assertions)]
    pub fn test_fixture_cat() -> Self {
        let mut runtime = Self::default();
        runtime.owner.claude_path = PathBuf::from("/bin/sh");
        runtime.launch_directory = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/"));
        runtime.arguments = vec![
            "-c".into(),
            "trap 'exit 0' INT; while IFS= read -r line; do printf '%s\\n' \"$line\"; done".into(),
        ];
        runtime
    }

    /// Start the fixed Claude Code TUI in a real PTY. No caller-controlled
    /// command, arguments, HOME, PATH, or working directory enter this path.
    pub fn create(&mut self, owner_device_id: &str) -> Result<SessionId, ClaudePtyError> {
        let (result, terminations) = self.begin_create(owner_device_id).into_parts();
        for termination in terminations {
            let _ = termination.finish();
        }
        result
    }

    /// Begin fixed-PTY creation while the runtime is locked. Any automatic
    /// pruning or partially-started PTY cleanup is returned to the caller so
    /// TERM/KILL grace never runs under the hub's global PTY mutex.
    pub fn begin_create(&mut self, owner_device_id: &str) -> PtyCreate {
        if owner_device_id.is_empty() || owner_device_id.len() > 64 {
            return PtyCreate::failure(ClaudePtyError::Forbidden, Vec::new());
        }
        let mut terminations = self.begin_prune_finished_sessions();
        if self.sessions.len() >= MAX_PTY_SESSIONS {
            return PtyCreate::failure(ClaudePtyError::Capacity, terminations);
        }

        let pty_system = native_pty_system();
        let pair = match pty_system.openpty(default_size()) {
            Ok(pair) => pair,
            Err(_) => return PtyCreate::failure(ClaudePtyError::Transport, terminations),
        };
        let mut command = CommandBuilder::new(self.owner.claude_path());
        command.env_clear();
        for argument in &self.arguments {
            command.arg(argument);
        }
        command.cwd(&self.launch_directory);
        command.env("HOME", self.owner.home());
        command.env("USER", "donovanyohan");
        command.env("LOGNAME", "donovanyohan");
        command.env("PATH", NODE_OWNER_PATH);
        command.env("SHELL", NODE_OWNER_SHELL);
        command.env("TERM", "xterm-256color");
        command.env("COLORTERM", "truecolor");

        let mut child = match pair.slave.spawn_command(command) {
            Ok(child) => child,
            Err(_) => return PtyCreate::failure(ClaudePtyError::Unavailable, terminations),
        };
        drop(pair.slave);
        let process_group = child
            .process_id()
            .and_then(|process_id| session_process_group(process_id, pair.master.as_ref()));
        #[cfg(unix)]
        if process_group.is_none() {
            // Do not admit a Session whose descendants could not be reaped as
            // a Relay-owned group. portable-pty supplies this on Unix; a
            // missing identity is a fail-closed transport setup failure.
            let _ = child.kill();
            reap_child(child);
            return PtyCreate::failure(ClaudePtyError::Transport, terminations);
        }
        let id = format!("claude-pty-{}", self.next_id);
        self.next_id = self.next_id.saturating_add(1);
        let session_id = SessionId::new(id.clone());
        let reader = match pair.master.try_clone_reader() {
            Ok(reader) => reader,
            Err(_) => {
                terminations.push(PtyTermination::startup_failure(
                    session_id,
                    child,
                    process_group,
                    pair.master,
                ));
                return PtyCreate::failure(ClaudePtyError::Transport, terminations);
            }
        };
        let input = match process_group
            .as_ref()
            .ok_or(ClaudePtyError::Transport)
            .and_then(spawn_input_writer)
        {
            Ok(input) => input,
            Err(error) => {
                terminations.push(PtyTermination::startup_failure(
                    session_id,
                    child,
                    process_group,
                    pair.master,
                ));
                return PtyCreate::failure(error, terminations);
            }
        };
        let (reader_tx, reader_rx) = mpsc::sync_channel(PTY_INBOUND_CAP);
        let reader_stop = Arc::new(AtomicBool::new(false));
        let reader_terminal = Arc::new(AtomicBool::new(false));
        let reader_dropped = Arc::new(AtomicU64::new(0));
        let reader_thread = match spawn_reader(
            reader,
            reader_tx,
            Arc::clone(&reader_stop),
            Arc::clone(&reader_terminal),
            Arc::clone(&reader_dropped),
        ) {
            Ok(reader_thread) => reader_thread,
            Err(error) => {
                input.finish();
                terminations.push(PtyTermination::startup_failure(
                    session_id,
                    child,
                    process_group,
                    pair.master,
                ));
                return PtyCreate::failure(error, terminations);
            }
        };

        self.sessions.insert(
            id,
            ManagedSession {
                owner_device_id: owner_device_id.to_owned(),
                status: ClaudePtyStatus::Starting,
                child: Some(child),
                process_group,
                master: Some(pair.master),
                input: Some(input),
                reader: Some(reader_thread),
                reader_rx,
                reader_stop,
                reader_terminal,
                reader_dropped,
                output: VecDeque::new(),
                output_bytes: 0,
                next_sequence: 1,
                pending_utf8: Vec::new(),
                terminal_seen: false,
                foreign_foreground_seen: false,
            },
        );
        PtyCreate {
            result: Ok(session_id),
            terminations,
        }
    }

    /// Return an incremental, loss-aware output snapshot. Disconnection merely
    /// stops polling; it never blocks the PTY reader or closes the Session.
    pub fn poll(
        &mut self,
        session_id: &str,
        owner_device_id: &str,
        cursor: u64,
    ) -> Result<TerminalSnapshot, ClaudePtyError> {
        let session = self.session_mut(session_id, owner_device_id)?;
        session.pump();
        let first_sequence = session
            .output
            .front()
            .map_or(session.next_sequence, |chunk| chunk.sequence);
        let truncated = cursor.saturating_add(1) < first_sequence;
        let mut output = Vec::new();
        let mut output_bytes: usize = 0;
        let mut next_cursor = cursor;
        let mut has_more = false;
        for chunk in session
            .output
            .iter()
            .filter(|chunk| chunk.sequence > cursor)
        {
            if !output.is_empty() && output_bytes.saturating_add(chunk.bytes) > PTY_DELIVERY_BYTES {
                has_more = true;
                break;
            }
            output_bytes = output_bytes.saturating_add(chunk.bytes);
            next_cursor = chunk.sequence;
            output.push(TerminalOutput {
                sequence: chunk.sequence,
                text: chunk.text.clone(),
            });
        }
        Ok(TerminalSnapshot {
            session_id: SessionId::new(session_id),
            status: session.status,
            output,
            next_cursor,
            has_more,
            truncated,
            dropped_chunks: session.reader_dropped.load(Ordering::Acquire),
        })
    }

    pub fn input(
        &mut self,
        session_id: &str,
        owner_device_id: &str,
        data: &str,
    ) -> Result<(), ClaudePtyError> {
        if data.is_empty() || data.len() > PTY_INPUT_BYTES || data.contains('\0') {
            return Err(ClaudePtyError::InvalidInput);
        }
        let session = self.session_mut(session_id, owner_device_id)?;
        session.pump();
        if session.status == ClaudePtyStatus::Closed || session.status == ClaudePtyStatus::Exited {
            return Err(ClaudePtyError::StaleHandle);
        }
        session
            .input
            .as_ref()
            .ok_or(ClaudePtyError::StaleHandle)?
            .enqueue(data.as_bytes())
    }

    pub fn resize(
        &mut self,
        session_id: &str,
        owner_device_id: &str,
        cols: u16,
        rows: u16,
    ) -> Result<(), ClaudePtyError> {
        if !(MIN_COLS..=MAX_COLS).contains(&cols) || !(MIN_ROWS..=MAX_ROWS).contains(&rows) {
            return Err(ClaudePtyError::InvalidResize);
        }
        let session = self.session_mut(session_id, owner_device_id)?;
        session.pump();
        let master = session.master.as_mut().ok_or(ClaudePtyError::StaleHandle)?;
        master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|_| ClaudePtyError::Transport)
    }

    /// Send terminal interrupt (`Ctrl-C`) to the PTY foreground process group.
    pub fn interrupt(
        &mut self,
        session_id: &str,
        owner_device_id: &str,
    ) -> Result<(), ClaudePtyError> {
        self.input(session_id, owner_device_id, "\u{3}")
    }

    /// Explicit close owns child termination/reaping. Layout close must call
    /// detach instead; this is intentionally a distinct endpoint.
    pub fn close(
        &mut self,
        session_id: &str,
        owner_device_id: &str,
    ) -> Result<TerminalSnapshot, ClaudePtyError> {
        self.begin_close(session_id, owner_device_id)?.finish()
    }

    /// Remove a Session under the runtime lock, then let the caller finish its
    /// bounded TERM/KILL teardown without serializing other terminal controls.
    pub fn begin_close(
        &mut self,
        session_id: &str,
        owner_device_id: &str,
    ) -> Result<PtyTermination, ClaudePtyError> {
        let session = self
            .sessions
            .get_mut(session_id)
            .ok_or(ClaudePtyError::StaleHandle)?;
        if session.owner_device_id != owner_device_id {
            return Err(ClaudePtyError::Forbidden);
        }
        session.pump();
        if !session.foreground_is_owned() {
            return Err(ClaudePtyError::Transport);
        }
        let session = self
            .sessions
            .remove(session_id)
            .expect("checked session remains present until this mutable operation");
        Ok(session.into_termination(session_id))
    }

    fn session_mut(
        &mut self,
        session_id: &str,
        owner_device_id: &str,
    ) -> Result<&mut ManagedSession, ClaudePtyError> {
        let session = self
            .sessions
            .get_mut(session_id)
            .ok_or(ClaudePtyError::StaleHandle)?;
        if session.owner_device_id != owner_device_id {
            return Err(ClaudePtyError::Forbidden);
        }
        Ok(session)
    }

    /// Tear down terminal records that have already reached a terminal state
    /// before they can consume another live-session slot. Keeping an exited
    /// record until the next create lets a browser observe the terminal result,
    /// while the next create deterministically releases its PTY resources.
    #[cfg(test)]
    fn prune_finished_sessions(&mut self) {
        for termination in self.begin_prune_finished_sessions() {
            let _ = termination.finish();
        }
    }

    fn begin_prune_finished_sessions(&mut self) -> Vec<PtyTermination> {
        let session_ids = self
            .sessions
            .iter_mut()
            .filter_map(|(session_id, session)| {
                session.pump();
                (session.foreground_is_owned()
                    && matches!(
                        session.status,
                        ClaudePtyStatus::Closed | ClaudePtyStatus::Exited
                    ))
                .then(|| session_id.clone())
            })
            .collect::<Vec<_>>();
        session_ids
            .into_iter()
            .filter_map(|session_id| {
                self.sessions
                    .remove(&session_id)
                    .map(|session| session.into_termination(&session_id))
            })
            .collect()
    }

    /// Reap every PTY bound to a browser-device identity after that browser
    /// session is revoked. The opaque browser session token never crosses the
    /// auth boundary; this runtime only receives its already-authenticated
    /// device identity.
    pub fn begin_owner_session_closes(&mut self, owner_device_id: &str) -> OwnerSessionClosures {
        let session_ids = self
            .sessions
            .iter()
            .filter(|(_, session)| session.owner_device_id == owner_device_id)
            .map(|(session_id, _)| session_id.clone())
            .collect::<Vec<_>>();
        let mut disposition = OwnerSessionCloseDisposition::Complete;
        let terminations = session_ids
            .into_iter()
            .filter_map(|session_id| {
                let session = self
                    .sessions
                    .get_mut(&session_id)
                    .expect("collected session remains present until this mutable operation");
                session.pump();
                if !session.foreground_is_owned() {
                    eprintln!("relay Claude PTY teardown refused an unowned foreground group");
                    disposition = OwnerSessionCloseDisposition::Retry;
                    return None;
                }
                self.sessions
                    .remove(&session_id)
                    .map(|session| session.into_termination(&session_id))
            })
            .collect();
        OwnerSessionClosures {
            terminations,
            disposition,
        }
    }

    pub fn close_owner_sessions(&mut self, owner_device_id: &str) {
        let closures = self.begin_owner_session_closes(owner_device_id);
        for termination in closures.terminations {
            let _ = termination.finish();
        }
    }

    #[cfg(test)]
    fn test_runtime(program: &str, arguments: &[&str]) -> Self {
        Self::new_with_program(
            NodeOwnerContext::fixed(),
            PathBuf::from(program),
            arguments
                .iter()
                .map(|argument| (*argument).to_owned())
                .collect(),
        )
    }

    #[cfg(test)]
    fn new_with_program(owner: NodeOwnerContext, program: PathBuf, arguments: Vec<String>) -> Self {
        let mut runtime = Self::new(owner);
        runtime.owner.claude_path = program;
        runtime.launch_directory =
            std::env::current_dir().expect("test process has a working directory");
        runtime.arguments = arguments;
        runtime
    }
}

impl ManagedSession {
    fn pump(&mut self) {
        self.observe_foreground_group();
        while let Ok(ReaderEvent::Output(bytes)) = self.reader_rx.try_recv() {
            self.append_output(bytes);
        }
        if self.reader_terminal.load(Ordering::Acquire) {
            self.flush_pending_output();
            self.terminal_seen = true;
        }
        if self.status == ClaudePtyStatus::Closed {
            return;
        }
        // Do not call `Child::try_wait` here. It reaps the direct PTY leader
        // and releases its numeric process-group identity before explicit
        // close/revoke has finished signalling that group. Reader EOF is the
        // non-reaping terminal observation that is safe to surface to clients.
        if self.terminal_seen {
            self.status = ClaudePtyStatus::Exited;
        } else if self.status == ClaudePtyStatus::Starting {
            self.status = ClaudePtyStatus::Running;
        }
    }

    fn append_output(&mut self, bytes: Vec<u8>) {
        self.append_output_chunk(bytes, false);
    }

    fn flush_pending_output(&mut self) {
        self.append_output_chunk(Vec::new(), true);
    }

    fn append_output_chunk(&mut self, bytes: Vec<u8>, finish: bool) {
        let (text, bytes_len) = decode_terminal_output(&mut self.pending_utf8, bytes, finish);
        if text.is_empty() {
            return;
        }
        let chunk = ScrollbackChunk {
            sequence: self.next_sequence,
            text,
            bytes: bytes_len,
        };
        self.next_sequence = self.next_sequence.saturating_add(1);
        self.output_bytes = self.output_bytes.saturating_add(chunk.bytes);
        self.output.push_back(chunk);
        while self.output_bytes > PTY_SCROLLBACK_BYTES {
            let Some(removed) = self.output.pop_front() else {
                break;
            };
            self.output_bytes = self.output_bytes.saturating_sub(removed.bytes);
        }
    }

    fn observe_foreground_group(&mut self) {
        #[cfg(target_os = "linux")]
        {
            if self
                .process_group
                .as_ref()
                .is_some_and(|ownership| !ownership.foreground_is_owned())
            {
                self.foreign_foreground_seen = true;
            }
        }
    }

    fn foreground_is_owned(&self) -> bool {
        #[cfg(target_os = "linux")]
        {
            !self.foreign_foreground_seen
                && self
                    .process_group
                    .as_ref()
                    .is_some_and(PtyOwnership::foreground_is_owned)
        }
        #[cfg(not(target_os = "linux"))]
        {
            true
        }
    }

    fn into_termination(mut self, session_id: &str) -> PtyTermination {
        self.reader_stop.store(true, Ordering::Release);
        if let Some(input) = self.input.take() {
            input.finish();
        }
        let termination = PtyTermination {
            session_id: SessionId::new(session_id),
            child: self.child.take(),
            process_group: self.process_group.take(),
            master: self.master.take(),
            reader: self.reader.take(),
            next_cursor: self.next_sequence.saturating_sub(1),
            dropped_chunks: self.reader_dropped.load(Ordering::Acquire),
        };
        self.status = ClaudePtyStatus::Closed;
        termination
    }

    fn close(&mut self) {
        if self.status == ClaudePtyStatus::Closed {
            return;
        }
        self.reader_stop.store(true, Ordering::Release);
        let input = self.input.take();
        if !self.foreground_is_owned() {
            eprintln!("relay Claude PTY teardown refused an unowned foreground group");
            if let Some(input) = input {
                input.finish();
            }
            return;
        }
        let process_group = self.process_group.take();
        if let Some(input) = input {
            input.finish();
        }
        if let Some(child) = self.child.take() {
            let _ = terminate_child(child, process_group.as_ref());
        }
        self.master.take();
        drop(process_group);
        if let Some(reader) = self.reader.take() {
            // The reader owns a cloned master FD and can only observe EOF after
            // every slave closes. Do not let an unexpected kernel/driver stall
            // hold the global runtime mutex during close or owner revocation.
            if reader.is_finished() {
                let _ = reader.join();
            }
        }
        self.pump();
        self.flush_pending_output();
        self.status = ClaudePtyStatus::Closed;
    }
}

impl Drop for ManagedSession {
    fn drop(&mut self) {
        self.close();
    }
}

impl PtyTermination {
    fn startup_failure(
        session_id: SessionId,
        child: Box<dyn Child + Send + Sync>,
        process_group: Option<PtyOwnership>,
        master: Box<dyn MasterPty + Send>,
    ) -> Self {
        Self {
            session_id,
            child: Some(child),
            process_group,
            master: Some(master),
            reader: None,
            next_cursor: 0,
            dropped_chunks: 0,
        }
    }

    /// Finish the bounded teardown after the caller has released the runtime
    /// mutex. A terminal signalling failure is returned rather than pretending
    /// that an unverified foreground descendant was reaped.
    pub fn finish(mut self) -> Result<TerminalSnapshot, ClaudePtyError> {
        self.finish_inner()?;
        Ok(TerminalSnapshot {
            session_id: self.session_id.clone(),
            status: ClaudePtyStatus::Closed,
            output: Vec::new(),
            next_cursor: self.next_cursor,
            has_more: false,
            truncated: false,
            dropped_chunks: self.dropped_chunks,
        })
    }

    fn finish_inner(&mut self) -> Result<(), ClaudePtyError> {
        let result = match self.child.take() {
            Some(child) => terminate_child(child, self.process_group.as_ref()),
            None => Ok(()),
        };
        self.master.take();
        self.process_group.take();
        if let Some(reader) = self.reader.take() {
            // The reader owns a cloned master FD. It may still be blocked in a
            // driver read, so joining remains opportunistic outside the mutex.
            if reader.is_finished() {
                let _ = reader.join();
            }
        }
        result
    }
}

impl Drop for PtyTermination {
    fn drop(&mut self) {
        let _ = self.finish_inner();
    }
}

fn default_size() -> PtySize {
    PtySize {
        rows: 36,
        cols: 120,
        pixel_width: 0,
        pixel_height: 0,
    }
}

fn decode_terminal_output(
    pending: &mut Vec<u8>,
    incoming: Vec<u8>,
    finish: bool,
) -> (String, usize) {
    let mut bytes = std::mem::take(pending);
    bytes.extend(incoming);

    let mut input = bytes.as_slice();
    let mut text = String::new();
    let mut consumed: usize = 0;
    while !input.is_empty() {
        match std::str::from_utf8(input) {
            Ok(valid) => {
                text.push_str(valid);
                consumed = consumed.saturating_add(input.len());
                break;
            }
            Err(error) => {
                let valid_up_to = error.valid_up_to();
                text.push_str(
                    std::str::from_utf8(&input[..valid_up_to])
                        .expect("UTF-8 error valid prefix is valid UTF-8"),
                );
                consumed = consumed.saturating_add(valid_up_to);
                match error.error_len() {
                    Some(invalid_len) => {
                        text.push('\u{FFFD}');
                        consumed = consumed.saturating_add(invalid_len);
                        input = &input[valid_up_to + invalid_len..];
                    }
                    None if finish => {
                        text.push('\u{FFFD}');
                        consumed = consumed.saturating_add(input.len() - valid_up_to);
                        break;
                    }
                    None => {
                        pending.extend_from_slice(&input[valid_up_to..]);
                        break;
                    }
                }
            }
        }
    }
    (text, consumed)
}

fn spawn_reader(
    mut reader: Box<dyn Read + Send>,
    sender: mpsc::SyncSender<ReaderEvent>,
    stop: Arc<AtomicBool>,
    terminal: Arc<AtomicBool>,
    dropped: Arc<AtomicU64>,
) -> Result<JoinHandle<()>, ClaudePtyError> {
    thread::Builder::new()
        .name("relay-claude-pty-reader".into())
        .spawn(move || {
            let mut buffer = vec![0_u8; PTY_READ_BYTES];
            loop {
                if stop.load(Ordering::Acquire) {
                    break;
                }
                match reader.read(&mut buffer) {
                    Ok(0) => {
                        terminal.store(true, Ordering::Release);
                        break;
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(PTY_INPUT_POLL_INTERVAL);
                    }
                    Err(_) => {
                        terminal.store(true, Ordering::Release);
                        break;
                    }
                    Ok(length) => {
                        match sender.try_send(ReaderEvent::Output(buffer[..length].to_vec())) {
                            Ok(()) => {}
                            Err(TrySendError::Full(_)) => {
                                dropped.fetch_add(1, Ordering::AcqRel);
                            }
                            Err(TrySendError::Disconnected(_)) => break,
                        }
                    }
                }
            }
        })
        .map_err(|_| ClaudePtyError::Transport)
}

fn spawn_input_writer(ownership: &PtyOwnership) -> Result<PtyInput, ClaudePtyError> {
    #[cfg(target_os = "linux")]
    {
        let mut writer = ownership
            .writer
            .try_clone()
            .map_err(|_| ClaudePtyError::Transport)?;
        let (sender, receiver) = mpsc::sync_channel::<InputRequest>(PTY_INPUT_QUEUE_CAP);
        let stop = Arc::new(AtomicBool::new(false));
        let worker_stop = Arc::clone(&stop);
        let delivery_failed = Arc::new(AtomicBool::new(false));
        let worker_delivery_failed = Arc::clone(&delivery_failed);
        let worker = thread::Builder::new()
            .name("relay-claude-pty-writer".into())
            .spawn(move || {
                while let Ok(request) = receiver.recv() {
                    if deliver_input(&mut writer, request.data, &worker_stop).is_err() {
                        if !worker_stop.load(Ordering::Acquire) {
                            worker_delivery_failed.store(true, Ordering::Release);
                        }
                        break;
                    }
                    if worker_stop.load(Ordering::Acquire) {
                        break;
                    }
                }
            })
            .map_err(|_| ClaudePtyError::Transport)?;
        Ok(PtyInput {
            sender,
            stop,
            delivery_failed,
            worker,
        })
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = ownership;
        Err(ClaudePtyError::Transport)
    }
}

#[cfg(target_os = "linux")]
fn deliver_input(
    writer: &mut FileDescriptor,
    data: Vec<u8>,
    stop: &AtomicBool,
) -> Result<(), ClaudePtyError> {
    let mut written = 0;
    loop {
        if stop.load(Ordering::Acquire) {
            return Err(ClaudePtyError::Transport);
        }
        match writer.write(&data[written..]) {
            Ok(0) => return Err(delivery_error(written)),
            Ok(count) => {
                written = written.saturating_add(count);
                if written == data.len() {
                    return Ok(());
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                thread::sleep(PTY_INPUT_POLL_INTERVAL);
            }
            Err(_) => return Err(delivery_error(written)),
        }
    }
}

fn delivery_error(written: usize) -> ClaudePtyError {
    if written == 0 {
        ClaudePtyError::Transport
    } else {
        ClaudePtyError::InputLost
    }
}

#[cfg(target_os = "linux")]
fn foreground_identity(writer: &FileDescriptor) -> ForegroundIdentity {
    match tcgetpgrp(writer) {
        Ok(process_group) if process_group.as_raw() > 0 => {
            ForegroundIdentity::ProcessGroup(process_group.as_raw())
        }
        // `tcgetpgrp` successfully reported no foreground group. This is not
        // an unavailable identity and cannot smuggle in a foreign numeric PGID.
        Ok(_) => ForegroundIdentity::NoForegroundGroup,
        Err(_) => ForegroundIdentity::Unavailable,
    }
}

#[cfg(target_os = "linux")]
impl PtyOwnership {
    fn foreground_is_owned(&self) -> bool {
        #[cfg(test)]
        let identity = self
            .foreground_override
            .unwrap_or_else(|| foreground_identity(&self.writer));
        #[cfg(not(test))]
        let identity = foreground_identity(&self.writer);
        match identity {
            ForegroundIdentity::NoForegroundGroup => true,
            ForegroundIdentity::ProcessGroup(process_group) => process_group == self.process_group,
            ForegroundIdentity::Unavailable => false,
        }
    }

    fn signal_groups(&self, signal: Signal) -> Result<(), ClaudePtyError> {
        // Relay holds a lifetime-safe identity only for the original group: its
        // direct leader remains unreaped until teardown finishes. A PTY
        // foreground group can outlive its leader, so never convert the numeric
        // `tcgetpgrp` result into `killpg`. Refuse the close instead of risking
        // an unrelated/reused group or claiming to have reaped an unowned one.
        if !self.foreground_is_owned() {
            return Err(ClaudePtyError::Transport);
        }
        // The direct child remains unreaped until this teardown completes, so
        // this numeric group identifier remains Relay-owned and identity-safe.
        let _ = killpg(Pid::from_raw(self.process_group), signal);
        Ok(())
    }
}

fn session_process_group(process_id: u32, master: &(dyn MasterPty + Send)) -> Option<PtyOwnership> {
    #[cfg(target_os = "linux")]
    {
        let process_id = i32::try_from(process_id).ok()?;
        // Clone the actual master descriptor—not its /proc symlink target,
        // which would allocate an unrelated PTY. FileDescriptor provides the
        // safe dup/FIONBIO wrapper, so no raw-FD ownership conversion escapes
        // into Relay.
        let mut writer = FileDescriptor::dup(&MasterFd(master.as_raw_fd()?)).ok()?;
        writer.set_non_blocking(true).ok()?;
        let leader_pid = Pid::from_raw(process_id);
        let process_group = getpgid(Some(leader_pid)).ok()?.as_raw();
        let session_id = getsid(Some(leader_pid)).ok()?.as_raw();
        (process_group == process_id && session_id == process_id).then_some(PtyOwnership {
            process_group,
            writer,
            #[cfg(test)]
            foreground_override: None,
        })
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (process_id, master);
        None
    }
}

fn terminate_child(
    mut child: Box<dyn Child + Send + Sync>,
    ownership: Option<&PtyOwnership>,
) -> Result<(), ClaudePtyError> {
    let result = {
        #[cfg(target_os = "linux")]
        {
            if let Some(ownership) = ownership {
                ownership.signal_groups(Signal::SIGTERM)?;
                thread::sleep(PTY_TERMINATION_GRACE);
                ownership.signal_groups(Signal::SIGKILL)?;
            }
            Ok(())
        }
    };
    let _ = child.kill();
    reap_child(child);
    result
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ReapDisposition {
    Reaped,
    Deadline,
    AttemptsExhausted,
    TryWaitError,
}

fn reap_child(mut child: Box<dyn Child + Send + Sync>) {
    let _ = thread::Builder::new()
        .name("relay-claude-pty-reaper".into())
        .spawn(move || {
            let disposition = reap_child_until(
                child.as_mut(),
                Instant::now() + PTY_REAPER_DEADLINE,
                PTY_REAPER_MAX_ATTEMPTS,
                PTY_REAPER_POLL_INTERVAL,
            );
            if disposition != ReapDisposition::Reaped {
                eprintln!("relay Claude PTY reaper stopped: {disposition:?}");
            }
        });
}

fn reap_child_until(
    child: &mut dyn Child,
    deadline: Instant,
    max_attempts: usize,
    poll_interval: Duration,
) -> ReapDisposition {
    if max_attempts == 0 {
        return ReapDisposition::AttemptsExhausted;
    }
    for attempt in 1..=max_attempts {
        match child.try_wait() {
            Ok(Some(_)) => return ReapDisposition::Reaped,
            Err(_) => return ReapDisposition::TryWaitError,
            Ok(None) if Instant::now() >= deadline => return ReapDisposition::Deadline,
            Ok(None) if attempt == max_attempts => return ReapDisposition::AttemptsExhausted,
            Ok(None) => thread::sleep(poll_interval),
        }
    }
    ReapDisposition::AttemptsExhausted
}

#[cfg(test)]
mod tests {
    use super::*;
    use portable_pty::{ChildKiller, ExitStatus};
    use std::time::{Duration, Instant};

    #[derive(Debug)]
    struct BlockingChild {
        release: Arc<AtomicBool>,
        poll_started: Arc<AtomicBool>,
        reaped: Arc<AtomicBool>,
    }

    #[derive(Debug)]
    struct ErrorChild {
        attempts: Arc<AtomicU64>,
    }

    #[derive(Debug)]
    struct NoopChildKiller;

    impl ChildKiller for NoopChildKiller {
        fn kill(&mut self) -> std::io::Result<()> {
            Ok(())
        }

        fn clone_killer(&self) -> Box<dyn ChildKiller + Send + Sync> {
            Box::new(Self)
        }
    }

    impl ChildKiller for BlockingChild {
        fn kill(&mut self) -> std::io::Result<()> {
            Ok(())
        }

        fn clone_killer(&self) -> Box<dyn ChildKiller + Send + Sync> {
            Box::new(NoopChildKiller)
        }
    }

    impl ChildKiller for ErrorChild {
        fn kill(&mut self) -> std::io::Result<()> {
            Ok(())
        }

        fn clone_killer(&self) -> Box<dyn ChildKiller + Send + Sync> {
            Box::new(NoopChildKiller)
        }
    }

    impl Child for BlockingChild {
        fn try_wait(&mut self) -> std::io::Result<Option<ExitStatus>> {
            self.poll_started.store(true, Ordering::Release);
            if self.release.load(Ordering::Acquire) {
                self.reaped.store(true, Ordering::Release);
                Ok(Some(ExitStatus::with_exit_code(0)))
            } else {
                Ok(None)
            }
        }

        fn wait(&mut self) -> std::io::Result<ExitStatus> {
            panic!("the reaper must poll try_wait instead of blocking on wait")
        }

        fn process_id(&self) -> Option<u32> {
            None
        }
    }

    impl Child for ErrorChild {
        fn try_wait(&mut self) -> std::io::Result<Option<ExitStatus>> {
            self.attempts.fetch_add(1, Ordering::AcqRel);
            Err(std::io::Error::other("persistent wait failure"))
        }

        fn wait(&mut self) -> std::io::Result<ExitStatus> {
            panic!("the reaper must never fall back to blocking wait")
        }

        fn process_id(&self) -> Option<u32> {
            None
        }
    }

    #[test]
    fn owner_context_is_explicit_and_not_process_home() {
        let context = NodeOwnerContext::fixed();
        assert_eq!(context.home(), Path::new(NODE_OWNER_HOME));
        assert_eq!(context.claude_path(), Path::new(NODE_OWNER_CLAUDE));
    }

    #[test]
    fn owner_context_launches_with_an_allowlisted_environment() {
        let mut runtime = NodePtyRuntime::test_runtime("/usr/bin/env", &[]);
        let session = runtime.create("device-a").unwrap();
        let deadline = Instant::now() + Duration::from_secs(2);
        let output = loop {
            let snapshot = runtime.poll(session.as_str(), "device-a", 0).unwrap();
            if !snapshot.output.is_empty() {
                break snapshot
                    .output
                    .into_iter()
                    .flat_map(|chunk| chunk.text.lines().map(str::to_owned).collect::<Vec<_>>())
                    .collect::<Vec<_>>();
            }
            assert!(
                Instant::now() <= deadline,
                "test PTY did not report its launch environment"
            );
            thread::sleep(Duration::from_millis(10));
        };
        let mut output = output;
        output.sort();
        assert_eq!(
            output,
            vec![
                "COLORTERM=truecolor",
                "HOME=/home/donovanyohan",
                "LOGNAME=donovanyohan",
                "PATH=/home/donovanyohan/.local/bin:/usr/local/bin:/usr/bin:/bin",
                "SHELL=/bin/bash",
                "TERM=xterm-256color",
                "USER=donovanyohan",
            ]
        );
        runtime.close(session.as_str(), "device-a").unwrap();
    }

    #[test]
    fn input_and_resize_are_bounded_before_the_pty() {
        let mut runtime = NodePtyRuntime::default();
        assert_eq!(
            runtime.input("missing", "device", &"x".repeat(PTY_INPUT_BYTES + 1)),
            Err(ClaudePtyError::InvalidInput)
        );
        assert_eq!(
            runtime.resize("missing", "device", 1, 1),
            Err(ClaudePtyError::InvalidResize)
        );
    }

    #[test]
    fn stale_handles_fail_closed() {
        let mut runtime = NodePtyRuntime::default();
        assert_eq!(
            runtime.poll("missing", "device", 0),
            Err(ClaudePtyError::StaleHandle)
        );
        assert_eq!(
            runtime.close("missing", "other"),
            Err(ClaudePtyError::StaleHandle)
        );
    }

    #[test]
    fn test_program_constructor_keeps_the_production_owner_context() {
        let runtime = NodePtyRuntime::test_runtime("/bin/sh", &["-c", "printf READY; cat"]);
        assert_eq!(runtime.owner().home(), Path::new(NODE_OWNER_HOME));
        assert_eq!(runtime.owner().claude_path(), Path::new("/bin/sh"));
        assert!(runtime.launch_directory.is_dir());
        assert_ne!(runtime.launch_directory, runtime.owner().home());
    }

    #[test]
    fn production_runtime_fails_closed_when_the_owner_runtime_is_unavailable() {
        let mut runtime = NodePtyRuntime::new(NodeOwnerContext {
            home: PathBuf::from("/definitely/not/a-relay-owner-home"),
            claude_path: PathBuf::from("/bin/sh"),
        });

        assert_eq!(runtime.create("device-a"), Err(ClaudePtyError::Unavailable));
        assert!(runtime.sessions.is_empty());
    }

    #[test]
    fn output_and_close_are_terminal_lifecycle_operations() {
        let mut runtime = NodePtyRuntime::test_runtime("/bin/sh", &["-c", "printf READY; cat"]);
        // The test fixture constructor only changes the executable; the fixed
        // production path has no argument injection surface.
        let session = runtime.create("device-a").unwrap();
        let deadline = Instant::now() + Duration::from_secs(2);
        let first = loop {
            let snapshot = runtime.poll(session.as_str(), "device-a", 0).unwrap();
            if !snapshot.output.is_empty() {
                break snapshot;
            }
            assert!(Instant::now() <= deadline, "test PTY produced no output");
            thread::sleep(Duration::from_millis(10));
        };
        assert_eq!(first.status, ClaudePtyStatus::Running);
        assert!(
            first
                .output
                .iter()
                .any(|chunk| chunk.text.contains("READY"))
        );
        runtime
            .input(session.as_str(), "device-a", "ping\n")
            .unwrap();
        loop {
            let snapshot = runtime
                .poll(session.as_str(), "device-a", first.next_cursor)
                .unwrap();
            if snapshot
                .output
                .iter()
                .any(|chunk| chunk.text.contains("ping"))
            {
                break;
            }
            assert!(
                Instant::now() <= deadline,
                "accepted terminal input did not reach the PTY"
            );
            thread::sleep(Duration::from_millis(10));
        }
        runtime
            .resize(session.as_str(), "device-a", 100, 40)
            .unwrap();
        assert_eq!(
            runtime.poll(session.as_str(), "device-b", first.next_cursor),
            Err(ClaudePtyError::Forbidden)
        );
        assert_eq!(
            runtime.close(session.as_str(), "other"),
            Err(ClaudePtyError::Forbidden)
        );
        let closed = runtime.close(session.as_str(), "device-a").unwrap();
        assert_eq!(closed.status, ClaudePtyStatus::Closed);
        assert!(!runtime.sessions.contains_key(session.as_str()));
    }

    #[test]
    fn begin_close_detaches_the_term_grace_from_the_runtime_mutex_path() {
        let mut runtime = NodePtyRuntime::test_runtime("/bin/sh", &["-c", "sleep 30"]);
        let session = runtime.create("device-a").unwrap();

        let started = Instant::now();
        let termination = runtime.begin_close(session.as_str(), "device-a").unwrap();
        assert!(
            started.elapsed() < Duration::from_millis(50),
            "the runtime lock path must remove the Session before TERM grace"
        );
        assert!(!runtime.sessions.contains_key(session.as_str()));
        assert_eq!(
            termination.finish().unwrap().status,
            ClaudePtyStatus::Closed
        );
    }

    #[test]
    fn automatic_pruning_does_not_wait_through_term_grace_before_create_returns() {
        let mut runtime = NodePtyRuntime::test_runtime("/bin/sh", &["-c", "sleep 30"]);
        let exited = runtime.create("device-a").unwrap();
        runtime.sessions.get_mut(exited.as_str()).unwrap().status = ClaudePtyStatus::Exited;

        let started = Instant::now();
        let (result, terminations) = runtime.begin_create("device-a").into_parts();
        assert!(
            started.elapsed() < Duration::from_millis(50),
            "automatic pruning must detach TERM/KILL grace before the caller releases its runtime mutex"
        );

        let replacement = result.unwrap();
        for termination in terminations {
            termination.finish().unwrap();
        }

        runtime.close(replacement.as_str(), "device-a").unwrap();
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn unavailable_foreground_identity_fails_closed_before_numeric_group_signalling() {
        let mut runtime = NodePtyRuntime::test_runtime(
            "/bin/sh",
            &["-c", "trap '' TERM; while :; do sleep 1; done"],
        );
        let session = runtime.create("device-a").unwrap();
        let process_group = runtime.sessions[session.as_str()]
            .process_group
            .as_ref()
            .expect("Linux test session records a process group")
            .process_group;
        runtime
            .sessions
            .get_mut(session.as_str())
            .unwrap()
            .process_group
            .as_mut()
            .unwrap()
            .foreground_override = Some(ForegroundIdentity::Unavailable);

        assert_eq!(
            runtime.close(session.as_str(), "device-a"),
            Err(ClaudePtyError::Transport),
            "missing foreground identity must refuse teardown instead of issuing killpg"
        );
        assert!(runtime.sessions.contains_key(session.as_str()));

        let _ = killpg(Pid::from_raw(process_group), Signal::SIGKILL);
        if let Some(child) = runtime
            .sessions
            .get_mut(session.as_str())
            .unwrap()
            .child
            .take()
        {
            reap_child(child);
        }
    }

    #[test]
    fn startup_failure_is_typed_and_leaves_no_session_handle() {
        let mut runtime = NodePtyRuntime::test_runtime("/definitely/not/claude", &[]);

        assert_eq!(runtime.create("device-a"), Err(ClaudePtyError::Unavailable));
        assert!(runtime.sessions.is_empty());
    }

    #[test]
    fn split_utf8_output_is_reassembled_without_replacement_characters() {
        let mut pending = Vec::new();
        let (first, first_bytes) =
            decode_terminal_output(&mut pending, b"before \xF0\x9F".to_vec(), false);
        assert_eq!(first, "before ");
        assert_eq!(first_bytes, 7);
        assert_eq!(pending, vec![0xF0, 0x9F]);

        let (second, second_bytes) =
            decode_terminal_output(&mut pending, b"\x98\x80 after".to_vec(), false);
        assert_eq!(second, "😀 after");
        assert_eq!(second_bytes, 10);
        assert!(pending.is_empty());
    }

    #[test]
    fn incomplete_utf8_at_terminal_exit_is_replaced_once() {
        let mut pending = Vec::new();
        let (first, first_bytes) = decode_terminal_output(&mut pending, vec![0xF0, 0x9F], false);
        assert_eq!(first, "");
        assert_eq!(first_bytes, 0);

        let (last, last_bytes) = decode_terminal_output(&mut pending, Vec::new(), true);
        assert_eq!(last, "�");
        assert_eq!(last_bytes, 2);
        assert!(pending.is_empty());
    }

    #[test]
    fn interrupt_reaches_the_foreground_pty_process_group() {
        let mut runtime = NodePtyRuntime::test_runtime(
            "/bin/sh",
            &[
                "-c",
                "trap 'printf INTERRUPTED; exit 0' INT; printf READY; while :; do sleep 1; done",
            ],
        );
        let session = runtime.create("device-a").unwrap();
        let deadline = Instant::now() + Duration::from_secs(2);
        let ready = loop {
            let snapshot = runtime.poll(session.as_str(), "device-a", 0).unwrap();
            if snapshot
                .output
                .iter()
                .any(|chunk| chunk.text.contains("READY"))
            {
                break snapshot;
            }
            assert!(Instant::now() <= deadline, "test PTY did not become ready");
            thread::sleep(Duration::from_millis(10));
        };

        runtime.interrupt(session.as_str(), "device-a").unwrap();
        let interrupted = loop {
            let snapshot = runtime
                .poll(session.as_str(), "device-a", ready.next_cursor)
                .unwrap();
            if snapshot
                .output
                .iter()
                .any(|chunk| chunk.text.contains("INTERRUPTED"))
            {
                break snapshot;
            }
            assert!(
                Instant::now() <= deadline,
                "terminal interrupt was not delivered"
            );
            thread::sleep(Duration::from_millis(10));
        };
        assert_eq!(interrupted.status, ClaudePtyStatus::Exited);
    }

    #[test]
    fn slow_consumer_delivery_is_bounded_and_recoverable_by_cursor() {
        let mut runtime = NodePtyRuntime::test_runtime("/usr/bin/yes", &["terminal output"]);
        let session = runtime.create("device-a").unwrap();
        let deadline = Instant::now() + Duration::from_secs(2);
        while runtime.sessions[session.as_str()]
            .reader_dropped
            .load(Ordering::Acquire)
            == 0
        {
            assert!(
                Instant::now() <= deadline,
                "reader never observed slow-consumer pressure"
            );
            thread::sleep(Duration::from_millis(10));
        }

        let first = runtime.poll(session.as_str(), "device-a", 0).unwrap();
        let delivered = first
            .output
            .iter()
            .map(|chunk| chunk.text.len())
            .sum::<usize>();
        assert!(!first.output.is_empty());
        assert!(delivered <= PTY_DELIVERY_BYTES);
        assert!(
            first.has_more,
            "the cursor must expose retained output incrementally"
        );
        assert!(
            first.dropped_chunks > 0,
            "the reader must report bounded queue drops"
        );

        let reattached = runtime
            .poll(session.as_str(), "device-a", first.next_cursor)
            .unwrap();
        assert_eq!(reattached.session_id, session);
        assert!(reattached.next_cursor >= first.next_cursor);
        runtime.close(session.as_str(), "device-a").unwrap();
    }

    #[test]
    fn saturated_reader_queue_still_releases_a_naturally_exited_session() {
        let mut runtime = NodePtyRuntime::test_runtime(
            "/bin/sh",
            &["-c", "yes saturated-terminal-output | head -c 1048576"],
        );
        let session = runtime.create("device-a").unwrap();
        let deadline = Instant::now() + Duration::from_secs(2);

        loop {
            let managed = &runtime.sessions[session.as_str()];
            if managed.reader_dropped.load(Ordering::Acquire) > 0
                && managed.reader.as_ref().is_some_and(JoinHandle::is_finished)
            {
                break;
            }
            assert!(
                Instant::now() <= deadline,
                "fixture did not fill and drain the non-polling reader queue"
            );
            thread::sleep(Duration::from_millis(10));
        }

        let status = {
            let managed = runtime.sessions.get_mut(session.as_str()).unwrap();
            managed.pump();
            managed.status
        };
        assert_eq!(status, ClaudePtyStatus::Exited);

        runtime.prune_finished_sessions();
        assert!(
            !runtime.sessions.contains_key(session.as_str()),
            "reader EOF must make a saturated non-polling session prunable"
        );
    }

    #[test]
    fn naturally_exited_sessions_do_not_exhaust_live_capacity() {
        let mut runtime = NodePtyRuntime::test_runtime("/bin/sh", &["-c", "exit 0"]);

        for _ in 0..(MAX_PTY_SESSIONS * 2) {
            let session = runtime.create("device-a").unwrap();
            let deadline = Instant::now() + Duration::from_secs(2);
            loop {
                let snapshot = runtime.poll(session.as_str(), "device-a", 0).unwrap();
                if snapshot.status == ClaudePtyStatus::Exited {
                    break;
                }
                assert!(
                    Instant::now() <= deadline,
                    "short-lived PTY did not report terminal exit"
                );
                thread::sleep(Duration::from_millis(10));
            }
        }

        let replacement = runtime.create("device-a").unwrap();
        assert_eq!(runtime.sessions.len(), 1);
        runtime.close(replacement.as_str(), "device-a").unwrap();
    }

    #[test]
    fn revoking_an_owner_reaps_only_that_owners_pty_sessions() {
        let mut runtime = NodePtyRuntime::test_runtime("/bin/sh", &["-c", "printf READY; cat"]);
        let revoked = runtime.create("device-revoked").unwrap();
        let retained = runtime.create("device-retained").unwrap();

        runtime.close_owner_sessions("device-revoked");

        assert!(!runtime.sessions.contains_key(revoked.as_str()));
        assert!(runtime.sessions.contains_key(retained.as_str()));
        runtime.close(retained.as_str(), "device-retained").unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn close_reaps_a_descendant_in_the_relay_owned_process_group() {
        let mut runtime = NodePtyRuntime::test_runtime(
            "/bin/sh",
            &[
                "-c",
                "sh -c 'trap \"\" TERM; while :; do sleep 1; done' & child=$!; printf 'CHILD:%s\\n' \"$child\"; wait \"$child\"",
            ],
        );
        let session = runtime.create("device-a").unwrap();
        let deadline = Instant::now() + Duration::from_secs(2);
        let child_pid = loop {
            let snapshot = runtime.poll(session.as_str(), "device-a", 0).unwrap();
            if let Some(pid) = snapshot.output.iter().find_map(|chunk| {
                chunk
                    .text
                    .lines()
                    .find_map(|line| line.trim().strip_prefix("CHILD:")?.parse::<i32>().ok())
            }) {
                break pid;
            }
            assert!(
                Instant::now() <= deadline,
                "test PTY did not report descendant PID"
            );
            thread::sleep(Duration::from_millis(10));
        };

        runtime.close(session.as_str(), "device-a").unwrap();
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            if kill(Pid::from_raw(child_pid), None) == Err(Errno::ESRCH) {
                break;
            }
            assert!(
                Instant::now() <= deadline,
                "Relay close left a PTY descendant alive"
            );
            thread::sleep(Duration::from_millis(10));
        }
    }

    #[cfg(unix)]
    #[test]
    fn delayed_close_after_leader_exit_reaps_the_remaining_pty_group() {
        let mut runtime = NodePtyRuntime::test_runtime(
            "/bin/sh",
            &[
                "-c",
                "sh -c 'trap \"\" TERM; while :; do sleep 1; done' & child=$!; printf 'CHILD:%s\\n' \"$child\"; exit 0",
            ],
        );
        let session = runtime.create("device-a").unwrap();
        let deadline = Instant::now() + Duration::from_secs(2);
        let child_pid = loop {
            let snapshot = runtime.poll(session.as_str(), "device-a", 0).unwrap();
            if let Some(pid) = snapshot.output.iter().find_map(|chunk| {
                chunk
                    .text
                    .lines()
                    .find_map(|line| line.trim().strip_prefix("CHILD:")?.parse::<i32>().ok())
            }) {
                break pid;
            }
            assert!(
                Instant::now() <= deadline,
                "test PTY did not report descendant PID"
            );
            thread::sleep(Duration::from_millis(10));
        };
        thread::sleep(Duration::from_millis(50));
        runtime.close(session.as_str(), "device-a").unwrap();
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            if kill(Pid::from_raw(child_pid), None) == Err(Errno::ESRCH) {
                break;
            }
            assert!(
                Instant::now() <= deadline,
                "delayed Relay close left a descendant or blocked PTY reader alive"
            );
            thread::sleep(Duration::from_millis(10));
        }
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn leader_exit_does_not_release_the_original_process_group_before_close() {
        let mut runtime = NodePtyRuntime::test_runtime(
            "/bin/sh",
            &[
                "-c",
                "sh -c 'trap \"\" HUP TERM; while :; do sleep 1; done' & child=$!; printf 'CHILD:%s\\n' \"$child\"; exit 0",
            ],
        );
        let session = runtime.create("device-a").unwrap();
        let leader_pid = runtime.sessions[session.as_str()]
            .child
            .as_ref()
            .and_then(|child| child.process_id())
            .and_then(|pid| i32::try_from(pid).ok())
            .expect("test PTY exposes its direct leader PID");
        let deadline = Instant::now() + Duration::from_secs(2);
        let child_pid = loop {
            let snapshot = runtime.poll(session.as_str(), "device-a", 0).unwrap();
            if let Some(pid) = snapshot.output.iter().find_map(|chunk| {
                chunk
                    .text
                    .lines()
                    .find_map(|line| line.trim().strip_prefix("CHILD:")?.parse::<i32>().ok())
            }) {
                break pid;
            }
            assert!(
                Instant::now() <= deadline,
                "test PTY did not report descendant PID"
            );
            thread::sleep(Duration::from_millis(10));
        };

        // The direct shell exits after reporting the child. The reader may
        // report terminal EOF, but that status probe must not reap the shell
        // and release its process-group ID before close can safely signal it.
        let deadline = Instant::now() + Duration::from_secs(2);
        let snapshot = loop {
            let snapshot = runtime.poll(session.as_str(), "device-a", 0).unwrap();
            if snapshot.status == ClaudePtyStatus::Exited {
                break snapshot;
            }
            assert!(
                Instant::now() <= deadline,
                "test PTY did not report reader EOF after its direct leader exited"
            );
            thread::sleep(Duration::from_millis(10));
        };
        assert_eq!(snapshot.status, ClaudePtyStatus::Exited);
        assert_eq!(
            kill(Pid::from_raw(leader_pid), None),
            Ok(()),
            "direct PTY leader must remain waitable until explicit close"
        );

        runtime.close(session.as_str(), "device-a").unwrap();
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            if kill(Pid::from_raw(child_pid), None) == Err(Errno::ESRCH) {
                break;
            }
            assert!(
                Instant::now() <= deadline,
                "close left a descendant in the original PTY group alive"
            );
            thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(
            kill(Pid::from_raw(leader_pid), None),
            Err(Errno::ESRCH),
            "close must reap the retained direct PTY leader"
        );
    }

    #[cfg(unix)]
    #[test]
    fn close_fails_closed_for_an_unowned_foreground_group_without_pidfd_fallback() {
        let mut runtime = NodePtyRuntime::test_runtime(
            "/bin/sh",
            &[
                "-c",
                "set -m; sh -c \"sh -c 'trap \\\"\\\" HUP TERM; while :; do sleep 1; done' & child=\\$!; printf 'CHILD:%s\\n' \\\"\\$child\\\"; sleep 0.2; exit 0\" & fg %1",
            ],
        );
        let session = runtime.create("device-a").unwrap();
        let deadline = Instant::now() + Duration::from_secs(2);
        let child_pid = loop {
            let snapshot = runtime.poll(session.as_str(), "device-a", 0).unwrap();
            if let Some(pid) = snapshot.output.iter().find_map(|chunk| {
                chunk
                    .text
                    .lines()
                    .find_map(|line| line.trim().strip_prefix("CHILD:")?.parse::<i32>().ok())
            }) {
                break pid;
            }
            assert!(
                Instant::now() <= deadline,
                "test PTY did not report the foreground descendant PID"
            );
            thread::sleep(Duration::from_millis(10));
        };

        let original_group = runtime.sessions[session.as_str()]
            .process_group
            .as_ref()
            .expect("Unix test session records its leader process group")
            .process_group;
        let foreground_group = runtime.sessions[session.as_str()]
            .master
            .as_deref()
            .and_then(MasterPty::process_group_leader)
            .expect("PTY reports the foreground process group");
        assert_ne!(
            foreground_group, original_group,
            "fixture must hand the terminal to the descendant group before close"
        );
        assert_eq!(
            foreground_group,
            getpgid(Some(Pid::from_raw(child_pid)))
                .expect("foreground descendant remains inspectable")
                .as_raw(),
            "fixture foreground group must belong to the reported descendant"
        );

        // The foreground group leader exits while its TERM-ignoring descendant
        // remains alive. The prior pidfd/poll approach could become readable
        // here and silently skip KILL. Relay remembers that it observed an
        // unowned foreground group, so it never authorizes a numeric fallback.
        thread::sleep(Duration::from_millis(300));
        assert!(runtime.sessions[session.as_str()].foreign_foreground_seen);
        let closures = runtime.begin_owner_session_closes("device-a");
        assert_eq!(closures.disposition, OwnerSessionCloseDisposition::Retry);
        assert!(closures.terminations.is_empty());
        assert!(runtime.sessions.contains_key(session.as_str()));
        assert_eq!(
            runtime.close(session.as_str(), "device-a"),
            Err(ClaudePtyError::Transport)
        );
        assert!(runtime.sessions.contains_key(session.as_str()));
        runtime.prune_finished_sessions();
        assert!(
            runtime.sessions.contains_key(session.as_str()),
            "automatic cleanup must preserve an unsafe terminal record instead of dropping it"
        );

        // The test fixture owns this child PID and cleans it up explicitly; a
        // production close deliberately has no equivalent unsafe numeric path.
        let _ = killpg(Pid::from_raw(child_pid), Signal::SIGKILL);
    }

    #[test]
    fn non_reader_input_backpressure_does_not_wedge_close() {
        let mut runtime = NodePtyRuntime::test_runtime("/bin/sh", &["-c", "sleep 30"]);
        let session = runtime.create("device-a").unwrap();
        let input = "x".repeat(PTY_INPUT_BYTES);
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            if runtime.input(session.as_str(), "device-a", &input)
                == Err(ClaudePtyError::Backpressure)
            {
                break;
            }
            assert!(
                Instant::now() <= deadline,
                "non-reading PTY never applied bounded input backpressure"
            );
        }

        let started = Instant::now();
        runtime.close(session.as_str(), "device-a").unwrap();
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "a blocked PTY writer must not wedge terminal close"
        );
    }

    #[test]
    fn non_reader_input_backpressure_does_not_wedge_owner_revoke() {
        let mut runtime = NodePtyRuntime::test_runtime("/bin/sh", &["-c", "sleep 30"]);
        let session = runtime.create("device-revoked").unwrap();
        let input = "x".repeat(PTY_INPUT_BYTES);
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            if runtime.input(session.as_str(), "device-revoked", &input)
                == Err(ClaudePtyError::Backpressure)
            {
                break;
            }
            assert!(
                Instant::now() <= deadline,
                "non-reading PTY never applied bounded input backpressure"
            );
        }

        let started = Instant::now();
        runtime.close_owner_sessions("device-revoked");
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "a blocked PTY writer must not wedge owner-session reaping"
        );
        assert!(!runtime.sessions.contains_key(session.as_str()));
    }

    #[test]
    fn reaper_polls_a_blocked_child_without_waiting() {
        let release = Arc::new(AtomicBool::new(false));
        let poll_started = Arc::new(AtomicBool::new(false));
        let reaped = Arc::new(AtomicBool::new(false));
        let child = Box::new(BlockingChild {
            release: Arc::clone(&release),
            poll_started: Arc::clone(&poll_started),
            reaped: Arc::clone(&reaped),
        });

        let started = Instant::now();
        reap_child(child);
        assert!(
            started.elapsed() < Duration::from_millis(50),
            "the caller must not wait for a blocked child reap"
        );

        let deadline = Instant::now() + Duration::from_secs(1);
        while !poll_started.load(Ordering::Acquire) {
            assert!(
                Instant::now() <= deadline,
                "the detached reaper never started child.try_wait"
            );
            thread::sleep(Duration::from_millis(1));
        }

        release.store(true, Ordering::Release);
        let deadline = Instant::now() + Duration::from_secs(1);
        while !reaped.load(Ordering::Acquire) {
            assert!(
                Instant::now() <= deadline,
                "the detached reaper never observed child termination"
            );
            thread::sleep(Duration::from_millis(1));
        }
    }

    #[test]
    fn reaper_stops_after_a_persistent_try_wait_error() {
        let attempts = Arc::new(AtomicU64::new(0));
        let mut child = ErrorChild {
            attempts: Arc::clone(&attempts),
        };

        assert_eq!(
            reap_child_until(
                &mut child,
                Instant::now() + Duration::from_secs(1),
                4,
                Duration::ZERO,
            ),
            ReapDisposition::TryWaitError
        );
        assert_eq!(
            attempts.load(Ordering::Acquire),
            1,
            "a persistent wait error must not leak an unbounded reaper loop"
        );
    }

    #[test]
    fn reaper_reports_attempt_and_deadline_dispositions() {
        let mut child = BlockingChild {
            release: Arc::new(AtomicBool::new(false)),
            poll_started: Arc::new(AtomicBool::new(false)),
            reaped: Arc::new(AtomicBool::new(false)),
        };

        assert_eq!(
            reap_child_until(
                &mut child,
                Instant::now() + Duration::from_secs(1),
                2,
                Duration::ZERO,
            ),
            ReapDisposition::AttemptsExhausted
        );
        assert_eq!(
            reap_child_until(&mut child, Instant::now(), 4, Duration::ZERO),
            ReapDisposition::Deadline
        );
    }
}
