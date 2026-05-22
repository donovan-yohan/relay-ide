import { createHash, randomUUID } from 'node:crypto';

import { Router, type RequestHandler } from 'express';

import {
  HANDOFF_SCHEMA_VERSION,
  isHandoffPlan,
  isHandoffRequest,
  type HandoffConflict,
  type HandoffPlan,
  type HandoffReasonCode,
  type HandoffRequest,
  type HandoffRequiredGrant,
  type HandoffRequiredGrantLeg,
  type HandoffRun,
  type HandoffRunTransition,
  type HandoffSnapshotGroup,
  type HandoffSourceDisposition,
} from '../shared/handoff.js';
import { proposeHandoffDestination } from '../shared/handoff-destination.js';
import {
  createWorkContextPrivacyMetadata,
  type ArtifactRef,
  type AuditEventRef,
} from '../shared/work-context.js';
import type { RelayCapabilityBit } from '../shared/security-policy.js';
import { planHandoffSnapshot, type HandoffPlannerDryRun } from './handoff-planner.js';
import {
  applyHandoffTransfer,
  type HandoffTransferApplyInput,
  type HandoffTransferApplyResult,
} from './handoff-transfer.js';
import type { WorkContextLifecycleEventInput, WorkContextStore } from './work-contexts.js';
import type { SessionSummary } from './types.js';

export const HANDOFF_PLAN_MAX_AGE_MS = 5 * 60 * 1000;
export const HANDOFF_STATUS_MAX_CONFLICTS = 25;

const SESSION_READ_CAPABILITY = 'session:read';

const REQUIRED_EXECUTE_GRANT_LEGS: readonly HandoffRequiredGrantLeg[] = [
  'source-read',
  'destination-write',
  'destination-session-create',
  'destination-exec',
];

export type HandoffApiErrorCode =
  | 'INVALID_REQUEST'
  | 'INVALID_PLAN_ID'
  | 'INVALID_WORK_CONTEXT_ID'
  | 'INVALID_SESSION_ID'
  | 'INVALID_RUN_STATE'
  | 'STALE_PLAN'
  | 'CAPABILITY_DENIED'
  | 'SOURCE_STALE_OR_OFFLINE'
  | 'HUB_UNAVAILABLE'
  | 'NODE_UNAVAILABLE'
  | 'DESTINATION_UNAVAILABLE'
  | 'LAUNCH_UNSUPPORTED'
  | 'LAUNCH_FAILED'
  | 'MISSING_CONFIRMED_GRANT'
  | 'HANDOFF_RUN_NOT_FOUND'
  | 'HANDOFF_ARTIFACT_NOT_FOUND'
  | 'HANDOFF_INTERNAL_ERROR';

export interface HandoffApiErrorBody {
  error: {
    code: HandoffApiErrorCode;
    message: string;
    retryable: boolean;
    reasonCode?: HandoffReasonCode;
    details?: Record<string, unknown>;
  };
}

export interface HandoffPlanInput {
  request: HandoffRequest;
  sourceRepoPath?: string;
  approvedUntrackedPaths?: readonly string[];
  dryRun?: HandoffPlannerDryRun;
  sourceBranchName?: string;
  now?: string;
}

export interface HandoffCreateInput {
  planId?: string;
  plan?: HandoffPlan;
  confirmedGrants?: readonly HandoffRequiredGrant[];
  sourceRepoPath?: string;
  destinationRepoPath?: string;
  approvedUntrackedPaths?: readonly string[];
  actorId?: string;
  now?: string;
}

export interface HandoffRunStatus {
  run: HandoffRun;
  progress: {
    state: HandoffRun['state'];
    terminal: boolean;
    transitions: number;
  };
  redaction: {
    rawSecretsAvailable: false;
    rawLogsAvailable: false;
    maxConflicts: typeof HANDOFF_STATUS_MAX_CONFLICTS;
  };
}

interface StoredPlan {
  plan: HandoffPlan;
  request: HandoffRequest;
  dryRun?: HandoffPlannerDryRun;
  createdAtMs: number;
  sourceRepoPath?: string;
  approvedUntrackedPaths?: readonly string[];
}

interface StoredRun {
  run: HandoffRun;
  auditEvents: unknown[];
  artifacts: HandoffArtifactSummary[];
}

export type HandoffCapabilityContext = readonly string[] | ReadonlySet<string>;

export type HandoffCapabilityProvider = (req: Parameters<RequestHandler>[0]) => HandoffCapabilityContext | null | undefined;

export interface HandoffArtifactSummary {
  id: string;
  runId?: string;
  planId?: string;
  group: HandoffSnapshotGroup | 'resume-bundle' | 'audit-summary';
  summary: string;
  refs: string[];
  byteCount?: number;
  sha256?: string;
  rawPayloadAvailable: false;
  transcriptExportAvailable: false;
}

export interface HandoffDestinationLaunchInput {
  plan: HandoffPlan;
  request: HandoffRequest;
  run: HandoffRun;
  artifacts: HandoffArtifactSummary[];
  handoffBrief: string;
}

export type HandoffDestinationLaunchResult =
  | { ok: true; session: SessionSummary; acknowledgedBrief: boolean }
  | {
      ok: false;
      code: 'HUB_UNAVAILABLE' | 'NODE_UNAVAILABLE' | 'LAUNCH_UNSUPPORTED' | 'LAUNCH_FAILED';
      message: string;
      details?: Record<string, unknown>;
    };

export interface HandoffServiceDeps {
  workContextStore?: Pick<
    WorkContextStore,
    'get' | 'associateSession' | 'recordLifecycleEvent' | 'update'
  >;
  getSession?: (nodeId: string, sessionId: string) => unknown | undefined;
  launchDestinationSession?: (
    input: HandoffDestinationLaunchInput
  ) => Promise<HandoffDestinationLaunchResult> | HandoffDestinationLaunchResult;
  applyTransfer?: (
    input: HandoffTransferApplyInput
  ) => Promise<HandoffTransferApplyResult>;
  now?: () => Date;
  createId?: () => string;
}

function nowIso(deps: HandoffServiceDeps): string {
  return (deps.now?.() ?? new Date()).toISOString();
}

function nowMs(deps: HandoffServiceDeps): number {
  return (deps.now?.() ?? new Date()).getTime();
}

function createId(deps: HandoffServiceDeps, prefix: string): string {
  return deps.createId?.() ?? `${prefix}-${randomUUID()}`;
}

function hashJson(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function apiError(
  code: HandoffApiErrorCode,
  message: string,
  status: number,
  details?: Record<string, unknown>,
  reasonCode?: HandoffReasonCode
): { status: number; body: HandoffApiErrorBody } {
  return {
    status,
    body: {
      error: {
        code,
        message,
        retryable:
          code === 'SOURCE_STALE_OR_OFFLINE' ||
          code === 'DESTINATION_UNAVAILABLE' ||
          code === 'NODE_UNAVAILABLE' ||
          code === 'HUB_UNAVAILABLE' ||
          code === 'LAUNCH_FAILED' ||
          code === 'STALE_PLAN',
        ...(reasonCode ? { reasonCode } : {}),
        ...(details ? { details } : {}),
      },
    },
  };
}

function conflict(
  code: HandoffConflict['code'],
  message: string,
  nodeId: string,
  reasonCode: HandoffReasonCode
): HandoffConflict {
  return { code, message, nodeId, reasonCode };
}

function sanitizeRun(run: HandoffRun): HandoffRun {
  return {
    ...run,
    conflicts: run.conflicts.slice(0, HANDOFF_STATUS_MAX_CONFLICTS),
    transitions: run.transitions.slice(-HANDOFF_STATUS_MAX_CONFLICTS),
  };
}

function mergeSourceDispositions(
  current: readonly HandoffSourceDisposition[],
  next: readonly HandoffSourceDisposition[]
): HandoffSourceDisposition[] {
  return Array.from(new Set([...current, ...next]));
}

function transition(
  run: HandoffRun,
  to: HandoffRun['state'],
  reasonCode: HandoffReasonCode,
  at: string,
  actorId?: string
): HandoffRunTransition {
  const item: HandoffRunTransition = {
    from: run.state,
    to,
    at,
    reasonCode,
    ...(actorId ? { actorId } : {}),
  };
  run.transitions = [...run.transitions, item];
  run.state = to;
  run.reasonCode = reasonCode;
  run.updatedAt = at;
  if (to === 'complete' || to === 'failed' || to === 'cancelled') {
    run.completedAt = at;
  } else {
    delete run.completedAt;
  }
  return item;
}

function openRunCopy(
  run: HandoffRun,
  patchInput: Omit<Partial<HandoffRun>, 'completedAt'> = {}
): HandoffRun {
  const copy: HandoffRun = {
    schemaVersion: run.schemaVersion,
    id: run.id,
    requestId: run.requestId,
    ...(run.planId ? { planId: run.planId } : {}),
    ...(run.snapshotId ? { snapshotId: run.snapshotId } : {}),
    state: run.state,
    sourceDisposition: run.sourceDisposition,
    ...(run.sourceDispositions ? { sourceDispositions: run.sourceDispositions } : {}),
    ...(run.reasonCode ? { reasonCode: run.reasonCode } : {}),
    conflicts: run.conflicts,
    transitions: run.transitions,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
  };
  return { ...copy, ...patchInput };
}

function rewindApplyComplete(run: HandoffRun): HandoffRun {
  const transitions = run.transitions.slice();
  const last = transitions.at(-1);
  if (
    run.state === 'complete' &&
    last?.from === 'applying' &&
    last.to === 'complete' &&
    last.reasonCode === 'APPLY_COMPLETED'
  ) {
    transitions.pop();
    return openRunCopy(run, {
      state: 'applying',
      reasonCode: 'APPLY_COMPLETED',
      transitions,
      updatedAt: transitions.at(-1)?.at ?? run.updatedAt,
    });
  }
  return run;
}

function sourceDispositionsForAppliedRun(
  plan: HandoffPlan,
  run: HandoffRun
): HandoffSourceDisposition[] {
  return mergeSourceDispositions(
    run.sourceDispositions ?? [run.sourceDisposition],
    [plan.source.disposition]
  );
}

function sourceDispositionsForLaunch(
  plan: HandoffPlan,
  run: HandoffRun
): HandoffSourceDisposition[] {
  return mergeSourceDispositions(
    sourceDispositionsForAppliedRun(plan, run),
    ['handed-off']
  );
}

function rewindLaunchAttempt(run: HandoffRun): HandoffRun {
  const launchIndex = run.transitions.findLastIndex(
    (entry) => entry.to === 'launching'
  );
  if (launchIndex < 0) return run;
  const transitions = run.transitions.slice(0, launchIndex);
  const sourceDispositions = (run.sourceDispositions ?? [run.sourceDisposition]).filter(
    (entry) => entry !== 'handoff-failed'
  );
  return openRunCopy(run, {
    state: 'applying',
    reasonCode: transitions.at(-1)?.reasonCode ?? 'APPLY_COMPLETED',
    conflicts: run.conflicts.filter((entry) => entry.code !== 'LAUNCH_FAILURE'),
    transitions,
    sourceDisposition: sourceDispositions[0] ?? 'left-running',
    sourceDispositions: sourceDispositions.length ? sourceDispositions : ['left-running'],
    updatedAt: transitions.at(-1)?.at ?? run.updatedAt,
  });
}

function buildHandoffBrief(input: {
  plan: HandoffPlan;
  run: HandoffRun;
  artifacts: HandoffArtifactSummary[];
}): string {
  const { plan, run, artifacts } = input;
  const artifactRefs = artifacts.map((artifact) => artifact.id).join(', ') || 'none';
  return [
    `Relay cold handoff ${run.id} is applied for WorkContext ${plan.route.workContextId}.`,
    `Destination cwd: ${plan.destinationProposal.cwd}. Source session: ${plan.source.nodeId}/${plan.source.sessionId}.`,
    `Source disposition is not process migration: ${(run.sourceDispositions ?? [run.sourceDisposition]).join(', ')}.`,
    `Artifact refs: ${artifactRefs}. Raw transcripts, provider auth, env/secrets, Hermes DBs, and broad home-folder mirrors are intentionally unavailable.`,
    'Before editing: inspect git status and the handoff artifact refs, then continue from this bounded brief only.',
  ].join('\n');
}

function artifactRefsForWorkContext(
  artifacts: readonly HandoffArtifactSummary[],
  producedAt: string,
  actorId?: string
): ArtifactRef[] {
  const privacy = createWorkContextPrivacyMetadata({ classification: 'internal' });
  return artifacts.map((artifact) => ({
    id: artifact.id,
    kind: artifact.group === 'resume-bundle' ? 'report' : 'log-ref',
    title: artifact.group,
    summary: artifact.summary,
    uri: artifact.id,
    ...(actorId ? { producedByActorId: actorId } : {}),
    producedAt,
    privacy,
  }));
}

function handoffStateArtifactRefsForWorkContext(input: {
  plan: HandoffPlan;
  run: HandoffRun;
  producedAt: string;
  actorId?: string;
}): ArtifactRef[] {
  const privacy = createWorkContextPrivacyMetadata({ classification: 'internal' });
  const refs: ArtifactRef[] = [
    {
      id: `handoff-run:${input.run.id}`,
      kind: 'report',
      title: 'HandoffRun',
      summary: `HandoffRun ${input.run.id} ${input.run.state}/${input.run.reasonCode ?? 'unknown'} for plan ${input.plan.id}`,
      uri: `handoff-run:${input.run.id}`,
      ...(input.actorId ? { producedByActorId: input.actorId } : {}),
      producedAt: input.producedAt,
      privacy,
    },
  ];
  if (input.run.snapshotId) {
    refs.push({
      id: `handoff-snapshot:${input.run.snapshotId}`,
      kind: 'report',
      title: 'HandoffSnapshot',
      summary: `Applied handoff snapshot ${input.run.snapshotId} for run ${input.run.id}`,
      uri: `handoff-snapshot:${input.run.snapshotId}`,
      ...(input.actorId ? { producedByActorId: input.actorId } : {}),
      producedAt: input.producedAt,
      privacy,
    });
  }
  return refs;
}

function auditRefsForWorkContext(
  run: HandoffRun,
  actorId?: string
): AuditEventRef[] {
  const privacy = createWorkContextPrivacyMetadata({ classification: 'internal' });
  return run.transitions.map((entry, idx) => ({
    id: `handoff-audit:${run.id}:${idx}`,
    eventId: `${run.id}:${idx}`,
    type: 'handoff-run-transition',
    occurredAt: entry.at,
    ...(actorId ? { actorId } : {}),
    correlationId: run.id,
    privacy,
  }));
}

function dedupeById<T extends { id: string }>(items: readonly T[]): T[] {
  const byId = new Map<string, T>();
  for (const item of items) byId.set(item.id, item);
  return Array.from(byId.values());
}

function hasRequiredExecuteGrantLegs(grants: readonly HandoffRequiredGrant[]): boolean {
  const allowed = new Set(grants.filter((grant) => grant.decision === 'allow').map((grant) => grant.leg));
  return REQUIRED_EXECUTE_GRANT_LEGS.every((leg) => allowed.has(leg));
}

function scopesMatch(a: HandoffRequiredGrant['scope'], b: HandoffRequiredGrant['scope']): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

function confirmedGrantEnvelopeConflicts(
  plan: HandoffPlan,
  confirmedGrants: readonly HandoffRequiredGrant[] | undefined
): HandoffConflict[] {
  if (!confirmedGrants || confirmedGrants.length === 0) return [];
  const plannedByLeg = new Map(plan.requiredGrants.map((grant) => [grant.leg, grant]));
  const conflicts: HandoffConflict[] = [];
  for (const confirmed of confirmedGrants) {
    const planned = plannedByLeg.get(confirmed.leg);
    if (!planned) {
      conflicts.push(conflict('MISSING_CAPABILITY_GRANT', `confirmed grant leg ${confirmed.leg} is not in the planned grant set`, plan.route.destinationNodeId, 'FAILED_MISSING_GRANT'));
      continue;
    }
    if (
      confirmed.nodeId !== planned.nodeId ||
      confirmed.capability !== planned.capability ||
      (confirmed.scope !== undefined && !scopesMatch(confirmed.scope, planned.scope))
    ) {
      conflicts.push(conflict('MISSING_CAPABILITY_GRANT', `confirmed grant ${confirmed.leg} does not match the planned node/capability/scope envelope`, planned.nodeId, 'FAILED_MISSING_GRANT'));
    }
  }
  return conflicts;
}

function missingConfirmedGrantConflicts(plan: HandoffPlan): HandoffConflict[] {
  const allowed = new Set(
    plan.requiredGrants
      .filter((grant) => grant.decision === 'allow')
      .map((grant) => grant.leg)
  );
  return REQUIRED_EXECUTE_GRANT_LEGS
    .filter((leg) => !allowed.has(leg))
    .map((leg) => {
      const planned = plan.requiredGrants.find((grant) => grant.leg === leg);
      return conflict(
        'MISSING_CAPABILITY_GRANT',
        `handoff execute requires confirmed ${leg} grant`,
        planned?.nodeId ?? plan.route.destinationNodeId,
        'FAILED_MISSING_GRANT'
      );
    });
}

function defaultRequiredGrants(request: HandoffRequest): HandoffRequiredGrant[] {
  const sessionCreateCapability: RelayCapabilityBit =
    request.desiredRuntime.kind === 'terminal'
      ? 'session:create:terminal'
      : 'session:create:agent';
  return [
    {
      leg: 'source-read',
      nodeId: request.source.nodeId,
      capability: 'rpc:fs:read',
      scope: { kind: 'path', pathPrefixes: [request.source.cwd] },
    },
    {
      leg: 'destination-write',
      nodeId: request.destination.nodeId,
      capability: 'rpc:fs:write',
      scope: { kind: 'path', pathPrefixes: [request.destination.cwd] },
    },
    {
      leg: 'destination-session-create',
      nodeId: request.destination.nodeId,
      capability: sessionCreateCapability,
      scope: { kind: 'node' },
    },
    {
      leg: 'destination-exec',
      nodeId: request.destination.nodeId,
      capability: 'pty:exec:arbitrary',
      scope: { kind: 'node' },
    },
  ];
}

function applyConfirmedGrants(
  plan: HandoffPlan,
  confirmedGrants: readonly HandoffRequiredGrant[] | undefined
): HandoffPlan {
  if (!confirmedGrants || confirmedGrants.length === 0) return plan;
  const byLeg = new Map(confirmedGrants.map((grant) => [grant.leg, grant]));
  return {
    ...plan,
    requiredGrants: plan.requiredGrants.map((plannedGrant) => {
      const confirmed = byLeg.get(plannedGrant.leg);
      if (!confirmed) return plannedGrant;
      return {
        ...plannedGrant,
        ...(confirmed.decision !== undefined ? { decision: confirmed.decision } : {}),
        ...(confirmed.grantRef !== undefined ? { grantRef: confirmed.grantRef } : {}),
      };
    }),
  };
}

function validateTransferPathBindings(
  plan: HandoffPlan,
  stored: StoredPlan | undefined,
  input: Pick<HandoffCreateInput, 'sourceRepoPath' | 'destinationRepoPath'>
): ReturnType<typeof apiError> | null {
  if (!stored) return null;
  if (input.sourceRepoPath && stored.sourceRepoPath && input.sourceRepoPath !== stored.sourceRepoPath) {
    return apiError('INVALID_REQUEST', 'handoff execute sourceRepoPath does not match the stored plan source path', 400, {
      planId: plan.id,
      field: 'sourceRepoPath',
    });
  }
  const expectedDestinationRepoPath = plan.destinationProposal.cwd || stored.request.destination.cwd;
  if (input.destinationRepoPath && input.destinationRepoPath !== expectedDestinationRepoPath) {
    return apiError('INVALID_REQUEST', 'handoff execute destinationRepoPath does not match the planned destination path', 400, {
      planId: plan.id,
      field: 'destinationRepoPath',
    });
  }
  return null;
}

function dryRunConflictReason(conflicts: readonly HandoffConflict[]): HandoffApiErrorCode | null {
  if (conflicts.some((entry) => entry.code === 'STALE_SOURCE')) return 'SOURCE_STALE_OR_OFFLINE';
  if (conflicts.some((entry) => entry.code === 'DESTINATION_UNAVAILABLE')) return 'DESTINATION_UNAVAILABLE';
  return null;
}

async function dryRunForPlan(input: HandoffPlanInput): Promise<HandoffPlannerDryRun | undefined> {
  if (input.dryRun) return input.dryRun;
  if (!input.sourceRepoPath) return undefined;
  return planHandoffSnapshot({
    repoPath: input.sourceRepoPath,
    nodeId: input.request.source.nodeId,
    ...(input.approvedUntrackedPaths ? { approvedUntrackedPaths: input.approvedUntrackedPaths } : {}),
  });
}

function buildPlan(input: {
  id: string;
  request: HandoffRequest;
  dryRun?: HandoffPlannerDryRun;
  createdAt: string;
  sourceBranchName?: string;
}): HandoffPlan {
  const branchName = input.sourceBranchName ?? input.dryRun?.branchName ?? undefined;
  const destinationProposal = branchName
    ? proposeHandoffDestination({
        source: input.request.source,
        destination: input.request.destination.option,
        sourceBranchName: branchName,
      })
    : proposeHandoffDestination({
        source: input.request.source,
        destination: input.request.destination.option,
      });
  const includedGroups = input.dryRun?.includedGroups ?? ['source-summary'];
  const excludedGroups = input.dryRun?.excludedGroups ?? [];
  const conflicts = input.dryRun?.conflicts ?? [];
  return {
    schemaVersion: HANDOFF_SCHEMA_VERSION,
    id: input.id,
    requestId: input.request.id,
    createdAt: input.createdAt,
    source: input.request.source,
    route: {
      sourceNodeId: input.request.source.nodeId,
      destinationNodeId: input.request.destination.nodeId,
      workContextId: input.request.source.workContextId,
    },
    transferMode: input.dryRun?.transferMode ?? 'metadata-only',
    includedGroups,
    excludedGroups,
    fileCount: input.dryRun?.fileCount ?? 0,
    byteCount: input.dryRun?.byteCount ?? 0,
    destinationProposal,
    pathMappings: [],
    conflicts,
    requiredGrants: defaultRequiredGrants(input.request),
    launchPreview: {
      nodeId: input.request.destination.nodeId,
      cwd: input.request.destination.cwd,
      runtime: input.request.desiredRuntime,
      summary: 'create a destination session only after the cold handoff snapshot applies',
      workContextId: input.request.source.workContextId,
    },
  };
}

export class HandoffService {
  private readonly plans = new Map<string, StoredPlan>();
  private readonly runs = new Map<string, StoredRun>();

  constructor(private readonly deps: HandoffServiceDeps = {}) {}

  async plan(input: HandoffPlanInput): Promise<{ ok: true; plan: HandoffPlan; dryRun?: HandoffPlannerDryRun } | { ok: false; error: ReturnType<typeof apiError> }> {
    if (!isHandoffRequest(input.request)) {
      return { ok: false, error: apiError('INVALID_REQUEST', 'handoff request does not match shared schema', 400) };
    }
    if (this.deps.workContextStore && !this.deps.workContextStore.get(input.request.source.workContextId)) {
      return {
        ok: false,
        error: apiError('INVALID_WORK_CONTEXT_ID', 'source WorkContext was not found', 404, {
          workContextId: input.request.source.workContextId,
        }),
      };
    }
    if (this.deps.getSession && !this.deps.getSession(input.request.source.nodeId, input.request.source.sessionId)) {
      return {
        ok: false,
        error: apiError('INVALID_SESSION_ID', 'source session was not found', 404, {
          nodeId: input.request.source.nodeId,
          sessionId: input.request.source.sessionId,
        }),
      };
    }
    const dryRun = await dryRunForPlan(input);
    const dryRunConflicts = dryRun?.conflicts ?? [];
    const dryRunReason = dryRunConflicts.length > 0 ? dryRunConflictReason(dryRunConflicts) : null;
    if (dryRunReason !== null) {
      return {
        ok: false,
        error: apiError(dryRunReason, 'source or destination is not ready for handoff planning', dryRunReason === 'SOURCE_STALE_OR_OFFLINE' ? 409 : 503, {
          conflicts: dryRunConflicts.slice(0, HANDOFF_STATUS_MAX_CONFLICTS),
        }, dryRunConflicts[0]?.reasonCode),
      };
    }
    const createdAt = input.now ?? nowIso(this.deps);
    const planInput: {
      id: string;
      request: HandoffRequest;
      dryRun?: HandoffPlannerDryRun;
      createdAt: string;
      sourceBranchName?: string;
    } = {
      id: createId(this.deps, 'handoff-plan'),
      request: input.request,
      createdAt,
    };
    if (dryRun) planInput.dryRun = dryRun;
    if (input.sourceBranchName) planInput.sourceBranchName = input.sourceBranchName;
    const plan = buildPlan(planInput);
    if (!isHandoffPlan(plan)) {
      return { ok: false, error: apiError('HANDOFF_INTERNAL_ERROR', 'constructed handoff plan failed shared schema validation', 500) };
    }
    this.plans.set(plan.id, {
      plan,
      request: input.request,
      ...(dryRun ? { dryRun } : {}),
      createdAtMs: Date.parse(createdAt),
      ...(input.sourceRepoPath ? { sourceRepoPath: input.sourceRepoPath } : {}),
      ...(input.approvedUntrackedPaths ? { approvedUntrackedPaths: input.approvedUntrackedPaths } : {}),
    });
    return { ok: true, plan, ...(dryRun ? { dryRun } : {}) };
  }

  async create(input: HandoffCreateInput): Promise<{ ok: true; run: HandoffRun; artifacts: HandoffArtifactSummary[] } | { ok: false; error: ReturnType<typeof apiError>; run?: HandoffRun }> {
    const stored = input.planId ? this.plans.get(input.planId) : undefined;
    const rawPlan = input.plan ?? stored?.plan;
    if (!rawPlan || !isHandoffPlan(rawPlan)) {
      return { ok: false, error: apiError('INVALID_PLAN_ID', 'handoff plan was not found or failed schema validation', 404, { planId: input.planId }) };
    }
    if (stored) {
      const ageMs = nowMs(this.deps) - stored.createdAtMs;
      if (ageMs > HANDOFF_PLAN_MAX_AGE_MS) {
        return {
          ok: false,
          error: apiError('STALE_PLAN', 'handoff plan is stale; refresh plan before execute', 409, {
            planId: rawPlan.id,
            maxAgeMs: HANDOFF_PLAN_MAX_AGE_MS,
            ageMs,
          }),
        };
      }
    }
    const envelopeConflicts = confirmedGrantEnvelopeConflicts(rawPlan, input.confirmedGrants);
    if (envelopeConflicts.length > 0) {
      const run = this.createFailedRun(rawPlan, envelopeConflicts, 'FAILED_MISSING_GRANT', input.actorId, input.now);
      return {
        ok: false,
        error: apiError('CAPABILITY_DENIED', 'confirmed handoff grants must match the immutable planned grant envelope', 403, {
          planId: rawPlan.id,
          conflicts: envelopeConflicts.slice(0, HANDOFF_STATUS_MAX_CONFLICTS),
        }, 'FAILED_MISSING_GRANT'),
        run,
      };
    }

    const plan = applyConfirmedGrants(rawPlan, input.confirmedGrants);
    const grantConflicts = missingConfirmedGrantConflicts(plan);
    if (!hasRequiredExecuteGrantLegs(plan.requiredGrants)) {
      const run = this.createFailedRun(plan, grantConflicts, 'FAILED_MISSING_GRANT', input.actorId, input.now);
      return {
        ok: false,
        error: apiError('MISSING_CONFIRMED_GRANT', 'handoff execute requires confirmed source-read, destination-write, destination-session-create, and destination-exec grants', 403, {
          planId: plan.id,
          missingGrantLegs: grantConflicts.map((entry) => entry.message),
        }, 'FAILED_MISSING_GRANT'),
        run,
      };
    }

    const pathBindingError = validateTransferPathBindings(plan, stored, input);
    if (pathBindingError) return { ok: false, error: pathBindingError };

    if (input.sourceRepoPath && input.destinationRepoPath && stored?.dryRun?.baseCommit) {
      const transferInput: HandoffTransferApplyInput = {
        requestId: plan.requestId,
        planId: plan.id,
        sourceRepoPath: input.sourceRepoPath,
        destinationRepoPath: input.destinationRepoPath,
        sourceNodeId: plan.route.sourceNodeId,
        destinationNodeId: plan.route.destinationNodeId,
        baseCommit: stored.dryRun.baseCommit,
        requiredGrants: plan.requiredGrants,
        expectedDryRun: stored.dryRun,
      };
      if (stored.dryRun.branchName) transferInput.branchName = stored.dryRun.branchName;
      if (input.actorId) transferInput.actorId = input.actorId;
      const approvedUntrackedPaths = input.approvedUntrackedPaths ?? stored.approvedUntrackedPaths;
      if (approvedUntrackedPaths) transferInput.approvedUntrackedPaths = approvedUntrackedPaths;
      const result = await (this.deps.applyTransfer ?? applyHandoffTransfer)(transferInput);
      const artifacts = this.artifactsForRun(result.run.id, plan.id, result.auditEvents);
      if (result.ok) {
        const launched = await this.launchAppliedRun({
          plan,
          request: stored.request,
          run: result.run,
          artifacts,
          ...(input.actorId ? { actorId: input.actorId } : {}),
        });
        this.runs.set(launched.run.id, {
          run: sanitizeRun(launched.run),
          auditEvents: [...result.auditEvents, ...launched.auditEvents],
          artifacts: launched.artifacts,
        });
        if (launched.ok) {
          return {
            ok: true,
            run: sanitizeRun(launched.run),
            artifacts: launched.artifacts,
          };
        }
        return {
          ok: false,
          error: launched.error,
          run: sanitizeRun(launched.run),
        };
      }
      this.runs.set(result.run.id, { run: sanitizeRun(result.run), auditEvents: result.auditEvents, artifacts });
      return {
        ok: false,
        error: apiError('SOURCE_STALE_OR_OFFLINE', 'handoff transfer/apply failed with typed conflicts', 409, {
          runId: result.run.id,
          conflicts: result.conflicts.slice(0, HANDOFF_STATUS_MAX_CONFLICTS),
        }, result.run.reasonCode),
        run: sanitizeRun(result.run),
      };
    }

    const run = this.createFailedRun(
      plan,
      [
        conflict(
          'DESTINATION_UNAVAILABLE',
          'handoff execute requires sourceRepoPath and destinationRepoPath for the transfer engine; refusing fake success',
          plan.route.destinationNodeId,
          'FAILED_DESTINATION_UNAVAILABLE'
        ),
      ],
      'FAILED_DESTINATION_UNAVAILABLE',
      input.actorId,
      input.now
    );
    return {
      ok: false,
      error: apiError('DESTINATION_UNAVAILABLE', 'transfer/apply engine was not invoked; no fake execute success emitted', 503, { runId: run.id }, 'FAILED_DESTINATION_UNAVAILABLE'),
      run,
    };
  }

  private async launchAppliedRun(input: {
    plan: HandoffPlan;
    request: HandoffRequest;
    run: HandoffRun;
    artifacts: HandoffArtifactSummary[];
    actorId?: string;
  }): Promise<
    | { ok: true; run: HandoffRun; artifacts: HandoffArtifactSummary[]; auditEvents: unknown[] }
    | {
        ok: false;
        run: HandoffRun;
        artifacts: HandoffArtifactSummary[];
        auditEvents: unknown[];
        error: ReturnType<typeof apiError>;
      }
  > {
    const launcher = this.deps.launchDestinationSession;
    const baseRun = rewindApplyComplete(input.run);
    baseRun.sourceDisposition = input.plan.source.disposition;
    baseRun.sourceDispositions = sourceDispositionsForAppliedRun(input.plan, baseRun);
    const startedAt = nowIso(this.deps);
    transition(baseRun, 'launching', 'LAUNCH_STARTED', startedAt, input.actorId);
    const handoffBrief = buildHandoffBrief({
      plan: input.plan,
      run: baseRun,
      artifacts: input.artifacts,
    });

    if (!launcher) {
      const failed = this.failLaunchRun(baseRun, {
        code: 'LAUNCH_UNSUPPORTED',
        message: 'destination launch is not wired for this hub; applied artifacts are preserved for retry',
        details: { runId: baseRun.id, planId: input.plan.id },
      }, input.actorId);
      return {
        ok: false,
        run: failed.run,
        artifacts: input.artifacts,
        auditEvents: failed.auditEvents,
        error: apiError('LAUNCH_UNSUPPORTED', failed.message, 501, failed.details, 'FAILED_LAUNCH'),
      };
    }

    const launch = await launcher({
      plan: input.plan,
      request: input.request,
      run: baseRun,
      artifacts: input.artifacts,
      handoffBrief,
    });
    if (!launch.ok) {
      const failed = this.failLaunchRun(baseRun, launch, input.actorId);
      this.recordWorkContextLaunchFailure({
        plan: input.plan,
        run: failed.run,
        artifacts: input.artifacts,
        launch,
        ...(input.actorId ? { actorId: input.actorId } : {}),
        at: failed.run.completedAt ?? failed.run.updatedAt,
      });
      const status =
        launch.code === 'NODE_UNAVAILABLE' ? 404 :
        launch.code === 'HUB_UNAVAILABLE' ? 503 :
        launch.code === 'LAUNCH_UNSUPPORTED' ? 501 : 500;
      return {
        ok: false,
        run: failed.run,
        artifacts: input.artifacts,
        auditEvents: failed.auditEvents,
        error: apiError(launch.code, launch.message, status, launch.details, 'FAILED_LAUNCH'),
      };
    }

    if (!launch.acknowledgedBrief) {
      const failed = this.failLaunchRun(baseRun, {
        code: 'LAUNCH_FAILED',
        message: 'destination session launched but did not acknowledge the bounded handoff brief',
        details: {
          runId: baseRun.id,
          planId: input.plan.id,
          sessionId: launch.session.id,
          nodeId: launch.session.nodeId ?? input.plan.route.destinationNodeId,
        },
      }, input.actorId);
      this.recordWorkContextLaunchFailure({
        plan: input.plan,
        run: failed.run,
        artifacts: input.artifacts,
        launch: {
          code: 'LAUNCH_FAILED',
          message: failed.message,
        },
        ...(input.actorId ? { actorId: input.actorId } : {}),
        at: failed.run.completedAt ?? failed.run.updatedAt,
      });
      return {
        ok: false,
        run: failed.run,
        artifacts: input.artifacts,
        auditEvents: failed.auditEvents,
        error: apiError('LAUNCH_FAILED', failed.message, 500, failed.details, 'FAILED_LAUNCH'),
      };
    }

    const verifyingAt = nowIso(this.deps);
    transition(baseRun, 'verifying', 'LAUNCH_COMPLETED', verifyingAt, input.actorId);
    const completedAt = nowIso(this.deps);
    transition(baseRun, 'complete', 'VERIFY_COMPLETED', completedAt, input.actorId);
    baseRun.sourceDisposition = 'handed-off';
    baseRun.sourceDispositions = sourceDispositionsForLaunch(input.plan, input.run);
    this.recordWorkContextLaunch({
      plan: input.plan,
      run: baseRun,
      session: launch.session,
      artifacts: input.artifacts,
      ...(input.actorId ? { actorId: input.actorId } : {}),
      at: completedAt,
    });
    return {
      ok: true,
      run: baseRun,
      artifacts: input.artifacts,
      auditEvents: [],
    };
  }

  private failLaunchRun(
    run: HandoffRun,
    launch: {
      code: 'HUB_UNAVAILABLE' | 'NODE_UNAVAILABLE' | 'LAUNCH_UNSUPPORTED' | 'LAUNCH_FAILED';
      message: string;
      details?: Record<string, unknown>;
    },
    actorId?: string
  ): {
    run: HandoffRun;
    auditEvents: unknown[];
    message: string;
    details?: Record<string, unknown>;
  } {
    const conflictEntry = conflict(
      'LAUNCH_FAILURE',
      launch.message,
      run.planId ?? 'hub',
      'FAILED_LAUNCH'
    );
    run.sourceDispositions = mergeSourceDispositions(
      run.sourceDispositions ?? [run.sourceDisposition],
      ['handoff-failed']
    );
    run.conflicts = [...run.conflicts, conflictEntry];
    run.sourceDisposition = 'handoff-failed';
    const failedAt = nowIso(this.deps);
    transition(run, 'failed', 'FAILED_LAUNCH', failedAt, actorId);
    return {
      run,
      auditEvents: [
        {
          id: createId(this.deps, 'handoff-launch-event'),
          runId: run.id,
          at: failedAt,
          phase: 'failed',
          type: 'handoff-launch-failed',
          reasonCode: 'FAILED_LAUNCH',
          code: launch.code,
          message: launch.message,
        },
      ],
      message: launch.message,
      ...(launch.details ? { details: launch.details } : {}),
    };
  }

  private recordWorkContextLaunchFailure(input: {
    plan: HandoffPlan;
    run: HandoffRun;
    artifacts: HandoffArtifactSummary[];
    launch: {
      code: 'HUB_UNAVAILABLE' | 'NODE_UNAVAILABLE' | 'LAUNCH_UNSUPPORTED' | 'LAUNCH_FAILED';
      message: string;
    };
    actorId?: string;
    at: string;
  }): void {
    const store = this.deps.workContextStore;
    if (!store) return;
    const existing = store.get(input.plan.route.workContextId);
    if (!existing) return;
    const artifactRefs = [
      ...artifactRefsForWorkContext(
        input.artifacts,
        input.at,
        input.actorId
      ),
      ...handoffStateArtifactRefsForWorkContext({
        plan: input.plan,
        run: input.run,
        producedAt: input.at,
        ...(input.actorId ? { actorId: input.actorId } : {}),
      }),
    ];
    const auditRefs = auditRefsForWorkContext(input.run, input.actorId);
    store.update(input.plan.route.workContextId, {
      artifacts: dedupeById([...existing.artifacts, ...artifactRefs]),
      auditRefs: dedupeById([...existing.auditRefs, ...auditRefs]),
    });
    const lifecycleEvent: WorkContextLifecycleEventInput = {
      type: 'handoff.closed',
      occurredAt: input.at,
      correlationId: input.run.id,
      artifacts: artifactRefs,
      summary: `Destination session launch failed for cold handoff ${input.run.id}: ${input.launch.code}; retry launch is available without rerunning transfer. Source state: ${(input.run.sourceDispositions ?? [input.run.sourceDisposition]).join(', ')}`,
    };
    if (input.actorId) lifecycleEvent.actorId = input.actorId;
    store.recordLifecycleEvent(input.plan.route.workContextId, lifecycleEvent);
  }

  private recordWorkContextLaunch(input: {
    plan: HandoffPlan;
    run: HandoffRun;
    session: SessionSummary;
    artifacts: HandoffArtifactSummary[];
    actorId?: string;
    at: string;
  }): void {
    const store = this.deps.workContextStore;
    if (!store) return;
    const existing = store.get(input.plan.route.workContextId);
    if (!existing) return;
    const artifactRefs = [
      ...artifactRefsForWorkContext(
        input.artifacts,
        input.at,
        input.actorId
      ),
      ...handoffStateArtifactRefsForWorkContext({
        plan: input.plan,
        run: input.run,
        producedAt: input.at,
        ...(input.actorId ? { actorId: input.actorId } : {}),
      }),
    ];
    const auditRefs = auditRefsForWorkContext(input.run, input.actorId);
    store.update(input.plan.route.workContextId, {
      artifacts: dedupeById([...existing.artifacts, ...artifactRefs]),
      auditRefs: dedupeById([...existing.auditRefs, ...auditRefs]),
    });
    store.associateSession(input.plan.route.workContextId, {
      session: input.session,
      relationship: 'handoff-destination',
    });
    const lifecycleEvent: WorkContextLifecycleEventInput = {
      type: 'session.started',
      occurredAt: input.at,
      correlationId: input.run.id,
      artifacts: artifactRefs,
      summary: `Started destination session ${input.session.nodeId ?? input.plan.route.destinationNodeId}/${input.session.id} for cold handoff ${input.run.id}; source state: ${(input.run.sourceDispositions ?? [input.run.sourceDisposition]).join(', ')}`,
    };
    if (input.actorId) lifecycleEvent.actorId = input.actorId;
    store.recordLifecycleEvent(input.plan.route.workContextId, lifecycleEvent);
  }

  getStatus(runId: string): HandoffRunStatus | null {
    const stored = this.runs.get(runId);
    if (!stored) return null;
    const run = sanitizeRun(stored.run);
    return {
      run,
      progress: {
        state: run.state,
        terminal: run.state === 'complete' || run.state === 'failed' || run.state === 'cancelled',
        transitions: run.transitions.length,
      },
      redaction: {
        rawSecretsAvailable: false,
        rawLogsAvailable: false,
        maxConflicts: HANDOFF_STATUS_MAX_CONFLICTS,
      },
    };
  }

  cancel(runId: string, actorId?: string): HandoffRunStatus | null {
    const stored = this.runs.get(runId);
    if (!stored) return null;
    if (stored.run.state === 'complete' || stored.run.state === 'failed' || stored.run.state === 'cancelled') {
      return this.getStatus(runId);
    }
    const at = nowIso(this.deps);
    const transition: HandoffRunTransition = {
      from: stored.run.state,
      to: 'cancelled',
      at,
      reasonCode: 'CANCELLED_BY_OPERATOR',
      ...(actorId ? { actorId } : {}),
    };
    stored.run = {
      ...stored.run,
      state: 'cancelled',
      reasonCode: 'CANCELLED_BY_OPERATOR',
      transitions: [...stored.run.transitions, transition],
      updatedAt: at,
      completedAt: at,
    };
    return this.getStatus(runId);
  }

  resume(runId: string): { run: HandoffRun; resume: { summary: string; artifactRefs: string[]; rawTranscriptAvailable: false; retryLaunchAvailable: boolean } } | null {
    const stored = this.runs.get(runId);
    if (!stored) return null;
    return {
      run: sanitizeRun(stored.run),
      resume: {
        summary: `Resume cold handoff ${runId} from state ${stored.run.state}; use artifact refs only, never raw transcript/provider auth.`,
        artifactRefs: stored.artifacts.map((artifact) => artifact.id),
        rawTranscriptAvailable: false,
        retryLaunchAvailable:
          stored.run.state === 'failed' && stored.run.reasonCode === 'FAILED_LAUNCH',
      },
    };
  }

  async retryLaunch(runId: string, actorId?: string): Promise<
    | { ok: true; run: HandoffRun; artifacts: HandoffArtifactSummary[] }
    | { ok: false; error: ReturnType<typeof apiError>; run?: HandoffRun }
  > {
    const stored = this.runs.get(runId);
    if (!stored) {
      return {
        ok: false,
        error: apiError('HANDOFF_RUN_NOT_FOUND', 'handoff run was not found', 404, { runId }),
      };
    }
    if (!stored.run.planId) {
      return {
        ok: false,
        error: apiError('INVALID_PLAN_ID', 'handoff run has no plan id for launch retry', 404, { runId }),
        run: sanitizeRun(stored.run),
      };
    }
    const storedPlan = this.plans.get(stored.run.planId);
    if (!storedPlan) {
      return {
        ok: false,
        error: apiError('INVALID_PLAN_ID', 'handoff plan was not found for launch retry', 404, { runId, planId: stored.run.planId }),
        run: sanitizeRun(stored.run),
      };
    }
    if (!(stored.run.state === 'failed' && stored.run.reasonCode === 'FAILED_LAUNCH')) {
      return {
        ok: false,
        error: apiError('INVALID_RUN_STATE', 'handoff launch retry is available only after a launch failure', 409, { runId, state: stored.run.state, reasonCode: stored.run.reasonCode }),
        run: sanitizeRun(stored.run),
      };
    }
    const retryRun = rewindLaunchAttempt(stored.run);
    const launched = await this.launchAppliedRun({
      plan: storedPlan.plan,
      request: storedPlan.request,
      run: retryRun,
      artifacts: stored.artifacts,
      ...(actorId ? { actorId } : {}),
    });
    this.runs.set(launched.run.id, {
      run: sanitizeRun(launched.run),
      auditEvents: [...stored.auditEvents, ...launched.auditEvents],
      artifacts: launched.artifacts,
    });
    if (launched.ok) {
      return { ok: true, run: sanitizeRun(launched.run), artifacts: launched.artifacts };
    }
    return { ok: false, error: launched.error, run: sanitizeRun(launched.run) };
  }

  readArtifact(ref: string): HandoffArtifactSummary | null {
    for (const run of this.runs.values()) {
      const artifact = run.artifacts.find((entry) => entry.id === ref);
      if (artifact) return artifact;
    }
    const plan = this.plans.get(ref);
    if (plan) {
      return {
        id: ref,
        planId: ref,
        group: 'resume-bundle',
        summary: `handoff plan ${ref} metadata reference`,
        refs: [plan.plan.id, plan.plan.requestId],
        sha256: hashJson(plan.plan),
        rawPayloadAvailable: false,
        transcriptExportAvailable: false,
      };
    }
    return null;
  }

  getPlan(planId: string): HandoffPlan | null {
    return this.plans.get(planId)?.plan ?? null;
  }

  getPlanForRun(runId: string): HandoffPlan | null {
    const stored = this.runs.get(runId);
    if (!stored?.run.planId) return null;
    return this.getPlan(stored.run.planId);
  }

  private createFailedRun(
    plan: HandoffPlan,
    conflicts: HandoffConflict[],
    reasonCode: HandoffReasonCode,
    actorId?: string,
    atOverride?: string
  ): HandoffRun {
    const at = atOverride ?? nowIso(this.deps);
    const run: HandoffRun = {
      schemaVersion: HANDOFF_SCHEMA_VERSION,
      id: createId(this.deps, 'handoff-run'),
      requestId: plan.requestId,
      planId: plan.id,
      state: 'failed',
      sourceDisposition: 'handoff-failed',
      sourceDispositions: mergeSourceDispositions([plan.source.disposition], ['handoff-failed']),
      reasonCode,
      conflicts,
      transitions: [
        {
          from: 'planned',
          to: 'failed',
          at,
          reasonCode,
          ...(actorId ? { actorId } : {}),
        },
      ],
      createdAt: at,
      updatedAt: at,
      completedAt: at,
    };
    const artifacts = this.artifactsForRun(run.id, plan.id, []);
    this.runs.set(run.id, { run, auditEvents: [], artifacts });
    return sanitizeRun(run);
  }

  private artifactsForRun(runId: string, planId: string, auditEvents: unknown[]): HandoffArtifactSummary[] {
    return [
      {
        id: `handoff-artifact:${runId}:audit-summary`,
        runId,
        planId,
        group: 'audit-summary',
        summary: 'bounded audit summary for cold handoff run; raw logs and secrets are not included',
        refs: auditEvents.slice(0, HANDOFF_STATUS_MAX_CONFLICTS).map((_, idx) => `audit:${idx}`),
        sha256: hashJson(auditEvents),
        rawPayloadAvailable: false,
        transcriptExportAvailable: false,
      },
      {
        id: `handoff-artifact:${runId}:resume-bundle`,
        runId,
        planId,
        group: 'resume-bundle',
        summary: 'resume bundle reference for destination agent; contains metadata refs only',
        refs: [runId, planId],
        rawPayloadAvailable: false,
        transcriptExportAvailable: false,
      },
    ];
  }
}

function bodyRecord(req: Parameters<RequestHandler>[0]): Record<string, unknown> {
  return typeof req.body === 'object' && req.body !== null && !Array.isArray(req.body)
    ? (req.body as Record<string, unknown>)
    : {};
}

function capabilitySet(context: HandoffCapabilityContext | null | undefined): Set<string> | null {
  if (!context) return null;
  const items = Array.isArray(context) ? context : Array.from(context);
  return new Set(items.map((item) => item.trim()).filter(Boolean));
}

function requireCapabilities(
  req: Parameters<RequestHandler>[0],
  capabilities: readonly string[],
  capabilityContext: HandoffCapabilityProvider
): ReturnType<typeof apiError> | null {
  const provided = capabilitySet(capabilityContext(req));
  if (!provided) {
    return apiError('CAPABILITY_DENIED', 'missing validated capability context for handoff route', 403, { missingCapabilities: capabilities });
  }
  const missing = capabilities.filter((capability) => !provided.has(capability));
  if (missing.length === 0) return null;
  return apiError('CAPABILITY_DENIED', `missing required capability: ${missing[0]}`, 403, { missingCapabilities: missing });
}

function createRouteCapabilities(plan: HandoffPlan | null): readonly string[] {
  const sessionCreateCapability = plan?.launchPreview.runtime.kind === 'terminal'
    ? 'session:create:terminal'
    : 'session:create:agent';
  return ['rpc:fs:read', 'rpc:fs:write', sessionCreateCapability, 'pty:exec:arbitrary'];
}

function launchRouteCapabilities(plan: HandoffPlan | null): readonly string[] {
  if (!plan) return [SESSION_READ_CAPABILITY];
  const runtimeCapabilities = plan.launchPreview.runtime.requiredCapabilities.length > 0
    ? plan.launchPreview.runtime.requiredCapabilities
    : [
        plan.launchPreview.runtime.kind === 'terminal'
          ? 'session:create:terminal'
          : 'session:create:agent',
        'pty:exec:arbitrary',
      ];
  return Array.from(new Set([SESSION_READ_CAPABILITY, ...runtimeCapabilities]));
}

function planFromCreateBody(body: Record<string, unknown>, service: HandoffService): HandoffPlan | null {
  const inlinePlan = body['plan'];
  if (isHandoffPlan(inlinePlan)) return inlinePlan;
  const planId = body['planId'];
  if (typeof planId === 'string') return service.getPlan(planId);
  return null;
}

export function createHandoffRouter(input: {
  service?: HandoffService;
  requireAuth?: RequestHandler;
  getCapabilities?: HandoffCapabilityProvider;
  workContextStore?: WorkContextStore;
  getSession?: (nodeId: string, sessionId: string) => unknown | undefined;
  launchDestinationSession?: (
    input: HandoffDestinationLaunchInput
  ) => Promise<HandoffDestinationLaunchResult> | HandoffDestinationLaunchResult;
} = {}): Router {
  const router = Router();
  const auth = input.requireAuth ?? ((_req, _res, next) => next());
  const capabilityContext = input.getCapabilities ?? (() => null);
  const service =
    input.service ??
    new HandoffService({
      ...(input.workContextStore ? { workContextStore: input.workContextStore } : {}),
      ...(input.getSession ? { getSession: input.getSession } : {}),
      ...(input.launchDestinationSession ? { launchDestinationSession: input.launchDestinationSession } : {}),
    });

  router.post('/plan', auth, async (req, res) => {
    const denied = requireCapabilities(req, [SESSION_READ_CAPABILITY, 'rpc:fs:read'], capabilityContext);
    if (denied) {
      res.status(denied.status).json(denied.body);
      return;
    }
    const body = bodyRecord(req);
    const result = await service.plan({
      request: body['request'] as HandoffRequest,
      ...(typeof body['sourceRepoPath'] === 'string' ? { sourceRepoPath: body['sourceRepoPath'] } : {}),
      ...(Array.isArray(body['approvedUntrackedPaths']) ? { approvedUntrackedPaths: body['approvedUntrackedPaths'] as string[] } : {}),
      ...(typeof body['sourceBranchName'] === 'string' ? { sourceBranchName: body['sourceBranchName'] } : {}),
    });
    if (!result.ok) {
      res.status(result.error.status).json(result.error.body);
      return;
    }
    res.json({ plan: result.plan, dryRun: result.dryRun, readOnly: true });
  });

  router.post('/create', auth, async (req, res) => {
    const body = bodyRecord(req);
    const denied = requireCapabilities(req, createRouteCapabilities(planFromCreateBody(body, service)), capabilityContext);
    if (denied) {
      res.status(denied.status).json(denied.body);
      return;
    }
    const result = await service.create({
      ...(typeof body['planId'] === 'string' ? { planId: body['planId'] } : {}),
      ...(body['plan'] ? { plan: body['plan'] as HandoffPlan } : {}),
      ...(Array.isArray(body['confirmedGrants']) ? { confirmedGrants: body['confirmedGrants'] as HandoffRequiredGrant[] } : {}),
      ...(typeof body['sourceRepoPath'] === 'string' ? { sourceRepoPath: body['sourceRepoPath'] } : {}),
      ...(typeof body['destinationRepoPath'] === 'string' ? { destinationRepoPath: body['destinationRepoPath'] } : {}),
      ...(Array.isArray(body['approvedUntrackedPaths']) ? { approvedUntrackedPaths: body['approvedUntrackedPaths'] as string[] } : {}),
      ...(typeof body['actorId'] === 'string' ? { actorId: body['actorId'] } : {}),
    });
    if (!result.ok) {
      res.status(result.error.status).json({ ...result.error.body, ...(result.run ? { run: result.run } : {}) });
      return;
    }
    res.status(201).json({ run: result.run, artifacts: result.artifacts });
  });

  router.get('/:runId/status', auth, (req, res) => {
    const denied = requireCapabilities(req, [SESSION_READ_CAPABILITY], capabilityContext);
    if (denied) {
      res.status(denied.status).json(denied.body);
      return;
    }
    const status = service.getStatus(req.params['runId'] ?? '');
    if (!status) {
      const error = apiError('HANDOFF_RUN_NOT_FOUND', 'handoff run was not found', 404, { runId: req.params['runId'] });
      res.status(error.status).json(error.body);
      return;
    }
    res.json(status);
  });

  router.post('/:runId/cancel', auth, (req, res) => {
    const denied = requireCapabilities(req, [SESSION_READ_CAPABILITY], capabilityContext);
    if (denied) {
      res.status(denied.status).json(denied.body);
      return;
    }
    const status = service.cancel(req.params['runId'] ?? '', bodyRecord(req)['actorId'] as string | undefined);
    if (!status) {
      const error = apiError('HANDOFF_RUN_NOT_FOUND', 'handoff run was not found', 404, { runId: req.params['runId'] });
      res.status(error.status).json(error.body);
      return;
    }
    res.json(status);
  });

  router.get('/:runId/resume', auth, (req, res) => {
    const denied = requireCapabilities(req, [SESSION_READ_CAPABILITY], capabilityContext);
    if (denied) {
      res.status(denied.status).json(denied.body);
      return;
    }
    const resume = service.resume(req.params['runId'] ?? '');
    if (!resume) {
      const error = apiError('HANDOFF_RUN_NOT_FOUND', 'handoff run was not found', 404, { runId: req.params['runId'] });
      res.status(error.status).json(error.body);
      return;
    }
    res.json(resume);
  });

  router.post('/:runId/launch', auth, async (req, res) => {
    const runId = req.params['runId'] ?? '';
    const denied = requireCapabilities(
      req,
      launchRouteCapabilities(service.getPlanForRun(runId)),
      capabilityContext
    );
    if (denied) {
      res.status(denied.status).json(denied.body);
      return;
    }
    const body = bodyRecord(req);
    const result = await service.retryLaunch(
      runId,
      typeof body['actorId'] === 'string' ? body['actorId'] : undefined
    );
    if (!result.ok) {
      res.status(result.error.status).json({
        ...result.error.body,
        ...(result.run ? { run: result.run } : {}),
      });
      return;
    }
    res.json({ run: result.run, artifacts: result.artifacts });
  });

  router.get('/artifacts/:ref', auth, (req, res) => {
    const denied = requireCapabilities(req, [SESSION_READ_CAPABILITY], capabilityContext);
    if (denied) {
      res.status(denied.status).json(denied.body);
      return;
    }
    const artifact = service.readArtifact(req.params['ref'] ?? '');
    if (!artifact) {
      const error = apiError('HANDOFF_ARTIFACT_NOT_FOUND', 'handoff artifact ref was not found', 404, { ref: req.params['ref'] });
      res.status(error.status).json(error.body);
      return;
    }
    res.json({ artifact });
  });

  return router;
}
