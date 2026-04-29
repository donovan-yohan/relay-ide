# Agent Chat Protocol V2 Design

## Status

Approved direction: make Agent Chat Protocol v2 the canonical web-chat model.

This design is based on current Relay code plus observed Conductor.app behavior. Conductor's Codex app-server protocol models conversations as threads, turns, and ordered thread items, then streams notifications that mutate those items. Relay v1 currently models web chat as a flat `ChatEvent` stream. V2 adopts the Conductor shape so Relay can represent Claude, Codex, OpenCode, Hermes, and future agent backends without collapsing rich provider behavior into lossy events.

## Goals

- Represent the full chat UX surface: loading, queueing, interrupt, thinking, tool calls, tool output, file changes, approvals, questions, plan previews, slash-command expansion, compaction, telemetry, and provider-specific extensions.
- Make v2 the only long-term protocol. V1 is deprecated as soon as v2 lands and is removed after adapters and UI are migrated.
- Support feature discovery per backend through explicit capabilities. Unsupported features are absent from the UI rather than simulated poorly.
- Preserve provider-native IDs needed for resume, fork, rollback, queue management, and debugging.
- Keep Relay as the proxy. Browsers talk to Relay; Relay adapters talk to provider CLIs, app servers, hooks, or attached gateways.

## Non-Goals

- Do not maintain v1 and v2 as parallel public protocols.
- Do not require every backend to support every item type.
- Do not design a database persistence layer in this slice. V2 state remains in memory initially, with IDs and shapes chosen so persistence can be added later.
- Do not treat Hermes as an OpenAI Responses API by default. Hermes integration should follow the observed `hermes-webui` chat/session/stream flow unless the installed gateway explicitly advertises a Responses-compatible endpoint.

## Evidence From Conductor

Conductor points to a message-part/turn-item protocol, not a flat event protocol:

- Codex app-server generated types expose a `ThreadItem` union with first-class `userMessage`, `agentMessage`, `plan`, `reasoning`, `commandExecution`, `fileChange`, `mcpToolCall`, `dynamicToolCall`, collaboration, web search, image, review-mode, and compaction items.
- Codex app-server notifications stream mutations such as turn started/completed, item started/completed, agent-message deltas, reasoning deltas, command-output deltas, patch updates, plan updates, and approval/input requests.
- Conductor's session manager keeps live state separately from transcript state: idle/working, active questions, proposed plan, fast-mode availability, running message ID, current turn ID, pending message queue, and notification index.
- Conductor persists both Relay-like IDs and provider-native IDs: Claude session IDs, Codex thread IDs, SDK message IDs, last assistant message IDs, turn IDs, queued message status, and cancellability.

The design consequence is that Relay v2 must store canonical conversation state as ordered items, then use events only as patch operations against that state.

## Current Relay Gap

Relay v1 uses:

- `shared/chat-events.ts`: flat `ChatEvent` union.
- `server/protocol-adapter.ts`: adapters emit `ChatEvent`.
- `server/web-session-handler.ts`: web sessions buffer `ChatEvent[]`.
- `frontend/src/hooks/useChatSocket.ts`: accepts only `chat:*` events.
- `frontend/src/components/chat/MessageTimeline.tsx`: rebuilds display state by grouping event streams.

That shape works for simple text/tool/approval demos, but it loses durable item identity and makes queueing, plan mode, full tool surfaces, command interaction, provider-native IDs, and richer resume semantics awkward.

## Protocol Model

### `AgentSessionV2`

Canonical session state:

- `id`: Relay session ID.
- `provider`: `claude`, `codex`, `opencode`, `hermes`, `mock`, or future backend ID.
- `providerSession`: provider-native IDs such as Claude session ID, Codex thread ID, Hermes session key, OpenCode session ID.
- `capabilities`: explicit support flags.
- `config`: model, effort, permission mode, cwd, additional directories, provider options.
- `live`: status, active turn, waiting state, active request IDs, proposed plan, queue length, fast-mode availability, current error.
- `turns`: ordered `AgentTurnV2[]`.

### `AgentTurnV2`

Canonical turn state:

- `id`: Relay turn ID.
- `providerTurnId`: optional provider-native turn ID.
- `status`: `queued`, `running`, `waiting`, `completed`, `interrupted`, `failed`.
- `inputMessageId`: user message item ID.
- `items`: ordered `AgentItemV2[]`.
- `startedAt`, `completedAt`, `durationMs`, `error`.
- `usage`: optional token/cost/context usage.

### `AgentItemV2`

Canonical ordered item union:

- `userMessage`: submitted user text, optional expanded text, attachments, command metadata.
- `assistantMessage`: assistant text, phase, memory citations, provider message ID.
- `reasoning`: summary and detailed reasoning text, visibility metadata.
- `plan`: plan text, plan steps, approval state.
- `commandExecution`: command, cwd, parsed actions, status, output, exit code, duration, terminal interaction metadata.
- `fileChange`: changed paths, patch, apply status, approvals.
- `mcpToolCall`: server, tool, arguments, progress, result, error.
- `dynamicToolCall`: namespace, tool, arguments, streamed content items, result.
- `approval`: approval request/response state for command, file, permission, MCP, or provider-specific permission.
- `question`: structured user input or elicitation.
- `compaction`: summary/context compaction event.
- `webSearch`: query and action/status.
- `imageView` and `imageGeneration`: image inspection/generation surfaces.
- `hookPrompt`: hook-generated prompt fragments when a provider exposes them.
- `providerExtension`: namespaced escape hatch for provider data that Relay should preserve but does not yet render.

### `AgentPatchV2`

WebSocket stream messages mutate canonical state:

- `agent-session-snapshot-v2`: full current session state on connect.
- `agent-live-state-updated-v2`: live status, queue, waiting, plan/question changes.
- `agent-turn-started-v2`, `agent-turn-updated-v2`, `agent-turn-completed-v2`.
- `agent-item-started-v2`, `agent-item-delta-v2`, `agent-item-updated-v2`, `agent-item-completed-v2`.
- `agent-request-opened-v2`, `agent-request-resolved-v2`.
- `agent-error-v2`.

The frontend applies patches to a local v2 reducer. It does not reconstruct transcript state from a flat stream.

### `AgentCommandV2`

Browser-to-server commands:

- `agent-send-message-v2`: user text, attachments, optional client message ID.
- `agent-interrupt-v2`: interrupt active turn or cancel queued message.
- `agent-approve-v2`: respond to approval.
- `agent-answer-v2`: respond to question/input.
- `agent-plan-response-v2`: approve or revise proposed plan.
- `agent-resume-v2`, `agent-fork-v2`, `agent-rollback-v2`: exposed only when supported by capabilities.

## Capabilities

Each adapter declares capabilities at connect time:

- `text`: send and stream assistant text.
- `reasoning`: stream reasoning/summary.
- `tools`: render tool calls.
- `commandExecution`: command-specific tool surface.
- `fileChanges`: patch/file-change surface.
- `approvals`: approval requests and responses.
- `questions`: structured input/elicitation.
- `plans`: plan mode/proposed-plan lifecycle.
- `slashCommands`: list/preview/expanded-message support.
- `queue`: queue user messages while a turn is running.
- `interrupt`: interrupt active turn.
- `cancelQueued`: cancel queued user message.
- `resume`, `fork`, `rollback`, `compact`.
- `telemetry`, `rateLimits`.

The UI reads capabilities before showing controls. If a capability is false, the UI hides the richer control and keeps the core chat path.

## Provider Strategy

### Codex

Codex should be the first real v2 adapter because its app-server protocol already matches the v2 shape. Relay should prefer `codex app-server --listen stdio://` when available and map app-server thread/turn/item notifications into v2 patches.

### Claude

Claude should use `--output-format stream-json --input-format stream-json` plus available hook events. It should preserve Claude session IDs, SDK message IDs, tool-use IDs, partial assistant messages, hook prompts, approval events, and plan/question semantics when exposed. Claude may initially support fewer item types than Codex, but should still emit v2 items rather than v1 events.

### OpenCode

OpenCode should map its web UI/server events into v2 items. Its first milestone is core text, tools, output, status, interrupt, and error handling. Provider-specific fields are preserved in `providerExtension` until mapped to richer item types.

### Hermes

Hermes should follow `nesquena/hermes-webui` observed semantics: create/list session, start chat, consume stream, handle token/reasoning/tool/approval/clarify/done/compressed/error/cancel events. The current Responses-style Relay adapter is a temporary implementation detail and should be replaced or gated behind endpoint detection.

## V1 Deprecation Policy

V1 is deprecated when the v2 contract lands.

Rules during migration:

- No new feature work targets `ChatEvent` directly.
- No new provider adapter may emit only v1.
- New frontend chat surfaces consume v2 state.
- A single compatibility module may translate v2 patches to v1 `ChatEvent` only while legacy components are being replaced.
- The compatibility module must have a removal issue and a failing-removal checklist in the implementation plan.

Removal gates:

- All web-session adapters emit v2.
- WebSocket clients receive v2 snapshots and patches.
- Frontend chat state is driven by the v2 reducer.
- Mock, Codex, Claude, OpenCode, and Hermes tests cover v2 behavior.
- Browser QA covers at least mock plus one installed real backend.
- Production log canary shows no v1-only web-chat paths in use.
- `shared/chat-events.ts`, v1 tests, and v1 compatibility translation are deleted or moved to archived docs.

## Migration Action Checklist

- [ ] Add v2 shared types and reducer tests.
- [ ] Add v2 adapter interface and base adapter helpers.
- [ ] Add a v2 mock adapter with text, reasoning, tools, approvals, queue, and interrupt scenarios.
- [ ] Add WebSession v2 state and snapshot/patch buffering.
- [ ] Add WebSocket v2 command handling.
- [ ] Add temporary `v2-to-v1` compatibility module for existing UI only.
- [ ] Port frontend socket hook to v2 snapshots/patches.
- [ ] Port timeline rendering from event grouping to ordered item rendering.
- [ ] Port approval/question/plan controls to v2 request objects.
- [ ] Port Codex to app-server v2 semantics.
- [ ] Port Claude to stream-json/hook v2 semantics.
- [ ] Port OpenCode to v2 semantics.
- [ ] Replace Hermes Responses adapter path with observed Hermes chat/session stream path or explicit endpoint detection.
- [ ] Remove v1 frontend consumption.
- [ ] Remove v1 adapter emission.
- [ ] Remove compatibility module.
- [ ] Update docs and close the v1 deprecation issue.

## Testing Strategy

- Type tests: v2 type guards, reducer invariants, capability validation.
- Adapter unit tests: native payload to v2 patch mapping for each backend.
- Integration tests: WebSession snapshot replay, live patch streaming, reconnect behavior, queue and interrupt behavior.
- Frontend tests: reducer application, ordered item rendering, approval/question/plan surfaces.
- Browser QA: load local dev server, create mock session, send message, see user item and assistant response, approve a request, interrupt a running turn.
- Real backend QA: exercise one installed backend at minimum for each PR that claims provider support.
- Production canary: inspect logs for web-session creation, send-message success, stream patches, and adapter errors.

## Open Risks

- Claude and Codex installed app protocols can drift. Relay should detect command help/schema when possible and log exact unsupported capability reasons.
- Hermes has multiple frontends and no standalone stable web protocol document. Relay should isolate Hermes endpoint probing and keep provider-specific logic inside the adapter.
- A large one-shot frontend migration could hide regressions. The plan should land a v2 reducer and compatibility shim first, then remove the shim only after browser QA proves v2 rendering.
