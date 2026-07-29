// @vitest-environment happy-dom

import { beforeEach, describe, expect, it } from 'vitest';
import { useUiStore } from '../../frontend/src/lib/stores/ui.js';
import type { ChannelMessageId } from '../../shared/channel-chat-protocol.js';

describe('channel thread transient UI state', () => {
  beforeEach(() => {
    useUiStore.setState({
      activeChannelId: null,
      activeThreadRootId: null,
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

  it('keeps the cockpit escape hatch when a channel is closed', () => {
    useUiStore.getState().setActiveChannelId('topic:next');
    useUiStore.getState().setForceOrgCockpit(true);

    useUiStore.getState().setActiveChannelId(null);
    expect(useUiStore.getState().forceOrgCockpit).toBe(true);
  });
});
