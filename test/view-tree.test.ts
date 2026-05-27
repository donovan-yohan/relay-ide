import { describe, expect, it } from 'vitest';

import { DEFAULT_LOCAL_NODE_ID } from '../shared/identity.js';
import { parseInstanceId, parseProjectId } from '../shared/project.js';
import {
  buildViewTree,
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
