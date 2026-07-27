import { describe, expect, it } from 'vitest';

import {
  buildPtyCapacityResponse,
  countActivePtySessions,
  sessionCreateErrorResponse,
} from '../server/session-capacity.js';

describe('PTY session capacity', () => {
  it('counts only active PTY sessions', () => {
    expect(
      countActivePtySessions([
        { mode: 'pty', status: 'active' },
        { mode: 'pty', status: 'disconnected' },
        { mode: 'pty' },
      ])
    ).toBe(2);
  });

  it('builds a structured soft-cap response when active PTY sessions reach the configured limit', () => {
    expect(buildPtyCapacityResponse(12, 12)).toEqual({
      error: 'pty_capacity_exhausted',
      message:
        'Session limit reached: 12 active PTY sessions. Close inactive sessions and try again.',
      activePtySessions: 12,
      maxPtySessions: 12,
    });
  });

  it('classifies node-pty spawn failures as capacity exhaustion', () => {
    expect(
      sessionCreateErrorResponse(new Error('posix_spawnp failed'), 73, 64)
    ).toEqual({
      error: 'pty_capacity_exhausted',
      message:
        'Unable to start a new terminal session. Too many PTY sessions may already be active; close inactive sessions and try again.',
      activePtySessions: 73,
      maxPtySessions: 64,
    });
  });
});
