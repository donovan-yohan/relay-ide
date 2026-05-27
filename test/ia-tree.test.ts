import { describe, expect, it } from 'vitest';

import { DEFAULT_LOCAL_NODE_ID } from '../shared/identity.js';
import { parseInstanceId, parseProjectId } from '../shared/project.js';
import type {
  RepoInventoryReport,
  RepoInventoryRepoInstance,
  RepoInventoryWorktreeInstance,
} from '../shared/repo-inventory.js';
import {
  buildIaTree,
  type BuildIaTreeInput,
  type IaNodeStatus,
  type IaProject,
  type IaTree,
} from '../server/features/ia-tree.js';

// ── Builders ────────────────────────────────────────────────────────────────

function repoInstance(
  overrides: Partial<RepoInventoryRepoInstance> = {}
): RepoInventoryRepoInstance {
  const nodeId = overrides.nodeId ?? DEFAULT_LOCAL_NODE_ID;
  const localPath = overrides.localPath ?? '/repos/relay';
  return {
    repoInstanceId: `${nodeId}:${localPath}`,
    nodeId,
    localPath,
    name: 'relay',
    isGitRepo: true,
    defaultBranch: 'main',
    currentBranch: 'main',
    repoIdentity: 'github.com/donovan-yohan/relay-ide',
    selectedRemote: null,
    remotes: [],
    repoIdentityWarnings: [],
    worktrees: [],
    reportedAt: '2026-05-27T00:00:00.000Z',
    ...overrides,
  };
}

function worktree(
  overrides: Partial<RepoInventoryWorktreeInstance> = {}
): RepoInventoryWorktreeInstance {
  const localPath = overrides.localPath ?? '/repos/relay/.worktrees/feat-x';
  return {
    worktreeInstanceId: `local:${localPath}`,
    localPath,
    branchName: 'feature/x',
    displayName: 'feat-x',
    lastActivity: '2026-05-27T00:00:00.000Z',
    ...overrides,
  };
}

function report(
  nodeId: string,
  repos: RepoInventoryRepoInstance[]
): RepoInventoryReport {
  return { nodeId, generatedAt: '2026-05-27T00:00:00.000Z', repos };
}

function node(overrides: Partial<IaNodeStatus> = {}): IaNodeStatus {
  return { nodeId: 'macbook', displayName: 'MacBook', status: 'online', ...overrides };
}

function build(partial: Partial<BuildIaTreeInput> = {}): IaTree {
  return buildIaTree({
    reports: [],
    nodes: [],
    generatedAt: '2026-05-27T00:00:00.000Z',
    ...partial,
  });
}

function allProjects(tree: IaTree): IaProject[] {
  return [...tree.workspaces.flatMap((ws) => ws.projects), ...tree.ungroupedProjects];
}

// ── C1: dedup matrix ──────────────────────────────────────────────────────────

describe('C1 dedup matrix', () => {
  it('(a) null repoIdentity → directory project keyed on node+path', () => {
    const tree = build({
      reports: [
        report(DEFAULT_LOCAL_NODE_ID, [
          repoInstance({
            localPath: '/dirs/scratch',
            name: 'scratch',
            isGitRepo: false,
            repoIdentity: null,
          }),
        ]),
      ],
    });
    const projects = allProjects(tree);
    expect(projects).toHaveLength(1);
    const project = projects[0]!;
    expect(project.kind).toBe('directory');
    expect(parseProjectId(project.id)).toEqual({
      kind: 'directory',
      nodeId: DEFAULT_LOCAL_NODE_ID,
      localPath: '/dirs/scratch',
    });
    expect(project.identity.kind).toBe('directory');
  });

  it('(a) blank repoIdentity on a git repo also falls back to directory', () => {
    const tree = build({
      reports: [report(DEFAULT_LOCAL_NODE_ID, [repoInstance({ repoIdentity: '   ' })])],
    });
    const projects = allProjects(tree);
    expect(projects).toHaveLength(1);
    expect(projects[0]!.kind).toBe('directory');
  });

  it('(b) same remote on two nodes = ONE project, TWO instances', () => {
    const remote = 'github.com/donovan-yohan/relay-ide';
    const tree = build({
      reports: [
        report(DEFAULT_LOCAL_NODE_ID, [
          repoInstance({ localPath: '/local/relay', repoIdentity: remote }),
        ]),
        report('macbook', [
          repoInstance({
            nodeId: 'macbook',
            localPath: '/remote/relay',
            repoIdentity: remote,
          }),
        ]),
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

    for (const instance of project.instances) {
      expect(parseInstanceId(instance.id)?.projectId).toBe(project.id);
    }

    const local = project.instances.find((i) => i.isLocal)!;
    const remoteInst = project.instances.find((i) => !i.isLocal)!;
    expect(local.hostLabel).toBe('this host');
    expect(remoteInst.hostLabel).toBe('MacBook');
  });

  it('(c) offline-node join surfaces an offline instance status', () => {
    const remote = 'github.com/donovan-yohan/relay-ide';
    const tree = build({
      reports: [
        report('macbook', [
          repoInstance({ nodeId: 'macbook', localPath: '/remote/relay', repoIdentity: remote }),
        ]),
      ],
      nodes: [node({ nodeId: 'macbook', status: 'offline' })],
    });
    const instance = allProjects(tree)[0]!.instances[0]!;
    expect(instance.nodeId).toBe('macbook');
    expect(instance.status).toBe('offline');
  });

  it('(c) stale-node join surfaces a stale instance status', () => {
    const remote = 'github.com/donovan-yohan/relay-ide';
    const tree = build({
      reports: [
        report('macbook', [
          repoInstance({ nodeId: 'macbook', localPath: '/remote/relay', repoIdentity: remote }),
        ]),
      ],
      nodes: [node({ nodeId: 'macbook', status: 'stale' })],
    });
    expect(allProjects(tree)[0]!.instances[0]!.status).toBe('stale');
  });

  it('(c) a remote node absent from the registry joins as offline', () => {
    const remote = 'github.com/donovan-yohan/relay-ide';
    const tree = build({
      reports: [
        report('ghost', [
          repoInstance({ nodeId: 'ghost', localPath: '/remote/relay', repoIdentity: remote }),
        ]),
      ],
      nodes: [],
    });
    expect(allProjects(tree)[0]!.instances[0]!.status).toBe('offline');
  });

  it('local host is online even when absent from the registry', () => {
    const tree = build({
      reports: [report(DEFAULT_LOCAL_NODE_ID, [repoInstance()])],
      nodes: [],
    });
    expect(allProjects(tree)[0]!.instances[0]!.status).toBe('online');
  });

  it('two checkouts of the same remote on the SAME node = one project, two instances', () => {
    const remote = 'github.com/acme/dup';
    const tree = build({
      reports: [
        report(DEFAULT_LOCAL_NODE_ID, [
          repoInstance({ localPath: '/a/dup', repoIdentity: remote }),
          repoInstance({ localPath: '/b/dup', repoIdentity: remote }),
        ]),
      ],
    });
    const projects = allProjects(tree);
    expect(projects).toHaveLength(1);
    expect(projects[0]!.instances).toHaveLength(2);
    expect(projects[0]!.instances.map((i) => i.localPath).sort()).toEqual([
      '/a/dup',
      '/b/dup',
    ]);
  });
});

// ── Identity-leak regression (mirror client C2) ───────────────────────────────

describe('identity-leak regression', () => {
  it('directory-project benches omit branch entirely and carry no repo anchor', () => {
    const tree = build({
      reports: [
        report(DEFAULT_LOCAL_NODE_ID, [
          repoInstance({
            localPath: '/dirs/scratch',
            name: 'scratch',
            isGitRepo: false,
            repoIdentity: null,
            worktrees: [
              worktree({ localPath: '/dirs/scratch/sub', branchName: 'leak' }),
            ],
          }),
        ]),
      ],
    });
    const bench = allProjects(tree)[0]!.instances[0]!.benches[0]!;
    expect(bench.isGit).toBe(false);
    expect(bench.branch).toBeNull();
    expect(bench.repoPath).toBeNull();
    // No leaked branch string anywhere on the directory bench.
    expect(JSON.stringify(bench)).not.toContain('leak');
  });

  it('a directory project never carries a repo-kind identity', () => {
    const tree = build({
      reports: [
        report(DEFAULT_LOCAL_NODE_ID, [
          repoInstance({
            localPath: '/dirs/x',
            name: 'x',
            isGitRepo: false,
            repoIdentity: null,
          }),
        ]),
      ],
    });
    const project = allProjects(tree)[0]!;
    expect(project.identity.kind).toBe('directory');
    expect(JSON.stringify(project.identity)).not.toContain('github.com');
  });
});

// ── Benches + workspace grouping ──────────────────────────────────────────────

describe('benches and grouping', () => {
  it('maps worktrees to benches with branch + parent repoPath on git projects', () => {
    const tree = build({
      reports: [
        report(DEFAULT_LOCAL_NODE_ID, [
          repoInstance({ worktrees: [worktree()] }),
        ]),
      ],
    });
    const instance = allProjects(tree)[0]!.instances[0]!;
    expect(instance.benches).toHaveLength(1);
    const bench = instance.benches[0]!;
    expect(bench.path).toBe('/repos/relay/.worktrees/feat-x');
    expect(bench.isGit).toBe(true);
    expect(bench.branch).toBe('feature/x');
    expect(bench.repoPath).toBe('/repos/relay');
    expect(bench.label).toBe('feat-x');
  });

  it('places workspace-group repos under their group and leaves others ungrouped', () => {
    const tree = build({
      reports: [
        report(DEFAULT_LOCAL_NODE_ID, [
          repoInstance({
            localPath: '/repos/grouped',
            name: 'grouped',
            repoIdentity: 'github.com/acme/grouped',
          }),
          repoInstance({
            localPath: '/repos/loose',
            name: 'loose',
            repoIdentity: 'github.com/acme/loose',
          }),
        ]),
      ],
      workspaceGroups: [
        { id: 'ws-1', name: 'My Workspace', order: 0, repos: ['/repos/grouped'] },
      ],
    });
    expect(tree.workspaces).toHaveLength(1);
    expect(tree.workspaces[0]!.projects.map((p) => p.label)).toEqual(['grouped']);
    expect(tree.ungroupedProjects.map((p) => p.label)).toEqual(['loose']);
  });

  it('tolerates a workspace group whose `repos` field is missing/non-array', () => {
    const malformed = { id: 'ws-legacy', name: 'Legacy', order: 0 } as {
      id: string;
      name: string;
      order: number;
      repos?: string[];
    };
    const tree = build({
      reports: [
        report(DEFAULT_LOCAL_NODE_ID, [
          repoInstance({
            localPath: '/repos/grouped',
            name: 'grouped',
            repoIdentity: 'github.com/acme/grouped',
          }),
        ]),
      ],
      workspaceGroups: [malformed],
    });
    expect(tree.workspaces).toHaveLength(1);
    expect(tree.workspaces[0]!.projects).toEqual([]);
    expect(tree.ungroupedProjects.map((p) => p.label)).toEqual(['grouped']);
  });

  it('rolls up the most-recent worktree activity onto instance + project', () => {
    const tree = build({
      reports: [
        report(DEFAULT_LOCAL_NODE_ID, [
          repoInstance({
            worktrees: [
              worktree({ localPath: '/repos/relay/.worktrees/old', lastActivity: '2026-05-20T00:00:00.000Z' }),
              worktree({ localPath: '/repos/relay/.worktrees/new', lastActivity: '2026-05-27T00:00:00.000Z' }),
            ],
          }),
        ]),
      ],
    });
    const project = allProjects(tree)[0]!;
    expect(project.lastActivity).toBe('2026-05-27T00:00:00.000Z');
    expect(project.instances[0]!.lastActivity).toBe('2026-05-27T00:00:00.000Z');
  });
});

describe('determinism + empty', () => {
  it('returns the supplied generatedAt and empty lanes for no reports', () => {
    const tree = build({ generatedAt: '2026-01-01T00:00:00.000Z' });
    expect(tree.generatedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(tree.workspaces).toEqual([]);
    expect(tree.ungroupedProjects).toEqual([]);
  });

  it('sorts ungrouped projects alphabetically by label', () => {
    const tree = build({
      reports: [
        report(DEFAULT_LOCAL_NODE_ID, [
          repoInstance({ localPath: '/repos/bbb', name: 'bbb', repoIdentity: 'github.com/acme/bbb' }),
          repoInstance({ localPath: '/repos/aaa', name: 'aaa', repoIdentity: 'github.com/acme/aaa' }),
        ]),
      ],
    });
    expect(tree.ungroupedProjects.map((p) => p.label)).toEqual(['aaa', 'bbb']);
  });
});
