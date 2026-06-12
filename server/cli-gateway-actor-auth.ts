import type { Request, Response } from 'express';
import {
  HandshakeGrantRegistry,
  type HandshakeGrantActor,
  type HandshakeGrantScope,
  type HandshakeGrantSessionBinding,
  type HandshakeGrantValidationFailureReason,
  type HandshakeGrantValidationScope,
} from '../shared/operator-handshake-grants.js';
import {
  ScopedActorCredentialRegistry,
  type ScopedActorCredentialRecord,
  type ScopedActorCredentialScope,
  type ScopedActorCredentialValidationFailureReason,
  type ScopedActorCredentialValidationResult,
} from '../shared/scoped-actor-credentials.js';
import {
  isRelayCapabilityBit,
  type RelayCapabilityBit,
} from '../shared/security-policy.js';

export const CLI_GATEWAY_ACTOR_AUDIENCE = 'relay:cli-gateway:v1' as const;
export const CLI_GATEWAY_READ_SCOPE_TASK_REF = 'relay:cli-gateway:v1:read' as const;
export const CLI_GATEWAY_ACTOR_TOKEN_HEADER = 'x-relay-cli-actor-token' as const;
export const CLI_GATEWAY_COMMAND_HEADER = 'x-relay-cli-command' as const;
export const CLI_GATEWAY_CORRELATION_ID_HEADER = 'x-relay-correlation-id' as const;
export const CLI_GATEWAY_ACTOR_GRANT_CAPABILITIES = [
  'session:read',
  'context:write',
  'inbox:write',
  'artifact:write',
] as const;
export const CLI_GATEWAY_ACTOR_READ_COMMANDS = [
  'nodes.list',
  'sessions.list',
  'sessions.get',
  'sessions.screen',
  'work-contexts.get',
  'work-contexts.resume',
  'work-context-artifacts.list',
  'work-context-artifacts.show',
  'work-context-artifacts.export',
  'work-context-artifacts.doctor',
  'handoff-artifacts.list',
  'handoff-artifacts.show',
  'handoff-artifacts.copy',
] as const;
export type CliGatewayActorReadCommand =
  (typeof CLI_GATEWAY_ACTOR_READ_COMMANDS)[number];

export const CLI_GATEWAY_ACTOR_WRITE_COMMANDS = [
  'context.create',
  'context.pin',
  'context.unpin',
  'inbox.send',
  'inbox.ack',
  'inbox.resolve',
  'inbox.ignore',
  'work-context-artifacts.publish',
  'work-context-artifacts.pin',
  'work-context-artifacts.unpin',
  'handoff-artifacts.attach',
] as const;
export type CliGatewayActorWriteCommand =
  (typeof CLI_GATEWAY_ACTOR_WRITE_COMMANDS)[number];
export type CliGatewayActorCommand =
  | CliGatewayActorReadCommand
  | CliGatewayActorWriteCommand;

const cliGatewayActorReadCommandSet = new Set<string>(CLI_GATEWAY_ACTOR_READ_COMMANDS);
const cliGatewayActorWriteCommandSet = new Set<string>(CLI_GATEWAY_ACTOR_WRITE_COMMANDS);
const cliGatewayActorGrantCapabilitySet = new Set<string>(CLI_GATEWAY_ACTOR_GRANT_CAPABILITIES);

export interface CliGatewayActorIssueInput {
  actor?: { type?: unknown; id?: unknown; displayName?: unknown };
  issuer?: { id?: unknown; displayName?: unknown };
  capabilities?: unknown;
  scope?: unknown;
  ttlMs?: unknown;
  expiresAt?: unknown;
  metadata?: unknown;
  correlationId?: unknown;
}

export interface CliGatewayGrantActorLifecycleInput extends CliGatewayActorIssueInput {
  grantHandle?: unknown;
  audience?: unknown;
  grantActor?: { type?: unknown; id?: unknown; displayName?: unknown };
  deviceId?: unknown;
  sessionBinding?: unknown;
}

export type CliGatewayActorGrantFailureReason =
  | HandshakeGrantValidationFailureReason
  | 'grant_handle_required'
  | 'actor_required'
  | 'issuer_required'
  | 'ttl_required'
  | 'audience_required'
  | 'audience_expansion'
  | 'capability_required'
  | 'capability_expansion'
  | 'scope_required'
  | 'credential_not_found';

export class CliGatewayActorGrantError extends Error {
  constructor(
    public readonly reason: CliGatewayActorGrantFailureReason,
    message: string,
    public readonly grantId?: string
  ) {
    super(`${reason.toUpperCase()}: ${message}`);
    this.name = 'CliGatewayActorGrantError';
  }
}

export interface CliGatewayActorValidationInput {
  token: string;
  capabilities: readonly RelayCapabilityBit[];
  scope?: ScopedActorCredentialScope;
  deferWorkContextScope?: boolean;
  correlationId?: string;
}

export interface CliGatewayActorFailureEnvelope {
  error: {
    code: 'UNAUTHORIZED' | 'FORBIDDEN';
    reasonCode: string;
    message: string;
    retryable: false;
    lane: 'denied';
    acceptedLanes: ['scoped-actor-credential'];
    audience: typeof CLI_GATEWAY_ACTOR_AUDIENCE;
    credentialId?: string;
    deniedBits?: string[];
    correlationId?: string;
  };
}

const AUTHENTICATED_CLI_GATEWAY_ACTOR_CREDENTIAL = Symbol(
  'relay.cliGatewayActorCredential'
);

type RequestWithAuthenticatedCliGatewayActor = Request & {
  [AUTHENTICATED_CLI_GATEWAY_ACTOR_CREDENTIAL]?: ScopedActorCredentialRecord;
};

export function createCliGatewayActorRegistry(): ScopedActorCredentialRegistry {
  return new ScopedActorCredentialRegistry();
}

export function createCliGatewayHandshakeGrantRegistry(): HandshakeGrantRegistry {
  return new HandshakeGrantRegistry();
}

export function attachAuthenticatedCliGatewayActorCredential(
  req: Request,
  credential: ScopedActorCredentialRecord
): void {
  (req as RequestWithAuthenticatedCliGatewayActor)[AUTHENTICATED_CLI_GATEWAY_ACTOR_CREDENTIAL] = credential;
}

export function authenticatedCliGatewayActorCredential(
  req: Request
): ScopedActorCredentialRecord | undefined {
  return (req as RequestWithAuthenticatedCliGatewayActor)[AUTHENTICATED_CLI_GATEWAY_ACTOR_CREDENTIAL];
}

export function bearerActorToken(req: Request): string {
  const authHeader = req.header('authorization') ?? '';
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() ?? '';
}

export function cliGatewayCorrelationId(req: Request): string | undefined {
  return req.header(CLI_GATEWAY_CORRELATION_ID_HEADER) ?? undefined;
}

export function isCliGatewayActorTokenRequest(req: Request): boolean {
  return (
    req.header(CLI_GATEWAY_ACTOR_TOKEN_HEADER) === 'v1' ||
    bearerActorToken(req).startsWith('relay-sac-v1.')
  );
}

export function classifyCliGatewayCredentialLane(
  req: Request,
  expectedCommand?: CliGatewayActorCommand
):
  | 'missing'
  | 'scoped-actor-credential'
  | 'browser-cookie-lane'
  | 'node-credential-lane'
  | 'unsupported-route'
  | 'unsupported-type' {
  const token = bearerActorToken(req);
  if (!token) {
    if (req.header('cookie')) return 'browser-cookie-lane';
    return 'missing';
  }
  if (token.startsWith('relay-sac-v1.')) {
    return isSupportedCliGatewayActorRequest(req, expectedCommand)
      ? 'scoped-actor-credential'
      : 'unsupported-route';
  }
  if (req.header('x-relay-node-id') || req.header('x-relay-node-credential')) {
    return 'node-credential-lane';
  }
  return 'unsupported-type';
}

export function isSupportedCliGatewayActorReadRequest(
  req: Request,
  expectedCommand?: CliGatewayActorReadCommand
): boolean {
  if (req.method !== 'GET') return false;
  if (!expectedCommand || !cliGatewayActorReadCommandSet.has(expectedCommand)) {
    return false;
  }
  const command = req.header(CLI_GATEWAY_COMMAND_HEADER);
  return command == null || command === expectedCommand;
}

export function isSupportedCliGatewayActorWriteRequest(
  req: Request,
  expectedCommand?: CliGatewayActorWriteCommand
): boolean {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
    return false;
  }
  if (!expectedCommand || !cliGatewayActorWriteCommandSet.has(expectedCommand)) {
    return false;
  }
  return req.header(CLI_GATEWAY_COMMAND_HEADER) === expectedCommand;
}

export function isSupportedCliGatewayActorRequest(
  req: Request,
  expectedCommand?: CliGatewayActorCommand
): boolean {
  if (!expectedCommand) return false;
  if (cliGatewayActorReadCommandSet.has(expectedCommand)) {
    return isSupportedCliGatewayActorReadRequest(
      req,
      expectedCommand as CliGatewayActorReadCommand
    );
  }
  if (cliGatewayActorWriteCommandSet.has(expectedCommand)) {
    return isSupportedCliGatewayActorWriteRequest(
      req,
      expectedCommand as CliGatewayActorWriteCommand
    );
  }
  return false;
}

export function cliGatewayActorCommandCapabilities(
  command: CliGatewayActorCommand
): readonly RelayCapabilityBit[] {
  if (cliGatewayActorReadCommandSet.has(command)) return ['session:read'];
  if (command.startsWith('context.')) return ['context:write'];
  if (command.startsWith('inbox.')) return ['inbox:write'];
  return ['artifact:write'];
}

export function defaultCliGatewayActorScope(
  overrides?: ScopedActorCredentialScope,
  capabilities: readonly RelayCapabilityBit[] = ['session:read']
): ScopedActorCredentialScope {
  if (!capabilities.includes('session:read')) {
    return overrides ?? {};
  }
  const taskRefs = uniqueStrings([
    CLI_GATEWAY_READ_SCOPE_TASK_REF,
    ...(overrides?.taskRefs ?? []),
  ]);
  return {
    ...(overrides ?? {}),
    taskRefs,
  };
}

export function validateCliGatewayActorCredential(
  registry: ScopedActorCredentialRegistry,
  input: CliGatewayActorValidationInput
): ScopedActorCredentialValidationResult {
  const validationScope = scopeForValidation(
    input.scope,
    input.deferWorkContextScope ? { deferWorkContextScope: true } : {}
  );
  return registry.validate(input.token, {
    audience: CLI_GATEWAY_ACTOR_AUDIENCE,
    requiredCapabilities: [...input.capabilities],
    scope: input.capabilities.includes('session:read')
      ? { taskRef: CLI_GATEWAY_READ_SCOPE_TASK_REF, ...validationScope }
      : validationScope,
    ...(input.correlationId ? { correlationId: input.correlationId } : {}),
  });
}

export function sendCliGatewayActorFailure(
  res: Response,
  failure: CliGatewayActorFailureEnvelope['error']
): void {
  res.status(failure.code === 'FORBIDDEN' ? 403 : 401).json({ error: failure });
}

export function cliGatewayActorFailure(input: {
  lane?: ReturnType<typeof classifyCliGatewayCredentialLane>;
  reason?: ScopedActorCredentialValidationFailureReason;
  credentialId?: string;
  deniedBits?: string[];
  correlationId?: string;
}): CliGatewayActorFailureEnvelope['error'] {
  const reason = input.reason;
  const lane = input.lane;
  const reasonCode = reason
    ? cliGatewayActorReasonCode(reason)
    : lane === 'missing'
      ? 'CLI_ACTOR_CREDENTIAL_MISSING'
      : lane === 'browser-cookie-lane'
        ? 'CLI_ACTOR_BROWSER_COOKIE_REJECTED'
        : lane === 'node-credential-lane'
          ? 'CLI_ACTOR_NODE_CREDENTIAL_REJECTED'
          : lane === 'unsupported-route'
            ? 'CLI_ACTOR_ROUTE_UNSUPPORTED'
            : 'CLI_ACTOR_CREDENTIAL_UNSUPPORTED_TYPE';
  return {
    code: reason && forbiddenActorReasons.has(reason) ? 'FORBIDDEN' : 'UNAUTHORIZED',
    reasonCode,
    message: cliGatewayActorMessage(reasonCode),
    retryable: false,
    lane: 'denied',
    acceptedLanes: ['scoped-actor-credential'],
    audience: CLI_GATEWAY_ACTOR_AUDIENCE,
    ...(input.credentialId ? { credentialId: input.credentialId } : {}),
    ...(input.deniedBits?.length ? { deniedBits: [...input.deniedBits] } : {}),
    ...(input.correlationId ? { correlationId: input.correlationId } : {}),
  };
}

export function issueCliGatewayActorCredential(
  registry: ScopedActorCredentialRegistry,
  input: CliGatewayActorIssueInput = {}
): { token: string; credential: ScopedActorCredentialRecord } {
  const scope = coerceScope(input.scope);
  const capabilities = coerceCapabilities(input.capabilities);
  const ttlMs = typeof input.ttlMs === 'number' ? input.ttlMs : 5 * 60 * 1000;
  return registry.issue({
    actor: coerceActor(input.actor),
    issuer: coerceIssuer(input.issuer),
    audience: CLI_GATEWAY_ACTOR_AUDIENCE,
    capabilities,
    scope: defaultCliGatewayActorScope(scope, capabilities),
    ttlMs,
    ...(typeof input.expiresAt === 'string' ? { expiresAt: input.expiresAt } : {}),
    ...(isRecord(input.metadata) ? { metadata: input.metadata } : {}),
    ...(typeof input.correlationId === 'string'
      ? { correlationId: input.correlationId }
      : {}),
  });
}

export function issueCliGatewayActorCredentialWithGrant(
  registry: ScopedActorCredentialRegistry,
  grantRegistry: HandshakeGrantRegistry,
  input: CliGatewayGrantActorLifecycleInput
): { token: string; credential: ScopedActorCredentialRecord } {
  const request = strictGrantLifecycleRequest(input);
  const grant = validateCliGatewayLifecycleGrant(grantRegistry, request, true);
  const issued = registry.issue({
    actor: request.actor,
    issuer: {
      id: grant.id,
      ...(grant.issuer.displayName ? { displayName: grant.issuer.displayName } : {}),
    },
    grantId: grant.id,
    audience: request.audience,
    capabilities: request.capabilities,
    scope: request.scope,
    ...(request.ttlMs != null ? { ttlMs: request.ttlMs } : {}),
    ...(request.expiresAt ? { expiresAt: request.expiresAt } : {}),
    ...(isRecord(input.metadata) ? { metadata: input.metadata } : {}),
    correlationId: request.correlationId,
  });
  return issued;
}

export function listCliGatewayActorCredentialsWithGrant(
  registry: ScopedActorCredentialRegistry,
  grantRegistry: HandshakeGrantRegistry,
  input: CliGatewayGrantActorLifecycleInput
): { credentials: ScopedActorCredentialRecord[] } {
  const request = strictGrantLifecycleRequest(input, { ttlRequired: false });
  validateCliGatewayLifecycleGrant(grantRegistry, request, true);
  return {
    credentials: registry
      .listCredentials()
      .filter((credential) => credentialMatchesGrantLifecycleRequest(credential, request)),
  };
}

export function revokeCliGatewayActorCredentialWithGrant(
  registry: ScopedActorCredentialRegistry,
  grantRegistry: HandshakeGrantRegistry,
  credentialId: string,
  input: CliGatewayGrantActorLifecycleInput
): ScopedActorCredentialRecord {
  const existing = registry.getCredential(credentialId);
  if (!existing) {
    throw new CliGatewayActorGrantError(
      'credential_not_found',
      'scoped actor credential not found'
    );
  }
  const request = strictGrantLifecycleRequest(input, {
    ttlRequired: false,
    capabilities: existing.capabilities,
    scope: existing.scope,
    actor: existing.actor,
  });
  const grant = validateCliGatewayLifecycleGrant(grantRegistry, request, true);
  const credential = registry.revoke(credentialId, {
    revokedBy: `grant:${grant.id}`,
    ...(typeof input.metadata === 'object' && input.metadata && 'reason' in input.metadata
      ? { reason: String((input.metadata as { reason?: unknown }).reason ?? '') }
      : {}),
    correlationId: request.correlationId,
  });
  if (!credential) {
    throw new CliGatewayActorGrantError(
      'credential_not_found',
      'scoped actor credential not found',
      grant.id
    );
  }
  return credential;
}

export function rotateCliGatewayActorCredentialWithGrant(
  registry: ScopedActorCredentialRegistry,
  grantRegistry: HandshakeGrantRegistry,
  credentialId: string,
  input: CliGatewayGrantActorLifecycleInput
): { token: string; credential: ScopedActorCredentialRecord; revoked: ScopedActorCredentialRecord } {
  const existing = registry.getCredential(credentialId);
  if (!existing) {
    throw new CliGatewayActorGrantError(
      'credential_not_found',
      'scoped actor credential not found'
    );
  }
  const request = strictGrantLifecycleRequest(input, {
    capabilities: existing.capabilities,
    scope: existing.scope,
    actor: existing.actor,
  });
  const grant = validateCliGatewayLifecycleGrant(grantRegistry, request, true);
  const issued = registry.issue({
    actor: existing.actor,
    issuer: {
      id: grant.id,
      ...(grant.issuer.displayName ? { displayName: grant.issuer.displayName } : {}),
    },
    grantId: grant.id,
    audience: existing.audience,
    capabilities: existing.capabilities,
    scope: existing.scope,
    ...(request.ttlMs != null ? { ttlMs: request.ttlMs } : {}),
    ...(request.expiresAt ? { expiresAt: request.expiresAt } : {}),
    ...(isRecord(input.metadata) ? { metadata: input.metadata } : {}),
    correlationId: request.correlationId,
  });
  const revoked = registry.revoke(credentialId, {
    revokedBy: `grant:${grant.id}`,
    reason: 'rotated by grant-backed lifecycle',
    correlationId: request.correlationId,
  });
  if (!revoked) throw new Error('credential disappeared during rotation');
  return { ...issued, revoked };
}

function scopeForValidation(
  scope: ScopedActorCredentialScope | undefined,
  options: { deferWorkContextScope?: boolean } = {}
): HandshakeGrantValidationScope {
  const taskRef = taskRefForGrantValidation(scope?.taskRefs);
  return {
    ...(scope?.nodeIds?.[0] ? { nodeId: scope.nodeIds[0] } : {}),
    ...(scope?.sessionIds?.[0] ? { sessionId: scope.sessionIds[0] } : {}),
    ...(scope?.globalSessionIds?.[0]
      ? { globalSessionId: scope.globalSessionIds[0] }
      : {}),
    ...(scope?.workContextIds?.[0]
      ? { workContextId: scope.workContextIds[0] }
      : {}),
    ...(options.deferWorkContextScope ? { deferWorkContextScope: true } : {}),
    ...(scope?.repoIds?.[0] ? { repoId: scope.repoIds[0] } : {}),
    ...(scope?.pathPrefixes?.[0] ? { path: scope.pathPrefixes[0] } : {}),
    ...(taskRef ? { taskRef } : {}),
  };
}

function taskRefForGrantValidation(taskRefs: readonly string[] | undefined): string | undefined {
  if (!taskRefs?.length) return undefined;
  return (
    taskRefs.find((taskRef) => taskRef !== CLI_GATEWAY_READ_SCOPE_TASK_REF) ??
    taskRefs[0]
  );
}

function credentialMatchesGrantLifecycleRequest(
  credential: ScopedActorCredentialRecord,
  request: StrictGrantLifecycleRequest
): boolean {
  return (
    credential.audience === request.audience &&
    credential.actor.type === request.actor.type &&
    credential.actor.id === request.actor.id &&
    listIsSubset(credential.capabilities, request.capabilities) &&
    scopeIsAuthorizedByRequest(credential.scope, request.scope)
  );
}

function scopeIsAuthorizedByRequest(
  credentialScope: ScopedActorCredentialScope,
  requestScope: ScopedActorCredentialScope
): boolean {
  return (
    scopeDimensionIsAuthorized(credentialScope.nodeIds, requestScope.nodeIds) &&
    scopeDimensionIsAuthorized(credentialScope.sessionIds, requestScope.sessionIds) &&
    scopeDimensionIsAuthorized(
      credentialScope.globalSessionIds,
      requestScope.globalSessionIds
    ) &&
    scopeDimensionIsAuthorized(
      credentialScope.workContextIds,
      requestScope.workContextIds
    ) &&
    scopeDimensionIsAuthorized(credentialScope.repoIds, requestScope.repoIds) &&
    scopeDimensionIsAuthorized(credentialScope.pathPrefixes, requestScope.pathPrefixes) &&
    scopeDimensionIsAuthorized(credentialScope.taskRefs, requestScope.taskRefs)
  );
}

function scopeDimensionIsAuthorized(
  credentialValues: readonly string[] | undefined,
  requestValues: readonly string[] | undefined
): boolean {
  if (!credentialValues?.length) return !requestValues?.length;
  if (!requestValues?.length) return false;
  return listIsSubset(credentialValues, requestValues);
}

function listIsSubset(
  values: readonly string[],
  allowed: readonly string[]
): boolean {
  return values.every((value) => allowed.includes(value));
}

function uniqueStrings(values: readonly string[]): string[] {
  return Array.from(new Set(values));
}

type StrictGrantLifecycleRequest = {
  grantHandle: string;
  audience: typeof CLI_GATEWAY_ACTOR_AUDIENCE;
  capabilities: RelayCapabilityBit[];
  actor: HandshakeGrantActor;
  grantActor?: HandshakeGrantActor;
  deviceId?: string;
  sessionBinding?: HandshakeGrantSessionBinding;
  scope: ScopedActorCredentialScope;
  ttlMs?: number;
  expiresAt?: string;
  correlationId: string;
};

function strictGrantLifecycleRequest(
  input: CliGatewayGrantActorLifecycleInput,
  options: {
    ttlRequired?: boolean;
    capabilities?: readonly RelayCapabilityBit[];
    scope?: ScopedActorCredentialScope;
    actor?: HandshakeGrantActor;
  } = {}
): StrictGrantLifecycleRequest {
  if (typeof input.grantHandle !== 'string' || !input.grantHandle.trim()) {
    throw new CliGatewayActorGrantError(
      'grant_handle_required',
      'grant-backed lifecycle requires a handshake grant handle'
    );
  }
  if (input.audience !== CLI_GATEWAY_ACTOR_AUDIENCE) {
    throw new CliGatewayActorGrantError(
      typeof input.audience === 'string' ? 'audience_expansion' : 'audience_required',
      'grant-backed CLI actor credentials require audience relay:cli-gateway:v1'
    );
  }
  const actor = options.actor ?? strictActor(input.actor);
  const capabilities = options.capabilities
    ? [...options.capabilities]
    : strictCliGatewayCapabilities(input.capabilities);
  const scope = defaultCliGatewayActorScope(options.scope ?? strictScope(input.scope));
  const ttlRequired = options.ttlRequired ?? true;
  const ttlMs = typeof input.ttlMs === 'number' ? input.ttlMs : undefined;
  const expiresAt = typeof input.expiresAt === 'string' ? input.expiresAt : undefined;
  if (ttlRequired && ttlMs == null && !expiresAt) {
    throw new CliGatewayActorGrantError(
      'ttl_required',
      'grant-backed CLI actor credentials require ttlMs or expiresAt'
    );
  }
  return {
    grantHandle: input.grantHandle.trim(),
    audience: CLI_GATEWAY_ACTOR_AUDIENCE,
    capabilities,
    actor,
    ...(input.grantActor ? { grantActor: strictActor(input.grantActor) } : {}),
    ...(typeof input.deviceId === 'string' ? { deviceId: input.deviceId } : {}),
    ...(isRecord(input.sessionBinding)
      ? { sessionBinding: strictSessionBinding(input.sessionBinding) }
      : {}),
    scope,
    ...(ttlMs != null ? { ttlMs } : {}),
    ...(expiresAt ? { expiresAt } : {}),
    correlationId:
      typeof input.correlationId === 'string' && input.correlationId.trim()
        ? input.correlationId.trim()
        : `cli-actor-grant-${Date.now()}`,
  };
}

function validateCliGatewayLifecycleGrant(
  grantRegistry: HandshakeGrantRegistry,
  request: StrictGrantLifecycleRequest,
  consume: boolean
) {
  const validationInput = {
    audience: request.audience,
    requiredCapabilities: request.capabilities,
    actor: request.actor,
    ...(request.deviceId ? { deviceId: request.deviceId } : {}),
    ...(request.sessionBinding ? { sessionBinding: request.sessionBinding } : {}),
    scope: scopeForValidation(request.scope),
    consume: false,
    correlationId: request.correlationId,
  };
  const preflight = grantRegistry.validate(request.grantHandle, validationInput);
  if (preflight.ok === false) {
    throw new CliGatewayActorGrantError(
      preflight.reason,
      'handshake grant does not authorize the requested CLI actor credential lifecycle operation',
      preflight.grantId
    );
  }
  const scopeExpansion = validateRequestedScopeAgainstGrant(
    preflight.grant.scope,
    request.scope
  );
  if (scopeExpansion) {
    throw new CliGatewayActorGrantError(
      scopeExpansion,
      'handshake grant does not authorize the requested CLI actor credential lifecycle operation',
      preflight.grant.id
    );
  }
  const validation = grantRegistry.validate(request.grantHandle, {
    ...validationInput,
    consume,
  });
  if (validation.ok === false) {
    throw new CliGatewayActorGrantError(
      validation.reason,
      'handshake grant does not authorize the requested CLI actor credential lifecycle operation',
      validation.grantId
    );
  }
  return validation.grant;
}

function validateRequestedScopeAgainstGrant(
  grantScope: HandshakeGrantScope,
  requestScope: ScopedActorCredentialScope
): HandshakeGrantValidationFailureReason | null {
  const rules: {
    grantValues: readonly string[] | undefined;
    requestValues: readonly string[] | undefined;
    wrongReason: HandshakeGrantValidationFailureReason;
    matches?: (grantValues: readonly string[], requestedValue: string) => boolean;
  }[] = [
    {
      grantValues: grantScope.nodeIds,
      requestValues: requestScope.nodeIds,
      wrongReason: 'wrong_node_scope',
    },
    {
      grantValues: grantScope.sessionIds,
      requestValues: requestScope.sessionIds,
      wrongReason: 'wrong_session_scope',
    },
    {
      grantValues: grantScope.globalSessionIds,
      requestValues: requestScope.globalSessionIds,
      wrongReason: 'wrong_global_session_scope',
    },
    {
      grantValues: grantScope.workContextIds,
      requestValues: requestScope.workContextIds,
      wrongReason: 'wrong_work_context_scope',
    },
    {
      grantValues: grantScope.repoIds,
      requestValues: requestScope.repoIds,
      wrongReason: 'wrong_repo_scope',
    },
    {
      grantValues: grantScope.pathPrefixes,
      requestValues: requestScope.pathPrefixes,
      wrongReason: 'wrong_path_scope',
      matches: (prefixes, requestedPath) =>
        prefixes.some((prefix) => pathMatchesGrantPrefix(requestedPath, prefix)),
    },
    {
      grantValues: grantScope.taskRefs,
      requestValues: requestScope.taskRefs,
      wrongReason: 'wrong_task_scope',
    },
  ];

  for (const rule of rules) {
    const requestValues = requestValuesForGrantScopeRule(rule);
    if (!requestValues.length) continue;
    const grantValues = rule.grantValues;
    if (!grantValues?.length) {
      if (requestOnlyScopeDimensionIsAllowed(rule.wrongReason, requestValues)) continue;
      return rule.wrongReason;
    }
    const matches = rule.matches ?? ((values, requested) => values.includes(requested));
    if (!requestValues.every((value) => matches(grantValues, value))) {
      return rule.wrongReason;
    }
  }
  return null;
}

function requestValuesForGrantScopeRule(rule: {
  grantValues: readonly string[] | undefined;
  requestValues: readonly string[] | undefined;
  wrongReason: HandshakeGrantValidationFailureReason;
}): readonly string[] {
  const requestValues = rule.requestValues ?? [];
  if (rule.wrongReason !== 'wrong_task_scope') return requestValues;
  return requestValues.filter(
    (taskRef) =>
      taskRef !== CLI_GATEWAY_READ_SCOPE_TASK_REF || rule.grantValues?.includes(taskRef)
  );
}

function requestOnlyScopeDimensionIsAllowed(
  wrongReason: HandshakeGrantValidationFailureReason,
  requestValues: readonly string[]
): boolean {
  return (
    wrongReason === 'wrong_task_scope' &&
    requestValues.length === 1 &&
    requestValues[0] === CLI_GATEWAY_READ_SCOPE_TASK_REF
  );
}

function pathMatchesGrantPrefix(path: string, prefix: string): boolean {
  if (path === prefix) return true;
  const normalizedPrefix = prefix.endsWith('/') ? prefix : `${prefix}/`;
  return path.startsWith(normalizedPrefix);
}

function strictActor(value: unknown): HandshakeGrantActor {
  if (!isRecord(value) || typeof value.type !== 'string' || typeof value.id !== 'string') {
    throw new CliGatewayActorGrantError(
      'actor_required',
      'grant-backed lifecycle requires actor type and id'
    );
  }
  return {
    type: value.type,
    id: value.id,
    ...(typeof value.displayName === 'string' ? { displayName: value.displayName } : {}),
  };
}

function strictCliGatewayCapabilities(value: unknown): RelayCapabilityBit[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new CliGatewayActorGrantError(
      'capability_required',
      'grant-backed lifecycle requires explicit capability bits'
    );
  }
  const capabilities = value.filter((entry): entry is string => typeof entry === 'string');
  if (capabilities.length !== value.length || capabilities.some((capability) => capability === '*')) {
    throw new CliGatewayActorGrantError(
      'capability_expansion',
      'grant-backed CLI actor credentials are limited to the CLI gateway capability allowlist'
    );
  }
  if (capabilities.some((capability) => !isRelayCapabilityBit(capability))) {
    throw new CliGatewayActorGrantError(
      'unknown_capability',
      'grant-backed lifecycle requires known Relay capability bits'
    );
  }
  if (capabilities.some((capability) => !cliGatewayActorGrantCapabilitySet.has(capability))) {
    throw new CliGatewayActorGrantError(
      'capability_expansion',
      'grant-backed CLI actor credentials are limited to the CLI gateway capability allowlist'
    );
  }
  return capabilities as RelayCapabilityBit[];
}

function strictScope(value: unknown): ScopedActorCredentialScope {
  const scope = coerceScope(value);
  if (!scope || Object.keys(scope).length === 0) {
    throw new CliGatewayActorGrantError(
      'scope_required',
      'grant-backed lifecycle requires at least one explicit scope dimension'
    );
  }
  return scope;
}

function strictSessionBinding(value: Record<string, unknown>): HandshakeGrantSessionBinding {
  return {
    ...(typeof value['sessionId'] === 'string' ? { sessionId: value['sessionId'] } : {}),
    ...(typeof value['globalSessionId'] === 'string'
      ? { globalSessionId: value['globalSessionId'] }
      : {}),
    ...(typeof value['workContextId'] === 'string'
      ? { workContextId: value['workContextId'] }
      : {}),
    ...(typeof value['authSessionHash'] === 'string'
      ? { authSessionHash: value['authSessionHash'] }
      : {}),
  };
}

const forbiddenActorReasons = new Set<ScopedActorCredentialValidationFailureReason>([
  'unsupported_actor_type',
  'wrong_audience',
  'unknown_audience',
  'missing_scope',
  'wrong_node_scope',
  'wrong_session_scope',
  'wrong_global_session_scope',
  'wrong_work_context_scope',
  'wrong_repo_scope',
  'wrong_path_scope',
  'wrong_task_scope',
  'unknown_capability',
  'insufficient_capability',
]);

function cliGatewayActorReasonCode(
  reason: ScopedActorCredentialValidationFailureReason
): string {
  return `CLI_ACTOR_${reason.toUpperCase()}`;
}

function cliGatewayActorMessage(reasonCode: string): string {
  switch (reasonCode) {
    case 'CLI_ACTOR_CREDENTIAL_MISSING':
      return 'CLI gateway read commands require --actor-token or RELAY_IDE_ACTOR_TOKEN';
    case 'CLI_ACTOR_BROWSER_COOKIE_REJECTED':
      return 'browser cookies are not accepted for the scoped CLI actor lane';
    case 'CLI_ACTOR_NODE_CREDENTIAL_REJECTED':
      return 'node credentials are not accepted for the scoped CLI actor lane';
    case 'CLI_ACTOR_CREDENTIAL_UNSUPPORTED_TYPE':
      return 'unsupported CLI gateway credential type';
    case 'CLI_ACTOR_ROUTE_UNSUPPORTED':
      return 'scoped CLI actor credentials are limited to the read-only CLI gateway smoke surface';
    default:
      return `scoped CLI actor credential rejected: ${reasonCode}`;
  }
}

function coerceActor(value: unknown): { type: string; id: string; displayName?: string } {
  const actor = isRecord(value) ? value : {};
  return {
    type: typeof actor.type === 'string' ? actor.type : 'cli',
    id: typeof actor.id === 'string' ? actor.id : 'relay-cli',
    ...(typeof actor.displayName === 'string'
      ? { displayName: actor.displayName }
      : {}),
  };
}

function coerceIssuer(value: unknown): { id: string; displayName?: string } {
  const issuer = isRecord(value) ? value : {};
  return {
    id: typeof issuer.id === 'string' ? issuer.id : 'browser-operator',
    ...(typeof issuer.displayName === 'string'
      ? { displayName: issuer.displayName }
      : {}),
  };
}

function coerceCapabilities(value: unknown): RelayCapabilityBit[] {
  if (!Array.isArray(value)) return ['session:read'];
  const caps = value.filter(
    (cap): cap is RelayCapabilityBit => typeof cap === 'string' && isRelayCapabilityBit(cap) && cliGatewayActorGrantCapabilitySet.has(cap)
  );
  return caps.length ? caps : ['session:read'];
}

function coerceScope(value: unknown): ScopedActorCredentialScope | undefined {
  if (!isRecord(value)) return undefined;
  const scope: ScopedActorCredentialScope = {};
  for (const [key, outputKey] of [
    ['nodeIds', 'nodeIds'],
    ['sessionIds', 'sessionIds'],
    ['globalSessionIds', 'globalSessionIds'],
    ['workContextIds', 'workContextIds'],
    ['repoIds', 'repoIds'],
    ['pathPrefixes', 'pathPrefixes'],
    ['taskRefs', 'taskRefs'],
  ] as const) {
    const raw = value[key];
    if (Array.isArray(raw)) {
      const strings = raw.filter((entry): entry is string => typeof entry === 'string');
      if (strings.length) scope[outputKey] = strings;
    }
  }
  return scope;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
