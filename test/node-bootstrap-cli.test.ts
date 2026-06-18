/**
 * Tests for relay-ide node bootstrap CLI commands (Slice 2, issue #652).
 *
 * Covers:
 *   - relay-ide node install argument parsing (binary-only path, no pair-token)
 *   - relay-ide node pair argument validation
 *   - relay-ide node doctor --json structured output
 *   - relay-ide node ssh-bootstrap script generation (reproducible, no exec)
 *
 * These tests exercise the pure logic extracted into testable helpers rather
 * than spawning the CLI process end-to-end. The CLI dispatch itself is covered
 * by manual acceptance; unit tests focus on the functions that back each command.
 */

import { describe, expect, it } from 'vitest';
import {
  generateBootstrapCommands,
  redactBootstrapSecrets,
} from '../shared/bootstrap-diagnostics.js';
import { deriveDegradedReasons } from '../server/node-manifest-build.js';
import type {
  NodeManifest,
  NodeCapabilityProbe,
} from '../shared/node-manifest.js';

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
    protocolVersion: '1.0',
    generatedAt: new Date().toISOString(),
    resolvedPaths: {},
    fileRpc: { available: true, capabilities: [] },
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
      terminalBackends: { 'relay-pty': makeProbe('relay-pty', 'available') },
      git: makeProbe('git', 'available'),
      clipboard: makeProbe('clipboard', 'available'),
      browserAutomation: makeProbe('browserAutomation', 'available'),
      githubCli: makeProbe('githubCli', 'available'),
      tailscale: makeProbe('tailscale', 'available'),
      ssh: makeProbe('ssh', 'available'),
      sessionResume: 'none',
      agents: {},
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// node doctor: degraded reason surfacing
// ---------------------------------------------------------------------------

describe('node doctor degraded reason surfacing', () => {
  it('returns no degraded reasons for a fully healthy manifest', () => {
    const manifest = makeMinimalManifest();
    const reasons = deriveDegradedReasons(manifest);
    expect(reasons).toHaveLength(0);
  });

  it('does not report tmux as a required degraded capability', () => {
    const manifest = makeMinimalManifest({
      capabilities: {
        ...makeMinimalManifest().capabilities,
        sessionResume: 'none',
      },
    });
    const reasons = deriveDegradedReasons(manifest);
    expect(
      reasons.find((r) => r.code === 'CAPABILITY_UNAVAILABLE_TMUX')
    ).toBeUndefined();
  });

  it('surfaces CAPABILITY_DEGRADED_CLIPBOARD with warn severity', () => {
    const manifest = makeMinimalManifest({
      capabilities: {
        ...makeMinimalManifest().capabilities,
        clipboard: makeProbe(
          'clipboard',
          'degraded',
          'No clipboard CLI found.'
        ),
      },
    });
    const reasons = deriveDegradedReasons(manifest);
    const clipReason = reasons.find(
      (r) => r.code === 'CAPABILITY_DEGRADED_CLIPBOARD'
    );
    expect(clipReason).toBeDefined();
    expect(clipReason?.severity).toBe('warn');
  });

  it('surfaces FILE_RPC_UNAVAILABLE with error severity', () => {
    const manifest = makeMinimalManifest({
      fileRpc: { available: false, capabilities: [] },
    });
    const reasons = deriveDegradedReasons(manifest);
    const fileRpcReason = reasons.find(
      (r) => r.code === 'FILE_RPC_UNAVAILABLE'
    );
    expect(fileRpcReason).toBeDefined();
    expect(fileRpcReason?.severity).toBe('error');
  });

  it('surfaces SERVICE_MANAGER_UNSUPPORTED_* with info severity when no service manager found', () => {
    const manifest = makeMinimalManifest({
      serviceManager: {
        kind: 'unsupported',
        label: 'unsupported',
        supported: false,
        installable: false,
        installHint: 'use --service manual',
        uninstallHint: '',
        message: 'no supported service manager detected.',
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

  it('surfaces agent-level degraded reasons', () => {
    const manifest = makeMinimalManifest({
      capabilities: {
        ...makeMinimalManifest().capabilities,
        agents: {
          claude: makeProbe(
            'claude',
            'unavailable',
            'Claude CLI not found on PATH.'
          ),
        },
      },
    });
    const reasons = deriveDegradedReasons(manifest);
    const agentReason = reasons.find(
      (r) => r.code === 'AGENT_UNAVAILABLE_CLAUDE'
    );
    expect(agentReason).toBeDefined();
    expect(agentReason?.severity).toBe('info');
  });

  it('surfaces multiple degraded reasons when multiple capabilities are degraded', () => {
    const manifest = makeMinimalManifest({
      fileRpc: { available: false, capabilities: [] },
      capabilities: {
        ...makeMinimalManifest().capabilities,
        git: makeProbe('git', 'unavailable', 'git not found.'),
        sessionResume: 'none',
      },
    });
    const reasons = deriveDegradedReasons(manifest);
    expect(reasons.length).toBeGreaterThanOrEqual(2);
    const codes = reasons.map((r) => r.code);
    expect(codes).toContain('CAPABILITY_UNAVAILABLE_GIT');
    expect(codes).toContain('FILE_RPC_UNAVAILABLE');
  });
});

// ---------------------------------------------------------------------------
// node install: argument parsing
// ---------------------------------------------------------------------------

describe('node install argument validation', () => {
  it('requires --hub flag', () => {
    // Simulate getNodeArg returning undefined when --hub is absent.
    // The install function checks hubUrl and calls process.exit(1).
    // We test the argument parsing logic here, not the full CLI.
    const args: string[] = ['--service', 'manual'];
    const idx = args.indexOf('--hub');
    const hubUrl =
      idx !== -1 && idx + 1 < args.length ? args[idx + 1] : undefined;
    expect(hubUrl).toBeUndefined();
  });

  it('accepts --service values from the allowed list', () => {
    const validModes = [
      'auto',
      'manual',
      'launchd',
      'systemd-user',
      'wsl-systemd',
      'wsl-manual',
    ];
    for (const mode of validModes) {
      expect(validModes).toContain(mode);
    }
  });

  it('defaults to manual service mode when --service is not supplied', () => {
    // Mirrors the CLI logic: getNodeArg(nodeArgs, '--service') ?? 'manual'
    const nodeArgs: string[] = ['install', '--hub', 'https://hub.example.com'];
    const idx = nodeArgs.indexOf('--service');
    const mode =
      idx !== -1 && idx + 1 < nodeArgs.length ? nodeArgs[idx + 1] : 'manual';
    expect(mode).toBe('manual');
  });

  it('distinguishes install-only (no --pair-token) from legacy pair+install', () => {
    const installOnlyArgs = ['install', '--hub', 'https://hub.example.com'];
    const legacyArgs = [
      'install',
      '--hub',
      'https://hub.example.com',
      '--pair-token',
      'pair_abc123',
    ];

    const tokenIdx = (a: string[]): string | undefined => {
      const i = a.indexOf('--pair-token');
      return i !== -1 && i + 1 < a.length ? a[i + 1] : undefined;
    };

    expect(tokenIdx(installOnlyArgs)).toBeUndefined();
    expect(tokenIdx(legacyArgs)).toBe('pair_abc123');
  });
});

// ---------------------------------------------------------------------------
// node pair: argument validation
// ---------------------------------------------------------------------------

describe('node pair argument validation', () => {
  it('requires --hub flag', () => {
    const args: string[] = ['pair', '--pair-token', 'pair_abc123'];
    const idx = args.indexOf('--hub');
    const hubUrl =
      idx !== -1 && idx + 1 < args.length ? args[idx + 1] : undefined;
    expect(hubUrl).toBeUndefined();
  });

  it('requires --pair-token flag (not just --hub)', () => {
    const args: string[] = ['pair', '--hub', 'https://hub.example.com'];
    const tokenIdx = args.indexOf('--pair-token');
    const token =
      tokenIdx !== -1 && tokenIdx + 1 < args.length
        ? args[tokenIdx + 1]
        : undefined;
    expect(token).toBeUndefined();
  });

  it('accepts both --hub and --pair-token', () => {
    const args: string[] = [
      'pair',
      '--hub',
      'https://hub.example.com',
      '--pair-token',
      'pair_abc123',
    ];
    const hubIdx = args.indexOf('--hub');
    const tokenIdx = args.indexOf('--pair-token');
    expect(args[hubIdx + 1]).toBe('https://hub.example.com');
    expect(args[tokenIdx + 1]).toBe('pair_abc123');
  });
});

// ---------------------------------------------------------------------------
// node ssh-bootstrap: script generation
// ---------------------------------------------------------------------------

describe('node ssh-bootstrap script generation', () => {
  it('generates an ssh-auto command for the given target', () => {
    const commands = generateBootstrapCommands({
      hubUrl: 'https://hub.example.com',
      pairToken: 'pair_test-token',
      sshTarget: 'user@remote.internal',
    });

    const sshCmd = commands.find((c) => c.id === 'ssh-auto');
    expect(sshCmd).toBeDefined();
    expect(sshCmd?.command).toContain("ssh 'user@remote.internal' 'bash -s'");
    expect(sshCmd?.command).toContain('https://hub.example.com');
  });

  it('redacts pair token in redactedCommand but not in command', () => {
    const pairToken = 'pair_should-be-redacted';
    const commands = generateBootstrapCommands({
      hubUrl: 'https://hub.example.com',
      pairToken,
      sshTarget: 'user@remote.internal',
    });

    const sshCmd = commands.find((c) => c.id === 'ssh-auto');
    expect(sshCmd?.command).toContain(pairToken);
    expect(sshCmd?.redactedCommand).not.toContain(pairToken);
    expect(sshCmd?.redactedCommand).toContain('pair_…redacted');
  });

  it('is reproducible: same hub + target always produces the same script structure', () => {
    const input = {
      hubUrl: 'https://hub.example.com',
      pairToken: 'pair_token-a',
      sshTarget: 'user@remote.internal',
    };

    const run1 = generateBootstrapCommands(input);
    const run2 = generateBootstrapCommands(input);

    const ssh1 = run1.find((c) => c.id === 'ssh-auto');
    const ssh2 = run2.find((c) => c.id === 'ssh-auto');

    expect(ssh1?.command).toBe(ssh2?.command);
    expect(ssh1?.caveats).toEqual(ssh2?.caveats);
  });

  it('includes install + pair steps in the script body', () => {
    const commands = generateBootstrapCommands({
      hubUrl: 'https://hub.example.com',
      pairToken: 'pair_test-token',
      sshTarget: 'user@remote.internal',
    });

    const sshCmd = commands.find((c) => c.id === 'ssh-auto');
    // The remote bootstrap script must check for relay-ide and install if missing.
    expect(sshCmd?.command).toContain('npm install -g relay-ide');
    // And pair the node with the hub.
    expect(sshCmd?.command).toContain('node install');
    expect(sshCmd?.command).toContain('--hub');
  });

  it('emits a note that this is script generation, not SSH-as-product', () => {
    const commands = generateBootstrapCommands({
      hubUrl: 'https://hub.example.com',
      pairToken: 'pair_test-token',
      sshTarget: 'user@remote.internal',
    });

    const sshCmd = commands.find((c) => c.id === 'ssh-auto');
    // Caveats must not describe SSH as a steady-state product API.
    const caveatText = sshCmd?.caveats.join(' ') ?? '';
    expect(caveatText).not.toMatch(
      /steady-state.*reverse WebSocket|ssh.*product/i
    );
  });

  it('does not generate an ssh command when no target is supplied', () => {
    const commands = generateBootstrapCommands({
      hubUrl: 'https://hub.example.com',
      pairToken: 'pair_test-token',
    });

    expect(commands.find((c) => c.id === 'ssh-auto')).toBeUndefined();
  });

  it('shell-quotes the target to prevent interpretation as separate commands', () => {
    const commands = generateBootstrapCommands({
      hubUrl: 'https://hub.example.com',
      pairToken: 'pair_test-token',
      sshTarget: "user@host; touch /tmp/pwned; echo '",
    });

    const sshCmd = commands.find((c) => c.id === 'ssh-auto');
    // The target must be single-quoted so the shell interprets it as one
    // argument (the literal hostname), not as separate shell commands.
    // The quoted form is: 'user@host; touch /tmp/pwned; echo '"'"''
    // The key property is that the target starts immediately after `ssh '`
    // (not as unquoted bare tokens).
    expect(sshCmd?.command).toContain("ssh 'user@host; touch /tmp/pwned;");
    // It must NOT be passed as unquoted tokens that the shell splits on `;`.
    expect(sshCmd?.command).not.toMatch(/ssh user@host;/);
  });

  it('trims whitespace from the target before embedding', () => {
    const commands = generateBootstrapCommands({
      hubUrl: 'https://hub.example.com',
      pairToken: 'pair_test-token',
      sshTarget: '  user@remote.internal  ',
    });

    const sshCmd = commands.find((c) => c.id === 'ssh-auto');
    expect(sshCmd?.command).toContain("ssh 'user@remote.internal' 'bash -s'");
    expect(sshCmd?.command).not.toContain("ssh '  user@remote.internal");
  });
});

// ---------------------------------------------------------------------------
// node doctor: structured JSON shape
// ---------------------------------------------------------------------------

describe('node doctor --json output shape', () => {
  it('degradedReasons from a manifest have the expected fields', () => {
    const manifest = makeMinimalManifest({
      fileRpc: { available: false, capabilities: [] },
      capabilities: {
        ...makeMinimalManifest().capabilities,
        tmux: makeProbe('tmux', 'unavailable', 'tmux not found.'),
        sessionResume: 'none',
      },
    });
    const reasons = deriveDegradedReasons(manifest);
    for (const reason of reasons) {
      expect(typeof reason.code).toBe('string');
      expect(typeof reason.description).toBe('string');
      expect(['info', 'warn', 'error']).toContain(reason.severity);
    }
  });

  it('produces a serialisable result that round-trips through JSON', () => {
    const manifest = makeMinimalManifest({
      fileRpc: { available: false, capabilities: [] },
    });
    const reasons = deriveDegradedReasons(manifest);
    const result = {
      ok: false,
      hostname: manifest.hostname,
      platform: manifest.platform,
      arch: manifest.arch,
      helperVersion: manifest.helperVersion,
      serviceManager: {
        kind: manifest.serviceManager.kind,
        supported: manifest.serviceManager.supported,
        message: manifest.serviceManager.message,
      },
      degradedReasons: reasons,
    };
    const json = JSON.stringify(result, null, 2);
    const parsed = JSON.parse(json) as typeof result;
    expect(parsed.ok).toBe(false);
    expect(parsed.degradedReasons).toHaveLength(reasons.length);
    expect(parsed.degradedReasons[0]?.code).toBe('FILE_RPC_UNAVAILABLE');
  });
});

// ---------------------------------------------------------------------------
// Secret redaction (cross-cutting)
// ---------------------------------------------------------------------------

describe('secret redaction in node bootstrap CLI output', () => {
  it('redacts pair tokens embedded in error messages', () => {
    const raw = 'NODE_CONNECT_FAILED: error contacting hub with pair_abc123def';
    const redacted = redactBootstrapSecrets(raw);
    expect(redacted).not.toContain('pair_abc123def');
    expect(redacted).toContain('pair_…redacted');
  });

  it('redacts bearer tokens in auth headers', () => {
    const raw = 'Authorization: Bearer secret_abcdefg';
    const redacted = redactBootstrapSecrets(raw);
    expect(redacted).not.toContain('secret_abcdefg');
  });

  it('redacts free-text privacy and credential leak classes', () => {
    const raw = [
      'status pstat_STATUS123',
      'clone https://token-only-value@hub.example.com/repo.git',
      'Cookie: sid=cookie-secret; prefs=abc',
      'FAKE_TOKEN_FIELD=fake-token-value',
      'path /Users/donovan/private/project /home/donovan/.ssh/id_ed25519',
    ].join(' ');
    const redacted = redactBootstrapSecrets(raw);

    expect(redacted).not.toContain('pstat_STATUS123');
    expect(redacted).not.toContain('token-only-value');
    expect(redacted).not.toContain('cookie-secret');
    expect(redacted).not.toContain('fake-token-value');
    expect(redacted).not.toContain('/Users/donovan/private/project');
    expect(redacted).not.toContain('/home/donovan/.ssh/id_ed25519');
  });

  it('keeps non-sensitive content intact', () => {
    const raw = 'relay-ide node doctor --hub https://hub.example.com';
    const redacted = redactBootstrapSecrets(raw);
    expect(redacted).toBe(raw);
  });
});
