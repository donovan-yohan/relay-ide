// @vitest-environment happy-dom
//
// #1166 routing half, composer copy. A DM routes an unmentioned message to its
// one agent implicitly, so the composer must stop telling you to type `@` at
// the very agent the header already says you are talking to.

import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { dmChannelTopicId } from '../../shared/dm-channels.js';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const DM_CHANNEL_ID = dmChannelTopicId('claude', 'ws:local');
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
vi.mock('../../frontend/src/components/chat/ChannelThreadPanel.js', () => ({
  ChannelThreadPanel: () => null,
}));
vi.mock('../../frontend/src/components/chat/ChannelComposer.js', () => ({
  ChannelComposer: (props: Record<string, unknown>) => {
    mocks.composerProps.push(props);
    return null;
  },
}));

const { ChannelView } = await import(
  '../../frontend/src/components/chat/ChannelView.js'
);

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
});
