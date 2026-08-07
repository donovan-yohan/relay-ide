import * as crypto from 'node:crypto';
import * as express from 'express';
import { isFileRpcOperation } from '../shared/file-rpc.js';
import { normalizeHubFileRpcRequest } from './file-rpc.js';
import type { Request, Response } from 'express';
import type { WorkContextStore } from './work-contexts.js';
import { isNodeManifest, type NodeManifest } from '../shared/node-manifest.js';
import type {
  RepoInventoryDirtySummary,
  RepoInventoryDivergenceSummary,
  RepoInventoryRepoInstance,
  RepoInventoryReport,
  RepoInventoryWorktreeInstance,
} from '../shared/repo-inventory.js';
import {
  classifySecurityAuditWriteFailure,
  redactPeerForBrowser,
  type NormalizedSecurityAuditEntry,
  type SecurityAuditEntryInput,
} from '../shared/security-audit.js';
import type { SecurityAuditVerificationResult } from './security-audit-log.js';
import {
  HubNodeRegistryError,
  type HubNodeRegistry,
  type PairTokenCapabilityEnvelope,
} from './hub-node-registry.js';
import {
  nodeHasTerminalBackend,
  nodeTerminalBackends,
  RELAY_NODE_LINK_PROTOCOL_VERSION,
  type RelayNodeError,
} from '../shared/relay-node-protocol.js';
import {
  BOOTSTRAP_DIAGNOSTICS,
  generateBootstrapCommands,
  type BootstrapServiceMode,
} from '../shared/bootstrap-diagnostics.js';
import { HubNodeLinkError, NODE_LINK_PROOF_HEADER } from './hub-node-link.js';
import {
  createRepoInventoryFeature,
  type RepoInventoryFeature,
} from './features/repo-inventory.js';
import type { SessionSummary } from './types.js';
import {
  DEFAULT_LOCAL_NODE_ID,
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
  type HubPolicyDecision,
  policyDecisionToRelayError,
  requiredCapabilitiesForRpcIntent,
  revokePolicyAffectedSessions,
  sessionCreateCapabilities,
} from './hub-policy-evaluator.js';
import {
  ConfirmationChallengeCapacityError,
  canonicalConfirmationParams,
  createConfirmationChallengeStore,
  hashAuthSessionIdentity,
  publicChallenge,
  type ConfirmationChallengeStore,
  type ConfirmationDecision,
  type ConfirmationFailure,
} from './confirmation-challenges.js';
import type { HubNodeSummary } from '../shared/relay-node-protocol.js';
import type { RelayCliGatewayError } from '../shared/cli-gateway-contract.js';
import { validateAndSanitizeGatewayCreateInput } from '../shared/cli-gateway-runtime.js';
import {
  authenticatedCliGatewayActorCredential,
  type CliGatewayActorReadCommand,
} from './cli-gateway-actor-auth.js';
import type {
  HighRiskApprovalApproverIdentity,
  HighRiskApprovalRequesterIdentity,
  HighRiskApprovalTarget,
} from './high-risk-approvals.js';
import { sourceTupleFromRequest } from './node-source-diagnostics.js';
import {
  HandshakeGrantRegistryError,
  HandshakeGrantRegistry,
  NODE_PAIR_TOKEN_CREATE_CAPABILITY,
  NODE_PAIR_TOKEN_MINT_GRANT_AUDIENCE,
  type HandshakeGrantActor,
  type HandshakeGrantScope,
  type HandshakeGrantSessionBinding,
  type HandshakeGrantValidationFailureReason,
  type HandshakeGrantValidationScope,
} from '../shared/operator-handshake-grants.js';
import {
  HIGH_RISK_CAPABILITIES,
  isRelayCapabilityBit,
  isRelayTrustTier,
  normalizeCapabilityBits,
  type RelayCapabilityBit,
  type RelayTrustTier,
} from '../shared/security-policy.js';
import {
  isHighRiskNodePairingRequest,
  isNodePairingTrustProfile,
  nodePairingProfileTrustTier,
  type NodePairingTrustProfile,
} from '../shared/node-pairing-requests.js';
import type { PendingPairingAccessEdit } from './hub-node-registry.js';

const FILE_RPC_FOLLOW_STREAM_BUFFER_BYTES = 256 * 1024;

interface HubNodeSessionTransport {
  hasActiveNode(nodeId: string): boolean;
  request(nodeId: string, type: string, payload: unknown): Promise<unknown>;
  streamRequest?(
    nodeId: string,
    type: string,
    payload: unknown,
    handlers: {
      onChunk: (payload: unknown) => void;
      onError?: (error: RelayNodeError) => void;
      onEnd?: () => void;
    }
  ): Promise<{ payload: unknown; close(): void }>;
}

interface RoutedSessionReadModelCache {
  set(nodeId: string, sessions: SessionSummary[], observedAtMs: number): void;
  upsert(nodeId: string, session: SessionSummary, observedAtMs: number): void;
}

export interface RoutedSessionAuditSink {
  append(input: SecurityAuditEntryInput): unknown;
  listBefore?(
    beforeSequence: number | null,
    limit: number
  ): {
    rows: NormalizedSecurityAuditEntry[];
    nextBeforeSequence: number | null;
  };
  head?(): { latestSequence: number; latestHash: string | null };
  verify?(): SecurityAuditVerificationResult;
}

interface AuditVerifyCacheEntry {
  latestSequence: number;
  latestHash: string | null;
  result: SecurityAuditVerificationResult;
  verifiedAtMs: number;
}

interface HubNodeRouterOptions {
  registry: HubNodeRegistry;
  requireAuth: express.RequestHandler;
  cliGatewayAuth?: express.RequestHandler;
  cliGatewayAuthForActorCommand?: (
    command: CliGatewayActorReadCommand
  ) => express.RequestHandler;
  scopedSessionAuth?: express.RequestHandler;
  repoInventoryFeature?: RepoInventoryFeature;
  collectLocalRepoInventory?: () => Promise<RepoInventoryReport>;
  nodeLinks?: HubNodeSessionTransport;
  sessionEnvelopes?: InMemorySessionEnvelopeRegistry;
  renewLocalSession?: (input: {
    id: string;
    expiresAt: string;
    now?: Date;
  }) => ReturnType<InMemorySessionEnvelopeRegistry['renew']>;
  releaseRoutedPtyControlSession?: (nodeId: string, sessionId: string) => void;
  releaseRoutedPtyControlSessionsForNode?: (nodeId: string) => void;
  confirmations?: ConfirmationChallengeStore;
  operatorHandshakeGrants?: HandshakeGrantRegistry;
  onOperatorHandshakeGrantRevoked?: (input: {
    grantId: string;
    revokedBy: string;
    reason?: string;
    correlationId?: string;
  }) => void;
  auditSink?: RoutedSessionAuditSink;
  workContextStore?: WorkContextStore;
  readModelCache?: RoutedSessionReadModelCache;
  sourceDiagnostics?: {
    strictDeny?: boolean;
  };
  now?: () => Date;
}

function bearerToken(req: Request): string | null {
  const header = req.header('authorization') ?? '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

function optionalControlActorOk(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    normalizeControlActor(value) !== undefined
  );
}

function optionalControlStringOk(value: unknown): boolean {
  return value === undefined || value === null || typeof value === 'string';
}

function optionalStringFieldOk(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

function optionalNullableStringFieldOk(value: unknown): boolean {
  return value === undefined || value === null || typeof value === 'string';
}

function sessionAssociationFieldsOk(session: Partial<SessionSummary>): boolean {
  // repo/worktree/branch/work-context bindings are optional: a non-repo
  // routed session (e.g. raw shell on a paired node) carries no repo
  // binding. Validate them only when present.
  return (
    optionalStringFieldOk(session.repoPath) &&
    optionalNullableStringFieldOk(session.worktreePath) &&
    optionalStringFieldOk(session.repoName) &&
    optionalStringFieldOk(session.branchName) &&
    optionalStringFieldOk(session.spawnedBySessionId) &&
    optionalStringFieldOk(session.workContextId)
  );
}

function sessionEnvelopeOk(session: Partial<SessionSummary>): boolean {
  return (
    session.sessionEnvelope === undefined ||
    isSessionEnvelope(session.sessionEnvelope)
  );
}

function controlSummaryFieldsOk(session: Partial<SessionSummary>): boolean {
  const activeActorsOk =
    session.activeActors === undefined ||
    (Array.isArray(session.activeActors) &&
      session.activeActors.every((actor) => normalizeControlActor(actor)));
  return (
    (session.controlMode === undefined || isControlMode(session.controlMode)) &&
    activeActorsOk &&
    optionalControlStringOk(session.lastInterventionAt) &&
    optionalControlActorOk(session.lastInterventionBy) &&
    optionalControlStringOk(session.lastInterventionEventId) &&
    (session.controlFreshness === undefined ||
      isControlFreshness(session.controlFreshness)) &&
    (session.controlReason === undefined ||
      typeof session.controlReason === 'string')
  );
}

// Shared utilities exported for the repo feature router (and any other
// hub-side router that needs to surface relay-node-protocol errors
// consistently). Pure functions — no router or registry state.
export function errorStatus(error: RelayNodeError): number {
  switch (error.code) {
    // #981: NODE_PROOF_REQUIRED → bearer located the credential but possession
    // was not proven (401). NODE_PROOF_INVALID → proof present but rejected
    // (wrong key / stale / replayed / mismatch) (403).
    case 'UNAUTHORIZED':
    case 'NODE_CREDENTIAL_MISSING':
    case 'NODE_CREDENTIAL_MALFORMED':
    case 'NODE_CREDENTIAL_MISMATCH':
    case 'NODE_PROOF_REQUIRED':
      return 401;
    case 'FORBIDDEN':
    case 'NODE_PROOF_INVALID':
      return 403;
    case 'ROTATION_IN_PROGRESS':
    case 'CONFIRMATION_REQUIRED':
      return 409;
    case 'TOKEN_EXPIRED':
    case 'TOKEN_ALREADY_USED':
    case 'PROTOCOL_INCOMPATIBLE':
    case 'VERSION_SKEW':
    case 'NODE_UNSUPPORTED':
    case 'INVALID_REQUEST':
      return 400;
    case 'UNSUPPORTED_CAPABILITY':
    case 'NODE_REVOKED':
    case 'NODE_CREDENTIAL_EXPIRED':
    case 'REPAIR_REQUIRED':
    case 'SESSION_EXPIRED':
    case 'SESSION_REVOKED':
    case 'SESSION_MISMATCH':
    case 'SESSION_NON_RENEWABLE':
      return 403;
    case 'NOT_FOUND':
    case 'NODE_OFFLINE':
      return 404;
    case 'NODE_BUSY':
      return 503;
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

/**
 * Check whether a node is in a state that blocks new session-create:
 *   - `updating` — binary update in progress, drain in-flight sessions
 *   - `major-skew-error` — helper major version mismatch, must update first
 *   - protocol mismatch — node-link protocol != hub protocol
 *
 * Returns true and sends the appropriate error response if blocked; returns false if clear.
 * Extracted to keep the session-create route handler below the complexity limit (#655).
 */
export function sendNodeUnavailableForCreate(
  res: Response,
  node: import('../shared/relay-node-protocol.js').HubNodeSummary,
  nodeId: string
): boolean {
  if (node.status === 'updating') {
    res.setHeader('Retry-After', '60');
    res.status(503).json({
      error: relayError(
        'NODE_BUSY',
        `node ${nodeId} is updating; new sessions blocked while update drains. retry after 60 seconds.`,
        true,
        { reasonCode: 'NODE_UPDATING' }
      ),
    });
    return true;
  }
  if (node.helperSkew?.category === 'major-skew-error') {
    res.setHeader('Retry-After', '60');
    res.status(503).json({
      error: relayError('NODE_BUSY', node.helperSkew.message, true, {
        reasonCode: 'NODE_VERSION_SKEW',
        helperVersion: node.helperSkew.helperVersion,
        hubVersion: node.helperSkew.hubVersion,
        remediationHint: node.helperSkew.remediationHint,
      }),
    });
    return true;
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
    return true;
  }
  return false;
}

export function isSessionSummary(value: unknown): value is SessionSummary {
  if (typeof value !== 'object' || value === null) return false;
  const session = value as Partial<SessionSummary>;
  return (
    typeof session.id === 'string' &&
    session.type === 'terminal' &&
    session.mode === 'pty' &&
    sessionAssociationFieldsOk(session) &&
    typeof session.cwd === 'string' &&
    controlSummaryFieldsOk(session) &&
    sessionEnvelopeOk(session) &&
    typeof session.displayName === 'string' &&
    typeof session.createdAt === 'string' &&
    typeof session.lastActivity === 'string' &&
    typeof session.idle === 'boolean' &&
    (typeof session.customCommand === 'string' ||
      session.customCommand === null) &&
    (session.status === 'active' || session.status === 'disconnected') &&
    typeof session.needsBranchRename === 'boolean' &&
    typeof session.activityState === 'string'
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
  // WorkContext identity is hub-owned metadata. A paired node can report
  // arbitrary session fields, but the hub must only surface a WorkContext id
  // after validating the routed create request or resolving a stored link.
  delete scoped.workContextId;

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
      issuedAt:
        lifecycle.issuedAt ?? existingEnvelope?.issuedAt ?? scoped.createdAt,
      expiresAt:
        lifecycle.expiresAt !== undefined
          ? lifecycle.expiresAt
          : (existingEnvelope?.expiresAt ?? null),
      revocable: existingEnvelope?.revocable ?? true,
      peerIdentity: { kind: 'relay-node', nodeId },
      ...(existingEnvelope?.correlationId
        ? { correlationId: existingEnvelope.correlationId }
        : {}),
      ...(existingEnvelope?.auditId
        ? { auditId: existingEnvelope.auditId }
        : {}),
    }),
  };
}

function routedWorkContextId(
  body: Record<string, unknown>
): string | undefined {
  const value = body['workContextId'];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function validateRoutedWorkContext(
  store: WorkContextStore | undefined,
  workContextId: string | undefined
): RelayNodeError | null {
  if (!workContextId) return null;
  if (!store) {
    return relayError(
      'NODE_UNSUPPORTED',
      'workContextId is not supported by this hub runtime',
      false,
      { reasonCode: 'WORK_CONTEXT_UNSUPPORTED', workContextId }
    );
  }
  if (store.get(workContextId)) return null;
  return relayError('NOT_FOUND', 'work context was not found', false, {
    reasonCode: 'WORK_CONTEXT_NOT_FOUND',
    workContextId,
  });
}

function associateRoutedWorkContext(
  store: WorkContextStore | undefined,
  workContextId: string | undefined,
  session: SessionSummary
): string | null {
  if (!workContextId || !store) return null;
  try {
    store.associateSession(workContextId, { session });
    return null;
  } catch (error) {
    return error instanceof Error
      ? error.message
      : 'work_context_association_failed';
  }
}

function withTrustedWorkContextId(
  store: WorkContextStore | undefined,
  session: SessionSummary,
  workContextId: string | undefined
): SessionSummary {
  const trustedWorkContextId =
    workContextId ?? store?.findSessionWorkContextIds(session)[0];
  return trustedWorkContextId
    ? { ...session, workContextId: trustedWorkContextId }
    : session;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCliGatewayV1Request(req: Request): boolean {
  return req.header('x-relay-cli-gateway') === 'v1';
}

function sendGatewayCreateValidationError(
  res: Response,
  error: RelayCliGatewayError
): void {
  res.status(400).json({ error });
}

function routedGatewayCreateBodyFromRequest(
  req: Request,
  res: Response,
  routeNodeId: string
): Record<string, unknown> | null {
  const body = req.body as unknown;
  if (!isCliGatewayV1Request(req))
    return paramsWithoutConfirmation(bodyRecord(req));
  if (!isRecord(body)) {
    sendGatewayCreateValidationError(res, {
      code: 'INVALID_ARGUMENT',
      message: 'sessions.create input JSON must be an object',
      retryable: false,
    });
    return null;
  }

  const validationInput = paramsWithoutConfirmation(body);
  if (validationInput['nodeId'] === undefined)
    validationInput['nodeId'] = routeNodeId;
  const validated = validateAndSanitizeGatewayCreateInput(validationInput);
  if (validated.ok === false) {
    sendGatewayCreateValidationError(res, validated.error);
    return null;
  }
  if (validated.nodeId !== routeNodeId) {
    sendGatewayCreateValidationError(res, {
      code: 'INVALID_ARGUMENT',
      message: 'sessions.create nodeId must match route nodeId',
      retryable: false,
      details: {
        field: 'nodeId',
        nodeId: routeNodeId,
        bodyNodeId: validated.nodeId ?? null,
      },
    });
    return null;
  }

  const routedBody = { ...validated.input };
  delete routedBody['nodeId'];
  return routedBody;
}

function confirmationTokenFromRequest(
  req: Request,
  body: Record<string, unknown>
): string | undefined {
  const bodyToken = body['confirmationToken'];
  if (typeof bodyToken === 'string' && bodyToken.trim())
    return bodyToken.trim();
  const headerToken = req.header('x-confirmation-token');
  return headerToken?.trim() || undefined;
}

export function paramsWithoutConfirmation(
  body: Record<string, unknown>
): Record<string, unknown> {
  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (key === 'confirmationToken' || key === 'confirmationChallengeId')
      continue;
    cleaned[key] = value;
  }
  return cleaned;
}

function authSessionHash(req: Request): string {
  const cookieToken =
    typeof req.cookies?.token === 'string' ? req.cookies.token : undefined;
  if (cookieToken) return hashAuthSessionIdentity(`cookie:${cookieToken}`);
  const authHeader = req.header('authorization')?.trim();
  if (authHeader) return hashAuthSessionIdentity(`authorization:${authHeader}`);
  const explicit = req.header('x-auth-session')?.trim();
  if (explicit && req.header('x-test-auth'))
    return hashAuthSessionIdentity(`test-header:${explicit}`);
  if (req.header('x-test-auth'))
    return hashAuthSessionIdentity(`test:${req.header('x-test-auth')}`);
  return hashAuthSessionIdentity(`remote:${req.ip ?? 'unknown'}`);
}

function authSessionLabel(req: Request): string | undefined {
  if (!req.header('x-test-auth')) return undefined;
  return req.header('x-auth-session')?.trim() || undefined;
}

function authenticatedScopedRequesterIdentity(
  req: Request,
  requesterAuthSessionHash: string
): HighRiskApprovalRequesterIdentity | undefined {
  const credential = authenticatedCliGatewayActorCredential(req);
  if (!credential) return undefined;
  return {
    kind: 'scoped-actor',
    authSessionHash: requesterAuthSessionHash,
    actorType: credential.actor.type,
    actorId: credential.actor.id,
    credentialId: credential.id,
    ...(credential.scope.sessionIds?.[0]
      ? { sessionId: credential.scope.sessionIds[0] }
      : {}),
    ...(credential.scope.workContextIds?.[0]
      ? { workContextId: credential.scope.workContextIds[0] }
      : {}),
    ...(credential.actor.displayName
      ? { displayName: credential.actor.displayName }
      : {}),
  };
}

function routedRequesterIdentity(
  req: Request,
  requesterAuthSessionHash: string
): HighRiskApprovalRequesterIdentity {
  const scopedRequester = authenticatedScopedRequesterIdentity(
    req,
    requesterAuthSessionHash
  );
  if (scopedRequester) return scopedRequester;
  const displayName = authSessionLabel(req);
  return {
    kind: 'browser-session',
    authSessionHash: requesterAuthSessionHash,
    ...(displayName ? { displayName } : {}),
  };
}

function routedApproverIdentity(
  req: Request,
  approverAuthSessionHash: string
): HighRiskApprovalApproverIdentity {
  const credential = authenticatedCliGatewayActorCredential(req);
  if (credential) {
    return {
      kind: credential.actor.type === 'agent' ? 'scoped-actor' : 'human',
      actorType: credential.actor.type,
      actorId: credential.actor.id,
      credentialId: credential.id,
      ...(credential.scope.sessionIds?.[0]
        ? { sessionId: credential.scope.sessionIds[0] }
        : {}),
      ...(credential.scope.workContextIds?.[0]
        ? { workContextId: credential.scope.workContextIds[0] }
        : {}),
      ...(credential.actor.displayName
        ? { displayName: credential.actor.displayName }
        : {}),
    };
  }
  const displayName = authSessionLabel(req);
  return {
    kind: 'human',
    actorType: 'human',
    actorId: approverAuthSessionHash,
    ...(displayName ? { displayName } : {}),
  };
}

function routedApprovalTarget(
  requester: HighRiskApprovalRequesterIdentity
): HighRiskApprovalTarget | undefined {
  return requester.kind === 'scoped-actor' ? { kind: 'human' } : undefined;
}

function relayErrorForConfirmationFailure(
  failure: ConfirmationFailure
): RelayNodeError {
  return relayError(
    failure.reasonCode === 'CONFIRMATION_REQUIRED'
      ? 'CONFIRMATION_REQUIRED'
      : 'UNAUTHORIZED',
    failure.message,
    false,
    {
      reasonCode: failure.reasonCode,
      ...(failure.challenge
        ? { challenge: publicChallenge(failure.challenge) }
        : {}),
    }
  );
}

function appendConfirmationAudit(
  sink: RoutedSessionAuditSink | undefined,
  entry: SecurityAuditEntryInput | undefined,
  decision: HubPolicyDecision
): RelayNodeError | null {
  if (!entry || !sink) return null;
  try {
    sink.append(entry);
    return null;
  } catch {
    const classification = classifySecurityAuditWriteFailure({
      ...(decision.trustTier ? { trustTier: decision.trustTier } : {}),
      requiredBits: decision.requiredBits,
      decision: entry.decision,
    });
    if (classification.mode === 'fail-closed') {
      return policyDecisionToRelayError({
        ...decision,
        decision: 'deny',
        reasonCode: 'POLICY_AUDIT_WRITE_FAILED_CLOSED',
        message: classification.visibleMessage,
        grantedBits: [],
        deniedBits: decision.requiredBits,
        challengeBits: [],
      });
    }
    return null;
  }
}

function confirmationCreateInput(
  req: Request,
  requesterAuthSessionHash: string,
  canonicalParams: ReturnType<typeof canonicalConfirmationParams>
) {
  const requesterDisplayName = authSessionLabel(req);
  const requester = routedRequesterIdentity(req, requesterAuthSessionHash);
  const approvalTarget = routedApprovalTarget(requester);
  return {
    requesterAuthSessionHash,
    ...(requesterDisplayName ? { requesterDisplayName } : {}),
    requester,
    ...(approvalTarget ? { approvalTarget } : {}),
    canonicalParams,
  };
}

function confirmationApprovalInput(
  req: Request,
  challengeId: string,
  decision: ConfirmationDecision,
  now: Date
) {
  const approverDisplayName = authSessionLabel(req);
  const approverAuthSessionHash = authSessionHash(req);
  const approver = routedApproverIdentity(req, approverAuthSessionHash);
  return {
    challengeId,
    approverAuthSessionHash,
    ...(approverDisplayName ? { approverDisplayName } : {}),
    ...(approver ? { approver } : {}),
    decision,
    now,
  };
}

function resolveConfirmationForDecision(input: {
  confirmations: ConfirmationChallengeStore;
  auditSink: RoutedSessionAuditSink | undefined;
  req: Request;
  decision: HubPolicyDecision;
  params: Record<string, unknown>;
  now: Date;
}): { ok: true } | { ok: false; error: RelayNodeError } {
  if (input.decision.decision !== 'challenge') return { ok: true };
  const canonicalParams = canonicalConfirmationParams(
    input.decision.intent.action,
    input.params
  );
  const requesterAuthSessionHash = authSessionHash(input.req);
  const token = confirmationTokenFromRequest(input.req, bodyRecord(input.req));
  if (token) {
    const redeemed = input.confirmations.redeemToken({
      token,
      requesterAuthSessionHash,
      decision: { ...input.decision, params: canonicalParams },
      canonicalParams,
      now: input.now,
    });
    const auditError = appendConfirmationAudit(
      input.auditSink,
      redeemed.audit,
      redeemed.challenge?.decision ?? input.decision
    );
    if (auditError) return { ok: false, error: auditError };
    if (redeemed.ok === true) return { ok: true };
    return { ok: false, error: relayErrorForConfirmationFailure(redeemed) };
  }
  const decisionWithCanonicalParams = {
    ...input.decision,
    params: canonicalParams,
  };
  const auditedDecision = appendPolicyAudit(
    input.auditSink,
    decisionWithCanonicalParams,
    { params: canonicalParams }
  );
  if (auditedDecision.decision !== 'challenge') {
    return { ok: false, error: policyDecisionToRelayError(auditedDecision) };
  }
  let challenge: ReturnType<ConfirmationChallengeStore['createChallenge']>;
  try {
    challenge = input.confirmations.createChallenge(
      decisionWithCanonicalParams,
      confirmationCreateInput(
        input.req,
        requesterAuthSessionHash,
        canonicalParams
      )
    );
  } catch (error) {
    if (error instanceof ConfirmationChallengeCapacityError) {
      return {
        ok: false,
        error: relayError(
          'NODE_BUSY',
          'confirmation challenge capacity exhausted; retry after existing challenges resolve',
          true,
          { reasonCode: error.code, maxChallenges: error.maxChallenges }
        ),
      };
    }
    throw error;
  }
  return {
    ok: false,
    error: relayError('CONFIRMATION_REQUIRED', challenge.message, false, {
      reasonCode: 'CONFIRMATION_REQUIRED',
      challenge: publicChallenge(challenge),
    }),
  };
}

function isConfirmationDecision(value: unknown): value is ConfirmationDecision {
  return value === 'approve' || value === 'deny' || value === 'deny_revoke';
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
  payload['type'] = 'terminal';
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

function auditPeerForSummary(
  summary: ScopedSessionSummary | undefined
): SecurityAuditEntryInput['peer'] {
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

function appendFsWriteCompletionAudit(
  sink: RoutedSessionAuditSink | undefined,
  opts:
    | {
        success: true;
        peer: SecurityAuditEntryInput['peer'];
        nodeId: string;
        sessionId: string;
        policyScope: unknown;
        payload: unknown;
        correlationId?: string;
      }
    | {
        success: false;
        peer: SecurityAuditEntryInput['peer'];
        nodeId: string;
        sessionId: string;
        policyScope: unknown;
        errorCode: string;
        correlationId?: string;
      }
): void {
  appendRoutedSessionAudit(
    sink,
    opts.success
      ? {
          eventType: 'grant',
          decision: 'allow',
          reasonCode: 'POLICY_ALLOW',
          peer: opts.peer,
          node: { nodeId: opts.nodeId },
          sessionId: opts.sessionId,
          intent: { action: 'rpc.fs.write.completed', target: opts.nodeId },
          material: {
            scope: opts.policyScope,
            params:
              typeof opts.payload === 'object' && opts.payload !== null
                ? (opts.payload as Record<string, unknown>)
                : { payload: opts.payload },
          },
          ...(opts.correlationId ? { correlationId: opts.correlationId } : {}),
        }
      : {
          eventType: 'denial',
          decision: 'failed',
          reasonCode: opts.errorCode,
          peer: opts.peer,
          node: { nodeId: opts.nodeId },
          sessionId: opts.sessionId,
          intent: { action: 'rpc.fs.write.completed', target: opts.nodeId },
          material: {
            scope: opts.policyScope,
            params: { error: opts.errorCode },
          },
          ...(opts.correlationId ? { correlationId: opts.correlationId } : {}),
        }
  );
}

function auditLifecycleDenial(
  sink: RoutedSessionAuditSink | undefined,
  validation: Exclude<
    ReturnType<InMemorySessionEnvelopeRegistry['validate']>,
    { ok: true }
  >,
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
    ...(validation.summary?.correlationId
      ? { correlationId: validation.summary.correlationId }
      : {}),
  });
}

export function sendPolicyDecision(
  sink: RoutedSessionAuditSink | undefined,
  res: Response,
  decision: ReturnType<typeof evaluateHubPolicy>,
  params?: unknown,
  confirmation?: {
    confirmations: ConfirmationChallengeStore;
    req: Request;
    canonicalParams: Record<string, unknown>;
    now: Date;
  }
): boolean {
  if (decision.decision === 'challenge' && confirmation) {
    const resolved = resolveConfirmationForDecision({
      confirmations: confirmation.confirmations,
      auditSink: sink,
      req: confirmation.req,
      decision,
      params: confirmation.canonicalParams,
      now: confirmation.now,
    });
    if (resolved.ok === true) return false;
    sendRelayError(res, resolved.error);
    return true;
  }
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

function auditCredentialRotation(
  sink: RoutedSessionAuditSink | undefined,
  input: {
    nodeId: string;
    eventType: 'rotation' | 'revocation';
    decision: 'recorded' | 'rotated' | 'failed' | 'revoked';
    reasonCode: string;
    credentialId?: string;
    rotationId?: string;
    params?: unknown;
  }
): void {
  appendRoutedSessionAudit(sink, {
    eventType: input.eventType,
    decision: input.decision,
    reasonCode: input.reasonCode,
    peer: {
      kind: 'node',
      nodeId: input.nodeId,
      ...(input.credentialId ? { credentialId: input.credentialId } : {}),
    },
    node: { nodeId: input.nodeId },
    intent: { action: 'nodes.credential.rotate', target: input.nodeId },
    material: {
      params: {
        ...(input.rotationId ? { rotationId: input.rotationId } : {}),
        ...(input.params && typeof input.params === 'object'
          ? (input.params as Record<string, unknown>)
          : input.params !== undefined
            ? { detail: input.params }
            : {}),
      },
    },
  });
}

function revokedReasonFromBody(
  body: Record<string, unknown>
): string | undefined {
  const reason = body['reason'];
  return typeof reason === 'string' && reason.trim()
    ? reason.trim()
    : undefined;
}

const SESSION_RENEW_IMMUTABLE_FIELDS = [
  'intent',
  'scope',
  'peerIdentity',
  'sessionEnvelope',
] as const;

function renewAuthorityError(
  body: Record<string, unknown>
): RelayNodeError | null {
  const field = SESSION_RENEW_IMMUTABLE_FIELDS.find(
    (key) => body[key] !== undefined
  );
  if (!field) return null;
  return relayError(
    'SESSION_MISMATCH',
    'session renewal cannot change intent, scope, peer identity, or envelope authority',
    false,
    { reasonCode: 'SESSION_RENEW_AUTHORITY_IMMUTABLE', field }
  );
}

function renewExpiresAtFromBody(
  body: Record<string, unknown>,
  now: Date
): string | RelayNodeError {
  const lifecycleError = lifecycleInputError(body, now);
  if (lifecycleError) {
    return relayError('INVALID_REQUEST', lifecycleError.message, false, {
      reasonCode: 'INVALID_LIFECYCLE_INPUT',
      field: lifecycleError.field,
    });
  }
  if (body['expiresAt'] === null) {
    return relayError(
      'INVALID_REQUEST',
      'session renewal requires a finite future expiresAt or ttlSeconds/ttlMs',
      false,
      { reasonCode: 'SESSION_RENEWAL_EXPIRY_REQUIRED', field: 'expiresAt' }
    );
  }
  const expiresAt = expiresAtFromLifecycleInput(body, now);
  if (typeof expiresAt !== 'string') {
    return relayError(
      'INVALID_REQUEST',
      'session renewal requires expiresAt, ttlMs, or ttlSeconds',
      false,
      { reasonCode: 'SESSION_RENEWAL_EXPIRY_REQUIRED' }
    );
  }
  return expiresAt;
}

function auditLifecycleRenewal(
  sink: RoutedSessionAuditSink | undefined,
  input: {
    summary: ScopedSessionSummary;
    previousSummary: ScopedSessionSummary;
    params?: unknown;
  }
): void {
  appendRoutedSessionAudit(sink, {
    eventType: 'grant',
    decision: 'allow',
    reasonCode: 'SESSION_RENEWED',
    peer: auditPeerForSummary(input.summary),
    node: { nodeId: input.summary.nodeId },
    sessionId: input.summary.sessionId,
    intent: { action: 'sessions.renew', target: input.summary.nodeId },
    material: {
      scope: input.summary.scope,
      params: {
        requested: input.params ?? null,
        previousExpiresAt: input.previousSummary.expiresAt,
        renewedExpiresAt: input.summary.expiresAt,
      },
    },
    ...(input.summary.correlationId
      ? { correlationId: input.summary.correlationId }
      : {}),
  });
}

function auditRenewalImmediateDenial(
  sink: RoutedSessionAuditSink | undefined,
  input: {
    error: RelayNodeError;
    nodeId?: string;
    sessionId: string;
    params?: unknown;
  }
): void {
  const reasonCode =
    typeof input.error.details?.['reasonCode'] === 'string'
      ? input.error.details['reasonCode']
      : input.error.code;
  appendRoutedSessionAudit(sink, {
    eventType: 'denial',
    decision: 'deny',
    reasonCode,
    peer: { kind: 'hub' },
    node: { ...(input.nodeId ? { nodeId: input.nodeId } : {}) },
    sessionId: input.sessionId,
    intent: {
      action: 'sessions.renew',
      ...(input.nodeId ? { target: input.nodeId } : {}),
    },
    material: { params: input.params ?? input.error.details ?? null },
  });
}

function includeFlag(value: unknown): boolean {
  return value === '1' || value === 'true' || value === true;
}

function nodeLogLinesFromQuery(value: unknown): number | RelayNodeError {
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw === undefined) return 100;
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) {
    return relayError(
      'INVALID_REQUEST',
      'lines must be a non-negative integer'
    );
  }
  const lines = Number(raw);
  if (lines > 2_000)
    return relayError('INVALID_REQUEST', 'lines must be <= 2000');
  return lines;
}

function nodeLogOutput(payload: unknown): string {
  if (!isRecord(payload)) return '';
  const output = payload['output'];
  const message = payload['message'];
  if (typeof output === 'string' && output.length > 0) return output;
  if (typeof message === 'string') return `${message}\n`;
  return '';
}

function nodeLogChunk(payload: unknown): string {
  if (!isRecord(payload)) return '';
  const chunk = payload['chunk'];
  return typeof chunk === 'string' ? chunk : '';
}

function fileTailOutput(payload: unknown): string {
  if (!isRecord(payload)) return '';
  const content = payload['content'];
  return typeof content === 'string' ? content : '';
}

function fileTailChunk(payload: unknown): string {
  if (!isRecord(payload)) return '';
  const content = payload['content'];
  return typeof content === 'string' ? content : '';
}

function relayErrorText(error: RelayNodeError): string {
  return `\n[${error.code}] ${error.message}\n`;
}

function relayErrorFromUnknown(error: unknown): RelayNodeError {
  if (error instanceof HubNodeLinkError) return error.relayNodeError;
  return relayError(
    'INTERNAL',
    error instanceof Error ? error.message : String(error ?? 'unknown'),
    true
  );
}

async function streamFileTailFollow(input: {
  req: Request;
  res: Response;
  nodeLinks: HubNodeSessionTransport;
  nodeId: string;
  request: unknown;
}): Promise<void> {
  const { req, res, nodeLinks, nodeId, request } = input;
  if (!nodeLinks.streamRequest) {
    sendRelayError(
      res,
      relayError(
        'NODE_UNSUPPORTED',
        'file RPC tail follow is not supported by this runtime'
      )
    );
    return;
  }
  let closed = false;
  let draining = false;
  let bufferedBytes = 0;
  const pendingChunks: string[] = [];
  let stream: { payload: unknown; close(): void } | undefined;
  const close = (): void => {
    if (closed) return;
    closed = true;
    stream?.close();
  };
  const closeWithStreamError = (error: RelayNodeError): void => {
    if (closed || res.destroyed) return;
    const output = relayErrorText(error);
    close();
    if (!res.destroyed) res.end(output);
  };
  const flushBuffered = (): void => {
    if (closed || res.destroyed || draining) return;
    while (pendingChunks.length > 0) {
      const chunk = pendingChunks.shift()!;
      bufferedBytes -= Buffer.byteLength(chunk);
      if (!res.write(chunk)) {
        draining = true;
        res.once('drain', () => {
          draining = false;
          flushBuffered();
        });
        return;
      }
    }
  };
  const writeBounded = (chunk: string): void => {
    if (!chunk || closed || res.destroyed) return;
    if (draining || pendingChunks.length > 0) {
      const chunkBytes = Buffer.byteLength(chunk);
      bufferedBytes += chunkBytes;
      pendingChunks.push(chunk);
      if (bufferedBytes > FILE_RPC_FOLLOW_STREAM_BUFFER_BYTES) {
        closeWithStreamError(
          relayError(
            'NODE_BUSY',
            'file RPC tail follow output exceeded bounded response buffer; stream closed',
            true,
            {
              reasonCode: 'FILE_RPC_FOLLOW_BACKPRESSURE',
              maxBufferedBytes: FILE_RPC_FOLLOW_STREAM_BUFFER_BYTES,
            }
          )
        );
      }
      return;
    }
    if (!res.write(chunk)) {
      draining = true;
      res.once('drain', () => {
        draining = false;
        flushBuffered();
      });
    }
  };
  req.on('close', close);
  try {
    stream = await nodeLinks.streamRequest(nodeId, 'fs.tail', request, {
      onChunk: (payload) => {
        if (closed || res.destroyed) return;
        const chunk = fileTailChunk(payload);
        writeBounded(chunk);
      },
      onError: (error) => {
        if (closed || res.destroyed) return;
        closeWithStreamError(error);
      },
      onEnd: () => {
        if (closed || res.destroyed) return;
        res.end();
      },
    });
    res.status(200);
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.flushHeaders();
    if (closed || res.destroyed) {
      stream.close();
      return;
    }
    const output = fileTailOutput(stream.payload);
    writeBounded(output);
  } catch (error) {
    if (res.headersSent) {
      const streamError = relayErrorFromUnknown(error);
      if (!closed && !res.destroyed) closeWithStreamError(streamError);
      return;
    }
    res.removeHeader('Content-Type');
    res.removeHeader('Cache-Control');
    sendRelayError(res, relayErrorFromUnknown(error));
  }
}

function protocolVersionRelayError(
  nodeProtocolVersion: string
): RelayNodeError {
  const [nodeMajor] = nodeProtocolVersion.split('.');
  const [hubMajor] = RELAY_NODE_LINK_PROTOCOL_VERSION.split('.');
  return relayError(
    nodeMajor === hubMajor ? 'VERSION_SKEW' : 'PROTOCOL_INCOMPATIBLE',
    `relay-node-link protocol ${nodeProtocolVersion} must exactly match hub protocol ${RELAY_NODE_LINK_PROTOCOL_VERSION}`
  );
}

function nodeTerminalUnsupportedError(
  nodeId: string,
  node: HubNodeSummary
): RelayNodeError | null {
  if (node.capabilities.core.shell !== 'available') {
    return relayError(
      'NODE_UNSUPPORTED',
      `node ${nodeId} cannot host shell-backed terminal sessions`,
      false,
      {
        reasonCode: 'NODE_TERMINAL_SHELL_UNAVAILABLE',
        capability: 'shell',
        status: node.capabilities.core.shell,
      }
    );
  }
  if (!nodeHasTerminalBackend(node)) {
    const backends = nodeTerminalBackends(node);
    return relayError(
      'NODE_UNSUPPORTED',
      `node ${nodeId} cannot host PTY sessions: no terminal backend is available`,
      false,
      {
        reasonCode: 'NODE_TERMINAL_BACKEND_UNAVAILABLE',
        capability: 'terminalBackend',
        terminalBackends: backends,
      }
    );
  }
  return null;
}

function cwdOnboardingRoot(node: HubNodeSummary, cwd: string): string {
  if (node.platform === 'win32') {
    const drive = cwd.match(/^[a-zA-Z]:[\\/]/)?.[0]?.slice(0, 2);
    return drive ? `${drive}\\` : cwd;
  }
  return '/';
}

function nodeCwdOnboardingPayload(input: {
  node: HubNodeSummary;
  body: Record<string, unknown>;
  operation: 'browse' | 'validate';
}):
  | { request: Record<string, unknown>; cwd: string; path: string }
  | RelayNodeError {
  const cwd = stringField(input.body, 'cwd') ?? input.node.homeDir ?? '/';
  if (cwd.includes('\0')) {
    return relayError(
      'INVALID_REQUEST',
      'cwd must not contain NUL bytes',
      false,
      {
        reasonCode: 'NODE_CWD_INVALID_REQUEST',
        field: 'cwd',
      }
    );
  }
  const root = cwdOnboardingRoot(input.node, cwd);
  const pathValue =
    input.operation === 'validate'
      ? cwd
      : (stringField(input.body, 'path') ?? '.');
  if (pathValue.includes('\0')) {
    return relayError(
      'INVALID_REQUEST',
      'path must not contain NUL bytes',
      false,
      {
        reasonCode: 'NODE_CWD_INVALID_REQUEST',
        field: 'path',
      }
    );
  }
  const maxEntries = input.body['maxEntries'];
  return {
    cwd,
    path: pathValue,
    request: {
      sessionId: 'cwd-onboarding',
      root,
      cwd: input.operation === 'validate' ? root : cwd,
      path: pathValue,
      ...(input.operation === 'browse' && maxEntries !== undefined
        ? { maxEntries }
        : {}),
    },
  };
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

function sessionRenewPolicyScope(
  summary: ScopedSessionSummary
): Parameters<typeof evaluateHubPolicy>[0]['scope'] {
  return {
    kind: summary.scope.kind,
    nodeId: summary.nodeId,
    cwd: summary.scope.cwd,
    ...(summary.scope.repoPath ? { repoPath: summary.scope.repoPath } : {}),
    ...(summary.scope.worktreePath !== undefined
      ? { worktreePath: summary.scope.worktreePath }
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

function pairTokenMintGrantHandle(
  req: Request,
  body: Record<string, unknown>
): string | undefined {
  const header =
    req.header('x-relay-operator-grant') ??
    req.header('x-relay-handshake-grant') ??
    req.header('x-relay-pair-token-grant');
  if (header?.trim()) return header.trim();
  for (const key of ['operatorGrant', 'handshakeGrant', 'grantHandle']) {
    const value = body[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function pairTokenMintCorrelationId(
  req: Request,
  body: Record<string, unknown>,
  fallback?: string
): string | undefined {
  return (
    stringFromBody(body, 'correlationId') ??
    req.header('x-relay-correlation-id')?.trim() ??
    fallback
  );
}

function pairTokenMintActor(
  req: Request,
  body: Record<string, unknown>
): HandshakeGrantActor | undefined {
  const actor = body['actor'];
  if (typeof actor === 'object' && actor !== null && !Array.isArray(actor)) {
    const candidate = actor as Record<string, unknown>;
    if (
      typeof candidate['type'] === 'string' &&
      typeof candidate['id'] === 'string'
    ) {
      return {
        type: candidate['type'],
        id: candidate['id'],
        ...(typeof candidate['displayName'] === 'string'
          ? { displayName: candidate['displayName'] }
          : {}),
      };
    }
  }
  const actorType =
    stringFromBody(body, 'actorType') ??
    req.header('x-relay-actor-type')?.trim();
  const actorId =
    stringFromBody(body, 'actorId') ?? req.header('x-relay-actor-id')?.trim();
  if (!actorType || !actorId) return undefined;
  const actorDisplayName =
    stringFromBody(body, 'actorDisplayName') ??
    req.header('x-relay-actor-display-name')?.trim();
  return {
    type: actorType,
    id: actorId,
    ...(actorDisplayName ? { displayName: actorDisplayName } : {}),
  };
}

function pairTokenMintSessionBinding(
  body: Record<string, unknown>
): HandshakeGrantSessionBinding | undefined {
  const binding = body['sessionBinding'];
  const record =
    typeof binding === 'object' && binding !== null && !Array.isArray(binding)
      ? (binding as Record<string, unknown>)
      : body;
  const normalized: HandshakeGrantSessionBinding = {
    ...(typeof record['sessionId'] === 'string'
      ? { sessionId: record['sessionId'] }
      : {}),
    ...(typeof record['globalSessionId'] === 'string'
      ? { globalSessionId: record['globalSessionId'] }
      : {}),
    ...(typeof record['workContextId'] === 'string'
      ? { workContextId: record['workContextId'] }
      : {}),
    ...(typeof record['authSessionHash'] === 'string'
      ? { authSessionHash: record['authSessionHash'] }
      : {}),
  };
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function pairTokenMintScope(
  body: Record<string, unknown>
): HandshakeGrantValidationScope | undefined {
  const scope = body['scope'];
  const record =
    typeof scope === 'object' && scope !== null && !Array.isArray(scope)
      ? (scope as Record<string, unknown>)
      : body;
  const normalized: HandshakeGrantValidationScope = {
    ...(typeof record['nodeId'] === 'string'
      ? { nodeId: record['nodeId'] }
      : {}),
    ...(typeof record['sessionId'] === 'string'
      ? { sessionId: record['sessionId'] }
      : {}),
    ...(typeof record['globalSessionId'] === 'string'
      ? { globalSessionId: record['globalSessionId'] }
      : {}),
    ...(typeof record['workContextId'] === 'string'
      ? { workContextId: record['workContextId'] }
      : {}),
    ...(typeof record['repoId'] === 'string'
      ? { repoId: record['repoId'] }
      : {}),
    ...(typeof record['path'] === 'string' ? { path: record['path'] } : {}),
    ...(typeof record['taskRef'] === 'string'
      ? { taskRef: record['taskRef'] }
      : {}),
  };
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

type CapabilityListParseResult =
  | { ok: true; capabilities: RelayCapabilityBit[] }
  | {
      ok: false;
      reasonCode: string;
      message: string;
      invalidCapability?: string;
    };

function parseCapabilityList(value: unknown): CapabilityListParseResult {
  if (value === undefined) return { ok: true, capabilities: [] };
  if (!Array.isArray(value)) {
    return {
      ok: false,
      reasonCode: 'PAIR_TOKEN_CAPABILITY_LIST_INVALID',
      message: 'pair token capability lists must be arrays',
    };
  }
  const capabilities: RelayCapabilityBit[] = [];
  const seen = new Set<RelayCapabilityBit>();
  for (const candidate of value) {
    if (!isRelayCapabilityBit(candidate)) {
      return {
        ok: false,
        reasonCode: 'PAIR_TOKEN_CAPABILITY_UNKNOWN',
        message: 'unknown pair token capability requested',
        invalidCapability: String(candidate),
      };
    }
    if (candidate === NODE_PAIR_TOKEN_CREATE_CAPABILITY) continue;
    if (!seen.has(candidate)) {
      seen.add(candidate);
      capabilities.push(candidate);
    }
  }
  return { ok: true, capabilities };
}

function pairTokenCapabilityEnvelopeFromBody(body: Record<string, unknown>):
  | {
      ok: true;
      envelope?: {
        allowed?: RelayCapabilityBit[];
        requiresConfirmation?: RelayCapabilityBit[];
      };
    }
  | {
      ok: false;
      reasonCode: string;
      message: string;
      invalidCapability?: string;
    } {
  const rawEnvelope = body['capabilityEnvelope'];
  const envelope =
    typeof rawEnvelope === 'object' &&
    rawEnvelope !== null &&
    !Array.isArray(rawEnvelope)
      ? (rawEnvelope as Record<string, unknown>)
      : {};
  const allowed = parseCapabilityList(
    envelope['allowed'] ?? body['allowedCapabilities'] ?? body['capabilities']
  );
  if (!allowed.ok) return allowed;
  const requiresConfirmation = parseCapabilityList(
    envelope['requiresConfirmation'] ?? body['requiresConfirmationCapabilities']
  );
  if (!requiresConfirmation.ok) return requiresConfirmation;
  if (
    allowed.capabilities.length === 0 &&
    requiresConfirmation.capabilities.length === 0
  ) {
    return { ok: true };
  }
  return {
    ok: true,
    envelope: {
      ...(allowed.capabilities.length > 0
        ? { allowed: allowed.capabilities }
        : {}),
      ...(requiresConfirmation.capabilities.length > 0
        ? { requiresConfirmation: requiresConfirmation.capabilities }
        : {}),
    },
  };
}

function pairTokenCapabilityEnvelopeCapabilities(
  envelope: PairTokenCapabilityEnvelope | undefined
): RelayCapabilityBit[] {
  const capabilities = new Set<RelayCapabilityBit>();
  for (const capability of envelope?.allowed ?? [])
    capabilities.add(capability);
  for (const capability of envelope?.requiresConfirmation ?? []) {
    capabilities.add(capability);
  }
  return Array.from(capabilities);
}

function boundedGrantBackedPairTokenTrustTier(
  trustTier: RelayTrustTier | undefined
): RelayTrustTier | undefined {
  // A pair-token-create grant derives the legacy dev bootstrap posture. The
  // request may voluntarily narrow that to sandbox, but it cannot promote a
  // grant-backed mint into a body-chosen prod node unless a future grant schema
  // carries an explicit trust-tier bound.
  return trustTier === 'sandbox' ? trustTier : undefined;
}

function pairTokenTrustTierFromBody(
  body: Record<string, unknown>
): { ok: true; trustTier?: RelayTrustTier } | { ok: false; value: string } {
  const value = body['trustTier'];
  if (value === undefined) return { ok: true };
  if (isRelayTrustTier(value)) return { ok: true, trustTier: value };
  return { ok: false, value: String(value) };
}

function pairTokenGrantReasonCode(
  reason: HandshakeGrantValidationFailureReason
): string {
  return `PAIR_TOKEN_GRANT_${reason.toUpperCase()}`;
}

function relayErrorForPairTokenGrantFailure(input: {
  reason: HandshakeGrantValidationFailureReason;
  grantId?: string;
  deniedBits: string[];
}): RelayNodeError {
  const reasonCode = pairTokenGrantReasonCode(input.reason);
  const details = {
    reasonCode,
    ...(input.grantId ? { grantId: input.grantId } : {}),
    deniedBits: input.deniedBits,
  };
  switch (input.reason) {
    case 'expired':
      return relayError(
        'TOKEN_EXPIRED',
        'operator handshake grant expired',
        false,
        details
      );
    case 'replayed':
      return relayError(
        'TOKEN_ALREADY_USED',
        'operator handshake grant was already consumed',
        false,
        details
      );
    case 'wrong_audience':
    case 'insufficient_capability':
    case 'missing_scope':
    case 'wrong_node_scope':
    case 'wrong_session_scope':
    case 'wrong_global_session_scope':
    case 'wrong_work_context_scope':
    case 'wrong_repo_scope':
    case 'wrong_path_scope':
    case 'wrong_task_scope':
      return relayError(
        'FORBIDDEN',
        'operator handshake grant cannot mint pair tokens for this request',
        false,
        details
      );
    default:
      return relayError(
        'UNAUTHORIZED',
        'valid operator handshake grant is required to mint a pair token',
        false,
        details
      );
  }
}

function appendPairTokenGrantAudit(
  auditSink: RoutedSessionAuditSink | undefined,
  input: {
    reason: HandshakeGrantValidationFailureReason;
    decision: 'deny' | 'expired';
    grantId?: string;
    deniedBits: string[];
    correlationId?: string;
  }
): void {
  if (!auditSink) return;
  const deniedBits = normalizeCapabilityBits(input.deniedBits);
  try {
    auditSink.append({
      eventType:
        input.reason === 'replayed'
          ? 'failed_redemption'
          : input.reason === 'expired'
            ? 'expiry'
            : 'denial',
      decision: input.decision,
      reasonCode: pairTokenGrantReasonCode(input.reason),
      peer: {
        kind: 'system',
        ...(input.grantId ? { credentialId: input.grantId } : {}),
      },
      intent: { action: 'nodes.pair-token.create' },
      material: {
        params: { reason: input.reason, grantId: input.grantId ?? null },
        scope: { audience: NODE_PAIR_TOKEN_MINT_GRANT_AUDIENCE },
      },
      requiredBits: [NODE_PAIR_TOKEN_CREATE_CAPABILITY],
      deniedBits,
      refs: { policyVersion: '1.0' },
      ...(input.correlationId ? { correlationId: input.correlationId } : {}),
    });
  } catch {
    // Denial path only; never leak grant material while trying to report audit failures.
  }
}

function recordFromBody(
  body: Record<string, unknown>,
  key: string
): Record<string, unknown> | undefined {
  const value = body[key];
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function requiredStringFromRecord(
  record: Record<string, unknown> | undefined,
  key: string
): string | undefined {
  const value = record?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function handshakeGrantIssuerFromBody(
  body: Record<string, unknown>,
  key: 'issuer' | 'approvedBy' | 'deniedBy' | 'revokedBy',
  fallbackId: string
): { id: string; displayName?: string } {
  const record = recordFromBody(body, key);
  const id =
    requiredStringFromRecord(record, 'id') ??
    (typeof body[key] === 'string' && body[key].trim()
      ? body[key].trim()
      : fallbackId);
  const displayName = requiredStringFromRecord(record, 'displayName');
  return { id, ...(displayName ? { displayName } : {}) };
}

function handshakeGrantActorFromBody(
  body: Record<string, unknown>
): HandshakeGrantActor | null {
  const actor = recordFromBody(body, 'actor');
  const type = requiredStringFromRecord(actor, 'type');
  const id = requiredStringFromRecord(actor, 'id');
  if (!type || !id) return null;
  const displayName = requiredStringFromRecord(actor, 'displayName');
  return { type, id, ...(displayName ? { displayName } : {}) };
}

function handshakeGrantCapabilitiesFromBody(
  body: Record<string, unknown>
): string[] | null {
  const value = body['capabilities'];
  if (!Array.isArray(value)) return null;
  const capabilities = value.filter(
    (capability): capability is string =>
      typeof capability === 'string' && capability.trim().length > 0
  );
  return capabilities.length > 0 ? capabilities : null;
}

function handshakeGrantScopeFromBody(
  body: Record<string, unknown>
): HandshakeGrantScope | null {
  const scope = recordFromBody(body, 'scope');
  return scope ? (scope as HandshakeGrantScope) : null;
}

function relayErrorForHandshakeGrantRegistryError(
  error: HandshakeGrantRegistryError
): RelayNodeError {
  return relayError('INVALID_REQUEST', error.message, false, {
    reasonCode: `HANDSHAKE_GRANT_${error.code.toUpperCase()}`,
  });
}

const PAIRING_HIGH_RISK_BIT_SET = new Set<string>(HIGH_RISK_CAPABILITIES);

// #982: stable sha256 of a value, for binding capability/roots sets into the
// exact-operation confirmation params WITHOUT exposing raw bits or paths in the
// public challenge surface. Inputs are pre-sorted arrays so the hash is stable.
function pairingBindingHash(value: unknown): string {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(value))
    .digest('hex');
}
const PAIRING_REQUEST_STATES = new Set([
  'pending',
  'approved',
  'denied',
  'expired',
]);

function pairingStateFromQuery(
  value: unknown
): 'pending' | 'approved' | 'denied' | 'expired' | undefined {
  return typeof value === 'string' && PAIRING_REQUEST_STATES.has(value)
    ? (value as 'pending' | 'approved' | 'denied' | 'expired')
    : undefined;
}

function pairingProfileFromBody(
  body: Record<string, unknown>
): { ok: true; profile?: NodePairingTrustProfile } | { ok: false } {
  const value = body['requestedProfile'] ?? body['profile'];
  if (value === undefined || value === null) return { ok: true };
  if (isNodePairingTrustProfile(value)) return { ok: true, profile: value };
  return { ok: false };
}

/**
 * Parse the editable-access fields shared by the request, edit-access, and
 * approve routes. Capabilities reuse {@link parseCapabilityList} so unknown bits
 * fail closed; `node:pair-token:create` is dropped (never a node ACL default).
 */
function pairingAccessEditFromBody(body: Record<string, unknown>):
  | {
      ok: true;
      edit: PendingPairingAccessEdit;
      requestedCapabilityBits?: RelayCapabilityBit[];
    }
  | { ok: false; error: RelayNodeError } {
  const profile = pairingProfileFromBody(body);
  if (!profile.ok) {
    return {
      ok: false,
      error: relayError(
        'INVALID_REQUEST',
        'requestedProfile must be a known node pairing trust profile',
        false,
        { reasonCode: 'PENDING_PAIRING_PROFILE_INVALID' }
      ),
    };
  }
  const capabilitiesProvided =
    body['requestedCapabilities'] !== undefined ||
    body['capabilities'] !== undefined;
  const capabilities = parseCapabilityList(
    body['requestedCapabilities'] ?? body['capabilities']
  );
  if (!capabilities.ok) {
    return {
      ok: false,
      error: relayError('INVALID_REQUEST', capabilities.message, false, {
        reasonCode: capabilities.reasonCode,
        ...(capabilities.invalidCapability
          ? { capability: capabilities.invalidCapability }
          : {}),
      }),
    };
  }
  const displayName = stringFromBody(body, 'displayName');
  const rootsValue = body['requestedRoots'] ?? body['roots'];
  const roots = Array.isArray(rootsValue)
    ? rootsValue.filter((root): root is string => typeof root === 'string')
    : undefined;
  const edit: PendingPairingAccessEdit = {
    ...(displayName ? { displayName } : {}),
    ...(profile.profile ? { requestedProfile: profile.profile } : {}),
    ...(capabilitiesProvided
      ? { requestedCapabilities: capabilities.capabilities }
      : {}),
    ...(roots ? { requestedRoots: roots } : {}),
  };
  return {
    ok: true,
    edit,
    ...(capabilitiesProvided
      ? { requestedCapabilityBits: capabilities.capabilities }
      : {}),
  };
}

function cachedAuditVerify(input: {
  auditSink: RoutedSessionAuditSink;
  nowMs: number;
  force: boolean;
  cache: AuditVerifyCacheEntry | null;
}): { result: SecurityAuditVerificationResult; cache: AuditVerifyCacheEntry } {
  const head = input.auditSink.head?.();
  const cache = input.cache;
  const cacheMatchesHead = Boolean(
    head &&
    cache &&
    cache.latestSequence === head.latestSequence &&
    cache.latestHash === head.latestHash
  );
  if (!input.force && cacheMatchesHead && cache) {
    return { result: cache.result, cache };
  }
  if (!input.force && head) {
    const result: SecurityAuditVerificationResult = {
      ok: true,
      entriesVerified: head.latestSequence,
      lastHash: head.latestHash,
    };
    return {
      result,
      cache: {
        latestSequence: head.latestSequence,
        latestHash: head.latestHash,
        result,
        verifiedAtMs: input.nowMs,
      },
    };
  }
  const result = input.auditSink.verify?.();
  if (!result) throw new Error('audit verify sink unavailable');
  const nextCache = {
    latestSequence: head?.latestSequence ?? result.entriesVerified,
    latestHash: head?.latestHash ?? result.lastHash,
    result,
    verifiedAtMs: input.nowMs,
  };
  return { result, cache: nextCache };
}

export function createHubNodeRouter(
  options: HubNodeRouterOptions
): express.Router {
  const router = express.Router();
  const { registry, requireAuth } = options;
  const cliGatewayAuth = options.cliGatewayAuth ?? requireAuth;
  const cliGatewayAuthForActorCommand =
    options.cliGatewayAuthForActorCommand ?? (() => cliGatewayAuth);
  const scopedSessionAuth = options.scopedSessionAuth ?? requireAuth;
  const envelopes = options.sessionEnvelopes ?? sessionEnvelopeRegistry;
  const confirmations =
    options.confirmations ?? createConfirmationChallengeStore();
  const now = () => options.now?.() ?? new Date();
  const operatorHandshakeGrants =
    options.operatorHandshakeGrants ?? new HandshakeGrantRegistry({ now });
  const repoInventoryFeature =
    options.repoInventoryFeature ?? createRepoInventoryFeature(registry);
  let auditVerifyCache: AuditVerifyCacheEntry | null = null;

  router.get('/hub/confirmations', requireAuth, (_req, res) => {
    res.json({ challenges: confirmations.listChallenges() });
  });

  router.get('/hub/confirmations/:challengeId', requireAuth, (req, res) => {
    const { challengeId } = req.params;
    const challenge = challengeId
      ? confirmations.getChallenge(challengeId)
      : undefined;
    if (!challenge) {
      sendRelayError(
        res,
        relayError('NOT_FOUND', 'confirmation challenge not found', false, {
          reasonCode: 'CONFIRMATION_NOT_FOUND',
        })
      );
      return;
    }
    res.json({ challenge: publicChallenge(challenge) });
  });

  router.post(
    '/hub/confirmations/:challengeId/requester-token',
    requireAuth,
    (req, res) => {
      const { challengeId } = req.params;
      if (!challengeId) {
        sendRelayError(
          res,
          relayError(
            'INVALID_REQUEST',
            'confirmation challenge id is required',
            false,
            {
              reasonCode: 'CONFIRMATION_NOT_FOUND',
            }
          )
        );
        return;
      }
      const result = confirmations.getRequesterToken({
        challengeId,
        requesterAuthSessionHash: authSessionHash(req),
        now: now(),
      });
      if (result.ok === false) {
        sendRelayError(res, relayErrorForConfirmationFailure(result));
        return;
      }
      res.json({
        confirmationToken: result.confirmationToken,
        challenge: publicChallenge(result.challenge),
      });
    }
  );

  router.post(
    '/hub/confirmations/:challengeId/approve',
    requireAuth,
    (req, res) => {
      const { challengeId } = req.params;
      const body = bodyRecord(req);
      const decision = body['decision'] ?? 'approve';
      if (!challengeId || !isConfirmationDecision(decision)) {
        sendRelayError(
          res,
          relayError(
            'INVALID_REQUEST',
            'decision must be approve, deny, or deny_revoke',
            false,
            {
              reasonCode: 'CONFIRMATION_INVALID_DECISION',
            }
          )
        );
        return;
      }
      const result = confirmations.approveChallenge(
        confirmationApprovalInput(req, challengeId, decision, now())
      );
      const auditError = result.challenge
        ? appendConfirmationAudit(
            options.auditSink,
            result.audit,
            result.challenge.decision
          )
        : null;
      if (auditError) {
        if (result.ok === true) {
          confirmations.invalidateChallenge({
            challengeId: result.challenge.challengeId,
            reasonCode: 'CONFIRMATION_TOKEN_INVALID',
            message:
              'confirmation approval audit write failed; approval token invalidated',
            now: now(),
          });
        }
        sendRelayError(res, auditError);
        return;
      }
      if (result.ok === false) {
        sendRelayError(res, relayErrorForConfirmationFailure(result));
        return;
      }
      res.json({
        confirmationToken: result.confirmationToken,
        challenge: publicChallenge(result.challenge),
      });
    }
  );

  router.get('/hub/operator-handshake-grants', requireAuth, (_req, res) => {
    res.json({ grants: operatorHandshakeGrants.listGrants() });
  });

  router.post('/hub/operator-handshake-grants', requireAuth, (req, res) => {
    const body = bodyRecord(req);
    const actor = handshakeGrantActorFromBody(body);
    const audience = stringFromBody(body, 'audience');
    const capabilities = handshakeGrantCapabilitiesFromBody(body);
    const scope = handshakeGrantScopeFromBody(body);
    if (!actor || !audience || !capabilities || !scope) {
      sendRelayError(
        res,
        relayError(
          'INVALID_REQUEST',
          'actor, audience, capabilities, and scope are required',
          false,
          { reasonCode: 'HANDSHAKE_GRANT_REQUEST_INVALID' }
        )
      );
      return;
    }
    const deviceRecord = recordFromBody(body, 'device');
    const deviceId = requiredStringFromRecord(deviceRecord, 'id');
    if (deviceRecord && !deviceId) {
      sendRelayError(
        res,
        relayError(
          'INVALID_REQUEST',
          'device.id is required when device is supplied',
          false,
          {
            reasonCode: 'HANDSHAKE_GRANT_DEVICE_INVALID',
          }
        )
      );
      return;
    }
    const deviceDisplayName = requiredStringFromRecord(
      deviceRecord,
      'displayName'
    );
    const device = deviceId
      ? {
          id: deviceId,
          ...(deviceDisplayName ? { displayName: deviceDisplayName } : {}),
        }
      : undefined;
    const sessionBinding = pairTokenMintSessionBinding(body);
    const metadata = recordFromBody(body, 'metadata');
    const expiresAt =
      typeof body['expiresAt'] === 'string' ? body['expiresAt'] : undefined;
    const ttlMs = typeof body['ttlMs'] === 'number' ? body['ttlMs'] : undefined;
    const correlationId = pairTokenMintCorrelationId(req, body);
    try {
      const grant = operatorHandshakeGrants.request({
        actor,
        issuer: handshakeGrantIssuerFromBody(
          body,
          'issuer',
          'browser-operator'
        ),
        audience,
        capabilities,
        scope,
        ...(device ? { device } : {}),
        ...(sessionBinding ? { sessionBinding } : {}),
        ...(metadata ? { metadata: metadata as never } : {}),
        ...(expiresAt ? { expiresAt } : {}),
        ...(ttlMs !== undefined ? { ttlMs } : {}),
        ...(correlationId ? { correlationId } : {}),
      });
      res.status(201).json({ grant });
    } catch (error) {
      if (error instanceof HandshakeGrantRegistryError) {
        sendRelayError(res, relayErrorForHandshakeGrantRegistryError(error));
        return;
      }
      throw error;
    }
  });

  router.post(
    '/hub/operator-handshake-grants/:grantId/approve',
    requireAuth,
    (req, res) => {
      const body = bodyRecord(req);
      const grantId = req.params.grantId;
      if (!grantId) {
        sendRelayError(
          res,
          relayError('INVALID_REQUEST', 'grant id is required', false, {
            reasonCode: 'HANDSHAKE_GRANT_ID_REQUIRED',
          })
        );
        return;
      }
      const highRiskApproval = recordFromBody(body, 'highRiskApproval');
      const correlationId = pairTokenMintCorrelationId(req, body);
      try {
        const approved = operatorHandshakeGrants.approve(grantId, {
          approvedBy: handshakeGrantIssuerFromBody(
            body,
            'approvedBy',
            'browser-operator'
          ),
          ...(highRiskApproval
            ? { highRiskApproval: highRiskApproval as never }
            : {}),
          ...(correlationId ? { correlationId } : {}),
        });
        res.json(approved);
      } catch (error) {
        if (error instanceof HandshakeGrantRegistryError) {
          sendRelayError(res, relayErrorForHandshakeGrantRegistryError(error));
          return;
        }
        throw error;
      }
    }
  );

  router.post(
    '/hub/operator-handshake-grants/:grantId/revoke',
    requireAuth,
    (req, res) => {
      const body = bodyRecord(req);
      const grantId = req.params.grantId;
      if (!grantId) {
        sendRelayError(
          res,
          relayError('INVALID_REQUEST', 'grant id is required', false, {
            reasonCode: 'HANDSHAKE_GRANT_ID_REQUIRED',
          })
        );
        return;
      }
      const reason =
        typeof body['reason'] === 'string' ? body['reason'] : undefined;
      const correlationId = pairTokenMintCorrelationId(req, body);
      const grant = operatorHandshakeGrants.revoke(grantId, {
        revokedBy: handshakeGrantIssuerFromBody(
          body,
          'revokedBy',
          'browser-operator'
        ),
        ...(reason ? { reason } : {}),
        ...(correlationId ? { correlationId } : {}),
      });
      if (!grant) {
        sendRelayError(
          res,
          relayError('NOT_FOUND', 'operator handshake grant not found', false, {
            reasonCode: 'HANDSHAKE_GRANT_NOT_FOUND',
          })
        );
        return;
      }
      options.onOperatorHandshakeGrantRevoked?.({
        grantId,
        revokedBy: 'browser-operator',
        ...(reason ? { reason } : {}),
        ...(correlationId ? { correlationId } : {}),
      });
      res.json({ grant });
    }
  );

  function sendMintedPairToken(input: {
    req: Request;
    res: Response;
    body: Record<string, unknown>;
    trustTier?: RelayTrustTier;
    capabilityEnvelope?: PairTokenCapabilityEnvelope;
    grant?: ReturnType<HandshakeGrantRegistry['getGrant']>;
  }): void {
    const { req, res, body, grant } = input;
    const displayName = stringFromBody(body, 'displayName');
    const ttlMs = pairTtlMs(body);
    const correlationId = pairTokenMintCorrelationId(
      req,
      body,
      grant?.correlationId
    );
    const source = sourceTupleFromRequest(req);
    const platform = stringFromBody(body, 'platform');
    const pairToken = registry.createPairToken({
      ...(displayName ? { displayName } : {}),
      ...(ttlMs !== undefined ? { ttlMs } : {}),
      ...(platform ? { platform } : {}),
      ...(input.trustTier ? { trustTier: input.trustTier } : {}),
      ...(input.capabilityEnvelope
        ? { capabilityEnvelope: input.capabilityEnvelope }
        : {}),
      ...(grant
        ? {
            issuer: {
              grantId: grant.id,
              actorType: grant.actor.type,
              ...(grant.actor.displayName
                ? { actorDisplayName: grant.actor.displayName }
                : {}),
              actorId: grant.actor.id,
            },
          }
        : {}),
      ...(correlationId ? { correlationId } : {}),
      ...(source ? { source } : {}),
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
  }

  router.post('/hub/pair-tokens', (req, res) => {
    const body = bodyRecord(req);
    const grantHandle = pairTokenMintGrantHandle(req, body);
    if (!grantHandle) {
      sendRelayError(
        res,
        relayError(
          'UNAUTHORIZED',
          'operator handshake grant is required to mint pair tokens',
          false,
          {
            reasonCode: 'PAIR_TOKEN_GRANT_REQUIRED',
            acceptedLanes: ['operator-handshake-grant'],
            rejectedLanes: ['browser-session', 'node-credential'],
          }
        )
      );
      return;
    }

    const correlationId = pairTokenMintCorrelationId(req, body);
    const actor = pairTokenMintActor(req, body);
    const deviceId = stringFromBody(body, 'deviceId');
    const sessionBinding = pairTokenMintSessionBinding(body);
    const scope = pairTokenMintScope(body);
    const trustTier = pairTokenTrustTierFromBody(body);
    if (trustTier.ok === false) {
      sendRelayError(
        res,
        relayError(
          'INVALID_REQUEST',
          'trustTier must be sandbox, dev, or prod',
          false,
          {
            reasonCode: 'PAIR_TOKEN_TRUST_TIER_INVALID',
            trustTier: trustTier.value,
          }
        )
      );
      return;
    }
    const capabilityEnvelope = pairTokenCapabilityEnvelopeFromBody(body);
    if (capabilityEnvelope.ok === false) {
      sendRelayError(
        res,
        relayError('INVALID_REQUEST', capabilityEnvelope.message, false, {
          reasonCode: capabilityEnvelope.reasonCode,
          ...(capabilityEnvelope.invalidCapability
            ? { capability: capabilityEnvelope.invalidCapability }
            : {}),
        })
      );
      return;
    }
    const validation = operatorHandshakeGrants.validate(grantHandle, {
      audience: NODE_PAIR_TOKEN_MINT_GRANT_AUDIENCE,
      requiredCapabilities: [
        NODE_PAIR_TOKEN_CREATE_CAPABILITY,
        ...pairTokenCapabilityEnvelopeCapabilities(capabilityEnvelope.envelope),
      ],
      ...(actor ? { actor } : {}),
      ...(deviceId ? { deviceId } : {}),
      ...(sessionBinding ? { sessionBinding } : {}),
      ...(scope ? { scope } : {}),
      consume: true,
      ...(correlationId ? { correlationId } : {}),
    });
    if (validation.ok === false) {
      const failure = validation;
      appendPairTokenGrantAudit(options.auditSink, {
        reason: failure.reason,
        decision: failure.reason === 'expired' ? 'expired' : 'deny',
        ...(failure.grantId ? { grantId: failure.grantId } : {}),
        deniedBits: failure.deniedBits,
        ...(correlationId ? { correlationId } : {}),
      });
      sendRelayError(res, relayErrorForPairTokenGrantFailure(failure));
      return;
    }
    const boundedTrustTier = boundedGrantBackedPairTokenTrustTier(
      trustTier.trustTier
    );
    sendMintedPairToken({
      req,
      res,
      body,
      ...(boundedTrustTier ? { trustTier: boundedTrustTier } : {}),
      ...(capabilityEnvelope.envelope
        ? { capabilityEnvelope: capabilityEnvelope.envelope }
        : {}),
      grant: validation.grant,
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
      // #981: node-supplied public key (PEM). Public material only; the hub
      // binds its fingerprint to the issued credential.
      const publicKey =
        typeof body['publicKey'] === 'string' ? body['publicKey'] : undefined;
      const source = sourceTupleFromRequest(req);
      res.status(201).json(
        registry.exchangePairToken({
          pairToken,
          manifest,
          ...(displayName ? { displayName } : {}),
          ...(protocolVersion ? { protocolVersion } : {}),
          ...(source ? { source } : {}),
          ...(publicKey ? { publicKey } : {}),
        })
      );
    } catch (error) {
      sendRegistryError(registry, res, error);
    }
  });

  // ===========================================================================
  // #982: pending node pairing request lifecycle.
  //
  // Node-facing (unauthenticated, like /hub/pairing/exchange):
  //   POST /hub/pairing/requests             submit a pending request
  //   POST /hub/pairing/requests/:id/status  poll status / one-time credential claim
  // Operator (requireAuth):
  //   GET   /hub/pairing/requests            list (?state=, ?deviceCode=)
  //   GET   /hub/pairing/requests/:id        inspect
  //   PATCH /hub/pairing/requests/:id/access edit requested access before approval
  //   POST  /hub/pairing/requests/:id/approve approve (high-risk → exact-op confirmation)
  //   POST  /hub/pairing/requests/:id/deny    deny
  // ===========================================================================

  router.post('/hub/pairing/requests', (req, res) => {
    const body = bodyRecord(req);
    let manifest: NodeManifest;
    try {
      manifest = manifestFromBody(body, true)!;
    } catch (error) {
      sendRegistryError(registry, res, error);
      return;
    }
    const parsed = pairingAccessEditFromBody(body);
    if (!parsed.ok) {
      sendRelayError(res, parsed.error);
      return;
    }
    const publicKey =
      typeof body['publicKey'] === 'string' ? body['publicKey'] : undefined;
    const protocolVersion =
      typeof body['protocolVersion'] === 'string'
        ? body['protocolVersion']
        : undefined;
    const correlationId = pairTokenMintCorrelationId(req, body);
    const source = sourceTupleFromRequest(req);
    try {
      const result = registry.submitPendingPairingRequest({
        manifest,
        ...(publicKey ? { publicKey } : {}),
        ...(parsed.edit.displayName
          ? { displayName: parsed.edit.displayName }
          : {}),
        ...(parsed.edit.requestedProfile
          ? { requestedProfile: parsed.edit.requestedProfile }
          : {}),
        ...(parsed.requestedCapabilityBits
          ? { requestedCapabilities: parsed.requestedCapabilityBits }
          : {}),
        ...(parsed.edit.requestedRoots
          ? { requestedRoots: parsed.edit.requestedRoots }
          : {}),
        ...(protocolVersion ? { protocolVersion } : {}),
        ...(correlationId ? { correlationId } : {}),
        ...(source ? { source } : {}),
      });
      res.status(201).json(result);
    } catch (error) {
      sendRegistryError(registry, res, error);
    }
  });

  router.post('/hub/pairing/requests/:requestId/status', (req, res) => {
    const { requestId } = req.params;
    const body = bodyRecord(req);
    const statusToken =
      req.header('x-relay-pairing-status-token')?.trim() ||
      (typeof body['statusToken'] === 'string'
        ? body['statusToken'].trim()
        : '');
    if (!requestId || !statusToken) {
      sendRelayError(
        res,
        relayError(
          'INVALID_REQUEST',
          'requestId and pairing status token are required',
          false,
          { reasonCode: 'PENDING_PAIRING_STATUS_TOKEN_REQUIRED' }
        )
      );
      return;
    }
    const source = sourceTupleFromRequest(req);
    try {
      const result = registry.pollPendingPairingRequest(
        requestId,
        statusToken,
        {
          ...(source ? { source } : {}),
        }
      );
      res.json(result);
    } catch (error) {
      sendRegistryError(registry, res, error);
    }
  });

  router.get('/hub/pairing/requests', requireAuth, (req, res) => {
    const deviceCode =
      typeof req.query['deviceCode'] === 'string'
        ? req.query['deviceCode']
        : undefined;
    if (deviceCode) {
      const match = registry.findPendingPairingRequestByDeviceCode(deviceCode);
      if (!match) {
        sendRelayError(
          res,
          relayError(
            'NOT_FOUND',
            'no pairing request matches that device code',
            false,
            { reasonCode: 'PENDING_PAIRING_NOT_FOUND' }
          )
        );
        return;
      }
      res.json({ requests: [match], request: match });
      return;
    }
    const state = pairingStateFromQuery(req.query['state']);
    const includeResolved =
      req.query['includeResolved'] === 'true' || req.query['all'] === 'true';
    res.json({
      requests: registry.listPendingPairingRequests({
        ...(state ? { state } : {}),
        ...(includeResolved ? { includeResolved } : {}),
      }),
    });
  });

  router.get('/hub/pairing/requests/:requestId', requireAuth, (req, res) => {
    const { requestId } = req.params;
    const request = requestId
      ? registry.getPendingPairingRequest(requestId)
      : null;
    if (!request) {
      sendRelayError(
        res,
        relayError('NOT_FOUND', 'pending pairing request not found', false, {
          reasonCode: 'PENDING_PAIRING_NOT_FOUND',
        })
      );
      return;
    }
    res.json({ request });
  });

  router.patch(
    '/hub/pairing/requests/:requestId/access',
    requireAuth,
    (req, res) => {
      const { requestId } = req.params;
      if (!requestId) {
        sendRelayError(
          res,
          relayError('INVALID_REQUEST', 'requestId is required', false, {
            reasonCode: 'PENDING_PAIRING_REQUEST_ID_REQUIRED',
          })
        );
        return;
      }
      const parsed = pairingAccessEditFromBody(bodyRecord(req));
      if (!parsed.ok) {
        sendRelayError(res, parsed.error);
        return;
      }
      try {
        const request = registry.editPendingPairingAccess(
          requestId,
          parsed.edit
        );
        res.json({ request });
      } catch (error) {
        sendRegistryError(registry, res, error);
      }
    }
  );

  router.post(
    '/hub/pairing/requests/:requestId/approve',
    requireAuth,
    (req, res) => {
      const { requestId } = req.params;
      if (!requestId) {
        sendRelayError(
          res,
          relayError('INVALID_REQUEST', 'requestId is required', false, {
            reasonCode: 'PENDING_PAIRING_REQUEST_ID_REQUIRED',
          })
        );
        return;
      }
      const body = bodyRecord(req);
      const parsed = pairingAccessEditFromBody(body);
      if (!parsed.ok) {
        sendRelayError(res, parsed.error);
        return;
      }
      const summary = registry.getPendingPairingRequest(requestId);
      if (!summary) {
        sendRelayError(
          res,
          relayError('NOT_FOUND', 'pending pairing request not found', false, {
            reasonCode: 'PENDING_PAIRING_NOT_FOUND',
          })
        );
        return;
      }
      // Higher-risk profile/capability choices route through the existing
      // exact-operation/high-risk confirmation contract before approval. Only a
      // still-`pending` request is gated; other states fall through to the
      // registry's typed state-machine error below.
      if (summary.state === 'pending') {
        const effectiveProfile =
          parsed.edit.requestedProfile ?? summary.requestedProfile;
        // Derive the capability set approval would actually grant (stored bits,
        // overlaid with any body edit) — NOT just the bits re-sent on this call.
        // This makes the challenge name the real high-risk bits and binds the
        // confirmation token to the exact capability grant.
        const effectiveCapabilityBits =
          registry.pendingPairingEffectiveCapabilityBits(
            requestId,
            parsed.edit
          ) ?? [];
        const effectiveRoots =
          registry.pendingPairingEffectiveRoots(requestId, parsed.edit) ?? [];
        const requiresApproval =
          summary.requiresExactOperationApproval ||
          isHighRiskNodePairingRequest({
            profile: effectiveProfile,
            requestedCapabilities: effectiveCapabilityBits,
          });
        if (requiresApproval) {
          const effectiveTrustTier =
            nodePairingProfileTrustTier(effectiveProfile);
          const challengeBits = effectiveCapabilityBits.filter((bit) =>
            PAIRING_HIGH_RISK_BIT_SET.has(bit)
          );
          const decision: HubPolicyDecision = {
            decision: 'challenge',
            reasonCode: 'POLICY_CHALLENGE_REQUIRED',
            message: `approving this ${effectiveProfile} pairing request requires exact-operation confirmation`,
            nodeId: requestId,
            peer: { kind: 'hub' },
            intent: { action: 'nodes.pair.approve', target: requestId },
            scope: { kind: 'node', nodeId: requestId },
            trustTier: effectiveTrustTier,
            requiredBits: challengeBits,
            grantedBits: [],
            deniedBits: [],
            challengeBits,
            unknownBits: [],
          };
          const gate = resolveConfirmationForDecision({
            confirmations,
            auditSink: options.auditSink,
            req,
            decision,
            // Bind every dimension of the grant into the canonical params so the
            // approved token cannot be replayed against a divergent grant (e.g.
            // capabilities OR roots widened by a PATCH /access between mint and
            // redeem). Capabilities and roots are bound as hashes so raw bits /
            // paths never appear in the public challenge surface.
            params: {
              requestId,
              requestedProfile: effectiveProfile,
              requestedTrustTier: effectiveTrustTier,
              publicKeyFingerprint: summary.publicKeyFingerprint ?? null,
              capabilityBitsHash: pairingBindingHash(
                [...effectiveCapabilityBits].sort()
              ),
              rootsHash: pairingBindingHash([...effectiveRoots].sort()),
            },
            now: now(),
          });
          if (!gate.ok) {
            sendRelayError(res, gate.error);
            return;
          }
        }
      }
      try {
        const request = registry.approvePendingPairingRequest(requestId, {
          edit: parsed.edit,
        });
        res.json({ request });
      } catch (error) {
        sendRegistryError(registry, res, error);
      }
    }
  );

  router.post(
    '/hub/pairing/requests/:requestId/deny',
    requireAuth,
    (req, res) => {
      const { requestId } = req.params;
      if (!requestId) {
        sendRelayError(
          res,
          relayError('INVALID_REQUEST', 'requestId is required', false, {
            reasonCode: 'PENDING_PAIRING_REQUEST_ID_REQUIRED',
          })
        );
        return;
      }
      const reason = stringFromBody(bodyRecord(req), 'reason');
      try {
        const request = registry.denyPendingPairingRequest(requestId, {
          ...(reason ? { reason } : {}),
        });
        res.json({ request });
      } catch (error) {
        sendRegistryError(registry, res, error);
      }
    }
  );

  router.post('/hub/node-heartbeat', (req, res) => {
    const token = bearerToken(req);
    const source = sourceTupleFromRequest(req);
    // #981: HTTP heartbeat is a node-credential lane too. Key-bound credentials
    // must prove possession here (audience-bound to heartbeat) so a captured
    // bearer token cannot keep a key-bound node alive without its private key.
    const proofHeader = req.header(NODE_LINK_PROOF_HEADER);
    const authContext = {
      ...(source ? { source } : {}),
      ...(options.sourceDiagnostics?.strictDeny
        ? { strictSourceDeny: true }
        : {}),
      audience: 'relay:node-heartbeat:v1' as const,
      ...(typeof proofHeader === 'string' && proofHeader.length > 0
        ? { proof: proofHeader }
        : {}),
    };
    const authenticated = registry.authenticateNodeLinkWithProof(
      token ?? '',
      authContext
    );
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
          credentialId: authenticated.credentialId,
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

  router.get(
    '/nodes',
    cliGatewayAuthForActorCommand('nodes.list'),
    (_req, res) => {
      res.json({ nodes: registry.listNodes() });
    }
  );

  router.get('/hub/audit/entries', cliGatewayAuth, async (req, res) => {
    if (!options.auditSink?.listBefore || !options.auditSink.head) {
      res.status(503).json({ error: 'audit_sink_unavailable' });
      return;
    }
    const rawBefore = req.query['beforeSequence'];
    const beforeSequence =
      rawBefore === undefined || rawBefore === ''
        ? null
        : (() => {
            const n = Number.parseInt(String(rawBefore), 10);
            return Number.isFinite(n) && n >= 0 ? n : null;
          })();
    const limitRaw = Number.parseInt(String(req.query['limit'] ?? '50'), 10);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 50;
    try {
      const result = options.auditSink.listBefore(beforeSequence, limit);
      const entries = result.rows.map((row) => ({
        ...row,
        peer: redactPeerForBrowser(row.peer),
      }));
      const head = options.auditSink.head();
      res.json({
        entries,
        nextBeforeSequence: result.nextBeforeSequence,
        head,
      });
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('[hub-node-router] audit entries read failed', error);
      res.status(500).json({ error: 'audit_read_failed' });
    }
  });

  router.get('/hub/audit/verify', cliGatewayAuth, async (req, res) => {
    if (!options.auditSink?.verify) {
      res.status(503).json({ error: 'audit_sink_unavailable' });
      return;
    }
    try {
      const force = includeFlag(req.query['force']);
      const verified = cachedAuditVerify({
        auditSink: options.auditSink,
        nowMs: now().getTime(),
        force,
        cache: auditVerifyCache,
      });
      auditVerifyCache = verified.cache;
      res.json(verified.result);
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('[hub-node-router] audit verify failed', error);
      res.status(500).json({ error: 'audit_verify_failed' });
    }
  });

  router.get('/hub/nodes/:nodeId/logs', cliGatewayAuth, async (req, res) => {
    const { nodeId } = req.params;
    if (!nodeId) {
      sendRelayError(res, relayError('INVALID_REQUEST', 'nodeId is required'));
      return;
    }
    const lines = nodeLogLinesFromQuery(req.query['lines']);
    if (typeof lines !== 'number') {
      sendRelayError(res, lines);
      return;
    }
    const follow = includeFlag(req.query['follow']);
    const requestPayload = { lines, follow };
    const node = registry
      .listNodes()
      .find((candidate) => candidate.nodeId === nodeId);
    if (!node || node.status === 'revoked') {
      sendRelayError(res, relayError('NOT_FOUND', 'node is not paired'));
      return;
    }
    if (node.protocolVersion !== RELAY_NODE_LINK_PROTOCOL_VERSION) {
      sendRelayError(res, protocolVersionRelayError(node.protocolVersion));
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
    const policyDecision = evaluateHubPolicy({
      peer: { kind: 'hub' },
      node,
      nodeId,
      // #597: route through the dedicated `logs.tail` action so the
      // capability gate consults `logs:read` instead of piggybacking on
      // `rpc:fs:tail`. Operators can grant/revoke log visibility without
      // exposing arbitrary file-tail powers.
      intent: { action: 'logs.tail', target: nodeId },
      scope: { kind: 'node', nodeId, cwd: '/' },
      requiredCapabilities: requiredCapabilitiesForRpcIntent('logs.tail'),
      params: requestPayload,
      now: now(),
    });
    if (
      sendPolicyDecision(options.auditSink, res, policyDecision, requestPayload)
    ) {
      return;
    }
    if (!follow) {
      try {
        const payload = await options.nodeLinks.request(
          nodeId,
          'logs.tail',
          requestPayload
        );
        res.json({ log: payload });
      } catch (error) {
        sendRelayError(res, relayErrorFromUnknown(error));
      }
      return;
    }
    if (!options.nodeLinks.streamRequest) {
      sendRelayError(
        res,
        relayError(
          'NODE_UNSUPPORTED',
          'hub node log streaming is not supported by this runtime'
        )
      );
      return;
    }

    let closed = false;
    let stream: { payload: unknown; close(): void } | undefined;
    const close = (): void => {
      if (closed) return;
      closed = true;
      stream?.close();
    };
    req.on('close', close);
    try {
      res.status(200);
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.flushHeaders();
      stream = await options.nodeLinks.streamRequest(
        nodeId,
        'logs.tail',
        requestPayload,
        {
          onChunk: (payload) => {
            if (closed || res.destroyed) return;
            const chunk = nodeLogChunk(payload);
            if (chunk) res.write(chunk);
          },
          onError: (error) => {
            if (closed || res.destroyed) return;
            res.write(`\n[${error.code}] ${error.message}\n`);
            res.end();
          },
          onEnd: () => {
            if (closed || res.destroyed) return;
            res.end();
          },
        }
      );
      if (closed || res.destroyed) {
        stream.close();
        return;
      }
      const output = nodeLogOutput(stream.payload);
      if (output) res.write(output);
    } catch (error) {
      if (res.headersSent) {
        const streamError = relayErrorFromUnknown(error);
        if (!closed && !res.destroyed) {
          res.write(`\n[${streamError.code}] ${streamError.message}\n`);
          res.end();
        }
      } else {
        res.removeHeader('Content-Type');
        res.removeHeader('Cache-Control');
        sendRelayError(res, relayErrorFromUnknown(error));
      }
    }
  });

  router.post(
    '/hub/nodes/:nodeId/credential-rotation',
    requireAuth,
    async (req, res) => {
      const { nodeId } = req.params;
      if (!nodeId) {
        sendRelayError(
          res,
          relayError('INVALID_REQUEST', 'nodeId is required')
        );
        return;
      }
      const body = bodyRecord(req);
      const delivery = stringField(body, 'delivery') ?? 'online';
      if (delivery !== 'online' && delivery !== 'manual') {
        sendRelayError(
          res,
          relayError('INVALID_REQUEST', 'delivery must be "online" or "manual"')
        );
        return;
      }
      try {
        const started = registry.beginCredentialRotation(nodeId);
        auditCredentialRotation(options.auditSink, {
          nodeId,
          eventType: 'rotation',
          decision: 'recorded',
          reasonCode: 'CREDENTIAL_ROTATION_ISSUED',
          credentialId: started.rotation.previousCredentialId,
          rotationId: started.rotation.rotationId,
          params: { delivery },
        });
        if (delivery === 'online') {
          if (!options.nodeLinks?.hasActiveNode(nodeId)) {
            const failed = registry.failCredentialRotation(
              nodeId,
              started.rotation.rotationId,
              'node is not connected for online credential rotation'
            );
            auditCredentialRotation(options.auditSink, {
              nodeId,
              eventType: 'rotation',
              decision: 'failed',
              reasonCode: 'CREDENTIAL_ROTATION_NODE_OFFLINE',
              credentialId: started.rotation.previousCredentialId,
              rotationId: started.rotation.rotationId,
            });
            res.status(503).json({
              error: relayError('NODE_OFFLINE', 'node is not connected', true),
              node: failed.node,
              rotation: failed.rotation,
            });
            return;
          }
          try {
            await options.nodeLinks.request(nodeId, 'credential.rotate', {
              credential: started.credential,
            });
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error);
            const failed = registry.failCredentialRotation(
              nodeId,
              started.rotation.rotationId,
              message
            );
            auditCredentialRotation(options.auditSink, {
              nodeId,
              eventType: 'rotation',
              decision: 'failed',
              reasonCode: 'CREDENTIAL_ROTATION_DELIVERY_FAILED',
              credentialId: started.rotation.previousCredentialId,
              rotationId: started.rotation.rotationId,
              params: { message },
            });
            res.status(502).json({
              error: relayError(
                'NODE_UNSUPPORTED',
                'credential rotation delivery failed',
                true,
                {
                  reasonCode: 'CREDENTIAL_ROTATION_DELIVERY_FAILED',
                }
              ),
              node: failed.node,
              rotation: failed.rotation,
            });
            return;
          }
          const delivered = registry.markCredentialRotationDelivered(
            nodeId,
            started.rotation.rotationId
          );
          auditCredentialRotation(options.auditSink, {
            nodeId,
            eventType: 'rotation',
            decision: 'recorded',
            reasonCode: 'CREDENTIAL_ROTATION_DELIVERED',
            credentialId: started.rotation.previousCredentialId,
            rotationId: started.rotation.rotationId,
          });
          res.status(202).json({
            node: delivered.node,
            rotation: delivered.rotation,
          });
          return;
        }
        res.status(201).json(started);
      } catch (error) {
        sendRegistryError(registry, res, error);
      }
    }
  );

  router.post(
    '/hub/nodes/:nodeId/credential-rotation/clear-failure',
    requireAuth,
    (req, res) => {
      const { nodeId } = req.params;
      if (!nodeId) {
        sendRelayError(
          res,
          relayError('INVALID_REQUEST', 'nodeId is required')
        );
        return;
      }
      try {
        const node = registry.clearCredentialRotationFailure(nodeId);
        auditCredentialRotation(options.auditSink, {
          nodeId,
          eventType: 'rotation',
          decision: 'recorded',
          reasonCode: 'CREDENTIAL_ROTATION_FAILURE_CLEARED',
        });
        res.json({ node });
      } catch (error) {
        sendRegistryError(registry, res, error);
      }
    }
  );

  // ── Node update state (Slice 5, #655) ────────────────────────────────────
  // Marks a node as `updating` so the hub blocks new session-create requests.
  // Called by `relay-ide node update` at the start of a node binary update.
  router.post('/hub/nodes/:nodeId/updating', requireAuth, (req, res) => {
    const { nodeId } = req.params;
    if (!nodeId) {
      sendRelayError(res, relayError('INVALID_REQUEST', 'nodeId is required'));
      return;
    }
    try {
      const node = registry.markNodeUpdating(nodeId);
      res.json({ node });
    } catch (error) {
      sendRegistryError(registry, res, error);
    }
  });

  // Clears the `updating` flag after a node update completes.
  // Called by `relay-ide node update` on success.
  router.delete('/hub/nodes/:nodeId/updating', requireAuth, (req, res) => {
    const { nodeId } = req.params;
    if (!nodeId) {
      sendRelayError(res, relayError('INVALID_REQUEST', 'nodeId is required'));
      return;
    }
    try {
      const node = registry.markNodeUpdateComplete(nodeId);
      res.json({ node });
    } catch (error) {
      sendRegistryError(registry, res, error);
    }
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

  router.post(
    '/hub/scoped-sessions/:sessionId/renew',
    scopedSessionAuth,
    (req, res) => {
      const { sessionId } = req.params;
      if (!sessionId) {
        sendRelayError(
          res,
          relayError('INVALID_REQUEST', 'sessionId is required')
        );
        return;
      }
      const body = bodyRecord(req);
      const queryNodeId =
        typeof req.query['nodeId'] === 'string'
          ? req.query['nodeId']
          : undefined;
      const nodeId = stringField(body, 'nodeId') ?? queryNodeId;
      const renewalNow = now();

      const authorityError = renewAuthorityError(body);
      if (authorityError) {
        auditRenewalImmediateDenial(options.auditSink, {
          error: authorityError,
          ...(nodeId ? { nodeId } : {}),
          sessionId,
          params: body,
        });
        sendRelayError(res, authorityError);
        return;
      }

      const expiresAt = renewExpiresAtFromBody(body, renewalNow);
      if (typeof expiresAt !== 'string') {
        auditRenewalImmediateDenial(options.auditSink, {
          error: expiresAt,
          ...(nodeId ? { nodeId } : {}),
          sessionId,
          params: body,
        });
        sendRelayError(res, expiresAt);
        return;
      }

      if (nodeId !== DEFAULT_LOCAL_NODE_ID) {
        const lifecycle = envelopes.validate({
          sessionId,
          ...(nodeId ? { nodeId } : {}),
          now: renewalNow,
        });
        if (lifecycle.ok === false) {
          const denial = lifecycle as Exclude<
            ReturnType<InMemorySessionEnvelopeRegistry['validate']>,
            { ok: true }
          >;
          auditLifecycleDenial(
            options.auditSink,
            denial,
            nodeId ?? denial.summary?.nodeId ?? 'unknown',
            sessionId,
            'sessions.renew',
            body
          );
          sendRelayError(res, denial.error);
          return;
        }

        const policyNode = registry
          .listNodes()
          .find((candidate) => candidate.nodeId === lifecycle.summary.nodeId);
        const policyDecision = evaluateHubPolicy({
          peer: { kind: 'hub' },
          node: policyNode ?? null,
          nodeId: lifecycle.summary.nodeId,
          intent: {
            action: 'sessions.renew',
            target: lifecycle.summary.nodeId,
          },
          scope: sessionRenewPolicyScope(lifecycle.summary),
          requiredCapabilities:
            requiredCapabilitiesForRpcIntent('sessions.renew'),
          expiresAt: lifecycle.summary.expiresAt,
          revokedAt: lifecycle.summary.revokedAt,
          sessionId: lifecycle.summary.sessionId,
          ...(lifecycle.summary.correlationId
            ? { correlationId: lifecycle.summary.correlationId }
            : {}),
          params: body,
          now: renewalNow,
        });
        if (
          sendPolicyDecision(options.auditSink, res, policyDecision, body, {
            confirmations,
            req,
            canonicalParams: body,
            now: renewalNow,
          })
        )
          return;
      }

      const renewed =
        nodeId === DEFAULT_LOCAL_NODE_ID && options.renewLocalSession
          ? options.renewLocalSession({
              id: sessionId,
              expiresAt,
              now: renewalNow,
            })
          : envelopes.renew({
              sessionId,
              ...(nodeId ? { nodeId } : {}),
              expiresAt,
              now: renewalNow,
            });
      if (renewed.ok === false) {
        const denial = renewed as Exclude<
          ReturnType<InMemorySessionEnvelopeRegistry['renew']>,
          { ok: true }
        >;
        auditLifecycleDenial(
          options.auditSink,
          denial,
          nodeId ?? denial.summary?.nodeId ?? 'unknown',
          sessionId,
          'sessions.renew',
          body
        );
        sendRelayError(res, denial.error);
        return;
      }

      auditLifecycleRenewal(options.auditSink, {
        previousSummary: renewed.previousSummary,
        summary: renewed.summary,
        params: body,
      });
      res.json({ session: renewed.summary });
    }
  );

  router.post(
    '/hub/scoped-sessions/:sessionId/revoke',
    scopedSessionAuth,
    (req, res) => {
      const { sessionId } = req.params;
      if (!sessionId) {
        sendRelayError(
          res,
          relayError('INVALID_REQUEST', 'sessionId is required')
        );
        return;
      }
      const body = bodyRecord(req);
      const queryNodeId =
        typeof req.query['nodeId'] === 'string'
          ? req.query['nodeId']
          : undefined;
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
        sendRelayError(
          res,
          relayError('NOT_FOUND', 'scoped session envelope was not found')
        );
        return;
      }
      auditLifecycleRevocation(options.auditSink, summary, body);
      options.releaseRoutedPtyControlSession?.(
        summary.nodeId,
        summary.sessionId
      );
      res.json({ session: summary });
    }
  );

  router.delete(
    '/hub/scoped-sessions/:sessionId',
    scopedSessionAuth,
    (req, res) => {
      const { sessionId } = req.params;
      if (!sessionId) {
        sendRelayError(
          res,
          relayError('INVALID_REQUEST', 'sessionId is required')
        );
        return;
      }
      const nodeId =
        typeof req.query['nodeId'] === 'string'
          ? req.query['nodeId']
          : undefined;
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
        sendRelayError(
          res,
          relayError('NOT_FOUND', 'scoped session envelope was not found')
        );
        return;
      }
      auditLifecycleRevocation(options.auditSink, summary, {
        method: 'DELETE',
      });
      options.releaseRoutedPtyControlSession?.(
        summary.nodeId,
        summary.sessionId
      );
      res.json({ session: summary });
    }
  );

  router.post(
    '/hub/nodes/:nodeId/cwd/:operation',
    requireAuth,
    async (req, res) => {
      const { nodeId, operation } = req.params;
      if (!nodeId) {
        sendRelayError(
          res,
          relayError('INVALID_REQUEST', 'nodeId is required')
        );
        return;
      }
      if (operation !== 'browse' && operation !== 'validate') {
        sendRelayError(
          res,
          relayError(
            'INVALID_REQUEST',
            'cwd operation must be browse or validate'
          )
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
        sendRelayError(res, protocolVersionRelayError(node.protocolVersion));
        return;
      }
      const terminalUnsupported = nodeTerminalUnsupportedError(nodeId, node);
      if (terminalUnsupported) {
        sendRelayError(res, terminalUnsupported);
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
      const normalized = nodeCwdOnboardingPayload({ node, body, operation });
      if ('code' in normalized) {
        sendRelayError(res, normalized);
        return;
      }
      const action = operation === 'browse' ? 'rpc.fs.list' : 'rpc.fs.stat';
      const nowForPolicy = now();
      const policyDecision = evaluateHubPolicy({
        peer: { kind: 'hub' },
        node,
        nodeId,
        intent: { action, target: nodeId },
        scope: {
          kind: 'node-cwd',
          nodeId,
          cwd: normalized.cwd,
          path: normalized.path,
        },
        requiredCapabilities: requiredCapabilitiesForRpcIntent(action),
        params: normalized.request,
        now: nowForPolicy,
      });
      if (
        sendPolicyDecision(
          options.auditSink,
          res,
          policyDecision,
          normalized.request,
          {
            confirmations,
            req,
            canonicalParams: normalized.request,
            now: nowForPolicy,
          }
        )
      )
        return;

      try {
        const rpcType = operation === 'browse' ? 'fs.list' : 'fs.stat';
        const payload = await options.nodeLinks.request(
          nodeId,
          rpcType,
          normalized.request
        );
        const responsePayload = isRecord(payload) ? payload : { payload };
        res.json({ nodeId, cwd: normalized.cwd, ...responsePayload });
      } catch (error) {
        if (error instanceof HubNodeLinkError) {
          sendRelayError(res, error.relayNodeError);
          return;
        }
        sendRegistryError(registry, res, error);
      }
    }
  );

  router.post(
    '/hub/nodes/:nodeId/sessions',
    cliGatewayAuth,
    async (req, res) => {
      const { nodeId } = req.params;
      if (!nodeId) {
        sendRelayError(
          res,
          relayError('INVALID_REQUEST', 'nodeId is required')
        );
        return;
      }
      const routedBody = routedGatewayCreateBodyFromRequest(req, res, nodeId);
      if (!routedBody) return;
      const workContextId = routedWorkContextId(routedBody);
      const workContextError = validateRoutedWorkContext(
        options.workContextStore,
        workContextId
      );
      if (workContextError) {
        sendRelayError(res, workContextError);
        return;
      }
      const node = registry
        .listNodes()
        .find((candidate) => candidate.nodeId === nodeId);
      if (!node || node.status === 'revoked') {
        sendRelayError(res, relayError('NOT_FOUND', 'node is not paired'));
        return;
      }
      // 503/400: node updating, helper major-version skew, or protocol mismatch blocks new sessions.
      if (sendNodeUnavailableForCreate(res, node, nodeId)) return;
      const terminalUnsupported = nodeTerminalUnsupportedError(nodeId, node);
      if (terminalUnsupported) {
        sendRelayError(res, terminalUnsupported);
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

      const lifecycleError = lifecycleInputError(routedBody);
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
      const expiresAt = expiresAtFromLifecycleInput(routedBody, createNow);
      if (
        expiresAt !== undefined &&
        expiresAt !== null &&
        Date.parse(expiresAt) <= createNow.getTime()
      ) {
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
          material: { params: routedBody },
        });
        sendRelayError(res, error);
        return;
      }
      const requestedEnvelope = isSessionEnvelope(routedBody['sessionEnvelope'])
        ? routedBody['sessionEnvelope']
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
          ...(requestedEnvelope.correlationId
            ? { correlationId: requestedEnvelope.correlationId }
            : {}),
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
      const rawSessionType = routedBody['type'];
      if (rawSessionType !== undefined && rawSessionType !== 'terminal') {
        sendRelayError(
          res,
          relayError('INVALID_REQUEST', 'type must be terminal', false, {
            reasonCode: 'INVALID_SESSION_TYPE',
            field: 'type',
          })
        );
        return;
      }
      const sessionType = 'terminal';
      const policyDecision = evaluateHubPolicy({
        peer: { kind: 'hub' },
        node,
        nodeId,
        intent: { action: 'sessions.create', target: nodeId },
        scope: sessionCreatePolicyScope(nodeId, routedBody),
        requiredCapabilities: sessionCreateCapabilities({
          sessionType,
          controlMode: routedBody['controlMode'],
        }),
        ...(expiresAt !== undefined ? { expiresAt } : {}),
        params: routedBody,
        now: createNow,
      });
      if (
        sendPolicyDecision(options.auditSink, res, policyDecision, routedBody, {
          confirmations,
          req,
          canonicalParams: routedBody,
          now: createNow,
        })
      )
        return;

      try {
        const payload = await options.nodeLinks.request(
          nodeId,
          'sessions.create',
          routedBody
        );
        const session = scopedNodeSession(nodeId, sessionFromPayload(payload), {
          ...(expiresAt !== undefined ? { expiresAt } : {}),
        });
        envelopes.upsert(session.sessionEnvelope!);
        const associationError = associateRoutedWorkContext(
          options.workContextStore,
          workContextId,
          session
        );
        const responseSession = withTrustedWorkContextId(
          options.workContextStore,
          session,
          workContextId
        );
        options.readModelCache?.upsert(nodeId, session, createNow.getTime());
        res.status(201).json(
          associationError
            ? {
                ...responseSession,
                workContextAssociationError: associationError,
              }
            : responseSession
        );
      } catch (error) {
        if (error instanceof HubNodeLinkError) {
          sendRelayError(res, error.relayNodeError);
          return;
        }
        sendRegistryError(registry, res, error);
      }
    }
  );

  router.post(
    '/hub/nodes/:nodeId/sessions/:sessionId/files/:operation',
    requireAuth,
    async (req, res) => {
      const { nodeId, sessionId, operation } = req.params;
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
      if (!isFileRpcOperation(operation)) {
        sendRelayError(
          res,
          relayError(
            'INVALID_REQUEST',
            'file RPC operation must be list, stat, read, tail, or write',
            false,
            {
              reasonCode: 'FILE_RPC_INVALID_REQUEST',
              operation,
            }
          )
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
      const routedBody = paramsWithoutConfirmation(body);
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
          routedBody
        );
        sendRelayError(res, denial.error);
        return;
      }

      const normalized = normalizeHubFileRpcRequest({
        operation,
        nodePlatform: node.platform,
        nodeId,
        session: lifecycle.summary,
        body: routedBody,
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
        params: { ...routedBody, path: normalized.value.request.path },
        now: now(),
      });
      const canonicalFileParams = {
        ...routedBody,
        path: normalized.value.request.path,
      };
      if (
        sendPolicyDecision(
          options.auditSink,
          res,
          policyDecision,
          canonicalFileParams,
          {
            confirmations,
            req,
            canonicalParams: canonicalFileParams,
            now: now(),
          }
        )
      ) {
        return;
      }

      const follow =
        operation === 'tail' &&
        'follow' in normalized.value.request &&
        normalized.value.request.follow === true;
      if (follow) {
        await streamFileTailFollow({
          req,
          res,
          nodeLinks: options.nodeLinks,
          nodeId,
          request: normalized.value.request,
        });
        return;
      }

      try {
        const payload = await options.nodeLinks.request(
          nodeId,
          `fs.${operation}`,
          normalized.value.request
        );
        // Post-write completion audit: record the node response for forensic completeness.
        if (operation === 'write') {
          appendFsWriteCompletionAudit(options.auditSink, {
            success: true,
            peer: auditPeerForSummary(lifecycle.summary),
            nodeId,
            sessionId,
            policyScope: normalized.value.policyScope,
            payload,
            ...(lifecycle.summary.correlationId
              ? { correlationId: lifecycle.summary.correlationId }
              : {}),
          });
        }
        res.json(payload);
      } catch (error) {
        if (error instanceof HubNodeLinkError) {
          if (operation === 'write') {
            appendFsWriteCompletionAudit(options.auditSink, {
              success: false,
              peer: auditPeerForSummary(lifecycle.summary),
              nodeId,
              sessionId,
              policyScope: normalized.value.policyScope,
              errorCode: String(
                error.relayNodeError.details?.['reasonCode'] ??
                  error.relayNodeError.code
              ),
              ...(lifecycle.summary.correlationId
                ? { correlationId: lifecycle.summary.correlationId }
                : {}),
            });
          }
          sendRelayError(res, error.relayNodeError);
          return;
        }
        sendRegistryError(registry, res, error);
      }
    }
  );

  router.patch(
    '/hub/nodes/:nodeId/sessions/:sessionId',
    requireAuth,
    async (req, res) => {
      const { nodeId, sessionId } = req.params;
      const displayName = bodyRecord(req)['displayName'];
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
      if (typeof displayName !== 'string' || displayName.trim().length === 0) {
        sendRelayError(
          res,
          relayError('INVALID_REQUEST', 'displayName is required')
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
          'sessions.rename',
          { method: 'PATCH' }
        );
        sendRelayError(res, denial.error);
        return;
      }
      const scoped = lifecycle.summary;
      const renameNow = now();
      const renameParams = { method: 'PATCH', displayName };
      const renamePolicyDecision = evaluateHubPolicy({
        peer: { kind: 'hub' },
        node,
        nodeId,
        intent: { action: 'sessions.rename', target: nodeId },
        scope: scoped
          ? {
              kind: scoped.scope.kind,
              nodeId,
              cwd: scoped.scope.cwd,
              ...(scoped.scope.repoPath
                ? { repoPath: scoped.scope.repoPath }
                : {}),
              ...(scoped.scope.worktreePath !== undefined
                ? { worktreePath: scoped.scope.worktreePath }
                : {}),
            }
          : { kind: 'node', nodeId, cwd: '/' },
        requiredCapabilities: ['session:control:rename'],
        sessionId,
        ...(scoped?.correlationId
          ? { correlationId: scoped.correlationId }
          : {}),
        ...(scoped?.expiresAt !== undefined
          ? { expiresAt: scoped.expiresAt }
          : {}),
        ...(scoped?.revokedAt ? { revokedAt: scoped.revokedAt } : {}),
        params: renameParams,
        now: renameNow,
      });
      if (
        sendPolicyDecision(
          options.auditSink,
          res,
          renamePolicyDecision,
          renameParams,
          {
            confirmations,
            req,
            canonicalParams: renameParams,
            now: renameNow,
          }
        )
      )
        return;

      try {
        const payload = await options.nodeLinks.request(
          nodeId,
          'sessions.rename',
          {
            id: sessionId,
            displayName,
          }
        );
        res.json({
          ...(typeof payload === 'object' && payload !== null
            ? (payload as Record<string, unknown>)
            : {}),
          id: sessionId,
          sessionId,
          nodeId,
          displayName,
        });
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
      const killNow = now();
      const killParams = { method: 'DELETE' };
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
              ...(scoped.scope.repoPath
                ? { repoPath: scoped.scope.repoPath }
                : {}),
              ...(scoped.scope.worktreePath !== undefined
                ? { worktreePath: scoped.scope.worktreePath }
                : {}),
            }
          : { kind: 'node', nodeId, cwd: '/' },
        requiredCapabilities: ['session:control:kill'],
        sessionId,
        ...(scoped?.correlationId
          ? { correlationId: scoped.correlationId }
          : {}),
        ...(scoped?.expiresAt !== undefined
          ? { expiresAt: scoped.expiresAt }
          : {}),
        ...(scoped?.revokedAt ? { revokedAt: scoped.revokedAt } : {}),
        params: killParams,
        now: killNow,
      });
      if (
        sendPolicyDecision(
          options.auditSink,
          res,
          killPolicyDecision,
          killParams,
          {
            confirmations,
            req,
            canonicalParams: killParams,
            now: killNow,
          }
        )
      )
        return;

      try {
        const payload = await options.nodeLinks.request(
          nodeId,
          'sessions.kill',
          {
            id: sessionId,
          }
        );
        envelopes.delete(sessionId, nodeId);
        options.releaseRoutedPtyControlSession?.(nodeId, sessionId);
        res.json({
          ...(typeof payload === 'object' && payload !== null
            ? (payload as Record<string, unknown>)
            : {}),
          ok: true,
          id: sessionId,
          sessionId,
          nodeId,
        });
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
      auditCredentialRotation(options.auditSink, {
        nodeId,
        eventType: 'revocation',
        decision: 'revoked',
        reasonCode: 'NODE_CREDENTIAL_REVOKED',
        credentialId: node.credentialId,
        params: { method: 'DELETE' },
      });
      const revokedSessions = revokePolicyAffectedSessions({
        envelopes,
        nodeId,
        node,
        reason: 'node-revoked',
        now: now(),
        auditSink: options.auditSink,
      });
      options.releaseRoutedPtyControlSessionsForNode?.(nodeId);
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
