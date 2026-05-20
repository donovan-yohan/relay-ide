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

The existing WebSocket attach path keeps streaming raw scrollback bytes to
xterm clients — this REST snapshot is a separate, optional read for status
cards, agent adapters, and reattach UX that need a typed view.

## Out of scope (later #614 slices)

- Reconnect UX badges (slice 3).
- Cross-node/remote replay forwarding (slice 3).
- Web-session replay redesign (existing `WebSession.messages` buffer is
  unchanged in slice 2).
- Per-node/per-connection/per-session durability config knobs (slice 4).
- Live process migration. No raw infinite transcript storage.
