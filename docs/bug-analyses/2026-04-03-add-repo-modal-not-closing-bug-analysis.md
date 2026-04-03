# Bug Analysis: "Add Repo" modal does not close after clicking "add repo"

**Ticket:** DYS-9
**Date:** 2026-04-03
**Status:** Fixed

## Symptoms

- User opens the "add repo" dialog from the sidebar
- Selects one or more folders and clicks "add repo"
- The API call succeeds (sidebar updates with the new repo)
- The modal overlay does not dismiss; it stays visible on screen
- User must manually close the dialog (click X, press Escape, or click the backdrop)

## Reproduction Steps

1. Launch the app and authenticate
2. Click "+ add repo" in the sidebar footer
3. Browse and select a folder
4. Click "add repo" to confirm
5. Observe: sidebar updates with the new workspace, but the dialog remains open

## Root Cause

**Author stylesheet overriding the browser's default `<dialog>` hiding behavior.**

In commit `3e7e737`, `display: flex` and `flex-direction: column` were added directly to the `.dialog-shell` selector in `frontend/src/components/dialogs/DialogShell.css`:

```css
.dialog-shell {
  /* ... */
  display: flex; /* <-- introduced in 3e7e737 */
  flex-direction: column; /* <-- introduced in 3e7e737 */
}
```

The native HTML `<dialog>` element relies on a user-agent stylesheet rule to hide itself when closed:

```css
dialog:not([open]) {
  display: none;
}
```

In the CSS cascade, author stylesheets take precedence over user-agent stylesheets regardless of specificity. (In fact, `dialog:not([open])` has _higher_ specificity than `.dialog-shell`, but specificity only applies within the same cascade origin.) Because `.dialog-shell { display: flex }` is an author rule, it wins over the UA rule unconditionally. When `dialog.close()` is called, the browser removes the `open` attribute and removes the dialog from the top layer (hiding the `::backdrop`), but the element remains visible because the author `display: flex` rule overrides the UA `display: none`.

**Evidence:**

- `frontend/src/components/dialogs/DialogShell.css:14-15` -- the `display: flex` rule
- `frontend/src/components/dialogs/DialogShell.tsx:50-52` -- the `close()` method calls `dialogRef.current?.close()`
- The `<dialog>` element's `close()` method correctly removes `[open]`, but CSS prevents visual hiding

## Impact

- **All dialogs** using `DialogShell` are affected (AddWorkspaceDialog, SettingsDialog, DeleteWorktreeDialog, CustomizeSessionDialog, WorkspaceSettingsDialog)
- Most visible with AddWorkspaceDialog since it's the primary onboarding action
- Blocks user workflow -- requires manual dismissal after every dialog submission

## Fix

Move `display: flex` and `flex-direction: column` to a `.dialog-shell[open]` rule so the flex layout only applies when the dialog is open. When closed, the browser's native `display: none` takes effect:

```css
.dialog-shell[open] {
  display: flex;
  flex-direction: column;
}
```

**File changed:** `frontend/src/components/dialogs/DialogShell.css`

## Architecture Review

The `DialogShell` component correctly delegates open/close to the native `<dialog>` API (`showModal()` / `close()`). The `AddWorkspaceDialog` submit handler correctly calls `shellRef.current?.close()` after a successful API response. No logic changes were needed -- the fix is purely CSS: scoping `display: flex` to `.dialog-shell[open]` so the author rule no longer overrides the browser's UA `display: none` when the dialog is closed.
