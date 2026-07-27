import {
  relayActionDescriptorFromCommandDefinition,
  type RelayActionAvailability,
  type RelayActionDescriptor,
} from '../../../../shared/action-descriptor.js';
import {
  gatewayError,
  gatewayOk,
  type RelayCliGatewayCommand,
  type RelayCliGatewayEnvelope,
  type RelayCliGatewayError,
} from '../../../../shared/cli-gateway-contract.js';
import {
  gatewayErrorMessage,
  gatewayErrorRetryable,
  normalizeGatewayErrorCode,
  sanitizedGatewayErrorDetails,
} from '../../../../shared/cli-gateway-runtime.js';
import type {
  HandoffPlan,
  HandoffRequest,
} from '../../../../shared/handoff.js';
import { isHandoffPlan } from '../../../../shared/handoff.js';
import {
  relayCommandDefinition,
  type RelayCommandDefinition,
} from '../../../../shared/relay-command-manifest.js';

const HANDOFFS_PLAN_COMMAND = relayCommandDefinition('handoffs.plan');

export interface HandoffPlanResponse {
  plan: HandoffPlan;
  dryRun?: unknown;
  readOnly?: boolean;
}

export interface HandoffPlanActionInput {
  request: HandoffRequest;
  sourceRepoPath?: string;
  approvedUntrackedPaths?: string[];
  sourceBranchName?: string;
}

export type HandoffPlanActionResult =
  RelayCliGatewayEnvelope<HandoffPlanResponse>;
export type HandoffFetch = (
  input: RequestInfo | URL,
  init?: RequestInit
) => Promise<Response>;

function commandAvailability(
  command: RelayCommandDefinition,
  reason?: string
): RelayActionAvailability {
  return {
    state: reason ? 'unavailable' : 'available',
    ...(reason ? { reason } : {}),
    capabilityHints: command.capabilityHints,
  };
}

export function handoffsPlanActionDescriptor(
  availability: RelayActionAvailability = commandAvailability(
    HANDOFFS_PLAN_COMMAND
  )
): RelayActionDescriptor {
  return relayActionDescriptorFromCommandDefinition(HANDOFFS_PLAN_COMMAND, {
    availability,
    surfaces: ['cli', 'agent', 'web', 'command-center'],
  });
}

export function handoffsPlanCommandDefinition(): RelayCommandDefinition {
  return HANDOFFS_PLAN_COMMAND;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function parseJsonRecord(
  res: Response
): Promise<Record<string, unknown> | null> {
  try {
    const data = await res.json();
    return isRecord(data) ? data : null;
  } catch {
    return null;
  }
}

function safeRecordArray(
  value: unknown
): Record<string, unknown>[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const records = value.filter(isRecord);
  return records.length ? records : undefined;
}

function errorDetailsWithHandoffSummaries(
  status: number,
  upstream: Record<string, unknown> | null
): Record<string, unknown> {
  const details = sanitizedGatewayErrorDetails(status, upstream ?? undefined);
  const error = isRecord(upstream?.['error']) ? upstream['error'] : null;
  const upstreamDetails = isRecord(error?.['details'])
    ? error['details']
    : null;
  const conflicts = safeRecordArray(upstreamDetails?.['conflicts']);
  if (conflicts) details['conflicts'] = conflicts;
  if (isRecord(upstream?.['run'])) details['run'] = upstream['run'];
  return details;
}

function gatewayErrorFromResponse(
  command: RelayCliGatewayCommand,
  res: Response,
  body: Record<string, unknown> | null
): RelayCliGatewayError {
  return {
    code: normalizeGatewayErrorCode(res.status, body ?? undefined),
    message: gatewayErrorMessage(res.status, body ?? undefined),
    retryable: gatewayErrorRetryable(res.status, body ?? undefined),
    details: errorDetailsWithHandoffSummaries(res.status, body),
  };
}

function invalidPlanResponse(): HandoffPlanActionResult {
  return gatewayError('handoffs.plan', {
    code: 'UPSTREAM_ERROR',
    message: 'handoffs.plan response did not include a valid plan',
    retryable: false,
    details: { reasonCode: 'INVALID_PLAN_RESPONSE' },
  });
}

export async function executeHandoffsPlanAction(
  input: HandoffPlanActionInput,
  fetchImpl: HandoffFetch = (url, init) => fetch(url, init)
): Promise<HandoffPlanActionResult> {
  const res = await fetchImpl('/handoffs/plan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  const body = await parseJsonRecord(res);
  if (!res.ok)
    return gatewayError(
      'handoffs.plan',
      gatewayErrorFromResponse('handoffs.plan', res, body)
    );
  if (!isHandoffPlan(body?.['plan'])) return invalidPlanResponse();
  return gatewayOk('handoffs.plan', body as unknown as HandoffPlanResponse);
}
