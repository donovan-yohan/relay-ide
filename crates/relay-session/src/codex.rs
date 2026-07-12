//! Codex app-server adapter.
//!
//! Translates the Codex JSONL/JSON-RPC wire vocabulary into the provider-
//! neutral [`crate::contract`] types. This is the *only* module that knows
//! Codex method names; nothing it exports carries a raw method string past the
//! neutral boundary.
//!
//! ## Transport
//!
//! The single permitted transport is a locally-spawned child running
//! `codex app-server --stdio` (equivalently `--listen stdio://`), speaking
//! JSONL on stdin/stdout. Network transports the installed build also exposes
//! (`--listen ws://…`, the `--ws-*` auth flags, `--listen unix://…`) are
//! **never** selected. [`codex_command_args`] emits exactly the stdio argv, and
//! [`assert_local_stdio_only`] rejects any argument vector that would select a
//! non-stdio transport. The CLI negative probe exercises this at runtime.

use crate::contract::{ApprovalKind, DegradedReason, EventKind};
use crate::jsonl::{Frame, FrameClass};

/// The Codex subcommand + argument vector for the only permitted transport.
///
/// Deliberately fixed. There is no code path that appends a `--listen`,
/// `--ws-*`, or `unix://` argument.
pub fn codex_command_args() -> Vec<String> {
    vec!["app-server".to_owned(), "--stdio".to_owned()]
}

/// Tokens that would select a non-local or network transport. Presence of any
/// of these in an argv is a contract violation.
pub const FORBIDDEN_TRANSPORT_TOKENS: &[&str] = &[
    "--listen",
    "ws://",
    "wss://",
    "unix://",
    "--ws-auth",
    "--ws-token-file",
    "--ws-token-sha256",
    "--ws-shared-secret-file",
    "--ws-issuer",
    "--ws-audience",
    "--ws-max-clock-skew-seconds",
];

/// Reason an argv was rejected by the transport guard.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TransportViolation {
    pub token: String,
}

/// Assert that an argument vector selects only the local stdio transport.
///
/// Returns `Err` if any forbidden network/socket token appears. The one
/// tolerated `--stdio`/`stdio://` spelling is explicitly allowed; everything
/// under `--listen` (including `stdio://` passed *via* `--listen`) is treated
/// as out of contract for this MVP because it opens the door to the network
/// spellings — the fixed argv uses the bare `--stdio` flag only.
pub fn assert_local_stdio_only(args: &[String]) -> Result<(), TransportViolation> {
    for arg in args {
        let lowered = arg.to_ascii_lowercase();
        for forbidden in FORBIDDEN_TRANSPORT_TOKENS {
            if lowered.contains(forbidden) {
                return Err(TransportViolation {
                    token: (*forbidden).to_owned(),
                });
            }
        }
    }
    Ok(())
}

/// A neutral mapping decision for one observed frame.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Mapped {
    /// A neutral event to surface.
    Event {
        kind: EventKind,
        label: &'static str,
    },
    /// A response to an outstanding client request (correlated by id upstream).
    Response { ok: bool },
    /// A degraded condition to record (frame understood, but unsupported).
    Degraded(DegradedReason),
}

/// A ledger entry describing one wire method the adapter recognizes.
#[derive(Debug, Clone, Copy)]
pub struct LedgerEntry {
    pub method: &'static str,
    pub kind: EventKind,
    pub label: &'static str,
    /// True only when a sanitized real-process probe observed this method. The
    /// initial adapter maps generated-schema methods without overclaiming live
    /// turn/event observation.
    pub observed: bool,
}

/// Guaranteed / supported notification methods for the installed v2 build.
///
/// Every entry below is documented by the generated codex-cli 0.144.1 schema.
/// The adapter maps it if it arrives; a later real-turn probe can record
/// sanitized observation separately.
pub const EVENT_LEDGER: &[LedgerEntry] = &[
    LedgerEntry {
        method: "configWarning",
        kind: EventKind::Diagnostic,
        label: "config.warning",
        observed: false,
    },
    LedgerEntry {
        method: "remoteControl/status/changed",
        kind: EventKind::Diagnostic,
        label: "remote_control.status",
        observed: false,
    },
    LedgerEntry {
        method: "thread/started",
        kind: EventKind::Lifecycle,
        label: "session.started",
        observed: false,
    },
    LedgerEntry {
        method: "mcpServer/startupStatus/updated",
        kind: EventKind::Diagnostic,
        label: "mcp.startup_status",
        observed: false,
    },
    LedgerEntry {
        method: "turn/started",
        kind: EventKind::Lifecycle,
        label: "turn.started",
        observed: false,
    },
    LedgerEntry {
        method: "turn/completed",
        kind: EventKind::Lifecycle,
        label: "turn.completed",
        observed: false,
    },
    LedgerEntry {
        method: "item/agentMessage/delta",
        kind: EventKind::Progress,
        label: "assistant.message",
        observed: false,
    },
    LedgerEntry {
        method: "item/started",
        kind: EventKind::Progress,
        label: "item.started",
        observed: false,
    },
    LedgerEntry {
        method: "item/completed",
        kind: EventKind::Progress,
        label: "item.completed",
        observed: false,
    },
    LedgerEntry {
        method: "thread/closed",
        kind: EventKind::Lifecycle,
        label: "session.closed",
        observed: false,
    },
    LedgerEntry {
        method: "error",
        kind: EventKind::Diagnostic,
        label: "provider.error",
        observed: false,
    },
];

/// Server→client **request** method names that appear in the generated v2
/// schema's top-level `ServerRequest` union for codex-cli 0.144.1. The two
/// command/file entries have a documented one-shot `accept` / `decline` /
/// `cancel` response and are queued by the supervisor; every other entry is
/// degraded without a fabricated reply. The list is generated-schema evidence,
/// not a claim of live prompt observation.
pub const SCHEMA_SERVER_REQUEST_METHODS: &[&str] = &[
    "item/commandExecution/requestApproval",
    "item/fileChange/requestApproval",
    "item/tool/requestUserInput",
    "mcpServer/elicitation/request",
    "item/permissions/requestApproval",
    "item/tool/call",
    "account/chatgptAuthTokens/refresh",
    "attestation/generate",
    "applyPatchApproval",
    "execCommandApproval",
];

/// Current v2 approval requests with an identical, documented bounded decision
/// result: `accept`, `decline`, or `cancel`. Other server requests remain
/// explicit unsupported/degraded events in this MVP.
pub fn approval_kind_for_method(method: &str) -> Option<ApprovalKind> {
    match method {
        "item/commandExecution/requestApproval" => Some(ApprovalKind::Command),
        "item/fileChange/requestApproval" => Some(ApprovalKind::FileChange),
        _ => None,
    }
}

/// Map a scanned frame onto a neutral decision.
pub fn map_frame(frame: &Frame) -> Mapped {
    match &frame.class {
        FrameClass::Response { ok } => Mapped::Response { ok: *ok },
        FrameClass::Notification => match frame.method.as_deref() {
            Some(method) => match ledger_lookup(method) {
                Some(entry) => Mapped::Event {
                    kind: entry.kind,
                    label: entry.label,
                },
                None => Mapped::Degraded(DegradedReason::UnsupportedEvent),
            },
            None => Mapped::Degraded(DegradedReason::UnsupportedEvent),
        },
        FrameClass::ServerRequest => match frame.method.as_deref() {
            Some(method) if approval_kind_for_method(method).is_some() => Mapped::Event {
                kind: EventKind::ApprovalRequest,
                label: "approval.request",
            },
            _ => Mapped::Degraded(DegradedReason::UnsupportedApproval),
        },
    }
}

fn ledger_lookup(method: &str) -> Option<&'static LedgerEntry> {
    EVENT_LEDGER.iter().find(|entry| entry.method == method)
}

/// Whether the adapter has a documented, non-fabricated one-shot response for
/// this server request. No session-wide approval or policy-amendment response
/// is exposed by this MVP.
pub fn can_answer_server_request(method: &str) -> bool {
    approval_kind_for_method(method).is_some()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::jsonl::scan_line;

    #[test]
    fn fixed_argv_is_local_stdio() {
        let args = codex_command_args();
        assert_eq!(args, vec!["app-server", "--stdio"]);
        assert!(assert_local_stdio_only(&args).is_ok());
    }

    #[test]
    fn websocket_and_socket_argvs_are_rejected() {
        for bad in [
            vec![
                "app-server".to_owned(),
                "--listen".to_owned(),
                "ws://127.0.0.1:9000".to_owned(),
            ],
            vec![
                "app-server".to_owned(),
                "--listen".to_owned(),
                "unix:///tmp/s".to_owned(),
            ],
            vec![
                "app-server".to_owned(),
                "--ws-auth".to_owned(),
                "signed-bearer-token".to_owned(),
            ],
            vec![
                "app-server".to_owned(),
                "--listen".to_owned(),
                "wss://example".to_owned(),
            ],
        ] {
            assert!(
                assert_local_stdio_only(&bad).is_err(),
                "should reject {bad:?}"
            );
        }
    }

    #[test]
    fn known_notification_maps_to_neutral_event() {
        let frame = scan_line(br#"{"method":"thread/started","params":{}}"#).unwrap();
        assert_eq!(
            map_frame(&frame),
            Mapped::Event {
                kind: EventKind::Lifecycle,
                label: "session.started"
            }
        );
    }

    #[test]
    fn unknown_notification_is_degraded_not_fatal() {
        let frame = scan_line(br#"{"method":"totally/unknown","params":{}}"#).unwrap();
        assert_eq!(
            map_frame(&frame),
            Mapped::Degraded(DegradedReason::UnsupportedEvent)
        );
    }

    #[test]
    fn only_documented_server_requests_surface_as_approvals() {
        let frame = scan_line(
            br#"{"jsonrpc":"2.0","id":5,"method":"item/fileChange/requestApproval","params":{}}"#,
        )
        .unwrap();
        assert_eq!(
            map_frame(&frame),
            Mapped::Event {
                kind: EventKind::ApprovalRequest,
                label: "approval.request"
            }
        );
        assert!(can_answer_server_request("item/fileChange/requestApproval"));
        assert!(!can_answer_server_request("openai/form"));
    }

    #[test]
    fn ledger_does_not_overclaim_live_observation() {
        let started = EVENT_LEDGER
            .iter()
            .find(|e| e.method == "thread/started")
            .unwrap();
        assert!(!started.observed);
        let turn = EVENT_LEDGER
            .iter()
            .find(|e| e.method == "turn/started")
            .unwrap();
        assert!(!turn.observed);
    }

    #[test]
    fn only_documented_current_approval_shapes_are_supported() {
        assert_eq!(
            approval_kind_for_method("item/commandExecution/requestApproval"),
            Some(ApprovalKind::Command)
        );
        assert_eq!(
            approval_kind_for_method("item/fileChange/requestApproval"),
            Some(ApprovalKind::FileChange)
        );
        assert_eq!(
            approval_kind_for_method("item/permissions/requestApproval"),
            None
        );
    }
}
