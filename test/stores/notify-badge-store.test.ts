// #1308 slice 5 item 2 — attention-badge state behind the favicon dot and the
// title count. Pure store logic; no DOM.
import { beforeEach, describe, expect, it } from 'vitest';
import {
  countAttentionChannels,
  reasonEarnsBadge,
  useNotifyBadgeStore,
} from '../../frontend/src/lib/stores/notify-badge.js';

const CHANNEL = 'topic:impl-1308';
const DM = 'topic:dm~claude~workspace-local';

beforeEach(() => {
  useNotifyBadgeStore.getState().reset();
});

describe('which reasons earn a badge', () => {
  it('counts mentions and DM replies, never turn-complete', () => {
    expect(reasonEarnsBadge('mention')).toBe(true);
    expect(reasonEarnsBadge('dm-reply')).toBe(true);
    // A finished turn is a workflow event on a channel the operator may have
    // fanned out and stopped watching — it can notify, but it must not pin a
    // permanent dot on the tab (its seq is 0, so no read mark could clear it).
    expect(reasonEarnsBadge('turn-complete')).toBe(false);
  });

  it('refuses to store a turn-complete flag at all', () => {
    useNotifyBadgeStore
      .getState()
      .flagChannel(CHANNEL, { seq: 0, reason: 'turn-complete' });
    expect(useNotifyBadgeStore.getState().flagByChannel).toEqual({});
  });
});

describe('flagging', () => {
  it('keeps the highest seq per channel', () => {
    const store = useNotifyBadgeStore.getState();
    store.flagChannel(CHANNEL, { seq: 10, reason: 'mention' });
    store.flagChannel(CHANNEL, { seq: 4, reason: 'mention' });
    expect(useNotifyBadgeStore.getState().flagByChannel[CHANNEL]).toEqual({
      seq: 10,
      reason: 'mention',
    });
    store.flagChannel(CHANNEL, { seq: 12, reason: 'dm-reply' });
    expect(useNotifyBadgeStore.getState().flagByChannel[CHANNEL]).toEqual({
      seq: 12,
      reason: 'dm-reply',
    });
  });

  it('leaves the map identity alone when nothing changed', () => {
    const store = useNotifyBadgeStore.getState();
    store.flagChannel(CHANNEL, { seq: 10, reason: 'mention' });
    const before = useNotifyBadgeStore.getState().flagByChannel;
    store.flagChannel(CHANNEL, { seq: 10, reason: 'mention' });
    // Identity stability is load-bearing: the delivery hook memoizes the count
    // on this object, so a new identity per redundant event would recompute (and
    // re-apply the favicon) on every message in a busy channel.
    expect(useNotifyBadgeStore.getState().flagByChannel).toBe(before);
  });

  it('clears one channel without disturbing the others', () => {
    const store = useNotifyBadgeStore.getState();
    store.flagChannel(CHANNEL, { seq: 10, reason: 'mention' });
    store.flagChannel(DM, { seq: 3, reason: 'dm-reply' });
    store.clearChannel(CHANNEL);
    expect(Object.keys(useNotifyBadgeStore.getState().flagByChannel)).toEqual([
      DM,
    ]);
  });
});

describe('count derived against the read position', () => {
  it('counts CHANNELS, not messages', () => {
    const flags = {
      [CHANNEL]: { seq: 40, reason: 'mention' as const },
      [DM]: { seq: 12, reason: 'dm-reply' as const },
    };
    // Two channels holding many unread messages each are still "2".
    expect(countAttentionChannels(flags, {})).toBe(2);
  });

  it('clears a channel once the read mark reaches its seq', () => {
    const flags = { [CHANNEL]: { seq: 40, reason: 'mention' as const } };
    expect(countAttentionChannels(flags, { [CHANNEL]: 39 })).toBe(1);
    expect(countAttentionChannels(flags, { [CHANNEL]: 40 })).toBe(0);
    // Read PAST it (another device read further) also clears.
    expect(countAttentionChannels(flags, { [CHANNEL]: 99 })).toBe(0);
  });

  it('re-raises when a newer message arrives after a read', () => {
    const store = useNotifyBadgeStore.getState();
    store.flagChannel(CHANNEL, { seq: 40, reason: 'mention' });
    const read = { [CHANNEL]: 40 };
    expect(
      countAttentionChannels(useNotifyBadgeStore.getState().flagByChannel, read)
    ).toBe(0);
    store.flagChannel(CHANNEL, { seq: 41, reason: 'mention' });
    expect(
      countAttentionChannels(useNotifyBadgeStore.getState().flagByChannel, read)
    ).toBe(1);
  });

  it('is zero with no flags at all', () => {
    expect(countAttentionChannels({}, { [CHANNEL]: 12 })).toBe(0);
  });
});
