import type { Request } from 'express';
import type {
  ControlActor,
  InterventionRecord,
} from '../shared/control-state.js';
import type { RelayCapabilityBit } from '../shared/security-policy.js';

export const CONTROL_READ_CAPABILITY = 'session:read' as const;
export const INTERVENTION_READ_CAPABILITY = 'tab:intervention:read' as const;
export const CONTROL_SESSION_CAPABILITY = 'session:attach' as const;
export const CONTROL_KILL_CAPABILITY = 'session:control:kill' as const;
export const CONTROL_RENAME_CAPABILITY = 'session:control:rename' as const;

export type SessionControlCapability = RelayCapabilityBit;

export interface ControlCapabilityDecision {
  decision: 'allow' | 'deny';
  capability: SessionControlCapability;
  placeholder: boolean;
  reasonCode?: 'CAPABILITY_REQUIRED';
  message?: string;
}

export interface SessionControlError {
  code: 'INVALID_REQUEST' | 'NOT_FOUND' | 'SESSION_CONFLICT' | 'FORBIDDEN';
  reasonCode:
    | 'CAPABILITY_REQUIRED'
    | 'SESSION_NOT_FOUND'
    | 'SESSION_DISCONNECTED'
    | 'CONTROL_STATE_STALE'
    | 'CONTROL_STATE_UNKNOWN';
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
}

export interface InterventionReadResponse {
  interventions: InterventionRecord[];
  count: number;
  limit: number;
  truncated: boolean;
  rawPayloadAvailable: false;
  transcriptExportAvailable: false;
  redaction: {
    payload: 'preview-only';
    metadataIncluded: true;
  };
}

const DEFAULT_INTERVENTION_LIMIT = 50;
const MAX_INTERVENTION_LIMIT = 200;

function parseCapabilityHeader(value: string | undefined): Set<string> | null {
  if (value === undefined) return null;
  return new Set(
    value
      .split(/[\s,]+/)
      .map((entry) => entry.trim())
      .filter(Boolean)
  );
}

export function evaluateControlCapabilityPlaceholder(
  capabilityHeader: string | undefined,
  capability: SessionControlCapability
): ControlCapabilityDecision {
  const explicitCapabilities = parseCapabilityHeader(capabilityHeader);
  if (!explicitCapabilities) {
    return { decision: 'allow', capability, placeholder: true };
  }
  if (explicitCapabilities.has(capability)) {
    return { decision: 'allow', capability, placeholder: true };
  }
  return {
    decision: 'deny',
    capability,
    placeholder: true,
    reasonCode: 'CAPABILITY_REQUIRED',
    message: `missing required capability: ${capability}`,
  };
}

export function capabilityDecisionFromRequest(
  req: Request,
  capability: SessionControlCapability
): ControlCapabilityDecision {
  const header = req.header('x-relay-capabilities') ?? undefined;
  return evaluateControlCapabilityPlaceholder(header, capability);
}

export function capabilitiesDecisionFromRequest(
  req: Request,
  capabilities: readonly SessionControlCapability[]
): ControlCapabilityDecision {
  const header = req.header('x-relay-capabilities') ?? undefined;
  let firstAllow: ControlCapabilityDecision | undefined;
  for (const capability of capabilities) {
    const decision = evaluateControlCapabilityPlaceholder(header, capability);
    if (decision.decision !== 'allow') return decision;
    firstAllow ??= decision;
  }
  return (
    firstAllow ??
    evaluateControlCapabilityPlaceholder(header, CONTROL_READ_CAPABILITY)
  );
}

export function errorStatus(error: SessionControlError): number {
  switch (error.reasonCode) {
    case 'CAPABILITY_REQUIRED':
      return 403;
    case 'SESSION_NOT_FOUND':
      return 404;
    default:
      return 409;
  }
}

export function capabilityError(
  decision: ControlCapabilityDecision
): SessionControlError {
  return {
    code: 'FORBIDDEN',
    reasonCode: 'CAPABILITY_REQUIRED',
    message:
      decision.message ?? `missing required capability: ${decision.capability}`,
    retryable: false,
    details: {
      capability: decision.capability,
      placeholder: decision.placeholder,
    },
  };
}

export function clampInterventionLimit(value: unknown): number {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim()
        ? Number(value)
        : DEFAULT_INTERVENTION_LIMIT;
  if (!Number.isFinite(parsed)) return DEFAULT_INTERVENTION_LIMIT;
  return Math.min(Math.max(Math.trunc(parsed), 1), MAX_INTERVENTION_LIMIT);
}

export function toInterventionReadResponse(input: {
  records: InterventionRecord[];
  limit?: number;
}): InterventionReadResponse {
  const limit = clampInterventionLimit(input.limit);
  const interventions = input.records.slice(0, limit);
  return {
    interventions,
    count: interventions.length,
    limit,
    truncated: input.records.length > interventions.length,
    rawPayloadAvailable: false,
    transcriptExportAvailable: false,
    redaction: {
      payload: 'preview-only',
      metadataIncluded: true,
    },
  };
}

export function createHumanDrivenInitialControlState(
  input: {
    actorId?: string;
    displayName?: string;
    nodeId?: string;
    sessionId?: string;
    reason?: string;
  } = {}
): {
  controlMode: 'human-driven';
  activeActors: ControlActor[];
  lastInterventionAt: null;
  lastInterventionBy: null;
  lastInterventionEventId: null;
  controlFreshness: 'fresh';
  controlReason: string;
} {
  const activeHuman: ControlActor = {
    kind: 'human',
    id: input.actorId ?? 'browser-user',
    displayName: input.displayName ?? 'Browser user',
    ...(input.nodeId ? { nodeId: input.nodeId } : {}),
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
  };
  return {
    controlMode: 'human-driven',
    activeActors: [activeHuman],
    lastInterventionAt: null,
    lastInterventionBy: null,
    lastInterventionEventId: null,
    controlFreshness: 'fresh',
    controlReason: input.reason ?? 'routed-session-created',
  };
}

export function actorFromRequestBody(value: unknown): ControlActor | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (
    record['kind'] !== 'agent' &&
    record['kind'] !== 'human' &&
    record['kind'] !== 'system'
  ) {
    return undefined;
  }
  const actor: ControlActor = { kind: record['kind'] };
  if (typeof record['id'] === 'string') actor.id = record['id'];
  if (typeof record['displayName'] === 'string')
    actor.displayName = record['displayName'];
  if (typeof record['nodeId'] === 'string') actor.nodeId = record['nodeId'];
  if (typeof record['sessionId'] === 'string')
    actor.sessionId = record['sessionId'];
  return actor;
}
