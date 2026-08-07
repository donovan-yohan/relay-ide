import { beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { saveConfig, DEFAULTS } from '../server/config.js';
import { createWorkspaceRouter } from '../server/workspaces.js';
import {
  clearWebhookEventTimestamps,
  recordWebhookEventForRepo,
} from '../server/webhook-manager.js';
import type { Config } from '../server/types.js';
import { createTestServer } from './helpers/test-server.js';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-webhook-status-'));

function makeTempConfig(name: string, overrides: Partial<Config>): string {
  const configPath = path.join(tmpDir, `${name}.json`);
  saveConfig(configPath, { ...DEFAULTS, ...overrides });
  return configPath;
}

function makeExecForRemotes(remotes: Record<string, string>) {
  return async (_file: string, args: string[], opts?: { cwd?: string }) => {
    const cwd = opts?.cwd;
    if (!cwd) throw new Error('cwd required');

    if (args.join(' ') === 'rev-parse --git-dir') {
      return { stdout: '.git\n', stderr: '' };
    }

    if (args.join(' ') === 'symbolic-ref refs/remotes/origin/HEAD --short') {
      return { stdout: 'origin/nightly\n', stderr: '' };
    }

    if (args.join(' ') === 'remote get-url origin') {
      const remote = remotes[cwd];
      if (!remote) throw new Error(`no remote for ${cwd}`);
      return { stdout: `${remote}\n`, stderr: '' };
    }

    if (args.join(' ') === 'symbolic-ref --short HEAD') {
      return { stdout: 'nightly\n', stderr: '' };
    }

    throw new Error(`unexpected git args: ${args.join(' ')}`);
  };
}

async function fetchWorkspaces(configPath: string, remotes: Record<string, string>) {
  const app = express();
  app.use(
    '/workspaces',
    createWorkspaceRouter({
      configPath,
      execAsync: makeExecForRemotes(remotes) as any,
    })
  );
  const { url, close } = await createTestServer(app);
  try {
    const response = await fetch(`${url}/workspaces`);
    expect(response.status).toBe(200);
    return (await response.json()) as {
      workspaces: Array<{
        path: string;
        webhookStatus: string;
        webhookError?: string;
        lastWebhookEventAt?: string;
      }>;
    };
  } finally {
    await close();
  }
}

describe('GET /workspaces webhookStatus', () => {
  beforeEach(() => {
    clearWebhookEventTimestamps();
  });

  it('maps webhook settings to live, manual, limited, and error states', async () => {
    const live = path.join(tmpDir, 'live');
    const manual = path.join(tmpDir, 'manual');
    const limited = path.join(tmpDir, 'limited');
    const missing = path.join(tmpDir, 'missing');
    const other = path.join(tmpDir, 'other');
    const repos = [live, manual, limited, missing, other];
    repos.forEach((repo) => fs.mkdirSync(repo, { recursive: true }));

    const configPath = makeTempConfig('states', {
      repos,
      repoSettings: {
        [live]: { webhookEnabled: true },
        [manual]: {},
        [limited]: { webhookError: 'not-admin' },
        [missing]: { webhookError: 'not-found' },
        [other]: { webhookError: 'github_error_500' },
      },
    });

    const payload = await fetchWorkspaces(configPath, {
      [live]: 'https://github.com/acme/live.git',
      [manual]: 'https://github.com/acme/manual.git',
      [limited]: 'https://github.com/acme/limited.git',
      [missing]: 'https://github.com/acme/missing.git',
      [other]: 'https://github.com/acme/other.git',
    });

    const byPath = Object.fromEntries(payload.workspaces.map((repo) => [repo.path, repo]));
    expect(byPath[live]?.webhookStatus).toBe('live');
    expect(byPath[live]?.webhookError).toBeUndefined();
    expect(byPath[manual]?.webhookStatus).toBe('manual');
    expect(byPath[manual]?.webhookError).toBeUndefined();
    expect(byPath[limited]?.webhookStatus).toBe('limited');
    expect(byPath[limited]?.webhookError).toBe('not-admin');
    expect(byPath[missing]?.webhookStatus).toBe('error');
    expect(byPath[missing]?.webhookError).toBe('not-found');
    expect(byPath[other]?.webhookStatus).toBe('error');
    expect(byPath[other]?.webhookError).toBe('github_error_500');
  });

  it('attaches the last webhook event timestamp to only the matching repo', async () => {
    const repoA = path.join(tmpDir, 'repo-a');
    const repoB = path.join(tmpDir, 'repo-b');
    fs.mkdirSync(repoA, { recursive: true });
    fs.mkdirSync(repoB, { recursive: true });

    const configPath = makeTempConfig('timestamps', {
      repos: [repoA, repoB],
      repoSettings: {
        [repoA]: { webhookEnabled: true },
        [repoB]: { webhookEnabled: true },
      },
    });

    const eventAt = recordWebhookEventForRepo(
      'acme/repo-a',
      new Date('2026-05-06T12:34:56.000Z')
    );

    const payload = await fetchWorkspaces(configPath, {
      [repoA]: 'https://github.com/acme/repo-a.git',
      [repoB]: 'https://github.com/acme/repo-b.git',
    });

    const byPath = Object.fromEntries(payload.workspaces.map((repo) => [repo.path, repo]));
    expect(byPath[repoA]?.lastWebhookEventAt).toBe(eventAt);
    expect(byPath[repoB]?.lastWebhookEventAt).toBeUndefined();
  });
});
