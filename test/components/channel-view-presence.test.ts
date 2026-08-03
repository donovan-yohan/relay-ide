// @vitest-environment happy-dom
//
// #1277 slice 13 — `ChannelView` wiring for the in-timeline presence row. The
// real `ChannelTimeline`/`ChannelMessageRow` are rendered here on purpose: the
// dedupe rule (a streaming row already draws the live block cursor) is only
// provable against the actual DOM both paths produce.

import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type {
  ChannelMessage,
  ChannelMessageId,
} from '../../shared/channel-chat-protocol.js';
import type { ChannelAgentStatus } from '../../frontend/src/lib/api.js';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const CHANNEL_ID = 'topic:operator-lane';
const CLAUDE_ID = 'agent-profile:claude:default';
const HERMES_ID = 'agent-profile:hermes:default';

const mocks = vi.hoisted(() => ({
  fetchWorkspaceTopic: vi.fn(),
  fetchChannelRoster: vi.fn(),
  messages: [] as unknown[],
}));

vi.mock('../../frontend/src/lib/api.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../frontend/src/lib/api.js')>();
  return {
    ...actual,
    fetchWorkspaceTopic: mocks.fetchWorkspaceTopic,
    fetchChannelRoster: mocks.fetchChannelRoster,
  };
});

vi.mock('../../frontend/src/hooks/useChannelChatSocket.js', () => ({
  useChannelChatSocket: () => ({
    channel: {
      id: CHANNEL_ID,
      title: 'operator lane',
      visibility: 'default',
      archived: false,
      latestSeq: 0,
      messageCount: mocks.messages.length,
      lastMessage: null,
      members: [],
    },
    reducer: {
      channelId: CHANNEL_ID,
      messages: mocks.messages,
      lastSeq: mocks.messages.length,
      needsCatchup: false,
      inFlight: [],
      truncated: false,
    },
    connected: true,
    disconnected: false,
    notFound: false,
    hasMoreOlder: false,
    loadingOlder: false,
    loadOlder: vi.fn(),
    fullSnapshotRevision: 0,
    post: vi.fn(),
    postPending: false,
    postError: null,
    resync: vi.fn(),
  }),
}));

vi.mock('../../frontend/src/components/chat/ChannelComposer.js', () => ({
  ChannelComposer: () => null,
}));
vi.mock('../../frontend/src/components/chat/ChannelThreadPanel.js', () => ({
  ChannelThreadPanel: () => null,
}));

const { ChannelView } = await import(
  '../../frontend/src/components/chat/ChannelView.js'
);

function topicFixture() {
  return {
    id: CHANNEL_ID,
    workspaceId: 'workspace:local',
    display: { title: 'operator lane' },
    routingDefaults: {},
  };
}

function rosterEntry(
  id: string,
  providerId: string,
  status: ChannelAgentStatus
) {
  return {
    id,
    displayName: providerId,
    providerId,
    isDefault: true,
    isBuiltIn: true,
    kind: 'framework' as const,
    available: true,
    reason: null,
    binding: { runtimeId: `runtime:${providerId}-1`, status },
  };
}

function agentMessage(
  seq: number,
  agentId: string,
  providerId: string,
  status: ChannelMessage['status']
): ChannelMessage {
  return {
    schemaVersion: 1,
    id: `chm:${seq}` as ChannelMessageId,
    channelId: CHANNEL_ID,
    seq,
    kind: 'message',
    status,
    sender: { kind: 'agent', id: agentId, providerId },
    body: { text: 'partial answer', format: 'markdown' },
    threadId: null,
    parentMessageId: null,
    createdAt: '2026-07-18T10:00:00.000Z',
    updatedAt: '2026-07-18T10:00:00.000Z',
  };
}

let container: HTMLDivElement;
let root: Root;
let queryClient: QueryClient;

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function render(): Promise<void> {
  await act(async () => {
    root.render(
      React.createElement(
        QueryClientProvider,
        { client: queryClient },
        React.createElement(ChannelView, { channelId: CHANNEL_ID })
      )
    );
  });
  await flush();
}

function presenceLabels(): string[] {
  return [...container.querySelectorAll('.ch-presence__label')].map(
    (label) => label.textContent ?? ''
  );
}

beforeEach(() => {
  mocks.fetchWorkspaceTopic.mockReset();
  mocks.fetchChannelRoster.mockReset();
  mocks.messages = [];
  mocks.fetchWorkspaceTopic.mockResolvedValue(topicFixture());
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 0 } },
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  queryClient.clear();
  container.remove();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('ChannelView in-timeline presence (#1277)', () => {
  it('announces a non-streaming agent for its whole thinking window', async () => {
    mocks.fetchChannelRoster.mockResolvedValue([
      rosterEntry(HERMES_ID, 'hermes', 'thinking'),
    ]);
    mocks.messages = [agentMessage(1, HERMES_ID, 'hermes', 'complete')];

    await render();

    expect(presenceLabels()).toEqual(['hermes is thinking…']);
  });

  it('does not announce an idle agent', async () => {
    mocks.fetchChannelRoster.mockResolvedValue([
      rosterEntry(HERMES_ID, 'hermes', 'idle'),
    ]);
    mocks.messages = [agentMessage(1, HERMES_ID, 'hermes', 'complete')];

    await render();

    // The header chip still exists (the agent is bound) — only the timeline
    // presence row is suppressed, which is what distinguishes idle from busy.
    expect(container.querySelector('.ch-agent-chip')).not.toBeNull();
    expect(container.querySelector('.ch-presence')).toBeNull();
  });

  it('suppresses the row for a provider that already owns a live streaming row', async () => {
    mocks.fetchChannelRoster.mockResolvedValue([
      rosterEntry(CLAUDE_ID, 'claude', 'streaming'),
    ]);
    mocks.messages = [agentMessage(1, CLAUDE_ID, 'claude', 'streaming')];

    await render();

    // The streaming row IS rendering its live block cursor…
    expect(container.querySelector('.ch-msg__cursor')).not.toBeNull();
    // …so claude must not also be announced below it.
    expect(container.querySelector('.ch-presence')).toBeNull();
  });

  it('anti-vacuity: the same streaming-status chip DOES announce once its row completes', async () => {
    // Identical roster/status to the suppression case above; the ONLY change is
    // that no message is in `streaming` state, so nothing draws a block cursor.
    // A presence row appearing here proves the previous assertion measured the
    // dedupe rule rather than a chip that was never there.
    mocks.fetchChannelRoster.mockResolvedValue([
      rosterEntry(CLAUDE_ID, 'claude', 'streaming'),
    ]);
    mocks.messages = [agentMessage(1, CLAUDE_ID, 'claude', 'complete')];

    await render();

    expect(container.querySelector('.ch-msg__cursor')).toBeNull();
    expect(presenceLabels()).toEqual(['claude is responding…']);
  });

  it('suppresses only the streaming provider when another agent is thinking', async () => {
    mocks.fetchChannelRoster.mockResolvedValue([
      rosterEntry(CLAUDE_ID, 'claude', 'streaming'),
      rosterEntry(HERMES_ID, 'hermes', 'thinking'),
    ]);
    mocks.messages = [agentMessage(1, CLAUDE_ID, 'claude', 'streaming')];

    await render();

    expect(container.querySelector('.ch-msg__cursor')).not.toBeNull();
    expect(presenceLabels()).toEqual(['hermes is thinking…']);
    expect(
      container
        .querySelector('.ch-presence__row')
        ?.getAttribute('data-channel-presence-agent')
    ).toBe(HERMES_ID);
  });

  it('mounts the timeline on an empty channel so a first DM turn shows presence', async () => {
    mocks.fetchChannelRoster.mockResolvedValue([
      rosterEntry(HERMES_ID, 'hermes', 'thinking'),
    ]);
    mocks.messages = [];

    await render();

    expect(container.querySelector('.ch-empty')).toBeNull();
    expect(container.querySelector('.ch-tl')).not.toBeNull();
    expect(presenceLabels()).toEqual(['hermes is thinking…']);
  });

  it('keeps the static empty state when an empty channel has no busy agent', async () => {
    mocks.fetchChannelRoster.mockResolvedValue([
      rosterEntry(HERMES_ID, 'hermes', 'idle'),
    ]);
    mocks.messages = [];

    await render();

    expect(container.querySelector('.ch-empty')).not.toBeNull();
    expect(container.querySelector('.ch-presence')).toBeNull();
  });

  it('does not flash the row in the gap between two items of one turn', async () => {
    // The binder holds the binding `streaming` for the whole turn, but the
    // bridge finalizes each assistant item independently. Between item N closing
    // and item N+1 opening no row is streaming — without a trailing hold the
    // presence row would appear and vanish at every tool boundary, growing and
    // shrinking the timeline foot each time.
    mocks.fetchChannelRoster.mockResolvedValue([
      rosterEntry(CLAUDE_ID, 'claude', 'streaming'),
    ]);
    mocks.messages = [agentMessage(1, CLAUDE_ID, 'claude', 'streaming')];
    await render();
    expect(container.querySelector('.ch-presence')).toBeNull();

    // Item 1 finalizes; item 2 has not opened yet.
    mocks.messages = [agentMessage(1, CLAUDE_ID, 'claude', 'complete')];
    await render();
    expect(container.querySelector('.ch-msg__cursor')).toBeNull();
    expect(container.querySelector('.ch-presence')).toBeNull();

    // Item 2 opens: still no presence row, and no toggle happened in between.
    mocks.messages = [
      agentMessage(1, CLAUDE_ID, 'claude', 'complete'),
      agentMessage(2, CLAUDE_ID, 'claude', 'streaming'),
    ];
    await render();
    expect(container.querySelector('.ch-presence')).toBeNull();
    // Anti-vacuity: a cold mount with the identical complete-message state DOES
    // announce (see the anti-vacuity case above), so the silence here is the
    // hold and not a missing chip.
  });

  it('keeps the main-lane row while the agent streams inside a thread', async () => {
    // Thread replies never render in the main timeline (`selectTopLevel`), so a
    // thread-only stream draws no block cursor here — the channel would look
    // idle while the agent is working.
    mocks.fetchChannelRoster.mockResolvedValue([
      rosterEntry(CLAUDE_ID, 'claude', 'streaming'),
    ]);
    const root = agentMessage(1, CLAUDE_ID, 'claude', 'complete');
    const reply = agentMessage(2, CLAUDE_ID, 'claude', 'streaming');
    mocks.messages = [
      root,
      { ...reply, threadId: root.id, parentMessageId: root.id },
    ];

    await render();

    expect(container.querySelector('.ch-msg__cursor')).toBeNull();
    expect(presenceLabels()).toEqual(['claude is responding…']);
  });

  it('rebuilds the row from the roster snapshot alone (reload path, no socket event)', async () => {
    // A cold mount clears this channel's socket statuses, so the only signal is
    // the roster query — exactly the state after a browser reload mid-turn.
    mocks.fetchChannelRoster.mockResolvedValue([
      rosterEntry(HERMES_ID, 'hermes', 'spawning'),
    ]);
    mocks.messages = [];

    await render();

    expect(presenceLabels()).toEqual(['hermes is thinking…']);
  });
});
