import * as crypto from 'node:crypto';
import * as os from 'node:os';
import { isFileRpcOperation, type FileRpcTailResponse } from '../shared/file-rpc.js';
import { createFileRpcFollower, executeLocalFileRpc, type FileRpcFollower } from './file-rpc.js';
import type { LocalRelayNode } from './local-node.js';
import {
  createNodeLogFollower,
  defaultNodeLogRuntime,
  parseNodeLogTailRequest,
  readNodeLogTailSnapshot,
  type NodeLogFollower,
} from './node-logs.js';
import type { LogEventFilter } from '../shared/log-event.js';
import type { Logger } from './logger.js';
import { createLogger } from './logger.js';
import type { CreateParams } from './sessions.js';
import {
  createAgentDrivenInitialControlState,
  createHumanDrivenInitialControlState,
} from './session-control-api.js';
import type {
  NodeLinkChannelHandler,
  NodeLinkEnvelopeHandlerContext,
} from './node-link-client.js';
import type {
  RelayNodeEnvelope,
  RelayNodeCredential,
  RelayNodeError,
} from '../shared/relay-node-protocol.js';
import { isSessionLane, type SessionLane } from '../shared/session-lane.js';
import type { SessionSummary, TerminalBackend } from './types.js';

// Node-side RPC dispatcher. Hub initiates rpc/<type> requests over the
// reverse WS; this module receives them, calls into the local
// RelayNode, and sends back a `<type>.result` (or `<type>.error`)
// envelope on the same `requestId`.
//
// Wired today: `sessions.create` (#425.7), `sessions.list` (#465),
// `sessions.kill` (#478), read-only File RPC `fs.list` / `fs.stat` /
// `fs.read` / `fs.tail` (#505), and `fs.write` (#428).
// Other RPC types fall through to an INVALID_REQUEST response so
// misrouted envelopes don't silently hang the hub-side pending
// request.

export interface NodeLinkRpcHostOptions {
  localRelayNode: LocalRelayNode;
  rotateCredential?: (credential: RelayNodeCredential) => Promise<void> | void;
  localLogConfigPath?: string;
  localLogDir?: string | null;
  logger?: Logger;
}

export interface NodeLinkRpcHost {
  handle: NodeLinkChannelHandler;
  closeAllLogFollowers(): void;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function parseCredentialRotatePayload(
  raw: unknown
): RelayNodeCredential | RelayNodeError {
  const record = asRecord(raw);
  const credentialRecord = asRecord(record?.['credential']);
  if (!credentialRecord) {
    return invalidRequest('credential.rotate payload.credential must be an object');
  }
  const protocol = asString(credentialRecord['protocol']);
  const protocolVersion = asString(credentialRecord['protocolVersion']);
  const nodeId = asString(credentialRecord['nodeId']);
  const credentialId = asString(credentialRecord['credentialId']);
  const token = asString(credentialRecord['token']);
  const issuedAt = asString(credentialRecord['issuedAt']);
  if (!protocol || !protocolVersion || !nodeId || !credentialId || !token || !issuedAt) {
    return invalidRequest(
      'credential.rotate payload.credential requires protocol, protocolVersion, nodeId, credentialId, token, and issuedAt'
    );
  }
  return { protocol, protocolVersion, nodeId, credentialId, token, issuedAt } as RelayNodeCredential;
}

function asStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
    ? (value as string[])
    : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function parseTerminalBackend(value: unknown): TerminalBackend | undefined {
  if (value === 'relay-pty' || value === 'tmux-compat') return value;
  return undefined;
}

function parseTerminalBackendOverride(
  record: Record<string, unknown>
): Pick<SessionsCreateInput, 'terminalBackend'> | RelayNodeError {
  if (Object.prototype.hasOwnProperty.call(record, 'useTmux')) {
    return invalidRequest(
      'sessions.create payload.useTmux is no longer supported; use terminalBackend'
    );
  }
  if (Object.prototype.hasOwnProperty.call(record, 'terminalBackend')) {
    const terminalBackend = parseTerminalBackend(record['terminalBackend']);
    if (terminalBackend === undefined) {
      return invalidRequest(
        'sessions.create payload.terminalBackend must be "relay-pty" or "tmux-compat"'
      );
    }
    return { terminalBackend };
  }
  return {};
}

function asNullableString(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value === 'string') return value;
  return undefined;
}

function defaultTerminalCommand(): string {
  if (process.env.SHELL) return process.env.SHELL;
  return process.platform === 'win32' ? 'powershell.exe' : '/bin/sh';
}

function parseSessionCommand(
  record: Record<string, unknown>,
  type: SessionsCreateInput['type']
): string | undefined {
  if (type === 'agent') {
    // Routed native agent sessions must spawn the selected framework command
    // on the node. Do not let a hub/browser shell fallback sneak through as
    // `command` while metadata still says `type: agent` / `agent: codex`.
    return undefined;
  }
  return asString(record['command']) ?? defaultTerminalCommand();
}

function parseInitialControlMode(
  record: Record<string, unknown>,
  type: SessionsCreateInput['type']
): Pick<SessionsCreateInput, 'controlMode'> | RelayNodeError {
  const controlMode = asString(record['controlMode']);
  if (controlMode === undefined) return {};
  if (controlMode !== 'agent-driven' && controlMode !== 'human-driven') {
    return invalidRequest(
      'sessions.create payload.controlMode must be "agent-driven" or "human-driven" when set'
    );
  }
  if (controlMode === 'agent-driven' && type !== 'agent') {
    return invalidRequest(
      'sessions.create payload.controlMode="agent-driven" is only supported for agent sessions'
    );
  }
  return { controlMode };
}

interface SessionsCreateInput {
  id?: string;
  type: 'agent' | 'terminal';
  mode?: 'pty' | 'web';
  controlMode?: 'agent-driven' | 'human-driven';
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
  terminalBackend?: TerminalBackend;
  needsBranchRename?: boolean;
  branchRenamePrompt?: string;
  continue?: boolean;
  sessionLane?: SessionLane;
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
  const id = asString(record['id']);
  if (id !== undefined) input.id = id;
  if (modeRaw === 'pty' || modeRaw === 'web') input.mode = modeRaw;
  const initialControl = parseInitialControlMode(record, typeRaw);
  if ('code' in initialControl) return initialControl;
  if (initialControl.controlMode) input.controlMode = initialControl.controlMode;
  const agent = asString(record['agent']);
  if (agent !== undefined) input.agent = agent;
  const repoPath = asString(record['repoPath']);
  if (repoPath !== undefined) input.repoPath = repoPath;
  const worktreePath = asNullableString(record['worktreePath']);
  if (worktreePath !== undefined) input.worktreePath = worktreePath;
  // #474: routed creates from a remote browser often arrive without
  // cwd because the frontend create-tab modal still assumes the hub's
  // local repo state. Until #473's modal split lands, default to the
  // node host's home directory so spawn() never receives undefined.
  const cwd = asString(record['cwd']) ?? os.homedir();
  input.cwd = cwd;
  const command = parseSessionCommand(record, typeRaw);
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
  const terminalOverride = parseTerminalBackendOverride(record);
  if ('code' in terminalOverride) return terminalOverride;
  Object.assign(input, terminalOverride);
  const needsBranchRename = asBoolean(record['needsBranchRename']);
  if (needsBranchRename !== undefined)
    input.needsBranchRename = needsBranchRename;
  const branchRenamePrompt = asString(record['branchRenamePrompt']);
  if (branchRenamePrompt !== undefined)
    input.branchRenamePrompt = branchRenamePrompt;
  const continueFlag = asBoolean(record['continue']);
  if (continueFlag !== undefined) input.continue = continueFlag;
  const sessionLane = record['sessionLane'];
  if (sessionLane !== undefined) {
    if (!isSessionLane(sessionLane)) {
      return invalidRequest(
        'sessions.create payload.sessionLane must be local-repo, remote-cwd, or remote-home when set'
      );
    }
    input.sessionLane = sessionLane;
  }
  return input;
}

function invalidRequest(message: string): RelayNodeError {
  return { code: 'INVALID_REQUEST', message, retryable: false };
}

function internalError(message: string): RelayNodeError {
  return { code: 'INTERNAL', message, retryable: true };
}

function notFound(message: string): RelayNodeError {
  return { code: 'NOT_FOUND', message, retryable: false };
}

function parseSessionIdPayload(
  rpcName: string,
  raw: unknown
): string | RelayNodeError {
  const record = asRecord(raw);
  if (!record) {
    return invalidRequest(`${rpcName} payload must be an object`);
  }
  const id = asString(record['id']);
  if (!id) {
    return invalidRequest(`${rpcName} payload.id must be a non-empty string`);
  }
  return id;
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
      ...(envelope.streamId ? { streamId: envelope.streamId } : {}),
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
      ...(envelope.streamId ? { streamId: envelope.streamId } : {}),
      error,
    })
  );
}

export function createNodeLinkRpcHost(
  options: NodeLinkRpcHostOptions
): NodeLinkRpcHost {
  const logger = options.logger ?? createLogger('node-link-rpc');
  const { localRelayNode } = options;
  const defaultLogs = defaultNodeLogRuntime();
  const logConfigPath = options.localLogConfigPath ?? defaultLogs.configPath;
  const logDir = options.localLogDir ?? defaultLogs.serviceLogDir;
  const logFollowers = new Map<string, NodeLogFollower>();
  const fileFollowers = new Map<string, FileRpcFollower>();

  function closeLogFollower(streamId: string): void {
    const follower = logFollowers.get(streamId);
    if (!follower) return;
    logFollowers.delete(streamId);
    follower.close();
  }

  function closeFileFollower(streamId: string): void {
    const follower = fileFollowers.get(streamId);
    if (!follower) return;
    fileFollowers.delete(streamId);
    follower.close();
  }

  function closeAllLogFollowers(): void {
    for (const streamId of Array.from(logFollowers.keys())) closeLogFollower(streamId);
    for (const streamId of Array.from(fileFollowers.keys())) closeFileFollower(streamId);
  }

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
        sendErrorEnvelope(
          ctx,
          envelope,
          invalidRequest('remote node web sessions are not supported')
        );
        return;
      }
      const { controlMode, ...createInput } = parsed;
      const sessionId = createInput.id ?? crypto.randomBytes(8).toString('hex');
      createInput.id = sessionId;
      const effectiveControlMode =
        controlMode ?? (createInput.type === 'agent' ? 'agent-driven' : 'human-driven');
      (createInput as CreateParams).controlState =
        effectiveControlMode === 'agent-driven'
          ? createAgentDrivenInitialControlState({
              workerId: sessionId,
              ...(createInput.displayName ? { displayName: createInput.displayName } : {}),
            })
          : createHumanDrivenInitialControlState({
              sessionId,
              ...(createInput.displayName ? { displayName: createInput.displayName } : {}),
            });
      const result = localRelayNode.sessions.create(createInput as CreateParams);
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

  function handleSessionsKill(
    envelope: RelayNodeEnvelope,
    ctx: NodeLinkEnvelopeHandlerContext
  ): void {
    const id = parseSessionIdPayload('sessions.kill', envelope.payload);
    if (typeof id !== 'string') {
      sendErrorEnvelope(ctx, envelope, id);
      return;
    }
    try {
      localRelayNode.sessions.kill(id);
      sendResultEnvelope(ctx, envelope, { ok: true });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error ?? 'unknown');
      logger.error(`sessions.kill failed: ${message}`);
      sendErrorEnvelope(
        ctx,
        envelope,
        message.toLowerCase().includes('not found')
          ? notFound(message)
          : internalError(message)
      );
    }
  }

  async function handleFileRpc(
    operation: 'list' | 'stat' | 'read' | 'tail' | 'write',
    envelope: RelayNodeEnvelope,
    ctx: NodeLinkEnvelopeHandlerContext
  ): Promise<void> {
    try {
      const result = await executeLocalFileRpc(operation, envelope.payload);
      if ('code' in result) {
        sendErrorEnvelope(ctx, envelope, result);
        return;
      }
      if (operation === 'tail' && (result as FileRpcTailResponse).follow) {
        if (!envelope.streamId) {
          sendErrorEnvelope(
            ctx,
            envelope,
            invalidRequest('fs.tail follow requires envelope.streamId')
          );
          return;
        }
        const streamId = envelope.streamId;
        closeFileFollower(streamId);
        sendResultEnvelope(ctx, envelope, result);
        const tailResult = result as FileRpcTailResponse;
        const follower = createFileRpcFollower({
          request: {
            path: tailResult.path,
            maxFollowChunkBytes: tailResult.maxFollowChunkBytes,
          },
          startOffset: tailResult.endOffset,
          write: (chunk) => sendStreamEnvelopeWithBackpressure(ctx, envelope, 'fs.tail.chunk', chunk),
          onError: (error) => {
            logger.warn(`fs.tail follow failed: ${error.message}`);
            sendStreamEnvelope(ctx, envelope, 'fs.tail.error', {
              error,
            });
            closeFileFollower(streamId);
          },
        });
        fileFollowers.set(streamId, follower);
        return;
      }
      sendResultEnvelope(ctx, envelope, result);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error ?? 'unknown');
      logger.error(`fs.${operation} failed: ${message}`);
      sendErrorEnvelope(ctx, envelope, internalError(message));
    }
  }

  function sendStreamEnvelope(
    ctx: NodeLinkEnvelopeHandlerContext,
    envelope: RelayNodeEnvelope,
    type: string,
    payload?: unknown
  ): void {
    ctx.send(
      ctx.buildEnvelope('rpc', type, {
        ...(envelope.requestId ? { requestId: envelope.requestId } : {}),
        ...(envelope.streamId ? { streamId: envelope.streamId } : {}),
        ...(payload !== undefined ? { payload } : {}),
      })
    );
  }

  async function sendStreamEnvelopeWithBackpressure(
    ctx: NodeLinkEnvelopeHandlerContext,
    envelope: RelayNodeEnvelope,
    type: string,
    payload?: unknown
  ): Promise<void> {
    const next = ctx.buildEnvelope('rpc', type, {
      ...(envelope.requestId ? { requestId: envelope.requestId } : {}),
      ...(envelope.streamId ? { streamId: envelope.streamId } : {}),
      ...(payload !== undefined ? { payload } : {}),
    });
    if (ctx.sendWithBackpressure) {
      await ctx.sendWithBackpressure(next);
      return;
    }
    ctx.send(next);
  }

  function handleLogsTail(
    envelope: RelayNodeEnvelope,
    ctx: NodeLinkEnvelopeHandlerContext
  ): void {
    const parsed = parseNodeLogTailRequest(envelope.payload);
    if ('code' in parsed) {
      sendErrorEnvelope(ctx, envelope, parsed);
      return;
    }
    if (parsed.follow && !envelope.streamId) {
      sendErrorEnvelope(
        ctx,
        envelope,
        invalidRequest('logs.tail follow requires envelope.streamId')
      );
      return;
    }
    // If any structured filter field is set, automatically read the JSONL
    // stream instead of plaintext — otherwise the filter would silently
    // no-op and `logs.tail.result` would return raw `output` rather than
    // the `events[]` shape documented in `docs/cli-schema/logs.md`.
    // Surfaced by Copilot on PR #607.
    const hasFilter =
      parsed.level !== undefined ||
      parsed.subsystem !== undefined ||
      parsed.sinceTs !== undefined;
    const filter: LogEventFilter | undefined = hasFilter
      ? {
          ...(parsed.level !== undefined ? { level: parsed.level } : {}),
          ...(parsed.subsystem !== undefined ? { subsystem: parsed.subsystem } : {}),
          ...(parsed.sinceTs !== undefined ? { sinceTs: parsed.sinceTs } : {}),
        }
      : undefined;
    const snapshot = readNodeLogTailSnapshot({
      configPath: logConfigPath,
      serviceLogDir: logDir,
      lines: parsed.lines,
      ...(hasFilter ? { structured: true } : {}),
      ...(filter ? { filter } : {}),
    });
    if ('code' in snapshot) {
      sendErrorEnvelope(ctx, envelope, snapshot);
      return;
    }
    sendResultEnvelope(ctx, envelope, snapshot);
    if (!parsed.follow) return;
    const streamId = envelope.streamId;
    if (!streamId) {
      sendErrorEnvelope(
        ctx,
        envelope,
        invalidRequest('logs.tail follow requires envelope.streamId')
      );
      return;
    }
    closeLogFollower(streamId);
    const follower = createNodeLogFollower({
      configPath: logConfigPath,
      serviceLogDir: logDir,
      write: (chunk) => sendStreamEnvelope(ctx, envelope, 'logs.tail.chunk', { chunk }),
      onError: (error) => {
        logger.warn(`logs.tail follow failed: ${error.message}`);
        sendStreamEnvelope(ctx, envelope, 'logs.tail.error', {
          error: internalError(error.message),
        });
      },
    });
    logFollowers.set(streamId, follower);
  }

  function handleLogsTailCancel(envelope: RelayNodeEnvelope): void {
    if (envelope.streamId) closeLogFollower(envelope.streamId);
  }

  async function handleCredentialRotate(
    envelope: RelayNodeEnvelope,
    ctx: NodeLinkEnvelopeHandlerContext
  ): Promise<void> {
    const credential = parseCredentialRotatePayload(envelope.payload);
    if ('code' in credential) {
      sendErrorEnvelope(ctx, envelope, credential);
      return;
    }
    if (!options.rotateCredential) {
      sendErrorEnvelope(
        ctx,
        envelope,
        invalidRequest('credential.rotate is not configured on this node')
      );
      return;
    }
    try {
      await options.rotateCredential(credential);
      sendResultEnvelope(ctx, envelope, {
        ok: true,
        nodeId: credential.nodeId,
        credentialId: credential.credentialId,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error ?? 'unknown');
      logger.error(`credential.rotate failed: ${message}`);
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
    if (envelope.type === 'sessions.kill') {
      handleSessionsKill(envelope, ctx);
      return;
    }
    if (envelope.type === 'credential.rotate') {
      void handleCredentialRotate(envelope, ctx);
      return;
    }
    if (envelope.type === 'logs.tail') {
      handleLogsTail(envelope, ctx);
      return;
    }
    if (envelope.type === 'logs.tail.cancel') {
      handleLogsTailCancel(envelope);
      return;
    }
    if (envelope.type === 'fs.tail.cancel') {
      if (envelope.streamId) closeFileFollower(envelope.streamId);
      return;
    }
    const fsMatch = envelope.type.match(/^fs\.(.+)$/);
    if (fsMatch && isFileRpcOperation(fsMatch[1])) {
      void handleFileRpc(fsMatch[1], envelope, ctx);
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

  return { handle, closeAllLogFollowers };
}
