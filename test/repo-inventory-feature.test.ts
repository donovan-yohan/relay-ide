import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import http from 'node:http';
import { WebSocket } from 'ws';
import express from 'express';
import { createHubNodeRegistry } from '../server/hub-node-registry.js';
import { createHubNodeLinkManager } from '../server/hub-node-link.js';
import { setupWebSocket } from '../server/ws.js';
import {
  createRepoInventoryFeature,
  validateInventoryPayload,
  parseStoredInventory,
} from '../server/features/repo-inventory.js';
import type { RepoInventoryReport } from '../shared/repo-inventory.js';
import type { NodeManifest } from '../shared/node-manifest.js';
import { testBrowserAuthTokens } from './helpers/ws-auth.js';

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (typeof address !== 'object' || address === null) {
        throw new Error('listen did not return an address');
      }
      resolve(address.port);
    });
  });
}

function close(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

function manifest(): NodeManifest {
  return {
    schemaVersion: 1,
    platform: 'linux',
    arch: 'x64',
    hostname: 'node-feature-host',
    helperVersion: '0.1.0-test',
    relayVersion: '0.1.0-test',
    protocolVersion: '1.0',
    generatedAt: '2026-01-02T03:04:05.000Z',
    resolvedPaths: {},
    fileRpc: { available: true, capabilities: [] },
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
      terminalBackends: {
        'relay-pty': {
          id: 'relay-pty',
          label: 'relay-pty',
          status: 'available',
          message: 'relay-pty ready',
        },
      },
      git: {
        id: 'git',
        label: 'Git',
        status: 'available',
        message: 'git 2.45.0',
      },
      clipboard: {
        id: 'clipboard',
        label: 'Clipboard',
        status: 'available',
        message: 'pbcopy',
      },
      browserAutomation: {
        id: 'browserAutomation',
        label: 'Browser automation',
        status: 'available',
        message: 'playwright ok',
      },
      githubCli: {
        id: 'githubCli',
        label: 'GitHub CLI',
        status: 'available',
        message: 'gh 2.51',
      },
      tailscale: {
        id: 'tailscale',
        label: 'Tailscale CLI',
        status: 'available',
        message: 'tailscale 1.62',
      },
      ssh: {
        id: 'ssh',
        label: 'SSH client',
        status: 'available',
        message: 'OpenSSH 9.7',
      },
      agents: {},
    },
    degradedReasons: [],
  };
}

function report(nodeId: string, repoPath: string): RepoInventoryReport {
  return {
    nodeId,
    generatedAt: '2026-01-02T03:04:05.000Z',
    repos: [
      {
        repoInstanceId: `${nodeId}:${repoPath}`,
        nodeId,
        localPath: repoPath,
        name: 'relay-ide',
        isGitRepo: true,
        defaultBranch: 'nightly',
        currentBranch: 'nightly',
        repoIdentity: 'github.com/donovan-yohan/relay-ide',
        selectedRemote: null,
        remotes: [],
        repoIdentityWarnings: [],
        worktrees: [],
        reportedAt: '2026-01-02T03:04:05.000Z',
      },
    ],
  };
}

function tmpRegistry() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-repo-inv-feat-'));
  const registry = createHubNodeRegistry({
    storagePath: path.join(tmpDir, 'nodes.json'),
    now: () => new Date('2026-01-02T03:04:05.000Z'),
  });
  return { tmpDir, registry };
}

describe('repo-inventory feature', () => {
  it('validateInventoryPayload accepts an undefined payload as a no-op pass-through', () => {
    const result = validateInventoryPayload(undefined, { nodeId: 'node-a' });
    expect(result).toEqual({ ok: true, payload: undefined });
  });

  it('validateInventoryPayload rejects malformed payloads', () => {
    const result = validateInventoryPayload(
      { not: 'a-report' },
      {
        nodeId: 'node-a',
      }
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('INVALID_REQUEST');
      expect(result.error.retryable).toBe(false);
    }
  });

  it('validateInventoryPayload rejects nodeId mismatch', () => {
    const result = validateInventoryPayload(report('node-a', '/a/repo'), {
      nodeId: 'node-b',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('INVALID_REQUEST');
      expect(result.error.message).toContain('nodeId');
    }
  });

  it('validateInventoryPayload returns the validated report when shape and nodeId match', () => {
    const payload = report('node-a', '/a/repo');
    const result = validateInventoryPayload(payload, { nodeId: 'node-a' });
    expect(result).toEqual({ ok: true, payload });
  });

  it('parseStoredInventory accepts opaque payload and returns the typed report when valid', () => {
    const payload = report('node-a', '/a/repo');
    expect(parseStoredInventory(payload)).toEqual(payload);
    expect(parseStoredInventory({ not: 'a-report' })).toBeNull();
    expect(parseStoredInventory(undefined)).toBeNull();
  });

  it('feature listInventoryReports reads opaque payloads stored on the registry', () => {
    const { tmpDir, registry } = tmpRegistry();
    try {
      const exchanged = registry.exchangePairToken({
        pairToken: registry.createPairToken({}).pairToken,
        manifest: manifest(),
      });
      const feature = createRepoInventoryFeature(registry);
      const payload = report(exchanged.node.nodeId, '/srv/repos/relay-ide');
      registry.recordHeartbeat({
        nodeId: exchanged.node.nodeId,
        protocolVersion: '1.0',
        repoInventory: payload,
      });
      const reports = feature.listInventoryReports();
      expect(reports).toHaveLength(1);
      expect(reports[0]?.nodeId).toBe(exchanged.node.nodeId);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('feature listInventoryReports drops a stored payload whose self-reported nodeId disagrees with the record it was stored against', () => {
    const { tmpDir, registry } = tmpRegistry();
    try {
      const exchanged = registry.exchangePairToken({
        pairToken: registry.createPairToken({}).pairToken,
        manifest: manifest(),
      });
      const feature = createRepoInventoryFeature(registry);
      // Bypass the validator by writing a mismatched payload directly
      // through recordHeartbeat (simulates corrupted on-disk state or a
      // path that skipped feature-layer validation).
      registry.recordHeartbeat({
        nodeId: exchanged.node.nodeId,
        protocolVersion: '1.0',
        repoInventory: report('different-node', '/srv/repos/relay-ide'),
      });
      expect(feature.listInventoryReports()).toHaveLength(0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('feature listInventoryReports skips malformed payloads silently', () => {
    const { tmpDir, registry } = tmpRegistry();
    try {
      const exchanged = registry.exchangePairToken({
        pairToken: registry.createPairToken({}).pairToken,
        manifest: manifest(),
      });
      const feature = createRepoInventoryFeature(registry);
      registry.recordHeartbeat({
        nodeId: exchanged.node.nodeId,
        protocolVersion: '1.0',
        repoInventory: { garbage: true },
      });
      expect(feature.listInventoryReports()).toHaveLength(0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('WS heartbeat path drops repoInventory when no validator is wired (safe-by-default)', async () => {
    const cleanup: Array<() => Promise<void> | void> = [];
    try {
      const tmpDir = fs.mkdtempSync(
        path.join(os.tmpdir(), 'relay-repo-inv-feat-ws-')
      );
      cleanup.push(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
      const registry = createHubNodeRegistry({
        storagePath: path.join(tmpDir, 'nodes.json'),
        now: () => new Date('2026-01-02T03:04:05.000Z'),
      });
      const exchanged = registry.exchangePairToken({
        pairToken: registry.createPairToken({}).pairToken,
        manifest: manifest(),
      });
      const server = http.createServer(express());
      // Intentionally pass a link manager WITHOUT an inventoryValidator
      // wired. Production composition root wires one; we want to prove
      // the WS path refuses to persist an unvalidated payload.
      const nodeLinks = createHubNodeLinkManager();
      setupWebSocket(
        server,
        testBrowserAuthTokens(),
        null,
        undefined,
        false,
        undefined,
        registry,
        nodeLinks
      );
      const port = await listen(server);
      cleanup.push(() => close(server));

      const ws = new WebSocket(`ws://127.0.0.1:${port}/hub/node-link`, {
        headers: { authorization: `Bearer ${exchanged.credential.token}` },
      });
      cleanup.push(() => ws.close());
      await new Promise<void>((resolve, reject) => {
        ws.once('open', resolve);
        ws.once('error', reject);
      });

      const ack = new Promise<Record<string, unknown>>((resolve) => {
        ws.once('message', (data) =>
          resolve(JSON.parse(data.toString()) as Record<string, unknown>)
        );
      });
      ws.send(
        JSON.stringify({
          protocol: 'relay-node-link',
          protocolVersion: '1.0',
          nodeId: exchanged.node.nodeId,
          channel: 'control',
          type: 'control.heartbeat',
          timestamp: '2026-01-02T03:04:10.000Z',
          payload: {
            repoInventory: report(
              exchanged.node.nodeId,
              '/srv/repos/relay-ide'
            ),
          },
        })
      );
      const response = await ack;
      expect(response.type).toBe('control.heartbeat.ack');
      // Payload was accepted (heartbeat acked) but the registry must not
      // hold any inventory because no validator was wired.
      expect(registry.listInventoryPayloads()).toHaveLength(0);
    } finally {
      while (cleanup.length > 0) await cleanup.pop()?.();
    }
  });

  it('feature listInventoryReports excludes revoked nodes by default but can include them on request', () => {
    const { tmpDir, registry } = tmpRegistry();
    try {
      const exchanged = registry.exchangePairToken({
        pairToken: registry.createPairToken({}).pairToken,
        manifest: manifest(),
      });
      const feature = createRepoInventoryFeature(registry);
      registry.recordHeartbeat({
        nodeId: exchanged.node.nodeId,
        protocolVersion: '1.0',
        repoInventory: report(exchanged.node.nodeId, '/srv/repos/relay-ide'),
      });
      registry.revokeNode(exchanged.node.nodeId);
      expect(feature.listInventoryReports()).toHaveLength(0);
      expect(
        feature.listInventoryReports({ includeRevoked: true })
      ).toHaveLength(1);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
