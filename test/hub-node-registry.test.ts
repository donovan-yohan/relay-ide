import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createHubNodeRegistry,
  DEFAULT_NODE_HEARTBEAT_TIMEOUTS,
} from '../server/hub-node-registry.js';
import type { NodeManifest } from '../shared/node-manifest.js';

function manifest(overrides: Partial<NodeManifest> = {}): NodeManifest {
  return {
    schemaVersion: 1,
    platform: 'darwin',
    arch: 'arm64',
    hostname: 'test-host',
    relayVersion: '9.9.9',
    generatedAt: '2026-01-02T03:04:05.000Z',
    wsl: { detected: false, version: null, systemd: false },
    serviceManager: {
      kind: 'launchd',
      label: 'launchd',
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
        status: 'degraded',
        message: 'file fallback',
      },
      browserAutomation: {
        id: 'browserAutomation',
        label: 'Browser automation',
        status: 'available',
        message: 'ok',
      },
      githubCli: {
        id: 'githubCli',
        label: 'GitHub CLI',
        status: 'unavailable',
        message: 'missing',
      },
      tailscale: {
        id: 'tailscale',
        label: 'Tailscale CLI',
        status: 'available',
        message: 'ok',
      },
      ssh: { id: 'ssh', label: 'SSH client', status: 'available', message: 'ok' },
      agents: {
        claude: {
          id: 'claude',
          label: 'Claude',
          status: 'available',
          message: 'ok',
        },
        codex: {
          id: 'codex',
          label: 'Codex',
          status: 'unavailable',
          message: 'missing',
        },
      },
    },
    ...overrides,
  };
}

function withTmpRegistry<T>(fn: (registry: ReturnType<typeof createHubNodeRegistry>) => T): T {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-hub-node-registry-'));
  try {
    return fn(
      createHubNodeRegistry({
        storagePath: path.join(tmpDir, 'nodes.json'),
        now: () => new Date('2026-01-02T03:04:05.000Z'),
      })
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

describe('hub node registry', () => {
  it('exchanges a one-time pair token for a durable credential without storing raw secret material', () => {
    withTmpRegistry((registry) => {
      const pair = registry.createPairToken({ displayName: 'Dev Mac' });
      expect(pair.pairToken).toMatch(/^pair_/);
      expect(pair.expiresAt).toBe('2026-01-02T03:14:05.000Z');

      const exchanged = registry.exchangePairToken({
        pairToken: pair.pairToken,
        manifest: manifest(),
        displayName: 'Dev Mac',
      });

      expect(exchanged.credential).toMatchObject({
        protocol: 'relay-node-link',
        protocolVersion: '1.0',
        nodeId: exchanged.node.nodeId,
      });
      expect(exchanged.credential.token).toMatch(new RegExp(`^${exchanged.node.nodeId}\\.`));
      expect(exchanged.node).toMatchObject({
        displayName: 'Dev Mac',
        hostname: 'test-host',
        platform: 'darwin',
        relayVersion: '9.9.9',
        protocolVersion: '1.0',
        status: 'online',
        capabilities: {
          totals: { available: 6, degraded: 1, unavailable: 2, unknown: 0 },
          agents: { claude: 'available', codex: 'unavailable' },
        },
      });

      expect(() =>
        registry.exchangePairToken({ pairToken: pair.pairToken, manifest: manifest() })
      ).toThrow(/TOKEN_ALREADY_USED/);

      const persisted = fs.readFileSync(registry.storagePath, 'utf8');
      expect(persisted).not.toContain(pair.pairToken);
      expect(persisted).not.toContain(exchanged.credential.token);
      expect(persisted).not.toContain(exchanged.credential.token.split('.')[1]!);
    });
  });

  it('persists paired nodes and authenticates durable node credentials after reload', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-hub-node-registry-'));
    try {
      const storagePath = path.join(tmpDir, 'nodes.json');
      const registry = createHubNodeRegistry({
        storagePath,
        now: () => new Date('2026-01-02T03:04:05.000Z'),
      });
      const pair = registry.createPairToken({});
      const exchanged = registry.exchangePairToken({
        pairToken: pair.pairToken,
        manifest: manifest({ hostname: 'persisted-host' }),
      });

      const reloaded = createHubNodeRegistry({
        storagePath,
        now: () => new Date('2026-01-02T03:04:06.000Z'),
      });

      expect(reloaded.authenticateCredential(exchanged.credential.token)?.nodeId).toBe(
        exchanged.node.nodeId
      );
      expect(reloaded.listNodes()[0]).toMatchObject({
        nodeId: exchanged.node.nodeId,
        hostname: 'persisted-host',
        status: 'online',
      });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('computes deterministic stale and offline states from heartbeat age', () => {
    const storagePath = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'relay-hub-node-registry-')),
      'nodes.json'
    );
    let now = new Date('2026-01-02T03:04:05.000Z');
    try {
      const registry = createHubNodeRegistry({ storagePath, now: () => now });
      const exchanged = registry.exchangePairToken({
        pairToken: registry.createPairToken({}).pairToken,
        manifest: manifest(),
      });

      now = new Date(
        Date.parse(exchanged.node.lastSeenAt) + DEFAULT_NODE_HEARTBEAT_TIMEOUTS.staleMs + 1
      );
      expect(registry.listNodes()[0]?.status).toBe('stale');

      now = new Date(
        Date.parse(exchanged.node.lastSeenAt) + DEFAULT_NODE_HEARTBEAT_TIMEOUTS.offlineMs + 1
      );
      expect(registry.listNodes()[0]?.status).toBe('offline');

      registry.recordHeartbeat({
        nodeId: exchanged.node.nodeId,
        protocolVersion: '1.0',
        manifest: manifest({ relayVersion: '10.0.0' }),
      });

      expect(registry.listNodes()[0]).toMatchObject({
        status: 'online',
        relayVersion: '10.0.0',
      });
    } finally {
      fs.rmSync(path.dirname(storagePath), { recursive: true, force: true });
    }
  });

  it('debounces heartbeat persistence and flushes the latest node state deterministically', async () => {
    const storagePath = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'relay-hub-node-registry-')),
      'nodes.json'
    );
    let now = new Date('2026-01-02T03:04:05.000Z');
    try {
      const registry = createHubNodeRegistry({
        storagePath,
        now: () => now,
        heartbeatPersistDebounceMs: 60_000,
      });
      const exchanged = registry.exchangePairToken({
        pairToken: registry.createPairToken({}).pairToken,
        manifest: manifest(),
      });
      const persistedBeforeHeartbeat = JSON.parse(fs.readFileSync(storagePath, 'utf8')) as {
        nodes: Array<{ lastSeenAt: string; hostname: string }>;
      };

      now = new Date('2026-01-02T03:05:05.000Z');
      registry.recordHeartbeat({
        nodeId: exchanged.node.nodeId,
        protocolVersion: '1.0',
        manifest: manifest({ hostname: 'heartbeat-host', relayVersion: '10.0.0' }),
      });

      const persistedImmediatelyAfterHeartbeat = JSON.parse(fs.readFileSync(storagePath, 'utf8')) as {
        nodes: Array<{ lastSeenAt: string; hostname: string; relayVersion: string }>;
      };
      expect(persistedImmediatelyAfterHeartbeat.nodes[0]).toMatchObject({
        lastSeenAt: persistedBeforeHeartbeat.nodes[0]?.lastSeenAt,
        hostname: 'test-host',
        relayVersion: '9.9.9',
      });

      await registry.flushPendingHeartbeatPersist();

      const persistedAfterFlush = JSON.parse(fs.readFileSync(storagePath, 'utf8')) as {
        nodes: Array<{ lastSeenAt: string; hostname: string; relayVersion: string }>;
      };
      expect(persistedAfterFlush.nodes[0]).toMatchObject({
        lastSeenAt: '2026-01-02T03:05:05.000Z',
        hostname: 'heartbeat-host',
        relayVersion: '10.0.0',
      });
    } finally {
      fs.rmSync(path.dirname(storagePath), { recursive: true, force: true });
    }
  });

  it('returns typed errors for expired tokens, bad credentials, and incompatible protocol versions', () => {
    withTmpRegistry((registry) => {
      const pair = registry.createPairToken({ ttlMs: 1 });
      registry.setNowForTest(() => new Date('2026-01-02T03:04:06.000Z'));
      expect(() =>
        registry.exchangePairToken({ pairToken: pair.pairToken, manifest: manifest() })
      ).toThrow(/TOKEN_EXPIRED/);

      registry.setNowForTest(() => new Date('2026-01-02T03:04:07.000Z'));
      expect(registry.authenticateCredential('node_missing.bad')).toBeNull();

      const fresh = registry.createPairToken({});
      expect(() =>
        registry.exchangePairToken({
          pairToken: fresh.pairToken,
          manifest: manifest(),
          protocolVersion: '2.0',
        })
      ).toThrow(/PROTOCOL_INCOMPATIBLE/);
    });
  });
});
