import {
  relayActionDescriptorFromCommandDefinition,
  type RelayActionAvailability,
  type RelayActionDescriptor,
} from '../../../../shared/action-descriptor.js';
import {
  gatewayError,
  gatewayOk,
  type RelayCliGatewayEnvelope,
  type RelayCliGatewayError,
  type RelayCliGatewayErrorCode,
} from '../../../../shared/cli-gateway-contract.js';
import { normalizeGatewayErrorCode } from '../../../../shared/cli-gateway-runtime.js';
import {
  DEFAULT_LOCAL_NODE_ID,
  createGlobalSessionId,
  type NodeId,
} from '../../../../shared/identity.js';
import {
  relayCommandDefinition,
  type RelayCommandDefinition,
} from '../../../../shared/relay-command-manifest.js';
import {
  ConfirmationRequiredError,
  HttpError,
  killSession as killSessionApi,
  renameSession as renameSessionApi,
} from '../api.js';

const SESSIONS_KILL_COMMAND = relayCommandDefinition('sessions.kill');
const SESSIONS_RENAME_COMMAND = relayCommandDefinition('sessions.rename');

// Optional fields permit explicit `undefined` to satisfy exactOptionalPropertyTypes
// at the call sites that resolve node identity conditionally.
export interface SessionKillActionInput {
  id: string;
  nodeId?: NodeId | string | undefined;
  globalSessionId?: string | undefined;
  confirmationToken?: string | undefined;
}

export interface SessionRenameActionInput {
  id: string;
  displayName: string;
  nodeId?: NodeId | string | undefined;
  globalSessionId?: string | undefined;
}

export interface SessionLifecycleActionTarget {
  sessionId: string;
  globalSessionId: string;
  nodeId: string;
}

export interface SessionKillActionData {
  ok: true;
  killed: true;
  id: string;
  sessionId: string;
  requestedId: string;
  nodeId: string;
  globalSessionId: string;
}

export interface SessionRenameActionData {
  renamed: true;
  id: string;
  sessionId: string;
  requestedId: string;
  nodeId: string;
  globalSessionId: string;
  displayName: string;
}

export type SessionKillActionResult =
  RelayCliGatewayEnvelope<SessionKillActionData>;
export type SessionRenameActionResult =
  RelayCliGatewayEnvelope<SessionRenameActionData>;

// Executors take the action input object so call sites can resolve owning-node
// routing once and pass it through (see useActionRegistry sessions.kill wiring).
// Defaults delegate to api.ts so the DELETE/PATCH + confirmation-retry stay one path.
export type SessionKillExecutor = (
  input: SessionKillActionInput
) => Promise<void>;
export type SessionRenameExecutor = (
  input: SessionRenameActionInput
) => Promise<unknown>;

// Session-control reasonCodes (server/session-control-api.ts:29-37) carry a
// finer-grained meaning than the gateway code; surface them on the gateway code
// the spec freezes (stale/unknown control and disconnected sessions are gateway
// FORBIDDEN even though normalizeGatewayErrorCode keeps them as their own codes).
const REASON_CODE_TO_GATEWAY_CODE: Record<string, RelayCliGatewayErrorCode> = {
  SESSION_NOT_FOUND: 'NOT_FOUND',
  CAPABILITY_REQUIRED: 'FORBIDDEN',
  SESSION_DISCONNECTED: 'FORBIDDEN',
  CONTROL_STATE_STALE: 'FORBIDDEN',
  CONTROL_STATE_UNKNOWN: 'FORBIDDEN',
};

function killCapabilityAvailability(reason?: string): RelayActionAvailability {
  return {
    state: reason ? 'unavailable' : 'available',
    ...(reason ? { reason } : {}),
    capabilityHints: SESSIONS_KILL_COMMAND.capabilityHints,
  };
}

function renameCapabilityAvailability(reason?: string): RelayActionAvailability {
  return {
    state: reason ? 'unavailable' : 'available',
    ...(reason ? { reason } : {}),
    capabilityHints: SESSIONS_RENAME_COMMAND.capabilityHints,
  };
}

export function sessionKillActionDescriptor(
  availability: RelayActionAvailability = killCapabilityAvailability()
): RelayActionDescriptor {
  return relayActionDescriptorFromCommandDefinition(SESSIONS_KILL_COMMAND, {
    availability,
    surfaces: ['cli', 'agent', 'web', 'command-center'],
  });
}

export function sessionRenameActionDescriptor(
  availability: RelayActionAvailability = renameCapabilityAvailability()
): RelayActionDescriptor {
  return relayActionDescriptorFromCommandDefinition(SESSIONS_RENAME_COMMAND, {
    availability,
    surfaces: ['cli', 'agent', 'web', 'command-center'],
  });
}

interface SessionLifecycleAvailabilityInput {
  sessionMissing?: boolean;
  nodeUnavailableReason?: string | null;
  unsupportedModeReason?: string | null;
  controlState?: 'stale' | 'unknown' | null;
}

function lifecycleUnavailableReason(
  input: SessionLifecycleAvailabilityInput,
  verb: string
): string | undefined {
  if (input.sessionMissing) return `${verb} requires an existing session`;
  if (input.nodeUnavailableReason) return input.nodeUnavailableReason;
  if (input.unsupportedModeReason) return input.unsupportedModeReason;
  if (input.controlState === 'stale')
    return `${verb} requires fresh session control state`;
  if (input.controlState === 'unknown')
    return `${verb} requires known session control state`;
  return undefined;
}

export function sessionKillActionAvailability(
  input: SessionLifecycleAvailabilityInput
): RelayActionAvailability {
  return killCapabilityAvailability(
    lifecycleUnavailableReason(input, 'closing a session')
  );
}

export function sessionRenameActionAvailability(
  input: SessionLifecycleAvailabilityInput
): RelayActionAvailability {
  return renameCapabilityAvailability(
    lifecycleUnavailableReason(input, 'renaming a session')
  );
}

export function sessionsKillCommandDefinition(): RelayCommandDefinition {
  return SESSIONS_KILL_COMMAND;
}

export function sessionsRenameCommandDefinition(): RelayCommandDefinition {
  return SESSIONS_RENAME_COMMAND;
}

function resolveIdentity(input: {
  id: string;
  nodeId?: NodeId | string | undefined;
  globalSessionId?: string | undefined;
}): SessionLifecycleActionTarget {
  const parsedNodeId = input.globalSessionId?.includes(':')
    ? input.globalSessionId.slice(0, input.globalSessionId.indexOf(':'))
    : undefined;
  const nodeId = input.nodeId ?? parsedNodeId ?? DEFAULT_LOCAL_NODE_ID;
  return {
    sessionId: input.id,
    globalSessionId:
      input.globalSessionId ?? createGlobalSessionId(nodeId, input.id),
    nodeId,
  };
}

export function sessionKillActionTarget(
  input: SessionKillActionInput
): SessionLifecycleActionTarget {
  return resolveIdentity(input);
}

export function sessionRenameActionTarget(
  input: SessionRenameActionInput
): SessionLifecycleActionTarget {
  return resolveIdentity(input);
}

function reasonCodeFromError(error: HttpError): string | undefined {
  const reasonCode = error.details?.['reasonCode'];
  return typeof reasonCode === 'string' ? reasonCode : undefined;
}

function gatewayCodeForHttpError(error: HttpError): RelayCliGatewayErrorCode {
  const reasonCode = reasonCodeFromError(error);
  const mapped = reasonCode ? REASON_CODE_TO_GATEWAY_CODE[reasonCode] : undefined;
  if (mapped) return mapped;
  return normalizeGatewayErrorCode(error.status, {
    code: error.code,
    message: error.message,
    retryable: error.retryable,
    details: error.details,
  });
}

function errorFromUnknown(
  error: unknown,
  fallbackReasonCode: string,
  fallbackMessage: string
): RelayCliGatewayError {
  if (error instanceof ConfirmationRequiredError) {
    return {
      code: 'CONFIRMATION_REQUIRED',
      message: error.message,
      retryable: true,
      details: {
        reasonCode: error.challenge.reasonCode,
        challengeId: error.challenge.challengeId,
        requiredBits: error.challenge.requiredBits,
        expiresAt: error.challenge.expiresAt,
      },
    };
  }

  if (error instanceof HttpError) {
    const reasonCode = reasonCodeFromError(error) ?? error.code ?? fallbackReasonCode;
    return {
      code: gatewayCodeForHttpError(error),
      message: error.message,
      retryable: error.retryable ?? error.status >= 500,
      details: { reasonCode, ...(error.details ?? {}) },
    };
  }

  if (error instanceof Error) {
    return {
      code: 'UPSTREAM_ERROR',
      message: error.message,
      retryable: true,
      details: { reasonCode: fallbackReasonCode },
    };
  }

  return {
    code: 'UPSTREAM_ERROR',
    message: fallbackMessage,
    retryable: true,
    details: { reasonCode: fallbackReasonCode },
  };
}

const defaultKillExecutor: SessionKillExecutor = (input) =>
  killSessionApi(input.id, input.nodeId);
const defaultRenameExecutor: SessionRenameExecutor = (input) =>
  renameSessionApi(input.id, input.displayName, input.nodeId);

export async function executeSessionKillAction(
  input: SessionKillActionInput,
  killSession: SessionKillExecutor = defaultKillExecutor
): Promise<SessionKillActionResult> {
  try {
    // Delegate to api.ts killSession so its registerConfirmationRetry loop stays
    // the single confirmation path; the DELETE returns no body, so the identity
    // envelope is projected from the request target.
    await killSession(input);
    const target = sessionKillActionTarget(input);
    return gatewayOk('sessions.kill', {
      ok: true,
      killed: true,
      id: target.sessionId,
      sessionId: target.sessionId,
      requestedId: target.sessionId,
      nodeId: target.nodeId,
      globalSessionId: target.globalSessionId,
    });
  } catch (rawError) {
    return gatewayError(
      'sessions.kill',
      errorFromUnknown(rawError, 'SESSION_KILL_FAILED', 'failed to close session')
    );
  }
}

export async function executeSessionRenameAction(
  input: SessionRenameActionInput,
  renameSession: SessionRenameExecutor = defaultRenameExecutor
): Promise<SessionRenameActionResult> {
  try {
    await renameSession(input);
    const target = sessionRenameActionTarget(input);
    return gatewayOk('sessions.rename', {
      renamed: true,
      id: target.sessionId,
      sessionId: target.sessionId,
      requestedId: target.sessionId,
      nodeId: target.nodeId,
      globalSessionId: target.globalSessionId,
      displayName: input.displayName,
    });
  } catch (rawError) {
    return gatewayError(
      'sessions.rename',
      errorFromUnknown(
        rawError,
        'SESSION_RENAME_FAILED',
        'failed to rename session'
      )
    );
  }
}
