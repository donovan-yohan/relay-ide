# Spike: Stable Runtime Daemon Design Gate

> **Status:** Spike complete — design gate, no runtime code  
> **Scope:** Split Relay's durable session runtime from the hot-swappable web/API surface  
> **Date:** 2026-05-08  
> **Issue:** [#364](https://github.com/donovan-yohan/relay-ide/issues/364)  
> **Epic:** [#368](https://github.com/donovan-yohan/relay-ide/issues/368)

---

## tl;dr

**Recommendation: proceed, but only after introducing an in-process runtime facade first.**

Relay already has the right durable substrate: tmux owns interactive process trees, `sessions.ts` can serialize PTY metadata/scrollback to `pending-sessions.json`, and web sessions are moving into `relay-state.db`. The unstable part is that `server/index.ts` still composes Express, browser WebSockets, session registry, node-pty attachments, hooks, telemetry, watchers, browser-content tokens, update/restart handling, and route wiring in one hot process.

The daemon split should put only session-runtime ownership behind a stable private process:

- PTY/web session registry and lifecycle
- node-pty attachments to tmux
- scrollback and session-state snapshots
- web-agent adapter runtimes and `relay-state.db`
- session event bus, hook ingestion, telemetry cache, and browser-content token registry

The hot web/API server should remain the browser-facing surface: auth cookies, static frontend, REST routers, GitHub/workspace dashboards, frontend WebSocket termination, and proxying to the daemon over a private local IPC channel.

**IPC choice: Unix-domain-socket HTTP + WebSocket.** Use request/response JSON for lifecycle APIs and a daemon WebSocket stream for PTY bytes/session events. Do not use stdio: it couples lifetimes to the supervisor. Do not expose another TCP port by default: it adds auth/firewall surface for no product value.

**First implementation PR:** add an in-process `RuntimeClient` / `RuntimeHost` facade and route existing session APIs + WebSocket attach logic through it without moving processes. That creates immediate value for #363/#366 by isolating restart/recovery seams and gives the daemon PR a narrow extraction target instead of a cursed rewrite.

---

## Current runtime shape

```mermaid
flowchart LR
  Browser[Browser UI]
  Index[server/index.ts\nExpress composition root]
  WS[server/ws.ts\n/ws/events + /ws/:id]
  Sessions[server/sessions.ts\nin-memory session registry]
  Pty[server/pty-handler.ts\nnode-pty attachment]
  Tmux[tmux session\nagent CLI / shell]
  WebSession[server/web-session-handler.ts\nweb-agent adapters]
  StateDB[relay-state.db]
  Hooks[server/hooks.ts]
  Telemetry[server/telemetry.ts]
  Watchers[server/watcher.ts]
  BrowserContent[server/browser-content.ts\nin-memory tokens]

  Browser <--> Index
  Browser <--> WS
  Index --> Sessions
  WS --> Sessions
  Sessions --> Pty
  Pty <--> Tmux
  Sessions --> WebSession
  WebSession --> StateDB
  Hooks --> Sessions
  Hooks --> Telemetry
  Telemetry --> WS
  Watchers --> WS
  BrowserContent --> WS
```

The important coupling is not tmux itself; tmux already survives. The coupling is that the browser-facing process also owns the live node-pty attachments, callback arrays, hook tokens, telemetry adapter instances, web-agent adapters, and browser-content token maps.

Relevant current touch points:

| Area             | Current owner                                                                           | Evidence / file-level touch point                           | Split implication                                                                                                    |
| ---------------- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Session registry | `sessions.ts` module-level `sessions = new Map<string, Session>()`                      | `server/sessions.ts`                                        | Move behind daemon-owned runtime API; web process should not mutate session objects directly.                        |
| PTY attachment   | `pty-handler.ts` spawns `node-pty`, attaches to tmux, keeps scrollback in memory        | `server/pty-handler.ts`                                     | Daemon owns node-pty and scrollback so hot web restarts do not reset attachment or lose in-memory scrollback deltas. |
| Browser PTY WS   | `ws.ts` terminates browser WS and directly subscribes to `session.pty.onData()`         | `server/ws.ts`                                              | Web keeps browser auth/WS, but proxies bytes to daemon stream.                                                       |
| Web sessions     | `web-session-handler.ts` creates `ProtocolAdapterV2`, persists via `relay-state-db.ts`  | `server/web-session-handler.ts`, `server/relay-state-db.ts` | Daemon owns live adapters and DB writes; web queries/proxies snapshots.                                              |
| Hooks            | `hooks.ts` localhost HTTP endpoints mutate session state and telemetry                  | `server/hooks.ts`                                           | Final split needs stable hook ingress into daemon, not the hot web process.                                          |
| Telemetry        | `telemetry.ts` has module-level maps, timers, adapter instances, pending telemetry file | `server/telemetry.ts`                                       | Daemon owns telemetry polling/cache; web exposes `/telemetry` by querying daemon.                                    |
| Watchers         | `watcher.ts` owns WorktreeWatcher, BranchWatcher, RefWatcher, GitWatcher                | `server/watcher.ts`, `server/index.ts`                      | Split into session-scoped daemon watchers vs dashboard/workspace web watchers; see watcher section.                  |
| Browser content  | `browser-content.ts` has process-local scoped token and per-file token maps             | `server/browser-content.ts`                                 | Tokens must survive hot web restart by living in daemon memory or durable local state.                               |
| Auth/static/API  | Express routes, cookie auth, static serving                                             | `server/index.ts`, `server/auth.ts`                         | Stays in hot web/API server.                                                                                         |

---

## Target architecture

```mermaid
flowchart LR
  Browser[Browser UI]
  Web[Hot web/API process\nExpress + static + auth + browser WS]
  Socket[(private UDS\nrelay-runtime.sock)]
  Daemon[Stable runtime daemon]
  RuntimeState[Runtime state\nsessions + scrollback + events]
  Pty[node-pty attachments]
  Tmux[tmux sessions]
  WebAdapters[web-agent adapters]
  DB[(relay-state.db)]
  HookIngress[stable hook ingress\nlocalhost + token]
  Telemetry[telemetry cache/adapters]
  Tokens[browser-content token registry]

  Browser <--> Web
  Web <--> Socket
  Socket <--> Daemon
  Daemon --> RuntimeState
  Daemon --> Pty
  Pty <--> Tmux
  Daemon --> WebAdapters
  WebAdapters --> DB
  HookIngress --> Daemon
  Daemon --> Telemetry
  Daemon --> Tokens
```

### Minimal daemon responsibilities

The daemon should be boring and small. Its job is to preserve runtime continuity, not to become a second application server.

The daemon owns:

1. **Runtime identity**
   - session ids
   - session summaries
   - live state (`agentState`, `BackendDisplayState`, `idle`, `currentActivity`)
   - branch/display-name metadata that is attached to a session
2. **PTY runtime**
   - `node-pty` processes
   - tmux attach/spawn decisions
   - PTY writes/resizes
   - scrollback FIFO and disk checkpointing
   - PTY exit cleanup
3. **Web-agent runtime**
   - `ProtocolAdapterV2` instances
   - web session snapshots and patches
   - `relay-state.db` writes, flushes, restores, archive status
4. **Runtime event bus**
   - session created/ended
   - session backend state changed
   - PTY data stream availability
   - web-agent patch stream
   - session activity and telemetry events
5. **Stable agent ingress**
   - hook callbacks or a hook-forwarding protocol
   - per-session hook-token validation
   - branch-rename side effects that depend on session state
6. **Telemetry cache**
   - session telemetry adapters and polling timers
   - account telemetry snapshots
   - pending telemetry file if retained during migration
7. **Browser-content token registry**
   - long-lived scoped token used by `relay-ide browser`
   - per-file token -> baseDir/filePath mapping
   - token TTL cleanup

The daemon should not own:

- browser cookie auth, PIN setup, or static frontend serving
- GitHub OAuth, webhook setup, Smee lifecycle, org dashboard aggregation
- full workspace CRUD and settings UI
- production service installation/update commands
- frontend HMR or Vite serving
- arbitrary GitHub/Jira/Linear integration polling except when a session event needs to emit a ticket transition

Those can restart freely or can reconstruct state from config/GitHub/SQLite.

---

## IPC choice

### Recommendation

Use **Unix-domain-socket HTTP + WebSocket** for macOS/Linux:

- socket path: `${configDir}/runtime/relay-runtime.sock`
- mode: `0600`
- auth: random runtime token in `${configDir}/runtime/runtime-token` with `0600`, sent as `Authorization: Bearer <runtime-token>` from the web process
- API prefix: `/v1/...`
- request/response: JSON over HTTP
- streams: WebSocket over UDS for PTY bytes, web-agent patches, and event bus subscription

Example surface:

| Method / stream                            | Purpose                                                |
| ------------------------------------------ | ------------------------------------------------------ |
| `GET /v1/health`                           | daemon readiness, protocol version, config dir         |
| `GET /v1/sessions`                         | replacement for `sessions.list()`                      |
| `POST /v1/sessions/pty`                    | create PTY session                                     |
| `POST /v1/sessions/web`                    | create web session                                     |
| `PATCH /v1/sessions/:id`                   | rename/update display metadata                         |
| `DELETE /v1/sessions/:id`                  | kill/archive session                                   |
| `POST /v1/sessions/:id/input`              | PTY write or web-agent command                         |
| `POST /v1/sessions/:id/resize`             | PTY resize                                             |
| `GET /v1/sessions/:id/snapshot`            | PTY scrollback or web-agent snapshot                   |
| `WS /v1/sessions/:id/stream`               | PTY bytes or web-agent patches                         |
| `WS /v1/events`                            | session/backend-state/telemetry/browser-content events |
| `POST /v1/hooks/:sessionId/:event`         | hook forwarding if hot web remains ingress             |
| `POST /v1/browser-tabs`                    | create/reuse browser-content token                     |
| `GET /v1/browser-content/resolve/:token/*` | validate token and return resolved file path metadata  |

### Why not the alternatives

| Option                      | Verdict                | Reason                                                                                                                           |
| --------------------------- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| stdio child protocol        | reject                 | It couples daemon lifetime to the hot web process or supervisor and makes independent recovery awkward.                          |
| extra localhost TCP port    | avoid by default       | Easier to debug, but creates another port/auth/firewall surface and collision problem. Useful only as an opt-in debug transport. |
| gRPC                        | reject for now         | Adds codegen and HTTP/2 operational weight without a current cross-language need.                                                |
| SQLite-only command queue   | reject for primary IPC | Fine for snapshots, bad for PTY byte streams and low-latency input/resize.                                                       |
| direct browser -> daemon WS | reject                 | Browser auth, TLS/origin policy, and UI routing should remain in the web/API process. Keep daemon private.                       |

---

## State ownership contract

| State                         | Owner after split                                           | Persistence                                  | Notes                                                                                                       |
| ----------------------------- | ----------------------------------------------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Config (`config.json`)        | web/API primary, daemon read-only snapshot + reload command | JSON config file                             | Web remains settings authority; daemon receives the subset needed for session runtime.                      |
| PIN/cookie auth               | web/API                                                     | config + in-memory authenticated token set   | Daemon trusts only web process via UDS bearer token.                                                        |
| PTY session records           | daemon                                                      | daemon memory + checkpoint                   | Current `pending-sessions.json` can remain as migration format, then fold into `relay-state.db` later.      |
| PTY scrollback                | daemon                                                      | memory + scrollback files or DB blob         | Keep 256KB cap; daemon can stream replay without web process involvement.                                   |
| tmux process tree             | tmux                                                        | tmux server                                  | Daemon owns attach/spawn/kill policy; tmux remains the durable process substrate.                           |
| Web sessions                  | daemon                                                      | `relay-state.db`                             | Existing DB is already the right destination; daemon should be sole writer.                                 |
| Runtime events                | daemon                                                      | in-memory fanout; optional short replay ring | Web subscribes and rebroadcasts to browser. Add sequence ids if #365 needs missed-event recovery.           |
| Telemetry                     | daemon                                                      | memory + pending telemetry file initially    | Later fold pending telemetry into DB if repeated restarts need stronger guarantees.                         |
| Browser-content tokens        | daemon                                                      | memory while daemon is alive                 | Hot web restarts keep tokens valid. Daemon restart can invalidate tokens; browser can reopen via event/CLI. |
| Workspace dashboard/git state | web/API                                                     | recompute/cache                              | Safe to restart; stale caches can be rebuilt.                                                               |
| GitHub webhooks/smee          | web/API                                                     | config + GitHub                              | Not session-durable; keep out of runtime daemon.                                                            |

The key rule: **the web process should never hold the canonical `Session` object after the split.** It holds DTOs and stream handles only.

---

## Hooks implications

Current Claude hooks post to `http://127.0.0.1:<relay-port>/hooks/...` and authenticate with a per-session token. That is too coupled to the hot web process.

Recommended final shape:

1. Daemon starts a stable loopback hook ingress server, separate from the browser-facing web/API port.
2. `pty-handler.ts` hook settings generation moves into daemon-owned PTY creation and points hooks at that stable ingress base URL.
3. Hook ingress keeps current protections:
   - localhost-only
   - per-session token
   - timing-safe token comparison
   - JSON payload limit
4. Hot web/API may retain `/hooks` temporarily as a compatibility forwarder to daemon IPC, but new sessions should get daemon hook URLs once daemon extraction starts.

Why not UDS-only hooks: the agent hook mechanism is process/CLI oriented and current settings are URL based. A tiny daemon-owned localhost listener keeps hook delivery simple without exposing the full browser API.

Migration note: #363 can still use the existing web `/hooks` route during supervised restart work. #364's daemon split should not block #363.

---

## Telemetry implications

Telemetry currently has daemon-shaped state already: module-level maps, polling timers, per-session adapters, and pending telemetry persistence.

Move telemetry into the runtime daemon because telemetry is session-adjacent and should not reset on hot web/API restarts. The web/API server should expose the existing `/telemetry` routes by calling daemon IPC or by caching daemon events for UI reads.

Required adjustments:

- `startTelemetry(deps)` becomes daemon boot wiring.
- `TelemetryDeps.getActiveSessions()` reads daemon session memory directly.
- `forwardHookEvent()` stays local to daemon hook handling.
- `/telemetry/session/:id` and `/telemetry/account` become web proxies to `GET /v1/telemetry/...` or use event-cache snapshots.
- Pending telemetry should either remain `pending-telemetry.json` for phase 1 or become a table in `relay-state.db` when #366 hardens repeated restart persistence.

---

## Web-session implications

Web sessions are not optional in the split. They have durable runtime too:

- live `ProtocolAdapterV2` instances
- provider session ids
- active turn state
- approval/input waits
- patch streams
- `relay-state.db` writes

The daemon owns `createWebSession()`, `reconnectWebSession()`, `applyWebSessionPatchV2()`, and `relay-state-db.ts` writes. Browser-facing `/ws/:sessionId` remains in the web process, but for `mode: web` it proxies daemon patch streams rather than subscribing to an in-process adapter.

Operational caveat: provider resume is still best-effort. If a web adapter cannot resume after daemon restart, the daemon should preserve the current recoverable failure behavior: append a client-source error item and mark the session disconnected.

---

## Watcher implications

Do not move all watchers just because they exist.

| Watcher           | Current purpose                                                 | Recommended owner | Reason                                                                                                                                                   |
| ----------------- | --------------------------------------------------------------- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WorktreeWatcher` | Broadcast worktree list changes                                 | web/API initially | Derived workspace UI state; can rebuild after web restart.                                                                                               |
| `GitWatcher`      | Changed-file sidebar events for active workspaces               | web/API initially | UI cache invalidation, not runtime continuity.                                                                                                           |
| `RefWatcher`      | PR/CI auto-refresh on upstream ref changes                      | web/API           | Dashboard/PR surface, not session runtime.                                                                                                               |
| `BranchWatcher`   | Detect branch switches and update session branch/display events | split             | Session branch changes affect runtime metadata; daemon should either own session-scoped branch watching or accept branch-update events from web watcher. |

First daemon phase: leave watchers in web/API and forward any session-affecting branch updates to daemon (`POST /v1/sessions/:id/branch`). Final phase: daemon owns only the branch watches for active session cwd/worktree paths. Web remains free to watch broader workspace/dashboard state.

---

## Browser-content token implications

`server/browser-content.ts` is currently restart-fragile:

- `scopedToken` is process-local.
- `tokenStore` and `pathToToken` are process-local.
- `/browser-tabs` both validates the scoped token and broadcasts browser tab events.

After split:

1. Daemon owns the scoped token and per-file token maps.
2. PTY/web session spawn env (`RELAY_IDE_BROWSER_*`) uses the daemon-minted scoped token.
3. Hot web `/browser-tabs` validates by forwarding to daemon `POST /v1/browser-tabs`.
4. Hot web `/browser-content/:token/*` asks daemon to resolve token + relative path, then serves the file itself with the existing realpath traversal checks preserved.
5. Daemon emits `browser-tab-opened` / `browser-tab-refreshed`; web rebroadcasts to browser clients.

This keeps tokens valid through hot web restarts while avoiding a public daemon file server.

---

## Migration phases

### Phase 0 — current epic work, no daemon dependency

Keep #362 HMR and #363 supervised backend restart moving. Use existing `serializeAll()` / `restoreFromDisk()` and tmux reattach. This spike should not block those tickets.

### Phase 1 — in-process runtime facade (first PR)

Add a narrow runtime boundary while everything remains in one process:

- `server/runtime/types.ts`
- `server/runtime/in-process-runtime.ts`
- `server/runtime/client.ts` or a lightweight `RuntimeClient` interface
- update `server/index.ts`, `server/ws.ts`, and session routes to depend on the interface instead of importing/mutating `sessions` directly where practical

Acceptance for Phase 1:

- no behavior change
- existing tests still pass
- `ws.ts` attaches to a runtime stream abstraction instead of direct `session.pty.onData()` where feasible
- session DTOs are explicitly separated from mutable runtime objects

This PR creates value immediately by making #363/#366 less fragile and making later daemon extraction mechanical.

### Phase 2 — harden restart checkpoints and runtime observability

Fold into or coordinate with #366:

- add restart reason codes (`update`, `dev-supervisor`, `crash-recovery`, `daemon-shutdown`)
- make checkpoint writes explicit and logged
- add stale-file tests around rapid repeated restarts
- add a runtime health snapshot endpoint, even in-process
- add event sequence ids if frontend reconnect needs missed-event replay

### Phase 3 — supervised backend restart

Fold into #363:

- supervisor restarts hot web/API process
- sessions still survive via current serialize/restore path
- browser reconnect behavior gets shaped enough for #365
- daemon is not required yet

### Phase 4 — extract daemon process behind same facade

Add `server/runtime-daemon.ts` and UDS transport implementation:

- daemon boots session runtime, relay-state DB, telemetry, hook ingress, browser-token registry
- web/API starts or connects to daemon in dev/self-hosting mode
- web/API routes and browser WebSockets call the same `RuntimeClient` interface over IPC
- retain in-process runtime as fallback/test implementation

### Phase 5 — move stable ingress and session-adjacent services

- generate hooks settings pointing to daemon hook ingress
- move telemetry polling fully daemon-side
- move browser-content token generation/validation daemon-side
- optionally move session-scoped branch watching daemon-side

### Phase 6 — retire compatibility paths

- remove hot web process as a hook owner for new sessions
- reduce `pending-sessions.json` to daemon shutdown recovery only or migrate PTY snapshots into `relay-state.db`
- document daemon lifecycle in #367 self-hosting mode

---

## File-level touch points

| File / new module                         | Expected change                                                                                                 |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `server/runtime/types.ts`                 | New DTOs, command types, stream event types, protocol version.                                                  |
| `server/runtime/in-process-runtime.ts`    | Wrap current `sessions.ts`, `pty-handler.ts`, `web-session-handler.ts` behavior without process split.          |
| `server/runtime/ipc-client.ts`            | UDS HTTP/WS client used by hot web process after extraction.                                                    |
| `server/runtime/ipc-server.ts`            | Daemon transport adapter exposing runtime API.                                                                  |
| `server/runtime-daemon.ts`                | Stable process composition root for runtime-only services.                                                      |
| `server/index.ts`                         | Stop being the owner of session runtime; wire web routes to `RuntimeClient`. Keep auth/static/workspace/GitHub. |
| `server/ws.ts`                            | Browser WS remains here, but PTY/web session bytes and patches come from runtime streams.                       |
| `server/sessions.ts`                      | Becomes daemon-internal after Phase 4; exports should shrink to runtime-host use.                               |
| `server/pty-handler.ts`                   | Becomes daemon-internal; hook URL generation uses daemon hook ingress.                                          |
| `server/web-session-handler.ts`           | Becomes daemon-internal; sole owner of live adapters.                                                           |
| `server/relay-state-db.ts`                | Daemon-only writer; web never writes web-session rows.                                                          |
| `server/hooks.ts`                         | Either daemon-owned router or web compatibility forwarder.                                                      |
| `server/telemetry.ts`                     | Daemon-owned timers/cache; web routes proxy reads.                                                              |
| `server/watcher.ts`                       | Keep dashboard watchers in web; move or forward session branch updates.                                         |
| `server/browser-content.ts`               | Split token registry (daemon) from file serving (web).                                                          |
| `bin/relay-ide.ts`                        | Later: command/supervisor wiring for daemon lifecycle and self-hosting mode.                                    |
| `docs/ARCHITECTURE.md` / `docs/DESIGN.md` | Update only when daemon implementation lands, not for this spike PR unless desired by reviewer.                 |

---

## Follow-up issue adjustments

Existing issue scopes are mostly right; adjust sequencing and first-slice wording rather than opening duplicate issues.

| Issue                                                                                    | Recommendation                                                                                                                                                                 |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [#363](https://github.com/donovan-yohan/relay-ide/issues/363) supervised backend restart | Keep as pre-daemon work. Add a note that it should use current serialize/restore and should not attempt daemon extraction. It should shape restart events for #365.            |
| [#366](https://github.com/donovan-yohan/relay-ide/issues/366) recovery hardening         | Expand acceptance to include a runtime health/checkpoint seam that Phase 1 daemon facade can call. This becomes the backend reliability prerequisite.                          |
| [#365](https://github.com/donovan-yohan/relay-ide/issues/365) frontend reconnect state   | Add explicit dependency on restart event semantics from #363/#366, not on the daemon split. Frontend should work with both current restore and future daemon stream reconnect. |
| [#367](https://github.com/donovan-yohan/relay-ide/issues/367) self-hosting mode          | Defer daemon lifecycle docs until after Phase 4; initial self-hosting can document supervised restart + HMR only.                                                              |

Proposed new follow-up if the team wants a dedicated first slice instead of expanding #366:

> `backend: introduce runtime facade before daemon extraction`  
> Add `RuntimeClient` / in-process runtime host, route session creation/list/kill and WS attach through it, separate mutable `Session` objects from browser-facing DTOs, and keep behavior unchanged. This is the first implementation PR identified by #364.

---

## Non-goals

- No true in-process Express/module HMR. Supervised process restart is the supported backend dev loop.
- No browser-facing daemon port.
- No multi-host/federated runtime. That belongs with [#317](https://github.com/donovan-yohan/relay-ide/issues/317), not this daemon split.
- No replacement for tmux as the process substrate.
- No attempt to move every GitHub/workspace/dashboard integration into the daemon.
- No production service manager rewrite in the first daemon PR.
- No compatibility promise that browser-content tokens survive daemon restart; hot web restart survival is the target.

---

## Risks and mitigations

| Risk                                           | Mitigation                                                                                         |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| The daemon becomes a second monolith           | Keep scope to session runtime; leave GitHub/workspace/static/auth in web/API.                      |
| IPC adds latency to PTY input                  | Use one long-lived WS stream per attached browser session; avoid HTTP per byte.                    |
| Hook delivery still drops during web restart   | Move hook URL generation to daemon hook ingress before calling daemon split complete.              |
| Session DTOs drift from internal `Session`     | Introduce typed runtime DTOs in Phase 1 and test serialization.                                    |
| Browser reconnect misses events during restart | Add sequence ids/replay ring only if #365 needs it; do not build Kafka in a trenchcoat.            |
| SQLite writer contention                       | Make daemon sole writer for `relay-state.db`; web reads via daemon or read-only snapshots.         |
| Dev daemon orphaning                           | Store daemon pid/socket/token under config dir; supervisor health-checks and cleans stale sockets. |

---

## Design gate verdict

**Verdict: VALIDATED.** Relay can split durable session runtime from hot web/API without a ground-up rewrite if the team first introduces an in-process runtime facade and keeps daemon scope aggressively small.

**Build first:** `backend: introduce runtime facade before daemon extraction`.

**Do not wait on this for:** #362 frontend HMR or #363 supervised backend restart. Those are useful pre-daemon steps and will generate better recovery requirements for the daemon extraction.
