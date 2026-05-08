#!/usr/bin/env node
/* eslint-disable no-console -- dev runner prints user-facing process status */
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';

const DEV_BACKEND_PORT = 3457;
const DEV_FRONTEND_PORT = 5173;
const DEV_HOST = '127.0.0.1';

const packageRoot = path.resolve(import.meta.dirname, '..', '..');
const require = createRequire(import.meta.url);
const backendScript = path.join(packageRoot, 'dist', 'server', 'index.js');
const vitePackageRoot = path.resolve(path.dirname(require.resolve('vite')), '..', '..');
const viteBin = path.join(vitePackageRoot, 'bin', 'vite.js');
const viteConfig = path.join(packageRoot, 'frontend', 'vite.config.ts');

function parsePort(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port <= 65_535
    ? port
    : fallback;
}

const backendPort = String(
  parsePort(
    process.env.RELAY_IDE_DEV_BACKEND_PORT ?? process.env.RELAY_IDE_PORT,
    DEV_BACKEND_PORT
  )
);
const frontendPort = String(
  parsePort(process.env.RELAY_IDE_DEV_FRONTEND_PORT, DEV_FRONTEND_PORT)
);
const backendHost = process.env.RELAY_IDE_DEV_BACKEND_HOST ?? DEV_HOST;
const frontendHost = process.env.RELAY_IDE_DEV_FRONTEND_HOST ?? DEV_HOST;
const backendTarget =
  process.env.RELAY_IDE_DEV_BACKEND_URL ?? `http://127.0.0.1:${backendPort}`;
const configPath =
  process.env.RELAY_IDE_CONFIG ?? path.join(packageRoot, 'config.dev.json');

const children = new Set<ChildProcess>();
let shuttingDown = false;

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
    shuttingDown = true;
    console.error(
      `${name} exited${signal ? ` via ${signal}` : ''}${code === null ? '' : ` with code ${code}`}; stopping relay dev mode.`
    );
    stopChildren(child);
    process.exit(code ?? 1);
  });
  child.on('error', (err) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error(`${name} failed to start: ${err.message}`);
    stopChildren(child);
    process.exit(1);
  });
  return child;
}

function stopChildren(skip?: ChildProcess): void {
  for (const child of children) {
    if (child === skip || child.killed) continue;
    child.kill('SIGTERM');
  }
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

spawnChild('backend', process.execPath, [backendScript], {
  ...process.env,
  RELAY_IDE_CONFIG: configPath,
  RELAY_IDE_PORT: backendPort,
  RELAY_IDE_HOST: backendHost,
  RELAY_IDE_DEV_BACKEND_PORT: backendPort,
  RELAY_IDE_DEV_BACKEND_URL: backendTarget,
  NO_PIN: '1',
});

spawnChild(
  'vite',
  process.execPath,
  [viteBin, '--config', viteConfig, '--host', frontendHost, '--port', frontendPort],
  {
    ...process.env,
    RELAY_IDE_DEV_BACKEND_PORT: backendPort,
    RELAY_IDE_DEV_BACKEND_URL: backendTarget,
    RELAY_IDE_DEV_FRONTEND_HOST: frontendHost,
    RELAY_IDE_DEV_FRONTEND_PORT: frontendPort,
  }
);
