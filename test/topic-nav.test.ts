import { describe, expect, it } from 'vitest';
import type { WorkspaceSurface } from '../shared/workspace-surfaces.js';
import type { WorkspaceTopic } from '../shared/workspace-topics.js';
import { buildTopicNavModel } from '../frontend/src/lib/state/topic-nav.js';
import { makeSession } from './helpers/frontend-factories.js';

const NOW = '2026-06-26T00:00:00Z';

function makeTopic(overrides: Partial<WorkspaceTopic> = {}): WorkspaceTopic {
  return {
    schemaVersion: 1,
    id: 'topic:alpha',
    workspaceId: 'workspace:alpha',
    source: 'persisted',
    status: 'active',
    visibility: 'default',
    display: { title: 'Alpha topic' },
    grouping: {},
    promptDefaults: {},
    routingDefaults: {},
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

function makeSurface(
  overrides: Partial<WorkspaceSurface> = {}
): WorkspaceSurface {
  return {
    id: 'surface:preview',
    kind: 'preview',
    label: 'Preview server',
    nodeId: 'local',
    workspaceId: 'workspace:alpha',
    status: 'published',
    health: 'reachable',
    provenance: { source: 'agent-published' },
    openMode: 'direct',
    url: 'http://localhost:5173',
    ...overrides,
  };
}

describe('buildTopicNavModel', () => {
  it('sorts pinned topics first and nests child topics', () => {
    const parent = makeTopic({
      id: 'topic:parent',
      display: { title: 'Parent' },
      grouping: { order: 2 },
    });
    const child = makeTopic({
      id: 'topic:child',
      display: { title: 'Child' },
      grouping: { parentTopicId: 'topic:parent', order: 1 },
    });
    const pinned = makeTopic({
      id: 'topic:pinned',
      display: { title: 'Pinned' },
      state: { pinned: true, muted: false },
      grouping: { order: 99 },
    });

    const model = buildTopicNavModel({
      topics: [parent, child, pinned],
      sessions: [],
      surfaces: [],
    });

    expect(model.rootIds).toEqual(['topic:pinned', 'topic:parent']);
    expect(model.byId.get('topic:parent')?.childIds).toEqual(['topic:child']);
  });

  it('links sessions by explicit session refs and reports attention state', () => {
    const topic = makeTopic({
      linkedRefs: { sessionIds: ['global:agent-1'] },
    });
    const model = buildTopicNavModel({
      topics: [topic],
      sessions: [
        makeSession({
          id: 'local-session',
          globalSessionId: 'global:agent-1',
          displayName: 'Agent lane',
          agentState: 'permission-prompt',
          permissionType: 'question',
          nodeId: 'devbox',
          status: 'active',
        }),
      ],
      surfaces: [],
    });

    const item = model.byId.get('topic:alpha');
    expect(item?.tone).toBe('attention');
    expect(item?.statusLabel).toBe('needs input');
    expect(item?.sessions).toMatchObject([
      {
        id: 'local-session',
        label: 'Agent lane',
        selectKey: 'global:agent-1',
        nodeId: 'devbox',
        status: 'active',
      },
    ]);
  });

  it('links surfaces by workspace id without fabricating sessions', () => {
    const topic = makeTopic({ workspaceId: 'workspace:alpha' });
    const model = buildTopicNavModel({
      topics: [topic],
      sessions: [],
      surfaces: [makeSurface()],
      derived: true,
    });

    const item = model.byId.get('topic:alpha');
    expect(model.derived).toBe(true);
    expect(item?.tone).toBe('idle');
    expect(item?.sessions).toEqual([]);
    expect(item?.surfaces).toMatchObject([
      { id: 'surface:preview', label: 'Preview server', kind: 'preview' },
    ]);
  });

  it('classifies topic workspace kind from routing defaults', () => {
    const repo = makeTopic({
      id: 'topic:repo',
      routingDefaults: { repoPath: '/repo/relay' },
    });
    const folder = makeTopic({
      id: 'topic:folder',
      workspaceId: 'workspace:folder',
      routingDefaults: { cwd: '/tmp/scratch' },
    });
    const thread = makeTopic({
      id: 'topic:thread',
      workspaceId: 'workspace:thread',
    });

    const model = buildTopicNavModel({
      topics: [repo, folder, thread],
      sessions: [],
      surfaces: [],
    });

    expect(model.byId.get('topic:repo')).toMatchObject({
      kind: 'repo',
      kindLabel: 'git repo',
    });
    expect(model.byId.get('topic:folder')).toMatchObject({
      kind: 'folder',
      kindLabel: 'folder',
    });
    expect(model.byId.get('topic:thread')).toMatchObject({
      kind: 'thread',
      kindLabel: 'topic',
    });
  });

  it('uses kind semantics for topic badges instead of ordering numbers', () => {
    const repo = makeTopic({
      id: 'topic:repo',
      display: { title: 'Repo' },
      grouping: { order: 3 },
      routingDefaults: { repoPath: '/repo/relay' },
    });
    const folder = makeTopic({
      id: 'topic:folder',
      display: { title: 'Folder' },
      grouping: { order: 2 },
      routingDefaults: { cwd: '/tmp/scratch' },
    });
    const thread = makeTopic({
      id: 'topic:thread',
      display: { title: 'Thread' },
      grouping: { order: 1 },
    });

    const model = buildTopicNavModel({
      topics: [repo, folder, thread],
      sessions: [],
      surfaces: [],
    });

    expect(model.byId.get('topic:repo')?.kind).toBe('repo');
    expect(model.byId.get('topic:folder')?.kind).toBe('folder');
    expect(model.byId.get('topic:thread')?.kind).toBe('thread');
    for (const item of model.items) {
      expect(item).not.toHaveProperty('badgeText');
    }
  });

  it('keeps attention topics ahead of idle pinned topics', () => {
    const pinned = makeTopic({
      id: 'topic:pinned',
      display: { title: 'Pinned idle' },
      linkedRefs: { sessionIds: ['idle-session'] },
      state: { pinned: true, muted: false },
      grouping: { order: 1 },
    });
    const attention = makeTopic({
      id: 'topic:attention',
      display: { title: 'Needs input' },
      linkedRefs: { sessionIds: ['attention-session'] },
      grouping: { order: 99 },
    });

    const model = buildTopicNavModel({
      topics: [pinned, attention],
      sessions: [
        makeSession({ id: 'idle-session', idle: true, agentState: 'idle' }),
        makeSession({
          id: 'attention-session',
          agentState: 'permission-prompt',
          permissionType: 'approval',
        }),
      ],
      surfaces: [],
    });

    expect(model.rootIds).toEqual(['topic:attention', 'topic:pinned']);
    expect(model.byId.get('topic:attention')).toMatchObject({
      tone: 'attention',
      statusLabel: 'needs input',
    });
  });

  it('projects a participant roster with role, provider, runtime, and bounded status summary', () => {
    const topic = makeTopic({
      linkedRefs: { sessionIds: ['global:ika', 'global:kame'] },
    });
    const longSummary = `${'reviewing '.repeat(20)}approval prompt`;
    const model = buildTopicNavModel({
      topics: [topic],
      sessions: [
        makeSession({
          id: 'ika-local',
          globalSessionId: 'global:ika',
          displayName: 'Ika frontend lane',
          agent: 'claude',
          mode: 'pty',
          activeWorker: { kind: 'agent', displayName: 'ika-frontend' },
          agentState: 'processing',
          currentActivity: { tool: 'npm', detail: longSummary },
        }),
        makeSession({
          id: 'kame-local',
          globalSessionId: 'global:kame',
          displayName: 'Kame QA gate',
          agent: 'codex',
          mode: 'web',
          activeWorker: { kind: 'agent', displayName: 'kame-qa' },
          agentState: 'idle',
          idle: true,
        }),
      ],
      surfaces: [],
    });

    const item = model.byId.get('topic:alpha');
    expect(item?.participants).toMatchObject([
      {
        label: 'Ika frontend lane',
        roleLabel: 'frontend',
        providerLabel: 'claude',
        runtimeLabel: 'agent · pty',
        statusLabel: 'running',
        selectKey: 'global:ika',
      },
      {
        label: 'Kame QA gate',
        roleLabel: 'qa',
        providerLabel: 'codex',
        runtimeLabel: 'agent · web',
        statusLabel: 'idle',
        selectKey: 'global:kame',
      },
    ]);
    expect(item?.participants[0]?.summaryLabel?.length).toBeLessThanOrEqual(96);
  });

  it('aggregates room status in task-room priority order', () => {
    const model = buildTopicNavModel({
      topics: [
        makeTopic({
          id: 'topic:mixed',
          linkedRefs: { sessionIds: ['running', 'prompt'] },
        }),
        makeTopic({
          id: 'topic:blocker',
          linkedRefs: { sessionIds: ['offline'] },
        }),
      ],
      sessions: [
        makeSession({ id: 'running', agentState: 'processing' }),
        makeSession({
          id: 'prompt',
          agentState: 'waiting-for-input',
          currentActivity: { tool: 'question', detail: 'pick route' },
        }),
        makeSession({ id: 'offline', status: 'disconnected' }),
      ],
      surfaces: [],
    });

    expect(model.byId.get('topic:mixed')).toMatchObject({
      tone: 'attention',
      statusLabel: 'needs input',
    });
    expect(model.byId.get('topic:blocker')).toMatchObject({
      tone: 'error',
      statusLabel: 'blocked',
    });
  });

  it('marks stale/offline participants without losing exact selection keys', () => {
    const model = buildTopicNavModel({
      topics: [
        makeTopic({
          linkedRefs: {
            sessionIds: ['devbox:remote-session', 'stale-session'],
          },
        }),
      ],
      sessions: [
        makeSession({
          id: 'remote-session',
          nodeId: 'devbox',
          displayName: 'remote lane',
          status: 'disconnected',
        }),
        makeSession({
          id: 'stale-session',
          displayName: 'stale lane',
          controlFreshness: 'stale',
          controlReason: 'node heartbeat expired',
        }),
      ],
      surfaces: [],
    });

    const participants = model.byId.get('topic:alpha')?.participants ?? [];
    expect(participants).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: 'remote lane',
          statusLabel: 'offline',
          selectKey: 'devbox:remote-session',
        }),
        expect.objectContaining({
          label: 'stale lane',
          statusLabel: 'stale',
          controlLabel: 'control stale',
        }),
      ])
    );
  });

  it('breaks cyclic parent links into roots instead of recursive children', () => {
    const a = makeTopic({
      id: 'topic:a',
      display: { title: 'A' },
      grouping: { parentTopicId: 'topic:b' },
    });
    const b = makeTopic({
      id: 'topic:b',
      display: { title: 'B' },
      grouping: { parentTopicId: 'topic:a' },
    });
    const self = makeTopic({
      id: 'topic:self',
      display: { title: 'Self' },
      grouping: { parentTopicId: 'topic:self' },
    });

    const model = buildTopicNavModel({
      topics: [a, b, self],
      sessions: [],
      surfaces: [],
    });

    expect(model.rootIds.sort()).toEqual(['topic:a', 'topic:b', 'topic:self']);
    expect(model.byId.get('topic:a')?.childIds).toEqual([]);
    expect(model.byId.get('topic:b')?.childIds).toEqual([]);
    expect(model.byId.get('topic:self')?.childIds).toEqual([]);
  });
});
