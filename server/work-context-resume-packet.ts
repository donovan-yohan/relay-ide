import {
  PIPELINE_HANDOFF_STAGES,
  isPipelineHandoffArtifactStale,
  type PipelineHandoffArtifact,
  type PipelineHandoffEvidence,
  type PipelineHandoffStage,
  type PipelineHandoffStageName,
} from '../shared/pipeline-handoff-artifact.js';
import type {
  ArtifactRef,
  AuditEventRef,
  TaskRef,
  WorkContextPrivacyClass,
} from '../shared/work-context.js';
import type {
  WorkContextArtifactReadResult,
  WorkContextArtifactStore,
} from './work-context-artifacts.js';
import type { WorkContextResumeSnapshot } from './work-contexts.js';

export const WORK_CONTEXT_RESUME_PACKET_SCHEMA_VERSION = 1 as const;

const DEFAULT_MAX_ARTIFACTS = 24;
const DEFAULT_MAX_AUDIT_REFS = 20;
const DEFAULT_MAX_CHARS = 24_000;
const ARTIFACT_SCAN_MULTIPLIER = 4;
const STAGE_ORDER: Record<PipelineHandoffStageName, number> =
  Object.fromEntries(
    PIPELINE_HANDOFF_STAGES.map((stage, index) => [stage, index])
  ) as Record<PipelineHandoffStageName, number>;
const APPROVAL_VERDICTS = new Set(['passed', 'approved', 'released']);
const BLOCKING_VERDICTS = new Set([
  'failed',
  'blocked',
  'changes-requested',
  'not-released',
]);
const UNRESOLVED_DECISIONS = new Set(['blocked', 'deferred']);
const MAX_PAYLOAD_TASK_REFS = 50;
const MAX_PAYLOAD_NON_GOALS = 20;
const MAX_PAYLOAD_STAGES = PIPELINE_HANDOFF_STAGES.length;
const MAX_STAGE_EVIDENCE_ITEMS = 20;
const MAX_STAGE_COMMAND_ITEMS = 20;
const MAX_STAGE_FOCUS_ITEMS = 20;

export interface WorkContextResumePacketLimits {
  maxArtifacts: number;
  maxAuditRefs: number;
  maxChars: number;
  approximateChars: number;
  truncated: boolean;
}

export interface WorkContextResumePacketOptions {
  currentHeadSha?: string;
  publicSafe?: boolean;
  maxArtifacts?: number;
  maxAuditRefs?: number;
  maxChars?: number;
}

export interface WorkContextResumeGoal {
  summary: string;
  taskRefs: TaskRef[];
  status: 'present' | 'missing';
  source: 'work-context' | 'artifact' | 'missing';
}

export interface WorkContextResumeArtifactSummary {
  id: string;
  kind: string;
  title?: string;
  uri?: string;
  summary?: string;
  producedAt?: string;
  privacyClass?: WorkContextPrivacyClass;
  publicSafe: boolean;
  stale?: boolean;
  staleReason?: string;
}

export interface WorkContextResumeGateEvidence {
  key: string;
  stage: PipelineHandoffStageName;
  status: string;
  summary: string;
  artifactId: string;
  artifactTitle: string;
  capturedAt: string;
  taskRef?: Pick<TaskRef, 'kind' | 'id' | 'title' | 'url' | 'status'>;
  prNumber?: number;
  headSha?: string;
  currentHeadSha?: string;
  stale: boolean;
  historical: boolean;
  acceptanceEvidence: PipelineHandoffEvidence[];
  commands: Array<{
    label: string;
    status: string;
    summary: string;
    exitCode?: number;
  }>;
  downstreamFocus: string[];
}

export interface WorkContextResumeBlocker {
  source: 'stage-verdict' | 'evidence' | 'missing-current-evidence';
  summary: string;
  artifactId?: string;
  stage?: PipelineHandoffStageName;
  taskRef?: Pick<TaskRef, 'kind' | 'id'>;
}

export interface WorkContextResumePacket {
  schemaVersion: typeof WORK_CONTEXT_RESUME_PACKET_SCHEMA_VERSION;
  generatedAt: string;
  workContext: WorkContextResumeSnapshot['workContext'];
  goal: WorkContextResumeGoal;
  nonGoals: string[];
  pinnedArtifacts: WorkContextResumeArtifactSummary[];
  artifacts: WorkContextResumeArtifactSummary[];
  evidence: {
    current: WorkContextResumeGateEvidence[];
    historical: WorkContextResumeGateEvidence[];
    missing: WorkContextResumeBlocker[];
  };
  blockers: {
    open: WorkContextResumeBlocker[];
    unresolvedDecisions: string[];
  };
  auditRefs: AuditEventRef[];
  sessions: WorkContextResumeSnapshot['sessions'];
  node: WorkContextResumeSnapshot['node'];
  suggestedNextAction: {
    kind:
      | 'resolve-blockers'
      | 'produce-current-evidence'
      | 'continue'
      | 'inspect-pins';
    summary: string;
  };
  privacy: {
    mode: 'compact-refs' | 'public-safe';
    rawPayloadAvailable: false;
    rawTranscriptIncluded: false;
    transcriptExportAvailable: false;
    rawLogsIncluded: false;
    rawTranscriptsIncluded: false;
    publicSafeDistinctions: string[];
  };
  provenance: {
    source: 'deterministic-work-context-index';
    artifactStoreAvailable: boolean;
    artifactRecordsScanned: number;
    rawDbHistorySummarizedByLlm: false;
  };
  limits: WorkContextResumePacketLimits;
}

export function resumeArtifactScanLimit(
  options: WorkContextResumePacketOptions = {}
): number {
  const maxArtifacts = boundedInt(
    options.maxArtifacts,
    DEFAULT_MAX_ARTIFACTS,
    1,
    200
  );
  return Math.min(maxArtifacts * ARTIFACT_SCAN_MULTIPLIER, 200);
}

export function readWorkContextArtifactsForResume(input: {
  store: WorkContextArtifactStore | null | undefined;
  workContextId: string;
  limit: number;
}): WorkContextArtifactReadResult[] {
  if (!input.store) return [];
  const records = input.store.list({
    workContextId: input.workContextId,
    includeSuperseded: true,
    limit: input.limit,
  });
  const readable: WorkContextArtifactReadResult[] = [];
  for (const record of records) {
    readable.push(input.store.read(record.metadata.id) ?? record);
  }
  return readable;
}

export function buildWorkContextResumePacket(input: {
  snapshot: WorkContextResumeSnapshot;
  artifactRecords?: WorkContextArtifactReadResult[];
  artifactStoreAvailable?: boolean;
  options?: WorkContextResumePacketOptions;
  generatedAt?: string;
}): WorkContextResumePacket {
  const options = input.options ?? {};
  const maxArtifacts = boundedInt(
    options.maxArtifacts,
    DEFAULT_MAX_ARTIFACTS,
    1,
    200
  );
  const maxAuditRefs = boundedInt(
    options.maxAuditRefs,
    DEFAULT_MAX_AUDIT_REFS,
    1,
    200
  );
  const maxChars = boundedInt(
    options.maxChars,
    DEFAULT_MAX_CHARS,
    4_000,
    200_000
  );
  const publicSafe = options.publicSafe ?? false;
  const artifactRecords = stableArtifactRecords(input.artifactRecords ?? []);
  const readableRecords = publicSafe
    ? artifactRecords.filter(
        (record) => record.metadata.visibility === 'public'
      )
    : artifactRecords;
  const payloads = readableRecords.filter(hasPayload);
  const goal = deriveGoal(
    input.snapshot.workContext.tasks,
    payloads,
    publicSafe
  );
  const nonGoals = boundedUniqueStrings(
    payloads.flatMap((record) =>
      payloadNonGoals(record.payload).map((item) => safeText(item, publicSafe))
    ),
    20
  );
  const pinnedArtifacts = summarizePinnedArtifacts(
    input.snapshot.artifacts,
    artifactRecords,
    options.currentHeadSha,
    publicSafe,
    maxArtifacts
  );
  const artifacts = summarizeArtifactRefs(
    input.snapshot.artifacts,
    publicSafe,
    maxArtifacts
  );
  const allEvidence = summarizeEvidence(
    payloads,
    options.currentHeadSha,
    publicSafe
  );
  const latestCurrentEvidence = latestByKey(
    allEvidence.filter((item) => !item.stale)
  );
  const latestHistoricalEvidence = latestByKey(
    allEvidence.filter((item) => item.stale)
  );
  const currentEvidence = latestCurrentEvidence.slice(0, maxArtifacts);
  const historicalEvidence = latestHistoricalEvidence.slice(0, maxArtifacts);
  const missing = missingCurrentEvidence(
    input.snapshot.workContext.tasks,
    latestCurrentEvidence
  );
  const openBlockers = [
    ...blockedStageEvidence(latestCurrentEvidence),
    ...missing,
  ];
  const unresolvedDecisions = unresolvedDecisionSummaries(
    latestCurrentEvidence,
    publicSafe
  );
  const workContext = publicSafe
    ? sanitizeResumeWorkContext(input.snapshot.workContext)
    : input.snapshot.workContext;
  const sessions = publicSafe
    ? sanitizeResumeSessions(input.snapshot.sessions)
    : input.snapshot.sessions;
  const packet: WorkContextResumePacket = {
    schemaVersion: WORK_CONTEXT_RESUME_PACKET_SCHEMA_VERSION,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    workContext,
    goal,
    nonGoals,
    pinnedArtifacts,
    artifacts,
    evidence: {
      current: currentEvidence,
      historical: historicalEvidence,
      missing,
    },
    blockers: {
      open: openBlockers,
      unresolvedDecisions,
    },
    auditRefs: publicSafe
      ? input.snapshot.auditRefs
          .slice(-maxAuditRefs)
          .map((ref) => safeAuditRef(ref))
      : input.snapshot.auditRefs.slice(-maxAuditRefs),
    sessions,
    node: publicSafe ? safeNode(input.snapshot.node) : input.snapshot.node,
    suggestedNextAction: suggestedNextAction(
      openBlockers,
      currentEvidence,
      pinnedArtifacts
    ),
    privacy: {
      mode: publicSafe ? 'public-safe' : 'compact-refs',
      rawPayloadAvailable: false,
      rawTranscriptIncluded: false,
      transcriptExportAvailable: false,
      rawLogsIncluded: false,
      rawTranscriptsIncluded: false,
      publicSafeDistinctions: publicSafeDistinctions(publicSafe),
    },
    provenance: {
      source: 'deterministic-work-context-index',
      artifactStoreAvailable:
        input.artifactStoreAvailable ?? artifactRecords.length > 0,
      artifactRecordsScanned: artifactRecords.length,
      rawDbHistorySummarizedByLlm: false,
    },
    limits: {
      maxArtifacts,
      maxAuditRefs,
      maxChars,
      approximateChars: 0,
      truncated: false,
    },
  };
  return enforcePacketCharLimit(packet, maxChars);
}

function stableArtifactRecords(
  records: WorkContextArtifactReadResult[]
): WorkContextArtifactReadResult[] {
  return [...records].sort((a, b) => {
    const captured = b.metadata.capturedAt.localeCompare(a.metadata.capturedAt);
    if (captured !== 0) return captured;
    return a.metadata.id.localeCompare(b.metadata.id);
  });
}

function hasPayload(
  record: WorkContextArtifactReadResult
): record is WorkContextArtifactReadResult & {
  payload: PipelineHandoffArtifact;
} {
  return isPipelineHandoffPayload(record.payload);
}

function isPipelineHandoffPayload(
  value: unknown
): value is PipelineHandoffArtifact {
  if (!isRecordObject(value)) return false;
  if (typeof value.id !== 'string' || typeof value.title !== 'string')
    return false;
  if (
    typeof value.createdAt !== 'string' ||
    typeof value.updatedAt !== 'string'
  )
    return false;
  if (!isRecordObject(value.scope)) return false;
  if (typeof value.scope.summary !== 'string') return false;
  if (!isRecordObject(value.head)) return false;
  if (typeof value.head.headSha !== 'string') return false;
  if (!isRecordObject(value.head.staleIf)) return false;
  if (value.head.staleIf.headShaChanges !== true) return false;
  return true;
}

function isRecordObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function payloadTaskRefs(
  payload: PipelineHandoffArtifact,
  publicSafe: boolean
): TaskRef[] {
  const rawTaskRefs = Array.isArray(payload.scope.taskRefs)
    ? payload.scope.taskRefs
    : [];
  const taskRefs = rawTaskRefs
    .slice(0, MAX_PAYLOAD_TASK_REFS)
    .filter(isTaskRef);
  return publicSafe
    ? taskRefs.filter(isPublicTaskRef).map((task) => safeTaskRef(task, true))
    : taskRefs;
}

function payloadNonGoals(payload: PipelineHandoffArtifact): string[] {
  return Array.isArray(payload.scope.nonGoals)
    ? payload.scope.nonGoals
        .slice(0, MAX_PAYLOAD_NON_GOALS)
        .filter((item): item is string => typeof item === 'string')
    : [];
}

function payloadStages(
  payload: PipelineHandoffArtifact
): PipelineHandoffStage[] {
  return Array.isArray(payload.stages)
    ? payload.stages.slice(0, MAX_PAYLOAD_STAGES).filter(isPipelineHandoffStage)
    : [];
}

function isTaskRef(value: unknown): value is TaskRef {
  return (
    isRecordObject(value) &&
    typeof value.kind === 'string' &&
    typeof value.id === 'string' &&
    (value.title === undefined || typeof value.title === 'string') &&
    (value.url === undefined || typeof value.url === 'string') &&
    (value.status === undefined || typeof value.status === 'string')
  );
}

function isPipelineHandoffStage(value: unknown): value is PipelineHandoffStage {
  if (!isRecordObject(value)) return false;
  if (
    !PIPELINE_HANDOFF_STAGES.includes(value.stage as PipelineHandoffStageName)
  )
    return false;
  if (typeof value.addedAt !== 'string') return false;
  if (typeof value.summary !== 'string') return false;
  switch (value.stage) {
    case 'implementation':
      return typeof value.decision === 'string';
    case 'qa':
    case 'review':
    case 'release':
      return typeof value.verdict === 'string';
    default:
      return false;
  }
}

function deriveGoal(
  tasks: TaskRef[],
  payloads: Array<
    WorkContextArtifactReadResult & { payload: PipelineHandoffArtifact }
  >,
  publicSafe: boolean
): WorkContextResumeGoal {
  const latestPayload = payloads[0]?.payload;
  const taskRefs = publicSafe
    ? tasks.filter(isPublicTaskRef).map((task) => safeTaskRef(task, true))
    : tasks;
  if (latestPayload) {
    return {
      summary: safeText(latestPayload.scope.summary, publicSafe),
      taskRefs: payloadTaskRefs(latestPayload, publicSafe),
      status: 'present',
      source: 'artifact',
    };
  }
  if (taskRefs.length > 0) {
    return {
      summary: taskRefs.map((task) => `${task.kind}:${task.id}`).join(', '),
      taskRefs,
      status: 'present',
      source: 'work-context',
    };
  }
  return {
    summary: 'No goal/task refs are present in this WorkContext packet.',
    taskRefs: [],
    status: 'missing',
    source: 'missing',
  };
}

function summarizePinnedArtifacts(
  pinned: ArtifactRef[],
  records: WorkContextArtifactReadResult[],
  currentHeadSha: string | undefined,
  publicSafe: boolean,
  maxArtifacts: number
): WorkContextResumeArtifactSummary[] {
  const recordsById = new Map(
    records.map((record) => [record.metadata.id, record])
  );
  return pinned
    .filter((artifact) =>
      artifact.uri?.startsWith('relay://work-context-artifacts/')
    )
    .filter((artifact) => includeArtifactRefInResume(artifact, publicSafe))
    .map((artifact) => {
      const record = artifact.uri
        ? recordsById.get(lastUriSegment(artifact.uri))
        : undefined;
      const stale = Boolean(
        currentHeadSha &&
        record?.metadata.headSha &&
        record.metadata.headSha !== currentHeadSha
      );
      return {
        id: safeText(artifact.id, publicSafe),
        kind: artifact.kind,
        ...(artifact.title
          ? { title: safeText(artifact.title, publicSafe) }
          : {}),
        ...(artifact.uri
          ? {
              uri: publicSafe
                ? publicSafeArtifactUri(artifact.uri)
                : artifact.uri,
            }
          : {}),
        ...(artifact.summary
          ? { summary: safeText(artifact.summary, publicSafe) }
          : {}),
        ...(artifact.producedAt ? { producedAt: artifact.producedAt } : {}),
        privacyClass: artifact.privacy.classification,
        publicSafe: isPublicPrivacy(artifact.privacy.classification),
        ...(stale
          ? { stale, staleReason: 'artifact head differs from currentHeadSha' }
          : {}),
      } satisfies WorkContextResumeArtifactSummary;
    })
    .sort(
      (a, b) =>
        (b.producedAt ?? '').localeCompare(a.producedAt ?? '') ||
        a.id.localeCompare(b.id)
    )
    .slice(0, maxArtifacts);
}

function summarizeArtifactRefs(
  artifacts: ArtifactRef[],
  publicSafe: boolean,
  maxArtifacts: number
): WorkContextResumeArtifactSummary[] {
  return artifacts
    .filter((artifact) => includeArtifactRefInResume(artifact, publicSafe))
    .map((artifact) => ({
      id: safeText(artifact.id, publicSafe),
      kind: artifact.kind,
      ...(artifact.title
        ? { title: safeText(artifact.title, publicSafe) }
        : {}),
      ...(artifact.uri
        ? {
            uri: publicSafe
              ? publicSafeArtifactUri(artifact.uri)
              : artifact.uri,
          }
        : {}),
      ...(artifact.summary
        ? { summary: safeText(artifact.summary, publicSafe) }
        : {}),
      ...(artifact.producedAt ? { producedAt: artifact.producedAt } : {}),
      privacyClass: artifact.privacy.classification,
      publicSafe: isPublicPrivacy(artifact.privacy.classification),
    }))
    .sort(
      (a, b) =>
        (b.producedAt ?? '').localeCompare(a.producedAt ?? '') ||
        a.id.localeCompare(b.id)
    )
    .slice(0, maxArtifacts);
}

function summarizeEvidence(
  payloads: Array<
    WorkContextArtifactReadResult & { payload: PipelineHandoffArtifact }
  >,
  currentHeadSha: string | undefined,
  publicSafe: boolean
): WorkContextResumeGateEvidence[] {
  const evidence: WorkContextResumeGateEvidence[] = [];
  for (const record of payloads) {
    const artifact = record.payload;
    const stale = currentHeadSha
      ? isPipelineHandoffArtifactStale(artifact, currentHeadSha)
      : false;
    for (const stage of payloadStages(artifact).sort(compareStages)) {
      evidence.push({
        key: evidenceKey(record, stage),
        stage: stage.stage,
        status: stageStatus(stage),
        summary: safeText(stage.summary, publicSafe),
        artifactId: safeText(record.metadata.id, publicSafe),
        artifactTitle: safeText(record.metadata.title, publicSafe),
        capturedAt: record.metadata.capturedAt,
        ...(record.metadata.taskRef
          ? { taskRef: safeTaskRef(record.metadata.taskRef, publicSafe) }
          : {}),
        ...(record.metadata.prNumber
          ? { prNumber: record.metadata.prNumber }
          : {}),
        headSha: artifact.head.headSha,
        ...(currentHeadSha ? { currentHeadSha } : {}),
        stale,
        historical: stale,
        acceptanceEvidence: stageAcceptanceEvidence(stage).map((item) =>
          safeEvidence(item, publicSafe)
        ),
        commands: stageCommands(stage).map((command) => ({
          label: safeText(command.label, publicSafe),
          status: command.status,
          summary: safeText(command.summary, publicSafe),
          ...(command.exitCode !== undefined
            ? { exitCode: command.exitCode }
            : {}),
        })),
        downstreamFocus: stageDownstreamFocus(stage).map((item) =>
          safeText(item, publicSafe)
        ),
      });
    }
  }
  return evidence.sort(compareEvidenceLatestFirst);
}

function stageAcceptanceEvidence(
  stage: PipelineHandoffStage
): PipelineHandoffEvidence[] {
  return Array.isArray(stage.acceptanceEvidence)
    ? stage.acceptanceEvidence
        .slice(0, MAX_STAGE_EVIDENCE_ITEMS)
        .filter(isPipelineHandoffEvidence)
    : [];
}

function stageCommands(
  stage: PipelineHandoffStage
): PipelineHandoffStage['commands'] {
  return Array.isArray(stage.commands)
    ? stage.commands
        .slice(0, MAX_STAGE_COMMAND_ITEMS)
        .filter(isPipelineHandoffCommand)
    : [];
}

function stageDownstreamFocus(stage: PipelineHandoffStage): string[] {
  return Array.isArray(stage.downstreamFocus)
    ? stage.downstreamFocus
        .slice(0, MAX_STAGE_FOCUS_ITEMS)
        .filter((item): item is string => typeof item === 'string')
    : [];
}

function isPipelineHandoffEvidence(
  value: unknown
): value is PipelineHandoffEvidence {
  return (
    isRecordObject(value) &&
    typeof value.label === 'string' &&
    typeof value.disposition === 'string' &&
    typeof value.summary === 'string'
  );
}

function isPipelineHandoffCommand(
  value: unknown
): value is PipelineHandoffStage['commands'][number] {
  return (
    isRecordObject(value) &&
    typeof value.label === 'string' &&
    typeof value.status === 'string' &&
    typeof value.summary === 'string' &&
    (value.exitCode === undefined || typeof value.exitCode === 'number')
  );
}

function latestByKey(
  items: WorkContextResumeGateEvidence[]
): WorkContextResumeGateEvidence[] {
  const byKey = new Map<string, WorkContextResumeGateEvidence>();
  for (const item of items) {
    if (!byKey.has(item.key)) byKey.set(item.key, item);
  }
  return Array.from(byKey.values()).sort(compareEvidenceLatestFirst);
}

function evidenceKey(
  record: WorkContextArtifactReadResult,
  stage: PipelineHandoffStage
): string {
  const task = record.metadata.taskRef;
  const taskPart = task ? `${task.kind}:${task.id}` : 'task:unknown';
  const prPart = record.metadata.prNumber
    ? `pr:${record.metadata.prNumber}`
    : 'pr:none';
  return `${stage.stage}|${taskPart}|${prPart}`;
}

function compareStages(
  a: PipelineHandoffStage,
  b: PipelineHandoffStage
): number {
  const order = STAGE_ORDER[a.stage] - STAGE_ORDER[b.stage];
  if (order !== 0) return order;
  return a.addedAt.localeCompare(b.addedAt);
}

function compareEvidenceLatestFirst(
  a: WorkContextResumeGateEvidence,
  b: WorkContextResumeGateEvidence
): number {
  const captured = b.capturedAt.localeCompare(a.capturedAt);
  if (captured !== 0) return captured;
  const stage = STAGE_ORDER[b.stage] - STAGE_ORDER[a.stage];
  if (stage !== 0) return stage;
  return a.key.localeCompare(b.key);
}

function missingCurrentEvidence(
  tasks: TaskRef[],
  current: WorkContextResumeGateEvidence[]
): WorkContextResumeBlocker[] {
  const keys = new Set(
    current.map((item) => `${item.taskRef?.kind}:${item.taskRef?.id}`)
  );
  return tasks
    .filter((task) => task.kind === 'github-pr' || task.kind === 'github-issue')
    .filter((task) => !keys.has(`${task.kind}:${task.id}`))
    .map((task) => ({
      source: 'missing-current-evidence',
      summary: `No current WorkContext gate evidence for ${task.kind}:${task.id}.`,
      taskRef: { kind: task.kind, id: task.id },
    }));
}

function blockedStageEvidence(
  evidence: WorkContextResumeGateEvidence[]
): WorkContextResumeBlocker[] {
  const blockers: WorkContextResumeBlocker[] = [];
  for (const item of evidence) {
    if (BLOCKING_VERDICTS.has(item.status)) {
      blockers.push({
        source: 'stage-verdict',
        summary: `${item.stage} evidence is ${item.status}: ${item.summary}`,
        artifactId: item.artifactId,
        stage: item.stage,
        ...(item.taskRef
          ? { taskRef: { kind: item.taskRef.kind, id: item.taskRef.id } }
          : {}),
      });
    }
    for (const evidenceItem of item.acceptanceEvidence) {
      if (evidenceItem.disposition === 'skipped-blocked') {
        blockers.push({
          source: 'evidence',
          summary: `${item.stage} evidence blocked: ${evidenceItem.summary}`,
          artifactId: item.artifactId,
          stage: item.stage,
          ...(item.taskRef
            ? { taskRef: { kind: item.taskRef.kind, id: item.taskRef.id } }
            : {}),
        });
      }
    }
  }
  return blockers;
}

function unresolvedDecisionSummaries(
  evidence: WorkContextResumeGateEvidence[],
  publicSafe: boolean
): string[] {
  const summaries = evidence
    .filter((item) => UNRESOLVED_DECISIONS.has(item.status))
    .map((item) =>
      safeText(
        `${item.stage} decision ${item.status} in ${item.artifactId}: ${item.summary}`,
        publicSafe
      )
    );
  return boundedUniqueStrings(summaries, 20);
}

function suggestedNextAction(
  blockers: WorkContextResumeBlocker[],
  current: WorkContextResumeGateEvidence[],
  pinned: WorkContextResumeArtifactSummary[]
): WorkContextResumePacket['suggestedNextAction'] {
  if (blockers.length > 0) {
    return {
      kind: 'resolve-blockers',
      summary: blockers[0]?.summary ?? 'Resolve open blockers.',
    };
  }
  if (current.length === 0) {
    return {
      kind: 'produce-current-evidence',
      summary:
        'Publish current-head implementation, QA, review, or release evidence before relying on this WorkContext.',
    };
  }
  const release = current.find(
    (item) => item.stage === 'release' && APPROVAL_VERDICTS.has(item.status)
  );
  if (release)
    return {
      kind: 'continue',
      summary:
        'Latest release evidence is current; continue with the downstream WorkContext focus.',
    };
  const focus = current.flatMap((item) => item.downstreamFocus)[0];
  if (focus) return { kind: 'continue', summary: focus };
  if (pinned.length > 0)
    return {
      kind: 'inspect-pins',
      summary:
        'Inspect pinned artifact refs and continue from the latest current evidence.',
    };
  return {
    kind: 'continue',
    summary: 'Continue from the current WorkContext task refs.',
  };
}

function enforcePacketCharLimit(
  packet: WorkContextResumePacket,
  maxChars: number
): WorkContextResumePacket {
  const originalChars = JSON.stringify(packet).length;
  let current = withLimitState(packet, false, originalChars);
  let changed = false;
  let stringLimit = 1024;
  for (let iteration = 0; iteration < 10; iteration += 1) {
    const truncatedStrings = truncatePacketStrings(current, stringLimit);
    changed =
      changed || JSON.stringify(truncatedStrings) !== JSON.stringify(current);
    current = truncatedStrings;
    const approximateChars = JSON.stringify(current).length;
    if (approximateChars <= maxChars) {
      return withLimitState(current, changed, approximateChars);
    }
    current = reducePacket(current);
    changed = true;
    stringLimit = Math.max(64, Math.floor(stringLimit / 2));
  }
  const minimal = minimalPacket(packet);
  const minimalChars = JSON.stringify(minimal).length;
  if (minimalChars <= maxChars)
    return withLimitState(minimal, true, minimalChars);
  const absolute = truncatePacketStrings(minimal, 32);
  return withLimitState(absolute, true, JSON.stringify(absolute).length);
}

function withLimitState(
  packet: WorkContextResumePacket,
  truncated: boolean,
  approximateChars: number
): WorkContextResumePacket {
  return {
    ...packet,
    limits: {
      ...packet.limits,
      approximateChars,
      truncated: truncated || packet.limits.truncated,
    },
  };
}

function truncatePacketStrings(
  packet: WorkContextResumePacket,
  maxStringChars: number
): WorkContextResumePacket {
  return JSON.parse(
    JSON.stringify(packet, (_key, value: unknown) => {
      if (typeof value !== 'string' || value.length <= maxStringChars)
        return value;
      return `${value.slice(0, Math.max(0, maxStringChars - 1))}…`;
    })
  ) as WorkContextResumePacket;
}

function reducePacket(
  packet: WorkContextResumePacket
): WorkContextResumePacket {
  return {
    ...packet,
    goal: {
      ...packet.goal,
      summary: truncateString(packet.goal.summary, 240),
      taskRefs: packet.goal.taskRefs.slice(
        0,
        Math.max(1, Math.floor(packet.goal.taskRefs.length / 2))
      ),
    },
    nonGoals: packet.nonGoals.slice(
      0,
      Math.max(0, Math.floor(packet.nonGoals.length / 2))
    ),
    pinnedArtifacts: packet.pinnedArtifacts.slice(
      0,
      Math.max(0, Math.floor(packet.pinnedArtifacts.length / 2))
    ),
    artifacts: packet.artifacts.slice(
      0,
      Math.max(0, Math.floor(packet.artifacts.length / 2))
    ),
    evidence: {
      current: packet.evidence.current.slice(
        0,
        Math.max(0, Math.floor(packet.evidence.current.length / 2))
      ),
      historical: packet.evidence.historical.slice(
        0,
        Math.max(0, Math.floor(packet.evidence.historical.length / 2))
      ),
      missing: packet.evidence.missing.slice(
        0,
        Math.max(0, Math.floor(packet.evidence.missing.length / 2))
      ),
    },
    blockers: {
      open: packet.blockers.open.slice(
        0,
        Math.max(0, Math.floor(packet.blockers.open.length / 2))
      ),
      unresolvedDecisions: packet.blockers.unresolvedDecisions.slice(
        0,
        Math.max(0, Math.floor(packet.blockers.unresolvedDecisions.length / 2))
      ),
    },
    auditRefs: packet.auditRefs.slice(
      -Math.max(0, Math.floor(packet.auditRefs.length / 2))
    ),
    sessions: packet.sessions.slice(
      0,
      Math.max(0, Math.floor(packet.sessions.length / 2))
    ),
    suggestedNextAction: {
      ...packet.suggestedNextAction,
      summary: truncateString(packet.suggestedNextAction.summary, 240),
    },
    limits: { ...packet.limits, truncated: true },
  };
}

function minimalPacket(
  packet: WorkContextResumePacket
): WorkContextResumePacket {
  const workContext = sanitizeResumeWorkContext(packet.workContext);
  return {
    ...packet,
    workContext: { ...workContext, tasks: workContext.tasks.slice(0, 1) },
    goal: {
      summary: truncateString(packet.goal.summary, 160),
      taskRefs: [],
      status: packet.goal.status,
      source: packet.goal.source,
    },
    nonGoals: [],
    pinnedArtifacts: [],
    artifacts: [],
    evidence: { current: [], historical: [], missing: [] },
    blockers: { open: [], unresolvedDecisions: [] },
    auditRefs: [],
    sessions: [],
    suggestedNextAction: {
      kind: packet.suggestedNextAction.kind,
      summary: truncateString(packet.suggestedNextAction.summary, 160),
    },
    limits: { ...packet.limits, truncated: true },
  };
}

function stageStatus(stage: PipelineHandoffStage): string {
  if ('verdict' in stage) return stage.verdict;
  if ('decision' in stage) return stage.decision;
  return 'unknown';
}

function safeEvidence(
  item: PipelineHandoffEvidence,
  publicSafe: boolean
): PipelineHandoffEvidence {
  return {
    label: safeText(item.label, publicSafe),
    disposition: item.disposition,
    summary: safeText(item.summary, publicSafe),
    ...(item.reason ? { reason: safeText(item.reason, publicSafe) } : {}),
    ...(item.artifacts
      ? {
          artifacts: item.artifacts.map((artifact) => ({
            id: safeText(artifact.id, publicSafe),
            kind: artifact.kind,
            ...(artifact.title
              ? { title: safeText(artifact.title, publicSafe) }
              : {}),
            ...(artifact.uri
              ? {
                  uri: publicSafe
                    ? publicSafeArtifactUri(artifact.uri)
                    : artifact.uri,
                }
              : {}),
            ...(artifact.summary
              ? { summary: safeText(artifact.summary, publicSafe) }
              : {}),
            ...(artifact.hashSha256 ? { hashSha256: artifact.hashSha256 } : {}),
          })),
        }
      : {}),
  };
}

function sanitizeResumeWorkContext(
  workContext: WorkContextResumeSnapshot['workContext']
): WorkContextResumeSnapshot['workContext'] {
  return {
    id: '[redacted-work-context]',
    ...(workContext.title ? { title: safeText(workContext.title, true) } : {}),
    source: safeText(workContext.source, true),
    createdAt: workContext.createdAt,
    updatedAt: workContext.updatedAt,
    anchors: {},
    actors: [],
    tasks: workContext.tasks
      .filter(isPublicTaskRef)
      .map((task) => safeTaskRef(task, true)),
    relatedContextRefs: [],
  };
}

function sanitizeResumeSessions(
  sessions: WorkContextResumeSnapshot['sessions']
): WorkContextResumeSnapshot['sessions'] {
  return sessions.map((session) => ({
    id: '[redacted-session]',
    nodeId: '[redacted-node]',
    ...(session.globalSessionId
      ? { globalSessionId: '[redacted-session]' }
      : {}),
    tabKind: session.tabKind,
    ...(session.type ? { type: session.type } : {}),
    ...(session.mode ? { mode: session.mode } : {}),
    cwd: '[redacted-local-path]',
    ...(session.repoName ? { repoName: safeText(session.repoName, true) } : {}),
    ...(session.branchName
      ? { branchName: safeText(session.branchName, true) }
      : {}),
    ...(session.displayName
      ? { displayName: safeText(session.displayName, true) }
      : {}),
    ...(session.status ? { status: session.status } : {}),
    ...(session.activityState ? { activityState: session.activityState } : {}),
    ...(session.controlMode ? { controlMode: session.controlMode } : {}),
    ...(session.controlFreshness
      ? { controlFreshness: session.controlFreshness }
      : {}),
    ...(session.controlReason
      ? { controlReason: safeText(session.controlReason, true) }
      : {}),
    ...(session.lastActivity ? { lastActivity: session.lastActivity } : {}),
    relationship: safeText(session.relationship, true),
    associatedAt: session.associatedAt,
    live: session.live,
  }));
}

function safeAuditRef(ref: AuditEventRef): AuditEventRef {
  return {
    ...ref,
    id: safeText(ref.id, true),
    eventId: safeText(ref.eventId, true),
    ...(ref.type ? { type: safeText(ref.type, true) } : {}),
    ...(ref.actorId ? { actorId: '[redacted-actor]' } : {}),
    ...(ref.correlationId
      ? { correlationId: safeText(ref.correlationId, true) }
      : {}),
    ...(ref.logRef ? { logRef: '[redacted-private-log-ref]' } : {}),
  };
}

function safeNode(
  node: WorkContextResumeSnapshot['node']
): WorkContextResumeSnapshot['node'] {
  return {
    nodeId: '[redacted-node]',
    status: node.status,
    ...(node.displayName
      ? { displayName: safeText(node.displayName, true) }
      : {}),
    ...(node.kind ? { kind: node.kind } : {}),
  };
}

function safeTaskRef(task: TaskRef, publicSafe: boolean): TaskRef {
  if (publicSafe && !isPublicTaskRef(task))
    return { kind: 'external', id: '[redacted-private-task]' };
  return {
    kind: task.kind,
    id: safeText(task.id, publicSafe),
    ...(task.title ? { title: safeText(task.title, publicSafe) } : {}),
    ...(task.url ? { url: safeText(task.url, publicSafe) } : {}),
    ...(task.status ? { status: safeText(task.status, publicSafe) } : {}),
  };
}

function isPublicTaskRef(task: TaskRef): boolean {
  return task.kind === 'github-issue' || task.kind === 'github-pr';
}

function publicSafeArtifactUri(uri: string): string {
  if (!uri.startsWith('relay://work-context-artifacts/')) {
    return '[redacted-private-artifact-ref]';
  }
  const segment = safeText(lastUriSegment(uri), true);
  return `relay://work-context-artifacts/${encodeURIComponent(segment)}`;
}

function safeText(value: string | undefined, publicSafe: boolean): string {
  if (!value) return '';
  if (!publicSafe) return value;
  return value
    .replace(/\bt_[a-f0-9]{8,}\b/gi, '[redacted-kanban-task]')
    .replace(
      /(?:\/home\/|\/Users\/|\/tmp\/)[^\s)'",]+/g,
      '[redacted-local-path]'
    )
    .replace(
      /(?<![A-Za-z])(?:[A-Za-z]:[\\/]|\\\\[^\\/\s)'",]+[\\/][^\\/\s)'",]+[\\/])[^\s)'",]+/g,
      '[redacted-local-path]'
    )
    .replace(
      /(?:bearer\s+|sk-|relay-(?:sac|auth|grant|pair)-v1)[a-z0-9._~+/-]+=*/gi,
      '[redacted-secret]'
    );
}

function truncateString(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 1))}…`;
}

function isPublicPrivacy(value: WorkContextPrivacyClass): boolean {
  return value === 'public';
}

function isPublicArtifactRef(artifact: ArtifactRef): boolean {
  return isPublicPrivacy(artifact.privacy.classification);
}

function includeArtifactRefInResume(
  artifact: ArtifactRef,
  publicSafe: boolean
): boolean {
  return !publicSafe || isPublicArtifactRef(artifact);
}

function publicSafeDistinctions(publicSafe: boolean): string[] {
  if (publicSafe) {
    return [
      'Only GitHub issue/PR task refs and relay:// artifact refs are intended for public sharing.',
      'Local paths, Kanban task ids, secrets, logs, transcripts, and private artifact URIs are redacted or omitted.',
      'Pipeline payload summaries and stage evidence are deterministic metadata, not LLM summaries of raw history.',
    ];
  }
  return [
    'Private packet may include internal task refs, local path-shaped summaries, and private relay artifact refs.',
    'Raw logs, raw transcripts, provider auth, environment values, and raw DB history are still omitted.',
    'Stale-head evidence is retained as historical and never counted as current approval.',
  ];
}

function lastUriSegment(uri: string): string {
  const index = uri.lastIndexOf('/');
  const segment = index >= 0 ? uri.slice(index + 1) : uri;
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function boundedUniqueStrings(values: string[], max: number): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
    if (result.length >= max) break;
  }
  return result;
}

function boundedInt(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number
): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.trunc(value), min), max);
}
