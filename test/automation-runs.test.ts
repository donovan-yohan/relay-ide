import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createAutomationRunStore,
  AutomationRunStoreError,
  type AutomationRunStore,
} from '../server/automation-runs.js';
import {
  resolveAutomationRunTargetLiveness,
  type AutomationRunLivenessResolver,
} from '../shared/automation-run.js';

const tempRoots: string[] = [];

/** Mutable clock so heartbeat/expiry transitions are deterministic. */
function makeClock(startMs: number): { now: () => string; advance: (ms: number) => void } {
  let current = startMs;
  return {
    now: () => new Date(current).toISOString(),
    advance: (ms: number) => {
      current += ms;
    },
  };
}

function makeStore(now: () => string): AutomationRunStore {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-automation-runs-'));
  tempRoots.push(root);
  return createAutomationRunStore({ dbPath: path.join(root, 'automation-runs.db'), now });
}

/** Liveness resolver backed by a mutable Set of alive session keys. */
function resolverFor(alive: Set<string>): AutomationRunLivenessResolver {
  return (target) => {
    if (target.sessionId && alive.has(target.sessionId)) return 'alive';
    if (target.globalSessionId && alive.has(target.globalSessionId)) return 'alive';
    return 'gone';
  };
}

const baseRegister = {
  id: 'automation-run:test-1',
  name: 'pr-959-watchdog',
  kind: 'watchdog' as const,
  runId: 'e059bf471bd0',
  owner: { orchestrator: 'hermes', actorId: 'cron:e059bf471bd0' },
  repoPath: '/repo/relay-ide',
  workContextId: 'wc:959',
  targets: [{ sessionId: 'sess-a' }],
  links: { taskRefs: [{ kind: 'github-issue', id: '959' }] },
  ttlSeconds: 300,
};

afterEach(() => {
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('automation run store', () => {
  it('registers a live run with alive targets and active status', () => {
    const clock = makeClock(Date.parse('2026-06-15T00:00:00.000Z'));
    const store = makeStore(clock.now);
    const alive = new Set(['sess-a']);

    const run = store.register(baseRegister, resolverFor(alive));
    expect(run).toMatchObject({
      id: 'automation-run:test-1',
      name: 'pr-959-watchdog',
      kind: 'watchdog',
      status: 'active',
      version: 1,
      owner: { orchestrator: 'hermes' },
      cleanup: { state: 'none' },
      redaction: { rawPayloadStored: false, rawTranscriptStored: false },
    });
    expect(run.targets[0]).toMatchObject({ sessionId: 'sess-a', lastKnownState: 'alive' });
    expect(run.staleReasons).toEqual([]);
    store.close();
  });

  it('detects a stale target session (gone) on read and flags cleanup-needed', () => {
    const clock = makeClock(Date.parse('2026-06-15T00:00:00.000Z'));
    const store = makeStore(clock.now);
    const alive = new Set(['sess-a']);
    store.register(baseRegister, resolverFor(alive));

    // The target session is killed / no longer exists.
    alive.delete('sess-a');
    const got = store.get('automation-run:test-1', resolverFor(alive));
    expect(got).not.toBeNull();
    expect(got?.status).toBe('cleanup-needed');
    expect(got?.staleReasons).toContain('target-session-gone');
    expect(got?.targets[0]?.lastKnownState).toBe('gone');
    expect(got?.cleanup.state).toBe('needed');
    // Reads are side-effect free: the persisted version did not move.
    expect(got?.version).toBe(1);
    store.close();
  });

  it('marks a run stale when its heartbeat lapses (no silent infinite watchdog)', () => {
    const clock = makeClock(Date.parse('2026-06-15T00:00:00.000Z'));
    const store = makeStore(clock.now);
    const alive = new Set(['sess-a']);
    store.register({ ...baseRegister, ttlSeconds: 30 }, resolverFor(alive));

    // Targets are still alive, but the watcher stopped checking in.
    clock.advance(31_000);
    const got = store.get('automation-run:test-1', resolverFor(alive));
    expect(got?.status).toBe('stale');
    expect(got?.staleReasons).toEqual(['heartbeat-expired']);
    expect(got?.cleanup.state).toBe('needed');

    // A fresh observation refreshes the heartbeat and clears staleness.
    const observed = store.observe('automation-run:test-1', { summary: 'still watching' }, resolverFor(alive));
    expect(observed.status).toBe('active');
    expect(observed.lastObservation?.summary).toBe('still watching');
    expect(observed.version).toBe(2);
    store.close();
  });

  it('treats a past hard expiry as cleanup-needed regardless of heartbeat', () => {
    const clock = makeClock(Date.parse('2026-06-15T00:00:00.000Z'));
    const store = makeStore(clock.now);
    const alive = new Set(['sess-a']);
    store.register(
      { ...baseRegister, expiresAt: '2026-06-14T00:00:00.000Z' },
      resolverFor(alive)
    );
    const got = store.get('automation-run:test-1', resolverFor(alive));
    expect(got?.status).toBe('cleanup-needed');
    expect(got?.staleReasons).toContain('hard-expiry');
    store.close();
  });

  it('retires idempotently: retire is terminal and a second retire is a no-op', () => {
    const clock = makeClock(Date.parse('2026-06-15T00:00:00.000Z'));
    const store = makeStore(clock.now);
    store.register(baseRegister, resolverFor(new Set(['sess-a'])));

    const retired = store.retire('automation-run:test-1', { reason: 'pr merged', retiredBy: 'ebi' });
    expect(retired.status).toBe('retired');
    expect(retired.cleanup).toMatchObject({ state: 'retired', reason: 'pr merged', retiredBy: 'ebi' });
    expect(retired.cleanup.retiredAt).toBeDefined();
    expect(retired.version).toBe(2);

    clock.advance(60_000);
    const again = store.retire('automation-run:test-1', { reason: 'second attempt', retiredBy: 'someone-else' });
    // Idempotent: unchanged record, no version bump, original retire metadata preserved.
    expect(again.status).toBe('retired');
    expect(again.version).toBe(2);
    expect(again.cleanup).toMatchObject({ reason: 'pr merged', retiredBy: 'ebi' });
    expect(again.updatedAt).toBe(retired.updatedAt);
    store.close();
  });

  it('rejects observing a retired run until it is re-registered', () => {
    const clock = makeClock(Date.parse('2026-06-15T00:00:00.000Z'));
    const store = makeStore(clock.now);
    store.register(baseRegister, resolverFor(new Set(['sess-a'])));
    store.retire('automation-run:test-1', {});

    expect(() => store.observe('automation-run:test-1', {}, resolverFor(new Set(['sess-a'])))).toThrow(
      AutomationRunStoreError
    );

    // Re-register revives the run as active.
    const revived = store.register(baseRegister, resolverFor(new Set(['sess-a'])));
    expect(revived.status).toBe('active');
    expect(revived.cleanup.state).toBe('none');
    store.close();
  });

  it('upserts on re-register by id, preserving createdAt and bumping version', () => {
    const clock = makeClock(Date.parse('2026-06-15T00:00:00.000Z'));
    const store = makeStore(clock.now);
    const first = store.register(baseRegister, resolverFor(new Set(['sess-a'])));
    clock.advance(5_000);
    const second = store.register(
      { ...baseRegister, name: 'pr-959-watchdog-renamed' },
      resolverFor(new Set(['sess-a']))
    );
    expect(second.id).toBe(first.id);
    expect(second.name).toBe('pr-959-watchdog-renamed');
    expect(second.createdAt).toBe(first.createdAt);
    expect(second.version).toBe(2);
    expect(store.list({ workContextId: 'wc:959' }, resolverFor(new Set(['sess-a'])))).toHaveLength(1);
    store.close();
  });

  it('lists with status/work-context filters and excludes retired by default', () => {
    const clock = makeClock(Date.parse('2026-06-15T00:00:00.000Z'));
    const store = makeStore(clock.now);
    store.register({ ...baseRegister, id: 'automation-run:alive', targets: [{ sessionId: 'live' }] }, resolverFor(new Set(['live'])));
    store.register({ ...baseRegister, id: 'automation-run:dead', targets: [{ sessionId: 'dead' }] }, resolverFor(new Set(['live'])));
    store.retire('automation-run:dead', {});

    const aliveResolver = resolverFor(new Set(['live']));
    const active = store.list({ workContextId: 'wc:959' }, aliveResolver);
    expect(active.map((r) => r.id)).toEqual(['automation-run:alive']);

    const withRetired = store.list({ workContextId: 'wc:959', includeRetired: true }, aliveResolver);
    expect(withRetired.map((r) => r.id).sort()).toEqual(['automation-run:alive', 'automation-run:dead']);

    const retiredOnly = store.list({ workContextId: 'wc:959', status: 'retired' }, aliveResolver);
    expect(retiredOnly.map((r) => r.id)).toEqual(['automation-run:dead']);
    store.close();
  });

  it('rejects secret-shaped fields in the register payload', () => {
    const clock = makeClock(Date.parse('2026-06-15T00:00:00.000Z'));
    const store = makeStore(clock.now);
    expect(() =>
      store.register({ ...baseRegister, token: 'relay-sac-v1.secret' }, resolverFor(new Set()))
    ).toThrow(/forbidden raw\/private fields/);
    store.close();
  });

  it('flags a finished (ended) target session as cleanup-needed', () => {
    const clock = makeClock(Date.parse('2026-06-15T00:00:00.000Z'));
    const store = makeStore(clock.now);
    store.register(baseRegister, resolverFor(new Set(['sess-a'])));
    // A resolver that reports the target session as finished/done.
    const endedResolver: AutomationRunLivenessResolver = () => 'ended';
    const got = store.get('automation-run:test-1', endedResolver);
    expect(got?.status).toBe('cleanup-needed');
    expect(got?.staleReasons).toContain('target-session-ended');
    store.close();
  });

  it('keeps a run active when its remote target resolves unknown', () => {
    const clock = makeClock(Date.parse('2026-06-15T00:00:00.000Z'));
    const store = makeStore(clock.now);
    store.register(baseRegister, resolverFor(new Set(['sess-a'])));
    // Cross-node targets resolve unknown, which must NOT trip cleanup-needed.
    const unknownResolver: AutomationRunLivenessResolver = () => 'unknown';
    const got = store.get('automation-run:test-1', unknownResolver);
    expect(got?.status).toBe('active');
    expect(got?.staleReasons).toEqual([]);
    store.close();
  });

  it('rejects re-registration that changes a run workContextId (tenant immutability)', () => {
    const clock = makeClock(Date.parse('2026-06-15T00:00:00.000Z'));
    const store = makeStore(clock.now);
    store.register(baseRegister, resolverFor(new Set(['sess-a'])));
    expect(() =>
      store.register(
        { ...baseRegister, workContextId: 'wc:other' },
        resolverFor(new Set(['sess-a']))
      )
    ).toThrow(AutomationRunStoreError);
    store.close();
  });

  it('preserves the prior observation summary on a bare heartbeat observe', () => {
    const clock = makeClock(Date.parse('2026-06-15T00:00:00.000Z'));
    const store = makeStore(clock.now);
    store.register(baseRegister, resolverFor(new Set(['sess-a'])));
    store.observe('automation-run:test-1', { summary: 'watching pr #959' }, resolverFor(new Set(['sess-a'])));
    clock.advance(1_000);
    const beat = store.observe('automation-run:test-1', {}, resolverFor(new Set(['sess-a'])));
    expect(beat.lastObservation?.summary).toBe('watching pr #959');
    expect(beat.lastObservation?.observedAt).not.toBe(undefined);
    store.close();
  });

  it('surfaces stale runs in a status listing even when many newer runs exist', () => {
    const clock = makeClock(Date.parse('2026-06-15T00:00:00.000Z'));
    const store = makeStore(clock.now);
    // One run pointed at a now-dead session, registered first (oldest updatedAt).
    store.register(
      { ...baseRegister, id: 'automation-run:stale', targets: [{ sessionId: 'dead' }] },
      resolverFor(new Set(['dead']))
    );
    // Many newer, healthy runs registered afterwards.
    for (let i = 0; i < 20; i += 1) {
      clock.advance(1_000);
      store.register(
        { ...baseRegister, id: `automation-run:live-${i}`, targets: [{ sessionId: `live-${i}` }] },
        resolverFor(new Set([`live-${i}`]))
      );
    }
    const aliveOnly = new Set(Array.from({ length: 20 }, (_v, i) => `live-${i}`));
    const cleanup = store.list({ workContextId: 'wc:959', status: 'cleanup-needed' }, resolverFor(aliveOnly));
    expect(cleanup.map((r) => r.id)).toEqual(['automation-run:stale']);
    store.close();
  });

  it('returns 404-class error when observing or retiring an unknown run', () => {
    const clock = makeClock(Date.parse('2026-06-15T00:00:00.000Z'));
    const store = makeStore(clock.now);
    expect(() => store.observe('automation-run:missing', {}, resolverFor(new Set()))).toThrow(
      AutomationRunStoreError
    );
    expect(() => store.retire('automation-run:missing', {})).toThrow(AutomationRunStoreError);
    expect(store.get('automation-run:missing')).toBeNull();
    store.close();
  });
});

describe('resolveAutomationRunTargetLiveness (production probe)', () => {
  const sessions = [
    { id: 'sess-live', globalSessionId: 'local:sess-live', durability: 'running-attached' },
    { id: 'sess-done', globalSessionId: 'local:sess-done', durability: 'ended' },
  ];

  it('resolves a present, running local session as alive', () => {
    expect(resolveAutomationRunTargetLiveness({ sessionId: 'sess-live' }, sessions, 'local')).toBe(
      'alive'
    );
    expect(
      resolveAutomationRunTargetLiveness({ globalSessionId: 'local:sess-live' }, sessions, 'local')
    ).toBe('alive');
  });

  it('resolves a present-but-finished local session as ended (the "done" case)', () => {
    expect(resolveAutomationRunTargetLiveness({ sessionId: 'sess-done' }, sessions, 'local')).toBe(
      'ended'
    );
  });

  it('resolves an absent local target as gone (404 / killed)', () => {
    expect(resolveAutomationRunTargetLiveness({ sessionId: 'sess-missing' }, sessions, 'local')).toBe(
      'gone'
    );
  });

  it('resolves a remote-node-scoped target as unknown, never gone', () => {
    expect(
      resolveAutomationRunTargetLiveness(
        { globalSessionId: 'node-b:sess-remote' },
        sessions,
        'local'
      )
    ).toBe('unknown');
  });
});
