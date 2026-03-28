---
status: current
created: 2026-03-27
branch:
supersedes:
implemented-by:
consulted-learnings: []
---

# Tooltip & Keyboard Shortcut Architecture

## Problem

Icons and action buttons across the UI lack contextual tooltips. Users can't discover what an icon does or learn keyboard shortcuts without trial and error. There's also no centralized system for managing keyboard shortcuts, making them hard to add, document, and avoid conflicts.

## Reference

The target UX is similar to VS Code / Cursor's tooltip pattern: hovering over any icon shows a tooltip with a label and the associated keyboard shortcut (e.g. "Create from... Cmd+Shift+N").

## Proposal

### 1. Tooltip Component

Create a reusable `Tooltip.svelte` component that:

- Wraps any element and shows a styled tooltip on hover/focus
- Displays a label and optional keyboard shortcut
- Supports positioning (top, bottom, left, right) with auto-flip
- Uses the existing terminal aesthetic (dark surface, mono font, subtle border)
- Has a small delay before showing (~300ms) to avoid flicker on mouse pass-through
- Renders the shortcut keys in styled `<kbd>` elements (platform-aware: Cmd vs Ctrl)

**Style:**
```
┌─────────────────────────┐
│ Create from...  ⌘⇧N     │
└─────────────────────────┘
```

- Background: `var(--surface)` or slightly lighter
- Border: `var(--border)`
- Font: `var(--font-mono)`, `var(--font-size-xs)`
- Kbd styling: slightly raised background, rounded corners

### 2. Keyboard Shortcut Registry

Create a centralized shortcut system:

**`frontend/src/lib/shortcuts.ts`** — single source of truth

```ts
interface Shortcut {
  id: string;                    // unique key, e.g. 'new-worktree'
  key: string;                   // the key (e.g. 'n', 'k', 'Enter')
  mod?: ('meta' | 'shift' | 'alt' | 'ctrl')[];  // modifier keys
  label: string;                 // human-readable label
  description?: string;          // longer description for help
  scope?: 'global' | 'sidebar' | 'terminal' | 'dialog';  // where it's active
}
```

**Registry pattern:**
- All shortcuts defined in one place (easy to audit for conflicts)
- Export a `SHORTCUTS` map keyed by id
- Helper function `formatShortcut(id)` returns display string (e.g. "⌘⇧N")
- Helper function `matchesShortcut(event, id)` checks if a keyboard event matches
- Platform detection: show ⌘ on macOS, Ctrl on others

**Global listener:**
- A single `keydown` listener at the app level that dispatches to handlers
- Handlers registered/unregistered based on active scope (e.g. dialog open = dialog scope)
- Prevents conflicts between scopes (dialog shortcuts don't fire when no dialog is open)

### 3. Where to Add Tooltips

Priority targets (existing icons lacking context):

**Sidebar:**
- Workspace settings gear icon → "Settings ⌘,"
- Collapse/expand chevron → "Collapse" / "Expand"
- New worktree button → "New worktree ⌘N"
- Context menu dots → "Actions"

**Toolbar / Header:**
- Any action buttons in the session toolbar
- Session type indicators

**Settings Dialog:**
- Reset buttons → "Reset to global defaults"
- Override badges → "This setting overrides the global default"

### 4. Implementation Phases

**Phase 1: Foundation**
- Create `Tooltip.svelte` component
- Create `shortcuts.ts` registry with initial shortcuts
- Add global keyboard listener with scope management

**Phase 2: Sidebar tooltips**
- Wrap sidebar action icons with Tooltip
- Register sidebar-scoped shortcuts (new worktree, settings, etc.)

**Phase 3: App-wide rollout**
- Add tooltips to toolbar, dialogs, dashboard actions
- Add a "Keyboard Shortcuts" help panel (⌘? or ⌘K)

## Open Questions

- Should shortcuts be user-configurable (like VS Code keybindings.json)?
- Should there be a command palette (⌘K) that lists all available actions?
- How to handle mobile (no hover, no keyboard shortcuts) — skip tooltips, or show on long-press?
