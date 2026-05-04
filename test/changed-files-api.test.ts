import { describe, test, beforeAll, afterAll, expect } from 'vitest';
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

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'changed-files-test-'));
  configPath = path.join(tmpDir, 'config.json');
  repoDir = path.join(tmpDir, 'repo');
  fs.mkdirSync(path.join(repoDir, '.git'), { recursive: true });

  saveConfig(configPath, { ...DEFAULTS, repos: [repoDir] });

  const app = express();
  app.use(express.json());

  const mockExec = async (
    file: string,
    args: string[],
    _opts: { cwd: string }
  ) => {
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

  app.use(
    '/workspaces',
    createWorkspaceRouter({ configPath, execAsync: mockExec as any })
  );

  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  const addr = server.address() as { port: number };
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  server?.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('GET /workspaces/changed-files', () => {
  test('returns changed files for a workspace', async () => {
    const res = await fetch(
      `${baseUrl}/workspaces/changed-files?path=${encodeURIComponent(repoDir)}`
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    expect(data.files).toBeInstanceOf(Array);
    expect(data.aggregate).toBeTruthy();
    expect(data.aggregate.fileCount).toBe(2);
  });

  test('returns 400 without path parameter', async () => {
    const res = await fetch(`${baseUrl}/workspaces/changed-files`);
    expect(res.status).toBe(400);
  });
});

describe('GET /workspaces/file-diff', () => {
  test('returns diff for a specific file', async () => {
    const res = await fetch(
      `${baseUrl}/workspaces/file-diff?path=${encodeURIComponent(repoDir)}&file=server/git.ts`
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    expect(data.diff).toBeTypeOf('string');
  });

  test('returns 400 without file parameter', async () => {
    const res = await fetch(
      `${baseUrl}/workspaces/file-diff?path=${encodeURIComponent(repoDir)}`
    );
    expect(res.status).toBe(400);
  });

  test('rejects absolute paths that did not start with ~', async () => {
    const res = await fetch(
      `${baseUrl}/workspaces/file-diff?path=${encodeURIComponent(repoDir)}&file=/etc/passwd`
    );
    expect(res.status).toBe(400);
    const data = (await res.json()) as any;
    expect(data.error).toBe('invalid file path');
  });

  test('rejects .. traversal in relative paths', async () => {
    const res = await fetch(
      `${baseUrl}/workspaces/file-diff?path=${encodeURIComponent(repoDir)}&file=../../etc/passwd`
    );
    expect(res.status).toBe(400);
    const data = (await res.json()) as any;
    expect(data.error).toBe('invalid file path');
  });

  test('reads ~/file paths via git diff instead of raw fs', async () => {
    const testFile = path.join(os.homedir(), '.relay-ide-test-tilde');
    fs.writeFileSync(testFile, 'tilde-test-content', 'utf-8');
    try {
      const res = await fetch(
        `${baseUrl}/workspaces/file-diff?path=${encodeURIComponent(repoDir)}&file=~/.relay-ide-test-tilde`
      );
      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      // Mock returns this for any git diff --unified=3 call
      expect(data.diff).toBe('diff output for file');
    } finally {
      fs.unlinkSync(testFile);
    }
  });

  test('rejects ~/../../ etc traversal attempts', async () => {
    const res = await fetch(
      `${baseUrl}/workspaces/file-diff?path=${encodeURIComponent(repoDir)}&file=~/../../etc/passwd`
    );
    expect(res.status).toBe(400);
    const data = (await res.json()) as any;
    expect(data.error).toBe('invalid file path');
  });

  test('returns 200 for non-existent ~/file via git diff (empty diff)', async () => {
    const res = await fetch(
      `${baseUrl}/workspaces/file-diff?path=${encodeURIComponent(repoDir)}&file=~/.relay-ide-nonexistent-file`
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    expect(typeof data.diff).toBe('string');
  });

  test('returns 200 for directory ~/path via git diff', async () => {
    const testDir = path.join(os.homedir(), '.relay-ide-test-dir');
    fs.mkdirSync(testDir, { recursive: true });
    try {
      const res = await fetch(
        `${baseUrl}/workspaces/file-diff?path=${encodeURIComponent(repoDir)}&file=~/.relay-ide-test-dir`
      );
      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(typeof data.diff).toBe('string');
    } finally {
      fs.rmdirSync(testDir);
    }
  });
});

describe('GET /workspaces/file-content', () => {
  test('returns file contents and metadata for an existing file', async () => {
    const sample = path.join(repoDir, 'sample.txt');
    fs.writeFileSync(sample, 'hello world\n', 'utf-8');
    const res = await fetch(
      `${baseUrl}/workspaces/file-content?path=${encodeURIComponent(repoDir)}&file=sample.txt`
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    expect(data.content).toBe('hello world\n');
    expect(data.binary).toBe(false);
    expect(data.truncated).toBe(false);
    expect(typeof data.sizeBytes).toBe('number');
    expect(typeof data.mtimeMs).toBe('number');
  });

  test('returns 400 without file parameter', async () => {
    const res = await fetch(
      `${baseUrl}/workspaces/file-content?path=${encodeURIComponent(repoDir)}`
    );
    expect(res.status).toBe(400);
  });

  test('rejects absolute paths', async () => {
    const res = await fetch(
      `${baseUrl}/workspaces/file-content?path=${encodeURIComponent(repoDir)}&file=/etc/passwd`
    );
    expect(res.status).toBe(400);
  });

  test('rejects .. traversal', async () => {
    const res = await fetch(
      `${baseUrl}/workspaces/file-content?path=${encodeURIComponent(repoDir)}&file=../../etc/passwd`
    );
    expect(res.status).toBe(400);
  });

  test('returns 404 for missing file', async () => {
    const res = await fetch(
      `${baseUrl}/workspaces/file-content?path=${encodeURIComponent(repoDir)}&file=does-not-exist.txt`
    );
    expect(res.status).toBe(404);
  });

  test('rejects symlinks pointing outside the repo', async () => {
    const target = path.join(tmpDir, 'outside.txt');
    fs.writeFileSync(target, 'leak\n', 'utf-8');
    const link = path.join(repoDir, 'leak-link.txt');
    fs.symlinkSync(target, link);
    try {
      const res = await fetch(
        `${baseUrl}/workspaces/file-content?path=${encodeURIComponent(repoDir)}&file=leak-link.txt`
      );
      expect(res.status).toBe(400);
      const data = (await res.json()) as any;
      expect(data.content).toBe('');
    } finally {
      fs.unlinkSync(link);
      fs.unlinkSync(target);
    }
  });

  test('flags binary files', async () => {
    const bin = path.join(repoDir, 'blob.bin');
    fs.writeFileSync(bin, Buffer.from([0x00, 0x01, 0x02, 0x03, 0x00]));
    const res = await fetch(
      `${baseUrl}/workspaces/file-content?path=${encodeURIComponent(repoDir)}&file=blob.bin`
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    expect(data.binary).toBe(true);
    expect(data.content).toBe('');
  });
});

describe('GET /workspaces/default-branch', () => {
  test('returns default branch for a workspace', async () => {
    const res = await fetch(
      `${baseUrl}/workspaces/default-branch?path=${encodeURIComponent(repoDir)}`
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    expect(typeof data.branch).toBe('string');
    expect(data.branch.length).toBeGreaterThan(0);
  });

  test('returns 400 without path parameter', async () => {
    const res = await fetch(`${baseUrl}/workspaces/default-branch`);
    expect(res.status).toBe(400);
  });
});
