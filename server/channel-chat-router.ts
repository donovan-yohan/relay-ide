import { existsSync } from 'node:fs';

import { Router } from 'express';
import type { Request, RequestHandler, Response } from 'express';
import multer from 'multer';

import type { RelayCliGatewayErrorCode } from '../shared/cli-gateway-contract.js';
import { isDmChannel } from '../shared/dm-channels.js';
import {
  authenticatedCliGatewayActorCredential,
  type CliGatewayActorReadCommand,
  type CliGatewayActorWriteCommand,
} from './cli-gateway-actor-auth.js';
import {
  CHANNEL_HISTORY_DEFAULT_LIMIT,
  CHANNEL_HISTORY_MAX_LIMIT,
  ChannelMessageStoreError,
  ChannelSearchRefusedError,
  channelSearchUnavailableReason,
  type ChannelHistoryFilter,
  type ChannelMessageStore,
} from './channel-message-store.js';
import type { ChannelHub } from './channel-hub.js';
import {
  CHANNEL_IMAGE_MAX_BYTES,
  CHANNEL_IMAGE_MAX_PER_MESSAGE,
  ChannelAttachmentStoreError,
  type ChannelAttachmentStore,
} from './channel-attachments.js';
import {
  ChannelAgentBusyError,
  ChannelAgentReleaseRefusedError,
  ChannelAgentNoActiveTurnError,
  ChannelAgentCommandError,
  ChannelAgentNotFoundError,
  ChannelAgentRoleConflictError,
  ChannelMessageNotRetryableError,
  type ChannelAgentBinder,
} from './channel-agent-binder.js';
import type { WorkspaceTopicStore } from './workspace-topics.js';
import type { WorkspaceTopic } from '../shared/workspace-topics.js';
import type { AgentApprovalDecisionV2 } from '../shared/agent-chat-protocol-v2.js';
import {
  CHANNEL_POST_STEERING_VALUES,
  CHANNEL_READ_STATE_EVENT,
  CHANNEL_SEARCH_MAX_RESULTS,
  CHANNEL_SEARCH_QUERY_MAX_CHARS,
  isChannelPostSteering,
  parseMentions,
  type ChannelBodyFormat,
  type ChannelPostSteering,
  type ChannelMessage,
  type ChannelMessageSearchResponse,
  type ChannelMessageSearchResult,
  type ChannelReadStateResponse,
  type ChannelReadStateUpdateResponse,
  type ChannelSenderRef,
} from '../shared/channel-chat-protocol.js';

const CONTEXT_READ = 'context:read';
const CONTEXT_WRITE = 'context:write';

const DEFAULT_KNOWN_PROVIDER_IDS = [
  'claude',
  'codex',
  'opencode',
  'hermes',
  'prime-agent',
  'pi',
];

/**
 * Byte budget for one REST history response. Rows are row-bounded (max 200) but
 * each body is capped at 256KB, so an unbudgeted page could reach ~51MB. We stop
 * at the budget and return a `nextCursor` so the client fetches the rest in pages.
 */
const DEFAULT_HISTORY_MAX_BYTES = 4 * 1024 * 1024;

/**
 * Trim a history page to the byte budget. `forward` (afterSeq) keeps the
 * oldest-first rows and continues via `afterSeq`; `backward` (default/beforeSeq)
 * keeps the newest rows and continues via `beforeSeq`. Always keeps ≥1 row.
 */
function budgetHistoryRows(
  messages: ChannelMessage[],
  direction: 'forward' | 'backward',
  maxBytes: number
): {
  rows: ChannelMessage[];
  hasMore: boolean;
  nextCursor?: Record<string, number>;
} {
  if (messages.length === 0) return { rows: [], hasMore: false };
  const order = direction === 'backward' ? [...messages].reverse() : messages;
  const kept: ChannelMessage[] = [];
  let bytes = 0;
  let truncated = false;
  for (const message of order) {
    const size = Buffer.byteLength(JSON.stringify(message), 'utf8') + 1;
    if (kept.length > 0 && bytes + size > maxBytes) {
      truncated = true;
      break;
    }
    bytes += size;
    kept.push(message);
  }
  if (direction === 'backward') kept.reverse();
  if (!truncated) return { rows: kept, hasMore: false };
  const nextCursor =
    direction === 'forward'
      ? { afterSeq: kept[kept.length - 1]!.seq }
      : { beforeSeq: kept[0]!.seq };
  return { rows: kept, hasMore: true, nextCursor };
}

/** Apply a public row limit plus the existing byte budget to a lookahead page. */
function budgetHistoryPage(
  messages: ChannelMessage[],
  direction: 'forward' | 'backward',
  limit: number,
  maxBytes: number
): {
  rows: ChannelMessage[];
  hasMore: boolean;
  nextCursor?: Record<string, number>;
} {
  const rowTruncated = messages.length > limit;
  const rowPage = rowTruncated
    ? direction === 'forward'
      ? messages.slice(0, limit)
      : messages.slice(messages.length - limit)
    : messages;
  const budgeted = budgetHistoryRows(rowPage, direction, maxBytes);
  if (budgeted.hasMore || !rowTruncated) return budgeted;
  const nextCursor =
    direction === 'forward'
      ? { afterSeq: budgeted.rows[budgeted.rows.length - 1]!.seq }
      : { beforeSeq: budgeted.rows[0]!.seq };
  return { ...budgeted, hasMore: true, nextCursor };
}

export interface ChannelChatRouterDeps {
  store: ChannelMessageStore | null;
  attachmentStore?: ChannelAttachmentStore | null;
  hub: ChannelHub;
  topicStore: WorkspaceTopicStore | null;
  /** @-mention routing binder (#1167); roster/interrupt/approval routes 503 without it. */
  binder?: ChannelAgentBinder | null;
  /** framework ids for @-mention resolution (v2 adapter registry + topic default). */
  knownProviderIds?: readonly string[];
  /** Private channel-runtime lookup used to authenticate source attribution. */
  getRuntime?: (runtimeId: string) =>
    | {
        profileActorId: string;
        providerId: string;
        role?: string;
        status?: string;
      }
    | undefined;
  /** byte budget for one history response body (defaults to 4MB). */
  historyMaxBytes?: number;
  /**
   * Global `/ws/events` fan-out (#1308 slice 3). Optional: without it read-state
   * writes still persist and every device converges on its next boot seed — the
   * broadcast only removes the wait.
   */
  broadcastEvent?: (type: string, data?: Record<string, unknown>) => void;
  requireAuth?: RequestHandler;
  requireReadActorAuth?: (
    command: CliGatewayActorReadCommand,
    options?: {
      scopeForRequest?: (
        req: Request
      ) => { workContextIds?: string[]; channelIds?: string[] } | undefined;
    }
  ) => RequestHandler;
  requireWriteActorAuth?: (
    command: CliGatewayActorWriteCommand,
    options?: {
      scopeForRequest?: (
        req: Request
      ) => { workContextIds?: string[]; channelIds?: string[] } | undefined;
    }
  ) => RequestHandler;
}

type PersistedChannelGuard = (
  req: Request,
  res: Response
) => WorkspaceTopic | null;

interface GatewayErrorBody {
  error: {
    code: RelayCliGatewayErrorCode;
    message: string;
    retryable: boolean;
    details?: Record<string, unknown>;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function bodyRecord(req: Request): Record<string, unknown> {
  return isRecord(req.body) ? req.body : {};
}

/**
 * Channel-scope enforcement at the ROUTE level (defense in depth alongside the
 * actor-auth middleware). A scoped actor credential's `channelIds` are the ONLY
 * channels it may enumerate/read/write. Browser-authenticated (non-actor)
 * requests have no `channelIds` scope and keep their existing authority.
 */
function actorChannelIds(req: Request): readonly string[] | undefined {
  const credential = authenticatedCliGatewayActorCredential(req);
  return credential?.scope?.channelIds;
}

/** Deny (403) when a scoped actor targets a channel outside its channel scope. */
function denyOutOfScopeChannel(
  req: Request,
  res: Response,
  channelId: string
): boolean {
  const credential = authenticatedCliGatewayActorCredential(req);
  if (!credential) return false; // browser/operator lane: existing authority
  if (credential.scope?.channelIds?.includes(channelId)) return false;
  sendGatewayError(
    res,
    'FORBIDDEN',
    'actor is not scoped to this channel',
    false,
    { channelId, reasonCode: 'CHANNEL_OUT_OF_SCOPE' }
  );
  return true;
}

/** Narrow a list of channel summaries to the actor's channel scope (if any). */
function filterChannelListToScope(
  req: Request,
  channels: Record<string, unknown>[]
): Record<string, unknown>[] {
  const allowed = actorChannelIds(req);
  if (!allowed) return channels;
  const allowedSet = new Set(allowed);
  return channels.filter(
    (channel) =>
      typeof channel['id'] === 'string' && allowedSet.has(channel['id'])
  );
}

/**
 * Fail-closed channel read guard for the scope-less channel verbs (`channels.list`
 * and global `channels/search`): a scoped actor credential that names NO channels
 * must not enumerate or read every channel. Browser/operator (non-actor) requests
 * carry no actor `channelIds` scope and keep their existing authority.
 */
function denyChannelReadWithoutScope(req: Request, res: Response): boolean {
  const credential = authenticatedCliGatewayActorCredential(req);
  if (!credential) return false; // browser/operator lane: existing authority
  const allowed = credential.scope?.channelIds;
  if (allowed && allowed.length > 0) return false;
  sendGatewayError(
    res,
    'FORBIDDEN',
    'actor credential has no channel scope; cannot enumerate or search channels',
    false,
    { reasonCode: 'CHANNEL_SCOPE_REQUIRED' }
  );
  return true;
}

/** Private browser/operator REST surfaces are never part of the actor lane. */
function denyScopedActorPrivateRoute(req: Request, res: Response): boolean {
  if (!authenticatedCliGatewayActorCredential(req)) return false;
  sendGatewayError(
    res,
    'FORBIDDEN',
    'scoped actors cannot access this private channel route',
    false,
    { reasonCode: 'CHANNEL_PRIVATE_ROUTE_ACTOR_FORBIDDEN' }
  );
  return true;
}

function parseCapabilityHeader(value: string | undefined): Set<string> {
  if (!value) return new Set();
  return new Set(
    value
      .split(/[\s,]+/)
      .map((entry) => entry.trim())
      .filter(Boolean)
  );
}

function statusForCode(code: RelayCliGatewayErrorCode): number {
  switch (code) {
    case 'UNAUTHORIZED':
      return 401;
    case 'FORBIDDEN':
      return 403;
    case 'NOT_FOUND':
      return 404;
    case 'SESSION_CONFLICT':
      return 409;
    case 'SERVER_UNAVAILABLE':
      return 503;
    case 'INTERNAL':
      return 500;
    default:
      return 400;
  }
}

function sendGatewayError(
  res: Response,
  code: RelayCliGatewayErrorCode,
  message: string,
  retryable = false,
  details?: Record<string, unknown>,
  statusOverride?: number
): void {
  const body: GatewayErrorBody = {
    error: { code, message, retryable, ...(details ? { details } : {}) },
  };
  res.status(statusOverride ?? statusForCode(code)).json(body);
}

function denyMissingCapability(
  req: Request,
  res: Response,
  required: readonly string[]
): boolean {
  const provided = parseCapabilityHeader(req.header('x-relay-capabilities'));
  const actorCredential = authenticatedCliGatewayActorCredential(req);
  for (const capability of actorCredential?.capabilities ?? []) {
    provided.add(capability);
  }
  const missing = required.filter((capability) => !provided.has(capability));
  if (missing.length === 0) return false;
  sendGatewayError(
    res,
    'FORBIDDEN',
    `missing required capability: ${missing[0]}`,
    false,
    {
      capability: missing[0],
      missingCapabilities: missing,
    }
  );
  return true;
}

/**
 * Reject anything that is not the browser operator lane (#1308 slice 3).
 *
 * `requireCliGatewayAuth` admits scoped ACTOR credentials, so "authenticated"
 * and "the operator" are different questions on these routes. Read state is the
 * operator's private reading position on their own devices; an agent must be
 * able to neither observe it nor move it.
 */
function denyNonOperator(
  req: Request,
  res: Response,
  verb: 'read' | 'mark'
): boolean {
  if (deriveSender(req, undefined).kind === 'human') return false;
  sendGatewayError(
    res,
    'FORBIDDEN',
    `only the operator can ${verb} channel read state`,
    false,
    { reasonCode: 'CHANNEL_READ_STATE_HUMAN_ONLY' }
  );
  return true;
}

function storeOr503(
  res: Response,
  store: ChannelMessageStore | null
): ChannelMessageStore | null {
  if (store) return store;
  sendGatewayError(
    res,
    'SERVER_UNAVAILABLE',
    'channel store unavailable',
    true,
    {
      reasonCode: 'CHANNEL_STORE_UNAVAILABLE',
    }
  );
  return null;
}

function attachmentStoreOr503(
  res: Response,
  store: ChannelAttachmentStore | null | undefined
): ChannelAttachmentStore | null {
  if (store) return store;
  sendGatewayError(
    res,
    'SERVER_UNAVAILABLE',
    'channel attachment store unavailable',
    true,
    { reasonCode: 'CHANNEL_ATTACHMENT_STORE_UNAVAILABLE' }
  );
  return null;
}

function topicStoreOr503(
  res: Response,
  topicStore: WorkspaceTopicStore | null
): WorkspaceTopicStore | null {
  if (topicStore) return topicStore;
  sendGatewayError(
    res,
    'SERVER_UNAVAILABLE',
    'workspace topic store unavailable',
    true,
    {
      reasonCode: 'WORKSPACE_TOPICS_UNAVAILABLE',
    }
  );
  return null;
}

function binderOr503(
  res: Response,
  binder: ChannelAgentBinder | null | undefined
): ChannelAgentBinder | null {
  if (binder) return binder;
  sendGatewayError(
    res,
    'SERVER_UNAVAILABLE',
    'channel agent binder unavailable',
    true,
    {
      reasonCode: 'CHANNEL_BINDER_UNAVAILABLE',
    }
  );
  return null;
}

/**
 * Server-derived sender attribution from the authenticated lane — NEVER from the
 * request body ([MF]: attribution is the core product promise). Browser cookie
 * session → human operator; CLI-gateway actor credential → agent:<actor id>.
 */
function deriveSender(
  req: Request,
  runtime: { profileActorId: string; providerId: string } | undefined
): ChannelSenderRef {
  const credential = authenticatedCliGatewayActorCredential(req);
  if (credential) {
    const isPersistentOrchestrator =
      credential.metadata?.reason === 'persistent-orchestrator';
    return {
      kind: 'agent',
      id: isPersistentOrchestrator
        ? credential.actor.id
        : `agent:${credential.actor.id}`,
      providerId: runtime?.providerId ?? credential.actor.id,
      ...(credential.actor.displayName
        ? { displayName: credential.actor.displayName }
        : {}),
    };
  }
  return { kind: 'human', id: 'human:operator', displayName: 'Operator' };
}

/**
 * Persistent-orchestrator credentials bind their stable profile Actor id to
 * the private runtime id carried in credential scope. Other actor credentials
 * stay unattributed and therefore remain subject to the ordinary agent brake.
 */
export function authenticatedSourceRuntimeId(
  credential: ReturnType<typeof authenticatedCliGatewayActorCredential>,
  getRuntime: ChannelChatRouterDeps['getRuntime']
): string | undefined {
  if (credential?.metadata?.reason !== 'persistent-orchestrator') {
    return undefined;
  }
  const runtimeId = credential.scope.sessionIds?.[0];
  if (!runtimeId) return undefined;
  const runtime = getRuntime?.(runtimeId);
  return runtime?.role === 'orchestrator' &&
    runtime.status === 'active' &&
    runtime.profileActorId === credential.actor.id
    ? runtimeId
    : undefined;
}

function mapStoreError(res: Response, error: unknown): void {
  if (error instanceof ChannelAttachmentStoreError) {
    const code: RelayCliGatewayErrorCode =
      error.status === 404 ? 'NOT_FOUND' : 'INVALID_ARGUMENT';
    sendGatewayError(
      res,
      code,
      error.message,
      false,
      { reasonCode: error.code.toUpperCase(), ...(error.details ?? {}) },
      error.status
    );
    return;
  }
  if (error instanceof ChannelMessageStoreError) {
    if (error.status === 413) {
      sendGatewayError(
        res,
        'INVALID_ARGUMENT',
        error.message,
        false,
        { reasonCode: error.code.toUpperCase(), ...(error.details ?? {}) },
        413
      );
      return;
    }
    const code: RelayCliGatewayErrorCode =
      error.status === 404
        ? 'NOT_FOUND'
        : error.status === 409
          ? 'SESSION_CONFLICT'
          : error.status >= 500
            ? 'INTERNAL'
            : 'INVALID_ARGUMENT';
    sendGatewayError(res, code, error.message, false, {
      reasonCode: error.code.toUpperCase(),
      ...(error.details ?? {}),
    });
    return;
  }
  sendGatewayError(
    res,
    'INTERNAL',
    error instanceof Error ? error.message : String(error),
    false
  );
}

/**
 * Dedicated provider-control lane. It neither persists a channel row nor
 * passes through mention context-packet construction.
 */
function createAgentCommandsHandler(
  deps: ChannelChatRouterDeps,
  requirePersistedChannel: PersistedChannelGuard
): RequestHandler {
  return (req, res) => {
    if (denyMissingCapability(req, res, [CONTEXT_WRITE])) return;
    const topic = requirePersistedChannel(req, res);
    if (!topic) return;
    if (topic.status === 'archived') {
      sendGatewayError(res, 'SESSION_CONFLICT', 'channel is archived', false, {
        channelId: topic.id,
        reasonCode: 'CHANNEL_ARCHIVED',
      });
      return;
    }
    const binder = binderOr503(res, deps.binder);
    if (!binder) return;
    const body = req.body as Record<string, unknown>;
    const profileId =
      typeof body['profileId'] === 'string' ? body['profileId'] : '';
    const command = typeof body['command'] === 'string' ? body['command'] : '';
    const args = typeof body['args'] === 'string' ? body['args'] : undefined;
    const confirmed = body['confirmed'] === true;
    if (!profileId || !command) {
      sendGatewayError(
        res,
        'INVALID_ARGUMENT',
        'profileId and command are required',
        false
      );
      return;
    }
    binder
      .executeCommand(topic.id, profileId, command, args, confirmed)
      .then((result) => res.json({ ok: true, ...result }))
      .catch((error) => {
        if (error instanceof ChannelAgentCommandError) {
          sendGatewayError(res, 'INVALID_ARGUMENT', error.message, false, {
            profileId,
            command,
            reasonCode: error.reasonCode,
          });
          return;
        }
        mapStoreError(res, error);
      });
  };
}

function rejectChannelControlMessage(
  res: Response,
  binder: ChannelAgentBinder | null | undefined,
  text: string
): boolean {
  if (!binder?.isControlMessage?.(text)) return false;
  sendGatewayError(
    res,
    'INVALID_ARGUMENT',
    'agent commands must use the channel agent-commands control endpoint',
    false,
    { reasonCode: 'CHANNEL_COMMAND_REQUIRES_CONTROL_LANE' }
  );
  return true;
}

function rejectEmptyChannelPost(
  res: Response,
  text: string,
  parts: readonly unknown[]
): boolean {
  if (text.length > 0 || parts.length > 0) return false;
  sendGatewayError(
    res,
    'INVALID_ARGUMENT',
    'text or at least one image part is required',
    false,
    { fields: ['text', 'parts'] }
  );
  return true;
}

/**
 * The browser post surface intentionally accepts a few legacy conveniences
 * (attachments and steering included). A scoped actor is a stable gateway
 * caller, though, so its request body must be the exact public command shape
 * before this route learns whether a channel exists or touches the transcript.
 */
function rejectInvalidActorChannelPostBody(
  req: Request,
  res: Response
): boolean {
  if (!authenticatedCliGatewayActorCredential(req)) return false;
  if (!isRecord(req.body)) {
    sendGatewayError(
      res,
      'INVALID_ARGUMENT',
      'channels.post body must be an object',
      false,
      { reasonCode: 'CHANNEL_ACTOR_POST_BODY_INVALID' }
    );
    return true;
  }
  const body = req.body;
  // These have dedicated actor denials rather than falling through to an
  // unknown-field error. They are real browser features, but never actor
  // authority.
  if ('parts' in body) {
    sendGatewayError(
      res,
      'FORBIDDEN',
      'scoped actors cannot author attachment or image parts',
      false,
      { field: 'parts', reasonCode: 'CHANNEL_ACTOR_ATTACHMENT_PARTS_FORBIDDEN' }
    );
    return true;
  }
  if ('steering' in body) {
    sendGatewayError(
      res,
      'FORBIDDEN',
      'scoped actors cannot steer private agent runtime turns',
      false,
      { field: 'steering', reasonCode: 'CHANNEL_ACTOR_STEERING_FORBIDDEN' }
    );
    return true;
  }
  const allowed = new Set([
    'text',
    'format',
    'parentMessageId',
    'threadId',
    'clientMessageId',
  ]);
  const undeclared = Object.keys(body).find((field) => !allowed.has(field));
  if (undeclared) {
    sendGatewayError(
      res,
      'INVALID_ARGUMENT',
      `${undeclared} is not declared for channels.post`,
      false,
      { field: undeclared, reasonCode: 'CHANNEL_ACTOR_POST_UNDECLARED' }
    );
    return true;
  }
  if (typeof body['text'] !== 'string' || body['text'].trim().length === 0) {
    sendGatewayError(
      res,
      'INVALID_ARGUMENT',
      'text must be a non-empty string',
      false,
      { field: 'text', reasonCode: 'CHANNEL_ACTOR_POST_TEXT_INVALID' }
    );
    return true;
  }
  if (
    body['format'] !== undefined &&
    body['format'] !== 'text' &&
    body['format'] !== 'markdown'
  ) {
    sendGatewayError(
      res,
      'INVALID_ARGUMENT',
      'format must be text or markdown',
      false,
      { field: 'format', reasonCode: 'CHANNEL_ACTOR_POST_FORMAT_INVALID' }
    );
    return true;
  }
  for (const field of ['parentMessageId', 'clientMessageId'] as const) {
    if (
      body[field] !== undefined &&
      (typeof body[field] !== 'string' || body[field].length === 0)
    ) {
      sendGatewayError(
        res,
        'INVALID_ARGUMENT',
        `${field} must be a non-empty string`,
        false,
        { field, reasonCode: 'CHANNEL_ACTOR_POST_ALIAS_INVALID' }
      );
      return true;
    }
  }
  if (
    body['threadId'] !== undefined &&
    body['threadId'] !== null &&
    (typeof body['threadId'] !== 'string' || body['threadId'].length === 0)
  ) {
    sendGatewayError(
      res,
      'INVALID_ARGUMENT',
      'threadId must be a non-empty string or null',
      false,
      { field: 'threadId', reasonCode: 'CHANNEL_ACTOR_POST_ALIAS_INVALID' }
    );
    return true;
  }
  return false;
}

function parseSeqQuery(value: unknown): number | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== 'string' || !raw.trim()) return undefined;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function parseHistoryLimit(value: unknown): number {
  const parsed = parseSeqQuery(value);
  if (parsed === undefined) return CHANNEL_HISTORY_DEFAULT_LIMIT;
  return Math.max(1, Math.min(CHANNEL_HISTORY_MAX_LIMIT, parsed));
}

function rejectInvalidActorPagination(
  req: Request,
  res: Response,
  fields: readonly string[]
): boolean {
  if (!authenticatedCliGatewayActorCredential(req)) return false;
  const allowed = new Set(fields);
  const undeclared = Object.keys(req.query).find(
    (field) => !allowed.has(field)
  );
  if (undeclared) {
    sendGatewayError(
      res,
      'INVALID_ARGUMENT',
      `${undeclared} is not declared for this stable actor command`,
      false,
      { field: undeclared, reasonCode: 'CHANNEL_QUERY_UNDECLARED' }
    );
    return true;
  }
  for (const field of fields) {
    const value = req.query[field];
    if (value === undefined) continue;
    const parsed = parseSeqQuery(value);
    if (
      Array.isArray(value) ||
      parsed === undefined ||
      (field === 'limit' && (parsed < 1 || parsed > CHANNEL_HISTORY_MAX_LIMIT))
    ) {
      sendGatewayError(
        res,
        'INVALID_ARGUMENT',
        `${field} must be a non-negative safe integer${field === 'limit' ? ' greater than zero' : ''}`,
        false,
        { field, reasonCode: 'CHANNEL_PAGINATION_INVALID' }
      );
      return true;
    }
  }
  if (
    req.query['beforeSeq'] !== undefined &&
    req.query['afterSeq'] !== undefined
  ) {
    sendGatewayError(
      res,
      'INVALID_ARGUMENT',
      'beforeSeq and afterSeq cannot be used together',
      false,
      {
        fields: ['beforeSeq', 'afterSeq'],
        reasonCode: 'CHANNEL_PAGINATION_DIRECTION_CONFLICT',
      }
    );
    return true;
  }
  return false;
}

function parseStringQuery(value: unknown): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
}

/** Same truthiness the `/workspace-topics` search route uses for its flags. */
function parseBooleanQuery(value: unknown): boolean {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw === 'true' || raw === '1';
}

function parseSearchLimit(value: unknown): number {
  const parsed = parseSeqQuery(value);
  if (parsed === undefined) return CHANNEL_SEARCH_MAX_RESULTS;
  return Math.max(1, Math.min(CHANNEL_SEARCH_MAX_RESULTS, parsed));
}

function channelSummaryView(
  store: ChannelMessageStore,
  topic: WorkspaceTopic
): Record<string, unknown> {
  const summary = store.getChannelSummary(topic.id);
  // #1287 slice 5 item 18: thread rows ride the SAME response the rail already
  // fetches. Threads were fully implemented server-side but reachable only from
  // the in-timeline "N replies" chip, so a live thread was invisible until the
  // channel was already open. Extension, not a new route (slice 3 pattern).
  //
  // A channel with no messages cannot hold a thread, so it skips the aggregate
  // outright: the GROUP BY costs a temp b-tree and a `json_extract` per threaded
  // row on top of the summary's plain COUNT(*), and `GET /channels` pays it per
  // channel on a list the rail refetches on every agent-turn window.
  const threads =
    summary && summary.messageCount > 0
      ? store.listChannelThreadSummaries(topic.id)
      : { threads: [], threadCount: 0 };
  return {
    id: topic.id,
    title: topic.display.title,
    ...(topic.display.kind ? { kind: topic.display.kind } : {}),
    visibility: topic.visibility,
    archived: topic.status === 'archived',
    latestSeq: summary?.latestSeq ?? 0,
    messageCount: summary?.messageCount ?? 0,
    lastMessage: summary?.lastMessage ?? null,
    members: store.listMembers(topic.id),
    threads: threads.threads,
    threadCount: threads.threadCount,
  };
}

/**
 * The ONLY channel write path. Persist → auto-enroll the sender as a member →
 * broadcast `channel-message-created-v1` (which also emits the sidebar badge and
 * fires the `onMessagePosted` hook #1167 subscribes to).
 */
function postToChannel(
  store: ChannelMessageStore,
  hub: ChannelHub,
  input: {
    channelId: string;
    sender: ChannelSenderRef;
    sourceRuntimeId?: string;
    text: string;
    format?: ChannelBodyFormat;
    parentMessageId?: string;
    clientMessageId?: string;
    mentions: ReturnType<typeof parseMentions>;
    parts?: import('../shared/channel-chat-protocol.js').ChannelMessagePart[];
    /**
     * Explicit mid-turn steering intent (#1308 slice 4). Never persisted on the
     * row — it governs how the binder TRIGGERS a turn for this post, not what
     * the durable transcript says. Replaying history therefore cannot re-issue
     * an interrupt.
     */
    steering?: ChannelPostSteering;
  }
): ChannelMessage {
  const message = store.appendComplete({
    channelId: input.channelId,
    sender: input.sender,
    text: input.text,
    ...(input.format ? { format: input.format } : {}),
    ...(input.parentMessageId
      ? { parentMessageId: input.parentMessageId }
      : {}),
    ...(input.clientMessageId
      ? { clientMessageId: input.clientMessageId }
      : {}),
    ...(input.mentions.length ? { mentions: input.mentions } : {}),
    ...(input.parts?.length ? { parts: input.parts } : {}),
    ...(input.sourceRuntimeId
      ? { source: { runtimeId: input.sourceRuntimeId } }
      : {}),
  });
  store.upsertMember({
    channelId: input.channelId,
    kind: input.sender.kind === 'agent' ? 'agent' : 'human',
    id: input.sender.id,
  });
  hub.broadcastCreated(
    message,
    input.mentions,
    input.steering ? { steering: input.steering } : undefined
  );
  return message;
}

export function createChannelChatRouter(deps: ChannelChatRouterDeps): Router {
  const router = Router();
  const passthrough: RequestHandler = (_req, _res, next) => next();
  const auth = deps.requireAuth ?? passthrough;
  const knownProviderIds = deps.knownProviderIds ?? DEFAULT_KNOWN_PROVIDER_IDS;

  const listAuth = deps.requireReadActorAuth?.('channels.list') ?? auth;
  const getAuth = deps.requireReadActorAuth?.('channels.get') ?? auth;
  const historyAuth = deps.requireReadActorAuth?.('channels.history') ?? auth;
  // Search is a filtered read of the same durable message log `channels.history`
  // already grants, so it rides that verb rather than minting a new gateway
  // command: a credential that may read a channel's transcript may search it,
  // and one that may not, cannot. When a scoped actor supplies a `channelId` the
  // requested scope is that single channel; a scope-less search is denied by the
  // actor lane (browser searches keep their existing authority).
  const searchAuth = auth;
  const threadHistoryAuth =
    deps.requireReadActorAuth?.('channels.threads.history') ?? auth;
  const postAuth = deps.requireWriteActorAuth?.('channels.post') ?? auth;
  const rosterAuth = deps.requireReadActorAuth?.('channels.roster') ?? auth;
  const interruptAuth = auth;
  // This is an operator lifecycle control, authenticated through the existing
  // channel router lane. It is not a provider command or a message write.
  const releaseAuth = auth;
  const approvalAuth = auth;
  const agentCommandsAuth = auth;
  const uploadImages = multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: CHANNEL_IMAGE_MAX_BYTES,
      files: CHANNEL_IMAGE_MAX_PER_MESSAGE,
      fields: 0,
      parts: CHANNEL_IMAGE_MAX_PER_MESSAGE,
    },
  }).array('images', CHANNEL_IMAGE_MAX_PER_MESSAGE);

  /** Persisted, non-derived channel guard shared by the #1167 agent routes. */
  function requirePersistedChannel(
    req: Request,
    res: Response
  ): WorkspaceTopic | null {
    const topicStore = topicStoreOr503(res, deps.topicStore);
    if (!topicStore) return null;
    const id = req.params['id'] ?? '';
    const topic = topicStore.get(id);
    if (!topic || topic.source !== 'persisted') {
      sendGatewayError(res, 'NOT_FOUND', 'channel not found', false, {
        channelId: id,
      });
      return null;
    }
    return topic;
  }

  router.get('/channels', listAuth, (req, res) => {
    if (denyMissingCapability(req, res, [CONTEXT_READ])) return;
    if (denyChannelReadWithoutScope(req, res)) return;
    const store = storeOr503(res, deps.store);
    if (!store) return;
    const topicStore = topicStoreOr503(res, deps.topicStore);
    if (!topicStore) return;
    try {
      const summaries = new Set(
        store.listChannelSummaries().map((summary) => summary.channelId)
      );
      const topics = topicStore.list({ includeArchived: true });
      const channels = topics
        .filter(
          (topic) => topic.status !== 'archived' || summaries.has(topic.id)
        )
        .map((topic) => channelSummaryView(store, topic));
      // A scoped actor enumerates ONLY its allowed channelIds (Slice 0 gate:
      // an actor scoped to channel A must never see channel B in the list).
      res.json({ channels: filterChannelListToScope(req, channels) });
    } catch (error) {
      mapStoreError(res, error);
    }
  });

  // MUST stay above `/channels/:id`: Express matches in registration order, and
  // a literal segment registered after a parameter route is unreachable. (Topic
  // ids are all `topic:`-prefixed, so `search` can never BE a channel id — the
  // ordering is about routing, not about a namespace collision.)
  router.get('/channels/search', searchAuth, (req, res) => {
    if (denyScopedActorPrivateRoute(req, res)) return;
    if (denyMissingCapability(req, res, [CONTEXT_READ])) return;
    if (denyChannelReadWithoutScope(req, res)) return;
    const store = storeOr503(res, deps.store);
    if (!store) return;
    const topicStore = topicStoreOr503(res, deps.topicStore);
    if (!topicStore) return;

    const rawQuery =
      parseStringQuery(req.query['q']) ?? parseStringQuery(req.query['query']);
    const query = (rawQuery ?? '')
      .slice(0, CHANNEL_SEARCH_QUERY_MAX_CHARS)
      .trim();
    // Asked BEFORE any work: the store owns the predicate for what it will and
    // will not run (blank text, no letter/digit, one term under the minimum
    // searchable length), and answering from it keeps "refused" distinguishable
    // from "consulted and empty". Without the distinction the client prints
    // "no matches" for a query the index never saw.
    const unavailableReason = channelSearchUnavailableReason(query);
    if (unavailableReason) {
      const unavailable: ChannelMessageSearchResponse = {
        query,
        results: [],
        truncated: false,
        unavailableReason,
      };
      res.json(unavailable);
      return;
    }
    const includeArchived = parseBooleanQuery(req.query['includeArchived']);
    const limit = parseSearchLimit(req.query['limit']);
    const scopeChannelId = parseStringQuery(req.query['channelId']);
    if (scopeChannelId && denyOutOfScopeChannel(req, res, scopeChannelId))
      return;
    const scopeWorkspaceId = parseStringQuery(req.query['workspaceId']);

    try {
      // Archive state and titles live in workspace_topics, a SEPARATE database
      // from the message log, so the visible-channel set is resolved here and
      // pushed INTO the index query as an allowlist. Filtering after the fact
      // would let 50 archived hits crowd out live ones and return a short page.
      //
      // Enumerated through `listAllTopicIds()`, NOT `list()`. `list()` is the
      // rail READ MODEL: it caps at WORKSPACE_TOPICS_MAX_LIST_ENTRIES (200) by
      // `updated_at DESC` across all workspaces while the store retains up to
      // WORKSPACE_TOPICS_MAX_STORED_ENTRIES (500), so building the allowlist
      // from it made every message in the 201st-and-older channel silently
      // unreachable — indexed, matching, and never returned, with no
      // `truncated` signal to admit it. Worse, the scope filters ran AFTER that
      // global window, so asking for one workspace narrowed the ANSWER instead
      // of the search space. Reach must be the corpus; the rail's cap is a
      // rendering budget. Cost is bounded by the 500-row retention: at most 500
      // point reads on a debounced, minimum-length query.
      const candidateIds = scopeChannelId
        ? [scopeChannelId]
        : (actorChannelIds(req) ?? topicStore.listAllTopicIds());
      const visible = new Map<string, WorkspaceTopic>();
      for (const candidateId of candidateIds) {
        const topic = topicStore.get(candidateId);
        if (!topic) continue;
        if (topic.source !== 'persisted') continue;
        if (scopeWorkspaceId && topic.workspaceId !== scopeWorkspaceId)
          continue;
        if (!includeArchived && topic.status === 'archived') continue;
        visible.set(topic.id, topic);
      }
      if (visible.size === 0) {
        const empty: ChannelMessageSearchResponse = {
          query,
          results: [],
          truncated: false,
        };
        res.json(empty);
        return;
      }
      // Overfetch by one so `truncated` reports "there were more" without a
      // second COUNT over the index. The extra row is never returned.
      const hits = store.searchMessages({
        query,
        channelIds: [...visible.keys()],
        limit: limit + 1,
      });
      const truncated = hits.length > limit;
      const results: ChannelMessageSearchResult[] = hits
        .slice(0, limit)
        .map((hit) => {
          const topic = visible.get(hit.channelId);
          return {
            ...hit,
            channelTitle: topic?.display.title ?? hit.channelId,
            archived: topic?.status === 'archived',
          };
        });
      const body: ChannelMessageSearchResponse = { query, results, truncated };
      res.json(body);
    } catch (error) {
      // A cost refusal is an ANSWER, not a failure (#1316): the store either
      // declined a prefix this corpus cannot afford or abandoned the read at
      // its wall-clock ceiling. Same 200-with-a-reason shape the static
      // refusals above use, for the same reason — an error status (or an empty
      // `results`) would make the client claim the transcript was searched.
      if (error instanceof ChannelSearchRefusedError) {
        const refused: ChannelMessageSearchResponse = {
          query,
          results: [],
          truncated: false,
          unavailableReason: error.reason,
        };
        res.json(refused);
        return;
      }
      mapStoreError(res, error);
    }
  });

  // #1308 slice 3 item 1: the operator's durable last-read marks.
  //
  // MUST stay above `/channels/:id` for the same registration-order reason
  // `/channels/search` does. Topic ids are `topic:`-prefixed, so `read-state`
  // can never BE a channel id.
  //
  // Auth is the edit/delete lane, not a read verb: the shared `auth` handler, an
  // explicit `context:read` check (no new gateway verb — the existing
  // `/channels/*` auth-lane inventory entry covers the path), and the
  // load-bearing human-lane gate. `requireCliGatewayAuth` admits scoped ACTOR
  // credentials, and an agent has no business reading — or moving — the
  // operator's private reading position. That gate is also what keeps this
  // single-operator device sync (#1231) rather than multi-party read receipts:
  // there is exactly one lane that can touch the table.
  router.get('/channels/read-state', auth, (req, res) => {
    if (denyMissingCapability(req, res, [CONTEXT_READ])) return;
    const store = storeOr503(res, deps.store);
    if (!store) return;
    if (denyNonOperator(req, res, 'read')) return;
    try {
      const body: ChannelReadStateResponse = {
        channels: store.listReadState(),
      };
      res.json(body);
    } catch (error) {
      mapStoreError(res, error);
    }
  });

  // Idempotent by construction (the store is monotonic-up), which is why this is
  // PUT and not POST: a device that retries after a timeout, or two devices that
  // report the same position, converge on one durable value.
  router.put('/channels/:id/read-state', auth, (req, res) => {
    if (denyMissingCapability(req, res, [CONTEXT_WRITE])) return;
    const store = storeOr503(res, deps.store);
    if (!store) return;
    // The human-lane gate runs BEFORE any channel lookup, deliberately. A route
    // whose whole point is that an agent can neither observe nor move the
    // operator's reading position must not answer 404-vs-403 to a scoped actor
    // credential, or the existence probe leaks exactly what the gate withholds.
    if (denyNonOperator(req, res, 'mark')) return;
    // Archived channels are deliberately NOT rejected the way edits and deletes
    // are: archive browse (#1087) is a legitimate read surface, and marking what
    // was read there mutates no transcript.
    const topic = requirePersistedChannel(req, res);
    if (!topic) return;
    const lastReadSeq = bodyRecord(req)['lastReadSeq'];
    if (
      typeof lastReadSeq !== 'number' ||
      !Number.isInteger(lastReadSeq) ||
      lastReadSeq < 0
    ) {
      sendGatewayError(
        res,
        'INVALID_ARGUMENT',
        'lastReadSeq must be a non-negative integer',
        false,
        { field: 'lastReadSeq', reasonCode: 'CHANNEL_READ_SEQ_INVALID' }
      );
      return;
    }
    try {
      const { advanced, ...readState } = store.markChannelRead(
        topic.id,
        lastReadSeq
      );
      // Broadcast only on a real advance. A stale or repeated mark gives other
      // devices nothing to converge on, and the lane is unfiltered fan-out to
      // every open tab — spending it on a no-op is pure noise.
      if (advanced) {
        deps.broadcastEvent?.(CHANNEL_READ_STATE_EVENT, {
          channelId: readState.channelId,
          lastReadSeq: readState.lastReadSeq,
        });
      }
      const body: ChannelReadStateUpdateResponse = { readState };
      res.json(body);
    } catch (error) {
      mapStoreError(res, error);
    }
  });

  router.get('/channels/:id', getAuth, (req, res) => {
    if (denyMissingCapability(req, res, [CONTEXT_READ])) return;
    const store = storeOr503(res, deps.store);
    if (!store) return;
    const topicStore = topicStoreOr503(res, deps.topicStore);
    if (!topicStore) return;
    const id = req.params['id'] ?? '';
    if (denyOutOfScopeChannel(req, res, id)) return;
    const topic = topicStore.get(id);
    if (!topic || topic.source !== 'persisted') {
      sendGatewayError(res, 'NOT_FOUND', 'channel not found', false, {
        channelId: id,
      });
      return;
    }
    try {
      res.json({ channel: channelSummaryView(store, topic) });
    } catch (error) {
      mapStoreError(res, error);
    }
  });

  router.get('/channels/:id/messages', historyAuth, (req, res) => {
    if (denyMissingCapability(req, res, [CONTEXT_READ])) return;
    const store = storeOr503(res, deps.store);
    if (!store) return;
    const id = req.params['id'] ?? '';
    if (denyOutOfScopeChannel(req, res, id)) return;
    if (
      rejectInvalidActorPagination(req, res, ['beforeSeq', 'afterSeq', 'limit'])
    )
      return;
    if (!requirePersistedChannel(req, res)) return;
    const filter: ChannelHistoryFilter = {};
    const beforeSeq = parseSeqQuery(req.query['beforeSeq']);
    if (beforeSeq !== undefined) filter.beforeSeq = beforeSeq;
    const afterSeq = parseSeqQuery(req.query['afterSeq']);
    if (afterSeq !== undefined) filter.afterSeq = afterSeq;
    const limit = parseHistoryLimit(req.query['limit']);
    // One extra row makes a full public page distinguishable from the end of
    // the log without an expensive COUNT. `budgetHistoryPage` drops it while
    // retaining the exact exclusive cursor for either direction.
    filter.limit = limit + 1;
    const threadId =
      typeof req.query['threadId'] === 'string'
        ? req.query['threadId']
        : undefined;
    if (threadId) filter.threadId = threadId;
    try {
      const all = store.history(id, filter);
      const direction = filter.afterSeq !== undefined ? 'forward' : 'backward';
      const budgeted = budgetHistoryPage(
        all,
        direction,
        limit,
        deps.historyMaxBytes ?? DEFAULT_HISTORY_MAX_BYTES
      );
      res.json({
        messages: budgeted.rows,
        ...(budgeted.hasMore
          ? { hasMore: true, nextCursor: budgeted.nextCursor }
          : {}),
      });
    } catch (error) {
      mapStoreError(res, error);
    }
  });

  router.post('/channels/:id/attachments', auth, (req, res) => {
    if (denyScopedActorPrivateRoute(req, res)) return;
    if (denyMissingCapability(req, res, [CONTEXT_WRITE])) return;
    const id = req.params['id'] ?? '';
    if (denyOutOfScopeChannel(req, res, id)) return;
    const topic = requirePersistedChannel(req, res);
    if (!topic) return;
    if (topic.status === 'archived') {
      sendGatewayError(res, 'SESSION_CONFLICT', 'channel is archived', false, {
        channelId: topic.id,
        reasonCode: 'CHANNEL_ARCHIVED',
      });
      return;
    }
    const attachmentStore = attachmentStoreOr503(res, deps.attachmentStore);
    if (!attachmentStore) return;

    uploadImages(req, res, (uploadError: unknown) => {
      if (uploadError) {
        const isLimit = uploadError instanceof multer.MulterError;
        const tooLarge = isLimit && uploadError.code === 'LIMIT_FILE_SIZE';
        sendGatewayError(
          res,
          'INVALID_ARGUMENT',
          tooLarge
            ? 'image exceeds 5MB cap'
            : `invalid image upload: ${uploadError instanceof Error ? uploadError.message : String(uploadError)}`,
          false,
          {
            reasonCode: tooLarge
              ? 'CHANNEL_IMAGE_TOO_LARGE'
              : 'CHANNEL_IMAGE_UPLOAD_INVALID',
          },
          tooLarge ? 413 : 400
        );
        return;
      }
      const files = Array.isArray(req.files)
        ? (req.files as Express.Multer.File[])
        : [];
      void attachmentStore
        .ingestMany(
          files.map((file) => ({
            bytes: file.buffer,
            ...(file.mimetype ? { declaredMime: file.mimetype } : {}),
            ...(file.originalname ? { alt: file.originalname } : {}),
          }))
        )
        .then((attachments) => res.status(201).json({ attachments }))
        .catch((error: unknown) => mapStoreError(res, error));
    });
  });

  router.get('/channels/:id/attachments/:attachmentId', auth, (req, res) => {
    if (denyScopedActorPrivateRoute(req, res)) return;
    if (denyMissingCapability(req, res, [CONTEXT_READ])) return;
    const id = req.params['id'] ?? '';
    if (denyOutOfScopeChannel(req, res, id)) return;
    if (!requirePersistedChannel(req, res)) return;
    const attachmentStore = attachmentStoreOr503(res, deps.attachmentStore);
    if (!attachmentStore) return;
    const attachmentId = req.params['attachmentId'] ?? '';
    const record = attachmentStore.get(attachmentId);
    if (!record || !existsSync(record.payloadPath)) {
      res.set('Cache-Control', 'no-store');
      sendGatewayError(
        res,
        'NOT_FOUND',
        'channel attachment not found',
        false,
        {
          attachmentId,
          reasonCode: 'CHANNEL_ATTACHMENT_NOT_FOUND',
        }
      );
      return;
    }
    res.sendFile(
      record.payloadPath,
      {
        headers: {
          'Content-Type': record.part.mime,
          'Content-Length': String(record.part.bytes),
          'Content-Disposition': 'inline',
          'Cache-Control': 'private, max-age=31536000, immutable',
          ETag: `"sha256-${record.sha256}"`,
          'X-Content-Type-Options': 'nosniff',
        },
      },
      (error) => {
        if (!error) return;
        if (res.headersSent) {
          res.destroy(error);
        } else {
          res.set('Cache-Control', 'no-store');
          sendGatewayError(
            res,
            'NOT_FOUND',
            'channel attachment not found',
            false,
            { attachmentId, reasonCode: 'CHANNEL_ATTACHMENT_NOT_FOUND' }
          );
        }
      }
    );
  });

  router.get(
    '/channels/:id/threads/:rootMessageId',
    threadHistoryAuth,
    (req, res) => {
      if (denyMissingCapability(req, res, [CONTEXT_READ])) return;
      const store = storeOr503(res, deps.store);
      if (!store) return;
      const id = req.params['id'] ?? '';
      if (denyOutOfScopeChannel(req, res, id)) return;
      if (
        rejectInvalidActorPagination(req, res, [
          'beforeSeq',
          'afterSeq',
          'limit',
        ])
      )
        return;
      if (!requirePersistedChannel(req, res)) return;
      const rootMessageId = req.params['rootMessageId'] ?? '';
      const filter: ChannelHistoryFilter = {};
      const beforeSeq = parseSeqQuery(req.query['beforeSeq']);
      const afterSeq = parseSeqQuery(req.query['afterSeq']);
      // Match the established history precedence: when both cursors are
      // supplied, afterSeq selects forward pagination and beforeSeq is ignored.
      if (afterSeq !== undefined) filter.afterSeq = afterSeq;
      else if (beforeSeq !== undefined) filter.beforeSeq = beforeSeq;
      const limit = parseHistoryLimit(req.query['limit']);
      // One extra row makes row-limit pagination observable without a COUNT.
      filter.limit = limit + 1;
      try {
        const all = store.threadHistory(id, rootMessageId, filter);
        const direction =
          filter.afterSeq !== undefined ? 'forward' : 'backward';
        const budgeted = budgetHistoryPage(
          all,
          direction,
          limit,
          deps.historyMaxBytes ?? DEFAULT_HISTORY_MAX_BYTES
        );
        res.json({
          messages: budgeted.rows,
          ...(budgeted.hasMore
            ? { hasMore: true, nextCursor: budgeted.nextCursor }
            : {}),
        });
      } catch (error) {
        mapStoreError(res, error);
      }
    }
  );

  // The existing post parser sits at the configured threshold; this security
  // denial is deliberately kept adjacent to attachment canonicalization.
  // eslint-disable-next-line complexity
  router.post('/channels/:id/messages', postAuth, (req, res) => {
    if (denyMissingCapability(req, res, [CONTEXT_WRITE])) return;
    const id = req.params['id'] ?? '';
    if (denyOutOfScopeChannel(req, res, id)) return;
    if (rejectInvalidActorChannelPostBody(req, res)) return;
    const store = storeOr503(res, deps.store);
    if (!store) return;
    const topicStore = topicStoreOr503(res, deps.topicStore);
    if (!topicStore) return;
    const body = bodyRecord(req);

    // [MF] Reject a client-supplied sender field outright — attribution is
    // ALWAYS server-derived from the auth lane, never forgeable from the body.
    if ('sender' in body || 'source' in body) {
      const field = 'sender' in body ? 'sender' : 'source';
      sendGatewayError(
        res,
        'INVALID_ARGUMENT',
        `${field} is server-derived and must not be supplied in the request body`,
        false,
        {
          field,
          reasonCode:
            field === 'sender'
              ? 'CHANNEL_SENDER_NOT_ALLOWED'
              : 'CHANNEL_SOURCE_NOT_ALLOWED',
        }
      );
      return;
    }

    // [MF] Topic must be a persisted, non-archived channel (derived topics from
    // deriveWorkspaceTopicsFromWorkContexts are rejected).
    const topic = topicStore.get(id);
    if (!topic || topic.source !== 'persisted') {
      sendGatewayError(res, 'NOT_FOUND', 'channel not found', false, {
        channelId: id,
      });
      return;
    }
    if (topic.status === 'archived') {
      sendGatewayError(res, 'SESSION_CONFLICT', 'channel is archived', false, {
        channelId: id,
        reasonCode: 'CHANNEL_ARCHIVED',
      });
      return;
    }

    const text = body['text'];
    if (typeof text !== 'string') {
      sendGatewayError(
        res,
        'INVALID_ARGUMENT',
        'text must be a string',
        false,
        {
          field: 'text',
        }
      );
      return;
    }
    // Provider-neutral binder catalog owns the recognition rule, including
    // exact profile identity and both @profile/command and @profile /command.
    if (rejectChannelControlMessage(res, deps.binder, text)) return;
    let parts: import('../shared/channel-chat-protocol.js').ChannelMessagePart[] =
      [];
    if (body['parts'] !== undefined) {
      const attachmentStore = attachmentStoreOr503(res, deps.attachmentStore);
      if (!attachmentStore) return;
      try {
        parts = attachmentStore.canonicalizeParts(body['parts']);
      } catch (error) {
        mapStoreError(res, error);
        return;
      }
    }
    if (rejectEmptyChannelPost(res, text, parts)) return;
    const format =
      body['format'] === 'text' || body['format'] === 'markdown'
        ? (body['format'] as ChannelBodyFormat)
        : undefined;
    // Public thread writes identify the message being replied to as `threadId`.
    // The store derives the canonical root and persists this supplied id as the
    // immediate parent; callers cannot forge a root id.
    const suppliedThreadId = body['threadId'];
    const threadId =
      typeof suppliedThreadId === 'string' && suppliedThreadId.length > 0
        ? suppliedThreadId
        : undefined;
    // JSON null is the protocol's explicit no-thread value and is equivalent
    // to omitting the field. Empty strings and other non-strings are malformed.
    if (
      'threadId' in body &&
      suppliedThreadId !== null &&
      threadId === undefined
    ) {
      sendGatewayError(
        res,
        'INVALID_ARGUMENT',
        'threadId must be a non-empty message id',
        false,
        { field: 'threadId' }
      );
      return;
    }
    const legacyParentMessageId =
      typeof body['parentMessageId'] === 'string'
        ? body['parentMessageId']
        : undefined;
    const resolvedLegacyParentMessageId = legacyParentMessageId || undefined;
    if (
      threadId !== undefined &&
      resolvedLegacyParentMessageId !== undefined &&
      threadId !== resolvedLegacyParentMessageId
    ) {
      sendGatewayError(
        res,
        'INVALID_ARGUMENT',
        'threadId and parentMessageId must identify the same message',
        false,
        { fields: ['threadId', 'parentMessageId'] }
      );
      return;
    }
    const parentMessageId = threadId ?? resolvedLegacyParentMessageId;
    const clientMessageId =
      typeof body['clientMessageId'] === 'string'
        ? body['clientMessageId']
        : undefined;

    // #1308 slice 4: mid-turn steering rides the EXISTING post route as one
    // additive body field rather than a second route — the operator is sending a
    // message either way, and the only thing that differs is whether the agent's
    // live turn is allowed to finish first. Omitted (the default) queues; the
    // binder is the sole interpreter and ignores it for non-human senders.
    const suppliedSteering = body['steering'];
    if (
      suppliedSteering !== undefined &&
      !isChannelPostSteering(suppliedSteering)
    ) {
      sendGatewayError(
        res,
        'INVALID_ARGUMENT',
        `steering must be one of: ${CHANNEL_POST_STEERING_VALUES.join(', ')}`,
        false,
        { field: 'steering', reasonCode: 'CHANNEL_STEERING_INVALID' }
      );
      return;
    }
    const steering = isChannelPostSteering(suppliedSteering)
      ? suppliedSteering
      : undefined;

    const credential = authenticatedCliGatewayActorCredential(req);
    const sourceRuntimeId = authenticatedSourceRuntimeId(
      credential,
      deps.getRuntime
    );
    const sourceRuntime = sourceRuntimeId
      ? deps.getRuntime?.(sourceRuntimeId)
      : undefined;
    const sender = deriveSender(req, sourceRuntime);

    // clientMessageId idempotency: return the existing row without re-broadcast.
    //
    // Steering is the ONE thing a replay must still act on (#1308 slice 4
    // review). The composer keeps its `clientMessageId` after a failed send, so
    // an operator whose "queue" POST landed server-side but looked like it
    // failed, and who then presses "interrupt & send", replays a known id. The
    // row is already persisted and already queued — re-broadcasting it would
    // double-deliver the message — but the interrupt has NOT happened yet, and
    // swallowing it silently would report an interrupt-and-send that did
    // neither. `steerExisting` applies the cancellation half only, and is a
    // no-op when the addressed binding has no live turn.
    if (clientMessageId) {
      const existing = store.findByClientMessage(
        id,
        sender.id,
        clientMessageId
      );
      if (existing) {
        if (steering) deps.binder?.steerExisting(existing, steering);
        res.status(200).json({ message: existing });
        return;
      }
    }

    const providerIds = [
      ...knownProviderIds,
      ...(topic.routingDefaults.providerId
        ? [topic.routingDefaults.providerId]
        : []),
    ];
    const mentions = parseMentions(text, providerIds);

    try {
      const message = postToChannel(store, deps.hub, {
        channelId: id,
        sender,
        ...(sourceRuntimeId ? { sourceRuntimeId } : {}),
        text,
        ...(format ? { format } : {}),
        ...(parentMessageId ? { parentMessageId } : {}),
        ...(clientMessageId ? { clientMessageId } : {}),
        mentions,
        ...(parts.length ? { parts } : {}),
        ...(steering ? { steering } : {}),
      });
      res.status(201).json({ message });
    } catch (error) {
      mapStoreError(res, error);
    }
  });

  // #1308 slice 1 item 3: the operator edits one of their OWN durable rows.
  //
  // PATCH, not POST: this replaces a field of an existing resource, and the row
  // keeps its id/seq/createdAt — the store mutates in place so no seq cursor,
  // thread link or catch-up window moves.
  //
  // Auth shape mirrors the retry lane (#1308 item 2): the shared `auth` lane
  // plus an explicit `context:write` check, because this slice adds no CLI
  // gateway verb. The additional human-lane gate below is the load-bearing one —
  // `requireCliGatewayAuth` admits scoped ACTOR credentials, and an agent must
  // never be able to rewrite the operator's words.
  router.patch('/channels/:id/messages/:messageId', auth, (req, res) => {
    if (denyMissingCapability(req, res, [CONTEXT_WRITE])) return;
    const store = storeOr503(res, deps.store);
    if (!store) return;
    const topic = requirePersistedChannel(req, res);
    if (!topic) return;
    if (topic.status === 'archived') {
      sendGatewayError(res, 'SESSION_CONFLICT', 'channel is archived', false, {
        channelId: topic.id,
        reasonCode: 'CHANNEL_ARCHIVED',
      });
      return;
    }
    const body = bodyRecord(req);
    // Same [MF] rule as the post lane: attribution is server-derived, so a body
    // that tries to name a sender is rejected outright rather than ignored.
    if ('sender' in body || 'source' in body) {
      const field = 'sender' in body ? 'sender' : 'source';
      sendGatewayError(
        res,
        'INVALID_ARGUMENT',
        `${field} is server-derived and must not be supplied in the request body`,
        false,
        {
          field,
          reasonCode:
            field === 'sender'
              ? 'CHANNEL_SENDER_NOT_ALLOWED'
              : 'CHANNEL_SOURCE_NOT_ALLOWED',
        }
      );
      return;
    }
    const sender = deriveSender(req, undefined);
    if (sender.kind !== 'human') {
      sendGatewayError(
        res,
        'FORBIDDEN',
        'only the operator can edit channel messages',
        false,
        {
          channelId: topic.id,
          reasonCode: 'CHANNEL_EDIT_HUMAN_ONLY',
        }
      );
      return;
    }
    const text = body['text'];
    if (typeof text !== 'string') {
      sendGatewayError(
        res,
        'INVALID_ARGUMENT',
        'text must be a string',
        false,
        {
          field: 'text',
        }
      );
      return;
    }
    const trimmed = text.trim();
    if (trimmed.length === 0) {
      // Not a delete lane: clearing a message is its own action with its own
      // audit shape, so an empty edit is rejected rather than silently emptying
      // a durable row.
      sendGatewayError(
        res,
        'INVALID_ARGUMENT',
        'edited text must not be empty',
        false,
        { field: 'text', reasonCode: 'CHANNEL_MESSAGE_BODY_EMPTY' }
      );
      return;
    }
    const providerIds = [
      ...knownProviderIds,
      ...(topic.routingDefaults.providerId
        ? [topic.routingDefaults.providerId]
        : []),
    ];
    try {
      const message = store.editMessage({
        channelId: topic.id,
        messageId: req.params['messageId'] ?? '',
        editorId: sender.id,
        text: trimmed,
        mentions: parseMentions(trimmed, providerIds),
      });
      // Broadcast only — NEVER `postToChannel`/`broadcastCreated`. Editing must
      // not re-run the turn the original text triggered (#1308 S1 non-goal);
      // future packets pick the new body up because the binder reads rows from
      // the store when it builds one.
      deps.hub.broadcastEdited(message);
      res.json({ message });
    } catch (error) {
      mapStoreError(res, error);
    }
  });

  // #1308 slice 1 item 4: the operator deletes one of their OWN durable rows.
  //
  // DELETE the resource, TOMBSTONE the record. The HTTP verb describes what the
  // operator asked for; the store never removes the row, because `seq` is the
  // substrate contract — a hole in the log would break every catch-up cursor,
  // deep link and thread parent that already names it. The response body is the
  // tombstone rather than 204, so the caller sees the row it now holds.
  //
  // Auth shape is the edit lane's, unchanged: the shared `auth` lane, an
  // explicit `context:write` check (no new gateway verb, and the existing
  // `/channels/*` auth-lane inventory entry covers the path), and a human-lane
  // gate that is the load-bearing one — `requireCliGatewayAuth` admits scoped
  // ACTOR credentials, and an agent must never be able to erase the operator's
  // words.
  router.delete('/channels/:id/messages/:messageId', auth, (req, res) => {
    if (denyMissingCapability(req, res, [CONTEXT_WRITE])) return;
    const store = storeOr503(res, deps.store);
    if (!store) return;
    const topic = requirePersistedChannel(req, res);
    if (!topic) return;
    if (topic.status === 'archived') {
      sendGatewayError(res, 'SESSION_CONFLICT', 'channel is archived', false, {
        channelId: topic.id,
        reasonCode: 'CHANNEL_ARCHIVED',
      });
      return;
    }
    const sender = deriveSender(req, undefined);
    if (sender.kind !== 'human') {
      sendGatewayError(
        res,
        'FORBIDDEN',
        'only the operator can delete channel messages',
        false,
        {
          channelId: topic.id,
          reasonCode: 'CHANNEL_DELETE_HUMAN_ONLY',
        }
      );
      return;
    }
    try {
      const message = store.deleteMessage({
        channelId: topic.id,
        messageId: req.params['messageId'] ?? '',
        deleterId: sender.id,
      });
      // Broadcast only, exactly as with an edit: no `postToChannel`, so the
      // mention-routing handlers never run and a deletion can never raise a turn.
      deps.hub.broadcastDeleted(message);
      res.json({ message });
    } catch (error) {
      mapStoreError(res, error);
    }
  });

  // #1167 §2: per-request agent roster (framework availability + live binding
  // status). Derived per request — no persistent handle registry.
  router.get('/channels/:id/roster', rosterAuth, (req, res) => {
    if (denyMissingCapability(req, res, [CONTEXT_READ])) return;
    if (!storeOr503(res, deps.store)) return;
    const id = req.params['id'] ?? '';
    if (denyOutOfScopeChannel(req, res, id)) return;
    const topic = requirePersistedChannel(req, res);
    if (!topic) return;
    const binder = binderOr503(res, deps.binder);
    if (!binder) return;
    binder
      .rosterForChannel(topic.id)
      .then((roster) => res.json({ roster }))
      .catch((error) => mapStoreError(res, error));
  });

  router.post(
    '/channels/:id/agent-commands',
    agentCommandsAuth,
    (req, res, next) => {
      if (denyScopedActorPrivateRoute(req, res)) return;
      next();
    },
    createAgentCommandsHandler(deps, requirePersistedChannel)
  );

  // #1259 slice 4: operator designates (spawns / resumes) the persistent
  // orchestrator for a product channel. Operator lane ONLY — scoped actors are
  // forbidden from creating orchestrator runtimes directly; the durable
  // orchestrator role is granted only through this channel-owned lane.
  router.post('/channels/:id/orchestrator', auth, (req, res) => {
    const topic = requirePersistedChannel(req, res);
    if (!topic) return;
    // A DM already addresses exactly one provider. A persistent orchestrator
    // would add a second, unrelated participant (and historically defaulted to
    // Claude when no framework was specified), so this is group-channel only.
    if (isDmChannel(topic)) {
      sendGatewayError(
        res,
        'UNSUPPORTED',
        'direct messages cannot designate an orchestrator',
        false,
        { channelId: topic.id, reasonCode: 'DM_ORCHESTRATOR_UNSUPPORTED' }
      );
      return;
    }
    const binder = binderOr503(res, deps.binder);
    if (!binder) return;
    const requested = req.query['framework'];
    const framework =
      typeof requested === 'string' && requested.length > 0
        ? requested
        : 'claude';
    binder
      .ensureOrchestrator(topic.id, framework)
      .then((binding) =>
        res.json({
          ok: true,
          orchestrator: {
            runtimeId: binding.runtimeId ?? null,
            status: binding.status ?? 'idle',
            framework,
          },
        })
      )
      .catch((error) => {
        if (error instanceof ChannelAgentRoleConflictError) {
          sendGatewayError(
            res,
            'SESSION_CONFLICT',
            'channel already bound to a non-orchestrator runtime',
            false,
            { channelId: topic.id, reasonCode: 'CHANNEL_ROLE_CONFLICT' }
          );
          return;
        }
        mapStoreError(res, error);
      });
  });

  // #1167 §7: interrupt the agent's active turn.
  router.post(
    '/channels/:id/agents/:agentId/interrupt',
    interruptAuth,
    (req, res) => {
      if (denyScopedActorPrivateRoute(req, res)) return;
      if (denyMissingCapability(req, res, [CONTEXT_WRITE])) return;
      const topic = requirePersistedChannel(req, res);
      if (!topic) return;
      const binder = binderOr503(res, deps.binder);
      if (!binder) return;
      const agentId = req.params['agentId'] ?? '';
      binder
        .interrupt(topic.id, agentId)
        .then(() => res.json({ ok: true }))
        .catch((error) => {
          if (error instanceof ChannelAgentNotFoundError) {
            sendGatewayError(res, 'NOT_FOUND', 'no live agent binding', false, {
              channelId: topic.id,
              agentId,
              reasonCode: 'CHANNEL_AGENT_NOT_BOUND',
            });
            return;
          }
          if (error instanceof ChannelAgentNoActiveTurnError) {
            sendGatewayError(
              res,
              'SESSION_CONFLICT',
              'agent has no active turn to interrupt',
              false,
              { channelId: topic.id, agentId, reasonCode: 'NO_ACTIVE_TURN' }
            );
            return;
          }
          mapStoreError(res, error);
        });
    }
  );

  router.post(
    '/channels/:id/agents/:agentId/release',
    releaseAuth,
    (req, res) => {
      if (denyMissingCapability(req, res, [CONTEXT_WRITE])) return;
      const topic = requirePersistedChannel(req, res);
      if (!topic) return;
      const sender = deriveSender(req, undefined);
      if (sender.kind !== 'human') {
        sendGatewayError(
          res,
          'FORBIDDEN',
          'only the operator can release a channel agent',
          false,
          { channelId: topic.id, reasonCode: 'CHANNEL_RELEASE_HUMAN_ONLY' }
        );
        return;
      }
      const binder = binderOr503(res, deps.binder);
      if (!binder) return;
      const agentId = req.params['agentId'] ?? '';
      binder
        .release(topic.id, agentId)
        .then(() => res.json({ ok: true }))
        .catch((error) => {
          if (error instanceof ChannelAgentNotFoundError) {
            sendGatewayError(res, 'NOT_FOUND', 'no live agent binding', false, {
              channelId: topic.id,
              agentId,
              reasonCode: 'CHANNEL_AGENT_NOT_BOUND',
            });
            return;
          }
          if (error instanceof ChannelAgentReleaseRefusedError) {
            sendGatewayError(res, 'SESSION_CONFLICT', error.message, true, {
              channelId: topic.id,
              agentId,
              status: error.status,
              reasonCode: error.reasonCode,
            });
            return;
          }
          mapStoreError(res, error);
        });
    }
  );

  // #1308 slice 1 item 2: retry one failed/interrupted/truncated agent row by
  // re-routing the ORIGINAL trigger message to the same profile.
  //
  // Auth shape is the edit/delete lane's, and for the same reason. The shared
  // `auth` lane plus an explicit `context:write` check comes first (this slice
  // adds no CLI gateway verb), but `denyMissingCapability` is NOT a credential
  // scope check — it seeds `provided` from the client-supplied
  // `x-relay-capabilities` header — so the human-lane gate below is the
  // load-bearing one. `requireCliGatewayAuth` admits scoped ACTOR credentials,
  // re-running a turn spends real provider tokens and spawns runtimes, and
  // `retryMessage` calls `routeOne` directly (outside `routeWithBrake`'s
  // mention-chain cap), so an agent must never be able to reach it.
  router.post('/channels/:id/messages/:messageId/retry', auth, (req, res) => {
    if (denyMissingCapability(req, res, [CONTEXT_WRITE])) return;
    const topic = requirePersistedChannel(req, res);
    if (!topic) return;
    // An archived channel is read-only, exactly as it is for post/edit/delete:
    // a retry writes a durable `retrying @…` system row and appends a whole new
    // agent turn, which is the loudest possible violation of that invariant.
    if (topic.status === 'archived') {
      sendGatewayError(res, 'SESSION_CONFLICT', 'channel is archived', false, {
        channelId: topic.id,
        reasonCode: 'CHANNEL_ARCHIVED',
      });
      return;
    }
    const sender = deriveSender(req, undefined);
    if (sender.kind !== 'human') {
      sendGatewayError(
        res,
        'FORBIDDEN',
        'only the operator can retry channel messages',
        false,
        {
          channelId: topic.id,
          reasonCode: 'CHANNEL_RETRY_HUMAN_ONLY',
        }
      );
      return;
    }
    if (!storeOr503(res, deps.store)) return;
    const binder = binderOr503(res, deps.binder);
    if (!binder) return;
    const messageId = req.params['messageId'] ?? '';
    binder
      .retryMessage(topic.id, messageId)
      .then((retry) => res.json({ ok: true, retry }))
      .catch((error) => {
        if (error instanceof ChannelMessageNotRetryableError) {
          sendGatewayError(
            res,
            error.notFound ? 'NOT_FOUND' : 'SESSION_CONFLICT',
            error.message,
            false,
            {
              channelId: topic.id,
              messageId,
              reasonCode: error.reasonCode,
            }
          );
          return;
        }
        if (error instanceof ChannelAgentBusyError) {
          sendGatewayError(res, 'SESSION_CONFLICT', error.message, true, {
            channelId: topic.id,
            messageId,
            agentId: error.profileActorId,
            status: error.status,
            reasonCode: 'CHANNEL_AGENT_BUSY',
          });
          return;
        }
        mapStoreError(res, error);
      });
  });

  // #1167 §7: respond to an in-channel approval request.
  router.post(
    '/channels/:id/agents/:agentId/approvals',
    approvalAuth,
    (req, res) => {
      if (denyScopedActorPrivateRoute(req, res)) return;
      if (denyMissingCapability(req, res, [CONTEXT_WRITE])) return;
      const topic = requirePersistedChannel(req, res);
      if (!topic) return;
      const binder = binderOr503(res, deps.binder);
      if (!binder) return;
      const agentId = req.params['agentId'] ?? '';
      const body = bodyRecord(req);
      const requestId = body['requestId'];
      if (typeof requestId !== 'string' || requestId.length === 0) {
        sendGatewayError(
          res,
          'INVALID_ARGUMENT',
          'requestId is required',
          false,
          {
            field: 'requestId',
          }
        );
        return;
      }
      const decision = body['decision'];
      if (
        !isRecord(decision) ||
        (decision['kind'] !== 'accept' &&
          decision['kind'] !== 'decline' &&
          decision['kind'] !== 'cancel')
      ) {
        sendGatewayError(
          res,
          'INVALID_ARGUMENT',
          'decision.kind must be accept|decline|cancel',
          false,
          { field: 'decision' }
        );
        return;
      }
      binder
        .respondToApproval(
          topic.id,
          agentId,
          requestId,
          decision as unknown as AgentApprovalDecisionV2
        )
        .then(() => res.json({ ok: true }))
        .catch((error) => {
          if (error instanceof ChannelAgentNotFoundError) {
            sendGatewayError(res, 'NOT_FOUND', 'no live agent binding', false, {
              channelId: topic.id,
              agentId,
              reasonCode: 'CHANNEL_AGENT_NOT_BOUND',
            });
            return;
          }
          mapStoreError(res, error);
        });
    }
  );

  return router;
}
