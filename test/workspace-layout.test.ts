import { beforeEach, describe, expect, it } from 'vitest';
import {
  _resetIdCounters,
  addTabToPane,
  closeLayoutTab,
  createDefaultWorkspaceLayout,
  listPanes,
  makePane,
  moveTabToPane,
  pruneLayout,
  selectLayoutTab,
  splitPaneWithTab,
  workspaceTabId,
  type WorkspaceLayoutNode,
  type WorkspacePane,
  type WorkspaceSplit,
  type WorkspaceTab,
} from '../frontend/src/lib/workspace-layout.js';

const sessionTab = (id: string): WorkspaceTab => ({
  kind: 'session',
  sessionId: id,
  sessionType: 'terminal',
});

const nodeSessionTab = (id: string, nodeId: string): WorkspaceTab => ({
  kind: 'session',
  sessionId: id,
  sessionType: 'terminal',
  nodeId,
});

const fileTab = (
  path: string,
  type: 'code' | 'diff' | 'html' = 'code'
): WorkspaceTab => ({
  kind: 'file',
  filePath: path,
  tabType: type,
});

const tid = (t: WorkspaceTab) => workspaceTabId(t);

beforeEach(() => {
  _resetIdCounters();
});

describe('workspaceTabId', () => {
  it('encodes session tabs', () => {
    expect(tid(sessionTab('abc'))).toBe('session::abc');
  });

  it('encodes file tabs by tabType + path', () => {
    expect(tid(fileTab('a.ts', 'code'))).toBe('file::code::a.ts');
    expect(tid(fileTab('a.ts', 'diff'))).toBe('file::diff::a.ts');
  });

  it('disambiguates code and diff for same path', () => {
    expect(tid(fileTab('a.ts', 'code'))).not.toBe(tid(fileTab('a.ts', 'diff')));
  });
});

describe('session tab nodeId', () => {
  it('preserves nodeId through addTabToPane', () => {
    const tab = nodeSessionTab('s1', 'wsl');
    const layout = createDefaultWorkspaceLayout([]);
    const next = addTabToPane(layout, layout.id, tab);
    const panes = listPanes(next);
    const stored = panes[0]!.tabs.find((t) => tid(t) === tid(tab));
    expect(stored).toBeDefined();
    expect(stored && 'nodeId' in stored && stored.nodeId).toBe('wsl');
  });

  it('shares tabId across panes regardless of nodeId (sessionId is canonical key)', () => {
    const tab = nodeSessionTab('s1', 'wsl');
    expect(tid(tab)).toBe('session::s1');
  });

  it('moveTabToPane carries nodeId with the tab', () => {
    const tab = nodeSessionTab('s1', 'mac');
    const a = makePane([tab], { id: 'pa' });
    const b = makePane([], { id: 'pb' });
    const split: WorkspaceLayoutNode = {
      type: 'split',
      id: 'sp',
      direction: 'horizontal',
      children: [a, b],
    };
    const moved = moveTabToPane(split, tid(tab), 'pb');
    const target = listPanes(moved).find((p) => p.id === 'pb')!;
    const carried = target.tabs[0];
    expect(carried && 'nodeId' in carried && carried.nodeId).toBe('mac');
  });
});

describe('makePane / createDefaultWorkspaceLayout', () => {
  it('activates first tab when no activeTabId given', () => {
    const a = sessionTab('a');
    const b = fileTab('b.ts');
    const pane = makePane([a, b]);
    expect(pane.activeTabId).toBe(tid(a));
  });

  it('honors explicit activeTabId if present in tabs', () => {
    const a = sessionTab('a');
    const b = fileTab('b.ts');
    const pane = makePane([a, b], { activeTabId: tid(b) });
    expect(pane.activeTabId).toBe(tid(b));
  });

  it('falls back when activeTabId not in tab list', () => {
    const a = sessionTab('a');
    const pane = makePane([a], { activeTabId: 'session::ghost' });
    expect(pane.activeTabId).toBe(tid(a));
  });

  it('createDefaultWorkspaceLayout makes a single pane', () => {
    const layout = createDefaultWorkspaceLayout([
      sessionTab('a'),
      fileTab('b.ts'),
    ]);
    expect(layout.type).toBe('pane');
    expect(layout.tabs).toHaveLength(2);
  });
});

describe('selectLayoutTab', () => {
  it('switches active tab when target exists in pane', () => {
    const a = sessionTab('a');
    const b = fileTab('b.ts');
    const layout = makePane([a, b]);
    const next = selectLayoutTab(layout, layout.id, tid(b)) as WorkspacePane;
    expect(next.activeTabId).toBe(tid(b));
  });

  it('no-op when target tab missing', () => {
    const a = sessionTab('a');
    const layout = makePane([a]);
    const next = selectLayoutTab(
      layout,
      layout.id,
      'session::ghost'
    ) as WorkspacePane;
    expect(next.activeTabId).toBe(tid(a));
  });
});

describe('moveTabToPane', () => {
  it('reorders within same pane', () => {
    const a = sessionTab('a');
    const b = fileTab('b.ts');
    const c = fileTab('c.ts');
    const layout = makePane([a, b, c]);
    const next = moveTabToPane(layout, tid(a), layout.id, 2) as WorkspacePane;
    expect(next.tabs.map(tid)).toEqual([tid(b), tid(c), tid(a)]);
    expect(next.activeTabId).toBe(tid(a));
  });

  it('moves tab between panes and activates in target', () => {
    const a = sessionTab('a');
    const b = fileTab('b.ts');
    const c = fileTab('c.ts');
    const left = makePane([a, b], { id: 'L' });
    const right = makePane([c], { id: 'R' });
    const layout: WorkspaceSplit = {
      type: 'split',
      id: 's-test',
      direction: 'horizontal',
      children: [left, right],
    };
    const next = moveTabToPane(layout, tid(b), 'R') as WorkspaceSplit;
    const panes = listPanes(next);
    const lp = panes.find((p) => p.id === 'L')!;
    const rp = panes.find((p) => p.id === 'R')!;
    expect(lp.tabs.map(tid)).toEqual([tid(a)]);
    expect(rp.tabs.map(tid)).toEqual([tid(c), tid(b)]);
    expect(rp.activeTabId).toBe(tid(b));
  });

  it('clamps out-of-range targetIndex to end', () => {
    const a = sessionTab('a');
    const b = fileTab('b.ts');
    const layout = makePane([a, b]);
    const next = moveTabToPane(layout, tid(a), layout.id, 99) as WorkspacePane;
    expect(next.tabs.map(tid)).toEqual([tid(b), tid(a)]);
  });

  it('returns layout unchanged when tab missing', () => {
    const layout = makePane([sessionTab('a')]);
    const next = moveTabToPane(layout, 'session::ghost', layout.id);
    expect(next).toBe(layout);
  });

  it('returns layout unchanged when target pane missing', () => {
    const a = sessionTab('a');
    const layout = makePane([a]);
    const next = moveTabToPane(layout, tid(a), 'ghost-pane');
    expect(next).toBe(layout);
  });

  it('prunes empty source pane after cross-pane move', () => {
    const a = sessionTab('a');
    const b = fileTab('b.ts');
    const left = makePane([a], { id: 'L' });
    const right = makePane([b], { id: 'R' });
    const layout: WorkspaceSplit = {
      type: 'split',
      id: 's-test',
      direction: 'horizontal',
      children: [left, right],
    };
    const next = moveTabToPane(layout, tid(a), 'R');
    expect(next.type).toBe('pane');
    expect((next as WorkspacePane).id).toBe('R');
    expect((next as WorkspacePane).tabs.map(tid)).toEqual([tid(b), tid(a)]);
  });
});

describe('splitPaneWithTab', () => {
  it('creates horizontal split with new pane after source', () => {
    const a = sessionTab('a');
    const b = fileTab('b.ts');
    const layout = makePane([a, b], { id: 'L' });
    const next = splitPaneWithTab(layout, 'L', tid(b), 'horizontal', 'after');
    expect(next.type).toBe('split');
    const split = next as WorkspaceSplit;
    expect(split.direction).toBe('horizontal');
    expect(split.children).toHaveLength(2);
    expect(split.children[0].type).toBe('pane');
    expect((split.children[0] as WorkspacePane).id).toBe('L');
    expect((split.children[0] as WorkspacePane).tabs.map(tid)).toEqual([
      tid(a),
    ]);
    expect((split.children[1] as WorkspacePane).tabs.map(tid)).toEqual([
      tid(b),
    ]);
  });

  it('creates vertical split with new pane before source', () => {
    const a = sessionTab('a');
    const b = fileTab('b.ts');
    const layout = makePane([a, b], { id: 'L' });
    const next = splitPaneWithTab(layout, 'L', tid(a), 'vertical', 'before');
    const split = next as WorkspaceSplit;
    expect(split.direction).toBe('vertical');
    expect((split.children[0] as WorkspacePane).tabs.map(tid)).toEqual([
      tid(a),
    ]);
    expect((split.children[1] as WorkspacePane).id).toBe('L');
    expect((split.children[1] as WorkspacePane).tabs.map(tid)).toEqual([
      tid(b),
    ]);
  });

  it('no-ops when same-pane and pane has only one tab', () => {
    const a = sessionTab('a');
    const layout = makePane([a], { id: 'L' });
    const next = splitPaneWithTab(layout, 'L', tid(a), 'horizontal', 'after');
    expect(next).toBe(layout);
  });

  it('no-ops when target pane missing', () => {
    const layout = makePane([sessionTab('a'), fileTab('b.ts')]);
    const next = splitPaneWithTab(
      layout,
      'ghost',
      'session::a',
      'horizontal',
      'after'
    );
    expect(next).toBe(layout);
  });

  it('moves tab from foreign source pane into new split at target edge', () => {
    const a = sessionTab('a');
    const b = fileTab('b.ts');
    const c = fileTab('c.ts');
    const left = makePane([a, b], { id: 'L' });
    const right = makePane([c], { id: 'R' });
    const layout: WorkspaceSplit = {
      type: 'split',
      id: 's-foreign',
      direction: 'horizontal',
      children: [left, right],
    };
    // Drag tab `a` from L onto R's right edge.
    const next = splitPaneWithTab(layout, 'R', tid(a), 'horizontal', 'after');
    // L should still exist with [b]; R should be split [R, newPane(a)].
    const panes = listPanes(next);
    const L = panes.find((p) => p.id === 'L')!;
    const R = panes.find((p) => p.id === 'R')!;
    const newPane = panes.find((p) => p.id !== 'L' && p.id !== 'R')!;
    expect(L.tabs.map(tid)).toEqual([tid(b)]);
    expect(R.tabs.map(tid)).toEqual([tid(c)]);
    expect(newPane.tabs.map(tid)).toEqual([tid(a)]);
  });

  it('reselects neighbor in source when splitting active tab', () => {
    const a = sessionTab('a');
    const b = fileTab('b.ts');
    const layout = makePane([a, b], { id: 'L', activeTabId: tid(a) });
    const next = splitPaneWithTab(layout, 'L', tid(a), 'horizontal', 'after');
    const split = next as WorkspaceSplit;
    const source = split.children[0] as WorkspacePane;
    expect(source.activeTabId).toBe(tid(b));
  });
});

describe('closeLayoutTab', () => {
  it('selects neighbor when closing active tab', () => {
    const a = sessionTab('a');
    const b = fileTab('b.ts');
    const c = fileTab('c.ts');
    const layout = makePane([a, b, c], { activeTabId: tid(b) });
    const next = closeLayoutTab(layout, tid(b)) as WorkspacePane;
    expect(next.tabs.map(tid)).toEqual([tid(a), tid(c)]);
    expect(next.activeTabId).toBe(tid(c));
  });

  it('selects last when closing last active', () => {
    const a = sessionTab('a');
    const b = fileTab('b.ts');
    const layout = makePane([a, b], { activeTabId: tid(b) });
    const next = closeLayoutTab(layout, tid(b)) as WorkspacePane;
    expect(next.activeTabId).toBe(tid(a));
  });

  it('leaves activeTabId untouched when closing non-active tab', () => {
    const a = sessionTab('a');
    const b = fileTab('b.ts');
    const layout = makePane([a, b], { activeTabId: tid(a) });
    const next = closeLayoutTab(layout, tid(b)) as WorkspacePane;
    expect(next.activeTabId).toBe(tid(a));
  });

  it('keeps single empty pane as root', () => {
    const a = sessionTab('a');
    const layout = makePane([a]);
    const next = closeLayoutTab(layout, tid(a)) as WorkspacePane;
    expect(next.type).toBe('pane');
    expect(next.tabs).toEqual([]);
    expect(next.activeTabId).toBeNull();
  });

  it('prunes empty pane and collapses single-child split', () => {
    const a = sessionTab('a');
    const b = fileTab('b.ts');
    const left = makePane([a], { id: 'L' });
    const right = makePane([b], { id: 'R' });
    const layout: WorkspaceSplit = {
      type: 'split',
      id: 's-test',
      direction: 'horizontal',
      children: [left, right],
    };
    const next = closeLayoutTab(layout, tid(a));
    expect(next.type).toBe('pane');
    expect((next as WorkspacePane).id).toBe('R');
    expect((next as WorkspacePane).tabs.map(tid)).toEqual([tid(b)]);
  });
});

describe('pruneLayout', () => {
  it('drops empty panes from splits', () => {
    const a = sessionTab('a');
    const empty = makePane([], { id: 'E' });
    const filled = makePane([a], { id: 'F' });
    const split: WorkspaceSplit = {
      type: 'split',
      id: 's-1',
      direction: 'horizontal',
      children: [empty, filled],
    };
    const next = pruneLayout(split) as WorkspacePane;
    expect(next.type).toBe('pane');
    expect(next.id).toBe('F');
  });

  it('drops one of three empty panes and keeps remaining children', () => {
    const a = sessionTab('a');
    const b = fileTab('b.ts');
    const split: WorkspaceSplit = {
      type: 'split',
      id: 's-2',
      direction: 'horizontal',
      children: [
        makePane([], { id: 'E' }),
        makePane([a], { id: 'F1' }),
        makePane([b], { id: 'F2' }),
      ],
    };
    const next = pruneLayout(split) as WorkspaceSplit;
    expect(next.type).toBe('split');
    expect(next.children).toHaveLength(2);
    expect((next.children[0] as WorkspacePane).id).toBe('F1');
    expect((next.children[1] as WorkspacePane).id).toBe('F2');
  });

  it('returns same reference when no pruning needed', () => {
    const a = sessionTab('a');
    const b = fileTab('b.ts');
    const split: WorkspaceSplit = {
      type: 'split',
      id: 's-3',
      direction: 'vertical',
      children: [makePane([a]), makePane([b])],
    };
    const next = pruneLayout(split);
    expect(next).toBe(split);
  });
});

describe('addTabToPane', () => {
  it('appends tab and activates by default', () => {
    const a = sessionTab('a');
    const layout = makePane([a]);
    const b = fileTab('b.ts');
    const next = addTabToPane(layout, layout.id, b) as WorkspacePane;
    expect(next.tabs.map(tid)).toEqual([tid(a), tid(b)]);
    expect(next.activeTabId).toBe(tid(b));
  });

  it('moves existing tab from another pane on add', () => {
    const a = sessionTab('a');
    const b = fileTab('b.ts');
    const left = makePane([a, b], { id: 'L' });
    const right = makePane([fileTab('c.ts')], { id: 'R' });
    const layout: WorkspaceLayoutNode = {
      type: 'split',
      id: 's-add',
      direction: 'horizontal',
      children: [left, right],
    };
    const next = addTabToPane(layout, 'R', b) as WorkspaceSplit;
    const panes = listPanes(next);
    const lp = panes.find((p) => p.id === 'L')!;
    const rp = panes.find((p) => p.id === 'R')!;
    expect(lp.tabs.map(tid)).toEqual([tid(a)]);
    expect(rp.tabs.map(tid).includes(tid(b))).toBe(true);
    expect(rp.activeTabId).toBe(tid(b));
  });

  it('respects activate=false', () => {
    const a = sessionTab('a');
    const layout = makePane([a]);
    const b = fileTab('b.ts');
    const next = addTabToPane(layout, layout.id, b, {
      activate: false,
    }) as WorkspacePane;
    expect(next.activeTabId).toBe(tid(a));
  });

  it('returns layout unchanged when target pane missing', () => {
    const layout = makePane([sessionTab('a')]);
    const next = addTabToPane(layout, 'ghost', fileTab('b.ts'));
    expect(next).toBe(layout);
  });
});
