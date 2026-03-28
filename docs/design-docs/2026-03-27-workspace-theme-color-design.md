---
status: current
created: 2026-03-27
branch:
supersedes:
implemented-by:
consulted-learnings: []
---

# Workspace Theme Color

## Problem

The colored initial block next to each workspace in the sidebar is derived from a hash of the workspace name (`deriveColor()` in `frontend/src/lib/colors.ts`). Users can't customize this color, which means:

- Two repos that hash to the same color look identical at a glance
- No way to assign meaningful colors (e.g. red for production, green for personal)
- The derived color has no connection to the actual workspace identity the user wants

## Proposal

### 1. Color Picker in Workspace Settings

Add a `themeColor` field to `WorkspaceSettings` (both frontend and backend types). In the WorkspaceSettingsDialog, add a color picker section above or within the existing settings.

**Data model changes:**
- `WorkspaceSettings.themeColor?: string` — hex color string (e.g. `#d97757`)
- When `themeColor` is set, use it instead of `deriveColor(name)`
- When `themeColor` is null/undefined, fall back to current derived behavior

**UI approach:**
- Show a row of preset color swatches (the existing `INITIAL_COLORS` palette + a few more)
- Include a custom hex input for power users
- Show a preview of the initial block with the selected color
- "Reset" button returns to auto-derived color

**Files to modify:**
- `server/types.ts` — add `themeColor` to `WorkspaceSettings`
- `frontend/src/lib/types.ts` — add `themeColor` to `WorkspaceSettings`
- `frontend/src/components/dialogs/WorkspaceSettingsDialog.svelte` — add color picker UI
- `frontend/src/components/WorkspaceItem.svelte` — use `workspace.themeColor ?? deriveColor(name)` for initial block

### 2. Claude Code Session Color Matching

When a session is started via Relay, pass the workspace theme color to the Claude Code process so the CLI session visually matches.

**Research finding:** Claude Code does not currently have a `--color` or `--theme` CLI flag. Options:
- Set an environment variable (e.g. `RELAY_THEME_COLOR`) on the PTY process that a status line script could read
- If Claude Code adds a color setting in the future, pass it via `--settings` JSON
- Could also set the `CLAUDE_CODE_COLOR` env var if/when CC supports it

**Implementation approach (env var):**
- In `server/pty-handler.ts`, when spawning the PTY, include the resolved theme color in the environment
- The status line or terminal can read this env var for visual theming

### Palette

Default swatches should include the existing derived colors plus a few extras:

```
#d97757  rust/terracotta (current accent)
#4ade80  green
#60a5fa  blue
#a78bfa  purple
#f472b6  pink
#fb923c  orange
#34d399  emerald
#f87171  red
#fbbf24  amber
#06b6d4  cyan
#8b5cf6  violet
#ec4899  magenta
```

## Open Questions

- Should the theme color also tint the session border-left color in the sidebar (currently uses `--accent`)?
- Should the color be visible in the workspace header area of the main content pane?
- Should there be a global default theme color setting?
