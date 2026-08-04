import { describe, expect, it } from 'vitest';

import {
  activeWorkAnchorLabel,
  activeWorkContextLabel,
  repoBindingLabel,
  repoKind,
} from '../frontend/src/components/ActiveWorkSurface.js';
import type { Repo, WorkContextActiveGroup, WorkContextSessionSummary } from '../frontend/src/lib/types.js';

function makeSession(
  overrides: Partial<WorkContextSessionSummary> = {}
): WorkContextSessionSummary {
  return {
    id: 'sess-1',
    nodeId: 'local',
    tabKind: 'terminal',
    type: 'terminal',
    cwd: '/home/user/my-project',
    repoPath: '/home/user/my-project',
    relationship: 'primary',
    associatedAt: '2026-05-12T00:00:00.000Z',
    live: true,
    ...overrides,
  };
}

function makeGroup(
  sessions: WorkContextSessionSummary[] = [],
  overrides: Partial<WorkContextActiveGroup> = {}
): WorkContextActiveGroup {
  return {
    id: 'group-1',
    context: null,
    node: {
      nodeId: 'local',
      status: 'online',
      displayName: 'local',
      kind: 'local',
    },
    sessions,
    staleReadModel: false,
    ...overrides,
  };
}

function makeRepo(
  path: string,
  kind: 'repo' | 'directory',
  overrides: Partial<Repo> = {}
): Repo {
  return {
    path,
    name: path.split('/').pop() ?? path,
    isGitRepo: kind === 'repo',
    kind,
    defaultBranch: kind === 'repo' ? 'main' : null,
    currentBranch: kind === 'repo' ? 'main' : null,
    ...overrides,
  };
}

describe('active-work-surface anchor rendering', () => {
  it('directory-kind session anchor reads <node> · <cwd> · directory', () => {
    const session = makeSession({
      nodeId: 'local',
      cwd: '/home/user/my-project',
      repoPath: '/home/user/my-project',
    });
    const repos = [makeRepo('/home/user/my-project', 'directory')];
    const group = makeGroup([session]);

    const kind = repoKind(session, repos);
    expect(kind).toBe('directory');

    const label = repoBindingLabel(session, repos);
    expect(label).toMatch(/local/);
    expect(label).toMatch(/\/home\/user\/my-project/);
    expect(label).toMatch(/directory/);
    expect(activeWorkAnchorLabel(group, session, repos)).toBe(
      'local · /home/user/my-project · directory'
    );
  });

  it('repo-kind session anchor includes repo name and branch', () => {
    const session = makeSession({
      nodeId: 'local',
      cwd: '/home/user/relay-ide',
      repoPath: '/home/user/relay-ide',
      repoName: 'relay-ide',
      branchName: 'nightly',
    });
    const repos = [makeRepo('/home/user/relay-ide', 'repo')];
    const group = makeGroup([session]);

    const kind = repoKind(session, repos);
    expect(kind).toBe('repo');

    const label = repoBindingLabel(session, repos);
    expect(label).toContain('relay-ide');
    expect(label).toContain('nightly');
    expect(label).not.toContain('directory');
    expect(activeWorkAnchorLabel(group, session, repos)).toBe(
      'repo relay-ide · nightly'
    );
  });

  it('session with no matching repo returns null kind and no repo-binding cockpit copy', () => {
    const session = makeSession({ repoPath: '/some/unknown/path' });
    const repos: Repo[] = [];
    const group = makeGroup([session]);

    expect(repoKind(session, repos)).toBeNull();
    expect(repoBindingLabel(session, repos)).toBeNull();
    expect(activeWorkAnchorLabel(group, session, repos)).toBe(
      'local · /home/user/my-project · no repo binding'
    );
  });

  it('remote session does not bind to a local repo with the same path', () => {
    const session = makeSession({
      nodeId: 'mac-node',
      cwd: '/Users/user/relay-ide',
      repoPath: '/Users/user/relay-ide',
      repoName: 'relay-ide',
      branchName: 'feature/active-work',
    });
    const repos = [makeRepo('/Users/user/relay-ide', 'repo')];
    const group = makeGroup([session], {
      node: {
        nodeId: 'mac-node',
        status: 'online',
        displayName: 'mac node',
        kind: 'remote',
      },
    });

    expect(repoKind(session, repos)).toBeNull();
    expect(repoBindingLabel(session, repos)).toBeNull();
    expect(activeWorkAnchorLabel(group, session, repos)).toBe(
      'remote mac node · /Users/user/relay-ide · no repo binding'
    );
    expect(activeWorkAnchorLabel(group, session, repos)).toMatch(
      /no repo binding$/
    );
  });

  it('remote session binds to a repo on the matching remote node', () => {
    const session = makeSession({
      nodeId: 'mac-node',
      cwd: '/Users/user/relay-ide',
      repoPath: '/Users/user/relay-ide',
      repoName: undefined,
      branchName: 'feature/active-work',
    });
    const repos = [
      makeRepo('/Users/user/relay-ide', 'repo', { name: 'local-relay' }),
      makeRepo('/Users/user/relay-ide', 'repo', {
        nodeId: 'mac-node',
        name: 'remote-relay',
      }),
    ];
    const group = makeGroup([session], {
      node: {
        nodeId: 'mac-node',
        status: 'online',
        displayName: 'mac node',
        kind: 'remote',
      },
    });

    expect(repoKind(session, repos)).toBe('repo');
    expect(repoBindingLabel(session, repos)).toBe(
      'remote-relay · feature/active-work'
    );
    expect(activeWorkAnchorLabel(group, session, repos)).toBe(
      'repo remote-relay · feature/active-work'
    );
  });

  it('directory-kind shows remote node name in anchor', () => {
    const session = makeSession({
      nodeId: 'remote-server',
      cwd: '/srv/workspace',
      repoPath: '/srv/workspace',
    });
    const repos = [
      makeRepo('/srv/workspace', 'directory', { nodeId: 'remote-server' }),
    ];
    const group = makeGroup([session], {
      node: {
        nodeId: 'remote-server',
        status: 'online',
        displayName: 'mac node',
        kind: 'remote',
      },
    });

    const label = repoBindingLabel(session, repos);
    expect(label).toContain('remote-server');
    expect(label).toContain('/srv/workspace');
    expect(label).toContain('directory');
    expect(activeWorkAnchorLabel(group, session, repos)).toBe(
      'mac node · /srv/workspace · directory'
    );
  });

  it('repo-less remote/free sessions are honest about node/cwd without repo badges', () => {
    const session = makeSession({
      nodeId: 'mac-node',
      cwd: '/tmp/scratch',
      repoPath: undefined,
      repoName: undefined,
      branchName: undefined,
      tabKind: 'other',
    });
    const group = makeGroup([session], {
      node: {
        nodeId: 'mac-node',
        status: 'offline',
        displayName: 'mac node',
        kind: 'remote',
      },
      staleReadModel: true,
    });

    expect(repoBindingLabel(session, [])).toBeNull();
    expect(activeWorkAnchorLabel(group, session, [])).toBe(
      'remote mac node · /tmp/scratch · no repo binding'
    );
    expect(activeWorkContextLabel(group)).toBe('unbound session group group-1');
  });

  it('does not bind a remote same-path session to a local configured repo', () => {
    const session = makeSession({
      id: 'remote-same-path',
      nodeId: 'mac-node',
      cwd: '/home/user/relay-ide',
      repoPath: '/home/user/relay-ide',
      repoName: undefined,
      branchName: undefined,
    });
    const repos = [
      makeRepo('/home/user/relay-ide', 'repo', {
        name: 'relay-ide',
        defaultBranch: 'nightly',
        currentBranch: 'nightly',
        nodeId: 'local',
      }),
    ];
    const group = makeGroup([session], {
      node: {
        nodeId: 'mac-node',
        status: 'online',
        displayName: 'mac node',
        kind: 'remote',
      },
    });

    expect(repoKind(session, repos)).toBeNull();
    expect(repoBindingLabel(session, repos)).toBeNull();
    expect(activeWorkAnchorLabel(group, session, repos)).toBe(
      'remote mac node · /home/user/relay-ide · no repo binding'
    );
  });

  it('binds a same-path repo when the session node matches the repo node', () => {
    const session = makeSession({
      nodeId: 'mac-node',
      cwd: '/home/user/relay-ide',
      repoPath: '/home/user/relay-ide',
      branchName: 'nightly',
    });
    const repos = [
      makeRepo('/home/user/relay-ide', 'repo', {
        name: 'relay-ide',
        defaultBranch: 'nightly',
        currentBranch: 'nightly',
        nodeId: 'mac-node',
      }),
    ];
    const group = makeGroup([session], {
      node: {
        nodeId: 'mac-node',
        status: 'online',
        displayName: 'mac node',
        kind: 'remote',
      },
    });

    expect(repoKind(session, repos)).toBe('repo');
    expect(repoBindingLabel(session, repos)).toBe('relay-ide · nightly');
    expect(activeWorkAnchorLabel(group, session, repos)).toBe(
      'repo relay-ide · nightly'
    );
  });
});
