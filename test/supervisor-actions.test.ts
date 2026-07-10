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

function boundary(
  sessions: Record<string, SessionSummary>,
  writes: string[] = []
): SupervisorActionSessionBoundary {
  return {
    list: () => Object.values(sessions),
    get: (id: string) => sessions[id] as Session | undefined,
    // Record the full byte stream (typed payload + deferred submit tail):
    // the split-write mechanics are pinned in supervisor-route-handlers tests.
    supervisorWrite: (
      id: string,
      input: { payload: string; deferredTail?: string }
    ) => {
      writes.push(`${id}:${input.payload}${input.deferredTail ?? ''}`);
      return {
        eventId: `evt-${id}`,
        modeBefore: 'agent-driven',
        modeAfter: 'co-driven',
      };
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

    expect(response).toMatchObject({
      command: 'supervisor.sessions',
      count: 3,
    });
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

    expect(writes).toEqual(['sess-1:hello', 'sess-1:\r']);
    expect(sendText).toMatchObject({
      command: 'supervisor.sendText',
      action: 'sendText',
      counts: { requested: 1, succeeded: 1, denied: 0, failed: 0, skipped: 0 },
      redaction: {
        rawContentAvailable: false,
        rawContentStored: false,
        hashesOnly: true,
      },
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
      expect(result.counts).toMatchObject({
        requested: 1,
        succeeded: 0,
        failed: 1,
      });
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
    actionBoundary.supervisorWrite = (
      id: string,
      input: { payload: string; deferredTail?: string }
    ) => {
      if (id === 'sess-2') throw new Error('pty is gone');
      writes.push(`${id}:${input.payload}${input.deferredTail ?? ''}`);
      return {
        eventId: `evt-${id}`,
        modeBefore: 'agent-driven',
        modeAfter: 'co-driven',
      };
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
      boundary: boundary(
        { 'sess-1': session({ controlFreshness: 'stale' }) },
        writes
      ),
      action: 'sendText',
      targetIds: ['sess-1'],
      text: '\u001b[200~paste',
    });

    expect(writes).toEqual([]);
    expect(result.counts).toMatchObject({
      requested: 1,
      succeeded: 0,
      failed: 1,
    });
    expect(result.results[0]?.error).toMatchObject({
      code: 'INVALID_ARGUMENT',
      reasonCode: 'TEXT_MUST_BE_LITERAL',
    });
  });
});

describe('#958 typed supervisor submit', () => {
  it('submits a bare carriage return (Enter), not a line feed', () => {
    const writes: string[] = [];
    const result = executeSupervisorAction({
      boundary: boundary({ 'sess-1': session() }, writes),
      action: 'submit',
      targetIds: ['sess-1'],
    });

    // The classic #958 bug was submitting '\n' (LF), which left content sitting
    // in CR-submit TUIs. The primitive owns a single '\r'.
    expect(writes).toEqual(['sess-1:\r']);
    expect(result.results[0]).toMatchObject({
      ok: true,
      action: 'submit',
      submitPerformed: true,
      submitKey: 'enter',
      clearInputPerformed: false,
      pasteBracketed: false,
      charsAccepted: 0,
      bytesAccepted: 0,
      steps: ['submit'],
    });
  });

  it('types a newline-containing prompt then submits with one owned carriage return', () => {
    const writes: string[] = [];
    const result = executeSupervisorAction({
      boundary: boundary({ 'sess-1': session() }, writes),
      action: 'submit',
      targetIds: ['sess-1'],
      text: 'first line\nsecond line\n',
    });

    // Trailing newline is stripped; embedded newline is preserved as a literal
    // LF; exactly one CR is appended by the primitive.
    expect(writes).toEqual(['sess-1:first line\nsecond line\r']);
    expect(result.counts).toMatchObject({
      requested: 1,
      succeeded: 1,
      failed: 0,
    });
    expect(result.results[0]).toMatchObject({
      ok: true,
      submitPerformed: true,
      submitKey: 'enter',
      charsAccepted: 'first line\nsecond line'.length,
      bytesAccepted: Buffer.byteLength('first line\nsecond line', 'utf8'),
      pasteBracketed: false,
      steps: ['type-text', 'submit'],
    });
    expect(result.audit.content).toMatchObject({
      rawContentAvailable: false,
      classes: ['submit', 'literal-text'],
      redacted: true,
    });
    expect(JSON.stringify(result)).not.toContain('first line');
  });

  it('normalizes CRLF/lone-CR line endings in the body to LF', () => {
    const writes: string[] = [];
    executeSupervisorAction({
      boundary: boundary({ 'sess-1': session() }, writes),
      action: 'submit',
      targetIds: ['sess-1'],
      text: 'echo hi\r\nmore\rtail\r\n',
    });

    expect(writes).toEqual(['sess-1:echo hi\nmore\ntail\r']);
  });

  it('wraps a long pasted prompt in bracketed-paste markers before the carriage return', () => {
    const writes: string[] = [];
    const longBody = 'x'.repeat(5000);
    const result = executeSupervisorAction({
      boundary: boundary({ 'sess-1': session() }, writes),
      action: 'submit',
      targetIds: ['sess-1'],
      text: longBody,
      paste: true,
    });

    expect(writes).toEqual([`sess-1:[200~${longBody}[201~\r`]);
    expect(result.results[0]).toMatchObject({
      ok: true,
      pasteBracketed: true,
      charsAccepted: 5000,
      submitPerformed: true,
      steps: ['type-text', 'submit'],
    });
  });

  it('clears the current input buffer before typing when asked', () => {
    const writes: string[] = [];
    const result = executeSupervisorAction({
      boundary: boundary({ 'sess-1': session() }, writes),
      action: 'submit',
      targetIds: ['sess-1'],
      text: 'redo',
      clearInput: true,
    });

    expect(writes).toEqual(['sess-1:redo\r']);
    expect(result.results[0]).toMatchObject({
      clearInputPerformed: true,
      steps: ['clear-input', 'type-text', 'submit'],
    });
  });

  it('previews a dry-run submission without writing or auditing a write', () => {
    const writes: string[] = [];
    const result = executeSupervisorAction({
      boundary: boundary({ 'sess-1': session() }, writes),
      action: 'submit',
      targetIds: ['sess-1'],
      text: 'preview me',
      dryRun: true,
    });

    expect(writes).toEqual([]);
    expect(result.counts).toMatchObject({
      requested: 1,
      succeeded: 1,
      failed: 0,
    });
    expect(result.audit).toMatchObject({
      dryRun: true,
      rawContentStored: false,
    });
    expect(result.results[0]).toMatchObject({
      ok: true,
      dryRun: true,
      submitPerformed: false,
      charsAccepted: 'preview me'.length,
      plannedBytes: Buffer.byteLength('preview me\r', 'utf8'),
      steps: ['type-text', 'submit'],
      postSubmit: { available: false },
    });
    expect(result.results[0]?.interventionEventId).toBeUndefined();
  });

  it('rejects control/escape sequences in the submit body before writing', () => {
    const writes: string[] = [];
    const result = executeSupervisorAction({
      boundary: boundary({ 'sess-1': session() }, writes),
      action: 'submit',
      targetIds: ['sess-1'],
      text: 'safe[31mred',
    });

    expect(writes).toEqual([]);
    expect(result.counts).toMatchObject({
      requested: 1,
      succeeded: 0,
      failed: 1,
    });
    expect(result.results[0]?.error).toMatchObject({
      code: 'INVALID_ARGUMENT',
      reasonCode: 'TEXT_MUST_BE_LITERAL',
    });
  });

  it('rejects an oversized submit body before writing', () => {
    const writes: string[] = [];
    const result = executeSupervisorAction({
      boundary: boundary({ 'sess-1': session() }, writes),
      action: 'submit',
      targetIds: ['sess-1'],
      text: 'y'.repeat(100_001),
    });

    expect(writes).toEqual([]);
    expect(result.results[0]?.error).toMatchObject({
      code: 'INVALID_ARGUMENT',
      reasonCode: 'TEXT_TOO_LARGE',
    });
  });

  it('reports derived post-submit session state when the session exposes it', () => {
    const writes: string[] = [];
    const result = executeSupervisorAction({
      boundary: boundary(
        { 'sess-1': session({ agentState: 'processing', idle: false }) },
        writes
      ),
      action: 'submit',
      targetIds: ['sess-1'],
      text: 'go',
      now: new Date('2026-06-14T00:00:00.000Z'),
    });

    expect(result.results[0]?.postSubmit).toEqual({
      available: true,
      agentState: 'processing',
      idle: false,
      source: 'session-snapshot',
      observedAt: '2026-06-14T00:00:00.000Z',
    });
  });
});
