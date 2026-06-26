import Database from 'better-sqlite3';
import * as path from 'node:path';
import express, {
  type Request,
  type RequestHandler,
  type Response,
} from 'express';

import type { RelayCliGatewayErrorCode } from '../shared/cli-gateway-contract.js';
import type { Config } from './types.js';
import type { WorkContextStore } from './work-contexts.js';
import type { WorkContext } from '../shared/work-context.js';
import {
  WORKSPACE_TOPICS_MAX_LIST_ENTRIES,
  WORKSPACE_TOPIC_MUTATION_POLICIES,
  WorkspaceTopicValidationError,
  applyWorkspaceTopicUpdate,
  archiveWorkspaceTopicRecord,
  assertWorkspaceTopicId,
  buildWorkspaceTopicRecord,
  createWorkspaceTopicId,
  parseWorkspaceTopicCreateInput,
  parseWorkspaceTopicUpdateInput,
  type WorkspaceTopic,
  type WorkspaceTopicCreateInput,
  type WorkspaceTopicListResponse,
  type WorkspaceTopicMutationKind,
  type WorkspaceTopicUpdateInput,
  type WorkspaceTopicValidationOptions,
} from '../shared/workspace-topics.js';
import {
  discoverWorkspaceSurfaces,
  type WorkspaceSurfaceStore,
} from './workspace-surfaces.js';
import type { CliGatewayActorWriteCommand } from './cli-gateway-actor-auth.js';

const CONTEXT_READ = 'context:read';
const CONTEXT_WRITE = 'context:write';
const WORKSPACE_TOPICS_LIST_SENTINEL_LIMIT =
  WORKSPACE_TOPICS_MAX_LIST_ENTRIES + 1;
const WORKSPACE_TOPICS_MAX_STORED_ENTRIES = 500;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS workspace_topics (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  status       TEXT NOT NULL,
  record_json  TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_workspace_topics_workspace
  ON workspace_topics(workspace_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_workspace_topics_updated
  ON workspace_topics(updated_at DESC);
`;

interface TopicRow {
  record_json: string;
}

class WorkspaceTopicStoreError extends Error {
  constructor(
    message: string,
    readonly reasonCode: string,
    readonly details: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = 'WorkspaceTopicStoreError';
  }
}

export interface WorkspaceTopicListFilter {
  workspaceId?: string;
  includeArchived?: boolean;
  limit?: number;
}

export interface WorkspaceTopicStore {
  close(): void;
  create(input: WorkspaceTopicCreateInput): WorkspaceTopic;
  update(id: string, patch: WorkspaceTopicUpdateInput): WorkspaceTopic | null;
  archive(id: string): WorkspaceTopic | null;
  get(id: string): WorkspaceTopic | null;
  list(filter?: WorkspaceTopicListFilter): WorkspaceTopic[];
}

function defaultClock(): string {
  return new Date().toISOString();
}

export function createWorkspaceTopicStore(input: {
  dbPath: string;
  now?: () => string;
}): WorkspaceTopicStore {
  const db = new Database(input.dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA_SQL);
  const clock = input.now ?? defaultClock;

  const getStmt = db.prepare(
    'SELECT record_json FROM workspace_topics WHERE id = ?'
  );
  const countStmt = db.prepare('SELECT COUNT(*) AS n FROM workspace_topics');
  const trimStmt = db.prepare(`
    DELETE FROM workspace_topics
    WHERE id IN (
      SELECT id FROM workspace_topics
      ORDER BY updated_at ASC, created_at ASC
      LIMIT @over
    )
  `);
  const upsertStmt = db.prepare(`
    INSERT INTO workspace_topics (
      id, workspace_id, status, record_json, created_at, updated_at
    ) VALUES (
      @id, @workspaceId, @status, @recordJson, @createdAt, @updatedAt
    )
    ON CONFLICT(id) DO UPDATE SET
      workspace_id = excluded.workspace_id,
      status = excluded.status,
      record_json = excluded.record_json,
      updated_at = excluded.updated_at
  `);

  function parseRow(row: TopicRow | undefined): WorkspaceTopic | null {
    if (!row) return null;
    try {
      return JSON.parse(row.record_json) as WorkspaceTopic;
    } catch {
      return null;
    }
  }

  function persist(topic: WorkspaceTopic): WorkspaceTopic {
    upsertStmt.run({
      id: topic.id,
      workspaceId: topic.workspaceId,
      status: topic.status,
      recordJson: JSON.stringify(topic),
      createdAt: topic.createdAt,
      updatedAt: topic.updatedAt,
    });
    const count = (countStmt.get() as { n: number }).n;
    if (count > WORKSPACE_TOPICS_MAX_STORED_ENTRIES) {
      trimStmt.run({ over: count - WORKSPACE_TOPICS_MAX_STORED_ENTRIES });
    }
    return topic;
  }

  return {
    close() {
      db.close();
    },

    create(createInput) {
      const topic = buildWorkspaceTopicRecord({
        create: createInput,
        now: clock(),
      });
      if (getStmt.get(topic.id)) {
        throw new WorkspaceTopicStoreError(
          'workspace topic already exists',
          'WORKSPACE_TOPIC_ALREADY_EXISTS',
          { id: topic.id }
        );
      }
      return persist(topic);
    },

    update(id, patchInput) {
      const existing = parseRow(getStmt.get(id) as TopicRow | undefined);
      if (!existing) return null;
      return persist(
        applyWorkspaceTopicUpdate({
          topic: existing,
          patch: patchInput,
          now: clock(),
        })
      );
    },

    archive(id) {
      const existing = parseRow(getStmt.get(id) as TopicRow | undefined);
      if (!existing) return null;
      return persist(archiveWorkspaceTopicRecord(existing, clock()));
    },

    get(id) {
      return parseRow(getStmt.get(id) as TopicRow | undefined);
    },

    list(filter = {}) {
      const clauses: string[] = [];
      const params: Record<string, unknown> = {};
      if (filter.workspaceId) {
        clauses.push('workspace_id = @workspaceId');
        params['workspaceId'] = filter.workspaceId;
      }
      if (!filter.includeArchived) {
        clauses.push("status != 'archived'");
      }
      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
      const limit =
        filter.limit && filter.limit > 0
          ? Math.min(filter.limit, WORKSPACE_TOPICS_LIST_SENTINEL_LIMIT)
          : WORKSPACE_TOPICS_MAX_LIST_ENTRIES;
      const rows = db
        .prepare(
          `SELECT record_json FROM workspace_topics ${where} ORDER BY updated_at DESC LIMIT @limit`
        )
        .all({ ...params, limit }) as TopicRow[];
      return rows
        .map((row) => parseRow(row))
        .filter((topic): topic is WorkspaceTopic => Boolean(topic));
    },
  };
}

export function initWorkspaceTopicStore(
  configDir: string,
  options?: { now?: () => string }
): WorkspaceTopicStore {
  return createWorkspaceTopicStore({
    dbPath: path.join(configDir, 'workspace-topics.db'),
    ...(options?.now ? { now: options.now } : {}),
  });
}

export function deriveWorkspaceTopicsFromWorkContexts(
  contexts: WorkContext[],
  now = defaultClock()
): WorkspaceTopic[] {
  return contexts
    .slice(0, WORKSPACE_TOPICS_MAX_LIST_ENTRIES)
    .map((context, index) => {
      const workspaceId = context.anchors.project?.workspaceId ?? 'ws:derived';
      const session = context.anchors.session;
      const repo = context.anchors.repo;
      const worktree = context.anchors.worktree;
      const artifactIds = context.artifacts.map((artifact) => artifact.id);
      const topic: WorkspaceTopic = {
        schemaVersion: 1,
        id: createWorkspaceTopicId(`derived-${context.id}`),
        workspaceId,
        source: 'derived',
        status: 'active',
        visibility: 'default',
        display: { title: context.title ?? context.id },
        grouping: { order: index },
        promptDefaults: {},
        routingDefaults: {
          ...(session?.agent ? { providerId: session.agent } : {}),
          ...(session?.nodeId ? { nodeId: session.nodeId } : {}),
          ...(repo?.localPath ? { repoPath: repo.localPath } : {}),
          ...(worktree?.localPath ? { worktreePath: worktree.localPath } : {}),
          ...(session?.cwd ? { cwd: session.cwd } : {}),
        },
        linkedRefs: {
          workContextIds: [context.id],
          ...(session?.sessionId ? { sessionIds: [session.sessionId] } : {}),
          ...(context.tasks.length ? { taskRefs: context.tasks } : {}),
          ...(artifactIds.length ? { artifactIds } : {}),
        },
        state: { pinned: false, muted: false },
        privacy: {
          classification: 'internal',
          retention: 'project',
          redaction: 'summary',
          rawDefaultsStored: false,
        },
        createdAt: context.createdAt,
        updatedAt: context.updatedAt || now,
      };
      return topic;
    });
}

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

function denyMissingCapability(
  req: Request,
  res: Response,
  required: string[]
): boolean {
  const caps = parseCapabilityHeader(req.header('x-relay-capabilities'));
  const missing = required.filter((cap) => !caps.has(cap));
  if (missing.length === 0) return false;
  sendGatewayError(
    res,
    'FORBIDDEN',
    `missing required capability: ${missing.join(', ')}`,
    false,
    {
      capability: missing[0],
    }
  );
  return true;
}

function bodyRecord(req: Request): Record<string, unknown> {
  return typeof req.body === 'object' &&
    req.body !== null &&
    !Array.isArray(req.body)
    ? (req.body as Record<string, unknown>)
    : {};
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readBooleanQuery(value: unknown): boolean {
  return value === 'true' || value === '1' || value === true;
}

function topicWorkContextScopeFromBody(
  req: Request
): { workContextIds?: string[] } | undefined {
  const body = bodyRecord(req);
  const linkedRefs =
    typeof body['linkedRefs'] === 'object' &&
    body['linkedRefs'] !== null &&
    !Array.isArray(body['linkedRefs'])
      ? (body['linkedRefs'] as Record<string, unknown>)
      : {};
  const raw = linkedRefs['workContextIds'];
  const ids = Array.isArray(raw)
    ? raw.filter(
        (value): value is string =>
          typeof value === 'string' && value.trim().length > 0
      )
    : [];
  return ids.length ? { workContextIds: ids } : undefined;
}

function workspaceSurfaceIdsFromBody(req: Request): string[] {
  const body = bodyRecord(req);
  const linkedRefs =
    typeof body['linkedRefs'] === 'object' &&
    body['linkedRefs'] !== null &&
    !Array.isArray(body['linkedRefs'])
      ? (body['linkedRefs'] as Record<string, unknown>)
      : {};
  const raw = linkedRefs['workspaceSurfaceIds'];
  return Array.isArray(raw)
    ? raw.filter(
        (value): value is string =>
          typeof value === 'string' && value.trim().length > 0
      )
    : [];
}

async function validationOptions(input: {
  config?: Config | undefined;
  surfaceStore?: WorkspaceSurfaceStore | null | undefined;
  workspaceSurfaceIds?: readonly string[] | undefined;
}): Promise<WorkspaceTopicValidationOptions> {
  const knownRepoPaths = input.config?.repos ?? [];
  const knownWorkspaceSurfaceIds = new Set<string>();
  const shouldValidateWorkspaceSurfaceIds = Boolean(
    input.workspaceSurfaceIds?.length
  );
  if (shouldValidateWorkspaceSurfaceIds && input.surfaceStore) {
    for (const surface of input.surfaceStore.list({
      limit: WORKSPACE_TOPICS_LIST_SENTINEL_LIMIT,
    })) {
      knownWorkspaceSurfaceIds.add(surface.id);
    }
  }
  if (shouldValidateWorkspaceSurfaceIds && input.config) {
    try {
      for (const surface of await discoverWorkspaceSurfaces(input.config)) {
        knownWorkspaceSurfaceIds.add(surface.id);
      }
    } catch {
      // Surface discovery is advisory for validation; a broken config should not
      // turn every topic write into a 500.
    }
  }
  return {
    ...(knownRepoPaths.length ? { knownRepoPaths } : {}),
    ...(knownWorkspaceSurfaceIds.size
      ? { knownWorkspaceSurfaceIds: Array.from(knownWorkspaceSurfaceIds) }
      : {}),
  };
}

function fallbackTopics(input: {
  workContextStore?: WorkContextStore | undefined;
  workspaceId?: string | undefined;
}): WorkspaceTopic[] {
  const topics = deriveWorkspaceTopicsFromWorkContexts(
    input.workContextStore?.list({
      limit: WORKSPACE_TOPICS_LIST_SENTINEL_LIMIT,
    }) ?? []
  );
  return input.workspaceId
    ? topics.filter((topic) => topic.workspaceId === input.workspaceId)
    : topics;
}

function mutationPolicy(kind: WorkspaceTopicMutationKind) {
  return WORKSPACE_TOPIC_MUTATION_POLICIES[kind];
}

export interface WorkspaceTopicsRouterOptions {
  store: WorkspaceTopicStore | null;
  surfaceStore?: WorkspaceSurfaceStore | null;
  workContextStore?: WorkContextStore;
  getConfig?: () => Config;
  requireAuth?: RequestHandler;
  requireReadAuth?: RequestHandler;
  requireWriteActorAuth?: (
    expectedCommand: CliGatewayActorWriteCommand,
    options?: {
      scopeForRequest?: (
        req: Request
      ) => { workContextIds?: string[] } | undefined;
    }
  ) => RequestHandler;
}

export function createWorkspaceTopicsRouter(
  options: WorkspaceTopicsRouterOptions
): express.Router {
  const router = express.Router();
  const auth = options.requireAuth ?? ((_req, _res, next) => next());
  const readAuth = options.requireReadAuth ?? auth;
  const writeAuth = (command: CliGatewayActorWriteCommand): RequestHandler =>
    options.requireWriteActorAuth?.(command, {
      scopeForRequest: topicWorkContextScopeFromBody,
    }) ?? auth;

  router.get('/workspace-topics', readAuth, (req, res) => {
    if (denyMissingCapability(req, res, [CONTEXT_READ])) return;
    const workspaceId = readString(req.query['workspaceId']);
    const includeArchived = readBooleanQuery(req.query['includeArchived']);
    const persisted = options.store
      ? options.store.list({
          ...(workspaceId ? { workspaceId } : {}),
          includeArchived,
          limit: WORKSPACE_TOPICS_LIST_SENTINEL_LIMIT,
        })
      : [];
    const derived = persisted.length === 0;
    const allTopics = derived
      ? fallbackTopics({
          workContextStore: options.workContextStore,
          workspaceId,
        })
      : persisted;
    const topics = allTopics.slice(0, WORKSPACE_TOPICS_MAX_LIST_ENTRIES);
    const body: WorkspaceTopicListResponse = {
      topics,
      truncated:
        allTopics.length > topics.length ||
        persisted.length > WORKSPACE_TOPICS_MAX_LIST_ENTRIES,
      derived,
    };
    res.json(body);
  });

  router.get('/workspace-topics/:id', readAuth, (req, res) => {
    if (denyMissingCapability(req, res, [CONTEXT_READ])) return;
    const id = req.params['id'] ?? '';
    try {
      assertWorkspaceTopicId(id);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'invalid workspace topic id';
      sendGatewayError(res, 'INVALID_ARGUMENT', message, false, {
        field: 'id',
      });
      return;
    }
    const topic =
      options.store?.get(id) ??
      fallbackTopics({ workContextStore: options.workContextStore }).find(
        (candidate) => candidate.id === id
      ) ??
      null;
    if (!topic) {
      sendGatewayError(res, 'NOT_FOUND', 'workspace topic not found', false, {
        id,
      });
      return;
    }
    res.json({ topic });
  });

  router.post(
    '/workspace-topics',
    writeAuth('workspace-topics.create'),
    async (req, res) => {
      if (denyMissingCapability(req, res, [CONTEXT_WRITE])) return;
      if (!options.store) {
        sendGatewayError(
          res,
          'SERVER_UNAVAILABLE',
          'workspace topic store is unavailable',
          true,
          {
            reasonCode: 'WORKSPACE_TOPIC_STORE_UNAVAILABLE',
          }
        );
        return;
      }
      try {
        const parsed = parseWorkspaceTopicCreateInput(
          req.body,
          await validationOptions({
            config: options.getConfig?.(),
            surfaceStore: options.surfaceStore,
            workspaceSurfaceIds: workspaceSurfaceIdsFromBody(req),
          })
        );
        const topic = options.store.create(parsed);
        res
          .status(201)
          .json({ topic, mutationPolicy: mutationPolicy('create') });
      } catch (error) {
        if (error instanceof WorkspaceTopicValidationError) {
          sendGatewayError(res, 'INVALID_ARGUMENT', error.message, false, {
            reasonCode: 'WORKSPACE_TOPIC_VALIDATION_FAILED',
            ...error.details,
          });
          return;
        }
        if (error instanceof WorkspaceTopicStoreError) {
          sendGatewayError(res, 'SESSION_CONFLICT', error.message, false, {
            reasonCode: error.reasonCode,
            ...error.details,
          });
          return;
        }
        sendGatewayError(
          res,
          'INTERNAL',
          'workspace topic create failed',
          true
        );
      }
    }
  );

  router.patch(
    '/workspace-topics/:id',
    writeAuth('workspace-topics.update'),
    async (req, res) => {
      if (denyMissingCapability(req, res, [CONTEXT_WRITE])) return;
      if (!options.store) {
        sendGatewayError(
          res,
          'SERVER_UNAVAILABLE',
          'workspace topic store is unavailable',
          true,
          {
            reasonCode: 'WORKSPACE_TOPIC_STORE_UNAVAILABLE',
          }
        );
        return;
      }
      const id = req.params['id'] ?? '';
      try {
        assertWorkspaceTopicId(id);
        const parsed = parseWorkspaceTopicUpdateInput(
          req.body,
          await validationOptions({
            config: options.getConfig?.(),
            surfaceStore: options.surfaceStore,
            workspaceSurfaceIds: workspaceSurfaceIdsFromBody(req),
          })
        );
        const topic = options.store.update(id, parsed);
        if (!topic) {
          sendGatewayError(
            res,
            'NOT_FOUND',
            'workspace topic not found',
            false,
            { id }
          );
          return;
        }
        res.json({ topic, mutationPolicy: mutationPolicy('update') });
      } catch (error) {
        if (error instanceof WorkspaceTopicValidationError) {
          sendGatewayError(res, 'INVALID_ARGUMENT', error.message, false, {
            reasonCode: 'WORKSPACE_TOPIC_VALIDATION_FAILED',
            ...error.details,
          });
          return;
        }
        sendGatewayError(
          res,
          'INTERNAL',
          'workspace topic update failed',
          true
        );
      }
    }
  );

  router.post(
    '/workspace-topics/:id/archive',
    writeAuth('workspace-topics.archive'),
    (req, res) => {
      if (denyMissingCapability(req, res, [CONTEXT_WRITE])) return;
      if (!options.store) {
        sendGatewayError(
          res,
          'SERVER_UNAVAILABLE',
          'workspace topic store is unavailable',
          true,
          {
            reasonCode: 'WORKSPACE_TOPIC_STORE_UNAVAILABLE',
          }
        );
        return;
      }
      const id = req.params['id'] ?? '';
      try {
        assertWorkspaceTopicId(id);
        const topic = options.store.archive(id);
        if (!topic) {
          sendGatewayError(
            res,
            'NOT_FOUND',
            'workspace topic not found',
            false,
            { id }
          );
          return;
        }
        res.json({ topic, mutationPolicy: mutationPolicy('archive') });
      } catch (error) {
        if (error instanceof WorkspaceTopicValidationError) {
          sendGatewayError(res, 'INVALID_ARGUMENT', error.message, false, {
            reasonCode: 'WORKSPACE_TOPIC_VALIDATION_FAILED',
            ...error.details,
          });
          return;
        }
        sendGatewayError(
          res,
          'INTERNAL',
          'workspace topic archive failed',
          true
        );
      }
    }
  );

  return router;
}
