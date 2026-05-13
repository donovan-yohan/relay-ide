import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHubNodeRegistry } from '../server/hub-node-registry.js';
import {
  createRepoInventoryFeature,
  validateInventoryPayload,
  parseStoredInventory,
} from '../server/features/repo-inventory.js';
import type { RepoInventoryReport } from '../shared/repo-inventory.js';
import type { NodeManifest } from '../shared/node-manifest.js';

function manifest(): NodeManifest {
  return {
    schemaVersion: 1,
    platform: 'linux',
    arch: 'x64',
    hostname: 'node-feature-host',
    relayVersion: '0.1.0-test',
    generatedAt: '2026-01-02T03:04:05.000Z',
    wsl: { detected: false, version: null, systemd: false },
    serviceManager: {
      kind: 'systemd-user',
      label: 'systemd user',
      supported: true,
      installable: true,
      installHint: 'install',
      uninstallHint: 'uninstall',
      message: 'ok',
    },
    capabilities: {
      tmux: { status: 'available', message: 'tmux 3.4' },
      git: { status: 'available', message: 'git 2.45.0' },
      clipboard: { status: 'available', message: 'pbcopy' },
      browserAutomation: { status: 'available', message: 'playwright ok' },
      githubCli: { status: 'available', message: 'gh 2.51' },
      tailscale: { status: 'available', message: 'tailscale 1.62' },
      ssh: { status: 'available', message: 'OpenSSH 9.7' },
      agents: {},
    },
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
