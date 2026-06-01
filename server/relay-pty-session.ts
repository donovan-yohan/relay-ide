import * as pty from 'node-pty';
import type { IPty, IPtyForkOptions } from 'node-pty';
import { fileURLToPath } from 'node:url';
import { cleanEnv } from './utils.js';
import {
  createLibghosttyTerminalModelBackend,
  encodeTerminalInput,
  type EncodedTerminalInput,
  type TerminalInput,
  type TerminalInputKey,
  type TerminalModelBackend,
  type TerminalModelSnapshot,
} from './terminal-model-backend.js';

export type RelayPtySessionStatus = 'starting' | 'running' | 'exited' | 'closed';

export interface RelayPtySessionOptions {
  id: string;
  command: string;
  args?: string[];
  cwd: string;
  cols?: number;
  rows?: number;
  env?: NodeJS.ProcessEnv;
  backend?: TerminalModelBackend;
  spawn?: PtySpawn;
  relayCliPath?: string;
  workContextId?: string;
  taskRef?: string;
}

export interface RelayPtySessionTimingSnapshot {
  startedAt: string;
  lastActivityAt: string;
  lastOutputAt: string | null;
  lastInputAt: string | null;
  lastResizeAt: string | null;
  idleMs: number;
}

export interface RelayPtySessionSnapshot {
  id: string;
  status: RelayPtySessionStatus;
  command: string;
  args: string[];
  cwd: string;
  cols: number;
  rows: number;
  timing: RelayPtySessionTimingSnapshot;
  terminal: TerminalModelSnapshot;
  exit: { exitCode: number; signal?: number } | null;
}

export interface RelayPtySessionDisposable {
  dispose(): void;
}

type DataHandler = (bytes: Buffer) => void;
type ExitHandler = (event: { exitCode: number; signal?: number }) => void;

type PtySpawn = (
  command: string,
  args: string[],
  options: IPtyForkOptions
) => IPty;

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
const TERM_NAME = 'xterm-256color';

function defaultRelayCliPath(): string {
  return fileURLToPath(new URL('../dist/bin/relay-ide.js', import.meta.url));
}

export function buildRelayPtySessionEnv(
  options: Pick<
    RelayPtySessionOptions,
    'id' | 'env' | 'relayCliPath' | 'workContextId' | 'taskRef'
  >
): Record<string, string> {
  const base = {
    ...cleanEnv(),
    ...options.env,
  } as Record<string, string>;
  delete base.CLAUDECODE;

  base.RELAY_IDE_SESSION_ID = options.id;
  base.RELAY_IDE_SESSION_RUNTIME = 'relay-pty/libghostty-vt';
  base.RELAY_IDE_CLI_PATH = options.relayCliPath ?? defaultRelayCliPath();
  if (options.workContextId) base.RELAY_IDE_WORK_CONTEXT_ID = options.workContextId;
  if (options.taskRef) base.RELAY_IDE_TASK_REF = options.taskRef;
  return base;
}

export function createRelayPtySession(options: RelayPtySessionOptions): RelayPtySession {
  return new RelayPtySession(options);
}

/**
 * Prototype PTY owner that bypasses tmux. It is intentionally not wired into the
 * production session registry yet: the point of #834 is to prove the terminal
 * model and input contract while keeping the existing tmux runtime untouched.
 */
export class RelayPtySession {
  readonly id: string;
  readonly command: string;
  readonly args: string[];
  readonly cwd: string;
  readonly backend: TerminalModelBackend;

  private readonly proc: IPty;
  private readonly dataHandlers = new Set<DataHandler>();
  private readonly exitHandlers = new Set<ExitHandler>();
  private statusValue: RelayPtySessionStatus = 'starting';
  private colsValue: number;
  private rowsValue: number;
  private readonly startedAt = Date.now();
  private lastActivityAt = this.startedAt;
  private lastOutputAt: number | null = null;
  private lastInputAt: number | null = null;
  private lastResizeAt: number | null = null;
  private exitValue: { exitCode: number; signal?: number } | null = null;

  constructor(options: RelayPtySessionOptions) {
    this.id = options.id;
    this.command = options.command;
    this.args = options.args ?? [];
    this.cwd = options.cwd;
    this.colsValue = options.cols ?? DEFAULT_COLS;
    this.rowsValue = options.rows ?? DEFAULT_ROWS;
    this.backend =
      options.backend ??
      createLibghosttyTerminalModelBackend({
        cols: this.colsValue,
        rows: this.rowsValue,
        scrollbackLimit: 1000,
      });

    const spawn = options.spawn ?? (pty.spawn as unknown as PtySpawn);
    this.proc = spawn(this.command, this.args, {
      name: TERM_NAME,
      cols: this.colsValue,
      rows: this.rowsValue,
      cwd: this.cwd,
      env: buildRelayPtySessionEnv(options),
    });

    this.proc.onData((chunk) => {
      const bytes = Buffer.from(chunk, 'utf8');
      this.markOutput();
      this.backend.feed(bytes);
      for (const handler of Array.from(this.dataHandlers)) handler(bytes);
    });
    this.proc.onExit(({ exitCode, signal }) => {
      this.statusValue = 'exited';
      const event: { exitCode: number; signal?: number } = { exitCode: exitCode ?? 0 };
      if (signal !== undefined && signal !== null) event.signal = signal;
      this.exitValue = event;
      for (const handler of Array.from(this.exitHandlers)) handler(event);
    });
    this.statusValue = 'running';
  }

  get status(): RelayPtySessionStatus {
    return this.statusValue;
  }

  onData(handler: DataHandler): RelayPtySessionDisposable {
    this.dataHandlers.add(handler);
    return { dispose: () => this.dataHandlers.delete(handler) };
  }

  onExit(handler: ExitHandler): RelayPtySessionDisposable {
    this.exitHandlers.add(handler);
    return { dispose: () => this.exitHandlers.delete(handler) };
  }

  writeRaw(bytes: Buffer): void {
    if (this.statusValue !== 'running') return;
    this.markInput();
    this.proc.write(bytes.toString('utf8'));
  }

  send(input: TerminalInput): EncodedTerminalInput {
    const encoded = encodeTerminalInput(input);
    this.writeRaw(encoded.bytes);
    return encoded;
  }

  sendText(text: string): EncodedTerminalInput {
    return this.send({ type: 'text', text });
  }

  sendKey(key: TerminalInputKey): EncodedTerminalInput {
    return this.send({ type: 'key', key });
  }

  resize(cols: number, rows: number): void {
    if (!Number.isInteger(cols) || cols <= 0) return;
    if (!Number.isInteger(rows) || rows <= 0) return;
    if (this.statusValue !== 'running') return;
    this.colsValue = cols;
    this.rowsValue = rows;
    this.markResize();
    this.proc.resize(cols, rows);
    this.backend.resize(cols, rows);
  }

  snapshot(options: { includeCells?: boolean; includeScrollback?: boolean } = {}): RelayPtySessionSnapshot {
    const at = Date.now();
    return {
      id: this.id,
      status: this.statusValue,
      command: this.command,
      args: this.args,
      cwd: this.cwd,
      cols: this.colsValue,
      rows: this.rowsValue,
      timing: {
        startedAt: new Date(this.startedAt).toISOString(),
        lastActivityAt: new Date(this.lastActivityAt).toISOString(),
        lastOutputAt: this.lastOutputAt === null ? null : new Date(this.lastOutputAt).toISOString(),
        lastInputAt: this.lastInputAt === null ? null : new Date(this.lastInputAt).toISOString(),
        lastResizeAt: this.lastResizeAt === null ? null : new Date(this.lastResizeAt).toISOString(),
        idleMs: at - this.lastActivityAt,
      },
      terminal: this.backend.snapshot(options),
      exit: this.exitValue,
    };
  }

  close(): void {
    if (this.statusValue === 'closed') return;
    this.statusValue = 'closed';
    try {
      this.proc.kill();
    } finally {
      this.backend.dispose();
    }
  }

  private markOutput(): void {
    const at = Date.now();
    this.lastOutputAt = at;
    this.lastActivityAt = at;
  }

  private markInput(): void {
    const at = Date.now();
    this.lastInputAt = at;
    this.lastActivityAt = at;
  }

  private markResize(): void {
    const at = Date.now();
    this.lastResizeAt = at;
    this.lastActivityAt = at;
  }
}
