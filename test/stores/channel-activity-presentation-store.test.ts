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
    },
    writable: true,
  });
}

const {
  CHANNEL_ACTIVITY_PRESENTATION_KEY,
  useChannelActivityPresentationStore,
} = await import(
  '../../frontend/src/lib/stores/channel-activity-presentation.js'
);

beforeEach(() => {
  for (const key of Object.keys(storage)) delete storage[key];
  useChannelActivityPresentationStore.setState({ presentation: 'shown' });
});

describe('channel activity presentation preference', () => {
  it('defaults to shown and persists a responses-first toggle', () => {
    expect(useChannelActivityPresentationStore.getState().presentation).toBe(
      'shown'
    );
    useChannelActivityPresentationStore.getState().togglePresentation();
    expect(useChannelActivityPresentationStore.getState().presentation).toBe(
      'collapsed'
    );
    expect(storage[CHANNEL_ACTIVITY_PRESENTATION_KEY]).toBe('collapsed');
  });
});
