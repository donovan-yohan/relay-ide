// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from 'vitest';
import { channelToggleAgentActivity } from '../../frontend/src/lib/actions/definitions/channel.js';
import { setupShortcutListener } from '../../frontend/src/lib/actions/shortcuts.js';
import { useChannelActivityPresentationStore } from '../../frontend/src/lib/stores/channel-activity-presentation.js';

describe('channel activity shortcut', () => {
  let cleanup: (() => void) | null = null;

  afterEach(() => {
    cleanup?.();
    cleanup = null;
    useChannelActivityPresentationStore.setState({ presentation: 'shown' });
  });

  it('toggles only in the chat context with mod+shift+a', () => {
    cleanup = setupShortcutListener(
      () => [
        {
          ...channelToggleAgentActivity,
          handler: () =>
            useChannelActivityPresentationStore.getState().togglePresentation(),
        },
      ],
      () => ({ view: 'chat', channelId: 'topic:activity' }),
      false
    );

    document.dispatchEvent(
      new KeyboardEvent('keydown', {
        ctrlKey: true,
        shiftKey: true,
        key: 'a',
        bubbles: true,
      })
    );

    expect(useChannelActivityPresentationStore.getState().presentation).toBe(
      'collapsed'
    );
  });
});
