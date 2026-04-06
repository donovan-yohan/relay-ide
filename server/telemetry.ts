import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import type { Request, Response } from 'express';

import type { AccountTelemetry, TelemetryData } from './types.js';
import type {
  TelemetryAdapter,
  TelemetryDeps,
  TelemetrySession,
} from './telemetry-adapter.js';
import { getAdapterForFramework } from './telemetry-adapter.js';
// Side-effect imports: register adapters in the adapter registry
import './adapters/claude-telemetry.js';
import './adapters/opencode-telemetry.js';
import { createLogger } from './logger.js';

// Re-export TelemetryDeps from telemetry-adapter for backward compat
export type { TelemetryDeps } from './telemetry-adapter.js';

const logger = createLogger('telemetry');

const POLL_INTERVAL_MS = 2_000;
const PERSIST_INTERVAL_MS = 60_000;
const STALE_THRESHOLD_MS = 5 * 60 * 1000;

interface PendingTelemetryFile {
  version: number;
  timestamp: string;
  sessions: Record<string, TelemetryData>;
  account: Record<string, AccountTelemetry> | null;
}

type IncomingTelemetryData = Omit<TelemetryData, 'updatedAt'>;

let activeDeps: TelemetryDeps | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let persistTimer: ReturnType<typeof setInterval> | null = null;
let sessionTelemetry = new Map<string, TelemetryData>();
// Map from frameworkId -> AccountTelemetry
let accountTelemetryMap = new Map<string, AccountTelemetry>();
// Per-session adapter instances (keyed by sessionId)
let sessionAdapters = new Map<string, TelemetryAdapter>();
let restoredPendingOnly = false;

function pendingFilePath(configDir: string): string {
  return path.join(configDir, 'pending-telemetry.json');
}

function telemetryToObject(): Record<string, TelemetryData> {
  return Object.fromEntries(sessionTelemetry.entries());
}

function sameTelemetry(
  a: TelemetryData | undefined,
  b: IncomingTelemetryData
): boolean {
  if (!a) return false;
  return (
    a.sessionId === b.sessionId &&
    a.model === b.model &&
    a.totalInputTokens === b.totalInputTokens &&
    a.totalOutputTokens === b.totalOutputTokens &&
    a.totalCacheRead === b.totalCacheRead &&
    a.totalCacheWrite === b.totalCacheWrite &&
    a.reasoningOutputTokens === b.reasoningOutputTokens &&
    a.contextPercent === b.contextPercent &&
    a.contextWindowSize === b.contextWindowSize &&
    a.costUsd === b.costUsd &&
    a.source === b.source
  );
}

function sameAccountTelemetry(
  a: AccountTelemetry | undefined,
  b: AccountTelemetry
): boolean {
  if (!a) return false;
  if (a.framework !== b.framework) return false;
  if (a.rateLimits.length !== b.rateLimits.length) return false;
  return b.rateLimits.every((br) => {
    const ar = a.rateLimits.find((r) => r.name === br.name);
    if (!ar) return false;
    return (
      ar.usedPercent === br.usedPercent &&
      ar.resetsAt === br.resetsAt &&
      ar.windowMinutes === br.windowMinutes
    );
  });
}

function createAdapterForSession(
  session: TelemetrySession & { agent?: string },
  deps: TelemetryDeps
): TelemetryAdapter | null {
  try {
    const frameworkId = session.agent ?? 'claude';
    const adapter = getAdapterForFramework(frameworkId, deps);
    if (adapter) {
      adapter.attach(session);
    }
    return adapter;
  } catch (err) {
    logger.warn(`Failed to create adapter for session ${session.id}:`, err);
    return null;
  }
}

function restorePendingTelemetry(configDir: string): void {
  const pendingPath = pendingFilePath(configDir);
  if (!fs.existsSync(pendingPath)) return;

  try {
    const pending = JSON.parse(
      fs.readFileSync(pendingPath, 'utf-8')
    ) as PendingTelemetryFile;

    // Reject v1 files — new format (v2) required
    if (pending.version !== 2) {
      fs.unlinkSync(pendingPath);
      return;
    }

    const ageMs = Date.now() - new Date(pending.timestamp).getTime();
    if (!Number.isFinite(ageMs) || ageMs > STALE_THRESHOLD_MS) {
      fs.unlinkSync(pendingPath);
      return;
    }

    sessionTelemetry = new Map(Object.entries(pending.sessions ?? {}));

    // Restore account telemetry map (v2 format: Record<frameworkId, AccountTelemetry>)
    if (pending.account && typeof pending.account === 'object') {
      for (const [frameworkId, acct] of Object.entries(pending.account)) {
        if (acct && typeof acct === 'object' && 'framework' in acct) {
          accountTelemetryMap.set(frameworkId, acct as AccountTelemetry);
        }
      }
    }

    restoredPendingOnly =
      sessionTelemetry.size > 0 || accountTelemetryMap.size > 0;
    fs.unlinkSync(pendingPath);
  } catch {
    try {
      fs.unlinkSync(pendingPath);
    } catch {
      /* ignore */
    }
  }
}

function persistPendingTelemetry(configDir: string): void {
  const payload: PendingTelemetryFile = {
    version: 2,
    timestamp: new Date().toISOString(),
    sessions: telemetryToObject(),
    account:
      accountTelemetryMap.size > 0
        ? Object.fromEntries(accountTelemetryMap.entries())
        : null,
  };
  const filePath = pendingFilePath(configDir);

  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf-8');
  } catch (err) {
    logger.warn('Failed to persist pending telemetry:', err);
  }
}

function pruneEndedSessions(activeSessionIds: Set<string>): void {
  for (const sessionId of [...sessionTelemetry.keys()]) {
    if (!activeSessionIds.has(sessionId)) {
      sessionTelemetry.delete(sessionId);
    }
  }
  for (const [sessionId, adapter] of [...sessionAdapters.entries()]) {
    if (!activeSessionIds.has(sessionId)) {
      try {
        adapter.detach(sessionId);
      } catch {
        /* ignore cleanup errors */
      }
      sessionAdapters.delete(sessionId);
    }
  }
}

function getOrCreateAdapter(
  session: TelemetrySession,
  deps: TelemetryDeps
): TelemetryAdapter | undefined {
  let adapter = sessionAdapters.get(session.id);
  if (!adapter) {
    adapter = createAdapterForSession(session, deps) ?? undefined;
    if (adapter) {
      sessionAdapters.set(session.id, adapter);
    }
  }
  return adapter;
}

function pollSessionTelemetry(
  adapter: TelemetryAdapter,
  sessionId: string,
  deps: TelemetryDeps
): void {
  const snapshot = adapter.collectSnapshot(sessionId);
  if (!snapshot) return;

  const { updatedAt: _u, ...incoming } = snapshot;
  if (!sameTelemetry(sessionTelemetry.get(sessionId), incoming)) {
    sessionTelemetry.set(sessionId, snapshot);
    deps.broadcastEvent('session-telemetry', { sessionId, data: snapshot });
  }

  const adapterAccount = adapter.collectAccountTelemetry?.();
  if (
    adapterAccount &&
    !sameAccountTelemetry(
      accountTelemetryMap.get(adapterAccount.framework),
      adapterAccount
    )
  ) {
    accountTelemetryMap.set(adapterAccount.framework, adapterAccount);
    deps.broadcastEvent('account-telemetry', { data: adapterAccount });
  }
}

function collectTelemetry(): void {
  if (!activeDeps) return;

  const activeSessions = activeDeps.getActiveSessions();
  const activeSessionIds = new Set(activeSessions.map((s) => s.id));

  if (activeSessionIds.size > 0) {
    restoredPendingOnly = false;
    pruneEndedSessions(activeSessionIds);
  } else if (!restoredPendingOnly) {
    sessionTelemetry = new Map();
    sessionAdapters.clear();
  }

  for (const session of activeSessions) {
    const adapter = getOrCreateAdapter(session, activeDeps);
    if (adapter) {
      pollSessionTelemetry(adapter, session.id, activeDeps);
    }
  }
}

export function startTelemetry(deps: TelemetryDeps): void {
  stopTelemetry();
  activeDeps = deps;
  restorePendingTelemetry(deps.configDir);
  collectTelemetry();
  pollTimer = setInterval(collectTelemetry, POLL_INTERVAL_MS);
  persistTimer = setInterval(
    () => persistPendingTelemetry(deps.configDir),
    PERSIST_INTERVAL_MS
  );
}

export function stopTelemetry(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  if (persistTimer) {
    clearInterval(persistTimer);
    persistTimer = null;
  }
  if (activeDeps) {
    persistPendingTelemetry(activeDeps.configDir);
  }
  // Detach all adapters
  for (const [sessionId, adapter] of sessionAdapters.entries()) {
    try {
      adapter.detach(sessionId);
    } catch {
      /* ignore */
    }
  }
  activeDeps = null;
  sessionTelemetry = new Map();
  accountTelemetryMap = new Map();
  sessionAdapters = new Map();
  restoredPendingOnly = false;
}

export function getTelemetryForSession(
  sessionId: string
): TelemetryData | undefined {
  return sessionTelemetry.get(sessionId);
}

export function getAccountTelemetry(): AccountTelemetry | null {
  // Prefer 'claude' framework; fall back to first available
  return (
    accountTelemetryMap.get('claude') ??
    accountTelemetryMap.values().next().value ??
    null
  );
}

export function createTelemetryRouter(): Router {
  const router = Router();

  router.get('/sessions', (_req: Request, res: Response) => {
    res.json(telemetryToObject());
  });

  router.get('/account', (_req: Request, res: Response) => {
    res.json(getAccountTelemetry());
  });

  router.get('/setup-status', (_req: Request, res: Response) => {
    res.json({ installed: activeDeps !== null });
  });

  return router;
}
