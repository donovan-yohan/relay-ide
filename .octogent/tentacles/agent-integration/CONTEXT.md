# agent-integration

Multi-agent framework layer: protocol adapters, output parsers, telemetry, hooks, web-chat, agent browser.

## Scope

- `server/protocol-adapter.ts` — `ProtocolAdapter` interface + `AdapterConfig`, `SessionOptions`, `Attachment`, `ChatEventHandler` types. The contract every agent backend implements.
- `server/protocol-adapters/` — concrete `claude`, `codex`, `opencode`, and `mock` adapters; `index.ts` exposes the `createAdapter(agentType)` factory plus `base-hook-adapter.ts`/`adapter-utils.ts` helpers.
- `server/output-parsers/` — vendor-extensible terminal output parser registry (`claude-parser.ts`, `codex-parser.ts`, `opencode-parser.ts`, `null-parser.ts`, `types.ts`); `index.ts` exports `outputParsers` keyed by `AgentFramework.parserType`.
- `server/adapters/` — framework-neutral **telemetry** adapters (`claude-telemetry.ts`, `codex-telemetry.ts`, `opencode-telemetry.ts`) that self-register via side-effect imports in `telemetry.ts`.
- `server/telemetry.ts` — telemetry bus: 2 s poll, 60 s persist, pending-telemetry file, `forwardHookEvent()`, Express Router.
- `server/telemetry-adapter.ts` — abstract `TelemetryAdapter` + `getAdapterForFramework()` registry.
- `server/hooks.ts` — localhost-only Claude Code hook HTTP endpoints with per-session token auth. Routes: `/hooks/{stop,notification,prompt-submit,session-end,tool-use,tool-result}`. Owns debounced branch rename and `fireBackendStateIfChanged` via `HookDeps` injection.
- `server/codex-hooks-adapter.ts` — writes Codex CLI hook config into a session-scoped config dir so Codex hook payloads route into the same pipeline as Claude hooks.
- `server/agent-events.ts` — canonical `AgentEvent` type + in-memory `AgentEventAdapter` (pub/sub). Event kinds: `session.*`, `prompt.submitted`, `tool.*`, `permission.*`, `telemetry.updated`, `state.changed`.
- `server/web-session-handler.ts` — creates `WebSession`s for the unified web chat (non-PTY). 1000-event ring buffer with **approval-preserving eviction** (non-approval events evicted first; approvals only drop as last-resort FIFO).
- `server/opencode-relay.ts` — OpenCode transport relay (WebSocket/SSE proxy between web sessions and the OpenCode CLI); `installOpenCodeRelayPlugin()` bootstraps.
- `server/agent-browser.ts` — Playwright Chromium automation (`launchBrowser`, `screenshot`, `validatePage` with console-error collection, `closeBrowser`). Playwright is a soft dependency — missing binary produces a helpful error via `ensurePlaywright()`.
- `shared/chat-events.ts` — canonical `ChatEvent` wire protocol (text-delta, message-complete, reasoning, compaction, tool-call, approval-request/response, error). `ChatEventSource` includes `claude | codex | opencode | mock | hermes`.

## Key Decisions

- **Two canonical event types, not one.** `AgentEvent` covers session lifecycle; `ChatEvent` covers streaming content, tool calls, approvals. The header of `shared/chat-events.ts` is explicit: "ChatEvent is a SIBLING to AgentEvent — not a subtype." Don't collapse them.
- **Adapters own transport, relay-ide owns protocol.** Browsers never talk to agent backends directly — each adapter connects to its own process/server and emits `ChatEvent`s over the event bus (see header of `server/protocol-adapter.ts`).
- **Side-effect imports for registry wiring.** `telemetry.ts` imports `./adapters/claude-telemetry.js` etc. purely for registration side effects. Renaming or removing a side-effect import silently drops adapter coverage — there is no build-time guarantee.
- **Output parsers are isolated.** `output-parsers/` may import `types.ts` only; it MUST NOT reach into `utils.ts` or any other server module (`docs/ARCHITECTURE.md` line 74). `NullOutputParser` lets frameworks opt out via `parserType: 'none'`, falling back to timer-based idle detection in `pty-handler.ts`.
- **Hooks are localhost-only with per-session tokens.** `hooks.ts` gates on `LOCALHOST_ADDRS` (`127.0.0.1`, `::1`, `::ffff:127.0.0.1`) and validates a `hookToken` minted per session. `HookDeps` injection keeps the module from statically coupling to sessions/git/config/analytics/telemetry/push.
- **Approval preservation in the web-chat buffer.** `pushToBuffer` in `web-session-handler.ts` evicts non-approval events first when the 1000-event cap is hit; approvals only drop if the entire buffer is approvals (pathological case).
- **Branch rename is debounced.** `scheduleBranchCheck` in `hooks.ts` uses a trailing-edge 1 s debounce; rename-retry delay is 5 s.

## Conventions

- New agent framework? Add four things, in order: (1) entry in `server/types.ts` `AgentFramework`, (2) output parser in `server/output-parsers/` registered in `outputParsers`, (3) protocol adapter in `server/protocol-adapters/` registered in `adapters`, (4) telemetry adapter in `server/adapters/` with a side-effect import in `telemetry.ts`. Add the literal to `ChatEventSource` in `shared/chat-events.ts`.
- `AgentEvent.source` and `ChatEvent.source` must use the same string literal for a framework — the frontend dedupes on source.
- Hook payloads must carry a valid per-session `hookToken` — never trust `sessionId` alone.
- `agent-browser.ts` must stay optional: guard Playwright usage behind `ensurePlaywright()` so a missing Chromium binary produces `MISSING_BINARY_MESSAGE`, not a crash.
- Parser registry keys must match `AgentFramework.parserType` exactly (including `'none'` for opt-out).

<!-- octogent:suggested-skills:start -->

## Suggested Skills

You can use these skills if you need to.

- `investigate`
- `review`
- `codex`
- `qa`
<!-- octogent:suggested-skills:end -->
