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
import type {
  WorkspaceTopic,
  WorkspaceTopicListResponse,
} from '../shared/workspace-topics.js';
import { createMockFetch } from './helpers/mock-fetch.js';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = '2026-07-27T00:00:00Z';

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
    display: { title: 'Palette lane', description: 'palette open target' },
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

async function flushQueryEffects() {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
}

describe('<CommandPalette /> topic selection', () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;

  beforeEach(() => {
    _resetForTesting();
    useUiStore.setState({
      activeChannelId: null,
      topicComposerOpen: true,
      sidebarOpen: true,
    });
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
            // The exact reference App.tsx wires into the palette.
            onSelectTopic: openTopicSelectionFromPalette,
            onSelectPr: vi.fn(),
          })
        )
      );
      await flushQueryEffects();
    });
  }

  function topicItem(title: string): HTMLElement {
    const item = [...container.querySelectorAll('.palette-item')].find(
      (el) => el.querySelector('.item-label')?.textContent === title
    );
    if (!item) throw new Error(`palette item not found: ${title}`);
    return item as HTMLElement;
  }

  it('opens the channel when a persisted topic is selected', async () => {
    queryClient.setQueryData(['workspace-topics'], listResponse([makeTopic()]));
    await renderPalette();

    await act(async () => topicItem('Palette lane').click());

    expect(useUiStore.getState().activeChannelId).toBe('topic:alpha');
    expect(useUiStore.getState().topicComposerOpen).toBe(false);
    expect(useUiStore.getState().activeWorkspaceId).toBe('workspace:alpha');
    expect(useUiStore.getState().activeRepoPath).toBe('/repo/relay');
    // The palette floats over the mobile drawer, which must not stay open.
    expect(useUiStore.getState().sidebarOpen).toBe(false);
  });

  it('leaves the channel closed for a derived topic', async () => {
    queryClient.setQueryData(
      ['workspace-topics'],
      listResponse([
        makeTopic({
          id: 'topic:derived',
          source: 'derived',
          display: { title: 'Derived lane' },
        }),
      ])
    );
    await renderPalette();

    await act(async () => topicItem('Derived lane').click());

    expect(useUiStore.getState().activeChannelId).toBeNull();
    expect(useUiStore.getState().activeWorkspaceId).toBe('workspace:alpha');
    expect(useUiStore.getState().activeRepoPath).toBe('/repo/relay');
  });

  it('fetches topics itself when the sidebar never mounted to fill the cache', async () => {
    // Collapsed-sidebar users never mount TopicSidebarShell, so the shared
    // ['workspace-topics'] cache entry stays empty (#1287).
    const fetchMock = vi.fn(
      createMockFetch({
        '/workspace-topics': [{ json: listResponse([makeTopic()]) }],
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    await renderPalette();
    await act(async () => {
      await flushQueryEffects();
    });

    expect(fetchMock).toHaveBeenCalled();
    expect(
      queryClient.getQueryData<WorkspaceTopicListResponse>(['workspace-topics'])
        ?.topics
    ).toHaveLength(1);
    await act(async () => topicItem('Palette lane').click());
    expect(useUiStore.getState().activeChannelId).toBe('topic:alpha');
  });

  it('picks up a topic invalidated while the palette was closed', async () => {
    // A topic created elsewhere invalidates ['workspace-topics'] with the default
    // `refetchType: 'active'`, so the palette has to stay an observer of the key
    // to ever see it — otherwise its corpus freezes at the first snapshot for the
    // rest of the session (#1287).
    const fetchMock = vi.fn(
      createMockFetch({
        '/workspace-topics': [
          { json: listResponse([makeTopic()]) },
          {
            json: listResponse([
              makeTopic(),
              makeTopic({
                id: 'topic:beta',
                display: { title: 'Later lane' },
              }),
            ]),
          },
        ],
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    await renderPalette();
    await act(async () => {
      await flushQueryEffects();
    });
    expect(topicItem('Palette lane')).toBeTruthy();

    await renderPalette(false);
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ['workspace-topics'] });
      await flushQueryEffects();
    });
    await renderPalette();
    await act(async () => {
      await flushQueryEffects();
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    await act(async () => topicItem('Later lane').click());
    expect(useUiStore.getState().activeChannelId).toBe('topic:beta');
  });
});
