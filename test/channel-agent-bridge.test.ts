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
  boundChannelAgentDetail,
  CHANNEL_BRIDGE_DETAIL_COMMAND_MAX_CHARS,
  CHANNEL_BRIDGE_FINALIZED_ITEM_CACHE_MAX,
  CHANNEL_BRIDGE_IMAGE_MAX_PER_TURN,
  CHANNEL_BRIDGE_DETAIL_ITEM_ID_MAX_CHARS,
  CHANNEL_BRIDGE_DETAIL_LANGUAGE_MAX_CHARS,
  CHANNEL_BRIDGE_DETAIL_PATH_MAX_CHARS,
  CHANNEL_BRIDGE_DETAIL_TITLE_MAX_CHARS,
} from '../server/channel-agent-bridge.js';
import type { ChannelBridgeRetentionSnapshot } from '../server/channel-agent-bridge.js';
import type { ChannelAttachmentStore } from '../server/channel-attachments.js';
import {
  buildMentionContextPacketEnvelope,
  PACKET_IMAGE_DEGRADATION_META_KEY,
} from '../server/channel-context-packet.js';
import {
  CHANNEL_AGENT_DETAIL_MAX_BYTES,
  parseMentions,
  type ChannelImagePart,
  type ChannelMessage,
} from '../shared/channel-chat-protocol.js';

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
    item: {
      type: 'assistantMessage',
      id: itemId,
      text,
      status: 'completed',
      completedAt: 't',
    },
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

function reasoningStarted(
  sessionId: string,
  turnId: string,
  itemId: string
): AgentPatchV2 {
  return {
    type: 'agent-item-started-v2',
    sessionId,
    timestamp: 't',
    turnId,
    item: {
      type: 'reasoning',
      id: itemId,
      summary: '',
      status: 'running',
    },
  };
}

function reasoningUpdated(
  sessionId: string,
  turnId: string,
  itemId: string,
  status: 'completed' | 'failed' | 'cancelled',
  summary: string
): AgentPatchV2 {
  return {
    type: 'agent-item-updated-v2',
    sessionId,
    timestamp: 't',
    turnId,
    item: {
      type: 'reasoning',
      id: itemId,
      summary,
      status,
      completedAt: 't',
    },
  };
}

describe('channel-agent-bridge lifecycle', () => {
  it('strictly bounds escaping-heavy detail content and every metadata scalar', () => {
    const huge = '\u0000'.repeat(300 * 1024);
    const detail = boundChannelAgentDetail(`reason-${huge}`, {
      kind: 'thought',
      title: huge,
      status: 'running',
      content: huge,
      language: huge,
      command: huge,
      path: huge,
    });
    expect(
      Buffer.byteLength(JSON.stringify(detail), 'utf8')
    ).toBeLessThanOrEqual(CHANNEL_AGENT_DETAIL_MAX_BYTES);
    expect(detail.itemId.length).toBeLessThanOrEqual(
      CHANNEL_BRIDGE_DETAIL_ITEM_ID_MAX_CHARS
    );
    expect(detail.card.title.length).toBeLessThanOrEqual(
      CHANNEL_BRIDGE_DETAIL_TITLE_MAX_CHARS
    );
    expect(detail.card.language?.length).toBeLessThanOrEqual(
      CHANNEL_BRIDGE_DETAIL_LANGUAGE_MAX_CHARS
    );
    expect(detail.card.command?.length).toBeLessThanOrEqual(
      CHANNEL_BRIDGE_DETAIL_COMMAND_MAX_CHARS
    );
    expect(detail.card.path?.length).toBeLessThanOrEqual(
      CHANNEL_BRIDGE_DETAIL_PATH_MAX_CHARS
    );
    expect(detail.card.content!.length).toBeLessThan(64 * 1024);
  });

  it('keeps truncated detail item ids stable and collision-resistant', () => {
    const sharedPrefix = 'provider-item-'.repeat(100);
    const first = boundChannelAgentDetail(`${sharedPrefix}:first`, {
      kind: 'thought',
      title: 'thinking',
      status: 'running',
    });
    const second = boundChannelAgentDetail(`${sharedPrefix}:second`, {
      kind: 'thought',
      title: 'thinking',
      status: 'running',
    });

    expect(first.itemId).toHaveLength(CHANNEL_BRIDGE_DETAIL_ITEM_ID_MAX_CHARS);
    expect(second.itemId).toHaveLength(CHANNEL_BRIDGE_DETAIL_ITEM_ID_MAX_CHARS);
    expect(first.itemId).not.toBe(second.itemId);
    expect(first.itemId).toMatch(/#[a-f0-9]{24}$/);
    expect(
      boundChannelAgentDetail(`${sharedPrefix}:first`, {
        kind: 'thought',
        title: 'thinking',
        status: 'running',
      }).itemId
    ).toBe(first.itemId);
  });

  it('projects only known card fields before sizing durable metadata', () => {
    const pollutedCard = {
      kind: 'thought',
      title: 'thinking',
      status: 'running',
      content: 'bounded thought',
      providerPayload: 'x'.repeat(512 * 1024),
      nestedProviderPayload: { secret: 'y'.repeat(512 * 1024) },
    } as Parameters<typeof boundChannelAgentDetail>[1] &
      Record<string, unknown>;

    const detail = boundChannelAgentDetail('reason-known-fields', pollutedCard);
    expect(detail.card).toEqual({
      kind: 'thought',
      title: 'thinking',
      status: 'running',
      content: 'bounded thought',
      sizeBytes: 15,
    });
    expect(detail.card).not.toHaveProperty('providerPayload');
    expect(detail.card).not.toHaveProperty('nestedProviderPayload');
    expect(Buffer.byteLength(JSON.stringify(detail), 'utf8')).toBeLessThan(
      CHANNEL_AGENT_DETAIL_MAX_BYTES
    );
  });

  it('bounds live card and reasoning accumulators and reports detail retention', () => {
    const { store, hub } = makeStore();
    const adapter = new MockProtocolAdapterV2();
    let retained: ChannelBridgeRetentionSnapshot | null = null;
    bindSessionToChannel({
      channelId: 'topic:detail-retention',
      agentFramework: 'codex',
      adapter,
      store,
      hub,
      onRetentionSnapshot: (snapshot) => {
        retained = snapshot;
      },
    });
    adapter.broadcastPatch(reasoningStarted('s', 'turn', 'reason'));
    for (let index = 0; index < 4; index++) {
      adapter.broadcastPatch({
        type: 'agent-item-delta-v2',
        sessionId: 's',
        timestamp: 't',
        turnId: 'turn',
        itemId: 'reason',
        delta: { summary: `${index}:${'x'.repeat(128 * 1024)}` },
      });
    }

    expect(retained).toMatchObject({
      openDetailStreams: 1,
      detailItemIds: 1,
      turnsWithRows: 1,
    });
    expect(retained!.retainedDetailBytes).toBeLessThan(200 * 1024);
    expect(
      store.history('topic:detail-retention')[0]?.agentDetail?.card.content
        ?.length
    ).toBeLessThanOrEqual(64 * 1024);

    adapter.broadcastPatch(turnCompleted('s', 'turn'));
    expect(retained).toEqual({
      openStreams: 0,
      openDetailStreams: 0,
      assistantItemIds: 0,
      detailItemIds: 0,
      turnsWithRows: 0,
      retainedTextBytes: 0,
      retainedDetailBytes: 0,
    });
  });

  it.each(
    (['completed', 'failed', 'interrupted'] as const).flatMap((turnStatus) =>
      (['completed', 'failed', 'cancelled'] as const).map((itemStatus) => [
        turnStatus,
        itemStatus,
      ])
    )
  )(
    'allows provisional turn %s to transition once to explicit item %s',
    (turnStatus, itemStatus) => {
      const { store, hub } = makeStore();
      const adapter = new MockProtocolAdapterV2();
      const completeBroadcast = vi.spyOn(hub, 'completeStreamBroadcast');
      bindSessionToChannel({
        channelId: 'topic:detail-terminal-matrix',
        agentFramework: 'codex',
        adapter,
        store,
        hub,
      });
      adapter.broadcastPatch(reasoningStarted('s', 'turn', 'reason'));
      adapter.broadcastPatch({
        type: 'agent-turn-completed-v2',
        sessionId: 's',
        timestamp: 't',
        turnId: 'turn',
        status: turnStatus,
      });

      adapter.broadcastPatch(
        reasoningUpdated(
          's',
          'turn',
          'reason',
          itemStatus,
          `first explicit ${itemStatus}`
        )
      );
      const explicitRowStatus =
        itemStatus === 'completed'
          ? 'complete'
          : itemStatus === 'failed'
            ? 'failed'
            : 'interrupted';
      expect(store.history('topic:detail-terminal-matrix')).toEqual([
        expect.objectContaining({
          status: explicitRowStatus,
          agentDetail: expect.objectContaining({
            card: expect.objectContaining({
              status: itemStatus,
              content: `first explicit ${itemStatus}`,
            }),
          }),
        }),
      ]);

      // Explicit terminal is absorbing: duplicate/conflicting replay cannot
      // rewrite either row status or card payload.
      adapter.broadcastPatch(
        reasoningUpdated('s', 'turn', 'reason', 'failed', 'conflicting replay')
      );
      expect(store.history('topic:detail-terminal-matrix')[0]).toMatchObject({
        status: explicitRowStatus,
        agentDetail: {
          card: {
            status: itemStatus,
            content: `first explicit ${itemStatus}`,
          },
        },
      });
      expect(completeBroadcast).toHaveBeenCalledTimes(2);
    }
  );

  it('lets a restart-provisional detail resolve once, then absorbs replay', () => {
    const { store, hub } = makeStore();
    const firstAdapter = new MockProtocolAdapterV2();
    const unbindFirst = bindSessionToChannel({
      channelId: 'topic:detail-restart',
      agentFramework: 'codex',
      adapter: firstAdapter,
      store,
      hub,
    });
    firstAdapter.broadcastPatch(reasoningStarted('s', 'turn', 'reason'));
    store.sweepStaleStreaming();
    unbindFirst();
    expect(store.history('topic:detail-restart')[0]).toMatchObject({
      status: 'truncated',
      meta: { truncationReason: 'restart' },
      agentDetail: { card: { status: 'cancelled' } },
    });

    const resumedAdapter = new MockProtocolAdapterV2();
    bindSessionToChannel({
      channelId: 'topic:detail-restart',
      agentFramework: 'codex',
      adapter: resumedAdapter,
      store,
      hub,
    });
    resumedAdapter.broadcastPatch(
      reasoningUpdated('s', 'turn', 'reason', 'completed', 'resumed terminal')
    );
    resumedAdapter.broadcastPatch(
      reasoningUpdated('s', 'turn', 'reason', 'failed', 'late conflict')
    );
    expect(store.history('topic:detail-restart')[0]).toMatchObject({
      status: 'complete',
      agentDetail: {
        card: { status: 'completed', content: 'resumed terminal' },
      },
    });
    expect(store.history('topic:detail-restart')[0]?.meta).toBeUndefined();
  });

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
        openDetailStreams: 0,
        assistantItemIds: 0,
        detailItemIds: 0,
        turnsWithRows: 0,
        retainedTextBytes: 0,
        retainedDetailBytes: 0,
      });
    }

    expect(store.getChannelSummary('topic:retention')?.messageCount).toBe(250);
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
    expect(messages).toHaveLength(5);
    expect(messages.filter((row) => row.agentDetail)).toHaveLength(4);
    const message = messages.find((row) => !row.agentDetail)!;
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
    expect(messages).toHaveLength(10);
    const prose = messages.filter((message) => !message.agentDetail);
    const claude = prose.find((m) => m.sender.id === 'agent:claude');
    const codex = prose.find((m) => m.sender.id === 'agent:codex');
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
      openDetailStreams: 0,
      assistantItemIds: 0,
      detailItemIds: 0,
      turnsWithRows: 0,
      retainedTextBytes: 0,
      retainedDetailBytes: 0,
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
    adapter.broadcastPatch(textDelta('s', 'turn-a', 'item-a', 'partial a'));
    adapter.broadcastPatch(textDelta('s', 'turn-b', 'item-b', 'partial b'));
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
      openDetailStreams: 0,
      assistantItemIds: 0,
      detailItemIds: 0,
      turnsWithRows: 0,
      retainedTextBytes: 0,
      retainedDetailBytes: 0,
    });
  });

  it('finalizes an open stream as truncated when the session is unbound mid-stream', () => {
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
      status: 'truncated',
      body: { text: 'hi' },
      meta: { truncationReason: 'missing-terminal' },
    });
    expect(messages[0]?.truncated).toBeUndefined();
  });

  it('treats a duplicate final after turn completion as a pure no-op', () => {
    const { store, hub } = makeStore();
    const adapter = new MockProtocolAdapterV2();
    const beginBroadcast = vi.spyOn(hub, 'beginStreamBroadcast');
    const completeBroadcast = vi.spyOn(hub, 'completeStreamBroadcast');
    const onAssistantMessageFinalized = vi.fn();
    let retained: ChannelBridgeRetentionSnapshot | null = null;
    bindSessionToChannel({
      channelId: 'topic:r',
      agentFramework: 'claude',
      adapter,
      store,
      hub,
      onAssistantMessageFinalized,
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
    expect(onAssistantMessageFinalized).toHaveBeenCalledOnce();
    expect(retained).toEqual({
      openStreams: 0,
      openDetailStreams: 0,
      assistantItemIds: 0,
      detailItemIds: 0,
      turnsWithRows: 0,
      retainedTextBytes: 0,
      retainedDetailBytes: 0,
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
      textDelta('session-gemini', 'turn-replay', 'item-replay', 'replay')
    );
    replayAdapter.broadcastPatch(
      assistantStarted('session-gemini', 'turn-replay', 'item-replay')
    );
    replayAdapter.broadcastPatch(
      textDelta('session-gemini', 'turn-replay', 'item-replay', 'replay')
    );

    expect(beginStore).toHaveBeenCalledTimes(1);
    expect(beginBroadcast).not.toHaveBeenCalled();
    expect(store.history('topic:replay')).toHaveLength(1);
    expect(retained).toEqual({
      openStreams: 0,
      openDetailStreams: 0,
      assistantItemIds: 0,
      detailItemIds: 0,
      turnsWithRows: 0,
      retainedTextBytes: 0,
      retainedDetailBytes: 0,
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
    adapter.broadcastPatch(
      textDelta('session-gemini', `turn-${newest}`, `item-${newest}`, 'replay')
    );
    expect(beginStore).not.toHaveBeenCalled();

    // The oldest tombstone was evicted, so one durable lookup refreshes it;
    // subsequent replay is served by the bounded tombstone without another hit.
    adapter.broadcastPatch(
      assistantStarted('session-gemini', 'turn-0', 'item-0')
    );
    adapter.broadcastPatch(
      textDelta('session-gemini', 'turn-0', 'item-0', 'replay')
    );
    adapter.broadcastPatch(
      assistantStarted('session-gemini', 'turn-0', 'item-0')
    );
    adapter.broadcastPatch(
      textDelta('session-gemini', 'turn-0', 'item-0', 'replay')
    );
    expect(beginStore).toHaveBeenCalledOnce();
    expect(beginBroadcast).not.toHaveBeenCalled();
    expect(retained).toEqual({
      openStreams: 0,
      openDetailStreams: 0,
      assistantItemIds: 0,
      detailItemIds: 0,
      turnsWithRows: 0,
      retainedTextBytes: 0,
      retainedDetailBytes: 0,
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

  it('marks a partial row truncated when turn completion races ahead of its terminal item', () => {
    const { store, hub } = makeStore();
    const adapter = new MockProtocolAdapterV2();
    bindSessionToChannel({
      channelId: 'topic:turn-race',
      agentFramework: 'codex',
      adapter,
      store,
      hub,
    });
    adapter.broadcastPatch(assistantStarted('s', 'turn', 'message'));
    adapter.broadcastPatch(
      textDelta('s', 'turn', 'message', 'Partial handoff')
    );
    adapter.broadcastPatch(turnCompleted('s', 'turn'));
    // A late terminal item can no longer silently relabel the partial row as
    // complete or create a duplicate after the source identity was released.
    adapter.broadcastPatch(
      assistantUpdated('s', 'turn', 'message', 'Complete handoff text.')
    );

    expect(store.history('topic:turn-race')).toEqual([
      expect.objectContaining({
        status: 'truncated',
        body: { text: 'Partial handoff', format: 'markdown' },
        meta: { truncationReason: 'missing-terminal' },
      }),
    ]);
    expect(store.history('topic:turn-race')[0]?.truncated).toBeUndefined();
  });

  it('persists the terminal item before releasing and broadcasting turn completion', () => {
    const { store, hub } = makeStore();
    const adapter = new MockProtocolAdapterV2();
    const finalizeStore = vi.spyOn(store, 'finalizeStream');
    const completeBroadcast = vi.spyOn(hub, 'completeStreamBroadcast');
    bindSessionToChannel({
      channelId: 'topic:write-ahead',
      agentFramework: 'codex',
      adapter,
      store,
      hub,
    });
    adapter.broadcastPatch(assistantStarted('s', 'turn', 'message'));
    adapter.broadcastPatch(textDelta('s', 'turn', 'message', 'Partial'));
    adapter.broadcastPatch(
      assistantUpdated('s', 'turn', 'message', 'Final durable handoff.')
    );

    expect(store.history('topic:write-ahead')).toEqual([
      expect.objectContaining({
        status: 'complete',
        body: { text: 'Final durable handoff.', format: 'markdown' },
      }),
    ]);
    expect(finalizeStore.mock.invocationCallOrder[0]).toBeLessThan(
      completeBroadcast.mock.invocationCallOrder[0]!
    );
    adapter.broadcastPatch(turnCompleted('s', 'turn'));
    expect(finalizeStore).toHaveBeenCalledOnce();
  });

  it('resolves substantial streaming output as truncated on idle fallback', () => {
    const { store, hub } = makeStore();
    const adapter = new MockProtocolAdapterV2();
    bindSessionToChannel({
      channelId: 'topic:idle',
      agentFramework: 'codex',
      adapter,
      store,
      hub,
    });
    adapter.broadcastPatch(assistantStarted('s', 'turn', 'message'));
    adapter.broadcastPatch(textDelta('s', 'turn', 'message', 'Still open'));
    adapter.broadcastPatch({
      type: 'agent-live-state-updated-v2',
      sessionId: 's',
      timestamp: 't',
      live: {
        status: 'idle',
        activeTurnId: 'turn',
        waitingOn: null,
        activeRequestIds: [],
        proposedPlanItemId: null,
        queueLength: 0,
        fastModeAvailable: false,
        error: null,
      },
    });

    expect(store.history('topic:idle')).toEqual([
      expect.objectContaining({
        status: 'truncated',
        meta: { truncationReason: 'missing-terminal' },
      }),
    ]);
    expect(store.history('topic:idle')[0]?.truncated).toBeUndefined();
  });

  it('resolves an empty streaming row as truncated on idle fallback', () => {
    const { store, hub } = makeStore();
    const adapter = new MockProtocolAdapterV2();
    bindSessionToChannel({
      channelId: 'topic:idle-empty',
      agentFramework: 'codex',
      adapter,
      store,
      hub,
    });
    adapter.broadcastPatch(assistantStarted('s', 'turn', 'message'));
    adapter.broadcastPatch({
      type: 'agent-live-state-updated-v2',
      sessionId: 's',
      timestamp: 't',
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
    });

    expect(store.history('topic:idle-empty')).toEqual([
      expect.objectContaining({
        status: 'truncated',
        body: { text: '', format: 'markdown' },
        meta: { truncationReason: 'missing-terminal' },
      }),
    ]);
  });

  it('materializes an empty assistant start as truncated when its terminal item is missing', () => {
    const { store, hub } = makeStore();
    const adapter = new MockProtocolAdapterV2();
    let retained: ChannelBridgeRetentionSnapshot | null = null;
    bindSessionToChannel({
      channelId: 'topic:empty-start',
      agentFramework: 'codex',
      adapter,
      store,
      hub,
      onRetentionSnapshot: (snapshot) => {
        retained = snapshot;
      },
    });
    adapter.broadcastPatch(assistantStarted('s', 'turn', 'message'));
    adapter.broadcastPatch(turnCompleted('s', 'turn'));

    expect(store.history('topic:empty-start')).toEqual([
      expect.objectContaining({
        status: 'truncated',
        body: { text: '', format: 'markdown' },
        meta: { truncationReason: 'missing-terminal' },
      }),
    ]);
    expect(store.history('topic:empty-start')[0]?.truncated).toBeUndefined();
    expect(retained).toEqual({
      openStreams: 0,
      openDetailStreams: 0,
      assistantItemIds: 0,
      detailItemIds: 0,
      turnsWithRows: 0,
      retainedTextBytes: 0,
      retainedDetailBytes: 0,
    });
  });

  it('canonicalizes provider-item aliases to one durable row', () => {
    const { store, hub } = makeStore();
    const adapter = new MockProtocolAdapterV2();
    const onAssistantMessageFinalized = vi.fn();
    bindSessionToChannel({
      channelId: 'topic:aliases',
      agentFramework: 'claude',
      adapter,
      store,
      hub,
      onAssistantMessageFinalized,
    });
    for (const itemId of ['relay-message-0', 'relay-message-1']) {
      adapter.broadcastPatch({
        type: 'agent-item-started-v2',
        sessionId: 's',
        timestamp: 't',
        turnId: 'turn',
        item: {
          type: 'assistantMessage',
          id: itemId,
          providerItemId: 'provider-item',
          text: '',
          status: 'running',
        },
      });
    }
    adapter.broadcastPatch(
      textDelta('s', 'turn', 'relay-message-0', 'Live partial')
    );
    adapter.broadcastPatch({
      type: 'agent-item-updated-v2',
      sessionId: 's',
      timestamp: 't',
      turnId: 'turn',
      item: {
        type: 'assistantMessage',
        id: 'relay-message-1',
        providerItemId: 'provider-item',
        text: 'Canonical final.',
        status: 'completed',
        completedAt: 't',
      },
    });
    adapter.broadcastPatch(turnCompleted('s', 'turn'));

    expect(store.history('topic:aliases')).toEqual([
      expect.objectContaining({
        status: 'complete',
        body: { text: 'Canonical final.', format: 'markdown' },
        source: expect.objectContaining({ itemId: 'provider-item' }),
      }),
    ]);
    expect(onAssistantMessageFinalized).toHaveBeenCalledOnce();
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

  it('stores agent-produced imageView output as a sender-neutral image part', async () => {
    const { store, hub } = makeStore();
    const adapter = new MockProtocolAdapterV2();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-agent-image-'));
    cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const source = path.join(dir, 'generated.png');
    fs.writeFileSync(source, Buffer.from('agent image fixture'));
    const part: ChannelImagePart = {
      type: 'image',
      id: 'cha:agent-image',
      mime: 'image/png',
      w: 2,
      h: 3,
      bytes: 19,
    };
    const attachmentStore = {
      ingest: vi.fn(async () => part),
    } as unknown as ChannelAttachmentStore;
    bindSessionToChannel({
      channelId: 'topic:image',
      agentFramework: 'codex',
      adapter,
      store,
      attachmentStore,
      hub,
    });

    adapter.broadcastPatch({
      type: 'agent-item-started-v2',
      sessionId: 's',
      timestamp: 't',
      turnId: 'turn-image',
      item: {
        type: 'imageView',
        id: 'img-1',
        source,
        status: 'running',
      },
    });

    await vi.waitFor(() => {
      expect(store.history('topic:image')).toHaveLength(1);
    });
    expect(attachmentStore.ingest).toHaveBeenCalledWith({
      bytes: Buffer.from('agent image fixture'),
    });
    expect(store.history('topic:image')[0]).toMatchObject({
      status: 'complete',
      sender: { kind: 'agent', providerId: 'codex' },
      body: { text: '' },
      parts: [part],
      source: { sessionId: 's', turnId: 'turn-image', itemId: 'img-1' },
    });
  });

  it('captures the thread parent before a fast turn completion clears it', async () => {
    const { store, hub } = makeStore();
    const adapter = new MockProtocolAdapterV2();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-image-parent-'));
    cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const source = path.join(dir, 'generated.png');
    fs.writeFileSync(source, Buffer.from('agent image fixture'));
    const root = store.appendComplete({
      channelId: 'topic:image-parent',
      sender: { kind: 'human', id: 'human:operator' },
      text: 'root',
    });
    const part: ChannelImagePart = {
      type: 'image',
      id: 'cha:threaded-agent-image',
      mime: 'image/png',
      w: 2,
      h: 3,
      bytes: 19,
    };
    let releaseIngest!: (part: ChannelImagePart) => void;
    const ingest = new Promise<ChannelImagePart>((resolve) => {
      releaseIngest = resolve;
    });
    const attachmentStore = {
      ingest: vi.fn(() => ingest),
    } as unknown as ChannelAttachmentStore;
    let parentMessageId: string | undefined = root.id;
    bindSessionToChannel({
      channelId: 'topic:image-parent',
      agentFramework: 'codex',
      adapter,
      store,
      attachmentStore,
      hub,
      parentMessageIdForTurn: () => parentMessageId,
    });

    adapter.broadcastPatch({
      type: 'agent-item-started-v2',
      sessionId: 's',
      timestamp: 't',
      turnId: 'turn-fast',
      item: {
        type: 'imageView',
        id: 'img-fast',
        source,
        status: 'running',
      },
    });
    parentMessageId = undefined;
    adapter.broadcastPatch(turnCompleted('s', 'turn-fast'));
    releaseIngest(part);

    await vi.waitFor(() => {
      expect(store.history('topic:image-parent')).toHaveLength(2);
    });
    const image = store
      .history('topic:image-parent')
      .find((message) => message.source?.itemId === 'img-fast');
    expect(image).toMatchObject({
      threadId: root.id,
      parentMessageId: root.id,
      parts: [part],
    });
  });

  it('waits for same-turn image ingest before routing an assistant mention', async () => {
    const { store, hub } = makeStore();
    const adapter = new MockProtocolAdapterV2();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-image-mention-'));
    cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const source = path.join(dir, 'generated.png');
    fs.writeFileSync(source, Buffer.from('agent image fixture'));
    const part: ChannelImagePart = {
      type: 'image',
      id: 'cha:mention-agent-image',
      mime: 'image/png',
      w: 2,
      h: 3,
      bytes: 19,
    };
    let releaseIngest!: (part: ChannelImagePart) => void;
    const ingest = new Promise<ChannelImagePart>((resolve) => {
      releaseIngest = resolve;
    });
    const attachmentStore = {
      ingest: vi.fn(() => ingest),
    } as unknown as ChannelAttachmentStore;
    const finalized = vi.fn();
    bindSessionToChannel({
      channelId: 'topic:image-mention',
      agentFramework: 'codex',
      adapter,
      store,
      attachmentStore,
      hub,
      onAssistantMessageFinalized: finalized,
    });

    adapter.broadcastPatch({
      type: 'agent-item-started-v2',
      sessionId: 's',
      timestamp: 't',
      turnId: 'turn-mention',
      item: {
        type: 'imageView',
        id: 'img-mention',
        source,
        status: 'running',
      },
    });
    adapter.broadcastPatch(assistantStarted('s', 'turn-mention', 'a-mention'));
    adapter.broadcastPatch(
      assistantUpdated(
        's',
        'turn-mention',
        'a-mention',
        '@hermes describe this image'
      )
    );
    adapter.broadcastPatch(turnCompleted('s', 'turn-mention'));
    expect(finalized).not.toHaveBeenCalled();

    releaseIngest(part);
    await vi.waitFor(() => expect(finalized).toHaveBeenCalledTimes(1));
    const routed = finalized.mock.calls[0]![0] as ChannelMessage;
    expect(routed.body.text).toBe('@hermes describe this image');
    expect(routed.parts).toEqual([part]);
    const durable = store.history('topic:image-mention');
    const assistant = durable.find(
      (message) => message.source?.itemId === 'a-mention'
    )!;
    const image = durable.find(
      (message) => message.source?.itemId === 'img-mention'
    )!;
    expect(routed.seq).toBe(assistant.seq);
    expect(image.seq).toBeGreaterThan(assistant.seq);
  });

  it('holds an assistant mention for an imageView that starts later in the turn', async () => {
    const { store, hub } = makeStore();
    const adapter = new MockProtocolAdapterV2();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-late-image-'));
    cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const source = path.join(dir, 'late.png');
    fs.writeFileSync(source, Buffer.from('late image fixture'));
    const part: ChannelImagePart = {
      type: 'image',
      id: 'cha:late-agent-image',
      mime: 'image/png',
      w: 3,
      h: 2,
      bytes: 18,
    };
    let releaseIngest!: (part: ChannelImagePart) => void;
    const ingest = new Promise<ChannelImagePart>((resolve) => {
      releaseIngest = resolve;
    });
    const attachmentStore = {
      ingest: vi.fn(() => ingest),
    } as unknown as ChannelAttachmentStore;
    const finalized = vi.fn();
    bindSessionToChannel({
      channelId: 'topic:late-image',
      agentFramework: 'codex',
      adapter,
      store,
      attachmentStore,
      hub,
      onAssistantMessageFinalized: finalized,
    });

    adapter.broadcastPatch(assistantStarted('s', 'turn-late', 'a-late'));
    adapter.broadcastPatch(
      assistantUpdated(
        's',
        'turn-late',
        'a-late',
        '@hermes inspect the later image'
      )
    );
    expect(finalized).not.toHaveBeenCalled();

    adapter.broadcastPatch({
      type: 'agent-item-started-v2',
      sessionId: 's',
      timestamp: 't',
      turnId: 'turn-late',
      item: {
        type: 'imageView',
        id: 'img-late',
        source,
        status: 'running',
      },
    });
    adapter.broadcastPatch(turnCompleted('s', 'turn-late'));
    expect(finalized).not.toHaveBeenCalled();

    releaseIngest(part);
    await vi.waitFor(() => expect(finalized).toHaveBeenCalledTimes(1));
    const routed = finalized.mock.calls[0]![0] as ChannelMessage;
    expect(routed.body.text).toBe('@hermes inspect the later image');
    expect(routed.parts).toEqual([part]);
    const durable = store.history('topic:late-image');
    const assistant = durable.find(
      (message) => message.source?.itemId === 'a-late'
    )!;
    const image = durable.find(
      (message) => message.source?.itemId === 'img-late'
    )!;
    expect(routed.seq).toBe(assistant.seq);
    expect(image.seq).toBeGreaterThan(assistant.seq);
  });

  it('states an @-filename failure without creating an extra mention', async () => {
    const { store, hub } = makeStore();
    const adapter = new MockProtocolAdapterV2();
    const finalized = vi.fn();
    bindSessionToChannel({
      channelId: 'topic:failed-image',
      agentFramework: 'codex',
      adapter,
      store,
      attachmentStore: {
        ingest: vi.fn(),
      } as unknown as ChannelAttachmentStore,
      hub,
      onAssistantMessageFinalized: finalized,
    });

    adapter.broadcastPatch(assistantStarted('s', 'turn-failed', 'a-failed'));
    adapter.broadcastPatch(
      assistantUpdated(
        's',
        'turn-failed',
        'a-failed',
        '@hermes inspect the missing image'
      )
    );
    adapter.broadcastPatch({
      type: 'agent-item-started-v2',
      sessionId: 's',
      timestamp: 't',
      turnId: 'turn-failed',
      item: {
        type: 'imageView',
        id: 'img-failed',
        source: '/missing/@claude.png',
        status: 'running',
      },
    });
    adapter.broadcastPatch(turnCompleted('s', 'turn-failed'));

    await vi.waitFor(() => expect(finalized).toHaveBeenCalledTimes(1));
    const routed = finalized.mock.calls[0]![0] as ChannelMessage;
    expect(routed.parts).toBeUndefined();
    expect(routed.body.text).toBe('@hermes inspect the missing image');
    expect(routed.meta?.[PACKET_IMAGE_DEGRADATION_META_KEY]).toEqual([
      '@claude.png',
    ]);
    expect(
      parseMentions(routed.body.text, ['hermes', 'claude']).map(
        (mention) => mention.providerId
      )
    ).toEqual(['hermes']);
    const packet = buildMentionContextPacketEnvelope({
      channelTitle: 'failed-image',
      framework: 'hermes',
      rows: [],
      trigger: routed,
      lastDeliveredSeq: 0,
    });
    expect(packet.content).toContain(
      '[Relay image attachment unavailable: @claude.png]'
    );
    expect(
      store
        .history('topic:failed-image')
        .find((message) => message.source?.itemId === 'img-failed')?.body.text
    ).toBe('[Agent image unavailable: @claude.png]');
  });

  it('caps agent-produced images per turn and states the omission once', async () => {
    const { store, hub } = makeStore();
    const adapter = new MockProtocolAdapterV2();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-image-cap-'));
    cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const source = path.join(dir, 'generated.png');
    fs.writeFileSync(source, Buffer.from('agent image fixture'));
    const part: ChannelImagePart = {
      type: 'image',
      id: 'cha:capped-agent-image',
      mime: 'image/png',
      w: 2,
      h: 3,
      bytes: 19,
    };
    const attachmentStore = {
      ingest: vi.fn(async () => part),
    } as unknown as ChannelAttachmentStore;
    bindSessionToChannel({
      channelId: 'topic:image-cap',
      agentFramework: 'codex',
      adapter,
      store,
      attachmentStore,
      hub,
    });

    for (
      let index = 0;
      index < CHANNEL_BRIDGE_IMAGE_MAX_PER_TURN + 3;
      index++
    ) {
      adapter.broadcastPatch({
        type: 'agent-item-started-v2',
        sessionId: 's',
        timestamp: 't',
        turnId: 'turn-image-cap',
        item: {
          type: 'imageView',
          id: `img-${index}`,
          source,
          status: 'running',
        },
      });
    }
    adapter.broadcastPatch(turnCompleted('s', 'turn-image-cap'));

    await vi.waitFor(() =>
      expect(attachmentStore.ingest).toHaveBeenCalledTimes(
        CHANNEL_BRIDGE_IMAGE_MAX_PER_TURN
      )
    );
    await vi.waitFor(() =>
      expect(store.history('topic:image-cap')).toHaveLength(
        CHANNEL_BRIDGE_IMAGE_MAX_PER_TURN + 1
      )
    );
    const messages = store.history('topic:image-cap');
    expect(messages.filter((message) => message.parts?.length)).toHaveLength(
      CHANNEL_BRIDGE_IMAGE_MAX_PER_TURN
    );
    expect(
      messages.filter(
        (message) =>
          message.kind === 'system' &&
          message.body.text ===
            `One or more agent images were omitted after the per-turn limit of ${CHANNEL_BRIDGE_IMAGE_MAX_PER_TURN}.`
      )
    ).toHaveLength(1);
  });

  it('drops a deferred clean callback on unbind when no terminal arrives', () => {
    const { store, hub } = makeStore();
    const adapter = new MockProtocolAdapterV2();
    const finalized = vi.fn();
    const unbind = bindSessionToChannel({
      channelId: 'topic:deferred-unbind',
      agentFramework: 'codex',
      adapter,
      store,
      hub,
      onAssistantMessageFinalized: finalized,
    });
    adapter.broadcastPatch(assistantStarted('s', 'turn-unbind', 'a-unbind'));
    adapter.broadcastPatch(
      assistantUpdated(
        's',
        'turn-unbind',
        'a-unbind',
        '@hermes never route this'
      )
    );
    expect(finalized).not.toHaveBeenCalled();

    unbind();
    expect(finalized).not.toHaveBeenCalled();
  });

  it('mirrors reasoning and command items as stable typed channel cards', () => {
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
    adapter.broadcastPatch(turnCompleted('s', 'turn'));

    const details = store.history('topic:n');
    expect(details).toHaveLength(2);
    expect(details.map((message) => message.source?.itemId)).toEqual([
      'c1',
      'r1',
    ]);
    expect(details.map((message) => message.agentDetail)).toEqual([
      expect.objectContaining({
        itemId: 'c1',
        card: expect.objectContaining({
          kind: 'output',
          title: 'ls',
          status: 'completed',
        }),
      }),
      expect.objectContaining({
        itemId: 'r1',
        card: expect.objectContaining({
          kind: 'thought',
          content: 'thinking',
          status: 'completed',
        }),
      }),
    ]);
  });

  it('preserves reasoning deltas when turn completion supplies the terminal boundary', () => {
    const { store, hub } = makeStore();
    const adapter = new MockProtocolAdapterV2();
    bindSessionToChannel({
      channelId: 'topic:reasoning',
      agentFramework: 'codex',
      adapter,
      store,
      hub,
    });
    adapter.broadcastPatch({
      type: 'agent-item-started-v2',
      sessionId: 's',
      timestamp: 't',
      turnId: 'turn',
      item: {
        type: 'reasoning',
        id: 'reason-1',
        providerItemId: 'provider-reason-1',
        summary: '',
        status: 'running',
      },
    });
    adapter.broadcastPatch({
      type: 'agent-item-delta-v2',
      sessionId: 's',
      timestamp: 't',
      turnId: 'turn',
      itemId: 'reason-1',
      delta: { summary: 'inspect ', detail: 'inspect the live channel' },
    });
    adapter.broadcastPatch(turnCompleted('s', 'turn'));

    const [message] = store.history('topic:reasoning');
    expect(message).toMatchObject({
      seq: 1,
      status: 'complete',
      source: {
        sessionId: 's',
        turnId: 'turn',
        itemId: 'provider-reason-1',
      },
      agentDetail: {
        itemId: 'provider-reason-1',
        card: {
          kind: 'thought',
          status: 'completed',
          content: 'inspect the live channel',
        },
      },
    });
  });

  it('applies a late authoritative detail update without appending a second row', () => {
    const { store, hub } = makeStore();
    const adapter = new MockProtocolAdapterV2();
    bindSessionToChannel({
      channelId: 'topic:late-detail',
      agentFramework: 'codex',
      adapter,
      store,
      hub,
    });
    adapter.broadcastPatch({
      type: 'agent-item-started-v2',
      sessionId: 's',
      timestamp: 't',
      turnId: 'turn',
      item: {
        type: 'reasoning',
        id: 'reason-1',
        summary: '',
        status: 'running',
      },
    });
    adapter.broadcastPatch(turnCompleted('s', 'turn'));
    const before = store.history('topic:late-detail')[0]!;

    adapter.broadcastPatch({
      type: 'agent-item-updated-v2',
      sessionId: 's',
      timestamp: 't2',
      turnId: 'turn',
      item: {
        type: 'reasoning',
        id: 'reason-1',
        summary: 'late provider summary',
        detail: 'late authoritative reasoning detail',
        status: 'completed',
      },
    });

    const after = store.history('topic:late-detail');
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({
      id: before.id,
      seq: before.seq,
      agentDetail: {
        itemId: 'reason-1',
        card: {
          kind: 'thought',
          status: 'completed',
          content: 'late authoritative reasoning detail',
        },
      },
    });
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
      status: 'truncated',
      truncated: true,
      body: { text: 'start ' },
      meta: { truncationReason: 'size-limit' },
    });
  });
});
