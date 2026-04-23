import { test, expect, describe, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { findFreePort, startSandbox } from '../server/sandbox.js';

let tmpDir: string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-ide-sandbox-test-'));
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('findFreePort', () => {
  test('returns a port in the default range', async () => {
    const port = await findFreePort();
    expect(port).toBeGreaterThanOrEqual(3456);
    expect(port).toBeLessThanOrEqual(3556);
  });

  test('falls back to a different port when preferred is in use', async () => {
    const net = await import('node:net');
    const server = net.createServer().listen(19998);
    try {
      const port = await findFreePort(19998);
      expect(port).not.toBe(19998);
      expect(port).toBeGreaterThan(0);
    } finally {
      server.close();
      await new Promise<void>((resolve) => server.on('close', resolve));
    }
  });
});

describe('startSandbox', () => {
  test('starts a sandbox server and cleans up on teardown', async () => {
    const sandbox = await startSandbox({
      workspacePath: tmpDir,
    });

    try {
      expect(sandbox.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(sandbox.port).toBeGreaterThan(0);
      expect(fs.existsSync(sandbox.configPath)).toBe(true);
      expect(fs.existsSync(sandbox.dataDir)).toBe(true);

      // Verify health endpoint
      const res = await fetch(`${sandbox.url}/health`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { status: string };
      expect(body.status).toBe('ok');

      // Verify config content
      const config = JSON.parse(fs.readFileSync(sandbox.configPath, 'utf8')) as {
        host: string;
        port: number;
        repos: string[];
      };
      expect(config.host).toBe('127.0.0.1');
      expect(config.port).toBe(sandbox.port);
      expect(config.repos).toContain(tmpDir);
    } finally {
      await sandbox.teardown();
    }

    expect(fs.existsSync(sandbox.dataDir)).toBe(false);
  }, 60_000);

  test('honors an explicit port option', async () => {
    const sandbox = await startSandbox({
      workspacePath: tmpDir,
      port: 19997,
    });

    try {
      expect(sandbox.port).toBe(19997);
    } finally {
      await sandbox.teardown();
    }
  }, 60_000);
});
