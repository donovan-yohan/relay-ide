// Operator-owned notification triggers (#1308 slice 5). Client-local and
// localStorage-backed, following the `advancedMode` pattern in `ui.ts`: a
// notification preference is a property of THIS device (its tab, its OS
// permission grant, its notification centre), not of the operator's account, so
// syncing it through the hub would be wrong as well as more expensive.
//
// This is deliberately NOT the legacy `defaultNotifications` config
// (`lib/notifications.ts` → `PUT /config`), which arms per-SESSION web-push for
// the PTY lane. That lane keeps its own server-side switch untouched.
import { create } from 'zustand';

/** localStorage slot for the persisted trigger set. */
export const NOTIFY_SETTINGS_KEY = 'relay-notify-settings';

/**
 * Which channel events are allowed to raise a notification.
 *
 * Defaults: mentions and DM replies ON (both are addressed AT the operator and
 * are rare enough that a missed one is the expensive outcome), turn-complete
 * OFF (an orchestrator fanning work out walks a dozen agents through
 * thinking→idle per minute; opting in is the only defensible default).
 */
export interface NotifySettings {
  /** An incoming message that mentions `@operator`. */
  mentions: boolean;
  /** An agent message arriving in a DM channel. */
  dmReplies: boolean;
  /** An agent turn settling back to idle. */
  turnComplete: boolean;
}

export type NotifySettingKey = keyof NotifySettings;

export const DEFAULT_NOTIFY_SETTINGS: NotifySettings = Object.freeze({
  mentions: true,
  dmReplies: true,
  turnComplete: false,
});

/**
 * Parse a persisted payload, per-key. Unknown keys are dropped and a key with a
 * non-boolean (or missing) value falls back to its default, so a partial write
 * from an older build — or a hand-edited slot — degrades one toggle at a time
 * instead of resetting the whole set.
 */
export function parseNotifySettings(raw: string | null): NotifySettings {
  if (!raw) return { ...DEFAULT_NOTIFY_SETTINGS };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...DEFAULT_NOTIFY_SETTINGS };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ...DEFAULT_NOTIFY_SETTINGS };
  }
  const record = parsed as Record<string, unknown>;
  const next = { ...DEFAULT_NOTIFY_SETTINGS };
  for (const key of Object.keys(DEFAULT_NOTIFY_SETTINGS) as NotifySettingKey[]) {
    const value = record[key];
    if (typeof value === 'boolean') next[key] = value;
  }
  return next;
}

export function serializeNotifySettings(settings: NotifySettings): string {
  return JSON.stringify({
    mentions: settings.mentions,
    dmReplies: settings.dmReplies,
    turnComplete: settings.turnComplete,
  });
}

function loadNotifySettings(): NotifySettings {
  try {
    return parseNotifySettings(localStorage.getItem(NOTIFY_SETTINGS_KEY));
  } catch {
    return { ...DEFAULT_NOTIFY_SETTINGS };
  }
}

function persistNotifySettings(settings: NotifySettings): void {
  try {
    localStorage.setItem(NOTIFY_SETTINGS_KEY, serializeNotifySettings(settings));
  } catch {
    /* localStorage unavailable */
  }
}

interface NotifySettingsState {
  settings: NotifySettings;
  setNotifySetting: (key: NotifySettingKey, enabled: boolean) => void;
  toggleNotifySetting: (key: NotifySettingKey) => void;
  /** Restore every trigger to its default. */
  resetNotifySettings: () => void;
}

export const useNotifySettingsStore = create<NotifySettingsState>((set, get) => ({
  settings: loadNotifySettings(),
  setNotifySetting: (key, enabled) => {
    const current = get().settings;
    if (current[key] === enabled) return;
    const next = { ...current, [key]: enabled };
    persistNotifySettings(next);
    set({ settings: next });
  },
  toggleNotifySetting: (key) => {
    get().setNotifySetting(key, !get().settings[key]);
  },
  resetNotifySettings: () => {
    const next = { ...DEFAULT_NOTIFY_SETTINGS };
    persistNotifySettings(next);
    set({ settings: next });
  },
}));

/** Non-reactive read for the socket handlers that evaluate signals. */
export function currentNotifySettings(): NotifySettings {
  return useNotifySettingsStore.getState().settings;
}
