import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import express from 'express';
import http from 'node:http';
import { BUILTIN_FRAMEWORKS } from '../server/types.js';

// ---------------------------------------------------------------------------
// Minimal express app that mounts just the /api/frameworks route
// (mirrors how server/index.ts registers it, without the full server bootstrap)
// ---------------------------------------------------------------------------

let server: http.Server;
let port: number;

beforeAll(async () => {
  const app = express();
  app.use(express.json());

  // Register the same route logic as server/index.ts will expose
  app.get('/api/frameworks', (_req, res) => {
    const frameworks = Object.values(BUILTIN_FRAMEWORKS).map((f) => ({
      id: f.id,
      displayName: f.displayName,
      command: f.command,
      capabilities: f.capabilities,
      eventSource: f.eventSource,
    }));
    res.json({ frameworks });
  });

  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as { port: number }).port;
});

afterAll(() => {
  server.close();
});

function url(p: string): string {
  return `http://127.0.0.1:${port}${p}`;
}

describe('GET /api/frameworks', () => {
  it('returns 200 with a frameworks array', async () => {
    const res = await fetch(url('/api/frameworks'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { frameworks: unknown[] };
    expect(Array.isArray(body.frameworks)).toBeTruthy();
  });

  it('returns all three builtin frameworks', async () => {
    const res = await fetch(url('/api/frameworks'));
    const body = (await res.json()) as { frameworks: Array<{ id: string }> };
    const ids = body.frameworks.map((f) => f.id);
    expect(ids.includes('claude')).toBeTruthy();
    expect(ids.includes('codex')).toBeTruthy();
    expect(ids.includes('opencode')).toBeTruthy();
  });

  it('each framework entry has id, displayName, command, capabilities, eventSource', async () => {
    const res = await fetch(url('/api/frameworks'));
    const body = (await res.json()) as {
      frameworks: Array<{
        id: string;
        displayName: string;
        command: string;
        capabilities: Record<string, boolean>;
        eventSource: string;
      }>;
    };
    for (const fw of body.frameworks) {
      expect(typeof fw.id === 'string').toBeTruthy();
      expect(typeof fw.displayName === 'string').toBeTruthy();
      expect(typeof fw.command === 'string').toBeTruthy();
      expect(typeof fw.eventSource === 'string').toBeTruthy();
      expect(
        fw.capabilities && typeof fw.capabilities === 'object'
      ).toBeTruthy();
      expect(typeof fw.capabilities.supportsHooks === 'boolean').toBeTruthy();
      expect(
        typeof fw.capabilities.supportsContinue === 'boolean'
      ).toBeTruthy();
      expect(typeof fw.capabilities.supportsYolo === 'boolean').toBeTruthy();
      expect(
        typeof fw.capabilities.supportsTelemetry === 'boolean'
      ).toBeTruthy();
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

  it('opencode framework entry has eventSource=plugin', async () => {
    const res = await fetch(url('/api/frameworks'));
    const body = (await res.json()) as {
      frameworks: Array<{ id: string; eventSource: string }>;
    };
    const opencode = body.frameworks.find((f) => f.id === 'opencode');
    expect(opencode).toBeTruthy();
    expect(opencode!.eventSource).toBe('plugin');
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
