import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  initRelayStateDb,
  closeRelayStateDb,
  upsertWebSessionNow,
  scheduleWebSessionUpsert,
  flushAllPendingWrites,
  loadAllWebSessions,
  deleteWebSession,
  markWebSessionStatus,
} from '../../server/relay-state-db.js';
import type { WebSession } from '../../server/types.js';
import { emptyAgentSessionV2 } from '../../shared/agent-chat-protocol-v2.js';

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
    const session = fakeWebSession();
    upsertWebSessionNow(session);

    const rows = loadAllWebSessions();
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.id).toBe('sess-1');
    expect(row.vendor).toBe('claude');
    expect(row.vendorSessionId).toBe('claude-abc');
    expect(row.agentSessionV2.id).toBe('sess-1');
    expect(row.meta.adapterType).toBe('claude');
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
});
