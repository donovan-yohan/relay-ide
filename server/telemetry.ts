import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import type { Request, Response } from 'express';

import type { AccountTelemetry, Session, TelemetryData } from './types.js';

const POLL_INTERVAL_MS = 2_000;
const PERSIST_INTERVAL_MS = 60_000;
const STALE_THRESHOLD_MS = 5 * 60 * 1000;

interface PendingTelemetryFile {
  version: number;
  timestamp: string;
  sessions: Record<string, TelemetryData>;
  account: AccountTelemetry | null;
}

type IncomingTelemetryData = Omit<TelemetryData, 'updatedAt'>;

export interface TelemetryDeps {
  getActiveSessions: () => Array<Pick<Session, 'id'>>;
  broadcastEvent: (type: string, data?: Record<string, unknown>) => void;
  configDir: string;
}

let activeDeps: TelemetryDeps | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let persistTimer: ReturnType<typeof setInterval> | null = null;
let sessionTelemetry = new Map<string, TelemetryData>();
let accountTelemetry: AccountTelemetry | null = null;
let restoredPendingOnly = false;

function telemetryDir(configDir: string): string {
  return path.join(configDir, 'telemetry');
}

function pendingFilePath(configDir: string): string {
  return path.join(configDir, 'pending-telemetry.json');
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function telemetryToObject(): Record<string, TelemetryData> {
  return Object.fromEntries(sessionTelemetry.entries());
}

function sameTelemetry(a: TelemetryData | undefined, b: IncomingTelemetryData): boolean {
  if (!a) return false;
  return a.sessionId === b.sessionId
    && a.model === b.model
    && a.totalInputTokens === b.totalInputTokens
    && a.totalOutputTokens === b.totalOutputTokens
    && a.totalCacheRead === b.totalCacheRead
    && a.totalCacheWrite === b.totalCacheWrite
    && a.contextPercent === b.contextPercent
    && a.contextWindowSize === b.contextWindowSize
    && a.costUsd === b.costUsd
    && a.source === b.source;
}

function sameAccountTelemetry(a: AccountTelemetry | null, b: Omit<AccountTelemetry, 'updatedAt'>): boolean {
  if (!a) return false;
  return a.fiveHourUsedPercent === b.fiveHourUsedPercent
    && a.fiveHourResetsAt === b.fiveHourResetsAt
    && a.sevenDayUsedPercent === b.sevenDayUsedPercent
    && a.sevenDayResetsAt === b.sevenDayResetsAt;
}

function extractTelemetry(sessionId: string, payload: unknown): {
  session: IncomingTelemetryData;
  account: Omit<AccountTelemetry, 'updatedAt'> | null;
} | null {
  if (!payload || typeof payload !== 'object') return null;

  const data = payload as Record<string, unknown>;
  const contextWindow = (data.context_window ?? {}) as Record<string, unknown>;
  const currentUsage = (contextWindow.current_usage ?? {}) as Record<string, unknown>;
  const cost = (data.cost ?? {}) as Record<string, unknown>;
  const rateLimits = (data.rate_limits ?? {}) as Record<string, unknown>;
  const fiveHour = (rateLimits.five_hour ?? {}) as Record<string, unknown>;
  const sevenDay = (rateLimits.seven_day ?? {}) as Record<string, unknown>;
  const model = (data.model ?? {}) as Record<string, unknown>;

  const session: IncomingTelemetryData = {
    sessionId,
    model: typeof model.display_name === 'string' ? model.display_name : null,
    totalInputTokens: asNumber(contextWindow.total_input_tokens, 0),
    totalOutputTokens: asNumber(contextWindow.total_output_tokens, 0),
    totalCacheRead: asNumber(currentUsage.cache_read_input_tokens, 0),
    totalCacheWrite: asNumber(currentUsage.cache_creation_input_tokens, 0),
    contextPercent: asNumber(contextWindow.used_percentage, -1),
    contextWindowSize: asNumber(contextWindow.context_window_size, 0),
    costUsd: typeof cost.total_cost_usd === 'number' ? cost.total_cost_usd : null,
    source: 'statusLine',
  };

  const account = (
    typeof fiveHour.used_percentage === 'number'
    || typeof sevenDay.used_percentage === 'number'
    || typeof fiveHour.resets_at === 'string'
    || typeof sevenDay.resets_at === 'string'
  ) ? {
    fiveHourUsedPercent: asNumber(fiveHour.used_percentage, -1),
    fiveHourResetsAt: asString(fiveHour.resets_at),
    sevenDayUsedPercent: asNumber(sevenDay.used_percentage, -1),
    sevenDayResetsAt: asString(sevenDay.resets_at),
  } : null;

  return { session, account };
}

function restorePendingTelemetry(configDir: string): void {
  const pendingPath = pendingFilePath(configDir);
  if (!fs.existsSync(pendingPath)) return;

  try {
    const pending = JSON.parse(fs.readFileSync(pendingPath, 'utf-8')) as PendingTelemetryFile;
    const ageMs = Date.now() - new Date(pending.timestamp).getTime();
    if (!Number.isFinite(ageMs) || ageMs > STALE_THRESHOLD_MS) {
      fs.unlinkSync(pendingPath);
      return;
    }

    sessionTelemetry = new Map(Object.entries(pending.sessions ?? {}));
    accountTelemetry = pending.account ?? null;
    restoredPendingOnly = sessionTelemetry.size > 0 || accountTelemetry !== null;
    fs.unlinkSync(pendingPath);
  } catch {
    try { fs.unlinkSync(pendingPath); } catch { /* ignore */ }
  }
}

function persistPendingTelemetry(configDir: string): void {
  const payload: PendingTelemetryFile = {
    version: 1,
    timestamp: new Date().toISOString(),
    sessions: telemetryToObject(),
    account: accountTelemetry,
  };
  const filePath = pendingFilePath(configDir);

  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf-8');
  } catch (err) {
    console.warn('[telemetry] Failed to persist pending telemetry:', err);
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
  } else if (!restoredPendingOnly) {
    sessionTelemetry = new Map();
  }

  for (const session of activeSessions) {
    const filePath = path.join(telemetryDir(activeDeps.configDir), `${session.id}.json`);
    let raw: string;
    try {
      raw = fs.readFileSync(filePath, 'utf-8');
    } catch (err) {
      const error = err as NodeJS.ErrnoException;
      if (error.code !== 'ENOENT') {
        console.warn(`[telemetry] Failed to read telemetry for session ${session.id}:`, err);
      }
      continue;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch (err) {
      console.warn(`[telemetry] Malformed telemetry JSON for session ${session.id}:`, err);
      continue;
    }

    const extracted = extractTelemetry(session.id, payload);
    if (!extracted) continue;

    if (!sameTelemetry(sessionTelemetry.get(session.id), extracted.session)) {
      const nextSessionTelemetry: TelemetryData = {
        ...extracted.session,
        updatedAt: new Date().toISOString(),
      };
      sessionTelemetry.set(session.id, nextSessionTelemetry);
      activeDeps.broadcastEvent('session-telemetry', { sessionId: session.id, data: nextSessionTelemetry });
    }

    if (extracted.account && !sameAccountTelemetry(accountTelemetry, extracted.account)) {
      accountTelemetry = {
        ...extracted.account,
        updatedAt: new Date().toISOString(),
      };
      activeDeps.broadcastEvent('account-telemetry', { data: accountTelemetry });
    }
  }
}

export function startTelemetry(deps: TelemetryDeps): void {
  stopTelemetry();
  activeDeps = deps;
  restorePendingTelemetry(deps.configDir);
  collectTelemetry();
  pollTimer = setInterval(collectTelemetry, POLL_INTERVAL_MS);
  persistTimer = setInterval(() => persistPendingTelemetry(deps.configDir), PERSIST_INTERVAL_MS);
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
  accountTelemetry = null;
  restoredPendingOnly = false;
}

export function getTelemetryForSession(sessionId: string): TelemetryData | undefined {
  return sessionTelemetry.get(sessionId);
}

export function getAccountTelemetry(): AccountTelemetry | null {
  return accountTelemetry;
}

export function createTelemetryRouter(): Router {
  const router = Router();

  router.get('/sessions', (_req: Request, res: Response) => {
    res.json(telemetryToObject());
  });

  router.get('/account', (_req: Request, res: Response) => {
    res.json(accountTelemetry);
  });

  router.get('/setup-status', (_req: Request, res: Response) => {
    res.json({ installed: activeDeps !== null });
  });

  return router;
}
