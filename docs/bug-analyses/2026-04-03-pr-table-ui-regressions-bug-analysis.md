# PR Table UI Regressions (DYS-10)

**Date:** 2026-04-03
**Severity:** Medium (visual regressions, no data loss)
**Status:** Fixed

## Symptoms

Four UI regressions in the PR table across both RepoDashboard and OrgDashboard, introduced during the Svelte-to-React migration:

1. **Button alignment** -- Action buttons (`+` and action labels like "review", "fix conflicts") not vertically aligned in the action column
2. **Column width truncation** -- Age column (`width: 50`) too narrow, causing "1h ago" to render as "1h a..."
3. **Missing button colors** -- All action buttons rendered as `ghost` variant (muted gray) regardless of semantic meaning (merge = green, fix conflicts = red, review = blue)
4. **Phantom scroll fade** -- Fade-to-black gradient at bottom of scroll sections always visible, even when content fits without scrolling

## Root Cause

### 1. Button alignment
- `RepoDashboard.css` `.pr-cell--action` lacked explicit `align-items: center` and `gap`
- `OrgDashboard.css` `.cell--action` same issue

### 2. Column width truncation
- `RepoDashboard.tsx` PrRow: age column set to `width: 50` (too narrow for monospace relative times)
- `OrgDashboard.tsx` OrgPrRow: same `width: 50`
- `RepoDashboard.css` `.pr-age-text` had `overflow: hidden; text-overflow: ellipsis` which actively truncated text

### 3. Missing button colors
- `RepoDashboard.tsx` PrRow: `+` button used `variant="ghost"` instead of `variant="primary"`. Action button hardcoded to `variant="ghost"` instead of mapping `action.color` through a `colorToVariant()` helper (which PrTopBar.tsx already had)
- `OrgDashboard.tsx` OrgPrRow: used a raw `<button>` element instead of `TuiButton` with semantic variant
- Both components were missing the `colorToVariant` mapping function present in PrTopBar.tsx

### 4. Phantom scroll fade
- `RepoDashboard.css` `.dashboard-section--scroll::after` unconditionally rendered a 32px gradient overlay
- No scroll detection mechanism -- the fade appeared even when content did not overflow

## Evidence

| File | Line | Issue |
|------|------|-------|
| `frontend/src/components/RepoDashboard.tsx` | 309 | `variant="ghost"` on `+` button |
| `frontend/src/components/RepoDashboard.tsx` | 317 | `variant="ghost"` on action button |
| `frontend/src/components/RepoDashboard.tsx` | 302 | `width: 50` age column |
| `frontend/src/components/RepoDashboard.css` | 38-48 | Unconditional `::after` fade |
| `frontend/src/components/RepoDashboard.css` | 203-207 | `overflow: hidden; text-overflow: ellipsis` on age text |
| `frontend/src/components/OrgDashboard.tsx` | 141 | Raw `<button>` instead of TuiButton |
| `frontend/src/components/OrgDashboard.tsx` | 140 | `width: 50` age column |

## Fix

### 1. Button alignment
- Added `align-items: center; gap: 8px` to `.pr-cell--action` (RepoDashboard.css)
- Added `align-items: center` to `.cell--action` (OrgDashboard.css)

### 2. Column width
- Widened age column from `width: 50` to `width: 72` in both RepoDashboard and OrgDashboard
- Changed `.pr-age-text` from truncating (`overflow: hidden; text-overflow: ellipsis`) to `white-space: nowrap` only

### 3. Button colors
- Added `colorToVariant()` helper to both RepoDashboard.tsx and OrgDashboard.tsx (matching PrTopBar.tsx pattern)
- Changed `+` button from `variant="ghost"` to `variant="primary"` (accent color per DESIGN.md)
- Changed action button from `variant="ghost"` to `variant={colorToVariant(action.color)}`
- Replaced raw `<button>` in OrgPrRow with `<TuiButton variant={colorToVariant(action.color)} size="sm">`

### 4. Scroll fade
- Made `::after` fade default to `opacity: 0` with a transition
- Added `.has-overflow` modifier class that sets `opacity: 1`
- Added `useScrollOverflow()` hook using `ResizeObserver` to detect when content overflows
- Applied to both the PR list section and the activity section

## Impact
- Visual-only regression, no functional or data impact
- Affected both per-repo dashboard (RepoDashboard) and org-wide dashboard (OrgDashboard)

## Architecture Review
- The `colorToVariant()` function is now duplicated in 3 files (PrTopBar, RepoDashboard, OrgDashboard). Consider extracting to a shared utility if more consumers appear.
- The `useScrollOverflow` hook could be extracted to a shared hooks module for reuse.
