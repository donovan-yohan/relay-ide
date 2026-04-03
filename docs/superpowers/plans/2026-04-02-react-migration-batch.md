# Svelte → React Migration (Batch) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate all remaining ~51 Svelte 5 components to React 19 TSX with Playwright visual regression tests confirming pixel-identical output, validated by `carabiner enforce --all`.

**Architecture:** Strangler-fig migration — React components live alongside Svelte counterparts. Each component gets: a `.tsx` file (React FC with typed props), a `.css` file (extracted from Svelte `<style>`), a `test-*.tsx` harness page, a `test-*.html` entry point, and a Playwright `.spec.ts` with screenshot assertions. State modules (`.svelte.ts`) are replaced by Zustand stores. The Svelte file is NOT deleted — it stays until the App shell migrates to React and stops importing it.

**Tech Stack:** React 19, TypeScript, Vite (dual svelte+react plugins), Playwright 1.58.2, Zustand, CSS (extracted from Svelte scoped styles), carabiner + eslint-plugin-sonarjs

---

## Migration Pattern Reference

Every subagent must follow this exact pattern. The existing `TuiButton` migration is the canonical example.

### Source (Svelte): `frontend/src/components/TuiButton.svelte`
- Props via `$props()` → React `interface TuiButtonProps` + destructured FC args
- `{@render children()}` → `{children}` (React.ReactNode)
- `class:tui-btn--sm={condition}` → template literal or `.filter(Boolean).join(' ')`
- Svelte `<style>` block → extract to `TuiButton.css`, import in TSX
- Svelte `bind:this` → React `useRef`
- Svelte `$state()` → React `useState()`
- Svelte `$derived` → React `useMemo()` or inline computation
- Svelte `$effect` → React `useEffect()`
- Svelte `onMount` → React `useEffect(() => { ... }, [])`
- Svelte snippets (`Snippet`) → React `React.ReactNode` props
- Svelte `export function` (component methods) → React `useImperativeHandle` + `forwardRef`
- Svelte `<svelte:document>` → React `useEffect` with `document.addEventListener`
- State modules (`.svelte.ts` with `$state`) → Zustand stores (Task 2)

### Output files per component:
1. `frontend/src/components/ComponentName.tsx` — React FC
2. `frontend/src/components/ComponentName.css` — extracted styles (prefix all selectors to avoid collision)
3. `frontend/src/test-component-name.tsx` — test harness page rendering all states
4. `frontend/test-component-name.html` — HTML entry (copy from `test-tui-button.html`, update paths and CSS vars)
5. `frontend/vite.config.ts` — add entry to `rollupOptions.input`
6. `tests/components/ComponentName.spec.ts` — Playwright spec with screenshot assertions

### CSS extraction rules:
- Svelte scoped styles use bare class names (`.foo`). In React CSS files, keep the same class names — the BEM-style naming (`.component-name__element`) already avoids collisions.
- Copy `:global()` rules as-is (without the `:global()` wrapper).
- Copy `@keyframes`, `@media` blocks verbatim.
- `class:name={cond}` becomes conditional className in React (see TuiButton.tsx pattern).

### Test harness pattern:
- Mount component with all meaningful prop combinations
- Give each variant a unique `id` for Playwright selectors
- Use `data-testid` for complex layouts
- Include interactive states (click counters, toggle states) where applicable

### Playwright spec pattern:
```typescript
import { test, expect } from '@playwright/test';

test.describe('ComponentName', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/test-component-name.html');
  });

  test('renders default state', async ({ page }) => {
    // Functional assertions
  });

  test('screenshot - default', async ({ page }) => {
    const el = page.locator('#test-default');
    await expect(el).toHaveScreenshot('component-name-default.png', {
      maxDiffPixels: 100,
      threshold: 0.1,
    });
  });
});
```

---

## Task 0: Playwright Visual Test Infrastructure

**Files:**
- Modify: `playwright.config.ts`
- Create: `tests/helpers/visual.ts`

This task is a prerequisite. The existing config is already correct. We just need a shared helper for screenshot options consistency.

- [ ] **Step 1: Create visual test helper**

```typescript
// tests/helpers/visual.ts
import type { PageScreenshotOptions } from '@playwright/test';

export const SCREENSHOT_OPTS = {
  maxDiffPixels: 100,
  threshold: 0.1,
} as const;

export const SCREENSHOT_OPTS_WIDE = {
  maxDiffPixels: 500,
  threshold: 0.1,
} as const;
```

- [ ] **Step 2: Verify Playwright config has `updateSnapshots` script**

Confirm `package.json` already has `test:e2e:update` script. It does: `"test:e2e:update": "playwright test --update-snapshots"`. No change needed.

- [ ] **Step 3: Commit**

```bash
git add tests/helpers/visual.ts
git commit -m "chore: add Playwright visual test helpers"
```

---

## Task 1: Zustand State Stores (Auth + Toasts + Config)

**Files:**
- Create: `frontend/src/lib/stores/auth.ts`
- Create: `frontend/src/lib/stores/toasts.ts`
- Create: `frontend/src/lib/stores/config.ts`
- Test: `tests/stores/auth.spec.ts` (unit test via Playwright page eval)

These three state modules are small (27-67 lines) and are dependencies for many components. They must be migrated to Zustand before components that use them.

- [ ] **Step 1: Install zustand**

```bash
cd frontend && npm install zustand
```

- [ ] **Step 2: Create auth store**

```typescript
// frontend/src/lib/stores/auth.ts
import { create } from 'zustand';
import {
  authenticate as apiAuth,
  checkAuth,
  checkAuthStatus,
  setupPin as apiSetupPin,
} from '../api.js';

interface AuthState {
  authenticated: boolean;
  pinError: string | null;
  checking: boolean;
  needsSetup: boolean;
  checkExistingAuth: () => Promise<void>;
  submitPin: (pin: string) => Promise<void>;
  setupNewPin: (pin: string, confirm: string) => Promise<void>;
}

export const useAuthStore = create<AuthState>((set) => ({
  authenticated: false,
  pinError: null,
  checking: true,
  needsSetup: false,

  checkExistingAuth: async () => {
    set({ checking: true });
    try {
      const status = await checkAuthStatus();
      if (!status.hasPIN) {
        set({ needsSetup: true, checking: false });
        return;
      }
      set({ needsSetup: false });
      const authed = await checkAuth();
      set({ authenticated: authed });
    } catch {
      set({ authenticated: false });
    } finally {
      set({ checking: false });
    }
  },

  submitPin: async (pin: string) => {
    set({ pinError: null });
    try {
      await apiAuth(pin);
      set({ authenticated: true });
    } catch (err) {
      set({ pinError: err instanceof Error ? err.message : 'Authentication failed' });
    }
  },

  setupNewPin: async (pin: string, confirm: string) => {
    set({ pinError: null });
    try {
      await apiSetupPin(pin, confirm);
      set({ authenticated: true, needsSetup: false });
    } catch (err) {
      set({ pinError: err instanceof Error ? err.message : 'Setup failed' });
    }
  },
}));
```

- [ ] **Step 3: Create toasts store**

Read `frontend/src/lib/state/toasts.svelte.ts` for exact shape, then create:

```typescript
// frontend/src/lib/stores/toasts.ts
import { create } from 'zustand';

export interface Toast {
  id: string;
  message: string;
  type: 'info' | 'error' | 'success';
}

interface ToastState {
  toasts: Toast[];
  addToast: (toast: Omit<Toast, 'id'>) => void;
  removeToast: (id: string) => void;
}

export const useToastStore = create<ToastState>((set) => ({
  toasts: [],
  addToast: (toast) =>
    set((state) => ({
      toasts: [...state.toasts, { ...toast, id: crypto.randomUUID() }],
    })),
  removeToast: (id) =>
    set((state) => ({
      toasts: state.toasts.filter((t) => t.id !== id),
    })),
}));
```

- [ ] **Step 4: Create config store**

Read `frontend/src/lib/state/config.svelte.ts` for exact shape, then create the Zustand equivalent in `frontend/src/lib/stores/config.ts`.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/stores/
git commit -m "feat: add Zustand stores for auth, toasts, config (React migration)"
```

---

## Task 2: Batch A — Simple Leaf Components (6 components)

**Components:** AgentBadge, PickerResultRow, DialogShell, PinGate, MobileInput, ContextMenu

These have minimal or no state module dependencies. Each one follows the same pattern: read Svelte → create TSX + CSS + test harness + Playwright spec.

**Files per component:**
- Read: `frontend/src/components/{Name}.svelte`
- Create: `frontend/src/components/{Name}.tsx`
- Create: `frontend/src/components/{Name}.css`
- Create: `frontend/src/test-{kebab-name}.tsx`
- Create: `frontend/test-{kebab-name}.html`
- Create: `tests/components/{Name}.spec.ts`
- Modify: `frontend/vite.config.ts` (add rollup input entry)

### AgentBadge

- [ ] **Step 1: Create AgentBadge.css**

Extract the `<style>` block from `AgentBadge.svelte` into `frontend/src/components/AgentBadge.css`.

- [ ] **Step 2: Create AgentBadge.tsx**

```tsx
// frontend/src/components/AgentBadge.tsx
import React from 'react';
import './AgentBadge.css';

interface AgentBadgeProps {
  agent: string;
}

export const AgentBadge: React.FC<AgentBadgeProps> = ({ agent }) => {
  const fallbackLetter = agent ? agent[0]!.toUpperCase() : '?';

  if (agent === 'claude') {
    return (
      <svg className="agent-badge" viewBox="0 0 512 509.64" xmlns="http://www.w3.org/2000/svg" aria-label="Claude">
        <path fill="currentColor" fillRule="nonzero" d="M142.27 316.619l73.655-41.326..." />
        {/* Full SVG path from Svelte source */}
      </svg>
    );
  }

  if (agent === 'codex') {
    return (
      <svg className="agent-badge" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-label="Codex">
        <path fill="currentColor" d="M22.2819 9.8211..." />
      </svg>
    );
  }

  if (agent === 'opencode') {
    return (
      <svg className="agent-badge" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-label="OpenCode">
        <text x="0" y="16" fontFamily="monospace" fontSize="14" fill="currentColor">&gt;_</text>
      </svg>
    );
  }

  return <span className="agent-badge agent-badge--fallback" aria-label={agent}>{fallbackLetter}</span>;
};

export default AgentBadge;
```

- [ ] **Step 3: Create test-agent-badge.tsx harness**

```tsx
import React from 'react';
import ReactDOM from 'react-dom/client';
import { AgentBadge } from './components/AgentBadge';
import './components/AgentBadge.css';

function TestPage() {
  return (
    <div className="test-page">
      <div className="test-section">
        <h2>Agent Badges</h2>
        <div id="badges-container" style={{ display: 'flex', gap: '16px', alignItems: 'center' }}>
          <div id="test-claude"><AgentBadge agent="claude" /></div>
          <div id="test-codex"><AgentBadge agent="codex" /></div>
          <div id="test-opencode"><AgentBadge agent="opencode" /></div>
          <div id="test-fallback"><AgentBadge agent="custom-agent" /></div>
          <div id="test-empty"><AgentBadge agent="" /></div>
        </div>
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('app')!).render(
  <React.StrictMode><TestPage /></React.StrictMode>
);
```

- [ ] **Step 4: Create test-agent-badge.html**

Copy from `frontend/test-tui-button.html`, update title to "AgentBadge Test Page" and script src to `/src/test-agent-badge.tsx`.

- [ ] **Step 5: Add vite entry**

Add `'test-agent-badge': resolve(import.meta.dirname, 'test-agent-badge.html')` to `rollupOptions.input` in `frontend/vite.config.ts`.

- [ ] **Step 6: Create AgentBadge.spec.ts**

```typescript
import { test, expect } from '@playwright/test';

test.describe('AgentBadge', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/test-agent-badge.html');
  });

  test('renders claude badge as SVG', async ({ page }) => {
    const badge = page.locator('#test-claude svg');
    await expect(badge).toHaveAttribute('aria-label', 'Claude');
  });

  test('renders fallback letter for unknown agent', async ({ page }) => {
    const badge = page.locator('#test-fallback .agent-badge--fallback');
    await expect(badge).toHaveText('C');
  });

  test('screenshot - all badges', async ({ page }) => {
    const container = page.locator('#badges-container');
    await expect(container).toHaveScreenshot('agent-badge-all.png', {
      maxDiffPixels: 100,
      threshold: 0.1,
    });
  });
});
```

- [ ] **Step 7: Run test and generate baseline screenshot**

```bash
npx playwright test tests/components/AgentBadge.spec.ts --update-snapshots
```

- [ ] **Step 8: Run carabiner enforce on the new file**

```bash
npx eslint frontend/src/components/AgentBadge.tsx --max-warnings=0
```

- [ ] **Step 9: Commit**

```bash
git add frontend/src/components/AgentBadge.tsx frontend/src/components/AgentBadge.css frontend/src/test-agent-badge.tsx frontend/test-agent-badge.html tests/components/AgentBadge.spec.ts frontend/vite.config.ts
git commit -m "migrate: AgentBadge component to React"
```

### PickerResultRow

- [ ] **Step 1-9: Repeat the exact same pattern as AgentBadge**

Read `frontend/src/components/PickerResultRow.svelte`. This component imports `StatusDot` and `TuiButton` — use their React versions (`./StatusDot` tsx, `./TuiButton` tsx). Props: `label`, `sublabel`, `dotStatus`, `intents`, `focused`, `onSelectIntent`, `onRowClick`. Extract the `<style>` block. Create `.tsx`, `.css`, test harness, HTML entry, Playwright spec. The test harness should render: default state, with sublabel, with dotStatus, focused state, with multiple intents.

### DialogShell

- [ ] **Step 1-9: Repeat the pattern**

This component uses `useImperativeHandle` + `forwardRef` because Svelte exposes `open()` and `close()` methods. It uses `<dialog>` element with `showModal()`. Props: `variant`, `width`, `title`, `children`, `headerExtra` (React.ReactNode), `footer` (React.ReactNode). The `scrolledBottom` state tracks scroll position. Test harness should render: compact variant, fullscreen variant, with footer, with header-extra.

### PinGate

- [ ] **Step 1-9: Repeat the pattern**

Depends on the Zustand `useAuthStore` from Task 1. Replace `getAuth()` + `submitPin()` + `setupNewPin()` with `useAuthStore()` hook. Uses `PinInput` and `TuiButton` React versions. Test harness needs to mock the auth store (provide initial state via Zustand). Show: setup mode (needsSetup=true), unlock mode, error state.

### MobileInput

- [ ] **Step 1-9: Repeat the pattern**

This is a complex input component (~300 lines). Uses `onMount`, `$state`, event handlers. Convert lifecycle to `useEffect`, state to `useState`. Imports `sendPtyData`, `isPtyConnected` from `../lib/ws.js` — these are plain TS functions, not Svelte state, so they work as-is. Test harness should mock the WebSocket functions and render the input in various states.

### ContextMenu

- [ ] **Step 1-9: Repeat the pattern**

Uses `TuiMenuItem` and `TuiMenuPanel` React versions. Has an `openAt()` method → `useImperativeHandle`. Uses `<svelte:document onkeydown>` → `useEffect` with `document.addEventListener('keydown', ...)`. The positioning logic (`positionMenu`) uses refs. Test harness: trigger button, open state, multiple menu items, disabled item, danger item.

### Batch A commit

- [ ] **Step 10: Run carabiner enforce on all new files**

```bash
npx eslint frontend/src/components/AgentBadge.tsx frontend/src/components/PickerResultRow.tsx frontend/src/components/DialogShell.tsx frontend/src/components/PinGate.tsx frontend/src/components/MobileInput.tsx frontend/src/components/ContextMenu.tsx --max-warnings=0
```

- [ ] **Step 11: Run all Playwright tests for Batch A**

```bash
npx playwright test tests/components/AgentBadge.spec.ts tests/components/PickerResultRow.spec.ts tests/components/DialogShell.spec.ts tests/components/PinGate.spec.ts tests/components/MobileInput.spec.ts tests/components/ContextMenu.spec.ts
```

---

## Task 3: Batch B — Medium Components Part 1 (8 components)

**Components:** SessionItem, WorkspaceItem, WorkspaceGroup, DiffFileSidebar, TargetBranchSwitcher, PrTopBar, SessionTabBar, SplitPaneLayout

**Same pattern as Batch A.** Each component: read Svelte → create TSX + CSS + test harness + HTML entry + Playwright spec + add vite entry.

### Key notes per component:

**SessionItem** — Uses `ContextMenu` (React version from Batch A), `CipherText`, `MarqueeText`, `StatusDot` (all already migrated). Has a discriminated union `ItemVariant` type with 3 variants. Test harness needs all 3 variant types rendered.

**WorkspaceItem** — Large (775 lines). Contains session list, drag-and-drop logic, context menus, and considerable derived state. This should be split into sub-components if possible during migration — but preserve existing API. Uses `$derived.by()` extensively → `useMemo()`.

**WorkspaceGroup** — Container for WorkspaceItems. Simpler.

**DiffFileSidebar** — File tree display for diffs. Uses file tree utility functions from `../lib/file-tree-utils.js` (plain TS, works as-is).

**TargetBranchSwitcher** — Branch selector dropdown.

**PrTopBar** — Large (630 lines). PR status bar with CI status, reviewers, merge button. Uses multiple API calls. Test harness should mock API responses.

**SessionTabBar** — Tab navigation for sessions. Uses session state.

**SplitPaneLayout** — Resizable split pane. Pure UI, no state dependencies. Uses mouse events for resize. Test harness: horizontal split, vertical split.

For each component, follow **Steps 1-9** identically to the AgentBadge pattern in Task 2.

- [ ] **Steps 1-9 for each of the 8 components**
- [ ] **Step 10: Run eslint on all 8 new TSX files**
- [ ] **Step 11: Run Playwright tests for all 8 specs**
- [ ] **Step 12: Commit**

```bash
git commit -m "migrate: Batch B medium components to React (SessionItem, WorkspaceItem, WorkspaceGroup, DiffFileSidebar, TargetBranchSwitcher, PrTopBar, SessionTabBar, SplitPaneLayout)"
```

---

## Task 4: Batch C — Medium Components Part 2 (8 components)

**Components:** OpenPicker, SearchableSelect, DataTable, BootScreen, Toolbar, TicketCard, TicketsPanel, FileTreeSidebar

### Key notes:

**OpenPicker** — Keyboard-navigable picker with fuzzy search. Uses `$state` for focus index, filter text. The `onkeydown` handler has substantial logic. Test harness: list of items, focused item, filtered state.

**SearchableSelect** — Dropdown with search input. Uses portal/floating positioning.

**DataTable** — Generic table with sorting, column resize, row selection. Uses `Map` for column widths → React `useState<Map>`. Test harness: sample data with sortable columns, selection mode.

**BootScreen** — Startup animation with `CipherText`. Simple, mostly CSS animation.

**Toolbar** — Action buttons bar. Uses `TuiButton` React version.

**TicketCard** — Single ticket display card. Leaf component.

**TicketsPanel** — Container for TicketCards with filtering. Uses DataTable internally.

**FileTreeSidebar** — Tree view for files. Uses `file-tree-utils.js` (plain TS). Recursive tree rendering → React recursive component.

For each component, follow **Steps 1-9**. Same commit pattern.

- [ ] **Steps 1-9 for each of the 8 components**
- [ ] **Step 10: Eslint validation**
- [ ] **Step 11: Playwright tests**
- [ ] **Step 12: Commit**

---

## Task 5: Batch D — Dialog Components (13 components)

**Components:** DeleteWorktreeDialog, RenameWarningModal, SettingRow, SettingsToc, SettingsDialog, CustomizeSessionDialog, WorkspaceSettingsDialog, WorkspaceEditor, AddWorkspaceDialog, GitHubIntegration, IntegrationRow, JiraIntegration, WebhookIntegration

All dialogs use `DialogShell` (migrated in Batch A). They follow a consistent pattern:
- Wrap content in `<DialogShell>` with title, footer buttons
- Form fields use `TuiInput`, `TuiButton`, `TuiCheckbox` (all already migrated)
- Use `useRef` + `useImperativeHandle` to expose `open()`/`close()`

### Key notes:

**SettingRow** — Simple label+control row. No dialog, just a layout component.

**SettingsToc** — Table of contents sidebar for settings. Links to sections.

**SettingsDialog** — Large (682 lines). Combines SettingsToc + multiple SettingRows. Uses config store. Consider breaking into sub-components during migration.

**WorkspaceSettingsDialog** — 631 lines. Workspace-specific settings. Uses config store + API calls.

**Integration components** (GitHubIntegration, JiraIntegration, WebhookIntegration, IntegrationRow) — Form-based configuration dialogs. Each uses API calls for auth/setup.

For each component, follow **Steps 1-9**.

- [ ] **Steps 1-9 for each of the 13 components**
- [ ] **Step 10: Eslint validation**
- [ ] **Step 11: Playwright tests**
- [ ] **Step 12: Commit**

---

## Task 6: Zustand State Stores (Sessions + UI + Telemetry + Boot + Unread)

**Files:**
- Create: `frontend/src/lib/stores/sessions.ts`
- Create: `frontend/src/lib/stores/ui.ts`
- Create: `frontend/src/lib/stores/telemetry.ts`
- Create: `frontend/src/lib/stores/boot-state.ts`
- Create: `frontend/src/lib/stores/unread.ts`

These are the larger state modules (510, 534, 319, 93, 52 lines). They must be migrated before the complex components that depend on them.

- [ ] **Step 1: Create sessions store**

Read `frontend/src/lib/state/sessions.svelte.ts` (510 lines). Convert all `$state()` to Zustand state, all exported functions to store actions. The store manages: session list, active session, sidebar items, polling, notifications. Use `subscribeWithSelector` middleware if needed for derived state.

- [ ] **Step 2: Create ui store**

Read `frontend/src/lib/state/ui.svelte.ts` (534 lines). Contains: view mode, sidebar state, modal state, keyboard shortcuts, layout preferences.

- [ ] **Step 3: Create telemetry store**

Read `frontend/src/lib/state/telemetry.svelte.ts` (319 lines). Event tracking, session analytics.

- [ ] **Step 4: Create boot-state store**

Read `frontend/src/lib/state/boot-state.svelte.ts` (93 lines). Boot sequence state machine.

- [ ] **Step 5: Create unread store**

Read `frontend/src/lib/state/unread.svelte.ts` (52 lines). Unread message tracking.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/lib/stores/
git commit -m "feat: add Zustand stores for sessions, ui, telemetry, boot-state, unread"
```

---

## Task 7: Batch E — Complex Components (16 components)

**Components:** Sidebar, Terminal, FileBrowser, FilePicker, FileViewerPane, FullPageDiff, DiffViewer, ChangedFiles, CommandPalette, RepoDashboard, OrgDashboard, AnalyticsDashboard, SessionDetail, AutomationPanel, StartWorkModal, StatusMappingModal

These are the largest, most stateful components. Each depends on Zustand stores from Tasks 1 + 6.

### Key notes:

**Terminal** (853 lines) — The most complex component. Uses xterm.js, WebSocket connections, resize observers. The xterm.js integration is framework-agnostic (attaches to a DOM element), so the React version wraps it in a `useEffect` + ref pattern. Test harness can render a mock terminal.

**Sidebar** — Uses sessions store, unread store, ui store. Renders WorkspaceGroups/WorkspaceItems/SessionItems. Already migrated sub-components make this mostly composition.

**FileBrowser** — File tree + file viewer split pane. Uses SplitPaneLayout, FileTreeSidebar, FileViewerPane.

**CommandPalette** (605 lines) — Keyboard-driven command palette with fuzzy search. Uses `$state` for focus, filter, results. Heavy keyboard event handling.

**RepoDashboard** (649 lines) — Main dashboard view. Composition of many sub-components.

**OrgDashboard** (787 lines) — Organization-level dashboard. API-heavy.

**AnalyticsDashboard** — Session analytics charts. Uses chart data from API.

**DiffViewer** — Code diff display. Uses shiki for syntax highlighting. The highlighting logic is in `../lib/shiki.ts` (plain TS).

**ChangedFiles** — File change list with diff stats.

**FullPageDiff** — Full-screen diff view. Composition of DiffViewer + DiffFileSidebar.

For each component, follow **Steps 1-9**.

- [ ] **Steps 1-9 for each of the 16 components**
- [ ] **Step 10: Eslint validation**
- [ ] **Step 11: Playwright tests**
- [ ] **Step 12: Commit**

---

## Task 8: Full Validation

- [ ] **Step 1: Run carabiner enforce --all**

```bash
carabiner enforce --all
```

Fix any ESLint/sonarjs/TypeScript errors in the new React components.

- [ ] **Step 2: Run all Playwright tests**

```bash
npm run test:e2e
```

- [ ] **Step 3: Run build**

```bash
npm run build
```

- [ ] **Step 4: Commit any fixes**

```bash
git commit -m "fix: resolve carabiner enforce violations in React migration"
```

---

## Subagent Dispatch Strategy

Tasks 2-5 and 7 are the bulk of the work. They can be parallelized as follows:

**Wave 1 (prerequisites):**
- Task 0: Playwright helpers (inline, fast)
- Task 1: Zustand stores for auth/toasts/config

**Wave 2 (parallel, 4 subagents):**
- Subagent A: Task 2 (Batch A — 6 simple leaf components)
- Subagent B: Task 3 (Batch B — 8 medium components part 1)
- Subagent C: Task 4 (Batch C — 8 medium components part 2)
- Subagent D: Task 5 (Batch D — 13 dialog components)

**Wave 3 (after Wave 2):**
- Task 6: Zustand stores for sessions/ui/telemetry/boot/unread

**Wave 4 (after Wave 3):**
- Task 7 (Batch E — 16 complex components) — split across 4 subagents:
  - Subagent E: Terminal, Sidebar, CommandPalette, FileBrowser
  - Subagent F: DiffViewer, ChangedFiles, FullPageDiff, FilePicker, FileViewerPane
  - Subagent G: RepoDashboard, OrgDashboard, AnalyticsDashboard, SessionDetail
  - Subagent H: AutomationPanel, StartWorkModal, StatusMappingModal

**Wave 5 (final):**
- Task 8: Full validation with carabiner enforce
