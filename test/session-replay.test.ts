import { describe, it, afterEach, beforeAll, afterAll, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as sessions from '../server/sessions.js';
import type { PtySession } from '../server/types.js';
import { DEFAULT_SESSION_REPLAY_CAPACITY_BYTES } from '../shared/session-replay.js';

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
