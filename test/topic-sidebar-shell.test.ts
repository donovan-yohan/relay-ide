// @vitest-environment happy-dom

import * as fs from 'node:fs';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceSurface } from '../shared/workspace-surfaces.js';
import type {
  WorkspaceTopic,
  WorkspaceTopicSearchResult,
} from '../shared/workspace-topics.js';
import { TopicSidebarView } from '../frontend/src/components/TopicSidebarShell.js';
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
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  async function renderView(
    props: Partial<React.ComponentProps<typeof TopicSidebarView>> = {}
  ) {
    await act(async () => {
      root.render(
        React.createElement(TopicSidebarView, {
          topics: [makeTopic()],
          sessions: [makeSession({ id: 's1', displayName: 'Frontend lane' })],
          surfaces: [makeSurface()],
          onSelectSession,
          ...props,
        })
      );
    });
  }

  it('renders a topic row, inline detail, linked session, and surface affordance', async () => {
    await renderView();

    expect(container.querySelector('.topic-shell')).not.toBeNull();
    expect(container.textContent).toContain('Build UI shell');
    expect(container.textContent).toContain('Thin-line topic detail');
    expect(container.textContent).toContain('Frontend lane');
    expect(container.textContent).toContain('preview');
  });

  it('selects linked sessions using the existing sidebar callback', async () => {
    await renderView();
    const sessionButton = container.querySelector(
      '.topic-child-row__button'
    ) as HTMLButtonElement;
    await act(async () => sessionButton.click());
    expect(onSelectSession).toHaveBeenCalledWith('s1');
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

  it('keeps surface actions outside the clickable row button', async () => {
    await renderView();

    const rowMain = container.querySelector('.topic-row__main');
    const surfaceAction = container.querySelector(
      '.topic-row__trail .topic-action'
    );

    expect(rowMain).not.toBeNull();
    expect(surfaceAction).not.toBeNull();
    expect(rowMain?.contains(surfaceAction)).toBe(false);
  });

  it('shows detail for a selected topic even when it has no nested sessions', async () => {
    await renderView({
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
  });

  it('reports loading, error, and empty states', async () => {
    await renderView({ loading: true, topics: [] });
    expect(container.textContent).toContain('loading topic shell');

    await renderView({ loading: false, error: true, topics: [] });
    expect(container.textContent).toContain('topic shell unavailable');

    await renderView({ loading: false, error: false, topics: [] });
    expect(container.textContent).toContain('no workspace topics yet');
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
          agentState: 'idle',
          idle: true,
        }),
        makeSession({
          id: 'approval-session',
          displayName: 'approval',
          agentState: 'permission-prompt',
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

  it('uses a two-step audited mobile reply preview before sending input', async () => {
    const onSendInput = vi.fn().mockResolvedValue({ ok: true });
    await renderView({
      sessions: [
        makeSession({
          id: 's1',
          displayName: 'approval',
          agentState: 'permission-prompt',
          permissionType: 'approval',
          controlFreshness: 'fresh',
        }),
      ],
      onSendInput,
    });

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

  it('makes the resume and terminal-tab mobile controls explicit', async () => {
    await renderView();

    const quickActions = container.querySelector('.topic-mobile-actions');
    expect(quickActions?.textContent).toContain('resume topic');
    expect(quickActions?.textContent).toContain('open terminal tab');

    const terminalTab = Array.from(
      quickActions?.querySelectorAll('button') ?? []
    ).find(
      (button) => button.textContent === 'open terminal tab'
    ) as HTMLButtonElement;
    expect(terminalTab.title).toContain('same linked Relay tab as resume');
    await act(async () => terminalTab.click());
    expect(onSelectSession).toHaveBeenCalledWith('s1');
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
    expect(container.textContent).toContain('topic search unavailable');
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

  it('renders search result explanation, freshness, disabled action, and truncation metadata', async () => {
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
    const action = container.querySelector(
      '.topic-search-result__action'
    ) as HTMLButtonElement;
    expect(action.disabled).toBe(true);
  });
});
