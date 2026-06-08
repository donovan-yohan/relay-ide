import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';

import Database from 'better-sqlite3';

import {
  PIPELINE_HANDOFF_STAGES,
  isPipelineHandoffArtifact,
  sanitizePipelineHandoffArtifactForPublic,
  validatePipelineHandoffArtifact,
  validatePublicPipelineHandoffArtifact,
  type PipelineHandoffArtifact,
  type PipelineHandoffStageName,
} from '../shared/pipeline-handoff-artifact.js';
import {
  ARTIFACT_KINDS,
  type ArtifactKind,
  type TaskRef,
  type WorkContextId,
} from '../shared/work-context.js';

const SCHEMA_VERSION = 1;
const DEFAULT_PAYLOAD_MEDIA_TYPE = 'application/json';
const DEFAULT_VISIBILITY: WorkContextArtifactVisibility = 'private';
const VISIBILITIES = new Set<string>(['private', 'public']);
const STAGES = new Set<string>(PIPELINE_HANDOFF_STAGES);
const SECRET_TEXT_RE =
  /(?:bearer\s+[a-z0-9._~+/-]+=*|sk-[a-z0-9_-]{8,}|relay-(?:sac|ohg|grant|auth|pair)-v1[a-z0-9._-]*|pair_[a-z0-9_-]{8,}|node_[a-z0-9._~+/=-]+\.secret_[a-z0-9._~+/=-]+|secret_[a-z0-9._~+/=-]+)/gi;
const ABSOLUTE_LOCAL_PATH_RE =
  /(?:^|[\s:=('"])(?:\/home\/[^\s)'"]+|\/Users\/[^\s)'"]+|\/tmp\/[^\s)'"]+)/g;
const WINDOWS_ABSOLUTE_PATH_RE = /(?:^|[\s:=('"])[a-z]:[\\/][^\s)'"]+/gi;
const UNC_PATH_RE = /(?:^|[\s:=('"])\\\\[^\s\\/'"]+[\\/][^\s)'"]+/g;
const KANBAN_TASK_ID_RE = /\bt_[a-f0-9]{8,}\b/gi;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS work_context_artifacts (
  id                    TEXT PRIMARY KEY,
  work_context_id       TEXT NOT NULL,
  project_id            TEXT,
  task_ref_kind         TEXT NOT NULL,
  task_ref_id           TEXT NOT NULL,
  stage                 TEXT,
  provenance_actor_id   TEXT,
  kind                  TEXT NOT NULL,
  title                 TEXT NOT NULL,
  summary               TEXT NOT NULL,
  visibility            TEXT NOT NULL,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  captured_at           TEXT NOT NULL,
  payload_kind          TEXT NOT NULL,
  payload_media_type    TEXT NOT NULL,
  payload_path          TEXT NOT NULL,
  payload_sha256        TEXT NOT NULL,
  payload_bytes         INTEGER NOT NULL,
  pr_number             INTEGER,
  head_sha              TEXT,
  base_name             TEXT,
  branch_name           TEXT,
  supersedes_artifact_id TEXT,
  metadata_json         TEXT NOT NULL,
  CHECK (visibility IN ('private', 'public'))
);
CREATE INDEX IF NOT EXISTS idx_work_context_artifacts_context
  ON work_context_artifacts(work_context_id, captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_work_context_artifacts_task_ref
  ON work_context_artifacts(task_ref_kind, task_ref_id, captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_work_context_artifacts_project
  ON work_context_artifacts(project_id, captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_work_context_artifacts_head
  ON work_context_artifacts(head_sha);
CREATE INDEX IF NOT EXISTS idx_work_context_artifacts_supersedes
  ON work_context_artifacts(supersedes_artifact_id);
`;

export type WorkContextArtifactVisibility = 'private' | 'public';
export type WorkContextArtifactPayloadKind = 'pipeline-handoff-artifact';

export interface WorkContextArtifactIndexInput {
  id?: string;
  workContextId: WorkContextId;
  projectId?: string;
  taskRef?: TaskRef;
  stage?: PipelineHandoffStageName;
  provenanceActorId?: string;
  visibility?: WorkContextArtifactVisibility;
  kind?: ArtifactKind;
  title?: string;
  summary?: string;
  capturedAt?: string;
  supersedesArtifactId?: string;
}

export interface StorePipelineHandoffArtifactInput extends WorkContextArtifactIndexInput {
  artifact: PipelineHandoffArtifact;
}

export interface WorkContextArtifactMetadata {
  id: string;
  workContextId: WorkContextId;
  projectId?: string;
  taskRef: TaskRef;
  stage?: PipelineHandoffStageName;
  provenanceActorId?: string;
  kind: ArtifactKind;
  title: string;
  summary: string;
  visibility: WorkContextArtifactVisibility;
  createdAt: string;
  updatedAt: string;
  capturedAt: string;
  payloadKind: WorkContextArtifactPayloadKind;
  payloadMediaType: string;
  payloadSha256: string;
  payloadBytes: number;
  prNumber?: number;
  headSha?: string;
  baseName?: string;
  branchName?: string;
  supersedesArtifactId?: string;
}

export interface WorkContextArtifactRecord {
  metadata: WorkContextArtifactMetadata;
  payloadPath: string;
}

export interface WorkContextArtifactReadResult extends WorkContextArtifactRecord {
  payload?: PipelineHandoffArtifact;
}

export interface PublicWorkContextArtifactSummary {
  id: string;
  workContextId: WorkContextId;
  projectId?: string;
  taskRef?: Pick<TaskRef, 'kind' | 'id' | 'title' | 'url' | 'status'>;
  stage?: PipelineHandoffStageName;
  kind: ArtifactKind;
  title: string;
  summary: string;
  visibility: WorkContextArtifactVisibility;
  capturedAt: string;
  payloadKind: WorkContextArtifactPayloadKind;
  payloadSha256: string;
  payloadBytes: number;
  prNumber?: number;
  headSha?: string;
  baseName?: string;
  branchName?: string;
  supersedesArtifactId?: string;
}

export interface PublicWorkContextArtifactReadResult {
  metadata: PublicWorkContextArtifactSummary;
  payload?: PipelineHandoffArtifact;
}

export interface WorkContextArtifactListInput {
  workContextId?: WorkContextId;
  projectId?: string;
  taskRef?: Pick<TaskRef, 'kind' | 'id'>;
  stage?: PipelineHandoffStageName;
  includeSuperseded?: boolean;
  limit?: number;
}

export interface WorkContextArtifactStore {
  close(): void;
  storePipelineHandoffArtifact(input: StorePipelineHandoffArtifactInput): WorkContextArtifactRecord;
  get(id: string): WorkContextArtifactRecord | null;
  read(id: string): WorkContextArtifactReadResult | null;
  list(input?: WorkContextArtifactListInput): WorkContextArtifactRecord[];
  publicSummary(id: string): PublicWorkContextArtifactReadResult | null;
}

interface WorkContextArtifactRow {
  id: string;
  work_context_id: string;
  project_id: string | null;
  task_ref_kind: string;
  task_ref_id: string;
  stage: string | null;
  provenance_actor_id: string | null;
  kind: string;
  title: string;
  summary: string;
  visibility: WorkContextArtifactVisibility;
  created_at: string;
  updated_at: string;
  captured_at: string;
  payload_kind: WorkContextArtifactPayloadKind;
  payload_media_type: string;
  payload_path: string;
  payload_sha256: string;
  payload_bytes: number;
  pr_number: number | null;
  head_sha: string | null;
  base_name: string | null;
  branch_name: string | null;
  supersedes_artifact_id: string | null;
  metadata_json: string;
}

interface PersistedMetadataJson {
  taskRef: TaskRef;
}

export class WorkContextArtifactStoreError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message = code) {
    super(message);
    this.name = 'WorkContextArtifactStoreError';
    this.status = status;
    this.code = code;
  }
}

export function initWorkContextArtifactStore(
  configDir: string
): WorkContextArtifactStore {
  return createWorkContextArtifactStore({
    dbPath: path.join(configDir, 'work-context-artifacts.db'),
    payloadRoot: path.join(configDir, 'work-context-artifacts', 'payloads'),
  });
}

export function createWorkContextArtifactStore(input: {
  dbPath: string;
  payloadRoot?: string;
}): WorkContextArtifactStore {
  mkdirSync(path.dirname(input.dbPath), { recursive: true });
  const payloadRoot = input.payloadRoot ?? path.join(path.dirname(input.dbPath), 'work-context-artifacts', 'payloads');
  mkdirSync(payloadRoot, { recursive: true });

  const db = new Database(input.dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.exec('CREATE TABLE IF NOT EXISTS work_context_artifact_schema_version (version INTEGER NOT NULL)');
  const schemaRow = db.prepare('SELECT version FROM work_context_artifact_schema_version').get() as
    | { version: number }
    | undefined;
  const hadSchemaRow = schemaRow !== undefined;
  if ((schemaRow?.version ?? 0) < SCHEMA_VERSION) {
    db.transaction(() => {
      db.exec(SCHEMA_SQL);
      if (hadSchemaRow) {
        db.prepare('UPDATE work_context_artifact_schema_version SET version = ?').run(SCHEMA_VERSION);
      } else {
        db.prepare('INSERT INTO work_context_artifact_schema_version (version) VALUES (?)').run(SCHEMA_VERSION);
      }
    })();
  }

  const insertArtifact = db.prepare(`
    INSERT INTO work_context_artifacts (
      id, work_context_id, project_id, task_ref_kind, task_ref_id, stage,
      provenance_actor_id, kind, title, summary, visibility, created_at,
      updated_at, captured_at, payload_kind, payload_media_type, payload_path,
      payload_sha256, payload_bytes, pr_number, head_sha, base_name,
      branch_name, supersedes_artifact_id, metadata_json
    ) VALUES (
      @id, @workContextId, @projectId, @taskRefKind, @taskRefId, @stage,
      @provenanceActorId, @kind, @title, @summary, @visibility, @createdAt,
      @updatedAt, @capturedAt, @payloadKind, @payloadMediaType, @payloadPath,
      @payloadSha256, @payloadBytes, @prNumber, @headSha, @baseName,
      @branchName, @supersedesArtifactId, @metadataJson
    )
  `);
  const selectById = db.prepare('SELECT * FROM work_context_artifacts WHERE id = ?');

  function mustNotAlreadyExist(id: string): void {
    if (selectById.get(id)) {
      throw new WorkContextArtifactStoreError(409, 'artifact_already_exists');
    }
  }

  function mustValidateSupersedes(id: string | undefined): void {
    if (!id) return;
    if (!selectById.get(id)) {
      throw new WorkContextArtifactStoreError(400, 'superseded_artifact_not_found');
    }
  }

  function writePayloadFile(payloadJson: string, sha256: string): string {
    const dir = path.join(payloadRoot, sha256.slice(0, 2), sha256.slice(2, 4));
    mkdirSync(dir, { recursive: true });
    const payloadPath = path.join(dir, `${sha256}.json`);
    if (!existsSync(payloadPath)) {
      try {
        writeFileSync(payloadPath, payloadJson, { flag: 'wx' });
      } catch (err) {
        if (!isFileExistsError(err)) throw err;
      }
    }
    return payloadPath;
  }

  function rowToRecord(row: WorkContextArtifactRow): WorkContextArtifactRecord {
    return {
      metadata: rowToMetadata(row),
      payloadPath: row.payload_path,
    };
  }

  function getRow(id: string): WorkContextArtifactRow | null {
    return (selectById.get(id) as WorkContextArtifactRow | undefined) ?? null;
  }

  return {
    close() {
      db.close();
    },

    storePipelineHandoffArtifact(storeInput: StorePipelineHandoffArtifactInput) {
      assertNonEmptyString(storeInput.workContextId, 'workContextId');
      if (storeInput.projectId !== undefined)
        assertNonEmptyString(storeInput.projectId, 'projectId');
      if (storeInput.stage !== undefined) assertValidStage(storeInput.stage);
      if (storeInput.provenanceActorId !== undefined)
        assertNonEmptyString(storeInput.provenanceActorId, 'provenanceActorId');
      if (storeInput.visibility !== undefined)
        assertValidVisibility(storeInput.visibility);
      if (storeInput.kind !== undefined) assertValidArtifactKind(storeInput.kind);
      if (storeInput.title !== undefined)
        assertNonEmptyString(storeInput.title, 'title');
      if (storeInput.summary !== undefined)
        assertNonEmptyString(storeInput.summary, 'summary');
      const validation = validatePipelineHandoffArtifact(storeInput.artifact);
      if (!validation.valid) {
        throw new WorkContextArtifactStoreError(
          400,
          'invalid_pipeline_handoff_artifact',
          validation.errors.join('; ')
        );
      }
      const artifactId = storeInput.id ?? storeInput.artifact.id ?? `artifact:${randomUUID()}`;
      mustNotAlreadyExist(artifactId);
      mustValidateSupersedes(storeInput.supersedesArtifactId);

      const taskRef = storeInput.taskRef ?? firstTaskRef(storeInput.artifact);
      if (!taskRef) {
        throw new WorkContextArtifactStoreError(400, 'task_ref_required');
      }
      assertValidTaskRef(taskRef);
      const now = new Date().toISOString();
      const capturedAt = storeInput.capturedAt ?? storeInput.artifact.head.capturedAt;
      assertIsoTimestamp(capturedAt, 'capturedAt');
      const payloadJson = JSON.stringify(storeInput.artifact, null, 2);
      const payloadSha256 = sha256Hex(payloadJson);
      const payloadPath = writePayloadFile(payloadJson, payloadSha256);
      const payloadBytes = Buffer.byteLength(payloadJson, 'utf8');
      const metadata: WorkContextArtifactMetadata = {
        id: artifactId,
        workContextId: storeInput.workContextId,
        ...(storeInput.projectId ? { projectId: storeInput.projectId } : {}),
        taskRef,
        ...(storeInput.stage ? { stage: storeInput.stage } : {}),
        ...(storeInput.provenanceActorId ? { provenanceActorId: storeInput.provenanceActorId } : {}),
        kind: storeInput.kind ?? 'report',
        title: storeInput.title ?? storeInput.artifact.title,
        summary: storeInput.summary ?? storeInput.artifact.scope.summary,
        visibility: storeInput.visibility ?? DEFAULT_VISIBILITY,
        createdAt: now,
        updatedAt: now,
        capturedAt,
        payloadKind: 'pipeline-handoff-artifact',
        payloadMediaType: DEFAULT_PAYLOAD_MEDIA_TYPE,
        payloadSha256,
        payloadBytes,
        ...(storeInput.artifact.head.pr?.number ? { prNumber: storeInput.artifact.head.pr.number } : {}),
        headSha: storeInput.artifact.head.headSha,
        baseName: storeInput.artifact.head.base.name,
        ...(storeInput.artifact.head.branch?.name ? { branchName: storeInput.artifact.head.branch.name } : {}),
        ...(storeInput.supersedesArtifactId ? { supersedesArtifactId: storeInput.supersedesArtifactId } : {}),
      };
      db.transaction(() => {
        insertArtifact.run({
          id: metadata.id,
          workContextId: metadata.workContextId,
          projectId: metadata.projectId ?? null,
          taskRefKind: metadata.taskRef.kind,
          taskRefId: metadata.taskRef.id,
          stage: metadata.stage ?? null,
          provenanceActorId: metadata.provenanceActorId ?? null,
          kind: metadata.kind,
          title: metadata.title,
          summary: metadata.summary,
          visibility: metadata.visibility,
          createdAt: metadata.createdAt,
          updatedAt: metadata.updatedAt,
          capturedAt: metadata.capturedAt,
          payloadKind: metadata.payloadKind,
          payloadMediaType: metadata.payloadMediaType,
          payloadPath,
          payloadSha256: metadata.payloadSha256,
          payloadBytes: metadata.payloadBytes,
          prNumber: metadata.prNumber ?? null,
          headSha: metadata.headSha ?? null,
          baseName: metadata.baseName ?? null,
          branchName: metadata.branchName ?? null,
          supersedesArtifactId: metadata.supersedesArtifactId ?? null,
          metadataJson: JSON.stringify({ taskRef: metadata.taskRef } satisfies PersistedMetadataJson),
        });
      })();
      return { metadata, payloadPath };
    },

    get(id: string) {
      const row = getRow(id);
      return row ? rowToRecord(row) : null;
    },

    read(id: string) {
      const row = getRow(id);
      if (!row) return null;
      const record = rowToRecord(row);
      const raw = readFileSync(row.payload_path, 'utf8');
      const payload = JSON.parse(raw) as unknown;
      if (!isPipelineHandoffArtifact(payload)) {
        throw new WorkContextArtifactStoreError(500, 'stored_payload_invalid');
      }
      return { ...record, payload };
    },

    list(input: WorkContextArtifactListInput = {}) {
      const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
      const clauses: string[] = [];
      const params: Record<string, unknown> = { limit };
      if (input.workContextId) {
        clauses.push('work_context_id = @workContextId');
        params.workContextId = input.workContextId;
      }
      if (input.projectId) {
        clauses.push('project_id = @projectId');
        params.projectId = input.projectId;
      }
      if (input.taskRef) {
        clauses.push('task_ref_kind = @taskRefKind AND task_ref_id = @taskRefId');
        params.taskRefKind = input.taskRef.kind;
        params.taskRefId = input.taskRef.id;
      }
      if (input.stage) {
        clauses.push('stage = @stage');
        params.stage = input.stage;
      }
      if (!input.includeSuperseded) {
        clauses.push('NOT EXISTS (SELECT 1 FROM work_context_artifacts newer WHERE newer.supersedes_artifact_id = work_context_artifacts.id)');
      }
      const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
      const rows = db.prepare(`SELECT * FROM work_context_artifacts ${where} ORDER BY captured_at DESC, created_at DESC LIMIT @limit`).all(params) as WorkContextArtifactRow[];
      return rows.map(rowToRecord);
    },

    publicSummary(id: string) {
      const row = getRow(id);
      if (!row) return null;
      const metadata = publicMetadata(rowToMetadata(row));
      const raw = readFileSync(row.payload_path, 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      if (!isPipelineHandoffArtifact(parsed)) {
        throw new WorkContextArtifactStoreError(500, 'stored_payload_invalid');
      }
      const payload = sanitizePipelineHandoffArtifactForPublic(parsed);
      const publicValidation = validatePublicPipelineHandoffArtifact(payload);
      if (!publicValidation.valid) {
        throw new WorkContextArtifactStoreError(
          500,
          'public_artifact_sanitization_failed',
          publicValidation.errors.join('; ')
        );
      }
      return { metadata, payload };
    },
  };
}

function rowToMetadata(row: WorkContextArtifactRow): WorkContextArtifactMetadata {
  const json = JSON.parse(row.metadata_json) as PersistedMetadataJson;
  return {
    id: row.id,
    workContextId: row.work_context_id,
    ...(row.project_id ? { projectId: row.project_id } : {}),
    taskRef: json.taskRef,
    ...(row.stage ? { stage: row.stage as PipelineHandoffStageName } : {}),
    ...(row.provenance_actor_id ? { provenanceActorId: row.provenance_actor_id } : {}),
    kind: row.kind as ArtifactKind,
    title: row.title,
    summary: row.summary,
    visibility: row.visibility,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    capturedAt: row.captured_at,
    payloadKind: row.payload_kind,
    payloadMediaType: row.payload_media_type,
    payloadSha256: row.payload_sha256,
    payloadBytes: row.payload_bytes,
    ...(row.pr_number !== null ? { prNumber: row.pr_number } : {}),
    ...(row.head_sha ? { headSha: row.head_sha } : {}),
    ...(row.base_name ? { baseName: row.base_name } : {}),
    ...(row.branch_name ? { branchName: row.branch_name } : {}),
    ...(row.supersedes_artifact_id ? { supersedesArtifactId: row.supersedes_artifact_id } : {}),
  };
}

function publicMetadata(
  metadata: WorkContextArtifactMetadata
): PublicWorkContextArtifactSummary {
  const taskRef = ['github-issue', 'github-pr'].includes(metadata.taskRef.kind)
    ? {
        kind: metadata.taskRef.kind,
        id: sanitizePublicText(metadata.taskRef.id),
        ...(metadata.taskRef.title ? { title: sanitizePublicText(metadata.taskRef.title) } : {}),
        ...(metadata.taskRef.url ? { url: sanitizePublicText(metadata.taskRef.url) } : {}),
        ...(metadata.taskRef.status ? { status: sanitizePublicText(metadata.taskRef.status) } : {}),
      }
    : undefined;
  return {
    id: sanitizePublicText(metadata.id),
    workContextId: sanitizePublicText(metadata.workContextId),
    ...(metadata.projectId ? { projectId: sanitizePublicText(metadata.projectId) } : {}),
    ...(taskRef ? { taskRef } : {}),
    ...(metadata.stage ? { stage: metadata.stage } : {}),
    kind: metadata.kind,
    title: sanitizePublicText(metadata.title),
    summary: sanitizePublicText(metadata.summary),
    visibility: metadata.visibility,
    capturedAt: metadata.capturedAt,
    payloadKind: metadata.payloadKind,
    payloadSha256: metadata.payloadSha256,
    payloadBytes: metadata.payloadBytes,
    ...(metadata.prNumber ? { prNumber: metadata.prNumber } : {}),
    ...(metadata.headSha ? { headSha: metadata.headSha } : {}),
    ...(metadata.baseName ? { baseName: sanitizePublicText(metadata.baseName) } : {}),
    ...(metadata.branchName ? { branchName: sanitizePublicText(metadata.branchName) } : {}),
    ...(metadata.supersedesArtifactId
      ? { supersedesArtifactId: sanitizePublicText(metadata.supersedesArtifactId) }
      : {}),
  };
}

function firstTaskRef(artifact: PipelineHandoffArtifact): TaskRef | undefined {
  return (
    artifact.scope.taskRefs.find((taskRef) => taskRef.kind === 'github-issue') ??
    artifact.scope.taskRefs.find((taskRef) => taskRef.kind === 'github-pr') ??
    artifact.scope.taskRefs[0]
  );
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function assertIsoTimestamp(value: string, label: string): void {
  if (Number.isNaN(Date.parse(value))) {
    throw new WorkContextArtifactStoreError(400, `${label}_invalid`);
  }
}

function assertNonEmptyString(value: string, label: string): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new WorkContextArtifactStoreError(400, `${label}_required`);
  }
}

function assertValidStage(value: string): void {
  if (!STAGES.has(value)) {
    throw new WorkContextArtifactStoreError(400, 'stage_invalid');
  }
}

function assertValidVisibility(value: string): void {
  if (!VISIBILITIES.has(value)) {
    throw new WorkContextArtifactStoreError(400, 'visibility_invalid');
  }
}

function assertValidArtifactKind(value: string): void {
  if (!ARTIFACT_KINDS.has(value)) {
    throw new WorkContextArtifactStoreError(400, 'artifact_kind_invalid');
  }
}

function assertValidTaskRef(value: TaskRef): void {
  assertNonEmptyString(value.kind, 'taskRef.kind');
  assertNonEmptyString(value.id, 'taskRef.id');
}

function sanitizePublicText(value: string): string {
  SECRET_TEXT_RE.lastIndex = 0;
  ABSOLUTE_LOCAL_PATH_RE.lastIndex = 0;
  WINDOWS_ABSOLUTE_PATH_RE.lastIndex = 0;
  UNC_PATH_RE.lastIndex = 0;
  KANBAN_TASK_ID_RE.lastIndex = 0;
  return value
    .replace(SECRET_TEXT_RE, '[redacted-secret]')
    .replace(ABSOLUTE_LOCAL_PATH_RE, (match) => {
      const prefix = " \t:=('\"".includes(match[0] ?? '') ? match[0] : '';
      return `${prefix}[redacted-local-path]`;
    })
    .replace(WINDOWS_ABSOLUTE_PATH_RE, (match) => {
      const prefix = " \t:=('\"".includes(match[0] ?? '') ? match[0] : '';
      return `${prefix}[redacted-local-path]`;
    })
    .replace(UNC_PATH_RE, (match) => {
      const prefix = " \t:=('\"".includes(match[0] ?? '') ? match[0] : '';
      return `${prefix}[redacted-local-path]`;
    })
    .replace(KANBAN_TASK_ID_RE, '[redacted-kanban-task]');
}

function isFileExistsError(err: unknown): boolean {
  return isRecord(err) && err.code === 'EEXIST';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
