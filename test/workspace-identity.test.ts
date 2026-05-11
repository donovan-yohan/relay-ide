import { describe, expect, it } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { saveConfig, DEFAULTS } from '../server/config.js';
import { createWorkspaceRouter } from '../server/workspaces.js';
import type { Config } from '../server/types.js';
import { createTestServer } from './helpers/test-server.js';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-identity-'));

function makeTempConfig(name: string, overrides: Partial<Config>): string {
  const configPath = path.join(tmpDir, `${name}.json`);
  saveConfig(configPath, { ...DEFAULTS, ...overrides });
  return configPath;
}

function makeExec(remotes: Record<string, Array<{ name: string; url: string }>>) {
  return async (_file: string, args: string[], opts?: { cwd?: string }) => {
    const cwd = opts?.cwd;
    if (!cwd) throw new Error('cwd required');

    if (args.join(' ') === 'rev-parse --git-dir') {
      return { stdout: '.git\n', stderr: '' };
    }

    if (args.join(' ') === 'symbolic-ref refs/remotes/origin/HEAD --short') {
      return { stdout: 'origin/nightly\n', stderr: '' };
    }

    if (args.join(' ') === 'remote -v') {
      const repoRemotes = remotes[cwd] ?? [];
      return {
        stdout: repoRemotes
          .flatMap((remote) => [
            `${remote.name}\t${remote.url} (fetch)`,
            `${remote.name}\t${remote.url} (push)`,
          ])
          .join('\n'),
        stderr: '',
      };
    }

    if (args.join(' ') === 'remote get-url origin') {
      const remote = (remotes[cwd] ?? []).find((item) => item.name === 'origin');
      if (!remote) throw new Error(`no origin for ${cwd}`);
      return { stdout: `${remote.url}\n`, stderr: '' };
    }

    if (args.join(' ') === 'symbolic-ref --short HEAD') {
      return { stdout: 'nightly\n', stderr: '' };
    }

    throw new Error(`unexpected git args: ${args.join(' ')}`);
  };
}

describe('workspace repo identity', () => {
  it('exposes canonical identity plus node-local path and instance ids', async () => {
    const repo = path.join(tmpDir, 'relay-ide');
    fs.mkdirSync(repo, { recursive: true });
    const configPath = makeTempConfig('identity', { repos: [repo] });
    const app = express();
    app.use(express.json());
    app.use(
      '/workspaces',
      createWorkspaceRouter({
        configPath,
        execAsync: makeExec({
          [repo]: [
            { name: 'origin', url: 'git@github.com:donovan-yohan/relay-ide.git' },
            { name: 'upstream', url: 'https://github.com/NousResearch/relay-ide.git' },
          ],
        }) as any,
      })
    );
    const { url, close } = await createTestServer(app);
    try {
      const response = await fetch(`${url}/workspaces`);
      expect(response.status).toBe(200);
      const payload = (await response.json()) as { workspaces: any[] };
      const workspace = payload.workspaces[0];

      expect(workspace.path).toBe(repo);
      expect(workspace.localPath).toBe(repo);
      expect(workspace.nodeId).toBe('local');
      expect(workspace.repoIdentity).toBe('github.com/donovan-yohan/relay-ide');
      expect(workspace.repoInstanceId).toBe(`local:${encodeURIComponent(repo)}`);
      expect(workspace.selectedRemote?.name).toBe('origin');
      expect(workspace.repoIdentityWarnings).toContain('fork-upstream-ambiguity');
      expect(workspace.remotes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'origin', identity: 'github.com/donovan-yohan/relay-ide' }),
          expect.objectContaining({ name: 'upstream', identity: 'github.com/nousresearch/relay-ide' }),
        ])
      );
    } finally {
      await close();
    }
  });

  it('includes identity fields for POST /workspaces/bulk added repos', async () => {
    const repo = path.join(tmpDir, 'bulk relay:repo');
    fs.mkdirSync(repo, { recursive: true });
    const configPath = makeTempConfig('bulk-identity', { repos: [] });
    const app = express();
    app.use(express.json());
    app.use(
      '/workspaces',
      createWorkspaceRouter({
        configPath,
        execAsync: makeExec({
          [repo]: [
            { name: 'origin', url: 'git@github.com:donovan-yohan/relay-ide.git' },
          ],
        }) as any,
      })
    );
    const { url, close } = await createTestServer(app);
    try {
      const response = await fetch(`${url}/workspaces/bulk`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paths: [repo] }),
      });
      expect(response.status).toBe(201);
      const payload = (await response.json()) as { added: any[]; errors: any[] };
      const workspace = payload.added[0];

      expect(payload.errors).toEqual([]);
      expect(workspace.path).toBe(repo);
      expect(workspace.localPath).toBe(repo);
      expect(workspace.nodeId).toBe('local');
      expect(workspace.repoIdentity).toBe('github.com/donovan-yohan/relay-ide');
      expect(workspace.repoInstanceId).toBe(`local:${encodeURIComponent(repo)}`);
      expect(workspace.selectedRemote?.name).toBe('origin');
      expect(workspace.selectedRemote?.identity).toBe(
        'github.com/donovan-yohan/relay-ide'
      );
      expect(workspace.remotes).toEqual([
        expect.objectContaining({
          name: 'origin',
          identity: 'github.com/donovan-yohan/relay-ide',
        }),
      ]);
      expect(workspace.repoIdentityWarnings).toEqual([]);
    } finally {
      await close();
    }
  });
});
