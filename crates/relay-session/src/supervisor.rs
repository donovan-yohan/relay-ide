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
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, SyncSender, TrySendError};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use crate::codex::{Mapped, approval_kind_for_method, codex_command_args, map_frame};
use crate::contract::{
    ApprovalDecision, ApprovalId, ApprovalRequest, DegradedReason, EventKind, FailureKind,
    Sequence, SessionError, SessionEvent, SessionId, SessionStatus, StreamSignals,
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

/// One arrival-ordered transport item.
#[derive(Debug)]
pub enum TransportItem {
    Line(Result<Frame, ScanError>),
    Exit,
}

/// A writable JSONL transport with owned lifecycle control.
pub trait Transport: Send {
    fn write_line(&mut self, line: &str) -> io::Result<()>;
    fn items(&self) -> &Receiver<TransportItem>;
    fn shutdown(&mut self);
}

/// The real, fixed-command local process transport.
pub struct ProcessTransport {
    child: Option<Child>,
    stdin: Option<ChildStdin>,
    rx: Receiver<TransportItem>,
    reader: Option<JoinHandle<()>>,
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
        let stopping = Arc::new(AtomicBool::new(false));
        let reader_stopping = Arc::clone(&stopping);
        let reader = thread::Builder::new()
            .name("relay-codex-reader".into())
            .spawn(move || reader_loop(stdout, tx, reader_stopping))
            .map_err(|_| SessionError::Transport)?;
        Ok(Self {
            child: Some(child),
            stdin: Some(stdin),
            rx,
            reader: Some(reader),
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
    fn write_line(&mut self, line: &str) -> io::Result<()> {
        let stdin = self
            .stdin
            .as_mut()
            .ok_or_else(|| io::Error::new(io::ErrorKind::BrokenPipe, "stdin closed"))?;
        stdin.write_all(line.as_bytes())?;
        stdin.write_all(b"\n")?;
        stdin.flush()
    }

    fn items(&self) -> &Receiver<TransportItem> {
        &self.rx
    }

    fn shutdown(&mut self) {
        self.stopping.store(true, Ordering::Release);
        self.stdin.take();
        if let Some(mut child) = self.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
        if let Some(reader) = self.reader.take() {
            let _ = reader.join();
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
    fn write_line(&mut self, line: &str) -> io::Result<()> {
        if self.write_fails {
            return Err(io::Error::new(
                io::ErrorKind::BrokenPipe,
                "scripted write failure",
            ));
        }
        self.writes.push(line.to_owned());
        Ok(())
    }

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
        self.transport
            .write_line(&response)
            .map_err(|_| SessionError::Transport)?;
        self.approvals.remove(index);
        Ok(())
    }

    pub fn create(&mut self, deadline: Duration) -> Result<SessionId, SessionError> {
        self.ensure_live()?;
        let overall = Instant::now() + deadline;
        let initialize = self.send_request("initialize", INITIALIZE_PARAMS)?;
        self.await_response(&initialize, overall)?;
        self.send_notification("initialized")?;
        let start = self.send_request("thread/start", "{}")?;
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
        self.ensure_live()?;
        let overall = Instant::now() + deadline;
        let initialize = self.send_request("initialize", INITIALIZE_PARAMS)?;
        self.await_response(&initialize, overall)?;
        self.send_notification("initialized")?;
        let params = format!("{{\"threadId\":{}}}", json_string(thread_id));
        let resume = self.send_request("thread/resume", &params)?;
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
        let session = self
            .session
            .clone()
            .ok_or(SessionError::Unsupported("no active session"))?;
        let params = format!(
            "{{\"threadId\":{},\"input\":[{{\"type\":\"text\",\"text\":{}}}]}}",
            json_string(session.as_str()),
            json_string(text)
        );
        let turn = self.send_request("turn/start", &params)?;
        let turn_id = self.await_result_turn_id(&turn, Instant::now() + deadline)?;
        self.active_turn = Some(turn_id.clone());
        self.status = SessionStatus::Working;
        Ok(turn_id)
    }

    pub fn cancel(&mut self, turn_id: &str, deadline: Duration) -> Result<(), SessionError> {
        self.ensure_live()?;
        let session = self
            .session
            .clone()
            .ok_or(SessionError::Unsupported("no active session"))?;
        if self.active_turn.as_deref() != Some(turn_id) {
            self.record_degraded(DegradedReason::CancellationRace);
            return Err(SessionError::Raced(DegradedReason::CancellationRace));
        }
        let params = format!(
            "{{\"threadId\":{},\"turnId\":{}}}",
            json_string(session.as_str()),
            json_string(turn_id)
        );
        let interrupt = self.send_request("turn/interrupt", &params)?;
        match self.await_response(&interrupt, Instant::now() + deadline) {
            Ok(()) => {
                self.active_turn = None;
                self.status = SessionStatus::Idle;
                Ok(())
            }
            // The real app-server rejects an interrupt that loses to terminal
            // completion. This is observable as a provider error response, not
            // a reason to fabricate successful cancellation.
            Err(SessionError::Unsupported(_)) => {
                self.active_turn = None;
                self.record_degraded(DegradedReason::CancellationRace);
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

    fn send_request(&mut self, method: &str, params: &str) -> Result<String, SessionError> {
        let id = self.next_id;
        self.next_id += 1;
        let request = format!(
            "{{\"jsonrpc\":\"2.0\",\"id\":{id},\"method\":{},\"params\":{params}}}",
            json_string(method)
        );
        self.transport
            .write_line(&request)
            .map_err(|_| SessionError::Transport)?;
        Ok(id.to_string())
    }

    fn send_notification(&mut self, method: &str) -> Result<(), SessionError> {
        let notification = format!("{{\"jsonrpc\":\"2.0\",\"method\":{}}}", json_string(method));
        self.transport
            .write_line(&notification)
            .map_err(|_| SessionError::Transport)
    }

    fn await_response(&mut self, id: &str, deadline: Instant) -> Result<(), SessionError> {
        loop {
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
        self.status = SessionStatus::Failed(FailureKind::ProcessTerminated);
        SessionError::Terminal(FailureKind::ProcessTerminated)
    }

    fn absorb(&mut self, item: TransportItem) -> Option<SessionError> {
        match item {
            TransportItem::Exit => Some(self.process_terminated()),
            TransportItem::Line(Err(ScanError::OverLimit { .. })) => {
                self.signals.over_limit += 1;
                self.record_degraded(DegradedReason::OverLimitFrame);
                None
            }
            TransportItem::Line(Err(ScanError::Malformed)) => {
                self.signals.malformed += 1;
                self.record_degraded(DegradedReason::MalformedFrame);
                None
            }
            TransportItem::Line(Err(ScanError::Empty)) => None,
            TransportItem::Line(Ok(frame)) => {
                if matches!(frame.class, FrameClass::ServerRequest)
                    && let (Some(id), Some(kind)) = (
                        frame.id.as_deref(),
                        frame.method.as_deref().and_then(approval_kind_for_method),
                    )
                {
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
                            self.active_turn = None;
                            if !self.status.is_terminal() {
                                self.status = SessionStatus::Idle;
                            }
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
                        self.record_degraded(reason);
                    }
                }
                None
            }
        }
    }

    fn enqueue_event(&mut self, kind: EventKind, label: &str, frame: &Frame) {
        let event = SessionEvent::new(
            Sequence(self.next_seq),
            kind,
            label.to_owned(),
            frame.preview.clone(),
        );
        self.next_seq += 1;
        if self.queue.len() >= EVENT_QUEUE_CAP {
            self.queue.pop_front();
            self.signals.dropped += 1;
            self.signals.backpressured = true;
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

    fn record_degraded(&mut self, reason: DegradedReason) {
        self.degraded_count += 1;
        if self.degraded_count > DEGRADED_TOLERANCE {
            self.status = SessionStatus::Failed(FailureKind::ProtocolViolation);
        } else if !self.status.is_terminal() {
            self.status = SessionStatus::Degraded(reason);
        }
    }
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
    output
}

const INITIALIZE_PARAMS: &str = "{\"clientInfo\":{\"name\":\"relay-node\",\"version\":\"0.1.0\"}}";

#[cfg(test)]
mod tests {
    use super::*;

    fn response(id: u64, body: &str) -> String {
        format!("{{\"jsonrpc\":\"2.0\",\"id\":{id},\"result\":{body}}}")
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
        assert_eq!(sequence, vec![0, 1, 2]);
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
    fn unsupported_server_request_is_diagnostic_not_auto_approved() {
        let request = b"{\"id\":9,\"method\":\"item/permissions/requestApproval\",\"params\":{}}";
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
    fn exit_timeout_write_failure_and_unavailable_executable_are_typed() {
        let mut exited = Supervisor::new(ScriptedTransport::from_items(vec![TransportItem::Exit]));
        assert_eq!(
            exited.create(DEFAULT_DEADLINE),
            Err(SessionError::Terminal(FailureKind::ProcessTerminated))
        );

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
    fn cancellation_races_are_typed() {
        let mut inactive = Supervisor::new(ScriptedTransport::from_items(vec![]));
        inactive.session = Some(SessionId::new("thread"));
        assert_eq!(
            inactive.cancel("turn", DEFAULT_DEADLINE),
            Err(SessionError::Raced(DegradedReason::CancellationRace))
        );

        let error = b"{\"jsonrpc\":\"2.0\",\"id\":1,\"error\":{\"code\":-32600}}";
        let mut rejected =
            Supervisor::new(ScriptedTransport::from_items(vec![TransportItem::Line(
                scan_line(error),
            )]));
        rejected.session = Some(SessionId::new("thread"));
        rejected.active_turn = Some("turn".into());
        assert_eq!(
            rejected.cancel("turn", DEFAULT_DEADLINE),
            Err(SessionError::Raced(DegradedReason::CancellationRace))
        );
    }
}
