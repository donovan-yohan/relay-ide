import * as crypto from 'node:crypto';
import path from 'node:path';

import Database from 'better-sqlite3';
import { Router } from 'express';
import type { RequestHandler } from 'express';

import { createLogger } from './logger.js';
import type { SessionSummary } from './types.js';
import { DEFAULT_LOCAL_NODE_ID, createGlobalSessionId } from '../shared/identity.js';
import type { HubNodeStatus, HubNodeSummary } from '../shared/relay-node-protocol.js';
import {
  WORK_CONTEXT_SCHEMA_VERSION,
  createWorkContextPrivacyMetadata,
  isWorkContext,
  type NodeRefKind,
  type SessionRef,
  type WorkContext,
  type WorkContextId,
  type WorkContextTabKind,
} from '../shared/work-context.js';

const logger = createLogger('work-contexts');

const SCHEMA_VERSION = 1;
const DEFAULT_SOURCE = 'relay-api';
const DEFAULT_RELATIONSHIP = 'associated';

const FORBIDDEN_RAW_PAYLOAD_KEYS = new Set([
  'rawContent',
  'rawPayload',
  'rawTranscript',
  'terminalTranscript',
  'transcript',
  'rawLog',
  'log',
  'hermesDbPath',
  'hermesProfileState',
  'rawHermesProfileState',
  'providerAuth',
  'providerToken',
  'env',
  'secrets',
]);

const SESSION_TAB_KINDS = new Set<string>([
  'agent',
  'terminal',
  'file',
  'diff',
  'preview',
  'html',
  'other',
]);

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS work_contexts (
  id           TEXT PRIMARY KEY,
  title        TEXT,
  source       TEXT NOT NULL,
  context_json TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_work_contexts_updated_at
  ON work_contexts(updated_at DESC);

CREATE TABLE IF NOT EXISTS work_context_session_links (
  work_context_id  TEXT NOT NULL,
  node_id          TEXT NOT NULL,
  session_id       TEXT NOT NULL,
  global_session_id TEXT,
  relationship     TEXT NOT NULL,
  session_ref_json  TEXT NOT NULL,
  associated_at     TEXT NOT NULL,
  PRIMARY KEY (work_context_id, node_id, session_id),
  FOREIGN KEY (work_context_id) REFERENCES work_contexts(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_work_context_session_links_session
  ON work_context_session_links(node_id, session_id);
CREATE INDEX IF NOT EXISTS idx_work_context_session_links_global
  ON work_context_session_links(global_session_id);

CREATE TABLE IF NOT EXISTS work_context_links (
  source_context_id TEXT NOT NULL,
  target_context_id TEXT NOT NULL,
  relationship      TEXT NOT NULL,
  linked_at         TEXT NOT NULL,
  PRIMARY KEY (source_context_id, target_context_id, relationship),
  FOREIGN KEY (source_context_id) REFERENCES work_contexts(id) ON DELETE CASCADE,
  FOREIGN KEY (target_context_id) REFERENCES work_contexts(id) ON DELETE CASCADE
);
`;

interface WorkContextRow {
  id: string;
  title: string | null;
  source: string;
  context_json: string;
  created_at: string;
  updated_at: string;
}

interface SessionLinkRow {
  work_context_id: string;
  node_id: string;
  session_id: string;
  global_session_id: string | null;
  relationship: string;
  session_ref_json: string;
  associated_at: string;
}

export interface WorkContextCreateInput {
  context?: WorkContext;
  id?: string;
  title?: string;
  source?: string;
  anchors?: WorkContext['anchors'];
  actors?: WorkContext['actors'];
  tasks?: WorkContext['tasks'];
  artifacts?: WorkContext['artifacts'];
  auditRefs?: WorkContext['auditRefs'];
  capabilityGrants?: WorkContext['capabilityGrants'];
  relatedContextRefs?: string[];
  privacy?: WorkContext['privacy'];
}

export type WorkContextPatchInput = Partial<
  Pick<
    WorkContext,
    | 'title'
    | 'source'
    | 'anchors'
    | 'actors'
    | 'tasks'
    | 'artifacts'
    | 'auditRefs'
    | 'capabilityGrants'
    | 'relatedContextRefs'
    | 'privacy'
  >
>;

export interface SessionAssociationInput {
  session?: SessionSummary;
  sessionRef?: SessionRef;
  relationship?: string;
}

export interface WorkContextSessionSummary {
  id: string;
  nodeId: string;
  globalSessionId?: string;
  tabKind: WorkContextTabKind;
  type?: SessionSummary['type'];
  mode?: SessionSummary['mode'];
  agent?: SessionSummary['agent'];
  cwd: string;
  repoPath?: string;
  worktreePath?: string | null;
  repoName?: string;
  branchName?: string;
  displayName?: string;
  status?: SessionSummary['status'];
  agentState?: SessionSummary['agentState'];
  controlMode?: SessionSummary['controlMode'];
  controlFreshness?: SessionSummary['controlFreshness'];
  lastActivity?: string;
  relationship: string;
  associatedAt: string;
  live: boolean;
}

export interface WorkContextNodeState {
  nodeId: string;
  status: HubNodeStatus | 'unknown';
  displayName?: string;
  lastSeenAt?: string;
  kind?: NodeRefKind;
}

export interface WorkContextActiveGroup {
  id: string;
  context: WorkContext | null;
  node: WorkContextNodeState;
  sessions: WorkContextSessionSummary[];
  staleReadModel: boolean;
}

export interface ListActiveWorkInput {
  sessions: SessionSummary[];
  nodes?: HubNodeSummary[];
}

export interface WorkContextStore {
  close(): void;
  create(input?: WorkContextCreateInput): WorkContext;
  get(id: WorkContextId): WorkContext | null;
  list(): WorkContext[];
  update(id: WorkContextId, patch: WorkContextPatchInput): WorkContext;
  linkContexts(sourceId: WorkContextId, targetId: WorkContextId, relationship?: string): WorkContext;
  associateSession(id: WorkContextId, input: SessionAssociationInput): WorkContext;
  listActiveWork(input: ListActiveWorkInput): WorkContextActiveGroup[];
}

export interface WorkContextRouterDeps {
  store: WorkContextStore;
  requireAuth?: RequestHandler;
  getSessions: () => Promise<SessionSummary[]> | SessionSummary[];
  getNodes?: () => HubNodeSummary[];
}

export function initWorkContextStore(configDir: string): WorkContextStore {
  return createWorkContextStore(path.join(configDir, 'work-contexts.db'));
}

export function createWorkContextStore(dbPath: string): WorkContextStore {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)');
  const row = db.prepare('SELECT version FROM schema_version').get() as
    | { version: number }
    | undefined;
  const hadRow = row !== undefined;
  const currentVersion = row?.version ?? 0;
  if (currentVersion < SCHEMA_VERSION) {
    db.transaction(() => {
      db.exec(SCHEMA_SQL);
      if (hadRow) {
        db.prepare('UPDATE schema_version SET version = ?').run(SCHEMA_VERSION);
      } else {
        db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(SCHEMA_VERSION);
      }
    })();
  }

  const selectContext = db.prepare(
    `SELECT id, title, source, context_json, created_at, updated_at
     FROM work_contexts WHERE id = ?`
  );
  const selectAllContexts = db.prepare(
    `SELECT id, title, source, context_json, created_at, updated_at
     FROM work_contexts ORDER BY updated_at DESC, created_at DESC`
  );
  const upsertContext = db.prepare(
    `INSERT INTO work_contexts (id, title, source, context_json, created_at, updated_at)
     VALUES (@id, @title, @source, @contextJson, @createdAt, @updatedAt)
     ON CONFLICT(id) DO UPDATE SET
       title = excluded.title,
       source = excluded.source,
       context_json = excluded.context_json,
       updated_at = excluded.updated_at`
  );
  const selectSessionLinks = db.prepare(
    `SELECT work_context_id, node_id, session_id, global_session_id,
            relationship, session_ref_json, associated_at
     FROM work_context_session_links
     ORDER BY associated_at ASC`
  );
  const upsertSessionLink = db.prepare(
    `INSERT INTO work_context_session_links (
       work_context_id, node_id, session_id, global_session_id,
       relationship, session_ref_json, associated_at
     ) VALUES (
       @workContextId, @nodeId, @sessionId, @globalSessionId,
       @relationship, @sessionRefJson, @associatedAt
     )
     ON CONFLICT(work_context_id, node_id, session_id) DO UPDATE SET
       global_session_id = excluded.global_session_id,
       relationship = excluded.relationship,
       session_ref_json = excluded.session_ref_json,
       associated_at = excluded.associated_at`
  );
  const upsertContextLink = db.prepare(
    `INSERT OR IGNORE INTO work_context_links (
       source_context_id, target_context_id, relationship, linked_at
     ) VALUES (?, ?, ?, ?)`
  );

  function write(context: WorkContext): WorkContext {
    assertValidPersistableContext(context);
    upsertContext.run({
      id: context.id,
      title: context.title ?? null,
      source: context.source,
      contextJson: JSON.stringify(context),
      createdAt: context.createdAt,
      updatedAt: context.updatedAt,
    });
    return context;
  }

  function mustGet(id: WorkContextId): WorkContext {
    const context = getById(id);
    if (!context) throw new WorkContextStoreError(404, 'work_context_not_found');
    return context;
  }

  function getById(id: WorkContextId): WorkContext | null {
    const row = selectContext.get(id) as WorkContextRow | undefined;
    return row ? rowToContext(row) : null;
  }

  return {
    close() {
      db.close();
    },

    create(input: WorkContextCreateInput = {}) {
      const now = new Date().toISOString();
      const context = input.context
        ? { ...input.context, updatedAt: input.context.updatedAt || now }
        : buildContextFromInput(input, now);
      return write(context);
    },

    get: getById,

    list() {
      return (selectAllContexts.all() as WorkContextRow[])
        .map(rowToContext)
        .filter((context): context is WorkContext => context !== null);
    },

    update(id: WorkContextId, patch: WorkContextPatchInput) {
      const existing = mustGet(id);
      const updated: WorkContext = {
        ...existing,
        ...patch,
        id: existing.id,
        schemaVersion: existing.schemaVersion,
        createdAt: existing.createdAt,
        updatedAt: new Date().toISOString(),
      };
      return write(updated);
    },

    linkContexts(sourceId: WorkContextId, targetId: WorkContextId, relationship = 'related') {
      const source = mustGet(sourceId);
      mustGet(targetId);
      const related = new Set(source.relatedContextRefs ?? []);
      related.add(targetId);
      const updated: WorkContext = {
        ...source,
        relatedContextRefs: Array.from(related).sort(),
        updatedAt: new Date().toISOString(),
      };
      db.transaction(() => {
        write(updated);
        upsertContextLink.run(sourceId, targetId, relationship, updated.updatedAt);
      })();
      return updated;
    },

    associateSession(id: WorkContextId, input: SessionAssociationInput) {
      const existing = mustGet(id);
      const associatedAt = new Date().toISOString();
      const relationship = input.relationship ?? DEFAULT_RELATIONSHIP;
      const sessionRef = input.session
        ? sessionSummaryToRef(input.session)
        : input.sessionRef;
      if (!sessionRef) {
        throw new WorkContextStoreError(400, 'session_ref_required');
      }
      assertValidSessionRef(sessionRef);
      const updated = contextWithSessionAnchor(existing, sessionRef, associatedAt);
      db.transaction(() => {
        write(updated);
        upsertSessionLink.run({
          workContextId: id,
          nodeId: sessionRef.nodeId,
          sessionId: sessionRef.sessionId,
          globalSessionId: sessionRef.globalSessionId ?? null,
          relationship,
          sessionRefJson: JSON.stringify(sessionRef),
          associatedAt,
        });
      })();
      return updated;
    },

    listActiveWork(input: ListActiveWorkInput) {
      const contexts = this.list();
      const allLinks = selectSessionLinks.all() as SessionLinkRow[];
      return buildActiveGroups(contexts, allLinks, input.sessions, input.nodes ?? []);
    },
  };
}

export class WorkContextStoreError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message = code) {
    super(message);
    this.name = 'WorkContextStoreError';
    this.status = status;
    this.code = code;
  }
}

export function createWorkContextRouter(deps: WorkContextRouterDeps): Router {
  const router = Router();
  const auth = deps.requireAuth ?? ((_req, _res, next) => next());

  router.get('/', auth, (_req, res) => {
    res.json({ workContexts: deps.store.list() });
  });

  router.post('/', auth, (req, res) => {
    try {
      const context = deps.store.create(req.body as WorkContextCreateInput);
      res.status(201).json({ workContext: context });
    } catch (err) {
      sendStoreError(res, err);
    }
  });

  router.get('/active', auth, async (_req, res) => {
    try {
      const sessions = await deps.getSessions();
      const nodes = deps.getNodes?.() ?? [];
      res.json({ groups: deps.store.listActiveWork({ sessions, nodes }) });
    } catch (err) {
      sendStoreError(res, err);
    }
  });

  router.get('/:id', auth, (req, res) => {
    const context = deps.store.get(req.params['id'] ?? '');
    if (!context) {
      res.status(404).json({ error: 'work_context_not_found' });
      return;
    }
    res.json({ workContext: context });
  });

  router.patch('/:id', auth, (req, res) => {
    try {
      const context = deps.store.update(
        req.params['id'] ?? '',
        req.body as WorkContextPatchInput
      );
      res.json({ workContext: context });
    } catch (err) {
      sendStoreError(res, err);
    }
  });

  router.post('/:id/link', auth, (req, res) => {
    const body = req.body as { targetContextId?: string; relationship?: string };
    if (!body.targetContextId) {
      res.status(400).json({ error: 'targetContextId is required' });
      return;
    }
    try {
      const context = deps.store.linkContexts(
        req.params['id'] ?? '',
        body.targetContextId,
        body.relationship
      );
      res.json({ workContext: context });
    } catch (err) {
      sendStoreError(res, err);
    }
  });

  router.post('/:id/sessions', auth, async (req, res) => {
    const body = req.body as {
      sessionId?: string;
      nodeId?: string;
      globalSessionId?: string;
      tabId?: string;
      tabKind?: WorkContextTabKind;
      cwd?: string;
      relationship?: string;
    };
    if (!body.sessionId) {
      res.status(400).json({ error: 'sessionId is required' });
      return;
    }
    const sessions = await deps.getSessions();
    const liveSession = sessions.find(
      (session) =>
        session.id === body.sessionId || session.globalSessionId === body.sessionId
    );
    const association: SessionAssociationInput = liveSession
      ? { session: liveSession }
      : { sessionRef: sessionRefFromBody(body as SessionRefBody) };
    if (body.relationship) association.relationship = body.relationship;
    try {
      const context = deps.store.associateSession(
        req.params['id'] ?? '',
        association
      );
      res.json({ workContext: context });
    } catch (err) {
      sendStoreError(res, err);
    }
  });

  return router;
}

interface SessionRefBody {
  sessionId: string;
  nodeId?: string;
  globalSessionId?: string;
  tabId?: string;
  tabKind?: WorkContextTabKind;
  cwd?: string;
}

function buildContextFromInput(
  input: WorkContextCreateInput,
  now: string
): WorkContext {
  const context: WorkContext = {
    schemaVersion: WORK_CONTEXT_SCHEMA_VERSION,
    id: input.id ?? createWorkContextId(),
    ...(input.title ? { title: input.title } : {}),
    createdAt: now,
    updatedAt: now,
    source: input.source ?? DEFAULT_SOURCE,
    anchors: input.anchors ?? {},
    actors: input.actors ?? [],
    tasks: input.tasks ?? [],
    artifacts: input.artifacts ?? [],
    auditRefs: input.auditRefs ?? [],
    capabilityGrants: input.capabilityGrants ?? [],
    ...(input.relatedContextRefs ? { relatedContextRefs: input.relatedContextRefs } : {}),
    privacy: input.privacy ?? createWorkContextPrivacyMetadata({ retention: 'project' }),
  };
  return context;
}

function createWorkContextId(): WorkContextId {
  return `wc:${crypto.randomBytes(8).toString('hex')}`;
}

function rowToContext(row: WorkContextRow): WorkContext | null {
  try {
    const value = JSON.parse(row.context_json) as unknown;
    if (!isWorkContext(value)) return null;
    return value;
  } catch (err) {
    logger.warn('failed to parse work context %s: %s', row.id, err);
    return null;
  }
}

function assertValidPersistableContext(context: WorkContext): void {
  if (!isWorkContext(context)) {
    throw new WorkContextStoreError(400, 'invalid_work_context');
  }
  if (containsForbiddenRawPayloadKey(context)) {
    throw new WorkContextStoreError(400, 'raw_payload_not_allowed');
  }
  if (containsRawPayloadStoredFlag(context)) {
    throw new WorkContextStoreError(400, 'raw_payload_storage_not_allowed');
  }
}

function containsForbiddenRawPayloadKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsForbiddenRawPayloadKey);
  if (!isRecord(value)) return false;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_RAW_PAYLOAD_KEYS.has(key)) return true;
    if (containsForbiddenRawPayloadKey(child)) return true;
  }
  return false;
}

function containsRawPayloadStoredFlag(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsRawPayloadStoredFlag);
  if (!isRecord(value)) return false;
  if (value.rawPayloadStored === true) return true;
  return Object.values(value).some(containsRawPayloadStoredFlag);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertValidSessionRef(ref: SessionRef): void {
  if (!ref.nodeId || !ref.sessionId || !ref.cwd) {
    throw new WorkContextStoreError(400, 'invalid_session_ref');
  }
  if (!SESSION_TAB_KINDS.has(ref.tabKind)) {
    throw new WorkContextStoreError(400, 'invalid_session_tab_kind');
  }
}

function contextWithSessionAnchor(
  context: WorkContext,
  sessionRef: SessionRef,
  updatedAt: string
): WorkContext {
  return {
    ...context,
    updatedAt,
    anchors: {
      ...context.anchors,
      node: context.anchors.node ?? {
        nodeId: sessionRef.nodeId,
        kind: sessionRef.nodeId === DEFAULT_LOCAL_NODE_ID ? 'local' : 'remote',
      },
      session: context.anchors.session ?? sessionRef,
    },
  };
}

export function sessionSummaryToRef(session: SessionSummary): SessionRef {
  const nodeId = session.nodeId ?? DEFAULT_LOCAL_NODE_ID;
  const globalSessionId = session.globalSessionId ?? createGlobalSessionId(nodeId, session.id);
  const tabKind: WorkContextTabKind = session.type === 'terminal' ? 'terminal' : 'agent';
  return {
    nodeId,
    sessionId: session.id,
    globalSessionId,
    tabKind,
    cwd: session.cwd,
  };
}

function sessionRefFromBody(body: SessionRefBody): SessionRef {
  if (!body.cwd) throw new WorkContextStoreError(400, 'cwd is required for offline session refs');
  const nodeId = body.nodeId ?? DEFAULT_LOCAL_NODE_ID;
  return {
    nodeId,
    sessionId: body.sessionId,
    ...(body.globalSessionId ? { globalSessionId: body.globalSessionId } : {}),
    ...(body.tabId ? { tabId: body.tabId } : {}),
    tabKind: body.tabKind ?? 'terminal',
    cwd: body.cwd,
  };
}

function buildActiveGroups(
  contexts: WorkContext[],
  links: SessionLinkRow[],
  sessions: SessionSummary[],
  nodes: HubNodeSummary[]
): WorkContextActiveGroup[] {
  const nodesById = new Map(nodes.map((node) => [node.nodeId, node]));
  const sessionsByKey = buildSessionLookup(sessions);
  const linkedSessionKeys = new Set<string>();
  const linksByContext = groupLinksByContext(links);
  const groups: WorkContextActiveGroup[] = [];

  for (const context of contexts) {
    const contextLinks = linksByContext.get(context.id) ?? [];
    const anchorLink = linkFromAnchor(context);
    if (
      anchorLink &&
      !contextLinks.some(
        (link) =>
          link.node_id === anchorLink.node_id &&
          link.session_id === anchorLink.session_id
      )
    ) {
      contextLinks.push(anchorLink);
    }

    const groupSessions = contextLinks.map((link) => {
      const key = sessionKey(link.node_id, link.session_id);
      linkedSessionKeys.add(key);
      const live = sessionsByKey.get(key) ??
        (link.global_session_id ? sessionsByKey.get(link.global_session_id) : undefined);
      return summarizeLinkedSession(link, live);
    });

    const node = nodeStateForContext(context, groupSessions, nodesById);
    groups.push({
      id: context.id,
      context,
      node,
      sessions: groupSessions,
      staleReadModel: node.status !== 'online' || groupSessions.some((s) => !s.live),
    });
  }

  for (const session of sessions) {
    const nodeId = session.nodeId ?? DEFAULT_LOCAL_NODE_ID;
    if (linkedSessionKeys.has(sessionKey(nodeId, session.id))) continue;
    const syntheticLink = sessionLinkFromSession('unassigned', session);
    const summarized = summarizeLinkedSession(syntheticLink, session);
    groups.push({
      id: `unassigned:${nodeId}:${session.id}`,
      context: null,
      node: nodeStateForNodeId(nodeId, nodesById),
      sessions: [summarized],
      staleReadModel: false,
    });
  }

  return groups;
}

function buildSessionLookup(sessions: SessionSummary[]): Map<string, SessionSummary> {
  const lookup = new Map<string, SessionSummary>();
  for (const session of sessions) {
    const nodeId = session.nodeId ?? DEFAULT_LOCAL_NODE_ID;
    lookup.set(sessionKey(nodeId, session.id), session);
    if (session.globalSessionId) lookup.set(session.globalSessionId, session);
  }
  return lookup;
}

function groupLinksByContext(links: SessionLinkRow[]): Map<string, SessionLinkRow[]> {
  const grouped = new Map<string, SessionLinkRow[]>();
  for (const link of links) {
    const existing = grouped.get(link.work_context_id);
    if (existing) existing.push(link);
    else grouped.set(link.work_context_id, [link]);
  }
  return grouped;
}

function linkFromAnchor(context: WorkContext): SessionLinkRow | null {
  const ref = context.anchors.session;
  if (!ref) return null;
  return {
    work_context_id: context.id,
    node_id: ref.nodeId,
    session_id: ref.sessionId,
    global_session_id: ref.globalSessionId ?? null,
    relationship: 'anchor',
    session_ref_json: JSON.stringify(ref),
    associated_at: context.updatedAt,
  };
}

function sessionLinkFromSession(
  workContextId: string,
  session: SessionSummary
): SessionLinkRow {
  const ref = sessionSummaryToRef(session);
  return {
    work_context_id: workContextId,
    node_id: ref.nodeId,
    session_id: ref.sessionId,
    global_session_id: ref.globalSessionId ?? null,
    relationship: DEFAULT_RELATIONSHIP,
    session_ref_json: JSON.stringify(ref),
    associated_at: session.createdAt,
  };
}

function summarizeLinkedSession(
  link: SessionLinkRow,
  liveSession: SessionSummary | undefined
): WorkContextSessionSummary {
  const ref = parseSessionRef(link.session_ref_json);
  if (liveSession) return summarizeLiveSession(link, liveSession);
  return {
    id: ref.sessionId,
    nodeId: ref.nodeId,
    ...(ref.globalSessionId ? { globalSessionId: ref.globalSessionId } : {}),
    tabKind: ref.tabKind,
    cwd: ref.cwd,
    relationship: link.relationship,
    associatedAt: link.associated_at,
    live: false,
  };
}

function summarizeLiveSession(
  link: SessionLinkRow,
  session: SessionSummary
): WorkContextSessionSummary {
  const nodeId = session.nodeId ?? DEFAULT_LOCAL_NODE_ID;
  const summary: WorkContextSessionSummary = {
    id: session.id,
    nodeId,
    ...(session.globalSessionId ? { globalSessionId: session.globalSessionId } : {}),
    tabKind: session.type === 'terminal' ? 'terminal' : 'agent',
    type: session.type,
    mode: session.mode,
    agent: session.agent,
    cwd: session.cwd,
    ...(session.repoPath ? { repoPath: session.repoPath } : {}),
    ...(session.worktreePath !== undefined ? { worktreePath: session.worktreePath } : {}),
    ...(session.repoName ? { repoName: session.repoName } : {}),
    ...(session.branchName ? { branchName: session.branchName } : {}),
    displayName: session.displayName,
    status: session.status,
    agentState: session.agentState,
    ...(session.controlMode ? { controlMode: session.controlMode } : {}),
    ...(session.controlFreshness ? { controlFreshness: session.controlFreshness } : {}),
    lastActivity: session.lastActivity,
    relationship: link.relationship,
    associatedAt: link.associated_at,
    live: true,
  };
  return summary;
}

function parseSessionRef(value: string): SessionRef {
  const parsed = JSON.parse(value) as SessionRef;
  assertValidSessionRef(parsed);
  return parsed;
}

function nodeStateForContext(
  context: WorkContext,
  sessions: WorkContextSessionSummary[],
  nodesById: Map<string, HubNodeSummary>
): WorkContextNodeState {
  const nodeId =
    context.anchors.node?.nodeId ?? sessions[0]?.nodeId ?? DEFAULT_LOCAL_NODE_ID;
  const state = nodeStateForNodeId(nodeId, nodesById);
  if (context.anchors.node?.displayName && !state.displayName) {
    return { ...state, displayName: context.anchors.node.displayName };
  }
  if (context.anchors.node?.kind) return { ...state, kind: context.anchors.node.kind };
  return state;
}

function nodeStateForNodeId(
  nodeId: string,
  nodesById: Map<string, HubNodeSummary>
): WorkContextNodeState {
  const node = nodesById.get(nodeId);
  if (node) {
    return {
      nodeId,
      status: node.status,
      displayName: node.displayName,
      lastSeenAt: node.lastSeenAt,
      kind: nodeId === DEFAULT_LOCAL_NODE_ID ? 'local' : 'remote',
    };
  }
  if (nodeId === DEFAULT_LOCAL_NODE_ID) {
    return { nodeId, status: 'online', displayName: 'Local node', kind: 'local' };
  }
  return { nodeId, status: 'unknown', kind: 'remote' };
}

function sessionKey(nodeId: string, sessionId: string): string {
  return `${nodeId}\u0000${sessionId}`;
}

function sendStoreError(
  res: { status: (code: number) => { json: (body: unknown) => void } },
  err: unknown
): void {
  if (err instanceof WorkContextStoreError) {
    res.status(err.status).json({ error: err.code });
    return;
  }
  logger.warn('work-context route failed: %s', err);
  res.status(500).json({ error: 'work_context_internal_error' });
}
