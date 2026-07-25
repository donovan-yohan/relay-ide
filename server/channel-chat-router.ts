import { existsSync } from 'node:fs';

import { Router } from 'express';
import type { Request, RequestHandler, Response } from 'express';
import multer from 'multer';

import type { RelayCliGatewayErrorCode } from '../shared/cli-gateway-contract.js';
import {
  authenticatedCliGatewayActorCredential,
  type CliGatewayActorReadCommand,
  type CliGatewayActorWriteCommand,
} from './cli-gateway-actor-auth.js';
import {
  CHANNEL_HISTORY_DEFAULT_LIMIT,
  CHANNEL_HISTORY_MAX_LIMIT,
  ChannelMessageStoreError,
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
  ChannelAgentNoActiveTurnError,
  ChannelAgentNotFoundError,
  type ChannelAgentBinder,
} from './channel-agent-binder.js';
import type { WorkspaceTopicStore } from './workspace-topics.js';
import type { WorkspaceTopic } from '../shared/workspace-topics.js';
import type { AgentApprovalDecisionV2 } from '../shared/agent-chat-protocol-v2.js';
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
  /** Live session lookup used to authenticate privileged source attribution. */
  getSession?: (
    sessionId: string
  ) => { role?: string; status?: string } | undefined;
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

/**
 * Persistent-orchestrator credentials use their actor id as authoritative
 * backing-session provenance. Other actor credentials stay unattributed and
 * therefore remain subject to the ordinary agent brake.
 */
export function authenticatedSourceSessionId(
  credential: ReturnType<typeof authenticatedCliGatewayActorCredential>,
  getSession: ChannelChatRouterDeps['getSession']
): string | undefined {
  if (credential?.metadata?.reason !== 'persistent-orchestrator') {
    return undefined;
  }
  const session = getSession?.(credential.actor.id);
  return session?.role === 'orchestrator' ? credential.actor.id : undefined;
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
    sourceSessionId?: string;
    text: string;
    format?: ChannelBodyFormat;
    parentMessageId?: string;
    clientMessageId?: string;
    mentions: ReturnType<typeof parseMentions>;
    parts?: import('../shared/channel-chat-protocol.js').ChannelMessagePart[];
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
    ...(input.sourceSessionId
      ? { source: { sessionId: input.sourceSessionId } }
      : {}),
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
  const threadHistoryAuth =
    deps.requireReadActorAuth?.('channels.threads.history') ?? auth;
  const postAuth = deps.requireWriteActorAuth?.('channels.post') ?? auth;
  const rosterAuth = deps.requireReadActorAuth?.('channels.roster') ?? auth;
  const interruptAuth =
    deps.requireWriteActorAuth?.('channels.interrupt') ?? auth;
  const approvalAuth =
    deps.requireWriteActorAuth?.('channels.respond-approval') ?? auth;
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
      const direction = filter.afterSeq !== undefined ? 'forward' : 'backward';
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

  router.post('/channels/:id/attachments', postAuth, (req, res) => {
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

  router.get(
    '/channels/:id/attachments/:attachmentId',
    historyAuth,
    (req, res) => {
      if (denyMissingCapability(req, res, [CONTEXT_READ])) return;
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
    }
  );

  router.get(
    '/channels/:id/threads/:rootMessageId',
    threadHistoryAuth,
    (req, res) => {
      if (denyMissingCapability(req, res, [CONTEXT_READ])) return;
      const store = storeOr503(res, deps.store);
      if (!store) return;
      const id = req.params['id'] ?? '';
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
    if (text.length === 0 && parts.length === 0) {
      sendGatewayError(
        res,
        'INVALID_ARGUMENT',
        'text or at least one image part is required',
        false,
        { fields: ['text', 'parts'] }
      );
      return;
    }
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

    const sender = deriveSender(req);
    const sourceSessionId = authenticatedSourceSessionId(
      authenticatedCliGatewayActorCredential(req),
      deps.getSession
    );

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
        ...(sourceSessionId ? { sourceSessionId } : {}),
        text,
        ...(format ? { format } : {}),
        ...(parentMessageId ? { parentMessageId } : {}),
        ...(clientMessageId ? { clientMessageId } : {}),
        mentions,
        ...(parts.length ? { parts } : {}),
      });
      res.status(201).json({ message });
    } catch (error) {
      mapStoreError(res, error);
    }
  });

  // #1167 §2: per-request agent roster (framework availability + live binding
  // status). Derived per request — no persistent handle registry.
  router.get('/channels/:id/roster', rosterAuth, (req, res) => {
    if (denyMissingCapability(req, res, [CONTEXT_READ])) return;
    if (!storeOr503(res, deps.store)) return;
    const topic = requirePersistedChannel(req, res);
    if (!topic) return;
    const binder = binderOr503(res, deps.binder);
    if (!binder) return;
    binder
      .rosterForChannel(topic.id)
      .then((roster) => res.json({ roster }))
      .catch((error) => mapStoreError(res, error));
  });

  // #1167 §7: interrupt the agent's active turn.
  router.post(
    '/channels/:id/agents/:agentId/interrupt',
    interruptAuth,
    (req, res) => {
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

  // #1167 §7: respond to an in-channel approval request.
  router.post(
    '/channels/:id/agents/:agentId/approvals',
    approvalAuth,
    (req, res) => {
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
