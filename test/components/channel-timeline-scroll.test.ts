// @vitest-environment happy-dom

import React, { act } from 'react';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { ChannelTimeline } from '../../frontend/src/components/chat/ChannelTimeline.js';
import { useReasoningDetailSettingsStore } from '../../frontend/src/lib/stores/reasoning-detail-settings.js';
import type {
  ChannelMessage,
  ChannelMessageId,
} from '../../shared/channel-chat-protocol.js';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function message(
  seq: number,
  text = `message ${seq}`,
  own = false
): ChannelMessage {
  return {
    schemaVersion: 1,
    id: `chm:${seq}` as ChannelMessageId,
    channelId: 'topic:general',
    seq,
    kind: 'message',
    status: 'complete',
    sender: own
      ? { kind: 'human', id: 'human:operator' }
      : { kind: 'agent', id: 'agent:codex', providerId: 'codex' },
    body: { text, format: 'text' },
    threadId: null,
    parentMessageId: null,
    createdAt: `2026-07-18T10:${String(seq).padStart(2, '0')}:00.000Z`,
    updatedAt: `2026-07-18T10:${String(seq).padStart(2, '0')}:00.000Z`,
  };
}

function detailMessage(seq: number): ChannelMessage {
  return {
    ...message(seq, ''),
    body: { text: '', format: 'markdown' },
    agentDetail: {
      itemId: `detail-${seq}`,
      card: {
        kind: 'output',
        title: 'durable output',
        status: 'completed',
        content: 'expanded durable card content',
      },
    },
  };
}

function reasoningMessage(
  seq: number,
  messageStatus: 'streaming' | 'complete' = 'streaming'
): ChannelMessage {
  return {
    ...message(seq, ''),
    status: messageStatus,
    body: { text: '', format: 'markdown' },
    agentDetail: {
      itemId: 'reasoning-stable-item',
      card: {
        kind: 'thought',
        title: 'provider summary title',
        status: messageStatus === 'streaming' ? 'running' : 'completed',
        content:
          messageStatus === 'streaming' ? 'retained reasoning content' : '   ',
      },
    },
  };
}

let host: HTMLDivElement;
let root: Root;
let timelineScrollHeight = 1_000;
let timelineClientHeight = 300;
let resizeCallback: ResizeObserverCallback | null = null;

const originalScrollHeight = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  'scrollHeight'
);
const originalClientHeight = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  'clientHeight'
);
const OriginalResizeObserver = globalThis.ResizeObserver;

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
    configurable: true,
    get() {
      return (this as HTMLElement).classList.contains('ch-tl')
        ? timelineScrollHeight
        : 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get() {
      return (this as HTMLElement).classList.contains('ch-tl')
        ? timelineClientHeight
        : 0;
    },
  });
  globalThis.ResizeObserver = class ResizeObserverMock {
    constructor(callback: ResizeObserverCallback) {
      resizeCallback = callback;
    }
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {
      resizeCallback = null;
    }
  };
});

afterAll(() => {
  if (originalScrollHeight) {
    Object.defineProperty(
      HTMLElement.prototype,
      'scrollHeight',
      originalScrollHeight
    );
  }
  if (originalClientHeight) {
    Object.defineProperty(
      HTMLElement.prototype,
      'clientHeight',
      originalClientHeight
    );
  }
  globalThis.ResizeObserver = OriginalResizeObserver;
});

async function render(
  messages: ChannelMessage[],
  options: {
    hasMoreOlder?: boolean;
    loadingOlder?: boolean;
    loadOlder?: () => Promise<void>;
    fullSnapshotRevision?: number;
    lastReadSeq?: number | null;
    collapseCompletedAgentActivity?: boolean;
  } = {}
): Promise<void> {
  await act(async () => {
    root.render(
      React.createElement(ChannelTimeline, {
        messages,
        lastReadSeq: options.lastReadSeq ?? null,
        channelId: 'topic:general',
        channelTitle: 'general',
        hasMoreOlder: options.hasMoreOlder ?? false,
        loadingOlder: options.loadingOlder ?? false,
        loadOlder: options.loadOlder ?? (async () => {}),
        fullSnapshotRevision: options.fullSnapshotRevision ?? 0,
        needsCatchup: false,
        onResync: () => {},
        collapseCompletedAgentActivity:
          options.collapseCompletedAgentActivity ?? false,
      })
    );
  });
}

function timeline(): HTMLDivElement {
  const element = host.querySelector<HTMLDivElement>('.ch-tl');
  if (!element) throw new Error('timeline not rendered');
  return element;
}

async function userScroll(scrollTop: number): Promise<void> {
  const element = timeline();
  element.scrollTop = scrollTop;
  await act(async () => {
    element.dispatchEvent(new Event('scroll'));
  });
}

describe('ChannelTimeline scroll model (#1193)', () => {
  beforeEach(() => {
    useReasoningDetailSettingsStore.getState().reset();
    timelineScrollHeight = 1_000;
    timelineClientHeight = 300;
    resizeCallback = null;
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it('opens at the bottom and follows an append larger than the threshold', async () => {
    await render([message(1), message(2)]);
    expect(timeline().scrollTop).toBe(1_000);

    await userScroll(700);
    timelineScrollHeight = 2_000;
    await render([message(1), message(2), message(3, 'large append')]);
    expect(timeline().scrollTop).toBe(2_000);
    expect(host.querySelector('.ch-new-messages')).toBeNull();
  });

  it('folds completed agent activity without hiding prose or live activity', async () => {
    const liveDetail = {
      ...detailMessage(4),
      status: 'streaming' as const,
      agentDetail: {
        itemId: 'live-4',
        card: {
          kind: 'thought' as const,
          title: 'thinking',
          status: 'running' as const,
          content: 'live reasoning',
        },
      },
    };
    await render(
      [
        message(1, 'assistant prose'),
        detailMessage(2),
        {
          ...detailMessage(3),
          agentDetail: {
            itemId: 'tool-3',
            card: {
              kind: 'tool_call',
              title: 'read file',
              status: 'completed',
              content: 'src/file.ts',
            },
          },
        },
        liveDetail,
      ],
      { collapseCompletedAgentActivity: true }
    );

    const summary = host.querySelector<HTMLButtonElement>('.ch-activity-run');
    expect(summary?.textContent).toContain('2 agent events');
    expect(summary?.textContent).toContain('1 output');
    expect(summary?.textContent).toContain('1 tool call');
    expect(summary?.getAttribute('aria-expanded')).toBe('false');
    expect(summary?.getAttribute('data-channel-message-seq')).toBe('3');
    expect(summary?.getAttribute('data-channel-activity-start-seq')).toBe('2');
    expect(summary?.getAttribute('data-channel-activity-end-seq')).toBe('3');
    const chevron = summary?.querySelector('svg');
    expect(chevron?.getAttribute('aria-hidden')).toBe('true');
    expect(chevron?.getAttribute('fill')).toBe('none');
    expect(chevron?.getAttribute('stroke-width')).toBe('1.5');
    expect(chevron?.getAttribute('stroke-linecap')).toBe('square');
    expect(host.querySelector('[data-channel-message-id="chm:2"]')).toBeNull();
    expect(host.querySelector('[data-channel-message-id="chm:3"]')).toBeNull();
    expect(host.textContent).toContain('assistant prose');
    expect(host.querySelector('[data-channel-message-id="chm:4"]')).not.toBeNull();
    expect(host.textContent).toContain('reasoning…');

    await act(async () => summary?.click());
    expect(summary?.getAttribute('aria-expanded')).toBe('true');
    expect(summary?.getAttribute('data-channel-message-seq')).toBe('3');
    expect(summary?.getAttribute('data-channel-activity-start-seq')).toBe('2');
    expect(summary?.getAttribute('data-channel-activity-end-seq')).toBe('3');
    expect(host.querySelector('[data-channel-message-id="chm:2"]')).not.toBeNull();
    expect(host.querySelector('[data-channel-message-id="chm:3"]')).not.toBeNull();
  });

  it('keeps scrollTop stable while up, counts appended rows, then jumps and clears', async () => {
    await render([message(1), message(2)]);
    await userScroll(200);

    timelineScrollHeight = 1_300;
    await render([message(1), message(2), message(3), message(4), message(5)]);
    expect(timeline().scrollTop).toBe(200);
    const jump = host.querySelector<HTMLButtonElement>('.ch-new-messages');
    expect(jump?.textContent).toBe('3 new messages');

    await act(async () => jump?.click());
    expect(timeline().scrollTop).toBe(1_300);
    expect(host.querySelector('.ch-new-messages')).toBeNull();
  });

  it('returns to the bottom for an own human append while scrolled up', async () => {
    await render([message(1), message(2)]);
    await userScroll(200);

    timelineScrollHeight = 1_300;
    await render([message(1), message(2), message(3, 'mine', true)]);

    expect(timeline().scrollTop).toBe(1_300);
    expect(host.querySelector('.ch-new-messages')).toBeNull();
  });

  it('uses the saved follow intent for streaming and viewport resizes', async () => {
    await render([message(1), message(2)]);
    await userScroll(700);

    timelineScrollHeight = 1_600;
    await render([message(1), message(2, 'streamed content')]);
    await act(async () => resizeCallback?.([], {} as ResizeObserver));
    expect(timeline().scrollTop).toBe(1_600);

    await userScroll(200);
    timelineClientHeight = 180;
    await act(async () => resizeCallback?.([], {} as ResizeObserver));
    expect(timeline().scrollTop).toBe(200);
  });

  it('keeps follow when content growth emits scroll before ResizeObserver', async () => {
    await render([message(1), message(2)]);
    await userScroll(700);

    timelineScrollHeight = 1_320;
    await userScroll(700);

    expect(timeline().scrollTop).toBe(1_320);
  });

  it('does not treat a reader-away growth scroll as follow intent', async () => {
    await render([message(1), message(2)]);
    await userScroll(200);

    timelineScrollHeight = 1_320;
    await userScroll(200);
    await act(async () => resizeCallback?.([], {} as ResizeObserver));

    expect(timeline().scrollTop).toBe(200);
  });

  it('bottom-anchors card expansion only while following', async () => {
    await render([message(1), detailMessage(2)]);
    await userScroll(700);
    const toggle = host.querySelector<HTMLButtonElement>(
      '.ch-agent-card__toggle'
    );
    if (!toggle) throw new Error('missing durable card toggle');

    await act(async () => {
      toggle.click();
      timelineScrollHeight = 1_320;
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => resolve())
      );
    });
    expect(timeline().scrollTop).toBe(1_320);

    await userScroll(200);
    await act(async () => {
      toggle.click();
      timelineScrollHeight = 1_000;
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => resolve())
      );
    });
    expect(timeline().scrollTop).toBe(200);
  });

  it('restores the visible reader anchor across a non-following reflow', async () => {
    await render([message(1), message(2)]);
    const firstRow = host.querySelector<HTMLElement>(
      '[data-channel-message-seq="1"]'
    );
    if (!firstRow) throw new Error('missing first message row');
    let rowTop = 40;
    firstRow.getBoundingClientRect = () =>
      ({
        x: 0,
        y: rowTop,
        top: rowTop,
        left: 0,
        right: 100,
        bottom: rowTop + 20,
        width: 100,
        height: 20,
        toJSON: () => ({}),
      }) as DOMRect;
    await userScroll(200);

    rowTop = 80;
    await act(async () => resizeCallback?.([], {} as ResizeObserver));
    expect(timeline().scrollTop).toBe(240);
  });

  it('disengages follow when scrolling to the top of a low-overflow timeline before prepend growth', async () => {
    timelineScrollHeight = 400;
    timelineClientHeight = 300;
    await render([message(3), message(4)]);

    await userScroll(0);
    timelineScrollHeight = 480;
    await render([message(1), message(2), message(3), message(4)]);
    await act(async () => resizeCallback?.([], {} as ResizeObserver));

    expect(timeline().scrollTop).toBe(0);
  });

  it('keeps a follower bottomed across an authoritative lower-seq snapshot', async () => {
    await render([message(99), message(100)]);

    timelineScrollHeight = 800;
    await render([message(1), message(2)]);
    expect(timeline().scrollTop).toBe(800);
  });

  it('does not hijack a reader on a lower-seq reset and counts the next append from the reset baseline', async () => {
    await render([message(99), message(100)]);
    await userScroll(200);

    timelineScrollHeight = 800;
    await render([message(1), message(2)]);
    expect(timeline().scrollTop).toBe(200);
    expect(host.querySelector('.ch-new-messages')).toBeNull();

    timelineScrollHeight = 1_100;
    await render([message(1), message(2), message(3)]);
    expect(timeline().scrollTop).toBe(200);
    expect(host.querySelector('.ch-new-messages')?.textContent).toBe(
      '1 new message'
    );
  });

  it('removes empty terminal reasoning before timeline grouping', async () => {
    await render([reasoningMessage(1)]);
    expect(host.querySelectorAll('.ch-group')).toHaveLength(1);
    expect(host.querySelector('.ch-group__header')).not.toBeNull();

    await render([reasoningMessage(1, 'complete')]);
    expect(host.querySelector('.ch-group')).toBeNull();
    expect(host.querySelector('.ch-group__header')).toBeNull();
    expect(host.querySelector('.ch-day-divider')).toBeNull();
  });

  it('preserves a same-item manual override when its message group remounts', async () => {
    await render([reasoningMessage(2)]);
    const toggle = host.querySelector<HTMLButtonElement>(
      '.ch-agent-card__toggle'
    );
    expect(toggle?.getAttribute('aria-expanded')).toBe('false');
    await act(async () => toggle?.click());
    expect(toggle?.getAttribute('aria-expanded')).toBe('true');

    // Prepending a same-sender row changes the group's React key from the
    // reasoning message id to the new first id, remounting all grouped rows.
    await render([message(1, 'earlier agent prose'), reasoningMessage(2)]);
    const remounted = host.querySelector<HTMLButtonElement>(
      '.ch-agent-card__toggle'
    );
    expect(remounted).not.toBe(toggle);
    expect(remounted?.getAttribute('aria-expanded')).toBe('true');
    expect(host.querySelector('.ch-agent-card__body')?.textContent).toContain(
      'retained reasoning content'
    );
  });
});
