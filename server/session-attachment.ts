import pty from 'node-pty';
import type { IPty, IPtyForkOptions } from 'node-pty';
import { Buffer } from 'node:buffer';
import type { Logger } from './logger.js';

/**
 * Stable wire interface between `node-link-pty-host.ts` and concrete
 * session-attach implementations. Relay-owned PTYs are the only live
 * attachment backend; this abstraction keeps node-pty handles behind one
 * boundary.
 */
export type SessionAttachmentStatus = 'attached' | 'detached' | 'closed';

export type SessionAttachmentMode = 'raw';

export interface SessionAttachmentSpawnOptions {
  sessionId: string;
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  cols: number;
  rows: number;
}

export interface SessionAttachmentDisposable {
  dispose(): void;
}

export interface SessionAttachment {
  readonly sessionId: string;
  readonly mode: SessionAttachmentMode;
  onData(handler: (bytes: Buffer) => void): SessionAttachmentDisposable;
  onExit(
    handler: (event: { exitCode: number; signal?: number }) => void
  ): SessionAttachmentDisposable;
  write(bytes: Buffer): void;
  resize(cols: number, rows: number): void;
  /**
   * Close the Relay-owned PTY attachment. Relay-pty is not a process
   * supervisor; closing an attachment ends the local child process.
   */
  close(reason?: string): Promise<void>;
  status(): SessionAttachmentStatus;
}

export interface SessionAttachmentFactory {
  readonly mode: SessionAttachmentMode;
  open(options: SessionAttachmentSpawnOptions): Promise<SessionAttachment>;
}

type PtySpawn = (
  command: string,
  args: string[],
  options: IPtyForkOptions
) => IPty;

const DEFAULT_TERM = 'xterm-256color';

function wrapPty(
  sessionId: string,
  mode: SessionAttachmentMode,
  process: IPty,
  hooks: {
    onClose?: (reason: string | undefined) => Promise<void> | void;
  } = {}
): SessionAttachment {
  let state: SessionAttachmentStatus = 'attached';
  process.onExit(() => {
    state = 'closed';
  });
  return {
    sessionId,
    mode,
    onData(handler) {
      const disposable = process.onData((chunk) => {
        if (state === 'closed') return;
        handler(Buffer.from(chunk, 'utf8'));
      });
      return { dispose: () => disposable.dispose() };
    },
    onExit(handler) {
      const disposable = process.onExit(({ exitCode, signal }) => {
        const event: { exitCode: number; signal?: number } = {
          exitCode: exitCode ?? 0,
        };
        if (signal !== undefined && signal !== null) event.signal = signal;
        handler(event);
      });
      return { dispose: () => disposable.dispose() };
    },
    write(bytes) {
      if (state === 'closed') return;
      process.write(bytes.toString('utf8'));
    },
    resize(cols, rows) {
      if (state === 'closed') return;
      if (!Number.isInteger(cols) || cols <= 0) return;
      if (!Number.isInteger(rows) || rows <= 0) return;
      try {
        process.resize(cols, rows);
      } catch {
        // Resize on a dying pty can throw; treat as a no-op.
      }
    },
    async close(reason) {
      if (state === 'closed') return;
      state = 'closed';
      try {
        process.kill();
      } catch {
        // already gone
      }
      if (hooks.onClose) await hooks.onClose(reason);
    },
    status() {
      return state;
    },
  };
}

export interface RawAttachmentFactoryDeps {
  spawn?: PtySpawn;
  logger?: Logger;
}

/**
 * Raw shell. No resume semantics: browser reload kills the shell. Used
 * on hosts that advertise `sessionResume: 'none'`.
 */
export function createRawAttachmentFactory(
  deps: RawAttachmentFactoryDeps = {}
): SessionAttachmentFactory {
  const spawn = deps.spawn ?? (pty.spawn as unknown as PtySpawn);
  return {
    mode: 'raw',
    async open(options) {
      const proc = spawn(options.command, options.args, {
        name: DEFAULT_TERM,
        cols: options.cols,
        rows: options.rows,
        cwd: options.cwd,
        env: options.env,
      });
      return wrapPty(options.sessionId, 'raw', proc);
    },
  };
}

export interface MockAttachmentRecord {
  written: Buffer[];
  resizes: Array<{ cols: number; rows: number }>;
  closed: boolean;
  closeReason?: string;
}

export interface MockAttachmentControl {
  emit(bytes: Buffer | string, index?: number): void;
  exit(event?: { exitCode: number; signal?: number }, index?: number): void;
  attachments: SessionAttachment[];
  records: MockAttachmentRecord[];
}

export interface MockAttachmentFactory
  extends SessionAttachmentFactory, MockAttachmentControl {}

/**
 * Test attachment factory. Replays scripted bytes, captures every
 * write/resize/close. Never spawns a real process. Scripted
 * data is buffered until the first onData listener registers so the
 * common "await open() then attachment.onData(...)" pattern observes
 * the replay (Copilot review, #472).
 */
export function createMockAttachmentFactory(
  initial: {
    data?: Array<Buffer | string>;
    exit?: { exitCode: number; signal?: number };
  } = {}
): MockAttachmentFactory {
  type DataHandler = (bytes: Buffer) => void;
  type ExitHandler = (event: { exitCode: number; signal?: number }) => void;
  const attachments: SessionAttachment[] = [];
  const records: MockAttachmentRecord[] = [];
  const dataHandlers: DataHandler[][] = [];
  const exitHandlers: ExitHandler[][] = [];
  const pendingData: Buffer[][] = [];
  const pendingExit: Array<{ exitCode: number; signal?: number } | undefined> =
    [];

  function emit(bytes: Buffer | string, index?: number): void {
    const target = index ?? dataHandlers.length - 1;
    if (target < 0) return;
    const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes, 'utf8');
    const handlers = dataHandlers[target] ?? [];
    if (handlers.length === 0) {
      (pendingData[target] ??= []).push(buf);
      return;
    }
    for (const handler of handlers.slice()) handler(buf);
  }

  function exit(
    event: { exitCode: number; signal?: number } = { exitCode: 0 },
    index?: number
  ): void {
    const target = index ?? exitHandlers.length - 1;
    if (target < 0) return;
    const handlers = exitHandlers[target] ?? [];
    if (handlers.length === 0) {
      pendingExit[target] = event;
      return;
    }
    for (const handler of handlers.slice()) handler(event);
  }

  return {
    mode: 'raw',
    attachments,
    records,
    emit,
    exit,
    async open(spawnOpts) {
      const idx = attachments.length;
      const data: DataHandler[] = [];
      const exits: ExitHandler[] = [];
      dataHandlers.push(data);
      exitHandlers.push(exits);
      pendingData.push([]);
      pendingExit.push(undefined);
      const record: MockAttachmentRecord = {
        written: [],
        resizes: [],
        closed: false,
      };
      records.push(record);
      let state: SessionAttachmentStatus = 'attached';
      const attachment: SessionAttachment = {
        sessionId: spawnOpts.sessionId,
        mode: 'raw',
        onData(handler) {
          data.push(handler);
          const buffered = pendingData[idx] ?? [];
          if (buffered.length > 0) {
            pendingData[idx] = [];
            for (const chunk of buffered) handler(chunk);
          }
          return {
            dispose: () => {
              const at = data.indexOf(handler);
              if (at >= 0) data.splice(at, 1);
            },
          };
        },
        onExit(handler) {
          exits.push(handler);
          const pending = pendingExit[idx];
          if (pending) {
            pendingExit[idx] = undefined;
            handler(pending);
          }
          return {
            dispose: () => {
              const at = exits.indexOf(handler);
              if (at >= 0) exits.splice(at, 1);
            },
          };
        },
        write(bytes) {
          if (state === 'closed') return;
          record.written.push(Buffer.from(bytes));
        },
        resize(cols, rows) {
          if (state === 'closed') return;
          record.resizes.push({ cols, rows });
        },
        async close(reason) {
          if (state === 'closed') return;
          state = 'closed';
          record.closed = true;
          if (reason !== undefined) record.closeReason = reason;
          for (const handler of exits.slice()) handler({ exitCode: 0 });
        },
        status() {
          return state;
        },
      };
      attachments.push(attachment);
      if (initial.data) for (const chunk of initial.data) emit(chunk, idx);
      if (initial.exit) exit(initial.exit, idx);
      return attachment;
    },
  };
}
