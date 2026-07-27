import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearPendingControlBurstsForTests,
  recordHumanPtyInput,
  recordSupervisorAction,
  redactInterventionPayload,
} from '../server/control-engine.js';
import {
  closeInterventionLog,
  initInterventionLog,
  listInterventions,
} from '../server/intervention-log.js';
import type { Session } from '../server/types.js';
import type {
  ControlActor,
  InterventionRecord,
  TabControlEvent,
} from '../shared/control-state.js';

const baseNow = new Date('2026-05-16T00:00:00.000Z');

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'sess-1',
    nodeId: 'local',
    type: 'terminal',
    mode: 'pty',
    pty: { write: vi.fn(), resize: vi.fn(), kill: vi.fn() },
    scrollback: [],
    onPtyReplacedCallbacks: [],
    restored: false,
    cleanedUp: false,
    cwd: '/repos/relay-ide',
    repoPath: '/repos/relay-ide',
    worktreePath: null,
    repoName: 'relay-ide',
    branchName: 'nightly',
    displayName: 'Terminal 1',
    createdAt: baseNow.toISOString(),
    lastActivity: baseNow.toISOString(),
    idle: true,
    customCommand: null,
    status: 'active',
    needsBranchRename: false,
    activityState: 'idle',
    controlState: {
      controlMode: 'human-driven',
      activeActors: [{ kind: 'human', id: 'local-user' }],
      lastInterventionAt: null,
      lastInterventionBy: null,
      lastInterventionEventId: null,
      controlFreshness: 'fresh',
    },
    ...overrides,
  } as Session;
}

function captureOptions(
  records: InterventionRecord[],
  events: TabControlEvent[] = []
) {
  return {
    inputDebounceMs: 100,
    append: (record: InterventionRecord) => records.push(record),
    emitEvent: (event: TabControlEvent) => events.push(event),
  };
}

describe('human terminal intervention engine', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(baseNow);
  });

  afterEach(() => {
    clearPendingControlBurstsForTests();
    vi.useRealTimers();
  });

  it('records one debounced human PTY burst without changing terminal ownership', () => {
    const session = makeSession();
    const records: InterventionRecord[] = [];
    const events: TabControlEvent[] = [];

    recordHumanPtyInput(session, 'hello', captureOptions(records, events));
    recordHumanPtyInput(session, ' world', captureOptions(records, events));
    vi.advanceTimersByTime(100);

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      sessionId: 'sess-1',
      tabId: 'local:sess-1',
      source: 'pty-input',
      kind: 'human-input',
      payloadPreview: 'hello world',
      modeBefore: 'human-driven',
      modeAfter: 'human-driven',
    });
    expect(session.controlState).toMatchObject({
      controlMode: 'human-driven',
      activeActors: [{ kind: 'human', id: 'local-user' }],
      lastInterventionEventId: records[0]?.id,
      controlReason: 'human input',
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'tab.intervention',
      controlMode: 'human-driven',
    });
  });

  it('ignores empty PTY input', () => {
    const records: InterventionRecord[] = [];
    recordHumanPtyInput(makeSession(), '', captureOptions(records));
    vi.advanceTimersByTime(100);
    expect(records).toEqual([]);
  });

  it('redacts secret-like and control-sequence payload previews', () => {
    const secret = redactInterventionPayload(
      'password=super-secret-token-1234567890'
    );
    expect(secret.payloadPreview).toMatch(/^\[redacted:secret-like\]/);
    expect(secret.redaction.hashSha256).toHaveLength(64);

    const control = redactInterventionPayload('\u001b[200~paste\u001b[201~');
    expect(control.payloadPreview).toContain('redacted:control-sequence');
  });

  it('records supervisor input as a human-driven intervention without raw payload', () => {
    const session = makeSession();
    const records: InterventionRecord[] = [];
    const events: TabControlEvent[] = [];
    const actor: ControlActor = {
      kind: 'agent',
      id: 'channel-profile:orchestrator',
      displayName: 'Channel orchestrator',
    };

    const event = recordSupervisorAction(
      session,
      {
        action: 'sendText',
        actor,
        payload: 'password=raw-secret-value',
      },
      captureOptions(records, events)
    );

    expect(session.controlState).toMatchObject({
      controlMode: 'human-driven',
      activeActors: [{ kind: 'human', id: 'local-user' }],
      lastInterventionEventId: event.eventId,
    });
    expect(records[0]).toMatchObject({
      source: 'supervisor-action',
      kind: 'supervisor-send-text',
      modeBefore: 'human-driven',
      modeAfter: 'human-driven',
      ackedAt: baseNow.toISOString(),
    });
    expect(records[0]).not.toHaveProperty('payloadPreview');
    expect(JSON.stringify(records[0])).not.toContain('raw-secret-value');
    expect(events.map((entry) => entry.type)).toEqual(['tab.intervention']);
  });

  it('keeps node-scoped identity in human input records', () => {
    const records: InterventionRecord[] = [];
    const remote = makeSession({
      id: 'remote-session',
      nodeId: 'mac-mini',
      cwd: '/Users/dev/relay-ide/.worktrees/feature',
    });

    recordHumanPtyInput(remote, 'x', captureOptions(records));
    vi.advanceTimersByTime(100);

    expect(records[0]).toMatchObject({
      sessionId: 'remote-session',
      tabId: 'mac-mini:remote-session',
      globalSessionId: 'mac-mini:remote-session',
      cwd: '/Users/dev/relay-ide/.worktrees/feature',
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

  it('persists hashes-only supervisor metadata', () => {
    const session = makeSession({ id: 'supervisor-plain', nodeId: 'node-a' });
    recordSupervisorAction(session, {
      action: 'sendText',
      actor: { kind: 'human', id: 'supervisor-1' },
      payload: 'hello',
    });

    const [record] = listInterventions({
      sessionId: 'supervisor-plain',
      nodeId: 'node-a',
    });
    expect(record).toMatchObject({
      source: 'supervisor-action',
      kind: 'supervisor-send-text',
      modeBefore: 'human-driven',
      modeAfter: 'human-driven',
      redaction: { byteCount: 5, classes: ['plain-text'] },
    });
    expect(record).not.toHaveProperty('payloadPreview');
  });
});
