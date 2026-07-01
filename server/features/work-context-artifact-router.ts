import { existsSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { Router } from 'express';
import type { Request, RequestHandler, Response } from 'express';

import type { RelayCliGatewayErrorCode } from '../../shared/cli-gateway-contract.js';
import { stableJsonEquals } from '../../shared/stable-json.js';
import {
  ARTIFACT_KINDS,
  createWorkContextPrivacyMetadata,
  type ArtifactKind,
  type ArtifactRef,
  type TaskRef,
  type WorkContext,
  type WorkContextId,
} from '../../shared/work-context.js';
import {
  isPipelineHandoffArtifact,
  type PipelineHandoffArtifact,
  type PipelineHandoffStageName,
} from '../../shared/pipeline-handoff-artifact.js';
import {
  AGENT_VIEW_MAX_TOTAL_BYTES,
  validateAgentViewArtifact,
  type ViewArtifactPackage,
} from '../../shared/agent-view-artifact.js';
import type { WorkContextStore } from '../work-contexts.js';
import type { CliGatewayEventBus } from '../cli-gateway-event-bus.js';
import {
  WORK_CONTEXT_ARTIFACT_SEARCH_MAX_LIMIT,
  WorkContextArtifactStoreError,
  type StoreAgentViewArtifactInput,
  type StorePipelineHandoffArtifactInput,
  type WorkContextArtifactListInput,
  type WorkContextArtifactMetadata,
  type WorkContextArtifactReadResult,
  type WorkContextArtifactRecord,
  type WorkContextArtifactStore,
  type WorkContextArtifactVisibility,
} from '../work-context-artifacts.js';
import {
  authenticatedCliGatewayActorCredential,
  type CliGatewayActorWriteCommand,
} from '../cli-gateway-actor-auth.js';

export const WORK_CONTEXT_ARTIFACT_URI_PREFIX =
  'relay://work-context-artifacts/';
const CONTEXT_READ = 'context:read';
const ARTIFACT_WRITE = 'artifact:write';
const STAGES = new Set(['implementation', 'qa', 'review', 'release']);
export const DEFAULT_WORK_CONTEXT_ARTIFACT_PUBLISH_MAX_BYTES = 1024 * 1024;
export const DEFAULT_WORK_CONTEXT_ARTIFACT_EXPORT_MAX_BYTES = 512 * 1024;

export interface WorkContextArtifactRouterDeps {
  store: WorkContextArtifactStore | null;
  workContextStore?: WorkContextStore;
  events?: Pick<CliGatewayEventBus, 'publish'>;
  requireAuth?: RequestHandler;
  requireReadAuth?: {
    list?: RequestHandler;
    show?: RequestHandler;
    export?: RequestHandler;
    handoffList?: RequestHandler;
    handoffShow?: RequestHandler;
    handoffCopy?: RequestHandler;
    doctor?: RequestHandler;
  };
  requireWriteAuth?: RequestHandler;
  requireWriteActorAuth?: (
    expectedCommand: CliGatewayActorWriteCommand,
    options?: {
      scopeForRequest?: (req: Request) =>
        | {
            workContextIds?: string[];
            repoIds?: string[];
            taskRefs?: string[];
          }
        | undefined;
      deferWorkContextScope?: boolean;
    }
  ) => RequestHandler;
  diagnostics?: {
    dbPath: string;
    payloadRoot: string;
    maxPublishBytes?: number;
    maxExportBytes?: number;
  };
}

interface GatewayErrorBody {
  error: {
    code: RelayCliGatewayErrorCode;
    message: string;
    retryable: boolean;
    details?: Record<string, unknown>;
  };
}

function artifactUri(id: string): string {
  return `${WORK_CONTEXT_ARTIFACT_URI_PREFIX}${encodeURIComponent(id)}`;
}

function artifactRefId(id: string): string {
  return `artifact:work-context-artifact:${id}`;
}

export function artifactRefForMetadata(
  metadata: WorkContextArtifactMetadata,
  actorId?: string
): ArtifactRef {
  const producedByActorId = actorId ?? metadata.provenanceActorId;
  return {
    id: artifactRefId(metadata.id),
    kind: metadata.kind,
    title: metadata.title,
    uri: artifactUri(metadata.id),
    ...(producedByActorId ? { producedByActorId } : {}),
    producedAt: new Date().toISOString(),
    summary: metadata.summary,
    privacy: createWorkContextPrivacyMetadata({
      classification: metadata.visibility === 'public' ? 'public' : 'internal',
      retention: 'project',
      rawPayloadStored: false,
      redaction: {
        redacted: true,
        strategy: 'summary',
        classes: ['payload', 'artifact'],
        hashSha256: metadata.payloadSha256,
      },
    }),
  };
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

function statusForCode(code: RelayCliGatewayErrorCode): number {
  switch (code) {
    case 'UNAUTHORIZED':
      return 401;
    case 'FORBIDDEN':
      return 403;
    case 'NOT_FOUND':
      return 404;
    case 'SESSION_CONFLICT':
      return 409;
    case 'SERVER_UNAVAILABLE':
      return 503;
    case 'INTERNAL':
      return 500;
    default:
      return 400;
  }
}

function gatewayErrorBody(
  code: RelayCliGatewayErrorCode,
  message: string,
  retryable: boolean,
  details?: Record<string, unknown>
): GatewayErrorBody {
  return {
    error: { code, message, retryable, ...(details ? { details } : {}) },
  };
}

function sendGatewayError(
  res: Response,
  code: RelayCliGatewayErrorCode,
  message: string,
  retryable = false,
  details?: Record<string, unknown>
): void {
  res
    .status(statusForCode(code))
    .json(gatewayErrorBody(code, message, retryable, details));
}

function denyUnauthorizedActorWorkContextScope(
  req: Request,
  res: Response,
  input: {
    workContextId: string;
    operation: string;
    artifactId?: string;
    redactWorkContextId?: boolean;
  }
): boolean {
  const credential = authenticatedCliGatewayActorCredential(req);
  const scopedWorkContextIds = credential?.scope.workContextIds;
  if (!scopedWorkContextIds?.length) return false;
  if (scopedWorkContextIds.includes(input.workContextId)) return false;
  sendGatewayError(
    res,
    'FORBIDDEN',
    'scoped CLI actor credential rejected: CLI_ACTOR_WRONG_WORK_CONTEXT_SCOPE',
    false,
    {
      reasonCode: 'CLI_ACTOR_WRONG_WORK_CONTEXT_SCOPE',
      operation: input.operation,
      ...(input.redactWorkContextId
        ? {}
        : { workContextId: input.workContextId }),
      ...(input.artifactId ? { artifactId: input.artifactId } : {}),
      credentialId: credential?.id ?? 'unknown',
    }
  );
  return true;
}

/**
 * Belt-and-suspenders (#1065 review): the hub-wide `q` search lane has no
 * workContextId to scope-check, so its safety today depends entirely on the
 * production `scopeForRequest` middleware wiring (`workContextScopeFromQuery`)
 * rejecting scoped actors before this handler runs. This is an in-handler
 * second gate that fails closed independent of that middleware wiring: any
 * scoped CLI actor credential is rejected for a q-only (no workContextId)
 * list/search request, regardless of what scope the middleware attached.
 */
function denyScopedActorHubWideSearch(
  req: Request,
  res: Response,
  operation: string
): boolean {
  const credential = authenticatedCliGatewayActorCredential(req);
  if (!credential?.scope.workContextIds?.length) return false;
  sendGatewayError(
    res,
    'FORBIDDEN',
    'scoped CLI actor credential rejected: CLI_ACTOR_MISSING_SCOPE',
    false,
    {
      reasonCode: 'CLI_ACTOR_MISSING_SCOPE',
      operation,
      credentialId: credential.id,
    }
  );
  return true;
}

function denyMissingCapability(
  req: Request,
  res: Response,
  required: readonly string[]
): boolean {
  const provided = parseCapabilityHeader(req.header('x-relay-capabilities'));
  const actorCredential = authenticatedCliGatewayActorCredential(req);
  for (const capability of actorCredential?.capabilities ?? [])
    provided.add(capability);
  const missing = required.filter((cap) => !provided.has(cap));
  if (missing.length === 0) return false;
  sendGatewayError(
    res,
    'FORBIDDEN',
    `missing required capability: ${missing[0]}`,
    false,
    {
      capability: missing[0],
      missingCapabilities: missing,
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

function writeScopeFromBody(
  req: Request
):
  | { workContextIds?: string[]; repoIds?: string[]; taskRefs?: string[] }
  | undefined {
  const body = bodyRecord(req);
  const workContextId = readString(body['workContextId']);
  const repoId = readString(body['repoId']) ?? readString(body['projectId']);
  const task = readTaskRef(body['taskRef']);
  const taskRef = task ? `${task.kind}:${task.id}` : undefined;
  return workContextId || repoId || taskRef
    ? {
        ...(workContextId ? { workContextIds: [workContextId] } : {}),
        ...(repoId ? { repoIds: [repoId] } : {}),
        ...(taskRef ? { taskRefs: [taskRef] } : {}),
      }
    : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0
    ? value
    : undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return undefined;
}

function readLimit(value: unknown): number | undefined {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim()
        ? Number(value)
        : undefined;
  if (parsed === undefined || !Number.isFinite(parsed)) return undefined;
  return Math.min(Math.max(Math.trunc(parsed), 1), 200);
}

/** Hard cap (#1065): `q`-driven searches never return more than this, regardless of the requested limit. */
function readSearchLimit(value: unknown): number {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim()
        ? Number(value)
        : undefined;
  if (parsed === undefined || !Number.isFinite(parsed)) {
    return WORK_CONTEXT_ARTIFACT_SEARCH_MAX_LIMIT;
  }
  return Math.min(
    Math.max(Math.trunc(parsed), 1),
    WORK_CONTEXT_ARTIFACT_SEARCH_MAX_LIMIT
  );
}

function readStage(value: unknown): PipelineHandoffStageName | undefined {
  return typeof value === 'string' && STAGES.has(value)
    ? (value as PipelineHandoffStageName)
    : undefined;
}

function readArtifactKind(value: unknown): ArtifactKind | undefined {
  return typeof value === 'string' && ARTIFACT_KINDS.has(value)
    ? (value as ArtifactKind)
    : undefined;
}

function readVisibility(
  value: unknown
): WorkContextArtifactVisibility | undefined {
  return value === 'private' || value === 'public' ? value : undefined;
}

function readTaskRef(value: unknown): TaskRef | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return undefined;
  const record = value as Record<string, unknown>;
  const kind = readString(record['kind']);
  const id = readString(record['id']);
  if (!kind || !id) return undefined;
  return {
    kind: kind as TaskRef['kind'],
    id,
    ...(readString(record['title'])
      ? { title: record['title'] as string }
      : {}),
    ...(readString(record['url']) ? { url: record['url'] as string } : {}),
    ...(readString(record['status'])
      ? { status: record['status'] as string }
      : {}),
  };
}

function readQueryTaskRef(
  req: Request
): Pick<TaskRef, 'kind' | 'id'> | undefined | 'invalid' {
  const kind = readString(
    req.query['taskRefKind'] ?? req.query['task-ref-kind']
  );
  const id = readString(req.query['taskRefId'] ?? req.query['task-ref-id']);
  if (!kind && !id) return undefined;
  if (!kind || !id) return 'invalid';
  return { kind: kind as TaskRef['kind'], id };
}

function currentHeadSha(
  req: Request,
  body?: Record<string, unknown>
): string | undefined {
  return (
    readString(body?.['currentHeadSha']) ??
    readString(body?.['expectedHeadSha']) ??
    readString(req.query['currentHeadSha'] ?? req.query['current-head-sha'])
  );
}

function staleness(
  metadata: WorkContextArtifactMetadata,
  current: string | undefined
): Record<string, unknown> | undefined {
  if (!current || !metadata.headSha) return undefined;
  return {
    stale: metadata.headSha !== current,
    staleIf: { headShaChanges: true },
    artifactHeadSha: metadata.headSha,
    currentHeadSha: current,
  };
}

function recordEnvelope(
  record: WorkContextArtifactRecord,
  current?: string
): Record<string, unknown> {
  const stale = staleness(record.metadata, current);
  return {
    metadata: record.metadata,
    ...(stale ? { staleness: stale } : {}),
  };
}

function readEnvelope(
  record: WorkContextArtifactReadResult,
  current?: string
): Record<string, unknown> {
  const stale = staleness(record.metadata, current);
  return {
    metadata: record.metadata,
    ...(record.payload ? { payload: record.payload } : {}),
    ...(stale ? { staleness: stale } : {}),
  };
}

function persistedArtifactPayloadBytes(
  artifact: PipelineHandoffArtifact
): number {
  return Buffer.byteLength(JSON.stringify(artifact, null, 2), 'utf8');
}

function persistedViewArtifactPayloadBytes(
  viewArtifact: ViewArtifactPackage
): number {
  return Buffer.byteLength(JSON.stringify(viewArtifact, null, 2), 'utf8');
}

function sameJson(left: unknown, right: unknown): boolean {
  return stableJsonEquals(left, right);
}

function ensureAppendOnlySupersedes(
  res: Response,
  store: WorkContextArtifactStore,
  input: {
    workContextId: WorkContextId;
    artifact: PipelineHandoffArtifact;
    supersedesArtifactId?: string;
    operation: string;
  }
): boolean {
  const { supersedesArtifactId } = input;
  if (!supersedesArtifactId) return true;
  let previous: WorkContextArtifactReadResult | null;
  try {
    previous = store.read(supersedesArtifactId);
  } catch (err) {
    if (err instanceof WorkContextArtifactStoreError) {
      mapStoreError(res, err, {
        operation: input.operation,
        artifactId: input.artifact.id,
        supersedesArtifactId,
      });
      return false;
    }
    sendGatewayError(
      res,
      'INTERNAL',
      'failed to read superseded WorkContext artifact',
      true,
      {
        reasonCode: 'WORK_CONTEXT_ARTIFACT_INTERNAL_ERROR',
        operation: input.operation,
        artifactId: input.artifact.id,
        supersedesArtifactId,
      }
    );
    return false;
  }
  if (!previous?.payload || !isPipelineHandoffArtifact(previous.payload)) {
    sendGatewayError(res, 'NOT_FOUND', 'superseded artifact not found', false, {
      reasonCode: 'WORK_CONTEXT_ARTIFACT_SUPERSEDES_NOT_FOUND',
      operation: input.operation,
      artifactId: input.artifact.id,
      supersedesArtifactId,
    });
    return false;
  }
  if (previous.metadata.workContextId !== input.workContextId) {
    sendGatewayError(
      res,
      'INVALID_ARGUMENT',
      'superseded artifact belongs to a different WorkContext',
      false,
      {
        reasonCode: 'WORK_CONTEXT_ARTIFACT_SUPERSEDES_SCOPE_MISMATCH',
        operation: input.operation,
        artifactId: input.artifact.id,
        supersedesArtifactId,
        workContextId: input.workContextId,
        supersededWorkContextId: previous.metadata.workContextId,
      }
    );
    return false;
  }
  if (previous.payload.head.headSha !== input.artifact.head.headSha) {
    sendGatewayError(
      res,
      'SESSION_CONFLICT',
      'artifact head is stale for the superseded handoff layer',
      false,
      {
        reasonCode: 'WORK_CONTEXT_ARTIFACT_STALE_HEAD',
        operation: input.operation,
        artifactId: input.artifact.id,
        supersedesArtifactId,
        artifactHeadSha: input.artifact.head.headSha,
        supersededHeadSha: previous.payload.head.headSha,
      }
    );
    return false;
  }
  if (input.artifact.stages.length <= previous.payload.stages.length) {
    sendGatewayError(
      res,
      'INVALID_ARGUMENT',
      'artifact must append at least one handoff stage layer',
      false,
      {
        reasonCode: 'WORK_CONTEXT_ARTIFACT_APPEND_ONLY_VIOLATION',
        operation: input.operation,
        artifactId: input.artifact.id,
        supersedesArtifactId,
        previousStageCount: previous.payload.stages.length,
        nextStageCount: input.artifact.stages.length,
      }
    );
    return false;
  }
  for (let index = 0; index < previous.payload.stages.length; index += 1) {
    const stage = previous.payload.stages[index]!;
    if (sameJson(stage, input.artifact.stages[index])) continue;
    sendGatewayError(
      res,
      'INVALID_ARGUMENT',
      'artifact changed an existing handoff stage layer',
      false,
      {
        reasonCode: 'WORK_CONTEXT_ARTIFACT_APPEND_ONLY_VIOLATION',
        operation: input.operation,
        artifactId: input.artifact.id,
        supersedesArtifactId,
        stageIndex: index,
        stage: stage.stage,
      }
    );
    return false;
  }
  return true;
}

function mapStoreError(
  res: Response,
  err: WorkContextArtifactStoreError,
  context: Record<string, unknown> = {}
): void {
  const details = { storeCode: err.code, ...context };
  switch (err.code) {
    case 'task_ref_required':
      sendGatewayError(res, 'INVALID_ARGUMENT', 'taskRef is required', false, {
        reasonCode: 'WORK_CONTEXT_ARTIFACT_TASK_REF_REQUIRED',
        ...details,
      });
      return;
    case 'invalid_pipeline_handoff_artifact':
    case 'invalid_agent_view_artifact':
    case 'artifact_id_mismatch':
    case 'artifact_supersedes_mismatch':
      sendGatewayError(res, 'INVALID_ARGUMENT', err.message, false, {
        reasonCode: 'WORK_CONTEXT_ARTIFACT_VALIDATION_FAILED',
        ...details,
      });
      return;
    case 'public_artifact_sanitization_failed':
      sendGatewayError(
        res,
        'FORBIDDEN',
        'public artifact copy failed sanitizer validation',
        false,
        {
          reasonCode: 'WORK_CONTEXT_ARTIFACT_UNSAFE_PUBLIC_COPY',
          ...details,
        }
      );
      return;
    case 'stored_payload_sha256_mismatch':
    case 'stored_payload_invalid':
      sendGatewayError(
        res,
        'INTERNAL',
        'stored artifact payload failed integrity validation',
        true,
        {
          reasonCode: 'WORK_CONTEXT_ARTIFACT_PAYLOAD_INTEGRITY_FAILED',
          ...details,
        }
      );
      return;
    case 'artifact_already_exists':
      sendGatewayError(
        res,
        'SESSION_CONFLICT',
        'artifact already exists',
        false,
        {
          reasonCode: 'WORK_CONTEXT_ARTIFACT_ALREADY_EXISTS',
          ...details,
        }
      );
      return;
    case 'superseded_artifact_not_found':
      sendGatewayError(
        res,
        'NOT_FOUND',
        'superseded artifact not found',
        false,
        {
          reasonCode: 'WORK_CONTEXT_ARTIFACT_SUPERSEDES_NOT_FOUND',
          ...details,
        }
      );
      return;
    default:
      sendGatewayError(res, 'INVALID_ARGUMENT', err.message, false, {
        reasonCode: 'WORK_CONTEXT_ARTIFACT_STORE_ERROR',
        ...details,
      });
  }
}

function ensureWorkContext(
  res: Response,
  workContextStore: WorkContextStore | undefined,
  workContextId: WorkContextId,
  operation: string
): boolean {
  if (!workContextStore) {
    sendGatewayError(
      res,
      'SERVER_UNAVAILABLE',
      'WorkContext store is unavailable',
      true,
      {
        reasonCode: 'WORK_CONTEXT_STORE_UNAVAILABLE',
        operation,
        workContextId,
      }
    );
    return false;
  }
  if (workContextStore.get(workContextId)) return true;
  sendGatewayError(res, 'NOT_FOUND', 'WorkContext not found', false, {
    reasonCode: 'WORK_CONTEXT_NOT_FOUND',
    operation,
    workContextId,
  });
  return false;
}

function pinArtifactRef(
  workContextStore: WorkContextStore,
  workContextId: WorkContextId,
  metadata: WorkContextArtifactMetadata,
  actorId?: string
): {
  workContext: WorkContext | null;
  artifactRef: ArtifactRef;
  alreadyPinned: boolean;
} {
  const existing = workContextStore.get(workContextId);
  const artifactRef = artifactRefForMetadata(metadata, actorId);
  if (!existing)
    return { workContext: null, artifactRef, alreadyPinned: false };
  const alreadyPinned = existing.artifacts.some(
    (item) => item.id === artifactRef.id || item.uri === artifactRef.uri
  );
  const workContext = alreadyPinned
    ? existing
    : workContextStore.recordLifecycleEvent(workContextId, {
        type: 'artifact.recorded',
        ...(actorId ? { actorId } : {}),
        artifacts: [artifactRef],
        summary: `Pinned WorkContext artifact ${metadata.id} to WorkContext ${workContextId}`,
      });
  return { workContext, artifactRef, alreadyPinned };
}

function unpinArtifactRef(
  workContextStore: WorkContextStore,
  workContextId: WorkContextId,
  artifactId: string,
  actorId?: string
): { workContext: WorkContext | null; removed: boolean } {
  const existing = workContextStore.get(workContextId);
  if (!existing) return { workContext: null, removed: false };
  const refId = artifactRefId(artifactId);
  const uri = artifactUri(artifactId);
  const nextArtifacts = existing.artifacts.filter(
    (item) => item.id !== refId && item.uri !== uri
  );
  const removed = nextArtifacts.length !== existing.artifacts.length;
  if (!removed) return { workContext: existing, removed: false };
  workContextStore.update(workContextId, { artifacts: nextArtifacts });
  return {
    workContext: workContextStore.recordLifecycleEvent(workContextId, {
      type: 'artifact.unpinned',
      ...(actorId ? { actorId } : {}),
      summary: `Unpinned WorkContext artifact ${artifactId} from WorkContext ${workContextId}`,
    }),
    removed: true,
  };
}

function storeOr503(
  res: Response,
  store: WorkContextArtifactStore | null,
  operation: string
): WorkContextArtifactStore | null {
  if (store) return store;
  sendGatewayError(
    res,
    'SERVER_UNAVAILABLE',
    'WorkContext artifact store is unavailable',
    true,
    {
      reasonCode: 'WORK_CONTEXT_ARTIFACT_STORE_UNAVAILABLE',
      operation,
    }
  );
  return null;
}

function safeFileSizeBytes(filePath: string): number | undefined {
  try {
    return statSync(filePath).size;
  } catch {
    return undefined;
  }
}

function dirSizeBytes(root: string): {
  bytes: number;
  files: number;
  largestBytes: number;
} {
  let bytes = 0;
  let files = 0;
  let largestBytes = 0;
  function walk(dir: string): void {
    let entries: Array<{
      name: string;
      isDirectory(): boolean;
      isFile(): boolean;
    }>;
    try {
      if (!existsSync(dir)) return;
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        const size = safeFileSizeBytes(full);
        if (size === undefined) continue;
        bytes += size;
        files += 1;
        largestBytes = Math.max(largestBytes, size);
      }
    }
  }
  walk(root);
  return { bytes, files, largestBytes };
}

function diagnosticsFor(
  s: WorkContextArtifactStore,
  diagnostics: WorkContextArtifactRouterDeps['diagnostics']
): Record<string, unknown> {
  const all = s.list({ includeSuperseded: true, limit: 200 });
  const largestFromIndex = Math.max(
    0,
    ...all.map((record) => record.metadata.payloadBytes)
  );
  const payload = diagnostics?.payloadRoot
    ? dirSizeBytes(diagnostics.payloadRoot)
    : {
        bytes: all.reduce(
          (sum, record) => sum + record.metadata.payloadBytes,
          0
        ),
        files: all.length,
        largestBytes: largestFromIndex,
      };
  return {
    ok: true,
    storage: {
      dbPath: diagnostics?.dbPath ?? null,
      dbBytes: diagnostics?.dbPath
        ? (safeFileSizeBytes(diagnostics.dbPath) ?? null)
        : null,
      payloadRoot: diagnostics?.payloadRoot ?? null,
      payloadBytes: payload.bytes,
      payloadFileCount: payload.files,
      largestPayloadBytes: Math.max(payload.largestBytes, largestFromIndex),
      artifactCount: all.length,
      integrity: 'read-index-ok',
      maxPublishBytes:
        diagnostics?.maxPublishBytes ??
        DEFAULT_WORK_CONTEXT_ARTIFACT_PUBLISH_MAX_BYTES,
      maxExportBytes:
        diagnostics?.maxExportBytes ??
        DEFAULT_WORK_CONTEXT_ARTIFACT_EXPORT_MAX_BYTES,
    },
    recentArtifacts: all.slice(0, 10).map((record) => ({
      id: record.metadata.id,
      workContextId: record.metadata.workContextId,
      taskRef: record.metadata.taskRef,
      payloadSha256: record.metadata.payloadSha256,
      payloadBytes: record.metadata.payloadBytes,
      capturedAt: record.metadata.capturedAt,
    })),
  };
}

export function readWorkContextArtifactQueryWorkContextId(
  query: Request['query']
): string | undefined {
  return readString(query['workContextId'] ?? query['work-context-id']);
}

function queryListInput(
  req: Request
): WorkContextArtifactListInput | 'invalid-task-ref' | 'missing-filter' {
  const workContextId = readWorkContextArtifactQueryWorkContextId(req.query);
  const taskRef = readQueryTaskRef(req);
  if (taskRef === 'invalid') return 'invalid-task-ref';
  // Hub-wide search lane (#1065): a `q` term stands in for the workContextId/taskRef
  // filter requirement below — it is bounded to a hard <=20 limit instead.
  const q = readString(req.query['q']);
  if (!workContextId && !taskRef && !q) return 'missing-filter';
  const projectId = readString(
    req.query['projectId'] ?? req.query['project-id']
  );
  const stage = readStage(req.query['stage']);
  const includeSuperseded = readBoolean(
    req.query['includeSuperseded'] ?? req.query['include-superseded']
  );
  const kind = readArtifactKind(req.query['kind']);
  const limit = q
    ? readSearchLimit(req.query['limit'])
    : readLimit(req.query['limit']);
  return {
    ...(workContextId ? { workContextId } : {}),
    ...(projectId ? { projectId } : {}),
    ...(taskRef ? { taskRef } : {}),
    ...(stage ? { stage } : {}),
    ...(includeSuperseded !== undefined ? { includeSuperseded } : {}),
    ...(limit ? { limit } : {}),
    ...(q ? { q } : {}),
    ...(kind ? { kind } : {}),
  };
}

function emitArtifactEvent(
  events: Pick<CliGatewayEventBus, 'publish'> | undefined,
  topic: 'work-context-artifacts' | 'handoff-artifacts',
  type: string,
  record: WorkContextArtifactRecord,
  actorId?: string,
  pinned?: boolean
): void {
  const { metadata } = record;
  events?.publish({
    topic,
    type,
    workContextId: metadata.workContextId,
    ...(actorId ? { actor: { id: actorId, kind: 'cli-gateway' } } : {}),
    payload: {
      artifactId: metadata.id,
      payloadKind: metadata.payloadKind,
      kind: metadata.kind,
      title: metadata.title,
      visibility: metadata.visibility,
      taskRef: metadata.taskRef,
      ...(metadata.stage ? { stage: metadata.stage } : {}),
      ...(metadata.projectId ? { projectId: metadata.projectId } : {}),
      ...(metadata.provenanceActorId
        ? { provenanceActorId: metadata.provenanceActorId }
        : {}),
      ...(metadata.prNumber !== undefined
        ? { prNumber: metadata.prNumber }
        : {}),
      ...(metadata.headSha ? { headSha: metadata.headSha } : {}),
      ...(metadata.supersedesArtifactId
        ? { supersedesArtifactId: metadata.supersedesArtifactId }
        : {}),
      ...(pinned !== undefined ? { pinned } : {}),
      rawPayloadAvailable: false,
    },
  });
}

function storeViewArtifactPublish(input: {
  res: Response;
  store: WorkContextArtifactStore;
  workContextStore?: WorkContextStore;
  body: Record<string, unknown>;
  viewArtifact: ViewArtifactPackage;
  workContextId: WorkContextId;
  operation: string;
  maxPublishBytes: number;
  events?: Pick<CliGatewayEventBus, 'publish'>;
}): void {
  const {
    res,
    store,
    workContextStore,
    body,
    viewArtifact,
    workContextId,
    operation,
    maxPublishBytes,
    events,
  } = input;
  const payloadBytes = persistedViewArtifactPayloadBytes(viewArtifact);
  if (payloadBytes > AGENT_VIEW_MAX_TOTAL_BYTES) {
    sendGatewayError(
      res,
      'INVALID_ARGUMENT',
      'viewArtifact payload exceeds agent view size cap',
      false,
      {
        reasonCode: 'WORK_CONTEXT_ARTIFACT_VIEW_OVERSIZE_PAYLOAD',
        operation,
        workContextId,
        artifactId: viewArtifact.manifest.revision.id,
        payloadBytes,
        maxBytes: AGENT_VIEW_MAX_TOTAL_BYTES,
      }
    );
    return;
  }
  if (payloadBytes > maxPublishBytes) {
    sendGatewayError(
      res,
      'INVALID_ARGUMENT',
      'artifact payload exceeds publish size cap',
      false,
      {
        reasonCode: 'WORK_CONTEXT_ARTIFACT_OVERSIZE_PAYLOAD',
        operation,
        workContextId,
        artifactId: viewArtifact.manifest.revision.id,
        payloadBytes,
        maxBytes: maxPublishBytes,
      }
    );
    return;
  }
  const provenanceActorId = readString(body['provenanceActorId']);
  const id = readString(body['id']);
  const projectId = readString(body['projectId']);
  const taskRef = readTaskRef(body['taskRef']);
  const stage = readStage(body['stage']);
  const visibility = readVisibility(body['visibility']);
  const kind = readString(body['kind']) as
    | StoreAgentViewArtifactInput['kind']
    | undefined;
  const title = readString(body['title']);
  const summary = readString(body['summary']);
  const capturedAt = readString(body['capturedAt']);
  const supersedesArtifactId = readString(body['supersedesArtifactId']);
  const inputRecord: StoreAgentViewArtifactInput = {
    viewArtifact,
    workContextId,
    ...(id ? { id } : {}),
    ...(projectId ? { projectId } : {}),
    ...(taskRef ? { taskRef } : {}),
    ...(stage ? { stage } : {}),
    ...(provenanceActorId ? { provenanceActorId } : {}),
    ...(visibility ? { visibility } : {}),
    ...(kind ? { kind } : {}),
    ...(title ? { title } : {}),
    ...(summary ? { summary } : {}),
    ...(capturedAt ? { capturedAt } : {}),
    ...(supersedesArtifactId ? { supersedesArtifactId } : {}),
  };
  try {
    const stored = store.storeAgentViewArtifact(inputRecord);
    const actorId = readString(body['actorId']) ?? provenanceActorId;
    const shouldPin = readBoolean(body['pin']) ?? false;
    const pinned =
      shouldPin && workContextStore
        ? pinArtifactRef(
            workContextStore,
            workContextId,
            stored.metadata,
            actorId
          )
        : undefined;
    emitArtifactEvent(
      events,
      'work-context-artifacts',
      'artifact.published',
      stored,
      actorId,
      Boolean(pinned && !pinned.alreadyPinned)
    );
    res.status(201).json({
      artifact: recordEnvelope(stored),
      ...(pinned ? { pin: pinned } : {}),
    });
  } catch (err) {
    if (err instanceof WorkContextArtifactStoreError) {
      mapStoreError(res, err, {
        operation,
        workContextId,
        artifactId: viewArtifact.manifest.revision.id,
      });
      return;
    }
    sendGatewayError(
      res,
      'INTERNAL',
      'failed to store WorkContext view artifact',
      true,
      {
        reasonCode: 'WORK_CONTEXT_ARTIFACT_INTERNAL_ERROR',
        operation,
        workContextId,
        artifactId: viewArtifact.manifest.revision.id,
      }
    );
  }
}

export function createWorkContextArtifactRouter(
  deps: WorkContextArtifactRouterDeps
): Router {
  const router = Router();
  const auth =
    deps.requireAuth ?? ((_req: Request, _res: Response, next) => next());
  const readAuth = deps.requireReadAuth ?? {};
  const writeAuth = deps.requireWriteAuth ?? auth;
  const writeActorAuth = (
    command: CliGatewayActorWriteCommand,
    options?: Parameters<
      NonNullable<WorkContextArtifactRouterDeps['requireWriteActorAuth']>
    >[1]
  ): RequestHandler =>
    deps.requireWriteActorAuth?.(command, options) ?? writeAuth;
  const routeAuth = (
    fallback: RequestHandler,
    handoff?: RequestHandler
  ): RequestHandler => {
    return (req, res, next) => {
      if (req.path.startsWith('/pipeline-handoff-artifacts')) {
        (handoff ?? fallback)(req, res, next);
        return;
      }
      fallback(req, res, next);
    };
  };
  const listAuth = routeAuth(readAuth.list ?? auth, readAuth.handoffList);
  const showAuth = routeAuth(readAuth.show ?? auth, readAuth.handoffShow);
  const copyAuth = routeAuth(readAuth.export ?? auth, readAuth.handoffCopy);
  const maxPublishBytes =
    deps.diagnostics?.maxPublishBytes ??
    DEFAULT_WORK_CONTEXT_ARTIFACT_PUBLISH_MAX_BYTES;
  const maxExportBytes =
    deps.diagnostics?.maxExportBytes ??
    DEFAULT_WORK_CONTEXT_ARTIFACT_EXPORT_MAX_BYTES;

  router.get(
    '/work-context-artifacts/doctor',
    readAuth.doctor ?? auth,
    (req, res) => {
      if (denyMissingCapability(req, res, [CONTEXT_READ])) return;
      const s = storeOr503(res, deps.store, 'doctor');
      if (!s) return;
      try {
        res.json({ diagnostics: diagnosticsFor(s, deps.diagnostics) });
      } catch (err) {
        if (err instanceof WorkContextArtifactStoreError) {
          mapStoreError(res, err, { operation: 'doctor' });
          return;
        }
        sendGatewayError(
          res,
          'INTERNAL',
          'failed to inspect WorkContext artifact storage',
          true,
          {
            reasonCode: 'WORK_CONTEXT_ARTIFACT_DIAGNOSTIC_FAILED',
            operation: 'doctor',
          }
        );
      }
    }
  );

  router.post(
    ['/work-context-artifacts', '/pipeline-handoff-artifacts'],
    routeAuth(
      writeActorAuth('work-context-artifacts.publish', {
        scopeForRequest: writeScopeFromBody,
      }),
      writeActorAuth('handoff-artifacts.attach', {
        scopeForRequest: writeScopeFromBody,
      })
    ),
    // eslint-disable-next-line complexity, sonarjs/cognitive-complexity -- publish validates either handoff artifacts or static view artifacts before shared store/pin handling.
    (req, res) => {
      const operation = req.path.startsWith('/pipeline-handoff-artifacts')
        ? 'attach'
        : 'publish';
      if (denyMissingCapability(req, res, [ARTIFACT_WRITE])) return;
      const s = storeOr503(res, deps.store, operation);
      if (!s) return;
      const body = bodyRecord(req);
      const workContextId = readString(body['workContextId']);
      if (!workContextId) {
        sendGatewayError(
          res,
          'INVALID_ARGUMENT',
          'workContextId is required',
          false,
          {
            reasonCode: 'WORK_CONTEXT_ID_REQUIRED',
            operation,
            field: 'workContextId',
          }
        );
        return;
      }
      if (
        !ensureWorkContext(res, deps.workContextStore, workContextId, operation)
      )
        return;
      const viewArtifact = body['viewArtifact'];
      const artifact = body['artifact'];
      if (viewArtifact !== undefined && artifact !== undefined) {
        sendGatewayError(
          res,
          'INVALID_ARGUMENT',
          'exactly one of artifact or viewArtifact is allowed',
          false,
          {
            reasonCode: 'WORK_CONTEXT_ARTIFACT_PAYLOAD_CONFLICT',
            operation,
            workContextId,
          }
        );
        return;
      }
      if (
        req.path.startsWith('/pipeline-handoff-artifacts') &&
        viewArtifact !== undefined
      ) {
        sendGatewayError(
          res,
          'INVALID_ARGUMENT',
          'pipeline-handoff-artifacts only accepts PipelineHandoffArtifact payloads',
          false,
          {
            reasonCode: 'WORK_CONTEXT_ARTIFACT_KIND_MISMATCH',
            operation,
            workContextId,
            field: 'viewArtifact',
          }
        );
        return;
      }
      if (viewArtifact !== undefined) {
        const validation = validateAgentViewArtifact(viewArtifact);
        if (!validation.valid) {
          const oversized = validation.errors.some(
            (error) => error.code === 'view_oversize'
          );
          sendGatewayError(
            res,
            'INVALID_ARGUMENT',
            oversized
              ? 'viewArtifact payload exceeds agent view size cap'
              : 'viewArtifact must be a valid AgentViewArtifact package',
            false,
            {
              reasonCode: oversized
                ? 'WORK_CONTEXT_ARTIFACT_VIEW_OVERSIZE_PAYLOAD'
                : 'WORK_CONTEXT_ARTIFACT_VALIDATION_FAILED',
              operation,
              workContextId,
              field: 'viewArtifact',
              validationErrors: validation.errors,
            }
          );
          return;
        }
        storeViewArtifactPublish({
          res,
          store: s,
          ...(deps.workContextStore
            ? { workContextStore: deps.workContextStore }
            : {}),
          body,
          viewArtifact: viewArtifact as ViewArtifactPackage,
          workContextId,
          operation,
          maxPublishBytes,
          ...(deps.events ? { events: deps.events } : {}),
        });
        return;
      }
      if (artifact === undefined || !isPipelineHandoffArtifact(artifact)) {
        sendGatewayError(
          res,
          'INVALID_ARGUMENT',
          'artifact must be a PipelineHandoffArtifact',
          false,
          {
            reasonCode: 'WORK_CONTEXT_ARTIFACT_VALIDATION_FAILED',
            operation,
            workContextId,
            field: 'artifact',
          }
        );
        return;
      }
      const payloadBytes = persistedArtifactPayloadBytes(artifact);
      if (payloadBytes > maxPublishBytes) {
        sendGatewayError(
          res,
          'INVALID_ARGUMENT',
          'artifact payload exceeds publish size cap',
          false,
          {
            reasonCode: 'WORK_CONTEXT_ARTIFACT_OVERSIZE_PAYLOAD',
            operation,
            workContextId,
            artifactId: artifact.id,
            payloadBytes,
            maxBytes: maxPublishBytes,
          }
        );
        return;
      }
      const current = currentHeadSha(req, body);
      if (current && artifact.head.headSha !== current) {
        sendGatewayError(
          res,
          'SESSION_CONFLICT',
          'artifact head is stale for the requested current head',
          false,
          {
            reasonCode: 'WORK_CONTEXT_ARTIFACT_STALE_HEAD',
            operation,
            workContextId,
            artifactId: artifact.id,
            artifactHeadSha: artifact.head.headSha,
            currentHeadSha: current,
          }
        );
        return;
      }
      const taskRef = readTaskRef(body['taskRef']);
      const stage = readStage(body['stage']);
      const provenanceActorId = readString(body['provenanceActorId']);
      const visibility = readVisibility(body['visibility']);
      const artifactIdOverride = readString(body['id']);
      const projectId = readString(body['projectId']);
      const kind = readString(body['kind']) as
        | StorePipelineHandoffArtifactInput['kind']
        | undefined;
      const title = readString(body['title']);
      const summary = readString(body['summary']);
      const capturedAt = readString(body['capturedAt']);
      const supersedesArtifactId = readString(body['supersedesArtifactId']);
      const input: StorePipelineHandoffArtifactInput = {
        artifact: artifact as PipelineHandoffArtifact,
        workContextId,
        ...(artifactIdOverride ? { id: artifactIdOverride } : {}),
        ...(projectId ? { projectId } : {}),
        ...(taskRef ? { taskRef } : {}),
        ...(stage ? { stage } : {}),
        ...(provenanceActorId ? { provenanceActorId } : {}),
        ...(visibility ? { visibility } : {}),
        ...(kind ? { kind } : {}),
        ...(title ? { title } : {}),
        ...(summary ? { summary } : {}),
        ...(capturedAt ? { capturedAt } : {}),
        ...(supersedesArtifactId ? { supersedesArtifactId } : {}),
      };
      try {
        if (
          !ensureAppendOnlySupersedes(res, s, {
            workContextId,
            artifact: artifact as PipelineHandoffArtifact,
            ...(supersedesArtifactId ? { supersedesArtifactId } : {}),
            operation,
          })
        ) {
          return;
        }
        const stored = s.storePipelineHandoffArtifact(input);
        const actorId = readString(body['actorId']) ?? provenanceActorId;
        const shouldPin = readBoolean(body['pin']) ?? false;
        const pinned =
          shouldPin && deps.workContextStore
            ? pinArtifactRef(
                deps.workContextStore,
                workContextId,
                stored.metadata,
                actorId
              )
            : undefined;
        emitArtifactEvent(
          deps.events,
          operation === 'attach'
            ? 'handoff-artifacts'
            : 'work-context-artifacts',
          operation === 'attach' ? 'artifact.attached' : 'artifact.published',
          stored,
          actorId,
          Boolean(pinned && !pinned.alreadyPinned)
        );
        res.status(201).json({
          artifact: recordEnvelope(stored, current),
          ...(pinned ? { pin: pinned } : {}),
        });
      } catch (err) {
        if (err instanceof WorkContextArtifactStoreError) {
          mapStoreError(res, err, {
            operation,
            workContextId,
            artifactId: artifact.id,
          });
          return;
        }
        sendGatewayError(
          res,
          'INTERNAL',
          'failed to store WorkContext artifact',
          true,
          {
            reasonCode: 'WORK_CONTEXT_ARTIFACT_INTERNAL_ERROR',
            operation,
            workContextId,
            artifactId: artifact.id,
          }
        );
      }
    }
  );

  router.get(
    ['/work-context-artifacts', '/pipeline-handoff-artifacts'],
    listAuth,
    (req, res) => {
      if (denyMissingCapability(req, res, [CONTEXT_READ])) return;
      const s = storeOr503(res, deps.store, 'list');
      if (!s) return;
      const input = queryListInput(req);
      if (input === 'invalid-task-ref') {
        sendGatewayError(
          res,
          'INVALID_ARGUMENT',
          'taskRefKind and taskRefId are both required when filtering by taskRef',
          false,
          {
            reasonCode: 'WORK_CONTEXT_ARTIFACT_TASK_REF_REQUIRED',
            operation: 'list',
          }
        );
        return;
      }
      if (input === 'missing-filter') {
        sendGatewayError(
          res,
          'INVALID_ARGUMENT',
          'workContextId or taskRef is required',
          false,
          {
            reasonCode: 'WORK_CONTEXT_ARTIFACT_FILTER_REQUIRED',
            operation: 'list',
          }
        );
        return;
      }
      if (
        input.workContextId &&
        denyUnauthorizedActorWorkContextScope(req, res, {
          workContextId: input.workContextId,
          operation: 'list',
        })
      ) {
        return;
      }
      if (
        input.q &&
        !input.workContextId &&
        denyScopedActorHubWideSearch(req, res, 'list')
      ) {
        return;
      }
      if (
        input.workContextId &&
        !ensureWorkContext(
          res,
          deps.workContextStore,
          input.workContextId,
          'list'
        )
      )
        return;
      const current = currentHeadSha(req);
      const listed = s.list(input);
      const artifacts = req.path.startsWith('/pipeline-handoff-artifacts')
        ? listed.filter(
            (record) =>
              record.metadata.payloadKind === 'pipeline-handoff-artifact'
          )
        : listed;
      res.json({
        artifacts: artifacts.map((record) => recordEnvelope(record, current)),
      });
    }
  );

  router.get(
    '/work-context-artifacts/:id/view-package',
    showAuth,
    (req, res) => {
      if (denyMissingCapability(req, res, [CONTEXT_READ])) return;
      const s = storeOr503(res, deps.store, 'show-view-package');
      if (!s) return;
      const id = req.params['id'] ?? '';
      try {
        const metadataRecord = s.get(id);
        if (
          metadataRecord &&
          denyUnauthorizedActorWorkContextScope(req, res, {
            workContextId: metadataRecord.metadata.workContextId,
            operation: 'show-view-package',
            artifactId: id,
            redactWorkContextId: true,
          })
        ) {
          return;
        }
        const record = s.readViewArtifactPackage(id);
        if (!record) {
          sendGatewayError(
            res,
            'NOT_FOUND',
            'WorkContext view artifact not found',
            false,
            {
              reasonCode: 'WORK_CONTEXT_ARTIFACT_NOT_FOUND',
              operation: 'show-view-package',
              artifactId: id,
            }
          );
          return;
        }
        res.json({
          artifact: { metadata: record.metadata, viewArtifact: record.payload },
        });
      } catch (err) {
        if (err instanceof WorkContextArtifactStoreError) {
          mapStoreError(res, err, {
            operation: 'show-view-package',
            artifactId: id,
          });
          return;
        }
        sendGatewayError(
          res,
          'INTERNAL',
          'failed to read WorkContext view artifact package',
          true,
          {
            reasonCode: 'WORK_CONTEXT_ARTIFACT_INTERNAL_ERROR',
            operation: 'show-view-package',
            artifactId: id,
          }
        );
      }
    }
  );

  router.get(
    ['/work-context-artifacts/:id', '/pipeline-handoff-artifacts/:id'],
    showAuth,
    (req, res) => {
      if (denyMissingCapability(req, res, [CONTEXT_READ])) return;
      const s = storeOr503(res, deps.store, 'show');
      if (!s) return;
      const id = req.params['id'] ?? '';
      const publicOnly = readBoolean(req.query['public']) ?? false;
      const current = currentHeadSha(req);
      try {
        const metadataRecord = s.get(id);
        if (
          metadataRecord &&
          denyUnauthorizedActorWorkContextScope(req, res, {
            workContextId: metadataRecord.metadata.workContextId,
            operation: 'show',
            artifactId: id,
            redactWorkContextId: true,
          })
        ) {
          return;
        }
        if (publicOnly) {
          const publicCopy = s.publicSummary(id);
          if (!publicCopy) {
            sendGatewayError(
              res,
              'NOT_FOUND',
              'public WorkContext artifact not found',
              false,
              {
                reasonCode: 'WORK_CONTEXT_ARTIFACT_PUBLIC_COPY_NOT_FOUND',
                operation: 'show',
                artifactId: id,
              }
            );
            return;
          }
          res.json({ artifact: publicCopy });
          return;
        }
        const record = s.read(id);
        if (
          !record ||
          (req.path.startsWith('/pipeline-handoff-artifacts') &&
            record.metadata.payloadKind !== 'pipeline-handoff-artifact')
        ) {
          sendGatewayError(
            res,
            'NOT_FOUND',
            'WorkContext artifact not found',
            false,
            {
              reasonCode: 'WORK_CONTEXT_ARTIFACT_NOT_FOUND',
              operation: 'show',
              artifactId: id,
            }
          );
          return;
        }
        res.json({ artifact: readEnvelope(record, current) });
      } catch (err) {
        if (err instanceof WorkContextArtifactStoreError) {
          mapStoreError(res, err, { operation: 'show', artifactId: id });
          return;
        }
        sendGatewayError(
          res,
          'INTERNAL',
          'failed to read WorkContext artifact',
          true,
          {
            reasonCode: 'WORK_CONTEXT_ARTIFACT_INTERNAL_ERROR',
            operation: 'show',
            artifactId: id,
          }
        );
      }
    }
  );

  const transferHandler = (operation: 'copy' | 'export'): RequestHandler => {
    return (req, res) => {
      if (denyMissingCapability(req, res, [CONTEXT_READ])) return;
      const s = storeOr503(res, deps.store, operation);
      if (!s) return;
      const id = req.params['id'] ?? '';
      try {
        const record = s.get(id);
        if (!record) {
          sendGatewayError(
            res,
            'NOT_FOUND',
            'WorkContext artifact not found',
            false,
            {
              reasonCode: 'WORK_CONTEXT_ARTIFACT_NOT_FOUND',
              operation,
              artifactId: id,
            }
          );
          return;
        }
        if (
          denyUnauthorizedActorWorkContextScope(req, res, {
            workContextId: record.metadata.workContextId,
            operation,
            artifactId: id,
            redactWorkContextId: true,
          })
        ) {
          return;
        }
        const publicCopy = s.publicSummary(id);
        if (!publicCopy) {
          sendGatewayError(
            res,
            'FORBIDDEN',
            'artifact is not available for public export',
            false,
            {
              reasonCode: 'WORK_CONTEXT_ARTIFACT_UNSAFE_PUBLIC_COPY',
              operation,
              artifactId: id,
            }
          );
          return;
        }
        const exportBytes = Buffer.byteLength(
          JSON.stringify(publicCopy, null, 2),
          'utf8'
        );
        if (exportBytes > maxExportBytes) {
          sendGatewayError(
            res,
            'INVALID_ARGUMENT',
            'artifact export exceeds public export size cap',
            false,
            {
              reasonCode: 'WORK_CONTEXT_ARTIFACT_OVERSIZE_EXPORT',
              operation,
              artifactId: id,
              exportBytes,
              maxBytes: maxExportBytes,
            }
          );
          return;
        }
        res.json({
          artifact: publicCopy,
          [operation]: {
            mode: 'public-summary',
            rawPayloadAvailable: false,
            exportBytes,
            maxBytes: maxExportBytes,
          },
        });
      } catch (err) {
        if (err instanceof WorkContextArtifactStoreError) {
          mapStoreError(res, err, { operation, artifactId: id });
          return;
        }
        sendGatewayError(
          res,
          'INTERNAL',
          'failed to export WorkContext artifact',
          true,
          {
            reasonCode: 'WORK_CONTEXT_ARTIFACT_INTERNAL_ERROR',
            operation,
            artifactId: id,
          }
        );
      }
    };
  };

  router.get(
    '/work-context-artifacts/:id/export',
    copyAuth,
    transferHandler('export')
  );
  router.get(
    [
      '/work-context-artifacts/:id/copy',
      '/pipeline-handoff-artifacts/:id/copy',
    ],
    copyAuth,
    transferHandler('copy')
  );

  router.post(
    '/work-context-artifacts/:id/pin',
    writeActorAuth('work-context-artifacts.pin', {
      deferWorkContextScope: true,
    }),
    (req, res) => {
      if (denyMissingCapability(req, res, [ARTIFACT_WRITE])) return;
      const s = storeOr503(res, deps.store, 'pin');
      if (!s) return;
      const body = bodyRecord(req);
      const workContextId = readString(body['workContextId']);
      const artifactId = req.params['id'] ?? '';
      if (!workContextId) {
        sendGatewayError(
          res,
          'INVALID_ARGUMENT',
          'workContextId is required',
          false,
          {
            reasonCode: 'WORK_CONTEXT_ID_REQUIRED',
            operation: 'pin',
            artifactId,
            field: 'workContextId',
          }
        );
        return;
      }
      if (
        denyUnauthorizedActorWorkContextScope(req, res, {
          workContextId,
          operation: 'pin',
          artifactId,
        })
      ) {
        return;
      }
      if (!ensureWorkContext(res, deps.workContextStore, workContextId, 'pin'))
        return;
      const record = s.get(artifactId);
      if (!record) {
        sendGatewayError(
          res,
          'NOT_FOUND',
          'WorkContext artifact not found',
          false,
          {
            reasonCode: 'WORK_CONTEXT_ARTIFACT_NOT_FOUND',
            operation: 'pin',
            artifactId,
            workContextId,
          }
        );
        return;
      }
      if (
        denyUnauthorizedActorWorkContextScope(req, res, {
          workContextId: record.metadata.workContextId,
          operation: 'pin',
          artifactId,
          redactWorkContextId: true,
        })
      ) {
        return;
      }
      const pinned = pinArtifactRef(
        deps.workContextStore!,
        workContextId,
        record.metadata,
        readString(body['actorId'])
      );
      emitArtifactEvent(
        deps.events,
        'work-context-artifacts',
        'artifact.pinned',
        record,
        readString(body['actorId']),
        !pinned.alreadyPinned
      );
      res.status(pinned.alreadyPinned ? 200 : 201).json({
        artifact: recordEnvelope(record),
        artifactRef: pinned.artifactRef,
        workContext: pinned.workContext,
        alreadyPinned: pinned.alreadyPinned,
      });
    }
  );

  router.post(
    '/work-context-artifacts/:id/unpin',
    writeActorAuth('work-context-artifacts.unpin', {
      deferWorkContextScope: true,
    }),
    (req, res) => {
      if (denyMissingCapability(req, res, [ARTIFACT_WRITE])) return;
      const s = storeOr503(res, deps.store, 'unpin');
      if (!s) return;
      const body = bodyRecord(req);
      const workContextId = readString(body['workContextId']);
      const artifactId = req.params['id'] ?? '';
      if (!workContextId) {
        sendGatewayError(
          res,
          'INVALID_ARGUMENT',
          'workContextId is required',
          false,
          {
            reasonCode: 'WORK_CONTEXT_ID_REQUIRED',
            operation: 'unpin',
            artifactId,
            field: 'workContextId',
          }
        );
        return;
      }
      if (
        denyUnauthorizedActorWorkContextScope(req, res, {
          workContextId,
          operation: 'unpin',
          artifactId,
        })
      ) {
        return;
      }
      if (
        !ensureWorkContext(res, deps.workContextStore, workContextId, 'unpin')
      )
        return;
      const record = s.get(artifactId);
      if (
        record &&
        denyUnauthorizedActorWorkContextScope(req, res, {
          workContextId: record.metadata.workContextId,
          operation: 'unpin',
          artifactId,
          redactWorkContextId: true,
        })
      ) {
        return;
      }
      const result = unpinArtifactRef(
        deps.workContextStore!,
        workContextId,
        artifactId,
        readString(body['actorId'])
      );
      if (record && result.removed)
        emitArtifactEvent(
          deps.events,
          'work-context-artifacts',
          'artifact.unpinned',
          record,
          readString(body['actorId']),
          false
        );
      res.json({
        workContext: result.workContext,
        removed: result.removed,
        lifecycle: { artifactDeleted: false },
      });
    }
  );

  return router;
}

export function writeArtifactExport(path: string, payload: unknown): void {
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}
