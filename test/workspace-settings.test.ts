import { describe, test, beforeEach, afterEach, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import type { Server } from 'node:http';

import { createWorkspaceRouter } from '../server/workspaces.js';
import { DEFAULTS, loadConfig, saveConfig } from '../server/config.js';

let tmpDir: string;
let configPath: string;
let repoPath: string;
let server: Server;
let baseUrl: string;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-settings-test-'));
  configPath = path.join(tmpDir, 'config.json');
  repoPath = path.join(tmpDir, 'repo');
  fs.mkdirSync(repoPath, { recursive: true });
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

afterEach(() => {
  server?.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('PATCH /workspaces/settings', () => {
  test('rejects non-true launchInTmux compatibility values', async () => {
    const res = await fetch(
      `${baseUrl}/workspaces/settings?path=${encodeURIComponent(repoPath)}`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ launchInTmux: 'false' }),
      }
    );

    expect(res.status).toBe(400);
    expect(loadConfig(configPath).repoSettings?.[repoPath]).toBeUndefined();
  });

  test('maps true launchInTmux compatibility values to tmux-compat', async () => {
    const res = await fetch(
      `${baseUrl}/workspaces/settings?path=${encodeURIComponent(repoPath)}`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ launchInTmux: true }),
      }
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ terminalBackend: 'tmux-compat' });
    expect(loadConfig(configPath).repoSettings?.[repoPath]).toEqual({
      terminalBackend: 'tmux-compat',
    });
  });
});
