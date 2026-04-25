import { describe, expect, it } from 'vitest';
import { createAdapterV2 } from '../server/protocol-adapters/index.js';
import { MockProtocolAdapterV2 } from '../server/protocol-adapters/mock-v2-adapter.js';
import type { AdapterConfig } from '../server/protocol-adapter-v2.js';
import {
  applyAgentPatchV2,
  emptyAgentSessionV2,
  type AgentPatchV2,
} from '../shared/agent-chat-protocol-v2.js';

const config: AdapterConfig = {
  cwd: '/tmp/repo',
  port: 3000,
  sessionId: 'session-1',
  hookToken: 'token',
  configDir: '/tmp/config',
};

const zeroDelays = {
  connectMs: 0,
  stepMs: 0,
};

function collectPatches(adapter: MockProtocolAdapterV2): AgentPatchV2[] {
  const patches: AgentPatchV2[] = [];
  adapter.onPatch((patch) => patches.push(patch));
  return patches;
}

function patchTypes(patches: AgentPatchV2[]): AgentPatchV2['type'][] {
  return patches.map((patch) => patch.type);
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 250
): Promise<void> {
  const start = Date.now();

  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('Timed out waiting for mock v2 adapter condition');
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function expectSettledWithin<T>(
  promise: Promise<T>,
  timeoutMs = 250
): Promise<PromiseSettledResult<T>> {
  return Promise.race([
    promise.then(
      (value): PromiseSettledResult<T> => ({ status: 'fulfilled', value }),
      (reason): PromiseSettledResult<T> => ({ status: 'rejected', reason })
    ),
    delay(timeoutMs).then(() => {
      throw new Error('Promise did not settle before timeout');
    }),
  ]);
}

describe('MockProtocolAdapterV2', () => {
  it('connect emits an idle session live-state patch', async () => {
    const adapter = new MockProtocolAdapterV2(zeroDelays);
    const patches = collectPatches(adapter);

    await adapter.connect(config);

    expect(adapter.status).toBe('connected');
    expect(patches).toEqual([
      expect.objectContaining({
        type: 'agent-live-state-updated-v2',
        sessionId: 'session-1',
        live: {
          status: 'idle',
          activeTurnId: null,
          waitingOn: null,
          activeRequestIds: [],
          proposedPlanItemId: null,
          queueLength: 0,
          fastModeAvailable: false,
          error: null,
        },
      }),
    ]);
  });

  it('sendMessage emits user, turn, assistant, delta, item completion, and turn completion patches', async () => {
    const adapter = new MockProtocolAdapterV2(zeroDelays);
    const patches = collectPatches(adapter);
    await adapter.connect(config);

    await adapter.sendMessage({
      turnId: 'turn-1',
      content: 'hello',
    });

    expect(patchTypes(patches)).toEqual([
      'agent-live-state-updated-v2',
      'agent-turn-started-v2',
      'agent-item-started-v2',
      'agent-item-started-v2',
      'agent-item-delta-v2',
      'agent-item-updated-v2',
      'agent-turn-completed-v2',
      'agent-live-state-updated-v2',
    ]);
    expect(patches[1]).toMatchObject({
      type: 'agent-turn-started-v2',
      turn: {
        id: 'turn-1',
        status: 'running',
        inputMessageId: 'user-turn-1',
      },
    });
    expect(patches[2]).toMatchObject({
      type: 'agent-item-started-v2',
      turnId: 'turn-1',
      item: { type: 'userMessage', id: 'user-turn-1', text: 'hello' },
    });
    expect(patches[3]).toMatchObject({
      type: 'agent-item-started-v2',
      turnId: 'turn-1',
      item: {
        type: 'assistantMessage',
        id: 'assistant-turn-1',
        text: '',
      },
    });
    expect(patches[4]).toMatchObject({
      type: 'agent-item-delta-v2',
      turnId: 'turn-1',
      itemId: 'assistant-turn-1',
      delta: { text: expect.any(String) },
    });
    expect(patches[5]).toMatchObject({
      type: 'agent-item-updated-v2',
      turnId: 'turn-1',
      item: {
        type: 'assistantMessage',
        id: 'assistant-turn-1',
        status: 'completed',
      },
    });
    expect(patches[6]).toMatchObject({
      type: 'agent-turn-completed-v2',
      turnId: 'turn-1',
      status: 'completed',
    });
  });

  it('emits a happy-path patch stream that reduces to user and assistant items', async () => {
    const adapter = new MockProtocolAdapterV2(zeroDelays);
    const patches = collectPatches(adapter);
    await adapter.connect(config);

    await adapter.sendMessage({
      turnId: 'turn-1',
      content: 'hello',
    });

    const reduced = patches.reduce(
      applyAgentPatchV2,
      emptyAgentSessionV2({
        id: 'session-1',
        provider: 'mock',
        cwd: '/tmp/repo',
      })
    );

    expect(reduced.turns).toHaveLength(1);
    expect(reduced.turns[0]?.items).toEqual([
      expect.objectContaining({
        type: 'userMessage',
        id: 'user-turn-1',
        text: 'hello',
      }),
      expect.objectContaining({
        type: 'assistantMessage',
        id: 'assistant-turn-1',
        text: 'Mock v2 response complete.',
      }),
    ]);
  });

  it('queue scenario keeps active turn running and emits queued live state for the second message', async () => {
    const adapter = new MockProtocolAdapterV2({ connectMs: 0, stepMs: 15 });
    const patches = collectPatches(adapter);
    await adapter.connect(config);

    const first = adapter.sendMessage({
      turnId: 'turn-1',
      content: 'first',
    });
    await waitFor(() =>
      patches.some(
        (patch) =>
          patch.type === 'agent-turn-started-v2' && patch.turn.id === 'turn-1'
      )
    );

    const second = adapter.sendMessage({
      turnId: 'turn-2',
      content: 'second',
    });

    await waitFor(() =>
      patches.some(
        (patch) =>
          patch.type === 'agent-live-state-updated-v2' &&
          patch.live.activeTurnId === 'turn-1' &&
          patch.live.queueLength === 1
      )
    );

    expect(
      patches.find(
        (patch) =>
          patch.type === 'agent-turn-started-v2' && patch.turn.id === 'turn-2'
      )
    ).toBeUndefined();

    await first;
    await second;

    expect(
      patches.some(
        (patch) =>
          patch.type === 'agent-turn-started-v2' && patch.turn.id === 'turn-2'
      )
    ).toBe(true);
  });

  it('rejects queued sendMessage promises on disconnect', async () => {
    const adapter = new MockProtocolAdapterV2({ connectMs: 0, stepMs: 50 });
    const patches = collectPatches(adapter);
    await adapter.connect(config);

    const first = adapter.sendMessage({
      turnId: 'turn-1',
      content: 'first',
    });
    await waitFor(() =>
      patches.some(
        (patch) =>
          patch.type === 'agent-turn-started-v2' && patch.turn.id === 'turn-1'
      )
    );

    const second = adapter.sendMessage({
      turnId: 'turn-2',
      content: 'second',
    });
    await waitFor(() =>
      patches.some(
        (patch) =>
          patch.type === 'agent-live-state-updated-v2' &&
          patch.live.queueLength === 1
      )
    );
    const queuedResultPromise = expectSettledWithin(second);

    await adapter.disconnect();

    const queuedResult = await queuedResultPromise;
    expect(queuedResult.status).toBe('rejected');
    expect(queuedResult).toMatchObject({
      status: 'rejected',
      reason: expect.objectContaining({
        message: 'MockProtocolAdapterV2 disconnected with 1 queued message(s)',
      }),
    });
    await first;
    expect(
      patches.some(
        (patch) =>
          patch.type === 'agent-live-state-updated-v2' &&
          patch.live.queueLength === 0
      )
    ).toBe(true);
  });

  it('settles queued sendMessage promises when reconnect disconnects the active session', async () => {
    const adapter = new MockProtocolAdapterV2({ connectMs: 0, stepMs: 50 });
    const patches = collectPatches(adapter);
    await adapter.connect(config);

    const first = adapter.sendMessage({
      turnId: 'turn-1',
      content: 'first',
    });
    await waitFor(() =>
      patches.some(
        (patch) =>
          patch.type === 'agent-turn-started-v2' && patch.turn.id === 'turn-1'
      )
    );

    const second = adapter.sendMessage({
      turnId: 'turn-2',
      content: 'second',
    });
    await waitFor(() =>
      patches.some(
        (patch) =>
          patch.type === 'agent-live-state-updated-v2' &&
          patch.live.queueLength === 1
      )
    );
    const queuedResultPromise = expectSettledWithin(second);

    await adapter.reconnect();

    const queuedResult = await queuedResultPromise;
    expect(queuedResult.status).toBe('rejected');
    expect(queuedResult).toMatchObject({
      status: 'rejected',
      reason: expect.objectContaining({
        message: 'MockProtocolAdapterV2 disconnected with 1 queued message(s)',
      }),
    });
    await first;
    expect(adapter.status).toBe('connected');
  });

  it('does not emit idle or become connected from a stale connect after disconnect', async () => {
    const adapter = new MockProtocolAdapterV2({ connectMs: 25, stepMs: 0 });
    const patches = collectPatches(adapter);

    const connect = adapter.connect(config);
    await delay(1);
    await adapter.disconnect();
    await connect;

    expect(adapter.status).toBe('disconnected');
    expect(patches).toEqual([]);
  });

  it('interrupting a queued turn cancels that queued send and emits queueLength update', async () => {
    const adapter = new MockProtocolAdapterV2({ connectMs: 0, stepMs: 50 });
    const patches = collectPatches(adapter);
    await adapter.connect(config);

    const first = adapter.sendMessage({
      turnId: 'turn-1',
      content: 'first',
    });
    await waitFor(() =>
      patches.some(
        (patch) =>
          patch.type === 'agent-turn-started-v2' && patch.turn.id === 'turn-1'
      )
    );

    const second = adapter.sendMessage({
      turnId: 'turn-2',
      content: 'second',
    });
    await waitFor(() =>
      patches.some(
        (patch) =>
          patch.type === 'agent-live-state-updated-v2' &&
          patch.live.queueLength === 1
      )
    );

    await adapter.interrupt({ turnId: 'turn-2' });

    await expectSettledWithin(second);
    expect(
      patches.some(
        (patch) =>
          patch.type === 'agent-live-state-updated-v2' &&
          patch.live.queueLength === 0
      )
    ).toBe(true);
    await adapter.interrupt({ turnId: 'turn-1' });
    await first;
  });

  it('approval scenario emits an approval item and waiting patch, then resolves after respondToApproval', async () => {
    const adapter = new MockProtocolAdapterV2(zeroDelays);
    const patches = collectPatches(adapter);
    await adapter.connect(config);

    const turn = adapter.sendMessage({
      turnId: 'turn-approval',
      content: 'scenario:approval',
    });

    await waitFor(() =>
      patches.some(
        (patch) =>
          patch.type === 'agent-live-state-updated-v2' &&
          patch.live.waitingOn === 'approval'
      )
    );

    expect(
      patches.find(
        (patch) =>
          patch.type === 'agent-item-started-v2' &&
          patch.item.type === 'approval'
      )
    ).toMatchObject({
      type: 'agent-item-started-v2',
      turnId: 'turn-approval',
      item: {
        type: 'approval',
        id: 'approval-turn-approval',
        requestId: 'approval-turn-approval',
        status: 'pending',
      },
    });
    expect(
      patches.find(
        (patch) =>
          patch.type === 'agent-live-state-updated-v2' &&
          patch.live.waitingOn === 'approval'
      )
    ).toMatchObject({
      type: 'agent-live-state-updated-v2',
      live: {
        status: 'waiting',
        activeTurnId: 'turn-approval',
        waitingOn: 'approval',
        activeRequestIds: ['approval-turn-approval'],
      },
    });

    await adapter.respondToApproval({
      requestId: 'approval-turn-approval',
      decision: 'allow',
    });
    await turn;

    expect(
      patches.some(
        (patch) =>
          patch.type === 'agent-item-updated-v2' &&
          patch.item.type === 'approval' &&
          patch.item.decision === 'allow'
      )
    ).toBe(true);
    expect(patches.at(-2)).toMatchObject({
      type: 'agent-turn-completed-v2',
      turnId: 'turn-approval',
      status: 'completed',
    });
  });

  it('interrupt marks the running turn interrupted', async () => {
    const adapter = new MockProtocolAdapterV2({ connectMs: 0, stepMs: 50 });
    const patches = collectPatches(adapter);
    await adapter.connect(config);

    const turn = adapter.sendMessage({
      turnId: 'turn-1',
      content: 'long running',
    });
    await waitFor(() =>
      patches.some(
        (patch) =>
          patch.type === 'agent-turn-started-v2' && patch.turn.id === 'turn-1'
      )
    );

    await adapter.interrupt({ turnId: 'turn-1' });
    await turn;

    expect(
      patches.find(
        (patch) =>
          patch.type === 'agent-turn-completed-v2' && patch.turnId === 'turn-1'
      )
    ).toMatchObject({
      type: 'agent-turn-completed-v2',
      status: 'interrupted',
    });
  });

  it('registers a v2 mock adapter factory without changing v1 createAdapter', () => {
    expect(createAdapterV2('mock')).toBeInstanceOf(MockProtocolAdapterV2);
  });
});
