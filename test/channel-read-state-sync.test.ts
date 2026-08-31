// @vitest-environment happy-dom

// Cross-device read sync, client half (#1308 slice 3 item 2).
//
// The invariant under test is that the hub is a point of CONVERGENCE and never a
// source of truth: localStorage stays the fast path, every hub-sourced mark is
// merged monotonic-up, and the one case where "up" is the wrong direction — the
// #1178 recreated-DM clamp — is fenced by the clamp epoch rather than trusted to
// the hub. The single exception is load-bearing (#1318): a PUT answered BELOW
// what it pushed is provably the channel head, so it drives the clamp instead of
// a suppression table. See docs/LEARNINGS.md L-20260729-client-derived-unread.
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
  method?: string | undefined;
  keepalive?: boolean | undefined;
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
    activityRaisedAtByChannel: {},
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

  it('clamps the local stores when the hub answers BELOW the pushed mark, which re-lights the dot and closes the re-push loop (#1318)', async () => {
    // A hub answer under the pushed value is not an opinion — it is the channel
    // HEAD, because `Math.min(requested, head)` is the only branch of the store
    // write that can return less than the request. So a "refusal" is really the
    // hub telling this device its marker belongs to a life the channel no
    // longer has (#1178: a DM deleted and recreated under the same id), and the
    // right answer is the repair, not a suppression table.
    //
    // Cold-boot shape: the real marker (40) is in localStorage, and the rail
    // has seeded the recreated channel's actual head (12).
    localStorage.setItem(channelLastReadKey('topic:dm'), '40');
    store().seedChannelActivity([{ id: 'topic:dm', latestSeq: 12 }], Date.now());
    // The bug this repairs: a stale-high marker eats the unread dot outright.
    expect(
      hasUnseenActivity('topic:dm', null, {
        latestSeq: 12,
        lastRead: store().lastReadByChannel['topic:dm'],
      })
    ).toBe(false);
    fetchMock.mockResolvedValue(readStateResponse('topic:dm', 12));

    // The boot merge sees the hub behind the (stranded) local mark and pushes.
    store().mergeReadState(
      [{ channelId: 'topic:dm', lastReadSeq: 12 }],
      Date.now()
    );
    vi.advanceTimersByTime(3_000);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(requests()[0]?.body.lastReadSeq).toBe(40);
    // Let the RESPONSE land, not just the request leave: the head arrives in
    // the body. In a real session the next boot merge is a page load away.
    await vi.advanceTimersByTimeAsync(0);

    // Both halves of the marker are rewritten to the authoritative head.
    expect(store().lastReadByChannel['topic:dm']).toBe(12);
    expect(localStorage.getItem(channelLastReadKey('topic:dm'))).toBe('12');

    // And that is what closes the loop the old refusal map existed to break:
    // the next boot merge finds local and hub agreeing, so the futile PUT is
    // never re-issued — no per-channel suppression table required.
    store().mergeReadState(
      [{ channelId: 'topic:dm', lastReadSeq: 12 }],
      Date.now() + 1_000
    );
    vi.advanceTimersByTime(10_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // The dot the stranded marker was swallowing comes back with the next
    // message. Against a marker of 40 this broadcast was invisible forever.
    store().recordActivity('topic:dm', 13);
    expect(
      hasUnseenActivity('topic:dm', null, {
        latestSeq: store().latestSeqByChannel['topic:dm'] ?? 0,
        lastRead: store().lastReadByChannel['topic:dm'],
      })
    ).toBe(true);

    // The decisive one: reading the recreated channel publishes normally. This
    // mark (13) sits BELOW the old stranded value, so a refusal armed at 40
    // would have swallowed it — and every mark up to 40 after it.
    fetchMock.mockResolvedValue(readStateResponse('topic:dm', 13));
    store().markChannelRead('topic:dm', 13);
    vi.advanceTimersByTime(3_000);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(requests()[1]?.body.lastReadSeq).toBe(13);
  });

  it('preserved invariant: a deeper local clamp wins over the head a PUT was still in flight for (#1178)', async () => {
    // An INVARIANT guard, not a regression test — it passes on both sides of
    // #1318, and deliberately so. A competing CLAMP is the one competitor the
    // "only ever moves DOWN" argument really does dispose of: a local clamp to
    // 5 lands BETWEEN the PUT leaving and the hub answering 12, and the later,
    // higher head is a no-op against stores already below it rather than a
    // rollback of the position this device just retracted. The competitor that
    // argument does NOT cover is a RAISE; that case is the test below.
    let answerPut: (res: Response) => void = () => {};
    fetchMock.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          answerPut = resolve;
        })
    );
    store().recordActivity('topic:dm', 50);
    store().markChannelRead('topic:dm', 40);
    vi.advanceTimersByTime(3_000);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(requests()[0]?.body.lastReadSeq).toBe(40);

    // The DM was deleted and recreated under the same id: head restarts at 5
    // and this device retracts its marker while the PUT is still open.
    store().clampChannelStores('topic:dm', 5);
    expect(store().lastReadByChannel['topic:dm']).toBe(5);

    // Only now does the pre-clamp PUT come back, head-clamped by the hub.
    answerPut(readStateResponse('topic:dm', 12));
    await vi.advanceTimersByTimeAsync(0);
    // Neither half moves back up: the pre-clamp head must not be handed back to
    // the device that just retracted past it.
    expect(store().lastReadByChannel['topic:dm']).toBe(5);
    expect(localStorage.getItem(channelLastReadKey('topic:dm'))).toBe('5');
    expect(store().latestSeqByChannel['topic:dm']).toBe(5);

    // And the operator reading the recreated DM to 9 still reaches the hub.
    fetchMock.mockClear();
    fetchMock.mockResolvedValue(readStateResponse('topic:dm', 9));
    store().markChannelRead('topic:dm', 9);
    vi.advanceTimersByTime(3_000);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(requests()[0]?.body.lastReadSeq).toBe(9);
  });

  it('keeps a head this device learned AFTER the PUT was issued, so the repair cannot eat a live message (#1318)', async () => {
    // The competitor "the clamp only moves DOWN" does not cover: a RAISE. The
    // head in a PUT response is a snapshot from the hub's transaction, applied
    // a network hop later, and the clamp lowers `latestSeqByChannel` as well as
    // the read marker — so a `channel-activity` broadcast that lands mid-flight
    // would be erased by an answer that predates it, hiding a message the
    // operator has never seen. Nothing about the clamp epoch stops that: it
    // fences the two MERGES, not the clamp.
    localStorage.setItem(channelLastReadKey('topic:dm'), '40');
    store().seedChannelActivity([{ id: 'topic:dm', latestSeq: 12 }], Date.now());
    let answerPut: (res: Response) => void = () => {};
    fetchMock.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          answerPut = resolve;
        })
    );

    // Boot merge finds the hub behind the stranded marker and pushes it.
    store().mergeReadState(
      [{ channelId: 'topic:dm', lastReadSeq: 12 }],
      Date.now()
    );
    vi.advanceTimersByTime(3_000);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(requests()[0]?.body.lastReadSeq).toBe(40);

    // A message arrives in the recreated channel while the PUT is still open.
    vi.advanceTimersByTime(50);
    store().recordActivity('topic:dm', 13);

    // Only now does the hub answer, with the head as it stood at seq 12.
    answerPut(readStateResponse('topic:dm', 12));
    await vi.advanceTimersByTimeAsync(0);

    // The read half of the repair still lands — that half only ever ADDS unread,
    // so it needs no fence and the stranded marker must not survive.
    expect(store().lastReadByChannel['topic:dm']).toBe(12);
    expect(localStorage.getItem(channelLastReadKey('topic:dm'))).toBe('12');
    // The decisive one: the newer head survives, so seq 13 stays unread.
    expect(store().latestSeqByChannel['topic:dm']).toBe(13);
    expect(
      hasUnseenActivity('topic:dm', null, {
        latestSeq: store().latestSeqByChannel['topic:dm'],
        lastRead: store().lastReadByChannel['topic:dm'],
      })
    ).toBe(true);
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
