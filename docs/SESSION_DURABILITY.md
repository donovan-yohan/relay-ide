# Session Durability

Tracks #614. This document explains the Relay session's process-ownership model
and the derived durability state machine added in the first epic slice.

## Process owner vs attach handle

A Relay session is owned by a node (PTY/tmux process or attached web runtime).
Browser tabs and hub sockets are **attach handles**, not process owners.
Closing a tab does not kill a session; killing a session requires an explicit
`kill` call that goes through the registry. Agents and operators should treat
"detach" as cheap and "kill" as load-bearing.

This boundary makes durable sessions feel reliable when a laptop sleeps, a
browser tab closes, a phone attaches later, or a node link flaps.

## Derived durability state

`shared/session-durability.ts` exposes a closed enum:

| State               | When                                                                       |
| ------------------- | -------------------------------------------------------------------------- |
| `running-attached`  | Process alive, hub/node link healthy, at least one attach handle.          |
| `running-detached`  | Process alive, no live attach handle (or coarse `status` reports so).      |
| `awaiting-start`    | Session created but has not produced output yet (`initializing` + `idle`). |
| `stale-node`        | Hub cannot prove the owning node is healthy (`stale`/`offline`/`revoked`). |
| `ended`             | PTY process was reaped and cleanup ran; nothing to reattach to.            |
| `error`             | Agent state reports an error condition.                                    |
| `permission-needed` | Interactive prompt waiting for an operator.                                |

Derivation lives in `deriveSessionDurability(input)`. It is a pure function;
priority order is documented in the source. `stale-node` is checked first
because hub-side node link health overrides any cached local process signal:
we cannot prove a process is still alive on an unreachable node.

The existing `SessionSummary.status: 'active' | 'disconnected'` is unchanged
for backward compatibility. New consumers reasoning about reattach safety
should prefer `summary.durability`.

## Transition emission

`sessions.onSessionDurabilityChanged(cb)` registers a listener that fires
whenever a session's derived durability differs from the last value emitted
for that session. Each event carries `{ sessionId, from, to, at }`. `ws.ts`
subscribes and broadcasts `session-durability-changed` over the existing
event stream so frontend/CLI gateway consumers can observe transitions
without polling.

`sessions.list()` calls the change-detection helper on every iteration; the
helper only fires when the derived state actually differs, so a steady-state
session does not emit on every list call.

## Bounded replay snapshot

PTY sessions own a 256 KB FIFO scrollback buffer (`server/pty-handler.ts`).
Slice 2 formalises this as a typed snapshot consumers can pull on demand:

```ts
sessions.getReplaySnapshot(sessionId): SessionReplaySnapshot | null
```

Snapshot fields:

| Field           | Meaning                                        |
| --------------- | ---------------------------------------------- |
| `payload`       | Concatenated scrollback string.                |
| `bytesIncluded` | Resident bytes in `payload`.                   |
| `bytesDropped`  | Lifetime bytes evicted by the FIFO. Monotonic. |
| `capacityBytes` | Per-session FIFO cap (currently 256 KB).       |
| `truncated`     | Convenience flag: `bytesDropped > 0`.          |
| `capturedAt`    | ISO timestamp of snapshot capture.             |
| `sessionId`     | Session id this snapshot belongs to.           |

REST endpoint: `GET /sessions/:id/replay` (auth-gated like other session
routes). Web-mode sessions and unknown ids return 404
`SESSION_REPLAY_UNAVAILABLE`; remote/routed sessions are out of scope for
this slice (see #614 slice 3+).

The existing WebSocket attach path now emits the versioned terminal stream v2
envelope for local PTY/tmux sessions instead of anonymous raw byte frames. The
browser remains on xterm.js and the default runtime is unchanged; the envelope
only makes the transport semantics explicit for future adapters.

## Terminal stream v2 envelope

`shared/session-replay.ts` defines `TerminalStreamEnvelope` with
`type: "terminal-stream"`, `version: 2`, the session id, a monotonic `seq`, a
cursor, timestamp, replay flag, and typed payload kinds:

- `metadata` announces the existing `node-pty/tmux` runtime, replay capacity,
  retained cursor range, last resize, and the `single-active-owner` resize
  policy.
- `replay-start` / `replay-end` bracket bounded reconnect replay. Clients pass
  `cursor=<lastSeenCursor>` on `/ws/:sessionId`; omitted cursor replays from
  the oldest retained frame.
- `lag` reports explicit stale/repair behavior: `cursor-too-old` starts replay
  from the oldest retained cursor, `cursor-too-new` skips replay and resumes
  live output, and `server-backfill` marks normal bounded backfill from a known
  cursor.
- `data` carries xterm bytes plus the retained cursor range. The browser still
  writes the payload to xterm.js; it also tracks the newest cursor for the next
  reconnect.
- `resize` records terminal resize attempts. Active clients are the only resize
  owners whose dimensions are applied to the PTY; passive mirrors receive the
  event but do not fight terminal geometry.

This contract is the gate for a later rmux adapter: rmux can map its output,
lag/backfill, render, and resize-owner signals into Relay's envelope without
changing browser rendering, permission checks, or the current node-pty/tmux
runtime.

## Frontend reconnect UX

`frontend/src/lib/session-durability.ts` maps each `SessionDurabilityState`
to a `{ statusDot, label, severity }` badge consumed by `SessionItem` and
mobile surfaces. `durabilityDisabledReason(state)` returns a typed string
when controls should be disabled (`stale-node`, `ended`, `error`) and
`null` otherwise. `permission-needed` deliberately does NOT disable
controls — the operator is supposed to answer prompts.

`activeWorkMobileControlState` consults the helper so the existing
disabled-reason fields on the mobile Active Work card surface the
durability reason ahead of the older "stale read model" / "${status} node"
messages.

The frontend subscribes to the `session-durability-changed` event stream
and updates the matching session in `useSessionsStore` without refetching
the full list (`handleDurabilityChanged`).

## Configurable scrollback cap

`resolveSessionDurabilityScrollbackBytes(config, repoPath, workspaceId?)`
resolves the effective per-session FIFO cap. Precedence, most specific
first:

1. `Config.repoSettings[repoPath].sessionDurability.scrollbackBytes`
2. `Config.workspaces[].settings.sessionDurability.scrollbackBytes`
3. `Config.sessionDurability.scrollbackBytes` (global)
4. `Config.maxScrollbackPerSessionBytes` (legacy top-level)
5. fallback to the 256 KB hard default in `pty-handler.ts`

Non-positive values are rejected with a warning; the resolver falls
through to the next layer. `resolveSessionSettings(...)` exposes the
result as `ResolvedSessionSettings.scrollbackBytes`; session creation
paths thread it into `CreateParams.maxScrollbackBytes`, which the PTY
handler persists on `PtySession.scrollbackCapacityBytes` and surfaces in
`SessionReplaySnapshot.capacityBytes` (slice 2).

Durability mode (Wave's "standard" vs "durable") is not yet a separable
knob in Relay — every Relay session is durable by construction because
tmux + node-pty keep the process alive across attach drops. The config
schema reserves the `sessionDurability` namespace so a future slice can
add a mode toggle without breaking the surface.

## Failure-matrix runbook

The five durability transitions the epic body promised. Automated coverage
lives in `test/session-durability-failure-matrix.test.ts`; manual
verification steps below for the failure modes the unit tests cannot fake.

| Scenario                              | Expected durability | Operator-visible signal                                    |
| ------------------------------------- | ------------------- | ---------------------------------------------------------- |
| Browser tab closed while session live | `running-detached`  | Tab badge flips to "detached"; reopening reattaches.       |
| Node link drops mid-session           | `stale-node`        | Badge flips to "stale node"; live input + kill disabled.   |
| Node reconnects after link drop       | `running-attached`  | Badge returns to "live"; controls re-enabled.              |
| PTY process exits (clean or crash)    | `ended` (then gone) | Badge briefly shows "ended" then session leaves the list.  |
| Agent posts an unrecoverable error    | `error`             | Badge shows "error"; controls disabled with typed reason.  |
| Permission prompt waiting             | `permission-needed` | Badge pulses; controls stay enabled so operator can reply. |

Manual verification steps for failure modes the automated suite cannot
simulate end-to-end:

- **Laptop sleep / network flap.** Pair a remote node, open a session,
  put the laptop running the hub or the node to sleep. The hub's node
  registry will flip to `stale` then `offline` within `staleMs` /
  `offlineMs`. Durability follows. On wake, the reverse link
  reconnects and durability returns to `running-attached`.
- **Hub restart.** Restart the hub while a node session is open. tmux
  keeps the PTY alive on the node. After hub comes back, the session
  list shows the session with `running-detached` until the browser
  attaches; then `running-attached`.
- **Browser refresh.** Refresh the browser tab. The WS reconnect handler
  reattaches; durability stays `running-attached` (or briefly flips
  through `running-detached` if the WS is rebuilt slowly).

## Provider-native import boundary

Provider-native session adapters complement durability replay; they do not replace it. Relay may inspect provider-owned state stores such as Claude JSONL files to derive a bounded `AgentSessionV2` read model and safe resume/open argv, but the provider store remains the source of truth for that native CLI.

Rules for this slice:

- provider stores are read-only; Relay must not write `.claude`, `.codex`, `.hermes`, `.opencode`, or equivalent native state paths;
- imported read models include an audit/divider marker with provider, source kind, import time, and content hash;
- snapshots expose hashes, sizes, event types, timestamps, and redacted previews, not raw provider rows;
- resume/open commands are copyable data only and are never executed by the adapter.

## Out of scope (later #614 slices)

- Cross-node/remote replay forwarding.
- Web-session replay redesign (existing `WebSession.messages` buffer is
  unchanged in slice 2).
- Durability mode toggle (standard vs durable).
- Live process migration. No raw infinite transcript storage.
