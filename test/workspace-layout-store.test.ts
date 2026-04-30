import { beforeEach, describe, expect, it } from 'vitest';
import {
  _resetPaneCounter,
  createDefaultWorkspaceLayout,
  workspaceTabId,
  type WorkspaceLayoutNode,
  type WorkspacePane,
  type WorkspaceSplit,
  type WorkspaceTab,
} from '../frontend/src/lib/workspace-layout.js';
import { useWorkspaceLayoutStore } from '../frontend/src/lib/stores/workspace-layout-store.js';

const sessionTab = (id: string): WorkspaceTab => ({
  kind: 'session',
  sessionId: id,
  sessionType: 'agent',
});

const fileTab = (path: string): WorkspaceTab => ({
  kind: 'file',
  filePath: path,
  tabType: 'code',
});

beforeEach(() => {
  _resetPaneCounter();
  const tabs: WorkspaceTab[] = [];
  const layout = createDefaultWorkspaceLayout(tabs);
  useWorkspaceLayoutStore.setState({
    layout,
    activePaneId: layout.id,
  });
});

describe('workspace-layout-store', () => {
  it('addTab adds tab to pane and activates by default', () => {
    const { setLayout, addTab } = useWorkspaceLayoutStore.getState();
    setLayout(createDefaultWorkspaceLayout([sessionTab('a')]));
    const paneId = (useWorkspaceLayoutStore.getState().layout as WorkspacePane)
      .id;
    addTab(paneId, fileTab('b.ts'));
    const layout = useWorkspaceLayoutStore.getState().layout as WorkspacePane;
    expect(layout.tabs).toHaveLength(2);
    expect(layout.activeTabId).toBe(workspaceTabId(fileTab('b.ts')));
    expect(useWorkspaceLayoutStore.getState().activePaneId).toBe(paneId);
  });

  it('selectTab switches active tab and activePaneId', () => {
    const { setLayout, selectTab } = useWorkspaceLayoutStore.getState();
    const a = sessionTab('a');
    const b = fileTab('b.ts');
    setLayout(createDefaultWorkspaceLayout([a, b]));
    const paneId = (useWorkspaceLayoutStore.getState().layout as WorkspacePane)
      .id;
    selectTab(paneId, workspaceTabId(b));
    const layout = useWorkspaceLayoutStore.getState().layout as WorkspacePane;
    expect(layout.activeTabId).toBe(workspaceTabId(b));
    expect(useWorkspaceLayoutStore.getState().activePaneId).toBe(paneId);
  });

  it('splitWithTab promotes pane to split and updates activePaneId to remain valid', () => {
    const { setLayout, splitWithTab } = useWorkspaceLayoutStore.getState();
    const a = sessionTab('a');
    const b = fileTab('b.ts');
    setLayout(createDefaultWorkspaceLayout([a, b]));
    const initialPaneId = (
      useWorkspaceLayoutStore.getState().layout as WorkspacePane
    ).id;
    splitWithTab(initialPaneId, workspaceTabId(b), 'horizontal', 'after');
    const layout = useWorkspaceLayoutStore.getState().layout;
    expect(layout.type).toBe('split');
    const split = layout as WorkspaceSplit;
    expect(split.children).toHaveLength(2);
    const activePaneId = useWorkspaceLayoutStore.getState().activePaneId;
    const allPaneIds = (split.children as WorkspaceLayoutNode[])
      .filter((c): c is WorkspacePane => c.type === 'pane')
      .map((p) => p.id);
    expect(allPaneIds.includes(activePaneId ?? '')).toBe(true);
  });

  it('moveTab transfers tab and updates activePaneId to target', () => {
    const { setLayout, splitWithTab, moveTab } =
      useWorkspaceLayoutStore.getState();
    const a = sessionTab('a');
    const b = fileTab('b.ts');
    setLayout(createDefaultWorkspaceLayout([a, b]));
    const initialPaneId = (
      useWorkspaceLayoutStore.getState().layout as WorkspacePane
    ).id;
    splitWithTab(initialPaneId, workspaceTabId(b), 'horizontal', 'after');
    const layout = useWorkspaceLayoutStore.getState().layout as WorkspaceSplit;
    const left = layout.children[0] as WorkspacePane;
    const right = layout.children[1] as WorkspacePane;
    moveTab(workspaceTabId(a), right.id);
    const after = useWorkspaceLayoutStore.getState().layout;
    expect(after.type).toBe('pane');
    expect((after as WorkspacePane).id).toBe(right.id);
    expect((after as WorkspacePane).tabs).toHaveLength(2);
    expect(useWorkspaceLayoutStore.getState().activePaneId).toBe(right.id);
    void left;
  });

  it('closeTab prunes empty pane and reselects activePaneId', () => {
    const { setLayout, splitWithTab, closeTab } =
      useWorkspaceLayoutStore.getState();
    const a = sessionTab('a');
    const b = fileTab('b.ts');
    setLayout(createDefaultWorkspaceLayout([a, b]));
    const initialPaneId = (
      useWorkspaceLayoutStore.getState().layout as WorkspacePane
    ).id;
    splitWithTab(initialPaneId, workspaceTabId(b), 'horizontal', 'after');
    closeTab(workspaceTabId(b));
    const after = useWorkspaceLayoutStore.getState().layout;
    expect(after.type).toBe('pane');
    expect((after as WorkspacePane).tabs).toHaveLength(1);
    const activePaneId = useWorkspaceLayoutStore.getState().activePaneId;
    expect(activePaneId).toBe((after as WorkspacePane).id);
  });

  it('setSplitSizes records sizes in sidecar keyed by splitId', () => {
    const { setLayout, splitWithTab, setSplitSizes } =
      useWorkspaceLayoutStore.getState();
    const a = sessionTab('a');
    const b = fileTab('b.ts');
    setLayout(createDefaultWorkspaceLayout([a, b]));
    const initialPaneId = (
      useWorkspaceLayoutStore.getState().layout as WorkspacePane
    ).id;
    splitWithTab(initialPaneId, workspaceTabId(b), 'horizontal', 'after');
    const split = useWorkspaceLayoutStore.getState().layout as WorkspaceSplit;
    setSplitSizes(split.id, [70, 30]);
    expect(useWorkspaceLayoutStore.getState().splitSizes[split.id]).toEqual([
      70, 30,
    ]);
  });

  it('GCs splitSizes entries when split is removed', () => {
    const { setLayout, splitWithTab, setSplitSizes, closeTab } =
      useWorkspaceLayoutStore.getState();
    const a = sessionTab('a');
    const b = fileTab('b.ts');
    setLayout(createDefaultWorkspaceLayout([a, b]));
    const initialPaneId = (
      useWorkspaceLayoutStore.getState().layout as WorkspacePane
    ).id;
    splitWithTab(initialPaneId, workspaceTabId(b), 'horizontal', 'after');
    const split = useWorkspaceLayoutStore.getState().layout as WorkspaceSplit;
    setSplitSizes(split.id, [70, 30]);
    closeTab(workspaceTabId(b));
    expect(useWorkspaceLayoutStore.getState().layout.type).toBe('pane');
    expect(
      useWorkspaceLayoutStore.getState().splitSizes[split.id]
    ).toBeUndefined();
  });
});
