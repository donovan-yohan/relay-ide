// #624 server-level aggregation coverage. Pairs with the shared-layer
// normalizer tests in test/shared/repo-identity.test.ts.
//
// Scope:
//   - aggregateRepoInventoryReports / summarizeRepoIdentityGroups collapse
//     N nodes with the same canonical RepoIdentity into one group while
//     preserving node-local paths;
//   - non-git inventory entries (repoIdentity === null) are returned as
//     graceful "unidentified" groups, not errors;
//   - GET /hub/repo-groups exposes the slim grouped shape and refuses
//     unauthenticated callers.

import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';

import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createHubNodeRegistry } from '../../server/hub-node-registry.js';
import {
  createRepoInventoryFeature,
} from '../../server/features/repo-inventory.js';
import { createRepoFeatureRouter } from '../../server/features/repo-router.js';
import {
  aggregateRepoInventoryReports,
  summarizeRepoIdentityGroups,
  type RepoInventoryRepoInstance,
  type RepoInventoryReport,
} from '../../shared/repo-inventory.js';
import {
  normalizeRemoteUrl,
  type ResolvedRemoteIdentity,
} from '../../shared/repo-identity.js';
import type { NodeManifest } from '../../shared/node-manifest.js';

function resolvedRemote(name: string, url: string): ResolvedRemoteIdentity {
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

function repoInstance(
  overrides: Partial<RepoInventoryRepoInstance> & {
    nodeId: string;
    localPath: string;
  }
): RepoInventoryRepoInstance {
  const remote = overrides.selectedRemote ??
    resolvedRemote('origin', 'git@github.com:donovan-yohan/relay-ide.git');
  return {
    repoInstanceId:
      overrides.repoInstanceId ??
      `${overrides.nodeId}:${encodeURIComponent(overrides.localPath)}`,
    nodeId: overrides.nodeId,
    localPath: overrides.localPath,
    name: overrides.name ?? 'relay-ide',
    isGitRepo: overrides.isGitRepo ?? true,
    defaultBranch: overrides.defaultBranch ?? 'nightly',
    currentBranch: overrides.currentBranch ?? 'nightly',
    repoIdentity:
      'repoIdentity' in overrides ? overrides.repoIdentity ?? null : remote.identity,
    selectedRemote: 'selectedRemote' in overrides ? overrides.selectedRemote ?? null : remote,
    remotes: overrides.remotes ?? (remote.identity ? [remote] : []),
    repoIdentityWarnings: overrides.repoIdentityWarnings ?? [],
    worktrees: overrides.worktrees ?? [],
    reportedAt: overrides.reportedAt ?? '2026-05-19T00:00:00.000Z',
  };
}

function inventoryReport(
  nodeId: string,
  repos: RepoInventoryRepoInstance[]
): RepoInventoryReport {
  return {
    nodeId,
    generatedAt: '2026-05-19T00:00:00.000Z',
    repos,
  };
}

describe('aggregateRepoInventoryReports (#624 backend grouping)', () => {
  it('collapses two nodes with the same RepoIdentity but different local paths into one group', () => {
    const macRemote = resolvedRemote(
      'origin',
      'git@github.com:donovan-yohan/relay-ide.git'
    );
    const linuxRemote = resolvedRemote(
      'origin',
      'https://github.com/donovan-yohan/relay-ide.git'
    );
    const result = aggregateRepoInventoryReports([
      inventoryReport('macbook', [
        repoInstance({
          nodeId: 'macbook',
          localPath: '/Users/kyle/dev/relay-ide',
          selectedRemote: macRemote,
          remotes: [macRemote],
        }),
      ]),
      inventoryReport('linux-box', [
        repoInstance({
          nodeId: 'linux-box',
          localPath: '/srv/repos/relay-ide',
          selectedRemote: linuxRemote,
          remotes: [linuxRemote],
        }),
      ]),
    ]);
    expect(result.groups).toHaveLength(1);
    const [group] = result.groups;
    expect(group?.repoIdentity).toBe('github.com/donovan-yohan/relay-ide');
    expect(group?.identityDebug.instanceCount).toBe(2);
    expect(group?.identityDebug.nodeIds.sort()).toEqual(
      ['linux-box', 'macbook']
    );
    expect(group?.instances.map((i) => [i.nodeId, i.localPath])).toEqual([
      ['linux-box', '/srv/repos/relay-ide'],
      ['macbook', '/Users/kyle/dev/relay-ide'],
    ]);
  });

  it('returns a graceful unidentified group for non-git cwds (absence, not error)', () => {
    expect(() =>
      aggregateRepoInventoryReports([
        inventoryReport('macbook', [
          repoInstance({
            nodeId: 'macbook',
            localPath: '/Users/kyle/scratch',
            name: 'scratch',
            isGitRepo: false,
            defaultBranch: null,
            currentBranch: null,
            repoIdentity: null,
            selectedRemote: null,
            remotes: [],
          }),
        ]),
      ])
    ).not.toThrow();
    const result = aggregateRepoInventoryReports([
      inventoryReport('macbook', [
        repoInstance({
          nodeId: 'macbook',
          localPath: '/Users/kyle/scratch',
          name: 'scratch',
          isGitRepo: false,
          defaultBranch: null,
          currentBranch: null,
          repoIdentity: null,
          selectedRemote: null,
          remotes: [],
        }),
      ]),
    ]);
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]?.repoIdentity).toBeNull();
    expect(result.groups[0]?.identityDebug.groupedBy).toBe('repoInstanceId');
  });
});

describe('summarizeRepoIdentityGroups (#624 slim view)', () => {
  it('returns the same grouping shape as the full aggregator without dirty/worktree payloads', () => {
    const linuxRemote = resolvedRemote(
      'origin',
      'https://github.com/donovan-yohan/relay-ide.git'
    );
    const result = summarizeRepoIdentityGroups([
      inventoryReport('macbook', [
        repoInstance({
          nodeId: 'macbook',
          localPath: '/Users/kyle/dev/relay-ide',
          worktrees: [
            {
              worktreeInstanceId:
                'macbook:%2FUsers%2Fkyle%2Fdev%2Frelay-ide%2F.worktrees%2Fa',
              localPath: '/Users/kyle/dev/relay-ide/.worktrees/a',
              branchName: 'feature/a',
            },
          ],
        }),
      ]),
      inventoryReport('linux-box', [
        repoInstance({
          nodeId: 'linux-box',
          localPath: '/srv/repos/relay-ide',
          selectedRemote: linuxRemote,
          remotes: [linuxRemote],
        }),
      ]),
    ]);
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]?.repoIdentity).toBe(
      'github.com/donovan-yohan/relay-ide'
    );
    expect(result.groups[0]?.nodeIds.sort()).toEqual([
      'linux-box',
      'macbook',
    ]);
    expect(result.groups[0]?.instances).toEqual([
      {
        nodeId: 'linux-box',
        repoInstanceId: 'linux-box:%2Fsrv%2Frepos%2Frelay-ide',
        localPath: '/srv/repos/relay-ide',
        currentBranch: 'nightly',
        defaultBranch: 'nightly',
      },
      {
        nodeId: 'macbook',
        repoInstanceId: 'macbook:%2FUsers%2Fkyle%2Fdev%2Frelay-ide',
        localPath: '/Users/kyle/dev/relay-ide',
        currentBranch: 'nightly',
        defaultBranch: 'nightly',
      },
    ]);
    // Slim shape must not carry dirty / worktrees / divergence fields per
    // RepoIdentityGroupInstance contract — guard against future drift.
    for (const instance of result.groups[0]?.instances ?? []) {
      expect(instance).not.toHaveProperty('worktrees');
      expect(instance).not.toHaveProperty('dirty');
      expect(instance).not.toHaveProperty('divergence');
    }
  });

  it('keeps unidentified groups visible (non-git cwd absence, not error)', () => {
    const result = summarizeRepoIdentityGroups([
      inventoryReport('macbook', [
        repoInstance({
          nodeId: 'macbook',
          localPath: '/Users/kyle/scratch',
          name: 'scratch',
          isGitRepo: false,
          defaultBranch: null,
          currentBranch: null,
          repoIdentity: null,
          selectedRemote: null,
          remotes: [],
        }),
      ]),
    ]);
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]?.repoIdentity).toBeNull();
    expect(result.groups[0]?.instanceCount).toBe(1);
    expect(result.groups[0]?.instances[0]?.localPath).toBe(
      '/Users/kyle/scratch'
    );
  });

  it('round-trips the slim response through JSON without dropping fields', () => {
    const original = summarizeRepoIdentityGroups([
      inventoryReport('macbook', [
        repoInstance({ nodeId: 'macbook', localPath: '/repo' }),
      ]),
    ]);
    expect(JSON.parse(JSON.stringify(original))).toEqual(original);
  });
});

describe('GET /hub/repo-groups (#624 endpoint)', () => {
  const cleanup: Array<() => Promise<void> | void> = [];

  function listen(server: http.Server): Promise<number> {
    return new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (typeof address !== 'object' || address === null) {
          throw new Error('listen did not return an address');
        }
        resolve(address.port);
      });
    });
  }

  function close(server: http.Server): Promise<void> {
    return new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }

  function manifest(): NodeManifest {
    return {
      schemaVersion: 1,
      platform: 'linux',
      arch: 'x64',
      hostname: 'repo-groups-host',
      relayVersion: '0.1.0-test',
      generatedAt: '2026-05-19T00:00:00.000Z',
      wsl: { detected: false, version: null, systemd: false },
      serviceManager: {
        kind: 'systemd-user',
        label: 'systemd user',
        supported: true,
        installable: true,
        installHint: 'install',
        uninstallHint: 'uninstall',
        message: 'ok',
      },
      capabilities: {
        tmux: { status: 'available', message: 'tmux 3.4' },
        git: { status: 'available', message: 'git 2.45.0' },
        clipboard: { status: 'available', message: 'pbcopy' },
        browserAutomation: { status: 'available', message: 'playwright ok' },
        githubCli: { status: 'available', message: 'gh 2.51' },
        tailscale: { status: 'available', message: 'tailscale 1.62' },
        ssh: { status: 'available', message: 'OpenSSH 9.7' },
        agents: {},
      },
    };
  }

  beforeEach(() => {
    cleanup.length = 0;
  });

  afterEach(async () => {
    while (cleanup.length > 0) await cleanup.pop()?.();
  });

  async function bootHub(): Promise<{
    base: string;
    nodeIds: string[];
    tokens: string[];
  }> {
    const tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'relay-repo-groups-')
    );
    cleanup.push(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
    const registry = createHubNodeRegistry({
      storagePath: path.join(tmpDir, 'nodes.json'),
      now: () => new Date('2026-05-19T00:00:00.000Z'),
    });
    const feature = createRepoInventoryFeature(registry);
    const app = express();
    app.use(express.json());
    const requireAuth: express.RequestHandler = (req, res, next) => {
      if (req.headers['x-test-auth'] === 'yes') {
        next();
        return;
      }
      res.status(401).json({ error: 'Unauthorized' });
    };
    app.use(
      createRepoFeatureRouter({
        registry,
        requireAuth,
        repoInventoryFeature: feature,
        // Inject a synthetic "local" inventory for the hub node itself so
        // the endpoint exercises the cross-node aggregation path.
        collectLocalRepoInventory: async () =>
          inventoryReport('hub-local', [
            repoInstance({
              nodeId: 'hub-local',
              localPath: '/var/relay/relay-ide',
            }),
          ]),
        now: () => new Date('2026-05-19T00:00:00.000Z'),
      })
    );
    const server = http.createServer(app);
    const port = await listen(server);
    cleanup.push(() => close(server));

    const nodeIds: string[] = [];
    const tokens: string[] = [];
    for (const _ of [0, 1]) {
      const exchanged = registry.exchangePairToken({
        pairToken: registry.createPairToken({}).pairToken,
        manifest: manifest(),
      });
      nodeIds.push(exchanged.node.nodeId);
      tokens.push(exchanged.credential.token);
    }

    // First paired node: same RepoIdentity, different local path
    registry.recordHeartbeat({
      nodeId: nodeIds[0]!,
      protocolVersion: '1.0',
      repoInventory: inventoryReport(nodeIds[0]!, [
        repoInstance({
          nodeId: nodeIds[0]!,
          localPath: '/Users/kyle/dev/relay-ide',
          selectedRemote: resolvedRemote(
            'origin',
            'git@github.com:donovan-yohan/relay-ide.git'
          ),
          remotes: [
            resolvedRemote(
              'origin',
              'git@github.com:donovan-yohan/relay-ide.git'
            ),
          ],
        }),
      ]),
    });
    // Second paired node: non-git cwd, should land as a separate
    // unidentified group (graceful absence, not error).
    registry.recordHeartbeat({
      nodeId: nodeIds[1]!,
      protocolVersion: '1.0',
      repoInventory: inventoryReport(nodeIds[1]!, [
        repoInstance({
          nodeId: nodeIds[1]!,
          localPath: '/srv/scratch',
          name: 'scratch',
          isGitRepo: false,
          defaultBranch: null,
          currentBranch: null,
          repoIdentity: null,
          selectedRemote: null,
          remotes: [],
        }),
      ]),
    });

    return { base: `http://127.0.0.1:${port}`, nodeIds, tokens };
  }

  it('refuses unauthenticated callers', async () => {
    const { base } = await bootHub();
    const response = await fetch(`${base}/hub/repo-groups`);
    expect(response.status).toBe(401);
  });

  it('returns one cross-node group for the same RepoIdentity and a separate unidentified group', async () => {
    const { base, nodeIds } = await bootHub();
    const response = await fetch(`${base}/hub/repo-groups`, {
      headers: { 'x-test-auth': 'yes' },
    });
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      generatedAt: string;
      groups: Array<{
        repoIdentity: string | null;
        instanceCount: number;
        nodeIds: string[];
        instances: Array<{ nodeId: string; localPath: string }>;
      }>;
    };
    expect(typeof payload.generatedAt).toBe('string');

    const relay = payload.groups.find(
      (group) => group.repoIdentity === 'github.com/donovan-yohan/relay-ide'
    );
    expect(relay).toBeDefined();
    expect(relay?.instanceCount).toBe(2);
    expect(relay?.nodeIds.sort()).toEqual(['hub-local', nodeIds[0]!].sort());
    expect(
      relay?.instances.map((instance) => instance.localPath).sort()
    ).toEqual(['/Users/kyle/dev/relay-ide', '/var/relay/relay-ide']);

    const unidentified = payload.groups.find(
      (group) => group.repoIdentity === null
    );
    expect(unidentified).toBeDefined();
    expect(unidentified?.instances[0]?.localPath).toBe('/srv/scratch');
    expect(unidentified?.instances[0]?.nodeId).toBe(nodeIds[1]);
  });
});
