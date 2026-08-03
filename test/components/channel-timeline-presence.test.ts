// @vitest-environment happy-dom
//
// #1277 slice 13 — in-timeline agent presence row ("hermes is thinking…").
// Covers the pure projection, the timeline render, and the follow-scroll
// interaction. `ChannelView`-level suppression/empty-channel behaviour lives in
// `channel-view-presence.test.ts`.

import fs from 'node:fs';
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
import { useStreamingPresenceHold } from '../../frontend/src/components/chat/useStreamingPresenceHold.js';
import {
  advanceStreamingHold,
  channelPresenceCopy,
  nextStreamingHoldExpiry,
  sameStreamingHold,
  selectChannelAgentPresence,
  PRESENCE_STREAM_HOLD_MS,
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

describe('advanceStreamingHold (#1277 intra-turn gap)', () => {
  it('holds a just-closed streaming row instead of releasing it immediately', () => {
    const live = advanceStreamingHold(new Map(), [CLAUDE_ID], 1_000);
    expect(live.get(CLAUDE_ID)).toBe(Number.POSITIVE_INFINITY);

    // Item N finalized; item N+1 has not opened yet. Suppression must survive.
    const gap = advanceStreamingHold(live, [], 1_000);
    expect(gap.has(CLAUDE_ID)).toBe(true);
    expect(gap.get(CLAUDE_ID)).toBe(1_000 + PRESENCE_STREAM_HOLD_MS);

    // Still inside the hold window a step later.
    const stillHeld = advanceStreamingHold(gap, [], 1_100);
    expect(stillHeld.get(CLAUDE_ID)).toBe(1_000 + PRESENCE_STREAM_HOLD_MS);

    // Item N+1 opens: back to a live row, deadline discarded.
    const resumed = advanceStreamingHold(stillHeld, [CLAUDE_ID], 1_200);
    expect(resumed.get(CLAUDE_ID)).toBe(Number.POSITIVE_INFINITY);
  });

  it('releases the agent once the hold lapses so a finished turn re-announces', () => {
    const live = advanceStreamingHold(new Map(), [CLAUDE_ID], 1_000);
    const gap = advanceStreamingHold(live, [], 1_000);
    const lapsed = advanceStreamingHold(
      gap,
      [],
      1_000 + PRESENCE_STREAM_HOLD_MS + 1
    );
    expect(lapsed.has(CLAUDE_ID)).toBe(false);

    // Which is what lets a still-busy chip earn a row again.
    expect(
      selectChannelAgentPresence(
        [chip(CLAUDE_ID, 'thinking', 'claude')],
        lapsed
      ).map((row) => row.agentId)
    ).toEqual([CLAUDE_ID]);
  });

  it('holds each agent independently', () => {
    const live = advanceStreamingHold(new Map(), [CLAUDE_ID, HERMES_ID], 1_000);
    const claudeClosed = advanceStreamingHold(live, [HERMES_ID], 1_000);
    expect(claudeClosed.get(CLAUDE_ID)).toBe(1_000 + PRESENCE_STREAM_HOLD_MS);
    expect(claudeClosed.get(HERMES_ID)).toBe(Number.POSITIVE_INFINITY);
  });

  it('reports the earliest pending deadline and ignores live rows', () => {
    expect(nextStreamingHoldExpiry(new Map())).toBeNull();
    expect(
      nextStreamingHoldExpiry(
        new Map([[CLAUDE_ID, Number.POSITIVE_INFINITY]])
      )
    ).toBeNull();
    expect(
      nextStreamingHoldExpiry(
        new Map([
          [CLAUDE_ID, 2_000],
          [HERMES_ID, 1_500],
        ])
      )
    ).toBe(1_500);
  });

  it('compares hold maps entry-wise so an unchanged step can reuse the previous map', () => {
    expect(
      sameStreamingHold(new Map([[CLAUDE_ID, 1]]), new Map([[CLAUDE_ID, 1]]))
    ).toBe(true);
    expect(
      sameStreamingHold(new Map([[CLAUDE_ID, 1]]), new Map([[CLAUDE_ID, 2]]))
    ).toBe(false);
    expect(sameStreamingHold(new Map([[CLAUDE_ID, 1]]), new Map())).toBe(false);
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
    expect(spinner?.classList.contains('tui-progress')).toBe(true);
  });

  it('hides the spinner from assistive tech and announces once per transition', async () => {
    await render([message(1)], [presence(HERMES_ID, 'thinking', 'hermes')]);

    // TuiProgress rewrites its own text every 80ms and hard-codes
    // `role="status"`. Inside a live region that is a ~12x/second announcement
    // flood, so the presence row must hide it: the label already carries the
    // meaning.
    const spinner = host.querySelector('.ch-presence__spinner');
    expect(spinner?.getAttribute('aria-hidden')).toBe('true');

    // Exactly one announcing region for presence — the innermost live region
    // wins, so the enclosing `role="log"` does not also read the row out.
    const region = host.querySelector('.ch-presence');
    expect(region?.getAttribute('role')).toBe('status');
    expect(region?.getAttribute('aria-live')).toBe('polite');
    expect(region?.getAttribute('aria-label')).toBe('agent presence');
  });

  it('tints the glyph with the per-agent color instead of the muted default', async () => {
    await render([message(1)], [presence(HERMES_ID, 'thinking', 'hermes')]);
    const glyph = host.querySelector<HTMLElement>('.ch-presence__glyph');
    expect(glyph?.style.color).toBe('var(--sender-hermes)');

    // `.agent-badge` declares `color: var(--text-muted)` on the svg itself, so
    // the wrapper's inline color only lands if the sheet opts back in. happy-dom
    // does not resolve component stylesheets, so assert the rule directly.
    const css = fs.readFileSync(
      'frontend/src/components/chat/ChannelView.css',
      'utf8'
    );
    expect(css).toMatch(
      /\.ch-presence__glyph \.agent-badge[\s\S]*?{[^}]*color:\s*currentColor/
    );
  });

  it('bottom-anchors the row when it is the only timeline content', async () => {
    await render([], [presence(HERMES_ID, 'thinking', 'hermes')]);
    const content = host.querySelector('.ch-tl-content');
    expect(content?.classList.contains('ch-tl-content--presence-only')).toBe(
      true
    );

    const css = fs.readFileSync(
      'frontend/src/components/chat/ChannelView.css',
      'utf8'
    );
    expect(css).toMatch(
      /\.ch-tl-content--presence-only\s*{[^}]*margin-top:\s*auto/
    );

    // Anti-vacuity: with history behind it the normal top-anchored model stays.
    await render([message(1)], [presence(HERMES_ID, 'thinking', 'hermes')]);
    expect(
      host
        .querySelector('.ch-tl-content')
        ?.classList.contains('ch-tl-content--presence-only')
    ).toBe(false);
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

describe('useStreamingPresenceHold (#1277)', () => {
  let hookHost: HTMLDivElement;
  let hookRoot: Root;

  function Probe({
    live,
  }: {
    live: ReadonlySet<string>;
  }): React.ReactElement {
    const membership = useStreamingPresenceHold(live, 200);
    return React.createElement('span', {
      'data-suppressed': membership.has(CLAUDE_ID) ? 'yes' : 'no',
    });
  }

  async function renderProbe(live: ReadonlySet<string>): Promise<void> {
    await act(async () => {
      hookRoot.render(React.createElement(Probe, { live }));
    });
  }

  function suppressed(): string | null {
    return hookHost
      .querySelector('span')
      ?.getAttribute('data-suppressed') ?? null;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    hookHost = document.createElement('div');
    document.body.appendChild(hookHost);
    hookRoot = createRoot(hookHost);
  });

  afterEach(() => {
    act(() => hookRoot.unmount());
    hookHost.remove();
    vi.useRealTimers();
  });

  it('keeps suppressing across the gap, then releases once the hold lapses', async () => {
    await renderProbe(new Set([CLAUDE_ID]));
    expect(suppressed()).toBe('yes');

    // Streaming row closed — suppression must survive the intra-turn gap.
    await renderProbe(new Set<string>());
    expect(suppressed()).toBe('yes');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(suppressed()).toBe('yes');

    // Nothing re-opened inside the window: the row is allowed back.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });
    expect(suppressed()).toBe('no');
  });

  it('re-arms the hold when a new row opens inside the window', async () => {
    await renderProbe(new Set([CLAUDE_ID]));
    await renderProbe(new Set<string>());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });

    // Item N+1 opens before the deadline.
    await renderProbe(new Set([CLAUDE_ID]));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(suppressed()).toBe('yes');
  });
});
