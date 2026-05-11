import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';

import {
  PortAllocator,
  upsertPortsInEnvFile,
} from '../server/port-allocator.js';

const DEV_BACKEND_PORT = 3457;
const DEV_FRONTEND_PORT = 5173;
const DEV_HOST = '127.0.0.1';
const DEV_TMUX_PREFIX = 'relay-dev-';
const SELF_HOST_TMUX_PREFIX = 'relay-self-';

export const SELF_HOST_PORT_VARIABLES = [
  'RELAY_IDE_DEV_BACKEND_PORT',
  'RELAY_IDE_DEV_FRONTEND_PORT',
] as const;

export interface ResolveSelfHostConfigPathOptions {
  env?: Record<string, string | undefined> | undefined;
  homedir?: string | undefined;
}

export interface ResolveDevModeOptionsParams {
  argv?: string[] | undefined;
  env?: Record<string, string | undefined> | undefined;
  packageRoot: string;
  homedir?: string | undefined;
}

export interface DevModeOptions {
  selfHost: boolean;
  backendPort: string;
  frontendPort: string;
  backendHost: string;
  frontendHost: string;
  backendTarget: string;
  configPath: string;
  tmuxPrefix: string;
  portMapping: Record<string, number> | null;
}

function parsePort(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : fallback;
}

function userConfigDir(
  env: Record<string, string | undefined>,
  homedir: string
): string {
  const xdgConfigHome = env.XDG_CONFIG_HOME?.trim();
  return path.join(xdgConfigHome || path.join(homedir, '.config'), 'relay-ide');
}

function safePathSlug(inputPath: string): string {
  return (
    path
      .basename(path.resolve(inputPath))
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'workspace'
  );
}

function pathHash(inputPath: string): string {
  return crypto
    .createHash('sha256')
    .update(path.resolve(inputPath))
    .digest('hex')
    .slice(0, 12);
}

export function resolveSelfHostConfigPath(
  packageRoot: string,
  options: ResolveSelfHostConfigPathOptions = {}
): string {
  const env = options.env ?? process.env;
  const home = options.homedir ?? os.homedir();
  const stateDir = path.join(
    userConfigDir(env, home),
    'self-host',
    `${safePathSlug(packageRoot)}-${pathHash(packageRoot)}`
  );
  return path.join(stateDir, 'config.json');
}

function isSelfHostRequested(
  argv: string[],
  env: Record<string, string | undefined>
): boolean {
  return argv.includes('--self-host') || env.RELAY_IDE_SELF_HOST === '1';
}

async function allocateSelfHostPorts(
  configPath: string,
  packageRoot: string
): Promise<Record<string, number>> {
  const allocator = new PortAllocator({ configPath });
  await allocator.initialize();
  const ports = await allocator.reconcilePortsForWorktree(
    packageRoot,
    packageRoot,
    [...SELF_HOST_PORT_VARIABLES]
  );
  return ports;
}

export async function resolveDevModeOptions(
  params: ResolveDevModeOptionsParams
): Promise<DevModeOptions> {
  const argv = params.argv ?? process.argv.slice(2);
  const env = params.env ?? process.env;
  const packageRoot = path.resolve(params.packageRoot);
  const selfHost = isSelfHostRequested(argv, env);
  const configPath = path.resolve(
    env.RELAY_IDE_CONFIG ??
      (selfHost
        ? resolveSelfHostConfigPath(packageRoot, {
            env,
            homedir: params.homedir,
          })
        : path.join(packageRoot, 'config.dev.json'))
  );

  let portMapping: Record<string, number> | null = null;
  if (selfHost) {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    portMapping = await allocateSelfHostPorts(configPath, packageRoot);
  }

  const backendPort = String(
    parsePort(
      env.RELAY_IDE_DEV_BACKEND_PORT ??
        env.RELAY_IDE_PORT ??
        (portMapping?.RELAY_IDE_DEV_BACKEND_PORT != null
          ? String(portMapping.RELAY_IDE_DEV_BACKEND_PORT)
          : undefined),
      DEV_BACKEND_PORT
    )
  );
  const frontendPort = String(
    parsePort(
      env.RELAY_IDE_DEV_FRONTEND_PORT ??
        (portMapping?.RELAY_IDE_DEV_FRONTEND_PORT != null
          ? String(portMapping.RELAY_IDE_DEV_FRONTEND_PORT)
          : undefined),
      DEV_FRONTEND_PORT
    )
  );
  const backendHost = env.RELAY_IDE_DEV_BACKEND_HOST ?? DEV_HOST;
  const frontendHost = env.RELAY_IDE_DEV_FRONTEND_HOST ?? DEV_HOST;
  const backendTarget =
    env.RELAY_IDE_DEV_BACKEND_URL ?? `http://127.0.0.1:${backendPort}`;

  const effectivePortMapping = selfHost
    ? {
        RELAY_IDE_DEV_BACKEND_PORT: Number(backendPort),
        RELAY_IDE_DEV_FRONTEND_PORT: Number(frontendPort),
      }
    : null;
  if (effectivePortMapping) {
    upsertPortsInEnvFile(packageRoot, effectivePortMapping);
  }

  return {
    selfHost,
    backendPort,
    frontendPort,
    backendHost,
    frontendHost,
    backendTarget,
    configPath,
    tmuxPrefix: selfHost ? SELF_HOST_TMUX_PREFIX : DEV_TMUX_PREFIX,
    portMapping: effectivePortMapping,
  };
}
