#!/usr/bin/env node
/* eslint-disable no-console */

import { pathToFileURL } from 'node:url';
import {
  isChannelMessage,
  type ChannelMessage,
} from '../shared/channel-chat-protocol.js';

const DEFAULT_BASE_URL = 'http://127.0.0.1:3456';
const DEFAULT_CAPABILITIES = ['session:read', 'context:read', 'context:write'];
const DEFAULT_POLL_INTERVAL_MS = 2_000;
const HISTORY_LIMIT = 100;
const TOKEN_REFRESH_RATIO = 2 / 3;

export interface PeerConfig {
  baseUrl: string;
  pin: string;
  actorId: string;
  displayName: string;
  role: string;
  productChannelId: string;
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

interface TokenState {
  token: string;
  mintedAt: number;
  expiresAt: number;
}

interface MintResponse {
  token: string;
  credential: {
    issuedAt: string;
    expiresAt: string;
  };
}

interface HistoryResponse {
  messages: ChannelMessage[];
}

export function buildAckText(message: ChannelMessage): string {
  return `orchestrator online — ack seq ${message.seq} from ${message.sender.id}`;
}

export function selectNewMessages(
  messages: ChannelMessage[],
  lastSeq: number,
  selfSenderId: string
): MessageSelection {
  const unseen = messages
    .filter((message) => message.seq > lastSeq)
    .sort((left, right) => left.seq - right.seq);
  let nextSeq = lastSeq;
  const acks: PeerAck[] = [];

  for (const message of unseen) {
    nextSeq = Math.max(nextSeq, message.seq);
    if (message.sender.id === selfSenderId) continue;
    acks.push({ seq: message.seq, text: buildAckText(message) });
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

function cookieFrom(response: Response): string {
  const raw = response.headers.get('set-cookie');
  const cookie = raw?.split(';')[0];
  if (!cookie) throw new Error('POST /auth did not return an auth cookie');
  return cookie;
}

function isMintResponse(value: unknown): value is MintResponse {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  if (
    typeof record['token'] !== 'string' ||
    !record['token'].startsWith('relay-sac-v1.')
  ) {
    return false;
  }
  const credential = record['credential'];
  if (typeof credential !== 'object' || credential === null) return false;
  const credentialRecord = credential as Record<string, unknown>;
  return (
    typeof credentialRecord['issuedAt'] === 'string' &&
    typeof credentialRecord['expiresAt'] === 'string'
  );
}

export class TokenManager {
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;
  private readonly refreshRatio: number;
  private cookie: string | null = null;
  private state: TokenState | null = null;

  constructor(
    private readonly config: Pick<
      PeerConfig,
      'baseUrl' | 'pin' | 'actorId' | 'displayName' | 'capabilities'
    >,
    fetchImpl: FetchLike = globalThis.fetch,
    now: () => number = Date.now,
    refreshRatio = TOKEN_REFRESH_RATIO
  ) {
    this.baseUrl = normalizedBaseUrl(config.baseUrl);
    this.fetchImpl = fetchImpl;
    this.now = now;
    if (
      !Number.isFinite(refreshRatio) ||
      refreshRatio <= 0 ||
      refreshRatio > 1
    ) {
      throw new RangeError('refreshRatio must be greater than 0 and at most 1');
    }
    this.refreshRatio = refreshRatio;
  }

  async getToken(forceRemint = false): Promise<string> {
    const currentNow = this.now();
    if (this.state && !forceRemint) {
      const lifetime = this.state.expiresAt - this.state.mintedAt;
      const elapsed = Math.max(0, currentNow - this.state.mintedAt);
      if (!needsRemint(lifetime, elapsed, this.refreshRatio)) {
        return this.state.token;
      }
    }
    return this.mintToken();
  }

  async gatewayFetch(
    url: string,
    command: string,
    init: RequestInit = {}
  ): Promise<Response> {
    const send = async (token: string): Promise<Response> => {
      const headers = new Headers(init.headers);
      headers.set('authorization', `Bearer ${token}`);
      headers.set('x-relay-cli-gateway', 'v1');
      headers.set('x-relay-cli-command', command);
      return this.fetchImpl(url, { ...init, headers });
    };

    let response = await send(await this.getToken());
    if (response.status === 401) {
      response = await send(await this.getToken(true));
    }
    return response;
  }

  private async authenticate(): Promise<string> {
    const response = await this.fetchImpl(`${this.baseUrl}/auth`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pin: this.config.pin }),
    });
    if (!response.ok) throw await responseError('POST /auth', response);
    return cookieFrom(response);
  }

  private async requestMint(cookie: string): Promise<Response> {
    return this.fetchImpl(`${this.baseUrl}/cli-gateway/actor-credentials`, {
      method: 'POST',
      headers: {
        cookie,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        capabilities: this.config.capabilities,
        actor: {
          type: 'agent',
          id: this.config.actorId,
          displayName: this.config.displayName,
        },
      }),
    });
  }

  private async mintToken(): Promise<string> {
    this.cookie ??= await this.authenticate();
    let response = await this.requestMint(this.cookie);
    if (response.status === 401) {
      this.cookie = await this.authenticate();
      response = await this.requestMint(this.cookie);
    }
    if (!response.ok) {
      throw await responseError(
        'POST /cli-gateway/actor-credentials',
        response
      );
    }

    const payload: unknown = await response.json();
    if (!isMintResponse(payload)) {
      throw new Error('actor credential mint returned an invalid response');
    }
    const issuedAt = Date.parse(payload.credential.issuedAt);
    const expiresAt = Date.parse(payload.credential.expiresAt);
    const lifetime = expiresAt - issuedAt;
    if (!Number.isFinite(lifetime) || lifetime <= 0) {
      throw new Error('actor credential mint returned an invalid lifetime');
    }

    const mintedAt = this.now();
    this.state = {
      token: payload.token,
      mintedAt,
      expiresAt: mintedAt + lifetime,
    };
    return payload.token;
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
  private readonly channelPath: string;
  private readonly tokenManager: TokenManager;
  private cursor = 0;

  constructor(
    private readonly config: PeerConfig,
    fetchImpl: FetchLike = globalThis.fetch,
    now: () => number = Date.now
  ) {
    this.baseUrl = normalizedBaseUrl(config.baseUrl);
    this.channelPath = `/channels/${encodeURIComponent(config.productChannelId)}`;
    this.tokenManager = new TokenManager(config, fetchImpl, now);
  }

  get lastSeq(): number {
    return this.cursor;
  }

  async pollOnce(): Promise<{ ackCount: number; lastSeq: number }> {
    const historyUrl =
      `${this.baseUrl}${this.channelPath}/messages` +
      `?afterSeq=${this.cursor}&limit=${HISTORY_LIMIT}`;
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
      this.cursor,
      `agent:${this.config.actorId}`
    );

    for (const ack of selection.acks) {
      const postResponse = await this.tokenManager.gatewayFetch(
        `${this.baseUrl}${this.channelPath}/messages`,
        'channels.post',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text: ack.text }),
        }
      );
      if (!postResponse.ok) {
        throw await responseError(
          `channels.post ack for seq ${ack.seq}`,
          postResponse
        );
      }
    }

    this.cursor = selection.nextSeq;
    return { ackCount: selection.acks.length, lastSeq: this.cursor };
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
  const pin = argValue(argv, '--pin') ?? env['RELAY_PEER_PIN'];
  const productChannelId =
    argValue(argv, '--channel') ?? env['RELAY_PEER_CHANNEL_ID'];
  if (!pin || !productChannelId) {
    throw new Error(
      'PIN and channel are required via --pin/--channel or RELAY_PEER_PIN/RELAY_PEER_CHANNEL_ID'
    );
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

  return {
    baseUrl:
      argValue(argv, '--base-url') ??
      env['RELAY_PEER_BASE_URL'] ??
      env['RELAY_IDE_URL'] ??
      DEFAULT_BASE_URL,
    pin,
    actorId,
    displayName:
      argValue(argv, '--display-name') ??
      env['RELAY_PEER_DISPLAY_NAME'] ??
      actorId,
    role: env['RELAY_PEER_ROLE'] ?? 'orchestrator',
    productChannelId,
    capabilities:
      capabilities && capabilities.length
        ? capabilities
        : [...DEFAULT_CAPABILITIES],
    renewable: true,
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
      `orchestrator peer ${config.actorId} polling ${config.productChannelId}`
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
