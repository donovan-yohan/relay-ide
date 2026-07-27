import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FrameworkInfo } from '../frontend/src/lib/types.js';

const CLAUDE_FRAMEWORK: FrameworkInfo = {
  id: 'claude',
  displayName: 'Claude',
  command: 'claude',
  capabilities: {
    supportsContinue: true,
    supportsYolo: true,
    supportsHooks: true,
    supportsTelemetry: true,
  },
  eventSource: 'hooks',
};

describe('createFrameworkAction', () => {
  it('builds command palette metadata for a framework chat action', async () => {
    const { createFrameworkAction } =
      await import('../frontend/src/lib/actions/definitions/frameworks.js');

    const action = createFrameworkAction(CLAUDE_FRAMEWORK);

    expect(action.id).toBe('session.new-claude');
    expect(action.label).toBe('open claude chat');
    expect(action.category).toBe('session');
    expect(action.icon).toBe('+');
    expect(action.when?.({ view: 'workspace', workspacePath: '/repo' })).toBe(
      true
    );
    expect(action.when?.({ view: 'workspace' })).toBe(false);
  });
});

describe('useConfigStore framework loading', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock('../frontend/src/lib/api.js');
  });

  it('loadFrameworks() fetches and stores frameworks when called', async () => {
    const fetchFrameworks = vi.fn().mockResolvedValue([CLAUDE_FRAMEWORK]);

    vi.doMock('../frontend/src/lib/api.js', async () => {
      const actual = await vi.importActual('../frontend/src/lib/api.js');
      return { ...actual, fetchFrameworks };
    });

    const { useConfigStore } =
      await import('../frontend/src/lib/stores/config.js');

    expect(fetchFrameworks).not.toHaveBeenCalled();
    expect(useConfigStore.getState().frameworks).toEqual([]);

    await useConfigStore.getState().loadFrameworks();

    expect(fetchFrameworks).toHaveBeenCalledTimes(1);
    expect(useConfigStore.getState().frameworks).toEqual([CLAUDE_FRAMEWORK]);
  });

  it('falls back to an empty framework list when loading fails', async () => {
    vi.doMock('../frontend/src/lib/api.js', async () => {
      const actual = await vi.importActual('../frontend/src/lib/api.js');
      return {
        ...actual,
        fetchFrameworks: vi.fn().mockRejectedValue(new Error('boom')),
      };
    });

    const { useConfigStore } =
      await import('../frontend/src/lib/stores/config.js');

    await useConfigStore.getState().loadFrameworks();

    expect(useConfigStore.getState().frameworks).toEqual([]);
  });
});
