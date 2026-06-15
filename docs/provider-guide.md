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

## 8. Provider-native session state adapters

Provider-native state adapters are separate from live `ProtocolAdapterV2` runtimes. They read provider-owned stores to produce a bounded Relay read model, but they do not control the native CLI and they must not write provider state.

The server-side contract is `AgentHarnessStateAdapter` (`server/harness-state-adapter.ts`) with:

- `detectInstall()` — reports installed/unavailable/unsupported and safe diagnostics.
- `listNativeSessions(scope?)` — returns provider, native id, source path, cwd/repo/work-context hints when present, timestamps, and redacted preview metadata.
- `readProviderState(ref)` — returns a hash/size/event-type snapshot with `rawPayloadStored: false`; raw JSONL/database rows are not persisted as Relay artifacts.
- `importSession(ref)` — normalizes provider state into an `AgentSessionV2` read model plus `AgentPatchV2` snapshot patches. Imports include a `providerExtension` audit/divider marker naming the source provider, source kind, import time, hash, and `readOnly: true`.
- `resumeCommand(ref)` — returns copyable argv data only. It never executes the command.
- `capabilities` — explicitly separates transcript import, provider-state read, native resume command generation, live event streaming, approval response, and tool-call exposure.

Read-only-first invariants:

- Do not mutate `.claude`, `.codex`, `.hermes`, `.opencode`, or any other proprietary provider store in this slice.
- Do not cross-provider migrate context; importing Claude state produces a Claude read model, not a Codex/Hermes/OpenCode session.
- Redact previews, tool inputs, command metadata, approval payloads, and secret-looking strings before surfacing them through summaries/snapshots.
- Treat native resume/open as explicit operator/agent intent. Adapter code may generate `['claude', '--resume', '<id>']`; it may not spawn it.

The first implementation is `ClaudeJsonlStateAdapter`, which imports Claude JSONL fixtures and keeps live streaming/approval response disabled.

## 9. Testing pattern

Each provider needs golden trace tests under `test/server/protocol-adapters/<provider>-adapter.test.ts`. Provider-native state adapters use adjacent golden fixture tests under `test/server/provider-state/`.

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

## 10. Stacked PR checklist

For each provider:

1. Create a branch from the previous stack branch.
2. Write/commit provider mapping tests first and watch them fail.
3. Implement adapter until targeted tests pass.
4. Register provider in `v2Adapters`.
5. Restore or rewrite provider web-session e2e tests.
6. Run `npm run check`, targeted tests, and `npm run build`.
7. Push and open a draft PR targeting the previous provider stack.

## 11. Deletion policy

When a provider is fully V2-native, delete replaced V1 code in the same provider stack. If a temporary bridge is used to keep the stack moving, the PR must explicitly label it as temporary and include the deletion target in its body.

## 12. Agent collaboration: role defaults + prompt appendix (#953)

Relay-launched agent sessions are not isolated terminals — other agents and operators can discover and message them through the CLI gateway (`roster.list`, `roster.register`/`roster.updateSelf`, `inbox.*`, `events subscribe --topic inbox`). To teach a session how to collaborate, two provider-neutral primitives live in `shared/agent-roster.ts`:

- **Role-default map** (`DEFAULT_AGENT_ROLE_MAP` / `roleForAgent(agent)`): a lightweight collaboration hint keyed by the lowercased agent kind — `claude → implementer`, `codex → reviewer`, `hermes`/`ebi → orchestrator`, `opencode → implementer`, everything else `collaborator`. It is a HINT (surfaced as `RosterEntry.role`), not an authorization boundary, and deliberately not a closed union — register a default for a custom provider by extending the map, or override per call. Do not hard-code the architecture around these agents.
- **Collaboration prompt appendix** (`collaborationPromptAppendix({ role, provider })`): the canonical, succinct system-prompt block that tells an agent how to identify its own session/work context, list active collaborators (`roster.list`), self-declare its own presence (`roster.register` / `roster.updateSelf`), send/ack inbox messages, and subscribe to inbox events instead of polling. It explicitly avoids raw tmux/PTY steering.

This is the **single authoring source** so docs and the launcher agree on one text.

### Explicit self-declared presence (#964)

Beyond the derived `roster.list` projection, an agent can publish an explicit presence overlay so non-Relay-launched agents and richer role/use-case/status surface for discovery:

- **`roster.register`** create-or-replaces the calling agent's presence record; **`roster.updateSelf`** patches it and refreshes its heartbeat. Both are `context:write` writes (the read `roster.list` stays `session:read`).
- Declare only the allowlisted safe subset — `role`, `displayName`, `useCase`, `statusText`, `needsAttention`, `capabilityHints[]`, plus self-claimed scope (`sessionId`/`globalSessionId`/`workContextId`/`repoPath`/`nodeId`/`provider`) and `ttlSeconds`. The schema is `additionalProperties: false` and the store re-sanitizes: secret-shaped keys are **rejected**, unknown keys dropped, text control-char-stripped + length-bounded. Never put secrets, tokens, transcripts, prompts, or provider-private state in presence.
- Presence is **heartbeat-expiring** (TTL default 120s, clamped 10–3600). Re-register or `update-self` before expiry; `roster.list` drops stale records and writes sweep them. It is non-authoritative discovery metadata, never an authorization input.
- On merge, derived session fields win for identity/control; self-declaration only overlays the soft subset and is tagged `origin: "merged"`, while an external agent with no live session surfaces as `origin: "self-declared"`. See `docs/CLI_GATEWAY.md` §"Explicit presence safe-field allowlist + expiry (#964)".

Custom providers need no code change to participate — the appendix (and these CLI verbs) are provider-neutral. A provider that renders the appendix into its own launch prompt automatically teaches its agents to register/update-self.

### Launch-time injection (#955)

Relay-launched PTY sessions receive the appendix automatically when their framework declares support, gated by explicit capability metadata on `AgentFramework`:

- **`collaborationPromptArg?: string`** — the provider-specific CLI flag that _appends_ (not replaces) the default system prompt. Claude Code uses `--append-system-prompt`, which works in both interactive/TUI and print modes.
- **`capabilities.supportsCollaborationPrompt?: boolean`** — whether Relay may inject. Both are optional, so custom frameworks resolved by `resolveFramework` default to **unsupported** and are unaffected.

`collaborationPromptArgsForFramework(framework)` (in `server/types.ts`) returns `[collaborationPromptArg, collaborationPromptAppendix({ provider: framework.id })]` when both fields are present, else `[]`. `createPtySession` appends that pair to the **tail** of the launch argv right after `resolveAgentFramework`, so the existing `continue → claudeArgs → yolo` ordering, cwd/repo/worktree binding, and `yoloEnv` mapping are all preserved verbatim. The appendix is derived fresh at each spawn and is **never persisted** on the session (it does not appear in `sessionArgs`/`claudeArgs` or any serialized state), so it re-derives identically on restore and never leaks into the roster contract.

**Currently supported:** Claude Code only. **Skipped safely:** Codex, OpenCode, Hermes, and any custom framework — they declare no support and never receive Claude's flag. Injection is also skipped when a session is launched with a **custom `command`** that overrides the framework CLI (the provider flag may be invalid there), matching the `injectClaudeHooks` gate.

**Fallback for unsupported providers:** until a provider's own append-prompt mechanism is verified and wired (set its `collaborationPromptArg` + `supportsCollaborationPrompt`), render `collaborationPromptAppendix({ provider })` into that provider's own launch prompt from the shared helper. An operator can opt a builtin out by overriding `supportsCollaborationPrompt: false` in `config.frameworks`. The reserved `AgentFramework.extraArgs` slot is intentionally left untouched — the appendix is derived dynamically from the shared source rather than baked into static framework config, to avoid prose drift.
