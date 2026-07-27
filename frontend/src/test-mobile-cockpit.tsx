import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { WorkspaceTopic } from '../../shared/workspace-topics.js';
import './App.css';
import { TopicSidebarView } from './components/TopicSidebarShell.js';
import { dmChannelTopicId } from './lib/dm-channels.js';
import {
  channelAgentStatusKey,
  useChannelAgentStatusStore,
} from './lib/stores/channel-agent-status.js';
import { useChannelActivityStore } from './lib/stores/channel-activity.js';
import { useUiStore } from './lib/stores/ui.js';
import type { SessionSummary } from './lib/types.js';

const WORKSPACE_ID = 'workspace:cockpit-smoke';
const BLOCKED_ID = 'topic:cockpit-blocked';
const GENERAL_ID = 'topic:cockpit-general';
const WORKING_ID = 'topic:cockpit-working';
const WAITING_ID = 'topic:cockpit-waiting';
const RECONCILED_ID = 'topic:cockpit-reconciled';
const PENDING_ID = 'topic:cockpit-pending-inbox';
const IDLE_ID = 'topic:cockpit-idle';
const UNKNOWN_ID = 'topic:cockpit-unknown';
const CLAUDE_DM_ID = dmChannelTopicId('claude', WORKSPACE_ID);
const NOW = '2026-07-19T12:00:00.000Z';

function topic(input: {
  id: string;
  title: string;
  sessionId?: string;
  providerId?: string;
  updatedAt?: string;
}): WorkspaceTopic {
  return {
    schemaVersion: 1,
    id: input.id,
    workspaceId: WORKSPACE_ID,
    source: 'persisted',
    status: 'active',
    visibility: 'default',
    display: {
      title: input.title,
      description: `Synthetic mobile cockpit fixture for ${input.title}`,
      kind: 'topic',
    },
    grouping: {},
    promptDefaults: {},
    routingDefaults: {
      repoPath: `/workspace/cockpit/${input.id}`,
      ...(input.providerId ? { providerId: input.providerId } : {}),
    },
    linkedRefs: input.sessionId ? { sessionIds: [input.sessionId] } : {},
    state: { pinned: false, muted: false },
    privacy: {
      classification: 'internal',
      retention: 'project',
      redaction: 'summary',
      rawDefaultsStored: false,
    },
    createdAt: NOW,
    updatedAt: input.updatedAt ?? NOW,
  };
}

function session(
  id: string,
  activityState: SessionSummary['activityState'],
  overrides: Partial<SessionSummary> = {}
): SessionSummary {
  return {
    id,
    type: 'terminal',
    mode: 'pty',
    repoName: 'relay-ide',
    repoPath: `/workspace/cockpit/${id}`,
    cwd: `/workspace/cockpit/${id}`,
    displayName: `${id} terminal`,
    createdAt: NOW,
    lastActivity: NOW,
    idle: activityState === 'idle',
    status: 'active',
    activityState,
    currentActivity:
      activityState === 'processing'
        ? { tool: 'edit', detail: 'TopicSidebarShell.tsx' }
        : undefined,
    ...overrides,
  };
}

const topics: WorkspaceTopic[] = [
  topic({ id: BLOCKED_ID, title: 'blocked approval', sessionId: 's-blocked' }),
  topic({ id: GENERAL_ID, title: 'general', sessionId: 's-general' }),
  topic({
    id: CLAUDE_DM_ID,
    title: 'Claude',
    sessionId: 's-dm',
    providerId: 'claude',
  }),
  topic({ id: WORKING_ID, title: 'mobile cockpit', sessionId: 's-working' }),
  topic({ id: WAITING_ID, title: 'waiting agent', sessionId: 's-waiting' }),
  topic({
    id: RECONCILED_ID,
    title: 'reconciled idle',
    sessionId: 's-reconciled',
  }),
  topic({ id: PENDING_ID, title: 'pending inbox', sessionId: 's-pending' }),
  topic({ id: IDLE_ID, title: 'seen idle', sessionId: 's-idle' }),
  topic({ id: UNKNOWN_ID, title: 'unknown signal' }),
];

const sessions: SessionSummary[] = [
  session('s-blocked', 'permission-prompt', {
    permissionType: 'approval',
    currentActivity: { tool: 'approval', detail: 'allow guarded command' },
  }),
  session('s-general', 'idle'),
  session('s-dm', 'idle'),
  session('s-working', 'processing'),
  session('s-waiting', 'processing', {
    currentActivity: { tool: 'awaiting', detail: 'operator direction' },
  }),
  session('s-reconciled', 'idle'),
  session('s-pending', 'idle'),
  session('s-idle', 'idle'),
];

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false } },
});
const rosterStatusByChannel = {
  [BLOCKED_ID]: 'waiting',
  [WORKING_ID]: 'streaming',
  [WAITING_ID]: 'waiting',
  [IDLE_ID]: 'idle',
} as const;
for (const fixtureTopic of topics) {
  const status =
    rosterStatusByChannel[
      fixtureTopic.id as keyof typeof rosterStatusByChannel
    ];
  queryClient.setQueryData(
    ['channel-roster', fixtureTopic.id],
    status
      ? [
          {
            id: 'claude',
            displayName: 'Claude',
            kind: 'framework',
            available: true,
            reason: null,
            binding: { runtimeId: `roster:${fixtureTopic.id}`, status },
          },
        ]
      : []
  );
}
useUiStore.getState().setAdvancedMode(false);
useUiStore.setState({
  activeChannelId: null,
  activeRepoPath: null,
  activeWorkspaceId: WORKSPACE_ID,
  sidebarOpen: true,
});
useChannelActivityStore.setState({
  latestSeqByChannel: {
    [GENERAL_ID]: 8,
    [CLAUDE_DM_ID]: 5,
  },
  lastReadByChannel: {
    [GENERAL_ID]: 2,
    [CLAUDE_DM_ID]: 1,
  },
});
useChannelAgentStatusStore.setState({
  statusByChannelAgent: {
    [channelAgentStatusKey(BLOCKED_ID, 'claude')]: 'waiting',
    [channelAgentStatusKey(WORKING_ID, 'claude')]: 'streaming',
    [channelAgentStatusKey(WAITING_ID, 'claude')]: 'waiting',
    [channelAgentStatusKey(RECONCILED_ID, 'claude')]: 'waiting',
    [channelAgentStatusKey(IDLE_ID, 'claude')]: 'idle',
  },
  runtimeByChannelAgent: {
    [channelAgentStatusKey(BLOCKED_ID, 'claude')]: 's-blocked',
    [channelAgentStatusKey(WORKING_ID, 'claude')]: 's-working',
    [channelAgentStatusKey(WAITING_ID, 'claude')]: 's-waiting',
    [channelAgentStatusKey(RECONCILED_ID, 'claude')]: 's-reconciled',
    [channelAgentStatusKey(IDLE_ID, 'claude')]: 's-idle',
  },
  updatedAtByChannelAgent: {
    [channelAgentStatusKey(BLOCKED_ID, 'claude')]: Date.now(),
    [channelAgentStatusKey(WORKING_ID, 'claude')]: Date.now(),
    [channelAgentStatusKey(WAITING_ID, 'claude')]: Date.now(),
    // Deterministically older than the query-cache roster snapshot above. The
    // fresh unbound roster must clear this stale waiting socket signal.
    [channelAgentStatusKey(RECONCILED_ID, 'claude')]: 1,
    [channelAgentStatusKey(IDLE_ID, 'claude')]: Date.now(),
  },
});

function Fixture(): React.ReactElement {
  return (
    <QueryClientProvider client={queryClient}>
      <main style={{ height: '100%', background: 'var(--bg)' }}>
        <TopicSidebarView
          topics={topics}
          sessions={sessions}
          surfaces={[]}
          workspaces={[
            {
              id: WORKSPACE_ID,
              name: 'Relay workspace',
              order: 0,
              pinned: true,
              color: null,
              icon: null,
            },
          ]}
          onSelectSession={() => {}}
        />
      </main>
    </QueryClientProvider>
  );
}

ReactDOM.createRoot(document.getElementById('app')!).render(<Fixture />);
