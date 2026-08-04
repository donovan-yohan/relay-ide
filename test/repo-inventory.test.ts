import { describe, expect, it } from 'vitest';

import {
  aggregateRepoInventoryReports,
  isRepoInventoryReport,
  type RepoInventoryRepoInstance,
} from '../shared/repo-inventory.js';
import { normalizeRemoteUrl, type ResolvedRemoteIdentity } from '../shared/repo-identity.js';

function remote(name: string, url: string): ResolvedRemoteIdentity {
  const normalized = normalizeRemoteUrl(url);
  return {
    name,
    url,
    identity: normalized.identity,
    provider: normalized.provider,
    host: normalized.host,
    path: normalized.path,
    owner: normalized.owner,
    repoName: normalized.name,
    ...(normalized.warning ? { warning: normalized.warning } : {}),
  };
}

function repo(overrides: Partial<RepoInventoryRepoInstance>): RepoInventoryRepoInstance {
  const selectedRemote = overrides.selectedRemote ?? remote('origin', 'git@github.com:donovan-yohan/relay-ide.git');
  return {
    repoInstanceId: overrides.repoInstanceId ?? `${overrides.nodeId ?? 'local'}:${encodeURIComponent(overrides.localPath ?? '/repo')}`,
    nodeId: overrides.nodeId ?? 'local',
    localPath: overrides.localPath ?? '/repo',
    name: overrides.name ?? 'relay-ide',
    isGitRepo: overrides.isGitRepo ?? true,
    defaultBranch: overrides.defaultBranch ?? 'nightly',
    currentBranch: overrides.currentBranch ?? 'nightly',
    repoIdentity: 'repoIdentity' in overrides ? (overrides.repoIdentity ?? null) : selectedRemote.identity,
    selectedRemote,
    remotes: overrides.remotes ?? [selectedRemote],
    repoIdentityWarnings: overrides.repoIdentityWarnings ?? [],
    dirty: overrides.dirty ?? {
      stagedCount: 0,
      unstagedCount: 0,
      untrackedCount: 0,
      conflictedCount: 0,
      files: [],
      truncated: false,
    },
    divergence: overrides.divergence ?? {
      upstreamRef: 'origin/nightly',
      aheadCount: 0,
      behindCount: 0,
    },
    worktrees: overrides.worktrees ?? [],
    reportedAt: overrides.reportedAt ?? '2026-05-12T00:00:00.000Z',
  };
}

describe('repo inventory aggregation', () => {
  it('groups the same GitHub repo across SSH/HTTPS remotes and node-local paths', () => {
    const macRemote = remote('origin', 'git@github.com:donovan-yohan/relay-ide.git');
    const linuxRemote = remote('origin', 'https://github.com/donovan-yohan/relay-ide.git');
    const result = aggregateRepoInventoryReports([
      {
        nodeId: 'macbook',
        generatedAt: '2026-05-12T00:00:00.000Z',
        repos: [
          repo({
            nodeId: 'macbook',
            localPath: '/Users/kyle/dev/relay-ide',
            repoInstanceId: 'macbook:%2FUsers%2Fkyle%2Fdev%2Frelay-ide',
            selectedRemote: macRemote,
            remotes: [macRemote],
            worktrees: [
              {
                worktreeInstanceId: 'macbook:%2FUsers%2Fkyle%2Fdev%2Frelay-ide%2F.worktrees%2Fa',
                localPath: '/Users/kyle/dev/relay-ide/.worktrees/a',
                branchName: 'feature/a',
                dirty: {
                  stagedCount: 1,
                  unstagedCount: 0,
                  untrackedCount: 0,
                  conflictedCount: 0,
                  files: [{ path: 'server/a.ts', status: 'modified' }],
                  truncated: false,
                },
              },
            ],
          }),
        ],
      },
      {
        nodeId: 'linux',
        generatedAt: '2026-05-12T00:00:00.000Z',
        repos: [
          repo({
            nodeId: 'linux',
            localPath: '/srv/repos/relay-ide',
            repoInstanceId: 'linux:%2Fsrv%2Frepos%2Frelay-ide',
            selectedRemote: linuxRemote,
            remotes: [linuxRemote],
            currentBranch: 'main',
          }),
        ],
      },
    ]);

    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]).toMatchObject({
      groupId: 'github.com/donovan-yohan/relay-ide',
      repoIdentity: 'github.com/donovan-yohan/relay-ide',
      identityDebug: {
        groupedBy: 'repoIdentity',
        instanceCount: 2,
        nodeIds: ['linux', 'macbook'],
      },
    });
    expect(result.groups[0]?.instances.map((instance) => [instance.nodeId, instance.localPath])).toEqual([
      ['linux', '/srv/repos/relay-ide'],
      ['macbook', '/Users/kyle/dev/relay-ide'],
    ]);
    expect(result.groups[0]?.instances[1]?.worktrees[0]).toMatchObject({
      localPath: '/Users/kyle/dev/relay-ide/.worktrees/a',
      branchName: 'feature/a',
    });
  });

  it('does not collapse unrelated same-basename repos when remotes differ', () => {
    const firstRemote = remote('origin', 'git@github.com:one/tools.git');
    const secondRemote = remote('origin', 'git@github.com:two/tools.git');
    const result = aggregateRepoInventoryReports([
      {
        nodeId: 'node-a',
        generatedAt: '2026-05-12T00:00:00.000Z',
        repos: [repo({ nodeId: 'node-a', name: 'tools', selectedRemote: firstRemote, remotes: [firstRemote] })],
      },
      {
        nodeId: 'node-b',
        generatedAt: '2026-05-12T00:00:00.000Z',
        repos: [repo({ nodeId: 'node-b', name: 'tools', selectedRemote: secondRemote, remotes: [secondRemote] })],
      },
    ]);

    expect(result.groups.map((group) => group.groupId).sort()).toEqual([
      'github.com/one/tools',
      'github.com/two/tools',
    ]);
  });

  it('surfaces fork/upstream and malformed/missing remote warnings', () => {
    const origin = remote('origin', 'git@github.com:donovan-yohan/relay-ide.git');
    const upstream = remote('upstream', 'https://github.com/NousResearch/relay-ide.git');
    const result = aggregateRepoInventoryReports([
      {
        nodeId: 'macbook',
        generatedAt: '2026-05-12T00:00:00.000Z',
        repos: [
          repo({
            nodeId: 'macbook',
            selectedRemote: origin,
            remotes: [origin, upstream],
            repoIdentityWarnings: ['multiple-remotes', 'fork-upstream-ambiguity'],
          }),
          repo({
            nodeId: 'macbook',
            localPath: '/Users/kyle/dev/no-remote',
            repoInstanceId: 'macbook:%2FUsers%2Fkyle%2Fdev%2Fno-remote',
            name: 'no-remote',
            repoIdentity: null,
            selectedRemote: null,
            remotes: [],
            repoIdentityWarnings: ['missing-remotes'],
          }),
        ],
      },
    ]);

    const relay = result.groups.find((group) => group.repoIdentity === 'github.com/donovan-yohan/relay-ide');
    const missing = result.groups.find((group) => group.repoIdentity === null);
    expect(relay?.warnings).toEqual(['fork-upstream-ambiguity', 'multiple-remotes']);
    expect(missing).toMatchObject({
      groupId: 'unidentified:macbook:%2FUsers%2Fkyle%2Fdev%2Fno-remote',
      warnings: ['missing-remotes'],
      identityDebug: { groupedBy: 'repoInstanceId' },
    });
  });

  it('validates node reports before accepting heartbeat inventory payloads', () => {
    const valid = {
      nodeId: 'macbook',
      generatedAt: '2026-05-12T00:00:00.000Z',
      repos: [repo({ nodeId: 'macbook' })],
    };
    const invalid = {
      ...valid,
      repos: [{ ...valid.repos[0], nodeId: 'other-node' }],
    };

    expect(isRepoInventoryReport(valid)).toBe(true);
    expect(isRepoInventoryReport(invalid)).toBe(false);
  });

  it('rejects remote identities with malformed provider or warning values', () => {
    const validRepo = repo({ nodeId: 'macbook' });
    const valid = {
      nodeId: 'macbook',
      generatedAt: '2026-05-12T00:00:00.000Z',
      repos: [validRepo],
    };
    const invalidProvider = {
      ...valid,
      repos: [
        {
          ...validRepo,
          selectedRemote: { ...validRepo.selectedRemote, provider: 'svn' },
          remotes: [{ ...validRepo.remotes[0], provider: 'svn' }],
        },
      ],
    };
    const invalidWarning = {
      ...valid,
      repos: [
        {
          ...validRepo,
          selectedRemote: { ...validRepo.selectedRemote, warning: 'surprise-warning' },
          remotes: [{ ...validRepo.remotes[0], warning: 'surprise-warning' }],
          repoIdentityWarnings: ['surprise-warning'],
        },
      ],
    };

    expect(isRepoInventoryReport(valid)).toBe(true);
    expect(isRepoInventoryReport(invalidProvider)).toBe(false);
    expect(isRepoInventoryReport(invalidWarning)).toBe(false);
  });
});
