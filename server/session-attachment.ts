import pty from 'node-pty';
import type { IPty, IPtyForkOptions } from 'node-pty';
import { Buffer } from 'node:buffer';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { Logger } from './logger.js';
import { createLogger } from './logger.js';

/**
 * Stable wire interface between `node-link-pty-host.ts` and concrete
 * session-attach implementations. Phase 1 (#467) ships `TmuxAttachment`
 * and a raw fallback; phase 2 (#469) will plug a server-side canonical
 * terminal in beside, not under, the tmux feature. No implementation
 * details (tmux verbs, node-pty handles, socket names) leak past this
 * boundary.
 */
export type SessionAttachmentStatus = 'attached' | 'detached' | 'closed';

export type SessionAttachmentMode = 'tmux' | 'raw';

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
  process: IPty
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
    async close() {
      if (state === 'closed') return;
      state = 'closed';
      try {
        process.kill();
      } catch {
        // already gone
      }
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

// Tmux config is invisible: no status bar, no prefix key, no mouse, zero
// escape-time. Operators never see the tmux UI; tmux is an
// attach-by-name primitive only.
const TMUX_CONF_BODY = [
  'set-option -g status off',
  'unbind-key -a',
  'set-option -g mouse off',
  'set-option -g escape-time 0',
  `set-option -g default-terminal "${DEFAULT_TERM}"`,
  'set-option -g history-limit 5000',
  'set-option -g destroy-unattached off',
].join('\n');

function writeTmuxConfig(dir: string): string {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, 'relay.tmux.conf');
  fs.writeFileSync(file, `${TMUX_CONF_BODY}\n`, { mode: 0o600 });
  return file;
}

function sanitizeTmuxName(sessionId: string): string {
  // tmux session names cannot contain ':' or '.'. Whitespace also
  // breaks `-t target` parsing.
  return `relay-${sessionId.replace(/[:.\s]/g, '_')}`;
}

export interface TmuxAttachmentFactoryDeps {
  spawn?: PtySpawn;
  tmuxPath?: string;
  socketName?: string;
  /**
   * Directory for the baked-in tmux.conf. Tests can override to a
   * scratch dir.
   */
  configDir?: string;
  logger?: Logger;
  /**
   * Hook to ensure the tmux session exists. Defaults to spawnSync of
   * `tmux new-session`. Tests can stub this without invoking real tmux.
   */
  ensureSession?: (params: {
    tmuxPath: string;
    socketName: string;
    configPath: string;
    target: string;
    options: SessionAttachmentSpawnOptions;
  }) => void;
}

/**
 * tmux-backed attachment. Browser reload reattaches to the same shell:
 *
 *   first attach  -> ensure session via `tmux new-session -d -s <target>`
 *                    then `attach-session -t <target>` over node-pty
 *   second attach -> session already exists, just `attach-session`
 *
 * `close()` kills the local attach client. The tmux session persists
 * for the next attach.
 */
export function createTmuxAttachmentFactory(
  deps: TmuxAttachmentFactoryDeps = {}
): SessionAttachmentFactory {
  const logger = deps.logger ?? createLogger('session-attachment-tmux');
  const spawn = deps.spawn ?? (pty.spawn as unknown as PtySpawn);
  const tmuxPath = deps.tmuxPath ?? 'tmux';
  const socketName = deps.socketName ?? 'relay';
  const configDir = deps.configDir ?? path.join(os.tmpdir(), 'relay-tmux');
  let configPath: string | undefined;

  function ensureConfig(): string {
    if (!configPath) configPath = writeTmuxConfig(configDir);
    return configPath;
  }

  const ensureSession =
    deps.ensureSession ??
    (({
      tmuxPath: bin,
      socketName: socket,
      configPath: cfg,
      target,
      options,
    }) => {
      const env = options.env;
      const has = spawnSync(
        bin,
        ['-L', socket, '-f', cfg, 'has-session', '-t', target],
        { env, encoding: 'utf8', timeout: 2_000 }
      );
      if (has.status === 0) return;

      const result = spawnSync(
        bin,
        [
          '-L',
          socket,
          '-f',
          cfg,
          'new-session',
          '-d',
          '-s',
          target,
          '-x',
          String(options.cols),
          '-y',
          String(options.rows),
          options.command,
          ...options.args,
        ],
        {
          cwd: options.cwd,
          env,
          encoding: 'utf8',
          timeout: 5_000,
        }
      );
      if (result.status !== 0) {
        const message =
          `${result.stderr || result.stdout || 'unknown error'}`.trim();
        // Race: another caller created the session between has-session
        // and new-session. Accept if it exists now.
        if (!message.includes('duplicate session')) {
          const recheck = spawnSync(
            bin,
            ['-L', socket, '-f', cfg, 'has-session', '-t', target],
            { env, encoding: 'utf8', timeout: 2_000 }
          );
          if (recheck.status !== 0) {
            throw new Error(`tmux new-session failed: ${message}`);
          }
        }
      }
    });

  return {
    mode: 'tmux',
    async open(options) {
      const cfg = ensureConfig();
      const target = sanitizeTmuxName(options.sessionId);
      logger.debug?.(
        `tmux attach for session ${options.sessionId} -> ${target}`
      );
      ensureSession({
        tmuxPath,
        socketName,
        configPath: cfg,
        target,
        options,
      });
      const attachArgs = [
        '-u',
        '-L',
        socketName,
        '-f',
        cfg,
        'attach-session',
        '-t',
        target,
      ];
      const proc = spawn(tmuxPath, attachArgs, {
        name: DEFAULT_TERM,
        cols: options.cols,
        rows: options.rows,
        cwd: options.cwd,
        env: options.env,
      });
      return wrapPty(options.sessionId, 'tmux', proc);
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
 * write/resize/close. Never spawns a real process or tmux.
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

  function emit(bytes: Buffer | string, index?: number): void {
    const target = index ?? dataHandlers.length - 1;
    if (target < 0) return;
    const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes, 'utf8');
    for (const handler of (dataHandlers[target] ?? []).slice()) handler(buf);
  }

  function exit(
    event: { exitCode: number; signal?: number } = { exitCode: 0 },
    index?: number
  ): void {
    const target = index ?? exitHandlers.length - 1;
    if (target < 0) return;
    for (const handler of (exitHandlers[target] ?? []).slice()) handler(event);
  }

  return {
    mode: 'tmux',
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
      const record: MockAttachmentRecord = {
        written: [],
        resizes: [],
        closed: false,
      };
      records.push(record);
      let state: SessionAttachmentStatus = 'attached';
      const attachment: SessionAttachment = {
        sessionId: spawnOpts.sessionId,
        mode: 'tmux',
        onData(handler) {
          data.push(handler);
          return {
            dispose: () => {
              const at = data.indexOf(handler);
              if (at >= 0) data.splice(at, 1);
            },
          };
        },
        onExit(handler) {
          exits.push(handler);
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
