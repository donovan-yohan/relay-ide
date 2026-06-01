export type NodeCapabilityStatus =
  | 'available'
  | 'degraded'
  | 'unavailable'
  | 'unknown';

export type NodeTerminalBackendCapability = 'relay-pty' | 'tmux-compat';

export type NodeAgentAuthStatus = 'authed' | 'unauthed' | 'unknown';

export interface NodeCapabilityProbe {
  id: string;
  label: string;
  status: NodeCapabilityStatus;
  message: string;
  path?: string;
  version?: string;
  /** Best-effort auth status for agent CLI probes. Never leaks secrets. */
  authStatus?: NodeAgentAuthStatus;
}

export type RmuxProbeStatus =
  | 'unavailable'
  | 'available-but-unsupported'
  | 'available-experimental'
  | 'probe-failed';

export type RmuxIpcKind = 'unix-socket' | 'windows-pipe' | 'unknown';

export interface RmuxIpcShape {
  kind: RmuxIpcKind;
  source: 'env' | 'platform-default' | 'unknown';
  shape: string;
  endpoint?: string;
}

export type RmuxR0ChecklistStatus = 'pass' | 'warn' | 'fail' | 'unknown';

export type RmuxR0ChecklistId =
  | 'version-pinning'
  | 'crash-restart-behavior'
  | 'socket-ipc-exposure'
  | 'permission-boundary'
  | 'packaging-update-path';

export interface RmuxR0ChecklistItem {
  id: RmuxR0ChecklistId;
  status: RmuxR0ChecklistStatus;
  message: string;
}

/**
 * Diagnostic-only rmux probe. This is availability/adoption-gate evidence,
 * not a runtime backend switch and not a hub capability grant.
 */
export interface RmuxCapabilityProbe {
  id: 'rmux';
  label: string;
  status: RmuxProbeStatus;
  binaryPresent: boolean;
  helperPresent: boolean;
  platform: string;
  arch: string;
  message: string;
  binaryPath?: string;
  helperPath?: string;
  version?: string;
  ipc: RmuxIpcShape;
  r0Checklist: RmuxR0ChecklistItem[];
}

/**
 * Structured degraded reason emitted in `NodeManifest.degradedReasons`.
 * Consumers can filter by severity and react to specific codes without
 * parsing message strings.
 */
export interface NodeManifestDegradedReason {
  code: string;
  description: string;
  severity: 'info' | 'warn' | 'error';
}

/**
 * Canonical resolved filesystem paths for this node installation.
 * Populated best-effort; absent when a path cannot be determined.
 */
export interface NodeResolvedPaths {
  binary?: string;
  configDir?: string;
  logDir?: string;
  socketDir?: string;
}

/**
 * File RPC availability for this node.
 * `capabilities` lists the enabled FileRpcOperation names.
 * `restrictions` lists any active policy overrides that reduce default
 * behaviour (e.g. "write disabled by policy").
 */
export interface NodeFileRpcStatus {
  available: boolean;
  capabilities: string[];
  restrictions?: string[];
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
  /**
   * Terminal runtime backends this node can create new PTY sessions with.
   * `relay-pty` is Relay's default direct PTY/runtime path; `tmux-compat`
   * is the explicit import/fallback path for old tmux-backed sessions.
   */
  terminalBackends?: Record<NodeTerminalBackendCapability, NodeCapabilityProbe>;
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
  /** Optional diagnostic-only rmux probe; absence means pre-rmux-probe node. */
  rmux?: RmuxCapabilityProbe;
  agents: Record<string, NodeCapabilityProbe>;
}

export interface NodeManifest {
  schemaVersion: 1;
  platform: string;
  arch: string;
  /** Linux distro name (from /etc/os-release or WSL_DISTRO_NAME). Absent on macOS/Windows. */
  distro?: string;
  hostname: string;
  homeDir?: string;
  /** Relay helper version (from package.json). Canonical field for the installed helper binary. */
  helperVersion: string;
  /** @deprecated Use helperVersion. Kept for backward compatibility. */
  relayVersion: string;
  /** Hub/node-link protocol version advertised by this node. */
  protocolVersion: string;
  generatedAt: string;
  /** Canonical resolved filesystem paths for this node. */
  resolvedPaths: NodeResolvedPaths;
  /** File RPC availability and capability list. */
  fileRpc: NodeFileRpcStatus;
  wsl: WslInfo;
  serviceManager: NodeServiceManager;
  capabilities: NodeCapabilities;
  /**
   * Structured list of degraded conditions detected during manifest build.
   * Derived from capability probes; never just strings.
   */
  degradedReasons: NodeManifestDegradedReason[];
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

function isRmuxProbeStatus(value: unknown): value is RmuxProbeStatus {
  return (
    value === 'unavailable' ||
    value === 'available-but-unsupported' ||
    value === 'available-experimental' ||
    value === 'probe-failed'
  );
}

function isRmuxIpcKind(value: unknown): value is RmuxIpcKind {
  return value === 'unix-socket' || value === 'windows-pipe' || value === 'unknown';
}

function isRmuxIpcShape(value: unknown): value is RmuxIpcShape {
  if (!isRecord(value)) return false;
  return (
    isRmuxIpcKind(value['kind']) &&
    (value['source'] === 'env' ||
      value['source'] === 'platform-default' ||
      value['source'] === 'unknown') &&
    typeof value['shape'] === 'string' &&
    isOptionalString(value['endpoint'])
  );
}

function isRmuxR0ChecklistId(value: unknown): value is RmuxR0ChecklistId {
  return (
    value === 'version-pinning' ||
    value === 'crash-restart-behavior' ||
    value === 'socket-ipc-exposure' ||
    value === 'permission-boundary' ||
    value === 'packaging-update-path'
  );
}

function isRmuxR0ChecklistStatus(value: unknown): value is RmuxR0ChecklistStatus {
  return value === 'pass' || value === 'warn' || value === 'fail' || value === 'unknown';
}

function isRmuxR0ChecklistItem(value: unknown): value is RmuxR0ChecklistItem {
  if (!isRecord(value)) return false;
  return (
    isRmuxR0ChecklistId(value['id']) &&
    isRmuxR0ChecklistStatus(value['status']) &&
    typeof value['message'] === 'string'
  );
}

function isRmuxCapabilityProbe(value: unknown): value is RmuxCapabilityProbe {
  if (!isRecord(value)) return false;
  return (
    value['id'] === 'rmux' &&
    typeof value['label'] === 'string' &&
    isRmuxProbeStatus(value['status']) &&
    typeof value['binaryPresent'] === 'boolean' &&
    typeof value['helperPresent'] === 'boolean' &&
    typeof value['platform'] === 'string' &&
    typeof value['arch'] === 'string' &&
    typeof value['message'] === 'string' &&
    isOptionalString(value['binaryPath']) &&
    isOptionalString(value['helperPath']) &&
    isOptionalString(value['version']) &&
    isRmuxIpcShape(value['ipc']) &&
    Array.isArray(value['r0Checklist']) &&
    (value['r0Checklist'] as unknown[]).every(isRmuxR0ChecklistItem)
  );
}

function isNodeCapabilities(value: unknown): value is NodeCapabilities {
  if (!isRecord(value)) return false;
  for (const key of requiredCapabilityKeys) {
    if (!isNodeCapabilityProbe(value[key])) return false;
  }
  if (value['terminalBackends'] !== undefined) {
    const terminalBackends = value['terminalBackends'];
    if (!isRecord(terminalBackends)) return false;
    if (!isNodeCapabilityProbe(terminalBackends['relay-pty'])) return false;
    if (!isNodeCapabilityProbe(terminalBackends['tmux-compat'])) return false;
  }
  // sessionResume was added in #467. Pre-#467 nodes did not publish it;
  // accept the field's absence and treat as 'none' at the call site.
  if (
    value['sessionResume'] !== undefined &&
    !isSessionResumeKind(value['sessionResume'])
  ) {
    return false;
  }
  if (value['rmux'] !== undefined && !isRmuxCapabilityProbe(value['rmux'])) {
    return false;
  }

  const agents = value['agents'];
  if (!isRecord(agents)) return false;
  return Object.values(agents).every((probe) => isNodeCapabilityProbe(probe));
}

function isDegradedSeverity(
  value: unknown
): value is NodeManifestDegradedReason['severity'] {
  return value === 'info' || value === 'warn' || value === 'error';
}

function isNodeManifestDegradedReason(
  value: unknown
): value is NodeManifestDegradedReason {
  if (!isRecord(value)) return false;
  return (
    typeof value['code'] === 'string' &&
    typeof value['description'] === 'string' &&
    isDegradedSeverity(value['severity'])
  );
}

function isNodeResolvedPaths(value: unknown): value is NodeResolvedPaths {
  if (!isRecord(value)) return false;
  return (
    isOptionalString(value['binary']) &&
    isOptionalString(value['configDir']) &&
    isOptionalString(value['logDir']) &&
    isOptionalString(value['socketDir'])
  );
}

function isNodeFileRpcStatus(value: unknown): value is NodeFileRpcStatus {
  if (!isRecord(value)) return false;
  return (
    typeof value['available'] === 'boolean' &&
    isStringArray(value['capabilities']) &&
    isOptionalStringArray(value['restrictions'])
  );
}

export function isNodeManifest(value: unknown): value is NodeManifest {
  if (!isRecord(value)) return false;
  if (
    value['schemaVersion'] !== 1 ||
    typeof value['platform'] !== 'string' ||
    typeof value['arch'] !== 'string' ||
    typeof value['hostname'] !== 'string' ||
    !isOptionalString(value['homeDir']) ||
    !isOptionalString(value['distro']) ||
    // helperVersion is required in new manifests; relayVersion kept for back-compat
    (typeof value['helperVersion'] !== 'string' &&
      typeof value['relayVersion'] !== 'string') ||
    typeof value['generatedAt'] !== 'string'
  ) {
    return false;
  }

  // resolvedPaths and fileRpc are required in new (schemaVersion 1 + helperVersion) manifests,
  // but older nodes may omit them. Accept absence for wire compat.
  if (
    value['resolvedPaths'] !== undefined &&
    !isNodeResolvedPaths(value['resolvedPaths'])
  ) {
    return false;
  }
  if (
    value['fileRpc'] !== undefined &&
    !isNodeFileRpcStatus(value['fileRpc'])
  ) {
    return false;
  }
  if (value['degradedReasons'] !== undefined) {
    if (!Array.isArray(value['degradedReasons'])) return false;
    if (
      !(value['degradedReasons'] as unknown[]).every(
        isNodeManifestDegradedReason
      )
    ) {
      return false;
    }
  }

  return (
    isWslInfo(value['wsl']) &&
    isNodeServiceManager(value['serviceManager']) &&
    isNodeCapabilities(value['capabilities'])
  );
}
