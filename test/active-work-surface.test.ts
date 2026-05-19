import { describe, expect, it } from 'vitest';

import {
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
    tabKind: 'primary',
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
  sessions: WorkContextSessionSummary[] = []
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
  };
}

function makeRepo(path: string, kind: 'repo' | 'directory'): Repo {
  return {
    path,
    name: path.split('/').pop() ?? path,
    isGitRepo: kind === 'repo',
    kind,
    defaultBranch: kind === 'repo' ? 'main' : null,
    currentBranch: kind === 'repo' ? 'main' : null,
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

    const label = repoBindingLabel(group, session, repos);
    expect(label).toMatch(/local/);
    expect(label).toMatch(/\/home\/user\/my-project/);
    expect(label).toMatch(/directory/);
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

    const label = repoBindingLabel(group, session, repos);
    expect(label).toContain('relay-ide');
    expect(label).toContain('nightly');
    // should NOT contain 'directory'
    expect(label).not.toContain('directory');
  });

  it('session with no matching repo returns null kind', () => {
    const session = makeSession({ repoPath: '/some/unknown/path' });
    const repos: Repo[] = [];

    expect(repoKind(session, repos)).toBeNull();
  });

  it('directory-kind shows remote node name in anchor', () => {
    const session = makeSession({
      nodeId: 'remote-server',
      cwd: '/srv/workspace',
      repoPath: '/srv/workspace',
    });
    const repos = [makeRepo('/srv/workspace', 'directory')];
    const group = makeGroup([session]);

    const label = repoBindingLabel(group, session, repos);
    expect(label).toContain('remote-server');
    expect(label).toContain('/srv/workspace');
    expect(label).toContain('directory');
  });
});
