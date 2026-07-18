import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { MockProtocolAdapterV2 } from '../server/protocol-adapters/mock-v2-adapter.js';
import type { AdapterConfig } from '../server/protocol-adapter-v2.js';
import type { AgentPatchV2 } from '../shared/agent-chat-protocol-v2.js';
import {
  createChannelMessageStore,
  type ChannelMessageStore,
} from '../server/channel-message-store.js';
import { createChannelHub, type ChannelHub } from '../server/channel-hub.js';
import { bindSessionToChannel } from '../server/channel-agent-bridge.js';

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

describe('channel-agent-bridge lifecycle', () => {
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
    bindSessionToChannel({
      channelId: 'topic:e',
      agentFramework: 'claude',
      adapter,
      store,
      hub,
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

  it('does not double-commit on re-emitted patches (source triple dedupe)', () => {
    const { store, hub } = makeStore();
    const adapter = new MockProtocolAdapterV2();
    bindSessionToChannel({
      channelId: 'topic:r',
      agentFramework: 'claude',
      adapter,
      store,
      hub,
    });
    adapter.broadcastPatch(assistantStarted('s', 'turn', 'a1'));
    adapter.broadcastPatch(assistantStarted('s', 'turn', 'a1')); // re-emit
    adapter.broadcastPatch(assistantUpdated('s', 'turn', 'a1', 'full'));
    adapter.broadcastPatch(assistantUpdated('s', 'turn', 'a1', 'full-again')); // stream closed

    const messages = store.history('topic:r');
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      status: 'complete',
      body: { text: 'full' },
    });
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
