import { describe, it, expect } from 'vitest';
import type { WebSocket } from 'ws';

import {
  bufferedAmountOf,
  createWsHeartbeatMonitor,
  deliverDelta,
  deliverTerminalEnvelope,
  sendWithBackpressure,
  WS_BACKPRESSURE_CLOSE_CODE,
  WS_HARD_LIMIT_BYTES,
  WS_LOW_LIMIT_BYTES,
  WS_SOFT_LIMIT_BYTES,
  type BackpressureSocket,
  type DeltaLaneState,
  type HeartbeatSocket,
  type TerminalLaneState,
} from '../server/ws-backpressure.js';
import { sendTerminalStreamEnvelope } from '../server/ws.js';
import {
  appendTerminalStreamData,
  buildTerminalStreamReplay,
  createTerminalStreamState,
  type TerminalStreamEnvelope,
  type TerminalStreamState,
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

// #1250 FIX 2: `deliverDelta` was missing channel-hub's `if (lagging) return`
// guard. After a patch was shed and BEFORE the drain snapshot healed the gap (the
// [low, soft] band) it kept sending RAW patches, which the client applied over the
// gap → inconsistent view. The lane must SUPPRESS every raw delta while lagging and
// heal with exactly one resync snapshot on drain.
describe('#1250 deliverDelta — suppress raw patches while lagging (no agent desync)', () => {
  it('SUPPRESSES a raw patch while lagging in the [low, soft] band (does not apply over the gap)', () => {
    const ws = fakeSocket({
      bufferedAmount: Math.floor(
        (WS_LOW_LIMIT_BYTES + WS_SOFT_LIMIT_BYTES) / 2
      ),
    });
    const state: DeltaLaneState = { lagging: true };
    const result = deliverDelta(
      ws,
      state,
      () => 'patch',
      () => 'snapshot'
    );
    // Pre-fix this returned 'sent' and applied the patch over the un-healed gap.
    expect(result).toBe('dropped');
    expect(state.lagging).toBe(true);
    expect(ws.sent).toHaveLength(0);
  });

  it('still closes 4409 at the hard cap WHILE lagging (a client that never drains is not stuck forever)', () => {
    const ws = fakeSocket({ bufferedAmount: WS_HARD_LIMIT_BYTES + 1 });
    const state: DeltaLaneState = { lagging: true };
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

  it('NO DESYNC end-to-end: healthy → shed → suppress → drain → ONE snapshot; client state == server state', () => {
    const ws = fakeSocket();
    const state: DeltaLaneState = { lagging: false };
    // Model the forwarder: a patch is applied to session state BEFORE deliverDelta
    // runs (handleAgentPatchV2), so the resync snapshot always reflects it.
    let serverN = 0;
    const apply = () => {
      serverN += 1;
    };
    const delta = () => `patch:${serverN}`;
    const snapshot = () => `snap:${serverN}`;

    // Healthy: every patch is delivered in order.
    ws.bufferedAmount = 0;
    apply();
    expect(deliverDelta(ws, state, delta, snapshot)).toBe('sent'); // p1
    apply();
    expect(deliverDelta(ws, state, delta, snapshot)).toBe('sent'); // p2
    expect(ws.sent).toEqual(['patch:1', 'patch:2']);

    // Stall above soft: the next patch is shed and the lane enters lagging.
    ws.bufferedAmount = WS_SOFT_LIMIT_BYTES + 1;
    apply();
    expect(deliverDelta(ws, state, delta, snapshot)).toBe('dropped'); // p3 shed
    expect(state.lagging).toBe(true);

    // Still lagging in the [low, soft] band: subsequent patches are SUPPRESSED —
    // NOT sent — so the client never applies a patch over the un-healed gap.
    ws.bufferedAmount = WS_SOFT_LIMIT_BYTES - 1;
    apply();
    expect(deliverDelta(ws, state, delta, snapshot)).toBe('dropped'); // p4 suppressed
    apply();
    expect(deliverDelta(ws, state, delta, snapshot)).toBe('dropped'); // p5 suppressed
    expect(ws.sent).toEqual(['patch:1', 'patch:2']); // no raw patch sent while lagging

    // Drain below low: exactly ONE resync snapshot reflecting ALL applied patches.
    ws.bufferedAmount = WS_LOW_LIMIT_BYTES - 1;
    apply();
    expect(deliverDelta(ws, state, delta, snapshot)).toBe('resync'); // p6
    expect(state.lagging).toBe(false);
    expect(ws.sent).toEqual(['patch:1', 'patch:2', 'snap:6']);

    // A client applying the received messages in order ends at the server state —
    // no desync, no double-apply (the snapshot supersedes the shed patches).
    let clientN = 0;
    for (const raw of ws.sent) {
      const [, n] = raw.split(':');
      clientN = Number(n);
    }
    expect(clientN).toBe(serverN); // 6
  });
});

// #1250 FIX 1: a shed terminal `data` envelope emitted nothing while the next
// (coarse or drained) envelope advanced the client's `Math.max` cursor PAST the
// shed range, so a `?cursor=` reconnect skipped it — silent, permanent output loss
// (and a split ANSI escape corrupts the xterm parser). The terminal lane now heals
// like the agent lane: suppress while lagging, replay the missed byte range from
// scrollback on drain, and never advance the client cursor past un-delivered bytes.
function terminalSubscriber(
  ws: FakeSocket,
  lane: TerminalLaneState,
  stream: TerminalStreamState
): (envelope: TerminalStreamEnvelope) => void {
  return (envelope) => {
    deliverTerminalEnvelope(
      ws,
      lane,
      {
        droppable: envelope.kind === 'data',
        gapStart:
          envelope.kind === 'data'
            ? envelope.payload.range.start
            : envelope.cursor,
        serialize: () => JSON.stringify(envelope),
      },
      (gapStartCursor) =>
        buildTerminalStreamReplay(stream, gapStartCursor).map((env) =>
          JSON.stringify(env)
        )
    );
  };
}

/**
 * Reconstruct what the browser client would render from the frames actually put on
 * the wire, applying the exact client logic (`terminalStreamCursor = Math.max(...)`
 * + `data` payload concatenation). `sawGap` is the no-silent-gap invariant: for a
 * stream that starts at cursor 0 with no FIFO truncation, the cursor must never
 * exceed the number of contiguous bytes the client has actually received.
 */
function reconstructClient(sent: string[]): {
  cursor: number;
  data: string;
  sawGap: boolean;
  lagSeen: boolean;
} {
  let cursor = 0;
  let data = '';
  let sawGap = false;
  let lagSeen = false;
  for (const raw of sent) {
    const env = JSON.parse(raw) as TerminalStreamEnvelope;
    cursor = Math.max(cursor, env.cursor);
    if (env.kind === 'data') data += env.payload.data;
    if (env.kind === 'lag') lagSeen = true;
    if (cursor > data.length) sawGap = true;
  }
  return { cursor, data, sawGap, lagSeen };
}

describe('#1250 deliverTerminalEnvelope — terminal gap-heal (no silent output loss)', () => {
  it('NO SILENT GAP: a lagging client that drains RECEIVES the missed byte range via resync (contiguous; cursor never jumps past delivered data)', () => {
    const stream = createTerminalStreamState({
      sessionId: 'sess-1',
      capacityBytes: 1_000_000,
    });
    const ws = fakeSocket();
    const lane: TerminalLaneState = { lagging: false, gapStartCursor: 0 };
    const deliver = terminalSubscriber(ws, lane, stream);
    const emit = (text: string) =>
      deliver(appendTerminalStreamData(stream, text));

    // Healthy: delivered.
    ws.bufferedAmount = 0;
    emit('AAAA'); // [0,4)
    expect(lane.lagging).toBe(false);

    // Stall above soft → next data shed; gap starts at the client cursor (4).
    ws.bufferedAmount = WS_SOFT_LIMIT_BYTES + 1;
    emit('BBBB'); // [4,8) shed
    expect(lane.lagging).toBe(true);
    expect(lane.gapStartCursor).toBe(4);

    // Still lagging in [low, soft]: further data suppressed — NOT sent.
    ws.bufferedAmount = WS_SOFT_LIMIT_BYTES - 1;
    emit('CCCC'); // [8,12) suppressed
    emit('DDDD'); // [12,16) suppressed

    // Drain below low → resync replays [4,20) contiguously from scrollback.
    ws.bufferedAmount = WS_LOW_LIMIT_BYTES - 1;
    emit('EEEE'); // [16,20) triggers resync
    expect(lane.lagging).toBe(false);

    const client = reconstructClient(ws.sent);
    expect(client.data).toBe('AAAABBBBCCCCDDDDEEEE'); // full output, no gap
    expect(client.cursor).toBe(stream.cursor); // caught up to head (20)
    expect(client.sawGap).toBe(false); // cursor never advanced past delivered bytes
  });

  it('HEALTHY CLIENT: a fast-draining terminal socket receives every data frame in order, never lags', () => {
    const stream = createTerminalStreamState({
      sessionId: 'sess-1',
      capacityBytes: 1_000_000,
    });
    const ws = fakeSocket(); // bufferedAmount stays 0
    const lane: TerminalLaneState = { lagging: false, gapStartCursor: 0 };
    const deliver = terminalSubscriber(ws, lane, stream);
    let expected = '';
    for (let i = 0; i < 200; i += 1) {
      const text = `f${i};`;
      expected += text;
      deliver(appendTerminalStreamData(stream, text));
    }
    expect(lane.lagging).toBe(false);
    const client = reconstructClient(ws.sent);
    expect(client.data).toBe(expected);
    expect(client.cursor).toBe(stream.cursor);
    expect(client.sawGap).toBe(false);
    expect(ws.closedWith).toBeNull();
  });

  it('UNAVOIDABLE TRUNCATION: when scrollback FIFO-trimmed the gap, resync starts at the oldest resident cursor and marks the loss with a `lag` envelope', () => {
    const stream = createTerminalStreamState({
      sessionId: 'sess-1',
      capacityBytes: 1024,
    });
    const ws = fakeSocket();
    const lane: TerminalLaneState = { lagging: false, gapStartCursor: 0 };
    const deliver = terminalSubscriber(ws, lane, stream);

    ws.bufferedAmount = 0;
    deliver(appendTerminalStreamData(stream, 'A'.repeat(100))); // [0,100)

    ws.bufferedAmount = WS_SOFT_LIMIT_BYTES + 1;
    deliver(appendTerminalStreamData(stream, 'B'.repeat(100))); // [100,200) shed
    expect(lane.gapStartCursor).toBe(100);

    // Produce enough while lagging to FIFO-trim past the gap start.
    ws.bufferedAmount = WS_SOFT_LIMIT_BYTES - 1;
    for (let i = 0; i < 30; i += 1) {
      deliver(appendTerminalStreamData(stream, 'C'.repeat(100)));
    }
    expect(stream.oldestCursor).toBeGreaterThan(100); // gap start trimmed away

    // Drain → resync from gapStart=100 clamps to oldestCursor and emits a lag.
    ws.bufferedAmount = WS_LOW_LIMIT_BYTES - 1;
    deliver(appendTerminalStreamData(stream, 'D'.repeat(10)));
    expect(lane.lagging).toBe(false);

    const client = reconstructClient(ws.sent);
    expect(client.lagSeen).toBe(true); // truncation surfaced, not hidden
    expect(client.cursor).toBe(stream.cursor); // client still catches up to head
  });

  it('BOUNDED GROWTH: a stalled terminal subscriber sheds then suppresses — queue stays bounded, socket not closed', () => {
    const stream = createTerminalStreamState({
      sessionId: 'sess-1',
      capacityBytes: 256 * 1024,
    });
    const ws = fakeSocket({ stalled: true });
    const lane: TerminalLaneState = { lagging: false, gapStartCursor: 0 };
    const deliver = terminalSubscriber(ws, lane, stream);
    for (let i = 0; i < 20_000; i += 1) {
      deliver(appendTerminalStreamData(stream, 'x'.repeat(1024)));
    }
    expect(ws.queuedBytes).toBeLessThan(WS_HARD_LIMIT_BYTES);
    expect(ws.bufferedAmount).toBeLessThanOrEqual(WS_SOFT_LIMIT_BYTES + 4096);
    expect(lane.lagging).toBe(true); // never drained below low → still healing
    expect(ws.closedWith).toBeNull(); // shed/suppressed, not closed — no churn
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
