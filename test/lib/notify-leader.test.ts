// #1308 slice 5 item 2 — cross-tab election for the OS notification tier.
//
// Storage is injected, so "two tabs" is two leaders over one map and the lease
// clock is an argument rather than a timer. No DOM needed: the module's only
// ambient dependency is `localStorage`, and the null-storage path is asserted
// explicitly.
import { beforeEach, describe, expect, it } from 'vitest';
import {
  createNotifyLeader,
  NOTIFY_LEADER_LEASE_MS,
  NOTIFY_LEADER_STORAGE_KEY,
  type NotifyLeaderStorage,
} from '../../frontend/src/lib/notify/leader.js';

const NOW = 1_800_000_000_000;

function memoryStorage(): NotifyLeaderStorage & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
    removeItem: (key) => {
      map.delete(key);
    },
  };
}

let storage: ReturnType<typeof memoryStorage>;

beforeEach(() => {
  storage = memoryStorage();
});

describe('lease', () => {
  it('gives the tier to exactly one of two tabs', () => {
    const a = createNotifyLeader({ id: 'a', storage });
    const b = createNotifyLeader({ id: 'b', storage });
    expect(a.claim(NOW)).toBe(true);
    expect(b.claim(NOW + 1)).toBe(false);
    // And it stays put while the holder keeps delivering.
    expect(a.claim(NOW + 2)).toBe(true);
    expect(b.claim(NOW + 3)).toBe(false);
  });

  it('is renewed by the deliveries it guards, so no timer is needed', () => {
    const a = createNotifyLeader({ id: 'a', storage });
    const b = createNotifyLeader({ id: 'b', storage });
    a.claim(NOW);
    a.claim(NOW + NOTIFY_LEADER_LEASE_MS - 1);
    // `b` measures the lease from the RENEWAL, not the original claim.
    expect(b.claim(NOW + NOTIFY_LEADER_LEASE_MS + 1)).toBe(false);
  });

  it('expires so a killed tab cannot mute the survivors', () => {
    const a = createNotifyLeader({ id: 'a', storage });
    const b = createNotifyLeader({ id: 'b', storage });
    a.claim(NOW);
    expect(b.claim(NOW + NOTIFY_LEADER_LEASE_MS)).toBe(true);
    // Taking over means holding it: `a` is now the follower.
    expect(a.claim(NOW + NOTIFY_LEADER_LEASE_MS + 1)).toBe(false);
  });

  it('hands over on release rather than waiting out the lease', () => {
    const a = createNotifyLeader({ id: 'a', storage });
    const b = createNotifyLeader({ id: 'b', storage });
    a.claim(NOW);
    a.release();
    expect(storage.map.get(NOTIFY_LEADER_STORAGE_KEY)).toBeUndefined();
    expect(b.claim(NOW + 1)).toBe(true);
  });

  it('never releases a lease it does not hold', () => {
    const a = createNotifyLeader({ id: 'a', storage });
    const b = createNotifyLeader({ id: 'b', storage });
    a.claim(NOW);
    b.release();
    expect(a.claim(NOW + 1)).toBe(true);
    expect(b.claim(NOW + 2)).toBe(false);
  });
});

describe('degradation', () => {
  it('is always leader with no storage — single-tab behaviour, never silence', () => {
    const solo = createNotifyLeader({ id: 'a', storage: null });
    expect(solo.claim(NOW)).toBe(true);
    expect(solo.claim(NOW + 1)).toBe(true);
    expect(() => solo.release()).not.toThrow();
  });

  it('claims through a storage that refuses to write', () => {
    // Private mode, quota, a partition that went away: muting notifications
    // would be a worse answer than the duplicate this election exists to avoid.
    const readOnly: NotifyLeaderStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
      removeItem: () => {},
    };
    expect(createNotifyLeader({ id: 'a', storage: readOnly }).claim(NOW)).toBe(
      true
    );
  });

  it('ignores a corrupt or foreign record', () => {
    storage.setItem(NOTIFY_LEADER_STORAGE_KEY, 'not json');
    expect(createNotifyLeader({ id: 'a', storage }).claim(NOW)).toBe(true);
    storage.setItem(NOTIFY_LEADER_STORAGE_KEY, JSON.stringify({ id: 7 }));
    expect(createNotifyLeader({ id: 'b', storage }).claim(NOW)).toBe(true);
  });

  it('treats a wildly future stamp as a skewed clock, not a live holder', () => {
    // Otherwise one machine an hour ahead locks the tier out of this tab for
    // the rest of its life.
    storage.setItem(
      NOTIFY_LEADER_STORAGE_KEY,
      JSON.stringify({ id: 'other', at: NOW + 3_600_000 })
    );
    expect(createNotifyLeader({ id: 'a', storage }).claim(NOW)).toBe(true);
  });
});
