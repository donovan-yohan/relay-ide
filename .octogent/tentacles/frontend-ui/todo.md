# frontend-ui — Backlog

## Epics

- [ ] **DESIGN.md compliance audit** — pass every component under `frontend/src/components/` and `components/dialogs/` and flag deviations from DESIGN.md (non-monospace fonts, non-zero border-radius, emoji, filled buttons). Produce a fix list ordered by visibility.
- [ ] **Terminal accessibility review** — `Terminal.tsx` renders via xterm.js with a custom scrollbar and disables the helper textarea on mobile. Audit screen-reader output, focus order, and keyboard navigation on desktop; add a fallback textarea strategy for a11y where xterm is opaque.
- [ ] **DialogShell regression harness** — top-layer stacking via `popover="manual"` is fragile across xterm canvas contexts (`docs/FRONTEND.md` line 130). Build a Playwright fixture that opens each dialog over an active terminal and asserts z-stack correctness.
- [ ] **Command palette search ergonomics** — `CommandPalette.tsx` consumes `getAllActions()` from the action registry; add fuzzy-score weighting by recency and category, and tests for ordering stability.
- [ ] **Chat view approval card flow** — `ChatView.tsx` + `ApprovalCard.tsx` render web-chat approvals. Storybook-style fixtures for approval/rejection states, race against `session-ended`, and accessible focus management.
- [ ] **Workspace group drag-and-drop audit** — `WorkspaceGroup.tsx` uses `@dnd-kit`. Add tests for reorder stability when sidebar items update mid-drag, and for keyboard-only reordering.
- [ ] **Mobile viewport transitions** — `MobileHeader.tsx` + `MobileInput.tsx` rely on `visualViewport`. Build end-to-end checks for keyboard-open, keyboard-close, and split-keyboard states on iOS Safari.
- [ ] **Dialog dismiss consistency** — Settings, CustomizeSession, AddWorkspace, DeleteWorktree, Rename/Workspace dialogs each implement Esc + backdrop-click dismiss differently. Unify dismiss semantics through `DialogShell`.
