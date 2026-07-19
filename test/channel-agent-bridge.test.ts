import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { MockProtocolAdapterV2 } from '../server/protocol-adapters/mock-v2-adapter.js';
import type { AdapterConfig } from '../server/protocol-adapter-v2.js';
import type { AgentPatchV2 } from '../shared/agent-chat-protocol-v2.js';
import {
  createChannelMessageStore,
  type ChannelMessageStore,
} from '../server/channel-message-store.js';
import { createChannelHub, type ChannelHub } from '../server/channel-hub.js';
import {
  bindSessionToChannel,
  CHANNEL_BRIDGE_FINALIZED_ITEM_CACHE_MAX,
} from '../server/channel-agent-bridge.js';
import type { ChannelBridgeRetentionSnapshot } from '../server/channel-agent-bridge.js';

const cleanup: Array<() => void> = [];

afterEach(() => {
  while (cleanup.length > 0) cleanup.pop()?.();
});

function makeStore(): { store: ChannelMessageStore; hub: ChannelHub } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-channel-bridge-'));
  cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = createChannelMessageStore(path.join(dir, 'channel-chat.db'));
  cleanup.push(() => store.close());
  const hub = createChannelHub({ store, channelExists: () => true });
  cleanup.push(() => hub.close());
  return { store, hub };
}

function config(sessionId: string): AdapterConfig {
  return {
    cwd: '/tmp',
    port: 0,
    sessionId,
    hookToken: 'tok',
    configDir: '/tmp',
  };
}

function assistantStarted(
  sessionId: string,
  turnId: string,
  itemId: string
): AgentPatchV2 {
  return {
    type: 'agent-item-started-v2',
    sessionId,
    timestamp: 't',
    turnId,
    item: { type: 'assistantMessage', id: itemId, text: '' },
  };
}
function textDelta(
  sessionId: string,
  turnId: string,
  itemId: string,
  text: string
): AgentPatchV2 {
  return {
    type: 'agent-item-delta-v2',
    sessionId,
    timestamp: 't',
    turnId,
    itemId,
    delta: { text },
  };
}
function assistantUpdated(
  sessionId: string,
  turnId: string,
  itemId: string,
  text: string
): AgentPatchV2 {
  return {
    type: 'agent-item-updated-v2',
    sessionId,
    timestamp: 't',
    turnId,
    item: { type: 'assistantMessage', id: itemId, text },
  };
}

function turnCompleted(sessionId: string, turnId: string): AgentPatchV2 {
  return {
    type: 'agent-turn-completed-v2',
    sessionId,
    timestamp: 't',
    turnId,
    status: 'completed',
  };
}

describe('channel-agent-bridge lifecycle', () => {
  it('releases completed stream text and item ids after every turn', async () => {
    const { store, hub } = makeStore();
    const adapter = new MockProtocolAdapterV2({ connectMs: 0, stepMs: 0 });
    await adapter.connect(config('sess-retention'));
    let retained: ChannelBridgeRetentionSnapshot | null = null;
    const unbind = bindSessionToChannel({
      channelId: 'topic:retention',
      agentFramework: 'mock',
      adapter,
      store,
      hub,
      onRetentionSnapshot: (snapshot) => {
        retained = snapshot;
      },
    });
    cleanup.push(unbind);

    for (let turn = 0; turn < 50; turn++) {
      await adapter.sendMessage({
        turnId: `turn-${turn}`,
        content: `stream turn ${turn}`,
      });
      expect(retained).toEqual({
        openStreams: 0,
        assistantItemIds: 0,
        turnsWithRows: 0,
        retainedTextBytes: 0,
      });
    }

    expect(store.history('topic:retention', { limit: 100 })).toHaveLength(50);
  });

  it('mirrors a full assistant turn as an attributed complete row', async () => {
    const { store, hub } = makeStore();
    const adapter = new MockProtocolAdapterV2({ connectMs: 1, stepMs: 1 });
    await adapter.connect(config('sess-1'));
    const unbind = bindSessionToChannel({
      channelId: 'topic:test',
      agentFramework: 'claude',
      adapter,
      store,
      hub,
    });
    cleanup.push(unbind);

    await adapter.sendMessage({ turnId: 'turn-1', content: 'hello' });

    const messages = store.history('topic:test');
    expect(messages).toHaveLength(1);
    const message = messages[0]!;
    expect(message.status).toBe('complete');
    expect(message.sender).toMatchObject({
      kind: 'agent',
      id: 'agent:claude',
      providerId: 'claude',
    });
    expect(message.body.text).toBe('Mock v2 response complete.');
    expect(message.source).toMatchObject({
      sessionId: 'sess-1',
      turnId: 'turn-1',
      itemId: 'assistant-turn-1',
    });
    expect(
      store.listMembers('topic:test').some((m) => m.id === 'agent:claude')
    ).toBe(true);
  });

  it('keeps two concurrent bound sessions from cross-contaminating in one channel', async () => {
    const { store, hub } = makeStore();
    const a1 = new MockProtocolAdapterV2({ connectMs: 1, stepMs: 1 });
    const a2 = new MockProtocolAdapterV2({ connectMs: 1, stepMs: 1 });
    await a1.connect(config('s1'));
    await a2.connect(config('s2'));
    cleanup.push(
      bindSessionToChannel({
        channelId: 'topic:c',
        agentFramework: 'claude',
        adapter: a1,
        store,
        hub,
      })
    );
    cleanup.push(
      bindSessionToChannel({
        channelId: 'topic:c',
        agentFramework: 'codex',
        adapter: a2,
        store,
        hub,
      })
    );

    await Promise.all([
      a1.sendMessage({ turnId: 't1', content: 'hi' }),
      a2.sendMessage({ turnId: 't2', content: 'hi' }),
    ]);

    const messages = store.history('topic:c');
    expect(messages).toHaveLength(2);
    const claude = messages.find((m) => m.sender.id === 'agent:claude');
    const codex = messages.find((m) => m.sender.id === 'agent:codex');
    expect(claude?.body.text).toBe('Mock v2 response complete.');
    expect(codex?.body.text).toBe('Mock v2 response complete.');
    expect(claude?.source?.sessionId).toBe('s1');
    expect(codex?.source?.sessionId).toBe('s2');
  });

  it('finalizes as failed on agent-error-v2 keeping the partial text', () => {
    const { store, hub } = makeStore();
    const adapter = new MockProtocolAdapterV2();
    let retained: ChannelBridgeRetentionSnapshot | null = null;
    bindSessionToChannel({
      channelId: 'topic:e',
      agentFramework: 'claude',
      adapter,
      store,
      hub,
      onRetentionSnapshot: (snapshot) => {
        retained = snapshot;
      },
    });
    adapter.broadcastPatch(assistantStarted('s', 'turn', 'a1'));
    adapter.broadcastPatch(textDelta('s', 'turn', 'a1', 'partial'));
    adapter.broadcastPatch({
      type: 'agent-error-v2',
      sessionId: 's',
      timestamp: 't',
      message: 'boom',
      turnId: 'turn',
    });

    const messages = store.history('topic:e');
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      status: 'failed',
      body: { text: 'partial' },
    });
    expect(retained).toEqual({
      openStreams: 0,
      assistantItemIds: 0,
      turnsWithRows: 0,
      retainedTextBytes: 0,
    });
  });

  it('releases every turn when a terminal agent error has no turn id', () => {
    const { store, hub } = makeStore();
    const adapter = new MockProtocolAdapterV2();
    let retained: ChannelBridgeRetentionSnapshot | null = null;
    bindSessionToChannel({
      channelId: 'topic:error-all',
      agentFramework: 'gemini',
      adapter,
      store,
      hub,
      onRetentionSnapshot: (snapshot) => {
        retained = snapshot;
      },
    });
    adapter.broadcastPatch(assistantStarted('s', 'turn-a', 'item-a'));
    adapter.broadcastPatch(assistantStarted('s', 'turn-b', 'item-b'));
    adapter.broadcastPatch({
      type: 'agent-error-v2',
      sessionId: 's',
      timestamp: 't',
      message: 'transport closed',
    });

    expect(store.history('topic:error-all')).toEqual([
      expect.objectContaining({ status: 'failed' }),
      expect.objectContaining({ status: 'failed' }),
    ]);
    expect(retained).toEqual({
      openStreams: 0,
      assistantItemIds: 0,
      turnsWithRows: 0,
      retainedTextBytes: 0,
    });
  });

  it('finalizes an open stream as interrupted when the session is unbound mid-stream', () => {
    const { store, hub } = makeStore();
    const adapter = new MockProtocolAdapterV2();
    const unbind = bindSessionToChannel({
      channelId: 'topic:d',
      agentFramework: 'claude',
      adapter,
      store,
      hub,
    });
    adapter.broadcastPatch(assistantStarted('s', 'turn', 'a1'));
    adapter.broadcastPatch(textDelta('s', 'turn', 'a1', 'hi'));
    unbind();

    const messages = store.history('topic:d');
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      status: 'interrupted',
      body: { text: 'hi' },
    });
  });

  it('treats a duplicate final after turn completion as a pure no-op', () => {
    const { store, hub } = makeStore();
    const adapter = new MockProtocolAdapterV2();
    const beginBroadcast = vi.spyOn(hub, 'beginStreamBroadcast');
    const completeBroadcast = vi.spyOn(hub, 'completeStreamBroadcast');
    let retained: ChannelBridgeRetentionSnapshot | null = null;
    bindSessionToChannel({
      channelId: 'topic:r',
      agentFramework: 'claude',
      adapter,
      store,
      hub,
      onRetentionSnapshot: (snapshot) => {
        retained = snapshot;
      },
    });
    adapter.broadcastPatch(assistantStarted('s', 'turn', 'a1'));
    adapter.broadcastPatch(assistantStarted('s', 'turn', 'a1')); // re-emit
    adapter.broadcastPatch(assistantUpdated('s', 'turn', 'a1', 'full'));
    adapter.broadcastPatch({
      type: 'agent-turn-completed-v2',
      sessionId: 's',
      timestamp: 't',
      turnId: 'turn',
      status: 'completed',
    });
    adapter.broadcastPatch(assistantUpdated('s', 'turn', 'a1', 'full-again'));

    const messages = store.history('topic:r');
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      status: 'complete',
      body: { text: 'full' },
    });
    expect(beginBroadcast).toHaveBeenCalledTimes(1);
    expect(completeBroadcast).toHaveBeenCalledTimes(1);
    expect(retained).toEqual({
      openStreams: 0,
      assistantItemIds: 0,
      turnsWithRows: 0,
      retainedTextBytes: 0,
    });
  });

  it('bounds Gemini-style replayed starts against a finalized durable row', () => {
    const { store, hub } = makeStore();
    const firstAdapter = new MockProtocolAdapterV2();
    const unbindFirst = bindSessionToChannel({
      channelId: 'topic:replay',
      agentFramework: 'gemini',
      adapter: firstAdapter,
      store,
      hub,
    });
    firstAdapter.broadcastPatch(
      assistantUpdated('session-gemini', 'turn-replay', 'item-replay', 'done')
    );
    unbindFirst();

    const beginStore = vi.spyOn(store, 'beginStream');
    const beginBroadcast = vi.spyOn(hub, 'beginStreamBroadcast');
    const replayAdapter = new MockProtocolAdapterV2();
    let retained: ChannelBridgeRetentionSnapshot | null = null;
    bindSessionToChannel({
      channelId: 'topic:replay',
      agentFramework: 'gemini',
      adapter: replayAdapter,
      store,
      hub,
      onRetentionSnapshot: (snapshot) => {
        retained = snapshot;
      },
    });

    replayAdapter.broadcastPatch(
      assistantStarted('session-gemini', 'turn-replay', 'item-replay')
    );
    replayAdapter.broadcastPatch(
      assistantStarted('session-gemini', 'turn-replay', 'item-replay')
    );

    expect(beginStore).toHaveBeenCalledTimes(1);
    expect(beginBroadcast).not.toHaveBeenCalled();
    expect(store.history('topic:replay')).toHaveLength(1);
    expect(retained).toEqual({
      openStreams: 0,
      assistantItemIds: 0,
      turnsWithRows: 0,
      retainedTextBytes: 0,
    });
  });

  it('bounds finalized-item replay tombstones while preserving dedupe', () => {
    const { store, hub } = makeStore();
    const adapter = new MockProtocolAdapterV2();
    let retained: ChannelBridgeRetentionSnapshot | null = null;
    bindSessionToChannel({
      channelId: 'topic:tombstones',
      agentFramework: 'gemini',
      adapter,
      store,
      hub,
      onRetentionSnapshot: (snapshot) => {
        retained = snapshot;
      },
    });

    for (
      let index = 0;
      index <= CHANNEL_BRIDGE_FINALIZED_ITEM_CACHE_MAX;
      index++
    ) {
      const turnId = `turn-${index}`;
      adapter.broadcastPatch(
        assistantUpdated('session-gemini', turnId, `item-${index}`, 'done')
      );
      adapter.broadcastPatch(turnCompleted('session-gemini', turnId));
    }

    const beginStore = vi.spyOn(store, 'beginStream');
    const beginBroadcast = vi.spyOn(hub, 'beginStreamBroadcast');
    const newest = CHANNEL_BRIDGE_FINALIZED_ITEM_CACHE_MAX;
    adapter.broadcastPatch(
      assistantStarted('session-gemini', `turn-${newest}`, `item-${newest}`)
    );
    expect(beginStore).not.toHaveBeenCalled();

    // The oldest tombstone was evicted, so one durable lookup refreshes it;
    // subsequent replay is served by the bounded tombstone without another hit.
    adapter.broadcastPatch(
      assistantStarted('session-gemini', 'turn-0', 'item-0')
    );
    adapter.broadcastPatch(
      assistantStarted('session-gemini', 'turn-0', 'item-0')
    );
    expect(beginStore).toHaveBeenCalledOnce();
    expect(beginBroadcast).not.toHaveBeenCalled();
    expect(retained).toEqual({
      openStreams: 0,
      assistantItemIds: 0,
      turnsWithRows: 0,
      retainedTextBytes: 0,
    });
  });

  it('materializes a non-streamed complete assistantMessage as one row (#1181)', () => {
    // A completed assistantMessage that never opened a stream (no started, no
    // delta) — the shape a hermes v0.18.2 message output-item maps to. Without
    // the bridge materializing it, the reply is silently dropped.
    const { store, hub } = makeStore();
    const adapter = new MockProtocolAdapterV2();
    bindSessionToChannel({
      channelId: 'topic:ns',
      agentFramework: 'hermes',
      adapter,
      store,
      hub,
    });
    adapter.broadcastPatch(assistantUpdated('s', 'turn', 'msg-turn', 'ok'));

    const messages = store.history('topic:ns');
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      status: 'complete',
      body: { text: 'ok' },
    });
    expect(messages[0]!.sender).toMatchObject({
      kind: 'agent',
      id: 'agent:hermes',
    });
  });

  it('does not double-commit a non-streamed complete followed by turn-completed (#1181)', () => {
    const { store, hub } = makeStore();
    const adapter = new MockProtocolAdapterV2();
    bindSessionToChannel({
      channelId: 'topic:ns2',
      agentFramework: 'hermes',
      adapter,
      store,
      hub,
    });
    adapter.broadcastPatch(assistantUpdated('s', 'turn', 'msg-turn', 'ok'));
    adapter.broadcastPatch({
      type: 'agent-turn-completed-v2',
      sessionId: 's',
      timestamp: 't',
      turnId: 'turn',
      status: 'completed',
    });

    const messages = store.history('topic:ns2');
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      status: 'complete',
      body: { text: 'ok' },
    });
  });

  it('does not mirror plan-item (or unknown-item) text deltas', () => {
    const { store, hub } = makeStore();
    const adapter = new MockProtocolAdapterV2();
    bindSessionToChannel({
      channelId: 'topic:plan',
      agentFramework: 'codex',
      adapter,
      store,
      hub,
    });
    // A plan item is started as a non-assistantMessage, then streams text deltas
    // (real codex-native adapters emit plan updates this way on `plan-<turnId>`).
    adapter.broadcastPatch({
      type: 'agent-item-started-v2',
      sessionId: 's',
      timestamp: 't',
      turnId: 'turn',
      item: { type: 'plan', id: 'plan-turn', text: '' },
    });
    adapter.broadcastPatch(
      textDelta('s', 'turn', 'plan-turn', 'Step 1: do it')
    );
    // A delta for an itemId never started at all is likewise dropped.
    adapter.broadcastPatch(textDelta('s', 'turn', 'ghost-item', 'stray text'));

    expect(store.history('topic:plan')).toHaveLength(0);
  });

  it('does not mirror non-text items', () => {
    const { store, hub } = makeStore();
    const adapter = new MockProtocolAdapterV2();
    bindSessionToChannel({
      channelId: 'topic:n',
      agentFramework: 'claude',
      adapter,
      store,
      hub,
    });
    adapter.broadcastPatch({
      type: 'agent-item-started-v2',
      sessionId: 's',
      timestamp: 't',
      turnId: 'turn',
      item: { type: 'commandExecution', id: 'c1', command: 'ls', output: '' },
    });
    adapter.broadcastPatch({
      type: 'agent-item-started-v2',
      sessionId: 's',
      timestamp: 't',
      turnId: 'turn',
      item: { type: 'reasoning', id: 'r1', summary: 'thinking' },
    });
    expect(store.history('topic:n')).toHaveLength(0);
  });

  it('force-finalizes truncated when the in-flight text exceeds the 256KB cap', () => {
    const { store, hub } = makeStore();
    const adapter = new MockProtocolAdapterV2();
    bindSessionToChannel({
      channelId: 'topic:cap',
      agentFramework: 'claude',
      adapter,
      store,
      hub,
    });
    adapter.broadcastPatch(assistantStarted('s', 'turn', 'a1'));
    adapter.broadcastPatch(textDelta('s', 'turn', 'a1', 'start '));
    adapter.broadcastPatch(
      textDelta('s', 'turn', 'a1', 'x'.repeat(256 * 1024))
    ); // breach

    const messages = store.history('topic:cap');
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      status: 'complete',
      truncated: true,
      body: { text: 'start ' },
    });
  });
});
