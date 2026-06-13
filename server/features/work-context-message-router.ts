import { Router } from 'express';
import type { Request, RequestHandler, Response } from 'express';

import type { RelayCliGatewayErrorCode } from '../../shared/cli-gateway-contract.js';
import type {
  WorkContextMessageEnvelope,
  WorkContextMessageId,
  WorkContextMessageListFilter,
} from '../../shared/work-context-message.js';
import type { WorkContextStore } from '../work-contexts.js';
import type { CliGatewayEventBus } from '../cli-gateway-event-bus.js';
import {
  authenticatedCliGatewayActorCredential,
  type CliGatewayActorWriteCommand,
} from '../cli-gateway-actor-auth.js';
import {
  WorkContextMessageStoreError,
  type WorkContextMessageStore,
} from '../work-context-messages.js';

const CONTEXT_READ = 'context:read';
const CONTEXT_WRITE = 'context:write';

export interface WorkContextMessageRouterDeps {
  store: WorkContextMessageStore | null;
  workContextStore?: WorkContextStore;
  events?: Pick<CliGatewayEventBus, 'publish'>;
  requireAuth?: RequestHandler;
  requireReadAuth?: {
    list?: RequestHandler;
    show?: RequestHandler;
    query?: RequestHandler;
  };
  requireWriteActorAuth?: (
    expectedCommand: CliGatewayActorWriteCommand,
    options?: {
      scopeForRequest?: (req: Request) => { workContextIds?: string[] } | undefined;
      deferWorkContextScope?: boolean;
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

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
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
  details?: Record<string, unknown>
): void {
  const body: GatewayErrorBody = {
    error: { code, message, retryable, ...(details ? { details } : {}) },
  };
  res.status(statusForCode(code)).json(body);
}

function parseCapabilityHeader(value: string | undefined): Set<string> {
  if (!value) return new Set();
  return new Set(value.split(/[\s,]+/).map((entry) => entry.trim()).filter(Boolean));
}

function denyMissingCapability(req: Request, res: Response, required: readonly string[]): boolean {
  const provided = parseCapabilityHeader(req.header('x-relay-capabilities'));
  const actorCredential = authenticatedCliGatewayActorCredential(req);
  for (const capability of actorCredential?.capabilities ?? []) provided.add(capability);
  const missing = required.filter((capability) => !provided.has(capability));
  if (missing.length === 0) return false;
  sendGatewayError(res, 'FORBIDDEN', `missing required capability: ${missing[0]}`, false, {
    capability: missing[0],
    missingCapabilities: missing,
  });
  return true;
}

function bodyRecord(req: Request): Record<string, unknown> {
  return isRecord(req.body) ? req.body : {};
}

function storeOr503(res: Response, store: WorkContextMessageStore | null): WorkContextMessageStore | null {
  if (store) return store;
  sendGatewayError(res, 'SERVER_UNAVAILABLE', 'WorkContext message store unavailable', true, {
    reasonCode: 'WORK_CONTEXT_MESSAGE_STORE_UNAVAILABLE',
  });
  return null;
}

function ensureWorkContext(
  res: Response,
  workContextStore: WorkContextStore | undefined,
  workContextId: string
): boolean {
  if (!workContextStore) return true;
  if (workContextStore.get(workContextId)) return true;
  sendGatewayError(res, 'NOT_FOUND', 'WorkContext not found', false, { workContextId });
  return false;
}

function mapStoreError(res: Response, error: unknown): void {
  if (error instanceof WorkContextMessageStoreError) {
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
  sendGatewayError(res, 'INTERNAL', error instanceof Error ? error.message : String(error), false);
}

function parseLimit(value: unknown): number | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw === 'number' && Number.isFinite(raw)) return Math.max(1, Math.floor(raw));
  if (typeof raw !== 'string' || !raw.trim()) return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? Math.max(1, parsed) : undefined;
}

function filterFromQuery(query: Request['query']): WorkContextMessageListFilter {
  const filter: WorkContextMessageListFilter = {};
  for (const [queryKey, filterKey] of [
    ['workContextId', 'workContextId'],
    ['kind', 'kind'],
    ['senderId', 'senderId'],
    ['audienceKind', 'audienceKind'],
    ['audienceId', 'audienceId'],
    ['payloadSchema', 'payloadSchema'],
    ['threadId', 'threadId'],
    ['parentMessageId', 'parentMessageId'],
    ['refKind', 'refKind'],
    ['refValue', 'refValue'],
  ] as const) {
    const value = readString(query[queryKey]);
    if (value) filter[filterKey] = value as never;
  }
  const limit = parseLimit(query['limit']);
  if (limit !== undefined) filter.limit = limit;
  return filter;
}

function filterFromBody(body: Record<string, unknown>): WorkContextMessageListFilter {
  const source = isRecord(body['filter']) ? body['filter'] : body;
  const filter: WorkContextMessageListFilter = {};
  for (const key of [
    'workContextId',
    'kind',
    'senderId',
    'audienceKind',
    'audienceId',
    'payloadSchema',
    'threadId',
    'parentMessageId',
    'refKind',
    'refValue',
  ] as const) {
    const value = readString(source[key]);
    if (value) filter[key] = value as never;
  }
  const limit = parseLimit(source['limit']);
  if (limit !== undefined) filter.limit = limit;
  return filter;
}

function requireFilterScope(res: Response, filter: WorkContextMessageListFilter): boolean {
  if (filter.workContextId || (filter.refKind && filter.refValue) || filter.threadId || filter.parentMessageId) {
    return true;
  }
  sendGatewayError(
    res,
    'INVALID_ARGUMENT',
    'workContextId, threadId, parentMessageId, or refKind/refValue is required for bounded message queries',
    false,
    { fields: ['workContextId', 'threadId', 'parentMessageId', 'refKind', 'refValue'] }
  );
  return false;
}

function denyUnauthorizedActorWorkContextScope(
  req: Request,
  res: Response,
  workContextId: string,
  operation: string
): boolean {
  const credential = authenticatedCliGatewayActorCredential(req);
  if (!credential) return false;
  const scopedWorkContextIds = credential.scope.workContextIds;
  if (!scopedWorkContextIds?.length) return false;
  if (scopedWorkContextIds.includes(workContextId)) return false;
  sendGatewayError(
    res,
    'FORBIDDEN',
    'scoped CLI actor credential rejected: CLI_ACTOR_WRONG_WORK_CONTEXT_SCOPE',
    false,
    {
      reasonCode: 'CLI_ACTOR_WRONG_WORK_CONTEXT_SCOPE',
      operation,
      credentialId: credential.id,
    }
  );
  return true;
}

function readableMessagesOrDeny(
  req: Request,
  res: Response,
  messages: WorkContextMessageEnvelope[],
  operation: string
): WorkContextMessageEnvelope[] | null {
  const credential = authenticatedCliGatewayActorCredential(req);
  const scopedWorkContextIds = credential?.scope.workContextIds;
  if (!scopedWorkContextIds?.length) return messages;
  const denied = messages.find(
    (message) => !scopedWorkContextIds.includes(message.workContextId)
  );
  if (!denied) return messages;
  sendGatewayError(
    res,
    'FORBIDDEN',
    'scoped CLI actor credential rejected: CLI_ACTOR_WRONG_WORK_CONTEXT_SCOPE',
    false,
    {
      reasonCode: 'CLI_ACTOR_WRONG_WORK_CONTEXT_SCOPE',
      operation,
      credentialId: credential?.id,
    }
  );
  return null;
}

function actorSender(req: Request): { kind: 'agent' | 'human' | 'system'; id: string; displayName?: string } {
  const credential = authenticatedCliGatewayActorCredential(req);
  if (!credential) return { kind: 'system', id: 'relay-cli' };
  return {
    kind: 'agent',
    id: credential.actor.id,
    ...(credential.actor.displayName ? { displayName: credential.actor.displayName } : {}),
  };
}

function appendInput(req: Request): Record<string, unknown> {
  const body = bodyRecord(req);
  const sender = authenticatedCliGatewayActorCredential(req)
    ? actorSender(req)
    : isRecord(body['sender'])
      ? body['sender']
      : actorSender(req);
  return { ...body, sender };
}

function emitMessageEvent(
  events: Pick<CliGatewayEventBus, 'publish'> | undefined,
  message: WorkContextMessageEnvelope
): void {
  const sessionId = message.refs.sessions?.[0]?.globalSessionId ?? message.refs.sessions?.[0]?.sessionId;
  events?.publish({
    topic: 'context',
    type: 'work-context-message.appended',
    workContextId: message.workContextId,
    ...(sessionId ? { sessionId } : {}),
    payload: {
      messageId: message.id,
      kind: message.kind,
      summary: message.summary,
      ...(message.payloadSchema ? { payloadSchema: message.payloadSchema } : {}),
      ...(message.refs.threadId ? { threadId: message.refs.threadId } : {}),
      ...(message.refs.parentMessageId ? { parentMessageId: message.refs.parentMessageId } : {}),
      sender: { kind: message.sender.kind, id: message.sender.id },
    },
  });
}

export function createWorkContextMessageRouter(deps: WorkContextMessageRouterDeps): Router {
  const router = Router();
  const auth = deps.requireAuth ?? ((_req: Request, _res: Response, next) => next());
  const readAuth = deps.requireReadAuth ?? {};
  const appendAuth =
    deps.requireWriteActorAuth?.('work-context-messages.append', {
      scopeForRequest: (req) => {
        const workContextId = readString(bodyRecord(req)['workContextId']);
        return workContextId ? { workContextIds: [workContextId] } : undefined;
      },
    }) ?? auth;

  router.post('/work-context-messages', appendAuth, (req, res) => {
    if (denyMissingCapability(req, res, [CONTEXT_WRITE])) return;
    const store = storeOr503(res, deps.store);
    if (!store) return;
    const input = appendInput(req);
    const workContextId = readString(input['workContextId']);
    if (!workContextId) {
      sendGatewayError(res, 'INVALID_ARGUMENT', 'workContextId is required', false, { field: 'workContextId' });
      return;
    }
    if (!ensureWorkContext(res, deps.workContextStore, workContextId)) return;
    try {
      const message = store.append(input);
      emitMessageEvent(deps.events, message);
      res.status(201).json({ message });
    } catch (error) {
      mapStoreError(res, error);
    }
  });

  router.get('/work-context-messages', readAuth.list ?? auth, (req, res) => {
    if (denyMissingCapability(req, res, [CONTEXT_READ])) return;
    const store = storeOr503(res, deps.store);
    if (!store) return;
    const filter = filterFromQuery(req.query);
    if (!requireFilterScope(res, filter)) return;
    if (filter.workContextId) {
      if (denyUnauthorizedActorWorkContextScope(req, res, filter.workContextId, 'work-context-messages.list')) return;
      if (!ensureWorkContext(res, deps.workContextStore, filter.workContextId)) return;
    }
    try {
      const messages = readableMessagesOrDeny(
        req,
        res,
        store.list(filter),
        'work-context-messages.list'
      );
      if (!messages) return;
      res.json({ messages });
    } catch (error) {
      mapStoreError(res, error);
    }
  });

  router.post('/work-context-messages/query', readAuth.query ?? auth, (req, res) => {
    if (denyMissingCapability(req, res, [CONTEXT_READ])) return;
    const store = storeOr503(res, deps.store);
    if (!store) return;
    const filter = filterFromBody(bodyRecord(req));
    if (!requireFilterScope(res, filter)) return;
    if (filter.workContextId) {
      if (denyUnauthorizedActorWorkContextScope(req, res, filter.workContextId, 'work-context-messages.query')) return;
      if (!ensureWorkContext(res, deps.workContextStore, filter.workContextId)) return;
    }
    try {
      const messages = readableMessagesOrDeny(
        req,
        res,
        store.list(filter),
        'work-context-messages.query'
      );
      if (!messages) return;
      res.json({ messages, filter });
    } catch (error) {
      mapStoreError(res, error);
    }
  });

  router.get('/work-context-messages/:id', readAuth.show ?? auth, (req, res) => {
    if (denyMissingCapability(req, res, [CONTEXT_READ])) return;
    const store = storeOr503(res, deps.store);
    if (!store) return;
    const id = req.params['id'] as WorkContextMessageId | undefined;
    if (!id) {
      sendGatewayError(res, 'INVALID_ARGUMENT', 'message id is required', false, { field: 'id' });
      return;
    }
    try {
      const message = store.get(id);
      if (!message) {
        sendGatewayError(res, 'NOT_FOUND', 'WorkContext message not found', false, { messageId: id });
        return;
      }
      if (denyUnauthorizedActorWorkContextScope(req, res, message.workContextId, 'work-context-messages.show')) return;
      if (!ensureWorkContext(res, deps.workContextStore, message.workContextId)) return;
      res.json({ message });
    } catch (error) {
      mapStoreError(res, error);
    }
  });

  return router;
}
