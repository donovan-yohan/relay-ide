import { Router } from 'express';
import type { Request, RequestHandler, Response } from 'express';

import type { RelayCliGatewayErrorCode } from '../../shared/cli-gateway-contract.js';
import {
  PR_OVERSEER_STATUSES,
  PrOverseerValidationError,
  prOverseerSummaryPayload,
  type PrObservation,
  type PrOverseerRecord,
  type PrOverseerStatus,
} from '../../shared/pr-overseer.js';
import type { WorkContextId } from '../../shared/work-context.js';
import type { CliGatewayActorWriteCommand } from '../cli-gateway-actor-auth.js';
import type { CliGatewayEventBus } from '../cli-gateway-event-bus.js';
import type { WorkContextStore } from '../work-contexts.js';
import { PrOverseerStoreError, type PrOverseerStore } from '../pr-overseer.js';
import type { PrObserver } from '../pr-overseer-github.js';

const CONTEXT_READ = 'context:read';
const CONTEXT_WRITE = 'context:write';

export interface PrOverseerRouterDeps {
  store: PrOverseerStore | null;
  /**
   * Fetches a fresh GitHub snapshot on `observe`. Injected so the store stays
   * network-free and tests can supply synthetic PR state. Absent → `observe`
   * still refreshes the heartbeat but records no new evidence (bare heartbeat).
   */
  observer?: PrObserver | undefined;
  workContextStore?: WorkContextStore | null;
  requireAuth?: RequestHandler;
  requireReadAuth?: {
    list?: RequestHandler;
    get?: RequestHandler;
  };
  requireWriteActorAuth?: (
    expectedCommand: CliGatewayActorWriteCommand,
    options?: {
      scopeForRequest?: (req: Request) => { workContextIds?: string[] } | undefined;
      deferWorkContextScope?: boolean;
    }
  ) => RequestHandler;
  events?: Pick<CliGatewayEventBus, 'publish'>;
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

function sendGatewayError(
  res: Response,
  code: RelayCliGatewayErrorCode,
  message: string,
  retryable = false,
  details?: Record<string, unknown>
): void {
  const status =
    code === 'NOT_FOUND'
      ? 404
      : code === 'FORBIDDEN'
        ? 403
        : code === 'SESSION_CONFLICT'
          ? 409
          : code === 'SERVER_UNAVAILABLE'
            ? 503
            : code === 'INTERNAL'
              ? 500
              : 400;
  res.status(status).json({ error: { code, message, retryable, ...(details ? { details } : {}) } });
}

function denyMissingCapability(req: Request, res: Response, required: string[]): boolean {
  const caps = parseCapabilityHeader(req.header('x-relay-capabilities'));
  const missing = required.filter((cap) => !caps.has(cap));
  if (missing.length === 0) return false;
  sendGatewayError(res, 'FORBIDDEN', `missing required capability: ${missing.join(', ')}`, false, {
    capability: missing[0],
  });
  return true;
}

function bodyRecord(req: Request): Record<string, unknown> {
  return req.body && typeof req.body === 'object' && !Array.isArray(req.body)
    ? (req.body as Record<string, unknown>)
    : {};
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readLimit(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, 100) : undefined;
}

function readStatus(value: unknown): PrOverseerStatus | undefined {
  return typeof value === 'string' && (PR_OVERSEER_STATUSES as readonly string[]).includes(value)
    ? (value as PrOverseerStatus)
    : undefined;
}

function storeOr503(res: Response, store: PrOverseerStore | null): PrOverseerStore | null {
  if (store) return store;
  sendGatewayError(res, 'SERVER_UNAVAILABLE', 'pr overseer store is unavailable', true, {
    reasonCode: 'PR_OVERSEER_STORE_UNAVAILABLE',
  });
  return null;
}

function ensureWorkContext(
  res: Response,
  store: WorkContextStore | null | undefined,
  workContextId: WorkContextId | undefined
): boolean {
  if (!workContextId || !store) return true;
  if (store.get(workContextId)) return true;
  sendGatewayError(res, 'NOT_FOUND', 'WorkContext not found', false, { workContextId });
  return false;
}

function mapError(res: Response, error: unknown, operation: string): void {
  if (error instanceof PrOverseerValidationError) {
    sendGatewayError(res, 'INVALID_ARGUMENT', error.message, false, {
      reasonCode: 'PR_OVERSEER_VALIDATION_FAILED',
      operation,
      ...error.details,
    });
    return;
  }
  if (error instanceof PrOverseerStoreError) {
    const code: RelayCliGatewayErrorCode =
      error.status === 404 ? 'NOT_FOUND' : error.status === 409 ? 'SESSION_CONFLICT' : 'INTERNAL';
    sendGatewayError(res, code, error.message, false, {
      reasonCode: error.code.toUpperCase(),
      operation,
      ...error.details,
    });
    return;
  }
  sendGatewayError(res, 'INTERNAL', 'pr overseer operation failed', true, { operation });
}

function emitEvent(
  events: Pick<CliGatewayEventBus, 'publish'> | undefined,
  type: string,
  record: PrOverseerRecord,
  previousStatus?: PrOverseerStatus
): void {
  events?.publish({
    topic: 'pr-overseer',
    type,
    ...(record.workContextId ? { workContextId: record.workContextId } : {}),
    ...(record.session?.sessionId ? { sessionId: record.session.sessionId } : {}),
    ...(record.session?.globalSessionId ? { globalSessionId: record.session.globalSessionId } : {}),
    payload: {
      ...prOverseerSummaryPayload(record),
      ...(previousStatus ? { previousStatus } : {}),
    },
  });
}

export function createPrOverseerRouter(deps: PrOverseerRouterDeps): Router {
  const router = Router();
  const auth = deps.requireAuth ?? ((_req: Request, _res: Response, next) => next());
  const readAuth = deps.requireReadAuth ?? {};
  const writeAuth = (
    command: CliGatewayActorWriteCommand,
    scopeForRequest?: (req: Request) => { workContextIds?: string[] } | undefined
  ): RequestHandler =>
    deps.requireWriteActorAuth?.(command, scopeForRequest ? { scopeForRequest } : undefined) ?? auth;

  const registerScope = (req: Request) => {
    const body = bodyRecord(req);
    const bodyWorkContextId = readString(body['workContextId']);
    // Require authorization for BOTH the requested and the existing run's
    // WorkContext so a scoped credential cannot overwrite/revive a run that
    // belongs to another WorkContext by re-registering its id (the store also
    // enforces workContextId immutability).
    const id = readString(body['id']);
    const existingWorkContextId = id && deps.store ? deps.store.get(id)?.workContextId : undefined;
    const workContextIds = [
      ...new Set([bodyWorkContextId, existingWorkContextId].filter((v): v is string => Boolean(v))),
    ];
    return workContextIds.length ? { workContextIds } : undefined;
  };
  const runScope = (req: Request) => {
    const id = req.params['id'] ?? '';
    const run = id && deps.store ? deps.store.get(id) : null;
    return run?.workContextId ? { workContextIds: [run.workContextId] } : undefined;
  };

  router.post('/pr-overseers', writeAuth('pr-overseer.register', registerScope), (req, res) => {
    if (denyMissingCapability(req, res, [CONTEXT_WRITE])) return;
    const s = storeOr503(res, deps.store);
    if (!s) return;
    const workContextId = readString(bodyRecord(req)['workContextId']) as WorkContextId | undefined;
    if (!ensureWorkContext(res, deps.workContextStore, workContextId)) return;
    try {
      const record = s.register(bodyRecord(req));
      emitEvent(deps.events, 'pr-overseer.registered', record);
      res.status(201).json({ prOverseer: record });
    } catch (error) {
      mapError(res, error, 'register');
    }
  });

  router.post(
    '/pr-overseers/:id/observe',
    writeAuth('pr-overseer.observe', runScope),
    async (req, res) => {
      if (denyMissingCapability(req, res, [CONTEXT_WRITE])) return;
      const s = storeOr503(res, deps.store);
      if (!s) return;
      const id = req.params['id'] ?? '';
      const existing = s.get(id);
      if (!existing) {
        sendGatewayError(res, 'NOT_FOUND', 'pr overseer not found', false, { prOverseerId: id });
        return;
      }
      if (!ensureWorkContext(res, deps.workContextStore, existing.workContextId)) return;

      // Fetch fresh GitHub evidence (async, network) BEFORE the sync store write.
      // The observer never throws; a defensive catch maps an unexpected throw to a
      // failed-fetch snapshot so a transient error never 500s the observe.
      let observation: PrObservation | undefined;
      if (deps.observer) {
        try {
          observation = await deps.observer({
            ownerRepo: existing.pr.ownerRepo,
            number: existing.pr.number,
            ...(existing.repoPath ? { repoPath: existing.repoPath } : {}),
          });
        } catch {
          observation = { ok: false, fetchedAt: new Date().toISOString(), unavailableReason: 'error' };
        }
      }

      try {
        const record = s.observe(id, bodyRecord(req), observation);
        emitEvent(deps.events, 'pr-overseer.observed', record, existing.status);
        if (record.status !== existing.status) {
          emitEvent(deps.events, 'pr-overseer.status-changed', record, existing.status);
        }
        res.json({ prOverseer: record });
      } catch (error) {
        mapError(res, error, 'observe');
      }
    }
  );

  router.post('/pr-overseers/:id/retire', writeAuth('pr-overseer.retire', runScope), (req, res) => {
    if (denyMissingCapability(req, res, [CONTEXT_WRITE])) return;
    const s = storeOr503(res, deps.store);
    if (!s) return;
    const id = req.params['id'] ?? '';
    const existing = s.get(id);
    if (!existing) {
      sendGatewayError(res, 'NOT_FOUND', 'pr overseer not found', false, { prOverseerId: id });
      return;
    }
    if (!ensureWorkContext(res, deps.workContextStore, existing.workContextId)) return;
    try {
      const record = s.retire(id, bodyRecord(req));
      if (existing.cleanup.state !== 'retired') {
        emitEvent(deps.events, 'pr-overseer.retired', record, existing.status);
      }
      res.json({ prOverseer: record });
    } catch (error) {
      mapError(res, error, 'retire');
    }
  });

  router.get('/pr-overseers', readAuth.list ?? auth, (req, res) => {
    if (denyMissingCapability(req, res, [CONTEXT_READ])) return;
    const s = storeOr503(res, deps.store);
    if (!s) return;
    const workContextId = readString(req.query['workContextId']);
    const repoPath = readString(req.query['repoPath']);
    const status = readStatus(req.query['status']);
    const orchestrator = readString(req.query['orchestrator']);
    const ownerRepo = readString(req.query['ownerRepo']);
    const includeRetired = req.query['includeRetired'] === 'true';
    const limit = readLimit(req.query['limit']);
    res.json({
      prOverseers: s.list({
        ...(workContextId ? { workContextId } : {}),
        ...(repoPath ? { repoPath } : {}),
        ...(status ? { status } : {}),
        ...(orchestrator ? { orchestrator } : {}),
        ...(ownerRepo ? { ownerRepo } : {}),
        ...(includeRetired ? { includeRetired } : {}),
        ...(limit ? { limit } : {}),
      }),
    });
  });

  router.get('/pr-overseers/:id', readAuth.get ?? auth, (req, res) => {
    if (denyMissingCapability(req, res, [CONTEXT_READ])) return;
    const s = storeOr503(res, deps.store);
    if (!s) return;
    const currentHeadSha = readString(req.query['currentHeadSha']);
    const record = s.get(req.params['id'] ?? '', currentHeadSha ? { currentHeadSha } : {});
    if (!record) {
      sendGatewayError(res, 'NOT_FOUND', 'pr overseer not found', false, {
        prOverseerId: req.params['id'] ?? '',
      });
      return;
    }
    res.json({ prOverseer: record });
  });

  return router;
}
