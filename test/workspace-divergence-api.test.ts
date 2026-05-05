import express from 'express';
import type { Server } from 'node:http';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULTS, saveConfig } from '../server/config.js';
import { createWorkspaceRouter } from '../server/workspaces.js';

const execFileAsync = promisify(execFile);

let tmpDir: string;
let configPath: string;
let repoPath: string;
let server: Server;
let baseUrl: string;

async function git(args: string[], cwd = repoPath): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, timeout: 10_000 });
  return stdout;
}

function write(relPath: string, content: string): void {
  const abs = path.join(repoPath, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
}

async function commit(message: string): Promise<void> {
  await git(['add', '-A']);
  await git(['commit', '-m', message]);
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-divergence-api-'));
  configPath = path.join(tmpDir, 'config.json');
  repoPath = path.join(tmpDir, 'repo');
  fs.mkdirSync(repoPath, { recursive: true });
  await git(['init', '--initial-branch=main']);
  await git(['config', 'user.name', 'Relay Test']);
  await git(['config', 'user.email', 'relay@example.test']);
  write('base.txt', 'base\n');
  await commit('initial commit');
  saveConfig(configPath, { ...DEFAULTS, repos: [repoPath] });

  const app = express();
  app.use(express.json());
  app.use('/workspaces', createWorkspaceRouter({ configPath }));

  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  const addr = server.address() as { port: number };
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function endpoint(repo = repoPath, base = 'main'): string {
  return `${baseUrl}/workspaces/divergence?path=${encodeURIComponent(repo)}&base=${encodeURIComponent(base)}`;
}

describe('GET /workspaces/divergence', () => {
  it('requires a configured workspace path', async () => {
    const missingPath = await fetch(`${baseUrl}/workspaces/divergence`);
    expect(missingPath.status).toBe(400);
    expect(await missingPath.json()).toMatchObject({ state: 'not_git', error: 'path parameter required' });

    const forbidden = await fetch(endpoint(path.join(tmpDir, 'other'), 'main'));
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toMatchObject({
      state: 'not_git',
      error: 'path not in configured workspaces',
    });
  });

  it('rejects unsafe base refs before git commands', async () => {
    const res = await fetch(endpoint(repoPath, '--upload-pack=/tmp/nope'));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toMatchObject({ state: 'invalid_base', error: 'invalid base ref' });
  });

  it('returns a display-ready divergence summary for configured repo subpaths', async () => {
    await git(['checkout', '-b', 'feature']);
    write('src/feature.ts', 'export const feature = true;\n');
    await commit('add feature');
    write('dirty.txt', 'dirty\n');

    const subdir = path.join(repoPath, 'src');
    const res = await fetch(endpoint(subdir, 'main'));
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body).toMatchObject({
      repoPath: fs.realpathSync(repoPath),
      currentBranch: 'feature',
      state: 'ok',
      aheadCount: 1,
      behindCount: 0,
      selectedBase: { ref: 'main' },
      lineDelta: { additions: 1, deletions: 0, fileCount: 1 },
      dirty: { untrackedCount: 1 },
    });
    expect(body.headSha).toMatch(/^[0-9a-f]{40}$/);
    expect(body.commits.ahead[0]).toMatchObject({ subject: 'add feature', author: 'Relay Test' });
    expect(body.baseCandidates.map((c: { ref: string }) => c.ref)).toContain('main');
    expect(typeof body.generatedAt).toBe('string');
  });
});
