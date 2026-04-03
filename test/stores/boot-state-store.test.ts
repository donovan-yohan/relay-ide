import { describe, it, beforeEach, expect } from 'vitest';

// Mock localStorage before importing the store
const storage: Record<string, string> = {};
if (typeof globalThis.localStorage === 'undefined') {
  Object.defineProperty(globalThis, 'localStorage', {
    value: {
      getItem: (key: string) => storage[key] ?? null,
      setItem: (key: string, value: string) => {
        storage[key] = value;
      },
      removeItem: (key: string) => {
        delete storage[key];
      },
      clear: () => {
        for (const key of Object.keys(storage)) delete storage[key];
      },
      get length() {
        return Object.keys(storage).length;
      },
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
      expect(state.phase).toBe('greeting');
      expect(state.lines.length).toBe(5);
      expect(state.greeting.length).toBeGreaterThan(0);
    });

    it('creates 5 boot lines for all services', () => {
      useBootStateStore.getState().startBoot();
      const { lines } = useBootStateStore.getState();
      expect(lines.map((l) => l.service)).toEqual([
        'auth',
        'workspaces',
        'sessions',
        'worktrees',
        'groups',
      ]);
    });

    it('all lines start as pending', () => {
      useBootStateStore.getState().startBoot();
      const { lines } = useBootStateStore.getState();
      for (const line of lines) {
        expect(line.status).toBe('pending');
      }
    });

    it('is a no-op if already past idle', () => {
      useBootStateStore.getState().startBoot();
      const greetingAfterFirst = useBootStateStore.getState().greeting;
      useBootStateStore.getState().startBoot();
      expect(useBootStateStore.getState().phase).toBe('greeting');
      expect(useBootStateStore.getState().greeting).toBe(greetingAfterFirst);
    });
  });

  describe('reportFetch', () => {
    beforeEach(() => {
      useBootStateStore.getState().startBoot();
    });

    it('updates a known service to loading', () => {
      useBootStateStore.getState().reportFetch('workspaces', 'loading');
      const ws = useBootStateStore
        .getState()
        .lines.find((l) => l.service === 'workspaces')!;
      expect(ws.status).toBe('loading');
    });

    it('updates a service to ok with summary and duration', () => {
      useBootStateStore.getState().reportFetch('sessions', 'ok', {
        summary: '2 active',
        durationMs: 42,
      });
      const sess = useBootStateStore
        .getState()
        .lines.find((l) => l.service === 'sessions')!;
      expect(sess.status).toBe('ok');
      expect(sess.summary).toBe('2 active');
      expect(sess.durationMs).toBe(42);
    });

    it('updates a service to fail with error', () => {
      useBootStateStore.getState().reportFetch('worktrees', 'fail', {
        error: 'timeout',
        durationMs: 5000,
      });
      const wt = useBootStateStore
        .getState()
        .lines.find((l) => l.service === 'worktrees')!;
      expect(wt.status).toBe('fail');
      expect(wt.error).toBe('timeout');
      expect(wt.durationMs).toBe(5000);
    });

    it('ignores unknown service', () => {
      const linesBefore = [...useBootStateStore.getState().lines];
      useBootStateStore.getState().reportFetch('unknown-service', 'ok');
      expect(useBootStateStore.getState().lines).toEqual(linesBefore);
    });

    it('does not affect other lines', () => {
      useBootStateStore
        .getState()
        .reportFetch('auth', 'ok', { durationMs: 10 });
      const { lines } = useBootStateStore.getState();
      for (const line of lines) {
        if (line.service !== 'auth') {
          expect(line.status).toBe('pending');
        }
      }
    });

    it('transitions from greeting to booting on first non-auth loading', () => {
      expect(useBootStateStore.getState().phase).toBe('greeting');
      useBootStateStore.getState().reportFetch('workspaces', 'loading');
      expect(useBootStateStore.getState().phase).toBe('booting');
    });

    it('does not transition to booting on auth loading', () => {
      useBootStateStore.getState().reportFetch('auth', 'loading');
      expect(useBootStateStore.getState().phase).toBe('greeting');
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
      expect(useBootStateStore.getState().phase).toBe('ready');
      expect(useBootStateStore.getState().bootComplete).toBe(true);
    });

    it('returns degraded when one fetch fails', () => {
      const { reportFetch } = useBootStateStore.getState();
      reportFetch('auth', 'ok');
      reportFetch('workspaces', 'ok', { summary: '3 repos' });
      reportFetch('sessions', 'fail', { error: 'timeout' });
      reportFetch('worktrees', 'ok', { summary: '1 tree' });
      reportFetch('groups', 'ok', { summary: '0 groups' });
      useBootStateStore.getState().finishBoot();
      expect(useBootStateStore.getState().phase).toBe('degraded');
      expect(useBootStateStore.getState().bootComplete).toBe(true);
    });

    it('ignores auth status when deriving phase', () => {
      const { reportFetch } = useBootStateStore.getState();
      reportFetch('auth', 'fail');
      reportFetch('workspaces', 'ok', { summary: '3 repos' });
      reportFetch('sessions', 'ok', { summary: '0 active' });
      reportFetch('worktrees', 'ok', { summary: '0 trees' });
      reportFetch('groups', 'ok', { summary: '0 groups' });
      useBootStateStore.getState().finishBoot();
      expect(useBootStateStore.getState().phase).toBe('ready');
    });
  });

  describe('resetBoot', () => {
    it('resets to greeting phase with fresh lines', () => {
      useBootStateStore.getState().startBoot();
      useBootStateStore.getState().reportFetch('auth', 'ok');
      useBootStateStore.getState().finishBoot();
      expect(useBootStateStore.getState().phase).toBe('ready');

      useBootStateStore.getState().resetBoot();
      expect(useBootStateStore.getState().phase).toBe('greeting');
      expect(useBootStateStore.getState().bootComplete).toBe(false);
      expect(useBootStateStore.getState().lines.length).toBe(5);
      for (const line of useBootStateStore.getState().lines) {
        expect(line.status).toBe('pending');
      }
    });
  });
});
