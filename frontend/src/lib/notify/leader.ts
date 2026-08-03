// Cross-tab election for the OS notification tier (#1308 slice 5 item 2).
//
// The gate, the coalesce ledger and the badge store are per-PAGE singletons, so
// two Relay tabs evaluate the same `/channels` payload independently and each
// one calls `notifier.deliver`. The per-channel `tag` usually collapses the
// result to a single notification-centre entry, but tag replacement is scoped
// per page on several engines and a replace can re-alert — so the operator
// hears the same agent reply twice, and a burst raises the permission prompt
// once per tab.
//
// ONLY the OS tier is elected. The favicon dot and the title count are
// legitimately per-tab (each tab draws its own chrome), so every tab keeps
// running its own gate and its own badge store; this decides which one is
// allowed to reach the operator's desktop.
//
// A TIMESTAMPED LEASE in `localStorage`, not a `BroadcastChannel` heartbeat:
// the lease is renewed by the very deliveries it guards, so it needs no timer
// and no background chatter, it expires on its own if the holder is frozen or
// killed rather than closed cleanly, and `localStorage` is the cross-tab
// channel this lane already depends on (`notify-settings` persists there).
// Where storage is unavailable — a private-mode webview, a non-DOM test
// environment — the lane degrades to "always leader", which is single-tab
// behaviour and never silences a notification.

/** Storage key holding `{ id, at }` for the current lease. */
export const NOTIFY_LEADER_STORAGE_KEY = 'relay-notify-leader';

/**
 * Lease length.
 *
 * Comfortably shorter than the 60s per-channel OS window, so a tab that closes
 * mid-burst does not mute the survivors for a whole minute; comfortably longer
 * than the 10s burst window, so an active leader cannot lose the lease between
 * two notifications of the same burst.
 */
export const NOTIFY_LEADER_LEASE_MS = 15_000;

/** The `localStorage` subset this lane uses. Injectable for tests. */
export interface NotifyLeaderStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
}

export interface NotifyLeader {
  /**
   * True when THIS tab owns the OS tier right now. Renews the lease as a side
   * effect, so a tab that keeps delivering keeps the lease.
   */
  claim: (now?: number) => boolean;
  /** Give the lease up if we hold it (sign-out, tests). */
  release: () => void;
}

export interface NotifyLeaderOptions {
  /** Defaults to a fresh random id — one per page, per notifier lifetime. */
  id?: string;
  /** Defaults to ambient `localStorage`; null disables election entirely. */
  storage?: NotifyLeaderStorage | null;
  key?: string;
  leaseMs?: number;
}

function ambientStorage(): NotifyLeaderStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    // Reading `localStorage` THROWS on a cookie-blocked origin in Chrome.
    return null;
  }
}

function randomLeaderId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

interface LeaseRecord {
  id: string;
  at: number;
}

function parseLease(raw: string | null): LeaseRecord | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const { id, at } = parsed as { id?: unknown; at?: unknown };
    if (typeof id !== 'string' || typeof at !== 'number') return null;
    return { id, at };
  } catch {
    return null;
  }
}

export function createNotifyLeader(
  options: NotifyLeaderOptions = {}
): NotifyLeader {
  const storage =
    options.storage === undefined ? ambientStorage() : options.storage;
  const key = options.key ?? NOTIFY_LEADER_STORAGE_KEY;
  const leaseMs = options.leaseMs ?? NOTIFY_LEADER_LEASE_MS;
  const id = options.id ?? randomLeaderId();

  if (!storage) return { claim: () => true, release: () => {} };

  function read(): LeaseRecord | null {
    try {
      return parseLease(storage?.getItem(key) ?? null);
    } catch {
      return null;
    }
  }

  return {
    claim: (nowInput) => {
      const now = nowInput ?? Date.now();
      const held = read();
      if (held !== null && held.id !== id) {
        const age = now - held.at;
        // A stamp from the FUTURE beyond one lease is a skewed or corrupted
        // clock, not a live holder — treating it as live would mute this tab
        // forever. `age` inside ±lease is the only "someone else has it" case.
        if (age < leaseMs && age > -leaseMs) return false;
      }
      try {
        storage?.setItem(key, JSON.stringify({ id, at: now }));
      } catch {
        // Quota, private mode, a storage partition that went away: fall back to
        // single-tab behaviour rather than silencing this tab's notifications.
        return true;
      }
      return true;
    },
    release: () => {
      const held = read();
      if (held !== null && held.id !== id) return;
      try {
        storage?.removeItem(key);
      } catch {
        // Best effort; the lease expires on its own.
      }
    },
  };
}
