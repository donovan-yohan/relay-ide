import {
  ENVIRONMENT_OPTION_SCHEMA_VERSION,
  type EnvironmentOption,
} from '../../../shared/environment-option.js';
import {
  DEFAULT_LOCAL_NODE_ID,
  createRepoInstanceId,
  createWorktreeInstanceId,
} from '../../../shared/identity.js';
import type { RelayCliGatewayErrorEnvelope } from '../../../shared/cli-gateway-contract.js';
import {
  HANDOFF_SCHEMA_VERSION,
  type HandoffPlan,
  type HandoffRequest,
  type HandoffRequiredGrant,
} from '../../../shared/handoff.js';
import {
  executeHandoffsCreateAction,
  executeHandoffsPlanAction,
  type HandoffCreateResponse,
  type HandoffPlanResponse,
} from './actions/handoff-gateway.js';
import type { SessionSummary } from './types.js';

export type HandoffLiveStatus =
  | 'idle'
  | 'loading'
  | 'ready'
  | 'needs-grants'
  | 'blocked'
  | 'empty'
  | 'capability-denied'
  | 'source-stale'
  | 'hub-unavailable'
  | 'error'
  | 'creating'
  | 'created';

export interface HandoffApiErrorView {
  code: string;
  message: string;
  retryable: boolean;
  reasonCode?: string;
  details?: Record<string, unknown>;
  status?: number;
}

export interface HandoffDraft {
  request: HandoffRequest;
  sourceRepoPath?: string;
  destinationRepoPath?: string;
  sourceBranchName?: string;
}

export interface HandoffDraftResult {
  draft: HandoffDraft | null;
  emptyReason?: string;
}

function preferredCwd(session: SessionSummary): string {
  return session.worktreePath ?? session.cwd ?? session.repoPath ?? '';
}

function destinationCwdFor(sourceCwd: string): string {
  const clean = sourceCwd.startsWith('/') ? sourceCwd : `/${sourceCwd}`;
  return `/relay-hub-cold-handoff${clean}`.replaceAll('//', '/');
}

function destinationOptionFor(session: SessionSummary, generatedAt: string): EnvironmentOption {
  const destinationNodeId = 'hub';
  const sourceCwd = preferredCwd(session);
  const destinationCwd = destinationCwdFor(sourceCwd || session.id);
  const sourceRepoPath = session.repoPath ?? session.worktreePath ?? null;
  const repoInstanceId = sourceRepoPath
    ? createRepoInstanceId(destinationNodeId, sourceRepoPath)
    : undefined;
  const worktreeInstanceId = session.worktreePath
    ? createWorktreeInstanceId(destinationNodeId, destinationCwd)
    : undefined;
  return {
    schemaVersion: ENVIRONMENT_OPTION_SCHEMA_VERSION,
    id: `handoff:${destinationNodeId}:${destinationCwd}`,
    node: {
      nodeId: destinationNodeId,
      kind: 'remote',
      displayName: 'hub',
      online: true,
    },
    capabilities: [
      'session:read',
      'session:create:agent',
      'rpc:fs:read',
      'rpc:fs:write',
      'pty:exec:arbitrary',
    ],
    cwd: destinationCwd,
    cwdMode: sourceRepoPath ? 'repo' : 'free',
    freshness: 'fresh',
    ...(repoInstanceId
      ? {
          repoInstance: {
            repoInstanceId,
            localPath: sourceRepoPath!,
            repoIdentity: null,
            ...(session.repoName ? { name: session.repoName } : {}),
            currentBranch: session.branchName ?? null,
          },
        }
      : {}),
    ...(repoInstanceId && worktreeInstanceId
      ? {
          bench: {
            worktreeInstanceId,
            localPath: destinationCwd,
            branchName: session.branchName ?? null,
          },
        }
      : {}),
    generatedAt,
  };
}

export function buildHandoffDraft(session: SessionSummary | null | undefined): HandoffDraftResult {
  if (!session) return { draft: null, emptyReason: 'select an active tab before requesting a cold handoff plan' };
  const cwd = preferredCwd(session);
  if (!cwd) return { draft: null, emptyReason: 'active tab has no cwd to snapshot' };
  if (!session.workContextId) return { draft: null, emptyReason: 'active tab has no WorkContext yet' };

  const requestedAt = new Date().toISOString();
  const sourceNodeId = session.nodeId ?? DEFAULT_LOCAL_NODE_ID;
  const destination = destinationOptionFor(session, requestedAt);
  const request: HandoffRequest = {
    schemaVersion: HANDOFF_SCHEMA_VERSION,
    id: `handoff-request:${sourceNodeId}:${session.id}:${Date.now()}`,
    requestedAt,
    requestedByActorId: 'relay-frontend',
    source: {
      nodeId: sourceNodeId,
      sessionId: session.id,
      ...(session.globalSessionId ? { globalSessionId: session.globalSessionId } : {}),
      workContextId: session.workContextId,
      cwd,
      disposition: session.durability === 'stale-node' ? 'stale-source' : 'left-running',
      ...(session.durability ? { durabilityState: session.durability } : {}),
    },
    destination: {
      nodeId: destination.node.nodeId,
      option: destination,
      cwd: destination.cwd,
      ...(destination.repoInstance?.repoInstanceId ? { repoInstanceId: destination.repoInstance.repoInstanceId } : {}),
      ...(destination.bench?.worktreeInstanceId ? { worktreeInstanceId: destination.bench.worktreeInstanceId } : {}),
    },
    desiredRuntime: {
      kind: session.type === 'terminal' ? 'terminal' : 'agent',
      ...(session.type === 'agent' ? { providerId: session.agent } : {}),
      commandSummary: 'start a new hub-side session from the cold handoff snapshot',
      requiredCapabilities: [
        session.type === 'terminal' ? 'session:create:terminal' : 'session:create:agent',
        'pty:exec:arbitrary',
      ],
    },
    reason: 'frontend cold handoff dry-run request',
  };

  const sourceRepoPath = session.worktreePath ?? session.repoPath ?? undefined;
  return {
    draft: {
      request,
      ...(sourceRepoPath ? { sourceRepoPath } : {}),
      ...(session.branchName ? { sourceBranchName: session.branchName } : {}),
      destinationRepoPath: destination.cwd,
    },
  };
}

function handoffErrorViewFromEnvelope(
  envelope: RelayCliGatewayErrorEnvelope
): HandoffApiErrorView {
  const details = envelope.error.details;
  const upstreamCode = typeof details?.['upstreamCode'] === 'string' ? details['upstreamCode'] : undefined;
  const reasonCode = typeof details?.['reasonCode'] === 'string' ? details['reasonCode'] : undefined;
  const status = typeof details?.['status'] === 'number' ? details['status'] : undefined;
  return {
    code: upstreamCode ?? envelope.error.code,
    message: envelope.error.message,
    retryable: envelope.error.retryable,
    ...(reasonCode ? { reasonCode } : {}),
    ...(details ? { details } : {}),
    ...(status !== undefined ? { status } : {}),
  };
}

export async function planHandoff(draft: HandoffDraft): Promise<HandoffPlanResponse> {
  const result = await executeHandoffsPlanAction({
    request: draft.request,
    ...(draft.sourceRepoPath ? { sourceRepoPath: draft.sourceRepoPath } : {}),
    ...(draft.sourceBranchName ? { sourceBranchName: draft.sourceBranchName } : {}),
  });
  if (result.ok === false) throw handoffErrorViewFromEnvelope(result);
  return result.data;
}

export function confirmedGrantsForPlan(plan: HandoffPlan): HandoffRequiredGrant[] {
  return plan.requiredGrants.map((grant) => ({
    ...grant,
    decision: 'allow',
  }));
}

export async function createHandoffFromPlan(
  draft: HandoffDraft,
  plan: HandoffPlan
): Promise<HandoffCreateResponse> {
  const result = await executeHandoffsCreateAction({
    planId: plan.id,
    confirmedGrants: confirmedGrantsForPlan(plan),
    ...(draft.sourceRepoPath ? { sourceRepoPath: draft.sourceRepoPath } : {}),
    ...(draft.destinationRepoPath ? { destinationRepoPath: draft.destinationRepoPath } : {}),
    actorId: 'relay-frontend',
  });
  if (result.ok === false) throw handoffErrorViewFromEnvelope(result);
  return result.data;
}

export function handoffStatusFromError(error: HandoffApiErrorView): HandoffLiveStatus {
  if (error.code === 'CAPABILITY_DENIED') return 'capability-denied';
  if (error.code === 'SOURCE_STALE_OR_OFFLINE' || error.code === 'STALE_PLAN') return 'source-stale';
  if (error.code === 'DESTINATION_UNAVAILABLE') return 'hub-unavailable';
  return 'error';
}
