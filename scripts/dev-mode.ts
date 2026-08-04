import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  PortAllocator,
  upsertPortsInEnvFile,
} from '../server/port-allocator.js';
import {
  pathHash,
  relayAppDataDir,
  resolveSourceLaunchConfigPath,
  safePathSlug,
} from '../server/runtime-state-paths.js';

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
  /**
   * Legacy in-repo config (`config.dev.json`) that still exists on disk but is
   * no longer the default (#961). Non-null only when ordinary `npm run dev`
   * relocated the default to app-data yet found an old in-repo file; callers
   * surface this so the user can migrate it. `null` otherwise.
   */
  legacyConfigPath: string | null;
  tmuxPrefix: string;
  portMapping: Record<string, number> | null;
}

function getArgValue(argv: string[], flag: string): string | undefined {
  const inlinePrefix = `${flag}=`;
  const inlineValue = argv.find((arg) => arg.startsWith(inlinePrefix));
  if (inlineValue) return inlineValue.slice(inlinePrefix.length);

  const idx = argv.indexOf(flag);
  if (idx === -1 || idx + 1 >= argv.length) return undefined;
  const value = argv[idx + 1];
  if (value === undefined || value.startsWith('--')) return undefined;
  return value;
}

function parsePortOverride(value: string | undefined): number | null {
  if (!value) return null;
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : null;
}

function parsePort(value: string | undefined, fallback: number): number {
  return parsePortOverride(value) ?? fallback;
}

function normalizeTmuxPrefix(prefix: string | undefined): string | null {
  const sanitized = prefix
    ?.trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+/, '');
  if (!sanitized) return null;
  return sanitized.endsWith('-') ? sanitized : `${sanitized}-`;
}

export function resolveSelfHostConfigPath(
  packageRoot: string,
  options: ResolveSelfHostConfigPathOptions = {}
): string {
  const env = options.env ?? process.env;
  const home = options.homedir ?? os.homedir();
  const stateDir = path.join(
    relayAppDataDir(env, home),
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
  const explicitConfigPath = getArgValue(argv, '--config');

  // Precedence: explicit `--config` > `RELAY_IDE_CONFIG` (non-self-host) >
  // mode default. The ordinary-dev default now lives under app-data instead of
  // `<repo>/config.dev.json` so runtime SQLite never spills into the checkout
  // (#961). An existing in-repo `config.dev.json` is surfaced (not silently
  // honored) via `legacyConfigPath` so the user can migrate or pin it.
  let configPath: string;
  let legacyConfigPath: string | null = null;
  if (explicitConfigPath) {
    configPath = path.resolve(explicitConfigPath);
  } else if (!selfHost && env.RELAY_IDE_CONFIG) {
    configPath = path.resolve(env.RELAY_IDE_CONFIG);
  } else if (selfHost) {
    configPath = path.resolve(
      resolveSelfHostConfigPath(packageRoot, { env, homedir: params.homedir })
    );
  } else {
    const resolved = resolveSourceLaunchConfigPath(packageRoot, {
      fileName: 'config.dev.json',
      namespace: 'dev',
      env,
      homedir: params.homedir,
    });
    configPath = resolved.configPath;
    legacyConfigPath = resolved.legacyConfigPath;
  }

  let portMapping: Record<string, number> | null = null;
  if (selfHost) {
    await fs.promises.mkdir(path.dirname(configPath), { recursive: true });
    portMapping = await allocateSelfHostPorts(configPath, packageRoot);
  }

  const cliBackendPort = getArgValue(argv, '--port');
  const allocatedBackendPort = portMapping?.RELAY_IDE_DEV_BACKEND_PORT;
  const backendPortNumber = selfHost
    ? (parsePortOverride(cliBackendPort) ??
      parsePortOverride(env.RELAY_IDE_DEV_BACKEND_PORT) ??
      allocatedBackendPort ??
      DEV_BACKEND_PORT)
    : parsePort(
        cliBackendPort ??
          env.RELAY_IDE_DEV_BACKEND_PORT ??
          env.RELAY_IDE_PORT,
        DEV_BACKEND_PORT
      );
  const backendPort = String(backendPortNumber);

  const allocatedFrontendPort = portMapping?.RELAY_IDE_DEV_FRONTEND_PORT;
  const frontendPortNumber = selfHost
    ? (parsePortOverride(env.RELAY_IDE_DEV_FRONTEND_PORT) ??
      allocatedFrontendPort ??
      DEV_FRONTEND_PORT)
    : parsePort(env.RELAY_IDE_DEV_FRONTEND_PORT, DEV_FRONTEND_PORT);
  const frontendPort = String(frontendPortNumber);

  const backendHost =
    getArgValue(argv, '--host') ?? env.RELAY_IDE_DEV_BACKEND_HOST ?? DEV_HOST;
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
    legacyConfigPath,
    tmuxPrefix:
      normalizeTmuxPrefix(env.RELAY_IDE_TMUX_PREFIX) ??
      (selfHost ? SELF_HOST_TMUX_PREFIX : DEV_TMUX_PREFIX),
    portMapping: effectivePortMapping,
  };
}
