# relay-rmux-helper protocol and prototype boundary

Status: experimental spec for #707/#745. This is not a supported default runtime and not a promise that Relay will adopt rmux. It defines the minimum Relay-owned JSON/stdin-stdout boundary that a throwaway Rust `relay-rmux-helper` prototype must satisfy before any TypeScript adapter code is written.

## Sources and invariants

Reviewed before writing this boundary:

- `AGENTS.md` — Relay architecture direction, tmux requirement, CLI gateway/adapter boundary, node capability notes.
- `docs/ARCHITECTURE.md` — `SessionAttachment`, hub/node routing, REST/WebSocket identities, tmux as process substrate.
- `docs/CLI_GATEWAY.md` — adapter-facing commands are versioned Relay JSON contracts, never private node-link/rmux/tmux protocol clients.
- `docs/SESSION_DURABILITY.md` — attach handles are not process owners; terminal stream v2 replay/lag/resize semantics are the browser/runtime contract.
- `docs/adrs/ADR-017-brain-as-peer-cli-session-events.md` — agent brains are hub-level peers that act through the CLI gateway.
- `docs/adrs/ADR-018-command-mediated-handoff-supervisor.md` and issue #718 — rmux/tmux/PTY are substrates; command-mediated handoff/supervisor actions stay Relay-owned.
- Issues #696, #707, and #745 — rmux is prior art plus an optional feature-flagged helper prototype, not a default runtime switch.
- Existing code touch points: `server/session-attachment.ts`, `server/node-link-pty-host.ts`, `server/rmux-probe.ts`, and `test/rmux-probe.test.ts`.

Hard invariants:

1. Relay TypeScript must not speak the rmux daemon wire protocol directly. If the prototype proceeds, the Rust helper uses `rmux-sdk`; Relay speaks only this helper protocol.
2. Relay product/API identity remains `sessionId`, `globalSessionId`, `nodeId`, `SessionAttachment`, `SessionSummary`, and Workbench nouns. rmux pane/session ids are debug-only substrate handles.
3. The existing tmux/node-pty path remains the default and clean fallback. rmux is opt-in, experimental, and deletable.
4. Raw bytes are not a stable agent-to-agent/supervisor API. `write` and `submit` below are PTY substrate operations only; typed supervisor/handoff work remains in #718/ADR-018 command slices.
5. No raw prompt, transcript, provider auth, or unbounded terminal history is stored in audit/logs by default.

## Process model

Relay starts `relay-rmux-helper` as a child process with:

- stdin: newline-delimited UTF-8 JSON requests from Relay;
- stdout: newline-delimited UTF-8 JSON responses and events from the helper;
- stderr: diagnostic text only, captured with size limits and redacted before Relay logs surface it.

The helper owns the rmux-sdk connection and any rmux pane/session handles it creates or attaches to. Relay owns the child process lifecycle, timeout policy, feature gates, capability checks, and mapping into existing `SessionAttachment` semantics.

The helper is intentionally single-node and local to the Relay node that runs it. Hub/node routing still flows through existing Relay node-link/session routes; no browser, adapter, or remote peer talks to the helper directly.

## Framing and envelope

Every message is one JSON object followed by `\n`. Messages over 64 KiB before newline are invalid; output data uses bounded chunks so one terminal burst cannot create an unbounded JSON frame. The helper must reject malformed JSON without crashing.

Common request:

```json
{
  "protocol": "relay-rmux-helper",
  "version": 0,
  "id": "req-0001",
  "op": "create",
  "data": {}
}
```

Common success response:

```json
{
  "protocol": "relay-rmux-helper",
  "version": 0,
  "id": "req-0001",
  "ok": true,
  "op": "create",
  "data": {}
}
```

Common error response:

```json
{
  "protocol": "relay-rmux-helper",
  "version": 0,
  "id": "req-0001",
  "ok": false,
  "op": "create",
  "error": {
    "code": "RMUX_UNAVAILABLE",
    "message": "rmux daemon is unavailable",
    "retryable": true,
    "details": { "reason": "connection refused" }
  }
}
```

Async event:

```json
{
  "protocol": "relay-rmux-helper",
  "version": 0,
  "event": "output",
  "sessionId": "relay-session-123",
  "attachId": "attach-1",
  "sequence": 42,
  "at": "2026-05-27T00:00:00.000Z",
  "data": {}
}
```

Rules:

- `id` is required for requests and their direct responses. Async events have no request `id`.
- Unknown `op`, unknown top-level fields in strict positions, invalid enum values, non-positive dimensions, and oversize payloads return `INVALID_ARGUMENT`.
- `version: 0` marks the prototype as unstable. Relay must refuse any other version with `UNSUPPORTED_VERSION` until explicitly upgraded.
- The helper must send exactly one response for every request it accepts, even if async events later report closure or crash.
- Relay must treat helper stdout as untrusted input and validate every frame before touching session state.

## Session and attachment handles

Relay passes its own session id into the helper and uses that id in every helper message:

```json
{ "sessionId": "relay-session-123" }
```

The helper may return opaque substrate handles only under a debug field:

```json
{
  "sessionId": "relay-session-123",
  "debug": {
    "substrate": "rmux",
    "substrateSessionRefHash": "sha256:...",
    "substratePaneRefHash": "sha256:..."
  }
}
```

Redaction requirements:

- `sessionId` is the only stable session identity exposed to Relay product/API layers.
- rmux session ids, pane ids, socket paths, and daemon labels must not appear in `SessionSummary`, CLI gateway envelopes, browser events, audit rows, or normal logs.
- Debug output may include hashes and a `substrate: "rmux"` label only when an explicit debug flag is enabled.
- Hashes are for correlation during prototype testing, not API identity.

`attachId` is a helper-local handle for a Relay attach stream. Closing an attach must not kill the underlying rmux session. Killing a session requires `op: "kill"`.

## Operations

### `hello`

Optional startup probe used immediately after spawn.

Request:

```json
{
  "protocol": "relay-rmux-helper",
  "version": 0,
  "id": "req-hello",
  "op": "hello",
  "data": { "maxFrameBytes": 65536 }
}
```

Response data:

```json
{
  "helperVersion": "0.0.0-prototype",
  "rmuxSdkVersion": "0.1.x",
  "capabilities": [
    "create",
    "attach",
    "output",
    "snapshot",
    "write",
    "submit",
    "resize",
    "status",
    "close",
    "kill"
  ],
  "limits": {
    "maxFrameBytes": 65536,
    "defaultSnapshotBytes": 32768,
    "maxSnapshotBytes": 262144,
    "defaultIdleTimeoutMs": 10000
  }
}
```

### `create`

Create a new rmux-backed process for a Relay session. This maps to `SessionAttachmentFactory.open(...)`, not to a new Relay product identity.

Request data:

```json
{
  "sessionId": "relay-session-123",
  "command": "/bin/sh",
  "args": ["-lc", "exec bash"],
  "cwd": "/repo/worktree",
  "env": { "TERM": "xterm-256color" },
  "cols": 120,
  "rows": 40,
  "replayCapacityBytes": 262144
}
```

Success data:

```json
{
  "sessionId": "relay-session-123",
  "state": "running",
  "created": true,
  "attachable": true,
  "replayCapacityBytes": 262144
}
```

Rules:

- Relay validates cwd, command, args, env, feature gates, and node policy before calling the helper.
- The helper must still reject invalid cwd, invalid dimensions, and unsupported env shapes because it is a second trust boundary.
- Env propagation follows Relay's existing PTY sanitization baseline: strip `CLAUDECODE`, reject prototype-pollution keys, and do not add provider auth or secrets beyond what the existing session creation path would pass.
- Duplicate `create` for an existing live `sessionId` returns `ALREADY_EXISTS` unless a future explicit restore flag is specified.

### `attach`

Attach to an existing helper/rmux session and start output events.

Request data:

```json
{
  "sessionId": "relay-session-123",
  "attachId": "attach-1",
  "cursor": 1200,
  "maxReplayBytes": 32768
}
```

Success data:

```json
{
  "sessionId": "relay-session-123",
  "attachId": "attach-1",
  "state": "attached",
  "cursor": {
    "oldest": 1000,
    "newest": 1200,
    "replayFrom": 1200
  }
}
```

Rules:

- Attach opens a stream handle only. It must not create a new process.
- If `cursor` is older than retained output, the helper emits an output `lag` event with `reason: "cursor-too-old"` and replays from the oldest retained cursor.
- If `cursor` is newer than current output, the helper emits `lag` with `reason: "cursor-too-new"` and resumes live output without fabricating frames.
- Missing sessions return `SESSION_NOT_FOUND`; stale/closed attach ids return `STALE_ATTACH`.

### `output` event

All terminal bytes from rmux map into Relay's terminal stream v2 semantics.

Event data:

```json
{
  "kind": "data",
  "bytesBase64": "SGVsbG8K",
  "encoding": "base64",
  "cursorStart": 1201,
  "cursorEnd": 1207,
  "replay": false,
  "truncated": false
}
```

Other event kinds:

```json
{ "kind": "metadata", "runtime": "rmux", "replayCapacityBytes": 262144, "resizePolicy": "single-active-owner" }
{ "kind": "replay-start", "fromCursor": 1000, "toCursor": 1200 }
{ "kind": "replay-end", "cursor": 1200, "truncated": false }
{ "kind": "lag", "reason": "cursor-too-old", "oldest": 1000, "requested": 1 }
{ "kind": "resize", "cols": 120, "rows": 40, "owner": "attach-1" }
{ "kind": "closed", "reason": "process-exit", "exitCode": 0, "signal": null }
```

Mapping rules:

- Relay converts helper output to `TerminalStreamEnvelope` (`type: "terminal-stream"`, `version: 2`) before browser/client emission.
- The helper may report rmux render/snapshot metadata, but Relay still renders through xterm bytes unless a later explicit command introduces a structured renderer.
- Output chunking must preserve byte order per session. `sequence` is monotonic per attach stream; cursor is monotonic per session.
- Backpressure closes the attach stream instead of dropping frames silently. The final `closed` event includes `reason: "backpressure"`.

### `snapshot`

Return a bounded readback of retained terminal output/screen state. This is the helper equivalent of Relay's bounded replay snapshot, not an unbounded transcript export.

Request data:

```json
{
  "sessionId": "relay-session-123",
  "maxBytes": 32768,
  "maxLines": 2000,
  "cursor": 1200
}
```

Success data:

```json
{
  "sessionId": "relay-session-123",
  "cursor": { "oldest": 1000, "newest": 1536 },
  "bytesBase64": "Li4u",
  "encoding": "base64",
  "bytesIncluded": 32768,
  "bytesDropped": 8192,
  "capacityBytes": 262144,
  "truncatedBytes": true,
  "truncatedLines": false,
  "capturedAt": "2026-05-27T00:00:00.000Z"
}
```

Rules:

- Default `maxBytes` is 32 KiB. Hard max is the smaller of helper `maxSnapshotBytes` and Relay's configured replay cap; never exceed 256 KiB in this prototype.
- Default `maxLines` is 2000. The helper must report whether bytes or lines were truncated.
- Snapshot output is for current UI/adapter inspection and debugging. Do not store it in audit by default.

### `write`

Write literal text to the process. No newline is appended.

Request data:

```json
{
  "sessionId": "relay-session-123",
  "attachId": "attach-1",
  "text": "printf relay-ok",
  "encoding": "utf8"
}
```

Success data:

```json
{ "sessionId": "relay-session-123", "bytesWritten": 15 }
```

Rules:

- This maps to `SessionAttachment.write(Buffer)`.
- It is not a typed supervisor action and must not be exposed as the blessed agent-to-agent command API.
- Relay capability/control checks happen before the helper request. The helper still rejects writes for closed/missing/stale sessions.
- Audit/logs record byte counts and hashes only, not raw text, unless an explicit debug run opts in.

### `submit`

Submit an enter/return action, optionally after literal text. This exists because UIs and adapters often distinguish typing text from pressing Enter.

Request data:

```json
{
  "sessionId": "relay-session-123",
  "attachId": "attach-1",
  "text": "npm test",
  "newline": "\r"
}
```

Success data:

```json
{ "sessionId": "relay-session-123", "bytesWritten": 9, "submitted": true }
```

Rules:

- `newline` is either `"\r"` or `"\n"`; Relay should default to the same newline behavior as the current PTY path.
- `submit` with no `text` sends only the newline.
- This is still raw PTY input. Supervisor send/submit commands from #718 must be separate Relay-owned commands with stricter capability/control/audit policy.

### `resize`

Resize a session. The helper reports the resize back as an output `resize` event.

Request data:

```json
{
  "sessionId": "relay-session-123",
  "attachId": "attach-1",
  "cols": 120,
  "rows": 40
}
```

Success data:

```json
{ "sessionId": "relay-session-123", "cols": 120, "rows": 40, "applied": true }
```

Rules:

- `cols` and `rows` must be positive integers within Relay's existing terminal bounds.
- Relay keeps the terminal stream v2 `single-active-owner` resize policy: passive mirrors observe resize events but do not fight geometry.
- Stale attach ids return `STALE_ATTACH`; a closed process returns `SESSION_CLOSED`.

### `status`

Return helper/runtime/session health without exposing raw rmux identity.

Request data:

```json
{ "sessionId": "relay-session-123" }
```

Success data:

```json
{
  "sessionId": "relay-session-123",
  "helper": { "state": "healthy" },
  "rmux": { "state": "available-experimental", "version": "0.1.2" },
  "session": {
    "state": "running",
    "attachCount": 1,
    "cursorNewest": 1536,
    "replayCapacityBytes": 262144
  },
  "degradedReasons": []
}
```

Allowed helper states: `healthy`, `degraded`, `shutting-down`.
Allowed rmux states: `available-experimental`, `unavailable`, `available-but-unsupported`, `probe-failed`, `daemon-timeout`.
Allowed session states: `running`, `detached`, `closing`, `closed`, `missing`, `errored`.

Relay maps these into existing `SessionSummary`/durability fields:

| Helper status                  | Relay durability/status mapping                                                          |
| ------------------------------ | ---------------------------------------------------------------------------------------- |
| `running` + attached stream    | `running-attached` / active                                                              |
| `running` + no attach stream   | `running-detached` / disconnected                                                        |
| `closing`                      | transitional; disable writes/resizes                                                     |
| `closed`                       | `ended` then cleanup                                                                     |
| `errored`, helper crash        | `error`; include typed degraded reason                                                   |
| rmux unavailable before create | no rmux session; use default tmux/node-pty fallback if policy allows                     |
| rmux unavailable after create  | `error` or `stale-node`-like degraded state; do not silently re-home an existing session |

### `close`

Close one attach stream. This is detach semantics.

Request data:

```json
{
  "sessionId": "relay-session-123",
  "attachId": "attach-1",
  "reason": "browser-detach"
}
```

Success data:

```json
{
  "sessionId": "relay-session-123",
  "attachId": "attach-1",
  "state": "detached"
}
```

Rules:

- `close` must not kill the process or rmux session.
- After the last attach closes, the helper keeps the session reattachable until Relay's normal session lifecycle/idle policy kills it.
- Repeated close is idempotent only for the same attach id and returns detached/closed status; unknown attach id returns `ATTACH_NOT_FOUND`.

### `kill`

Terminate the underlying rmux-backed process/session.

Request data:

```json
{ "sessionId": "relay-session-123", "reason": "operator-kill" }
```

Success data:

```json
{
  "sessionId": "relay-session-123",
  "state": "closed",
  "exitCode": 143,
  "signal": 15
}
```

Rules:

- Relay calls `kill` only for explicit session termination, matching `SESSION_ATTACHMENT_KILL_REASON` semantics.
- The helper closes all attach streams, emits `closed` events, and releases rmux handles.
- Cleanup failures return `CLEANUP_FAILED` with `retryable: true` when another kill attempt might succeed.

## Typed errors

| Code                       | Retryable | Meaning                                                                                                                                      |
| -------------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `INVALID_JSON`             | false     | A stdin line was not valid JSON.                                                                                                             |
| `INVALID_ARGUMENT`         | false     | Schema, dimensions, cwd, env, cursor, size, or enum validation failed.                                                                       |
| `UNSUPPORTED_VERSION`      | false     | Protocol major/version mismatch.                                                                                                             |
| `FEATURE_DISABLED`         | false     | Relay-side gate should have blocked this before helper use; helper may return this during hello/create if built with runtime gate awareness. |
| `CAPABILITY_DENIED`        | false     | Relay/node policy denied an operation before substrate execution. Prefer returning this from Relay, not the helper.                          |
| `RMUX_UNAVAILABLE`         | true      | rmux binary/daemon/socket is unavailable.                                                                                                    |
| `RMUX_UNSUPPORTED_VERSION` | false     | rmux version is below the prototype floor.                                                                                                   |
| `DAEMON_TIMEOUT`           | true      | rmux daemon or SDK call timed out.                                                                                                           |
| `IPC_PERMISSION_DENIED`    | false     | rmux socket/named pipe exists but is not accessible to this node process.                                                                    |
| `HELPER_DEGRADED`          | true      | Helper is alive but missing a capability or has partial rmux failure.                                                                        |
| `HELPER_SHUTTING_DOWN`     | true      | Helper is draining; no new sessions accepted.                                                                                                |
| `SESSION_NOT_FOUND`        | false     | No live helper session for the Relay session id.                                                                                             |
| `ALREADY_EXISTS`           | false     | Create requested for an existing live helper session.                                                                                        |
| `ATTACH_NOT_FOUND`         | false     | Attach handle does not exist.                                                                                                                |
| `STALE_ATTACH`             | false     | Attach handle refers to an older/closed stream generation.                                                                                   |
| `SESSION_CLOSED`           | false     | Operation attempted after process/session closure.                                                                                           |
| `CLEANUP_FAILED`           | true      | Close/kill cleanup partially failed.                                                                                                         |
| `INTERNAL`                 | maybe     | Unexpected helper error; include a redacted reason and correlation id.                                                                       |

Error details must be redacted. Good details: `field`, `limit`, `reasonCode`, `correlationId`, `retryAfterMs`, `status`. Bad details: raw command text, raw prompt text, full cwd if policy requires path redaction, bearer tokens, socket credentials, provider auth, raw rmux pane ids.

## Gating and fallback

The prototype is reachable only when every gate passes:

1. Relay config enables the experimental helper, e.g. `experimental.rmuxHelper.enabled: true`. Default is false.
2. Node rmux probe status is `available-experimental`, as produced by `server/rmux-probe.ts` and surfaced in the node manifest.
3. A dev-only override is explicitly present for local experiments when the probe is `probe-failed` or `available-but-unsupported`, e.g. `RELAY_RMUX_HELPER_DEV_OVERRIDE=1`. The override must be visible in status output and PR/test evidence; it must not be accepted for production-tier nodes.
4. The requested session is local to the node process that can spawn the helper. Browser/adapters never bypass hub/node routing to reach the helper.
5. The operation has passed existing Relay session/capability/control checks before the helper sees a write, submit, resize, close, or kill.

Fallback rules:

- When the feature flag is off, no helper process is spawned and the existing tmux/node-pty path remains unchanged.
- When the flag is on but the rmux probe is unacceptable, Relay reports a degraded rmux capability and creates sessions with the default tmux/node-pty path unless the user explicitly requested rmux-only behavior for a prototype test.
- If helper spawn/hello fails during create, Relay may fall back to tmux/node-pty for that create only when the request did not require rmux-only. The response/session metadata must show `runtime: "tmux"`/existing mode, not pretend rmux succeeded.
- Once a session is created on rmux, Relay must not silently migrate it to tmux after helper/rmux failure. Mark it degraded/error, preserve bounded snapshot if available, and require explicit operator recovery.

## Security and audit boundaries

Stdio JSON:

- Validate every frame on both sides.
- Enforce per-frame and per-request size caps.
- Use request timeouts; never let one helper operation block the node event loop indefinitely.
- Treat helper stdout/stderr as untrusted. A compromised helper cannot grant capabilities or alter Relay session ownership.

rmux IPC/socket:

- The rmux probe documents expected Unix socket / Windows named-pipe shape. Prototype code must verify owner/current-user accessibility before use when possible.
- Relay must not open a new unauthenticated listener for rmux control.
- Socket paths and pipe labels are debug-only and redacted/hashes in logs.
- Permission errors fail closed as `IPC_PERMISSION_DENIED`.

Environment/process:

- Inherit only the sanitized environment Relay would pass to the existing PTY path.
- Strip `CLAUDECODE`; reject `__proto__`, `constructor`, and `prototype` env keys; do not inject provider auth just because the helper exists.
- Spawn under the Relay node user's permissions. Do not elevate. Do not write helper state into provider stores.

Audit/logging:

- Record operation type, Relay session id/global id, node id, actor/capability decision, byte counts, hashes, timestamps, and typed result.
- Do not store raw prompts, raw submitted text, raw terminal transcripts, provider auth, raw rmux ids, or socket credentials by default.
- `snapshot`/readback output is bounded and should be treated like terminal replay, not durable audit content.

## Crash and degraded-state matrix

| Failure                                        | Expected behavior                                                                                                                        |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Helper process exits before `hello`            | Mark rmux helper unavailable; fallback to tmux/node-pty if create was not rmux-only.                                                     |
| Helper exits with live sessions                | Emit/derive `error` for affected sessions, close helper attach streams, keep Relay process alive, do not auto-migrate existing sessions. |
| rmux daemon unavailable before create          | `RMUX_UNAVAILABLE`; fallback only for non-rmux-only create.                                                                              |
| rmux daemon timeout during attach/write/resize | Typed `DAEMON_TIMEOUT`; session becomes degraded until `status` recovers or operator kills/recreates.                                    |
| Unsupported rmux version                       | `RMUX_UNSUPPORTED_VERSION`; gate fails unless dev override is set.                                                                       |
| Session missing                                | `SESSION_NOT_FOUND`; Relay cleans up stale registry/attach state.                                                                        |
| Stale attach                                   | `STALE_ATTACH`; caller must reattach and request snapshot/replay with a fresh cursor.                                                    |
| Close cleanup fails                            | Attach marked closing/degraded; retry close or escalate to kill.                                                                         |
| Kill cleanup fails                             | `CLEANUP_FAILED`; Relay reports ended/error only after it can prove process/rmux handles are gone.                                       |
| Output backpressure                            | Close attach stream with `closed.reason: "backpressure"`; process remains running unless policy kills it.                                |

## Prototype acceptance evidence

A prototype PR that implements this boundary must include evidence for:

- feature flag off: no helper spawn, existing tmux/node-pty path still works;
- probe gate pass: `available-experimental` permits helper in explicit dev mode;
- probe gate fail: unavailable/unsupported/probe-failed status falls back cleanly;
- create/attach/output/snapshot/write/submit/resize/status/close/kill happy path;
- helper crash while attached;
- rmux unavailable/daemon timeout;
- session missing/stale attach;
- close vs kill distinction;
- identity redaction in `SessionSummary`, CLI/API output, logs, and audit summaries;
- no raw prompt/transcript/provider auth stored by default;
- packaging/deletion notes: what new files are helper-only and removable if abandoned.

## End-of-prototype decision template

Use this template at the end of the #707 prototype before deciding whether rmux gets another slice.

```md
## relay-rmux-helper prototype decision

Decision: keep iterating | abandon and delete | promote to second gated prototype

### Evidence

- Relay commit/PR:
- rmux upstream commit/version:
- Platforms tested:
- Feature flag state tested:
- Commands/tests/smokes run:
- Crash/degraded cases covered:

### Value over tmux/node-pty

- Complexity removed or simplified:
- User/operator behavior improved:
- Browser/session durability behavior improved:
- Gaps still worse than existing runtime:

### Safety and operations

- Capability/control/audit boundaries preserved:
- Identity redaction verified:
- IPC/socket permission risk:
- Packaging/update burden:
- Observability/debuggability:

### Code accounting

- Files added only for prototype:
- Files touched in default runtime path:
- Code that can be deleted if abandoned:
- Code that would remain even if rmux is abandoned:

### Next action

- If keep/promote: narrow next issue and required gates.
- If abandon: deletion PR/issues and docs cleanup.
```

If the prototype cannot show concrete deletion/simplification or a material reliability win over tmux/node-pty, the default decision should be abandon or defer. shiny substrate worship is how we get haunted process trees, and no thanks.
