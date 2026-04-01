import * as api from '../api.js';
import type { AccountTelemetry, Repo, SessionSummary, SessionTelemetry } from '../types.js';
import {
  mergeAccountTelemetrySnapshot,
  mergeSessionTelemetrySnapshot,
  pickNewerAccountTelemetry,
  pickNewerSessionTelemetry,
} from '../telemetry-sync.js';

let sessionTelemetryById = $state<Record<string, SessionTelemetry>>({});
let accountTelemetry = $state<AccountTelemetry | null>(null);
let telemetrySetupInstalled = $state<boolean | null>(null);

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

function buildAggregate(sessions: SessionSummary[]): TelemetryAggregate {
  const aggregate = emptyAggregate(sessions.length);
  let contextPercentTotal = 0;
  let contextPercentCount = 0;

  for (const session of sessions) {
    const telemetry = sessionTelemetryById[session.id];
    if (!telemetry) continue;
    aggregate.trackedSessions += 1;
    aggregate.totalInputTokens += telemetry.totalInputTokens || 0;
    aggregate.totalOutputTokens += telemetry.totalOutputTokens || 0;
    aggregate.totalCacheRead += telemetry.totalCacheRead || 0;
    aggregate.totalCacheWrite += telemetry.totalCacheWrite || 0;
    aggregate.totalCostUsd = mergeCost(aggregate.totalCostUsd, telemetry.costUsd);
    if (telemetry.contextPercent >= 0) {
      contextPercentTotal += telemetry.contextPercent;
      contextPercentCount += 1;
      aggregate.maxContextPercent = aggregate.maxContextPercent === null
        ? telemetry.contextPercent
        : Math.max(aggregate.maxContextPercent, telemetry.contextPercent);
    }
  }

  if (contextPercentCount > 0) {
    aggregate.averageContextPercent = contextPercentTotal / contextPercentCount;
  }

  return aggregate;
}

export function summarizeSessionSetTelemetry(sessions: SessionSummary[]): TelemetryAggregate {
  return buildAggregate(sessions);
}

export function summarizeReposTelemetry(repos: Repo[], sessions: SessionSummary[]): OrgTelemetrySummary {
  const sessionsByRepo = new Map<string, SessionSummary[]>();
  for (const session of sessions) {
    const bucket = sessionsByRepo.get(session.repoPath) ?? [];
    bucket.push(session);
    sessionsByRepo.set(session.repoPath, bucket);
  }

  const repoSummaries = repos.map((repo) => ({
    repoPath: repo.path,
    repoName: repo.name,
    aggregate: buildAggregate(sessionsByRepo.get(repo.path) ?? []),
  }));

  const outsideRelaySessions = sessions.filter((session) => !sessionTelemetryById[session.id]);
  const outsideRelay = buildAggregate(outsideRelaySessions);
  outsideRelay.totalSessions = outsideRelaySessions.length;

  return {
    repos: repoSummaries,
    outsideRelay,
  };
}

export function summarizeSessionTelemetry(sessionId: string): SessionTelemetry | null {
  return sessionTelemetryById[sessionId] ?? null;
}

export function getTelemetryState() {
  return {
    get sessionTelemetryById() { return sessionTelemetryById; },
    get accountTelemetry() { return accountTelemetry; },
    get telemetrySetupInstalled() { return telemetrySetupInstalled; },
  };
}

function normalizeSessionTelemetry(sessionId: string, data: Partial<SessionTelemetry>): SessionTelemetry {
  return {
    sessionId,
    model: typeof data.model === 'string' || data.model === null ? data.model ?? null : null,
    totalInputTokens: typeof data.totalInputTokens === 'number' ? data.totalInputTokens : 0,
    totalOutputTokens: typeof data.totalOutputTokens === 'number' ? data.totalOutputTokens : 0,
    totalCacheRead: typeof data.totalCacheRead === 'number' ? data.totalCacheRead : 0,
    totalCacheWrite: typeof data.totalCacheWrite === 'number' ? data.totalCacheWrite : 0,
    contextPercent: typeof data.contextPercent === 'number' ? data.contextPercent : -1,
    contextWindowSize: typeof data.contextWindowSize === 'number' ? data.contextWindowSize : 0,
    costUsd: typeof data.costUsd === 'number' ? data.costUsd : null,
    turnCount: typeof data.turnCount === 'number' ? data.turnCount : 0,
    subagentCount: typeof data.subagentCount === 'number' ? data.subagentCount : 0,
    source: data.source === 'jsonl' ? 'jsonl' : 'statusLine',
    updatedAt: typeof data.updatedAt === 'string' ? data.updatedAt : new Date().toISOString(),
  };
}

function normalizeAccountTelemetry(data: Partial<AccountTelemetry>): AccountTelemetry {
  return {
    fiveHourUsedPercent: typeof data.fiveHourUsedPercent === 'number' ? data.fiveHourUsedPercent : -1,
    fiveHourResetsAt: typeof data.fiveHourResetsAt === 'string' ? data.fiveHourResetsAt : null,
    sevenDayUsedPercent: typeof data.sevenDayUsedPercent === 'number' ? data.sevenDayUsedPercent : -1,
    sevenDayResetsAt: typeof data.sevenDayResetsAt === 'string' ? data.sevenDayResetsAt : null,
    updatedAt: typeof data.updatedAt === 'string' ? data.updatedAt : new Date().toISOString(),
  };
}

export function setSessionTelemetry(data: SessionTelemetry): void {
  const normalized = normalizeSessionTelemetry(data.sessionId, data);
  const next = pickNewerSessionTelemetry(sessionTelemetryById[normalized.sessionId], normalized);
  if (sessionTelemetryById[normalized.sessionId] === next) return;
  sessionTelemetryById = { ...sessionTelemetryById, [normalized.sessionId]: next };
}

export function setSessionTelemetryBatch(items: SessionTelemetry[], requestStartedAt = new Date().toISOString()): void {
  const normalized = items.map((item) => normalizeSessionTelemetry(item.sessionId, item));
  sessionTelemetryById = mergeSessionTelemetrySnapshot(sessionTelemetryById, normalized, requestStartedAt);
}

export function clearSessionTelemetry(sessionId: string): void {
  if (!(sessionId in sessionTelemetryById)) return;
  const next = { ...sessionTelemetryById };
  delete next[sessionId];
  sessionTelemetryById = next;
}

export function pruneSessionTelemetry(activeSessionIds: Iterable<string>): void {
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
  if (changed) sessionTelemetryById = next;
}

export function setAccountTelemetrySnapshot(data: AccountTelemetry | null): void {
  if (!data) {
    accountTelemetry = null;
    return;
  }
  accountTelemetry = pickNewerAccountTelemetry(accountTelemetry, normalizeAccountTelemetry(data));
}

export function setTelemetrySetupInstalled(installed: boolean | null): void {
  telemetrySetupInstalled = installed;
}

export function handleSessionTelemetryEvent(sessionId: string, data: SessionTelemetry | Record<string, unknown>): void {
  if (!data || typeof data !== 'object') return;
  setSessionTelemetry(normalizeSessionTelemetry(sessionId, data as Partial<SessionTelemetry>));
}

export function handleAccountTelemetryEvent(data: AccountTelemetry | Record<string, unknown> | null): void {
  if (!data || typeof data !== 'object') {
    accountTelemetry = null;
    return;
  }
  accountTelemetry = pickNewerAccountTelemetry(accountTelemetry, normalizeAccountTelemetry(data as Partial<AccountTelemetry>));
}

export async function refreshTelemetry(): Promise<void> {
  const requestStartedAt = new Date().toISOString();
  const [sessionResult, accountResult, setupResult] = await Promise.allSettled([
    api.fetchSessionTelemetry(),
    api.fetchAccountTelemetry(),
    api.fetchTelemetrySetupStatus(),
  ]);

  if (sessionResult.status === 'fulfilled') {
    setSessionTelemetryBatch(sessionResult.value, requestStartedAt);
  }
  if (accountResult.status === 'fulfilled') {
    accountTelemetry = mergeAccountTelemetrySnapshot(accountTelemetry, accountResult.value, requestStartedAt);
  }
  if (setupResult.status === 'fulfilled') {
    setTelemetrySetupInstalled(setupResult.value.installed);
  }
}
