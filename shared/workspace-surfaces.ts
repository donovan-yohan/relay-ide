import type { NodeId } from './identity.js';
import type { WorkspaceId } from './workspace.js';

// Workspace surfaces (#784): a read-mostly catalogue of the dev servers,
// previews, docs, dashboards, logs, and commands attached to a workspace
// evidence root. Surfaces are either *discovered* via safe static inspection
// (configured repo metadata, package.json scripts, docker-compose published
// ports) or *agent-published* by an agent that knows about a surface Relay
// cannot statically see. There is intentionally no process/port scanning.

export const WORKSPACE_SURFACES_MAX_LIST_ENTRIES = 200;
export const WORKSPACE_SURFACES_DEFAULT_LIST_ENTRIES = 100;
/** Bounded retention for agent-published surfaces (oldest trimmed FIFO). */
export const WORKSPACE_SURFACES_MAX_PUBLISHED_ENTRIES = 500;
export const WORKSPACE_SURFACE_LABEL_MAX = 200;
export const WORKSPACE_SURFACE_DESCRIPTION_MAX = 2000;
export const WORKSPACE_SURFACE_URL_MAX = 2048;
export const WORKSPACE_SURFACE_COMMAND_MAX = 2048;

export const WORKSPACE_SURFACE_KINDS = [
  'web',
  'docs',
  'preview',
  'dashboard',
  'logs',
  'command',
] as const;
export type WorkspaceSurfaceKind = (typeof WORKSPACE_SURFACE_KINDS)[number];

export const WORKSPACE_SURFACE_PROVENANCES = [
  'configured',
  'package-script',
  'compose',
  'agent-published',
  // Reserved: live process inspection is intentionally NOT implemented (no
  // process/network scanning). Kept in the union so the value is stable if a
  // future, capability-gated discovery lane ever lands.
  'process-scan',
] as const;
export type WorkspaceSurfaceProvenance =
  (typeof WORKSPACE_SURFACE_PROVENANCES)[number];

export type WorkspaceSurfaceStatus = 'discovered' | 'published' | 'retired';

export type WorkspaceSurfaceHealth =
  | 'unknown'
  | 'reachable'
  | 'unreachable'
  | 'configured';

/**
 * How the frontend may act on a surface's URL/command. Never assume localhost
 * means the browser device: only a hub-owned loopback surface (or a public,
 * non-loopback URL) may be opened directly. Node-owned or ambiguous loopback
 * URLs are copy-only/node-scoped until a real proxy/tunnel exists.
 */
export type WorkspaceSurfaceOpenMode =
  | 'direct'
  | 'node-scoped'
  | 'copy'
  | 'unavailable';

export interface WorkspaceSurfaceProvenanceMeta {
  source: WorkspaceSurfaceProvenance;
  /** package.json script name / compose service name / etc. */
  detail?: string;
  actor?: string;
  sessionId?: string;
  workContextId?: string;
}

export interface WorkspaceSurface {
  id: string;
  kind: WorkspaceSurfaceKind;
  label: string;
  description?: string;
  url?: string;
  command?: string;
  /** Reference to a log file/artifact (relative path or artifact id). */
  logRef?: string;
  nodeId: NodeId;
  workspaceId?: WorkspaceId;
  /** Workspace-evidence root id this surface belongs to. */
  rootId?: string;
  repoPath?: string;
  status: WorkspaceSurfaceStatus;
  health: WorkspaceSurfaceHealth;
  provenance: WorkspaceSurfaceProvenanceMeta;
  /** Derived at read time; never persisted. */
  openMode: WorkspaceSurfaceOpenMode;
  createdAt?: string;
  updatedAt?: string;
}

export interface WorkspaceSurfaceListResponse {
  surfaces: WorkspaceSurface[];
  truncated: boolean;
}

export interface WorkspaceSurfacePublishInput {
  id?: string;
  kind: WorkspaceSurfaceKind;
  label: string;
  description?: string;
  url?: string;
  command?: string;
  logRef?: string;
  nodeId?: NodeId;
  workspaceId?: WorkspaceId;
  rootId?: string;
  repoPath?: string;
  health?: WorkspaceSurfaceHealth;
  actor?: string;
  sessionId?: string;
  workContextId?: string;
}

export interface WorkspaceSurfaceConfiguredInput
  extends WorkspaceSurfacePublishInput {
  /** Optional config/source label shown in provenance metadata. */
  provenanceDetail?: string;
}

export class WorkspaceSurfaceValidationError extends Error {
  constructor(
    message: string,
    public readonly details: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = 'WorkspaceSurfaceValidationError';
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readString(value: unknown, field: string, max: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new WorkspaceSurfaceValidationError(`${field} must be a string`, { field });
  }
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > max) {
    throw new WorkspaceSurfaceValidationError(`${field} exceeds ${max} characters`, {
      field,
      max,
    });
  }
  return trimmed;
}

function isWorkspaceSurfaceKind(value: unknown): value is WorkspaceSurfaceKind {
  return (
    typeof value === 'string' &&
    (WORKSPACE_SURFACE_KINDS as readonly string[]).includes(value)
  );
}

function isHealth(value: unknown): value is WorkspaceSurfaceHealth {
  return (
    value === 'unknown' ||
    value === 'reachable' ||
    value === 'unreachable' ||
    value === 'configured'
  );
}

/**
 * Strict parse of an agent-published surface. URLs must be http(s) (or a clearly
 * relative path); arbitrary schemes (file:, javascript:, data:) are rejected so
 * a published surface can never smuggle an unsafe link into the dashboard.
 */
export function parseWorkspaceSurfacePublishInput(
  raw: unknown
): WorkspaceSurfacePublishInput {
  const record = asRecord(raw);
  const kind = record['kind'];
  if (!isWorkspaceSurfaceKind(kind)) {
    throw new WorkspaceSurfaceValidationError(
      `kind is required and must be one of ${WORKSPACE_SURFACE_KINDS.join(', ')}`,
      { field: 'kind' }
    );
  }
  const label = readString(record['label'], 'label', WORKSPACE_SURFACE_LABEL_MAX);
  if (!label) {
    throw new WorkspaceSurfaceValidationError('label is required', { field: 'label' });
  }
  const url = readString(record['url'], 'url', WORKSPACE_SURFACE_URL_MAX);
  if (url !== undefined) assertSafeUrl(url);
  const healthRaw = record['health'];
  const health = isHealth(healthRaw) ? healthRaw : undefined;
  if (healthRaw !== undefined && !health) {
    throw new WorkspaceSurfaceValidationError('health is invalid', { field: 'health' });
  }
  const input: WorkspaceSurfacePublishInput = { kind, label };
  const id = readString(record['id'], 'id', 256);
  if (id) input.id = id;
  const description = readString(
    record['description'],
    'description',
    WORKSPACE_SURFACE_DESCRIPTION_MAX
  );
  if (description) input.description = description;
  if (url) input.url = url;
  const command = readString(record['command'], 'command', WORKSPACE_SURFACE_COMMAND_MAX);
  if (command) input.command = command;
  const logRef = readString(record['logRef'], 'logRef', WORKSPACE_SURFACE_URL_MAX);
  if (logRef) input.logRef = logRef;
  const nodeId = readString(record['nodeId'], 'nodeId', 256);
  if (nodeId) input.nodeId = nodeId;
  const workspaceId = readString(record['workspaceId'], 'workspaceId', 256);
  if (workspaceId) input.workspaceId = workspaceId;
  const rootId = readString(record['rootId'], 'rootId', 2048);
  if (rootId) input.rootId = rootId;
  const repoPath = readString(record['repoPath'], 'repoPath', 4096);
  if (repoPath) input.repoPath = repoPath;
  if (health) input.health = health;
  const actor = readString(record['actor'], 'actor', 256);
  if (actor) input.actor = actor;
  const sessionId = readString(record['sessionId'], 'sessionId', 256);
  if (sessionId) input.sessionId = sessionId;
  const workContextId = readString(record['workContextId'], 'workContextId', 256);
  if (workContextId) input.workContextId = workContextId;
  // A surface with no actionable target is meaningless.
  if (!input.url && !input.command && !input.logRef) {
    throw new WorkspaceSurfaceValidationError(
      'one of url, command, or logRef is required'
    );
  }
  return input;
}

function isRelativePath(url: string): boolean {
  return (url.startsWith('/') && !url.startsWith('//')) || url.startsWith('./') || url.startsWith('../');
}

function assertSafeUrl(url: string): void {
  // Relative path (served under a root/proxy) is allowed.
  if (isRelativePath(url)) return;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new WorkspaceSurfaceValidationError('url is not a valid URL or relative path', {
      field: 'url',
    });
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new WorkspaceSurfaceValidationError('url must be http(s) or a relative path', {
      field: 'url',
      protocol: parsed.protocol,
    });
  }
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]']);

/** True for an http(s) URL whose host is a loopback / unspecified address. */
export function isLoopbackUrl(url: string | undefined): boolean {
  if (!url || isRelativePath(url)) return false;
  try {
    const parsed = new URL(url);
    return LOOPBACK_HOSTS.has(parsed.hostname);
  } catch {
    return false;
  }
}

/**
 * Decide how a surface may be opened, given which node owns it. Routing
 * boundary (#784): localhost is the *owning node's* loopback, not the browser
 * device, so a node-owned loopback URL is copy-only/node-scoped.
 */
export function classifyOpenMode(
  surface: Pick<WorkspaceSurface, 'url' | 'command' | 'logRef' | 'nodeId'>,
  localNodeId: NodeId
): WorkspaceSurfaceOpenMode {
  if (!surface.url) {
    return surface.command || surface.logRef ? 'copy' : 'unavailable';
  }
  const nodeGated = isRelativePath(surface.url) || isLoopbackUrl(surface.url);
  if (!nodeGated) return 'direct';
  return surface.nodeId === localNodeId ? 'direct' : 'node-scoped';
}

export function createWorkspaceSurfaceId(
  nodeId: NodeId,
  rootId: string | undefined,
  slug: string
): string {
  const root = rootId ? rootId : 'none';
  return `wsurf:${encodeURIComponent(nodeId)}:${encodeURIComponent(root)}:${encodeURIComponent(
    slug
  )}`;
}
