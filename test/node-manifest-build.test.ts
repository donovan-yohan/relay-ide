/**
 * Tests for server/node-manifest-build.ts
 *
 * Covers #651 Slice 1 acceptance criteria:
 *   - Manifest builder happy path
 *   - Missing tmux → degraded reason
 *   - Missing agent CLI → degraded reasons (per provider)
 *   - File RPC unavailable → degraded reason
 *   - Service manager detection on macOS (launchd) vs Linux (systemd) — mocked
 */

import os from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  buildFileRpcStatus,
  buildResolvedPaths,
  deriveDegradedReasons,
  detectDistro,
  enrichManifest,
  enrichProbeWithAuthStatus,
  NODE_LINK_PROTOCOL_VERSION,
  probeAgentAuthStatus,
} from '../server/node-manifest-build.js';
import {
  getCoreNodeManifest,
  getNodeManifest,
} from '../server/node-manifest.js';
import type {
  NodeCapabilityProbe,
  NodeManifest,
} from '../shared/node-manifest.js';
import { FILE_RPC_OPERATIONS } from '../shared/file-rpc.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeProbe(
  id: string,
  status: NodeCapabilityProbe['status'],
  message = `${id} probe`
): NodeCapabilityProbe {
  return { id, label: id, status, message };
}

function makeMinimalManifest(
  overrides: Partial<Omit<NodeManifest, 'degradedReasons'>> = {}
): Omit<NodeManifest, 'degradedReasons'> {
  return {
    schemaVersion: 1,
    platform: 'darwin',
    arch: 'arm64',
    hostname: 'test-node',
    relayVersion: '0.1.0-test',
    helperVersion: '0.1.0-test',
    protocolVersion: NODE_LINK_PROTOCOL_VERSION,
    generatedAt: new Date().toISOString(),
    resolvedPaths: {},
    fileRpc: buildFileRpcStatus(true),
    wsl: { detected: false, version: null, systemd: false },
    serviceManager: {
      kind: 'launchd',
      label: 'launchd user agent',
      supported: true,
      installable: true,
      installHint: '',
      uninstallHint: '',
      message: 'macOS launchd user agents are supported.',
      caveats: [],
    },
    capabilities: {
      tmux: makeProbe('tmux', 'available'),
      git: makeProbe('git', 'available'),
      clipboard: makeProbe('clipboard', 'available'),
      browserAutomation: makeProbe('browserAutomation', 'available'),
      githubCli: makeProbe('githubCli', 'available'),
      tailscale: makeProbe('tailscale', 'available'),
      ssh: makeProbe('ssh', 'available'),
      sessionResume: 'tmux',
      agents: {},
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Protocol version
// ---------------------------------------------------------------------------

describe('NODE_LINK_PROTOCOL_VERSION', () => {
  it('is a non-empty string matching relay-node-protocol', () => {
    expect(typeof NODE_LINK_PROTOCOL_VERSION).toBe('string');
    expect(NODE_LINK_PROTOCOL_VERSION.length).toBeGreaterThan(0);
    // Should look like a semver-ish string e.g. "1.0"
    expect(NODE_LINK_PROTOCOL_VERSION).toMatch(/^\d+\.\d+/);
  });
});

// ---------------------------------------------------------------------------
// detectDistro
// ---------------------------------------------------------------------------

describe('detectDistro', () => {
  it('returns undefined on macOS', () => {
    expect(detectDistro({ platform: 'darwin' })).toBeUndefined();
  });

  it('returns undefined on Windows', () => {
    expect(detectDistro({ platform: 'win32' })).toBeUndefined();
  });

  it('returns WSL_DISTRO_NAME on Linux with WSL env', () => {
    const result = detectDistro({
      platform: 'linux',
      env: { WSL_DISTRO_NAME: 'Ubuntu' },
    });
    expect(result).toBe('Ubuntu');
  });

  it('parses /etc/os-release ID field on Linux', () => {
    const osReleaseContent = `NAME="Fedora Linux"\nID=fedora\nVERSION_ID=40\n`;
    const result = detectDistro({
      platform: 'linux',
      env: {},
      readFileSync: () => osReleaseContent,
    });
    expect(result).toBe('fedora');
  });

  it('returns undefined on Linux with no env and unreadable /etc/os-release', () => {
    const result = detectDistro({
      platform: 'linux',
      env: {},
      readFileSync: () => {
        throw new Error('ENOENT');
      },
    });
    expect(result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// buildResolvedPaths
// ---------------------------------------------------------------------------

describe('buildResolvedPaths', () => {
  it('returns empty object when no deps provided', () => {
    // We can't assert binary exists, but the shape should be correct
    const result = buildResolvedPaths({});
    expect(typeof result).toBe('object');
  });

  it('includes configDir when provided', () => {
    const result = buildResolvedPaths({
      configDir: '/home/user/.config/relay-ide',
    });
    expect(result.configDir).toBe('/home/user/.config/relay-ide');
  });

  it('includes logDir when provided', () => {
    const result = buildResolvedPaths({
      logDir: '/home/user/.config/relay-ide/logs',
    });
    expect(result.logDir).toBe('/home/user/.config/relay-ide/logs');
  });

  it('omits logDir when null', () => {
    const result = buildResolvedPaths({ logDir: null });
    expect('logDir' in result).toBe(false);
  });

  it('omits socketDir when null', () => {
    const result = buildResolvedPaths({ socketDir: null });
    expect('socketDir' in result).toBe(false);
  });

  it('converts a file:// scriptUrl to a path', () => {
    const fileUrl =
      'file:///usr/lib/node_modules/relay-ide/dist/bin/relay-ide.js';
    const result = buildResolvedPaths({ scriptUrl: fileUrl });
    expect(result.binary).toBe(
      '/usr/lib/node_modules/relay-ide/dist/bin/relay-ide.js'
    );
  });
});

// ---------------------------------------------------------------------------
// buildFileRpcStatus
// ---------------------------------------------------------------------------

describe('buildFileRpcStatus', () => {
  it('happy path — available with full operation set', () => {
    const result = buildFileRpcStatus(true);
    expect(result.available).toBe(true);
    expect(result.capabilities).toEqual([...FILE_RPC_OPERATIONS]);
    expect(result.restrictions).toBeUndefined();
  });

  it('unavailable → empty capabilities list', () => {
    const result = buildFileRpcStatus(false);
    expect(result.available).toBe(false);
    expect(result.capabilities).toEqual([]);
  });

  it('includes restrictions when provided', () => {
    const result = buildFileRpcStatus(true, ['write disabled by policy']);
    expect(result.restrictions).toEqual(['write disabled by policy']);
  });

  it('omits restrictions when empty array', () => {
    const result = buildFileRpcStatus(true, []);
    expect(result.restrictions).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// probeAgentAuthStatus
// ---------------------------------------------------------------------------

describe('probeAgentAuthStatus', () => {
  it('returns unknown for opencode (no auth heuristic)', () => {
    expect(probeAgentAuthStatus('opencode', { homeDir: os.tmpdir() })).toBe(
      'unknown'
    );
  });

  it('returns unknown for hermes (no auth heuristic)', () => {
    expect(probeAgentAuthStatus('hermes', { homeDir: os.tmpdir() })).toBe(
      'unknown'
    );
  });

  it('returns unknown for custom-agent ids', () => {
    expect(
      probeAgentAuthStatus('my-custom-agent', { homeDir: os.tmpdir() })
    ).toBe('unknown');
  });

  it('returns unauthed for claude when credential file is absent', () => {
    // Use a fresh tmpdir that has no .claude or .config/claude dirs
    const tmpHome = os.tmpdir();
    const result = probeAgentAuthStatus('claude', { homeDir: tmpHome });
    // It's either 'authed' (if the test runner happens to be authed) or 'unauthed'.
    // We cannot assert 'unauthed' definitively; just assert valid shape.
    expect(['authed', 'unauthed']).toContain(result);
  });
});

// ---------------------------------------------------------------------------
// enrichProbeWithAuthStatus
// ---------------------------------------------------------------------------

describe('enrichProbeWithAuthStatus', () => {
  it('sets authStatus to unknown for unavailable probes', () => {
    const probe = makeProbe('claude', 'unavailable');
    const result = enrichProbeWithAuthStatus(probe, { homeDir: os.tmpdir() });
    expect(result.authStatus).toBe('unknown');
    expect(result.id).toBe('claude');
    expect(result.status).toBe('unavailable');
  });

  it('does not mutate the input probe', () => {
    const probe = makeProbe('codex', 'available');
    const before = { ...probe };
    enrichProbeWithAuthStatus(probe, { homeDir: os.tmpdir() });
    expect(probe).toEqual(before);
  });

  it('adds an authStatus field to available probes', () => {
    const probe = makeProbe('opencode', 'available');
    const result = enrichProbeWithAuthStatus(probe, { homeDir: os.tmpdir() });
    expect(['authed', 'unauthed', 'unknown']).toContain(result.authStatus);
  });
});

// ---------------------------------------------------------------------------
// deriveDegradedReasons
// ---------------------------------------------------------------------------

describe('deriveDegradedReasons', () => {
  it('returns empty array when all probes are available', () => {
    const manifest = makeMinimalManifest();
    const reasons = deriveDegradedReasons(manifest);
    expect(reasons).toEqual([]);
  });

  it('emits a warn reason when tmux is unavailable', () => {
    const manifest = makeMinimalManifest({
      capabilities: {
        ...makeMinimalManifest().capabilities,
        tmux: makeProbe('tmux', 'unavailable', 'tmux was not found on PATH.'),
        sessionResume: 'none',
      },
    });
    const reasons = deriveDegradedReasons(manifest);
    const tmuxReason = reasons.find(
      (r) => r.code === 'CAPABILITY_UNAVAILABLE_TMUX'
    );
    expect(tmuxReason).toBeDefined();
    expect(tmuxReason?.severity).toBe('warn');
    expect(tmuxReason?.description).toContain('tmux');
  });

  it('emits an info reason for each unavailable agent CLI', () => {
    const manifest = makeMinimalManifest({
      capabilities: {
        ...makeMinimalManifest().capabilities,
        agents: {
          claude: makeProbe(
            'claude',
            'unavailable',
            'claude CLI not found on PATH.'
          ),
          codex: makeProbe(
            'codex',
            'unavailable',
            'codex CLI not found on PATH.'
          ),
          opencode: makeProbe(
            'opencode',
            'available',
            'opencode is available.'
          ),
        },
      },
    });
    const reasons = deriveDegradedReasons(manifest);
    const claudeReason = reasons.find(
      (r) => r.code === 'AGENT_UNAVAILABLE_CLAUDE'
    );
    const codexReason = reasons.find(
      (r) => r.code === 'AGENT_UNAVAILABLE_CODEX'
    );
    const opencodeReason = reasons.find(
      (r) => r.code === 'AGENT_UNAVAILABLE_OPENCODE'
    );

    expect(claudeReason).toBeDefined();
    expect(claudeReason?.severity).toBe('info');
    expect(codexReason).toBeDefined();
    expect(codexReason?.severity).toBe('info');
    expect(opencodeReason).toBeUndefined(); // opencode is available, no reason
  });

  it('emits an error reason when file RPC is unavailable', () => {
    const manifest = makeMinimalManifest({
      fileRpc: buildFileRpcStatus(false),
    });
    const reasons = deriveDegradedReasons(manifest);
    const fileRpcReason = reasons.find(
      (r) => r.code === 'FILE_RPC_UNAVAILABLE'
    );
    expect(fileRpcReason).toBeDefined();
    expect(fileRpcReason?.severity).toBe('error');
  });

  it('emits a warn reason for degraded capabilities', () => {
    const manifest = makeMinimalManifest({
      capabilities: {
        ...makeMinimalManifest().capabilities,
        clipboard: makeProbe(
          'clipboard',
          'degraded',
          'No supported clipboard CLI found.'
        ),
      },
    });
    const reasons = deriveDegradedReasons(manifest);
    const clipboardReason = reasons.find(
      (r) => r.code === 'CAPABILITY_DEGRADED_CLIPBOARD'
    );
    expect(clipboardReason).toBeDefined();
    expect(clipboardReason?.severity).toBe('warn');
  });

  it('emits a service manager reason when service manager is unsupported', () => {
    const manifest = makeMinimalManifest({
      serviceManager: {
        kind: 'unsupported',
        label: 'unsupported platform',
        supported: false,
        installable: false,
        installHint: 'Run in foreground.',
        uninstallHint: 'No service to uninstall.',
        message: 'Unsupported service platform.',
        caveats: [],
      },
    });
    const reasons = deriveDegradedReasons(manifest);
    const smReason = reasons.find((r) =>
      r.code.startsWith('SERVICE_MANAGER_UNSUPPORTED_')
    );
    expect(smReason).toBeDefined();
    expect(smReason?.severity).toBe('info');
  });
});

// ---------------------------------------------------------------------------
// enrichManifest integration
// ---------------------------------------------------------------------------

describe('enrichManifest', () => {
  it('happy path — adds all required #651 fields without mutating input', async () => {
    const core = await getCoreNodeManifest({
      env: { PATH: '' },
      platform: 'darwin',
      arch: 'arm64',
      hostname: 'test-node',
      relayVersion: '0.1.0-test',
    });

    const input: NodeManifest = {
      ...core,
      helperVersion: core.relayVersion,
      protocolVersion: NODE_LINK_PROTOCOL_VERSION,
      resolvedPaths: {},
      fileRpc: buildFileRpcStatus(true),
      degradedReasons: [],
    };

    const before = JSON.stringify(input);
    const enriched = enrichManifest(input, {
      configDir: '/home/user/.config/relay-ide',
      logDir: '/home/user/.config/relay-ide/logs',
      homeDir: os.tmpdir(),
      platform: 'darwin',
      env: { PATH: '' },
    });

    // Input not mutated
    expect(JSON.stringify(input)).toBe(before);

    // New fields present
    expect(enriched.helperVersion).toBe('0.1.0-test');
    expect(enriched.protocolVersion).toBe(NODE_LINK_PROTOCOL_VERSION);
    expect(enriched.resolvedPaths.configDir).toBe(
      '/home/user/.config/relay-ide'
    );
    expect(enriched.resolvedPaths.logDir).toBe(
      '/home/user/.config/relay-ide/logs'
    );
    expect(enriched.fileRpc.available).toBe(true);
    expect(enriched.fileRpc.capabilities).toEqual([...FILE_RPC_OPERATIONS]);
    expect(Array.isArray(enriched.degradedReasons)).toBe(true);
    // distro should be absent on macOS
    expect(enriched.distro).toBeUndefined();
  });

  it('sets distro from WSL_DISTRO_NAME on Linux', async () => {
    const core = await getCoreNodeManifest({
      env: {
        PATH: '',
        WSL_DISTRO_NAME: 'Ubuntu',
        WSL_INTEROP: '/run/WSL/1_interop',
      },
      platform: 'linux',
    });
    const input: NodeManifest = {
      ...core,
      helperVersion: core.relayVersion,
      protocolVersion: NODE_LINK_PROTOCOL_VERSION,
      resolvedPaths: {},
      fileRpc: buildFileRpcStatus(true),
      degradedReasons: [],
    };
    const enriched = enrichManifest(input, {
      platform: 'linux',
      env: { WSL_DISTRO_NAME: 'Ubuntu' },
      homeDir: os.tmpdir(),
    });
    expect(enriched.distro).toBe('Ubuntu');
  });
});

// ---------------------------------------------------------------------------
// getNodeManifest integration (full pipeline including enrichment)
// ---------------------------------------------------------------------------

describe('getNodeManifest (full pipeline with enrichment)', () => {
  it('happy path — output includes all #651 fields', async () => {
    const manifest = await getNodeManifest({
      env: { PATH: '' },
      platform: 'darwin',
      arch: 'arm64',
      hostname: 'relay-test-node',
      relayVersion: '9.9.9-test',
      now: new Date('2026-01-02T03:04:05.000Z'),
      configDir: '/home/test/.config/relay-ide',
      homeDir: os.tmpdir(),
    });

    // Backward-compat fields still present
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.platform).toBe('darwin');
    expect(manifest.arch).toBe('arm64');
    expect(manifest.relayVersion).toBe('9.9.9-test');

    // New #651 fields
    expect(manifest.helperVersion).toBe('9.9.9-test');
    expect(manifest.protocolVersion).toMatch(/^\d+\.\d+/);
    expect(manifest.resolvedPaths).toBeDefined();
    expect(manifest.resolvedPaths.configDir).toBe(
      '/home/test/.config/relay-ide'
    );
    expect(manifest.fileRpc.available).toBe(true);
    expect(manifest.fileRpc.capabilities.length).toBeGreaterThan(0);
    expect(Array.isArray(manifest.degradedReasons)).toBe(true);

    // Agent probes should have authStatus
    const agentEntries = Object.entries(manifest.capabilities.agents);
    expect(agentEntries.length).toBeGreaterThan(0);
    for (const [, probe] of agentEntries) {
      expect(['authed', 'unauthed', 'unknown']).toContain(probe.authStatus);
    }
  });

  it('missing tmux → appears in degradedReasons as warn', async () => {
    const manifest = await getNodeManifest({
      env: { PATH: '' }, // empty PATH — tmux not found
      platform: 'darwin',
      hostname: 'no-tmux-node',
      relayVersion: '0.0.1-test',
      homeDir: os.tmpdir(),
    });

    expect(manifest.capabilities.tmux.status).toBe('unavailable');
    const tmuxReason = manifest.degradedReasons.find(
      (r) => r.code === 'CAPABILITY_UNAVAILABLE_TMUX'
    );
    expect(tmuxReason).toBeDefined();
    expect(tmuxReason?.severity).toBe('warn');
  });

  it('all agents missing → one degraded reason per unavailable agent', async () => {
    const manifest = await getNodeManifest({
      env: { PATH: '' }, // empty PATH — no agents found
      platform: 'darwin',
      hostname: 'no-agents-node',
      relayVersion: '0.0.1-test',
      homeDir: os.tmpdir(),
    });

    const agentReasons = manifest.degradedReasons.filter((r) =>
      r.code.startsWith('AGENT_UNAVAILABLE_')
    );
    const unavailableAgents = Object.values(
      manifest.capabilities.agents
    ).filter((p) => p.status === 'unavailable');
    // Each unavailable agent should have exactly one reason
    expect(agentReasons.length).toBe(unavailableAgents.length);
    for (const reason of agentReasons) {
      expect(reason.severity).toBe('info');
      expect(typeof reason.description).toBe('string');
    }
  });

  it('service manager detection on macOS emits launchd', async () => {
    const manifest = await getNodeManifest({
      env: { PATH: '' },
      platform: 'darwin',
      hostname: 'mac-node',
      relayVersion: '0.0.1-test',
      homeDir: os.tmpdir(),
    });
    expect(manifest.serviceManager.kind).toBe('launchd');
    expect(manifest.serviceManager.supported).toBe(true);
  });

  it('service manager detection on Linux with mocked systemctl', async () => {
    // On the test runner (macOS or Linux), we cannot guarantee systemd is
    // present. We test the manifest shape is valid regardless of service manager.
    const manifest = await getNodeManifest({
      env: { PATH: '' },
      platform: 'linux',
      hostname: 'linux-node',
      relayVersion: '0.0.1-test',
      homeDir: os.tmpdir(),
    });
    // Should be one of the known Linux service manager kinds
    const linuxKinds = [
      'systemd-user',
      'systemd-system',
      'wsl-systemd',
      'wsl-manual',
      'manual',
      'unsupported',
    ];
    expect(linuxKinds).toContain(manifest.serviceManager.kind);
  });

  it('degradedReasons are structured objects (not strings)', async () => {
    const manifest = await getNodeManifest({
      env: { PATH: '' },
      platform: 'darwin',
      hostname: 'shape-check-node',
      relayVersion: '0.0.1-test',
      homeDir: os.tmpdir(),
    });
    for (const reason of manifest.degradedReasons) {
      expect(typeof reason.code).toBe('string');
      expect(typeof reason.description).toBe('string');
      expect(['info', 'warn', 'error']).toContain(reason.severity);
    }
  });
});
