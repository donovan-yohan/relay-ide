// @vitest-environment happy-dom
// #1308 slice 5 item 2 — `useNotifyDelivery`, the hook `App` mounts once.
//
// What is under test is the REFRESH GATE, because that is the lane's only
// backstop: `TopicSidebarShell` owns the sole activity-driven
// `invalidateQueries(['channels'])` and unmounts with a collapsed sidebar, and
// invalidation without an active observer refetches nothing. If this gate is
// wrong the operator gets no mention badge, no dot, no title count and no
// notification — silently.
import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { createRoot, type Root } from 'react-dom/client';
import { useNotifyDelivery } from '../../frontend/src/hooks/useNotifyDelivery.js';
import { resetNotifyRuntime } from '../../frontend/src/lib/notify/runtime.js';
import { useChannelActivityStore } from '../../frontend/src/lib/stores/channel-activity.js';
import { useNotifyBadgeStore } from '../../frontend/src/lib/stores/notify-badge.js';
import { useNotifySettingsStore } from '../../frontend/src/lib/stores/notify-settings.js';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const apiMock = vi.hoisted(() => ({
  fetchChannels: vi.fn(),
  fetchWorkspaceTopics: vi.fn(),
}));
vi.mock('../../frontend/src/lib/api.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  fetchChannels: apiMock.fetchChannels,
  fetchWorkspaceTopics: apiMock.fetchWorkspaceTopics,
}));

/** Windows declared by the hook; kept in step with it deliberately. */
const HIDDEN_REFRESH_MS = 10_000;
const VISIBLE_REFRESH_MS = 45_000;

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let client: QueryClient;

function Harness({ enabled }: { enabled: boolean }) {
  useNotifyDelivery(enabled, client);
  return null;
}

async function mount(enabled = true): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(React.createElement(Harness, { enabled }));
  });
}

async function rerender(enabled: boolean): Promise<void> {
  await act(async () => {
    root!.render(React.createElement(Harness, { enabled }));
  });
}

function setHidden(hidden: boolean): void {
  Object.defineProperty(document, 'hidden', {
    value: hidden,
    configurable: true,
  });
}

/** Move a channel's latest seq — the socket signal the refresh rides. */
async function channelActivity(seq: number): Promise<void> {
  await act(async () => {
    useChannelActivityStore.setState({
      latestSeqByChannel: { 'topic:impl-1308': seq },
    });
  });
}

async function advance(ms: number): Promise<void> {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
  // Let the fetch settle.
  await act(async () => {
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  apiMock.fetchChannels.mockReset();
  apiMock.fetchChannels.mockResolvedValue([]);
  apiMock.fetchWorkspaceTopics.mockReset();
  apiMock.fetchWorkspaceTopics.mockResolvedValue({ topics: [] });
  document.head.innerHTML = '<link rel="icon" href="/icon.svg" />';
  document.title = 'Relay';
  setHidden(false);
  document.hasFocus = () => true;
  localStorage.clear();
  resetNotifyRuntime();
  useNotifySettingsStore.getState().resetNotifySettings();
  useChannelActivityStore.setState({
    latestSeqByChannel: {},
    lastReadByChannel: {},
  });
  client = new QueryClient();
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
  client.clear();
  vi.useRealTimers();
});

describe('summary refresh gate', () => {
  it('refreshes a VISIBLE tab whose rail is unmounted (collapsed sidebar)', async () => {
    await mount();
    apiMock.fetchChannels.mockClear();
    await channelActivity(4);
    await advance(VISIBLE_REFRESH_MS);
    expect(apiMock.fetchChannels).toHaveBeenCalledTimes(1);
  });

  it('refreshes a HIDDEN tab with permission still at `default`', async () => {
    // The circular dependency this closes: an OS-tier event only exists while
    // hidden, the lazy prompt only fires from an OS-tier event, and this refresh
    // is the only lane that can produce a payload while hidden. Gating it on a
    // grant made the whole tier unreachable on a fresh browser.
    delete (globalThis as { Notification?: unknown }).Notification;
    setHidden(true);
    await mount();
    apiMock.fetchChannels.mockClear();
    await channelActivity(4);
    await advance(HIDDEN_REFRESH_MS);
    expect(apiMock.fetchChannels).toHaveBeenCalledTimes(1);
  });

  it('still refreshes a HIDDEN tab whose rail is mounted', async () => {
    // The rail keeps its `['channels']` observer while hidden but suppresses its
    // own refetch there (`pendingWhileHidden`), so an observer count of 1 on a
    // hidden tab means NOBODY is fetching — the exact gap this lane fills.
    setHidden(true);
    await mount();
    const observer = new QueryObserver(client, {
      queryKey: ['channels'],
      queryFn: apiMock.fetchChannels,
      staleTime: 5 * 60_000,
    });
    const unsubscribe = observer.subscribe(() => {});
    apiMock.fetchChannels.mockClear();
    await channelActivity(4);
    await advance(HIDDEN_REFRESH_MS);
    expect(apiMock.fetchChannels).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it('stands down while a VISIBLE tab rail is observing the same key', async () => {
    await mount();
    apiMock.fetchChannels.mockClear();
    const observer = new QueryObserver(client, {
      queryKey: ['channels'],
      queryFn: apiMock.fetchChannels,
      staleTime: 5 * 60_000,
    });
    const unsubscribe = observer.subscribe(() => {});
    apiMock.fetchChannels.mockClear();
    await channelActivity(4);
    await advance(VISIBLE_REFRESH_MS);
    expect(apiMock.fetchChannels).not.toHaveBeenCalled();
    unsubscribe();
  });

  it('decides ownership at FIRE time, not schedule time', async () => {
    // The rail can unmount inside the window; what matters is who owns the
    // fetch when it comes due.
    const observer = new QueryObserver(client, {
      queryKey: ['channels'],
      queryFn: apiMock.fetchChannels,
      staleTime: 5 * 60_000,
    });
    const unsubscribe = observer.subscribe(() => {});
    await mount();
    apiMock.fetchChannels.mockClear();
    await channelActivity(4);
    unsubscribe();
    await advance(VISIBLE_REFRESH_MS);
    expect(apiMock.fetchChannels).toHaveBeenCalledTimes(1);
  });

  it('costs nothing when both message triggers are off', async () => {
    useNotifySettingsStore.getState().setNotifySetting('mentions', false);
    useNotifySettingsStore.getState().setNotifySetting('dmReplies', false);
    await mount();
    apiMock.fetchChannels.mockClear();
    await channelActivity(4);
    await advance(VISIBLE_REFRESH_MS);
    expect(apiMock.fetchChannels).not.toHaveBeenCalled();
  });

  it('is trailing, so a streaming turn cannot starve the refresh', async () => {
    await mount();
    apiMock.fetchChannels.mockClear();
    await channelActivity(1);
    await advance(VISIBLE_REFRESH_MS - 1_000);
    await channelActivity(2);
    await channelActivity(3);
    await advance(1_000);
    expect(apiMock.fetchChannels).toHaveBeenCalledTimes(1);
  });
});

describe('lane teardown', () => {
  it('drops every ledger when the lane is disabled (sign-out, auth expiry)', async () => {
    await mount();
    useNotifyBadgeStore
      .getState()
      .flagChannel('topic:impl-1308', { seq: 9, reason: 'mention' });
    expect(
      Object.keys(useNotifyBadgeStore.getState().flagByChannel)
    ).toHaveLength(1);

    await rerender(false);
    // Stopping the watcher alone would leave the badge flags, the gate's seq
    // ledger and the OS windows behind — so after a re-auth an unread message
    // could never raise its badge again on this tab.
    expect(useNotifyBadgeStore.getState().flagByChannel).toEqual({});
  });

  it('stops refreshing once disabled', async () => {
    await mount();
    await rerender(false);
    apiMock.fetchChannels.mockClear();
    await channelActivity(4);
    await advance(VISIBLE_REFRESH_MS);
    expect(apiMock.fetchChannels).not.toHaveBeenCalled();
  });

  it('restores the document title it found', async () => {
    await mount();
    await act(async () => {
      useNotifyBadgeStore
        .getState()
        .flagChannel('topic:impl-1308', { seq: 9, reason: 'mention' });
    });
    expect(document.title).toBe('(1) Relay');
    await rerender(false);
    expect(document.title).toBe('Relay');
  });
});
