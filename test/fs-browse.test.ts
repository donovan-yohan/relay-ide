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
let server: Server;
let baseUrl: string;

before(async () => {
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

after(() => {
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
  assert.equal(res.status, 200, `Expected 200 but got ${res.status}`);
  return res.json() as Promise<ReturnType<typeof browse>>;
}

describe('GET /workspaces/browse', () => {
  test('lists directories in a given path', async () => {
    const browsable = path.join(tmpDir, 'browsable');
    const data = await browse({ path: browsable });

    assert.equal(data.resolved, browsable);
    const names = data.entries.map((e) => e.name);

    // Should include visible directories but not files or denylisted dirs
    assert.ok(names.includes('visible-dir'), 'should include visible-dir');
    assert.ok(names.includes('git-repo'), 'should include git-repo');
    assert.ok(names.includes('empty-dir'), 'should include empty-dir');
    assert.ok(!names.includes('file.txt'), 'should exclude files');
    assert.ok(!names.includes('node_modules'), 'should exclude node_modules');
  });

  test('hides dotfiles by default', async () => {
    const browsable = path.join(tmpDir, 'browsable');
    const data = await browse({ path: browsable });
    const names = data.entries.map((e) => e.name);

    assert.ok(
      !names.includes('.hidden-dir'),
      'should exclude hidden dirs by default'
    );
  });

  test('shows dotfiles when showHidden=true', async () => {
    const browsable = path.join(tmpDir, 'browsable');
    const data = await browse({ path: browsable, showHidden: 'true' });
    const names = data.entries.map((e) => e.name);

    assert.ok(
      names.includes('.hidden-dir'),
      'should include hidden dirs when showHidden'
    );
    // .git should still be excluded (in denylist)
    assert.ok(!names.includes('.git'), 'should still exclude .git');
  });

  test('filters by prefix', async () => {
    const browsable = path.join(tmpDir, 'browsable');
    const data = await browse({ path: browsable, prefix: 'vis' });

    assert.equal(data.entries.length, 1);
    assert.equal(data.entries[0]!.name, 'visible-dir');
  });

  test('prefix filter is case-insensitive', async () => {
    const browsable = path.join(tmpDir, 'browsable');
    const data = await browse({ path: browsable, prefix: 'VIS' });

    assert.equal(data.entries.length, 1);
    assert.equal(data.entries[0]!.name, 'visible-dir');
  });

  test('detects isGitRepo correctly', async () => {
    const browsable = path.join(tmpDir, 'browsable');
    const data = await browse({ path: browsable });

    const gitRepo = data.entries.find((e) => e.name === 'git-repo');
    const visibleDir = data.entries.find((e) => e.name === 'visible-dir');

    assert.ok(gitRepo, 'git-repo entry should exist');
    assert.equal(
      gitRepo.isGitRepo,
      true,
      'git-repo should have isGitRepo=true'
    );
    assert.ok(visibleDir, 'visible-dir entry should exist');
    assert.equal(
      visibleDir.isGitRepo,
      false,
      'visible-dir should have isGitRepo=false'
    );
  });

  test('detects hasChildren correctly', async () => {
    const browsable = path.join(tmpDir, 'browsable');
    const data = await browse({ path: browsable });

    const visibleDir = data.entries.find((e) => e.name === 'visible-dir');
    const emptyDir = data.entries.find((e) => e.name === 'empty-dir');

    assert.ok(visibleDir, 'visible-dir entry should exist');
    assert.equal(
      visibleDir.hasChildren,
      true,
      'visible-dir should have children'
    );
    assert.ok(emptyDir, 'empty-dir entry should exist');
    assert.equal(
      emptyDir.hasChildren,
      false,
      'empty-dir should not have children'
    );
  });

  test('truncates at 100 entries', async () => {
    const manyDir = path.join(tmpDir, 'many');
    const data = await browse({ path: manyDir });

    assert.equal(data.entries.length, 100);
    assert.equal(data.truncated, true);
    assert.equal(data.total, 110);
  });

  test('sorts alphabetically case-insensitive', async () => {
    const browsable = path.join(tmpDir, 'browsable');
    const data = await browse({ path: browsable });
    const names = data.entries.map((e) => e.name);

    const sorted = [...names].sort((a, b) =>
      a.toLowerCase().localeCompare(b.toLowerCase())
    );
    assert.deepEqual(names, sorted, 'entries should be sorted alphabetically');
  });

  test('returns 400 for non-existent path', async () => {
    const params = new URLSearchParams({
      path: path.join(tmpDir, 'nonexistent'),
    });
    const res = await fetch(`${baseUrl}/workspaces/browse?${params}`);
    assert.equal(res.status, 400);
  });

  test('returns 400 for file path', async () => {
    const params = new URLSearchParams({
      path: path.join(tmpDir, 'browsable', 'file.txt'),
    });
    const res = await fetch(`${baseUrl}/workspaces/browse?${params}`);
    assert.equal(res.status, 400);
  });

  test('defaults to home directory when no path given', async () => {
    const data = await browse();
    assert.equal(data.resolved, os.homedir());
    // Should have at least some entries (home dir is not empty)
    assert.ok(data.entries.length > 0, 'home directory should have entries');
  });

  test('includes files when includeFiles=true', async () => {
    const browsable = path.join(tmpDir, 'browsable');
    const data = await browse({ path: browsable, includeFiles: 'true' });
    const names = data.entries.map((e) => e.name);

    assert.ok(names.includes('file.txt'), 'should include file.txt');
    assert.ok(
      names.includes('visible-dir'),
      'should still include directories'
    );
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
      assert.ok(
        lastDirIdx < firstFileIdx,
        'all directories should come before files'
      );
    }
  });

  test('files have isDirectory=false and size field with includeFiles=true', async () => {
    const browsable = path.join(tmpDir, 'browsable');
    const data = await browse({ path: browsable, includeFiles: 'true' });
    const fileEntry = data.entries.find((e) => e.name === 'file.txt') as
      | { name: string; isDirectory?: boolean; size?: number }
      | undefined;

    assert.ok(fileEntry, 'file.txt should exist');
    assert.equal(
      fileEntry.isDirectory,
      false,
      'file should have isDirectory=false'
    );
    assert.equal(typeof fileEntry.size, 'number', 'file should have size');
    assert.ok(fileEntry.size! > 0, 'file should have non-zero size');
  });

  test('excludes files when includeFiles is not set', async () => {
    const browsable = path.join(tmpDir, 'browsable');
    const data = await browse({ path: browsable });
    const names = data.entries.map((e) => e.name);

    assert.ok(!names.includes('file.txt'), 'should exclude files by default');
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

    assert.equal(res.status, 201);
    const data = (await res.json()) as {
      added: Array<{ path: string }>;
      errors: Array<{ path: string; error: string }>;
    };
    assert.equal(data.added.length, 2);
    assert.equal(data.errors.length, 0);
  });

  test('rejects duplicate workspaces', async () => {
    const dir1 = path.join(tmpDir, 'browsable', 'visible-dir');

    const res = await fetch(`${baseUrl}/workspaces/bulk`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: [dir1] }),
    });

    assert.equal(res.status, 201);
    const data = (await res.json()) as {
      added: Array<{ path: string }>;
      errors: Array<{ path: string; error: string }>;
    };
    assert.equal(data.added.length, 0);
    assert.equal(data.errors.length, 1);
    assert.ok(data.errors[0]!.error.includes('Already exists'));
  });

  test('returns 400 for empty paths array', async () => {
    const res = await fetch(`${baseUrl}/workspaces/bulk`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: [] }),
    });

    assert.equal(res.status, 400);
  });

  test('handles mixed valid/invalid paths', async () => {
    const validDir = path.join(tmpDir, 'browsable', 'git-repo');
    const invalidDir = path.join(tmpDir, 'nonexistent');

    const res = await fetch(`${baseUrl}/workspaces/bulk`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: [validDir, invalidDir] }),
    });

    assert.equal(res.status, 201);
    const data = (await res.json()) as {
      added: Array<{ path: string }>;
      errors: Array<{ path: string; error: string }>;
    };
    assert.equal(data.added.length, 1);
    assert.equal(data.errors.length, 1);
  });
});
