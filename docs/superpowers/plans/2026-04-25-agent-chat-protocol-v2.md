# Agent Chat Protocol V2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Relay web chat v1 `ChatEvent` with Agent Chat Protocol v2, a canonical turn/item protocol modeled after observed Conductor.app behavior, then remove v1.

**Architecture:** V2 stores conversation state as sessions, turns, and ordered items. Adapters emit v2 patches that mutate this state; the browser receives a snapshot on connect and patch messages afterward. V1 is a temporary compatibility source only and is deleted after the frontend and adapters consume v2.

**Tech Stack:** TypeScript ESM, Express WebSocket server, React 19, Vitest, existing `ProtocolAdapter` and `WebSession` infrastructure.

---

## Source Documents

- Design spec: `docs/superpowers/specs/2026-04-25-agent-chat-protocol-v2-design.md`
- Current v1 types: `shared/chat-events.ts`
- Current adapter interface: `server/protocol-adapter.ts`
- Current web session state: `server/web-session-handler.ts`, `server/types.ts`
- Current WebSocket command path: `server/ws.ts`
- Current frontend socket hook: `frontend/src/hooks/useChatSocket.ts`
- Current frontend timeline: `frontend/src/components/chat/MessageTimeline.tsx`
- Hermes spike: `docs/spikes/hermes-integration.md`

## V1 Deprecation Contract

V1 is deprecated in Task 1 and removed in Task 9.

Allowed during migration:

- One compatibility module named `shared/agent-chat-v1-compat.ts`.
- Existing tests may keep referencing v1 until their task ports them.
- Existing UI may receive v1 events only through the compatibility module.

Not allowed after Task 1:

- New provider code emitting `ChatEvent` directly.
- New frontend rendering based on `ChatEvent[]`.
- New docs describing v1 as the canonical web-chat protocol.

Removal gate before Task 9:

- `rg "ChatEvent|chat-events|chat:" server frontend shared test` only returns archived docs or tests intentionally checking deletion behavior.

## File Structure

Create:

- `shared/agent-chat-protocol-v2.ts`: canonical v2 types, type guards, reducer helpers.
- `shared/agent-chat-v1-compat.ts`: temporary v2-to-v1 and v1-to-v2 compatibility helpers.
- `server/protocol-adapter-v2.ts`: v2 adapter contract and base adapter class.
- `server/protocol-adapters/mock-v2-adapter.ts`: v2 mock scenarios used by tests and QA.
- `server/web-session-v2-state.ts`: in-memory v2 state, bounded patch buffer, snapshot creation.
- `frontend/src/hooks/useAgentChatSocket.ts`: v2 socket hook.
- `frontend/src/components/chat-v2/AgentTimeline.tsx`: ordered item renderer.
- `frontend/src/components/chat-v2/AgentItemRenderer.tsx`: item type switch.
- `frontend/src/components/chat-v2/AgentRequestPanel.tsx`: approval/question/plan requests.
- `test/agent-chat-protocol-v2.test.ts`: shared type/reducer tests.
- `test/web-session-v2.test.ts`: server session snapshot/patch tests.
- `test/mock-v2-adapter.test.ts`: adapter behavior tests.
- `test/agent-chat-v1-compat.test.ts`: temporary compatibility tests.
- `test/frontend-agent-chat-v2.test.tsx`: frontend reducer/rendering tests.

Modify:

- `server/types.ts`: add v2 state fields to `WebSession` during migration, remove v1 fields in Task 9.
- `server/web-session-handler.ts`: wire v2 state and patch dispatch.
- `server/ws.ts`: handle v2 commands and snapshot replay.
- `server/protocol-adapters/index.ts`: register mock v2 and later provider v2 adapters.
- `frontend/src/components/chat/ChatView.tsx`: switch from v1 hook/timeline to v2 hook/timeline.
- `docs/WEB_CHAT.md`: document v2 and mark v1 removed.

## Task 1: Add V2 Contract And Deprecate V1

**Files:**

- Create: `shared/agent-chat-protocol-v2.ts`
- Create: `test/agent-chat-protocol-v2.test.ts`
- Modify: `docs/WEB_CHAT.md`

- [ ] **Step 1: Write failing tests for v2 type guards and reducer basics**

Add `test/agent-chat-protocol-v2.test.ts` with tests for:

```ts
import { describe, expect, it } from 'vitest';
import {
  applyAgentPatchV2,
  emptyAgentSessionV2,
  isAgentPatchV2,
} from '../shared/agent-chat-protocol-v2.js';

describe('Agent Chat Protocol v2', () => {
  it('accepts session snapshots and item patches', () => {
    const session = emptyAgentSessionV2({
      id: 's1',
      provider: 'mock',
      cwd: '/tmp/repo',
    });

    expect(
      isAgentPatchV2({
        type: 'agent-item-started-v2',
        sessionId: 's1',
        timestamp: '2026-04-25T00:00:00.000Z',
        turnId: 't1',
        item: { type: 'assistantMessage', id: 'm1', text: '', phase: null },
      })
    ).toBe(true);

    const next = applyAgentPatchV2(session, {
      type: 'agent-turn-started-v2',
      sessionId: 's1',
      timestamp: '2026-04-25T00:00:00.000Z',
      turn: {
        id: 't1',
        status: 'running',
        inputMessageId: 'u1',
        items: [],
        startedAt: '2026-04-25T00:00:00.000Z',
      },
    });

    expect(next.turns).toHaveLength(1);
    expect(next.live.status).toBe('working');
  });
});
```

- [ ] **Step 2: Run the failing test**

Run: `npm test -- test/agent-chat-protocol-v2.test.ts`

Expected: fail because `shared/agent-chat-protocol-v2.ts` does not exist.

- [ ] **Step 3: Add minimal v2 types and reducer**

Implement `shared/agent-chat-protocol-v2.ts` with:

- `AgentProviderV2`
- `AgentCapabilitySetV2`
- `AgentSessionV2`
- `AgentTurnV2`
- `AgentItemV2`
- `AgentPatchV2`
- `AgentCommandV2`
- `emptyAgentSessionV2`
- `isAgentPatchV2`
- `applyAgentPatchV2`

Keep the first reducer small:

- `agent-session-snapshot-v2` replaces full state.
- `agent-live-state-updated-v2` merges `live`.
- `agent-turn-started-v2` inserts or replaces a turn.
- `agent-item-started-v2` inserts or replaces an item in a turn.
- `agent-item-delta-v2` appends text/output to compatible item fields.
- `agent-item-updated-v2` shallow-replaces an item.
- `agent-turn-completed-v2` updates turn status and live status.
- `agent-error-v2` stores `live.error`.

- [ ] **Step 4: Document v1 deprecation**

Update `docs/WEB_CHAT.md` top section:

```md
> Agent Chat Protocol v2 is the canonical web-chat protocol. The older
> `ChatEvent` protocol is deprecated and exists only as a temporary migration
> input until all adapters and UI surfaces consume v2.
```

- [ ] **Step 5: Verify**

Run:

```bash
npm test -- test/agent-chat-protocol-v2.test.ts
npm run build
```

Expected: both pass.

- [ ] **Step 6: Commit**

```bash
git add shared/agent-chat-protocol-v2.ts test/agent-chat-protocol-v2.test.ts docs/WEB_CHAT.md
git commit -m "feat: add agent chat protocol v2 contract"
```

## Task 2: Add Temporary V1 Compatibility Module

**Files:**

- Create: `shared/agent-chat-v1-compat.ts`
- Create: `test/agent-chat-v1-compat.test.ts`

- [ ] **Step 1: Write compatibility tests**

Tests must prove:

- v1 text deltas map to an `assistantMessage` item delta.
- v1 approval requests map to an `approval` item and active request.
- v2 assistant-message deltas can still produce v1 `chat:text-delta` while legacy UI remains.
- The file comment says the module is temporary and names Task 9 as the removal task.

- [ ] **Step 2: Run the failing test**

Run: `npm test -- test/agent-chat-v1-compat.test.ts`

Expected: fail because module does not exist.

- [ ] **Step 3: Implement the compatibility module**

Implement named exports:

- `mapChatEventToAgentPatchV2(event: ChatEvent): AgentPatchV2[]`
- `mapAgentPatchV2ToChatEvents(patch: AgentPatchV2): ChatEvent[]`

Rules:

- The module must not be imported by new provider adapters.
- It may be imported only by web-session migration code and tests.
- It must preserve `sessionId`, `turnId`, `timestamp`, provider/source, message IDs, tool IDs, and request IDs.

- [ ] **Step 4: Verify**

Run:

```bash
npm test -- test/agent-chat-v1-compat.test.ts test/agent-chat-protocol-v2.test.ts
npm run build
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add shared/agent-chat-v1-compat.ts test/agent-chat-v1-compat.test.ts
git commit -m "feat: bridge legacy chat events to agent chat v2"
```

## Task 3: Add V2 Adapter Interface And Mock Adapter

**Files:**

- Create: `server/protocol-adapter-v2.ts`
- Create: `server/protocol-adapters/mock-v2-adapter.ts`
- Create: `test/mock-v2-adapter.test.ts`
- Modify: `server/protocol-adapters/index.ts`

- [ ] **Step 1: Write mock adapter tests**

Tests must cover:

- `connect()` emits an idle session live-state patch.
- `sendMessage()` emits user item, turn started, assistant item, text delta, item completed, turn completed.
- A queue scenario keeps the active turn running and emits queued live state for the second message.
- An approval scenario emits an `approval` item and request-opened patch, then resolves after `respondToApproval()`.
- `interrupt()` marks the running turn interrupted.

- [ ] **Step 2: Run failing tests**

Run: `npm test -- test/mock-v2-adapter.test.ts`

Expected: fail because v2 adapter files do not exist.

- [ ] **Step 3: Implement `ProtocolAdapterV2`**

`server/protocol-adapter-v2.ts` should mirror the old lifecycle but emit v2 patches:

- `connect(config): Promise<void>`
- `disconnect(): Promise<void>`
- `reconnect(): Promise<void>`
- `sendMessage(input: AgentSendMessageInputV2): Promise<void>`
- `interrupt(input: AgentInterruptInputV2): Promise<void>`
- `respondToApproval(input: AgentApprovalResponseInputV2): Promise<void>`
- `respondToInput(input: AgentInputResponseInputV2): Promise<void>`
- `onPatch(handler): () => void`
- readonly `capabilities`, `status`, `runtimeOwnership`, `agentType`

Include `BaseProtocolAdapterV2` with guarded patch emission.

- [ ] **Step 4: Implement `MockProtocolAdapterV2`**

Use deterministic IDs for test scenarios:

- message IDs: `user-${turnId}`, `assistant-${turnId}`
- approval request ID: `approval-${turnId}`
- tool ID: `tool-${turnId}`

- [ ] **Step 5: Verify**

Run:

```bash
npm test -- test/mock-v2-adapter.test.ts test/agent-chat-protocol-v2.test.ts
npm run build
```

Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add server/protocol-adapter-v2.ts server/protocol-adapters/mock-v2-adapter.ts server/protocol-adapters/index.ts test/mock-v2-adapter.test.ts
git commit -m "feat: add v2 protocol adapter interface"
```

## Task 4: Wire WebSession V2 State And WebSocket Protocol

**Files:**

- Create: `server/web-session-v2-state.ts`
- Create: `test/web-session-v2.test.ts`
- Modify: `server/types.ts`
- Modify: `server/web-session-handler.ts`
- Modify: `server/ws.ts`

- [ ] **Step 1: Write server tests**

Tests must cover:

- Creating a web session initializes `agentSessionV2`.
- Applying patches updates the v2 snapshot.
- Reconnecting to `/ws/:sessionId` sends `agent-session-snapshot-v2` before live patches.
- Client commands `agent-send-message-v2`, `agent-interrupt-v2`, `agent-approve-v2`, and `agent-answer-v2` call the v2 adapter methods.
- During migration, legacy `send-message`, `interrupt`, `approve`, and `input-response` still work through the compatibility bridge.

- [ ] **Step 2: Run failing tests**

Run: `npm test -- test/web-session-v2.test.ts`

Expected: fail because v2 web-session state is not wired.

- [ ] **Step 3: Implement v2 state helper**

`server/web-session-v2-state.ts` should export:

- `createInitialAgentSessionV2(params)`
- `applyWebSessionPatchV2(session, patch)`
- `pushAgentPatchToBuffer(session, patch)`
- `createAgentSessionSnapshotPatch(session)`

Patch buffer cap: 1000 patches. Preserve unresolved `agent-request-opened-v2` patches the same way v1 preserves approvals.

- [ ] **Step 4: Extend `WebSession` temporarily**

Add fields:

- `agentSessionV2: AgentSessionV2`
- `agentPatchesV2: AgentPatchV2[]`
- `protocolVersion: 2`

Keep `messages: ChatEvent[]` only until Task 9.

- [ ] **Step 5: Update WebSocket handling**

In `server/ws.ts`:

- On connect, send snapshot patch first.
- Then replay buffered v2 patches.
- Then stream live v2 patches.
- Accept v2 command names.
- Keep v1 command names only through compatibility code.

- [ ] **Step 6: Verify**

Run:

```bash
npm test -- test/web-session-v2.test.ts test/web-session-handler.test.ts
npm run build
```

Expected: pass.

- [ ] **Step 7: Commit**

```bash
git add server/web-session-v2-state.ts server/types.ts server/web-session-handler.ts server/ws.ts test/web-session-v2.test.ts
git commit -m "feat: stream agent chat v2 over web sessions"
```

## Task 5: Port Frontend To V2 State

**Files:**

- Create: `frontend/src/hooks/useAgentChatSocket.ts`
- Create: `frontend/src/components/chat-v2/AgentTimeline.tsx`
- Create: `frontend/src/components/chat-v2/AgentItemRenderer.tsx`
- Create: `frontend/src/components/chat-v2/AgentRequestPanel.tsx`
- Create: `test/frontend-agent-chat-v2.test.tsx`
- Modify: `frontend/src/components/chat/ChatView.tsx`

- [ ] **Step 1: Write frontend tests**

Tests must cover:

- Snapshot plus patches render ordered user and assistant messages.
- Reasoning item renders separately from assistant text.
- Command execution item renders command, status, and output.
- Approval request renders buttons and calls `agent-approve-v2`.
- Empty state still renders when a session has no turns.

- [ ] **Step 2: Run failing tests**

Run: `npm test -- test/frontend-agent-chat-v2.test.tsx`

Expected: fail because v2 frontend files do not exist.

- [ ] **Step 3: Implement v2 socket hook**

`useAgentChatSocket` should:

- Store `AgentSessionV2 | null`, not `ChatEvent[]`.
- Apply incoming `agent-*-v2` patches with `applyAgentPatchV2`.
- Send v2 command names.
- Keep ping/pong reconnect behavior from `useChatSocket`.

- [ ] **Step 4: Implement ordered item rendering**

Render based on `session.turns[].items[]`, not event grouping.

Initial item support:

- `userMessage`
- `assistantMessage`
- `reasoning`
- `commandExecution`
- `fileChange`
- `mcpToolCall`
- `dynamicToolCall`
- `approval`
- `question`
- `plan`
- `compaction`
- `providerExtension`

- [ ] **Step 5: Switch `ChatView` to v2**

Use v2 hook and timeline. Keep old `MessageTimeline` files untouched until Task 9 so rollback is easy.

- [ ] **Step 6: Verify locally**

Run:

```bash
npm test -- test/frontend-agent-chat-v2.test.tsx
npm run build
npm run dev
```

Then use `/browse` or Playwright against the dev server:

- Create a mock web session.
- Send a message.
- Confirm the user message appears.
- Confirm the assistant response appears.
- Trigger approval scenario.
- Confirm approval buttons resolve the request.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/hooks/useAgentChatSocket.ts frontend/src/components/chat-v2 test/frontend-agent-chat-v2.test.tsx frontend/src/components/chat/ChatView.tsx
git commit -m "feat: render web chat from agent chat v2 state"
```

## Task 6: Port Codex To Native App-Server V2

**Files:**

- Create: `server/protocol-adapters/codex-app-server-v2-adapter.ts`
- Create: `test/codex-app-server-v2-adapter.test.ts`
- Modify: `server/protocol-adapters/index.ts`

- [ ] **Step 1: Write mapping tests**

Use fixtures shaped like Codex app-server notifications:

- `thread/started`
- `turn/started`
- `item/started`
- `item/agentMessage/delta`
- `item/reasoning/textDelta`
- `item/commandExecution/outputDelta`
- `item/fileChange/patchUpdated`
- `item/completed`
- `turn/completed`
- approval and input server requests

- [ ] **Step 2: Implement stdio app-server client**

Spawn:

```bash
codex app-server --listen stdio://
```

Implement JSON-RPC framing, request IDs, notification dispatch, and process cleanup inside the adapter.

- [ ] **Step 3: Map Codex notifications to v2 patches**

Preserve:

- thread ID as `providerSession.threadId`
- turn IDs
- item IDs
- command process IDs
- file patches
- usage and model/reroute data where emitted

- [ ] **Step 4: Verify**

Run:

```bash
npm test -- test/codex-app-server-v2-adapter.test.ts
npm run build
codex app-server --help
```

If Codex is installed locally, run browser QA against a Codex web session.

- [ ] **Step 5: Commit**

```bash
git add server/protocol-adapters/codex-app-server-v2-adapter.ts server/protocol-adapters/index.ts test/codex-app-server-v2-adapter.test.ts
git commit -m "feat: drive codex web sessions through app-server v2"
```

## Task 7: Port Claude, OpenCode, And Hermes To V2

This task can split into three PRs if needed. Each provider must emit v2 patches directly; do not add new v1 mapping.

**Files:**

- Modify: `server/protocol-adapters/claude-adapter.ts` or create `server/protocol-adapters/claude-v2-adapter.ts`
- Modify: `server/protocol-adapters/opencode-adapter.ts` or create `server/protocol-adapters/opencode-v2-adapter.ts`
- Modify: `server/protocol-adapters/hermes-adapter.ts` or create `server/protocol-adapters/hermes-v2-adapter.ts`
- Add provider-specific tests under `test/*-v2-adapter.test.ts`

- [ ] **Step 1: Claude v2**

Use:

```bash
claude --print --output-format stream-json --input-format stream-json --include-partial-messages --include-hook-events
```

Map assistant messages, partial text, tool use, hook prompts, approvals, questions, plan mode when available, session IDs, and completion.

- [ ] **Step 2: OpenCode v2**

Map OpenCode session/server events into core v2 item types first:

- text
- tool calls
- command output
- file changes
- status/error
- interrupt

Preserve unknown fields in `providerExtension`.

- [ ] **Step 3: Hermes v2**

Replace the default `/v1/responses` assumption with observed Hermes web flow:

- session creation/listing
- chat start
- chat stream consumption
- token/reasoning/tool/approval/clarify/done/compressed/cancel/error events

If a specific installed Hermes gateway advertises a Responses endpoint, gate it behind endpoint detection and log which path was selected.

- [ ] **Step 4: Verify**

Run provider tests:

```bash
npm test -- test/claude-v2-adapter.test.ts test/opencode-v2-adapter.test.ts test/hermes-v2-adapter.test.ts
npm run build
```

Run browser QA against each installed provider that is available on the host.

- [ ] **Step 5: Commit**

Use one commit per provider:

```bash
git add server/protocol-adapters/claude-v2-adapter.ts test/claude-v2-adapter.test.ts
git commit -m "feat: port claude web sessions to agent chat v2"

git add server/protocol-adapters/opencode-v2-adapter.ts test/opencode-v2-adapter.test.ts
git commit -m "feat: port opencode web sessions to agent chat v2"

git add server/protocol-adapters/hermes-v2-adapter.ts test/hermes-v2-adapter.test.ts
git commit -m "feat: port hermes web sessions to agent chat v2"
```

## Task 8: End-To-End Browser And Production Log Verification

**Files:**

- Create: `docs/plans/agent-chat-v2-verification.md`
- Add or update Playwright/browser QA tests if the repo already has the right harness.

- [ ] **Step 1: Document verification script**

The doc must include exact local steps:

```bash
npm run build
npm run dev
```

Browser checks:

- Mock web session: message appears and response appears.
- Approval scenario: request appears and resolves.
- Interrupt scenario: turn becomes interrupted.
- Installed backend session: at least one of Codex, Claude, OpenCode, Hermes sends and receives visible messages.

Production checks:

- Observe prod logs during a web-session create/send cycle.
- Confirm no 500s for session creation.
- Confirm no silent dropped send-message commands.
- Confirm selected provider protocol path is logged.

- [ ] **Step 2: Run local browser QA**

Use `/browse` or Playwright against the local dev server. Capture the URL, provider, and observed result in the verification doc.

- [ ] **Step 3: Observe production logs**

Record exact log snippets or summaries in the verification doc, including timestamps and provider.

- [ ] **Step 4: Commit**

```bash
git add docs/plans/agent-chat-v2-verification.md
git commit -m "docs: add agent chat v2 verification checklist"
```

## Task 9: Remove V1

**Files:**

- Delete: `shared/chat-events.ts`
- Delete: `shared/agent-chat-v1-compat.ts`
- Delete or rewrite: v1 tests referencing `ChatEvent`
- Delete or rewrite: `frontend/src/hooks/useChatSocket.ts`
- Delete or rewrite: `frontend/src/components/chat/MessageTimeline.tsx` if fully replaced by v2 timeline
- Delete or rewrite: v1 adapter paths that emit `ChatEvent`
- Modify: `docs/WEB_CHAT.md`

- [ ] **Step 1: Confirm removal gate**

Run:

```bash
rg "ChatEvent|chat-events|chat:" server frontend shared test
```

Expected before deletion: only migration targets remain.

- [ ] **Step 2: Delete compatibility module and v1 types**

Remove `shared/chat-events.ts` and `shared/agent-chat-v1-compat.ts`.

- [ ] **Step 3: Remove legacy WebSession fields**

Remove:

- `messages: ChatEvent[]`
- v1 `pushToBuffer`
- legacy WebSocket command handling if no clients need it
- v1 replay path

- [ ] **Step 4: Remove old frontend v1 hook and event timeline**

Delete old files only after `ChatView` no longer imports them.

- [ ] **Step 5: Update docs**

`docs/WEB_CHAT.md` should describe only v2. Keep a short historical note:

```md
Relay previously used a flat `ChatEvent` protocol. It was removed after Agent
Chat Protocol v2 became the canonical web-chat state model.
```

- [ ] **Step 6: Verify**

Run:

```bash
rg "ChatEvent|chat-events|chat:" server frontend shared test
npm test
npm run build
```

Expected:

- `rg` returns no live implementation references.
- tests pass.
- build passes.

- [ ] **Step 7: Commit**

```bash
git add -A shared server frontend test docs/WEB_CHAT.md
git commit -m "refactor: remove legacy chat event protocol"
```

## Task 10: Close Tracking Issues And Update PR Notes

**Files:**

- Modify PR body or GitHub issues only.

- [ ] **Step 1: Search existing issues**

Run:

```bash
gh issue list --repo donovan-yohan/relay-ide --search "agent chat protocol OR web chat OR ChatEvent OR v2" --state all
```

- [ ] **Step 2: Create missing tracking issue if needed**

If no issue tracks v1 removal, create one:

```bash
gh issue create --repo donovan-yohan/relay-ide \
  --title "Deprecate and remove web chat v1 ChatEvent protocol" \
  --body "Agent Chat Protocol v2 is the canonical web-chat protocol. Remove v1 ChatEvent types, v1 WebSocket replay, v1 frontend event grouping, and the temporary v1 compatibility module after all providers emit v2." \
  --label improvement --label project:agent-platform --label p2-high
```

- [ ] **Step 3: Update final PR body**

PR body must include:

- The provider adapters migrated.
- The v1 removal status.
- Browser QA result.
- Production log observation result.
- Any provider capability gaps that are intentionally hidden in UI.

## Execution Order

Recommended PR split:

1. Contract and compatibility: Tasks 1-2.
2. Server v2 substrate: Tasks 3-4.
3. Frontend v2 rendering: Task 5.
4. Codex app-server: Task 6.
5. Claude/OpenCode/Hermes adapters: Task 7, split per provider if needed.
6. Verification and v1 removal: Tasks 8-10.

## Self-Review

- Spec coverage: protocol model, capabilities, provider strategies, migration, and v1 removal are represented by tasks.
- Placeholder scan: no implementation step relies on an unnamed future decision.
- Type consistency: v2 names are consistently `Agent*V2`, patch names use `agent-*-v2`, and v1 compatibility is isolated to `shared/agent-chat-v1-compat.ts`.
