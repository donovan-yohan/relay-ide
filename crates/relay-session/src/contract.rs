//! Provider-neutral Session contract.
//!
//! This module is the stable seam that downstream issues (#1142 session
//! surface, #1145 event fan-out) depend on. It deliberately does **not**
//! reference Codex, JSON-RPC, or any wire method name. Provider adapters
//! translate their transport into these neutral types; nothing here leaks
//! the underlying JSONL structure. Diagnostic previews are bounded, redacted
//! strings only, never raw provider payloads.

use std::fmt;

/// Opaque, provider-neutral session identity.
///
/// The inner string is an adapter-assigned handle. Callers must treat it as
/// opaque and must not parse provider structure out of it.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct SessionId(String);

impl SessionId {
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for SessionId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

/// Opaque identifier for one pending approval request.
///
/// Callers may correlate it with a later decision but must not infer provider
/// transport structure from its contents.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct ApprovalId(String);

impl ApprovalId {
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// A safe subset of approval requests with a documented response shape.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApprovalKind {
    Command,
    FileChange,
}

impl ApprovalKind {
    pub const fn code(self) -> &'static str {
        match self {
            Self::Command => "command",
            Self::FileChange => "file_change",
        }
    }
}

/// A pending approval request surfaced by the adapter.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApprovalRequest {
    pub id: ApprovalId,
    pub kind: ApprovalKind,
}

/// A one-request decision. Persistent grants and policy amendments are outside
/// this MVP because they add authority and storage scope.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApprovalDecision {
    AcceptOnce,
    Decline,
    Cancel,
}

/// Monotonic arrival sequence number.
///
/// Every event a session surfaces carries a sequence assigned strictly in the
/// order the adapter observed it on the transport. Consumers use this to detect
/// gaps and to preserve ordering independent of wall-clock timing.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct Sequence(pub u64);

impl fmt::Display for Sequence {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}", self.0)
    }
}

/// Coarse, provider-neutral session status.
///
/// Deliberately small: it captures enough for a downstream cockpit to render a
/// truthful lifecycle without exposing provider internals.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SessionStatus {
    /// Child spawned; handshake not yet complete.
    Starting,
    /// Handshake complete; no active work.
    Idle,
    /// A prompt/turn is being processed.
    Working,
    /// Still usable, but a bounded fault was observed (see reason).
    Degraded(DegradedReason),
    /// Terminal, unrecoverable within this session (see kind).
    Failed(FailureKind),
    /// Cleanly shut down and owned child reaped.
    Closed,
}

impl SessionStatus {
    pub fn is_terminal(&self) -> bool {
        matches!(self, Self::Failed(_) | Self::Closed)
    }
}

/// Typed, bounded degradation reasons. A session in `Degraded` remains usable;
/// the supervisor escalates to `Failed(TooManyFaults)` once the bounded
/// tolerance is exceeded.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DegradedReason {
    /// A transport line was not valid framing and was dropped.
    MalformedFrame,
    /// A transport line exceeded the byte limit and was dropped/truncated.
    OverLimitFrame,
    /// A provider event was recognized as a frame but is not modeled.
    UnsupportedEvent,
    /// A provider request required a response shape this build does not
    /// document as supported (e.g. an approval prompt) — reported, never
    /// answered with a fabricated decision.
    UnsupportedApproval,
    /// The bounded event queue overflowed and old events were shed.
    Backpressure,
    /// A cancel arrived after the work it targeted had already finished.
    CancellationRace,
}

impl DegradedReason {
    pub const fn code(self) -> &'static str {
        match self {
            Self::MalformedFrame => "malformed_frame",
            Self::OverLimitFrame => "over_limit_frame",
            Self::UnsupportedEvent => "unsupported_event",
            Self::UnsupportedApproval => "unsupported_approval",
            Self::Backpressure => "backpressure",
            Self::CancellationRace => "cancellation_race",
        }
    }
}

/// Typed terminal failures.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FailureKind {
    /// The provider executable could not be launched.
    ExecutableUnavailable,
    /// The owned child process exited/was terminated unexpectedly.
    ProcessTerminated,
    /// A required protocol step did not complete within its deadline.
    Timeout,
    /// The bounded queue overflowed past the recovery tolerance.
    QueueOverflow,
    /// The transport produced output that violates the framing contract past
    /// the recovery tolerance.
    ProtocolViolation,
}

impl FailureKind {
    pub const fn code(self) -> &'static str {
        match self {
            Self::ExecutableUnavailable => "executable_unavailable",
            Self::ProcessTerminated => "process_terminated",
            Self::Timeout => "timeout",
            Self::QueueOverflow => "queue_overflow",
            Self::ProtocolViolation => "protocol_violation",
        }
    }
}

/// Neutral classification of a surfaced event. The adapter maps provider
/// method names onto this closed set; downstream code never sees the raw
/// method string, only `kind` + a neutral `label`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EventKind {
    /// Session/turn lifecycle transition.
    Lifecycle,
    /// Opaque incremental work output.
    Progress,
    /// Provider asked for a decision. Only emitted for shapes the adapter
    /// documents as supported; otherwise a `Diagnostic` with
    /// `UnsupportedApproval` is emitted instead.
    ApprovalRequest,
    /// A warning/degradation signal from the provider or adapter.
    Diagnostic,
    /// A well-formed frame whose meaning is not modeled by the adapter.
    Unsupported,
}

impl EventKind {
    pub const fn code(self) -> &'static str {
        match self {
            Self::Lifecycle => "lifecycle",
            Self::Progress => "progress",
            Self::ApprovalRequest => "approval_request",
            Self::Diagnostic => "diagnostic",
            Self::Unsupported => "unsupported",
        }
    }
}

/// A single provider-neutral event.
///
/// `label` is a stable, human-readable neutral tag chosen by the adapter (for
/// example `"turn.started"`), *not* the provider's wire method. `preview` is a
/// bounded, secret-redacted diagnostic string; it never carries structured
/// provider payload and must not be parsed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionEvent {
    pub seq: Sequence,
    pub kind: EventKind,
    pub label: String,
    pub preview: String,
}

impl SessionEvent {
    pub fn new(
        seq: Sequence,
        kind: EventKind,
        label: impl Into<String>,
        preview: impl Into<String>,
    ) -> Self {
        Self {
            seq,
            kind,
            label: label.into(),
            preview: preview.into(),
        }
    }
}

/// Backpressure / integrity counters exposed alongside the event stream.
///
/// These are cumulative and monotonic for the life of the session. They let a
/// consumer detect lossy conditions truthfully instead of silently believing
/// it saw everything.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct StreamSignals {
    /// Frames dropped because the bounded queue was full when they arrived.
    pub dropped: u64,
    /// Lines rejected for exceeding the byte limit.
    pub over_limit: u64,
    /// Lines rejected as malformed framing.
    pub malformed: u64,
    /// Well-formed but unmodeled frames observed.
    pub unsupported: u64,
    /// True while the queue is at capacity and shedding.
    pub backpressured: bool,
}

/// Errors returned by session control methods (create/resume/prompt/cancel).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SessionError {
    /// The provider executable could not be launched.
    Unavailable,
    /// The session is in a terminal state and cannot accept the call.
    Terminal(FailureKind),
    /// The call could not complete within its deadline.
    Timeout,
    /// The call raced a lifecycle transition (e.g. cancel after completion).
    Raced(DegradedReason),
    /// The requested operation is not supported by the installed protocol.
    Unsupported(&'static str),
    /// The transport rejected the request (write failed / process gone).
    Transport,
}

impl SessionError {
    pub const fn code(&self) -> &'static str {
        match self {
            Self::Unavailable => "unavailable",
            Self::Terminal(_) => "terminal",
            Self::Timeout => "timeout",
            Self::Raced(_) => "raced",
            Self::Unsupported(_) => "unsupported",
            Self::Transport => "transport",
        }
    }
}

impl fmt::Display for SessionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Terminal(kind) => write!(formatter, "terminal:{}", kind.code()),
            Self::Raced(reason) => write!(formatter, "raced:{}", reason.code()),
            Self::Unsupported(detail) => write!(formatter, "unsupported:{detail}"),
            other => formatter.write_str(other.code()),
        }
    }
}

impl std::error::Error for SessionError {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_terminality_is_explicit() {
        assert!(SessionStatus::Failed(FailureKind::Timeout).is_terminal());
        assert!(SessionStatus::Closed.is_terminal());
        assert!(!SessionStatus::Idle.is_terminal());
        assert!(!SessionStatus::Degraded(DegradedReason::Backpressure).is_terminal());
    }

    #[test]
    fn session_id_is_opaque_but_displayable() {
        let id = SessionId::new("relay-sess-1");
        assert_eq!(id.as_str(), "relay-sess-1");
        assert_eq!(id.to_string(), "relay-sess-1");
    }

    #[test]
    fn error_codes_are_stable() {
        assert_eq!(SessionError::Unavailable.code(), "unavailable");
        assert_eq!(
            SessionError::Terminal(FailureKind::ProcessTerminated).to_string(),
            "terminal:process_terminated"
        );
    }
}
