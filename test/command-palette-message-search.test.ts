// @vitest-environment happy-dom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import CommandPalette from '../frontend/src/components/CommandPalette.js';
import { openTopicSelectionFromPalette } from '../frontend/src/lib/topic-selection.js';
import { useUiStore } from '../frontend/src/lib/stores/ui.js';
import { _resetForTesting } from '../frontend/src/lib/actions/registry.js';
import type { ActionContext } from '../frontend/src/lib/actions/types.js';
import { builtInAgentProfileId } from '../shared/agent-profile.js';
import {
  CHANNEL_SEARCH_HIGHLIGHT_CLOSE,
  CHANNEL_SEARCH_HIGHLIGHT_OPEN,
  type ChannelMessageId,
  type ChannelMessageSearchResult,
} from '../shared/channel-chat-protocol.js';
import type {
  WorkspaceTopic,
  WorkspaceTopicListResponse,
} from '../shared/workspace-topics.js';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = '2026-08-03T00:00:00Z';

/** The palette holds a keystroke for 150ms before either search query runs. */
const DEBOUNCE_SETTLE_MS = 250;

const actionContext: ActionContext = {
  view: 'session',
  workspacePath: '/repo',
  cwd: '/repo',
  isMobile: false,
};

function makeTopic(overrides: Partial<WorkspaceTopic> = {}): WorkspaceTopic {
  return {
    schemaVersion: 1,
    id: 'topic:alpha',
    workspaceId: 'workspace:alpha',
    source: 'persisted',
    status: 'active',
    visibility: 'default',
    display: { title: 'Build UI shell' },
    grouping: {},
    promptDefaults: {},
    routingDefaults: { nodeId: 'devbox', repoPath: '/repo/relay' },
    linkedRefs: {},
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

function listResponse(topics: WorkspaceTopic[]): WorkspaceTopicListResponse {
  return { topics, truncated: false, derived: false };
}

function makeHit(
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

async function flushQueryEffects() {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
}

function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    'value'
  )?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('<CommandPalette /> message search (#1308 slice 2 item 3)', () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;
  let searchUrls: string[];
  let searchHits: ChannelMessageSearchResult[];
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    _resetForTesting();
    useUiStore.setState({
      activeChannelId: null,
      topicComposerOpen: true,
      sidebarOpen: true,
      pendingChannelMessage: null,
    });
    searchUrls = [];
    searchHits = [makeHit()];
    fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/channels/search')) {
        searchUrls.push(url);
        return Response.json({
          query: 'sqlite',
          results: searchHits,
          truncated: false,
        });
      }
      if (url.startsWith('/workspace-topics')) {
        return Response.json(listResponse([makeTopic()]));
      }
      throw new Error(`unstubbed fetch in unit test: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    queryClient.clear();
    container.remove();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    useUiStore.setState({
      activeChannelId: null,
      topicComposerOpen: false,
      sidebarOpen: false,
      pendingChannelMessage: null,
    });
    useUiStore.getState().setActiveRepoPath(null);
    useUiStore.getState().setActiveWorkspaceId(null);
    _resetForTesting();
  });

  async function renderPalette(open = true) {
    await act(async () => {
      root.render(
        React.createElement(
          QueryClientProvider,
          { client: queryClient },
          React.createElement(CommandPalette, {
            open,
            workspaces: [],
            sessions: [],
            actionContext,
            onClose: vi.fn(),
            onSelectWorkspace: vi.fn(),
            onSelectSession: vi.fn(),
            onSelectTopic: openTopicSelectionFromPalette,
            onSelectPr: vi.fn(),
          })
        )
      );
      await flushQueryEffects();
    });
  }

  /** Type into the palette input and let the 150ms debounce + query settle. */
  async function search(text: string) {
    const input = container.querySelector(
      '.palette-search-input'
    ) as HTMLInputElement;
    await act(async () => {
      setInputValue(input, text);
      await flushQueryEffects();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, DEBOUNCE_SETTLE_MS));
      await flushQueryEffects();
    });
    await act(async () => {
      await flushQueryEffects();
    });
  }

  function group(label: string): HTMLElement | null {
    const header = [...container.querySelectorAll('.palette-category')].find(
      (el) => el.textContent?.trim() === label
    );
    return (header?.parentElement as HTMLElement | undefined) ?? null;
  }

  function messageRow(): HTMLElement {
    const row = group('messages')?.querySelector('.palette-item');
    if (!row) throw new Error('no message row rendered');
    return row as HTMLElement;
  }

  it('renders a messages category from the search endpoint, under topics', async () => {
    await renderPalette();
    await search('sqlite');

    expect(searchUrls).toHaveLength(1);
    // The palette asks for its own five rows rather than reusing the sidebar's
    // twenty-row page under a key that never mentions a page size.
    expect(searchUrls[0]).toContain('q=sqlite');
    expect(searchUrls[0]).toContain('limit=5');

    const categories = [...container.querySelectorAll('.palette-category')].map(
      (el) => el.textContent?.trim()
    );
    expect(categories).toContain('messages');
    // The other half of the same question sits directly above it.
    expect(categories.indexOf('messages')).toBe(
      categories.indexOf('topics') + 1
    );

    const row = messageRow();
    // Snippet as the label, with the PUA sentinels consumed; channel + sender
    // as the dim sublabel.
    expect(row.querySelector('.item-label')?.textContent).toBe(
      'rebuilt the sqlite index'
    );
    expect(row.textContent).not.toContain(CHANNEL_SEARCH_HIGHLIGHT_OPEN);
    expect(row.querySelector('.item-sublabel')?.textContent).toBe(
      'Build UI shell · claude'
    );
  });

  it('caps the category at five hits even if the server hands back more', async () => {
    searchHits = Array.from({ length: 9 }, (_, index) =>
      makeHit({ messageId: `chm:hit-${index}` as ChannelMessageId })
    );
    await renderPalette();
    await search('sqlite');

    expect(group('messages')?.querySelectorAll('.palette-item')).toHaveLength(
      5
    );
  });

  it('opens the hit channel and writes the S1 jump anchor when selected', async () => {
    await renderPalette();
    await search('sqlite');

    await act(async () => messageRow().click());

    expect(useUiStore.getState().activeChannelId).toBe('topic:alpha');
    // Written AFTER the channel open, which clears an un-consumed anchor.
    expect(useUiStore.getState().pendingChannelMessage).toEqual({
      channelId: 'topic:alpha',
      messageId: 'chm:hit-1',
    });
    expect(useUiStore.getState().topicComposerOpen).toBe(false);
    // The channel's own workspace/repo context lands too, exactly as clicking
    // its rail row would.
    expect(useUiStore.getState().activeWorkspaceId).toBe('workspace:alpha');
    expect(useUiStore.getState().activeRepoPath).toBe('/repo/relay');
    // The palette floats over the mobile drawer, which must not stay open.
    expect(useUiStore.getState().sidebarOpen).toBe(false);
  });

  it('still opens a hit whose channel is absent from the palette topic corpus', async () => {
    // Routine: chat search returns the chats whose TITLE matched, and a message
    // can match in a channel whose title did not.
    searchHits = [
      makeHit({
        channelId: 'topic:unlisted',
        messageId: 'chm:hit-9' as ChannelMessageId,
        channelTitle: 'Unlisted lane',
      }),
    ];
    await renderPalette();
    await search('sqlite');

    await act(async () => messageRow().click());

    expect(useUiStore.getState().activeChannelId).toBe('topic:unlisted');
    expect(useUiStore.getState().pendingChannelMessage).toEqual({
      channelId: 'topic:unlisted',
      messageId: 'chm:hit-9',
    });
  });

  it('anchors a thread hit on the reply itself so ChannelView opens its panel', async () => {
    // The palette deliberately does NOT resolve the root: `ChannelView` maps a
    // reply anchor to `activeThreadRootId` (test/components/channel-message-jump).
    // Handing it the ROOT would land the jump on the main lane instead.
    searchHits = [
      makeHit({
        messageId: 'chm:reply-9' as ChannelMessageId,
        threadId: 'chm:root-1' as ChannelMessageId,
      }),
    ];
    await renderPalette();
    await search('sqlite');

    expect(messageRow().querySelector('.item-sublabel')?.textContent).toContain(
      'thread'
    );
    await act(async () => messageRow().click());

    expect(useUiStore.getState().pendingChannelMessage).toEqual({
      channelId: 'topic:alpha',
      messageId: 'chm:reply-9',
    });
  });

  it('never searches while the palette is closed', async () => {
    // `usePaletteState` only clears `query` on the way back IN, so a closed
    // palette still holds the last query the operator typed — without `open` in
    // `enabled`, every background refetch would hit the hub for a panel nobody
    // is looking at.
    await renderPalette();
    await search('sqlite');
    expect(searchUrls).toHaveLength(1);

    await renderPalette(false);
    await act(async () => {
      await queryClient.invalidateQueries({
        queryKey: ['channel-message-search'],
      });
      await new Promise((resolve) => setTimeout(resolve, DEBOUNCE_SETTLE_MS));
      await flushQueryEffects();
    });

    expect(searchUrls).toHaveLength(1);
    expect(container.querySelector('.palette-item')).toBeNull();
  });

  it('does not search for an empty query', async () => {
    await renderPalette();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, DEBOUNCE_SETTLE_MS));
      await flushQueryEffects();
    });

    expect(searchUrls).toHaveLength(0);
    expect(
      [...container.querySelectorAll('.palette-category')].map((el) =>
        el.textContent?.trim()
      )
    ).not.toContain('messages');
  });
});
