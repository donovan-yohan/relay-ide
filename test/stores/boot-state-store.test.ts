import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Mock localStorage before importing the store
const storage: Record<string, string> = {};
if (typeof globalThis.localStorage === 'undefined') {
  Object.defineProperty(globalThis, 'localStorage', {
    value: {
      getItem: (key: string) => storage[key] ?? null,
      setItem: (key: string, value: string) => { storage[key] = value; },
      removeItem: (key: string) => { delete storage[key]; },
      clear: () => { for (const key of Object.keys(storage)) delete storage[key]; },
      get length() { return Object.keys(storage).length; },
      key: (index: number) => Object.keys(storage)[index] ?? null,
    },
    configurable: true,
  });
}

import { useBootStateStore } from '../../frontend/src/lib/stores/boot-state.js';

function resetStore() {
  useBootStateStore.setState({
    phase: 'idle',
    greeting: '',
    lines: [],
    bootComplete: false,
  });
}

describe('boot-state Zustand store', () => {
  beforeEach(() => {
    resetStore();
  });

  describe('startBoot', () => {
    it('transitions from idle to greeting', () => {
      useBootStateStore.getState().startBoot();
      const state = useBootStateStore.getState();
      assert.strictEqual(state.phase, 'greeting');
      assert.strictEqual(state.lines.length, 5);
      assert.ok(state.greeting.length > 0, 'greeting should be non-empty');
    });

    it('creates 5 boot lines for all services', () => {
      useBootStateStore.getState().startBoot();
      const { lines } = useBootStateStore.getState();
      assert.deepStrictEqual(
        lines.map((l) => l.service),
        ['auth', 'workspaces', 'sessions', 'worktrees', 'groups']
      );
    });

    it('all lines start as pending', () => {
      useBootStateStore.getState().startBoot();
      const { lines } = useBootStateStore.getState();
      for (const line of lines) {
        assert.strictEqual(line.status, 'pending');
      }
    });

    it('is a no-op if already past idle', () => {
      useBootStateStore.getState().startBoot();
      const greetingAfterFirst = useBootStateStore.getState().greeting;
      useBootStateStore.getState().startBoot();
      assert.strictEqual(useBootStateStore.getState().phase, 'greeting');
      assert.strictEqual(useBootStateStore.getState().greeting, greetingAfterFirst);
    });
  });

  describe('reportFetch', () => {
    beforeEach(() => {
      useBootStateStore.getState().startBoot();
    });

    it('updates a known service to loading', () => {
      useBootStateStore.getState().reportFetch('workspaces', 'loading');
      const ws = useBootStateStore.getState().lines.find((l) => l.service === 'workspaces')!;
      assert.strictEqual(ws.status, 'loading');
    });

    it('updates a service to ok with summary and duration', () => {
      useBootStateStore.getState().reportFetch('sessions', 'ok', {
        summary: '2 active',
        durationMs: 42,
      });
      const sess = useBootStateStore.getState().lines.find((l) => l.service === 'sessions')!;
      assert.strictEqual(sess.status, 'ok');
      assert.strictEqual(sess.summary, '2 active');
      assert.strictEqual(sess.durationMs, 42);
    });

    it('updates a service to fail with error', () => {
      useBootStateStore.getState().reportFetch('worktrees', 'fail', {
        error: 'timeout',
        durationMs: 5000,
      });
      const wt = useBootStateStore.getState().lines.find((l) => l.service === 'worktrees')!;
      assert.strictEqual(wt.status, 'fail');
      assert.strictEqual(wt.error, 'timeout');
      assert.strictEqual(wt.durationMs, 5000);
    });

    it('ignores unknown service', () => {
      const linesBefore = [...useBootStateStore.getState().lines];
      useBootStateStore.getState().reportFetch('unknown-service', 'ok');
      assert.deepStrictEqual(useBootStateStore.getState().lines, linesBefore);
    });

    it('does not affect other lines', () => {
      useBootStateStore.getState().reportFetch('auth', 'ok', { durationMs: 10 });
      const { lines } = useBootStateStore.getState();
      for (const line of lines) {
        if (line.service !== 'auth') {
          assert.strictEqual(line.status, 'pending', `${line.service} should still be pending`);
        }
      }
    });

    it('transitions from greeting to booting on first non-auth loading', () => {
      assert.strictEqual(useBootStateStore.getState().phase, 'greeting');
      useBootStateStore.getState().reportFetch('workspaces', 'loading');
      assert.strictEqual(useBootStateStore.getState().phase, 'booting');
    });

    it('does not transition to booting on auth loading', () => {
      useBootStateStore.getState().reportFetch('auth', 'loading');
      assert.strictEqual(useBootStateStore.getState().phase, 'greeting');
    });
  });

  describe('finishBoot', () => {
    beforeEach(() => {
      useBootStateStore.getState().startBoot();
    });

    it('returns ready when all non-auth lines are ok', () => {
      const { reportFetch } = useBootStateStore.getState();
      reportFetch('auth', 'ok');
      reportFetch('workspaces', 'ok', { summary: '3 repos' });
      reportFetch('sessions', 'ok', { summary: '2 active' });
      reportFetch('worktrees', 'ok', { summary: '1 tree' });
      reportFetch('groups', 'ok', { summary: '0 groups' });
      useBootStateStore.getState().finishBoot();
      assert.strictEqual(useBootStateStore.getState().phase, 'ready');
      assert.strictEqual(useBootStateStore.getState().bootComplete, true);
    });

    it('returns degraded when one fetch fails', () => {
      const { reportFetch } = useBootStateStore.getState();
      reportFetch('auth', 'ok');
      reportFetch('workspaces', 'ok', { summary: '3 repos' });
      reportFetch('sessions', 'fail', { error: 'timeout' });
      reportFetch('worktrees', 'ok', { summary: '1 tree' });
      reportFetch('groups', 'ok', { summary: '0 groups' });
      useBootStateStore.getState().finishBoot();
      assert.strictEqual(useBootStateStore.getState().phase, 'degraded');
      assert.strictEqual(useBootStateStore.getState().bootComplete, true);
    });

    it('ignores auth status when deriving phase', () => {
      const { reportFetch } = useBootStateStore.getState();
      reportFetch('auth', 'fail');
      reportFetch('workspaces', 'ok', { summary: '3 repos' });
      reportFetch('sessions', 'ok', { summary: '0 active' });
      reportFetch('worktrees', 'ok', { summary: '0 trees' });
      reportFetch('groups', 'ok', { summary: '0 groups' });
      useBootStateStore.getState().finishBoot();
      assert.strictEqual(useBootStateStore.getState().phase, 'ready');
    });
  });

  describe('resetBoot', () => {
    it('resets to greeting phase with fresh lines', () => {
      useBootStateStore.getState().startBoot();
      useBootStateStore.getState().reportFetch('auth', 'ok');
      useBootStateStore.getState().finishBoot();
      assert.strictEqual(useBootStateStore.getState().phase, 'ready');

      useBootStateStore.getState().resetBoot();
      assert.strictEqual(useBootStateStore.getState().phase, 'greeting');
      assert.strictEqual(useBootStateStore.getState().bootComplete, false);
      assert.strictEqual(useBootStateStore.getState().lines.length, 5);
      for (const line of useBootStateStore.getState().lines) {
        assert.strictEqual(line.status, 'pending');
      }
    });
  });
});
