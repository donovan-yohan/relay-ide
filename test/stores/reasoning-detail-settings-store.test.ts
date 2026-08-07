import { beforeEach, describe, expect, it } from 'vitest';

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
  DEFAULT_REASONING_DETAIL_SETTINGS,
  REASONING_DETAIL_SETTINGS_KEY,
  parseReasoningDetailSettings,
  useReasoningDetailSettingsStore,
} = await import('../../frontend/src/lib/stores/reasoning-detail-settings.js');

beforeEach(() => {
  for (const key of Object.keys(storage)) delete storage[key];
  useReasoningDetailSettingsStore.getState().reset();
});

describe('reasoning detail settings', () => {
  it('defaults new reasoning details to collapsed', () => {
    expect(DEFAULT_REASONING_DETAIL_SETTINGS).toEqual({
      defaultState: 'collapsed',
    });
  });

  it.each(['collapsed', 'expanded'] as const)(
    'persists the %s default',
    (defaultState) => {
      useReasoningDetailSettingsStore.getState().setDefaultState(defaultState);
      expect(
        parseReasoningDetailSettings(
          storage[REASONING_DETAIL_SETTINGS_KEY] ?? null
        )
      ).toEqual({ defaultState });
    }
  );

  it.each([null, '', 'nope', '[]', '{"defaultState":"open"}'])(
    'degrades %s to the collapsed default',
    (raw) => {
      expect(parseReasoningDetailSettings(raw)).toEqual({
        defaultState: 'collapsed',
      });
    }
  );
});
