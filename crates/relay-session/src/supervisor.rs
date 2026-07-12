//! One-node supervised Codex app-server session.
//!
//! `Supervisor` owns one local child transport and drives the documented
//! `initialize` → `initialized` → `thread/start` / `thread/resume` →
//! `turn/start` / `turn/interrupt` lifecycle. It uses finite deadlines,
//! ordered event sequencing, bounded queues, and explicit degraded/failed state.

use std::collections::VecDeque;
use std::io::{self, BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender, SyncSender, TrySendError};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use crate::codex::{Mapped, approval_kind_for_method, codex_command_args, map_frame};
use crate::contract::{
    ApprovalDecision, ApprovalId, ApprovalRequest, ChatCategory, ChatRole, ChatSignal,
    DegradedReason, EventKind, FailureKind, RichChatEvent, Sequence, SessionError, SessionEvent,
    SessionId, SessionStatus, StreamSignals,
};
use crate::jsonl::{Frame, FrameClass, MAX_LINE_BYTES, ResultField, ScanError, scan_line};

/// Bounded neutral event queue capacity.
pub const EVENT_QUEUE_CAP: usize = 1024;
/// Bounded child-reader to supervisor hand-off capacity.
pub const INBOUND_QUEUE_CAP: usize = 1024;
/// Degraded frames tolerated before terminal protocol failure.
pub const DEGRADED_TOLERANCE: u64 = 64;
/// Dropped neutral events tolerated before terminal queue failure.
pub const DROP_TOLERANCE: u64 = 4096;
/// Default deadline for one control request.
pub const DEFAULT_DEADLINE: Duration = Duration::from_secs(10);

/// Bounded number of control writes awaiting the process writer.
pub const OUTBOUND_QUEUE_CAP: usize = 16;

const OUTBOUND_CONTROL_LINE_TOO_LARGE: &str = "outbound control line exceeds limit";

/// One arrival-ordered transport item.
#[derive(Debug)]
pub enum TransportItem {
    Line(Result<Frame, ScanError>),
    Exit,
}

/// A writable JSONL transport with owned lifecycle control.
///
/// `write_line` queues one bounded line and returns a completion receiver. It
/// must not wait for the child to consume the line; the supervisor applies the
/// control operation's deadline while waiting for that completion.
pub trait Transport: Send {
    fn write_line(&mut self, line: String) -> io::Result<Receiver<io::Result<()>>>;
    /// Interrupt a pending control write without waiting for thread teardown.
    fn abort_write(&mut self);
    fn items(&self) -> &Receiver<TransportItem>;
    fn shutdown(&mut self);
}

struct OutboundWrite {
    line: String,
    complete: SyncSender<io::Result<()>>,
}

struct ReapTask {
    child: Child,
    writer: JoinHandle<()>,
    reader: JoinHandle<()>,
}

/// The real, fixed-command local process transport.
pub struct ProcessTransport {
    child: Option<Child>,
    write_tx: Option<SyncSender<OutboundWrite>>,
    rx: Receiver<TransportItem>,
    writer: Option<JoinHandle<()>>,
    reader: Option<JoinHandle<()>>,
    reap_tx: Option<Sender<ReapTask>>,
    reaper: Option<JoinHandle<()>>,
    stopping: Arc<AtomicBool>,
}

impl ProcessTransport {
    /// Spawns exactly `codex app-server --stdio`; callers cannot supply an
    /// alternative executable or transport.
    pub fn spawn(cwd: Option<&Path>) -> Result<Self, SessionError> {
        Self::spawn_program("codex", cwd)
    }

    fn spawn_program(program: &str, cwd: Option<&Path>) -> Result<Self, SessionError> {
        let mut command = Command::new(program);
        command
            .args(codex_command_args())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        if let Some(cwd) = cwd {
            command.current_dir(cwd);
        }
        let mut child = command.spawn().map_err(|_| SessionError::Unavailable)?;
        let stdin = child.stdin.take().ok_or(SessionError::Transport)?;
        let stdout = child.stdout.take().ok_or(SessionError::Transport)?;
        let (tx, rx) = mpsc::sync_channel(INBOUND_QUEUE_CAP);
        let (write_tx, write_rx) = mpsc::sync_channel(OUTBOUND_QUEUE_CAP);
        let stopping = Arc::new(AtomicBool::new(false));
        let (reap_tx, reap_rx) = mpsc::channel();
        let reaper = match thread::Builder::new()
            .name("relay-codex-reaper".into())
            .spawn(move || reaper_loop(reap_rx))
        {
            Ok(reaper) => reaper,
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(SessionError::Transport);
            }
        };
        let writer_stopping = Arc::clone(&stopping);
        let writer = match thread::Builder::new()
            .name("relay-codex-writer".into())
            .spawn(move || writer_loop(stdin, write_rx, writer_stopping))
        {
            Ok(writer) => writer,
            Err(_) => {
                drop(reap_tx);
                let _ = child.kill();
                let _ = child.wait();
                let _ = reaper.join();
                return Err(SessionError::Transport);
            }
        };
        let reader_stopping = Arc::clone(&stopping);
        let reader = match thread::Builder::new()
            .name("relay-codex-reader".into())
            .spawn(move || reader_loop(stdout, tx, reader_stopping))
        {
            Ok(reader) => reader,
            Err(_) => {
                stopping.store(true, Ordering::Release);
                drop(write_tx);
                drop(reap_tx);
                let _ = child.kill();
                let _ = child.wait();
                let _ = writer.join();
                let _ = reaper.join();
                return Err(SessionError::Transport);
            }
        };
        Ok(Self {
            child: Some(child),
            write_tx: Some(write_tx),
            rx,
            writer: Some(writer),
            reader: Some(reader),
            reap_tx: Some(reap_tx),
            reaper: Some(reaper),
            stopping,
        })
    }
}

/// Send an item without allowing shutdown to deadlock on a full bounded queue.
fn send_item(
    tx: &SyncSender<TransportItem>,
    mut item: TransportItem,
    stopping: &AtomicBool,
) -> bool {
    loop {
        if stopping.load(Ordering::Acquire) {
            return false;
        }
        match tx.try_send(item) {
            Ok(()) => return true,
            Err(TrySendError::Disconnected(_)) => return false,
            Err(TrySendError::Full(returned)) => {
                item = returned;
                thread::sleep(Duration::from_millis(1));
            }
        }
    }
}

/// Read bounded lines in arrival order. A full hand-off queue applies OS-level
/// backpressure to stdout rather than retaining unbounded provider output.
fn reader_loop<R: io::Read>(stdout: R, tx: SyncSender<TransportItem>, stopping: Arc<AtomicBool>) {
    let mut reader = BufReader::new(stdout);
    let mut buffer = Vec::with_capacity(4096);
    loop {
        buffer.clear();
        match read_bounded_line(&mut reader, &mut buffer) {
            Ok(0) | Err(_) => {
                let _ = send_item(&tx, TransportItem::Exit, &stopping);
                return;
            }
            Ok(_) => {
                if !send_item(&tx, TransportItem::Line(scan_line(&buffer)), &stopping) {
                    return;
                }
            }
        }
    }
}

/// Write control lines on a dedicated bounded worker. The supervisor waits on
/// each completion receiver, so a child that stops reading stdin cannot block
/// its control deadline.
fn writer_loop(mut stdin: ChildStdin, rx: Receiver<OutboundWrite>, stopping: Arc<AtomicBool>) {
    while let Ok(write) = rx.recv() {
        let result = if stopping.load(Ordering::Acquire) {
            Err(io::Error::new(
                io::ErrorKind::BrokenPipe,
                "transport stopping",
            ))
        } else {
            stdin
                .write_all(write.line.as_bytes())
                .and_then(|()| stdin.write_all(b"\n"))
                .and_then(|()| stdin.flush())
        };
        let failed = result.is_err();
        let _ = write.complete.send(result);
        if failed {
            return;
        }
    }
}

/// Reap a killed child and join its IO workers without delaying the supervisor
/// past the control operation's deadline.
fn reaper_loop(rx: Receiver<ReapTask>) {
    while let Ok(task) = rx.recv() {
        let mut child = task.child;
        let _ = child.wait();
        let _ = task.writer.join();
        let _ = task.reader.join();
    }
}

/// Read one line while retaining no more than `MAX_LINE_BYTES + 1` bytes. The
/// rest of an over-limit line is drained before the next frame is read.
fn read_bounded_line<R: BufRead>(reader: &mut R, buffer: &mut Vec<u8>) -> io::Result<usize> {
    let limit = MAX_LINE_BYTES + 1;
    let mut total = 0;
    loop {
        let available = match reader.fill_buf() {
            Ok(available) => available,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(error),
        };
        if available.is_empty() {
            return Ok(total);
        }
        if let Some(newline) = available.iter().position(|byte| *byte == b'\n') {
            if buffer.len() < limit {
                let take = newline.min(limit - buffer.len());
                buffer.extend_from_slice(&available[..take]);
            }
            reader.consume(newline + 1);
            return Ok(total + newline + 1);
        }
        if buffer.len() < limit {
            let take = available.len().min(limit - buffer.len());
            buffer.extend_from_slice(&available[..take]);
        }
        total += available.len();
        let consumed = available.len();
        reader.consume(consumed);
    }
}

impl Transport for ProcessTransport {
    fn write_line(&mut self, line: String) -> io::Result<Receiver<io::Result<()>>> {
        let (complete_tx, complete_rx) = mpsc::sync_channel(1);
        let write = OutboundWrite {
            line,
            complete: complete_tx,
        };
        self.write_tx
            .as_ref()
            .ok_or_else(|| io::Error::new(io::ErrorKind::BrokenPipe, "stdin closed"))?
            .try_send(write)
            .map_err(|error| match error {
                TrySendError::Full(_) => {
                    io::Error::new(io::ErrorKind::WouldBlock, "outbound queue full")
                }
                TrySendError::Disconnected(_) => {
                    io::Error::new(io::ErrorKind::BrokenPipe, "writer stopped")
                }
            })?;
        Ok(complete_rx)
    }

    fn abort_write(&mut self) {
        self.stopping.store(true, Ordering::Release);
        self.write_tx.take();
        let Some(mut child) = self.child.take() else {
            return;
        };
        let _ = child.kill();
        let task = ReapTask {
            child,
            writer: self
                .writer
                .take()
                .expect("live process transport has a writer"),
            reader: self
                .reader
                .take()
                .expect("live process transport has a reader"),
        };
        let reap_tx = self
            .reap_tx
            .take()
            .expect("live process transport has a reaper");
        let reaper = self
            .reaper
            .take()
            .expect("live process transport has a reaper handle");
        reap_tx
            .send(task)
            .expect("live process transport reaper is receiving");
        drop(reap_tx);
        drop(reaper);
    }

    fn items(&self) -> &Receiver<TransportItem> {
        &self.rx
    }

    fn shutdown(&mut self) {
        self.stopping.store(true, Ordering::Release);
        self.write_tx.take();
        self.reap_tx.take();
        if let Some(mut child) = self.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
        if let Some(writer) = self.writer.take() {
            let _ = writer.join();
        }
        if let Some(reader) = self.reader.take() {
            let _ = reader.join();
        }
        if let Some(reaper) = self.reaper.take() {
            let _ = reaper.join();
        }
    }
}

impl Drop for ProcessTransport {
    fn drop(&mut self) {
        self.shutdown();
    }
}

/// Deterministic no-process transport for contract/failure tests.
pub struct ScriptedTransport {
    rx: Receiver<TransportItem>,
    writes: Vec<String>,
    write_fails: bool,
}

impl ScriptedTransport {
    pub fn from_lines<I, S>(lines: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: AsRef<[u8]>,
    {
        let (tx, rx) = mpsc::channel();
        for line in lines {
            let _ = tx.send(TransportItem::Line(scan_line(line.as_ref())));
        }
        let _ = tx.send(TransportItem::Exit);
        drop(tx);
        Self {
            rx,
            writes: Vec::new(),
            write_fails: false,
        }
    }

    pub fn from_items<I: IntoIterator<Item = TransportItem>>(items: I) -> Self {
        let (tx, rx) = mpsc::channel();
        for item in items {
            let _ = tx.send(item);
        }
        drop(tx);
        Self {
            rx,
            writes: Vec::new(),
            write_fails: false,
        }
    }

    pub fn with_write_failure(mut self) -> Self {
        self.write_fails = true;
        self
    }

    pub fn writes(&self) -> &[String] {
        &self.writes
    }
}

impl Transport for ScriptedTransport {
    fn write_line(&mut self, line: String) -> io::Result<Receiver<io::Result<()>>> {
        if self.write_fails {
            return Err(io::Error::new(
                io::ErrorKind::BrokenPipe,
                "scripted write failure",
            ));
        }
        self.writes.push(line);
        let (complete_tx, complete_rx) = mpsc::sync_channel(1);
        let _ = complete_tx.send(Ok(()));
        Ok(complete_rx)
    }

    fn abort_write(&mut self) {}

    fn items(&self) -> &Receiver<TransportItem> {
        &self.rx
    }

    fn shutdown(&mut self) {}
}

/// Owns one session's state, local process, and bounded neutral event stream.
pub struct Supervisor<T: Transport> {
    transport: T,
    status: SessionStatus,
    signals: StreamSignals,
    queue: VecDeque<SessionEvent>,
    approvals: VecDeque<ApprovalRequest>,
    next_seq: u64,
    next_id: u64,
    degraded_count: u64,
    session: Option<SessionId>,
    active_turn: Option<String>,
    completed_turns: VecDeque<String>,
}

impl<T: Transport> Supervisor<T> {
    pub fn new(transport: T) -> Self {
        Self {
            transport,
            status: SessionStatus::Starting,
            signals: StreamSignals::default(),
            queue: VecDeque::with_capacity(EVENT_QUEUE_CAP),
            approvals: VecDeque::with_capacity(EVENT_QUEUE_CAP),
            next_seq: 0,
            next_id: 1,
            degraded_count: 0,
            session: None,
            active_turn: None,
            completed_turns: VecDeque::with_capacity(EVENT_QUEUE_CAP),
        }
    }

    pub fn status(&self) -> &SessionStatus {
        &self.status
    }

    pub fn signals(&self) -> StreamSignals {
        self.signals
    }

    pub fn session_id(&self) -> Option<&SessionId> {
        self.session.as_ref()
    }

    pub fn transport(&self) -> &T {
        &self.transport
    }

    pub fn next_event(&mut self) -> Option<SessionEvent> {
        self.queue.pop_front()
    }

    pub fn queued(&self) -> usize {
        self.queue.len()
    }

    pub fn next_approval(&self) -> Option<ApprovalRequest> {
        self.approvals.front().cloned()
    }

    /// Reply once to a documented command/file approval. The only accept form
    /// is `accept`; session/policy amendment responses are deliberately absent.
    pub fn respond_to_approval(
        &mut self,
        approval: &ApprovalRequest,
        decision: ApprovalDecision,
    ) -> Result<(), SessionError> {
        self.ensure_live()?;
        let deadline = self.deadline_after(DEFAULT_DEADLINE)?;
        let index = self
            .approvals
            .iter()
            .position(|pending| pending == approval)
            .ok_or(SessionError::Unsupported("unknown approval"))?;
        let decision = match decision {
            ApprovalDecision::AcceptOnce => "accept",
            ApprovalDecision::Decline => "decline",
            ApprovalDecision::Cancel => "cancel",
        };
        let response = format!(
            "{{\"jsonrpc\":\"2.0\",\"id\":{},\"result\":{{\"decision\":\"{decision}\"}}}}",
            approval.id.as_str()
        );
        self.write_control_line(&response, deadline)?;
        self.approvals.remove(index);
        Ok(())
    }

    pub fn create(&mut self, deadline: Duration) -> Result<SessionId, SessionError> {
        self.ensure_live()?;
        let overall = self.deadline_after(deadline)?;
        let initialize = self.send_request("initialize", INITIALIZE_PARAMS, overall)?;
        self.await_response(&initialize, overall)?;
        self.send_notification("initialized", overall)?;
        let start = self.send_request("thread/start", "{}", overall)?;
        let thread_id = self.await_result_thread_id(&start, overall)?;
        let session = SessionId::new(thread_id);
        self.session = Some(session.clone());
        self.status = SessionStatus::Idle;
        Ok(session)
    }

    pub fn resume(
        &mut self,
        thread_id: &str,
        deadline: Duration,
    ) -> Result<SessionId, SessionError> {
        self.resume_at_cwd(thread_id, None, deadline)
    }

    /// Resume a persisted Codex thread while explicitly overriding its working
    /// directory with a hub-approved canonical CWD.
    pub fn resume_in_cwd(
        &mut self,
        thread_id: &str,
        cwd: &str,
        deadline: Duration,
    ) -> Result<SessionId, SessionError> {
        self.resume_at_cwd(thread_id, Some(cwd), deadline)
    }

    fn resume_at_cwd(
        &mut self,
        thread_id: &str,
        cwd: Option<&str>,
        deadline: Duration,
    ) -> Result<SessionId, SessionError> {
        self.ensure_live()?;
        let overall = self.deadline_after(deadline)?;
        let initialize = self.send_request("initialize", INITIALIZE_PARAMS, overall)?;
        self.await_response(&initialize, overall)?;
        self.send_notification("initialized", overall)?;
        let params = match cwd {
            Some(cwd) => format!(
                "{{\"threadId\":{},\"cwd\":{}}}",
                json_string_bounded(thread_id)?,
                json_string_bounded(cwd)?,
            ),
            None => format!("{{\"threadId\":{}}}", json_string_bounded(thread_id)?),
        };
        let resume = self.send_request("thread/resume", &params, overall)?;
        let resumed_id = self.await_result_thread_id(&resume, overall)?;
        if resumed_id != thread_id {
            self.status = SessionStatus::Failed(FailureKind::ProtocolViolation);
            return Err(SessionError::Terminal(FailureKind::ProtocolViolation));
        }
        let session = SessionId::new(resumed_id);
        self.session = Some(session.clone());
        self.status = SessionStatus::Idle;
        Ok(session)
    }

    pub fn prompt(&mut self, text: &str, deadline: Duration) -> Result<String, SessionError> {
        self.ensure_live()?;
        let overall = self.deadline_after(deadline)?;
        let session = self
            .session
            .clone()
            .ok_or(SessionError::Unsupported("no active session"))?;
        let params = format!(
            "{{\"threadId\":{},\"input\":[{{\"type\":\"text\",\"text\":{}}}]}}",
            json_string_bounded(session.as_str())?,
            json_string_bounded(text)?
        );
        let turn = self.send_request("turn/start", &params, overall)?;
        let turn_id = self.await_result_turn_id(&turn, overall)?;
        if self.take_completed_turn(&turn_id) {
            self.active_turn = None;
            self.status = SessionStatus::Idle;
        } else {
            self.active_turn = Some(turn_id.clone());
            self.status = SessionStatus::Working;
        }
        Ok(turn_id)
    }

    pub fn cancel(&mut self, turn_id: &str, deadline: Duration) -> Result<(), SessionError> {
        self.ensure_live()?;
        let overall = self.deadline_after(deadline)?;
        let session = self
            .session
            .clone()
            .ok_or(SessionError::Unsupported("no active session"))?;
        if self.active_turn.as_deref() != Some(turn_id) {
            if let Some(error) = self.record_degraded(DegradedReason::CancellationRace) {
                return Err(error);
            }
            return Err(SessionError::Raced(DegradedReason::CancellationRace));
        }
        let params = format!(
            "{{\"threadId\":{},\"turnId\":{}}}",
            json_string_bounded(session.as_str())?,
            json_string_bounded(turn_id)?
        );
        let interrupt = self.send_request("turn/interrupt", &params, overall)?;
        match self.await_response(&interrupt, overall) {
            Ok(()) => {
                self.active_turn = None;
                self.status = SessionStatus::Idle;
                Ok(())
            }
            // During response waiting, only a matching completion clears the
            // active turn. That validates this race; other provider errors
            // preserve their typed error and active-turn state.
            Err(SessionError::Unsupported("provider error response"))
                if self.active_turn.is_none() =>
            {
                if let Some(error) = self.record_degraded(DegradedReason::CancellationRace) {
                    return Err(error);
                }
                Err(SessionError::Raced(DegradedReason::CancellationRace))
            }
            Err(error) => Err(error),
        }
    }

    /// Nonblocking stream drain for UI/status consumers.
    pub fn pump(&mut self) {
        while let Ok(item) = self.transport.items().try_recv() {
            let _ = self.absorb(item);
        }
    }

    /// Close/reap the owned process. Recovery is an explicit new create/resume.
    pub fn close(&mut self) {
        self.transport.shutdown();
        if !self.status.is_terminal() {
            self.status = SessionStatus::Closed;
        }
    }

    fn ensure_live(&self) -> Result<(), SessionError> {
        match self.status {
            SessionStatus::Failed(kind) => Err(SessionError::Terminal(kind)),
            SessionStatus::Closed => Err(SessionError::Terminal(FailureKind::ProcessTerminated)),
            _ => Ok(()),
        }
    }

    fn deadline_after(&mut self, duration: Duration) -> Result<Instant, SessionError> {
        Instant::now()
            .checked_add(duration)
            .ok_or_else(|| self.timeout())
    }

    fn send_request(
        &mut self,
        method: &str,
        params: &str,
        deadline: Instant,
    ) -> Result<String, SessionError> {
        let id = self.next_id;
        let request = format!(
            "{{\"jsonrpc\":\"2.0\",\"id\":{id},\"method\":{},\"params\":{params}}}",
            json_string(method)
        );
        self.write_control_line(&request, deadline)?;
        self.next_id += 1;
        Ok(id.to_string())
    }

    fn send_notification(&mut self, method: &str, deadline: Instant) -> Result<(), SessionError> {
        let notification = format!("{{\"jsonrpc\":\"2.0\",\"method\":{}}}", json_string(method));
        self.write_control_line(&notification, deadline)
    }

    fn write_control_line(&mut self, line: &str, deadline: Instant) -> Result<(), SessionError> {
        if line.len() > MAX_LINE_BYTES {
            return Err(SessionError::Unsupported(OUTBOUND_CONTROL_LINE_TOO_LARGE));
        }
        let remaining = self.remaining(deadline)?;
        let complete = self
            .transport
            .write_line(line.to_owned())
            .map_err(|_| SessionError::Transport)?;
        match complete.recv_timeout(remaining) {
            Ok(Ok(())) => {
                self.remaining(deadline)?;
                Ok(())
            }
            Ok(Err(_)) | Err(RecvTimeoutError::Disconnected) => Err(SessionError::Transport),
            Err(RecvTimeoutError::Timeout) => {
                self.transport.abort_write();
                Err(self.timeout())
            }
        }
    }

    fn await_response(&mut self, id: &str, deadline: Instant) -> Result<(), SessionError> {
        loop {
            self.ensure_live()?;
            match self.next_response_or_event(id, deadline)? {
                Some(true) => return Ok(()),
                Some(false) => return Err(SessionError::Unsupported("provider error response")),
                None => {}
            }
        }
    }

    fn await_result_thread_id(
        &mut self,
        id: &str,
        deadline: Instant,
    ) -> Result<String, SessionError> {
        self.await_result_field(id, deadline, ResultField::ThreadId)
    }

    fn await_result_turn_id(
        &mut self,
        id: &str,
        deadline: Instant,
    ) -> Result<String, SessionError> {
        self.await_result_field(id, deadline, ResultField::TurnId)
    }

    fn await_result_field(
        &mut self,
        id: &str,
        deadline: Instant,
        field: ResultField,
    ) -> Result<String, SessionError> {
        loop {
            self.ensure_live()?;
            let remaining = self.remaining(deadline)?;
            match self.transport.items().recv_timeout(remaining) {
                Ok(TransportItem::Line(Ok(frame))) if is_response_for(&frame, id) => {
                    if !response_ok(&frame) {
                        return Err(SessionError::Unsupported("provider error response"));
                    }
                    return frame
                        .result_field(field)
                        .ok_or(SessionError::Unsupported("missing id field in result"));
                }
                Ok(item) => {
                    if let Some(error) = self.absorb(item) {
                        return Err(error);
                    }
                }
                Err(RecvTimeoutError::Timeout) => return Err(self.timeout()),
                Err(RecvTimeoutError::Disconnected) => return Err(self.process_terminated()),
            }
        }
    }

    fn next_response_or_event(
        &mut self,
        id: &str,
        deadline: Instant,
    ) -> Result<Option<bool>, SessionError> {
        let remaining = self.remaining(deadline)?;
        match self.transport.items().recv_timeout(remaining) {
            Ok(TransportItem::Line(Ok(frame))) if is_response_for(&frame, id) => {
                Ok(Some(response_ok(&frame)))
            }
            Ok(item) => match self.absorb(item) {
                Some(error) => Err(error),
                None => Ok(None),
            },
            Err(RecvTimeoutError::Timeout) => Err(self.timeout()),
            Err(RecvTimeoutError::Disconnected) => Err(self.process_terminated()),
        }
    }

    fn remaining(&mut self, deadline: Instant) -> Result<Duration, SessionError> {
        deadline
            .checked_duration_since(Instant::now())
            .ok_or_else(|| self.timeout())
    }

    fn timeout(&mut self) -> SessionError {
        self.status = SessionStatus::Failed(FailureKind::Timeout);
        SessionError::Timeout
    }

    fn process_terminated(&mut self) -> SessionError {
        if !matches!(
            self.status,
            SessionStatus::Failed(FailureKind::ProcessTerminated)
        ) {
            let mut event = SessionEvent::new(
                Sequence(self.next_seq),
                EventKind::Diagnostic,
                "provider.disconnected",
                "Provider process disconnected.",
            );
            event.rich.signal = Some(ChatSignal::Disconnected);
            self.next_seq += 1;
            if self.queue.len() >= EVENT_QUEUE_CAP {
                self.queue.pop_front();
                self.signals.dropped += 1;
                self.signals.backpressured = true;
                event.rich.signal = Some(ChatSignal::QueuePressure);
            }
            self.queue.push_back(event);
        }
        self.status = SessionStatus::Failed(FailureKind::ProcessTerminated);
        SessionError::Terminal(FailureKind::ProcessTerminated)
    }

    fn absorb(&mut self, item: TransportItem) -> Option<SessionError> {
        if self.status.is_terminal() {
            return self.ensure_live().err();
        }
        match item {
            TransportItem::Exit => Some(self.process_terminated()),
            TransportItem::Line(Err(ScanError::OverLimit { .. })) => {
                self.signals.over_limit += 1;
                self.record_degraded(DegradedReason::OverLimitFrame)
            }
            TransportItem::Line(Err(ScanError::Malformed)) => {
                self.signals.malformed += 1;
                self.record_degraded(DegradedReason::MalformedFrame)
            }
            TransportItem::Line(Err(ScanError::Empty)) => None,
            TransportItem::Line(Ok(frame)) => {
                if matches!(frame.class, FrameClass::ServerRequest)
                    && let (Some(id), Some(kind)) = (
                        frame.id.as_deref(),
                        frame.method.as_deref().and_then(approval_kind_for_method),
                    )
                {
                    if !frame.has_params {
                        self.enqueue_event(
                            EventKind::Diagnostic,
                            DegradedReason::UnsupportedApproval.code(),
                            &frame,
                        );
                        return self.record_degraded(DegradedReason::UnsupportedApproval);
                    }
                    self.enqueue_approval(
                        ApprovalRequest {
                            id: ApprovalId::new(id),
                            kind,
                        },
                        &frame,
                    );
                    return None;
                }
                match map_frame(&frame) {
                    Mapped::Event { kind, label } => {
                        self.enqueue_event(kind, label, &frame);
                        if label == "turn.completed" {
                            return self.record_turn_completed(frame.event_turn_id.as_deref());
                        }
                    }
                    Mapped::Response { .. } => {}
                    Mapped::Degraded(reason) => {
                        if reason == DegradedReason::UnsupportedEvent {
                            self.signals.unsupported += 1;
                        }
                        let kind = if reason == DegradedReason::UnsupportedApproval {
                            EventKind::Diagnostic
                        } else {
                            EventKind::Unsupported
                        };
                        self.enqueue_event(kind, reason.code(), &frame);
                        return self.record_degraded(reason);
                    }
                }
                None
            }
        }
    }

    fn record_turn_completed(&mut self, turn_id: Option<&str>) -> Option<SessionError> {
        let Some(turn_id) = turn_id else {
            return self.record_degraded(DegradedReason::UnsupportedEvent);
        };
        if self.active_turn.as_deref() == Some(turn_id) {
            self.active_turn = None;
            if !self.status.is_terminal() {
                self.status = SessionStatus::Idle;
            }
            return None;
        }
        if self.completed_turns.len() >= EVENT_QUEUE_CAP {
            self.completed_turns.pop_front();
            self.signals.dropped += 1;
            self.signals.backpressured = true;
            if self.signals.dropped > DROP_TOLERANCE {
                self.status = SessionStatus::Failed(FailureKind::QueueOverflow);
                return Some(SessionError::Terminal(FailureKind::QueueOverflow));
            }
            if let Some(error) = self.record_degraded(DegradedReason::Backpressure) {
                return Some(error);
            }
        }
        self.completed_turns.push_back(turn_id.to_owned());
        None
    }

    fn take_completed_turn(&mut self, turn_id: &str) -> bool {
        self.completed_turns
            .iter()
            .position(|completed| completed == turn_id)
            .and_then(|index| self.completed_turns.remove(index))
            .is_some()
    }

    fn enqueue_event(&mut self, kind: EventKind, label: &str, frame: &Frame) {
        let mut event = SessionEvent::new(
            Sequence(self.next_seq),
            kind,
            label.to_owned(),
            frame.preview.clone(),
        );
        event.rich = codex_rich_event(self.next_seq, kind, label, frame);
        self.next_seq += 1;
        if self.queue.len() >= EVENT_QUEUE_CAP {
            self.queue.pop_front();
            self.signals.dropped += 1;
            self.signals.backpressured = true;
            event.rich.signal = Some(ChatSignal::QueuePressure);
            if self.signals.dropped > DROP_TOLERANCE {
                self.status = SessionStatus::Failed(FailureKind::QueueOverflow);
            } else {
                self.record_degraded(DegradedReason::Backpressure);
            }
        } else if self.queue.len() + 1 < EVENT_QUEUE_CAP {
            self.signals.backpressured = false;
        }
        self.queue.push_back(event);
    }

    fn enqueue_approval(&mut self, approval: ApprovalRequest, frame: &Frame) {
        if self.approvals.len() >= EVENT_QUEUE_CAP {
            self.status = SessionStatus::Failed(FailureKind::QueueOverflow);
            self.signals.dropped += 1;
            self.signals.backpressured = true;
            return;
        }
        self.approvals.push_back(approval);
        self.enqueue_event(EventKind::ApprovalRequest, "approval.request", frame);
    }

    fn record_degraded(&mut self, reason: DegradedReason) -> Option<SessionError> {
        self.degraded_count += 1;
        if self.degraded_count > DEGRADED_TOLERANCE {
            self.status = SessionStatus::Failed(FailureKind::ProtocolViolation);
            Some(SessionError::Terminal(FailureKind::ProtocolViolation))
        } else if !self.status.is_terminal() {
            self.status = SessionStatus::Degraded(reason);
            None
        } else {
            None
        }
    }
}

fn codex_rich_event(sequence: u64, kind: EventKind, label: &str, frame: &Frame) -> RichChatEvent {
    if let Some(text) = frame.display_text.as_deref() {
        return RichChatEvent::new(
            sequence,
            ChatRole::Assistant,
            ChatCategory::Message,
            "assistant.message",
            text,
            None,
        );
    }
    let (category, text, signal) = match kind {
        EventKind::Diagnostic | EventKind::Unsupported => (
            ChatCategory::Error,
            format!("Provider reported {}.", label.replace('_', " ")),
            Some(ChatSignal::Degraded),
        ),
        EventKind::ApprovalRequest => (
            ChatCategory::Status,
            "Provider requested approval.".to_owned(),
            None,
        ),
        EventKind::Lifecycle | EventKind::Progress => (
            ChatCategory::Status,
            format!("{}.", label.replace(['.', '_'], " ")),
            None,
        ),
    };
    RichChatEvent::new(sequence, ChatRole::System, category, label, text, signal)
}

fn is_response_for(frame: &Frame, id: &str) -> bool {
    frame.method.is_none() && frame.id.as_deref() == Some(id)
}

fn response_ok(frame: &Frame) -> bool {
    matches!(frame.class, FrameClass::Response { ok: true })
}

/// Escape and quote a string as JSON without retaining a raw provider payload.
pub fn json_string(value: &str) -> String {
    let mut output = String::with_capacity(value.len() + 2);
    append_json_string(value, &mut output);
    output
}

/// Escape and quote a JSON string only when its encoded value is safe to place
/// on a bounded control line. This stops oversized prompt/session input before
/// cloning it into an outbound payload.
fn json_string_bounded(value: &str) -> Result<String, SessionError> {
    let capacity = escaped_json_string_len(value, MAX_LINE_BYTES)
        .ok_or(SessionError::Unsupported(OUTBOUND_CONTROL_LINE_TOO_LARGE))?;
    let mut output = String::with_capacity(capacity);
    append_json_string(value, &mut output);
    Ok(output)
}

fn escaped_json_string_len(value: &str, limit: usize) -> Option<usize> {
    let mut length: usize = 2;
    for character in value.chars() {
        let encoded = match character {
            '"' | '\\' | '\n' | '\r' | '\t' => 2,
            control if (control as u32) < 0x20 => 6,
            character => character.len_utf8(),
        };
        length = length.checked_add(encoded)?;
        if length > limit {
            return None;
        }
    }
    Some(length)
}

fn append_json_string(value: &str, output: &mut String) {
    output.push('"');
    for character in value.chars() {
        match character {
            '"' => output.push_str("\\\""),
            '\\' => output.push_str("\\\\"),
            '\n' => output.push_str("\\n"),
            '\r' => output.push_str("\\r"),
            '\t' => output.push_str("\\t"),
            control if (control as u32) < 0x20 => {
                output.push_str(&format!("\\u{:04x}", control as u32))
            }
            character => output.push(character),
        }
    }
    output.push('"');
}

const INITIALIZE_PARAMS: &str = "{\"clientInfo\":{\"name\":\"relay-node\",\"version\":\"0.1.0\"}}";

#[cfg(test)]
mod tests {
    use super::*;

    fn response(id: u64, body: &str) -> String {
        format!("{{\"jsonrpc\":\"2.0\",\"id\":{id},\"result\":{body}}}")
    }

    struct StalledWriteTransport {
        rx: Receiver<TransportItem>,
        pending: Vec<SyncSender<io::Result<()>>>,
        aborted: Arc<AtomicBool>,
    }

    impl StalledWriteTransport {
        fn new() -> (Self, Arc<AtomicBool>) {
            let (_tx, rx) = mpsc::channel();
            let aborted = Arc::new(AtomicBool::new(false));
            (
                Self {
                    rx,
                    pending: Vec::new(),
                    aborted: Arc::clone(&aborted),
                },
                aborted,
            )
        }
    }

    impl Transport for StalledWriteTransport {
        fn write_line(&mut self, _line: String) -> io::Result<Receiver<io::Result<()>>> {
            let (complete_tx, complete_rx) = mpsc::sync_channel(1);
            self.pending.push(complete_tx);
            Ok(complete_rx)
        }

        fn abort_write(&mut self) {
            self.aborted.store(true, Ordering::Release);
            self.pending.clear();
        }

        fn items(&self) -> &Receiver<TransportItem> {
            &self.rx
        }

        fn shutdown(&mut self) {}
    }

    #[test]
    fn create_preserves_handshake_order() {
        let lines = vec![
            response(1, "{}"),
            response(2, "{\"thread\":{\"id\":\"thread-1\"}}"),
        ];
        let mut supervisor = Supervisor::new(ScriptedTransport::from_lines(lines));
        assert_eq!(
            supervisor.create(DEFAULT_DEADLINE).unwrap().as_str(),
            "thread-1"
        );
        let writes = supervisor.transport().writes();
        assert!(writes[0].contains("\"method\":\"initialize\""));
        assert!(writes[1].contains("\"method\":\"initialized\""));
        assert!(writes[2].contains("\"method\":\"thread/start\""));
    }

    #[test]
    fn prompt_write_deadline_interrupts_a_stalled_transport() {
        let (transport, aborted) = StalledWriteTransport::new();
        let mut supervisor = Supervisor::new(transport);
        supervisor.session = Some(SessionId::new("thread-1"));

        let started = Instant::now();
        assert_eq!(
            supervisor.prompt("hello", Duration::from_millis(10)),
            Err(SessionError::Timeout)
        );
        assert!(started.elapsed() < Duration::from_millis(100));
        assert!(aborted.load(Ordering::Acquire));
        assert_eq!(
            supervisor.status(),
            &SessionStatus::Failed(FailureKind::Timeout)
        );
    }

    #[test]
    fn oversized_prompt_is_rejected_before_transport_submission() {
        let mut supervisor = Supervisor::new(ScriptedTransport::from_items(vec![]));
        supervisor.session = Some(SessionId::new("thread-1"));

        assert_eq!(
            supervisor.prompt(&"x".repeat(MAX_LINE_BYTES - 2), DEFAULT_DEADLINE),
            Err(SessionError::Unsupported(OUTBOUND_CONTROL_LINE_TOO_LARGE))
        );
        assert!(supervisor.transport().writes().is_empty());
    }

    #[test]
    fn overflowing_deadline_fails_typed_before_transport_submission() {
        let mut supervisor = Supervisor::new(ScriptedTransport::from_items(vec![]));

        assert_eq!(supervisor.create(Duration::MAX), Err(SessionError::Timeout));
        assert_eq!(
            supervisor.status(),
            &SessionStatus::Failed(FailureKind::Timeout)
        );
        assert!(supervisor.transport().writes().is_empty());
    }

    #[test]
    fn resume_in_cwd_sends_the_approved_cwd_override() {
        let lines = vec![
            response(1, "{}"),
            response(2, "{\"thread\":{\"id\":\"requested\"}}"),
        ];
        let mut supervisor = Supervisor::new(ScriptedTransport::from_lines(lines));

        assert_eq!(
            supervisor.resume_in_cwd("requested", "/approved/workspace", DEFAULT_DEADLINE),
            Ok(SessionId::new("requested"))
        );
        assert!(supervisor.transport().writes()[2].contains("\"cwd\":\"/approved/workspace\""));
    }

    #[test]
    fn resume_requires_provider_to_confirm_same_thread() {
        let lines = vec![
            response(1, "{}"),
            response(2, "{\"thread\":{\"id\":\"other\"}}"),
        ];
        let mut supervisor = Supervisor::new(ScriptedTransport::from_lines(lines));
        assert_eq!(
            supervisor.resume("requested", DEFAULT_DEADLINE),
            Err(SessionError::Terminal(FailureKind::ProtocolViolation))
        );
    }

    #[test]
    fn events_preserve_arrival_order() {
        let lines = vec![
            "{\"method\":\"thread/started\",\"params\":{}}",
            "{\"method\":\"item/started\",\"params\":{}}",
            "{\"method\":\"item/completed\",\"params\":{}}",
        ];
        let mut supervisor = Supervisor::new(ScriptedTransport::from_lines(lines));
        supervisor.pump();
        let sequence: Vec<_> =
            std::iter::from_fn(|| supervisor.next_event().map(|event| event.seq.0)).collect();
        assert_eq!(sequence, vec![0, 1, 2, 3]);
    }

    #[test]
    fn known_agent_message_surfaces_typed_safe_assistant_text() {
        let line = r#"{"method":"item/completed","params":{"item":{"type":"agentMessage","text":"answer Bearer private-token"}}}"#;
        let mut supervisor = Supervisor::new(ScriptedTransport::from_lines([line]));
        supervisor.pump();
        let event = supervisor.next_event().unwrap();
        assert_eq!(event.rich.role, ChatRole::Assistant);
        assert_eq!(event.rich.category, ChatCategory::Message);
        assert_eq!(event.rich.text, "answer Bearer [redacted]");
        assert!(!event.rich.text.contains("private-token"));
    }

    #[test]
    fn malformed_over_limit_and_unknown_frames_degrade() {
        let oversized = vec![b'x'; MAX_LINE_BYTES + 1];
        let items = vec![
            TransportItem::Line(scan_line(b"not-json")),
            TransportItem::Line(scan_line(&oversized)),
            TransportItem::Line(scan_line(b"{\"method\":\"unknown/event\",\"params\":{}}")),
        ];
        let mut supervisor = Supervisor::new(ScriptedTransport::from_items(items));
        supervisor.pump();
        assert_eq!(supervisor.signals().malformed, 1);
        assert_eq!(supervisor.signals().over_limit, 1);
        assert_eq!(supervisor.signals().unsupported, 1);
    }

    #[test]
    fn degraded_frames_past_tolerance_abort_active_await_without_later_idle() {
        let mut items: Vec<_> = (0..=DEGRADED_TOLERANCE)
            .map(|_| TransportItem::Line(Err(ScanError::Malformed)))
            .collect();
        items.push(TransportItem::Line(scan_line(response(1, "{}").as_bytes())));
        items.push(TransportItem::Line(scan_line(
            response(2, "{\"thread\":{\"id\":\"thread-1\"}}").as_bytes(),
        )));
        let mut supervisor = Supervisor::new(ScriptedTransport::from_items(items));

        assert_eq!(
            supervisor.create(DEFAULT_DEADLINE),
            Err(SessionError::Terminal(FailureKind::ProtocolViolation))
        );
        assert_eq!(
            supervisor.status(),
            &SessionStatus::Failed(FailureKind::ProtocolViolation)
        );
    }

    #[test]
    fn terminal_protocol_violation_survives_followup_transport_exit() {
        let mut items: Vec<_> = (0..=DEGRADED_TOLERANCE)
            .map(|_| TransportItem::Line(Err(ScanError::Malformed)))
            .collect();
        items.push(TransportItem::Exit);
        let mut supervisor = Supervisor::new(ScriptedTransport::from_items(items));

        supervisor.pump();

        assert_eq!(
            supervisor.status(),
            &SessionStatus::Failed(FailureKind::ProtocolViolation)
        );
    }

    #[test]
    fn output_flood_sheds_oldest_and_signals_backpressure() {
        let items = (0..EVENT_QUEUE_CAP + 10).map(|_| {
            TransportItem::Line(Ok(scan_line(
                b"{\"method\":\"thread/started\",\"params\":{}}",
            )
            .unwrap()))
        });
        let mut supervisor = Supervisor::new(ScriptedTransport::from_items(items));
        supervisor.pump();
        assert_eq!(supervisor.queued(), EVENT_QUEUE_CAP);
        assert!(supervisor.signals().dropped >= 10);
        assert!(supervisor.signals().backpressured);
    }

    #[test]
    fn documented_approval_requires_explicit_one_shot_response() {
        let request = b"{\"jsonrpc\":\"2.0\",\"id\":9,\"method\":\"item/fileChange/requestApproval\",\"params\":{}}";
        let mut supervisor =
            Supervisor::new(ScriptedTransport::from_items(vec![TransportItem::Line(
                scan_line(request),
            )]));
        supervisor.pump();
        let approval = supervisor.next_approval().unwrap();
        supervisor
            .respond_to_approval(&approval, ApprovalDecision::Decline)
            .unwrap();
        assert!(supervisor.transport().writes()[0].contains("\"decision\":\"decline\""));
        assert!(supervisor.next_approval().is_none());
    }

    #[test]
    fn approval_without_params_is_rejected_before_approval_handling() {
        let request =
            b"{\"jsonrpc\":\"2.0\",\"id\":9,\"method\":\"item/fileChange/requestApproval\"}";
        let mut supervisor =
            Supervisor::new(ScriptedTransport::from_items(vec![TransportItem::Line(
                scan_line(request),
            )]));

        supervisor.pump();

        assert!(supervisor.next_approval().is_none());
        let event = supervisor.next_event().unwrap();
        assert_eq!(event.kind, EventKind::Diagnostic);
        assert_eq!(event.label, DegradedReason::UnsupportedApproval.code());
    }

    #[test]
    fn unsupported_server_request_is_diagnostic_not_auto_approved() {
        let request = b"{\"jsonrpc\":\"2.0\",\"id\":9,\"method\":\"item/permissions/requestApproval\",\"params\":{}}";
        let mut supervisor =
            Supervisor::new(ScriptedTransport::from_items(vec![TransportItem::Line(
                scan_line(request),
            )]));
        supervisor.pump();
        let event = supervisor.next_event().unwrap();
        assert_eq!(event.kind, EventKind::Diagnostic);
        assert_eq!(event.label, DegradedReason::UnsupportedApproval.code());
        assert!(supervisor.next_approval().is_none());
    }

    #[test]
    fn completion_before_turn_start_response_is_not_cancellable() {
        let completion = "{\"jsonrpc\":\"2.0\",\"method\":\"turn/completed\",\"params\":{\"turn\":{\"id\":\"turn-1\"}}}";
        let start_response = response(1, "{\"turn\":{\"id\":\"turn-1\"}}");
        let mut supervisor = Supervisor::new(ScriptedTransport::from_lines([
            completion,
            start_response.as_str(),
        ]));
        supervisor.session = Some(SessionId::new("thread-1"));

        assert_eq!(
            supervisor.prompt("hello", DEFAULT_DEADLINE).unwrap(),
            "turn-1"
        );
        assert_eq!(supervisor.status(), &SessionStatus::Idle);
        assert_eq!(
            supervisor.cancel("turn-1", DEFAULT_DEADLINE),
            Err(SessionError::Raced(DegradedReason::CancellationRace))
        );
    }

    #[test]
    fn exit_timeout_write_failure_and_unavailable_executable_are_typed() {
        let mut exited = Supervisor::new(ScriptedTransport::from_items(vec![TransportItem::Exit]));
        assert_eq!(
            exited.create(DEFAULT_DEADLINE),
            Err(SessionError::Terminal(FailureKind::ProcessTerminated))
        );
        let disconnected = exited.next_event().expect("disconnect event");
        assert_eq!(disconnected.rich.signal, Some(ChatSignal::Disconnected));
        assert_eq!(disconnected.rich.text, "Provider process disconnected.");

        let (sender, receiver) = mpsc::channel();
        let transport = ScriptedTransport {
            rx: receiver,
            writes: Vec::new(),
            write_fails: false,
        };
        let mut timed_out = Supervisor::new(transport);
        assert_eq!(
            timed_out.create(Duration::from_millis(5)),
            Err(SessionError::Timeout)
        );
        assert_eq!(
            timed_out.status(),
            &SessionStatus::Failed(FailureKind::Timeout)
        );
        drop(sender);

        let mut write_failure =
            Supervisor::new(ScriptedTransport::from_items(vec![]).with_write_failure());
        assert_eq!(
            write_failure.create(DEFAULT_DEADLINE),
            Err(SessionError::Transport)
        );
        assert!(matches!(
            ProcessTransport::spawn_program("relay-missing-codex", None),
            Err(SessionError::Unavailable)
        ));
    }

    #[test]
    fn cancel_preserves_provider_error_without_matching_completion() {
        let start = response(3, "{\"turn\":{\"id\":\"turn-1\"}}");
        let interrupt_error = "{\"jsonrpc\":\"2.0\",\"id\":4,\"error\":{\"code\":-32600}}";
        let mut supervisor = Supervisor::new(ScriptedTransport::from_lines([
            start.as_str(),
            interrupt_error,
        ]));
        supervisor.session = Some(SessionId::new("thread-1"));
        supervisor.next_id = 3;

        assert_eq!(
            supervisor.prompt("hello", DEFAULT_DEADLINE).unwrap(),
            "turn-1"
        );
        assert_eq!(
            supervisor.cancel("turn-1", DEFAULT_DEADLINE),
            Err(SessionError::Unsupported("provider error response"))
        );
        assert_eq!(supervisor.active_turn.as_deref(), Some("turn-1"));
        assert_eq!(supervisor.status(), &SessionStatus::Working);
    }

    #[test]
    fn cancel_after_matching_completion_error_is_a_typed_race() {
        let start = response(3, "{\"turn\":{\"id\":\"turn-1\"}}");
        let completion = "{\"jsonrpc\":\"2.0\",\"method\":\"turn/completed\",\"params\":{\"turn\":{\"id\":\"turn-1\"}}}";
        let interrupt_error = "{\"jsonrpc\":\"2.0\",\"id\":4,\"error\":{\"code\":-32600}}";
        let mut supervisor = Supervisor::new(ScriptedTransport::from_lines([
            start.as_str(),
            completion,
            interrupt_error,
        ]));
        supervisor.session = Some(SessionId::new("thread-1"));
        supervisor.next_id = 3;

        assert_eq!(
            supervisor.prompt("hello", DEFAULT_DEADLINE).unwrap(),
            "turn-1"
        );
        assert_eq!(
            supervisor.cancel("turn-1", DEFAULT_DEADLINE),
            Err(SessionError::Raced(DegradedReason::CancellationRace))
        );
        assert!(supervisor.active_turn.is_none());
        assert_eq!(
            supervisor.status(),
            &SessionStatus::Degraded(DegradedReason::CancellationRace)
        );
    }
}
