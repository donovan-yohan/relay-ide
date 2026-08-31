// @vitest-environment happy-dom
//
// #1308 slice 1 item 3 — editing one of the operator's own messages in place.
// The affordance and the server route share one predicate
// (`channelMessageEditable`), so these tests pin the two halves that the shared
// predicate cannot: that the row offers the action ONLY where the predicate
// allows it, and that the editor hands back exactly what the operator typed.

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

describe('ChannelMessageRow inline edit', () => {
  let container: HTMLDivElement;
  let root: Root;
  let onEdit: Mock<(message: ChannelMessage, text: string) => Promise<unknown>>;

  async function renderRow(
    message: ChannelMessage = humanMessage(),
    props: Record<string, unknown> = {}
  ): Promise<HTMLElement> {
    await act(async () => {
      root.render(
        React.createElement(ChannelMessageRow, {
          message,
          channelId: CHANNEL_ID,
          onEdit,
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

  async function openEditor(row: HTMLElement): Promise<HTMLTextAreaElement> {
    await hover(row);
    const edit = row.querySelector<HTMLButtonElement>(
      '[aria-label="edit message"]'
    );
    expect(edit).not.toBeNull();
    await act(async () => edit?.click());
    const textarea = row.querySelector<HTMLTextAreaElement>(
      '[aria-label="edit message text"]'
    );
    expect(textarea?.tagName).toBe('TEXTAREA');
    return textarea!;
  }

  async function type(
    textarea: HTMLTextAreaElement,
    value: string
  ): Promise<void> {
    // React tracks the last value it wrote; set through the prototype so the
    // controlled component sees a real change.
    const setter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      'value'
    )?.set;
    await act(async () => {
      setter?.call(textarea, value);
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  beforeEach(() => {
    onEdit = vi.fn(async () => {});
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('offers edit on the operator’s own row only', async () => {
    const own = await renderRow();
    await hover(own);
    expect(own.querySelector('[aria-label="edit message"]')).not.toBeNull();

    // Agent rows are a durable record of what a provider said; system rows are
    // the hub's own bookkeeping. Neither may be rewritten.
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
    expect(agent.querySelector('[aria-label="edit message"]')).toBeNull();

    // No edit lane wired → no affordance, even on a human row.
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
    expect(unwired.querySelector('[aria-label="edit message"]')).toBeNull();
  });

  it('saves the edited text on enter and closes the editor', async () => {
    const row = await renderRow();
    const textarea = await openEditor(row);
    // The editor opens seeded with the durable body, not empty.
    expect(textarea.value).toBe('deploy at 3pm');

    await type(textarea, 'deploy at 5pm');
    await act(async () => {
      textarea.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })
      );
    });

    expect(onEdit).toHaveBeenCalledTimes(1);
    expect(onEdit.mock.calls[0]?.[1]).toBe('deploy at 5pm');
    expect(row.querySelector('textarea')).toBeNull();
  });

  it('keeps a newline on shift+enter and never sends an unchanged or empty body', async () => {
    const row = await renderRow();
    const textarea = await openEditor(row);

    await act(async () => {
      textarea.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          shiftKey: true,
          bubbles: true,
        })
      );
    });
    expect(onEdit).not.toHaveBeenCalled();

    // Unchanged text closes the editor without a write…
    await act(async () => {
      textarea.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })
      );
    });
    expect(onEdit).not.toHaveBeenCalled();
    expect(row.querySelector('textarea')).toBeNull();

    // …and an emptied body is not a delete lane, so it is refused outright.
    const reopened = await openEditor(row);
    await type(reopened, '   ');
    await act(async () => {
      reopened.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })
      );
    });
    expect(onEdit).not.toHaveBeenCalled();
    expect(row.querySelector('textarea')).not.toBeNull();
  });

  it('escape abandons the edit and a failed save keeps the draft on screen', async () => {
    const row = await renderRow();
    const textarea = await openEditor(row);
    await type(textarea, 'thrown away');
    await act(async () => {
      textarea.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
      );
    });
    expect(onEdit).not.toHaveBeenCalled();
    expect(row.querySelector('textarea')).toBeNull();

    onEdit.mockRejectedValueOnce(new Error('409'));
    const retry = await openEditor(row);
    await type(retry, 'deploy at 5pm');
    await act(async () => {
      retry.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })
      );
    });
    expect(onEdit).toHaveBeenCalledTimes(1);
    // The operator's words are the one thing this row must never discard.
    const stillOpen = row.querySelector<HTMLTextAreaElement>('textarea');
    expect(stillOpen).not.toBeNull();
    expect(stillOpen?.value).toBe('deploy at 5pm');
  });

  it('renders a dim (edited) suffix once the row carries an editedAt stamp', async () => {
    const plain = await renderRow();
    expect(plain.querySelector('.ch-msg__edited')).toBeNull();

    const row = await renderRow(
      humanMessage({
        body: { text: 'deploy at 5pm', format: 'text' },
        meta: { editedAt: '2026-08-03T01:00:00.000Z' },
      })
    );
    const marker = row.querySelector('.ch-msg__edited');
    expect(marker?.textContent).toBe('(edited)');
    // The stamp itself is available on demand, never as permanent chrome.
    expect(marker?.getAttribute('title')).toContain('2026-08-03T01:00:00.000Z');

    // The marker is suppressed while the editor is open — the row is mid-change,
    // not settled.
    await openEditor(row);
    expect(row.querySelector('.ch-msg__edited')).toBeNull();
  });
});
