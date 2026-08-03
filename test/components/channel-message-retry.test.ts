// @vitest-environment happy-dom
//
// #1308 slice 1 item 2 — the retry affordances on a lost agent turn. The row
// derives "can this be retried" from the SAME shared contract the server route
// uses (`channelRetryTarget`), so these assertions are about the affordance
// obeying that contract, not about a component-local heuristic.

import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';

import { ChannelMessageRow } from '../../frontend/src/components/chat/ChannelMessageRow.js';
import { ChannelTimeline } from '../../frontend/src/components/chat/ChannelTimeline.js';
import {
  channelTurnId,
  CHANNEL_RETRY_OF_META_KEY,
  type ChannelMessage,
  type ChannelMessageId,
} from '../../shared/channel-chat-protocol.js';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const CHANNEL_ID = 'topic:operator-lane';
const PROFILE_ID = 'agent-profile:claude:default';
const TRIGGER_ID = 'chm:11111111-2222-4333-8444-555555555555' as ChannelMessageId;
const FAILED_ID = 'chm:66666666-7777-4888-8999-aaaaaaaaaaaa' as ChannelMessageId;

function triggerRow(): ChannelMessage {
  return {
    schemaVersion: 1,
    id: TRIGGER_ID,
    channelId: CHANNEL_ID,
    seq: 4,
    kind: 'message',
    status: 'complete',
    sender: { kind: 'human', id: 'human:operator' },
    body: { text: '@claude ship the anchor', format: 'text' },
    threadId: null,
    parentMessageId: null,
    createdAt: '2026-08-03T00:00:00.000Z',
    updatedAt: '2026-08-03T00:00:00.000Z',
  };
}

function agentRow(overrides: Partial<ChannelMessage> = {}): ChannelMessage {
  return {
    schemaVersion: 1,
    id: FAILED_ID,
    channelId: CHANNEL_ID,
    seq: 5,
    kind: 'message',
    status: 'failed',
    sender: { kind: 'agent', id: PROFILE_ID, providerId: 'claude' },
    body: { text: 'half a re', format: 'markdown' },
    threadId: null,
    parentMessageId: null,
    source: {
      runtimeId: 'runtime:claude',
      turnId: channelTurnId(TRIGGER_ID, PROFILE_ID),
      itemId: 'assistant-0',
    },
    createdAt: '2026-08-03T00:00:01.000Z',
    updatedAt: '2026-08-03T00:00:02.000Z',
    ...overrides,
  };
}

describe('ChannelMessageRow retry affordance', () => {
  let container: HTMLDivElement;
  let root: Root;

  async function renderRow(
    props: Partial<React.ComponentProps<typeof ChannelMessageRow>> = {}
  ): Promise<HTMLElement> {
    await act(async () => {
      root.render(
        React.createElement(ChannelMessageRow, {
          message: agentRow(),
          channelId: CHANNEL_ID,
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

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('fires the retry lane exactly once per click, with the failed row', async () => {
    const onRetry = vi.fn(async () => {});
    const row = await renderRow({ onRetry });

    const inline = row.querySelector<HTMLButtonElement>('.ch-msg__retry');
    expect(inline).not.toBeNull();
    await act(async () => inline?.click());

    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry.mock.calls[0]?.[0]).toMatchObject({ id: FAILED_ID });
  });

  it('disables retry while the bound agent is busy in this channel', async () => {
    const onRetry = vi.fn(async () => {});
    const row = await renderRow({ onRetry, retryBusy: true });

    const inline = row.querySelector<HTMLButtonElement>('.ch-msg__retry');
    expect(inline?.disabled).toBe(true);
    expect(inline?.getAttribute('title')).toBe('agent is busy');
    await act(async () => inline?.click());
    expect(onRetry).not.toHaveBeenCalled();

    await hover(row);
    const toolbarRetry = row.querySelector<HTMLButtonElement>(
      '.ch-msg__actions [aria-label="retry this reply"]'
    );
    expect(toolbarRetry?.disabled).toBe(true);
  });

  it('holds a single in-flight retry: a second click cannot stack a turn', async () => {
    let release: (() => void) | undefined;
    const onRetry = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        })
    );
    const row = await renderRow({ onRetry });
    const inline = row.querySelector<HTMLButtonElement>('.ch-msg__retry');

    await act(async () => inline?.click());
    const pending = row.querySelector<HTMLButtonElement>('.ch-msg__retry');
    expect(pending?.disabled).toBe(true);
    expect(pending?.textContent).toContain('retrying');

    await act(async () => pending?.click());
    expect(onRetry).toHaveBeenCalledTimes(1);

    await act(async () => {
      release?.();
    });
    expect(
      row.querySelector<HTMLButtonElement>('.ch-msg__retry')?.disabled
    ).toBe(false);
  });

  it('replaces the button with a `retried` mark once a retry superseded the row', async () => {
    const onRetry = vi.fn(async () => {});
    const row = await renderRow({ onRetry, retried: true });

    expect(row.querySelector('.ch-msg__retry')).toBeNull();
    expect(row.querySelector('.ch-msg__tag--retried')?.textContent).toBe(
      'retried'
    );
  });

  it('offers interrupted/truncated retry in the toolbar but not inline', async () => {
    const onRetry = vi.fn(async () => {});
    for (const status of ['interrupted', 'truncated'] as const) {
      const row = await renderRow({
        message: agentRow({ status }),
        onRetry,
      });
      expect(row.querySelector('.ch-msg__retry')).toBeNull();
      await hover(row);
      expect(
        row.querySelector('.ch-msg__actions [aria-label="retry this reply"]')
      ).not.toBeNull();
    }
  });

  it('offers nothing when no routed turn can be recovered', async () => {
    const onRetry = vi.fn(async () => {});
    // A completed reply, and a failed row whose turn id the binder never minted
    // (a provider-labelled item) — neither names a trigger to re-route.
    for (const message of [
      agentRow({ status: 'complete' }),
      agentRow({
        source: {
          runtimeId: 'runtime:hermes',
          turnId: 'turn-0',
          itemId: 'assistant-0',
        },
      }),
    ]) {
      const row = await renderRow({ message, onRetry });
      expect(row.querySelector('.ch-msg__retry')).toBeNull();
      await hover(row);
      expect(
        row.querySelector('.ch-msg__actions [aria-label="retry this reply"]')
      ).toBeNull();
    }
  });
});

describe('ChannelTimeline retry wiring', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function renderTimeline(
    messages: ChannelMessage[],
    props: Partial<React.ComponentProps<typeof ChannelTimeline>> = {}
  ): Promise<void> {
    await act(async () => {
      root.render(
        React.createElement(ChannelTimeline, {
          messages,
          lastReadSeq: null,
          channelId: CHANNEL_ID,
          channelTitle: 'operator lane',
          hasMoreOlder: false,
          loadingOlder: false,
          loadOlder: async () => {},
          fullSnapshotRevision: 0,
          needsCatchup: false,
          onResync: () => {},
          ...props,
        })
      );
    });
  }

  it('retries without ever re-posting the human message', async () => {
    const onRetryMessage = vi.fn(async () => {});
    const messages = [triggerRow(), agentRow()];
    await renderTimeline(messages, { onRetryMessage });

    const rendered = () =>
      Array.from(
        container.querySelectorAll<HTMLElement>('[data-channel-message-id]')
      ).map((node) => node.dataset['channelMessageId']);
    expect(rendered()).toEqual([TRIGGER_ID, FAILED_ID]);

    const inline = container.querySelector<HTMLButtonElement>('.ch-msg__retry');
    await act(async () => inline?.click());
    expect(onRetryMessage).toHaveBeenCalledTimes(1);

    // The server answers with a supersede system row plus a fresh agent row —
    // and NOT with a second copy of the operator's message.
    const superseded: ChannelMessage = {
      ...triggerRow(),
      id: 'chm:sys-1' as ChannelMessageId,
      seq: 6,
      kind: 'system',
      sender: { kind: 'system', id: 'system' },
      body: { text: 'retrying @claude — previous reply failed', format: 'text' },
      meta: { [CHANNEL_RETRY_OF_META_KEY]: FAILED_ID },
    };
    await renderTimeline([...messages, superseded], { onRetryMessage });

    expect(
      rendered().filter((id) => id === TRIGGER_ID)
    ).toHaveLength(1);
    expect(container.querySelector('.ch-msg__retry')).toBeNull();
    expect(container.querySelector('.ch-msg__tag--retried')).not.toBeNull();
  });

  it('propagates the busy set so a mid-turn agent cannot be re-fired', async () => {
    const onRetryMessage = vi.fn(async () => {});
    await renderTimeline([triggerRow(), agentRow()], {
      onRetryMessage,
      busyAgentIds: new Set([PROFILE_ID]),
    });

    const inline = container.querySelector<HTMLButtonElement>('.ch-msg__retry');
    expect(inline?.disabled).toBe(true);
    await act(async () => inline?.click());
    expect(onRetryMessage).not.toHaveBeenCalled();
  });
});
