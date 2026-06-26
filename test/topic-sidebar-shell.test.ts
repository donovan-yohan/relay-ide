// @vitest-environment happy-dom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceSurface } from '../shared/workspace-surfaces.js';
import type { WorkspaceTopic } from '../shared/workspace-topics.js';
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
});
