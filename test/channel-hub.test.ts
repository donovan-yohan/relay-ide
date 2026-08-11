import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createChannelMessageStore,
  type ChannelMessageStore,
} from '../server/channel-message-store.js';
import {
  CHANNEL_WS_BACKPRESSURE_CLOSE_CODE,
  createChannelHub,
  type ChannelHub,
  type ChannelEventSink,
  type ChannelSocket,
} from '../server/channel-hub.js';
import {
  applyChannelEventV1,
  initialChannelReducerState,
  type ChannelEventV1,
  type ChannelSenderRef,
} from '../shared/channel-chat-protocol.js';

const cleanup: Array<() => void> = [];

afterEach(() => {
  vi.useRealTimers();
  while (cleanup.length > 0) cleanup.pop()?.();
});

const HUMAN: ChannelSenderRef = { kind: 'human', id: 'human:operator' };
const AGENT: ChannelSenderRef = {
  kind: 'agent',
  id: 'agent:claude',
  providerId: 'claude',
};

function store(): ChannelMessageStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-channel-hub-'));
  cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const s = createChannelMessageStore(path.join(dir, 'channel-chat.db'));
  cleanup.push(() => s.close());
  return s;
}

interface FakeSocket extends ChannelSocket {
  bufferedAmount: number;
  readyState: number;
  sent: ChannelEventV1[];
  closed: number | null;
  emit(event: 'close' | 'error'): void;
}

function fakeSocket(): FakeSocket {
  const handlers: Partial<Record<'close' | 'error', () => void>> = {};
  return {
    readyState: 1,
    bufferedAmount: 0,
    sent: [],
    closed: null,
    send(data: string) {
      this.sent.push(JSON.parse(data) as ChannelEventV1);
    },
    close(code?: number) {
      this.closed = code ?? 1000;
      this.readyState = 3;
    },
    on(event, handler) {
      handlers[event] = handler;
    },
    emit(event) {
      handlers[event]?.();
    },
  };
}

function fakeSink(): ChannelEventSink & {
  bufferedAmount: number;
  sent: ChannelEventV1[];
  closed: string | null;
  emitClose(): void;
} {
  const handlers: Array<() => void> = [];
  let ready = true;
  return {
    bufferedAmount: 0,
    get ready() {
      return ready;
    },
    sent: [],
    closed: null,
    send(event) {
      this.sent.push(event);
      return true;
    },
    close(reason) {
      this.closed = reason.code;
      ready = false;
      for (const handler of handlers) handler();
    },
    onClose(handler) {
      handlers.push(handler);
    },
    emitClose() {
      ready = false;
      for (const handler of handlers) handler();
    },
  };
}

function hubWith(
  s: ChannelMessageStore,
  opts: Partial<Parameters<typeof createChannelHub>[0]> = {}
): ChannelHub {
  const hub = createChannelHub({
    store: s,
    channelExists: () => true,
    ...opts,
  });
  cleanup.push(() => hub.close());
  return hub;
}

describe('channel-hub fan-out', () => {
  it('bounds the connect-time live queue and relies on durable reconnect catch-up', () => {
    const s = store();
    const hub = hubWith(s, { connectQueueMaxEvents: 3 });
    const sock = fakeSocket();
    const ordinarySend = sock.send;
    let injected = false;
    sock.send = function (data: string) {
      ordinarySend.call(this, data);
      if (injected) return;
      injected = true;
      // Re-entrant delivery is a defense-in-depth stand-in for live traffic at
      // the snapshot boundary. The fourth queued event must close, not retain.
      for (let index = 0; index < 4; index++) {
        const message = s.appendComplete({
          channelId: 'topic:c',
          sender: HUMAN,
          text: `queued-${index}`,
        });
        hub.broadcastCreated(message);
      }
    };

    hub.handleConnection(sock, { channelId: 'topic:c', sinceSeq: null });

    expect(sock.closed).toBe(CHANNEL_WS_BACKPRESSURE_CLOSE_CODE);
    expect(hub.subscriberCount('topic:c')).toBe(0);
    expect(s.latestSeq('topic:c')).toBe(4); // reconnect can replay every row
  });

  it('closes when cumulative connect-queue bytes exceed the cap below the event cap', () => {
    const s = store();
    const messages = [0, 1].map((index) =>
      s.appendComplete({
        channelId: 'topic:c',
        sender: HUMAN,
        text: `${index}-${'x'.repeat(512)}`,
      })
    );
    const eventBytes = messages.map((message) =>
      Buffer.byteLength(
        JSON.stringify({
          type: 'channel-message-created-v1',
          channelId: 'topic:c',
          timestamp: '2026-01-01T00:00:00.000Z',
          message,
        }),
        'utf8'
      )
    );
    const hub = hubWith(s, {
      connectQueueMaxEvents: 10,
      connectQueueMaxBytes: eventBytes[0]! + eventBytes[1]! - 1,
    });
    const sock = fakeSocket();
    const ordinarySend = sock.send;
    let injected = false;
    sock.send = function (data: string) {
      ordinarySend.call(this, data);
      if (injected) return;
      injected = true;
      for (const message of messages) hub.broadcastCreated(message);
    };

    hub.handleConnection(sock, { channelId: 'topic:c', sinceSeq: null });

    expect(sock.closed).toBe(CHANNEL_WS_BACKPRESSURE_CLOSE_CODE);
    expect(hub.subscriberCount('topic:c')).toBe(0);
  });

  it('resets connect-queue byte accounting after a successful snapshot flush', () => {
    const s = store();
    const messages = [0, 1].map((index) =>
      s.appendComplete({
        channelId: 'topic:c',
        sender: HUMAN,
        text: `${index}-${'x'.repeat(128)}`,
      })
    );
    const exactQueueBytes = messages.reduce(
      (total, message) =>
        total +
        Buffer.byteLength(
          JSON.stringify({
            type: 'channel-message-created-v1',
            channelId: 'topic:c',
            timestamp: '2026-01-01T00:00:00.000Z',
            message,
          }),
          'utf8'
        ),
      0
    );
    const hub = hubWith(s, {
      connectQueueMaxEvents: 10,
      connectQueueMaxBytes: exactQueueBytes,
    });
    const sock = fakeSocket();
    const ordinarySend = sock.send;
    let injected = false;
    sock.send = function (data: string) {
      ordinarySend.call(this, data);
      if (injected) return;
      injected = true;
      for (const message of messages) hub.broadcastCreated(message);
    };

    hub.handleConnection(sock, { channelId: 'topic:c', sinceSeq: null });

    expect(sock.closed).toBeNull();
    expect(hub.retentionSnapshot()).toEqual({
      connectQueueEvents: 0,
      connectQueueBytes: 0,
    });
  });

  it('delivers a committed post to every subscriber', () => {
    const s = store();
    const hub = hubWith(s);
    const a = fakeSocket();
    const b = fakeSocket();
    hub.handleConnection(a, { channelId: 'topic:c', sinceSeq: null });
    hub.handleConnection(b, { channelId: 'topic:c', sinceSeq: null });
    expect(a.sent[0]?.type).toBe('channel-snapshot-v1');

    const msg = s.appendComplete({
      channelId: 'topic:c',
      sender: HUMAN,
      text: 'hi',
    });
    hub.broadcastCreated(msg);
    for (const sock of [a, b]) {
      expect(
        sock.sent.some((e) => e.type === 'channel-message-created-v1')
      ).toBe(true);
    }
  });

  it('debounces persisted card rows and transports the latest Codex-shaped update through the reducer', () => {
    vi.useFakeTimers();
    const s = store();
    const hub = hubWith(s, { coalesceMs: 50 });
    const sock = fakeSocket();
    hub.handleConnection(sock, { channelId: 'topic:c', sinceSeq: null });
    const started = s.beginStream({
      channelId: 'topic:c',
      sender: { kind: 'agent', id: 'agent:codex', providerId: 'codex' },
      source: {
        runtimeId: 'runtime_synthetic_codex',
        turnId: 'turn_synthetic_codex',
        itemId: 'reason_synthetic_codex',
      },
      agentDetail: {
        itemId: 'reason_synthetic_codex',
        card: { kind: 'thought', title: 'thinking', status: 'running' },
      },
    });
    hub.beginStreamBroadcast(started);
    const partial = s.updateAgentDetail(started.id, {
      itemId: 'reason_synthetic_codex',
      card: {
        kind: 'thought',
        title: 'thinking',
        status: 'running',
        content: 'Codex synthetic thought: verify the reducer',
      },
    })!;
    hub.updateStreamBroadcast(partial);
    const latest = s.updateAgentDetail(started.id, {
      itemId: 'reason_synthetic_codex',
      card: {
        kind: 'thought',
        title: 'thinking',
        status: 'running',
        content:
          'Codex synthetic thought: verify the reducer contract before applying the patch.',
      },
    })!;
    hub.updateStreamBroadcast(latest);

    expect(
      sock.sent.filter((event) => event.type === 'channel-message-updated-v1')
    ).toHaveLength(0);
    vi.advanceTimersByTime(50);
    const updates = sock.sent.filter(
      (event) => event.type === 'channel-message-updated-v1'
    );
    expect(updates).toHaveLength(1);

    let state = initialChannelReducerState('topic:c');
    for (const event of sock.sent) state = applyChannelEventV1(state, event);
    expect(state.byId[started.id]?.agentDetail?.card.content).toBe(
      latest.agentDetail?.card.content
    );
    expect(state.needsCatchup).toBe(false);
  });

  it('serves (sinceSeq, head] then live with seq continuity across the boundary', () => {
    const s = store();
    for (let i = 1; i <= 3; i++) {
      s.appendComplete({ channelId: 'topic:c', sender: HUMAN, text: `m${i}` });
    }
    const hub = hubWith(s);
    const sock = fakeSocket();
    hub.handleConnection(sock, { channelId: 'topic:c', sinceSeq: 1 });
    const snap = sock.sent[0];
    expect(snap?.type).toBe('channel-snapshot-v1');
    if (snap?.type !== 'channel-snapshot-v1')
      throw new Error('expected snapshot');
    expect(snap.mode).toBe('catchup');
    expect(snap.messages.map((m) => m.seq)).toEqual([2, 3]);

    const m4 = s.appendComplete({
      channelId: 'topic:c',
      sender: HUMAN,
      text: 'm4',
    });
    hub.broadcastCreated(m4);
    const created = sock.sent.find(
      (e) => e.type === 'channel-message-created-v1'
    );
    if (created?.type !== 'channel-message-created-v1')
      throw new Error('expected created');
    expect(created.message.seq).toBe(4); // no dup, no gap after snapshot head (3)
  });

  it('falls back to a full snapshot when the catch-up gap exceeds 500 rows', () => {
    const s = store();
    for (let i = 0; i < 510; i++) {
      s.appendComplete({ channelId: 'topic:c', sender: HUMAN, text: `m${i}` });
    }
    const hub = hubWith(s);
    const sock = fakeSocket();
    hub.handleConnection(sock, { channelId: 'topic:c', sinceSeq: 1 });
    const snap = sock.sent[0];
    if (snap?.type !== 'channel-snapshot-v1')
      throw new Error('expected snapshot');
    expect(snap.mode).toBe('full');
    expect(snap.messages).toHaveLength(100);
  });

  it('coalesces a burst of deltas into one event per tick with incrementing deltaIndex', () => {
    vi.useFakeTimers();
    const s = store();
    const hub = hubWith(s, { coalesceMs: 50 });
    const streaming = s.beginStream({
      channelId: 'topic:c',
      sender: AGENT,
      source: { runtimeId: 'runtime' },
    });
    const sock = fakeSocket();
    hub.handleConnection(sock, { channelId: 'topic:c', sinceSeq: null });
    hub.beginStreamBroadcast(streaming);

    hub.pushDelta(streaming.id, 'a');
    hub.pushDelta(streaming.id, 'b');
    vi.advanceTimersByTime(50);
    let deltas = sock.sent.filter((e) => e.type === 'channel-message-delta-v1');
    expect(deltas).toHaveLength(1);
    expect(deltas[0]).toMatchObject({ deltaIndex: 0, delta: { text: 'ab' } });

    hub.pushDelta(streaming.id, 'c');
    vi.advanceTimersByTime(50);
    deltas = sock.sent.filter((e) => e.type === 'channel-message-delta-v1');
    expect(
      deltas.map((d) =>
        d.type === 'channel-message-delta-v1' ? d.deltaIndex : -1
      )
    ).toEqual([0, 1]);
  });

  it('dedupes stream deltas by messageId + deltaIndex across the snapshot boundary', () => {
    vi.useFakeTimers();
    const s = store();
    const hub = hubWith(s, { coalesceMs: 10 });
    const streaming = s.beginStream({
      channelId: 'topic:c',
      sender: AGENT,
      source: { runtimeId: 'runtime' },
    });
    hub.beginStreamBroadcast(streaming);
    hub.pushDelta(streaming.id, 'hello');
    vi.advanceTimersByTime(10); // flush idx 0 (no subscribers yet)

    const late = fakeSocket();
    hub.handleConnection(late, { channelId: 'topic:c', sinceSeq: null });
    const snap = late.sent[0];
    if (snap?.type !== 'channel-snapshot-v1')
      throw new Error('expected snapshot');
    expect(snap.inFlight).toEqual([{ messageId: streaming.id, deltaIndex: 0 }]);
    const overlaid = snap.messages.find((m) => m.id === streaming.id);
    expect(overlaid?.body.text).toBe('hello'); // in-memory text overlaid on DB lag

    hub.pushDelta(streaming.id, ' world');
    vi.advanceTimersByTime(10); // flush idx 1
    const deltas = late.sent
      .filter((e) => e.type === 'channel-message-delta-v1')
      .map((d) => (d.type === 'channel-message-delta-v1' ? d.deltaIndex : -1));
    expect(deltas).toEqual([1]); // idx 0 was in the snapshot, never re-sent live
  });
});

describe('channel-hub snapshot correctness', () => {
  it('does not duplicate pending accumulator text for a subscriber that connects mid-coalesce window', () => {
    vi.useFakeTimers();
    const s = store();
    const hub = hubWith(s, { coalesceMs: 50 });
    const streaming = s.beginStream({
      channelId: 'topic:c',
      sender: AGENT,
      source: { runtimeId: 'runtime' },
    });
    hub.beginStreamBroadcast(streaming);

    // idx 0 flushed with no subscribers connected.
    hub.pushDelta(streaming.id, 'Hello ');
    vi.advanceTimersByTime(50);

    // Second delta is PENDING (timer armed, not yet fired) when the subscriber
    // connects — this is the coalesce window the finding exploits.
    hub.pushDelta(streaming.id, 'world');
    const sock = fakeSocket();
    hub.handleConnection(sock, { channelId: 'topic:c', sinceSeq: null });

    let applied = 0;
    let state = initialChannelReducerState('topic:c');
    const drain = (): void => {
      while (applied < sock.sent.length) {
        state = applyChannelEventV1(state, sock.sent[applied++]!);
      }
    };
    drain(); // snapshot (the queued flush delta is deduped away at connect)

    // Fire the pending window. Without the fix a duplicate 'world' delta lands
    // here and the reducer appends it a second time.
    vi.advanceTimersByTime(50);
    drain();

    const row = state.byId[streaming.id];
    expect(row?.body.text).toBe('Hello world'); // exact, not 'Hello worldworld'
    expect(state.needsCatchup).toBe(false);
    expect(state.quarantined[streaming.id]).toBeUndefined();
  });

  it('heals a stream that finalized while the client was disconnected on reconnect', () => {
    const s = store();
    const hub = hubWith(s);
    const streaming = s.beginStream({
      channelId: 'topic:c',
      sender: AGENT,
      source: { runtimeId: 'runtime', turnId: 't1', itemId: 'a1' },
      text: 'partial',
    });
    hub.beginStreamBroadcast(streaming);

    // Client sees the streaming row, then disconnects.
    const first = fakeSocket();
    hub.handleConnection(first, { channelId: 'topic:c', sinceSeq: null });
    let state = initialChannelReducerState('topic:c');
    for (const e of first.sent) state = applyChannelEventV1(state, e);
    expect(state.byId[streaming.id]?.status).toBe('streaming');
    first.emit('close');

    // Stream finalizes WHILE the client is gone (no new seq allocated).
    const finalMsg = s.finalizeStream(streaming.id, {
      text: 'partial answer',
      status: 'truncated',
      truncationReason: 'missing-terminal',
    });
    hub.completeStreamBroadcast(finalMsg!);

    // Reconnect with the stale cursor (== latestSeq → catch-up, gap 0).
    const reconnect = fakeSocket();
    hub.handleConnection(reconnect, {
      channelId: 'topic:c',
      sinceSeq: state.lastSeq,
    });
    for (const e of reconnect.sent) state = applyChannelEventV1(state, e);

    const row = state.byId[streaming.id];
    expect(row?.status).toBe('truncated'); // no permanently stuck streaming row
    expect(row?.body.text).toBe('partial answer');
    expect(row?.meta).toEqual({ truncationReason: 'missing-terminal' });
    expect(row?.truncated).toBeUndefined();
    expect(state.needsCatchup).toBe(false);
  });

  it('prioritizes a fresh row over resync rows that exceed the default 4MB catch-up budget', () => {
    const s = store();
    const resyncText = 'r'.repeat(10 * 1024);
    for (let index = 0; index < 500; index++) {
      s.appendComplete({
        channelId: 'topic:c',
        sender: AGENT,
        source: { runtimeId: `resync-${index}` },
        text: resyncText,
      });
    }
    const sinceSeq = s.latestSeq('topic:c');
    const fresh = s.appendComplete({
      channelId: 'topic:c',
      sender: HUMAN,
      text: 'fresh after reconnect',
    });
    expect(
      Buffer.byteLength(
        JSON.stringify(s.listResyncRows('topic:c', sinceSeq, 500)),
        'utf8'
      )
    ).toBeGreaterThan(4 * 1024 * 1024);

    const hub = hubWith(s); // default 4MB budget
    const sock = fakeSocket();
    hub.handleConnection(sock, { channelId: 'topic:c', sinceSeq });
    const snap = sock.sent[0];
    if (snap?.type !== 'channel-snapshot-v1')
      throw new Error('expected snapshot');

    expect(snap.truncated).toBe(true);
    expect(snap.messages.some((message) => message.id === fresh.id)).toBe(true);
    expect(snap.latestSeq).toBe(fresh.seq);
    expect(
      snap.messages.reduce(
        (total, message) =>
          total + Buffer.byteLength(JSON.stringify(message), 'utf8') + 1,
        0
      )
    ).toBeLessThanOrEqual(4 * 1024 * 1024);
    let state = {
      ...initialChannelReducerState('topic:c'),
      lastSeq: sinceSeq,
    };
    state = applyChannelEventV1(state, snap);
    expect(state.lastSeq).toBe(fresh.seq);
    expect(state.needsCatchup).toBe(false);
  });

  it('trims resync rows nearest the cursor while emitting them in ascending sequence order', () => {
    const s = store();
    for (let index = 0; index < 4; index++) {
      s.appendComplete({
        channelId: 'topic:c',
        sender: AGENT,
        source: { runtimeId: `resync-${index}` },
        text: 'r'.repeat(1_000),
      });
    }
    const sinceSeq = s.latestSeq('topic:c');
    const resync = s.listResyncRows('topic:c', sinceSeq, 500);
    const snapshotMaxBytes = resync
      .slice(-2)
      .reduce(
        (total, message) =>
          total + Buffer.byteLength(JSON.stringify(message), 'utf8') + 1,
        0
      );
    const hub = hubWith(s, { snapshotMaxBytes });
    const sock = fakeSocket();
    hub.handleConnection(sock, { channelId: 'topic:c', sinceSeq });
    const snap = sock.sent[0];
    if (snap?.type !== 'channel-snapshot-v1')
      throw new Error('expected snapshot');

    expect(snap.truncated).toBe(true);
    expect(snap.messages.map((message) => message.seq)).toEqual([3, 4]);
    expect(snap.latestSeq).toBe(4);
  });

  it('keeps a contiguous fresh prefix and cursor at its end when fresh rows overflow the budget', () => {
    const s = store();
    s.appendComplete({
      channelId: 'topic:c',
      sender: AGENT,
      source: { runtimeId: 'resync' },
      text: 'resync',
    });
    const sinceSeq = s.latestSeq('topic:c');
    const fresh = [0, 1, 2].map((index) =>
      s.appendComplete({
        channelId: 'topic:c',
        sender: HUMAN,
        text: `fresh-${index}-${'f'.repeat(1_000)}`,
      })
    );
    const snapshotMaxBytes = fresh
      .slice(0, 2)
      .reduce(
        (total, message) =>
          total + Buffer.byteLength(JSON.stringify(message), 'utf8') + 1,
        0
      );
    const hub = hubWith(s, { snapshotMaxBytes });
    const sock = fakeSocket();
    hub.handleConnection(sock, { channelId: 'topic:c', sinceSeq });
    const snap = sock.sent[0];
    if (snap?.type !== 'channel-snapshot-v1')
      throw new Error('expected snapshot');

    expect(snap.truncated).toBe(true);
    expect(snap.messages.map((message) => message.seq)).toEqual(
      fresh.slice(0, 2).map((message) => message.seq)
    );
    expect(snap.latestSeq).toBe(fresh[1]!.seq);
    let state = {
      ...initialChannelReducerState('topic:c'),
      lastSeq: sinceSeq,
    };
    state = applyChannelEventV1(state, snap);
    expect(state.lastSeq).toBe(fresh[1]!.seq);
    expect(state.needsCatchup).toBe(false);
  });

  it('keeps only fresh rows when one exactly fills the catch-up budget remainder', () => {
    const s = store();
    s.appendComplete({
      channelId: 'topic:c',
      sender: AGENT,
      source: { runtimeId: 'resync' },
      text: 'resync',
    });
    const sinceSeq = s.latestSeq('topic:c');
    const fresh = s.appendComplete({
      channelId: 'topic:c',
      sender: HUMAN,
      text: 'fresh',
    });
    const snapshotMaxBytes =
      Buffer.byteLength(JSON.stringify(fresh), 'utf8') + 1;
    const hub = hubWith(s, { snapshotMaxBytes });
    const sock = fakeSocket();
    hub.handleConnection(sock, { channelId: 'topic:c', sinceSeq });
    const snap = sock.sent[0];
    if (snap?.type !== 'channel-snapshot-v1')
      throw new Error('expected snapshot');

    expect(snap.truncated).toBe(true);
    expect(snap.messages.map((message) => message.id)).toEqual([fresh.id]);
    expect(
      snap.messages.reduce(
        (total, message) =>
          total + Buffer.byteLength(JSON.stringify(message), 'utf8') + 1,
        0
      )
    ).toBeLessThanOrEqual(snapshotMaxBytes);
  });

  it('keeps an under-budget resync plus fresh catch-up complete and ascending', () => {
    const s = store();
    for (let index = 0; index < 2; index++) {
      s.appendComplete({
        channelId: 'topic:c',
        sender: AGENT,
        source: { runtimeId: `resync-${index}` },
        text: `resync-${index}`,
      });
    }
    const sinceSeq = s.latestSeq('topic:c');
    s.appendComplete({ channelId: 'topic:c', sender: HUMAN, text: 'fresh-1' });
    const fresh = s.appendComplete({
      channelId: 'topic:c',
      sender: HUMAN,
      text: 'fresh-2',
    });
    const hub = hubWith(s);
    const sock = fakeSocket();
    hub.handleConnection(sock, { channelId: 'topic:c', sinceSeq });
    const snap = sock.sent[0];
    if (snap?.type !== 'channel-snapshot-v1')
      throw new Error('expected snapshot');

    expect(snap.mode).toBe('catchup');
    expect(snap.truncated).toBe(false);
    expect(snap.latestSeq).toBe(fresh.seq);
    expect(snap.messages.map((message) => message.seq)).toEqual([1, 2, 3, 4]);
  });

  it('forces a full snapshot (client reset) when the cursor is ahead of the server head', () => {
    const s = store();
    for (let i = 1; i <= 3; i++) {
      s.appendComplete({ channelId: 'topic:c', sender: HUMAN, text: `m${i}` });
    }
    const hub = hubWith(s);

    // Simulate a client that synced far ahead (seq 999) before a rollback shrank
    // the server head back to 3.
    let state = initialChannelReducerState('topic:c');
    state = applyChannelEventV1(state, {
      type: 'channel-snapshot-v1',
      channelId: 'topic:c',
      timestamp: 't',
      mode: 'full',
      messages: [],
      members: [],
      latestSeq: 999,
      inFlight: [],
      truncated: false,
    });
    expect(state.lastSeq).toBe(999);

    const sock = fakeSocket();
    hub.handleConnection(sock, { channelId: 'topic:c', sinceSeq: 999 });
    const snap = sock.sent[0];
    if (snap?.type !== 'channel-snapshot-v1')
      throw new Error('expected snapshot');
    expect(snap.mode).toBe('full'); // reset, not a silent empty catch-up
    expect(snap.latestSeq).toBe(3);

    // Reducer resets to head; a subsequent message is no longer dropped as replay.
    state = applyChannelEventV1(state, snap);
    expect(state.lastSeq).toBe(3);
    const m4 = s.appendComplete({
      channelId: 'topic:c',
      sender: HUMAN,
      text: 'm4',
    });
    hub.broadcastCreated(m4);
    for (const e of sock.sent.slice(1)) state = applyChannelEventV1(state, e);
    expect(state.byId[m4.id]).toBeDefined();
    expect(state.lastSeq).toBe(4);
  });

  it('byte-budgets a full snapshot and flags truncated', () => {
    const s = store();
    const body = 'x'.repeat(2000);
    for (let i = 0; i < 20; i++) {
      s.appendComplete({ channelId: 'topic:c', sender: HUMAN, text: body });
    }
    // ~8KB budget → only a few of the 2KB+ rows fit.
    const hub = hubWith(s, { snapshotMaxBytes: 8 * 1000 });
    const sock = fakeSocket();
    hub.handleConnection(sock, { channelId: 'topic:c', sinceSeq: null });
    const snap = sock.sent[0];
    if (snap?.type !== 'channel-snapshot-v1')
      throw new Error('expected snapshot');
    expect(snap.truncated).toBe(true);
    expect(snap.messages.length).toBeGreaterThan(0);
    expect(snap.messages.length).toBeLessThan(20); // stopped before all rows
    const bytes = Buffer.byteLength(JSON.stringify(snap.messages), 'utf8');
    expect(bytes).toBeLessThanOrEqual(8 * 1000 + 2500);
    // Full snapshot keeps the newest rows (tail).
    expect(snap.messages[snap.messages.length - 1]?.seq).toBe(20);
  });
});

describe('channel-hub backpressure', () => {
  it('suppresses deltas over the watermark, keeps durable events, resyncs on drain, and recovers', () => {
    vi.useFakeTimers();
    const s = store();
    const hub = hubWith(s, { coalesceMs: 5 });
    const streaming = s.beginStream({
      channelId: 'topic:c',
      sender: AGENT,
      source: { runtimeId: 'runtime' },
    });
    const sock = fakeSocket();
    hub.handleConnection(sock, { channelId: 'topic:c', sinceSeq: null });
    hub.beginStreamBroadcast(streaming);
    sock.sent.length = 0;

    // Over the 1MB high watermark → deltas suppressed.
    sock.bufferedAmount = 2 * 1024 * 1024;
    hub.pushDelta(streaming.id, 'x');
    vi.advanceTimersByTime(5);
    expect(
      sock.sent.filter((e) => e.type === 'channel-message-delta-v1')
    ).toHaveLength(0);

    // Durable events are always delivered even while lagging.
    hub.broadcastCreated(
      s.appendComplete({ channelId: 'topic:c', sender: HUMAN, text: 'durable' })
    );
    expect(sock.sent.some((e) => e.type === 'channel-message-created-v1')).toBe(
      true
    );

    // Drain below 256KB → the next deliver emits a resync.
    sock.bufferedAmount = 100 * 1024;
    hub.broadcastCreated(
      s.appendComplete({
        channelId: 'topic:c',
        sender: HUMAN,
        text: 'durable2',
      })
    );
    expect(sock.sent.some((e) => e.type === 'channel-resync-required-v1')).toBe(
      true
    );

    // Recovered: subsequent deltas are delivered again.
    hub.pushDelta(streaming.id, 'y');
    vi.advanceTimersByTime(5);
    expect(sock.sent.some((e) => e.type === 'channel-message-delta-v1')).toBe(
      true
    );
  });

  it('closes the socket with 4409 on sustained overflow', () => {
    vi.useFakeTimers();
    const s = store();
    const hub = hubWith(s, { coalesceMs: 5 });
    const streaming = s.beginStream({
      channelId: 'topic:c',
      sender: AGENT,
      source: { runtimeId: 'runtime' },
    });
    const sock = fakeSocket();
    hub.handleConnection(sock, { channelId: 'topic:c', sinceSeq: null });
    hub.beginStreamBroadcast(streaming);

    sock.bufferedAmount = 5 * 1024 * 1024;
    hub.pushDelta(streaming.id, 'z');
    vi.advanceTimersByTime(5);
    expect(sock.closed).toBe(4409);
    expect(hub.subscriberCount('topic:c')).toBe(0);
  });
});

describe('channel-hub connection lifecycle', () => {
  it('shares the register-before-replay handoff with a non-WebSocket sink', () => {
    const s = store();
    const hub = hubWith(s);
    const initial = s.appendComplete({
      channelId: 'topic:c',
      sender: HUMAN,
      text: 'before',
    });
    const sink = fakeSink();
    const originalSend = sink.send;
    let injected = false;
    sink.send = function (event) {
      const accepted = originalSend.call(this, event);
      if (injected || event.type !== 'channel-snapshot-v1') return accepted;
      injected = true;
      const committedDuringReplay = s.appendComplete({
        channelId: 'topic:c',
        sender: HUMAN,
        text: 'during',
      });
      hub.broadcastCreated(committedDuringReplay);
      return accepted;
    };

    const unsubscribe = hub.subscribe(sink, {
      channelId: 'topic:c',
      afterSeq: 0,
    });

    expect(sink.sent[0]).toMatchObject({
      type: 'channel-snapshot-v1',
      latestSeq: initial.seq,
    });
    expect(
      sink.sent.filter(
        (event) =>
          event.type === 'channel-message-created-v1' &&
          event.message.body.text === 'during'
      )
    ).toHaveLength(1);
    expect(hub.subscriberCount('topic:c')).toBe(1);
    unsubscribe();
    expect(hub.subscriberCount('topic:c')).toBe(0);
  });

  it('closes unknown channels with 4404', () => {
    const s = store();
    const hub = hubWith(s, { channelExists: () => false });
    const sock = fakeSocket();
    hub.handleConnection(sock, { channelId: 'topic:missing', sinceSeq: null });
    expect(sock.closed).toBe(4404);
  });

  it('removes a subscriber on disconnect', () => {
    const s = store();
    const hub = hubWith(s);
    const sock = fakeSocket();
    hub.handleConnection(sock, { channelId: 'topic:c', sinceSeq: null });
    expect(hub.subscriberCount('topic:c')).toBe(1);
    sock.emit('close');
    expect(hub.subscriberCount('topic:c')).toBe(0);
  });

  it('emits a channel-activity badge on committed posts', () => {
    const s = store();
    const badges: Array<{ type: string; data: Record<string, unknown> }> = [];
    const hub = hubWith(s, {
      badgeBroadcaster: (type, data) => badges.push({ type, data }),
    });
    hub.broadcastCreated(
      s.appendComplete({ channelId: 'topic:c', sender: HUMAN, text: 'hi' })
    );
    expect(badges).toContainEqual({
      type: 'channel-activity',
      data: { channelId: 'topic:c', latestSeq: 1 },
    });
  });
});
