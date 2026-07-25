import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  initRelayStateDb,
  closeRelayStateDb,
  upsertWebSessionNow,
  scheduleWebSessionUpsert,
  flushAllPendingWrites,
  iterateWebSessions,
  loadAllWebSessions,
  deleteWebSession,
  markWebSessionStatus,
  reapStaleWebSessions,
  setReapProtectedSessionIdsProvider,
  runRelayStateDbMaintenance,
} from '../../server/relay-state-db.js';
import type { WebSession } from '../../server/types.js';
import {
  emptyAgentSessionV2,
  MAX_TRANSCRIPT_BYTES,
  type AgentItemV2,
  type AgentTurnV2,
} from '../../shared/agent-chat-protocol-v2.js';

vi.mock('../../server/logger.js', () => ({
  createLogger: () => ({
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

function fakeWebSession(overrides: Partial<WebSession> = {}): WebSession {
  const base = {
    mode: 'web' as const,
    id: 'sess-1',
    type: 'agent' as const,
    agent: 'claude' as WebSession['agent'],
    repoPath: '/repo',
    worktreePath: null,
    cwd: '/repo',
    repoName: 'repo',
    branchName: 'main',
    displayName: 'Agent 1',
    createdAt: new Date('2026-04-29T00:00:00Z').toISOString(),
    lastActivity: new Date('2026-04-29T00:00:01Z').toISOString(),
    idle: true,
    customCommand: null,
    status: 'active' as const,
    needsBranchRename: false,
    agentState: 'initializing' as const,
    adapterV2: {
      disconnect: () => Promise.resolve(),
    } as unknown as WebSession['adapterV2'],
    adapterType: 'claude',
    agentSessionV2: emptyAgentSessionV2({
      id: 'sess-1',
      provider: 'claude',
      cwd: '/repo',
      capabilities: { resume: true },
      providerSession: { claudeSessionId: 'claude-abc' },
    }),
    agentPatchesV2: [],
    protocolVersion: 2 as const,
    currentTurnId: null,
    runtimeOwnership: 'spawned' as const,
    hookToken: 'tok',
    hooksActive: true,
  };
  return { ...base, ...overrides } as WebSession;
}

describe('relay-state-db', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-state-db-'));
    initRelayStateDb(dir);
  });

  afterEach(() => {
    closeRelayStateDb();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('upserts and round-trips a web session', () => {
    const session = fakeWebSession({
      spawnedBySessionId: 'orchestrator-session',
      role: 'orchestrator',
    });
    upsertWebSessionNow(session);

    const rows = loadAllWebSessions();
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.id).toBe('sess-1');
    expect(row.vendor).toBe('claude');
    expect(row.vendorSessionId).toBe('claude-abc');
    expect(row.agentSessionV2.id).toBe('sess-1');
    expect(row.meta.adapterType).toBe('claude');
    expect(row.meta.spawnedBySessionId).toBe('orchestrator-session');
    expect(row.meta.role).toBe('orchestrator');
    expect(row.status).toBe('active');
  });

  it('overwrites on second upsert (same id)', () => {
    const session = fakeWebSession();
    upsertWebSessionNow(session);

    const updated = fakeWebSession({ displayName: 'Renamed' });
    upsertWebSessionNow(updated);

    const rows = loadAllWebSessions();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.displayName).toBe('Renamed');
  });

  it('snapshots restore IDs without holding a SQLite cursor between rows', () => {
    for (let i = 0; i < 3; i++) {
      upsertWebSessionNow(
        fakeWebSession({
          id: `iter-${i}`,
          displayName: `Before ${i}`,
          lastActivity: new Date(
            Date.parse('2026-04-29T00:00:00Z') + i * 1000
          ).toISOString(),
        })
      );
    }

    const iterator = iterateWebSessions();
    const first = iterator.next();
    expect(first.value?.id).toBe('iter-0');

    // A write must complete while the iterator is paused; the remaining row is
    // fetched by ID only after the write, not from a long-lived SQLite cursor.
    upsertWebSessionNow(
      fakeWebSession({
        id: 'iter-1',
        displayName: 'Updated between rows',
        lastActivity: new Date('2026-04-29T00:00:01Z').toISOString(),
      })
    );
    const remaining = Array.from(iterator);
    expect([first.value, ...remaining].map((row) => row!.id)).toEqual([
      'iter-0',
      'iter-1',
      'iter-2',
    ]);
    expect(remaining[0]!.displayName).toBe('Updated between rows');

    const closeIterator = iterateWebSessions();
    expect(closeIterator.next().value?.id).toBe('iter-0');
    expect(() => closeRelayStateDb()).not.toThrow();
    expect(closeIterator.next().done).toBe(true);
  });

  it('debounces scheduled upserts and flushes on demand', async () => {
    const session = fakeWebSession();
    scheduleWebSessionUpsert(session);

    expect(loadAllWebSessions()).toHaveLength(0);

    flushAllPendingWrites();
    expect(loadAllWebSessions()).toHaveLength(1);
  });

  it('immediate upsert cancels pending debounce for the same id', () => {
    const session = fakeWebSession();
    scheduleWebSessionUpsert(session);
    upsertWebSessionNow({ ...session, displayName: 'Forced' } as WebSession);

    flushAllPendingWrites();

    const rows = loadAllWebSessions();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.displayName).toBe('Forced');
  });

  it('deleteWebSession removes the row', () => {
    const session = fakeWebSession();
    upsertWebSessionNow(session);
    expect(loadAllWebSessions()).toHaveLength(1);

    deleteWebSession(session.id);
    expect(loadAllWebSessions()).toHaveLength(0);
  });

  it('markWebSessionStatus archived hides row from load', () => {
    const session = fakeWebSession();
    upsertWebSessionNow(session);

    markWebSessionStatus(session.id, 'archived');
    expect(loadAllWebSessions()).toHaveLength(0);
  });

  it('archived status survives subsequent upserts', () => {
    const session = fakeWebSession();
    upsertWebSessionNow(session);
    markWebSessionStatus(session.id, 'archived');

    // Simulate a late patch arriving after archive — must not revive.
    upsertWebSessionNow({ ...session, displayName: 'Late' } as WebSession);

    expect(loadAllWebSessions()).toHaveLength(0);
  });

  it('throttle bound: scheduled writes fire even under continuous bursts', async () => {
    const session = fakeWebSession();

    // Hammer the scheduler — pure debounce would never fire under this load.
    for (let i = 0; i < 5; i++) {
      scheduleWebSessionUpsert({
        ...session,
        displayName: `iter-${i}`,
      } as WebSession);
      await new Promise((r) => setTimeout(r, 200));
    }

    // Within ~MAX_WAIT_MS (1000ms) the first burst should have flushed.
    await new Promise((r) => setTimeout(r, 200));

    const rows = loadAllWebSessions();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.displayName).toMatch(/^iter-/);
  });

  it('persists empty providerSession as null vendor_session_id', () => {
    const session = fakeWebSession();
    session.agentSessionV2 = emptyAgentSessionV2({
      id: 'sess-1',
      provider: 'claude',
      cwd: '/repo',
      capabilities: {},
    });
    upsertWebSessionNow(session);

    const rows = loadAllWebSessions();
    expect(rows[0]!.vendorSessionId).toBeNull();
  });

  it('caps an oversized transcript on persist and cold-resume (#1243)', () => {
    const bigTurn = (id: string): AgentTurnV2 => ({
      id,
      status: 'completed',
      inputMessageId: `${id}-input`,
      startedAt: '2026-07-22T00:00:00.000Z',
      completedAt: '2026-07-22T00:00:02.000Z',
      items: [
        {
          type: 'commandExecution',
          id: `${id}-cmd`,
          command: 'echo',
          output: 'x'.repeat(200_000),
          status: 'completed',
          startedAt: '2026-07-22T00:00:00.000Z',
          completedAt: '2026-07-22T00:00:01.000Z',
        } satisfies AgentItemV2,
      ],
    });

    const session = fakeWebSession();
    // ~1.6MB transcript across 8 turns — well over the 512KB budget.
    session.agentSessionV2.turns = Array.from({ length: 8 }, (_, i) =>
      bigTurn(`turn-${i}`)
    );

    upsertWebSessionNow(session);

    // In-memory transcript is trimmed in place (bounds the live/boot rss).
    expect(
      Buffer.byteLength(JSON.stringify(session.agentSessionV2.turns), 'utf8')
    ).toBeLessThanOrEqual(MAX_TRANSCRIPT_BYTES);

    // Cold-resume: the persisted blob restores as a valid, bounded session that
    // preserves the most-recent turn tail.
    const rows = loadAllWebSessions();
    expect(rows).toHaveLength(1);
    const restored = rows[0]!.agentSessionV2;
    expect(
      Buffer.byteLength(JSON.stringify(restored.turns), 'utf8')
    ).toBeLessThanOrEqual(MAX_TRANSCRIPT_BYTES);
    expect(restored.turns.map((t) => t.id)).toContain('turn-7');
    expect(restored.turns.map((t) => t.id)).not.toContain('turn-0');
    for (const t of restored.turns) expect(t.items.length).toBeGreaterThan(0);
  });

  it('restores ALL non-archived rows on boot (no restore cap) (#1248)', () => {
    // >50 rows: the removed MAX_RESTORE_SESSIONS cap used to drop the oldest,
    // which broke channel-agent resume (binder respawned a fresh session) and
    // orphaned direct sessions past the cap. All must restore, resume anchor
    // (vendorSessionId) intact.
    for (let i = 0; i < 60; i++) {
      const session = fakeWebSession({
        id: `sess-${i}`,
        lastActivity: new Date(
          Date.parse('2026-04-29T00:00:00Z') + i * 1000
        ).toISOString(),
      });
      session.agentSessionV2 = emptyAgentSessionV2({
        id: `sess-${i}`,
        provider: 'claude',
        cwd: '/repo',
        capabilities: { resume: true },
        providerSession: { claudeSessionId: `claude-${i}` },
      });
      upsertWebSessionNow(session);
    }

    const rows = loadAllWebSessions();
    expect(rows).toHaveLength(60);
    const ids = rows.map((r) => r.id);
    // Oldest (sess-0) and newest (sess-59) both present — nothing dropped.
    expect(ids).toContain('sess-0');
    expect(ids).toContain('sess-59');
    // Resume anchor survives for the oldest row.
    const oldest = rows.find((r) => r.id === 'sess-0')!;
    expect(oldest.vendorSessionId).toBe('claude-0');
  });

  it('age-reaps an old idle status=active row (v2 idle derives to active) (#1248)', () => {
    const now = Date.now();
    const eightDaysAgo = new Date(now - 8 * 24 * 60 * 60 * 1000).toISOString();

    const activeOld = fakeWebSession({
      id: 'active-old',
      lastActivity: eightDaysAgo,
    });
    // live.status stays idle -> derived status 'active'. A status-scoped reaper
    // would leak this forever; the age reaper evicts it.
    upsertWebSessionNow(activeOld);

    const removed = reapStaleWebSessions({ protectedIds: new Set() });
    expect(removed).toBe(1);
    expect(loadAllWebSessions().map((r) => r.id)).not.toContain('active-old');
  });

  it('age-reaps old rows regardless of status but keeps recent ones (#1248)', () => {
    const now = Date.now();
    const eightDaysAgo = new Date(now - 8 * 24 * 60 * 60 * 1000).toISOString();
    const oneHourAgo = new Date(now - 60 * 60 * 1000).toISOString();

    const staleDisconnected = fakeWebSession({
      id: 'stale-disc',
      lastActivity: eightDaysAgo,
    });
    staleDisconnected.agentSessionV2.live.status = 'disconnected';

    const staleActive = fakeWebSession({
      id: 'stale-active',
      lastActivity: eightDaysAgo,
    });

    const recent = fakeWebSession({ id: 'recent', lastActivity: oneHourAgo });

    upsertWebSessionNow(staleDisconnected);
    upsertWebSessionNow(staleActive);
    upsertWebSessionNow(recent);

    const removed = reapStaleWebSessions({ protectedIds: new Set() });
    expect(removed).toBe(2);

    const ids = loadAllWebSessions().map((r) => r.id);
    expect(ids).not.toContain('stale-disc');
    expect(ids).not.toContain('stale-active');
    expect(ids).toContain('recent');
  });

  it('never reaps a live-in-memory or channel-bound session even when old (#1248)', () => {
    const now = Date.now();
    const eightDaysAgo = new Date(now - 8 * 24 * 60 * 60 * 1000).toISOString();

    const liveOld = fakeWebSession({
      id: 'live-old',
      lastActivity: eightDaysAgo,
    });
    const boundOld = fakeWebSession({
      id: 'bound-old',
      lastActivity: eightDaysAgo,
    });
    boundOld.agentSessionV2.live.status = 'disconnected';
    const unprotectedOld = fakeWebSession({
      id: 'unprotected-old',
      lastActivity: eightDaysAgo,
    });

    upsertWebSessionNow(liveOld);
    upsertWebSessionNow(boundOld);
    upsertWebSessionNow(unprotectedOld);

    // Protection set = live map ids + channel-bound session ids.
    const removed = reapStaleWebSessions({
      protectedIds: new Set(['live-old', 'bound-old']),
    });
    expect(removed).toBe(1);

    const ids = loadAllWebSessions().map((r) => r.id);
    expect(ids).toContain('live-old');
    expect(ids).toContain('bound-old');
    expect(ids).not.toContain('unprotected-old');
  });

  it('reaper reads the registered protection provider (#1248)', () => {
    const now = Date.now();
    const eightDaysAgo = new Date(now - 8 * 24 * 60 * 60 * 1000).toISOString();

    upsertWebSessionNow(
      fakeWebSession({ id: 'protected-old', lastActivity: eightDaysAgo })
    );
    upsertWebSessionNow(
      fakeWebSession({ id: 'doomed-old', lastActivity: eightDaysAgo })
    );

    setReapProtectedSessionIdsProvider(() => ['protected-old']);
    try {
      const removed = reapStaleWebSessions();
      expect(removed).toBe(1);
      const ids = loadAllWebSessions().map((r) => r.id);
      expect(ids).toContain('protected-old');
      expect(ids).not.toContain('doomed-old');
    } finally {
      setReapProtectedSessionIdsProvider(null);
    }
  });

  it('reap is a no-op when no protection is resolvable (fail-safe) (#1248)', () => {
    const eightDaysAgo = new Date(
      Date.now() - 8 * 24 * 60 * 60 * 1000
    ).toISOString();
    upsertWebSessionNow(
      fakeWebSession({ id: 'old', lastActivity: eightDaysAgo })
    );

    // No explicit set, no provider registered -> skip rather than risk dropping
    // a live/bound session's resume anchor.
    expect(reapStaleWebSessions()).toBe(0);
    expect(loadAllWebSessions().map((r) => r.id)).toContain('old');
  });

  it('enables incremental auto_vacuum and truncates the WAL on maintenance', () => {
    const session = fakeWebSession();
    session.agentSessionV2.turns = [
      {
        id: 'turn-0',
        status: 'completed',
        inputMessageId: 'in',
        startedAt: '2026-07-22T00:00:00.000Z',
        completedAt: '2026-07-22T00:00:01.000Z',
        items: [
          {
            type: 'commandExecution',
            id: 'c',
            command: 'echo',
            output: 'y'.repeat(50_000),
            status: 'completed',
            startedAt: '2026-07-22T00:00:00.000Z',
            completedAt: '2026-07-22T00:00:01.000Z',
          } satisfies AgentItemV2,
        ],
      },
    ];
    upsertWebSessionNow(session);
    deleteWebSession(session.id); // orphan pages onto the freelist

    runRelayStateDbMaintenance();

    // Independent connection: auto_vacuum is INCREMENTAL (2) and the WAL was
    // truncated back toward zero by wal_checkpoint(TRUNCATE).
    const probe = new Database(path.join(dir, 'relay-state.db'), {
      readonly: true,
    });
    try {
      expect(probe.pragma('auto_vacuum', { simple: true })).toBe(2);
    } finally {
      probe.close();
    }
    const walPath = path.join(dir, 'relay-state.db-wal');
    if (fs.existsSync(walPath)) {
      expect(fs.statSync(walPath).size).toBeLessThan(1024 * 1024);
    }
  });
});
