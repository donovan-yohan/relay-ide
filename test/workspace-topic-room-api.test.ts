import { afterEach, describe, expect, it } from 'vitest';

import type { WorkContext } from '../shared/work-context.js';
import type {
  WorkspaceTopic,
  WorkspaceTopicCreateInput,
} from '../shared/workspace-topics.js';
import {
  createWorkContextForTopicRoom,
  launchWorkspaceTopicRoom,
} from '../frontend/src/lib/api.js';
import { makeSession } from './helpers/frontend-factories.js';

const originalFetch = globalThis.fetch;
const NOW = '2026-06-26T00:00:00Z';

function topic(overrides: Partial<WorkspaceTopic> = {}): WorkspaceTopic {
  return {
    schemaVersion: 1,
    id: 'topic:remote-launch',
    workspaceId: 'workspace:remote-devbox',
    source: 'persisted',
    status: 'active',
    visibility: 'default',
    display: { title: 'Remote launch room' },
    grouping: {},
    promptDefaults: {},
    routingDefaults: {
      providerId: 'hermes',
      nodeId: 'devbox',
      repoPath: '/repo/relay',
      worktreePath: '/repo/relay/.worktrees/1045',
      cwd: '/repo/relay/.worktrees/1045/frontend',
    },
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

function topicCreate(
  overrides: Partial<WorkspaceTopicCreateInput> = {}
): WorkspaceTopicCreateInput {
  return {
    workspaceId: 'workspace:remote-devbox',
    title: 'Remote launch room',
    routingDefaults: {
      providerId: 'hermes',
      nodeId: 'devbox',
      repoPath: '/repo/relay',
      worktreePath: '/repo/relay/.worktrees/1045',
      cwd: '/repo/relay/.worktrees/1045/frontend',
    },
    linkedRefs: {},
    ...overrides,
  };
}

function workContext(overrides: Partial<WorkContext> = {}): WorkContext {
  return {
    schemaVersion: 1,
    id: 'wc-topic',
    title: 'Remote launch room',
    createdAt: NOW,
    updatedAt: NOW,
    source: 'workspace-topic-room',
    anchors: {},
    actors: [],
    tasks: [],
    artifacts: [],
    auditRefs: [],
    capabilityGrants: [],
    privacy: {
      classification: 'internal',
      retention: 'project',
      rawPayloadStored: false,
      redaction: { redacted: false, strategy: 'none', classes: [] },
    },
    ...overrides,
  };
}

describe('workspace topic room API', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('creates default WorkContext anchors with the topic node target', async () => {
    const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
    globalThis.fetch = (async (input, init) => {
      calls.push({
        path: String(input),
        body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
      });
      return new Response(JSON.stringify({ workContext: workContext() }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof globalThis.fetch;

    await createWorkContextForTopicRoom({ topic: topicCreate() });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ path: '/work-contexts' });
    expect(calls[0]?.body).toMatchObject({
      title: 'Remote launch room',
      source: 'workspace-topic-room',
      anchors: {
        project: { workspaceId: 'workspace:remote-devbox' },
        node: { nodeId: 'devbox', kind: 'remote' },
        repo: { localPath: '/repo/relay' },
        worktree: { localPath: '/repo/relay/.worktrees/1045' },
      },
    });
  });

  it('launches created rooms on the topic routing node when launch has no override', async () => {
    const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
    globalThis.fetch = (async (input, init) => {
      calls.push({
        path: String(input),
        body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
      });
      return new Response(
        JSON.stringify(
          makeSession({
            id: 'remote-session',
            nodeId: 'devbox',
            workContextId: 'wc-topic',
          })
        ),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }) as typeof globalThis.fetch;

    await launchWorkspaceTopicRoom({
      room: { topic: topic(), workContext: workContext() },
      launch: {
        type: 'terminal',
        mode: 'pty',
      },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ path: '/hub/nodes/devbox/sessions' });
    expect(calls[0]?.body).toMatchObject({
      type: 'terminal',
      mode: 'pty',
      workspaceTopicId: 'topic:remote-launch',
      workContextId: 'wc-topic',
    });
    expect(calls[0]?.body).not.toHaveProperty('nodeId');
  });
});
