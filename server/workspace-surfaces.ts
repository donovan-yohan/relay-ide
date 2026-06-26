import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as path from 'node:path';
import express, { type Request, type RequestHandler, type Response } from 'express';

import type { RelayCliGatewayErrorCode } from '../shared/cli-gateway-contract.js';
import { DEFAULT_LOCAL_NODE_ID } from '../shared/identity.js';
import {
  authenticatedCliGatewayActorCredential,
  type CliGatewayActorWriteCommand,
} from './cli-gateway-actor-auth.js';
import {
  WORKSPACE_SURFACES_DEFAULT_LIST_ENTRIES,
  WORKSPACE_SURFACES_MAX_LIST_ENTRIES,
  WORKSPACE_SURFACES_MAX_PUBLISHED_ENTRIES,
  WorkspaceSurfaceValidationError,
  classifyOpenMode,
  createWorkspaceSurfaceId,
  parseWorkspaceSurfacePublishInput,
  type WorkspaceSurface,
  type WorkspaceSurfaceConfiguredInput,
  type WorkspaceSurfacePublishInput,
} from '../shared/workspace-surfaces.js';
import { listConfiguredWorkspaceEvidenceRoots } from './workspace-evidence.js';
import type { Config } from './types.js';
import type { WorkspaceEvidenceRoot } from '../shared/workspace-evidence.js';

const CONTEXT_READ = 'context:read';
const CONTEXT_WRITE = 'context:write';
const WORKSPACE_SURFACES_LIST_SENTINEL_LIMIT =
  WORKSPACE_SURFACES_MAX_LIST_ENTRIES + 1;

function workspaceSurfacePriority(surface: WorkspaceSurface): number {
  if (surface.status === 'published') return 2;
  if (surface.provenance.source === 'configured') return 1;
  return 0;
}

// ─── Static discovery (no process/network scanning) ──────────────────────────

// package.json script names that conventionally start a long-running web/dev
// surface. Mapped to a surface kind so the dashboard can label them sensibly.
const DEV_SCRIPT_KINDS: Array<{ pattern: RegExp; kind: WorkspaceSurface['kind'] }> = [
  { pattern: /(^|:)docs?($|:)|storybook/i, kind: 'docs' },
  { pattern: /preview/i, kind: 'preview' },
  { pattern: /(^|:)(dev|serve|start|vite)($|:)/i, kind: 'web' },
];

function classifyScript(name: string): WorkspaceSurface['kind'] | null {
  for (const { pattern, kind } of DEV_SCRIPT_KINDS) {
    if (pattern.test(name)) return kind;
  }
  return null;
}

// Best-effort static port extraction from a package.json script command. Only
// reads the literal text — never executes anything.
function extractPort(command: string): number | null {
  const patterns = [
    /--port[=\s]+(\d{2,5})/,
    /(?:^|\s)-p[=\s]+(\d{2,5})/,
    /PORT[=\s]+(\d{2,5})/,
    /localhost:(\d{2,5})/,
    /127\.0\.0\.1:(\d{2,5})/,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(command);
    if (match && match[1]) {
      const port = Number.parseInt(match[1], 10);
      if (port > 0 && port < 65536) return port;
    }
  }
  return null;
}

function readJsonFile(file: string): Record<string, unknown> | null {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function discoverPackageScripts(root: WorkspaceEvidenceRoot): WorkspaceSurface[] {
  if (!root.path) return [];
  const pkg = readJsonFile(path.join(root.path, 'package.json'));
  const scripts = pkg && typeof pkg['scripts'] === 'object' && pkg['scripts'] !== null
    ? (pkg['scripts'] as Record<string, unknown>)
    : null;
  if (!scripts) return [];
  const surfaces: WorkspaceSurface[] = [];
  for (const [name, value] of Object.entries(scripts)) {
    if (typeof value !== 'string') continue;
    const kind = classifyScript(name);
    if (!kind) continue;
    const port = extractPort(value);
    const surface = baseSurface(root, {
      slug: `pkg:${name}`,
      kind,
      label: `npm run ${name}`,
      description: value.length > 200 ? `${value.slice(0, 197)}…` : value,
      provenance: { source: 'package-script', detail: name },
      command: `npm run ${name}`,
      ...(port ? { url: `http://localhost:${port}` } : {}),
    });
    surfaces.push(surface);
  }
  return surfaces;
}

// docker-compose published-port discovery via a tolerant line scan. Avoids a
// YAML dependency: matches `- "3000:8080"` / `- 3000:8080` ports entries. Only
// the host (published) port becomes a loopback URL.
const COMPOSE_FILES = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'];
const COMPOSE_PORT = /^\s*-\s*["']?(\d{2,5}):(\d{2,5})["']?\s*$/;

function discoverComposePorts(root: WorkspaceEvidenceRoot): WorkspaceSurface[] {
  if (!root.path) return [];
  for (const name of COMPOSE_FILES) {
    const file = path.join(root.path, name);
    let raw: string;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const surfaces: WorkspaceSurface[] = [];
    const seen = new Set<number>();
    for (const line of raw.split(/\r?\n/)) {
      const match = COMPOSE_PORT.exec(line);
      if (!match || !match[1]) continue;
      const hostPort = Number.parseInt(match[1], 10);
      if (!(hostPort > 0 && hostPort < 65536) || seen.has(hostPort)) continue;
      seen.add(hostPort);
      surfaces.push(
        baseSurface(root, {
          slug: `compose:${hostPort}`,
          kind: 'web',
          label: `compose :${hostPort}`,
          description: `docker-compose published port ${match[1]}:${match[2]} (${name})`,
          provenance: { source: 'compose', detail: name },
          url: `http://localhost:${hostPort}`,
        })
      );
    }
    if (surfaces.length) return surfaces;
  }
  return [];
}

function baseSurface(
  root: WorkspaceEvidenceRoot,
  fields: {
    slug: string;
    kind: WorkspaceSurface['kind'];
    label: string;
    description?: string;
    provenance: WorkspaceSurface['provenance'];
    url?: string;
    command?: string;
  }
): WorkspaceSurface {
  const surface: WorkspaceSurface = {
    id: createWorkspaceSurfaceId(root.nodeId, root.ref.id, fields.slug),
    kind: fields.kind,
    label: fields.label,
    nodeId: root.nodeId,
    rootId: root.ref.id,
    status: 'discovered',
    health: fields.url ? 'configured' : 'unknown',
    provenance: fields.provenance,
    openMode: 'unavailable',
  };
  if (fields.description) surface.description = fields.description;
  if (fields.url) surface.url = fields.url;
  if (fields.command) surface.command = fields.command;
  if (root.ref.workspaceId) surface.workspaceId = root.ref.workspaceId;
  if (root.path) surface.repoPath = root.path;
  surface.openMode = classifyOpenMode(surface, DEFAULT_LOCAL_NODE_ID);
  return surface;
}

function findConfiguredSurfaceRoot(
  roots: WorkspaceEvidenceRoot[],
  input: WorkspaceSurfaceConfiguredInput
): WorkspaceEvidenceRoot | undefined {
  if (input.rootId) {
    const byRoot = roots.find((root) => root.ref.id === input.rootId);
    if (byRoot) return byRoot;
  }
  if (input.repoPath) {
    const resolved = path.resolve(input.repoPath);
    const byPath = roots.find(
      (root) => root.path && path.resolve(root.path) === resolved
    );
    if (byPath) return byPath;
  }
  if (input.workspaceId) {
    const byWorkspace = roots.find(
      (root) => root.ref.workspaceId === input.workspaceId
    );
    if (byWorkspace) return byWorkspace;
  }
  return undefined;
}

function discoverConfiguredSurfaces(
  config: Config,
  roots: WorkspaceEvidenceRoot[]
): WorkspaceSurface[] {
  const configured = Array.isArray(config.workspaceSurfaces)
    ? config.workspaceSurfaces
    : [];
  const surfaces: WorkspaceSurface[] = [];
  for (const raw of configured) {
    try {
      const parsed = parseWorkspaceSurfacePublishInput(raw);
      const root = findConfiguredSurfaceRoot(roots, parsed);
      const nodeId = parsed.nodeId ?? root?.nodeId ?? DEFAULT_LOCAL_NODE_ID;
      const rootId = parsed.rootId ?? root?.ref.id;
      const workspaceId = parsed.workspaceId ?? root?.ref.workspaceId;
      const repoPath = parsed.repoPath ?? root?.path;
      const record: WorkspaceSurface = {
        id:
          parsed.id ??
          createWorkspaceSurfaceId(
            nodeId,
            rootId,
            `configured:${parsed.kind}:${parsed.label}`
          ),
        kind: parsed.kind,
        label: parsed.label,
        ...(parsed.description ? { description: parsed.description } : {}),
        ...(parsed.url ? { url: parsed.url } : {}),
        ...(parsed.command ? { command: parsed.command } : {}),
        ...(parsed.logRef ? { logRef: parsed.logRef } : {}),
        nodeId,
        ...(workspaceId ? { workspaceId } : {}),
        ...(rootId ? { rootId } : {}),
        ...(repoPath ? { repoPath } : {}),
        status: 'discovered',
        health: parsed.health ?? 'configured',
        provenance: {
          source: 'configured',
          ...(raw.provenanceDetail ? { detail: raw.provenanceDetail } : {}),
        },
        openMode: 'unavailable',
      };
      record.openMode = classifyOpenMode(record, DEFAULT_LOCAL_NODE_ID);
      surfaces.push(record);
    } catch {
      // Invalid configured entries are ignored so a stale config value cannot
      // break the workspace evidence dashboard or CLI list path.
    }
  }
  return surfaces;
}

export async function discoverWorkspaceSurfaces(config: Config): Promise<WorkspaceSurface[]> {
  const roots = await listConfiguredWorkspaceEvidenceRoots(config);
  const surfaces: WorkspaceSurface[] = [];
  surfaces.push(...discoverConfiguredSurfaces(config, roots));
  for (const root of roots) {
    if (root.status !== 'available' || !root.path) continue;
    surfaces.push(...discoverPackageScripts(root), ...discoverComposePorts(root));
  }
  return surfaces;
}

// ─── Agent-published store (bounded, persisted under the config dir) ──────────

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS workspace_surfaces (
  id           TEXT PRIMARY KEY,
  node_id      TEXT NOT NULL,
  workspace_id TEXT,
  root_id      TEXT,
  repo_path    TEXT,
  record_json  TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_workspace_surfaces_root
  ON workspace_surfaces(root_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_workspace_surfaces_workspace
  ON workspace_surfaces(workspace_id, updated_at DESC);
`;

export interface WorkspaceSurfaceListFilter {
  rootId?: string;
  workspaceId?: string;
  repoPath?: string;
  limit?: number;
}

export interface WorkspaceSurfaceStore {
  close(): void;
  upsert(input: WorkspaceSurfacePublishInput): WorkspaceSurface;
  list(filter: WorkspaceSurfaceListFilter): WorkspaceSurface[];
  get(id: string): WorkspaceSurface | null;
}

interface SurfaceRow {
  record_json: string;
}

function defaultClock(): string {
  return new Date().toISOString();
}

export function createWorkspaceSurfaceStore(input: {
  dbPath: string;
  now?: () => string;
}): WorkspaceSurfaceStore {
  const db = new Database(input.dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA_SQL);
  const clock = input.now ?? defaultClock;

  const getStmt = db.prepare('SELECT record_json FROM workspace_surfaces WHERE id = ?');
  const upsertStmt = db.prepare(`
    INSERT INTO workspace_surfaces (
      id, node_id, workspace_id, root_id, repo_path, record_json, created_at, updated_at
    ) VALUES (
      @id, @nodeId, @workspaceId, @rootId, @repoPath, @recordJson, @createdAt, @updatedAt
    )
    ON CONFLICT(id) DO UPDATE SET
      node_id = excluded.node_id,
      workspace_id = excluded.workspace_id,
      root_id = excluded.root_id,
      repo_path = excluded.repo_path,
      record_json = excluded.record_json,
      updated_at = excluded.updated_at
  `);
  const countStmt = db.prepare('SELECT COUNT(*) AS n FROM workspace_surfaces');
  const trimStmt = db.prepare(`
    DELETE FROM workspace_surfaces WHERE id IN (
      SELECT id FROM workspace_surfaces ORDER BY updated_at ASC LIMIT @over
    )
  `);

  function parseRow(row: SurfaceRow | undefined): WorkspaceSurface | null {
    if (!row) return null;
    try {
      return JSON.parse(row.record_json) as WorkspaceSurface;
    } catch {
      return null;
    }
  }

  return {
    close() {
      db.close();
    },

    upsert(parsed) {
      const now = clock();
      const nodeId = parsed.nodeId ?? DEFAULT_LOCAL_NODE_ID;
      const id =
        parsed.id ??
        createWorkspaceSurfaceId(
          nodeId,
          parsed.rootId,
          `agent:${parsed.kind}:${parsed.label}`
        );
      const existing = parseRow(getStmt.get(id) as SurfaceRow | undefined);
      const record: WorkspaceSurface = {
        id,
        kind: parsed.kind,
        label: parsed.label,
        ...(parsed.description ? { description: parsed.description } : {}),
        ...(parsed.url ? { url: parsed.url } : {}),
        ...(parsed.command ? { command: parsed.command } : {}),
        ...(parsed.logRef ? { logRef: parsed.logRef } : {}),
        nodeId,
        ...(parsed.workspaceId ? { workspaceId: parsed.workspaceId } : {}),
        ...(parsed.rootId ? { rootId: parsed.rootId } : {}),
        ...(parsed.repoPath ? { repoPath: parsed.repoPath } : {}),
        status: 'published',
        health: parsed.health ?? 'unknown',
        provenance: {
          source: 'agent-published',
          ...(parsed.actor ? { actor: parsed.actor } : {}),
          ...(parsed.sessionId ? { sessionId: parsed.sessionId } : {}),
          ...(parsed.workContextId ? { workContextId: parsed.workContextId } : {}),
        },
        openMode: 'unavailable',
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      record.openMode = classifyOpenMode(record, DEFAULT_LOCAL_NODE_ID);
      upsertStmt.run({
        id: record.id,
        nodeId: record.nodeId,
        workspaceId: record.workspaceId ?? null,
        rootId: record.rootId ?? null,
        repoPath: record.repoPath ?? null,
        recordJson: JSON.stringify(record),
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      });
      const count = (countStmt.get() as { n: number }).n;
      if (count > WORKSPACE_SURFACES_MAX_PUBLISHED_ENTRIES) {
        trimStmt.run({ over: count - WORKSPACE_SURFACES_MAX_PUBLISHED_ENTRIES });
      }
      return record;
    },

    list(filter) {
      const clauses: string[] = [];
      const params: Record<string, unknown> = {};
      if (filter.rootId) {
        clauses.push('root_id = @rootId');
        params['rootId'] = filter.rootId;
      }
      if (filter.workspaceId) {
        clauses.push('workspace_id = @workspaceId');
        params['workspaceId'] = filter.workspaceId;
      }
      if (filter.repoPath) {
        clauses.push('repo_path = @repoPath');
        params['repoPath'] = filter.repoPath;
      }
      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
      const limit =
        filter.limit && filter.limit > 0
          ? Math.min(filter.limit, WORKSPACE_SURFACES_LIST_SENTINEL_LIMIT)
          : WORKSPACE_SURFACES_DEFAULT_LIST_ENTRIES;
      const rows = db
        .prepare(
          `SELECT record_json FROM workspace_surfaces ${where} ORDER BY updated_at DESC LIMIT @limit`
        )
        .all({ ...params, limit }) as SurfaceRow[];
      const out: WorkspaceSurface[] = [];
      for (const row of rows) {
        const record = parseRow(row);
        if (record) out.push(record);
      }
      return out;
    },

    get(id) {
      return parseRow(getStmt.get(id) as SurfaceRow | undefined);
    },
  };
}

export function initWorkspaceSurfaceStore(
  configDir: string,
  options?: { now?: () => string }
): WorkspaceSurfaceStore {
  return createWorkspaceSurfaceStore({
    dbPath: path.join(configDir, 'workspace-surfaces.db'),
    ...(options?.now ? { now: options.now } : {}),
  });
}

// ─── Router ──────────────────────────────────────────────────────────────────

function sendGatewayError(
  res: Response,
  code: RelayCliGatewayErrorCode,
  message: string,
  retryable = false,
  details?: Record<string, unknown>
): void {
  const status =
    code === 'NOT_FOUND'
      ? 404
      : code === 'FORBIDDEN'
        ? 403
        : code === 'SERVER_UNAVAILABLE'
          ? 503
          : code === 'INTERNAL'
            ? 500
            : 400;
  res.status(status).json({
    error: { code, message, retryable, ...(details ? { details } : {}) },
  });
}

function parseCapabilityHeader(value: string | undefined): Set<string> {
  if (!value) return new Set();
  return new Set(
    value
      .split(/[\s,]+/)
      .map((entry) => entry.trim())
      .filter(Boolean)
  );
}

function denyMissingCapability(req: Request, res: Response, required: string[]): boolean {
  const caps = parseCapabilityHeader(req.header('x-relay-capabilities'));
  const missing = required.filter((cap) => !caps.has(cap));
  if (missing.length === 0) return false;
  sendGatewayError(res, 'FORBIDDEN', `missing required capability: ${missing.join(', ')}`, false, {
    capability: missing[0],
  });
  return true;
}

function readQueryString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function bodyRecord(req: Request): Record<string, unknown> {
  return typeof req.body === 'object' && req.body !== null && !Array.isArray(req.body)
    ? (req.body as Record<string, unknown>)
    : {};
}

function readBodyString(req: Request, key: string): string | undefined {
  const value = bodyRecord(req)[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function workspaceSurfacePublishScopeFromRequest(
  req: Request
): { nodeIds?: string[]; workContextIds?: string[] } | undefined {
  const nodeId = readBodyString(req, 'nodeId');
  const workContextId = readBodyString(req, 'workContextId');
  if (!nodeId && !workContextId) return undefined;
  return {
    ...(nodeId ? { nodeIds: [nodeId] } : {}),
    ...(workContextId ? { workContextIds: [workContextId] } : {}),
  };
}

function bindPublishedSurfaceToActor(
  req: Request,
  res: Response,
  input: WorkspaceSurfacePublishInput
): WorkspaceSurfacePublishInput | null {
  const credential = authenticatedCliGatewayActorCredential(req);
  if (!credential) return input;

  const allowedNodeIds = credential.scope.nodeIds ?? [];
  const nodeId =
    input.nodeId ?? (allowedNodeIds.length === 1 ? allowedNodeIds[0] : undefined);
  if (!nodeId || !allowedNodeIds.includes(nodeId)) {
    sendGatewayError(
      res,
      'FORBIDDEN',
      'workspace surface actor publishes require a matching node-scoped credential',
      false,
      { reasonCode: 'WORKSPACE_SURFACE_NODE_SCOPE_REQUIRED' }
    );
    return null;
  }

  return {
    ...input,
    nodeId,
    actor: credential.actor.id,
  };
}

export interface WorkspaceSurfacesRouterOptions {
  store: WorkspaceSurfaceStore | null;
  getConfig?: () => Config;
  requireAuth?: RequestHandler;
  requireReadAuth?: RequestHandler;
  requireWriteActorAuth?: (
    expectedCommand: CliGatewayActorWriteCommand,
    options?: {
      scopeForRequest?: (req: Request) =>
        | { nodeIds?: string[]; workContextIds?: string[] }
        | undefined;
    }
  ) => RequestHandler;
}

export function createWorkspaceSurfacesRouter(
  options: WorkspaceSurfacesRouterOptions
): express.Router {
  const router = express.Router();
  const auth = options.requireAuth ?? ((_req, _res, next) => next());
  const readAuth = options.requireReadAuth ?? auth;
  const writeAuth =
    options.requireWriteActorAuth?.('workspace-surfaces.publish', {
      scopeForRequest: workspaceSurfacePublishScopeFromRequest,
    }) ?? auth;

  // List = static discovery (best-effort) merged with persisted agent-published
  // surfaces. Discovery never throws; a broken package.json yields no surfaces.
  router.get('/workspace-surfaces', readAuth, async (req, res) => {
    if (denyMissingCapability(req, res, [CONTEXT_READ])) return;
    const filter: WorkspaceSurfaceListFilter = {};
    const rootId = readQueryString(req.query['rootId']);
    if (rootId) filter.rootId = rootId;
    const workspaceId = readQueryString(req.query['workspaceId']);
    if (workspaceId) filter.workspaceId = workspaceId;
    const repoPath = readQueryString(req.query['repoPath']);
    if (repoPath) filter.repoPath = repoPath;

    let discovered: WorkspaceSurface[] = [];
    if (options.getConfig) {
      try {
        discovered = await discoverWorkspaceSurfaces(options.getConfig());
      } catch {
        discovered = [];
      }
      if (rootId) discovered = discovered.filter((s) => s.rootId === rootId);
      if (workspaceId) discovered = discovered.filter((s) => s.workspaceId === workspaceId);
      if (repoPath) discovered = discovered.filter((s) => s.repoPath === repoPath);
    }
    const published = options.store
      ? options.store.list({
          ...filter,
          limit: WORKSPACE_SURFACES_LIST_SENTINEL_LIMIT,
        })
      : [];
    const configured = discovered.filter(
      (surface) => surface.provenance.source === 'configured'
    );
    const staticDiscovered = discovered.filter(
      (surface) => surface.provenance.source !== 'configured'
    );
    // Agent-published/configured surfaces win on id collision and list priority
    // so a flood of inferred scripts cannot truncate intentional surfaces.
    const byId = new Map<string, WorkspaceSurface>();
    for (const surface of [...staticDiscovered, ...configured, ...published]) {
      byId.set(surface.id, surface);
    }
    const surfaces = Array.from(byId.values())
      .sort((a, b) => workspaceSurfacePriority(b) - workspaceSurfacePriority(a))
      .slice(0, WORKSPACE_SURFACES_MAX_LIST_ENTRIES);
    res.json({
      surfaces,
      truncated:
        byId.size > surfaces.length ||
        published.length > WORKSPACE_SURFACES_MAX_LIST_ENTRIES,
    });
  });

  router.post('/workspace-surfaces', writeAuth, (req, res) => {
    if (denyMissingCapability(req, res, [CONTEXT_WRITE])) return;
    if (!options.store) {
      sendGatewayError(res, 'SERVER_UNAVAILABLE', 'workspace surface store is unavailable', true, {
        reasonCode: 'WORKSPACE_SURFACE_STORE_UNAVAILABLE',
      });
      return;
    }
    try {
      const input = parseWorkspaceSurfacePublishInput(req.body);
      const actorBoundInput = bindPublishedSurfaceToActor(req, res, input);
      if (!actorBoundInput) return;
      const surface = options.store.upsert(actorBoundInput);
      res.status(201).json({ surface });
    } catch (error) {
      if (error instanceof WorkspaceSurfaceValidationError) {
        sendGatewayError(res, 'INVALID_ARGUMENT', error.message, false, {
          reasonCode: 'WORKSPACE_SURFACE_VALIDATION_FAILED',
          ...error.details,
        });
        return;
      }
      sendGatewayError(res, 'INTERNAL', 'workspace surface publish failed', true);
    }
  });

  return router;
}
