import { Router } from 'express';
import type { Request, Response } from 'express';

import { loadConfig, saveConfig } from './config.js';
import type { Config } from './types.js';
import { createLogger } from './logger.js';

const logger = createLogger('github-app');

// Deps type

export interface GitHubAppDeps {
  configPath: string;
  clientId: string;
  fetchFn?: typeof globalThis.fetch;
  onConnected?: () => void;
}

// Device flow state

interface DeviceFlowState {
  generation: number;
  deviceCode: string;
  interval: number;
  timerId: ReturnType<typeof setInterval> | null;
  flowStatus: 'polling' | 'denied' | 'expired' | null;
  pollInFlight: boolean;
}

const deviceFlow: DeviceFlowState = {
  generation: 0,
  deviceCode: '',
  interval: 5,
  timerId: null,
  flowStatus: null,
  pollInFlight: false,
};

/** Test helper — returns the current device flow state. */
export function _getDeviceFlowState(): DeviceFlowState {
  return deviceFlow;
}

function stopPollTimer(): void {
  if (deviceFlow.timerId !== null) {
    clearInterval(deviceFlow.timerId);
    deviceFlow.timerId = null;
  }
}

/**
 * Creates and returns an Express Router that handles all /auth/github routes.
 *
 * Caller is responsible for mounting and applying auth middleware:
 *   app.use('/auth/github', requireAuth, createGitHubAppRouter({ configPath, clientId }));
 */
export function createGitHubAppRouter(deps: GitHubAppDeps): Router {
  const { configPath, clientId } = deps;
  const fetchFn = deps.fetchFn ?? globalThis.fetch;

  const router = Router();

  function getConfig(): Config {
    return loadConfig(configPath);
  }

  // GET / — Initiate GitHub Device Flow
  router.get('/', async (_req: Request, res: Response) => {
    // Cancel any existing poll timer and increment generation
    stopPollTimer();
    deviceFlow.generation += 1;
    deviceFlow.flowStatus = null; // Reset stale status from prior flow
    const generation = deviceFlow.generation;

    // POST to GitHub device/code endpoint
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10_000);

    let deviceCodeData: {
      device_code: string;
      user_code: string;
      verification_uri: string;
      expires_in: number;
      interval: number;
    };

    try {
      const codeRes = await fetchFn('https://github.com/login/device/code', {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          client_id: clientId,
          scope: 'repo admin:repo_hook',
        }),
        signal: controller.signal,
      });

      if (!codeRes.ok) {
        res.status(500).json({ error: 'Failed to initiate device flow' });
        return;
      }

      deviceCodeData = (await codeRes.json()) as typeof deviceCodeData;
    } catch {
      res.status(500).json({ error: 'Failed to initiate device flow' });
      return;
    } finally {
      clearTimeout(timeoutId);
    }

    // Store device code and start polling
    deviceFlow.deviceCode = deviceCodeData.device_code;
    deviceFlow.interval = Math.max(deviceCodeData.interval ?? 5, 1);
    deviceFlow.flowStatus = 'polling';

    deviceFlow.timerId = setInterval(
      () =>
        void poll(generation, configPath, clientId, fetchFn, deps.onConnected),
      deviceFlow.interval * 1000
    );

    res.json({
      userCode: deviceCodeData.user_code,
      verificationUri: deviceCodeData.verification_uri,
      expiresIn: deviceCodeData.expires_in,
    });
  });

  // GET /status — Return { connected, username, deviceFlowStatus? } from config
  router.get('/status', (_req: Request, res: Response) => {
    const config = getConfig();
    const github = config.github;
    const connected = Boolean(github?.accessToken);
    const username = github?.username ?? null;
    res.json({
      connected,
      username,
      ...(deviceFlow.flowStatus
        ? { deviceFlowStatus: deviceFlow.flowStatus }
        : {}),
    });
  });

  // POST /disconnect — Remove accessToken and username from config.github (preserve webhookSecret and smeeUrl)
  router.post('/disconnect', (_req: Request, res: Response) => {
    const config = getConfig();
    if (config.github) {
      delete config.github.accessToken;
      delete config.github.username;
    }
    saveConfig(configPath, config);

    // Cancel any in-progress device-flow polling and invalidate the current flow
    stopPollTimer();
    deviceFlow.generation += 1;
    deviceFlow.deviceCode = '';
    deviceFlow.flowStatus = null;
    res.json({ ok: true });
  });

  return router;
}

async function poll(
  generation: number,
  configPath: string,
  clientId: string,
  fetchFn: typeof globalThis.fetch,
  onConnected?: () => void
): Promise<void> {
  // Generation check — abort if a newer flow has started
  if (deviceFlow.generation !== generation) return;
  // In-flight guard — skip if previous poll hasn't finished (prevents overlap when request takes > interval)
  if (deviceFlow.pollInFlight) return;
  deviceFlow.pollInFlight = true;
  try {
    let data: Record<string, string>;
    const pollController = new AbortController();
    const pollTimeoutId = setTimeout(() => pollController.abort(), 10_000);
    try {
      const res = await fetchFn('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          client_id: clientId,
          device_code: deviceFlow.deviceCode,
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        }),
        signal: pollController.signal,
      });
      data = (await res.json()) as Record<string, string>;
    } catch (err) {
      logger.warn('Device flow poll network error:', err);
      return;
    } finally {
      clearTimeout(pollTimeoutId);
    }

    // Re-check generation after await
    if (deviceFlow.generation !== generation) return;

    if (data['error'] === 'authorization_pending') {
      // No-op — keep polling
      return;
    }

    if (data['error'] === 'slow_down') {
      // Re-check generation before restarting timer
      if (deviceFlow.generation !== generation) return;
      // Clear timer and restart with increased interval (do NOT increment generation)
      stopPollTimer();
      deviceFlow.interval += 5;
      deviceFlow.timerId = setInterval(
        () => void poll(generation, configPath, clientId, fetchFn, onConnected),
        deviceFlow.interval * 1000
      );
      return;
    }

    if (data['error'] === 'expired_token') {
      stopPollTimer();
      deviceFlow.flowStatus = 'expired';
      return;
    }

    if (data['error'] === 'access_denied') {
      stopPollTimer();
      deviceFlow.flowStatus = 'denied';
      return;
    }

    if (data['access_token']) {
      const accessToken = data['access_token'];

      // Fetch username via GraphQL (best-effort)
      let username: string | undefined;
      try {
        const gqlRes = await fetchFn('https://api.github.com/graphql', {
          method: 'POST',
          headers: {
            Authorization: `bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ query: '{ viewer { login } }' }),
        });

        if (gqlRes.ok) {
          const gqlData = (await gqlRes.json()) as {
            data?: { viewer?: { login?: string } };
          };
          username = gqlData.data?.viewer?.login ?? undefined;
        }
      } catch {
        // Best-effort — username stays undefined
      }

      // Save token to config first, then username (best-effort)
      const config = loadConfig(configPath);
      if (!config.github) config.github = {};
      config.github.accessToken = accessToken;
      if (username) config.github.username = username;
      saveConfig(configPath, config);

      // Clear timer and mark flow complete
      stopPollTimer();
      deviceFlow.flowStatus = null;

      onConnected?.();
      return;
    }

    // Unknown response
    logger.warn('Unknown device flow poll response', data);
  } finally {
    deviceFlow.pollInFlight = false;
  }
}
