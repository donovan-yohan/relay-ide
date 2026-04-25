import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import express from 'express';
import { getFrameworkClientInfo } from '../server/frameworks.js';
import { createTestServer } from './helpers/test-server.js';

// ---------------------------------------------------------------------------
// Minimal express app that mounts just the /api/frameworks route
// (mirrors how server/index.ts registers it, without the full server bootstrap)
// ---------------------------------------------------------------------------

let baseUrl: string;
let closeServer: () => Promise<void>;

beforeAll(async () => {
  const app = express();
  app.use(express.json());

  // Register the same route logic as server/index.ts will expose
  app.get('/api/frameworks', (_req, res) => {
    const frameworks = getFrameworkClientInfo();
    res.json({ frameworks });
  });

  const result = await createTestServer(app);
  baseUrl = result.url;
  closeServer = result.close;
});

afterAll(() => closeServer());

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
