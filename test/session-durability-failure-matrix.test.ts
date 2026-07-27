// #614 slice 5: failure-matrix QA suite for session durability. Verifies that
// every documented durability transition surfaces through `sessions.list()`
// + the `session-durability-changed` event. Where the real failure mode
// is hard to fake in a unit test (laptop sleep, network flap), we mutate
// the session signals the production code paths set anyway.

import { describe, it, afterEach, beforeAll, afterAll, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as sessions from '../server/sessions.js';
import type { PtySession } from '../server/types.js';
import type { SessionDurabilityState } from '../shared/session-durability.js';

const execFileAsync = promisify(execFile);
const createdIds: string[] = [];
let tmuxTmpdir: string;
let previousTmuxTmpdir: string | undefined;

beforeAll(() => {
  previousTmuxTmpdir = process.env.TMUX_TMPDIR;
  tmuxTmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-failure-matrix-'));
  process.env.TMUX_TMPDIR = tmuxTmpdir;
});

afterEach(async () => {
  for (const id of createdIds) {
    try {
      sessions.kill(id);
    } catch {
      // Already killed
    }
  }
  createdIds.length = 0;
  sessions.setSessionNodeStatusResolver(null);
  await Promise.resolve();
});

afterAll(() => {
  if (tmuxTmpdir) fs.rmSync(tmuxTmpdir, { recursive: true, force: true });
  if (previousTmuxTmpdir === undefined) delete process.env.TMUX_TMPDIR;
  else process.env.TMUX_TMPDIR = previousTmuxTmpdir;
  void execFileAsync('tmux', ['kill-server'], {
    env: { ...process.env },
  }).catch(() => {});
});

function makeSession(label: string): {
  id: string;
  session: PtySession;
} {
  const result = sessions.create({
    repoName: label,
    repoPath: '/tmp',
    worktreePath: null,
    cwd: '/tmp',
    command: '/bin/echo',
    args: ['hi'],
  });
  createdIds.push(result.id);
  const session = sessions.get(result.id) as PtySession;
  expect(session).toBeTruthy();
  return { id: result.id, session };
}

function durabilityOf(id: string): SessionDurabilityState | undefined {
  return sessions.list().find((s) => s.id === id)?.durability;
}

interface CapturedTransition {
  sessionId: string;
  from: SessionDurabilityState | undefined;
  to: SessionDurabilityState;
}

function captureTransitions(): {
  unsubscribe: () => void;
  events: CapturedTransition[];
} {
  const events: CapturedTransition[] = [];
  const unsubscribe = sessions.onSessionDurabilityChanged((event) => {
    events.push({
      sessionId: event.sessionId,
      from: event.from,
      to: event.to,
    });
  });
  return { unsubscribe, events };
}

describe('session durability — failure matrix (#614 slice 5)', () => {
  it('tab close / socket drop while process alive → running-detached', () => {
    // Closing a browser tab on the live UI flips `session.status` to
    // `disconnected` once the WS handler clears its attach. The hub keeps
    // the process running; durability must surface `running-detached`
    // instead of pretending the session is still attached.
    const { id, session } = makeSession('tab-close');
    expect(durabilityOf(id)).toBe('running-attached');

    const cap = captureTransitions();
    try {
      session.status = 'disconnected';
      expect(durabilityOf(id)).toBe('running-detached');
      const transitions = cap.events.filter((e) => e.sessionId === id);
      expect(transitions.at(-1)).toMatchObject({
        from: 'running-attached',
        to: 'running-detached',
      });
    } finally {
      cap.unsubscribe();
    }
  });

  it('node link drops while running-attached → stale-node, reconnect → running-attached', () => {
    // Production wires a node-status resolver to `hubNodeRegistry`. The
    // matrix here flips a fake resolver so the transition fires through
    // the same `emitDurabilityIfChanged` path the hub uses.
    const { id, session } = makeSession('node-drop');
    session.nodeId = 'remote-test' as typeof session.nodeId;
    expect(durabilityOf(id)).toBe('running-attached');

    const cap = captureTransitions();
    try {
      let reported: 'online' | 'offline' | 'stale' | 'revoked' = 'online';
      sessions.setSessionNodeStatusResolver(() => reported);
      sessions.refreshDurability([id]);
      expect(durabilityOf(id)).toBe('running-attached');

      reported = 'offline';
      sessions.refreshDurability([id]);
      expect(durabilityOf(id)).toBe('stale-node');

      // Node comes back online — durability should return to running-attached
      // without any other signal changing on the session.
      reported = 'online';
      sessions.refreshDurability([id]);
      expect(durabilityOf(id)).toBe('running-attached');

      const transitions = cap.events.filter((e) => e.sessionId === id);
      const toStates = transitions.map((t) => t.to);
      expect(toStates).toEqual(
        expect.arrayContaining(['stale-node', 'running-attached'])
      );
    } finally {
      cap.unsubscribe();
    }
  });

  it('PTY process exit → ended', () => {
    // `runExitCleanup` flips `session.cleanedUp = true` before removing
    // the record from the map. The durability derivation must surface
    // `ended` so any consumer that snapshots the registry mid-cleanup
    // (or persists last-known summaries) reports the truth.
    const { id, session } = makeSession('pty-exit');
    expect(durabilityOf(id)).toBe('running-attached');

    const cap = captureTransitions();
    try {
      session.cleanedUp = true;
      expect(durabilityOf(id)).toBe('ended');
      expect(cap.events.at(-1)).toMatchObject({
        sessionId: id,
        to: 'ended',
      });
    } finally {
      cap.unsubscribe();
    }
  });

  it('agent error transition → error', () => {
    // Terminal runtime failures set `activityState = 'error'`.
    // (e.g. parser-detected error frames
    // for PTY sessions). Durability must surface this ahead of the
    // attached/detached default.
    const { id, session } = makeSession('agent-error');
    expect(durabilityOf(id)).toBe('running-attached');

    const cap = captureTransitions();
    try {
      session.activityState = 'error';
      expect(durabilityOf(id)).toBe('error');
      expect(cap.events.at(-1)).toMatchObject({
        sessionId: id,
        to: 'error',
      });
    } finally {
      cap.unsubscribe();
    }
  });

  it('permission prompt → permission-needed without disabling the session', () => {
    // Permission prompts are durability transitions too — they let the
    // mobile card light up an approval affordance without touching
    // attach state. Slice 3 explicitly does NOT disable controls for
    // this state; this test pins that behaviour.
    const { id, session } = makeSession('permission');
    expect(durabilityOf(id)).toBe('running-attached');

    const cap = captureTransitions();
    try {
      session.activityState = 'permission-prompt';
      expect(durabilityOf(id)).toBe('permission-needed');
      expect(cap.events.at(-1)?.to).toBe('permission-needed');
    } finally {
      cap.unsubscribe();
    }
  });
});
