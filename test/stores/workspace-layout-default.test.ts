import { beforeEach, describe, expect, it, vi } from 'vitest';

const storage: Record<string, string> = {};

function installLocalStorage() {
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
    configurable: true,
  });
}

describe('workspace layout defaults', () => {
  beforeEach(() => {
    vi.resetModules();
    for (const key of Object.keys(storage)) delete storage[key];
    installLocalStorage();
  });

  it('does not expose the legacy workspace layout feature flag or toggle', async () => {
    const { useUiStore } = await import(
      '../../frontend/src/lib/stores/ui.js'
    );

    const state = useUiStore.getState();
    expect('workspaceLayoutEnabled' in state).toBe(false);
    expect('setWorkspaceLayoutEnabled' in state).toBe(false);
  });
});
