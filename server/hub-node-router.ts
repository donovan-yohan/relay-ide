import * as express from 'express';
import { isFileRpcOperation } from '../shared/file-rpc.js';
import { normalizeHubFileRpcRequest } from './file-rpc.js';
import type { Request, Response } from 'express';
import { isNodeManifest, type NodeManifest } from '../shared/node-manifest.js';
import type {
  RepoInventoryDirtySummary,
  RepoInventoryDivergenceSummary,
  RepoInventoryRepoInstance,
  RepoInventoryReport,
  RepoInventoryWorktreeInstance,
} from '../shared/repo-inventory.js';
import type { SecurityAuditEntryInput } from '../shared/security-audit.js';
import {
  HubNodeRegistryError,
  type HubNodeRegistry,
} from './hub-node-registry.js';
import {
  RELAY_NODE_LINK_PROTOCOL_VERSION,
  type RelayNodeError,
} from '../shared/relay-node-protocol.js';
import {
  BOOTSTRAP_DIAGNOSTICS,
  generateBootstrapCommands,
  type BootstrapServiceMode,
} from '../shared/bootstrap-diagnostics.js';
import { HubNodeLinkError } from './hub-node-link.js';
import {
  createRepoInventoryFeature,
  type RepoInventoryFeature,
} from './features/repo-inventory.js';
import type { SessionSummary } from './types.js';
import {
  createGlobalSessionId,
  createRepoInstanceId,
  createWorktreeInstanceId,
} from '../shared/identity.js';
import {
  isControlFreshness,
  isControlMode,
  normalizeControlActor,
  normalizeControlStateSummary,
} from '../shared/control-state.js';
import {
  createRoutedNodeSessionEnvelope,
  isSessionEnvelope,
} from '../shared/session-envelope.js';
import {
  expiresAtFromLifecycleInput,
  lifecycleInputError,
  sessionEnvelopeRegistry,
  type InMemorySessionEnvelopeRegistry,
  type ScopedSessionSummary,
} from './session-envelope-registry.js';
import {
  appendPolicyAudit,
  evaluateHubPolicy,
  isSessionCreateType,
  policyDecisionToRelayError,
  requiredCapabilitiesForRpcIntent,
  revokePolicyAffectedSessions,
  sessionCreateCapability,
} from './hub-policy-evaluator.js';

interface HubNodeSessionTransport {
  hasActiveNode(nodeId: string): boolean;
  request(nodeId: string, type: string, payload: unknown): Promise<unknown>;
}

export interface RoutedSessionAuditSink {
  append(input: SecurityAuditEntryInput): unknown;
}

interface HubNodeRouterOptions {
  registry: HubNodeRegistry;
  requireAuth: express.RequestHandler;
  scopedSessionAuth?: express.RequestHandler;
  repoInventoryFeature?: RepoInventoryFeature;
  collectLocalRepoInventory?: () => Promise<RepoInventoryReport>;
  nodeLinks?: HubNodeSessionTransport;
  sessionEnvelopes?: InMemorySessionEnvelopeRegistry;
  auditSink?: RoutedSessionAuditSink;
  now?: () => Date;
}

function bearerToken(req: Request): string | null {
  const header = req.header('authorization') ?? '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

function optionalControlActorOk(value: unknown): boolean {
  return value === undefined || value === null || normalizeControlActor(value) !== undefined;
}

function optionalControlStringOk(value: unknown): boolean {
  return value === undefined || value === null || typeof value === 'string';
}

function controlSummaryFieldsOk(session: Partial<SessionSummary>): boolean {
  const activeActorsOk =
    session.activeActors === undefined ||
    (Array.isArray(session.activeActors) &&
      session.activeActors.every((actor) => normalizeControlActor(actor)));
  return (
    (session.controlMode === undefined || isControlMode(session.controlMode)) &&
    activeActorsOk &&
    optionalControlActorOk(session.activeWorker) &&
    optionalControlStringOk(session.lastInterventionAt) &&
    optionalControlActorOk(session.lastInterventionBy) &&
    optionalControlStringOk(session.lastInterventionEventId) &&
    (session.controlFreshness === undefined ||
      isControlFreshness(session.controlFreshness)) &&
    (session.controlReason === undefined || typeof session.controlReason === 'string')
  );
}

// Shared utilities exported for the repo feature router (and any other
// hub-side router that needs to surface relay-node-protocol errors
// consistently). Pure functions — no router or registry state.
export function errorStatus(error: RelayNodeError): number {
  switch (error.code) {
    case 'UNAUTHORIZED':
      return 401;
    case 'TOKEN_EXPIRED':
    case 'TOKEN_ALREADY_USED':
    case 'PROTOCOL_INCOMPATIBLE':
    case 'VERSION_SKEW':
    case 'NODE_UNSUPPORTED':
    case 'INVALID_REQUEST':
      return 400;
    case 'UNSUPPORTED_CAPABILITY':
    case 'NODE_REVOKED':
    case 'SESSION_EXPIRED':
    case 'SESSION_REVOKED':
    case 'SESSION_MISMATCH':
      return 403;
    case 'NOT_FOUND':
    case 'NODE_OFFLINE':
      return 404;
    default:
      return 500;
  }
}

export function sendRegistryError(
  registry: HubNodeRegistry,
  res: Response,
  error: unknown
): void {
  const body = registry.errorBody(error);
  res.status(errorStatus(body.error)).json(body);
}

export function relayError(
  code: RelayNodeError['code'],
  message: string,
  retryable = false,
  details?: Record<string, unknown>
): RelayNodeError {
  return { code, message, retryable, ...(details ? { details } : {}) };
}

export function sendRelayError(res: Response, error: RelayNodeError): void {
  res.status(errorStatus(error)).json({ error });
}

export function isSessionSummary(value: unknown): value is SessionSummary {
  if (typeof value !== 'object' || value === null) return false;
  const session = value as Partial<SessionSummary>;
  // repoPath / worktreePath / branchName are optional: a non-repo
  // routed session (e.g. raw shell on a paired node) carries no repo
  // binding. Validate them only when present.
  const repoPathOk =
    session.repoPath === undefined || typeof session.repoPath === 'string';
  const worktreePathOk =
    session.worktreePath === undefined ||
    session.worktreePath === null ||
    typeof session.worktreePath === 'string';
  const branchNameOk =
    session.branchName === undefined || typeof session.branchName === 'string';
  const repoNameOk =
    session.repoName === undefined || typeof session.repoName === 'string';
  return (
    typeof session.id === 'string' &&
    (session.type === 'agent' || session.type === 'terminal') &&
    (session.mode === 'pty' || session.mode === 'web') &&
    repoPathOk &&
    worktreePathOk &&
    typeof session.cwd === 'string' &&
    repoNameOk &&
    branchNameOk &&
    controlSummaryFieldsOk(session) &&
    (session.sessionEnvelope === undefined ||
      isSessionEnvelope(session.sessionEnvelope)) &&
    typeof session.displayName === 'string' &&
    typeof session.createdAt === 'string' &&
    typeof session.lastActivity === 'string' &&
    typeof session.idle === 'boolean' &&
    (typeof session.customCommand === 'string' ||
      session.customCommand === null) &&
    (session.status === 'active' || session.status === 'disconnected') &&
    typeof session.needsBranchRename === 'boolean' &&
    typeof session.agentState === 'string'
  );
}

export function scopedNodeSession(
  nodeId: string,
  session: SessionSummary,
  lifecycle: { expiresAt?: string | null; issuedAt?: string } = {}
): SessionSummary {
  const scoped: SessionSummary = { ...session };
  delete scoped.nodeId;
  delete scoped.globalSessionId;
  delete scoped.repoInstanceId;
  delete scoped.worktreeInstanceId;

  const existingEnvelope = isSessionEnvelope(scoped.sessionEnvelope)
    ? scoped.sessionEnvelope
    : null;
  const globalSessionId = createGlobalSessionId(nodeId, scoped.id);
  const result = {
    ...scoped,
    ...normalizeControlStateSummary(scoped),
    nodeId,
    globalSessionId,
    ...(scoped.repoPath
      ? { repoInstanceId: createRepoInstanceId(nodeId, scoped.repoPath) }
      : {}),
    ...(scoped.worktreePath
      ? {
          worktreeInstanceId: createWorktreeInstanceId(
            nodeId,
            scoped.worktreePath
          ),
        }
      : {}),
  };
  return {
    ...result,
    sessionEnvelope: createRoutedNodeSessionEnvelope({
      sessionId: scoped.id,
      nodeId,
      globalSessionId,
      cwd: scoped.cwd,
      ...(scoped.repoPath ? { repoPath: scoped.repoPath } : {}),
      ...(scoped.worktreePath !== undefined
        ? { worktreePath: scoped.worktreePath }
        : {}),
      issuedAt: lifecycle.issuedAt ?? existingEnvelope?.issuedAt ?? scoped.createdAt,
      expiresAt:
        lifecycle.expiresAt !== undefined
          ? lifecycle.expiresAt
          : (existingEnvelope?.expiresAt ?? null),
      revocable: existingEnvelope?.revocable ?? true,
      peerIdentity: { kind: 'relay-node', nodeId },
      ...(existingEnvelope?.correlationId
        ? { correlationId: existingEnvelope.correlationId }
        : {}),
      ...(existingEnvelope?.auditId ? { auditId: existingEnvelope.auditId } : {}),
    }),
  };
}

export function sessionFromPayload(payload: unknown): SessionSummary {
  if (typeof payload !== 'object' || payload === null) {
    throw new HubNodeRegistryError(
      'INVALID_REQUEST',
      'node session create response was malformed'
    );
  }
  const session = (payload as Record<string, unknown>)['session'];
  if (!isSessionSummary(session)) {
    throw new HubNodeRegistryError(
      'INVALID_REQUEST',
      'node session create response was malformed'
    );
  }
  return session;
}

export function bodyRecord(req: Request): Record<string, unknown> {
  return typeof req.body === 'object' && req.body !== null
    ? (req.body as Record<string, unknown>)
    : {};
}

export interface ColdReopenWarning {
  code:
    | 'source-dirty-checkout'
    | 'source-diverged-checkout'
    | 'target-dirty-checkout'
    | 'target-diverged-checkout';
  message: string;
  details?: Record<string, unknown>;
}

export interface ColdReopenTarget {
  repo: RepoInventoryRepoInstance;
  worktree: RepoInventoryWorktreeInstance | null;
  branchName: string | null;
  warnings: ColdReopenWarning[];
}

function stringField(
  record: Record<string, unknown>,
  key: string
): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function recordField(
  record: Record<string, unknown>,
  key: string
): Record<string, unknown> {
  const value = record[key];
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function dirtyCount(
  dirty: RepoInventoryDirtySummary | null | undefined
): number {
  if (!dirty) return 0;
  return (
    dirty.stagedCount +
    dirty.unstagedCount +
    dirty.untrackedCount +
    dirty.conflictedCount
  );
}

function isDiverged(
  divergence: RepoInventoryDivergenceSummary | null | undefined
): boolean {
  if (!divergence) return false;
  return divergence.aheadCount > 0 || divergence.behindCount > 0;
}

function checkoutWarnings(
  scope: 'source' | 'target',
  checkout: RepoInventoryRepoInstance | RepoInventoryWorktreeInstance
): ColdReopenWarning[] {
  const warnings: ColdReopenWarning[] = [];
  if (dirtyCount(checkout.dirty) > 0) {
    warnings.push({
      code: `${scope}-dirty-checkout`,
      message: `${scope} checkout has uncommitted changes; cold reopen uses git/worktree state and will not migrate live process state`,
      details: { dirty: checkout.dirty },
    });
  }
  if (isDiverged(checkout.divergence)) {
    warnings.push({
      code: `${scope}-diverged-checkout`,
      message: `${scope} checkout is ahead or behind its upstream; push/fetch before relying on this reopened session`,
      details: { divergence: checkout.divergence },
    });
  }
  return warnings;
}

interface SourceCheckoutLookup {
  nodeId?: string;
  repoInstanceId?: string;
  worktreeInstanceId?: string;
  repoPath?: string;
  worktreePath?: string;
  repoIdentity?: string;
  branchName?: string;
}

function sourceCheckoutLookup(
  source: Record<string, unknown>
): SourceCheckoutLookup | null {
  const nodeId = stringField(source, 'nodeId');
  const repoInstanceId = stringField(source, 'repoInstanceId');
  const worktreeInstanceId = stringField(source, 'worktreeInstanceId');
  const repoPath = stringField(source, 'repoPath');
  const worktreePath = stringField(source, 'worktreePath');
  const repoIdentity = stringField(source, 'repoIdentity');
  const branchName = stringField(source, 'branchName');
  const lookup: SourceCheckoutLookup = {
    ...(nodeId ? { nodeId } : {}),
    ...(repoInstanceId ? { repoInstanceId } : {}),
    ...(worktreeInstanceId ? { worktreeInstanceId } : {}),
    ...(repoPath ? { repoPath } : {}),
    ...(worktreePath ? { worktreePath } : {}),
    ...(repoIdentity ? { repoIdentity } : {}),
    ...(branchName ? { branchName } : {}),
  };
  return Object.keys(lookup).length > 0 ? lookup : null;
}

function matchingWorktree(
  repo: RepoInventoryRepoInstance,
  lookup: SourceCheckoutLookup
): RepoInventoryWorktreeInstance | undefined {
  return repo.worktrees.find(
    (candidate) =>
      candidate.worktreeInstanceId === lookup.worktreeInstanceId ||
      candidate.localPath === lookup.worktreePath
  );
}

function matchingRepoCheckout(
  repo: RepoInventoryRepoInstance,
  lookup: SourceCheckoutLookup
): RepoInventoryRepoInstance | RepoInventoryWorktreeInstance | null {
  const worktree = matchingWorktree(repo, lookup);
  if (worktree) return worktree;
  if (lookup.repoInstanceId && repo.repoInstanceId === lookup.repoInstanceId)
    return repo;
  if (lookup.repoPath && repo.localPath === lookup.repoPath) return repo;
  if (lookup.repoIdentity && repo.repoIdentity === lookup.repoIdentity) {
    return lookup.branchName
      ? (repo.worktrees.find(
          (candidate) => candidate.branchName === lookup.branchName
        ) ?? repo)
      : repo;
  }
  return null;
}

function findSourceCheckout(
  reports: RepoInventoryReport[],
  source: Record<string, unknown>
): RepoInventoryRepoInstance | RepoInventoryWorktreeInstance | null {
  const lookup = sourceCheckoutLookup(source);
  if (!lookup) return null;

  for (const report of reports) {
    if (lookup.nodeId && report.nodeId !== lookup.nodeId) continue;
    for (const repo of report.repos) {
      const checkout = matchingRepoCheckout(repo, lookup);
      if (checkout) return checkout;
    }
  }
  return null;
}

export function findColdReopenTarget(
  reports: RepoInventoryReport[],
  nodeId: string,
  body: Record<string, unknown>
): ColdReopenTarget | RelayNodeError {
  const source = recordField(body, 'source');
  const target = recordField(body, 'target');
  const repoIdentity =
    stringField(body, 'repoIdentity') ??
    stringField(source, 'repoIdentity') ??
    stringField(target, 'repoIdentity');
  const branchName =
    stringField(body, 'branchName') ??
    stringField(source, 'branchName') ??
    stringField(target, 'branchName') ??
    null;
  const targetRepoInstanceId = stringField(target, 'repoInstanceId');
  const targetWorktreeInstanceId = stringField(target, 'worktreeInstanceId');
  const targetRepoPath = stringField(target, 'repoPath');
  const targetWorktreePath = stringField(target, 'worktreePath');

  if (!repoIdentity && !targetRepoInstanceId && !targetRepoPath) {
    return relayError(
      'INVALID_REQUEST',
      'source.repoIdentity or target.repoInstanceId is required for cold reopen'
    );
  }

  const report = reports.find((candidate) => candidate.nodeId === nodeId);
  if (!report) {
    return relayError(
      'NOT_FOUND',
      'target node has not reported repo inventory',
      false,
      {
        suggestedAction: 'pair-node-heartbeat-with-repo-inventory',
        repoIdentity: repoIdentity ?? null,
        targetNodeId: nodeId,
      }
    );
  }

  const repo = report.repos.find((candidate) => {
    if (targetRepoInstanceId)
      return candidate.repoInstanceId === targetRepoInstanceId;
    if (targetRepoPath) return candidate.localPath === targetRepoPath;
    return candidate.repoIdentity === repoIdentity;
  });

  if (!repo) {
    return relayError(
      'NOT_FOUND',
      'target node does not have this repository checkout',
      false,
      {
        suggestedAction: 'clone-or-add-worktree',
        repoIdentity: repoIdentity ?? null,
        targetNodeId: nodeId,
      }
    );
  }

  const worktree =
    repo.worktrees.find((candidate) => {
      if (targetWorktreeInstanceId)
        return candidate.worktreeInstanceId === targetWorktreeInstanceId;
      if (targetWorktreePath) return candidate.localPath === targetWorktreePath;
      return branchName ? candidate.branchName === branchName : false;
    }) ?? null;
  const repoMatchesRequestedBranch =
    branchName !== null && repo.currentBranch === branchName;
  if (
    (targetWorktreeInstanceId || targetWorktreePath || branchName) &&
    !worktree &&
    !repoMatchesRequestedBranch
  ) {
    return relayError(
      'NOT_FOUND',
      'target node does not have this branch/worktree checkout',
      false,
      {
        suggestedAction: 'add-worktree-or-checkout-branch',
        repoIdentity: repo.repoIdentity,
        branchName,
        targetNodeId: nodeId,
      }
    );
  }

  const sourceCheckout = findSourceCheckout(reports, source);
  const warnings = [
    ...(sourceCheckout ? checkoutWarnings('source', sourceCheckout) : []),
    ...checkoutWarnings('target', worktree ?? repo),
  ];

  return {
    repo,
    worktree,
    branchName: worktree?.branchName ?? branchName,
    warnings,
  };
}

function coldReopenPrompt(input: {
  source: Record<string, unknown>;
  target: ColdReopenTarget;
  existingPrompt?: string;
}): string {
  const lines = [
    'cold reopen handoff: this starts/reopens work on this node from git/worktree state. it is not a live tmux/PTY migration and no running process state was transferred.',
    `target repo: ${input.target.repo.localPath}`,
    ...(input.target.worktree
      ? [`target worktree: ${input.target.worktree.localPath}`]
      : []),
    ...(input.target.branchName ? [`branch: ${input.target.branchName}`] : []),
  ];
  const sourceSessionId = stringField(input.source, 'sessionId');
  if (sourceSessionId) lines.push(`source session: ${sourceSessionId}`);
  if (input.target.warnings.length > 0) {
    lines.push('warnings:');
    for (const warning of input.target.warnings)
      lines.push(`- ${warning.message}`);
  }
  const handoff = lines.join('\n');
  return input.existingPrompt
    ? `${input.existingPrompt}\n\n${handoff}`
    : handoff;
}

export function coldReopenSessionPayload(
  body: Record<string, unknown>,
  target: ColdReopenTarget
): Record<string, unknown> {
  const source = recordField(body, 'source');
  const payload = { ...body };
  delete payload['source'];
  delete payload['target'];
  delete payload['repoIdentity'];
  delete payload['sourceSession'];
  payload['type'] =
    typeof payload['type'] === 'string' ? payload['type'] : 'agent';
  payload['repoPath'] = target.repo.localPath;
  payload['worktreePath'] = target.worktree?.localPath ?? null;
  if (target.branchName) payload['branchName'] = target.branchName;
  if (payload['continue'] === undefined) payload['continue'] = false;
  const existingPrompt =
    typeof body['initialPrompt'] === 'string'
      ? body['initialPrompt']
      : undefined;
  payload['initialPrompt'] = coldReopenPrompt({
    source,
    target,
    ...(existingPrompt !== undefined ? { existingPrompt } : {}),
  });
  return payload;
}

function auditPeerForSummary(summary: ScopedSessionSummary | undefined): SecurityAuditEntryInput['peer'] {
  if (summary?.peerIdentity.kind === 'relay-node') {
    return {
      kind: 'node',
      nodeId: summary.peerIdentity.nodeId,
      ...(summary.peerIdentity.credentialId
        ? { credentialId: summary.peerIdentity.credentialId }
        : {}),
      ...(summary.peerIdentity.displayName
        ? { displayName: summary.peerIdentity.displayName }
        : {}),
    };
  }
  return { kind: 'hub' };
}

function appendRoutedSessionAudit(
  sink: RoutedSessionAuditSink | undefined,
  input: SecurityAuditEntryInput
): void {
  if (!sink) return;
  try {
    sink.append(input);
  } catch {
    // Best-effort lifecycle visibility. The lifecycle validator itself is
    // already fail-closed for expired/revoked/mismatched session envelopes.
  }
}

function auditLifecycleDenial(
  sink: RoutedSessionAuditSink | undefined,
  validation: Exclude<ReturnType<InMemorySessionEnvelopeRegistry['validate']>, { ok: true }>,
  nodeId: string,
  sessionId: string,
  action: string,
  params?: unknown
): void {
  const reasonCode =
    typeof validation.error.details?.['reasonCode'] === 'string'
      ? validation.error.details['reasonCode']
      : validation.error.code;
  appendRoutedSessionAudit(sink, {
    eventType:
      validation.error.code === 'SESSION_EXPIRED'
        ? 'expiry'
        : validation.error.code === 'SESSION_REVOKED'
          ? 'revocation'
          : 'denial',
    decision:
      validation.error.code === 'SESSION_EXPIRED'
        ? 'expired'
        : validation.error.code === 'SESSION_REVOKED'
          ? 'revoked'
          : 'deny',
    reasonCode,
    peer: auditPeerForSummary(validation.summary),
    node: { nodeId },
    sessionId,
    intent: { action, target: nodeId },
    material: {
      scope: validation.summary?.scope ?? null,
      params: params ?? validation.error.details ?? null,
    },
    ...(validation.summary?.correlationId ? { correlationId: validation.summary.correlationId } : {}),
  });
}

function sendPolicyDecision(
  sink: RoutedSessionAuditSink | undefined,
  res: Response,
  decision: ReturnType<typeof evaluateHubPolicy>,
  params?: unknown
): boolean {
  const audited = appendPolicyAudit(sink, decision, { params });
  if (audited.decision === 'allow') return false;
  sendRelayError(res, policyDecisionToRelayError(audited));
  return true;
}

function auditLifecycleRevocation(
  sink: RoutedSessionAuditSink | undefined,
  summary: ScopedSessionSummary,
  params?: unknown
): void {
  appendRoutedSessionAudit(sink, {
    eventType: 'revocation',
    decision: 'revoked',
    reasonCode: 'SESSION_REVOKED',
    peer: auditPeerForSummary(summary),
    node: { nodeId: summary.nodeId },
    sessionId: summary.sessionId,
    intent: { action: 'sessions.revoke', target: summary.nodeId },
    material: { scope: summary.scope, params: params ?? null },
    ...(summary.correlationId ? { correlationId: summary.correlationId } : {}),
  });
}

function revokedReasonFromBody(body: Record<string, unknown>): string | undefined {
  const reason = body['reason'];
  return typeof reason === 'string' && reason.trim() ? reason.trim() : undefined;
}

function includeFlag(value: unknown): boolean {
  return value === '1' || value === 'true' || value === true;
}

function sessionCreatePolicyScope(
  nodeId: string,
  body: Record<string, unknown>
): Parameters<typeof evaluateHubPolicy>[0]['scope'] {
  const repoPath = stringField(body, 'repoPath');
  const worktreePath = stringField(body, 'worktreePath');
  const cwd = stringField(body, 'cwd') ?? worktreePath ?? repoPath ?? '/';
  const kind = worktreePath ? 'worktree' : repoPath ? 'repo' : 'node-cwd';
  return {
    kind,
    nodeId,
    cwd,
    ...(repoPath ? { repoPath } : {}),
    ...(body['worktreePath'] === null
      ? { worktreePath: null }
      : worktreePath
        ? { worktreePath }
        : {}),
  };
}

function revokeAddressError(
  envelopes: InMemorySessionEnvelopeRegistry,
  sessionIdOrGlobalId: string,
  nodeId?: string
): RelayNodeError | null {
  if (nodeId || envelopes.hasGlobalSessionId(sessionIdOrGlobalId)) return null;
  const localMatches = envelopes.countLocalSessionId(sessionIdOrGlobalId);
  if (localMatches === 0) return null;
  return relayError(
    'INVALID_REQUEST',
    'nodeId is required when revoking by node-local session id',
    false,
    {
      reasonCode: 'AMBIGUOUS_LOCAL_SESSION_ID',
      sessionId: sessionIdOrGlobalId,
      matches: localMatches,
    }
  );
}

function manifestFromBody(
  body: Record<string, unknown>,
  required = false
): NodeManifest | null {
  const manifest = body['manifest'];
  if (manifest === undefined || manifest === null) {
    if (required) {
      throw new HubNodeRegistryError('INVALID_REQUEST', 'manifest is required');
    }
    return null;
  }
  if (!isNodeManifest(manifest)) {
    throw new HubNodeRegistryError('INVALID_REQUEST', 'manifest is malformed');
  }
  return manifest;
}

function validateInventoryFromBody(
  feature: RepoInventoryFeature,
  body: Record<string, unknown>,
  nodeId: string
): unknown {
  const repoInventory = body['repoInventory'];
  if (repoInventory === undefined || repoInventory === null) return undefined;
  const result = feature.validateInventoryPayload(repoInventory, { nodeId });
  if (!result.ok) {
    throw new HubNodeRegistryError(result.error.code, result.error.message);
  }
  return result.payload;
}

function pairTtlMs(body: Record<string, unknown>): number | undefined {
  const ttlMs = body['ttlMs'];
  if (typeof ttlMs === 'number' && Number.isFinite(ttlMs) && ttlMs > 0)
    return ttlMs;
  const ttlSeconds = body['ttlSeconds'];
  if (
    typeof ttlSeconds === 'number' &&
    Number.isFinite(ttlSeconds) &&
    ttlSeconds > 0
  ) {
    return Math.round(ttlSeconds * 1000);
  }
  return undefined;
}

const serviceModeValues = new Set<BootstrapServiceMode>([
  'manual',
  'launchd',
  'systemd-user',
  'wsl-systemd',
  'wsl-manual',
]);

function serviceModesFromBody(
  body: Record<string, unknown>
): BootstrapServiceMode[] | undefined {
  const serviceModes = body['serviceModes'];
  if (!Array.isArray(serviceModes)) return undefined;
  const valid = serviceModes.filter(
    (mode): mode is BootstrapServiceMode =>
      typeof mode === 'string' &&
      serviceModeValues.has(mode as BootstrapServiceMode)
  );
  return valid.length > 0 ? Array.from(new Set(valid)) : undefined;
}

function stringFromBody(
  body: Record<string, unknown>,
  key: string
): string | undefined {
  const value = body[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function hubUrlFromRequest(
  req: Request,
  body: Record<string, unknown>
): string {
  const explicitHubUrl = stringFromBody(body, 'hubUrl');
  if (explicitHubUrl) return explicitHubUrl;
  const forwardedProto = req.header('x-forwarded-proto')?.split(',')[0]?.trim();
  const proto = forwardedProto || req.protocol || 'http';
  const forwardedHost = req.header('x-forwarded-host')?.split(',')[0]?.trim();
  const host = forwardedHost || req.get('host');
  return `${proto}://${host}`;
}

export function createHubNodeRouter(
  options: HubNodeRouterOptions
): express.Router {
  const router = express.Router();
  const { registry, requireAuth } = options;
  const scopedSessionAuth = options.scopedSessionAuth ?? requireAuth;
  const envelopes = options.sessionEnvelopes ?? sessionEnvelopeRegistry;
  const now = () => options.now?.() ?? new Date();
  const repoInventoryFeature =
    options.repoInventoryFeature ?? createRepoInventoryFeature(registry);

  router.post('/hub/pair-tokens', requireAuth, (req, res) => {
    const body = bodyRecord(req);
    const displayName =
      typeof body['displayName'] === 'string' ? body['displayName'] : undefined;
    const ttlMs = pairTtlMs(body);
    const pairToken = registry.createPairToken({
      ...(displayName ? { displayName } : {}),
      ...(ttlMs !== undefined ? { ttlMs } : {}),
    });
    const hubUrl = hubUrlFromRequest(req, body);
    const sshTarget = stringFromBody(body, 'sshTarget');
    const tailscaleTarget = stringFromBody(body, 'tailscaleTarget');
    const serviceModes = serviceModesFromBody(body);
    res.status(201).json({
      ...pairToken,
      hubUrl,
      suggestedCommands: generateBootstrapCommands({
        hubUrl,
        pairToken: pairToken.pairToken,
        ...(sshTarget ? { sshTarget } : {}),
        ...(tailscaleTarget ? { tailscaleTarget } : {}),
        ...(serviceModes ? { serviceModes } : {}),
      }),
      diagnostics: BOOTSTRAP_DIAGNOSTICS,
    });
  });

  router.post('/hub/pairing/exchange', (req, res) => {
    const body = bodyRecord(req);
    const pairToken = body['pairToken'];
    if (typeof pairToken !== 'string') {
      res.status(400).json({
        error: {
          code: 'INVALID_REQUEST',
          message: 'pairToken is required',
          retryable: false,
        },
      });
      return;
    }
    try {
      const manifest = manifestFromBody(body, true)!;
      const protocolVersion =
        typeof body['protocolVersion'] === 'string'
          ? body['protocolVersion']
          : undefined;
      const displayName =
        typeof body['displayName'] === 'string'
          ? body['displayName']
          : undefined;
      res.status(201).json(
        registry.exchangePairToken({
          pairToken,
          manifest,
          ...(displayName ? { displayName } : {}),
          ...(protocolVersion ? { protocolVersion } : {}),
        })
      );
    } catch (error) {
      sendRegistryError(registry, res, error);
    }
  });

  router.post('/hub/node-heartbeat', (req, res) => {
    const token = bearerToken(req);
    const authenticated = token
      ? registry.authenticateCredentialDetailed(token)
      : null;
    if (!authenticated) {
      const error = {
        code: 'UNAUTHORIZED' as const,
        message: 'invalid node credential',
        retryable: false,
      };
      res.status(errorStatus(error)).json({ error });
      return;
    }
    if (authenticated.ok === false) {
      const { error } = authenticated;
      res.status(errorStatus(error)).json({ error });
      return;
    }
    const body = bodyRecord(req);
    const protocolVersion = body['protocolVersion'];
    if (
      body['nodeId'] !== authenticated.node.nodeId ||
      typeof protocolVersion !== 'string'
    ) {
      res.status(400).json({
        error: {
          code: 'INVALID_REQUEST',
          message: 'nodeId and protocolVersion are required',
          retryable: false,
        },
      });
      return;
    }
    try {
      const manifest = manifestFromBody(body);
      const repoInventory = validateInventoryFromBody(
        repoInventoryFeature,
        body,
        authenticated.node.nodeId
      );
      res.json({
        node: registry.recordHeartbeat({
          nodeId: authenticated.node.nodeId,
          protocolVersion,
          ...(manifest ? { manifest } : {}),
          ...(repoInventory !== undefined && repoInventory !== null
            ? { repoInventory }
            : {}),
        }),
      });
    } catch (error) {
      sendRegistryError(registry, res, error);
    }
  });

  router.get('/nodes', requireAuth, (_req, res) => {
    res.json({ nodes: registry.listNodes() });
  });

  // Repo-feature endpoints (GET /hub/repo-inventory + POST
  // /hub/nodes/:nodeId/sessions/reopen) used to live here. Per #425.2 /
  // #433 they moved to `server/features/repo-router.ts`. Composition
  // root mounts both routers.

  router.get('/hub/scoped-sessions', scopedSessionAuth, (req, res) => {
    res.json({
      sessions: envelopes.listSummaries({
        now: now(),
        includeRevoked: includeFlag(req.query['includeRevoked']),
        includeExpired: req.query['includeExpired'] === '0' ? false : true,
      }),
    });
  });

  router.post('/hub/scoped-sessions/:sessionId/revoke', scopedSessionAuth, (req, res) => {
    const { sessionId } = req.params;
    if (!sessionId) {
      sendRelayError(res, relayError('INVALID_REQUEST', 'sessionId is required'));
      return;
    }
    const body = bodyRecord(req);
    const queryNodeId =
      typeof req.query['nodeId'] === 'string' ? req.query['nodeId'] : undefined;
    const nodeId = stringField(body, 'nodeId') ?? queryNodeId;
    const revokeReason = revokedReasonFromBody(body);
    const addressError = revokeAddressError(envelopes, sessionId, nodeId);
    if (addressError) {
      sendRelayError(res, addressError);
      return;
    }
    const summary = envelopes.revoke(sessionId, {
      ...(nodeId ? { nodeId } : {}),
      ...(revokeReason ? { reason: revokeReason } : {}),
      now: now(),
    });
    if (!summary) {
      sendRelayError(res, relayError('NOT_FOUND', 'scoped session envelope was not found'));
      return;
    }
    auditLifecycleRevocation(options.auditSink, summary, body);
    res.json({ session: summary });
  });

  router.delete('/hub/scoped-sessions/:sessionId', scopedSessionAuth, (req, res) => {
    const { sessionId } = req.params;
    if (!sessionId) {
      sendRelayError(res, relayError('INVALID_REQUEST', 'sessionId is required'));
      return;
    }
    const nodeId = typeof req.query['nodeId'] === 'string' ? req.query['nodeId'] : undefined;
    const addressError = revokeAddressError(envelopes, sessionId, nodeId);
    if (addressError) {
      sendRelayError(res, addressError);
      return;
    }
    const summary = envelopes.revoke(sessionId, {
      ...(nodeId ? { nodeId } : {}),
      reason: 'operator-revoked',
      now: now(),
    });
    if (!summary) {
      sendRelayError(res, relayError('NOT_FOUND', 'scoped session envelope was not found'));
      return;
    }
    auditLifecycleRevocation(options.auditSink, summary, { method: 'DELETE' });
    res.json({ session: summary });
  });

  router.post('/hub/nodes/:nodeId/sessions', requireAuth, async (req, res) => {
    const { nodeId } = req.params;
    if (!nodeId) {
      sendRelayError(res, relayError('INVALID_REQUEST', 'nodeId is required'));
      return;
    }
    const node = registry
      .listNodes()
      .find((candidate) => candidate.nodeId === nodeId);
    if (!node || node.status === 'revoked') {
      sendRelayError(res, relayError('NOT_FOUND', 'node is not paired'));
      return;
    }
    if (node.protocolVersion !== RELAY_NODE_LINK_PROTOCOL_VERSION) {
      const [nodeMajor] = node.protocolVersion.split('.');
      const [hubMajor] = RELAY_NODE_LINK_PROTOCOL_VERSION.split('.');
      sendRelayError(
        res,
        relayError(
          nodeMajor === hubMajor ? 'VERSION_SKEW' : 'PROTOCOL_INCOMPATIBLE',
          `relay-node-link protocol ${node.protocolVersion} must exactly match hub protocol ${RELAY_NODE_LINK_PROTOCOL_VERSION}`
        )
      );
      return;
    }
    if (node.capabilities.core.tmux !== 'available') {
      sendRelayError(
        res,
        relayError(
          'NODE_UNSUPPORTED',
          `node ${nodeId} cannot host tmux-backed PTY sessions`
        )
      );
      return;
    }
    if (node.status !== 'online' || !options.nodeLinks?.hasActiveNode(nodeId)) {
      sendRelayError(
        res,
        relayError(
          'NODE_OFFLINE',
          `node ${nodeId} has no live reverse link`,
          true
        )
      );
      return;
    }

    const body = bodyRecord(req);
    const lifecycleError = lifecycleInputError(body);
    if (lifecycleError) {
      sendRelayError(
        res,
        relayError('INVALID_REQUEST', lifecycleError.message, false, {
          reasonCode: 'INVALID_LIFECYCLE_INPUT',
          field: lifecycleError.field,
        })
      );
      return;
    }
    const createNow = now();
    const expiresAt = expiresAtFromLifecycleInput(body, createNow);
    if (expiresAt !== undefined && expiresAt !== null && Date.parse(expiresAt) <= createNow.getTime()) {
      const error = relayError(
        'SESSION_EXPIRED',
        'routed session envelope is already expired',
        false,
        { reasonCode: 'SESSION_EXPIRED', expiresAt }
      );
      appendRoutedSessionAudit(options.auditSink, {
        eventType: 'expiry',
        decision: 'expired',
        reasonCode: 'SESSION_EXPIRED',
        peer: { kind: 'hub' },
        node: { nodeId },
        intent: { action: 'sessions.create', target: nodeId },
        material: { params: body },
      });
      sendRelayError(res, error);
      return;
    }
    const requestedEnvelope = isSessionEnvelope(body['sessionEnvelope'])
      ? body['sessionEnvelope']
      : null;
    if (requestedEnvelope && requestedEnvelope.nodeId !== nodeId) {
      appendRoutedSessionAudit(options.auditSink, {
        eventType: 'denial',
        decision: 'deny',
        reasonCode: 'SESSION_NODE_MISMATCH',
        peer: { kind: 'hub' },
        node: { nodeId },
        sessionId: requestedEnvelope.sessionId,
        intent: { action: 'sessions.create', target: nodeId },
        material: {
          params: {
            expectedNodeId: requestedEnvelope.nodeId,
            actualNodeId: nodeId,
          },
        },
        ...(requestedEnvelope.correlationId ? { correlationId: requestedEnvelope.correlationId } : {}),
      });
      sendRelayError(
        res,
        relayError(
          'SESSION_MISMATCH',
          'routed session envelope node does not match the route',
          false,
          {
            reasonCode: 'SESSION_NODE_MISMATCH',
            expectedNodeId: requestedEnvelope.nodeId,
            actualNodeId: nodeId,
          }
        )
      );
      return;
    }
    const rawSessionType = body['type'];
    if (rawSessionType !== undefined && !isSessionCreateType(rawSessionType)) {
      sendRelayError(
        res,
        relayError('INVALID_REQUEST', 'type must be agent or terminal', false, {
          reasonCode: 'INVALID_SESSION_TYPE',
          field: 'type',
        })
      );
      return;
    }
    const sessionType = rawSessionType === 'agent' ? 'agent' : 'terminal';
    const policyDecision = evaluateHubPolicy({
      peer: { kind: 'hub' },
      node,
      nodeId,
      intent: { action: 'sessions.create', target: nodeId },
      scope: sessionCreatePolicyScope(nodeId, body),
      requiredCapabilities: [sessionCreateCapability(sessionType)],
      ...(expiresAt !== undefined ? { expiresAt } : {}),
      params: body,
      now: createNow,
    });
    if (sendPolicyDecision(options.auditSink, res, policyDecision, body)) return;

    try {
      const payload = await options.nodeLinks.request(
        nodeId,
        'sessions.create',
        body
      );
      const session = scopedNodeSession(nodeId, sessionFromPayload(payload), {
        ...(expiresAt !== undefined ? { expiresAt } : {}),
      });
      envelopes.upsert(session.sessionEnvelope!);
      res.status(201).json(session);
    } catch (error) {
      if (error instanceof HubNodeLinkError) {
        sendRelayError(res, error.relayNodeError);
        return;
      }
      sendRegistryError(registry, res, error);
    }
  });

  router.post(
    '/hub/nodes/:nodeId/sessions/:sessionId/files/:operation',
    requireAuth,
    async (req, res) => {
      const { nodeId, sessionId, operation } = req.params;
      if (!nodeId) {
        sendRelayError(res, relayError('INVALID_REQUEST', 'nodeId is required'));
        return;
      }
      if (!sessionId) {
        sendRelayError(res, relayError('INVALID_REQUEST', 'sessionId is required'));
        return;
      }
      if (!isFileRpcOperation(operation)) {
        sendRelayError(
          res,
          relayError('INVALID_REQUEST', 'file RPC operation must be list, stat, or read', false, {
            reasonCode: 'FILE_RPC_INVALID_REQUEST',
            operation,
          })
        );
        return;
      }
      const node = registry
        .listNodes()
        .find((candidate) => candidate.nodeId === nodeId);
      if (!node || node.status === 'revoked') {
        sendRelayError(res, relayError('NOT_FOUND', 'node is not paired'));
        return;
      }
      if (node.protocolVersion !== RELAY_NODE_LINK_PROTOCOL_VERSION) {
        const [nodeMajor] = node.protocolVersion.split('.');
        const [hubMajor] = RELAY_NODE_LINK_PROTOCOL_VERSION.split('.');
        sendRelayError(
          res,
          relayError(
            nodeMajor === hubMajor ? 'VERSION_SKEW' : 'PROTOCOL_INCOMPATIBLE',
            `relay-node-link protocol ${node.protocolVersion} must exactly match hub protocol ${RELAY_NODE_LINK_PROTOCOL_VERSION}`
          )
        );
        return;
      }
      if (
        node.status !== 'online' ||
        !options.nodeLinks?.hasActiveNode(nodeId)
      ) {
        sendRelayError(
          res,
          relayError(
            'NODE_OFFLINE',
            `node ${nodeId} has no live reverse link`,
            true
          )
        );
        return;
      }

      const body = bodyRecord(req);
      const lifecycle = envelopes.validate({ nodeId, sessionId, now: now() });
      if (!lifecycle.ok) {
        const denial = lifecycle as Exclude<
          ReturnType<InMemorySessionEnvelopeRegistry['validate']>,
          { ok: true }
        >;
        auditLifecycleDenial(
          options.auditSink,
          denial,
          nodeId,
          sessionId,
          `rpc.fs.${operation}`,
          body
        );
        sendRelayError(res, denial.error);
        return;
      }

      const normalized = normalizeHubFileRpcRequest({
        operation,
        nodePlatform: node.platform,
        nodeId,
        session: lifecycle.summary,
        body,
      });
      if (normalized.ok === false) {
        sendRelayError(res, normalized.error);
        return;
      }

      const action = `rpc.fs.${operation}`;
      const policyDecision = evaluateHubPolicy({
        peer: { kind: 'hub' },
        node,
        nodeId,
        intent: { action, target: nodeId },
        scope: normalized.value.policyScope,
        requiredCapabilities: requiredCapabilitiesForRpcIntent(action),
        sessionId,
        ...(lifecycle.summary.correlationId
          ? { correlationId: lifecycle.summary.correlationId }
          : {}),
        ...(lifecycle.summary.expiresAt !== undefined
          ? { expiresAt: lifecycle.summary.expiresAt }
          : {}),
        ...(lifecycle.summary.revokedAt
          ? { revokedAt: lifecycle.summary.revokedAt }
          : {}),
        params: { ...body, path: normalized.value.request.path },
        now: now(),
      });
      if (
        sendPolicyDecision(options.auditSink, res, policyDecision, {
          ...body,
          path: normalized.value.request.path,
        })
      ) {
        return;
      }

      try {
        const payload = await options.nodeLinks.request(
          nodeId,
          `fs.${operation}`,
          normalized.value.request
        );
        res.json(payload);
      } catch (error) {
        if (error instanceof HubNodeLinkError) {
          sendRelayError(res, error.relayNodeError);
          return;
        }
        sendRegistryError(registry, res, error);
      }
    }
  );

  router.delete(
    '/hub/nodes/:nodeId/sessions/:sessionId',
    requireAuth,
    async (req, res) => {
      const { nodeId, sessionId } = req.params;
      if (!nodeId) {
        sendRelayError(
          res,
          relayError('INVALID_REQUEST', 'nodeId is required')
        );
        return;
      }
      if (!sessionId) {
        sendRelayError(
          res,
          relayError('INVALID_REQUEST', 'sessionId is required')
        );
        return;
      }
      const node = registry
        .listNodes()
        .find((candidate) => candidate.nodeId === nodeId);
      if (!node || node.status === 'revoked') {
        sendRelayError(res, relayError('NOT_FOUND', 'node is not paired'));
        return;
      }
      if (node.protocolVersion !== RELAY_NODE_LINK_PROTOCOL_VERSION) {
        const [nodeMajor] = node.protocolVersion.split('.');
        const [hubMajor] = RELAY_NODE_LINK_PROTOCOL_VERSION.split('.');
        sendRelayError(
          res,
          relayError(
            nodeMajor === hubMajor ? 'VERSION_SKEW' : 'PROTOCOL_INCOMPATIBLE',
            `relay-node-link protocol ${node.protocolVersion} must exactly match hub protocol ${RELAY_NODE_LINK_PROTOCOL_VERSION}`
          )
        );
        return;
      }
      if (
        node.status !== 'online' ||
        !options.nodeLinks?.hasActiveNode(nodeId)
      ) {
        sendRelayError(
          res,
          relayError(
            'NODE_OFFLINE',
            `node ${nodeId} has no live reverse link`,
            true
          )
        );
        return;
      }

      const lifecycle = envelopes.validate({ nodeId, sessionId, now: now() });
      if (!lifecycle.ok) {
        const denial = lifecycle as Exclude<
          ReturnType<InMemorySessionEnvelopeRegistry['validate']>,
          { ok: true }
        >;
        auditLifecycleDenial(
          options.auditSink,
          denial,
          nodeId,
          sessionId,
          'sessions.kill',
          { method: 'DELETE' }
        );
        sendRelayError(res, denial.error);
        return;
      }
      const scoped = lifecycle.summary;
      const killPolicyDecision = evaluateHubPolicy({
        peer: { kind: 'hub' },
        node,
        nodeId,
        intent: { action: 'sessions.kill', target: nodeId },
        scope: scoped
          ? {
              kind: scoped.scope.kind,
              nodeId,
              cwd: scoped.scope.cwd,
              ...(scoped.scope.repoPath ? { repoPath: scoped.scope.repoPath } : {}),
              ...(scoped.scope.worktreePath !== undefined
                ? { worktreePath: scoped.scope.worktreePath }
                : {}),
            }
          : { kind: 'node', nodeId, cwd: '/' },
        requiredCapabilities: ['session:attach'],
        sessionId,
        ...(scoped?.correlationId ? { correlationId: scoped.correlationId } : {}),
        ...(scoped?.expiresAt !== undefined ? { expiresAt: scoped.expiresAt } : {}),
        ...(scoped?.revokedAt ? { revokedAt: scoped.revokedAt } : {}),
        params: { method: 'DELETE' },
        now: now(),
      });
      if (sendPolicyDecision(options.auditSink, res, killPolicyDecision, { method: 'DELETE' })) return;

      try {
        await options.nodeLinks.request(nodeId, 'sessions.kill', {
          id: sessionId,
        });
        envelopes.delete(sessionId, nodeId);
        res.json({ ok: true });
      } catch (error) {
        if (error instanceof HubNodeLinkError) {
          sendRelayError(res, error.relayNodeError);
          return;
        }
        sendRegistryError(registry, res, error);
      }
    }
  );

  router.delete('/nodes/:nodeId', requireAuth, (req, res) => {
    const { nodeId } = req.params;
    if (!nodeId) {
      res.status(400).json({
        error: {
          code: 'INVALID_REQUEST',
          message: 'nodeId is required',
          retryable: false,
        },
      });
      return;
    }
    try {
      const node = registry.revokeNode(nodeId);
      const revokedSessions = revokePolicyAffectedSessions({
        envelopes,
        nodeId,
        node,
        reason: 'node-revoked',
        now: now(),
        auditSink: options.auditSink,
      });
      res.json({
        node,
        events: revokedSessions.map((session) => ({
          type: 'SESSION_PERMISSION_REVOKED',
          nodeId,
          sessionId: session.sessionId,
          globalSessionId: session.globalSessionId,
          reasonCode: 'POLICY_NODE_REVOKED',
        })),
      });
    } catch (error) {
      sendRegistryError(registry, res, error);
    }
  });

  return router;
}
