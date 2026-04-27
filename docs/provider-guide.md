# AgentPatchV2 Provider Guide

This guide captures the provider-port pattern extracted from the Claude Web UI V2 stack.

## 1. Provider contract

Every web-chat provider implements `ProtocolAdapterV2` from `server/protocol-adapter-v2.ts` and emits only `AgentPatchV2` patches from `shared/agent-chat-protocol-v2.ts`.

Required lifecycle:

1. `connect(config)` stores config, validates transport availability, emits either a snapshot or an idle live-state patch.
2. `sendMessage({ turnId, content })` starts a turn when idle or queues FIFO when busy.
3. Provider-native events map into normalized `agent-item-*` patches.
4. `interrupt()` aborts active work and emits an interrupted turn completion.
5. `respondToApproval()` resolves a pending provider permission request.
6. `disconnect()` aborts active work, rejects queued sends, clears pending approvals, and closes the transport.

## 2. Mapping table format

Each provider design must include this table before implementation:

| Native event         | V2 patch                                          | Item type           | Correlation key        | Notes                                             |
| -------------------- | ------------------------------------------------- | ------------------- | ---------------------- | ------------------------------------------------- |
| session/init         | `agent-session-snapshot-v2`                       | —                   | provider session id    | include capabilities and providerSession metadata |
| user prompt accepted | `agent-turn-started-v2` + `agent-item-started-v2` | `userMessage`       | relay `turnId`         | user item id = `user-${turnId}`                   |
| assistant text delta | `agent-item-delta-v2`                             | `assistantMessage`  | message/content id     | start item before first delta                     |
| reasoning/thinking   | `agent-item-started-v2` or delta                  | `reasoning`         | content id             | default `visibility: 'summary'`                   |
| shell command        | `agent-item-started-v2`/updated                   | `commandExecution`  | native tool id         | preserve command, cwd, output, exitCode           |
| file edit/write      | `agent-item-started-v2`/updated                   | `fileChange`        | native tool id         | preserve paths, patch, applyStatus                |
| generic tool         | `agent-item-started-v2`/updated                   | `dynamicToolCall`   | native tool id         | namespace = provider name                         |
| permission request   | `agent-item-started-v2` + waiting live state      | `approval`          | request/tool id        | resume via `respondToApproval`                    |
| completion           | `agent-turn-completed-v2` + idle live state       | —                   | turn id                | include usage when available                      |
| unknown native event | `agent-item-started-v2`                           | `providerExtension` | generated extension id | namespace = provider name, payload = raw event    |

## 3. Item ID conventions

Use stable, deterministic ids so deltas and updates converge:

- `userMessage`: `user-${turnId}`
- `assistantMessage`: `msg-${turnId}-${blockIndex}` or native message id when unique and stable
- `reasoning`: `thinking-${turnId}-${blockIndex}`
- `commandExecution`: `exec-${nativeToolId}`
- `fileChange`: `file-${nativeToolId}`
- `dynamicToolCall`: `tool-${nativeToolId}`
- `approval`: `approval-${requestId}`
- `providerExtension`: `ext-${provider}-${turnId}-${counter}`

Never use timestamps as the only id when the provider has a native correlation id.

## 4. Capability declaration

Declare capabilities in the adapter as static truth for the current implementation, not aspiration.

Common semantics:

- `queue`: adapter buffers sends while active.
- `cancelQueued`: adapter can cancel a specific queued turn. Claude is `false`.
- `interrupt`: active transport can be interrupted/aborted.
- `approvals`: adapter can pause native execution and resume from `respondToApproval`.
- `slashCommands`: provider supports slash command text or palette hints.
- `resume`: provider session id can be used for continuation.
- `telemetry` / `rateLimits`: adapter emits or exposes corresponding usage metadata.

The UI gates affordances from `session.capabilities`. If a capability is false, do not render the control.

## 5. providerExtension policy

Map to core V2 when a shape is provider-agnostic and already exists in `AgentItemV2`.

Use `providerExtension` when:

- The event is provider-specific (`EnterPlanMode`, `FastModeUnavailable`, provider checkpoint notices).
- The event is not yet understood but should remain visible for dogfood/debugging.
- Adding a top-level patch would only serve one provider.

Promotion rule: if two providers need the same extension shape, open a follow-up schema change to promote it into core V2.

## 6. Renderer registration

Provider extension renderers live under:

```text
frontend/src/components/chat/extensions/<provider>/
```

Register in:

```text
frontend/src/components/chat/extensions/registry.tsx
```

Requirements:

- Fallback renderer must show namespace and raw payload kind.
- Provider renderers must be isolated to their namespace.
- A missing renderer must not break the timeline.
- Tests should assert both known provider cards and fallback cards.

## 7. Queue and approval pattern

Queue:

```ts
if (activeTurnId !== null) {
  queue.push(input);
  emitLiveState({ status: 'working', activeTurnId, queueLength: queue.length });
  return;
}
await startTurn(input);
```

Approval:

1. Native permission event arrives.
2. Emit `approval` item.
3. Emit live state `{ status: 'waiting', waitingOn: 'approval', activeRequestIds: [requestId] }`.
4. Store resolver in `Map<requestId, resolver>`.
5. `respondToApproval()` resolves the native promise.
6. Emit approval item update and live state back to `working`.
7. Reject all pending resolvers on disconnect/interrupt.

## 8. Testing pattern

Each provider needs golden trace tests under `test/server/protocol-adapters/<provider>-adapter.test.ts`.

Minimum cases:

- capabilities match expected object
- init/session snapshot
- assistant text + delta + completion
- reasoning/thinking
- command execution
- file change
- dynamic tool
- approval wait/resume
- queue behavior
- interrupt behavior
- providerExtension fallback for unknown event
- result error -> `agent-error-v2` + failed turn

Use a deterministic dependency seam for provider transport. Tests should feed native events directly without spawning real CLIs.

## 9. Stacked PR checklist

For each provider:

1. Create a branch from the previous stack branch.
2. Write/commit provider mapping tests first and watch them fail.
3. Implement adapter until targeted tests pass.
4. Register provider in `v2Adapters`.
5. Restore or rewrite provider web-session e2e tests.
6. Run `npm run check`, targeted tests, and `npm run build`.
7. Push and open a draft PR targeting the previous provider stack.

## 10. Deletion policy

When a provider is fully V2-native, delete replaced V1 code in the same provider stack. If a temporary bridge is used to keep the stack moving, the PR must explicitly label it as temporary and include the deletion target in its body.
