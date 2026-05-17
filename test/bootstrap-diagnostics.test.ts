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
      serviceModes: ['manual', 'launchd', 'systemd-user', 'wsl-systemd', 'wsl-manual'],
    });

    expect(commands.map((command) => command.id)).toEqual([
      'local-manual',
      'macos-launchd',
      'linux-systemd-user',
      'wsl-systemd',
      'wsl-manual',
      'ssh-auto',
      'tailscale-ssh-auto',
    ]);
    expect(commands[0]!.command).toContain(`--pair-token '${pairToken}'`);
    expect(commands[0]!.redactedCommand).not.toContain(pairToken);
    expect(commands[5]!.command).toContain("ssh 'dev@example.internal' 'bash -s'");
    expect(commands[6]!.command).toContain("tailscale ssh 'dev@tail-host' 'bash -s'");
    for (const command of commands) {
      expect(command.redactedCommand).toContain('pair_…redacted');
      expect(command.command).toContain('https://hub.example.com');
      expect(command.command).toContain(pairToken);
    }
  });

  it('trims and shell-quotes ssh and tailscale targets before embedding them in remote commands', () => {
    const commands = generateBootstrapCommands({
      hubUrl: 'https://hub.example.com',
      pairToken: 'pair_secret-token-value',
      sshTarget: "  dev@example.internal; touch /tmp/owned; echo '  ",
      tailscaleTarget: '  tail-host && curl attacker.example  ',
      serviceModes: ['manual'],
    });

    const ssh = commands.find((command) => command.id === 'ssh-auto')?.command ?? '';
    const tailscale =
      commands.find((command) => command.id === 'tailscale-ssh-auto')?.command ?? '';

    expect(ssh).toContain("ssh 'dev@example.internal; touch /tmp/owned; echo '\"'\"'' 'bash -s'");
    expect(tailscale).toContain("tailscale ssh 'tail-host && curl attacker.example' 'bash -s'");
    expect(ssh).not.toContain("ssh '  dev@example.internal");
    expect(tailscale).not.toContain("tailscale ssh '  tail-host");
    expect(ssh).not.toContain('ssh dev@example.internal;');
    expect(tailscale).not.toContain('tailscale ssh tail-host &&');
  });

  it('suppresses remote bootstrap commands for blank ssh and tailscale targets', () => {
    const commands = generateBootstrapCommands({
      hubUrl: 'https://hub.example.com',
      pairToken: 'pair_secret-token-value',
      sshTarget: '   ',
      tailscaleTarget: '\t\n ',
      serviceModes: ['manual'],
    });

    expect(commands.map((command) => command.id)).toEqual(['local-manual']);
  });

  it('marks manual and WSL manual commands as pair-only connect commands', () => {
    const commands = generateBootstrapCommands({
      hubUrl: 'https://hub.example.com',
      pairToken: 'pair_secret-token-value',
      serviceModes: ['manual', 'wsl-manual'],
    });

    for (const command of commands) {
      expect(command.command).toContain('node connect');
      expect(command.command).not.toContain('--service');
      expect(command.label).toMatch(/pair-only/);
      expect(command.caveats.join(' ')).toContain('sends one heartbeat, then exits');
      expect(command.caveats.join(' ')).not.toMatch(/foreground/i);
    }
  });

  it('does not advertise any install-like command as active reverse-link bootstrap', () => {
    const commands = generateBootstrapCommands({
      hubUrl: 'https://hub.example.com',
      pairToken: 'pair_secret-token-value',
      sshTarget: 'dev@example.internal',
      tailscaleTarget: 'dev@tail-host',
      serviceModes: ['launchd', 'systemd-user', 'wsl-systemd'],
    }).filter((command) => command.command.includes('node install'));

    expect(commands.map((command) => command.id)).toEqual([
      'macos-launchd',
      'linux-systemd-user',
      'wsl-systemd',
      'ssh-auto',
      'tailscale-ssh-auto',
    ]);

    for (const command of commands) {
      const displayText = [command.label, ...command.caveats].join(' ');
      expect(command.command).toContain('node install');
      expect(displayText).toContain('pair credentials');
      expect(displayText).toContain('generic Relay service');
      expect(displayText).toContain('does not start or maintain /hub/node-link');
      expect(displayText).not.toMatch(/steady-state traffic uses reverse WebSocket/i);
      expect(displayText).not.toMatch(/active reverse-link bootstrap/i);
      expect(displayText).not.toMatch(/node traffic is established/i);
    }
  });

  it('does not advertise unsupported service managers as a foreground node lifecycle', () => {
    const unsupported = BOOTSTRAP_DIAGNOSTICS.find(
      (diagnostic) => diagnostic.code === 'SERVICE_MANAGER_UNSUPPORTED'
    );

    expect(unsupported?.hint).toContain('node connect only to pair credentials');
    expect(unsupported?.hint).not.toMatch(/foreground/i);
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

  it('keeps JSON string redaction parseable for embedded bearer and named secret values', () => {
    const raw = JSON.stringify({
      authHeader: 'Bearer upstream-bearer-secret',
      nested: {
        token: 'plain-token-secret',
        pin: '123456',
        pairToken: 'pair_json_token',
        password: 'password-secret',
        secret: 'secret_should-not-log',
      },
    });

    const redacted = redactBootstrapSecrets(raw);
    const parsed = JSON.parse(redacted) as {
      authHeader: string;
      nested: Record<string, string>;
    };

    expect(parsed.authHeader).toBe('Bearer …redacted');
    expect(Object.values(parsed.nested)).toEqual([
      '…redacted',
      '…redacted',
      '…redacted',
      '…redacted',
      '…redacted',
    ]);
    expect(redacted).not.toContain('upstream-bearer-secret');
    expect(redacted).not.toContain('plain-token-secret');
    expect(redacted).not.toContain('pair_json_token');
    expect(redacted).not.toContain('password-secret');
    expect(redacted).not.toContain('secret_should-not-log');
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
