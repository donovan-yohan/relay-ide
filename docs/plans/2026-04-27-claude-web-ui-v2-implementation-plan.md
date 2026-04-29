# Claude Web UI V2 + Multi-Provider Roadmap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land a chat.html-faithful Agent Chat Protocol V2 web UI with Claude working end-to-end, delete the V1 web-chat surface, then use the resulting provider-guide/SKILL to port Codex, OpenCode, and Hermes through stacked PRs.

**Architecture:** Normalize all web-chat traffic through `AgentPatchV2` and `AgentSessionV2`, with provider-only variance isolated in `providerExtension` renderer namespaces. Build UI first against `mock-v2`, then plug in Claude via `@anthropic-ai/claude-agent-sdk`, then extract repeatable provider-port patterns before porting Codex, OpenCode, and Hermes.

**Tech Stack:** TypeScript ESM, Express/WebSocket, `node-pty` for PTY mode, React 19, Vite, Vitest/happy-dom, Playwright, GitHub CLI (`gh`), git worktrees, stacked PRs.

---

## Source Documents

- Active design: `docs/plans/2026-04-27-claude-web-ui-v2-design.md`
- Active roadmap: `docs/plans/2026-04-27-multi-provider-roadmap.md`
- Superseded on landing: `docs/plans/2026-04-26-v1-to-v2-port.md`
- UI target: `docs/design-system/ui_kits/relay-web/chat.html`
- Design system guardrails: `DESIGN.md`

## Progress Ledger

| Stack | Branch                        | PR base                       | Status      | Owner          | Purpose                                             |
| ----- | ----------------------------- | ----------------------------- | ----------- | -------------- | --------------------------------------------------- |
| 0     | `feat/agent-chat-protocol-v2` | `nightly`                     | in progress | lead           | Existing V2 protocol foundation + design/plan docs  |
| 1     | `stack/v2-ui-mock`            | `feat/agent-chat-protocol-v2` | pending     | UI agent       | Phase A UI rebuild against mock-v2                  |
| 2     | `stack/v2-claude-adapter`     | `stack/v2-ui-mock`            | pending     | Adapter agent  | Phase B Claude SDK adapter                          |
| 3     | `stack/v2-v1-cutover`         | `stack/v2-claude-adapter`     | pending     | Cutover agent  | Remove V1 web-chat fallback and stale code          |
| 4     | `stack/v2-dogfood-guide`      | `stack/v2-v1-cutover`         | pending     | Lead + dogfood | Phase C dogfood log, provider guide, provider SKILL |
| 5     | `stack/v2-codex`              | `stack/v2-dogfood-guide`      | pending     | Provider agent | Codex V2 web adapter                                |
| 6     | `stack/v2-opencode`           | `stack/v2-codex`              | pending     | Provider agent | OpenCode V2 web adapter                             |
| 7     | `stack/v2-hermes`             | `stack/v2-opencode`           | pending     | Provider agent | Hermes V2 web adapter                               |
| 8     | `stack/v2-polish-telemetry`   | `stack/v2-hermes`             | pending     | Lead           | Telemetry, rate limit, resume polish                |

## Pi-Teams Tracking

Runtime team: `claude-web-ui-v2`

Initial team task map:

- Task 1: UI rebuild planning reconnaissance
- Task 2: Claude V2 adapter planning reconnaissance
- Task 3: V1 deletion and compatibility cutover reconnaissance
- Task 4: Worktree + stacked PR checkpoint plan
- Task 5: Write implementation plan and initialize progress tracking

If teammate spawning is available, assign one agent per stack branch. If teammate spawning is unavailable in the current terminal adapter, keep these tasks as the canonical tracker and execute/verify each stack in isolated worktrees manually.

---

## Git, Worktree, Commit, and PR Protocol

### Global rules

- Base all feature PRs on `nightly` directly or indirectly through the stack; never push directly to `master`.
- Use `.worktrees/` for implementation branches. It is already ignored by `.gitignore`.
- One worktree per stack branch. Do not implement multiple stack branches in one working directory.
- Commit after each coherent test-passing task, not after giant phases.
- Open PRs as drafts early with `gh pr create`; update PR bodies with test evidence after each checkpoint.
- When a lower stack branch changes, rebase upper stack branches in order and update PR bases if needed.

### Current repo state checkpoint

Current branch is `feat/agent-chat-protocol-v2`, ahead of `nightly` by the V2 foundation commits. There is an existing open PR:

- `#304 feat(claude-v2): native V2 protocol adapter (Conductor-aligned)` (`feat/v2-claude-adapter` → `feat/agent-chat-protocol-v2`)

Before implementation, decide whether to preserve PR #304 as a source branch or replace it with `stack/v2-claude-adapter`. If replacing it, close #304 with a comment linking the new stack PR. Do not let two Claude-adapter PRs diverge.

### Stack setup commands

Run from repo root after the plan/docs checkpoint commit lands:

```bash
git fetch origin

git worktree add .worktrees/v2-ui-mock -b stack/v2-ui-mock feat/agent-chat-protocol-v2
git worktree add .worktrees/v2-claude-adapter -b stack/v2-claude-adapter stack/v2-ui-mock
git worktree add .worktrees/v2-v1-cutover -b stack/v2-v1-cutover stack/v2-claude-adapter
git worktree add .worktrees/v2-dogfood-guide -b stack/v2-dogfood-guide stack/v2-v1-cutover
```

For later provider ports, create worktrees only when their base PR is reviewable:

```bash
git worktree add .worktrees/v2-codex -b stack/v2-codex stack/v2-dogfood-guide
git worktree add .worktrees/v2-opencode -b stack/v2-opencode stack/v2-codex
git worktree add .worktrees/v2-hermes -b stack/v2-hermes stack/v2-opencode
git worktree add .worktrees/v2-polish-telemetry -b stack/v2-polish-telemetry stack/v2-hermes
```

In each new worktree:

```bash
nvm use
npm install
npm run check
npm test
```

If baseline tests fail before any edits, stop and record the failure in the branch PR body before proceeding.

### PR creation commands

Root PR if absent:

```bash
gh pr create \
  --base nightly \
  --head feat/agent-chat-protocol-v2 \
  --title "feat: agent chat protocol v2 foundation" \
  --body-file docs/plans/2026-04-27-claude-web-ui-v2-implementation-plan.md \
  --draft
```

Stack PRs:

```bash
gh pr create --base feat/agent-chat-protocol-v2 --head stack/v2-ui-mock --title "feat(chat): rebuild web chat on AgentPatchV2 mock" --draft
gh pr create --base stack/v2-ui-mock --head stack/v2-claude-adapter --title "feat(claude): add native AgentPatchV2 web adapter" --draft
gh pr create --base stack/v2-claude-adapter --head stack/v2-v1-cutover --title "refactor(web-chat): remove V1 protocol fallback" --draft
gh pr create --base stack/v2-v1-cutover --head stack/v2-dogfood-guide --title "docs(agent-v2): add provider guide and provider-port skill" --draft
gh pr create --base stack/v2-dogfood-guide --head stack/v2-codex --title "feat(codex): port web sessions to AgentPatchV2" --draft
gh pr create --base stack/v2-codex --head stack/v2-opencode --title "feat(opencode): port web sessions to AgentPatchV2" --draft
gh pr create --base stack/v2-opencode --head stack/v2-hermes --title "feat(hermes): port web sessions to AgentPatchV2" --draft
gh pr create --base stack/v2-hermes --head stack/v2-polish-telemetry --title "feat(agent-v2): restore telemetry and provider polish" --draft
```

### Commit checkpoint pattern

Use conventional commits and include the stack name in the subject when helpful:

```bash
git add <exact files>
git commit -m "test(chat-v2): cover mock timeline primitives"
git commit -m "feat(chat-v2): render chat.html turn layout"
git commit -m "feat(claude-v2): map sdk tool events to AgentPatchV2"
git commit -m "refactor(web-chat): require V2 adapters for web sessions"
git commit -m "docs(agent-v2): document provider port recipe"
```

---

## File Responsibility Map

### Frozen or mostly frozen contracts

- `shared/agent-chat-protocol-v2.ts` — V2 wire/session schema and reducer. Only change if an existing schema has a verified bug; do not add provider-specific top-level patch types.
- `server/protocol-adapter-v2.ts` — V2 adapter interface/base. Only change for cross-provider requirements discovered during Claude implementation.
- `frontend/src/hooks/useAgentChatSocket.ts` — V2 WebSocket state hook. Keep as the single chat state source; change only for missing V2 commands or reconnection bugs.

### Phase A UI files

Create:

- `frontend/src/components/chat/Turn.tsx`
- `frontend/src/components/chat/TurnHeader.tsx`
- `frontend/src/components/chat/TurnFooter.tsx`
- `frontend/src/components/chat/LiveBar.tsx`
- `frontend/src/components/chat/QueueChips.tsx`
- `frontend/src/components/chat/SlashPalette.tsx`
- `frontend/src/components/chat/FileChangeRow.tsx`
- `frontend/src/components/chat/extensions/registry.ts`
- `frontend/src/components/chat/extensions/claude/EnterPlanModeCard.tsx`
- `frontend/src/components/chat/extensions/claude/FastModeUnavailableCard.tsx`
- `test/components/chat-v2-rendering.test.tsx`

Modify or rewrite:

- `frontend/src/components/chat/ChatView.tsx`
- `frontend/src/components/chat/ChatView.css`
- `frontend/src/components/chat/Composer.tsx`
- `frontend/src/components/chat/Composer.css`
- `frontend/src/components/chat/ToolCard.tsx`
- `frontend/src/components/chat/ToolCard.css`
- `frontend/src/components/chat/ApprovalCard.tsx`
- `frontend/src/components/chat/ApprovalCard.css`

Delete or replace:

- `frontend/src/components/chat/MessageTimeline.tsx`
- `frontend/src/components/chat/MessageTimeline.css`
- `frontend/src/components/chat/FileChangeCard.tsx`
- `frontend/src/components/chat/FileChangeCard.css`
- `frontend/src/components/chat-v2/AgentTimeline.tsx`
- `frontend/src/components/chat-v2/AgentItemRenderer.tsx`
- `frontend/src/components/chat-v2/AgentRequestPanel.tsx`

### Phase B Claude adapter files

Create:

- `test/server/protocol-adapters/claude-adapter.test.ts`
- `test/fixtures/claude-sdk/assistant-text.json`
- `test/fixtures/claude-sdk/tool-use-bash.json`
- `test/fixtures/claude-sdk/tool-use-edit.json`
- `test/fixtures/claude-sdk/approval-permission.json`
- `test/fixtures/claude-sdk/result-error.json`

Replace/modify:

- `server/protocol-adapters/claude-adapter.ts`
- `server/protocol-adapters/index.ts`
- `package.json`
- `package-lock.json`

### Phase C cutover/deletion files

Modify:

- `server/web-session-handler.ts`
- `server/ws.ts`
- `server/types.ts`
- `server/sessions.ts`
- `test/web-session-handler.test.ts`
- `test/web-session-v2.test.ts`
- `test/web-chat-integration.test.ts`

Delete:

- `server/protocol-adapter.ts`
- `server/protocol-adapters/mock-adapter.ts`
- `server/protocol-adapters/codex-adapter.ts`
- `server/protocol-adapters/opencode-adapter.ts`
- `server/protocol-adapters/opencode-attached-adapter.ts`
- `server/protocol-adapters/hermes-adapter.ts`
- `server/protocol-adapters/base-hook-adapter.ts`
- `server/protocol-adapters/attached-runtime-adapter.ts` unless a V2 attached adapter still imports it
- `shared/chat-events.ts`
- `shared/agent-chat-v1-compat.ts`
- `frontend/src/hooks/useChatSocket.ts`
- `test/chat-events.test.ts`
- `test/agent-chat-v1-compat.test.ts`

Rename:

- `server/protocol-adapters/mock-v2-adapter.ts` → `server/protocol-adapters/mock-adapter.ts`
- `test/mock-v2-adapter.test.ts` → `test/mock-adapter.test.ts`

Delete on final landing:

- `docs/plans/2026-04-26-v1-to-v2-port.md`

### Provider-guide and future provider files

Create:

- `docs/provider-guide.md`
- `.agents/skills/add-provider/SKILL.md`
- `docs/plans/2026-04-27-codex-v2-port.md`
- `docs/plans/2026-04-27-opencode-v2-port.md`
- `docs/plans/2026-04-27-hermes-v2-port.md`

Provider adapter replacements:

- `server/protocol-adapters/codex-adapter.ts`
- `server/protocol-adapters/opencode-adapter.ts`
- `server/protocol-adapters/hermes-adapter.ts`

---

## Stack 0 — Foundation, Docs, and Baseline

**Branch:** `feat/agent-chat-protocol-v2`  
**PR base:** `nightly`  
**Purpose:** Make the active design docs and this implementation plan visible in the stack, then establish a clean baseline.

- [ ] **Step 0.1: Stage only relevant planning docs**

  ```bash
  git add \
    docs/plans/2026-04-27-claude-web-ui-v2-design.md \
    docs/plans/2026-04-27-multi-provider-roadmap.md \
    docs/plans/2026-04-27-claude-web-ui-v2-implementation-plan.md
  ```

  Do not stage `.DS_Store`, `port-assignments.json`, or unrelated plan files unless explicitly requested.

- [ ] **Step 0.2: Commit the implementation plan**

  ```bash
  git commit -m "docs(agent-v2): plan claude web ui v2 stack"
  ```

- [ ] **Step 0.3: Create or update the root PR**

  ```bash
  gh pr view --head feat/agent-chat-protocol-v2 || gh pr create --base nightly --head feat/agent-chat-protocol-v2 --title "feat: agent chat protocol v2 foundation" --draft
  ```

- [ ] **Step 0.4: Baseline verification**

  ```bash
  npm run check
  npm test
  npm run build
  ```

  Expected: all commands pass before stack branches start. If not, record failures in this plan and in the root PR body.

---

## Stack 1 — Phase A UI Rebuild Against `mock-v2`

**Branch:** `stack/v2-ui-mock`  
**PR base:** `feat/agent-chat-protocol-v2`  
**Primary tests:** `test/components/chat-v2-rendering.test.tsx`, `test/frontend-agent-chat-v2.test.ts`, `test/mock-v2-adapter.test.ts`, `npm run check`

### Task 1.1: Capture chat.html primitives in tests first

**Files:**

- Create: `test/components/chat-v2-rendering.test.tsx`
- Modify: `test/frontend-agent-chat-v2.test.ts`

- [ ] Build a reduced `AgentSessionV2` fixture with one completed turn, one running turn, command execution, dynamic tool call, file change, approval, provider extension, live state, and queue length.
- [ ] Assert rendered DOM contains these design-target classes: `.tl`, `.turn`, `.turn-header`, `.turn-footer`, `.tl-text--user`, `.tcard`, `.tcard__h`, `.tcard__body`, `.fc-row`, `.acard`, `.live-bar`, `.queue`, `.slash`, `.composer`, `.composer__bar`, `.cbar-trigger`.
- [ ] Assert approval buttons call `approve(requestId, 'allow' | 'allow-always' | 'deny')` exactly.
- [ ] Assert `cancelQueued: false` hides queued-message cancel buttons and `cancelQueued: true` shows them.
- [ ] Run:

  ```bash
  npm test -- test/components/chat-v2-rendering.test.tsx test/frontend-agent-chat-v2.test.ts
  ```

  Expected before implementation: tests fail because the chat.html class structure is not present.

### Task 1.2: Replace the temporary `chat-v2` renderer with real chat components

**Files:**

- Create: `frontend/src/components/chat/Turn.tsx`
- Create: `frontend/src/components/chat/TurnHeader.tsx`
- Create: `frontend/src/components/chat/TurnFooter.tsx`
- Create: `frontend/src/components/chat/LiveBar.tsx`
- Create: `frontend/src/components/chat/QueueChips.tsx`
- Create: `frontend/src/components/chat/FileChangeRow.tsx`
- Modify: `frontend/src/components/chat/ChatView.tsx`
- Modify: `frontend/src/components/chat/ChatView.css`
- Delete after replacement: `frontend/src/components/chat-v2/AgentTimeline.tsx`, `frontend/src/components/chat-v2/AgentItemRenderer.tsx`, `frontend/src/components/chat-v2/AgentRequestPanel.tsx`

- [ ] Render `session.turns` through `Turn` components, not the old `AgentTimeline`.
- [ ] Render `userMessage` and `assistantMessage` as `.tl-text`; user messages must add `.tl-text--user`.
- [ ] Render `reasoning` above the first assistant answer in its turn, collapsed by default when `visibility === 'summary'`.
- [ ] Render `commandExecution`, `dynamicToolCall`, and `mcpToolCall` through `ToolCard`.
- [ ] Render `fileChange` through `FileChangeRow` using `.fc-row`, not a card.
- [ ] Render `approval` through the rebuilt `ApprovalCard`.
- [ ] Render `providerExtension` through the extension registry fallback until Claude-specific renderers exist.
- [ ] Preserve auto-stick scrolling behavior from the old timeline: scroll only when near bottom.
- [ ] Run:

  ```bash
  npm test -- test/components/chat-v2-rendering.test.tsx test/frontend-agent-chat-v2.test.ts
  npm run check
  ```

### Task 1.3: Rebuild `ToolCard`, `ApprovalCard`, and `Composer` against chat.html

**Files:**

- Modify: `frontend/src/components/chat/ToolCard.tsx`
- Modify: `frontend/src/components/chat/ToolCard.css`
- Modify: `frontend/src/components/chat/ApprovalCard.tsx`
- Modify: `frontend/src/components/chat/ApprovalCard.css`
- Modify: `frontend/src/components/chat/Composer.tsx`
- Modify: `frontend/src/components/chat/Composer.css`
- Create: `frontend/src/components/chat/SlashPalette.tsx`

- [ ] `ToolCard` header is a `<button class="tcard__h">` with `aria-expanded`; body uses `.tcard__body`.
- [ ] `ToolCard` status classes map `running`, `completed`, `failed`, `cancelled`, and `pending` to chat.html status classes.
- [ ] `ApprovalCard` uses `.acard`, `.acard__btn--allow`, `.acard__btn--always`, `.acard__btn--deny`; buttons disable after decision.
- [ ] `Composer` uses the V2 hook actions from `ChatView`, toggles send/interrupt based on live state, supports `Enter` to send and `Shift+Enter` for newline.
- [ ] `SlashPalette` appears only when `session.capabilities.slashCommands === true` and the draft starts with `/`.
- [ ] Context trigger (`.cbar-trigger`) shows latest turn `usage.contextPercent` when present.
- [ ] Run:

  ```bash
  npm test -- test/components/chat-v2-rendering.test.tsx
  npm run check
  ```

### Task 1.4: Make `mock-v2` exercise the full UI surface

**Files:**

- Modify: `server/protocol-adapters/mock-v2-adapter.ts`
- Modify: `test/mock-v2-adapter.test.ts`

- [ ] Expand `MockProtocolAdapterV2.capabilities` to advertise the UI superset: text, reasoning, tools, commandExecution, fileChanges, approvals, questions, plans, slashCommands, queue, interrupt, cancelQueued, resume, fork, rollback, compact, telemetry, rateLimits.
- [ ] Add deterministic patch emissions for reasoning, command execution, file change, approval, live state, queue, and provider extension items.
- [ ] Keep tests deterministic with zero-delay configuration.
- [ ] Run:

  ```bash
  npm test -- test/mock-v2-adapter.test.ts test/components/chat-v2-rendering.test.tsx
  npm run check
  ```

### Task 1.5: Checkpoint Stack 1

- [ ] Commit UI tests and implementation in small commits.
- [ ] Push and open draft PR:

  ```bash
  git push -u origin stack/v2-ui-mock
  gh pr create --base feat/agent-chat-protocol-v2 --head stack/v2-ui-mock --title "feat(chat): rebuild web chat on AgentPatchV2 mock" --draft
  ```

- [ ] Update the PR body with executed commands and screenshots if a browser pass is run.

---

## Stack 2 — Phase B Claude V2 Adapter

**Branch:** `stack/v2-claude-adapter`  
**PR base:** `stack/v2-ui-mock`  
**Primary tests:** `test/server/protocol-adapters/claude-adapter.test.ts`, `test/web-session-handler.test.ts`, `test/web-session-v2.test.ts`, `npm run check`

### Task 2.1: Add Claude SDK dependency and seam for deterministic tests

**Files:**

- Modify: `package.json`
- Modify: `package-lock.json`
- Replace: `server/protocol-adapters/claude-adapter.ts`
- Create: `test/server/protocol-adapters/claude-adapter.test.ts`

- [ ] Add `@anthropic-ai/claude-agent-sdk` pinned to the version verified during implementation.
- [ ] In `claude-adapter.ts`, expose a constructor dependency seam for the SDK `query()` function so tests can feed async-generator messages without spawning Claude.
- [ ] Ensure runtime sets `CLAUDE_CODE_ENTRYPOINT="sdk-ts"` for the SDK path.
- [ ] First failing test: `connect()` emits an `agent-session-snapshot-v2` or live-state patch with Claude capabilities and `providerSession.claudeSessionId` once an init/system event is observed.
- [ ] Run:

  ```bash
  npm test -- test/server/protocol-adapters/claude-adapter.test.ts
  ```

  Expected before implementation: failure because adapter is still V1 or missing SDK seam.

### Task 2.2: Implement lifecycle and queue

**Files:**

- Replace: `server/protocol-adapters/claude-adapter.ts`

- [ ] `connect(config)` stores config, marks status connected, and does not start `query()` until first `sendMessage`.
- [ ] `sendMessage(input)` starts the SDK generator when idle; when busy, buffers FIFO and emits `agent-live-state-updated-v2` with `queueLength`.
- [ ] `interrupt(input)` aborts the active generator using `AbortController` and emits `agent-turn-completed-v2 { status: 'interrupted' }` plus idle live state.
- [ ] `disconnect()` aborts active work, rejects/clears queued messages, clears approval resolvers, and marks status disconnected.
- [ ] Run:

  ```bash
  npm test -- test/server/protocol-adapters/claude-adapter.test.ts test/mock-v2-adapter.test.ts
  npm run check
  ```

### Task 2.3: Implement Claude SDK message mapping

**Files:**

- Replace: `server/protocol-adapters/claude-adapter.ts`
- Create fixtures under: `test/fixtures/claude-sdk/`

- [ ] Map `system/init` to session snapshot/provider session metadata.
- [ ] Map assistant text blocks to `assistantMessage` started/delta/updated patches using `msg-${turnId}-${blockIdx}`.
- [ ] Map thinking blocks to `reasoning` with `visibility: 'summary'`.
- [ ] Map `tool_use` for `Bash` to `commandExecution` keyed by Claude `tool_use.id`.
- [ ] Map `tool_use` for `Edit`, `Write`, and `MultiEdit` to `fileChange` keyed by Claude `tool_use.id`.
- [ ] Map other `tool_use` blocks to `dynamicToolCall { namespace: 'claude' }`.
- [ ] Map `tool_result` to an update of the matching item with `status: 'completed'`.
- [ ] Map `result` usage to `agent-turn-completed-v2.usage`.
- [ ] Map `result.subtype === 'error_during_execution'` to `agent-error-v2` and failed turn completion.
- [ ] Unknown SDK messages become `providerExtension { namespace: 'claude', payload: raw }` and log a warning signature.
- [ ] Run:

  ```bash
  npm test -- test/server/protocol-adapters/claude-adapter.test.ts
  npm run check
  ```

### Task 2.4: Implement approvals and Claude-specific extension renderers

**Files:**

- Replace: `server/protocol-adapters/claude-adapter.ts`
- Create: `frontend/src/components/chat/extensions/registry.ts`
- Create: `frontend/src/components/chat/extensions/claude/EnterPlanModeCard.tsx`
- Create: `frontend/src/components/chat/extensions/claude/FastModeUnavailableCard.tsx`
- Modify: `test/components/chat-v2-rendering.test.tsx`

- [ ] Hook `PreToolUse` permission waits on a `Map<requestId, resolver>`.
- [ ] Emit an `approval` item and live state `waitingOn: 'approval'` before awaiting the resolver.
- [ ] `respondToApproval()` resolves the pending hook promise and emits an approval item update with the decision.
- [ ] Map `EnterPlanMode` and `FastModeUnavailable` notifications to Claude provider-extension cards.
- [ ] Default registry fallback renders an unmapped debug card with namespace and payload kind.
- [ ] Run:

  ```bash
  npm test -- test/server/protocol-adapters/claude-adapter.test.ts test/components/chat-v2-rendering.test.tsx
  npm run check
  ```

### Task 2.5: Register Claude as a V2 adapter

**Files:**

- Modify: `server/protocol-adapters/index.ts`
- Modify: `test/web-session-handler.test.ts`
- Modify: `test/web-session-v2.test.ts`

- [ ] Add `claude: () => new ClaudeProtocolAdapter()` to `v2Adapters`.
- [ ] Keep non-Claude V1 web adapters untouched until Stack 3 cutover.
- [ ] Confirm `createWebSession({ agentType: 'claude' })` uses `adapterV2`, not compatibility mapping.
- [ ] Run:

  ```bash
  npm test -- test/server/protocol-adapters/claude-adapter.test.ts test/web-session-handler.test.ts test/web-session-v2.test.ts
  npm run check
  ```

### Task 2.6: Checkpoint Stack 2

- [ ] Rebase on latest Stack 1 after UI review feedback.
- [ ] Push and open/update PR:

  ```bash
  git push -u origin stack/v2-claude-adapter
  gh pr create --base stack/v2-ui-mock --head stack/v2-claude-adapter --title "feat(claude): add native AgentPatchV2 web adapter" --draft
  ```

- [ ] If PR #304 remains open, either retarget it to the new stack or close it with a migration note.

---

## Stack 3 — V1 Web-Chat Cutover and Deletion

**Branch:** `stack/v2-v1-cutover`  
**PR base:** `stack/v2-claude-adapter`  
**Primary tests:** full `npm test`, `npm run check`, `npm run build`

### Task 3.1: Gate non-ported providers explicitly

**Files:**

- Modify: `server/protocol-adapters/index.ts`
- Modify: `server/web-session-handler.ts`
- Modify: `test/web-session-handler.test.ts`

- [ ] Replace V1 fallback behavior with explicit V2 adapter creation.
- [ ] For `codex`, `opencode`, `opencode-attached`, and `hermes` web sessions, return a clear unsupported/unavailable error until their V2 stack lands.
- [ ] Confirm PTY mode paths are not touched.
- [ ] Run:

  ```bash
  npm test -- test/web-session-handler.test.ts test/web-session-v2.test.ts
  npm run check
  ```

### Task 3.2: Remove V1 WebSocket branches

**Files:**

- Modify: `server/ws.ts`
- Modify: `test/web-chat-integration.test.ts`

- [ ] Keep only `agent-send-message-v2`, `agent-interrupt-v2`, `agent-approve-v2`, and `agent-answer-v2` handling for web-chat agent sessions.
- [ ] Remove compatibility replay of `session.messages` through `mapChatEventToAgentPatchV2`.
- [ ] Reconnects replay `session.agentPatchesV2` or current `agentSessionV2`, not V1 messages.
- [ ] Run:

  ```bash
  npm test -- test/web-chat-integration.test.ts test/web-session-handler.test.ts
  npm run check
  ```

### Task 3.3: Remove V1 types, adapters, and frontend hook

**Files:** see Phase C deletion list above.

- [ ] Delete V1 protocol files and adapters listed in this plan.
- [ ] Rename `mock-v2-adapter.ts` to `mock-adapter.ts` and update imports/tests.
- [ ] Remove `WebSession.messages: ChatEvent[]` and V1 `adapter: ProtocolAdapter` from `server/types.ts`.
- [ ] Update `server/sessions.ts` persistence to no longer serialize V1 messages.
- [ ] Delete frontend `useChatSocket.ts` and old V1 chat component files.
- [ ] Delete V1 tests or rewrite them to V2 equivalents where they still cover useful behavior.
- [ ] Run:

  ```bash
  rg "chat-events|agent-chat-v1-compat|ProtocolAdapter|useChatSocket|messages: ChatEvent|createAdapter\(" server frontend shared test
  npm test
  npm run check
  npm run build
  ```

  Expected `rg`: no V1 web-chat protocol references remain, except in deleted-file history.

### Task 3.4: Delete superseded plan on landing branch

**Files:**

- Delete: `docs/plans/2026-04-26-v1-to-v2-port.md`

- [ ] Remove the superseded plan in Stack 3, not earlier, so reviewers can still compare context while UI/Claude stacks are under review.
- [ ] Commit:

  ```bash
  git add -A
  git commit -m "refactor(web-chat): delete v1 protocol surface"
  ```

### Task 3.5: Checkpoint Stack 3

- [ ] Push and open/update PR:

  ```bash
  git push -u origin stack/v2-v1-cutover
  gh pr create --base stack/v2-claude-adapter --head stack/v2-v1-cutover --title "refactor(web-chat): remove V1 protocol fallback" --draft
  ```

- [ ] Mark draft ready only after `npm test`, `npm run check`, and `npm run build` pass.

---

## Stack 4 — Phase C Dogfood, Provider Guide, and Provider Skill

**Branch:** `stack/v2-dogfood-guide`  
**PR base:** `stack/v2-v1-cutover`  
**Primary tests:** docs review, skill self-check, targeted UI tests

### Task 4.1: Dogfood Claude web sessions

**Files:**

- Create: `docs/plans/2026-04-27-claude-v2-dogfood-log.md`
- Modify as findings require: `server/protocol-adapters/claude-adapter.ts`, `frontend/src/components/chat/extensions/claude/*`, UI components/tests

- [ ] Use Claude web sessions for real coding tasks for about one week or until at least these events are exercised: text, thinking, Bash, Edit/Write/MultiEdit, approval allow, approval deny, interrupt, queued message, SDK error.
- [ ] For every unmapped event, log raw signature, provider namespace, desired renderer, and whether it should become core V2 or provider extension.
- [ ] Add renderer/tests for recurring Claude extensions.
- [ ] Run targeted tests after every fix:

  ```bash
  npm test -- test/server/protocol-adapters/claude-adapter.test.ts test/components/chat-v2-rendering.test.tsx
  npm run check
  ```

### Task 4.2: Write provider guide from empirical patterns

**Files:**

- Create: `docs/provider-guide.md`
- Modify: `docs/plans/2026-04-27-multi-provider-roadmap.md`

- [ ] Document native mapping table format.
- [ ] Document providerExtension policy.
- [ ] Document renderer registration.
- [ ] Document capability declaration semantics.
- [ ] Document lifecycle integration.
- [ ] Document item ID conventions.
- [ ] Document golden trace test pattern.

### Task 4.3: Add repo-local add-provider skill

**Files:**

- Create: `.agents/skills/add-provider/SKILL.md`

- [ ] Skill inputs: provider name, transport type, native event source, capability set.
- [ ] Skill outputs: adapter skeleton, mapping table skeleton, renderer registry hook, test fixture checklist, stacked PR checklist.
- [ ] Include explicit instruction to read `docs/provider-guide.md` before generating provider code.
- [ ] Run `chalkbag build` only if project workflow requires regenerating `.claude/` projections; do not hand-edit generated files.

### Task 4.4: Checkpoint Stack 4

- [ ] Push and open/update PR:

  ```bash
  git push -u origin stack/v2-dogfood-guide
  gh pr create --base stack/v2-v1-cutover --head stack/v2-dogfood-guide --title "docs(agent-v2): add provider guide and provider-port skill" --draft
  ```

---

## Stack 5 — Codex V2 Web Port

**Branch:** `stack/v2-codex`  
**PR base:** `stack/v2-dogfood-guide`

- [ ] Create `docs/plans/2026-04-27-codex-v2-port.md` using `docs/provider-guide.md`.
- [ ] Replace gated-unavailable Codex web adapter with `ProtocolAdapterV2` implementation using `codex app-server` JSON-RPC.
- [ ] Add `test/server/protocol-adapters/codex-adapter.test.ts` golden trace tests.
- [ ] Register `codex` in `v2Adapters`.
- [ ] Remove Codex unavailable gate.
- [ ] Run:

  ```bash
  npm test -- test/server/protocol-adapters/codex-adapter.test.ts test/web-session-handler.test.ts
  npm run check
  npm run build
  ```

- [ ] Open stacked PR:

  ```bash
  gh pr create --base stack/v2-dogfood-guide --head stack/v2-codex --title "feat(codex): port web sessions to AgentPatchV2" --draft
  ```

---

## Stack 6 — OpenCode V2 Web Port

**Branch:** `stack/v2-opencode`  
**PR base:** `stack/v2-codex`

- [ ] Create `docs/plans/2026-04-27-opencode-v2-port.md` using `docs/provider-guide.md`.
- [ ] Replace gated-unavailable OpenCode web adapter with `ProtocolAdapterV2` implementation using OpenCode public server events.
- [ ] Add `test/server/protocol-adapters/opencode-adapter.test.ts` golden trace tests.
- [ ] Register `opencode` in `v2Adapters`; decide whether `opencode-attached` remains a separate V2 provider key or folds into provider options.
- [ ] Remove OpenCode unavailable gate.
- [ ] Run:

  ```bash
  npm test -- test/server/protocol-adapters/opencode-adapter.test.ts test/web-session-handler.test.ts
  npm run check
  npm run build
  ```

- [ ] Open stacked PR:

  ```bash
  gh pr create --base stack/v2-codex --head stack/v2-opencode --title "feat(opencode): port web sessions to AgentPatchV2" --draft
  ```

---

## Stack 7 — Hermes V2 Web Port

**Branch:** `stack/v2-hermes`  
**PR base:** `stack/v2-opencode`

- [ ] Create `docs/plans/2026-04-27-hermes-v2-port.md` using `docs/provider-guide.md`.
- [ ] Replace gated-unavailable Hermes web adapter with `ProtocolAdapterV2` implementation using Hermes gateway client semantics.
- [ ] Add `test/server/protocol-adapters/hermes-adapter.test.ts` golden trace tests.
- [ ] Register `hermes` in `v2Adapters`.
- [ ] Remove Hermes unavailable gate.
- [ ] Run:

  ```bash
  npm test -- test/server/protocol-adapters/hermes-adapter.test.ts test/web-session-handler.test.ts
  npm run check
  npm run build
  ```

- [ ] Open stacked PR:

  ```bash
  gh pr create --base stack/v2-opencode --head stack/v2-hermes --title "feat(hermes): port web sessions to AgentPatchV2" --draft
  ```

---

## Stack 8 — Telemetry, Resume, and Provider Polish

**Branch:** `stack/v2-polish-telemetry`  
**PR base:** `stack/v2-hermes`

- [ ] Restore agentlytics/telemetry equivalents from V2 patches; use provider-keyed event names like `sidecar.<provider>.<verb>`.
- [ ] Decide and implement session resume semantics across reconnect: snapshot replay vs delta-since-last-seen.
- [ ] Add rate-limit display if providers expose rate-limit metadata.
- [ ] Add compact/slash command polish per provider capabilities.
- [ ] Run:

  ```bash
  npm test
  npm run check
  npm run build
  ```

- [ ] Open stacked PR:

  ```bash
  gh pr create --base stack/v2-hermes --head stack/v2-polish-telemetry --title "feat(agent-v2): restore telemetry and provider polish" --draft
  ```

---

## Verification Matrix

| Command                        | When to run                                                          | Required before ready-for-review |
| ------------------------------ | -------------------------------------------------------------------- | -------------------------------- |
| `npm test -- <targeted files>` | After each task                                                      | Yes, for touched subsystem       |
| `npm run check`                | Before every commit that changes TS/TSX                              | Yes                              |
| `npm test`                     | Before marking each stack PR ready                                   | Yes                              |
| `npm run build`                | Before Stack 3 and every provider port ready                         | Yes                              |
| `npm run test:e2e`             | Before final stack landing or if UI routing/session creation changes | Preferred                        |
| Manual Claude web dogfood      | Stack 4                                                              | Yes                              |

## Risk Controls

- **SDK drift:** pin `@anthropic-ai/claude-agent-sdk`; capture version in PR body and update mapping tests on upgrades.
- **Hook/tool race:** correlate every tool item by Claude `tool_use.id`; tests must include hook before block, block before hook, and missing hook cases.
- **Approval deadlocks:** all approval resolver promises must resolve or reject on disconnect/interrupt.
- **Queue semantics:** Claude exposes `cancelQueued: false`; UI must not show per-chip cancel for Claude.
- **Provider regression window:** Codex/OpenCode/Hermes web sessions are explicitly unavailable between Stack 3 and their provider stacks; PTY sessions must stay green.
- **Context poisoning:** delete replaced V1 files in Stack 3 and delete superseded docs on landing.
- **Stack drift:** after any lower-stack force-push, rebase upper stacks in order and rerun targeted tests.

## Completion Definition

This roadmap is complete when:

- Claude web sessions work end-to-end on `AgentPatchV2`.
- The chat UI matches `chat.html` primitives and follows `DESIGN.md`.
- V1 web-chat adapters, compatibility bridge, old hook, and old components are deleted.
- `docs/provider-guide.md` and `.agents/skills/add-provider/SKILL.md` exist and are based on dogfood findings.
- Codex, OpenCode, and Hermes web sessions are all restored as V2 adapters.
- `npm test`, `npm run check`, and `npm run build` pass on the final stack tip.
- All stack PRs are merged in order into `nightly`.
