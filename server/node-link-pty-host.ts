import { Buffer } from 'node:buffer';
import type { Logger } from './logger.js';
import { createLogger } from './logger.js';
import type { RelayNodeEnvelope } from '../shared/relay-node-protocol.js';
import type {
  SessionAttachment,
  SessionAttachmentFactory,
  SessionAttachmentMode,
} from './session-attachment.js';
import { createRawAttachmentFactory } from './session-attachment.js';
import type { NodeSessionResumeKind } from '../shared/node-manifest.js';
import type { LocalRelayNode } from './local-node.js';
import type { PtySession } from './types.js';

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

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
   * Pluggable attachment backend. Defaults to raw relay-pty.
   * Tests inject `MockAttachmentFactory` directly to avoid spawning processes.
   */
  attachmentFactory?: SessionAttachmentFactory;
  defaultShell?: string;
  defaultCwd?: string;
  defaultEnv?: NodeJS.ProcessEnv;
  localRelayNode?: LocalRelayNode;
  logger?: Logger;
  inputRecorder?: (input: { sessionId: string; data: string }) => void;
  /**
   * Resume capability the manifest advertises. relay-pty/libghostty-vt is not
   * a process supervisor, so current nodes use raw attachments and advertise
   * `none` until a future daemon/canonical-emulator exists.
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
  /**
   * Context captured at attach time so traffic on this stream always
   * flows back over the link that opened it, even when a hub
   * reconnect overlaps and `handle()` swaps in a fresh context for
   * later envelopes (gemini-code-assist, #472 review).
   */
  ctx: NodeLinkPtyHostContext;
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
  return createRawAttachmentFactory();
}

function createLiveSessionAttachment(session: PtySession): SessionAttachment {
  let state: 'attached' | 'closed' = 'attached';
  let exitEmitted = false;
  const disposables: Array<{ dispose(): void }> = [];
  const exitHandlers = new Set<
    (event: { exitCode: number; signal?: number }) => void
  >();

  function emitExit(event: { exitCode: number; signal?: number }): void {
    if (exitEmitted) return;
    exitEmitted = true;
    state = 'closed';
    for (const disposable of disposables.splice(0)) disposable.dispose();
    for (const handler of Array.from(exitHandlers)) handler(event);
  }

  const realExit = session.pty.onExit(({ exitCode, signal }) => {
    const event: { exitCode: number; signal?: number } = {
      exitCode: exitCode ?? 0,
    };
    if (signal !== undefined && signal !== null) event.signal = signal;
    emitExit(event);
  });
  disposables.push(realExit);

  return {
    sessionId: session.id,
    mode: 'raw',
    onData(handler) {
      if (state === 'closed') return { dispose: () => {} };
      for (const chunk of session.scrollback) {
        handler(Buffer.from(chunk, 'utf8'));
      }
      const disposable = session.pty.onData((chunk) => {
        if (state === 'closed') return;
        handler(Buffer.from(chunk, 'utf8'));
      });
      disposables.push(disposable);
      return {
        dispose: () => {
          disposable.dispose();
          const index = disposables.indexOf(disposable);
          if (index >= 0) disposables.splice(index, 1);
        },
      };
    },
    onExit(handler) {
      exitHandlers.add(handler);
      return { dispose: () => void exitHandlers.delete(handler) };
    },
    write(bytes) {
      if (state === 'closed') return;
      session.pty.write(bytes.toString('utf8'));
    },
    resize(cols, rows) {
      if (state === 'closed') return;
      session.pty.resize(cols, rows);
    },
    async close() {
      // Browser detach must not kill the node-local session that was created
      // via sessions.create. It only closes this stream and leaves the real
      // Codex/Claude/etc process running for later reattach.
      emitExit({ exitCode: 0 });
    },
    status() {
      return state;
    },
  };
}

export function createNodeLinkPtyHost(
  options: NodeLinkPtyHostOptions
): NodeLinkPtyHost {
  const logger = options.logger ?? createLogger('node-link-pty');
  const factory = resolveFactory(options);
  const inputRecorder = options.inputRecorder;
  const localRelayNode = options.localRelayNode;
  const defaultShell = options.defaultShell ?? defaultLoginShell();
  const defaultCwd = options.defaultCwd ?? process.cwd();
  const defaultEnv = options.defaultEnv ?? process.env;
  const streams = new Map<string, ActiveStream>();
  // Pending attaches need a ctx too — they haven't joined `streams` yet
  // but already need to be able to send pty.error if open() fails.
  const opening = new Map<string, NodeLinkPtyHostContext>();
  let closed = false;

  function send(
    ctx: NodeLinkPtyHostContext,
    type: string,
    streamId: string,
    extras: Partial<RelayNodeEnvelope> = {}
  ): void {
    ctx.send(ctx.buildEnvelope('pty', type, { streamId, ...extras }));
  }

  function sendData(stream: ActiveStream, data: string): void {
    send(stream.ctx, 'pty.data', stream.streamId, { payload: { data } });
  }

  function sendExit(
    ctx: NodeLinkPtyHostContext,
    streamId: string,
    exitCode: number,
    signal?: number
  ): void {
    send(ctx, 'pty.exit', streamId, {
      payload: { exitCode, signal: signal ?? null },
    });
  }

  function sendError(
    ctx: NodeLinkPtyHostContext,
    streamId: string,
    message: string,
    retryable: boolean
  ): void {
    send(ctx, 'pty.error', streamId, {
      error: { code: 'INTERNAL', message, retryable },
    });
  }

  async function attach(
    ctx: NodeLinkPtyHostContext,
    streamId: string,
    input: NodeLinkPtyAttachInput
  ): Promise<void> {
    if (streams.has(streamId) || opening.has(streamId)) {
      logger.warn(`duplicate attach for streamId ${streamId}; ignoring`);
      sendError(ctx, streamId, 'stream already attached', false);
      return;
    }
    opening.set(streamId, ctx);
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
        const liveSession = localRelayNode?.sessions.get(sessionId);
        attachment =
          liveSession?.mode === 'pty'
            ? createLiveSessionAttachment(liveSession)
            : await factory.open({
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
        sendError(ctx, streamId, `pty attach failed: ${message}`, false);
        return;
      }

      if (closed) {
        // Detach-only close keeps the tmux session alive across the
        // host's shutdown so a fresh link can resume it.
        await attachment.close('host shutting down');
        return;
      }

      const stream: ActiveStream = {
        streamId,
        sessionId,
        attachment,
        ctx,
        closing: false,
      };
      streams.set(streamId, stream);

      attachment.onData((chunk) => {
        const live = streams.get(streamId);
        if (!live || live.attachment !== attachment || live.closing) return;
        // tmux owns scrollback for resumable sessions; raw sessions
        // have no resume so any local buffer would be discarded
        // anyway. Forward bytes straight through.
        sendData(live, chunk.toString('utf8'));
      });
      attachment.onExit(({ exitCode, signal }) => {
        const live = streams.get(streamId);
        if (!live || live.attachment !== attachment) return;
        streams.delete(streamId);
        sendExit(live.ctx, streamId, exitCode ?? 0, signal);
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
      inputRecorder?.({ sessionId: stream.sessionId, data });
      stream.attachment.write(Buffer.from(data, 'utf8'));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`pty input failed (${streamId}): ${message}`);
      sendError(stream.ctx, streamId, `pty input failed: ${message}`, true);
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
      sendExit(stream.ctx, streamId, -1);
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
      const streamId = envelope.streamId;
      const payload = payloadRecord(envelope.payload);
      if (envelope.type === 'pty.attach') {
        void attach(ctx, streamId, payload as NodeLinkPtyAttachInput);
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
        if (reason) sendError(stream.ctx, stream.streamId, reason, false);
        try {
          await stream.attachment.close(reason);
        } catch {
          sendExit(stream.ctx, stream.streamId, -1);
        }
      }
    },
  };
}
