# Claude Web UI on Agent Chat Protocol V2 — Design

> **Status:** Design approved (brainstorm 2026-04-27). Implementation plan to be authored next via `superpowers:writing-plans`.
>
> **Supersedes:** `docs/plans/2026-04-26-v1-to-v2-port.md` (delete on landing — see Deletion Targets below). That earlier plan ports all four providers in a single mega-cutover and treats UI rebuild as out-of-scope; this design narrows to claude-end-to-end first, rebuilds UI against `docs/design-system/ui_kits/relay-web/chat.html`, and explicitly drives a dogfood loop that produces `provider-guide.md` and a SKILL for adding remaining providers.

---

## Goal

Claude works end-to-end in the relay web UI on Agent Chat Protocol V2 (`AgentPatchV2`), rendered against the chat.html design target, with the V1 surface deleted in the same branch. The output of this work — a working adapter, a chat.html-faithful UI, and the empirical patterns extracted from doing it — becomes the input for the immediate follow-on work that ports codex / opencode / hermes (see `docs/plans/2026-04-27-multi-provider-roadmap.md`).

**Non-goals (explicit):**

- Codex, OpenCode, Hermes web sessions. They go silent (broken / disabled) until their respective V2 ports land in the immediate follow-up. PTY mode for all three remains untouched.
- `provider-guide.md` and the provider-add SKILL. Both are downstream deliverables — written from the empirical patterns this work surfaces, not before.

---

## Architecture

### Decision: normalize core, progressively enhance

Locked in this brainstorm. Considered alternatives (thin envelope per Conductor, full normalize) and chose normalize-with-escape-hatch:

- **Core normalized**: `AgentPatchV2` is the integration boundary. Every adapter emits patches conforming to the V2 schema. UI consumes `AgentSessionV2` only.
- **Escape hatch**: Provider-native events without a clean V2 mapping → `AgentProviderExtensionItemV2 { namespace: 'claude', payload: <raw> }`. Each provider registers a renderer module for its namespace.
- **Hard rule**: Never invent a top-level wire patch type for one provider. If two or more providers need a shape, promote it to V2 schema in a follow-up.

Conductor (decompiled 2026-04-27 from `/Applications/Conductor.app`) chose pure thin envelope (`{ type, id, agentType, data: unknown }`). At 2 providers and a larger team they can afford parallel UI renderers per provider. At 4 providers and our team size, normalize wins (single chrome, single approval flow, single queue UX). See multi-provider roadmap for full Conductor findings.

### Boundary contract (already shipped, unchanged)

| File                                          | Responsibility                                                                                                                                                      |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `shared/agent-chat-protocol-v2.ts`            | Wire shape (`AgentPatchV2`), session shape (`AgentSessionV2`), reducer (`applyAgentPatchV2`), capability set, item discriminators. 798 lines, frozen for this work. |
| `server/protocol-adapter-v2.ts`               | `ProtocolAdapterV2` interface + `BaseProtocolAdapterV2`. Frozen for this work.                                                                                      |
| `frontend/src/hooks/useAgentChatSocket.ts`    | WS client; reduces patches into `AgentSessionV2` state. Frozen for this work.                                                                                       |
| `server/protocol-adapters/mock-v2-adapter.ts` | Reference V2 implementation. Stays as test fixture and as UI-development driver (Phase A below).                                                                    |

### New / replaced layers (this work)

| File                                                  | Responsibility                                                                                                                                                                                       | Notes                                    |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| `server/protocol-adapters/claude-adapter.ts`          | Native V2 adapter for Claude. Wraps `@anthropic-ai/claude-agent-sdk`, owns SDK lifecycle + hook handlers, emits `AgentPatchV2` via `BaseProtocolAdapterV2.emitPatch`. Replaces V1 file at same path. | See Mapping Table                        |
| `frontend/src/components/chat/*`                      | Full rebuild against chat.html. No V1 component survives.                                                                                                                                            | See UI Components                        |
| `frontend/src/components/chat/extensions/registry.ts` | Renderer registry keyed by `providerExtension` namespace. Default fallback = "unmapped event" debug card.                                                                                            | New                                      |
| `frontend/src/components/chat/extensions/claude/*`    | Claude-namespace extension renderers (e.g. `EnterPlanModeCard`, `FastModeUnavailableCard`).                                                                                                          | New, populated as we hit unmapped events |

### Lifecycle

1. **Web session create** → `claudeAdapter.connect(config)` → adapter validates capabilities, publishes `agent-session-snapshot-v2`. SDK `query()` is **not** started yet.
2. **First `sendMessage`** → adapter starts SDK generator with the user input. Each yielded SDK message + each hook callback maps to one or more `AgentPatchV2` emissions.
3. **Interrupt** → adapter aborts SDK generator (AbortController). Emits `agent-turn-completed-v2 { status: 'interrupted' }` + `agent-live-state-updated-v2 { status: 'idle' }`.
4. **Approval** → SDK hook awaits decision. Adapter emits `approval` item + `agent-live-state-updated-v2 { status: 'waiting', waitingOn: 'approval' }`. On `respondToApproval`, adapter resumes the awaiting hook with the decision and emits `approval` update + `agent-live-state-updated-v2 { status: 'working' }`.
5. **Queue** → second `sendMessage` while a turn is running → adapter buffers and emits `agent-live-state-updated-v2 { queueLength: N }`. Drains FIFO when current turn completes.
6. **Disconnect** → adapter aborts SDK + cleanup. Reconnect = fresh adapter; `resume` capability replays via persisted Claude `sessionId`.

### Capability negotiation

Adapter publishes capabilities once at session snapshot:

```ts
// claude
{
  text: true,
  reasoning: true,
  tools: true,
  commandExecution: true,
  fileChanges: true,
  approvals: true,
  questions: false,
  plans: false,
  slashCommands: true,
  queue: true,
  interrupt: true,
  cancelQueued: false,
  resume: true,
  fork: false,
  rollback: false,
  compact: true,
  telemetry: true,
  rateLimits: true,
}
```

UI gates affordances on capabilities:

- `cancelQueued: false` → no per-item × on queue chips for claude (chip stays for visual queue length only).
- `questions: false` → never render a question card in claude sessions.
- `plans: false` → never render a plan card.
- `compact: true` → expose `/compact` in slash palette.

`mock-v2-adapter` publishes a superset (everything `true`) so UI exercises every branch during Phase A.

---

## Implementation Order (Phase A → B → C)

### Phase A: UI rebuild against `mock-v2-adapter`

`mock-v2-adapter` already emits the full V2 contract (462 lines, includes queue, approvals, deltas, tool calls). UI is built and matured against it. Outcome: UI is **provider-agnostic by construction** — claude later plugs in without UI changes.

Deliverables:

- All chat components rebuilt vs chat.html (see UI Components below).
- Mock-v2 connected as a regular session via the existing `index.ts` registry.
- Manual + automated checks: deterministic mock trace plays through UI cleanly; every chat.html primitive is exercised (turns, tcards collapsed/expanded, fc-rows, acard with all three actions, live-bar, queue, slash palette, composer with context-pop).
- v1 frontend components deleted in this phase (see Deletion Targets).

### Phase B: `claude-adapter.ts` v2 implementation

Replace `claude-adapter.ts` with a `BaseProtocolAdapterV2` subclass driving `@anthropic-ai/claude-agent-sdk`. Conductor (app v0.49.5) uses this SDK with `CLAUDE_CODE_ENTRYPOINT="sdk-ts"`; we adopt the same entrypoint.

Deliverables:

- New `claude-adapter.ts` per Mapping Table below.
- v1 claude adapter file deleted (same path, replaced).
- Unit tests under `test/server/protocol-adapters/claude-adapter.test.ts`: each native event class → expected patch sequence, deterministic.
- Web session handler updated to require V2 adapter (no V1 fallback).

### Phase C: dogfood loop

Switch personal usage to claude-on-web. Capture every unmapped SDK message / hook event encountered → grow Mapping Table or add `claude/<NewCard>` extension renderer. After ~1 week dogfood:

- Inventory of providerExtension namespaces actually used.
- List of mapping table additions.
- Inventory of UI bugs / chat.html deviations to fix.

This output drives the next deliverable: `provider-guide.md`.

---

## Mapping Table — Claude Agent SDK → AgentPatchV2

Salvaged from `2026-04-26-v1-to-v2-port.md` Phase 1 with adjustments for SDK-not-stream-json transport. SDK's `query()` async generator yields typed messages instead of stream-json strings; hook events arrive via the SDK's hooks config.

| SDK event                                                                       | V2 patch                                                                                                                                   | Item shape                                                                                                  |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `system` (init) — `{ subtype: 'init', tools: [...], sessionId }`                | `agent-session-snapshot-v2` (set `providerSession.claudeSessionId`, capabilities update with tool names)                                   | —                                                                                                           |
| `assistant` message, `content[]: text` (delta)                                  | `agent-item-delta-v2` (text)                                                                                                               | `assistantMessage` (id = `msg-${turnId}-${blockIdx}`)                                                       |
| `assistant` message, `content[]: thinking`                                      | `agent-item-delta-v2` (summary)                                                                                                            | `reasoning` (id = `thinking-${turnId}-${blockIdx}`, visibility = `summary`)                                 |
| `assistant` message, `content[]: tool_use` (`name === 'Bash'`)                  | `agent-item-started-v2`                                                                                                                    | `commandExecution` (id = `exec-${tool_use.id}`, command = input.command, output = '')                       |
| `assistant` message, `content[]: tool_use` (`name in {Edit, Write, MultiEdit}`) | `agent-item-started-v2`                                                                                                                    | `fileChange` (paths from input, applyStatus = `pending`)                                                    |
| `assistant` message, `content[]: tool_use` (other)                              | `agent-item-started-v2`                                                                                                                    | `dynamicToolCall` (namespace = `claude`, id = `tool-${tool_use.id}`)                                        |
| `tool_result` block                                                             | `agent-item-updated-v2`                                                                                                                    | matching item with `result` populated, `status: 'completed'`                                                |
| hook `PreToolUse` (`Bash`)                                                      | `agent-item-started-v2`                                                                                                                    | `commandExecution` (correlated with `tool_use.id`)                                                          |
| hook `PostToolUse` (`Bash`)                                                     | `agent-item-updated-v2`                                                                                                                    | `commandExecution` with `output`, `exitCode`, `durationMs`, `status: 'completed'`                           |
| hook `PreToolUse` (`Edit/Write/MultiEdit`)                                      | `agent-item-started-v2`                                                                                                                    | `fileChange` correlated                                                                                     |
| hook `PostToolUse` (`Edit/Write/MultiEdit`)                                     | `agent-item-updated-v2`                                                                                                                    | `fileChange` with `patch`, `applyStatus: 'applied'`                                                         |
| hook `notification` (`permission`)                                              | `agent-item-started-v2` + `agent-live-state-updated-v2`                                                                                    | `approval` (kind = `permission`, requestId, target) — live state `status: 'waiting', waitingOn: 'approval'` |
| hook `Stop` / `session.idle`                                                    | `agent-turn-completed-v2 { status: 'completed' }` + `agent-live-state-updated-v2 { status: 'idle' }`                                       | —                                                                                                           |
| `result` (final usage block on turn)                                            | included in `agent-turn-completed-v2.usage`                                                                                                | —                                                                                                           |
| `result` (`subtype: 'error_during_execution'`)                                  | `agent-error-v2` + `agent-turn-completed-v2 { status: 'failed' }`                                                                          | —                                                                                                           |
| `EnterPlanMode` notification (Claude-specific)                                  | `agent-item-started-v2` with `providerExtension { namespace: 'claude', payload: { kind: 'enterPlanMode', ...raw } }`                       | —                                                                                                           |
| `FastModeUnavailable` notification                                              | `providerExtension` (`namespace: 'claude'`)                                                                                                | —                                                                                                           |
| Any unrecognized SDK message                                                    | `agent-item-started-v2` with `providerExtension` (`namespace: 'claude'`, payload = raw event), log warn with event signature for follow-up | —                                                                                                           |

**Item ID conventions** (load-bearing for delta correlation):

- `userMessage`: `user-${turnId}` (one per turn).
- `assistantMessage`: `msg-${turnId}-${blockIdx}` where `blockIdx` increments per text block within a turn.
- `reasoning`: `thinking-${turnId}-${blockIdx}` parallel to message.
- `commandExecution`, `fileChange`, `dynamicToolCall`: keyed off Claude's `tool_use.id` so `PreToolUse` / `tool_use` block / `PostToolUse` / `tool_result` all converge on the same item.
- `approval`: SDK hook gives a request ID; use it directly.
- `providerExtension`: `ext-${namespace}-${turnId}-${counter}`.

---

## UI Components vs `chat.html`

`chat.html` (1230 lines) is the design target. Component breakdown:

| chat.html primitive                              | Component                                                     | Source of truth                                          |
| ------------------------------------------------ | ------------------------------------------------------------- | -------------------------------------------------------- |
| `.tl > .turn`                                    | `Turn.tsx`                                                    | One `AgentTurnV2`                                        |
| `.turn-header`                                   | `TurnHeader.tsx`                                              | Turn metadata (started, model badge)                     |
| `.turn-footer`                                   | `TurnFooter.tsx`                                              | Turn usage / duration on completion                      |
| `.tcard` (collapsed/expanded tool card)          | `ToolCard.tsx` (rebuilt)                                      | `commandExecution`, `dynamicToolCall`, `mcpToolCall`     |
| `.tcard__h` (header with `aria-expanded`)        | inside `ToolCard.tsx`                                         | —                                                        |
| `.tcard__body`                                   | inside `ToolCard.tsx`                                         | —                                                        |
| `.fc-row` (file change inline)                   | `FileChangeRow.tsx`                                           | `fileChange`                                             |
| `.acard` (approval)                              | `ApprovalCard.tsx` (rebuilt)                                  | `approval`                                               |
| `.acard__btn--allow / --always / --deny`         | inside `ApprovalCard.tsx`, calls `useAgentChatSocket.approve` | —                                                        |
| `.live-bar`                                      | `LiveBar.tsx`                                                 | `AgentSessionLiveStateV2`                                |
| `.queue` + `.queue__item`                        | `QueueChips.tsx`                                              | `live.queueLength` + queued user messages from session   |
| `.slash` overlay                                 | `SlashPalette.tsx`                                            | adapter capability `slashCommands` + claude's slash list |
| `.composer`                                      | `Composer.tsx` (rebuilt)                                      | textarea + context-pop + send/interrupt button           |
| `.composer__bar` + `.cbar-trigger` (context pop) | inside `Composer.tsx`                                         | `usage.contextPercent` from latest turn                  |
| `.chat-tabs`                                     | already exists outside chat scope                             | session list (out of scope this work)                    |

Reasoning blocks render inline above their owning turn's first assistant message, collapsible, default collapsed (per `visibility: 'summary'`).

`MessageTimeline.tsx` v1 file is deleted; new top-level `ChatView.tsx` (or kept name, full rewrite) renders the timeline by mapping `session.turns` → `Turn` components.

---

## State Management

- WS state: `useAgentChatSocket` (existing). Returns `session: AgentSessionV2 | null`, `connected`, action callbacks.
- No Zustand store for chat state — `AgentSessionV2` from the hook is the single source of truth. Reducer is in `shared/`.
- UI-only ephemeral state (which `tcard` is expanded, slash palette open, composer draft) lives in component-local React state.

---

## Error / Approval / Queue Handling

- **Errors**: `agent-error-v2` patch updates session.error and emits live-state error. UI shows error banner above composer with retry. Turn marked `failed`, partial items remain visible.
- **Approvals**: hook pauses → patch emitted → UI surfaces `acard` → user clicks `allow / allow-always / deny` → hook unpauses with decision → patch updates approval item and live-state.
- **Queue**: extra `sendMessage` while running buffers in adapter. UI renders `.queue__item` chips for each buffered message. `cancelQueued: false` → chip × buttons absent for claude. On turn complete, adapter shifts queue, fires next.
- **Interrupt**: composer button toggles to `■` while live state is `working`. Click → `interrupt()` → adapter aborts SDK gen → patch closes turn as `interrupted`.

---

## Testing

- **Unit**: `test/server/protocol-adapters/claude-adapter.test.ts` — feed canned SDK message + hook sequences, assert patch stream is exact (golden trace).
- **Reducer**: existing reducer tests stay green (no contract change).
- **Mock-driven UI**: deterministic `mock-v2` script plays a representative session through real UI in vitest + happy-dom. Assert DOM matches chat.html primitives at each step.
- **Manual dogfood**: real claude session, real coding work for ~1 week. Capture unmapped events → fold into mapping table or extension renderer.
- **Regression on existing v2 mocks**: web-session-handler tests must pass after V1 fallback removal.

---

## Deletion Targets (objective, not cleanup phase)

Per `feedback_delete_replaced_code` memory: deletion is part of the work, not a follow-up. Files removed in this same branch:

**Server**:

- `server/protocol-adapters/claude-adapter.ts` (replaced in place by V2 version)
- `server/protocol-adapters/mock-adapter.ts` (V1; rename `mock-v2-adapter.ts` → `mock-adapter.ts` once V1 gone)
- `server/protocol-adapters/codex-adapter.ts` (V1; codex web sessions go silent until V2 port)
- `server/protocol-adapters/opencode-adapter.ts` (same)
- `server/protocol-adapters/opencode-attached-adapter.ts` (same)
- `server/protocol-adapters/hermes-adapter.ts` (same)
- `server/protocol-adapter.ts` (V1 interface, no V2 adapter inherits)
- `server/protocol-adapters/base-hook-adapter.ts` (V1; V2 claude adapter uses SDK directly, not this base)
- `server/protocol-adapters/attached-runtime-adapter.ts` (V1; preserve only if any V2 adapter inherits — verify in implementation)
- V1 fallback branch in `server/web-session-handler.ts`
- V1 fallback branch in `server/ws.ts:504-534`
- `WebSession.messages: ChatEvent[]` and `WebSession.adapter: ProtocolAdapter` in `server/types.ts` (V2 path only)

**Shared**:

- `shared/chat-events.ts`
- `shared/agent-chat-v1-compat.ts`

**Frontend**:

- `frontend/src/hooks/useChatSocket.ts`
- `frontend/src/components/chat/MessageTimeline.tsx` + `.css` (full rebuild)
- `frontend/src/components/chat/ToolCard.tsx` + `.css` (full rebuild)
- `frontend/src/components/chat/FileChangeCard.tsx` + `.css` (full rebuild — note: chat.html uses inline `.fc-row`, not a card; rename component to `FileChangeRow`)
- `frontend/src/components/chat/ApprovalCard.tsx` + `.css` (full rebuild)
- `frontend/src/components/chat/Composer.tsx` + `.css` (full rebuild)

**Docs**:

- `docs/plans/2026-04-26-v1-to-v2-port.md` — superseded by this design + the multi-provider roadmap. Delete on landing to prevent context poisoning.

**Renames** (to keep names clean once V1 gone):

- `mock-v2-adapter.ts` → `mock-adapter.ts`
- `mock-v2-adapter.test.ts` → `mock-adapter.test.ts`

---

## Risks

- **SDK API surface drift**: `@anthropic-ai/claude-agent-sdk` is pre-1.0. Mapping table is keyed off current SDK shape; pin version in `package.json` and call out upgrades as deliberate.
- **Hook ↔ tool_use correlation**: SDK delivers `PreToolUse` and `tool_use` block separately; both must converge to same item id. Risk = race; mitigation = item id keyed off `tool_use.id`, `PreToolUse` runs synchronously before the assistant block emit per SDK contract — verify in unit test with intentional reordering.
- **Approval hook resume**: SDK hook awaits a return value; relay's WS approval flow is async. Adapter must hold the awaiting Promise across the WS round-trip without blocking other patches. Implementation: keep a `Map<requestId, Resolver>` in the adapter, resolve from `respondToApproval`.
- **Queue semantics**: `cancelQueued: false` means UI shows queue but can't cancel individual items. If a user wants to cancel, only `interrupt()` is available — that aborts current turn, queue drains as normal. Document this in slash help text.
- **Codex / OpenCode / Hermes regression window**: web sessions for these break on landing. Acceptable per Q6 decision; immediate follow-up roadmap addresses each.
- **chat.html is HTML, not React**: rebuild is non-trivial; `MessageTimeline.tsx` v1 was 300 lines of fiddly scroll/layout logic that needs to come back. Risk = scroll/auto-stick bugs. Mitigation = port scroll behavior verbatim from old timeline before deleting it.

---

## Open implementation questions (for writing-plans skill)

These are questions for the implementation plan, not the design. Listed so the next phase has them queued:

1. Branch strategy: continue on `feat/agent-chat-protocol-v2` or new branch? (Current branch already has 12 V2-prep commits.)
2. PR cadence: single PR for all of Phase A + B + C, or split A (UI rebuild on mock) and B (claude adapter)? Splitting risks half-shipped state but lowers review surface.
3. Mock superset capabilities: does the mock advertise every capability `true`, or do we add separate "claude-mode mock" and "full-mock" so we test capability gating on UI?
4. Renderer registry registration timing: at module load (eager) or via a hook (lazy)? Eager is simpler for V1 of the registry.
5. Telemetry: V1 sessions feed agentlytics. Does V2 emit equivalent events, or do we accept a temporary blackout while ports complete?
