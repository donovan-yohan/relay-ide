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
  canUseLiveSessionActions,
  closeSelectedPane,
  createWorkspaceLayout,
  moveSelectedPane,
  resetWorkspaceLayout,
  restoreWorkspaceLayout,
  selectTab,
  serializeWorkspaceLayout,
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
