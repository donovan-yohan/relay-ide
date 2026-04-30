# Issue 263 Workspace Layout First Slice Autoplan

Source issue: https://github.com/donovan-yohan/relay-ide/issues/263

Branch reviewed: `nightly`

Base branch: `nightly`

## Plan Summary

Build the first slice as a workspace layout substrate, not as full VSCode customization.

The first slice should introduce a typed layout tree for the session workspace, a generic tab model that can represent agent sessions, terminal sessions, file tabs, diff tabs, html preview tabs, and review tabs, and a resizable main-pane renderer that can show those tabs in split groups. Drag-out behavior should be limited to moving a tab from its current group into a new split to the left, right, top, or bottom of the same main area.

This intentionally does not tackle arbitrary side-bar docking, floating pop-outs, multiple sidebars on each side, persisted workspace customization, or a full PR/checks experience. Those are the larger epic.

## Premises

| Premise                                                | Assessment                                                                                                                                                           |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Relay should move toward VSCode-like customization     | Valid, but too large for one issue. The first slice needs to create the layout model that future customization uses.                                                 |
| Agents, terminals, files, and diffs should all be tabs | Valid as a product direction. Today they are separate tab systems in `SessionTabBar` and `FileViewerPane`, so the first slice must normalize identity and rendering. |
| Dragging should be built on existing dependencies      | Valid. `@dnd-kit/core` and `@dnd-kit/sortable` are already dependencies.                                                                                             |
| Resizing should be user-visible in the first slice     | Valid. Issue #263 acceptance criteria require resizable split dividers. Use a proven panel-resize library rather than expanding custom pointer math.                 |
| Sidebars should become dockable and reorderable now    | Too broad for the first slice. It belongs to the epic, after the main-area layout model exists.                                                                      |

Premise gate recommendation: approve these premises. The only scope adjustment is to treat side-bar docking as follow-up work, not as part of the first implementation slice.

## What Already Exists

| Sub-problem             | Current code                                                                                                                               |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Hard-coded main layout  | `frontend/src/components/SplitPaneLayout.tsx` renders terminal, optional file viewer, and optional right sidebar as a fixed row.           |
| Manual resize handles   | `SplitPaneLayout.tsx` owns pointer listeners and clamps file/right-sidebar sizes.                                                          |
| Agent and terminal tabs | `frontend/src/components/SessionTabBar.tsx` renders session tabs from `SessionSummary[]`.                                                  |
| File/diff/html tabs     | `frontend/src/components/FileViewerPane.tsx` renders `OpenFileTab[]` from `useUiStore`.                                                    |
| File tab state          | `frontend/src/lib/stores/ui.ts` stores `openFileTabs`, `activeFileTabKey`, and file viewer ratio.                                          |
| Right utility surface   | `frontend/src/components/FileTreeSidebar.tsx` already has `changes`, `all-files`, and `checks` tabs. Checks is currently placeholder text. |
| Drag and drop library   | `@dnd-kit/core`, `@dnd-kit/sortable`, and `@dnd-kit/utilities` are already installed.                                                      |

## Dream State Delta

```text
CURRENT
  left sidebar: session/workspace browser
  main: one active session terminal area
  file viewer: optional right split owned by file tabs
  right sidebar: changed/all-files/checks utility tree

FIRST SLICE
  left sidebar: unchanged
  main: layout tree with resizable split groups
  main tabs: sessions + file/diff/html/review descriptors can share tab chrome
  drag-out: tab -> adjacent split inside main area
  right sidebar: unchanged except it can open file/diff/review tabs into the main layout

12-MONTH IDEAL
  left/right dock areas can host multiple bars
  bars can be reordered and moved between sides
  main can split recursively and persist layout per workspace
  files, diffs, agents, terminals, PRs, checks, logs, stats, and utility terminals are all typed tabs
  views can be condensed, expanded, hidden, or moved without changing their underlying state
```

## Implementation Alternatives

| Approach                                                                                               | Effort |   Risk | Pros                                                               | Cons                                                              | Decision |
| ------------------------------------------------------------------------------------------------------ | -----: | -----: | ------------------------------------------------------------------ | ----------------------------------------------------------------- | -------- |
| Patch `SplitPaneLayout` with drag targets and extra children                                           | Medium |   High | Smallest initial diff                                              | Locks the product deeper into terminal/file/sidebar special cases | Reject   |
| Introduce a typed layout tree and render it with `react-resizable-panels`, using dnd-kit for tab moves | Medium | Medium | Matches future workspace customization while keeping slice bounded | Requires a small model migration and tests                        | Accept   |
| Build a full dock manager for main plus sidebars                                                       |   High |   High | Closest to final vision                                            | Too much scope for first pass, hard to verify in one PR           | Defer    |

Library decision: add `react-resizable-panels` for split resizing and use existing `@dnd-kit` for tab drag/drop. `react-split-pane` exists, but it is an older split-pane component with a less natural nested panel-group model for this feature.

## Accepted First Slice

### 0. Tmux Session Substrate Gate

Issue #264 should be treated as session/process substrate work, not as UI layout work.

The browser still uses xterm for terminal rendering. The server-side change is that Relay stops treating terminal sessions as mostly anonymous PTY streams and starts tying each PTY attachment to stable tmux session names, windows, or panes. That gives the UI stronger handles for "this terminal tab is attached to tmux target X" without making tmux responsible for the React layout.

Recommendation: land #264 before the full "agents and terminals can appear in multiple main panes" version of #263. Relay's current frontend PTY path is effectively single-active-terminal oriented: `connectPtySocket(sessionId, term, ...)` replaces the global PTY websocket, and `sendPtyData(data)` writes to that global connection. Multiple live terminal panes need targeted input/output routing. Tmux gives us the backend identity layer for that routing.

Tmux helps with:

- stable session names instead of fragile process tracking
- targeted `send-keys` for prompt/input injection
- `capture-pane` for reading terminal state without parsing every ANSI stream
- windows/panes as backend primitives for utility terminals
- resurrection/restoration of sessions after Relay restarts

Tmux does not replace:

- xterm rendering in the browser
- the React layout tree
- tab identity and ownership rules
- drag/drop target handling
- pane resizing UI
- side dock customization state

First slice adjustment:

- If #264 lands first, model session/terminal tabs as references to tmux-backed Relay sessions.
- If #263 lands first, limit implementation to one mounted live terminal pane and allow file/diff/html tabs to split around it. Do not claim multi-live-terminal support until #264 or equivalent targeted PTY routing exists.

### 1. Add Typed Workspace Tab Descriptors

Create a small model, likely `frontend/src/lib/workspace-layout.ts`, with:

```ts
export type WorkspaceTab =
  | { kind: 'session'; sessionId: string; sessionType: 'agent' | 'terminal' }
  | {
      kind: 'file';
      filePath: string;
      tabType: 'code' | 'diff' | 'html';
      token?: string;
    };

export type WorkspacePane = {
  id: string;
  activeTabId: string | null;
  tabs: WorkspaceTabInstance[];
};

export type WorkspaceLayoutNode =
  | { type: 'pane'; pane: WorkspacePane }
  | {
      type: 'split';
      direction: 'horizontal' | 'vertical';
      sizes: number[];
      children: WorkspaceLayoutNode[];
    };
```

Rules:

- Tab IDs are stable and deterministic for file tabs, using the existing `fileTabKey` identity.
- Session tabs use session IDs.
- A tab exists in exactly one pane.
- Closing a tab removes it from its pane, then selects the nearest remaining tab.
- Empty panes are pruned.
- Split nodes with one child collapse.

### 2. Add Pure Layout Reducers

Add pure functions before touching UI rendering:

- `createDefaultWorkspaceLayout(sessionTabs, fileTabs)`
- `moveTabToPane(tabId, targetPaneId, index?)`
- `splitPaneWithTab(sourcePaneId, tabId, direction, placement)`
- `closeLayoutTab(tabId)`
- `selectLayoutTab(paneId, tabId)`
- `pruneLayout(layout)`

This is the safety net. The feature is visual, but the expensive bugs will be state bugs.

### 3. Add Main Workspace Layout Renderer

Replace `SplitPaneLayout` for the center area with a new component, likely:

- `frontend/src/components/WorkspaceLayout.tsx`
- `frontend/src/components/WorkspacePane.tsx`
- `frontend/src/components/WorkspaceTabBar.tsx`
- `frontend/src/components/WorkspaceDropOverlay.tsx`

`WorkspaceLayout` owns the recursive split rendering. Use `PanelGroup`, `Panel`, and `PanelResizeHandle` from `react-resizable-panels`.

First slice rendering:

- `session` tabs render the current `SessionContent`, `SessionStatusBar`, and `Toolbar` behavior.
- `file` tabs render the existing `FileViewerPane` content path, but the old `FileViewerPane` should be split into tab chrome vs content so one pane can render one active file tab without owning every file tab.
- The existing `SessionTabBar` can become a compatibility wrapper or be replaced by the generic `WorkspaceTabBar` only inside session view.

### 4. Drag-Out Scope

Support only:

- Drag a tab within the same pane to reorder.
- Drag a tab onto another pane tab bar to move it there.
- Drag a tab to a pane edge drop zone to create a new split.

Do not support:

- Floating windows.
- Dragging side-bar bars.
- Dragging panes outside the main area.
- Persisting custom layouts.
- Arbitrary 3+ column sidebars.

### 5. Keep Sidebars Stable

Left sidebar stays as-is.

Right sidebar stays as-is, including `changes`, `all-files`, and `checks`. Selecting a changed file or all-file entry should open a file/diff tab in the active main pane. This is enough to prove the main tab model without rebuilding the side utility rail.

## NOT In Scope

| Item                                               | Why deferred                                                                                                    |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Floating pop-out windows                           | Issue #263 already excludes this.                                                                               |
| Layout persistence                                 | Issue #263 excludes this, and persistence should wait until the model settles.                                  |
| Docking bars between left and right                | Larger epic work. Needs a side-bar model separate from main-pane tabs.                                          |
| Multiple sidebars per side                         | Larger epic work. Requires dock-area state, not just main split state.                                          |
| Condensed vs expanded panel modes                  | Larger epic work. Separate from hidden vs visible.                                                              |
| Full PR view and GitHub Actions checks integration | Mentioned in the epic direction, but not needed to prove tab dragging and splitting.                            |
| Removing all open/close animations globally        | Product direction accepted, but should be done when sidebars are redesigned, not bundled into this first slice. |

## CEO Review

### 0A Premise Challenge

The right problem is not "drag tabs" by itself. The real problem is that Relay has several powerful surfaces that cannot share space. Users bounce between terminal, file diffs, sidebar tools, and PR context instead of arranging the job they are doing.

The first slice should therefore create the composable workspace substrate. Dragging is the affordance. The product value is user-controlled arrangement.

### 0B Existing Code Leverage

Leverage `FileViewerPane` for file/diff/html content, `SessionContent` for session rendering, `SessionTabBar` naming/icon patterns, `useUiStore` for existing file-tab identity, and `@dnd-kit` for drag behavior. Replace the bespoke resizing math in `SplitPaneLayout` instead of extending it.

### 0C Dream State Mapping

The accepted first slice leaves side docking, PR/checks, condensed views, and persistence for later, but it creates the shared tab and layout vocabulary those features need.

### 0D Mode

Mode: selective expansion.

Accepted expansion: add a generic tab descriptor model even though issue #263 only says drag tabs. This prevents a throwaway drag implementation.

Rejected expansion: include left/right dock customization in the same PR. That is the larger epic.

### Sections 1-11 Summary

| Section              | Finding                                                                                                                               |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Architecture         | The current architecture is too special-cased. New layout tree required.                                                              |
| Error and rescue     | Most errors are UI state errors: duplicate tabs, lost active tab, empty panes, invalid drop targets. Handle with pure reducer guards. |
| Security             | No new server trust boundary if this remains client-side layout state. Do not let html preview sandbox rules loosen during refactor.  |
| Data and interaction | Keyboard and touch behavior must not regress. Drag must have button/menu fallback for accessibility.                                  |
| Code quality         | Split current file viewer into tab chrome and content renderer before trying to mount file tabs in multiple panes.                    |
| Tests                | Reducer tests are mandatory. Component tests should cover drag result state without relying only on pointer simulation.               |
| Performance          | Avoid remounting terminal sessions when moving tabs or resizing panes. This is the biggest risk.                                      |
| Observability        | No telemetry required, but layout reducer should be easy to inspect in devtools.                                                      |
| Deployment           | Client-only feature, standard nightly path.                                                                                           |
| Long-term            | Reversible if the model stays isolated behind new components. Hard to reverse if it mutates `App.tsx` deeply.                         |
| Design               | Use Relay's black, square, monospace TUI style. Drop zones should be thin border/edge indicators, not glossy overlays.                |

## Design Review

Initial design score: 6/10.

The interaction direction is right, but the current issue underspecifies empty panes, drag target feedback, keyboard access, touch behavior, and what happens when terminal tabs move.

| Pass                         | Score | Required fix                                                                                                                             |
| ---------------------------- | ----: | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Information architecture     |  7/10 | Main area becomes the place where user work tabs live. Sidebars remain navigation/utility.                                               |
| Interaction states           |  5/10 | Specify dragging, invalid drop, empty pane, single-tab close, loading diff, errored diff, no active session, and mobile fallback states. |
| User journey                 |  7/10 | Start with "open file beside terminal" and "move terminal beside diff" as the two hero flows.                                            |
| AI slop risk                 |  8/10 | Design language is already specific. Avoid generic IDE chrome and rounded tab pills.                                                     |
| Design system alignment      |  8/10 | Use zero-radius tabs, 1px borders, lowercase labels, monochrome SVG icons.                                                               |
| Responsive and accessibility |  5/10 | Desktop-first is fine, but keyboard fallback and mobile no-op behavior must be explicit.                                                 |
| Unresolved decisions         |  6/10 | Need user call on whether first slice includes session tabs in the shared model or only file tabs. Recommendation: include sessions now. |

Design decision: first slice should be desktop-first. On mobile, preserve current behavior and do not expose drag-out splits.

## Engineering Review

### Scope Challenge

The issue touches at least these files:

- `frontend/src/App.tsx`
- `frontend/src/components/SplitPaneLayout.tsx`
- `frontend/src/components/SplitPaneLayout.css`
- `frontend/src/components/SessionTabBar.tsx`
- `frontend/src/components/FileViewerPane.tsx`
- `frontend/src/lib/stores/ui.ts`
- new layout model/tests

That is already a real feature. Adding side dock customization would push it into a rewrite. Do not do that in the first slice.

### Architecture Diagram

```text
useSessionsStore                    useUiStore
  sessions, activeSessionId           openFileTabs, activeFileTabKey
          \                              /
           \                            /
            workspace tab descriptors
                       |
              workspace layout store
                       |
              WorkspaceLayout recursive renderer
                 /          |           \
        WorkspacePane   ResizeHandle   WorkspaceDropOverlay
             |
       WorkspaceTabBar
             |
       Active tab content
        /              \
  SessionContent     FileTabContent
  Toolbar            DiffViewer / CodeBlock / HtmlTabView
```

### Test Diagram

| Flow or branch                                               | Test type                            | Required coverage                                                           |
| ------------------------------------------------------------ | ------------------------------------ | --------------------------------------------------------------------------- |
| Create default layout from active session and open file tabs | Vitest reducer test                  | Session and file descriptors produce one main pane with stable active tab.  |
| Drag file tab to right edge                                  | Vitest reducer test, component smoke | Layout becomes horizontal split with source and target panes.               |
| Drag terminal tab to bottom edge                             | Vitest reducer test                  | Layout becomes vertical split without losing session ID.                    |
| Move tab between existing panes                              | Vitest reducer test                  | Tab removed from source and appended to target.                             |
| Close active tab in multi-tab pane                           | Vitest reducer test                  | Neighbor tab becomes active.                                                |
| Close last tab in split pane                                 | Vitest reducer test                  | Empty pane pruned and split collapses if needed.                            |
| Invalid drop target                                          | Vitest reducer test                  | State unchanged.                                                            |
| Resize divider                                               | Component test if practical          | Panel sizes update without remounting active tab.                           |
| Open changed file from right sidebar                         | Existing UI/store test extended      | File opens in active workspace pane, not a separate hard-coded file viewer. |
| Mobile session view                                          | Playwright or component smoke        | Current single-pane behavior remains usable, drag affordances hidden.       |

### Failure Modes Registry

| Failure mode                                                         | Severity | Mitigation                                                                                      |
| -------------------------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------- |
| Moving a terminal tab remounts the terminal and drops live PTY state | Critical | Keep session rendering keyed by session ID and verify no forced new session is created.         |
| Two mounted terminal panes fight over one global PTY websocket       | Critical | Land tmux-required session routing first, or restrict first slice to one mounted live terminal. |
| File tab appears in two panes                                        | High     | Enforce single-owner invariant in pure reducers.                                                |
| Closing a tab leaves activeTabId pointing at missing tab             | High     | Reducer selects neighbor or null.                                                               |
| Empty split remains visible                                          | Medium   | `pruneLayout` collapses empty panes and single-child splits.                                    |
| Drag overlay steals terminal pointer input                           | Medium   | Only activate DnD from tab handles, not pane body.                                              |
| Mobile layout becomes unusable                                       | Medium   | Hide split drag affordances on mobile for first slice.                                          |
| Existing right sidebar resize regresses                              | Medium   | Keep right sidebar path unchanged in this slice.                                                |

### Performance

Resizing will fire constantly. Use `react-resizable-panels` for layout size changes and keep terminal/diff content keyed so resizing does not trigger expensive remounts. Do not put live terminal content inside a component whose key changes when a tab moves.

## Error And Rescue Registry

| Error                     | Trigger                                | User-visible behavior                             | Test                                       |
| ------------------------- | -------------------------------------- | ------------------------------------------------- | ------------------------------------------ |
| `missing-tab`             | active tab no longer exists            | pane selects nearest available tab or empty state | reducer test                               |
| `invalid-drop-target`     | drop over unsupported region           | drag cancels, layout unchanged                    | reducer test                               |
| `empty-pane`              | last tab closed or moved out           | pane pruned, sibling expands                      | reducer test                               |
| `unsupported-mobile-drag` | mobile/touch split drag in first slice | no drag-out affordance shown                      | component/e2e smoke                        |
| `file-diff-fetch-error`   | existing diff load fails               | existing retry/close UI remains                   | existing FileViewerPane behavior preserved |

## Decision Audit Trail

| #   | Phase  | Decision                                                                    | Classification | Principle               | Rationale                                                                                 | Rejected                       |
| --- | ------ | --------------------------------------------------------------------------- | -------------- | ----------------------- | ----------------------------------------------------------------------------------------- | ------------------------------ |
| 1   | CEO    | First slice builds layout substrate, not complete VSCode customization      | Mechanical     | Boil lakes, flag oceans | Shared tab/pane model is a lake. Full docking system is an ocean.                         | Full sidebar docking now       |
| 2   | CEO    | Include sessions and file/diff/html tabs in the shared tab descriptor model | Taste          | Choose completeness     | Issue says files, terminal, chat, review should work. File-only drag would be throwaway.  | File tabs only                 |
| 3   | Eng    | Use `react-resizable-panels` for split resizing                             | Mechanical     | Do not reinvent         | Current pointer math is already special-cased and nested splits need a panel-group model. | Expand bespoke resize code     |
| 4   | Design | Desktop-first drag-out, mobile preserves current single-pane behavior       | Mechanical     | Explicit over clever    | Mobile drag/split UX is a separate design problem.                                        | Force split UI onto mobile     |
| 5   | Eng    | Keep sidebars stable in first slice                                         | Mechanical     | Pragmatic               | Proves the main layout model without entangling dock-area design.                         | Rebuild left/right docks now   |
| 6   | Eng    | Add reducer tests before component drag tests                               | Mechanical     | Quality                 | State bugs are the highest-risk part of this feature.                                     | Rely only on pointer/e2e tests |

## Deferred Epic Work

Create or update follow-up GitHub issues for:

- Dock areas: left and right sidebars can host multiple bars, reorder bars, and move bars between sides.
- Sidebar visibility shortcuts and top-left/top-right icon controls.
- Per-workspace layout persistence.
- Condensed vs expanded view modes per pane.
- PR review tab with branch diff against target branch.
- GitHub Actions checks tab with status and logs.
- Optional utility terminal pop-out and larger dedicated window.
- Remove open/close animations where they fight customization.

## Recommended First PR Checklist

- [ ] Decide ordering with #264. Preferred: land tmux-hard-requirement first if #263 includes multiple live terminal panes.
- [ ] Add `react-resizable-panels`.
- [ ] Add `frontend/src/lib/workspace-layout.ts` with typed layout model and reducers.
- [ ] Add `test/workspace-layout.test.ts` for tab move, split, close, prune, and invalid drop behavior.
- [ ] Extract file-tab content rendering from `FileViewerPane` so a single tab can render inside any workspace pane.
- [ ] Add `WorkspaceLayout`, `WorkspacePane`, `WorkspaceTabBar`, and `WorkspaceDropOverlay`.
- [ ] Wire session view in `App.tsx` through the new main layout.
- [ ] Keep `FileTreeSidebar` and left `Sidebar` behavior stable.
- [ ] Add at least one browser/component smoke test for opening a changed file beside an active session.
- [ ] Run `npm run build`, `npm test`, and targeted Vitest for the new reducer tests.

## Review Scores

- CEO: pass with scoped expansion. The feature is strategically right if it starts with the shared workspace model.
- Design: 6/10 to 8/10 after the states and desktop-first constraints above.
- Eng: pass with concerns. Main risk is terminal remounting and layout state bugs.

## Final Recommendation

First slice: "workspace layout substrate for main-pane tab splitting."

Do not start with sidebars. Do not start with full docking. Do not start with persistence.

Start by making the main area able to host mixed tab types in resizable split panes. Once that is real, sidebars and PR/checks become placement policy, not architecture.
