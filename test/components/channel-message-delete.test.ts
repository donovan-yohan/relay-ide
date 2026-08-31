// @vitest-environment happy-dom
//
// #1308 slice 1 item 4 — deleting one of the operator's own messages.
// The affordance and the server route share one predicate
// (`channelMessageDeletable`), so these tests pin the halves that predicate
// cannot: that destruction takes two deliberate steps WITHOUT a browser
// `confirm()`, and that a tombstone still renders as a row.

import React, { act } from 'react';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from 'vitest';
import { createRoot, type Root } from 'react-dom/client';

import { ChannelMessageRow } from '../../frontend/src/components/chat/ChannelMessageRow.js';
import type {
  ChannelMessage,
  ChannelMessageId,
} from '../../shared/channel-chat-protocol.js';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const CHANNEL_ID = 'topic:operator-lane';
const MESSAGE_ID =
  'chm:1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d' as ChannelMessageId;

function humanMessage(overrides: Partial<ChannelMessage> = {}): ChannelMessage {
  return {
    schemaVersion: 1,
    id: MESSAGE_ID,
    channelId: CHANNEL_ID,
    seq: 12,
    kind: 'message',
    status: 'complete',
    sender: { kind: 'human', id: 'human:operator' },
    body: { text: 'deploy at 3pm', format: 'text' },
    threadId: null,
    parentMessageId: null,
    createdAt: '2026-08-03T00:00:00.000Z',
    updatedAt: '2026-08-03T00:00:00.000Z',
    ...overrides,
  };
}

function tombstone(overrides: Partial<ChannelMessage> = {}): ChannelMessage {
  return humanMessage({
    body: { text: '', format: 'text' },
    meta: { deletedAt: '2026-08-03T02:00:00.000Z' },
    ...overrides,
  });
}

describe('ChannelMessageRow inline delete', () => {
  let container: HTMLDivElement;
  let root: Root;
  let onDelete: Mock<(message: ChannelMessage) => Promise<unknown>>;

  async function renderRow(
    message: ChannelMessage = humanMessage(),
    props: Record<string, unknown> = {}
  ): Promise<HTMLElement> {
    await act(async () => {
      root.render(
        React.createElement(ChannelMessageRow, {
          message,
          channelId: CHANNEL_ID,
          onDelete,
          ...props,
        })
      );
    });
    const row = container.querySelector<HTMLElement>('.ch-msg');
    expect(row).not.toBeNull();
    return row!;
  }

  async function hover(row: HTMLElement): Promise<void> {
    await act(async () => {
      row.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });
  }

  async function openConfirm(row: HTMLElement): Promise<void> {
    await hover(row);
    const button = row.querySelector<HTMLButtonElement>(
      '[aria-label="delete message"]'
    );
    expect(button).not.toBeNull();
    await act(async () => button?.click());
  }

  beforeEach(() => {
    onDelete = vi.fn<(message: ChannelMessage) => Promise<unknown>>(
      async () => {}
    );
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('offers delete on the operator’s own live row only', async () => {
    const own = await renderRow();
    await hover(own);
    expect(own.querySelector('[aria-label="delete message"]')).not.toBeNull();

    // An agent row is a durable record of what a provider said.
    const agent = await renderRow(
      humanMessage({
        sender: {
          kind: 'agent',
          id: 'agent-profile:claude:default',
          providerId: 'claude',
        },
      })
    );
    await hover(agent);
    expect(agent.querySelector('.ch-msg__actions')).not.toBeNull();
    expect(agent.querySelector('[aria-label="delete message"]')).toBeNull();

    // An already-deleted row cannot be deleted again.
    const gone = await renderRow(tombstone());
    await hover(gone);
    expect(gone.querySelector('[aria-label="delete message"]')).toBeNull();

    // No delete lane wired → no affordance, even on a human row.
    await act(async () => {
      root.render(
        React.createElement(ChannelMessageRow, {
          message: humanMessage(),
          channelId: CHANNEL_ID,
        })
      );
    });
    const unwired = container.querySelector<HTMLElement>('.ch-msg')!;
    await hover(unwired);
    expect(unwired.querySelector('[aria-label="delete message"]')).toBeNull();
  });

  it('asks inline before deleting and never calls the browser confirm', async () => {
    // A native modal would steal focus from the row it is about, cannot be
    // styled to the TUI, and hides the message being confirmed.
    const nativeConfirm = vi.fn(() => true);
    vi.stubGlobal('confirm', nativeConfirm);
    (window as unknown as { confirm: () => boolean }).confirm = nativeConfirm;

    const row = await renderRow();
    await openConfirm(row);
    expect(onDelete).not.toHaveBeenCalled();
    expect(nativeConfirm).not.toHaveBeenCalled();
    const strip = row.querySelector(
      '[aria-label="delete message confirmation"]'
    );
    expect(strip).not.toBeNull();
    // The question sits on the row, in the toolbar's own slot.
    expect(row.textContent).toContain('delete?');

    await act(async () =>
      row
        .querySelector<HTMLButtonElement>(
          'button[aria-label="confirm delete message"]'
        )
        ?.click()
    );
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(onDelete.mock.calls[0]?.[0]?.id).toBe(MESSAGE_ID);
    vi.unstubAllGlobals();
  });

  it('backs out on cancel and on escape without deleting', async () => {
    const row = await renderRow();
    await openConfirm(row);
    await act(async () =>
      row
        .querySelector<HTMLButtonElement>(
          'button[aria-label="cancel delete message"]'
        )
        ?.click()
    );
    expect(onDelete).not.toHaveBeenCalled();
    expect(
      row.querySelector('[aria-label="delete message confirmation"]')
    ).toBeNull();

    await openConfirm(row);
    await act(async () => {
      row
        .querySelector('[aria-label="delete message confirmation"]')
        ?.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
        );
    });
    expect(onDelete).not.toHaveBeenCalled();
    expect(
      row.querySelector('[aria-label="delete message confirmation"]')
    ).toBeNull();
  });

  it('keeps the confirm open when the write fails', async () => {
    onDelete.mockRejectedValueOnce(new Error('409'));
    const row = await renderRow();
    await openConfirm(row);
    await act(async () =>
      row
        .querySelector<HTMLButtonElement>(
          'button[aria-label="confirm delete message"]'
        )
        ?.click()
    );
    expect(onDelete).toHaveBeenCalledTimes(1);
    // The operator asked for this and is owed the outcome, not a silent revert.
    expect(
      row.querySelector('[aria-label="delete message confirmation"]')
    ).not.toBeNull();
  });

  it('renders a tombstone as a dim placeholder that keeps its thread anchor', async () => {
    const onOpenThread = vi.fn();
    // The edit lane IS wired here, so the missing edit button below is the
    // shared predicate refusing a tombstone, not an unwired surface.
    const row = await renderRow(tombstone(), {
      replyCount: 2,
      onOpenThread,
      onEdit: vi.fn(async () => {}),
    });
    expect(row.querySelector('.ch-msg__deleted')?.textContent).toBe(
      'message deleted'
    );
    expect(row.className).toContain('ch-msg--deleted');
    // The row keeps its identity, so a deep link and a thread parent that named
    // it stay valid.
    expect(row.getAttribute('data-channel-message-id')).toBe(MESSAGE_ID);
    expect(row.getAttribute('data-channel-message-seq')).toBe('12');
    // Deleting the parent must not strand its replies.
    const chip = row.querySelector<HTMLButtonElement>('.ch-msg__thread-chip');
    expect(chip?.textContent).toContain('2 replies');
    await act(async () => chip?.click());
    expect(onOpenThread).toHaveBeenCalledWith(MESSAGE_ID);

    // Still addressable (copy-link survives), but there is nothing left to copy
    // as text and nothing left to edit.
    await hover(row);
    expect(
      row.querySelector('[aria-label="copy link to message"]')
    ).not.toBeNull();
    expect(row.querySelector('[aria-label="copy message text"]')).toBeNull();
    expect(row.querySelector('[aria-label="edit message"]')).toBeNull();
  });
});
