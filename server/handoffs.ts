import { createHash, randomUUID } from 'node:crypto';

import { Router, type RequestHandler } from 'express';

import {
  HANDOFF_SCHEMA_VERSION,
  isHandoffPlan,
  isHandoffRequest,
  type HandoffConflict,
  type HandoffPlan,
  type HandoffReasonCode,
  type HandoffRequest,
  type HandoffRequiredGrant,
} from '../shared/handoff.js';
import { proposeHandoffDestination } from '../shared/handoff-destination.js';
import {
  planHandoffSnapshot,
  type HandoffPlannerDryRun,
} from './handoff-planner.js';
import type { WorkContextStore } from './work-contexts.js';

export const HANDOFF_STATUS_MAX_CONFLICTS = 25;

const SESSION_READ_CAPABILITY = 'session:read';

export type HandoffApiErrorCode =
  | 'INVALID_REQUEST'
  | 'INVALID_WORK_CONTEXT_ID'
  | 'INVALID_SESSION_ID'
  | 'CAPABILITY_DENIED'
  | 'SOURCE_STALE_OR_OFFLINE'
  | 'DESTINATION_UNAVAILABLE'
  | 'HANDOFF_ARTIFACT_NOT_FOUND'
  | 'HANDOFF_INTERNAL_ERROR';

export interface HandoffApiErrorBody {
  error: {
    code: HandoffApiErrorCode;
    message: string;
    retryable: boolean;
    reasonCode?: HandoffReasonCode;
    details?: Record<string, unknown>;
  };
}

export interface HandoffPlanInput {
  request: HandoffRequest;
  sourceRepoPath?: string;
  approvedUntrackedPaths?: readonly string[];
  dryRun?: HandoffPlannerDryRun;
  sourceBranchName?: string;
  now?: string;
}

interface StoredPlan {
  plan: HandoffPlan;
}

export type HandoffCapabilityContext = readonly string[] | ReadonlySet<string>;

export type HandoffCapabilityProvider = (
  req: Parameters<RequestHandler>[0]
) => HandoffCapabilityContext | null | undefined;

export interface HandoffArtifactSummary {
  id: string;
  planId: string;
  group: 'plan-metadata';
  summary: string;
  refs: string[];
  sha256: string;
  rawPayloadAvailable: false;
  transcriptExportAvailable: false;
}

export interface HandoffServiceDeps {
  workContextStore?: Pick<WorkContextStore, 'get'>;
  getSession?: (nodeId: string, sessionId: string) => unknown | undefined;
  now?: () => Date;
  createId?: () => string;
}

function nowIso(deps: HandoffServiceDeps): string {
  return (deps.now?.() ?? new Date()).toISOString();
}

function createId(deps: HandoffServiceDeps): string {
  return deps.createId?.() ?? `handoff-plan-${randomUUID()}`;
}

function hashJson(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function apiError(
  code: HandoffApiErrorCode,
  message: string,
  status: number,
  details?: Record<string, unknown>,
  reasonCode?: HandoffReasonCode
): { status: number; body: HandoffApiErrorBody } {
  return {
    status,
    body: {
      error: {
        code,
        message,
        retryable:
          code === 'SOURCE_STALE_OR_OFFLINE' ||
          code === 'DESTINATION_UNAVAILABLE',
        ...(reasonCode ? { reasonCode } : {}),
        ...(details ? { details } : {}),
      },
    },
  };
}

function defaultRequiredGrants(
  request: HandoffRequest
): HandoffRequiredGrant[] {
  return [
    {
      leg: 'source-read',
      nodeId: request.source.nodeId,
      capability: 'rpc:fs:read',
      scope: { kind: 'path', pathPrefixes: [request.source.cwd] },
    },
    {
      leg: 'destination-write',
      nodeId: request.destination.nodeId,
      capability: 'rpc:fs:write',
      scope: { kind: 'path', pathPrefixes: [request.destination.cwd] },
    },
  ];
}

function dryRunConflictReason(
  conflicts: readonly HandoffConflict[]
): HandoffApiErrorCode | null {
  if (conflicts.some((entry) => entry.code === 'STALE_SOURCE'))
    return 'SOURCE_STALE_OR_OFFLINE';
  if (conflicts.some((entry) => entry.code === 'DESTINATION_UNAVAILABLE'))
    return 'DESTINATION_UNAVAILABLE';
  return null;
}

async function dryRunForPlan(
  input: HandoffPlanInput
): Promise<HandoffPlannerDryRun | undefined> {
  if (input.dryRun) return input.dryRun;
  if (!input.sourceRepoPath) return undefined;
  return planHandoffSnapshot({
    repoPath: input.sourceRepoPath,
    nodeId: input.request.source.nodeId,
    ...(input.approvedUntrackedPaths
      ? { approvedUntrackedPaths: input.approvedUntrackedPaths }
      : {}),
  });
}

function buildPlan(input: {
  id: string;
  request: HandoffRequest;
  dryRun?: HandoffPlannerDryRun;
  createdAt: string;
  sourceBranchName?: string;
}): HandoffPlan {
  const branchName =
    input.sourceBranchName ?? input.dryRun?.branchName ?? undefined;
  const destinationProposal = proposeHandoffDestination({
    source: input.request.source,
    destination: input.request.destination.option,
    ...(branchName ? { sourceBranchName: branchName } : {}),
  });
  return {
    schemaVersion: HANDOFF_SCHEMA_VERSION,
    id: input.id,
    requestId: input.request.id,
    createdAt: input.createdAt,
    source: input.request.source,
    route: {
      sourceNodeId: input.request.source.nodeId,
      destinationNodeId: input.request.destination.nodeId,
      workContextId: input.request.source.workContextId,
    },
    transferMode: input.dryRun?.transferMode ?? 'metadata-only',
    includedGroups: input.dryRun?.includedGroups ?? ['source-summary'],
    excludedGroups: input.dryRun?.excludedGroups ?? [],
    fileCount: input.dryRun?.fileCount ?? 0,
    byteCount: input.dryRun?.byteCount ?? 0,
    destinationProposal,
    pathMappings: [],
    conflicts: input.dryRun?.conflicts ?? [],
    requiredGrants: defaultRequiredGrants(input.request),
  };
}

export class HandoffService {
  private readonly plans = new Map<string, StoredPlan>();

  constructor(private readonly deps: HandoffServiceDeps = {}) {}

  async plan(
    input: HandoffPlanInput
  ): Promise<
    | { ok: true; plan: HandoffPlan; dryRun?: HandoffPlannerDryRun }
    | { ok: false; error: ReturnType<typeof apiError> }
  > {
    if (!isHandoffRequest(input.request)) {
      return {
        ok: false,
        error: apiError(
          'INVALID_REQUEST',
          'handoff request does not match shared schema',
          400
        ),
      };
    }
    if (
      this.deps.workContextStore &&
      !this.deps.workContextStore.get(input.request.source.workContextId)
    ) {
      return {
        ok: false,
        error: apiError(
          'INVALID_WORK_CONTEXT_ID',
          'source WorkContext was not found',
          404,
          { workContextId: input.request.source.workContextId }
        ),
      };
    }
    if (
      this.deps.getSession &&
      !this.deps.getSession(
        input.request.source.nodeId,
        input.request.source.sessionId
      )
    ) {
      return {
        ok: false,
        error: apiError(
          'INVALID_SESSION_ID',
          'source session was not found',
          404,
          {
            nodeId: input.request.source.nodeId,
            sessionId: input.request.source.sessionId,
          }
        ),
      };
    }
    const dryRun = await dryRunForPlan(input);
    const conflicts = dryRun?.conflicts ?? [];
    const reason = dryRunConflictReason(conflicts);
    if (reason) {
      return {
        ok: false,
        error: apiError(
          reason,
          'source or destination is not ready for handoff planning',
          reason === 'SOURCE_STALE_OR_OFFLINE' ? 409 : 503,
          { conflicts: conflicts.slice(0, HANDOFF_STATUS_MAX_CONFLICTS) },
          conflicts[0]?.reasonCode
        ),
      };
    }
    const plan = buildPlan({
      id: createId(this.deps),
      request: input.request,
      createdAt: input.now ?? nowIso(this.deps),
      ...(dryRun ? { dryRun } : {}),
      ...(input.sourceBranchName
        ? { sourceBranchName: input.sourceBranchName }
        : {}),
    });
    if (!isHandoffPlan(plan)) {
      return {
        ok: false,
        error: apiError(
          'HANDOFF_INTERNAL_ERROR',
          'constructed handoff plan failed shared schema validation',
          500
        ),
      };
    }
    this.plans.set(plan.id, { plan });
    return { ok: true, plan, ...(dryRun ? { dryRun } : {}) };
  }

  getPlan(planId: string): HandoffPlan | null {
    return this.plans.get(planId)?.plan ?? null;
  }

  readArtifact(ref: string): HandoffArtifactSummary | null {
    const plan = this.getPlan(ref);
    if (!plan) return null;
    return {
      id: ref,
      planId: ref,
      group: 'plan-metadata',
      summary: `read-only handoff plan ${ref} metadata reference`,
      refs: [plan.id, plan.requestId],
      sha256: hashJson(plan),
      rawPayloadAvailable: false,
      transcriptExportAvailable: false,
    };
  }
}

function bodyRecord(
  req: Parameters<RequestHandler>[0]
): Record<string, unknown> {
  return typeof req.body === 'object' &&
    req.body !== null &&
    !Array.isArray(req.body)
    ? (req.body as Record<string, unknown>)
    : {};
}

function capabilitySet(
  context: HandoffCapabilityContext | null | undefined
): Set<string> | null {
  if (!context) return null;
  const items = Array.isArray(context) ? context : Array.from(context);
  return new Set(items.map((item) => item.trim()).filter(Boolean));
}

function requireCapabilities(
  req: Parameters<RequestHandler>[0],
  capabilities: readonly string[],
  capabilityContext: HandoffCapabilityProvider
): ReturnType<typeof apiError> | null {
  const provided = capabilitySet(capabilityContext(req));
  if (!provided) {
    return apiError(
      'CAPABILITY_DENIED',
      'missing validated capability context for handoff route',
      403,
      { missingCapabilities: capabilities }
    );
  }
  const missing = capabilities.filter(
    (capability) => !provided.has(capability)
  );
  return missing.length
    ? apiError(
        'CAPABILITY_DENIED',
        `missing required capability: ${missing[0]}`,
        403,
        { missingCapabilities: missing }
      )
    : null;
}

export function createHandoffRouter(
  input: {
    service?: HandoffService;
    requireAuth?: RequestHandler;
    getCapabilities?: HandoffCapabilityProvider;
    workContextStore?: WorkContextStore;
    getSession?: (nodeId: string, sessionId: string) => unknown | undefined;
  } = {}
): Router {
  const router = Router();
  const auth = input.requireAuth ?? ((_req, _res, next) => next());
  const capabilityContext = input.getCapabilities ?? (() => null);
  const service =
    input.service ??
    new HandoffService({
      ...(input.workContextStore
        ? { workContextStore: input.workContextStore }
        : {}),
      ...(input.getSession ? { getSession: input.getSession } : {}),
    });

  router.post('/plan', auth, async (req, res) => {
    const denied = requireCapabilities(
      req,
      [SESSION_READ_CAPABILITY, 'rpc:fs:read'],
      capabilityContext
    );
    if (denied) {
      res.status(denied.status).json(denied.body);
      return;
    }
    const body = bodyRecord(req);
    const result = await service.plan({
      request: body['request'] as HandoffRequest,
      ...(typeof body['sourceRepoPath'] === 'string'
        ? { sourceRepoPath: body['sourceRepoPath'] }
        : {}),
      ...(Array.isArray(body['approvedUntrackedPaths'])
        ? { approvedUntrackedPaths: body['approvedUntrackedPaths'] as string[] }
        : {}),
      ...(typeof body['sourceBranchName'] === 'string'
        ? { sourceBranchName: body['sourceBranchName'] }
        : {}),
    });
    if (!result.ok) {
      res.status(result.error.status).json(result.error.body);
      return;
    }
    res.json({ plan: result.plan, dryRun: result.dryRun, readOnly: true });
  });

  router.get('/artifacts/:ref', auth, (req, res) => {
    const denied = requireCapabilities(
      req,
      [SESSION_READ_CAPABILITY],
      capabilityContext
    );
    if (denied) {
      res.status(denied.status).json(denied.body);
      return;
    }
    const artifact = service.readArtifact(req.params['ref'] ?? '');
    if (!artifact) {
      const error = apiError(
        'HANDOFF_ARTIFACT_NOT_FOUND',
        'handoff plan artifact ref was not found',
        404,
        { ref: req.params['ref'] }
      );
      res.status(error.status).json(error.body);
      return;
    }
    res.json({ artifact });
  });

  return router;
}
