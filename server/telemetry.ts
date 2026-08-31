import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import type { Request, Response } from 'express';

import type { AccountTelemetry, Session, TelemetryData } from './types.js';
import type { GlobalSessionId, NodeId } from '../shared/identity.js';
import { createLogger } from './logger.js';
import { createGlobalSessionId } from '../shared/identity.js';

/**
 * The subset of a session the telemetry poller needs to key its snapshots.
 * Inlined here when the unwired per-framework telemetry adapter registry
 * (`server/telemetry-adapter.ts`) was removed as obsolete (#1483); this module
 * was its only surviving consumer.
 */
export type TelemetrySession = Pick<Session, 'id'> & {
  nodeId?: NodeId;
  globalSessionId?: GlobalSessionId;
};

export interface TelemetryDeps {
  getActiveSessions: () => TelemetrySession[];
  broadcastEvent: (type: string, data?: Record<string, unknown>) => void;
  configDir: string;
}

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

let activeDeps: TelemetryDeps | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let persistTimer: ReturnType<typeof setInterval> | null = null;
let sessionTelemetry = new Map<string, TelemetryData>();
// Map from frameworkId -> AccountTelemetry
let accountTelemetryMap = new Map<string, AccountTelemetry>();
let restoredPendingOnly = false;

function pendingFilePath(configDir: string): string {
  return path.join(configDir, 'pending-telemetry.json');
}

function telemetryToObject(): Record<string, TelemetryData> {
  const activeSessionsById = new Map(
    (activeDeps?.getActiveSessions() ?? []).map((session) => [
      session.id,
      session,
    ])
  );
  const result: Record<string, TelemetryData> = {};
  for (const [sessionId, telemetry] of Array.from(sessionTelemetry.entries())) {
    const session = activeSessionsById.get(sessionId);
    const globalSessionId =
      session?.globalSessionId ??
      (session?.nodeId
        ? createGlobalSessionId(session.nodeId, sessionId)
        : undefined);
    const telemetryKey = globalSessionId ?? sessionId;
    result[telemetryKey] = {
      ...telemetry,
      sessionId,
      ...(globalSessionId || session?.nodeId
        ? { localSessionId: sessionId }
        : {}),
      ...(session?.nodeId ? { nodeId: session.nodeId } : {}),
      ...(globalSessionId ? { globalSessionId } : {}),
    };
  }
  return result;
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
  activeDeps = null;
  sessionTelemetry = new Map();
  accountTelemetryMap = new Map();
  restoredPendingOnly = false;
}

export function getTelemetryForSession(
  sessionId: string
): TelemetryData | undefined {
  return sessionTelemetry.get(sessionId);
}

export function getAccountTelemetry(): Record<string, AccountTelemetry> {
  return Object.fromEntries(accountTelemetryMap.entries());
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
