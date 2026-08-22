import type { Request } from 'express';
import {
  HandshakeGrantRegistry,
  type HandshakeGrantActor,
} from '../shared/operator-handshake-grants.js';
import {
  OPERATOR_CLIENT_CREDENTIAL_AUDIENCE,
  OPERATOR_CLIENT_CREDENTIAL_TOKEN_PREFIX,
  OperatorClientCredentialRegistry,
  type IssueOperatorClientCredentialInput,
  type OperatorClientCredentialRecord,
  type OperatorClientCredentialScope,
  type OperatorClientCredentialValidationFailureReason,
} from '../shared/operator-client-credentials.js';

export const OPERATOR_CLIENT_TOKEN_HEADER =
  'x-relay-operator-client-token' as const;
export const OPERATOR_CLIENT_COMMAND_HEADER = 'x-relay-cli-command' as const;
export const OPERATOR_CLIENT_GATEWAY_HEADER = 'x-relay-cli-gateway' as const;
export const OPERATOR_CLIENT_CHANNEL_COMMANDS = [
  'channels.list',
  'channels.get',
  'channels.history',
  'channels.subscribe',
  'channels.post',
] as const;

export type OperatorClientChannelCommand =
  (typeof OPERATOR_CLIENT_CHANNEL_COMMANDS)[number];
export type OperatorClientAuthFailureReason =
  | OperatorClientCredentialValidationFailureReason
  | 'marker_required'
  | 'actor_marker_forbidden'
  | 'token_substitution'
  | 'command_mismatch'
  | 'gateway_marker_required'
  | 'unsupported_command';

export class OperatorClientCredentialError extends Error {
  constructor(
    public readonly reason:
      | OperatorClientAuthFailureReason
      | 'grant_required'
      | 'grant_rejected'
      | 'credential_not_found'
      | 'client_mismatch',
    message: string
  ) {
    super(message);
    this.name = 'OperatorClientCredentialError';
  }
}

const AUTHENTICATED_OPERATOR_CLIENT_CREDENTIAL = Symbol(
  'relay.operatorClientCredential'
);

type RequestWithOperatorClientCredential = Request & {
  [AUTHENTICATED_OPERATOR_CLIENT_CREDENTIAL]?: OperatorClientCredentialRecord;
};

export function createOperatorClientCredentialRegistry(): OperatorClientCredentialRegistry {
  return new OperatorClientCredentialRegistry();
}

export function bearerOperatorClientToken(req: Request): string {
  const authorization = req.header('authorization') ?? '';
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() ?? '';
}

/** A presented marker or family token always selects this lane, including misuse. */
export function isOperatorClientCredentialRequest(req: Request): boolean {
  return (
    req.header(OPERATOR_CLIENT_TOKEN_HEADER) !== undefined ||
    bearerOperatorClientToken(req).startsWith(
      `${OPERATOR_CLIENT_CREDENTIAL_TOKEN_PREFIX}.`
    )
  );
}

export function authenticatedOperatorClientCredential(
  req: Request
): OperatorClientCredentialRecord | undefined {
  return (req as RequestWithOperatorClientCredential)[
    AUTHENTICATED_OPERATOR_CLIENT_CREDENTIAL
  ];
}

export function authenticateOperatorClientCredential(
  registry: OperatorClientCredentialRegistry,
  req: Request,
  command: OperatorClientChannelCommand,
  channelId?: string
):
  | { ok: true; credential: OperatorClientCredentialRecord }
  | {
      ok: false;
      reason: OperatorClientAuthFailureReason;
      credentialId?: string;
      deniedBits?: string[];
    } {
  if (!isOperatorClientChannelCommand(command)) {
    return { ok: false, reason: 'unsupported_command' };
  }
  if (req.header(OPERATOR_CLIENT_GATEWAY_HEADER) !== 'v1') {
    return { ok: false, reason: 'gateway_marker_required' };
  }
  if (req.header(OPERATOR_CLIENT_TOKEN_HEADER) !== 'v1') {
    return { ok: false, reason: 'marker_required' };
  }
  if (req.header('x-relay-cli-actor-token') !== undefined) {
    return { ok: false, reason: 'actor_marker_forbidden' };
  }
  if (req.header(OPERATOR_CLIENT_COMMAND_HEADER) !== command) {
    return { ok: false, reason: 'command_mismatch' };
  }
  const token = bearerOperatorClientToken(req);
  if (!token.startsWith(`${OPERATOR_CLIENT_CREDENTIAL_TOKEN_PREFIX}.`)) {
    return { ok: false, reason: 'token_substitution' };
  }
  const capabilities =
    command === 'channels.post' ? ['context:write'] : ['context:read'];
  const validation = registry.validate(token, {
    audience: OPERATOR_CLIENT_CREDENTIAL_AUDIENCE,
    requiredCapabilities: capabilities,
    ...(channelId ? { channelId } : {}),
  });
  if (!validation.ok) {
    return {
      ok: false,
      reason: validation.reason,
      ...(validation.credentialId
        ? { credentialId: validation.credentialId }
        : {}),
      deniedBits: validation.deniedBits,
    };
  }
  (req as RequestWithOperatorClientCredential)[
    AUTHENTICATED_OPERATOR_CLIENT_CREDENTIAL
  ] = validation.credential;
  return validation;
}

export function operatorClientAuthFailure(input: {
  reason: OperatorClientAuthFailureReason;
  credentialId?: string;
  deniedBits?: string[];
}): {
  code: 'UNAUTHORIZED' | 'FORBIDDEN';
  reasonCode: string;
  message: string;
  retryable: false;
  lane: 'denied';
  acceptedLanes: ['operator-client-credential'];
  audience: typeof OPERATOR_CLIENT_CREDENTIAL_AUDIENCE;
  credentialId?: string;
  deniedBits?: string[];
} {
  const forbidden = new Set<OperatorClientAuthFailureReason>([
    'wrong_audience',
    'wrong_channel_scope',
    'unknown_capability',
    'insufficient_capability',
    'actor_marker_forbidden',
    'token_substitution',
    'command_mismatch',
    'unsupported_command',
  ]);
  return {
    code: forbidden.has(input.reason) ? 'FORBIDDEN' : 'UNAUTHORIZED',
    reasonCode: `OPERATOR_CLIENT_${input.reason.toUpperCase()}`,
    message: operatorClientFailureMessage(input.reason),
    retryable: false,
    lane: 'denied',
    acceptedLanes: ['operator-client-credential'],
    audience: OPERATOR_CLIENT_CREDENTIAL_AUDIENCE,
    ...(input.credentialId ? { credentialId: input.credentialId } : {}),
    ...(input.deniedBits?.length ? { deniedBits: input.deniedBits } : {}),
  };
}

export function issueOperatorClientCredentialWithGrant(
  registry: OperatorClientCredentialRegistry,
  grants: HandshakeGrantRegistry,
  value: unknown
): { token: string; credential: OperatorClientCredentialRecord } {
  const input = operatorClientCredentialIssueInput(value);
  const grantHandle = requiredGrantHandle(value);
  const grantInput = grantValidationInput(input);
  const preflight = grants.validate(grantHandle, {
    ...grantInput,
    consume: false,
  });
  if (!preflight.ok) throw grantRejected();
  requireGrantScope(preflight.grant.scope.channelIds, input.scope?.channelIds);
  const issued = registry.issue({
    ...input,
    grantId: preflight.grant.id,
    notAfter: preflight.grant.expiresAt,
  });
  const consumed = grants.validate(grantHandle, {
    ...grantInput,
    consume: true,
  });
  if (!consumed.ok) {
    registry.revoke(issued.credential.id, {
      revokedBy: 'grant-validation-failed',
      reason: 'grant validation changed before credential issue completed',
    });
    throw grantRejected();
  }
  return issued;
}

export function revokeOperatorClientCredentialWithGrant(
  registry: OperatorClientCredentialRegistry,
  grants: HandshakeGrantRegistry,
  credentialId: string,
  value: unknown
): OperatorClientCredentialRecord {
  const credential = registry.getCredential(credentialId);
  if (!credential) {
    throw new OperatorClientCredentialError(
      'credential_not_found',
      'operator client credential not found'
    );
  }
  const input = strictRevokeInput(value, credential);
  const grantHandle = requiredGrantHandle(value);
  const grantInput = grantValidationInput(input, credential.capabilities);
  const preflight = grants.validate(grantHandle, {
    ...grantInput,
    consume: false,
  });
  if (!preflight.ok) throw grantRejected();
  requireGrantScope(
    preflight.grant.scope.channelIds,
    credential.scope.channelIds
  );
  const consumed = grants.validate(grantHandle, {
    ...grantInput,
    consume: true,
  });
  if (!consumed.ok) throw grantRejected();
  const revoked = registry.revoke(credentialId, {
    revokedBy: `grant:${preflight.grant.id}`,
    ...(isRecord(value) && typeof value['reason'] === 'string'
      ? { reason: value['reason'] }
      : {}),
  });
  if (!revoked) {
    throw new OperatorClientCredentialError(
      'credential_not_found',
      'operator client credential disappeared during revocation'
    );
  }
  return revoked;
}

export function isOperatorClientChannelCommand(
  value: string
): value is OperatorClientChannelCommand {
  return (OPERATOR_CLIENT_CHANNEL_COMMANDS as readonly string[]).includes(
    value
  );
}

export function operatorClientCredentialIssueInput(
  value: unknown
): IssueOperatorClientCredentialInput {
  if (!isRecord(value)) {
    throw new OperatorClientCredentialError(
      'grant_rejected',
      'operator client credential issue requires an object body'
    );
  }
  const client = strictClient(value['client']);
  const capabilities = strictCapabilities(value['capabilities']);
  const scope = strictScope(value['scope']);
  const ttlMs = typeof value['ttlMs'] === 'number' ? value['ttlMs'] : undefined;
  const expiresAt =
    typeof value['expiresAt'] === 'string' ? value['expiresAt'] : undefined;
  const device = isRecord(value['device'])
    ? strictDevice(value['device'])
    : undefined;
  return {
    client,
    capabilities,
    scope,
    ...(device ? { device } : {}),
    ...(ttlMs !== undefined ? { ttlMs } : {}),
    ...(expiresAt ? { expiresAt } : {}),
    ...(typeof value['correlationId'] === 'string'
      ? { correlationId: value['correlationId'] }
      : {}),
  };
}

function strictRevokeInput(
  value: unknown,
  credential: OperatorClientCredentialRecord
): IssueOperatorClientCredentialInput {
  if (!isRecord(value)) {
    throw new OperatorClientCredentialError(
      'grant_rejected',
      'operator client credential revoke requires an object body'
    );
  }
  const client = strictClient(value['client']);
  if (client.id !== credential.client.id) {
    throw new OperatorClientCredentialError(
      'client_mismatch',
      'operator client metadata does not match this credential'
    );
  }
  const device = isRecord(value['device'])
    ? strictDevice(value['device'])
    : undefined;
  return {
    client,
    capabilities: credential.capabilities,
    scope: credential.scope,
    ...(device ? { device } : {}),
    ttlMs: 1,
  };
}

function grantValidationInput(
  input: Pick<
    IssueOperatorClientCredentialInput,
    'client' | 'device' | 'capabilities' | 'scope'
  >,
  capabilities = input.capabilities
): {
  audience: typeof OPERATOR_CLIENT_CREDENTIAL_AUDIENCE;
  requiredCapabilities: string[];
  actor: HandshakeGrantActor;
  deviceId?: string;
  scope?: { channelIds?: string[] };
} {
  return {
    audience: OPERATOR_CLIENT_CREDENTIAL_AUDIENCE,
    requiredCapabilities: [...capabilities],
    actor: {
      type: 'cli',
      id: input.client.id,
      ...(input.client.displayName
        ? { displayName: input.client.displayName }
        : {}),
    },
    ...(input.device ? { deviceId: input.device.id } : {}),
    ...(input.scope?.channelIds ? { scope: input.scope } : {}),
  };
}

function requireGrantScope(
  grantChannelIds: readonly string[] | undefined,
  credentialChannelIds: readonly string[] | undefined
): void {
  if (grantChannelIds?.length && !credentialChannelIds?.length) {
    throw new OperatorClientCredentialError(
      'grant_rejected',
      'a channel-scoped handshake grant cannot mint an unscoped operator client credential'
    );
  }
}

function requiredGrantHandle(value: unknown): string {
  const grantHandle = isRecord(value) ? value['grantHandle'] : undefined;
  if (typeof grantHandle !== 'string' || !grantHandle.trim()) {
    throw new OperatorClientCredentialError(
      'grant_required',
      'operator client grant-backed lifecycle requires a handshake grant handle'
    );
  }
  return grantHandle.trim();
}

function strictClient(value: unknown): {
  id: string;
  displayName?: string;
  platform?: string;
} {
  if (
    !isRecord(value) ||
    typeof value['id'] !== 'string' ||
    !value['id'].trim()
  ) {
    throw new OperatorClientCredentialError(
      'grant_rejected',
      'operator client credential requires client.id'
    );
  }
  return {
    id: value['id'].trim(),
    ...(typeof value['displayName'] === 'string' && value['displayName'].trim()
      ? { displayName: value['displayName'].trim() }
      : {}),
    ...(typeof value['platform'] === 'string' && value['platform'].trim()
      ? { platform: value['platform'].trim() }
      : {}),
  };
}

function strictDevice(value: Record<string, unknown>): {
  id: string;
  displayName?: string;
} {
  if (typeof value['id'] !== 'string' || !value['id'].trim()) {
    throw new OperatorClientCredentialError(
      'grant_rejected',
      'operator client device metadata requires device.id'
    );
  }
  return {
    id: value['id'].trim(),
    ...(typeof value['displayName'] === 'string' && value['displayName'].trim()
      ? { displayName: value['displayName'].trim() }
      : {}),
  };
}

function strictCapabilities(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.some((capability) => typeof capability !== 'string')
  ) {
    throw new OperatorClientCredentialError(
      'grant_rejected',
      'operator client credential requires explicit capability bits'
    );
  }
  return [...value];
}

function strictScope(value: unknown): OperatorClientCredentialScope {
  if (value === undefined) return {};
  if (!isRecord(value)) {
    throw new OperatorClientCredentialError(
      'grant_rejected',
      'operator client scope must be an object'
    );
  }
  if (value['channelIds'] === undefined) return {};
  if (!Array.isArray(value['channelIds'])) {
    throw new OperatorClientCredentialError(
      'grant_rejected',
      'operator client scope.channelIds must be an array'
    );
  }
  return { channelIds: value['channelIds'] as string[] };
}

function grantRejected(): OperatorClientCredentialError {
  return new OperatorClientCredentialError(
    'grant_rejected',
    'handshake grant does not authorize this operator client credential lifecycle operation'
  );
}

function operatorClientFailureMessage(
  reason: OperatorClientAuthFailureReason
): string {
  switch (reason) {
    case 'marker_required':
      return 'operator client credentials require x-relay-operator-client-token: v1';
    case 'actor_marker_forbidden':
      return 'actor-token markers are not accepted for operator client credentials';
    case 'token_substitution':
      return 'operator client credentials do not accept another credential family';
    case 'command_mismatch':
      return 'operator client credential command marker does not match this route';
    case 'gateway_marker_required':
      return 'operator client credentials require x-relay-cli-gateway: v1';
    case 'unsupported_command':
      return 'operator client credentials are limited to stable channel commands';
    default:
      return `operator client credential rejected: ${reason}`;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
