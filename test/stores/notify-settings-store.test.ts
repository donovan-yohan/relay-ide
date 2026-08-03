// #1308 slice 5 item 1 — the operator's notification trigger set.
import { describe, it, beforeEach, expect } from 'vitest';

// Mock localStorage before importing the store (it loads at module init).
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
    writable: true,
  });
}

const {
  DEFAULT_NOTIFY_SETTINGS,
  NOTIFY_SETTINGS_KEY,
  parseNotifySettings,
  serializeNotifySettings,
  useNotifySettingsStore,
  currentNotifySettings,
} = await import('../../frontend/src/lib/stores/notify-settings.js');

beforeEach(() => {
  for (const key of Object.keys(storage)) delete storage[key];
  useNotifySettingsStore.getState().resetNotifySettings();
});

describe('notify settings defaults', () => {
  it('ships mentions + dm replies on and turn-complete off', () => {
    expect(DEFAULT_NOTIFY_SETTINGS).toEqual({
      mentions: true,
      dmReplies: true,
      turnComplete: false,
    });
  });

  it('starts from the defaults with an empty slot', () => {
    expect(currentNotifySettings()).toEqual(DEFAULT_NOTIFY_SETTINGS);
  });
});

describe('parseNotifySettings', () => {
  it('round-trips a serialized set', () => {
    const settings = { mentions: false, dmReplies: true, turnComplete: true };
    expect(parseNotifySettings(serializeNotifySettings(settings))).toEqual(
      settings
    );
  });

  it.each([null, '', 'not json', '[]', '"nope"', '42'])(
    'degrades %s to the defaults',
    (raw) => {
      expect(parseNotifySettings(raw)).toEqual(DEFAULT_NOTIFY_SETTINGS);
    }
  );

  it('fills only the keys a partial payload is missing', () => {
    expect(parseNotifySettings('{"turnComplete":true}')).toEqual({
      mentions: true,
      dmReplies: true,
      turnComplete: true,
    });
  });

  it('refuses non-boolean values per key instead of resetting the set', () => {
    expect(
      parseNotifySettings('{"mentions":"yes","turnComplete":true,"junk":1}')
    ).toEqual({ mentions: true, dmReplies: true, turnComplete: true });
  });
});

describe('notify settings store', () => {
  it('persists a toggle to localStorage', () => {
    useNotifySettingsStore.getState().setNotifySetting('turnComplete', true);
    expect(currentNotifySettings().turnComplete).toBe(true);
    expect(parseNotifySettings(storage[NOTIFY_SETTINGS_KEY] ?? null)).toEqual({
      mentions: true,
      dmReplies: true,
      turnComplete: true,
    });
  });

  it('does not churn state for a no-op write', () => {
    const before = currentNotifySettings();
    useNotifySettingsStore.getState().setNotifySetting('mentions', true);
    expect(currentNotifySettings()).toBe(before);
  });

  it('toggles each trigger independently', () => {
    const { toggleNotifySetting } = useNotifySettingsStore.getState();
    toggleNotifySetting('mentions');
    toggleNotifySetting('turnComplete');
    expect(currentNotifySettings()).toEqual({
      mentions: false,
      dmReplies: true,
      turnComplete: true,
    });
  });

  it('restores the defaults on reset', () => {
    useNotifySettingsStore.getState().setNotifySetting('dmReplies', false);
    useNotifySettingsStore.getState().resetNotifySettings();
    expect(currentNotifySettings()).toEqual(DEFAULT_NOTIFY_SETTINGS);
  });
});
