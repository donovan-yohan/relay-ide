export type BootstrapCommandId =
  | 'local-manual'
  | 'macos-launchd'
  | 'linux-systemd-user'
  | 'wsl-systemd'
  | 'wsl-manual'
  | 'ssh-auto'
  | 'tailscale-ssh-auto';

export type BootstrapServiceMode =
  | 'manual'
  | 'launchd'
  | 'systemd-user'
  | 'wsl-systemd'
  | 'wsl-manual';

export type BootstrapDiagnosticCode =
  | 'BOOTSTRAP_UNREACHABLE'
  | 'BOOTSTRAP_REMOTE_SHELL_FAILED'
  | 'BOOTSTRAP_INSTALL_FAILED'
  | 'SERVICE_MANAGER_UNSUPPORTED'
  | 'SERVICE_START_FAILED'
  | 'PAIR_TOKEN_INVALID'
  | 'PAIR_TOKEN_EXPIRED'
  | 'NODE_CREDENTIAL_REJECTED'
  | 'NODE_CONNECT_FAILED'
  | 'PROTOCOL_INCOMPATIBLE'
  | 'NODE_STARTED_NO_HEARTBEAT';

export interface BootstrapDiagnostic {
  code: BootstrapDiagnosticCode;
  stage: string;
  meaning: string;
  hint: string;
}

export interface BootstrapCommand {
  id: BootstrapCommandId;
  label: string;
  transport: 'local' | 'ssh' | 'tailscale-ssh';
  service: BootstrapServiceMode | 'auto';
  command: string;
  redactedCommand: string;
  caveats: string[];
}

export interface BootstrapCommandInput {
  hubUrl: string;
  pairToken: string;
  sshTarget?: string;
  tailscaleTarget?: string;
  serviceModes?: BootstrapServiceMode[];
  relayCommand?: string;
  installCommand?: string;
}

export const BOOTSTRAP_DIAGNOSTICS: BootstrapDiagnostic[] = [
  {
    code: 'BOOTSTRAP_UNREACHABLE',
    stage: 'reachability',
    meaning: 'Cannot connect to the target over SSH or Tailscale SSH.',
    hint: 'Check hostname, tailnet reachability, ACLs, and sshd.',
  },
  {
    code: 'BOOTSTRAP_REMOTE_SHELL_FAILED',
    stage: 'remote-shell',
    meaning: 'SSH connected, but the remote shell could not run the bootstrap script.',
    hint: 'Check login shell, quoting, PATH, and remote command restrictions.',
  },
  {
    code: 'BOOTSTRAP_INSTALL_FAILED',
    stage: 'install',
    meaning: 'Relay install or update failed on the target.',
    hint: 'Use the redacted captured stderr and retry with the official installer or npm path.',
  },
  {
    code: 'SERVICE_MANAGER_UNSUPPORTED',
    stage: 'service-detection',
    meaning: 'No supported launchd/systemd service path was found.',
    hint: 'Use node connect only to pair credentials, then install a service-specific variant or your own supervisor; WSL may require systemd to be explicitly enabled.',
  },
  {
    code: 'SERVICE_START_FAILED',
    stage: 'service-start',
    meaning: 'The service was installed but did not start or stay running.',
    hint: 'Inspect launchctl or journalctl logs for the relay-ide service.',
  },
  {
    code: 'PAIR_TOKEN_INVALID',
    stage: 'pair-token',
    meaning: 'The pair token is malformed, unknown, or already consumed.',
    hint: 'Generate a new short-lived token from the hub and retry.',
  },
  {
    code: 'PAIR_TOKEN_EXPIRED',
    stage: 'pair-token',
    meaning: 'The pair token expired before the node exchanged it.',
    hint: 'Generate a new token; pair tokens are intentionally short-lived and single-use.',
  },
  {
    code: 'NODE_CREDENTIAL_REJECTED',
    stage: 'node-auth',
    meaning: 'The persistent node credential was revoked or rejected by the hub.',
    hint: 'Delete the local node credential and pair the node again.',
  },
  {
    code: 'NODE_CONNECT_FAILED',
    stage: 'connect-back',
    meaning: 'The node started but cannot reach hub URL for heartbeat or reverse WebSocket.',
    hint: 'Check DNS, firewall, proxy, TLS, and that the hub URL is reachable from the node.',
  },
  {
    code: 'PROTOCOL_INCOMPATIBLE',
    stage: 'protocol',
    meaning: 'The node and hub relay-node protocol versions are incompatible.',
    hint: 'Upgrade the hub and node to compatible Relay versions.',
  },
  {
    code: 'NODE_STARTED_NO_HEARTBEAT',
    stage: 'heartbeat',
    meaning: 'The bootstrap command exited, but the hub has not observed a node heartbeat.',
    hint: 'Run relay-ide node status, relay-ide node logs, and relay-ide node doctor from the target.',
  },
];

const DEFAULT_SERVICE_MODES: BootstrapServiceMode[] = [
  'manual',
  'launchd',
  'systemd-user',
  'wsl-systemd',
  'wsl-manual',
];

const SERVICE_LABELS: Record<BootstrapServiceMode, { id: BootstrapCommandId; label: string }> = {
  manual: { id: 'local-manual', label: 'Local/manual pair-only node setup' },
  launchd: { id: 'macos-launchd', label: 'macOS launchd Relay service bootstrap' },
  'systemd-user': { id: 'linux-systemd-user', label: 'Linux systemd --user Relay service bootstrap' },
  'wsl-systemd': { id: 'wsl-systemd', label: 'WSL systemd-enabled Relay service bootstrap' },
  'wsl-manual': { id: 'wsl-manual', label: 'WSL manual pair-only node setup' },
};

const NODE_LINK_NOT_STARTED_CAVEAT =
  'Current bootstrap diagnostics pair credentials and install/start the generic Relay service only; this slice does not start or maintain /hub/node-link, so routed sessions still need a persistent node-link client.';

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function localNodeCommand(input: Required<Pick<BootstrapCommandInput, 'hubUrl' | 'pairToken' | 'relayCommand'>>, service: BootstrapServiceMode): string {
  const subCommand = service === 'manual' || service === 'wsl-manual' ? 'connect' : 'install';
  const base = [
    input.relayCommand,
    'node',
    subCommand,
    '--hub',
    shellQuote(input.hubUrl),
    '--pair-token',
    shellQuote(input.pairToken),
  ];
  if (subCommand === 'install') {
    base.push('--service', service);
  }
  return base.join(' ');
}

function remoteBootstrapScript(input: Required<Pick<BootstrapCommandInput, 'hubUrl' | 'pairToken' | 'relayCommand' | 'installCommand'>>): string {
  return [
    'set -euo pipefail',
    `command -v ${input.relayCommand} >/dev/null || ${input.installCommand}`,
    `${input.relayCommand} node install --hub ${shellQuote(input.hubUrl)} --pair-token ${shellQuote(input.pairToken)} --service auto`,
  ].join('\n');
}

function remoteCommand(binary: 'ssh' | 'tailscale ssh', target: string, script: string): string {
  return `${binary} ${shellQuote(target)} 'bash -s' <<'RELAY_IDE_BOOTSTRAP'\n${script}\nRELAY_IDE_BOOTSTRAP`;
}

function commandCaveats(service: BootstrapServiceMode): string[] {
  if (service === 'wsl-systemd') {
    return [
      'Only works when WSL systemd and the user bus are enabled; WSL distro shutdown still stops the node.',
      NODE_LINK_NOT_STARTED_CAVEAT,
    ];
  }
  if (service === 'wsl-manual') {
    return [
      'Pair-only WSL fallback; node connect stores credentials and sends one heartbeat, then exits. Relay does not install a Windows scheduled task in MVP.',
    ];
  }
  if (service === 'manual') {
    return [
      'Pair-only fallback; node connect stores credentials and sends one heartbeat, then exits. Install a service-specific variant or supervisor for steady-state node traffic.',
    ];
  }
  return [NODE_LINK_NOT_STARTED_CAVEAT];
}

function withRedaction(command: Omit<BootstrapCommand, 'redactedCommand'>): BootstrapCommand {
  return { ...command, redactedCommand: redactBootstrapSecrets(command.command) };
}

export function generateBootstrapCommands(input: BootstrapCommandInput): BootstrapCommand[] {
  const relayCommand = input.relayCommand ?? 'relay-ide';
  const installCommand = input.installCommand ?? 'npm install -g relay-ide';
  const normalized = {
    ...input,
    relayCommand,
    installCommand,
    hubUrl: input.hubUrl.trim(),
    sshTarget: input.sshTarget?.trim(),
    tailscaleTarget: input.tailscaleTarget?.trim(),
  };
  const commands: BootstrapCommand[] = [];

  for (const service of input.serviceModes ?? DEFAULT_SERVICE_MODES) {
    const meta = SERVICE_LABELS[service];
    commands.push(
      withRedaction({
        id: meta.id,
        label: meta.label,
        transport: 'local',
        service,
        command: localNodeCommand(normalized, service),
        caveats: commandCaveats(service),
      })
    );
  }

  const script = remoteBootstrapScript(normalized);
  if (normalized.sshTarget) {
    commands.push(
      withRedaction({
        id: 'ssh-auto',
        label: 'SSH pairing/service bootstrap with auto-detection',
        transport: 'ssh',
        service: 'auto',
        command: remoteCommand('ssh', normalized.sshTarget, script),
        caveats: [NODE_LINK_NOT_STARTED_CAVEAT],
      })
    );
  }
  if (normalized.tailscaleTarget) {
    commands.push(
      withRedaction({
        id: 'tailscale-ssh-auto',
        label: 'Tailscale SSH pairing/service bootstrap with auto-detection',
        transport: 'tailscale-ssh',
        service: 'auto',
        command: remoteCommand('tailscale ssh', normalized.tailscaleTarget, script),
        caveats: [
          'Tailscale is the private reachability/trust layer, not the Relay hub-node protocol.',
          NODE_LINK_NOT_STARTED_CAVEAT,
        ],
      })
    );
  }

  return commands;
}

export function redactBootstrapSecrets(value: string): string {
  return value
    .replace(/--pair-token\s+(?:'[^']*'|"[^"]*"|\S+)/g, '--pair-token pair_…redacted')
    .replace(/\bpair_[A-Za-z0-9._~+/=-]+\b/g, 'pair_…redacted')
    .replace(/\bnode_[A-Za-z0-9._~+/=-]+\.secret_[A-Za-z0-9._~+/=-]+\b/g, 'node_…redacted.secret_…redacted')
    .replace(/\bsecret_[A-Za-z0-9._~+/=-]+\b/g, 'secret_…redacted')
    .replace(/(Authorization:\s*Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1…redacted')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1…redacted')
    .replace(/("(?:token|pairToken|pin|password|secret)"\s*:\s*)"[^"]*"/gi, '$1"…redacted"')
    .replace(/\b(token|pin|password|secret)=([^\s&"',}]+)/gi, '$1=…redacted')
    // URL-embedded credentials, any scheme — keeps bootstrap log lines
    // (which can quote `--hub-url https://user:pass@…` or `wss://…`) in
    // lockstep with the diag-bundle url-credential rule (#604).
    .replace(
      /([a-z][a-z0-9+.-]*:\/\/)([^/\s:@]+):([^@\s/]+)@/gi,
      '$1…redacted:…redacted@'
    );
}
