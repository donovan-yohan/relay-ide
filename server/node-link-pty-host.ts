import { Buffer } from 'node:buffer';
import type { Logger } from './logger.js';
import { createLogger } from './logger.js';
import type { RelayNodeEnvelope } from '../shared/relay-node-protocol.js';
import type {
  SessionAttachment,
  SessionAttachmentFactory,
  SessionAttachmentMode,
} from './session-attachment.js';
import {
  createRawAttachmentFactory,
  createTmuxAttachmentFactory,
} from './session-attachment.js';
import type { NodeSessionResumeKind } from '../shared/node-manifest.js';

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
const SCROLLBACK_BYTE_LIMIT = 256 * 1024;

export interface NodeLinkPtyAttachInput {
  sessionId?: unknown;
  command?: unknown;
  args?: unknown;
  cols?: unknown;
  rows?: unknown;
  cwd?: unknown;
  env?: unknown;
}

export interface NodeLinkPtyHostDeps {
  /**
   * #467: pluggable attachment backend. Defaults derived from
   * `sessionResume`: 'tmux' -> TmuxAttachment, anything else -> raw.
   * Tests inject `MockAttachmentFactory` directly to avoid spawning
   * processes or tmux.
   */
  attachmentFactory?: SessionAttachmentFactory;
  defaultShell?: string;
  defaultCwd?: string;
  defaultEnv?: NodeJS.ProcessEnv;
  logger?: Logger;
  /**
   * Resume capability the manifest advertises. Determines which
   * factory is constructed when `attachmentFactory` is not supplied.
   * Hosts without tmux (or with `sessionResume: 'none'`) fall back to
   * a raw shell that dies on detach. 'canonical-emulator' is treated
   * as 'raw' in phase 1; #469 will replace this dispatch.
   */
  sessionResume?: NodeSessionResumeKind;
}

export interface NodeLinkPtyHostContext {
  send: (envelope: RelayNodeEnvelope) => void;
  buildEnvelope: (
    channel: RelayNodeEnvelope['channel'],
    type: string,
    extras?: Partial<RelayNodeEnvelope>
  ) => RelayNodeEnvelope;
}

export interface NodeLinkPtyHost {
  handle(envelope: RelayNodeEnvelope, ctx: NodeLinkPtyHostContext): void;
  closeAll(reason?: string): Promise<void>;
  readonly mode: SessionAttachmentMode;
}

interface ActiveStream {
  streamId: string;
  sessionId: string;
  attachment: SessionAttachment;
  scrollback: Buffer[];
  scrollbackBytes: number;
  closing: boolean;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function asPositiveInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
    ? value
    : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') return undefined;
    out.push(item);
  }
  return out;
}

const UNSAFE_ENV_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function asEnv(value: unknown): NodeJS.ProcessEnv | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const out = Object.create(null) as NodeJS.ProcessEnv;
  for (const [k, v] of Object.entries(value)) {
    if (UNSAFE_ENV_KEYS.has(k)) continue;
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}

function defaultLoginShell(): string {
  return process.env['SHELL'] || '/bin/sh';
}

function sanitizeEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next = Object.create(null) as NodeJS.ProcessEnv;
  for (const [k, v] of Object.entries(base)) {
    if (UNSAFE_ENV_KEYS.has(k)) continue;
    if (k === 'CLAUDECODE') continue;
    if (typeof v === 'string') next[k] = v;
  }
  return next;
}

export interface NodeLinkPtyHostOptions extends NodeLinkPtyHostDeps {
  nodeId: string;
}

function resolveFactory(opts: NodeLinkPtyHostDeps): SessionAttachmentFactory {
  if (opts.attachmentFactory) return opts.attachmentFactory;
  if (opts.sessionResume === 'tmux') return createTmuxAttachmentFactory();
  return createRawAttachmentFactory();
}

export function createNodeLinkPtyHost(
  options: NodeLinkPtyHostOptions
): NodeLinkPtyHost {
  const logger = options.logger ?? createLogger('node-link-pty');
  const factory = resolveFactory(options);
  const defaultShell = options.defaultShell ?? defaultLoginShell();
  const defaultCwd = options.defaultCwd ?? process.cwd();
  const defaultEnv = options.defaultEnv ?? process.env;
  const streams = new Map<string, ActiveStream>();
  const opening = new Set<string>();
  let currentCtx: NodeLinkPtyHostContext | undefined;
  let closed = false;

  function sendData(streamId: string, data: string): void {
    if (!currentCtx) return;
    currentCtx.send(
      currentCtx.buildEnvelope('pty', 'pty.data', {
        streamId,
        payload: { data },
      })
    );
  }

  function sendExit(streamId: string, exitCode: number, signal?: number): void {
    if (!currentCtx) return;
    currentCtx.send(
      currentCtx.buildEnvelope('pty', 'pty.exit', {
        streamId,
        payload: { exitCode, signal: signal ?? null },
      })
    );
  }

  function sendError(
    streamId: string,
    message: string,
    retryable: boolean
  ): void {
    if (!currentCtx) return;
    currentCtx.send(
      currentCtx.buildEnvelope('pty', 'pty.error', {
        streamId,
        error: { code: 'INTERNAL', message, retryable },
      })
    );
  }

  function recordScrollback(stream: ActiveStream, chunk: Buffer): void {
    stream.scrollback.push(chunk);
    stream.scrollbackBytes += chunk.byteLength;
    while (
      stream.scrollbackBytes > SCROLLBACK_BYTE_LIMIT &&
      stream.scrollback.length > 1
    ) {
      const dropped = stream.scrollback.shift();
      stream.scrollbackBytes -= dropped?.byteLength ?? 0;
    }
  }

  async function attach(
    streamId: string,
    input: NodeLinkPtyAttachInput
  ): Promise<void> {
    if (streams.has(streamId) || opening.has(streamId)) {
      logger.warn(`duplicate attach for streamId ${streamId}; ignoring`);
      sendError(streamId, 'stream already attached', false);
      return;
    }
    opening.add(streamId);
    try {
      const sessionId = asString(input.sessionId) ?? `relay-stream-${streamId}`;
      const command = asString(input.command) ?? defaultShell;
      const args = asStringArray(input.args) ?? [];
      const cols = asPositiveInt(input.cols) ?? DEFAULT_COLS;
      const rows = asPositiveInt(input.rows) ?? DEFAULT_ROWS;
      const cwd = asString(input.cwd) ?? defaultCwd;
      const env = sanitizeEnv(asEnv(input.env) ?? defaultEnv);

      let attachment: SessionAttachment;
      try {
        attachment = await factory.open({
          sessionId,
          command,
          args,
          cwd,
          env,
          cols,
          rows,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(`pty attach failed (${streamId}): ${message}`);
        sendError(streamId, `pty attach failed: ${message}`, false);
        return;
      }

      if (closed) {
        await attachment.close('host shutting down');
        return;
      }

      const stream: ActiveStream = {
        streamId,
        sessionId,
        attachment,
        scrollback: [],
        scrollbackBytes: 0,
        closing: false,
      };
      streams.set(streamId, stream);

      attachment.onData((chunk) => {
        const live = streams.get(streamId);
        if (!live || live.attachment !== attachment || live.closing) return;
        recordScrollback(live, chunk);
        sendData(streamId, chunk.toString('utf8'));
      });
      attachment.onExit(({ exitCode, signal }) => {
        const live = streams.get(streamId);
        if (!live || live.attachment !== attachment) return;
        streams.delete(streamId);
        sendExit(streamId, exitCode ?? 0, signal);
      });
    } finally {
      opening.delete(streamId);
    }
  }

  function input(streamId: string, data: unknown): void {
    const stream = streams.get(streamId);
    if (!stream) return;
    if (typeof data !== 'string') return;
    try {
      stream.attachment.write(Buffer.from(data, 'utf8'));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`pty input failed (${streamId}): ${message}`);
      sendError(streamId, `pty input failed: ${message}`, true);
    }
  }

  function resize(streamId: string, cols: unknown, rows: unknown): void {
    const stream = streams.get(streamId);
    if (!stream) return;
    const c = asPositiveInt(cols);
    const r = asPositiveInt(rows);
    if (!c || !r) return;
    try {
      stream.attachment.resize(c, r);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`pty resize failed (${streamId}): ${message}`);
    }
  }

  async function detach(streamId: string): Promise<void> {
    const stream = streams.get(streamId);
    if (!stream) return;
    stream.closing = true;
    try {
      await stream.attachment.close('detach');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`pty detach failed (${streamId}): ${message}`);
      streams.delete(streamId);
      sendExit(streamId, -1);
    }
  }

  function payloadRecord(payload: unknown): Record<string, unknown> {
    return typeof payload === 'object' && payload !== null
      ? (payload as Record<string, unknown>)
      : {};
  }

  return {
    mode: factory.mode,
    handle(envelope: RelayNodeEnvelope, ctx: NodeLinkPtyHostContext): void {
      if (envelope.channel !== 'pty') return;
      if (typeof envelope.streamId !== 'string') return;
      currentCtx = ctx;
      const streamId = envelope.streamId;
      const payload = payloadRecord(envelope.payload);
      if (envelope.type === 'pty.attach') {
        void attach(streamId, payload as NodeLinkPtyAttachInput);
        return;
      }
      if (envelope.type === 'pty.input') {
        input(streamId, payload['data']);
        return;
      }
      if (envelope.type === 'pty.resize') {
        resize(streamId, payload['cols'], payload['rows']);
        return;
      }
      if (envelope.type === 'pty.detach') {
        void detach(streamId);
        return;
      }
    },
    async closeAll(reason?: string): Promise<void> {
      closed = true;
      const active = Array.from(streams.values());
      streams.clear();
      for (const stream of active) {
        stream.closing = true;
        if (reason) sendError(stream.streamId, reason, false);
        try {
          await stream.attachment.close(reason);
        } catch {
          sendExit(stream.streamId, -1);
        }
      }
    },
  };
}
