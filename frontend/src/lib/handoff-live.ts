import {
  ENVIRONMENT_OPTION_SCHEMA_VERSION,
  type EnvironmentOption,
} from '../../../shared/environment-option.js';
import {
  DEFAULT_LOCAL_NODE_ID,
  createRepoInstanceId,
  createWorktreeInstanceId,
} from '../../../shared/identity.js';
import {
  HANDOFF_SCHEMA_VERSION,
  isHandoffPlan,
  type HandoffPlan,
  type HandoffRequest,
  type HandoffRequiredGrant,
  type HandoffRun,
} from '../../../shared/handoff.js';
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

export interface HandoffPlanResponse {
  plan: HandoffPlan;
  dryRun?: unknown;
  readOnly?: boolean;
}

export interface HandoffCreateResponse {
  run: HandoffRun;
  artifacts?: Array<{
    id: string;
    group: string;
    summary: string;
    refs?: string[];
    rawPayloadAvailable?: false;
    transcriptExportAvailable?: false;
  }>;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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

async function parseHandoffError(res: Response): Promise<HandoffApiErrorView> {
  try {
    const data = await res.json();
    const error = isRecord(data?.error) ? data.error : null;
    const code = typeof error?.code === 'string' ? error.code : `HTTP_${res.status}`;
    return {
      code,
      message:
        typeof error?.message === 'string'
          ? error.message
          : typeof data?.error === 'string'
            ? data.error
            : `handoff API returned HTTP ${res.status}`,
      retryable: typeof error?.retryable === 'boolean' ? error.retryable : false,
      ...(typeof error?.reasonCode === 'string' ? { reasonCode: error.reasonCode } : {}),
      ...(isRecord(error?.details) ? { details: error.details } : {}),
      status: res.status,
    };
  } catch {
    return {
      code: `HTTP_${res.status}`,
      message: `handoff API returned HTTP ${res.status}`,
      retryable: false,
      status: res.status,
    };
  }
}

export async function planHandoff(draft: HandoffDraft): Promise<HandoffPlanResponse> {
  const res = await fetch('/handoffs/plan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      request: draft.request,
      ...(draft.sourceRepoPath ? { sourceRepoPath: draft.sourceRepoPath } : {}),
      ...(draft.sourceBranchName ? { sourceBranchName: draft.sourceBranchName } : {}),
    }),
  });
  if (!res.ok) throw await parseHandoffError(res);
  const body = (await res.json()) as HandoffPlanResponse;
  if (!isHandoffPlan(body.plan)) {
    throw {
      code: 'INVALID_PLAN_RESPONSE',
      message: 'handoff API response did not include a valid plan',
      retryable: false,
    } satisfies HandoffApiErrorView;
  }
  return body;
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
  const res = await fetch('/handoffs/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      planId: plan.id,
      confirmedGrants: confirmedGrantsForPlan(plan),
      ...(draft.sourceRepoPath ? { sourceRepoPath: draft.sourceRepoPath } : {}),
      ...(draft.destinationRepoPath ? { destinationRepoPath: draft.destinationRepoPath } : {}),
      actorId: 'relay-frontend',
    }),
  });
  if (!res.ok) {
    const clone = res.clone();
    const error = await parseHandoffError(res);
    try {
      const data = await clone.json();
      if (isRecord(data?.run)) {
        (error.details ??= {}).run = data.run;
      }
    } catch {
      // ignore parse fallback; the typed error is enough for UI copy.
    }
    throw error;
  }
  return (await res.json()) as HandoffCreateResponse;
}

export function handoffStatusFromError(error: HandoffApiErrorView): HandoffLiveStatus {
  if (error.code === 'CAPABILITY_DENIED') return 'capability-denied';
  if (error.code === 'SOURCE_STALE_OR_OFFLINE' || error.code === 'STALE_PLAN') return 'source-stale';
  if (error.code === 'DESTINATION_UNAVAILABLE') return 'hub-unavailable';
  return 'error';
}
