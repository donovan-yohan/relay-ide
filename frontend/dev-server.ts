import type { ProxyOptions } from 'vite';

export const DEV_BACKEND_PORT = 3457;
export const DEV_FRONTEND_PORT = 5173;
export const DEV_FRONTEND_HOST = '127.0.0.1';

const DEFAULT_DEV_BACKEND_TARGET = `http://127.0.0.1:${DEV_BACKEND_PORT}`;

export const backendProxyPaths = [
  '/auth',
  '/sessions',
  '/context',
  '/inbox',
  '/repos',
  '/branches',
  '/worktrees',
  '/workspaces',
  '/workspace-surfaces',
  '/workspace-topics',
  '/workspace-groups',
  '/git',
  '/gh',
  '/config',
  '/hooks',
  '/webhooks',
  '/integration-github',
  '/integration-jira',
  '/branch-linker',
  '/ticket-transitions',
  '/org-dashboard',
  '/analytics',
  '/api',
  '/telemetry',
  '/push',
  '/presets',
  '/version',
  '/update',
  '/update-channel',
  '/health',
  '/browser-tabs',
  '/browser-content',
  '/ws',
] as const;

type DevEnv = Record<string, string | undefined>;

function parsePort(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : fallback;
}

export function buildBackendProxyTarget(env: DevEnv = process.env): string {
  if (env.RELAY_IDE_DEV_BACKEND_URL) return env.RELAY_IDE_DEV_BACKEND_URL;
  const port = parsePort(
    env.RELAY_IDE_DEV_BACKEND_PORT ?? env.RELAY_IDE_PORT,
    DEV_BACKEND_PORT
  );
  return `http://127.0.0.1:${port}`;
}

export function getDevFrontendHost(env: DevEnv = process.env): string {
  return env.RELAY_IDE_DEV_FRONTEND_HOST ?? DEV_FRONTEND_HOST;
}

export function getDevFrontendPort(env: DevEnv = process.env): number {
  return parsePort(env.RELAY_IDE_DEV_FRONTEND_PORT, DEV_FRONTEND_PORT);
}

export function createDevProxyConfig(
  target = DEFAULT_DEV_BACKEND_TARGET
): Record<string, ProxyOptions> {
  return Object.fromEntries(
    backendProxyPaths.map((route) => [
      route,
      {
        target,
        changeOrigin: true,
        secure: false,
        ws: route === '/ws',
      } satisfies ProxyOptions,
    ])
  );
}
