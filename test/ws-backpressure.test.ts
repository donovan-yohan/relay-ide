import { describe, it, expect } from 'vitest';
import type { WebSocket } from 'ws';

import {
  bufferedAmountOf,
  createWsHeartbeatMonitor,
  deliverDelta,
  sendWithBackpressure,
  WS_BACKPRESSURE_CLOSE_CODE,
  WS_HARD_LIMIT_BYTES,
  WS_LOW_LIMIT_BYTES,
  WS_SOFT_LIMIT_BYTES,
  type BackpressureSocket,
  type DeltaLaneState,
  type HeartbeatSocket,
} from '../server/ws-backpressure.js';
import { sendTerminalStreamEnvelope } from '../server/ws.js';
import {
  appendTerminalStreamData,
  createTerminalStreamState,
  type TerminalStreamEnvelope,
} from '../shared/session-replay.js';

// #1249: these tests ARE the off-heap leak confirmation. The pre-fix fan-out
// paths gated a `ws.send` only on `readyState === OPEN`, so a stalled-but-OPEN
// subscriber (backgrounded mobile tab / sleeping laptop) accumulated outbound
// frames in the socket's off-heap send queue without bound — 150MB/min, 15GB rss.
// A fake socket whose `bufferedAmount` we control and whose `send` counts queued
// bytes reproduces the unbounded growth directly (test 4) and proves it is now
// bounded by the soft/hard watermarks + healed by the heartbeat reaper.

const OPEN = 1;
const CLOSED = 3;

interface FakeSocket extends BackpressureSocket {
  readyState: number;
  bufferedAmount: number;
  /** total bytes accepted by `send` — the simulated off-heap send queue size. */
  queuedBytes: number;
  sent: string[];
  closedWith: number | null;
  /** when true, `send` also grows `bufferedAmount` (a client that never drains). */
  stalled: boolean;
  on(event: 'close' | 'error', handler: () => void): void;
  fireClose(): void;
}

function fakeSocket(
  opts: { bufferedAmount?: number; stalled?: boolean } = {}
): FakeSocket {
  const handlers: Array<() => void> = [];
  return {
    readyState: OPEN,
    bufferedAmount: opts.bufferedAmount ?? 0,
    queuedBytes: 0,
    sent: [],
    closedWith: null,
    stalled: opts.stalled ?? false,
    send(data: string) {
      const bytes = Buffer.byteLength(data, 'utf8');
      this.queuedBytes += bytes;
      this.sent.push(data);
      // A stalled client's kernel/uv send queue never drains, so bufferedAmount
      // tracks everything ever queued — exactly the incident condition.
      if (this.stalled) this.bufferedAmount += bytes;
    },
    close(code?: number) {
      this.closedWith = code ?? 1000;
      this.readyState = CLOSED;
      this.fireClose();
    },
    on(event, handler) {
      if (event === 'close') handlers.push(handler);
    },
    fireClose() {
      for (const h of handlers.splice(0)) h();
    },
  };
}

interface FakeHeartbeatSocket extends HeartbeatSocket {
  pings: number;
  terminated: boolean;
  pong(): void;
}

function fakeHeartbeatSocket(): FakeHeartbeatSocket {
  let onPong: (() => void) | null = null;
  return {
    pings: 0,
    terminated: false,
    ping() {
      this.pings += 1;
    },
    terminate() {
      this.terminated = true;
    },
    on(_event: 'pong', handler: () => void) {
      onPong = handler;
    },
    pong() {
      onPong?.();
    },
  };
}

function dataEnvelope(bytes: number): TerminalStreamEnvelope {
  const state = createTerminalStreamState({ sessionId: 'sess-1' });
  return appendTerminalStreamData(state, 'x'.repeat(bytes));
}

describe('#1249 sendWithBackpressure — per-connection send-queue bound', () => {
  it('drops a replayable delta above the soft watermark (does not queue)', () => {
    const ws = fakeSocket({ bufferedAmount: WS_SOFT_LIMIT_BYTES + 1 });
    const result = sendWithBackpressure(ws, () => 'delta', { droppable: true });
    expect(result).toBe('dropped');
    expect(ws.sent).toHaveLength(0);
    expect(ws.queuedBytes).toBe(0);
  });

  it('still sends a coarse (non-droppable) frame above the soft watermark', () => {
    const ws = fakeSocket({ bufferedAmount: WS_SOFT_LIMIT_BYTES + 1 });
    const result = sendWithBackpressure(ws, () => 'resize');
    expect(result).toBe('sent');
    expect(ws.sent).toEqual(['resize']);
  });

  it('closes with 4409 above the hard watermark', () => {
    const ws = fakeSocket({ bufferedAmount: WS_HARD_LIMIT_BYTES + 1 });
    const result = sendWithBackpressure(ws, () => 'delta', { droppable: true });
    expect(result).toBe('closed');
    expect(ws.closedWith).toBe(WS_BACKPRESSURE_CLOSE_CODE);
    expect(ws.sent).toHaveLength(0);
  });

  it('closes an irreplaceable (event) lane when it is soft-lagging', () => {
    const ws = fakeSocket({ bufferedAmount: WS_SOFT_LIMIT_BYTES + 1 });
    const result = sendWithBackpressure(ws, () => 'event', {
      closeWhenLagging: true,
    });
    expect(result).toBe('closed');
    expect(ws.closedWith).toBe(WS_BACKPRESSURE_CLOSE_CODE);
  });

  it('does not send on a non-OPEN socket', () => {
    const ws = fakeSocket();
    ws.readyState = CLOSED;
    expect(sendWithBackpressure(ws, () => 'x', { droppable: true })).toBe(
      'not-open'
    );
    expect(ws.sent).toHaveLength(0);
  });

  it('bufferedAmountOf tolerates a socket without the property', () => {
    expect(bufferedAmountOf({ readyState: OPEN, send() {}, close() {} })).toBe(
      0
    );
  });
});

describe('#1249 sendTerminalStreamEnvelope — RANK 1 leak path (raw PTY stdout)', () => {
  it('closes a hard-lagging terminal socket 4409 and splices its subscriber', () => {
    const ws = fakeSocket({ bufferedAmount: WS_HARD_LIMIT_BYTES + 1 });
    // Mirror the ws.ts wiring: the ws `close` handler splices the subscriber.
    const subscriber = (env: TerminalStreamEnvelope) =>
      sendTerminalStreamEnvelope(ws as unknown as WebSocket, env);
    const subscribers = [subscriber];
    ws.on('close', () => {
      const i = subscribers.indexOf(subscriber);
      if (i !== -1) subscribers.splice(i, 1);
    });

    sendTerminalStreamEnvelope(ws as unknown as WebSocket, dataEnvelope(64));

    expect(ws.closedWith).toBe(WS_BACKPRESSURE_CLOSE_CODE);
    expect(subscribers).toHaveLength(0);
  });

  it('BOUNDED GROWTH: a stalled subscriber never grows the send queue without limit', () => {
    // The direct reproduction of the incident. On nightly this loop calls
    // `ws.send` unconditionally 20k times → queuedBytes climbs past hundreds of
    // MB. With the fix, once bufferedAmount crosses the soft watermark every
    // further `data` delta is shed, so the queue is bounded by soft + one frame.
    const ws = fakeSocket({ stalled: true });
    const FRAME_BYTES = 1024;
    for (let i = 0; i < 20_000; i += 1) {
      sendTerminalStreamEnvelope(
        ws as unknown as WebSocket,
        dataEnvelope(FRAME_BYTES)
      );
    }
    // 20k * ~1KB frames = ~20MB if unbounded; bounded well under the hard cap.
    expect(ws.queuedBytes).toBeLessThan(WS_HARD_LIMIT_BYTES);
    expect(ws.bufferedAmount).toBeLessThanOrEqual(
      WS_SOFT_LIMIT_BYTES + 4096 // soft watermark + one in-flight frame envelope
    );
    expect(ws.closedWith).toBeNull(); // shed, not closed — no reconnect churn
  });

  it('HEALTHY CLIENT: a fast-draining terminal socket receives every frame', () => {
    const ws = fakeSocket(); // bufferedAmount stays 0 (drains instantly)
    for (let i = 0; i < 500; i += 1) {
      sendTerminalStreamEnvelope(ws as unknown as WebSocket, dataEnvelope(256));
    }
    expect(ws.sent).toHaveLength(500);
    expect(ws.closedWith).toBeNull();
  });
});

describe('#1249 deliverDelta — agent web-session patch lane', () => {
  it('sheds a patch above the soft watermark and marks lagging', () => {
    const ws = fakeSocket({ bufferedAmount: WS_SOFT_LIMIT_BYTES + 1 });
    const state: DeltaLaneState = { lagging: false };
    const result = deliverDelta(
      ws,
      state,
      () => 'patch',
      () => 'snapshot'
    );
    expect(result).toBe('dropped');
    expect(state.lagging).toBe(true);
    expect(ws.sent).toHaveLength(0);
  });

  it('re-syncs with a fresh snapshot ONLY once drained below the low watermark', () => {
    const ws = fakeSocket({ bufferedAmount: WS_LOW_LIMIT_BYTES - 1 });
    const state: DeltaLaneState = { lagging: true };
    const result = deliverDelta(
      ws,
      state,
      () => 'patch',
      () => 'snapshot'
    );
    expect(result).toBe('resync');
    expect(state.lagging).toBe(false);
    // Snapshot only — it already reflects this delta (patch applied to session
    // state before the forwarder runs), so re-sending the delta would double-apply.
    expect(ws.sent).toEqual(['snapshot']);
  });

  it('closes 4409 above the hard watermark', () => {
    const ws = fakeSocket({ bufferedAmount: WS_HARD_LIMIT_BYTES + 1 });
    const state: DeltaLaneState = { lagging: false };
    expect(
      deliverDelta(
        ws,
        state,
        () => 'patch',
        () => 'snapshot'
      )
    ).toBe('closed');
    expect(ws.closedWith).toBe(WS_BACKPRESSURE_CLOSE_CODE);
  });

  it('HEALTHY CLIENT: delivers every patch and never lags', () => {
    const ws = fakeSocket();
    const state: DeltaLaneState = { lagging: false };
    for (let i = 0; i < 300; i += 1) {
      expect(
        deliverDelta(
          ws,
          state,
          () => `p${i}`,
          () => 'snapshot'
        )
      ).toBe('sent');
    }
    expect(state.lagging).toBe(false);
    expect(ws.sent).toHaveLength(300);
  });

  it('BOUNDED GROWTH: a stalled agent subscriber never queues without limit', () => {
    const ws = fakeSocket({ stalled: true });
    const state: DeltaLaneState = { lagging: false };
    for (let i = 0; i < 20_000; i += 1) {
      deliverDelta(
        ws,
        state,
        () => 'x'.repeat(1024),
        () => 'snapshot'
      );
    }
    expect(ws.bufferedAmount).toBeLessThan(WS_HARD_LIMIT_BYTES);
  });
});

describe('#1249 createWsHeartbeatMonitor — half-open socket reaper', () => {
  it('reaps a socket that stops ponging and runs its cleanup', () => {
    const monitor = createWsHeartbeatMonitor({ intervalMs: 1_000_000 });
    const ws = fakeHeartbeatSocket();
    const subscribers = [ws];
    monitor.track(ws, () => {
      const i = subscribers.indexOf(ws);
      if (i !== -1) subscribers.splice(i, 1);
    });

    // Tick 1: alive→ping (marks not-alive, awaits a pong that never comes).
    monitor.tick();
    expect(ws.pings).toBe(1);
    expect(ws.terminated).toBe(false);

    // Tick 2: no pong since tick 1 → terminate + cleanup (subscriber spliced).
    monitor.tick();
    expect(ws.terminated).toBe(true);
    expect(subscribers).toHaveLength(0);
    expect(monitor.trackedCount()).toBe(0);
    monitor.stop();
  });

  it('keeps a socket that pongs alive across ticks', () => {
    const monitor = createWsHeartbeatMonitor({ intervalMs: 1_000_000 });
    const ws = fakeHeartbeatSocket();
    let reaped = false;
    monitor.track(ws, () => {
      reaped = true;
    });

    monitor.tick(); // ping
    ws.pong(); // client answers → marked alive again
    monitor.tick(); // still alive → ping, not terminated
    ws.pong();
    monitor.tick();

    expect(ws.terminated).toBe(false);
    expect(reaped).toBe(false);
    expect(monitor.trackedCount()).toBe(1);
    monitor.stop();
  });

  it('untrack removes a socket and stop clears all + the interval', () => {
    const monitor = createWsHeartbeatMonitor({ intervalMs: 1_000_000 });
    const a = fakeHeartbeatSocket();
    const b = fakeHeartbeatSocket();
    monitor.track(a, () => {});
    monitor.track(b, () => {});
    expect(monitor.trackedCount()).toBe(2);
    monitor.untrack(a);
    expect(monitor.trackedCount()).toBe(1);
    monitor.stop();
    expect(monitor.trackedCount()).toBe(0);
  });
});
