# Bug Analysis: Add Repo modal always open on mobile after launching

> **Status**: Confirmed | **Date**: 2026-04-04
> **Severity**: High
> **Affected Area**: `frontend/src/components/dialogs/DialogShell.css`

## Symptoms
- On mobile devices, the "add repo" modal content is visible immediately after launching the app, without any user interaction
- The modal appears rendered in normal page flow, overlaying the main app content
- On desktop, the same issue exists but is far less noticeable due to viewport size and stacking contexts

## Reproduction Steps
1. Open Relay IDE on a mobile device (or use mobile viewport in devtools)
2. Observe the "add repo" dialog content rendered on screen immediately after boot
3. No user action required — the dialog content is visible on page load

## Root Cause

**CSS cascade override of `<dialog>` hidden state.**

`DialogShell.css:14` sets `display: flex` on `.dialog-shell`, the class applied directly to the `<dialog>` HTML element:

```css
/* DialogShell.css:12-16 */
.dialog-shell {
  ...
  display: flex;
  flex-direction: column;
}
```

The HTML `<dialog>` element is hidden by default via the browser's UA stylesheet:
```css
/* Browser UA stylesheet */
dialog:not([open]) {
  display: none;
}
```

**The CSS cascade resolves `display: flex` as the winner** because author stylesheets always take precedence over UA stylesheets, regardless of specificity. This causes ALL `<dialog>` elements using DialogShell to render their content in normal DOM flow even when `.showModal()` has not been called.

### Why mobile-only (or much more visible on mobile)

1. **Mobile layout creates paint-order issue** (`App.css:132-137`): On mobile, `.main-app` has `position: fixed; inset: 0`, removing it from normal flow. The dialog elements (siblings of `.main-app` in the DOM at `App.tsx:832-856`) are in normal flow and paint ON TOP of the fixed main-app due to later DOM order.

2. **Dialog covers ~95% of mobile viewport**: `.dialog-shell--compact { width: min(var(--dialog-width, 460px), 95vw) }` — on a 375px mobile viewport, this is ~356px, covering nearly the entire screen.

3. **Desktop mitigation**: The sidebar (`z-index: 100; position: relative`) creates a higher stacking context. The 520px dialog is a smaller fraction of a desktop viewport (~36% of 1440px). The issue technically exists on desktop but is far less prominent.

## Evidence
- `DialogShell.css:14` — `display: flex` set on `.dialog-shell` with no `[open]` qualifier
- `DialogShell.tsx:117` — `<dialog>` element receives className `dialog-shell`
- No `dialog:not([open]) { display: none }` rule exists anywhere in the author stylesheets (confirmed via grep)
- `App.tsx:838-841` — `<AddWorkspaceDialog>` rendered outside `.main-app`, in normal DOM flow
- `App.css:132-137` — mobile `.main-app` is `position: fixed`, causing paint-order inversion with sibling dialogs
- `WorkspaceSettingsDialog.css:1-10` — comparison: this dialog does NOT set `display` on the `<dialog>` element and is unaffected

## Impact Assessment
- **All DialogShell-based dialogs are affected**: AddWorkspaceDialog, SettingsDialog, CustomizeSessionDialog, DeleteWorktreeDialog (4 dialogs total)
- AddWorkspaceDialog is the most visible because it contains a FileBrowser with substantial content that renders on mount
- `WorkspaceSettingsDialog` uses its own `<dialog>` element without overriding display — NOT affected
- The issue makes the app appear broken on mobile first launch, directly impacting first-time user experience

## Recommended Fix Direction

Add a single CSS rule to `DialogShell.css` that restores the browser's intended hidden behavior:

```css
.dialog-shell:not([open]) {
  display: none;
}
```

This is a one-line fix that resolves the issue for all DialogShell-based dialogs at once.

## Architecture Review

### Systemic Spread
- `DialogShell.css:14` — the single source of the bug, affecting all 4 DialogShell consumers:
  - `AddWorkspaceDialog.tsx` (via `DialogShell` component)
  - `SettingsDialog.tsx` (via `DialogShell` component)
  - `CustomizeSessionDialog.tsx` (via `DialogShell` component)
  - `DeleteWorktreeDialog.tsx` (via `DialogShell` component)
- `WorkspaceSettingsDialog.tsx:145` — uses its own `<dialog>` element but does NOT set `display` on it → not affected
- No other `<dialog>` elements exist in the codebase

### Design Gap
The `<dialog>` element has special display semantics — it's hidden by default via UA stylesheet, and this hiding relies on `display: none`. Any author-level `display` override on a `<dialog>` element breaks this semantic. The project has no convention or guard against this:

- **Missing constraint**: The DialogShell component sets `display: flex` directly on the `<dialog>` element. The intent was layout (flex column), but the side effect was overriding the browser's hidden state.
- **Better design**: Either always pair `display` overrides on `<dialog>` with an explicit `:not([open]) { display: none }` rule, or apply `display: flex` only to `dialog[open]` / to a child wrapper element (like `WorkspaceSettingsDialog` does with `.workspace-settings-dialog-content`).

### Testing Gaps
- **Missing test cases:** A visual regression test or Playwright assertion like "after boot, `document.querySelectorAll('dialog[open]')` should be empty and no dialog content should be visible" would catch this immediately.
- **Infrastructure gaps:** No CSS-level tests or visual snapshot tests exist for dialog visibility states. Given the project has 5+ dialog components, a structural test that validates dialog hidden state on page load would prevent this class of bug.

### Harness Context Gaps
- `docs/FRONTEND.md` does not mention `<dialog>` display semantics or the constraint that `display` must not be unconditionally overridden on `<dialog>` elements.
- `DESIGN.md` does not cover dialog component conventions.
- These are minor gaps — the fix is simple and self-documenting. A one-line note in FRONTEND.md under component conventions would prevent recurrence.

## Harness Trace

Insufficient run history — harness trace unavailable (no `.harness/` runtime directory).
