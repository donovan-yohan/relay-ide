import pty from 'node-pty';
import type { IPty } from 'node-pty';
import type { Logger } from './logger.js';
import { createLogger } from './logger.js';
import type { RelayNodeEnvelope } from '../shared/relay-node-protocol.js';

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
const DEFAULT_NAME = 'xterm-256color';
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
  spawn?: (command: string, args: string[], options: pty.IPtyForkOptions) => IPty;
  defaultShell?: string;
  defaultCwd?: string;
  defaultEnv?: NodeJS.ProcessEnv;
  logger?: Logger;
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
  closeAll(reason?: string): void;
}

interface ActiveStream {
  streamId: string;
  ptyProcess: IPty;
  scrollback: string[];
  scrollbackBytes: number;
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

function asEnv(value: unknown): NodeJS.ProcessEnv | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}

function defaultLoginShell(): string {
  return process.env['SHELL'] || '/bin/sh';
}

function sanitizeEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next = { ...base };
  // Strip CLAUDECODE so nested Claude sessions don't reuse parent state.
  delete next['CLAUDECODE'];
  return next;
}

export interface NodeLinkPtyHostOptions extends NodeLinkPtyHostDeps {
  nodeId: string;
}

export function createNodeLinkPtyHost(
  options: NodeLinkPtyHostOptions
): NodeLinkPtyHost {
  const logger = options.logger ?? createLogger('node-link-pty');
  const spawn = options.spawn ?? pty.spawn;
  const defaultShell = options.defaultShell ?? defaultLoginShell();
  const defaultCwd = options.defaultCwd ?? process.cwd();
  const defaultEnv = options.defaultEnv ?? process.env;
  const streams = new Map<string, ActiveStream>();
  let currentCtx: NodeLinkPtyHostContext | undefined;

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

  function sendError(streamId: string, message: string, retryable: boolean): void {
    if (!currentCtx) return;
    currentCtx.send(
      currentCtx.buildEnvelope('pty', 'pty.error', {
        streamId,
        error: { code: 'INTERNAL', message, retryable },
      })
    );
  }

  function recordScrollback(stream: ActiveStream, chunk: string): void {
    stream.scrollback.push(chunk);
    stream.scrollbackBytes += chunk.length;
    while (
      stream.scrollbackBytes > SCROLLBACK_BYTE_LIMIT &&
      stream.scrollback.length > 1
    ) {
      const dropped = stream.scrollback.shift();
      stream.scrollbackBytes -= dropped?.length ?? 0;
    }
  }

  function attach(streamId: string, input: NodeLinkPtyAttachInput): void {
    if (streams.has(streamId)) {
      logger.warn(`duplicate attach for streamId ${streamId}; ignoring`);
      sendError(streamId, 'stream already attached', false);
      return;
    }
    const command = asString(input.command) ?? defaultShell;
    const args = asStringArray(input.args) ?? [];
    const cols = asPositiveInt(input.cols) ?? DEFAULT_COLS;
    const rows = asPositiveInt(input.rows) ?? DEFAULT_ROWS;
    const cwd = asString(input.cwd) ?? defaultCwd;
    const env = sanitizeEnv(asEnv(input.env) ?? defaultEnv);

    let ptyProcess: IPty;
    try {
      ptyProcess = spawn(command, args, {
        name: DEFAULT_NAME,
        cols,
        rows,
        cwd,
        env,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`pty spawn failed (${streamId}): ${message}`);
      sendError(streamId, `pty spawn failed: ${message}`, false);
      return;
    }

    const stream: ActiveStream = {
      streamId,
      ptyProcess,
      scrollback: [],
      scrollbackBytes: 0,
    };
    streams.set(streamId, stream);

    ptyProcess.onData((chunk) => {
      const live = streams.get(streamId);
      if (!live || live.ptyProcess !== ptyProcess) return;
      recordScrollback(live, chunk);
      sendData(streamId, chunk);
    });
    ptyProcess.onExit(({ exitCode, signal }) => {
      const live = streams.get(streamId);
      if (!live || live.ptyProcess !== ptyProcess) return;
      streams.delete(streamId);
      sendExit(streamId, exitCode ?? 0, signal);
    });
  }

  function input(streamId: string, data: unknown): void {
    const stream = streams.get(streamId);
    if (!stream) return;
    if (typeof data !== 'string') return;
    try {
      stream.ptyProcess.write(data);
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
      stream.ptyProcess.resize(c, r);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`pty resize failed (${streamId}): ${message}`);
    }
  }

  function detach(streamId: string): void {
    const stream = streams.get(streamId);
    if (!stream) return;
    streams.delete(streamId);
    try {
      stream.ptyProcess.kill();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`pty kill failed (${streamId}): ${message}`);
    }
  }

  function payloadRecord(payload: unknown): Record<string, unknown> {
    return typeof payload === 'object' && payload !== null
      ? (payload as Record<string, unknown>)
      : {};
  }

  return {
    handle(envelope: RelayNodeEnvelope, ctx: NodeLinkPtyHostContext): void {
      if (envelope.channel !== 'pty') return;
      if (typeof envelope.streamId !== 'string') return;
      currentCtx = ctx;
      const streamId = envelope.streamId;
      const payload = payloadRecord(envelope.payload);
      if (envelope.type === 'pty.attach') {
        attach(streamId, payload as NodeLinkPtyAttachInput);
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
        detach(streamId);
        return;
      }
    },
    closeAll(reason?: string): void {
      for (const stream of Array.from(streams.values())) {
        streams.delete(stream.streamId);
        try {
          stream.ptyProcess.kill();
        } catch {
          /* best effort */
        }
        if (reason) {
          sendError(stream.streamId, reason, false);
        }
      }
    },
  };
}
