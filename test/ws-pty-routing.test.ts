import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Terminal } from '@xterm/xterm';

// We need to mock store imports BEFORE importing ws.ts
const sessionsStore = {
  activeSessionId: null as string | null,
  beginPtyReconnect: vi.fn(),
  clearPtyReconnect: vi.fn(),
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

interface MockSocket {
  url: string;
  readyState: number;
  onopen: ((ev: Event) => void) | null;
  onmessage: ((ev: MessageEvent) => void) | null;
  onclose: ((ev: CloseEvent) => void) | null;
  onerror: ((ev: Event) => void) | null;
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  __triggerOpen: () => void;
}

const sockets: MockSocket[] = [];

class FakeWebSocket {
  static OPEN = 1;
  static CLOSED = 3;
  url: string;
  readyState = 0;
  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  send = vi.fn();
  close = vi.fn(() => {
    this.readyState = FakeWebSocket.CLOSED;
  });

  constructor(url: string) {
    this.url = url;
    sockets.push(this as unknown as MockSocket);
    Object.assign(this as unknown as MockSocket, {
      __triggerOpen: () => {
        this.readyState = FakeWebSocket.OPEN;
        this.onopen?.({} as Event);
      },
    });
  }
}

beforeEach(() => {
  sockets.length = 0;
  sessionsStore.activeSessionId = null;
  sessionsStore.beginPtyReconnect.mockClear();
  sessionsStore.clearPtyReconnect.mockClear();
  uiStore.sendToTargetSessionId = null;
  // @ts-expect-error — replace global
  globalThis.WebSocket = FakeWebSocket;
  vi.stubGlobal('location', {
    protocol: 'http:',
    host: 'localhost:3000',
  });
  vi.stubGlobal('document', {
    addEventListener: vi.fn(),
    visibilityState: 'visible',
    hidden: false,
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const fakeTerm = (): Terminal => {
  return {
    write: vi.fn(),
    clear: vi.fn(),
  } as unknown as Terminal;
};

async function importWs() {
  vi.resetModules();
  return await import('../frontend/src/lib/ws.js');
}

describe('per-session PTY routing', () => {
  it('opens distinct sockets for distinct sessions', async () => {
    const ws = await importWs();
    const onResize = vi.fn();
    const onEnd = vi.fn();
    ws.connectPtySocket('sess-a', fakeTerm(), onResize, onEnd);
    ws.connectPtySocket('sess-b', fakeTerm(), onResize, onEnd);
    expect(sockets).toHaveLength(2);
    expect(sockets[0]!.url).toContain('/ws/sess-a');
    expect(sockets[1]!.url).toContain('/ws/sess-b');
  });

  it('routes sendPtyData to the matching session', async () => {
    const ws = await importWs();
    ws.connectPtySocket('sess-a', fakeTerm(), vi.fn(), vi.fn());
    ws.connectPtySocket('sess-b', fakeTerm(), vi.fn(), vi.fn());
    sockets[0]!.__triggerOpen();
    sockets[1]!.__triggerOpen();
    ws.sendPtyData('sess-a', 'hello-a');
    ws.sendPtyData('sess-b', 'hello-b');
    expect(sockets[0]!.send).toHaveBeenCalledWith('hello-a');
    expect(sockets[1]!.send).toHaveBeenCalledWith('hello-b');
    // Cross-talk check
    const aCalls = sockets[0]!.send.mock.calls.map((c) => c[0]);
    expect(aCalls.includes('hello-b')).toBe(false);
  });

  it('routes sendPtyResize per session', async () => {
    const ws = await importWs();
    ws.connectPtySocket('sess-a', fakeTerm(), vi.fn(), vi.fn());
    ws.connectPtySocket('sess-b', fakeTerm(), vi.fn(), vi.fn());
    sockets[0]!.__triggerOpen();
    sockets[1]!.__triggerOpen();
    ws.sendPtyResize('sess-a', 80, 24);
    expect(sockets[0]!.send).toHaveBeenCalledWith(
      JSON.stringify({ type: 'resize', cols: 80, rows: 24 })
    );
    expect(sockets[1]!.send).not.toHaveBeenCalled();
  });

  it('isPtyConnected reports per-session state', async () => {
    const ws = await importWs();
    ws.connectPtySocket('sess-a', fakeTerm(), vi.fn(), vi.fn());
    expect(ws.isPtyConnected('sess-a')).toBe(false);
    sockets[0]!.__triggerOpen();
    expect(ws.isPtyConnected('sess-a')).toBe(true);
    expect(ws.isPtyConnected('sess-b')).toBe(false);
  });

  it('disconnectPtySocket cleans up only the target session', async () => {
    const ws = await importWs();
    ws.connectPtySocket('sess-a', fakeTerm(), vi.fn(), vi.fn());
    ws.connectPtySocket('sess-b', fakeTerm(), vi.fn(), vi.fn());
    sockets[0]!.__triggerOpen();
    sockets[1]!.__triggerOpen();
    ws.disconnectPtySocket('sess-a');
    expect(sockets[0]!.close).toHaveBeenCalled();
    expect(sockets[1]!.close).not.toHaveBeenCalled();
    expect(ws.isPtyConnected('sess-a')).toBe(false);
    expect(ws.isPtyConnected('sess-b')).toBe(true);
  });

  it('no-arg sendPtyData routes to sendToTargetSessionId when set', async () => {
    const ws = await importWs();
    ws.connectPtySocket('sess-a', fakeTerm(), vi.fn(), vi.fn());
    ws.connectPtySocket('sess-b', fakeTerm(), vi.fn(), vi.fn());
    sockets[0]!.__triggerOpen();
    sockets[1]!.__triggerOpen();
    uiStore.sendToTargetSessionId = 'sess-b';
    ws.sendPtyData('to-active');
    expect(sockets[1]!.send).toHaveBeenCalledWith('to-active');
    expect(sockets[0]!.send).not.toHaveBeenCalled();
  });

  it('no-arg sendPtyData falls back to activeSessionId', async () => {
    const ws = await importWs();
    ws.connectPtySocket('sess-a', fakeTerm(), vi.fn(), vi.fn());
    sockets[0]!.__triggerOpen();
    sessionsStore.activeSessionId = 'sess-a';
    ws.sendPtyData('to-active');
    expect(sockets[0]!.send).toHaveBeenCalledWith('to-active');
  });

  it('no-arg sendPtyData is a no-op when no active target', async () => {
    const ws = await importWs();
    ws.connectPtySocket('sess-a', fakeTerm(), vi.fn(), vi.fn());
    sockets[0]!.__triggerOpen();
    expect(() => ws.sendPtyData('orphan')).not.toThrow();
    expect(sockets[0]!.send).not.toHaveBeenCalled();
  });

  it('reconnecting one session does not affect siblings', async () => {
    const ws = await importWs();
    ws.connectPtySocket('sess-a', fakeTerm(), vi.fn(), vi.fn());
    ws.connectPtySocket('sess-b', fakeTerm(), vi.fn(), vi.fn());
    sockets[0]!.__triggerOpen();
    sockets[1]!.__triggerOpen();
    // Force-close A (non-clean code → triggers reconnect path)
    sockets[0]!.readyState = FakeWebSocket.CLOSED;
    sockets[0]!.onclose?.({ code: 1006 } as CloseEvent);
    // B should still be operational
    expect(ws.isPtyConnected('sess-b')).toBe(true);
    ws.sendPtyData('sess-b', 'still-here');
    expect(sockets[1]!.send).toHaveBeenCalledWith('still-here');
  });

  it('reopening a session replaces the prior socket', async () => {
    const ws = await importWs();
    ws.connectPtySocket('sess-a', fakeTerm(), vi.fn(), vi.fn());
    ws.connectPtySocket('sess-a', fakeTerm(), vi.fn(), vi.fn());
    expect(sockets[0]!.close).toHaveBeenCalled();
    expect(sockets).toHaveLength(2);
    expect(sockets[1]!.url).toContain('/ws/sess-a');
  });

  it('reconnects an open PTY after server-restarting followed by clean close', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url === '/auth/check') return { status: 200 };
        if (url === '/sessions') {
          return { json: async () => [{ id: 'sess-a' }] };
        }
        throw new Error(`unexpected fetch ${url}`);
      })
    );
    const ws = await importWs();
    const term = fakeTerm();
    const onEnd = vi.fn();
    ws.connectPtySocket('sess-a', term, vi.fn(), onEnd);
    sockets[0]!.__triggerOpen();

    ws.connectEventSocket(vi.fn());
    sockets[1]!.onmessage?.({
      data: JSON.stringify({ type: 'server-restarting', reason: 'dev-restart' }),
    } as MessageEvent);
    sockets[0]!.readyState = FakeWebSocket.CLOSED;
    sockets[0]!.onclose?.({ code: 1000 } as CloseEvent);

    expect(term.write).not.toHaveBeenCalledWith('\r\n[Session ended]\r\n');
    expect(onEnd).not.toHaveBeenCalled();
    expect(sessionsStore.beginPtyReconnect).toHaveBeenCalledWith('sess-a');

    await vi.advanceTimersByTimeAsync(1000);

    expect(term.clear).not.toHaveBeenCalled();
    expect(sockets).toHaveLength(3);
    expect(sockets[2]!.url).toContain('/ws/sess-a');
  });

  it('does not invoke auth fallback for 401 checks during the restart grace window', async () => {
    vi.useFakeTimers();
    const onAuthRequired = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url === '/auth/check') return { status: 401 };
        throw new Error(`unexpected fetch ${url}`);
      })
    );

    const ws = await importWs();
    ws.connectEventSocket(vi.fn(), vi.fn(), onAuthRequired);
    sockets[0]!.onmessage?.({
      data: JSON.stringify({ type: 'server-restarting', reason: 'dev-restart' }),
    } as MessageEvent);
    sockets[0]!.readyState = FakeWebSocket.CLOSED;
    sockets[0]!.onclose?.({ code: 1006 } as CloseEvent);

    await vi.advanceTimersByTimeAsync(3000);

    expect(onAuthRequired).not.toHaveBeenCalled();
  });
});
