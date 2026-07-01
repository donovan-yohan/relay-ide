// @vitest-environment happy-dom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  sendInboxMessage: vi.fn(),
  useSessionMailbox: vi.fn(),
}));

vi.mock('../frontend/src/lib/api.js', () => ({
  sendInboxMessage: mocks.sendInboxMessage,
}));

vi.mock('../frontend/src/hooks/useSessionMailbox.js', () => ({
  useSessionMailbox: mocks.useSessionMailbox,
}));

const { default: SessionMailboxPanel } =
  await import('../frontend/src/components/SessionMailboxPanel.js');

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  mocks.sendInboxMessage.mockReset().mockResolvedValue({});
  const refetch = vi.fn();
  mocks.useSessionMailbox.mockReturnValue({
    summary: {
      messages: [],
      unreadCount: 0,
      openCount: 0,
      decisionCount: 0,
      attentionCount: 0,
      artifactCount: 0,
      priority: 'normal',
      latestPreview: null,
    },
    isLoading: false,
    isError: false,
    error: null,
    isUpdating: false,
    refetch,
    updateMessage: vi.fn(),
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  });
}

describe('SessionMailboxPanel composer', () => {
  it('sends a local-friend inbox message to the mailbox session', async () => {
    act(() =>
      root.render(
        React.createElement(SessionMailboxPanel, { targetSessionId: 's1' })
      )
    );

    const input = container.querySelector(
      '.session-mailbox-compose__input'
    ) as HTMLInputElement;
    expect(input).not.toBeNull();

    const setValue = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value'
    )!.set!;
    act(() => {
      setValue.call(input, 'ping from operator');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });

    const sendBtn = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'send'
    ) as HTMLButtonElement;
    expect(sendBtn).toBeDefined();
    act(() => sendBtn.click());
    await flush();

    expect(mocks.sendInboxMessage).toHaveBeenCalledTimes(1);
    expect(mocks.sendInboxMessage).toHaveBeenCalledWith({
      targetSessionId: 's1',
      text: 'ping from operator',
      contextPacketIds: [],
    });
    // Input clears after a successful send.
    expect(
      (
        container.querySelector(
          '.session-mailbox-compose__input'
        ) as HTMLInputElement
      ).value
    ).toBe('');
  });

  it('does not send an empty message', async () => {
    act(() =>
      root.render(
        React.createElement(SessionMailboxPanel, { targetSessionId: 's1' })
      )
    );
    const sendBtn = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'send'
    ) as HTMLButtonElement;
    expect(sendBtn.disabled).toBe(true);
    act(() => sendBtn.click());
    await flush();
    expect(mocks.sendInboxMessage).not.toHaveBeenCalled();
  });
});
