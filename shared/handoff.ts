import {
  parseFileResourceRef,
  type FileResourceRef,
} from './file-resource-ref.js';
import type {
  GlobalSessionId,
  NodeId,
  RepoInstanceId,
  WorktreeInstanceId,
} from './identity.js';
import {
  isEnvironmentOption,
  type EnvironmentOption,
} from './environment-option.js';
import {
  isRelayCapabilityBit,
  type RelayCapabilityBit,
  type RelayCapabilityDecision,
  type RelayPolicyScope,
} from './security-policy.js';
import {
  isSessionDurabilityState,
  type SessionDurabilityState,
} from './session-durability.js';
import type { WorkContextId } from './work-context.js';

export const HANDOFF_SCHEMA_VERSION = 1 as const;

export const HANDOFF_SOURCE_DISPOSITIONS = [
  'left-running',
  'stop-requested',
  'stopped',
  'stale-source',
  'handed-off',
  'handoff-failed',
] as const;

export type HandoffSourceDisposition =
  (typeof HANDOFF_SOURCE_DISPOSITIONS)[number];

export const HANDOFF_CONFLICT_CODES = [
  'STALE_SOURCE',
  'MISSING_CAPABILITY_GRANT',
  'BASE_MISMATCH',
  'DESTINATION_DIRTY',
  'DESTINATION_CONFLICT',
  'UNTRACKED_COLLISION',
  'SECRET_EXCLUDED',
  'CACHE_EXCLUDED',
  'UNSAFE_PATH_MAPPING',
  'LAUNCH_FAILURE',
] as const;

export type HandoffConflictCode = (typeof HANDOFF_CONFLICT_CODES)[number];

export const HANDOFF_REASON_CODES = [
  'HANDOFF_PLANNED',
  'SNAPSHOT_CAPTURED',
  'TRANSFER_STARTED',
  'TRANSFER_COMPLETED',
  'APPLY_STARTED',
  'APPLY_COMPLETED',
  'LAUNCH_STARTED',
  'LAUNCH_COMPLETED',
  'VERIFY_STARTED',
  'VERIFY_COMPLETED',
  'CANCELLED_BY_OPERATOR',
  'FAILED_STALE_SOURCE',
  'FAILED_MISSING_GRANT',
  'FAILED_BASE_MISMATCH',
  'FAILED_DESTINATION_CONFLICT',
  'FAILED_UNSAFE_PATH_MAPPING',
  'FAILED_LAUNCH',
] as const;

export type HandoffReasonCode = (typeof HANDOFF_REASON_CODES)[number];

export const HANDOFF_RUN_STATES = [
  'planned',
  'snapshotting',
  'transferring',
  'applying',
  'launching',
  'verifying',
  'complete',
  'failed',
  'cancelled',
] as const;

export type HandoffRunState = (typeof HANDOFF_RUN_STATES)[number];

export const HANDOFF_TRANSFER_MODES = [
  'tracked-patch',
  'approved-untracked-files',
  'artifact-refs',
  'metadata-only',
] as const;

export type HandoffTransferMode = (typeof HANDOFF_TRANSFER_MODES)[number];

const HANDOFF_GRANT_LEG_SOURCE_READ = 'source-read';
const HANDOFF_GRANT_LEG_DESTINATION_WRITE = 'destination-write';
const HANDOFF_GRANT_LEG_DESTINATION_SESSION_CREATE =
  'destination-session-create';
const HANDOFF_GRANT_LEG_DESTINATION_EXEC = 'destination-exec';

export const HANDOFF_REQUIRED_GRANT_LEGS = [
  HANDOFF_GRANT_LEG_SOURCE_READ,
  HANDOFF_GRANT_LEG_DESTINATION_WRITE,
  HANDOFF_GRANT_LEG_DESTINATION_SESSION_CREATE,
  HANDOFF_GRANT_LEG_DESTINATION_EXEC,
] as const;

export type HandoffRequiredGrantLeg =
  (typeof HANDOFF_REQUIRED_GRANT_LEGS)[number];

export type HandoffDestinationWriteMode = 'create' | 'overwrite';
export type HandoffPathKind = 'file' | 'directory' | 'patch' | 'artifact';
export type HandoffSnapshotGroup =
  | 'tracked-patch'
  | 'staged-metadata'
  | 'approved-untracked'
  | 'source-summary'
  | 'excluded-secret'
  | 'excluded-cache';

export interface HandoffSourceRef {
  nodeId: NodeId;
  sessionId: string;
  workContextId: WorkContextId;
  globalSessionId?: GlobalSessionId;
  cwd: string;
  disposition: HandoffSourceDisposition;
  durabilityState?: SessionDurabilityState;
}

export interface HandoffDestinationRef {
  nodeId: NodeId;
  option: EnvironmentOption;
  cwd: string;
  repoInstanceId?: RepoInstanceId;
  worktreeInstanceId?: WorktreeInstanceId;
}

export interface HandoffRuntimeRequest {
  kind: 'agent' | 'terminal';
  providerId?: string;
  commandSummary?: string;
  requiredCapabilities: RelayCapabilityBit[];
}

export interface HandoffRequest {
  schemaVersion: typeof HANDOFF_SCHEMA_VERSION;
  id: string;
  requestedAt: string;
  requestedByActorId: string;
  source: HandoffSourceRef;
  destination: HandoffDestinationRef;
  desiredRuntime: HandoffRuntimeRequest;
  reason?: string;
}

export interface HandoffPathEndpoint {
  nodeId: NodeId;
  path: string;
  pathHashSha256?: string;
  fileRef?: FileResourceRef;
}

export interface HandoffPathMapping {
  kind: HandoffPathKind;
  source: HandoffPathEndpoint;
  destination: HandoffPathEndpoint & {
    mode: HandoffDestinationWriteMode;
    expectedHashSha256?: string;
  };
  bytes?: number;
  sha256?: string;
  summary?: string;
}

export interface HandoffDestinationProposal {
  nodeId: NodeId;
  cwd: string;
  repoInstanceId?: RepoInstanceId;
  worktreeInstanceId?: WorktreeInstanceId;
  branchName?: string;
  summary: string;
}

export interface HandoffConflict {
  code: HandoffConflictCode;
  message: string;
  nodeId?: NodeId;
  pathHashSha256?: string;
  sourcePathHashSha256?: string;
  destinationPathHashSha256?: string;
  reasonCode?: HandoffReasonCode;
}

export interface HandoffRequiredGrant {
  leg: HandoffRequiredGrantLeg;
  nodeId: NodeId;
  capability: RelayCapabilityBit;
  decision?: RelayCapabilityDecision;
  grantRef?: string;
  scope?: RelayPolicyScope;
}

export interface HandoffLaunchPreview {
  nodeId: NodeId;
  cwd: string;
  runtime: HandoffRuntimeRequest;
  summary: string;
  workContextId: WorkContextId;
}

export interface HandoffPlan {
  schemaVersion: typeof HANDOFF_SCHEMA_VERSION;
  id: string;
  requestId: string;
  createdAt: string;
  source: HandoffSourceRef;
  route: {
    sourceNodeId: NodeId;
    destinationNodeId: NodeId;
    workContextId: WorkContextId;
  };
  transferMode: HandoffTransferMode;
  includedGroups: HandoffSnapshotGroup[];
  excludedGroups: HandoffSnapshotGroup[];
  fileCount: number;
  byteCount: number;
  destinationProposal: HandoffDestinationProposal;
  pathMappings: HandoffPathMapping[];
  conflicts: HandoffConflict[];
  requiredGrants: HandoffRequiredGrant[];
  launchPreview: HandoffLaunchPreview;
}

export interface HandoffSnapshotArtifactRef {
  group: HandoffSnapshotGroup;
  ref: FileResourceRef;
  size: number;
  sha256: string;
  summary?: string;
}

export interface HandoffSnapshot {
  schemaVersion: typeof HANDOFF_SCHEMA_VERSION;
  id: string;
  planId: string;
  capturedAt: string;
  source: HandoffSourceRef;
  baseCommit?: string;
  branchName?: string;
  trackedPatchRefs: HandoffSnapshotArtifactRef[];
  stagedMetadataRefs: HandoffSnapshotArtifactRef[];
  approvedUntrackedRefs: HandoffSnapshotArtifactRef[];
  excludedGroups: HandoffSnapshotGroup[];
  cwd: string;
  sourceSummaryRefs: HandoffSnapshotArtifactRef[];
  summary: string;
}

export interface HandoffRunTransition {
  from: HandoffRunState;
  to: HandoffRunState;
  at: string;
  reasonCode: HandoffReasonCode;
  actorId?: string;
}

export interface HandoffRun {
  schemaVersion: typeof HANDOFF_SCHEMA_VERSION;
  id: string;
  requestId: string;
  planId?: string;
  snapshotId?: string;
  state: HandoffRunState;
  sourceDisposition: HandoffSourceDisposition;
  reasonCode?: HandoffReasonCode;
  conflicts: HandoffConflict[];
  transitions: HandoffRunTransition[];
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

const SOURCE_DISPOSITION_SET = new Set<string>(HANDOFF_SOURCE_DISPOSITIONS);
const CONFLICT_CODE_SET = new Set<string>(HANDOFF_CONFLICT_CODES);
const REASON_CODE_SET = new Set<string>(HANDOFF_REASON_CODES);
const RUN_STATE_SET = new Set<string>(HANDOFF_RUN_STATES);
const TRANSFER_MODE_SET = new Set<string>(HANDOFF_TRANSFER_MODES);
const REQUIRED_GRANT_LEG_SET = new Set<string>(HANDOFF_REQUIRED_GRANT_LEGS);
const PATH_KIND_SET = new Set<string>([
  'file',
  'directory',
  'patch',
  'artifact',
]);
const SNAPSHOT_GROUP_SET = new Set<string>([
  'tracked-patch',
  'staged-metadata',
  'approved-untracked',
  'source-summary',
  'excluded-secret',
  'excluded-cache',
]);
const DESTINATION_WRITE_MODE_SET = new Set<string>(['create', 'overwrite']);
const RUNTIME_KIND_SET = new Set<string>(['agent', 'terminal']);
const SHA256_HEX_RE = /^[a-f0-9]{64}$/i;
const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const FORBIDDEN_RAW_KEYS = new Set<string>([
  'rawContent',
  'rawPayload',
  'rawSecret',
  'providerAuth',
  'authToken',
  'secret',
  'transcript',
  'transcriptPayload',
  'logPayload',
]);

const ALLOWED_TRANSITIONS: Record<HandoffRunState, readonly HandoffRunState[]> =
  {
    planned: ['snapshotting', 'failed', 'cancelled'],
    snapshotting: ['transferring', 'failed', 'cancelled'],
    transferring: ['applying', 'failed', 'cancelled'],
    applying: ['launching', 'failed', 'cancelled'],
    launching: ['verifying', 'failed', 'cancelled'],
    verifying: ['complete', 'failed', 'cancelled'],
    complete: [],
    failed: [],
    cancelled: [],
  };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

function isOptionalSha256(value: unknown): boolean {
  return (
    value === undefined ||
    (typeof value === 'string' && SHA256_HEX_RE.test(value))
  );
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === 'string' && ISO_TIMESTAMP_RE.test(value);
}

function isNonNegativeFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isEnumValue(value: unknown, values: Set<string>): value is string {
  return typeof value === 'string' && values.has(value);
}

function isEnumArray(value: unknown, values: Set<string>): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => isEnumValue(item, values))
  );
}

function isCapabilityArray(value: unknown): value is RelayCapabilityBit[] {
  return Array.isArray(value) && value.every(isRelayCapabilityBit);
}

function hasNoForbiddenRawKeys(value: unknown): boolean {
  if (Array.isArray(value)) return value.every(hasNoForbiddenRawKeys);
  if (!isRecord(value)) return true;
  return Object.entries(value).every(
    ([key, nested]) =>
      !FORBIDDEN_RAW_KEYS.has(key) && hasNoForbiddenRawKeys(nested)
  );
}

function isRelayPolicyScope(value: unknown): value is RelayPolicyScope {
  if (!isRecord(value)) return false;
  const stringArrayOrMissing = (item: unknown) =>
    item === undefined ||
    (Array.isArray(item) && item.every((v) => typeof v === 'string'));
  return (
    (value.kind === 'node' ||
      value.kind === 'workspace' ||
      value.kind === 'repo' ||
      value.kind === 'path') &&
    stringArrayOrMissing(value.workspaceIds) &&
    stringArrayOrMissing(value.repoIds) &&
    stringArrayOrMissing(value.pathPrefixes)
  );
}

function isAbsolutePath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.startsWith('/') &&
    value.trim().length > 1
  );
}

export function isHandoffSourceDisposition(
  value: unknown
): value is HandoffSourceDisposition {
  return isEnumValue(value, SOURCE_DISPOSITION_SET);
}

export function isHandoffConflictCode(
  value: unknown
): value is HandoffConflictCode {
  return isEnumValue(value, CONFLICT_CODE_SET);
}

export function isHandoffReasonCode(
  value: unknown
): value is HandoffReasonCode {
  return isEnumValue(value, REASON_CODE_SET);
}

export function isHandoffRunState(value: unknown): value is HandoffRunState {
  return isEnumValue(value, RUN_STATE_SET);
}

export function isHandoffRunTransitionAllowed(
  from: HandoffRunState,
  to: HandoffRunState
): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

function isSourceRef(value: unknown): value is HandoffSourceRef {
  if (!isRecord(value)) return false;
  return (
    hasString(value.nodeId) &&
    hasString(value.sessionId) &&
    hasString(value.workContextId) &&
    isOptionalString(value.globalSessionId) &&
    isAbsolutePath(value.cwd) &&
    isHandoffSourceDisposition(value.disposition) &&
    (value.durabilityState === undefined ||
      isSessionDurabilityState(value.durabilityState))
  );
}

function destinationOptionMatches(value: Record<string, unknown>): boolean {
  const option = value.option as EnvironmentOption;
  return option.node.nodeId === value.nodeId && option.cwd === value.cwd;
}

function isDestinationRef(value: unknown): value is HandoffDestinationRef {
  if (!isRecord(value) || !isEnvironmentOption(value.option)) return false;
  return (
    hasString(value.nodeId) &&
    isAbsolutePath(value.cwd) &&
    isOptionalString(value.repoInstanceId) &&
    isOptionalString(value.worktreeInstanceId) &&
    destinationOptionMatches(value)
  );
}

function isRuntimeRequest(value: unknown): value is HandoffRuntimeRequest {
  if (!isRecord(value)) return false;
  return (
    isEnumValue(value.kind, RUNTIME_KIND_SET) &&
    isOptionalString(value.providerId) &&
    isOptionalString(value.commandSummary) &&
    isCapabilityArray(value.requiredCapabilities)
  );
}

export function isHandoffRequest(value: unknown): value is HandoffRequest {
  if (!isRecord(value) || !hasNoForbiddenRawKeys(value)) return false;
  return (
    value.schemaVersion === HANDOFF_SCHEMA_VERSION &&
    hasString(value.id) &&
    isIsoTimestamp(value.requestedAt) &&
    hasString(value.requestedByActorId) &&
    isSourceRef(value.source) &&
    isDestinationRef(value.destination) &&
    isRuntimeRequest(value.desiredRuntime) &&
    isOptionalString(value.reason)
  );
}

function isFileRef(value: unknown): value is FileResourceRef {
  return parseFileResourceRef(value) !== null;
}

function fileRefMatchesEndpoint(value: Record<string, unknown>): boolean {
  if (value.fileRef === undefined) return true;
  const ref = parseFileResourceRef(value.fileRef);
  return ref !== null && ref.nodeId === value.nodeId && ref.path === value.path;
}

function isPathEndpoint(value: unknown): value is HandoffPathEndpoint {
  if (!isRecord(value)) return false;
  return (
    hasString(value.nodeId) &&
    isAbsolutePath(value.path) &&
    isOptionalSha256(value.pathHashSha256) &&
    (value.fileRef === undefined || isFileRef(value.fileRef)) &&
    fileRefMatchesEndpoint(value)
  );
}

function isPathMapping(value: unknown): value is HandoffPathMapping {
  if (!isRecord(value)) return false;
  if (!isPathEndpoint(value.source) || !isRecord(value.destination))
    return false;
  return (
    isEnumValue(value.kind, PATH_KIND_SET) &&
    isPathEndpoint(value.destination) &&
    isEnumValue(value.destination.mode, DESTINATION_WRITE_MODE_SET) &&
    isOptionalSha256(value.destination.expectedHashSha256) &&
    (value.bytes === undefined || isNonNegativeFinite(value.bytes)) &&
    isOptionalSha256(value.sha256) &&
    isOptionalString(value.summary)
  );
}

function isDestinationProposal(
  value: unknown
): value is HandoffDestinationProposal {
  if (!isRecord(value)) return false;
  return (
    hasString(value.nodeId) &&
    isAbsolutePath(value.cwd) &&
    isOptionalString(value.repoInstanceId) &&
    isOptionalString(value.worktreeInstanceId) &&
    isOptionalString(value.branchName) &&
    hasString(value.summary)
  );
}

function isConflict(value: unknown): value is HandoffConflict {
  if (!isRecord(value)) return false;
  return (
    isHandoffConflictCode(value.code) &&
    hasString(value.message) &&
    isOptionalString(value.nodeId) &&
    isOptionalSha256(value.pathHashSha256) &&
    isOptionalSha256(value.sourcePathHashSha256) &&
    isOptionalSha256(value.destinationPathHashSha256) &&
    (value.reasonCode === undefined || isHandoffReasonCode(value.reasonCode))
  );
}

function isGrantCapabilityValid(
  leg: HandoffRequiredGrantLeg,
  capability: RelayCapabilityBit
): boolean {
  switch (leg) {
    case HANDOFF_GRANT_LEG_SOURCE_READ:
      return capability === 'rpc:fs:read' || capability === 'rpc:git:read';
    case HANDOFF_GRANT_LEG_DESTINATION_WRITE:
      return capability === 'rpc:fs:write' || capability === 'rpc:git:write';
    case HANDOFF_GRANT_LEG_DESTINATION_SESSION_CREATE:
      return (
        capability === 'session:create:terminal' ||
        capability === 'session:create:agent'
      );
    case HANDOFF_GRANT_LEG_DESTINATION_EXEC:
      return capability === 'pty:exec:arbitrary';
  }
}

function isRequiredGrantLeg(value: unknown): value is HandoffRequiredGrantLeg {
  return isEnumValue(value, REQUIRED_GRANT_LEG_SET);
}

function isRequiredGrant(value: unknown): value is HandoffRequiredGrant {
  if (!isRecord(value)) return false;
  if (!isRequiredGrantLeg(value.leg)) return false;
  if (!isRelayCapabilityBit(value.capability)) return false;
  return (
    hasString(value.nodeId) &&
    isGrantCapabilityValid(value.leg, value.capability) &&
    (value.decision === undefined ||
      value.decision === 'allow' ||
      value.decision === 'requiresConfirmation' ||
      value.decision === 'deny') &&
    isOptionalString(value.grantRef) &&
    (value.scope === undefined || isRelayPolicyScope(value.scope))
  );
}

function hasRequiredGrantLegs(grants: HandoffRequiredGrant[]): boolean {
  const legs = new Set(grants.map((grant) => grant.leg));
  return (
    legs.has(HANDOFF_GRANT_LEG_SOURCE_READ) &&
    legs.has(HANDOFF_GRANT_LEG_DESTINATION_WRITE) &&
    (legs.has(HANDOFF_GRANT_LEG_DESTINATION_SESSION_CREATE) ||
      legs.has(HANDOFF_GRANT_LEG_DESTINATION_EXEC))
  );
}

function isLaunchPreview(value: unknown): value is HandoffLaunchPreview {
  if (!isRecord(value)) return false;
  return (
    hasString(value.nodeId) &&
    isAbsolutePath(value.cwd) &&
    isRuntimeRequest(value.runtime) &&
    hasString(value.summary) &&
    hasString(value.workContextId)
  );
}

function isPlanRoute(value: unknown): value is HandoffPlan['route'] {
  if (!isRecord(value)) return false;
  return (
    hasString(value.sourceNodeId) &&
    hasString(value.destinationNodeId) &&
    hasString(value.workContextId)
  );
}

function pathMappingsMatchRoute(
  mappings: HandoffPathMapping[],
  route: HandoffPlan['route']
): boolean {
  return mappings.every(
    (mapping) =>
      mapping.source.nodeId === route.sourceNodeId &&
      mapping.destination.nodeId === route.destinationNodeId
  );
}

function requiredGrantsMatchRoute(
  grants: HandoffRequiredGrant[],
  route: HandoffPlan['route']
): boolean {
  return grants.every((grant) => {
    if (grant.leg === HANDOFF_GRANT_LEG_SOURCE_READ)
      return grant.nodeId === route.sourceNodeId;
    return grant.nodeId === route.destinationNodeId;
  });
}

export function isHandoffPlan(value: unknown): value is HandoffPlan {
  if (!isRecord(value) || !hasNoForbiddenRawKeys(value)) return false;
  if (
    !Array.isArray(value.requiredGrants) ||
    !value.requiredGrants.every(isRequiredGrant)
  )
    return false;
  return (
    value.schemaVersion === HANDOFF_SCHEMA_VERSION &&
    hasString(value.id) &&
    hasString(value.requestId) &&
    isIsoTimestamp(value.createdAt) &&
    isSourceRef(value.source) &&
    isPlanRoute(value.route) &&
    value.route.sourceNodeId === value.source.nodeId &&
    value.route.workContextId === value.source.workContextId &&
    isEnumValue(value.transferMode, TRANSFER_MODE_SET) &&
    isEnumArray(value.includedGroups, SNAPSHOT_GROUP_SET) &&
    isEnumArray(value.excludedGroups, SNAPSHOT_GROUP_SET) &&
    isNonNegativeFinite(value.fileCount) &&
    isNonNegativeFinite(value.byteCount) &&
    isDestinationProposal(value.destinationProposal) &&
    value.destinationProposal.nodeId === value.route.destinationNodeId &&
    Array.isArray(value.pathMappings) &&
    value.pathMappings.every(isPathMapping) &&
    pathMappingsMatchRoute(value.pathMappings, value.route) &&
    Array.isArray(value.conflicts) &&
    value.conflicts.every(isConflict) &&
    hasRequiredGrantLegs(value.requiredGrants) &&
    requiredGrantsMatchRoute(value.requiredGrants, value.route) &&
    isLaunchPreview(value.launchPreview) &&
    value.launchPreview.workContextId === value.source.workContextId
  );
}

function isSnapshotArtifactRef(
  value: unknown
): value is HandoffSnapshotArtifactRef {
  if (!isRecord(value)) return false;
  return (
    isEnumValue(value.group, SNAPSHOT_GROUP_SET) &&
    isFileRef(value.ref) &&
    isNonNegativeFinite(value.size) &&
    typeof value.sha256 === 'string' &&
    SHA256_HEX_RE.test(value.sha256) &&
    isOptionalString(value.summary)
  );
}

function isSnapshotArtifactArray(
  value: unknown
): value is HandoffSnapshotArtifactRef[] {
  return Array.isArray(value) && value.every(isSnapshotArtifactRef);
}

export function isHandoffSnapshot(value: unknown): value is HandoffSnapshot {
  if (!isRecord(value) || !hasNoForbiddenRawKeys(value)) return false;
  return (
    value.schemaVersion === HANDOFF_SCHEMA_VERSION &&
    hasString(value.id) &&
    hasString(value.planId) &&
    isIsoTimestamp(value.capturedAt) &&
    isSourceRef(value.source) &&
    isOptionalString(value.baseCommit) &&
    isOptionalString(value.branchName) &&
    isSnapshotArtifactArray(value.trackedPatchRefs) &&
    isSnapshotArtifactArray(value.stagedMetadataRefs) &&
    isSnapshotArtifactArray(value.approvedUntrackedRefs) &&
    isEnumArray(value.excludedGroups, SNAPSHOT_GROUP_SET) &&
    isAbsolutePath(value.cwd) &&
    value.cwd === value.source.cwd &&
    isSnapshotArtifactArray(value.sourceSummaryRefs) &&
    hasString(value.summary)
  );
}

function isRunTransition(value: unknown): value is HandoffRunTransition {
  if (!isRecord(value)) return false;
  if (!isHandoffRunState(value.from) || !isHandoffRunState(value.to))
    return false;
  return (
    isHandoffRunTransitionAllowed(value.from, value.to) &&
    isIsoTimestamp(value.at) &&
    isHandoffReasonCode(value.reasonCode) &&
    isOptionalString(value.actorId)
  );
}

function transitionsLeadToCurrentState(
  transitions: HandoffRunTransition[],
  state: HandoffRunState
): boolean {
  if (transitions.length === 0) return state === 'planned';
  let previousState: HandoffRunState = 'planned';
  for (const transition of transitions) {
    if (transition.from !== previousState) return false;
    previousState = transition.to;
  }
  return previousState === state;
}

export function isHandoffRun(value: unknown): value is HandoffRun {
  if (!isRecord(value) || !hasNoForbiddenRawKeys(value)) return false;
  if (
    !Array.isArray(value.transitions) ||
    !value.transitions.every(isRunTransition)
  )
    return false;
  return (
    value.schemaVersion === HANDOFF_SCHEMA_VERSION &&
    hasString(value.id) &&
    hasString(value.requestId) &&
    isOptionalString(value.planId) &&
    isOptionalString(value.snapshotId) &&
    isHandoffRunState(value.state) &&
    isHandoffSourceDisposition(value.sourceDisposition) &&
    (value.reasonCode === undefined || isHandoffReasonCode(value.reasonCode)) &&
    Array.isArray(value.conflicts) &&
    value.conflicts.every(isConflict) &&
    transitionsLeadToCurrentState(value.transitions, value.state) &&
    isIsoTimestamp(value.createdAt) &&
    isIsoTimestamp(value.updatedAt) &&
    (value.completedAt === undefined || isIsoTimestamp(value.completedAt))
  );
}
