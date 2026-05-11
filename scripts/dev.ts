#!/usr/bin/env node
/* eslint-disable no-console -- dev runner prints user-facing process status */
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { BackendSupervisor, createDevSourceWatcher } from './dev-supervisor.js';
import { resolveDevModeOptions } from './dev-mode.js';

const packageRoot = path.resolve(import.meta.dirname, '..', '..');
const require = createRequire(import.meta.url);
const backendScript = path.join(packageRoot, 'dist', 'server', 'index.js');
const vitePackageRoot = path.resolve(
  path.dirname(require.resolve('vite')),
  '..',
  '..'
);
const viteBin = path.join(vitePackageRoot, 'bin', 'vite.js');
const viteConfig = path.join(packageRoot, 'frontend', 'vite.config.ts');

const mode = await resolveDevModeOptions({
  argv: process.argv.slice(2),
  env: process.env,
  packageRoot,
});

const {
  selfHost,
  backendPort,
  frontendPort,
  backendHost,
  frontendHost,
  backendTarget,
  configPath,
  tmuxPrefix,
} = mode;

const children = new Set<ChildProcess>();
let shuttingDown = false;
let backendRestartTimer: ReturnType<typeof setTimeout> | null = null;
let sourceWatcher: { close(): void } | null = null;

const backendSupervisor = new BackendSupervisor({
  packageRoot,
  backendScript,
  backendEnv: {
    ...process.env,
    RELAY_IDE_CONFIG: configPath,
    RELAY_IDE_PORT: backendPort,
    RELAY_IDE_HOST: backendHost,
    RELAY_IDE_DEV_BACKEND_PORT: backendPort,
    RELAY_IDE_DEV_BACKEND_URL: backendTarget,
    RELAY_IDE_TMUX_PREFIX: tmuxPrefix,
    RELAY_IDE_SELF_HOST: selfHost ? '1' : undefined,
    NO_PIN: '1',
  },
  log: (message) => console.log(message),
  error: (message) => console.error(message),
  onFatal: (code) => stopDevMode(code),
});

function spawnChild(
  name: string,
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv
): ChildProcess {
  const child = spawn(command, args, {
    cwd: packageRoot,
    env,
    stdio: 'inherit',
  });
  children.add(child);
  child.on('exit', (code, signal) => {
    children.delete(child);
    if (shuttingDown) return;
    stopDevMode(
      code ?? 1,
      child,
      `${name} exited${signal ? ` via ${signal}` : ''}${code === null ? '' : ` with code ${code}`}; stopping relay dev mode.`
    );
  });
  child.on('error', (err) => {
    if (shuttingDown) return;
    stopDevMode(1, child, `${name} failed to start: ${err.message}`);
  });
  return child;
}

function stopChildren(skip?: ChildProcess): void {
  sourceWatcher?.close();
  sourceWatcher = null;
  if (backendRestartTimer) {
    clearTimeout(backendRestartTimer);
    backendRestartTimer = null;
  }
  backendSupervisor.stop();
  for (const child of children) {
    if (child === skip || child.killed) continue;
    child.kill('SIGTERM');
  }
}

function stopDevMode(
  code: number,
  skip?: ChildProcess,
  message?: string
): void {
  if (shuttingDown) return;
  shuttingDown = true;
  if (message) console.error(message);
  stopChildren(skip);
  process.exit(code);
}

function shutdown(signal: NodeJS.Signals): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`received ${signal}; stopping relay dev mode.`);
  stopChildren();
  setTimeout(() => process.exit(0), 500).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

console.log(`relay dev backend:  http://${backendHost}:${backendPort}`);
console.log(`relay dev frontend: http://${frontendHost}:${frontendPort}`);
console.log(`proxy target:        ${backendTarget}`);
console.log(`config:              ${configPath}`);
console.log(`tmux prefix:         ${tmuxPrefix}`);
if (selfHost) console.log('self-host mode:      on');

backendSupervisor.start();
sourceWatcher = createDevSourceWatcher(
  packageRoot,
  (filePath) => {
    if (backendRestartTimer) clearTimeout(backendRestartTimer);
    backendRestartTimer = setTimeout(() => {
      backendRestartTimer = null;
      backendSupervisor.requestRestart(filePath);
    }, 250);
  },
  (message) => console.log(message),
  (message) => console.error(message)
);

spawnChild(
  'vite',
  process.execPath,
  [
    viteBin,
    '--config',
    viteConfig,
    '--host',
    frontendHost,
    '--port',
    frontendPort,
  ],
  {
    ...process.env,
    RELAY_IDE_DEV_BACKEND_PORT: backendPort,
    RELAY_IDE_DEV_BACKEND_URL: backendTarget,
    RELAY_IDE_DEV_FRONTEND_HOST: frontendHost,
    RELAY_IDE_DEV_FRONTEND_PORT: frontendPort,
    RELAY_IDE_TMUX_PREFIX: tmuxPrefix,
    RELAY_IDE_SELF_HOST: selfHost ? '1' : undefined,
  }
);
