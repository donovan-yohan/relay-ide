import { describe, expect, it } from 'vitest';
import {
  executeSupervisorAction,
  listSupervisorSessions,
  type SupervisorActionSessionBoundary,
} from '../server/supervisor-actions.js';
import type { Session, SessionSummary } from '../server/types.js';
import { supervisorActionRequiredCapabilities } from '../shared/supervisor-actions.js';

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

function boundary(sessions: Record<string, SessionSummary>, writes: string[] = []): SupervisorActionSessionBoundary {
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
      sendKey: { allowed: true },
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

  it('maps canonical sendKey names to terminal bytes while auditing only the key name', () => {
    const writes: string[] = [];
    const result = executeSupervisorAction({
      boundary: boundary({ 'sess-1': session() }, writes),
      action: 'sendKey',
      targetIds: ['sess-1'],
      key: 'arrow-up',
      now: new Date('2026-05-16T00:00:02.000Z'),
    });

    expect(writes).toEqual(['sess-1:\u001b[A']);
    expect(result).toMatchObject({
      command: 'supervisor.sendKey',
      action: 'sendKey',
      counts: { requested: 1, succeeded: 1, denied: 0, failed: 0, skipped: 0 },
      audit: {
        action: 'sendKey',
        key: 'arrow-up',
        targetSessionIds: ['sess-1'],
        targetCount: 1,
        content: {
          rawContentAvailable: false,
          byteCount: 3,
          charCount: 3,
          lineCount: 1,
          classes: ['named-key'],
          redacted: true,
        },
      },
      results: [{ sessionId: 'sess-1', ok: true, key: 'arrow-up' }],
    });
    expect(JSON.stringify(result)).not.toContain('\u001b[A');
  });

  it.each(['ArrowUp', 'up', '\u001b[A', 'ctrl-m', 'arrow-up\n'])(
    'rejects non-canonical sendKey input %s before writing',
    (key) => {
      const writes: string[] = [];
      const result = executeSupervisorAction({
        boundary: boundary({ 'sess-1': session() }, writes),
        action: 'sendKey',
        targetIds: ['sess-1'],
        key,
      });

      expect(writes).toEqual([]);
      expect(result.counts).toMatchObject({ requested: 1, succeeded: 0, failed: 1 });
      expect(result.results[0]?.error).toMatchObject({
        code: 'INVALID_ARGUMENT',
        reasonCode: 'KEY_INVALID',
      });
    }
  );

  it.each(['sendText', 'sendKey', 'submit'] as const)(
    'reports capability-denied %s without writing to targets',
    (action) => {
      const writes: string[] = [];
      const deniedCapability = supervisorActionRequiredCapabilities(action)[1];
      const result = executeSupervisorAction({
        boundary: boundary({ 'sess-1': session() }, writes),
        action,
        targetIds: ['sess-1'],
        text: action === 'sendText' ? 'hello' : undefined,
        key: action === 'sendKey' ? 'escape' : undefined,
        deniedByCapability: {
          code: 'FORBIDDEN',
          reasonCode: 'CAPABILITY_REQUIRED',
          message: `missing required capability: ${deniedCapability}`,
          retryable: false,
          details: { capability: deniedCapability },
        },
      });

      expect(writes).toEqual([]);
      expect(result.counts).toEqual({
        requested: 1,
        succeeded: 0,
        denied: 1,
        failed: 0,
        skipped: 0,
      });
      expect(result.audit).toMatchObject({
        partialFailure: true,
        rawContentStored: false,
        counts: { denied: 1 },
      });
      expect(result.results[0]?.error).toMatchObject({
        code: 'FORBIDDEN',
        reasonCode: 'CAPABILITY_REQUIRED',
      });
      expect(result.redaction).toEqual({
        rawContentAvailable: false,
        rawContentStored: false,
        hashesOnly: true,
      });
      expect(JSON.stringify(result)).not.toContain('hello');
    }
  );

  it('preserves successful target results when another supervisor action target fails upstream', () => {
    const writes: string[] = [];
    const sessions = {
      'sess-1': session({ id: 'sess-1' }),
      'sess-2': session({ id: 'sess-2' }),
    };
    const actionBoundary = boundary(sessions, writes);
    actionBoundary.supervisorWrite = (id: string, input: { payload: string }) => {
      if (id === 'sess-2') throw new Error('pty is gone');
      writes.push(`${id}:${input.payload}`);
      return { eventId: `evt-${id}`, modeBefore: 'agent-driven', modeAfter: 'co-driven' };
    };

    const result = executeSupervisorAction({
      boundary: actionBoundary,
      action: 'sendText',
      targetIds: ['sess-1', 'sess-2'],
      text: 'hello',
    });

    expect(writes).toEqual(['sess-1:hello']);
    expect(result.counts).toEqual({
      requested: 2,
      succeeded: 1,
      denied: 0,
      failed: 1,
      skipped: 0,
    });
    expect(result.audit).toMatchObject({
      partialFailure: true,
      rawContentStored: false,
      content: {
        rawContentAvailable: false,
        hashSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        byteCount: 5,
        charCount: 5,
        redacted: true,
      },
    });
    expect(result.results[0]).toMatchObject({ sessionId: 'sess-1', ok: true });
    expect(result.results[1]).toMatchObject({
      sessionId: 'sess-2',
      ok: false,
      error: {
        code: 'UPSTREAM_ERROR',
        reasonCode: 'UPSTREAM_WRITE_FAILED',
        message: 'pty is gone',
        retryable: true,
      },
    });
    expect(JSON.stringify(result)).not.toContain('hello');
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
