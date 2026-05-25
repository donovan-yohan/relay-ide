import { createHash } from 'node:crypto';

import {
  normalizeControlStateSummary,
  type ControlMode,
  type ControlStateSummary,
} from '../shared/control-state.js';
import type { RelayCapabilityBit } from '../shared/security-policy.js';
import type { AgentState, SessionMode, SessionStatus, SessionSummary, SessionType } from './types.js';

export const SUPERVISOR_SNAPSHOT_COMMAND_ID = 'supervisor.snapshot' as const;
export const SUPERVISOR_SNAPSHOT_REQUIRED_CAPABILITIES = [
  'session:read',
  'tab:intervention:read',
] as const satisfies readonly RelayCapabilityBit[];

export type SupervisorSnapshotErrorCode =
  | 'NOT_FOUND'
  | 'FORBIDDEN'
  | 'CONTROL_STATE_STALE'
  | 'INTERVENTION_ACK_REQUIRED'
  | 'UPSTREAM_ERROR';

export interface SupervisorSnapshotPolicy {
  /** Optional caller-observed mode. If supplied, the snapshot refuses stale/mismatched control state. */
  expectedControlMode?: ControlMode;
  /** Optional caller-observed intervention event. Required to match when the target has a newer intervention. */
  latestSeenInterventionEventId?: string;
}

export interface SupervisorRedactedInterventionSummary {
  id: string;
  timestamp: string;
  source: string;
  kind: string;
  authorKind?: string;
  redacted: true;
  hashSha256?: string;
  byteCount?: number;
  lineCount?: number;
}

export interface SupervisorSnapshotPartialFailure {
  source: 'interventions';
  code: 'UPSTREAM_ERROR';
  message: string;
}

export interface SupervisorSnapshotInput {
  session?: SessionSummary | null;
  grantedCapabilities: readonly string[] | ReadonlySet<string>;
  actorId?: string;
  policy?: SupervisorSnapshotPolicy;
  now?: Date;
  readInterventions?: () =>
    | readonly SupervisorRedactedInterventionSummary[]
    | Promise<readonly SupervisorRedactedInterventionSummary[]>;
}

export interface SupervisorProviderSnapshot {
  providerId: string;
  mode: SessionMode;
  capabilityBoundary: 'relay-command-contract';
  readOnlyAdapterState: boolean;
  rawProviderStateStored: false;
}

export interface SupervisorSessionSnapshot {
  command: typeof SUPERVISOR_SNAPSHOT_COMMAND_ID;
  capturedAt: string;
  session: {
    sessionId: string;
    globalSessionId?: string;
    nodeId?: string;
    type: SessionType;
    agent: string;
    mode: SessionMode;
    status: SessionStatus;
    agentState: AgentState;
    cwd: string;
    repoPath?: string;
    worktreePath?: string | null;
    workContextId?: string;
  };
  control: ControlStateSummary;
  provider: SupervisorProviderSnapshot;
  interventions: {
    available: boolean;
    items: SupervisorRedactedInterventionSummary[];
    rawPayloadAvailable: false;
    transcriptExportAvailable: false;
  };
  redaction: {
    rawPtyInputAvailable: false;
    rawTranscriptAvailable: false;
    rawPromptAvailable: false;
    rawProviderStateAvailable: false;
    auditStoresHashesOnly: true;
  };
  partialFailures: SupervisorSnapshotPartialFailure[];
}

export interface SupervisorSnapshotAuditSummary {
  command: typeof SUPERVISOR_SNAPSHOT_COMMAND_ID;
  decision: 'allowed' | 'denied';
  actorId?: string;
  target: {
    sessionId?: string;
    globalSessionId?: string;
    nodeId?: string;
  };
  requiredCapabilities: readonly RelayCapabilityBit[];
  missingCapabilities: readonly RelayCapabilityBit[];
  controlMode?: ControlMode;
  controlFreshness?: ControlStateSummary['controlFreshness'];
  latestInterventionEventIdHash?: string;
  partialFailureCount: number;
  redaction: {
    rawPromptStored: false;
    rawTranscriptStored: false;
    rawPtyInputStored: false;
    rawProviderStateStored: false;
  };
}

export type SupervisorSnapshotResult =
  | { ok: true; snapshot: SupervisorSessionSnapshot; audit: SupervisorSnapshotAuditSummary }
  | {
      ok: false;
      error: { code: SupervisorSnapshotErrorCode; message: string; retryable: boolean };
      audit: SupervisorSnapshotAuditSummary;
    };

function hasCapability(granted: readonly string[] | ReadonlySet<string>, capability: string): boolean {
  if (typeof (granted as ReadonlySet<string>).has === 'function') {
    return (granted as ReadonlySet<string>).has(capability);
  }
  return (granted as readonly string[]).includes(capability);
}

function missingCapabilities(
  granted: readonly string[] | ReadonlySet<string>
): RelayCapabilityBit[] {
  return SUPERVISOR_SNAPSHOT_REQUIRED_CAPABILITIES.filter(
    (capability) => !hasCapability(granted, capability)
  );
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function controlStateFromSession(session: SessionSummary): ControlStateSummary {
  return normalizeControlStateSummary({
    controlMode: session.controlMode,
    activeActors: session.activeActors,
    activeWorker: session.activeWorker,
    lastInterventionAt: session.lastInterventionAt,
    lastInterventionBy: session.lastInterventionBy,
    lastInterventionEventId: session.lastInterventionEventId,
    controlFreshness: session.controlFreshness,
    controlReason: session.controlReason,
  });
}

function auditSummary(input: {
  session?: SessionSummary | null | undefined;
  actorId?: string | undefined;
  decision: 'allowed' | 'denied';
  control?: ControlStateSummary | undefined;
  missing?: readonly RelayCapabilityBit[] | undefined;
  partialFailureCount?: number | undefined;
}): SupervisorSnapshotAuditSummary {
  return {
    command: SUPERVISOR_SNAPSHOT_COMMAND_ID,
    decision: input.decision,
    ...(input.actorId ? { actorId: input.actorId } : {}),
    target: {
      ...(input.session?.id ? { sessionId: input.session.id } : {}),
      ...(input.session?.globalSessionId ? { globalSessionId: input.session.globalSessionId } : {}),
      ...(input.session?.nodeId ? { nodeId: input.session.nodeId } : {}),
    },
    requiredCapabilities: SUPERVISOR_SNAPSHOT_REQUIRED_CAPABILITIES,
    missingCapabilities: input.missing ?? [],
    ...(input.control?.controlMode ? { controlMode: input.control.controlMode } : {}),
    ...(input.control?.controlFreshness
      ? { controlFreshness: input.control.controlFreshness }
      : {}),
    ...(input.control?.lastInterventionEventId
      ? { latestInterventionEventIdHash: hash(input.control.lastInterventionEventId) }
      : {}),
    partialFailureCount: input.partialFailureCount ?? 0,
    redaction: {
      rawPromptStored: false,
      rawTranscriptStored: false,
      rawPtyInputStored: false,
      rawProviderStateStored: false,
    },
  };
}

export async function createSupervisorSnapshot(
  input: SupervisorSnapshotInput
): Promise<SupervisorSnapshotResult> {
  if (!input.session) {
    return {
      ok: false,
      error: { code: 'NOT_FOUND', message: 'session not found', retryable: false },
      audit: auditSummary({
        session: input.session,
        actorId: input.actorId,
        decision: 'denied',
      }),
    };
  }

  const control = controlStateFromSession(input.session);
  const missing = missingCapabilities(input.grantedCapabilities);
  if (missing.length > 0) {
    return {
      ok: false,
      error: {
        code: 'FORBIDDEN',
        message: 'supervisor snapshot requires session read and intervention read capabilities',
        retryable: false,
      },
      audit: auditSummary({
        session: input.session,
        actorId: input.actorId,
        decision: 'denied',
        control,
        missing,
      }),
    };
  }

  if (
    input.policy?.expectedControlMode &&
    (control.controlFreshness !== 'fresh' || control.controlMode !== input.policy.expectedControlMode)
  ) {
    return {
      ok: false,
      error: {
        code: 'CONTROL_STATE_STALE',
        message: 'target session control state changed since the caller snapshot',
        retryable: true,
      },
      audit: auditSummary({
        session: input.session,
        actorId: input.actorId,
        decision: 'denied',
        control,
      }),
    };
  }

  if (
    control.lastInterventionEventId &&
    input.policy?.latestSeenInterventionEventId !== control.lastInterventionEventId
  ) {
    return {
      ok: false,
      error: {
        code: 'INTERVENTION_ACK_REQUIRED',
        message: 'latest human intervention must be observed before supervisor actions continue',
        retryable: true,
      },
      audit: auditSummary({
        session: input.session,
        actorId: input.actorId,
        decision: 'denied',
        control,
      }),
    };
  }

  const partialFailures: SupervisorSnapshotPartialFailure[] = [];
  let interventions: SupervisorRedactedInterventionSummary[] = [];
  if (input.readInterventions) {
    try {
      interventions = [...(await input.readInterventions())];
    } catch (error) {
      partialFailures.push({
        source: 'interventions',
        code: 'UPSTREAM_ERROR',
        message: error instanceof Error ? error.message : 'failed to read redacted interventions',
      });
    }
  }

  const snapshot: SupervisorSessionSnapshot = {
    command: SUPERVISOR_SNAPSHOT_COMMAND_ID,
    capturedAt: (input.now ?? new Date()).toISOString(),
    session: {
      sessionId: input.session.id,
      ...(input.session.globalSessionId ? { globalSessionId: input.session.globalSessionId } : {}),
      ...(input.session.nodeId ? { nodeId: input.session.nodeId } : {}),
      type: input.session.type,
      agent: input.session.agent,
      mode: input.session.mode,
      status: input.session.status,
      agentState: input.session.agentState,
      cwd: input.session.cwd,
      ...(input.session.repoPath ? { repoPath: input.session.repoPath } : {}),
      ...(input.session.worktreePath !== undefined
        ? { worktreePath: input.session.worktreePath }
        : {}),
      ...(input.session.workContextId ? { workContextId: input.session.workContextId } : {}),
    },
    control,
    provider: {
      providerId: input.session.agent,
      mode: input.session.mode,
      capabilityBoundary: 'relay-command-contract',
      readOnlyAdapterState: true,
      rawProviderStateStored: false,
    },
    interventions: {
      available: partialFailures.length === 0,
      items: interventions,
      rawPayloadAvailable: false,
      transcriptExportAvailable: false,
    },
    redaction: {
      rawPtyInputAvailable: false,
      rawTranscriptAvailable: false,
      rawPromptAvailable: false,
      rawProviderStateAvailable: false,
      auditStoresHashesOnly: true,
    },
    partialFailures,
  };

  return {
    ok: true,
    snapshot,
    audit: auditSummary({
      session: input.session,
      actorId: input.actorId,
      decision: 'allowed',
      control,
      partialFailureCount: partialFailures.length,
    }),
  };
}
