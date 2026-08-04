# Unstyled Buttons in All Workspaces PR List (DYS-11)

**Date:** 2026-04-03
**Severity:** Low-Medium (visual regression, no functional impact)
**Status:** Fixed

## Symptoms

In the "All Workspaces" view (`OrgDashboard`), two button types rendered as default/unstyled HTML buttons instead of using the project's `TuiButton` component:

1. **Preset delete buttons** — In the `PresetsRow` sub-component, buttons to delete named filter presets (e.g., "× my-filter") used a raw `<button>` with custom CSS class `.preset-delete-btn` instead of `TuiButton`.
2. **Retry button** — In the `PrsTabError` sub-component, the "Retry" button shown on GitHub timeout errors used a raw `<button>` with custom CSS class `.retry-btn` instead of `TuiButton`.

Both buttons had hand-written CSS that approximated the TuiButton styles, but bypassed the design system component entirely — resulting in visual inconsistency on hover states and missing semantic box-drawing corner interactions defined in DESIGN.md.

## Root Cause

The Svelte-to-React migration (Batch E1, commit `6bd9bd5`) converted `OrgDashboard.svelte` to `OrgDashboard.tsx` but did not replace all interactive elements with the `TuiButton` component. The React migration created raw `<button>` elements for several interactive buttons:

- `OrgPrRow` action button (`<button onClick={...}>`) — partially remediated in DYS-10
- `PresetsRow` delete buttons (`<button className="preset-delete-btn">`) — **this bug**
- `PrsTabError` retry button (`<button className="retry-btn">`) — **this bug**

DYS-10 fixed the PR row action button (`Open`, `Fix Conflicts`, etc.) in `OrgPrRow` but left the preset delete and retry buttons as raw elements with bespoke CSS. The bespoke CSS in `OrgDashboard.css` manually reproduced button styling using different hover colors and without TuiButton's box-drawing corner animation.

## Evidence

| File | Line | Issue |
|------|------|-------|
| `frontend/src/components/OrgDashboard.tsx` | ~205 | `<button className="preset-delete-btn">` in `PresetsRow` |
| `frontend/src/components/OrgDashboard.tsx` | ~342 | `<button className="retry-btn">` in `PrsTabError` |
| `frontend/src/components/OrgDashboard.css` | ~288-303 | `.preset-delete-btn` hand-written styles |
| `frontend/src/components/OrgDashboard.css` | ~101-116 | `.retry-btn` hand-written styles |

## Fix

1. **`PresetsRow` delete buttons** — replaced `<button className="preset-delete-btn">` with `<TuiButton variant="danger" size="sm">`. Danger variant is correct per DESIGN.md (error-red border/text, neutral at rest) — delete is a destructive action.

2. **`PrsTabError` retry button** — replaced `<button className="retry-btn">` with `<TuiButton variant="ghost" size="sm">`. Ghost variant is correct per DESIGN.md (muted border/text, secondary action).

3. **CSS cleanup** — removed `.retry-btn` and `.preset-delete-btn` rule blocks from `OrgDashboard.css`, as they are now superseded by `TuiButton`'s own styles.

## Variant Rationale

- `variant="danger"` for preset delete: matches DESIGN.md — destructive actions use the error semantic color
- `variant="ghost"` for retry: matches DESIGN.md — secondary/recovery actions use ghost (muted, non-prominent)

## Impact

- Visual-only regression, no functional or data impact
- Only affects the "All Workspaces" tab (`OrgDashboard`) preset management and the GitHub timeout error state
- The PR row action buttons (`Open`, `Fix Conflicts`, etc.) were already fixed in DYS-10

## Architecture Note

This is the third DYS-11-class issue caused by incomplete button conversion during the Svelte-to-React migration. The pattern of hand-writing custom button CSS instead of using `TuiButton` should be treated as a linting signal — a future ESLint rule could enforce `no-raw-button` in component files.
