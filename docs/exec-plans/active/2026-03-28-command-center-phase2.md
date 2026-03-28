# Command Center Phase 2: Registry + 15 HIGH-Priority Actions

> **Status**: Complete | **Created**: 2026-03-28 | **Last Updated**: 2026-03-28
> **Design Doc**: `docs/design-docs/2026-03-28-command-center-design.md`
> **Consulted Learnings**: L-20260324-exact-optional-types, L-20260321-nav-model-ui-flows, L-20260325-template-state-chain, L-20260325-dual-mobile-mechanism
> **For Claude:** Use /harness:orchestrate to execute this plan.

## Decision Log

| Date | Phase | Decision | Rationale |
|------|-------|----------|-----------|
| 2026-03-28 | Design | Registry-first approach (Approach A with C's north star) | Incremental, existing Spotlight keeps working during migration |
| 2026-03-28 | Design | Centralized registration in App.svelte | App.svelte owns most handlers already; distributing to leaf components adds ceremony |
| 2026-03-28 | Design | Basic 3-boolean context gating (not full ActionContext) | Phase 2 scope; full context derivation is Phase 4 |
| 2026-03-28 | Plan | Split registry into pure .ts (testable) + .svelte.ts (reactive) | .svelte.ts files use runes that can't run in node:test; pure .ts is testable via tsconfig.test.json |
| 2026-03-28 | Plan | PR actions use simplified handlers (navigate to view) | PR creation/push require complex state derivation; direct handlers deferred to Phase 3 |

## Progress

- [x] Task 1: Action types _(completed 2026-03-28)_
- [x] Task 2: Registry core (TDD) _(completed 2026-03-28)_
- [x] Task 3: Registry Svelte wrapper _(completed 2026-03-28)_
- [x] Task 4: Action definitions (15 HIGH-priority) _(completed 2026-03-28)_
- [x] Task 5: Register actions in App.svelte _(completed 2026-03-28)_
- [x] Task 6: Spotlight migration _(completed 2026-03-28)_
- [x] Task 7: Coverage test _(completed 2026-03-28)_

## Surprises & Discoveries

| Date | What | Plan Impact | Action Taken |
|------|------|-------------|--------------|
| 2026-03-28 | `exactOptionalPropertyTypes` required conditional spread for actionContext | None — same result, different syntax | Used `...(x ? { key: x } : {})` pattern per L-20260324 |

## Plan Drift

| Task | Plan Said | Actually Happened | Why |
|------|-----------|-------------------|-----|
| 5+6 | Separate commits for Task 5 and Task 6 | Combined into single commit | Co-dependent changes — Spotlight won't compile without actionContext prop, App won't compile without Spotlight accepting it |

---

## File Structure

**New files:**
| File | Responsibility |
|------|---------------|
| `frontend/src/lib/actions/types.ts` | Action, ActionMeta, ActionContext, ActionCategory type definitions |
| `frontend/src/lib/actions/registry.ts` | Core registry logic — pure Map-based, no Svelte runes, fully testable |
| `frontend/src/lib/actions/registry.svelte.ts` | Thin reactive wrapper — `$state` version counter for Svelte component reactivity |
| `frontend/src/lib/actions/definitions/session.ts` | 6 session ActionMeta objects |
| `frontend/src/lib/actions/definitions/workspace.ts` | 2 workspace ActionMeta objects |
| `frontend/src/lib/actions/definitions/pr.ts` | 3 PR/branch ActionMeta objects |
| `frontend/src/lib/actions/definitions/settings.ts` | 4 settings ActionMeta objects |
| `test/actions/registry.test.ts` | Registry unit tests (7 test cases) |
| `test/action-coverage.test.ts` | Coverage enforcement test (allowlist of 15 action IDs) |

**Modified files:**
| File | Change |
|------|--------|
| `frontend/src/App.svelte` | Import definitions, register actions with handler closures, pass context to Spotlight |
| `frontend/src/components/Spotlight.svelte` | Read commands from registry instead of hardcoded array, filter by `when()` context |
| `tsconfig.test.json` | Include new frontend files in test compilation |

---

### Task 1: Action Types

**Files:**
- Create: `frontend/src/lib/actions/types.ts`
- Modify: `tsconfig.test.json`

- [ ] **Step 1: Create the types file**

```typescript
// frontend/src/lib/actions/types.ts

export type ActionCategory = 'session' | 'workspace' | 'pr' | 'settings' | 'navigation' | 'terminal';

export type ActionContext = {
  view: 'workspace' | 'session' | 'dashboard' | 'settings' | 'org';
  workspaceId?: string;
  sessionId?: string;
  agentRunning?: boolean;
  isMobile?: boolean;
  prState?: 'none' | 'draft' | 'open' | 'merged' | 'closed';
};

export type Action = {
  id: string;
  label: string;
  description?: string;
  aliases?: string[];
  category: ActionCategory;
  icon?: string;
  shortcut?: { key: string; global?: boolean };
  when?: (ctx: ActionContext) => boolean;
  handler: (ctx: ActionContext) => void | Promise<void>;
  mobile?: { showInSheet?: boolean; label?: string };
};

export type ActionMeta = Omit<Action, 'handler'>;
```

- [ ] **Step 2: Add to tsconfig.test.json**

Add `"frontend/src/lib/actions/types.ts"` and `"frontend/src/lib/actions/registry.ts"` to the include array in `tsconfig.test.json`.

- [ ] **Step 3: Verify compilation**

Run: `npx tsc -p tsconfig.test.json --noEmit`
Expected: PASS (no errors)

- [ ] **Step 4: Commit**

```bash
git add frontend/src/lib/actions/types.ts tsconfig.test.json
git commit -m "feat: add action type definitions for command center registry"
```

---

### Task 2: Registry Core (TDD)

**Files:**
- Create: `frontend/src/lib/actions/registry.ts`
- Create: `test/actions/registry.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// test/actions/registry.test.ts
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  registerGlobal,
  registerContextual,
  unregisterContextual,
  getAction,
  getAllActions,
  getActionsByCategory,
  _resetForTesting,
} from '../../frontend/src/lib/actions/registry.js';
import type { Action } from '../../frontend/src/lib/actions/types.js';

function makeAction(overrides: Partial<Action> & { id: string }): Action {
  return {
    label: overrides.id,
    category: 'session',
    handler: () => {},
    ...overrides,
  };
}

describe('ActionRegistry', () => {
  beforeEach(() => {
    _resetForTesting();
  });

  it('registerGlobal adds actions retrievable via getAction', () => {
    const action = makeAction({ id: 'session.new-agent' });
    registerGlobal([action]);
    assert.deepStrictEqual(getAction('session.new-agent'), action);
  });

  it('registerGlobal with duplicate ID throws', () => {
    const action = makeAction({ id: 'session.new-agent' });
    registerGlobal([action]);
    assert.throws(
      () => registerGlobal([makeAction({ id: 'session.new-agent' })]),
      /already registered/
    );
  });

  it('registerContextual + unregisterContextual lifecycle', () => {
    const action = makeAction({ id: 'ctx.temp' });
    registerContextual([action]);
    assert.deepStrictEqual(getAction('ctx.temp'), action);
    unregisterContextual(['ctx.temp']);
    assert.strictEqual(getAction('ctx.temp'), undefined);
  });

  it('unregister action that was never registered is a no-op', () => {
    assert.doesNotThrow(() => unregisterContextual(['nonexistent']));
  });

  it('getAction returns undefined for unknown ID', () => {
    assert.strictEqual(getAction('nope'), undefined);
  });

  it('getAllActions returns global + contextual', () => {
    registerGlobal([makeAction({ id: 'a' })]);
    registerContextual([makeAction({ id: 'b' })]);
    const all = getAllActions();
    assert.strictEqual(all.length, 2);
    assert.ok(all.some(a => a.id === 'a'));
    assert.ok(all.some(a => a.id === 'b'));
  });

  it('getActionsByCategory filters correctly', () => {
    registerGlobal([
      makeAction({ id: 'session.a', category: 'session' }),
      makeAction({ id: 'pr.b', category: 'pr' }),
      makeAction({ id: 'session.c', category: 'session' }),
    ]);
    const sessions = getActionsByCategory('session');
    assert.strictEqual(sessions.length, 2);
    assert.ok(sessions.every(a => a.category === 'session'));
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx tsc -p tsconfig.test.json && node --test dist/test/actions/registry.test.js`
Expected: FAIL — module `registry.js` not found

- [ ] **Step 3: Implement the registry**

```typescript
// frontend/src/lib/actions/registry.ts
import type { Action, ActionCategory } from './types.js';

const globalActions = new Map<string, Action>();
const contextualActions = new Map<string, Action>();

export function registerGlobal(actions: Action[]): void {
  for (const action of actions) {
    if (globalActions.has(action.id) || contextualActions.has(action.id)) {
      throw new Error(`Action "${action.id}" is already registered`);
    }
    globalActions.set(action.id, action);
  }
}

export function registerContextual(actions: Action[]): void {
  for (const action of actions) {
    if (globalActions.has(action.id) || contextualActions.has(action.id)) {
      throw new Error(`Action "${action.id}" is already registered`);
    }
    contextualActions.set(action.id, action);
  }
}

export function unregisterContextual(ids: string[]): void {
  for (const id of ids) {
    contextualActions.delete(id);
  }
}

export function getAction(id: string): Action | undefined {
  return globalActions.get(id) ?? contextualActions.get(id);
}

export function getAllActions(): Action[] {
  return [...globalActions.values(), ...contextualActions.values()];
}

export function getActionsByCategory(category: ActionCategory): Action[] {
  return getAllActions().filter(a => a.category === category);
}

/** Reset all state — for testing only. */
export function _resetForTesting(): void {
  globalActions.clear();
  contextualActions.clear();
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsc -p tsconfig.test.json && node --test dist/test/actions/registry.test.js`
Expected: 7 tests PASS

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/actions/registry.ts test/actions/registry.test.ts
git commit -m "feat: action registry with full TDD coverage"
```

---

### Task 3: Registry Svelte Wrapper

**Files:**
- Create: `frontend/src/lib/actions/registry.svelte.ts`

The pure `registry.ts` works in Node tests but mutations aren't reactive in Svelte components. This thin wrapper adds a `$state` version counter that Svelte components depend on to re-derive when the registry changes.

- [ ] **Step 1: Create the reactive wrapper**

```typescript
// frontend/src/lib/actions/registry.svelte.ts
import {
  registerGlobal as _registerGlobal,
  registerContextual as _registerContextual,
  unregisterContextual as _unregisterContextual,
  getAction,
  getAllActions,
  getActionsByCategory,
} from './registry.js';
import type { Action } from './types.js';

let version = $state(0);

export function registerGlobal(actions: Action[]): void {
  _registerGlobal(actions);
  version++;
}

export function registerContextual(actions: Action[]): void {
  _registerContextual(actions);
  version++;
}

export function unregisterContextual(ids: string[]): void {
  _unregisterContextual(ids);
  version++;
}

/** Read inside $derived to track registry mutations. */
export function getRegistryVersion(): number {
  return version;
}

export { getAction, getAllActions, getActionsByCategory };
```

- [ ] **Step 2: Verify frontend builds**

Run: `cd frontend && npx svelte-check`
Expected: PASS (no type errors)

- [ ] **Step 3: Commit**

```bash
git add frontend/src/lib/actions/registry.svelte.ts
git commit -m "feat: reactive registry wrapper for Svelte 5 components"
```

---

### Task 4: Action Definitions (15 HIGH-Priority)

**Files:**
- Create: `frontend/src/lib/actions/definitions/session.ts`
- Create: `frontend/src/lib/actions/definitions/workspace.ts`
- Create: `frontend/src/lib/actions/definitions/pr.ts`
- Create: `frontend/src/lib/actions/definitions/settings.ts`

These files export `ActionMeta` objects (metadata only, no handlers). Handlers are bound in App.svelte (Task 5).

- [ ] **Step 1: Create session definitions**

```typescript
// frontend/src/lib/actions/definitions/session.ts
import type { ActionMeta } from '../types.js';

export const sessionNewAgent: ActionMeta = {
  id: 'session.new-agent',
  label: 'new agent session',
  description: 'start claude or codex',
  category: 'session',
  icon: '+',
  shortcut: { key: 'mod+t', global: true },
  when: (ctx) => !!ctx.workspaceId,
};

export const sessionNewTerminal: ActionMeta = {
  id: 'session.new-terminal',
  label: 'new terminal session',
  description: 'open a bare shell',
  category: 'session',
  icon: '+',
  when: (ctx) => !!ctx.workspaceId,
};

export const sessionCloseActive: ActionMeta = {
  id: 'session.close-active',
  label: 'close active session',
  description: 'close the current tab',
  category: 'session',
  icon: '×',
  shortcut: { key: 'mod+w' },
  when: (ctx) => !!ctx.sessionId,
};

export const sessionKill: ActionMeta = {
  id: 'session.kill',
  label: 'kill session',
  description: 'terminate the active session process',
  category: 'session',
  icon: '■',
  when: (ctx) => !!ctx.sessionId,
};

export const sessionStartOnRepo: ActionMeta = {
  id: 'session.start-on-repo',
  label: 'start session on repo',
  description: 'open agent on current workspace',
  category: 'session',
  icon: '▸',
  when: (ctx) => !!ctx.workspaceId,
};

export const sessionStartOnTicket: ActionMeta = {
  id: 'session.start-on-ticket',
  label: 'start work on ticket',
  description: 'pick a ticket and start coding',
  category: 'session',
  icon: '◆',
  when: (ctx) => !!ctx.workspaceId,
};

export const sessionActions: ActionMeta[] = [
  sessionNewAgent,
  sessionNewTerminal,
  sessionCloseActive,
  sessionKill,
  sessionStartOnRepo,
  sessionStartOnTicket,
];
```

- [ ] **Step 2: Create workspace definitions**

```typescript
// frontend/src/lib/actions/definitions/workspace.ts
import type { ActionMeta } from '../types.js';

export const workspaceAdd: ActionMeta = {
  id: 'workspace.add',
  label: 'add workspace',
  description: 'connect a repo',
  category: 'workspace',
  icon: '+',
};

export const workspaceNewWorktree: ActionMeta = {
  id: 'workspace.new-worktree',
  label: 'new worktree',
  description: 'create a branch and start coding',
  category: 'workspace',
  icon: '+',
  when: (ctx) => !!ctx.workspaceId,
};

export const workspaceActions: ActionMeta[] = [
  workspaceAdd,
  workspaceNewWorktree,
];
```

- [ ] **Step 3: Create PR definitions**

```typescript
// frontend/src/lib/actions/definitions/pr.ts
import type { ActionMeta } from '../types.js';

export const prCreate: ActionMeta = {
  id: 'pr.create',
  label: 'create pull request',
  description: 'open a PR for this branch',
  aliases: ['pr', 'pull request', 'open pr'],
  category: 'pr',
  icon: '⇗',
  when: (ctx) => !!ctx.workspaceId && ctx.prState !== 'open' && ctx.prState !== 'draft',
};

export const prPushBranch: ActionMeta = {
  id: 'pr.push-branch',
  label: 'push branch',
  description: 'push to remote',
  aliases: ['push', 'git push'],
  category: 'pr',
  icon: '↑',
  when: (ctx) => !!ctx.workspaceId,
};

export const prSwitchBranch: ActionMeta = {
  id: 'pr.switch-branch',
  label: 'switch branch',
  description: 'check out a different branch',
  aliases: ['checkout', 'branch'],
  category: 'pr',
  icon: '⇄',
  when: (ctx) => !!ctx.workspaceId,
};

export const prActions: ActionMeta[] = [
  prCreate,
  prPushBranch,
  prSwitchBranch,
];
```

- [ ] **Step 4: Create settings definitions**

```typescript
// frontend/src/lib/actions/definitions/settings.ts
import type { ActionMeta } from '../types.js';

export const settingsOpen: ActionMeta = {
  id: 'settings.open',
  label: 'open settings',
  description: 'app preferences and integrations',
  category: 'settings',
  icon: '>',
};

export const settingsConnectGithub: ActionMeta = {
  id: 'settings.connect-github',
  label: 'connect github',
  description: 'link your github account',
  category: 'settings',
  icon: '>',
};

export const settingsToggleYolo: ActionMeta = {
  id: 'settings.toggle-yolo',
  label: 'toggle yolo mode',
  description: 'skip permission checks',
  category: 'settings',
  icon: '⚡',
};

export const settingsCheckUpdates: ActionMeta = {
  id: 'settings.check-updates',
  label: 'check for updates',
  description: 'see if a new version is available',
  category: 'settings',
  icon: '↻',
};

export const settingsActions: ActionMeta[] = [
  settingsOpen,
  settingsConnectGithub,
  settingsToggleYolo,
  settingsCheckUpdates,
];
```

- [ ] **Step 5: Verify frontend builds**

Run: `cd frontend && npx svelte-check`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add frontend/src/lib/actions/definitions/
git commit -m "feat: define 15 HIGH-priority action metadata objects"
```

---

### Task 5: Register Actions in App.svelte

**Files:**
- Modify: `frontend/src/App.svelte`

Import all action metadata from definition files. In the `onMount` block, build full `Action` objects by spreading metadata + handler closures, then call `registerGlobal()`.

- [ ] **Step 1: Add imports to App.svelte**

Add after the existing imports at the top of `<script lang="ts">`:

```typescript
import { registerGlobal } from './lib/actions/registry.svelte.js';
import type { Action, ActionContext } from './lib/actions/types.js';
import { sessionNewAgent, sessionNewTerminal, sessionCloseActive, sessionKill, sessionStartOnRepo, sessionStartOnTicket } from './lib/actions/definitions/session.js';
import { workspaceAdd, workspaceNewWorktree } from './lib/actions/definitions/workspace.js';
import { prCreate, prPushBranch, prSwitchBranch } from './lib/actions/definitions/pr.js';
import { settingsOpen, settingsConnectGithub, settingsToggleYolo, settingsCheckUpdates } from './lib/actions/definitions/settings.js';
import { setDefaultYolo } from './lib/api.js';
```

- [ ] **Step 2: Register all actions in onMount**

Inside the existing `onMount(() => { ... })` block in App.svelte, add the following registration block. Place it near the top of onMount, before the keyboard listener setup:

```typescript
    // ── Action Registry ──────────────────────────────────
    registerGlobal([
      { ...sessionNewAgent, handler: () => handleQuickAgent() },
      { ...sessionNewTerminal, handler: () => handleQuickTerminal() },
      { ...sessionCloseActive, handler: () => {
        if (sessionState.activeSessionId) handleCloseSession(sessionState.activeSessionId);
      }},
      { ...sessionKill, handler: async () => {
        if (sessionState.activeSessionId) {
          await killSession(sessionState.activeSessionId);
          await refreshAll();
        }
      }},
      { ...sessionStartOnRepo, handler: () => handleQuickAgent() },
      { ...sessionStartOnTicket, handler: () => {
        // Navigate to workspace dashboard where ticket panel is visible
        if (sessionState.activeSessionId) sessionState.activeSessionId = null;
      }},
      { ...workspaceAdd, handler: () => addWorkspaceDialogRef?.open() },
      { ...workspaceNewWorktree, handler: () => {
        if (activeWorkspace) handleNewWorktree(activeWorkspace);
      }},
      { ...prCreate, handler: () => {
        // Navigate to dashboard where Create PR CTA is visible
        if (sessionState.activeSessionId) sessionState.activeSessionId = null;
      }},
      { ...prPushBranch, handler: () => {
        // Navigate to dashboard where Push Branch CTA is visible
        if (sessionState.activeSessionId) sessionState.activeSessionId = null;
      }},
      { ...prSwitchBranch, handler: () => {
        // Navigate to dashboard where BranchSwitcher is visible
        if (sessionState.activeSessionId) sessionState.activeSessionId = null;
      }},
      { ...settingsOpen, handler: () => handleOpenSettings() },
      { ...settingsConnectGithub, handler: () => settingsDialogRef?.open('section-integrations') },
      { ...settingsToggleYolo, handler: async () => {
        const newVal = !configState.defaultYolo;
        configState.defaultYolo = newVal;
        await setDefaultYolo(newVal);
      }},
      { ...settingsCheckUpdates, handler: () => settingsDialogRef?.open('section-about') },
    ] satisfies Action[]);
```

- [ ] **Step 3: Add actionContext derivation**

Add a reactive context derivation after the existing state declarations at the top of the `<script>` block (after line ~48 where `configState` is declared):

```typescript
  let actionContext = $derived<ActionContext>({
    view: sessionState.activeSessionId ? 'session'
      : ui.activeWorkspacePath ? 'workspace'
      : 'dashboard',
    workspaceId: ui.activeWorkspacePath ?? undefined,
    sessionId: sessionState.activeSessionId ?? undefined,
  });
```

- [ ] **Step 4: Pass actionContext to Spotlight**

Update the `<Spotlight>` component props in the template. Find the existing `<Spotlight` tag and add the `actionContext` prop:

```svelte
<Spotlight
  open={spotlightOpen}
  workspaces={sessionState.workspaces}
  sessions={sessionState.sessions}
  {actionContext}
  onClose={() => { spotlightOpen = false; }}
  onSelectWorkspace={(path) => { ui.activeWorkspacePath = path; sessionState.activeSessionId = null; closeSidebar(); }}
  onSelectSession={(id) => handleSelectSession(id)}
  onSelectPr={handleSpotlightSelectPr}
  onOpenSettings={(sectionId) => { settingsDialogRef?.open(sectionId); }}
/>
```

Note: The `onCommand` prop is removed here — command execution now goes through action handlers directly (implemented in Task 6). Remove `handleSpotlightCommand` function if it becomes unused after the Spotlight migration.

- [ ] **Step 5: Verify frontend builds**

Run: `cd frontend && npx svelte-check`
Expected: Will fail until Spotlight is updated (Task 6) to accept `actionContext` prop and remove `onCommand`. That's expected — proceed to Task 6.

- [ ] **Step 6: Commit (after Task 6)**

This task commits together with Task 6 since they're co-dependent.

---

### Task 6: Spotlight Migration

**Files:**
- Modify: `frontend/src/components/Spotlight.svelte`

Replace the hardcoded `commands` array with a registry lookup. Commands from the registry are filtered by `when()` context. When a command is selected, call `action.handler(ctx)` directly instead of the `onCommand` callback.

- [ ] **Step 1: Update Spotlight props**

Replace the props block to add `actionContext` and remove `onCommand`:

```typescript
  import { getAllActions, getRegistryVersion } from '../lib/actions/registry.svelte.js';
  import type { ActionContext, Action } from '../lib/actions/types.js';

  let {
    open = false,
    workspaces,
    sessions,
    actionContext,
    onClose,
    onSelectWorkspace,
    onSelectSession,
    onSelectPr,
    onOpenSettings,
  }: {
    open: boolean;
    workspaces: Workspace[];
    sessions: SessionSummary[];
    actionContext: ActionContext;
    onClose: () => void;
    onSelectWorkspace: (path: string) => void;
    onSelectSession: (id: string) => void;
    onSelectPr: (pr: PullRequest) => void;
    onOpenSettings?: (sectionId: string) => void;
  } = $props();
```

- [ ] **Step 2: Replace hardcoded commands with registry lookup**

Remove the hardcoded `commands` array (lines 65-69). Replace with a derived registry read:

```typescript
  // Commands from the action registry, filtered by current context
  let registryCommands = $derived.by(() => {
    void getRegistryVersion(); // track registry mutations
    return getAllActions().filter(a => !a.when || a.when(actionContext));
  });
```

- [ ] **Step 3: Update SpotlightResult type and results derivation**

Update the `SpotlightResult` command variant to hold an `Action` reference:

```typescript
  type SpotlightResult =
    | { type: 'workspace'; id: string; label: string; sublabel?: string; data: Workspace }
    | { type: 'session'; id: string; label: string; sublabel?: string; data: SessionSummary }
    | { type: 'pr' | 'attention'; id: string; label: string; sublabel?: string; data: PullRequest }
    | { type: 'ticket'; id: string; label: string; sublabel?: string; data: GitHubIssue | JiraIssue }
    | { type: 'command'; id: string; label: string; sublabel?: string; data: Action }
    | { type: 'setting'; id: string; label: string; sublabel?: string; data: { id: string; label: string; description: string; section: string } };
```

In the `results` derivation, replace the command-building sections. For the **default view** (no query), replace the `for (const cmd of commands)` block:

```typescript
      for (const action of registryCommands) {
        items.push({
          type: 'command',
          id: `cmd-${action.id}`,
          label: action.label,
          sublabel: action.description ?? '',
          data: action,
        });
      }
```

For the **search view** (query present), replace the `const cmdMatches = commands.filter(...)` block:

```typescript
    // Commands from registry
    const cmdMatches = registryCommands
      .filter(a =>
        a.label.toLowerCase().includes(q) ||
        (a.description?.toLowerCase().includes(q)) ||
        (a.aliases?.some(alias => alias.toLowerCase().includes(q)))
      );
    for (const action of cmdMatches) {
      items.push({
        type: 'command',
        id: `cmd-${action.id}`,
        label: action.label,
        sublabel: action.description ?? '',
        data: action,
      });
    }
```

- [ ] **Step 4: Update selectItem for command type**

In the `selectItem` function, update the `command` case to call the action handler directly:

```typescript
      case 'command':
        item.data.handler(actionContext);
        break;
```

- [ ] **Step 5: Update categoryIcon for commands**

In `categoryIcon`, the `'command'` case currently returns `'>'`. Update to use the action's icon:

No change needed — the icon display in the template uses `categoryIcon(item.type)` for the type, not per-item. For Phase 2, keep the generic `>` icon for commands. Per-action icons can be shown by updating the template:

In the template, replace the icon rendering for command results. Find the `{:else}` branch that renders `categoryIcon`:

```svelte
                {#if item.type === 'attention' || item.type === 'pr'}
                  <StatusDot status={derivePrDotStatus(item.data)} size={7} />
                {:else if item.type === 'command' && item.data.icon}
                  <span class="item-icon">{item.data.icon}</span>
                {:else}
                  <span class="item-icon">{@html categoryIcon(item.type)}</span>
                {/if}
```

Note: Uses `{:else if}` chain per learning L-20260325-template-state-chain to avoid duplicate rendering.

- [ ] **Step 6: Add shortcut badge display for commands**

In the template result row, add a shortcut badge after the sublabel when the action has a shortcut:

```svelte
                {#if item.sublabel}
                  <span class="item-sublabel">{item.sublabel}</span>
                {/if}
                {#if item.type === 'command' && item.data.shortcut}
                  <kbd class="item-shortcut">{formatShortcut(item.data.shortcut.key)}</kbd>
                {/if}
```

Add the `formatShortcut` helper function in the `<script>` block:

```typescript
  const isMac = typeof navigator !== 'undefined' && navigator.platform.toUpperCase().includes('MAC');

  function formatShortcut(key: string): string {
    return key
      .replace('mod', isMac ? '⌘' : 'ctrl')
      .replace('shift', '⇧')
      .split('+')
      .map(k => k.length === 1 ? k.toUpperCase() : k)
      .join('');
  }
```

Add the CSS for the shortcut badge:

```css
  .item-shortcut {
    font-family: var(--font-mono);
    font-size: var(--font-size-xs);
    color: var(--text-muted);
    border: 1px solid var(--border);
    padding: 1px 4px;
    flex-shrink: 0;
    opacity: 0.6;
  }
```

- [ ] **Step 7: Verify frontend builds**

Run: `cd frontend && npx svelte-check`
Expected: PASS

- [ ] **Step 8: Verify full build + tests**

Run: `npm run build && npm test`
Expected: PASS (all existing tests still pass, registry tests pass)

- [ ] **Step 9: Commit Tasks 5 + 6 together**

```bash
git add frontend/src/App.svelte frontend/src/components/Spotlight.svelte
git commit -m "feat: register 15 actions in App.svelte, migrate Spotlight to read from registry"
```

---

### Task 7: Coverage Test

**Files:**
- Create: `test/action-coverage.test.ts`
- Modify: `tsconfig.test.json` (add definition files to include)

- [ ] **Step 1: Add definition files to tsconfig.test.json**

Add all 4 definition files to the include array:

```
"frontend/src/lib/actions/definitions/session.ts",
"frontend/src/lib/actions/definitions/workspace.ts",
"frontend/src/lib/actions/definitions/pr.ts",
"frontend/src/lib/actions/definitions/settings.ts"
```

- [ ] **Step 2: Write the coverage test**

```typescript
// test/action-coverage.test.ts
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  registerGlobal,
  getAllActions,
  _resetForTesting,
} from '../frontend/src/lib/actions/registry.js';
import type { Action, ActionMeta } from '../frontend/src/lib/actions/types.js';
import { sessionActions } from '../frontend/src/lib/actions/definitions/session.js';
import { workspaceActions } from '../frontend/src/lib/actions/definitions/workspace.js';
import { prActions } from '../frontend/src/lib/actions/definitions/pr.js';
import { settingsActions } from '../frontend/src/lib/actions/definitions/settings.js';

// Phase 2 allowlist: 15 HIGH-priority action IDs
const PHASE2_ALLOWLIST = [
  'session.new-agent',
  'session.new-terminal',
  'session.close-active',
  'session.kill',
  'session.start-on-repo',
  'session.start-on-ticket',
  'workspace.add',
  'workspace.new-worktree',
  'pr.create',
  'pr.push-branch',
  'pr.switch-branch',
  'settings.open',
  'settings.connect-github',
  'settings.toggle-yolo',
  'settings.check-updates',
] as const;

const ALL_META: ActionMeta[] = [
  ...sessionActions,
  ...workspaceActions,
  ...prActions,
  ...settingsActions,
];

function toAction(meta: ActionMeta): Action {
  return { ...meta, handler: () => {} };
}

describe('Action Coverage', () => {
  beforeEach(() => {
    _resetForTesting();
  });

  it('all Phase 2 allowlist IDs have corresponding definitions', () => {
    const definedIds = new Set(ALL_META.map(a => a.id));
    const missing = PHASE2_ALLOWLIST.filter(id => !definedIds.has(id));
    assert.deepStrictEqual(missing, [], `Missing action definitions: ${missing.join(', ')}`);
  });

  it('all registered action IDs are unique', () => {
    registerGlobal(ALL_META.map(toAction));
    const all = getAllActions();
    const ids = all.map(a => a.id);
    const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
    assert.deepStrictEqual(dupes, [], `Duplicate action IDs: ${dupes.join(', ')}`);
  });

  it('all required Action fields are present and well-formed', () => {
    for (const meta of ALL_META) {
      assert.ok(meta.id, `Action missing id`);
      assert.ok(meta.id.includes('.'), `Action id "${meta.id}" must use category.verb-noun format`);
      assert.ok(meta.label, `Action "${meta.id}" missing label`);
      assert.ok(meta.category, `Action "${meta.id}" missing category`);
      assert.strictEqual(meta.label, meta.label.toLowerCase(), `Action "${meta.id}" label must be lowercase`);
    }
  });

  it('no conflicting keyboard shortcuts', () => {
    const shortcuts = ALL_META
      .filter(a => a.shortcut)
      .map(a => ({ id: a.id, key: a.shortcut!.key }));
    const seen = new Map<string, string>();
    for (const { id, key } of shortcuts) {
      if (seen.has(key)) {
        assert.fail(`Shortcut conflict: "${key}" claimed by both "${seen.get(key)}" and "${id}"`);
      }
      seen.set(key, id);
    }
  });
});
```

- [ ] **Step 3: Run the coverage test**

Run: `npx tsc -p tsconfig.test.json && node --test dist/test/action-coverage.test.js`
Expected: 4 tests PASS

- [ ] **Step 4: Run full test suite**

Run: `npm test`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add test/action-coverage.test.ts tsconfig.test.json
git commit -m "feat: action coverage test with Phase 2 allowlist enforcement"
```

---

## Deliverable Traceability

| Design Doc Deliverable | Plan Task |
|----------------------|-----------|
| Action type + ActionMeta type in types.ts | Task 1 |
| ActionRegistry in registry.svelte.ts (runes-based Map) | Task 2 + Task 3 |
| Define 15 HIGH-priority ActionMeta objects in definition files | Task 4 |
| Register all 15 in App.svelte with handler closures | Task 5 |
| Modify Spotlight.svelte to read from ActionRegistry | Task 6 |
| Basic context gating: 3 reactive booleans | Task 5 (actionContext) + Task 4 (when predicates) |
| Coverage test: test/action-coverage.test.ts with allowlist | Task 7 |

---

## Outcomes & Retrospective

**What worked:**
- Split registry into pure .ts + .svelte.ts — enabled full TDD while maintaining Svelte reactivity
- Parallel execution of independent tasks (3+4) cut orchestration time
- Co-dependent tasks (5+6) dispatched as single agent avoided broken intermediate state
- exactOptionalPropertyTypes learning (L-20260324) applied proactively — no type errors

**What didn't:**
- PR action handlers are navigational only (clear session → show dashboard). Phase 3 should add direct handlers that call the PR state machine

**Learnings to codify:**
- L-20260328-svelte-runes-testability: written to LEARNINGS.md
