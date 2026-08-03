// @vitest-environment happy-dom
//
// #1277 slice 13 — in-timeline agent presence row ("hermes is thinking…").
// Covers the pure projection, the timeline render, and the follow-scroll
// interaction. `ChannelView`-level suppression/empty-channel behaviour lives in
// `channel-view-presence.test.ts`.

import React, { act } from 'react';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { ChannelTimeline } from '../../frontend/src/components/chat/ChannelTimeline.js';
import {
  channelPresenceCopy,
  selectChannelAgentPresence,
  type ChannelAgentPresence,
  type ChannelPresenceChip,
} from '../../frontend/src/lib/chat/channel-agent-presence.js';
import type { ChannelAgentStatus } from '../../frontend/src/lib/api.js';
import type {
  ChannelMessage,
  ChannelMessageId,
} from '../../shared/channel-chat-protocol.js';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const HERMES_ID = 'agent-profile:hermes:default';
const CLAUDE_ID = 'agent-profile:claude:default';

function chip(
  agentId: string,
  status: ChannelAgentStatus,
  label: string
): ChannelPresenceChip {
  return {
    agentId,
    status,
    identity: { label, colorVar: 'var(--sender-hermes)', glyph: 'hermes' },
  };
}

function presence(
  agentId: string,
  status: ChannelAgentPresence['status'],
  label: string
): ChannelAgentPresence {
  return {
    agentId,
    status,
    label,
    colorVar: 'var(--sender-hermes)',
    glyph: 'hermes',
  };
}

function message(seq: number, own = false): ChannelMessage {
  return {
    schemaVersion: 1,
    id: `chm:${seq}` as ChannelMessageId,
    channelId: 'topic:general',
    seq,
    kind: 'message',
    status: 'complete',
    sender: own
      ? { kind: 'human', id: 'human:operator' }
      : { kind: 'agent', id: HERMES_ID, providerId: 'hermes' },
    body: { text: `message ${seq}`, format: 'text' },
    threadId: null,
    parentMessageId: null,
    createdAt: `2026-07-18T10:${String(seq).padStart(2, '0')}:00.000Z`,
    updatedAt: `2026-07-18T10:${String(seq).padStart(2, '0')}:00.000Z`,
  };
}

describe('selectChannelAgentPresence (#1277)', () => {
  it('keeps every busy agent and drops idle ones', () => {
    const rows = selectChannelAgentPresence(
      [
        chip(HERMES_ID, 'thinking', 'hermes'),
        chip(CLAUDE_ID, 'idle', 'claude'),
      ],
      new Set<string>()
    );
    expect(rows.map((row) => row.agentId)).toEqual([HERMES_ID]);
    expect(rows[0]?.status).toBe('thinking');
  });

  it('suppresses only the agents that already own a live streaming row', () => {
    const chips = [
      chip(HERMES_ID, 'thinking', 'hermes'),
      chip(CLAUDE_ID, 'streaming', 'claude'),
    ];
    // Anti-vacuity: with an empty suppression set BOTH rows survive, so the
    // single-row result below is caused by the suppression input and nothing
    // else about these chips.
    expect(
      selectChannelAgentPresence(chips, new Set<string>()).map((r) => r.agentId)
    ).toEqual([HERMES_ID, CLAUDE_ID]);

    expect(
      selectChannelAgentPresence(chips, new Set([CLAUDE_ID])).map(
        (r) => r.agentId
      )
    ).toEqual([HERMES_ID]);
  });

  it('suppresses on streaming-row membership, not on streaming status', () => {
    // Status flipped to `streaming` before the bridge opened a row: nothing is
    // drawing a block cursor yet, so the presence row must still announce it.
    const rows = selectChannelAgentPresence(
      [chip(CLAUDE_ID, 'streaming', 'claude')],
      new Set<string>()
    );
    expect(rows).toHaveLength(1);
    expect(channelPresenceCopy(rows[0]!)).toBe('claude is responding…');
  });

  it('accepts a Map (the reducer-derived streaming provider index) as the suppression set', () => {
    const streaming = new Map<string, string | undefined>([
      [CLAUDE_ID, 'claude'],
    ]);
    expect(
      selectChannelAgentPresence(
        [chip(CLAUDE_ID, 'streaming', 'claude')],
        streaming
      )
    ).toEqual([]);
  });

  it('reads spawning and thinking as one operator-facing verb', () => {
    expect(channelPresenceCopy(presence(HERMES_ID, 'spawning', 'hermes'))).toBe(
      'hermes is thinking…'
    );
    expect(channelPresenceCopy(presence(HERMES_ID, 'thinking', 'hermes'))).toBe(
      'hermes is thinking…'
    );
    expect(channelPresenceCopy(presence(HERMES_ID, 'waiting', 'hermes'))).toBe(
      'hermes is waiting for input'
    );
  });
});

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
  agentPresence: ChannelAgentPresence[]
): Promise<void> {
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
        fullSnapshotRevision: 0,
        needsCatchup: false,
        onResync: () => {},
        agentPresence,
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

describe('ChannelTimeline presence row (#1277)', () => {
  beforeEach(() => {
    timelineScrollHeight = 1_000;
    timelineClientHeight = 300;
    resizeCallback = null;
    vi.stubGlobal('matchMedia', () => ({
      matches: false,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  it('renders one row per busy agent at the foot of the timeline content', async () => {
    await render(
      [message(1)],
      [
        presence(HERMES_ID, 'thinking', 'hermes'),
        presence(CLAUDE_ID, 'waiting', 'claude'),
      ]
    );

    const rows = host.querySelectorAll('.ch-presence__row');
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain('hermes is thinking…');
    expect(rows[1]?.textContent).toContain('claude is waiting for input');

    // Foot of the conversation, inside the observed content element.
    const content = host.querySelector('.ch-tl-content');
    expect(content?.lastElementChild?.classList.contains('ch-presence')).toBe(
      true
    );
  });

  it('renders nothing when no agent is busy', async () => {
    await render([message(1)], []);
    expect(host.querySelector('.ch-presence')).toBeNull();
  });

  it('carries no message seq, so it can never become a scroll anchor', async () => {
    await render([message(1)], [presence(HERMES_ID, 'thinking', 'hermes')]);
    const row = host.querySelector('.ch-presence__row');
    expect(row).not.toBeNull();
    expect(row?.hasAttribute('data-channel-message-seq')).toBe(false);
    expect(
      host.querySelectorAll('[data-channel-message-seq]')
    ).toHaveLength(1);
  });

  it('uses the shared braille spinner as its only motion', async () => {
    await render([message(1)], [presence(HERMES_ID, 'thinking', 'hermes')]);
    const spinner = host.querySelector('.ch-presence__spinner');
    expect(spinner).not.toBeNull();
    expect(spinner?.getAttribute('role')).toBe('status');
    expect(spinner?.classList.contains('tui-progress')).toBe(true);
  });

  it('still renders under prefers-reduced-motion', async () => {
    vi.stubGlobal('matchMedia', () => ({
      matches: true,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    await render([message(1)], [presence(HERMES_ID, 'thinking', 'hermes')]);

    const row = host.querySelector('.ch-presence__row');
    expect(row?.textContent).toContain('hermes is thinking…');
    // TuiProgress freezes on frame 0 rather than disappearing.
    expect(host.querySelector('.ch-presence__spinner')?.textContent).toBe(
      '⠋'
    );
  });

  it('does not inflate the new-message pill when the row appears or clears', async () => {
    await render([message(1), message(2)], []);
    await userScroll(200);
    expect(host.querySelector('.ch-new-messages')).toBeNull();

    // Row appears (agent started thinking) — no message seq changed.
    timelineScrollHeight = 1_100;
    await render(
      [message(1), message(2)],
      [presence(HERMES_ID, 'thinking', 'hermes')]
    );
    await act(async () => resizeCallback?.([], {} as ResizeObserver));
    expect(host.querySelector('.ch-new-messages')).toBeNull();
    expect(timeline().scrollTop).toBe(200);

    // Row clears again — still no pill, reader still parked.
    timelineScrollHeight = 1_000;
    await render([message(1), message(2)], []);
    await act(async () => resizeCallback?.([], {} as ResizeObserver));
    expect(host.querySelector('.ch-new-messages')).toBeNull();
    expect(timeline().scrollTop).toBe(200);
  });

  it('keeps a follower stuck to the bottom across presence growth and shrink', async () => {
    await render([message(1), message(2)], []);
    expect(timeline().scrollTop).toBe(1_000);

    timelineScrollHeight = 1_100;
    await render(
      [message(1), message(2)],
      [presence(HERMES_ID, 'thinking', 'hermes')]
    );
    await act(async () => resizeCallback?.([], {} as ResizeObserver));
    expect(timeline().scrollTop).toBe(1_100);

    timelineScrollHeight = 1_000;
    await render([message(1), message(2)], []);
    await act(async () => resizeCallback?.([], {} as ResizeObserver));
    expect(timeline().scrollTop).toBe(1_000);
  });
});
