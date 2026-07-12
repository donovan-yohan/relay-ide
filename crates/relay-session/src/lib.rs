//! `relay-session`: minimal, one-node supervised Session adapters.
//!
//! ## What this crate is
//!
//! - [`contract`] — a small, provider-neutral Session identity/status/event
//!   contract that downstream issues (#1142, #1145) can build on. It never
//!   mentions Codex, JSON-RPC, or wire methods; Codex JSONL does not leak into
//!   it.
//! - [`jsonl`] — bounded JSONL framing for the Codex stdio transport: complete
//!   JSON validation with hard line/preview limits and secret redaction.
//! - [`codex`] — the Codex adapter: the fixed local `codex app-server --stdio`
//!   argv, a websocket/socket transport guard, the guaranteed/unsupported event
//!   ledger, and honest handling of server-initiated (approval) requests.
//! - [`supervisor`] — child-process supervision and the create / resume /
//!   prompt / cancel / close lifecycle, with monotonic arrival sequencing,
//!   bounded queues, backpressure/lag signals, and typed degraded/failed states
//!   with bounded recovery.
//! - [`claude_pty`] — the fixed node-owner Claude Code PTY runtime with bounded
//!   output, opaque handles, resize/interrupt control, and explicit close.
//!
//! ## What this crate is not
//!
//! It is not a generic multi-provider framework, not a network client (there is
//! no WebSocket path — see [`codex::assert_local_stdio_only`]), and it does not
//! persist raw provider transcripts. Diagnostic previews are bounded and
//! redacted.

pub mod claude_pty;
pub mod codex;
pub mod contract;
pub mod jsonl;
pub mod supervisor;

pub use contract::{
    ApprovalDecision, ApprovalId, ApprovalKind, ApprovalRequest, DegradedReason, EventKind,
    FailureKind, Sequence, SessionError, SessionEvent, SessionId, SessionStatus, StreamSignals,
};
pub use supervisor::{
    DEFAULT_DEADLINE, ProcessTransport, ScriptedTransport, Supervisor, Transport,
};
