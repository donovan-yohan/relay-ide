import type { LocalRelayNode } from './local-node.js';
import type { Logger } from './logger.js';
import { createLogger } from './logger.js';
import type { CreateParams } from './sessions.js';
import type { CreateWebParams } from './web-session-handler.js';
import type {
  NodeLinkChannelHandler,
  NodeLinkEnvelopeHandlerContext,
} from './node-link-client.js';
import type {
  RelayNodeEnvelope,
  RelayNodeError,
} from '../shared/relay-node-protocol.js';
import type { SessionSummary } from './types.js';

// Node-side RPC dispatcher. Hub initiates rpc/<type> requests over the
// reverse WS; this module receives them, calls into the local
// RelayNode, and sends back a `<type>.result` (or `<type>.error`)
// envelope on the same `requestId`.
//
// Wired today: `sessions.create` (#425.7) and `sessions.list` (#465).
// Other RPC types fall through to an INVALID_REQUEST response so
// misrouted envelopes don't silently hang the hub-side pending
// request.

export interface NodeLinkRpcHostOptions {
  localRelayNode: LocalRelayNode;
  logger?: Logger;
}

export interface NodeLinkRpcHost {
  handle: NodeLinkChannelHandler;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
    ? (value as string[])
    : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function asNullableString(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value === 'string') return value;
  return undefined;
}

interface SessionsCreateInput {
  type: 'agent' | 'terminal';
  mode?: 'pty' | 'web';
  agent?: string;
  repoPath?: string;
  worktreePath?: string | null;
  cwd?: string;
  command?: string;
  args?: string[];
  displayName?: string;
  branchName?: string;
  customCommand?: string | null;
  workspaceId?: string;
  additionalDirs?: string[];
  initialPrompt?: string;
  useTmux?: boolean;
  needsBranchRename?: boolean;
  branchRenamePrompt?: string;
  continue?: boolean;
}

function parseSessionsCreateInput(
  raw: unknown
): SessionsCreateInput | RelayNodeError {
  const record = asRecord(raw);
  if (!record) {
    return invalidRequest('sessions.create payload must be an object');
  }
  const typeRaw = asString(record['type']);
  if (typeRaw !== 'agent' && typeRaw !== 'terminal') {
    return invalidRequest(
      'sessions.create payload.type must be "agent" or "terminal"'
    );
  }
  const modeRaw = asString(record['mode']);
  if (modeRaw !== undefined && modeRaw !== 'pty' && modeRaw !== 'web') {
    return invalidRequest(
      'sessions.create payload.mode must be "pty" or "web" when set'
    );
  }
  const input: SessionsCreateInput = { type: typeRaw };
  if (modeRaw) input.mode = modeRaw;
  const agent = asString(record['agent']);
  if (agent !== undefined) input.agent = agent;
  const repoPath = asString(record['repoPath']);
  if (repoPath !== undefined) input.repoPath = repoPath;
  const worktreePath = asNullableString(record['worktreePath']);
  if (worktreePath !== undefined) input.worktreePath = worktreePath;
  const cwd = asString(record['cwd']);
  if (cwd !== undefined) input.cwd = cwd;
  const command = asString(record['command']);
  if (command !== undefined) input.command = command;
  const args = asStringArray(record['args']);
  if (args !== undefined) input.args = args;
  const displayName = asString(record['displayName']);
  if (displayName !== undefined) input.displayName = displayName;
  const branchName = asString(record['branchName']);
  if (branchName !== undefined) input.branchName = branchName;
  const customCommand = asNullableString(record['customCommand']);
  if (customCommand !== undefined) input.customCommand = customCommand;
  const workspaceId = asString(record['workspaceId']);
  if (workspaceId !== undefined) input.workspaceId = workspaceId;
  const additionalDirs = asStringArray(record['additionalDirs']);
  if (additionalDirs !== undefined) input.additionalDirs = additionalDirs;
  const initialPrompt = asString(record['initialPrompt']);
  if (initialPrompt !== undefined) input.initialPrompt = initialPrompt;
  const useTmux = asBoolean(record['useTmux']);
  if (useTmux !== undefined) input.useTmux = useTmux;
  const needsBranchRename = asBoolean(record['needsBranchRename']);
  if (needsBranchRename !== undefined)
    input.needsBranchRename = needsBranchRename;
  const branchRenamePrompt = asString(record['branchRenamePrompt']);
  if (branchRenamePrompt !== undefined)
    input.branchRenamePrompt = branchRenamePrompt;
  const continueFlag = asBoolean(record['continue']);
  if (continueFlag !== undefined) input.continue = continueFlag;
  return input;
}

function invalidRequest(message: string): RelayNodeError {
  return { code: 'INVALID_REQUEST', message, retryable: false };
}

function internalError(message: string): RelayNodeError {
  return { code: 'INTERNAL', message, retryable: true };
}

function sessionSummaryFromCreateResult(value: unknown): SessionSummary {
  // CreateResult is SessionSummary & { pid }. Strip pid before sending
  // across the wire; hub-side isSessionSummary validator doesn't expect
  // it and it leaks node-local OS detail.
  const record = (value as Record<string, unknown>) ?? {};
  const { pid: _pid, ...rest } = record;
  void _pid;
  return rest as unknown as SessionSummary;
}

function sendResultEnvelope(
  ctx: NodeLinkEnvelopeHandlerContext,
  envelope: RelayNodeEnvelope,
  payload: unknown
): void {
  ctx.send(
    ctx.buildEnvelope('rpc', `${envelope.type}.result`, {
      ...(envelope.requestId ? { requestId: envelope.requestId } : {}),
      payload,
    })
  );
}

function sendErrorEnvelope(
  ctx: NodeLinkEnvelopeHandlerContext,
  envelope: RelayNodeEnvelope,
  error: RelayNodeError
): void {
  ctx.send(
    ctx.buildEnvelope('rpc', `${envelope.type}.error`, {
      ...(envelope.requestId ? { requestId: envelope.requestId } : {}),
      error,
    })
  );
}

export function createNodeLinkRpcHost(
  options: NodeLinkRpcHostOptions
): NodeLinkRpcHost {
  const logger = options.logger ?? createLogger('node-link-rpc');
  const { localRelayNode } = options;

  async function handleSessionsCreate(
    envelope: RelayNodeEnvelope,
    ctx: NodeLinkEnvelopeHandlerContext
  ): Promise<void> {
    const parsed = parseSessionsCreateInput(envelope.payload);
    if ('code' in parsed) {
      sendErrorEnvelope(ctx, envelope, parsed);
      return;
    }
    try {
      if (parsed.mode === 'web') {
        const { session } = await localRelayNode.sessions.createWeb(
          parsed as unknown as CreateWebParams
        );
        sendResultEnvelope(ctx, envelope, { session });
        return;
      }
      const result = localRelayNode.sessions.create(
        parsed as unknown as CreateParams
      );
      sendResultEnvelope(ctx, envelope, {
        session: sessionSummaryFromCreateResult(result),
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error ?? 'unknown');
      logger.error(`sessions.create failed: ${message}`);
      sendErrorEnvelope(ctx, envelope, internalError(message));
    }
  }

  function handleSessionsList(
    envelope: RelayNodeEnvelope,
    ctx: NodeLinkEnvelopeHandlerContext
  ): void {
    try {
      const raw = localRelayNode.sessions.list();
      const sessions = raw.map((entry) =>
        sessionSummaryFromCreateResult(entry)
      );
      sendResultEnvelope(ctx, envelope, { sessions });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error ?? 'unknown');
      logger.error(`sessions.list failed: ${message}`);
      sendErrorEnvelope(ctx, envelope, internalError(message));
    }
  }

  function handle(
    envelope: RelayNodeEnvelope,
    ctx: NodeLinkEnvelopeHandlerContext
  ): void {
    if (envelope.channel !== 'rpc') return;
    if (envelope.type === 'sessions.create') {
      void handleSessionsCreate(envelope, ctx);
      return;
    }
    if (envelope.type === 'sessions.list') {
      handleSessionsList(envelope, ctx);
      return;
    }
    logger.warn(
      `unhandled rpc/${envelope.type} (requestId=${envelope.requestId ?? '?'})`
    );
    sendErrorEnvelope(
      ctx,
      envelope,
      invalidRequest(`rpc method "${envelope.type}" is not implemented`)
    );
  }

  return { handle };
}
