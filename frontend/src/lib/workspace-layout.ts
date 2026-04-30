import { fileTabKey, type FileTabType } from './stores/ui.js';

export type WorkspaceTab =
  | {
      kind: 'session';
      sessionId: string;
      sessionType: 'agent' | 'terminal';
    }
  | {
      kind: 'file';
      filePath: string;
      tabType: FileTabType;
      token?: string;
    };

export type WorkspaceTabId = string;

export function workspaceTabId(tab: WorkspaceTab): WorkspaceTabId {
  if (tab.kind === 'session') return `session::${tab.sessionId}`;
  return `file::${fileTabKey(tab.filePath, tab.tabType)}`;
}

export interface WorkspacePane {
  type: 'pane';
  id: string;
  activeTabId: WorkspaceTabId | null;
  tabs: WorkspaceTab[];
}

export type SplitDirection = 'horizontal' | 'vertical';
export type SplitPlacement = 'before' | 'after';

export interface WorkspaceSplit {
  type: 'split';
  id: string;
  direction: SplitDirection;
  children: WorkspaceLayoutNode[];
}

export type WorkspaceLayoutNode = WorkspacePane | WorkspaceSplit;

let _paneCounter = 0;
let _splitCounter = 0;
export function freshPaneId(prefix = 'pane'): string {
  _paneCounter += 1;
  return `${prefix}-${_paneCounter}`;
}

export function freshSplitId(prefix = 'split'): string {
  _splitCounter += 1;
  return `${prefix}-${_splitCounter}`;
}

export function _resetPaneCounter(): void {
  _paneCounter = 0;
  _splitCounter = 0;
}

export function collectSplitIds(node: WorkspaceLayoutNode): string[] {
  if (node.type === 'pane') return [];
  return [node.id, ...node.children.flatMap(collectSplitIds)];
}

export function makePane(
  tabs: WorkspaceTab[] = [],
  opts?: { id?: string; activeTabId?: WorkspaceTabId | null }
): WorkspacePane {
  const id = opts?.id ?? freshPaneId();
  const ids = tabs.map(workspaceTabId);
  let active: WorkspaceTabId | null = opts?.activeTabId ?? null;
  if (active && !ids.includes(active)) active = null;
  if (!active && ids.length > 0) active = ids[0] ?? null;
  return { type: 'pane', id, activeTabId: active, tabs };
}

interface TabLocation {
  paneId: string;
  index: number;
}

function findTabLocation(
  node: WorkspaceLayoutNode,
  tabId: WorkspaceTabId
): TabLocation | null {
  if (node.type === 'pane') {
    const i = node.tabs.findIndex((t) => workspaceTabId(t) === tabId);
    return i >= 0 ? { paneId: node.id, index: i } : null;
  }
  for (const child of node.children) {
    const loc = findTabLocation(child, tabId);
    if (loc) return loc;
  }
  return null;
}

function findPane(
  node: WorkspaceLayoutNode,
  paneId: string
): WorkspacePane | null {
  if (node.type === 'pane') return node.id === paneId ? node : null;
  for (const child of node.children) {
    const found = findPane(child, paneId);
    if (found) return found;
  }
  return null;
}

export function listPanes(node: WorkspaceLayoutNode): WorkspacePane[] {
  if (node.type === 'pane') return [node];
  return node.children.flatMap(listPanes);
}

function mapPanes(
  node: WorkspaceLayoutNode,
  fn: (pane: WorkspacePane) => WorkspacePane
): WorkspaceLayoutNode {
  if (node.type === 'pane') return fn(node);
  return { ...node, children: node.children.map((c) => mapPanes(c, fn)) };
}

function pickActiveAfterRemoval(
  tabs: WorkspaceTab[],
  removedIndex: number,
  prevActive: WorkspaceTabId | null,
  removedTabId: WorkspaceTabId
): WorkspaceTabId | null {
  if (prevActive !== removedTabId) return prevActive;
  if (tabs.length === 0) return null;
  const neighbor =
    removedIndex >= tabs.length ? tabs[tabs.length - 1] : tabs[removedIndex];
  return neighbor ? workspaceTabId(neighbor) : null;
}

export function selectLayoutTab(
  layout: WorkspaceLayoutNode,
  paneId: string,
  tabId: WorkspaceTabId
): WorkspaceLayoutNode {
  return mapPanes(layout, (p) => {
    if (p.id !== paneId) return p;
    if (!p.tabs.some((t) => workspaceTabId(t) === tabId)) return p;
    return { ...p, activeTabId: tabId };
  });
}

export function closeLayoutTab(
  layout: WorkspaceLayoutNode,
  tabId: WorkspaceTabId
): WorkspaceLayoutNode {
  const next = mapPanes(layout, (p) => {
    const idx = p.tabs.findIndex((t) => workspaceTabId(t) === tabId);
    if (idx < 0) return p;
    const tabs = p.tabs.slice();
    tabs.splice(idx, 1);
    return {
      ...p,
      tabs,
      activeTabId: pickActiveAfterRemoval(tabs, idx, p.activeTabId, tabId),
    };
  });
  return pruneLayout(next);
}

export function moveTabToPane(
  layout: WorkspaceLayoutNode,
  tabId: WorkspaceTabId,
  targetPaneId: string,
  targetIndex?: number
): WorkspaceLayoutNode {
  const loc = findTabLocation(layout, tabId);
  if (!loc) return layout;
  const target = findPane(layout, targetPaneId);
  if (!target) return layout;

  const sourcePane = findPane(layout, loc.paneId);
  if (!sourcePane) return layout;
  const tabObj = sourcePane.tabs[loc.index];
  if (!tabObj) return layout;

  if (loc.paneId === targetPaneId) {
    const lastIndex = target.tabs.length - 1;
    let dest = targetIndex ?? lastIndex;
    dest = Math.max(0, Math.min(dest, lastIndex));
    if (dest === loc.index) return layout;
    const newTabs = target.tabs.slice();
    const [removed] = newTabs.splice(loc.index, 1);
    if (!removed) return layout;
    newTabs.splice(dest, 0, removed);
    return mapPanes(layout, (p) =>
      p.id === targetPaneId
        ? { ...p, tabs: newTabs, activeTabId: workspaceTabId(removed) }
        : p
    );
  }

  const next = mapPanes(layout, (p) => {
    if (p.id === loc.paneId) {
      const tabs = p.tabs.slice();
      tabs.splice(loc.index, 1);
      return {
        ...p,
        tabs,
        activeTabId: pickActiveAfterRemoval(
          tabs,
          loc.index,
          p.activeTabId,
          tabId
        ),
      };
    }
    if (p.id === targetPaneId) {
      const tabs = p.tabs.slice();
      let dest = targetIndex ?? tabs.length;
      dest = Math.max(0, Math.min(dest, tabs.length));
      tabs.splice(dest, 0, tabObj);
      return { ...p, tabs, activeTabId: workspaceTabId(tabObj) };
    }
    return p;
  });
  return pruneLayout(next);
}

export function splitPaneWithTab(
  layout: WorkspaceLayoutNode,
  targetPaneId: string,
  tabId: WorkspaceTabId,
  direction: SplitDirection,
  placement: SplitPlacement
): WorkspaceLayoutNode {
  const target = findPane(layout, targetPaneId);
  if (!target) return layout;
  const tabLoc = findTabLocation(layout, tabId);
  if (!tabLoc) return layout;
  const sourcePane = findPane(layout, tabLoc.paneId);
  if (!sourcePane) return layout;
  const tab = sourcePane.tabs[tabLoc.index];
  if (!tab) return layout;
  // Same-pane single-tab: no-op (would just create empty source and prune back).
  if (tabLoc.paneId === targetPaneId && target.tabs.length <= 1) return layout;

  const newPane = makePane([tab]);
  const sourcePaneIdLocal = tabLoc.paneId;
  const sourceIndex = tabLoc.index;
  const sameSourceAndTarget = sourcePaneIdLocal === targetPaneId;

  function replace(node: WorkspaceLayoutNode): WorkspaceLayoutNode {
    if (node.type === 'pane') {
      if (node.id === targetPaneId) {
        let tabs = node.tabs;
        let activeId = node.activeTabId;
        if (sameSourceAndTarget) {
          const idx = node.tabs.findIndex((t) => workspaceTabId(t) === tabId);
          tabs = node.tabs.slice();
          tabs.splice(idx, 1);
          activeId = pickActiveAfterRemoval(tabs, idx, node.activeTabId, tabId);
        }
        const targetWithoutTab: WorkspacePane = {
          ...node,
          tabs,
          activeTabId: activeId,
        };
        const children =
          placement === 'before'
            ? [newPane, targetWithoutTab]
            : [targetWithoutTab, newPane];
        return { type: 'split', id: freshSplitId(), direction, children };
      }
      if (!sameSourceAndTarget && node.id === sourcePaneIdLocal) {
        const tabs = node.tabs.slice();
        tabs.splice(sourceIndex, 1);
        return {
          ...node,
          tabs,
          activeTabId: pickActiveAfterRemoval(
            tabs,
            sourceIndex,
            node.activeTabId,
            tabId
          ),
        };
      }
      return node;
    }
    return { ...node, children: node.children.map(replace) };
  }
  return pruneLayout(replace(layout));
}

export function pruneLayout(layout: WorkspaceLayoutNode): WorkspaceLayoutNode {
  function visit(node: WorkspaceLayoutNode): WorkspaceLayoutNode | null {
    if (node.type === 'pane') return node;
    const kept: WorkspaceLayoutNode[] = [];
    for (const c of node.children) {
      const v = visit(c);
      if (!v) continue;
      if (v.type === 'pane' && v.tabs.length === 0) continue;
      kept.push(v);
    }
    if (kept.length === 0) return null;
    if (kept.length === 1) return kept[0] ?? null;
    if (kept.length === node.children.length) {
      const sameRefs = kept.every((c, i) => c === node.children[i]);
      if (sameRefs) return node;
    }
    return { ...node, children: kept };
  }
  const out = visit(layout);
  return out ?? layout;
}

export function addTabToPane(
  layout: WorkspaceLayoutNode,
  paneId: string,
  tab: WorkspaceTab,
  opts?: { activate?: boolean; index?: number }
): WorkspaceLayoutNode {
  const id = workspaceTabId(tab);
  if (!findPane(layout, paneId)) return layout;
  const existingLoc = findTabLocation(layout, id);
  if (existingLoc) {
    const moved = moveTabToPane(layout, id, paneId, opts?.index);
    return opts?.activate === false
      ? moved
      : selectLayoutTab(moved, paneId, id);
  }
  return mapPanes(layout, (p) => {
    if (p.id !== paneId) return p;
    const tabs = p.tabs.slice();
    let dest = opts?.index ?? tabs.length;
    dest = Math.max(0, Math.min(dest, tabs.length));
    tabs.splice(dest, 0, tab);
    return {
      ...p,
      tabs,
      activeTabId: opts?.activate === false ? p.activeTabId : id,
    };
  });
}

export function createDefaultWorkspaceLayout(
  tabs: WorkspaceTab[],
  activeTabId?: WorkspaceTabId | null
): WorkspacePane {
  return makePane(tabs, { activeTabId: activeTabId ?? null });
}
