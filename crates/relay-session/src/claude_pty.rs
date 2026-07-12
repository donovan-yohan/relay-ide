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
use std::sync::mpsc::{self, Receiver, TryRecvError, TrySendError};
use std::thread::{self, JoinHandle};
use std::time::Duration;

#[cfg(all(unix, test))]
use nix::{errno::Errno, sys::signal::kill};
#[cfg(unix)]
use nix::{
    sys::signal::{Signal, killpg},
    unistd::{Pid, getpgid},
};
use portable_pty::{Child, CommandBuilder, MasterPty, PtySize, native_pty_system};

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
/// One small node runtime is deliberately capped before it becomes a terminal
/// platform or a hidden process farm.
pub const MAX_PTY_SESSIONS: usize = 8;
const MIN_ROWS: u16 = 4;
const MAX_ROWS: u16 = 300;
const MIN_COLS: u16 = 20;
const MAX_COLS: u16 = 500;
const PTY_TERMINATION_GRACE: Duration = Duration::from_millis(250);

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
    Exit,
}

#[derive(Debug)]
struct ScrollbackChunk {
    sequence: u64,
    text: String,
    bytes: usize,
}

struct ManagedSession {
    owner_device_id: String,
    status: ClaudePtyStatus,
    child: Option<Box<dyn Child + Send + Sync>>,
    process_group: Option<i32>,
    master: Option<Box<dyn MasterPty + Send>>,
    writer: Option<Box<dyn Write + Send>>,
    reader: Option<JoinHandle<()>>,
    reader_rx: Receiver<ReaderEvent>,
    reader_stop: Arc<AtomicBool>,
    reader_dropped: Arc<AtomicU64>,
    output: VecDeque<ScrollbackChunk>,
    output_bytes: usize,
    next_sequence: u64,
    pending_utf8: Vec<u8>,
    terminal_seen: bool,
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
        if owner_device_id.is_empty() || owner_device_id.len() > 64 {
            return Err(ClaudePtyError::Forbidden);
        }
        self.prune_finished_sessions();
        if self.sessions.len() >= MAX_PTY_SESSIONS {
            return Err(ClaudePtyError::Capacity);
        }

        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(default_size())
            .map_err(|_| ClaudePtyError::Transport)?;
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

        let mut child = pair
            .slave
            .spawn_command(command)
            .map_err(|_| ClaudePtyError::Unavailable)?;
        drop(pair.slave);
        let process_group = child.process_id().and_then(session_process_group);
        let reader = match pair.master.try_clone_reader() {
            Ok(reader) => reader,
            Err(_) => {
                terminate_child(&mut child, process_group);
                return Err(ClaudePtyError::Transport);
            }
        };
        let writer = match pair.master.take_writer() {
            Ok(writer) => writer,
            Err(_) => {
                terminate_child(&mut child, process_group);
                return Err(ClaudePtyError::Transport);
            }
        };
        let (reader_tx, reader_rx) = mpsc::sync_channel(PTY_INBOUND_CAP);
        let reader_stop = Arc::new(AtomicBool::new(false));
        let reader_dropped = Arc::new(AtomicU64::new(0));
        let reader_thread = match spawn_reader(
            reader,
            reader_tx,
            Arc::clone(&reader_stop),
            Arc::clone(&reader_dropped),
        ) {
            Ok(reader_thread) => reader_thread,
            Err(error) => {
                drop(writer);
                terminate_child(&mut child, process_group);
                return Err(error);
            }
        };

        let id = format!("claude-pty-{}", self.next_id);
        self.next_id = self.next_id.saturating_add(1);
        self.sessions.insert(
            id.clone(),
            ManagedSession {
                owner_device_id: owner_device_id.to_owned(),
                status: ClaudePtyStatus::Starting,
                child: Some(child),
                process_group,
                master: Some(pair.master),
                writer: Some(writer),
                reader: Some(reader_thread),
                reader_rx,
                reader_stop,
                reader_dropped,
                output: VecDeque::new(),
                output_bytes: 0,
                next_sequence: 1,
                pending_utf8: Vec::new(),
                terminal_seen: false,
            },
        );
        Ok(SessionId::new(id))
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
        let writer = session.writer.as_mut().ok_or(ClaudePtyError::StaleHandle)?;
        writer
            .write_all(data.as_bytes())
            .and_then(|()| writer.flush())
            .map_err(|_| ClaudePtyError::Transport)
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
        let session = self.session_mut(session_id, owner_device_id)?;
        session.close();
        Ok(TerminalSnapshot {
            session_id: SessionId::new(session_id),
            status: session.status,
            output: Vec::new(),
            next_cursor: session.next_sequence.saturating_sub(1),
            has_more: false,
            truncated: false,
            dropped_chunks: session.reader_dropped.load(Ordering::Acquire),
        })
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
    fn prune_finished_sessions(&mut self) {
        self.sessions.retain(|_, session| {
            session.pump();
            !matches!(
                session.status,
                ClaudePtyStatus::Closed | ClaudePtyStatus::Exited
            )
        });
    }

    /// Reap every PTY bound to a browser-device identity after that browser
    /// session is revoked. The opaque browser session token never crosses the
    /// auth boundary; this runtime only receives its already-authenticated
    /// device identity.
    pub fn close_owner_sessions(&mut self, owner_device_id: &str) {
        self.sessions.retain(|_, session| {
            if session.owner_device_id == owner_device_id {
                session.close();
                false
            } else {
                true
            }
        });
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
        loop {
            match self.reader_rx.try_recv() {
                Ok(ReaderEvent::Output(bytes)) => self.append_output(bytes),
                Ok(ReaderEvent::Exit) => {
                    self.flush_pending_output();
                    self.terminal_seen = true;
                }
                Err(TryRecvError::Empty | TryRecvError::Disconnected) => break,
            }
        }
        if self.status == ClaudePtyStatus::Closed {
            return;
        }
        if self.terminal_seen
            || self
                .child
                .as_mut()
                .and_then(|child| child.try_wait().ok().flatten())
                .is_some()
        {
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

    fn close(&mut self) {
        if self.status == ClaudePtyStatus::Closed {
            return;
        }
        self.reader_stop.store(true, Ordering::Release);
        self.writer.take();
        if let Some(child) = self.child.as_mut() {
            terminate_child(child, self.process_group);
        }
        self.child.take();
        self.master.take();
        if let Some(reader) = self.reader.take() {
            let _ = reader.join();
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
                        let _ = sender.try_send(ReaderEvent::Exit);
                        break;
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(_) => {
                        let _ = sender.try_send(ReaderEvent::Exit);
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

fn session_process_group(process_id: u32) -> Option<i32> {
    #[cfg(unix)]
    {
        let process_id = i32::try_from(process_id).ok()?;
        // portable-pty creates the child as a new session leader. Require its
        // process group to match the leader PID before ever signalling a group.
        let process_group = getpgid(Some(Pid::from_raw(process_id))).ok()?.as_raw();
        (process_group == process_id).then_some(process_group)
    }
    #[cfg(not(unix))]
    {
        let _ = process_id;
        None
    }
}

fn terminate_child(child: &mut Box<dyn Child + Send + Sync>, process_group: Option<i32>) {
    #[cfg(unix)]
    if let Some(process_group) = process_group {
        // Terminate both the session leader and its PTY descendants. Give a
        // cooperative TUI a bounded chance to handle SIGTERM before the final
        // group kill guarantees Relay does not orphan descendants.
        let process_group = Pid::from_raw(process_group);
        let _ = killpg(process_group, Signal::SIGTERM);
        thread::sleep(PTY_TERMINATION_GRACE);
        let _ = killpg(process_group, Signal::SIGKILL);
    }
    let _ = child.kill();
    let _ = child.wait();
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

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
        assert!(runtime.sessions[session.as_str()].child.is_none());
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
}
