import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import type { Request, Response } from 'express';

import type { AccountTelemetry, Session, TelemetryData } from './types.js';
import type { TelemetryAdapter, TelemetryDeps } from './telemetry-adapter.js';
import { getAdapterForFramework } from './telemetry-adapter.js';
import { ClaudeTelemetryAdapter } from './adapters/claude-telemetry.js';
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
  for (let i = 0; i < a.rateLimits.length; i++) {
    const ar = a.rateLimits[i];
    const br = b.rateLimits[i];
    if (!ar || !br) return false;
    if (
      ar.name !== br.name ||
      ar.usedPercent !== br.usedPercent ||
      ar.resetsAt !== br.resetsAt
    ) {
      return false;
    }
  }
  return true;
}

function createAdapterForSession(
  session: Pick<Session, 'id'> & { agent?: string },
  deps: TelemetryDeps
): TelemetryAdapter | null {
  try {
    const frameworkId = (session as Session).agent ?? 'claude';
    const adapter = getAdapterForFramework(frameworkId, deps);
    if (adapter) {
      adapter.attach(session as Session);
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

function collectTelemetry(): void {
  if (!activeDeps) return;

  const activeSessions = activeDeps.getActiveSessions();
  const activeSessionIds = new Set(activeSessions.map((session) => session.id));

  if (activeSessionIds.size > 0) {
    restoredPendingOnly = false;
    for (const sessionId of [...sessionTelemetry.keys()]) {
      if (!activeSessionIds.has(sessionId)) {
        sessionTelemetry.delete(sessionId);
      }
    }
    // Detach and remove adapters for ended sessions
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
  } else if (!restoredPendingOnly) {
    sessionTelemetry = new Map();
    sessionAdapters.clear();
  }

  for (const session of activeSessions) {
    // Get or create adapter for this session
    let adapter = sessionAdapters.get(session.id);
    if (!adapter) {
      adapter = createAdapterForSession(session, activeDeps) ?? undefined;
      if (adapter) {
        sessionAdapters.set(session.id, adapter);
      }
    }

    if (!adapter) continue;

    const snapshot = adapter.collectSnapshot(session.id);
    if (!snapshot) continue;

    const { updatedAt: _u, ...snapshotWithoutUpdatedAt } = snapshot;

    if (!sameTelemetry(sessionTelemetry.get(session.id), snapshotWithoutUpdatedAt)) {
      sessionTelemetry.set(session.id, snapshot);
      activeDeps.broadcastEvent('session-telemetry', {
        sessionId: session.id,
        data: snapshot,
      });
    }

    // Poll account telemetry from adapter (side channel)
    if (adapter instanceof ClaudeTelemetryAdapter) {
      const adapterAccount = adapter.getAccountTelemetry();
      if (adapterAccount) {
        const existing = accountTelemetryMap.get(adapterAccount.framework);
        if (!sameAccountTelemetry(existing, adapterAccount)) {
          accountTelemetryMap.set(adapterAccount.framework, adapterAccount);
          activeDeps.broadcastEvent('account-telemetry', {
            data: adapterAccount,
          });
        }
      }
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
