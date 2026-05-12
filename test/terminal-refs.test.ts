import { beforeEach, describe, expect, it, vi } from 'vitest';

const sessionsStore = {
  sessions: [] as Array<{
    id: string;
    nodeId?: string;
    globalSessionId?: string;
  }>,
  activeSessionId: null as string | null,
};
const uiStore = {
  sendToTargetSessionId: null as string | null,
};

vi.mock('../frontend/src/lib/stores/sessions.js', () => ({
  useSessionsStore: {
    getState: () => sessionsStore,
  },
}));
vi.mock('../frontend/src/lib/stores/ui.js', () => ({
  useUiStore: {
    getState: () => uiStore,
  },
}));

import {
  _clearTerminalHandlesForTesting,
  getActiveTerminalHandle,
  getTerminalHandle,
  setTerminalHandle,
} from '../frontend/src/lib/terminal-refs.js';

type TestTerminalHandle = NonNullable<Parameters<typeof setTerminalHandle>[1]>;

const handle = (name: string): TestTerminalHandle =>
  ({
    getTerm: vi.fn(() => null),
    focusTerm: vi.fn(),
    fitTerm: vi.fn(),
    exitCopyMode: vi.fn(),
    handleImageUpload: vi.fn(async () => undefined),
    name,
  }) as unknown as TestTerminalHandle;

describe('terminal refs scoped identity', () => {
  beforeEach(() => {
    _clearTerminalHandlesForTesting();
    sessionsStore.sessions = [];
    sessionsStore.activeSessionId = null;
    uiStore.sendToTargetSessionId = null;
  });

  it('preserves legacy local-id handle lookup', () => {
    const localHandle = handle('local');
    setTerminalHandle('local-session', localHandle);

    sessionsStore.activeSessionId = 'local-session';

    expect(getTerminalHandle('local-session')).toBe(localHandle);
    expect(getActiveTerminalHandle()).toBe(localHandle);
  });

  it('routes scoped active ids to scoped handles without collapsing duplicate local ids', () => {
    const nodeAHandle = handle('node-a');
    const nodeBHandle = handle('node-b');
    sessionsStore.sessions = [
      {
        id: 'same-local-id',
        nodeId: 'node-a',
        globalSessionId: 'node-a:same-local-id',
      },
      {
        id: 'same-local-id',
        nodeId: 'node-b',
        globalSessionId: 'node-b:same-local-id',
      },
    ];
    setTerminalHandle('node-a:same-local-id', nodeAHandle);
    setTerminalHandle('node-b:same-local-id', nodeBHandle);

    sessionsStore.activeSessionId = 'node-b:same-local-id';
    expect(getActiveTerminalHandle()).toBe(nodeBHandle);

    uiStore.sendToTargetSessionId = 'node-a:same-local-id';
    expect(getActiveTerminalHandle()).toBe(nodeAHandle);
  });

  it('does not guess a handle for ambiguous bare local ids across nodes', () => {
    const nodeAHandle = handle('node-a');
    const nodeBHandle = handle('node-b');
    sessionsStore.sessions = [
      {
        id: 'same-local-id',
        nodeId: 'node-a',
        globalSessionId: 'node-a:same-local-id',
      },
      {
        id: 'same-local-id',
        nodeId: 'node-b',
        globalSessionId: 'node-b:same-local-id',
      },
    ];
    setTerminalHandle('node-a:same-local-id', nodeAHandle);
    setTerminalHandle('node-b:same-local-id', nodeBHandle);

    sessionsStore.activeSessionId = 'same-local-id';

    expect(getActiveTerminalHandle()).toBe(null);
  });
});
