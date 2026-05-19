import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Terminal } from '@xterm/xterm';

// We need to mock store imports BEFORE importing ws.ts
const sessionsStore = {
  sessions: [] as Array<{
    id: string;
    nodeId?: string;
    globalSessionId?: string;
  }>,
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
  __triggerMessage: (data: string) => void;
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
      __triggerMessage: (data: string) => {
        this.onmessage?.({ data } as MessageEvent);
      },
    });
  }
}

let rafCallbacks: Array<() => void> = [];

beforeEach(() => {
  sockets.length = 0;
  rafCallbacks = [];
  sessionsStore.sessions = [];
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
  // Capture rAF callbacks instead of executing them immediately
  vi.stubGlobal('requestAnimationFrame', (cb: () => void) => {
    rafCallbacks.push(cb);
    return rafCallbacks.length - 1;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    rafCallbacks[id] = () => {};
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

/** Flush all pending rAF callbacks. */
function flushRaf() {
  const pending = [...rafCallbacks];
  rafCallbacks = [];
  for (const cb of pending) cb();
}

async function importWs() {
  vi.resetModules();
  return await import('../frontend/src/lib/ws.js');
}

describe('pausePtyFeed / resumePtyFeed', () => {
  it('buffers incoming bytes while paused and does not write to xterm', async () => {
    const ws = await importWs();
    const term = fakeTerm();
    ws.connectPtySocket('sess-a', term, vi.fn(), vi.fn());
    sockets[0]!.__triggerOpen();

    ws.pausePtyFeed('sess-a');
    sockets[0]!.__triggerMessage('chunk-1');
    sockets[0]!.__triggerMessage('chunk-2');

    // Nothing should have been written to xterm while paused.
    expect(term.write).not.toHaveBeenCalled();
  });

  it('flushes buffered bytes to xterm on resume', async () => {
    const ws = await importWs();
    const term = fakeTerm();
    ws.connectPtySocket('sess-a', term, vi.fn(), vi.fn());
    sockets[0]!.__triggerOpen();

    ws.pausePtyFeed('sess-a');
    sockets[0]!.__triggerMessage('hello ');
    sockets[0]!.__triggerMessage('world');

    ws.resumePtyFeed('sess-a');
    // resume moves data into the write queue; flush happens on next rAF
    flushRaf();

    expect(term.write).toHaveBeenCalledTimes(1);
    const written = (term.write as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(written).toBe('hello world');
  });

  it('writes data to xterm normally while not paused', async () => {
    const ws = await importWs();
    const term = fakeTerm();
    ws.connectPtySocket('sess-a', term, vi.fn(), vi.fn());
    sockets[0]!.__triggerOpen();

    sockets[0]!.__triggerMessage('live-data');
    flushRaf();

    expect(term.write).toHaveBeenCalledTimes(1);
    expect((term.write as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toBe(
      'live-data'
    );
  });

  it('can pause and resume multiple times without losing data', async () => {
    const ws = await importWs();
    const term = fakeTerm();
    ws.connectPtySocket('sess-a', term, vi.fn(), vi.fn());
    sockets[0]!.__triggerOpen();

    // First pause cycle
    ws.pausePtyFeed('sess-a');
    sockets[0]!.__triggerMessage('a');
    ws.resumePtyFeed('sess-a');
    flushRaf();

    // Second pause cycle
    ws.pausePtyFeed('sess-a');
    sockets[0]!.__triggerMessage('b');
    ws.resumePtyFeed('sess-a');
    flushRaf();

    const writeCalls = (term.write as ReturnType<typeof vi.fn>).mock.calls;
    const allWritten = writeCalls.map((c) => c[0] as string).join('');
    expect(allWritten).toBe('ab');
  });

  it('pause is a no-op for unknown session ids', async () => {
    const ws = await importWs();
    expect(() => ws.pausePtyFeed('nonexistent')).not.toThrow();
    expect(() => ws.resumePtyFeed('nonexistent')).not.toThrow();
  });

  it('does not double-pause if called multiple times', async () => {
    const ws = await importWs();
    const term = fakeTerm();
    ws.connectPtySocket('sess-a', term, vi.fn(), vi.fn());
    sockets[0]!.__triggerOpen();

    ws.pausePtyFeed('sess-a');
    ws.pausePtyFeed('sess-a'); // second call is a no-op

    sockets[0]!.__triggerMessage('only-once');
    ws.resumePtyFeed('sess-a');
    flushRaf();

    const written = (term.write as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(written).toBe('only-once');
  });

  it('keeps the WebSocket open while paused', async () => {
    const ws = await importWs();
    const term = fakeTerm();
    ws.connectPtySocket('sess-a', term, vi.fn(), vi.fn());
    sockets[0]!.__triggerOpen();

    ws.pausePtyFeed('sess-a');
    expect(ws.isPtyConnected('sess-a')).toBe(true);
    expect(sockets[0]!.close).not.toHaveBeenCalled();
  });
});

describe('pause ring buffer — 256 KB cap with FIFO eviction', () => {
  it('evicts oldest bytes when the pause buffer exceeds 256 KB', async () => {
    const ws = await importWs();
    const term = fakeTerm();
    ws.connectPtySocket('sess-a', term, vi.fn(), vi.fn());
    sockets[0]!.__triggerOpen();

    ws.pausePtyFeed('sess-a');

    // Send 300 KB in 10 KB chunks (30 chunks) — should trigger eviction
    const chunk = 'x'.repeat(10 * 1024); // 10 KB per chunk
    for (let i = 0; i < 30; i++) {
      sockets[0]!.__triggerMessage(chunk);
    }

    ws.resumePtyFeed('sess-a');
    flushRaf();

    // After eviction the combined write should be <= 256 KB
    const written = (term.write as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(typeof written).toBe('string');
    expect(written.length).toBeLessThanOrEqual(256 * 1024);

    // And the tail of the data should be intact (newest chunks preserved)
    expect(written.endsWith(chunk)).toBe(true);
  });

  it('preserves data exactly when total is under the 256 KB cap', async () => {
    const ws = await importWs();
    const term = fakeTerm();
    ws.connectPtySocket('sess-a', term, vi.fn(), vi.fn());
    sockets[0]!.__triggerOpen();

    ws.pausePtyFeed('sess-a');

    const chunk = 'y'.repeat(100);
    for (let i = 0; i < 5; i++) {
      sockets[0]!.__triggerMessage(chunk);
    }

    ws.resumePtyFeed('sess-a');
    flushRaf();

    const written = (term.write as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(written).toBe(chunk.repeat(5));
  });

  it('uses O(1) head-index eviction — many small chunks over cap do not corrupt data', async () => {
    // Sends many small 1-byte chunks totalling well over the 256 KB cap.
    // This exercises the head-index path that was previously O(N) per eviction.
    const ws = await importWs();
    const term = fakeTerm();
    ws.connectPtySocket('sess-a', term, vi.fn(), vi.fn());
    sockets[0]!.__triggerOpen();

    ws.pausePtyFeed('sess-a');

    // 300_000 single-byte chunks → 300 KB total, triggers many evictions
    const totalChunks = 300_000;
    for (let i = 0; i < totalChunks; i++) {
      sockets[0]!.__triggerMessage('z');
    }

    ws.resumePtyFeed('sess-a');
    flushRaf();

    const written = (term.write as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(typeof written).toBe('string');
    // Flushed output must be within the 256 KB cap
    expect(written.length).toBeLessThanOrEqual(256 * 1024);
    // All flushed bytes should be 'z' (no corruption)
    expect(written).toMatch(/^z+$/);
  });
});

describe('resumePtyFeed — flush writeQueue even when pauseBuffer is empty', () => {
  it('schedules a flush for data already in writeQueue before the pause started', async () => {
    // Simulates: data arrived and was queued in writeQueue, THEN the tab was
    // paused (e.g., the rAF hadn't fired yet). On resume, that queued data
    // should be flushed even though pauseBuffer is empty.
    const ws = await importWs();

    // We need access to internal connection state; use the test helper.
    const { _ptyConnectionsForTesting } = ws;

    const term = fakeTerm();
    ws.connectPtySocket('sess-a', term, vi.fn(), vi.fn());
    sockets[0]!.__triggerOpen();

    // Deliver a message BEFORE pausing so it goes into writeQueue normally.
    sockets[0]!.__triggerMessage('pre-pause-data');

    // Now pause — this cancels the pending rAF but leaves writeQueue intact.
    ws.pausePtyFeed('sess-a');

    // Verify nothing was written yet (rAF was cancelled).
    expect(term.write).not.toHaveBeenCalled();

    // Deliver additional data while paused — goes to pauseBuffer.
    sockets[0]!.__triggerMessage('paused-data');

    // Resume should flush both writeQueue and pauseBuffer contents.
    ws.resumePtyFeed('sess-a');
    flushRaf();

    expect(term.write).toHaveBeenCalledTimes(1);
    const written = (term.write as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(written).toContain('pre-pause-data');
    expect(written).toContain('paused-data');
  });

  it('flushes writeQueue on resume even when pauseBuffer was never filled', async () => {
    // Pause immediately after connect (before any data), then receive data while
    // paused, then resume. Ensures the unconditional scheduleFlush path works.
    const ws = await importWs();
    const term = fakeTerm();
    ws.connectPtySocket('sess-a', term, vi.fn(), vi.fn());
    sockets[0]!.__triggerOpen();

    ws.pausePtyFeed('sess-a');
    sockets[0]!.__triggerMessage('buffered');
    ws.resumePtyFeed('sess-a');
    flushRaf();

    expect(term.write).toHaveBeenCalledTimes(1);
    expect((term.write as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toBe(
      'buffered'
    );
  });
});
