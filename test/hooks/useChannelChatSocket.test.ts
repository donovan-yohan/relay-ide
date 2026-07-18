// @vitest-environment happy-dom

import React, { act } from 'react';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { UseChannelChatSocketState } from '../../frontend/src/hooks/useChannelChatSocket.js';
import { useChannelActivityStore } from '../../frontend/src/lib/stores/channel-activity.js';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const fetchChannelMock = vi.hoisted(() => vi.fn());

vi.mock('../../frontend/src/lib/api.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../frontend/src/lib/api.js')>();
  return { ...actual, fetchChannel: fetchChannelMock as Mock };
});

import { useChannelChatSocket } from '../../frontend/src/hooks/useChannelChatSocket.js';

// ── Minimal WebSocket double ─────────────────────────────────────────────────
class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: MockWebSocket[] = [];

  url: string;
  readyState = MockWebSocket.CONNECTING;
  onopen: ((ev?: unknown) => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  onerror: ((ev?: unknown) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  // test-driven server events
  open(): void {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.();
  }
  message(payload: unknown): void {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }
  serverClose(code = 1006): void {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({ code });
  }

  // client-initiated close: the hook nulls handlers first, so no onclose fires
  close(): void {
    this.readyState = MockWebSocket.CLOSED;
  }
  send(): void {}
}

const CID = 'topic:test-channel';

function summary(latestSeq: number) {
  return {
    id: CID,
    title: 'test',
    visibility: 'default' as const,
    archived: false,
    latestSeq,
    messageCount: latestSeq,
    lastMessage: null,
    members: [],
  };
}

function fullSnapshot(latestSeq: number) {
  return {
    type: 'channel-snapshot-v1',
    channelId: CID,
    timestamp: new Date().toISOString(),
    mode: 'full',
    messages: [],
    members: [],
    latestSeq,
    inFlight: [],
    truncated: false,
  };
}

let container: HTMLDivElement;
let root: Root;
let latest: UseChannelChatSocketState;

function Harness({ channelId }: { channelId: string | null }) {
  latest = useChannelChatSocket(channelId);
  return null;
}

async function render(channelId: string | null): Promise<void> {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  await act(async () => {
    root.render(
      React.createElement(
        QueryClientProvider,
        { client: queryClient },
        React.createElement(Harness, { channelId })
      )
    );
  });
}

function currentSocket(): MockWebSocket {
  return MockWebSocket.instances[MockWebSocket.instances.length - 1]!;
}

async function openCurrent(): Promise<void> {
  await act(async () => {
    currentSocket().open();
    await Promise.resolve();
  });
}

async function sendSnapshot(latestSeq: number): Promise<void> {
  await act(async () => {
    currentSocket().message(fullSnapshot(latestSeq));
    await Promise.resolve();
  });
}

describe('useChannelChatSocket liveness + recovery (#1178)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    MockWebSocket.instances = [];
    fetchChannelMock.mockReset();
    fetchChannelMock.mockResolvedValue(summary(0));
    vi.stubGlobal('WebSocket', MockWebSocket);
    useChannelActivityStore.setState({
      latestSeqByChannel: {},
      lastReadByChannel: {},
    });
    try {
      localStorage.clear();
    } catch {
      /* ignore */
    }
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('idle-probe forces a reconnect when a REST head-check outruns the socket', async () => {
    await render(CID);
    await openCurrent();
    await sendSnapshot(5); // reducer.lastSeq → 5, cursor → 5
    expect(latest.connected).toBe(true);
    expect(MockWebSocket.instances).toHaveLength(1);

    // Server advanced past what the (now half-dead) socket ever delivered.
    fetchChannelMock.mockResolvedValue(summary(9));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(151_000);
    });

    // A fresh socket was opened to catch up.
    expect(MockWebSocket.instances.length).toBeGreaterThanOrEqual(2);
  });

  it('idle-probe leaves a healthy-but-quiet socket alone', async () => {
    await render(CID);
    await openCurrent();
    await sendSnapshot(5);

    fetchChannelMock.mockResolvedValue(summary(5)); // no divergence
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200_000);
    });

    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it('visibilitychange reconnects a socket that silently closed', async () => {
    await render(CID);
    await openCurrent();
    await act(async () => {
      currentSocket().serverClose(1006); // NAT/proxy drop → backoff pending
      await Promise.resolve();
    });
    const afterClose = MockWebSocket.instances.length;

    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      await Promise.resolve();
    });

    expect(MockWebSocket.instances.length).toBe(afterClose + 1);
  });

  it('resync cancels a pending backoff timer so it cannot reopen later', async () => {
    await render(CID);
    await openCurrent();
    await act(async () => {
      currentSocket().serverClose(1006); // schedules a 1s backoff reconnect
      await Promise.resolve();
    });

    await act(async () => {
      latest.resync();
      await Promise.resolve();
    });
    const afterResync = MockWebSocket.instances.length;

    // The stale backoff timer must NOT also fire and tear down the new socket.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(MockWebSocket.instances.length).toBe(afterResync);
  });

  it('surfaces disconnected after the reconnect budget is exhausted, then resync recovers', async () => {
    await render(CID);
    await openCurrent();

    for (let i = 0; i < 40 && !latest.disconnected; i++) {
      await act(async () => {
        currentSocket().serverClose(1006);
        await vi.advanceTimersByTimeAsync(10_000);
      });
    }

    expect(latest.disconnected).toBe(true);
    expect(latest.connected).toBe(false);

    const before = MockWebSocket.instances.length;
    await act(async () => {
      latest.resync();
      await Promise.resolve();
    });
    expect(latest.disconnected).toBe(false);
    expect(MockWebSocket.instances.length).toBe(before + 1);
  });

  it('clamps client seq stores DOWN when a full snapshot head is below the stored marker', async () => {
    // A DM recreated under the same deterministic id restarts seq low.
    useChannelActivityStore.getState().recordActivity(CID, 50);
    useChannelActivityStore.getState().markChannelRead(CID, 40);

    await render(CID);
    await openCurrent();
    await sendSnapshot(5); // authoritative head is now 5

    const state = useChannelActivityStore.getState();
    expect(state.latestSeqByChannel[CID]).toBe(5);
    expect(state.lastReadByChannel[CID]).toBe(5);
  });
});
