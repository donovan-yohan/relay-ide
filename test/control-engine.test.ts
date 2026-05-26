import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  acknowledgeHumanInput,
  applyControlModeAction,
  clearPendingControlBurstsForTests,
  maybeAutoRevertToAgentDriven,
  recordHumanPtyInput,
  recordSupervisorAction,
  redactInterventionPayload,
} from '../server/control-engine.js';
import {
  ackSessionHumanInput,
  appendIntervention,
  closeInterventionLog,
  hasUnackedHumanInput,
  initInterventionLog,
  listInterventions,
} from '../server/intervention-log.js';
import type { Session } from '../server/types.js';
import type {
  ControlActor,
  ControlMode,
  ControlStateSummary,
  InterventionRecord,
  TabControlEvent,
} from '../shared/control-state.js';

const baseNow = new Date('2026-05-16T00:00:00.000Z');

function controlState(mode: ControlMode, overrides: Partial<ControlStateSummary> = {}): ControlStateSummary {
  return {
    controlMode: mode,
    activeActors: [{ kind: mode === 'agent-driven' ? 'agent' : 'human', id: mode === 'agent-driven' ? 'codex' : 'local-user' }],
    ...(mode === 'human-driven' ? {} : { activeWorker: { kind: 'agent' as const, id: 'codex' } }),
    lastInterventionAt: null,
    lastInterventionBy: null,
    lastInterventionEventId: null,
    controlFreshness: 'fresh',
    ...overrides,
  };
}

function makeSession(overrides: Partial<Session> = {}): Session {
  const session = {
    id: 'sess-1',
    nodeId: 'local',
    type: 'agent',
    agent: 'codex',
    mode: 'pty',
    pty: { write: vi.fn(), resize: vi.fn(), kill: vi.fn() },
    scrollback: [],
    useTmux: false,
    tmuxSessionName: 'relay-sess-1',
    onPtyReplacedCallbacks: [],
    restored: false,
    outputParser: 'codex',
    hookToken: 'hook-token',
    hooksActive: false,
    cleanedUp: false,
    yolo: false,
    claudeArgs: [],
    continuePolicy: 'always',
    cwd: '/repos/relay-ide',
    repoPath: '/repos/relay-ide',
    worktreePath: null,
    repoName: 'relay-ide',
    branchName: 'nightly',
    displayName: 'Agent 1',
    createdAt: baseNow.toISOString(),
    lastActivity: baseNow.toISOString(),
    idle: true,
    customCommand: null,
    status: 'active',
    needsBranchRename: false,
    agentState: 'idle',
    controlState: controlState('agent-driven'),
    ...overrides,
  };
  return session as Session;
}

function captureOptions(records: InterventionRecord[], events: TabControlEvent[] = []) {
  return {
    inputDebounceMs: 100,
    autoRevertMs: 1_000,
    append: (record: InterventionRecord) => records.push(record),
    hasUnacked: (scope: { sessionId: string; nodeId?: string; globalSessionId?: string }) => records.some((record) => {
      if (record.kind !== 'human-input' || record.ackedAt) return false;
      if (record.sessionId !== scope.sessionId) return false;
      if (scope.globalSessionId && record.globalSessionId !== scope.globalSessionId) return false;
      if (scope.nodeId && record.nodeId !== scope.nodeId) return false;
      return true;
    }),
    ackHumanInput: ({ sessionId, nodeId, globalSessionId, actor, ackedAt }: { sessionId: string; nodeId?: string; globalSessionId?: string; actor: ControlActor; ackedAt?: string }) => {
      let count = 0;
      for (const record of records) {
        if (record.kind !== 'human-input' || record.ackedAt) continue;
        if (record.sessionId !== sessionId) continue;
        if (globalSessionId && record.globalSessionId !== globalSessionId) continue;
        if (nodeId && record.nodeId !== nodeId) continue;
        record.ackedBy = actor;
        record.ackedAt = ackedAt ?? baseNow.toISOString();
        count += 1;
      }
      return count;
    },
    emitEvent: (event: TabControlEvent) => events.push(event),
  };
}

describe('control transition engine', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(baseNow);
  });

  afterEach(() => {
    clearPendingControlBurstsForTests();
    vi.useRealTimers();
  });

  it('records one debounced human PTY burst and moves agent-driven sessions to co-driven', () => {
    const session = makeSession();
    const records: InterventionRecord[] = [];
    const events: TabControlEvent[] = [];
    const options = captureOptions(records, events);

    recordHumanPtyInput(session, 'hello', options);
    recordHumanPtyInput(session, ' world', options);

    expect(session.controlState?.controlMode).toBe('co-driven');
    expect(records).toHaveLength(0);
    vi.advanceTimersByTime(99);
    expect(records).toHaveLength(0);
    vi.advanceTimersByTime(1);

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      sessionId: 'sess-1',
      tabId: 'local:sess-1',
      nodeId: 'local',
      globalSessionId: 'local:sess-1',
      source: 'pty-input',
      kind: 'human-input',
      payloadPreview: 'hello world',
      modeBefore: 'agent-driven',
      modeAfter: 'co-driven',
    });
    expect(records[0]?.redaction).toMatchObject({
      redacted: false,
      byteCount: 11,
      charCount: 11,
      lineCount: 1,
      classes: ['plain-text'],
    });
    expect(session.controlState).toMatchObject({
      controlMode: 'co-driven',
      lastInterventionEventId: records[0]?.id,
      controlReason: 'human input',
    });
    expect(events.map((event) => event.type)).toEqual(['tab.mode-changed', 'tab.intervention']);
    expect(events[0]).toMatchObject({
      controlMode: 'co-driven',
      activeActors: [
        { kind: 'human', id: 'local-user' },
        { kind: 'agent', id: 'codex' },
      ],
      activeWorker: { kind: 'agent', id: 'codex' },
    });
  });

  it('does not record human-driven or empty PTY input as intervention input', () => {
    const records: InterventionRecord[] = [];
    const options = captureOptions(records);

    const humanDriven = makeSession({ id: 'human', controlState: controlState('human-driven') });

    recordHumanPtyInput(humanDriven, 'selection noise', options);
    recordHumanPtyInput(makeSession({ id: 'empty' }), '', options);
    vi.advanceTimersByTime(200);

    expect(records).toEqual([]);
    expect(humanDriven.controlState?.controlMode).toBe('human-driven');
  });

  it('refreshes the co-driven idle clock while a human is actively typing', () => {
    const records: InterventionRecord[] = [];
    const options = captureOptions(records);
    const session = makeSession({
      controlState: controlState('co-driven', {
        lastInterventionAt: new Date(baseNow.getTime() - 2_000).toISOString(),
      }),
    });

    recordHumanPtyInput(session, 'still here', options);

    expect(session.controlState).toMatchObject({
      controlMode: 'co-driven',
      controlReason: 'human input',
      lastInterventionAt: baseNow.toISOString(),
    });
    expect(maybeAutoRevertToAgentDriven({ session, options })).toMatchObject({
      reverted: false,
      reason: 'not-idle-long-enough',
    });
    vi.advanceTimersByTime(100);
    expect(maybeAutoRevertToAgentDriven({ session, options })).toMatchObject({
      reverted: false,
      reason: 'unacked-human-input',
    });
    expect(records[0]).toMatchObject({
      kind: 'human-input',
      modeBefore: 'co-driven',
      modeAfter: 'co-driven',
      payloadPreview: 'still here',
    });
  });

  it('redacts secret-like and control-sequence payload previews while retaining counts and hashes', () => {
    const secret = redactInterventionPayload('password=super-secret-token-1234567890');
    expect(secret.payloadPreview).toMatch(/^\[redacted:secret-like\]/);
    expect(secret.redaction).toMatchObject({
      redacted: true,
      classes: ['secret-like'],
      lineCount: 1,
    });
    expect(secret.redaction.hashSha256).toHaveLength(64);

    const control = redactInterventionPayload('\u001b[200~paste\u001b[201~');
    expect(control.payloadPreview).toContain('redacted:control-sequence');
    expect(control.redaction.classes).toContain('control-sequence');
  });

  it('records typed supervisor actions as co-driven intervention events without exposing raw payloads', () => {
    const session = makeSession();
    const records: InterventionRecord[] = [];
    const events: TabControlEvent[] = [];
    const actor: ControlActor = { kind: 'human', id: 'supervisor-1', displayName: 'Supervisor' };
    const options = captureOptions(records, events);

    const event = recordSupervisorAction(session, { action: 'sendText', actor, payload: 'password=raw-secret-value' }, options);

    expect(session.controlState).toMatchObject({
      controlMode: 'co-driven',
      lastInterventionEventId: event.eventId,
      controlReason: 'supervisor sendText',
    });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      source: 'supervisor-action',
      kind: 'supervisor-send-text',
      modeBefore: 'agent-driven',
      modeAfter: 'co-driven',
      ackedAt: baseNow.toISOString(),
    });
    expect(records[0]?.redaction).toMatchObject({
      redacted: true,
      classes: ['secret-like'],
    });
    expect(records[0]).not.toHaveProperty('payloadPreview');
    expect(JSON.stringify(records[0])).not.toContain('raw-secret-value');
    expect(events.map((entry) => entry.type)).toEqual(['tab.mode-changed', 'tab.intervention']);
    expect(event).toMatchObject({
      type: 'tab.intervention',
      controlMode: 'co-driven',
      intervention: { kind: 'supervisor-send-text' },
    });
  });

  it('creates visible intervention and transition events for join, take-over, and hand-back actions', () => {
    const session = makeSession();
    const records: InterventionRecord[] = [];
    const events: TabControlEvent[] = [];
    const options = captureOptions(records, events);

    applyControlModeAction(session, 'join', options);
    expect(session.controlState?.controlMode).toBe('co-driven');
    applyControlModeAction(session, 'take-over', options);
    expect(session.controlState?.controlMode).toBe('human-driven');
    applyControlModeAction(session, 'hand-back', options);
    expect(session.controlState?.controlMode).toBe('agent-driven');

    expect(records.map((record) => record.kind)).toEqual(['join', 'take-over', 'hand-back']);
    expect(events.filter((event) => event.type === 'tab.intervention')).toHaveLength(3);
    expect(events.filter((event) => event.type === 'tab.mode-changed')).toHaveLength(3);
    expect(events.at(-1)).toMatchObject({
      controlMode: 'agent-driven',
      actor: { kind: 'human', id: 'local-user' },
      activeActors: [{ kind: 'agent', id: 'codex' }],
      activeWorker: { kind: 'agent', id: 'codex' },
    });
    expect(records.every((record) => record.ackedAt)).toBe(true);
  });

  it('flushes pending human-input bursts before explicit mode actions and acks', () => {
    const session = makeSession();
    const records: InterventionRecord[] = [];
    const options = captureOptions(records);

    recordHumanPtyInput(session, 'typed before hand-back', options);
    applyControlModeAction(session, 'hand-back', options);

    expect(session.controlState?.controlMode).toBe('agent-driven');
    expect(records.map((record) => record.kind)).toEqual(['human-input', 'hand-back']);
    expect(records[0]).toMatchObject({
      kind: 'human-input',
      ackedAt: records[1]?.timestamp,
      modeAfter: 'co-driven',
    });
    vi.advanceTimersByTime(100);
    expect(session.controlState?.controlMode).toBe('agent-driven');
    expect(records.map((record) => record.kind)).toEqual(['human-input', 'hand-back']);
  });

  it('auto-reverts idle fresh co-driven sessions only after human input is acked', () => {
    const records: InterventionRecord[] = [];
    const events: TabControlEvent[] = [];
    const options = captureOptions(records, events);
    const session = makeSession({
      controlState: controlState('co-driven', {
        lastInterventionAt: new Date(baseNow.getTime() - 2_000).toISOString(),
      }),
    });
    records.push({
      id: 'human-1',
      sessionId: session.id,
      tabId: 'local:sess-1',
      nodeId: 'local',
      globalSessionId: 'local:sess-1',
      cwd: session.cwd,
      timestamp: new Date(baseNow.getTime() - 2_000).toISOString(),
      author: { kind: 'human', id: 'local-user' },
      source: 'pty-input',
      kind: 'human-input',
      payloadPreview: 'x',
      redaction: { redacted: false, byteCount: 1, charCount: 1, lineCount: 1, hashSha256: '0'.repeat(64), classes: ['plain-text'] },
      modeBefore: 'agent-driven',
      modeAfter: 'co-driven',
    });

    expect(maybeAutoRevertToAgentDriven({ session, options })).toMatchObject({
      reverted: false,
      reason: 'unacked-human-input',
    });
    expect(acknowledgeHumanInput(session, { kind: 'agent', id: 'codex' }, options)).toBe(1);

    const result = maybeAutoRevertToAgentDriven({ session, options });
    expect(result).toMatchObject({ reverted: true });
    expect(session.controlState?.controlMode).toBe('agent-driven');
    expect(records.at(-1)).toMatchObject({
      source: 'auto-revert',
      kind: 'auto-revert',
      modeBefore: 'co-driven',
      modeAfter: 'agent-driven',
    });
    expect(events.map((event) => event.type)).toContain('tab.mode-changed');
  });

  it('suppresses auto-revert for stale state, disconnected nodes, and not-idle windows', () => {
    const records: InterventionRecord[] = [];
    const options = captureOptions(records);
    const stale = makeSession({
      controlState: controlState('co-driven', {
        controlFreshness: 'stale',
        lastInterventionAt: new Date(baseNow.getTime() - 2_000).toISOString(),
      }),
    });
    const disconnected = makeSession({
      status: 'disconnected',
      controlState: controlState('co-driven', {
        lastInterventionAt: new Date(baseNow.getTime() - 2_000).toISOString(),
      }),
    });
    const recent = makeSession({
      controlState: controlState('co-driven', {
        lastInterventionAt: new Date(baseNow.getTime() - 500).toISOString(),
      }),
    });

    expect(maybeAutoRevertToAgentDriven({ session: stale, options })).toMatchObject({ reason: 'not-fresh' });
    expect(maybeAutoRevertToAgentDriven({ session: disconnected, options })).toMatchObject({ reason: 'node-disconnected' });
    expect(maybeAutoRevertToAgentDriven({ session: recent, options })).toMatchObject({ reason: 'not-idle-long-enough' });
    expect(records).toHaveLength(0);
  });

  it('carries node-scoped remote and free/non-git tab identity in intervention records', () => {
    const records: InterventionRecord[] = [];
    const options = captureOptions(records);
    const remote = makeSession({
      id: 'remote-session',
      nodeId: 'mac-mini',
      cwd: '/Users/dev/relay-ide/.worktrees/feature',
      repoPath: '/Users/dev/relay-ide',
      worktreePath: '/Users/dev/relay-ide/.worktrees/feature',
      repoName: 'relay-ide',
      branchName: 'feature/tab-control',
    });
    const free = makeSession({
      id: 'free-shell',
      nodeId: 'local',
      cwd: '/tmp',
      repoPath: undefined,
      worktreePath: undefined,
      repoName: undefined,
      branchName: undefined,
    });

    applyControlModeAction(remote, 'join', options);
    applyControlModeAction(free, 'join', options);

    expect(records[0]).toMatchObject({
      sessionId: 'remote-session',
      tabId: 'mac-mini:remote-session',
      nodeId: 'mac-mini',
      globalSessionId: 'mac-mini:remote-session',
      cwd: '/Users/dev/relay-ide/.worktrees/feature',
    });
    expect(records[1]).toMatchObject({
      sessionId: 'free-shell',
      tabId: 'local:free-shell',
      nodeId: 'local',
      globalSessionId: 'local:free-shell',
      cwd: '/tmp',
    });
  });
});

describe('persistent intervention log', () => {
  let configDir: string;

  beforeEach(() => {
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-interventions-'));
    initInterventionLog(configDir);
  });

  afterEach(() => {
    closeInterventionLog();
    fs.rmSync(configDir, { recursive: true, force: true });
  });

  it('persists supervisor action records as hashes-only metadata without raw payload previews', () => {
    const session = makeSession({ id: 'supervisor-plain', nodeId: 'node-a' });
    const actor: ControlActor = { kind: 'human', id: 'supervisor-1', displayName: 'Supervisor' };

    recordSupervisorAction(session, { action: 'sendText', actor, payload: 'hello' });

    const [record] = listInterventions({ sessionId: 'supervisor-plain', nodeId: 'node-a' });
    expect(record).toMatchObject({
      source: 'supervisor-action',
      kind: 'supervisor-send-text',
      redaction: {
        redacted: false,
        byteCount: 5,
        charCount: 5,
        lineCount: 1,
        classes: ['plain-text'],
      },
    });
    expect(record?.redaction.hashSha256).toHaveLength(64);
    expect(record).not.toHaveProperty('payloadPreview');
    expect(JSON.stringify(record)).not.toContain('hello');
  });

  it('persists structured records, lists by session/node, and acks human input', () => {
    const record: InterventionRecord = {
      id: 'int-1',
      sessionId: 'sess-1',
      tabId: 'node-a:sess-1',
      nodeId: 'node-a',
      globalSessionId: 'node-a:sess-1',
      cwd: '/tmp',
      timestamp: baseNow.toISOString(),
      author: { kind: 'human', id: 'operator' },
      source: 'pty-input',
      kind: 'human-input',
      payloadPreview: '[redacted:secret-like] bytes=10 sha256=abcdef',
      redaction: {
        redacted: true,
        byteCount: 10,
        charCount: 10,
        lineCount: 1,
        hashSha256: 'a'.repeat(64),
        classes: ['secret-like'],
      },
      modeBefore: 'agent-driven',
      modeAfter: 'co-driven',
    };

    appendIntervention(record);
    appendIntervention({
      ...record,
      id: 'int-2',
      tabId: 'node-b:sess-1',
      nodeId: 'node-b',
      globalSessionId: 'node-b:sess-1',
    });

    expect(listInterventions({ sessionId: 'sess-1', nodeId: 'node-a' })).toEqual([record]);
    expect(listInterventions({ sessionId: 'sess-1', nodeId: 'other' })).toEqual([]);
    expect(hasUnackedHumanInput('sess-1')).toBe(true);
    expect(hasUnackedHumanInput({ sessionId: 'sess-1', nodeId: 'node-a' })).toBe(true);

    expect(ackSessionHumanInput({
      sessionId: 'sess-1',
      nodeId: 'node-a',
      globalSessionId: 'node-a:sess-1',
      actor: { kind: 'agent', id: 'codex' },
      ackedAt: '2026-05-16T00:00:01.000Z',
    })).toBe(1);

    const [acked] = listInterventions({ sessionId: 'sess-1', nodeId: 'node-a' });
    expect(acked?.ackedAt).toBe('2026-05-16T00:00:01.000Z');
    expect(acked?.ackedBy).toMatchObject({ kind: 'agent', id: 'codex' });
    expect(hasUnackedHumanInput({ sessionId: 'sess-1', nodeId: 'node-a' })).toBe(false);
    expect(hasUnackedHumanInput({ sessionId: 'sess-1', nodeId: 'node-b' })).toBe(true);
    expect(hasUnackedHumanInput('sess-1')).toBe(true);
  });
});
