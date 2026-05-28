// #765 / ADR-019: gateway HTTP surface for context packets + session inbox.
//
// This router owns the `context.*` / `inbox.*` v1 CLI gateway verbs. It is
// STRICTLY ref-only and hub-mediated: it never pushes context into a session's
// raw PTY input. Delivery is PULL — `inbox.list` / `inbox.get` are the only
// verbs that flip a message `queued → delivered`, as a read side effect.
//
// STORE SEAM (parallel lane #758): this router depends only on the narrow
// `ContextInboxStore` interface declared below — create/get/list packets,
// send/list/get inbox messages, and a single transition-guarded
// `updateInboxState`. #758 builds the concrete SQLite-behind-gateway store
// (mirroring `server/work-contexts.ts`) and the orchestrator wires it into the
// mount block in `server/index.ts` at integration. Until then this router can
// be exercised against any in-memory implementation of the interface (see the
// route-level test).
//
// CAPABILITY GATE: the gateway client forwards granted bits in the
// `x-relay-capabilities` header. Reads require `context:read` / `inbox:read`,
// writes require `context:write` / `inbox:write`. A missing bit is a 403
// FORBIDDEN — consistent with `server/cli-gateway-events.ts`. The bits are
// default-allow (reads) / dev-allow-not-high-risk (writes) per ADR-019 D5, so
// a headless agent ack loop is never gated behind a confirmation prompt.
//
// TERMINAL-STATE GUARD (fugu C2): `inbox.ack` / `inbox.resolve` / `inbox.ignore`
// call the store's transition-guarded `updateInboxState`; the router never
// trusts the caller to enforce the lifecycle. Idempotent re-acks succeed; any
// transition out of a `TERMINAL_INBOX_MESSAGE_STATES` member is rejected as a
// SESSION_CONFLICT. The same guard is shared with #758's store.

import { Router } from 'express';
import type { RequestHandler, Request, Response } from 'express';

import type { RelayCliGatewayErrorCode } from '../../shared/cli-gateway-contract.js';
import type { GlobalSessionId } from '../../shared/identity.js';
import type { WorkContextId } from '../../shared/work-context.js';
import {
  TERMINAL_INBOX_MESSAGE_STATES,
  type ContextPacket,
  type ContextPacketBinding,
  type ContextPacketId,
  type ContextPacketKind,
  type SessionInboxMessage,
  type SessionInboxMessageId,
  type SessionInboxMessageState,
} from '../../shared/context-packet.js';
import {
  decoratePacketAnchorState,
  decoratePacketsAnchorState,
  type AnchorStateResolver,
  type DecoratedContextPacket,
} from '../context-adapters/file-range.js';
import { resolveAnchorWithRegisteredFetcher } from '../anchor-resolution.js';
import { FILE_RESOURCE_REF_INTENTS } from '../../shared/file-resource-ref.js';

// ---------------------------------------------------------------------------
// Store seam — implemented by #758, depended on here as an interface.
// ---------------------------------------------------------------------------

/** Input the router hands the store to mint a packet. */
export interface CreateContextPacketInput {
  kind: ContextPacketKind;
  anchor?: ContextPacket['anchor'];
  fileRef?: ContextPacket['fileRef'];
  note?: string;
  binding?: ContextPacketBinding;
  createdBy: string;
}

/** Filter for `listPackets`. All fields optional. */
export interface ListContextPacketsFilter {
  nodeId?: string;
  workspaceId?: string;
  limit?: number;
}

/** Input the router hands the store to queue an inbox message. */
export interface CreateInboxMessageInput {
  targetSessionId?: GlobalSessionId;
  targetWorkContextId?: WorkContextId;
  contextPacketIds: ContextPacketId[];
  text?: string;
  createdBy: string;
}

/** Filter for `listInboxMessages`. At least one target is required by the route. */
export interface ListInboxMessagesFilter {
  targetSessionId?: GlobalSessionId;
  targetWorkContextId?: WorkContextId;
  state?: SessionInboxMessageState;
  limit?: number;
}

/**
 * Result of a transition-guarded inbox state update. `ok: false` carries a
 * typed reason so the router can map it to the right gateway error code
 * WITHOUT re-implementing the lifecycle rules (those live in the store, shared
 * with #758).
 */
export type UpdateInboxStateResult =
  | { ok: true; message: SessionInboxMessage }
  | { ok: false; reason: 'not_found' }
  | {
      ok: false;
      reason: 'terminal';
      currentState: SessionInboxMessageState;
    }
  | {
      ok: false;
      reason: 'invalid_transition';
      currentState: SessionInboxMessageState;
    };

/**
 * The narrow store contract this router needs. #758 implements it over SQLite.
 *
 * `getInboxMessage` / `listInboxMessages` MAY flip `queued → delivered` as a
 * PULL side effect (the read-as-delivery semantics from ADR-019 D3); that
 * belongs in the store, not the router, so the projection is consistent across
 * the future agent `preturn` path.
 *
 * `updateInboxState` is the single transition-guarded mutation. The store is
 * the authority on the lifecycle machine (idempotent re-ack, terminal reject);
 * the router only forwards the requested target state and maps the result.
 */
export interface ContextInboxStore {
  createPacket(input: CreateContextPacketInput): ContextPacket;
  getPacket(id: ContextPacketId): ContextPacket | null;
  listPackets(filter?: ListContextPacketsFilter): ContextPacket[];

  createInboxMessage(input: CreateInboxMessageInput): SessionInboxMessage;
  listInboxMessages(filter: ListInboxMessagesFilter): SessionInboxMessage[];
  getInboxMessage(id: SessionInboxMessageId): SessionInboxMessage | null;

  /**
   * Transition-guarded update. Caller-requested `targetState` is validated by
   * the store against the `queued → delivered → acknowledged → terminal`
   * machine; transitions out of a terminal state are refused.
   */
  updateInboxState(
    id: SessionInboxMessageId,
    targetState: SessionInboxMessageState,
    actorId?: string
  ): UpdateInboxStateResult;
}

export interface ContextInboxRouterDeps {
  store: ContextInboxStore | null;
  requireAuth?: RequestHandler;
  /**
   * #760: resolve a `file-anchor` packet's DERIVED `AnchorState` at read time.
   * Defaults to the hub-registered #766 resolver. A `null` resolution (no
   * fetcher / no in-scope session) leaves the packet UNDECORATED rather than
   * guessing. `AnchorState` is never stored — it is computed on every read.
   */
  resolveAnchorState?: AnchorStateResolver;
}

// ---------------------------------------------------------------------------
// Capability gate (mirrors server/cli-gateway-events.ts).
// ---------------------------------------------------------------------------

const CONTEXT_READ = 'context:read';
const CONTEXT_WRITE = 'context:write';
const INBOX_READ = 'inbox:read';
const INBOX_WRITE = 'inbox:write';

function parseCapabilityHeader(value: string | undefined): Set<string> {
  if (!value) return new Set();
  return new Set(
    value
      .split(/[\s,]+/)
      .map((entry) => entry.trim())
      .filter(Boolean)
  );
}

interface GatewayErrorBody {
  error: {
    code: RelayCliGatewayErrorCode;
    message: string;
    retryable: boolean;
    details?: Record<string, unknown>;
  };
}

function gatewayErrorBody(
  code: RelayCliGatewayErrorCode,
  message: string,
  retryable: boolean,
  details?: Record<string, unknown>
): GatewayErrorBody {
  return { error: { code, message, retryable, ...(details ? { details } : {}) } };
}

function statusForCode(code: RelayCliGatewayErrorCode): number {
  switch (code) {
    case 'UNAUTHORIZED':
      return 401;
    case 'FORBIDDEN':
      return 403;
    case 'NOT_FOUND':
      return 404;
    case 'SESSION_CONFLICT':
      return 409;
    case 'SERVER_UNAVAILABLE':
      return 503;
    default:
      return 400;
  }
}

function sendGatewayError(
  res: Response,
  code: RelayCliGatewayErrorCode,
  message: string,
  retryable = false,
  details?: Record<string, unknown>
): void {
  res.status(statusForCode(code)).json(gatewayErrorBody(code, message, retryable, details));
}

/** Returns true (and sends a 403) when a required capability is missing. */
function denyMissingCapability(
  req: Request,
  res: Response,
  required: readonly string[]
): boolean {
  const provided = parseCapabilityHeader(req.header('x-relay-capabilities'));
  const missing = required.filter((cap) => !provided.has(cap));
  if (missing.length === 0) return false;
  sendGatewayError(res, 'FORBIDDEN', `missing required capability: ${missing[0]}`, false, {
    capability: missing[0],
    missingCapabilities: missing,
  });
  return true;
}

function bodyRecord(req: Request): Record<string, unknown> {
  return typeof req.body === 'object' && req.body !== null && !Array.isArray(req.body)
    ? (req.body as Record<string, unknown>)
    : {};
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
}

const CONTEXT_PACKET_KIND_SET = new Set<ContextPacketKind>([
  'file-anchor',
  'file-ref',
  'diff-ref',
  'log-ref',
  'note',
]);

function readPacketKind(value: unknown): ContextPacketKind | undefined {
  return typeof value === 'string' && CONTEXT_PACKET_KIND_SET.has(value as ContextPacketKind)
    ? (value as ContextPacketKind)
    : undefined;
}

const INBOX_STATE_SET = new Set<SessionInboxMessageState>([
  'queued',
  'delivered',
  'acknowledged',
  'resolved',
  'ignored',
]);

function readInboxState(value: unknown): SessionInboxMessageState | undefined {
  return typeof value === 'string' && INBOX_STATE_SET.has(value as SessionInboxMessageState)
    ? (value as SessionInboxMessageState)
    : undefined;
}

function readLimit(value: unknown): number | undefined {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim()
        ? Number(value)
        : undefined;
  if (parsed === undefined || !Number.isFinite(parsed)) return undefined;
  return Math.min(Math.max(Math.trunc(parsed), 1), 200);
}

interface FieldValidationHint {
  field: string;
  message: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const SHA256_HEX_RE = /^[a-f0-9]{64}$/i;

function pathEscapesRoot(value: string): boolean {
  const parts: string[] = [];
  for (const segment of value.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (parts.length === 0) return true;
      parts.pop();
      continue;
    }
    parts.push(segment);
  }
  return false;
}

function pushStringPathHint(
  hints: FieldValidationHint[],
  field: string,
  value: unknown,
  message: string
): void {
  if (!isNonEmptyString(value)) {
    hints.push({ field, message });
  } else if (!value.startsWith('/')) {
    hints.push({ field, message: 'must be absolute and start with /' });
  } else if (pathEscapesRoot(value)) {
    hints.push({ field, message: 'must not escape the filesystem root with .. segments' });
  }
}

function pushTimestampAndHashHints(
  hints: FieldValidationHint[],
  payload: Record<string, unknown>,
  fieldPrefix: string
): void {
  const rawCapturedAt = payload['capturedAt'];
  if (
    rawCapturedAt !== undefined &&
    (typeof rawCapturedAt !== 'string' || !ISO_TIMESTAMP_RE.test(rawCapturedAt))
  ) {
    hints.push({ field: `${fieldPrefix}.capturedAt`, message: 'must be an ISO 8601 UTC timestamp when set' });
  }

  const rawSha = payload['sha256'];
  if (rawSha !== undefined && (typeof rawSha !== 'string' || !SHA256_HEX_RE.test(rawSha))) {
    hints.push({ field: `${fieldPrefix}.sha256`, message: 'must be 64 hex characters when set' });
  }
}

function pushNumericHints(
  hints: FieldValidationHint[],
  payload: Record<string, unknown>,
  fieldPrefix: string
): void {
  for (const numericField of ['size', 'mtimeMs'] as const) {
    const value = payload[numericField];
    if (
      value !== undefined &&
      (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
    ) {
      hints.push({ field: `${fieldPrefix}.${numericField}`, message: 'must be a non-negative finite number when set' });
    }
  }

  const maxBytes = payload['maxBytes'];
  if (
    maxBytes !== undefined &&
    (typeof maxBytes !== 'number' || !Number.isFinite(maxBytes) || maxBytes <= 0)
  ) {
    hints.push({ field: `${fieldPrefix}.maxBytes`, message: 'must be a positive finite number when set' });
  }
}

function pushRepoBindingHints(
  hints: FieldValidationHint[],
  payload: Record<string, unknown>,
  fieldPrefix: string
): void {
  const repoBinding = payload['repoBinding'];
  if (repoBinding === undefined) return;
  if (!isRecord(repoBinding)) {
    hints.push({ field: `${fieldPrefix}.repoBinding`, message: 'must be an object when set' });
    return;
  }

  pushStringPathHint(
    hints,
    `${fieldPrefix}.repoBinding.repoPath`,
    repoBinding['repoPath'],
    'is required and must be an absolute path'
  );

  const worktreePath = repoBinding['worktreePath'];
  if (worktreePath !== undefined && worktreePath !== null) {
    pushStringPathHint(
      hints,
      `${fieldPrefix}.repoBinding.worktreePath`,
      worktreePath,
      'must be an absolute path or null when set'
    );
  }

  const branch = repoBinding['branch'];
  if (branch !== undefined && branch !== null && typeof branch !== 'string') {
    hints.push({ field: `${fieldPrefix}.repoBinding.branch`, message: 'must be a string or null when set' });
  }
}

function validateFileResourceRefPayload(
  payload: unknown,
  fieldPrefix: string
): FieldValidationHint[] {
  const hints: FieldValidationHint[] = [];
  if (!isRecord(payload)) {
    return [
      {
        field: fieldPrefix,
        message: 'must be an object with nodeId, absolute path, and intent',
      },
    ];
  }

  if (!isNonEmptyString(payload['nodeId'])) {
    hints.push({ field: `${fieldPrefix}.nodeId`, message: 'is required and must be a non-empty string' });
  }

  pushStringPathHint(
    hints,
    `${fieldPrefix}.path`,
    payload['path'],
    'is required and must be a non-empty absolute path'
  );

  const rawIntent = payload['intent'];
  if (
    typeof rawIntent !== 'string' ||
    !(FILE_RESOURCE_REF_INTENTS as readonly string[]).includes(rawIntent)
  ) {
    hints.push({
      field: `${fieldPrefix}.intent`,
      message: `must be one of ${FILE_RESOURCE_REF_INTENTS.join('|')}`,
    });
  }

  pushTimestampAndHashHints(hints, payload, fieldPrefix);
  pushNumericHints(hints, payload, fieldPrefix);
  pushRepoBindingHints(hints, payload, fieldPrefix);
  return hints;
}

function validateLineRangePayload(
  payload: unknown,
  fieldPrefix: string
): FieldValidationHint[] {
  if (!isRecord(payload)) return [{ field: fieldPrefix, message: 'must be an object with startLine and endLine' }];
  const hints: FieldValidationHint[] = [];
  const startLine = payload['startLine'];
  const endLine = payload['endLine'];
  if (typeof startLine !== 'number' || !Number.isInteger(startLine) || startLine < 1) {
    hints.push({ field: `${fieldPrefix}.startLine`, message: 'must be an integer >= 1' });
  }
  if (typeof endLine !== 'number' || !Number.isInteger(endLine) || endLine < 1) {
    hints.push({ field: `${fieldPrefix}.endLine`, message: 'must be an integer >= 1' });
  } else if (typeof startLine === 'number' && Number.isInteger(startLine) && endLine < startLine) {
    hints.push({ field: `${fieldPrefix}.endLine`, message: 'must be >= startLine' });
  }
  return hints;
}

function validateByteRangePayload(
  payload: unknown,
  fieldPrefix: string
): FieldValidationHint[] {
  if (!isRecord(payload)) return [{ field: fieldPrefix, message: 'must be an object with startByte and endByte' }];
  const hints: FieldValidationHint[] = [];
  const startByte = payload['startByte'];
  const endByte = payload['endByte'];
  if (typeof startByte !== 'number' || !Number.isInteger(startByte) || startByte < 0) {
    hints.push({ field: `${fieldPrefix}.startByte`, message: 'must be an integer >= 0' });
  }
  if (typeof endByte !== 'number' || !Number.isInteger(endByte) || endByte < 0) {
    hints.push({ field: `${fieldPrefix}.endByte`, message: 'must be an integer >= 0' });
  } else if (typeof startByte === 'number' && Number.isInteger(startByte) && endByte <= startByte) {
    hints.push({ field: `${fieldPrefix}.endByte`, message: 'must be > startByte' });
  }
  return hints;
}

function validateAnchorPayload(payload: unknown): FieldValidationHint[] {
  const hints: FieldValidationHint[] = [];
  if (!isRecord(payload)) {
    return [{ field: 'anchor', message: 'is required and must be an object for kind=file-anchor' }];
  }
  hints.push(...validateFileResourceRefPayload(payload['ref'], 'anchor.ref'));
  const hasLineRange = payload['lineRange'] !== undefined;
  const hasByteRange = payload['byteRange'] !== undefined;
  if (!hasLineRange && !hasByteRange) {
    hints.push({ field: 'anchor', message: 'must include lineRange or byteRange' });
  }
  if (hasLineRange) hints.push(...validateLineRangePayload(payload['lineRange'], 'anchor.lineRange'));
  if (hasByteRange) hints.push(...validateByteRangePayload(payload['byteRange'], 'anchor.byteRange'));
  if (payload['quote'] !== undefined && typeof payload['quote'] !== 'string') {
    hints.push({ field: 'anchor.quote', message: 'must be a string when set' });
  }
  return hints;
}

function validateContextBindingPayload(payload: unknown): FieldValidationHint[] {
  if (payload === undefined) return [];
  if (!isRecord(payload)) return [{ field: 'binding', message: 'must be an object when set' }];

  const hints: FieldValidationHint[] = [];
  for (const field of [
    'workspaceId',
    'nodeId',
    'repoInstanceId',
    'worktreeInstanceId',
  ] as const) {
    if (payload[field] !== undefined && !isNonEmptyString(payload[field])) {
      hints.push({ field: `binding.${field}`, message: 'must be a non-empty string when set' });
    }
  }
  return hints;
}

function validateContextCreatePayload(
  kind: ContextPacketKind,
  body: Record<string, unknown>
): FieldValidationHint[] {
  const hints = validateContextBindingPayload(body['binding']);
  switch (kind) {
    case 'file-anchor':
      hints.push(...validateAnchorPayload(body['anchor']));
      return hints;
    case 'file-ref':
      hints.push(...validateFileResourceRefPayload(body['fileRef'], 'fileRef'));
      return hints;
    case 'note':
      if (!readString(body['note'])) {
        hints.push({ field: 'note', message: 'is required for kind=note' });
      }
      return hints;
    case 'diff-ref':
    case 'log-ref':
    default:
      return hints;
  }
}

const TERMINAL_STATE_SET = new Set<SessionInboxMessageState>(TERMINAL_INBOX_MESSAGE_STATES);

/** Map a guarded-update failure onto the right gateway error response. */
function sendUpdateFailure(
  res: Response,
  result: Exclude<UpdateInboxStateResult, { ok: true }>
): void {
  if (result.reason === 'not_found') {
    sendGatewayError(res, 'NOT_FOUND', 'inbox message not found');
    return;
  }
  if (result.reason === 'terminal') {
    sendGatewayError(
      res,
      'SESSION_CONFLICT',
      `inbox message is in terminal state '${result.currentState}'`,
      false,
      { currentState: result.currentState, terminalStates: [...TERMINAL_INBOX_MESSAGE_STATES] }
    );
    return;
  }
  sendGatewayError(
    res,
    'SESSION_CONFLICT',
    `invalid inbox state transition from '${result.currentState}'`,
    false,
    { currentState: result.currentState }
  );
}

export function createContextInboxRouter(deps: ContextInboxRouterDeps): Router {
  const router = Router();
  const auth = deps.requireAuth ?? ((_req: Request, _res: Response, next) => next());
  // #760: derived `AnchorState` decoration resolver. Defaults to the hub
  // registry; `resolveAnchorWithRegisteredFetcher` returns `null` when the hub
  // has not wired a fetcher, in which case packets pass through undecorated.
  const resolveAnchorState: AnchorStateResolver =
    deps.resolveAnchorState ?? resolveAnchorWithRegisteredFetcher;

  /** Resolve the store or send 503; centralizes the null guard. */
  function store(res: Response): ContextInboxStore | null {
    if (!deps.store) {
      sendGatewayError(res, 'SERVER_UNAVAILABLE', 'context/inbox store is unavailable', true, {
        reasonCode: 'CONTEXT_STORE_UNAVAILABLE',
      });
      return null;
    }
    return deps.store;
  }

  /**
   * #760: collect the decorated `file-anchor` packets a message references, so
   * `inbox.get`/`inbox.list` can surface each referenced packet's derived
   * `AnchorState` without the agent issuing a follow-up `context.get`. Only
   * `file-anchor` packets are decorated; missing/non-anchor packets are skipped.
   * Returns `[]` when the message references no resolvable file-anchor packets.
   */
  async function decoratedAnchorPacketsFor(
    s: ContextInboxStore,
    message: SessionInboxMessage
  ): Promise<DecoratedContextPacket[]> {
    const anchorPackets: ContextPacket[] = [];
    for (const id of message.contextPacketIds) {
      const packet = s.getPacket(id);
      if (packet && packet.kind === 'file-anchor' && packet.anchor) {
        anchorPackets.push(packet);
      }
    }
    if (anchorPackets.length === 0) return [];
    return decoratePacketsAnchorState(anchorPackets, resolveAnchorState);
  }

  /** Attach decorated referenced packets to a message envelope (additive). */
  async function decorateMessage(
    s: ContextInboxStore,
    message: SessionInboxMessage
  ): Promise<SessionInboxMessage & { contextPackets?: DecoratedContextPacket[] }> {
    const contextPackets = await decoratedAnchorPacketsFor(s, message);
    return contextPackets.length > 0 ? { ...message, contextPackets } : message;
  }

  // -- context.create ------------------------------------------------------
  router.post('/context', auth, (req, res) => {
    if (denyMissingCapability(req, res, [CONTEXT_WRITE])) return;
    const s = store(res);
    if (!s) return;
    const body = bodyRecord(req);
    const kind = readPacketKind(body['kind']);
    if (!kind) {
      sendGatewayError(res, 'INVALID_ARGUMENT', 'kind is required and must be a known ContextPacketKind', false, {
        field: 'kind',
      });
      return;
    }
    const fieldErrors = validateContextCreatePayload(kind, body);
    if (fieldErrors.length > 0) {
      const [first] = fieldErrors;
      sendGatewayError(
        res,
        'INVALID_ARGUMENT',
        `invalid ${kind} context packet: ${first?.field ?? 'payload'} ${first?.message ?? 'is invalid'}`,
        false,
        { reasonCode: 'INVALID_CONTEXT_PACKET', fieldErrors }
      );
      return;
    }
    const createdBy = readString(body['createdBy']) ?? 'cli-gateway';
    try {
      const contextPacket = s.createPacket({
        kind,
        ...(body['anchor'] !== undefined ? { anchor: body['anchor'] as ContextPacket['anchor'] } : {}),
        ...(body['fileRef'] !== undefined ? { fileRef: body['fileRef'] as ContextPacket['fileRef'] } : {}),
        ...(readString(body['note']) ? { note: body['note'] as string } : {}),
        ...(body['binding'] !== undefined ? { binding: body['binding'] as ContextPacketBinding } : {}),
        createdBy,
      });
      res.status(201).json({ contextPacket });
    } catch (err) {
      sendGatewayError(res, 'INVALID_ARGUMENT', err instanceof Error ? err.message : 'invalid context packet');
    }
  });

  // -- context.list --------------------------------------------------------
  router.get('/context', auth, (req, res) => {
    if (denyMissingCapability(req, res, [CONTEXT_READ])) return;
    const s = store(res);
    if (!s) return;
    const filter: ListContextPacketsFilter = {};
    const nodeId = readString(req.query['nodeId']);
    const workspaceId = readString(req.query['workspaceId']);
    const limit = readLimit(req.query['limit']);
    if (nodeId) filter.nodeId = nodeId;
    if (workspaceId) filter.workspaceId = workspaceId;
    if (limit !== undefined) filter.limit = limit;
    res.json({ contextPackets: s.listPackets(filter) });
  });

  // -- context.get ---------------------------------------------------------
  // #760: decorate a returned `file-anchor` packet with its DERIVED, NON-STORED
  // `AnchorState` (the runtime consumer of #766 flagged as missing by #759).
  router.get('/context/:id', auth, (req, res, next) => {
    if (denyMissingCapability(req, res, [CONTEXT_READ])) return;
    const s = store(res);
    if (!s) return;
    const contextPacket = s.getPacket(req.params['id'] ?? '');
    if (!contextPacket) {
      sendGatewayError(res, 'NOT_FOUND', 'context packet not found');
      return;
    }
    decoratePacketAnchorState(contextPacket, resolveAnchorState)
      .then((decorated) => res.json({ contextPacket: decorated }))
      .catch(next);
  });

  // -- inbox.send ----------------------------------------------------------
  router.post('/inbox', auth, (req, res) => {
    if (denyMissingCapability(req, res, [INBOX_WRITE])) return;
    const s = store(res);
    if (!s) return;
    const body = bodyRecord(req);
    const targetSessionId = readString(body['targetSessionId']);
    const targetWorkContextId = readString(body['targetWorkContextId']);
    if (!targetSessionId && !targetWorkContextId) {
      sendGatewayError(res, 'INVALID_ARGUMENT', 'one of targetSessionId or targetWorkContextId is required', false, {
        field: 'targetSessionId',
      });
      return;
    }
    const createdBy = readString(body['createdBy']) ?? 'cli-gateway';
    try {
      const message = s.createInboxMessage({
        ...(targetSessionId ? { targetSessionId } : {}),
        ...(targetWorkContextId ? { targetWorkContextId } : {}),
        contextPacketIds: readStringArray(body['contextPacketIds']),
        ...(readString(body['text']) ? { text: body['text'] as string } : {}),
        createdBy,
      });
      res.status(201).json({ message });
    } catch (err) {
      sendGatewayError(res, 'INVALID_ARGUMENT', err instanceof Error ? err.message : 'invalid inbox message');
    }
  });

  // -- inbox.list ----------------------------------------------------------
  // PULL delivery: the store flips queued → delivered as a read side effect.
  router.get('/inbox', auth, (req, res, next) => {
    if (denyMissingCapability(req, res, [INBOX_READ])) return;
    const s = store(res);
    if (!s) return;
    const targetSessionId = readString(req.query['targetSessionId']);
    const targetWorkContextId = readString(req.query['targetWorkContextId']);
    if (!targetSessionId && !targetWorkContextId) {
      sendGatewayError(res, 'INVALID_ARGUMENT', 'one of targetSessionId or targetWorkContextId is required', false, {
        field: 'targetSessionId',
      });
      return;
    }
    const filter: ListInboxMessagesFilter = {};
    if (targetSessionId) filter.targetSessionId = targetSessionId;
    if (targetWorkContextId) filter.targetWorkContextId = targetWorkContextId;
    const state = readInboxState(req.query['state']);
    const limit = readLimit(req.query['limit']);
    if (state) filter.state = state;
    if (limit !== undefined) filter.limit = limit;
    // PULL delivery runs first (the store flips queued → delivered), then each
    // message's referenced file-anchor packets are decorated with derived state.
    const messages = s.listInboxMessages(filter);
    Promise.all(messages.map((m) => decorateMessage(s, m)))
      .then((decorated) => res.json({ messages: decorated }))
      .catch(next);
  });

  // -- inbox.get -----------------------------------------------------------
  // PULL delivery: the store flips queued → delivered as a read side effect.
  // #760: referenced file-anchor packets are decorated with derived AnchorState.
  router.get('/inbox/:id', auth, (req, res, next) => {
    if (denyMissingCapability(req, res, [INBOX_READ])) return;
    const s = store(res);
    if (!s) return;
    const message = s.getInboxMessage(req.params['id'] ?? '');
    if (!message) {
      sendGatewayError(res, 'NOT_FOUND', 'inbox message not found');
      return;
    }
    decorateMessage(s, message)
      .then((decorated) => res.json({ message: decorated }))
      .catch(next);
  });

  // -- inbox.ack / inbox.resolve / inbox.ignore ----------------------------
  // All three go through the store's transition-guarded update; the router
  // never trusts the caller to enforce the lifecycle (fugu C2).
  function transitionHandler(targetState: SessionInboxMessageState): RequestHandler {
    return (req, res) => {
      if (denyMissingCapability(req, res, [INBOX_WRITE])) return;
      const s = store(res);
      if (!s) return;
      const id = req.params['id'] ?? '';
      if (!id) {
        sendGatewayError(res, 'INVALID_ARGUMENT', 'id is required', false, { field: 'id' });
        return;
      }
      const actorId = readString(bodyRecord(req)['actorId']);
      const result = s.updateInboxState(id, targetState, actorId);
      if (!result.ok) {
        sendUpdateFailure(res, result);
        return;
      }
      res.json({ message: result.message });
    };
  }

  router.post('/inbox/:id/ack', auth, transitionHandler('acknowledged'));
  router.post('/inbox/:id/resolve', auth, transitionHandler('resolved'));
  router.post('/inbox/:id/ignore', auth, transitionHandler('ignored'));

  return router;
}

/** Exported for the store + tests: is this a terminal inbox state? */
export function isTerminalInboxState(state: SessionInboxMessageState): boolean {
  return TERMINAL_STATE_SET.has(state);
}
