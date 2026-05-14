import pty from 'node-pty';
import type { IPty, IPtyForkOptions } from 'node-pty';
import { Buffer } from 'node:buffer';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Logger } from './logger.js';
import { createLogger } from './logger.js';

const execFileAsync = promisify(execFile);

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

/**
 * Magic `close()` reason that tells the tmux backend to destroy the
 * persistent session, not just the local attach client. `node-link-pty-
 * host` passes this on `closeAll('host shutting down')`-style paths
 * where the caller has decided the session is no longer wanted; normal
 * detach uses any other reason (or `undefined`) to keep the tmux
 * session alive for the next attach.
 */
export const SESSION_ATTACHMENT_KILL_REASON = '__relay_kill_session__';

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
   * Default: detach the local client only (tmux backend keeps the
   * persistent session alive for the next attach).
   *
   * Pass `SESSION_ATTACHMENT_KILL_REASON` to fully destroy the
   * persistent session — used when the caller has explicit intent to
   * end the session, not just disconnect a browser.
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

function defaultUserConfigDir(): string {
  // XDG-style location under the user's HOME, never world-readable.
  // os.tmpdir() is shared by every uid on the box (Copilot review,
  // #472) — a malicious local user could pre-create the directory
  // with permissive perms and race the conf write, and tmux configs
  // can shell out via `run-shell`.
  const xdg = process.env['XDG_CONFIG_HOME'];
  const base =
    xdg && xdg.startsWith('/') ? xdg : path.join(os.homedir(), '.config');
  return path.join(base, 'relay-ide', 'tmux');
}

function writeTmuxConfig(dir: string): string {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // Tighten perms even if the directory pre-existed with a wider mode.
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    // Best-effort: chmod may fail on weird filesystems (e.g. SMB).
  }
  const file = path.join(dir, 'relay.tmux.conf');
  fs.writeFileSync(file, `${TMUX_CONF_BODY}\n`, { mode: 0o600 });
  return file;
}

function sanitizeTmuxName(sessionId: string): string {
  // Whitelist alphanumeric + underscore + hyphen. Tmux session names
  // also reject ':' and '.' but other characters ([, ], whitespace,
  // shell metacharacters) cause downstream parsing/quoting bugs that
  // are not worth defending against case-by-case.
  return `relay-${sessionId.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
}

export interface TmuxAttachmentFactoryDeps {
  spawn?: PtySpawn;
  tmuxPath?: string;
  socketName?: string;
  /**
   * Directory for the baked-in tmux.conf. Defaults to
   * `$XDG_CONFIG_HOME/relay-ide/tmux` (or `~/.config/relay-ide/tmux`).
   * Tests can override to a scratch dir.
   */
  configDir?: string;
  logger?: Logger;
  /**
   * Hook to ensure the tmux session exists. Defaults to async execFile
   * against `tmux`. Tests can stub this without invoking real tmux.
   */
  ensureSession?: (params: {
    tmuxPath: string;
    socketName: string;
    configPath: string;
    target: string;
    options: SessionAttachmentSpawnOptions;
  }) => Promise<void> | void;
  /**
   * Hook to kill a tmux session when `close()` is invoked with
   * `SESSION_ATTACHMENT_KILL_REASON`. Defaults to async execFile of
   * `tmux kill-session -t <target>`. Tests can stub this.
   */
  killSession?: (params: {
    tmuxPath: string;
    socketName: string;
    configPath: string;
    target: string;
    env: NodeJS.ProcessEnv;
  }) => Promise<void> | void;
}

/**
 * tmux-backed attachment. Browser reload reattaches to the same shell:
 *
 *   first attach  -> ensure session via `tmux new-session -d -s <target>`
 *                    then `attach-session -t <target>` over node-pty
 *   second attach -> session already exists, just `attach-session`
 *
 * `close()` kills the local attach client; the tmux session persists
 * for the next attach. To fully destroy the persistent session pass
 * `SESSION_ATTACHMENT_KILL_REASON` as the reason.
 */
export function createTmuxAttachmentFactory(
  deps: TmuxAttachmentFactoryDeps = {}
): SessionAttachmentFactory {
  const logger = deps.logger ?? createLogger('session-attachment-tmux');
  const spawn = deps.spawn ?? (pty.spawn as unknown as PtySpawn);
  const tmuxPath = deps.tmuxPath ?? 'tmux';
  const socketName = deps.socketName ?? 'relay';
  const configDir = deps.configDir ?? defaultUserConfigDir();
  let configPath: string | undefined;

  function ensureConfig(): string {
    if (!configPath) configPath = writeTmuxConfig(configDir);
    return configPath;
  }

  const ensureSession =
    deps.ensureSession ??
    (async ({
      tmuxPath: bin,
      socketName: socket,
      configPath: cfg,
      target,
      options,
    }) => {
      const env = options.env;
      try {
        await execFileAsync(
          bin,
          ['-L', socket, '-f', cfg, 'has-session', '-t', target],
          { env, timeout: 2_000 }
        );
        return;
      } catch {
        // not present — fall through to new-session
      }

      try {
        await execFileAsync(
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
          { cwd: options.cwd, env, timeout: 5_000 }
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // Race: another caller may have created the session between
        // has-session and new-session.
        if (message.includes('duplicate session')) return;
        try {
          await execFileAsync(
            bin,
            ['-L', socket, '-f', cfg, 'has-session', '-t', target],
            { env, timeout: 2_000 }
          );
          return;
        } catch {
          throw new Error(`tmux new-session failed: ${message}`);
        }
      }
    });

  const killSession =
    deps.killSession ??
    (async ({
      tmuxPath: bin,
      socketName: socket,
      configPath: cfg,
      target,
      env,
    }) => {
      try {
        await execFileAsync(
          bin,
          ['-L', socket, '-f', cfg, 'kill-session', '-t', target],
          { env, timeout: 2_000 }
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn?.(`tmux kill-session failed for ${target}: ${message}`);
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
      await ensureSession({
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
      return wrapPty(options.sessionId, 'tmux', proc, {
        onClose: async (reason) => {
          if (reason !== SESSION_ATTACHMENT_KILL_REASON) return;
          await killSession({
            tmuxPath,
            socketName,
            configPath: cfg,
            target,
            env: options.env,
          });
        },
      });
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
 * write/resize/close. Never spawns a real process or tmux. Scripted
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
        mode: 'tmux',
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
