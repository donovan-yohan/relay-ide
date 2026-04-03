# Bug Analysis: Add Repo modal content shifts and disappears on checkbox focus

- **Date:** 2026-04-03
- **Ticket:** DYS-8
- **Severity:** High
- **Branch:** nightly

## Symptoms

When using the "Add Repo" dialog, focusing UI elements (particularly checkboxes in the file browser tree) causes the modal content to shift entirely out of the visible area. The effect worsens for items further down the scrollable list. Pressing Tab sometimes snaps content back into view, but the behavior is inconsistent and jarring. This completely breaks keyboard accessibility.

## Reproduction Steps

1. Open the "add repo" dialog from the sidebar.
2. Wait for the file browser tree to load.
3. Click on a checkbox in the tree, or Tab into the tree and navigate with arrow keys.
4. Observe that the dialog body content shifts upward, making the file browser invisible.
5. Tab again -- content may snap back partially, then shift again on the next focus.

## Root Cause

**Nested scrollable containers + browser auto-scroll-on-focus behavior.**

The dialog layout creates two nested scrollable containers:

1. `.dialog-shell__body` (DialogShell.css:130-134) -- `overflow-y: auto`, flex child of the dialog
2. `.tree-container` (FileBrowser.css:33-38) -- `max-height: 50vh`, `overflow-y: auto`, inside the dialog body

When any focusable element inside `.tree-container` receives focus (via Tab, click, or programmatic `.focus()`), the browser walks up the entire ancestor chain and scrolls **every** scrollable ancestor to ensure the focused element is in the viewport. The `.tree-container` scrolls correctly (it is the intended scroll container), but `.dialog-shell__body` also scrolls, pushing the entire file browser component out of view.

**Contributing factor:** The `TuiCheckbox` component uses a visually-hidden `<input>` element (`position: absolute; clip: rect(0,0,0,0); width: 1px; height: 1px`). The computed layout position of this hidden input can confuse the browser's scroll-into-view algorithm, causing larger-than-expected scroll offsets on ancestor containers.

**Secondary issue:** The `DialogShell.open()` method calls `.focus()` on the first focusable element without `{ preventScroll: true }`, which can trigger the same ancestor-scroll behavior on dialog open.

## Evidence

| File                                              | Line    | Issue                                                                         |
| ------------------------------------------------- | ------- | ----------------------------------------------------------------------------- |
| `frontend/src/components/dialogs/DialogShell.css` | 130-134 | `.dialog-shell__body` has `overflow-y: auto` (scrollable ancestor)            |
| `frontend/src/components/FileBrowser.css`         | 33-38   | `.tree-container` has `overflow-y: auto` + `max-height: 50vh` (nested scroll) |
| `frontend/src/components/TuiCheckbox.css`         | 17-24   | Hidden `<input>` with `position: absolute; clip: rect(0,0,0,0)`               |
| `frontend/src/components/dialogs/DialogShell.tsx` | 44      | `.focus()` called without `preventScroll: true`                               |

## Impact

- Keyboard accessibility is completely broken -- Tab navigation makes content disappear.
- Click-based interaction is impaired -- clicking a checkbox can make the tree invisible.
- Affects all users of the "add repo" flow.
- Any dialog using DialogShell that contains a nested scrollable container with focusable elements is susceptible.

## Fix

Three-part fix:

### 1. `preventScroll` on initial dialog focus (DialogShell.tsx)

Added `{ preventScroll: true }` to the `.focus()` call in `useDialogControls.open()`. This prevents the browser from scrolling the dialog body when focus is programmatically moved to the first focusable element on dialog open.

### 2. Focus-in scroll guard on tree container (FileBrowser.tsx)

Added an `onFocus` handler on `.tree-container` that captures the dialog body's `scrollTop` before focus and restores it on the next animation frame if the browser changed it. This prevents the browser's auto-scroll-on-focus from disturbing the outer dialog body scroll position.

### 3. `overscroll-behavior: contain` on tree container (FileBrowser.css)

Added `overscroll-behavior: contain` to `.tree-container` to prevent scroll chaining from the tree to the dialog body during normal scroll interactions (mouse wheel, touch scroll).

## Architecture Review

### Systemic spread

This bug pattern can affect **any** DialogShell consumer that places a scrollable container with focusable elements inside the dialog body. Current consumers to audit:

- `SettingsDialog` -- uses fullscreen variant with its own scroll sections
- `WorkspaceSettingsDialog` -- may contain scrollable lists
- `CustomizeSessionDialog` -- contains form inputs

### Design gap

The DialogShell component assumes its body will be the sole scroll container for its children. When children introduce their own scroll containers (as FileBrowser does), the nested overflow creates this focus-scroll conflict. A stronger design would either:

- Make `.dialog-shell__body` non-scrollable (`overflow: hidden`) and require children to manage their own scroll, OR
- Provide a mechanism for children to signal "I handle my own scroll"

### Testing gaps

No automated tests cover focus behavior within nested scroll containers in dialogs. A test that opens AddWorkspaceDialog, focuses a checkbox, and asserts that the dialog body scroll position remains unchanged would catch regressions.

### Prior art

Related to learning L-20260324-fixed-in-dialog: `position: fixed` inside dialogs uses the dialog as containing block. Similarly, browser focus-scroll behavior inside dialog top-layer elements interacts unexpectedly with nested scroll containers.
