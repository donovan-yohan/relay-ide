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
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, TrySendError};
use std::sync::{Arc, Mutex};
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
    Closing,
    Closed,
}

impl ClaudePtyStatus {
    pub const fn code(self) -> &'static str {
        match self {
            Self::Starting => "starting",
            Self::Running => "running",
            Self::Exited => "exited",
            Self::Closing => "closing",
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
    TeardownFailed,
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
            Self::TeardownFailed => "pty_teardown_failed",
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
    sender: Option<mpsc::SyncSender<InputRequest>>,
    stop: Arc<AtomicBool>,
    delivery_failed: Arc<AtomicBool>,
    worker: Option<JoinHandle<()>>,
}

impl PtyInput {
    fn enqueue(&self, data: &[u8]) -> Result<(), ClaudePtyError> {
        if self.delivery_failed.load(Ordering::Acquire) {
            return Err(ClaudePtyError::InputLost);
        }
        let request = InputRequest {
            data: data.to_vec(),
        };
        let sender = self.sender.as_ref().ok_or(ClaudePtyError::StaleHandle)?;
        match sender.try_send(request) {
            Ok(()) => Ok(()),
            Err(TrySendError::Full(_)) => Err(ClaudePtyError::Backpressure),
            Err(TrySendError::Disconnected(_)) if self.delivery_failed.load(Ordering::Acquire) => {
                Err(ClaudePtyError::InputLost)
            }
            Err(TrySendError::Disconnected(_)) => Err(ClaudePtyError::Transport),
        }
    }

    fn request_stop(&mut self) {
        self.stop.store(true, Ordering::Release);
        self.sender.take();
    }

    fn join_if_finished(&mut self) -> bool {
        self.request_stop();
        let Some(worker) = self.worker.as_ref() else {
            return true;
        };
        if !worker.is_finished() {
            return false;
        }
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
        true
    }
}

/// Linux ownership for the PTY session created by portable-pty.
///
/// The direct child remains waitable until the teardown state machine has
/// terminated its group and verified reap, so its PID reserves the original
/// process-group identity for the entire period Relay may call `killpg`. A
/// nonblocking duplicate of the master FD gives the input worker a cancellable
/// writer without consuming the reader.
#[cfg(target_os = "linux")]
struct PtyOwnership {
    process_group: i32,
    writer: FileDescriptor,
    #[cfg(test)]
    foreground_override: Option<ForegroundIdentity>,
    #[cfg(test)]
    signal_error: Option<Signal>,
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
    child_reaped: bool,
}

const PTY_CLOSE_ATTEMPTS: usize = 3;
const MAX_CLOSED_PTY_SESSIONS: usize = MAX_PTY_SESSIONS * 4;
const PTY_CLOSE_BACKOFF: [Duration; PTY_CLOSE_ATTEMPTS] = [
    Duration::ZERO,
    Duration::from_millis(50),
    Duration::from_millis(250),
];

#[derive(Clone, Copy)]
enum CloseCause {
    Explicit = 1,
    OwnerInvalidated = 2,
    Prune = 4,
    Startup = 8,
    Shutdown = 16,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PtyTeardownFailure {
    Ownership,
    TermSignal,
    KillSignal,
    ReapDeadline,
    ReapAttemptsExhausted,
    TryWait,
    ResourceHandlesPending,
    LeaseMismatch,
}

type SharedSession = Arc<Mutex<ManagedSession>>;

struct ClosingSession {
    session: SharedSession,
    generation: u64,
    attempts: usize,
    causes: u8,
    not_before: Instant,
    last_failure: Option<PtyTeardownFailure>,
}

struct SignallingSession {
    session: SharedSession,
    owner_device_id: String,
    generation: u64,
    attempt: usize,
    lease_id: u64,
    causes: u8,
}

struct ClosedSession {
    owner_device_id: String,
    next_cursor: u64,
    dropped_chunks: u64,
    order: u64,
}

struct TerminalFailure {
    closing: ClosingSession,
}

/// An exclusive, runtime-owned teardown lease. The keyed lifecycle record
/// remains in `signalling` until this lease is returned, so no failed operation
/// can make its child, original group identity, or PTY descriptors disappear.
pub struct PtyTermination {
    session_id: SessionId,
    owner_device_id: String,
    generation: u64,
    attempt: usize,
    lease_id: u64,
    causes: u8,
    session: SharedSession,
}

pub struct PtyTerminationOutcome {
    result: PtyTerminationResult,
}

enum PtyTerminationResult {
    Closed(PtyTermination),
    Retry {
        termination: PtyTermination,
        failure: PtyTeardownFailure,
    },
}

/// A create result contains only lock-bound launch bookkeeping. Callers must
/// drive due teardown leases after releasing the runtime mutex.
pub struct PtyCreate {
    result: Result<SessionId, ClaudePtyError>,
}

impl PtyCreate {
    pub fn into_result(self) -> Result<SessionId, ClaudePtyError> {
        self.result
    }
}

/// The outcome of selecting PTYs for owner invalidation cleanup.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OwnerSessionCloseDisposition {
    Complete,
    Retry,
}

pub struct OwnerSessionClosures {
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
    closing: HashMap<String, ClosingSession>,
    signalling: HashMap<String, SignallingSession>,
    closed: HashMap<String, ClosedSession>,
    terminal_failures: HashMap<String, TerminalFailure>,
    next_id: u64,
    next_generation: u64,
    next_lease_id: u64,
    next_closed_order: u64,
    shutdown_requested: bool,
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
            closing: HashMap::new(),
            signalling: HashMap::new(),
            closed: HashMap::new(),
            terminal_failures: HashMap::new(),
            next_id: 1,
            next_generation: 1,
            next_lease_id: 1,
            next_closed_order: 1,
            shutdown_requested: false,
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
    #[cfg(any(debug_assertions, feature = "test-fixtures"))]
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
        let launch_directory = self.launch_directory.clone();
        self.create_in_directory(owner_device_id, &launch_directory)
    }

    /// Start the fixed Claude executable in a trusted node-selected directory.
    /// This changes only CWD; executable, arguments, HOME, PATH, and auth
    /// context remain fixed by the runtime.
    pub fn create_in_directory(
        &mut self,
        owner_device_id: &str,
        launch_directory: &Path,
    ) -> Result<SessionId, ClaudePtyError> {
        self.finish_due_terminations();
        self.schedule_prune_finished_sessions();
        self.finish_due_terminations();
        let result = self.try_create(owner_device_id, launch_directory);
        self.finish_due_terminations();
        result
    }

    /// Begin fixed-PTY creation while the runtime is locked. It only schedules
    /// automatic cleanup; callers must claim and finish those leases after
    /// releasing the hub mutex, then retry admission if capacity was freed.
    pub fn begin_create(&mut self, owner_device_id: &str) -> PtyCreate {
        let launch_directory = self.launch_directory.clone();
        self.begin_create_in_directory(owner_device_id, &launch_directory)
    }

    /// Begin creation in a hub-validated Workspace CWD while preserving the
    /// exact fixed executable and node-owner environment.
    pub fn begin_create_in_directory(
        &mut self,
        owner_device_id: &str,
        launch_directory: &Path,
    ) -> PtyCreate {
        self.schedule_prune_finished_sessions();
        PtyCreate {
            result: self.try_create(owner_device_id, launch_directory),
        }
    }

    fn try_create(
        &mut self,
        owner_device_id: &str,
        launch_directory: &Path,
    ) -> Result<SessionId, ClaudePtyError> {
        if self.shutdown_requested {
            return Err(ClaudePtyError::Unavailable);
        }
        if owner_device_id.is_empty() || owner_device_id.len() > 64 {
            return Err(ClaudePtyError::Forbidden);
        }
        if self.capacity_consumed() >= MAX_PTY_SESSIONS {
            return Err(ClaudePtyError::Capacity);
        }

        let pty_system = native_pty_system();
        let pair = match pty_system.openpty(default_size()) {
            Ok(pair) => pair,
            Err(_) => return Err(ClaudePtyError::Transport),
        };
        let mut command = CommandBuilder::new(self.owner.claude_path());
        command.env_clear();
        for argument in &self.arguments {
            command.arg(argument);
        }
        command.cwd(launch_directory);
        command.env("HOME", self.owner.home());
        command.env("USER", "donovanyohan");
        command.env("LOGNAME", "donovanyohan");
        command.env("PATH", NODE_OWNER_PATH);
        command.env("SHELL", NODE_OWNER_SHELL);
        command.env("TERM", "xterm-256color");
        command.env("COLORTERM", "truecolor");

        let child = match pair.slave.spawn_command(command) {
            Ok(child) => child,
            Err(_) => return Err(ClaudePtyError::Unavailable),
        };
        drop(pair.slave);
        let id = format!("claude-pty-{}", self.next_id);
        self.next_id = self.next_id.saturating_add(1);
        let session_id = SessionId::new(id.clone());
        let process_group = child
            .process_id()
            .and_then(|process_id| session_process_group(process_id, pair.master.as_ref()));
        #[cfg(unix)]
        if process_group.is_none() {
            self.register_startup_failure(
                session_id,
                owner_device_id,
                child,
                None,
                pair.master,
                None,
            );
            return Err(ClaudePtyError::Transport);
        }
        let reader = match pair.master.try_clone_reader() {
            Ok(reader) => reader,
            Err(_) => {
                self.register_startup_failure(
                    session_id,
                    owner_device_id,
                    child,
                    process_group,
                    pair.master,
                    None,
                );
                return Err(ClaudePtyError::Transport);
            }
        };
        let input = match process_group
            .as_ref()
            .ok_or(ClaudePtyError::Transport)
            .and_then(spawn_input_writer)
        {
            Ok(input) => input,
            Err(error) => {
                self.register_startup_failure(
                    session_id,
                    owner_device_id,
                    child,
                    process_group,
                    pair.master,
                    None,
                );
                return Err(error);
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
                self.register_startup_failure(
                    session_id,
                    owner_device_id,
                    child,
                    process_group,
                    pair.master,
                    Some(input),
                );
                return Err(error);
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
                child_reaped: false,
            },
        );
        Ok(session_id)
    }

    /// Return an incremental, loss-aware output snapshot. Disconnection merely
    /// stops polling; it never blocks the PTY reader or closes the Session.
    pub fn poll(
        &mut self,
        session_id: &str,
        owner_device_id: &str,
        cursor: u64,
    ) -> Result<TerminalSnapshot, ClaudePtyError> {
        if let Some(session) = self.sessions.get_mut(session_id) {
            if session.owner_device_id != owner_device_id {
                return Err(ClaudePtyError::Forbidden);
            }
            session.pump();
            return Ok(session_snapshot(session, session_id, cursor));
        }
        if let Some(closing) = self.closing.get(session_id) {
            let session = lock_shared_session(&closing.session);
            return closing_snapshot(session_id, owner_device_id, &session.owner_device_id);
        }
        if let Some(signalling) = self.signalling.get(session_id) {
            return closing_snapshot(session_id, owner_device_id, &signalling.owner_device_id);
        }
        if let Some(closed) = self.closed.get(session_id) {
            if closed.owner_device_id != owner_device_id {
                return Err(ClaudePtyError::Forbidden);
            }
            return Ok(terminal_snapshot(
                session_id,
                ClaudePtyStatus::Closed,
                closed.next_cursor,
                closed.dropped_chunks,
            ));
        }
        if let Some(failure) = self.terminal_failures.get(session_id) {
            if lock_shared_session(&failure.closing.session).owner_device_id != owner_device_id {
                return Err(ClaudePtyError::Forbidden);
            }
            return Err(ClaudePtyError::TeardownFailed);
        }
        Err(ClaudePtyError::StaleHandle)
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
        let session = self.active_session_mut(session_id, owner_device_id)?;
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
        let session = self.active_session_mut(session_id, owner_device_id)?;
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

    /// Direct runtime convenience for unit tests and the node probe. Hub code
    /// requests the transition under its mutex, then drives leases outside it.
    pub fn close(
        &mut self,
        session_id: &str,
        owner_device_id: &str,
    ) -> Result<TerminalSnapshot, ClaudePtyError> {
        self.request_close(session_id, owner_device_id)?;
        self.finish_due_terminations();
        self.poll(session_id, owner_device_id, 0)
    }

    /// Enter Closing without foreground probing or resource consumption. The
    /// later lease either reports Closed after reap or comes back retryable.
    pub fn request_close(
        &mut self,
        session_id: &str,
        owner_device_id: &str,
    ) -> Result<(), ClaudePtyError> {
        self.schedule_close(session_id, owner_device_id, CloseCause::Explicit)
    }

    fn active_session_mut(
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

    fn schedule_close(
        &mut self,
        session_id: &str,
        owner_device_id: &str,
        cause: CloseCause,
    ) -> Result<(), ClaudePtyError> {
        if let Some(session) = self.sessions.get_mut(session_id) {
            if session.owner_device_id != owner_device_id {
                return Err(ClaudePtyError::Forbidden);
            }
            session.pump();
        } else if let Some(closing) = self.closing.get_mut(session_id) {
            if lock_shared_session(&closing.session).owner_device_id != owner_device_id {
                return Err(ClaudePtyError::Forbidden);
            }
            closing.causes |= cause as u8;
            return Ok(());
        } else if let Some(signalling) = self.signalling.get_mut(session_id) {
            if signalling.owner_device_id != owner_device_id {
                return Err(ClaudePtyError::Forbidden);
            }
            signalling.causes |= cause as u8;
            return Ok(());
        } else if let Some(closed) = self.closed.get(session_id) {
            return (closed.owner_device_id == owner_device_id)
                .then_some(())
                .ok_or(ClaudePtyError::Forbidden);
        } else if let Some(failure) = self.terminal_failures.get_mut(session_id) {
            if lock_shared_session(&failure.closing.session).owner_device_id != owner_device_id {
                return Err(ClaudePtyError::Forbidden);
            }
            failure.closing.causes |= cause as u8;
            return Err(ClaudePtyError::TeardownFailed);
        } else {
            return Err(ClaudePtyError::StaleHandle);
        }

        let session = self
            .sessions
            .remove(session_id)
            .expect("the active record checked above remains present");
        let generation = self.next_generation;
        self.next_generation = self.next_generation.saturating_add(1);
        self.closing.insert(
            session_id.to_owned(),
            ClosingSession {
                session: Arc::new(Mutex::new(session)),
                generation,
                attempts: 0,
                causes: cause as u8,
                not_before: Instant::now(),
                last_failure: None,
            },
        );
        Ok(())
    }

    fn schedule_prune_finished_sessions(&mut self) {
        let session_ids = self
            .sessions
            .iter_mut()
            .filter_map(|(session_id, session)| {
                session.pump();
                (session.status == ClaudePtyStatus::Exited).then(|| session_id.clone())
            })
            .collect::<Vec<_>>();
        for session_id in session_ids {
            let owner = self.sessions[&session_id].owner_device_id.clone();
            let _ = self.schedule_close(&session_id, &owner, CloseCause::Prune);
        }
    }

    #[cfg(test)]
    fn prune_finished_sessions(&mut self) {
        self.schedule_prune_finished_sessions();
        self.finish_due_terminations();
    }

    /// Schedule every record owned by an invalidated browser device. Auth is
    /// acknowledged only when `owner_close_disposition` reaches Complete.
    pub fn begin_owner_session_closes(&mut self, owner_device_id: &str) -> OwnerSessionClosures {
        let mut session_ids = self
            .sessions
            .iter()
            .filter(|(_, session)| session.owner_device_id == owner_device_id)
            .map(|(session_id, _)| session_id.clone())
            .collect::<Vec<_>>();
        session_ids.extend(
            self.closing
                .iter()
                .filter(|(_, closing)| {
                    lock_shared_session(&closing.session).owner_device_id == owner_device_id
                })
                .map(|(session_id, _)| session_id.clone()),
        );
        session_ids.extend(
            self.signalling
                .iter()
                .filter(|(_, signalling)| signalling.owner_device_id == owner_device_id)
                .map(|(session_id, _)| session_id.clone()),
        );
        session_ids.extend(
            self.terminal_failures
                .iter()
                .filter(|(_, failure)| {
                    lock_shared_session(&failure.closing.session).owner_device_id == owner_device_id
                })
                .map(|(session_id, _)| session_id.clone()),
        );
        session_ids.sort();
        session_ids.dedup();
        for session_id in session_ids {
            let _ = self.schedule_close(&session_id, owner_device_id, CloseCause::OwnerInvalidated);
        }
        OwnerSessionClosures {
            disposition: self.owner_close_disposition(owner_device_id),
        }
    }

    pub fn close_owner_sessions(&mut self, owner_device_id: &str) {
        self.begin_owner_session_closes(owner_device_id);
        self.finish_due_terminations();
    }

    /// Claim every due close attempt while locked. The returned leases are the
    /// only values permitted to sleep, signal, join, or poll children.
    pub fn claim_due_terminations(&mut self) -> Vec<PtyTermination> {
        let now = Instant::now();
        let abandoned = self
            .signalling
            .iter()
            .filter(|(_, signalling)| Arc::strong_count(&signalling.session) == 1)
            .map(|(session_id, _)| session_id.clone())
            .collect::<Vec<_>>();
        for session_id in abandoned {
            let signalling = self
                .signalling
                .remove(&session_id)
                .expect("abandoned lease sentinel remains present");
            let closing = ClosingSession {
                session: signalling.session,
                generation: signalling.generation,
                attempts: signalling.attempt,
                causes: signalling.causes,
                not_before: now + PTY_CLOSE_BACKOFF[signalling.attempt.min(PTY_CLOSE_ATTEMPTS - 1)],
                last_failure: Some(PtyTeardownFailure::LeaseMismatch),
            };
            if signalling.attempt >= PTY_CLOSE_ATTEMPTS {
                self.terminal_failures
                    .insert(session_id, TerminalFailure { closing });
            } else {
                self.closing.insert(session_id, closing);
            }
        }
        let session_ids = self
            .closing
            .iter()
            .filter(|(_, closing)| closing.not_before <= now)
            .map(|(session_id, _)| session_id.clone())
            .collect::<Vec<_>>();
        let mut terminations = Vec::with_capacity(session_ids.len());
        for session_id in session_ids {
            let closing = self
                .closing
                .remove(&session_id)
                .expect("a due closing record remains present until leased");
            let lease_id = self.next_lease_id;
            self.next_lease_id = self.next_lease_id.saturating_add(1);
            let attempt = closing.attempts.saturating_add(1);
            let owner_device_id = lock_shared_session(&closing.session)
                .owner_device_id
                .clone();
            self.signalling.insert(
                session_id.clone(),
                SignallingSession {
                    session: Arc::clone(&closing.session),
                    owner_device_id: owner_device_id.clone(),
                    generation: closing.generation,
                    attempt,
                    lease_id,
                    causes: closing.causes,
                },
            );
            terminations.push(PtyTermination {
                session_id: SessionId::new(session_id),
                owner_device_id,
                generation: closing.generation,
                attempt,
                lease_id,
                causes: closing.causes,
                session: Arc::clone(&closing.session),
            });
        }
        terminations
    }

    /// Return a completed lease to its original keyed lifecycle record. A
    /// retry never changes generation or ownership and never drops the bundle.
    pub fn complete_termination(&mut self, outcome: PtyTerminationOutcome) {
        let (termination, failure) = match outcome.result {
            PtyTerminationResult::Closed(termination) => (termination, None),
            PtyTerminationResult::Retry {
                termination,
                failure,
            } => (termination, Some(failure)),
        };
        let claimed_session_id = termination.session_id.as_str().to_owned();
        let sentinel_session_id = self
            .signalling
            .iter()
            .find(|(_, signalling)| Arc::ptr_eq(&signalling.session, &termination.session))
            .map(|(session_id, _)| session_id.clone());
        let valid = sentinel_session_id
            .as_ref()
            .filter(|session_id| **session_id == claimed_session_id)
            .and_then(|session_id| self.signalling.get(session_id))
            .is_some_and(|signalling| {
                signalling.generation == termination.generation
                    && signalling.attempt == termination.attempt
                    && signalling.lease_id == termination.lease_id
                    && signalling.owner_device_id == termination.owner_device_id
            });
        if !valid {
            eprintln!("relay Claude PTY teardown completion lease mismatch");
            let quarantine_session_id = sentinel_session_id.unwrap_or(claimed_session_id);
            let signalling = self.signalling.remove(&quarantine_session_id);
            let session = signalling
                .as_ref()
                .map(|record| Arc::clone(&record.session))
                .unwrap_or_else(|| Arc::clone(&termination.session));
            let causes = signalling
                .as_ref()
                .map_or(termination.causes, |record| record.causes);
            let generation = signalling
                .as_ref()
                .map_or(termination.generation, |record| record.generation);
            let attempts = signalling
                .as_ref()
                .map_or(termination.attempt, |record| record.attempt);
            self.terminal_failures.insert(
                quarantine_session_id,
                TerminalFailure {
                    closing: ClosingSession {
                        session,
                        generation,
                        attempts,
                        causes,
                        not_before: Instant::now(),
                        last_failure: Some(PtyTeardownFailure::LeaseMismatch),
                    },
                },
            );
            return;
        }

        let signalling = self
            .signalling
            .remove(&claimed_session_id)
            .expect("validated signalling record remains present");
        if let Some(failure) = failure {
            let closing = ClosingSession {
                session: signalling.session,
                generation: termination.generation,
                attempts: termination.attempt,
                causes: signalling.causes,
                not_before: Instant::now()
                    + PTY_CLOSE_BACKOFF[termination.attempt.min(PTY_CLOSE_ATTEMPTS - 1)],
                last_failure: Some(failure),
            };
            if termination.attempt >= PTY_CLOSE_ATTEMPTS {
                self.terminal_failures
                    .insert(claimed_session_id, TerminalFailure { closing });
            } else {
                self.closing.insert(claimed_session_id, closing);
            }
            return;
        }

        let (next_cursor, dropped_chunks) = {
            let mut session = lock_shared_session(&signalling.session);
            session.release_after_reap()
        };
        self.insert_closed(
            claimed_session_id,
            ClosedSession {
                owner_device_id: termination.owner_device_id,
                next_cursor,
                dropped_chunks,
                order: 0,
            },
        );
    }

    /// Test/node convenience that executes a bounded batch outside any caller
    /// mutex. Hub code claims and completes through separate lock acquisitions.
    pub fn finish_due_terminations(&mut self) {
        let terminations = self.claim_due_terminations();
        for termination in terminations {
            self.complete_termination(termination.finish());
        }
    }

    pub fn owner_close_disposition(&self, owner_device_id: &str) -> OwnerSessionCloseDisposition {
        let pending = self
            .sessions
            .values()
            .any(|session| session.owner_device_id == owner_device_id)
            || self.closing.values().any(|closing| {
                lock_shared_session(&closing.session).owner_device_id == owner_device_id
            })
            || self
                .signalling
                .values()
                .any(|signalling| signalling.owner_device_id == owner_device_id)
            || self.terminal_failures.values().any(|failure| {
                lock_shared_session(&failure.closing.session).owner_device_id == owner_device_id
            });
        if pending {
            OwnerSessionCloseDisposition::Retry
        } else {
            OwnerSessionCloseDisposition::Complete
        }
    }

    fn capacity_consumed(&self) -> usize {
        self.sessions.len()
            + self.closing.len()
            + self.signalling.len()
            + self.terminal_failures.len()
    }

    fn insert_closed(&mut self, session_id: String, mut closed: ClosedSession) {
        closed.order = self.next_closed_order;
        self.next_closed_order = self.next_closed_order.saturating_add(1);
        self.closed.insert(session_id, closed);
        while self.closed.len() > MAX_CLOSED_PTY_SESSIONS {
            let Some(oldest) = self
                .closed
                .iter()
                .min_by_key(|(_, record)| record.order)
                .map(|(session_id, _)| session_id.clone())
            else {
                break;
            };
            self.closed.remove(&oldest);
        }
    }

    pub fn begin_shutdown(&mut self) -> OwnerSessionCloseDisposition {
        self.shutdown_requested = true;
        let session_ids = self.sessions.keys().cloned().collect::<Vec<_>>();
        for session_id in session_ids {
            let owner = self.sessions[&session_id].owner_device_id.clone();
            let _ = self.schedule_close(&session_id, &owner, CloseCause::Shutdown);
        }
        for closing in self.closing.values_mut() {
            closing.causes |= CloseCause::Shutdown as u8;
        }
        for signalling in self.signalling.values_mut() {
            signalling.causes |= CloseCause::Shutdown as u8;
        }
        for failure in self.terminal_failures.values_mut() {
            failure.closing.causes |= CloseCause::Shutdown as u8;
        }
        self.shutdown_disposition()
    }

    pub fn shutdown_disposition(&self) -> OwnerSessionCloseDisposition {
        if self.sessions.is_empty()
            && self.closing.is_empty()
            && self.signalling.is_empty()
            && self.terminal_failures.is_empty()
        {
            OwnerSessionCloseDisposition::Complete
        } else {
            OwnerSessionCloseDisposition::Retry
        }
    }

    pub fn has_terminal_failures(&self) -> bool {
        !self.terminal_failures.is_empty()
    }

    pub fn has_pending_terminations(&self) -> bool {
        !self.closing.is_empty() || !self.signalling.is_empty()
    }

    pub fn teardown_failure(
        &self,
        session_id: &str,
        owner_device_id: &str,
    ) -> Result<Option<(PtyTeardownFailure, usize)>, ClaudePtyError> {
        if let Some(closing) = self.closing.get(session_id) {
            if lock_shared_session(&closing.session).owner_device_id != owner_device_id {
                return Err(ClaudePtyError::Forbidden);
            }
            return Ok(closing
                .last_failure
                .map(|failure| (failure, closing.attempts)));
        }
        if let Some(failure) = self.terminal_failures.get(session_id) {
            if lock_shared_session(&failure.closing.session).owner_device_id != owner_device_id {
                return Err(ClaudePtyError::Forbidden);
            }
            return Ok(failure
                .closing
                .last_failure
                .map(|reason| (reason, failure.closing.attempts)));
        }
        Ok(None)
    }

    fn register_startup_failure(
        &mut self,
        session_id: SessionId,
        owner_device_id: &str,
        child: Box<dyn Child + Send + Sync>,
        process_group: Option<PtyOwnership>,
        master: Box<dyn MasterPty + Send>,
        input: Option<PtyInput>,
    ) {
        let (_, reader_rx) = mpsc::sync_channel(1);
        let generation = self.next_generation;
        self.next_generation = self.next_generation.saturating_add(1);
        self.closing.insert(
            session_id.as_str().to_owned(),
            ClosingSession {
                session: Arc::new(Mutex::new(ManagedSession {
                    owner_device_id: owner_device_id.to_owned(),
                    status: ClaudePtyStatus::Starting,
                    child: Some(child),
                    process_group,
                    master: Some(master),
                    input,
                    reader: None,
                    reader_rx,
                    reader_stop: Arc::new(AtomicBool::new(false)),
                    reader_terminal: Arc::new(AtomicBool::new(false)),
                    reader_dropped: Arc::new(AtomicU64::new(0)),
                    output: VecDeque::new(),
                    output_bytes: 0,
                    next_sequence: 1,
                    pending_utf8: Vec::new(),
                    terminal_seen: false,
                    foreign_foreground_seen: false,
                    child_reaped: false,
                })),
                generation,
                attempts: 0,
                causes: CloseCause::Startup as u8,
                not_before: Instant::now(),
                last_failure: None,
            },
        );
    }

    #[cfg(target_os = "linux")]
    #[cfg(test)]
    fn set_test_foreground_identity(&mut self, session_id: &str, identity: ForegroundIdentity) {
        if let Some(session) = self.sessions.get_mut(session_id) {
            session
                .process_group
                .as_mut()
                .expect("test session retains its original process group")
                .foreground_override = Some(identity);
            return;
        }
        lock_shared_session(
            &self
                .closing
                .get(session_id)
                .expect("test session remains in Closing")
                .session,
        )
        .process_group
        .as_mut()
        .expect("test session retains its original process group")
        .foreground_override = Some(identity);
    }

    #[cfg(target_os = "linux")]
    #[cfg(test)]
    fn set_test_signal_error(&mut self, session_id: &str, signal: Option<Signal>) {
        let shared = self
            .closing
            .get(session_id)
            .map(|closing| Arc::clone(&closing.session))
            .or_else(|| {
                self.signalling
                    .get(session_id)
                    .map(|signalling| Arc::clone(&signalling.session))
            })
            .expect("test session remains in teardown");
        lock_shared_session(&shared)
            .process_group
            .as_mut()
            .expect("test session retains its original process group")
            .signal_error = signal;
    }

    #[cfg(test)]
    fn replace_test_closing_child(
        &mut self,
        session_id: &str,
        child: Box<dyn Child + Send + Sync>,
    ) {
        lock_shared_session(
            &self
                .closing
                .get(session_id)
                .expect("test session has entered Closing before injecting reap behavior")
                .session,
        )
        .child = Some(child);
    }

    #[cfg(test)]
    fn force_due_terminations_for_test(&mut self) {
        for closing in self.closing.values_mut() {
            closing.not_before = Instant::now();
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
            if self.process_group.as_ref().is_some_and(|ownership| {
                matches!(
                    ownership.foreground_identity(),
                    ForegroundIdentity::ProcessGroup(process_group)
                        if process_group != ownership.process_group
                )
            }) {
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

    fn prepare_for_teardown(&mut self) {
        self.reader_stop.store(true, Ordering::Release);
        if let Some(input) = self.input.as_mut() {
            input.request_stop();
        }
    }

    fn finish_resource_handles(&mut self) -> bool {
        self.prepare_for_teardown();
        if self
            .input
            .as_mut()
            .is_some_and(|input| input.join_if_finished())
        {
            self.input.take();
        }
        if self.reader.as_ref().is_some_and(JoinHandle::is_finished) {
            if let Some(reader) = self.reader.take() {
                let _ = reader.join();
            }
        }
        self.input.is_none() && self.reader.is_none()
    }

    fn release_after_reap(&mut self) -> (u64, u64) {
        debug_assert!(self.child_reaped);
        debug_assert!(self.input.is_none());
        debug_assert!(self.reader.is_none());
        self.child.take();
        self.master.take();
        self.process_group.take();
        self.pump();
        self.flush_pending_output();
        self.status = ClaudePtyStatus::Closed;
        (
            self.next_sequence.saturating_sub(1),
            self.reader_dropped.load(Ordering::Acquire),
        )
    }
}

#[cfg(test)]
impl Drop for ManagedSession {
    fn drop(&mut self) {
        // Test fixtures must not leave live PTY children behind for later
        // process-group cases. Production has no destructor teardown path:
        // every outcome must return through the explicit state machine.
        self.reader_stop.store(true, Ordering::Release);
        if let Some(input) = self.input.as_mut() {
            input.request_stop();
        }
        if let Some(mut child) = self.child.take() {
            let _ = child.kill();
            reap_child(child);
        }
        self.master.take();
        self.process_group.take();
        if let Some(reader) = self.reader.take() {
            if reader.is_finished() {
                let _ = reader.join();
            }
        }
    }
}

impl PtyTermination {
    /// Finish one bounded, outside-lock lease. All failure paths return `self`
    /// with its complete original resource bundle still attached.
    pub fn finish(self) -> PtyTerminationOutcome {
        let failure = {
            let mut session = lock_shared_session(&self.session);
            session.prepare_for_teardown();
            if !session.child_reaped {
                let result = if session.process_group.is_none()
                    && self.causes & CloseCause::Startup as u8 != 0
                {
                    terminate_startup_child(&mut session)
                } else if !session.foreground_is_owned() {
                    Err(PtyTeardownFailure::Ownership)
                } else {
                    let ManagedSession {
                        child,
                        process_group,
                        ..
                    } = &mut *session;
                    match (child.as_deref_mut(), process_group.as_ref()) {
                        (Some(child), Some(ownership)) => terminate_child(child, ownership),
                        _ => Err(PtyTeardownFailure::Ownership),
                    }
                };
                if let Err(failure) = result {
                    Some(failure)
                } else {
                    session.child_reaped = true;
                    None
                }
            } else {
                None
            }
        };
        if let Some(failure) = failure {
            return PtyTerminationOutcome {
                result: PtyTerminationResult::Retry {
                    termination: self,
                    failure,
                },
            };
        }
        let handles_finished = lock_shared_session(&self.session).finish_resource_handles();
        if !handles_finished {
            return PtyTerminationOutcome {
                result: PtyTerminationResult::Retry {
                    termination: self,
                    failure: PtyTeardownFailure::ResourceHandlesPending,
                },
            };
        }
        PtyTerminationOutcome {
            result: PtyTerminationResult::Closed(self),
        }
    }
}

fn lock_shared_session(session: &SharedSession) -> std::sync::MutexGuard<'_, ManagedSession> {
    session
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn session_snapshot(session: &ManagedSession, session_id: &str, cursor: u64) -> TerminalSnapshot {
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
    TerminalSnapshot {
        session_id: SessionId::new(session_id),
        status: session.status,
        output,
        next_cursor,
        has_more,
        truncated,
        dropped_chunks: session.reader_dropped.load(Ordering::Acquire),
    }
}

fn terminal_snapshot(
    session_id: &str,
    status: ClaudePtyStatus,
    next_cursor: u64,
    dropped_chunks: u64,
) -> TerminalSnapshot {
    TerminalSnapshot {
        session_id: SessionId::new(session_id),
        status,
        output: Vec::new(),
        next_cursor,
        has_more: false,
        truncated: false,
        dropped_chunks,
    }
}

fn closing_snapshot(
    session_id: &str,
    owner_device_id: &str,
    record_owner_device_id: &str,
) -> Result<TerminalSnapshot, ClaudePtyError> {
    if record_owner_device_id != owner_device_id {
        return Err(ClaudePtyError::Forbidden);
    }
    Ok(terminal_snapshot(
        session_id,
        ClaudePtyStatus::Closing,
        0,
        0,
    ))
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
            sender: Some(sender),
            stop,
            delivery_failed,
            worker: Some(worker),
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
    fn foreground_identity(&self) -> ForegroundIdentity {
        #[cfg(test)]
        {
            self.foreground_override
                .unwrap_or_else(|| foreground_identity(&self.writer))
        }
        #[cfg(not(test))]
        {
            foreground_identity(&self.writer)
        }
    }

    fn foreground_is_owned(&self) -> bool {
        match self.foreground_identity() {
            ForegroundIdentity::NoForegroundGroup => true,
            ForegroundIdentity::ProcessGroup(process_group) => process_group == self.process_group,
            ForegroundIdentity::Unavailable => false,
        }
    }

    fn signal_groups(&self, signal: Signal) -> Result<(), PtyTeardownFailure> {
        // Relay holds a lifetime-safe identity only for the original group: its
        // direct leader remains unreaped until teardown finishes. A PTY
        // foreground group can outlive its leader, so never convert the numeric
        // `tcgetpgrp` result into `killpg`. Refuse the close instead of risking
        // an unrelated/reused group or claiming to have reaped an unowned one.
        if !self.foreground_is_owned() {
            return Err(PtyTeardownFailure::Ownership);
        }
        // The direct child remains unreaped until this teardown completes, so
        // this numeric group identifier remains Relay-owned and identity-safe.
        #[cfg(test)]
        if self.signal_error == Some(signal) {
            return Err(match signal {
                Signal::SIGTERM => PtyTeardownFailure::TermSignal,
                _ => PtyTeardownFailure::KillSignal,
            });
        }
        killpg(Pid::from_raw(self.process_group), signal).map_err(|_| match signal {
            Signal::SIGTERM => PtyTeardownFailure::TermSignal,
            _ => PtyTeardownFailure::KillSignal,
        })
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
            #[cfg(test)]
            signal_error: None,
        })
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (process_id, master);
        None
    }
}

fn terminate_child(
    child: &mut dyn Child,
    ownership: &PtyOwnership,
) -> Result<(), PtyTeardownFailure> {
    #[cfg(target_os = "linux")]
    {
        // Both checks are fail-closed and target only the original verified
        // Relay-owned group. There is deliberately no numeric foreground or
        // direct-child fallback once that identity becomes unavailable.
        ownership.signal_groups(Signal::SIGTERM)?;
        thread::sleep(PTY_TERMINATION_GRACE);
        ownership.signal_groups(Signal::SIGKILL)?;
    }
    match reap_child_until(
        child,
        Instant::now() + PTY_REAPER_DEADLINE,
        PTY_REAPER_MAX_ATTEMPTS,
        PTY_REAPER_POLL_INTERVAL,
    ) {
        ReapDisposition::Reaped => Ok(()),
        ReapDisposition::Deadline => Err(PtyTeardownFailure::ReapDeadline),
        ReapDisposition::AttemptsExhausted => Err(PtyTeardownFailure::ReapAttemptsExhausted),
        ReapDisposition::TryWaitError => Err(PtyTeardownFailure::TryWait),
    }
}

fn terminate_startup_child(session: &mut ManagedSession) -> Result<(), PtyTeardownFailure> {
    let child = session
        .child
        .as_deref_mut()
        .ok_or(PtyTeardownFailure::Ownership)?;
    child.kill().map_err(|_| PtyTeardownFailure::KillSignal)?;
    match reap_child_until(
        child,
        Instant::now() + PTY_REAPER_DEADLINE,
        PTY_REAPER_MAX_ATTEMPTS,
        PTY_REAPER_POLL_INTERVAL,
    ) {
        ReapDisposition::Reaped => Ok(()),
        ReapDisposition::Deadline => Err(PtyTeardownFailure::ReapDeadline),
        ReapDisposition::AttemptsExhausted => Err(PtyTeardownFailure::ReapAttemptsExhausted),
        ReapDisposition::TryWaitError => Err(PtyTeardownFailure::TryWait),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ReapDisposition {
    Reaped,
    Deadline,
    AttemptsExhausted,
    TryWaitError,
}

#[cfg(test)]
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
    fn requested_launch_directory_changes_only_cwd_and_keeps_owner_environment() {
        let launch_directory =
            std::env::temp_dir().join(format!("relay-claude-requested-cwd-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&launch_directory);
        std::fs::create_dir_all(&launch_directory).unwrap();
        let mut runtime = NodePtyRuntime::test_runtime(
            "/bin/sh",
            &[
                "-c",
                "printf 'PWD=%s\\nHOME=%s\\nPATH=%s\\n' \"$PWD\" \"$HOME\" \"$PATH\"; cat",
            ],
        );

        let session = runtime
            .create_in_directory("device-a", &launch_directory)
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(2);
        let output = loop {
            let snapshot = runtime.poll(session.as_str(), "device-a", 0).unwrap();
            let output = snapshot
                .output
                .iter()
                .map(|chunk| chunk.text.as_str())
                .collect::<String>();
            if output.contains("PATH=") {
                break output;
            }
            assert!(
                Instant::now() <= deadline,
                "test PTY produced no launch context"
            );
            thread::sleep(Duration::from_millis(10));
        };
        assert!(output.contains(&format!("PWD={}", launch_directory.display())));
        assert!(output.contains(&format!("HOME={NODE_OWNER_HOME}")));
        assert!(output.contains(&format!("PATH={NODE_OWNER_PATH}")));
        runtime.close(session.as_str(), "device-a").unwrap();
        std::fs::remove_dir_all(launch_directory).unwrap();
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
        runtime.request_close(session.as_str(), "device-a").unwrap();
        assert!(
            started.elapsed() < Duration::from_millis(50),
            "the runtime lock path must transition the Session before TERM grace"
        );
        assert!(!runtime.sessions.contains_key(session.as_str()));
        assert!(runtime.closing.contains_key(session.as_str()));
        runtime.finish_due_terminations();
        assert_eq!(
            runtime
                .poll(session.as_str(), "device-a", 0)
                .unwrap()
                .status,
            ClaudePtyStatus::Closed
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn post_lease_unavailable_foreground_retains_the_bundle_for_retry() {
        let mut runtime = NodePtyRuntime::test_runtime(
            "/bin/sh",
            &["-c", "trap '' TERM; while :; do sleep 1; done"],
        );
        let session = runtime.create("device-a").unwrap();

        runtime.request_close(session.as_str(), "device-a").unwrap();
        runtime.set_test_foreground_identity(session.as_str(), ForegroundIdentity::Unavailable);
        runtime.finish_due_terminations();

        {
            let closing = &runtime.closing[session.as_str()];
            let bundle = lock_shared_session(&closing.session);
            assert!(bundle.child.is_some(), "retry retains the direct child");
            assert!(
                bundle.process_group.is_some(),
                "retry retains original PGID identity"
            );
            assert!(bundle.master.is_some(), "retry retains the PTY master");
            assert!(bundle.reader.is_some(), "retry retains the reader handle");
            assert!(bundle.input.is_some(), "retry retains stopped writer state");
            assert!(
                bundle
                    .input
                    .as_ref()
                    .is_some_and(|input| input.worker.is_some()),
                "retry retains the writer join handle"
            );
        }

        assert_eq!(
            runtime
                .poll(session.as_str(), "device-a", 0)
                .unwrap()
                .status,
            ClaudePtyStatus::Closing,
            "an outside-lock ownership failure must leave a truthful retryable record"
        );
        assert_eq!(
            runtime.input(session.as_str(), "device-a", "ignored\n"),
            Err(ClaudePtyError::StaleHandle),
            "closing disables controls without releasing the owned bundle"
        );

        runtime
            .set_test_foreground_identity(session.as_str(), ForegroundIdentity::NoForegroundGroup);
        runtime.force_due_terminations_for_test();
        runtime.finish_due_terminations();

        assert_eq!(
            runtime
                .poll(session.as_str(), "device-a", 0)
                .unwrap()
                .status,
            ClaudePtyStatus::Closed,
            "a later verified attempt must reap the original retained child"
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn signal_failure_is_typed_and_retains_the_exact_bundle() {
        let mut runtime = NodePtyRuntime::test_runtime("/bin/sh", &["-c", "sleep 30"]);
        let session = runtime.create("device-a").unwrap();
        runtime.request_close(session.as_str(), "device-a").unwrap();
        runtime.set_test_signal_error(session.as_str(), Some(Signal::SIGTERM));

        runtime.finish_due_terminations();

        assert_eq!(
            runtime
                .teardown_failure(session.as_str(), "device-a")
                .unwrap(),
            Some((PtyTeardownFailure::TermSignal, 1))
        );
        let closing = &runtime.closing[session.as_str()];
        let bundle = lock_shared_session(&closing.session);
        assert!(bundle.child.is_some());
        assert!(bundle.process_group.is_some());
        assert!(bundle.master.is_some());
        assert!(bundle.reader.is_some());
        assert!(
            bundle
                .input
                .as_ref()
                .is_some_and(|input| input.worker.is_some())
        );
        drop(bundle);

        runtime.set_test_signal_error(session.as_str(), None);
        runtime.force_due_terminations_for_test();
        runtime.finish_due_terminations();
        runtime.force_due_terminations_for_test();
        runtime.finish_due_terminations();
        assert_eq!(
            runtime
                .poll(session.as_str(), "device-a", 0)
                .unwrap()
                .status,
            ClaudePtyStatus::Closed
        );
    }

    #[test]
    fn dropped_lease_is_recovered_without_losing_or_duplicating_capacity() {
        let mut runtime = NodePtyRuntime::test_runtime("/bin/sh", &["-c", "sleep 30"]);
        let session = runtime.create("device-a").unwrap();
        runtime.request_close(session.as_str(), "device-a").unwrap();
        let generation = runtime.closing[session.as_str()].generation;
        let lease = runtime.claim_due_terminations().pop().unwrap();
        assert_eq!(
            Arc::strong_count(&runtime.signalling[session.as_str()].session),
            2
        );

        drop(lease);
        assert!(runtime.claim_due_terminations().is_empty());

        assert!(runtime.signalling.is_empty());
        let closing = &runtime.closing[session.as_str()];
        assert_eq!(closing.generation, generation);
        assert_eq!(closing.attempts, 1);
        assert_eq!(
            closing.last_failure,
            Some(PtyTeardownFailure::LeaseMismatch)
        );
        assert_eq!(Arc::strong_count(&closing.session), 1);
        assert_eq!(runtime.capacity_consumed(), 1);
    }

    #[test]
    fn mismatched_completion_quarantines_the_original_keyed_record_once() {
        let mut runtime = NodePtyRuntime::test_runtime("/bin/sh", &["-c", "sleep 30"]);
        let session = runtime.create("device-a").unwrap();
        runtime.request_close(session.as_str(), "device-a").unwrap();
        let mut lease = runtime.claim_due_terminations().pop().unwrap();
        let original_generation = lease.generation;
        let original_attempt = lease.attempt;
        lease.generation = lease.generation.saturating_add(99);

        runtime.complete_termination(PtyTerminationOutcome {
            result: PtyTerminationResult::Retry {
                termination: lease,
                failure: PtyTeardownFailure::Ownership,
            },
        });

        assert!(runtime.signalling.is_empty());
        assert_eq!(runtime.capacity_consumed(), 1);
        let failure = &runtime.terminal_failures[session.as_str()].closing;
        assert_eq!(failure.generation, original_generation);
        assert_eq!(failure.attempts, original_attempt);
        assert_eq!(
            failure.last_failure,
            Some(PtyTeardownFailure::LeaseMismatch)
        );

        let mut runtime = NodePtyRuntime::test_runtime("/bin/sh", &["-c", "sleep 30"]);
        let session = runtime.create("device-b").unwrap();
        runtime.request_close(session.as_str(), "device-b").unwrap();
        let mut lease = runtime.claim_due_terminations().pop().unwrap();
        lease.session_id = SessionId::new("wrong-key");
        runtime.complete_termination(PtyTerminationOutcome {
            result: PtyTerminationResult::Retry {
                termination: lease,
                failure: PtyTeardownFailure::Ownership,
            },
        });
        assert!(runtime.signalling.is_empty());
        assert_eq!(runtime.capacity_consumed(), 1);
        assert!(runtime.terminal_failures.contains_key(session.as_str()));
        assert!(!runtime.terminal_failures.contains_key("wrong-key"));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn close_causes_coalesce_without_resetting_attempt_or_backoff() {
        let mut runtime = NodePtyRuntime::test_runtime("/bin/sh", &["-c", "sleep 30"]);
        let session = runtime.create("device-a").unwrap();
        runtime.request_close(session.as_str(), "device-a").unwrap();
        runtime.set_test_foreground_identity(session.as_str(), ForegroundIdentity::Unavailable);
        let lease = runtime.claim_due_terminations().pop().unwrap();
        runtime.begin_owner_session_closes("device-a");
        assert_ne!(
            runtime.signalling[session.as_str()].causes & CloseCause::OwnerInvalidated as u8,
            0,
            "an invalidation coalesces while the exclusive lease is outside the mutex"
        );
        runtime.complete_termination(lease.finish());
        let first_not_before = runtime.closing[session.as_str()].not_before;
        assert!(first_not_before >= Instant::now());

        runtime.begin_owner_session_closes("device-a");
        let closing = &runtime.closing[session.as_str()];
        assert_eq!(closing.attempts, 1);
        assert_ne!(closing.causes & CloseCause::Explicit as u8, 0);
        assert_ne!(closing.causes & CloseCause::OwnerInvalidated as u8, 0);

        runtime.force_due_terminations_for_test();
        runtime.finish_due_terminations();
        let closing = &runtime.closing[session.as_str()];
        assert_eq!(closing.attempts, 2);
        assert!(closing.not_before >= Instant::now() + Duration::from_millis(200));
    }

    #[test]
    fn shutdown_latches_admission_and_closed_truth_is_bounded() {
        let mut runtime = NodePtyRuntime::test_runtime("/bin/sh", &["-c", "sleep 30"]);
        let session = runtime.create("device-a").unwrap();
        assert_eq!(
            runtime.begin_shutdown(),
            OwnerSessionCloseDisposition::Retry
        );
        assert_eq!(
            runtime.begin_create("device-a").into_result(),
            Err(ClaudePtyError::Unavailable)
        );
        runtime.finish_due_terminations();
        runtime.force_due_terminations_for_test();
        runtime.finish_due_terminations();
        assert_eq!(
            runtime
                .poll(session.as_str(), "device-a", 0)
                .unwrap()
                .status,
            ClaudePtyStatus::Closed
        );
        assert_eq!(
            runtime.shutdown_disposition(),
            OwnerSessionCloseDisposition::Complete
        );

        for index in 0..=MAX_CLOSED_PTY_SESSIONS {
            runtime.insert_closed(
                format!("closed-{index}"),
                ClosedSession {
                    owner_device_id: "device-a".into(),
                    next_cursor: 0,
                    dropped_chunks: 0,
                    order: 0,
                },
            );
        }
        assert_eq!(runtime.closed.len(), MAX_CLOSED_PTY_SESSIONS);
        assert!(!runtime.closed.contains_key("closed-0"));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn persistent_reap_errors_exhaust_retries_without_freeing_capacity() {
        let mut runtime = NodePtyRuntime::test_runtime("/bin/sh", &["-c", "sleep 30"]);
        let session = runtime.create("device-a").unwrap();
        let attempts = Arc::new(AtomicU64::new(0));

        runtime.request_close(session.as_str(), "device-a").unwrap();
        runtime
            .set_test_foreground_identity(session.as_str(), ForegroundIdentity::NoForegroundGroup);
        runtime.replace_test_closing_child(
            session.as_str(),
            Box::new(ErrorChild {
                attempts: Arc::clone(&attempts),
            }),
        );
        for _ in 0..PTY_CLOSE_ATTEMPTS {
            runtime.force_due_terminations_for_test();
            runtime.finish_due_terminations();
        }

        assert_eq!(attempts.load(Ordering::Acquire), PTY_CLOSE_ATTEMPTS as u64);
        assert!(runtime.terminal_failures.contains_key(session.as_str()));
        assert_eq!(runtime.capacity_consumed(), 1);
        assert_eq!(
            runtime.poll(session.as_str(), "device-a", 0),
            Err(ClaudePtyError::TeardownFailed),
            "retry exhaustion must not lie with a Closed result"
        );
        assert_eq!(
            runtime.owner_close_disposition("device-a"),
            OwnerSessionCloseDisposition::Retry,
            "terminal teardown failure must prevent auth invalidation acknowledgement"
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn reap_deadline_remains_retryable_with_child_and_identity_retained() {
        let mut runtime = NodePtyRuntime::test_runtime("/bin/sh", &["-c", "sleep 30"]);
        let session = runtime.create("device-a").unwrap();
        runtime.request_close(session.as_str(), "device-a").unwrap();
        runtime
            .set_test_foreground_identity(session.as_str(), ForegroundIdentity::NoForegroundGroup);
        runtime.replace_test_closing_child(
            session.as_str(),
            Box::new(BlockingChild {
                release: Arc::new(AtomicBool::new(false)),
                poll_started: Arc::new(AtomicBool::new(false)),
                reaped: Arc::new(AtomicBool::new(false)),
            }),
        );

        runtime.finish_due_terminations();

        let failure = runtime
            .teardown_failure(session.as_str(), "device-a")
            .unwrap()
            .expect("bounded reap reports a retry reason");
        assert!(matches!(
            failure.0,
            PtyTeardownFailure::ReapDeadline | PtyTeardownFailure::ReapAttemptsExhausted
        ));
        let bundle = lock_shared_session(&runtime.closing[session.as_str()].session);
        assert!(bundle.child.is_some());
        assert!(bundle.process_group.is_some());
        assert!(!bundle.child_reaped);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn reaped_child_waits_for_reader_without_re_signalling() {
        let mut runtime = NodePtyRuntime::test_runtime("/bin/sh", &["-c", "sleep 30"]);
        let session = runtime.create("device-a").unwrap();
        runtime.request_close(session.as_str(), "device-a").unwrap();
        {
            let shared = Arc::clone(&runtime.closing[session.as_str()].session);
            let mut bundle = lock_shared_session(&shared);
            bundle.reader.take();
            bundle.reader = Some(thread::spawn(|| thread::sleep(Duration::from_millis(500))));
        }

        runtime.finish_due_terminations();
        {
            let closing = &runtime.closing[session.as_str()];
            assert_eq!(
                closing.last_failure,
                Some(PtyTeardownFailure::ResourceHandlesPending)
            );
            assert!(lock_shared_session(&closing.session).child_reaped);
        }
        runtime.set_test_signal_error(session.as_str(), Some(Signal::SIGTERM));
        thread::sleep(Duration::from_millis(300));
        runtime.force_due_terminations_for_test();
        runtime.finish_due_terminations();
        assert_eq!(
            runtime
                .poll(session.as_str(), "device-a", 0)
                .unwrap()
                .status,
            ClaudePtyStatus::Closed
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn failed_prune_consumes_full_capacity_until_retry_succeeds() {
        let mut runtime = NodePtyRuntime::test_runtime("/bin/sh", &["-c", "sleep 30"]);
        let sessions = (0..MAX_PTY_SESSIONS)
            .map(|_| runtime.create("device-a").unwrap())
            .collect::<Vec<_>>();
        let exited = sessions[0].as_str();
        runtime.sessions.get_mut(exited).unwrap().status = ClaudePtyStatus::Exited;
        runtime.set_test_foreground_identity(exited, ForegroundIdentity::Unavailable);

        assert_eq!(
            runtime.begin_create("device-a").into_result(),
            Err(ClaudePtyError::Capacity)
        );
        runtime.finish_due_terminations();
        assert_eq!(runtime.capacity_consumed(), MAX_PTY_SESSIONS);
        assert_eq!(
            runtime.begin_create("device-a").into_result(),
            Err(ClaudePtyError::Capacity),
            "failed prune must not open an admission slot"
        );

        runtime.set_test_foreground_identity(exited, ForegroundIdentity::NoForegroundGroup);
        for _ in 0..2 {
            runtime.force_due_terminations_for_test();
            runtime.finish_due_terminations();
        }
        assert!(runtime.begin_create("device-a").into_result().is_ok());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn partial_startup_bundle_uses_the_same_retryable_owner() {
        let mut runtime = NodePtyRuntime::test_runtime("/bin/sh", &["-c", "sleep 30"]);
        let session = runtime.create("device-a").unwrap();
        let mut managed = runtime.sessions.remove(session.as_str()).unwrap();
        managed.reader_stop.store(true, Ordering::Release);
        managed.reader.take();
        runtime.register_startup_failure(
            session.clone(),
            "device-a",
            managed.child.take().unwrap(),
            managed.process_group.take(),
            managed.master.take().unwrap(),
            managed.input.take(),
        );
        runtime.set_test_signal_error(session.as_str(), Some(Signal::SIGTERM));

        runtime.finish_due_terminations();

        assert!(
            runtime.sessions.is_empty(),
            "partial startup exposes no active handle"
        );
        assert_eq!(runtime.capacity_consumed(), 1);
        assert_eq!(
            runtime
                .teardown_failure(session.as_str(), "device-a")
                .unwrap(),
            Some((PtyTeardownFailure::TermSignal, 1))
        );
        let bundle = lock_shared_session(&runtime.closing[session.as_str()].session);
        assert!(bundle.child.is_some());
        assert!(bundle.master.is_some());
        assert!(bundle.process_group.is_some());
        drop(bundle);

        runtime.set_test_signal_error(session.as_str(), None);
        for _ in 0..2 {
            runtime.force_due_terminations_for_test();
            runtime.finish_due_terminations();
        }
        assert_eq!(
            runtime
                .poll(session.as_str(), "device-a", 0)
                .unwrap()
                .status,
            ClaudePtyStatus::Closed
        );
        assert_eq!(runtime.capacity_consumed(), 0);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn startup_without_a_process_group_kills_and_reaps_the_direct_child() {
        let mut runtime = NodePtyRuntime::test_runtime("/bin/sh", &["-c", "exec sleep 30"]);
        let session = runtime.create("device-a").unwrap();
        let mut managed = runtime.sessions.remove(session.as_str()).unwrap();
        managed.reader_stop.store(true, Ordering::Release);
        managed.reader.take();
        managed.process_group.take();
        runtime.register_startup_failure(
            session.clone(),
            "device-a",
            managed.child.take().unwrap(),
            None,
            managed.master.take().unwrap(),
            managed.input.take(),
        );

        for _ in 0..PTY_CLOSE_ATTEMPTS {
            runtime.force_due_terminations_for_test();
            runtime.finish_due_terminations();
            if runtime.closed.contains_key(session.as_str()) {
                break;
            }
        }

        assert_eq!(
            runtime
                .poll(session.as_str(), "device-a", 0)
                .unwrap()
                .status,
            ClaudePtyStatus::Closed
        );
        assert_eq!(runtime.capacity_consumed(), 0);
        assert!(!runtime.has_terminal_failures());
    }

    #[test]
    fn automatic_pruning_does_not_wait_through_term_grace_before_create_returns() {
        let mut runtime = NodePtyRuntime::test_runtime("/bin/sh", &["-c", "sleep 30"]);
        let exited = runtime.create("device-a").unwrap();
        runtime.sessions.get_mut(exited.as_str()).unwrap().status = ClaudePtyStatus::Exited;

        let started = Instant::now();
        let result = runtime.begin_create("device-a").into_result();
        assert!(
            started.elapsed() < Duration::from_millis(50),
            "automatic pruning must detach TERM/KILL grace before the caller releases its runtime mutex"
        );

        let replacement = result.unwrap();
        runtime.finish_due_terminations();

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
            runtime.close(session.as_str(), "device-a").unwrap().status,
            ClaudePtyStatus::Closing,
            "missing foreground identity must leave the child retryable instead of issuing killpg"
        );
        assert!(runtime.closing.contains_key(session.as_str()));

        let _ = killpg(Pid::from_raw(process_group), Signal::SIGKILL);
        runtime
            .set_test_foreground_identity(session.as_str(), ForegroundIdentity::NoForegroundGroup);
        runtime.force_due_terminations_for_test();
        runtime.finish_due_terminations();
        assert_eq!(
            runtime
                .poll(session.as_str(), "device-a", 0)
                .unwrap()
                .status,
            ClaudePtyStatus::Closed
        );
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
        assert!(runtime.closing.contains_key(session.as_str()));
        assert_eq!(
            runtime.close(session.as_str(), "device-a").unwrap().status,
            ClaudePtyStatus::Closing
        );
        assert!(runtime.closing.contains_key(session.as_str()));
        runtime.prune_finished_sessions();
        assert!(
            runtime.closing.contains_key(session.as_str()),
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
