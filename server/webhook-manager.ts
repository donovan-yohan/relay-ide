import { Router } from 'express';
import type { Request, Response as ExpressResponse, RequestHandler } from 'express';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { loadConfig, saveConfig } from './config.js';
import { extractOwnerRepo, buildRepoMap } from './git.js';
import type { Config } from './types.js';

// ── Types ──────────────────────────────────────────────────────────────────────

export interface WebhookManagerDeps {
  configPath: string;
  broadcastEvent: (type: string, data?: Record<string, unknown>) => void;
  fetchFn?: typeof globalThis.fetch;
  requireAuth: RequestHandler;
}

type CreateWebhookResult =
  | { ok: true; webhookId: number; ownerRepo: string }
  | { ok: false; error: string; webhookError: string | null };

// ── Smee singleton state ───────────────────────────────────────────────────────

let smeeHandle: { close(): void } | null = null;
let smeeConnected = false;
let lastEventAt: string | null = null;

// ── Smart polling state ────────────────────────────────────────────────────────

let pollingTimer: ReturnType<typeof setInterval> | null = null;

function stopSmartPolling(): void {
  if (pollingTimer !== null) {
    clearInterval(pollingTimer);
    pollingTimer = null;
  }
}

/**
 * Starts a 30-second polling interval that broadcasts `pr-updated` and
 * `ci-updated` events only for workspaces that do NOT have a working webhook
 * configured (`webhookEnabled !== true` or `webhookError` is set).
 *
 * Calling this again replaces any existing polling timer.
 */
export function startSmartPolling(
  configPath: string,
  broadcastEvent: (type: string, data?: Record<string, unknown>) => void,
): void {
  stopSmartPolling();

  const POLL_INTERVAL_MS = 30_000;

  const tick = (): void => {
    const config = loadConfig(configPath);
    const workspacePaths = config.workspaces ?? [];
    if (workspacePaths.length === 0) return;

    const repoSettings = config.repoSettings ?? {};

    // Collect paths that need polling (no webhook or webhook has an error)
    const unwebhookedPaths = workspacePaths.filter((wsPath) => {
      const ws = repoSettings[wsPath];
      return !ws?.webhookEnabled || ws?.webhookError;
    });

    if (unwebhookedPaths.length === 0) return;

    // Resolve owner/repo for each unwebhooked path synchronously via git config cache
    // We use the async buildRepoMap but fire-and-forget inside the interval
    void (async () => {
      const execFn = (file: string, args: string[], opts: { cwd: string; timeout?: number }) =>
        execFileAsync(file, args, opts);
      const repoMap = await buildRepoMap(unwebhookedPaths, execFn);

      // Single broadcast per poll cycle — frontend debounces invalidation
      if (repoMap.size > 0) {
        broadcastEvent('pr-updated', { repos: [...repoMap.keys()] });
        broadcastEvent('ci-updated', { repos: [...repoMap.keys()] });
      }
    })();
  };

  pollingTimer = setInterval(tick, POLL_INTERVAL_MS);
}

function stopSmee(): void {
  if (smeeHandle) {
    try {
      smeeHandle.close();
    } catch {
      // Best-effort
    }
    smeeHandle = null;
  }
  smeeConnected = false;
}

function startSmee(smeeUrl: string, targetPort: number): void {
  stopSmee();

  // Dynamic import — smee-client may not be installed
  void (async () => {
    try {
      // Import as unknown first to avoid type-mismatch with varying smee-client versions
      const smeeModule = await import('smee-client') as unknown as {
        default: new (opts: {
          source: string;
          target: string;
          logger?: { info(...args: unknown[]): void; error(...args: unknown[]): void };
        }) => {
          start(): Promise<{ close(): void; addEventListener(type: string, fn: () => void): void }>;
          stop(): Promise<void>;
          onmessage: ((msg: unknown) => void) | null;
          onerror: ((ev: unknown) => void) | null;
          onopen: ((ev: unknown) => void) | null;
        };
      };

      const client = new smeeModule.default({
        source: smeeUrl,
        target: `http://localhost:${targetPort}/webhooks`,
        logger: {
          info: (...args: unknown[]) => console.log('[smee]', ...args),
          error: (...args: unknown[]) => console.error('[smee]', ...args),
        },
      });

      // Hook connectivity events via client setters (available before start)
      client.onmessage = () => {
        lastEventAt = new Date().toISOString();
      };
      client.onerror = () => {
        smeeConnected = false;
      };
      client.onopen = () => {
        smeeConnected = true;
      };

      // start() returns Promise<EventSource> — await it to get the handle for close()
      const es = await client.start();
      smeeHandle = { close: () => void es.close() };
      smeeConnected = true;
    } catch (err) {
      console.warn('[webhook-manager] smee-client not available or failed to start:', err);
      smeeConnected = false;
    }
  })();
}

export function reloadSmee(configPath: string, port: number): void {
  const config = loadConfig(configPath);
  const smeeUrl = config.github?.smeeUrl;
  stopSmee();
  if (smeeUrl) {
    startSmee(smeeUrl, port);
  }
}

export function getSmeeStatus(): { smeeConnected: boolean; lastEventAt: string | null } {
  return { smeeConnected, lastEventAt };
}

// ── GitHub API helper ──────────────────────────────────────────────────────────

type FetchFn = typeof globalThis.fetch;

function makeGithubApi(fetchFn: FetchFn) {
  return async function githubApi(
    method: string,
    path: string,
    token: string,
    body?: unknown,
  ): Promise<globalThis.Response> {
    const init: RequestInit = {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
    }
    return fetchFn(`https://api.github.com${path}`, init);
  };
}

// ── Webhook CRUD helper ────────────────────────────────────────────────────────

const execFileAsync = promisify(execFile);

async function getOwnerRepoForPath(repoPath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['remote', 'get-url', 'origin'], {
      cwd: repoPath,
      timeout: 10_000,
    });
    return extractOwnerRepo(stdout.trim());
  } catch {
    return null;
  }
}

async function createWebhookForPath(
  repoPath: string,
  configPath: string,
  config: Config,
  githubApi: ReturnType<typeof makeGithubApi>,
): Promise<CreateWebhookResult> {
  const token = config.github?.accessToken;
  const secret = config.github?.webhookSecret;
  const smeeUrl = config.github?.smeeUrl;

  if (!token) return { ok: false, error: 'not_authenticated', webhookError: null };
  if (!secret || !smeeUrl) return { ok: false, error: 'not_configured', webhookError: null };

  const ownerRepo = await getOwnerRepoForPath(repoPath);
  if (!ownerRepo) return { ok: false, error: 'no_remote', webhookError: null };

  const parts = ownerRepo.split('/');
  const owner = parts[0];
  const repo = parts[1];
  if (!owner || !repo) return { ok: false, error: 'invalid_remote', webhookError: null };

  let apiRes: globalThis.Response;
  try {
    apiRes = await githubApi('POST', `/repos/${owner}/${repo}/hooks`, token, {
      name: 'web',
      active: true,
      events: ['*'],
      config: {
        url: smeeUrl,
        content_type: 'json',
        secret,
        insecure_ssl: '0',
      },
    });
  } catch (err) {
    return { ok: false, error: `fetch_failed: ${String(err)}`, webhookError: null };
  }

  // 422 — webhook already exists; try to find the existing webhook ID
  if (apiRes.status === 422) {
    try {
      const listRes = await githubApi('GET', `/repos/${owner}/${repo}/hooks`, token);
      if (listRes.ok) {
        const hooks = await listRes.json() as Array<{ id: number; config?: { url?: string } }>;
        const existing = hooks.find((h) => h.config?.url === smeeUrl);
        if (existing) {
          persistWebhookSuccess(configPath, config, repoPath, existing.id);
          return { ok: true, webhookId: existing.id, ownerRepo };
        }
      }
    } catch (err) {
      console.warn('[webhook-manager] Could not retrieve existing webhook ID for', ownerRepo, err);
    }
    // Webhook exists on GitHub but we couldn't find its ID — don't persist a fake ID
    return { ok: true, webhookId: 0, ownerRepo };
  }

  if (apiRes.status === 403) {
    persistWebhookError(configPath, config, repoPath, 'not-admin');
    return { ok: false, error: 'forbidden', webhookError: 'not-admin' };
  }

  if (apiRes.status === 401) {
    return { ok: false, error: 'unauthorized', webhookError: null };
  }

  if (apiRes.status === 404) {
    persistWebhookError(configPath, config, repoPath, 'not-found');
    return { ok: false, error: 'not_found', webhookError: 'not-found' };
  }

  if (!apiRes.ok) {
    return { ok: false, error: `github_error_${apiRes.status}`, webhookError: null };
  }

  const created = await apiRes.json() as { id: number };
  persistWebhookSuccess(configPath, config, repoPath, created.id);
  return { ok: true, webhookId: created.id, ownerRepo };
}

function persistWebhookSuccess(
  configPath: string,
  config: Config,
  repoPath: string,
  webhookId: number,
): void {
  if (!config.repoSettings) config.repoSettings = {};
  if (!config.repoSettings[repoPath]) config.repoSettings[repoPath] = {};
  const ws = config.repoSettings[repoPath]!;
  ws.webhookId = webhookId;
  ws.webhookEnabled = true;
  delete ws.webhookError;
  saveConfig(configPath, config);
}

function persistWebhookError(
  configPath: string,
  config: Config,
  repoPath: string,
  errorCode: string,
): void {
  if (!config.repoSettings) config.repoSettings = {};
  if (!config.repoSettings[repoPath]) config.repoSettings[repoPath] = {};
  config.repoSettings[repoPath]!.webhookError = errorCode;
  saveConfig(configPath, config);
}

// ── Router factory ─────────────────────────────────────────────────────────────

/**
 * Creates and returns an Express Router for webhook management routes.
 *
 * Mount with:
 *   app.use('/webhooks/manage', createWebhookManagerRouter({ configPath, broadcastEvent, requireAuth }));
 *
 * Distinct from the `/webhooks` receiver in webhooks.ts — this router handles CRUD and lifecycle.
 */
export function createWebhookManagerRouter(deps: WebhookManagerDeps): Router {
  const { configPath, requireAuth } = deps;
  const fetchFn = deps.fetchFn ?? globalThis.fetch;
  const githubApi = makeGithubApi(fetchFn);

  const router = Router();

  function getConfig(): Config {
    return loadConfig(configPath);
  }

  // All routes require authentication
  router.use(requireAuth);

  // ── POST /setup — Generate smee channel + secret, save config, start smee ──

  router.post('/setup', async (_req: Request, res: ExpressResponse) => {
    // Create smee channel via redirect
    let channelUrl: string;
    try {
      const smeeRes = await fetchFn('https://smee.io/new', { redirect: 'manual' });
      const location = smeeRes.headers.get('location');
      if (location) {
        channelUrl = location;
      } else {
        // No location header — try following redirect
        const followRes = await fetchFn('https://smee.io/new', { redirect: 'follow' });
        channelUrl = followRes.url;
      }
      if (!channelUrl || !channelUrl.startsWith('https://smee.io/')) {
        res.status(502).json({ error: 'smee_channel_failed' });
        return;
      }
    } catch (err) {
      res.status(502).json({ error: 'smee_unreachable', detail: String(err) });
      return;
    }

    const secret = crypto.randomBytes(20).toString('hex');

    const config = getConfig();
    if (!config.github) config.github = {};
    config.github.webhookSecret = secret;
    config.github.smeeUrl = channelUrl;
    config.github.backfillOffered = false; // reset so backfill banner shows after fresh setup
    saveConfig(configPath, config);

    // Start smee client — non-blocking
    startSmee(channelUrl, config.port ?? 3456);

    res.json({ ok: true, smeeUrl: channelUrl });
  });

  // ── DELETE /setup — Teardown: delete all tracked webhooks, clear config, stop smee ──

  router.delete('/setup', async (_req: Request, res: ExpressResponse) => {
    const config = getConfig();
    const token = config.github?.accessToken;
    let deleted = 0;

    if (token && config.repoSettings) {
      const entries = Object.entries(config.repoSettings);
      for (const [repoPath, ws] of entries) {
        const webhookId = ws.webhookId;
        if (!webhookId) continue;

        const ownerRepo = await getOwnerRepoForPath(repoPath);
        if (!ownerRepo) continue;

        const parts = ownerRepo.split('/');
        const owner = parts[0];
        const repo = parts[1];
        if (!owner || !repo) continue;

        try {
          await githubApi('DELETE', `/repos/${owner}/${repo}/hooks/${webhookId}`, token);
          deleted++;
        } catch (err) {
          console.warn(`[webhook-manager] Failed to delete webhook ${webhookId} for ${ownerRepo}:`, err);
        }
      }

      // Clear webhook fields from all repo settings
      for (const ws of Object.values(config.repoSettings)) {
        delete ws.webhookId;
        delete ws.webhookEnabled;
        delete ws.webhookError;
      }
    }

    // Clear github webhook config fields
    if (config.github) {
      delete config.github.webhookSecret;
      delete config.github.smeeUrl;
      delete config.github.autoProvision;
      delete config.github.backfillOffered;
    }
    saveConfig(configPath, config);

    stopSmee();

    res.json({ ok: true, deleted });
  });

  // ── GET /status — Health endpoint ──

  router.get('/status', (_req: Request, res: ExpressResponse) => {
    const config = getConfig();
    const github = config.github;
    const configured = Boolean(github?.webhookSecret && github?.smeeUrl);
    const { smeeConnected: sc, lastEventAt: lea } = getSmeeStatus();
    const secret = github?.webhookSecret ?? null;
    const secretPreview = secret ? `****${secret.slice(-4)}` : null;

    res.json({
      configured,
      smeeConnected: sc,
      lastEventAt: lea,
      autoProvision: github?.autoProvision ?? false,
      secretPreview,
    });
  });

  // ── POST /reload — Hot-reload smee client ──

  router.post('/reload', (_req: Request, res: ExpressResponse) => {
    const config = getConfig();
    const smeeUrl = config.github?.smeeUrl;
    stopSmee();
    if (smeeUrl) {
      startSmee(smeeUrl, config.port ?? 3456);
    }
    res.json({ ok: true });
  });

  // ── POST /ping — Test connection via GitHub ping API ──

  router.post('/ping', async (_req: Request, res: ExpressResponse) => {
    const config = getConfig();
    const token = config.github?.accessToken;

    if (!token) {
      res.status(400).json({ error: 'not_authenticated' });
      return;
    }

    // Find first workspace with a webhookId
    let foundOwnerRepo: string | null = null;
    let foundWebhookId: number | null = null;

    if (config.repoSettings) {
      for (const [repoPath, ws] of Object.entries(config.repoSettings)) {
        if (!ws.webhookId) continue;
        const ownerRepo = await getOwnerRepoForPath(repoPath);
        if (ownerRepo) {
          foundOwnerRepo = ownerRepo;
          foundWebhookId = ws.webhookId;
          break;
        }
      }
    }

    if (!foundOwnerRepo || !foundWebhookId) {
      res.json({ error: 'no_webhook' });
      return;
    }

    const parts = foundOwnerRepo.split('/');
    const owner = parts[0];
    const repo = parts[1];
    if (!owner || !repo) {
      res.json({ error: 'no_webhook' });
      return;
    }

    try {
      const pingRes = await githubApi(
        'POST',
        `/repos/${owner}/${repo}/hooks/${foundWebhookId}/pings`,
        token,
      );
      if (pingRes.ok || pingRes.status === 204) {
        res.json({ ok: true });
      } else {
        res.status(pingRes.status).json({ error: 'ping_failed', status: pingRes.status });
      }
    } catch (err) {
      res.status(502).json({ error: 'ping_failed', detail: String(err) });
    }
  });

  // ── POST /repos — Create webhook for a specific repo ──

  router.post('/repos', async (req: Request, res: ExpressResponse) => {
    const body = req.body as { repoPath?: unknown };
    const repoPath = body.repoPath;
    if (!repoPath || typeof repoPath !== 'string') {
      res.status(400).json({ error: 'missing_repo_path' });
      return;
    }

    const config = getConfig();
    const result = await createWebhookForPath(repoPath, configPath, config, githubApi);

    if (result.ok) {
      res.json({ ok: true, webhookId: result.webhookId });
    } else {
      const status = result.webhookError === 'not-admin' ? 403 : 400;
      res.status(status).json({ error: result.error, webhookError: result.webhookError });
    }
  });

  // ── POST /repos/remove — Remove webhook for a specific repo ──

  router.post('/repos/remove', async (req: Request, res: ExpressResponse) => {
    const body = req.body as { repoPath?: unknown };
    const repoPath = body.repoPath;
    if (!repoPath || typeof repoPath !== 'string') {
      res.status(400).json({ error: 'missing_repo_path' });
      return;
    }

    const config = getConfig();
    const token = config.github?.accessToken;
    const ws = config.repoSettings?.[repoPath];
    const webhookId = ws?.webhookId;

    if (!webhookId) {
      res.json({ ok: true });
      return;
    }

    if (token) {
      const ownerRepo = await getOwnerRepoForPath(repoPath);
      if (ownerRepo) {
        const parts = ownerRepo.split('/');
        const owner = parts[0];
        const repo = parts[1];
        if (owner && repo) {
          try {
            const delRes = await githubApi(
              'DELETE',
              `/repos/${owner}/${repo}/hooks/${webhookId}`,
              token,
            );
            // 404 is fine — webhook already gone
            if (!delRes.ok && delRes.status !== 404) {
              console.warn(`[webhook-manager] DELETE hook returned ${delRes.status}`);
            }
          } catch (err) {
            console.warn('[webhook-manager] Failed to delete webhook via API:', err);
          }
        }
      }
    }

    // Clear local webhook state regardless of API result
    if (config.repoSettings?.[repoPath]) {
      const wsEntry = config.repoSettings[repoPath]!;
      delete wsEntry.webhookId;
      delete wsEntry.webhookEnabled;
      delete wsEntry.webhookError;
    }
    saveConfig(configPath, config);

    res.json({ ok: true });
  });

  // ── POST /backfill — Create webhooks for all workspaces ──

  router.post('/backfill', async (_req: Request, res: ExpressResponse) => {
    const config = getConfig();
    const workspacePaths = config.workspaces ?? [];

    if (workspacePaths.length === 0) {
      res.json({ total: 0, success: 0, failed: 0, results: [] });
      return;
    }

    // Build repo map to confirm which paths have valid git remotes
    const execFn = (file: string, args: string[], opts: { cwd: string; timeout?: number }) =>
      execFileAsync(file, args, opts);

    const repoMap = await buildRepoMap(workspacePaths, execFn);

    type BackfillResult = { path: string; ownerRepo: string | null; ok: boolean; error?: string };
    const results: BackfillResult[] = [];

    // Bounded concurrency: 5 at a time
    const CONCURRENCY = 5;
    const paths = [...workspacePaths];

    for (let i = 0; i < paths.length; i += CONCURRENCY) {
      const batch = paths.slice(i, i + CONCURRENCY);
      const batchResults = await Promise.all(
        batch.map(async (wsPath): Promise<BackfillResult> => {
          // Find ownerRepo from the map by value
          let ownerRepo: string | null = null;
          for (const [key, val] of repoMap) {
            if (val === wsPath) {
              ownerRepo = key;
              break;
            }
          }

          if (!ownerRepo) {
            return { path: wsPath, ownerRepo: null, ok: false, error: 'no_remote' };
          }

          // Reload config for each path to pick up writes from previous batch items
          const freshConfig = getConfig();
          const result = await createWebhookForPath(wsPath, configPath, freshConfig, githubApi);
          if (result.ok) {
            return { path: wsPath, ownerRepo, ok: true };
          } else {
            return { path: wsPath, ownerRepo, ok: false, error: result.error };
          }
        }),
      );
      results.push(...batchResults);
    }

    const success = results.filter((r) => r.ok).length;
    const failed = results.filter((r) => !r.ok).length;

    // Mark backfill as offered so the banner doesn't re-show
    const updatedConfig = getConfig();
    if (updatedConfig.github) {
      updatedConfig.github.backfillOffered = true;
      saveConfig(configPath, updatedConfig);
    }

    res.json({ total: paths.length, success, failed, results });
  });

  return router;
}
