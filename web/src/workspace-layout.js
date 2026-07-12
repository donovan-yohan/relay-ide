export const LAYOUT_VERSION = 1;
export const MAX_LAYOUT_DEPTH = 3;
export const MAX_PANE_COUNT = 4;
export const MAX_TAB_COUNT = 6;
export const MAX_SESSION_REFERENCE_LENGTH = 128;

const MAX_WORKSPACE_TEXT_LENGTH = 256;
const NODE_AVAILABILITY = new Set(["available", "unavailable", "unknown"]);

export class LayoutLimitError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = "LayoutLimitError";
  }
}

export function createWorkspaceLayout({
  workspaceId = "workspace-local",
  workspaceName = "Local workspace",
  nodeId = "node-local",
  nodeLabel = "Local Node",
  root = "/home/relay/scratch",
  rootKind = "non-repo",
  sessionId = "session-local-1",
} = {}) {
  const tab = createSessionTab("tab-1", sessionId, "Session");
  const state = {
    version: LAYOUT_VERSION,
    workspace: {
      id: workspaceId,
      name: workspaceName,
      node: { id: nodeId, label: nodeLabel },
      root: { path: root, kind: rootKind },
    },
    layout: {
      kind: "tabs",
      id: "pane-1",
      showTabStrip: true,
      activeTabId: tab.id,
      tabs: [tab],
    },
    selectedPaneId: "pane-1",
    nodeAvailability: "available",
    recovery: null,
  };
  assertSnapshot(state);
  return state;
}

export function addSessionTab(state, { sessionId, title } = {}) {
  const metrics = layoutMetrics(state);
  if (metrics.tabCount >= MAX_TAB_COUNT) {
    throw new LayoutLimitError("tab-cap", `This Workspace is limited to ${MAX_TAB_COUNT} tabs.`);
  }

  const pane = selectedPane(state);
  const tab = createSessionTab(
    nextId(state.layout, "tab"),
    sessionId ?? activeSessionId(pane),
    title ?? "Session view",
  );
  return withLayout(state, replacePane(state.layout, pane.id, {
    ...pane,
    activeTabId: tab.id,
    tabs: [...pane.tabs, tab],
  }), pane.id);
}

export function activeSessionTab(state) {
  const pane = selectedPane(state);
  const tab = pane.tabs.find((candidate) => candidate.id === pane.activeTabId);
  if (!tab) throw new TypeError("Selected pane has no active Session tab.");
  return { paneId: pane.id, tab: clone(tab) };
}

export function openSessionTab(state, sessionId, title = "Session") {
  assertText(sessionId, "Session reference", MAX_SESSION_REFERENCE_LENGTH);
  const existing = findTab(state.layout, sessionId);
  if (existing) return selectTab(state, existing.paneId, existing.tabId);
  return addSessionTab(state, { sessionId, title });
}

// Session lifecycle remains outside this presentation model. The caller has
// already created or reattached a node-owned opaque Session and only records
// that reference on the currently selected tab.
export function attachSessionToSelectedTab(state, sessionId, title = "Session") {
  assertText(sessionId, "Session reference", MAX_SESSION_REFERENCE_LENGTH);
  assertText(title, "tab title");
  const pane = selectedPane(state);
  const tabs = pane.tabs.map((tab) => (
    tab.id === pane.activeTabId ? { ...tab, title, content: { kind: "session", sessionId } } : tab
  ));
  return withLayout(state, replacePane(state.layout, pane.id, { ...pane, tabs }), pane.id);
}

export function selectTab(state, paneId, tabId) {
  const pane = findPane(state.layout, paneId);
  if (!pane || !pane.tabs.some((tab) => tab.id === tabId)) {
    throw new TypeError("Selected tab does not exist in the Workspace layout.");
  }
  return withLayout(state, replacePane(state.layout, pane.id, { ...pane, activeTabId: tabId }), pane.id);
}

export function splitSelectedPane(state) {
  const metrics = layoutMetrics(state);
  if (metrics.paneCount >= MAX_PANE_COUNT) {
    throw new LayoutLimitError("pane-cap", `This Workspace is limited to ${MAX_PANE_COUNT} panes.`);
  }

  const pane = selectedPane(state);
  if (paneDepth(state.layout, pane.id) >= MAX_LAYOUT_DEPTH) {
    throw new LayoutLimitError("depth-cap", `This Workspace is limited to ${MAX_LAYOUT_DEPTH} layout splits.`);
  }

  const activeTab = pane.tabs.find((tab) => tab.id === pane.activeTabId);
  const mirrorTab = { ...clone(activeTab), id: nextId(state.layout, "tab"), title: `${activeTab.title} mirror` };
  const mirrorPane = {
    kind: "tabs",
    id: nextId(state.layout, "pane"),
    showTabStrip: true,
    activeTabId: mirrorTab.id,
    tabs: [mirrorTab],
  };
  const layout = replacePane(state.layout, pane.id, {
    kind: "split",
    id: nextId(state.layout, "split"),
    direction: "row",
    ratio: 0.5,
    first: clone(pane),
    second: mirrorPane,
  });
  return withLayout(state, layout, mirrorPane.id);
}

export function moveSelectedPane(state) {
  const pane = selectedPane(state);
  const moved = swapPaneWithSibling(state.layout, pane.id);
  if (!moved) {
    throw new LayoutLimitError("move-unavailable", "Split a pane before moving it.");
  }
  return withLayout(state, moved, pane.id);
}

export function toggleSelectedTabStrip(state) {
  const pane = selectedPane(state);
  return withLayout(state, replacePane(state.layout, pane.id, { ...pane, showTabStrip: !pane.showTabStrip }), pane.id);
}

export function closeSelectedPane(state) {
  const pane = selectedPane(state);
  if (pane.tabs.length > 1) {
    const removedIndex = pane.tabs.findIndex((tab) => tab.id === pane.activeTabId);
    const tabs = pane.tabs.filter((tab) => tab.id !== pane.activeTabId);
    const nextTab = tabs[Math.min(removedIndex, tabs.length - 1)];
    return withLayout(state, replacePane(state.layout, pane.id, { ...pane, tabs, activeTabId: nextTab.id }), pane.id);
  }

  const layout = removePane(state.layout, pane.id);
  if (!layout) {
    throw new LayoutLimitError("root-pane", "Keep one pane open to preserve the Workspace view.");
  }
  return withLayout(state, layout, firstPaneId(layout));
}

export function removeSessionFromLayout(state, sessionId) {
  assertText(sessionId, "Session reference", MAX_SESSION_REFERENCE_LENGTH);
  const layout = removeSessionTabs(state.layout, sessionId);
  if (!layout) return null;
  const selectedPaneId = findPane(layout, state.selectedPaneId) ? state.selectedPaneId : firstPaneId(layout);
  return withLayout(state, layout, selectedPaneId);
}

export function moveTab(state, sourcePaneId, tabId, targetPaneId, targetIndex) {
  const source = findPane(state.layout, sourcePaneId);
  const target = findPane(state.layout, targetPaneId);
  if (!source || !target) throw new TypeError("Tab move references a missing pane.");
  const sourceIndex = source.tabs.findIndex((tab) => tab.id === tabId);
  if (sourceIndex < 0) throw new TypeError("Tab move references a missing tab.");
  const requestedIndex = Number.isInteger(targetIndex) ? targetIndex : target.tabs.length;
  if (requestedIndex < 0 || requestedIndex > target.tabs.length) {
    throw new TypeError("Tab move index is invalid.");
  }

  if (sourcePaneId === targetPaneId) {
    const tabs = [...source.tabs];
    const [tab] = tabs.splice(sourceIndex, 1);
    const insertionIndex = sourceIndex < requestedIndex ? requestedIndex - 1 : requestedIndex;
    tabs.splice(insertionIndex, 0, tab);
    return withLayout(state, replacePane(state.layout, source.id, {
      ...source,
      activeTabId: tab.id,
      tabs,
    }), source.id);
  }

  if (source.tabs.length === 1) {
    throw new LayoutLimitError("move-tab-unavailable", "Keep one Session tab in each pane.");
  }
  const tab = source.tabs[sourceIndex];
  const sourceTabs = source.tabs.filter((candidate) => candidate.id !== tabId);
  const targetTabs = [...target.tabs];
  targetTabs.splice(requestedIndex, 0, tab);
  const withoutSource = replacePane(state.layout, source.id, {
    ...source,
    activeTabId: sourceTabs[Math.min(sourceIndex, sourceTabs.length - 1)].id,
    tabs: sourceTabs,
  });
  return withLayout(state, replacePane(withoutSource, target.id, {
    ...target,
    activeTabId: tab.id,
    tabs: targetTabs,
  }), target.id);
}

export function setSplitRatio(state, splitId, ratio) {
  if (typeof ratio !== "number" || !Number.isFinite(ratio)) {
    throw new TypeError("Split ratio is invalid.");
  }
  const split = findSplit(state.layout, splitId);
  if (!split) throw new TypeError("Split does not exist in the Workspace layout.");
  return withLayout(state, replaceLayoutNode(state.layout, split.id, {
    ...split,
    ratio: clampRatio(ratio),
  }), state.selectedPaneId);
}

export function resetWorkspaceLayout(state) {
  const sessionId = sessionIds(state)[0] ?? "session-local-1";
  return {
    ...createWorkspaceLayout({
      workspaceId: state.workspace.id,
      workspaceName: state.workspace.name,
      nodeId: state.workspace.node.id,
      nodeLabel: state.workspace.node.label,
      root: state.workspace.root.path,
      rootKind: state.workspace.root.kind,
      sessionId,
    }),
    nodeAvailability: state.nodeAvailability,
  };
}

export function setNodeAvailability(state, nodeAvailability) {
  if (!NODE_AVAILABILITY.has(nodeAvailability)) {
    throw new TypeError(`Unsupported Node availability: ${nodeAvailability}`);
  }
  return { ...state, nodeAvailability };
}

export function canUseLiveSessionActions(state) {
  return state.nodeAvailability === "available";
}

export function serializeWorkspaceLayout(state) {
  assertSnapshot(state);
  const { version, workspace, layout, selectedPaneId } = state;
  return JSON.stringify({ version, workspace, layout, selectedPaneId });
}

export function restoreWorkspaceLayout(serialized) {
  const fallback = { ...createWorkspaceLayout(), nodeAvailability: "unknown" };
  if (serialized === null || serialized === undefined) {
    return { state: fallback, recovered: false };
  }

  let snapshot;
  try {
    snapshot = JSON.parse(serialized);
  } catch {
    return recovery(fallback, "invalid-json", "Saved layout could not be read.");
  }
  if (snapshot?.version !== LAYOUT_VERSION) {
    return recovery(fallback, "unsupported-version", "Saved layout uses an unsupported version.");
  }
  try {
    const normalized = clone(snapshot);
    normalizeSplitRatios(normalized.layout);
    assertSnapshot(normalized);
    return { state: { ...normalized, nodeAvailability: "unknown", recovery: null }, recovered: false };
  } catch {
    return recovery(fallback, "invalid-layout", "Saved layout is invalid or exceeds current limits.");
  }
}

export function sessionIds(state) {
  const ids = [];
  visitPanes(state.layout, (pane) => {
    for (const tab of pane.tabs) {
      if (tab.content.kind === "session") ids.push(tab.content.sessionId);
    }
  });
  return ids;
}

export function layoutMetrics(state) {
  let paneCount = 0;
  let tabCount = 0;
  let maxDepth = 0;
  visitLayout(state.layout, 0, (node, depth) => {
    maxDepth = Math.max(maxDepth, depth);
    if (node.kind === "tabs") {
      paneCount += 1;
      tabCount += node.tabs.length;
    }
  });
  return { paneCount, tabCount, maxDepth };
}

export function selectedPane(state) {
  const pane = findPane(state.layout, state.selectedPaneId);
  if (!pane) throw new TypeError("Selected pane does not exist in the Workspace layout.");
  return pane;
}

function recovery(fallback, code, message) {
  return { state: { ...fallback, recovery: { code, message } }, recovered: true };
}

function createSessionTab(id, sessionId, title) {
  return { id, title, content: { kind: "session", sessionId } };
}

function withLayout(state, layout, selectedPaneId) {
  const next = { ...state, layout, selectedPaneId, recovery: null };
  assertSnapshot(next);
  return next;
}

function assertSnapshot(snapshot) {
  if (!snapshot || snapshot.version !== LAYOUT_VERSION) {
    throw new TypeError("Workspace layout uses an unsupported version.");
  }
  assertWorkspace(snapshot.workspace);
  assertText(snapshot.selectedPaneId, "selected pane");

  const tabIds = new Set();
  const paneIds = new Set();
  const layoutIds = new Set();
  const metrics = { paneCount: 0, tabCount: 0 };
  assertLayout(snapshot.layout, 0, { tabIds, paneIds, layoutIds, metrics });
  if (metrics.paneCount > MAX_PANE_COUNT || metrics.tabCount > MAX_TAB_COUNT) {
    throw new TypeError("Workspace layout exceeds the bounded presentation caps.");
  }
  if (!paneIds.has(snapshot.selectedPaneId)) {
    throw new TypeError("Workspace layout selects a missing pane.");
  }
}

function assertWorkspace(workspace) {
  if (!workspace) throw new TypeError("Workspace identity is invalid.");
  assertText(workspace.id, "Workspace id");
  assertText(workspace.name, "Workspace name");
  if (!workspace.node) throw new TypeError("Workspace must bind one visible Node.");
  assertText(workspace.node.id, "Node id");
  assertText(workspace.node.label, "Node label");
  if (!workspace.root || !["repo", "non-repo"].includes(workspace.root.kind)) {
    throw new TypeError("Workspace must bind an approved repo or non-repo root.");
  }
  assertText(workspace.root.path, "Workspace root");
}

function assertLayout(node, depth, context) {
  if (!node || typeof node !== "object" || depth > MAX_LAYOUT_DEPTH) {
    throw new TypeError("Workspace layout depth is invalid.");
  }
  assertUniqueId(node.id, context.layoutIds, "layout node");

  if (node.kind === "tabs") {
    assertUniqueId(node.id, context.paneIds, "pane");
    if (typeof node.showTabStrip !== "boolean" || !Array.isArray(node.tabs) || node.tabs.length === 0) {
      throw new TypeError("Tab pane is invalid.");
    }
    assertText(node.activeTabId, "active tab");
    context.metrics.paneCount += 1;
    context.metrics.tabCount += node.tabs.length;
    let active = false;
    for (const tab of node.tabs) {
      if (!tab) throw new TypeError("Tab identity is invalid.");
      assertUniqueId(tab.id, context.tabIds, "tab");
      assertText(tab.title, "tab title");
      active ||= tab.id === node.activeTabId;
      if (!tab.content || tab.content.kind !== "session") {
        throw new TypeError("This MVP only permits opaque Session references in layout tabs.");
      }
      assertText(tab.content.sessionId, "Session reference", MAX_SESSION_REFERENCE_LENGTH);
    }
    if (!active) throw new TypeError("Tab pane selects a missing tab.");
    return;
  }

  if (node.kind !== "split" || node.direction !== "row" || !isValidRatio(node.ratio)) {
    throw new TypeError("Layout node is invalid.");
  }
  assertLayout(node.first, depth + 1, context);
  assertLayout(node.second, depth + 1, context);
}

function assertUniqueId(id, ids, label) {
  assertText(id, label);
  if (ids.has(id)) throw new TypeError(`Workspace ${label} identity is invalid.`);
  ids.add(id);
}

function assertText(value, label, limit = MAX_WORKSPACE_TEXT_LENGTH) {
  if (typeof value !== "string" || value.length === 0 || value.length > limit) {
    throw new TypeError(`Workspace ${label} is invalid.`);
  }
}

function activeSessionId(pane) {
  return pane.tabs.find((tab) => tab.id === pane.activeTabId).content.sessionId;
}

function findPane(node, paneId) {
  if (node.kind === "tabs") return node.id === paneId ? node : null;
  return findPane(node.first, paneId) ?? findPane(node.second, paneId);
}

function findSplit(node, splitId) {
  if (node.kind === "tabs") return null;
  if (node.id === splitId) return node;
  return findSplit(node.first, splitId) ?? findSplit(node.second, splitId);
}

function findTab(node, sessionId) {
  if (node.kind === "tabs") {
    const tab = node.tabs.find((candidate) => candidate.content.sessionId === sessionId);
    return tab ? { paneId: node.id, tabId: tab.id } : null;
  }
  return findTab(node.first, sessionId) ?? findTab(node.second, sessionId);
}

function paneDepth(node, paneId, depth = 0) {
  if (node.kind === "tabs") return node.id === paneId ? depth : -1;
  return Math.max(paneDepth(node.first, paneId, depth + 1), paneDepth(node.second, paneId, depth + 1));
}

function replacePane(node, paneId, replacement) {
  if (node.kind === "tabs") return node.id === paneId ? replacement : node;
  return { ...node, first: replacePane(node.first, paneId, replacement), second: replacePane(node.second, paneId, replacement) };
}

function replaceLayoutNode(node, nodeId, replacement) {
  if (node.id === nodeId) return replacement;
  if (node.kind === "tabs") return node;
  return {
    ...node,
    first: replaceLayoutNode(node.first, nodeId, replacement),
    second: replaceLayoutNode(node.second, nodeId, replacement),
  };
}

function swapPaneWithSibling(node, paneId) {
  if (node.kind === "tabs") return null;
  if (node.first.kind === "tabs" && node.first.id === paneId) return { ...node, first: node.second, second: node.first };
  if (node.second.kind === "tabs" && node.second.id === paneId) return { ...node, first: node.second, second: node.first };
  const first = swapPaneWithSibling(node.first, paneId);
  if (first) return { ...node, first };
  const second = swapPaneWithSibling(node.second, paneId);
  return second ? { ...node, second } : null;
}

function removePane(node, paneId) {
  if (node.kind === "tabs") return node.id === paneId ? null : node;
  if (node.first.kind === "tabs" && node.first.id === paneId) return node.second;
  if (node.second.kind === "tabs" && node.second.id === paneId) return node.first;
  const first = removePane(node.first, paneId);
  if (first !== node.first) return first ? { ...node, first } : node.second;
  const second = removePane(node.second, paneId);
  return second !== node.second ? (second ? { ...node, second } : node.first) : node;
}

function firstPaneId(node) {
  return node.kind === "tabs" ? node.id : firstPaneId(node.first);
}

function removeSessionTabs(node, sessionId) {
  if (node.kind === "tabs") {
    const tabs = node.tabs.filter((tab) => tab.content.sessionId !== sessionId);
    if (tabs.length === 0) return null;
    const activeTabId = tabs.some((tab) => tab.id === node.activeTabId) ? node.activeTabId : tabs[0].id;
    return { ...node, activeTabId, tabs };
  }
  const first = removeSessionTabs(node.first, sessionId);
  const second = removeSessionTabs(node.second, sessionId);
  if (!first) return second;
  if (!second) return first;
  return { ...node, first, second };
}

function nextId(layout, prefix) {
  let highest = 0;
  const expression = new RegExp(`^${prefix}-([0-9]+)$`);
  visitLayout(layout, 0, (node) => {
    const match = expression.exec(node.id);
    if (match) highest = Math.max(highest, Number(match[1]));
    if (node.kind === "tabs") {
      for (const tab of node.tabs) {
        const tabMatch = expression.exec(tab.id);
        if (tabMatch) highest = Math.max(highest, Number(tabMatch[1]));
      }
    }
  });
  return `${prefix}-${highest + 1}`;
}

function visitPanes(node, visit) {
  visitLayout(node, 0, (candidate) => { if (candidate.kind === "tabs") visit(candidate); });
}

function visitLayout(node, depth, visit) {
  visit(node, depth);
  if (node.kind === "split") {
    visitLayout(node.first, depth + 1, visit);
    visitLayout(node.second, depth + 1, visit);
  }
}

function normalizeSplitRatios(node) {
  if (node.kind !== "split") return;
  if (node.ratio === undefined) node.ratio = 0.5;
  normalizeSplitRatios(node.first);
  normalizeSplitRatios(node.second);
}

function clampRatio(value) {
  return Math.max(0.2, Math.min(0.8, value));
}

function isValidRatio(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0.2 && value <= 0.8;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}
