# Design System — Relay

## Product Context

- **What this is:** Hub/node agentic development environment for managing terminal-native agent tabs across local and remote nodes. Repos and worktrees are the golden-path local Project/Bench case, but the user-facing source of truth is the active tab context: `nodeId`, `cwd`, and `kind`.
- **Who it's for:** Developers who use CLI agents (Claude Code, Codex, OpenCode, Hermes, and remote node shells) — power users who live in terminals
- **Space/industry:** Developer tools, CLI companions, terminal multiplexers
- **Project type:** Web app (mobile-friendly) with terminal-native aesthetic

## Aesthetic Direction

- **Direction:** Industrial/Utilitarian — TUI-native
- **Decoration level:** Minimal — structure IS the decoration. No ornamentation.
- **Mood:** A well-built CLI tool that happens to live in a browser. Casual authority, not enterprise polish. The interface should feel like it was built by someone who uses `tmux` daily.
- **Anti-patterns:** No purple gradients, no rounded pill buttons, no centered-everything layouts, no decorative blobs, no emoji icons, no solid filled buttons.

## Typography

- **All roles:** System monospace stack — `'SF Mono', 'Cascadia Code', 'JetBrains Mono', 'Fira Code', 'Consolas', monospace`
- **Rationale:** Single font family reinforces the terminal identity. No sans-serif anywhere.
- **Case:** All section labels and headers use **lowercase**. `git settings` not `GIT SETTINGS`. This shifts tone from enterprise admin panel to casual dev tool.
- **Scale:**
  - `--font-size-xs`: 0.75rem — labels, metadata, table headers
  - `--font-size-sm`: 0.8125rem — body text, list items
  - `--font-size-base`: 0.875rem — primary content
  - `--font-size-lg`: 1rem — page titles, dialog titles

## Color

### Core Palette

- **Approach:** Restrained — accent + neutrals + semantic status colors
- **Background:** `--bg: #000000` — pure black, used for ALL primary surfaces including sidebar
- **Surface:** `--surface: #0a0a0a` — reserved ONLY for floating elements (dialogs, dropdowns, toasts, context menus) that need visual separation from the page
- **Surface hover:** `--surface-hover: #141414` — hover/active state for interactive elements
- **Accent:** `--accent: #d97757` — terracotta, primary brand color, used for focus rings, active states, primary button borders
- **Text:** `--text: #e0e0e0` — primary text
- **Text muted:** `--text-muted: #888888` — secondary text, labels, metadata
- **Border:** `--border: #333333` — all structural borders

### Semantic Status Colors

- **Success:** `--status-success: #4ade80` — merge-ready, active sessions, healthy state
- **Error:** `--status-error: #f87171` — failures, danger actions, conflicts
- **Warning:** `--status-warning: #fbbf24` — review requested, pending actions
- **Merged:** `--status-merged: #a78bfa` — merged PRs, completed state
- **Info:** `--status-info: #60a5fa` — informational, review actions

### Diff Line Tints

- **Added line:** `--diff-added-bg: color-mix(in srgb, var(--status-success) 9%, transparent)` — restrained green tint behind added lines only
- **Removed line:** `--diff-removed-bg: color-mix(in srgb, var(--status-error) 9%, transparent)` — restrained red tint behind removed lines only

These tokens are dark-only backgrounds for diff-shaped content. Keep the text
palette unchanged; the tint communicates line polarity without introducing a
separate rainbow syntax theme.

### Repo / Project Identity Colors

12 colors for hash-derived repo/project badge backgrounds. Each bound repo Project gets a deterministic color based on its name; free/non-git and unbound remote tabs do not inherit a repo badge just because their `cwd` looks repo-shaped.

```
--color-red:     #d97757    (terracotta — also the accent)
--color-green:   #4ade80
--color-blue:    #60a5fa
--color-purple:  #a78bfa
--color-pink:    #f472b6
--color-orange:  #fb923c
--color-teal:    #34d399
--color-coral:   #f87171
--color-yellow:  #fbbf24
--color-sky:     #38bdf8
--color-lime:    #a3e635
--color-indigo:  #818cf8
```

Each color has a muted variant for workspace group backgrounds: `color-mix(in srgb, var(--color-X) 15%, transparent)`.

### Dark Mode

- **Strategy:** Dark-only. No light mode. This is a dev tool used alongside terminals.
- There is no theme toggle, light-theme CSS, or stored theme preference. The app renders the all-dark palette (`:root` in `frontend/src/App.css`) unconditionally.

## Spacing

- **Base unit:** 4px
- **Density:** Compact — data-dense terminal UX
- **Scale:** 2xs(2px) xs(4px) sm(8px) md(16px) lg(24px) xl(32px) 2xl(48px) 3xl(64px)

## Layout

- **Approach:** Grid-disciplined — strict sidebar + main area split
- **Sidebar width:** 240px default, resizable, collapsible
- **Max content width:** None — content fills available space
- **Border radius:**
  - **0px** for all UI elements: buttons, dialogs, menus, inputs, pills, badges, context menus, toasts, cards, containers
  - **2px** exception for repo badges/avatars (24x24px or smaller) — optical correction; at small sizes, square corners look jagged rather than intentionally sharp
  - **50%** for status dots only — these are semantically circular (active/inactive indicators)

## Buttons

- **All buttons are outline-only.** No solid/filled backgrounds anywhere.
- **Border:** `1px solid` with color matching the button's semantic role
- **Background:** `transparent` at rest
- **Hover:** Subtle tint at 8-12% opacity: `color-mix(in srgb, [button-color] 10%, transparent)`
- **Variants:**
  - **Primary:** `border-color: var(--accent); color: var(--accent)` — save, confirm, add
  - **Success:** `border-color: var(--status-success); color: var(--status-success)` — merge
  - **Danger:** `border-color: color-mix(in srgb, var(--status-error) 50%, transparent); color: var(--status-error)` — remove, delete (border at 50% to reduce visual weight at rest, full on hover)
  - **Info:** `border-color: var(--status-info); color: var(--status-info)` — review PR
  - **Ghost:** `border-color: var(--border); color: var(--text-muted)` — cancel, secondary actions
- **Disabled:** `opacity: 0.4; cursor: not-allowed`

## Checkboxes

- **Style:** Terminal-style custom checkboxes using monospace bracket characters
- **Checked:** `[x]` in accent color
- **Unchecked:** `[ ]` in muted text color
- **No native browser checkbox styling.** Hide the native input, render the bracket characters as a sibling span.

## Icons

- **No emojis anywhere.** All emoji usage (robot, terminal, gear, etc.) must be replaced with flat monochrome SVG line icons.
- **Style:** Stroke-based, 1.5px stroke width, `stroke-linecap: square` (reinforces the square aesthetic)
- **Color:** `var(--text-muted)` at rest, `var(--text)` on hover
- **Size:** 14-18px depending on context
- **Agent badges:** Claude and Codex already use proper SVGs — this is the reference pattern for all icons.

## Workspace Grouping

- **Pattern:** Workspace containers use an outlined border derived from the group's assigned color
- **Border:** `1px solid color-mix(in srgb, [group-color] 30%, transparent)` — subtle enough to group visually without competing with content
- **Background:** Pure black (`--bg`) interior — no colored backgrounds
- **Purpose:** Visual grouping of pinned Projects and active Tabs within a workspace, distinguishable at a glance by border color. In the current local implementation many workspace rows still represent repo/worktree groups; document that as the repo Project/Bench case, not as the universal model.

## Alignment Architecture

Alignment is a system-level concern, not a per-component pixel-push. These rules ensure everything fits together without manual adjustment.

### Layout Tokens

- `--sidebar-padding-x: 16px` — horizontal padding for sidebar items
- `--content-padding-x: 20px` — horizontal padding for main content area
- `--row-padding-y: 10px` — vertical padding for list rows
- `--icon-slot-width: 24px` — fixed width for left-aligned icon columns
- `--action-slot-width: 36px` — fixed width for right-aligned action columns

### Alignment Rules

1. **Left icons form a vertical column.** Every icon in a list (status dots, repo badges, session indicators, menu icons) sits in a fixed-width slot (`--icon-slot-width`). The text content starts at the same horizontal position regardless of icon presence.
2. **Right actions form a vertical column.** Action buttons, checkboxes, toggles, and metadata on the right side of rows align to a consistent trailing edge using `margin-left: auto` within flex rows.
3. **Borders always extend edge-to-edge.** Dividers, section separators, and row borders span the full width of their container with zero horizontal margin. Use `margin: 0 calc(-1 * var(--sidebar-padding-x))` to break out of parent padding when needed.
4. **Nested content indents by `--icon-slot-width`.** Child items (worktree sessions under a workspace, sub-settings under a section) indent by exactly the icon slot width, maintaining the visual column.
5. **No floating panels.** Dialog sidebars (TOC, navigation) attach flush to the dialog content with no gap. Use a single flex container with `gap: 0`.
6. **Consistent row heights.** Interactive rows have a minimum height of `44px` (touch target) with content vertically centered.

### Component Grid Pattern

```
|<-- padding -->|<-- icon -->|<-- content (flex: 1) -->|<-- action -->|<-- padding -->|
|   16px        |   24px     |   flexible              |   36px       |   16px        |
```

Every list row (sidebar items, settings rows, menu items, table rows) follows this grid. The padding, icon slot, and action slot are fixed. Content fills the remaining space.

## Motion & Micro-Interactions

The terminal identity comes from BEHAVIOR, not just styling. Every animation completes in under 400ms. Nothing blocks interaction.

### Easing

- **Enter:** ease-out (elements arriving)
- **Exit:** ease-in (elements leaving)
- **Move:** ease-in-out (elements repositioning)

### 1. ASCII Box-Drawing Buttons

Buttons use Unicode box-drawing corner characters (`┌ ┐ └ ┘`) with CSS border edges between them. On hover, corners upgrade to double-line variants (`╔ ╗ ╚ ╝`) and edges shift to double borders. Implementation: Svelte TuiButton component with corner `<span>` elements and CSS `border-top`/`border-bottom` for edges.

### 2. Cipher-Decode Loading

Replace skeleton pulse bars with text that starts as random ASCII noise and resolves character-by-character from left to right. Each unresolved character cycles through random glyphs at ~40ms intervals. Resolution sweeps at ~10ms/char. Total duration 300-500ms. When real data arrives, remaining characters snap to final values instantly. Also used for status text changes (effect 7).

### 3. Marquee-Scroll Overflow

Long text that overflows its container scrolls horizontally on hover (Spotify-style). On mouse leave, text smoothly animates back to start position. Speed is constant (~50px/sec) regardless of text length — longer text takes proportionally longer. Trailing edge has a 24px fade gradient. **Scroll distance extends 32px past the overflow** (past the fade gradient + 8px breathing room) so all text is fully visible at scroll end. CSS-only with `transition` on `transform: translateX()`.

### 4. Terminal Block Cursor

Focused inputs show a block cursor (`█`) at the insertion point. Native caret is hidden via `caret-color: transparent`. **Solid while typing, blinks only when idle** — cursor stays visible during active input, then starts blinking after 530ms of no keystrokes (matches real terminal behavior). Cursor position tracks via JS measurement of text width. Opacity: 0.7 when visible (not fully opaque — subtler).

### 5. FZF-Style `>` Cursor in Menus

Dropdown and context menu items show a `>` character as the selection indicator. The `>` slides in from left with a quick `transform: translateX` transition (120ms ease-out). Items still get a subtle background tint on hover, but `>` is the primary affordance. Replaces highlight-only hover patterns.

### 6. Progress Indicators

Four-tier hierarchy by available space:

- **ASCII bar** `[████████░░░░░░░░] 52%` — determinate, when horizontal space is available
- **Knight Rider** `[░░░░████░░░░░░░░]` — indeterminate, horizontal space, bouncing block
- **Braille spinner** `⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏` — indeterminate, tight space (1 character), 80ms cycle
- **Line spinner** `| / - \` — indeterminate, tightest space (1 character), 120ms cycle

### 7. Cipher-Decode Status Changes

When status text changes (session activates, PR merges, build passes), the old text scrambles to noise then resolves into the new text using the cipher-decode effect. Duration: ~200-300ms total. Dot color changes simultaneously at scramble start. This unifies effects 2 and 7 — one consistent text transition pattern.

### 8. Scanline / CRT Effect

A barely-visible (opacity 0.02-0.03) repeating scanline pattern overlays the sidebar. The pattern continuously drifts downward at a slow rate (~8s cycle) creating the optical illusion of a CRT display. On hover over workspace items, a single faint horizontal scanline sweeps down the item (~800ms, ease-in-out). This is the most decorative element — intentionally subtle, an easter egg for close inspection.

## Implementation Audit Checklist

### Completed (v1 overhaul)

- [x] Remove all `border-radius` > 0 except status dots (50%) and repo badges (2px)
- [x] Convert all solid/filled buttons to outline-only
- [x] Convert all `text-transform: uppercase` and hardcoded uppercase labels to lowercase
- [x] Replace all emoji usage with SVG icons
- [x] Change sidebar background from `--surface` to `--bg` (pure black)
- [x] Implement terminal-style `[x]`/`[ ]` checkboxes (TuiCheckbox component)
- [x] Convert PR table pills to outline-only
- [x] Expand color array in `colors.ts` from 8 to 12 colors

### Pending (v2 micro-interactions + alignment)

- [ ] Implement TuiButton component with box-drawing corners
- [ ] Implement cipher-decode loading component
- [ ] Implement marquee-scroll overflow component
- [ ] Implement block cursor for focused inputs
- [ ] Add `>` cursor to ContextMenu and dropdown components
- [ ] Implement ASCII progress bar and spinner components
- [ ] Apply cipher-decode to status text transitions
- [ ] Add scanline CRT overlay to sidebar
- [ ] Apply alignment architecture tokens and rules across all components
- [ ] Fix SettingsDialog layout — TOC must attach flush to content, no floating panel

## Decisions Log

| Date       | Decision                                      | Rationale                                                                                                                                 |
| ---------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-03-25 | Initial design system created                 | Created by /design-consultation based on existing v3 Terminal Aesthetic and user feedback on screenshots                                  |
| 2026-03-25 | All-lowercase section labels                  | Casual terminal feel over enterprise admin panel tone                                                                                     |
| 2026-03-25 | Zero border-radius (with 2px badge exception) | Uncompromising TUI aesthetic; badge exception is optical correction at small sizes                                                        |
| 2026-03-25 | Outline-only buttons, no solid fills          | TUI/Ink aesthetic — consistent with terminal tool identity                                                                                |
| 2026-03-25 | No emojis, flat SVG icons only                | Visual consistency; emojis render differently per platform                                                                                |
| 2026-03-25 | Pure black (#000) for all primary surfaces    | Sidebar and main area should be identical black; --surface reserved for floating elements only                                            |
| 2026-03-25 | 12-color repo identity palette                | More colors for visual distinction between repos; hash-derived assignment                                                                 |
| 2026-03-25 | Workspace group outlined borders              | Subtle color-coded borders for visual grouping without background fills                                                                   |
| 2026-03-25 | TUI micro-interactions (8 effects)            | Box-drawing buttons, cipher-decode loading, marquee scroll, block cursor, fzf cursor, ASCII progress, cipher status changes, CRT scanline |
| 2026-03-25 | Alignment architecture                        | System-level layout tokens and rules — icon/action columns, edge-to-edge borders, consistent row grid                                     |
