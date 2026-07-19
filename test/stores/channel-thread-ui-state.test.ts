// @vitest-environment happy-dom

import { beforeEach, describe, expect, it } from 'vitest';
import { useUiStore } from '../../frontend/src/lib/stores/ui.js';
import type { ChannelMessageId } from '../../shared/channel-chat-protocol.js';

describe('channel thread transient UI state', () => {
  beforeEach(() => {
    useUiStore.setState({
      activeChannelId: null,
      activeThreadRootId: null,
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
});
