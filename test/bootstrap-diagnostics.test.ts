import { describe, expect, it } from 'vitest';
import {
  BOOTSTRAP_DIAGNOSTICS,
  generateBootstrapCommands,
  redactBootstrapSecrets,
} from '../shared/bootstrap-diagnostics.js';

describe('bootstrap command generation and diagnostics', () => {
  it('generates local, service, ssh, and tailscale commands with redacted display copies', () => {
    const pairToken = 'pair_secret-token-value';
    const commands = generateBootstrapCommands({
      hubUrl: 'https://hub.example.com',
      pairToken,
      sshTarget: 'dev@example.internal',
      tailscaleTarget: 'dev@tail-host',
      serviceModes: ['manual', 'launchd', 'systemd-user', 'systemd-system', 'wsl-systemd', 'wsl-manual'],
    });

    expect(commands.map((command) => command.id)).toEqual([
      'local-manual',
      'macos-launchd',
      'linux-systemd-user',
      'linux-systemd-system',
      'wsl-systemd',
      'wsl-manual',
      'ssh-auto',
      'tailscale-ssh-auto',
    ]);
    expect(commands[0]!.command).toContain(`--pair-token '${pairToken}'`);
    expect(commands[0]!.redactedCommand).not.toContain(pairToken);
    expect(commands[6]!.command).toContain("ssh dev@example.internal 'bash -s'");
    expect(commands[7]!.command).toContain("tailscale ssh dev@tail-host 'bash -s'");
    for (const command of commands) {
      expect(command.redactedCommand).toContain('pair_…redacted');
      expect(command.command).toContain('https://hub.example.com');
      expect(command.command).toContain(pairToken);
    }
  });

  it('redacts pair tokens, node credentials, and bearer headers from diagnostics text', () => {
    const raw = [
      'pair token pair_abc123XYZ leaked',
      'credential node_abc.secret_123456789',
      'Authorization: Bearer secret_should-not-log',
      '--pair-token pair_cli_token',
    ].join('\n');

    const redacted = redactBootstrapSecrets(raw);

    expect(redacted).not.toContain('pair_abc123XYZ');
    expect(redacted).not.toContain('secret_123456789');
    expect(redacted).not.toContain('secret_should-not-log');
    expect(redacted).not.toContain('pair_cli_token');
    expect(redacted).toContain('pair_…redacted');
    expect(redacted).toContain('Bearer …redacted');
  });

  it('defines the diagnostics taxonomy required for bootstrap triage', () => {
    expect(BOOTSTRAP_DIAGNOSTICS.map((diagnostic) => diagnostic.code)).toEqual([
      'BOOTSTRAP_UNREACHABLE',
      'BOOTSTRAP_REMOTE_SHELL_FAILED',
      'BOOTSTRAP_INSTALL_FAILED',
      'SERVICE_MANAGER_UNSUPPORTED',
      'SERVICE_START_FAILED',
      'PAIR_TOKEN_INVALID',
      'PAIR_TOKEN_EXPIRED',
      'NODE_CREDENTIAL_REJECTED',
      'NODE_CONNECT_FAILED',
      'PROTOCOL_INCOMPATIBLE',
      'NODE_STARTED_NO_HEARTBEAT',
    ]);
    expect(
      BOOTSTRAP_DIAGNOSTICS.find((diagnostic) => diagnostic.code === 'NODE_CONNECT_FAILED')
        ?.meaning
    ).toMatch(/cannot reach hub/i);
  });
});
