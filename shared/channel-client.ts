/**
 * Thin Node/TypeScript client for Relay's stable channel HTTP surface.
 *
 * Credentials are deliberately construction-only.  Per-call payloads contain
 * only channel data, so callers cannot accidentally persist a token in a post,
 * a replay fixture, or application logs.
 */
import {
  applyChannelEventV1,
  initialChannelReducerState,
  isChannelEventV1,
  type ChannelAsyncRun,
  type ChannelAgentDetail,
  type ChannelEventV1,
  type ChannelMessage,
  type ChannelMessageId,
  type ChannelMessageSearchResponse,
  type ChannelReducerState,
  type ChannelSenderRef,
  type ChannelSnapshotEventV1,
  type ChannelSnapshotStateReplacementV1,
  type ChannelSubscriptionFilter,
} from './channel-chat-protocol.js';

/**
 * The HTTP client is a public boundary, not a provider debugging surface.
 * Relay-owned run/target ids and sender identity remain useful to callers;
 * backing-runtime, turn and provider-item correlation do not cross it.
 */
export type RelayChannelMessage = Omit<
  ChannelMessage,
  'sender' | 'source' | 'agentDetail' | 'meta'
> & {
  sender: Omit<ChannelSenderRef, 'runtimeId'>;
  agentDetail?: Omit<ChannelAgentDetail, 'itemId'>;
  meta?: Record<string, unknown>;
};

type ChannelMessageEvent = Extract<ChannelEventV1, { message: ChannelMessage }>;
type RelayChannelMessageEvent = Omit<ChannelMessageEvent, 'message'> & {
  message: RelayChannelMessage;
};
export type RelayChannelSnapshotStateReplacement = Omit<
  ChannelSnapshotStateReplacementV1,
  'message'
> & { message: RelayChannelMessage };
export type RelayChannelSnapshotEvent = Omit<
  ChannelSnapshotEventV1,
  'messages' | 'stateReplacements'
> & {
  messages: RelayChannelMessage[];
  stateReplacements?: RelayChannelSnapshotStateReplacement[];
};
export type RelayChannelEvent =
  | Exclude<ChannelEventV1, ChannelMessageEvent | ChannelSnapshotEventV1>
  | RelayChannelMessageEvent
  | RelayChannelSnapshotEvent;

/** A reducer view whose message-bearing fields have passed the public boundary. */
export type RelayChannelReducerState = Omit<
  ChannelReducerState,
  'messages' | 'byId'
> & {
  messages: RelayChannelMessage[];
  byId: Record<string, RelayChannelMessage>;
};

export interface RelayChannelClientConfig {
  /** Relay hub URL. Defaults to RELAY_IDE_URL or the local RELAY_IDE_PORT hub. */
  baseUrl?: string;
  /** Construction-only bearer credential. Defaults to actor then browser env credential. */
  token?: string;
  /** Construction-only headers, useful for an already-authenticated proxy. */
  headers?: HeadersInit;
  /** Injectable for tests or a custom Node fetch dispatcher. */
  fetch?: typeof globalThis.fetch;
  /** Injectable environment for embedded clients and tests. */
  env?: Readonly<Record<string, string | undefined>>;
}

export interface RelayChannelClientErrorBody {
  code?: RelayChannelClientErrorCode;
  message?: string;
  retryable?: boolean;
  details?: Record<string, unknown>;
}

/** Codes are kept in the stable gateway vocabulary even for local guards. */
export type RelayChannelClientErrorCode =
  | 'UNAUTHORIZED'
  | 'SERVER_UNAVAILABLE'
  | 'INVALID_ARGUMENT'
  | 'INVALID_JSON'
  | 'UNSUPPORTED'
  | 'NOT_FOUND'
  | 'FORBIDDEN'
  | 'SESSION_CONFLICT'
  | 'CONFIRMATION_REQUIRED'
  | 'NODE_OFFLINE'
  | 'SESSION_EXPIRED'
  | 'SESSION_REVOKED'
  | 'SESSION_MISMATCH'
  | 'SESSION_NON_RENEWABLE'
  | 'CONTROL_STATE_STALE'
  | 'INTERVENTION_ACK_REQUIRED'
  | 'INTERVENTION_ACK_STALE'
  | 'CONTROL_STATE_UNKNOWN'
  | 'UPSTREAM_ERROR'
  | 'INTERNAL';

const RELAY_CHANNEL_CLIENT_ERROR_CODES = new Set<RelayChannelClientErrorCode>([
  'UNAUTHORIZED',
  'SERVER_UNAVAILABLE',
  'INVALID_ARGUMENT',
  'INVALID_JSON',
  'UNSUPPORTED',
  'NOT_FOUND',
  'FORBIDDEN',
  'SESSION_CONFLICT',
  'CONFIRMATION_REQUIRED',
  'NODE_OFFLINE',
  'SESSION_EXPIRED',
  'SESSION_REVOKED',
  'SESSION_MISMATCH',
  'SESSION_NON_RENEWABLE',
  'CONTROL_STATE_STALE',
  'INTERVENTION_ACK_REQUIRED',
  'INTERVENTION_ACK_STALE',
  'CONTROL_STATE_UNKNOWN',
  'UPSTREAM_ERROR',
  'INTERNAL',
]);

function gatewayErrorCode(value: unknown): RelayChannelClientErrorCode {
  return typeof value === 'string' &&
    RELAY_CHANNEL_CLIENT_ERROR_CODES.has(value as RelayChannelClientErrorCode)
    ? (value as RelayChannelClientErrorCode)
    : 'UPSTREAM_ERROR';
}

/** Error envelope projected without request headers or credential material. */
export class RelayChannelClientError extends Error {
  readonly status: number;
  readonly code?: RelayChannelClientErrorCode;
  readonly retryable?: boolean;
  readonly details?: Record<string, unknown>;

  constructor(status: number, body: RelayChannelClientErrorBody) {
    super(body.message ?? `Relay channel request failed (${status})`);
    this.name = 'RelayChannelClientError';
    this.status = status;
    if (body.code !== undefined) this.code = body.code;
    if (body.retryable !== undefined) this.retryable = body.retryable;
    if (body.details !== undefined) this.details = body.details;
  }
}

export type RelayChannelSubscriptionLimit =
  | 'line-bytes'
  | 'stream-bytes'
  | 'collected-output-bytes';

/** A local, fail-closed bound stopped consuming an untrusted subscription. */
export class RelayChannelSubscriptionOverflowError extends RelayChannelClientError {
  readonly limit: RelayChannelSubscriptionLimit;
  readonly maximum: number;
  readonly observed: number;

  constructor(
    limit: RelayChannelSubscriptionLimit,
    maximum: number,
    observed: number
  ) {
    super(413, {
      code: 'UPSTREAM_ERROR',
      retryable: false,
      message: `Relay subscription exceeded ${limit} limit`,
      details: { limit, maximum, observed },
    });
    this.name = 'RelayChannelSubscriptionOverflowError';
    this.limit = limit;
    this.maximum = maximum;
    this.observed = observed;
  }
}

export interface ChannelSummary {
  id: string;
  [key: string]: unknown;
}

export interface ChannelRosterEntry {
  id: string;
  [key: string]: unknown;
}

export interface ChannelPage {
  messages: RelayChannelMessage[];
  hasMore?: boolean;
  nextCursor?: { beforeSeq: number } | { afterSeq: number };
}

export interface ChannelPostInput {
  channelId: string;
  text: string;
  format?: 'text' | 'markdown';
  parentMessageId?: ChannelMessageId;
  threadId?: ChannelMessageId | null;
  clientMessageId?: string;
}

export interface ChannelPostResult {
  message: RelayChannelMessage;
  run?: ChannelAsyncRun;
  [key: string]: unknown;
}

export interface ChannelSubscribeInput extends ChannelSubscriptionFilter {
  channelId: string;
  afterSeq?: number;
  /** Prior reducer state when resuming; enables catchup state replacement. */
  state?: RelayChannelReducerState;
  signal?: AbortSignal;
  /** Maximum bytes in one NDJSON line. Defaults to 1 MiB. */
  maxLineBytes?: number;
  /** Maximum bytes read from one subscription response. Defaults to 8 MiB. */
  maxStreamBytes?: number;
}

export interface ChannelSubscriptionFrame {
  schemaVersion: 1;
  frame: 'open' | 'event' | 'closed';
  channelId: string;
  sequence: number;
  occurredAt: string;
  durableSeq: number;
  payload?: RelayChannelEvent | { type: 'channel-heartbeat-v1' };
  reason?: string;
  retryable?: boolean;
  latestSeq?: number;
}

export interface ChannelSubscriptionUpdate {
  frame: ChannelSubscriptionFrame;
  /** State after this frame's payload; snapshots apply stateReplacements here. */
  state: RelayChannelReducerState;
  /** Server-confirmed durable cursor; replacements never advance it. */
  durableSeq: number;
}

export interface ChannelCollectInput extends ChannelSubscribeInput {
  /** Stop after this many event frames, without counting open/closed frames. */
  maxEvents?: number;
  /** Stop a quiet stream locally. This is not sent to the server. */
  idleTimeoutMs?: number;
  /** Maximum serialized bytes retained by this collector. Defaults to 8 MiB. */
  maxOutputBytes?: number;
}

export interface ChannelCollectedSubscription {
  frames: ChannelSubscriptionFrame[];
  state: RelayChannelReducerState;
  durableSeq: number;
  /** Why a finite local collection returned. */
  stopReason: 'max-events' | 'idle-timeout' | 'stream-closed' | 'aborted';
}

export interface RelayChannelClient {
  list(): Promise<{ channels: ChannelSummary[] }>;
  get(input: { channelId: string }): Promise<{ channel: ChannelSummary }>;
  run: {
    get(input: {
      channelId: string;
      runId: string;
      threadId?: string;
    }): Promise<{ run: ChannelAsyncRun }>;
  };
  history(input: {
    channelId: string;
    limit?: number;
    beforeSeq?: number;
    afterSeq?: number;
  }): Promise<ChannelPage>;
  threads: {
    history(input: {
      channelId: string;
      threadId: string;
      limit?: number;
      beforeSeq?: number;
      afterSeq?: number;
    }): Promise<ChannelPage>;
  };
  roster(input: {
    channelId: string;
  }): Promise<{ roster: ChannelRosterEntry[] }>;
  /**
   * Search the durable message log (#1410). Omitting `channelId` searches the
   * credential's own channel scope, not every channel: a scope-less actor
   * credential is refused by the hub, and an out-of-scope `channelId` is
   * rejected before any read.
   */
  search(input: {
    q: string;
    channelId?: string;
    workspaceId?: string;
    includeArchived?: boolean;
    limit?: number;
  }): Promise<ChannelMessageSearchResponse>;
  post(input: ChannelPostInput): Promise<ChannelPostResult>;
  subscribe(
    input: ChannelSubscribeInput
  ): AsyncGenerator<ChannelSubscriptionUpdate>;
  collect(input: ChannelCollectInput): Promise<ChannelCollectedSubscription>;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

const PRIVATE_PROVIDER_KEYS = new Set([
  'runtimeId',
  'turnId',
  'itemId',
  'providerItemId',
  'providerTurnId',
  'providerRuntimeId',
  'sessionId',
  'source',
  'sourceId',
  'sourceRuntimeId',
  'sourceTurnId',
  'sourceItemId',
]);
const PRIVATE_PROVIDER_NORMALIZED_KEYS = new Set(
  [...PRIVATE_PROVIDER_KEYS].map((key) =>
    key.replace(/[-_]/g, '').toLowerCase()
  )
);
const SENSITIVE_ERROR_KEY =
  /(?:token|authorization|credential|secret|api[-_]?key|password)/i;
export const RELAY_CHANNEL_SUBSCRIPTION_MAX_LINE_BYTES = 1024 * 1024;
export const RELAY_CHANNEL_SUBSCRIPTION_MAX_STREAM_BYTES = 8 * 1024 * 1024;
export const RELAY_CHANNEL_SUBSCRIPTION_MAX_COLLECTED_OUTPUT_BYTES =
  8 * 1024 * 1024;
const PRIVATE_REDACTION_MIN_CHARS = 8;

function isPrivateProviderKey(key: string): boolean {
  const normalized = key.replace(/[-_]/g, '').toLowerCase();
  return (
    PRIVATE_PROVIDER_NORMALIZED_KEYS.has(normalized) ||
    /^(?:provider|source)?(?:runtime|turn|item|session)(?:id)?$/.test(
      normalized
    )
  );
}

/** Public Relay correlations must not become redaction needles. */
function isRetainedRelayKey(key: string): boolean {
  const normalized = key.replace(/[-_]/g, '').toLowerCase();
  return (
    normalized === 'runid' ||
    normalized === 'targetid' ||
    normalized === 'sender' ||
    normalized === 'senderid' ||
    normalized === 'providerid'
  );
}

function isPrivateValueKey(key: string): boolean {
  return isPrivateProviderKey(key) || SENSITIVE_ERROR_KEY.test(key);
}

/**
 * A provider locator is normally an opaque, punctuation-safe identifier. Do
 * not turn ubiquitous short words (for example `codex`, `0`, or `1`) into
 * global redaction needles merely because an upstream put one under `source`.
 */
function isRedactablePrivateValue(value: string): boolean {
  return (
    value.length >= PRIVATE_REDACTION_MIN_CHARS &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)
  );
}

/**
 * First pass: keep the strings named by private fields even when they are
 * echoed under an otherwise harmless key somewhere else in the same envelope.
 * This deliberately runs before field removal; a source object can contain a
 * provider marker which a diagnostic string later repeats verbatim.
 */
function collectPrivateStringValues(
  value: unknown,
  values: Set<string>,
  inheritedPrivate = false
): void {
  if (typeof value === 'string') {
    if (inheritedPrivate && isRedactablePrivateValue(value)) values.add(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value)
      collectPrivateStringValues(entry, values, inheritedPrivate);
    return;
  }
  const object = record(value);
  if (!object) return;
  for (const [key, entry] of Object.entries(object)) {
    const childPrivate = isRetainedRelayKey(key)
      ? false
      : inheritedPrivate || isPrivateValueKey(key);
    collectPrivateStringValues(entry, values, childPrivate);
  }
}

function redactPrivateStrings(
  value: string,
  needles: ReadonlySet<string>
): string {
  let result = value;
  for (const needle of needles)
    result = result.split(needle).join('[REDACTED]');
  return result;
}

/** Remove provider correlations and secret-bearing keys from nested public data. */
function projectPublicValue(value: unknown, configuredToken?: string): unknown {
  const privateValues = new Set<string>();
  if (configuredToken) privateValues.add(configuredToken);
  collectPrivateStringValues(value, privateValues);
  return projectPublicValueWithNeedles(value, privateValues);
}

function projectPublicValueWithNeedles(
  value: unknown,
  privateValues: ReadonlySet<string>
): unknown {
  if (typeof value === 'string')
    return redactPrivateStrings(value, privateValues);
  if (Array.isArray(value))
    return value.map((entry) =>
      projectPublicValueWithNeedles(entry, privateValues)
    );
  const object = record(value);
  if (!object) return value;
  return Object.fromEntries(
    Object.entries(object)
      .filter(([key]) => !isPrivateValueKey(key))
      .map(([key, entry]) => [
        key,
        projectPublicValueWithNeedles(entry, privateValues),
      ])
  );
}

/** Project every message-bearing response at the client boundary. */
export function projectRelayChannelMessage(
  message: ChannelMessage,
  configuredToken?: string
): RelayChannelMessage {
  return projectPublicValue(message, configuredToken) as RelayChannelMessage;
}

function projectChannelEvent(
  event: ChannelEventV1,
  configuredToken?: string
): RelayChannelEvent {
  // One pass over the complete event matters: a private source value on one
  // snapshot row must also be redacted if another row echoes it under `detail`.
  return projectPublicValue(event, configuredToken) as RelayChannelEvent;
}

function projectReducerState(
  state: ChannelReducerState,
  configuredToken?: string
): RelayChannelReducerState {
  return projectPublicValue(state, configuredToken) as RelayChannelReducerState;
}

function asInternalReducerState(
  state: RelayChannelReducerState
): ChannelReducerState {
  // Reducer operations use stable row ids, sequence and stream cursors. The
  // omitted provider metadata is deliberately irrelevant to those operations.
  return state as unknown as ChannelReducerState;
}

function projectPage(
  page: {
    messages: ChannelMessage[];
    hasMore?: boolean;
    nextCursor?: ChannelPage['nextCursor'];
  },
  configuredToken?: string
): ChannelPage {
  return {
    messages: page.messages.map((message) =>
      projectRelayChannelMessage(message, configuredToken)
    ),
    ...(page.hasMore === undefined ? {} : { hasMore: page.hasMore }),
    ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
  };
}

function projectPostResult(
  result: Omit<ChannelPostResult, 'message'> & { message: ChannelMessage },
  configuredToken?: string
): ChannelPostResult {
  return projectPublicValue(
    {
      ...result,
      message: projectRelayChannelMessage(result.message, configuredToken),
    },
    configuredToken
  ) as ChannelPostResult;
}

function readErrorBody(
  value: unknown,
  configuredToken?: string
): RelayChannelClientErrorBody {
  const outer = record(value);
  const candidate = record(outer?.['error']) ?? outer;
  if (!candidate) return {};
  const projectedCandidate =
    record(projectPublicValue(candidate, configuredToken)) ?? {};
  const details = record(projectedCandidate['details']);
  return {
    ...(typeof candidate['code'] === 'string'
      ? { code: gatewayErrorCode(candidate['code']) }
      : { code: 'UPSTREAM_ERROR' }),
    ...(typeof projectedCandidate['message'] === 'string'
      ? {
          message: projectedCandidate['message'],
        }
      : {}),
    ...(typeof projectedCandidate['retryable'] === 'boolean'
      ? { retryable: projectedCandidate['retryable'] }
      : {}),
    ...(details
      ? {
          details,
        }
      : {}),
  };
}

function publicTransportError(error: unknown, configuredToken?: string): Error {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(projectPublicValue(message, configuredToken) as string);
}

function trimBaseUrl(value: string): string {
  return value.replace(/\/+$/, '');
}

function defaultBaseUrl(
  env: Readonly<Record<string, string | undefined>>
): string {
  return trimBaseUrl(
    env['RELAY_IDE_URL'] ??
      `http://127.0.0.1:${env['RELAY_IDE_PORT'] ?? '3456'}`
  );
}

function pathWithQuery(
  pathname: string,
  query: Record<string, unknown>
): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== false) search.set(key, String(value));
  }
  return `${pathname}${search.size ? `?${search}` : ''}`;
}

function jsonBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function textBytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

/** Exact JSON byte length without repeatedly serializing retained frames. */
function collectionOutputBytes(
  frameBytes: number,
  state: RelayChannelReducerState,
  durableSeq: number,
  stopReason: ChannelCollectedSubscription['stopReason']
): number {
  // Property order intentionally matches collectionOutput below. State is a
  // generic reducer projection, so its exact current serialization remains the
  // only safe cap authority; retained frames are incrementally accounted for.
  return (
    textBytes('{"frames":') +
    frameBytes +
    textBytes(',"state":') +
    jsonBytes(state) +
    textBytes(',"durableSeq":') +
    jsonBytes(durableSeq) +
    textBytes(',"stopReason":') +
    jsonBytes(stopReason) +
    1
  );
}

function collectionOutput(
  frames: readonly ChannelSubscriptionFrame[],
  state: RelayChannelReducerState,
  durableSeq: number,
  stopReason: ChannelCollectedSubscription['stopReason']
): ChannelCollectedSubscription {
  return { frames: [...frames], state, durableSeq, stopReason };
}

function boundedPositiveInteger(
  value: number | undefined,
  fallback: number,
  name: string
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new RelayChannelClientError(400, {
      code: 'INVALID_ARGUMENT',
      message: `${name} must be a positive safe integer`,
    });
  }
  return resolved;
}

function appendBytes(
  left: Uint8Array<ArrayBufferLike>,
  right: Uint8Array<ArrayBufferLike>
): Uint8Array<ArrayBufferLike> {
  if (left.byteLength === 0) return right;
  if (right.byteLength === 0) return left;
  const joined = new Uint8Array(left.byteLength + right.byteLength);
  joined.set(left);
  joined.set(right, left.byteLength);
  return joined;
}

function isHeartbeat(
  value: unknown
): value is { type: 'channel-heartbeat-v1' } {
  const payload = record(value);
  return (
    payload !== undefined &&
    Object.keys(payload).length === 1 &&
    payload['type'] === 'channel-heartbeat-v1'
  );
}

type InternalSubscriptionFrame = Omit<ChannelSubscriptionFrame, 'payload'> & {
  payload?: ChannelEventV1 | { type: 'channel-heartbeat-v1' };
};

const SUBSCRIPTION_FRAME_COMMON_KEYS = [
  'schemaVersion',
  'frame',
  'channelId',
  'sequence',
  'occurredAt',
  'durableSeq',
] as const;

function hasOnlySubscriptionFrameKeys(
  value: Record<string, unknown>,
  allowed: readonly string[]
): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function hasValidSubscriptionFrameBase(
  frame: Record<string, unknown>,
  expectedChannelId: string
): boolean {
  return (
    frame['schemaVersion'] === 1 &&
    frame['channelId'] === expectedChannelId &&
    typeof frame['sequence'] === 'number' &&
    Number.isSafeInteger(frame['sequence']) &&
    frame['sequence'] >= 0 &&
    typeof frame['occurredAt'] === 'string' &&
    typeof frame['durableSeq'] === 'number' &&
    Number.isSafeInteger(frame['durableSeq']) &&
    frame['durableSeq'] >= 0
  );
}

function eventMatchesSubscriptionChannel(
  event: ChannelEventV1,
  channelId: string
): boolean {
  if (event.channelId !== channelId) return false;
  switch (event.type) {
    case 'channel-snapshot-v1':
      return (
        event.messages.every((message) => message.channelId === channelId) &&
        event.stateReplacements?.every(
          (replacement) => replacement.message.channelId === channelId
        ) !== false &&
        event.runs?.every((run) => run.channelId === channelId) !== false
      );
    case 'channel-message-created-v1':
    case 'channel-message-updated-v1':
    case 'channel-message-completed-v1':
    case 'channel-message-edited-v1':
    case 'channel-message-deleted-v1':
      return event.message.channelId === channelId;
    case 'channel-run-lifecycle-v1':
      return event.run.channelId === channelId;
    case 'channel-message-delta-v1':
    case 'channel-resync-required-v1':
      return true;
  }
}

/** Validate the wire discriminants before reducing or spreading any frame. */
function isSubscriptionFrame(
  value: unknown,
  expectedChannelId: string
): value is InternalSubscriptionFrame {
  const frame = record(value);
  if (!frame || !hasValidSubscriptionFrameBase(frame, expectedChannelId))
    return false;
  if (frame['frame'] === 'open') {
    return hasOnlySubscriptionFrameKeys(frame, SUBSCRIPTION_FRAME_COMMON_KEYS);
  }
  if (frame['frame'] === 'event') {
    if (
      !hasOnlySubscriptionFrameKeys(frame, [
        ...SUBSCRIPTION_FRAME_COMMON_KEYS,
        'payload',
      ]) ||
      !Object.hasOwn(frame, 'payload')
    ) {
      return false;
    }
    const payload = frame['payload'];
    return (
      isHeartbeat(payload) ||
      (isChannelEventV1(payload) &&
        eventMatchesSubscriptionChannel(payload, expectedChannelId))
    );
  }
  if (frame['frame'] !== 'closed') return false;
  return (
    hasOnlySubscriptionFrameKeys(frame, [
      ...SUBSCRIPTION_FRAME_COMMON_KEYS,
      'reason',
      'retryable',
      'latestSeq',
    ]) &&
    typeof frame['reason'] === 'string' &&
    typeof frame['retryable'] === 'boolean' &&
    (frame['latestSeq'] === undefined ||
      (typeof frame['latestSeq'] === 'number' &&
        Number.isSafeInteger(frame['latestSeq']) &&
        frame['latestSeq'] >= 0))
  );
}

export function createRelayChannelClient(
  config: RelayChannelClientConfig = {}
): RelayChannelClient {
  const env = config.env ?? (typeof process === 'undefined' ? {} : process.env);
  const baseUrl = trimBaseUrl(config.baseUrl ?? defaultBaseUrl(env));
  // A browser bearer is accepted by the ordinary HTTP auth lane.  Advertising
  // it as an actor credential would switch server-side scope semantics, so the
  // actor marker is emitted only for a known actor credential/env lane.
  const configuredToken = config.token;
  const configuredActor = configuredToken?.startsWith('relay-sac-v1.')
    ? configuredToken
    : undefined;
  const actorToken = configuredActor ?? env['RELAY_IDE_ACTOR_TOKEN'];
  const browserToken = configuredActor
    ? undefined
    : (configuredToken ?? env['RELAY_IDE_BROWSER_TOKEN']);
  const token = actorToken ?? browserToken;
  const fetcher = config.fetch ?? globalThis.fetch;
  const staticHeaders = new Headers(config.headers);

  const headersFor = (command: string, write = false): Headers => {
    const headers = new Headers(staticHeaders);
    headers.set('accept', 'application/json');
    headers.set('x-relay-cli-gateway', 'v1');
    headers.set('x-relay-cli-command', command);
    headers.set(
      'x-relay-capabilities',
      write ? 'context:write' : 'context:read'
    );
    if (token && !headers.has('authorization'))
      headers.set('authorization', `Bearer ${token}`);
    if (actorToken && !headers.has('x-relay-cli-actor-token'))
      headers.set('x-relay-cli-actor-token', 'v1');
    return headers;
  };

  const request = async <T>(
    command: string,
    pathname: string,
    init: RequestInit = {},
    write = false
  ): Promise<T> => {
    const headers = headersFor(command, write);
    if (init.headers)
      new Headers(init.headers).forEach((value, key) =>
        headers.set(key, value)
      );
    let response: Response;
    try {
      response = await fetcher(`${baseUrl}${pathname}`, { ...init, headers });
    } catch (error) {
      throw publicTransportError(error, token);
    }
    let raw: string;
    try {
      raw = await response.text();
    } catch (error) {
      throw publicTransportError(error, token);
    }
    let parsed: unknown;
    try {
      parsed = raw ? JSON.parse(raw) : undefined;
    } catch {
      parsed = undefined;
    }
    if (!response.ok)
      throw new RelayChannelClientError(
        response.status,
        readErrorBody(parsed, token)
      );
    // Every non-streaming success crosses the same fail-closed recursive
    // boundary.  Do this before typed method projections so list/get/run/roster
    // cannot accidentally become a provider-correlation escape hatch.
    return projectPublicValue(parsed, token) as T;
  };

  const subscribe = async function* (
    input: ChannelSubscribeInput
  ): AsyncGenerator<ChannelSubscriptionUpdate> {
    const {
      channelId,
      afterSeq,
      state: initialState,
      signal,
      maxLineBytes: requestedMaxLineBytes,
      maxStreamBytes: requestedMaxStreamBytes,
      ...filter
    } = input;
    const maxLineBytes = boundedPositiveInteger(
      requestedMaxLineBytes,
      RELAY_CHANNEL_SUBSCRIPTION_MAX_LINE_BYTES,
      'maxLineBytes'
    );
    const maxStreamBytes = boundedPositiveInteger(
      requestedMaxStreamBytes,
      RELAY_CHANNEL_SUBSCRIPTION_MAX_STREAM_BYTES,
      'maxStreamBytes'
    );
    const pathname = pathWithQuery(
      `/channels/${encodeURIComponent(channelId)}/subscribe`,
      {
        afterSeq,
        ...filter,
      }
    );
    const headers = headersFor('channels.subscribe');
    headers.set('accept', 'application/x-ndjson');
    const streamAbort = new AbortController();
    const streamSignal = AbortSignal.any(
      [signal, streamAbort.signal].filter(
        (value): value is AbortSignal => value !== undefined
      )
    );
    let response: Response;
    try {
      response = await fetcher(`${baseUrl}${pathname}`, {
        headers,
        signal: streamSignal,
      });
    } catch (error) {
      if (signal?.aborted || streamAbort.signal.aborted) return;
      throw publicTransportError(error, token);
    }
    if (!response.ok) {
      let raw: string;
      try {
        raw = await response.text();
      } catch (error) {
        throw publicTransportError(error, token);
      }
      let parsed: unknown;
      try {
        parsed = raw ? JSON.parse(raw) : undefined;
      } catch {
        parsed = undefined;
      }
      throw new RelayChannelClientError(
        response.status,
        readErrorBody(parsed, token)
      );
    }
    if (!response.body)
      throw new RelayChannelClientError(502, {
        code: 'UPSTREAM_ERROR',
        retryable: true,
        message: 'Relay subscription response had no body',
      });

    let state = initialState
      ? asInternalReducerState(initialState)
      : initialChannelReducerState(channelId);
    let durableSeq = afterSeq ?? 0;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pendingLine: Uint8Array<ArrayBufferLike> = new Uint8Array();
    let streamBytes = 0;
    const overflow = (
      limit: RelayChannelSubscriptionLimit,
      maximum: number,
      observed: number
    ): never => {
      streamAbort.abort();
      throw new RelayChannelSubscriptionOverflowError(limit, maximum, observed);
    };
    const emit = (
      lineBytes: Uint8Array
    ): ChannelSubscriptionUpdate | undefined => {
      const line = decoder.decode(lineBytes).trim();
      if (!line) return undefined;
      let frame: unknown;
      try {
        frame = JSON.parse(line);
      } catch {
        throw new RelayChannelClientError(502, {
          code: 'UPSTREAM_ERROR',
          retryable: true,
          message: 'Relay subscription emitted invalid NDJSON',
        });
      }
      if (!isSubscriptionFrame(frame, channelId)) {
        throw new RelayChannelClientError(502, {
          code: 'UPSTREAM_ERROR',
          retryable: true,
          message: 'Relay subscription emitted an invalid frame',
        });
      }
      const parsed = frame;
      const publicPayload =
        parsed.frame === 'event' && isChannelEventV1(parsed.payload)
          ? projectChannelEvent(parsed.payload, token)
          : undefined;
      if (publicPayload) {
        // State starts public and receives only the projected event. This keeps
        // provider diagnostics out of reducer state and avoids reprojecting
        // every retained row for each incoming delta.
        state = applyChannelEventV1(
          state,
          publicPayload as unknown as ChannelEventV1
        );
      }
      // durableSeq comes from the authoritative frame, never reducer state.
      durableSeq = Math.max(durableSeq, parsed.durableSeq);
      return {
        frame: {
          ...(projectPublicValue(parsed, token) as Omit<
            ChannelSubscriptionFrame,
            'payload'
          >),
          ...(publicPayload
            ? { payload: publicPayload }
            : parsed.payload
              ? { payload: parsed.payload }
              : {}),
        },
        state: state as unknown as RelayChannelReducerState,
        durableSeq,
      };
    };
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!value) continue;
        streamBytes += value.byteLength;
        if (streamBytes > maxStreamBytes)
          overflow('stream-bytes', maxStreamBytes, streamBytes);
        let start = 0;
        for (let index = 0; index < value.byteLength; index += 1) {
          if (value[index] !== 0x0a) continue;
          const segment = value.subarray(start, index);
          const lineBytes = pendingLine.byteLength + segment.byteLength;
          if (lineBytes > maxLineBytes)
            overflow('line-bytes', maxLineBytes, lineBytes);
          pendingLine = appendBytes(pendingLine, segment);
          const update = emit(pendingLine);
          pendingLine = new Uint8Array();
          if (update) yield update;
          start = index + 1;
        }
        // The final segment has no newline and becomes the bounded carry-over.
        pendingLine = appendBytes(pendingLine, value.subarray(start));
        if (pendingLine.byteLength > maxLineBytes)
          overflow('line-bytes', maxLineBytes, pendingLine.byteLength);
      }
      const update = emit(pendingLine);
      if (update) yield update;
    } catch (error) {
      if (signal?.aborted) return;
      if (error instanceof RelayChannelClientError) throw error;
      throw publicTransportError(error, token);
    } finally {
      streamAbort.abort();
      await reader.cancel().catch(() => undefined);
      await reader.closed.catch(() => undefined);
      reader.releaseLock();
    }
  };

  const collect = async (
    input: ChannelCollectInput
  ): Promise<ChannelCollectedSubscription> => {
    const {
      maxEvents,
      idleTimeoutMs,
      maxOutputBytes: requestedMaxOutputBytes,
      signal,
      ...subscribeInput
    } = input;
    const maxOutputBytes = boundedPositiveInteger(
      requestedMaxOutputBytes,
      RELAY_CHANNEL_SUBSCRIPTION_MAX_COLLECTED_OUTPUT_BYTES,
      'maxOutputBytes'
    );
    const controller = new AbortController();
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let idleTimedOut = false;
    const clearIdleTimer = () => {
      if (idleTimer !== undefined) {
        clearTimeout(idleTimer);
        idleTimer = undefined;
      }
    };
    const resetIdleTimer = () => {
      clearIdleTimer();
      if (idleTimeoutMs === undefined) return;
      idleTimer = setTimeout(() => {
        idleTimedOut = true;
        controller.abort();
      }, idleTimeoutMs);
    };
    const combined = AbortSignal.any(
      [signal, controller.signal].filter(
        (value): value is AbortSignal => value !== undefined
      )
    );
    const frames: ChannelSubscriptionFrame[] = [];
    let state: RelayChannelReducerState =
      subscribeInput.state ??
      projectReducerState(initialChannelReducerState(subscribeInput.channelId));
    let durableSeq = subscribeInput.afterSeq ?? 0;
    let events = 0;
    let serializedFrameBytes = 2; // `[]`
    let stopReason: ChannelCollectedSubscription['stopReason'] =
      'stream-closed';
    resetIdleTimer();
    try {
      for await (const update of subscribe({
        ...subscribeInput,
        signal: combined,
      })) {
        const nextEvents = events + (update.frame.frame === 'event' ? 1 : 0);
        const nextStopReason =
          maxEvents !== undefined && nextEvents >= maxEvents
            ? 'max-events'
            : 'stream-closed';
        const nextSerializedFrameBytes =
          serializedFrameBytes +
          (frames.length === 0 ? 0 : 1) +
          jsonBytes(update.frame);
        // Count the exact object returned to a caller, including wrappers and
        // durable state, without reserializing all previously retained frames.
        const nextOutputBytes = collectionOutputBytes(
          nextSerializedFrameBytes,
          update.state,
          update.durableSeq,
          nextStopReason
        );
        if (nextOutputBytes > maxOutputBytes) {
          controller.abort();
          throw new RelayChannelSubscriptionOverflowError(
            'collected-output-bytes',
            maxOutputBytes,
            nextOutputBytes
          );
        }
        frames.push(update.frame);
        serializedFrameBytes = nextSerializedFrameBytes;
        state = update.state;
        durableSeq = update.durableSeq;
        events = nextEvents;
        if (maxEvents !== undefined && events >= maxEvents) {
          // Max-events is a successful local terminal condition. Clear the
          // timer before aborting so a simultaneous deadline cannot win.
          stopReason = 'max-events';
          clearIdleTimer();
          controller.abort();
          break;
        }
        // Only an accepted update extends the quiet-stream deadline.
        resetIdleTimer();
      }
    } finally {
      clearIdleTimer();
    }
    if (stopReason !== 'max-events') {
      if (idleTimedOut) stopReason = 'idle-timeout';
      else if (signal?.aborted) stopReason = 'aborted';
    }
    return collectionOutput(frames, state, durableSeq, stopReason);
  };

  return {
    list: () => request('channels.list', '/channels'),
    get: ({ channelId }) =>
      request('channels.get', `/channels/${encodeURIComponent(channelId)}`),
    run: {
      get: ({ channelId, runId, threadId }) =>
        request(
          'channels.run.get',
          pathWithQuery(
            `/channels/${encodeURIComponent(channelId)}/runs/${encodeURIComponent(runId)}`,
            { threadId }
          )
        ),
    },
    history: ({ channelId, limit, beforeSeq, afterSeq }) =>
      request<{
        messages: ChannelMessage[];
        hasMore?: boolean;
        nextCursor?: ChannelPage['nextCursor'];
      }>(
        'channels.history',
        pathWithQuery(`/channels/${encodeURIComponent(channelId)}/messages`, {
          limit,
          beforeSeq,
          afterSeq,
        })
      ).then(projectPage),
    threads: {
      history: ({ channelId, threadId, limit, beforeSeq, afterSeq }) =>
        request<{
          messages: ChannelMessage[];
          hasMore?: boolean;
          nextCursor?: ChannelPage['nextCursor'];
        }>(
          'channels.threads.history',
          pathWithQuery(
            `/channels/${encodeURIComponent(channelId)}/threads/${encodeURIComponent(threadId)}`,
            { limit, beforeSeq, afterSeq }
          )
        ).then(projectPage),
    },
    roster: ({ channelId }) =>
      request(
        'channels.roster',
        `/channels/${encodeURIComponent(channelId)}/roster`
      ),
    search: ({ q, channelId, workspaceId, includeArchived, limit }) =>
      request<ChannelMessageSearchResponse>(
        'channels.search',
        pathWithQuery('/channels/search', {
          q,
          channelId,
          workspaceId,
          includeArchived,
          limit,
        })
      ),
    post: ({ channelId, ...body }) =>
      request<Omit<ChannelPostResult, 'message'> & { message: ChannelMessage }>(
        'channels.post',
        `/channels/${encodeURIComponent(channelId)}/messages`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        },
        true
      ).then(projectPostResult),
    subscribe,
    collect,
  };
}
