import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import express from 'express';
import type { Server } from 'node:http';

import { createWorkspaceRouter } from '../server/workspaces.js';
import { saveConfig, DEFAULTS } from '../server/config.js';

let tmpDir: string;
let configPath: string;
let repoDir: string;
let server: Server;
let baseUrl: string;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'changed-files-test-'));
  configPath = path.join(tmpDir, 'config.json');
  repoDir = path.join(tmpDir, 'repo');
  fs.mkdirSync(path.join(repoDir, '.git'), { recursive: true });

  saveConfig(configPath, { ...DEFAULTS, workspaces: [repoDir] });

  const app = express();
  app.use(express.json());

  const mockExec = async (file: string, args: string[], _opts: { cwd: string }) => {
    if (args[0] === 'status' && args.includes('--porcelain=v1')) {
      return { stdout: ' M server/git.ts\0?? new-file.ts\0', stderr: '' };
    }
    if (args[0] === 'diff' && args.includes('--numstat')) {
      return { stdout: '10\t2\tserver/git.ts\n', stderr: '' };
    }
    if (args[0] === 'diff' && args.includes('--unified=3')) {
      return { stdout: 'diff output for file', stderr: '' };
    }
    if (file === 'wc') {
      return { stdout: '      20 new-file.ts', stderr: '' };
    }
    if (args[0] === 'rev-parse' && args[1] === '--git-dir') {
      return { stdout: '.git\n', stderr: '' };
    }
    if (args[0] === 'symbolic-ref') {
      return { stdout: 'origin/main\n', stderr: '' };
    }
    return { stdout: '', stderr: '' };
  };

  app.use('/workspaces', createWorkspaceRouter({ configPath, execAsync: mockExec as any }));

  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  const addr = server.address() as { port: number };
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
  server?.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('GET /workspaces/changed-files', () => {
  test('returns changed files for a workspace', async () => {
    const res = await fetch(`${baseUrl}/workspaces/changed-files?path=${encodeURIComponent(repoDir)}`);
    assert.equal(res.status, 200);
    const data = await res.json() as any;
    assert.ok(Array.isArray(data.files));
    assert.ok(data.aggregate);
    assert.equal(data.aggregate.fileCount, 2);
  });

  test('returns 400 without path parameter', async () => {
    const res = await fetch(`${baseUrl}/workspaces/changed-files`);
    assert.equal(res.status, 400);
  });
});

describe('GET /workspaces/file-diff', () => {
  test('returns diff for a specific file', async () => {
    const res = await fetch(`${baseUrl}/workspaces/file-diff?path=${encodeURIComponent(repoDir)}&file=server/git.ts`);
    assert.equal(res.status, 200);
    const data = await res.json() as any;
    assert.ok(typeof data.diff === 'string');
  });

  test('returns 400 without file parameter', async () => {
    const res = await fetch(`${baseUrl}/workspaces/file-diff?path=${encodeURIComponent(repoDir)}`);
    assert.equal(res.status, 400);
  });
});
