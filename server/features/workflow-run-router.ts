import { Router } from 'express';
import type { Request, RequestHandler, Response } from 'express';

import type { RelayCliGatewayErrorCode } from '../../shared/cli-gateway-contract.js';
import {
  WORKFLOW_RUN_STATES,
  WorkflowRunValidationError,
  workflowRunSummaryPayload,
  type WorkflowRunProjection,
  type WorkflowRunState,
} from '../../shared/workflow-run.js';
import type { WorkContextId } from '../../shared/work-context.js';
import type { CliGatewayEventBus } from '../cli-gateway-event-bus.js';
import type { CliGatewayActorWriteCommand } from '../cli-gateway-actor-auth.js';
import type { WorkContextStore } from '../work-contexts.js';
import {
  WorkflowRunStoreError,
  type WorkflowRunStore,
} from '../workflow-runs.js';

const CONTEXT_READ = 'context:read';
const CONTEXT_WRITE = 'context:write';

export interface WorkflowRunRouterDeps {
  store: WorkflowRunStore | null;
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
  return new Set(value.split(/[\s,]+/).map((entry) => entry.trim()).filter(Boolean));
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

function readState(value: unknown): WorkflowRunState | undefined {
  return typeof value === 'string' && (WORKFLOW_RUN_STATES as readonly string[]).includes(value)
    ? (value as WorkflowRunState)
    : undefined;
}

function storeOr503(res: Response, store: WorkflowRunStore | null): WorkflowRunStore | null {
  if (store) return store;
  sendGatewayError(res, 'SERVER_UNAVAILABLE', 'workflow run store is unavailable', true, {
    reasonCode: 'WORKFLOW_RUN_STORE_UNAVAILABLE',
  });
  return null;
}

function ensureWorkContext(
  res: Response,
  store: WorkContextStore | null | undefined,
  workContextId: WorkContextId
): boolean {
  if (!store) return true;
  if (store.get(workContextId)) return true;
  sendGatewayError(res, 'NOT_FOUND', 'WorkContext not found', false, { workContextId });
  return false;
}

function mapError(res: Response, error: unknown, operation: string): void {
  if (error instanceof WorkflowRunValidationError) {
    sendGatewayError(res, 'INVALID_ARGUMENT', error.message, false, {
      reasonCode: 'WORKFLOW_RUN_VALIDATION_FAILED',
      operation,
      ...error.details,
    });
    return;
  }
  if (error instanceof WorkflowRunStoreError) {
    const code: RelayCliGatewayErrorCode =
      error.status === 404 ? 'NOT_FOUND' : error.status === 409 ? 'SESSION_CONFLICT' : 'INTERNAL';
    sendGatewayError(res, code, error.message, false, {
      reasonCode: error.code.toUpperCase(),
      operation,
      ...error.details,
    });
    return;
  }
  sendGatewayError(res, 'INTERNAL', 'workflow run operation failed', true, { operation });
}

function emitRunEvent(
  events: Pick<CliGatewayEventBus, 'publish'> | undefined,
  type: string,
  run: WorkflowRunProjection,
  previousState?: WorkflowRunState
): void {
  events?.publish({
    topic: 'workflow-runs',
    type,
    workContextId: run.workContextId,
    ...(run.links?.sessionIds?.[0] ? { sessionId: run.links.sessionIds[0] } : {}),
    ...(run.links?.globalSessionIds?.[0] ? { globalSessionId: run.links.globalSessionIds[0] } : {}),
    payload: {
      ...workflowRunSummaryPayload(run),
      ...(previousState ? { previousState } : {}),
    },
  });
}

export function createWorkflowRunRouter(deps: WorkflowRunRouterDeps): Router {
  const router = Router();
  const auth = deps.requireAuth ?? ((_req: Request, _res: Response, next) => next());
  const readAuth = deps.requireReadAuth ?? {};
  const writeAuth = (
    command: CliGatewayActorWriteCommand,
    scopeForRequest?: (req: Request) => { workContextIds?: string[] } | undefined
  ): RequestHandler =>
    deps.requireWriteActorAuth?.(
      command,
      scopeForRequest ? { scopeForRequest } : undefined
    ) ?? auth;

  const publishScope = (req: Request) => {
    const workContextId = readString(bodyRecord(req)['workContextId']);
    return workContextId ? { workContextIds: [workContextId] } : undefined;
  };
  const runScope = (req: Request) => {
    const id = req.params['id'] ?? '';
    const workflowRun = id && deps.store ? deps.store.get(id) : null;
    return workflowRun ? { workContextIds: [workflowRun.workContextId] } : undefined;
  };

  router.post('/workflow-runs', writeAuth('workflow-runs.publish', publishScope), (req, res) => {
    if (denyMissingCapability(req, res, [CONTEXT_WRITE])) return;
    const s = storeOr503(res, deps.store);
    if (!s) return;
    const workContextId = readString(bodyRecord(req)['workContextId']);
    if (!workContextId) {
      sendGatewayError(res, 'INVALID_ARGUMENT', 'workContextId is required', false, {
        field: 'workContextId',
      });
      return;
    }
    if (!ensureWorkContext(res, deps.workContextStore, workContextId)) return;
    try {
      const workflowRun = s.publish(bodyRecord(req));
      emitRunEvent(deps.events, 'workflow-run.published', workflowRun);
      res.status(201).json({ workflowRun });
    } catch (error) {
      mapError(res, error, 'publish');
    }
  });

  router.patch('/workflow-runs/:id', writeAuth('workflow-runs.update', runScope), (req, res) => {
    if (denyMissingCapability(req, res, [CONTEXT_WRITE])) return;
    const s = storeOr503(res, deps.store);
    if (!s) return;
    const id = req.params['id'] ?? '';
    const existing = s.get(id);
    if (!existing) {
      sendGatewayError(res, 'NOT_FOUND', 'workflow run not found', false, { workflowRunId: id });
      return;
    }
    if (!ensureWorkContext(res, deps.workContextStore, existing.workContextId)) return;
    try {
      const workflowRun = s.update(id, bodyRecord(req));
      emitRunEvent(deps.events, 'workflow-run.updated', workflowRun, existing.state);
      if (workflowRun.state !== existing.state) {
        emitRunEvent(deps.events, 'workflow-run.state-changed', workflowRun, existing.state);
      }
      res.json({ workflowRun });
    } catch (error) {
      mapError(res, error, 'update');
    }
  });

  router.get('/workflow-runs', readAuth.list ?? auth, (req, res) => {
    if (denyMissingCapability(req, res, [CONTEXT_READ])) return;
    const s = storeOr503(res, deps.store);
    if (!s) return;
    const workContextId = readString(req.query['workContextId']);
    if (!workContextId) {
      sendGatewayError(res, 'INVALID_ARGUMENT', 'workContextId is required', false, {
        field: 'workContextId',
      });
      return;
    }
    if (!ensureWorkContext(res, deps.workContextStore, workContextId)) return;
    const state = readState(req.query['state']);
    const providerRuntime = readString(req.query['providerRuntime']);
    const limit = readLimit(req.query['limit']);
    res.json({
      workflowRuns: s.list({
        workContextId,
        ...(state ? { state } : {}),
        ...(providerRuntime ? { providerRuntime } : {}),
        ...(limit ? { limit } : {}),
      }),
    });
  });

  router.get('/workflow-runs/:id', readAuth.get ?? auth, (req, res) => {
    if (denyMissingCapability(req, res, [CONTEXT_READ])) return;
    const s = storeOr503(res, deps.store);
    if (!s) return;
    const workflowRun = s.get(req.params['id'] ?? '');
    if (!workflowRun) {
      sendGatewayError(res, 'NOT_FOUND', 'workflow run not found', false, {
        workflowRunId: req.params['id'] ?? '',
      });
      return;
    }
    if (!ensureWorkContext(res, deps.workContextStore, workflowRun.workContextId)) return;
    res.json({ workflowRun });
  });

  return router;
}
