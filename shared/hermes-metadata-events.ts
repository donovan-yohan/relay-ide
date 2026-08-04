import {
  isWorkContextPrivacyMetadata,
  type ArtifactRef,
  type TaskRef,
  type WorkContextActor,
  type WorkContextAnchors,
  type WorkContextPrivacyMetadata,
} from './work-context.js';

export const HERMES_METADATA_EVENT_SCHEMA_VERSION = 1 as const;

export const HERMES_METADATA_EVENT_INGESTION_RECOMMENDATION =
  'Keep this as a shared validator/spike handler for #556, then add an authenticated Relay ingestion route that persists only accepted metadata events into the WorkContext/audit store. Do not ingest Hermes profile SQLite, env, provider auth, or raw transcript/log payloads.';

export type HermesMetadataRuntime =
  | 'hermes'
  | 'claude'
  | 'codex'
  | 'opencode'
  | 'shell'
  | 'other';

export type HermesMetadataEventKind =
  | 'session.lifecycle'
  | 'task.lifecycle'
  | 'child-session.linked'
  | 'tool.summary'
  | 'artifact.recorded'
  | 'control.intervention';

export type HermesMetadataEventStatus =
  | 'started'
  | 'resumed'
  | 'ended'
  | 'claimed'
  | 'commented'
  | 'blocked'
  | 'completed'
  | 'crashed'
  | 'timed_out'
  | 'spawned'
  | 'succeeded'
  | 'failed'
  | 'skipped'
  | 'requested'
  | 'approved'
  | 'denied';

export type HermesToolCategory =
  | 'terminal'
  | 'file'
  | 'web'
  | 'browser'
  | 'kanban'
  | 'git'
  | 'github'
  | 'agent'
  | 'other';

export interface HermesMetadataSource {
  kind: 'hermes-agent';
  profile: string;
  runtime: HermesMetadataRuntime;
  provider?: string;
  model?: string;
  runId?: string;
  sessionId?: string;
  pluginVersion?: string;
}

export interface HermesMetadataActor
  extends Pick<
    WorkContextActor,
    'kind' | 'id' | 'displayName' | 'providerId' | 'nodeId' | 'sessionId'
  > {
  profile?: string;
  runtime?: HermesMetadataRuntime;
  model?: string;
}

export interface HermesMetadataWorkContextLink {
  workContextId?: string;
  taskRefs: TaskRef[];
  anchors: WorkContextAnchors;
  relatedContextRefs?: string[];
}

export interface HermesChildSessionRef {
  sessionId: string;
  runtime: HermesMetadataRuntime;
  profile?: string;
  runId?: string;
  parentSessionId?: string;
  nodeId?: string;
  cwd?: string;
  status?: HermesMetadataEventStatus;
}

export interface HermesToolSummary {
  name: string;
  category: HermesToolCategory;
  status: 'succeeded' | 'failed' | 'skipped';
  durationMs?: number;
  summary?: string;
  errorSummary?: string;
  artifactIds?: string[];
}

export interface HermesMetadataEventAuditHint {
  correlationId?: string;
  emittedByPluginVersion?: string;
  retentionExpiresAt?: string;
  recommendedNextStep?: string;
}

export interface HermesMetadataEvent {
  schemaVersion: typeof HERMES_METADATA_EVENT_SCHEMA_VERSION;
  eventId: string;
  timestamp: string;
  source: HermesMetadataSource;
  eventKind: HermesMetadataEventKind;
  status: HermesMetadataEventStatus;
  workContext: HermesMetadataWorkContextLink;
  actor: HermesMetadataActor;
  parent?: HermesChildSessionRef;
  childSessions?: HermesChildSessionRef[];
  tool?: HermesToolSummary;
  artifacts: ArtifactRef[];
  privacy: WorkContextPrivacyMetadata;
  audit?: HermesMetadataEventAuditHint;
}

export interface HermesMetadataIngestionResult {
  accepted: boolean;
  event?: HermesMetadataEvent;
  errors: string[];
  recommendation: string;
}

const EVENT_KINDS = new Set<string>([
  'session.lifecycle',
  'task.lifecycle',
  'child-session.linked',
  'tool.summary',
  'artifact.recorded',
  'control.intervention',
]);
const STATUSES = new Set<string>([
  'started',
  'resumed',
  'ended',
  'claimed',
  'commented',
  'blocked',
  'completed',
  'crashed',
  'timed_out',
  'spawned',
  'succeeded',
  'failed',
  'skipped',
  'requested',
  'approved',
  'denied',
]);
const RUNTIMES = new Set<string>([
  'hermes',
  'claude',
  'codex',
  'opencode',
  'shell',
  'other',
]);
const ACTOR_KINDS = new Set<string>([
  'human',
  'agent',
  'system',
  'service',
  'node',
]);
const TASK_KINDS = new Set<string>([
  'github-issue',
  'github-pr',
  'kanban-task',
  'jira-ticket',
  'linear-issue',
  'external',
]);
const TAB_KINDS = new Set<string>([
  'agent',
  'terminal',
  'file',
  'diff',
  'preview',
  'html',
  'other',
]);
const NODE_KINDS = new Set<string>(['local', 'remote']);
const ARTIFACT_KINDS = new Set<string>([
  'file',
  'diff',
  'log-ref',
  'transcript-ref',
  'screenshot',
  'report',
  'command-output-ref',
  'external',
]);
const TOOL_CATEGORIES = new Set<string>([
  'terminal',
  'file',
  'web',
  'browser',
  'kanban',
  'git',
  'github',
  'agent',
  'other',
]);
const TOOL_STATUSES = new Set<string>(['succeeded', 'failed', 'skipped']);
const TOP_LEVEL_KEYS = new Set<string>([
  'schemaVersion',
  'eventId',
  'timestamp',
  'source',
  'eventKind',
  'status',
  'workContext',
  'actor',
  'parent',
  'childSessions',
  'tool',
  'artifacts',
  'privacy',
  'audit',
]);
const SOURCE_KEYS = new Set<string>([
  'kind',
  'profile',
  'runtime',
  'provider',
  'model',
  'runId',
  'sessionId',
  'pluginVersion',
]);
const ACTOR_KEYS = new Set<string>([
  'kind',
  'id',
  'displayName',
  'providerId',
  'nodeId',
  'sessionId',
  'profile',
  'runtime',
  'model',
]);
const WORK_CONTEXT_KEYS = new Set<string>([
  'workContextId',
  'taskRefs',
  'anchors',
  'relatedContextRefs',
]);
const TASK_REF_KEYS = new Set<string>([
  'kind',
  'id',
  'title',
  'url',
  'status',
  'parentRef',
  'privacy',
]);
const ANCHORS_KEYS = new Set<string>([
  'node',
  'session',
  'project',
  'repo',
  'worktree',
]);
const NODE_ANCHOR_KEYS = new Set<string>([
  'nodeId',
  'kind',
  'displayName',
  'online',
]);
const SESSION_ANCHOR_KEYS = new Set<string>([
  'nodeId',
  'sessionId',
  'globalSessionId',
  'tabId',
  'tabKind',
  'cwd',
]);
const PROJECT_ANCHOR_KEYS = new Set<string>([
  'workspaceId',
  'projectId',
  'instanceId',
  'benchId',
]);
const REPO_ANCHOR_KEYS = new Set<string>([
  'repoIdentity',
  'repoInstanceId',
  'ownerRepo',
  'remoteUrl',
  'localPath',
  'branchName',
]);
const WORKTREE_ANCHOR_KEYS = new Set<string>([
  'worktreeInstanceId',
  'localPath',
  'branchName',
]);
const CHILD_SESSION_KEYS = new Set<string>([
  'sessionId',
  'runtime',
  'profile',
  'runId',
  'parentSessionId',
  'nodeId',
  'cwd',
  'status',
]);
const TOOL_KEYS = new Set<string>([
  'name',
  'category',
  'status',
  'durationMs',
  'summary',
  'errorSummary',
  'artifactIds',
]);
const ARTIFACT_KEYS = new Set<string>([
  'id',
  'kind',
  'title',
  'uri',
  'path',
  'mediaType',
  'producedByActorId',
  'producedAt',
  'summary',
  'privacy',
]);
const PRIVACY_KEYS = new Set<string>([
  'classification',
  'retention',
  'rawPayloadStored',
  'redaction',
  'policyRefs',
]);
const REDACTION_KEYS = new Set<string>([
  'redacted',
  'strategy',
  'classes',
  'byteCount',
  'charCount',
  'lineCount',
  'hashSha256',
  'preview',
]);
const AUDIT_HINT_KEYS = new Set<string>([
  'correlationId',
  'emittedByPluginVersion',
  'retentionExpiresAt',
  'recommendedNextStep',
]);
const FORBIDDEN_RAW_PAYLOAD_KEYS = new Set<string>([
  'accesstoken',
  'apikey',
  'authorization',
  'bearer',
  'clientsecret',
  'conversation',
  'environment',
  'env',
  'hermesprofilepath',
  'hermesdbpath',
  'log',
  'messages',
  'openaiapikey',
  'output',
  'processenv',
  'profilepath',
  'providerauth',
  'rawcontent',
  'rawlog',
  'rawpayload',
  'rawtranscript',
  'refreshtoken',
  'scrollback',
  'secret',
  'secretkey',
  'secrets',
  'sqlitedbpath',
  'stderr',
  'stdout',
  'token',
  'transcript',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === 'string')
  );
}

function isEnumValue(value: unknown, values: ReadonlySet<string>): value is string {
  return typeof value === 'string' && values.has(value);
}

function isIsoTimestamp(value: unknown): value is string {
  return hasString(value) && !Number.isNaN(Date.parse(value));
}

function normalizedKey(key: string): string {
  return key.replace(/[^a-z0-9]/gi, '').toLowerCase();
}

function findUnsafePayloadKey(value: unknown, path = '$'): string | undefined {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const unsafe = findUnsafePayloadKey(value[index], `${path}[${index}]`);
      if (unsafe) return unsafe;
    }
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  for (const [key, nested] of Object.entries(value)) {
    const normalized = normalizedKey(key);
    if (FORBIDDEN_RAW_PAYLOAD_KEYS.has(normalized)) {
      return `${path}.${key}`;
    }
    const unsafe = findUnsafePayloadKey(nested, `${path}.${key}`);
    if (unsafe) return unsafe;
  }
  return undefined;
}

function hasOnlyTopLevelKeys(value: Record<string, unknown>): boolean {
  return Object.keys(value).every((key) => TOP_LEVEL_KEYS.has(key));
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowedKeys: ReadonlySet<string>
): boolean {
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

function collectUnknownKeys(
  value: unknown,
  allowedKeys: ReadonlySet<string>,
  path: string
): string[] {
  if (!isRecord(value)) return [];
  return Object.keys(value)
    .filter((key) => !allowedKeys.has(key))
    .map((key) => `unknown metadata key: ${path}.${key}`);
}

function collectPrivacyUnknownKeyErrors(value: unknown, path: string): string[] {
  if (!isRecord(value)) return [];
  return [
    ...collectUnknownKeys(value, PRIVACY_KEYS, path),
    ...collectUnknownKeys(value.redaction, REDACTION_KEYS, `${path}.redaction`),
  ];
}

function collectAnchorUnknownKeyErrors(value: unknown, path: string): string[] {
  if (!isRecord(value)) return [];
  return [
    ...collectUnknownKeys(value, ANCHORS_KEYS, path),
    ...collectUnknownKeys(value.node, NODE_ANCHOR_KEYS, `${path}.node`),
    ...collectUnknownKeys(value.session, SESSION_ANCHOR_KEYS, `${path}.session`),
    ...collectUnknownKeys(value.project, PROJECT_ANCHOR_KEYS, `${path}.project`),
    ...collectUnknownKeys(value.repo, REPO_ANCHOR_KEYS, `${path}.repo`),
    ...collectUnknownKeys(value.worktree, WORKTREE_ANCHOR_KEYS, `${path}.worktree`),
  ];
}

function collectNestedUnknownKeyErrors(
  value: Record<string, unknown>
): string[] {
  const workContext = isRecord(value.workContext) ? value.workContext : undefined;
  const errors = [
    ...collectUnknownKeys(value.source, SOURCE_KEYS, '$.source'),
    ...collectUnknownKeys(value.actor, ACTOR_KEYS, '$.actor'),
    ...collectUnknownKeys(value.workContext, WORK_CONTEXT_KEYS, '$.workContext'),
    ...collectAnchorUnknownKeyErrors(
      workContext?.anchors,
      '$.workContext.anchors'
    ),
    ...collectUnknownKeys(value.parent, CHILD_SESSION_KEYS, '$.parent'),
    ...collectUnknownKeys(value.tool, TOOL_KEYS, '$.tool'),
    ...collectPrivacyUnknownKeyErrors(value.privacy, '$.privacy'),
    ...collectUnknownKeys(value.audit, AUDIT_HINT_KEYS, '$.audit'),
  ];

  if (Array.isArray(workContext?.taskRefs)) {
    workContext.taskRefs.forEach((taskRef, index) => {
      errors.push(
        ...collectUnknownKeys(
          taskRef,
          TASK_REF_KEYS,
          `$.workContext.taskRefs[${index}]`
        )
      );
      if (isRecord(taskRef)) {
        errors.push(
          ...collectPrivacyUnknownKeyErrors(
            taskRef.privacy,
            `$.workContext.taskRefs[${index}].privacy`
          )
        );
      }
    });
  }

  if (Array.isArray(value.childSessions)) {
    value.childSessions.forEach((childSession, index) => {
      errors.push(
        ...collectUnknownKeys(
          childSession,
          CHILD_SESSION_KEYS,
          `$.childSessions[${index}]`
        )
      );
    });
  }

  if (Array.isArray(value.artifacts)) {
    value.artifacts.forEach((artifact, index) => {
      errors.push(
        ...collectUnknownKeys(
          artifact,
          ARTIFACT_KEYS,
          `$.artifacts[${index}]`
        )
      );
      if (isRecord(artifact)) {
        errors.push(
          ...collectPrivacyUnknownKeyErrors(
            artifact.privacy,
            `$.artifacts[${index}].privacy`
          )
        );
      }
    });
  }

  return errors;
}

function isHermesPrivacyMetadata(
  value: unknown
): value is WorkContextPrivacyMetadata {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, PRIVACY_KEYS) &&
    (!isRecord(value.redaction) || hasOnlyKeys(value.redaction, REDACTION_KEYS)) &&
    isWorkContextPrivacyMetadata(value)
  );
}

function isStringMap(value: unknown): boolean {
  if (value === undefined) return true;
  if (!isRecord(value)) return false;
  return Object.values(value).every(
    (item) => item === undefined || typeof item === 'string'
  );
}

function isTaskRef(value: unknown): value is TaskRef {
  if (!isRecord(value) || !hasOnlyKeys(value, TASK_REF_KEYS)) return false;
  return (
    isEnumValue(value.kind, TASK_KINDS) &&
    hasString(value.id) &&
    isOptionalString(value.title) &&
    isOptionalString(value.url) &&
    isOptionalString(value.status) &&
    isOptionalString(value.parentRef) &&
    (value.privacy === undefined || isHermesPrivacyMetadata(value.privacy))
  );
}

function isNodeAnchor(value: unknown): boolean {
  if (!isRecord(value) || !hasOnlyKeys(value, NODE_ANCHOR_KEYS)) return false;
  return (
    hasString(value.nodeId) &&
    isEnumValue(value.kind, NODE_KINDS) &&
    isOptionalString(value.displayName) &&
    (value.online === undefined || typeof value.online === 'boolean')
  );
}

function isSessionAnchor(value: unknown): boolean {
  if (!isRecord(value) || !hasOnlyKeys(value, SESSION_ANCHOR_KEYS)) return false;
  return (
    hasString(value.nodeId) &&
    hasString(value.sessionId) &&
    isOptionalString(value.globalSessionId) &&
    isOptionalString(value.tabId) &&
    isEnumValue(value.tabKind, TAB_KINDS) &&
    hasString(value.cwd)
  );
}

function isWorkContextAnchors(value: unknown): value is WorkContextAnchors {
  if (!isRecord(value) || !hasOnlyKeys(value, ANCHORS_KEYS)) return false;
  return (
    (value.node === undefined || isNodeAnchor(value.node)) &&
    (value.session === undefined || isSessionAnchor(value.session)) &&
    (value.project === undefined ||
      (isRecord(value.project) &&
        hasOnlyKeys(value.project, PROJECT_ANCHOR_KEYS) &&
        isStringMap(value.project))) &&
    (value.repo === undefined ||
      (isRecord(value.repo) &&
        hasOnlyKeys(value.repo, REPO_ANCHOR_KEYS) &&
        isStringMap(value.repo))) &&
    (value.worktree === undefined ||
      (isRecord(value.worktree) &&
        hasOnlyKeys(value.worktree, WORKTREE_ANCHOR_KEYS) &&
        isStringMap(value.worktree)))
  );
}

function isArtifactRef(value: unknown): value is ArtifactRef {
  if (!isRecord(value) || !hasOnlyKeys(value, ARTIFACT_KEYS)) return false;
  return (
    hasString(value.id) &&
    isEnumValue(value.kind, ARTIFACT_KINDS) &&
    isOptionalString(value.title) &&
    isOptionalString(value.uri) &&
    isOptionalString(value.path) &&
    isOptionalString(value.mediaType) &&
    isOptionalString(value.producedByActorId) &&
    isOptionalString(value.producedAt) &&
    isOptionalString(value.summary) &&
    isHermesPrivacyMetadata(value.privacy) &&
    value.privacy.rawPayloadStored === false
  );
}

function isMetadataSource(value: unknown): value is HermesMetadataSource {
  if (!isRecord(value) || !hasOnlyKeys(value, SOURCE_KEYS)) return false;
  return (
    value.kind === 'hermes-agent' &&
    hasString(value.profile) &&
    isEnumValue(value.runtime, RUNTIMES) &&
    isOptionalString(value.provider) &&
    isOptionalString(value.model) &&
    isOptionalString(value.runId) &&
    isOptionalString(value.sessionId) &&
    isOptionalString(value.pluginVersion)
  );
}

function isMetadataActor(value: unknown): value is HermesMetadataActor {
  if (!isRecord(value) || !hasOnlyKeys(value, ACTOR_KEYS)) return false;
  return (
    isEnumValue(value.kind, ACTOR_KINDS) &&
    hasString(value.id) &&
    isOptionalString(value.displayName) &&
    isOptionalString(value.providerId) &&
    isOptionalString(value.nodeId) &&
    isOptionalString(value.sessionId) &&
    isOptionalString(value.profile) &&
    (value.runtime === undefined || isEnumValue(value.runtime, RUNTIMES)) &&
    isOptionalString(value.model)
  );
}

function isWorkContextLink(
  value: unknown
): value is HermesMetadataWorkContextLink {
  if (!isRecord(value) || !hasOnlyKeys(value, WORK_CONTEXT_KEYS)) return false;
  return (
    isOptionalString(value.workContextId) &&
    Array.isArray(value.taskRefs) &&
    value.taskRefs.every(isTaskRef) &&
    isWorkContextAnchors(value.anchors) &&
    (value.relatedContextRefs === undefined ||
      isStringArray(value.relatedContextRefs))
  );
}

function isChildSession(value: unknown): value is HermesChildSessionRef {
  if (!isRecord(value) || !hasOnlyKeys(value, CHILD_SESSION_KEYS)) return false;
  return (
    hasString(value.sessionId) &&
    isEnumValue(value.runtime, RUNTIMES) &&
    isOptionalString(value.profile) &&
    isOptionalString(value.runId) &&
    isOptionalString(value.parentSessionId) &&
    isOptionalString(value.nodeId) &&
    isOptionalString(value.cwd) &&
    (value.status === undefined || isEnumValue(value.status, STATUSES))
  );
}

function isToolSummary(value: unknown): value is HermesToolSummary {
  if (!isRecord(value) || !hasOnlyKeys(value, TOOL_KEYS)) return false;
  return (
    hasString(value.name) &&
    isEnumValue(value.category, TOOL_CATEGORIES) &&
    isEnumValue(value.status, TOOL_STATUSES) &&
    (value.durationMs === undefined ||
      (typeof value.durationMs === 'number' && value.durationMs >= 0)) &&
    isOptionalString(value.summary) &&
    isOptionalString(value.errorSummary) &&
    (value.artifactIds === undefined || isStringArray(value.artifactIds))
  );
}

function isAuditHint(value: unknown): value is HermesMetadataEventAuditHint {
  if (value === undefined) return true;
  if (!isRecord(value) || !hasOnlyKeys(value, AUDIT_HINT_KEYS)) return false;
  return (
    isOptionalString(value.correlationId) &&
    isOptionalString(value.emittedByPluginVersion) &&
    isOptionalString(value.retentionExpiresAt) &&
    isOptionalString(value.recommendedNextStep)
  );
}

function collectShapeErrors(value: Record<string, unknown>): string[] {
  const errors: string[] = [];
  if (!hasOnlyTopLevelKeys(value)) errors.push('unknown top-level key');
  errors.push(...collectNestedUnknownKeyErrors(value));
  if (value.schemaVersion !== HERMES_METADATA_EVENT_SCHEMA_VERSION) {
    errors.push('schemaVersion must be 1');
  }
  if (!hasString(value.eventId)) errors.push('eventId is required');
  if (!isIsoTimestamp(value.timestamp)) errors.push('timestamp must be ISO-like');
  if (!isMetadataSource(value.source)) errors.push('source is invalid');
  if (!isEnumValue(value.eventKind, EVENT_KINDS)) {
    errors.push('eventKind is invalid');
  }
  if (!isEnumValue(value.status, STATUSES)) errors.push('status is invalid');
  if (!isWorkContextLink(value.workContext)) {
    errors.push('workContext link is invalid');
  }
  if (!isMetadataActor(value.actor)) errors.push('actor is invalid');
  if (value.parent !== undefined && !isChildSession(value.parent)) {
    errors.push('parent session ref is invalid');
  }
  if (
    value.childSessions !== undefined &&
    (!Array.isArray(value.childSessions) ||
      !value.childSessions.every(isChildSession))
  ) {
    errors.push('childSessions are invalid');
  }
  if (value.tool !== undefined && !isToolSummary(value.tool)) {
    errors.push('tool summary is invalid');
  }
  if (!Array.isArray(value.artifacts) || !value.artifacts.every(isArtifactRef)) {
    errors.push('artifacts are invalid');
  }
  if (
    !isHermesPrivacyMetadata(value.privacy) ||
    value.privacy.rawPayloadStored !== false
  ) {
    errors.push('privacy must be valid and rawPayloadStored=false');
  }
  if (!isAuditHint(value.audit)) errors.push('audit hint is invalid');
  return errors;
}

function collectEventKindErrors(value: Record<string, unknown>): string[] {
  const errors: string[] = [];
  if (value.eventKind === 'tool.summary' && value.tool === undefined) {
    errors.push('tool.summary events require tool');
  }
  if (
    value.eventKind === 'child-session.linked' &&
    (!Array.isArray(value.childSessions) || value.childSessions.length === 0)
  ) {
    errors.push('child-session.linked events require childSessions');
  }
  if (
    value.eventKind === 'artifact.recorded' &&
    (!Array.isArray(value.artifacts) || value.artifacts.length === 0)
  ) {
    errors.push('artifact.recorded events require artifacts');
  }
  if (
    value.eventKind === 'task.lifecycle' &&
    (!isRecord(value.workContext) ||
      !Array.isArray(value.workContext.taskRefs) ||
      value.workContext.taskRefs.length === 0)
  ) {
    errors.push('task.lifecycle events require taskRefs');
  }
  return errors;
}

export function validateHermesMetadataEvent(value: unknown): string[] {
  if (!isRecord(value)) return ['event must be an object'];
  const unsafeKeyPath = findUnsafePayloadKey(value);
  const errors = [
    ...collectShapeErrors(value),
    ...collectEventKindErrors(value),
  ];
  if (unsafeKeyPath) {
    errors.push(`raw/secret/transcript-shaped payload key rejected: ${unsafeKeyPath}`);
  }
  return errors;
}

export function isHermesMetadataEvent(
  value: unknown
): value is HermesMetadataEvent {
  return validateHermesMetadataEvent(value).length === 0;
}

export function ingestHermesMetadataEventCandidate(
  value: unknown
): HermesMetadataIngestionResult {
  const errors = validateHermesMetadataEvent(value);
  if (errors.length > 0) {
    return {
      accepted: false,
      errors,
      recommendation: HERMES_METADATA_EVENT_INGESTION_RECOMMENDATION,
    };
  }
  return {
    accepted: true,
    event: value as HermesMetadataEvent,
    errors: [],
    recommendation: HERMES_METADATA_EVENT_INGESTION_RECOMMENDATION,
  };
}
