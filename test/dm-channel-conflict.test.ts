// @vitest-environment happy-dom
//
// #1287 item 8: DM channel ids are deterministic, so `getOrCreateDmChannel`'s
// read-then-create is a race — two surfaces opening the same DM at once both
// see 404 and both POST. Before this item the loser got a bare 400 "workspace
// topic already exists" and the DM simply failed to open, even though the row
// it wanted was sitting right there. The create conflict now answers 409 with a
// body that names the blocking row, so the loser adopts it instead.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ARCHIVED_CHANNEL_PROMPT_NOTICE,
  getOrCreateDmChannel,
  openAgentChannel,
} from '../frontend/src/lib/agent-channels.js';
import { dmChannelTopicId } from '../frontend/src/lib/dm-channels.js';
import { useToastStore } from '../frontend/src/lib/stores/toasts.js';
import { useUiStore } from '../frontend/src/lib/stores/ui.js';
import {
  buildWorkspaceTopicConflictDetails,
  workspaceTopicConflictMessage,
  type WorkspaceTopic,
} from '../shared/workspace-topics.js';

const DM_INPUT = {
  providerId: 'claude',
  providerDisplayName: 'Claude Code',
  workspaceId: 'ws:alpha',
};
const DM_ID = dmChannelTopicId('claude', 'ws:alpha');

function dmTopic(status: 'active' | 'archived' = 'active'): WorkspaceTopic {
  return {
    schemaVersion: 1,
    id: DM_ID,
    workspaceId: 'ws:alpha',
    source: 'persisted',
    status,
    visibility: 'default',
    display: { title: 'Claude Code' },
    grouping: {},
    promptDefaults: {},
    routingDefaults: { providerId: 'claude' },
    linkedRefs: {},
    state: { pinned: false, muted: false },
    privacy: {
      classification: 'internal',
      retention: 'project',
      redaction: 'summary',
      rawDefaultsStored: false,
    },
    createdAt: '2026-06-26T00:00:00.000Z',
    updatedAt: '2026-06-26T00:00:00.000Z',
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** The exact 409 envelope `POST /workspace-topics` sends for a taken id. */
function conflictResponse(status: 'active' | 'archived'): Response {
  const details = buildWorkspaceTopicConflictDetails({
    id: DM_ID,
    workspaceId: 'ws:alpha',
    status,
    title: 'Claude Code',
  });
  return jsonResponse(409, {
    error: {
      code: 'SESSION_CONFLICT',
      message: workspaceTopicConflictMessage(details),
      retryable: false,
      details,
    },
  });
}

const calls: Array<{ method: string; url: string }> = [];

function stubFetch(handler: (method: string, url: string) => Response): void {
  vi.stubGlobal('fetch', (input: unknown, init?: { method?: string }) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push({ method, url });
    return Promise.resolve(handler(method, url));
  });
}

beforeEach(() => {
  calls.length = 0;
  useUiStore.setState({ activeChannelId: null, activeWorkspaceId: null });
  useToastStore.setState({ toasts: [] });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('getOrCreateDmChannel conflict handling (#1287)', () => {
  it('returns the existing DM without attempting a create', async () => {
    stubFetch((method) => {
      if (method === 'GET') return jsonResponse(200, { topic: dmTopic() });
      throw new Error(`unexpected ${method}`);
    });

    await expect(getOrCreateDmChannel(DM_INPUT)).resolves.toMatchObject({
      id: DM_ID,
    });
    expect(calls.map((call) => call.method)).toEqual(['GET']);
  });

  it('creates the DM when no row owns the deterministic id', async () => {
    stubFetch((method) =>
      method === 'GET'
        ? jsonResponse(404, {
            error: { code: 'NOT_FOUND', message: 'workspace topic not found' },
          })
        : jsonResponse(201, { topic: dmTopic() })
    );

    await expect(getOrCreateDmChannel(DM_INPUT)).resolves.toMatchObject({
      id: DM_ID,
    });
    expect(calls.map((call) => call.method)).toEqual(['GET', 'POST']);
  });

  it('adopts the blocking row when the create loses the race', async () => {
    let gets = 0;
    stubFetch((method) => {
      if (method === 'POST') return conflictResponse('active');
      gets += 1;
      // The row appears between the 404 read and the create.
      return gets === 1
        ? jsonResponse(404, {
            error: { code: 'NOT_FOUND', message: 'workspace topic not found' },
          })
        : jsonResponse(200, { topic: dmTopic() });
    });

    const topic = await getOrCreateDmChannel(DM_INPUT);

    expect(topic.id).toBe(DM_ID);
    expect(calls.map((call) => call.method)).toEqual(['GET', 'POST', 'GET']);
  });

  it('opens an archived blocker so the channel restore bar can take over', async () => {
    let gets = 0;
    stubFetch((method) => {
      if (method === 'POST') return conflictResponse('archived');
      gets += 1;
      return gets === 1
        ? jsonResponse(404, {
            error: { code: 'NOT_FOUND', message: 'workspace topic not found' },
          })
        : jsonResponse(200, { topic: dmTopic('archived') });
    });

    const topic = await getOrCreateDmChannel(DM_INPUT);

    // Not an error path: the archived DM opens, and ChannelView renders the
    // shared restore affordance from its `archived` status.
    expect(topic.status).toBe('archived');
  });

  it('still fails loudly when the create error is not a taken id', async () => {
    stubFetch((method) =>
      method === 'GET'
        ? jsonResponse(404, {
            error: { code: 'NOT_FOUND', message: 'workspace topic not found' },
          })
        : jsonResponse(503, {
            error: {
              code: 'SERVER_UNAVAILABLE',
              message: 'workspace topic store is unavailable',
              retryable: true,
              details: { reasonCode: 'WORKSPACE_TOPIC_STORE_UNAVAILABLE' },
            },
          })
    );

    await expect(getOrCreateDmChannel(DM_INPUT)).rejects.toThrow(/unavailable/);
    expect(calls.map((call) => call.method)).toEqual(['GET', 'POST']);
  });
});

// Adopting an archived blocker inside `getOrCreateDmChannel` only pays off if
// the CALLER actually opens what it adopted. It used to post the first message
// before navigating, and `POST /channels/:id/messages` answers 409
// CHANNEL_ARCHIVED — so the await threw, `setActiveChannelId` never ran, and the
// operator got a failure toast about a channel the sidebar filters out of its
// default list. The archived channel is now opened first, whatever the post does.
describe('openAgentChannel lands on an archived DM (#1287)', () => {
  const OPEN_INPUT = {
    providerId: 'claude',
    workspaceId: 'ws:alpha',
    prompt: 'triage the reconnect flake',
  };

  /** Archived DM already on disk (no race): the plain read returns it. */
  function stubArchivedDm(): void {
    stubFetch((method, url) => {
      if (url.includes('/channels/')) {
        return jsonResponse(409, {
          error: {
            code: 'SESSION_CONFLICT',
            message: 'channel is archived',
            retryable: false,
            details: { channelId: DM_ID, reasonCode: 'CHANNEL_ARCHIVED' },
          },
        });
      }
      if (method === 'GET') {
        return jsonResponse(200, { topic: dmTopic('archived') });
      }
      throw new Error(`unexpected ${method} ${url}`);
    });
  }

  it('opens the channel and names the remedy instead of dead-ending', async () => {
    stubArchivedDm();

    const topic = await openAgentChannel(OPEN_INPUT);

    expect(topic.status).toBe('archived');
    // The whole point: ChannelView is mounted on the archived row, so its
    // shared restore bar is on screen.
    expect(useUiStore.getState().activeChannelId).toBe(DM_ID);
    expect(
      useToastStore.getState().toasts.map((toast) => toast.message)
    ).toEqual([ARCHIVED_CHANNEL_PROMPT_NOTICE]);
  });

  it('posts the prompt and opens the channel on the healthy path', async () => {
    stubFetch((method, url) => {
      if (url.includes('/channels/')) {
        return jsonResponse(201, { message: { seq: 1 } });
      }
      if (method === 'GET') return jsonResponse(200, { topic: dmTopic() });
      throw new Error(`unexpected ${method} ${url}`);
    });

    await openAgentChannel(OPEN_INPUT);

    expect(useUiStore.getState().activeChannelId).toBe(DM_ID);
    expect(useToastStore.getState().toasts).toEqual([]);
    expect(calls.some((call) => call.url.includes('/messages'))).toBe(true);
  });

  it('still throws for a post failure that is not the archived channel', async () => {
    stubFetch((method, url) => {
      if (url.includes('/channels/')) {
        return jsonResponse(409, {
          error: {
            code: 'SESSION_CONFLICT',
            message: 'thread root belongs to another channel',
            retryable: false,
            details: { reasonCode: 'thread_root_channel_mismatch' },
          },
        });
      }
      if (method === 'GET') return jsonResponse(200, { topic: dmTopic() });
      throw new Error(`unexpected ${method} ${url}`);
    });

    await expect(openAgentChannel(OPEN_INPUT)).rejects.toThrow(/thread root/);
    // Opening first is not swallowing: the caller still reports the failure,
    // and the channel it navigated to is a live one.
    expect(useUiStore.getState().activeChannelId).toBe(DM_ID);
    expect(useToastStore.getState().toasts).toEqual([]);
  });
});
