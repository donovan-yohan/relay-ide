//! Native, loopback-only Hermes rich-client Session adapter.
//!
//! This crate speaks the authenticated dashboard `/api/ws` TUI JSON-RPC
//! protocol. It deliberately rejects the OpenAI-compatible API gateway and all
//! remote endpoints: Relay's first Hermes integration is one-node only.

use std::{
    collections::{HashMap, HashSet, VecDeque},
    fmt,
    io::{self, Read, Write},
    net::{TcpStream, ToSocketAddrs},
    thread,
    time::{Duration, Instant},
};

use base64::{Engine as _, engine::general_purpose::STANDARD};
use relay_session::jsonl::redact_and_bound_display;
use relay_session::{ChatCategory, ChatRole, ChatSignal, RichChatEvent};
use serde_json::{Value, json};
use sha1::{Digest, Sha1};

pub const DEFAULT_EVENT_QUEUE_LIMIT: usize = 128;
pub const DEFAULT_REPLAY_WINDOW: usize = 64;
pub const MAX_PENDING_INTERACTIONS: usize = DEFAULT_EVENT_QUEUE_LIMIT;
pub const MAX_RPC_BYTES: usize = 8 * 1024;
pub const MAX_FRAME_BYTES: usize = 64 * 1024;
pub const MAX_CONNECT_ATTEMPTS: usize = 3;
const CONNECT_BACKOFFS: [Duration; MAX_CONNECT_ATTEMPTS - 1] =
    [Duration::from_millis(50), Duration::from_millis(100)];
pub const DEFAULT_RPC_TIMEOUT: Duration = Duration::from_secs(15);
const GLOBAL_UNSCOPED_EVENTS: &[&str] = &["gateway.ready"];

#[derive(Debug, Clone, Copy)]
struct Deadline(Instant);

impl Deadline {
    fn after(timeout: Duration) -> Self {
        Self(Instant::now() + timeout)
    }

    fn remaining(self) -> Result<Duration, AdapterError> {
        let remaining = self.0.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            Err(AdapterError::Timeout)
        } else {
            Ok(remaining)
        }
    }

    fn set_read_timeout(self, stream: &TcpStream) -> Result<(), AdapterError> {
        stream
            .set_read_timeout(Some(self.remaining()?))
            .map_err(map_io_error)
    }

    fn set_write_timeout(self, stream: &TcpStream) -> Result<(), AdapterError> {
        stream
            .set_write_timeout(Some(self.remaining()?))
            .map_err(map_io_error)
    }
}

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
    EntropyUnavailable,
    GatewayLost,
    MalformedRpc,
    Timeout,
    RetryExhausted,
    ReplayGap,
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
            Self::EntropyUnavailable => "entropy_unavailable",
            Self::GatewayLost => "gateway_lost",
            Self::MalformedRpc => "malformed_rpc",
            Self::Timeout => "timeout",
            Self::RetryExhausted => "retry_exhausted",
            Self::ReplayGap => "replay_gap",
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
    pub rich: RichChatEvent,
    /// Opaque provider correlation for a clarification response. Present only
    /// when the gateway emitted one; no clarification payload is retained.
    pub clarification_id: Option<String>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct StreamSignals {
    pub dropped: u64,
    pub interaction_limited: u64,
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
    rpc_timeout: Duration,
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
    pending_approvals: HashMap<String, usize>,
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
            rpc_timeout: DEFAULT_RPC_TIMEOUT,
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
            pending_approvals: HashMap::new(),
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
        if !self.pending_approvals.contains_key(live_id) {
            self.status = SessionStatus::Degraded;
            return Err(AdapterError::Raced);
        }
        let result = self.call(
            "approval.respond",
            json!({"session_id": live_id, "choice": choice.as_wire()}),
        )?;
        let resolved = result
            .get("resolved")
            .and_then(Value::as_u64)
            .ok_or_else(|| {
                self.status = SessionStatus::Degraded;
                AdapterError::MalformedRpc
            })?;
        if resolved == 0 {
            self.status = SessionStatus::Degraded;
            return Err(AdapterError::Raced);
        }
        let remove_marker = {
            let pending = self
                .pending_approvals
                .get_mut(live_id)
                .expect("checked before control RPC");
            *pending -= 1;
            *pending == 0
        };
        if remove_marker {
            self.pending_approvals.remove(live_id);
        }
        Ok(())
    }

    pub fn respond_clarification(
        &mut self,
        request_id: &str,
        answer: &str,
    ) -> Result<(), AdapterError> {
        if request_id.is_empty() || request_id.len() > 256 || answer.len() > MAX_RPC_BYTES / 2 {
            return Err(AdapterError::PayloadTooLarge);
        }
        if !self.pending_clarifications.contains(request_id) {
            self.status = SessionStatus::Degraded;
            return Err(AdapterError::Raced);
        }
        self.call(
            "clarify.respond",
            json!({"request_id": request_id, "answer": answer}),
        )?;
        self.pending_clarifications.remove(request_id);
        Ok(())
    }

    pub fn pump(&mut self, timeout: Duration) -> Result<(), AdapterError> {
        let status_before_wait = self.status;
        match self.receive_frame(Deadline::after(timeout), false) {
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
        let deadline = Deadline::after(self.rpc_timeout);
        self.send_frame(&wire, deadline)?;

        loop {
            let raw = match self.receive_frame(deadline, true) {
                Ok(raw) => raw,
                Err(AdapterError::Timeout) => {
                    self.quarantine_transport();
                    return Err(AdapterError::Timeout);
                }
                Err(error) => return Err(error),
            };
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

    fn quarantine_transport(&mut self) {
        self.socket.take();
        self.status = SessionStatus::Failed;
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
        let is_global = GLOBAL_UNSCOPED_EVENTS.contains(&event_type);
        let session_id = if is_global {
            params
                .get("session_id")
                .and_then(Value::as_str)
                .unwrap_or_default()
        } else {
            params
                .get("session_id")
                .and_then(Value::as_str)
                .filter(|session_id| !session_id.is_empty())
                .ok_or_else(|| {
                    self.signals.malformed += 1;
                    self.status = SessionStatus::Degraded;
                    AdapterError::MalformedRpc
                })?
        };
        if !is_global
            && self.enforce_session_scope
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
            "session.title" => (
                EventKind::Lifecycle,
                "session_title",
                "session title updated".to_owned(),
            ),
            "message.start" => {
                self.status = SessionStatus::Working;
                (
                    EventKind::Status,
                    "message_started",
                    "message started".to_owned(),
                )
            }
            "message.delta" => match assistant_message_text(payload) {
                Some(text) => (EventKind::Status, "assistant_message", text),
                None => (
                    EventKind::Status,
                    "message_delta",
                    "message update".to_owned(),
                ),
            },
            "message.complete" => {
                self.status = SessionStatus::Idle;
                match assistant_message_text(payload) {
                    Some(text) => (EventKind::Status, "assistant_message", text),
                    None => (
                        EventKind::Status,
                        "message_complete",
                        "message complete".to_owned(),
                    ),
                }
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
            "approval.request" => {
                if self.reserve_approval(session_id) {
                    (
                        EventKind::ApprovalRequest,
                        "approval_request",
                        "approval requested".to_owned(),
                    )
                } else {
                    self.record_interaction_pressure();
                    (
                        EventKind::Diagnostic,
                        "interaction_limit_reached",
                        "interaction request capacity reached".to_owned(),
                    )
                }
            }
            "clarify.request" => {
                let request_id = payload
                    .and_then(|payload| payload.get("request_id"))
                    .and_then(Value::as_str)
                    .filter(|id| id.len() <= 256);
                if let Some(request_id) = request_id.filter(|id| !id.is_empty()) {
                    if self.reserve_clarification(request_id) {
                        clarification_id = Some(request_id.to_owned());
                        (
                            EventKind::ClarificationRequest,
                            "clarification_request",
                            "clarification requested".to_owned(),
                        )
                    } else {
                        self.record_interaction_pressure();
                        (
                            EventKind::Diagnostic,
                            "interaction_limit_reached",
                            "interaction request capacity reached".to_owned(),
                        )
                    }
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

    fn reserve_approval(&mut self, session_id: &str) -> bool {
        if !self.has_pending_interaction_capacity() {
            return false;
        }
        *self
            .pending_approvals
            .entry(session_id.to_owned())
            .or_default() += 1;
        true
    }

    fn reserve_clarification(&mut self, request_id: &str) -> bool {
        if self.pending_clarifications.contains(request_id) {
            return true;
        }
        if !self.has_pending_interaction_capacity() {
            return false;
        }
        self.pending_clarifications.insert(request_id.to_owned());
        true
    }

    fn has_pending_interaction_capacity(&self) -> bool {
        self.pending_approvals.values().sum::<usize>() + self.pending_clarifications.len()
            < MAX_PENDING_INTERACTIONS
    }

    fn record_interaction_pressure(&mut self) {
        self.signals.interaction_limited += 1;
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
        let preview = truncate_preview(preview);
        let rich = hermes_rich_event(self.next_sequence, kind, label, &preview);
        let mut event = SessionEvent {
            sequence: self.next_sequence,
            session_id: session_id.to_owned(),
            kind,
            label,
            preview,
            rich,
            clarification_id,
        };
        if self.queue.len() == self.queue_limit {
            self.queue.pop_front();
            self.signals.dropped += 1;
            self.signals.replay_gap = true;
            self.status = SessionStatus::Degraded;
            event.rich.signal = Some(ChatSignal::QueuePressure);
        }
        self.queue.push_back(event.clone());
        self.replay.push_back(event);
        while self.replay.len() > self.replay_window {
            self.replay.pop_front();
        }
    }

    fn send_frame(&mut self, text: &str, deadline: Deadline) -> Result<(), AdapterError> {
        let result = {
            let stream = self.socket.as_mut().ok_or(AdapterError::GatewayLost)?;
            write_websocket_frame(stream, 0x1, text.as_bytes(), deadline)
        };
        self.finish_send(result)
    }

    fn receive_frame(
        &mut self,
        deadline: Deadline,
        quarantine_on_timeout: bool,
    ) -> Result<String, AdapterError> {
        loop {
            let frame = {
                let stream = self.socket.as_mut().ok_or(AdapterError::GatewayLost)?;
                read_websocket_frame(stream, deadline)
            };
            let (opcode, bytes) = match frame {
                Ok(frame) => frame,
                Err(error) => {
                    if quarantine_on_timeout || !matches!(error, AdapterError::Timeout) {
                        self.quarantine_transport();
                    }
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
                    self.quarantine_transport();
                    return Err(AdapterError::GatewayLost);
                }
                0x9 => {
                    let result = {
                        let stream = self.socket.as_mut().ok_or(AdapterError::GatewayLost)?;
                        write_websocket_frame(stream, 0xA, &bytes, deadline)
                    };
                    if let Err(error) = result {
                        return self.finish_send(Err(error));
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

    fn finish_send<T>(&mut self, result: Result<T, AdapterError>) -> Result<T, AdapterError> {
        if result.is_err() {
            self.quarantine_transport();
        }
        result
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

fn assistant_message_text(payload: Option<&serde_json::Map<String, Value>>) -> Option<String> {
    let payload = payload?;
    ["text", "delta", "content"]
        .into_iter()
        .find_map(|field| payload.get(field).and_then(Value::as_str))
        .filter(|text| !text.is_empty())
        .map(redact_and_bound_display)
}

fn hermes_rich_event(sequence: u64, kind: EventKind, label: &str, preview: &str) -> RichChatEvent {
    if label == "assistant_message" {
        return RichChatEvent::new(
            sequence,
            ChatRole::Assistant,
            ChatCategory::Message,
            label,
            preview,
            None,
        );
    }
    let (category, signal) = match kind {
        EventKind::Tool => (ChatCategory::Tool, None),
        EventKind::Diagnostic | EventKind::Unsupported => {
            (ChatCategory::Error, Some(ChatSignal::Degraded))
        }
        _ => (ChatCategory::Status, None),
    };
    RichChatEvent::new(sequence, ChatRole::System, category, label, preview, signal)
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
    connect_once_with_timeout(endpoint, DEFAULT_RPC_TIMEOUT)
}

fn connect_once_with_timeout(
    endpoint: &GatewayEndpoint,
    timeout: Duration,
) -> Result<TcpStream, AdapterError> {
    let deadline = Deadline::after(timeout);
    let address = (endpoint.host.as_str(), endpoint.port)
        .to_socket_addrs()
        .map_err(map_io_error)?
        .find(|address| address.ip().is_loopback())
        .ok_or(AdapterError::GatewayLost)?;
    let mut stream =
        TcpStream::connect_timeout(&address, deadline.remaining()?).map_err(map_io_error)?;

    let key = websocket_key()?;
    let request = format!(
        "GET {} HTTP/1.1\r\nHost: {}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: {}\r\nSec-WebSocket-Version: 13\r\n\r\n",
        endpoint.request_target,
        endpoint.host_header(),
        key
    );
    write_all_until(&mut stream, request.as_bytes(), deadline)?;
    flush_until(&mut stream, deadline)?;

    let response = read_http_headers(&mut stream, deadline)?;
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
    fill_random(&mut nonce)?;
    Ok(STANDARD.encode(nonce))
}

fn fill_random(bytes: &mut [u8]) -> Result<(), AdapterError> {
    getrandom::getrandom(bytes).map_err(|_| AdapterError::EntropyUnavailable)
}

fn websocket_accept(key: &str) -> String {
    let mut digest = Sha1::new();
    digest.update(key.as_bytes());
    digest.update(b"258EAFA5-E914-47DA-95CA-C5AB0DC85B11");
    STANDARD.encode(digest.finalize())
}

fn read_http_headers(stream: &mut TcpStream, deadline: Deadline) -> Result<String, AdapterError> {
    let mut bytes = Vec::with_capacity(1024);
    let mut byte = [0_u8; 1];
    while bytes.len() < MAX_RPC_BYTES {
        read_exact_until(stream, &mut byte, deadline)?;
        bytes.push(byte[0]);
        if bytes.ends_with(b"\r\n\r\n") {
            return String::from_utf8(bytes).map_err(|_| AdapterError::MalformedRpc);
        }
    }
    Err(AdapterError::PayloadTooLarge)
}

fn write_websocket_frame(
    stream: &mut TcpStream,
    opcode: u8,
    payload: &[u8],
    deadline: Deadline,
) -> Result<(), AdapterError> {
    if payload.len() > MAX_FRAME_BYTES {
        return Err(AdapterError::PayloadTooLarge);
    }
    if opcode & 0x08 != 0 && payload.len() > 125 {
        return Err(AdapterError::MalformedRpc);
    }
    let mut mask = [0_u8; 4];
    fill_random(&mut mask)?;
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
    header.reserve(payload.len());
    header.extend(
        payload
            .iter()
            .enumerate()
            .map(|(index, byte)| byte ^ mask[index % mask.len()]),
    );
    write_all_until(stream, &header, deadline)?;
    flush_until(stream, deadline)
}

fn read_websocket_frame(
    stream: &mut TcpStream,
    deadline: Deadline,
) -> Result<(u8, Vec<u8>), AdapterError> {
    let mut header = [0_u8; 2];
    read_exact_until(stream, &mut header, deadline)?;
    if header[0] & 0xF0 != 0x80 || header[1] & 0x80 != 0 {
        return Err(AdapterError::MalformedRpc);
    }
    let opcode = header[0] & 0x0F;
    let length_marker = header[1] & 0x7F;
    if opcode & 0x08 != 0 && length_marker >= 126 {
        return Err(AdapterError::MalformedRpc);
    }
    let mut length = u64::from(length_marker);
    if length_marker == 126 {
        let mut bytes = [0_u8; 2];
        read_exact_until(stream, &mut bytes, deadline)?;
        length = u64::from(u16::from_be_bytes(bytes));
    } else if length_marker == 127 {
        let mut bytes = [0_u8; 8];
        read_exact_until(stream, &mut bytes, deadline)?;
        length = u64::from_be_bytes(bytes);
    }
    if length > MAX_FRAME_BYTES as u64 {
        return Err(AdapterError::PayloadTooLarge);
    }
    let length = usize::try_from(length).map_err(|_| AdapterError::PayloadTooLarge)?;
    let mut payload = vec![0_u8; length];
    read_exact_until(stream, &mut payload, deadline)?;
    Ok((opcode, payload))
}

fn read_exact_until(
    stream: &mut TcpStream,
    buffer: &mut [u8],
    deadline: Deadline,
) -> Result<(), AdapterError> {
    let mut offset = 0;
    while offset < buffer.len() {
        deadline.set_read_timeout(stream)?;
        match stream.read(&mut buffer[offset..]) {
            Ok(0) => return Err(AdapterError::GatewayLost),
            Ok(read) => offset += read,
            Err(error) => return Err(map_io_error(error)),
        }
    }
    Ok(())
}

fn write_all_until(
    stream: &mut TcpStream,
    buffer: &[u8],
    deadline: Deadline,
) -> Result<(), AdapterError> {
    let mut offset = 0;
    while offset < buffer.len() {
        deadline.set_write_timeout(stream)?;
        match stream.write(&buffer[offset..]) {
            Ok(0) => return Err(AdapterError::GatewayLost),
            Ok(written) => offset += written,
            Err(error) => return Err(map_io_error(error)),
        }
    }
    Ok(())
}

fn flush_until(stream: &mut TcpStream, deadline: Deadline) -> Result<(), AdapterError> {
    deadline.set_write_timeout(stream)?;
    stream.flush().map_err(map_io_error)
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
    use std::net::TcpListener;

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

    #[test]
    fn pending_interactions_are_bounded_and_excess_is_visible() {
        let mut adapter = HermesSessionAdapter::scripted();
        for _ in 0..=MAX_PENDING_INTERACTIONS {
            adapter
                .ingest_json(
                    r#"{"jsonrpc":"2.0","method":"event","params":{"type":"approval.request","session_id":"live-session","payload":{}}}"#,
                )
                .unwrap();
        }

        assert_eq!(
            adapter.pending_approvals.get("live-session"),
            Some(&MAX_PENDING_INTERACTIONS)
        );
        assert_eq!(adapter.stream_signals().interaction_limited, 1);
        assert_eq!(
            adapter.drain_events().last().unwrap().label,
            "interaction_limit_reached"
        );
    }

    #[test]
    fn handshake_read_deadline_is_absolute_while_peer_drips_bytes() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let _ = read_http_headers(&mut stream, Deadline::after(Duration::from_secs(1)));
            for byte in b"HTTP/1.1 101 Switching Protocols\r\n" {
                if stream.write_all(&[*byte]).is_err() || stream.flush().is_err() {
                    break;
                }
                thread::sleep(Duration::from_millis(5));
            }
        });

        let endpoint =
            GatewayEndpoint::parse(&format!("ws://127.0.0.1:{port}/api/ws?token=test-token"))
                .unwrap();
        let started = Instant::now();
        assert!(matches!(
            connect_once_with_timeout(&endpoint, Duration::from_millis(20)),
            Err(AdapterError::Timeout)
        ));
        assert!(started.elapsed() < Duration::from_millis(100));
        server.join().unwrap();
    }

    #[test]
    fn control_rpc_deadline_is_absolute_while_frame_payload_drips() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            accept_upgrade(&mut stream);
            read_client_frame(&mut stream).unwrap();
            write_server_text_frame_drip(
                &mut stream,
                r#"{"jsonrpc":"2.0","id":1,"result":{"session_id":"live-session","stored_session_id":"stored-session"}}"#,
            );
        });

        let endpoint =
            GatewayEndpoint::parse(&format!("ws://127.0.0.1:{port}/api/ws?token=test-token"))
                .unwrap();
        let mut adapter = HermesSessionAdapter::connect(endpoint).unwrap();
        adapter.rpc_timeout = Duration::from_millis(20);

        let started = Instant::now();
        assert_eq!(adapter.create(None), Err(AdapterError::Timeout));
        assert!(started.elapsed() < Duration::from_millis(100));
        assert_eq!(adapter.status(), SessionStatus::Failed);
        assert!(adapter.socket.is_none());
        server.join().unwrap();
    }

    #[test]
    fn oversized_u64_frame_length_is_rejected_before_usize_conversion() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            accept_upgrade(&mut stream);
            stream.write_all(&[0x81, 127]).unwrap();
            stream.write_all(&u64::MAX.to_be_bytes()).unwrap();
            stream.flush().unwrap();
        });

        let endpoint =
            GatewayEndpoint::parse(&format!("ws://127.0.0.1:{port}/api/ws?token=test-token"))
                .unwrap();
        let mut adapter = HermesSessionAdapter::connect(endpoint).unwrap();

        assert_eq!(
            adapter.pump(Duration::from_millis(100)),
            Err(AdapterError::PayloadTooLarge)
        );
        assert_eq!(adapter.status(), SessionStatus::Failed);
        server.join().unwrap();
    }

    #[test]
    fn outbound_control_frames_are_limited_to_125_bytes() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let mut client = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        let (_server, _) = listener.accept().unwrap();

        assert_eq!(
            write_websocket_frame(
                &mut client,
                0xA,
                &[0_u8; 126],
                Deadline::after(Duration::from_millis(100)),
            ),
            Err(AdapterError::MalformedRpc)
        );
    }

    #[test]
    fn control_frames_reject_extended_length_markers_before_length_decode() {
        for (opcode, marker) in [(0x89, 126), (0x8A, 127), (0x8B, 126)] {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let port = listener.local_addr().unwrap().port();
            let server = thread::spawn(move || {
                let (mut stream, _) = listener.accept().unwrap();
                accept_upgrade(&mut stream);
                stream.write_all(&[opcode, marker]).unwrap();
                stream.flush().unwrap();
            });

            let endpoint =
                GatewayEndpoint::parse(&format!("ws://127.0.0.1:{port}/api/ws?token=test-token"))
                    .unwrap();
            let mut adapter = HermesSessionAdapter::connect(endpoint).unwrap();

            assert_eq!(
                adapter.pump(Duration::from_millis(100)),
                Err(AdapterError::MalformedRpc),
                "opcode {opcode:#x} with marker {marker} must fail before an extended-length read"
            );
            server.join().unwrap();
        }
    }

    #[test]
    fn partial_send_failure_quarantines_the_socket() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let client = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        let (_server, _) = listener.accept().unwrap();
        let mut adapter = HermesSessionAdapter::scripted();
        adapter.socket = Some(client);
        let mut writer = PartialWriteFailure::default();
        let result = writer.write_all(b"frame").map_err(map_io_error);

        assert_eq!(adapter.finish_send(result), Err(AdapterError::GatewayLost));
        assert!(adapter.socket.is_none());
        assert_eq!(adapter.status(), SessionStatus::Failed);
    }

    #[test]
    fn passive_observation_timeout_keeps_the_socket_for_later_pumps() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            accept_upgrade(&mut stream);
            thread::sleep(Duration::from_millis(50));
        });

        let endpoint =
            GatewayEndpoint::parse(&format!("ws://127.0.0.1:{port}/api/ws?token=test-token"))
                .unwrap();
        let mut adapter = HermesSessionAdapter::connect(endpoint).unwrap();

        assert_eq!(
            adapter.pump(Duration::from_millis(5)),
            Err(AdapterError::Timeout)
        );
        assert_eq!(adapter.status(), SessionStatus::Idle);
        assert!(adapter.socket.is_some());
        server.join().unwrap();
    }

    #[test]
    fn control_timeout_quarantines_the_socket_before_a_late_response_can_be_reused() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let request =
                read_http_headers(&mut stream, Deadline::after(Duration::from_secs(1))).unwrap();
            let key = request
                .lines()
                .find_map(|line| line.strip_prefix("Sec-WebSocket-Key: "))
                .unwrap();
            let accept = websocket_accept(key);
            write!(
                stream,
                "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {accept}\r\n\r\n"
            )
            .unwrap();
            read_client_frame(&mut stream).unwrap();
            write_server_text_frame(
                &mut stream,
                r#"{"jsonrpc":"2.0","id":1,"result":{"session_id":"live-session","stored_session_id":"stored-session"}}"#,
            )
            .unwrap();
            read_client_frame(&mut stream).unwrap();
            thread::sleep(Duration::from_millis(20));
            let _ = write_server_text_frame(&mut stream, r#"{"jsonrpc":"2.0","id":2,"result":{}}"#);
        });

        let endpoint =
            GatewayEndpoint::parse(&format!("ws://127.0.0.1:{port}/api/ws?token=test-token"))
                .unwrap();
        let mut adapter = HermesSessionAdapter::connect(endpoint).unwrap();
        let session = adapter.create(None).unwrap();
        adapter.rpc_timeout = Duration::from_millis(5);

        assert_eq!(
            adapter.interrupt(&session.live_id),
            Err(AdapterError::Timeout)
        );
        assert_eq!(adapter.status(), SessionStatus::Failed);
        assert_eq!(
            adapter.interrupt(&session.live_id),
            Err(AdapterError::GatewayLost)
        );
        server.join().unwrap();
    }

    fn accept_upgrade(stream: &mut TcpStream) {
        let request = read_http_headers(stream, Deadline::after(Duration::from_secs(1))).unwrap();
        let key = request
            .lines()
            .find_map(|line| line.strip_prefix("Sec-WebSocket-Key: "))
            .unwrap();
        let accept = websocket_accept(key);
        write!(
            stream,
            "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {accept}\r\n\r\n"
        )
        .unwrap();
    }

    fn write_server_text_frame_drip(stream: &mut TcpStream, text: &str) {
        stream.write_all(&[0x81, text.len() as u8]).unwrap();
        stream.flush().unwrap();
        for byte in text.as_bytes() {
            if stream.write_all(&[*byte]).is_err() || stream.flush().is_err() {
                break;
            }
            thread::sleep(Duration::from_millis(5));
        }
    }

    #[derive(Default)]
    struct PartialWriteFailure {
        wrote_once: bool,
    }

    impl Write for PartialWriteFailure {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            if self.wrote_once {
                Err(io::Error::new(io::ErrorKind::BrokenPipe, "write failed"))
            } else {
                self.wrote_once = true;
                Ok(bytes.len().min(1))
            }
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    fn write_server_text_frame(stream: &mut TcpStream, text: &str) -> io::Result<()> {
        stream.write_all(&[0x81, text.len() as u8])?;
        stream.write_all(text.as_bytes())?;
        stream.flush()
    }

    fn read_client_frame(stream: &mut TcpStream) -> io::Result<()> {
        let mut header = [0_u8; 2];
        stream.read_exact(&mut header)?;
        assert_ne!(header[1] & 0x80, 0, "client frames are masked");
        let length = usize::from(header[1] & 0x7F);
        assert!(length < 126, "test request stays compact");
        let mut mask = [0_u8; 4];
        stream.read_exact(&mut mask)?;
        let mut payload = vec![0_u8; length];
        stream.read_exact(&mut payload)
    }
}
#[test]
fn assistant_message_is_typed_redacted_and_reasoning_is_not_retained() {
    let mut adapter = HermesSessionAdapter::scripted();
    adapter.ingest_json(
            r#"{"jsonrpc":"2.0","method":"event","params":{"type":"message.delta","session_id":"live-1","payload":{"text":"answer sk-SECRET"}}}"#,
        ).unwrap();
    adapter.ingest_json(
            r#"{"jsonrpc":"2.0","method":"event","params":{"type":"reasoning.delta","session_id":"live-1","payload":{"text":"private chain"}}}"#,
        ).unwrap();
    let events = adapter.drain_events();
    assert_eq!(events[0].rich.role, ChatRole::Assistant);
    assert_eq!(events[0].rich.text, "answer sk-[redacted]");
    assert!(
        !events
            .iter()
            .any(|event| event.rich.text.contains("private chain"))
    );
}

#[test]
fn foreign_session_event_does_not_surface() {
    let mut adapter = HermesSessionAdapter::scripted();
    adapter.enforce_session_scope = true;
    adapter.owned_live_sessions.insert("owned".to_owned());
    adapter.ingest_json(
            r#"{"jsonrpc":"2.0","method":"event","params":{"type":"message.delta","session_id":"foreign","payload":{"text":"must drop"}}}"#,
        ).unwrap();
    assert!(adapter.drain_events().is_empty());
    assert_eq!(adapter.stream_signals().foreign, 1);
}

#[test]
fn queue_pressure_marks_surviving_event_truthfully() {
    let mut adapter = HermesSessionAdapter::scripted_with_queue_limit(1);
    for name in ["one", "two"] {
        adapter.ingest_json(&format!(
                r#"{{"jsonrpc":"2.0","method":"event","params":{{"type":"tool.start","session_id":"live-1","payload":{{"name":"{name}"}}}}}}"#,
            )).unwrap();
    }
    let event = adapter.drain_events().pop().unwrap();
    assert_eq!(event.rich.signal, Some(ChatSignal::QueuePressure));
    assert_eq!(adapter.stream_signals().dropped, 1);
}
