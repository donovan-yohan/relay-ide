import { afterEach, describe, expect, it, vi } from 'vitest';

import { archiveWorkspaceTopic } from '../frontend/src/lib/api.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('workspace topic archive API (#1382)', () => {
  it('posts the reversible lifecycle route with context write authority', async () => {
    const topic = {
      id: 'topic:release-lane',
      workspaceId: 'ws:local',
      status: 'archived',
      display: { title: 'release lane' },
      routingDefaults: {},
    };
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ topic }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(archiveWorkspaceTopic(topic.id)).resolves.toEqual(topic);
    expect(fetchMock).toHaveBeenCalledWith(
      '/workspace-topics/topic%3Arelease-lane/archive',
      {
        method: 'POST',
        headers: { 'x-relay-capabilities': 'context:write' },
      }
    );
  });
});
