import assert from "node:assert/strict";
import test from "node:test";

import {
  LAYOUT_VERSION,
  MAX_LAYOUT_DEPTH,
  MAX_PANE_COUNT,
  MAX_SESSION_REFERENCE_LENGTH,
  MAX_TAB_COUNT,
  LayoutLimitError,
  addSessionTab,
  activeSessionTab,
  attachSessionToSelectedTab,
  canUseLiveSessionActions,
  closeSelectedPane,
  createWorkspaceLayout,
  detachTabToNewPane,
  layoutMetrics,
  moveTab,
  moveSelectedPane,
  openSessionTab,
  removeSessionFromLayout,
  resetWorkspaceLayout,
  restoreWorkspaceLayout,
  selectTab,
  serializeWorkspaceLayout,
  setSplitRatio,
  setNodeAvailability,
  sessionIds,
  splitSelectedPane,
  toggleSelectedTabStrip,
} from "../src/workspace-layout.js";

function uniqueSessionIds(state) {
  return [...new Set(sessionIds(state))];
}

test("a non-repo Workspace preserves an opaque Session identity through layout-only mutations and reopen", () => {
  const initial = createWorkspaceLayout({
    nodeId: "node-local",
    root: "/home/relay/scratch",
    rootKind: "non-repo",
    sessionId: "session-opaque-7",
  });
  const expectedSessionIds = uniqueSessionIds(initial);

  assert.equal(initial.workspace.root.kind, "non-repo");
  assert.deepEqual(expectedSessionIds, ["session-opaque-7"]);

  const withTab = addSessionTab(initial);
  const split = splitSelectedPane(withTab);
  const moved = moveSelectedPane(split);
  const hidden = toggleSelectedTabStrip(moved);
  const closed = closeSelectedPane(hidden);
  const reopened = restoreWorkspaceLayout(serializeWorkspaceLayout(closed)).state;

  for (const state of [withTab, split, moved, hidden, closed, reopened]) {
    assert.deepEqual(uniqueSessionIds(state), expectedSessionIds);
  }
  assert.equal(reopened.workspace.node.id, "node-local");
  assert.equal(reopened.workspace.root.path, "/home/relay/scratch");
});

test("layout persistence is versioned, bounded, and never persists runtime authority", () => {
  let state = createWorkspaceLayout({ sessionId: "session-opaque-9" });

  for (let count = 1; count < MAX_TAB_COUNT; count += 1) {
    state = addSessionTab(state);
  }
  assert.throws(() => addSessionTab(state), (error) => {
    assert.ok(error instanceof LayoutLimitError);
    assert.equal(error.code, "tab-cap");
    return true;
  });

  state = createWorkspaceLayout({ sessionId: "session-opaque-9" });
  for (let count = 1; count < MAX_PANE_COUNT; count += 1) {
    state = splitSelectedPane(state);
  }
  assert.throws(() => splitSelectedPane(state), (error) => {
    assert.ok(error instanceof LayoutLimitError);
    assert.ok(["pane-cap", "depth-cap"].includes(error.code));
    return true;
  });

  const serialized = JSON.parse(serializeWorkspaceLayout(state));
  assert.equal(serialized.version, LAYOUT_VERSION);
  assert.equal("nodeAvailability" in serialized, false);
  assert.equal("runtime" in serialized, false);
  assert.ok(MAX_LAYOUT_DEPTH >= 1);
});

test("invalid, corrupt, overlong, or version-mismatched persisted layouts recover deterministically without a historical availability fallback", () => {
  const snapshot = JSON.parse(serializeWorkspaceLayout(createWorkspaceLayout()));
  const malformed = restoreWorkspaceLayout("{not json");
  const incompatible = restoreWorkspaceLayout(
    JSON.stringify({ version: LAYOUT_VERSION + 1, workspace: {}, layout: {} }),
  );
  const corrupt = restoreWorkspaceLayout(
    JSON.stringify({
      ...snapshot,
      layout: { kind: "tabs", id: "pane-corrupt", showTabStrip: true, activeTabId: "tab-missing", tabs: [] },
    }),
  );
  const overlong = restoreWorkspaceLayout(
    JSON.stringify({
      ...snapshot,
      layout: {
        ...snapshot.layout,
        tabs: [{ ...snapshot.layout.tabs[0], content: { kind: "session", sessionId: "x".repeat(MAX_SESSION_REFERENCE_LENGTH + 1) } }],
      },
    }),
  );

  assert.equal(malformed.recovered, true);
  assert.equal(malformed.state.recovery.code, "invalid-json");
  assert.equal(incompatible.recovered, true);
  assert.equal(incompatible.state.recovery.code, "unsupported-version");
  assert.equal(corrupt.recovered, true);
  assert.equal(corrupt.state.recovery.code, "invalid-layout");
  assert.equal(overlong.recovered, true);
  assert.equal(overlong.state.recovery.code, "invalid-layout");
  assert.equal(malformed.state.nodeAvailability, "unknown");
  assert.equal(incompatible.state.nodeAvailability, "unknown");
  assert.equal(corrupt.state.nodeAvailability, "unknown");
  assert.equal(overlong.state.nodeAvailability, "unknown");
});

test("unavailable Nodes disable live Session actions and presentation mutations expose no termination operation", () => {
  const unavailable = setNodeAvailability(createWorkspaceLayout(), "unavailable");

  assert.equal(canUseLiveSessionActions(unavailable), false);
  assert.equal("terminateSession" in unavailable, false);
  assert.equal("terminateSession" in addSessionTab(unavailable), false);
  assert.deepEqual(uniqueSessionIds(addSessionTab(unavailable)), uniqueSessionIds(unavailable));
});

test("selecting a tab changes only the presentation selection", () => {
  const initial = createWorkspaceLayout({ sessionId: "session-opaque-10" });
  const withTab = addSessionTab(initial);
  const nextTabId = withTab.layout.tabs[1].id;
  const selected = selectTab(withTab, withTab.selectedPaneId, nextTabId);

  assert.equal(selected.layout.activeTabId, nextTabId);
  assert.deepEqual(uniqueSessionIds(selected), uniqueSessionIds(withTab));
});

test("resetting a valid Workspace layout keeps its opaque Session reference and clears recovery state", () => {
  const initial = createWorkspaceLayout({
    nodeId: "node-local",
    root: "/home/relay/non-repo",
    rootKind: "non-repo",
    sessionId: "session-opaque-11",
  });
  const reset = resetWorkspaceLayout(splitSelectedPane(addSessionTab(initial)));

  assert.deepEqual(uniqueSessionIds(reset), ["session-opaque-11"]);
  assert.equal(reset.recovery, null);
  assert.equal(reset.workspace.node.id, "node-local");
  assert.equal(reset.workspace.root.path, "/home/relay/non-repo");
});

test("opening, dragging, and resizing Session tabs remains a bounded presentation-only mutation", () => {
  let state = createWorkspaceLayout({ sessionId: "session-opaque-12" });
  state = openSessionTab(state, "session-opaque-13", "Codex session");
  const withTwoTabs = state;
  state = splitSelectedPane(state);
  const splitId = state.layout.id;
  const sourcePaneId = state.layout.first.id;
  const targetPaneId = state.layout.second.id;
  const sourceTabId = state.layout.first.tabs[0].id;

  state = moveTab(state, sourcePaneId, sourceTabId, targetPaneId, 0);
  state = setSplitRatio(state, splitId, 0.72);

  assert.equal(activeSessionTab(state).paneId, targetPaneId);
  assert.equal(state.layout.ratio, 0.72);
  assert.deepEqual(uniqueSessionIds(state).sort(), uniqueSessionIds(withTwoTabs).sort());
  assert.throws(
    () => moveTab(state, sourcePaneId, state.layout.first.tabs[0].id, targetPaneId, 0),
    (error) => error instanceof LayoutLimitError && error.code === "move-tab-unavailable",
  );
});

test("detaching a tab creates a selected sibling split without cloning Session references", () => {
  let state = createWorkspaceLayout({ sessionId: "session-opaque-20" });
  state = openSessionTab(state, "session-opaque-21", "Codex session");
  state = openSessionTab(state, "session-opaque-22", "Hermes session");
  const sourcePaneId = state.layout.id;
  const detachedTabId = state.layout.tabs[1].id;
  const sourceActiveTabId = state.layout.tabs[2].id;

  state = detachTabToNewPane(state, {
    sourcePaneId,
    tabId: detachedTabId,
    placement: "before",
  });

  assert.equal(state.layout.kind, "split");
  assert.equal(state.layout.first.id, state.selectedPaneId);
  assert.equal(state.layout.first.tabs[0].id, detachedTabId);
  assert.equal(state.layout.first.tabs[0].content.sessionId, "session-opaque-21");
  assert.equal(state.layout.second.id, sourcePaneId);
  assert.equal(state.layout.second.activeTabId, sourceActiveTabId);
  assert.deepEqual(sessionIds(state), ["session-opaque-21", "session-opaque-20", "session-opaque-22"]);
  assert.deepEqual(layoutMetrics(state), { paneCount: 2, tabCount: 3, maxDepth: 1 });
});

test("detaching a sole tab mirrors its Session reference into a selected sibling pane", () => {
  const singleTab = createWorkspaceLayout({ sessionId: "session-opaque-22" });
  const sourceTab = singleTab.layout.tabs[0];
  const detached = detachTabToNewPane(singleTab, {
    sourcePaneId: singleTab.layout.id,
    tabId: sourceTab.id,
  });

  assert.equal(detached.layout.kind, "split");
  assert.equal(detached.layout.first.tabs[0].id, sourceTab.id);
  assert.equal(detached.layout.second.id, detached.selectedPaneId);
  assert.notEqual(detached.layout.second.tabs[0].id, sourceTab.id);
  assert.equal(detached.layout.second.tabs[0].title, `${sourceTab.title} mirror`);
  assert.deepEqual(sessionIds(detached), ["session-opaque-22", "session-opaque-22"]);
  assert.deepEqual(layoutMetrics(detached), { paneCount: 2, tabCount: 2, maxDepth: 1 });
});

test("detaching a tab enforces placement, pane-count, and tab-count invariants", () => {
  const singleTab = createWorkspaceLayout({ sessionId: "session-opaque-23" });
  assert.throws(
    () => detachTabToNewPane(singleTab, {
      sourcePaneId: singleTab.layout.id,
      tabId: singleTab.layout.tabs[0].id,
      placement: "sideways",
    }),
    /placement must be before or after/,
  );

  let capped = singleTab;
  capped = detachTabToNewPane(capped, {
    sourcePaneId: capped.layout.id,
    tabId: capped.layout.tabs[0].id,
  });
  capped = detachTabToNewPane(capped, {
    sourcePaneId: capped.selectedPaneId,
    tabId: activeSessionTab(capped).tab.id,
  });
  capped = detachTabToNewPane(capped, {
    sourcePaneId: capped.selectedPaneId,
    tabId: activeSessionTab(capped).tab.id,
  });
  assert.throws(
    () => detachTabToNewPane(capped, {
      sourcePaneId: capped.selectedPaneId,
      tabId: activeSessionTab(capped).tab.id,
    }),
    (error) => error instanceof LayoutLimitError && error.code === "pane-cap",
  );

  let tabCapped = createWorkspaceLayout({ sessionId: "session-opaque-tab-cap" });
  for (let count = 1; count < 4; count += 1) tabCapped = addSessionTab(tabCapped);
  const rootPaneId = tabCapped.layout.id;
  tabCapped = detachTabToNewPane(tabCapped, {
    sourcePaneId: rootPaneId,
    tabId: activeSessionTab(tabCapped).tab.id,
  });
  const firstMirrorPaneId = tabCapped.selectedPaneId;
  tabCapped = selectTab(tabCapped, rootPaneId, tabCapped.layout.first.activeTabId);
  tabCapped = addSessionTab(tabCapped);
  tabCapped = detachTabToNewPane(tabCapped, {
    sourcePaneId: rootPaneId,
    tabId: activeSessionTab(tabCapped).tab.id,
  });
  tabCapped = selectTab(tabCapped, rootPaneId, tabCapped.layout.first.first.activeTabId);
  tabCapped = addSessionTab(tabCapped);
  assert.equal(layoutMetrics(tabCapped).tabCount, MAX_TAB_COUNT);
  assert.throws(
    () => detachTabToNewPane(tabCapped, {
      sourcePaneId: firstMirrorPaneId,
      tabId: tabCapped.layout.second.tabs[0].id,
    }),
    (error) => error instanceof LayoutLimitError && error.code === "tab-cap",
  );
});

test("attaching an already-owned Session replaces only the selected opaque layout reference", () => {
  const initial = createWorkspaceLayout({ sessionId: "session-opaque-14" });
  const attached = attachSessionToSelectedTab(initial, "session-opaque-15", "Attached session");

  assert.equal(activeSessionTab(attached).tab.content.sessionId, "session-opaque-15");
  assert.equal(activeSessionTab(attached).tab.title, "Attached session");
  assert.equal("runtime" in attached, false);
});

test("closing a provider Session removes only its presentation references", () => {
  let state = createWorkspaceLayout({ sessionId: "session-opaque-12" });
  state = openSessionTab(state, "session-opaque-13", "Codex session");
  state = splitSelectedPane(state);

  state = removeSessionFromLayout(state, "session-opaque-13");

  assert.deepEqual(sessionIds(state), ["session-opaque-12"]);
  assert.equal(state.layout.kind, "tabs");
  assert.equal(activeSessionTab(state).tab.content.sessionId, "session-opaque-12");
});

test("closing the final provider Session removes its last tab and pane instead of retaining a shadow layout", () => {
  let state = createWorkspaceLayout({ sessionId: "session-opaque-final" });
  state = splitSelectedPane(state);

  const removed = removeSessionFromLayout(state, "session-opaque-final");

  assert.equal(removed, null);
});
