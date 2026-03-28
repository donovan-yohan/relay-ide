# Implementation: Command Center Overhaul

**Priority: WAVE 0 (Phase 2) — Phase 2 starts immediately. Phases 3-4 absorb actions from other streams.**

## Pre-flight Checks

```bash
# 1. Current state
git status
git log --oneline -3

# 2. Pull latest nightly
git fetch origin nightly
git rebase origin/nightly

# 3. No blocking dependencies. Verify existing Spotlight:
ls frontend/src/components/Spotlight.svelte 2>/dev/null || echo "Spotlight not found"
grep -r "handleQuickAgent\|handleNewWorktree\|handleOpenSettings" frontend/src/ -l || echo "Handler functions not found"

# 4. Design doc exists
cat docs/design-docs/2026-03-28-command-center-design.md | head -5
```

Phase 2 has no dependencies. Phases 3-4 absorb actions from other streams as they land.

## Design Doc

Read fully: `docs/design-docs/2026-03-28-command-center-design.md`

## What This Stream CONSUMES

### From other streams (NOT blockers — absorbed incrementally):
- Sidebar UX: new sidebar actions (kill session, rename, delete worktree) → register when landed
- PR Integration: SessionIntent actions (review-pr, fix-conflicts) → register when landed
- True Workspaces: workspace actions (launch workspace session) → register when landed
- Worktree Lifecycle: worktree actions (cleanup, resume) → register when landed

None of these block Phase 2. Phase 2 registers the 15 HIGH-priority actions that ALREADY EXIST in the codebase.

## What This Stream PRODUCES

### Contract: Action Registration Interface

```typescript
// frontend/src/lib/actions/types.ts
type ActionMeta = Omit<Action, 'handler'>;

type Action = {
  id: string;           // 'category.verb-noun' e.g. 'session.new-agent'
  label: string;        // all lowercase per DESIGN.md
  description?: string;
  aliases?: string[];
  category: 'session' | 'workspace' | 'pr' | 'settings' | 'navigation' | 'terminal';
  icon?: string;
  shortcut?: { key: string; global?: boolean };
  when?: (ctx: ActionContext) => boolean;
  handler: (ctx: ActionContext) => void | Promise<void>;
  mobile?: { showInSheet?: boolean; label?: string };
};

type ActionContext = {
  view: 'workspace' | 'session' | 'dashboard' | 'settings' | 'org';
  workspaceId?: string;
  sessionId?: string;
  agentRunning?: boolean;
  isMobile?: boolean;
  prState?: 'none' | 'draft' | 'open' | 'merged' | 'closed';
};

// Registry functions
registerGlobal(actions: Action[]): void;
registerContextual(actions: Action[]): void;
unregisterContextual(ids: string[]): void;
```

### Contract: File Structure

```
frontend/src/lib/actions/
  types.ts              — Action, ActionMeta, ActionContext types
  registry.svelte.ts    — ActionRegistry (Svelte 5 runes)
  frecency.ts           — Frecency scoring (localStorage)
  shortcuts.svelte.ts   — Centralized keyboard shortcut listener
  context.svelte.ts     — ActionContext provider

frontend/src/lib/actions/definitions/
  session.ts            — Session action metadata
  workspace.ts          — Workspace action metadata
  pr.ts                 — PR/branch action metadata
  settings.ts           — Settings action metadata
  navigation.ts         — Navigation action metadata
  terminal.ts           — Terminal action metadata
```

## Implementation Order (from design doc)

**Phase 2 — Registry + 15 HIGH-priority actions (start immediately):**
1. Action type + ActionMeta type in `types.ts`
2. ActionRegistry in `registry.svelte.ts` (runes-based Map)
3. Define 15 HIGH-priority ActionMeta objects in definition files
4. Register all 15 in App.svelte with handler closures
5. Modify Spotlight.svelte to read from ActionRegistry instead of hardcoded array
6. Basic context gating: 3 reactive booleans (hasWorkspace, hasSession, hasPr)
7. Coverage test: `test/action-coverage.test.ts` with allowlist

**Phase 3 — CommandPalette + Shortcuts (after Phase 2):**
1. CommandPalette.svelte (replaces Spotlight): mobile bottom sheet, category tabs, shortcut hints
2. ShortcutListener — centralized keyboard handler replacing scattered listeners
3. Register remaining 42 MED/LOW-priority actions
4. Mobile entrypoint in MobileHeader.svelte

**Phase 4 — Discoverability (after Phase 3):**
1. Frecency ranking (localStorage usage tracking)
2. Full ActionContext derivation (view priority, agentRunning, prState)
3. "Needs attention" section in palette
4. Tooltip shortcut hints across the app

## What NOT to Build

- Natural language commands → north star, not in scope
- Composable workflows / "save as workflow" → north star, not in scope
- Per-action telemetry → forward-compatible type field, not implemented

## Process

1. Run `/harness:plan` for Phase 2
2. Run `/harness:orchestrate` — Phase 2 ships with existing Spotlight UI backed by registry
3. After Phase 2 lands, run `/harness:plan` for Phase 3
4. Phase 3 ships the new CommandPalette component
5. Run `/harness:complete` after Phase 3
