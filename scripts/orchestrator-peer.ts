#!/usr/bin/env node
/* eslint-disable no-console */

import { pathToFileURL } from 'node:url';
import {
  isChannelMessage,
  type ChannelMessage,
} from '../shared/channel-chat-protocol.js';

const DEFAULT_BASE_URL = 'http://127.0.0.1:3456';
// Channel-scope is required for the bridge; context:read/write cover the channel
// read/write verbs the peer drives. A pre-minted lease must be minted WITH these
// capabilities and the peer's channel scope — it is never re-minted here.
const DEFAULT_CAPABILITIES = ['session:read', 'context:read', 'context:write'];
const DEFAULT_POLL_INTERVAL_MS = 2_000;
const HISTORY_LIMIT = 100;
const TOKEN_REFRESH_RATIO = 2 / 3;

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
  scope?: unknown;
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

/**
 * Tests a token lifetime on a clock whose zero is the token's issue time.
 * TokenManager shifts its absolute clock to that origin before calling here.
 */
export function needsRemint(
  expiresAt: number,
  now: number,
  refreshRatio: number
): boolean {
  if (!Number.isFinite(expiresAt) || expiresAt <= 0 || !Number.isFinite(now)) {
    return true;
  }
  if (!Number.isFinite(refreshRatio) || refreshRatio <= 0 || refreshRatio > 1) {
    throw new RangeError('refreshRatio must be greater than 0 and at most 1');
  }
  return now >= expiresAt * refreshRatio;
}

function normalizedBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

async function responseError(
  label: string,
  response: Response
): Promise<Error> {
  const detail = (await response.text()).trim();
  return new Error(
    `${label} failed (${response.status})${detail ? `: ${detail}` : ''}`
  );
}

export class TokenManager {
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;

  constructor(
    private readonly config: Pick<
      PeerConfig,
      'baseUrl' | 'actorToken' | 'actorId' | 'displayName' | 'capabilities'
    >,
    fetchImpl: FetchLike = globalThis.fetch,
    // Kept for API compatibility; a pre-minted lease is used as-is and never
    // re-minted through a PIN/cookie login.
    _now: () => number = Date.now,
    _refreshRatio = TOKEN_REFRESH_RATIO
  ) {
    this.baseUrl = normalizedBaseUrl(config.baseUrl);
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

  async gatewayFetch(
    url: string,
    command: string,
    init: RequestInit = {}
  ): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set('authorization', `Bearer ${this.config.actorToken}`);
    headers.set('x-relay-cli-gateway', 'v1');
    headers.set('x-relay-cli-command', command);
    return this.fetchImpl(url, { ...init, headers });
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

  constructor(
    private readonly config: PeerConfig,
    fetchImpl: FetchLike = globalThis.fetch,
    now: () => number = Date.now
  ) {
    this.baseUrl = normalizedBaseUrl(config.baseUrl);
    this.productChannelPath = `/channels/${encodeURIComponent(config.productChannelId)}`;
    this.implChannelPath = `/channels/${encodeURIComponent(config.implChannelId)}`;
    this.tokenManager = new TokenManager(config, fetchImpl, now);
  }

  get productLastSeq(): number {
    return this.productCursor;
  }

  get implLastSeq(): number {
    return this.implCursor;
  }

  private async relayChannel(
    sourceChannelPath: string,
    targetChannelPath: string,
    cursor: number,
    buildText: (message: ChannelMessage) => string,
    relayKind: 'instruction' | 'rollup'
  ): Promise<MessageSelection> {
    const historyUrl =
      `${this.baseUrl}${sourceChannelPath}/messages` +
      `?afterSeq=${cursor}&limit=${HISTORY_LIMIT}`;
    const historyResponse = await this.tokenManager.gatewayFetch(
      historyUrl,
      'channels.history'
    );
    if (!historyResponse.ok) {
      throw await responseError('channels.history', historyResponse);
    }
    const history = parseHistoryResponse(await historyResponse.json());
    const selection = selectNewMessages(
      history.messages,
      cursor,
      `agent:${this.config.actorId}`,
      buildText
    );

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
        throw await responseError(
          `channels.post ${relayKind} for seq ${ack.seq}`,
          postResponse
        );
      }
    }

    return selection;
  }

  async pollOnce(): Promise<{
    instructionCount: number;
    rollupCount: number;
    productLastSeq: number;
    implLastSeq: number;
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

    return {
      instructionCount: productSelection.acks.length,
      rollupCount: implSelection.acks.length,
      productLastSeq: this.productCursor,
      implLastSeq: this.implCursor,
    };
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

  const scope =
    typeof env['RELAY_PEER_SCOPE'] === 'string' &&
    env['RELAY_PEER_SCOPE'].length > 0
      ? JSON.parse(env['RELAY_PEER_SCOPE'])
      : { channelIds: [productChannelId, implChannelId] };

  return {
    baseUrl:
      argValue(argv, '--base-url') ??
      env['RELAY_PEER_BASE_URL'] ??
      env['RELAY_IDE_URL'] ??
      DEFAULT_BASE_URL,
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
    scope,
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
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
