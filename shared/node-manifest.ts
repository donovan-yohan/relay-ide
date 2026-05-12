export type NodeCapabilityStatus =
  | 'available'
  | 'degraded'
  | 'unavailable'
  | 'unknown';

export interface NodeCapabilityProbe {
  id: string;
  label: string;
  status: NodeCapabilityStatus;
  message: string;
  path?: string;
  version?: string;
}

export interface WslInfo {
  detected: boolean;
  version: 1 | 2 | null;
  distroName?: string;
  systemd: boolean;
  message?: string;
}

export type ServiceManagerKind =
  | 'launchd'
  | 'systemd-user'
  | 'systemd-system'
  | 'wsl-systemd'
  | 'wsl-manual'
  | 'manual'
  | 'unsupported';

export interface NodeServiceManager {
  kind: ServiceManagerKind;
  label: string;
  supported: boolean;
  installable: boolean;
  servicePath?: string;
  unitName?: string;
  statusCommand?: string;
  installHint: string;
  uninstallHint: string;
  message: string;
  caveats: string[];
}

export interface NodeCapabilities {
  tmux: NodeCapabilityProbe;
  git: NodeCapabilityProbe;
  clipboard: NodeCapabilityProbe;
  browserAutomation: NodeCapabilityProbe;
  githubCli: NodeCapabilityProbe;
  tailscale: NodeCapabilityProbe;
  ssh: NodeCapabilityProbe;
  agents: Record<string, NodeCapabilityProbe>;
}

export interface NodeManifest {
  schemaVersion: 1;
  platform: string;
  arch: string;
  hostname: string;
  relayVersion: string;
  generatedAt: string;
  wsl: WslInfo;
  serviceManager: NodeServiceManager;
  capabilities: NodeCapabilities;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isCapabilityStatus(value: unknown): value is NodeCapabilityStatus {
  return (
    value === 'available' ||
    value === 'degraded' ||
    value === 'unavailable' ||
    value === 'unknown'
  );
}

export function isNodeCapabilityProbe(value: unknown): value is NodeCapabilityProbe {
  if (!isRecord(value)) return false;
  return (
    typeof value['id'] === 'string' &&
    typeof value['label'] === 'string' &&
    isCapabilityStatus(value['status']) &&
    typeof value['message'] === 'string'
  );
}

export function isNodeManifest(value: unknown): value is NodeManifest {
  if (!isRecord(value)) return false;
  if (
    value['schemaVersion'] !== 1 ||
    typeof value['platform'] !== 'string' ||
    typeof value['arch'] !== 'string' ||
    typeof value['hostname'] !== 'string' ||
    typeof value['relayVersion'] !== 'string' ||
    typeof value['generatedAt'] !== 'string'
  ) {
    return false;
  }

  const wsl = value['wsl'];
  if (
    !isRecord(wsl) ||
    typeof wsl['detected'] !== 'boolean' ||
    typeof wsl['systemd'] !== 'boolean'
  ) {
    return false;
  }

  const serviceManager = value['serviceManager'];
  if (
    !isRecord(serviceManager) ||
    typeof serviceManager['kind'] !== 'string' ||
    typeof serviceManager['label'] !== 'string' ||
    typeof serviceManager['supported'] !== 'boolean' ||
    typeof serviceManager['installable'] !== 'boolean' ||
    typeof serviceManager['installHint'] !== 'string' ||
    typeof serviceManager['uninstallHint'] !== 'string' ||
    typeof serviceManager['message'] !== 'string' ||
    !Array.isArray(serviceManager['caveats'])
  ) {
    return false;
  }

  const capabilities = value['capabilities'];
  if (!isRecord(capabilities)) return false;
  const requiredCapabilityKeys = [
    'tmux',
    'git',
    'clipboard',
    'browserAutomation',
    'githubCli',
    'tailscale',
    'ssh',
  ] as const;
  for (const key of requiredCapabilityKeys) {
    if (!isNodeCapabilityProbe(capabilities[key])) return false;
  }

  const agents = capabilities['agents'];
  if (!isRecord(agents)) return false;
  return Object.values(agents).every((probe) => isNodeCapabilityProbe(probe));
}
