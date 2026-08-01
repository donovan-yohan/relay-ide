/**
 * Tests for workbench layout persistence — slice 3 of epic #612.
 *
 * Covers:
 *   1. Shared types: serialize/deserialize round-trip
 *      - Happy path (known kinds)
 *      - Forward-compat: unknown block kinds survive round-trip
 *      - Unknown extra fields preserved in _unknown
 *      - Edge cases: missing fields, wrong types, bad schemaVersion
 *   2. Server storage module: read/write/delete layout files
 *   3. Server REST endpoints via the router
 *      - GET returns 204 for unset layout
 *      - PUT validates schema, persists, returns layout
 *      - GET returns what was PUT
 *      - PUT rejects mismatched workspaceScope.id
 *
 * The `WorkbenchCanvas` source-structure assertions this file used to carry
 * were dropped with `frontend/src/workbench/` in epic #1287 slice 0. The layout
 * types, storage module, and REST surface below are unchanged.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ---------------------------------------------------------------------------
// 1. Shared types — serialize/deserialize round-trip
// ---------------------------------------------------------------------------

import {
  deserialiseWorkbenchLayout,
  serialiseWorkbenchLayout,
  WORKBENCH_LAYOUT_SCHEMA_VERSION,
} from '../shared/workbench-layout-types.js';
import type {
  WorkbenchLayout,
  WorkbenchBlockPlacement,
} from '../shared/workbench-layout-types.js';

function makePlacement(
  overrides: Partial<WorkbenchBlockPlacement> = {}
): WorkbenchBlockPlacement {
  return {
    descriptor: {
      kind: 'markdown',
      id: 'block-1',
      title: 'test block',
      capabilityRequirements: [],
      meta: { content: 'hello world' },
    },
    position: { x: 100, y: 200 },
    size: { width: 400, height: 300 },
    minimized: false,
    ...overrides,
  };
}

function makeLayout(overrides: Partial<WorkbenchLayout> = {}): WorkbenchLayout {
  return {
    schemaVersion: WORKBENCH_LAYOUT_SCHEMA_VERSION,
    workspaceScope: { id: 'ws:test', displayName: 'test workspace' },
    blocks: [makePlacement()],
    ...overrides,
  };
}

describe('workbench-layout-types: serialise/deserialise', () => {
  it('round-trips a layout with a known block kind', () => {
    const original = makeLayout();
    const raw = serialiseWorkbenchLayout(original);
    const restored = deserialiseWorkbenchLayout(raw);
    expect(restored).not.toBeNull();
    expect(restored!.schemaVersion).toBe(WORKBENCH_LAYOUT_SCHEMA_VERSION);
    expect(restored!.workspaceScope.id).toBe('ws:test');
    expect(restored!.blocks).toHaveLength(1);
    const block = restored!.blocks[0]!;
    expect(block.descriptor.kind).toBe('markdown');
    expect(block.position).toEqual({ x: 100, y: 200 });
    expect(block.size).toEqual({ width: 400, height: 300 });
    expect(block.minimized).toBe(false);
  });

  it('round-trips a minimized block', () => {
    const original = makeLayout({
      blocks: [makePlacement({ minimized: true })],
    });
    const restored = deserialiseWorkbenchLayout(
      serialiseWorkbenchLayout(original)
    );
    expect(restored!.blocks[0]!.minimized).toBe(true);
  });

  it('round-trips a layout with an UNKNOWN block kind (forward-compat)', () => {
    // Simulate a layout written by a future client with kind 'ai-agent-v2'
    const futureRaw = {
      schemaVersion: WORKBENCH_LAYOUT_SCHEMA_VERSION,
      workspaceScope: { id: 'ws:future', displayName: 'future' },
      blocks: [
        {
          descriptor: {
            kind: 'ai-agent-v2', // unknown kind
            id: 'future-block',
            title: 'future block',
            capabilityRequirements: [],
            meta: { something: 'opaque' },
          },
          position: { x: 50, y: 75 },
          size: { width: 320, height: 240 },
          minimized: false,
        },
      ],
    };

    // Should deserialise without throwing
    const restored = deserialiseWorkbenchLayout(futureRaw);
    expect(restored).not.toBeNull();
    expect(restored!.blocks).toHaveLength(1);
    // The kind is preserved verbatim
    expect(restored!.blocks[0]!.descriptor.kind).toBe('ai-agent-v2');
    expect(restored!.blocks[0]!.descriptor.id).toBe('future-block');

    // Re-serialise — the unknown kind must survive another round-trip
    const reraw = serialiseWorkbenchLayout(restored!);
    const rerestored = deserialiseWorkbenchLayout(reraw);
    expect(rerestored!.blocks[0]!.descriptor.kind).toBe('ai-agent-v2');
  });

  it('preserves unknown placement fields in _unknown bag', () => {
    const rawWithExtra = {
      schemaVersion: WORKBENCH_LAYOUT_SCHEMA_VERSION,
      workspaceScope: { id: 'ws:test' },
      blocks: [
        {
          descriptor: {
            kind: 'terminal',
            id: 'b1',
            title: 't',
            capabilityRequirements: [],
            meta: {
              sessionRef: {
                nodeId: 'n1',
                sessionId: 's1',
                tabKind: 'agent',
                cwd: '/',
              },
            },
          },
          position: { x: 0, y: 0 },
          size: { width: 200, height: 100 },
          minimized: false,
          futureField: 'preserved', // extra field from future schema
        },
      ],
    };
    const restored = deserialiseWorkbenchLayout(rawWithExtra);
    expect(restored!.blocks[0]!._unknown).toBeDefined();
    expect(restored!.blocks[0]!._unknown!['futureField']).toBe('preserved');
  });

  it('returns null for null input', () => {
    expect(deserialiseWorkbenchLayout(null)).toBeNull();
    expect(deserialiseWorkbenchLayout(undefined)).toBeNull();
  });

  it('throws for non-object root', () => {
    expect(() => deserialiseWorkbenchLayout('string')).toThrow();
    expect(() => deserialiseWorkbenchLayout(42)).toThrow();
    expect(() => deserialiseWorkbenchLayout([])).toThrow();
  });

  it('throws for missing schemaVersion', () => {
    const raw = {
      workspaceScope: { id: 'ws:test' },
      blocks: [],
    };
    expect(() => deserialiseWorkbenchLayout(raw)).toThrow(/schemaVersion/);
  });

  it('throws for wrong schemaVersion', () => {
    const raw = {
      schemaVersion: 999,
      workspaceScope: { id: 'ws:test' },
      blocks: [],
    };
    expect(() => deserialiseWorkbenchLayout(raw)).toThrow(/schemaVersion/);
  });

  it('throws for missing workspaceScope.id', () => {
    const raw = {
      schemaVersion: WORKBENCH_LAYOUT_SCHEMA_VERSION,
      workspaceScope: {},
      blocks: [],
    };
    expect(() => deserialiseWorkbenchLayout(raw)).toThrow(/workspaceScope/);
  });

  it('throws for non-array blocks', () => {
    const raw = {
      schemaVersion: WORKBENCH_LAYOUT_SCHEMA_VERSION,
      workspaceScope: { id: 'ws:test' },
      blocks: 'not-an-array',
    };
    expect(() => deserialiseWorkbenchLayout(raw)).toThrow(/blocks/);
  });

  it('throws for block missing descriptor.kind', () => {
    const raw = {
      schemaVersion: WORKBENCH_LAYOUT_SCHEMA_VERSION,
      workspaceScope: { id: 'ws:test' },
      blocks: [
        {
          descriptor: {
            id: 'b1',
            title: 't',
            capabilityRequirements: [],
            meta: {},
          },
          position: { x: 0, y: 0 },
          size: { width: 200, height: 100 },
          minimized: false,
        },
      ],
    };
    expect(() => deserialiseWorkbenchLayout(raw)).toThrow(/kind/);
  });

  it('defaults minimized to false when missing', () => {
    const raw = {
      schemaVersion: WORKBENCH_LAYOUT_SCHEMA_VERSION,
      workspaceScope: { id: 'ws:test' },
      blocks: [
        {
          descriptor: {
            kind: 'markdown',
            id: 'b1',
            title: 't',
            capabilityRequirements: [],
            meta: { content: '' },
          },
          position: { x: 0, y: 0 },
          size: { width: 200, height: 100 },
          // no minimized field
        },
      ],
    };
    const restored = deserialiseWorkbenchLayout(raw);
    expect(restored!.blocks[0]!.minimized).toBe(false);
  });

  // Bug 3 fix: descriptor must include title and capabilityRequirements so
  // missingCapabilities() cannot crash on undefined at runtime.
  it('throws for block descriptor missing title', () => {
    const raw = {
      schemaVersion: WORKBENCH_LAYOUT_SCHEMA_VERSION,
      workspaceScope: { id: 'ws:test' },
      blocks: [
        {
          descriptor: {
            kind: 'markdown',
            id: 'b1',
            // title intentionally omitted
            capabilityRequirements: [],
            meta: { content: '' },
          },
          position: { x: 0, y: 0 },
          size: { width: 200, height: 100 },
          minimized: false,
        },
      ],
    };
    expect(() => deserialiseWorkbenchLayout(raw)).toThrow(/title/);
  });

  it('throws for block descriptor missing capabilityRequirements', () => {
    const raw = {
      schemaVersion: WORKBENCH_LAYOUT_SCHEMA_VERSION,
      workspaceScope: { id: 'ws:test' },
      blocks: [
        {
          descriptor: {
            kind: 'markdown',
            id: 'b1',
            title: 't',
            // capabilityRequirements intentionally omitted
            meta: { content: '' },
          },
          position: { x: 0, y: 0 },
          size: { width: 200, height: 100 },
          minimized: false,
        },
      ],
    };
    expect(() => deserialiseWorkbenchLayout(raw)).toThrow(
      /capabilityRequirements/
    );
  });

  // Bug 4 fix: existing _unknown from a stored JSON bag must be preserved
  // when deserializing, so unknown fields survive multiple round-trips.
  it('preserves _unknown bag across multiple serialize/deserialize cycles', () => {
    // Simulate a layout that was already deserialized once and has an _unknown bag.
    const rawWithBothExtraAndUnknown = {
      schemaVersion: WORKBENCH_LAYOUT_SCHEMA_VERSION,
      workspaceScope: { id: 'ws:test' },
      blocks: [
        {
          descriptor: {
            kind: 'markdown',
            id: 'b1',
            title: 't',
            capabilityRequirements: [],
            meta: { content: '' },
          },
          position: { x: 0, y: 0 },
          size: { width: 200, height: 100 },
          minimized: false,
          // Simulates a field that was in _unknown from a prior deserialization
          // and was merged back into the top-level by serialiseWorkbenchLayout.
          futureTopLevelField: 'must survive',
          // An _unknown bag from a prior cycle (would come from a server that
          // itself already did the round-trip preservation).
          _unknown: { olderFutureField: 'also preserved' },
        },
      ],
    };

    // First deserialization: collects futureTopLevelField into _unknown, merges
    // olderFutureField from the existing _unknown bag.
    const restored1 = deserialiseWorkbenchLayout(rawWithBothExtraAndUnknown);
    expect(restored1).not.toBeNull();
    expect(restored1!.blocks[0]!._unknown).toBeDefined();
    expect(restored1!.blocks[0]!._unknown!['futureTopLevelField']).toBe(
      'must survive'
    );
    expect(restored1!.blocks[0]!._unknown!['olderFutureField']).toBe(
      'also preserved'
    );

    // Serialize back out — both unknown fields must be in the top-level output.
    const serialized = serialiseWorkbenchLayout(restored1!);
    const block0 = serialized.blocks[0] as Record<string, unknown>;
    expect(block0['futureTopLevelField']).toBe('must survive');
    expect(block0['olderFutureField']).toBe('also preserved');

    // Second deserialization — unknown fields must still be present.
    const restored2 = deserialiseWorkbenchLayout(serialized);
    expect(restored2!.blocks[0]!._unknown!['futureTopLevelField']).toBe(
      'must survive'
    );
    expect(restored2!.blocks[0]!._unknown!['olderFutureField']).toBe(
      'also preserved'
    );
  });
});

// ---------------------------------------------------------------------------
// 2. Server storage module — file read/write
// ---------------------------------------------------------------------------

import {
  readWorkbenchLayout,
  writeWorkbenchLayout,
  deleteWorkbenchLayout,
  validateLayoutBody,
} from '../server/workbench-layout.js';

describe('workbench-layout server storage', () => {
  let tmpDir: string;
  let configPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-wb-test-'));
    configPath = path.join(tmpDir, 'config.json');
    // Config file itself doesn't need to exist for layout tests
    fs.writeFileSync(configPath, '{}', 'utf8');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns null when no layout has been stored', () => {
    const result = readWorkbenchLayout(configPath, 'ws:test');
    expect(result).toBeNull();
  });

  it('round-trips a layout through write/read', () => {
    const layout = makeLayout();
    writeWorkbenchLayout(configPath, 'ws:test', layout);
    const restored = readWorkbenchLayout(configPath, 'ws:test');
    expect(restored).not.toBeNull();
    expect(restored!.workspaceScope.id).toBe('ws:test');
    expect(restored!.blocks).toHaveLength(1);
  });

  it('different workspaceIds write independent files', () => {
    const layout1 = makeLayout({
      workspaceScope: { id: 'ws:alpha' },
      blocks: [],
    });
    const layout2 = makeLayout({
      workspaceScope: { id: 'ws:beta' },
      blocks: [
        makePlacement({
          descriptor: {
            kind: 'markdown',
            id: 'b2',
            title: 'beta',
            capabilityRequirements: [],
            meta: { content: 'b' },
          },
        }),
      ],
    });
    writeWorkbenchLayout(configPath, 'ws:alpha', layout1);
    writeWorkbenchLayout(configPath, 'ws:beta', layout2);

    const r1 = readWorkbenchLayout(configPath, 'ws:alpha');
    const r2 = readWorkbenchLayout(configPath, 'ws:beta');
    expect(r1!.blocks).toHaveLength(0);
    expect(r2!.blocks).toHaveLength(1);
  });

  it('delete silently removes the layout', () => {
    writeWorkbenchLayout(configPath, 'ws:test', makeLayout());
    expect(readWorkbenchLayout(configPath, 'ws:test')).not.toBeNull();
    deleteWorkbenchLayout(configPath, 'ws:test');
    expect(readWorkbenchLayout(configPath, 'ws:test')).toBeNull();
  });

  it('delete on non-existent layout does not throw', () => {
    expect(() => deleteWorkbenchLayout(configPath, 'ws:ghost')).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 3. Server REST endpoints — router integration test
// ---------------------------------------------------------------------------

import http from 'node:http';
import express from 'express';
import type { Express } from 'express';
import { createWorkbenchLayoutRouter } from '../server/workbench-layout.js';

function buildTestApp(configPath: string): Express {
  const app = express();
  app.use(express.json());
  // Mount with the same params-shape as the real server
  app.use('/workspace-groups', createWorkbenchLayoutRouter({ configPath }));
  return app;
}

/**
 * Minimal HTTP test helper — invoke an Express app in-process without
 * starting a real server, matching the pattern used in other server tests.
 */
async function call(
  app: Express,
  method: 'GET' | 'PUT',
  url: string,
  body?: unknown
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, () => {
      const addr = server.address() as { port: number };
      const port = addr.port;
      const bodyStr = body !== undefined ? JSON.stringify(body) : undefined;
      const headers: Record<string, string> = {};
      if (bodyStr !== undefined) {
        headers['Content-Type'] = 'application/json';
        headers['Content-Length'] = String(Buffer.byteLength(bodyStr));
      }
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          path: url,
          method,
          headers,
        },
        (res) => {
          let data = '';
          res.on('data', (chunk: Buffer) => {
            data += chunk.toString();
          });
          res.on('end', () => {
            server.close();
            const parsed = data.trim() ? JSON.parse(data) : null;
            resolve({ status: res.statusCode ?? 0, body: parsed });
          });
        }
      );
      req.on('error', (err: Error) => {
        server.close();
        reject(err);
      });
      if (bodyStr !== undefined) req.write(bodyStr);
      req.end();
    });
  });
}

describe('workbench-layout REST endpoints', () => {
  let tmpDir: string;
  let configPath: string;
  let app: Express;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-wb-api-test-'));
    configPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(configPath, '{}', 'utf8');
    app = buildTestApp(configPath);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('GET returns 204 when no layout is stored', async () => {
    const result = await call(
      app,
      'GET',
      '/workspace-groups/ws%3Atest/workbench-layout'
    );
    expect(result.status).toBe(204);
    expect(result.body).toBeNull();
  });

  it('PUT persists a valid layout and returns 200 with the layout', async () => {
    const layout = makeLayout({ workspaceScope: { id: 'ws:test' } });
    const putResult = await call(
      app,
      'PUT',
      '/workspace-groups/ws%3Atest/workbench-layout',
      layout
    );
    expect(putResult.status).toBe(200);
    const returnedLayout = putResult.body as WorkbenchLayout;
    expect(returnedLayout.schemaVersion).toBe(WORKBENCH_LAYOUT_SCHEMA_VERSION);
    expect(returnedLayout.blocks).toHaveLength(1);
  });

  it('GET returns what was PUT', async () => {
    const layout = makeLayout({ workspaceScope: { id: 'ws:alpha' } });
    await call(
      app,
      'PUT',
      '/workspace-groups/ws%3Aalpha/workbench-layout',
      layout
    );
    const getResult = await call(
      app,
      'GET',
      '/workspace-groups/ws%3Aalpha/workbench-layout'
    );
    expect(getResult.status).toBe(200);
    const returned = getResult.body as WorkbenchLayout;
    expect(returned.blocks).toHaveLength(1);
    expect(returned.blocks[0]!.descriptor.kind).toBe('markdown');
  });

  it('PUT rejects mismatched workspaceScope.id', async () => {
    const layout = makeLayout({ workspaceScope: { id: 'ws:other' } });
    const result = await call(
      app,
      'PUT',
      '/workspace-groups/ws%3Atest/workbench-layout',
      layout
    );
    expect(result.status).toBe(400);
  });

  it('PUT rejects wrong schemaVersion', async () => {
    const bad = { ...makeLayout(), schemaVersion: 999 };
    const result = await call(
      app,
      'PUT',
      '/workspace-groups/ws%3Atest/workbench-layout',
      bad
    );
    expect(result.status).toBe(400);
  });

  it('PUT accepts unknown block kinds (forward-compat)', async () => {
    const layout = {
      schemaVersion: WORKBENCH_LAYOUT_SCHEMA_VERSION,
      workspaceScope: { id: 'ws:future' },
      blocks: [
        {
          descriptor: {
            kind: 'ai-agent-v2',
            id: 'b1',
            title: 't',
            capabilityRequirements: [],
            meta: {},
          },
          position: { x: 0, y: 0 },
          size: { width: 200, height: 100 },
          minimized: false,
        },
      ],
    };
    const result = await call(
      app,
      'PUT',
      '/workspace-groups/ws%3Afuture/workbench-layout',
      layout
    );
    expect(result.status).toBe(200);
    // The unknown kind should round-trip
    const returned = result.body as WorkbenchLayout;
    expect(returned.blocks[0]!.descriptor.kind).toBe('ai-agent-v2');
  });

  it('different workspace IDs are stored independently', async () => {
    const layoutA = makeLayout({
      workspaceScope: { id: 'ws:aaa' },
      blocks: [],
    });
    const layoutB = makeLayout({
      workspaceScope: { id: 'ws:bbb' },
      blocks: [makePlacement()],
    });
    await call(
      app,
      'PUT',
      '/workspace-groups/ws%3Aaaa/workbench-layout',
      layoutA
    );
    await call(
      app,
      'PUT',
      '/workspace-groups/ws%3Abbb/workbench-layout',
      layoutB
    );

    const getA = await call(
      app,
      'GET',
      '/workspace-groups/ws%3Aaaa/workbench-layout'
    );
    const getB = await call(
      app,
      'GET',
      '/workspace-groups/ws%3Abbb/workbench-layout'
    );

    expect((getA.body as WorkbenchLayout).blocks).toHaveLength(0);
    expect((getB.body as WorkbenchLayout).blocks).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 4. validateLayoutBody — unit tests
// ---------------------------------------------------------------------------

describe('validateLayoutBody', () => {
  it('returns null for a valid body', () => {
    expect(validateLayoutBody(makeLayout())).toBeNull();
  });

  it('returns error for non-object', () => {
    expect(validateLayoutBody('string')).not.toBeNull();
    expect(validateLayoutBody(null)).not.toBeNull();
    expect(validateLayoutBody(42)).not.toBeNull();
  });

  it('returns error for missing schemaVersion', () => {
    const bad = { workspaceScope: { id: 'ws:x' }, blocks: [] };
    expect(validateLayoutBody(bad)).toMatch(/schemaVersion/);
  });

  it('returns error for wrong schemaVersion', () => {
    const bad = {
      schemaVersion: 2,
      workspaceScope: { id: 'ws:x' },
      blocks: [],
    };
    expect(validateLayoutBody(bad)).toMatch(/schemaVersion/);
  });

  it('accepts unknown block kinds when required descriptor fields are present', () => {
    // Bug 3 fix: unknown *kinds* are accepted, but title + capabilityRequirements
    // are required on every descriptor so missingCapabilities() cannot crash.
    const good = {
      schemaVersion: WORKBENCH_LAYOUT_SCHEMA_VERSION,
      workspaceScope: { id: 'ws:x' },
      blocks: [
        {
          descriptor: {
            kind: 'future-kind',
            id: 'b1',
            title: 'future block',
            capabilityRequirements: [],
          },
          position: { x: 0, y: 0 },
          size: { width: 200, height: 100 },
          minimized: false,
        },
      ],
    };
    expect(validateLayoutBody(good)).toBeNull();
  });

  it('rejects descriptor missing title', () => {
    // Bug 3: title is required — absence must produce a validation error.
    const bad = {
      schemaVersion: WORKBENCH_LAYOUT_SCHEMA_VERSION,
      workspaceScope: { id: 'ws:x' },
      blocks: [
        {
          descriptor: {
            kind: 'future-kind',
            id: 'b1',
            // title intentionally omitted
            capabilityRequirements: [],
          },
          position: { x: 0, y: 0 },
          size: { width: 200, height: 100 },
          minimized: false,
        },
      ],
    };
    expect(validateLayoutBody(bad)).toMatch(/title/);
  });

  it('rejects descriptor missing capabilityRequirements', () => {
    // Bug 3: capabilityRequirements is required — absence must produce a
    // validation error so missingCapabilities() cannot crash on undefined.
    const bad = {
      schemaVersion: WORKBENCH_LAYOUT_SCHEMA_VERSION,
      workspaceScope: { id: 'ws:x' },
      blocks: [
        {
          descriptor: {
            kind: 'markdown',
            id: 'b1',
            title: 'some block',
            // capabilityRequirements intentionally omitted
          },
          position: { x: 0, y: 0 },
          size: { width: 200, height: 100 },
          minimized: false,
        },
      ],
    };
    expect(validateLayoutBody(bad)).toMatch(/capabilityRequirements/);
  });
});
