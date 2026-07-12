# Codex app-server Session adapter

## Boundary

`relay-session` supervises exactly one local child command:

```text
codex app-server --stdio
```

The child communicates over newline-delimited JSON-RPC 2.0 on stdin/stdout.
Relay never selects `--listen`, `ws://`, `wss://`, `unix://`, or `--ws-*`
arguments. `relay-node codex-stdio-probe --negative-transport` is an executable
negative probe for that invariant.

The adapter owns the child lifecycle, writes requests, reads stdout in arrival
order, and assigns monotonic neutral event sequence numbers. It does not
persist raw provider frames, provider credentials, or full transcripts.
Diagnostics retain only a 256-byte secret-redacted preview. Input lines are
capped at 64 KiB; both the child-reader hand-off and neutral queue hold 1,024
events. A full reader hand-off applies OS pipe backpressure rather than growing
Relay memory; neutral-event shedding is surfaced through typed signals/status.
Truncation, malformed frames, unsupported events, and backpressure are never
silently hidden.

## Downstream Session contract

`relay-session::contract` is provider-neutral:

- `SessionId` is opaque.
- `SessionStatus` is `Starting`, `Idle`, `Working`, `Degraded`, `Failed`, or
  `Closed`.
- `SessionEvent` has monotonic `Sequence`, neutral `EventKind`, label, and
  bounded redacted preview.
- `StreamSignals` reports dropped, over-limit, malformed, unsupported, and
  backpressure conditions.
- `ApprovalRequest`/`ApprovalDecision` expose only safe one-request command and
  file-change decisions. There is no persistent approval cache or policy
  amendment surface.

Codex method names are contained in the adapter; generic Session consumers do
not parse JSONL or method names.

## Guaranteed mapping ledger

The codex-cli 0.144.1 generated schema documents the mappings below. They are
mapped when received but are not claimed as real-turn observations until the
opt-in live probe succeeds.

| Codex event | Neutral event |
| --- | --- |
| `thread/started`, `thread/closed` | lifecycle: `session.started`, `session.closed` |
| `turn/started`, `turn/completed` | lifecycle: `turn.started`, `turn.completed` |
| `item/started`, `item/completed` | progress: `item.started`, `item.completed` |
| `configWarning`, `remoteControl/status/changed`, `error`, `mcpServer/startupStatus/updated` | diagnostic |

Supported current approval requests are
`item/commandExecution/requestApproval` and
`item/fileChange/requestApproval`. Relay exposes them as pending neutral
requests and sends only an explicit per-request `accept`, `decline`, or
`cancel` result chosen by its caller. It never auto-approves.

All other server requests—including permission profile changes, tool input,
MCP elicitation, token refresh, dynamic tools, attestation, and legacy approval
methods—remain unsupported. They produce typed degraded diagnostics and no
fabricated reply. Unknown notifications do the same.

## Recovery and failure behavior

| Condition | Result |
| --- | --- |
| Executable missing or stdin write fails | typed unavailable/transport error |
| Child exit | terminal `process_terminated` |
| Request deadline | typed timeout |
| Malformed or over-limit JSONL | degraded signal; terminal protocol failure only after bounded tolerance |
| Queue saturation | oldest event shed with drop/backpressure signal; terminal queue overflow past bounded tolerance |
| Cancel after completion/wrong turn | typed cancellation-race degradation |
| Provider error response | typed unsupported provider response |

No automatic restart occurs. The bounded recovery action is to close/reap the
owned child and create or resume a new Session explicitly.

## Probes

Run with the profile-local authenticated Codex environment:

```sh
HOME=/home/donovanyohan/.hermes/profiles/kani-backend/home \
PATH="$HOME/.local/bin:$PATH" \
cargo run -p relay-node -- codex-stdio-probe --negative-transport

HOME=/home/donovanyohan/.hermes/profiles/kani-backend/home \
PATH="$HOME/.local/bin:$PATH" \
cargo run -p relay-node -- codex-stdio-probe --handshake
```

`--exercise` additionally executes create, prompt, cancel, and resume. It is
opt-in because a real provider turn can consume account quota. Its output is a
small status record and deliberately excludes thread ids and transcripts.
