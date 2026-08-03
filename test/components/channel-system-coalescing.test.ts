// @vitest-environment happy-dom
//
// #1308 slice 1 item 5 — consecutive system rows coalesce into one run.
// Two layers, because they own different halves of the behaviour: the pure
// builder decides where a run STARTS and STOPS (the boundary cases), and the
// real `ChannelTimeline` decides whether a run is folded and how it opens.
// The renderer is mounted rather than stubbed so the fold is proven against the
// same DOM the live lane produces — including the day-divider, unread-line and
// #1306 presence rows a run has to interleave with.

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
import {
  buildTimelineNodes,
  SYSTEM_RUN_COLLAPSE_MIN,
  type TimelineNode,
} from '../../frontend/src/lib/chat/channel-timeline-layout.js';
import type { ChannelAgentPresence } from '../../frontend/src/lib/chat/channel-agent-presence.js';
import type {
  ChannelMessage,
  ChannelMessageId,
} from '../../shared/channel-chat-protocol.js';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

// Day-boundary assertions are local-calendar sensitive — pin TZ so the
// `23:58Z → 00:01Z` pair really straddles midnight on every machine (#1178).
const originalTz = process.env.TZ;
beforeAll(() => {
  process.env.TZ = 'UTC';
});
afterAll(() => {
  if (originalTz === undefined) delete process.env.TZ;
  else process.env.TZ = originalTz;
});

const CHANNEL_ID = 'topic:operator-lane';

function base(seq: number, overrides: Partial<ChannelMessage>): ChannelMessage {
  return {
    schemaVersion: 1,
    id: `chm:row-${seq}` as ChannelMessageId,
    channelId: CHANNEL_ID,
    seq,
    kind: 'message',
    status: 'complete',
    sender: { kind: 'human', id: 'human:operator' },
    body: { text: `row ${seq}`, format: 'text' },
    threadId: null,
    parentMessageId: null,
    createdAt: '2026-08-03T10:00:00.000Z',
    updatedAt: '2026-08-03T10:00:00.000Z',
    ...overrides,
  };
}

function sys(seq: number, overrides: Partial<ChannelMessage> = {}) {
  return base(seq, {
    kind: 'system',
    sender: { kind: 'system', id: 'system' },
    body: { text: `system note ${seq}`, format: 'text' },
    ...overrides,
  });
}

function human(seq: number, overrides: Partial<ChannelMessage> = {}) {
  return base(seq, overrides);
}

function runSeqs(nodes: TimelineNode[]): number[][] {
  return nodes
    .filter((node): node is Extract<TimelineNode, { kind: 'system' }> =>
      Boolean(node.kind === 'system')
    )
    .map((node) => node.messages.map((message) => message.seq));
}

function kinds(nodes: TimelineNode[]): string[] {
  return nodes.map((node) => node.kind);
}

describe('buildTimelineNodes — system-event coalescing (#1308 item 5)', () => {
  it('folds consecutive system rows into ONE run node', () => {
    const nodes = buildTimelineNodes([sys(1), sys(2), sys(3)], null);
    expect(kinds(nodes)).toEqual(['day-divider', 'system']);
    expect(runSeqs(nodes)).toEqual([[1, 2, 3]]);
  });

  it('breaks the run at an interleaved human message', () => {
    const nodes = buildTimelineNodes(
      [sys(1), sys(2), human(3), sys(4), sys(5)],
      null
    );
    expect(kinds(nodes)).toEqual(['day-divider', 'system', 'group', 'system']);
    expect(runSeqs(nodes)).toEqual([
      [1, 2],
      [4, 5],
    ]);
  });

  it('breaks the run at a day divider', () => {
    const nodes = buildTimelineNodes(
      [
        sys(1, { createdAt: '2026-08-03T23:57:00.000Z' }),
        sys(2, { createdAt: '2026-08-03T23:58:00.000Z' }),
        sys(3, { createdAt: '2026-08-04T00:01:00.000Z' }),
        sys(4, { createdAt: '2026-08-04T00:02:00.000Z' }),
      ],
      null
    );
    // The divider must sit BETWEEN the two runs, never swallowed inside one.
    expect(kinds(nodes)).toEqual([
      'day-divider',
      'system',
      'day-divider',
      'system',
    ]);
    expect(runSeqs(nodes)).toEqual([
      [1, 2],
      [3, 4],
    ]);
  });

  it('breaks the run at the unread line', () => {
    const nodes = buildTimelineNodes([sys(1), sys(2), sys(3), sys(4)], 2);
    expect(kinds(nodes)).toEqual([
      'day-divider',
      'system',
      'unread-line',
      'system',
    ]);
    expect(runSeqs(nodes)).toEqual([
      [1, 2],
      [3, 4],
    ]);
  });

  it('leaves an approval row standing alone and breaks the run around it', () => {
    // The approval row owns approve/deny buttons — folding it behind a summary
    // would hide an action the operator is being asked to take.
    const nodes = buildTimelineNodes(
      [
        sys(1),
        sys(2),
        sys(3, { meta: { approvalRequestId: 'req-1', agentId: 'a' } }),
        sys(4),
        sys(5),
      ],
      null
    );
    expect(runSeqs(nodes)).toEqual([[1, 2], [3], [4, 5]]);
  });

  it('emits a single-message run for a lone system row', () => {
    const nodes = buildTimelineNodes([human(1), sys(2), human(3)], null);
    expect(kinds(nodes)).toEqual(['day-divider', 'group', 'system', 'group']);
    expect(runSeqs(nodes)).toEqual([[2]]);
  });
});

describe('ChannelTimeline — system-run fold', () => {
  let container: HTMLDivElement;
  let root: Root;

  const baseProps = {
    lastReadSeq: null,
    channelId: CHANNEL_ID,
    channelTitle: 'operator lane',
    hasMoreOlder: false,
    loadingOlder: false,
    loadOlder: async () => {},
    fullSnapshotRevision: 0,
    needsCatchup: false,
    onResync: () => {},
  };

  async function render(
    props: Record<string, unknown> & { messages: ChannelMessage[] }
  ): Promise<void> {
    await act(async () => {
      root.render(
        React.createElement(ChannelTimeline, { ...baseProps, ...props })
      );
    });
  }

  function summary(): HTMLButtonElement | null {
    return container.querySelector<HTMLButtonElement>('.ch-system-run');
  }

  function systemRowTexts(): string[] {
    return Array.from(container.querySelectorAll('.ch-system-msg__label')).map(
      (node) => node.textContent ?? ''
    );
  }

  let originalScrollIntoView: typeof Element.prototype.scrollIntoView;

  beforeEach(() => {
    originalScrollIntoView = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = () => {};
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    Element.prototype.scrollIntoView = originalScrollIntoView;
  });

  it(`folds a run of ${SYSTEM_RUN_COLLAPSE_MIN} into one summary the operator can open and close`, async () => {
    await render({ messages: [sys(1), sys(2), sys(3)] });

    const button = summary();
    expect(button).not.toBeNull();
    expect(button?.textContent).toContain('3 system events');
    expect(button?.getAttribute('aria-expanded')).toBe('false');
    // Folded rows are OUT of the DOM — that is the whole point of the fold.
    expect(systemRowTexts()).toEqual([]);
    // While folded the summary stands in for the run's last seq so the reader
    // anchor in `useFollowingScroll` still has a row to hold onto.
    expect(button?.getAttribute('data-channel-message-seq')).toBe('3');

    await act(async () => {
      button?.click();
    });
    expect(systemRowTexts()).toEqual([
      'system note 1',
      'system note 2',
      'system note 3',
    ]);
    expect(summary()?.getAttribute('aria-expanded')).toBe('true');
    // Expanded, the real rows carry the seq — a duplicate on the summary would
    // shadow them in the anchor's `querySelector`.
    expect(summary()?.hasAttribute('data-channel-message-seq')).toBe(false);

    await act(async () => {
      summary()?.click();
    });
    expect(systemRowTexts()).toEqual([]);
    expect(summary()?.getAttribute('aria-expanded')).toBe('false');
  });

  it('leaves a short run expanded with no summary to click', async () => {
    await render({ messages: [sys(1), sys(2)] });
    expect(summary()).toBeNull();
    expect(systemRowTexts()).toEqual(['system note 1', 'system note 2']);
  });

  it('folds each run independently around an interleaved message', async () => {
    await render({
      messages: [sys(1), sys(2), sys(3), human(4), sys(5), sys(6), sys(7)],
    });
    const buttons = Array.from(
      container.querySelectorAll<HTMLButtonElement>('.ch-system-run')
    );
    expect(buttons).toHaveLength(2);

    await act(async () => {
      buttons[0]?.click();
    });
    // Opening one run must not open the other.
    expect(systemRowTexts()).toEqual([
      'system note 1',
      'system note 2',
      'system note 3',
    ]);
  });

  it('keeps day dividers, the unread line and the presence row interleaved with folds', async () => {
    const presence: ChannelAgentPresence[] = [
      {
        agentId: 'agent-profile:hermes:default',
        status: 'thinking',
        label: 'hermes',
        colorVar: 'var(--sender-hermes)',
        glyph: 'hermes',
      },
    ];
    await render({
      messages: [
        sys(1, { createdAt: '2026-08-03T23:56:00.000Z' }),
        sys(2, { createdAt: '2026-08-03T23:57:00.000Z' }),
        sys(3, { createdAt: '2026-08-03T23:58:00.000Z' }),
        sys(4, { createdAt: '2026-08-04T00:01:00.000Z' }),
        sys(5, { createdAt: '2026-08-04T00:02:00.000Z' }),
        sys(6, { createdAt: '2026-08-04T00:03:00.000Z' }),
      ],
      lastReadSeq: 4,
      agentPresence: presence,
    });

    // Two days → two dividers; the unread line splits the second day's run, so
    // that day yields a 1-row run (no fold) plus a 2-row run (no fold).
    expect(container.querySelectorAll('.ch-day-divider')).toHaveLength(2);
    expect(
      container.querySelectorAll('[data-channel-unread-divider]')
    ).toHaveLength(1);
    expect(container.querySelectorAll('.ch-system-run')).toHaveLength(1);
    expect(systemRowTexts()).toEqual([
      'system note 4',
      'system note 5',
      'system note 6',
    ]);
    expect(container.querySelectorAll('.ch-presence__row')).toHaveLength(1);

    // Order is what proves interleaving: divider, folded run, divider, unread
    // line, then the day-2 rows.
    const order = Array.from(
      container.querySelectorAll(
        '.ch-day-divider, .ch-system-run, [data-channel-unread-divider], .ch-system-msg, .ch-presence'
      )
    ).map((node) => node.className.split(' ')[0]);
    expect(order).toEqual([
      'ch-day-divider',
      'ch-system-run',
      'ch-day-divider',
      'ch-system-msg',
      'ch-unread-line',
      'ch-system-msg',
      'ch-system-msg',
      'ch-presence',
    ]);
  });

  it('opens the run holding a deep-link target so the jump never lands on nothing', async () => {
    await render({ messages: [sys(1), sys(2), sys(3)] });
    expect(systemRowTexts()).toEqual([]);

    await render({
      messages: [sys(1), sys(2), sys(3)],
      jumpTarget: { messageId: 'chm:row-2' as ChannelMessageId, token: 1 },
    });
    expect(systemRowTexts()).toEqual([
      'system note 1',
      'system note 2',
      'system note 3',
    ]);
    expect(
      container
        .querySelector('.ch-msg--jump')
        ?.getAttribute('data-channel-message-id')
    ).toBe('chm:row-2');
  });
});
