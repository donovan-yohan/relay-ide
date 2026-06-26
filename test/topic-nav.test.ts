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
        }),
      ],
      surfaces: [],
    });

    const item = model.byId.get('topic:alpha');
    expect(item?.tone).toBe('attention');
    expect(item?.statusLabel).toBe('needs input');
    expect(item?.sessions).toMatchObject([
      { label: 'Agent lane', selectKey: 'global:agent-1', nodeId: 'devbox' },
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
});
