import * as crypto from 'node:crypto';
import path from 'node:path';

import Database from 'better-sqlite3';
import { Router } from 'express';
import type { RequestHandler } from 'express';

import { createLogger } from './logger.js';
import type { SessionSummary } from './types.js';
import {
  DEFAULT_LOCAL_NODE_ID,
  createGlobalSessionId,
} from '../shared/identity.js';
import type {
  HubNodeStatus,
  HubNodeSummary,
} from '../shared/relay-node-protocol.js';
import {
  WORK_CONTEXT_SCHEMA_VERSION,
  createWorkContextPrivacyMetadata,
  isWorkContext,
  type ArtifactRef,
  type AuditEventRef,
  type NodeRefKind,
  type SessionRef,
  type TaskRef,
  type WorkContext,
  type WorkContextId,
  type WorkContextTabKind,
} from '../shared/work-context.js';

const logger = createLogger('work-contexts');

const SCHEMA_VERSION = 1;
const DEFAULT_SOURCE = 'relay-api';
const DEFAULT_RELATIONSHIP = 'associated';
const MAX_RESUME_ARTIFACTS = 20;
const MAX_RESUME_AUDIT_REFS = 50;
const MAX_RESUME_SESSIONS = 20;
const LIFECYCLE_EVENT_TYPES = new Set([
  'handoff.created',
  'session.associated',
  'session.started',
  'session.resumed',
  'operator.intervened',
  'artifact.recorded',
  'artifact.unpinned',
  'summary.recorded',
  'handoff.closed',
]);

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

export interface WorkContextLifecycleEventInput {
  eventId?: string;
  type?: string;
  actorId?: string;
  occurredAt?: string;
  correlationId?: string;
  logRef?: string;
  artifacts?: ArtifactRef[];
  summary?: string;
}

export interface WorkContextFromTaskRefInput extends WorkContextCreateInput {
  taskRef?: TaskRef;
  existingWorkContextId?: string;
  relationship?: string;
}

export interface WorkContextResumeSnapshot {
  workContext: Pick<
    WorkContext,
    | 'id'
    | 'title'
    | 'source'
    | 'createdAt'
    | 'updatedAt'
    | 'anchors'
    | 'actors'
    | 'tasks'
    | 'relatedContextRefs'
  >;
  node: WorkContextNodeState;
  sessions: WorkContextSessionSummary[];
  artifacts: ArtifactRef[];
  auditRefs: AuditEventRef[];
  privacy: {
    mode: 'compact-refs';
    rawPayloadAvailable: false;
    transcriptExportAvailable: false;
    rawTranscriptIncluded: false;
  };
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
  currentActivity?: SessionSummary['currentActivity'];
  controlMode?: SessionSummary['controlMode'];
  activeActors?: SessionSummary['activeActors'];
  activeWorker?: SessionSummary['activeWorker'];
  lastInterventionAt?: SessionSummary['lastInterventionAt'];
  lastInterventionBy?: SessionSummary['lastInterventionBy'];
  lastInterventionEventId?: SessionSummary['lastInterventionEventId'];
  controlFreshness?: SessionSummary['controlFreshness'];
  controlReason?: SessionSummary['controlReason'];
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
  linkContexts(
    sourceId: WorkContextId,
    targetId: WorkContextId,
    relationship?: string
  ): WorkContext;
  associateSession(
    id: WorkContextId,
    input: SessionAssociationInput
  ): WorkContext;
  recordLifecycleEvent(
    id: WorkContextId,
    input: WorkContextLifecycleEventInput
  ): WorkContext;
  getResumeSnapshot(
    id: WorkContextId,
    input: ListActiveWorkInput
  ): WorkContextResumeSnapshot;
  listActiveWork(input: ListActiveWorkInput): WorkContextActiveGroup[];
  findSessionWorkContextIds(session: SessionSummary): WorkContextId[];
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
  db.exec(
    'CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)'
  );
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
        db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(
          SCHEMA_VERSION
        );
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
  const selectSessionLinksBySession = db.prepare(
    `SELECT work_context_id, node_id, session_id, global_session_id,
            relationship, session_ref_json, associated_at
     FROM work_context_session_links
     WHERE node_id = ? AND session_id = ?
     ORDER BY associated_at ASC`
  );
  const selectSessionLinksByGlobal = db.prepare(
    `SELECT work_context_id, node_id, session_id, global_session_id,
            relationship, session_ref_json, associated_at
     FROM work_context_session_links
     WHERE global_session_id = ?
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
    const persistable = canonicalizePersistableContext(context);
    upsertContext.run({
      id: persistable.id,
      title: persistable.title ?? null,
      source: persistable.source,
      contextJson: JSON.stringify(persistable),
      createdAt: persistable.createdAt,
      updatedAt: persistable.updatedAt,
    });
    return persistable;
  }

  function mustGet(id: WorkContextId): WorkContext {
    const context = getById(id);
    if (!context)
      throw new WorkContextStoreError(404, 'work_context_not_found');
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
        ? canonicalizePersistableContext({
            ...input.context,
            updatedAt: input.context.updatedAt || now,
          })
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
      const allowedPatch = pickWorkContextPatch(patch);
      const updated: WorkContext = {
        ...existing,
        ...allowedPatch,
        id: existing.id,
        schemaVersion: existing.schemaVersion,
        createdAt: existing.createdAt,
        updatedAt: new Date().toISOString(),
      };
      return write(updated);
    },

    linkContexts(
      sourceId: WorkContextId,
      targetId: WorkContextId,
      relationship = 'related'
    ) {
      if (sourceId === targetId) {
        throw new WorkContextStoreError(
          400,
          'work_context_self_link_not_allowed'
        );
      }
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
        upsertContextLink.run(
          sourceId,
          targetId,
          relationship,
          updated.updatedAt
        );
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
      const updated = contextWithSessionAssociationEvent(
        contextWithSessionAnchor(existing, sessionRef, associatedAt),
        sessionRef,
        associatedAt
      );
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

    recordLifecycleEvent(
      id: WorkContextId,
      input: WorkContextLifecycleEventInput
    ) {
      const existing = mustGet(id);
      const updated = contextWithLifecycleEvent(
        existing,
        input,
        new Date().toISOString()
      );
      return write(updated);
    },

    getResumeSnapshot(id: WorkContextId, input: ListActiveWorkInput) {
      const context = mustGet(id);
      const groups = buildActiveGroups(
        [context],
        selectSessionLinks.all() as SessionLinkRow[],
        input.sessions,
        input.nodes ?? []
      );
      return resumeSnapshotFromGroup(
        groups[0] ?? {
          id: context.id,
          context,
          node: nodeStateForNodeId(DEFAULT_LOCAL_NODE_ID, new Map()),
          sessions: [],
          staleReadModel: true,
        }
      );
    },

    listActiveWork(input: ListActiveWorkInput) {
      const contexts = this.list();
      const allLinks = selectSessionLinks.all() as SessionLinkRow[];
      return buildActiveGroups(
        contexts,
        allLinks,
        input.sessions,
        input.nodes ?? []
      );
    },

    findSessionWorkContextIds(session: SessionSummary) {
      const ref = sessionSummaryToRef(session);
      const rows = [
        ...(selectSessionLinksBySession.all(
          ref.nodeId,
          ref.sessionId
        ) as SessionLinkRow[]),
        ...(ref.globalSessionId
          ? (selectSessionLinksByGlobal.all(
              ref.globalSessionId
            ) as SessionLinkRow[])
          : []),
      ].sort((a, b) => a.associated_at.localeCompare(b.associated_at));
      const ids = new Set<WorkContextId>();
      for (const link of rows) ids.add(link.work_context_id);
      return Array.from(ids);
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

  router.post('/from-task-ref', auth, (req, res) => {
    const input = req.body as WorkContextFromTaskRefInput;
    if (!input.taskRef) {
      res.status(400).json({ error: 'taskRef is required' });
      return;
    }
    try {
      if (input.existingWorkContextId) {
        const existing = deps.store.get(input.existingWorkContextId);
        if (!existing) {
          res.status(404).json({ error: 'work_context_not_found' });
          return;
        }
        const context = deps.store.update(existing.id, {
          ...pickWorkContextPatch(input),
          tasks: dedupeById([...existing.tasks, input.taskRef]),
        });
        deps.store.recordLifecycleEvent(context.id, {
          type: 'handoff.created',
          summary: `Linked task ${input.taskRef.kind}:${input.taskRef.id}`,
        });
        res.json({ workContext: deps.store.get(context.id) ?? context });
        return;
      }
      const context = deps.store.create({
        ...input,
        tasks: dedupeById([...(input.tasks ?? []), input.taskRef]),
      });
      deps.store.recordLifecycleEvent(context.id, {
        type: 'handoff.created',
        summary: `Created handoff context for ${input.taskRef.kind}:${input.taskRef.id}`,
      });
      res
        .status(201)
        .json({ workContext: deps.store.get(context.id) ?? context });
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

  router.get('/:id/resume', auth, async (req, res) => {
    try {
      const sessions = await deps.getSessions();
      const nodes = deps.getNodes?.() ?? [];
      res.json({
        resume: deps.store.getResumeSnapshot(req.params['id'] ?? '', {
          sessions,
          nodes,
        }),
      });
    } catch (err) {
      sendStoreError(res, err);
    }
  });

  router.post('/:id/events', auth, (req, res) => {
    try {
      const context = deps.store.recordLifecycleEvent(
        req.params['id'] ?? '',
        req.body as WorkContextLifecycleEventInput
      );
      res.status(201).json({ workContext: context });
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
        pickWorkContextPatch(req.body as WorkContextPatchInput)
      );
      res.json({ workContext: context });
    } catch (err) {
      sendStoreError(res, err);
    }
  });

  router.post('/:id/link', auth, (req, res) => {
    const body = req.body as {
      targetContextId?: string;
      relationship?: string;
    };
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
      agent?: string;
      controlMode?: SessionSummary['controlMode'];
      relationship?: string;
    };
    if (!body.sessionId) {
      res.status(400).json({ error: 'sessionId is required' });
      return;
    }
    const sessions = await deps.getSessions();
    const liveSession = findLiveSessionForAssociation(sessions, body);
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
  agent?: string;
  controlMode?: SessionSummary['controlMode'];
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
    ...(input.relatedContextRefs
      ? { relatedContextRefs: input.relatedContextRefs }
      : {}),
    privacy:
      input.privacy ??
      createWorkContextPrivacyMetadata({ retention: 'project' }),
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
    return canonicalizePersistableContext(value);
  } catch (err) {
    if (err instanceof WorkContextStoreError) {
      logger.warn('dropped unsafe work context %s: %s', row.id, err.code);
    } else {
      logger.warn('failed to parse work context %s: %s', row.id, err);
    }
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

function canonicalizePersistableContext(context: WorkContext): WorkContext {
  assertValidPersistableContext(context);
  const canonical: WorkContext = {
    schemaVersion: context.schemaVersion,
    id: context.id,
    ...(context.title ? { title: context.title } : {}),
    createdAt: context.createdAt,
    updatedAt: context.updatedAt,
    source: context.source,
    anchors: pickAnchors(context.anchors),
    actors: context.actors.map(pickActor),
    tasks: context.tasks.map(pickTask),
    artifacts: context.artifacts.map(pickArtifact),
    auditRefs: context.auditRefs.map(pickAuditRef),
    capabilityGrants: context.capabilityGrants.map(pickCapabilityGrant),
    ...(context.relatedContextRefs
      ? { relatedContextRefs: [...context.relatedContextRefs] }
      : {}),
    privacy: pickPrivacy(context.privacy),
  };
  assertValidPersistableContext(canonical);
  return canonical;
}

function pickWorkContextPatch(
  patch: WorkContextPatchInput
): WorkContextPatchInput {
  return {
    ...(patch.title !== undefined ? { title: patch.title } : {}),
    ...(patch.source !== undefined ? { source: patch.source } : {}),
    ...(patch.anchors !== undefined ? { anchors: patch.anchors } : {}),
    ...(patch.actors !== undefined ? { actors: patch.actors } : {}),
    ...(patch.tasks !== undefined ? { tasks: patch.tasks } : {}),
    ...(patch.artifacts !== undefined ? { artifacts: patch.artifacts } : {}),
    ...(patch.auditRefs !== undefined ? { auditRefs: patch.auditRefs } : {}),
    ...(patch.capabilityGrants !== undefined
      ? { capabilityGrants: patch.capabilityGrants }
      : {}),
    ...(patch.relatedContextRefs !== undefined
      ? { relatedContextRefs: patch.relatedContextRefs }
      : {}),
    ...(patch.privacy !== undefined ? { privacy: patch.privacy } : {}),
  };
}

function withoutUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, child]) => child !== undefined)
  ) as T;
}

function pickPrivacy(privacy: WorkContext['privacy']): WorkContext['privacy'] {
  return {
    classification: privacy.classification,
    retention: privacy.retention,
    rawPayloadStored: privacy.rawPayloadStored,
    redaction: {
      redacted: privacy.redaction.redacted,
      strategy: privacy.redaction.strategy,
      classes: [...privacy.redaction.classes],
      ...(privacy.redaction.byteCount !== undefined
        ? { byteCount: privacy.redaction.byteCount }
        : {}),
      ...(privacy.redaction.charCount !== undefined
        ? { charCount: privacy.redaction.charCount }
        : {}),
      ...(privacy.redaction.lineCount !== undefined
        ? { lineCount: privacy.redaction.lineCount }
        : {}),
      ...(privacy.redaction.hashSha256
        ? { hashSha256: privacy.redaction.hashSha256 }
        : {}),
      ...(privacy.redaction.preview
        ? { preview: privacy.redaction.preview }
        : {}),
    },
    ...(privacy.policyRefs ? { policyRefs: [...privacy.policyRefs] } : {}),
  };
}

function pickAnchors(anchors: WorkContext['anchors']): WorkContext['anchors'] {
  const node = anchors.node
    ? withoutUndefined({
        nodeId: anchors.node.nodeId,
        kind: anchors.node.kind,
        displayName: anchors.node.displayName,
        online: anchors.node.online,
      })
    : undefined;
  const session = anchors.session
    ? withoutUndefined({
        nodeId: anchors.session.nodeId,
        sessionId: anchors.session.sessionId,
        globalSessionId: anchors.session.globalSessionId,
        tabId: anchors.session.tabId,
        tabKind: anchors.session.tabKind,
        cwd: anchors.session.cwd,
        agent: anchors.session.agent,
        controlMode: anchors.session.controlMode,
      })
    : undefined;
  const project = anchors.project
    ? withoutUndefined({
        workspaceId: anchors.project.workspaceId,
        projectId: anchors.project.projectId,
        instanceId: anchors.project.instanceId,
        benchId: anchors.project.benchId,
      })
    : undefined;
  const repo = anchors.repo
    ? withoutUndefined({
        repoIdentity: anchors.repo.repoIdentity,
        repoInstanceId: anchors.repo.repoInstanceId,
        ownerRepo: anchors.repo.ownerRepo,
        remoteUrl: anchors.repo.remoteUrl,
        localPath: anchors.repo.localPath,
        branchName: anchors.repo.branchName,
      })
    : undefined;
  const worktree = anchors.worktree
    ? withoutUndefined({
        worktreeInstanceId: anchors.worktree.worktreeInstanceId,
        localPath: anchors.worktree.localPath,
        branchName: anchors.worktree.branchName,
      })
    : undefined;
  return withoutUndefined({
    node,
    session,
    project,
    repo,
    worktree,
  }) as WorkContext['anchors'];
}

function pickActor(
  actor: WorkContext['actors'][number]
): WorkContext['actors'][number] {
  return {
    kind: actor.kind,
    id: actor.id,
    ...(actor.displayName ? { displayName: actor.displayName } : {}),
    ...(actor.providerId ? { providerId: actor.providerId } : {}),
    ...(actor.nodeId ? { nodeId: actor.nodeId } : {}),
    ...(actor.sessionId ? { sessionId: actor.sessionId } : {}),
    ...(actor.privacy ? { privacy: pickPrivacy(actor.privacy) } : {}),
  };
}

function pickTask(
  task: WorkContext['tasks'][number]
): WorkContext['tasks'][number] {
  return {
    kind: task.kind,
    id: task.id,
    ...(task.title ? { title: task.title } : {}),
    ...(task.url ? { url: task.url } : {}),
    ...(task.status ? { status: task.status } : {}),
    ...(task.parentRef ? { parentRef: task.parentRef } : {}),
    ...(task.privacy ? { privacy: pickPrivacy(task.privacy) } : {}),
  };
}

function pickArtifact(
  artifact: WorkContext['artifacts'][number]
): WorkContext['artifacts'][number] {
  return {
    id: artifact.id,
    kind: artifact.kind,
    ...(artifact.title ? { title: artifact.title } : {}),
    ...(artifact.uri ? { uri: artifact.uri } : {}),
    ...(artifact.path ? { path: artifact.path } : {}),
    ...(artifact.mediaType ? { mediaType: artifact.mediaType } : {}),
    ...(artifact.producedByActorId
      ? { producedByActorId: artifact.producedByActorId }
      : {}),
    ...(artifact.producedAt ? { producedAt: artifact.producedAt } : {}),
    ...(artifact.summary ? { summary: artifact.summary } : {}),
    privacy: pickPrivacy(artifact.privacy),
  };
}

function pickAuditRef(
  auditRef: WorkContext['auditRefs'][number]
): WorkContext['auditRefs'][number] {
  return {
    id: auditRef.id,
    eventId: auditRef.eventId,
    ...(auditRef.type ? { type: auditRef.type } : {}),
    ...(auditRef.occurredAt ? { occurredAt: auditRef.occurredAt } : {}),
    ...(auditRef.actorId ? { actorId: auditRef.actorId } : {}),
    ...(auditRef.correlationId
      ? { correlationId: auditRef.correlationId }
      : {}),
    ...(auditRef.chainHash ? { chainHash: auditRef.chainHash } : {}),
    ...(auditRef.logRef ? { logRef: auditRef.logRef } : {}),
    privacy: pickPrivacy(auditRef.privacy),
  };
}

function pickCapabilityGrant(
  grant: WorkContext['capabilityGrants'][number]
): WorkContext['capabilityGrants'][number] {
  return {
    id: grant.id,
    ref: grant.ref,
    ...(grant.capability ? { capability: grant.capability } : {}),
    ...(grant.capabilities ? { capabilities: [...grant.capabilities] } : {}),
    ...(grant.decision ? { decision: grant.decision } : {}),
    policyClass: grant.policyClass,
    ...(grant.scope
      ? {
          scope: {
            kind: grant.scope.kind,
            ...(grant.scope.workspaceIds
              ? { workspaceIds: [...grant.scope.workspaceIds] }
              : {}),
            ...(grant.scope.repoIds
              ? { repoIds: [...grant.scope.repoIds] }
              : {}),
            ...(grant.scope.pathPrefixes
              ? { pathPrefixes: [...grant.scope.pathPrefixes] }
              : {}),
          },
        }
      : {}),
    ...(grant.actorId ? { actorId: grant.actorId } : {}),
    ...(grant.auditEventId ? { auditEventId: grant.auditEventId } : {}),
    privacy: pickPrivacy(grant.privacy),
  };
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

function contextWithSessionAssociationEvent(
  context: WorkContext,
  sessionRef: SessionRef,
  associatedAt: string
): WorkContext {
  return contextWithLifecycleEvent(
    context,
    {
      eventId: `session:${sessionRef.nodeId}:${sessionRef.sessionId}:associated`,
      type: 'session.associated',
      occurredAt: associatedAt,
      summary: `Associated ${sessionRef.agent ?? sessionRef.tabKind} session ${sessionRef.sessionId} on ${sessionRef.nodeId}`,
    },
    associatedAt
  );
}

function contextWithLifecycleEvent(
  context: WorkContext,
  input: WorkContextLifecycleEventInput,
  now: string
): WorkContext {
  if (input.type !== undefined && !LIFECYCLE_EVENT_TYPES.has(input.type)) {
    throw new WorkContextStoreError(400, 'invalid_lifecycle_event_type');
  }
  const occurredAt = input.occurredAt ?? now;
  if (Number.isNaN(Date.parse(occurredAt))) {
    throw new WorkContextStoreError(400, 'invalid_lifecycle_occurred_at');
  }
  const eventId =
    input.eventId ??
    `work-context:${context.id}:${crypto.randomBytes(8).toString('hex')}`;
  const auditRef: AuditEventRef = {
    id: `audit-ref:${eventId}`,
    eventId,
    ...(input.type ? { type: input.type } : {}),
    occurredAt,
    ...(input.actorId ? { actorId: input.actorId } : {}),
    ...(input.correlationId ? { correlationId: input.correlationId } : {}),
    ...(input.logRef ? { logRef: input.logRef } : {}),
    privacy: createWorkContextPrivacyMetadata({
      classification: 'internal',
      retention: 'audit',
      redaction: {
        redacted: true,
        strategy: 'summary',
        classes: ['payload', 'transcript', 'log'],
      },
    }),
  };
  const artifacts = [
    ...context.artifacts,
    ...safeLifecycleArtifacts(input, eventId, occurredAt),
  ];
  const auditRefs = upsertAuditRef(context.auditRefs, auditRef);
  const updated: WorkContext = {
    ...context,
    artifacts: dedupeById(artifacts),
    auditRefs,
    updatedAt: now,
  };
  return updated;
}

function safeLifecycleArtifacts(
  input: WorkContextLifecycleEventInput,
  eventId: string,
  occurredAt: string
): ArtifactRef[] {
  const artifacts = input.artifacts ?? [];
  const summaryArtifact: ArtifactRef[] = input.summary
    ? [
        {
          id: `artifact-ref:${eventId}:summary`,
          kind: 'report',
          title: 'Lifecycle summary',
          summary: input.summary,
          ...(input.actorId ? { producedByActorId: input.actorId } : {}),
          producedAt: occurredAt,
          privacy: createWorkContextPrivacyMetadata({
            classification: 'internal',
            retention: 'session',
            redaction: {
              redacted: true,
              strategy: 'summary',
              classes: ['payload', 'transcript', 'log'],
            },
          }),
        },
      ]
    : [];
  return [...artifacts, ...summaryArtifact];
}

function upsertAuditRef(
  refs: AuditEventRef[],
  ref: AuditEventRef
): AuditEventRef[] {
  return dedupeById([...refs, ref]);
}

function dedupeById<T extends { id: string }>(items: T[]): T[] {
  const byId = new Map<string, T>();
  for (const item of items) byId.set(item.id, item);
  return Array.from(byId.values());
}

export function sessionSummaryToRef(session: SessionSummary): SessionRef {
  const nodeId = session.nodeId ?? DEFAULT_LOCAL_NODE_ID;
  const globalSessionId =
    session.globalSessionId ?? createGlobalSessionId(nodeId, session.id);
  const tabKind: WorkContextTabKind =
    session.type === 'terminal' ? 'terminal' : 'agent';
  return {
    nodeId,
    sessionId: session.id,
    globalSessionId,
    tabKind,
    cwd: session.cwd,
    ...(session.agent ? { agent: session.agent } : {}),
    ...(session.controlMode ? { controlMode: session.controlMode } : {}),
  };
}

function sessionRefFromBody(body: SessionRefBody): SessionRef {
  if (!body.cwd)
    throw new WorkContextStoreError(
      400,
      'cwd is required for offline session refs'
    );
  const nodeId = body.nodeId ?? DEFAULT_LOCAL_NODE_ID;
  return {
    nodeId,
    sessionId: body.sessionId,
    ...(body.globalSessionId ? { globalSessionId: body.globalSessionId } : {}),
    ...(body.tabId ? { tabId: body.tabId } : {}),
    tabKind: body.tabKind ?? 'terminal',
    cwd: body.cwd,
    ...(body.agent ? { agent: body.agent } : {}),
    ...(body.controlMode ? { controlMode: body.controlMode } : {}),
  };
}

function findLiveSessionForAssociation(
  sessions: SessionSummary[],
  body: { sessionId?: string; nodeId?: string }
): SessionSummary | undefined {
  if (!body.sessionId) return undefined;
  return sessions.find((session) => {
    const nodeId = session.nodeId ?? DEFAULT_LOCAL_NODE_ID;
    if (body.nodeId && nodeId !== body.nodeId) return false;
    return (
      session.id === body.sessionId ||
      session.globalSessionId === body.sessionId
    );
  });
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
      const live =
        sessionsByKey.get(key) ??
        (link.global_session_id
          ? sessionsByKey.get(link.global_session_id)
          : undefined);
      return summarizeLinkedSession(link, live);
    });

    const node = nodeStateForContext(context, groupSessions, nodesById);
    groups.push({
      id: context.id,
      context,
      node,
      sessions: groupSessions,
      staleReadModel:
        node.status !== 'online' || groupSessions.some((s) => !s.live),
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

function resumeSnapshotFromGroup(
  group: WorkContextActiveGroup
): WorkContextResumeSnapshot {
  if (!group.context)
    throw new WorkContextStoreError(404, 'work_context_not_found');
  const context = group.context;
  return {
    workContext: {
      id: context.id,
      ...(context.title ? { title: context.title } : {}),
      source: context.source,
      createdAt: context.createdAt,
      updatedAt: context.updatedAt,
      anchors: context.anchors,
      actors: context.actors,
      tasks: context.tasks,
      ...(context.relatedContextRefs
        ? { relatedContextRefs: context.relatedContextRefs }
        : {}),
    },
    node: group.node,
    sessions: group.sessions.slice(0, MAX_RESUME_SESSIONS),
    artifacts: context.artifacts.slice(-MAX_RESUME_ARTIFACTS),
    auditRefs: context.auditRefs.slice(-MAX_RESUME_AUDIT_REFS),
    privacy: {
      mode: 'compact-refs',
      rawPayloadAvailable: false,
      transcriptExportAvailable: false,
      rawTranscriptIncluded: false,
    },
  };
}

function buildSessionLookup(
  sessions: SessionSummary[]
): Map<string, SessionSummary> {
  const lookup = new Map<string, SessionSummary>();
  for (const session of sessions) {
    const nodeId = session.nodeId ?? DEFAULT_LOCAL_NODE_ID;
    lookup.set(sessionKey(nodeId, session.id), session);
    if (session.globalSessionId) lookup.set(session.globalSessionId, session);
  }
  return lookup;
}

function groupLinksByContext(
  links: SessionLinkRow[]
): Map<string, SessionLinkRow[]> {
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
    ...(ref.agent ? { agent: ref.agent } : {}),
    cwd: ref.cwd,
    ...(ref.controlMode ? { controlMode: ref.controlMode } : {}),
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
    ...(session.globalSessionId
      ? { globalSessionId: session.globalSessionId }
      : {}),
    tabKind: session.type === 'terminal' ? 'terminal' : 'agent',
    type: session.type,
    mode: session.mode,
    agent: session.agent,
    cwd: session.cwd,
    ...(session.repoPath ? { repoPath: session.repoPath } : {}),
    ...(session.worktreePath !== undefined
      ? { worktreePath: session.worktreePath }
      : {}),
    ...(session.repoName ? { repoName: session.repoName } : {}),
    ...(session.branchName ? { branchName: session.branchName } : {}),
    displayName: session.displayName,
    status: session.status,
    agentState: session.agentState,
    ...(session.currentActivity
      ? { currentActivity: session.currentActivity }
      : {}),
    ...(session.controlMode ? { controlMode: session.controlMode } : {}),
    ...(session.activeActors ? { activeActors: session.activeActors } : {}),
    ...(session.activeWorker ? { activeWorker: session.activeWorker } : {}),
    ...(session.lastInterventionAt !== undefined
      ? { lastInterventionAt: session.lastInterventionAt }
      : {}),
    ...(session.lastInterventionBy !== undefined
      ? { lastInterventionBy: session.lastInterventionBy }
      : {}),
    ...(session.lastInterventionEventId !== undefined
      ? { lastInterventionEventId: session.lastInterventionEventId }
      : {}),
    ...(session.controlFreshness
      ? { controlFreshness: session.controlFreshness }
      : {}),
    ...(session.controlReason ? { controlReason: session.controlReason } : {}),
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
    context.anchors.node?.nodeId ??
    sessions[0]?.nodeId ??
    DEFAULT_LOCAL_NODE_ID;
  const state = nodeStateForNodeId(nodeId, nodesById);
  if (context.anchors.node?.displayName || context.anchors.node?.kind) {
    return {
      ...state,
      ...(context.anchors.node.displayName
        ? { displayName: context.anchors.node.displayName }
        : {}),
      ...(context.anchors.node.kind ? { kind: context.anchors.node.kind } : {}),
    };
  }
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
    return {
      nodeId,
      status: 'online',
      displayName: 'Local node',
      kind: 'local',
    };
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
