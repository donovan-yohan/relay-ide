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
let server: Server;
let baseUrl: string;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-browse-test-'));
  configPath = path.join(tmpDir, 'config.json');

  // Create a directory tree for testing
  //   tmpDir/
  //     browsable/
  //       visible-dir/
  //         nested/
  //       .hidden-dir/
  //       git-repo/
  //         .git/
  //       empty-dir/
  //       node_modules/
  //       file.txt
  const browsable = path.join(tmpDir, 'browsable');
  fs.mkdirSync(path.join(browsable, 'visible-dir', 'nested'), {
    recursive: true,
  });
  fs.mkdirSync(path.join(browsable, '.hidden-dir'), { recursive: true });
  fs.mkdirSync(path.join(browsable, 'git-repo', '.git'), { recursive: true });
  fs.mkdirSync(path.join(browsable, 'empty-dir'), { recursive: true });
  fs.mkdirSync(path.join(browsable, 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(browsable, 'file.txt'), 'not a directory');

  // Create 110 dirs to test truncation
  const manyDir = path.join(tmpDir, 'many');
  fs.mkdirSync(manyDir);
  for (let i = 0; i < 110; i++) {
    fs.mkdirSync(path.join(manyDir, `dir-${String(i).padStart(3, '0')}`));
  }

  // Save a config so the router can load it
  saveConfig(configPath, { ...DEFAULTS, workspaces: [] });

  // Start a test server
  const app = express();
  app.use(express.json());
  app.use('/workspaces', createWorkspaceRouter({ configPath }));

  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server.address();
  if (typeof addr === 'object' && addr) {
    baseUrl = `http://127.0.0.1:${addr.port}`;
  }
});

afterAll(() => {
  server?.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function browse(query: Record<string, string> = {}): Promise<{
  resolved: string;
  entries: Array<{
    name: string;
    path: string;
    isGitRepo: boolean;
    hasChildren: boolean;
  }>;
  truncated: boolean;
  total: number;
}> {
  const params = new URLSearchParams(query);
  const res = await fetch(`${baseUrl}/workspaces/browse?${params}`);
  expect(res.status).toBe(200);
  return res.json() as Promise<ReturnType<typeof browse>>;
}

describe('GET /workspaces/browse', () => {
  test('lists directories in a given path', async () => {
    const browsable = path.join(tmpDir, 'browsable');
    const data = await browse({ path: browsable });

    expect(data.resolved).toBe(browsable);
    const names = data.entries.map((e) => e.name);

    // Should include visible directories but not files or denylisted dirs
    expect(names.includes('visible-dir')).toBeTruthy();
    expect(names.includes('git-repo')).toBeTruthy();
    expect(names.includes('empty-dir')).toBeTruthy();
    expect(!names.includes('file.txt')).toBeTruthy();
    expect(!names.includes('node_modules')).toBeTruthy();
  });

  test('hides dotfiles by default', async () => {
    const browsable = path.join(tmpDir, 'browsable');
    const data = await browse({ path: browsable });
    const names = data.entries.map((e) => e.name);

    expect(!names.includes('.hidden-dir')).toBeTruthy();
  });

  test('shows dotfiles when showHidden=true', async () => {
    const browsable = path.join(tmpDir, 'browsable');
    const data = await browse({ path: browsable, showHidden: 'true' });
    const names = data.entries.map((e) => e.name);

    expect(names.includes('.hidden-dir')).toBeTruthy();
    // .git should still be excluded (in denylist)
    expect(!names.includes('.git')).toBeTruthy();
  });

  test('filters by prefix', async () => {
    const browsable = path.join(tmpDir, 'browsable');
    const data = await browse({ path: browsable, prefix: 'vis' });

    expect(data.entries.length).toBe(1);
    expect(data.entries[0]!.name).toBe('visible-dir');
  });

  test('prefix filter is case-insensitive', async () => {
    const browsable = path.join(tmpDir, 'browsable');
    const data = await browse({ path: browsable, prefix: 'VIS' });

    expect(data.entries.length).toBe(1);
    expect(data.entries[0]!.name).toBe('visible-dir');
  });

  test('detects isGitRepo correctly', async () => {
    const browsable = path.join(tmpDir, 'browsable');
    const data = await browse({ path: browsable });

    const gitRepo = data.entries.find((e) => e.name === 'git-repo');
    const visibleDir = data.entries.find((e) => e.name === 'visible-dir');

    expect(gitRepo).toBeTruthy();
    expect(gitRepo.isGitRepo).toBe(true);
    expect(visibleDir).toBeTruthy();
    expect(visibleDir.isGitRepo).toBe(false);
  });

  test('detects hasChildren correctly', async () => {
    const browsable = path.join(tmpDir, 'browsable');
    const data = await browse({ path: browsable });

    const visibleDir = data.entries.find((e) => e.name === 'visible-dir');
    const emptyDir = data.entries.find((e) => e.name === 'empty-dir');

    expect(visibleDir).toBeTruthy();
    expect(visibleDir.hasChildren).toBe(true);
    expect(emptyDir).toBeTruthy();
    expect(emptyDir.hasChildren).toBe(false);
  });

  test('truncates at 100 entries', async () => {
    const manyDir = path.join(tmpDir, 'many');
    const data = await browse({ path: manyDir });

    expect(data.entries.length).toBe(100);
    expect(data.truncated).toBe(true);
    expect(data.total).toBe(110);
  });

  test('sorts alphabetically case-insensitive', async () => {
    const browsable = path.join(tmpDir, 'browsable');
    const data = await browse({ path: browsable });
    const names = data.entries.map((e) => e.name);

    const sorted = [...names].sort((a, b) =>
      a.toLowerCase().localeCompare(b.toLowerCase())
    );
    expect(names).toEqual(sorted);
  });

  test('returns 400 for non-existent path', async () => {
    const params = new URLSearchParams({
      path: path.join(tmpDir, 'nonexistent'),
    });
    const res = await fetch(`${baseUrl}/workspaces/browse?${params}`);
    expect(res.status).toBe(400);
  });

  test('returns 400 for file path', async () => {
    const params = new URLSearchParams({
      path: path.join(tmpDir, 'browsable', 'file.txt'),
    });
    const res = await fetch(`${baseUrl}/workspaces/browse?${params}`);
    expect(res.status).toBe(400);
  });

  test('defaults to home directory when no path given', async () => {
    const data = await browse();
    expect(data.resolved).toBe(os.homedir());
    // Should have at least some entries (home dir is not empty)
    expect(data.entries.length > 0).toBeTruthy();
  });

  test('includes files when includeFiles=true', async () => {
    const browsable = path.join(tmpDir, 'browsable');
    const data = await browse({ path: browsable, includeFiles: 'true' });
    const names = data.entries.map((e) => e.name);

    expect(names.includes('file.txt')).toBeTruthy();
    expect(names.includes('visible-dir')).toBeTruthy();
  });

  test('directories sort before files with includeFiles=true', async () => {
    const browsable = path.join(tmpDir, 'browsable');
    const data = await browse({ path: browsable, includeFiles: 'true' });
    const entries = data.entries as Array<{
      name: string;
      isDirectory?: boolean;
    }>;

    const firstFileIdx = entries.findIndex((e) => e.isDirectory === false);
    let lastDirIdx = -1;
    for (let i = entries.length - 1; i >= 0; i--) {
      if (entries[i]!.isDirectory === true) {
        lastDirIdx = i;
        break;
      }
    }
    if (firstFileIdx !== -1 && lastDirIdx !== -1) {
      expect(lastDirIdx < firstFileIdx).toBeTruthy();
    }
  });

  test('files have isDirectory=false and size field with includeFiles=true', async () => {
    const browsable = path.join(tmpDir, 'browsable');
    const data = await browse({ path: browsable, includeFiles: 'true' });
    const fileEntry = data.entries.find((e) => e.name === 'file.txt') as
      | { name: string; isDirectory?: boolean; size?: number }
      | undefined;

    expect(fileEntry).toBeTruthy();
    expect(fileEntry.isDirectory).toBe(false);
    expect(typeof fileEntry.size).toBe('number');
    expect(fileEntry.size! > 0).toBeTruthy();
  });

  test('excludes files when includeFiles is not set', async () => {
    const browsable = path.join(tmpDir, 'browsable');
    const data = await browse({ path: browsable });
    const names = data.entries.map((e) => e.name);

    expect(!names.includes('file.txt')).toBeTruthy();
  });
});

describe('POST /workspaces/bulk', () => {
  test('adds multiple workspaces', async () => {
    const dir1 = path.join(tmpDir, 'browsable', 'visible-dir');
    const dir2 = path.join(tmpDir, 'browsable', 'empty-dir');

    const res = await fetch(`${baseUrl}/workspaces/bulk`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: [dir1, dir2] }),
    });

    expect(res.status).toBe(201);
    const data = (await res.json()) as {
      added: Array<{ path: string }>;
      errors: Array<{ path: string; error: string }>;
    };
    expect(data.added.length).toBe(2);
    expect(data.errors.length).toBe(0);
  });

  test('rejects duplicate workspaces', async () => {
    const dir1 = path.join(tmpDir, 'browsable', 'visible-dir');

    const res = await fetch(`${baseUrl}/workspaces/bulk`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: [dir1] }),
    });

    expect(res.status).toBe(201);
    const data = (await res.json()) as {
      added: Array<{ path: string }>;
      errors: Array<{ path: string; error: string }>;
    };
    expect(data.added.length).toBe(0);
    expect(data.errors.length).toBe(1);
    expect(data.errors[0]!.error.includes('Already exists')).toBeTruthy();
  });

  test('returns 400 for empty paths array', async () => {
    const res = await fetch(`${baseUrl}/workspaces/bulk`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: [] }),
    });

    expect(res.status).toBe(400);
  });

  test('handles mixed valid/invalid paths', async () => {
    const validDir = path.join(tmpDir, 'browsable', 'git-repo');
    const invalidDir = path.join(tmpDir, 'nonexistent');

    const res = await fetch(`${baseUrl}/workspaces/bulk`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: [validDir, invalidDir] }),
    });

    expect(res.status).toBe(201);
    const data = (await res.json()) as {
      added: Array<{ path: string }>;
      errors: Array<{ path: string; error: string }>;
    };
    expect(data.added.length).toBe(1);
    expect(data.errors.length).toBe(1);
  });
});
