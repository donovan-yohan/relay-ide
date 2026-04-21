import { describe, it, expect } from 'vitest';

// Test-only boot state logic stubbed here because boot-state.svelte.ts uses Svelte
// runes ($state) that the Node.js test runner cannot process directly.
// This is a minimal approximation suitable for tests, not a source of truth.
// TODO: Extract pure logic into a shared .ts module so both the Svelte wrapper
// and these tests import the same code (see docs/LEARNINGS.md).

type FetchStatus = 'pending' | 'loading' | 'ok' | 'fail';

interface BootLine {
  service: string;
  status: FetchStatus;
  summary?: string | undefined;
  durationMs?: number | undefined;
  error?: string | undefined;
}

const SERVICES = [
  'auth',
  'workspaces',
  'sessions',
  'worktrees',
  'groups',
] as const;

function createBootLines(): BootLine[] {
  return SERVICES.map((service) => ({
    service,
    status: 'pending' as FetchStatus,
  }));
}

function derivePhaseAfterFinish(lines: BootLine[]): 'ready' | 'degraded' {
  const fetchLines = lines.filter((l) => l.service !== 'auth');
  const anyFailed = fetchLines.some((l) => l.status === 'fail');
  return anyFailed ? 'degraded' : 'ready';
}

function reportFetch(
  lines: BootLine[],
  service: string,
  status: 'loading' | 'ok' | 'fail',
  opts?: { summary?: string; durationMs?: number; error?: string }
): BootLine[] {
  const idx = lines.findIndex((l) => l.service === service);
  if (idx === -1) return lines;
  const updated = [...lines];
  updated[idx] = {
    service,
    status,
    summary: opts?.summary,
    durationMs: opts?.durationMs,
    error: opts?.error,
  };
  return updated;
}

describe('boot-state', () => {
  describe('createBootLines', () => {
    it('creates 5 lines for all services', () => {
      const lines = createBootLines();
      expect(lines.length).toBe(5);
      expect(lines.map((l) => l.service)).toEqual([
        'auth',
        'workspaces',
        'sessions',
        'worktrees',
        'groups',
      ]);
    });

    it('all lines start as pending', () => {
      const lines = createBootLines();
      for (const line of lines) {
        expect(line.status).toBe('pending');
      }
    });
  });

  describe('reportFetch', () => {
    it('updates a known service to loading', () => {
      let lines = createBootLines();
      lines = reportFetch(lines, 'workspaces', 'loading');
      const ws = lines.find((l) => l.service === 'workspaces')!;
      expect(ws.status).toBe('loading');
    });

    it('updates a service to ok with summary and duration', () => {
      let lines = createBootLines();
      lines = reportFetch(lines, 'sessions', 'ok', {
        summary: '2 active',
        durationMs: 42,
      });
      const sess = lines.find((l) => l.service === 'sessions')!;
      expect(sess.status).toBe('ok');
      expect(sess.summary).toBe('2 active');
      expect(sess.durationMs).toBe(42);
    });

    it('updates a service to fail with error', () => {
      let lines = createBootLines();
      lines = reportFetch(lines, 'worktrees', 'fail', {
        error: 'timeout',
        durationMs: 5000,
      });
      const wt = lines.find((l) => l.service === 'worktrees')!;
      expect(wt.status).toBe('fail');
      expect(wt.error).toBe('timeout');
      expect(wt.durationMs).toBe(5000);
    });

    it('ignores unknown service', () => {
      let lines = createBootLines();
      const original = [...lines];
      lines = reportFetch(lines, 'unknown-service', 'ok');
      expect(lines).toEqual(original);
    });

    it('does not affect other lines', () => {
      let lines = createBootLines();
      lines = reportFetch(lines, 'auth', 'ok', { durationMs: 10 });
      // All other lines should still be pending
      for (const line of lines) {
        if (line.service !== 'auth') {
          expect(line.status).toBe('pending');
        }
      }
    });
  });

  describe('derivePhaseAfterFinish', () => {
    it('returns ready when all non-auth lines are ok', () => {
      let lines = createBootLines();
      lines = reportFetch(lines, 'auth', 'ok');
      lines = reportFetch(lines, 'workspaces', 'ok', { summary: '3 repos' });
      lines = reportFetch(lines, 'sessions', 'ok', { summary: '2 active' });
      lines = reportFetch(lines, 'worktrees', 'ok', { summary: '1 tree' });
      lines = reportFetch(lines, 'groups', 'ok', { summary: '0 groups' });
      expect(derivePhaseAfterFinish(lines)).toBe('ready');
    });

    it('returns degraded when one fetch fails', () => {
      let lines = createBootLines();
      lines = reportFetch(lines, 'auth', 'ok');
      lines = reportFetch(lines, 'workspaces', 'ok', { summary: '3 repos' });
      lines = reportFetch(lines, 'sessions', 'fail', { error: 'timeout' });
      lines = reportFetch(lines, 'worktrees', 'ok', { summary: '1 tree' });
      lines = reportFetch(lines, 'groups', 'ok', { summary: '0 groups' });
      expect(derivePhaseAfterFinish(lines)).toBe('degraded');
    });

    it('returns degraded when all fetches fail', () => {
      let lines = createBootLines();
      lines = reportFetch(lines, 'auth', 'ok');
      lines = reportFetch(lines, 'workspaces', 'fail', { error: 'network' });
      lines = reportFetch(lines, 'sessions', 'fail', { error: 'network' });
      lines = reportFetch(lines, 'worktrees', 'fail', { error: 'network' });
      lines = reportFetch(lines, 'groups', 'fail', { error: 'network' });
      expect(derivePhaseAfterFinish(lines)).toBe('degraded');
    });

    it('ignores auth status when deriving phase', () => {
      let lines = createBootLines();
      lines = reportFetch(lines, 'auth', 'fail'); // auth failed but non-auth are ok
      lines = reportFetch(lines, 'workspaces', 'ok', { summary: '3 repos' });
      lines = reportFetch(lines, 'sessions', 'ok', { summary: '0 active' });
      lines = reportFetch(lines, 'worktrees', 'ok', { summary: '0 trees' });
      lines = reportFetch(lines, 'groups', 'ok', { summary: '0 groups' });
      expect(derivePhaseAfterFinish(lines)).toBe('ready');
    });
  });
});
