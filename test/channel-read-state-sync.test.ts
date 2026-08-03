// @vitest-environment happy-dom

// Cross-device read sync, client half (#1308 slice 3 item 2).
//
// The invariant under test is that the hub is a point of CONVERGENCE and never a
// source of truth: localStorage stays the fast path, every hub-sourced mark is
// merged monotonic-up, and the one case where "up" is the wrong direction — the
// #1178 recreated-DM clamp — is fenced by the clamp epoch rather than trusted to
// the hub. See docs/LEARNINGS.md L-20260729-client-derived-unread.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  channelLastReadKey,
  clearPendingReadStatePushesForTests,
  hasUnseenActivity,
  useChannelActivityStore,
} from '../frontend/src/lib/stores/channel-activity.js';

/** Shape of a stubbed `fetch` call, narrowed for the assertions below. */
interface CapturedRequest {
  url: string;
  method?: string;
  keepalive?: boolean;
  headers: Record<string, string>;
  body: { lastReadSeq?: number };
}

let fetchMock: ReturnType<typeof vi.fn>;

function requests(): CapturedRequest[] {
  return fetchMock.mock.calls.map((call) => {
    const [url, init] = call as [string, RequestInit];
    return {
      url,
      method: init?.method,
      keepalive: (init as { keepalive?: boolean } | undefined)?.keepalive,
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : {},
    };
  });
}

function store(): ReturnType<typeof useChannelActivityStore.getState> {
  return useChannelActivityStore.getState();
}

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  clearPendingReadStatePushesForTests();
  useChannelActivityStore.setState({
    latestSeqByChannel: {},
    lastReadByChannel: {},
    clampedAtByChannel: {},
  });
  fetchMock = vi.fn(
    async () =>
      ({ ok: true, status: 200, json: async () => ({}) }) as unknown as Response
  );
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  clearPendingReadStatePushesForTests();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('hub read-state merge (#1308 slice 3)', () => {
  it('takes MAX(local, hub) per channel, reading the localStorage marker a cold boot has not loaded yet', () => {
    // Cold-boot shape: the reactive store is empty, the real marker is in
    // localStorage. Comparing only against the store would let the hub's older
    // mark win and relight a channel the operator has already read to 40.
    localStorage.setItem(channelLastReadKey('topic:cold'), '40');
    store().markChannelRead('topic:hot', 30);

    store().mergeReadState(
      [
        { channelId: 'topic:cold', lastReadSeq: 12 },
        { channelId: 'topic:hot', lastReadSeq: 5 },
        { channelId: 'topic:elsewhere', lastReadSeq: 9 },
      ],
      Date.now()
    );

    const merged = store();
    // Hub ahead → adopted, in BOTH halves: the store answers this render and
    // localStorage has to answer the next reload.
    expect(merged.lastReadByChannel['topic:elsewhere']).toBe(9);
    expect(localStorage.getItem(channelLastReadKey('topic:elsewhere'))).toBe(
      '9'
    );
    // Hub behind → refused. Neither half moves down.
    expect(merged.lastReadByChannel['topic:hot']).toBe(30);
    expect(localStorage.getItem(channelLastReadKey('topic:cold'))).toBe('40');

    // The decisive one: a channel whose local mark lived only in localStorage
    // must not report unread for messages the operator has already read.
    expect(
      hasUnseenActivity('topic:cold', null, {
        latestSeq: 20,
        lastRead: merged.lastReadByChannel['topic:cold'],
      })
    ).toBe(false);
    expect(
      hasUnseenActivity('topic:elsewhere', null, {
        latestSeq: 20,
        lastRead: merged.lastReadByChannel['topic:elsewhere'],
      })
    ).toBe(true);
  });

  it('refuses a hub payload fetched before a clamp, then accepts one fetched after (#1178 fence)', () => {
    // A DM deleted and recreated under the same deterministic id restarts its
    // seq low. Both the head seq and the read mark have to come DOWN — the one
    // direction monotonic-up merging cannot express.
    store().recordActivity('topic:dm', 50);
    store().markChannelRead('topic:dm', 40);
    const staleFetchedAt = Date.now() - 1;

    store().clampChannelStores('topic:dm', 5);
    expect(store().lastReadByChannel['topic:dm']).toBe(5);
    // The mark this device just retracted must not still be in flight to the
    // hub, where it would be handed straight back to every other device.
    vi.advanceTimersByTime(10_000);
    expect(fetchMock).not.toHaveBeenCalled();

    // The boot payload the rail already had in flight still describes the
    // channel's previous life.
    store().mergeReadState(
      [{ channelId: 'topic:dm', lastReadSeq: 40 }],
      staleFetchedAt
    );
    expect(store().lastReadByChannel['topic:dm']).toBe(5);
    expect(localStorage.getItem(channelLastReadKey('topic:dm'))).toBe('5');
    expect(
      hasUnseenActivity('topic:dm', null, {
        latestSeq: 6,
        lastRead: store().lastReadByChannel['topic:dm'],
      })
    ).toBe(true);
    // Fenced out means fenced out in both directions: no push-back either, or
    // the fence would leak the pre-clamp position back to the hub anyway.
    vi.advanceTimersByTime(10_000);
    expect(fetchMock).not.toHaveBeenCalled();

    // A payload fetched after the clamp is authoritative again.
    store().mergeReadState(
      [{ channelId: 'topic:dm', lastReadSeq: 6 }],
      Date.now() + 1_000
    );
    expect(store().lastReadByChannel['topic:dm']).toBe(6);
    expect(
      hasUnseenActivity('topic:dm', null, {
        latestSeq: 6,
        lastRead: store().lastReadByChannel['topic:dm'],
      })
    ).toBe(false);
  });

  it('re-pushes the local mark when the boot payload shows the hub behind, and stays quiet when it agrees', () => {
    // This is the whole retry policy: a push that failed leaves the hub holding
    // an older mark, and the next boot merge notices and re-sends. No timer, no
    // queue that has to survive a reload.
    localStorage.setItem(channelLastReadKey('topic:alpha'), '40');

    store().mergeReadState(
      [{ channelId: 'topic:alpha', lastReadSeq: 12 }],
      Date.now()
    );
    vi.advanceTimersByTime(3_000);
    expect(requests()).toHaveLength(1);
    expect(requests()[0]?.body.lastReadSeq).toBe(40);

    fetchMock.mockClear();
    store().mergeReadState(
      [{ channelId: 'topic:alpha', lastReadSeq: 40 }],
      Date.now()
    );
    vi.advanceTimersByTime(3_000);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('read-state push (#1308 slice 3)', () => {
  it('coalesces a burst of marks into one PUT carrying the final seq', () => {
    store().markChannelRead('topic:alpha', 4);
    vi.advanceTimersByTime(1_000);
    store().markChannelRead('topic:alpha', 9);
    vi.advanceTimersByTime(1_000);
    store().markChannelRead('topic:alpha', 11);
    // Still inside the window: reading a channel must not cost a request per
    // mark, and ChannelView writes on both unmount and focus loss.
    expect(fetchMock).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1_000);
    const sent = requests();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toBe('/channels/topic%3Aalpha/read-state');
    expect(sent[0]?.method).toBe('PUT');
    expect(sent[0]?.body).toEqual({ lastReadSeq: 11 });
    expect(sent[0]?.headers['x-relay-capabilities']).toBe('context:write');
    // Not a teardown, so no keepalive: the browser is free to treat this as an
    // ordinary cancellable request.
    expect(sent[0]?.keepalive).toBe(false);

    // The window is trailing, not resetting — it fired one window after the
    // FIRST mark, and a later mark arms a fresh one.
    store().markChannelRead('topic:alpha', 12);
    vi.advanceTimersByTime(3_000);
    expect(requests()).toHaveLength(2);
    expect(requests()[1]?.body.lastReadSeq).toBe(12);
  });

  it('never re-sends a mark that did not advance', () => {
    store().markChannelRead('topic:alpha', 11);
    vi.advanceTimersByTime(3_000);
    store().markChannelRead('topic:alpha', 11);
    store().markChannelRead('topic:alpha', 7);
    vi.advanceTimersByTime(3_000);
    expect(requests()).toHaveLength(1);
  });

  it('flushes an armed push on pagehide so closing the tab does not lose the mark', () => {
    store().markChannelRead('topic:alpha', 7);
    expect(fetchMock).not.toHaveBeenCalled();

    window.dispatchEvent(new Event('pagehide'));

    const sent = requests();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.body).toEqual({ lastReadSeq: 7 });
    // `keepalive` is the only fetch mode that survives the document being torn
    // down; without it the request the flush exists to make is cancelled.
    expect(sent[0]?.keepalive).toBe(true);

    // The armed window must be consumed, not left to fire a duplicate at a
    // page that may have been restored from bfcache.
    vi.advanceTimersByTime(10_000);
    expect(requests()).toHaveLength(1);
  });

  it('flushes on a hidden visibilitychange, the last event a discarded mobile tab gets', () => {
    store().markChannelRead('topic:beta', 3);
    Object.defineProperty(document, 'hidden', {
      configurable: true,
      get: () => true,
    });
    document.dispatchEvent(new Event('visibilitychange'));

    const sent = requests();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toBe('/channels/topic%3Abeta/read-state');
    expect(sent[0]?.keepalive).toBe(true);
  });

  it('keeps the local mark when the hub rejects the push', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({ error: 'store unavailable' }),
      text: async () => '{"error":"store unavailable"}',
      headers: new Headers({ 'content-type': 'application/json' }),
    } as unknown as Response);

    store().markChannelRead('topic:alpha', 8);
    vi.advanceTimersByTime(3_000);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    // Unread is client-derived, so an unreachable hub costs convergence and
    // nothing else — this device still knows it has read to 8.
    expect(store().lastReadByChannel['topic:alpha']).toBe(8);
    expect(localStorage.getItem(channelLastReadKey('topic:alpha'))).toBe('8');
    // And no retry timer was armed behind it.
    vi.advanceTimersByTime(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
