//! Native, loopback-only Hermes rich-client Session adapter.
//!
//! This crate speaks the authenticated dashboard `/api/ws` TUI JSON-RPC
//! protocol. It deliberately rejects the OpenAI-compatible API gateway and all
//! remote endpoints: Relay's first Hermes integration is one-node only.

use std::{
    collections::{HashSet, VecDeque},
    fmt,
    io::{self, Read, Write},
    net::{TcpStream, ToSocketAddrs},
    thread,
    time::Duration,
};

use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use sha1::{Digest, Sha1};

pub const DEFAULT_EVENT_QUEUE_LIMIT: usize = 128;
pub const DEFAULT_REPLAY_WINDOW: usize = 64;
pub const MAX_RPC_BYTES: usize = 8 * 1024;
pub const MAX_FRAME_BYTES: usize = 64 * 1024;
pub const MAX_CONNECT_ATTEMPTS: usize = 3;
const CONNECT_BACKOFFS: [Duration; MAX_CONNECT_ATTEMPTS - 1] =
    [Duration::from_millis(50), Duration::from_millis(100)];
pub const DEFAULT_RPC_TIMEOUT: Duration = Duration::from_secs(15);

/// A loopback dashboard URL with an already-present dashboard credential.
///
/// The actual credential remains in the request target and is never exposed by
/// `Display`, `Debug`, adapter events, or typed errors.
#[derive(Clone, PartialEq, Eq)]
pub struct GatewayEndpoint {
    host: String,
    port: u16,
    request_target: String,
}

impl GatewayEndpoint {
    pub fn parse(raw: &str) -> Result<Self, AdapterError> {
        if raw
            .bytes()
            .any(|byte| byte.is_ascii_control() || byte.is_ascii_whitespace())
        {
            return Err(AdapterError::UnsupportedEndpoint);
        }
        let rest = raw
            .strip_prefix("ws://")
            .ok_or(AdapterError::UnsupportedEndpoint)?;
        let (authority, target) = rest
            .split_once('/')
            .ok_or(AdapterError::UnsupportedEndpoint)?;
        if authority.contains('@') || target.is_empty() {
            return Err(AdapterError::UnsupportedEndpoint);
        }

        let (host, port) = parse_loopback_authority(authority)?;
        let request_target = format!("/{target}");
        let (path, query) = request_target
            .split_once('?')
            .unwrap_or((request_target.as_str(), ""));
        if path != "/api/ws" || !has_supported_credential(query) {
            return Err(AdapterError::UnsupportedEndpoint);
        }

        Ok(Self {
            host,
            port,
            request_target,
        })
    }

    pub fn redacted_url(&self) -> String {
        format!(
            "ws://{}:{}/api/ws?credential=redacted",
            self.host, self.port
        )
    }

    fn host_header(&self) -> String {
        if self.host.contains(':') {
            format!("[{}]:{}", self.host, self.port)
        } else {
            format!("{}:{}", self.host, self.port)
        }
    }
}

impl fmt::Debug for GatewayEndpoint {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("GatewayEndpoint")
            .field("url", &self.redacted_url())
            .finish()
    }
}

impl fmt::Display for GatewayEndpoint {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.redacted_url())
    }
}

fn parse_loopback_authority(authority: &str) -> Result<(String, u16), AdapterError> {
    let (host, port) = if let Some(rest) = authority.strip_prefix('[') {
        let (host, port) = rest
            .split_once("]:")
            .ok_or(AdapterError::UnsupportedEndpoint)?;
        (host, port)
    } else {
        authority
            .rsplit_once(':')
            .ok_or(AdapterError::UnsupportedEndpoint)?
    };
    let port = port
        .parse::<u16>()
        .ok()
        .filter(|port| *port != 0)
        .ok_or(AdapterError::UnsupportedEndpoint)?;
    let host = host.to_ascii_lowercase();
    if !matches!(host.as_str(), "127.0.0.1" | "localhost" | "::1") {
        return Err(AdapterError::UnsupportedEndpoint);
    }
    Ok((host, port))
}

fn has_supported_credential(query: &str) -> bool {
    let mut items = query.split('&');
    let Some((key, value)) = items.next().and_then(|item| item.split_once('=')) else {
        return false;
    };
    key == "token" && !value.is_empty() && items.next().is_none()
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AdapterError {
    UnsupportedEndpoint,
    AuthFailed,
    GatewayLost,
    MalformedRpc,
    Timeout,
    RetryExhausted,
    ReplayGap,
    QueuePressure,
    PayloadTooLarge,
    Unsupported,
    UnknownSession,
    Raced,
    RemoteFailure,
}

impl AdapterError {
    pub const fn code(&self) -> &'static str {
        match self {
            Self::UnsupportedEndpoint => "unsupported_endpoint",
            Self::AuthFailed => "auth_failed",
            Self::GatewayLost => "gateway_lost",
            Self::MalformedRpc => "malformed_rpc",
            Self::Timeout => "timeout",
            Self::RetryExhausted => "retry_exhausted",
            Self::ReplayGap => "replay_gap",
            Self::QueuePressure => "queue_pressure",
            Self::PayloadTooLarge => "payload_too_large",
            Self::Unsupported => "unsupported",
            Self::UnknownSession => "unknown_session",
            Self::Raced => "raced",
            Self::RemoteFailure => "remote_failure",
        }
    }
}

impl fmt::Display for AdapterError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.code())
    }
}

impl std::error::Error for AdapterError {}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionStatus {
    Idle,
    Working,
    Degraded,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EventKind {
    Lifecycle,
    Status,
    Tool,
    ClarificationRequest,
    ApprovalRequest,
    Diagnostic,
    Unsupported,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionEvent {
    pub sequence: u64,
    /// The live gateway session that emitted this event. `gateway.ready` has
    /// no session scope and uses an empty string.
    pub session_id: String,
    pub kind: EventKind,
    pub label: &'static str,
    pub preview: String,
    /// Opaque provider correlation for a clarification response. Present only
    /// when the gateway emitted one; no clarification payload is retained.
    pub clarification_id: Option<String>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct StreamSignals {
    pub dropped: u64,
    pub malformed: u64,
    pub unsupported: u64,
    pub foreign: u64,
    pub replay_gap: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CreatedSession {
    pub live_id: String,
    pub stored_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionSummary {
    pub stored_id: String,
}

/// The public ledger is intentionally narrow. Any event not in this set becomes
/// an `Unsupported` event; it is never guessed, normalized through another
/// provider, or silently dropped. A `clarify.request` needs an opaque response
/// id before it can join this supported set.
pub const GUARANTEED_EVENTS: &[&str] = &[
    "gateway.ready",
    "session.info",
    "message.start",
    "message.delta",
    "message.complete",
    "thinking.delta",
    "reasoning.delta",
    "reasoning.available",
    "status.update",
    "tool.start",
    "tool.progress",
    "tool.generating",
    "tool.complete",
    "tool.output_risk",
    "approval.request",
    "error",
];

pub const UNSUPPORTED_EVENTS: &[&str] = &[
    "sudo.request",
    "secret.request",
    "terminal.read.request",
    "background.complete",
    "skin.changed",
];

pub const UNSUPPORTED_METHODS: &[&str] = &[
    "config.set",
    "command.dispatch",
    "cli.exec",
    "process.stop",
    "terminal.resize",
    "image.attach",
    "session.branch",
    "session.compress",
];

pub struct HermesSessionAdapter {
    endpoint: Option<GatewayEndpoint>,
    socket: Option<TcpStream>,
    enforce_session_scope: bool,
    owned_live_sessions: HashSet<String>,
    next_rpc_id: u64,
    next_sequence: u64,
    status: SessionStatus,
    queue_limit: usize,
    replay_window: usize,
    queue: VecDeque<SessionEvent>,
    replay: VecDeque<SessionEvent>,
    signals: StreamSignals,
    pending_approvals: HashSet<String>,
    pending_clarifications: HashSet<String>,
}

impl HermesSessionAdapter {
    pub fn connect(endpoint: GatewayEndpoint) -> Result<Self, AdapterError> {
        let mut last_error = AdapterError::GatewayLost;
        debug_assert_eq!(CONNECT_BACKOFFS.len() + 1, MAX_CONNECT_ATTEMPTS);
        for backoff in CONNECT_BACKOFFS
            .iter()
            .copied()
            .map(Some)
            .chain(std::iter::once(None))
        {
            match connect_once(&endpoint) {
                Ok(socket) => {
                    return Ok(Self {
                        endpoint: Some(endpoint),
                        socket: Some(socket),
                        enforce_session_scope: true,
                        ..Self::scripted()
                    });
                }
                Err(AdapterError::AuthFailed) => return Err(AdapterError::AuthFailed),
                Err(error) => {
                    last_error = error;
                    if let Some(backoff) = backoff {
                        thread::sleep(backoff);
                    }
                }
            }
        }
        match last_error {
            AdapterError::Timeout | AdapterError::GatewayLost => Err(AdapterError::RetryExhausted),
            error => Err(error),
        }
    }

    pub fn scripted() -> Self {
        Self::scripted_with_queue_limit(DEFAULT_EVENT_QUEUE_LIMIT)
    }

    pub fn scripted_with_queue_limit(queue_limit: usize) -> Self {
        Self {
            endpoint: None,
            socket: None,
            enforce_session_scope: false,
            owned_live_sessions: HashSet::new(),
            next_rpc_id: 0,
            next_sequence: 0,
            status: SessionStatus::Idle,
            queue_limit: queue_limit.max(1),
            replay_window: DEFAULT_REPLAY_WINDOW,
            queue: VecDeque::new(),
            replay: VecDeque::new(),
            signals: StreamSignals::default(),
            pending_approvals: HashSet::new(),
            pending_clarifications: HashSet::new(),
        }
    }

    pub fn endpoint(&self) -> Option<&GatewayEndpoint> {
        self.endpoint.as_ref()
    }

    pub const fn status(&self) -> SessionStatus {
        self.status
    }

    pub const fn stream_signals(&self) -> StreamSignals {
        self.signals
    }

    fn require_owned_live_session(&self, live_id: &str) -> Result<(), AdapterError> {
        if live_id.is_empty() {
            return Err(AdapterError::MalformedRpc);
        }
        if self.enforce_session_scope && !self.owned_live_sessions.contains(live_id) {
            return Err(AdapterError::UnknownSession);
        }
        Ok(())
    }

    pub fn drain_events(&mut self) -> Vec<SessionEvent> {
        self.queue.drain(..).collect()
    }

    pub fn replay_from(&self, sequence: u64) -> Result<Vec<SessionEvent>, AdapterError> {
        if self
            .replay
            .front()
            .is_some_and(|event| sequence < event.sequence)
        {
            return Err(AdapterError::ReplayGap);
        }
        Ok(self
            .replay
            .iter()
            .filter(|event| event.sequence >= sequence)
            .cloned()
            .collect())
    }

    pub fn ingest_json(&mut self, raw: &str) -> Result<(), AdapterError> {
        if raw.len() > MAX_FRAME_BYTES {
            self.signals.malformed += 1;
            self.status = SessionStatus::Degraded;
            return Err(AdapterError::PayloadTooLarge);
        }
        let frame: Value = serde_json::from_str(raw).map_err(|_| {
            self.signals.malformed += 1;
            self.status = SessionStatus::Degraded;
            AdapterError::MalformedRpc
        })?;
        self.ingest_frame(frame)
    }

    pub fn create(&mut self, cwd: Option<&str>) -> Result<CreatedSession, AdapterError> {
        let mut params = serde_json::Map::new();
        params.insert("source".to_owned(), Value::String("relay".to_owned()));
        if let Some(cwd) = cwd.filter(|cwd| !cwd.is_empty()) {
            params.insert("cwd".to_owned(), Value::String(cwd.to_owned()));
        }
        let result = self.call("session.create", Value::Object(params))?;
        let live_id = string_field(&result, "session_id")?;
        let stored_id = string_field(&result, "stored_session_id")?;
        self.owned_live_sessions.insert(live_id.clone());
        Ok(CreatedSession { live_id, stored_id })
    }

    pub fn list(&mut self) -> Result<Vec<SessionSummary>, AdapterError> {
        let result = self.call("session.list", json!({"limit": 50}))?;
        let sessions = result
            .get("sessions")
            .and_then(Value::as_array)
            .ok_or(AdapterError::MalformedRpc)?;
        sessions
            .iter()
            .map(|session| {
                Ok(SessionSummary {
                    stored_id: string_field(session, "id")?,
                })
            })
            .collect()
    }

    pub fn resume(&mut self, stored_id: &str) -> Result<CreatedSession, AdapterError> {
        if stored_id.is_empty() || stored_id.len() > 256 {
            return Err(AdapterError::MalformedRpc);
        }
        let result = self.call("session.resume", json!({"session_id": stored_id}))?;
        let live_id = string_field(&result, "session_id")?;
        let stored_id = result
            .get("stored_session_id")
            .and_then(Value::as_str)
            .unwrap_or(stored_id)
            .to_owned();
        self.owned_live_sessions.insert(live_id.clone());
        Ok(CreatedSession { live_id, stored_id })
    }

    pub fn prompt(&mut self, live_id: &str, text: &str) -> Result<(), AdapterError> {
        self.require_owned_live_session(live_id)?;
        if text.is_empty() || text.len() > MAX_RPC_BYTES / 2 {
            return Err(AdapterError::PayloadTooLarge);
        }
        self.status = SessionStatus::Working;
        self.call(
            "prompt.submit",
            json!({"session_id": live_id, "text": text}),
        )?;
        Ok(())
    }

    pub fn interrupt(&mut self, live_id: &str) -> Result<(), AdapterError> {
        self.require_owned_live_session(live_id)?;
        self.call("session.interrupt", json!({"session_id": live_id}))
            .map(|_| ())
    }

    pub fn respond_approval(
        &mut self,
        live_id: &str,
        choice: ApprovalChoice,
    ) -> Result<(), AdapterError> {
        self.require_owned_live_session(live_id)?;
        if !self.pending_approvals.remove(live_id) {
            self.status = SessionStatus::Degraded;
            return Err(AdapterError::Raced);
        }
        self.call(
            "approval.respond",
            json!({"session_id": live_id, "choice": choice.as_wire()}),
        )
        .map(|_| ())
    }

    pub fn respond_clarification(
        &mut self,
        request_id: &str,
        answer: &str,
    ) -> Result<(), AdapterError> {
        if request_id.is_empty() || request_id.len() > 256 || answer.len() > MAX_RPC_BYTES / 2 {
            return Err(AdapterError::PayloadTooLarge);
        }
        if !self.pending_clarifications.remove(request_id) {
            self.status = SessionStatus::Degraded;
            return Err(AdapterError::Raced);
        }
        self.call(
            "clarify.respond",
            json!({"request_id": request_id, "answer": answer}),
        )
        .map(|_| ())
    }

    pub fn pump(&mut self, timeout: Duration) -> Result<(), AdapterError> {
        let status_before_wait = self.status;
        match self.receive_frame(timeout) {
            Err(AdapterError::Timeout) => {
                // A bounded observation window is allowed to be quiet. Preserve
                // the previous state so callers can distinguish that idle wait
                // from a control-RPC deadline, which remains degraded.
                self.status = status_before_wait;
                Err(AdapterError::Timeout)
            }
            Err(error) => Err(error),
            Ok(frame) => self.ingest_json(&frame),
        }
    }

    fn call(&mut self, method: &str, params: Value) -> Result<Value, AdapterError> {
        if UNSUPPORTED_METHODS.contains(&method) {
            return Err(AdapterError::Unsupported);
        }
        self.next_rpc_id += 1;
        let request_id = self.next_rpc_id;
        let request = json!({
            "jsonrpc": "2.0",
            "id": request_id,
            "method": method,
            "params": params,
        });
        let wire = serde_json::to_string(&request).map_err(|_| AdapterError::MalformedRpc)?;
        if wire.len() > MAX_RPC_BYTES {
            return Err(AdapterError::PayloadTooLarge);
        }
        self.send_frame(&wire)?;

        loop {
            let raw = self.receive_frame(DEFAULT_RPC_TIMEOUT)?;
            let frame: Value = serde_json::from_str(&raw).map_err(|_| {
                self.signals.malformed += 1;
                self.status = SessionStatus::Degraded;
                AdapterError::MalformedRpc
            })?;
            if frame.get("id").and_then(Value::as_u64) == Some(request_id) {
                if let Some(error) = frame.get("error") {
                    let error = classify_rpc_error(error);
                    if !matches!(error, AdapterError::Unsupported) {
                        self.status = SessionStatus::Degraded;
                    }
                    return Err(error);
                }
                return frame.get("result").cloned().ok_or_else(|| {
                    self.signals.malformed += 1;
                    self.status = SessionStatus::Degraded;
                    AdapterError::MalformedRpc
                });
            }
            self.ingest_frame(frame)?;
        }
    }

    fn ingest_frame(&mut self, frame: Value) -> Result<(), AdapterError> {
        if frame.get("method").and_then(Value::as_str) != Some("event") {
            self.signals.malformed += 1;
            self.status = SessionStatus::Degraded;
            return Err(AdapterError::MalformedRpc);
        }
        let params = frame
            .get("params")
            .and_then(Value::as_object)
            .ok_or_else(|| {
                self.signals.malformed += 1;
                self.status = SessionStatus::Degraded;
                AdapterError::MalformedRpc
            })?;
        let event_type = params.get("type").and_then(Value::as_str).ok_or_else(|| {
            self.signals.malformed += 1;
            self.status = SessionStatus::Degraded;
            AdapterError::MalformedRpc
        })?;
        let session_id = params
            .get("session_id")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if self.enforce_session_scope
            && !session_id.is_empty()
            && !self.owned_live_sessions.contains(session_id)
        {
            self.signals.foreign += 1;
            return Ok(());
        }
        let payload = params.get("payload").and_then(Value::as_object);
        self.map_event(event_type, session_id, payload);
        Ok(())
    }

    fn map_event(
        &mut self,
        event_type: &str,
        session_id: &str,
        payload: Option<&serde_json::Map<String, Value>>,
    ) {
        let mut clarification_id = None;
        let (kind, label, preview) = match event_type {
            "gateway.ready" => (
                EventKind::Lifecycle,
                "gateway_ready",
                "gateway ready".to_owned(),
            ),
            "session.info" => (
                EventKind::Lifecycle,
                "session_info",
                "session information".to_owned(),
            ),
            "message.start" => {
                self.status = SessionStatus::Working;
                (
                    EventKind::Status,
                    "message_started",
                    "message started".to_owned(),
                )
            }
            "message.delta" => (
                EventKind::Status,
                "message_delta",
                "redacted message delta".to_owned(),
            ),
            "message.complete" => {
                self.status = SessionStatus::Idle;
                (
                    EventKind::Status,
                    "message_complete",
                    "message complete".to_owned(),
                )
            }
            "thinking.delta" | "reasoning.delta" | "reasoning.available" => (
                EventKind::Status,
                "reasoning",
                "redacted reasoning".to_owned(),
            ),
            "status.update" => (
                EventKind::Status,
                "status_update",
                "status update".to_owned(),
            ),
            "tool.start" => (EventKind::Tool, "tool_started", tool_preview(payload)),
            "tool.progress" | "tool.generating" => {
                (EventKind::Tool, "tool_progress", tool_preview(payload))
            }
            "tool.complete" => (EventKind::Tool, "tool_complete", tool_preview(payload)),
            "tool.output_risk" => (
                EventKind::Tool,
                "tool_output_risk",
                "tool output risk updated".to_owned(),
            ),
            "approval.request" if !session_id.is_empty() => {
                self.pending_approvals.insert(session_id.to_owned());
                (
                    EventKind::ApprovalRequest,
                    "approval_request",
                    "approval requested".to_owned(),
                )
            }
            "clarify.request" => {
                let request_id = payload
                    .and_then(|payload| payload.get("request_id"))
                    .and_then(Value::as_str)
                    .filter(|id| id.len() <= 256);
                if let Some(request_id) = request_id.filter(|id| !id.is_empty()) {
                    self.pending_clarifications.insert(request_id.to_owned());
                    clarification_id = Some(request_id.to_owned());
                    (
                        EventKind::ClarificationRequest,
                        "clarification_request",
                        "clarification requested".to_owned(),
                    )
                } else {
                    self.record_unsupported();
                    (
                        EventKind::Unsupported,
                        "clarification_without_id",
                        "clarification request lacks a response id".to_owned(),
                    )
                }
            }
            "error" => {
                self.status = SessionStatus::Degraded;
                (
                    EventKind::Diagnostic,
                    "gateway_error",
                    "gateway reported an error".to_owned(),
                )
            }
            _ => {
                self.record_unsupported();
                (
                    EventKind::Unsupported,
                    "unsupported_event",
                    "unsupported gateway event".to_owned(),
                )
            }
        };
        self.enqueue(session_id, kind, label, preview, clarification_id);
    }

    fn record_unsupported(&mut self) {
        self.signals.unsupported += 1;
        self.status = SessionStatus::Degraded;
    }

    fn enqueue(
        &mut self,
        session_id: &str,
        kind: EventKind,
        label: &'static str,
        preview: String,
        clarification_id: Option<String>,
    ) {
        self.next_sequence += 1;
        let event = SessionEvent {
            sequence: self.next_sequence,
            session_id: session_id.to_owned(),
            kind,
            label,
            preview: truncate_preview(preview),
            clarification_id,
        };
        if self.queue.len() == self.queue_limit {
            self.queue.pop_front();
            self.signals.dropped += 1;
            self.signals.replay_gap = true;
            self.status = SessionStatus::Degraded;
        }
        self.queue.push_back(event.clone());
        self.replay.push_back(event);
        while self.replay.len() > self.replay_window {
            self.replay.pop_front();
        }
    }

    fn send_frame(&mut self, text: &str) -> Result<(), AdapterError> {
        let result = {
            let stream = self.socket.as_mut().ok_or(AdapterError::GatewayLost)?;
            write_websocket_frame(stream, 0x1, text.as_bytes()).map_err(map_io_error)
        };
        if let Err(error) = &result {
            self.record_transport_failure(error);
        }
        result
    }

    fn receive_frame(&mut self, timeout: Duration) -> Result<String, AdapterError> {
        let timeout_result = {
            let stream = self.socket.as_mut().ok_or(AdapterError::GatewayLost)?;
            stream.set_read_timeout(Some(timeout)).map_err(map_io_error)
        };
        if let Err(error) = timeout_result {
            self.record_transport_failure(&error);
            return Err(error);
        }

        loop {
            let frame = {
                let stream = self.socket.as_mut().ok_or(AdapterError::GatewayLost)?;
                read_websocket_frame(stream)
            };
            let (opcode, bytes) = match frame {
                Ok(frame) => frame,
                Err(error) => {
                    self.record_transport_failure(&error);
                    return Err(error);
                }
            };
            match opcode {
                0x1 => match String::from_utf8(bytes) {
                    Ok(text) => return Ok(text),
                    Err(_) => {
                        self.signals.malformed += 1;
                        self.status = SessionStatus::Degraded;
                        return Err(AdapterError::MalformedRpc);
                    }
                },
                0x8 => {
                    self.status = SessionStatus::Failed;
                    return Err(AdapterError::GatewayLost);
                }
                0x9 => {
                    let result = {
                        let stream = self.socket.as_mut().ok_or(AdapterError::GatewayLost)?;
                        write_websocket_frame(stream, 0xA, &bytes).map_err(map_io_error)
                    };
                    if let Err(error) = result {
                        self.record_transport_failure(&error);
                        return Err(error);
                    }
                }
                0xA => continue,
                _ => {
                    self.signals.malformed += 1;
                    self.status = SessionStatus::Degraded;
                    return Err(AdapterError::MalformedRpc);
                }
            }
        }
    }

    fn record_transport_failure(&mut self, error: &AdapterError) {
        match error {
            AdapterError::GatewayLost | AdapterError::RetryExhausted => {
                self.status = SessionStatus::Failed;
            }
            AdapterError::Timeout | AdapterError::PayloadTooLarge | AdapterError::MalformedRpc => {
                self.status = SessionStatus::Degraded;
            }
            _ => {}
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApprovalChoice {
    Once,
    Deny,
}

impl ApprovalChoice {
    const fn as_wire(self) -> &'static str {
        match self {
            Self::Once => "once",
            Self::Deny => "deny",
        }
    }
}

fn tool_preview(payload: Option<&serde_json::Map<String, Value>>) -> String {
    let tool_name = payload
        .and_then(|payload| payload.get("name"))
        .and_then(Value::as_str)
        .filter(|name| {
            name.len() <= 80
                && name.chars().all(|character| {
                    character.is_ascii_alphanumeric() || matches!(character, '_' | '-')
                })
        });
    match tool_name {
        Some(name) => format!("tool {name}"),
        None => "tool activity".to_owned(),
    }
}

fn truncate_preview(mut preview: String) -> String {
    const LIMIT: usize = 160;
    if preview.len() > LIMIT {
        preview.truncate(LIMIT);
    }
    preview
}

fn string_field(value: &Value, field: &str) -> Result<String, AdapterError> {
    value
        .get(field)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty() && value.len() <= 256)
        .map(ToOwned::to_owned)
        .ok_or(AdapterError::MalformedRpc)
}

fn classify_rpc_error(error: &Value) -> AdapterError {
    match error.get("code").and_then(Value::as_i64) {
        Some(-32601) => AdapterError::Unsupported,
        Some(-32700 | -32600 | -32602) => AdapterError::MalformedRpc,
        Some(4009) => AdapterError::Raced,
        _ => AdapterError::RemoteFailure,
    }
}

fn connect_once(endpoint: &GatewayEndpoint) -> Result<TcpStream, AdapterError> {
    let address = (endpoint.host.as_str(), endpoint.port)
        .to_socket_addrs()
        .map_err(map_io_error)?
        .find(|address| address.ip().is_loopback())
        .ok_or(AdapterError::GatewayLost)?;
    let mut stream =
        TcpStream::connect_timeout(&address, DEFAULT_RPC_TIMEOUT).map_err(map_io_error)?;
    stream
        .set_read_timeout(Some(DEFAULT_RPC_TIMEOUT))
        .map_err(map_io_error)?;
    stream
        .set_write_timeout(Some(DEFAULT_RPC_TIMEOUT))
        .map_err(map_io_error)?;

    let key = websocket_key()?;
    let request = format!(
        "GET {} HTTP/1.1\r\nHost: {}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: {}\r\nSec-WebSocket-Version: 13\r\n\r\n",
        endpoint.request_target,
        endpoint.host_header(),
        key
    );
    stream.write_all(request.as_bytes()).map_err(map_io_error)?;
    stream.flush().map_err(map_io_error)?;

    let response = read_http_headers(&mut stream)?;
    let status = response.lines().next().unwrap_or_default();
    if status.contains(" 401 ") || status.contains(" 403 ") {
        return Err(AdapterError::AuthFailed);
    }
    if !status.starts_with("HTTP/1.1 101") {
        return Err(AdapterError::GatewayLost);
    }
    let expected_accept = websocket_accept(&key);
    let actual_accept = response.lines().find_map(|line| {
        let (name, value) = line.split_once(':')?;
        name.eq_ignore_ascii_case("sec-websocket-accept")
            .then(|| value.trim())
    });
    if actual_accept != Some(expected_accept.as_str()) {
        return Err(AdapterError::GatewayLost);
    }
    Ok(stream)
}

fn websocket_key() -> Result<String, AdapterError> {
    let mut nonce = [0_u8; 16];
    std::fs::File::open("/dev/urandom")
        .and_then(|mut source| source.read_exact(&mut nonce))
        .map_err(map_io_error)?;
    Ok(STANDARD.encode(nonce))
}

fn websocket_accept(key: &str) -> String {
    let mut digest = Sha1::new();
    digest.update(key.as_bytes());
    digest.update(b"258EAFA5-E914-47DA-95CA-C5AB0DC85B11");
    STANDARD.encode(digest.finalize())
}

fn read_http_headers(stream: &mut TcpStream) -> Result<String, AdapterError> {
    let mut bytes = Vec::with_capacity(1024);
    let mut byte = [0_u8; 1];
    while bytes.len() < MAX_RPC_BYTES {
        stream.read_exact(&mut byte).map_err(map_io_error)?;
        bytes.push(byte[0]);
        if bytes.ends_with(b"\r\n\r\n") {
            return String::from_utf8(bytes).map_err(|_| AdapterError::MalformedRpc);
        }
    }
    Err(AdapterError::PayloadTooLarge)
}

fn write_websocket_frame(stream: &mut TcpStream, opcode: u8, payload: &[u8]) -> io::Result<()> {
    if payload.len() > MAX_FRAME_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "frame too large",
        ));
    }
    let mut mask = [0_u8; 4];
    std::fs::File::open("/dev/urandom")?.read_exact(&mut mask)?;
    let mut header = vec![0x80 | opcode, 0x80];
    if payload.len() <= 125 {
        header[1] |= payload.len() as u8;
    } else if payload.len() <= usize::from(u16::MAX) {
        header[1] |= 126;
        header.extend_from_slice(&(payload.len() as u16).to_be_bytes());
    } else {
        header[1] |= 127;
        header.extend_from_slice(&(payload.len() as u64).to_be_bytes());
    }
    header.extend_from_slice(&mask);
    stream.write_all(&header)?;
    for (index, byte) in payload.iter().enumerate() {
        stream.write_all(&[byte ^ mask[index % mask.len()]])?;
    }
    stream.flush()
}

fn read_websocket_frame(stream: &mut TcpStream) -> Result<(u8, Vec<u8>), AdapterError> {
    let mut header = [0_u8; 2];
    stream.read_exact(&mut header).map_err(map_io_error)?;
    if header[0] & 0xF0 != 0x80 || header[1] & 0x80 != 0 {
        return Err(AdapterError::MalformedRpc);
    }
    let opcode = header[0] & 0x0F;
    let mut length = u64::from(header[1] & 0x7F);
    if length == 126 {
        let mut bytes = [0_u8; 2];
        stream.read_exact(&mut bytes).map_err(map_io_error)?;
        length = u64::from(u16::from_be_bytes(bytes));
    } else if length == 127 {
        let mut bytes = [0_u8; 8];
        stream.read_exact(&mut bytes).map_err(map_io_error)?;
        length = u64::from_be_bytes(bytes);
    }
    if length as usize > MAX_FRAME_BYTES {
        return Err(AdapterError::PayloadTooLarge);
    }
    let mut payload = vec![0_u8; length as usize];
    stream.read_exact(&mut payload).map_err(map_io_error)?;
    Ok((opcode, payload))
}

fn map_io_error(error: io::Error) -> AdapterError {
    match error.kind() {
        io::ErrorKind::TimedOut | io::ErrorKind::WouldBlock => AdapterError::Timeout,
        io::ErrorKind::InvalidInput => AdapterError::PayloadTooLarge,
        _ => AdapterError::GatewayLost,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_loopback_dashboard_websocket_urls_with_credentials() {
        let endpoint =
            GatewayEndpoint::parse("ws://127.0.0.1:9119/api/ws?token=top-secret").unwrap();
        assert_eq!(
            endpoint.redacted_url(),
            "ws://127.0.0.1:9119/api/ws?credential=redacted"
        );
        assert!(GatewayEndpoint::parse("ws://127.0.0.1:9119/v1/chat/completions?token=x").is_err());
        assert!(GatewayEndpoint::parse("wss://127.0.0.1:9119/api/ws?token=x").is_err());
        assert!(
            GatewayEndpoint::parse("ws://127.0.0.1:9119/api/ws?token=x&ticket=browser-auth")
                .is_err()
        );
        assert!(
            GatewayEndpoint::parse("ws://127.0.0.1:9119/api/ws?token=x\r\nInjected: y").is_err()
        );
    }

    #[test]
    fn clarification_without_request_id_is_visible_but_not_answerable() {
        let mut adapter = HermesSessionAdapter::scripted();
        adapter.ingest_json(r#"{"jsonrpc":"2.0","method":"event","params":{"type":"clarify.request","session_id":"a","payload":{}}}"#).unwrap();
        assert_eq!(adapter.drain_events()[0].label, "clarification_without_id");
        assert_eq!(
            adapter.respond_clarification("missing", "answer"),
            Err(AdapterError::Raced)
        );
    }

    #[test]
    fn replay_window_reports_a_gap_before_the_oldest_retained_event() {
        let mut adapter = HermesSessionAdapter::scripted_with_queue_limit(3);
        adapter.replay_window = 2;
        for _ in 0..3 {
            adapter
                .ingest_json(
                    r#"{"jsonrpc":"2.0","method":"event","params":{"type":"gateway.ready"}}"#,
                )
                .unwrap();
        }
        assert_eq!(adapter.replay_from(1), Err(AdapterError::ReplayGap));
        assert_eq!(adapter.replay_from(2).unwrap().len(), 2);
    }
}
