// @vitest-environment happy-dom
//
// #1287 ITEM 14: restore used to be two mutations with disjoint invalidations —
// the in-channel composer bar refreshed `['channel']` + `['workspace-topic']`
// and swallowed errors, while the sidebar refreshed `['workspace-topics']` and
// toasted them. Both surfaces mount at once, so one restore always left the
// other rendering stale archived state. These tests pin the single shared
// mutation: three keys every time, and a failure that reaches the operator.

import React, { act, useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  fetchWorkspaceTopic: vi.fn(),
  fetchChannelRoster: vi.fn(),
  restoreWorkspaceTopic: vi.fn(),
}));

vi.mock('../../frontend/src/lib/api.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../frontend/src/lib/api.js')>();
  return {
    ...actual,
    fetchWorkspaceTopic: mocks.fetchWorkspaceTopic,
    fetchChannelRoster: mocks.fetchChannelRoster,
    restoreWorkspaceTopic: mocks.restoreWorkspaceTopic,
  };
});

const CHANNEL_ID = 'topic:archived-lane';

// Archived channel: the composer renders its restore bar instead of the input.
vi.mock('../../frontend/src/hooks/useChannelChatSocket.js', () => ({
  useChannelChatSocket: () => ({
    channel: {
      id: CHANNEL_ID,
      title: 'archived lane',
      visibility: 'default',
      archived: true,
      latestSeq: 0,
      messageCount: 0,
      lastMessage: null,
      members: [],
    },
    reducer: {
      channelId: CHANNEL_ID,
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

const { ChannelView } = await import(
  '../../frontend/src/components/chat/ChannelView.js'
);
const { restoreTopicQueryKeys, useRestoreTopicMutation } = await import(
  '../../frontend/src/lib/hooks/use-restore-topic.js'
);
const { useToastStore } = await import(
  '../../frontend/src/lib/stores/toasts.js'
);

function topicFixture(status: 'active' | 'archived' = 'archived') {
  return {
    id: CHANNEL_ID,
    workspaceId: 'ws:local',
    status,
    display: { title: 'archived lane' },
    routingDefaults: {},
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

/** Seed the readers that must not keep rendering the archived state. */
function seedTopicCaches(): void {
  queryClient.setQueryData(['channel', CHANNEL_ID], { archived: true });
  queryClient.setQueryData(['workspace-topics'], { topics: [] });
  queryClient.setQueryData(['workspace-topics', 'with-archived'], {
    topics: [],
  });
  queryClient.setQueryData(
    ['workspace-topics', 'search', 'lane', 'all', 'with-archived'],
    { results: [] }
  );
}

beforeEach(() => {
  mocks.fetchWorkspaceTopic.mockReset();
  mocks.fetchChannelRoster.mockReset();
  mocks.restoreWorkspaceTopic.mockReset();
  mocks.fetchWorkspaceTopic.mockResolvedValue(topicFixture());
  mocks.fetchChannelRoster.mockResolvedValue([]);
  mocks.restoreWorkspaceTopic.mockResolvedValue(topicFixture('active'));
  useToastStore.setState({ toasts: [] });
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: 0 },
      mutations: { retry: false },
    },
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

describe('shared restore mutation (#1287)', () => {
  it('names every reader of a topic archived state, list keys by prefix', () => {
    expect(restoreTopicQueryKeys(CHANNEL_ID)).toEqual([
      ['channel', CHANNEL_ID],
      ['workspace-topic', CHANNEL_ID],
      ['workspace-topics'],
    ]);
  });

  it('invalidates all three key sets from any caller, prefix included', async () => {
    seedTopicCaches();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');

    function Probe(): null {
      const { mutate } = useRestoreTopicMutation();
      useEffect(() => {
        mutate(CHANNEL_ID);
      }, [mutate]);
      return null;
    }

    await act(async () => {
      root.render(
        React.createElement(
          QueryClientProvider,
          { client: queryClient },
          React.createElement(Probe)
        )
      );
    });
    await flush();

    expect(mocks.restoreWorkspaceTopic).toHaveBeenCalledWith(CHANNEL_ID);
    for (const queryKey of restoreTopicQueryKeys(CHANNEL_ID)) {
      expect(invalidate).toHaveBeenCalledWith({ queryKey });
    }
    // The `['workspace-topics']` entry is a PREFIX: the archived-inclusive view
    // and the search results must fall in with it, or the sidebar keeps the
    // restored row greyed out.
    for (const queryKey of [
      ['channel', CHANNEL_ID],
      ['workspace-topics'],
      ['workspace-topics', 'with-archived'],
      ['workspace-topics', 'search', 'lane', 'all', 'with-archived'],
    ]) {
      expect(queryClient.getQueryState(queryKey)?.isInvalidated).toBe(true);
    }
  });

  it('surfaces a restore failure as a toast instead of swallowing it', async () => {
    mocks.restoreWorkspaceTopic.mockRejectedValue(new Error('restore refused'));

    function Probe(): null {
      const { mutate } = useRestoreTopicMutation();
      useEffect(() => {
        mutate(CHANNEL_ID);
      }, [mutate]);
      return null;
    }

    await act(async () => {
      root.render(
        React.createElement(
          QueryClientProvider,
          { client: queryClient },
          React.createElement(Probe)
        )
      );
    });
    await flush();

    expect(useToastStore.getState().toasts.map((t) => t.message)).toContain(
      'restore refused'
    );
  });
});

describe('ChannelView restore bar call site (#1287)', () => {
  async function renderChannel(): Promise<void> {
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

  it('drives the shared mutation from the ungated composer restore bar', async () => {
    seedTopicCaches();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    await renderChannel();

    const restore = container.querySelector<HTMLButtonElement>(
      '.ch-composer__restore'
    );
    expect(restore).not.toBeNull();

    await act(async () => restore?.click());
    await flush();

    expect(mocks.restoreWorkspaceTopic).toHaveBeenCalledWith(CHANNEL_ID);
    for (const queryKey of restoreTopicQueryKeys(CHANNEL_ID)) {
      expect(invalidate).toHaveBeenCalledWith({ queryKey });
    }
  });

  it('holds the bar in its pending state until the restore settles', async () => {
    let settle: (() => void) | null = null;
    mocks.restoreWorkspaceTopic.mockReturnValue(
      new Promise<void>((resolve) => {
        settle = resolve;
      })
    );
    await renderChannel();

    const restore = container.querySelector<HTMLButtonElement>(
      '.ch-composer__restore'
    );
    act(() => {
      restore?.click();
    });
    await flush();

    expect(restore?.disabled).toBe(true);
    expect(restore?.textContent).toContain('restoring');

    settle?.();
    await flush();
  });

  it('toasts a failed in-channel restore rather than failing silently', async () => {
    mocks.restoreWorkspaceTopic.mockRejectedValue(
      new Error('channel store unavailable')
    );
    await renderChannel();

    const restore = container.querySelector<HTMLButtonElement>(
      '.ch-composer__restore'
    );
    await act(async () => restore?.click());
    await flush();

    expect(useToastStore.getState().toasts.map((t) => t.message)).toContain(
      'channel store unavailable'
    );
    // Retryable: the bar comes back out of its pending state.
    expect(restore?.disabled).toBe(false);
  });
});
