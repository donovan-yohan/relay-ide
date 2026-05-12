import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { NodeCapabilityProbe, NodeManifest } from '../shared/node-manifest.js';
import type { RepoInventoryReport } from '../shared/repo-inventory.js';
import { createLogger } from './logger.js';
import {
  RELAY_NODE_LINK_PROTOCOL,
  RELAY_NODE_LINK_PROTOCOL_VERSION,
  type HubNodeStatus,
  type HubNodeSummary,
  type HubNodeVersionState,
  type NodeCapabilityManifestSummary,
  type NodeCapabilityStatus,
  type RelayNodeCredential,
  type RelayNodeError,
  type RelayNodeErrorCode,
} from '../shared/relay-node-protocol.js';

const logger = createLogger('hub-node-registry');
const REVERSE_LINK_ROUTE = 'reverse-link' as const;
const UNKNOWN_CAPABILITY_STATUS = 'unknown' as const;

interface StoredPairToken {
  tokenId: string;
  tokenHash: string;
  displayName?: string;
  createdAt: string;
  expiresAt: string;
  usedAt?: string;
}

interface StoredNodeRecord {
  nodeId: string;
  credentialId: string;
  credentialHash: string;
  displayName: string;
  hostname: string;
  platform: string;
  arch: string;
  relayVersion: string;
  protocolVersion: string;
  capabilities: NodeCapabilityManifestSummary;
  repoInventory?: RepoInventoryReport;
  createdAt: string;
  pairedAt: string;
  lastSeenAt: string;
  revokedAt?: string;
}

interface RegistryFile {
  schemaVersion: 1;
  pairTokens: StoredPairToken[];
  nodes: StoredNodeRecord[];
}

export interface PairTokenResponse {
  tokenId: string;
  pairToken: string;
  expiresAt: string;
}

export interface PairExchangeInput {
  pairToken: string;
  manifest: NodeManifest;
  displayName?: string;
  protocolVersion?: string;
}

export interface HeartbeatInput {
  nodeId: string;
  protocolVersion: string;
  manifest?: NodeManifest;
  repoInventory?: RepoInventoryReport;
}

export interface HubNodeRegistryOptions {
  storagePath: string;
  now?: () => Date;
  staleMs?: number;
  offlineMs?: number;
  heartbeatPersistDebounceMs?: number;
}

export const DEFAULT_PAIR_TOKEN_TTL_MS = 10 * 60 * 1000;
export const DEFAULT_NODE_HEARTBEAT_TIMEOUTS = {
  staleMs: 45 * 1000,
  offlineMs: 90 * 1000,
} as const;
export const DEFAULT_HEARTBEAT_PERSIST_DEBOUNCE_MS = 5 * 1000;
const PRIVILEGED_NODE_WARNING =
  'A paired Relay node is trusted to act as the local OS user on that machine.';

export type CredentialAuthResult =
  | { ok: true; node: HubNodeSummary }
  | { ok: false; error: RelayNodeError };
type NodeRevokedListener = (nodeId: string) => void;

class HubNodeRegistryError extends Error {
  readonly relayNodeError: RelayNodeError;

  constructor(code: RelayNodeErrorCode, message: string, retryable = false) {
    super(`${code}: ${message}`);
    this.name = 'HubNodeRegistryError';
    this.relayNodeError = { code, message, retryable };
  }
}

function emptyRegistryFile(): RegistryFile {
  return { schemaVersion: 1, pairTokens: [], nodes: [] };
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function randomToken(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(24).toString('base64url')}`;
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

function assertCompatibleProtocol(protocolVersion: string): void {
  if (protocolVersion === RELAY_NODE_LINK_PROTOCOL_VERSION) return;
  const [requestedMajor] = protocolVersion.split('.');
  const [hubMajor] = RELAY_NODE_LINK_PROTOCOL_VERSION.split('.');
  const code: RelayNodeErrorCode =
    requestedMajor === hubMajor ? 'VERSION_SKEW' : 'PROTOCOL_INCOMPATIBLE';
  throw new HubNodeRegistryError(
    code,
    `relay-node-link protocol ${protocolVersion} must exactly match hub protocol ${RELAY_NODE_LINK_PROTOCOL_VERSION}`
  );
}

function countProbe(
  totals: NodeCapabilityManifestSummary['totals'],
  probe: NodeCapabilityProbe | undefined
): void {
  const status = probe?.status ?? 'unknown';
  totals[status] += 1;
}

function summarizeCapabilities(manifest: NodeManifest): NodeCapabilityManifestSummary {
  const totals = { available: 0, degraded: 0, unavailable: 0, unknown: 0 };
  countProbe(totals, manifest.capabilities.tmux);
  countProbe(totals, manifest.capabilities.git);
  countProbe(totals, manifest.capabilities.clipboard);
  countProbe(totals, manifest.capabilities.browserAutomation);
  countProbe(totals, manifest.capabilities.githubCli);
  countProbe(totals, manifest.capabilities.tailscale);
  countProbe(totals, manifest.capabilities.ssh);

  const agents: NodeCapabilityManifestSummary['agents'] = {};
  for (const [id, probe] of Object.entries(manifest.capabilities.agents)) {
    agents[id] = probe.status;
    countProbe(totals, probe);
  }

  return {
    totals,
    core: {
      shell: 'available',
      tmux: manifest.capabilities.tmux.status,
      git: manifest.capabilities.git.status,
      worktrees: worktreeCapabilityStatus(manifest.capabilities.git.status),
      browserAutomation: manifest.capabilities.browserAutomation.status,
      clipboardImage: manifest.capabilities.clipboard.status,
      ssh: manifest.capabilities.ssh.status,
      tailscale: manifest.capabilities.tailscale.status,
    },
    agents,
    serviceManager: manifest.serviceManager.kind,
    wsl: manifest.wsl.detected,
  };
}

function worktreeCapabilityStatus(gitStatus: NodeCapabilityStatus): NodeCapabilityStatus {
  if (gitStatus === 'available') return 'available';
  return gitStatus;
}

function nodeDisplayName(displayName: string | undefined, manifest: NodeManifest): string {
  const trimmed = displayName?.trim();
  return trimmed || manifest.hostname;
}

function readRegistryFile(storagePath: string): RegistryFile {
  try {
    const parsed = JSON.parse(fs.readFileSync(storagePath, 'utf8')) as Partial<RegistryFile>;
    if (parsed.schemaVersion !== 1) return emptyRegistryFile();
    return {
      schemaVersion: 1,
      pairTokens: Array.isArray(parsed.pairTokens) ? parsed.pairTokens : [],
      nodes: Array.isArray(parsed.nodes) ? parsed.nodes : [],
    };
  } catch (error) {
    const maybeNodeError = error as NodeJS.ErrnoException;
    if (maybeNodeError.code === 'ENOENT') return emptyRegistryFile();
    if (error instanceof SyntaxError) {
      quarantineCorruptRegistryFile(storagePath);
      return emptyRegistryFile();
    }
    throw error;
  }
}

function quarantineCorruptRegistryFile(storagePath: string): void {
  const quarantinePath = `${storagePath}.corrupt-${Date.now()}`;
  try {
    fs.renameSync(storagePath, quarantinePath);
    logger.warn(
      'hub node registry file is corrupt; quarantined file and starting with empty registry: %s',
      quarantinePath
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(
      'hub node registry file is corrupt; could not quarantine file and starting with empty registry: %s',
      message
    );
  }
}

function writeRegistryFile(storagePath: string, registry: RegistryFile): void {
  fs.mkdirSync(path.dirname(storagePath), { recursive: true });
  const tmpPath = `${storagePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmpPath, `${JSON.stringify(registry)}\n`, { mode: 0o600 });
    fs.renameSync(tmpPath, storagePath);
  } catch (error) {
    fs.rmSync(tmpPath, { force: true });
    throw error;
  }
}

function statusForNode(
  node: StoredNodeRecord,
  now: Date,
  staleMs: number,
  offlineMs: number
): HubNodeStatus {
  if (node.revokedAt) return 'revoked';
  const ageMs = now.getTime() - Date.parse(node.lastSeenAt);
  if (ageMs > offlineMs) return 'offline';
  if (ageMs > staleMs) return 'stale';
  return 'online';
}

function normalizeCapabilitySummary(
  capabilities: NodeCapabilityManifestSummary
): NodeCapabilityManifestSummary {
  if (capabilities.core) return capabilities;
  return {
    ...capabilities,
    core: {
      shell: UNKNOWN_CAPABILITY_STATUS,
      tmux: UNKNOWN_CAPABILITY_STATUS,
      git: UNKNOWN_CAPABILITY_STATUS,
      worktrees: UNKNOWN_CAPABILITY_STATUS,
      browserAutomation: UNKNOWN_CAPABILITY_STATUS,
      clipboardImage: UNKNOWN_CAPABILITY_STATUS,
      ssh: UNKNOWN_CAPABILITY_STATUS,
      tailscale: UNKNOWN_CAPABILITY_STATUS,
    },
  };
}

function versionState(protocolVersion: string): HubNodeVersionState {
  if (protocolVersion === RELAY_NODE_LINK_PROTOCOL_VERSION) return 'compatible';
  const [nodeMajor] = protocolVersion.split('.');
  const [hubMajor] = RELAY_NODE_LINK_PROTOCOL_VERSION.split('.');
  return nodeMajor === hubMajor ? 'version-skew' : 'incompatible';
}

function publicNode(
  node: StoredNodeRecord,
  status: HubNodeStatus
): HubNodeSummary {
  return {
    nodeId: node.nodeId,
    displayName: node.displayName,
    hostname: node.hostname,
    platform: node.platform,
    arch: node.arch,
    relayVersion: node.relayVersion,
    protocolVersion: node.protocolVersion,
    status,
    connection: connectionSummary(status),
    trust: {
      state: node.revokedAt ? 'revoked' : 'trusted',
      level: 'privileged-local-user',
      warning: PRIVILEGED_NODE_WARNING,
    },
    credentialState: node.revokedAt ? 'revoked' : 'active',
    version: {
      state: versionState(node.protocolVersion),
      nodeProtocolVersion: node.protocolVersion,
      hubProtocolVersion: RELAY_NODE_LINK_PROTOCOL_VERSION,
    },
    capabilities: normalizeCapabilitySummary(node.capabilities),
    createdAt: node.createdAt,
    pairedAt: node.pairedAt,
    lastSeenAt: node.lastSeenAt,
    credentialId: node.credentialId,
  };
}

function connectionSummary(status: HubNodeStatus): HubNodeSummary['connection'] {
  if (status === 'online') return { route: REVERSE_LINK_ROUTE, status: 'connected' };
  if (status === 'stale') return { route: REVERSE_LINK_ROUTE, status: 'stale heartbeat' };
  if (status === 'offline') return { route: REVERSE_LINK_ROUTE, status: 'offline' };
  return { route: REVERSE_LINK_ROUTE, status: 'revoked' };
}

export class HubNodeRegistry {
  readonly storagePath: string;
  private now: () => Date;
  private readonly staleMs: number;
  private readonly offlineMs: number;
  private readonly heartbeatPersistDebounceMs: number;
  private state: RegistryFile;
  private heartbeatPersistTimer: NodeJS.Timeout | null = null;
  private heartbeatPersistDirty = false;
  private heartbeatPersistError: unknown = null;
  private readonly nodeRevokedListeners = new Set<NodeRevokedListener>();

  constructor(options: HubNodeRegistryOptions) {
    this.storagePath = options.storagePath;
    this.now = options.now ?? (() => new Date());
    this.staleMs = options.staleMs ?? DEFAULT_NODE_HEARTBEAT_TIMEOUTS.staleMs;
    this.offlineMs = options.offlineMs ?? DEFAULT_NODE_HEARTBEAT_TIMEOUTS.offlineMs;
    this.heartbeatPersistDebounceMs =
      options.heartbeatPersistDebounceMs ?? DEFAULT_HEARTBEAT_PERSIST_DEBOUNCE_MS;
    this.state = readRegistryFile(options.storagePath);
  }

  setNowForTest(now: () => Date): void {
    this.now = now;
  }

  onNodeRevoked(listener: NodeRevokedListener): () => void {
    this.nodeRevokedListeners.add(listener);
    return () => {
      this.nodeRevokedListeners.delete(listener);
    };
  }

  createPairToken(options: { displayName?: string; ttlMs?: number }): PairTokenResponse {
    const createdAt = this.now();
    const expiresAt = new Date(
      createdAt.getTime() + (options.ttlMs ?? DEFAULT_PAIR_TOKEN_TTL_MS)
    );
    const pairToken = randomToken('pair');
    const tokenId = randomToken('pt');
    this.state.pairTokens.push({
      tokenId,
      tokenHash: sha256(pairToken),
      ...(options.displayName ? { displayName: options.displayName } : {}),
      createdAt: createdAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
    });
    this.persist();
    return {
      tokenId,
      pairToken,
      expiresAt: expiresAt.toISOString(),
    };
  }

  exchangePairToken(input: PairExchangeInput): {
    credential: RelayNodeCredential;
    node: HubNodeSummary;
  } {
    const protocolVersion = input.protocolVersion ?? RELAY_NODE_LINK_PROTOCOL_VERSION;
    assertCompatibleProtocol(protocolVersion);
    const tokenHash = sha256(input.pairToken);
    const pairToken = this.state.pairTokens.find((candidate) =>
      timingSafeEqualHex(candidate.tokenHash, tokenHash)
    );
    if (!pairToken) {
      throw new HubNodeRegistryError('UNAUTHORIZED', 'pair token was not found');
    }
    if (pairToken.usedAt) {
      throw new HubNodeRegistryError('TOKEN_ALREADY_USED', 'pair token has already been used');
    }
    const now = this.now();
    if (Date.parse(pairToken.expiresAt) <= now.getTime()) {
      throw new HubNodeRegistryError('TOKEN_EXPIRED', 'pair token expired');
    }

    const nodeId = randomToken('node');
    const credentialId = randomToken('cred');
    const secret = randomToken('secret');
    const token = `${nodeId}.${secret}`;
    const timestamp = now.toISOString();
    const node: StoredNodeRecord = {
      nodeId,
      credentialId,
      credentialHash: sha256(token),
      displayName: nodeDisplayName(input.displayName ?? pairToken.displayName, input.manifest),
      hostname: input.manifest.hostname,
      platform: input.manifest.platform,
      arch: input.manifest.arch,
      relayVersion: input.manifest.relayVersion,
      protocolVersion,
      capabilities: summarizeCapabilities(input.manifest),
      createdAt: timestamp,
      pairedAt: timestamp,
      lastSeenAt: timestamp,
    };
    pairToken.usedAt = timestamp;
    this.state.nodes.push(node);
    this.persist();
    return {
      credential: {
        protocol: RELAY_NODE_LINK_PROTOCOL,
        protocolVersion: RELAY_NODE_LINK_PROTOCOL_VERSION,
        nodeId,
        credentialId,
        token,
        issuedAt: timestamp,
      },
      node: publicNode(node, 'online'),
    };
  }

  authenticateCredential(token: string): HubNodeSummary | null {
    const result = this.authenticateCredentialDetailed(token);
    return result.ok ? result.node : null;
  }

  authenticateCredentialDetailed(token: string): CredentialAuthResult {
    const tokenHash = sha256(token);
    const [nodeId] = token.split('.', 1);
    const node = this.state.nodes.find((candidate) => candidate.nodeId === nodeId);
    if (!node || !timingSafeEqualHex(node.credentialHash, tokenHash)) {
      return {
        ok: false,
        error: { code: 'UNAUTHORIZED', message: 'invalid node credential', retryable: false },
      };
    }
    if (node.revokedAt) {
      return {
        ok: false,
        error: { code: 'NODE_REVOKED', message: 'node credential was revoked', retryable: false },
      };
    }
    return {
      ok: true,
      node: publicNode(
        node,
        statusForNode(node, this.now(), this.staleMs, this.offlineMs)
      ),
    };
  }

  recordHeartbeat(input: HeartbeatInput): HubNodeSummary {
    assertCompatibleProtocol(input.protocolVersion);
    const node = this.state.nodes.find((candidate) => candidate.nodeId === input.nodeId);
    if (!node) throw new HubNodeRegistryError('NOT_FOUND', 'node is not paired');
    if (node.revokedAt) throw new HubNodeRegistryError('NODE_REVOKED', 'node was revoked');
    const now = this.now().toISOString();
    node.lastSeenAt = now;
    node.protocolVersion = input.protocolVersion;
    if (input.manifest) {
      node.hostname = input.manifest.hostname;
      node.platform = input.manifest.platform;
      node.arch = input.manifest.arch;
      node.relayVersion = input.manifest.relayVersion;
      node.capabilities = summarizeCapabilities(input.manifest);
    }
    if (input.repoInventory) {
      if (input.repoInventory.nodeId !== input.nodeId) {
        throw new HubNodeRegistryError(
          'INVALID_REQUEST',
          'repoInventory.nodeId must match authenticated nodeId'
        );
      }
      node.repoInventory = input.repoInventory;
    }
    this.scheduleHeartbeatPersist();
    return publicNode(node, 'online');
  }

  async flushPendingHeartbeatPersist(): Promise<void> {
    if (this.heartbeatPersistTimer) {
      clearTimeout(this.heartbeatPersistTimer);
      this.heartbeatPersistTimer = null;
    }
    this.flushHeartbeatPersistNow();

    if (this.heartbeatPersistError) {
      const error = this.heartbeatPersistError;
      this.heartbeatPersistError = null;
      throw error;
    }
  }

  listNodes(): HubNodeSummary[] {
    const now = this.now();
    return this.state.nodes.map((node) =>
      publicNode(node, statusForNode(node, now, this.staleMs, this.offlineMs))
    );
  }

  listRepoInventoryReports(options: { includeRevoked?: boolean } = {}): RepoInventoryReport[] {
    return this.state.nodes
      .filter((node) => options.includeRevoked || !node.revokedAt)
      .map((node) => node.repoInventory)
      .filter((report): report is RepoInventoryReport => Boolean(report));
  }

  revokeNode(nodeId: string): HubNodeSummary {
    const node = this.state.nodes.find((candidate) => candidate.nodeId === nodeId);
    if (!node) throw new HubNodeRegistryError('NOT_FOUND', 'node is not paired');
    const alreadyRevoked = Boolean(node.revokedAt);
    if (!alreadyRevoked) {
      node.revokedAt = this.now().toISOString();
      this.persist();
      this.notifyNodeRevoked(nodeId);
    }
    return publicNode(node, 'revoked');
  }

  errorBody(error: unknown): { error: RelayNodeError } {
    if (error instanceof HubNodeRegistryError) {
      return { error: error.relayNodeError };
    }
    return {
      error: {
        code: 'INTERNAL',
        message: error instanceof Error ? error.message : 'internal hub node registry error',
        retryable: true,
      },
    };
  }

  private notifyNodeRevoked(nodeId: string): void {
    this.nodeRevokedListeners.forEach((listener) => listener(nodeId));
  }

  private persist(): void {
    this.cancelPendingHeartbeatPersist();
    this.heartbeatPersistError = null;
    writeRegistryFile(this.storagePath, this.state);
  }

  private scheduleHeartbeatPersist(): void {
    this.heartbeatPersistDirty = true;
    if (this.heartbeatPersistTimer) return;
    this.heartbeatPersistTimer = setTimeout(() => {
      this.heartbeatPersistTimer = null;
      try {
        this.flushHeartbeatPersistNow();
      } catch {
        /* error is recorded for a later deterministic flush/retry */
      }
    }, this.heartbeatPersistDebounceMs);
    this.heartbeatPersistTimer.unref?.();
  }

  private flushHeartbeatPersistNow(): void {
    if (!this.heartbeatPersistDirty) return;
    try {
      writeRegistryFile(this.storagePath, this.state);
      this.heartbeatPersistDirty = false;
      this.heartbeatPersistError = null;
    } catch (error) {
      this.heartbeatPersistError = error;
      throw error;
    }
  }

  private cancelPendingHeartbeatPersist(): void {
    if (this.heartbeatPersistTimer) {
      clearTimeout(this.heartbeatPersistTimer);
      this.heartbeatPersistTimer = null;
    }
    this.heartbeatPersistDirty = false;
  }
}

export function createHubNodeRegistry(options: HubNodeRegistryOptions): HubNodeRegistry {
  return new HubNodeRegistry(options);
}

export { HubNodeRegistryError, summarizeCapabilities };
