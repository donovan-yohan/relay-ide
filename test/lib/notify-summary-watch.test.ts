// @vitest-environment happy-dom
// #1308 slice 5 item 2 — the query-cache lane that feeds the mention/DM-reply
// producer. Uses a REAL `QueryClient`, so the key match, the cold-boot ordering,
// and the unsubscribe are exercised as shipped.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import {
  channelSummariesHaveObserver,
  ensureNotifySummaryCaches,
  refreshChannelSummaries,
} from '../../frontend/src/lib/notify/summary-watch.js';
import { resetNotifyRuntime } from '../../frontend/src/lib/notify/runtime.js';
import { watchChannelSummaries } from '../../frontend/src/lib/notify/summary-watch.js';
import { useChannelActivityStore } from '../../frontend/src/lib/stores/channel-activity.js';
import {
  countAttentionChannels,
  useNotifyBadgeStore,
} from '../../frontend/src/lib/stores/notify-badge.js';
import { useNotifySettingsStore } from '../../frontend/src/lib/stores/notify-settings.js';
import { useUiStore } from '../../frontend/src/lib/stores/ui.js';
import { dmChannelTopicId } from '../../shared/dm-channels.js';

const DM_ID = dmChannelTopicId('claude', null);
const CLAUDE_PROFILE = 'agent-profile:claude:default';

// Only the two fetchers this lane calls are stubbed; everything else in the API
// client (the read-state push the activity store makes, for one) stays real.
const apiMock = vi.hoisted(() => ({
  fetchChannels: vi.fn(),
  fetchWorkspaceTopics: vi.fn(),
}));
vi.mock('../../frontend/src/lib/api.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  fetchChannels: apiMock.fetchChannels,
  fetchWorkspaceTopics: apiMock.fetchWorkspaceTopics,
}));

const shown: { options?: { body?: string } }[] = [];

class FakeNotification {
  static permission: NotificationPermission = 'granted';
  static requestPermission = vi.fn(async () => FakeNotification.permission);
  onclick: ((event?: unknown) => void) | null = null;
  constructor(_title: string, options?: { body?: string }) {
    shown.push({ options });
  }
  close(): void {}
}

const TOPICS = {
  topics: [
    {
      id: DM_ID,
      display: { title: 'claude' },
      workspaceId: null,
      routingDefaults: { providerId: 'claude' },
    },
  ],
};

function dmRows(seq: number) {
  return [
    {
      id: DM_ID,
      lastMessage: {
        seq,
        senderId: CLAUDE_PROFILE,
        senderKind: 'agent' as const,
        senderDisplayName: 'claude',
        providerId: 'claude',
        preview: 'pushed the branch',
      },
    },
  ];
}

let client: QueryClient;
let stop: (() => void) | undefined;

beforeEach(() => {
  shown.length = 0;
  apiMock.fetchChannels.mockReset();
  apiMock.fetchChannels.mockResolvedValue(dmRows(13));
  apiMock.fetchWorkspaceTopics.mockReset();
  apiMock.fetchWorkspaceTopics.mockResolvedValue(TOPICS);
  (globalThis as { Notification?: unknown }).Notification = FakeNotification;
  Object.defineProperty(document, 'hidden', {
    value: true,
    configurable: true,
  });
  document.hasFocus = () => false;
  localStorage.clear();
  resetNotifyRuntime();
  useNotifySettingsStore.getState().resetNotifySettings();
  useChannelActivityStore.setState({ lastReadByChannel: {} });
  useUiStore.getState().setActiveChannelId(null);
  client = new QueryClient();
});

afterEach(() => {
  stop?.();
  stop = undefined;
  client.clear();
  delete (globalThis as { Notification?: unknown }).Notification;
});

function attentionCount(): number {
  return countAttentionChannels(
    useNotifyBadgeStore.getState().flagByChannel,
    useChannelActivityStore.getState().lastReadByChannel
  );
}

describe('channel summary watch', () => {
  it('seeds badges from what is already cached, without notifying', () => {
    client.setQueryData(['channels'], dmRows(12));
    client.setQueryData(['workspace-topics'], TOPICS);
    stop = watchChannelSummaries(client);
    expect(attentionCount()).toBe(1);
    expect(shown).toHaveLength(0);
  });

  it('notifies on the payload AFTER the seed', () => {
    client.setQueryData(['channels'], dmRows(12));
    client.setQueryData(['workspace-topics'], TOPICS);
    stop = watchChannelSummaries(client);
    client.setQueryData(['channels'], dmRows(13));
    expect(shown).toHaveLength(1);
    expect(shown[0]?.options?.body).toBe('claude replied in claude');
  });

  it('tolerates either payload landing second on a cold boot', () => {
    stop = watchChannelSummaries(client);
    // Channels first: no topics yet, so nothing can be derived and the seed has
    // not been spent.
    client.setQueryData(['channels'], dmRows(12));
    expect(attentionCount()).toBe(0);
    client.setQueryData(['workspace-topics'], TOPICS);
    // The topics update re-runs the pass, which is the seed.
    expect(attentionCount()).toBe(1);
    expect(shown).toHaveLength(0);
  });

  it('ignores updates to unrelated caches', () => {
    client.setQueryData(['channels'], dmRows(12));
    client.setQueryData(['workspace-topics'], TOPICS);
    stop = watchChannelSummaries(client);
    client.setQueryData(['hub-nodes'], [{ nodeId: 'node-1' }]);
    client.setQueryData(['active-work'], []);
    expect(shown).toHaveLength(0);
  });

  it('stops feeding the producer once unsubscribed', () => {
    client.setQueryData(['channels'], dmRows(12));
    client.setQueryData(['workspace-topics'], TOPICS);
    stop = watchChannelSummaries(client);
    stop();
    stop = undefined;
    client.setQueryData(['channels'], dmRows(13));
    expect(shown).toHaveLength(0);
  });
});

describe('cache bootstrap and refresh', () => {
  it('fetches both payloads when nothing has (collapsed sidebar boot)', async () => {
    stop = watchChannelSummaries(client);
    await ensureNotifySummaryCaches(client);
    expect(apiMock.fetchChannels).toHaveBeenCalledTimes(1);
    expect(apiMock.fetchWorkspaceTopics).toHaveBeenCalledTimes(1);
    // The bootstrap is the SEED: badged, not notified.
    expect(attentionCount()).toBe(1);
    expect(shown).toHaveLength(0);
  });

  it('fetches nothing when the rail already filled both caches', async () => {
    client.setQueryData(['channels'], dmRows(12));
    client.setQueryData(['workspace-topics'], TOPICS);
    await ensureNotifySummaryCaches(client);
    expect(apiMock.fetchChannels).not.toHaveBeenCalled();
    expect(apiMock.fetchWorkspaceTopics).not.toHaveBeenCalled();
  });

  it('refreshes with no mounted observer, which is what wakes a hidden tab', async () => {
    client.setQueryData(['channels'], dmRows(12));
    client.setQueryData(['workspace-topics'], TOPICS);
    stop = watchChannelSummaries(client);
    expect(shown).toHaveLength(0);
    // Nothing observes `['channels']` here — the rail is unmounted — so an
    // invalidation would be inert. A direct fetch writes the cache and the
    // watch sees it.
    await refreshChannelSummaries(client);
    expect(apiMock.fetchChannels).toHaveBeenCalledTimes(1);
    expect(shown).toHaveLength(1);
    expect(shown[0]?.options?.body).toBe('claude replied in claude');
  });

  it('survives a refresh that fails', async () => {
    client.setQueryData(['channels'], dmRows(12));
    client.setQueryData(['workspace-topics'], TOPICS);
    stop = watchChannelSummaries(client);
    apiMock.fetchChannels.mockRejectedValue(new Error('hub unreachable'));
    await expect(refreshChannelSummaries(client)).resolves.toBeUndefined();
    expect(shown).toHaveLength(0);
  });
});

describe('rail ownership probe', () => {
  // The notify lane's refresh must stand down when the rail is mounted (it
  // fetches on a tighter throttle already) and take over when it is not —
  // otherwise a collapsed sidebar leaves NOTHING refetching `['channels']`,
  // because `invalidateQueries` defaults to `refetchType: 'active'`.
  it('is false with the rail unmounted, true while it observes', () => {
    client.setQueryData(['channels'], dmRows(12));
    expect(channelSummariesHaveObserver(client)).toBe(false);

    const observer = new QueryObserver(client, {
      queryKey: ['channels'],
      queryFn: apiMock.fetchChannels,
    });
    const unsubscribe = observer.subscribe(() => {});
    expect(channelSummariesHaveObserver(client)).toBe(true);

    unsubscribe();
    expect(channelSummariesHaveObserver(client)).toBe(false);
  });

  it('does not count an observer on a DIFFERENT key', () => {
    client.setQueryData(['channels'], dmRows(12));
    const observer = new QueryObserver(client, {
      queryKey: ['workspace-topics'],
      queryFn: () => apiMock.fetchWorkspaceTopics(),
    });
    const unsubscribe = observer.subscribe(() => {});
    expect(channelSummariesHaveObserver(client)).toBe(false);
    unsubscribe();
  });
});

describe('badge pruning', () => {
  it('drops the dot for a channel that left the active topic list', () => {
    client.setQueryData(['channels'], dmRows(12));
    client.setQueryData(['workspace-topics'], TOPICS);
    stop = watchChannelSummaries(client);
    expect(attentionCount()).toBe(1);

    // The DM was deleted or archived: `['workspace-topics']` is always the
    // ACTIVE view (the archived one rides a distinct key), so its absence is
    // the closest thing this lane has to a channel-deleted signal.
    client.setQueryData(['workspace-topics'], {
      topics: [
        {
          id: 'topic:impl-1308',
          display: { title: 'impl 1308' },
          workspaceId: null,
        },
      ],
    });
    expect(attentionCount()).toBe(0);
  });

  it('keeps every flag when the topic payload is TRUNCATED', () => {
    // A page of the corpus is not evidence of deletion.
    client.setQueryData(['channels'], dmRows(12));
    client.setQueryData(['workspace-topics'], TOPICS);
    stop = watchChannelSummaries(client);
    expect(attentionCount()).toBe(1);
    client.setQueryData(['workspace-topics'], {
      topics: [
        {
          id: 'topic:impl-1308',
          display: { title: 'impl 1308' },
          workspaceId: null,
        },
      ],
      truncated: true,
    });
    expect(attentionCount()).toBe(1);
  });
});
