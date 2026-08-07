import { beforeEach, describe, expect, it, vi } from 'vitest';

const effectState = vi.hoisted(() => ({
  cleanup: undefined as void | (() => void),
}));

const storeMock = vi.hoisted(() => ({
  ensureFreshAll: vi.fn(),
}));

vi.mock('react', () => ({
  useEffect: (effect: () => void | (() => void)) => {
    effectState.cleanup = effect();
  },
}));

vi.mock('../../frontend/src/lib/stores/sessions.js', () => ({
  DEFAULT_ENRICHMENT_TTL_MS: 600_000,
  useSessionsStore: {
    getState: () => storeMock,
  },
}));

import { useVisibilityRefresh } from '../../frontend/src/hooks/useVisibilityRefresh.js';

describe('useVisibilityRefresh', () => {
  let listeners: Record<string, () => void>;
  let visibilityState = 'visible';

  beforeEach(() => {
    vi.clearAllMocks();
    effectState.cleanup = undefined;
    listeners = {};
    visibilityState = 'visible';
    vi.stubGlobal('document', {
      addEventListener: vi.fn((event: string, handler: () => void) => {
        listeners[event] = handler;
      }),
      removeEventListener: vi.fn((event: string) => {
        delete listeners[event];
      }),
      get visibilityState() {
        return visibilityState;
      },
    });
  });

  it('refreshes stale repos when the tab becomes visible', () => {
    useVisibilityRefresh(true);

    visibilityState = 'visible';
    listeners.visibilitychange?.();

    expect(storeMock.ensureFreshAll).toHaveBeenCalledWith(600_000);
  });

  it('does not refresh while the tab is inactive and removes the listener on cleanup', () => {
    useVisibilityRefresh(true);

    visibilityState = 'hidden';
    listeners.visibilitychange?.();

    expect(storeMock.ensureFreshAll).not.toHaveBeenCalled();
    if (effectState.cleanup) effectState.cleanup();
    expect(listeners.visibilitychange).toBeUndefined();
  });
});
