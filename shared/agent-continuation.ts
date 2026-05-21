import { HANDOFF_SCHEMA_VERSION } from './handoff.js';
import type { GlobalSessionId, NodeId } from './identity.js';
import {
  isWorkContextPrivacyMetadata,
  type ArtifactRef,
  type SessionRef,
  type TaskRef,
  type WorkContext,
  type WorkContextId,
  type WorkContextPrivacyMetadata,
} from './work-context.js';

export const RESUME_MODES = [
  'summary-only',
  'native-same-node',
  'native-cross-node',
  'relay-managed-timeline',
] as const;

export type ResumeMode = (typeof RESUME_MODES)[number];

export const RESUME_CONFIDENCES = ['high', 'medium', 'low', 'unknown'] as const;

export type ResumeConfidence = (typeof RESUME_CONFIDENCES)[number];

export const RESUME_EXCLUDE_CLASSES = [
  'credential',
  'secret',
  'provider-auth',
  'profile-db',
  'env',
  'raw-transcript',
  'unbounded-log',
  'raw-payload',
  'cache',
  'unsafe-local-path',
] as const;

export type ResumeExcludeClass = (typeof RESUME_EXCLUDE_CLASSES)[number];

export const RESUME_STATE_LOCATION_KINDS = [
  'native-session',
  'bounded-summary-ref',
  'relay-timeline-ref',
  'provider-state-ref',
  'profile-db',
  'provider-auth-store',
  'environment',
  'raw-transcript',
  'cache',
] as const;

export type ResumeStateLocationKind =
  (typeof RESUME_STATE_LOCATION_KINDS)[number];

export const RESUME_READINESS_SIGNAL_KINDS = [
  'node-online',
  'cwd-present',
  'command-available',
  'runtime-auth-ready',
  'capability-granted',
  'work-context-bound',
] as const;

export type ResumeReadinessSignalKind =
  (typeof RESUME_READINESS_SIGNAL_KINDS)[number];

export interface SafeExcludeMetadata {
  class: ResumeExcludeClass;
  reason: string;
  sourceRef?: string;
  replacementRef?: string;
  count?: number;
}

export interface ResumeStateLocation {
  kind: ResumeStateLocationKind;
  ref: string;
  summary: string;
  portable: boolean;
  includeByDefault: boolean;
  exclude?: SafeExcludeMetadata;
  privacy?: WorkContextPrivacyMetadata;
}

export interface NativeResumeCommandMetadata {
  commandSummary: string;
  argvPreview?: string[];
  requiresSameNode: boolean;
  requiresAuth: boolean;
  requiredCapabilities: string[];
}

export interface DestinationReadinessSignal {
  kind: ResumeReadinessSignalKind;
  summary: string;
  ready: boolean;
  ref?: string;
}

export interface HarnessDescriptor {
  id: string;
  providerId: string;
  displayName?: string;
  supportedResumeModes: ResumeMode[];
  safeStateLocations: ResumeStateLocation[];
  unsafeStateLocations: ResumeStateLocation[];
  nativeResumeCommand?: NativeResumeCommandMetadata;
  destinationReadiness: DestinationReadinessSignal[];
}

export interface ResumeEndpointRef {
  nodeId: NodeId;
  cwd: string;
  sessionId?: string;
  globalSessionId?: GlobalSessionId;
}

export interface ResumeManifestSummary {
  hash: string;
  fileCount: number;
  byteCount?: number;
}

export interface ResumeTaskRef {
  kind: TaskRef['kind'];
  id: string;
  title?: string;
  url?: string;
  status?: string;
}

export interface ResumeArtifactSummary {
  id: string;
  kind: ArtifactRef['kind'];
  title?: string;
  uri?: string;
  path?: string;
  summary?: string;
  privacy: WorkContextPrivacyMetadata;
}

export interface AgentStateExportPlan {
  workContextId: WorkContextId;
  resumeMode: ResumeMode;
  confidence: ResumeConfidence;
  source: ResumeEndpointRef;
  destination: ResumeEndpointRef;
  harnessId?: string;
  nativeSessionRef?: string;
  boundedSummaryRefs: string[];
  relayTimelineRefs: string[];
  providerStateRefs: string[];
  artifactRefs: ResumeArtifactSummary[];
  excludes: SafeExcludeMetadata[];
  manifest?: ResumeManifestSummary;
  authRuntimeReadiness: DestinationReadinessSignal[];
}

export interface ResumeInstructionProviderFields {
  providerId: string;
  commandSummary?: string;
  wrapperFields?: Record<string, string>;
}

export interface ResumeInstruction {
  mode: ResumeMode;
  confidence: ResumeConfidence;
  providerNeutralBrief: string;
  currentObjective: string;
  recentEvidence: string[];
  openBlockers: string[];
  requiredFirstAction: string;
  provider?: ResumeInstructionProviderFields;
}

export interface ResumeVerification {
  workContextId: WorkContextId;
  destinationNodeId: NodeId;
  destinationSessionId?: string;
  acknowledged: boolean;
  started: boolean;
  checkedAt?: string;
  confidence: ResumeConfidence;
  readiness: DestinationReadinessSignal[];
}

export interface AgentResumeBundle {
  schemaVersion: typeof HANDOFF_SCHEMA_VERSION;
  id: string;
  createdAt: string;
  workContextId: WorkContextId;
  mode: ResumeMode;
  confidence: ResumeConfidence;
  source: ResumeEndpointRef;
  destination: ResumeEndpointRef;
  harness?: HarnessDescriptor;
  exportPlan: AgentStateExportPlan;
  instruction: ResumeInstruction;
  verification?: ResumeVerification;
}

export interface GenerateHandoffBriefInput {
  id: string;
  createdAt?: string;
  workContext: WorkContext;
  sourceSession?: SessionRef;
  destination: ResumeEndpointRef;
  harness?: HarnessDescriptor;
  requestedMode?: ResumeMode;
  manifest?: ResumeManifestSummary;
  branchName?: string;
  baseCommit?: string;
  currentObjective?: string;
  recentEvidence?: string[];
  openBlockers?: string[];
  requiredFirstAction?: string;
  boundedSummaryRefs?: string[];
  relayTimelineRefs?: string[];
  providerStateRefs?: string[];
  excludes?: SafeExcludeMetadata[];
  readiness?: DestinationReadinessSignal[];
}

const RESUME_MODE_SET = new Set<string>(RESUME_MODES);
const RESUME_CONFIDENCE_SET = new Set<string>(RESUME_CONFIDENCES);
const RESUME_EXCLUDE_CLASS_SET = new Set<string>(RESUME_EXCLUDE_CLASSES);
const STATE_LOCATION_KIND_SET = new Set<string>(RESUME_STATE_LOCATION_KINDS);
const READINESS_SIGNAL_KIND_SET = new Set<string>(
  RESUME_READINESS_SIGNAL_KINDS
);
const SHA256_HEX_RE = /^[a-f0-9]{64}$/i;
const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const DEFAULT_EXCLUDES: SafeExcludeMetadata[] = [
  {
    class: 'credential',
    reason: 'credentials are never copied in agent continuation bundles',
  },
  {
    class: 'provider-auth',
    reason: 'provider auth stores remain owned by the destination runtime',
  },
  {
    class: 'profile-db',
    reason: 'Hermes/agent profile databases are not Relay handoff payloads',
  },
  {
    class: 'raw-transcript',
    reason:
      'resume uses bounded summaries or transcript refs, not raw transcripts',
  },
  {
    class: 'env',
    reason:
      'environment variables may contain secrets and are re-established locally',
  },
  {
    class: 'cache',
    reason: 'caches are runtime-local and excluded from portable state',
  },
];
const FORBIDDEN_RAW_KEYS = new Set<string>([
  'rawContent',
  'rawPayload',
  'rawSecret',
  'providerAuth',
  'authToken',
  'token',
  'secret',
  'env',
  'environment',
  'transcript',
  'transcriptPayload',
  'rawTranscript',
  'logPayload',
  'hermesDbPath',
  'providerDb',
  'profileDb',
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

function isOptionalStringArray(value: unknown): boolean {
  return value === undefined || isStringArray(value);
}

function isNonNegativeFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isOptionalNonNegativeFinite(value: unknown): boolean {
  return value === undefined || isNonNegativeFinite(value);
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === 'string' && ISO_TIMESTAMP_RE.test(value);
}

function isOptionalIsoTimestamp(value: unknown): boolean {
  return value === undefined || isIsoTimestamp(value);
}

function isEnumValue(value: unknown, values: Set<string>): value is string {
  return typeof value === 'string' && values.has(value);
}

function isEnumArray(value: unknown, values: Set<string>): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => isEnumValue(item, values))
  );
}

function hasNoForbiddenRawKeys(value: unknown): boolean {
  if (Array.isArray(value)) return value.every(hasNoForbiddenRawKeys);
  if (!isRecord(value)) return true;
  return Object.entries(value).every(
    ([key, nested]) =>
      !FORBIDDEN_RAW_KEYS.has(key) && hasNoForbiddenRawKeys(nested)
  );
}

export function isResumeMode(value: unknown): value is ResumeMode {
  return isEnumValue(value, RESUME_MODE_SET);
}

export function isResumeConfidence(value: unknown): value is ResumeConfidence {
  return isEnumValue(value, RESUME_CONFIDENCE_SET);
}

export function isResumeExcludeClass(
  value: unknown
): value is ResumeExcludeClass {
  return isEnumValue(value, RESUME_EXCLUDE_CLASS_SET);
}

function isSafeExcludeMetadata(value: unknown): value is SafeExcludeMetadata {
  if (!isRecord(value)) return false;
  return (
    isResumeExcludeClass(value.class) &&
    hasString(value.reason) &&
    isOptionalString(value.sourceRef) &&
    isOptionalString(value.replacementRef) &&
    isOptionalNonNegativeFinite(value.count)
  );
}

function isResumeStateLocation(value: unknown): value is ResumeStateLocation {
  if (!isRecord(value) || !hasNoForbiddenRawKeys(value)) return false;
  return (
    isEnumValue(value.kind, STATE_LOCATION_KIND_SET) &&
    hasString(value.ref) &&
    hasString(value.summary) &&
    typeof value.portable === 'boolean' &&
    typeof value.includeByDefault === 'boolean' &&
    (value.exclude === undefined || isSafeExcludeMetadata(value.exclude)) &&
    (value.privacy === undefined ||
      isWorkContextPrivacyMetadata(value.privacy))
  );
}

function isDestinationReadinessSignal(
  value: unknown
): value is DestinationReadinessSignal {
  if (!isRecord(value)) return false;
  return (
    isEnumValue(value.kind, READINESS_SIGNAL_KIND_SET) &&
    hasString(value.summary) &&
    typeof value.ready === 'boolean' &&
    isOptionalString(value.ref)
  );
}

function isNativeResumeCommandMetadata(
  value: unknown
): value is NativeResumeCommandMetadata {
  if (!isRecord(value) || !hasNoForbiddenRawKeys(value)) return false;
  return (
    hasString(value.commandSummary) &&
    isOptionalStringArray(value.argvPreview) &&
    typeof value.requiresSameNode === 'boolean' &&
    typeof value.requiresAuth === 'boolean' &&
    isStringArray(value.requiredCapabilities)
  );
}

export function isHarnessDescriptor(
  value: unknown
): value is HarnessDescriptor {
  if (!isRecord(value) || !hasNoForbiddenRawKeys(value)) return false;
  return (
    hasString(value.id) &&
    hasString(value.providerId) &&
    isOptionalString(value.displayName) &&
    isEnumArray(value.supportedResumeModes, RESUME_MODE_SET) &&
    Array.isArray(value.safeStateLocations) &&
    value.safeStateLocations.every(isResumeStateLocation) &&
    Array.isArray(value.unsafeStateLocations) &&
    value.unsafeStateLocations.every(isResumeStateLocation) &&
    (value.nativeResumeCommand === undefined ||
      isNativeResumeCommandMetadata(value.nativeResumeCommand)) &&
    Array.isArray(value.destinationReadiness) &&
    value.destinationReadiness.every(isDestinationReadinessSignal)
  );
}

function isResumeEndpointRef(value: unknown): value is ResumeEndpointRef {
  if (!isRecord(value)) return false;
  return (
    hasString(value.nodeId) &&
    hasString(value.cwd) &&
    isOptionalString(value.sessionId) &&
    isOptionalString(value.globalSessionId)
  );
}

function isResumeManifestSummary(
  value: unknown
): value is ResumeManifestSummary {
  if (!isRecord(value)) return false;
  return (
    typeof value.hash === 'string' &&
    SHA256_HEX_RE.test(value.hash) &&
    isNonNegativeFinite(value.fileCount) &&
    isOptionalNonNegativeFinite(value.byteCount)
  );
}

function isResumeArtifactSummary(
  value: unknown
): value is ResumeArtifactSummary {
  if (!isRecord(value) || !hasNoForbiddenRawKeys(value)) return false;
  return (
    hasString(value.id) &&
    hasString(value.kind) &&
    isOptionalString(value.title) &&
    isOptionalString(value.uri) &&
    isOptionalString(value.path) &&
    isOptionalString(value.summary) &&
    isWorkContextPrivacyMetadata(value.privacy)
  );
}

export function isAgentStateExportPlan(
  value: unknown
): value is AgentStateExportPlan {
  if (!isRecord(value) || !hasNoForbiddenRawKeys(value)) return false;
  return (
    hasString(value.workContextId) &&
    isResumeMode(value.resumeMode) &&
    isResumeConfidence(value.confidence) &&
    isResumeEndpointRef(value.source) &&
    isResumeEndpointRef(value.destination) &&
    isOptionalString(value.harnessId) &&
    isOptionalString(value.nativeSessionRef) &&
    isStringArray(value.boundedSummaryRefs) &&
    isStringArray(value.relayTimelineRefs) &&
    isStringArray(value.providerStateRefs) &&
    Array.isArray(value.artifactRefs) &&
    value.artifactRefs.every(isResumeArtifactSummary) &&
    Array.isArray(value.excludes) &&
    value.excludes.every(isSafeExcludeMetadata) &&
    (value.manifest === undefined || isResumeManifestSummary(value.manifest)) &&
    Array.isArray(value.authRuntimeReadiness) &&
    value.authRuntimeReadiness.every(isDestinationReadinessSignal)
  );
}

function isResumeInstructionProviderFields(
  value: unknown
): value is ResumeInstructionProviderFields {
  if (!isRecord(value) || !hasNoForbiddenRawKeys(value)) return false;
  return (
    hasString(value.providerId) &&
    isOptionalString(value.commandSummary) &&
    (value.wrapperFields === undefined ||
      (isRecord(value.wrapperFields) &&
        Object.values(value.wrapperFields).every(
          (item) => typeof item === 'string'
        )))
  );
}

export function isResumeInstruction(
  value: unknown
): value is ResumeInstruction {
  if (!isRecord(value) || !hasNoForbiddenRawKeys(value)) return false;
  return (
    isResumeMode(value.mode) &&
    isResumeConfidence(value.confidence) &&
    hasString(value.providerNeutralBrief) &&
    hasString(value.currentObjective) &&
    isStringArray(value.recentEvidence) &&
    isStringArray(value.openBlockers) &&
    hasString(value.requiredFirstAction) &&
    (value.provider === undefined ||
      isResumeInstructionProviderFields(value.provider))
  );
}

export function isResumeVerification(
  value: unknown
): value is ResumeVerification {
  if (!isRecord(value)) return false;
  return (
    hasString(value.workContextId) &&
    hasString(value.destinationNodeId) &&
    isOptionalString(value.destinationSessionId) &&
    typeof value.acknowledged === 'boolean' &&
    typeof value.started === 'boolean' &&
    isOptionalIsoTimestamp(value.checkedAt) &&
    isResumeConfidence(value.confidence) &&
    Array.isArray(value.readiness) &&
    value.readiness.every(isDestinationReadinessSignal)
  );
}

export function isAgentResumeBundle(
  value: unknown
): value is AgentResumeBundle {
  if (!isRecord(value) || !hasNoForbiddenRawKeys(value)) return false;
  return (
    value.schemaVersion === HANDOFF_SCHEMA_VERSION &&
    hasString(value.id) &&
    isIsoTimestamp(value.createdAt) &&
    hasString(value.workContextId) &&
    isResumeMode(value.mode) &&
    isResumeConfidence(value.confidence) &&
    isResumeEndpointRef(value.source) &&
    isResumeEndpointRef(value.destination) &&
    (value.harness === undefined || isHarnessDescriptor(value.harness)) &&
    isAgentStateExportPlan(value.exportPlan) &&
    isResumeInstruction(value.instruction) &&
    (value.verification === undefined ||
      isResumeVerification(value.verification)) &&
    value.exportPlan.workContextId === value.workContextId &&
    value.instruction.mode === value.mode &&
    value.instruction.confidence === value.confidence &&
    value.exportPlan.resumeMode === value.mode &&
    value.exportPlan.confidence === value.confidence
  );
}

function firstPresent<T>(...items: Array<T | undefined>): T | undefined {
  return items.find((item): item is T => item !== undefined);
}

function truncate(value: string, max = 240): string {
  const trimmed = value.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 1)}…`;
}

function boundedStrings(
  values: string[] | undefined,
  fallback: string
): string[] {
  const bounded = (values ?? [])
    .filter((item) => item.trim().length > 0)
    .slice(0, 8)
    .map((item) => truncate(item));
  return bounded.length > 0 ? bounded : [fallback];
}

function summarizeTasks(tasks: TaskRef[]): ResumeTaskRef[] {
  return tasks.slice(0, 12).map((task) => ({
    kind: task.kind,
    id: task.id,
    ...(task.title !== undefined ? { title: task.title } : {}),
    ...(task.url !== undefined ? { url: task.url } : {}),
    ...(task.status !== undefined ? { status: task.status } : {}),
  }));
}

function summarizeArtifacts(artifacts: ArtifactRef[]): ResumeArtifactSummary[] {
  return artifacts.slice(0, 12).map((artifact) => ({
    id: artifact.id,
    kind: artifact.kind,
    ...(artifact.title !== undefined ? { title: artifact.title } : {}),
    ...(artifact.uri !== undefined ? { uri: artifact.uri } : {}),
    ...(artifact.path !== undefined ? { path: artifact.path } : {}),
    ...(artifact.summary !== undefined
      ? { summary: truncate(artifact.summary) }
      : {}),
    privacy: artifact.privacy,
  }));
}

function pickMode(
  requestedMode: ResumeMode | undefined,
  harness: HarnessDescriptor | undefined,
  sourceNodeId: NodeId,
  destinationNodeId: NodeId
): ResumeMode {
  if (
    requestedMode &&
    (requestedMode === 'summary-only' ||
      (harness !== undefined &&
        harness.supportedResumeModes.includes(requestedMode)))
  ) {
    return requestedMode;
  }
  if (!harness) return 'summary-only';
  if (
    sourceNodeId === destinationNodeId &&
    harness.supportedResumeModes.includes('native-same-node')
  ) {
    return 'native-same-node';
  }
  if (harness.supportedResumeModes.includes('native-cross-node')) {
    return 'native-cross-node';
  }
  if (harness.supportedResumeModes.includes('relay-managed-timeline')) {
    return 'relay-managed-timeline';
  }
  return 'summary-only';
}

function confidenceForMode(
  mode: ResumeMode,
  readiness: DestinationReadinessSignal[]
): ResumeConfidence {
  if (mode === 'summary-only') return 'low';
  if (readiness.length === 0) return 'unknown';
  return readiness.every((signal) => signal.ready) ? 'high' : 'medium';
}

function buildProviderBrief(input: {
  workContext: WorkContext;
  source: ResumeEndpointRef;
  destination: ResumeEndpointRef;
  mode: ResumeMode;
  confidence: ResumeConfidence;
  manifest: ResumeManifestSummary | undefined;
  branchName: string | undefined;
  baseCommit: string | undefined;
  tasks: ResumeTaskRef[];
  artifacts: ResumeArtifactSummary[];
  excludes: SafeExcludeMetadata[];
  currentObjective: string;
  recentEvidence: string[];
  openBlockers: string[];
  requiredFirstAction: string;
}): string {
  const repo = input.workContext.anchors.repo;
  const repoIdentity = firstPresent(
    repo?.repoIdentity,
    repo?.ownerRepo,
    repo?.remoteUrl,
    'none'
  );
  const sourceCwdMetadata = [
    `cwd=${input.source.cwd}`,
    input.source.sessionId ? `session=${input.source.sessionId}` : undefined,
    input.source.globalSessionId
      ? `global=${input.source.globalSessionId}`
      : undefined,
  ]
    .filter((item): item is string => item !== undefined)
    .join(', ');
  const manifestSummary = input.manifest
    ? `hash=${input.manifest.hash}, files=${input.manifest.fileCount}`
    : 'hash=none, files=0';
  const taskSummary = input.tasks
    .map(
      (task) => `${task.kind}:${task.id}${task.title ? ` (${task.title})` : ''}`
    )
    .join('; ');
  const artifactSummary = input.artifacts
    .map(
      (artifact) =>
        `${artifact.kind}:${artifact.id}${artifact.summary ? ` (${artifact.summary})` : ''}`
    )
    .join('; ');

  return [
    `WorkContext: ${input.workContext.id}`,
    `Task refs: ${taskSummary || 'none'}`,
    `Repo identity: ${repoIdentity}`,
    `Source node: ${input.source.nodeId}`,
    `Destination node: ${input.destination.nodeId}`,
    `Source cwd metadata: ${sourceCwdMetadata}`,
    `Destination cwd: ${input.destination.cwd}`,
    `Branch/base: ${input.branchName ?? repo?.branchName ?? 'unknown'} / ${input.baseCommit ?? 'unknown'}`,
    `Manifest: ${manifestSummary}`,
    `Excluded classes: ${input.excludes.map((item) => item.class).join(', ')}`,
    `Resume mode/confidence: ${input.mode} / ${input.confidence}`,
    `Current objective: ${input.currentObjective}`,
    `Recent evidence: ${input.recentEvidence.join(' | ')}`,
    `Artifact refs: ${artifactSummary || 'none'}`,
    `Open blockers: ${input.openBlockers.join(' | ')}`,
    `Required first action: ${input.requiredFirstAction}`,
  ].join('\n');
}

function resolveSourceEndpoint(
  workContext: WorkContext,
  sourceSession: SessionRef | undefined
): ResumeEndpointRef {
  const sourceNode =
    firstPresent(sourceSession?.nodeId, workContext.anchors.node?.nodeId) ??
    'unknown-source-node';
  const sourceCwd =
    firstPresent(
      sourceSession?.cwd,
      workContext.anchors.worktree?.localPath,
      workContext.anchors.repo?.localPath
    ) ?? 'unknown-cwd';
  return {
    nodeId: sourceNode,
    cwd: sourceCwd,
    ...(sourceSession?.sessionId !== undefined
      ? { sessionId: sourceSession.sessionId }
      : {}),
    ...(sourceSession?.globalSessionId !== undefined
      ? { globalSessionId: sourceSession.globalSessionId }
      : {}),
  };
}

function deriveBoundedSummaryRefs(
  input: GenerateHandoffBriefInput,
  artifacts: ResumeArtifactSummary[]
): string[] {
  return (
    input.boundedSummaryRefs ??
    artifacts
      .filter(
        (artifact) =>
          artifact.kind === 'report' || artifact.kind === 'transcript-ref'
      )
      .map((artifact) => artifact.uri ?? artifact.path ?? artifact.id)
  ).slice(0, 12);
}

function deriveRelayTimelineRefs(input: GenerateHandoffBriefInput): string[] {
  return (
    input.relayTimelineRefs ??
    input.workContext.auditRefs.map((ref) => ref.logRef ?? ref.id)
  ).slice(0, 12);
}

function providerFields(
  harness: HarnessDescriptor | undefined
): ResumeInstructionProviderFields | undefined {
  if (!harness) return undefined;
  return {
    providerId: harness.providerId,
    ...(harness.nativeResumeCommand?.commandSummary !== undefined
      ? { commandSummary: harness.nativeResumeCommand.commandSummary }
      : {}),
  };
}

function buildInstruction(input: {
  mode: ResumeMode;
  confidence: ResumeConfidence;
  providerNeutralBrief: string;
  currentObjective: string;
  recentEvidence: string[];
  openBlockers: string[];
  requiredFirstAction: string;
  harness: HarnessDescriptor | undefined;
}): ResumeInstruction {
  const provider = providerFields(input.harness);
  return {
    mode: input.mode,
    confidence: input.confidence,
    providerNeutralBrief: input.providerNeutralBrief,
    currentObjective: input.currentObjective,
    recentEvidence: input.recentEvidence,
    openBlockers: input.openBlockers,
    requiredFirstAction: input.requiredFirstAction,
    ...(provider !== undefined ? { provider } : {}),
  };
}

function buildExportPlan(input: {
  request: GenerateHandoffBriefInput;
  mode: ResumeMode;
  confidence: ResumeConfidence;
  source: ResumeEndpointRef;
  artifacts: ResumeArtifactSummary[];
  excludes: SafeExcludeMetadata[];
  readiness: DestinationReadinessSignal[];
  boundedSummaryRefs: string[];
}): AgentStateExportPlan {
  return {
    workContextId: input.request.workContext.id,
    resumeMode: input.mode,
    confidence: input.confidence,
    source: input.source,
    destination: input.request.destination,
    ...(input.request.harness !== undefined
      ? { harnessId: input.request.harness.id }
      : {}),
    ...(input.mode.startsWith('native-') && input.source.sessionId !== undefined
      ? { nativeSessionRef: `${input.source.nodeId}:${input.source.sessionId}` }
      : {}),
    boundedSummaryRefs: input.boundedSummaryRefs,
    relayTimelineRefs: deriveRelayTimelineRefs(input.request),
    providerStateRefs: (input.request.providerStateRefs ?? []).slice(0, 12),
    artifactRefs: input.artifacts,
    excludes: input.excludes,
    ...(input.request.manifest !== undefined
      ? { manifest: input.request.manifest }
      : {}),
    authRuntimeReadiness: input.readiness,
  };
}

function objectiveFromInput(
  input: GenerateHandoffBriefInput,
  source: ResumeEndpointRef
): string {
  const repo = input.workContext.anchors.repo;
  const repoIdentity =
    firstPresent(
      repo?.repoIdentity,
      repo?.ownerRepo,
      repo?.remoteUrl,
      source.cwd
    ) ?? source.cwd;
  return truncate(
    input.currentObjective ??
      input.workContext.title ??
      `Resume work for ${repoIdentity}`
  );
}

export function generateHandoffBrief(
  input: GenerateHandoffBriefInput
): AgentResumeBundle {
  const workContext = input.workContext;
  const source = resolveSourceEndpoint(
    workContext,
    firstPresent(input.sourceSession, workContext.anchors.session)
  );
  const readiness =
    input.readiness ?? input.harness?.destinationReadiness ?? [];
  const mode = pickMode(
    input.requestedMode,
    input.harness,
    source.nodeId,
    input.destination.nodeId
  );
  const confidence = confidenceForMode(mode, readiness);
  const tasks = summarizeTasks(workContext.tasks);
  const artifacts = summarizeArtifacts(workContext.artifacts);
  const excludes = [...(input.excludes ?? DEFAULT_EXCLUDES)];
  const branchName = firstPresent(
    input.branchName,
    workContext.anchors.worktree?.branchName,
    workContext.anchors.repo?.branchName
  );
  const currentObjective = objectiveFromInput(input, source);
  const recentEvidence = boundedStrings(
    input.recentEvidence ??
      artifacts.map(
        (artifact) => artifact.summary ?? artifact.title ?? artifact.id
      ),
    'No bounded evidence refs were provided; use WorkContext refs before acting.'
  );
  const openBlockers = boundedStrings(
    input.openBlockers,
    'No open blockers recorded in bounded handoff metadata.'
  );
  const requiredFirstAction = truncate(
    input.requiredFirstAction ??
      `Verify destination cwd ${input.destination.cwd} and WorkContext ${workContext.id} before editing.`
  );
  const providerNeutralBrief = buildProviderBrief({
    workContext,
    source,
    destination: input.destination,
    mode,
    confidence,
    manifest: input.manifest,
    branchName,
    baseCommit: input.baseCommit,
    tasks,
    artifacts,
    excludes,
    currentObjective,
    recentEvidence,
    openBlockers,
    requiredFirstAction,
  });
  const boundedSummaryRefs = deriveBoundedSummaryRefs(input, artifacts);
  const exportPlan = buildExportPlan({
    request: input,
    mode,
    confidence,
    source,
    artifacts,
    excludes,
    readiness,
    boundedSummaryRefs,
  });
  const instruction = buildInstruction({
    mode,
    confidence,
    providerNeutralBrief,
    currentObjective,
    recentEvidence,
    openBlockers,
    requiredFirstAction,
    harness: input.harness,
  });

  return {
    schemaVersion: HANDOFF_SCHEMA_VERSION,
    id: input.id,
    createdAt: input.createdAt ?? new Date().toISOString(),
    workContextId: workContext.id,
    mode,
    confidence,
    source,
    destination: input.destination,
    ...(input.harness !== undefined ? { harness: input.harness } : {}),
    exportPlan,
    instruction,
  };
}
