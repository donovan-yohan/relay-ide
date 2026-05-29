import type { Request, Response } from 'express';
import {
  ScopedActorCredentialRegistry,
  type ScopedActorCredentialRecord,
  type ScopedActorCredentialScope,
  type ScopedActorCredentialValidationFailureReason,
  type ScopedActorCredentialValidationResult,
} from '../shared/scoped-actor-credentials.js';
import type { RelayCapabilityBit } from '../shared/security-policy.js';

export const CLI_GATEWAY_ACTOR_AUDIENCE = 'relay:cli-gateway:v1' as const;
export const CLI_GATEWAY_READ_SCOPE_TASK_REF = 'relay:cli-gateway:v1:read' as const;
export const CLI_GATEWAY_ACTOR_TOKEN_HEADER = 'x-relay-cli-actor-token' as const;
export const CLI_GATEWAY_COMMAND_HEADER = 'x-relay-cli-command' as const;
export const CLI_GATEWAY_CORRELATION_ID_HEADER = 'x-relay-correlation-id' as const;
export const CLI_GATEWAY_ACTOR_READ_COMMANDS = [
  'nodes.list',
  'sessions.list',
  'sessions.get',
  'work-contexts.get',
] as const;
export type CliGatewayActorReadCommand =
  (typeof CLI_GATEWAY_ACTOR_READ_COMMANDS)[number];

const cliGatewayActorReadCommandSet = new Set<string>(CLI_GATEWAY_ACTOR_READ_COMMANDS);

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

export interface CliGatewayActorValidationInput {
  token: string;
  capabilities: readonly RelayCapabilityBit[];
  scope?: ScopedActorCredentialScope;
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
  return req.header(CLI_GATEWAY_ACTOR_TOKEN_HEADER) === 'v1';
}

export function classifyCliGatewayCredentialLane(
  req: Request,
  expectedCommand?: CliGatewayActorReadCommand
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
    return isSupportedCliGatewayActorReadRequest(req, expectedCommand)
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
  return command === expectedCommand;
}

export function defaultCliGatewayActorScope(
  overrides?: ScopedActorCredentialScope
): ScopedActorCredentialScope {
  return {
    taskRefs: [CLI_GATEWAY_READ_SCOPE_TASK_REF],
    ...(overrides ?? {}),
  };
}

export function validateCliGatewayActorCredential(
  registry: ScopedActorCredentialRegistry,
  input: CliGatewayActorValidationInput
): ScopedActorCredentialValidationResult {
  return registry.validate(input.token, {
    audience: CLI_GATEWAY_ACTOR_AUDIENCE,
    requiredCapabilities: [...input.capabilities],
    scope: {
      taskRef: CLI_GATEWAY_READ_SCOPE_TASK_REF,
      ...scopeForValidation(input.scope),
    },
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
    scope: defaultCliGatewayActorScope(scope),
    ttlMs,
    ...(typeof input.expiresAt === 'string' ? { expiresAt: input.expiresAt } : {}),
    ...(isRecord(input.metadata) ? { metadata: input.metadata } : {}),
    ...(typeof input.correlationId === 'string'
      ? { correlationId: input.correlationId }
      : {}),
  });
}

function scopeForValidation(
  scope: ScopedActorCredentialScope | undefined
): {
  nodeId?: string;
  sessionId?: string;
  globalSessionId?: string;
  workContextId?: string;
  repoId?: string;
  path?: string;
  taskRef?: string;
} {
  return {
    ...(scope?.nodeIds?.[0] ? { nodeId: scope.nodeIds[0] } : {}),
    ...(scope?.sessionIds?.[0] ? { sessionId: scope.sessionIds[0] } : {}),
    ...(scope?.globalSessionIds?.[0]
      ? { globalSessionId: scope.globalSessionIds[0] }
      : {}),
    ...(scope?.workContextIds?.[0]
      ? { workContextId: scope.workContextIds[0] }
      : {}),
    ...(scope?.repoIds?.[0] ? { repoId: scope.repoIds[0] } : {}),
    ...(scope?.pathPrefixes?.[0] ? { path: scope.pathPrefixes[0] } : {}),
    ...(scope?.taskRefs?.[0] ? { taskRef: scope.taskRefs[0] } : {}),
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
  const caps = value.filter((cap): cap is RelayCapabilityBit => cap === 'session:read');
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
