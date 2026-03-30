# Command Center Phase 3: Shortcuts + Full Coverage

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Register remaining 42 MED/LOW-priority actions, build CommandPalette.svelte (replaces Spotlight), add ShortcutListener + ShortcutHint components, and add mobile palette trigger with hardware keyboard detection.

**Architecture:** Extend existing action registry with new categories (`sidebar`, `terminal`, `navigation`, `dashboard`, `org`, `ticket`) and 42 action definitions. Build CommandPalette as a superset of Spotlight (category tabs, mobile bottom sheet, frecency hooks). Replace scattered keydown listeners in App.svelte with a centralized ShortcutListener that reads from the registry. Terminal zoom/paste shortcuts stay in xterm's custom key handler.

**Tech Stack:** Svelte 5 runes, TypeScript, node:test, happy-dom (already a devDependency)

---

## Decision Log

| Date | Phase | Decision | Rationale |
|------|-------|----------|-----------|
| 2026-03-29 | Plan | Expand ActionCategory union to add `sidebar`, `terminal`, `navigation`, `dashboard`, `org`, `ticket` | Design doc maps ~42 MED/LOW actions across these categories |
| 2026-03-29 | Plan | Keep Terminal zoom/paste in xterm's customKeyHandler | xterm intercepts keys before document; moving to ShortcutListener would cause double-handling |
| 2026-03-29 | Plan | CommandPalette absorbs Spotlight's full resource search (workspaces, sessions, PRs, issues) | Design doc spec: "Existing Spotlight search becomes a resources section in CommandPalette" |
| 2026-03-29 | Plan | Tab navigation shortcuts (Cmd+1-9, Cmd+Shift+[/]) stay as global registry actions, not individual per-tab actions | They use a dynamic parameter (tab index) — register once with a handler that reads current state |
| 2026-03-29 | Plan | ShortcutListener lives in App.svelte as a `$effect` | It needs the same lifecycle as App — mount once, cleanup on destroy. No separate component needed. |

## Progress

- [ ] Task 1: Expand ActionCategory + add new definition files
- [ ] Task 2: Register sidebar actions (10 definitions)
- [ ] Task 3: Register session management actions (5 definitions)
- [ ] Task 4: Register PR/branch actions (8 definitions)
- [ ] Task 5: Register dashboard + org + ticket actions (9 definitions)
- [ ] Task 6: Register settings mutation actions (11 definitions)
- [ ] Task 7: Register terminal + navigation actions (5 definitions)
- [ ] Task 8: Update coverage test allowlist
- [ ] Task 9: Build ShortcutListener
- [ ] Task 10: Wire ShortcutListener in App.svelte, remove scattered listeners
- [ ] Task 11: Build ShortcutHint.svelte
- [ ] Task 12: Build CommandPalette.svelte
- [ ] Task 13: Swap Spotlight for CommandPalette in App.svelte
- [ ] Task 14: Mobile palette trigger + hardware keyboard detection
- [ ] Task 15: Final integration test + cleanup

## Surprises & Discoveries

| Date | What | Plan Impact | Action Taken |
|------|------|-------------|--------------|

## Plan Drift

| Task | Plan Said | Actually Happened | Why |
|------|-----------|-------------------|-----|

---

## File Structure

**New files:**
| File | Responsibility |
|------|---------------|
| `frontend/src/lib/actions/definitions/sidebar.ts` | 10 sidebar ActionMeta objects (collapse, workspace nav/settings, rename/kill session, delete worktree, resume session) |
| `frontend/src/lib/actions/definitions/dashboard.ts` | 4 dashboard + 5 org + 3 ticket ActionMeta objects |
| `frontend/src/lib/actions/definitions/terminal.ts` | 2 terminal ActionMeta objects (scroll top/bottom — zoom stays in xterm) |
| `frontend/src/lib/actions/definitions/navigation.ts` | 3 navigation ActionMeta objects (go dashboard, previous/next tab) |
| `frontend/src/lib/actions/shortcuts.ts` | ShortcutListener: `setupShortcutListener(getActions)` → single keydown handler + cleanup fn |
| `frontend/src/components/ShortcutHint.svelte` | Inline `<kbd>` shortcut badge, reads from registry |
| `frontend/src/components/CommandPalette.svelte` | Full command palette: desktop overlay + mobile bottom sheet, category tabs, shortcut badges |
| `test/actions/shortcuts.test.ts` | ShortcutListener unit tests (6 test cases) |

**Modified files:**
| File | Change |
|------|--------|
| `frontend/src/lib/actions/types.ts` | Add `sidebar`, `terminal`, `navigation`, `dashboard`, `org`, `ticket` to ActionCategory union |
| `frontend/src/lib/actions/definitions/session.ts` | Add 3 new session actions: customize, switch-to-tab, rename |
| `frontend/src/lib/actions/definitions/pr.ts` | Add 5 new PR actions: fix-conflicts, archive, rename-branch, copy-branch-name, open-externally |
| `frontend/src/lib/actions/definitions/settings.ts` | Add 7 new settings actions: disconnect-github, setup-webhooks, remove-webhook, connect-jira, toggle-continue, toggle-tmux, toggle-notifications |
| `frontend/src/App.svelte` | Register all 42 new actions, replace keydown block with ShortcutListener, swap Spotlight for CommandPalette |
| `frontend/src/components/MobileHeader.svelte` | Add `> command` trigger button |
| `frontend/src/lib/state/ui.svelte.ts` | Add `hasHardwareKeyboard` flag |
| `test/action-coverage.test.ts` | Expand allowlist from 15 to 57 action IDs, import new definition files |
| `tsconfig.test.json` | Add new definition files + shortcuts.ts to include array |

---

### Task 1: Expand ActionCategory + add new definition files

**Files:**
- Modify: `frontend/src/lib/actions/types.ts:1`
- Create: `frontend/src/lib/actions/definitions/sidebar.ts`
- Create: `frontend/src/lib/actions/definitions/dashboard.ts`
- Create: `frontend/src/lib/actions/definitions/terminal.ts`
- Create: `frontend/src/lib/actions/definitions/navigation.ts`
- Modify: `tsconfig.test.json`

- [ ] **Step 1: Expand ActionCategory union**

In `frontend/src/lib/actions/types.ts`, change line 1 from:

```typescript
export type ActionCategory = 'session' | 'workspace' | 'pr' | 'settings';
```

to:

```typescript
export type ActionCategory = 'session' | 'workspace' | 'pr' | 'settings' | 'sidebar' | 'terminal' | 'navigation' | 'dashboard' | 'org' | 'ticket';
```

- [ ] **Step 2: Create sidebar definitions**

Create `frontend/src/lib/actions/definitions/sidebar.ts`:

```typescript
import type { ActionMeta } from '../types.js';

export const sidebarCollapse: ActionMeta = {
  id: 'sidebar.collapse',
  label: 'toggle sidebar',
  description: 'collapse or expand the sidebar',
  category: 'sidebar',
  icon: '«',
};

export const sidebarNavigateDashboard: ActionMeta = {
  id: 'sidebar.navigate-dashboard',
  label: 'go to workspace dashboard',
  description: 'open the workspace overview',
  category: 'sidebar',
  icon: '■',
  when: (ctx) => !!ctx.workspacePath,
};

export const sidebarWorkspaceSettings: ActionMeta = {
  id: 'sidebar.workspace-settings',
  label: 'workspace settings',
  description: 'configure workspace preferences',
  category: 'sidebar',
  icon: '>',
  when: (ctx) => !!ctx.workspacePath,
};

export const sidebarRenameSession: ActionMeta = {
  id: 'sidebar.rename-session',
  label: 'rename session',
  description: 'change the display name of a session',
  category: 'sidebar',
  icon: '~',
  when: (ctx) => !!ctx.sessionId,
};

export const sidebarDeleteWorktree: ActionMeta = {
  id: 'sidebar.delete-worktree',
  label: 'delete worktree',
  description: 'remove a branch worktree',
  category: 'sidebar',
  icon: '×',
  when: (ctx) => !!ctx.workspacePath,
};

export const sidebarResumeSession: ActionMeta = {
  id: 'sidebar.resume-session',
  label: 'resume session on worktree',
  description: 'continue a previous session',
  category: 'sidebar',
  icon: '▸',
  when: (ctx) => !!ctx.workspacePath,
};

export const sidebarResumeYolo: ActionMeta = {
  id: 'sidebar.resume-yolo',
  label: 'resume session (yolo)',
  description: 'continue with yolo mode enabled',
  category: 'sidebar',
  icon: '!',
  when: (ctx) => !!ctx.workspacePath,
};

export const sidebarActions: ActionMeta[] = [
  sidebarCollapse,
  sidebarNavigateDashboard,
  sidebarWorkspaceSettings,
  sidebarRenameSession,
  sidebarDeleteWorktree,
  sidebarResumeSession,
  sidebarResumeYolo,
];
```

- [ ] **Step 3: Create dashboard/org/ticket definitions**

Create `frontend/src/lib/actions/definitions/dashboard.ts`:

```typescript
import type { ActionMeta } from '../types.js';

// ── Workspace Dashboard ──

export const dashboardOpenPrSession: ActionMeta = {
  id: 'dashboard.open-pr-session',
  label: 'open session on pr branch',
  description: 'start a session on a pull request branch',
  category: 'dashboard',
  icon: '+',
  when: (ctx) => !!ctx.workspacePath,
};

export const dashboardSortPrs: ActionMeta = {
  id: 'dashboard.sort-prs',
  label: 'sort pr table',
  description: 'change sort order for pull requests',
  category: 'dashboard',
  icon: '↕',
  when: (ctx) => !!ctx.workspacePath,
};

export const dashboardClearFilters: ActionMeta = {
  id: 'dashboard.clear-filters',
  label: 'clear filters',
  description: 'reset all active filters',
  category: 'dashboard',
  icon: '×',
};

// ── Org Dashboard ──

export const orgSwitchTab: ActionMeta = {
  id: 'org.switch-tab',
  label: 'switch prs/tickets tab',
  description: 'toggle between prs and tickets view',
  category: 'org',
  icon: '⇄',
};

export const orgSaveFilter: ActionMeta = {
  id: 'org.save-filter',
  label: 'save filter preset',
  description: 'save current filter configuration',
  category: 'org',
  icon: '+',
};

export const orgDeleteFilter: ActionMeta = {
  id: 'org.delete-filter',
  label: 'delete filter preset',
  description: 'remove a saved filter',
  category: 'org',
  icon: '×',
};

export const orgTogglePrStatus: ActionMeta = {
  id: 'org.toggle-pr-status',
  label: 'toggle pr status filter',
  description: 'show or hide prs by status',
  category: 'org',
  icon: '●',
};

export const orgNavigateToWorkspace: ActionMeta = {
  id: 'org.navigate-to-workspace',
  label: 'open workspace from pr',
  description: 'navigate to the workspace for a pull request',
  category: 'org',
  icon: '→',
};

// ── Ticket Actions ──

export const ticketSwitchProvider: ActionMeta = {
  id: 'ticket.switch-provider',
  label: 'switch github/jira tab',
  description: 'toggle between github and jira tickets',
  category: 'ticket',
  icon: '⇄',
};

export const ticketOpenExternal: ActionMeta = {
  id: 'ticket.open-external',
  label: 'open ticket externally',
  description: 'view ticket in browser',
  category: 'ticket',
  icon: '⇗',
};

export const dashboardActions: ActionMeta[] = [
  dashboardOpenPrSession,
  dashboardSortPrs,
  dashboardClearFilters,
  orgSwitchTab,
  orgSaveFilter,
  orgDeleteFilter,
  orgTogglePrStatus,
  orgNavigateToWorkspace,
  ticketSwitchProvider,
  ticketOpenExternal,
];
```

- [ ] **Step 4: Create terminal definitions**

Create `frontend/src/lib/actions/definitions/terminal.ts`:

```typescript
import type { ActionMeta } from '../types.js';

export const terminalScrollTop: ActionMeta = {
  id: 'terminal.scroll-top',
  label: 'scroll to top',
  description: 'scroll terminal output to the top',
  category: 'terminal',
  icon: '↑',
  when: (ctx) => !!ctx.sessionId,
};

export const terminalScrollBottom: ActionMeta = {
  id: 'terminal.scroll-bottom',
  label: 'scroll to bottom',
  description: 'scroll terminal output to the bottom',
  category: 'terminal',
  icon: '↓',
  when: (ctx) => !!ctx.sessionId,
};

export const terminalActions: ActionMeta[] = [
  terminalScrollTop,
  terminalScrollBottom,
];
```

- [ ] **Step 5: Create navigation definitions**

Create `frontend/src/lib/actions/definitions/navigation.ts`:

```typescript
import type { ActionMeta } from '../types.js';

export const navPreviousTab: ActionMeta = {
  id: 'navigation.previous-tab',
  label: 'previous tab',
  description: 'switch to the previous session tab',
  category: 'navigation',
  icon: '←',
  shortcut: { key: 'mod+shift+[' },
  when: (ctx) => !!ctx.sessionId,
};

export const navNextTab: ActionMeta = {
  id: 'navigation.next-tab',
  label: 'next tab',
  description: 'switch to the next session tab',
  category: 'navigation',
  icon: '→',
  shortcut: { key: 'mod+shift+]' },
  when: (ctx) => !!ctx.sessionId,
};

export const navSwitchToTab: ActionMeta = {
  id: 'navigation.switch-to-tab',
  label: 'switch to tab by number',
  description: 'jump to a specific session tab (1-9)',
  aliases: ['tab 1', 'tab 2', 'tab 3'],
  category: 'navigation',
  icon: '#',
};

export const navigationActions: ActionMeta[] = [
  navPreviousTab,
  navNextTab,
  navSwitchToTab,
];
```

- [ ] **Step 6: Add new files to tsconfig.test.json**

In `tsconfig.test.json`, update the `include` array to add:

```
"frontend/src/lib/actions/definitions/sidebar.ts",
"frontend/src/lib/actions/definitions/dashboard.ts",
"frontend/src/lib/actions/definitions/terminal.ts",
"frontend/src/lib/actions/definitions/navigation.ts",
"frontend/src/lib/actions/shortcuts.ts"
```

The full include array becomes:

```json
"include": ["server/**/*.ts", "bin/**/*.ts", "test/**/*.ts", "frontend/src/lib/pr-state.ts", "frontend/src/lib/state/display-state.ts", "frontend/src/lib/state/sidebar-items.ts", "frontend/src/lib/types.ts", "frontend/src/lib/diff-summary.ts", "frontend/src/lib/actions/types.ts", "frontend/src/lib/actions/registry.ts", "frontend/src/lib/actions/definitions/session.ts", "frontend/src/lib/actions/definitions/workspace.ts", "frontend/src/lib/actions/definitions/pr.ts", "frontend/src/lib/actions/definitions/settings.ts", "frontend/src/lib/actions/definitions/sidebar.ts", "frontend/src/lib/actions/definitions/dashboard.ts", "frontend/src/lib/actions/definitions/terminal.ts", "frontend/src/lib/actions/definitions/navigation.ts", "frontend/src/lib/actions/shortcuts.ts"]
```

- [ ] **Step 7: Run build to verify types compile**

Run: `npm run build 2>&1 | tail -5`
Expected: Build succeeds (warnings are ok, no errors)

- [ ] **Step 8: Commit**

```bash
git add frontend/src/lib/actions/types.ts frontend/src/lib/actions/definitions/sidebar.ts frontend/src/lib/actions/definitions/dashboard.ts frontend/src/lib/actions/definitions/terminal.ts frontend/src/lib/actions/definitions/navigation.ts tsconfig.test.json
git commit -m "feat: expand ActionCategory and add 22 MED/LOW action definitions (sidebar, dashboard, terminal, navigation)"
```

---

### Task 2: Expand session definitions

**Files:**
- Modify: `frontend/src/lib/actions/definitions/session.ts`

- [ ] **Step 1: Add new session actions**

Add to `frontend/src/lib/actions/definitions/session.ts`, before the `sessionActions` array:

```typescript
export const sessionCustomize: ActionMeta = {
  id: 'session.customize',
  label: 'customize session',
  description: 'configure agent and flags for a new session',
  category: 'session',
  icon: '>',
  when: (ctx) => !!ctx.workspacePath,
};

export const sessionSwitchToTab: ActionMeta = {
  id: 'session.switch-to-tab',
  label: 'switch to session tab',
  description: 'jump to a specific open session',
  category: 'session',
  icon: '→',
  when: (ctx) => !!ctx.sessionId,
};

export const sessionRename: ActionMeta = {
  id: 'session.rename',
  label: 'rename active session',
  description: 'change the display name of the current session',
  category: 'session',
  icon: '~',
  when: (ctx) => !!ctx.sessionId,
};
```

Update the `sessionActions` array to include the new ones:

```typescript
export const sessionActions: ActionMeta[] = [
  sessionNewAgent,
  sessionNewTerminal,
  sessionCloseActive,
  sessionKill,
  sessionStartOnRepo,
  sessionStartOnTicket,
  sessionCustomize,
  sessionSwitchToTab,
  sessionRename,
];
```

- [ ] **Step 2: Commit**

```bash
git add frontend/src/lib/actions/definitions/session.ts
git commit -m "feat: add 3 session MED-priority action definitions (customize, switch-to-tab, rename)"
```

---

### Task 3: Expand PR definitions

**Files:**
- Modify: `frontend/src/lib/actions/definitions/pr.ts`

- [ ] **Step 1: Add new PR actions**

Add to `frontend/src/lib/actions/definitions/pr.ts`, before the `prActions` array:

```typescript
export const prFixConflicts: ActionMeta = {
  id: 'pr.fix-conflicts',
  label: 'fix conflicts',
  description: 'resolve merge conflicts on current branch',
  category: 'pr',
  icon: '!',
  when: (ctx) => !!ctx.workspacePath,
};

export const prArchiveBranch: ActionMeta = {
  id: 'pr.archive-branch',
  label: 'archive branch',
  description: 'archive the current branch',
  category: 'pr',
  icon: '—',
  when: (ctx) => !!ctx.workspacePath,
};

export const prRenameBranch: ActionMeta = {
  id: 'pr.rename-branch',
  label: 'rename branch',
  description: 'change the current branch name',
  category: 'pr',
  icon: '~',
  when: (ctx) => !!ctx.workspacePath,
};

export const prCopyBranchName: ActionMeta = {
  id: 'pr.copy-branch-name',
  label: 'copy branch name',
  description: 'copy current branch name to clipboard',
  category: 'pr',
  icon: '⎘',
  when: (ctx) => !!ctx.workspacePath,
};

export const prOpenExternal: ActionMeta = {
  id: 'pr.open-external',
  label: 'open pr externally',
  description: 'view pull request in browser',
  aliases: ['github', 'open pr'],
  category: 'pr',
  icon: '⇗',
  when: (ctx) => !!ctx.workspacePath,
};

export const prRefresh: ActionMeta = {
  id: 'pr.refresh',
  label: 'refresh pr data',
  description: 'reload pr status and ci checks',
  category: 'pr',
  icon: '↻',
  when: (ctx) => !!ctx.workspacePath,
};

export const prChangeTarget: ActionMeta = {
  id: 'pr.change-target',
  label: 'change target branch',
  description: 'set a different base branch for the pr',
  category: 'pr',
  icon: '⇄',
  when: (ctx) => !!ctx.workspacePath,
};

export const prSkipChecks: ActionMeta = {
  id: 'pr.skip-checks',
  label: 'skip checks',
  description: 'bypass ci checks for this pr',
  category: 'pr',
  icon: '»',
  when: (ctx) => !!ctx.workspacePath,
};
```

Update the `prActions` array:

```typescript
export const prActions: ActionMeta[] = [
  prCreate,
  prPushBranch,
  prSwitchBranch,
  prFixConflicts,
  prArchiveBranch,
  prRenameBranch,
  prCopyBranchName,
  prOpenExternal,
  prRefresh,
  prChangeTarget,
  prSkipChecks,
];
```

- [ ] **Step 2: Commit**

```bash
git add frontend/src/lib/actions/definitions/pr.ts
git commit -m "feat: add 8 PR MED/LOW-priority action definitions"
```

---

### Task 4: Expand settings definitions

**Files:**
- Modify: `frontend/src/lib/actions/definitions/settings.ts`

- [ ] **Step 1: Add new settings actions**

Add to `frontend/src/lib/actions/definitions/settings.ts`, before the `settingsActions` array:

```typescript
export const settingsDisconnectGithub: ActionMeta = {
  id: 'settings.disconnect-github',
  label: 'disconnect github',
  description: 'remove github account connection',
  category: 'settings',
  icon: '×',
};

export const settingsSetupWebhooks: ActionMeta = {
  id: 'settings.setup-webhooks',
  label: 'setup webhooks',
  description: 'configure webhook integrations',
  category: 'settings',
  icon: '>',
};

export const settingsRemoveWebhook: ActionMeta = {
  id: 'settings.remove-webhook',
  label: 'remove webhook',
  description: 'delete a webhook configuration',
  category: 'settings',
  icon: '×',
};

export const settingsTestWebhook: ActionMeta = {
  id: 'settings.test-webhook',
  label: 'test webhook',
  description: 'send a test webhook payload',
  category: 'settings',
  icon: '▸',
};

export const settingsConnectJira: ActionMeta = {
  id: 'settings.connect-jira',
  label: 'connect jira',
  description: 'link your jira account',
  category: 'settings',
  icon: '>',
};

export const settingsDisconnectJira: ActionMeta = {
  id: 'settings.disconnect-jira',
  label: 'disconnect jira',
  description: 'remove jira account connection',
  category: 'settings',
  icon: '×',
};

export const settingsToggleDevTools: ActionMeta = {
  id: 'settings.toggle-devtools',
  label: 'toggle developer tools',
  description: 'show or hide debug panel',
  category: 'settings',
  icon: '>',
};

export const settingsClearAnalytics: ActionMeta = {
  id: 'settings.clear-analytics',
  label: 'clear analytics',
  description: 'delete local usage data',
  category: 'settings',
  icon: '×',
};

export const settingsToggleContinue: ActionMeta = {
  id: 'settings.toggle-continue',
  label: 'toggle continue session',
  description: 'resume last session when opening a repo',
  category: 'settings',
  icon: '↻',
};

export const settingsToggleTmux: ActionMeta = {
  id: 'settings.toggle-tmux',
  label: 'toggle tmux',
  description: 'wrap sessions in tmux',
  category: 'settings',
  icon: '>',
};

export const settingsToggleNotifications: ActionMeta = {
  id: 'settings.toggle-notifications',
  label: 'toggle notifications',
  description: 'enable or disable push notifications',
  category: 'settings',
  icon: '●',
};

export const settingsChangeDefaultAgent: ActionMeta = {
  id: 'settings.change-default-agent',
  label: 'change default agent',
  description: 'set the default coding agent',
  category: 'settings',
  icon: '>',
};
```

Update the `settingsActions` array:

```typescript
export const settingsActions: ActionMeta[] = [
  settingsOpen,
  settingsConnectGithub,
  settingsToggleYolo,
  settingsCheckUpdates,
  settingsDisconnectGithub,
  settingsSetupWebhooks,
  settingsRemoveWebhook,
  settingsTestWebhook,
  settingsConnectJira,
  settingsDisconnectJira,
  settingsToggleDevTools,
  settingsClearAnalytics,
  settingsToggleContinue,
  settingsToggleTmux,
  settingsToggleNotifications,
  settingsChangeDefaultAgent,
];
```

- [ ] **Step 2: Commit**

```bash
git add frontend/src/lib/actions/definitions/settings.ts
git commit -m "feat: add 12 settings MED/LOW-priority action definitions"
```

---

### Task 5: Update coverage test allowlist

**Files:**
- Modify: `test/action-coverage.test.ts`

- [ ] **Step 1: Expand the allowlist and imports**

Replace the entire `test/action-coverage.test.ts` with:

```typescript
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
import { sidebarActions } from '../frontend/src/lib/actions/definitions/sidebar.js';
import { dashboardActions } from '../frontend/src/lib/actions/definitions/dashboard.js';
import { terminalActions } from '../frontend/src/lib/actions/definitions/terminal.js';
import { navigationActions } from '../frontend/src/lib/actions/definitions/navigation.js';

// Full allowlist: 57 palettable action IDs (15 Phase 2 + 42 Phase 3)
const ACTION_ALLOWLIST = [
  // Session (9)
  'session.new-agent',
  'session.new-terminal',
  'session.close-active',
  'session.kill',
  'session.start-on-repo',
  'session.start-on-ticket',
  'session.customize',
  'session.switch-to-tab',
  'session.rename',
  // Workspace (2)
  'workspace.add',
  'workspace.new-worktree',
  // PR (11)
  'pr.create',
  'pr.push-branch',
  'pr.switch-branch',
  'pr.fix-conflicts',
  'pr.archive-branch',
  'pr.rename-branch',
  'pr.copy-branch-name',
  'pr.open-external',
  'pr.refresh',
  'pr.change-target',
  'pr.skip-checks',
  // Settings (16)
  'settings.open',
  'settings.connect-github',
  'settings.toggle-yolo',
  'settings.check-updates',
  'settings.disconnect-github',
  'settings.setup-webhooks',
  'settings.remove-webhook',
  'settings.test-webhook',
  'settings.connect-jira',
  'settings.disconnect-jira',
  'settings.toggle-devtools',
  'settings.clear-analytics',
  'settings.toggle-continue',
  'settings.toggle-tmux',
  'settings.toggle-notifications',
  'settings.change-default-agent',
  // Sidebar (7)
  'sidebar.collapse',
  'sidebar.navigate-dashboard',
  'sidebar.workspace-settings',
  'sidebar.rename-session',
  'sidebar.delete-worktree',
  'sidebar.resume-session',
  'sidebar.resume-yolo',
  // Dashboard (3)
  'dashboard.open-pr-session',
  'dashboard.sort-prs',
  'dashboard.clear-filters',
  // Org (5)
  'org.switch-tab',
  'org.save-filter',
  'org.delete-filter',
  'org.toggle-pr-status',
  'org.navigate-to-workspace',
  // Ticket (2)
  'ticket.switch-provider',
  'ticket.open-external',
  // Terminal (2)
  'terminal.scroll-top',
  'terminal.scroll-bottom',
  // Navigation (3)
  'navigation.previous-tab',
  'navigation.next-tab',
  'navigation.switch-to-tab',
] as const;

const ALL_META: ActionMeta[] = [
  ...sessionActions,
  ...workspaceActions,
  ...prActions,
  ...settingsActions,
  ...sidebarActions,
  ...dashboardActions,
  ...terminalActions,
  ...navigationActions,
];

function toAction(meta: ActionMeta): Action {
  return { ...meta, handler: () => {} };
}

describe('Action Coverage', () => {
  beforeEach(() => {
    _resetForTesting();
  });

  it('all allowlist IDs have corresponding definitions', () => {
    const definedIds = new Set(ALL_META.map(a => a.id));
    const missing = ACTION_ALLOWLIST.filter(id => !definedIds.has(id));
    assert.deepStrictEqual(missing, [], `Missing action definitions: ${missing.join(', ')}`);
  });

  it('all defined actions are in the allowlist', () => {
    const allowedIds = new Set<string>(ACTION_ALLOWLIST);
    const extra = ALL_META.filter(a => !allowedIds.has(a.id)).map(a => a.id);
    assert.deepStrictEqual(extra, [], `Defined actions not in allowlist: ${extra.join(', ')}`);
  });

  it('all registered action IDs are unique', () => {
    registerGlobal(ALL_META.map(toAction));
    const all = getAllActions();
    const ids = all.map((a: Action) => a.id);
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
      .filter((a: ActionMeta) => a.shortcut)
      .map((a: ActionMeta) => ({ id: a.id, key: a.shortcut!.key }));
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

- [ ] **Step 2: Run tests**

Run: `npm test 2>&1 | grep -E "action-coverage|PASS|FAIL|✓|✖"`
Expected: All 5 action coverage tests pass

- [ ] **Step 3: Commit**

```bash
git add test/action-coverage.test.ts
git commit -m "feat: expand coverage allowlist from 15 to 60 action IDs"
```

---

### Task 6: Register all new actions in App.svelte

**Files:**
- Modify: `frontend/src/App.svelte:14-19` (imports)
- Modify: `frontend/src/App.svelte:115-154` (registerGlobal block)

- [ ] **Step 1: Add imports for new definition files**

After the existing action definition imports (lines 16-19), add:

```typescript
import { sidebarActions as sidebarMeta } from './lib/actions/definitions/sidebar.js';
import { dashboardActions as dashboardMeta } from './lib/actions/definitions/dashboard.js';
import { terminalActions as terminalMeta } from './lib/actions/definitions/terminal.js';
import { navigationActions as navigationMeta } from './lib/actions/definitions/navigation.js';
```

Also import the new individual action exports that need specific handlers:

```typescript
import { sessionCustomize, sessionSwitchToTab, sessionRename } from './lib/actions/definitions/session.js';
import { prFixConflicts, prArchiveBranch, prRenameBranch, prCopyBranchName, prOpenExternal, prRefresh, prChangeTarget, prSkipChecks } from './lib/actions/definitions/pr.js';
import { settingsDisconnectGithub, settingsSetupWebhooks, settingsRemoveWebhook, settingsTestWebhook, settingsConnectJira, settingsDisconnectJira, settingsToggleDevTools, settingsClearAnalytics, settingsToggleContinue, settingsToggleTmux, settingsToggleNotifications, settingsChangeDefaultAgent } from './lib/actions/definitions/settings.js';
import { sidebarCollapse, sidebarNavigateDashboard, sidebarWorkspaceSettings, sidebarRenameSession, sidebarDeleteWorktree, sidebarResumeSession, sidebarResumeYolo } from './lib/actions/definitions/sidebar.js';
import { dashboardOpenPrSession, dashboardSortPrs, dashboardClearFilters, orgSwitchTab, orgSaveFilter, orgDeleteFilter, orgTogglePrStatus, orgNavigateToWorkspace, ticketSwitchProvider, ticketOpenExternal } from './lib/actions/definitions/dashboard.js';
import { terminalScrollTop, terminalScrollBottom } from './lib/actions/definitions/terminal.js';
import { navPreviousTab, navNextTab, navSwitchToTab } from './lib/actions/definitions/navigation.js';
```

- [ ] **Step 2: Add new action registrations**

After the existing `registerGlobal([...])` block's closing `] satisfies Action[])`, add the Phase 3 actions. Alternatively, merge them into the existing `registerGlobal` call. The cleanest approach is to add them to the existing array.

Add these entries inside the existing `registerGlobal([ ... ])` call, after `settingsCheckUpdates`:

```typescript
      // ── Phase 3: Session ──
      { ...sessionCustomize, handler: () => customizeDialogRef?.open() },
      { ...sessionSwitchToTab, handler: () => {} }, // handled by ShortcutListener (Cmd+1-9)
      { ...sessionRename, handler: () => {
        const name = prompt('rename session:');
        if (name?.trim() && sessionState.activeSessionId) {
          renameSession(sessionState.activeSessionId, name.trim());
        }
      }},
      // ── Phase 3: PR ──
      { ...prFixConflicts, handler: () => navigateToDashboard() },
      { ...prArchiveBranch, handler: () => navigateToDashboard() },
      { ...prRenameBranch, handler: () => navigateToDashboard() },
      { ...prCopyBranchName, handler: async () => {
        // Copy active workspace branch name to clipboard
        const sessions = workspaceSessions;
        const branch = sessions[0]?.branchName;
        if (branch) await navigator.clipboard.writeText(branch);
      }},
      { ...prOpenExternal, handler: () => navigateToDashboard() },
      { ...prRefresh, handler: async () => {
        await refreshAll();
      }},
      { ...prChangeTarget, handler: () => navigateToDashboard() },
      { ...prSkipChecks, handler: () => navigateToDashboard() },
      // ── Phase 3: Settings ──
      { ...settingsDisconnectGithub, handler: () => settingsDialogRef?.open('section-integrations') },
      { ...settingsSetupWebhooks, handler: () => settingsDialogRef?.open('section-integrations') },
      { ...settingsRemoveWebhook, handler: () => settingsDialogRef?.open('section-integrations') },
      { ...settingsTestWebhook, handler: () => settingsDialogRef?.open('section-integrations') },
      { ...settingsConnectJira, handler: () => settingsDialogRef?.open('section-integrations') },
      { ...settingsDisconnectJira, handler: () => settingsDialogRef?.open('section-integrations') },
      { ...settingsToggleDevTools, handler: () => settingsDialogRef?.open('section-advanced') },
      { ...settingsClearAnalytics, handler: () => settingsDialogRef?.open('section-advanced') },
      { ...settingsToggleContinue, handler: () => settingsDialogRef?.open('section-general') },
      { ...settingsToggleTmux, handler: () => settingsDialogRef?.open('section-general') },
      { ...settingsToggleNotifications, handler: () => settingsDialogRef?.open('section-general') },
      { ...settingsChangeDefaultAgent, handler: () => settingsDialogRef?.open('section-general') },
      // ── Phase 3: Sidebar ──
      { ...sidebarCollapse, handler: () => toggleSidebarCollapsed() },
      { ...sidebarNavigateDashboard, handler: () => navigateToDashboard() },
      { ...sidebarWorkspaceSettings, handler: () => {
        if (activeWorkspace) workspaceSettingsDialogRef?.open();
      }},
      { ...sidebarRenameSession, handler: () => {
        const name = prompt('rename session:');
        if (name?.trim() && sessionState.activeSessionId) {
          renameSession(sessionState.activeSessionId, name.trim());
        }
      }},
      { ...sidebarDeleteWorktree, handler: () => {
        if (activeWorkspace) deleteWorktreeDialogRef?.open();
      }},
      { ...sidebarResumeSession, handler: () => handleQuickAgent() },
      { ...sidebarResumeYolo, handler: () => handleQuickAgent() }, // TODO: pass yolo flag
      // ── Phase 3: Dashboard/Org/Ticket ──
      { ...dashboardOpenPrSession, handler: () => handleQuickAgent() },
      { ...dashboardSortPrs, handler: () => {} }, // UI-only action, no-op from palette
      { ...dashboardClearFilters, handler: () => {} }, // UI-only action, no-op from palette
      { ...orgSwitchTab, handler: () => {} },
      { ...orgSaveFilter, handler: () => {} },
      { ...orgDeleteFilter, handler: () => {} },
      { ...orgTogglePrStatus, handler: () => {} },
      { ...orgNavigateToWorkspace, handler: () => {} },
      { ...ticketSwitchProvider, handler: () => {} },
      { ...ticketOpenExternal, handler: () => {} },
      // ── Phase 3: Terminal ──
      { ...terminalScrollTop, handler: () => terminalRef?.scrollToTop?.() },
      { ...terminalScrollBottom, handler: () => terminalRef?.scrollToBottom?.() },
      // ── Phase 3: Navigation ──
      { ...navPreviousTab, handler: () => {
        const sessions = workspaceSessions;
        if (sessions.length === 0) return;
        const idx = sessions.findIndex(s => s.id === sessionState.activeSessionId);
        const prev = idx <= 0 ? sessions[sessions.length - 1] : sessions[idx - 1];
        if (prev) handleSelectSession(prev.id);
      }},
      { ...navNextTab, handler: () => {
        const sessions = workspaceSessions;
        if (sessions.length === 0) return;
        const idx = sessions.findIndex(s => s.id === sessionState.activeSessionId);
        const next = idx === -1 || idx === sessions.length - 1 ? sessions[0] : sessions[idx + 1];
        if (next) handleSelectSession(next.id);
      }},
      { ...navSwitchToTab, handler: () => {} }, // handled by Cmd+1-9 in ShortcutListener
```

Also add the import for `toggleSidebarCollapsed`:

```typescript
import { getUi, openSidebar, closeSidebar, toggleSidebarCollapsed } from './lib/state/ui.svelte.js';
```

And add the `renameSession` import from api.ts (check if it's already imported — the state version is different):

```typescript
import { renameSession as renameSessionApi } from './lib/api.js';
```

Note: Use `renameSessionApi` in the handlers that need the API call. Check which `renameSession` is already in scope — the state version at line 5 just updates local state, while the API version persists the change. Use the API version for the palette handlers.

- [ ] **Step 3: Build to verify**

Run: `npm run build 2>&1 | tail -5`
Expected: Build succeeds

- [ ] **Step 4: Run tests to verify**

Run: `npm test 2>&1 | grep -E "action-coverage|PASS|FAIL|✓|✖"`
Expected: All coverage tests pass

- [ ] **Step 5: Commit**

```bash
git add frontend/src/App.svelte
git commit -m "feat: register 42 Phase 3 actions in App.svelte"
```

---

### Task 7: Build ShortcutListener (TDD)

**Files:**
- Create: `frontend/src/lib/actions/shortcuts.ts`
- Create: `test/actions/shortcuts.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `test/actions/shortcuts.test.ts`:

```typescript
import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { parseShortcut, matchesShortcut, formatShortcut } from '../../frontend/src/lib/actions/shortcuts.js';

describe('ShortcutListener', () => {
  describe('parseShortcut', () => {
    it('parses mod+t into platform-aware key combo', () => {
      const result = parseShortcut('mod+t');
      assert.deepStrictEqual(result, { mod: true, shift: false, key: 't' });
    });

    it('parses mod+shift+[ into key combo', () => {
      const result = parseShortcut('mod+shift+[');
      assert.deepStrictEqual(result, { mod: true, shift: true, key: '[' });
    });

    it('parses single key', () => {
      const result = parseShortcut('escape');
      assert.deepStrictEqual(result, { mod: false, shift: false, key: 'escape' });
    });
  });

  describe('matchesShortcut', () => {
    it('matches mod+t when metaKey is true on mac', () => {
      const parsed = parseShortcut('mod+t');
      const event = { metaKey: true, ctrlKey: false, shiftKey: false, key: 't' };
      assert.ok(matchesShortcut(event as KeyboardEvent, parsed, true));
    });

    it('matches mod+t when ctrlKey is true on non-mac', () => {
      const parsed = parseShortcut('mod+t');
      const event = { metaKey: false, ctrlKey: true, shiftKey: false, key: 't' };
      assert.ok(matchesShortcut(event as KeyboardEvent, parsed, false));
    });

    it('does not match when shift is required but not pressed', () => {
      const parsed = parseShortcut('mod+shift+[');
      const event = { metaKey: true, ctrlKey: false, shiftKey: false, key: '[' };
      assert.ok(!matchesShortcut(event as KeyboardEvent, parsed, true));
    });
  });

  describe('formatShortcut', () => {
    it('formats mod+t as ⌘T on mac', () => {
      assert.strictEqual(formatShortcut('mod+t', true), '⌘T');
    });

    it('formats mod+t as ctrl+T on non-mac', () => {
      assert.strictEqual(formatShortcut('mod+t', false), 'ctrl+T');
    });

    it('formats mod+shift+[ with shift symbol on mac', () => {
      assert.strictEqual(formatShortcut('mod+shift+[', true), '⌘⇧[');
    });

    it('formats mod+w on non-mac', () => {
      assert.strictEqual(formatShortcut('mod+w', false), 'ctrl+W');
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test 2>&1 | grep -E "shortcuts|FAIL|ERR"`
Expected: FAIL — module not found

- [ ] **Step 3: Implement shortcuts.ts**

Create `frontend/src/lib/actions/shortcuts.ts`:

```typescript
import type { Action, ActionContext } from './types.js';

export type ParsedShortcut = {
  mod: boolean;
  shift: boolean;
  key: string;
};

export function parseShortcut(shortcutKey: string): ParsedShortcut {
  const parts = shortcutKey.toLowerCase().split('+');
  return {
    mod: parts.includes('mod'),
    shift: parts.includes('shift'),
    key: parts.filter(p => p !== 'mod' && p !== 'shift').join('+') || shortcutKey,
  };
}

export function matchesShortcut(
  event: KeyboardEvent,
  parsed: ParsedShortcut,
  isMac: boolean,
): boolean {
  const modPressed = isMac ? event.metaKey : event.ctrlKey;
  if (parsed.mod && !modPressed) return false;
  if (!parsed.mod && modPressed) return false;
  if (parsed.shift !== event.shiftKey) return false;
  return event.key.toLowerCase() === parsed.key.toLowerCase();
}

export function formatShortcut(shortcutKey: string, isMac: boolean): string {
  const parts = shortcutKey.split('+');
  const formatted = parts.map(p => {
    switch (p.toLowerCase()) {
      case 'mod': return isMac ? '⌘' : 'ctrl';
      case 'shift': return isMac ? '⇧' : 'shift';
      default: return p.length === 1 ? p.toUpperCase() : p;
    }
  });
  return isMac ? formatted.join('') : formatted.join('+');
}

/**
 * Sets up a single global keydown listener that dispatches to registered actions.
 * Returns a cleanup function to remove the listener.
 */
export function setupShortcutListener(
  getActions: () => Action[],
  getContext: () => ActionContext,
  isMac: boolean,
): () => void {
  const onKeydown = (e: KeyboardEvent) => {
    const modPressed = isMac ? e.metaKey : e.ctrlKey;
    if (!modPressed) return; // all registry shortcuts require mod

    // Don't intercept from text inputs unless the shortcut is global
    const tag = (document.activeElement as HTMLElement | null)?.tagName;
    const inInput = tag === 'INPUT' || tag === 'TEXTAREA';

    const actions = getActions();
    for (const action of actions) {
      if (!action.shortcut) continue;
      const parsed = parseShortcut(action.shortcut.key);
      if (!matchesShortcut(e, parsed, isMac)) continue;
      if (inInput && !action.shortcut.global) continue;

      const ctx = getContext();
      if (action.when && !action.when(ctx)) continue;

      e.preventDefault();
      const result = action.handler(ctx);
      if (result instanceof Promise) {
        result.catch(err => console.error(`Shortcut action "${action.id}" failed:`, err));
      }
      return;
    }
  };

  document.addEventListener('keydown', onKeydown);
  return () => document.removeEventListener('keydown', onKeydown);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test 2>&1 | grep -E "shortcuts|pass|fail|✓|✖"`
Expected: All 9 tests pass

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/actions/shortcuts.ts test/actions/shortcuts.test.ts
git commit -m "feat: ShortcutListener with parseShortcut, matchesShortcut, formatShortcut (TDD)"
```

---

### Task 8: Wire ShortcutListener in App.svelte, remove scattered listeners

**Files:**
- Modify: `frontend/src/App.svelte`

The goal: replace the 60-line `onKeydown` block (lines 186-253) with a call to `setupShortcutListener`, plus a special-case handler for Cmd+P (toggle palette) and Cmd+1-9 (tab switching, which is dynamic).

- [ ] **Step 1: Import setupShortcutListener**

Add to App.svelte imports:

```typescript
import { setupShortcutListener } from './lib/actions/shortcuts.js';
```

- [ ] **Step 2: Replace the keydown block**

Replace the block from line 182 (`// Keyboard shortcuts for tab navigation`) to line 253 (`cleanupKeydown = () => ...`) with:

```typescript
    // Keyboard shortcuts — centralized via ShortcutListener
    const isMac = navigator.platform.toUpperCase().includes('MAC');
    let cleanupKeydown: (() => void) | undefined;

    {
      // Special-case: Cmd+P toggles palette (must work even from inputs, before registry check)
      // Special-case: Cmd+1-9 for tab switching (dynamic, not registry-driven)
      const onSpecialKeydown = (e: KeyboardEvent) => {
        const mod = isMac ? e.metaKey : e.ctrlKey;
        if (!mod) return;

        if (e.key === 'p' && !e.shiftKey) {
          e.preventDefault();
          spotlightOpen = !spotlightOpen;
          return;
        }

        const tag = (document.activeElement as HTMLElement | null)?.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA') return;

        if (!e.shiftKey && e.key >= '1' && e.key <= '9') {
          const sessions = workspaceSessions;
          if (sessions.length === 0) return;
          e.preventDefault();
          const n = parseInt(e.key, 10);
          const target = n === 9 ? sessions[sessions.length - 1] : sessions[n - 1];
          if (target) handleSelectSession(target.id);
          return;
        }
      };

      document.addEventListener('keydown', onSpecialKeydown);

      // Registry-driven shortcuts (Cmd+T, Cmd+W, Cmd+Shift+[/], etc.)
      const cleanupRegistry = setupShortcutListener(
        () => getAllActions(),
        () => actionContext,
        isMac,
      );

      cleanupKeydown = () => {
        document.removeEventListener('keydown', onSpecialKeydown);
        cleanupRegistry();
      };
    }
```

Also add the `getAllActions` import from registry.svelte.ts (it's already imported in Spotlight but App.svelte needs it too):

```typescript
import { registerGlobal, getAllActions } from './lib/actions/registry.svelte.js';
```

- [ ] **Step 3: Build to verify**

Run: `npm run build 2>&1 | tail -5`
Expected: Build succeeds

- [ ] **Step 4: Commit**

```bash
git add frontend/src/App.svelte
git commit -m "feat: wire ShortcutListener, replace scattered keydown handlers"
```

---

### Task 9: Build ShortcutHint.svelte

**Files:**
- Create: `frontend/src/components/ShortcutHint.svelte`

- [ ] **Step 1: Create ShortcutHint component**

Create `frontend/src/components/ShortcutHint.svelte`:

```svelte
<script lang="ts">
  import { getAction } from '../lib/actions/registry.svelte.js';
  import { formatShortcut } from '../lib/actions/shortcuts.js';

  let { actionId }: { actionId: string } = $props();

  const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform || '');

  let shortcut = $derived.by(() => {
    const action = getAction(actionId);
    if (!action?.shortcut) return null;
    return formatShortcut(action.shortcut.key, isMac);
  });
</script>

{#if shortcut}
  <kbd class="shortcut-hint">{shortcut}</kbd>
{/if}

<style>
  .shortcut-hint {
    font-family: var(--font-mono);
    font-size: var(--font-size-xs);
    color: var(--text-muted);
    border: 1px solid var(--border);
    padding: 1px 4px;
    border-radius: 0;
    white-space: nowrap;
  }
</style>
```

- [ ] **Step 2: Build to verify**

Run: `npm run build 2>&1 | tail -5`
Expected: Build succeeds

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/ShortcutHint.svelte
git commit -m "feat: ShortcutHint.svelte — inline keyboard shortcut badge from registry"
```

---

### Task 10: Build CommandPalette.svelte

**Files:**
- Create: `frontend/src/components/CommandPalette.svelte`

This is the largest task. CommandPalette absorbs all of Spotlight's functionality plus: category tabs, mobile bottom sheet, shortcut badges, and the design doc's visual spec.

- [ ] **Step 1: Create CommandPalette.svelte**

Create `frontend/src/components/CommandPalette.svelte`. This component has the same props as Spotlight but adds category tabs, mobile bottom sheet rendering, and shortcut badges.

```svelte
<script lang="ts">
  import { useQueryClient } from '@tanstack/svelte-query';
  import type { Repo, SessionSummary, PullRequest, OrgPrsResponse, GitHubIssue, GitHubIssuesResponse, JiraIssue, JiraIssuesResponse } from '../lib/types.js';
  import { derivePrDotStatus } from '../lib/pr-status.js';
  import StatusDot from './StatusDot.svelte';
  import TuiInput from './TuiInput.svelte';
  import { getAllActions } from '../lib/actions/registry.svelte.js';
  import { formatShortcut } from '../lib/actions/shortcuts.js';
  import type { ActionContext, Action } from '../lib/actions/types.js';
  import { isMobileDevice } from '../lib/utils.js';

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
    workspaces: Repo[];
    sessions: SessionSummary[];
    actionContext: ActionContext;
    onClose: () => void;
    onSelectWorkspace: (path: string) => void;
    onSelectSession: (id: string) => void;
    onSelectPr: (pr: PullRequest) => void;
    onOpenSettings?: (sectionId: string) => void;
  } = $props();

  const queryClient = useQueryClient();
  const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform || '');

  let query = $state('');
  let focusedIndex = $state(0);
  let inputWrapperEl = $state<HTMLDivElement | undefined>(undefined);
  let resultsEl = $state<HTMLDivElement | undefined>(undefined);
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let debouncedQuery = $state('');
  let activeTab = $state<'all' | 'sessions' | 'workspaces' | 'prs' | 'settings'>('all');

  // Drag-dismiss state (mobile)
  let dragStartY = 0;
  let dragOffset = $state(0);
  let dragging = $state(false);

  // Read cached data from svelte-query
  let cachedPrs = $derived<PullRequest[]>(
    (queryClient.getQueryData<OrgPrsResponse>(['org-prs'])?.prs ?? [])
  );
  let cachedGithubIssues = $derived<GitHubIssue[]>(
    (queryClient.getQueryData<GitHubIssuesResponse>(['github-issues'])?.issues ?? [])
  );
  let cachedJiraIssues = $derived<JiraIssue[]>(
    (queryClient.getQueryData<JiraIssuesResponse>(['jira-issues'])?.issues ?? [])
  );

  // Settings entries (searchable)
  const SETTINGS_ENTRIES = [
    { id: 'setting-agent', label: 'Default Coding Agent', description: 'Which AI agent to use', section: 'section-general' },
    { id: 'setting-continue', label: 'Continue Session', description: 'Resume last session when opening a repo', section: 'section-general' },
    { id: 'setting-yolo', label: 'YOLO Mode', description: 'Skip permission checks', section: 'section-general' },
    { id: 'setting-tmux', label: 'Launch in tmux', description: 'Wrap sessions in tmux', section: 'section-general' },
    { id: 'setting-notifications', label: 'Notifications', description: 'Push notifications for sessions', section: 'section-general' },
    { id: 'setting-github', label: 'GitHub Connection', description: 'Connect GitHub account for PRs and CI', section: 'section-integrations' },
    { id: 'setting-webhooks', label: 'Webhooks', description: 'Real-time CI and PR updates', section: 'section-integrations' },
    { id: 'setting-jira', label: 'Jira', description: 'See Jira tickets in the sidebar', section: 'section-integrations' },
    { id: 'setting-devtools', label: 'Developer Tools', description: 'Mobile debug panel', section: 'section-advanced' },
    { id: 'setting-analytics', label: 'Analytics', description: 'Local usage data', section: 'section-advanced' },
    { id: 'setting-version', label: 'Version', description: 'Check for updates', section: 'section-about' },
  ];

  // Registry commands filtered by context
  let registryCommands = $derived.by(() => {
    return getAllActions().filter(a => !a.when || a.when(actionContext));
  });

  // "Needs Attention" — PRs with changes requested or awaiting review
  let needsAttention = $derived(
    cachedPrs.filter(pr =>
      pr.state === 'OPEN' && (
        pr.reviewDecision === 'CHANGES_REQUESTED' ||
        pr.role === 'reviewer'
      )
    ).slice(0, 5)
  );

  // Search results
  type PaletteResult =
    | { type: 'workspace'; id: string; label: string; sublabel?: string; data: Repo }
    | { type: 'session'; id: string; label: string; sublabel?: string; data: SessionSummary }
    | { type: 'pr' | 'attention'; id: string; label: string; sublabel?: string; data: PullRequest }
    | { type: 'ticket'; id: string; label: string; sublabel?: string; data: GitHubIssue | JiraIssue }
    | { type: 'command'; id: string; label: string; sublabel?: string; data: Action }
    | { type: 'setting'; id: string; label: string; sublabel?: string; data: { id: string; label: string; description: string; section: string } };

  // Tab filter mapping
  function matchesTab(type: PaletteResult['type']): boolean {
    if (activeTab === 'all') return true;
    switch (activeTab) {
      case 'sessions': return type === 'session' || type === 'command';
      case 'workspaces': return type === 'workspace';
      case 'prs': return type === 'pr' || type === 'attention';
      case 'settings': return type === 'setting' || (type === 'command');
      default: return true;
    }
  }

  let results = $derived.by((): PaletteResult[] => {
    const q = debouncedQuery.toLowerCase().trim();
    const items: PaletteResult[] = [];

    if (!q) {
      // Default view: needs attention + commands
      for (const pr of needsAttention) {
        items.push({
          type: 'attention',
          id: `attn-${pr.number}`,
          label: `#${pr.number} ${pr.title}`,
          sublabel: pr.repoName ?? '',
          data: pr,
        });
      }
      for (const ws of workspaces.slice(0, 5)) {
        items.push({
          type: 'workspace',
          id: `ws-${ws.path}`,
          label: ws.name,
          sublabel: ws.path,
          data: ws,
        });
      }
      for (const action of registryCommands) {
        items.push({
          type: 'command',
          id: `cmd-${action.id}`,
          label: action.label,
          sublabel: action.description ?? '',
          data: action,
        });
      }
      return items.filter(r => matchesTab(r.type));
    }

    // Workspaces
    const wsMatches = workspaces
      .filter(w => w.name.toLowerCase().includes(q))
      .slice(0, 5);
    for (const ws of wsMatches) {
      items.push({
        type: 'workspace',
        id: `ws-${ws.path}`,
        label: ws.name,
        sublabel: ws.path,
        data: ws,
      });
    }

    // Sessions
    const sessMatches = sessions
      .filter(s =>
        s.displayName.toLowerCase().includes(q) ||
        s.branchName.toLowerCase().includes(q) ||
        s.repoName.toLowerCase().includes(q)
      )
      .slice(0, 5);
    for (const s of sessMatches) {
      items.push({
        type: 'session',
        id: `sess-${s.id}`,
        label: s.displayName || s.branchName || s.repoName,
        sublabel: s.repoName,
        data: s,
      });
    }

    // PRs
    const prMatches = cachedPrs
      .filter(pr =>
        pr.title.toLowerCase().includes(q) ||
        String(pr.number).includes(q) ||
        pr.headRefName.toLowerCase().includes(q)
      )
      .slice(0, 5);
    for (const pr of prMatches) {
      items.push({
        type: 'pr',
        id: `pr-${pr.number}`,
        label: `#${pr.number} ${pr.title}`,
        sublabel: pr.repoName ?? pr.headRefName,
        data: pr,
      });
    }

    // GitHub Issues
    const ghMatches = cachedGithubIssues
      .filter(i =>
        i.title.toLowerCase().includes(q) ||
        String(i.number).includes(q)
      )
      .slice(0, 3);
    for (const issue of ghMatches) {
      items.push({
        type: 'ticket',
        id: `gh-${issue.number}`,
        label: `#${issue.number} ${issue.title}`,
        sublabel: issue.repoName,
        data: issue,
      });
    }

    // Jira Issues
    const jiraMatches = cachedJiraIssues
      .filter(i =>
        i.title.toLowerCase().includes(q) ||
        i.key.toLowerCase().includes(q)
      )
      .slice(0, 3);
    for (const issue of jiraMatches) {
      items.push({
        type: 'ticket',
        id: `jira-${issue.key}`,
        label: `${issue.key} ${issue.title}`,
        sublabel: issue.status,
        data: issue,
      });
    }

    // Commands from registry (match label, description, aliases)
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

    // Settings
    const settingMatches = SETTINGS_ENTRIES
      .filter(s =>
        s.label.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q)
      );
    for (const s of settingMatches) {
      items.push({
        type: 'setting',
        id: s.id,
        label: s.label,
        sublabel: s.description,
        data: s,
      });
    }

    return items.filter(r => matchesTab(r.type));
  });

  // Group results by type for category headers
  interface ResultGroup {
    label: string;
    items: PaletteResult[];
  }

  let groupedResults = $derived.by((): ResultGroup[] => {
    const q = debouncedQuery.toLowerCase().trim();
    const groups: ResultGroup[] = [];
    const typeOrder: Array<{ type: PaletteResult['type']; label: string }> = q
      ? [
          { type: 'workspace', label: 'workspaces' },
          { type: 'session', label: 'sessions' },
          { type: 'pr', label: 'pull requests' },
          { type: 'ticket', label: 'tickets' },
          { type: 'command', label: 'commands' },
          { type: 'setting', label: 'settings' },
        ]
      : [
          { type: 'attention', label: 'needs attention' },
          { type: 'workspace', label: 'workspaces' },
          { type: 'command', label: 'commands' },
        ];

    for (const { type, label } of typeOrder) {
      const items = results.filter(r => r.type === type);
      if (items.length > 0) {
        groups.push({ label, items });
      }
    }
    return groups;
  });

  // Flat list for keyboard navigation
  let flatItems = $derived(groupedResults.flatMap(g => g.items));

  // Clamp focused index when results change
  $effect(() => {
    if (focusedIndex >= flatItems.length) {
      focusedIndex = Math.max(0, flatItems.length - 1);
    }
  });

  // Focus input when opened
  $effect(() => {
    if (open) {
      query = '';
      debouncedQuery = '';
      focusedIndex = 0;
      activeTab = 'all';
      requestAnimationFrame(() => inputWrapperEl?.querySelector('input')?.focus());
    }
  });

  function handleInput() {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debouncedQuery = query;
    }, 150);
  }

  async function selectItem(item: PaletteResult) {
    if (item.type === 'command') {
      try {
        await item.data.handler(actionContext);
        onClose();
      } catch (err) {
        console.error(`Action "${item.data.id}" failed:`, err);
        onClose();
      }
      return;
    }
    onClose();
    switch (item.type) {
      case 'workspace':
        onSelectWorkspace(item.data.path);
        break;
      case 'session':
        onSelectSession(item.data.id);
        break;
      case 'attention':
      case 'pr':
        onSelectPr(item.data);
        break;
      case 'ticket':
        break;
      case 'setting':
        onOpenSettings?.(item.data.section);
        break;
    }
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      focusedIndex = Math.min(focusedIndex + 1, flatItems.length - 1);
      scrollFocusedIntoView();
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      focusedIndex = Math.max(focusedIndex - 1, 0);
      scrollFocusedIntoView();
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const item = flatItems[focusedIndex];
      if (item) selectItem(item);
      return;
    }
    // Tab key cycles through category tabs
    if (e.key === 'Tab') {
      e.preventDefault();
      const tabs: typeof activeTab[] = ['all', 'sessions', 'workspaces', 'prs', 'settings'];
      const idx = tabs.indexOf(activeTab);
      activeTab = e.shiftKey
        ? tabs[(idx - 1 + tabs.length) % tabs.length]!
        : tabs[(idx + 1) % tabs.length]!;
      focusedIndex = 0;
      return;
    }
  }

  function scrollFocusedIntoView() {
    requestAnimationFrame(() => {
      const el = document.querySelector('.palette-item.focused');
      el?.scrollIntoView({ block: 'nearest' });
    });
  }

  function handleBackdropClick(e: MouseEvent) {
    if ((e.target as HTMLElement).classList.contains('palette-overlay')) {
      onClose();
    }
  }

  function categoryIcon(type: PaletteResult['type']): string {
    switch (type) {
      case 'workspace': return '■';
      case 'session': return '▸';
      case 'pr': case 'attention': return '●';
      case 'ticket': return '#';
      case 'command': return '>';
      case 'setting': return '⚙';
      default: return '';
    }
  }

  // Mobile swipe-down dismiss
  function handleDragStart(e: TouchEvent) {
    if (!isMobileDevice) return;
    // Only start drag if we're at scroll top or touching the drag handle
    const target = e.target as HTMLElement;
    const isHandle = target.classList.contains('drag-handle');
    if (!isHandle && resultsEl && resultsEl.scrollTop > 0) return;
    dragStartY = e.touches[0]!.clientY;
    dragging = true;
  }

  function handleDragMove(e: TouchEvent) {
    if (!dragging) return;
    const delta = e.touches[0]!.clientY - dragStartY;
    if (delta > 0) {
      dragOffset = delta;
    }
  }

  function handleDragEnd() {
    if (!dragging) return;
    dragging = false;
    if (dragOffset > 100) {
      onClose();
    }
    dragOffset = 0;
  }
</script>

{#if open}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="palette-overlay" class:mobile={isMobileDevice} onclick={handleBackdropClick}>
    <div
      class="palette"
      class:mobile={isMobileDevice}
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
      style={isMobileDevice && dragOffset > 0 ? `transform: translateY(${dragOffset}px)` : ''}
      ontouchstart={handleDragStart}
      ontouchmove={handleDragMove}
      ontouchend={handleDragEnd}
    >
      {#if isMobileDevice}
        <div class="drag-handle"><span class="drag-bar"></span></div>
      {/if}

      <div class="palette-input-row" bind:this={inputWrapperEl}>
        <span class="palette-prompt">&gt;</span>
        <TuiInput
          bind:value={query}
          placeholder="search commands, workspaces, sessions..."
          oninput={handleInput}
          onkeydown={handleKeydown}
          autocomplete="off"
          spellcheck={false}
          role="combobox"
          aria-expanded={flatItems.length > 0}
          aria-controls="palette-results"
          aria-activedescendant={flatItems[focusedIndex] ? `palette-item-${flatItems[focusedIndex]!.id}` : undefined}
        />
      </div>

      <!-- Category tabs -->
      <div class="palette-tabs" role="tablist">
        {#each ['all', 'sessions', 'workspaces', 'prs', 'settings'] as tab}
          <button
            class="palette-tab"
            class:active={activeTab === tab}
            role="tab"
            aria-selected={activeTab === tab}
            onclick={() => { activeTab = tab as typeof activeTab; focusedIndex = 0; }}
          >{tab}</button>
        {/each}
      </div>

      <div class="palette-results" id="palette-results" role="listbox" bind:this={resultsEl}>
        {#if flatItems.length === 0 && debouncedQuery.trim()}
          <div class="palette-empty">no results for "{debouncedQuery}"</div>
        {:else}
          {#each groupedResults as group}
            <div class="palette-category" role="presentation">
              {group.label}
              {#if group.label === 'needs attention'}
                <span class="category-count">({group.items.length})</span>
              {/if}
            </div>
            {#each group.items as item}
              {@const globalIndex = flatItems.indexOf(item)}
              <!-- svelte-ignore a11y_click_events_have_key_events -->
              <div
                id="palette-item-{item.id}"
                class="palette-item"
                class:focused={globalIndex === focusedIndex}
                role="option"
                aria-selected={globalIndex === focusedIndex}
                onclick={() => selectItem(item)}
                onmouseenter={() => { focusedIndex = globalIndex; }}
              >
                <span class="item-cursor" class:visible={globalIndex === focusedIndex}>&gt;</span>
                {#if item.type === 'attention' || item.type === 'pr'}
                  <StatusDot status={derivePrDotStatus(item.data)} size={7} />
                {:else if item.type === 'command' && item.data.icon}
                  <span class="item-icon">{item.data.icon}</span>
                {:else}
                  <span class="item-icon">{categoryIcon(item.type)}</span>
                {/if}
                <span class="item-label">{item.label}</span>
                {#if item.sublabel}
                  <span class="item-sublabel">{item.sublabel}</span>
                {/if}
                {#if !isMobileDevice && item.type === 'command' && item.data.shortcut}
                  <kbd class="item-shortcut">{formatShortcut(item.data.shortcut.key, isMac)}</kbd>
                {/if}
              </div>
            {/each}
          {/each}
        {/if}
      </div>

      {#if !isMobileDevice}
        <div class="palette-footer">
          <span class="hint">↑↓ navigate</span>
          <span class="hint">tab category</span>
          <span class="hint">↵ select</span>
          <span class="hint">esc close</span>
        </div>
      {/if}
    </div>
  </div>
{/if}

<style>
  /* ── Desktop overlay ── */
  .palette-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.5);
    z-index: 1000;
    display: flex;
    align-items: flex-start;
    justify-content: center;
    padding-top: 20vh;
  }

  .palette {
    width: 100%;
    max-width: 580px;
    background: var(--surface);
    border: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    max-height: 480px;
  }

  .palette-input-row {
    display: flex;
    align-items: center;
    padding: 12px 16px;
    gap: 8px;
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
    height: 44px;
  }

  .palette-prompt {
    font-family: var(--font-mono);
    font-size: var(--font-size-base);
    color: var(--accent);
    font-weight: bold;
    flex-shrink: 0;
    line-height: 1;
    user-select: none;
  }

  .palette-input-row :global(.tui-input-wrapper) {
    flex: 1;
  }

  .palette-input-row :global(.tui-input) {
    background: transparent;
    border: none;
    padding: 0;
  }

  .palette-input-row :global(.tui-input:focus) {
    border: none;
  }

  .palette-input-row :global(.tui-input::placeholder) {
    color: #555;
  }

  /* ── Category tabs ── */
  .palette-tabs {
    display: flex;
    gap: 0;
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
    height: 32px;
  }

  .palette-tab {
    background: none;
    border: none;
    border-bottom: 2px solid transparent;
    padding: 6px 12px;
    font-family: var(--font-mono);
    font-size: var(--font-size-xs);
    color: var(--text-muted);
    cursor: pointer;
    text-transform: lowercase;
  }

  .palette-tab:hover {
    color: var(--text);
  }

  .palette-tab.active {
    color: var(--accent);
    border-bottom-color: var(--accent);
  }

  /* ── Results ── */
  .palette-results {
    overflow-y: auto;
    flex: 1;
    min-height: 0;
  }

  .palette-category {
    padding: 8px 16px 4px;
    font-size: var(--font-size-xs);
    font-family: var(--font-mono);
    font-weight: 600;
    color: #555;
    letter-spacing: 0.08em;
    user-select: none;
    text-transform: lowercase;
  }

  .category-count {
    font-weight: 400;
    opacity: 0.7;
  }

  .palette-item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 16px;
    cursor: pointer;
    font-family: var(--font-mono);
    font-size: var(--font-size-sm);
    color: var(--text-muted);
    transition: background 0.08s;
    min-height: 36px;
  }

  .palette-item:hover,
  .palette-item.focused {
    background: var(--surface-hover);
    color: var(--text);
  }

  .item-cursor {
    flex-shrink: 0;
    width: 12px;
    font-size: var(--font-size-xs);
    color: var(--accent);
    opacity: 0;
    transition: opacity 0.12s ease-out;
  }

  .item-cursor.visible {
    opacity: 1;
  }

  .item-icon {
    flex-shrink: 0;
    width: 16px;
    text-align: center;
    font-size: var(--font-size-xs);
    color: var(--text-muted);
    opacity: 0.6;
  }

  .item-label {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }

  .item-sublabel {
    font-size: var(--font-size-xs);
    color: #555;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex-shrink: 1;
    min-width: 0;
    max-width: 180px;
  }

  .item-shortcut {
    font-family: var(--font-mono);
    font-size: var(--font-size-xs);
    color: #888;
    border: 1px solid #444;
    padding: 1px 6px;
    flex-shrink: 0;
    border-radius: 0;
  }

  .palette-empty {
    padding: 20px 16px;
    font-family: var(--font-mono);
    font-size: var(--font-size-sm);
    color: var(--text-muted);
    opacity: 0.6;
    text-align: center;
  }

  .palette-footer {
    display: flex;
    gap: 16px;
    padding: 8px 16px;
    border-top: 1px solid var(--border);
    flex-shrink: 0;
  }

  .hint {
    font-family: var(--font-mono);
    font-size: var(--font-size-xs);
    color: var(--text-muted);
    opacity: 0.5;
  }

  /* ── Mobile bottom sheet ── */
  .palette-overlay.mobile {
    padding-top: 0;
    align-items: flex-end;
    background: rgba(0, 0, 0, 0.6);
  }

  .palette.mobile {
    max-width: 100%;
    max-height: 70vh;
    border: none;
    border-top: 1px solid var(--border);
    padding-bottom: env(safe-area-inset-bottom);
    border-radius: 0;
  }

  .drag-handle {
    display: flex;
    justify-content: center;
    padding: 8px 0 4px;
    cursor: grab;
    touch-action: none;
  }

  .drag-bar {
    width: 24px;
    height: 3px;
    background: var(--text-muted);
    border-radius: 0;
  }

  .palette.mobile .palette-item {
    min-height: 48px;
    padding: 14px 16px;
    border-bottom: 1px solid #1a1a1a;
  }

  .palette.mobile .item-cursor {
    display: none;
  }

  .palette.mobile .item-shortcut {
    display: none;
  }

  .palette.mobile .palette-tabs {
    overflow-x: auto;
    -webkit-overflow-scrolling: touch;
  }
</style>
```

- [ ] **Step 2: Build to verify**

Run: `npm run build 2>&1 | tail -5`
Expected: Build succeeds

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/CommandPalette.svelte
git commit -m "feat: CommandPalette.svelte — desktop overlay + mobile bottom sheet with category tabs"
```

---

### Task 11: Swap Spotlight for CommandPalette in App.svelte

**Files:**
- Modify: `frontend/src/App.svelte`

- [ ] **Step 1: Replace Spotlight import with CommandPalette**

Change:
```typescript
import Spotlight from './components/Spotlight.svelte';
```
to:
```typescript
import CommandPalette from './components/CommandPalette.svelte';
```

- [ ] **Step 2: Replace Spotlight usage in template**

Replace the Spotlight component usage (around lines 927-938):

```svelte
  <!-- Spotlight command palette -->
  <Spotlight
    open={spotlightOpen}
    workspaces={sessionState.repos}
    sessions={sessionState.sessions}
    {actionContext}
    onClose={() => { spotlightOpen = false; }}
    onSelectWorkspace={(path) => { ui.activeRepoPath = path; sessionState.activeSessionId = null; closeSidebar(); }}
    onSelectSession={(id) => handleSelectSession(id)}
    onSelectPr={handleSpotlightSelectPr}
    onOpenSettings={(sectionId) => { spotlightOpen = false; settingsDialogRef?.open(sectionId); }}
  />
```

with:

```svelte
  <!-- Command palette -->
  <CommandPalette
    open={spotlightOpen}
    workspaces={sessionState.repos}
    sessions={sessionState.sessions}
    {actionContext}
    onClose={() => { spotlightOpen = false; }}
    onSelectWorkspace={(path) => { ui.activeRepoPath = path; sessionState.activeSessionId = null; closeSidebar(); }}
    onSelectSession={(id) => handleSelectSession(id)}
    onSelectPr={handleSpotlightSelectPr}
    onOpenSettings={(sectionId) => { spotlightOpen = false; settingsDialogRef?.open(sectionId); }}
  />
```

- [ ] **Step 3: Build to verify**

Run: `npm run build 2>&1 | tail -5`
Expected: Build succeeds

- [ ] **Step 4: Run all tests**

Run: `npm test 2>&1 | tail -10`
Expected: All tests pass (git-watcher flaky is pre-existing)

- [ ] **Step 5: Commit**

```bash
git add frontend/src/App.svelte
git commit -m "feat: swap Spotlight for CommandPalette in App.svelte"
```

Note: Spotlight.svelte is NOT deleted yet — keep it for easy rollback. Delete it in the final cleanup task.

---

### Task 12: Mobile palette trigger + hardware keyboard detection

**Files:**
- Modify: `frontend/src/components/MobileHeader.svelte`
- Modify: `frontend/src/lib/state/ui.svelte.ts`

- [ ] **Step 1: Add hasHardwareKeyboard flag to ui.svelte.ts**

Add to `frontend/src/lib/state/ui.svelte.ts`, after `let terminalFontSize = $state(...)` (line 50):

```typescript
let hasHardwareKeyboard = $state(false);
```

Add the getter/setter to the `getUi()` return object:

```typescript
    get hasHardwareKeyboard() { return hasHardwareKeyboard; },
    set hasHardwareKeyboard(v: boolean) { hasHardwareKeyboard = v; },
```

- [ ] **Step 2: Add keyboard detection to App.svelte**

In App.svelte's `onMount`, add hardware keyboard detection for mobile after the existing mobile viewport handling:

```typescript
    // Hardware keyboard detection (mobile only)
    if (isMobileDevice) {
      const detectKeyboard = (e: KeyboardEvent) => {
        if (!ui.hasHardwareKeyboard) {
          ui.hasHardwareKeyboard = true;
        }
      };
      document.addEventListener('keydown', detectKeyboard);
      // No cleanup needed — detection is one-way (session-persistent)
    }
```

- [ ] **Step 3: Add command trigger to MobileHeader**

Replace `frontend/src/components/MobileHeader.svelte` with:

```svelte
<script lang="ts">
  let {
    title,
    onMenuClick,
    onCommandClick,
    hidden = false,
  }: {
    title: string;
    onMenuClick: () => void;
    onCommandClick: () => void;
    hidden?: boolean;
  } = $props();
</script>

<div class="mobile-header" class:hidden>
  <button
    class="icon-btn"
    aria-label="Open sessions menu"
    onclick={onMenuClick}
  >&#9776;</button>
  <span class="mobile-title">{title}</span>
  <button
    class="command-trigger"
    aria-label="Open command palette"
    onclick={onCommandClick}
  >&gt; command</button>
</div>

<style>
  .mobile-header {
    display: none;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    background: var(--surface);
    border-bottom: 1px solid var(--border);
    min-height: 44px;
    flex-shrink: 0;
  }

  @media (max-width: 600px) {
    .mobile-header {
      display: flex;
    }
    .mobile-header.hidden {
      display: none;
    }
  }

  .mobile-title {
    font-size: var(--font-size-base);
    color: var(--text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
  }

  .icon-btn {
    background: none;
    border: none;
    color: var(--text);
    font-size: var(--font-size-lg);
    cursor: pointer;
    padding: 8px;
    min-width: 36px;
    min-height: 36px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 0;
    touch-action: manipulation;
  }

  .icon-btn:hover {
    background: var(--border);
  }

  .command-trigger {
    background: none;
    border: 1px solid var(--accent);
    color: var(--accent);
    font-family: var(--font-mono);
    font-size: var(--font-size-xs);
    padding: 4px 10px;
    cursor: pointer;
    min-height: 44px;
    display: flex;
    align-items: center;
    border-radius: 0;
    touch-action: manipulation;
    white-space: nowrap;
    flex-shrink: 0;
  }

  .command-trigger:active {
    background: var(--accent);
    color: var(--surface);
  }
</style>
```

- [ ] **Step 4: Wire onCommandClick in App.svelte**

Find where MobileHeader is used in App.svelte and add the `onCommandClick` prop:

```svelte
<MobileHeader
  title={...}
  onMenuClick={...}
  onCommandClick={() => { spotlightOpen = true; }}
  hidden={...}
/>
```

- [ ] **Step 5: Build to verify**

Run: `npm run build 2>&1 | tail -5`
Expected: Build succeeds

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/MobileHeader.svelte frontend/src/lib/state/ui.svelte.ts frontend/src/App.svelte
git commit -m "feat: mobile command palette trigger + hardware keyboard detection"
```

---

### Task 13: Final integration test + cleanup

**Files:**
- Modify: various

- [ ] **Step 1: Run full build**

Run: `npm run build 2>&1 | tail -10`
Expected: Build succeeds with no errors (warnings ok)

- [ ] **Step 2: Run full test suite**

Run: `npm test 2>&1 | tail -20`
Expected: All tests pass (git-watcher flaky is pre-existing)

- [ ] **Step 3: Verify action count**

Run a quick check that the coverage test validates the right count:

```bash
npm test 2>&1 | grep -A1 "action-coverage"
```

Expected: 5 passing tests in action-coverage

- [ ] **Step 4: Delete Spotlight.svelte**

Remove the deprecated file:

```bash
rm frontend/src/components/Spotlight.svelte
```

- [ ] **Step 5: Build again after deletion**

Run: `npm run build 2>&1 | tail -5`
Expected: Build succeeds (Spotlight is no longer imported)

- [ ] **Step 6: Commit cleanup**

```bash
git add -A
git commit -m "chore: delete deprecated Spotlight.svelte, Phase 3 complete"
```

---

## Appendix: Action ID → Count Summary

| Category | Count | IDs |
|----------|-------|-----|
| session | 9 | new-agent, new-terminal, close-active, kill, start-on-repo, start-on-ticket, customize, switch-to-tab, rename |
| workspace | 2 | add, new-worktree |
| pr | 11 | create, push-branch, switch-branch, fix-conflicts, archive-branch, rename-branch, copy-branch-name, open-external, refresh, change-target, skip-checks |
| settings | 16 | open, connect-github, toggle-yolo, check-updates, disconnect-github, setup-webhooks, remove-webhook, test-webhook, connect-jira, disconnect-jira, toggle-devtools, clear-analytics, toggle-continue, toggle-tmux, toggle-notifications, change-default-agent |
| sidebar | 7 | collapse, navigate-dashboard, workspace-settings, rename-session, delete-worktree, resume-session, resume-yolo |
| dashboard | 3 | open-pr-session, sort-prs, clear-filters |
| org | 5 | switch-tab, save-filter, delete-filter, toggle-pr-status, navigate-to-workspace |
| ticket | 2 | switch-provider, open-external |
| terminal | 2 | scroll-top, scroll-bottom |
| navigation | 3 | previous-tab, next-tab, switch-to-tab |
| **Total** | **60** | |

Note: The design doc cited 57 total (15 Phase 2 + 42 Phase 3). Our actual count is 60 due to:
- 3 extra session actions (customize, switch-to-tab, rename) that were implicit in the audit but not counted in the 42 figure
- Terminal zoom/paste NOT counted (stays in xterm, not in registry)
- Dashboard/org/ticket actions counted individually rather than grouped

The allowlist in the coverage test is authoritative.
