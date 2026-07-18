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
import type {
  ChannelMessage,
  ChannelMessageId,
} from '../../shared/channel-chat-protocol.js';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function message(seq: number, text = `message ${seq}`): ChannelMessage {
  return {
    schemaVersion: 1,
    id: `chm:${seq}` as ChannelMessageId,
    channelId: 'topic:general',
    seq,
    kind: 'message',
    status: 'complete',
    sender: { kind: 'human', id: 'human:operator' },
    body: { text, format: 'text' },
    threadId: null,
    parentMessageId: null,
    createdAt: `2026-07-18T10:${String(seq).padStart(2, '0')}:00.000Z`,
    updatedAt: `2026-07-18T10:${String(seq).padStart(2, '0')}:00.000Z`,
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

async function render(messages: ChannelMessage[]): Promise<void> {
  await act(async () => {
    root.render(
      React.createElement(ChannelTimeline, {
        messages,
        lastReadSeq: null,
        channelId: 'topic:general',
        channelTitle: 'general',
        hasMoreOlder: false,
        loadingOlder: false,
        loadOlder: async () => {},
        needsCatchup: false,
        onResync: () => {},
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
});
