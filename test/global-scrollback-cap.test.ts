/**
 * Tests for the global scrollback cap (Lever 2 of issue #331).
 *
 * Tests `enforceGlobalScrollbackCap` directly via the exported function.
 * The function accepts an optional `sessionProvider` injection so we can
 * exercise all code paths without spinning up real PTY processes.
 */

import { describe, it, expect } from 'vitest';
import { enforceGlobalScrollbackCap } from '../server/sessions.js';
import type { PtySession } from '../server/types.js';

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Build a minimal PtySession-shaped object for testing scrollback trimming.
 * Only the fields used by enforceGlobalScrollbackCap are needed.
 */
function makeSession(
  id: string,
  scrollbackChunks: string[],
  lastActivity: string
): PtySession {
  return {
    id,
    mode: 'pty',
    scrollback: [...scrollbackChunks],
    lastActivity,
    // Stub remaining required fields so TypeScript is satisfied
    type: 'terminal',
    agent: 'claude',
    nodeId: 'local',
    displayName: id,
    cwd: '/tmp',
    createdAt: lastActivity,
    idle: false,
    status: 'active',
    agentState: 'idle',
    useTmux: false,
    tmuxSessionName: '',
    onPtyReplacedCallbacks: [],
    restored: false,
    outputParser: { onData: () => null, reset: () => {} },
    hookToken: '',
    hooksActive: false,
    cleanedUp: false,
    yolo: false,
    claudeArgs: [],
    continuePolicy: 'never',
    pty: {} as PtySession['pty'],
  } as unknown as PtySession;
}

// ── Smoke test: real function with no live sessions ────────────────────────────

describe('enforceGlobalScrollbackCap (real export, empty sessions)', () => {
  it('is a function', () => {
    expect(typeof enforceGlobalScrollbackCap).toBe('function');
  });

  it('returns 0 when the internal sessions Map is empty', () => {
    // Module is freshly imported; no live sessions have been created.
    const freed = enforceGlobalScrollbackCap(undefined);
    expect(freed).toBe(0);
  });
});

// ── Injectable session-provider tests ─────────────────────────────────────────
// All of the following call the REAL enforceGlobalScrollbackCap with an
// explicit sessionProvider so we control the input without needing live PTYs.
// The cap parameter cannot be injected (it is module-level), but we can stay
// well under or well over the default 4 MB cap by choosing chunk sizes.

describe('enforceGlobalScrollbackCap via sessionProvider', () => {
  it('returns 0 when total scrollback is within the cap', () => {
    const s = makeSession(
      's1',
      ['a'.repeat(100), 'b'.repeat(100)],
      '2024-01-01T00:00:00.000Z'
    );
    // 200 bytes total — well under 4 MB cap.
    const freed = enforceGlobalScrollbackCap(undefined, () => [s]);
    expect(freed).toBe(0);
    expect(s.scrollback).toHaveLength(2); // untouched
  });

  it('trims oldest non-active session first when cap is exceeded', () => {
    // We need > 4 MB to trigger the real cap.
    const BIG = 2 * 1024 * 1024 + 1; // 2 MB + 1 byte each → 4 MB + 2 bytes total
    const s1 = makeSession('s1', ['a'.repeat(BIG)], '2024-01-01T00:00:00.000Z');
    const s2 = makeSession('s2', ['b'.repeat(BIG)], '2024-01-02T00:00:00.000Z');

    const freed = enforceGlobalScrollbackCap(undefined, () => [s1, s2]);
    expect(freed).toBeGreaterThan(0);
    // s1 (older lastActivity) should be trimmed first.
    expect(s1.scrollback).toHaveLength(0);
    // s2 (newer) should remain because trimming s1 was enough to get under 4 MB.
    expect(s2.scrollback).toHaveLength(1);
  });

  it('never trims the active session', () => {
    const BIG = 3 * 1024 * 1024; // 3 MB each → 6 MB total, 2 MB over cap
    const active = makeSession(
      'active',
      ['x'.repeat(BIG)],
      '2024-01-01T00:00:00.000Z' // oldest — would normally be trimmed first
    );
    const other = makeSession(
      'other',
      ['y'.repeat(BIG)],
      '2024-01-02T00:00:00.000Z'
    );

    const freed = enforceGlobalScrollbackCap('active', () => [active, other]);
    expect(freed).toBeGreaterThan(0);
    // Active session must not be touched, even though it is the oldest.
    expect(active.scrollback).toHaveLength(1);
    // The other session should be trimmed.
    expect(other.scrollback).toHaveLength(0);
  });

  it('trims across multiple sessions when one is not enough', () => {
    // 3 sessions × 2 MB = 6 MB total → need to free 2 MB to get under 4 MB cap.
    const MB2 = 2 * 1024 * 1024;
    const s1 = makeSession('s1', ['a'.repeat(MB2)], '2024-01-01T00:00:00.000Z');
    const s2 = makeSession('s2', ['b'.repeat(MB2)], '2024-01-02T00:00:00.000Z');
    const s3 = makeSession('s3', ['c'.repeat(MB2)], '2024-01-03T00:00:00.000Z');

    const freed = enforceGlobalScrollbackCap(undefined, () => [s1, s2, s3]);
    expect(freed).toBeGreaterThan(0);
    // s1 (oldest) is trimmed first; s2 may also be trimmed; s3 (newest) stays.
    expect(s3.scrollback).toHaveLength(1);
  });

  it('returns 0 with no sessions', () => {
    const freed = enforceGlobalScrollbackCap(undefined, () => []);
    expect(freed).toBe(0);
  });

  it('trims within a session chunk-by-chunk', () => {
    // One session with 3 chunks of 2 MB each → 6 MB, 2 MB over cap.
    const MB2 = 2 * 1024 * 1024;
    const s1 = makeSession(
      's1',
      ['a'.repeat(MB2), 'b'.repeat(MB2), 'c'.repeat(MB2)],
      '2024-01-01T00:00:00.000Z'
    );

    const freed = enforceGlobalScrollbackCap(undefined, () => [s1]);
    expect(freed).toBeGreaterThan(0);
    // At least the first (oldest) chunk should have been trimmed.
    expect(s1.scrollback.length).toBeLessThan(3);
    // The last (newest) chunk should survive since it's the final one.
    expect(s1.scrollback[s1.scrollback.length - 1]).toBe('c'.repeat(MB2));
  });
});
