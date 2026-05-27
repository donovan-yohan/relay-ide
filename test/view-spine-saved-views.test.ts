// #738: saved/named Views + pins/favorites + lens persistence.
// Covers the PURE logic (`applyPins`, `applyPinsToGrouped`, `savedViewLens`) and
// the localStorage load/normalize/fail-soft helpers in the ui store. No DOM
// beyond a tiny in-memory localStorage shim.

import { beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_LOCAL_NODE_ID } from '../shared/identity.js';
import { createInstanceId, createProjectId } from '../shared/project.js';
import { createBenchId } from '../shared/bench.js';
import {
  applyLens,
  applyPins,
  applyPinsToGrouped,
  buildViewTree,
  groupProjectsByWorkspace,
  savedViewLens,
  type BuildViewTreeInput,
  type SavedView,
  type ViewTree,
} from '../frontend/src/lib/state/view-tree.js';
import type {
  Repo,
  SessionSummary,
  WorktreeInfo,
} from '../frontend/src/lib/types.js';

// ── in-memory localStorage shim (must be installed BEFORE importing the store) ──
const storage: Record<string, string> = {};
Object.defineProperty(globalThis, 'localStorage', {
  value: {
    getItem: (key: string) => storage[key] ?? null,
    setItem: (key: string, value: string) => {
      storage[key] = value;
    },
    removeItem: (key: string) => {
      delete storage[key];
    },
  },
  configurable: true,
});

// Imported after the shim so module-load-time reads see the shim.
const {
  loadViewSpineLens,
  loadViewSpinePins,
  loadViewSpineSavedViews,
} = await import('../frontend/src/lib/stores/ui.js');

// ── builders (mirror test/view-tree.test.ts) ───────────────────────────────────
function repo(overrides: Partial<Repo> = {}): Repo {
  return {
    path: '/repos/relay',
    name: 'relay',
    isGitRepo: true,
    defaultBranch: 'main',
    currentBranch: 'main',
    repoIdentity: 'github.com/donovan-yohan/relay-ide',
    nodeId: DEFAULT_LOCAL_NODE_ID,
    ...overrides,
  };
}

function worktree(overrides: Partial<WorktreeInfo> = {}): WorktreeInfo {
  return {
    path: '/repos/relay/wt-a',
    repoPath: '/repos/relay',
    branchName: 'feat/a',
    nodeId: DEFAULT_LOCAL_NODE_ID,
    ...overrides,
  } as WorktreeInfo;
}

function build(partial: Partial<BuildViewTreeInput> = {}): ViewTree {
  return buildViewTree({
    repos: [],
    worktrees: [],
    sessions: [],
    workspaceGroups: [],
    nodes: [],
    ...partial,
  });
}

// Stable ids for the canonical relay project (matches buildViewTree's minting).
const RELAY_PROJECT_ID = createProjectId({
  kind: 'repo',
  remote: 'github.com/donovan-yohan/relay-ide',
});
const RELAY_INSTANCE_ID = createInstanceId(RELAY_PROJECT_ID, DEFAULT_LOCAL_NODE_ID);

describe('#738 applyPins — pinned items float to top of their parent', () => {
  it('is identity for an empty pin set (same object reference)', () => {
    const tree = build({
      repos: [
        repo({ path: '/repos/a', name: 'a', repoIdentity: 'r/a' }),
        repo({ path: '/repos/b', name: 'b', repoIdentity: 'r/b' }),
      ],
    });
    expect(applyPins(tree, new Set())).toBe(tree);
  });

  it('floats a pinned ungrouped project to the front, keeping the rest stable', () => {
    const tree = build({
      repos: [
        repo({ path: '/repos/a', name: 'a', repoIdentity: 'r/a' }),
        repo({ path: '/repos/b', name: 'b', repoIdentity: 'r/b' }),
        repo({ path: '/repos/c', name: 'c', repoIdentity: 'r/c' }),
      ],
    });
    // Ungrouped projects sort by label: a, b, c.
    expect(tree.ungroupedProjects.map((p) => p.label)).toEqual(['a', 'b', 'c']);
    const cId = createProjectId({ kind: 'repo', remote: 'r/c' });
    const pinned = applyPins(tree, new Set([cId]));
    // c floats to front; a, b keep their relative order.
    expect(pinned.ungroupedProjects.map((p) => p.label)).toEqual(['c', 'a', 'b']);
  });

  it('floats pinned benches to the top within their instance, preserving order', () => {
    const tree = build({
      repos: [repo()],
      worktrees: [
        worktree({ path: '/repos/relay/wt-a', branchName: 'a' }),
        worktree({ path: '/repos/relay/wt-b', branchName: 'b' }),
        worktree({ path: '/repos/relay/wt-c', branchName: 'c' }),
      ],
    });
    const inst = tree.ungroupedProjects[0]!.instances[0]!;
    // Benches sort by path: wt-a, wt-b, wt-c.
    expect(inst.benches.map((b) => b.path)).toEqual([
      '/repos/relay/wt-a',
      '/repos/relay/wt-b',
      '/repos/relay/wt-c',
    ]);
    const benchCId = createBenchId(RELAY_INSTANCE_ID, '/repos/relay/wt-c');
    const pinned = applyPins(tree, new Set([benchCId]));
    const pinnedInst = pinned.ungroupedProjects[0]!.instances[0]!;
    expect(pinnedInst.benches.map((b) => b.path)).toEqual([
      '/repos/relay/wt-c',
      '/repos/relay/wt-a',
      '/repos/relay/wt-b',
    ]);
  });

  it('does not mutate the input tree', () => {
    const tree = build({
      repos: [
        repo({ path: '/repos/a', name: 'a', repoIdentity: 'r/a' }),
        repo({ path: '/repos/b', name: 'b', repoIdentity: 'r/b' }),
      ],
    });
    const before = tree.ungroupedProjects.map((p) => p.label);
    const bId = createProjectId({ kind: 'repo', remote: 'r/b' });
    applyPins(tree, new Set([bId]));
    expect(tree.ungroupedProjects.map((p) => p.label)).toEqual(before);
  });

  it('pin survives the recent lens (lens runs first, pin re-ranks after)', () => {
    // Two projects with different recency; the older one is pinned.
    const tree = build({
      repos: [
        repo({ path: '/repos/a', name: 'a', repoIdentity: 'r/a' }),
        repo({ path: '/repos/b', name: 'b', repoIdentity: 'r/b' }),
      ],
      sessions: [
        { ...session({ id: 's-a', cwd: '/repos/a', repoPath: '/repos/a' }), lastActivity: '2026-05-01T00:00:00.000Z' },
        { ...session({ id: 's-b', cwd: '/repos/b', repoPath: '/repos/b' }), lastActivity: '2026-05-27T00:00:00.000Z' },
      ],
    });
    // recent lens: b (newer) before a.
    const lensed = applyLens(tree, 'recent');
    expect(lensed.ungroupedProjects.map((p) => p.label)).toEqual(['b', 'a']);
    // Pin a → a floats above b despite older recency.
    const aId = createProjectId({ kind: 'repo', remote: 'r/a' });
    const pinned = applyPins(lensed, new Set([aId]));
    expect(pinned.ungroupedProjects.map((p) => p.label)).toEqual(['a', 'b']);
  });
});

function session(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: 's1',
    type: 'agent',
    agent: 'claude',
    cwd: '/repos/relay',
    displayName: 'relay',
    createdAt: '2026-05-27T00:00:00.000Z',
    lastActivity: '2026-05-27T00:00:00.000Z',
    idle: true,
    nodeId: DEFAULT_LOCAL_NODE_ID,
    ...overrides,
  } as SessionSummary;
}

describe('#738 applyPinsToGrouped — re-rank after persisted grouping', () => {
  it('floats a pinned workspace group to the top', () => {
    const tree = build({
      repos: [
        repo({ path: '/repos/a', name: 'a', repoIdentity: 'r/a' }),
        repo({ path: '/repos/b', name: 'b', repoIdentity: 'r/b' }),
      ],
    });
    const aId = createProjectId({ kind: 'repo', remote: 'r/a' });
    const bId = createProjectId({ kind: 'repo', remote: 'r/b' });
    const grouped = groupProjectsByWorkspace(tree.ungroupedProjects, [
      { id: 'ws:one', name: 'one', order: 0, projectIds: [aId] },
      { id: 'ws:two', name: 'two', order: 1, projectIds: [bId] },
    ]);
    expect(grouped.workspaces.map((w) => w.name)).toEqual(['one', 'two']);
    // Pin the second workspace → it floats to the front.
    const reranked = applyPinsToGrouped(grouped, new Set(['ws:two']));
    expect(reranked.workspaces.map((w) => w.name)).toEqual(['two', 'one']);
  });

  it('floats a pinned project to the top within its workspace group', () => {
    const tree = build({
      repos: [
        repo({ path: '/repos/a', name: 'a', repoIdentity: 'r/a' }),
        repo({ path: '/repos/b', name: 'b', repoIdentity: 'r/b' }),
      ],
    });
    const aId = createProjectId({ kind: 'repo', remote: 'r/a' });
    const bId = createProjectId({ kind: 'repo', remote: 'r/b' });
    const grouped = groupProjectsByWorkspace(tree.ungroupedProjects, [
      { id: 'ws:one', name: 'one', order: 0, projectIds: [aId, bId] },
    ]);
    expect(grouped.workspaces[0]!.projects.map((p) => p.label)).toEqual(['a', 'b']);
    const reranked = applyPinsToGrouped(grouped, new Set([bId]));
    expect(reranked.workspaces[0]!.projects.map((p) => p.label)).toEqual(['b', 'a']);
  });

  it('is identity for an empty pin set', () => {
    const grouped = groupProjectsByWorkspace([], []);
    expect(applyPinsToGrouped(grouped, new Set())).toBe(grouped);
  });
});

describe('#738 savedViewLens — restores a saved View lens', () => {
  const views: SavedView[] = [
    { id: 'v1', name: 'My Host', lens: 'this-host' },
    { id: 'v2', name: 'All', lens: 'all' },
  ];

  it('returns the lens of a matching saved View', () => {
    expect(savedViewLens(views, 'v1')).toBe('this-host');
    expect(savedViewLens(views, 'v2')).toBe('all');
  });

  it('returns null for an unknown id (deleted / corrupt reference)', () => {
    expect(savedViewLens(views, 'nope')).toBeNull();
    expect(savedViewLens([], 'v1')).toBeNull();
  });
});

// Keys must match ui.ts. Re-declared here to keep the test independent of the
// store's private constants.
const LENS_KEY = 'relay-view-spine-lens';
const PINS_KEY = 'relay-view-spine-pins';
const SAVED_KEY = 'relay-view-spine-saved-views';

describe('#738 localStorage load/save round-trip + fail-soft', () => {
  beforeEach(() => {
    for (const key of Object.keys(storage)) delete storage[key];
  });

  it('lens: default recent when missing; round-trips a valid value', () => {
    expect(loadViewSpineLens()).toBe('recent');
    storage[LENS_KEY] = 'this-host';
    expect(loadViewSpineLens()).toBe('this-host');
  });

  it('lens: unknown / corrupt value falls back to default', () => {
    storage[LENS_KEY] = 'bogus';
    expect(loadViewSpineLens()).toBe('recent');
    storage[LENS_KEY] = '{not json';
    expect(loadViewSpineLens()).toBe('recent');
  });

  it('pins: empty when missing; round-trips a JSON array', () => {
    expect(loadViewSpinePins()).toEqual(new Set());
    storage[PINS_KEY] = JSON.stringify(['p:a', 'b:x', 'ws:one']);
    expect(loadViewSpinePins()).toEqual(new Set(['p:a', 'b:x', 'ws:one']));
  });

  it('pins: corrupt / non-array / non-string entries fail soft', () => {
    storage[PINS_KEY] = '{not json';
    expect(loadViewSpinePins()).toEqual(new Set());
    storage[PINS_KEY] = JSON.stringify({ not: 'an array' });
    expect(loadViewSpinePins()).toEqual(new Set());
    storage[PINS_KEY] = JSON.stringify(['ok', 42, null, '', 'ok2']);
    expect(loadViewSpinePins()).toEqual(new Set(['ok', 'ok2']));
  });

  it('saved views: empty when missing; round-trips well-formed entries', () => {
    expect(loadViewSpineSavedViews()).toEqual([]);
    const views: SavedView[] = [
      { id: 'v1', name: 'Mine', lens: 'this-host' },
      { id: 'v2', name: 'Everything', lens: 'all' },
    ];
    storage[SAVED_KEY] = JSON.stringify(views);
    expect(loadViewSpineSavedViews()).toEqual(views);
  });

  it('saved views: drops malformed entries, de-dupes by id, fails soft on garbage', () => {
    storage[SAVED_KEY] = '{not json';
    expect(loadViewSpineSavedViews()).toEqual([]);

    storage[SAVED_KEY] = JSON.stringify([
      { id: 'v1', name: 'Good', lens: 'recent' },
      { id: '', name: 'no id', lens: 'all' }, // dropped: blank id
      { id: 'v2', name: '', lens: 'all' }, // dropped: blank name
      { id: 'v3', name: 'Bad lens', lens: 'nope' }, // dropped: bad lens
      { id: 'v1', name: 'Dup', lens: 'all' }, // dropped: dup id
      'not an object', // dropped
    ]);
    expect(loadViewSpineSavedViews()).toEqual([
      { id: 'v1', name: 'Good', lens: 'recent' },
    ]);
  });
});
