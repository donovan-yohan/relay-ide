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
/** Backs a redefined `document.hidden` so the backgrounded lane is testable. */
let documentHidden = false;

/** A hub PUT response carrying the durable value the hub actually holds. */
function readStateResponse(channelId: string, lastReadSeq: number): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      readState: { channelId, lastReadSeq, updatedAt: '2026-07-27T00:00:00Z' },
    }),
  } as unknown as Response;
}

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
  documentHidden = false;
  Object.defineProperty(document, 'hidden', {
    configurable: true,
    get: () => documentHidden,
  });
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

  it('treats a corrupt localStorage marker as absent instead of poisoning the channel with NaN', () => {
    // `Number('null')` is NaN, and NaN loses every comparison it touches:
    // `Math.max(store, NaN)` is NaN, so BOTH merge branches are false — no
    // adopt, no push-back — and the channel drops out of the sync in both
    // directions, permanently and with nothing surfaced.
    localStorage.setItem(channelLastReadKey('topic:corrupt'), 'null');

    store().mergeReadState(
      [{ channelId: 'topic:corrupt', lastReadSeq: 7 }],
      Date.now()
    );

    // Self-heals: the hub value wins and rewrites the marker.
    expect(store().lastReadByChannel['topic:corrupt']).toBe(7);
    expect(localStorage.getItem(channelLastReadKey('topic:corrupt'))).toBe('7');

    // The same NaN silently suppressed the unread dot, which is how a corrupt
    // marker stayed invisible in the first place.
    localStorage.setItem(channelLastReadKey('topic:poisoned'), 'undefined');
    expect(
      hasUnseenActivity('topic:poisoned', null, {
        latestSeq: 3,
        lastRead: undefined,
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
    documentHidden = true;
    document.dispatchEvent(new Event('visibilitychange'));

    const sent = requests();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toBe('/channels/topic%3Abeta/read-state');
    expect(sent[0]?.keepalive).toBe(true);
  });

  it('publishes a mark written by a LATER visibilitychange listener within the same dispatch', () => {
    // The ordering the teardown flush cannot win. This store binds its own
    // `visibilitychange` listener lazily on the first armed push, and
    // ChannelView re-registers its listener on every channelId change — so in a
    // real session ChannelView is the LATER listener and its `markChannelRead`
    // runs after the store's flush has already found nothing armed. Arm one
    // push here so the store's listener is definitely registered first.
    store().markChannelRead('topic:earlier', 2);
    vi.advanceTimersByTime(3_000);
    fetchMock.mockClear();

    const channelViewOnVisibility = (): void => {
      if (document.hidden) store().markChannelRead('topic:beta', 9);
    };
    document.addEventListener('visibilitychange', channelViewOnVisibility);
    documentHidden = true;
    try {
      document.dispatchEvent(new Event('visibilitychange'));
    } finally {
      document.removeEventListener('visibilitychange', channelViewOnVisibility);
    }

    // No timer advance: an already-hidden page publishes inline, because a
    // backgrounded mobile tab may have its timers frozen or be discarded
    // outright before a 3s window could ever fire.
    const sent = requests();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toBe('/channels/topic%3Abeta/read-state');
    expect(sent[0]?.body).toEqual({ lastReadSeq: 9 });
    expect(sent[0]?.keepalive).toBe(true);

    // Consumed, not left armed behind a duplicate for a bfcache restore.
    vi.advanceTimersByTime(10_000);
    expect(requests()).toHaveLength(1);
  });

  it('stops re-pushing a mark the hub has refused, but still sends a higher one', async () => {
    // A marker stranded above the channel head (a rewound DM) can never be
    // accepted: the hub clamps to head and answers with what it holds. Without
    // reading that answer the boot merge re-issues the identical futile PUT
    // every boot, forever, with nothing able to stop it.
    localStorage.setItem(channelLastReadKey('topic:alpha'), '40');
    fetchMock.mockResolvedValue(readStateResponse('topic:alpha', 12));

    store().mergeReadState(
      [{ channelId: 'topic:alpha', lastReadSeq: 12 }],
      Date.now()
    );
    vi.advanceTimersByTime(3_000);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(requests()[0]?.body.lastReadSeq).toBe(40);
    // Let the RESPONSE land, not just the request leave: the refusal is learned
    // from the body. In a real session the next boot merge is a page load away.
    await vi.advanceTimersByTimeAsync(0);

    // The next boot merge sees the hub still behind — and stays quiet, because
    // this is the exact value it just refused.
    store().mergeReadState(
      [{ channelId: 'topic:alpha', lastReadSeq: 12 }],
      Date.now()
    );
    vi.advanceTimersByTime(10_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // A genuinely higher mark is still worth one request: suppression is scoped
    // to the refused value, not to the channel.
    store().markChannelRead('topic:alpha', 41);
    vi.advanceTimersByTime(3_000);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(requests()[1]?.body.lastReadSeq).toBe(41);
  });

  it('adopts a HIGHER mark the hub answers a push with, without waiting for the broadcast', async () => {
    // Another device read further first. The PUT response already carries the
    // hub's durable, head-clamped value, so the merge is free convergence.
    fetchMock.mockResolvedValue(readStateResponse('topic:beta', 30));

    store().markChannelRead('topic:beta', 5);
    vi.advanceTimersByTime(3_000);
    await vi.waitFor(() =>
      expect(store().lastReadByChannel['topic:beta']).toBe(30)
    );
    expect(localStorage.getItem(channelLastReadKey('topic:beta'))).toBe('30');
    // Adopting is not a reason to push: the hub already holds the higher value.
    vi.advanceTimersByTime(10_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
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
