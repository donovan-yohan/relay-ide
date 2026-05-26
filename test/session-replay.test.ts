import { describe, it, afterEach, beforeAll, afterAll, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as sessions from '../server/sessions.js';
import type { PtySession } from '../server/types.js';
import {
  appendTerminalStreamData,
  buildTerminalStreamReplay,
  createTerminalStreamState,
  DEFAULT_SESSION_REPLAY_CAPACITY_BYTES,
  dropTerminalStreamPrefixBytes,
  recordTerminalStreamResize,
} from '../shared/session-replay.js';

const createdIds: string[] = [];
let tmuxTmpdir: string;
let previousTmuxTmpdir: string | undefined;

beforeAll(() => {
  previousTmuxTmpdir = process.env.TMUX_TMPDIR;
  tmuxTmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-tmux-'));
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
});

afterAll(() => {
  if (tmuxTmpdir) fs.rmSync(tmuxTmpdir, { recursive: true, force: true });
  if (previousTmuxTmpdir === undefined) delete process.env.TMUX_TMPDIR;
  else process.env.TMUX_TMPDIR = previousTmuxTmpdir;
});

describe('getReplaySnapshot', () => {
  it('returns null for unknown session ids', () => {
    expect(sessions.getReplaySnapshot('does-not-exist')).toBeNull();
  });

  it('returns a typed snapshot for a PTY session with no output yet', () => {
    const result = sessions.create({
      repoName: 'replay-empty',
      repoPath: '/tmp',
      worktreePath: null,
      cwd: '/tmp',
      command: '/bin/echo',
      args: ['hi'],
    });
    createdIds.push(result.id);
    const snap = sessions.getReplaySnapshot(result.id);
    expect(snap).not.toBeNull();
    expect(snap?.sessionId).toBe(result.id);
    expect(snap?.bytesIncluded).toBe(snap?.payload.length);
    expect(snap?.bytesDropped).toBe(0);
    expect(snap?.truncated).toBe(false);
    expect(snap?.capacityBytes).toBe(DEFAULT_SESSION_REPLAY_CAPACITY_BYTES);
    expect(snap?.capturedAt).toMatch(/T.*Z$/);
  });

  it('reports the per-session effective cap, not the shared default', () => {
    const result = sessions.create({
      repoName: 'replay-custom-cap',
      repoPath: '/tmp',
      worktreePath: null,
      cwd: '/tmp',
      command: '/bin/echo',
      args: ['hi'],
    });
    createdIds.push(result.id);
    const session = sessions.get(result.id) as PtySession;
    // Sessions can be created with a non-default cap via
    // `maxScrollbackBytes`; the snapshot must reflect that effective cap
    // rather than the shared default, so consumers don't act on stale
    // metadata.
    session.scrollbackCapacityBytes = 4096;
    const snap = sessions.getReplaySnapshot(result.id);
    expect(snap?.capacityBytes).toBe(4096);
  });

  it('reports bytesDropped and truncated=true after the FIFO evicts', () => {
    const result = sessions.create({
      repoName: 'replay-trunc',
      repoPath: '/tmp',
      worktreePath: null,
      cwd: '/tmp',
      command: '/bin/echo',
      args: ['hi'],
    });
    createdIds.push(result.id);
    const session = sessions.get(result.id) as PtySession;
    // Simulate the FIFO evicting bytes by mutating the lifetime counter
    // directly — exercising the snapshot shape without needing to write
    // 256KB through the real PTY in a unit test.
    session.scrollbackBytesEvicted = 12_345;
    const snap = sessions.getReplaySnapshot(result.id);
    expect(snap?.bytesDropped).toBe(12_345);
    expect(snap?.truncated).toBe(true);
  });
});

describe('terminal stream v2 replay envelopes', () => {
  it('backfills from a known cursor with monotonic envelope sequence and cursor', () => {
    const state = createTerminalStreamState({ sessionId: 'sess-replay' });
    appendTerminalStreamData(state, 'hello');
    appendTerminalStreamData(state, ' world');
    const beforeReplayNextSeq = state.nextSeq;

    const replay = buildTerminalStreamReplay(state, 5);

    expect(replay.map((envelope) => envelope.kind)).toEqual([
      'metadata',
      'lag',
      'replay-start',
      'data',
      'replay-end',
    ]);
    expect(replay[1]?.kind).toBe('lag');
    if (replay[1]?.kind === 'lag') {
      expect(replay[1].payload.reason).toBe('server-backfill');
      expect(replay[1].payload.requestedCursor).toBe(5);
    }
    const replayedData = replay.find((envelope) => envelope.kind === 'data');
    expect(replayedData?.kind).toBe('data');
    if (replayedData?.kind === 'data') {
      expect(replayedData.payload.data).toBe(' world');
      expect(replayedData.payload.range).toEqual({ start: 5, end: 11 });
    }
    expect(replay.map((envelope) => envelope.seq)).toEqual([2, 3, 4, 5, 6]);
    expect(replay.map((envelope) => envelope.cursor)).toEqual([
      5, 5, 5, 11, 11,
    ]);
    expect(state.nextSeq).toBe(beforeReplayNextSeq);

    const liveAfterReplay = appendTerminalStreamData(state, '!');
    expect(liveAfterReplay.seq).toBe(beforeReplayNextSeq);
  });

  it('marks too-old cursors stale and replays from the oldest retained cursor', () => {
    const state = createTerminalStreamState({ sessionId: 'sess-stale' });
    appendTerminalStreamData(state, 'abcdef');
    dropTerminalStreamPrefixBytes(state, 3);

    const replay = buildTerminalStreamReplay(state, 0);
    const lag = replay.find((envelope) => envelope.kind === 'lag');
    const replayStart = replay.find(
      (envelope) => envelope.kind === 'replay-start'
    );
    const replayedData = replay.find((envelope) => envelope.kind === 'data');

    expect(lag?.kind).toBe('lag');
    if (lag?.kind === 'lag') {
      expect(lag.payload.reason).toBe('cursor-too-old');
      expect(lag.payload.oldestCursor).toBe(3);
      expect(lag.payload.latestCursor).toBe(6);
    }
    expect(replayStart?.kind).toBe('replay-start');
    if (replayStart?.kind === 'replay-start') {
      expect(replayStart.payload.startCursor).toBe(3);
      expect(replayStart.payload.endCursor).toBe(6);
    }
    expect(replayedData?.kind).toBe('data');
    if (replayedData?.kind === 'data') {
      expect(replayedData.payload.data).toBe('def');
      expect(replayedData.payload.range).toEqual({ start: 3, end: 6 });
    }
  });
});

describe('terminal stream v2 resize ownership', () => {
  it('applies active resize owner events and records passive mirrors as non-applying', () => {
    const state = createTerminalStreamState({ sessionId: 'sess-resize' });

    const active = recordTerminalStreamResize(state, {
      cols: 120,
      rows: 40,
      owner: 'active',
      sourceClientId: 'client-active',
    });
    const passive = recordTerminalStreamResize(state, {
      cols: 80,
      rows: 24,
      owner: 'passive',
      sourceClientId: 'client-passive',
    });

    expect(active.payload).toMatchObject({
      cols: 120,
      rows: 40,
      owner: 'active',
      ownerClientId: 'client-active',
      sourceClientId: 'client-active',
      applied: true,
    });
    expect(passive.payload).toMatchObject({
      cols: 80,
      rows: 24,
      owner: 'passive',
      ownerClientId: 'client-active',
      sourceClientId: 'client-passive',
      applied: false,
    });
    expect(state.activeResizeOwnerId).toBe('client-active');
  });
});
