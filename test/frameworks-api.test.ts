import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import { BUILTIN_FRAMEWORKS } from '../server/types.js';

// ---------------------------------------------------------------------------
// Minimal express app that mounts just the /api/frameworks route
// (mirrors how server/index.ts registers it, without the full server bootstrap)
// ---------------------------------------------------------------------------

let server: http.Server;
let port: number;

before(async () => {
  const app = express();
  app.use(express.json());

  // Register the same route logic as server/index.ts will expose
  app.get('/api/frameworks', (_req, res) => {
    const frameworks = Object.values(BUILTIN_FRAMEWORKS).map(f => ({
      id: f.id,
      displayName: f.displayName,
      command: f.command,
      capabilities: f.capabilities,
      eventSource: f.eventSource,
    }));
    res.json({ frameworks });
  });

  server = http.createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as { port: number }).port;
});

after(() => {
  server.close();
});

function url(p: string): string {
  return `http://127.0.0.1:${port}${p}`;
}

describe('GET /api/frameworks', () => {
  it('returns 200 with a frameworks array', async () => {
    const res = await fetch(url('/api/frameworks'));
    assert.equal(res.status, 200);
    const body = await res.json() as { frameworks: unknown[] };
    assert.ok(Array.isArray(body.frameworks), 'response should have a frameworks array');
  });

  it('returns all three builtin frameworks', async () => {
    const res = await fetch(url('/api/frameworks'));
    const body = await res.json() as { frameworks: Array<{ id: string }> };
    const ids = body.frameworks.map(f => f.id);
    assert.ok(ids.includes('claude'), 'should include claude');
    assert.ok(ids.includes('codex'), 'should include codex');
    assert.ok(ids.includes('opencode'), 'should include opencode');
  });

  it('each framework entry has id, displayName, command, capabilities, eventSource', async () => {
    const res = await fetch(url('/api/frameworks'));
    const body = await res.json() as {
      frameworks: Array<{
        id: string;
        displayName: string;
        command: string;
        capabilities: Record<string, boolean>;
        eventSource: string;
      }>;
    };
    for (const fw of body.frameworks) {
      assert.ok(typeof fw.id === 'string', `framework ${fw.id} should have string id`);
      assert.ok(typeof fw.displayName === 'string', `framework ${fw.id} should have displayName`);
      assert.ok(typeof fw.command === 'string', `framework ${fw.id} should have command`);
      assert.ok(typeof fw.eventSource === 'string', `framework ${fw.id} should have eventSource`);
      assert.ok(fw.capabilities && typeof fw.capabilities === 'object', `framework ${fw.id} should have capabilities`);
      assert.ok(typeof fw.capabilities.supportsHooks === 'boolean');
      assert.ok(typeof fw.capabilities.supportsContinue === 'boolean');
      assert.ok(typeof fw.capabilities.supportsYolo === 'boolean');
      assert.ok(typeof fw.capabilities.supportsTelemetry === 'boolean');
    }
  });

  it('claude framework entry has correct values', async () => {
    const res = await fetch(url('/api/frameworks'));
    const body = await res.json() as {
      frameworks: Array<{ id: string; displayName: string; command: string; eventSource: string; capabilities: Record<string, boolean> }>;
    };
    const claude = body.frameworks.find(f => f.id === 'claude');
    assert.ok(claude, 'should have claude entry');
    assert.equal(claude!.displayName, 'Claude Code');
    assert.equal(claude!.command, 'claude');
    assert.equal(claude!.eventSource, 'hooks');
    assert.equal(claude!.capabilities.supportsHooks, true);
    assert.equal(claude!.capabilities.supportsTelemetry, true);
  });

  it('opencode framework entry has eventSource=plugin', async () => {
    const res = await fetch(url('/api/frameworks'));
    const body = await res.json() as { frameworks: Array<{ id: string; eventSource: string }> };
    const opencode = body.frameworks.find(f => f.id === 'opencode');
    assert.ok(opencode, 'should have opencode entry');
    assert.equal(opencode!.eventSource, 'plugin');
  });

  it('does not include internal fields like parserType or continueArgs', async () => {
    const res = await fetch(url('/api/frameworks'));
    const body = await res.json() as { frameworks: Array<Record<string, unknown>> };
    for (const fw of body.frameworks) {
      assert.equal(fw.parserType, undefined, 'parserType should not be exposed');
      assert.equal(fw.continueArgs, undefined, 'continueArgs should not be exposed');
      assert.equal(fw.yoloArgs, undefined, 'yoloArgs should not be exposed');
    }
  });
});
