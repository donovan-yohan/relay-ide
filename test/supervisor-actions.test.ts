import { describe, expect, it } from 'vitest';
import { executeSupervisorAction, listSupervisorSessions } from '../server/supervisor-actions.js';
import type { Session, SessionSummary } from '../server/types.js';

function session(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: 'sess-1',
    globalSessionId: 'local:sess-1',
    nodeId: 'local',
    type: 'agent',
    agent: 'codex',
    mode: 'pty',
    cwd: '/repo',
    createdAt: '2026-05-16T00:00:00.000Z',
    lastActivity: '2026-05-16T00:00:00.000Z',
    idle: true,
    status: 'active',
    controlMode: 'agent-driven',
    controlFreshness: 'fresh',
    controlState: {
      controlMode: 'agent-driven',
      activeActors: [{ kind: 'agent', id: 'codex' }],
      activeWorker: { kind: 'agent', id: 'codex' },
      lastInterventionAt: null,
      lastInterventionBy: null,
      lastInterventionEventId: null,
      controlFreshness: 'fresh',
    },
    ...overrides,
  } as SessionSummary;
}

function boundary(sessions: Record<string, SessionSummary>, writes: string[] = []) {
  return {
    list: () => Object.values(sessions),
    get: (id: string) => sessions[id] as Session | undefined,
    supervisorWrite: (id: string, input: { payload: string }) => {
      writes.push(`${id}:${input.payload}`);
      return { eventId: `evt-${id}`, modeBefore: 'agent-driven', modeAfter: 'co-driven' };
    },
  };
}

describe('typed supervisor actions', () => {
  it('lists typed action eligibility without exposing raw terminal state', () => {
    const response = listSupervisorSessions([
      session(),
      session({ id: 'web-1', mode: 'web' }),
      session({ id: 'stale-1', controlFreshness: 'stale' }),
    ]);

    expect(response).toMatchObject({ command: 'supervisor.sessions', count: 3 });
    expect(response.sessions[0]?.actions).toEqual({
      sendText: { allowed: true },
      submit: { allowed: true },
    });
    expect(response.sessions[1]?.actions.sendText).toMatchObject({
      allowed: false,
      reasonCode: 'SESSION_MODE_UNSUPPORTED',
    });
    expect(JSON.stringify(response)).not.toContain('scrollback');
  });

  it('executes bounded sendText and submit through the supervisor boundary with hashes-only audit content', () => {
    const writes: string[] = [];
    const sessions = { 'sess-1': session() };

    const sendText = executeSupervisorAction({
      boundary: boundary(sessions, writes),
      action: 'sendText',
      targetIds: ['sess-1'],
      text: 'hello',
      now: new Date('2026-05-16T00:00:00.000Z'),
    });
    const submit = executeSupervisorAction({
      boundary: boundary(sessions, writes),
      action: 'submit',
      targetIds: ['sess-1'],
      now: new Date('2026-05-16T00:00:01.000Z'),
    });

    expect(writes).toEqual(['sess-1:hello', 'sess-1:\n']);
    expect(sendText).toMatchObject({
      command: 'supervisor.sendText',
      action: 'sendText',
      counts: { requested: 1, succeeded: 1, denied: 0, failed: 0, skipped: 0 },
      redaction: { rawContentAvailable: false, rawContentStored: false, hashesOnly: true },
    });
    expect(submit.command).toBe('supervisor.submit');
    expect(sendText.audit.content).toMatchObject({
      rawContentAvailable: false,
      hashSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      byteCount: 5,
      charCount: 5,
      lineCount: 1,
      redacted: true,
    });
    expect(JSON.stringify(sendText)).not.toContain('hello');
  });

  it('refuses control sequences and stale sessions before writing', () => {
    const writes: string[] = [];
    const result = executeSupervisorAction({
      boundary: boundary({ 'sess-1': session({ controlFreshness: 'stale' }) }, writes),
      action: 'sendText',
      targetIds: ['sess-1'],
      text: '\u001b[200~paste',
    });

    expect(writes).toEqual([]);
    expect(result.counts).toMatchObject({ requested: 1, succeeded: 0, failed: 1 });
    expect(result.results[0]?.error).toMatchObject({
      code: 'INVALID_ARGUMENT',
      reasonCode: 'TEXT_MUST_BE_LITERAL',
    });
  });
});
