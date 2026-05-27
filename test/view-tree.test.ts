import { describe, expect, it } from 'vitest';

import { DEFAULT_LOCAL_NODE_ID } from '../shared/identity.js';
import { parseInstanceId, parseProjectId } from '../shared/project.js';
import {
  applyLens,
  benchCreatePayload,
  buildViewTree,
  DEFAULT_VIEW_LENS,
  type BuildViewTreeInput,
  type ViewTreeNodeStatus,
} from '../frontend/src/lib/state/view-tree.js';
import type {
  Repo,
  SessionSummary,
  Workspace,
  WorktreeInfo,
} from '../frontend/src/lib/types.js';

// ── Builders ────────────────────────────────────────────────────────────────

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
  };
}

function node(overrides: Partial<ViewTreeNodeStatus> = {}): ViewTreeNodeStatus {
  return {
    nodeId: 'macbook',
    displayName: 'MacBook',
    status: 'online',
    ...overrides,
  };
}

function build(partial: Partial<BuildViewTreeInput> = {}) {
  return buildViewTree({
    repos: [],
    worktrees: [],
    sessions: [],
    workspaceGroups: [],
    nodes: [],
    ...partial,
  });
}

function allProjects(tree: ReturnType<typeof buildViewTree>) {
  return [
    ...tree.workspaces.flatMap((ws) => ws.projects),
    ...tree.ungroupedProjects,
  ];
}

// ── C1: dedup matrix ──────────────────────────────────────────────────────────

describe('C1 dedup matrix', () => {
  it('(a) null repoIdentity falls back to a directory project keyed on node+path', () => {
    const tree = build({
      repos: [
        repo({
          path: '/dirs/scratch',
          name: 'scratch',
          isGitRepo: false,
          kind: 'directory',
          repoIdentity: null,
        }),
      ],
    });
    const projects = allProjects(tree);
    expect(projects).toHaveLength(1);
    const project = projects[0]!;
    expect(project.kind).toBe('directory');
    const identity = parseProjectId(project.id);
    expect(identity).toEqual({
      kind: 'directory',
      nodeId: DEFAULT_LOCAL_NODE_ID,
      localPath: '/dirs/scratch',
    });
    // Directory projects never carry a git remote.
    expect(project.identity.kind).toBe('directory');
  });

  it('(a) blank repoIdentity on a git repo also falls back to directory project', () => {
    const tree = build({
      repos: [repo({ repoIdentity: '   ' })],
    });
    const projects = allProjects(tree);
    expect(projects).toHaveLength(1);
    expect(projects[0]!.kind).toBe('directory');
  });

  it('(b) same repo remote on two nodes = ONE project, TWO instances', () => {
    const remote = 'github.com/donovan-yohan/relay-ide';
    const tree = build({
      repos: [
        repo({
          path: '/local/relay',
          repoIdentity: remote,
          nodeId: DEFAULT_LOCAL_NODE_ID,
        }),
        repo({
          path: '/remote/relay',
          repoIdentity: remote,
          nodeId: 'macbook',
        }),
      ],
      nodes: [node({ nodeId: 'macbook', status: 'online' })],
    });
    const projects = allProjects(tree);
    expect(projects).toHaveLength(1);
    const project = projects[0]!;
    expect(project.kind).toBe('repo');
    expect(project.instances).toHaveLength(2);

    const hosts = project.instances.map((i) => i.nodeId).sort();
    expect(hosts).toEqual(['macbook', DEFAULT_LOCAL_NODE_ID].sort());

    // Instance ids reference the SAME project id, differ only by host.
    for (const instance of project.instances) {
      const parsed = parseInstanceId(instance.id);
      expect(parsed?.projectId).toBe(project.id);
    }

    // Local instance labels as `this host`; remote as the node displayName.
    const local = project.instances.find((i) => i.isLocal)!;
    const remoteInst = project.instances.find((i) => !i.isLocal)!;
    expect(local.hostLabel).toBe('this host');
    expect(remoteInst.hostLabel).toBe('MacBook');
  });

  it('(c) offline-node join surfaces an offline instance status', () => {
    const remote = 'github.com/donovan-yohan/relay-ide';
    const tree = build({
      repos: [repo({ path: '/remote/relay', repoIdentity: remote, nodeId: 'macbook' })],
      nodes: [node({ nodeId: 'macbook', status: 'offline' })],
    });
    const project = allProjects(tree)[0]!;
    const instance = project.instances[0]!;
    expect(instance.nodeId).toBe('macbook');
    expect(instance.status).toBe('offline');
  });

  it('(c) stale-node join surfaces a stale instance status', () => {
    const remote = 'github.com/donovan-yohan/relay-ide';
    const tree = build({
      repos: [repo({ path: '/remote/relay', repoIdentity: remote, nodeId: 'macbook' })],
      nodes: [node({ nodeId: 'macbook', status: 'stale' })],
    });
    expect(allProjects(tree)[0]!.instances[0]!.status).toBe('stale');
  });

  it('(c) a remote node absent from /nodes joins as offline', () => {
    const remote = 'github.com/donovan-yohan/relay-ide';
    const tree = build({
      repos: [repo({ path: '/remote/relay', repoIdentity: remote, nodeId: 'ghost' })],
      nodes: [],
    });
    expect(allProjects(tree)[0]!.instances[0]!.status).toBe('offline');
  });

  it('local host is online even when absent from /nodes', () => {
    const tree = build({ repos: [repo()], nodes: [] });
    expect(allProjects(tree)[0]!.instances[0]!.status).toBe('online');
  });
});

// ── C2: free-lane leak regression ─────────────────────────────────────────────

describe('C2 free-lane leak regression', () => {
  it('a repoPath-less session lands in the free lane with NO branch/repo identity', () => {
    const tree = build({
      sessions: [
        session({
          id: 'free-1',
          // No repoPath. A malicious-ish summary still carrying branch/repoName
          // must NOT leak those into the free entry.
          branchName: 'feature/should-not-leak',
          repoName: 'should-not-leak',
          cwd: '/tmp/scratch',
        }),
      ],
    });
    expect(allProjects(tree)).toHaveLength(0);
    expect(tree.freeLane).toHaveLength(1);
    const entry = tree.freeLane[0]!;

    // Structural guarantee: the free entry shape carries no branch/repo fields.
    expect(entry).not.toHaveProperty('branch');
    expect(entry).not.toHaveProperty('branchName');
    expect(entry).not.toHaveProperty('repoName');
    expect(entry).not.toHaveProperty('repoIdentity');
    // And no field VALUE equals the leaked branch/repo strings.
    const serialized = JSON.stringify(entry);
    expect(serialized).not.toContain('should-not-leak');

    expect(entry.cwd).toBe('/tmp/scratch');
    expect(entry.label).toBe('scratch');
    expect(entry.tab.count).toBe(1);
  });

  it('multiple free sessions on the same (node, cwd) collapse into one counted entry', () => {
    const tree = build({
      sessions: [
        session({ id: 'a', cwd: '/tmp/work', branchName: 'x' }),
        session({ id: 'b', cwd: '/tmp/work', branchName: 'y' }),
      ],
    });
    expect(tree.freeLane).toHaveLength(1);
    expect(tree.freeLane[0]!.tab.count).toBe(2);
  });

  it('free sessions never appear nested under a repo project', () => {
    const tree = build({
      repos: [repo()],
      sessions: [
        session({ id: 'anchored', repoPath: '/repos/relay', cwd: '/repos/relay' }),
        session({ id: 'free', cwd: '/tmp/elsewhere' }),
      ],
    });
    expect(tree.freeLane).toHaveLength(1);
    expect(tree.freeLane[0]!.cwd).toBe('/tmp/elsewhere');
    // The anchored session bumps the project instance root tab; the free one
    // stays in its own lane.
    const project = allProjects(tree)[0]!;
    expect(project.instances[0]!.rootTab.count).toBe(1);
  });
});

// ── Bench/worktree + workspace grouping coverage ──────────────────────────────

describe('benches and grouping', () => {
  it('maps worktrees to benches with branch on git projects', () => {
    const worktree: WorktreeInfo = {
      name: 'feat-x',
      path: '/repos/relay/.worktrees/feat-x',
      repoName: 'relay',
      repoPath: '/repos/relay',
      displayName: 'feat-x',
      lastActivity: '2026-05-27T00:00:00.000Z',
      branchName: 'feature/x',
      nodeId: DEFAULT_LOCAL_NODE_ID,
    };
    const tree = build({ repos: [repo()], worktrees: [worktree] });
    const instance = allProjects(tree)[0]!.instances[0]!;
    expect(instance.benches).toHaveLength(1);
    const bench = instance.benches[0]!;
    expect(bench.path).toBe('/repos/relay/.worktrees/feat-x');
    expect(bench.isGit).toBe(true);
    expect(bench.branch).toBe('feature/x');
    // #731: a git bench carries its configured PARENT repo path (the worktree's
    // `repoPath`), which the backend validates against `config.repos`.
    expect(bench.repoPath).toBe('/repos/relay');
  });

  it('directory-project benches omit branch entirely', () => {
    const dir = repo({
      path: '/dirs/scratch',
      name: 'scratch',
      isGitRepo: false,
      kind: 'directory',
      repoIdentity: null,
    });
    const tree = build({
      repos: [dir],
      sessions: [
        session({
          id: 'w',
          repoPath: '/dirs/scratch',
          worktreePath: '/dirs/scratch/sub',
          branchName: 'leak',
          cwd: '/dirs/scratch/sub',
        }),
      ],
    });
    const bench = allProjects(tree)[0]!.instances[0]!.benches[0]!;
    expect(bench.isGit).toBe(false);
    expect(bench.branch).toBeNull();
    // #731: a non-git/directory bench carries NO repo anchor — there is no
    // `config.repos`-validated path to start an agent session against.
    expect(bench.repoPath).toBeNull();
  });

  it('places workspace-group repos under their group and leaves others ungrouped', () => {
    const grouped = repo({
      path: '/repos/grouped',
      name: 'grouped',
      repoIdentity: 'github.com/acme/grouped',
    });
    const loose = repo({
      path: '/repos/loose',
      name: 'loose',
      repoIdentity: 'github.com/acme/loose',
    });
    const ws: Workspace = {
      id: 'ws-1',
      name: 'My Workspace',
      repos: ['/repos/grouped'],
      order: 0,
    };
    const tree = build({ repos: [grouped, loose], workspaceGroups: [ws] });
    expect(tree.workspaces).toHaveLength(1);
    expect(tree.workspaces[0]!.projects.map((p) => p.label)).toEqual(['grouped']);
    expect(tree.ungroupedProjects.map((p) => p.label)).toEqual(['loose']);
  });
});

// ── S2: Views lenses (#727) ───────────────────────────────────────────────────

describe('S2 Views lenses', () => {
  // Three distinct git remotes → three ungrouped projects, each with a single
  // local session whose lastActivity is staggered so recency order is testable.
  function recencyFixture() {
    const mk = (name: string, when: string) => ({
      repo: repo({
        path: `/repos/${name}`,
        name,
        repoIdentity: `github.com/acme/${name}`,
      }),
      session: session({
        id: `s-${name}`,
        repoPath: `/repos/${name}`,
        cwd: `/repos/${name}`,
        lastActivity: when,
      }),
    });
    const alpha = mk('alpha', '2026-05-20T00:00:00.000Z'); // oldest
    const bravo = mk('bravo', '2026-05-27T12:00:00.000Z'); // newest
    const charlie = mk('charlie', '2026-05-25T00:00:00.000Z'); // middle
    return build({
      repos: [alpha.repo, bravo.repo, charlie.repo],
      sessions: [alpha.session, bravo.session, charlie.session],
    });
  }

  it('default lens is recent', () => {
    expect(DEFAULT_VIEW_LENS).toBe('recent');
  });

  it('All lens is identity (same object reference, unchanged)', () => {
    const tree = recencyFixture();
    expect(applyLens(tree, 'all')).toBe(tree);
  });

  it('Recent sorts ungrouped projects by most-recent activity first', () => {
    const tree = recencyFixture();
    const recent = applyLens(tree, 'recent');
    expect(recent.ungroupedProjects.map((p) => p.label)).toEqual([
      'bravo', // newest
      'charlie',
      'alpha', // oldest
    ]);
    // Pure: input tree untouched (still alphabetical from the build).
    expect(tree.ungroupedProjects.map((p) => p.label)).toEqual([
      'alpha',
      'bravo',
      'charlie',
    ]);
  });

  it('Recent sorts a project\'s benches by activity, newest first', () => {
    const old: WorktreeInfo = {
      name: 'old',
      path: '/repos/relay/.worktrees/old',
      repoName: 'relay',
      repoPath: '/repos/relay',
      displayName: 'old',
      lastActivity: '2026-05-20T00:00:00.000Z',
      branchName: 'feature/old',
      nodeId: DEFAULT_LOCAL_NODE_ID,
    };
    const fresh: WorktreeInfo = {
      ...old,
      name: 'fresh',
      path: '/repos/relay/.worktrees/fresh',
      displayName: 'fresh',
      lastActivity: '2026-05-27T00:00:00.000Z',
      branchName: 'feature/fresh',
    };
    const tree = build({ repos: [repo()], worktrees: [old, fresh] });
    const recent = applyLens(tree, 'recent');
    const benches = recent.ungroupedProjects[0]!.instances[0]!.benches;
    expect(benches.map((b) => b.label)).toEqual(['fresh', 'old']);
  });

  it('Recent is stable for equal/unknown recency (preserves build order)', () => {
    // Two projects, no sessions → both have null recency; build order is
    // alphabetical and must be preserved by the stable sort.
    const tree = build({
      repos: [
        repo({ path: '/repos/aaa', name: 'aaa', repoIdentity: 'github.com/acme/aaa' }),
        repo({ path: '/repos/bbb', name: 'bbb', repoIdentity: 'github.com/acme/bbb' }),
      ],
    });
    const recent = applyLens(tree, 'recent');
    expect(recent.ungroupedProjects.map((p) => p.label)).toEqual(['aaa', 'bbb']);
  });

  it('Recent sorts the free lane by activity, newest first', () => {
    const tree = build({
      sessions: [
        session({ id: 'f-old', cwd: '/tmp/old', lastActivity: '2026-05-20T00:00:00.000Z' }),
        session({ id: 'f-new', cwd: '/tmp/new', lastActivity: '2026-05-27T00:00:00.000Z' }),
      ],
    });
    const recent = applyLens(tree, 'recent');
    expect(recent.freeLane.map((e) => e.label)).toEqual(['new', 'old']);
  });

  it('This-host excludes remote instances; drops projects with no local instance', () => {
    const remote = 'github.com/donovan-yohan/relay-ide';
    const tree = build({
      repos: [
        // Same remote on local + remote node → one project, two instances.
        repo({ path: '/local/relay', repoIdentity: remote, nodeId: DEFAULT_LOCAL_NODE_ID }),
        repo({ path: '/remote/relay', repoIdentity: remote, nodeId: 'macbook' }),
        // Remote-only project → must drop out entirely under this-host.
        repo({
          path: '/remote/only',
          name: 'only',
          repoIdentity: 'github.com/acme/only',
          nodeId: 'macbook',
        }),
      ],
      nodes: [node({ nodeId: 'macbook', status: 'online' })],
    });

    const local = applyLens(tree, 'this-host');
    const projects = [
      ...local.workspaces.flatMap((w) => w.projects),
      ...local.ungroupedProjects,
    ];
    // The remote-only project is gone; the shared project survives with only
    // its local instance.
    expect(projects.map((p) => p.label).sort()).toEqual(['relay']);
    const survivor = projects.find((p) => p.label === 'relay')!;
    expect(survivor.instances).toHaveLength(1);
    expect(survivor.instances[0]!.isLocal).toBe(true);
    expect(survivor.instances[0]!.nodeId).toBe(DEFAULT_LOCAL_NODE_ID);

    // Pure: input tree still has both instances on the shared project.
    const sharedBefore = tree.ungroupedProjects.find((p) => p.label === 'relay')!;
    expect(sharedBefore.instances).toHaveLength(2);
  });

  it('This-host filters the free lane to local entries only', () => {
    const tree = build({
      sessions: [
        session({ id: 'local-free', cwd: '/tmp/local', nodeId: DEFAULT_LOCAL_NODE_ID }),
        session({ id: 'remote-free', cwd: '/tmp/remote', nodeId: 'macbook' }),
      ],
      nodes: [node({ nodeId: 'macbook', status: 'online' })],
    });
    expect(tree.freeLane).toHaveLength(2);
    const local = applyLens(tree, 'this-host');
    expect(local.freeLane.map((e) => e.label)).toEqual(['local']);
    expect(local.freeLane[0]!.isLocal).toBe(true);
  });
});

// ── S4: "+ tab" create-payload resolver (#731) ────────────────────────────────
describe('S4 benchCreatePayload', () => {
  it('builds a local git agent payload (nodeId, repoPath, worktreePath, cwd)', () => {
    const worktree: WorktreeInfo = {
      name: 'feat-x',
      path: '/repos/relay/.worktrees/feat-x',
      repoName: 'relay',
      repoPath: '/repos/relay',
      displayName: 'feat-x',
      lastActivity: '2026-05-27T00:00:00.000Z',
      branchName: 'feature/x',
      nodeId: DEFAULT_LOCAL_NODE_ID,
    };
    const tree = build({ repos: [repo()], worktrees: [worktree] });
    const instance = allProjects(tree)[0]!.instances[0]!;
    const bench = instance.benches[0]!;

    // Mirrors the dialog's local-git create so the backend agent contract
    // passes: repoPath is the configured parent repo, the worktree becomes cwd.
    // #740: also carries the bench identity (instanceId + deterministic benchId)
    // so the create handler can inherit this Bench's persisted env overlay.
    expect(benchCreatePayload(instance, bench)).toEqual({
      nodeId: DEFAULT_LOCAL_NODE_ID,
      repoPath: '/repos/relay',
      worktreePath: '/repos/relay/.worktrees/feat-x',
      cwd: '/repos/relay/.worktrees/feat-x',
      instanceId: instance.id,
      benchId: bench.id,
    });
  });

  it('routes a remote bench to its node id (correct cross-node routing)', () => {
    const remoteRepo = repo({ nodeId: 'macbook' });
    const worktree: WorktreeInfo = {
      name: 'feat-y',
      path: '/repos/relay/.worktrees/feat-y',
      repoName: 'relay',
      repoPath: '/repos/relay',
      displayName: 'feat-y',
      lastActivity: '2026-05-27T00:00:00.000Z',
      branchName: 'feature/y',
      nodeId: 'macbook',
    };
    const tree = build({
      repos: [remoteRepo],
      worktrees: [worktree],
      nodes: [node({ nodeId: 'macbook', status: 'online' })],
    });
    const instance = allProjects(tree)[0]!.instances.find(
      (i) => i.nodeId === 'macbook'
    )!;
    const bench = instance.benches[0]!;

    // The payload routes to the bench's host node, NOT the local default —
    // guards against creating the tab on the wrong machine.
    expect(benchCreatePayload(instance, bench)).toEqual({
      nodeId: 'macbook',
      repoPath: '/repos/relay',
      worktreePath: '/repos/relay/.worktrees/feat-y',
      cwd: '/repos/relay/.worktrees/feat-y',
      instanceId: instance.id,
      benchId: bench.id,
    });
  });

  it('returns null for a non-git/directory bench (no agent-capable anchor)', () => {
    const dir = repo({
      path: '/dirs/scratch',
      name: 'scratch',
      isGitRepo: false,
      kind: 'directory',
      repoIdentity: null,
    });
    const tree = build({
      repos: [dir],
      sessions: [
        session({
          id: 'w',
          repoPath: '/dirs/scratch',
          worktreePath: '/dirs/scratch/sub',
          cwd: '/dirs/scratch/sub',
        }),
      ],
    });
    const instance = allProjects(tree)[0]!.instances[0]!;
    const bench = instance.benches[0]!;

    // A directory bench has no `config.repos`-validated repo path → an agent
    // session is impossible, so the helper withholds a payload (UI hides +tab).
    expect(bench.repoPath).toBeNull();
    expect(benchCreatePayload(instance, bench)).toBeNull();
  });

  it('carries anchor + bench identity only — no branch/agent/yolo leaked', () => {
    const worktree: WorktreeInfo = {
      name: 'feat-z',
      path: '/repos/relay/.worktrees/feat-z',
      repoName: 'relay',
      repoPath: '/repos/relay',
      displayName: 'feat-z',
      lastActivity: '2026-05-27T00:00:00.000Z',
      branchName: 'feature/z',
      nodeId: DEFAULT_LOCAL_NODE_ID,
    };
    const tree = build({ repos: [repo()], worktrees: [worktree] });
    const instance = allProjects(tree)[0]!.instances[0]!;
    const bench = instance.benches[0]!;

    // #740: the payload carries the repo/worktree anchor plus the bench identity
    // (instanceId + deterministic benchId) used to inherit the Bench env overlay.
    // It must NOT leak branch, agent, yolo, or env values directly into the
    // create call — env inheritance is resolved later, by benchId, at create.
    const payload = benchCreatePayload(instance, bench);
    expect(payload).not.toBeNull();
    expect(Object.keys(payload!).sort()).toEqual([
      'benchId',
      'cwd',
      'instanceId',
      'nodeId',
      'repoPath',
      'worktreePath',
    ]);
    // The benchId is the deterministic id of the anchoring bench, so the
    // create-time overlay lookup matches exactly one persisted overlay.
    expect(payload!.benchId).toBe(bench.id);
    expect(payload!.instanceId).toBe(instance.id);
  });
});

describe('S4 workspace-group ws.repos guard', () => {
  it('tolerates a persisted workspace whose `repos` field is missing/non-array', () => {
    const grouped = repo({
      path: '/repos/grouped',
      name: 'grouped',
      repoIdentity: 'github.com/acme/grouped',
    });
    // Legacy/malformed persisted workspace: `repos` omitted. The ON path must
    // not throw (mirrors the OFF path's `Array.isArray` guard in Sidebar.tsx).
    const malformed = {
      id: 'ws-legacy',
      name: 'Legacy',
      order: 0,
    } as unknown as Workspace;

    expect(() =>
      build({ repos: [grouped], workspaceGroups: [malformed] })
    ).not.toThrow();

    const tree = build({ repos: [grouped], workspaceGroups: [malformed] });
    // No repos → the group is present but empty; the repo falls through to the
    // ungrouped lane rather than crashing the projection.
    expect(tree.workspaces).toHaveLength(1);
    expect(tree.workspaces[0]!.projects).toEqual([]);
    expect(tree.ungroupedProjects.map((p) => p.label)).toEqual(['grouped']);
  });
});

// ── #739: interactive Tab leaves + attention bubbling ─────────────────────────

describe('#739 tab leaves', () => {
  it('lists individual Tabs per bench with a stable select key + label + branch', () => {
    const tree = build({
      repos: [repo()],
      sessions: [
        session({
          id: 'a',
          repoPath: '/repos/relay',
          worktreePath: '/repos/relay/.worktrees/x',
          branchName: 'feature/x',
          displayName: 'agent one',
          cwd: '/repos/relay/.worktrees/x',
        }),
        session({
          id: 'b',
          repoPath: '/repos/relay',
          worktreePath: '/repos/relay/.worktrees/x',
          branchName: 'feature/x',
          displayName: 'agent two',
          cwd: '/repos/relay/.worktrees/x',
        }),
      ],
    });
    const bench = allProjects(tree)[0]!.instances[0]!.benches[0]!;
    expect(bench.tab.count).toBe(2);
    expect(bench.tab.leaves.map((l) => l.label)).toEqual([
      'agent one',
      'agent two',
    ]);
    // Select key is the scoped session key (node-scoped global id form here).
    expect(bench.tab.leaves[0]!.selectKey).toContain('a');
    expect(bench.tab.leaves[0]!.branch).toBe('feature/x');
  });

  it('root-anchored sessions become instance root tab leaves', () => {
    const tree = build({
      repos: [repo()],
      sessions: [
        session({
          id: 'root',
          repoPath: '/repos/relay',
          displayName: 'root agent',
          cwd: '/repos/relay',
        }),
      ],
    });
    const instance = allProjects(tree)[0]!.instances[0]!;
    expect(instance.rootTab.count).toBe(1);
    expect(instance.rootTab.leaves.map((l) => l.label)).toEqual(['root agent']);
  });

  it('directory/free tab leaves carry NO branch (leak guard)', () => {
    const tree = build({
      sessions: [
        session({
          id: 'free',
          cwd: '/tmp/scratch',
          branchName: 'should-not-leak',
          displayName: 'scratch session',
        }),
      ],
    });
    const entry = tree.freeLane[0]!;
    expect(entry.tab.leaves).toHaveLength(1);
    expect(entry.tab.leaves[0]!.branch).toBeNull();
    // No field VALUE leaks the branch string.
    expect(JSON.stringify(entry.tab.leaves[0])).not.toContain('should-not-leak');
  });
});

describe('#739 attention rollup', () => {
  // A session whose agentState puts it in a given attention/non-attention state.
  const attn = (id: string, agentState: SessionSummary['agentState'], extra: Partial<SessionSummary> = {}) =>
    session({
      id,
      repoPath: '/repos/relay',
      worktreePath: `/repos/relay/.worktrees/${id}`,
      cwd: `/repos/relay/.worktrees/${id}`,
      agentState,
      idle: agentState === 'idle',
      ...extra,
    });

  it('no-attention case: idle tabs leave bench/instance/project quiet', () => {
    const tree = build({
      repos: [repo()],
      sessions: [attn('a', 'idle'), attn('b', 'idle')],
    });
    const project = allProjects(tree)[0]!;
    const instance = project.instances[0]!;
    for (const bench of instance.benches) {
      expect(bench.attention.state).toBeNull();
      expect(bench.attention.count).toBe(0);
    }
    expect(instance.attention.state).toBeNull();
    expect(instance.attention.count).toBe(0);
    expect(project.attention.state).toBeNull();
    expect(project.attention.count).toBe(0);
  });

  it('bubbles a single attention tab bench → instance → project', () => {
    const tree = build({
      repos: [repo()],
      sessions: [attn('a', 'idle'), attn('b', 'permission-prompt')],
    });
    const project = allProjects(tree)[0]!;
    const instance = project.instances[0]!;
    const benchB = instance.benches.find((x) =>
      x.path.endsWith('/b')
    )!;
    const benchA = instance.benches.find((x) =>
      x.path.endsWith('/a')
    )!;
    // Only bench b's tab needs attention.
    expect(benchA.attention.state).toBeNull();
    expect(benchA.attention.count).toBe(0);
    expect(benchB.attention.state).toBe('permission');
    expect(benchB.attention.count).toBe(1);
    // Instance + project see exactly one attention tab.
    expect(instance.attention.state).toBe('permission');
    expect(instance.attention.count).toBe(1);
    expect(project.attention.state).toBe('permission');
    expect(project.attention.count).toBe(1);
  });

  it('picks the HIGHEST-priority attention state and SUMS counts up the tree', () => {
    const tree = build({
      repos: [repo()],
      sessions: [
        // error (priority 800) on bench a
        attn('a', 'error'),
        // permission (priority 1000) on bench b → wins
        attn('b', 'permission-prompt'),
        // a second attention tab on bench b → count rolls up to 3 total
        session({
          id: 'b2',
          repoPath: '/repos/relay',
          worktreePath: '/repos/relay/.worktrees/b',
          cwd: '/repos/relay/.worktrees/b',
          agentState: 'error',
          idle: false,
        }),
      ],
    });
    const project = allProjects(tree)[0]!;
    const instance = project.instances[0]!;
    const benchB = instance.benches.find((x) => x.path.endsWith('/b'))!;
    // bench b: permission beats error; 2 attention tabs.
    expect(benchB.attention.state).toBe('permission');
    expect(benchB.attention.count).toBe(2);
    // project: highest = permission; total attention tabs = 3 (a + b + b2).
    expect(project.attention.state).toBe('permission');
    expect(project.attention.count).toBe(3);
  });

  it('rolls attention across multiple instances of one project', () => {
    const tree = build({
      repos: [repo()],
      nodes: [node({ nodeId: 'macbook', status: 'online' })],
      sessions: [
        // local instance: idle
        attn('local', 'idle'),
        // remote instance: needs-answer
        attn('remote', 'permission-prompt', {
          nodeId: 'macbook',
          permissionType: 'question',
        }),
      ],
    });
    const project = allProjects(tree)[0]!;
    expect(project.instances.length).toBeGreaterThanOrEqual(2);
    // needs-answer bubbles to the project even though it's on a remote instance.
    expect(project.attention.state).toBe('needs-answer');
    expect(project.attention.count).toBe(1);
  });

  it('bubbles attention for free-lane tabs', () => {
    const tree = build({
      sessions: [
        session({ id: 'free', cwd: '/tmp/w', agentState: 'permission-prompt', idle: false }),
      ],
    });
    const entry = tree.freeLane[0]!;
    expect(entry.attention.state).toBe('permission');
    expect(entry.attention.count).toBe(1);
  });
});
