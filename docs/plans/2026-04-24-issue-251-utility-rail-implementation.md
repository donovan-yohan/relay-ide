# Issue 251 Utility Rail Implementation Spec

Source issue: https://github.com/donovan-yohan/relay-ide/issues/251

HTML sketch: `docs/plans/issue-251-utility-rail-layout-sketch.html`

Branch reviewed: `nightly`

Base commit reviewed: `d5c62ff`

## Goal

Introduce a persistent workspace utility rail that consolidates secondary workspace tools into one coherent surface without closing off the larger layout vision: tabs and panes should eventually be collectible, draggable, split out, resized, grouped, ungrouped, and rearranged.

This issue should not become a one-off "better file sidebar." It should create the utility surface vocabulary that later workspace layout work can promote into a fully rearrangeable pane system.

## Larger Vision Constraint

Relay is moving toward a workspace where every useful surface can become a tab or pane:

- agent sessions
- terminal sessions
- files
- diffs and review
- logs and output
- stats, cost, context, and session telemetry
- utility terminals

Long term, these surfaces should be movable between groups, dragged out into adjacent panes, resized, shown, hidden, regrouped, and ungrouped. Issue #251 should therefore model utility tabs with stable identities and panel boundaries instead of hard-coding them as special cases inside `FileTreeSidebar`.

The right utility rail is the default home for utility surfaces, not their permanent container. The icon rail is always docked at the far right when visible. The selected utility pane appears immediately to the left of that icon rail. In the larger workspace model, users should be able to drag any utility icon out of the rail and anchor that full pane elsewhere in the workspace.

## Sidebar Display Model

The right utility rail should use the same visible/hidden shell model that should later apply to the left sidebar:

| Mode      | Behavior                                                                                                                                                  |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `visible` | Right rail is present. The far-right icon strip is always visible; if a utility icon is selected, its pane renders immediately to the left of the strip.  |
| `hidden`  | Right rail takes no layout width; the main area gets maximum space. A top-corner toggle remains available, matching today's right-sidebar button pattern. |

There is no separate expanded/collapsed mode. The icon strip plus hover tooltips is enough. If the user clicks the currently active icon again, Relay clears the selected utility pane and leaves only the icon strip visible. If the user hides the rail, both the icon strip and utility content disappear.

The first implementation should treat the right rail as the proving ground for this model. The left sidebar can adopt the same state language later.

The icon strip has two jobs:

- Click an icon to make that utility surface the selected right-side pane. Click the same active icon again to clear the selected pane.
- Drag an icon out to promote that utility surface into an anchored full pane in the future layout system.

Example target behavior:

1. The rail has `git diff`, `PR`, and `file browser` icons.
2. The selected right-side pane is `git diff`, rendered immediately left of the icon rail.
3. The user drags `file browser` out of the rail and anchors it as its own pane.
4. The layout becomes `[file browser][git diff][icon rail]`.
5. The user clicks the remaining `PR` icon in the rail.
6. The rail-selected pane swaps from `git diff` to `PR`, producing `[file browser][PR][icon rail]`.

The anchored `file browser` pane is no longer competing for the rail-selected pane unless the user docks it back into the rail. Its icon may remain visible as a focus/dock control later, but its placement is different from rail-hosted utility tabs.

If drag-out is not implemented in the first #251 PR, the component and state model should still expose stable utility tab identities so the later drag/drop implementation does not need to reinterpret the rail.

Resize invariant:

- Anchored panes have their own width and resize handle.
- The rail-selected pane has its own width and resize handle.
- These widths are independent, so resizing `[file browser]` does not resize `[PR]`.
- The far-right icon rail is fixed width and never resizes.
- Hiding the rail removes the fixed icon rail and rail-selected pane, but does not destroy anchored pane widths.

Border invariant:

- Adjacent panes share a single 1px divider.
- Do not render visual gaps or double borders between `[anchored pane][rail-selected pane][icon rail]`.
- Resize handles sit on the shared divider and may increase hit target invisibly, but the visible line remains one pixel.
- Hovering or dragging a resize handle can recolor the shared divider; it should not widen the divider or push panes apart.

## Animation Constraint

Reduce sliding and dynamic layout animation. This is a dev tool; layout should take the space it owns immediately.

Use immediate reflow for:

- opening and closing the utility rail
- resizing panes
- switching utility tabs
- moving future tabs between pane groups
- expanding a pane to claim available workspace space

Keep only lightweight affordances where they communicate state without delaying layout:

- hover/focus color changes
- active tab border changes
- loading spinners or text state
- short status flashes for changed files

Avoid width/transform slide transitions for primary layout changes. Mobile drawer behavior may still need a direct off-canvas fallback, but desktop workspace layout should not slide.

## Current Code

| Concern                        | Current implementation                                                                                                                    |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Session workspace shell        | `frontend/src/App.tsx` renders session mode with `SplitPaneLayout`.                                                                       |
| Three-pane layout              | `frontend/src/components/SplitPaneLayout.tsx` hard-codes terminal, optional file viewer, and optional right sidebar.                      |
| Existing right sidebar state   | `frontend/src/lib/stores/ui.ts` stores `rightSidebarCollapsed`, `rightSidebarWidth`, and `rightSidebarTab`.                               |
| Existing recover toggle        | `frontend/src/components/PrTopBar.tsx` renders the top-right sidebar toggle button.                                                       |
| Existing right sidebar content | `frontend/src/components/FileTreeSidebar.tsx` owns `changes`, `all-files`, and placeholder `checks` tabs.                                 |
| File tabs                      | `frontend/src/lib/stores/ui.ts` stores `openFileTabs` and `activeFileTabKey`; `FileViewerPane.tsx` owns tab chrome and content rendering. |
| Full diff route                | `FullPageDiff.tsx` is still a modal/full-page overlay via `fullPageDiff`, causing view-mode jumps.                                        |
| Stats data                     | `useTelemetryStore` can summarize session telemetry; `SessionStatusBar` renders per-session model/context/tokens/cost.                    |

## Implementation Plan

> Generated by `/scope`-style planning on 2026-04-24

### Files to Change

```files
frontend/src/lib/stores/ui.ts -- replace narrow rightSidebarTab state with workspace-scoped utility rail state and openUtilityRailTab actions
frontend/src/components/SplitPaneLayout.tsx -- keep the existing three-pane shell but rename/right-size props around a generic utility rail boundary
frontend/src/components/SplitPaneLayout.css -- remove desktop slide transitions and style immediate rail reflow
frontend/src/App.tsx -- wire utility rail actions into file/review opens and render WorkspaceUtilityRail in session mode
frontend/src/hooks/useActionRegistry.ts -- route "open review"/diff actions to the review utility tab instead of only fullPageDiff
frontend/src/components/PrTopBar.tsx -- update the top-corner rail toggle to hide/show the entire right rail
frontend/src/components/WorkspaceUtilityRail.tsx -- NEW: utility rail shell, fixed icon strip, visibility toggle behavior, resize handles, and panel host
frontend/src/components/WorkspaceUtilityRail.css -- NEW: TUI-native rail styles with no desktop layout slide animation
frontend/src/components/UtilityRailFilesPanel.tsx -- NEW: files/changes panel wrapper around existing FileTreeSidebar behavior
frontend/src/components/UtilityRailReviewPanel.tsx -- NEW: review panel using existing changed-files/diff APIs and DiffViewer without full-page navigation
frontend/src/components/UtilityRailLogsPanel.tsx -- NEW: logs/output panel shell backed by current session/activity data, ready for richer streams later
frontend/src/components/UtilityRailStatsPanel.tsx -- NEW: stats panel using telemetry store summaries for current workspace/session context
frontend/src/components/FileTreeSidebar.tsx -- split reusable file-tree panel logic from old right-sidebar tab chrome or adapt it behind UtilityRailFilesPanel
frontend/src/components/FileViewerPane.tsx -- expose reusable file tab/content pieces where utility review/file actions need to target pane-compatible tabs
test/stores/ui-store.test.ts -- add workspace-scoped utility rail state, tab open, persistence, and migration coverage
test/e2e/components/WorkspaceUtilityRail.spec.ts -- NEW: component coverage for tabs, direct-open behavior, selected-pane toggle, visibility, and immediate layout states
test/e2e/components/SplitPaneLayout.spec.ts -- update expectations for generic utility rail sizing and no desktop slide behavior
docs/FRONTEND.md -- update component map and key pattern for workspace utility rail
docs/plans/2026-04-24-issue-251-utility-rail-implementation.md -- this implementation spec
```

### State Model

Add a utility rail model in `ui.ts` that is still small enough for #251 but compatible with future pane collection:

```ts
export type UtilityRailTab = 'files' | 'review' | 'logs' | 'stats';
export type UtilitySurfacePlacement =
  | { kind: 'rail' }
  | { kind: 'anchored-pane'; paneId: string };

export interface WorkspaceUtilityRailState {
  visible: boolean;
  selectedRailTab: UtilityRailTab | null;
  width: number;
  anchoredPaneWidths?: Partial<Record<UtilityRailTab, number>>;
  placements?: Partial<Record<UtilityRailTab, UtilitySurfacePlacement>>;
  reviewFilePath?: string;
  filesMode?: 'changes' | 'all-files';
}
```

Persist it per workspace path, not globally:

```text
relay-utility-rail::<workspacePath>
```

Expose actions:

- `getUtilityRailState(workspacePath)`
- `setSelectedUtilityRailTab(workspacePath, tab | null)`
- `openUtilityRailTab(workspacePath, tab, options?)`
- `setUtilityRailVisible(workspacePath, visible)`
- `toggleUtilityRailVisible(workspacePath)`
- `setUtilityRailWidth(workspacePath, width)`
- `setAnchoredUtilityPaneWidth(workspacePath, tab, width)`
- `setUtilitySurfacePlacement(workspacePath, tab, placement)`

`openUtilityRailTab()` should make the rail visible and select the requested tab unless the caller explicitly asks to preserve the current selected tab. This gives existing actions a single integration point.

Click behavior:

- Click an inactive rail icon: set `selectedRailTab` to that tab and make the rail visible.
- Click the active rail icon: set `selectedRailTab` to `null`; keep the rail visible as an icon-only strip.
- Click the top-corner toggle: set `visible` to `false` or restore it to `true`.

`placements` is a future-compatibility hook. #251 does not need to render anchored panes, but the rail should be able to understand that a utility surface may later live outside the default rail-selected pane.

Default placement is `{ kind: 'rail' }`. `selectedRailTab` selects among rail-hosted surfaces only. If `files` is anchored in its own pane, clicking `review` should swap the rail-selected pane to review rather than disturbing the anchored files pane.

Suggested constants:

```ts
export const DEFAULT_UTILITY_RAIL_WIDTH = 320;
export const MIN_UTILITY_RAIL_WIDTH = 220;
export const MAX_UTILITY_RAIL_WIDTH = 640;
export const UTILITY_ICON_RAIL_WIDTH = 48;
```

## Accepted First Slice

### 1. Create The Utility Rail Shell

Build `WorkspaceUtilityRail` as the replacement conceptual owner for the current right sidebar.

It should render:

- a vertical activity-bar-style tab strip for `files`, `review`, `logs`, and `stats`
- a panel host that keeps mounted tab panels where that preserves context
- visible and hidden rail states
- active-icon toggle behavior that can clear the selected utility pane
- controls for hiding and restoring the rail
- accessible icon buttons and tooltip labels
- no desktop slide animation

Visible mode should always keep the icon strip docked at the far right. When `selectedRailTab` is non-null, the selected pane appears immediately to the left of the icon strip. When `selectedRailTab` is `null`, only the icon strip remains visible. Hidden mode should remove both the icon strip and selected pane from layout entirely while keeping the top-corner toggle in `PrTopBar` visible.

The activity strip should use icon buttons with hover tooltips rather than persistent text labels. Use the Relay design language: lowercase labels in tooltips, monospace, 0px radius, 1px borders, pure black surfaces, no emoji, and outline-only controls. Use monochrome SVG icons, not emoji.

The selected icon owns the pane immediately left of the icon rail. Selecting `review` means that pane is review; selecting `stats` means that pane is stats. This is the mental model to preserve when utility surfaces later become draggable panes.

If a utility surface is dragged out and anchored elsewhere, the rail-selected pane continues to be controlled by the active rail-hosted icon. For example, `[file browser][git diff][icon rail]` can become `[file browser][PR][icon rail]` by clicking the `PR` icon while the anchored file browser remains in place.

### 2. Keep Layout Boundary Stable But Rename The Concept

`SplitPaneLayout` can remain as the immediate layout wrapper for this issue, but its right child should be treated as `utilityRail`, not `rightSidebar`.

Do not try to implement all draggable pane grouping in #251. Instead:

- isolate the utility rail as a pane-like child with a clear identity
- keep the resize handle behavior
- make resize available only when `visible === true` and `selectedRailTab !== null`
- keep anchored utility pane resize handles independent from the rail-selected pane resize handle
- keep the far-right icon rail fixed at `UTILITY_ICON_RAIL_WIDTH`
- render shared single-pixel dividers between adjacent panes, not double borders or gutters
- use `UTILITY_ICON_RAIL_WIDTH` when visible with no selected pane
- use zero width when hidden
- avoid slide transitions on desktop
- keep terminal as the primary workspace surface
- keep file viewer as-is until #263-style main pane tabs take over

This lets #251 land without conflicting with the larger workspace layout substrate.

### 3. Replace `FileTreeSidebar` Tab Ownership

`FileTreeSidebar` currently owns both tab chrome and file tree content. Move toward this boundary:

- `WorkspaceUtilityRail` owns utility tabs.
- `UtilityRailFilesPanel` owns files/changes content.
- `FileTreeSidebar` either becomes the files panel implementation or is split into reusable `ChangesTree` / `AllFilesTree` pieces.

The `files` tab should preserve current behavior:

- changed files tree
- all files tree
- diff source toggle
- file count
- changed-file refresh on event socket updates
- clicking a file opens the existing file viewer tab

### 4. Add Review As A First-Class Utility Tab

The `review` tab is the representative hard case. It should use existing APIs and components:

- `fetchChangedFiles`
- `fetchFileDiff`
- `fetchDefaultBranch`
- `DiffViewer`
- `DiffFileSidebar` or equivalent file list behavior
- existing diff source state

It should not require new backend routes.

It should not replace the full future review workspace. The first implementation should make review available inside the rail so actions can open review context without jumping into `FullPageDiff`.

Minimum useful review behavior:

- list changed files for the current workspace/worktree
- select a file
- render a unified diff in the rail
- support direct-open from an action with an initial file
- preserve selected file when switching away and back

### 5. Add Logs And Stats As Real Shell Tabs

`logs` and `stats` should be first-class tabs even if their first content is intentionally modest.

`logs` first slice:

- show current session identity
- show current activity from `activeSession.currentActivity`
- reserve a stable output/log region
- make the panel boundary ready for later event streams or utility terminal output

`stats` first slice:

- show current session telemetry when a session is active
- show workspace aggregate telemetry using `useTelemetryStore.summarizeSessionSetTelemetry`
- include model, context %, tokens, cost, and rate-limit fields where available

Avoid new analytics APIs unless the existing store cannot answer a required field.

### 6. Wire Existing Actions To Utility Tabs

Existing actions should open the relevant rail tab directly:

- file tree file click: open `files`, then open file tab
- terminal file path click: open `files`, then open file tab
- command palette/open review: open `review`
- full-page diff action: prefer `review` utility tab for in-workspace use; keep `FullPageDiff` only as a fallback or legacy route until replaced
- future logs/stats commands: call `openUtilityRailTab`

This is the most important acceptance path: users should not experience view-mode jumps when they ask for secondary workspace context.

### 7. Design For Future Pane Collection

Do not implement full drag/drop pane collection in #251, but structure the rail so it can become a pane source later.

Useful constraints:

- Each utility tab has a stable id.
- Each utility icon can be represented as a drag source.
- Each utility panel is independently renderable.
- The rail shell does not know panel internals.
- Panel state is keyed by workspace path and tab id.
- Opening a tab is expressed as an action, not as direct component state mutation.
- Rail visibility and selected pane are explicit (`visible`, `selectedRailTab`) instead of inferred from width.
- The rail can eventually be represented as a `WorkspacePane` child in the #263 layout tree.
- Dragging an icon out should eventually create or focus a full anchored pane for that utility tab.
- When a utility tab is anchored elsewhere, it no longer competes for the rail-selected pane until it is docked back.
- The icon strip can still act as the canonical launcher/focus/dock control for anchored surfaces later.

## Not In Scope

| Item                                  | Why deferred                                                                                                       |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Full drag/drop pane collection        | Belongs to #263-style workspace layout substrate. #251 should only preserve stable utility icon identities for it. |
| Arbitrary pane grouping/ungrouping UI | Must be designed across all tab types, not just the utility rail.                                                  |
| Utility terminal implementation       | Issue #255 owns terminal tabs in the utility surface. #251 should leave a clean host boundary.                     |
| New runtime/session types             | Explicit non-goal of #251.                                                                                         |
| Replacing session tab model           | Larger layout work. #251 only prepares compatibility.                                                              |
| Rebuilding every file/diff feature    | Explicit non-goal. Reuse current data sources and components.                                                      |
| Animated sidebar/drawer polish        | Product direction is immediate layout occupancy, not animated sliding.                                             |

## Verification

Run focused checks:

```bash
npx vitest run test/stores/ui-store.test.ts
npx playwright test test/e2e/components/WorkspaceUtilityRail.spec.ts test/e2e/components/SplitPaneLayout.spec.ts
npm run check
```

Manual QA:

- Open a session and verify terminal remains primary.
- Open changed files and confirm the utility rail selects `files`.
- Open review from command palette and confirm it opens the `review` tab without leaving session view.
- Switch between `files`, `review`, `logs`, and `stats`; confirm panel state is preserved.
- Resize the selected utility pane and anchored utility panes independently; reload the workspace and confirm widths persist for that workspace only.
- Click an inactive rail icon and confirm its pane appears immediately left of the fixed icon strip.
- Click the active rail icon again and confirm the selected pane disappears while the fixed icon strip remains.
- Hide the rail and confirm both the icon strip and selected pane take no layout width, then restore it from the top-corner button.
- Confirm anchored panes remain in place and keep their own widths when the rail-selected pane changes.
- Confirm desktop rail open/close takes layout space immediately with no slide animation.
- Confirm mobile fallback still allows access to the utility rail without covering terminal input permanently.

## Acceptance Criteria

- [ ] Relay has one utility rail surface for secondary workspace tools.
- [ ] Utility rail state is persisted per workspace.
- [ ] Existing actions can open the relevant utility tab directly.
- [ ] The rail supports `files`, `review`, `logs`, and `stats` as first-class tabs.
- [ ] The rail has explicit visible/hidden state and a nullable selected utility pane.
- [ ] The visible rail always keeps a fixed-width icon strip docked at the far right.
- [ ] Clicking the active icon clears the selected pane and leaves only the fixed icon strip visible.
- [ ] Hidden mode gives the main area maximum space while preserving a top-corner restore toggle.
- [ ] The selected utility icon determines the pane immediately left of the icon rail.
- [ ] Utility icons have stable identities suitable for future drag-out pane anchoring.
- [ ] The spec supports anchored utility surfaces such as `[file browser][git diff][icon rail]`, where clicking another rail icon swaps only the rail-selected pane.
- [ ] Anchored utility panes and the rail-selected pane have independent resize handles and persisted widths.
- [ ] The shell has a stable host boundary for future utility terminal tabs.
- [ ] Desktop layout changes use immediate reflow, not sliding layout animation.
- [ ] The tab/panel model is compatible with future draggable, groupable, resizable panes.
- [ ] No new backend runtime/session type is introduced.

## Risk Notes

- `FileTreeSidebar` currently mixes rail tab chrome and file-tree content; splitting it incorrectly could regress changed-file refresh and file selection.
- `FullPageDiff` is still reachable through `fullPageDiff` store state; action routing needs a careful migration so keyboard shortcuts and command palette actions do not fork behavior.
- `FileViewerPane` owns both file tab chrome and content rendering. Avoid deep refactors here unless necessary; #251 should prepare the boundary, not complete #263.
- Utility rail persistence must be workspace-scoped. A global active tab would feel wrong when switching repos.
- Do not reintroduce a separate collapsed mode. Visible rail with `selectedRailTab: null` gives the icon-only behavior without adding another display state.
- The fixed icon rail must stay fixed width. Width persistence applies to content panes, not the activity strip.
- Removing layout animation should be targeted. Keep useful loading/status animations; remove sliding reflow for primary workspace structure.
