import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import express from 'express';
import { getFrameworkClientInfoWithRuntime } from '../server/frameworks.js';
import { createTestServer } from './helpers/test-server.js';

// ---------------------------------------------------------------------------
// Minimal express app that mounts just the /api/frameworks route
// (mirrors how server/index.ts registers it, without the full server bootstrap)
// ---------------------------------------------------------------------------

let baseUrl: string;
let closeServer: () => Promise<void>;
let closeHermesProbeServer: () => Promise<void>;
let fakeBinDir: string;
let hermesProbeUrl: string;
let originalHermesEndpoint: string | undefined;
let originalPath: string | undefined;

beforeAll(async () => {
  originalHermesEndpoint = process.env.HERMES_API_ENDPOINT;
  originalPath = process.env.PATH;
  fakeBinDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-frameworks-'));
  const fakeHermes = path.join(fakeBinDir, 'hermes');
  fs.writeFileSync(fakeHermes, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(fakeHermes, 0o755);
  const fakePrimeAgent = path.join(fakeBinDir, 'prime-agent');
  fs.writeFileSync(fakePrimeAgent, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(fakePrimeAgent, 0o755);
  const fakePi = path.join(fakeBinDir, 'pi');
  fs.writeFileSync(fakePi, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(fakePi, 0o755);
  const fakeAgy = path.join(fakeBinDir, 'agy');
  fs.writeFileSync(fakeAgy, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(fakeAgy, 0o755);

  const hermesProbeApp = express();
  hermesProbeApp.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });
  const hermesProbeServer = await createTestServer(hermesProbeApp);
  hermesProbeUrl = hermesProbeServer.url;
  closeHermesProbeServer = hermesProbeServer.close;
  process.env.HERMES_API_ENDPOINT = hermesProbeUrl;

  const app = express();
  app.use(express.json());

  // Register the same route logic as server/index.ts will expose
  app.get('/api/frameworks', async (_req, res) => {
    const frameworks = await getFrameworkClientInfoWithRuntime(undefined, {
      ...process.env,
      PATH: `${fakeBinDir}${path.delimiter}${originalPath ?? ''}`,
    });
    res.json({ frameworks });
  });

  const result = await createTestServer(app);
  baseUrl = result.url;
  closeServer = result.close;
});

afterAll(async () => {
  await closeServer();
  await closeHermesProbeServer();
  if (originalHermesEndpoint === undefined) {
    delete process.env.HERMES_API_ENDPOINT;
  } else {
    process.env.HERMES_API_ENDPOINT = originalHermesEndpoint;
  }
  process.env.PATH = originalPath;
  fs.rmSync(fakeBinDir, { recursive: true, force: true });
});

function url(p: string): string {
  return `${baseUrl}${p}`;
}

describe('GET /api/frameworks', () => {
  it('returns 200 with a frameworks array', async () => {
    const res = await fetch(url('/api/frameworks'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { frameworks: unknown[] };
    expect(body.frameworks).toBeInstanceOf(Array);
  });

  it('returns all builtin frameworks', async () => {
    const res = await fetch(url('/api/frameworks'));
    const body = (await res.json()) as { frameworks: Array<{ id: string }> };
    const ids = body.frameworks.map((f) => f.id);
    expect(ids).toContain('claude');
    expect(ids).toContain('codex');
    expect(ids).toContain('opencode');
    expect(ids).toContain('hermes');
    expect(ids).toContain('prime-agent');
    expect(ids).toContain('pi');
    expect(ids).toContain('antigravity');
  });

  it('each framework entry has id, displayName, command, capabilities, eventSource, and availability', async () => {
    const res = await fetch(url('/api/frameworks'));
    const body = (await res.json()) as {
      frameworks: Array<{
        id: string;
        displayName: string;
        command: string;
        capabilities: Record<string, boolean>;
        eventSource: string;
        availability?: {
          installed: boolean;
          path?: string;
          reason?: string;
        };
      }>;
    };
    for (const fw of body.frameworks) {
      expect(fw.id).toBeTypeOf('string');
      expect(fw.displayName).toBeTypeOf('string');
      expect(fw.command).toBeTypeOf('string');
      expect(fw.eventSource).toBeTypeOf('string');
      expect(
        fw.capabilities && typeof fw.capabilities === 'object'
      ).toBeTruthy();
      expect(fw.capabilities.supportsHooks).toBeTypeOf('boolean');
      expect(fw.capabilities.supportsContinue).toBeTypeOf('boolean');
      expect(fw.capabilities.supportsYolo).toBeTypeOf('boolean');
      expect(fw.capabilities.supportsTelemetry).toBeTypeOf('boolean');
      expect(fw.availability).toBeTruthy();
      expect(fw.availability!.installed).toBeTypeOf('boolean');
    }
  });

  it('claude framework entry has correct values', async () => {
    const res = await fetch(url('/api/frameworks'));
    const body = (await res.json()) as {
      frameworks: Array<{
        id: string;
        displayName: string;
        command: string;
        eventSource: string;
        capabilities: Record<string, boolean>;
      }>;
    };
    const claude = body.frameworks.find((f) => f.id === 'claude');
    expect(claude).toBeTruthy();
    expect(claude!.displayName).toBe('Claude Code');
    expect(claude!.command).toBe('claude');
    expect(claude!.eventSource).toBe('hooks');
    expect(claude!.capabilities.supportsHooks).toBe(true);
    expect(claude!.capabilities.supportsTelemetry).toBe(true);
  });

  it('returns Prime Agent as an installed first-class channel provider', async () => {
    const res = await fetch(url('/api/frameworks'));
    const body = (await res.json()) as {
      frameworks: Array<{
        id: string;
        displayName: string;
        command: string;
        eventSource: string;
        capabilities: Record<string, boolean>;
        availability?: { installed: boolean; path?: string };
      }>;
    };
    const prime = body.frameworks.find((f) => f.id === 'prime-agent');
    expect(prime).toMatchObject({
      displayName: 'Prime Agent',
      command: 'prime-agent',
      eventSource: 'timer',
    });
    expect(prime!.capabilities.supportsChannelAgents).toBe(true);
    expect(prime!.availability).toEqual({
      installed: true,
      path: path.join(fakeBinDir, 'prime-agent'),
    });
  });

  it('returns Antigravity as an installed first-class channel provider', async () => {
    const res = await fetch(url('/api/frameworks'));
    const body = (await res.json()) as {
      frameworks: Array<{
        id: string;
        displayName: string;
        command: string;
        eventSource: string;
        capabilities: Record<string, boolean>;
        availability?: { installed: boolean; path?: string };
      }>;
    };
    const agy = body.frameworks.find((f) => f.id === 'antigravity');
    expect(agy).toMatchObject({
      displayName: 'Antigravity',
      command: 'agy',
      eventSource: 'timer',
    });
    expect(agy!.capabilities.supportsChannelAgents).toBe(true);
    expect(agy!.availability).toEqual({
      installed: true,
      path: path.join(fakeBinDir, 'agy'),
    });
  });

  it('opencode framework entry has eventSource=plugin', async () => {
    const res = await fetch(url('/api/frameworks'));
    const body = (await res.json()) as {
      frameworks: Array<{ id: string; eventSource: string }>;
    };
    const opencode = body.frameworks.find((f) => f.id === 'opencode');
    expect(opencode).toBeTruthy();
    expect(opencode!.eventSource).toBe('plugin');
  });

  it('surfaces Hermes channel runtime availability from the async route', async () => {
    const res = await fetch(url('/api/frameworks'));
    const body = (await res.json()) as {
      frameworks: Array<{
        id: string;
        availability?: { installed: boolean; path?: string };
        channelAvailability?: {
          available: boolean;
          endpoint?: string;
          reason?: string;
        };
      }>;
    };
    const hermes = body.frameworks.find((f) => f.id === 'hermes');
    expect(hermes).toBeTruthy();
    expect(hermes!.availability?.installed).toBe(true);
    expect(hermes!.availability?.path).toBe(path.join(fakeBinDir, 'hermes'));
    expect(hermes!.channelAvailability).toMatchObject({
      available: false,
      endpoint: hermesProbeUrl,
    });
    expect(hermes!.channelAvailability?.reason).toContain(
      'Responses API is not enabled'
    );
  });

  it('returns Pi as an installed first-class channel provider', async () => {
    const res = await fetch(url('/api/frameworks'));
    const body = (await res.json()) as {
      frameworks: Array<{
        id: string;
        displayName: string;
        command: string;
        eventSource: string;
        capabilities: Record<string, boolean>;
        availability?: { installed: boolean; path?: string };
      }>;
    };
    const pi = body.frameworks.find((f) => f.id === 'pi');
    expect(pi).toMatchObject({
      displayName: 'Pi',
      command: 'pi',
      eventSource: 'timer',
    });
    expect(pi!.capabilities.supportsChannelAgents).toBe(true);
    expect(pi!.availability).toEqual({
      installed: true,
      path: path.join(fakeBinDir, 'pi'),
    });
  });

  it('does not include internal fields like parserType or continueArgs', async () => {
    const res = await fetch(url('/api/frameworks'));
    const body = (await res.json()) as {
      frameworks: Array<Record<string, unknown>>;
    };
    for (const fw of body.frameworks) {
      expect(fw.parserType).toBe(undefined);
      expect(fw.continueArgs).toBe(undefined);
      expect(fw.yoloArgs).toBe(undefined);
    }
  });
});
