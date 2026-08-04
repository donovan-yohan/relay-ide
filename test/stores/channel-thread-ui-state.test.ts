// @vitest-environment happy-dom

import { beforeEach, describe, expect, it } from 'vitest';
import { useUiStore } from '../../frontend/src/lib/stores/ui.js';
import type { ChannelMessageId } from '../../shared/channel-chat-protocol.js';

describe('channel thread transient UI state', () => {
  beforeEach(() => {
    useUiStore.setState({
      activeChannelId: null,
      activeThreadRootId: null,
      pendingChannelThread: null,
      forceOrgCockpit: false,
    });
  });

  it('opens a thread and clears it whenever channel selection is set', () => {
    const rootId = 'chm:root' as ChannelMessageId;
    useUiStore.getState().setActiveThreadRootId(rootId);
    expect(useUiStore.getState().activeThreadRootId).toBe(rootId);

    useUiStore.getState().setActiveChannelId('topic:next');
    expect(useUiStore.getState().activeChannelId).toBe('topic:next');
    expect(useUiStore.getState().activeThreadRootId).toBeNull();
  });

  // #1287: forceOrgCockpit is a one-off escape hatch an open channel outranks,
  // so opening a channel must drop it — a latched flag would otherwise fire as
  // a surprise cockpit navigation the moment the channel is closed again.
  it('drops a latched cockpit escape hatch when a channel is opened', () => {
    useUiStore.getState().setForceOrgCockpit(true);

    useUiStore.getState().setActiveChannelId('topic:next');
    expect(useUiStore.getState().forceOrgCockpit).toBe(false);
  });

  // #1287 slice 5 item 18: the rail asks for "this channel, with this thread".
  it('records a thread-open intent and only the target channel consumes it', () => {
    const rootId = 'chm:root' as ChannelMessageId;
    // The rail always opens the channel first, so the intent must survive being
    // written immediately after `setActiveChannelId` cleared the field.
    useUiStore.getState().setActiveChannelId('topic:alpha');
    useUiStore.getState().requestChannelThread('topic:alpha', rootId);
    expect(useUiStore.getState().pendingChannelThread).toEqual({
      channelId: 'topic:alpha',
      rootMessageId: rootId,
    });

    useUiStore.getState().consumeChannelThreadIntent('topic:beta');
    expect(useUiStore.getState().pendingChannelThread).not.toBeNull();

    useUiStore.getState().consumeChannelThreadIntent('topic:alpha');
    expect(useUiStore.getState().pendingChannelThread).toBeNull();
  });

  it('cancels an un-consumed thread intent on a plain channel open', () => {
    useUiStore
      .getState()
      .requestChannelThread('topic:alpha', 'chm:root' as ChannelMessageId);

    useUiStore.getState().setActiveChannelId('topic:beta');
    expect(useUiStore.getState().pendingChannelThread).toBeNull();
  });

  it('keeps the cockpit escape hatch when a channel is closed', () => {
    useUiStore.getState().setActiveChannelId('topic:next');
    useUiStore.getState().setForceOrgCockpit(true);

    useUiStore.getState().setActiveChannelId(null);
    expect(useUiStore.getState().forceOrgCockpit).toBe(true);
  });
});
