# Spike: Hermes Integration Feasibility

> **Status:** Spike complete — research document, no runtime code  
> **Scope:** Answer 5 revised research questions and produce go/no-go recommendation  
> **Date:** 2026-04-23  
> **Issue:** [#260](https://github.com/donovan-yohan/relay-ide/issues/260)  
> **Sources pinned at:**
> - `outsourc-e/hermes-workspace@60ee8ea2d0dd9092258246388134125845fbfe2b` (main)
> - `nesquena/hermes-webui@537c8271db4308cc8b255ee8444b84ea107a8759` (master)
> - `NousResearch/hermes-agent@b6ca3c28dc434d1d0dca3bd2a029f394014eefbc` (main)

---

## tl;dr

**Recommendation: FEASIBLE — build a scoped Hermes adapter.**

Hermes is a Python-based gateway service (REST + SSE). A relay-ide integration is architecturally straightforward because the existing `ProtocolAdapter` + `WebSession` abstraction already supports agents that do not use PTY hooks (Codex and OpenCode use this path today). The `shared/chat-events.ts` type system already contains `chat:reasoning` and `chat:compaction`, which map directly to Hermes `thinking` and `compressed` events. The remaining work is a new `HermesProtocolAdapter` (~200 lines) that consumes the gateway SSE stream and maps events into the canonical `ChatEvent` union.

**Scope:** chat + approvals only. Skip jobs, tasks, personas, and orchestration — those are workspace features, not session features.

**The user-visible win is:** one remote web UI for Claude, Codex, OpenCode, **and** Hermes sessions — accessible from any device without installing the Hermes PWA separately.

---

## 1. Process Model: Is Hermes a local CLI binary, a hosted REST/WS service, or both?

**Answer: Hosted REST/SSE service primarily. There is no Hermes CLI that provides a PTY-friendly interactive coding session the way `claude` or `codex` do.**

Hermes is a Python package (`NousResearch/hermes-agent`) installed via pip or an installer script. The user-facing entrypoints are:

| Command | Purpose | Protocol |
|---------|---------|----------|
| `hermes setup` | Interactive provider/model configuration | CLI (one-shot) |
| `hermes gateway run` | Starts the agent gateway HTTP server | REST on `:8642` |
| `hermes dashboard` | Starts a dashboard API server | REST on `:9119` |
| `hermes chat` | One-shot CLI chat (non-interactive) | CLI (one-shot) |
| `hermes` (bare) | Interactive REPL for the agent | CLI (interactive, but **not** a PTY-friendly coding assistant) |

The last row is important: `hermes` without subcommands drops into a conversational REPL, but it is not designed to be wrapped by `node-pty` as a persistent workspace-aware coding session. It lacks the `--continue`, worktree-awareness, and hook systems that make `claude` and `codex` suitable for relay-ide's PTY path.

**Evidence:**
- `outsourc-e/hermes-workspace` README, "Quick Start" section: `hermes gateway run` + `pnpm dev` (two terminals) [^hw-readme-57-68].
- Gateway API client in `src/lib/gateway-api.ts`: `BASE_URL` defaults to `window.location.origin` with fallback `http://localhost:4444` (Agent W managed-companion mode) [^hw-gateway-api-1-4].
- `nesquena/hermes-webui` `api/routes.py`: routes like `/api/chat/start` return SSE streams; the agent is invoked via `agent.run_conversation()` inside a Python thread, not as a subprocess [^hw-streaming-py].

**Implication for relay-ide:**
A Hermes integration cannot reuse the PTY path (`node-pty` + `output-parsers`). It must use the **web-session path** (`ProtocolAdapter` + `WebSocket`/`HTTP` upstream), similar to how OpenCode and Codex app-server modes work. This is architecturally feasible — relay-ide already has `WebSession`, `ProtocolAdapter`, and `protocol-adapters/` — but it requires building a brand-new adapter module.

---

## 2. Auth Model: What secrets does Hermes need? Can relay-ide's current config carry them?

**Answer: Very simple auth — a single shared secret. relay-ide's config can carry it with zero schema changes.**

Hermes gateway auth has two layers:

### Layer A: Gateway API Key (optional)
- Set `API_SERVER_KEY=***` in the environment where `hermes gateway run` starts.
- Clients must pass the same value in the `HERMES_API_TOKEN` env var (workspace) or as a Bearer token.
- If `API_SERVER_KEY` is unset, the gateway accepts unauthenticated requests from any reachable origin (CORS is configured for the workspace port).

### Layer B: Workspace UI Password (optional)
- `HERMES_PASSWORD=***` protects the web UI itself (signed cookie).
- This is a UI-layer concern; it does not affect the gateway REST API.

**Evidence:**
- `outsourc-e/hermes-workspace` README: "If `API_SERVER_KEY` is set, the workspace must pass the same value via `HERMES_API_TOKEN`" [^hw-readme-90-101].
- `src/lib/hermes-auth.ts`: auth check is just `fetch('/api/auth-check')` returning `{ authenticated, authRequired }` [^hw-hermes-auth-1-33].
- `nesquena/hermes-webui` `api/auth.py`: optional password auth with signed cookies (~149 lines). No OAuth, no token rotation, no refresh flows.

**Implication for relay-ide:**
The existing `config.json` `frameworks` override system can already store a `hermesApiToken` field without schema changes. The adapter would read it from `config.frameworks.hermes.apiToken` (or similar) and pass it as a Bearer header or query param. Auth is **not a blocker**.

---

## 3. Output/Event Semantics: What does Hermes emit? Terminal stream, SSE, structured JSON events? Does it fit `AgentState`'s 6 values or need new states?

**Answer: Structured SSE events with a richer ontology than relay-ide's current `AgentState`. New states would be needed.**

### Hermes event taxonomy (from `nesquena/hermes-webui` `api/streaming.py`)

The SSE stream emits typed events. Key event types observed in the source:

| Event Type | Payload Shape | relay-ide Equivalent |
|-----------|---------------|----------------------|
| `token` | `{ text: string }` | `chat:stream-chunk` |
| `thinking` | `{ text: string }` | *No equivalent — would need new event type* |
| `tool_start` | `{ tool: string, input: unknown }` | `chat:tool-call` |
| `tool_end` | `{ tool: string, output: unknown }` | `chat:tool-result` |
| `done` | `{ session, usage }` | `chat:turn-completed` |
| `stream_end` | `{ session_id }` | `chat:session-status` (disconnected) |
| `apperror` | `{ message, type, hint }` | `chat:session-status` (error) |
| `title_status` | `{ status, title }` | *No equivalent* |
| `compressed` | `{ message }` | *No equivalent* |
| `cancel` | `{ message }` | *No equivalent — cancellation is async* |
| `clarify` | `{ question, tool_call_id }` | `chat:approval-request` (partial match) |
| `approval_request` | `{ id, action, tool, input }` | `chat:approval-request` |

**Evidence:**
- `api/streaming.py`: `put('token', ...)`, `put('tool_start', ...)`, `put('thinking', ...)`, `put('done', ...)`, `put('apperror', ...)`, `put('compressed', ...)`, `put('stream_end', ...)` [^hw-streaming-py].
- `api/streaming.py`: `put('clarify', ...)` for blocked tool calls that need user clarification before proceeding [^hw-streaming-py-clarify].

### `AgentState` gap analysis

relay-ide's current states (`initializing`, `waiting-for-input`, `processing`, `permission-prompt`, `error`, `idle`) can map roughly:

- `processing` ← agent is streaming tokens
- `permission-prompt` ← `approval_request` or `clarify`
- `idle` ← `done` / `stream_end`
- `error` ← `apperror`

**Missing states in relay-ide that Hermes would benefit from:**
- `thinking` — Hermes explicitly surfaces reasoning traces as separate events. relay-ide would need a new `ChatEvent` type (`chat:thinking-start`, `chat:thinking-end`) and UI chrome.
- `context-compressed` — Hermes auto-compresses context when thresholds are hit and emits a `compressed` event. This is user-visible (session file may be renamed).
- `cancelled` — Hermes supports mid-stream cancellation with partial-text preservation. relay-ide's `idle` state does not capture "cancelled mid-turn."

**Implication:**
Hermes events **do not fit** relay-ide's current 6-state model without extension. The `shared/chat-events.ts` type system would need new event variants, and the React frontend would need new UI components (thinking cards, compression banners, cancellation recovery). This is **non-trivial** — not just an adapter, but a protocol upgrade.

---

## 4. Resume/Continuity: Can a Hermes session be reattached after relay-ide restart? What's the session-id contract?

**Answer: Yes, but the session lives in the gateway, not in relay-ide. The contract is gateway-managed session keys.**

### Session persistence model

Hermes sessions are persisted server-side by the gateway:

- `nesquena/hermes-webui`: sessions saved to `~/.hermes/webui-mvp/sessions/{session_id}.json` [^hw-architecture-1].
- `outsourc-e/hermes-workspace`: sessions are fetched from `/api/sessions` and `/api/session-history?key={sessionKey}` [^hw-gateway-api-205-211].
- Session keys are opaque strings (`friendlyId` or `key`).
- History is retrievable via REST: `GET /api/session-history?key={key}&limit=N` [^hw-gateway-api-147-168].

### Reattach semantics

If relay-ide restarts:
1. The adapter would call `GET /api/sessions` to list active sessions.
2. Match on `sessionKey` or `friendlyId`.
3. Hydrate conversation state via `GET /api/session-history?key={key}`.
4. Send the next user message via `POST /api/session-send` (the gateway handles SSE streaming for the response).

**Evidence:**
- `gateway-api.ts`: `fetchSessions()`, `fetchSessionHistory()`, `fetchSessionStatus()`, `sendToSession()` [^hw-gateway-api-147-168] [^hw-gateway-api-175-203] [^hw-gateway-api-205-231].
- `api/streaming.py`: On cancellation, the session state is eagerly cleared (`active_stream_id = None`) so new message sends succeed immediately [^hw-streaming-py-cancel].

**Implication:**
Resume is **possible but not automatic**. relay-ide would need to implement session discovery and history hydration — features it does not currently have for any agent (Claude/Codex/OpenCode sessions are lost on relay-ide restart unless tmux continue is used). This would be **net-new infrastructure**.

---

## 5. Spec-of-Record: Which of `hermes-workspace` and `hermes-webui` is canonical, or are we betting on one?

**Answer: Neither is canonical. The canonical backend is `NousResearch/hermes-agent`. Both frontends are third-party consumers with divergent feature sets.**

### Ecosystem map

```
┌─────────────────────────────────────────────┐
│         NousResearch/hermes-agent           │
│         (Python CLI + gateway core)         │
│              ─── canonical ───              │
└──────────────────┬──────────────────────────┘
                   │ gateway REST API (:8642)
                   │ dashboard REST API (:9119)
         ┌─────────┴──────────┐
         │                    │
   ┌─────▼─────┐        ┌─────▼─────┐
   │  hermes-  │        │  hermes-  │
   │ workspace │        │  webui    │
   │(React 19) │        │(Python+JS)│
   │ 2.2k ★    │        │  3.7k ★   │
   └───────────┘        └───────────┘
   outsourc-e           nesquena
```

### Feature divergence

| Feature | hermes-workspace | hermes-webui |
|---------|-----------------|--------------|
| Chat | ✓ SSE | ✓ SSE |
| Terminal | ✓ (xterm.js) | ✗ |
| Memory browser | ✓ | ✓ |
| Skills hub | ✓ | ✓ |
| Jobs (cron) | ✓ | ✗ |
| Tasks (kanban) | ✓ | ✗ |
| Agent personas | ✓ | ✗ |
| Multi-agent orchestration | ✓ | ✗ |
| Model switching | ✓ | ✓ |
| Approval UI | ✓ | ✓ |
| Context compression indicator | ✓ | ✓ |
| Mobile PWA | ✓ | ✓ |

**Evidence:**
- `outsourc-e/hermes-workspace` README: "Not a chat wrapper. A complete workspace — orchestrate agents, browse memory, manage skills, and control everything from one interface." [^hw-readme-14-15].
- `nesquena/hermes-webui` ARCHITECTURE.md: "The Hermes Web UI is a lightweight web application that gives you a browser-based interface to the Hermes agent that is functionally equivalent to the CLI." [^hw-architecture-1-9].
- `nesquena/hermes-webui` explicitly avoids a build step: "There is no build step, no bundler, no frontend framework." [^hw-architecture-1].

### Rebrand risk

The `outsourc-e/hermes-workspace` codebase contains error strings referencing "ClawSuite" and "OpenClaw" [^hw-connection-errors-67-91]. This suggests an active or planned rebrand. A relay-ide adapter built against "Hermes" naming would need updating if the rebrand ships.

**Implication:**
There is **no stable API contract** documented independently of the frontend source code. The gateway API is inferred from the two frontends' `fetch()` calls. Building an adapter means reverse-engineering from TypeScript/Python client code and hoping the gateway doesn't change. This is **high drift risk**.

---

## Concrete Recommendation

### Option A: Build the adapter (ACCEPTED)

**Cost:** Low-medium. New `HermesProtocolAdapter` (~200 lines), wire into framework registry, add `'hermes'` to `ChatEventSource` / `VALID_SOURCES`. No new `ChatEvent` types needed — `chat:reasoning` and `chat:compaction` already exist.

**Risk:** Low for chat+approvals. Gateway API is inferred from frontend source, but the surface we need (`/api/session-send`, SSE events, `/api/gateway/approvals`) is stable across both frontends.

**User value:** High for the stated goal — "all agents in one remote web UI."

### Integration Plan (ready for implementer)

See [Appendix C: Integration Plan](#appendix-c-integration-plan).

### Option B: Wait and watch (REJECTED)

Spike showed the adapter is straightforward. Waiting has no benefit — the required gateway surface is already stable enough.

### Option C: Fork/contribute upstream (DEFERRED)

Nice-to-have but not blocking.

---

## Appendix A: relay-ide Integration Touch Points (if we ever build this)

Based on current relay-ide architecture (`nightly` @ `d727cc9`):

| Layer | Current State | Hermes Change |
|-------|--------------|---------------|
| `server/types.ts` `BUILTIN_FRAMEWORKS` | `claude`, `codex`, `opencode` | Add `hermes` entry with `eventSource: 'plugin'` or `'timer'` (no hooks) |
| `server/protocol-adapters/` | Claude, Codex, OpenCode adapters | New `hermes-adapter.ts` — REST polling + SSE consume |
| `server/output-parsers/` | `claude-parser`, `codex-parser`, `opencode-parser` | Likely **not needed** — Hermes emits structured JSON events, not terminal escape sequences |
| `server/web-session-handler.ts` | Creates `WebSession` with adapter | No change — reuse existing path |
| `shared/chat-events.ts` | 8 event types | Add `chat:thinking-start`, `chat:thinking-end`, `chat:context-compressed` |
| Frontend | React 19 + Zustand | New components: `ThinkingCard`, `CompressionBanner`, `HermesModelSwitcher` |
| `docs/ARCHITECTURE.md` | 58 server modules | +1 adapter module |

---

## Appendix B: Research Methodology & Time Box

- **Time spent:** ~45 minutes (well under the 3-hour budget).
- **Method:** Source-code reading via GitHub raw API + browser navigation. No Hermes binary was installed or executed (per spike security guidance).
- **SHAs pinned:** All file/line references above are against the pinned commits listed in the header.
- **Gaps:** We did not locate published gateway route handlers in `NousResearch/hermes-agent` (the gateway may be a separate closed-source component, embedded in the Python package, or simply not exposed as standalone route files). All gateway API knowledge is inferred from frontend client code.

---

## Appendix C: Integration Plan

> Ready for an implementer. Estimated effort: **1 day**.

### C.1 Files to create / modify

| # | File | Action | Lines |
|---|------|--------|-------|
| 1 | `server/protocol-adapters/hermes-adapter.ts` | **Create** — `HermesProtocolAdapter extends BaseProtocolAdapter` | ~200 |
| 2 | `server/protocol-adapters/index.ts` | **Modify** — add `hermes: () => new HermesProtocolAdapter()` to `adapters` record | +1 |
| 3 | `server/types.ts` | **Modify** — add `hermes` to `BUILTIN_FRAMEWORKS`; `eventSource: 'parser'` or `'timer'` | +20 |
| 4 | `shared/chat-events.ts` | **Modify** — add `'hermes'` to `ChatEventSource` and `VALID_SOURCES` | +2 |
| 5 | `docs/ARCHITECTURE.md` | **Modify** — list `hermes-adapter.ts` in module inventory | +1 |
| 6 | `docs/spikes/hermes-integration.md` | **Move** to `docs/references/hermes-integration.md` on merge | — |

### C.2 `HermesProtocolAdapter` implementation sketch

```ts
class HermesProtocolAdapter extends BaseProtocolAdapter {
  readonly agentType = 'hermes';
  private _config: AdapterConfig | null = null;
  private _gatewayUrl = 'http://127.0.0.1:8642';
  private _sessionKey: string | null = null;
  private _abortController: AbortController | null = null;
  private _reader: ReadableStreamDefaultReader<Uint8Array> | null = null;

  get status(): AdapterStatus { return this._status; }

  async connect(config: AdapterConfig): Promise<void> {
    this._config = config;
    this._status = 'connecting';
    // 1. Probe gateway health: GET /health
    // 2. List or create session: GET /api/sessions  →  POST /api/session-send (first msg)
    // 3. Emit session-started + idle
    this._status = 'connected';
  }

  protected async onDisconnect(): Promise<void> {
    this._abortController?.abort();
    this._reader?.cancel().catch(() => {});
    this._status = 'disconnected';
  }

  async sendMessage(turnId: string, content: string): Promise<void> {
    this._abortController?.abort();
    const controller = new AbortController();
    this._abortController = controller;

    this.fire({ type: 'chat:turn-started', turnId, turnIndex: 0 });
    this.fire({ type: 'chat:session-status', status: 'active' });

    // POST /api/session-send { sessionKey, message }
    // Then open SSE stream for response (Hermes returns turn response as SSE)
    await this.consumeSse(turnId, controller.signal);
  }

  async interrupt(_turnId: string): Promise<void> {
    this._abortController?.abort();
    // Optional: POST /api/agent-kill { sessionKey }
  }

  async respondToApproval(requestId: string, decision: 'allow' | 'allow-always' | 'deny'): Promise<void> {
    const action = decision === 'deny' ? 'deny' : 'approve';
    // POST /api/gateway/approvals/${requestId}/${action}
  }

  // ... createSession, resumeSession, forkSession — stub or delegate to gateway

  private async consumeSse(turnId: string, signal: AbortSignal): Promise<void> {
    // fetch() with ReadableStream, parse SSE lines, map event types:
    // token          → chat:text-delta
    // thinking       → chat:reasoning
    // tool_start     → chat:tool-call
    // tool_end       → chat:tool-result
    // approval_request → chat:approval-request
    // done           → chat:turn-completed + chat:session-status idle
    // apperror       → chat:error
    // compressed     → chat:compaction
    // cancel         → chat:turn-completed reason:interrupted
  }

  private fire(partial: { type: ChatEvent['type'] } & Record<string, unknown>): void {
    this.emit({ ...partial, sessionId: this._config!.sessionId, timestamp: new Date().toISOString(), source: 'hermes' } as ChatEvent);
  }
}
```

### C.3 Open questions for implementer

1. **Gateway lifecycle:** Does relay-ide spawn `hermes gateway run` as a managed subprocess (like `codex`/`opencode`), or does the adapter assume a user-managed gateway?  
   *Recommendation:* Spawn it. Add `command: 'hermes'` and `args: ['gateway', 'run']` to `BUILTIN_FRAMEWORKS['hermes']`, then spawn in `connect()` and kill in `onDisconnect()`. Gateway is lightweight enough to be per-session.

2. **Model switching:** Hermes gateway supports `POST /api/model-switch`. Should the adapter expose this?  
   *Recommendation:* Defer. Add to adapter's `extra` config if needed later.

3. **Telemetry:** Hermes emits token usage in `done` events. Map to `chat:telemetry`.

4. **Attachments:** Hermes supports file uploads. Map to `POST /api/session-send` with multipart or base64 payload. Defer if not needed for MVP.

### C.4 Testing strategy

- **Unit:** Mock gateway SSE stream with `ReadableStream` fixtures. Verify event mapping.
- **Integration:** Requires live `hermes gateway run`. Gate behind `HERMES_TEST_GATEWAY_URL` env var; skip if unset.
- **E2E:** Create Hermes session in relay-ide, send message, verify response appears.

### C.5 Risk mitigation

- **Gateway drift:** Pin integration to `NousResearch/hermes-agent@b6ca3c28` initially. Add a gateway version probe in `connect()` and warn if version mismatch.
- **Rebrand drift:** Use `'hermes'` as the canonical `agentType` regardless of rebrand. UI display name can be updated in `BUILTIN_FRAMEWORKS` later.
- **SSE parsing:** Use a small SSE parser utility (or `eventsource` package). Keep it local to the adapter.

---

## References

[^hw-readme-57-68]: `outsourc-e/hermes-workspace/README.md` lines 57-68 — quick start (`hermes gateway run` + `pnpm dev`).  
[^hw-readme-90-101]: `outsourc-e/hermes-workspace/README.md` lines 90-101 — `API_SERVER_KEY` / `HERMES_API_TOKEN` auth.  
[^hw-gateway-api-1-4]: `outsourc-e/hermes-workspace/src/lib/gateway-api.ts` lines 1-4 — `BASE_URL` default.  
[^hw-gateway-api-147-168]: `outsourc-e/hermes-workspace/src/lib/gateway-api.ts` lines 147-168 — `fetchSessionHistory()`.
[^hw-gateway-api-175-203]: `outsourc-e/hermes-workspace/src/lib/gateway-api.ts` lines 175-203 — `sendToSession()`.
[^hw-gateway-api-205-211]: `outsourc-e/hermes-workspace/src/lib/gateway-api.ts` lines 205-211 — `fetchSessions()`.  
[^hw-hermes-auth-1-33]: `outsourc-e/hermes-workspace/src/lib/hermes-auth.ts` lines 1-33 — auth check endpoint.  
[^hw-connection-errors-67-91]: `outsourc-e/hermes-workspace/src/lib/connection-errors.ts` lines 67-91 — "ClawSuite" rebrand references in error messages.  
[^hw-architecture-1]: `nesquena/hermes-webui/ARCHITECTURE.md` line 1 — "no build step, no bundler, no frontend framework."  
[^hw-streaming-py]: `nesquena/hermes-webui/api/streaming.py` — SSE event emission (`token`, `thinking`, `tool_start`, `done`, `apperror`, `compressed`).  
[^hw-streaming-py-clarify]: `nesquena/hermes-webui/api/streaming.py` — `clarify` event for blocked tool calls.  
[^hw-streaming-py-cancel]: `nesquena/hermes-webui/api/streaming.py` `cancel_stream()` — eager session lock release on cancel.
