---
status: implemented
created: 2026-03-25
branch: tui-outline-aesthetic
supersedes:
implemented-by:
consulted-learnings: []
---

# TUI Design System Overhaul

## Goal

Build a TUI-native component library for Relay that makes design drift structurally impossible. Replace duplicated patterns with shared primitives. Add 8 micro-interactions that shift the product identity from "styled like a terminal" to "behaves like a terminal."

## Problem

The frontend has grown to 40+ Svelte components with systemic inconsistencies:
- 4 separate `.btn` class definitions with different padding values
- 47+ unique padding values with no spacing scale
- 20+ hardcoded font sizes instead of using CSS variables
- Status dots duplicated in 4 places instead of using the StatusDot component
- 3 identical integration card implementations (GitHub/Webhook/Jira)
- No shared layout tokens for alignment
- Loading states inconsistent (shimmer, skeleton bars, plain text)

## Approach

### Phase 1: Foundation
- Add layout alignment tokens and spacing scale to `app.css`
- Move button CSS from DialogShell `:global()` to app.css as global classes
- Normalize all hardcoded font sizes to the 4-variable scale (~55 changes across 20 files)
- Fix remaining hardcoded border colors and debug values

### Phase 2: Core Components (9 new + 1 modified)
- **TuiButton** — Box-drawing corner characters (┌┐└┘ → ╔╗╚╝ on hover), replaces all `.btn` definitions
- **TuiRow** — Layout primitive enforcing icon/content/action column grid, prevents alignment drift
- **TuiMenuPanel + TuiMenuItem** — Visual primitives for dropdown/menu panels with fzf `>` cursor
- **CipherText** — Smart loading component: random ASCII noise → character-by-character resolve
- **MarqueeText** — Overflow text scrolls on hover (Spotify-style), animates back on leave
- **TuiInput** — Block cursor (█), solid while typing, blinks when idle, native caret hidden
- **TuiProgress** — ASCII bar, Knight Rider, braille spinner, line spinner
- **IntegrationRow** — Extracted accordion pattern for settings integration cards
- **StatusDot** — Extended with new variants (running, idle, connected, warning, etc.)

### Phase 3: Adoption
- Replace all button instances with TuiButton (~15 files)
- Replace all loading states with CipherText (~7 files)
- Consolidate StatusDot usage (~5 files)
- Extract IntegrationRow (3 integration files)
- Adopt MarqueeText, TuiInput in high-visibility locations

### Phase 4: Polish
- CRT scanline overlay on sidebar (drift + hover sweep)
- Alignment audit of all list components using TuiRow grid
- Padding normalization to 4px grid across all components

## Deliverable Summary

1. Layout tokens in app.css (--sidebar-padding-x, --icon-slot-width, --space-* scale)
2. Global button CSS in app.css (extracted from DialogShell)
3. Font-size normalization (~55 changes across 20 files)
4. TuiButton component with box-drawing corners
5. TuiRow layout primitive
6. TuiMenuPanel + TuiMenuItem primitives
7. CipherText component (smart loading + text transitions)
8. MarqueeText component (overflow scroll on hover)
9. TuiInput component (block cursor)
10. TuiProgress component (4 spinner/bar variants)
11. IntegrationRow component (extracted accordion pattern)
12. StatusDot extended with new variants
13. TuiButton adopted across ~15 consumer files
14. CipherText adopted across ~7 consumer files
15. StatusDot consolidated across ~5 files
16. IntegrationRow adopted in 3 integration files
17. MarqueeText adopted in SessionItem
18. TuiInput adopted in BranchSwitcher, SearchableSelect, PinGate, Spotlight
19. FZF `>` cursor in ContextMenu, BranchSwitcher, SearchableSelect (via TuiMenuItem)
20. CRT scanline overlay on Sidebar
21. Alignment audit using TuiRow grid
22. Padding normalization to 4px grid
23. Vitest logic tests for CipherText, TuiInput, MarqueeText, TuiProgress, TuiButton

## Key Decisions

- Dropdowns stay separate (BranchSwitcher, SearchableSelect, ContextMenu) — only visual primitives (TuiMenuPanel + TuiMenuItem) are shared
- CipherText is a smart component with `loading` prop, not a pure visual
- TuiRow enforces alignment at the component level, not via CSS utility classes
- Block cursor clips within input bounds via `overflow: hidden` on wrapper
- All animations respect `prefers-reduced-motion`
- All animations under 400ms

## Codex Review Fixes (incorporated)

1. **Tests use `node:test` not Vitest** — ADR-005 mandates Node built-in test runner. Frontend logic tests run via `node --test`.
2. **Don't remove skeleton CSS in Phase 1** — wait until CipherText replaces consumers in Phase 3
3. **Skip `.btn` bridge** — go straight from local `.btn` to TuiButton, no intermediate globalization step
4. **Add TargetBranchSwitcher** to adoption inventory (missed from original audit)
5. **StatusDot variants must match actual display-state model** — `initializing`, `unseen-idle`, `seen-idle`, `permission`, `inactive`, `permission-prompt`
6. **TuiMenuItem uses `onmousedown`** not `onclick` — preserves blur timing for dropdown selection
7. **TuiButton/TuiInput forward attributes** — use `{...rest}` spread for `aria-*`, `title`, `data-track`, `inputmode`, etc.
8. **TuiInput rollout order**: start with PinGate (simplest), then Spotlight, then BranchSwitcher/SearchableSelect
9. **CipherText scope**: use for status text transitions and inline loading text. Keep structural skeletons for layout-heavy loading. Add `aria-live="polite"` for screen readers.
10. **Hover interactions are desktop-only enhancements** — touch devices get the base experience without marquee/scanline/fzf cursor

## References

- DESIGN.md (root) — full design system specification
- Approved eng review plan: `.claude/plans/composed-moseying-engelbart.md`
- Preview page: `/tmp/design-tui-vision-preview.html`
