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
  WORKSPACE_TOPICS_SEARCH_DEFAULT_LIMIT,
  WORKSPACE_TOPICS_SEARCH_MAX_RESULTS,
  WORKSPACE_TOPICS_SEARCH_QUERY_MAX,
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
  type WorkspaceTopicSearchFreshness,
  type WorkspaceTopicSearchMatch,
  type WorkspaceTopicSearchResponse,
  type WorkspaceTopicSearchResult,
  type WorkspaceTopicUpdateInput,
  type WorkspaceTopicValidationOptions,
} from '../shared/workspace-topics.js';
import {
  discoverWorkspaceSurfaces,
  type WorkspaceSurfaceStore,
} from './workspace-surfaces.js';
import type { WorkspaceSurface } from '../shared/workspace-surfaces.js';
import type {
  CliGatewayActorReadCommand,
  CliGatewayActorWriteCommand,
} from './cli-gateway-actor-auth.js';

const CONTEXT_READ = 'context:read';
const CONTEXT_WRITE = 'context:write';
const WORKSPACE_TOPICS_LIST_SENTINEL_LIMIT =
  WORKSPACE_TOPICS_MAX_LIST_ENTRIES + 1;
export const WORKSPACE_TOPICS_MAX_STORED_ENTRIES = 500;

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
  const trimArchivedStmt = db.prepare(`
    DELETE FROM workspace_topics
    WHERE id IN (
      SELECT id FROM workspace_topics
      WHERE status = 'archived'
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

  function storedCount(): number {
    return (countStmt.get() as { n: number }).n;
  }

  function trimArchivedOverCap(): number {
    const count = storedCount();
    if (count <= WORKSPACE_TOPICS_MAX_STORED_ENTRIES) return count;
    trimArchivedStmt.run({ over: count - WORKSPACE_TOPICS_MAX_STORED_ENTRIES });
    return storedCount();
  }

  function trimArchivedForNewTopic(): number {
    const count = storedCount();
    if (count < WORKSPACE_TOPICS_MAX_STORED_ENTRIES) return count;
    trimArchivedStmt.run({
      over: count - WORKSPACE_TOPICS_MAX_STORED_ENTRIES + 1,
    });
    return storedCount();
  }

  function assertCapacityForNewTopic(): void {
    if (storedCount() < WORKSPACE_TOPICS_MAX_STORED_ENTRIES) return;
    if (trimArchivedForNewTopic() < WORKSPACE_TOPICS_MAX_STORED_ENTRIES) return;
    throw new WorkspaceTopicStoreError(
      'workspace topic store is full',
      'WORKSPACE_TOPIC_STORE_FULL',
      { max: WORKSPACE_TOPICS_MAX_STORED_ENTRIES }
    );
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
    trimArchivedOverCap();
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
      assertCapacityForNewTopic();
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
    .slice(0, WORKSPACE_TOPICS_LIST_SENTINEL_LIMIT)
    .map((context, index) => {
      const workspaceId = context.anchors.project?.workspaceId ?? 'ws:derived';
      const session = context.anchors.session;
      const repo = context.anchors.repo;
      const worktree = context.anchors.worktree;
      const artifactIds = context.artifacts.map((artifact) => artifact.id);
      const topic: WorkspaceTopic = {
        schemaVersion: 1,
        id: createWorkspaceTopicId(`derived-${context.id}`, workspaceId),
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

function topicWorkContextScopeFromTopic(
  topic: WorkspaceTopic | null | undefined
): { workContextIds?: string[] } | undefined {
  const ids = topic?.linkedRefs.workContextIds?.filter(
    (value): value is string =>
      typeof value === 'string' && value.trim().length > 0
  );
  return ids?.length ? { workContextIds: ids } : undefined;
}

function mergeTopicWorkContextScopes(
  ...scopes: Array<{ workContextIds?: string[] } | undefined>
): { workContextIds?: string[] } | undefined {
  const ids = Array.from(
    new Set(
      scopes.flatMap(
        (scope) =>
          scope?.workContextIds?.filter(
            (value): value is string =>
              typeof value === 'string' && value.trim().length > 0
          ) ?? []
      )
    )
  );
  return ids.length ? { workContextIds: ids } : undefined;
}

function topicWorkContextScopeFromPersistedTopic(input: {
  store: WorkspaceTopicStore | null;
  req: Request;
}): { workContextIds?: string[] } | undefined {
  const id = input.req.params['id'] ?? '';
  try {
    assertWorkspaceTopicId(id);
  } catch {
    return undefined;
  }
  return topicWorkContextScopeFromTopic(input.store?.get(id));
}

function topicWorkContextScopeFromUpdate(input: {
  store: WorkspaceTopicStore | null;
  req: Request;
}): { workContextIds?: string[] } | undefined {
  return mergeTopicWorkContextScopes(
    topicWorkContextScopeFromPersistedTopic(input),
    topicWorkContextScopeFromBody(input.req)
  );
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
  const contexts =
    input.workContextStore?.list({
      ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
      limit: WORKSPACE_TOPICS_LIST_SENTINEL_LIMIT,
    }) ?? [];
  return deriveWorkspaceTopicsFromWorkContexts(
    contexts.slice(0, WORKSPACE_TOPICS_LIST_SENTINEL_LIMIT)
  );
}

function readPositiveIntQuery(
  value: unknown,
  fallback: number,
  max: number
): number {
  if (typeof value !== 'string' || value.trim() === '') return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), max);
}

function readStringListQuery(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : value === undefined ? [] : [value];
  return Array.from(
    new Set(
      raw
        .flatMap((entry) =>
          typeof entry === 'string' ? entry.split(/[\s,]+/) : []
        )
        .map((entry) => entry.trim())
        .filter(Boolean)
    )
  );
}

function topicSearchScopeFromQuery(
  req: Request
): { workContextIds?: string[] } | undefined {
  const ids = readStringListQuery(
    req.query['workContextId'] ?? req.query['workContextIds']
  );
  return ids.length ? { workContextIds: ids } : undefined;
}

function normalizedText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[#/_\\:.-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function matchScore(value: string, query: string): number {
  const raw = value.toLowerCase();
  const normalized = normalizedText(value);
  const q = query.toLowerCase().trim();
  const qNoHash = q.startsWith('#') ? q.slice(1) : q;
  const normalizedQuery = normalizedText(qNoHash || q);
  if (!q) return 0;
  if (!normalizedQuery) return 0;
  if (raw === q || (qNoHash && raw === qNoHash)) return 100;
  if (normalized === normalizedQuery) return 95;
  if (raw.startsWith(q) || (qNoHash && raw.startsWith(qNoHash))) return 80;
  if (normalized.startsWith(normalizedQuery)) return 75;
  if (raw.includes(q) || (qNoHash && raw.includes(qNoHash))) return 60;
  if (normalized.includes(normalizedQuery)) return 55;
  return 0;
}

function pushSearchMatch(
  matches: WorkspaceTopicSearchMatch[],
  candidate: WorkspaceTopicSearchMatch
): void {
  if (!candidate.value.trim()) return;
  const key = `${candidate.kind}:${candidate.field}:${candidate.value}`;
  if (
    matches.some(
      (entry) => `${entry.kind}:${entry.field}:${entry.value}` === key
    )
  ) {
    return;
  }
  matches.push(candidate);
}

function basenameForSearch(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.replace(/[\\/]+$/, '');
  return trimmed.split(/[\\/]/).pop() || trimmed;
}

function workContextIdsForTopic(topic: WorkspaceTopic): string[] {
  return topic.linkedRefs.workContextIds?.filter(Boolean) ?? [];
}

function topicIntersectsScope(
  topic: WorkspaceTopic,
  scopeIds: readonly string[]
): boolean {
  if (scopeIds.length === 0) return true;
  const topicIds = new Set(workContextIdsForTopic(topic));
  return scopeIds.some((id) => topicIds.has(id));
}

function surfaceMatchesTopicForSearch(
  topic: WorkspaceTopic,
  surface: WorkspaceSurface
): boolean {
  if (topic.linkedRefs.workspaceSurfaceIds?.includes(surface.id)) return true;
  if (surface.workspaceId && surface.workspaceId === topic.workspaceId)
    return true;
  if (
    topic.routingDefaults.repoPath &&
    surface.repoPath === topic.routingDefaults.repoPath
  ) {
    return true;
  }
  return false;
}

function includeArtifactText(
  context: WorkContext,
  artifactId: string
): boolean {
  const artifact = context.artifacts.find((entry) => entry.id === artifactId);
  if (!artifact) return true;
  if (artifact.privacy.classification === 'secret') return false;
  if (artifact.privacy.rawPayloadStored) return false;
  if (artifact.kind === 'transcript-ref') return false;
  return !artifact.privacy.redaction.classes.some(
    (entry) =>
      entry === 'secret' ||
      entry === 'credential' ||
      entry === 'transcript' ||
      entry === 'payload'
  );
}

async function collectSearchSurfaces(input: {
  config?: Config | undefined;
  surfaceStore?: WorkspaceSurfaceStore | null | undefined;
}): Promise<WorkspaceSurface[]> {
  const surfaces: WorkspaceSurface[] = [];
  const seen = new Set<string>();
  for (const surface of input.surfaceStore?.list({
    limit: WORKSPACE_TOPICS_LIST_SENTINEL_LIMIT,
  }) ?? []) {
    if (!seen.has(surface.id)) {
      seen.add(surface.id);
      surfaces.push(surface);
    }
  }
  if (input.config) {
    try {
      for (const surface of await discoverWorkspaceSurfaces(input.config)) {
        if (!seen.has(surface.id)) {
          seen.add(surface.id);
          surfaces.push(surface);
        }
      }
    } catch {
      // Discovery is advisory; stored topics and persisted surfaces still search.
    }
  }
  return surfaces;
}

function collectSearchTopics(input: {
  store: WorkspaceTopicStore | null;
  workContextStore?: WorkContextStore | undefined;
  workspaceId?: string | undefined;
  includeArchived: boolean;
}): { topics: WorkspaceTopic[]; derived: boolean } {
  const seen = new Set<string>();
  const topics: WorkspaceTopic[] = [];
  const persisted = input.store
    ? input.store.list({
        ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
        includeArchived: input.includeArchived,
        limit: WORKSPACE_TOPICS_LIST_SENTINEL_LIMIT,
      })
    : [];
  for (const topic of persisted) {
    seen.add(topic.id);
    topics.push(topic);
  }
  for (const topic of fallbackTopics({
    workContextStore: input.workContextStore,
    workspaceId: input.workspaceId,
  })) {
    if (!seen.has(topic.id)) {
      seen.add(topic.id);
      topics.push(topic);
    }
  }
  return { topics, derived: persisted.length === 0 };
}

function searchableContexts(input: {
  workContextStore?: WorkContextStore | undefined;
  workspaceId?: string | undefined;
}): WorkContext[] {
  return (
    input.workContextStore?.list({
      ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
      limit: WORKSPACE_TOPICS_LIST_SENTINEL_LIMIT,
    }) ?? []
  );
}

interface SearchAccumulator {
  matches: WorkspaceTopicSearchMatch[];
  score: number;
}

function addSearchCandidate(
  accumulator: SearchAccumulator,
  query: string,
  kind: WorkspaceTopicSearchMatch['kind'],
  field: string,
  label: string,
  value: string | undefined,
  weight = 1
): void {
  if (!value) return;
  const candidateScore = matchScore(value, query) * weight;
  if (candidateScore <= 0) return;
  accumulator.score += candidateScore;
  pushSearchMatch(accumulator.matches, { kind, field, label, value });
}

function addTopicFieldMatches(
  accumulator: SearchAccumulator,
  query: string,
  topic: WorkspaceTopic
): void {
  const add = addSearchCandidate.bind(null, accumulator, query);
  add('topic', 'display.title', 'topic title', topic.display.title, 1.4);
  add(
    'phrase',
    'display.description',
    'topic brief',
    topic.display.description,
    1.1
  );
  add('topic', 'id', 'topic id', topic.id);
  add('workspace', 'workspaceId', 'workspace', topic.workspaceId);
  add(
    'agent',
    'routingDefaults.providerId',
    'provider',
    topic.routingDefaults.providerId,
    1.2
  );
  add(
    'agent',
    'routingDefaults.agentId',
    'agent',
    topic.routingDefaults.agentId,
    1.2
  );
  add(
    'session',
    'routingDefaults.nodeId',
    'node',
    topic.routingDefaults.nodeId
  );
}

function addTopicPathMatches(
  accumulator: SearchAccumulator,
  query: string,
  topic: WorkspaceTopic
): void {
  const add = addSearchCandidate.bind(null, accumulator, query);
  for (const [field, value] of [
    ['routingDefaults.repoPath', topic.routingDefaults.repoPath],
    ['routingDefaults.worktreePath', topic.routingDefaults.worktreePath],
    ['routingDefaults.cwd', topic.routingDefaults.cwd],
  ] as const) {
    const kind = field.includes('worktree') ? 'worktree' : 'repo';
    const name = field.split('.').pop() ?? field;
    add(kind, field, name, value, 1.1);
    add(
      kind,
      `${field}.basename`,
      `${name} name`,
      basenameForSearch(value),
      1.3
    );
  }
}

function addTopicRefMatches(
  accumulator: SearchAccumulator,
  query: string,
  topic: WorkspaceTopic
): void {
  const add = addSearchCandidate.bind(null, accumulator, query);
  for (const task of topic.linkedRefs.taskRefs ?? []) {
    add('task', 'linkedRefs.taskRefs.id', `${task.kind} ref`, task.id, 1.5);
    add(
      'task',
      'linkedRefs.taskRefs.idHash',
      `${task.kind} ref`,
      `#${task.id}`,
      1.5
    );
    add('task', 'linkedRefs.taskRefs.title', 'task title', task.title, 1.2);
    add('task', 'linkedRefs.taskRefs.url', 'task url', task.url);
    add('task', 'linkedRefs.taskRefs.status', 'task status', task.status);
  }
  for (const sessionId of topic.linkedRefs.sessionIds ?? []) {
    add('session', 'linkedRefs.sessionIds', 'linked session', sessionId, 1.1);
  }
  for (const artifactId of topic.linkedRefs.artifactIds ?? []) {
    add('artifact', 'linkedRefs.artifactIds', 'artifact ref', artifactId, 1.1);
  }
}

function linkedContextsForTopic(
  topic: WorkspaceTopic,
  contexts: readonly WorkContext[],
  scopeWorkContextIds: readonly string[] = []
): WorkContext[] {
  const linkedContextIds = new Set(workContextIdsForTopic(topic));
  const scopedIds = new Set(scopeWorkContextIds);
  return contexts.filter(
    (context) =>
      linkedContextIds.has(context.id) &&
      (scopedIds.size === 0 || scopedIds.has(context.id))
  );
}

function addContextAnchorMatches(
  accumulator: SearchAccumulator,
  query: string,
  context: WorkContext
): void {
  const add = addSearchCandidate.bind(null, accumulator, query);
  add('phrase', 'workContext.title', 'work context', context.title, 1.2);
  add('workspace', 'workContext.id', 'work context id', context.id);
  add(
    'session',
    'workContext.session.id',
    'session',
    context.anchors.session?.sessionId
  );
  add(
    'session',
    'workContext.session.globalId',
    'global session',
    context.anchors.session?.globalSessionId
  );
  add(
    'agent',
    'workContext.session.agent',
    'session agent',
    context.anchors.session?.agent,
    1.2
  );
  add(
    'repo',
    'workContext.repo.ownerRepo',
    'repo',
    context.anchors.repo?.ownerRepo,
    1.2
  );
  add(
    'repo',
    'workContext.repo.localPath',
    'repo path',
    context.anchors.repo?.localPath
  );
  add(
    'worktree',
    'workContext.worktree.localPath',
    'worktree path',
    context.anchors.worktree?.localPath
  );
  add(
    'worktree',
    'workContext.worktree.branchName',
    'worktree branch',
    context.anchors.worktree?.branchName
  );
}

function addContextChildMatches(
  accumulator: SearchAccumulator,
  query: string,
  context: WorkContext
): void {
  const add = addSearchCandidate.bind(null, accumulator, query);
  for (const actor of context.actors) {
    add('agent', 'workContext.actors.id', 'actor', actor.id);
    add('agent', 'workContext.actors.displayName', 'actor', actor.displayName);
    add(
      'agent',
      'workContext.actors.providerId',
      'actor provider',
      actor.providerId
    );
  }
  for (const task of context.tasks) {
    add('task', 'workContext.tasks.id', `${task.kind} ref`, task.id, 1.4);
    add(
      'task',
      'workContext.tasks.idHash',
      `${task.kind} ref`,
      `#${task.id}`,
      1.4
    );
    add('task', 'workContext.tasks.title', 'task title', task.title, 1.2);
    add('task', 'workContext.tasks.url', 'task url', task.url);
  }
  for (const artifact of context.artifacts) {
    add(
      'artifact',
      'workContext.artifacts.id',
      'artifact id',
      artifact.id,
      1.1
    );
    if (!includeArtifactText(context, artifact.id)) continue;
    add(
      'artifact',
      'workContext.artifacts.title',
      'artifact title',
      artifact.title,
      1.2
    );
    add(
      'artifact',
      'workContext.artifacts.summary',
      'artifact summary',
      artifact.summary
    );
    add('artifact', 'workContext.artifacts.uri', 'artifact uri', artifact.uri);
    add(
      'artifact',
      'workContext.artifacts.path',
      'artifact path',
      artifact.path
    );
  }
}

function addSurfaceMatches(
  accumulator: SearchAccumulator,
  query: string,
  surface: WorkspaceSurface
): void {
  const add = addSearchCandidate.bind(null, accumulator, query);
  add('surface', 'surface.id', 'surface id', surface.id, 1.1);
  add('surface', 'surface.label', 'surface label', surface.label, 1.3);
  add(
    'surface',
    'surface.description',
    'surface description',
    surface.description
  );
  add('surface', 'surface.kind', 'surface kind', surface.kind);
  add(
    'surface',
    'surface.target',
    'surface target',
    surface.url ?? surface.command ?? surface.logRef
  );
  add('session', 'surface.nodeId', 'surface node', surface.nodeId);
}

function searchFreshness(
  contexts: readonly WorkContext[],
  topicSurfaces: readonly WorkspaceSurface[]
): WorkspaceTopicSearchFreshness {
  if (topicSurfaces.some((surface) => surface.health === 'unreachable'))
    return 'stale';
  return contexts.some((context) => context.anchors.session?.sessionId)
    ? 'fresh'
    : 'unknown';
}

function surfaceMatchesTopicSearchScope(
  topic: WorkspaceTopic,
  surface: WorkspaceSurface,
  scopeWorkContextIds: readonly string[]
): boolean {
  if (scopeWorkContextIds.length === 0) {
    return surfaceMatchesTopicForSearch(topic, surface);
  }
  const surfaceWorkContextId = surface.provenance.workContextId;
  if (
    surfaceWorkContextId &&
    !scopeWorkContextIds.includes(surfaceWorkContextId)
  ) {
    return false;
  }
  if (topic.linkedRefs.workspaceSurfaceIds?.includes(surface.id)) return true;
  return Boolean(
    surfaceWorkContextId &&
    scopeWorkContextIds.includes(surfaceWorkContextId) &&
    surfaceMatchesTopicForSearch(topic, surface)
  );
}

function buildSearchResult(input: {
  topic: WorkspaceTopic;
  query: string;
  contexts: readonly WorkContext[];
  surfaces: readonly WorkspaceSurface[];
  scopeWorkContextIds?: readonly string[] | undefined;
}): WorkspaceTopicSearchResult | null {
  const topic = input.topic;
  const accumulator: SearchAccumulator = { matches: [], score: 0 };
  addTopicFieldMatches(accumulator, input.query, topic);
  addTopicPathMatches(accumulator, input.query, topic);
  addTopicRefMatches(accumulator, input.query, topic);

  const contexts = linkedContextsForTopic(
    topic,
    input.contexts,
    input.scopeWorkContextIds ?? []
  );
  for (const context of contexts) {
    addContextAnchorMatches(accumulator, input.query, context);
    addContextChildMatches(accumulator, input.query, context);
  }

  const topicSurfaces = input.surfaces.filter((surface) =>
    surfaceMatchesTopicSearchScope(
      topic,
      surface,
      input.scopeWorkContextIds ?? []
    )
  );
  for (const surface of topicSurfaces) {
    addSurfaceMatches(accumulator, input.query, surface);
  }

  if (accumulator.matches.length === 0) return null;
  const freshness = searchFreshness(contexts, topicSurfaces);
  const primarySessionId =
    topic.linkedRefs.sessionIds?.[0] ??
    contexts[0]?.anchors.session?.globalSessionId ??
    contexts[0]?.anchors.session?.sessionId;
  return {
    topic,
    score: Math.round(accumulator.score),
    freshness,
    matches: accumulator.matches.slice(0, 6),
    action: {
      kind: 'open-topic',
      topicId: topic.id,
      ...(primarySessionId ? { primarySessionId } : {}),
      ...(freshness === 'stale'
        ? { disabledReason: 'some linked surfaces are stale or unreachable' }
        : {}),
    },
  };
}

async function searchWorkspaceTopics(input: {
  query: string;
  store: WorkspaceTopicStore | null;
  surfaceStore?: WorkspaceSurfaceStore | null | undefined;
  workContextStore?: WorkContextStore | undefined;
  config?: Config | undefined;
  workspaceId?: string | undefined;
  includeArchived: boolean;
  scopeWorkContextIds?: readonly string[] | undefined;
  limit: number;
}): Promise<WorkspaceTopicSearchResponse> {
  const collected = collectSearchTopics({
    store: input.store,
    workContextStore: input.workContextStore,
    workspaceId: input.workspaceId,
    includeArchived: input.includeArchived,
  });
  const contexts = searchableContexts({
    workContextStore: input.workContextStore,
    workspaceId: input.workspaceId,
  });
  const surfaces = await collectSearchSurfaces({
    config: input.config,
    surfaceStore: input.surfaceStore,
  });
  const scopedTopics = collected.topics.filter((topic) =>
    topicIntersectsScope(topic, input.scopeWorkContextIds ?? [])
  );
  const results = scopedTopics
    .map((topic) =>
      buildSearchResult({
        topic,
        query: input.query,
        contexts,
        surfaces,
        scopeWorkContextIds: input.scopeWorkContextIds,
      })
    )
    .filter((result): result is WorkspaceTopicSearchResult => Boolean(result))
    .sort(
      (a, b) =>
        b.score - a.score || b.topic.updatedAt.localeCompare(a.topic.updatedAt)
    );
  return {
    query: input.query,
    results: results.slice(0, input.limit),
    truncated: results.length > input.limit,
    derived: collected.derived,
  };
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
  requireReadActorAuth?: (
    expectedCommand: CliGatewayActorReadCommand,
    options?: {
      scopeForRequest?: (
        req: Request
      ) => { workContextIds?: string[] } | undefined;
    }
  ) => RequestHandler;
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
  const readAuth = (
    command: CliGatewayActorReadCommand,
    authOptions?: {
      scopeForRequest?: (
        req: Request
      ) => { workContextIds?: string[] } | undefined;
    }
  ): RequestHandler =>
    options.requireReadActorAuth?.(command, authOptions) ??
    options.requireReadAuth ??
    auth;
  const writeAuth = (
    command: CliGatewayActorWriteCommand,
    scopeForRequest: (req: Request) => { workContextIds?: string[] } | undefined
  ): RequestHandler =>
    options.requireWriteActorAuth?.(command, { scopeForRequest }) ?? auth;

  router.get(
    '/workspace-topics',
    readAuth('workspace-topics.list'),
    (req, res) => {
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
    }
  );

  router.get(
    '/workspace-topics/search',
    readAuth('workspace-topics.search', {
      scopeForRequest: topicSearchScopeFromQuery,
    }),
    async (req, res) => {
      if (denyMissingCapability(req, res, [CONTEXT_READ])) return;
      const rawQuery = readString(req.query['q'] ?? req.query['query']) ?? '';
      const query = rawQuery.slice(0, WORKSPACE_TOPICS_SEARCH_QUERY_MAX).trim();
      if (!query || !normalizedText(query)) {
        const empty: WorkspaceTopicSearchResponse = {
          query,
          results: [],
          truncated: false,
          derived: false,
          unavailableReason: 'empty_query',
        };
        res.json(empty);
        return;
      }
      const workspaceId = readString(req.query['workspaceId']);
      const includeArchived = readBooleanQuery(req.query['includeArchived']);
      const limit = readPositiveIntQuery(
        req.query['limit'],
        WORKSPACE_TOPICS_SEARCH_DEFAULT_LIMIT,
        WORKSPACE_TOPICS_SEARCH_MAX_RESULTS
      );
      const scope = topicSearchScopeFromQuery(req);
      try {
        res.json(
          await searchWorkspaceTopics({
            query,
            store: options.store,
            surfaceStore: options.surfaceStore,
            workContextStore: options.workContextStore,
            config: options.getConfig?.(),
            workspaceId,
            includeArchived,
            scopeWorkContextIds: scope?.workContextIds,
            limit,
          })
        );
      } catch {
        sendGatewayError(
          res,
          'INTERNAL',
          'workspace topic search failed',
          true
        );
      }
    }
  );

  router.get(
    '/workspace-topics/:id',
    readAuth('workspace-topics.get'),
    (req, res) => {
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
    }
  );

  router.post(
    '/workspace-topics',
    writeAuth('workspace-topics.create', topicWorkContextScopeFromBody),
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
    writeAuth('workspace-topics.update', (req) =>
      topicWorkContextScopeFromUpdate({ store: options.store, req })
    ),
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
    writeAuth('workspace-topics.archive', (req) =>
      topicWorkContextScopeFromPersistedTopic({ store: options.store, req })
    ),
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
