import { create } from 'zustand';
import * as api from '../api.js';
import type {
  AccountTelemetry,
  Repo,
  SessionSummary,
  SessionTelemetry,
} from '../types.js';
import {
  mergeAccountTelemetrySnapshot,
  mergeAccountTelemetryByFrameworkSnapshot,
  mergeSessionTelemetrySnapshot,
  pickNewerAccountTelemetry,
  pickNewerSessionTelemetry,
} from '../telemetry-sync.js';

export interface TelemetryAggregate {
  trackedSessions: number;
  totalSessions: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheRead: number;
  totalCacheWrite: number;
  totalCostUsd: number | null;
  averageContextPercent: number | null;
  maxContextPercent: number | null;
}

export interface RepoTelemetrySummary {
  repoPath: string;
  repoName: string;
  aggregate: TelemetryAggregate;
}

export interface OrgTelemetrySummary {
  repos: RepoTelemetrySummary[];
  outsideRelay: TelemetryAggregate;
}

function emptyAggregate(totalSessions = 0): TelemetryAggregate {
  return {
    trackedSessions: 0,
    totalSessions,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheRead: 0,
    totalCacheWrite: 0,
    totalCostUsd: null,
    averageContextPercent: null,
    maxContextPercent: null,
  };
}

function mergeCost(current: number | null, next: number | null): number | null {
  if (current === null) return next;
  if (next === null) return current;
  return current + next;
}

function buildAggregate(
  sessions: SessionSummary[],
  telemetryById: Record<string, SessionTelemetry>
): TelemetryAggregate {
  const aggregate = emptyAggregate(sessions.length);
  let contextPercentTotal = 0;
  let contextPercentCount = 0;

  for (const session of sessions) {
    const telemetry = telemetryById[session.id];
    if (!telemetry) continue;
    aggregate.trackedSessions += 1;
    aggregate.totalInputTokens += telemetry.totalInputTokens || 0;
    aggregate.totalOutputTokens += telemetry.totalOutputTokens || 0;
    aggregate.totalCacheRead += telemetry.totalCacheRead || 0;
    aggregate.totalCacheWrite += telemetry.totalCacheWrite || 0;
    aggregate.totalCostUsd = mergeCost(
      aggregate.totalCostUsd,
      telemetry.costUsd
    );
    if (telemetry.contextPercent >= 0) {
      contextPercentTotal += telemetry.contextPercent;
      contextPercentCount += 1;
      aggregate.maxContextPercent =
        aggregate.maxContextPercent === null
          ? telemetry.contextPercent
          : Math.max(aggregate.maxContextPercent, telemetry.contextPercent);
    }
  }

  if (contextPercentCount > 0) {
    aggregate.averageContextPercent = contextPercentTotal / contextPercentCount;
  }

  return aggregate;
}

function normalizeSessionTelemetry(
  sessionId: string,
  data: Partial<SessionTelemetry>
): SessionTelemetry {
  return {
    sessionId,
    model:
      typeof data.model === 'string' || data.model === null
        ? (data.model ?? null)
        : null,
    totalInputTokens:
      typeof data.totalInputTokens === 'number' ? data.totalInputTokens : 0,
    totalOutputTokens:
      typeof data.totalOutputTokens === 'number' ? data.totalOutputTokens : 0,
    totalCacheRead:
      typeof data.totalCacheRead === 'number' ? data.totalCacheRead : 0,
    totalCacheWrite:
      typeof data.totalCacheWrite === 'number' ? data.totalCacheWrite : 0,
    contextPercent:
      typeof data.contextPercent === 'number' ? data.contextPercent : -1,
    contextWindowSize:
      typeof data.contextWindowSize === 'number' ? data.contextWindowSize : 0,
    costUsd: typeof data.costUsd === 'number' ? data.costUsd : null,
    turnCount: typeof data.turnCount === 'number' ? data.turnCount : 0,
    subagentCount:
      typeof data.subagentCount === 'number' ? data.subagentCount : 0,
    source: typeof data.source === 'string' ? data.source : 'statusLine',
    updatedAt:
      typeof data.updatedAt === 'string'
        ? data.updatedAt
        : new Date().toISOString(),
  };
}

function normalizeAccountTelemetry(
  data: Partial<AccountTelemetry>
): AccountTelemetry {
  return {
    framework: typeof data.framework === 'string' ? data.framework : 'unknown',
    rateLimits: Array.isArray(data.rateLimits) ? data.rateLimits : [],
    planType: typeof data.planType === 'string' ? data.planType : undefined,
    updatedAt:
      typeof data.updatedAt === 'string'
        ? data.updatedAt
        : new Date().toISOString(),
  };
}

export interface TelemetryState {
  sessionTelemetryById: Record<string, SessionTelemetry>;
  accountTelemetryByFramework: Record<string, AccountTelemetry>;
  telemetrySetupInstalled: boolean | null;
  summarizeSessionSetTelemetry: (
    sessions: SessionSummary[]
  ) => TelemetryAggregate;
  summarizeReposTelemetry: (
    repos: Repo[],
    sessions: SessionSummary[]
  ) => OrgTelemetrySummary;
  summarizeSessionTelemetry: (sessionId: string) => SessionTelemetry | null;
  setSessionTelemetry: (data: SessionTelemetry) => void;
  setSessionTelemetryBatch: (
    items: SessionTelemetry[],
    requestStartedAt?: string
  ) => void;
  clearSessionTelemetry: (sessionId: string) => void;
  pruneSessionTelemetry: (activeSessionIds: Iterable<string>) => void;
  setAccountTelemetrySnapshot: (
    data: Record<string, AccountTelemetry> | null,
    requestStartedAt?: string
  ) => void;
  getAccountTelemetry: (framework?: string) => AccountTelemetry | null;
  setTelemetrySetupInstalled: (installed: boolean | null) => void;
  handleSessionTelemetryEvent: (
    sessionId: string,
    data: SessionTelemetry | Record<string, unknown>
  ) => void;
  handleAccountTelemetryEvent: (
    data: AccountTelemetry | Record<string, unknown> | null
  ) => void;
  refreshTelemetry: () => Promise<void>;
}

export const useTelemetryStore = create<TelemetryState>()((set, get) => ({
  sessionTelemetryById: {},
  accountTelemetryByFramework: {},
  telemetrySetupInstalled: null,

  summarizeSessionSetTelemetry: (sessions) =>
    buildAggregate(sessions, get().sessionTelemetryById),

  summarizeReposTelemetry: (repos, sessions) => {
    const { sessionTelemetryById } = get();
    const sessionsByRepo = new Map<string, SessionSummary[]>();
    for (const session of sessions) {
      const bucket = sessionsByRepo.get(session.repoPath) ?? [];
      bucket.push(session);
      sessionsByRepo.set(session.repoPath, bucket);
    }
    const repoSummaries = repos.map((repo) => ({
      repoPath: repo.path,
      repoName: repo.name,
      aggregate: buildAggregate(
        sessionsByRepo.get(repo.path) ?? [],
        sessionTelemetryById
      ),
    }));
    const outsideRelaySessions = sessions.filter(
      (s) => !sessionTelemetryById[s.id]
    );
    const outsideRelay = buildAggregate(
      outsideRelaySessions,
      sessionTelemetryById
    );
    outsideRelay.totalSessions = outsideRelaySessions.length;
    return { repos: repoSummaries, outsideRelay };
  },

  summarizeSessionTelemetry: (sessionId) =>
    get().sessionTelemetryById[sessionId] ?? null,

  setSessionTelemetry: (data) => {
    const { sessionTelemetryById } = get();
    const normalized = normalizeSessionTelemetry(data.sessionId, data);
    const next = pickNewerSessionTelemetry(
      sessionTelemetryById[normalized.sessionId],
      normalized
    );
    if (sessionTelemetryById[normalized.sessionId] === next) return;
    set({
      sessionTelemetryById: {
        ...sessionTelemetryById,
        [normalized.sessionId]: next,
      },
    });
  },

  setSessionTelemetryBatch: (
    items,
    requestStartedAt = new Date().toISOString()
  ) => {
    const { sessionTelemetryById } = get();
    const normalized = items.map((item) =>
      normalizeSessionTelemetry(item.sessionId, item)
    );
    set({
      sessionTelemetryById: mergeSessionTelemetrySnapshot(
        sessionTelemetryById,
        normalized,
        requestStartedAt
      ),
    });
  },

  clearSessionTelemetry: (sessionId) => {
    const { sessionTelemetryById } = get();
    if (!(sessionId in sessionTelemetryById)) return;
    const next = { ...sessionTelemetryById };
    delete next[sessionId];
    set({ sessionTelemetryById: next });
  },

  pruneSessionTelemetry: (activeSessionIds) => {
    const { sessionTelemetryById } = get();
    const allowed = new Set(activeSessionIds);
    const next: Record<string, SessionTelemetry> = {};
    let changed = false;
    for (const [sessionId, telemetry] of Object.entries(sessionTelemetryById)) {
      if (allowed.has(sessionId)) {
        next[sessionId] = telemetry;
      } else {
        changed = true;
      }
    }
    if (changed) set({ sessionTelemetryById: next });
  },

  setAccountTelemetrySnapshot: (data, requestStartedAt) => {
    const { accountTelemetryByFramework } = get();
    const requestTime = requestStartedAt ?? new Date().toISOString();
    if (!data) {
      set({
        accountTelemetryByFramework: mergeAccountTelemetryByFrameworkSnapshot(
          accountTelemetryByFramework,
          null,
          requestTime
        ),
      });
      return;
    }
    set({
      accountTelemetryByFramework: mergeAccountTelemetryByFrameworkSnapshot(
        accountTelemetryByFramework,
        data,
        requestTime
      ),
    });
  },

  setTelemetrySetupInstalled: (installed) =>
    set({ telemetrySetupInstalled: installed }),

  handleSessionTelemetryEvent: (sessionId, data) => {
    if (!data || typeof data !== 'object') return;
    get().setSessionTelemetry(
      normalizeSessionTelemetry(sessionId, data as Partial<SessionTelemetry>)
    );
  },

  handleAccountTelemetryEvent: (data) => {
    if (!data || typeof data !== 'object') {
      set({ accountTelemetryByFramework: {} });
      return;
    }
    const normalized = normalizeAccountTelemetry(
      data as Partial<AccountTelemetry>
    );
    const framework = normalized.framework;
    const { accountTelemetryByFramework } = get();
    const existing = accountTelemetryByFramework[framework] ?? null;
    const merged = pickNewerAccountTelemetry(existing, normalized);
    if (existing === merged) return;
    set({
      accountTelemetryByFramework: {
        ...accountTelemetryByFramework,
        [framework]: merged,
      },
    });
  },

  refreshTelemetry: async () => {
    const requestStartedAt = new Date().toISOString();
    const [sessionResult, accountResult, setupResult] =
      await Promise.allSettled([
        api.fetchSessionTelemetry(),
        api.fetchAccountTelemetry(),
        api.fetchTelemetrySetupStatus(),
      ]);

    const { sessionTelemetryById, accountTelemetryByFramework } = get();

    const updates: Partial<TelemetryState> = {};
    if (sessionResult.status === 'fulfilled') {
      const normalized = sessionResult.value.map((item) =>
        normalizeSessionTelemetry(item.sessionId, item)
      );
      updates.sessionTelemetryById = mergeSessionTelemetrySnapshot(
        sessionTelemetryById,
        normalized,
        requestStartedAt
      );
    }
    if (accountResult.status === 'fulfilled') {
      updates.accountTelemetryByFramework =
        mergeAccountTelemetryByFrameworkSnapshot(
          accountTelemetryByFramework,
          accountResult.value ?? {},
          requestStartedAt
        );
    }
    if (setupResult.status === 'fulfilled') {
      updates.telemetrySetupInstalled = setupResult.value.installed;
    }
    if (Object.keys(updates).length > 0) set(updates);
  },

  getAccountTelemetry: (framework) => {
    const { accountTelemetryByFramework } = get();
    if (framework) {
      return accountTelemetryByFramework[framework] ?? null;
    }
    return (
      accountTelemetryByFramework['claude'] ??
      Object.values(accountTelemetryByFramework)[0] ??
      null
    );
  },
}));

export default useTelemetryStore;
