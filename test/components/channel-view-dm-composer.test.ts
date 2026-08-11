// @vitest-environment happy-dom
//
// #1166 routing half, composer copy. A DM routes an unmentioned message to its
// one agent implicitly, so the composer must stop telling you to type `@` at
// the very agent the header already says you are talking to. Covers BOTH
// composers a DM exposes: the channel composer and the thread composer —
// `handleMessagePosted` has no `threadId` gate, so a thread reply in a DM
// routes implicitly too.

import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import type { ChannelMessageId } from '../../shared/channel-chat-protocol.js';
import { dmChannelTopicId } from '../../shared/dm-channels.js';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const DM_CHANNEL_ID = dmChannelTopicId('claude', 'ws:local');
const CODEX_DM_CHANNEL_ID = dmChannelTopicId('codex', 'ws:local');
const GROUP_CHANNEL_ID = 'topic:general';

const mocks = vi.hoisted(() => ({
  fetchWorkspaceTopic: vi.fn(),
  fetchChannelRoster: vi.fn(),
  composerProps: [] as Record<string, unknown>[],
  channelId: 'topic:unset',
  channelTitle: 'unset',
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
      id: mocks.channelId,
      title: mocks.channelTitle,
      visibility: 'default',
      archived: false,
      latestSeq: 0,
      messageCount: 0,
      lastMessage: null,
      members: [],
    },
    reducer: {
      channelId: mocks.channelId,
      messages: [],
      lastSeq: 0,
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

vi.mock('../../frontend/src/components/chat/ChannelTimeline.js', () => ({
  ChannelTimeline: () => null,
}));
// ChannelThreadPanel is deliberately REAL here: its composer copy is the thing
// under test, and only the live ChannelView → panel wiring proves a DM thread
// actually gets the DM copy. Only its data hook is stubbed.
vi.mock('../../frontend/src/hooks/useChannelThread.js', () => ({
  useChannelThread: () => ({
    root: null,
    replies: [],
    hasMoreOlder: false,
    loadingOlder: false,
    loadOlder: vi.fn(),
    loading: false,
    error: null,
    rootFloorRevision: 0,
  }),
}));
vi.mock('../../frontend/src/components/chat/ChannelComposer.js', () => ({
  ChannelComposer: (props: Record<string, unknown>) => {
    mocks.composerProps.push(props);
    return null;
  },
}));

const { ChannelView } =
  await import('../../frontend/src/components/chat/ChannelView.js');
const { useUiStore } = await import('../../frontend/src/lib/stores/ui.js');

const THREAD_ROOT_ID = 'chm:root-1' as ChannelMessageId;

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

async function render(channelId: string): Promise<void> {
  await act(async () => {
    root.render(
      React.createElement(
        QueryClientProvider,
        { client: queryClient },
        React.createElement(ChannelView, { channelId })
      )
    );
  });
  await flush();
}

function latestPlaceholder(): unknown {
  return mocks.composerProps.at(-1)?.['placeholder'];
}

function latestCommandProviderHint(): unknown {
  return mocks.composerProps.at(-1)?.['implicitCommandProviderId'];
}

/** Every placeholder any composer has been handed this render pass. */
function placeholders(): string[] {
  return mocks.composerProps
    .map((props) => props['placeholder'])
    .filter((value): value is string => typeof value === 'string');
}

/** Open the thread panel on the channel already on screen. */
async function openThread(channelId: string): Promise<void> {
  await act(async () => {
    useUiStore.getState().requestChannelThread(channelId, THREAD_ROOT_ID);
  });
  await flush();
}

beforeEach(() => {
  mocks.fetchWorkspaceTopic.mockReset();
  mocks.fetchChannelRoster.mockReset();
  mocks.fetchChannelRoster.mockResolvedValue([]);
  mocks.composerProps.length = 0;
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

describe('ChannelView composer copy', () => {
  it('addresses the agent and drops the mention hint inside a DM', async () => {
    mocks.channelId = DM_CHANNEL_ID;
    mocks.channelTitle = 'Claude Code';
    mocks.fetchWorkspaceTopic.mockResolvedValue({
      id: DM_CHANNEL_ID,
      workspaceId: 'ws:local',
      display: { title: 'Claude Code' },
      routingDefaults: { providerId: 'claude' },
    });

    await render(DM_CHANNEL_ID);

    const placeholder = latestPlaceholder();
    expect(typeof placeholder).toBe('string');
    expect(placeholder as string).toMatch(/^message @/);
    // The DM routes implicitly — never prompt for the `@` it does not need.
    expect(placeholder as string).not.toContain('to mention');
    expect(placeholder as string).not.toContain('#');
    expect(latestCommandProviderHint()).toBeUndefined();
  });

  it('leaves a multi-party channel on the default `#channel` copy', async () => {
    mocks.channelId = GROUP_CHANNEL_ID;
    mocks.channelTitle = 'general';
    mocks.fetchWorkspaceTopic.mockResolvedValue({
      id: GROUP_CHANNEL_ID,
      workspaceId: 'ws:local',
      display: { title: 'general' },
      routingDefaults: {},
    });

    await render(GROUP_CHANNEL_ID);

    // No override: ChannelComposer keeps its own `#channel… · @ to mention`
    // default, which is still the right instruction where @ is required.
    expect(latestPlaceholder()).toBeUndefined();
  });

  it('drops the mention hint from a DM thread composer too', async () => {
    mocks.channelId = DM_CHANNEL_ID;
    mocks.channelTitle = 'Claude Code';
    mocks.fetchWorkspaceTopic.mockResolvedValue({
      id: DM_CHANNEL_ID,
      workspaceId: 'ws:local',
      display: { title: 'Claude Code' },
      routingDefaults: { providerId: 'claude' },
    });

    await render(DM_CHANNEL_ID);
    mocks.composerProps.length = 0;
    await openThread(DM_CHANNEL_ID);

    // A thread reply in a DM routes implicitly exactly like a top-level one
    // (no `threadId` gate in the binder), so neither composer may ask for `@`.
    expect(placeholders()).toContain(
      'reply in thread…  ·  shift+enter for newline'
    );
    expect(placeholders().some((copy) => copy.includes('to mention'))).toBe(
      false
    );
    expect(latestCommandProviderHint()).toBeUndefined();
  });

  it('keeps the mention hint on a multi-party thread composer', async () => {
    mocks.channelId = GROUP_CHANNEL_ID;
    mocks.channelTitle = 'general';
    mocks.fetchWorkspaceTopic.mockResolvedValue({
      id: GROUP_CHANNEL_ID,
      workspaceId: 'ws:local',
      display: { title: 'general' },
      routingDefaults: {},
    });

    await render(GROUP_CHANNEL_ID);
    mocks.composerProps.length = 0;
    await openThread(GROUP_CHANNEL_ID);

    // Nothing implicit here — `@` is still the only way to reach an agent.
    expect(placeholders()).toContain(
      'reply in thread…  ·  @ to mention · shift+enter for newline'
    );
    expect(latestCommandProviderHint()).toBeUndefined();
  });

  it('passes only the Codex DM provider hint to main and thread composers', async () => {
    mocks.channelId = CODEX_DM_CHANNEL_ID;
    mocks.channelTitle = 'Codex';
    mocks.fetchWorkspaceTopic.mockResolvedValue({
      id: CODEX_DM_CHANNEL_ID,
      workspaceId: 'ws:local',
      display: { title: 'Codex' },
      routingDefaults: { providerId: 'codex' },
    });

    await render(CODEX_DM_CHANNEL_ID);
    expect(latestCommandProviderHint()).toBe('codex');
    mocks.composerProps.length = 0;
    await openThread(CODEX_DM_CHANNEL_ID);
    expect(latestCommandProviderHint()).toBe('codex');
  });
});
