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

export type NodePathMode =
  | 'native'
  | 'wsl-native'
  | 'windows-mount'
  | 'unknown';

export type WslLifecycleMode = 'wsl-systemd' | 'wsl-manual';

export type WslSupportTier = 'tier-1.5';

export interface WslInfo {
  detected: boolean;
  version: 1 | 2 | null;
  distroName?: string;
  systemd: boolean;
  supportTier?: WslSupportTier;
  lifecycleMode?: WslLifecycleMode;
  pathMode?: NodePathMode;
  windowsPath?: string;
  caveats?: string[];
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

/**
 * How the node persists a PTY across detach. Browsers reload, links
 * flap; tmux-backed hosts can reattach to the same shell. Hosts without
 * tmux advertise 'none' and the frontend hides the resumable badge.
 *
 * 'canonical-emulator' is reserved for #469 (server-side canonical
 * terminal). Phase 1 (#467) emits only 'tmux' or 'none'.
 */
export type NodeSessionResumeKind = 'tmux' | 'canonical-emulator' | 'none';

export interface NodeCapabilities {
  tmux: NodeCapabilityProbe;
  git: NodeCapabilityProbe;
  clipboard: NodeCapabilityProbe;
  browserAutomation: NodeCapabilityProbe;
  githubCli: NodeCapabilityProbe;
  tailscale: NodeCapabilityProbe;
  ssh: NodeCapabilityProbe;
  /**
   * #467: optional on the wire so pre-#467 manifests still validate.
   * The server probe always populates it; consumers should treat
   * `undefined` as 'none'.
   */
  sessionResume?: NodeSessionResumeKind;
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
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCapabilityStatus(value: unknown): value is NodeCapabilityStatus {
  return (
    value === 'available' ||
    value === 'degraded' ||
    value === 'unavailable' ||
    value === 'unknown'
  );
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string';
}

function isWslVersion(value: unknown): value is WslInfo['version'] {
  return value === 1 || value === 2 || value === null;
}

function isNodePathMode(value: unknown): value is NodePathMode | undefined {
  return (
    value === undefined ||
    value === 'native' ||
    value === 'wsl-native' ||
    value === 'windows-mount' ||
    value === 'unknown'
  );
}

function isWslLifecycleMode(
  value: unknown
): value is WslLifecycleMode | undefined {
  return (
    value === undefined || value === 'wsl-systemd' || value === 'wsl-manual'
  );
}

function isWslSupportTier(value: unknown): value is WslSupportTier | undefined {
  return value === undefined || value === 'tier-1.5';
}

function isServiceManagerKind(value: unknown): value is ServiceManagerKind {
  return (
    value === 'launchd' ||
    value === 'systemd-user' ||
    value === 'systemd-system' ||
    value === 'wsl-systemd' ||
    value === 'wsl-manual' ||
    value === 'manual' ||
    value === 'unsupported'
  );
}

const requiredCapabilityKeys = [
  'tmux',
  'git',
  'clipboard',
  'browserAutomation',
  'githubCli',
  'tailscale',
  'ssh',
] as const;

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === 'string')
  );
}

function isOptionalStringArray(value: unknown): value is string[] | undefined {
  return value === undefined || isStringArray(value);
}

export function isNodeCapabilityProbe(
  value: unknown
): value is NodeCapabilityProbe {
  if (!isRecord(value)) return false;
  return (
    typeof value['id'] === 'string' &&
    typeof value['label'] === 'string' &&
    isCapabilityStatus(value['status']) &&
    typeof value['message'] === 'string' &&
    isOptionalString(value['path']) &&
    isOptionalString(value['version'])
  );
}

function isWslInfo(value: unknown): value is WslInfo {
  if (!isRecord(value)) return false;
  return (
    typeof value['detected'] === 'boolean' &&
    isWslVersion(value['version']) &&
    typeof value['systemd'] === 'boolean' &&
    isOptionalString(value['distroName']) &&
    isWslSupportTier(value['supportTier']) &&
    isWslLifecycleMode(value['lifecycleMode']) &&
    isNodePathMode(value['pathMode']) &&
    isOptionalString(value['windowsPath']) &&
    isOptionalStringArray(value['caveats']) &&
    isOptionalString(value['message'])
  );
}

function isNodeServiceManager(value: unknown): value is NodeServiceManager {
  if (!isRecord(value)) return false;
  return (
    isServiceManagerKind(value['kind']) &&
    typeof value['label'] === 'string' &&
    typeof value['supported'] === 'boolean' &&
    typeof value['installable'] === 'boolean' &&
    isOptionalString(value['servicePath']) &&
    isOptionalString(value['unitName']) &&
    isOptionalString(value['statusCommand']) &&
    typeof value['installHint'] === 'string' &&
    typeof value['uninstallHint'] === 'string' &&
    typeof value['message'] === 'string' &&
    isStringArray(value['caveats'])
  );
}

function isSessionResumeKind(value: unknown): value is NodeSessionResumeKind {
  return value === 'tmux' || value === 'canonical-emulator' || value === 'none';
}

function isNodeCapabilities(value: unknown): value is NodeCapabilities {
  if (!isRecord(value)) return false;
  for (const key of requiredCapabilityKeys) {
    if (!isNodeCapabilityProbe(value[key])) return false;
  }
  // sessionResume was added in #467. Pre-#467 nodes did not publish it;
  // accept the field's absence and treat as 'none' at the call site.
  if (
    value['sessionResume'] !== undefined &&
    !isSessionResumeKind(value['sessionResume'])
  ) {
    return false;
  }

  const agents = value['agents'];
  if (!isRecord(agents)) return false;
  return Object.values(agents).every((probe) => isNodeCapabilityProbe(probe));
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

  return (
    isWslInfo(value['wsl']) &&
    isNodeServiceManager(value['serviceManager']) &&
    isNodeCapabilities(value['capabilities'])
  );
}
