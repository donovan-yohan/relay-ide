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
