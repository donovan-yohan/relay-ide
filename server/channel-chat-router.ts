import { Router } from 'express';
import type { Request, RequestHandler, Response } from 'express';

import type { RelayCliGatewayErrorCode } from '../shared/cli-gateway-contract.js';
import {
  authenticatedCliGatewayActorCredential,
  type CliGatewayActorReadCommand,
  type CliGatewayActorWriteCommand,
} from './cli-gateway-actor-auth.js';
import {
  ChannelMessageStoreError,
  type ChannelHistoryFilter,
  type ChannelMessageStore,
} from './channel-message-store.js';
import type { ChannelHub } from './channel-hub.js';
import type { WorkspaceTopicStore } from './workspace-topics.js';
import type { WorkspaceTopic } from '../shared/workspace-topics.js';
import {
  parseMentions,
  type ChannelBodyFormat,
  type ChannelMessage,
  type ChannelSenderRef,
} from '../shared/channel-chat-protocol.js';

const CONTEXT_READ = 'context:read';
const CONTEXT_WRITE = 'context:write';

const DEFAULT_KNOWN_PROVIDER_IDS = ['claude', 'codex', 'opencode', 'hermes'];

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

export interface ChannelChatRouterDeps {
  store: ChannelMessageStore | null;
  hub: ChannelHub;
  topicStore: WorkspaceTopicStore | null;
  /** framework ids for @-mention resolution (v2 adapter registry + topic default). */
  knownProviderIds?: readonly string[];
  /** byte budget for one history response body (defaults to 4MB). */
  historyMaxBytes?: number;
  requireAuth?: RequestHandler;
  requireReadActorAuth?: (
    command: CliGatewayActorReadCommand,
    options?: {
      scopeForRequest?: (
        req: Request
      ) => { workContextIds?: string[] } | undefined;
    }
  ) => RequestHandler;
  requireWriteActorAuth?: (
    command: CliGatewayActorWriteCommand,
    options?: {
      scopeForRequest?: (
        req: Request
      ) => { workContextIds?: string[] } | undefined;
    }
  ) => RequestHandler;
}

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

/**
 * Server-derived sender attribution from the authenticated lane — NEVER from the
 * request body ([MF]: attribution is the core product promise). Browser cookie
 * session → human operator; CLI-gateway actor credential → agent:<actor id>.
 */
function deriveSender(req: Request): ChannelSenderRef {
  const credential = authenticatedCliGatewayActorCredential(req);
  if (credential) {
    return {
      kind: 'agent',
      id: `agent:${credential.actor.id}`,
      providerId: credential.actor.id,
      ...(credential.actor.displayName
        ? { displayName: credential.actor.displayName }
        : {}),
    };
  }
  return { kind: 'human', id: 'human:operator', displayName: 'Operator' };
}

function mapStoreError(res: Response, error: unknown): void {
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

function parseSeqQuery(value: unknown): number | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== 'string' || !raw.trim()) return undefined;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function channelSummaryView(
  store: ChannelMessageStore,
  topic: WorkspaceTopic
): Record<string, unknown> {
  const summary = store.getChannelSummary(topic.id);
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
    text: string;
    format?: ChannelBodyFormat;
    parentMessageId?: string;
    clientMessageId?: string;
    mentions: ReturnType<typeof parseMentions>;
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
  });
  store.upsertMember({
    channelId: input.channelId,
    kind: input.sender.kind === 'agent' ? 'agent' : 'human',
    id: input.sender.id,
  });
  hub.broadcastCreated(message, input.mentions);
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
  const postAuth = deps.requireWriteActorAuth?.('channels.post') ?? auth;

  router.get('/channels', listAuth, (req, res) => {
    if (denyMissingCapability(req, res, [CONTEXT_READ])) return;
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
      res.json({ channels });
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
    const filter: ChannelHistoryFilter = {};
    const beforeSeq = parseSeqQuery(req.query['beforeSeq']);
    if (beforeSeq !== undefined) filter.beforeSeq = beforeSeq;
    const afterSeq = parseSeqQuery(req.query['afterSeq']);
    if (afterSeq !== undefined) filter.afterSeq = afterSeq;
    const limit = parseSeqQuery(req.query['limit']);
    if (limit !== undefined) filter.limit = limit;
    const threadId =
      typeof req.query['threadId'] === 'string'
        ? req.query['threadId']
        : undefined;
    if (threadId) filter.threadId = threadId;
    try {
      const all = store.history(id, filter);
      const direction =
        filter.afterSeq !== undefined ? 'forward' : 'backward';
      const budgeted = budgetHistoryRows(
        all,
        direction,
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

  router.post('/channels/:id/messages', postAuth, (req, res) => {
    if (denyMissingCapability(req, res, [CONTEXT_WRITE])) return;
    const store = storeOr503(res, deps.store);
    if (!store) return;
    const topicStore = topicStoreOr503(res, deps.topicStore);
    if (!topicStore) return;
    const id = req.params['id'] ?? '';
    const body = bodyRecord(req);

    // [MF] Reject a client-supplied sender field outright — attribution is
    // ALWAYS server-derived from the auth lane, never forgeable from the body.
    if ('sender' in body) {
      sendGatewayError(
        res,
        'INVALID_ARGUMENT',
        'sender is server-derived and must not be supplied in the request body',
        false,
        { field: 'sender', reasonCode: 'CHANNEL_SENDER_NOT_ALLOWED' }
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
    if (typeof text !== 'string' || text.length === 0) {
      sendGatewayError(res, 'INVALID_ARGUMENT', 'text is required', false, {
        field: 'text',
      });
      return;
    }
    const format =
      body['format'] === 'text' || body['format'] === 'markdown'
        ? (body['format'] as ChannelBodyFormat)
        : undefined;
    const parentMessageId =
      typeof body['parentMessageId'] === 'string'
        ? body['parentMessageId']
        : undefined;
    const clientMessageId =
      typeof body['clientMessageId'] === 'string'
        ? body['clientMessageId']
        : undefined;

    const sender = deriveSender(req);

    // clientMessageId idempotency: return the existing row without re-broadcast.
    if (clientMessageId) {
      const existing = store.findByClientMessage(
        id,
        sender.id,
        clientMessageId
      );
      if (existing) {
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
        text,
        ...(format ? { format } : {}),
        ...(parentMessageId ? { parentMessageId } : {}),
        ...(clientMessageId ? { clientMessageId } : {}),
        mentions,
      });
      res.status(201).json({ message });
    } catch (error) {
      mapStoreError(res, error);
    }
  });

  return router;
}
