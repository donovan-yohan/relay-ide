// @vitest-environment happy-dom
//
// #1308 slice 1 item 1 — the per-message hover action toolbar. The toolbar is
// mounted only while the row is hovered/focused/long-press pinned, so "renders
// on hover" is a DOM assertion here rather than a CSS one: an always-mounted,
// opacity-hidden toolbar would still be two extra buttons per row in a lane
// that routinely holds hundreds.

import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';

import { ChannelMessageRow } from '../../frontend/src/components/chat/ChannelMessageRow.js';
import { encodeChannelSegment } from '../../frontend/src/lib/url-nav.js';
import type {
  ChannelMessage,
  ChannelMessageId,
} from '../../shared/channel-chat-protocol.js';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const CHANNEL_ID = 'topic:operator-lane';
const MESSAGE_ID =
  'chm:9f0c1d2e-3a4b-4c5d-8e9f-0a1b2c3d4e5f' as ChannelMessageId;

function humanMessage(overrides: Partial<ChannelMessage> = {}): ChannelMessage {
  return {
    schemaVersion: 1,
    id: MESSAGE_ID,
    channelId: CHANNEL_ID,
    seq: 7,
    kind: 'message',
    status: 'complete',
    sender: { kind: 'human', id: 'human:operator' },
    body: { text: 'ship the anchor', format: 'text' },
    threadId: null,
    parentMessageId: null,
    createdAt: '2026-08-03T00:00:00.000Z',
    updatedAt: '2026-08-03T00:00:00.000Z',
    ...overrides,
  };
}

describe('ChannelMessageRow action toolbar', () => {
  let container: HTMLDivElement;
  let root: Root;
  let writeText: ReturnType<typeof vi.fn>;

  async function renderRow(
    message: ChannelMessage = humanMessage()
  ): Promise<HTMLElement> {
    await act(async () => {
      root.render(
        React.createElement(ChannelMessageRow, {
          message,
          channelId: CHANNEL_ID,
        })
      );
    });
    const row = container.querySelector<HTMLElement>('.ch-msg');
    expect(row).not.toBeNull();
    return row!;
  }

  async function hover(row: HTMLElement): Promise<void> {
    // React polyfills onMouseEnter from the delegated `mouseover` listener, so
    // this is the event a real pointer entry produces.
    await act(async () => {
      row.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });
  }

  beforeEach(() => {
    writeText = vi.fn(async () => {});
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('mounts the toolbar on hover and unmounts it on leave', async () => {
    const row = await renderRow();
    expect(row.querySelector('.ch-msg__actions')).toBeNull();

    await hover(row);

    const actions = row.querySelector('.ch-msg__actions');
    expect(actions).not.toBeNull();
    expect(actions?.getAttribute('aria-label')).toBe('message actions');
    expect(
      Array.from(actions!.querySelectorAll('button')).map((button) =>
        button.getAttribute('aria-label')
      )
    ).toEqual(['copy link to message', 'copy message text']);

    await act(async () => {
      row.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
    });
    expect(row.querySelector('.ch-msg__actions')).toBeNull();
  });

  it('copies a deep link that names the channel and the message', async () => {
    const row = await renderRow();
    await hover(row);

    const copyLink = row.querySelector<HTMLButtonElement>(
      '[aria-label="copy link to message"]'
    );
    await act(async () => copyLink?.click());

    expect(writeText).toHaveBeenCalledTimes(1);
    const link = String(writeText.mock.calls[0]?.[0]);
    expect(link).toBe(
      `${window.location.origin}/channel/${encodeChannelSegment(CHANNEL_ID)}#msg-${MESSAGE_ID.slice('chm:'.length)}`
    );
    // The link must survive a paste into the router that produced it.
    expect(new URL(link).pathname).toBe(
      `/channel/${encodeChannelSegment(CHANNEL_ID)}`
    );
  });

  it('copies the message body verbatim', async () => {
    const row = await renderRow(
      humanMessage({ body: { text: 'line one\nline two', format: 'text' } })
    );
    await hover(row);

    const copyText = row.querySelector<HTMLButtonElement>(
      '[aria-label="copy message text"]'
    );
    await act(async () => copyText?.click());

    expect(writeText).toHaveBeenCalledWith('line one\nline two');
  });

  it('pins the toolbar open on a touch long press and dismisses it outside', async () => {
    vi.useFakeTimers();
    try {
      const row = await renderRow();

      // happy-dom has no Touch constructor; React reads `touches[0]`, so the
      // synthetic event needs one entry with coordinates.
      await act(async () => {
        const event = new MouseEvent('touchstart', { bubbles: true });
        Object.defineProperty(event, 'touches', {
          value: [{ clientX: 10, clientY: 10 }],
        });
        row.dispatchEvent(event);
      });
      expect(row.querySelector('.ch-msg__actions')).toBeNull();

      await act(async () => {
        vi.advanceTimersByTime(600);
      });
      expect(row.querySelector('.ch-msg__actions')).not.toBeNull();

      await act(async () => {
        document.body.dispatchEvent(new MouseEvent('pointerdown'));
      });
      expect(row.querySelector('.ch-msg__actions')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
