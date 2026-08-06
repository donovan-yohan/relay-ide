// @vitest-environment happy-dom
//
// #1308 slice 4 item 2 — mid-turn steering affordances. The REAL composer,
// timeline and message rows render here: the feature is a three-way agreement
// between the live status signal, the post route's `steering` field and the
// queued chip's own retirement rule, and isolated fixtures of any one of them
// would prove none of it.

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

const CHANNEL_ID = 'topic:ops';
const CLAUDE_ID = 'agent-profile:claude:default';
const RUNTIME_ID = 'runtime:claude-1';
const HERMES_ID = 'agent-profile:hermes:default';
const HERMES_RUNTIME_ID = 'runtime:hermes-1';

interface PostOpts {
  clientMessageId?: string;
  threadId?: string;
  steering?: 'interrupt';
}

const mocks = vi.hoisted(() => ({
  fetchWorkspaceTopic: vi.fn(),
  fetchChannelRoster: vi.fn(),
  post: vi.fn(),
  messages: [] as unknown[],
  threadRoot: null as unknown,
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
      title: 'ops',
      visibility: 'default',
      archived: false,
      latestSeq: mocks.messages.length,
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
    post: mocks.post,
    postPending: false,
    postError: null,
    resync: vi.fn(),
  }),
}));

// The thread panel's own history fetch is not what is under test; the panel is
// here because its composer is a SECOND send path (`threadId` is attached by
// `ChannelView`, not by the composer) and has to inherit the steering cluster.
vi.mock('../../frontend/src/hooks/useChannelThread.js', () => ({
  useChannelThread: () => ({
    root: mocks.threadRoot,
    replies: [],
    hasMoreOlder: false,
    loadingOlder: false,
    loadOlder: vi.fn(),
    loading: false,
    error: null,
    rootFloorRevision: 0,
  }),
}));

const { ChannelView } =
  await import('../../frontend/src/components/chat/ChannelView.js');
const { useUiStore } = await import('../../frontend/src/lib/stores/ui.js');
const { useChannelAgentStatusStore } =
  await import('../../frontend/src/lib/stores/channel-agent-status.js');
const { useChannelQueuedSendsStore } =
  await import('../../frontend/src/lib/stores/channel-queued-sends.js');

function topicFixture() {
  return {
    id: CHANNEL_ID,
    workspaceId: 'workspace:local',
    display: { title: 'ops' },
    routingDefaults: {},
  };
}

function rosterEntry(
  status: ChannelAgentStatus,
  queuedCount = 0,
  steerSupported = false,
  steeringCount = 0
) {
  return {
    id: CLAUDE_ID,
    displayName: 'claude',
    providerId: 'claude',
    isDefault: true,
    isBuiltIn: true,
    kind: 'framework' as const,
    available: true,
    reason: null,
    binding: {
      runtimeId: RUNTIME_ID,
      status,
      queuedCount,
      steerSupported,
      steeringCount,
    },
  };
}

function humanMessage(
  seq: number,
  text: string,
  threadId: ChannelMessageId | null
): ChannelMessage {
  return {
    schemaVersion: 1,
    id: `chm:${seq}` as ChannelMessageId,
    channelId: CHANNEL_ID,
    seq,
    kind: 'message',
    status: 'complete',
    sender: { kind: 'human', id: 'operator', displayName: 'you' },
    body: { text, format: 'markdown' },
    threadId,
    parentMessageId: threadId,
    createdAt: '2026-08-03T10:00:00.000Z',
    updatedAt: '2026-08-03T10:00:00.000Z',
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

function composers(): HTMLTextAreaElement[] {
  return [
    ...container.querySelectorAll<HTMLTextAreaElement>('.ch-composer__ta'),
  ];
}

function setNativeValue(el: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    'value'
  )?.set;
  setter?.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

async function typeAndPressEnter(
  el: HTMLTextAreaElement,
  text: string,
  init: KeyboardEventInit = {}
): Promise<void> {
  await act(async () => {
    setNativeValue(el, text);
  });
  await act(async () => {
    el.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        bubbles: true,
        cancelable: true,
        ...init,
      })
    );
  });
  await flush();
}

function queuedChips(): string[] {
  return [...container.querySelectorAll('.ch-msg__tag--queued')].map(
    (chip) => chip.textContent ?? ''
  );
}

function presenceLabels(): string[] {
  return [...container.querySelectorAll('.ch-presence__label')].map(
    (label) => label.textContent ?? ''
  );
}

beforeEach(() => {
  mocks.fetchWorkspaceTopic.mockReset();
  mocks.fetchChannelRoster.mockReset();
  mocks.post.mockReset();
  mocks.messages = [];
  mocks.threadRoot = null;
  mocks.fetchWorkspaceTopic.mockResolvedValue(topicFixture());
  mocks.post.mockImplementation(async (text: string, opts?: PostOpts) => {
    const message = humanMessage(
      mocks.messages.length + 1,
      text,
      (opts?.threadId as ChannelMessageId | undefined) ?? null
    );
    mocks.messages = [...mocks.messages, message];
    return message;
  });
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  useUiStore.setState({
    activeChannelId: null,
    activeThreadRootId: null,
    pendingChannelThread: null,
  });
  useChannelQueuedSendsStore.setState({ marksByMessageId: {} });
  useChannelAgentStatusStore.setState({
    statusByChannelAgent: {},
    runtimeByChannelAgent: {},
    queuedCountByChannelAgent: {},
    steeringCountByChannelAgent: {},
    steerSupportedByChannelAgent: {},
    queueDrainSeqByChannelAgent: {},
    updatedAtByChannelAgent: {},
  });
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
  useUiStore.setState({
    activeChannelId: null,
    activeThreadRootId: null,
    pendingChannelThread: null,
  });
});

describe('composer steering cluster (#1308 slice 4 item 2b)', () => {
  it('stays out of the way while every bound agent is idle', async () => {
    mocks.fetchChannelRoster.mockResolvedValue([rosterEntry('idle')]);
    await render();

    expect(container.querySelector('.ch-composer__steer')).toBeNull();
    expect(
      container.querySelector('.ch-composer__hint')?.textContent
    ).toContain('send');
  });

  it('reveals the queue fallback + interrupt&send for a non-steerable harness', async () => {
    mocks.fetchChannelRoster.mockResolvedValue([rosterEntry('streaming')]);
    await render();

    const cluster = container.querySelector('.ch-composer__steer');
    expect(cluster).not.toBeNull();
    expect(cluster?.getAttribute('aria-label')).toBe('mid-turn steering');
    expect(
      container.querySelector('.ch-composer__steer-btn')?.textContent
    ).toBe('queue');
    const interrupt = container.querySelector(
      '.ch-composer__steer-btn--interrupt'
    );
    // Same interrupt vocabulary as the header chip: the black square.
    expect(interrupt?.textContent).toContain('■');
    expect(interrupt?.getAttribute('aria-label')).toBe('interrupt and send');
  });

  it('posts with no steering by default — the backend selects queue or native steer', async () => {
    mocks.fetchChannelRoster.mockResolvedValue([rosterEntry('streaming')]);
    await render();

    const [composer] = composers();
    await typeAndPressEnter(composer!, 'also check the tests');

    expect(mocks.post).toHaveBeenCalledTimes(1);
    const [text, opts] = mocks.post.mock.calls[0] as [string, PostOpts];
    expect(text).toBe('also check the tests');
    expect(opts.steering).toBeUndefined();
  });

  it('posts steering:interrupt from the explicit control', async () => {
    mocks.fetchChannelRoster.mockResolvedValue([rosterEntry('streaming')]);
    await render();

    const [composer] = composers();
    await act(async () => setNativeValue(composer!, 'stop, do this instead'));
    const interrupt = container.querySelector<HTMLButtonElement>(
      '.ch-composer__steer-btn--interrupt'
    );
    await act(async () => interrupt?.click());
    await flush();

    expect(mocks.post).toHaveBeenCalledTimes(1);
    const [text, opts] = mocks.post.mock.calls[0] as [string, PostOpts];
    expect(text).toBe('stop, do this instead');
    expect(opts.steering).toBe('interrupt');
  });

  it('maps enter to the default delivery lane and cmd/ctrl+enter to interrupt-send', async () => {
    mocks.fetchChannelRoster.mockResolvedValue([rosterEntry('streaming')]);
    await render();

    await typeAndPressEnter(composers()[0]!, 'first');
    await typeAndPressEnter(composers()[0]!, 'second', { metaKey: true });
    await typeAndPressEnter(composers()[0]!, 'third', { ctrlKey: true });

    const steerings = mocks.post.mock.calls.map(
      (call) => (call[1] as PostOpts).steering
    );
    expect(steerings).toEqual([undefined, 'interrupt', 'interrupt']);
  });

  it('labels ordinary Enter as safe-boundary steering for a steer-capable harness', async () => {
    mocks.fetchChannelRoster.mockResolvedValue([
      rosterEntry('streaming', 0, true),
    ]);
    await render();

    const defaultAction = container.querySelector<HTMLButtonElement>(
      '.ch-composer__steer-btn'
    );
    expect(defaultAction?.textContent).toBe('steer');
    expect(defaultAction?.title).toContain('safe tool boundary');
    expect(
      container.querySelector('.ch-composer__hint')?.textContent
    ).toContain('steer after tool');

    await typeAndPressEnter(composers()[0]!, 'inspect the conflicts next');
    expect((mocks.post.mock.calls[0]![1] as PostOpts).steering).toBeUndefined();
  });

  it('reconciles a newer socket steerSupported:false over an older roster true', async () => {
    mocks.fetchChannelRoster.mockResolvedValue([
      rosterEntry('streaming', 0, true),
    ]);
    await render();
    expect(
      container.querySelector<HTMLButtonElement>('.ch-composer__steer-btn')
        ?.textContent
    ).toBe('steer');

    // A capability downgrade is a real socket value, not an absent field. It
    // must therefore beat the roster snapshot just like a status transition.
    await act(async () => {
      useChannelAgentStatusStore
        .getState()
        .recordStatus(
          CHANNEL_ID,
          CLAUDE_ID,
          'streaming',
          RUNTIME_ID,
          0,
          0,
          false
        );
    });
    await flush();

    expect(
      container.querySelector<HTMLButtonElement>('.ch-composer__steer-btn')
        ?.textContent
    ).toBe('queue');
  });

  it('keeps cmd+enter a plain send when nothing is mid-turn', async () => {
    // The modifier changes what happens to a LIVE turn. With no live turn there
    // is nothing to cancel, so it must not smuggle a steering flag to a route
    // that would then interrupt the next agent to pick the message up.
    mocks.fetchChannelRoster.mockResolvedValue([rosterEntry('idle')]);
    await render();

    await typeAndPressEnter(composers()[0]!, 'nothing running', {
      metaKey: true,
    });

    expect(mocks.post).toHaveBeenCalledTimes(1);
    expect((mocks.post.mock.calls[0]![1] as PostOpts).steering).toBeUndefined();
  });
});

describe('queued chip (#1308 slice 4 item 2a)', () => {
  it('marks a busy-send row and clears it when the next turn consumes the queue', async () => {
    mocks.fetchChannelRoster.mockResolvedValue([rosterEntry('streaming')]);
    await render();

    await typeAndPressEnter(composers()[0]!, 'and update the docs');
    await render();

    expect(queuedChips()).toEqual(['queued — claude is mid-turn']);

    // The binder's drain: the queue is spliced out and reported empty a beat
    // before the consuming turn is announced.
    await act(async () => {
      useChannelAgentStatusStore
        .getState()
        .recordStatus(CHANNEL_ID, CLAUDE_ID, 'idle', RUNTIME_ID, 0);
    });
    await flush();

    expect(queuedChips()).toEqual([]);
  });

  it('does not mark a send made while every agent is idle', async () => {
    mocks.fetchChannelRoster.mockResolvedValue([rosterEntry('idle')]);
    await render();

    await typeAndPressEnter(composers()[0]!, 'plain send');
    await render();

    expect(container.querySelectorAll('.ch-msg').length).toBe(1);
    expect(queuedChips()).toEqual([]);
  });

  it('does not mark an interrupt-send — the operator refused to wait', async () => {
    mocks.fetchChannelRoster.mockResolvedValue([rosterEntry('streaming')]);
    await render();

    await typeAndPressEnter(composers()[0]!, 'stop that', { metaKey: true });
    await render();

    expect(mocks.post).toHaveBeenCalledTimes(1);
    expect(queuedChips()).toEqual([]);
  });

  it('does not paint a native steer as queued', async () => {
    mocks.fetchChannelRoster.mockResolvedValue([
      rosterEntry('streaming', 0, true),
    ]);
    await render();

    await typeAndPressEnter(composers()[0]!, 'change direction');
    await render();

    expect(queuedChips()).toEqual([]);
  });

  it('keeps the queued-row chip scoped to non-steerable agents in mixed mode', async () => {
    const hermes = {
      ...rosterEntry('streaming'),
      id: HERMES_ID,
      displayName: 'hermes',
      providerId: 'hermes',
      binding: {
        runtimeId: HERMES_RUNTIME_ID,
        status: 'streaming' as const,
        queuedCount: 0,
        steeringCount: 0,
        steerSupported: false,
      },
    };
    mocks.fetchChannelRoster.mockResolvedValue([
      rosterEntry('streaming', 0, true),
      hermes,
    ]);
    await render();

    expect(
      container.querySelector<HTMLButtonElement>('.ch-composer__steer-btn')
        ?.textContent
    ).toBe('steer / queue');
    await typeAndPressEnter(composers()[0]!, 'coordinate the two agents');
    await render();

    expect(queuedChips()).toEqual(['queued — hermes is mid-turn']);
  });

  it('drops the mark when a drain lands while the post is still in flight', async () => {
    // Failing toward silence: the message was already consumed by the time the
    // row existed, so a chip naming a wait would be a lie.
    mocks.fetchChannelRoster.mockResolvedValue([rosterEntry('streaming')]);
    await render();

    mocks.post.mockImplementationOnce(async (text: string) => {
      useChannelAgentStatusStore
        .getState()
        .recordStatus(CHANNEL_ID, CLAUDE_ID, 'idle', RUNTIME_ID, 0);
      const message = humanMessage(mocks.messages.length + 1, text, null);
      mocks.messages = [...mocks.messages, message];
      return message;
    });
    await typeAndPressEnter(composers()[0]!, 'raced the drain');
    await render();

    expect(queuedChips()).toEqual([]);
  });
});

describe('presence queue depth (#1308 slice 4 item 2c)', () => {
  it('names native safe-boundary work as steering pending, never queued', async () => {
    mocks.fetchChannelRoster.mockResolvedValue([
      rosterEntry('thinking', 0, true, 1),
    ]);
    await render();

    expect(presenceLabels()).toEqual([
      'claude is thinking… (1 steering pending)',
    ]);
  });

  it('suffixes the presence row with the queue depth', async () => {
    mocks.fetchChannelRoster.mockResolvedValue([rosterEntry('thinking', 2)]);
    await render();

    expect(presenceLabels()).toEqual(['claude is thinking… (2 queued)']);
  });

  it('drops the suffix again once the queue empties', async () => {
    mocks.fetchChannelRoster.mockResolvedValue([rosterEntry('thinking', 1)]);
    await render();
    expect(presenceLabels()).toEqual(['claude is thinking… (1 queued)']);

    await act(async () => {
      useChannelAgentStatusStore
        .getState()
        .recordStatus(CHANNEL_ID, CLAUDE_ID, 'thinking', RUNTIME_ID, 0);
    });
    await flush();

    expect(presenceLabels()).toEqual(['claude is thinking…']);
  });
});

describe('thread composer inherits steering (#1308 slice 4 item 2d)', () => {
  it('offers the cluster in the thread lane and threads the flag through its own send path', async () => {
    mocks.fetchChannelRoster.mockResolvedValue([rosterEntry('streaming')]);
    const rootMessage = humanMessage(1, 'root question', null);
    mocks.messages = [rootMessage];
    mocks.threadRoot = rootMessage;
    await render();

    await act(async () => {
      useUiStore.getState().requestChannelThread(CHANNEL_ID, rootMessage.id);
    });
    await flush();

    const threadComposer = container.querySelector<HTMLTextAreaElement>(
      '.ch-thread .ch-composer__ta'
    );
    expect(threadComposer).not.toBeNull();
    expect(
      container.querySelector('.ch-thread .ch-composer__steer')
    ).not.toBeNull();

    await typeAndPressEnter(threadComposer!, 'reply now', { metaKey: true });

    expect(mocks.post).toHaveBeenCalledTimes(1);
    const opts = mocks.post.mock.calls[0]![1] as PostOpts;
    expect(opts.threadId).toBe(rootMessage.id);
    expect(opts.steering).toBe('interrupt');
  });
});
