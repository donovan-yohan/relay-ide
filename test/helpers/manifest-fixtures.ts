import type {
  NodeCapabilityProbe,
  NodeCapabilityStatus,
  NodeManifest,
} from '../../shared/node-manifest.js';

// Parameterized test fixture for `NodeManifest`. Tests pass an explicit
// list of agent ids so the framework set is part of the input — not a
// hardcoded global. Core / registry / smoke tests no longer assume
// Claude / Codex / OpenCode / Hermes are baked into the platform.

export interface AgentInput {
  id: string;
  label?: string;
  status?: NodeCapabilityStatus;
  message?: string;
}

export interface ManifestFixtureOptions {
  agents?: AgentInput[];
  overrides?: Partial<NodeManifest>;
}

function agentProbe(input: AgentInput): NodeCapabilityProbe {
  return {
    id: input.id,
    label: input.label ?? input.id,
    status: input.status ?? 'available',
    message: input.message ?? 'ok',
  };
}

function defaultCapabilities(
  agents: AgentInput[]
): NodeManifest['capabilities'] {
  return {
    terminalBackends: {
      'relay-pty': {
        id: 'relay-pty',
        label: 'Relay PTY',
        status: 'available',
        message: 'ok',
      },
    },
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
    ssh: {
      id: 'ssh',
      label: 'SSH client',
      status: 'available',
      message: 'ok',
    },
    agents: Object.fromEntries(
      agents.map((agent) => [agent.id, agentProbe(agent)])
    ),
  };
}

/**
 * Build a NodeManifest fixture with the supplied agent list (defaults
 * to an empty list — explicit ids are the point of #437). `overrides`
 * shallow-merges at the manifest top level, with a one-level-deep
 * merge for `capabilities` so a partial override (e.g. just `clipboard`)
 * doesn't wipe the agents map or the other default probes.
 */
export function buildManifestWithAgents(
  options: ManifestFixtureOptions = {}
): NodeManifest {
  const agents = options.agents ?? [];
  const base: NodeManifest = {
    schemaVersion: 1,
    platform: 'darwin',
    arch: 'arm64',
    hostname: 'test-host',
    helperVersion: '9.9.9',
    relayVersion: '9.9.9',
    protocolVersion: '1.0',
    generatedAt: '2026-01-02T03:04:05.000Z',
    resolvedPaths: {},
    fileRpc: { available: true, capabilities: [] },
    degradedReasons: [],
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
    capabilities: defaultCapabilities(agents),
  };
  const overrides = options.overrides ?? {};
  return {
    ...base,
    ...overrides,
    capabilities: {
      ...base.capabilities,
      ...(overrides.capabilities ?? {}),
    },
  };
}
