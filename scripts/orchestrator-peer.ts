#!/usr/bin/env node
/* eslint-disable no-console */

import { pathToFileURL } from 'node:url';
import {
  isChannelDeliveryReceipt,
  isChannelMessage,
  type ChannelDeliveryReceiptState,
  type ChannelDeliveryReceiptV1,
  type ChannelMessage,
} from '../shared/channel-chat-protocol.js';
import { redactBootstrapSecrets } from '../shared/bootstrap-diagnostics.js';

const DEFAULT_BASE_URL = 'http://127.0.0.1:3456';
// Context read/write cover the channel verbs the peer drives. Its pre-minted
// lease may be server-scoped, but this peer does not declare or enforce scope.
const DEFAULT_CAPABILITIES = ['session:read', 'context:read', 'context:write'];
const DEFAULT_POLL_INTERVAL_MS = 2_000;
const HISTORY_LIMIT = 100;
const GATEWAY_REQUEST_TIMEOUT_MS = 10_000;
const MAX_SAFE_ERROR_DETAIL_CHARS = 512;
const MAX_RESPONSE_BODY_CHARS = 2_048;
const LOOPBACK_HOSTS = new Set(['localhost', '::1', '[::1]']);
const IPV4_LOOPBACK_HOST = /^127(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

export interface PeerConfig {
  baseUrl: string;
  /**
   * Pre-minted short-lived scoped-actor lease (`relay-sac-v1.` token).
   *
   * The daily-driver PIN/cookie must NEVER be used here: this peer is
   * migration-only until the operator-handshake-grant redemption path lands
   * (MCP bridge design). The token is supplied out-of-band via
   * `RELAY_IDE_ACTOR_TOKEN` and never appears in argv, logs, or artifacts.
   */
  actorToken: string;
  actorId: string;
  displayName: string;
  role: string;
  productChannelId: string;
  implChannelId: string;
  workerFramework: string;
  capabilities: string[];
  renewable: boolean;
  budget?: { maxTurns?: number; maxTokens?: number };
  pollIntervalMs: number;
}

export type FetchLike = (
  input: string | URL,
  init?: RequestInit
) => Promise<Response>;

export interface PeerAck {
  seq: number;
  text: string;
}

export interface MessageSelection {
  acks: PeerAck[];
  nextSeq: number;
}

interface PostedDeliveryRef {
  messageId: string;
  channelId: string;
}

interface RelaySelection extends MessageSelection {
  deliveries: PostedDeliveryRef[];
}

interface HistoryResponse {
  messages: ChannelMessage[];
}

export function buildAckText(message: ChannelMessage): string {
  return `orchestrator online — ack seq ${message.seq} from ${message.sender.id}`;
}

export function buildInstruction(message: ChannelMessage): string {
  return `instruction (relayed from product): ${message.body.text}`;
}

export function buildWorkerMention(
  framework: string,
  message: ChannelMessage
): string {
  return `@${framework} ${message.body.text}`;
}

export function buildRollup(message: ChannelMessage): string {
  return `rollup (from impl): ${message.body.text}`;
}

// ── typed delivery receipts (#1442) ──────────────────────────────────────────
//
// Capability detection, not version sniffing: a hub that serves the additive
// `channels.receipts` route is queried for typed receipts for the messages the
// peer just relayed; an older hub answers 404 and the peer silently falls back
// to its existing ack-text parsing. Receipts only annotate delivery outcomes —
// they never replace message relaying.

/** Terminal receipt states the peer does not need to re-query. */
export const SETTLED_RECEIPT_STATES = new Set<ChannelDeliveryReceiptState>([
  'completed',
  'dropped_queue_full',
  'refused_policy',
  'unreachable_offline',
  'expired_watchdog',
  'failed_runtime',
  'superseded',
]);

/**
 * Parse one `channels.receipts` response. Additive and defensive: any shape
 * the validator refuses (including one smuggling a text field past a buggy
 * server) degrades to "no typed receipts" rather than poisoning the run.
 */
export function parseReceiptsResponse(
  value: unknown
): ChannelDeliveryReceiptV1[] | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = (value as Record<string, unknown>)['receipts'];
  if (!Array.isArray(raw)) return null;
  const receipts: ChannelDeliveryReceiptV1[] = [];
  for (const entry of raw) {
    if (!isChannelDeliveryReceipt(entry)) return null;
    receipts.push(entry);
  }
  return receipts;
}

export function latestStateForMessage(
  receipts: ChannelDeliveryReceiptV1[],
  messageId: string
): ChannelDeliveryReceiptState | undefined {
  // The ring returns newest-first; the first hit is the current state.
  return receipts.find((receipt) => receipt.messageId === messageId)?.state;
}

export function isSettledReceiptState(
  state: ChannelDeliveryReceiptState
): boolean {
  return SETTLED_RECEIPT_STATES.has(state);
}

export function selectNewMessages(
  messages: ChannelMessage[],
  lastSeq: number,
  selfSenderId: string,
  buildText: (message: ChannelMessage) => string = buildAckText
): MessageSelection {
  const unseen = messages
    .filter((message) => message.seq > lastSeq)
    .sort((left, right) => left.seq - right.seq);
  let nextSeq = lastSeq;
  const acks: PeerAck[] = [];

  for (const message of unseen) {
    // The peer's own posts are written complete; skip + advance past them.
    if (message.sender.id === selfSenderId) {
      nextSeq = Math.max(nextSeq, message.seq);
      continue;
    }
    // A still-streaming message has no finalized text yet (a live worker reply
    // begins empty and fills in). Relaying it now would carry empty/partial
    // content AND advance the cursor past it, so the finalized text is never
    // relayed. HOLD the cursor before it — re-read next poll — so it is relayed
    // exactly once, when complete. A stale stream is not a permanent hold: the
    // bridge finalizes an open row (truncated/failed) on turn-complete, error,
    // idle, or session-end. Caveat: this break blocks any HIGHER-seq message
    // behind an earlier streaming one. With the current one-worker-per-impl
    // relay that's a single stream at a time (fine); if a future slice runs
    // concurrent cross-sender streams in one channel, an earlier open stream can
    // briefly head-of-line-block a later finished one (bounded, no data loss).
    if (message.status === 'streaming') break;
    nextSeq = Math.max(nextSeq, message.seq);
    // Relay only messages that carry final content. 'complete'/'truncated' have
    // finalized text; 'interrupted'/'failed' are terminal with no useful reply —
    // advance past them without relaying.
    if (message.status === 'complete' || message.status === 'truncated') {
      acks.push({ seq: message.seq, text: buildText(message) });
    }
  }

  return { acks, nextSeq };
}

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return LOOPBACK_HOSTS.has(normalized) || IPV4_LOOPBACK_HOST.test(normalized);
}

/**
 * This peer sends its bearer lease on every request. Accept only a local HTTP
 * hub or an HTTPS hub, and reject URL forms that can smuggle credentials into
 * an error, proxy log, or different authority.
 */
export function validatePeerBaseUrl(baseUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error('baseUrl must be an absolute HTTP(S) URL');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('baseUrl must use HTTP(S)');
  }
  if (!parsed.hostname) {
    throw new Error('baseUrl must include a host');
  }
  if (parsed.username || parsed.password) {
    throw new Error('baseUrl must not include URL credentials');
  }
  if (parsed.search || parsed.hash) {
    throw new Error('baseUrl must not include a query or fragment');
  }
  if (parsed.protocol === 'http:' && !isLoopbackHost(parsed.hostname)) {
    throw new Error('baseUrl must use HTTPS unless its host is loopback');
  }

  return parsed.toString().replace(/\/+$/, '');
}

/** Redact and bound server-controlled text before it reaches stderr. */
export function redactPeerText(value: unknown, actorToken?: string): string {
  let text: string;
  try {
    text = typeof value === 'string' ? value : String(value);
  } catch {
    text = 'unprintable error';
  }
  // The shared redactor covers standard bearer/header/JSON forms. The peer
  // also accepts deliberately short test/migration lease shapes, so scrub any
  // relay SAC prefix and the exact configured token as backstops.
  const redacted = redactBootstrapSecrets(text)
    .replace(/\brelay-sac-v1\.[A-Za-z0-9._~+/=-]+\b/g, 'relay-sac-v1.…redacted')
    .replace(/(Bearer\s+)[^\s"',;)}\]]+/gi, '$1…redacted');
  const withConfiguredToken = actorToken
    ? redacted.replaceAll(actorToken, 'relay-sac-v1.…redacted')
    : redacted;
  return withConfiguredToken.length > MAX_SAFE_ERROR_DETAIL_CHARS
    ? `${withConfiguredToken.slice(0, MAX_SAFE_ERROR_DETAIL_CHARS)}…[truncated]`
    : withConfiguredToken;
}

export function safePeerErrorMessage(
  error: unknown,
  actorToken?: string
): string {
  return redactPeerText(
    error instanceof Error ? error.message : error,
    actorToken
  );
}

async function readCappedResponseText(response: Response): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let truncated = false;
  try {
    while (text.length <= MAX_RESPONSE_BODY_CHARS) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    if (text.length > MAX_RESPONSE_BODY_CHARS) {
      text = text.slice(0, MAX_RESPONSE_BODY_CHARS);
      truncated = true;
      await reader.cancel();
    }
    text += decoder.decode();
  } finally {
    reader.releaseLock();
  }
  return truncated ? `${text}…[response truncated]` : text;
}

async function responseError(
  label: string,
  response: Response,
  actorToken?: string
): Promise<Error> {
  const detail = redactPeerText(
    (await readCappedResponseText(response)).trim(),
    actorToken
  );
  return new Error(
    `${label} failed (${response.status})${detail ? `: ${detail}` : ''}`
  );
}

export class TokenManager {
  private readonly baseUrl: string;
  private readonly baseOrigin: string;
  private readonly fetchImpl: FetchLike;
  private readonly responseTimeouts = new WeakMap<Response, () => void>();

  constructor(
    private readonly config: Pick<
      PeerConfig,
      'baseUrl' | 'actorToken' | 'actorId' | 'displayName' | 'capabilities'
    >,
    fetchImpl: FetchLike = globalThis.fetch
  ) {
    this.baseUrl = validatePeerBaseUrl(config.baseUrl);
    this.baseOrigin = new URL(this.baseUrl).origin;
    this.fetchImpl = fetchImpl;
    if (!config.actorToken.startsWith('relay-sac-v1.')) {
      throw new Error('actorToken must be a pre-minted relay-sac-v1 lease');
    }
  }

  /**
   * The pre-minted scoped-actor lease is used directly. There is deliberately
   * NO remint path: refreshing would require the daily-driver PIN/cookie, which
   * must never enter this peer. An expired lease surfaces as gateway 401s and
   * the operator re-provisions a fresh lease out-of-band.
   */
  getToken(): Promise<string> {
    return Promise.resolve(this.config.actorToken);
  }

  releaseGatewayResponse(response: Response): void {
    this.responseTimeouts.get(response)?.();
  }

  async gatewayFetch(
    url: string,
    command: string,
    init: RequestInit = {}
  ): Promise<Response> {
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      throw new Error('gateway request URL must be absolute');
    }
    // Never let this bearer-carrying helper become an open proxy. History does
    // legitimately use `afterSeq` and `limit`, so reject credential-like query
    // fields rather than rejecting that required cursor query wholesale.
    if (target.username || target.password || target.hash) {
      throw new Error(
        'gateway request URL must not include credentials or a fragment'
      );
    }
    for (const [name, value] of target.searchParams) {
      if (
        /(?:token|secret|password|cookie|authorization|credential|grant|pin|key)/i.test(
          name
        ) ||
        value === this.config.actorToken ||
        /\brelay-sac-v1\./.test(value)
      ) {
        throw new Error(
          'gateway request URL must not include credential material'
        );
      }
    }
    if (target.origin !== this.baseOrigin) {
      throw new Error(
        'gateway request URL must use the configured base origin'
      );
    }
    const headers = new Headers(init.headers);
    headers.set('authorization', `Bearer ${this.config.actorToken}`);
    headers.set('x-relay-cli-gateway', 'v1');
    headers.set('x-relay-cli-command', command);
    // A same-origin endpoint must not be able to bounce this bearer to a
    // different authority through a followed redirect.
    const timeoutController = new AbortController();
    const timeout = setTimeout(() => {
      timeoutController.abort(
        new DOMException('gateway request timed out', 'TimeoutError')
      );
    }, GATEWAY_REQUEST_TIMEOUT_MS);
    timeout.unref();
    const signal = init.signal
      ? AbortSignal.any([init.signal, timeoutController.signal])
      : timeoutController.signal;
    const abortError = (): unknown =>
      signal.reason ??
      new DOMException('gateway request aborted', 'AbortError');

    if (signal.aborted) {
      clearTimeout(timeout);
      throw abortError();
    }

    let rejectOnAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectOnAbort = () => reject(abortError());
      signal.addEventListener('abort', rejectOnAbort, { once: true });
    });
    try {
      const response = await Promise.race([
        this.fetchImpl(url, { ...init, headers, redirect: 'error', signal }),
        aborted,
      ]);
      const release = (): void => {
        clearTimeout(timeout);
        this.responseTimeouts.delete(response);
      };
      if (response.body) {
        this.responseTimeouts.set(response, release);
      } else {
        release();
      }
      return response;
    } catch (error) {
      clearTimeout(timeout);
      throw error;
    } finally {
      if (rejectOnAbort) {
        signal.removeEventListener('abort', rejectOnAbort);
      }
    }
  }
}

function parseHistoryResponse(value: unknown): HistoryResponse {
  if (typeof value !== 'object' || value === null) {
    throw new Error('channels.history returned an invalid response');
  }
  const messages = (value as Record<string, unknown>)['messages'];
  if (!Array.isArray(messages) || !messages.every(isChannelMessage)) {
    throw new Error('channels.history returned invalid messages');
  }
  return { messages };
}

export function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    const timeout = setTimeout(finish, ms);
    signal.addEventListener('abort', finish, { once: true });
    if (signal.aborted) finish();
  });
}

export class OrchestratorPeer {
  private readonly baseUrl: string;
  private readonly productChannelPath: string;
  private readonly implChannelPath: string;
  private readonly tokenManager: TokenManager;
  private productCursor = 0;
  private implCursor = 0;
  /**
   * Capability detection cache (#1442): null = not yet probed; true/false =
   * whether the hub serves the additive `channels.receipts` route. A probe
   * never fails the run — an older hub just keeps the ack-text fallback.
   */
  private receiptsSupported: boolean | null = null;

  constructor(
    private readonly config: PeerConfig,
    fetchImpl: FetchLike = globalThis.fetch
  ) {
    this.baseUrl = validatePeerBaseUrl(config.baseUrl);
    this.productChannelPath = `/channels/${encodeURIComponent(config.productChannelId)}`;
    this.implChannelPath = `/channels/${encodeURIComponent(config.implChannelId)}`;
    this.tokenManager = new TokenManager(config, fetchImpl);
  }

  get productLastSeq(): number {
    return this.productCursor;
  }

  get implLastSeq(): number {
    return this.implCursor;
  }

  get supportsDeliveryReceipts(): boolean | null {
    return this.receiptsSupported;
  }

  /**
   * Query typed delivery receipts for one channel's recent messages (#1442).
   * Returns null when the hub does not support the route (404) or answers
   * with a malformed payload — both mean "fall back to ack-text parsing".
   */
  async fetchReceipts(
    channelId: string
  ): Promise<ChannelDeliveryReceiptV1[] | null> {
    const receiptsUrl =
      `${this.baseUrl}/channels/${encodeURIComponent(channelId)}` +
      `/receipts?limit=50`;
    const response = await this.tokenManager.gatewayFetch(
      receiptsUrl,
      'channels.receipts'
    );
    if (!response.ok) {
      try {
        // 404 = older hub without the additive route: capability absent.
        if (response.status === 404) {
          if (this.receiptsSupported === null) this.receiptsSupported = false;
          return null;
        }
        throw await responseError(
          'channels.receipts',
          response,
          this.config.actorToken
        );
      } finally {
        this.tokenManager.releaseGatewayResponse(response);
      }
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } finally {
      this.tokenManager.releaseGatewayResponse(response);
    }
    const parsed = parseReceiptsResponse(payload);
    if (parsed !== null && this.receiptsSupported === null) {
      this.receiptsSupported = true;
    }
    return parsed;
  }

  private async relayChannel(
    sourceChannelPath: string,
    targetChannelPath: string,
    cursor: number,
    buildText: (message: ChannelMessage) => string,
    relayKind: 'instruction' | 'rollup'
  ): Promise<RelaySelection> {
    const historyUrl =
      `${this.baseUrl}${sourceChannelPath}/messages` +
      `?afterSeq=${cursor}&limit=${HISTORY_LIMIT}`;
    const historyResponse = await this.tokenManager.gatewayFetch(
      historyUrl,
      'channels.history'
    );
    if (!historyResponse.ok) {
      try {
        throw await responseError(
          'channels.history',
          historyResponse,
          this.config.actorToken
        );
      } finally {
        this.tokenManager.releaseGatewayResponse(historyResponse);
      }
    }
    let historyPayload: unknown;
    try {
      historyPayload = await historyResponse.json();
    } finally {
      this.tokenManager.releaseGatewayResponse(historyResponse);
    }
    const history = parseHistoryResponse(historyPayload);
    const selection = selectNewMessages(
      history.messages,
      cursor,
      `agent:${this.config.actorId}`,
      buildText
    );

    const deliveries: PostedDeliveryRef[] = [];
    for (const ack of selection.acks) {
      const postResponse = await this.tokenManager.gatewayFetch(
        `${this.baseUrl}${targetChannelPath}/messages`,
        'channels.post',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text: ack.text }),
        }
      );
      if (!postResponse.ok) {
        try {
          throw await responseError(
            `channels.post ${relayKind} for seq ${ack.seq}`,
            postResponse,
            this.config.actorToken
          );
        } finally {
          this.tokenManager.releaseGatewayResponse(postResponse);
        }
      }
      // Posting remains successful even if an older/non-conforming hub omits
      // the returned message. Receipt correlation is then unavailable, but the
      // existing text relay behavior is unchanged.
      let postPayload: unknown = null;
      try {
        postPayload = await postResponse.json();
      } catch {
        // Deliberately ignored: receipt observability is additive.
      } finally {
        this.tokenManager.releaseGatewayResponse(postResponse);
      }
      if (typeof postPayload !== 'object' || postPayload === null) continue;
      const posted = (postPayload as Record<string, unknown>)['message'];
      if (!isChannelMessage(posted)) continue;
      deliveries.push({ messageId: posted.id, channelId: posted.channelId });
    }

    return { ...selection, deliveries };
  }

  async pollOnce(): Promise<{
    instructionCount: number;
    rollupCount: number;
    productLastSeq: number;
    implLastSeq: number;
    /** Typed receipt states for the just-relayed messages, when available. */
    deliveryStates: Record<string, ChannelDeliveryReceiptState>;
  }> {
    const productSelection = await this.relayChannel(
      this.productChannelPath,
      this.implChannelPath,
      this.productCursor,
      (message) => buildWorkerMention(this.config.workerFramework, message),
      'instruction'
    );
    this.productCursor = productSelection.nextSeq;

    const implSelection = await this.relayChannel(
      this.implChannelPath,
      this.productChannelPath,
      this.implCursor,
      buildRollup,
      'rollup'
    );
    this.implCursor = implSelection.nextSeq;

    const postedDeliveries = [
      ...productSelection.deliveries,
      ...implSelection.deliveries,
    ];
    const deliveryStates =
      postedDeliveries.length > 0 && this.receiptsSupported !== false
        ? await this.collectDeliveryStates(postedDeliveries)
        : {};

    return {
      instructionCount: productSelection.acks.length,
      rollupCount: implSelection.acks.length,
      productLastSeq: this.productCursor,
      implLastSeq: this.implCursor,
      deliveryStates,
    };
  }

  // Typed receipts when the hub supports the route (#1442). The query is
  // best-effort: any failure here degrades to the ack-text fallback rather
  // than failing a poll that already relayed its messages successfully.
  private async collectDeliveryStates(
    postedDeliveries: ReadonlyArray<{
      channelId: string;
      messageId: string;
    }>
  ): Promise<Record<string, ChannelDeliveryReceiptState>> {
    const deliveryStates: Record<string, ChannelDeliveryReceiptState> = {};
    try {
      const channelIds = new Set(
        postedDeliveries.map((delivery) => delivery.channelId)
      );
      for (const channelId of channelIds) {
        const receipts = await this.fetchReceipts(channelId);
        if (!receipts) continue;
        for (const delivery of postedDeliveries) {
          if (delivery.channelId !== channelId) continue;
          const state = latestStateForMessage(receipts, delivery.messageId);
          if (state !== undefined) deliveryStates[delivery.messageId] = state;
        }
      }
    } catch {
      // Receipt observability must never break the relay loop.
    }
    return deliveryStates;
  }

  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      await this.pollOnce();
      await abortableDelay(this.config.pollIntervalMs, signal);
    }
  }
}

function argValue(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}

function positiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`expected a positive integer, received ${value}`);
  }
  return parsed;
}

export function readPeerConfig(
  env: NodeJS.ProcessEnv = process.env,
  argv: string[] = process.argv.slice(2)
): PeerConfig {
  // Pre-minted short-lived scoped-actor lease (see PeerConfig.actorToken).
  // The daily-driver PIN/cookie is explicitly FORBIDDEN here — this peer is
  // migration-only until the operator-handshake-grant path lands.
  const actorToken = env['RELAY_IDE_ACTOR_TOKEN'];
  const productChannelId =
    argValue(argv, '--channel') ?? env['RELAY_PEER_CHANNEL_ID'];
  const implChannelId =
    argValue(argv, '--impl-channel') ?? env['RELAY_PEER_IMPL_CHANNEL_ID'];
  if (!actorToken || !productChannelId || !implChannelId) {
    throw new Error(
      'actor token, product channel, and impl channel are required via RELAY_IDE_ACTOR_TOKEN and --channel/--impl-channel or RELAY_PEER_CHANNEL_ID/RELAY_PEER_IMPL_CHANNEL_ID'
    );
  }
  if (!actorToken.startsWith('relay-sac-v1.')) {
    throw new Error('actorToken must be a pre-minted relay-sac-v1 lease');
  }

  const actorId =
    argValue(argv, '--actor-id') ??
    env['RELAY_PEER_ACTOR_ID'] ??
    'orchestrator-peer-v0';
  const capabilities = (
    argValue(argv, '--capabilities') ?? env['RELAY_PEER_CAPABILITIES']
  )
    ?.split(',')
    .map((capability) => capability.trim())
    .filter(Boolean);

  const baseUrl = validatePeerBaseUrl(
    argValue(argv, '--base-url') ??
      env['RELAY_PEER_BASE_URL'] ??
      env['RELAY_IDE_URL'] ??
      DEFAULT_BASE_URL
  );

  return {
    baseUrl,
    actorToken,
    actorId,
    displayName:
      argValue(argv, '--display-name') ??
      env['RELAY_PEER_DISPLAY_NAME'] ??
      actorId,
    role: env['RELAY_PEER_ROLE'] ?? 'orchestrator',
    productChannelId,
    implChannelId,
    workerFramework:
      argValue(argv, '--worker-framework') ??
      env['RELAY_PEER_WORKER_FRAMEWORK'] ??
      'codex',
    capabilities:
      capabilities && capabilities.length
        ? capabilities
        : [...DEFAULT_CAPABILITIES],
    renewable: false,
    pollIntervalMs: positiveInteger(
      argValue(argv, '--poll-interval-ms') ??
        env['RELAY_PEER_POLL_INTERVAL_MS'],
      DEFAULT_POLL_INTERVAL_MS
    ),
  };
}

export async function main(): Promise<void> {
  const config = readPeerConfig();
  const controller = new AbortController();
  const stop = (): void => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  try {
    console.log(
      `orchestrator peer ${config.actorId} polling ${config.productChannelId} and ${config.implChannelId}`
    );
    await new OrchestratorPeer(config).run(controller.signal);
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  void main().catch((error: unknown) => {
    console.error(safePeerErrorMessage(error));
    process.exitCode = 1;
  });
}
