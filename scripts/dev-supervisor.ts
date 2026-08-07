import fs from 'node:fs';
import path from 'node:path';
import { spawn as nodeSpawn } from 'node:child_process';
import type { ChildProcess, SpawnOptions } from 'node:child_process';

export type SpawnFn = (
  command: string,
  args: string[],
  options: SpawnOptions
) => ChildProcess;

type LogFn = (message: string) => void;

export interface BackendSupervisorOptions {
  packageRoot: string;
  backendScript: string;
  backendEnv: NodeJS.ProcessEnv;
  spawn?: SpawnFn;
  log?: LogFn;
  error?: LogFn;
  onFatal?: (code: number) => void;
}

const SOURCE_ROOTS = new Set(['server', 'shared', 'bin']);
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts']);
const IGNORED_DIRS = new Set([
  '.git',
  '.worktrees',
  'node_modules',
  'dist',
  'coverage',
]);

export class BackendSupervisor {
  private readonly spawnFn: SpawnFn;
  private readonly logFn: LogFn;
  private readonly errorFn: LogFn;
  private backend: ChildProcess | null = null;
  private build: ChildProcess | null = null;
  private stopping = false;
  private restartAfterBackendExit = false;
  private queuedRestartSource: string | null = null;

  constructor(private readonly options: BackendSupervisorOptions) {
    this.spawnFn = options.spawn ?? nodeSpawn;
    this.logFn = options.log ?? (() => {});
    this.errorFn = options.error ?? (() => {});
  }

  start(): void {
    if (this.backend) return;
    this.spawnBackend();
  }

  requestRestart(sourcePath: string): void {
    if (this.stopping) return;
    this.queuedRestartSource = sourcePath;
    if (this.build) return;
    this.startRebuild();
  }

  stop(): void {
    this.stopping = true;
    if (this.build && !this.build.killed) this.build.kill('SIGTERM');
    if (this.backend && !this.backend.killed) this.backend.kill('SIGTERM');
  }

  private spawnBackend(): void {
    const child = this.spawnFn(process.execPath, [this.options.backendScript], {
      cwd: this.options.packageRoot,
      env: this.options.backendEnv,
      stdio: 'inherit',
    });
    this.backend = child;
    child.on('exit', (code, signal) => {
      if (this.backend !== child) return;
      this.backend = null;
      if (this.stopping) return;
      if (this.restartAfterBackendExit) {
        this.restartAfterBackendExit = false;
        this.logFn('backend restart complete; starting rebuilt backend.');
        this.spawnBackend();
        return;
      }
      this.errorFn(
        `backend exited${signal ? ` via ${signal}` : ''}${
          code === null ? '' : ` with code ${code}`
        }; stopping relay dev mode.`
      );
      this.options.onFatal?.(code ?? 1);
    });
    child.on('error', (err) => {
      if (this.stopping) return;
      this.errorFn(`backend failed to start: ${err.message}`);
      this.options.onFatal?.(1);
    });
  }

  private startRebuild(): void {
    const source = this.queuedRestartSource;
    this.queuedRestartSource = null;
    this.logFn(
      `backend source changed${source ? ` (${path.relative(this.options.packageRoot, source)})` : ''}; rebuilding...`
    );
    const child = this.spawnFn('npm', ['run', 'build:server'], {
      cwd: this.options.packageRoot,
      env: process.env,
      stdio: 'inherit',
    });
    this.build = child;
    child.on('exit', (code, signal) => {
      if (this.build !== child) return;
      this.build = null;
      if (this.stopping) return;
      if (code === 0) {
        this.restartBackendAfterSuccessfulBuild();
      } else {
        this.errorFn(
          `backend rebuild failed${signal ? ` via ${signal}` : ''}${
            code === null ? '' : ` with code ${code}`
          }; keeping current backend process.`
        );
      }
      if (this.queuedRestartSource) this.startRebuild();
    });
    child.on('error', (err) => {
      if (this.build !== child) return;
      this.build = null;
      if (this.stopping) return;
      this.errorFn(`backend rebuild failed to start: ${err.message}`);
      if (this.queuedRestartSource) this.startRebuild();
    });
  }

  private restartBackendAfterSuccessfulBuild(): void {
    if (!this.backend) {
      this.logFn('backend was not running; starting rebuilt backend.');
      this.spawnBackend();
      return;
    }
    this.restartAfterBackendExit = true;
    this.logFn('backend rebuild succeeded; restarting backend gracefully.');
    this.backend.kill('SIGTERM');
  }
}

export function shouldWatchDevSourceFile(
  filePath: string,
  packageRoot: string
): boolean {
  const relativePath = path.relative(packageRoot, filePath);
  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    return false;
  }
  const [topLevel] = relativePath.split(path.sep);
  if (!topLevel || !SOURCE_ROOTS.has(topLevel)) return false;
  if (relativePath.split(path.sep).some((part) => IGNORED_DIRS.has(part))) {
    return false;
  }
  return SOURCE_EXTENSIONS.has(path.extname(relativePath));
}

export function createDevSourceWatcher(
  packageRoot: string,
  onChange: (filePath: string) => void,
  log: LogFn = () => {},
  error: LogFn = () => {}
): { close(): void } {
  const watchers = new Map<string, fs.FSWatcher>();

  function watchDir(dir: string): void {
    if (watchers.has(dir)) return;
    let watcher: fs.FSWatcher;
    try {
      watcher = fs.watch(dir, (eventType, filename) => {
        if (!filename) return;
        const fullPath = path.join(dir, filename.toString());
        if (eventType === 'rename') {
          watchTreeIfDirectory(fullPath);
        }
        if (shouldWatchDevSourceFile(fullPath, packageRoot)) {
          onChange(fullPath);
        }
      });
    } catch (err) {
      error(
        `failed to watch ${path.relative(packageRoot, dir)}: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
      return;
    }
    watchers.set(dir, watcher);
  }

  function watchTreeIfDirectory(dir: string): void {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(dir);
    } catch {
      return;
    }
    if (!stat.isDirectory()) return;
    const name = path.basename(dir);
    if (IGNORED_DIRS.has(name)) return;
    watchTree(dir);
  }

  function watchTree(dir: string): void {
    watchDir(dir);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || IGNORED_DIRS.has(entry.name)) continue;
      watchTree(path.join(dir, entry.name));
    }
  }

  for (const root of SOURCE_ROOTS) {
    watchTreeIfDirectory(path.join(packageRoot, root));
  }
  log(`watching backend sources (${[...SOURCE_ROOTS].join(', ')})`);

  return {
    close(): void {
      for (const watcher of watchers.values()) watcher.close();
      watchers.clear();
    },
  };
}
