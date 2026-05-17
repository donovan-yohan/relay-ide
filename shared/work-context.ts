import type {
  GlobalSessionId,
  NodeId,
  RepoIdentity,
  RepoInstanceId,
  WorktreeInstanceId,
} from './identity.js';
import type { WorkspaceId } from './workspace.js';
import type { ProjectId, InstanceId } from './project.js';
import type { BenchId } from './bench.js';
import {
  isRelayCapabilityBit,
  type RelayCapabilityBit,
  type RelayCapabilityDecision,
  type RelayPolicyScope,
} from './security-policy.js';

export const WORK_CONTEXT_SCHEMA_VERSION = 1 as const;

export type WorkContextId = string;
export type WorkContextRef = string;
export type TaskRefId = string;
export type ArtifactId = string;
export type AuditEventRefId = string;
export type CapabilityGrantRefId = string;

export type WorkContextActorKind =
  | 'human'
  | 'agent'
  | 'system'
  | 'service'
  | 'node';

export type TaskRefKind =
  | 'github-issue'
  | 'github-pr'
  | 'kanban-task'
  | 'jira-ticket'
  | 'linear-issue'
  | 'external';

export type WorkContextTabKind =
  | 'agent'
  | 'terminal'
  | 'file'
  | 'diff'
  | 'preview'
  | 'html'
  | 'other';

export type NodeRefKind = 'local' | 'remote';

export type ArtifactKind =
  | 'file'
  | 'diff'
  | 'log-ref'
  | 'transcript-ref'
  | 'screenshot'
  | 'report'
  | 'command-output-ref'
  | 'external';

export type WorkContextPrivacyClass =
  | 'public'
  | 'internal'
  | 'sensitive'
  | 'secret';

export type WorkContextRedactionClass =
  | 'credential'
  | 'secret'
  | 'personal'
  | 'path'
  | 'payload'
  | 'transcript'
  | 'log'
  | 'artifact'
  | 'other';

export type WorkContextRedactionStrategy =
  | 'none'
  | 'preview'
  | 'summary'
  | 'hash'
  | 'omitted';

export type WorkContextRetentionClass =
  | 'ephemeral'
  | 'session'
  | 'project'
  | 'audit';

export type CapabilityPolicyClass =
  | 'read-only'
  | 'write'
  | 'exec'
  | 'network'
  | 'privileged'
  | 'unknown';

export interface WorkContextRedactionMetadata {
  redacted: boolean;
  strategy: WorkContextRedactionStrategy;
  classes: WorkContextRedactionClass[];
  byteCount?: number;
  charCount?: number;
  lineCount?: number;
  hashSha256?: string;
  preview?: string;
}

export interface WorkContextPrivacyMetadata {
  classification: WorkContextPrivacyClass;
  retention: WorkContextRetentionClass;
  rawPayloadStored: boolean;
  redaction: WorkContextRedactionMetadata;
  policyRefs?: string[];
}

export interface WorkContextActor {
  kind: WorkContextActorKind;
  id: string;
  displayName?: string;
  providerId?: string;
  nodeId?: NodeId;
  sessionId?: string;
  privacy?: WorkContextPrivacyMetadata;
}

export interface TaskRef {
  kind: TaskRefKind;
  id: TaskRefId;
  title?: string;
  url?: string;
  status?: string;
  parentRef?: TaskRefId;
  privacy?: WorkContextPrivacyMetadata;
}

export interface NodeRef {
  nodeId: NodeId;
  kind: NodeRefKind;
  displayName?: string;
  online?: boolean;
}

export interface SessionRef {
  nodeId: NodeId;
  sessionId: string;
  globalSessionId?: GlobalSessionId;
  tabId?: string;
  tabKind: WorkContextTabKind;
  cwd: string;
}

export interface RepoRef {
  repoIdentity?: RepoIdentity;
  repoInstanceId?: RepoInstanceId;
  ownerRepo?: string;
  remoteUrl?: string;
  localPath?: string;
  branchName?: string;
}

export interface WorktreeRef {
  worktreeInstanceId?: WorktreeInstanceId;
  localPath?: string;
  branchName?: string;
}

export interface ProjectRefs {
  workspaceId?: WorkspaceId;
  projectId?: ProjectId;
  instanceId?: InstanceId;
  benchId?: BenchId;
}

export interface WorkContextAnchors {
  node?: NodeRef;
  session?: SessionRef;
  project?: ProjectRefs;
  repo?: RepoRef;
  worktree?: WorktreeRef;
}

export interface ArtifactRef {
  id: ArtifactId;
  kind: ArtifactKind;
  title?: string;
  uri?: string;
  path?: string;
  mediaType?: string;
  producedByActorId?: string;
  producedAt?: string;
  summary?: string;
  privacy: WorkContextPrivacyMetadata;
}

export interface AuditEventRef {
  id: AuditEventRefId;
  eventId: string;
  type?: string;
  occurredAt?: string;
  actorId?: string;
  correlationId?: string;
  chainHash?: string;
  logRef?: string;
  privacy: WorkContextPrivacyMetadata;
}

export interface CapabilityGrantRef {
  id: CapabilityGrantRefId;
  ref: string;
  capability?: RelayCapabilityBit;
  capabilities?: RelayCapabilityBit[];
  decision?: RelayCapabilityDecision;
  policyClass: CapabilityPolicyClass;
  scope?: RelayPolicyScope;
  actorId?: string;
  auditEventId?: AuditEventRefId;
  privacy: WorkContextPrivacyMetadata;
}

export interface WorkContext {
  schemaVersion: typeof WORK_CONTEXT_SCHEMA_VERSION;
  id: WorkContextId;
  title?: string;
  createdAt: string;
  updatedAt: string;
  source: string;
  anchors: WorkContextAnchors;
  actors: WorkContextActor[];
  tasks: TaskRef[];
  artifacts: ArtifactRef[];
  auditRefs: AuditEventRef[];
  capabilityGrants: CapabilityGrantRef[];
  relatedContextRefs?: WorkContextRef[];
  privacy: WorkContextPrivacyMetadata;
}

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
const PRIVACY_CLASSES = new Set<string>([
  'public',
  'internal',
  'sensitive',
  'secret',
]);
const RETENTION_CLASSES = new Set<string>([
  'ephemeral',
  'session',
  'project',
  'audit',
]);
const REDACTION_STRATEGIES = new Set<string>([
  'none',
  'preview',
  'summary',
  'hash',
  'omitted',
]);
const REDACTION_CLASSES = new Set<string>([
  'credential',
  'secret',
  'personal',
  'path',
  'payload',
  'transcript',
  'log',
  'artifact',
  'other',
]);
const CAPABILITY_DECISIONS = new Set<string>([
  'allow',
  'requiresConfirmation',
  'deny',
]);
const CAPABILITY_POLICY_CLASSES = new Set<string>([
  'read-only',
  'write',
  'exec',
  'network',
  'privileged',
  'unknown',
]);
const POLICY_SCOPE_KINDS = new Set<string>([
  'node',
  'workspace',
  'repo',
  'path',
]);
const FORBIDDEN_RAW_PAYLOAD_KEYS = new Set<string>([
  'rawContent',
  'rawPayload',
  'transcript',
  'log',
  'hermesDbPath',
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

function hasNoForbiddenRawPayloadKeys(value: unknown): boolean {
  if (!isRecord(value)) return true;
  return Object.keys(value).every(
    (key) => !FORBIDDEN_RAW_PAYLOAD_KEYS.has(key)
  );
}

function isEnumValue(value: unknown, values: Set<string>): value is string {
  return typeof value === 'string' && values.has(value);
}

export function isWorkContextRedactionMetadata(
  value: unknown
): value is WorkContextRedactionMetadata {
  if (!isRecord(value)) return false;
  if (typeof value.redacted !== 'boolean') return false;
  if (!isEnumValue(value.strategy, REDACTION_STRATEGIES)) return false;
  if (!isStringArray(value.classes)) return false;
  return value.classes.every((item) => REDACTION_CLASSES.has(item));
}

export function isWorkContextPrivacyMetadata(
  value: unknown
): value is WorkContextPrivacyMetadata {
  if (!isRecord(value)) return false;
  return (
    isEnumValue(value.classification, PRIVACY_CLASSES) &&
    isEnumValue(value.retention, RETENTION_CLASSES) &&
    typeof value.rawPayloadStored === 'boolean' &&
    isWorkContextRedactionMetadata(value.redaction) &&
    (value.policyRefs === undefined || isStringArray(value.policyRefs))
  );
}

export function createWorkContextPrivacyMetadata(
  input: Partial<WorkContextPrivacyMetadata> = {}
): WorkContextPrivacyMetadata {
  return {
    classification: input.classification ?? 'internal',
    retention: input.retention ?? 'session',
    rawPayloadStored: input.rawPayloadStored ?? false,
    redaction: input.redaction ?? {
      redacted: false,
      strategy: 'none',
      classes: [],
    },
    ...(input.policyRefs ? { policyRefs: [...input.policyRefs] } : {}),
  };
}

function isActor(value: unknown): value is WorkContextActor {
  if (!isRecord(value)) return false;
  return (
    isEnumValue(value.kind, ACTOR_KINDS) &&
    hasString(value.id) &&
    isOptionalString(value.displayName) &&
    isOptionalString(value.providerId) &&
    isOptionalString(value.nodeId) &&
    isOptionalString(value.sessionId) &&
    (value.privacy === undefined || isWorkContextPrivacyMetadata(value.privacy))
  );
}

function isTaskRef(value: unknown): value is TaskRef {
  if (!isRecord(value)) return false;
  return (
    isEnumValue(value.kind, TASK_KINDS) &&
    hasString(value.id) &&
    isOptionalString(value.title) &&
    isOptionalString(value.url) &&
    isOptionalString(value.status) &&
    isOptionalString(value.parentRef) &&
    (value.privacy === undefined || isWorkContextPrivacyMetadata(value.privacy))
  );
}

function isNodeRef(value: unknown): value is NodeRef {
  if (!isRecord(value)) return false;
  return (
    hasString(value.nodeId) &&
    isEnumValue(value.kind, new Set<string>(['local', 'remote'])) &&
    isOptionalString(value.displayName) &&
    (value.online === undefined || typeof value.online === 'boolean')
  );
}

function isSessionRef(value: unknown): value is SessionRef {
  if (!isRecord(value)) return false;
  return (
    hasString(value.nodeId) &&
    hasString(value.sessionId) &&
    isOptionalString(value.globalSessionId) &&
    isOptionalString(value.tabId) &&
    isEnumValue(value.tabKind, TAB_KINDS) &&
    hasString(value.cwd)
  );
}

function isOptionalStringMap(value: unknown): boolean {
  if (value === undefined) return true;
  if (!isRecord(value)) return false;
  return Object.values(value).every(
    (item) => item === undefined || typeof item === 'string'
  );
}

function isAnchors(value: unknown): value is WorkContextAnchors {
  if (!isRecord(value)) return false;
  return (
    (value.node === undefined || isNodeRef(value.node)) &&
    (value.session === undefined || isSessionRef(value.session)) &&
    isOptionalStringMap(value.project) &&
    isOptionalStringMap(value.repo) &&
    isOptionalStringMap(value.worktree)
  );
}

function isArtifactRef(value: unknown): value is ArtifactRef {
  if (!isRecord(value) || !hasNoForbiddenRawPayloadKeys(value)) return false;
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
    isWorkContextPrivacyMetadata(value.privacy)
  );
}

function isAuditEventRef(value: unknown): value is AuditEventRef {
  if (!isRecord(value)) return false;
  return (
    hasString(value.id) &&
    hasString(value.eventId) &&
    isOptionalString(value.type) &&
    isOptionalString(value.occurredAt) &&
    isOptionalString(value.actorId) &&
    isOptionalString(value.correlationId) &&
    isOptionalString(value.chainHash) &&
    isOptionalString(value.logRef) &&
    isWorkContextPrivacyMetadata(value.privacy)
  );
}

function hasValidCapabilityGrantBits(value: Record<string, unknown>): boolean {
  const singleCapabilityValid =
    value.capability === undefined || isRelayCapabilityBit(value.capability);
  const capabilitiesValid =
    value.capabilities === undefined ||
    (Array.isArray(value.capabilities) &&
      value.capabilities.every(isRelayCapabilityBit));
  return singleCapabilityValid && capabilitiesValid;
}

function isRelayPolicyScope(value: unknown): value is RelayPolicyScope {
  if (!isRecord(value)) return false;
  return (
    isEnumValue(value.kind, POLICY_SCOPE_KINDS) &&
    (value.workspaceIds === undefined || isStringArray(value.workspaceIds)) &&
    (value.repoIds === undefined || isStringArray(value.repoIds)) &&
    (value.pathPrefixes === undefined || isStringArray(value.pathPrefixes))
  );
}

function isCapabilityGrantRef(value: unknown): value is CapabilityGrantRef {
  if (!isRecord(value)) return false;
  return (
    hasString(value.id) &&
    hasString(value.ref) &&
    hasValidCapabilityGrantBits(value) &&
    (value.decision === undefined ||
      isEnumValue(value.decision, CAPABILITY_DECISIONS)) &&
    isEnumValue(value.policyClass, CAPABILITY_POLICY_CLASSES) &&
    (value.scope === undefined || isRelayPolicyScope(value.scope)) &&
    isOptionalString(value.actorId) &&
    isOptionalString(value.auditEventId) &&
    isWorkContextPrivacyMetadata(value.privacy)
  );
}

export function isWorkContext(value: unknown): value is WorkContext {
  if (!isRecord(value)) return false;
  return (
    value.schemaVersion === WORK_CONTEXT_SCHEMA_VERSION &&
    hasString(value.id) &&
    isOptionalString(value.title) &&
    hasString(value.createdAt) &&
    hasString(value.updatedAt) &&
    hasString(value.source) &&
    isAnchors(value.anchors) &&
    Array.isArray(value.actors) &&
    value.actors.every(isActor) &&
    Array.isArray(value.tasks) &&
    value.tasks.every(isTaskRef) &&
    Array.isArray(value.artifacts) &&
    value.artifacts.every(isArtifactRef) &&
    Array.isArray(value.auditRefs) &&
    value.auditRefs.every(isAuditEventRef) &&
    Array.isArray(value.capabilityGrants) &&
    value.capabilityGrants.every(isCapabilityGrantRef) &&
    (value.relatedContextRefs === undefined ||
      isStringArray(value.relatedContextRefs)) &&
    isWorkContextPrivacyMetadata(value.privacy)
  );
}
