import { Router } from 'express';
import type { Request, RequestHandler, Response } from 'express';

import type { RelayCliGatewayErrorCode } from '../../shared/cli-gateway-contract.js';
import {
  AUTOMATION_RUN_KINDS,
  AUTOMATION_RUN_STATUSES,
  AutomationRunValidationError,
  automationRunSummaryPayload,
  type AutomationRunKind,
  type AutomationRunLivenessResolver,
  type AutomationRunRecord,
  type AutomationRunStatus,
} from '../../shared/automation-run.js';
import type { WorkContextId } from '../../shared/work-context.js';
import type { CliGatewayActorWriteCommand } from '../cli-gateway-actor-auth.js';
import type { CliGatewayEventBus } from '../cli-gateway-event-bus.js';
import type { WorkContextStore } from '../work-contexts.js';
import { AutomationRunStoreError, type AutomationRunStore } from '../automation-runs.js';

const CONTEXT_READ = 'context:read';
const CONTEXT_WRITE = 'context:write';

export interface AutomationRunRouterDeps {
  store: AutomationRunStore | null;
  /**
   * Resolves a target session's current liveness against the live session
   * registry. Injected so reads/writes reflect whether a watcher's target
   * session still exists (the #959 stale-target detection). Absent → targets
   * stay at their last-observed state.
   */
  resolveLiveness?: AutomationRunLivenessResolver;
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

function readStatus(value: unknown): AutomationRunStatus | undefined {
  return typeof value === 'string' && (AUTOMATION_RUN_STATUSES as readonly string[]).includes(value)
    ? (value as AutomationRunStatus)
    : undefined;
}

function readKind(value: unknown): AutomationRunKind | undefined {
  return typeof value === 'string' && (AUTOMATION_RUN_KINDS as readonly string[]).includes(value)
    ? (value as AutomationRunKind)
    : undefined;
}

function storeOr503(res: Response, store: AutomationRunStore | null): AutomationRunStore | null {
  if (store) return store;
  sendGatewayError(res, 'SERVER_UNAVAILABLE', 'automation run store is unavailable', true, {
    reasonCode: 'AUTOMATION_RUN_STORE_UNAVAILABLE',
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
  if (error instanceof AutomationRunValidationError) {
    sendGatewayError(res, 'INVALID_ARGUMENT', error.message, false, {
      reasonCode: 'AUTOMATION_RUN_VALIDATION_FAILED',
      operation,
      ...error.details,
    });
    return;
  }
  if (error instanceof AutomationRunStoreError) {
    const code: RelayCliGatewayErrorCode =
      error.status === 404 ? 'NOT_FOUND' : error.status === 409 ? 'SESSION_CONFLICT' : 'INTERNAL';
    sendGatewayError(res, code, error.message, false, {
      reasonCode: error.code.toUpperCase(),
      operation,
      ...error.details,
    });
    return;
  }
  sendGatewayError(res, 'INTERNAL', 'automation run operation failed', true, { operation });
}

function emitRunEvent(
  events: Pick<CliGatewayEventBus, 'publish'> | undefined,
  type: string,
  run: AutomationRunRecord,
  previousStatus?: AutomationRunStatus
): void {
  events?.publish({
    topic: 'automation-runs',
    type,
    ...(run.workContextId ? { workContextId: run.workContextId } : {}),
    ...(run.targets[0]?.sessionId ? { sessionId: run.targets[0].sessionId } : {}),
    ...(run.targets[0]?.globalSessionId
      ? { globalSessionId: run.targets[0].globalSessionId }
      : {}),
    payload: {
      ...automationRunSummaryPayload(run),
      ...(previousStatus ? { previousStatus } : {}),
    },
  });
}

export function createAutomationRunRouter(deps: AutomationRunRouterDeps): Router {
  const router = Router();
  const auth = deps.requireAuth ?? ((_req: Request, _res: Response, next) => next());
  const readAuth = deps.requireReadAuth ?? {};
  const resolver = deps.resolveLiveness;
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
    const existingWorkContextId =
      id && deps.store ? deps.store.get(id)?.workContextId : undefined;
    const workContextIds = [...new Set([bodyWorkContextId, existingWorkContextId].filter(
      (value): value is string => Boolean(value)
    ))];
    return workContextIds.length ? { workContextIds } : undefined;
  };
  const runScope = (req: Request) => {
    const id = req.params['id'] ?? '';
    const run = id && deps.store ? deps.store.get(id) : null;
    return run?.workContextId ? { workContextIds: [run.workContextId] } : undefined;
  };

  router.post('/automation-runs', writeAuth('automation-runs.register', registerScope), (req, res) => {
    if (denyMissingCapability(req, res, [CONTEXT_WRITE])) return;
    const s = storeOr503(res, deps.store);
    if (!s) return;
    const workContextId = readString(bodyRecord(req)['workContextId']) as WorkContextId | undefined;
    if (!ensureWorkContext(res, deps.workContextStore, workContextId)) return;
    try {
      const run = s.register(bodyRecord(req), resolver);
      emitRunEvent(deps.events, 'automation-run.registered', run);
      res.status(201).json({ automationRun: run });
    } catch (error) {
      mapError(res, error, 'register');
    }
  });

  router.post(
    '/automation-runs/:id/observe',
    writeAuth('automation-runs.observe', runScope),
    (req, res) => {
      if (denyMissingCapability(req, res, [CONTEXT_WRITE])) return;
      const s = storeOr503(res, deps.store);
      if (!s) return;
      const id = req.params['id'] ?? '';
      const existing = s.get(id);
      if (!existing) {
        sendGatewayError(res, 'NOT_FOUND', 'automation run not found', false, { automationRunId: id });
        return;
      }
      if (!ensureWorkContext(res, deps.workContextStore, existing.workContextId)) return;
      try {
        const run = s.observe(id, bodyRecord(req), resolver);
        emitRunEvent(deps.events, 'automation-run.observed', run, existing.status);
        if (run.status !== existing.status) {
          emitRunEvent(deps.events, 'automation-run.status-changed', run, existing.status);
        }
        res.json({ automationRun: run });
      } catch (error) {
        mapError(res, error, 'observe');
      }
    }
  );

  router.post(
    '/automation-runs/:id/retire',
    writeAuth('automation-runs.retire', runScope),
    (req, res) => {
      if (denyMissingCapability(req, res, [CONTEXT_WRITE])) return;
      const s = storeOr503(res, deps.store);
      if (!s) return;
      const id = req.params['id'] ?? '';
      const existing = s.get(id);
      if (!existing) {
        sendGatewayError(res, 'NOT_FOUND', 'automation run not found', false, { automationRunId: id });
        return;
      }
      if (!ensureWorkContext(res, deps.workContextStore, existing.workContextId)) return;
      try {
        const run = s.retire(id, bodyRecord(req));
        if (existing.status !== 'retired') {
          emitRunEvent(deps.events, 'automation-run.retired', run, existing.status);
        }
        res.json({ automationRun: run });
      } catch (error) {
        mapError(res, error, 'retire');
      }
    }
  );

  router.get('/automation-runs', readAuth.list ?? auth, (req, res) => {
    if (denyMissingCapability(req, res, [CONTEXT_READ])) return;
    const s = storeOr503(res, deps.store);
    if (!s) return;
    const workContextId = readString(req.query['workContextId']);
    const repoPath = readString(req.query['repoPath']);
    const status = readStatus(req.query['status']);
    const kind = readKind(req.query['kind']);
    const orchestrator = readString(req.query['orchestrator']);
    const includeRetired = req.query['includeRetired'] === 'true';
    const limit = readLimit(req.query['limit']);
    res.json({
      automationRuns: s.list(
        {
          ...(workContextId ? { workContextId } : {}),
          ...(repoPath ? { repoPath } : {}),
          ...(status ? { status } : {}),
          ...(kind ? { kind } : {}),
          ...(orchestrator ? { orchestrator } : {}),
          ...(includeRetired ? { includeRetired } : {}),
          ...(limit ? { limit } : {}),
        },
        resolver
      ),
    });
  });

  router.get('/automation-runs/:id', readAuth.get ?? auth, (req, res) => {
    if (denyMissingCapability(req, res, [CONTEXT_READ])) return;
    const s = storeOr503(res, deps.store);
    if (!s) return;
    const run = s.get(req.params['id'] ?? '', resolver);
    if (!run) {
      sendGatewayError(res, 'NOT_FOUND', 'automation run not found', false, {
        automationRunId: req.params['id'] ?? '',
      });
      return;
    }
    res.json({ automationRun: run });
  });

  return router;
}
