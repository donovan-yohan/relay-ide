import { describe, expect, it } from 'vitest';
import type { WorkspaceSurface } from '../shared/workspace-surfaces.js';
import type { WorkspaceTopic } from '../shared/workspace-topics.js';
import {
  buildTopicNavModel,
  formatTaskRefLabel,
  indexChannelSummaries,
  selectChannelRailTree,
  type ChannelRailSummary,
  type TopicNavWorkspace,
} from '../frontend/src/lib/state/topic-nav.js';
import { dmChannelTopicId } from '../frontend/src/lib/dm-channels.js';
import { makeSession } from './helpers/frontend-factories.js';

function makeWorkspace(
  overrides: Partial<TopicNavWorkspace> = {}
): TopicNavWorkspace {
  return {
    id: 'ws:a',
    name: 'workspace a',
    order: 0,
    pinned: false,
    color: null,
    icon: null,
    ...overrides,
  };
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
          activityState: 'permission-prompt',
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

  it('does not borrow same-repo sessions across explicitly linked chat topics', () => {
    const firstTopic = makeTopic({
      id: 'topic:first',
      display: { title: 'First chat' },
      routingDefaults: { repoPath: '/repo/relay' },
      linkedRefs: { workContextIds: ['wc:first'] },
    });
    const secondTopic = makeTopic({
      id: 'topic:second',
      display: { title: 'Second chat' },
      routingDefaults: { repoPath: '/repo/relay' },
      linkedRefs: { workContextIds: ['wc:second'] },
    });

    const model = buildTopicNavModel({
      topics: [firstTopic, secondTopic],
      sessions: [
        makeSession({
          id: 'agent-1',
          displayName: 'Agent 1',
          repoPath: '/repo/relay',
          cwd: '/repo/relay',
          workContextId: 'wc:first',
        }),
        makeSession({
          id: 'agent-2',
          displayName: 'Agent 2',
          repoPath: '/repo/relay',
          cwd: '/repo/relay',
          workContextId: 'wc:second',
        }),
      ],
      surfaces: [],
    });

    expect(model.byId.get('topic:first')?.participants).toMatchObject([
      { sessionId: 'agent-1', label: 'Agent 1' },
    ]);
    expect(model.byId.get('topic:second')?.participants).toMatchObject([
      { sessionId: 'agent-2', label: 'Agent 2' },
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

  it('preserves artifact refs for topic-room metadata without loading payloads', () => {
    const topic = makeTopic({
      linkedRefs: { artifactIds: ['artifact:evidence-1'] },
    });
    const model = buildTopicNavModel({
      topics: [topic],
      sessions: [],
      surfaces: [],
    });

    expect(model.byId.get('topic:alpha')?.artifactIds).toEqual([
      'artifact:evidence-1',
    ]);
  });

  it('preserves WorkContext refs for topic-room orchestration reads', () => {
    const topic = makeTopic({
      linkedRefs: { workContextIds: ['wc:relay'] },
    });
    const model = buildTopicNavModel({
      topics: [topic],
      sessions: [],
      surfaces: [],
    });

    expect(model.byId.get('topic:alpha')?.workContextIds).toEqual(['wc:relay']);
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
        makeSession({ id: 'idle-session', idle: true, activityState: 'idle' }),
        makeSession({
          id: 'attention-session',
          activityState: 'permission-prompt',
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
          mode: 'pty',
          activityState: 'processing',
          currentActivity: { tool: 'npm', detail: longSummary },
        }),
        makeSession({
          id: 'kame-local',
          globalSessionId: 'global:kame',
          displayName: 'Kame QA gate',
          mode: 'pty',
          activityState: 'idle',
          idle: true,
        }),
      ],
      surfaces: [],
    });

    const item = model.byId.get('topic:alpha');
    expect(item?.participants).toMatchObject([
      {
        label: 'Kame QA gate',
        roleLabel: 'terminal',
        providerLabel: 'idle',
        runtimeLabel: 'terminal · pty',
        statusLabel: 'idle',
        selectKey: 'global:kame',
      },
      {
        label: 'Ika frontend lane',
        roleLabel: 'terminal',
        providerLabel: 'running',
        runtimeLabel: 'terminal · pty',
        statusLabel: 'running',
        selectKey: 'global:ika',
      },
    ]);
    expect(
      item?.participants.find(
        (participant) => participant.selectKey === 'global:ika'
      )?.summaryLabel?.length
    ).toBeLessThanOrEqual(96);
  });

  it('bounds participant attention summaries when only tool names are available', () => {
    const topic = makeTopic({
      linkedRefs: { sessionIds: ['approval', 'question'] },
    });
    const longToolName = 'tool-name-'.repeat(30);
    const model = buildTopicNavModel({
      topics: [topic],
      sessions: [
        makeSession({
          id: 'approval',
          activityState: 'permission-prompt',
          permissionType: 'approval',
          currentActivity: { tool: longToolName },
        }),
        makeSession({
          id: 'question',
          activityState: 'waiting-for-input',
          currentActivity: { tool: longToolName },
        }),
      ],
      surfaces: [],
    });

    const participants = model.byId.get('topic:alpha')?.participants ?? [];
    expect(participants).toHaveLength(2);
    for (const participant of participants) {
      expect(participant.summaryLabel?.length).toBeLessThanOrEqual(96);
      expect(participant.summaryLabel).toBe(`${longToolName.slice(0, 93)}...`);
    }
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
        makeSession({ id: 'running', activityState: 'processing' }),
        makeSession({
          id: 'prompt',
          activityState: 'waiting-for-input',
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

  it('marks offline participants without losing exact selection keys', () => {
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
          displayName: 'second offline lane',
          status: 'disconnected',
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
          label: 'second offline lane',
          statusLabel: 'offline',
          selectKey: 'stale-session',
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

  // #1061: raw substrate node ids (e.g. `node_<random token>`) must never
  // leak into nav-model fields consumers render directly — only a resolved
  // friendly name (or `null`, which callers must omit) is exposed.
  const RAW_NODE_ID = 'node_AbCdEfGh12345678IjKlMnOpQrStUvWx';

  it('resolves session/participant node ids to friendly names from the node roster', () => {
    const model = buildTopicNavModel({
      topics: [
        makeTopic({
          routingDefaults: { nodeId: RAW_NODE_ID },
          linkedRefs: { sessionIds: [`${RAW_NODE_ID}:s1`] },
        }),
      ],
      sessions: [
        makeSession({
          id: 's1',
          nodeId: RAW_NODE_ID,
          displayName: 'remote lane',
        }),
      ],
      surfaces: [],
      nodes: [{ nodeId: RAW_NODE_ID, displayName: 'Ops Box' }],
    });

    const item = model.byId.get('topic:alpha');
    expect(item?.sessions[0]).toMatchObject({
      nodeId: RAW_NODE_ID,
      nodeLabel: 'Ops Box',
    });
    expect(item?.participants[0]).toMatchObject({
      nodeId: RAW_NODE_ID,
      nodeLabel: 'Ops Box',
    });
    expect(item?.routingLabel).toContain('Ops Box');
    expect(item?.routingLabel).not.toContain(RAW_NODE_ID);
  });

  it('leaves nodeLabel null for an unresolved/unpaired node id instead of falling back to the raw id', () => {
    const model = buildTopicNavModel({
      topics: [
        makeTopic({
          routingDefaults: { nodeId: RAW_NODE_ID },
          linkedRefs: { sessionIds: [`${RAW_NODE_ID}:s1`] },
        }),
      ],
      sessions: [
        makeSession({
          id: 's1',
          nodeId: RAW_NODE_ID,
          displayName: 'remote lane',
        }),
      ],
      surfaces: [],
      // No matching node roster entry (or no `nodes` input at all).
    });

    const item = model.byId.get('topic:alpha');
    expect(item?.sessions[0]?.nodeLabel).toBeNull();
    expect(item?.participants[0]?.nodeLabel).toBeNull();
    // Unresolved routing node id with no other routing parts omits entirely
    // rather than falling back to the raw id.
    expect(item?.routingLabel).toBeNull();
  });
});

describe('formatTaskRefLabel', () => {
  it('prefers an authored title over any id formatting', () => {
    expect(
      formatTaskRefLabel({ kind: 'github-issue', id: '1234', title: 'Fix it' })
    ).toBe('Fix it');
  });

  it('formats an untitled github issue/PR ref as #<id>', () => {
    expect(formatTaskRefLabel({ kind: 'github-issue', id: '1234' })).toBe(
      '#1234'
    );
    expect(formatTaskRefLabel({ kind: 'github-pr', id: '42' })).toBe('#42');
  });

  it('keeps already-human refs (e.g. ticket keys) as-is when untitled', () => {
    expect(formatTaskRefLabel({ kind: 'jira-ticket', id: 'REL-1061' })).toBe(
      'REL-1061'
    );
    expect(formatTaskRefLabel({ kind: 'linear-issue', id: 'ENG-42' })).toBe(
      'ENG-42'
    );
  });
});

describe('selectChannelRailTree', () => {
  const dmA = dmChannelTopicId('claude', 'ws:a');
  const dmOrphan = dmChannelTopicId('codex', 'ws:unknown');
  const model = () =>
    buildTopicNavModel({
      topics: [
        makeTopic({ id: 'topic:a1', workspaceId: 'ws:a' }),
        makeTopic({
          id: 'topic:a-child',
          workspaceId: 'ws:a',
          grouping: { parentTopicId: 'topic:a1' },
        }),
        makeTopic({
          id: 'topic:a-grandchild',
          workspaceId: 'ws:a',
          grouping: { parentTopicId: 'topic:a-child' },
        }),
        makeTopic({
          id: dmA,
          workspaceId: 'ws:a',
          routingDefaults: { providerId: 'claude' },
        }),
        makeTopic({ id: 'topic:b1', workspaceId: 'ws:b' }),
        makeTopic({ id: 'topic:orphan', workspaceId: 'ws:unknown' }),
        makeTopic({
          id: dmOrphan,
          workspaceId: 'ws:unknown',
          routingDefaults: { providerId: 'codex' },
        }),
      ],
      sessions: [],
      surfaces: [],
      derived: false,
    });

  it('projects one ordered channel/DM tree with nested children and orphans', () => {
    const tree = selectChannelRailTree(
      model(),
      [
        makeWorkspace({ id: 'ws:a', name: 'A', order: 1 }),
        makeWorkspace({ id: 'ws:b', name: 'B', order: 0 }),
      ],
      { unreadByChannel: {} }
    );
    expect(tree.groups.map((group) => group.id)).toEqual(['ws:b', 'ws:a']);
    expect(tree.groups[0]!.channels.map((node) => node.item.id)).toEqual([
      'topic:b1',
    ]);
    expect(tree.groups[1]!.channels.map((node) => node.item.id)).toEqual([
      'topic:a1',
    ]);
    expect(
      tree.groups[1]!.channels[0]!.children.map((node) => node.item.id)
    ).toEqual(['topic:a-child']);
    // Structural parity lives in this shared selector output. Desktop may gate
    // descendants behind expansion while mobile renders recursively, but neither
    // consumer owns a second grouping source.
    expect(
      tree.groups[1]!.channels[0]!.children[0]!.children.map(
        (node) => node.item.id
      )
    ).toEqual(['topic:a-grandchild']);
    expect(tree.groups[1]!.directMessages.map((node) => node.item.id)).toEqual([
      dmA,
    ]);
    expect(tree.orphans.channels.map((node) => node.item.id)).toEqual([
      'topic:orphan',
    ]);
    expect(tree.orphans.directMessages.map((node) => node.item.id)).toEqual([
      dmOrphan,
    ]);
  });

  it('floats pinned workspaces before order', () => {
    const tree = selectChannelRailTree(
      model(),
      [
        makeWorkspace({ id: 'ws:a', order: 0, pinned: false }),
        makeWorkspace({ id: 'ws:b', order: 9, pinned: true }),
      ],
      { unreadByChannel: {} }
    );
    expect(tree.groups.map((group) => group.id)).toEqual(['ws:b', 'ws:a']);
  });

  it('carries the same unread snapshot through nodes and group summaries', () => {
    const tree = selectChannelRailTree(
      model(),
      [makeWorkspace({ id: 'ws:a' }), makeWorkspace({ id: 'ws:b' })],
      {
        unreadByChannel: {
          'topic:a-child': true,
          [dmOrphan]: true,
        },
      }
    );
    const groupA = tree.groups.find((group) => group.id === 'ws:a');
    expect(groupA?.channels[0]?.unread).toBe(false);
    expect(groupA?.channels[0]?.children[0]?.unread).toBe(true);
    expect(groupA?.unread).toBe(true);
    expect(tree.orphans.directMessages[0]?.unread).toBe(true);
    expect(tree.orphans.unread).toBe(true);
  });

  // #1287: this used to assert `tree.groups` was `[]` for a workspace with no
  // channels. That contract made a freshly added workspace invisible until a
  // chat existed inside it — impossible, because the lane needed to target the
  // create was the very thing being dropped. A known workspace is now always a
  // lane; only its emptiness changes what the lane renders.
  it('keeps a known workspace with zero channels as an empty lane', () => {
    const tree = selectChannelRailTree(
      model(),
      [makeWorkspace({ id: 'ws:empty' })],
      { unreadByChannel: {} }
    );
    expect(tree.groups.map((group) => group.id)).toEqual(['ws:empty']);
    expect(tree.groups[0]!.empty).toBe(true);
    expect(tree.groups[0]!.channels).toEqual([]);
    expect(tree.groups[0]!.directMessages).toEqual([]);
    expect(tree.groups[0]!.unread).toBe(false);
    expect(tree.orphans.channels.map((node) => node.item.id)).toEqual([
      'topic:a1',
      'topic:b1',
      'topic:orphan',
    ]);
    expect(tree.orphans.directMessages.map((node) => node.item.id)).toEqual([
      dmA,
      dmOrphan,
    ]);
  });

  // #1287 item 6: the rail joins GET /channels summaries onto topic rows so a
  // row's last message/members come from the one list call, not a per-channel
  // fan-out. Topics the list does not cover must still project.
  it('joins channel summaries onto rows by id and leaves uncovered rows null', () => {
    const summary = (
      overrides: Partial<ChannelRailSummary> & { id: string }
    ): ChannelRailSummary => ({
      latestSeq: 4,
      messageCount: 12,
      members: [{ kind: 'agent', id: 'agent:claude', joinedAt: NOW }],
      lastMessage: {
        seq: 4,
        preview: 'shipped the rail join',
        senderId: 'agent:claude',
        senderKind: 'agent',
        createdAt: NOW,
      },
      ...overrides,
    });
    const tree = selectChannelRailTree(
      model(),
      [makeWorkspace({ id: 'ws:a' })],
      {
        unreadByChannel: {},
        summaryByChannel: indexChannelSummaries([
          summary({ id: 'topic:a1' }),
          summary({ id: 'topic:a-child', messageCount: 0, lastMessage: null }),
        ]),
      }
    );
    const groupA = tree.groups.find((group) => group.id === 'ws:a');
    expect(groupA?.channels[0]?.summary?.messageCount).toBe(12);
    expect(groupA?.channels[0]?.summary?.lastMessage?.preview).toBe(
      'shipped the rail join'
    );
    expect(groupA?.channels[0]?.summary?.members).toHaveLength(1);
    // Covered but empty: a summary with no messages still hydrates the row.
    expect(groupA?.channels[0]?.children[0]?.summary?.lastMessage).toBeNull();
    // Uncovered (derived/fallback) rows carry no summary at all.
    expect(groupA?.directMessages[0]?.summary).toBeNull();
    expect(tree.orphans.channels[0]?.summary).toBeNull();
  });

  it('projects rows with no summary snapshot at all', () => {
    const tree = selectChannelRailTree(
      model(),
      [makeWorkspace({ id: 'ws:a' })],
      { unreadByChannel: {} }
    );
    expect(tree.groups[0]?.channels[0]?.summary).toBeNull();
  });

  it('orders an empty lane among populated ones and flags only the empty one', () => {
    const tree = selectChannelRailTree(
      model(),
      [
        makeWorkspace({ id: 'ws:a', name: 'A', order: 2 }),
        makeWorkspace({ id: 'ws:empty', name: 'Empty', order: 1 }),
        makeWorkspace({ id: 'ws:b', name: 'B', order: 0 }),
      ],
      { unreadByChannel: {} }
    );
    expect(tree.groups.map((group) => group.id)).toEqual([
      'ws:b',
      'ws:empty',
      'ws:a',
    ]);
    expect(tree.groups.map((group) => group.empty)).toEqual([
      false,
      true,
      false,
    ]);
  });
});

describe('topic nav channel identity', () => {
  it('threads channelKind, icon, and color from display into the nav item', () => {
    const model = buildTopicNavModel({
      topics: [
        makeTopic({
          id: 'topic:chan',
          display: { title: 'Ops', kind: 'ops', icon: '⚙', color: '#f00' },
        }),
        makeTopic({ id: 'topic:plain', display: { title: 'Plain' } }),
      ],
      sessions: [],
      surfaces: [],
    });
    expect(model.byId.get('topic:chan')).toMatchObject({
      channelKind: 'ops',
      icon: '⚙',
      color: '#f00',
    });
    expect(model.byId.get('topic:plain')).toMatchObject({
      channelKind: null,
      icon: null,
      color: null,
    });
  });
});
