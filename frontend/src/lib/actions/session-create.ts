import {
  relayActionDescriptorFromCommandDefinition,
  type RelayActionAvailability,
  type RelayActionDescriptor,
} from '../../../../shared/action-descriptor.js';
import {
  relayCommandDefinition,
  type RelayCommandDefinition,
} from '../../../../shared/relay-command-manifest.js';
import {
  DEFAULT_LOCAL_NODE_ID,
  createGlobalSessionId,
} from '../../../../shared/identity.js';
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
  type?: 'agent' | 'terminal';
  mode?: 'pty' | 'web';
  agent?: string;
  terminalBackend?: 'relay-pty' | 'tmux-compat';
}

export interface SessionCreateActionError {
  code: string;
  reasonCode: string;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
}

export interface SessionCreateActionSuccess {
  ok: true;
  command: 'sessions.create';
  descriptor: RelayActionDescriptor;
  input: SessionCreateActionInput;
  session: SessionSummary;
  target: SessionCreateActionTarget;
}

export interface SessionCreateActionFailure {
  ok: false;
  command: 'sessions.create';
  descriptor: RelayActionDescriptor;
  input: SessionCreateActionInput;
  target: Partial<SessionCreateActionTarget>;
  error: SessionCreateActionError;
  rawError?: unknown;
}

export type SessionCreateActionResult =
  | SessionCreateActionSuccess
  | SessionCreateActionFailure;

export type SessionCreateExecutor = (
  input: CreateSessionBody
) => Promise<SessionSummary>;

function capabilityAvailability(
  reason?: string
): RelayActionAvailability {
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

function targetFromInputAndSession(
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
    target.worktreePath = session.worktreePath ?? input.worktreePath ?? null;
  }
  const type = session.type ?? input.type;
  if (type) target.type = type;
  const mode = session.mode ?? input.mode;
  if (mode) target.mode = mode;
  const agent = session.agent ?? input.agent;
  if (agent) target.agent = agent;
  if (input.terminalBackend) target.terminalBackend = input.terminalBackend;
  return target;
}

function targetFromInput(input: SessionCreateActionInput): Partial<SessionCreateActionTarget> {
  return {
    ...(input.nodeId ? { nodeId: input.nodeId } : {}),
    ...(input.cwd ? { cwd: input.cwd } : {}),
    ...(input.repoPath ? { repoPath: input.repoPath } : {}),
    ...(input.worktreePath !== undefined ? { worktreePath: input.worktreePath } : {}),
    ...(input.type ? { type: input.type } : {}),
    ...(input.mode ? { mode: input.mode } : {}),
    ...(input.agent ? { agent: input.agent } : {}),
    ...(input.terminalBackend ? { terminalBackend: input.terminalBackend } : {}),
  };
}

function errorFromUnknown(error: unknown): SessionCreateActionError {
  if (error instanceof ConflictError) {
    return {
      code: 'SESSION_CONFLICT',
      reasonCode: 'SESSION_ALREADY_EXISTS',
      message: 'session already exists for this launch target',
      retryable: false,
      details: error.sessionId ? { sessionId: error.sessionId } : {},
    };
  }

  if (error instanceof ConfirmationRequiredError) {
    return {
      code: 'CONFIRMATION_REQUIRED',
      reasonCode: error.challenge.reasonCode,
      message: error.message,
      retryable: true,
      details: {
        challengeId: error.challenge.challengeId,
        requiredBits: error.challenge.requiredBits,
        expiresAt: error.challenge.expiresAt,
      },
    };
  }

  if (error instanceof HttpError) {
    return {
      code: error.code ?? 'UPSTREAM_ERROR',
      reasonCode: error.code ?? 'HTTP_ERROR',
      message: error.message,
      retryable: error.retryable ?? error.status >= 500,
      ...(error.details ? { details: error.details } : {}),
    };
  }

  if (error instanceof Error) {
    return {
      code: 'UPSTREAM_ERROR',
      reasonCode: 'SESSION_CREATE_FAILED',
      message: error.message,
      retryable: true,
    };
  }

  return {
    code: 'UPSTREAM_ERROR',
    reasonCode: 'SESSION_CREATE_FAILED',
    message: 'failed to create session',
    retryable: true,
  };
}

export async function executeSessionCreateAction(
  input: SessionCreateActionInput,
  createSession: SessionCreateExecutor = createSessionApi
): Promise<SessionCreateActionResult> {
  const descriptor = sessionCreateActionDescriptor(
    sessionCreateActionAvailability({
      workspacePath: input.repoPath ?? input.worktreePath ?? null,
      cwd: input.cwd ?? null,
    })
  );

  try {
    const session = await createSession(input);
    return {
      ok: true,
      command: 'sessions.create',
      descriptor,
      input,
      session,
      target: targetFromInputAndSession(input, session),
    };
  } catch (rawError) {
    return {
      ok: false,
      command: 'sessions.create',
      descriptor,
      input,
      target: targetFromInput(input),
      error: errorFromUnknown(rawError),
      rawError,
    };
  }
}
