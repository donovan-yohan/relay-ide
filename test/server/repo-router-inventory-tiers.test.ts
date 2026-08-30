// #1448: the three /hub read models that share the local repo scan must ask
// for the tier they actually consume. /hub/repo-groups projects identity
// coordinates only, so it must not pay for dirty/divergence/worktree git forks
// it immediately discards; /hub/repo-inventory and /hub/ia/tree must keep
// asking for the full report.

import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';

import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';

import { createHubNodeRegistry } from '../../server/hub-node-registry.js';
import { createRepoInventoryFeature } from '../../server/features/repo-inventory.js';
import { createRepoFeatureRouter } from '../../server/features/repo-router.js';
import type { RepoInventoryDetail } from '../../server/repo-inventory.js';
import type { RepoInventoryReport } from '../../shared/repo-inventory.js';

const cleanup: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()?.();
});

function localReport(): RepoInventoryReport {
  return {
    nodeId: 'hub-local',
    generatedAt: '2026-08-29T00:00:00.000Z',
    repos: [
      {
        repoInstanceId: 'hub-local:%2Fvar%2Frelay%2Frelay-ide',
        nodeId: 'hub-local',
        localPath: '/var/relay/relay-ide',
        name: 'relay-ide',
        isGitRepo: true,
        defaultBranch: 'nightly',
        currentBranch: 'nightly',
        repoIdentity: 'github.com/donovan-yohan/relay-ide',
        selectedRemote: null,
        remotes: [],
        repoIdentityWarnings: [],
        dirty: null,
        divergence: null,
        worktrees: [],
        reportedAt: '2026-08-29T00:00:00.000Z',
      },
    ],
  };
}

async function bootHub(): Promise<{
  base: string;
  requestedDetails: Array<RepoInventoryDetail | undefined>;
}> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-repo-tiers-'));
  cleanup.push(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const registry = createHubNodeRegistry({
    storagePath: path.join(tmpDir, 'nodes.json'),
    now: () => new Date('2026-08-29T00:00:00.000Z'),
  });
  const requestedDetails: Array<RepoInventoryDetail | undefined> = [];
  const app = express();
  app.use(express.json());
  app.use(
    createRepoFeatureRouter({
      registry,
      requireAuth: (_req, _res, next) => next(),
      repoInventoryFeature: createRepoInventoryFeature(registry),
      collectLocalRepoInventory: async (detail) => {
        requestedDetails.push(detail);
        return localReport();
      },
      now: () => new Date('2026-08-29T00:00:00.000Z'),
    })
  );
  const server = http.createServer(app);
  const port = await new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve((server.address() as { port: number }).port);
    });
  });
  cleanup.push(
    () => new Promise<void>((resolve) => server.close(() => resolve()))
  );
  return { base: `http://127.0.0.1:${port}`, requestedDetails };
}

describe('hub repo read models request the tier they consume', () => {
  it('GET /hub/repo-groups asks for the identity tier', async () => {
    const { base, requestedDetails } = await bootHub();
    const res = await fetch(`${base}/hub/repo-groups`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { groups: Array<{ instances: unknown[] }> };
    expect(body.groups).toHaveLength(1);
    expect(requestedDetails).toEqual(['identity']);
  });

  it('GET /hub/repo-inventory and /hub/ia/tree still ask for the full report', async () => {
    const { base, requestedDetails } = await bootHub();
    expect((await fetch(`${base}/hub/repo-inventory`)).status).toBe(200);
    expect((await fetch(`${base}/hub/ia/tree`)).status).toBe(200);
    expect(requestedDetails).toEqual([undefined, undefined]);
  });

  it('keeps the /hub/repo-groups response shape unchanged', async () => {
    const { base } = await bootHub();
    const body = (await (await fetch(`${base}/hub/repo-groups`)).json()) as {
      generatedAt: string;
      groups: Array<Record<string, unknown>>;
    };
    expect(body.generatedAt).toBe('2026-08-29T00:00:00.000Z');
    expect(Object.keys(body.groups[0]!).sort()).toEqual([
      'displayName',
      'instanceCount',
      'instances',
      'nodeIds',
      'repoIdentity',
      'warnings',
    ]);
  });
});
