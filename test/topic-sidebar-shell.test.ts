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
import { useSessionsStore } from '../frontend/src/lib/stores/sessions.js';
import { useUiStore } from '../frontend/src/lib/stores/ui.js';
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

async function flushQueryEffects() {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
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
    vi.unstubAllGlobals();
    useSessionsStore.setState({ sessions: [] });
    useUiStore.getState().setActiveRepoPath(null);
    useUiStore.getState().setActiveWorkspaceId(null);
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
    expect(container.querySelector('.topic-room')).not.toBeNull();
    expect(container.textContent).toContain('Build UI shell');
    expect(container.textContent).toContain('task room');
    expect(container.textContent).toContain('primary action');
    expect(container.textContent).toContain('Thin-line topic detail');
    expect(container.textContent).toContain('Frontend lane');
    expect(container.textContent).toContain('preview');
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
    expect(btn.textContent).toBe('show archived');
    await act(async () => btn.click());
    expect(onToggleArchived).toHaveBeenCalled();
  });

  it('restores an archived topic from its detail panel', async () => {
    const onRestoreTopic = vi.fn();
    await renderView({
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
      onRestoreTopic,
    });
    expect(container.querySelector('.topic-row.archived')).not.toBeNull();
    const restore = container.querySelector(
      '.topic-detail__restore'
    ) as HTMLButtonElement;
    expect(restore).not.toBeNull();
    await act(async () => restore.click());
    expect(onRestoreTopic).toHaveBeenCalledWith('topic:old');
  });

  it('disables the restore button while its restore is in flight', async () => {
    const onRestoreTopic = vi.fn();
    await renderView({
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
      onRestoreTopic,
      restoringTopicId: 'topic:old',
    });
    const restore = container.querySelector(
      '.topic-detail__restore'
    ) as HTMLButtonElement;
    expect(restore.disabled).toBe(true);
    expect(restore.textContent).toContain('restoring');
    await act(async () => restore.click());
    expect(onRestoreTopic).not.toHaveBeenCalled();
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
    expect(container.textContent).toContain('no sessions linked yet');
    const primary = container.querySelector(
      '.topic-room__primary'
    ) as HTMLButtonElement;
    expect(primary.textContent).toBe('view artifact');
    expect(primary.disabled).toBe(false);
  });

  it('renders a task-room panel with grouped sessions, refs, and safe artifacts', async () => {
    await renderView({
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
          agentState: 'permission-prompt',
          permissionType: 'question',
        }),
        makeSession({
          id: 'approval-session',
          displayName: 'approval lane',
          agentState: 'permission-prompt',
          permissionType: 'approval',
        }),
        makeSession({
          id: 'running-session',
          displayName: 'running lane',
          agentState: 'processing',
        }),
        makeSession({
          id: 'idle-session',
          displayName: 'idle lane',
          agentState: 'idle',
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
          agentState: 'error',
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

  it('keeps stale sessions inspectable while disabling live room controls', async () => {
    await renderView({
      sessions: [
        makeSession({
          id: 's1',
          displayName: 'offline approval',
          agentState: 'permission-prompt',
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
      sessions: [
        makeSession({
          id: 's1',
          displayName: 'readable lane',
          agentState: 'idle',
          controlFreshness: undefined,
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
    await renderView({ surfaces: [], surfacesError: true });

    expect(container.textContent).toContain('Frontend lane');
    expect(container.textContent).toContain('surfaces unavailable');
  });

  it('keeps the room usable while surfaces are still loading', async () => {
    await renderView({ surfaces: [], surfacesLoading: true });

    expect(container.textContent).not.toContain('loading topic shell');
    expect(container.querySelector('.topic-room')).not.toBeNull();
    expect(container.textContent).toContain('Frontend lane');
    expect(container.textContent).toContain('surfaces loading…');
  });

  it('keeps the shell room mounted while surfaces query is still pending', async () => {
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
    expect(container.querySelector('.topic-room')).not.toBeNull();
    expect(container.textContent).toContain('Build UI shell');
    expect(container.textContent).toContain('surfaces loading…');
    queryClient.clear();
  });

  it('reports loading, error, and empty states', async () => {
    await renderView({ loading: true, topics: [] });
    expect(container.textContent).toContain('loading topic shell');

    await renderView({ loading: false, error: true, topics: [] });
    expect(container.textContent).toContain('topic shell unavailable');

    await renderView({ loading: false, error: false, topics: [] });
    expect(container.textContent).toContain('no workspace topics yet');
  });

  it('surfaces task-room creation entrypoints and preview panel', async () => {
    const onCreateTaskRoom = vi.fn();
    await renderView({
      createPanel: React.createElement(
        'form',
        { className: 'topic-create-panel', 'aria-label': 'create task room' },
        React.createElement(
          'div',
          { className: 'topic-create-preview' },
          'provider: hermes'
        ),
        React.createElement('button', { type: 'button' }, 'create only'),
        React.createElement('button', { type: 'button' }, 'create + launch')
      ),
      onCreateTaskRoom,
    });

    const createButton = container.querySelector(
      '.topic-shell__create'
    ) as HTMLButtonElement;
    await act(async () => createButton.click());

    expect(onCreateTaskRoom).toHaveBeenCalled();
    expect(container.textContent).toContain('provider: hermes');
    expect(container.textContent).toContain('create only');
    expect(container.textContent).toContain('create + launch');
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

  it('bounds mobile topic latest status from raw activity text', async () => {
    const longToolName = 'tool-name-'.repeat(30);
    await renderView({
      topics: [
        makeTopic({
          linkedRefs: { sessionIds: ['waiting-session'] },
        }),
      ],
      sessions: [
        makeSession({
          id: 'waiting-session',
          displayName: 'waiting lane',
          agentState: 'waiting-for-input',
          currentActivity: { tool: longToolName },
        }),
      ],
      surfaces: [],
    });

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
    expect(container.textContent).toContain('use / search for topic history');
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

  it('offers explicit approve and deny presets before audited mobile approval send', async () => {
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
    await renderView({
      topics: [makeTopic({ linkedRefs: { sessionIds: ['global:agent-1'] } })],
      sessions: [
        makeSession({
          id: 'local-session',
          globalSessionId: 'global:agent-1',
          displayName: 'global approval',
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
    await act(async () => form.requestSubmit());

    expect(onSelectSession).not.toHaveBeenCalled();
    expect(onSendInput).toHaveBeenCalledWith('local-session', 'y\r', undefined);
  });

  it('disables disconnected mobile controls before submit', async () => {
    const onSendInput = vi.fn().mockResolvedValue({ ok: true });
    await renderView({
      sessions: [
        makeSession({
          id: 's1',
          displayName: 'offline approval',
          agentState: 'permission-prompt',
          permissionType: 'approval',
          controlFreshness: 'fresh',
          status: 'disconnected',
        }),
      ],
      onSendInput,
    });

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
    await renderView({
      sessions: [
        makeSession({
          id: 's1',
          displayName: 'offline idle session',
          agentState: 'idle',
          idle: true,
          status: 'disconnected',
          controlFreshness: 'fresh',
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
    });

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

  it('keeps permission/question mobile input fail-closed when control freshness is omitted', async () => {
    const onSendInput = vi.fn().mockResolvedValue({ ok: true });
    await renderView({
      sessions: [
        makeSession({
          id: 's1',
          displayName: 'approval awaiting freshness',
          agentState: 'permission-prompt',
          permissionType: 'approval',
          status: 'active',
        }),
      ],
      onSendInput,
    });

    expect(container.querySelector('.topic-mobile-row')?.textContent).toContain(
      'approve'
    );
    expect(container.textContent).toContain(
      'controls disabled: unknown control state'
    );

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

    expect(input.disabled).toBe(true);
    expect(submit.disabled).toBe(true);
    expect(submit.title).toContain('unknown control state');
    expect(presets.map((preset) => preset.disabled)).toEqual([true, true]);
    expect(resume.disabled).toBe(false);
    expect(resume.title).toContain('open the linked Relay tab');
    expect(terminal.disabled).toBe(false);

    await act(async () => terminal.click());
    expect(onSelectSession).toHaveBeenCalledWith('s1');
    expect(onSendInput).not.toHaveBeenCalled();

    vi.clearAllMocks();
    await renderView({
      sessions: [
        makeSession({
          id: 's1',
          displayName: 'question awaiting freshness',
          agentState: 'permission-prompt',
          permissionType: 'question',
          status: 'active',
        }),
      ],
      onSendInput,
    });

    expect(container.querySelector('.topic-mobile-row')?.textContent).toContain(
      'reply'
    );
    expect(container.textContent).toContain(
      'controls disabled: unknown control state'
    );

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

    expect(questionInput.disabled).toBe(true);
    expect(questionSubmit.disabled).toBe(true);
    expect(
      container.querySelectorAll('.topic-mobile-control__preset')
    ).toHaveLength(0);
    expect(questionTerminal.disabled).toBe(false);

    await act(async () => questionTerminal.click());
    expect(onSelectSession).toHaveBeenCalledWith('s1');
    expect(onSendInput).not.toHaveBeenCalled();
  });

  it('keeps mobile resume enabled when only live input control state is unsafe', async () => {
    const onSendInput = vi.fn().mockResolvedValue({ ok: true });
    await renderView({
      sessions: [
        makeSession({
          id: 's1',
          displayName: 'live Hermes pty session',
          status: 'active',
          controlFreshness: 'unknown',
        }),
      ],
      onSendInput,
    });

    expect(container.querySelector('.topic-mobile-row')?.textContent).toContain(
      'resume'
    );
    expect(container.textContent).toContain(
      'controls disabled: unknown control state'
    );

    const input = container.querySelector(
      '.topic-mobile-control input'
    ) as HTMLInputElement;
    const submit = container.querySelector(
      '.topic-mobile-control__primary'
    ) as HTMLButtonElement;
    const buttons = Array.from(
      container.querySelectorAll('.topic-mobile-actions button')
    ) as HTMLButtonElement[];
    const resume = buttons.find(
      (button) => button.textContent === 'resume topic'
    ) as HTMLButtonElement;
    const terminal = buttons.find(
      (button) => button.textContent === 'open terminal tab'
    ) as HTMLButtonElement;

    expect(input.disabled).toBe(true);
    expect(submit.disabled).toBe(true);
    expect(resume.disabled).toBe(false);
    expect(resume.title).toContain('open the linked Relay tab');
    expect(terminal.disabled).toBe(false);

    await act(async () => terminal.click());
    expect(onSelectSession).toHaveBeenCalledWith('s1');
    expect(onSendInput).not.toHaveBeenCalled();
  });

  it('keeps web session input disabled while allowing mobile tab resume', async () => {
    await renderView({
      sessions: [
        makeSession({
          id: 's1',
          displayName: 'fresh Hermes web session',
          mode: 'web',
          status: 'active',
          controlFreshness: 'fresh',
        }),
      ],
    });

    expect(container.querySelector('.topic-mobile-row')?.textContent).toContain(
      'resume'
    );
    expect(container.textContent).toContain(
      'controls disabled: web session input is unsupported here'
    );

    const resume = Array.from(
      container.querySelectorAll('.topic-mobile-actions button')
    ).find(
      (button) => button.textContent === 'resume topic'
    ) as HTMLButtonElement;
    expect(resume.disabled).toBe(false);
    await act(async () => resume.click());
    expect(onSelectSession).toHaveBeenCalledWith('s1');
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

  it('renders participant roster cards grouped by role/runtime and opens exact existing sessions', async () => {
    await renderView({
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
          agent: 'claude',
          activeWorker: { kind: 'agent', displayName: 'ika-frontend' },
          agentState: 'processing',
          currentActivity: {
            tool: 'edit',
            detail: 'wiring participant roster',
          },
          controlMode: 'agent-driven',
          lastActivity: '2026-06-25T23:44:00Z',
        }),
        makeSession({
          id: 'kame-local',
          globalSessionId: 'global:kame',
          displayName: 'Kame QA',
          agent: 'codex',
          activeWorker: { kind: 'agent', displayName: 'kame-qa' },
          status: 'disconnected',
          controlMode: 'human-driven',
          lastActivity: '2026-06-24T12:00:00Z',
        }),
      ],
      surfaces: [],
    });

    const roster = container.querySelector('.topic-participants');
    expect(roster?.textContent).toContain('participants');
    expect(roster?.textContent).toContain('frontend · claude');
    expect(roster?.textContent).toContain('qa · codex');
    expect(roster?.textContent).toContain('last 25-06-26');
    expect(roster?.textContent).toContain('agent-driven');
    expect(roster?.textContent).toContain('wiring participant roster');
    expect(roster?.textContent).toContain('running');
    expect(roster?.textContent).toContain('offline');

    const childRows = Array.from(
      container.querySelectorAll('.topic-child-row')
    );
    expect(childRows[0]?.textContent).toContain('agent · pty');
    expect(childRows[0]?.textContent).toContain('last 25-06-26');
    expect(childRows[0]?.textContent).toContain('agent-driven');
    expect(childRows[0]?.textContent).toContain('wiring participant roster');

    const ikaCard = Array.from(
      container.querySelectorAll('.topic-participant-card')
    ).find((card) =>
      card.textContent?.includes('Ika frontend')
    ) as HTMLButtonElement;
    await act(async () => ikaCard.click());
    expect(onSelectSession).toHaveBeenCalledWith('devbox:remote-ika');
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
