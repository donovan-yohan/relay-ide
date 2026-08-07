/**
 * Tests for hub↔node helper-version skew detection (#655, Slice 5 of epic #613).
 *
 * Covers:
 *   - classifyHelperSkew categorization (compatible / minor-skew-warn / major-skew-error)
 *   - Edge cases: unknown version, node ahead of hub, exact match, pre-release
 *   - Registry markNodeUpdating / markNodeUpdateComplete state transitions
 *   - Session-create 503 gate for updating nodes and major-skew nodes
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import express from 'express';
import http from 'node:http';
import { describe, expect, it, afterEach } from 'vitest';
import { classifyHelperSkew } from '../server/node-version-skew.js';
import { createHubNodeRegistry } from '../server/hub-node-registry.js';
import { createHubNodeRouter } from '../server/hub-node-router.js';
import { createSessionEnvelopeRegistry } from '../server/session-envelope-registry.js';
import type { NodeManifest } from '../shared/node-manifest.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeManifest(overrides: Partial<NodeManifest> = {}): NodeManifest {
  return {
    schemaVersion: 1,
    platform: 'linux',
    arch: 'x64',
    hostname: 'test-node',
    relayVersion: '0.1.0-test',
    helperVersion: '0.1.0-test',
    protocolVersion: '1.0',
    generatedAt: new Date().toISOString(),
    resolvedPaths: {},
    fileRpc: { available: true, capabilities: [] },
    degradedReasons: [],
    wsl: { detected: false, version: null, systemd: false },
    serviceManager: {
      kind: 'systemd-user',
      label: 'systemd user',
      supported: true,
      installable: true,
      installHint: 'install',
      uninstallHint: 'uninstall',
      message: 'ok',
      caveats: [],
    },
    capabilities: {
      tmux: { id: 'tmux', label: 'tmux', status: 'available', message: 'ok' },
      git: { id: 'git', label: 'Git', status: 'available', message: 'ok' },
      clipboard: {
        id: 'clipboard',
        label: 'Clipboard',
        status: 'unknown',
        message: 'unknown',
      },
      browserAutomation: {
        id: 'ba',
        label: 'Browser',
        status: 'degraded',
        message: 'missing',
      },
      githubCli: {
        id: 'gh',
        label: 'GitHub CLI',
        status: 'available',
        message: 'ok',
      },
      tailscale: {
        id: 'ts',
        label: 'Tailscale',
        status: 'unavailable',
        message: 'missing',
      },
      ssh: { id: 'ssh', label: 'SSH', status: 'available', message: 'ok' },
      agents: {},
    },
    ...overrides,
  };
}

function withTmpRegistry<T>(
  fn: (registry: ReturnType<typeof createHubNodeRegistry>) => T,
  hubVersion?: string
): T {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-skew-test-'));
  try {
    return fn(
      createHubNodeRegistry({
        storagePath: path.join(tmpDir, 'nodes.json'),
        now: () => new Date('2026-01-02T03:04:05.000Z'),
        hubVersion,
      })
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// classifyHelperSkew: compatibility policy
// ---------------------------------------------------------------------------

describe('classifyHelperSkew', () => {
  it('returns compatible when versions match exactly', () => {
    const result = classifyHelperSkew('0.1.0', '0.1.0');
    expect(result.category).toBe('compatible');
  });

  it('returns compatible for same major.minor with different patch', () => {
    const result = classifyHelperSkew('0.1.3', '0.1.7');
    // same major.minor → minor gap is 0, still compatible
    expect(result.category).toBe('compatible');
  });

  it('returns minor-skew-warn when node is 1 minor behind hub', () => {
    const result = classifyHelperSkew('0.1.0', '0.2.0');
    expect(result.category).toBe('minor-skew-warn');
    expect(result.remediationHint).toBeDefined();
  });

  it('returns minor-skew-warn when node is 2 minor versions behind hub', () => {
    const result = classifyHelperSkew('0.1.0', '0.3.0');
    expect(result.category).toBe('minor-skew-warn');
  });

  it('returns minor-skew-warn when node is 3+ minor versions behind hub (strongly warns)', () => {
    const result = classifyHelperSkew('0.1.0', '0.5.0');
    expect(result.category).toBe('minor-skew-warn');
    expect(result.message).toMatch(/strongly recommended/);
  });

  it('returns minor-skew-warn when node is ahead of hub', () => {
    const result = classifyHelperSkew('0.5.0', '0.4.0');
    expect(result.category).toBe('minor-skew-warn');
  });

  it('returns major-skew-error when node major is lower than hub major', () => {
    const result = classifyHelperSkew('0.1.0', '1.0.0');
    expect(result.category).toBe('major-skew-error');
    expect(result.message).toMatch(/new sessions blocked/);
    expect(result.remediationHint).toBeDefined();
  });

  it('returns major-skew-error when node major is higher than hub major', () => {
    const result = classifyHelperSkew('2.0.0', '1.0.0');
    expect(result.category).toBe('major-skew-error');
  });

  it('returns minor-skew-warn for unknown helper version', () => {
    const result = classifyHelperSkew('unknown', '0.1.0');
    expect(result.category).toBe('minor-skew-warn');
    expect(result.message).toMatch(/unknown/);
  });

  it('returns minor-skew-warn for empty helper version', () => {
    const result = classifyHelperSkew('', '0.1.0');
    expect(result.category).toBe('minor-skew-warn');
  });

  it('handles nightly pre-release versions as same major', () => {
    // pre-release: 0.1.0-nightly.X — major is 0, same as hub 0.2.0
    const result = classifyHelperSkew('0.1.0-nightly.20260501.1', '0.2.0');
    expect(result.category).toBe('minor-skew-warn');
  });

  it('blocks sessions when node is nightly and hub is major-bumped', () => {
    const result = classifyHelperSkew('0.1.0-nightly.20260501.1', '1.0.0');
    expect(result.category).toBe('major-skew-error');
  });

  it('includes helperVersion and hubVersion in result', () => {
    const result = classifyHelperSkew('0.1.0', '0.2.0');
    expect(result.helperVersion).toBe('0.1.0');
    expect(result.hubVersion).toBe('0.2.0');
  });
});

// ---------------------------------------------------------------------------
// Registry: markNodeUpdating / markNodeUpdateComplete
// ---------------------------------------------------------------------------

describe('hub-node-registry updating state', () => {
  function pairNode(registry: ReturnType<typeof createHubNodeRegistry>) {
    const { pairToken } = registry.createPairToken({});
    return registry.exchangePairToken({
      pairToken,
      manifest: makeManifest(),
      protocolVersion: '1.0',
    });
  }

  it('marks node as updating and back to normal', () => {
    withTmpRegistry((registry) => {
      const { node } = pairNode(registry);
      const updating = registry.markNodeUpdating(node.nodeId);
      expect(updating.status).toBe('updating');

      const complete = registry.markNodeUpdateComplete(node.nodeId);
      // after clearing, node was not heartbeating so may be offline/stale — just not 'updating'
      expect(complete.status).not.toBe('updating');
    });
  });

  it('idempotent: markNodeUpdating twice does not throw', () => {
    withTmpRegistry((registry) => {
      const { node } = pairNode(registry);
      registry.markNodeUpdating(node.nodeId);
      const second = registry.markNodeUpdating(node.nodeId);
      expect(second.status).toBe('updating');
    });
  });

  it('throws NOT_FOUND for unknown node on markNodeUpdating', () => {
    withTmpRegistry((registry) => {
      expect(() => registry.markNodeUpdating('node_nonexistent')).toThrow();
    });
  });

  it('throws NOT_FOUND for unknown node on markNodeUpdateComplete', () => {
    withTmpRegistry((registry) => {
      expect(() =>
        registry.markNodeUpdateComplete('node_nonexistent')
      ).toThrow();
    });
  });

  it('listNodes includes updating status', () => {
    withTmpRegistry((registry) => {
      const { node } = pairNode(registry);
      registry.markNodeUpdating(node.nodeId);
      const nodes = registry.listNodes();
      const found = nodes.find((n) => n.nodeId === node.nodeId);
      expect(found?.status).toBe('updating');
    });
  });
});

// ---------------------------------------------------------------------------
// Registry: helperSkew in publicNode
// ---------------------------------------------------------------------------

describe('hub-node-registry helperSkew', () => {
  function pairNode(
    registry: ReturnType<typeof createHubNodeRegistry>,
    helperVersion: string
  ) {
    const { pairToken } = registry.createPairToken({});
    return registry.exchangePairToken({
      pairToken,
      manifest: makeManifest({ helperVersion, relayVersion: helperVersion }),
      protocolVersion: '1.0',
    });
  }

  it('exposes compatible helperSkew when versions match', () => {
    withTmpRegistry((registry) => {
      const { node } = pairNode(registry, '0.1.0');
      expect(node.helperSkew?.category).toBe('compatible');
    }, '0.1.0');
  });

  it('exposes minor-skew-warn when helper is one minor behind', () => {
    withTmpRegistry((registry) => {
      const { node } = pairNode(registry, '0.1.0');
      expect(node.helperSkew?.category).toBe('minor-skew-warn');
    }, '0.2.0');
  });

  it('exposes major-skew-error when helper is a different major', () => {
    withTmpRegistry((registry) => {
      const { node } = pairNode(registry, '0.1.0');
      expect(node.helperSkew?.category).toBe('major-skew-error');
    }, '1.0.0');
  });

  it('omits helperSkew when no hubVersion configured', () => {
    withTmpRegistry((registry) => {
      const { node } = pairNode(registry, '0.1.0');
      expect(node.helperSkew).toBeUndefined();
    });
  });

  it('updates helperSkew after heartbeat with new helperVersion', () => {
    withTmpRegistry((registry) => {
      const { node } = pairNode(registry, '0.1.0');
      const updated = registry.recordHeartbeat({
        nodeId: node.nodeId,
        protocolVersion: '1.0',
        manifest: makeManifest({
          helperVersion: '0.2.0',
          relayVersion: '0.2.0',
        }),
      });
      // now within same major, minor gap=0 → compatible
      expect(updated.helperSkew?.category).toBe('compatible');
    }, '0.2.0');
  });
});

// ---------------------------------------------------------------------------
// HTTP: 503 gate for updating and major-skew nodes
// ---------------------------------------------------------------------------

describe('session-create 503 gate', () => {
  const servers: http.Server[] = [];

  afterEach(async () => {
    await Promise.all(
      servers.map((s) => new Promise<void>((r) => s.close(() => r())))
    );
    servers.length = 0;
  });

  async function setupServer(hubVersion: string) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-skew-http-'));
    const registry = createHubNodeRegistry({
      storagePath: path.join(tmpDir, 'nodes.json'),
      now: () => new Date('2026-01-02T03:04:05.000Z'),
      hubVersion,
    });

    // Pair a node with the given helper version
    const { pairToken } = registry.createPairToken({});
    const { node } = registry.exchangePairToken({
      pairToken,
      manifest: makeManifest({ helperVersion: '0.1.0', relayVersion: '0.1.0' }),
      protocolVersion: '1.0',
    });

    const app = express();
    app.use(express.json());
    const requireAuth: express.RequestHandler = (_req, _res, next) => next();
    const envelopes = createSessionEnvelopeRegistry();
    const router = createHubNodeRouter({
      registry,
      requireAuth,
      sessionEnvelopes: envelopes,
    });
    app.use(router);

    const server = http.createServer(app);
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve)
    );
    servers.push(server);
    const address = server.address() as { port: number };
    const base = `http://127.0.0.1:${address.port}`;

    return { registry, node, base, tmpDir };
  }

  it('returns 503 with Retry-After when node is in updating state', async () => {
    const { registry, node, base } = await setupServer('0.1.0');
    registry.markNodeUpdating(node.nodeId);

    const res = await fetch(`${base}/hub/nodes/${node.nodeId}/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'terminal' }),
    });

    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('60');
    const body = (await res.json()) as {
      error: { details?: { reasonCode?: string } };
    };
    expect(body.error.details?.reasonCode).toBe('NODE_UPDATING');
  });

  it('returns 503 with Retry-After when node has major-skew-error', async () => {
    // Hub is v1.0.0, node helper is v0.1.0 → major skew
    const { node, base } = await setupServer('1.0.0');

    const res = await fetch(`${base}/hub/nodes/${node.nodeId}/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'terminal' }),
    });

    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('60');
    const body = (await res.json()) as {
      error: { details?: { reasonCode?: string } };
    };
    expect(body.error.details?.reasonCode).toBe('NODE_VERSION_SKEW');
  });

  it('does not block sessions for minor-skew-warn nodes', async () => {
    // Hub is v0.2.0, node helper is v0.1.0 → minor skew, sessions allowed
    const { node, base } = await setupServer('0.2.0');

    const res = await fetch(`${base}/hub/nodes/${node.nodeId}/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'terminal' }),
    });

    // Should not get 503 from skew; the request will fail for a different
    // reason (node offline because no live node link) but not from the skew gate.
    expect(res.status).not.toBe(503);
  });
});
