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
} from '../../../../shared/cli-gateway-contract.js';
import { normalizeGatewayErrorCode } from '../../../../shared/cli-gateway-runtime.js';
import {
  DEFAULT_LOCAL_NODE_ID,
  createGlobalSessionId,
} from '../../../../shared/identity.js';
import {
  relayCommandDefinition,
  type RelayCommandDefinition,
} from '../../../../shared/relay-command-manifest.js';
import {
  ConfirmationRequiredError,
  ConflictError,
  HttpError,
  createSession as createSessionApi,
  type CreateSessionBody,
} from '../api.js';
import type { SessionSummary } from '../types.js';

const SESSIONS_CREATE_COMMAND = relayCommandDefinition('sessions.create');

export type SessionCreateActionInput = CreateSessionBody;

export interface SessionCreateActionTarget {
  sessionId: string;
  globalSessionId: string;
  nodeId: string;
  cwd?: string;
  repoPath?: string;
  worktreePath?: string | null;
  type?: 'terminal';
  mode?: 'pty';
  terminalBackend?: 'relay-pty';
}

export type SessionCreateActionResult = RelayCliGatewayEnvelope<SessionSummary>;
export type SessionCreateActionFailure = Extract<
  SessionCreateActionResult,
  { ok: false }
>;

export type SessionCreateExecutor = (
  input: CreateSessionBody
) => Promise<SessionSummary>;

function capabilityAvailability(reason?: string): RelayActionAvailability {
  return {
    state: reason ? 'unavailable' : 'available',
    ...(reason ? { reason } : {}),
    capabilityHints: SESSIONS_CREATE_COMMAND.capabilityHints,
  };
}

export function sessionCreateActionDescriptor(
  availability: RelayActionAvailability = capabilityAvailability()
): RelayActionDescriptor {
  return relayActionDescriptorFromCommandDefinition(SESSIONS_CREATE_COMMAND, {
    availability,
    surfaces: ['cli', 'agent', 'web', 'command-center'],
  });
}

export function sessionCreateActionAvailability(input: {
  workspacePath?: string | null;
  cwd?: string | null;
  nodeUnavailableReason?: string | null;
  unsupportedCapabilityReason?: string | null;
}): RelayActionAvailability {
  const reason =
    input.nodeUnavailableReason ??
    input.unsupportedCapabilityReason ??
    (!input.workspacePath && !input.cwd
      ? 'session launch requires a workspace, cwd, or selected environment'
      : undefined);
  return capabilityAvailability(reason ?? undefined);
}

export function sessionsCreateCommandDefinition(): RelayCommandDefinition {
  return SESSIONS_CREATE_COMMAND;
}

export function sessionCreateActionTarget(
  input: SessionCreateActionInput,
  session: SessionSummary
): SessionCreateActionTarget {
  const nodeId = session.nodeId ?? input.nodeId ?? DEFAULT_LOCAL_NODE_ID;
  const sessionId = session.id;
  const target: SessionCreateActionTarget = {
    sessionId,
    globalSessionId:
      session.globalSessionId ?? createGlobalSessionId(nodeId, sessionId),
    nodeId,
  };
  const cwd = session.cwd ?? input.cwd;
  if (cwd) target.cwd = cwd;
  const repoPath = session.repoPath ?? input.repoPath;
  if (repoPath) target.repoPath = repoPath;
  if (session.worktreePath !== undefined || input.worktreePath !== undefined) {
    target.worktreePath =
      session.worktreePath !== undefined
        ? session.worktreePath
        : (input.worktreePath ?? null);
  }
  const type = session.type ?? input.type;
  if (type) target.type = type;
  const mode = session.mode ?? input.mode;
  if (mode) target.mode = mode;
  if (input.terminalBackend) target.terminalBackend = input.terminalBackend;
  return target;
}

function errorFromUnknown(error: unknown): RelayCliGatewayError {
  if (error instanceof ConflictError) {
    return {
      code: 'SESSION_CONFLICT',
      message: 'session already exists for this launch target',
      retryable: false,
      details: error.sessionId
        ? { sessionId: error.sessionId, reasonCode: 'SESSION_ALREADY_EXISTS' }
        : { reasonCode: 'SESSION_ALREADY_EXISTS' },
    };
  }

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
    return {
      code: normalizeGatewayErrorCode(error.status, {
        code: error.code,
        message: error.message,
        retryable: error.retryable,
        details: error.details,
      }),
      message: error.message,
      retryable: error.retryable ?? error.status >= 500,
      ...(error.details
        ? {
            details: {
              reasonCode: error.code ?? 'HTTP_ERROR',
              ...error.details,
            },
          }
        : { details: { reasonCode: error.code ?? 'HTTP_ERROR' } }),
    };
  }

  if (error instanceof Error) {
    return {
      code: 'UPSTREAM_ERROR',
      message: error.message,
      retryable: true,
      details: { reasonCode: 'SESSION_CREATE_FAILED' },
    };
  }

  return {
    code: 'UPSTREAM_ERROR',
    message: 'failed to create session',
    retryable: true,
    details: { reasonCode: 'SESSION_CREATE_FAILED' },
  };
}

export async function executeSessionCreateAction(
  input: SessionCreateActionInput,
  createSession: SessionCreateExecutor = createSessionApi
): Promise<SessionCreateActionResult> {
  try {
    const session = await createSession(input);
    return gatewayOk('sessions.create', session);
  } catch (rawError) {
    return gatewayError('sessions.create', errorFromUnknown(rawError));
  }
}
