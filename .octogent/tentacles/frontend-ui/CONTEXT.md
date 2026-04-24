# frontend-ui

React 19 components, dialogs, chat view, TUI primitives, App shell, CSS. The visible surface of Relay IDE.

## Scope

- `frontend/src/App.tsx` — root layout: left sidebar + `SplitPaneLayout` (terminal / FileViewerPane / FileTreeSidebar) for session view; dashboard / PR top bar + tabs for non-session views. Creates the module-level `QueryClient`.
- `frontend/src/App.css`, `frontend/src/main.tsx`, `frontend/index.html` — shell + global CSS variables.
- `frontend/src/components/` — 70+ TSX components, each paired with its own `.css` module. Groups:
  - **Layout & shell** — `Sidebar`, `SplitPaneLayout`, `MobileHeader`, `Toolbar`, `PrTopBar`, `SessionTabBar`, `SessionStatusBar`, `StatusDot`, `SessionIndicator`.
  - **Terminal** — `Terminal.tsx` (xterm.js + FitAddon + WebLinksAddon + WebgpuAddon + custom scrollbar, file-path link provider with the `FILE_EXT_PATTERN` regex). `MobileInput.tsx` for virtual-keyboard input.
  - **Workspace & repo views** — `RepoItem`, `RepoDashboard`, `OrgDashboard`, `WorkspaceGroup`, `RepoRow`, `PrRow`, `PrGlyph`, `BranchSwitcher`, `TargetBranchSwitcher`.
  - **File viewer** — `FileBrowser`, `FilePicker`, `FileTreeSidebar`, `FileViewerPane`, `DiffViewer`, `DiffFileSidebar`, `DiffSourceToggle`, `FullPageDiff`, `ChangedFiles`, `CodeBlock` (Shiki wrapper).
  - **Chat** — `components/chat/{ChatView,MessageTimeline,Composer,ToolCard,ApprovalCard,FileChangeCard}.tsx` for the unified web-chat interface.
  - **Session auth + boot** — `BootScreen`, `PinGate`, `PinInput`, `AgentBadge`, `InstallBanner`, `UpdateToast`, `SessionDetail`, `SessionHistoryPanel`.
  - **Dialogs (`components/dialogs/`)** — `DialogShell` (shared wrapper using `popover="manual"`), `SettingsDialog` + `SettingsToc` + `SettingRow`, `CustomizeSessionDialog`, `AddWorkspaceDialog`, `DeleteWorktreeDialog`, `RenameWarningModal`, `WorkspaceEditor`, `WorkspaceSettingsDialog`, `integrations/`.
  - **TUI primitives** — `TuiButton`, `TuiCheckbox`, `TuiInput`, `TuiMenuItem`, `TuiMenuPanel`, `TuiProgress`, `TuiRow` — outline-only, monospace, 0 px radius (see `DESIGN.md`).
  - **Presentational utilities** — `MarqueeText`, `CipherText`, `Hint`, `ContextMenu`, `ErrorToast`, `ImageToast`, `NotificationStack`, `DataTable`, `SearchableSelect`, `FilterChipBar`, `CommandPalette`, `OpenPicker`, `PickerResultRow`, `ShortcutHint`, `ticket cards`.
- `frontend/src/types/xterm-addon-webgpu.d.ts` — ambient types for the WebGPU xterm addon.

## Key Decisions

- **DESIGN.md is authoritative for visuals.** Before changing any color, font, spacing, border-radius, or button style, read the project-root `DESIGN.md`. TUI aesthetic: monospace, lowercase labels, no emoji, outline-only buttons, 0 px border-radius (`docs/FRONTEND.md` line 107). Deviate only with explicit user approval.
- **Components are thin; logic lives outside.** Components render state and dispatch events; anything stateful imports from `frontend/src/lib/stores/` (Zustand) or `frontend/src/lib/state/` (pure logic) — owned by the `frontend-state` tentacle. Components never talk to REST endpoints directly except through `lib/api.ts`.
- **Paired component + CSS files.** Every `*.tsx` has a sibling `*.css`. Global CSS variables live in `App.css`. Don't introduce CSS-in-JS — the stack is plain CSS modules per component.
- **DialogShell handles top-layer stacking.** `dialogs/DialogShell.tsx` uses `popover="manual"` + `showPopover()` / `hidePopover()` because z-index alone cannot stack above xterm.js canvas contexts (`docs/FRONTEND.md` line 130). Use `fullscreen` prop for the Settings modal; omit for compact dialogs.
- **Session indicator language is fixed.** `SessionIndicator.tsx` uses the Unicode shape alphabet (`●` running, `▶` idle, `◆◇` permission/needs-answer, `■` error, `─` inactive). New states should extend this alphabet, not invent new colors/shapes.
- **Tab bar "+" dropdown has exactly three options.** "New Agent", "New Terminal", "Customize..." — all paths terminate in `createSession()` → `POST /sessions`. `Cmd/Ctrl+T` is the instant-agent shortcut.
- **Mobile has its own input path.** `MobileInput.tsx` owns virtual-keyboard IME via `beforeinput` intent capture. xterm.js's own `.xterm-helper-textarea` is disabled on mobile to avoid focus fights. `Toolbar.tsx` buttons use `mousedown` + `preventDefault()` to keep the keyboard open.
- **`SplitPaneLayout` is the session frame.** Wraps terminal / file-viewer / right-sidebar with resizable handles; Ctrl+B toggles the right sidebar; `FileTreeSidebar` and `FileViewerPane` share `fileDiffSource` + `fileDiffDefaultBranch` via the `UI` store.
- **Repo root items always show "default" as name** unless the user explicitly renames the active session (`RepoItem.tsx`).

## Conventions

- New component? Create `FooBar.tsx` + `FooBar.css` under `components/` (or `components/chat/` / `components/dialogs/` when it fits). Import CSS directly in the TSX. Don't cross-import from other components' CSS.
- Props interface goes at the top; use `forwardRef` + `useImperativeHandle` when parents need imperative handles (see `Terminal.tsx` `TerminalHandle`, dialogs' `*DialogHandle`).
- State goes to Zustand; derived values go to `useMemo`. Never mirror store state into `useState`.
- Context menus go through the universal `ContextMenu.tsx` "…" dropdown; menu items vary by state (`Active` → Rename/Kill; `Inactive worktree` → Customize/Resume/Resume (YOLO)/Delete; `Idle repo` → Customize/New Worktree) — `docs/FRONTEND.md` line 121.
- Session-item secondary row order is fixed: `timestamp → branch → PR number → context-menu`. Diff stats appear in the primary row.
- All async UI actions use `setLoading`/`clearLoading` wrappers that show the CSS shimmer overlay with `pointer-events: none` on the affected item.
- Components must not import from `frontend/src/lib/state/` modules to trigger side effects. State modules are pure.
- When adding a dialog, register it in `App.tsx` with a ref handle and expose `show()` / `hide()` methods via `useImperativeHandle`.

<!-- octogent:suggested-skills:start -->

## Suggested Skills

You can use these skills if you need to.

- `design-review`
- `design-consultation`
- `plan-design-review`
- `browse`
- `qa`
<!-- octogent:suggested-skills:end -->
