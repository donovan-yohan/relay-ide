import React, { useRef } from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { WorkspaceTopic } from '../../shared/workspace-topics.js';
import './App.css';
import { Sidebar } from './components/Sidebar.js';
import SettingsDialog, {
  type SettingsDialogHandle,
} from './components/dialogs/SettingsDialog.js';
import AddWorkspaceDialog, {
  type AddWorkspaceDialogHandle,
} from './components/dialogs/AddWorkspaceDialog.js';
import { dmChannelTopicId } from './lib/dm-channels.js';
import { useChannelActivityStore } from './lib/stores/channel-activity.js';
import { useSessionsStore } from './lib/stores/sessions.js';
import { useUiStore } from './lib/stores/ui.js';

const nativeFetch = window.fetch.bind(window);
const fileBrowserEntries = [
  {
    name: 'project-parent',
    path: '/workspace/project-parent',
    isGitRepo: false,
    hasChildren: true,
  },
  ...Array.from({ length: 48 }, (_, index) => ({
    name: `project-${String(index + 1).padStart(2, '0')}`,
    path: `/workspace/project-${String(index + 1).padStart(2, '0')}`,
    isGitRepo: false,
    hasChildren: false,
  })),
];
const fileBrowserChildren = [
  {
    name: 'child-project',
    path: '/workspace/project-parent/child-project',
    isGitRepo: false,
    hasChildren: false,
  },
];

/** Keep the production Add Project dialog deterministic in this browser fixture. */
window.fetch = (input, init) => {
  const url = new URL(
    typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.href
        : input.url,
    window.location.href
  );
  if (url.pathname === '/nodes') {
    return Promise.resolve(
      new Response(JSON.stringify({ nodes: [] }), {
        headers: { 'Content-Type': 'application/json' },
      })
    );
  }
  if (url.pathname === '/workspaces/browse') {
    const entries =
      url.searchParams.get('path') === '/workspace/project-parent'
        ? fileBrowserChildren
        : fileBrowserEntries;
    return Promise.resolve(
      new Response(
        JSON.stringify({
          resolved:
            url.searchParams.get('path') === '/workspace/project-parent'
              ? '/workspace/project-parent'
              : '/workspace',
          entries,
          truncated: false,
          total: entries.length,
        }),
        { headers: { 'Content-Type': 'application/json' } }
      )
    );
  }
  return nativeFetch(input, init);
};

const CHANNEL_ID = 'topic:sidebar-smoke';
const WORKSPACE_ID = 'workspace:sidebar-smoke';
const SECOND_CHANNEL_ID = 'topic:sidebar-research';
const SECOND_WORKSPACE_ID = 'workspace:sidebar-research';
const CHILD_CHANNEL_ID = 'topic:sidebar-smoke-child';
const ORPHAN_CHANNEL_ID = 'topic:sidebar-orphan';
const ORPHAN_WORKSPACE_ID = 'workspace:sidebar-missing';
const CLAUDE_DM_ID = dmChannelTopicId('claude', WORKSPACE_ID);
const CODEX_DM_ID = dmChannelTopicId('codex', SECOND_WORKSPACE_ID);
const ORPHAN_DM_ID = dmChannelTopicId('hermes', ORPHAN_WORKSPACE_ID);
const WORK_CONTEXT_ID = 'wc:sidebar-smoke';
const NOW = '2026-07-19T00:00:00.000Z';

const topic: WorkspaceTopic = {
  schemaVersion: 1,
  id: CHANNEL_ID,
  workspaceId: WORKSPACE_ID,
  source: 'persisted',
  status: 'active',
  visibility: 'default',
  display: {
    title: 'engineering',
    description: 'Synthetic sidebar smoke channel',
    kind: 'topic',
  },
  grouping: {},
  promptDefaults: {},
  routingDefaults: { repoPath: '/workspace/example' },
  linkedRefs: {
    workContextIds: [WORK_CONTEXT_ID],
    taskRefs: [{ kind: 'github-issue', id: '1194', title: 'sidebar smoke' }],
  },
  state: { pinned: false, muted: false },
  privacy: {
    classification: 'internal',
    retention: 'project',
    redaction: 'summary',
    rawDefaultsStored: false,
  },
  createdAt: NOW,
  updatedAt: NOW,
};

function siblingTopic(input: {
  id: string;
  workspaceId: string;
  title: string;
  providerId?: string;
  parentId?: string;
}): WorkspaceTopic {
  return {
    ...topic,
    id: input.id,
    workspaceId: input.workspaceId,
    display: { title: input.title, kind: 'topic' },
    grouping: input.parentId ? { parentTopicId: input.parentId } : {},
    routingDefaults: {
      repoPath:
        input.workspaceId === WORKSPACE_ID
          ? '/workspace/example'
          : '/workspace/research',
      ...(input.providerId ? { providerId: input.providerId } : {}),
    },
    linkedRefs: {},
  };
}

const topics = [
  topic,
  siblingTopic({
    id: CLAUDE_DM_ID,
    workspaceId: WORKSPACE_ID,
    title: 'Claude',
    providerId: 'claude',
  }),
  siblingTopic({
    id: SECOND_CHANNEL_ID,
    workspaceId: SECOND_WORKSPACE_ID,
    title: 'research',
  }),
  siblingTopic({
    id: CODEX_DM_ID,
    workspaceId: SECOND_WORKSPACE_ID,
    title: 'Codex',
    providerId: 'codex',
  }),
  siblingTopic({
    id: CHILD_CHANNEL_ID,
    workspaceId: WORKSPACE_ID,
    title: 'engineering child',
    parentId: CHANNEL_ID,
  }),
  siblingTopic({
    id: ORPHAN_CHANNEL_ID,
    workspaceId: ORPHAN_WORKSPACE_ID,
    title: 'orphan channel',
  }),
  siblingTopic({
    id: ORPHAN_DM_ID,
    workspaceId: ORPHAN_WORKSPACE_ID,
    title: 'Hermes',
    providerId: 'hermes',
  }),
];

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false } },
});
queryClient.setQueryData(['workspace-topics'], {
  topics,
  truncated: false,
  derived: false,
});
queryClient.setQueryData(
  ['ia-workspaces'],
  [
    {
      id: WORKSPACE_ID,
      name: 'Relay workspace',
      status: 'active',
      order: 0,
      projectIds: [],
      pinned: true,
      color: null,
      icon: null,
      defaultRepoPath: '/workspace/example',
      defaultNodeId: null,
      defaultProvider: null,
      createdAt: NOW,
      updatedAt: NOW,
    },
    {
      id: SECOND_WORKSPACE_ID,
      name: 'Research workspace',
      status: 'active',
      order: 1,
      projectIds: [],
      pinned: false,
      color: null,
      icon: null,
      defaultRepoPath: '/workspace/research',
      defaultNodeId: null,
      defaultProvider: null,
      createdAt: NOW,
      updatedAt: NOW,
    },
  ]
);
queryClient.setQueryData(['workspace-surfaces', 'topic-shell'], []);
queryClient.setQueryData(['hub-nodes'], []);
queryClient.setQueryData(['workflow-runs', WORK_CONTEXT_ID, 5], []);

useUiStore.getState().setAdvancedMode(false);
useUiStore.setState({
  activeChannelId: null,
  activeRepoPath: null,
  activeWorkspaceId: null,
  analyticsView: null,
  repoDashboardTabIntent: null,
  sidebarCollapsed: false,
  sidebarOpen: true,
});
useSessionsStore.setState({ sessions: [], activeSessionId: null });
useChannelActivityStore.setState({
  latestSeqByChannel: {},
  lastReadByChannel: {},
});

function Fixture(): React.ReactElement {
  const settingsRef = useRef<SettingsDialogHandle>(null);
  const addWorkspaceRef = useRef<AddWorkspaceDialogHandle>(null);
  const activeChannelId = useUiStore((state) => state.activeChannelId);
  const activeRepoPath = useUiStore((state) => state.activeRepoPath);
  const dashboardTabIntent = useUiStore(
    (state) => state.repoDashboardTabIntent
  );

  return (
    <QueryClientProvider client={queryClient}>
      <main style={{ display: 'flex', height: '100%' }}>
        <Sidebar
          onSelectSession={() => {}}
          onOpenSettings={() => settingsRef.current?.open('section-advanced')}
          onNewWorktree={() => {}}
          onAddWorkspace={() => {}}
          onOpenAnalytics={() => {}}
        />
        <section
          aria-label="sidebar smoke controls"
          style={{ padding: 16, flex: 1 }}
        >
          <button
            type="button"
            data-testid="emit-unread"
            onClick={() => {
              useUiStore.getState().setActiveChannelId(null);
              useChannelActivityStore.getState().recordActivity(CHANNEL_ID, 2);
              useChannelActivityStore.getState().recordActivity(CODEX_DM_ID, 3);
            }}
          >
            emit unread activity
          </button>
          <button
            type="button"
            data-testid="open-add-project"
            onClick={() => addWorkspaceRef.current?.open()}
          >
            open add project
          </button>
          <button
            type="button"
            data-testid="open-settings-top"
            aria-label="open top dialog"
            onClick={() => settingsRef.current?.open()}
          >
            open settings at top
          </button>
          <output data-testid="active-channel">
            {activeChannelId ?? 'none'}
          </output>
          <output data-testid="evidence-route">
            {activeRepoPath ?? 'none'}:{dashboardTabIntent?.tab ?? 'none'}
          </output>
          {activeChannelId ? (
            <section
              aria-label="channel timeline"
              data-testid="channel-timeline"
            >
              channel timeline: {activeChannelId}
            </section>
          ) : null}
        </section>
      </main>
      <SettingsDialog ref={settingsRef} />
      <AddWorkspaceDialog ref={addWorkspaceRef} onWorkspacesAdded={() => {}} />
    </QueryClientProvider>
  );
}

ReactDOM.createRoot(document.getElementById('app')!).render(<Fixture />);
