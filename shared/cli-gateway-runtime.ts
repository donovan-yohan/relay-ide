import type {
  RelayCliGatewayCommand,
  RelayCliGatewayError,
  RelayCliGatewayErrorCode,
} from './cli-gateway-contract.js';

export interface GatewayCreateValidationOk {
  ok: true;
  input: Record<string, unknown>;
  nodeId?: string;
  sessionType: 'agent' | 'terminal';
}

export interface GatewayCreateValidationFailure {
  ok: false;
  error: RelayCliGatewayError;
}

export type GatewayCreateValidationResult =
  | GatewayCreateValidationOk
  | GatewayCreateValidationFailure;

const createSessionAllowedFields = new Set([
  'nodeId',
  'repoPath',
  'worktreePath',
  'cwd',
  'type',
  'mode',
  'agent',
  'yolo',
  'cols',
  'rows',
  'branchName',
  'initialPrompt',
  'continuePolicy',
  'controlMode',
  'sessionEnvelope',
  'ttlSeconds',
  'expiresAt',
  'confirmationToken',
]);

const stringFields = [
  'nodeId',
  'repoPath',
  'cwd',
  'agent',
  'branchName',
  'initialPrompt',
  'expiresAt',
  'confirmationToken',
] as const;

const localUnsupportedFields = [
  'sessionEnvelope',
  'ttlSeconds',
  'expiresAt',
  'confirmationToken',
] as const;

function createValidationError(
  code: RelayCliGatewayErrorCode,
  message: string,
  details?: Record<string, unknown>
): GatewayCreateValidationFailure {
  return {
    ok: false,
    error: {
      code,
      message,
      retryable: false,
      ...(details ? { details } : {}),
    },
  };
}

function invalidCreateInput(
  message: string,
  details?: Record<string, unknown>
): GatewayCreateValidationFailure {
  return createValidationError('INVALID_ARGUMENT', message, details);
}

function unsupportedCreateInput(
  message: string,
  details: Record<string, unknown>
): GatewayCreateValidationFailure {
  return createValidationError('UNSUPPORTED', message, details);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function gatewayCliInvalidArgumentError(
  _commandName: RelayCliGatewayCommand,
  message: string,
  details?: Record<string, unknown>
): RelayCliGatewayError {
  return {
    code: 'INVALID_ARGUMENT',
    message,
    retryable: false,
    ...(details ? { details } : {}),
  };
}

export function gatewayCliInvalidJsonError(
  _commandName: RelayCliGatewayCommand,
  message: string
): RelayCliGatewayError {
  return {
    code: 'INVALID_JSON',
    message: `invalid input JSON: ${message}`,
    retryable: false,
  };
}

function validateStringField(
  input: Record<string, unknown>,
  field: string
): GatewayCreateValidationFailure | null {
  if (input[field] === undefined) return null;
  if (typeof input[field] !== 'string') {
    return invalidCreateInput(`sessions.create ${field} must be a string`, { field });
  }
  return null;
}

function validateNumberField(
  input: Record<string, unknown>,
  field: 'cols' | 'rows' | 'ttlSeconds',
  min: number,
  max?: number
): GatewayCreateValidationFailure | null {
  if (input[field] === undefined) return null;
  if (typeof input[field] !== 'number' || !Number.isFinite(input[field])) {
    return invalidCreateInput(`sessions.create ${field} must be a finite number`, { field });
  }
  if (input[field] < min || (max !== undefined && input[field] > max)) {
    return invalidCreateInput(
      `sessions.create ${field} must be between ${min} and ${max ?? 'infinity'}`,
      { field, min, ...(max !== undefined ? { max } : {}) }
    );
  }
  return null;
}

function validateSessionEnvelopeInput(
  envelope: unknown,
  nodeId: string | undefined
): GatewayCreateValidationFailure | null {
  if (envelope === undefined) return null;
  if (!isRecord(envelope)) {
    return invalidCreateInput('sessions.create sessionEnvelope must be an object', {
      field: 'sessionEnvelope',
    });
  }
  const envelopeNodeId = envelope['nodeId'];
  if (envelopeNodeId !== undefined && typeof envelopeNodeId !== 'string') {
    return invalidCreateInput('sessions.create sessionEnvelope.nodeId must be a string', {
      field: 'sessionEnvelope.nodeId',
    });
  }
  if (nodeId && typeof envelopeNodeId === 'string' && envelopeNodeId !== nodeId) {
    return invalidCreateInput('sessions.create sessionEnvelope.nodeId must match nodeId', {
      field: 'sessionEnvelope.nodeId',
      nodeId,
      envelopeNodeId,
    });
  }
  const peerIdentity = envelope['peerIdentity'];
  if (peerIdentity !== undefined) {
    if (!isRecord(peerIdentity)) {
      return invalidCreateInput(
        'sessions.create sessionEnvelope.peerIdentity must be an object',
        { field: 'sessionEnvelope.peerIdentity' }
      );
    }
    const kind = peerIdentity['kind'];
    if (kind !== 'relay-node') {
      return unsupportedCreateInput(
        'sessions.create does not yet accept adapter-owned agent peer identity; routed creates are represented as relay-node peers until hub credential/session registry ownership lands',
        {
          field: 'sessionEnvelope.peerIdentity.kind',
          unsupported: kind ?? null,
          supported: ['relay-node'],
        }
      );
    }
    const peerNodeId = peerIdentity['nodeId'];
    if (peerNodeId !== undefined && typeof peerNodeId !== 'string') {
      return invalidCreateInput(
        'sessions.create sessionEnvelope.peerIdentity.nodeId must be a string',
        { field: 'sessionEnvelope.peerIdentity.nodeId' }
      );
    }
    if (nodeId && typeof peerNodeId === 'string' && peerNodeId !== nodeId) {
      return invalidCreateInput(
        'sessions.create sessionEnvelope.peerIdentity.nodeId must match nodeId',
        { field: 'sessionEnvelope.peerIdentity.nodeId', nodeId, peerNodeId }
      );
    }
  }
  return null;
}

function sanitizedCreateInput(
  rawInput: Record<string, unknown>
): GatewayCreateValidationFailure | { ok: true; input: Record<string, unknown> } {
  const sanitized: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(rawInput)) {
    if (!createSessionAllowedFields.has(field)) {
      return invalidCreateInput(`sessions.create field is not in the v1 contract: ${field}`, {
        field,
      });
    }
    sanitized[field] = value;
  }
  return { ok: true, input: sanitized };
}

function validateCreateFieldTypes(
  input: Record<string, unknown>
): GatewayCreateValidationFailure | null {
  for (const field of stringFields) {
    const error = validateStringField(input, field);
    if (error) return error;
  }
  if (
    input['worktreePath'] !== undefined &&
    input['worktreePath'] !== null &&
    typeof input['worktreePath'] !== 'string'
  ) {
    return invalidCreateInput('sessions.create worktreePath must be a string or null', {
      field: 'worktreePath',
    });
  }
  if (input['yolo'] !== undefined && typeof input['yolo'] !== 'boolean') {
    return invalidCreateInput('sessions.create yolo must be a boolean', { field: 'yolo' });
  }
  for (const [field, min, max] of [
    ['cols', 1, 500],
    ['rows', 1, 200],
    ['ttlSeconds', 1, undefined],
  ] as const) {
    const error = validateNumberField(input, field, min, max);
    if (error) return error;
  }
  return null;
}

function validateCreateEnums(
  input: Record<string, unknown>
): GatewayCreateValidationFailure | null {
  if (input['type'] !== undefined && input['type'] !== 'agent' && input['type'] !== 'terminal') {
    return invalidCreateInput('sessions.create type must be agent or terminal', { field: 'type' });
  }
  if (input['mode'] !== undefined && input['mode'] !== 'pty' && input['mode'] !== 'web') {
    return invalidCreateInput('sessions.create mode must be pty or web', { field: 'mode' });
  }
  if (
    input['continuePolicy'] !== undefined &&
    input['continuePolicy'] !== 'always' &&
    input['continuePolicy'] !== 'never'
  ) {
    return invalidCreateInput('sessions.create continuePolicy must be always or never', {
      field: 'continuePolicy',
    });
  }
  if (
    input['controlMode'] !== undefined &&
    input['controlMode'] !== 'agent-driven' &&
    input['controlMode'] !== 'human-driven'
  ) {
    return invalidCreateInput('sessions.create controlMode must be agent-driven or human-driven', {
      field: 'controlMode',
    });
  }
  if (input['expiresAt'] !== undefined && Number.isNaN(Date.parse(input['expiresAt'] as string))) {
    return invalidCreateInput('sessions.create expiresAt must be an ISO date-time string', {
      field: 'expiresAt',
    });
  }
  return null;
}

function validateLocalCreateSupport(
  input: Record<string, unknown>
): GatewayCreateValidationFailure | null {
  for (const field of localUnsupportedFields) {
    if (input[field] !== undefined) {
      return unsupportedCreateInput(
        `local sessions.create does not support ${field}; use routed node creation or omit the field`,
        { field, supportedLocalFields: ['repoPath', 'worktreePath', 'type', 'mode', 'agent'] }
      );
    }
  }
  if (typeof input['cwd'] === 'string') {
    return unsupportedCreateInput(
      'local /sessions creation derives cwd from repoPath/worktreePath; explicit cwd requires routed node creation',
      { field: 'cwd', supported: ['repoPath', 'worktreePath'] }
    );
  }
  if (input['controlMode'] === 'agent-driven') {
    return unsupportedCreateInput(
      'local /sessions creation does not yet policy-gate initial controlMode=agent-driven; use routed node creation or omit controlMode',
      { field: 'controlMode', supported: ['human-driven', undefined] }
    );
  }
  if (typeof input['repoPath'] !== 'string') {
    return invalidCreateInput('local session creation requires repoPath', { field: 'repoPath' });
  }
  return null;
}

export function validateAndSanitizeGatewayCreateInput(
  rawInput: Record<string, unknown>
): GatewayCreateValidationResult {
  const sanitizedResult = sanitizedCreateInput(rawInput);
  if (sanitizedResult.ok === false) return sanitizedResult;

  const sanitized = sanitizedResult.input;
  const typeError = validateCreateFieldTypes(sanitized);
  if (typeError) return typeError;
  const enumError = validateCreateEnums(sanitized);
  if (enumError) return enumError;

  const nodeId = typeof sanitized['nodeId'] === 'string' ? sanitized['nodeId'] : undefined;
  const envelopeError = validateSessionEnvelopeInput(sanitized['sessionEnvelope'], nodeId);
  if (envelopeError) return envelopeError;
  if (!nodeId) {
    const localError = validateLocalCreateSupport(sanitized);
    if (localError) return localError;
  }

  const sessionType = sanitized['type'] === 'terminal' ? 'terminal' : 'agent';
  sanitized['type'] = sessionType;
  return { ok: true, input: sanitized, ...(nodeId ? { nodeId } : {}), sessionType };
}

export function validateAndSanitizeLocalGatewayCreateInput(
  rawInput: Record<string, unknown>
): GatewayCreateValidationResult {
  const validated = validateAndSanitizeGatewayCreateInput(rawInput);
  if (validated.ok === false) return validated;
  if (validated.nodeId) {
    return unsupportedCreateInput(
      'local /sessions gateway creation cannot accept nodeId; use routed node creation through /hub/nodes/:nodeId/sessions',
      { field: 'nodeId', supported: ['repoPath', 'worktreePath'] }
    );
  }
  return validated;
}

function upstreamErrorRecord(upstream: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  const error = upstream?.['error'];
  return typeof error === 'object' && error !== null
    ? (error as Record<string, unknown>)
    : upstream;
}

export function normalizeGatewayErrorCode(
  status: number,
  upstream: Record<string, unknown> | undefined
): RelayCliGatewayErrorCode {
  const body = upstreamErrorRecord(upstream);
  const reason = typeof body?.['reasonCode'] === 'string' ? body['reasonCode'] : undefined;
  const code = typeof body?.['code'] === 'string' ? body['code'] : undefined;
  if (code === 'CONFIRMATION_REQUIRED' || reason === 'CONFIRMATION_REQUIRED') return 'CONFIRMATION_REQUIRED';
  if (code === 'NODE_OFFLINE') return 'NODE_OFFLINE';
  if (code === 'UNSUPPORTED') return 'UNSUPPORTED';
  if (reason === 'HAND_BACK_ACK_REQUIRED') return 'INTERVENTION_ACK_REQUIRED';
  if (reason === 'STALE_INTERVENTION_ACK') return 'INTERVENTION_ACK_STALE';
  if (reason === 'CONTROL_STATE_STALE') return 'CONTROL_STATE_STALE';
  if (reason === 'CONTROL_STATE_UNKNOWN') return 'CONTROL_STATE_UNKNOWN';
  if (code === 'UNAUTHORIZED' || status === 401) return 'UNAUTHORIZED';
  if (code === 'NODE_UNSUPPORTED') return 'UNSUPPORTED';
  if (code === 'NOT_FOUND' || status === 404) return 'NOT_FOUND';
  if (code === 'FORBIDDEN' || status === 403) return 'FORBIDDEN';
  if (status === 400 || code === 'INVALID_REQUEST' || code === 'INVALID_ARGUMENT') return 'INVALID_ARGUMENT';
  if (status === 409 || code === 'SESSION_CONFLICT') return 'SESSION_CONFLICT';
  if (status === 503) return 'SERVER_UNAVAILABLE';
  return 'UPSTREAM_ERROR';
}

export function gatewayErrorRetryable(
  status: number,
  upstream: Record<string, unknown> | undefined
): boolean {
  const body = upstreamErrorRecord(upstream);
  if (typeof body?.['retryable'] === 'boolean') return body['retryable'];
  return status === 503 || status >= 500;
}

export function gatewayErrorMessage(
  status: number,
  upstream: Record<string, unknown> | undefined
): string {
  const body = upstreamErrorRecord(upstream);
  return typeof body?.['message'] === 'string'
    ? body['message']
    : `Relay hub returned HTTP ${status}`;
}

function redactedChallenge(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const result: Record<string, unknown> = {};
  for (const key of ['id', 'challengeId', 'expiresAt', 'requiredBits', 'requiredCapabilities']) {
    const entry = value[key];
    if (entry !== undefined) result[key] = entry;
  }
  return Object.keys(result).length ? result : { present: true };
}

export function sanitizedGatewayErrorDetails(
  status: number,
  upstream: Record<string, unknown> | undefined
): Record<string, unknown> {
  const body = upstreamErrorRecord(upstream);
  const details: Record<string, unknown> = { status };
  const code = body?.['code'];
  const reasonCode = body?.['reasonCode'];
  if (typeof code === 'string') details['upstreamCode'] = code;
  if (typeof reasonCode === 'string') details['reasonCode'] = reasonCode;

  const upstreamDetails = isRecord(body?.['details']) ? body['details'] : undefined;
  const field = isRecord(upstreamDetails) ? upstreamDetails['field'] : body?.['field'];
  if (typeof field === 'string') details['field'] = field;
  const challenge = redactedChallenge(
    isRecord(upstreamDetails) ? upstreamDetails['challenge'] : body?.['challenge']
  );
  if (challenge) details['challenge'] = challenge;
  return details;
}
