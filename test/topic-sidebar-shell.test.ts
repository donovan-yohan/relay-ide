// @vitest-environment happy-dom

import * as fs from 'node:fs';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceSurface } from '../shared/workspace-surfaces.js';
import {
  resolveTopicActiveContext,
  type WorkspaceTopic,
  type WorkspaceTopicListResponse,
  type WorkspaceTopicSearchResult,
} from '../shared/workspace-topics.js';
import {
  TopicSidebarShell,
  TopicSidebarView,
} from '../frontend/src/components/TopicSidebarShell.js';
import { builtInAgentProfileId } from '../shared/agent-profile.js';
import {
  CHANNEL_SEARCH_HIGHLIGHT_CLOSE,
  CHANNEL_SEARCH_HIGHLIGHT_OPEN,
  CHANNEL_SEARCH_MIN_QUERY_CHARS,
  type ChannelMessageId,
  type ChannelMessageSearchResult,
} from '../shared/channel-chat-protocol.js';
import { createWorkspaceId, LOCAL_WORKSPACE_ID } from '../shared/workspace.js';
import { dmChannelTopicId } from '../frontend/src/lib/dm-channels.js';
import {
  buildTopicRoomCreateInput,
  TOPIC_ROOM_DRAFT_EMPTY,
} from '../frontend/src/lib/topic-create.js';
import {
  channelLastReadKey,
  hasUnseenActivity,
  useChannelActivityStore,
} from '../frontend/src/lib/stores/channel-activity.js';
import { useChannelAgentStatusStore } from '../frontend/src/lib/stores/channel-agent-status.js';
import type {
  ChannelRailSummary,
  ChannelRailThreadSummary,
} from '../frontend/src/lib/state/topic-nav.js';
import { useSessionsStore } from '../frontend/src/lib/stores/sessions.js';
import { useUiStore } from '../frontend/src/lib/stores/ui.js';
import { openTopicTaskRoom } from '../frontend/src/lib/topic-task-room.js';
import { makeSession } from './helpers/frontend-factories.js';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const NOW = '2026-06-26T00:00:00Z';

// #1287 slice 5 fold storage (see frontend/src/lib/stores/ui.ts).
const TOPIC_RAIL_EXPANSION_KEY = 'claude-remote-topic-rail-expansion';
const COLLAPSED_TOPIC_GROUPS_KEY = 'claude-remote-collapsed-topic-groups';
function resetRailFolds() {
  return {
    topicRailExpansion: {} as Record<string, boolean>,
    collapsedTopicGroups: new Set<string>(),
  };
}

// #1287 slice 5 item 19: desktop row presence reads this store, so a status left
// behind by one case would color the next case's rows.
function resetAgentStatusStore() {
  useChannelAgentStatusStore.setState({
    statusByChannelAgent: {},
    runtimeByChannelAgent: {},
    updatedAtByChannelAgent: {},
  });
}

async function flushQueryEffects() {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
}

/**
 * Wait for a rendered condition instead of guessing a tick count (#1293).
 *
 * Resolving a mocked query promise settles on a microtask, then TanStack Query
 * flips `isSuccess` and schedules the re-render on a LATER tick — so a fixed
 * `flushQueryEffects()` intermittently asserts against the pre-render DOM.
 * Polling the DOM itself makes the wait a condition, mirroring the drain fix in
 * 03aff413 without hard-coding how many ticks the chain happens to take.
 *
 * The budget is WALL CLOCK rather than a tick count (#1308 slice 2): the search
 * field debounces before it queries at all, so a tick-counted poll drains a
 * few microtasks in well under the settle window and reports a timeout before
 * the request the case is waiting for was ever sent. Still a condition poll —
 * it returns the instant the DOM satisfies `check` — with a ceiling that
 * outlasts a real debounce instead of one that outlasts only a microtask chain.
 */
const WAIT_FOR_RENDERED_TIMEOUT_MS = 2_000;
const WAIT_FOR_RENDERED_POLL_MS = 10;

async function waitForRendered(
  check: () => boolean,
  description: string
): Promise<void> {
  const deadline = Date.now() + WAIT_FOR_RENDERED_TIMEOUT_MS;
  for (;;) {
    if (check()) return;
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for ${description}`);
    }
    await act(async () => {
      await flushQueryEffects();
      await new Promise((resolve) =>
        setTimeout(resolve, WAIT_FOR_RENDERED_POLL_MS)
      );
    });
  }
}

function makeTopic(overrides: Partial<WorkspaceTopic> = {}): WorkspaceTopic {
  return {
    schemaVersion: 1,
    id: 'topic:alpha',
    workspaceId: 'workspace:alpha',
    source: 'persisted',
    status: 'active',
    visibility: 'default',
    display: { title: 'Build UI shell', description: 'Thin-line topic detail' },
    grouping: {},
    promptDefaults: {},
    routingDefaults: { nodeId: 'devbox', repoPath: '/repo/relay' },
    linkedRefs: { sessionIds: ['s1'] },
    state: { pinned: false, muted: false },
    privacy: {
      classification: 'internal',
      retention: 'project',
      redaction: 'summary',
      rawDefaultsStored: false,
    },
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

/**
 * A `GET /channels` row as the rail consumes it (#1287). Agent senders carry the
 * REAL post-#1234 shape: the sender id is the profile Actor id and the vendor
 * rides `providerId` — the legacy `agent:<vendor>` id is the one form whose
 * trailing segment happens to read like a name, so fixtures must not use it.
 */
function makeChannelSummary(
  overrides: Partial<ChannelRailSummary> & { id: string }
): ChannelRailSummary {
  return {
    latestSeq: 3,
    messageCount: 3,
    members: [
      { kind: 'agent', id: builtInAgentProfileId('claude'), joinedAt: NOW },
    ],
    lastMessage: {
      seq: 3,
      preview: 'latest channel message',
      senderId: builtInAgentProfileId('claude'),
      senderKind: 'agent',
      providerId: 'claude',
      createdAt: NOW,
    },
    ...overrides,
  };
}

/** Bypass React's instance-level value tracker so `input` events are not
 *  deduped as no-ops when the test writes the value directly. */
function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    'value'
  )?.set;
  if (setter) setter.call(input, value);
  else input.value = value;
}

/**
 * One `/channels/search` hit (#1308 slice 2). The snippet carries the REAL
 * Private Use Area sentinels, imported rather than retyped, so the renderer and
 * the server contract cannot drift apart behind a hand-written literal.
 */
function makeMessageHit(
  overrides: Partial<ChannelMessageSearchResult> = {}
): ChannelMessageSearchResult {
  return {
    messageId: 'chm:hit-1' as ChannelMessageId,
    channelId: 'topic:alpha',
    threadId: null,
    seq: 12,
    snippet: `rebuilt the ${CHANNEL_SEARCH_HIGHLIGHT_OPEN}sqlite${CHANNEL_SEARCH_HIGHLIGHT_CLOSE} index`,
    senderKind: 'agent',
    senderId: builtInAgentProfileId('claude'),
    providerId: 'claude',
    createdAt: NOW,
    score: -3.2,
    channelTitle: 'Build UI shell',
    archived: false,
    ...overrides,
  };
}

function makeSurface(
  overrides: Partial<WorkspaceSurface> = {}
): WorkspaceSurface {
  return {
    id: 'surface:preview',
    kind: 'preview',
    label: 'Preview server',
    nodeId: 'devbox',
    workspaceId: 'workspace:alpha',
    repoPath: '/repo/relay',
    status: 'published',
    health: 'reachable',
    provenance: { source: 'agent-published' },
    openMode: 'direct',
    url: 'http://localhost:5173',
    ...overrides,
  };
}

describe('TopicSidebarView', () => {
  let container: HTMLDivElement;
  let root: Root;
  const onSelectSession = vi.fn();

  beforeEach(() => {
    globalThis.ResizeObserver = ResizeObserverStub as typeof ResizeObserver;
    useUiStore.setState({
      advancedMode: false,
      repoDashboardTabIntent: null,
      activeChannelId: null,
      // #1287: the composer flag and the lane pointer are written by the
      // new-chat cases below and are NOT transient — leaving either set leaks
      // one case's navigation into the next, which is how an order-dependent
      // green suite hides a real regression.
      topicComposerOpen: false,
      activeWorkspaceId: null,
      pendingChannelThread: null,
      // #1287 slice 5: rail/lane folds are persisted operator intent now, so
      // they outlive a remount by design — reset them between cases or one
      // test's collapse silently folds the next test's rows.
      ...resetRailFolds(),
    });
    localStorage.removeItem(TOPIC_RAIL_EXPANSION_KEY);
    localStorage.removeItem(COLLAPSED_TOPIC_GROUPS_KEY);
    useChannelActivityStore.setState({
      latestSeqByChannel: {},
      lastReadByChannel: {},
      clampedAtByChannel: {},
    });
    resetAgentStatusStore();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    useSessionsStore.setState({ sessions: [] });
    useUiStore.setState({
      advancedMode: false,
      repoDashboardTabIntent: null,
      activeChannelId: null,
      topicComposerOpen: false,
      pendingChannelThread: null,
      ...resetRailFolds(),
    });
    localStorage.removeItem(TOPIC_RAIL_EXPANSION_KEY);
    localStorage.removeItem(COLLAPSED_TOPIC_GROUPS_KEY);
    useUiStore.getState().setActiveRepoPath(null);
    useUiStore.getState().setActiveWorkspaceId(null);
    useChannelActivityStore.setState({
      latestSeqByChannel: {},
      lastReadByChannel: {},
      clampedAtByChannel: {},
    });
    resetAgentStatusStore();
    localStorage.removeItem(channelLastReadKey('topic:alpha'));
  });

  async function renderView(
    props: Partial<React.ComponentProps<typeof TopicSidebarView>> = {},
    options: {
      advancedMode?: boolean;
      onRender?: React.ProfilerOnRenderCallback;
    } = {}
  ) {
    useUiStore.setState({
      advancedMode: options.advancedMode ?? props.showAdvancedDetail === true,
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const view = React.createElement(TopicSidebarView, {
      topics: [makeTopic()],
      sessions: [makeSession({ id: 's1', displayName: 'Frontend lane' })],
      surfaces: [makeSurface()],
      onSelectSession,
      ...props,
    });
    await act(async () => {
      root.render(
        React.createElement(
          QueryClientProvider,
          { client: queryClient },
          options.onRender
            ? React.createElement(
                React.Profiler,
                { id: 'topic-sidebar', onRender: options.onRender },
                view
              )
            : view
        )
      );
    });
  }

  it('renders a topic row plus explicit advanced detail, linked session, and surface affordance', async () => {
    await renderView({ showAdvancedDetail: true });

    expect(container.querySelector('.topic-shell')).not.toBeNull();
    expect(container.querySelector('.topic-room')).not.toBeNull();
    expect(container.textContent).toContain('Build UI shell');
    expect(container.textContent).toContain('task room');
    expect(container.textContent).toContain('primary action');
    expect(container.textContent).toContain('Thin-line topic detail');
    expect(container.textContent).toContain('Frontend lane');
    expect(container.textContent).toContain('preview');
    expect(container.textContent).toContain('artifacts/surfaces');
    expect(
      container.querySelector('.topic-room__evidence-link')
    ).not.toBeNull();
  });

  it('keeps the default rail to workspaces, channels/DMs, compact presence, and unread state', async () => {
    const dmId = dmChannelTopicId('claude', 'workspace:alpha');
    useChannelActivityStore.setState({
      latestSeqByChannel: { 'topic:alpha': 9 },
      lastReadByChannel: { 'topic:alpha': 3 },
    });

    await renderView(
      {
        showAdvancedDetail: true,
        topics: [
          makeTopic(),
          makeTopic({
            id: dmId,
            display: { title: 'Claude' },
            routingDefaults: { providerId: 'claude' },
            linkedRefs: {},
          }),
        ],
        workspaces: [
          {
            id: 'workspace:alpha',
            name: 'engineering',
            order: 0,
            pinned: false,
            color: null,
            icon: null,
          },
        ],
      },
      { advancedMode: false }
    );

    expect(container.textContent).toContain('engineering');
    expect(container.textContent).toContain('Build UI shell');
    expect(container.textContent).toContain('direct messages');
    expect(container.textContent).toContain('Claude');
    expect(
      container.querySelector(
        `.topic-workspace-group [data-topic-id="${dmId}"]`
      )
    ).not.toBeNull();
    expect(
      container.querySelector(`.topic-mobile-group [data-topic-id="${dmId}"]`)
    ).not.toBeNull();
    expect(
      container.querySelector(
        '.topic-workspace-group [data-topic-id="topic:alpha"][data-unread="true"]'
      )
    ).not.toBeNull();
    expect(
      container.querySelector(
        '.topic-mobile-group [data-topic-id="topic:alpha"][data-unread="true"]'
      )
    ).not.toBeNull();
    expect(
      container.querySelector(
        '.topic-row__activity-dot[aria-label="unread activity"]'
      )
    ).not.toBeNull();
    expect(container.querySelector('.topic-shell__advanced-detail')).toBeNull();
    expect(container.querySelector('.topic-room')).toBeNull();
    expect(container.textContent).not.toContain('task room');
    expect(container.textContent).not.toContain('primary action');
    expect(container.textContent).not.toContain('orchestration');
    expect(container.textContent).not.toContain('raw terminal attach');
    expect(container.querySelector('.topic-participants')).toBeNull();
    expect(container.querySelector('.topic-child-row__button')).not.toBeNull();

    const channelButton = Array.from(
      container.querySelectorAll<HTMLButtonElement>('.topic-row__main')
    ).find((button) => button.textContent?.includes('Build UI shell'));
    expect(channelButton).toBeTruthy();
    await act(async () => channelButton?.click());
    expect(useUiStore.getState().activeChannelId).toBe('topic:alpha');
  });

  it('preserves persisted last-read fallback in the shared rail snapshot', async () => {
    localStorage.setItem(channelLastReadKey('topic:alpha'), '9');
    useChannelActivityStore.setState({
      latestSeqByChannel: { 'topic:alpha': 9 },
      lastReadByChannel: {},
    });

    await renderView();

    expect(
      container.querySelector(
        '[data-topic-id="topic:alpha"][data-unread="true"]'
      )
    ).toBeNull();
    localStorage.removeItem(channelLastReadKey('topic:alpha'));
  });

  it('reports unseen activity for a fresh store seeded from a channel list payload (#1287)', () => {
    localStorage.setItem(channelLastReadKey('topic:alpha'), '3');

    // Fresh store == every reload: `latestSeqByChannel` starts empty, so the rail
    // has no head seq until the channel list seeds it.
    expect(
      hasUnseenActivity('topic:alpha', null, {
        latestSeq: undefined,
        lastRead: undefined,
      })
    ).toBe(false);

    act(() => {
      useChannelActivityStore.getState().seedChannelActivity(
        [
          { id: 'topic:alpha', latestSeq: 9 },
          { id: 'topic:empty', latestSeq: 0 },
        ],
        Date.now()
      );
    });

    const seeded = useChannelActivityStore.getState();
    expect(seeded.latestSeqByChannel['topic:alpha']).toBe(9);
    expect(seeded.latestSeqByChannel['topic:empty']).toBeUndefined();
    expect(
      hasUnseenActivity('topic:alpha', null, {
        latestSeq: seeded.latestSeqByChannel['topic:alpha'],
        lastRead: seeded.lastReadByChannel['topic:alpha'],
      })
    ).toBe(true);

    // Seeding is monotonic up: a list response that lands after a live
    // `channel-activity` broadcast must not rewind the head seq.
    act(() => {
      useChannelActivityStore.getState().recordActivity('topic:alpha', 12);
      useChannelActivityStore
        .getState()
        .seedChannelActivity([{ id: 'topic:alpha', latestSeq: 9 }], Date.now());
    });
    expect(
      useChannelActivityStore.getState().latestSeqByChannel['topic:alpha']
    ).toBe(12);
  });

  it('refuses a channel list payload fetched before a clamp (#1287)', () => {
    // Stale-ahead state a recreated DM leaves behind (#1178), plus the list
    // payload the rail already cached while the head was still high.
    act(() => {
      useChannelActivityStore.getState().recordActivity('topic:alpha', 50);
      useChannelActivityStore.getState().markChannelRead('topic:alpha', 40);
    });
    const cachedFetchedAt = Date.now() - 1;

    act(() => {
      useChannelActivityStore.getState().clampChannelStores('topic:alpha', 5);
    });
    const clamped = useChannelActivityStore.getState();
    expect(clamped.latestSeqByChannel['topic:alpha']).toBe(5);
    expect(clamped.lastReadByChannel['topic:alpha']).toBe(5);

    // The rail remounts (sidebar collapse) and React Query replays the cached
    // pre-clamp payload; re-seeding head 50 against the clamped read marker 5
    // would pin the unread dot on for the channel's whole new lifetime.
    act(() => {
      useChannelActivityStore
        .getState()
        .seedChannelActivity(
          [{ id: 'topic:alpha', latestSeq: 50 }],
          cachedFetchedAt
        );
    });
    const afterStaleSeed = useChannelActivityStore.getState();
    expect(afterStaleSeed.latestSeqByChannel['topic:alpha']).toBe(5);
    expect(
      hasUnseenActivity('topic:alpha', null, {
        latestSeq: afterStaleSeed.latestSeqByChannel['topic:alpha'],
        lastRead: afterStaleSeed.lastReadByChannel['topic:alpha'],
      })
    ).toBe(false);

    // A payload fetched after the clamp is authoritative again.
    act(() => {
      useChannelActivityStore
        .getState()
        .seedChannelActivity(
          [{ id: 'topic:alpha', latestSeq: 7 }],
          Date.now() + 1_000
        );
    });
    const afterFreshSeed = useChannelActivityStore.getState();
    expect(afterFreshSeed.latestSeqByChannel['topic:alpha']).toBe(7);
    expect(
      hasUnseenActivity('topic:alpha', null, {
        latestSeq: afterFreshSeed.latestSeqByChannel['topic:alpha'],
        lastRead: afterFreshSeed.lastReadByChannel['topic:alpha'],
      })
    ).toBe(true);
  });

  it('seeds unread head seqs from the channel list on shell mount (#1287)', async () => {
    localStorage.setItem(channelLastReadKey('topic:alpha'), '3');
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const topicsResponse: WorkspaceTopicListResponse = {
      topics: [makeTopic()],
      truncated: false,
      derived: false,
    };
    queryClient.setQueryData(['workspace-topics'], topicsResponse);
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const body =
        url === '/channels'
          ? { channels: [{ id: 'topic:alpha', latestSeq: 9 }] }
          : {};
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchMock);

    await act(async () => {
      root.render(
        React.createElement(
          QueryClientProvider,
          { client: queryClient },
          React.createElement(TopicSidebarShell, { onSelectSession })
        )
      );
      await flushQueryEffects();
    });
    // Drain the fetch → query-cache → seed-effect → re-render chain.
    for (let attempt = 0; attempt < 10; attempt += 1) {
      if (
        useChannelActivityStore.getState().latestSeqByChannel['topic:alpha'] !==
        undefined
      )
        break;
      await act(async () => {
        await flushQueryEffects();
      });
    }

    expect(fetchMock).toHaveBeenCalledWith('/channels', {
      headers: { 'x-relay-capabilities': 'context:read' },
    });
    expect(
      useChannelActivityStore.getState().latestSeqByChannel['topic:alpha']
    ).toBe(9);
    expect(
      container.querySelector(
        '[data-topic-id="topic:alpha"][data-unread="true"]'
      )
    ).not.toBeNull();
    queryClient.clear();
  });

  // `GET /channels` is O(channels) on the hub, and a streaming turn emits a
  // badge per message create / stream open / stream complete. The rail's refresh
  // lane must therefore stay throttled AND silent while the tab is hidden,
  // deferring one refresh to the moment the operator comes back.
  it('defers the throttled channel-list refresh while the tab is hidden (#1287)', async () => {
    vi.useFakeTimers();
    try {
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });
      queryClient.setQueryData(['workspace-topics'], {
        topics: [makeTopic()],
        truncated: false,
        derived: false,
      } satisfies WorkspaceTopicListResponse);
      vi.stubGlobal(
        'fetch',
        vi.fn(
          async () =>
            new Response(JSON.stringify({ channels: [] }), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            })
        ) as unknown as typeof fetch
      );
      const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
      const channelListRefreshes = () =>
        invalidateSpy.mock.calls.filter(
          (call) =>
            Array.isArray(call[0]?.queryKey) &&
            call[0].queryKey[0] === 'channels'
        ).length;

      act(() => {
        root.render(
          React.createElement(
            QueryClientProvider,
            { client: queryClient },
            React.createElement(TopicSidebarShell, { onSelectSession })
          )
        );
      });

      // Visible tab: one refresh per throttle window, not per activity event.
      act(() => {
        useChannelActivityStore.getState().recordActivity('topic:alpha', 5);
        useChannelActivityStore.getState().recordActivity('topic:alpha', 6);
        vi.advanceTimersByTime(10_000);
      });
      expect(channelListRefreshes()).toBe(1);

      // Hidden tab: the window elapses without touching the hub.
      const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
      act(() => {
        useChannelActivityStore.getState().recordActivity('topic:alpha', 7);
        vi.advanceTimersByTime(60_000);
      });
      expect(channelListRefreshes()).toBe(1);

      // Coming back to the foreground settles the deferred refresh exactly once.
      hidden.mockReturnValue(false);
      act(() => {
        document.dispatchEvent(new Event('visibilitychange'));
      });
      expect(channelListRefreshes()).toBe(2);
      hidden.mockRestore();
      queryClient.clear();
    } finally {
      vi.useRealTimers();
    }
  });

  // #1287 item 6: the rail listed bare topic records while GET /channels already
  // returned the per-row payload the Slack-style UX needs. Rows now join that
  // summary by id.
  it('hydrates rail rows with the channel summary last message and stamp (#1287)', async () => {
    await renderView({
      topics: [makeTopic()],
      channelSummaries: [
        makeChannelSummary({
          id: 'topic:alpha',
          lastMessage: {
            seq: 7,
            preview: 'pushed the row payload join',
            senderId: builtInAgentProfileId('claude'),
            senderKind: 'agent',
            providerId: 'claude',
            createdAt: new Date(Date.now() - 5 * 60_000).toISOString(),
          },
        }),
      ],
    });

    const preview = container.querySelector('.topic-row__preview');
    expect(preview?.textContent).toBe('claude: pushed the row payload join');
    expect(container.querySelector('.topic-row__time')?.textContent).toBe('5m');
    // Title still renders alongside the snippet — hydration is additive.
    expect(container.querySelector('.topic-row__title')?.textContent).toContain(
      'Build UI shell'
    );
  });

  it('renders rows with no channel summary (derived/fallback topics) unchanged (#1287)', async () => {
    await renderView({
      topics: [makeTopic({ source: 'derived' })],
      derived: true,
      channelSummaries: [],
    });

    expect(container.querySelector('.topic-row')).not.toBeNull();
    expect(container.querySelector('.topic-row__title')?.textContent).toContain(
      'Build UI shell'
    );
    expect(container.querySelector('.topic-row__preview')).toBeNull();
    expect(container.querySelector('.topic-row__time')).toBeNull();
    // Nothing to join a presence indicator against either (#1287 slice 5).
    expect(container.querySelector('.topic-row__presence')).toBeNull();
  });

  // #1287 slice 5 item 19: desktop rows used to carry no agent presence at all —
  // the roster fan-out that produced presence chips is gated to the mobile
  // cockpit. Presence now comes from the summary members the rail already holds.
  it('shows desktop row presence from the summary members joined with live status (#1287)', async () => {
    useChannelAgentStatusStore.setState({
      statusByChannelAgent: { 'topic:alpha codex': 'streaming' },
      runtimeByChannelAgent: {},
      updatedAtByChannelAgent: {},
    });
    await renderView({
      topics: [makeTopic()],
      channelSummaries: [
        makeChannelSummary({
          id: 'topic:alpha',
          members: [
            { kind: 'agent', id: 'claude', joinedAt: NOW },
            { kind: 'agent', id: 'codex', joinedAt: NOW },
            { kind: 'human', id: 'human:operator', joinedAt: NOW },
          ],
        }),
      ],
    });

    const presence = container.querySelector<HTMLElement>(
      '.topic-tree [data-topic-id="topic:alpha"] .topic-row__presence'
    );
    expect(presence).not.toBeNull();
    // Two agent members (the human is not presence), rolled up to the live
    // streaming agent's state.
    expect(presence?.dataset.agentCount).toBe('2');
    expect(presence?.dataset.presence).toBe('working');
    // Queried by accessible name, not by class: ARIA does not permit naming a
    // generic element, so an aria-label on a bare span is discarded and the
    // dot/spinner children are aria-hidden — the state would reach a mouse
    // tooltip and nothing else.
    expect(
      container.querySelector('[role="img"][aria-label="2 agents working"]')
    ).toBe(presence);
    // The row's own status name is exposed too; `role="group"` names the trail
    // without turning the presence indicator inside it presentational.
    expect(
      container
        .querySelector('.topic-tree [data-topic-id="topic:alpha"] .topic-row')
        ?.querySelector('[role="group"]')
    ).toBe(presence?.parentElement);
    expect(
      presence?.querySelector('.topic-row__presence-count')?.textContent
    ).toBe('2');
    // Working liveness is the braille spinner (DESIGN.md text motion); the 50%
    // dot carries every other state.
    expect(
      presence?.querySelector('.topic-row__presence-spinner')
    ).not.toBeNull();
    expect(presence?.querySelector('.topic-row__presence-dot')).toBeNull();
  });

  it('rests a desktop presence indicator on the 50% status dot with no count for a lone agent (#1287)', async () => {
    await renderView({
      topics: [makeTopic()],
      channelSummaries: [
        makeChannelSummary({
          id: 'topic:alpha',
          members: [{ kind: 'agent', id: 'claude', joinedAt: NOW }],
        }),
      ],
    });

    const presence = container.querySelector<HTMLElement>(
      '.topic-tree [data-topic-id="topic:alpha"] .topic-row__presence'
    );
    expect(presence?.dataset.presence).toBe('idle');
    expect(
      container.querySelector('[role="img"][aria-label="1 agent idle"]')
    ).toBe(presence);
    expect(presence?.querySelector('.topic-row__presence-dot')).not.toBeNull();
    expect(presence?.querySelector('.topic-row__presence-spinner')).toBeNull();
    // A single agent stays uncluttered — the count lives in the label only.
    expect(presence?.querySelector('.topic-row__presence-count')).toBeNull();
  });

  it('omits desktop presence for a human-only channel (#1287)', async () => {
    await renderView({
      topics: [makeTopic()],
      channelSummaries: [
        makeChannelSummary({
          id: 'topic:alpha',
          members: [{ kind: 'human', id: 'human:operator', joinedAt: NOW }],
        }),
      ],
    });

    expect(
      container.querySelector(
        '.topic-tree [data-topic-id="topic:alpha"] .topic-row__presence'
      )
    ).toBeNull();
  });

  // #1287 slice 5 item 18: threads existed server-side and in ChannelView, but
  // the only entry point was the in-timeline "N replies" chip — so a live thread
  // was unreachable until its channel was already open.
  describe('rail thread rows (#1287 slice 5 item 18)', () => {
    function makeThread(overrides: Partial<ChannelRailThreadSummary> = {}) {
      return {
        rootMessageId: 'chm:root-1',
        replyCount: 2,
        lastReplyAt: NOW,
        preview: 'how should the binder key runtimes?',
        rootSenderId: builtInAgentProfileId('claude'),
        rootSenderKind: 'agent' as const,
        providerId: 'claude',
        ...overrides,
      };
    }

    async function renderWithThreads(
      threads: ChannelRailThreadSummary[],
      threadCount = threads.length
    ) {
      await renderView({
        topics: [makeTopic({ id: 'topic:alpha', display: { title: 'alpha' } })],
        sessions: [],
        surfaces: [],
        channelSummaries: [
          makeChannelSummary({ id: 'topic:alpha', threads, threadCount }),
        ],
      });
    }

    function threadsBlock(): HTMLElement | null {
      return container.querySelector<HTMLElement>(
        '.topic-tree [data-topic-id="topic:alpha"] .topic-threads'
      );
    }

    it('shows a collapsed thread count plus the latest thread line', async () => {
      await renderWithThreads([makeThread()], 3);

      const block = threadsBlock();
      expect(block).not.toBeNull();
      expect(block?.dataset.threadCount).toBe('3');
      const toggle = block?.querySelector<HTMLButtonElement>(
        '.topic-threads__toggle'
      );
      // Collapsed by default: the fold id is never a rail root, so nothing
      // auto-opens it.
      expect(toggle?.getAttribute('aria-expanded')).toBe('false');
      expect(block?.querySelector('.topic-threads__count')?.textContent).toBe(
        '3 threads'
      );
      // The sender label comes from the server-resolved vendor, never by
      // splitting the profile Actor id (#1234).
      expect(block?.querySelector('.topic-threads__latest')?.textContent).toBe(
        'claude: how should the binder key runtimes?'
      );
      expect(block?.querySelector('.topic-thread-row')).toBeNull();
    });

    it('leaves a channel with no threads exactly as it was', async () => {
      await renderView({
        topics: [makeTopic({ id: 'topic:alpha', display: { title: 'alpha' } })],
        sessions: [],
        surfaces: [],
        channelSummaries: [makeChannelSummary({ id: 'topic:alpha' })],
      });

      expect(threadsBlock()).toBeNull();
      expect(container.querySelector('.topic-thread-row')).toBeNull();
      // The row itself is untouched — title and hydrated snippet still render.
      expect(container.textContent).toContain('alpha');
      expect(container.textContent).toContain('latest channel message');
    });

    it('expands to one row per thread and opens the channel with that thread', async () => {
      await renderWithThreads([
        makeThread(),
        makeThread({
          rootMessageId: 'chm:root-2',
          replyCount: 1,
          preview: 'rollout plan',
          rootSenderId: 'human:operator',
          rootSenderKind: 'human',
        }),
      ]);

      await act(async () => {
        threadsBlock()
          ?.querySelector<HTMLButtonElement>('.topic-threads__toggle')
          ?.click();
      });

      const rows = Array.from(
        container.querySelectorAll<HTMLElement>(
          '.topic-tree [data-topic-id="topic:alpha"] .topic-thread-row'
        )
      );
      expect(rows.map((row) => row.dataset.threadRootId)).toEqual([
        'chm:root-1',
        'chm:root-2',
      ]);
      expect(
        rows[0]?.querySelector('.topic-thread-row__meta')?.textContent
      ).toContain('2 replies');
      // Singular/plural is the same copy the in-timeline chip and thread panel
      // use, so the rail cannot drift from them.
      expect(
        rows[1]?.querySelector('.topic-thread-row__meta')?.textContent
      ).toContain('1 reply');
      expect(
        rows[1]?.querySelector('.topic-thread-row__preview')?.textContent
      ).toBe('you: rollout plan');

      await act(async () => {
        rows[1]
          ?.querySelector<HTMLButtonElement>('.topic-thread-row__button')
          ?.click();
      });

      // Opening the channel is what makes the thread reachable; the thread
      // itself rides an intent, because `setActiveChannelId` clears
      // `activeThreadRootId` and ChannelView clears it again on every switch.
      expect(useUiStore.getState().activeChannelId).toBe('topic:alpha');
      expect(useUiStore.getState().pendingChannelThread).toEqual({
        channelId: 'topic:alpha',
        rootMessageId: 'chm:root-2',
      });
    });

    it('keeps the thread fold independent of the channel row fold', async () => {
      await renderWithThreads([makeThread()]);

      await act(async () => {
        threadsBlock()
          ?.querySelector<HTMLButtonElement>('.topic-threads__toggle')
          ?.click();
      });
      expect(container.querySelector('.topic-thread-row')).not.toBeNull();

      // Collapsing the channel row must not take the thread list with it — the
      // thread line IS the signal that this channel has side-conversations.
      await act(async () => {
        useUiStore.getState().setTopicRailExpanded('topic:alpha', false);
      });
      expect(container.querySelector('.topic-thread-row')).not.toBeNull();
      // And the fold is persisted operator intent, like every other rail fold.
      expect(
        useUiStore.getState().topicRailExpansion['topic:alpha#threads']
      ).toBe(true);
    });
  });

  it('labels the operator as the snippet sender and skips message-less channels (#1287)', async () => {
    await renderView({
      topics: [
        makeTopic({ id: 'topic:alpha', display: { title: 'alpha' } }),
        makeTopic({
          id: 'topic:quiet',
          display: { title: 'quiet' },
          linkedRefs: {},
        }),
      ],
      sessions: [],
      surfaces: [],
      channelSummaries: [
        makeChannelSummary({
          id: 'topic:alpha',
          lastMessage: {
            seq: 2,
            preview: 'ack',
            senderId: 'human:operator',
            senderKind: 'human',
            createdAt: NOW,
          },
        }),
        makeChannelSummary({
          id: 'topic:quiet',
          latestSeq: 0,
          messageCount: 0,
          lastMessage: null,
        }),
      ],
    });

    const previews = [...container.querySelectorAll('.topic-row__preview')].map(
      (node) => node.textContent
    );
    expect(previews).toEqual(['you: ack']);
  });

  // Sender ids are profile Actor ids (#1234): `agent-profile:<vendor>:default`
  // and `agent-profile:<vendor>:<uuid>`. Splitting one for a label renders
  // "default:" / "<uuid>:", so the label must come from the server-resolved
  // display name or providerId, with the VENDOR segment as the only fallback.
  it('labels agent snippets from the resolved identity, never the profile id tail (#1234)', async () => {
    const customProfileId = 'agent-profile:claude:9f3ac1de-42b7-4d1a-8f00-1e2b';
    await renderView({
      topics: [
        makeTopic({ id: 'topic:alpha', display: { title: 'alpha' } }),
        makeTopic({ id: 'topic:beta', display: { title: 'beta' } }),
        makeTopic({ id: 'topic:gamma', display: { title: 'gamma' } }),
      ],
      sessions: [],
      surfaces: [],
      channelSummaries: [
        // Built-in default profile: no stored display name, vendor on providerId.
        makeChannelSummary({
          id: 'topic:alpha',
          lastMessage: {
            seq: 3,
            preview: 'built-in default reply',
            senderId: builtInAgentProfileId('codex'),
            senderKind: 'agent',
            providerId: 'codex',
            createdAt: NOW,
          },
        }),
        // Custom profile: the authored name wins over the vendor.
        makeChannelSummary({
          id: 'topic:beta',
          lastMessage: {
            seq: 3,
            preview: 'custom profile reply',
            senderId: customProfileId,
            senderKind: 'agent',
            senderDisplayName: 'Reviewer Claude',
            providerId: 'claude',
            createdAt: NOW,
          },
        }),
        // Neither field resolved (older row): fall back to the VENDOR segment.
        makeChannelSummary({
          id: 'topic:gamma',
          lastMessage: {
            seq: 3,
            preview: 'unresolved reply',
            senderId: customProfileId,
            senderKind: 'agent',
            createdAt: NOW,
          },
        }),
      ],
    });

    const previews = [...container.querySelectorAll('.topic-row__preview')].map(
      (node) => node.textContent
    );
    expect(previews).toEqual([
      'codex: built-in default reply',
      'Reviewer Claude: custom profile reply',
      'claude: unresolved reply',
    ]);
    expect(previews.some((text) => text?.startsWith('default:'))).toBe(false);
  });

  // The summary preview is truncated server-side, so re-deriving the mention
  // signal from it drops any `@operator` past the cut-off — exactly the long
  // agent status update the attention lane exists for. The payload carries
  // server-computed mention refs over the FULL body instead.
  it('keeps the mention bonus when the mention sits past the preview cut-off', async () => {
    useChannelActivityStore.setState({
      latestSeqByChannel: { 'topic:alpha': 9, 'topic:beta': 9 },
      lastReadByChannel: { 'topic:alpha': 3, 'topic:beta': 3 },
      clampedAtByChannel: {},
    });
    const longStatus = `${'status update. '.repeat(40)}@operator please confirm`;
    const truncatedPreview = longStatus.slice(0, 200);
    expect(truncatedPreview).not.toContain('@operator');

    await renderView({
      topics: [
        makeTopic({
          id: 'topic:alpha',
          display: { title: 'alpha' },
          linkedRefs: {},
        }),
        makeTopic({
          id: 'topic:beta',
          display: { title: 'beta' },
          linkedRefs: {},
        }),
      ],
      sessions: [],
      surfaces: [],
      channelSummaries: [
        makeChannelSummary({
          id: 'topic:alpha',
          latestSeq: 9,
          lastMessage: {
            seq: 9,
            preview: 'no mention here',
            senderId: builtInAgentProfileId('claude'),
            senderKind: 'agent',
            providerId: 'claude',
            createdAt: NOW,
          },
        }),
        makeChannelSummary({
          id: 'topic:beta',
          latestSeq: 9,
          lastMessage: {
            seq: 9,
            preview: truncatedPreview,
            senderId: builtInAgentProfileId('claude'),
            senderKind: 'agent',
            providerId: 'claude',
            mentions: [{ raw: '@operator' }],
            createdAt: NOW,
          },
        }),
      ],
    });

    const attentionTitles = [
      ...container.querySelectorAll('.topic-cockpit__attention-title'),
    ].map((node) => node.textContent);
    // Without the mention bonus these tie and sort alphabetically.
    expect(attentionTitles).toEqual(['#beta', '#alpha']);
  });

  // #1287 item 6: the mobile cockpit used to fan out a limit-1 `channel-history`
  // request per unread channel just to learn whether the newest message
  // mentioned the operator. The channel list already carries that row, so the
  // per-channel history calls must be gone.
  it('drops the per-unread-channel history fan-out in the mobile cockpit (#1287)', async () => {
    localStorage.setItem(channelLastReadKey('topic:alpha'), '3');
    useUiStore.setState({ sidebarOpen: true });
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query === '(max-width: 600px)',
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const topicsResponse: WorkspaceTopicListResponse = {
      topics: [makeTopic()],
      truncated: false,
      derived: false,
    };
    queryClient.setQueryData(['workspace-topics'], topicsResponse);
    const requested: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      requested.push(url);
      const body =
        url === '/channels'
          ? {
              channels: [
                makeChannelSummary({
                  id: 'topic:alpha',
                  latestSeq: 9,
                  lastMessage: {
                    seq: 9,
                    preview: '@operator please review',
                    senderId: 'agent:claude',
                    senderKind: 'agent',
                    createdAt: NOW,
                  },
                }),
              ],
            }
          : url.endsWith('/roster')
            ? { roster: [] }
            : {};
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchMock);

    await act(async () => {
      root.render(
        React.createElement(
          QueryClientProvider,
          { client: queryClient },
          React.createElement(TopicSidebarShell, { onSelectSession })
        )
      );
      await flushQueryEffects();
    });
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (
        requested.some((url) => url.endsWith('/roster')) &&
        useChannelActivityStore.getState().latestSeqByChannel['topic:alpha'] !==
          undefined
      ) {
        break;
      }
      await act(async () => {
        await flushQueryEffects();
      });
    }

    // The cockpit reconcile path really ran (roster is per-channel and stays)...
    expect(requested).toContain('/channels/topic%3Aalpha/roster');
    // ...and the row is unread, which is exactly what used to trigger the
    // limit-1 history fetch.
    expect(
      useChannelActivityStore.getState().latestSeqByChannel['topic:alpha']
    ).toBe(9);
    // One list call, and no per-channel message reads at all.
    expect(requested.filter((url) => url === '/channels')).toHaveLength(1);
    expect(requested.filter((url) => url.includes('/messages'))).toEqual([]);
    queryClient.clear();
  });

  // #1287 slice 5 item 19: desktop rows gained presence WITHOUT un-gating the
  // per-channel roster fan-out — it costs one request per row, so presence is a
  // join over the one channel-list payload the rail already fetches.
  it('adds no per-row roster fetch for desktop presence (#1287)', async () => {
    useUiStore.setState({ sidebarOpen: true });
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    useChannelAgentStatusStore.setState({
      statusByChannelAgent: { 'topic:alpha codex': 'waiting' },
      runtimeByChannelAgent: {},
      updatedAtByChannelAgent: {},
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const topicsResponse: WorkspaceTopicListResponse = {
      topics: [makeTopic()],
      truncated: false,
      derived: false,
    };
    queryClient.setQueryData(['workspace-topics'], topicsResponse);
    const requested: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      requested.push(url);
      const body =
        url === '/channels'
          ? {
              channels: [
                makeChannelSummary({
                  id: 'topic:alpha',
                  members: [
                    { kind: 'agent', id: 'claude', joinedAt: NOW },
                    { kind: 'agent', id: 'codex', joinedAt: NOW },
                  ],
                }),
              ],
            }
          : url.endsWith('/roster')
            ? { roster: [] }
            : {};
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchMock);

    await act(async () => {
      root.render(
        React.createElement(
          QueryClientProvider,
          { client: queryClient },
          React.createElement(TopicSidebarShell, { onSelectSession })
        )
      );
      await flushQueryEffects();
    });
    // Poll the rendered join, not a tick count (#1293): the store-only presence
    // paints first and the summary members arrive a render later.
    await waitForRendered(
      () =>
        container.querySelector<HTMLElement>(
          '.topic-tree [data-topic-id="topic:alpha"] .topic-row__presence'
        )?.dataset.agentCount === '2',
      'desktop presence indicator hydrated from the channel list'
    );

    const presence = container.querySelector<HTMLElement>(
      '.topic-tree [data-topic-id="topic:alpha"] .topic-row__presence'
    );
    expect(presence?.dataset.agentCount).toBe('2');
    // Live 'waiting' from the status store outranks the quiet member.
    expect(presence?.dataset.presence).toBe('blocked');
    // The list is the ONLY channel read; no roster call was made on desktop.
    expect(requested.filter((url) => url === '/channels')).toHaveLength(1);
    expect(requested.filter((url) => url.endsWith('/roster'))).toEqual([]);
    queryClient.clear();
  });

  it('does not commit the sidebar for unrelated channel activity', async () => {
    let commits = 0;
    await renderView(
      {
        topics: [makeTopic({ id: 'topic:relevant' })],
        sessions: [],
        surfaces: [],
      },
      { onRender: () => commits++ }
    );
    const committedBeforeUnrelatedActivity = commits;

    await act(async () => {
      useChannelActivityStore.getState().recordActivity('topic:unrelated', 1);
    });

    expect(commits).toBe(committedBeforeUnrelatedActivity);
  });

  it('reveals mechanical detail only in advanced mode and hands evidence to the repo dashboard', async () => {
    await renderView({ showAdvancedDetail: true }, { advancedMode: true });

    expect(
      container.querySelector('.topic-shell__advanced-detail')
    ).not.toBeNull();
    expect(container.querySelector('.topic-room')).not.toBeNull();
    expect(container.textContent).toContain('task room');
    expect(container.textContent).toContain('primary action');
    expect(container.textContent).toContain('sessions');
    expect(container.textContent).toContain('artifacts/surfaces');
    expect(container.textContent).toContain('raw terminal attach');
    expect(container.querySelector('.topic-participants')).not.toBeNull();

    const evidenceLink = container.querySelector(
      '.topic-room__evidence-link'
    ) as HTMLButtonElement;
    expect(evidenceLink).not.toBeNull();
    await act(async () => evidenceLink.click());

    expect(useUiStore.getState().activeWorkspaceId).toBe('workspace:alpha');
    expect(useUiStore.getState().activeRepoPath).toBe('/repo/relay');
    expect(useUiStore.getState().activeChannelId).toBeNull();
    expect(useUiStore.getState().repoDashboardTabIntent).toEqual({
      repoPath: '/repo/relay',
      tab: 'evidence',
    });
  });

  it('renders terminal sessions flat and selects the exact session', async () => {
    await renderView(
      {
        showAdvancedDetail: true,
        sessions: [
          makeSession({
            id: 'orch',
            nodeId: 'node-a',
            displayName: 'persistent planner',
            idle: false,
          }),
          makeSession({
            id: 'worker-a',
            nodeId: 'node-b',
            displayName: 'alpha worker',
          }),
          makeSession({
            id: 'worker-b',
            nodeId: 'node-b',
            globalSessionId: 'global:worker-b',
            displayName: 'beta worker',
          }),
        ],
        surfaces: [],
      },
      { advancedMode: true }
    );

    const tree = container.querySelector(
      '.topic-room .session-lineage-tree'
    ) as HTMLElement;
    expect(tree).not.toBeNull();
    expect(tree.textContent).toContain('persistent planner');
    expect(tree.textContent).toContain('alpha worker');
    expect(tree.textContent).toContain('beta worker');
    expect(
      container.querySelector('.topic-mobile-cockpit .session-lineage-tree')
    ).not.toBeNull();
    expect(
      tree
        .querySelector('[data-session-id="worker-a"]')
        ?.parentElement?.style.getPropertyValue('--session-lineage-depth')
    ).toBe('0');

    const worker = tree.querySelector(
      '[data-session-id="worker-b"]'
    ) as HTMLButtonElement;
    await act(async () => worker.click());
    expect(onSelectSession).toHaveBeenCalledWith('global:worker-b');
  });

  it('keeps sessions flat when no orchestrator lineage is available', async () => {
    await renderView(
      {
        showAdvancedDetail: true,
        sessions: [
          makeSession({ id: 'standalone', displayName: 'plain session' }),
        ],
        surfaces: [],
      },
      { advancedMode: true }
    );

    const tree = container.querySelector(
      '.topic-room .session-lineage-tree'
    ) as HTMLElement;
    expect(tree.className).toContain('session-lineage-tree--flat');
    expect(tree.textContent).toContain('plain session');
    expect(tree.textContent).not.toContain('orchestrator');
  });

  it('keeps collapsed topic rows free of linked-item and recency metadata', async () => {
    await renderView();

    const trail = container.querySelector('.topic-row__trail');
    expect(trail?.getAttribute('aria-label')).toBe('idle');
    expect(container.querySelector('.topic-chip')).toBeNull();
    expect(container.querySelector('.topic-row__hover-actions')).toBeNull();
    expect(container.querySelector('.topic-row__recency')).toBeNull();
    expect(container.querySelector('.topic-shell__advanced-detail')).toBeNull();
    expect(container.querySelector('.topic-room')).toBeNull();
  });

  it('groups topics under workspace channel headers', async () => {
    await renderView({
      topics: [
        makeTopic({
          id: 'topic:a',
          workspaceId: 'ws:a',
          display: { title: 'Alpha channel' },
          linkedRefs: {},
        }),
        makeTopic({
          id: 'topic:b',
          workspaceId: 'ws:b',
          display: { title: 'Beta channel' },
          linkedRefs: {},
        }),
      ],
      sessions: [],
      surfaces: [],
      workspaces: [
        {
          id: 'ws:a',
          name: 'engineering',
          order: 0,
          pinned: false,
          color: null,
          icon: null,
        },
        {
          id: 'ws:b',
          name: 'research',
          order: 1,
          pinned: false,
          color: null,
          icon: null,
        },
      ],
    });
    const headers = Array.from(
      container.querySelectorAll('.topic-workspace-group__name')
    ).map((el) => el.textContent);
    expect(headers).toContain('engineering');
    expect(headers).toContain('research');
    expect(container.textContent).toContain('Alpha channel');
    expect(container.textContent).toContain('Beta channel');
  });

  it('groups the mobile cockpit under the same workspace headers (#1088)', async () => {
    await renderView({
      topics: [
        makeTopic({
          id: 'topic:a',
          workspaceId: 'ws:a',
          display: { title: 'Alpha channel' },
          linkedRefs: {},
        }),
        makeTopic({
          id: 'topic:b',
          workspaceId: 'ws:b',
          display: { title: 'Beta channel' },
          linkedRefs: {},
        }),
      ],
      sessions: [],
      surfaces: [],
      workspaces: [
        {
          id: 'ws:a',
          name: 'engineering',
          order: 0,
          pinned: false,
          color: null,
          icon: null,
        },
        {
          id: 'ws:b',
          name: 'research',
          order: 1,
          pinned: false,
          color: null,
          icon: null,
        },
      ],
    });
    const mobileHeaders = Array.from(
      container.querySelectorAll('.topic-mobile-group__name')
    ).map((el) => el.textContent);
    expect(mobileHeaders).toContain('engineering');
    expect(mobileHeaders).toContain('research');
  });

  // #1287 item 3: a workspace holding no channels used to be dropped from the
  // rail entirely, so a just-added project was invisible until a chat existed
  // inside it — impossible, because the lane was also the only way to pick it
  // as the create target. The id shape here is the deterministic, path-keyed
  // one add-project mints (item 2).
  const emptyLaneId = createWorkspaceId('project:/repo/fresh');
  const emptyLaneSelector = `.topic-workspace-group[data-workspace-id="${emptyLaneId}"]`;
  // Both lanes carry the repo anchor `ensureProjectWorkspace` stamps on every
  // add-project workspace, so a create can be checked for lane/repo AGREEMENT
  // rather than lane alone (#1287).
  const OLD_LANE_REPO = '/repo/old';
  const FRESH_LANE_REPO = '/repo/fresh';

  async function renderWithEmptyLane(
    extra: Partial<React.ComponentProps<typeof TopicSidebarView>> = {}
  ) {
    await renderView({
      topics: [
        makeTopic({
          id: 'topic:a',
          workspaceId: 'ws:a',
          display: { title: 'Alpha channel' },
          linkedRefs: {},
        }),
      ],
      sessions: [],
      surfaces: [],
      workspaces: [
        {
          id: 'ws:a',
          name: 'engineering',
          order: 0,
          pinned: false,
          color: null,
          icon: null,
          defaultRepoPath: OLD_LANE_REPO,
        },
        {
          id: emptyLaneId,
          name: 'fresh',
          order: 1,
          pinned: false,
          color: null,
          icon: null,
          defaultRepoPath: FRESH_LANE_REPO,
        },
      ],
      ...extra,
    });
  }

  it('renders a known workspace with zero channels as a lane with a start-a-chat affordance (#1287)', async () => {
    await renderWithEmptyLane({ onCreateTaskRoom: vi.fn() });

    const lane = container.querySelector(emptyLaneSelector);
    expect(lane).not.toBeNull();
    expect(
      lane?.querySelector('.topic-workspace-group__name')?.textContent
    ).toBe('fresh');
    // The populated lane still renders its channels; the empty one renders the
    // affordance in place of the (empty) channel list.
    expect(
      container.querySelector(
        '.topic-workspace-group[data-workspace-id="ws:a"] [data-rail-section="channels"]'
      )
    ).not.toBeNull();
    expect(lane?.querySelector('[data-rail-section="channels"]')).toBeNull();
    const start = lane?.querySelector<HTMLButtonElement>(
      '.topic-workspace-group__empty'
    );
    // Same control as the rail header's `new chat`, no second visual language.
    expect(start?.className).toContain('topic-shell__create');
    expect(start?.textContent).toBe('new chat');
    expect(start?.disabled).toBe(false);
    // Desktop and mobile read the same projection, so the lane exists in both.
    expect(
      container.querySelector(
        `.topic-mobile-group[data-workspace-id="${emptyLaneId}"] .topic-mobile-group__empty`
      )
    ).not.toBeNull();

    await renderWithEmptyLane();
    expect(
      container.querySelector<HTMLButtonElement>(
        `${emptyLaneSelector} .topic-workspace-group__empty`
      )?.disabled
    ).toBe(true);
  });

  it('makes an empty workspace lane selectable as the real ia_workspaces id (#1287)', async () => {
    await renderWithEmptyLane();
    expect(useUiStore.getState().activeWorkspaceId).toBeNull();

    const header = container.querySelector<HTMLButtonElement>(
      `${emptyLaneSelector} .topic-workspace-group__select`
    );
    expect(header).not.toBeNull();
    await act(async () => header?.click());

    expect(useUiStore.getState().activeWorkspaceId).toBe(emptyLaneId);
  });

  it('stamps the empty lane workspace id on a chat created from that lane (#1287)', async () => {
    const onCreateTaskRoom = vi.fn();
    await renderWithEmptyLane({ onCreateTaskRoom });

    const start = container.querySelector<HTMLButtonElement>(
      `${emptyLaneSelector} [data-workspace-start-chat="${emptyLaneId}"]`
    );
    await act(async () => start?.click());

    expect(onCreateTaskRoom).toHaveBeenCalledTimes(1);
    expect(useUiStore.getState().activeWorkspaceId).toBe(emptyLaneId);
    // Every create path resolves its workspace from the active pointer, so the
    // chat the operator now writes lands in THIS lane instead of falling back
    // to the hub-seeded local workspace (#1287 item 1).
    const created = buildTopicRoomCreateInput({
      draft: { ...TOPIC_ROOM_DRAFT_EMPTY, title: 'first chat' },
      workspaceId: useUiStore.getState().activeWorkspaceId,
      defaultProviderId: 'claude',
      taskRef: undefined,
    });
    expect(created.workspaceId).toBe(emptyLaneId);
    expect(created.workspaceId).not.toBe(LOCAL_WORKSPACE_ID);
  });

  // #1287: these wire the REAL `openTopicTaskRoom` instead of a `vi.fn()` spy.
  // The existing cases stub out the exact function that was broken, which is
  // why CI stayed green while both new-chat buttons were dead in production.
  it('clears an open channel so both new-chat buttons actually reach the composer (#1287)', async () => {
    for (const selector of [
      '.topic-shell__create',
      `${emptyLaneSelector} [data-workspace-start-chat="${emptyLaneId}"]`,
    ]) {
      useUiStore.setState({
        activeChannelId: 'topic:a',
        topicComposerOpen: false,
      });
      await renderWithEmptyLane({ onCreateTaskRoom: openTopicTaskRoom });

      const button = container.querySelector<HTMLButtonElement>(selector);
      expect(button, selector).not.toBeNull();
      await act(async () => button?.click());

      // Without the clear the composer never mounts: an open channel outranks
      // `topicComposerOpen` in `resolveAppViewMode` AND in `ChatHome`, so the
      // click was a silent no-op that issued no request at all.
      expect(useUiStore.getState().activeChannelId, selector).toBeNull();
      expect(useUiStore.getState().topicComposerOpen, selector).toBe(true);
    }
  });

  // #1287: `activeWorkspaceId` and `activeRepoPath` are two halves of ONE
  // routing decision — the first files the channel, the second becomes its
  // `routingDefaults.repoPath`/`cwd`. Moving only the lane pointer files the
  // chat in the NEW project while still routing it at the ABANDONED project's
  // repo, a split across two projects that is strictly worse than the
  // consistent-but-stale state it replaced. Both new-chat entry points are
  // driven here because they now share one body.
  it('routes a new chat at the freshly selected lane AND that lane’s repo (#1287)', async () => {
    for (const entry of [
      {
        label: 'rail header',
        selectLane: true,
        selector: '.topic-shell__create',
      },
      {
        label: 'empty-lane button',
        selectLane: false,
        selector: `${emptyLaneSelector} [data-workspace-start-chat="${emptyLaneId}"]`,
      },
    ]) {
      // The operator's state mid-#1287: `selectedId` defaults to the first
      // channel, which lives in `ws:a` — the OLD workspace — and that
      // project's repo is the active one.
      useUiStore.setState({
        activeWorkspaceId: null,
        activeRepoPath: OLD_LANE_REPO,
      });
      await renderWithEmptyLane({ onCreateTaskRoom: vi.fn() });

      if (entry.selectLane) {
        const laneHeader = container.querySelector<HTMLButtonElement>(
          `${emptyLaneSelector} .topic-workspace-group__select`
        );
        await act(async () => laneHeader?.click());
        expect(useUiStore.getState().activeWorkspaceId, entry.label).toBe(
          emptyLaneId
        );
        // A bare lane click must NOT move the repo pointer: `activeRepoPath`
        // sits directly above the chat landing in `resolveAppViewMode`, so
        // stamping it outside a create would turn selecting a lane into a
        // navigation onto RepoDashboard.
        expect(useUiStore.getState().activeRepoPath, entry.label).toBe(
          OLD_LANE_REPO
        );
      }

      const button = container.querySelector<HTMLButtonElement>(entry.selector);
      expect(button, entry.label).not.toBeNull();
      await act(async () => button?.click());

      const ui = useUiStore.getState();
      expect(ui.activeWorkspaceId, entry.label).toBe(emptyLaneId);
      expect(ui.activeRepoPath, entry.label).toBe(FRESH_LANE_REPO);

      const created = buildTopicRoomCreateInput({
        draft: { ...TOPIC_ROOM_DRAFT_EMPTY, title: 'first chat' },
        workspaceId: ui.activeWorkspaceId,
        defaultProviderId: 'claude',
        // Exactly how `useTopicRoomCreate` derives it with no active session:
        // `activeSession?.repoPath ?? activeRepoPath ?? repos[0]?.path`.
        defaultRepoPath: ui.activeRepoPath ?? undefined,
        taskRef: undefined,
      });
      expect(created.workspaceId, entry.label).toBe(emptyLaneId);
      expect(created.routingDefaults?.repoPath, entry.label).toBe(
        FRESH_LANE_REPO
      );
      expect(created.routingDefaults?.repoPath, entry.label).not.toBe(
        OLD_LANE_REPO
      );
    }
  });

  it('selects the workspace when its mobile lane header is tapped (#1287)', async () => {
    await renderWithEmptyLane({ onCreateTaskRoom: vi.fn() });

    const mobileHeader = container.querySelector<HTMLButtonElement>(
      `.topic-mobile-group[data-workspace-id="${emptyLaneId}"] .topic-mobile-group__header`
    );
    await act(async () => mobileHeader?.click());

    expect(useUiStore.getState().activeWorkspaceId).toBe(emptyLaneId);
  });

  it('keeps mobile workspace headers natural-case without uppercase styling', () => {
    const css = fs.readFileSync(
      'frontend/src/components/TopicSidebarShell.css',
      'utf8'
    );
    const headerBlock = css.match(
      /\.topic-mobile-group__header\s*{[\s\S]*?\n\s*}/
    )?.[0];

    expect(headerBlock).toBeTruthy();
    expect(headerBlock).not.toMatch(/text-transform\s*:\s*uppercase/i);
    expect(headerBlock).not.toMatch(/letter-spacing\s*:/i);
  });

  it('resumes the most recent session in one tap from the mobile cockpit (#1088)', async () => {
    await renderView({
      topics: [
        makeTopic({
          id: 'topic:a',
          workspaceId: 'ws:a',
          display: { title: 'Alpha channel' },
          linkedRefs: { sessionIds: ['s-old', 's-new'] },
        }),
      ],
      sessions: [
        makeSession({
          id: 's-old',
          displayName: 'older',
          lastActivity: '2026-06-01T00:00:00Z',
        }),
        makeSession({
          id: 's-new',
          displayName: 'newer',
          lastActivity: '2026-06-25T00:00:00Z',
        }),
      ],
      surfaces: [],
    });
    const resume = container.querySelector(
      '.topic-mobile-cockpit__resume'
    ) as HTMLButtonElement;
    expect(resume).not.toBeNull();
    expect(resume.disabled).toBe(false);
    await act(async () => resume.click());
    expect(onSelectSession).toHaveBeenCalledTimes(1);
    const key = onSelectSession.mock.calls[0][0] as string;
    expect(key).toContain('s-new');
  });

  it('disables mobile resume-last when no session has activity yet (#1088)', async () => {
    await renderView({
      topics: [makeTopic({ id: 'topic:a', linkedRefs: {} })],
      sessions: [],
      surfaces: [],
    });
    const resume = container.querySelector(
      '.topic-mobile-cockpit__resume'
    ) as HTMLButtonElement;
    expect(resume).not.toBeNull();
    expect(resume.disabled).toBe(true);
  });

  it('opens a persisted channel timeline when tapping its mobile row (#1205)', async () => {
    useUiStore.setState({ sidebarOpen: true });
    await renderView({
      topics: [
        makeTopic({
          id: 'topic:a',
          workspaceId: 'ws:a',
          routingDefaults: { repoPath: '/repo/mobile-detail' },
          display: { title: 'Mobile resume target' },
          linkedRefs: { sessionIds: ['s-old', 's-new'] },
        }),
      ],
      sessions: [
        makeSession({
          id: 's-old',
          displayName: 'older',
          lastActivity: '2026-06-01T00:00:00Z',
        }),
        makeSession({
          id: 's-new',
          displayName: 'newer',
          lastActivity: '2026-06-25T00:00:00Z',
        }),
      ],
      surfaces: [],
    });

    const row = container.querySelector(
      '.topic-mobile-row'
    ) as HTMLButtonElement;
    expect(row).not.toBeNull();
    await act(async () => row.click());

    expect(onSelectSession).not.toHaveBeenCalled();
    expect(useUiStore.getState().activeChannelId).toBe('topic:a');
    expect(useUiStore.getState().activeRepoPath).toBe('/repo/mobile-detail');
    expect(useUiStore.getState().sidebarOpen).toBe(false);
  });

  it('collapses and expands a mobile workspace group (#1205)', async () => {
    await renderView({
      topics: [
        makeTopic({
          id: 'topic:a',
          workspaceId: 'ws:a',
          display: { title: 'Alpha channel' },
          linkedRefs: {},
        }),
      ],
      sessions: [],
      surfaces: [],
      workspaces: [
        {
          id: 'ws:a',
          name: 'engineering',
          order: 0,
          pinned: false,
          color: null,
          icon: null,
        },
      ],
    });

    const group = container.querySelector(
      '.topic-mobile-group[data-workspace-id="ws:a"]'
    ) as HTMLElement;
    const header = group.querySelector(
      '.topic-mobile-group__header'
    ) as HTMLButtonElement;
    expect(header.getAttribute('aria-expanded')).toBe('true');
    expect(group.querySelector('[data-topic-id="topic:a"]')).not.toBeNull();

    await act(async () => header.click());
    expect(header.getAttribute('aria-expanded')).toBe('false');
    expect(group.querySelector('[data-topic-id="topic:a"]')).toBeNull();

    await act(async () => header.click());
    expect(header.getAttribute('aria-expanded')).toBe('true');
    expect(group.querySelector('[data-topic-id="topic:a"]')).not.toBeNull();
  });

  describe('rail fold persistence (#1287 slice 5)', () => {
    const RAIL_TOPIC = makeTopic({
      id: 'topic:alpha',
      workspaceId: 'ws:a',
      display: { title: 'Alpha channel' },
      linkedRefs: { sessionIds: ['s1'] },
    });
    const RAIL_WORKSPACE = {
      id: 'ws:a',
      name: 'engineering',
      order: 0,
      pinned: false,
      color: null,
      icon: null,
    };

    function railRow(topicId: string): HTMLButtonElement {
      // `.topic-node` is the desktop rail row; the mobile cockpit renders the
      // same channel as `.topic-mobile-node`.
      const button = container.querySelector(
        `.topic-node[data-topic-id="${topicId}"] > .topic-row > .topic-row__main`
      );
      expect(button).not.toBeNull();
      return button as HTMLButtonElement;
    }

    async function remount() {
      await act(async () => root.unmount());
      root = createRoot(container);
    }

    // #1287 slice 5 item 17: the desktop lane header. Two controls, not one:
    // the name selects the lane (the rail's create target) and the trailing
    // −/+ folds it, so selecting a workspace never hides its channels.
    function desktopLaneHeader(workspaceId = 'ws:a'): HTMLElement {
      const header = container.querySelector(
        `.topic-workspace-group[data-workspace-id="${workspaceId}"] .topic-workspace-group__header--split`
      );
      expect(header).not.toBeNull();
      return header as HTMLElement;
    }

    function desktopLaneFold(workspaceId = 'ws:a'): HTMLButtonElement {
      const toggle = desktopLaneHeader(workspaceId).querySelector(
        '.topic-workspace-group__toggle'
      );
      expect(toggle).not.toBeNull();
      return toggle as HTMLButtonElement;
    }

    function desktopLaneSelect(workspaceId = 'ws:a'): HTMLButtonElement {
      const select = desktopLaneHeader(workspaceId).querySelector(
        '.topic-workspace-group__select'
      );
      expect(select).not.toBeNull();
      return select as HTMLButtonElement;
    }

    function desktopLaneRow(topicId: string, workspaceId = 'ws:a') {
      return container.querySelector(
        `.topic-workspace-group[data-workspace-id="${workspaceId}"] [data-topic-id="${topicId}"]`
      );
    }

    async function renderRailLane() {
      await renderView({
        topics: [RAIL_TOPIC],
        sessions: [],
        surfaces: [],
        workspaces: [RAIL_WORKSPACE],
      });
    }

    it('collapses and expands a desktop workspace lane from its header', async () => {
      // Desktop rendered this lane as a select-only header, so the whole
      // breakpoint had no way to fold a workspace at all.
      await renderRailLane();

      expect(desktopLaneFold().getAttribute('aria-expanded')).toBe('true');
      expect(desktopLaneFold().textContent).toContain('−');
      expect(desktopLaneFold().getAttribute('aria-label')).toBe(
        'collapse engineering'
      );
      expect(desktopLaneRow('topic:alpha')).not.toBeNull();

      await act(async () => desktopLaneFold().click());
      expect(desktopLaneFold().getAttribute('aria-expanded')).toBe('false');
      expect(desktopLaneFold().textContent).toContain('+');
      expect(desktopLaneRow('topic:alpha')).toBeNull();

      await act(async () => desktopLaneFold().click());
      expect(desktopLaneFold().getAttribute('aria-expanded')).toBe('true');
      expect(desktopLaneRow('topic:alpha')).not.toBeNull();
    });

    it('keeps desktop lane select and fold as separate gestures', async () => {
      // Selecting a lane is how the rail picks the create target for
      // `new chat`. Binding select and fold to one click made the desktop
      // operator collapse the very lane they had just aimed at — two clicks to
      // select a lane and still see its channels. Mobile keeps the combined tap
      // because a tap is the only lane-scale gesture a phone has.
      await renderRailLane();

      await act(async () => desktopLaneSelect().click());
      expect(useUiStore.getState().activeWorkspaceId).toBe('ws:a');
      expect(desktopLaneFold().getAttribute('aria-expanded')).toBe('true');
      expect(desktopLaneRow('topic:alpha')).not.toBeNull();

      // Folding is still available, and it does not disturb the selection.
      await act(async () => desktopLaneFold().click());
      expect(desktopLaneRow('topic:alpha')).toBeNull();
      expect(useUiStore.getState().activeWorkspaceId).toBe('ws:a');

      // Mobile keeps one combined lane-scale tap.
      const mobileHeader = container.querySelector(
        '.topic-mobile-group[data-workspace-id="ws:a"] .topic-mobile-group__header'
      ) as HTMLButtonElement;
      await act(async () => mobileHeader.click());
      expect(mobileHeader.getAttribute('aria-expanded')).toBe('true');
      expect(useUiStore.getState().activeWorkspaceId).toBe('ws:a');
    });

    it('rolls unread up onto a collapsed desktop lane header only while folded', async () => {
      // `selectChannelRailTree` already computed `group.unread` for both
      // breakpoints; desktop discarded it, so folding would have hidden the
      // one signal that a channel needs attention.
      await renderRailLane();
      const rollupDot = () =>
        desktopLaneHeader().querySelector(
          '[role="img"][aria-label="unread activity"]'
        );

      await act(async () => desktopLaneFold().click());
      expect(rollupDot()).toBeNull();

      await act(async () => {
        useChannelActivityStore.getState().recordActivity('topic:alpha', 2);
      });
      expect(rollupDot()).not.toBeNull();

      await act(async () => desktopLaneFold().click());
      // Expanded, the unread lives on the row itself — never doubled onto the
      // header.
      expect(rollupDot()).toBeNull();
      expect(desktopLaneRow('topic:alpha')?.getAttribute('data-unread')).toBe(
        'true'
      );
    });

    it('folds a lane once for both breakpoints and persists the decision', async () => {
      await renderRailLane();
      const mobileHeader = () =>
        container.querySelector(
          '.topic-mobile-group[data-workspace-id="ws:a"] .topic-mobile-group__header'
        ) as HTMLButtonElement;

      await act(async () => desktopLaneFold().click());

      // One operator decision per workspace, not one per breakpoint.
      expect(mobileHeader().getAttribute('aria-expanded')).toBe('false');
      expect(
        JSON.parse(localStorage.getItem(COLLAPSED_TOPIC_GROUPS_KEY) ?? '[]')
      ).toEqual(['ws:a']);

      await remount();
      await renderRailLane();

      expect(desktopLaneFold().getAttribute('aria-expanded')).toBe('false');
      expect(desktopLaneRow('topic:alpha')).toBeNull();
    });

    it('keeps a collapsed root collapsed through nav-model identity churn', async () => {
      // The removed effect re-added every `model.rootIds` entry to the local
      // expanded set whenever the model changed identity, and the sessions
      // store rebuilds its array via `.map()` on every activity/status/branch/
      // rename WS event — so a collapsed root sprang open mid-session.
      const sessions = [
        makeSession({ id: 's1', displayName: 'Frontend lane' }),
      ];
      await renderView({
        topics: [RAIL_TOPIC],
        sessions,
        surfaces: [],
        workspaces: [RAIL_WORKSPACE],
      });

      expect(railRow('topic:alpha').getAttribute('aria-expanded')).toBe('true');
      await act(async () => railRow('topic:alpha').click());
      expect(railRow('topic:alpha').getAttribute('aria-expanded')).toBe(
        'false'
      );

      for (let churn = 0; churn < 3; churn++) {
        await renderView({
          topics: [RAIL_TOPIC],
          // Same content, brand-new array + object identities: exactly what a
          // WS activity event hands the rail.
          sessions: sessions.map((session) => ({ ...session })),
          surfaces: [],
          workspaces: [RAIL_WORKSPACE],
        });
        expect(railRow('topic:alpha').getAttribute('aria-expanded')).toBe(
          'false'
        );
      }
      expect(
        container.querySelector('.topic-node.expanded[data-topic-id]')
      ).toBeNull();
    });

    // Boot-time rehydration from these keys is covered in
    // test/stores/ui-store.test.ts (a reload is a fresh module graph).
    it('survives a remount and writes the fold to localStorage', async () => {
      const sessions = [
        makeSession({ id: 's1', displayName: 'Frontend lane' }),
      ];
      await renderView({
        topics: [RAIL_TOPIC],
        sessions,
        surfaces: [],
        workspaces: [RAIL_WORKSPACE],
      });
      await act(async () => railRow('topic:alpha').click());

      expect(
        JSON.parse(localStorage.getItem(TOPIC_RAIL_EXPANSION_KEY) ?? '{}')
      ).toEqual({ 'topic:alpha': false });

      await remount();
      await renderView({
        topics: [RAIL_TOPIC],
        sessions,
        surfaces: [],
        workspaces: [RAIL_WORKSPACE],
      });

      expect(railRow('topic:alpha').getAttribute('aria-expanded')).toBe(
        'false'
      );
    });

    it('still auto-expands a root the operator has never folded', async () => {
      const sessions = [
        makeSession({ id: 's1', displayName: 'Frontend lane' }),
      ];
      await renderView({
        topics: [RAIL_TOPIC],
        sessions,
        surfaces: [],
        workspaces: [RAIL_WORKSPACE],
      });
      await act(async () => railRow('topic:alpha').click());
      expect(railRow('topic:alpha').getAttribute('aria-expanded')).toBe(
        'false'
      );

      const newcomer = makeTopic({
        id: 'topic:beta',
        workspaceId: 'ws:a',
        display: { title: 'Beta channel' },
        linkedRefs: { sessionIds: ['s2'] },
      });
      await renderView({
        topics: [RAIL_TOPIC, newcomer],
        sessions: [
          ...sessions,
          makeSession({ id: 's2', displayName: 'Beta lane' }),
        ],
        surfaces: [],
        workspaces: [RAIL_WORKSPACE],
      });

      // A root nobody has decided about opens on arrival; the folded one does
      // not come back with it.
      expect(railRow('topic:beta').getAttribute('aria-expanded')).toBe('true');
      expect(railRow('topic:alpha').getAttribute('aria-expanded')).toBe(
        'false'
      );
    });

    it('persists a folded mobile workspace group across a remount', async () => {
      await renderView({
        topics: [RAIL_TOPIC],
        sessions: [],
        surfaces: [],
        workspaces: [RAIL_WORKSPACE],
      });
      const header = () =>
        container.querySelector(
          '.topic-mobile-group[data-workspace-id="ws:a"] .topic-mobile-group__header'
        ) as HTMLButtonElement;

      await act(async () => header().click());
      expect(header().getAttribute('aria-expanded')).toBe('false');
      expect(
        JSON.parse(localStorage.getItem(COLLAPSED_TOPIC_GROUPS_KEY) ?? '[]')
      ).toEqual(['ws:a']);

      await remount();
      await renderView({
        topics: [RAIL_TOPIC],
        sessions: [],
        surfaces: [],
        workspaces: [RAIL_WORKSPACE],
      });

      expect(header().getAttribute('aria-expanded')).toBe('false');
      expect(
        container.querySelector(
          '.topic-mobile-group[data-workspace-id="ws:a"] [data-topic-id="topic:alpha"]'
        )
      ).toBeNull();
    });
  });

  it('shows reactive unread state on a collapsed mobile workspace header (#1205)', async () => {
    await renderView({
      topics: [
        makeTopic({
          id: 'topic:a',
          workspaceId: 'ws:a',
          display: { title: 'Alpha channel' },
          linkedRefs: {},
        }),
      ],
      sessions: [],
      surfaces: [],
      workspaces: [
        {
          id: 'ws:a',
          name: 'engineering',
          order: 0,
          pinned: false,
          color: null,
          icon: null,
        },
      ],
    });

    const header = container.querySelector(
      '.topic-mobile-group__header'
    ) as HTMLButtonElement;
    await act(async () => header.click());
    expect(header.querySelector('[aria-label="unread activity"]')).toBeNull();

    await act(async () => {
      useChannelActivityStore.getState().recordActivity('topic:a', 2);
    });
    expect(
      header.querySelector('[aria-label="unread activity"]')
    ).not.toBeNull();
  });

  it('suppresses the no-workspace header consistently for a sole orphan lane', async () => {
    await renderView({ workspaces: [] });

    const desktopOrphan = container.querySelector(
      '.topic-workspace-group--orphan'
    ) as HTMLElement;
    const mobileOrphan = container.querySelector(
      '.topic-mobile-group--orphan'
    ) as HTMLElement;
    expect(desktopOrphan).not.toBeNull();
    expect(mobileOrphan).not.toBeNull();
    expect(
      desktopOrphan.querySelector('.topic-workspace-group__header')
    ).toBeNull();
    expect(
      mobileOrphan.querySelector('.topic-mobile-group__header')
    ).toBeNull();
  });

  it('hides the mobile detail/control chrome for resumable chat rows (#1122)', async () => {
    await renderView();

    expect(container.querySelector('.topic-mobile-detail')).toBeNull();
    expect(container.querySelector('.topic-shell__advanced-detail')).toBeNull();
    expect(container.querySelector('.topic-room')).toBeNull();
    expect(container.textContent).not.toContain('resume topic');
    expect(container.textContent).not.toContain('open terminal tab');
  });

  it('opens an actionable mobile control panel only after its row is tapped in default mode', async () => {
    useUiStore.setState({ sidebarOpen: true });
    const props: Partial<React.ComponentProps<typeof TopicSidebarView>> = {
      sessions: [
        makeSession({
          id: 's1',
          displayName: 'Frontend lane',
          activityState: 'permission-prompt',
          permissionType: 'approval',
          mode: 'pty',
        }),
      ],
      surfaces: [],
    };

    await renderView(props, { advancedMode: false });
    expect(container.querySelector('.topic-mobile-detail')).toBeNull();

    const row = container.querySelector(
      '.topic-mobile-row'
    ) as HTMLButtonElement;
    expect(row.textContent).toContain('approve');
    await act(async () => row.click());

    expect(container.querySelector('.topic-mobile-detail')).not.toBeNull();
    expect(useUiStore.getState().sidebarOpen).toBe(true);
    expect(container.textContent).toContain('approve');
    expect(container.querySelector('.topic-mobile-control')).not.toBeNull();
    expect(
      container.querySelectorAll('.topic-mobile-control__preset')
    ).toHaveLength(2);
    const submit = container.querySelector(
      '.topic-mobile-control__primary'
    ) as HTMLButtonElement;
    expect(submit.title).toBe('review and send approve');
    expect(submit.title).not.toMatch(/audited|live session|terminal|control/i);
    expect(container.querySelector('.topic-mobile-detail__latest')).toBeNull();
    expect(container.querySelector('.topic-mobile-detail__meta')).toBeNull();
    expect(
      container.querySelector('.topic-mobile-detail__description')
    ).toBeNull();
    expect(container.querySelector('.topic-mobile-actions')).toBeNull();
    expect(container.textContent).not.toContain('carriage return appended');
    expect(container.textContent).not.toContain('audited control input');
    expect(container.textContent).not.toContain(
      'audit/intervention trail preserved'
    );
    expect(useUiStore.getState().advancedMode).toBe(false);
  });

  it('resets default mobile input and preview when one session changes from approve to reply', async () => {
    const onSendInput = vi.fn().mockResolvedValue({ ok: true });
    const renderAction = async (
      activityState: 'permission-prompt' | 'waiting-for-input'
    ) => {
      await renderView(
        {
          sessions: [
            makeSession({
              id: 's1',
              displayName: 'Frontend lane',
              activityState,
              ...(activityState === 'permission-prompt'
                ? { permissionType: 'approval' as const }
                : {}),
              mode: 'pty',
            }),
          ],
          surfaces: [],
          onSendInput,
        },
        { advancedMode: false }
      );
    };

    await renderAction('permission-prompt');
    const row = container.querySelector(
      '.topic-mobile-row'
    ) as HTMLButtonElement;
    await act(async () => row.click());
    const approve = Array.from(
      container.querySelectorAll<HTMLButtonElement>(
        '.topic-mobile-control__preset'
      )
    ).find((button) => button.textContent === 'approve')!;
    await act(async () => approve.click());
    const approvalForm = container.querySelector(
      '.topic-mobile-control'
    ) as HTMLFormElement;
    await act(async () => approvalForm.requestSubmit());
    expect(container.querySelector('.topic-mobile-confirm')).not.toBeNull();
    expect(container.textContent).toContain('review before sending');

    await renderAction('waiting-for-input');
    const replyInput = container.querySelector(
      '.topic-mobile-control input'
    ) as HTMLInputElement;
    expect(replyInput.value).toBe('');
    expect(container.querySelector('.topic-mobile-confirm')).toBeNull();
    expect(container.textContent).not.toContain('approve selected');
    expect(onSendInput).not.toHaveBeenCalled();

    await act(async () => {
      replyInput.value = 'ready';
      replyInput.dispatchEvent(
        new InputEvent('input', {
          bubbles: true,
          data: 'ready',
          inputType: 'insertText',
        })
      );
      replyInput.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const replyForm = container.querySelector(
      '.topic-mobile-control'
    ) as HTMLFormElement;
    await act(async () => replyForm.requestSubmit());
    expect(container.textContent).toContain('review before sending');
    await act(async () => replyForm.requestSubmit());
    expect(onSendInput).toHaveBeenCalledWith('s1', 'ready\r', undefined);
    expect(container.textContent).toContain('sent');
    expect(container.textContent).not.toContain('carriage return appended');
    expect(container.textContent).not.toContain('audited control input');
    expect(container.textContent).not.toContain(
      'audit/intervention trail preserved'
    );
  });

  it('shows a search scope toggle only when a workspace is active', async () => {
    const onToggleSearchScope = vi.fn();
    await renderView({ activeWorkspaceId: 'ws:a', onToggleSearchScope });
    const chip = container.querySelector('.topic-search__scope');
    expect(chip).not.toBeNull();
    expect(chip?.textContent).toBe('all');
    await act(async () => (chip as HTMLButtonElement).click());
    expect(onToggleSearchScope).toHaveBeenCalled();

    await renderView({ activeWorkspaceId: null });
    expect(container.querySelector('.topic-search__scope')).toBeNull();
  });

  it('reflects the workspace scope on the toggle label', async () => {
    await renderView({ activeWorkspaceId: 'ws:a', searchScope: 'workspace' });
    const chip = container.querySelector('.topic-search__scope');
    expect(chip?.textContent).toBe('this workspace');
    expect(chip?.getAttribute('aria-pressed')).toBe('true');
  });

  it('toggles the show-archived control', async () => {
    const onToggleArchived = vi.fn();
    await renderView({ onToggleArchived });
    const btn = container.querySelector(
      '.topic-archived-toggle__btn'
    ) as HTMLButtonElement;
    expect(btn).not.toBeNull();
    expect(btn.textContent).toBe('show older chats');
    await act(async () => btn.click());
    expect(onToggleArchived).toHaveBeenCalled();
  });

  // #1287: the sidebar no longer owns a restore affordance. Its only one lived
  // in the advanced-mode detail panel and invalidated a different key set than
  // the in-channel bar, so archived rows went stale on whichever surface did not
  // run the restore. Opening the archived row shows the ungated composer restore
  // bar at every breakpoint, and that bar drives the one shared mutation.
  it('renders an archived topic without a sidebar restore button', async () => {
    await renderView({
      showAdvancedDetail: true,
      topics: [
        makeTopic({
          id: 'topic:old',
          workspaceId: 'ws:a',
          status: 'archived',
          display: { title: 'Archived lane' },
          linkedRefs: {},
        }),
      ],
      sessions: [],
      surfaces: [],
    });
    expect(container.querySelector('.topic-row.archived')).not.toBeNull();
    expect(container.querySelector('.topic-detail')).not.toBeNull();
    expect(container.querySelector('.topic-detail__restore')).toBeNull();
    expect(
      [...container.querySelectorAll('button')].some((btn) =>
        (btn.textContent ?? '').includes('restore')
      )
    ).toBe(false);
  });

  it('selects linked sessions using the existing sidebar callback', async () => {
    await renderView();
    const sessionButton = container.querySelector(
      '.topic-child-row__button'
    ) as HTMLButtonElement;
    await act(async () => sessionButton.click());
    expect(onSelectSession).toHaveBeenCalledWith('s1');
  });

  it('labels open-session affordances with a friendly name, not the raw select key', async () => {
    await renderView();
    const tips = Array.from(container.querySelectorAll('[title]'))
      .map((el) => el.getAttribute('title') ?? '')
      .filter((title) => title.startsWith('open'));
    expect(tips.length).toBeGreaterThan(0);
    expect(
      tips.some((title) => title === 'open existing session Frontend lane')
    ).toBe(true);
    // The internal scoped select key must not leak into any tooltip.
    for (const title of tips) {
      expect(title).not.toMatch(/::|worktree:|node:/);
    }
  });

  it('resolves the topic detail meta strip to the workspace name, never the raw workspace id (#1061)', async () => {
    const workspaceId = 'ws:3fa85f64-5717-4562-b3fc-2c963f66afa6';
    await renderView({
      topics: [
        makeTopic({
          workspaceId,
          display: { title: 'Ugly workspace id topic' },
          linkedRefs: {},
        }),
      ],
      sessions: [],
      surfaces: [],
      workspaces: [
        {
          id: workspaceId,
          name: 'Platform Guild',
          order: 0,
          pinned: false,
          color: null,
          icon: null,
        },
      ],
    });

    expect(container.textContent).toContain('Platform Guild');
    expect(container.textContent).not.toContain(workspaceId);
  });

  it('omits the workspace meta span entirely when the workspace name is unresolved, never falling back to the raw id (#1061)', async () => {
    const workspaceId = 'ws:9c858901-8a57-4791-81fe-4c455b099bc9';
    await renderView({
      topics: [
        makeTopic({
          workspaceId,
          display: { title: 'Unmapped workspace topic' },
          linkedRefs: {},
        }),
      ],
      sessions: [],
      surfaces: [],
      workspaces: [],
    });

    expect(container.textContent).not.toContain(workspaceId);
  });

  it('never renders raw routing node ids in participant/session/mobile-control meta; resolves via the node roster when known (#1061)', async () => {
    const knownNodeId = 'node_7Kx9QoZmP3vL1nRt5sWyAeBcDfGhIjKl';
    const unknownNodeId = 'node_Zz01Xy23Wv45Ut67Sr89Qp01On23Ml45';
    await renderView({
      showAdvancedDetail: true,
      topics: [
        makeTopic({
          linkedRefs: {
            sessionIds: [
              `${knownNodeId}:known-node-session`,
              `${unknownNodeId}:unknown-node-session`,
            ],
          },
        }),
      ],
      sessions: [
        makeSession({
          id: 'known-node-session',
          nodeId: knownNodeId,
          displayName: 'Known node lane',
        }),
        makeSession({
          id: 'unknown-node-session',
          nodeId: unknownNodeId,
          displayName: 'Unknown node lane',
        }),
      ],
      surfaces: [],
      nodes: [{ nodeId: knownNodeId, displayName: 'Ops Box' }],
    });

    expect(container.textContent).toContain('Ops Box');
    expect(container.textContent).not.toContain(knownNodeId);
    expect(container.textContent).not.toContain(unknownNodeId);

    const childRows = Array.from(
      container.querySelectorAll('.topic-child-row')
    );
    for (const row of childRows) {
      expect(row.textContent).not.toContain('Ops Box');
      expect(row.textContent).not.toContain(knownNodeId);
      expect(row.textContent).not.toContain(unknownNodeId);
    }
  });

  it('establishes the topic node/repo context when a topic is selected', async () => {
    await renderView({
      topics: [
        makeTopic({
          id: 'topic:ctx',
          workspaceId: 'workspace:ctx',
          routingDefaults: { nodeId: 'devbox', repoPath: '/repo/ctx' },
        }),
      ],
      sessions: [],
      surfaces: [],
    });
    // Auto-selection on mount must not clobber the active repo.
    expect(useUiStore.getState().activeRepoPath).toBeNull();

    const row = container.querySelector('.topic-row__main') as HTMLElement;
    await act(async () => row.click());

    expect(useUiStore.getState().activeRepoPath).toBe('/repo/ctx');
    expect(useUiStore.getState().activeWorkspaceId).toBe('workspace:ctx');
  });

  it('keeps the active repo for a thread topic but still sets the workspace', async () => {
    useUiStore.getState().setActiveRepoPath('/repo/keep');
    await renderView({
      topics: [
        makeTopic({
          id: 'topic:thread',
          workspaceId: 'workspace:thread',
          routingDefaults: {},
          linkedRefs: {},
        }),
      ],
      sessions: [],
      surfaces: [],
    });
    const row = container.querySelector('.topic-row__main') as HTMLElement;
    await act(async () => row.click());

    expect(useUiStore.getState().activeRepoPath).toBe('/repo/keep');
    expect(useUiStore.getState().activeWorkspaceId).toBe('workspace:thread');
  });

  it('resolveTopicActiveContext prefers repo, then worktree, else null', () => {
    expect(
      resolveTopicActiveContext(
        makeTopic({
          workspaceId: 'w',
          routingDefaults: { repoPath: '/r', worktreePath: '/wt' },
        })
      )
    ).toEqual({ workspaceId: 'w', repoPath: '/r' });
    expect(
      resolveTopicActiveContext(
        makeTopic({
          workspaceId: 'w',
          routingDefaults: { worktreePath: '/wt' },
        })
      )
    ).toEqual({ workspaceId: 'w', repoPath: '/wt' });
    expect(
      resolveTopicActiveContext(
        makeTopic({ workspaceId: 'w', routingDefaults: { cwd: '/c' } })
      )
    ).toEqual({ workspaceId: 'w', repoPath: null });
  });

  it('renders kind-icon badges without numeric ordering text', async () => {
    await renderView({
      topics: [
        makeTopic({ id: 'topic:repo', grouping: { order: 3 } }),
        makeTopic({
          id: 'topic:folder',
          workspaceId: 'workspace:folder',
          grouping: { order: 2 },
          routingDefaults: { cwd: '/tmp/scratch' },
        }),
        makeTopic({
          id: 'topic:thread',
          workspaceId: 'workspace:thread',
          grouping: { order: 1 },
          routingDefaults: {},
          linkedRefs: {},
        }),
      ],
      sessions: [],
      surfaces: [],
    });

    const badges = Array.from(
      container.querySelectorAll('.topic-tree .topic-row__badge')
    );
    expect(badges.map((badge) => badge.getAttribute('data-kind'))).toEqual([
      'thread',
      'folder',
      'repo',
    ]);
    for (const badge of badges) {
      expect(badge.querySelector('svg')).not.toBeNull();
      expect(badge.textContent).toBe('');
    }
  });

  it('keeps surface actions out of collapsed topic rows', async () => {
    await renderView();

    const rowMain = container.querySelector('.topic-row__main');
    const surfaceAction = container.querySelector(
      '.topic-row__trail .topic-action'
    );

    expect(rowMain).not.toBeNull();
    expect(surfaceAction).toBeNull();
  });

  it('shows detail for a selected topic even when it has no nested sessions', async () => {
    await renderView({
      showAdvancedDetail: true,
      topics: [
        makeTopic({
          linkedRefs: {
            taskRefs: [
              { kind: 'github-issue', id: '1023', title: 'thin sidebar' },
            ],
          },
        }),
      ],
      sessions: [],
    });

    expect(container.querySelector('.topic-detail')?.textContent).toContain(
      'Thin-line topic detail'
    );
    expect(container.textContent).toContain('1 task refs');
    expect(container.textContent).toContain('no sessions linked yet');
    const primary = container.querySelector(
      '.topic-room__primary'
    ) as HTMLButtonElement;
    expect(primary.textContent).toBe('view artifact');
    expect(primary.disabled).toBe(false);
  });

  it('renders a task-room panel with grouped sessions, refs, and safe artifacts', async () => {
    await renderView({
      showAdvancedDetail: true,
      topics: [
        makeTopic({
          linkedRefs: {
            sessionIds: [
              'question-session',
              'approval-session',
              'running-session',
              'idle-session',
              'stale-session',
              'crashed-session',
            ],
            taskRefs: [
              {
                kind: 'github-issue',
                id: '1044',
                title: 'topic room detail',
                url: 'https://github.com/donovan-yohan/relay-ide/issues/1044',
                status: 'open',
              },
            ],
            artifactIds: ['artifact:evidence-1'],
          },
        }),
      ],
      sessions: [
        makeSession({
          id: 'question-session',
          displayName: 'question lane',
          activityState: 'permission-prompt',
          permissionType: 'question',
        }),
        makeSession({
          id: 'approval-session',
          displayName: 'approval lane',
          activityState: 'permission-prompt',
          permissionType: 'approval',
        }),
        makeSession({
          id: 'running-session',
          displayName: 'running lane',
          activityState: 'processing',
        }),
        makeSession({
          id: 'idle-session',
          displayName: 'idle lane',
          activityState: 'idle',
          idle: true,
        }),
        makeSession({
          id: 'stale-session',
          displayName: 'stale lane',
          status: 'disconnected',
        }),
        makeSession({
          id: 'crashed-session',
          displayName: 'crashed lane',
          activityState: 'error',
        }),
      ],
      surfaces: [
        makeSurface(),
        makeSurface({
          id: 'surface:copy-only',
          kind: 'logs',
          label: 'Build log',
          openMode: 'copy',
          url: undefined,
          logRef: 'artifact:build-log',
        }),
      ],
    });

    expect(container.textContent).toContain('needs input · 1');
    expect(container.textContent).toContain('approval · 1');
    expect(container.textContent).toContain('running · 1');
    expect(container.textContent).toContain('idle · 1');
    expect(container.textContent).toContain('stale/offline · 1');
    expect(container.textContent).toContain('crashed · 1');
    expect(container.textContent).toContain('topic room detail');
    expect(container.textContent).toContain('metadata ref only');
    expect(container.textContent).toContain('direct open');
    expect(container.textContent).toContain('copy only');
    expect(container.textContent).toContain(
      'raw terminal attach stays secondary'
    );
  });

  it('formats an untitled github issue task ref as #<id>, not the bare tracker id (#1061)', async () => {
    await renderView({
      showAdvancedDetail: true,
      topics: [
        makeTopic({
          linkedRefs: {
            taskRefs: [{ kind: 'github-issue', id: '9821', status: 'open' }],
          },
        }),
      ],
      sessions: [],
      surfaces: [],
    });

    const refs = container.querySelector('.topic-room-ref-list');
    expect(refs?.textContent).toContain('#9821');
  });

  it('keeps stale sessions inspectable while disabling live room controls', async () => {
    await renderView({
      showAdvancedDetail: true,
      sessions: [
        makeSession({
          id: 's1',
          displayName: 'offline approval',
          activityState: 'permission-prompt',
          permissionType: 'approval',
          status: 'disconnected',
        }),
      ],
    });

    const primary = container.querySelector(
      '.topic-room__primary'
    ) as HTMLButtonElement;
    const sessionButton = container.querySelector(
      '.topic-room-session__button'
    ) as HTMLButtonElement;

    expect(primary.textContent).toBe('approve');
    expect(primary.disabled).toBe(true);
    expect(container.textContent).toContain(
      'controls disabled: session offline/disconnected'
    );
    await act(async () => sessionButton.click());
    expect(onSelectSession).toHaveBeenCalledWith('s1');
  });

  it('keeps desktop resume enabled when only live input control state is unknown', async () => {
    await renderView({
      showAdvancedDetail: true,
      sessions: [
        makeSession({
          id: 's1',
          displayName: 'readable lane',
          activityState: 'idle',
        }),
      ],
    });

    const primary = container.querySelector(
      '.topic-room__primary'
    ) as HTMLButtonElement;

    expect(primary.textContent).toBe('resume');
    expect(primary.disabled).toBe(false);
    expect(
      primary.closest('.topic-room__action-band')?.textContent
    ).not.toContain('controls disabled: unknown control state');

    await act(async () => primary.click());
    expect(onSelectSession).toHaveBeenCalledWith('s1');
  });

  it('selects the exact global session from the task-room session row', async () => {
    await renderView({
      showAdvancedDetail: true,
      topics: [makeTopic({ linkedRefs: { sessionIds: ['global:agent-1'] } })],
      sessions: [
        makeSession({
          id: 'local-session',
          globalSessionId: 'global:agent-1',
          displayName: 'global lane',
        }),
      ],
    });

    const roomSessionButton = container.querySelector(
      '.topic-room-session__button'
    ) as HTMLButtonElement;
    // Tooltip shows the friendly label; the raw global select key stays internal.
    expect(roomSessionButton.title).toBe('open exact session global lane');
    expect(roomSessionButton.title).not.toContain('global:agent-1');
    await act(async () => roomSessionButton.click());
    expect(onSelectSession).toHaveBeenCalledWith('global:agent-1');
  });

  it('keeps the room usable when surface loading fails', async () => {
    await renderView({
      surfaces: [],
      surfacesError: true,
      showAdvancedDetail: true,
    });

    expect(container.textContent).toContain('Frontend lane');
    expect(container.textContent).toContain('surfaces unavailable');
  });

  it('keeps the room usable while surfaces are still loading', async () => {
    await renderView({
      surfaces: [],
      surfacesLoading: true,
      showAdvancedDetail: true,
    });

    expect(container.textContent).not.toContain('loading topic shell');
    expect(container.querySelector('.topic-room')).not.toBeNull();
    expect(container.textContent).toContain('Frontend lane');
    expect(container.textContent).toContain('surfaces loading…');
  });

  it('keeps the chat list mounted without advanced detail while surfaces query is still pending', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const topicsResponse: WorkspaceTopicListResponse = {
      topics: [makeTopic()],
      truncated: false,
      derived: false,
    };
    queryClient.setQueryData(['workspace-topics'], topicsResponse);
    useSessionsStore.setState({
      sessions: [makeSession({ id: 's1', displayName: 'Frontend lane' })],
    });
    const fetchMock = vi.fn(
      () => new Promise<Response>(() => {})
    ) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchMock);

    await act(async () => {
      root.render(
        React.createElement(
          QueryClientProvider,
          { client: queryClient },
          React.createElement(TopicSidebarShell, { onSelectSession })
        )
      );
      await flushQueryEffects();
    });

    expect(fetchMock).toHaveBeenCalledWith('/workspace-surfaces', {
      headers: { 'x-relay-capabilities': 'context:read' },
    });
    expect(container.textContent).not.toContain('loading topic shell');
    expect(container.querySelector('.topic-shell')).not.toBeNull();
    expect(container.querySelector('.topic-shell__advanced-detail')).toBeNull();
    expect(container.querySelector('.topic-room')).toBeNull();
    expect(container.textContent).toContain('Build UI shell');
    queryClient.clear();
  });

  it('reports loading, error, and empty states', async () => {
    await renderView({ loading: true, topics: [] });
    expect(container.textContent).toContain('loading chats');

    await renderView({ loading: false, error: true, topics: [] });
    expect(container.textContent).toContain('chat list unavailable');

    await renderView({ loading: false, error: false, topics: [] });
    expect(container.textContent).toContain('no chats yet');
  });

  it('routes the task-room creation entrypoint to the main-pane composer', async () => {
    // #1058: creation lives in the main pane (TopicComposer), not a sidebar
    // panel — the sidebar button only fires the navigation callback.
    const onCreateTaskRoom = vi.fn();
    await renderView({ onCreateTaskRoom });

    const createButton = container.querySelector(
      '.topic-shell__create'
    ) as HTMLButtonElement;
    await act(async () => createButton.click());

    expect(onCreateTaskRoom).toHaveBeenCalled();
    expect(useUiStore.getState().activeWorkspaceId).toBe('workspace:alpha');
    expect(useUiStore.getState().activeRepoPath).toBe('/repo/relay');
    expect(container.querySelector('.topic-create-panel')).toBeNull();
  });

  it('renders a phone-first attention list sorted before routine topics', async () => {
    await renderView({
      topics: [
        makeTopic({
          id: 'topic:idle',
          display: { title: 'Routine lane' },
          linkedRefs: { sessionIds: ['idle-session'] },
        }),
        makeTopic({
          id: 'topic:approval',
          display: { title: 'Approval lane' },
          linkedRefs: { sessionIds: ['approval-session'] },
        }),
      ],
      sessions: [
        makeSession({
          id: 'idle-session',
          displayName: 'idle',
          activityState: 'idle',
          idle: true,
        }),
        makeSession({
          id: 'approval-session',
          displayName: 'approval',
          activityState: 'permission-prompt',
          permissionType: 'approval',
          currentActivity: { tool: 'bash', detail: 'allow command?' },
        }),
      ],
      surfaces: [],
    });

    const mobileRows = Array.from(
      container.querySelectorAll('.topic-mobile-row')
    );
    expect(mobileRows[0]?.textContent).toContain('Approval lane');
    expect(mobileRows[0]?.textContent).toContain('approve');
    expect(mobileRows[0]?.textContent).toContain('allow command?');
    expect(mobileRows[1]?.textContent).toContain('Routine lane');
  });

  it('bounds mobile topic latest status from raw activity text', async () => {
    const longToolName = 'tool-name-'.repeat(30);
    await renderView(
      {
        topics: [
          makeTopic({
            linkedRefs: { sessionIds: ['waiting-session'] },
          }),
        ],
        sessions: [
          makeSession({
            id: 'waiting-session',
            displayName: 'waiting lane',
            activityState: 'waiting-for-input',
            currentActivity: { tool: longToolName },
          }),
        ],
        surfaces: [],
      },
      { advancedMode: true }
    );

    const mobileRowStatus = container.querySelector(
      '.topic-mobile-row__status'
    )?.textContent;
    const mobileDetailLatest = container.querySelector(
      '.topic-mobile-detail__latest'
    )?.textContent;

    expect(mobileRowStatus).toBe(`${longToolName.slice(0, 93)}...`);
    expect(mobileDetailLatest).toBe(`${longToolName.slice(0, 93)}...`);
    expect(mobileRowStatus?.length).toBeLessThanOrEqual(96);
    expect(mobileDetailLatest?.length).toBeLessThanOrEqual(96);
  });

  it('uses the bounded topic search as the only mobile search surface', async () => {
    await renderView();

    expect(container.querySelector('.topic-search__input')).not.toBeNull();
    expect(
      container.querySelector('.topic-mobile-cockpit__bar input')
    ).toBeNull();
    // #1287 slice 5 item 12: the search surface is named by the real control's
    // accessible label, not by a static span in the cockpit bar that named a
    // capability the bar did not provide.
    expect(
      container.querySelector('.topic-search')?.getAttribute('aria-label')
    ).toBe('search chat history');
  });

  describe('mobile search placement (#1287 slice 5 item 12)', () => {
    function precedes(first: Element | null, second: Element | null): boolean {
      if (!first || !second) return false;
      return Boolean(
        first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING
      );
    }

    it('renders search and older chats before the mobile chat list', async () => {
      // The cockpit and the search field are siblings in one flex column, so
      // DOM order IS the mobile reading order. Search used to trail the
      // attention lane, the session tree, and every channel row.
      await renderView({ onToggleArchived: vi.fn() });

      const search = container.querySelector('.topic-search');
      const archived = container.querySelector('.topic-archived-toggle');
      const cockpit = container.querySelector('.topic-mobile-cockpit');
      const mobileList = container.querySelector('.topic-mobile-list');

      expect(search).not.toBeNull();
      expect(archived).not.toBeNull();
      expect(mobileList).not.toBeNull();
      expect(precedes(search, cockpit)).toBe(true);
      expect(precedes(search, mobileList)).toBe(true);
      expect(precedes(archived, cockpit)).toBe(true);
      expect(precedes(archived, mobileList)).toBe(true);
      expect(precedes(search, archived)).toBe(true);
      // The attention lane and the session tree are inside the cockpit, so
      // clearing the cockpit clears everything the operator used to scroll past.
      expect(
        precedes(search, container.querySelector('.topic-cockpit__attention'))
      ).toBe(true);
    });

    it('drops the dead search label from the mobile action bar', async () => {
      await renderView();

      const bar = container.querySelector('.topic-mobile-cockpit__bar');
      expect(bar).not.toBeNull();
      expect(container.querySelector('.topic-mobile-cockpit__hint')).toBeNull();
      expect(bar?.textContent).not.toContain('search');
      // Only the real actions remain in the bar.
      expect(bar?.textContent).toContain('new');
    });

    it('keeps the desktop column order header, search, older chats, tree', async () => {
      await renderView({
        onCreateTaskRoom: vi.fn(),
        onToggleArchived: vi.fn(),
      });

      const header = container.querySelector('.topic-shell__header');
      const search = container.querySelector('.topic-search');
      const archived = container.querySelector('.topic-archived-toggle');
      const tree = container.querySelector('.topic-tree');

      expect(header).not.toBeNull();
      expect(tree).not.toBeNull();
      expect(precedes(header, search)).toBe(true);
      expect(precedes(search, archived)).toBe(true);
      expect(precedes(archived, tree)).toBe(true);
    });

    it('keeps chat-search results directly under the search field', async () => {
      const searchResults: WorkspaceTopicSearchResult[] = [
        {
          topic: makeTopic({
            id: 'topic:hit',
            display: { title: 'Search hit lane' },
          }),
          score: 90,
          freshness: 'fresh',
          matches: [
            {
              kind: 'topic',
              field: 'display.title',
              label: 'chat title',
              value: 'Search hit lane',
            },
          ],
          action: { kind: 'open-topic', topicId: 'topic:hit' },
        },
      ];

      await renderView({ searchQuery: 'hit', searchResults });

      const search = container.querySelector('.topic-search');
      const results = container.querySelector('.topic-search-results');
      const cockpit = container.querySelector('.topic-mobile-cockpit');

      expect(results).not.toBeNull();
      expect(precedes(search, results)).toBe(true);
      expect(precedes(results, cockpit)).toBe(true);
    });

    it('keeps the message section above the fold with the chats section (#1308 slice 2)', async () => {
      // The mobile "search surface" is not a second component — it is this
      // panel, ordered above the cockpit. So the new section is only above the
      // fold on a phone if it renders INSIDE the panel; a message section
      // appended after the tree would be legal on desktop and unreachable on a
      // phone without scrolling past every channel row.
      await renderView({
        searchQuery: 'sqlite',
        messageResults: [makeMessageHit()],
      });

      const search = container.querySelector('.topic-search');
      const messages = container.querySelector(
        '.topic-search-section[aria-label="message search results"]'
      );
      const cockpit = container.querySelector('.topic-mobile-cockpit');
      const mobileList = container.querySelector('.topic-mobile-list');

      expect(messages?.querySelector('.topic-message-result')).not.toBeNull();
      expect(precedes(search, messages)).toBe(true);
      expect(precedes(messages, cockpit)).toBe(true);
      expect(precedes(messages, mobileList)).toBe(true);
    });
  });

  it('uses a two-step audited mobile reply preview before sending input', async () => {
    const onSendInput = vi.fn().mockResolvedValue({ ok: true });
    await renderView(
      {
        sessions: [
          makeSession({
            id: 's1',
            displayName: 'approval',
            activityState: 'permission-prompt',
            permissionType: 'approval',
          }),
        ],
        onSendInput,
      },
      { advancedMode: true }
    );

    const input = container.querySelector(
      '.topic-mobile-control input'
    ) as HTMLInputElement;
    const form = container.querySelector(
      '.topic-mobile-control'
    ) as HTMLFormElement;

    await act(async () => {
      input.value = 'y';
      input.dispatchEvent(
        new InputEvent('input', {
          bubbles: true,
          data: 'y',
          inputType: 'insertText',
        })
      );
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await act(async () => form.requestSubmit());
    expect(onSendInput).not.toHaveBeenCalled();
    expect(container.textContent).toContain('confirmation preview');
    expect(container.textContent).toContain('carriage return appended');

    await act(async () => form.requestSubmit());
    expect(onSendInput).toHaveBeenCalledWith('s1', 'y\r', undefined);
    expect(container.textContent).toContain('sent · audit/intervention trail');
  });

  it('offers explicit approve and deny presets before audited mobile approval send', async () => {
    const onSendInput = vi.fn().mockResolvedValue({ ok: true });
    await renderView(
      {
        sessions: [
          makeSession({
            id: 's1',
            displayName: 'approval',
            activityState: 'permission-prompt',
            permissionType: 'approval',
          }),
        ],
        onSendInput,
      },
      { advancedMode: true }
    );

    const denyPreset = Array.from(
      container.querySelectorAll('.topic-mobile-control__preset')
    ).find((button) => button.textContent === 'deny') as HTMLButtonElement;
    const input = container.querySelector(
      '.topic-mobile-control input'
    ) as HTMLInputElement;
    const form = container.querySelector(
      '.topic-mobile-control'
    ) as HTMLFormElement;

    await act(async () => denyPreset.click());
    expect(input.value).toBe('n');
    expect(container.textContent).toContain(
      'deny selected · preview before sending'
    );
    await act(async () => form.requestSubmit());
    expect(onSendInput).not.toHaveBeenCalled();
    expect(container.textContent).toContain('confirmation preview');
    await act(async () => form.requestSubmit());
    expect(onSendInput).toHaveBeenCalledWith('s1', 'n\r', undefined);
  });

  it('sends audited mobile replies to the local session id when linked by global id', async () => {
    const onSendInput = vi.fn().mockResolvedValue({ ok: true });
    await renderView(
      {
        topics: [makeTopic({ linkedRefs: { sessionIds: ['global:agent-1'] } })],
        sessions: [
          makeSession({
            id: 'local-session',
            globalSessionId: 'global:agent-1',
            displayName: 'global approval',
            activityState: 'permission-prompt',
            permissionType: 'approval',
          }),
        ],
        onSendInput,
      },
      { advancedMode: true }
    );

    const input = container.querySelector(
      '.topic-mobile-control input'
    ) as HTMLInputElement;
    const form = container.querySelector(
      '.topic-mobile-control'
    ) as HTMLFormElement;

    await act(async () => {
      input.value = 'y';
      input.dispatchEvent(
        new InputEvent('input', {
          bubbles: true,
          data: 'y',
          inputType: 'insertText',
        })
      );
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });

    await act(async () => form.requestSubmit());
    await act(async () => form.requestSubmit());

    expect(onSelectSession).not.toHaveBeenCalled();
    expect(onSendInput).toHaveBeenCalledWith('local-session', 'y\r', undefined);
  });

  it('disables disconnected mobile controls before submit', async () => {
    const onSendInput = vi.fn().mockResolvedValue({ ok: true });
    await renderView(
      {
        sessions: [
          makeSession({
            id: 's1',
            displayName: 'offline approval',
            activityState: 'permission-prompt',
            permissionType: 'approval',
            status: 'disconnected',
          }),
        ],
        onSendInput,
      },
      { advancedMode: true }
    );

    const input = container.querySelector(
      '.topic-mobile-control input'
    ) as HTMLInputElement;
    const submit = container.querySelector(
      '.topic-mobile-control__primary'
    ) as HTMLButtonElement;
    const form = container.querySelector(
      '.topic-mobile-control'
    ) as HTMLFormElement;

    expect(input.disabled).toBe(true);
    expect(submit.disabled).toBe(true);
    expect(submit.title).toContain('offline/disconnected');
    expect(container.textContent).toContain(
      'controls disabled: session offline/disconnected'
    );

    await act(async () => form.requestSubmit());
    expect(onSendInput).not.toHaveBeenCalled();
  });

  it('disables stale/offline mobile resume while preserving artifact handoff', async () => {
    await renderView(
      {
        sessions: [
          makeSession({
            id: 's1',
            displayName: 'offline idle session',
            activityState: 'idle',
            idle: true,
            status: 'disconnected',
          }),
        ],
        surfaces: [
          makeSurface({
            id: 'surface:log',
            kind: 'logs',
            label: 'Last known artifact',
            openMode: 'copy',
            command: 'relay artifact show surface:log',
          }),
        ],
      },
      { advancedMode: true }
    );

    expect(container.querySelector('.topic-mobile-row')?.textContent).toContain(
      'waiting'
    );
    expect(container.textContent).toContain(
      'controls disabled: session offline/disconnected'
    );

    const buttons = Array.from(
      container.querySelectorAll('.topic-mobile-actions button')
    ) as HTMLButtonElement[];
    const resume = buttons.find(
      (button) => button.textContent === 'resume topic'
    ) as HTMLButtonElement;
    const terminal = buttons.find(
      (button) => button.textContent === 'open terminal tab'
    ) as HTMLButtonElement;
    const artifact = buttons.find((button) =>
      button.textContent?.includes('logs artifact')
    ) as HTMLButtonElement;

    expect(resume.disabled).toBe(true);
    expect(resume.title).toContain('offline/disconnected');
    expect(terminal.disabled).toBe(true);
    expect(artifact.disabled).toBe(false);
    await act(async () => artifact.click());
    expect(container.textContent).toMatch(
      /surface (target ready to copy|target copied|copy unavailable)/
    );
    expect(onSelectSession).not.toHaveBeenCalled();
  });

  it('keeps permission/question terminal input available without ownership state', async () => {
    const onSendInput = vi.fn().mockResolvedValue({ ok: true });
    await renderView(
      {
        sessions: [
          makeSession({
            id: 's1',
            displayName: 'approval awaiting input',
            activityState: 'permission-prompt',
            permissionType: 'approval',
            status: 'active',
          }),
        ],
        onSendInput,
      },
      { advancedMode: true }
    );

    expect(container.querySelector('.topic-mobile-row')?.textContent).toContain(
      'approve'
    );
    expect(container.textContent).not.toContain('unknown control state');

    const input = container.querySelector(
      '.topic-mobile-control input'
    ) as HTMLInputElement;
    const submit = container.querySelector(
      '.topic-mobile-control__primary'
    ) as HTMLButtonElement;
    const presets = Array.from(
      container.querySelectorAll('.topic-mobile-control__preset')
    ) as HTMLButtonElement[];
    const buttons = Array.from(
      container.querySelectorAll('.topic-mobile-actions button')
    ) as HTMLButtonElement[];
    const resume = buttons.find(
      (button) => button.textContent === 'resume topic'
    ) as HTMLButtonElement;
    const terminal = buttons.find(
      (button) => button.textContent === 'open terminal tab'
    ) as HTMLButtonElement;

    expect(input.disabled).toBe(false);
    expect(submit.disabled).toBe(true);
    expect(submit.title).not.toContain('control state');
    expect(presets.map((preset) => preset.disabled)).toEqual([false, false]);
    expect(resume.disabled).toBe(false);
    expect(resume.title).toContain('open the linked Relay tab');
    expect(terminal.disabled).toBe(false);

    await act(async () => terminal.click());
    expect(onSelectSession).toHaveBeenCalledWith('s1');
    expect(onSendInput).not.toHaveBeenCalled();

    vi.clearAllMocks();
    await renderView(
      {
        sessions: [
          makeSession({
            id: 's1',
            displayName: 'question awaiting input',
            activityState: 'permission-prompt',
            permissionType: 'question',
            status: 'active',
          }),
        ],
        onSendInput,
      },
      { advancedMode: true }
    );

    expect(container.querySelector('.topic-mobile-row')?.textContent).toContain(
      'reply'
    );
    expect(container.textContent).not.toContain('unknown control state');

    const questionInput = container.querySelector(
      '.topic-mobile-control input'
    ) as HTMLInputElement;
    const questionSubmit = container.querySelector(
      '.topic-mobile-control__primary'
    ) as HTMLButtonElement;
    const questionTerminal = Array.from(
      container.querySelectorAll('.topic-mobile-actions button')
    ).find(
      (button) => button.textContent === 'open terminal tab'
    ) as HTMLButtonElement;

    expect(questionInput.disabled).toBe(false);
    expect(questionSubmit.disabled).toBe(true);
    expect(
      container.querySelectorAll('.topic-mobile-control__preset')
    ).toHaveLength(0);
    expect(questionTerminal.disabled).toBe(false);

    await act(async () => questionTerminal.click());
    expect(onSelectSession).toHaveBeenCalledWith('s1');
    expect(onSendInput).not.toHaveBeenCalled();
  });

  it('keeps resume-last enabled when only live input control state is unsafe', async () => {
    const onSendInput = vi.fn().mockResolvedValue({ ok: true });
    await renderView({
      sessions: [
        makeSession({
          id: 's1',
          displayName: 'live Hermes pty session',
          status: 'active',
        }),
      ],
      onSendInput,
    });

    expect(container.querySelector('.topic-mobile-detail')).toBeNull();

    const resumeLast = container.querySelector(
      '.topic-mobile-cockpit__resume'
    ) as HTMLButtonElement;
    expect(resumeLast.disabled).toBe(false);
    await act(async () => resumeLast.click());
    expect(onSelectSession).toHaveBeenCalledWith('s1');
    expect(onSendInput).not.toHaveBeenCalled();
  });

  it('makes the mobile row an explicit channel timeline affordance', async () => {
    await renderView();

    const row = container.querySelector(
      '.topic-mobile-row'
    ) as HTMLButtonElement;
    expect(container.querySelector('.topic-mobile-actions')).toBeNull();
    expect(row.querySelector('.topic-mobile-row__cta')?.textContent).toBe(
      'open'
    );
    expect(row.title).toBe('open channel timeline');
    await act(async () => row.click());
    expect(onSelectSession).not.toHaveBeenCalled();
    expect(useUiStore.getState().activeChannelId).toBe('topic:alpha');
  });

  it('resumes an attachable derived session without opening a channel timeline', async () => {
    useUiStore.setState({ sidebarOpen: true, activeChannelId: null });
    await renderView({
      topics: [
        makeTopic({
          id: 'topic:derived-session',
          source: 'derived',
          linkedRefs: { sessionIds: ['s1'] },
        }),
      ],
      sessions: [
        makeSession({
          id: 's1',
          displayName: 'Derived lane',
          status: 'active',
        }),
      ],
      surfaces: [],
    });

    const row = container.querySelector(
      '.topic-mobile-row'
    ) as HTMLButtonElement;
    expect(row.querySelector('.topic-mobile-row__cta')?.textContent).toBe(
      'resume'
    );
    expect(row.title).toContain('resume chat Derived lane');

    await act(async () => row.click());

    expect(onSelectSession).toHaveBeenCalledTimes(1);
    expect(onSelectSession).toHaveBeenCalledWith('s1');
    expect(useUiStore.getState().activeChannelId).toBeNull();
    expect(useUiStore.getState().sidebarOpen).toBe(false);
  });

  it('renders bounded topic history search without changing the thin-line layout', async () => {
    const onSearchQueryChange = vi.fn();
    await renderView({
      topics: [],
      sessions: [],
      surfaces: [],
      searchQuery: 'apollo',
      searchLoading: true,
      onSearchQueryChange,
    });

    expect(container.querySelector('.topic-search')).not.toBeNull();
    expect(container.textContent).toContain('search');
    expect(container.textContent).not.toContain(
      'no topic matches for “apollo”'
    );
    const input = container.querySelector(
      '.topic-search__input'
    ) as HTMLInputElement;
    expect(input.value).toBe('apollo');
  });

  it('keeps keyboard-visible focus styling for the search input', () => {
    const css = fs.readFileSync(
      'frontend/src/components/TopicSidebarShell.css',
      'utf8'
    );

    expect(css).toContain('.topic-search__input:focus-visible');
    expect(css).toMatch(
      /\.topic-search__input:focus-visible\s*{[\s\S]*outline:\s*1px solid var\(--accent\)/
    );
  });

  it('keeps keyboard-visible focus styling for room controls', () => {
    const css = fs.readFileSync(
      'frontend/src/components/TopicSidebarShell.css',
      'utf8'
    );

    expect(css).toMatch(
      /\.topic-room__primary:not\(:disabled\):focus-visible,\s*\.topic-room-ref-list a:focus-visible\s*{[\s\S]*outline:\s*1px solid var\(--accent\)[\s\S]*outline-offset:\s*2px[\s\S]*box-shadow:/
    );
    expect(css).toMatch(
      /\.topic-room-session__button:focus-visible\s*{[\s\S]*outline:\s*1px solid var\(--accent\)[\s\S]*outline-offset:\s*2px[\s\S]*box-shadow:/
    );
  });

  it('opens direct surfaces with noopener and noreferrer isolation', async () => {
    const openMock = vi.fn();
    vi.stubGlobal('open', openMock);

    await renderView({
      showAdvancedDetail: true,
      topics: [makeTopic({ linkedRefs: { sessionIds: [] } })],
      sessions: [],
      surfaces: [makeSurface()],
    });

    const primary = container.querySelector(
      '.topic-room__primary'
    ) as HTMLButtonElement;
    await act(async () => primary.click());

    expect(openMock).toHaveBeenCalledWith(
      'http://localhost:5173',
      '_blank',
      'noopener,noreferrer'
    );
  });

  it('keeps active search input mounted instead of showing global loading', async () => {
    const onSearchQueryChange = vi.fn();
    await renderView({
      loading: true,
      topics: [],
      sessions: [],
      surfaces: [],
      searchQuery: 'apollo',
      searchLoading: true,
      onSearchQueryChange,
    });

    expect(container.textContent).not.toContain('loading topic shell');
    expect(container.querySelector('.topic-search__input')).not.toBeNull();
    expect(container.textContent).not.toContain(
      'no topic matches for “apollo”'
    );
  });

  it('keeps search controls mounted for inline search errors with retry and clear actions', async () => {
    const onSearchRetry = vi.fn();
    const onSearchClear = vi.fn();
    await renderView({
      topics: [],
      sessions: [],
      surfaces: [],
      searchQuery: 'apollo',
      searchError: true,
      onSearchRetry,
      onSearchClear,
    });

    expect(container.querySelector('.topic-shell')).not.toBeNull();
    expect(container.querySelector('.topic-search__input')).not.toBeNull();
    expect(container.textContent).toContain('chat search unavailable');
    const retryButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'retry'
    ) as HTMLButtonElement;
    const clearButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'clear'
    ) as HTMLButtonElement;
    await act(async () => retryButton.click());
    await act(async () => clearButton.click());
    expect(onSearchRetry).toHaveBeenCalledTimes(1);
    expect(onSearchClear).toHaveBeenCalledTimes(1);
  });

  it('renders participant roster cards grouped by role/runtime and opens exact existing sessions', async () => {
    await renderView({
      showAdvancedDetail: true,
      topics: [
        makeTopic({
          linkedRefs: { sessionIds: ['devbox:remote-ika', 'global:kame'] },
        }),
      ],
      sessions: [
        makeSession({
          id: 'remote-ika',
          nodeId: 'devbox',
          displayName: 'Ika frontend',
          activityState: 'processing',
          currentActivity: {
            tool: 'edit',
            detail: 'wiring participant roster',
          },
          lastActivity: '2026-06-25T23:44:00Z',
        }),
        makeSession({
          id: 'kame-local',
          globalSessionId: 'global:kame',
          displayName: 'Kame QA',
          status: 'disconnected',
          lastActivity: '2026-06-24T12:00:00Z',
        }),
      ],
      surfaces: [],
    });

    const roster = container.querySelector('.topic-participants');
    expect(roster?.textContent).toContain('participants');
    expect(roster?.textContent).toContain('terminal · running');
    expect(roster?.textContent).toContain('terminal · offline');
    expect(roster?.textContent).toContain('last 25-06-26');
    expect(roster?.textContent).not.toContain('driven');
    expect(roster?.textContent).toContain('wiring participant roster');
    expect(roster?.textContent).toContain('running');
    expect(roster?.textContent).toContain('offline');

    const childRows = Array.from(
      container.querySelectorAll('.topic-child-row')
    );
    const ikaChildRow = childRows.find((row) =>
      row.textContent?.includes('Ika frontend')
    );
    expect(ikaChildRow).toBeTruthy();
    expect(ikaChildRow?.textContent).not.toContain('agent · pty');
    expect(ikaChildRow?.textContent).not.toContain('last 25-06-26');
    expect(ikaChildRow?.textContent).not.toContain('driven');
    expect(ikaChildRow?.textContent).not.toContain('wiring participant roster');

    const ikaCard = Array.from(
      container.querySelectorAll('.topic-participant-card')
    ).find((card) =>
      card.textContent?.includes('Ika frontend')
    ) as HTMLButtonElement;
    await act(async () => ikaCard.click());
    expect(onSelectSession).toHaveBeenCalledWith('devbox:remote-ika');
  });

  it('renders search result explanation, freshness, stale caveat, and truncation metadata without blocking the open action', async () => {
    const staleTopic = makeTopic({
      id: 'topic:stale',
      display: {
        title: 'Stale result topic',
        description: 'Search metadata detail',
      },
    });
    const searchResults: WorkspaceTopicSearchResult[] = [
      {
        topic: staleTopic,
        score: 120,
        freshness: 'stale',
        matches: [
          {
            kind: 'task',
            field: 'linkedRefs.taskRefs.title',
            label: 'task title',
            value: 'apollo search acceptance',
          },
        ],
        action: {
          kind: 'open-topic',
          topicId: 'topic:stale',
          primarySessionId: 's-stale',
          disabledReason: 'some linked surfaces are stale or unreachable',
        },
      },
    ];

    await renderView({
      topics: [staleTopic],
      sessions: [],
      surfaces: [],
      searchQuery: 'apollo',
      searchResults,
      searchTruncated: true,
    });

    expect(container.textContent).toContain(
      'task title: apollo search acceptance'
    );
    expect(container.textContent).toContain('stale');
    expect(container.textContent).toContain(
      'some linked surfaces are stale or unreachable'
    );
    expect(container.textContent).toContain('results truncated');
    // #1287 slice 5 item 20: a stale linked surface is a caveat about the
    // topic's evidence, not about the chat — the channel still opens, and it
    // opens the channel instead of attaching `primarySessionId`.
    const action = container.querySelector(
      '.topic-search-result__action'
    ) as HTMLButtonElement;
    expect(action.disabled).toBe(false);
    await act(async () => action.click());
    expect(onSelectSession).not.toHaveBeenCalled();
    expect(useUiStore.getState().activeChannelId).toBe('topic:stale');
  });

  it('opens the channel from a search row for a channel-native chat with no sessions', async () => {
    // #1287 slice 5 item 20: the row used to attach `action.primarySessionId`
    // and disable itself when the topic had none — which was every chat born in
    // a channel. The action is `open-topic`, so it must route by `topicId`.
    useUiStore.setState({ sidebarOpen: true, activeChannelId: null });
    const channelTopic = makeTopic({
      id: 'topic:channel-native',
      workspaceId: 'workspace:beta',
      display: { title: 'Channel native chat' },
      linkedRefs: {},
      routingDefaults: {},
    });
    const searchResults: WorkspaceTopicSearchResult[] = [
      {
        topic: channelTopic,
        score: 80,
        freshness: 'fresh',
        matches: [
          {
            kind: 'topic',
            field: 'display.title',
            label: 'chat title',
            value: 'Channel native chat',
          },
        ],
        action: { kind: 'open-topic', topicId: 'topic:channel-native' },
      },
    ];

    await renderView({
      topics: [channelTopic],
      sessions: [],
      surfaces: [],
      searchQuery: 'channel',
      searchResults,
    });

    const action = container.querySelector(
      '.topic-search-result__action'
    ) as HTMLButtonElement;
    expect(action.disabled).toBe(false);
    expect(action.title).toBe('open chat');

    await act(async () => action.click());

    expect(useUiStore.getState().activeChannelId).toBe('topic:channel-native');
    expect(useUiStore.getState().activeWorkspaceId).toBe('workspace:beta');
    expect(useUiStore.getState().topicComposerOpen).toBe(false);
    expect(useUiStore.getState().sidebarOpen).toBe(false);
    expect(onSelectSession).not.toHaveBeenCalled();
  });

  it('resumes the linked session from a derived search row instead of opening nothing', async () => {
    // The server's chat search deliberately appends derived topics
    // (`fallbackTopics` over the WorkContext store). `openTopicSelection`
    // returns early for anything not `persisted`, so routing them through the
    // channel path rendered an enabled `open` button that only shifted
    // workspace context — while the rail resumed the very same topic's session.
    useUiStore.setState({ sidebarOpen: true, activeChannelId: null });
    const derivedTopic = makeTopic({
      id: 'topic:derived-hit',
      source: 'derived',
      workspaceId: 'workspace:beta',
      display: { title: 'Derived session chat' },
      linkedRefs: { sessionIds: ['s1'] },
    });
    const searchResults: WorkspaceTopicSearchResult[] = [
      {
        topic: derivedTopic,
        score: 60,
        freshness: 'fresh',
        matches: [
          {
            kind: 'topic',
            field: 'display.title',
            label: 'chat title',
            value: 'Derived session chat',
          },
        ],
        action: {
          kind: 'open-topic',
          topicId: 'topic:derived-hit',
          primarySessionId: 's1',
        },
      },
    ];

    await renderView({
      topics: [derivedTopic],
      sessions: [makeSession({ id: 's1', displayName: 'Derived lane' })],
      surfaces: [],
      searchQuery: 'derived',
      searchResults,
    });

    const action = container.querySelector(
      '.topic-search-result__action'
    ) as HTMLButtonElement;
    expect(action.disabled).toBe(false);
    expect(action.textContent).toBe('resume');
    expect(action.title).toBe('resume the linked session');

    await act(async () => action.click());

    // Same disposition the rail gives this topic: the session, never a channel.
    expect(onSelectSession).toHaveBeenCalledWith('s1');
    expect(useUiStore.getState().activeChannelId).toBeNull();
    expect(useUiStore.getState().activeWorkspaceId).toBe('workspace:beta');
    expect(useUiStore.getState().sidebarOpen).toBe(false);
  });

  it('disables a derived search row that reaches neither a channel nor a session', async () => {
    const derivedTopic = makeTopic({
      id: 'topic:derived-orphan',
      source: 'derived',
      display: { title: 'Orphan derived chat' },
      linkedRefs: {},
    });
    const searchResults: WorkspaceTopicSearchResult[] = [
      {
        topic: derivedTopic,
        score: 20,
        freshness: 'stale',
        matches: [],
        action: { kind: 'open-topic', topicId: 'topic:derived-orphan' },
      },
    ];

    await renderView({
      topics: [derivedTopic],
      sessions: [],
      surfaces: [],
      searchQuery: 'orphan',
      searchResults,
    });

    const action = container.querySelector(
      '.topic-search-result__action'
    ) as HTMLButtonElement;
    expect(action.disabled).toBe(true);
    expect(action.title).toBe('no chat or session to open for this hit');
  });

  it('disables a derived search row whose linked session no longer resolves', async () => {
    // `primarySessionId` is a string on a WorkContext record, not proof the
    // session exists. Enabling `resume` on id presence alone let the operator
    // click into `activeSessionId = <gone id>`, which App's channel/session
    // mutual exclusion reads as "a session opened" and uses to clear
    // `activeChannelId` — the row closed the chat they were reading and landed
    // them on neither surface. The rail disables the same topic's resume, so
    // this row must too.
    useUiStore.setState({
      sidebarOpen: true,
      activeChannelId: 'topic:already-open',
    });
    const derivedTopic = makeTopic({
      id: 'topic:derived-gone',
      source: 'derived',
      display: { title: 'Gone session chat' },
      linkedRefs: { sessionIds: ['gone'] },
    });
    const searchResults: WorkspaceTopicSearchResult[] = [
      {
        topic: derivedTopic,
        score: 40,
        freshness: 'stale',
        matches: [],
        action: {
          kind: 'open-topic',
          topicId: 'topic:derived-gone',
          primarySessionId: 'gone',
        },
      },
    ];

    await renderView({
      topics: [derivedTopic],
      sessions: [],
      surfaces: [],
      searchQuery: 'gone',
      searchResults,
    });

    const action = container.querySelector(
      '.topic-search-result__action'
    ) as HTMLButtonElement;
    expect(action.disabled).toBe(true);
    expect(action.title).toBe('linked session is no longer available');

    await act(async () => action.click());

    expect(onSelectSession).not.toHaveBeenCalled();
    // The channel the operator was reading survives the dead row.
    expect(useUiStore.getState().activeChannelId).toBe('topic:already-open');
  });

  it('disables a derived search row whose linked session cannot be attached', async () => {
    // Parity with the rail: `selectMobile` gates resume on
    // `sessionAttachDisabledReason`, so a disconnected session must read the
    // same on both entry points, reason and all.
    useUiStore.setState({
      sidebarOpen: true,
      activeChannelId: 'topic:already-open',
    });
    const derivedTopic = makeTopic({
      id: 'topic:derived-dead',
      source: 'derived',
      display: { title: 'Disconnected session chat' },
      linkedRefs: { sessionIds: ['s-dead'] },
    });
    const searchResults: WorkspaceTopicSearchResult[] = [
      {
        topic: derivedTopic,
        score: 40,
        freshness: 'stale',
        matches: [],
        action: {
          kind: 'open-topic',
          topicId: 'topic:derived-dead',
          primarySessionId: 's-dead',
        },
      },
    ];

    await renderView({
      topics: [derivedTopic],
      sessions: [
        makeSession({
          id: 's-dead',
          displayName: 'Dead lane',
          status: 'disconnected',
        }),
      ],
      surfaces: [],
      searchQuery: 'dead',
      searchResults,
    });

    const action = container.querySelector(
      '.topic-search-result__action'
    ) as HTMLButtonElement;
    expect(action.disabled).toBe(true);
    expect(action.title).toBe(
      'session offline/disconnected — controls unavailable until reconnect'
    );

    await act(async () => action.click());

    expect(onSelectSession).not.toHaveBeenCalled();
    expect(useUiStore.getState().activeChannelId).toBe('topic:already-open');
  });

  it('threads the show-older-chats toggle into chat search requests', async () => {
    // #1287: the archived toggle used to drive only the non-search list query,
    // so searching an archived chat title reported no matches.
    const archivedTopic = makeTopic({
      id: 'topic:old',
      status: 'archived',
      display: { title: 'Archived lane' },
      linkedRefs: {},
    });
    // Parsed rather than raw URLs so param order in searchWorkspaceTopics()
    // is free to change without breaking this regression.
    const searchQueries: Record<string, string>[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/workspace-topics/search')) {
        const params = new URL(url, 'http://relay.test').searchParams;
        searchQueries.push(Object.fromEntries(params));
        const includeArchived = params.get('includeArchived') === '1';
        return Response.json({
          query: 'archived',
          results: includeArchived
            ? [
                {
                  topic: archivedTopic,
                  score: 10,
                  freshness: 'fresh',
                  matches: [],
                  action: { kind: 'open-topic', topicId: archivedTopic.id },
                },
              ]
            : [],
          truncated: false,
          derived: false,
        });
      }
      return Response.json({
        topics: [],
        surfaces: [],
        nodes: [],
        workspaces: [],
        truncated: false,
        derived: false,
      });
    }) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchMock);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await act(async () => {
      root.render(
        React.createElement(
          QueryClientProvider,
          { client: queryClient },
          React.createElement(TopicSidebarShell, { onSelectSession })
        )
      );
    });
    await act(async () => {
      await flushQueryEffects();
    });

    const searchInput = container.querySelector(
      '.topic-search__input'
    ) as HTMLInputElement;
    await act(async () => {
      setInputValue(searchInput, 'archived');
      searchInput.dispatchEvent(
        new InputEvent('input', {
          bubbles: true,
          data: 'archived',
          inputType: 'insertText',
        })
      );
    });
    // #1293: wait for the empty-result row rather than a fixed flush — the
    // search request resolves a tick before the panel re-renders.
    await waitForRendered(
      () => container.textContent?.includes('no chat matches for') === true,
      'the empty chat-search result row'
    );

    expect(searchQueries).toEqual([{ q: 'archived', limit: '20' }]);
    expect(container.textContent).not.toContain('Archived lane');

    const archivedToggle = container.querySelector(
      '.topic-archived-toggle__btn'
    ) as HTMLButtonElement;
    await act(async () => {
      archivedToggle.click();
    });
    await waitForRendered(
      () => container.textContent?.includes('Archived lane') === true,
      'the archived chat-search result row'
    );

    expect(searchQueries).toContainEqual({
      q: 'archived',
      includeArchived: '1',
      limit: '20',
    });
    expect(container.textContent).not.toContain('no chat matches for');
    queryClient.clear();
  });

  // ── message search section (#1308 slice 2 item 2) ─────────────────────────
  describe('message search section (#1308 slice 2)', () => {
    it('renders chats and messages as two labelled sections with emphasized matches', async () => {
      await renderView({
        topics: [
          makeTopic({ id: 'topic:hit', display: { title: 'Hit lane' } }),
        ],
        sessions: [],
        surfaces: [],
        searchQuery: 'sqlite',
        searchResults: [
          {
            topic: makeTopic({
              id: 'topic:hit',
              display: { title: 'Hit lane' },
            }),
            score: 90,
            freshness: 'fresh',
            matches: [
              {
                kind: 'topic',
                field: 'display.title',
                label: 'chat title',
                value: 'Hit lane',
              },
            ],
            action: { kind: 'open-topic', topicId: 'topic:hit' },
          },
        ],
        messageResults: [makeMessageHit()],
      });

      const sections = Array.from(
        container.querySelectorAll('.topic-search-section')
      );
      expect(sections.map((s) => s.getAttribute('aria-label'))).toEqual([
        'chat search results',
        'message search results',
      ]);
      expect(
        sections.map(
          (s) => s.querySelector('.topic-search-section__header')?.textContent
        )
      ).toEqual(['chats', 'messages']);

      // A chat hit still renders in the chats section, unchanged.
      expect(sections[0]?.textContent).toContain('Hit lane');
      expect(sections[0]?.querySelector('.topic-search-result')).not.toBeNull();

      const row = sections[1]?.querySelector(
        '.topic-message-result'
      ) as HTMLButtonElement;
      expect(row).not.toBeNull();
      // Channel title, sender label, snippet, relative stamp.
      expect(
        row.querySelector('.topic-message-result__channel')?.textContent
      ).toBe('Build UI shell');
      expect(
        row.querySelector('.topic-message-result__sender')?.textContent
      ).toBe('claude');
      expect(
        row.querySelector('.topic-message-result__time')?.textContent
      ).toBeTruthy();
      // The PUA sentinels are consumed, never rendered, and the matched run is
      // its own element rather than markup smuggled through the body.
      const snippet = row.querySelector('.topic-message-result__snippet');
      expect(snippet?.textContent).toBe('rebuilt the sqlite index');
      expect(snippet?.textContent).not.toContain(CHANNEL_SEARCH_HIGHLIGHT_OPEN);
      expect(row.querySelector('.topic-message-result__hit')?.textContent).toBe(
        'sqlite'
      );
    });

    it('shows a per-section empty state so a hit in one section is not read as both', async () => {
      await renderView({
        topics: [],
        sessions: [],
        surfaces: [],
        searchQuery: 'apollo',
        searchResults: [],
        messageResults: [],
      });

      expect(container.textContent).toContain('no chat matches for “apollo”');
      expect(container.textContent).toContain(
        'no message matches for “apollo”'
      );
    });

    it('opens the channel and asks it to jump when a message hit is clicked', async () => {
      useUiStore.setState({ sidebarOpen: true, activeChannelId: null });
      await renderView({
        // Deliberately NOT in `topics`: chat-title search returns the chats it
        // matched, and a message can match in a channel whose title did not.
        topics: [],
        sessions: [],
        surfaces: [],
        searchQuery: 'sqlite',
        searchResults: [],
        messageResults: [makeMessageHit()],
      });

      const row = container.querySelector(
        '.topic-message-result'
      ) as HTMLButtonElement;
      await act(async () => row.click());

      expect(useUiStore.getState().activeChannelId).toBe('topic:alpha');
      // The S1 anchor, written AFTER the channel open (which clears it).
      expect(useUiStore.getState().pendingChannelMessage).toEqual({
        channelId: 'topic:alpha',
        messageId: 'chm:hit-1',
      });
      expect(useUiStore.getState().sidebarOpen).toBe(false);
      expect(onSelectSession).not.toHaveBeenCalled();
    });

    it('anchors a thread hit on the reply itself so the S1 walk opens its panel', async () => {
      // The sidebar deliberately does NOT resolve the root or open the panel:
      // `ChannelView` maps a reply anchor to `activeThreadRootId` (proved in
      // test/components/channel-message-jump.test.ts). Handing it the ROOT id
      // here would land the jump on the main lane and never open the thread.
      useUiStore.setState({ sidebarOpen: true, activeChannelId: null });
      await renderView({
        topics: [],
        sessions: [],
        surfaces: [],
        searchQuery: 'sqlite',
        searchResults: [],
        messageResults: [
          makeMessageHit({
            messageId: 'chm:reply-9' as ChannelMessageId,
            threadId: 'chm:root-1' as ChannelMessageId,
          }),
        ],
      });

      const row = container.querySelector(
        '.topic-message-result'
      ) as HTMLButtonElement;
      expect(
        row.querySelector('.topic-message-result__thread')?.textContent
      ).toBe('thread');

      await act(async () => row.click());

      expect(useUiStore.getState().pendingChannelMessage).toEqual({
        channelId: 'topic:alpha',
        messageId: 'chm:reply-9',
      });
    });

    it('threads the show-older-chats toggle into BOTH search requests', async () => {
      // #1288 lesson, applied to the second section: the toggle has to reach
      // the message query's KEY as well as its params, or TanStack serves the
      // active-only answer to the include-archived question.
      const topicQueries: Record<string, string>[] = [];
      const messageQueries: Record<string, string>[] = [];
      const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.startsWith('/workspace-topics/search')) {
          const params = new URL(url, 'http://relay.test').searchParams;
          topicQueries.push(Object.fromEntries(params));
          return Response.json({
            query: 'archived',
            results: [],
            truncated: false,
            derived: false,
          });
        }
        if (url.startsWith('/channels/search')) {
          const params = new URL(url, 'http://relay.test').searchParams;
          messageQueries.push(Object.fromEntries(params));
          const includeArchived = params.get('includeArchived') === '1';
          return Response.json({
            query: 'archived',
            results: includeArchived
              ? [
                  makeMessageHit({
                    channelTitle: 'Archived lane',
                    archived: true,
                    snippet: 'said archived once',
                  }),
                ]
              : [],
            truncated: false,
          });
        }
        return Response.json({
          topics: [],
          surfaces: [],
          nodes: [],
          workspaces: [],
          truncated: false,
          derived: false,
        });
      }) as unknown as typeof fetch;
      vi.stubGlobal('fetch', fetchMock);
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });

      await act(async () => {
        root.render(
          React.createElement(
            QueryClientProvider,
            { client: queryClient },
            React.createElement(TopicSidebarShell, { onSelectSession })
          )
        );
      });
      await act(async () => {
        await flushQueryEffects();
      });

      const searchInput = container.querySelector(
        '.topic-search__input'
      ) as HTMLInputElement;
      await act(async () => {
        setInputValue(searchInput, 'archived');
        searchInput.dispatchEvent(
          new InputEvent('input', {
            bubbles: true,
            data: 'archived',
            inputType: 'insertText',
          })
        );
      });
      await waitForRendered(
        () =>
          container.textContent?.includes('no message matches for') === true,
        'the empty message-search section'
      );

      // One shared debounce: one request per section for the whole word.
      expect(topicQueries).toEqual([{ q: 'archived', limit: '20' }]);
      expect(messageQueries).toEqual([{ q: 'archived', limit: '20' }]);
      expect(container.textContent).not.toContain('Archived lane');

      const archivedToggle = container.querySelector(
        '.topic-archived-toggle__btn'
      ) as HTMLButtonElement;
      await act(async () => {
        archivedToggle.click();
      });
      await waitForRendered(
        () => container.textContent?.includes('Archived lane') === true,
        'the archived message-search hit'
      );

      expect(topicQueries).toContainEqual({
        q: 'archived',
        includeArchived: '1',
        limit: '20',
      });
      expect(messageQueries).toContainEqual({
        q: 'archived',
        includeArchived: '1',
        limit: '20',
      });
      expect(container.textContent).not.toContain('no message matches for');
      queryClient.clear();
    });

    it('refuses to search messages below the minimum query length', async () => {
      // A one-character prefix ranks essentially the whole FTS corpus inside a
      // synchronous sqlite call on the hub's event loop, so the rail must not
      // send it at all. Chat-title search is an in-memory scan and keeps
      // answering from the first keystroke.
      expect(CHANNEL_SEARCH_MIN_QUERY_CHARS).toBe(3);
      const topicQueries: string[] = [];
      const messageQueries: string[] = [];
      const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.startsWith('/workspace-topics/search')) {
          topicQueries.push(url);
          return Response.json({
            query: 'sq',
            results: [],
            truncated: false,
            derived: false,
          });
        }
        if (url.startsWith('/channels/search')) {
          messageQueries.push(url);
          return Response.json({
            query: 'sq',
            results: [makeMessageHit()],
            truncated: false,
          });
        }
        return Response.json({
          topics: [],
          surfaces: [],
          nodes: [],
          workspaces: [],
          truncated: false,
          derived: false,
        });
      }) as unknown as typeof fetch;
      vi.stubGlobal('fetch', fetchMock);
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });

      await act(async () => {
        root.render(
          React.createElement(
            QueryClientProvider,
            { client: queryClient },
            React.createElement(TopicSidebarShell, { onSelectSession })
          )
        );
      });
      await act(async () => {
        await flushQueryEffects();
      });

      const searchInput = container.querySelector(
        '.topic-search__input'
      ) as HTMLInputElement;
      await act(async () => {
        setInputValue(searchInput, 'sq');
        searchInput.dispatchEvent(
          new InputEvent('input', {
            bubbles: true,
            data: 'sq',
            inputType: 'insertText',
          })
        );
      });
      await waitForRendered(
        () =>
          container.textContent?.includes(
            'type 3 characters to search messages'
          ) === true,
        'the too-short message-search state'
      );

      // The chats section is an in-memory scan, so it still answers two
      // characters; only the index read is withheld.
      await waitForRendered(
        () => topicQueries.length === 1,
        'the chat-title search for the same two characters'
      );
      expect(messageQueries).toEqual([]);
      // The refusal is named, never dressed up as a miss over a corpus nothing
      // consulted.
      expect(container.textContent).not.toContain('no message matches for');

      await act(async () => {
        setInputValue(searchInput, 'sql');
        searchInput.dispatchEvent(
          new InputEvent('input', {
            bubbles: true,
            data: 'l',
            inputType: 'insertText',
          })
        );
      });
      await waitForRendered(
        () => container.textContent?.includes('Build UI shell') === true,
        'the message hit once the query is long enough'
      );
      expect(messageQueries).toHaveLength(1);
      expect(messageQueries[0]).toContain('q=sql');
      queryClient.clear();
    });
  });
});
