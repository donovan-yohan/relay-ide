import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AgentPresenceStoreError,
  createAgentPresenceStore,
  type AgentPresenceStore,
} from '../server/agent-presence-store.js';

vi.mock('../server/logger.js', () => ({
  createLogger: () => ({
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

const tmpDirs: string[] = [];
const openStores: AgentPresenceStore[] = [];

/** Mutable clock so expiry/heartbeat are deterministic without fake timers. */
function makeClock(startIso: string): {
  now: () => Date;
  advanceMs: (ms: number) => void;
} {
  let current = new Date(startIso).getTime();
  return {
    now: () => new Date(current),
    advanceMs: (ms: number) => {
      current += ms;
    },
  };
}

function makeStore(now: () => Date): AgentPresenceStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-presence-test-'));
  tmpDirs.push(dir);
  const store = createAgentPresenceStore(path.join(dir, 'agent-presence.db'), {
    now,
  });
  openStores.push(store);
  return store;
}

afterEach(() => {
  while (openStores.length) {
    try {
      openStores.pop()!.close();
    } catch {
      /* already closed */
    }
  }
  while (tmpDirs.length) {
    fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

describe('AgentPresenceStore.register', () => {
  it('mints a record with a stable id and a heartbeat expiry', () => {
    const clock = makeClock('2026-06-15T12:00:00.000Z');
    const store = makeStore(clock.now);
    const presence = store.register({
      registeredBy: 'actor:claude-1',
      globalSessionId: 'node-a:sess-1',
      role: 'implementer',
      useCase: 'implementing #964',
      ttlSeconds: 120,
    });
    expect(presence.id).toMatch(/^pres:/);
    expect(presence.role).toBe('implementer');
    expect(presence.createdAt).toBe('2026-06-15T12:00:00.000Z');
    expect(presence.expiresAt).toBe('2026-06-15T12:02:00.000Z');
  });

  it('re-registers the same scope idempotently (preserves createdAt, refreshes expiry)', () => {
    const clock = makeClock('2026-06-15T12:00:00.000Z');
    const store = makeStore(clock.now);
    const first = store.register({
      registeredBy: 'actor:claude-1',
      globalSessionId: 'node-a:sess-1',
      role: 'implementer',
      displayName: 'Claude impl',
    });
    clock.advanceMs(30_000);
    const second = store.register({
      registeredBy: 'actor:claude-1',
      globalSessionId: 'node-a:sess-1',
      role: 'reviewer',
    });
    expect(second.id).toBe(first.id);
    expect(second.createdAt).toBe(first.createdAt);
    expect(second.updatedAt).toBe('2026-06-15T12:00:30.000Z');
    // register is create-or-REPLACE: the prior displayName is gone.
    expect(second.role).toBe('reviewer');
    expect(second.displayName).toBeUndefined();
    expect(store.list()).toHaveLength(1);
  });

  it('rejects unsafe fields and missing attribution as 400s', () => {
    const clock = makeClock('2026-06-15T12:00:00.000Z');
    const store = makeStore(clock.now);
    expect(() =>
      store.register({ registeredBy: 'actor:x', token: 'secret-value' })
    ).toThrowError(AgentPresenceStoreError);
    try {
      store.register({ registeredBy: 'actor:x', token: 'secret-value' });
    } catch (err) {
      expect((err as AgentPresenceStoreError).status).toBe(400);
      expect((err as AgentPresenceStoreError).code).toBe(
        'presence_unsafe_field'
      );
    }
    expect(() => store.register({ globalSessionId: 'x' })).toThrowError(
      /registered_by_required/
    );
  });
});

describe('AgentPresenceStore.updateSelf', () => {
  it('patches provided fields, keeps untouched ones, refreshes heartbeat', () => {
    const clock = makeClock('2026-06-15T12:00:00.000Z');
    const store = makeStore(clock.now);
    const registered = store.register({
      registeredBy: 'actor:claude-1',
      globalSessionId: 'node-a:sess-1',
      role: 'implementer',
      displayName: 'Claude impl',
      useCase: 'implementing #964',
      ttlSeconds: 120,
    });
    clock.advanceMs(60_000);
    const updated = store.updateSelf({
      registeredBy: 'actor:claude-1',
      id: registered.id,
      statusText: 'running tests',
    });
    expect(updated.statusText).toBe('running tests');
    // untouched fields survive the patch
    expect(updated.role).toBe('implementer');
    expect(updated.displayName).toBe('Claude impl');
    expect(updated.useCase).toBe('implementing #964');
    // heartbeat refreshed
    expect(updated.updatedAt).toBe('2026-06-15T12:01:00.000Z');
    expect(updated.expiresAt).toBe('2026-06-15T12:03:00.000Z');
    expect(updated.createdAt).toBe(registered.createdAt);
  });

  it('fails closed (404) when no live presence exists', () => {
    const clock = makeClock('2026-06-15T12:00:00.000Z');
    const store = makeStore(clock.now);
    expect(() =>
      store.updateSelf({
        registeredBy: 'actor:nobody',
        globalSessionId: 'node-a:ghost',
      })
    ).toThrowError(/not_found/);
  });

  it('refuses to update another agent’s presence (403)', () => {
    const clock = makeClock('2026-06-15T12:00:00.000Z');
    const store = makeStore(clock.now);
    const registered = store.register({
      registeredBy: 'actor:claude-1',
      globalSessionId: 'node-a:sess-1',
    });
    try {
      store.updateSelf({
        registeredBy: 'actor:evil',
        id: registered.id,
        statusText: 'pwned',
      });
      throw new Error('expected updateSelf to throw');
    } catch (err) {
      expect((err as AgentPresenceStoreError).status).toBe(403);
      expect((err as AgentPresenceStoreError).code).toBe(
        'agent_presence_not_owner'
      );
    }
  });

  it('404s a heartbeat once the record has expired (must re-register)', () => {
    const clock = makeClock('2026-06-15T12:00:00.000Z');
    const store = makeStore(clock.now);
    const registered = store.register({
      registeredBy: 'actor:claude-1',
      globalSessionId: 'node-a:sess-1',
      ttlSeconds: 10,
    });
    clock.advanceMs(11_000);
    expect(() =>
      store.updateSelf({ registeredBy: 'actor:claude-1', id: registered.id })
    ).toThrowError(/not_found/);
  });
});

describe('AgentPresenceStore.list + expiry', () => {
  it('filters expired records lazily at read time', () => {
    const clock = makeClock('2026-06-15T12:00:00.000Z');
    const store = makeStore(clock.now);
    store.register({
      registeredBy: 'actor:a',
      globalSessionId: 'node-a:s1',
      ttlSeconds: 30,
    });
    store.register({
      registeredBy: 'actor:b',
      globalSessionId: 'node-a:s2',
      ttlSeconds: 3600,
    });
    expect(store.list()).toHaveLength(2);
    clock.advanceMs(31_000);
    const live = store.list();
    expect(live).toHaveLength(1);
    expect(live[0].globalSessionId).toBe('node-a:s2');
  });

  it('filters by scope columns', () => {
    const clock = makeClock('2026-06-15T12:00:00.000Z');
    const store = makeStore(clock.now);
    store.register({
      registeredBy: 'actor:a',
      globalSessionId: 'node-a:s1',
      workContextId: 'wc:1',
      nodeId: 'node-a',
    });
    store.register({
      registeredBy: 'actor:b',
      globalSessionId: 'node-b:s2',
      workContextId: 'wc:2',
      nodeId: 'node-b',
    });
    expect(store.list({ workContextId: 'wc:1' })).toHaveLength(1);
    expect(store.list({ nodeId: 'node-b' })[0].globalSessionId).toBe(
      'node-b:s2'
    );
    expect(store.list({ workContextId: 'wc:none' })).toHaveLength(0);
  });

  it('sweepExpired physically removes stale rows', () => {
    const clock = makeClock('2026-06-15T12:00:00.000Z');
    const store = makeStore(clock.now);
    store.register({
      registeredBy: 'actor:a',
      globalSessionId: 'node-a:s1',
      ttlSeconds: 10,
    });
    clock.advanceMs(11_000);
    expect(store.list({ includeExpired: true })).toHaveLength(1);
    expect(store.sweepExpired()).toBe(1);
    expect(store.list({ includeExpired: true })).toHaveLength(0);
  });
});
