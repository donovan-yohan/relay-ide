// #1287 slice 2 — add-project must produce a sidebar lane.
//
// Regression suite for the verified defect: `POST /workspaces/bulk` registered
// the path in `config.repos` / `config.repoSettings` and NOTHING else, while
// `ia_workspaces` (what the sidebar renders) was written only by the one-shot,
// marker-guarded boot migration and by an HTTP CRUD with zero frontend callers.
// After first boot the workspace-group lane was therefore unpopulatable on
// every install.
//
// Properties pinned here:
//   1. bulk-add writes a REAL `ia_workspaces` row, in `ws:<localId>` grammar,
//      named from the repo basename, with membership that equals the ProjectId
//      `GET /hub/ia/tree` derives for the same repo;
//   2. re-add is idempotent — the same row is reused, never duplicated, and a
//      user rename survives;
//   3. a duplicate add still SURFACES the lane (not only an "Already exists"
//      error), and backfills a lane for repos registered before this change;
//   4. no IA store → the add still succeeds exactly as before.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { saveConfig, DEFAULTS } from '../server/config.js';
import { createIaStore, type IaStore } from '../server/ia-store.js';
import { createWorkspaceRouter } from '../server/workspaces.js';
import { projectWorkspaceId } from '../server/project-workspace.js';
import { repoInstanceProjectId } from '../server/features/ia-tree.js';
import { DEFAULT_LOCAL_NODE_ID } from '../shared/identity.js';
import { parseWorkspaceId } from '../shared/workspace.js';
import type { Config } from '../server/types.js';
import { createTestServer } from './helpers/test-server.js';

vi.mock('../server/logger.js', () => ({
  createLogger: () => ({
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

const tmpDirs: string[] = [];
const openStores: IaStore[] = [];

function makeDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

function makeStore(): IaStore {
  const store = createIaStore(path.join(makeDir('relay-pw-db-'), 'ia.db'));
  openStores.push(store);
  return store;
}

afterEach(() => {
  while (openStores.length) {
    try {
      openStores.pop()!.close();
    } catch {
      /* already closed */
    }
  }
  while (tmpDirs.length) {
    fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

const REMOTE_URL = 'git@github.com:donovan-yohan/relay-ide.git';

/** Minimal git mock: every path is a git repo on `nightly` with one origin. */
function makeExec(gitRepo: boolean) {
  return async (_file: string, args: string[], opts?: { cwd?: string }) => {
    if (!opts?.cwd) throw new Error('cwd required');
    const joined = args.join(' ');
    if (joined === 'rev-parse --git-dir') {
      if (!gitRepo) {
        const err = new Error('not a git repository') as Error & {
          code?: number;
          stderr?: string;
        };
        err.code = 128;
        err.stderr =
          'fatal: not a git repository (or any of the parent directories): .git';
        throw err;
      }
      return { stdout: '.git\n', stderr: '' };
    }
    if (joined === 'symbolic-ref refs/remotes/origin/HEAD --short') {
      return { stdout: 'origin/nightly\n', stderr: '' };
    }
    if (joined === 'symbolic-ref --short HEAD') {
      return { stdout: 'nightly\n', stderr: '' };
    }
    if (joined === 'remote -v') {
      return {
        stdout: [
          `origin\t${REMOTE_URL} (fetch)`,
          `origin\t${REMOTE_URL} (push)`,
        ].join('\n'),
        stderr: '',
      };
    }
    if (joined === 'remote get-url origin') {
      return { stdout: `${REMOTE_URL}\n`, stderr: '' };
    }
    throw new Error(`unexpected git args: ${joined}`);
  };
}

interface BulkResponse {
  added: Array<{ path: string }>;
  errors: Array<{ path: string; error: string }>;
  workspaces?: Array<{
    path: string;
    workspaceId: string;
    name: string;
    created: boolean;
    archived: boolean;
  }>;
}

interface Harness {
  repo: string;
  bulk: (paths: string[]) => Promise<BulkResponse>;
  close: () => Promise<void>;
}

async function makeHarness(options: {
  iaStore?: IaStore | null;
  gitRepo?: boolean;
  repoName?: string;
  seedConfigRepos?: boolean;
}): Promise<Harness> {
  const root = makeDir('relay-pw-');
  const repo = path.join(root, options.repoName ?? 'relay-ide');
  fs.mkdirSync(repo, { recursive: true });
  const configPath = path.join(root, 'config.json');
  const overrides: Partial<Config> = {
    repos: options.seedConfigRepos ? [repo] : [],
  };
  saveConfig(configPath, { ...DEFAULTS, ...overrides });

  const app = express();
  app.use(express.json());
  app.use(
    '/workspaces',
    createWorkspaceRouter({
      configPath,
      iaStore: options.iaStore ?? null,
      execAsync: makeExec(options.gitRepo ?? true) as never,
    })
  );
  const { url, close } = await createTestServer(app);

  return {
    repo,
    close,
    bulk: async (paths: string[]) => {
      const response = await fetch(`${url}/workspaces/bulk`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paths }),
      });
      expect(response.status).toBe(201);
      return (await response.json()) as BulkResponse;
    },
  };
}

describe('#1287 add-project writes the sidebar workspace lane', () => {
  it('creates an ia_workspaces row for each bulk-added repo', async () => {
    const iaStore = makeStore();
    const h = await makeHarness({ iaStore });
    try {
      const before = iaStore.listWorkspaces({ includeArchived: true });
      expect(before).toHaveLength(0);

      const result = await h.bulk([h.repo]);
      expect(result.errors).toEqual([]);
      expect(result.added.map((a) => a.path)).toEqual([h.repo]);

      // THE defect: this list used to be empty forever after first boot.
      const rows = iaStore.listWorkspaces({ includeArchived: true });
      expect(rows).toHaveLength(1);
      const row = rows[0]!;

      // Grammar: must be an id `ia_workspaces` can actually mint, so the
      // sidebar's `knownIds.has(workspaceId)` lookup can succeed.
      expect(parseWorkspaceId(row.id)).not.toBeNull();
      expect(row.id).toBe(projectWorkspaceId(h.repo));
      expect(row.name).toBe(path.basename(h.repo));
      expect(row.defaultRepoPath).toBe(h.repo);
      expect(row.status).toBe('active');

      // Membership lines up byte-for-byte with the ProjectId the IA tree emits
      // for the same repo — otherwise the lane would group nothing.
      expect(row.projectIds).toEqual([
        repoInstanceProjectId({
          repoInstanceId: `${DEFAULT_LOCAL_NODE_ID}:${encodeURIComponent(h.repo)}`,
          nodeId: DEFAULT_LOCAL_NODE_ID,
          localPath: h.repo,
          name: path.basename(h.repo),
          isGitRepo: true,
          defaultBranch: 'nightly',
          currentBranch: 'nightly',
          repoIdentity: 'github.com/donovan-yohan/relay-ide',
          selectedRemote: null,
          remotes: [],
          repoIdentityWarnings: [],
          worktrees: [],
          reportedAt: '',
        }),
      ]);

      // And the route reports the lane back so the client can reveal it.
      expect(result.workspaces).toEqual([
        {
          path: h.repo,
          workspaceId: row.id,
          name: row.name,
          created: true,
          archived: false,
        },
      ]);
    } finally {
      await h.close();
    }
  });

  it('files a non-git directory under a directory-kind project lane', async () => {
    const iaStore = makeStore();
    const h = await makeHarness({ iaStore, gitRepo: false, repoName: 'notes' });
    try {
      const result = await h.bulk([h.repo]);
      expect(result.errors).toEqual([]);

      const row = iaStore.getWorkspace(projectWorkspaceId(h.repo));
      expect(row).not.toBeNull();
      expect(row!.name).toBe('notes');
      expect(row!.projectIds).toEqual([
        repoInstanceProjectId({
          repoInstanceId: `${DEFAULT_LOCAL_NODE_ID}:${encodeURIComponent(h.repo)}`,
          nodeId: DEFAULT_LOCAL_NODE_ID,
          localPath: h.repo,
          name: 'notes',
          isGitRepo: false,
          defaultBranch: null,
          currentBranch: null,
          repoIdentity: null,
          selectedRemote: null,
          remotes: [],
          repoIdentityWarnings: [],
          worktrees: [],
          reportedAt: '',
        }),
      ]);
    } finally {
      await h.close();
    }
  });

  it('is idempotent on re-add: reuses the row, never duplicates, keeps renames', async () => {
    const iaStore = makeStore();
    const h = await makeHarness({ iaStore });
    try {
      const first = await h.bulk([h.repo]);
      const id = first.workspaces![0]!.workspaceId;

      // The user renames + pins their lane between the two adds.
      const seeded = iaStore.getWorkspace(id)!;
      iaStore.upsertWorkspace({
        id,
        name: 'My Lane',
        order: seeded.order,
        projectIds: seeded.projectIds,
        pinned: true,
      });

      const second = await h.bulk([h.repo]);

      // Re-adding an already-registered repo is still reported as a duplicate…
      expect(second.added).toEqual([]);
      expect(second.errors).toEqual([
        { path: h.repo, error: 'Already exists' },
      ]);
      // …but the EXISTING lane is surfaced rather than only the error.
      expect(second.workspaces).toEqual([
        {
          path: h.repo,
          workspaceId: id,
          name: 'My Lane',
          created: false,
          archived: false,
        },
      ]);

      // Exactly one row, and the user's edits survived untouched.
      const rows = iaStore.listWorkspaces({ includeArchived: true });
      expect(rows).toHaveLength(1);
      expect(rows[0]!.id).toBe(id);
      expect(rows[0]!.name).toBe('My Lane');
      expect(rows[0]!.pinned).toBe(true);
      expect(rows[0]!.projectIds).toEqual(seeded.projectIds);
    } finally {
      await h.close();
    }
  });

  it('backfills a lane for a repo registered before #1287', async () => {
    const iaStore = makeStore();
    // `config.repos` already holds the path (pre-#1287 install) but no
    // `ia_workspaces` row exists — the live prod state this slice repairs.
    const h = await makeHarness({ iaStore, seedConfigRepos: true });
    try {
      expect(iaStore.listWorkspaces({ includeArchived: true })).toHaveLength(0);

      const result = await h.bulk([h.repo]);
      expect(result.added).toEqual([]);
      expect(result.errors).toEqual([
        { path: h.repo, error: 'Already exists' },
      ]);
      expect(result.workspaces).toEqual([
        {
          path: h.repo,
          workspaceId: projectWorkspaceId(h.repo),
          name: path.basename(h.repo),
          created: true,
          archived: false,
        },
      ]);

      // The backfilled lane MUST carry membership. The duplicate path used to
      // pass `projectId: undefined`, and since every later duplicate add did
      // the same, the `projectIds: []` it seeded could never be filled — the
      // lane rendered in the sidebar forever while grouping nothing.
      const rows = iaStore.listWorkspaces({ includeArchived: true });
      expect(rows).toHaveLength(1);
      expect(rows[0]!.projectIds).toEqual([
        repoInstanceProjectId({
          repoInstanceId: `${DEFAULT_LOCAL_NODE_ID}:${encodeURIComponent(h.repo)}`,
          nodeId: DEFAULT_LOCAL_NODE_ID,
          localPath: h.repo,
          name: path.basename(h.repo),
          isGitRepo: true,
          defaultBranch: 'nightly',
          currentBranch: 'nightly',
          repoIdentity: 'github.com/donovan-yohan/relay-ide',
          selectedRemote: null,
          remotes: [],
          repoIdentityWarnings: [],
          worktrees: [],
          reportedAt: '',
        }),
      ]);
    } finally {
      await h.close();
    }
  });

  it('reports an archived lane as archived instead of claiming success', async () => {
    const iaStore = makeStore();
    const h = await makeHarness({ iaStore, seedConfigRepos: true });
    try {
      const id = projectWorkspaceId(h.repo);
      iaStore.upsertWorkspace({
        id,
        name: 'Retired lane',
        order: 3,
        projectIds: [],
        status: 'archived',
      });

      const result = await h.bulk([h.repo]);

      // Non-clobber: the archive survives, and membership is still backfilled
      // so the lane is useful the moment it is restored.
      const row = iaStore.getWorkspace(id)!;
      expect(row.status).toBe('archived');
      expect(row.name).toBe('Retired lane');
      expect(row.projectIds).toHaveLength(1);

      // But the client is TOLD it is archived. `listWorkspaces()` hides
      // archived rows, so reporting this as a ready lane would promise the user
      // a lane that never appears.
      expect(iaStore.listWorkspaces()).toEqual([]);
      expect(result.workspaces).toEqual([
        {
          path: h.repo,
          workspaceId: id,
          name: 'Retired lane',
          created: false,
          archived: true,
        },
      ]);
    } finally {
      await h.close();
    }
  });

  it('orders new lanes after existing ones without disturbing them', async () => {
    const iaStore = makeStore();
    const h = await makeHarness({ iaStore });
    try {
      iaStore.upsertWorkspace({
        id: 'ws:local',
        name: 'Local',
        order: -1,
        projectIds: [],
      });
      iaStore.upsertWorkspace({
        id: 'ws:hand-made',
        name: 'Hand made',
        order: 4,
        projectIds: [],
      });

      await h.bulk([h.repo]);

      expect(iaStore.getWorkspace(projectWorkspaceId(h.repo))!.order).toBe(5);
      expect(iaStore.getWorkspace('ws:local')!.order).toBe(-1);
      expect(iaStore.getWorkspace('ws:hand-made')!.order).toBe(4);
    } finally {
      await h.close();
    }
  });

  it('still adds the repo when no IA store is wired', async () => {
    const h = await makeHarness({ iaStore: null });
    try {
      const result = await h.bulk([h.repo]);
      expect(result.errors).toEqual([]);
      expect(result.added.map((a) => a.path)).toEqual([h.repo]);
      expect(result.workspaces).toEqual([]);
    } finally {
      await h.close();
    }
  });
});
