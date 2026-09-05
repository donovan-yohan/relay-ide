import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';

import Database from 'better-sqlite3';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MockProtocolAdapterV2 } from '../server/protocol-adapters/mock-v2-adapter.js';
import { CHANNEL_ADAPTER_LAUNCH_CONTRACTS } from '../server/protocol-adapters/index.js';
import {
  AgentControlUnavailableError,
  AgentSteerRejectedError,
  BaseProtocolAdapterV2,
  type AdapterConfig,
  type AdapterStatus,
  type AgentApprovalResponseInputV2,
  type AgentInterruptInputV2,
  type AgentSendMessageInputV2,
  type ProtocolAdapterV2,
} from '../server/protocol-adapter-v2.js';
import type { AgentCapabilitySetV2 } from '../shared/agent-chat-protocol-v2.js';
import type { AgentRole } from '../shared/agent-roster.js';
import {
  builtInAgentProfileId,
  computeMentionDisambiguators,
} from '../shared/agent-profile.js';
import { relayControlCatalogForProvider } from '../shared/agent-command-catalog.js';
import {
  dmChannelCreateInput,
  dmChannelTopicId,
} from '../shared/dm-channels.js';
import {
  createAgentProfileStore,
  type AgentProfileStore,
} from '../server/agent-profile-store.js';
import {
  CHANNEL_HISTORY_MAX_LIMIT,
  createChannelMessageStore,
  type ChannelMessageStore,
} from '../server/channel-message-store.js';
import { createChannelHub, type ChannelHub } from '../server/channel-hub.js';
import { PACKET_MAX_ROWS } from '../server/channel-context-packet.js';
import type { ChannelAttachmentStore } from '../server/channel-attachments.js';
import {
  CHANNEL_BINDING_YOLO_DEFAULT,
  ChannelAgentBusyError,
  createChannelAgentBinder,
  MAX_CONSECUTIVE_AGENT_TURNS,
  type BinderRuntimes,
  type ChannelAgentBinder,
  type MentionTarget,
} from '../server/channel-agent-binder.js';
import type {
  ChannelAgentRuntime,
  CreateChannelAgentRuntimeParams,
} from '../server/channel-agent-runtime.js';
import {
  createWorkspaceTopicStore,
  createWorkspaceTopicsRouter,
  type WorkspaceTopicStore,
} from '../server/workspace-topics.js';
import {
  channelTurnId,
  parseMentions,
  CHANNEL_RETRY_OF_META_KEY,
  type ChannelDeliveryReceiptV1,
  type ChannelAttachmentId,
  type ChannelImagePart,
  type ChannelMessage,
  type ChannelSenderRef,
} from '../shared/channel-chat-protocol.js';

const CHANNEL_COMMAND_CONTRACTS: Array<[string, string]> = Object.entries(
  CHANNEL_ADAPTER_LAUNCH_CONTRACTS
).flatMap(([providerId, contract]) =>
  contract.requirement.kind === 'command'
    ? [[providerId, contract.requirement.command]]
    : []
);

const cleanup: Array<() => void> = [];
afterEach(() => {
  while (cleanup.length > 0) cleanup.pop()?.();
});

describe('channel-agent-binder — durable delegation completion callbacks', () => {
  const callbackTargets = ['a', 'b', 'c', 'd'].map((id) => ({
    id,
    displayName: id.toUpperCase(),
    kind: 'framework' as const,
    available: true,
    reason: null,
  }));
  const A: ChannelSenderRef = {
    kind: 'agent',
    id: builtInAgentProfileId('a'),
    providerId: 'a',
    displayName: 'A',
  };

  it('blocks archive from callback scheduling through requester binding admission', async () => {
    let releaseSpawn!: () => void;
    const spawnGate = new Promise<void>((resolve) => {
      releaseSpawn = resolve;
    });
    const topics = createWorkspaceTopicStore({ dbPath: ':memory:' });
    cleanup.push(() => topics.close());
    topics.create({ id: CH, workspaceId: 'ws:test', title: 'Test' });
    const { binder, store } = makeBinder({
      build: (provider) =>
        new ScriptedAdapter(
          provider,
          provider === 'a'
            ? { mode: 'reply', text: 'callback acknowledged' }
            : { mode: 'stall' }
        ),
      targets: callbackTargets,
      knownProviderIds: ['a', 'b', 'c', 'd'],
      topicStore: topics,
      gate: spawnGate,
    });
    const trigger = store.appendComplete({
      channelId: CH,
      sender: OPERATOR,
      text: 'durable callback trigger',
    });
    const edge = store.createCompletionCallback({
      id: 'chcb:archive-window',
      channelId: CH,
      threadId: null,
      triggerMessageId: trigger.id,
      requesterProfileId: builtInAgentProfileId('a'),
      targetProfileId: builtInAgentProfileId('b'),
      targetRuntimeId: 'runtime:b',
      targetTurnId: 'turn:archive-window',
    });
    store.satisfyCompletionCallback({
      channelId: edge.channelId,
      targetProfileId: edge.targetProfileId,
      targetTurnId: edge.targetTurnId,
      terminalReason: 'completed',
      messageDisposition: 'no-terminal-message',
    });

    // Recovery schedules claim on setTimeout(0). Before that timer can run,
    // the requester's channel is already authoritatively active.
    await binder.recoverCompletionCallbacks();
    expect(binder.archiveActivityForChannel(CH)).toMatchObject({
      active: true,
      reasons: expect.arrayContaining(['completion-callback']),
    });

    const app = express();
    app.use(express.json());
    app.use(
      createWorkspaceTopicsRouter({
        store: topics,
        channelArchiveActivity: (channelId) =>
          binder.archiveActivityForChannel(channelId),
      })
    );
    const server = http.createServer(app);
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve)
    );
    cleanup.push(() => server.close());
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('missing callback archive test address');
    }
    const response = await fetch(
      `http://127.0.0.1:${address.port}/workspace-topics/${encodeURIComponent(CH)}/archive`,
      {
        method: 'POST',
        headers: { 'x-relay-capabilities': 'context:write' },
      }
    );
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: 'SESSION_CONFLICT',
        details: { reasonCode: 'CHANNEL_ARCHIVE_AGENT_ACTIVE' },
      },
    });
    expect(topics.get(CH)?.status).toBe('active');

    releaseSpawn();
    await waitFor(
      () => store.getCompletionCallback(edge.id)?.state === 'consumed'
    );
    await waitFor(() => !binder.archiveActivityForChannel(CH).active);
  });

  it('terminalizes an unavailable requester once and releases the archive fence', async () => {
    const { binder, store, sessions } = makeBinder({
      build: (provider) => new ScriptedAdapter(provider, { mode: 'stall' }),
      targets: callbackTargets,
      knownProviderIds: ['a', 'b', 'c', 'd'],
    });
    const trigger = store.appendComplete({
      channelId: CH,
      sender: OPERATOR,
      text: 'missing requester callback',
    });
    const edge = store.createCompletionCallback({
      id: 'chcb:release-throws',
      channelId: CH,
      threadId: null,
      triggerMessageId: trigger.id,
      requesterProfileId: 'agent-profile:missing',
      targetProfileId: builtInAgentProfileId('b'),
      targetRuntimeId: 'runtime:b',
      targetTurnId: 'turn:release-throws',
    });
    store.satisfyCompletionCallback({
      channelId: edge.channelId,
      targetProfileId: edge.targetProfileId,
      targetTurnId: edge.targetTurnId,
      terminalReason: 'completed',
      messageDisposition: 'no-terminal-message',
    });
    const terminalize =
      store.terminalizeDeliveredCompletionCallback.bind(store);
    let terminalizeAttempts = 0;
    store.terminalizeDeliveredCompletionCallback = (input) => {
      terminalizeAttempts += 1;
      return terminalize(input);
    };

    await binder.recoverCompletionCallbacks();
    await waitFor(
      () => store.getCompletionCallback(edge.id)?.state === 'undeliverable'
    );
    expect(store.getCompletionCallback(edge.id)).toMatchObject({
      state: 'undeliverable',
      terminalReason: 'completed',
      deliveryReason: 'requester-profile-unavailable',
    });
    expect(binder.archiveActivityForChannel(CH)).toEqual({
      active: false,
      reasons: [],
    });
    expect(sessions.spawns()).toBe(0); // never fabricate a requester runtime
    await binder.recoverCompletionCallbacks();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(terminalizeAttempts).toBe(1);
    expect(store.claimSatisfiedCompletionCallbacks()).toEqual([]);
  });

  it('bounds unavailable-requester terminalization persistence retries without clearing archive safety', async () => {
    vi.useFakeTimers();
    try {
      const { binder, store } = makeBinder({
        build: (provider) => new ScriptedAdapter(provider, { mode: 'stall' }),
        targets: callbackTargets,
        knownProviderIds: ['a', 'b', 'c', 'd'],
      });
      const trigger = store.appendComplete({
        channelId: CH,
        sender: OPERATOR,
        text: 'persistence outage callback',
      });
      const edge = store.createCompletionCallback({
        id: 'chcb:terminalization-storage-outage',
        channelId: CH,
        threadId: null,
        triggerMessageId: trigger.id,
        requesterProfileId: 'agent-profile:missing',
        targetProfileId: builtInAgentProfileId('b'),
        targetRuntimeId: 'runtime:b',
        targetTurnId: 'turn:terminalization-storage-outage',
      });
      store.satisfyCompletionCallback({
        channelId: edge.channelId,
        targetProfileId: edge.targetProfileId,
        targetTurnId: edge.targetTurnId,
        terminalReason: 'completed',
        messageDisposition: 'no-terminal-message',
      });
      let attempts = 0;
      store.terminalizeDeliveredCompletionCallback = () => {
        attempts += 1;
        throw new Error('sqlite disk I/O error');
      };

      await binder.recoverCompletionCallbacks();
      await vi.advanceTimersByTimeAsync(0); // first claim + failed CAS
      expect(attempts).toBe(1);
      await vi.advanceTimersByTimeAsync(25 + 50 + 100 + 200);
      expect(attempts).toBe(5);
      // The fifth failed CAS escalates in memory but must not pretend the
      // durable row reached `undeliverable` or make the channel archivable.
      expect(store.getCompletionCallback(edge.id)).toMatchObject({
        state: 'delivered',
      });
      expect(binder.archiveActivityForChannel(CH)).toMatchObject({
        active: true,
        reasons: expect.arrayContaining([
          'completion-callback',
          'completion-callback-terminalization-failed',
        ]),
      });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(attempts).toBe(5);
    } finally {
      vi.useRealTimers();
    }
  });

  it('wakes a silent successful delegator exactly once with a typed internal trigger', async () => {
    const adapters = new Map<string, ScriptedAdapter>();
    const { binder, store } = makeBinder({
      build: (provider) => {
        const adapter = new ScriptedAdapter(
          provider,
          provider === 'b'
            ? { mode: 'reply', text: 'work complete' }
            : { mode: 'stall' }
        );
        adapters.set(provider, adapter);
        return adapter;
      },
      targets: callbackTargets,
      knownProviderIds: ['a', 'b', 'c', 'd'],
    });
    const delegated = postAgentTurnRow(
      store,
      binder,
      'a-delegates-b',
      'a-item',
      '@b investigate this',
      ['a', 'b', 'c', 'd'],
      'runtime:a',
      A
    );
    await waitFor(() => adapters.get('a')?.sendCalls.length === 1);
    const a = adapters.get('a')!;
    const b = adapters.get('b')!;
    expect(a.sendInputs[0]?.content).toContain(
      '[Relay internal completion callback]'
    );
    expect(a.sendInputs[0]?.content).toContain('terminalReason=completed');
    const bTurn = channelTurnId(delegated.id, builtInAgentProfileId('b'));
    expect(store.getCompletionCallback(`chcb:${bTurn}`)).toMatchObject({
      state: 'consumed',
      messageDisposition: 'final-message',
    });
    b.emitTerminal('completed'); // duplicate/late terminal patch
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(a.sendCalls).toHaveLength(1);
    // Internal callbacks never manufacture a chat row attributed to B or A.
    expect(
      rows(store).filter((row) => row.body.text.includes('internal completion'))
    ).toHaveLength(0);
  });

  it('uses B’s explicit final @A once and consumes the automatic duplicate', async () => {
    const adapters = new Map<string, ScriptedAdapter>();
    const { binder, store } = makeBinder({
      build: (provider) => {
        const adapter = new ScriptedAdapter(
          provider,
          provider === 'b'
            ? { mode: 'reply', text: '@a completed explicitly' }
            : { mode: 'stall' }
        );
        adapters.set(provider, adapter);
        return adapter;
      },
      targets: callbackTargets,
      knownProviderIds: ['a', 'b', 'c', 'd'],
    });
    const delegated = postAgentTurnRow(
      store,
      binder,
      'a-explicit-b',
      'a-item',
      '@b investigate this',
      ['a', 'b', 'c', 'd'],
      'runtime:a',
      A
    );
    await waitFor(() => adapters.get('a')?.sendCalls.length === 1);
    const a = adapters.get('a')!;
    expect(a.sendInputs[0]?.content).not.toContain(
      '[Relay internal completion callback]'
    );
    const bTurn = channelTurnId(delegated.id, builtInAgentProfileId('b'));
    expect(store.getCompletionCallback(`chcb:${bTurn}`)).toMatchObject({
      state: 'consumed',
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(a.sendCalls).toHaveLength(1);
  });

  for (const scenario of [
    {
      name: 'error',
      reason: 'error',
      end: (adapter: ScriptedAdapter) => adapter.emitError(),
    },
    {
      name: 'interrupt',
      reason: 'interrupt',
      end: (adapter: ScriptedAdapter) => adapter.emitTerminal('interrupted'),
    },
    {
      name: 'unexpected disconnect',
      reason: 'unexpected-disconnect',
      end: (adapter: ScriptedAdapter) => adapter.emitUnexpectedDisconnect(),
    },
  ] as const) {
    it(`wakes the delegator on ${scenario.name} with the guarded reason`, async () => {
      const adapters = new Map<string, ScriptedAdapter>();
      const { binder, store } = makeBinder({
        build: (provider) => {
          const adapter = new ScriptedAdapter(provider, { mode: 'stall' });
          adapters.set(provider, adapter);
          return adapter;
        },
        targets: callbackTargets,
        knownProviderIds: ['a', 'b', 'c', 'd'],
      });
      postAgentTurnRow(
        store,
        binder,
        `a-${scenario.reason}`,
        'a-item',
        '@b investigate this',
        ['a', 'b', 'c', 'd'],
        'runtime:a',
        A
      );
      await waitFor(() => adapters.has('b'));
      scenario.end(adapters.get('b')!);
      await waitFor(() => adapters.get('a')?.sendCalls.length === 1);
      expect(adapters.get('a')!.sendInputs[0]?.content).toContain(
        `terminalReason=${scenario.reason}`
      );
    });
  }

  it('marks a watchdog callback no-terminal-message', async () => {
    const adapters = new Map<string, ScriptedAdapter>();
    const { binder, store } = makeBinder({
      build: (provider) => {
        const adapter = new ScriptedAdapter(provider, { mode: 'stall' });
        adapters.set(provider, adapter);
        return adapter;
      },
      targets: callbackTargets,
      knownProviderIds: ['a', 'b', 'c', 'd'],
      watchdogMs: 10,
    });
    postAgentTurnRow(
      store,
      binder,
      'a-watchdog',
      'a-item',
      '@b investigate this',
      ['a', 'b', 'c', 'd'],
      'runtime:a',
      A
    );
    await waitFor(() => adapters.get('a')?.sendCalls.length === 1);
    expect(adapters.get('a')!.sendInputs[0]?.content).toContain(
      'terminalReason=watchdog'
    );
    expect(adapters.get('a')!.sendInputs[0]?.content).toContain(
      'messageDisposition=no-terminal-message'
    );
  });

  it('keeps an approval-related bare idle pending until the real terminal patch', async () => {
    const adapters = new Map<string, ScriptedAdapter | ApprovalAdapter>();
    const { binder, store } = makeBinder({
      build: (provider) => {
        const adapter =
          provider === 'b'
            ? new ApprovalAdapter(provider)
            : new ScriptedAdapter(provider, { mode: 'stall' });
        adapters.set(provider, adapter);
        return adapter;
      },
      targets: callbackTargets,
      knownProviderIds: ['a', 'b', 'c', 'd'],
      watchdogMs: 10,
    });
    const delegated = postAgentTurnRow(
      store,
      binder,
      'a-approval',
      'a-item',
      '@b investigate this',
      ['a', 'b', 'c', 'd'],
      'runtime:a',
      A
    );
    await waitFor(() => adapters.has('b'));
    await new Promise((resolve) => setTimeout(resolve, 35));
    expect(adapters.has('a')).toBe(false);
    const bTurn = channelTurnId(delegated.id, builtInAgentProfileId('b'));
    expect(store.getCompletionCallback(`chcb:${bTurn}`)).toMatchObject({
      state: 'pending',
    });
  });

  it('unwinds A → B → C as C → B → A without a downward callback', async () => {
    const adapters = new Map<string, ScriptedAdapter>();
    const { binder, store } = makeBinder({
      build: (provider) => {
        const adapter = new ScriptedAdapter(
          provider,
          provider === 'b'
            ? { mode: 'reply-sequence', texts: ['@c investigate', 'B final'] }
            : { mode: 'stall' }
        );
        adapters.set(provider, adapter);
        return adapter;
      },
      targets: callbackTargets,
      knownProviderIds: ['a', 'b', 'c', 'd'],
    });
    postAgentTurnRow(
      store,
      binder,
      'a-nested',
      'a-item',
      '@b investigate',
      ['a', 'b', 'c', 'd'],
      'runtime:a',
      A
    );
    await waitFor(() => adapters.has('c'));
    // B has terminalized its first turn, but C is still active: A must wait.
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(adapters.has('a')).toBe(false);
    adapters.get('c')!.emitTerminal('completed');
    await waitFor(() => adapters.get('b')?.sendCalls.length === 2);
    await waitFor(() => adapters.get('a')?.sendCalls.length === 1);
    expect(adapters.get('c')!.sendCalls).toHaveLength(1);
    expect(adapters.get('b')!.sendCalls).toHaveLength(2);
    expect(adapters.get('a')!.sendInputs[0]?.content).toContain(
      'terminalReason=completed'
    );
    await new Promise((resolve) => setTimeout(resolve, 25));
    // B’s completion callback returns upward only; it never re-notifies C.
    expect(adapters.get('c')!.sendCalls).toHaveLength(1);
  });

  it('enqueues a completion callback behind a busy delegator FIFO', async () => {
    const adapters = new Map<string, ScriptedAdapter>();
    const { binder, store } = makeBinder({
      build: (provider) => {
        const adapter = new ScriptedAdapter(
          provider,
          provider === 'b'
            ? { mode: 'reply', text: 'B done' }
            : { mode: 'stall' }
        );
        adapters.set(provider, adapter);
        return adapter;
      },
      targets: callbackTargets,
      knownProviderIds: ['a', 'b', 'c', 'd'],
    });
    post(store, binder, '@a keep working', ['a', 'b', 'c', 'd']);
    await waitFor(() => adapters.get('a')?.sendCalls.length === 1);
    postAgentTurnRow(
      store,
      binder,
      'a-busy-delegates-b',
      'a-item',
      '@b investigate',
      ['a', 'b', 'c', 'd'],
      'runtime:a',
      A
    );
    await waitFor(() => adapters.has('b'));
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(adapters.get('a')!.sendCalls).toHaveLength(1);
    adapters.get('a')!.emitTerminal('completed');
    await waitFor(() => adapters.get('a')!.sendCalls.length === 2);
    expect(adapters.get('a')!.sendInputs[1]?.content).toContain(
      '[Relay internal completion callback]'
    );
  });

  it('treats a nested B callback final @A as an upward return, never B → A delegation', async () => {
    const adapters = new Map<string, ScriptedAdapter>();
    const { binder, store } = makeBinder({
      build: (provider) => {
        const adapter = new ScriptedAdapter(
          provider,
          provider === 'b'
            ? {
                mode: 'reply-sequence',
                texts: ['@c investigate', '@a B explicitly returned'],
              }
            : { mode: 'stall' }
        );
        adapters.set(provider, adapter);
        return adapter;
      },
      targets: callbackTargets,
      knownProviderIds: ['a', 'b', 'c', 'd'],
    });
    const delegated = postAgentTurnRow(
      store,
      binder,
      'a-nested-explicit-return',
      'a-item',
      '@b investigate',
      ['a', 'b', 'c', 'd'],
      'runtime:a',
      A
    );
    await waitFor(() => adapters.has('c'));
    adapters.get('c')!.emitTerminal('completed');
    await waitFor(() => adapters.get('a')?.sendCalls.length === 1);
    expect(adapters.get('a')!.sendInputs[0]?.content).not.toContain(
      '[Relay internal completion callback]'
    );
    const bTurn = channelTurnId(delegated.id, builtInAgentProfileId('b'));
    expect(store.getCompletionCallback(`chcb:${bTurn}`)).toMatchObject({
      state: 'consumed',
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(adapters.get('a')!.sendCalls).toHaveLength(1);
    expect(adapters.get('c')!.sendCalls).toHaveLength(1);
  });

  it('recovers a persisted pending callback after a hub restart', async () => {
    const dir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'relay-callback-restart-')
    );
    cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const storePath = path.join(dir, 'channel-chat.db');
    const first = makeBinder({
      build: (provider) => new ScriptedAdapter(provider, { mode: 'stall' }),
      targets: callbackTargets,
      knownProviderIds: ['a', 'b', 'c', 'd'],
      storePath,
    });
    postAgentTurnRow(
      first.store,
      first.binder,
      'a-restart-delegates-b',
      'a-item',
      '@b investigate',
      ['a', 'b', 'c', 'd'],
      'runtime:a',
      A
    );
    await waitFor(() => first.sessions.spawns() === 1);
    first.binder.close();
    first.store.close();

    const adapters = new Map<string, ScriptedAdapter>();
    const restarted = makeBinder({
      build: (provider) => {
        const adapter = new ScriptedAdapter(provider, { mode: 'stall' });
        adapters.set(provider, adapter);
        return adapter;
      },
      targets: callbackTargets,
      knownProviderIds: ['a', 'b', 'c', 'd'],
      storePath,
    });
    await restarted.binder.recoverCompletionCallbacks();
    await waitFor(() => adapters.get('a')?.sendCalls.length === 1);
    expect(adapters.get('a')!.sendInputs[0]?.content).toContain(
      'terminalReason=unexpected-disconnect'
    );
  });

  it('converges reciprocal A and B mentions without ping-ponging', async () => {
    const adapters = new Map<string, ScriptedAdapter>();
    const { binder, store } = makeBinder({
      build: (provider) => {
        const adapter = new ScriptedAdapter(
          provider,
          provider === 'b'
            ? { mode: 'reply', text: '@a B explicitly returned' }
            : { mode: 'reply', text: 'A acknowledged without delegating' }
        );
        adapters.set(provider, adapter);
        return adapter;
      },
      targets: callbackTargets,
      knownProviderIds: ['a', 'b', 'c', 'd'],
    });
    postAgentTurnRow(
      store,
      binder,
      'a-b-mutual',
      'a-item',
      '@b delegated work',
      ['a', 'b', 'c', 'd'],
      'runtime:a',
      A
    );
    await waitFor(() => adapters.get('a')?.sendCalls.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(adapters.get('b')!.sendCalls).toHaveLength(1);
    expect(adapters.get('a')!.sendCalls).toHaveLength(1);
  });

  it('does not rearm a reverse delegation when callback handling has no new @mention', async () => {
    const adapters = new Map<string, ScriptedAdapter>();
    const { binder, store } = makeBinder({
      build: (provider) => {
        const adapter = new ScriptedAdapter(
          provider,
          provider === 'b'
            ? { mode: 'reply', text: 'B finished silently' }
            : { mode: 'reply', text: 'A handled the callback' }
        );
        adapters.set(provider, adapter);
        return adapter;
      },
      targets: callbackTargets,
      knownProviderIds: ['a', 'b', 'c', 'd'],
    });
    postAgentTurnRow(
      store,
      binder,
      'a-no-rearm',
      'a-item',
      '@b delegated work',
      ['a', 'b', 'c', 'd'],
      'runtime:a',
      A
    );
    await waitFor(() => adapters.get('a')?.sendCalls.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(adapters.get('a')!.sendInputs[0]?.content).toContain(
      '[Relay internal completion callback]'
    );
    expect(adapters.get('b')!.sendCalls).toHaveLength(1);
    expect(
      agentReplies(store, 'a').some(
        (row) => row.body.text === 'A handled the callback'
      )
    ).toBe(true);
  });

  it('replays a callback after crash-before-send and consumes only after acceptance', async () => {
    const dir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'relay-callback-preaccept-')
    );
    cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const storePath = path.join(dir, 'channel-chat.db');
    const firstAdapters = new Map<string, ScriptedAdapter | DeferredAdapter>();
    const first = makeBinder({
      build: (provider) => {
        const adapter =
          provider === 'a'
            ? new DeferredAdapter(provider)
            : new ScriptedAdapter(provider, { mode: 'reply', text: 'B done' });
        firstAdapters.set(provider, adapter);
        return adapter;
      },
      targets: callbackTargets,
      knownProviderIds: ['a', 'b', 'c', 'd'],
      storePath,
    });
    const delegated = postAgentTurnRow(
      first.store,
      first.binder,
      'a-preaccept-b',
      'a-item',
      '@b investigate',
      ['a', 'b', 'c', 'd'],
      'runtime:a',
      A
    );
    await waitFor(() => firstAdapters.get('a') instanceof DeferredAdapter);
    const deferred = firstAdapters.get('a') as DeferredAdapter;
    await waitFor(() => deferred.sendCalls.length === 1);
    const firstDispatch = deferred.sendInputs[0]!;
    const edgeId = `chcb:${channelTurnId(delegated.id, builtInAgentProfileId('b'))}`;
    expect(first.store.getCompletionCallback(edgeId)).toMatchObject({
      state: 'delivered',
    });
    first.binder.close();
    first.store.close();

    const restartedAdapters = new Map<string, ScriptedAdapter>();
    const restarted = makeBinder({
      build: (provider) => {
        const adapter = new ScriptedAdapter(provider, { mode: 'stall' });
        restartedAdapters.set(provider, adapter);
        return adapter;
      },
      targets: callbackTargets,
      knownProviderIds: ['a', 'b', 'c', 'd'],
      storePath,
    });
    await restarted.binder.recoverCompletionCallbacks();
    await waitFor(() => restartedAdapters.get('a')?.sendCalls.length === 1);
    const recoveredDispatch = restartedAdapters.get('a')!.sendInputs[0]!;
    // Relay replays the same deterministic provider-facing identifiers. The
    // generic adapter contract does not promise provider-side dedupe, but a
    // provider that honors either identity sees the same dispatch on recovery.
    expect(recoveredDispatch.turnId).toBe(firstDispatch.turnId);
    expect(recoveredDispatch.clientMessageId).toBe(
      firstDispatch.clientMessageId
    );
    expect(restarted.store.getCompletionCallback(edgeId)).toMatchObject({
      state: 'consumed',
    });
    restarted.binder.close();
    restarted.store.close();

    const postAcceptance = makeBinder({
      build: (provider) => new ScriptedAdapter(provider, { mode: 'stall' }),
      targets: callbackTargets,
      knownProviderIds: ['a', 'b', 'c', 'd'],
      storePath,
    });
    await postAcceptance.binder.recoverCompletionCallbacks();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(postAcceptance.sessions.spawns()).toBe(0);
  });

  it('persists a busy delegatee admission across restart before that turn starts', async () => {
    const dir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'relay-callback-busy-restart-')
    );
    cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const storePath = path.join(dir, 'channel-chat.db');
    const first = makeBinder({
      build: (provider) => new ScriptedAdapter(provider, { mode: 'stall' }),
      targets: callbackTargets,
      knownProviderIds: ['a', 'b', 'c', 'd'],
      storePath,
    });
    post(first.store, first.binder, '@b keep working', ['a', 'b', 'c', 'd']);
    await waitFor(() => first.sessions.spawns() === 1);
    const delegated = postAgentTurnRow(
      first.store,
      first.binder,
      'a-queued-b',
      'a-item',
      '@b queued delegation',
      ['a', 'b', 'c', 'd'],
      'runtime:a',
      A
    );
    const edgeId = `chcb:${channelTurnId(delegated.id, builtInAgentProfileId('b'))}`;
    await waitFor(() => first.store.getCompletionCallback(edgeId) !== null);
    expect(first.store.getCompletionCallback(edgeId)).toMatchObject({
      state: 'pending',
    });
    first.binder.close();
    first.store.close();

    const adapters = new Map<string, ScriptedAdapter>();
    const restarted = makeBinder({
      build: (provider) => {
        const adapter = new ScriptedAdapter(provider, { mode: 'stall' });
        adapters.set(provider, adapter);
        return adapter;
      },
      targets: callbackTargets,
      knownProviderIds: ['a', 'b', 'c', 'd'],
      storePath,
    });
    await restarted.binder.recoverCompletionCallbacks();
    await waitFor(() => adapters.get('a')?.sendCalls.length === 1);
    expect(adapters.get('a')!.sendInputs[0]?.content).toContain(
      'terminalReason=unexpected-disconnect'
    );
  });

  it('recovers a nested child admitted behind a busy delegatee FIFO and unwinds upward', async () => {
    const dir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'relay-callback-nested-queue-')
    );
    cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const storePath = path.join(dir, 'channel-chat.db');
    const first = makeBinder({
      build: (provider) =>
        new ScriptedAdapter(
          provider,
          provider === 'b'
            ? { mode: 'reply', text: '@c delegated while C is busy' }
            : { mode: 'stall' }
        ),
      targets: callbackTargets,
      knownProviderIds: ['a', 'b', 'c', 'd'],
      storePath,
    });
    post(first.store, first.binder, '@c keep working', ['a', 'b', 'c', 'd']);
    await waitFor(() => first.sessions.spawns() === 1);
    postAgentTurnRow(
      first.store,
      first.binder,
      'a-nested-queued-c',
      'a-item',
      '@b investigate',
      ['a', 'b', 'c', 'd'],
      'runtime:a',
      A
    );
    await waitFor(() => agentReplies(first.store, 'b').length === 1);
    const cTrigger = agentReplies(first.store, 'b')[0]!;
    const childId = `chcb:${channelTurnId(cTrigger.id, builtInAgentProfileId('c'))}`;
    await waitFor(() => first.store.getCompletionCallback(childId) !== null);
    expect(first.store.getCompletionCallback(childId)).toMatchObject({
      state: 'pending',
    });
    first.binder.close();
    first.store.close();

    const adapters = new Map<string, ScriptedAdapter>();
    const restarted = makeBinder({
      build: (provider) => {
        const adapter = new ScriptedAdapter(
          provider,
          provider === 'b'
            ? { mode: 'reply', text: 'B resumed and completed' }
            : { mode: 'stall' }
        );
        adapters.set(provider, adapter);
        return adapter;
      },
      targets: callbackTargets,
      knownProviderIds: ['a', 'b', 'c', 'd'],
      storePath,
    });
    await restarted.binder.recoverCompletionCallbacks();
    await waitFor(() => adapters.get('a')?.sendCalls.length === 1);
    expect(adapters.get('a')!.sendInputs[0]?.content).toContain(
      '[Relay internal completion callback]'
    );
  });

  it('releases an unaccepted callback on runtime death and rebinds it exactly once', async () => {
    const aAdapters: Array<DeferredAdapter | ScriptedAdapter> = [];
    const { binder, store, sessions } = makeBinder({
      build: (provider) => {
        if (provider === 'a') {
          const adapter =
            aAdapters.length === 0
              ? new DeferredAdapter(provider)
              : new ScriptedAdapter(provider, { mode: 'stall' });
          aAdapters.push(adapter);
          return adapter;
        }
        return new ScriptedAdapter(provider, { mode: 'reply', text: 'B done' });
      },
      targets: callbackTargets,
      knownProviderIds: ['a', 'b', 'c', 'd'],
    });
    postAgentTurnRow(
      store,
      binder,
      'a-dead-preaccept-b',
      'a-item',
      '@b investigate',
      ['a', 'b', 'c', 'd'],
      'runtime:a',
      A
    );
    await waitFor(() => aAdapters[0] instanceof DeferredAdapter);
    await waitFor(
      () => (aAdapters[0] as DeferredAdapter).sendCalls.length === 1
    );
    // B is the first spawned runtime; A's still-unaccepted callback is second.
    sessions.fireEnd('sess-2-a');
    await waitFor(() => aAdapters.length === 2);
    await waitFor(
      () => (aAdapters[1] as ScriptedAdapter).sendCalls.length === 1
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect((aAdapters[1] as ScriptedAdapter).sendCalls).toHaveLength(1);
  });

  it('retries transient callback routing after configured runtimes and preserves orchestrator role', async () => {
    const adapters = new Map<string, ScriptedAdapter>();
    const { binder, store, sessions } = makeBinder({
      build: (provider) => {
        const adapter = new ScriptedAdapter(provider, { mode: 'stall' });
        adapters.set(provider, adapter);
        return adapter;
      },
      targets: callbackTargets,
      knownProviderIds: ['a', 'b', 'c', 'd'],
      createErrorOnce: new Error('transient runtime launch failure'),
    });
    const trigger = store.appendComplete({
      channelId: CH,
      sender: OPERATOR,
      text: 'callback trigger',
    });
    store.designateSoleOrchestrator({
      channelId: CH,
      profileActorId: builtInAgentProfileId('a'),
      agentFramework: 'a',
    });
    const edge = store.createCompletionCallback({
      id: 'chcb:transient-recovery',
      channelId: CH,
      threadId: null,
      triggerMessageId: trigger.id,
      requesterProfileId: builtInAgentProfileId('a'),
      targetProfileId: builtInAgentProfileId('b'),
      targetRuntimeId: 'runtime:b',
      targetTurnId: 'turn:transient-recovery',
    });
    store.satisfyCompletionCallback({
      channelId: edge.channelId,
      targetProfileId: edge.targetProfileId,
      targetTurnId: edge.targetTurnId,
      terminalReason: 'error',
      messageDisposition: 'no-terminal-message',
    });
    await binder.recoverCompletionCallbacks();
    await waitFor(() => adapters.get('a')?.sendCalls.length === 1);
    expect(sessions.spawns()).toBe(2);
    expect(sessions.lastCreateParams()?.role).toBe('orchestrator');
  });

  it('terminalizes a delegatee FIFO-cap rejection upward instead of dropping its edge', async () => {
    const adapters = new Map<string, ScriptedAdapter>();
    const { binder, store } = makeBinder({
      build: (provider) => {
        const adapter = new ScriptedAdapter(provider, { mode: 'stall' });
        adapters.set(provider, adapter);
        return adapter;
      },
      targets: callbackTargets,
      knownProviderIds: ['a', 'b', 'c', 'd'],
    });
    post(store, binder, '@b occupy the worker', ['a', 'b', 'c', 'd']);
    await waitFor(() => adapters.get('b')?.sendCalls.length === 1);
    for (let index = 0; index < 8; index += 1) {
      post(store, binder, `@b queued ${index}`, ['a', 'b', 'c', 'd']);
    }
    await new Promise((resolve) => setTimeout(resolve, 30));
    postAgentTurnRow(
      store,
      binder,
      'a-cap-delegates-b',
      'a-item',
      '@b one too many',
      ['a', 'b', 'c', 'd'],
      'runtime:a',
      A
    );
    await waitFor(() => adapters.get('a')?.sendCalls.length === 1);
    expect(adapters.get('a')!.sendInputs[0]?.content).toContain(
      'terminalReason=error'
    );
  });

  it('queues a callback-bearing delegation behind a busy steerable agent instead of steering it', async () => {
    const { binder, store, sessions } = makeBinder({
      build: (provider) => {
        return new SteerableAdapter(provider, true);
      },
      targets: callbackTargets,
      knownProviderIds: ['a', 'b', 'c', 'd'],
    });
    post(store, binder, '@b keep the native turn active', ['a', 'b', 'c', 'd']);
    await waitFor(() => sessions.spawns() === 1);
    const b = sessions.adapterFor(
      sessions.firstSessionId()
    ) as SteerableAdapter;
    await waitFor(() => b.sendCalls.length === 1);
    const delegated = postAgentTurnRow(
      store,
      binder,
      'a-steerable-delegates-b',
      'a-item',
      '@b must be its own callback edge',
      ['a', 'b', 'c', 'd'],
      'runtime:a',
      A
    );
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(b.steerAttempts).toHaveLength(0);
    expect(b.sendCalls).toHaveLength(1);
    b.completeLatest();
    await waitFor(() => b.sendCalls.length === 2);
    const targetTurnId = channelTurnId(
      delegated.id,
      builtInAgentProfileId('b')
    );
    expect(b.sendInputs[1]?.turnId).toBe(targetTurnId);
    expect(store.getCompletionCallback(`chcb:${targetTurnId}`)).toMatchObject({
      targetTurnId,
    });
  });

  it('releases a queued upward callback when its busy requester runtime dies', async () => {
    const aAdapters: ScriptedAdapter[] = [];
    const { binder, store, sessions } = makeBinder({
      build: (provider) => {
        const adapter = new ScriptedAdapter(
          provider,
          provider === 'b'
            ? { mode: 'reply', text: 'B done' }
            : { mode: 'stall' }
        );
        if (provider === 'a') aAdapters.push(adapter);
        return adapter;
      },
      targets: callbackTargets,
      knownProviderIds: ['a', 'b', 'c', 'd'],
    });
    post(store, binder, '@a keep working', ['a', 'b', 'c', 'd']);
    await waitFor(() => aAdapters[0]?.sendCalls.length === 1);
    const delegated = postAgentTurnRow(
      store,
      binder,
      'a-upward-queued-delegates-b',
      'a-item',
      '@b investigate',
      ['a', 'b', 'c', 'd'],
      'runtime:a',
      A
    );
    const edgeId = `chcb:${channelTurnId(delegated.id, builtInAgentProfileId('b'))}`;
    await waitFor(
      () => store.getCompletionCallback(edgeId)?.state === 'delivered'
    );
    sessions.fireEnd('sess-1-a');
    await waitFor(() => aAdapters.length === 2);
    await waitFor(() => aAdapters[1]?.sendCalls.length === 1);
    expect(store.getCompletionCallback(edgeId)).toMatchObject({
      state: 'consumed',
    });
  });

  it('terminalizes a queued downward delegation when its delegatee runtime dies', async () => {
    const adapters = new Map<string, ScriptedAdapter>();
    const { binder, store, sessions } = makeBinder({
      build: (provider) => {
        const adapter = new ScriptedAdapter(provider, { mode: 'stall' });
        adapters.set(provider, adapter);
        return adapter;
      },
      targets: callbackTargets,
      knownProviderIds: ['a', 'b', 'c', 'd'],
    });
    post(store, binder, '@b keep working', ['a', 'b', 'c', 'd']);
    await waitFor(() => adapters.get('b')?.sendCalls.length === 1);
    const delegated = postAgentTurnRow(
      store,
      binder,
      'a-downward-queued-delegates-b',
      'a-item',
      '@b queued work',
      ['a', 'b', 'c', 'd'],
      'runtime:a',
      A
    );
    const edgeId = `chcb:${channelTurnId(delegated.id, builtInAgentProfileId('b'))}`;
    await waitFor(
      () => store.getCompletionCallback(edgeId)?.state === 'pending'
    );
    sessions.fireEnd('sess-1-b');
    await waitFor(() => adapters.get('a')?.sendCalls.length === 1);
    expect(adapters.get('a')!.sendInputs[0]?.content).toContain(
      'terminalReason=unexpected-disconnect'
    );
    expect(store.getCompletionCallback(edgeId)).toMatchObject({
      state: 'consumed',
    });
  });

  it('prunes expired settled callback rows during live callback mutation without restart', async () => {
    const dir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'relay-callback-live-prune-')
    );
    cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const storePath = path.join(dir, 'channel-chat.db');
    const { binder, store } = makeBinder({
      build: (provider) => new ScriptedAdapter(provider, { mode: 'stall' }),
      targets: callbackTargets,
      knownProviderIds: ['a', 'b', 'c', 'd'],
      storePath,
    });
    const trigger = store.appendComplete({
      channelId: CH,
      sender: OPERATOR,
      text: 'old callback trigger',
    });
    const old = store.createCompletionCallback({
      id: 'chcb:expired-live-row',
      channelId: CH,
      threadId: null,
      triggerMessageId: trigger.id,
      requesterProfileId: builtInAgentProfileId('a'),
      targetProfileId: builtInAgentProfileId('b'),
      targetRuntimeId: 'runtime:b',
      targetTurnId: 'turn:expired-live-row',
    });
    store.satisfyCompletionCallback({
      channelId: old.channelId,
      targetProfileId: old.targetProfileId,
      targetTurnId: old.targetTurnId,
      terminalReason: 'completed',
      messageDisposition: 'no-terminal-message',
    });
    store.claimSatisfiedCompletionCallbacks();
    expect(store.consumeCompletionCallback(old.id)).toBe(true);
    const raw = new Database(storePath);
    raw
      .prepare(
        `UPDATE channel_completion_callbacks
          SET consumed_at = ?, updated_at = ?
        WHERE id = ?`
      )
      .run(
        new Date(Date.now() - 8 * 24 * 60 * 60 * 1_000).toISOString(),
        new Date().toISOString(),
        old.id
      );
    raw.close();

    postAgentTurnRow(
      store,
      binder,
      'a-prune-live-delegates-b',
      'a-item',
      '@b trigger a live callback mutation',
      ['a', 'b', 'c', 'd'],
      'runtime:a',
      A
    );
    await waitFor(() => store.getCompletionCallback(old.id) === null);
  });

  it('drains more than one bounded recovery batch without stranding callback edges', async () => {
    const adapters = new Map<string, ScriptedAdapter>();
    const { binder, store } = makeBinder({
      build: (provider) => {
        const adapter = new ScriptedAdapter(provider, {
          mode: 'reply',
          text: 'ack',
        });
        adapters.set(provider, adapter);
        return adapter;
      },
      targets: callbackTargets,
      knownProviderIds: ['a', 'b', 'c', 'd'],
    });
    const trigger = store.appendComplete({
      channelId: CH,
      sender: OPERATOR,
      text: 'batch callback trigger',
    });
    for (let index = 0; index < 101; index += 1) {
      const edge = store.createCompletionCallback({
        id: `chcb:batch:${index}`,
        channelId: CH,
        threadId: null,
        triggerMessageId: trigger.id,
        requesterProfileId: builtInAgentProfileId('a'),
        targetProfileId: builtInAgentProfileId('b'),
        targetRuntimeId: 'runtime:b',
        targetTurnId: `turn:batch:${index}`,
      });
      store.satisfyCompletionCallback({
        channelId: edge.channelId,
        targetProfileId: edge.targetProfileId,
        targetTurnId: edge.targetTurnId,
        terminalReason: 'completed',
        messageDisposition: 'no-terminal-message',
      });
    }
    await binder.recoverCompletionCallbacks();
    await waitFor(() => adapters.get('a')?.sendCalls.length === 101, 8000);
    expect(store.claimSatisfiedCompletionCallbacks()).toEqual([]);
  });
});

const CH = 'topic:test';
const OPERATOR: ChannelSenderRef = {
  kind: 'human',
  id: 'human:operator',
  displayName: 'operator',
};
/** A CLI-gateway actor post (deriveSender kind 'agent') — subject to the brake. */
const AGENT_SENDER: ChannelSenderRef = {
  kind: 'agent',
  id: 'agent:orchestrator',
  providerId: 'orchestrator',
  displayName: 'orchestrator',
};
const CLAUDE_AGENT_SENDER: ChannelSenderRef = {
  kind: 'agent',
  id: 'agent-profile:claude:default',
  providerId: 'claude',
  displayName: 'Claude',
};

function makeStore(dbPathOverride?: string): {
  store: ChannelMessageStore;
  hub: ChannelHub;
} {
  const dir = dbPathOverride
    ? null
    : fs.mkdtempSync(path.join(os.tmpdir(), 'relay-binder-'));
  if (dir) cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = createChannelMessageStore(
    dbPathOverride ?? path.join(dir!, 'channel-chat.db')
  );
  cleanup.push(() => store.close());
  const hub = createChannelHub({ store, channelExists: () => true });
  cleanup.push(() => hub.close());
  return { store, hub };
}

async function waitFor(
  cond: () => boolean,
  ms = 4000,
  step = 5
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, step));
  }
  throw new Error('waitFor timed out');
}

function rows(store: ChannelMessageStore): ChannelMessage[] {
  return store.history(CH, { limit: 200 });
}
function agentReplies(store: ChannelMessageStore, providerId?: string) {
  return rows(store).filter(
    (m) =>
      m.sender.kind === 'agent' &&
      m.status === 'complete' &&
      !m.agentDetail &&
      (!providerId || m.sender.providerId === providerId)
  );
}
function systemRows(store: ChannelMessageStore) {
  return rows(store).filter((m) => m.kind === 'system');
}

function post(
  store: ChannelMessageStore,
  binder: ChannelAgentBinder,
  text: string,
  knownIds: string[],
  sender: ChannelSenderRef = OPERATOR,
  parentMessageId?: string
): ChannelMessage {
  const mentions = parseMentions(text, knownIds);
  const message = store.appendComplete({
    channelId: CH,
    sender,
    text,
    ...(mentions.length ? { mentions } : {}),
    ...(parentMessageId ? { parentMessageId } : {}),
  });
  binder.handleMessagePosted(message, message.mentions ?? []);
  return message;
}

function postWithAsyncRun(
  store: ChannelMessageStore,
  binder: ChannelAgentBinder,
  text: string,
  knownIds: string[],
  sender: ChannelSenderRef = OPERATOR,
  parentMessageId?: string
) {
  const mentions = parseMentions(text, knownIds);
  const result = store.appendCompleteWithAsyncRun({
    channelId: CH,
    sender,
    text,
    ...(mentions.length ? { mentions } : {}),
    ...(parentMessageId ? { parentMessageId } : {}),
    targetIds: mentions.flatMap((mention) =>
      mention.profileId
        ? [mention.profileId]
        : mention.providerId
          ? [builtInAgentProfileId(mention.providerId)]
          : []
    ),
  });
  binder.handleMessagePosted(result.message, result.message.mentions ?? []);
  return result;
}

function postAgentTurnRow(
  store: ChannelMessageStore,
  binder: ChannelAgentBinder,
  turnId: string,
  itemId: string,
  text: string,
  knownIds: string[],
  runtimeId = 'runtime:orchestrator',
  sender: ChannelSenderRef = AGENT_SENDER,
  parentMessageId?: string
): ChannelMessage {
  const mentions = parseMentions(text, knownIds);
  const stream = store.beginStream({
    channelId: CH,
    sender,
    source: { runtimeId, turnId, itemId },
    ...(mentions.length ? { mentions } : {}),
    ...(parentMessageId ? { parentMessageId } : {}),
  });
  const message = store.finalizeStream(stream.id, {
    text,
    status: 'complete',
  })!;
  binder.handleMessagePosted(message, mentions);
  return message;
}

// ── scripted adapter (deterministic, no timers) ──────────────────────────────

type ScriptMode =
  | { mode: 'stall' }
  | { mode: 'reply'; text: string }
  | { mode: 'reply-items'; texts: string[] }
  | { mode: 'reply-items-once-then-stall'; texts: string[] }
  | { mode: 'reply-sequence'; texts: string[] }
  | { mode: 'reject' }
  | { mode: 'reject-once-then-reply'; text: string };

class ScriptedAdapter extends BaseProtocolAdapterV2 {
  readonly runtimeOwnership = 'spawned' as const;
  readonly capabilities: AgentCapabilitySetV2 = {
    text: true,
    queue: false,
    interrupt: true,
    approvals: true,
    streaming: true,
  };
  readonly sendCalls: string[] = [];
  readonly sendInputs: AgentSendMessageInputV2[] = [];
  /** Recorded, never terminalized: a real interrupt is an async round-trip. */
  readonly interruptCalls: string[] = [];
  private _status: AdapterStatus = 'disconnected';
  private sid = 'scripted';
  private rejected = false;
  private lastTurnId: string | null = null;

  constructor(
    readonly agentType: string,
    private readonly script: ScriptMode
  ) {
    super();
  }
  get status(): AdapterStatus {
    return this._status;
  }
  async connect(config: AdapterConfig): Promise<void> {
    this._status = 'connected';
    this.sid = config.sessionId;
  }
  protected async onDisconnect(): Promise<void> {
    this._status = 'disconnected';
  }
  async reconnect(): Promise<void> {}
  async resumeSession(): Promise<void> {}
  async interrupt(input: AgentInterruptInputV2): Promise<void> {
    this.interruptCalls.push(input.turnId ?? this.lastTurnId ?? '');
  }
  async respondToApproval(): Promise<void> {}
  async respondToInput(): Promise<void> {}

  async sendMessage(input: AgentSendMessageInputV2): Promise<void> {
    this.sendCalls.push(input.turnId);
    this.sendInputs.push(input);
    this.lastTurnId = input.turnId;
    if (this.script.mode === 'reject-once-then-reply' && !this.rejected) {
      this.rejected = true;
      throw new Error('transport down');
    }
    if (this.script.mode === 'reject') throw new Error('transport down');
    if (
      this.script.mode === 'stall' ||
      (this.script.mode === 'reply-items-once-then-stall' &&
        this.sendCalls.length > 1)
    ) {
      return; // resolve, never complete
    }
    this.runReplyItems(
      input.turnId,
      this.script.mode === 'reply-items' ||
        this.script.mode === 'reply-items-once-then-stall'
        ? this.script.texts
        : this.script.mode === 'reply-sequence'
          ? [
              this.script.texts[
                Math.min(
                  this.sendCalls.length - 1,
                  this.script.texts.length - 1
                )
              ] ?? '',
            ]
          : [this.script.text]
    );
  }

  emitTerminal(status: 'completed' | 'interrupted' | 'failed'): void {
    if (!this.lastTurnId) return;
    this.emitPatch({
      type: 'agent-turn-completed-v2',
      sessionId: this.sid,
      timestamp: 't',
      turnId: this.lastTurnId,
      status,
    });
  }

  emitError(message = 'scripted error'): void {
    this.emitPatch({
      type: 'agent-error-v2',
      sessionId: this.sid,
      timestamp: 't',
      ...(this.lastTurnId ? { turnId: this.lastTurnId } : {}),
      message,
    });
  }

  emitUnexpectedDisconnect(): void {
    this.emitPatch({
      type: 'agent-live-state-updated-v2',
      sessionId: this.sid,
      timestamp: 't',
      live: {
        status: 'disconnected',
        activeTurnId: null,
        waitingOn: null,
        activeRequestIds: [],
        queueLength: 0,
      },
    });
  }

  private runReplyItems(turnId: string, texts: string[]): void {
    this.emitPatch({
      type: 'agent-turn-started-v2',
      sessionId: this.sid,
      timestamp: 't',
      turn: {
        id: turnId,
        status: 'running',
        inputMessageId: `u-${turnId}`,
        items: [],
        startedAt: 't',
      },
    });
    for (const [index, text] of texts.entries()) {
      const itemId = `assistant-${turnId}-${index}`;
      this.emitPatch({
        type: 'agent-item-started-v2',
        sessionId: this.sid,
        timestamp: 't',
        turnId,
        item: { type: 'assistantMessage', id: itemId, text: '' },
      });
      this.emitPatch({
        type: 'agent-item-delta-v2',
        sessionId: this.sid,
        timestamp: 't',
        turnId,
        itemId,
        delta: { text },
      });
      this.emitPatch({
        type: 'agent-item-updated-v2',
        sessionId: this.sid,
        timestamp: 't',
        turnId,
        item: {
          type: 'assistantMessage',
          id: itemId,
          text,
          status: 'completed',
        },
      });
    }
    this.emitPatch({
      type: 'agent-turn-completed-v2',
      sessionId: this.sid,
      timestamp: 't',
      turnId,
      status: 'completed',
    });
  }
}

// ── approval-driving adapter (waitingOn handshake, no timers) ─────────────────
// Emits an approval item + `waitingOn:'approval'` on send, parks the turn, and
// resolves it only on respondToApproval / interrupt. Records send/respond/
// interrupt calls so the brake, watchdog-pause, and round-trip can be asserted.
class ApprovalAdapter extends BaseProtocolAdapterV2 {
  readonly runtimeOwnership = 'spawned' as const;
  readonly capabilities: AgentCapabilitySetV2 = {
    text: true,
    approvals: true,
    interrupt: true,
    streaming: true,
    queue: false,
  };
  readonly sendCalls: string[] = [];
  readonly respondCalls: AgentApprovalResponseInputV2[] = [];
  readonly interruptCalls: string[] = [];
  private _status: AdapterStatus = 'disconnected';
  private sid = 'appr';
  private activeTurn: string | null = null;
  private pendingApprovalId: string | null = null;

  constructor(readonly agentType: string) {
    super();
  }
  get status(): AdapterStatus {
    return this._status;
  }
  async connect(config: AdapterConfig): Promise<void> {
    this._status = 'connected';
    this.sid = config.sessionId;
  }
  protected async onDisconnect(): Promise<void> {
    this._status = 'disconnected';
  }
  async reconnect(): Promise<void> {}
  async resumeSession(): Promise<void> {}
  async respondToInput(): Promise<void> {}

  async sendMessage(input: AgentSendMessageInputV2): Promise<void> {
    this.sendCalls.push(input.turnId);
    this.activeTurn = input.turnId;
    const approvalId = `appr-${input.turnId}`;
    this.pendingApprovalId = approvalId;
    this.emitPatch({
      type: 'agent-turn-started-v2',
      sessionId: this.sid,
      timestamp: 't',
      turn: {
        id: input.turnId,
        status: 'running',
        inputMessageId: `u-${input.turnId}`,
        items: [],
        startedAt: 't',
      },
    });
    this.emitPatch({
      type: 'agent-item-started-v2',
      sessionId: this.sid,
      timestamp: 't',
      turnId: input.turnId,
      item: {
        type: 'approval',
        id: approvalId,
        requestId: approvalId,
        kind: 'command',
        description: 'Run mock command',
        target: 'npm test',
        status: 'pending',
        startedAt: 't',
      },
    });
    this.emitPatch({
      type: 'agent-live-state-updated-v2',
      sessionId: this.sid,
      timestamp: 't',
      live: { waitingOn: 'approval' },
    });
    // Real hermes shape (#1181 re-review): hermes fires
    // `session-status {status:'idle', waitingOn:'approval'}` alongside the
    // permission prompt, and the legacy compat mapping strips the waitingOn for
    // the `idle` case — so the binder sees a BARE idle mid-approval. It must
    // ignore it: never finalize (which would let pump dispatch a concurrent
    // turn) and never clobber the waiting state / re-arm the watchdog.
    this.emitPatch({
      type: 'agent-live-state-updated-v2',
      sessionId: this.sid,
      timestamp: 't',
      live: {
        status: 'idle',
        activeTurnId: null,
        waitingOn: null,
        activeRequestIds: [],
        error: null,
      },
    });
  }

  async interrupt(input: AgentInterruptInputV2): Promise<void> {
    this.interruptCalls.push(input.turnId ?? this.activeTurn ?? '');
    const turnId = this.activeTurn;
    if (turnId === null) return;
    this.activeTurn = null;
    this.pendingApprovalId = null;
    this.emitPatch({
      type: 'agent-turn-completed-v2',
      sessionId: this.sid,
      timestamp: 't',
      turnId,
      status: 'interrupted',
    });
  }

  async respondToApproval(input: AgentApprovalResponseInputV2): Promise<void> {
    this.respondCalls.push(input);
    if (input.requestId !== this.pendingApprovalId) return;
    const turnId = this.activeTurn;
    if (turnId === null) return;
    this.emitPatch({
      type: 'agent-item-updated-v2',
      sessionId: this.sid,
      timestamp: 't',
      turnId,
      item: {
        type: 'approval',
        id: input.requestId,
        requestId: input.requestId,
        kind: 'command',
        description: 'Run mock command',
        target: 'npm test',
        status: 'completed',
        decision: input.decision,
      },
    });
    this.emitPatch({
      type: 'agent-live-state-updated-v2',
      sessionId: this.sid,
      timestamp: 't',
      live: { waitingOn: null },
    });
    const itemId = `a-${turnId}`;
    this.emitPatch({
      type: 'agent-item-started-v2',
      sessionId: this.sid,
      timestamp: 't',
      turnId,
      item: { type: 'assistantMessage', id: itemId, text: '' },
    });
    this.emitPatch({
      type: 'agent-item-delta-v2',
      sessionId: this.sid,
      timestamp: 't',
      turnId,
      itemId,
      delta: { text: 'approved and done' },
    });
    this.emitPatch({
      type: 'agent-item-updated-v2',
      sessionId: this.sid,
      timestamp: 't',
      turnId,
      item: {
        type: 'assistantMessage',
        id: itemId,
        text: 'approved and done',
        status: 'completed',
      },
    });
    this.activeTurn = null;
    this.pendingApprovalId = null;
    this.emitPatch({
      type: 'agent-turn-completed-v2',
      sessionId: this.sid,
      timestamp: 't',
      turnId,
      status: 'completed',
    });
  }
}

// ── heartbeat adapter (#1541 inactivity watchdog) ────────────────────────────
// Models a long implementation turn: the runtime keeps emitting tool items and
// deltas for as long as the work takes, then finishes. Nothing here is "stuck",
// so a watchdog that measured turn wall-clock killed it and one that measures
// silence must not. `complete()` ends the turn the way a real provider does.
class HeartbeatAdapter extends BaseProtocolAdapterV2 {
  readonly runtimeOwnership = 'spawned' as const;
  readonly capabilities: AgentCapabilitySetV2 = {
    text: true,
    queue: false,
    interrupt: true,
    approvals: true,
    streaming: true,
  };
  readonly sendCalls: string[] = [];
  readonly interruptCalls: string[] = [];
  beats = 0;
  private _status: AdapterStatus = 'disconnected';
  private sid = 'heartbeat';
  private activeTurn: string | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    readonly agentType: string,
    private readonly beatMs: number
  ) {
    super();
  }
  get status(): AdapterStatus {
    return this._status;
  }
  async connect(config: AdapterConfig): Promise<void> {
    this._status = 'connected';
    this.sid = config.sessionId;
  }
  protected async onDisconnect(): Promise<void> {
    this.stopBeating();
    this._status = 'disconnected';
  }
  async reconnect(): Promise<void> {}
  async resumeSession(): Promise<void> {}
  async respondToApproval(): Promise<void> {}
  async respondToInput(): Promise<void> {}
  async interrupt(input: AgentInterruptInputV2): Promise<void> {
    this.interruptCalls.push(input.turnId ?? this.activeTurn ?? '');
  }

  async sendMessage(input: AgentSendMessageInputV2): Promise<void> {
    this.sendCalls.push(input.turnId);
    this.activeTurn = input.turnId;
    this.emitPatch({
      type: 'agent-turn-started-v2',
      sessionId: this.sid,
      timestamp: 't',
      turn: {
        id: input.turnId,
        status: 'running',
        inputMessageId: `u-${input.turnId}`,
        items: [],
        startedAt: 't',
      },
    });
    this.emitPatch({
      type: 'agent-item-started-v2',
      sessionId: this.sid,
      timestamp: 't',
      turnId: input.turnId,
      item: { type: 'assistantMessage', id: `a-${input.turnId}`, text: '' },
    });
    this.timer = setInterval(() => this.beat(), this.beatMs);
    this.timer.unref?.();
  }

  private beat(): void {
    const turnId = this.activeTurn;
    if (turnId === null) return;
    this.beats += 1;
    this.emitPatch({
      type: 'agent-item-delta-v2',
      sessionId: this.sid,
      timestamp: 't',
      turnId,
      itemId: `a-${turnId}`,
      delta: { text: '.' },
    });
  }

  private stopBeating(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Open a tool call for the active turn and emit NOTHING further (#1548).
   * Models `npm run check`: the item starts, the command runs for minutes, and
   * no delta, live-state, or step update lands until it is done.
   */
  startTool(itemId = 'tool-1', command = 'npm run check'): void {
    const turnId = this.activeTurn;
    if (turnId === null) return;
    this.emitPatch({
      type: 'agent-item-started-v2',
      sessionId: this.sid,
      timestamp: 't',
      turnId,
      item: {
        type: 'commandExecution',
        id: itemId,
        command,
        output: '',
        status: 'running',
      },
    });
  }

  /** Terminal update for a tool opened by `startTool`. */
  finishTool(itemId = 'tool-1', command = 'npm run check'): void {
    const turnId = this.activeTurn;
    if (turnId === null) return;
    this.emitPatch({
      type: 'agent-item-updated-v2',
      sessionId: this.sid,
      timestamp: 't',
      turnId,
      item: {
        type: 'commandExecution',
        id: itemId,
        command,
        output: 'ok',
        exitCode: 0,
        status: 'completed',
      },
    });
  }

  /**
   * A live-state ping that explicitly names NO active turn — the shape a
   * runtime emits when it thinks it is idle. It must never refresh the silence
   * budget of the turn the watchdog is bounding (#1548).
   */
  emitIdleHeartbeat(): void {
    this.emitPatch({
      type: 'agent-live-state-updated-v2',
      sessionId: this.sid,
      timestamp: 't',
      live: { status: 'working', activeTurnId: null },
    });
  }

  /** Terminal tool delta labelled with ANY turn id — replays a finished turn. */
  emitToolTerminalDeltaFor(turnId: string, itemId = 'tool-1'): void {
    this.emitPatch({
      type: 'agent-item-delta-v2',
      sessionId: this.sid,
      timestamp: 't',
      turnId,
      itemId,
      delta: { status: 'completed', output: 'stale' },
    });
  }

  /** Emit a delta labelled with ANY turn id — used to replay a finished turn. */
  emitDeltaFor(turnId: string): void {
    this.emitPatch({
      type: 'agent-item-delta-v2',
      sessionId: this.sid,
      timestamp: 't',
      turnId,
      itemId: `a-${turnId}`,
      delta: { text: 'stale' },
    });
  }

  complete(text = 'long job done'): void {
    const turnId = this.activeTurn;
    if (turnId === null) return;
    this.stopBeating();
    this.activeTurn = null;
    this.emitPatch({
      type: 'agent-item-updated-v2',
      sessionId: this.sid,
      timestamp: 't',
      turnId,
      item: {
        type: 'assistantMessage',
        id: `a-${turnId}`,
        text,
        status: 'completed',
      },
    });
    this.emitPatch({
      type: 'agent-turn-completed-v2',
      sessionId: this.sid,
      timestamp: 't',
      turnId,
      status: 'completed',
    });
  }
}

// ── steerable adapter (#1308 slice 4 mid-turn steering) ──────────────────────
// Every send opens a turn that streams one partial chunk and then STALLS, so a
// turn is reliably live when the next post lands. `interrupt` emits the same
// terminal patch a real cancellation produces; `complete` finishes naturally.
// Tracks the set of turns the adapter believes are open so a double dispatch is
// OBSERVED (concurrentPeak > 1) rather than inferred from send counts.
class SteerableAdapter extends BaseProtocolAdapterV2 {
  readonly runtimeOwnership = 'spawned' as const;
  readonly capabilities: AgentCapabilitySetV2;
  readonly sendCalls: string[] = [];
  readonly sendInputs: AgentSendMessageInputV2[] = [];
  readonly steerAttempts: AgentSendMessageInputV2[] = [];
  readonly steerInputs: AgentSendMessageInputV2[] = [];
  readonly interruptCalls: string[] = [];
  /** Peak simultaneously-open turns; the binder must never let this exceed 1. */
  concurrentPeak = 0;
  private readonly open = new Set<string>();
  private _status: AdapterStatus = 'disconnected';
  private sid = 'steerable';

  constructor(
    readonly agentType: string,
    private readonly supportsSafeBoundarySteer = false,
    private readonly rejectsSafeBoundarySteer = false,
    private readonly failsSafeBoundarySteer = false,
    private readonly hangsSafeBoundarySteer = false
  ) {
    super();
    this.capabilities = {
      text: true,
      queue: false,
      steer: supportsSafeBoundarySteer,
      interrupt: true,
      approvals: false,
      streaming: true,
    };
  }
  get status(): AdapterStatus {
    return this._status;
  }
  async connect(config: AdapterConfig): Promise<void> {
    this._status = 'connected';
    this.sid = config.sessionId;
  }
  protected async onDisconnect(): Promise<void> {
    this._status = 'disconnected';
  }
  async reconnect(): Promise<void> {}
  async resumeSession(): Promise<void> {}
  async respondToApproval(): Promise<void> {}
  async respondToInput(): Promise<void> {}

  async sendMessage(input: AgentSendMessageInputV2): Promise<void> {
    this.sendCalls.push(input.turnId);
    this.sendInputs.push(input);
    this.open.add(input.turnId);
    this.concurrentPeak = Math.max(this.concurrentPeak, this.open.size);
    this.emitPatch({
      type: 'agent-turn-started-v2',
      sessionId: this.sid,
      timestamp: 't',
      turn: {
        id: input.turnId,
        status: 'running',
        inputMessageId: `u-${input.turnId}`,
        items: [],
        startedAt: 't',
      },
    });
    this.emitPatch({
      type: 'agent-item-started-v2',
      sessionId: this.sid,
      timestamp: 't',
      turnId: input.turnId,
      item: {
        type: 'assistantMessage',
        id: `a-${input.turnId}`,
        text: '',
      },
    });
    this.emitPatch({
      type: 'agent-item-delta-v2',
      sessionId: this.sid,
      timestamp: 't',
      turnId: input.turnId,
      itemId: `a-${input.turnId}`,
      delta: { text: 'partial…' },
    });
    // No terminal patch: the turn stays live until interrupt() or complete().
  }

  async steerMessage(input: AgentSendMessageInputV2): Promise<void> {
    this.steerAttempts.push(input);
    if (!this.supportsSafeBoundarySteer) {
      throw new Error('safe-boundary steering unavailable');
    }
    if (this.rejectsSafeBoundarySteer) {
      throw new AgentSteerRejectedError('activeTurnNotSteerable');
    }
    if (this.failsSafeBoundarySteer) {
      throw new Error('steer transport reset');
    }
    if (this.hangsSafeBoundarySteer) {
      return new Promise<void>(() => {});
    }
    this.steerInputs.push(input);
  }

  async interrupt(input: AgentInterruptInputV2): Promise<void> {
    const turnId = input.turnId ?? [...this.open][0];
    if (turnId === undefined) return;
    this.interruptCalls.push(turnId);
    this.closeTurn(turnId, 'interrupted');
  }

  /** Finish the newest live turn the way a normal completion would. */
  completeLatest(text = 'done'): void {
    const turnId = this.sendCalls[this.sendCalls.length - 1];
    if (turnId === undefined) return;
    this.emitPatch({
      type: 'agent-item-updated-v2',
      sessionId: this.sid,
      timestamp: 't',
      turnId,
      item: {
        type: 'assistantMessage',
        id: `a-${turnId}`,
        text,
        status: 'completed',
      },
    });
    this.closeTurn(turnId, 'completed');
  }

  private closeTurn(
    turnId: string,
    status: 'completed' | 'interrupted' | 'failed'
  ): void {
    if (!this.open.delete(turnId)) return;
    this.emitPatch({
      type: 'agent-turn-completed-v2',
      sessionId: this.sid,
      timestamp: 't',
      turnId,
      status,
    });
  }
}

// ── deferred-send adapter (send acceptance resolved/rejected on command) ──────
// sendMessage returns a promise the test resolves (accept) or rejects (transport
// failure) explicitly, so the send-failure/rebind interleaving is deterministic.
class DeferredAdapter extends BaseProtocolAdapterV2 {
  readonly runtimeOwnership = 'spawned' as const;
  readonly capabilities: AgentCapabilitySetV2 = {
    text: true,
    streaming: true,
    interrupt: true,
    queue: false,
  };
  readonly sendCalls: string[] = [];
  readonly sendInputs: AgentSendMessageInputV2[] = [];
  private _status: AdapterStatus = 'disconnected';
  private sid = 'deferred';
  private readonly pending = new Map<
    string,
    { resolve: () => void; reject: (err: unknown) => void }
  >();

  constructor(readonly agentType: string) {
    super();
  }
  get status(): AdapterStatus {
    return this._status;
  }
  async connect(config: AdapterConfig): Promise<void> {
    this._status = 'connected';
    this.sid = config.sessionId;
  }
  protected async onDisconnect(): Promise<void> {
    this._status = 'disconnected';
  }
  async reconnect(): Promise<void> {}
  async resumeSession(): Promise<void> {}
  async interrupt(): Promise<void> {}
  async respondToApproval(): Promise<void> {}
  async respondToInput(): Promise<void> {}

  sendMessage(input: AgentSendMessageInputV2): Promise<void> {
    this.sendCalls.push(input.turnId);
    this.sendInputs.push(input);
    return new Promise<void>((resolve, reject) => {
      this.pending.set(input.turnId, { resolve, reject });
    });
  }

  rejectSend(turnId: string): void {
    const d = this.pending.get(turnId);
    this.pending.delete(turnId);
    d?.reject(new Error('transport down'));
  }

  /** Open a tool call this runtime will never close (it is about to die). */
  openTool(turnId: string, itemId = 'tool-dead'): void {
    this.emitPatch({
      type: 'agent-item-started-v2',
      sessionId: this.sid,
      timestamp: 't',
      turnId,
      item: {
        type: 'commandExecution',
        id: itemId,
        command: 'npm run check',
        output: '',
        status: 'running',
      },
    });
  }

  /** Accept the send AND stream a completing reply for the turn. */
  completeReply(turnId: string, text: string): void {
    const d = this.pending.get(turnId);
    this.pending.delete(turnId);
    d?.resolve();
    const itemId = `a-${turnId}`;
    this.emitPatch({
      type: 'agent-item-started-v2',
      sessionId: this.sid,
      timestamp: 't',
      turnId,
      item: { type: 'assistantMessage', id: itemId, text: '' },
    });
    this.emitPatch({
      type: 'agent-item-delta-v2',
      sessionId: this.sid,
      timestamp: 't',
      turnId,
      itemId,
      delta: { text },
    });
    this.emitPatch({
      type: 'agent-item-updated-v2',
      sessionId: this.sid,
      timestamp: 't',
      turnId,
      item: { type: 'assistantMessage', id: itemId, text, status: 'completed' },
    });
    this.emitPatch({
      type: 'agent-turn-completed-v2',
      sessionId: this.sid,
      timestamp: 't',
      turnId,
      status: 'completed',
    });
  }
}

// ── parked-on-approval adapter (#1307) ───────────────────────────────────────
// Opens a turn and parks it on an approval, which is the ONE state the watchdog
// deliberately refuses to force-drain (draining it would abandon the approval).
// Presence therefore has no timer under it: if the runtime dies here without a
// terminal transition, the header chip and the in-timeline presence row stay
// busy forever. `die()` models the unexpected process/transport death an adapter
// reports as a `disconnected` live state; the runtime can also be made to vanish
// from the registry with no notification at all (`forgetWithoutEnd`).
class ParkedOnApprovalAdapter extends BaseProtocolAdapterV2 {
  readonly runtimeOwnership = 'spawned' as const;
  readonly capabilities: AgentCapabilitySetV2 = {
    text: true,
    streaming: true,
    interrupt: true,
  };
  readonly sendCalls: string[] = [];
  private _status: AdapterStatus = 'disconnected';
  private sid = 'parked';

  constructor(readonly agentType: string) {
    super();
  }
  get status(): AdapterStatus {
    return this._status;
  }
  async connect(config: AdapterConfig): Promise<void> {
    this._status = 'connected';
    this.sid = config.sessionId;
  }
  protected async onDisconnect(): Promise<void> {
    this._status = 'disconnected';
  }
  async reconnect(): Promise<void> {}
  async resumeSession(): Promise<void> {}
  async interrupt(_i: AgentInterruptInputV2): Promise<void> {}
  async respondToApproval(_i: AgentApprovalResponseInputV2): Promise<void> {}
  async respondToInput(): Promise<void> {}

  async sendMessage(input: AgentSendMessageInputV2): Promise<void> {
    this.sendCalls.push(input.turnId);
    this.emitPatch({
      type: 'agent-turn-started-v2',
      sessionId: this.sid,
      timestamp: 't',
      turn: {
        id: input.turnId,
        status: 'running',
        inputMessageId: `user-${input.turnId}`,
        items: [],
        startedAt: 't',
      },
    });
    this.emitPatch({
      type: 'agent-live-state-updated-v2',
      sessionId: this.sid,
      timestamp: 't',
      live: {
        status: 'waiting',
        activeTurnId: input.turnId,
        waitingOn: 'approval',
        error: null,
      },
    });
  }

  /** Unexpected process death, as codex reports it when its client closes. */
  die(): void {
    this._status = 'disconnected';
    this.emitPatch({
      type: 'agent-live-state-updated-v2',
      sessionId: this.sid,
      timestamp: 't',
      live: {
        status: 'disconnected',
        activeTurnId: null,
        waitingOn: null,
        activeRequestIds: [],
        queueLength: 0,
      },
    });
  }
}

// ── idle-without-turn-completed adapter (#1181 defect 3) ─────────────────────
// Emits `working` then a trailing `idle` live-state but NO agent-turn-completed-v2
// (and no assistant item) — the shape a hermes turn produces when it signals
// session-status idle without a paired turn-completed. Reproduces the presence
// wedge: the binder must fall back to idle instead of flipping to 'thinking'.
class IdleWithoutTurnCompletedAdapter extends BaseProtocolAdapterV2 {
  readonly runtimeOwnership = 'attached' as const;
  readonly capabilities: AgentCapabilitySetV2 = {
    text: true,
    interrupt: true,
    streaming: true,
  };
  private _status: AdapterStatus = 'disconnected';
  private sid = 'idle-nc';
  constructor(readonly agentType: string) {
    super();
  }
  get status(): AdapterStatus {
    return this._status;
  }
  async connect(config: AdapterConfig): Promise<void> {
    this._status = 'connected';
    this.sid = config.sessionId;
  }
  protected async onDisconnect(): Promise<void> {
    this._status = 'disconnected';
  }
  async reconnect(): Promise<void> {}
  async resumeSession(): Promise<void> {}
  async interrupt(_i: AgentInterruptInputV2): Promise<void> {}
  async respondToApproval(): Promise<void> {}
  async respondToInput(): Promise<void> {}
  async sendMessage(input: AgentSendMessageInputV2): Promise<void> {
    this.emitPatch({
      type: 'agent-live-state-updated-v2',
      sessionId: this.sid,
      timestamp: 't',
      live: { status: 'working', error: null },
    });
    this.emitPatch({
      type: 'agent-turn-started-v2',
      sessionId: this.sid,
      timestamp: 't',
      turn: {
        id: input.turnId,
        status: 'running',
        inputMessageId: `user-${input.turnId}`,
        items: [],
        startedAt: 't',
      },
    });
    // No assistant item, and crucially NO agent-turn-completed-v2 — only a
    // trailing idle live-state, as a hermes turn can emit.
    this.emitPatch({
      type: 'agent-live-state-updated-v2',
      sessionId: this.sid,
      timestamp: 't',
      live: {
        status: 'idle',
        activeTurnId: null,
        waitingOn: null,
        activeRequestIds: [],
        error: null,
      },
    });
  }
}

// Bare-idle harness with explicit late/error terminals. It keeps lifecycle
// ordering deterministic for retained-parent pruning and legacy error-pair
// regressions without relying on timers.
class ManualBareIdleAdapter extends BaseProtocolAdapterV2 {
  readonly runtimeOwnership = 'attached' as const;
  readonly capabilities: AgentCapabilitySetV2 = {
    text: true,
    interrupt: true,
    streaming: true,
  };
  readonly sendCalls: string[] = [];
  private _status: AdapterStatus = 'disconnected';
  private sid = 'manual-idle';
  private itemNumber = 0;
  private idleOneSend = false;

  constructor(
    readonly agentType: string,
    private readonly autoIdle = true
  ) {
    super();
  }
  get status(): AdapterStatus {
    return this._status;
  }
  async connect(config: AdapterConfig): Promise<void> {
    this._status = 'connected';
    this.sid = config.sessionId;
  }
  protected async onDisconnect(): Promise<void> {
    this._status = 'disconnected';
  }
  async reconnect(): Promise<void> {}
  async resumeSession(): Promise<void> {}
  async interrupt(_i: AgentInterruptInputV2): Promise<void> {}
  async respondToApproval(): Promise<void> {}
  async respondToInput(): Promise<void> {}

  async sendMessage(input: AgentSendMessageInputV2): Promise<void> {
    this.sendCalls.push(input.turnId);
    if (this.autoIdle || this.idleOneSend) {
      this.idleOneSend = false;
      this.emitPatch({
        type: 'agent-live-state-updated-v2',
        sessionId: this.sid,
        timestamp: 't',
        live: { status: 'idle', activeTurnId: null },
      });
    }
  }

  idleNextSend(): void {
    this.idleOneSend = true;
  }

  emitLate(turnId: string, text = 'late reply'): void {
    this.emitPatch({
      type: 'agent-item-updated-v2',
      sessionId: this.sid,
      timestamp: 't',
      turnId,
      item: {
        type: 'assistantMessage',
        id: `manual-late-${++this.itemNumber}`,
        text,
        status: 'completed',
      },
    });
  }

  emitCompleted(turnId: string): void {
    this.emitPatch({
      type: 'agent-turn-completed-v2',
      sessionId: this.sid,
      timestamp: 't',
      turnId,
      status: 'completed',
    });
  }

  emitError(message: string): void {
    this.emitPatch({
      type: 'agent-error-v2',
      sessionId: this.sid,
      timestamp: 't',
      message,
    });
  }

  emitLegacyErrorPair(message: string): void {
    this.emitError(message);
    this.emitCompleted('turn-0');
  }
}

// Emits bare idle before its first assistant row. This reproduces late-opening
// output after binder finishTurn, including Hermes' `turn-0` fallback label.
class LateOpeningReplyAdapter extends BaseProtocolAdapterV2 {
  readonly runtimeOwnership = 'attached' as const;
  readonly capabilities: AgentCapabilitySetV2 = {
    text: true,
    interrupt: true,
    streaming: true,
  };
  private _status: AdapterStatus = 'disconnected';
  private sid = 'late';
  private outputNumber = 0;

  constructor(
    readonly agentType: string,
    private readonly fallbackTurnId: boolean
  ) {
    super();
  }
  get status(): AdapterStatus {
    return this._status;
  }
  async connect(config: AdapterConfig): Promise<void> {
    this._status = 'connected';
    this.sid = config.sessionId;
  }
  protected async onDisconnect(): Promise<void> {
    this._status = 'disconnected';
  }
  async reconnect(): Promise<void> {}
  async resumeSession(): Promise<void> {}
  async interrupt(_i: AgentInterruptInputV2): Promise<void> {}
  async respondToApproval(): Promise<void> {}
  async respondToInput(): Promise<void> {}
  async sendMessage(input: AgentSendMessageInputV2): Promise<void> {
    const outputNumber = ++this.outputNumber;
    this.emitPatch({
      type: 'agent-live-state-updated-v2',
      sessionId: this.sid,
      timestamp: 't',
      live: { status: 'idle', activeTurnId: null },
    });
    const turnId = this.fallbackTurnId ? 'turn-0' : input.turnId;
    setTimeout(() => {
      this.emitPatch({
        type: 'agent-item-updated-v2',
        sessionId: this.sid,
        timestamp: 't',
        turnId,
        item: {
          type: 'assistantMessage',
          id: `late-${turnId}-${outputNumber}`,
          text: 'late reply',
          status: 'completed',
        },
      });
      this.emitPatch({
        type: 'agent-turn-completed-v2',
        sessionId: this.sid,
        timestamp: 't',
        turnId,
        status: 'completed',
      });
    }, 5).unref?.();
  }
}

// ── sessions harness ─────────────────────────────────────────────────────────

interface SessionsHarness {
  sessions: BinderRuntimes;
  spawns: () => number;
  destroyCalls: () => string[];
  firstSessionId: () => string;
  adapterFor: (sessionId: string) => ProtocolAdapterV2;
  fireEnd: (sessionId: string) => void;
  forgetWithoutEnd: (sessionId: string) => void;
  registerSourceSession: (sessionId: string, role: AgentRole) => void;
  registerRestoredRuntime: (
    sessionId: string,
    agentType: string,
    role: AgentRole,
    profileId?: string
  ) => Promise<void>;
  lastCreateParams: () => CreateChannelAgentRuntimeParams | undefined;
  createParams: () => CreateChannelAgentRuntimeParams[];
}

function makeSessions(
  build: (agentType: string) => ProtocolAdapterV2,
  opts: {
    throwOnCreate?: boolean;
    createError?: unknown;
    createErrorOnce?: unknown;
    gate?: Promise<void>;
  } = {}
): SessionsHarness {
  const created = new Map<string, { runtime: ChannelAgentRuntime }>();
  const order: string[] = [];
  const endCbs: Array<(id: string) => void> = [];
  const destroyCalls: string[] = [];
  let spawns = 0;
  let createErrorOnceRaised = false;
  let lastParams: CreateChannelAgentRuntimeParams | undefined;
  const createParams: CreateChannelAgentRuntimeParams[] = [];
  const sessions: BinderRuntimes = {
    async create(params) {
      spawns++;
      lastParams = params;
      createParams.push(params);
      if (opts.createError !== undefined) throw opts.createError;
      if (opts.createErrorOnce !== undefined && !createErrorOnceRaised) {
        createErrorOnceRaised = true;
        throw opts.createErrorOnce;
      }
      if (opts.throwOnCreate) throw new Error('boom: spawn failed');
      // Optional gate: park the spawn so a test can drive a close()/reorder race
      // between runtime creation being invoked and its continuation resuming.
      if (opts.gate) await opts.gate;
      const id = `sess-${spawns}-${params.providerId}`;
      const adapter = build(params.providerId);
      await adapter.connect({
        cwd: params.cwd,
        port: 0,
        sessionId: id,
        hookToken: 't',
        configDir: params.configDir,
      });
      const runtime = {
        id,
        providerId: params.providerId,
        profileActorId: params.profileActorId,
        threadId: params.threadId ?? null,
        ...(params.role !== undefined ? { role: params.role } : {}),
        status: 'active',
        adapter,
        cwd: params.cwd,
        providerSession: {},
      } as unknown as ChannelAgentRuntime;
      created.set(id, { runtime });
      order.push(id);
      return runtime;
    },
    get(id) {
      return created.get(id)?.runtime;
    },
    async destroy(id) {
      if (!created.delete(id)) return;
      destroyCalls.push(id);
      for (const cb of [...endCbs]) cb(id);
    },
    onRuntimeEnd(cb) {
      endCbs.push(cb);
      return () => {
        const i = endCbs.indexOf(cb);
        if (i >= 0) endCbs.splice(i, 1);
      };
    },
  };
  return {
    sessions,
    spawns: () => spawns,
    destroyCalls: () => destroyCalls,
    firstSessionId: () => order[0]!,
    adapterFor: (id) => created.get(id)!.runtime.adapter,
    fireEnd: (id) => {
      created.delete(id);
      for (const cb of [...endCbs]) cb(id);
    },
    forgetWithoutEnd: (id) => {
      created.delete(id);
    },
    registerSourceSession: (id, role) => {
      created.set(id, {
        runtime: { id, role } as unknown as ChannelAgentRuntime,
      });
    },
    registerRestoredRuntime: async (id, agentType, role, profileId) => {
      const adapter = build(agentType);
      await adapter.connect({
        cwd: '/tmp',
        port: 0,
        sessionId: id,
        hookToken: 't',
        configDir: '/tmp',
      });
      created.set(id, {
        runtime: {
          id,
          providerId: agentType,
          profileActorId: profileId ?? builtInAgentProfileId(agentType),
          role,
          status: 'active',
          adapter,
          cwd: '/tmp',
          providerSession: {},
        } as unknown as ChannelAgentRuntime,
      });
    },
    lastCreateParams: () => lastParams,
    createParams: () => createParams,
  };
}

const MOCK_TARGETS: MentionTarget[] = [
  {
    id: 'mock',
    displayName: 'Mock',
    kind: 'framework',
    available: true,
    reason: null,
  },
];

/** Only a real built-in provider id has a `providerResumeId` key (#1408). */
const CLAUDE_TARGETS: MentionTarget[] = [
  {
    id: 'claude',
    displayName: 'Claude',
    kind: 'framework',
    available: true,
    reason: null,
  },
];

function makeBinder(cfg: {
  build: (agentType: string) => ProtocolAdapterV2;
  targets: MentionTarget[];
  mentionTargets?: () => Promise<MentionTarget[]>;
  knownProviderIds: string[];
  topicStore?: WorkspaceTopicStore | null;
  watchdogMs?: number;
  turnCeilingMs?: number;
  presenceSweepMs?: number;
  throwOnCreate?: boolean;
  createError?: unknown;
  createErrorOnce?: unknown;
  yolo?: boolean;
  gate?: Promise<void>;
  attachmentStore?: ChannelAttachmentStore;
  agentProfileStore?: AgentProfileStore | null;
  processEnv?: NodeJS.ProcessEnv;
  storePath?: string;
  now?: () => number;
  deliveryContractProbeFactory?: Parameters<
    typeof createChannelAgentBinder
  >[0]['deliveryContractProbeFactory'];
}): {
  binder: ChannelAgentBinder;
  store: ChannelMessageStore;
  hub: ChannelHub;
  sessions: SessionsHarness;
} {
  const { store, hub } = makeStore(cfg.storePath);
  const sessions = makeSessions(cfg.build, {
    ...(cfg.throwOnCreate ? { throwOnCreate: true } : {}),
    ...(cfg.createError !== undefined ? { createError: cfg.createError } : {}),
    ...(cfg.createErrorOnce !== undefined
      ? { createErrorOnce: cfg.createErrorOnce }
      : {}),
    ...(cfg.gate ? { gate: cfg.gate } : {}),
  });
  const binder = createChannelAgentBinder({
    store,
    ...(cfg.attachmentStore ? { attachmentStore: cfg.attachmentStore } : {}),
    hub,
    topicStore: cfg.topicStore ?? null,
    ...(cfg.agentProfileStore !== undefined
      ? { agentProfileStore: cfg.agentProfileStore }
      : {}),
    runtimes: sessions.sessions,
    knownProviderIds: cfg.knownProviderIds,
    mentionTargets: cfg.mentionTargets ?? (async () => cfg.targets),
    port: 0,
    configDir: '/tmp',
    ...(cfg.watchdogMs !== undefined ? { watchdogMs: cfg.watchdogMs } : {}),
    ...(cfg.turnCeilingMs !== undefined
      ? { turnCeilingMs: cfg.turnCeilingMs }
      : {}),
    ...(cfg.presenceSweepMs !== undefined
      ? { presenceSweepMs: cfg.presenceSweepMs }
      : {}),
    ...(cfg.yolo !== undefined ? { yolo: cfg.yolo } : {}),
    ...(cfg.processEnv !== undefined ? { processEnv: cfg.processEnv } : {}),
    ...(cfg.now !== undefined ? { now: cfg.now } : {}),
    ...(cfg.deliveryContractProbeFactory
      ? { deliveryContractProbeFactory: cfg.deliveryContractProbeFactory }
      : {}),
  });
  cleanup.push(() => binder.close());
  return { binder, store, hub, sessions };
}

// ── tests ────────────────────────────────────────────────────────────────────

describe('channel-agent-binder — lifecycle', () => {
  it('reports binding admission synchronously and returns to archive-safe when idle', async () => {
    let releaseSpawn!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseSpawn = resolve;
    });
    const { binder } = makeBinder({
      build: (agentType) => new ScriptedAdapter(agentType, { mode: 'stall' }),
      targets: MOCK_TARGETS,
      knownProviderIds: ['mock'],
      gate,
    });

    expect(binder.archiveActivityForChannel(CH)).toEqual({
      active: false,
      reasons: [],
    });
    const binding = binder.ensureBinding(CH, 'mock');
    expect(binder.archiveActivityForChannel(CH)).toMatchObject({
      active: true,
      reasons: expect.arrayContaining(['binding-in-flight']),
    });

    releaseSpawn();
    await binding;
    expect(binder.archiveActivityForChannel(CH)).toEqual({
      active: false,
      reasons: [],
    });
  });

  it('discovers and executes only confirmed Codex controls without persisting or routing a message', async () => {
    const calls: Array<{
      command: string;
      args?: string;
      confirmed?: boolean;
    }> = [];
    const { binder, store } = makeBinder({
      build: (agentType) => {
        const adapter = new ScriptedAdapter(agentType, { mode: 'stall' });
        Object.assign(adapter, {
          getSlashCommands: () => [
            {
              name: 'model',
              dispatch: 'relay-control',
              collisionKey: 'model',
              args: [{ value: 'gpt-fast', label: 'GPT Fast' }],
            },
            { name: 'deploy', dispatch: 'agent', collisionKey: 'deploy' },
          ],
          executeControlCommand: async (input: {
            command: string;
            args?: string;
            confirmed?: boolean;
          }) => {
            calls.push(input);
            return { config: { model: input.args ?? null } };
          },
        });
        return adapter;
      },
      targets: [
        {
          id: 'codex',
          displayName: 'Codex',
          kind: 'framework',
          available: true,
          reason: null,
        },
      ],
      knownProviderIds: ['codex'],
    });
    const profileId = builtInAgentProfileId('codex');
    const roster = await binder.rosterForChannel(CH);
    expect(roster[0]?.commands?.map((command) => command.name)).toContain(
      'model'
    );
    expect(
      roster[0]?.commands?.some((command) => command.name === 'deploy')
    ).toBe(false);
    await expect(
      binder.executeCommand(CH, profileId, 'rollback', '1')
    ).rejects.toMatchObject({
      reasonCode: 'CONFIRMATION_REQUIRED',
    });
    await binder.executeCommand(CH, profileId, 'model', 'gpt-fast', true);
    expect(calls).toEqual([
      { command: 'model', args: 'gpt-fast', confirmed: true },
    ]);
    const liveRoster = await binder.rosterForChannel(CH);
    expect(
      liveRoster[0]?.commands?.find((command) => command.name === 'model')?.args
    ).toEqual([{ value: 'gpt-fast', label: 'GPT Fast' }]);
    expect(rows(store)).toHaveLength(0);
  });

  it('executes a provider command in its exact thread runtime without creating root state', async () => {
    const commands: string[] = [];
    const { binder, store, sessions } = makeBinder({
      build: (agentType) => {
        const adapter = new ScriptedAdapter(agentType, { mode: 'stall' });
        Object.assign(adapter, {
          getSlashCommands: () => [
            { name: 'compact', dispatch: 'relay-control' },
          ],
          executeControlCommand: async ({ command }: { command: string }) => {
            commands.push(command);
            return {};
          },
        });
        return adapter;
      },
      targets: MOCK_TARGETS,
      knownProviderIds: ['mock'],
    });
    const root = store.appendComplete({
      channelId: CH,
      sender: OPERATOR,
      text: 'conversation root',
    });
    const profileId = builtInAgentProfileId('mock');

    await binder.executeCommand(
      CH,
      profileId,
      'compact',
      undefined,
      undefined,
      root.id
    );

    expect(commands).toEqual(['compact']);
    expect(sessions.createParams()).toEqual([
      expect.objectContaining({ threadId: root.id }),
    ]);
    expect(store.getBinding(CH, profileId)).toBeNull();
    expect(store.getBinding(CH, profileId, root.id)?.runtimeId).toBeTruthy();
  });

  it('does not advertise unbound Prime controls and treats a connected empty catalog as authoritative', async () => {
    let adapter: ScriptedAdapter | null = null;
    const { binder, store } = makeBinder({
      build: (agentType) => {
        adapter = new ScriptedAdapter(agentType, {
          mode: 'reply',
          text: 'ack',
        });
        Object.assign(adapter, { getSlashCommands: () => [] });
        return adapter;
      },
      targets: [
        {
          id: 'prime-agent',
          displayName: 'Prime Agent',
          kind: 'framework',
          available: true,
          reason: null,
        },
      ],
      knownProviderIds: ['prime-agent'],
    });

    const preview = await binder.rosterForChannel(CH);
    expect(preview[0]?.commands).toBeUndefined();
    expect(binder.isControlMessage('@prime-agent /model')).toBe(true);
    expect(binder.isControlMessage('@prime-agent /thinking high')).toBe(true);
    expect(binder.isControlMessage('@prime-agent /effort high')).toBe(true);
    expect(binder.isControlMessage('@prime-agent /compact')).toBe(false);
    expect(binder.isControlMessage('@prime-agent /new')).toBe(false);
    expect(binder.isControlMessage('@prime-agent /clear')).toBe(false);
    expect(binder.isControlMessage('@prime-agent /reset')).toBe(false);
    await binder.ensureBinding(CH, 'prime-agent');
    const connected = await binder.rosterForChannel(CH);
    expect(connected[0]?.commands).toBeUndefined();
    expect(adapter).not.toBeNull();
    post(store, binder, '@prime-agent /compact', ['prime-agent']);
    post(store, binder, '@prime-agent /new', ['prime-agent']);
    await waitFor(() => adapter!.sendInputs.length === 2);
    expect(adapter!.sendInputs[0]!.content).toContain('/compact');
    expect(adapter!.sendInputs[1]!.content).toContain('/new');
  });

  it('waits for a cold Prime binding to discover the requested control before dispatch', async () => {
    let releaseDiscovery!: () => void;
    const discovery = new Promise<void>((resolve) => {
      releaseDiscovery = resolve;
    });
    let enteredDiscovery!: () => void;
    const entered = new Promise<void>((resolve) => {
      enteredDiscovery = resolve;
    });
    const calls: string[] = [];
    const { binder } = makeBinder({
      build: (agentType) => {
        const adapter = new ScriptedAdapter(agentType, { mode: 'stall' });
        const connect = adapter.connect.bind(adapter);
        let discovered = false;
        Object.assign(adapter, {
          connect: async (adapterConfig: AdapterConfig) => {
            enteredDiscovery();
            await discovery;
            await connect(adapterConfig);
            discovered = true;
          },
          getSlashCommands: () =>
            discovered
              ? [
                  {
                    name: 'compact',
                    dispatch: 'relay-control' as const,
                    collisionKey: 'compact',
                  },
                ]
              : [],
          executeControlCommand: async (input: { command: string }) => {
            calls.push(input.command);
            return {};
          },
        });
        return adapter;
      },
      targets: [
        {
          id: 'prime-agent',
          displayName: 'Prime Agent',
          kind: 'framework',
          available: true,
          reason: null,
        },
      ],
      knownProviderIds: ['prime-agent'],
    });
    const profileId = builtInAgentProfileId('prime-agent');
    expect((await binder.rosterForChannel(CH))[0]?.commands).toBeUndefined();

    const command = binder.executeCommand(CH, profileId, 'compact');
    await entered;
    expect(calls).toEqual([]);
    releaseDiscovery();
    await command;
    expect(calls).toEqual(['compact']);
  });

  it('maps a live provider control retraction to a typed unavailable result', async () => {
    const { binder } = makeBinder({
      build: (agentType) => {
        const adapter = new ScriptedAdapter(agentType, { mode: 'stall' });
        Object.assign(adapter, {
          getSlashCommands: () => [
            {
              name: 'compact',
              dispatch: 'relay-control' as const,
              collisionKey: 'compact',
            },
          ],
          executeControlCommand: async () => {
            throw new AgentControlUnavailableError(
              'compact',
              'Prime Agent no longer supports /compact on this runtime'
            );
          },
        });
        return adapter;
      },
      targets: [
        {
          id: 'prime-agent',
          displayName: 'Prime Agent',
          kind: 'framework',
          available: true,
          reason: null,
        },
      ],
      knownProviderIds: ['prime-agent'],
    });

    await expect(
      binder.executeCommand(CH, builtInAgentProfileId('prime-agent'), 'compact')
    ).rejects.toMatchObject({ reasonCode: 'UNAVAILABLE_COMMAND' });
  });

  it('does not advertise relay controls from an adapter without a control executor', async () => {
    const { binder } = makeBinder({
      build: (agentType) => {
        const adapter = new ScriptedAdapter(agentType, { mode: 'stall' });
        Object.assign(adapter, {
          getSlashCommands: () => [
            {
              name: 'model',
              dispatch: 'relay-control',
              collisionKey: 'model',
            },
          ],
        });
        return adapter;
      },
      targets: [
        {
          id: 'mock',
          displayName: 'Mock',
          kind: 'framework',
          available: true,
          reason: null,
        },
      ],
      knownProviderIds: ['mock'],
    });

    await binder.ensureBinding(CH, 'mock');
    const connected = await binder.rosterForChannel(CH);
    expect(connected[0]?.commands).toBeUndefined();
  });

  it('targets command controls by exact named-profile Actor ID across a display-name collision', async () => {
    const profiles = createAgentProfileStore(':memory:');
    cleanup.push(() => profiles.close());
    profiles.seedBuiltIns([{ id: 'mock' }]);
    const backend = profiles.create({
      id: 'agent-profile:mock:backend-command',
      providerId: 'mock',
      displayName: 'Reviewer',
    });
    const audit = profiles.create({
      id: 'agent-profile:mock:audit-command',
      providerId: 'mock',
      displayName: 'Reviewer',
    });
    const calls: Array<{ profile: string; command: string }> = [];
    let created = 0;
    const { binder } = makeBinder({
      build: (agentType) => {
        const profile = ++created === 1 ? backend.id : audit.id;
        const command = profile === backend.id ? 'model' : 'compact';
        const adapter = new ScriptedAdapter(agentType, { mode: 'stall' });
        Object.assign(adapter, {
          getSlashCommands: () => [
            { name: command, dispatch: 'relay-control', collisionKey: command },
          ],
          executeControlCommand: async (input: { command: string }) => {
            calls.push({ profile, command: input.command });
            return { config: { profile } };
          },
        });
        return adapter;
      },
      targets: MOCK_TARGETS,
      knownProviderIds: ['mock'],
      agentProfileStore: profiles,
    });

    const tokens = computeMentionDisambiguators(profiles.list());
    expect(
      parseMentions(
        `@Reviewer#${tokens.get(backend.id)}`,
        ['mock'],
        profiles.list()
      )[0]?.profileId
    ).toBe(backend.id);
    expect(
      parseMentions(
        `@Reviewer#${tokens.get(audit.id)}`,
        ['mock'],
        profiles.list()
      )[0]?.profileId
    ).toBe(audit.id);

    await binder.executeCommand(CH, backend.id, 'model', 'gpt-test');
    await binder.executeCommand(CH, audit.id, 'compact');
    expect(calls).toEqual([
      { profile: backend.id, command: 'model' },
      { profile: audit.id, command: 'compact' },
    ]);
    const roster = await binder.rosterForChannel(CH);
    expect(
      roster
        .find((entry) => entry.id === backend.id)
        ?.commands?.map((c) => c.name)
    ).toEqual(['model']);
    expect(
      roster
        .find((entry) => entry.id === audit.id)
        ?.commands?.map((c) => c.name)
    ).toEqual(['compact']);
  });

  it('uses the same adapter control contract for current providers and leaves unsupported providers empty', async () => {
    const providerIds = ['claude', 'codex', 'opencode', 'hermes'];
    const calls: Array<{ providerId: string; command: string }> = [];
    const targets: MentionTarget[] = [
      ...providerIds.map((id) => ({
        id,
        displayName: id,
        kind: 'framework' as const,
        available: true,
        reason: null,
      })),
      {
        id: 'unsupported',
        displayName: 'unsupported',
        kind: 'framework' as const,
        available: false,
        reason: 'adapter unavailable',
      },
    ];
    const { binder } = makeBinder({
      build: (agentType) => {
        const adapter = new ScriptedAdapter(agentType, { mode: 'stall' });
        Object.assign(adapter, {
          getSlashCommands: () => [
            {
              name: 'compact',
              dispatch: 'relay-control',
              collisionKey: 'compact',
            },
          ],
          executeControlCommand: async (input: { command: string }) => {
            calls.push({ providerId: agentType, command: input.command });
            return {};
          },
        });
        return adapter;
      },
      targets,
      knownProviderIds: [...providerIds, 'unsupported'],
    });

    for (const providerId of providerIds) {
      await binder.executeCommand(
        CH,
        builtInAgentProfileId(providerId),
        'compact'
      );
    }
    expect(calls).toEqual(
      providerIds.map((providerId) => ({ providerId, command: 'compact' }))
    );
    expect(relayControlCatalogForProvider('unsupported')).toEqual([]);
    await expect(
      binder.executeCommand(CH, builtInAgentProfileId('unsupported'), 'compact')
    ).rejects.toMatchObject({ reasonCode: 'UNAVAILABLE' });
  });

  it('passes a hermes profile binding through to adapter extra, and only for hermes (#1453)', async () => {
    const profiles = createAgentProfileStore(':memory:');
    cleanup.push(() => profiles.close());
    profiles.seedBuiltIns([{ id: 'hermes' }, { id: 'mock' }]);
    profiles.create({
      id: 'agent-profile:hermes:po',
      providerId: 'hermes',
      displayName: 'Product Owner',
      hermesProfile: 'koi-product',
    });
    // A stale binding left on a NON-hermes profile must not reach that
    // adapter's `extra` — the field is a Hermes multiplex quirk, not a generic
    // provider option.
    profiles.create({
      id: 'agent-profile:mock:stale',
      providerId: 'mock',
      displayName: 'Stale Mock',
      hermesProfile: 'koi-product',
    });
    const { binder, sessions, store } = makeBinder({
      build: () => new MockProtocolAdapterV2({ connectMs: 1, stepMs: 1 }),
      targets: [
        {
          id: 'hermes',
          displayName: 'Hermes',
          kind: 'framework',
          available: true,
          reason: null,
        },
        ...MOCK_TARGETS,
      ],
      knownProviderIds: ['hermes', 'mock'],
      agentProfileStore: profiles,
    });

    post(store, binder, '@Product Owner one', ['hermes']);
    await waitFor(() => sessions.spawns() === 1);
    expect(sessions.lastCreateParams()).toMatchObject({
      providerId: 'hermes',
      extra: { hermesProfile: 'koi-product' },
    });

    post(store, binder, '@Stale Mock two', ['mock']);
    await waitFor(() => sessions.spawns() === 2);
    const mockParams = sessions.lastCreateParams() as {
      providerId: string;
      extra?: Record<string, unknown>;
    };
    expect(mockParams.providerId).toBe('mock');
    expect(mockParams.extra?.['hermesProfile']).toBeUndefined();
  });

  it('carries the per-profile gateway key alongside a binding, and only then (#1453)', async () => {
    const profiles = createAgentProfileStore(':memory:');
    cleanup.push(() => profiles.close());
    profiles.seedBuiltIns([{ id: 'hermes' }, { id: 'mock' }]);
    profiles.create({
      id: 'agent-profile:hermes:bound',
      providerId: 'hermes',
      displayName: 'Bound Hermes',
      hermesProfile: 'koi-product',
      hermesApiKey: 'koi-only-key',
    });
    // A key with NO binding: the runtime talks to the gateway default, which
    // the named profile's key cannot authenticate, so it must not be sent.
    profiles.create({
      id: 'agent-profile:hermes:unbound',
      providerId: 'hermes',
      displayName: 'Unbound Hermes',
      hermesApiKey: 'orphan-key',
    });
    // A key stranded on a provider with no gateway-secret descriptor row.
    profiles.create({
      id: 'agent-profile:mock:stale-key',
      providerId: 'mock',
      displayName: 'Stale Key Mock',
      hermesProfile: 'koi-product',
      hermesApiKey: 'stale-key',
    });
    const { binder, sessions, store } = makeBinder({
      build: () => new MockProtocolAdapterV2({ connectMs: 1, stepMs: 1 }),
      targets: [
        {
          id: 'hermes',
          displayName: 'Hermes',
          kind: 'framework',
          available: true,
          reason: null,
        },
        ...MOCK_TARGETS,
      ],
      knownProviderIds: ['hermes', 'mock'],
      agentProfileStore: profiles,
    });

    post(store, binder, '@Bound Hermes one', ['hermes']);
    await waitFor(() => sessions.spawns() === 1);
    expect(sessions.lastCreateParams()).toMatchObject({
      providerId: 'hermes',
      extra: { hermesProfile: 'koi-product', hermesApiKey: 'koi-only-key' },
    });

    // `extra` is runtime-only, and the durable binding row is where a leak
    // would become permanent. `ChannelMessageStore.upsertBinding` has no
    // `extra` field at all, so this is belt-and-braces on that contract.
    expect(
      JSON.stringify(store.getBinding(CH, 'agent-profile:hermes:bound'))
    ).not.toContain('koi-only-key');

    post(store, binder, '@Unbound Hermes two', ['hermes']);
    await waitFor(() => sessions.spawns() === 2);
    const unbound = sessions.lastCreateParams() as {
      extra?: Record<string, unknown>;
    };
    expect(unbound.extra?.['hermesApiKey']).toBeUndefined();

    post(store, binder, '@Stale Key Mock three', ['mock']);
    await waitFor(() => sessions.spawns() === 3);
    const mock = sessions.lastCreateParams() as {
      providerId: string;
      extra?: Record<string, unknown>;
    };
    expect(mock.providerId).toBe('mock');
    expect(mock.extra?.['hermesApiKey']).toBeUndefined();
  });

  it('keeps same-provider profiles isolated: bindings, sessions, replies, roster, and status all use profile actor ids', async () => {
    const profiles = createAgentProfileStore(':memory:');
    cleanup.push(() => profiles.close());
    profiles.seedBuiltIns([{ id: 'mock' }]);
    const backend = profiles.create({
      id: 'agent-profile:mock:backend',
      providerId: 'mock',
      displayName: 'Backend',
      model: 'mock-model',
      provider: 'mock-provider',
      effort: 'high',
      envVars: { PROFILE_TEST_FLAG: '1' },
      systemPrompt: 'Review the backend boundary.',
    });
    const reviewer = profiles.create({
      id: 'agent-profile:mock:reviewer',
      providerId: 'mock',
      displayName: 'Reviewer',
    });
    const { binder, store, sessions } = makeBinder({
      build: () => new MockProtocolAdapterV2({ connectMs: 1, stepMs: 1 }),
      targets: MOCK_TARGETS,
      knownProviderIds: ['mock'],
      agentProfileStore: profiles,
    });
    const statusAgentIds = new Set<string>();
    binder.setStatusBroadcaster((_type, data) => {
      if (typeof data['agentId'] === 'string')
        statusAgentIds.add(data['agentId']);
    });

    post(store, binder, '@Backend one', ['mock']);
    await waitFor(() => sessions.spawns() === 1);
    expect(sessions.lastCreateParams()).toMatchObject({
      providerId: 'mock',
      profileActorId: backend.id,
      model: 'mock-model',
      processEnv: { PROFILE_TEST_FLAG: '1' },
      systemPrompt: 'Review the backend boundary.',
      extra: { provider: 'mock-provider', effort: 'high' },
    });
    post(store, binder, '@Reviewer two', ['mock']);
    await waitFor(() => sessions.spawns() === 2);
    expect(store.getBinding(CH, backend.id)?.runtimeId).toBeTruthy();
    expect(store.getBinding(CH, reviewer.id)?.runtimeId).toBeTruthy();

    // A second mention of Backend reuses only Backend's pinned profile runtime.
    post(store, binder, '@Backend again', ['mock']);
    await waitFor(() => agentReplies(store, 'mock').length === 3);
    expect(sessions.spawns()).toBe(2);
    expect(agentReplies(store, 'mock').map((reply) => reply.sender.id)).toEqual(
      expect.arrayContaining([backend.id, reviewer.id])
    );
    const roster = await binder.rosterForChannel(CH);
    expect(roster.map((entry) => entry.id)).toEqual(
      expect.arrayContaining([backend.id, reviewer.id])
    );
    expect(statusAgentIds.has(backend.id)).toBe(true);
    expect(statusAgentIds.has(reviewer.id)).toBe(true);
  });

  it('keeps the default-only provider path on one reusable built-in profile identity', async () => {
    const { binder, store, sessions } = makeBinder({
      build: () => new MockProtocolAdapterV2({ connectMs: 1, stepMs: 1 }),
      targets: MOCK_TARGETS,
      knownProviderIds: ['mock'],
    });
    const defaultId = builtInAgentProfileId('mock');
    const statusIds = new Set<string>();
    binder.setStatusBroadcaster((_type, data) => {
      if (typeof data['agentId'] === 'string') statusIds.add(data['agentId']);
    });
    post(store, binder, '@mock first', ['mock']);
    post(store, binder, '@mock second', ['mock']);
    await waitFor(() => agentReplies(store, 'mock').length === 2);
    expect(sessions.spawns()).toBe(1);
    expect(store.getBinding(CH, defaultId)?.runtimeId).toBeTruthy();
    expect(
      agentReplies(store, 'mock').every((row) => row.sender.id === defaultId)
    ).toBe(true);
    expect(
      (await binder.rosterForChannel(CH)).find((row) => row.id === defaultId)
        ?.binding
    ).not.toBeNull();
    expect(statusIds.has(defaultId)).toBe(true);
  });

  it('routes a named profile mention from the assistant-finalized contacts parser path', async () => {
    const profiles = createAgentProfileStore(':memory:');
    cleanup.push(() => profiles.close());
    profiles.seedBuiltIns([{ id: 'mock' }]);
    profiles.create({
      id: 'agent-profile:mock:backend-finalizer',
      providerId: 'mock',
      displayName: 'Backend',
    });
    const reviewer = profiles.create({
      id: 'agent-profile:mock:reviewer-finalizer',
      providerId: 'mock',
      displayName: 'Reviewer',
    });
    const { binder, store, sessions } = makeBinder({
      build: (agentType) =>
        new ScriptedAdapter(agentType, {
          mode: 'reply',
          text: '@Reviewer take this.',
        }),
      targets: MOCK_TARGETS,
      knownProviderIds: ['mock'],
      agentProfileStore: profiles,
    });

    post(store, binder, '@Backend begin', ['mock']);
    await waitFor(() => sessions.spawns() === 2);
    expect(store.getBinding(CH, reviewer.id)?.runtimeId).toBeTruthy();
  });

  it('keeps a persisted profile mention pinned across a rename/collision reparse', async () => {
    const profiles = createAgentProfileStore(':memory:');
    cleanup.push(() => profiles.close());
    profiles.seedBuiltIns([{ id: 'mock' }]);
    const pinned = profiles.create({
      id: 'agent-profile:mock:renamed',
      providerId: 'mock',
      displayName: 'Backend',
    });
    profiles.create({
      id: 'agent-profile:mock:current-reviewer',
      providerId: 'mock',
      displayName: 'Reviewer',
    });
    const { binder, store, sessions } = makeBinder({
      build: () => new MockProtocolAdapterV2({ connectMs: 1, stepMs: 1 }),
      targets: MOCK_TARGETS,
      knownProviderIds: ['mock'],
      agentProfileStore: profiles,
    });
    const message = store.appendComplete({
      channelId: CH,
      sender: OPERATOR,
      text: '@Reviewer please inspect',
      mentions: [
        { raw: '@Reviewer', providerId: 'mock', profileId: pinned.id },
      ],
    });
    binder.handleMessagePosted(message, message.mentions ?? []);
    await waitFor(() => sessions.spawns() === 1);
    expect(store.getBinding(CH, pinned.id)?.runtimeId).toBeTruthy();
    expect(
      store.getBinding(CH, 'agent-profile:mock:current-reviewer')
    ).toBeNull();
  });

  it('resolveMentions is the one resolver: its output persisted as-is admits and routes the same profiles (#1503)', async () => {
    const profiles = createAgentProfileStore(':memory:');
    cleanup.push(() => profiles.close());
    profiles.seedBuiltIns([{ id: 'mock' }]);
    const tako = profiles.create({
      id: 'agent-profile:mock:tako',
      providerId: 'mock',
      displayName: 'Tako Planner',
    });
    const { binder, store, sessions } = makeBinder({
      build: () => new MockProtocolAdapterV2({ connectMs: 1, stepMs: 1 }),
      targets: MOCK_TARGETS,
      knownProviderIds: ['mock'],
      agentProfileStore: profiles,
    });
    const text = '@Tako Planner and @mock and @nobody go';
    const resolved = binder.resolveMentions(text);
    expect(resolved).toEqual([
      { raw: '@Tako Planner', providerId: 'mock', profileId: tako.id },
      {
        raw: '@mock',
        providerId: 'mock',
        profileId: builtInAgentProfileId('mock'),
      },
      { raw: '@nobody' },
    ]);
    expect(
      binder.resolvePostTargetIds({
        channelId: CH,
        sender: OPERATOR,
        text,
        mentions: resolved,
      })
    ).toEqual([tako.id, builtInAgentProfileId('mock')]);
    const message = store.appendComplete({
      channelId: CH,
      sender: OPERATOR,
      text,
      mentions: resolved,
    });
    binder.handleMessagePosted(message, message.mentions ?? []);
    await waitFor(() => sessions.spawns() === 2);
    expect(store.getBinding(CH, tako.id)?.runtimeId).toBeTruthy();
    expect(
      store.getBinding(CH, builtInAgentProfileId('mock'))?.runtimeId
    ).toBeTruthy();
  });

  it('resolveMentions without a profile catalog keeps the vendor-only tokenizer shape', () => {
    const { binder } = makeBinder({
      build: () => new MockProtocolAdapterV2({ connectMs: 1, stepMs: 1 }),
      targets: MOCK_TARGETS,
      knownProviderIds: ['mock'],
    });
    expect(binder.resolveMentions('@mock hi @Tako Planner')).toEqual([
      { raw: '@mock', providerId: 'mock' },
      { raw: '@Tako' },
    ]);
  });

  it('resolveMentions with a present but unseeded catalog degrades to the vendor-only shape (contacts === [])', () => {
    const empty = createAgentProfileStore(':memory:');
    cleanup.push(() => empty.close());
    const { binder } = makeBinder({
      build: () => new MockProtocolAdapterV2({ connectMs: 1, stepMs: 1 }),
      targets: MOCK_TARGETS,
      knownProviderIds: ['mock'],
      agentProfileStore: empty,
    });
    expect(binder.resolveMentions('@mock hi @Tako Planner')).toEqual([
      { raw: '@mock', providerId: 'mock' },
      { raw: '@Tako' },
    ]);
  });

  it('designates an orchestrator without submitting a turn', async () => {
    const { binder, store, sessions } = makeBinder({
      build: () => new MockProtocolAdapterV2({ connectMs: 1, stepMs: 1 }),
      targets: MOCK_TARGETS,
      knownProviderIds: ['mock'],
    });

    const binding = await binder.ensureOrchestrator(CH, 'mock');

    expect(binding.runtimeId).toBe(sessions.firstSessionId());
    expect(store.getBinding(CH, builtInAgentProfileId('mock'))?.role).toBe(
      'orchestrator'
    );
    expect(sessions.lastCreateParams()).toMatchObject({
      providerId: 'mock',
      role: 'orchestrator',
    });
    expect(agentReplies(store)).toHaveLength(0);
  });

  it('serializes competing orchestrator profiles before spawning a loser', async () => {
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const targets: MentionTarget[] = [
      ...MOCK_TARGETS,
      {
        id: 'codex',
        displayName: 'Codex',
        kind: 'framework',
        available: true,
        reason: null,
      },
    ];
    const { binder, store, sessions } = makeBinder({
      build: () => new MockProtocolAdapterV2({ connectMs: 1, stepMs: 1 }),
      targets,
      knownProviderIds: ['mock', 'codex'],
      gate,
    });

    const first = binder.ensureOrchestrator(CH, 'mock');
    const competitor = binder.ensureOrchestrator(CH, 'codex');
    await waitFor(() => sessions.spawns() === 1);
    expect(sessions.createParams()).toHaveLength(1);
    releaseGate();
    const [firstResult, competitorResult] = await Promise.allSettled([
      first,
      competitor,
    ]);

    expect(firstResult.status).toBe('fulfilled');
    expect(competitorResult).toMatchObject({
      status: 'rejected',
      reason: expect.objectContaining({
        status: 409,
        code: 'channel_orchestrator_conflict',
        details: expect.objectContaining({
          designatedProfileActorId: builtInAgentProfileId('mock'),
          requestedProfileActorId: builtInAgentProfileId('codex'),
        }),
      }),
    });
    expect(sessions.spawns()).toBe(1);
    expect(store.getSoleOrchestratorBinding(CH)?.profileActorId).toBe(
      builtInAgentProfileId('mock')
    );
    expect(store.getBinding(CH, builtInAgentProfileId('codex'))).toBeNull();
  });

  it('coalesces simultaneous idempotent designation requests to one runtime', async () => {
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const { binder, store, sessions } = makeBinder({
      build: () => new MockProtocolAdapterV2({ connectMs: 1, stepMs: 1 }),
      targets: MOCK_TARGETS,
      knownProviderIds: ['mock'],
      gate,
    });
    const first = binder.ensureOrchestrator(CH, 'mock');
    const repeated = binder.ensureOrchestrator(CH, 'mock');
    await waitFor(() => sessions.spawns() === 1);
    releaseGate();
    const [a, b] = await Promise.all([first, repeated]);
    expect(a.runtimeId).toBe(b.runtimeId);
    expect(sessions.spawns()).toBe(1);
    expect(store.getSoleOrchestratorBinding(CH)?.profileActorId).toBe(
      builtInAgentProfileId('mock')
    );
  });

  it('reuses a restored orchestrator binding', async () => {
    const { binder, store, sessions } = makeBinder({
      build: () => new MockProtocolAdapterV2({ connectMs: 1, stepMs: 1 }),
      targets: MOCK_TARGETS,
      knownProviderIds: ['mock'],
    });
    const sessionId = 'session:restored-driver';
    await sessions.registerRestoredRuntime(sessionId, 'mock', 'orchestrator');
    store.upsertBinding({
      channelId: CH,
      profileActorId: builtInAgentProfileId('mock'),
      agentFramework: 'mock',
      runtimeId: sessionId,
    });

    const binding = await binder.ensureOrchestrator(CH, 'mock');

    expect(binding.runtimeId).toBe(sessionId);
    expect(store.getBinding(CH, builtInAgentProfileId('mock'))?.role).toBe(
      'orchestrator'
    );
    expect(sessions.spawns()).toBe(0);
  });

  it('reuses an explicitly selected profile-pinned restored orchestrator', async () => {
    const profiles = createAgentProfileStore(':memory:');
    cleanup.push(() => profiles.close());
    profiles.seedBuiltIns([{ id: 'mock' }]);
    const reviewer = profiles.create({
      id: 'reviewer',
      providerId: 'mock',
      displayName: 'Reviewer',
    });
    const { binder, store, sessions } = makeBinder({
      build: () => new MockProtocolAdapterV2({ connectMs: 1, stepMs: 1 }),
      targets: MOCK_TARGETS,
      knownProviderIds: ['mock'],
      agentProfileStore: profiles,
    });
    const sessionId = 'session:restored-profile';
    await sessions.registerRestoredRuntime(
      sessionId,
      'mock',
      'orchestrator',
      reviewer.id
    );
    store.upsertBinding({
      channelId: CH,
      profileActorId: reviewer.id,
      agentFramework: 'mock',
      runtimeId: sessionId,
    });

    expect(
      (await binder.ensureOrchestrator(CH, 'mock', reviewer.id)).runtimeId
    ).toBe(sessionId);
    expect(sessions.spawns()).toBe(0);
    // Exact custom actor ids are accepted by the control lookup; a legacy
    // prefix rewrite would miss this live binding as "not found".
    await expect(binder.interrupt(CH, reviewer.id)).rejects.toThrow(
      /no active turn/
    );
  });

  it('does not reuse an unpinned legacy session for a custom profile', async () => {
    const profiles = createAgentProfileStore(':memory:');
    cleanup.push(() => profiles.close());
    profiles.seedBuiltIns([{ id: 'mock' }]);
    const reviewer = profiles.create({
      id: 'reviewer',
      providerId: 'mock',
      displayName: 'Reviewer',
    });
    const { binder, store, sessions } = makeBinder({
      build: () => new MockProtocolAdapterV2({ connectMs: 1, stepMs: 1 }),
      targets: MOCK_TARGETS,
      knownProviderIds: ['mock'],
      agentProfileStore: profiles,
    });
    await sessions.registerRestoredRuntime(
      'session:legacy',
      'mock',
      'orchestrator'
    );
    store.upsertBinding({
      channelId: CH,
      profileActorId: reviewer.id,
      agentFramework: 'mock',
      runtimeId: 'session:legacy',
    });

    expect(
      (await binder.ensureOrchestrator(CH, 'mock', reviewer.id)).runtimeId
    ).not.toBe('session:legacy');
    expect(sessions.spawns()).toBe(1);
  });

  it('does not reuse a different custom profile restored session for the same provider', async () => {
    const profiles = createAgentProfileStore(':memory:');
    cleanup.push(() => profiles.close());
    profiles.seedBuiltIns([{ id: 'mock' }]);
    const profileA = profiles.create({
      id: 'profile-a',
      providerId: 'mock',
      displayName: 'Reviewer A',
    });
    const profileB = profiles.create({
      id: 'profile-b',
      providerId: 'mock',
      displayName: 'Reviewer B',
    });
    const { binder, store, sessions } = makeBinder({
      build: () => new MockProtocolAdapterV2({ connectMs: 1, stepMs: 1 }),
      targets: MOCK_TARGETS,
      knownProviderIds: ['mock'],
      agentProfileStore: profiles,
    });
    await sessions.registerRestoredRuntime(
      'session:profile-a',
      'mock',
      'orchestrator',
      profileA.id
    );
    store.upsertBinding({
      channelId: CH,
      profileActorId: profileB.id,
      agentFramework: 'mock',
      runtimeId: 'session:profile-a',
    });

    const binding = await binder.ensureOrchestrator(CH, 'mock', profileB.id);
    expect(binding.runtimeId).not.toBe('session:profile-a');
    expect(sessions.spawns()).toBe(1);
    expect(sessions.lastCreateParams()).toMatchObject({
      profileActorId: profileB.id,
    });
    expect(store.getBinding(CH, profileB.id)).toMatchObject({
      profileActorId: profileB.id,
      runtimeId: binding.runtimeId,
    });
  });

  it('rejects a restored healthy non-orchestrator binding', async () => {
    const { binder, store, sessions } = makeBinder({
      build: () => new MockProtocolAdapterV2({ connectMs: 1, stepMs: 1 }),
      targets: MOCK_TARGETS,
      knownProviderIds: ['mock'],
    });
    const sessionId = 'session:restored-worker';
    await sessions.registerRestoredRuntime(sessionId, 'mock', 'implementer');
    store.upsertBinding({
      channelId: CH,
      profileActorId: builtInAgentProfileId('mock'),
      agentFramework: 'mock',
      runtimeId: sessionId,
    });

    await expect(binder.ensureOrchestrator(CH, 'mock')).rejects.toThrow(
      /already binds @mock.*role implementer/
    );
    expect(sessions.spawns()).toBe(0);
    expect(store.getBinding(CH, builtInAgentProfileId('mock'))?.runtimeId).toBe(
      sessionId
    );
  });

  it('first mention spawns exactly one session and streams the reply as agent:mock', async () => {
    const { binder, store, sessions } = makeBinder({
      build: () => new MockProtocolAdapterV2({ connectMs: 1, stepMs: 1 }),
      targets: MOCK_TARGETS,
      knownProviderIds: ['mock'],
    });
    post(store, binder, '@mock hello', ['mock']);
    await waitFor(() => agentReplies(store, 'mock').length === 1);
    expect(sessions.spawns()).toBe(1);
    const reply = agentReplies(store, 'mock')[0]!;
    expect(reply.sender.id).toBe('agent-profile:mock:default');
    expect(reply.body.text).toBe('Mock v2 response complete.');
    expect(reply.threadId).toBeNull();
    expect(reply.parentMessageId).toBeNull();
  });

  it('isolates one profile into concurrent thread runtimes and captures channel instructions at spawn', async () => {
    const topics = createWorkspaceTopicStore({ dbPath: ':memory:' });
    cleanup.push(() => topics.close());
    topics.create({
      id: CH,
      workspaceId: 'ws:test',
      title: 'threaded work',
      promptDefaults: {
        systemPrompt: 'You are working in a shared channel.',
        instructions: 'Keep each conversation self-contained.',
      },
    });
    const { binder, store, sessions } = makeBinder({
      build: () => new MockProtocolAdapterV2({ connectMs: 1, stepMs: 1 }),
      targets: MOCK_TARGETS,
      knownProviderIds: ['mock'],
      topicStore: topics,
    });
    const first = store.appendComplete({
      channelId: CH,
      sender: OPERATOR,
      text: 'first root',
    });
    const second = store.appendComplete({
      channelId: CH,
      sender: OPERATOR,
      text: 'second root',
    });

    post(store, binder, '@mock first thread', ['mock'], OPERATOR, first.id);
    post(store, binder, '@mock second thread', ['mock'], OPERATOR, second.id);
    await waitFor(() => agentReplies(store, 'mock').length === 2);

    expect(sessions.spawns()).toBe(2);
    expect(sessions.createParams()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          threadId: first.id,
          systemPrompt:
            'You are working in a shared channel.\n\nKeep each conversation self-contained.',
        }),
        expect.objectContaining({
          threadId: second.id,
          systemPrompt:
            'You are working in a shared channel.\n\nKeep each conversation self-contained.',
        }),
      ])
    );
    const profileId = builtInAgentProfileId('mock');
    const firstBinding = store.getBinding(CH, profileId, first.id);
    const secondBinding = store.getBinding(CH, profileId, second.id);
    expect(firstBinding?.runtimeId).toBeTruthy();
    expect(secondBinding?.runtimeId).toBeTruthy();
    expect(firstBinding?.runtimeId).not.toBe(secondBinding?.runtimeId);
    expect(agentReplies(store, 'mock').map((reply) => reply.threadId)).toEqual(
      expect.arrayContaining([first.id, second.id])
    );
  });

  it('keeps a live thread prompt stable until explicit apply, then restarts only that scope with the new prompt', async () => {
    const topics = createWorkspaceTopicStore({ dbPath: ':memory:' });
    cleanup.push(() => topics.close());
    topics.create({
      id: CH,
      workspaceId: 'ws:test',
      title: 'prompt apply',
      promptDefaults: { systemPrompt: 'old shared instructions' },
    });
    const { binder, store, sessions } = makeBinder({
      build: () => new MockProtocolAdapterV2({ connectMs: 1, stepMs: 1 }),
      targets: MOCK_TARGETS,
      knownProviderIds: ['mock'],
      topicStore: topics,
    });
    const first = store.appendComplete({
      channelId: CH,
      sender: OPERATOR,
      text: 'first root',
    });
    const second = store.appendComplete({
      channelId: CH,
      sender: OPERATOR,
      text: 'second root',
    });
    post(store, binder, '@mock first', ['mock'], OPERATOR, first.id);
    post(store, binder, '@mock second', ['mock'], OPERATOR, second.id);
    await waitFor(() => agentReplies(store, 'mock').length === 2);
    expect(sessions.createParams()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          threadId: first.id,
          systemPrompt: 'old shared instructions',
        }),
        expect.objectContaining({
          threadId: second.id,
          systemPrompt: 'old shared instructions',
        }),
      ])
    );

    topics.update(CH, {
      promptDefaults: { systemPrompt: 'new shared instructions' },
    });
    // Topic persistence alone never rewrites a live provider runtime.
    expect(sessions.spawns()).toBe(2);
    expect(sessions.createParams()[0]?.systemPrompt).toBe(
      'old shared instructions'
    );

    await expect(binder.restartScope(CH, first.id)).resolves.toEqual({
      restarted: 1,
    });
    expect(sessions.spawns()).toBe(3);
    expect(sessions.createParams()[2]).toMatchObject({
      threadId: first.id,
      systemPrompt: 'new shared instructions',
    });
    expect(
      store.getBinding(CH, builtInAgentProfileId('mock'), second.id)?.runtimeId
    ).toBeTruthy();
    expect(sessions.destroyCalls()).toHaveLength(1);
  });

  it('refuses prompt apply while the selected thread has a live turn', async () => {
    const topics = createWorkspaceTopicStore({ dbPath: ':memory:' });
    cleanup.push(() => topics.close());
    topics.create({
      id: CH,
      workspaceId: 'ws:test',
      title: 'busy prompt apply',
      promptDefaults: { systemPrompt: 'old instructions' },
    });
    const { binder, store, sessions } = makeBinder({
      build: () => new MockProtocolAdapterV2({ connectMs: 1, stepMs: 80 }),
      targets: MOCK_TARGETS,
      knownProviderIds: ['mock'],
      topicStore: topics,
    });
    const root = store.appendComplete({
      channelId: CH,
      sender: OPERATOR,
      text: 'busy root',
    });
    post(store, binder, '@mock work', ['mock'], OPERATOR, root.id);
    await waitFor(() =>
      rows(store).some(
        (message) =>
          message.threadId === root.id &&
          message.sender.providerId === 'mock' &&
          message.status === 'streaming'
      )
    );
    topics.update(CH, {
      promptDefaults: { systemPrompt: 'new instructions' },
    });

    await expect(binder.restartScope(CH, root.id)).rejects.toMatchObject({
      reasonCode: 'CHANNEL_AGENT_NOT_IDLE',
    });
    expect(sessions.spawns()).toBe(1);
    expect(sessions.destroyCalls()).toEqual([]);
    expect(sessions.createParams()[0]).toMatchObject({
      threadId: root.id,
      systemPrompt: 'old instructions',
    });
  });

  it.each([
    ['the routed turn id', false],
    ['the unambiguous Hermes turn-0 fallback', true],
  ])(
    'retains the exact thread parent for a late-opening row using %s',
    async (_label, fallbackTurnId) => {
      const { binder, store } = makeBinder({
        build: (agentType) =>
          new LateOpeningReplyAdapter(agentType, fallbackTurnId),
        targets: MOCK_TARGETS,
        knownProviderIds: ['mock'],
      });
      const root = store.appendComplete({
        channelId: CH,
        sender: OPERATOR,
        text: 'root',
      });
      const { message: trigger, run } = postWithAsyncRun(
        store,
        binder,
        '@mock threaded',
        ['mock'],
        OPERATOR,
        root.id
      );
      await waitFor(() => agentReplies(store, 'mock').length === 1);
      const reply = agentReplies(store, 'mock')[0]!;
      expect(trigger.threadId).toBe(root.id);
      expect(reply.threadId).toBe(root.id);
      expect(reply.parentMessageId).toBe(trigger.id);
      expect(reply.asyncRun).toEqual({
        runId: run.id,
        targetId: builtInAgentProfileId('mock'),
      });
    }
  );

  it('releases each Hermes fallback association before the next threaded turn', async () => {
    const { binder, store } = makeBinder({
      build: (agentType) => new LateOpeningReplyAdapter(agentType, true),
      targets: MOCK_TARGETS,
      knownProviderIds: ['mock'],
    });
    const rootOne = store.appendComplete({
      channelId: CH,
      sender: OPERATOR,
      text: 'root one',
    });
    const rootTwo = store.appendComplete({
      channelId: CH,
      sender: OPERATOR,
      text: 'root two',
    });
    const triggerOne = post(
      store,
      binder,
      '@mock one',
      ['mock'],
      OPERATOR,
      rootOne.id
    );
    await waitFor(() => agentReplies(store, 'mock').length === 1);
    const triggerTwo = post(
      store,
      binder,
      '@mock two',
      ['mock'],
      OPERATOR,
      rootTwo.id
    );
    await waitFor(() => agentReplies(store, 'mock').length === 2);
    const replies = agentReplies(store, 'mock');
    expect(replies[0]).toMatchObject({
      threadId: rootOne.id,
      parentMessageId: triggerOne.id,
    });
    expect(replies[1]).toMatchObject({
      threadId: rootTwo.id,
      parentMessageId: triggerTwo.id,
    });
  });

  it('fails closed to the known conversation root when a turn-0 fallback is ambiguous', async () => {
    const { binder, store } = makeBinder({
      build: (agentType) => new LateOpeningReplyAdapter(agentType, true),
      targets: MOCK_TARGETS,
      knownProviderIds: ['mock'],
    });
    const rootOne = store.appendComplete({
      channelId: CH,
      sender: OPERATOR,
      text: 'root one',
    });
    postWithAsyncRun(
      store,
      binder,
      '@mock one',
      ['mock'],
      OPERATOR,
      rootOne.id
    );
    postWithAsyncRun(
      store,
      binder,
      '@mock two',
      ['mock'],
      OPERATOR,
      rootOne.id
    );
    await waitFor(() => agentReplies(store, 'mock').length === 2);
    for (const reply of agentReplies(store, 'mock')) {
      expect(reply.threadId).toBe(rootOne.id);
      // The two provider fallback rows cannot safely borrow either trigger,
      // but the runtime itself is scoped to this durable conversation.
      expect(reply.parentMessageId).toBe(rootOne.id);
      expect(reply.asyncRun).toBeUndefined();
    }
  });

  it('retains a bounded exact-turn tombstone across a bare-idle successor', async () => {
    const { binder, store, sessions } = makeBinder({
      build: (agentType) => new ManualBareIdleAdapter(agentType),
      targets: MOCK_TARGETS,
      knownProviderIds: ['mock'],
    });
    const root = store.appendComplete({
      channelId: CH,
      sender: OPERATOR,
      text: 'root',
    });
    const first = postWithAsyncRun(
      store,
      binder,
      '@mock A',
      ['mock'],
      OPERATOR,
      root.id
    );
    postWithAsyncRun(store, binder, '@mock B', ['mock'], OPERATOR, root.id);
    await waitFor(() => sessions.spawns() === 1);
    const adapter = sessions.adapterFor(
      sessions.firstSessionId()
    ) as ManualBareIdleAdapter;
    await waitFor(() => adapter.sendCalls.length === 2);

    // A bare idle terminalized A, then B started and displaced A from the live
    // fallback slot. A late row with A's exact provider id must still carry A's
    // public run reference; an anonymous turn-0 never gets this tombstone.
    adapter.emitLate(adapter.sendCalls[0]!, 'late exact A');
    await waitFor(() => agentReplies(store, 'mock').length === 1);
    expect(agentReplies(store, 'mock')[0]).toMatchObject({
      parentMessageId: first.message.id,
      asyncRun: {
        runId: first.run.id,
        targetId: builtInAgentProfileId('mock'),
      },
    });
  });

  it('expires an exact-turn tombstone without granting it to anonymous fallback', async () => {
    let clock = 0;
    const { binder, store, sessions } = makeBinder({
      build: (agentType) => new ManualBareIdleAdapter(agentType),
      targets: MOCK_TARGETS,
      knownProviderIds: ['mock'],
      now: () => clock,
    });
    const root = store.appendComplete({
      channelId: CH,
      sender: OPERATOR,
      text: 'root',
    });
    postWithAsyncRun(store, binder, '@mock A', ['mock'], OPERATOR, root.id);
    postWithAsyncRun(store, binder, '@mock B', ['mock'], OPERATOR, root.id);
    await waitFor(() => sessions.spawns() === 1);
    const adapter = sessions.adapterFor(
      sessions.firstSessionId()
    ) as ManualBareIdleAdapter;
    await waitFor(() => adapter.sendCalls.length === 2);
    clock = 60 * 1000 + 1;

    adapter.emitLate(adapter.sendCalls[0]!, 'expired exact A');
    await waitFor(() => agentReplies(store, 'mock').length === 1);
    expect(agentReplies(store, 'mock')[0]).toMatchObject({
      parentMessageId: root.id,
    });
    expect(agentReplies(store, 'mock')[0]?.asyncRun).toBeUndefined();
    const binding = await binder.ensureBinding(CH, 'mock');
    expect(binding.exactTurnTombstones.has(adapter.sendCalls[0]!)).toBe(false);
  });

  it('bounds retained parents across many bare-idle turns', async () => {
    const { binder, store, sessions } = makeBinder({
      build: (agentType) => new ManualBareIdleAdapter(agentType),
      targets: MOCK_TARGETS,
      knownProviderIds: ['mock'],
    });
    for (let i = 0; i < 20; i++) {
      post(store, binder, `@mock idle ${i}`, ['mock']);
    }
    await waitFor(() => {
      if (sessions.spawns() !== 1) return false;
      return (
        (
          sessions.adapterFor(
            sessions.firstSessionId()
          ) as ManualBareIdleAdapter
        ).sendCalls.length === 20
      );
    });
    const binding = await binder.ensureBinding(CH, 'mock');
    expect(binding.activeTurnId).toBeNull();
    expect(binding.parentMessageIdByTurn.size).toBeLessThanOrEqual(1);
    expect(binding.exactTurnTombstones.size).toBeLessThanOrEqual(16);
  });

  it('prunes predecessors so an exact late successor recovers from fallback poisoning', async () => {
    const { binder, store, sessions } = makeBinder({
      build: (agentType) => new ManualBareIdleAdapter(agentType),
      targets: MOCK_TARGETS,
      knownProviderIds: ['mock'],
    });
    const rootOne = store.appendComplete({
      channelId: CH,
      sender: OPERATOR,
      text: 'root one',
    });
    post(store, binder, '@mock one', ['mock'], OPERATOR, rootOne.id);
    const triggerTwo = post(
      store,
      binder,
      '@mock two',
      ['mock'],
      OPERATOR,
      rootOne.id
    );
    await waitFor(() => sessions.spawns() === 1);
    const adapter = sessions.adapterFor(
      sessions.firstSessionId()
    ) as ManualBareIdleAdapter;
    await waitFor(() => adapter.sendCalls.length === 2);
    adapter.emitLate(adapter.sendCalls[1]!);
    await waitFor(() => agentReplies(store, 'mock').length === 1);
    expect(agentReplies(store, 'mock')[0]).toMatchObject({
      threadId: rootOne.id,
      parentMessageId: triggerTwo.id,
    });
    // Exact terminal evidence identifies and releases B, clearing the overlap
    // ambiguity. A later isolated C may safely use a genuine turn-0 fallback.
    adapter.emitCompleted(adapter.sendCalls[1]!);
    const triggerThree = post(
      store,
      binder,
      '@mock three',
      ['mock'],
      OPERATOR,
      rootOne.id
    );
    await waitFor(() => adapter.sendCalls.length === 3);
    adapter.emitLate('turn-0', 'valid fallback');
    await waitFor(() => agentReplies(store, 'mock').length === 2);
    expect(agentReplies(store, 'mock')[1]).toMatchObject({
      threadId: rootOne.id,
      parentMessageId: triggerThree.id,
    });
  });

  it('never resurrects a stale turn-0 against a newer retained successor', async () => {
    const { binder, store, sessions } = makeBinder({
      build: (agentType) => new ManualBareIdleAdapter(agentType),
      targets: MOCK_TARGETS,
      knownProviderIds: ['mock'],
    });
    const rootOne = store.appendComplete({
      channelId: CH,
      sender: OPERATOR,
      text: 'root one',
    });
    post(store, binder, '@mock one', ['mock'], OPERATOR, rootOne.id);
    post(store, binder, '@mock two', ['mock'], OPERATOR, rootOne.id);
    await waitFor(() => sessions.spawns() === 1);
    const adapter = sessions.adapterFor(
      sessions.firstSessionId()
    ) as ManualBareIdleAdapter;
    await waitFor(() => adapter.sendCalls.length === 2);
    // Both turns have bare-idled; this anonymous row may belong to the older
    // generation and therefore must not borrow the newer turn's parent.
    adapter.emitLate('turn-0', 'stale reply');
    await waitFor(() => agentReplies(store, 'mock').length === 1);
    expect(agentReplies(store, 'mock')[0]).toMatchObject({
      threadId: rootOne.id,
      parentMessageId: rootOne.id,
    });
  });

  it('does not let a legacy error pair finish a freshly pumped successor', async () => {
    const { binder, store, sessions } = makeBinder({
      build: (agentType) => new ManualBareIdleAdapter(agentType, false),
      targets: MOCK_TARGETS,
      knownProviderIds: ['mock'],
    });
    post(store, binder, '@mock first', ['mock']);
    post(store, binder, '@mock successor', ['mock']);
    await waitFor(() => sessions.spawns() === 1);
    const adapter = sessions.adapterFor(
      sessions.firstSessionId()
    ) as ManualBareIdleAdapter;
    await waitFor(() => adapter.sendCalls.length === 1);
    // Patch 1 of the pair pumps U; model U synchronously bare-idling before
    // patch 2 (turn-0 completed) is dispatched.
    adapter.idleNextSend();
    adapter.emitLegacyErrorPair('legacy failure');
    await waitFor(() => adapter.sendCalls.length === 2);
    const binding = await binder.ensureBinding(CH, 'mock');
    expect(binding.activeTurnId).toBeNull();
    expect(binding.parentMessageIdByTurn.has(adapter.sendCalls[1]!)).toBe(true);
    adapter.emitLate(adapter.sendCalls[1]!, 'successor late reply');
    await waitFor(() => agentReplies(store, 'mock').length === 1);
    expect(agentReplies(store, 'mock')[0]).toMatchObject({
      threadId: null,
      parentMessageId: null,
    });
    adapter.emitCompleted(adapter.sendCalls[1]!);
    expect(binding.parentMessageIdByTurn.size).toBe(0);
  });

  it('surfaces an agent error received while the binding is idle', async () => {
    const profiles = createAgentProfileStore(':memory:');
    cleanup.push(() => profiles.close());
    profiles.seedBuiltIns([{ id: 'mock' }]);
    profiles.create({
      id: 'agent-profile:mock:backend-error',
      providerId: 'mock',
      displayName: 'Backend',
    });
    const { binder, store, sessions } = makeBinder({
      build: (agentType) => new ManualBareIdleAdapter(agentType),
      targets: MOCK_TARGETS,
      knownProviderIds: ['mock'],
      agentProfileStore: profiles,
    });
    post(store, binder, '@Backend idle', ['mock']);
    await waitFor(() => sessions.spawns() === 1);
    expect(sessions.lastCreateParams()?.displayName).toBe(`#${CH} · Backend`);
    const adapter = sessions.adapterFor(
      sessions.firstSessionId()
    ) as ManualBareIdleAdapter;
    await waitFor(() => adapter.sendCalls.length === 1);
    adapter.emitError('idle failure');
    await waitFor(() =>
      systemRows(store).some(
        (row) => row.body.text === '@Backend errored: idle failure'
      )
    );
  });

  it('two concurrent mentions single-flight to exactly one spawn', async () => {
    const { binder, sessions } = makeBinder({
      build: () => new MockProtocolAdapterV2({ connectMs: 5, stepMs: 1 }),
      targets: MOCK_TARGETS,
      knownProviderIds: ['mock'],
    });
    const [b1, b2] = await Promise.all([
      binder.ensureBinding(CH, 'mock'),
      binder.ensureBinding(CH, 'mock'),
    ]);
    expect(sessions.spawns()).toBe(1);
    expect(b1).toBe(b2);
  });

  it('a second sequential mention reuses the live session (no respawn)', async () => {
    const { binder, store, sessions } = makeBinder({
      build: () => new MockProtocolAdapterV2({ connectMs: 1, stepMs: 1 }),
      targets: MOCK_TARGETS,
      knownProviderIds: ['mock'],
    });
    post(store, binder, '@mock one', ['mock']);
    await waitFor(() => agentReplies(store, 'mock').length === 1);
    post(store, binder, '@mock two', ['mock']);
    await waitFor(() => agentReplies(store, 'mock').length === 2);
    expect(sessions.spawns()).toBe(1);
  });

  it('a mention while streaming queues and drains after the active turn', async () => {
    const { binder, store, sessions } = makeBinder({
      build: () => new MockProtocolAdapterV2({ connectMs: 1, stepMs: 30 }),
      targets: MOCK_TARGETS,
      knownProviderIds: ['mock'],
    });
    post(store, binder, '@mock a', ['mock']);
    post(store, binder, '@mock b', ['mock']);
    await waitFor(() => agentReplies(store, 'mock').length === 2, 6000);
    expect(sessions.spawns()).toBe(1);
  });

  // #1308 slice 4 changed what the cap means for the operator's own lane: a
  // contiguous human run drains as ONE turn, so an overflowing post supersedes
  // the queue tail (identical trigger + packet) instead of being announced as
  // dropped for a turn that was never going to exist. The drop row is still the
  // honest answer whenever superseding would NOT be equivalent.
  it('supersedes rather than drops when an over-cap post coalesces with the tail', async () => {
    const { binder, store } = makeBinder({
      build: () => new ScriptedAdapter('stall', { mode: 'stall' }),
      targets: [
        {
          id: 'stall',
          displayName: 'Stall',
          kind: 'framework',
          available: true,
          reason: null,
        },
      ],
      knownProviderIds: ['stall'],
    });
    const root = store.appendComplete({
      channelId: CH,
      sender: OPERATOR,
      text: 'root',
    });
    for (let i = 0; i < 12; i++) {
      post(store, binder, `@stall ${i}`, ['stall'], OPERATOR, root.id);
    }
    await new Promise((r) => setTimeout(r, 120));
    expect(
      systemRows(store).filter((m) => m.body.text.includes('message dropped'))
    ).toHaveLength(0);
  });

  it('keeps queue caps isolated between conversations', async () => {
    const { binder, store } = makeBinder({
      build: () => new ScriptedAdapter('stall', { mode: 'stall' }),
      targets: [
        {
          id: 'stall',
          displayName: 'Stall',
          kind: 'framework',
          available: true,
          reason: null,
        },
      ],
      knownProviderIds: ['stall'],
    });
    const rootA = store.appendComplete({
      channelId: CH,
      sender: OPERATOR,
      text: 'root a',
    });
    const rootB = store.appendComplete({
      channelId: CH,
      sender: OPERATOR,
      text: 'root b',
    });
    // One live turn plus a full cap of thread-A posts.
    for (let i = 0; i < 9; i++) {
      post(store, binder, `@stall a${i}`, ['stall'], OPERATOR, rootA.id);
    }
    await new Promise((r) => setTimeout(r, 120));
    // Thread B owns an independent runtime/queue, so thread A's cap cannot
    // drop its post.
    const independent = post(
      store,
      binder,
      '@stall b0',
      ['stall'],
      OPERATOR,
      rootB.id
    );
    await waitFor(
      () =>
        store.getBinding(CH, builtInAgentProfileId('stall'), rootB.id)
          ?.runtimeId != null
    );
    expect(
      systemRows(store).filter((m) => m.body.text.includes('message dropped'))
    ).toHaveLength(0);
    expect(independent.threadId).toBe(rootB.id);
  });

  it('runtime death unbinds, clears the binding, and respawns on next mention', async () => {
    const { binder, store, sessions } = makeBinder({
      build: () => new MockProtocolAdapterV2({ connectMs: 1, stepMs: 1 }),
      targets: MOCK_TARGETS,
      knownProviderIds: ['mock'],
    });
    post(store, binder, '@mock one', ['mock']);
    await waitFor(() => agentReplies(store, 'mock').length === 1);
    const sid = sessions.firstSessionId();
    sessions.fireEnd(sid);
    expect(
      store.getBinding(CH, builtInAgentProfileId('mock'))?.runtimeId
    ).toBeNull();
    post(store, binder, '@mock two', ['mock']);
    await waitFor(() => agentReplies(store, 'mock').length === 2);
    expect(sessions.spawns()).toBe(2);
  });

  it('threads runtime-ended rows for queued trigger messages', async () => {
    const { binder, store, sessions } = makeBinder({
      build: (agentType) => new DeferredAdapter(agentType),
      targets: MOCK_TARGETS,
      knownProviderIds: ['mock'],
    });
    const root = store.appendComplete({
      channelId: CH,
      sender: OPERATOR,
      text: 'root',
    });
    post(store, binder, '@mock active', ['mock'], OPERATOR, root.id);
    const queued = post(
      store,
      binder,
      '@mock queued',
      ['mock'],
      OPERATOR,
      root.id
    );
    await waitFor(() => sessions.spawns() === 1);
    const adapter = sessions.adapterFor(
      sessions.firstSessionId()
    ) as DeferredAdapter;
    await waitFor(() => adapter.sendCalls.length === 1);
    sessions.fireEnd(sessions.firstSessionId());
    await waitFor(() =>
      systemRows(store).some((m) => m.body.text.includes('runtime ended'))
    );
    const ended = systemRows(store).find((m) =>
      m.body.text.includes('runtime ended')
    )!;
    expect(ended.threadId).toBe(root.id);
    expect(ended.parentMessageId).toBe(queued.id);
  });

  it('spawn failure posts a system row and leaves no stuck single-flight', async () => {
    const { binder, store, sessions } = makeBinder({
      build: () => new MockProtocolAdapterV2(),
      targets: MOCK_TARGETS,
      knownProviderIds: ['mock'],
      throwOnCreate: true,
    });
    const root = store.appendComplete({
      channelId: CH,
      sender: OPERATOR,
      text: 'root',
    });
    const first = post(store, binder, '@mock one', ['mock'], OPERATOR, root.id);
    await waitFor(() =>
      systemRows(store).some((m) => m.body.text.includes('failed to start'))
    );
    const second = post(
      store,
      binder,
      '@mock two',
      ['mock'],
      OPERATOR,
      root.id
    );
    await waitFor(() => sessions.spawns() === 2); // single-flight cleared, retried
    const failures = systemRows(store).filter((m) =>
      m.body.text.includes('failed to start')
    );
    expect(failures).toHaveLength(2);
    expect(failures.map((m) => m.parentMessageId)).toEqual([
      first.id,
      second.id,
    ]);
  });

  it('keeps a saved provider conversation intact across failed recovery attempts', async () => {
    const { binder, store, sessions } = makeBinder({
      build: () => new MockProtocolAdapterV2(),
      targets: MOCK_TARGETS,
      knownProviderIds: ['mock'],
      throwOnCreate: true,
    });
    const profileActorId = builtInAgentProfileId('mock');
    store.upsertBinding({
      channelId: CH,
      profileActorId,
      agentFramework: 'mock',
      runtimeId: 'stale-runtime',
      providerSession: { threadId: 'durable-provider-thread' },
    });

    await expect(binder.ensureBinding(CH, 'mock')).rejects.toThrow(
      'spawn failed'
    );
    await expect(binder.ensureBinding(CH, 'mock')).rejects.toThrow(
      'spawn failed'
    );

    expect(sessions.createParams()).toEqual([
      expect.objectContaining({
        providerSession: { threadId: 'durable-provider-thread' },
      }),
      expect.objectContaining({
        providerSession: { threadId: 'durable-provider-thread' },
      }),
    ]);
    expect(store.getBinding(CH, profileActorId)?.providerSession).toEqual({
      threadId: 'durable-provider-thread',
    });
  });

  it('marks a completed run as completed_unmet and posts one follow-up when delivery contract is unmet (#1569)', async () => {
    const profiles = createAgentProfileStore(':memory:');
    cleanup.push(() => profiles.close());
    profiles.seedBuiltIns([{ id: 'mock' }]);

    const { binder, store } = makeBinder({
      build: (agentType) =>
        new ScriptedAdapter(agentType, { mode: 'reply', text: 'done' }),
      targets: MOCK_TARGETS,
      knownProviderIds: ['mock'],
      agentProfileStore: profiles,
      deliveryContractProbeFactory: () => ({
        git: {
          currentBranch: async () => ({ kind: 'ok', value: 'feat/x' }),
          aheadCount: async () => ({ kind: 'ok', value: 0 }),
        },
        pr: {
          hasOpenPrForBranch: async () => ({ kind: 'ok', value: false }),
        },
      }),
    });

    const mentions = parseMentions('@mock please ship', ['mock']);
    const result = store.appendCompleteWithAsyncRun({
      channelId: CH,
      sender: OPERATOR,
      text: '@mock please ship',
      mentions,
      targetIds: [builtInAgentProfileId('mock')],
      deliveryContract: { expect: ['pr:feat/x'] },
      meta: { deliveryContract: { expect: ['pr:feat/x'] } },
    });
    binder.handleMessagePosted(result.message, result.message.mentions ?? []);

    await waitFor(() => {
      const run = store.getAsyncRun(result.run.id);
      return run?.state === 'completed_unmet';
    });

    const run = store.getAsyncRun(result.run.id)!;
    expect(run.state).toBe('completed_unmet');
    expect(run.deliveryContract?.result?.met).toBe(false);
    expect(run.deliveryContract?.result?.unmet).toEqual(['pr:feat/x']);
    expect(run.deliveryContract?.result?.unknown ?? []).toEqual([]);
    expect(run.deliveryContract?.followupPostedAt).toBeTruthy();

    const sys = systemRows(store).map((m) => m.body.text);
    expect(sys.some((t) => t.includes('Delivery contract unmet'))).toBe(true);
    expect(
      sys.filter((t) => t.includes('Turn ended with contract unmet')).length
    ).toBe(1);
  });

  it('keeps a run completed when the delivery contract cannot be verified (#1569)', async () => {
    const profiles = createAgentProfileStore(':memory:');
    cleanup.push(() => profiles.close());
    profiles.seedBuiltIns([{ id: 'mock' }]);

    const { binder, store } = makeBinder({
      build: (agentType) =>
        new ScriptedAdapter(agentType, { mode: 'reply', text: 'done' }),
      targets: MOCK_TARGETS,
      knownProviderIds: ['mock'],
      agentProfileStore: profiles,
      deliveryContractProbeFactory: () => ({
        git: {
          currentBranch: async () => ({ kind: 'ok', value: 'feat/x' }),
          aheadCount: async () => ({
            kind: 'unknown',
            reason: 'not a git repository',
          }),
        },
        pr: {
          hasOpenPrForBranch: async () => ({
            kind: 'unknown',
            reason: 'gh unauthenticated',
          }),
        },
      }),
    });

    const mentions = parseMentions('@mock please ship', ['mock']);
    const result = store.appendCompleteWithAsyncRun({
      channelId: CH,
      sender: OPERATOR,
      text: '@mock please ship',
      mentions,
      targetIds: [builtInAgentProfileId('mock')],
      deliveryContract: { expect: ['commit', 'pr:feat/x'] },
      meta: { deliveryContract: { expect: ['commit', 'pr:feat/x'] } },
    });
    binder.handleMessagePosted(result.message, result.message.mentions ?? []);

    await waitFor(() => {
      const run = store.getAsyncRun(result.run.id);
      return (
        run?.state === 'completed' && Boolean(run.deliveryContract?.result)
      );
    });

    const run = store.getAsyncRun(result.run.id)!;
    expect(run.state).toBe('completed');
    expect(run.deliveryContract?.result?.unmet ?? []).toEqual([]);
    expect(run.deliveryContract?.result?.unknown?.length ?? 0).toBeGreaterThan(
      0
    );
    expect(run.deliveryContract?.followupPostedAt).toBeFalsy();

    const sys = systemRows(store).map((m) => m.body.text);
    expect(
      sys.some((t) => t.includes('Delivery contract could not verify'))
    ).toBe(true);
    expect(sys.some((t) => t.includes('Turn ended with contract unmet'))).toBe(
      false
    );
  });

  it('keeps a run completed and does not follow-up when the delivery contract is met (#1569)', async () => {
    const profiles = createAgentProfileStore(':memory:');
    cleanup.push(() => profiles.close());
    profiles.seedBuiltIns([{ id: 'mock' }]);

    const { binder, store } = makeBinder({
      build: (agentType) =>
        new ScriptedAdapter(agentType, { mode: 'reply', text: 'done' }),
      targets: MOCK_TARGETS,
      knownProviderIds: ['mock'],
      agentProfileStore: profiles,
      deliveryContractProbeFactory: () => ({
        git: {
          currentBranch: async () => ({ kind: 'ok', value: 'feat/x' }),
          aheadCount: async () => ({ kind: 'ok', value: 1 }),
        },
        pr: {
          hasOpenPrForBranch: async () => ({ kind: 'ok', value: true }),
        },
      }),
    });

    const mentions = parseMentions('@mock please ship', ['mock']);
    const result = store.appendCompleteWithAsyncRun({
      channelId: CH,
      sender: OPERATOR,
      text: '@mock please ship',
      mentions,
      targetIds: [builtInAgentProfileId('mock')],
      deliveryContract: { expect: ['text:done'] },
      meta: { deliveryContract: { expect: ['text:done'] } },
    });
    binder.handleMessagePosted(result.message, result.message.mentions ?? []);

    await waitFor(() => {
      const run = store.getAsyncRun(result.run.id);
      return (
        run?.state === 'completed' && Boolean(run.deliveryContract?.result)
      );
    });

    const run = store.getAsyncRun(result.run.id)!;
    expect(run.state).toBe('completed');
    expect(run.deliveryContract?.result?.met).toBe(true);
    expect(run.deliveryContract?.followupPostedAt).toBeFalsy();
    const sys = systemRows(store).map((m) => m.body.text);
    expect(sys.some((t) => t.includes('Delivery contract unmet'))).toBe(false);
    expect(sys.some((t) => t.includes('Turn ended with contract unmet'))).toBe(
      false
    );
  });

  it('does not consume a MAX_CONSECUTIVE_AGENT_TURNS slot when routing the follow-up (#1569)', async () => {
    const profiles = createAgentProfileStore(':memory:');
    cleanup.push(() => profiles.close());
    profiles.seedBuiltIns([{ id: 'mock' }]);

    const { binder, store } = makeBinder({
      build: (agentType) =>
        new ScriptedAdapter(agentType, { mode: 'reply', text: 'done' }),
      targets: MOCK_TARGETS,
      knownProviderIds: ['mock'],
      agentProfileStore: profiles,
      deliveryContractProbeFactory: () => ({
        git: {
          currentBranch: async () => ({ kind: 'ok', value: 'feat/x' }),
          aheadCount: async () => ({ kind: 'ok', value: 0 }),
        },
        pr: {
          hasOpenPrForBranch: async () => ({ kind: 'ok', value: false }),
        },
      }),
    });

    const mentions = parseMentions('@mock please ship', ['mock']);
    const result = store.appendCompleteWithAsyncRun({
      channelId: CH,
      sender: OPERATOR,
      text: '@mock please ship',
      mentions,
      targetIds: [builtInAgentProfileId('mock')],
      deliveryContract: { expect: ['pr:feat/x'] },
      meta: { deliveryContract: { expect: ['pr:feat/x'] } },
    });
    binder.handleMessagePosted(result.message, result.message.mentions ?? []);

    await waitFor(() =>
      systemRows(store).some((m) =>
        m.body.text.includes('Turn ended with contract unmet')
      )
    );

    const baseline = agentReplies(store, 'mock').length;
    for (let i = 0; i < MAX_CONSECUTIVE_AGENT_TURNS; i += 1) {
      postAgentTurnRow(
        store,
        binder,
        `post-followup-${i}`,
        'item-0',
        `@mock agent turn ${i}`,
        ['mock'],
        'session:not-registered',
        AGENT_SENDER
      );
    }
    await waitFor(
      () =>
        agentReplies(store, 'mock').length ===
        baseline + MAX_CONSECUTIVE_AGENT_TURNS
    );
    expect(
      systemRows(store).some((m) =>
        m.body.text.includes('Mention chain paused')
      )
    ).toBe(false);

    postAgentTurnRow(
      store,
      binder,
      'post-followup-cap',
      'item-0',
      '@mock should be braked',
      ['mock'],
      'session:not-registered',
      AGENT_SENDER
    );
    await waitFor(() =>
      systemRows(store).some((m) =>
        m.body.text.includes('Mention chain paused')
      )
    );
    const pause = systemRows(store).find((m) =>
      m.body.text.includes('Mention chain paused')
    );
    expect(pause?.body.text).toContain(
      `Mention chain paused — ${MAX_CONSECUTIVE_AGENT_TURNS} agent turns without a human.`
    );
  });

  it('does not route a follow-up when the channel is paused (#1569)', async () => {
    const profiles = createAgentProfileStore(':memory:');
    cleanup.push(() => profiles.close());
    profiles.seedBuiltIns([{ id: 'mock' }, { id: 'b' }]);

    const deferred = new DeferredAdapter('mock');
    const { binder, store } = makeBinder({
      build: (agentType) =>
        agentType === 'mock'
          ? deferred
          : new ScriptedAdapter(agentType, { mode: 'reply', text: 'ok' }),
      targets: [
        {
          id: 'mock',
          displayName: 'Mock',
          kind: 'framework',
          available: true,
          reason: null,
        },
        {
          id: 'b',
          displayName: 'B',
          kind: 'framework',
          available: true,
          reason: null,
        },
      ],
      knownProviderIds: ['mock', 'b'],
      agentProfileStore: profiles,
      deliveryContractProbeFactory: () => ({
        git: {
          currentBranch: async () => ({ kind: 'ok', value: 'feat/x' }),
          aheadCount: async () => ({ kind: 'ok', value: 0 }),
        },
        pr: {
          hasOpenPrForBranch: async () => ({ kind: 'ok', value: false }),
        },
      }),
    });

    const mentions = parseMentions('@mock please ship', ['mock', 'b']);
    const result = store.appendCompleteWithAsyncRun({
      channelId: CH,
      sender: OPERATOR,
      text: '@mock please ship',
      mentions,
      targetIds: [builtInAgentProfileId('mock')],
      deliveryContract: { expect: ['pr:feat/x'] },
      meta: { deliveryContract: { expect: ['pr:feat/x'] } },
    });
    binder.handleMessagePosted(result.message, result.message.mentions ?? []);
    await waitFor(() => deferred.sendInputs.length === 1);

    for (let i = 0; i < MAX_CONSECUTIVE_AGENT_TURNS + 1; i += 1) {
      postAgentTurnRow(
        store,
        binder,
        `pause-${i}`,
        'item-0',
        `@b pause me ${i}`,
        ['b'],
        'session:not-registered',
        AGENT_SENDER
      );
    }
    await waitFor(() =>
      systemRows(store).some((m) =>
        m.body.text.includes('Mention chain paused')
      )
    );
    const pauseRowsBefore = systemRows(store).filter((m) =>
      m.body.text.includes('Mention chain paused')
    ).length;

    deferred.completeReply(deferred.sendCalls[0]!, 'done');

    await waitFor(
      () => store.getAsyncRun(result.run.id)?.state === 'completed_unmet'
    );
    const followup = systemRows(store).find((m) =>
      Boolean(
        (m.meta as Record<string, unknown> | undefined)?.[
          'deliveryContractFollowup'
        ]
      )
    );
    expect(followup).toBeTruthy();
    if (followup) binder.handleMessagePosted(followup, []);

    await waitFor(() => {
      const rows = systemRows(store).filter((m) =>
        m.body.text.includes('Mention chain paused')
      );
      return rows.length === pauseRowsBefore + 1;
    });
    expect(deferred.sendInputs).toHaveLength(1);
  });

  it('swallows exceptions thrown during delivery-contract evaluation (#1569)', async () => {
    const unhandled: unknown[] = [];
    const handler = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', handler);
    try {
      const profiles = createAgentProfileStore(':memory:');
      cleanup.push(() => profiles.close());
      profiles.seedBuiltIns([{ id: 'mock' }]);

      const { binder, store } = makeBinder({
        build: (agentType) =>
          new ScriptedAdapter(agentType, { mode: 'reply', text: 'done' }),
        targets: MOCK_TARGETS,
        knownProviderIds: ['mock'],
        agentProfileStore: profiles,
        deliveryContractProbeFactory: () => ({
          git: {
            currentBranch: async () => {
              throw new Error('git probe exploded');
            },
            aheadCount: async () => ({ kind: 'ok', value: 0 }),
          },
          pr: {
            hasOpenPrForBranch: async () => ({ kind: 'ok', value: false }),
          },
        }),
      });

      const mentions = parseMentions('@mock please ship', ['mock']);
      const result = store.appendCompleteWithAsyncRun({
        channelId: CH,
        sender: OPERATOR,
        text: '@mock please ship',
        mentions,
        targetIds: [builtInAgentProfileId('mock')],
        deliveryContract: { expect: ['pr'] },
        meta: { deliveryContract: { expect: ['pr'] } },
      });
      binder.handleMessagePosted(result.message, result.message.mentions ?? []);

      await waitFor(
        () => store.getAsyncRun(result.run.id)?.state === 'completed'
      );
      await new Promise((r) => setTimeout(r, 50));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', handler);
    }
  });
});

describe('channel-agent-binder — delivery + idempotency', () => {
  it('preserves an active threaded turn across transport rebind and finishes promptly', async () => {
    let spawnNumber = 0;
    let firstAdapter: DeferredAdapter | null = null;
    const { binder, store, sessions } = makeBinder({
      build: (agentType) => {
        spawnNumber++;
        if (spawnNumber === 1) {
          firstAdapter = new DeferredAdapter(agentType);
          return firstAdapter;
        }
        return new ScriptedAdapter(agentType, {
          mode: 'reply',
          text: 'rebound reply',
        });
      },
      targets: MOCK_TARGETS,
      knownProviderIds: ['mock'],
    });
    const root = store.appendComplete({
      channelId: CH,
      sender: OPERATOR,
      text: 'root',
    });
    const trigger = post(
      store,
      binder,
      '@mock retry',
      ['mock'],
      OPERATOR,
      root.id
    );
    await waitFor(
      () => firstAdapter !== null && firstAdapter.sendCalls.length === 1
    );
    const turnId = firstAdapter!.sendCalls[0]!;
    // Model a dead transport discovered by send rejection before the normal
    // session-end callback has removed the live binding.
    sessions.forgetWithoutEnd(sessions.firstSessionId());
    firstAdapter!.rejectSend(turnId);
    await waitFor(() => agentReplies(store, 'mock').length === 1);
    const reply = agentReplies(store, 'mock')[0]!;
    expect(reply).toMatchObject({
      threadId: root.id,
      parentMessageId: trigger.id,
    });
    expect(sessions.spawns()).toBe(2);
    const rebound = await binder.ensureBinding(CH, 'mock');
    expect(rebound.activeTurnId).toBeNull();
    expect(rebound.status).toBe('idle');
  });

  it('threads a terminal send-failure row to its triggering reply', async () => {
    const { binder, store } = makeBinder({
      build: () => new ScriptedAdapter('x', { mode: 'reject' }),
      targets: [
        {
          id: 'x',
          displayName: 'X',
          kind: 'framework',
          available: true,
          reason: null,
        },
      ],
      knownProviderIds: ['x'],
    });
    const root = store.appendComplete({
      channelId: CH,
      sender: OPERATOR,
      text: 'root',
    });
    const trigger = post(store, binder, '@x go', ['x'], OPERATOR, root.id);
    await waitFor(() =>
      systemRows(store).some((m) => m.body.text.includes('could not receive'))
    );
    const failure = systemRows(store).find((m) =>
      m.body.text.includes('could not receive')
    )!;
    expect(failure.threadId).toBe(root.id);
    expect(failure.parentMessageId).toBe(trigger.id);
  });

  it('uses a deterministic turnId and a retry reuses the same turn identity', async () => {
    const { binder, store, sessions } = makeBinder({
      build: () =>
        new ScriptedAdapter('x', {
          mode: 'reject-once-then-reply',
          text: 'ok',
        }),
      targets: [
        {
          id: 'x',
          displayName: 'X',
          kind: 'framework',
          available: true,
          reason: null,
        },
      ],
      knownProviderIds: ['x'],
    });
    const trigger = post(store, binder, '@x go', ['x']);
    await waitFor(() => agentReplies(store, 'x').length === 1);
    const adapter = sessions.adapterFor(
      sessions.firstSessionId()
    ) as ScriptedAdapter;
    expect(adapter.sendCalls).toHaveLength(2); // rejected once, then retried
    const expected = `chturn-${trigger.id}-${builtInAgentProfileId('x')}`;
    expect(adapter.sendCalls[0]).toBe(expected);
    expect(adapter.sendCalls[1]).toBe(expected); // retry reuses the SAME turnId
    expect(sessions.spawns()).toBe(1);
  });

  it('resolves image refs once and preserves attachments across a send retry', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'binder-image-retry-'));
    cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const payloadPath = path.join(dir, 'fixture.png');
    fs.writeFileSync(payloadPath, Buffer.from('fixture'));
    const part: ChannelImagePart = {
      type: 'image',
      id: 'cha:retry-image',
      mime: 'image/png',
      w: 1,
      h: 1,
      bytes: 7,
    };
    const attachmentStore = {
      get: (id: string) =>
        id === part.id
          ? {
              part,
              sha256: 'retry-image',
              payloadPath,
              createdAt: 't',
            }
          : null,
    } as ChannelAttachmentStore;
    const { binder, store, sessions } = makeBinder({
      build: () =>
        new ScriptedAdapter('mock', {
          mode: 'reject-once-then-reply',
          text: 'ok',
        }),
      targets: MOCK_TARGETS,
      knownProviderIds: ['mock'],
      attachmentStore,
    });
    const mentions = parseMentions('@mock inspect', ['mock']);
    const trigger = store.appendComplete({
      channelId: CH,
      sender: OPERATOR,
      text: '@mock inspect',
      mentions,
      parts: [part],
    });
    binder.handleMessagePosted(trigger, mentions);

    await waitFor(() => agentReplies(store, 'mock').length === 1);
    const adapter = sessions.adapterFor(
      sessions.firstSessionId()
    ) as ScriptedAdapter;
    expect(adapter.sendInputs).toHaveLength(2);
    expect(adapter.sendInputs[0]!.attachments).toEqual([
      { type: 'image', path: payloadPath, mimeType: 'image/png' },
    ]);
    expect(adapter.sendInputs[1]).toEqual(adapter.sendInputs[0]);
  });

  it('retains an image-only thread root as structural text and an attachment', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'binder-image-root-'));
    cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const payloadPath = path.join(dir, 'root.png');
    fs.writeFileSync(payloadPath, Buffer.from('fixture'));
    const part: ChannelImagePart = {
      type: 'image',
      id: 'cha:image-root',
      mime: 'image/png',
      w: 1,
      h: 1,
      bytes: 7,
    };
    const attachmentStore = {
      get: (id: string) =>
        id === part.id
          ? {
              part,
              sha256: 'image-root',
              payloadPath,
              createdAt: 't',
            }
          : null,
    } as ChannelAttachmentStore;
    const { binder, store, sessions } = makeBinder({
      build: () => new ScriptedAdapter('mock', { mode: 'reply', text: 'ok' }),
      targets: MOCK_TARGETS,
      knownProviderIds: ['mock'],
      attachmentStore,
    });
    const root = store.appendComplete({
      channelId: CH,
      sender: OPERATOR,
      text: '',
      parts: [part],
    });

    post(
      store,
      binder,
      '@mock inspect the root image',
      ['mock'],
      OPERATOR,
      root.id
    );
    await waitFor(() => sessions.spawns() === 1);
    const adapter = sessions.adapterFor(
      sessions.firstSessionId()
    ) as ScriptedAdapter;
    await waitFor(() => adapter.sendInputs.length === 1);
    expect(adapter.sendInputs[0]!.content).toContain(
      '1 prior thread rows (1 shown, 0 activity rows filtered).'
    );
    expect(adapter.sendInputs[0]!.content).toContain(
      'operator: [image-only message]'
    );
    expect(adapter.sendInputs[0]!.attachments).toEqual([
      { type: 'image', path: payloadPath, mimeType: 'image/png' },
    ]);
  });

  it('queries exact counts across a large activity-only stretch without losing older prose', async () => {
    const { binder, store, sessions } = makeBinder({
      build: () => new ScriptedAdapter('mock', { mode: 'reply', text: 'ok' }),
      targets: MOCK_TARGETS,
      knownProviderIds: ['mock'],
    });
    store.appendComplete({
      channelId: CH,
      sender: OPERATOR,
      text: 'retain this earlier prose',
    });
    for (let index = 0; index < CHANNEL_HISTORY_MAX_LIMIT + 5; index += 1) {
      const detail = store.beginStream({
        channelId: CH,
        sender: {
          kind: 'agent',
          id: 'agent:other',
          providerId: 'other',
        },
        source: {
          runtimeId: 'runtime:other',
          turnId: `turn:${index}`,
          itemId: `thought:${index}`,
        },
        agentDetail: {
          itemId: `thought:${index}`,
          card: {
            kind: 'thought',
            title: 'Reasoning summary',
            status: 'running',
            content: 'activity must not consume prose context',
          },
        },
      });
      store.finalizeStream(detail.id, { text: '', status: 'complete' });
    }

    post(store, binder, '@mock inspect the earlier prose', ['mock']);
    await waitFor(() => agentReplies(store, 'mock').length === 1);
    const adapter = sessions.adapterFor(
      sessions.firstSessionId()
    ) as ScriptedAdapter;
    await waitFor(() => adapter.sendInputs.length === 1);
    const packet = adapter.sendInputs[0]!.content;
    expect(packet).toContain('operator: retain this earlier prose');
    expect(packet).toContain(
      `${CHANNEL_HISTORY_MAX_LIMIT + 6} messages since your last turn (1 shown, ${CHANNEL_HISTORY_MAX_LIMIT + 5} activity rows filtered).`
    );
    expect(packet).not.toContain('activity must not consume prose context');
  });

  it('keeps a deleted thread root structural beside only the newest 15 of 16 replies', async () => {
    const { binder, store, sessions } = makeBinder({
      build: () => new ScriptedAdapter('mock', { mode: 'reply', text: 'ok' }),
      targets: MOCK_TARGETS,
      knownProviderIds: ['mock'],
    });
    const root = store.appendComplete({
      channelId: CH,
      sender: OPERATOR,
      text: 'thread anchor to delete',
    });
    for (let index = 0; index < PACKET_MAX_ROWS; index += 1) {
      store.appendComplete({
        channelId: CH,
        sender: OPERATOR,
        text: `thread reply ${index}`,
        parentMessageId: root.id,
      });
    }
    store.deleteMessage({
      channelId: CH,
      messageId: root.id,
      deleterId: OPERATOR.id,
    });

    post(
      store,
      binder,
      '@mock inspect this thread',
      ['mock'],
      OPERATOR,
      root.id
    );
    await waitFor(() => sessions.spawns() === 1);
    const adapter = sessions.adapterFor(
      sessions.firstSessionId()
    ) as ScriptedAdapter;
    await waitFor(() => adapter.sendInputs.length === 1);
    const packet = adapter.sendInputs[0]!.content;
    expect(packet).toContain(
      `${PACKET_MAX_ROWS + 1} prior thread rows (${PACKET_MAX_ROWS} shown, 0 activity rows filtered).`
    );
    expect(packet.match(/\[message deleted\]/g)).toHaveLength(1);
    expect(packet.match(/\[…earlier messages omitted\]/g)).toHaveLength(1);
    expect(packet).not.toContain('operator: thread reply 0\n');
    expect(packet).toContain('operator: thread reply 1');
    expect(packet).toContain(`operator: thread reply ${PACKET_MAX_ROWS - 1}`);
    expect(packet).not.toContain('thread anchor to delete');
  });

  it('advances the delivery cursor only after a send is accepted', async () => {
    const { binder, store } = makeBinder({
      build: () => new MockProtocolAdapterV2({ connectMs: 1, stepMs: 1 }),
      targets: MOCK_TARGETS,
      knownProviderIds: ['mock'],
    });
    const trigger = post(store, binder, '@mock hello', ['mock']);
    await waitFor(() => agentReplies(store, 'mock').length === 1);
    await waitFor(
      () =>
        store.getBinding(CH, builtInAgentProfileId('mock'))?.providerSession[
          'lastDeliveredSeq'
        ] === trigger.seq
    );
    expect(
      store.getBinding(CH, builtInAgentProfileId('mock'))?.providerSession[
        'lastDeliveredSeq'
      ]
    ).toBe(trigger.seq);
  });

  it('delivers only post-cursor rows on a follow-up thread turn (#1408)', async () => {
    const { binder, store, sessions } = makeBinder({
      build: () => new ScriptedAdapter('mock', { mode: 'reply', text: 'ok' }),
      targets: MOCK_TARGETS,
      knownProviderIds: ['mock'],
    });
    const profileId = builtInAgentProfileId('mock');
    const root = store.appendComplete({
      channelId: CH,
      sender: OPERATOR,
      text: 'thread root question',
    });
    store.appendComplete({
      channelId: CH,
      sender: OPERATOR,
      text: 'early thread detail',
      parentMessageId: root.id,
    });

    const first = post(
      store,
      binder,
      '@mock start here',
      ['mock'],
      OPERATOR,
      root.id
    );
    await waitFor(() => sessions.spawns() === 1);
    const adapter = sessions.adapterFor(
      sessions.firstSessionId()
    ) as ScriptedAdapter;
    await waitFor(() => adapter.sendInputs.length === 1);
    // Turn 1 is the orientation window: root plus the prior reply.
    expect(adapter.sendInputs[0]!.content).toContain(
      'operator: thread root question'
    );
    expect(adapter.sendInputs[0]!.content).toContain(
      'operator: early thread detail'
    );
    // The cursor lands on the THREAD-scoped row, not the channel-scoped one.
    await waitFor(
      () =>
        store.getBinding(CH, profileId, root.id)?.providerSession[
          'lastDeliveredSeq'
        ] === first.seq
    );
    expect(store.getBinding(CH, profileId)).toBeNull();

    store.appendComplete({
      channelId: CH,
      sender: OPERATOR,
      text: 'later thread detail',
      parentMessageId: root.id,
    });
    const second = post(
      store,
      binder,
      '@mock and now this',
      ['mock'],
      OPERATOR,
      root.id
    );
    await waitFor(() => adapter.sendInputs.length === 2);
    const packet = adapter.sendInputs[1]!.content;
    expect(packet).toContain('operator: later thread detail');
    expect(packet).not.toContain('thread root question');
    expect(packet).not.toContain('early thread detail');
    expect(packet).not.toContain('@mock start here');
    expect(packet).toContain('@mock and now this');
    expect(sessions.spawns()).toBe(1);
    await waitFor(
      () =>
        store.getBinding(CH, profileId, root.id)?.providerSession[
          'lastDeliveredSeq'
        ] === second.seq
    );
  });

  it('re-orients a respawned thread runtime that holds no provider resume state', async () => {
    const { binder, store, sessions } = makeBinder({
      build: () => new ScriptedAdapter('mock', { mode: 'reply', text: 'ok' }),
      targets: MOCK_TARGETS,
      knownProviderIds: ['mock'],
    });
    const root = store.appendComplete({
      channelId: CH,
      sender: OPERATOR,
      text: 'thread root question',
    });
    const delivered = store.appendComplete({
      channelId: CH,
      sender: OPERATOR,
      text: 'already delivered detail',
      parentMessageId: root.id,
    });
    // A predecessor runtime consumed the thread and died. Only Relay's own
    // cursor survives — no adapter resume handle.
    store.upsertBinding({
      channelId: CH,
      threadId: root.id,
      profileActorId: builtInAgentProfileId('mock'),
      agentFramework: 'mock',
      providerSession: { lastDeliveredSeq: delivered.seq },
    });

    post(store, binder, '@mock continue', ['mock'], OPERATOR, root.id);
    await waitFor(() => sessions.spawns() === 1);
    const adapter = sessions.adapterFor(
      sessions.firstSessionId()
    ) as ScriptedAdapter;
    await waitFor(() => adapter.sendInputs.length === 1);
    const packet = adapter.sendInputs[0]!.content;
    expect(packet).toContain('operator: thread root question');
    expect(packet).toContain('operator: already delivered detail');
  });

  it('honors the stored thread cursor when the runtime resumes provider state', async () => {
    const { binder, store, sessions } = makeBinder({
      build: () => new ScriptedAdapter('claude', { mode: 'reply', text: 'ok' }),
      targets: CLAUDE_TARGETS,
      knownProviderIds: ['claude'],
    });
    const root = store.appendComplete({
      channelId: CH,
      sender: OPERATOR,
      text: 'thread root question',
    });
    const delivered = store.appendComplete({
      channelId: CH,
      sender: OPERATOR,
      text: 'already delivered detail',
      parentMessageId: root.id,
    });
    const fresh = store.appendComplete({
      channelId: CH,
      sender: OPERATOR,
      text: 'brand new detail',
      parentMessageId: root.id,
    });
    // Same row, but the adapter kept claude's RESUME handle beside the cursor,
    // so the respawned process replays the conversation itself.
    store.upsertBinding({
      channelId: CH,
      threadId: root.id,
      profileActorId: builtInAgentProfileId('claude'),
      agentFramework: 'claude',
      providerSession: {
        claudeSessionId: 'resume-me',
        lastDeliveredSeq: delivered.seq,
      },
    });

    post(store, binder, '@claude continue', ['claude'], OPERATOR, root.id);
    await waitFor(() => sessions.spawns() === 1);
    expect(sessions.lastCreateParams()?.providerSession).toMatchObject({
      claudeSessionId: 'resume-me',
    });
    const adapter = sessions.adapterFor(
      sessions.firstSessionId()
    ) as ScriptedAdapter;
    await waitFor(() => adapter.sendInputs.length === 1);
    const packet = adapter.sendInputs[0]!.content;
    expect(packet).toContain('operator: brand new detail');
    expect(packet).not.toContain('thread root question');
    expect(packet).not.toContain('already delivered detail');
    expect(fresh.seq).toBeGreaterThan(delivered.seq);
  });

  // #1408. Resume is attempted from ONE provider-specific key. A blob that is
  // non-empty but carries no key this provider resumes from (mock persists
  // `mockSessionId`) spawns an amnesiac process, so it must still be oriented —
  // otherwise a custom adapter with private bookkeeping silently defeats the
  // orientation rule and the agent gets a replies-only packet with no root.
  it('re-orients when the stored provider state is not a resume handle for this provider', async () => {
    const { binder, store, sessions } = makeBinder({
      build: () => new ScriptedAdapter('mock', { mode: 'reply', text: 'ok' }),
      targets: MOCK_TARGETS,
      knownProviderIds: ['mock'],
    });
    const root = store.appendComplete({
      channelId: CH,
      sender: OPERATOR,
      text: 'thread root question',
    });
    const delivered = store.appendComplete({
      channelId: CH,
      sender: OPERATOR,
      text: 'already delivered detail',
      parentMessageId: root.id,
    });
    store.upsertBinding({
      channelId: CH,
      threadId: root.id,
      profileActorId: builtInAgentProfileId('mock'),
      agentFramework: 'mock',
      providerSession: {
        // Real key the mock adapter persists — and one `providerResumeId`
        // does not map, so `runtimes.create` never resumes from it.
        mockSessionId: 'mock-session-abc',
        // Claude's key on a mock binding is inert too: resume is per provider.
        claudeSessionId: 'not-mine',
        lastDeliveredSeq: delivered.seq,
      },
    });

    post(store, binder, '@mock continue', ['mock'], OPERATOR, root.id);
    await waitFor(() => sessions.spawns() === 1);
    const adapter = sessions.adapterFor(
      sessions.firstSessionId()
    ) as ScriptedAdapter;
    await waitFor(() => adapter.sendInputs.length === 1);
    const packet = adapter.sendInputs[0]!.content;
    expect(packet).toContain('operator: thread root question');
    expect(packet).toContain('operator: already delivered detail');
  });

  it('never advances the thread cursor when the send is rejected', async () => {
    const { binder, store } = makeBinder({
      build: () => new ScriptedAdapter('mock', { mode: 'reject' }),
      targets: MOCK_TARGETS,
      knownProviderIds: ['mock'],
    });
    const root = store.appendComplete({
      channelId: CH,
      sender: OPERATOR,
      text: 'thread root question',
    });
    post(store, binder, '@mock please', ['mock'], OPERATOR, root.id);
    await waitFor(() =>
      systemRows(store).some((message) =>
        message.body.text.includes('could not receive the message')
      )
    );
    expect(
      store.getBinding(CH, builtInAgentProfileId('mock'), root.id)
        ?.providerSession['lastDeliveredSeq']
    ).toBeUndefined();
  });
});

describe('channel-agent-binder — agent-to-agent brake', () => {
  it('does not grant the brake exemption from a self-declared orchestrator presence role', async () => {
    const { binder, store } = makeBinder({
      build: () => new MockProtocolAdapterV2({ connectMs: 1, stepMs: 1 }),
      targets: MOCK_TARGETS,
      knownProviderIds: ['mock'],
    });

    for (let index = 0; index < MAX_CONSECUTIVE_AGENT_TURNS; index += 1) {
      postAgentTurnRow(
        store,
        binder,
        `self-declared-${index}`,
        'item-0',
        `@mock self-declared orchestrator ${index}`,
        ['mock'],
        'session:not-registered',
        AGENT_SENDER
      );
    }
    await waitFor(
      () => agentReplies(store, 'mock').length === MAX_CONSECUTIVE_AGENT_TURNS
    );

    postAgentTurnRow(
      store,
      binder,
      'self-declared-cap',
      'item-0',
      '@mock should be braked',
      ['mock'],
      'session:not-registered',
      AGENT_SENDER
    );
    await waitFor(() =>
      systemRows(store).some((message) =>
        message.body.text.includes('Mention chain paused')
      )
    );
    expect(agentReplies(store, 'mock')).toHaveLength(
      MAX_CONSECUTIVE_AGENT_TURNS
    );
  });

  it('does not charge orchestrator turns against the worker-turn allowance', async () => {
    const { binder, store, sessions } = makeBinder({
      build: () => new MockProtocolAdapterV2({ connectMs: 1, stepMs: 1 }),
      targets: MOCK_TARGETS,
      knownProviderIds: ['mock'],
    });
    const driverSessionId = 'session:driver';
    const workerSessionId = 'session:worker';
    sessions.registerSourceSession(driverSessionId, 'orchestrator');
    sessions.registerSourceSession(workerSessionId, 'implementer');

    for (let index = 0; index < MAX_CONSECUTIVE_AGENT_TURNS + 1; index += 1) {
      postAgentTurnRow(
        store,
        binder,
        `driver-turn-${index}`,
        'item-0',
        `@mock coordinate ${index}`,
        ['mock'],
        driverSessionId,
        CLAUDE_AGENT_SENDER
      );
    }
    await waitFor(
      () =>
        agentReplies(store, 'mock').length === MAX_CONSECUTIVE_AGENT_TURNS + 1
    );
    expect(
      systemRows(store).filter((message) =>
        message.body.text.includes('Mention chain paused')
      )
    ).toHaveLength(0);

    for (let index = 0; index < MAX_CONSECUTIVE_AGENT_TURNS; index += 1) {
      postAgentTurnRow(
        store,
        binder,
        `worker-turn-${index}`,
        'item-0',
        `@mock worker ${index}`,
        ['mock'],
        workerSessionId,
        AGENT_SENDER
      );
    }
    await waitFor(
      () =>
        agentReplies(store, 'mock').length ===
        MAX_CONSECUTIVE_AGENT_TURNS * 2 + 1
    );
    postAgentTurnRow(
      store,
      binder,
      'worker-turn-cap',
      'item-0',
      '@mock worker cap',
      ['mock'],
      workerSessionId,
      AGENT_SENDER
    );
    await waitFor(() =>
      systemRows(store).some((message) =>
        message.body.text.includes('Mention chain paused')
      )
    );
    expect(agentReplies(store, 'mock')).toHaveLength(
      MAX_CONSECUTIVE_AGENT_TURNS * 2 + 1
    );
  });

  it('lets the orchestrator route through a paused brake while human reset restores workers', async () => {
    const { binder, store, sessions } = makeBinder({
      build: () => new MockProtocolAdapterV2({ connectMs: 1, stepMs: 1 }),
      targets: MOCK_TARGETS,
      knownProviderIds: ['mock'],
    });
    const driverSessionId = 'session:driver';
    const workerSessionId = 'session:worker';
    sessions.registerSourceSession(driverSessionId, 'orchestrator');
    sessions.registerSourceSession(workerSessionId, 'implementer');

    for (let index = 0; index < MAX_CONSECUTIVE_AGENT_TURNS; index += 1) {
      postAgentTurnRow(
        store,
        binder,
        `worker-pause-${index}`,
        'item-0',
        `@mock worker ${index}`,
        ['mock'],
        workerSessionId,
        AGENT_SENDER
      );
    }
    await waitFor(
      () => agentReplies(store, 'mock').length === MAX_CONSECUTIVE_AGENT_TURNS
    );
    postAgentTurnRow(
      store,
      binder,
      'worker-pause-cap',
      'item-0',
      '@mock pause',
      ['mock'],
      workerSessionId,
      AGENT_SENDER
    );
    await waitFor(() =>
      systemRows(store).some((message) =>
        message.body.text.includes('Mention chain paused')
      )
    );

    postAgentTurnRow(
      store,
      binder,
      'driver-after-pause',
      'item-0',
      '@mock keep coordinating',
      ['mock'],
      driverSessionId,
      CLAUDE_AGENT_SENDER
    );
    await waitFor(
      () =>
        agentReplies(store, 'mock').length === MAX_CONSECUTIVE_AGENT_TURNS + 1
    );
    expect(
      systemRows(store).filter((message) =>
        message.body.text.includes('Mention chain paused')
      )
    ).toHaveLength(1);

    post(store, binder, '@mock human reset', ['mock'], OPERATOR);
    await waitFor(
      () =>
        agentReplies(store, 'mock').length === MAX_CONSECUTIVE_AGENT_TURNS + 2
    );
    postAgentTurnRow(
      store,
      binder,
      'worker-after-reset',
      'item-0',
      '@mock worker resumed',
      ['mock'],
      workerSessionId,
      AGENT_SENDER
    );
    await waitFor(
      () =>
        agentReplies(store, 'mock').length === MAX_CONSECUTIVE_AGENT_TURNS + 3
    );
  });

  it('counts one provider turn once across item rows and mention fanout', async () => {
    const build = (agentType: string) =>
      agentType === 'a'
        ? new ScriptedAdapter('a', {
            // Completion callbacks are now intentionally delivered back to A.
            // Keep this fan-out-counting fixture focused on A's FIRST provider
            // turn so a callback re-entry cannot manufacture another batch.
            mode: 'reply-items-once-then-stall',
            texts: ['one @b @c', 'two @b', 'three @b', 'four @b'],
          })
        : new ScriptedAdapter(agentType, { mode: 'reply', text: 'done' });
    const { binder, store } = makeBinder({
      build,
      targets: [
        {
          id: 'a',
          displayName: 'A',
          kind: 'framework',
          available: true,
          reason: null,
        },
        {
          id: 'b',
          displayName: 'B',
          kind: 'framework',
          available: true,
          reason: null,
        },
        {
          id: 'c',
          displayName: 'C',
          kind: 'framework',
          available: true,
          reason: null,
        },
      ],
      knownProviderIds: ['a', 'b', 'c'],
    });

    post(store, binder, '@a go', ['a', 'b', 'c']);
    await waitFor(() => agentReplies(store, 'b').length === 4);
    await waitFor(() => agentReplies(store, 'c').length === 1);
    expect(agentReplies(store, 'b')).toHaveLength(4);
    expect(agentReplies(store, 'c')).toHaveLength(1);

    // Four rows consumed one provider-turn count, not four row counts: a second
    // distinct turn still routes instead of immediately tripping the cap.
    postAgentTurnRow(
      store,
      binder,
      'turn-after-multi-item',
      'item-0',
      '@b after',
      ['a', 'b', 'c']
    );
    await waitFor(() => agentReplies(store, 'b').length === 5);
    expect(agentReplies(store, 'b')).toHaveLength(5);
    expect(
      systemRows(store).filter((message) =>
        message.body.text.includes('Mention chain paused')
      )
    ).toHaveLength(0);
  });

  it('blocks later rows of an admitted turn after another turn pauses the channel', async () => {
    const { binder, store } = makeBinder({
      build: (agentType) =>
        new ScriptedAdapter(agentType, { mode: 'reply', text: 'done' }),
      targets: [
        {
          id: 'b',
          displayName: 'B',
          kind: 'framework',
          available: true,
          reason: null,
        },
      ],
      knownProviderIds: ['b'],
    });

    for (let index = 0; index < MAX_CONSECUTIVE_AGENT_TURNS; index += 1) {
      postAgentTurnRow(
        store,
        binder,
        `turn-${index}`,
        'item-0',
        `@b row ${index}`,
        ['b']
      );
    }
    await waitFor(
      () => agentReplies(store, 'b').length === MAX_CONSECUTIVE_AGENT_TURNS
    );

    postAgentTurnRow(store, binder, 'turn-cap', 'item-0', '@b pause', ['b']);
    await waitFor(() =>
      systemRows(store).some((message) =>
        message.body.text.includes('Mention chain paused')
      )
    );

    // turn-0 was admitted before the pause. Its later item must still pass the
    // per-dispatch pause check and never enqueue another downstream turn.
    postAgentTurnRow(store, binder, 'turn-0', 'item-late', '@b late row', [
      'b',
    ]);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(agentReplies(store, 'b')).toHaveLength(MAX_CONSECUTIVE_AGENT_TURNS);
    expect(
      systemRows(store).filter((message) =>
        message.body.text.includes('Mention chain paused')
      )
    ).toHaveLength(1);
  });

  it('caps consecutive agent turns and a human post resets the brake', async () => {
    const build = (agentType: string) =>
      new ScriptedAdapter(agentType, {
        mode: 'reply',
        text: agentType === 'a' ? 'ping @b' : 'ping @a',
      });
    const { binder, store } = makeBinder({
      build,
      targets: [
        {
          id: 'a',
          displayName: 'A',
          kind: 'framework',
          available: true,
          reason: null,
        },
        {
          id: 'b',
          displayName: 'B',
          kind: 'framework',
          available: true,
          reason: null,
        },
      ],
      knownProviderIds: ['a', 'b'],
    });
    const root = store.appendComplete({
      channelId: CH,
      sender: OPERATOR,
      text: 'root',
    });
    post(store, binder, '@a go', ['a', 'b'], OPERATOR, root.id);
    await waitFor(() =>
      systemRows(store).some((m) =>
        m.body.text.includes('Mention chain paused')
      )
    );
    const pausedRows = systemRows(store).filter((m) =>
      m.body.text.includes('Mention chain paused')
    );
    expect(pausedRows).toHaveLength(1);
    expect(pausedRows[0]!.threadId).toBe(root.id);
    expect(pausedRows[0]!.parentMessageId).not.toBeNull();
    // Human-initiated a reply is not counted; the brake bounds the autonomous
    // fan-out at MAX_CONSECUTIVE_AGENT_TURNS agent turns.
    const beforeReset = agentReplies(store).length;
    expect(beforeReset).toBeLessThanOrEqual(MAX_CONSECUTIVE_AGENT_TURNS + 1);

    // A fresh human post resets the counter → the chain resumes.
    post(store, binder, '@a again', ['a', 'b']);
    await waitFor(() => agentReplies(store).length > beforeReset, 6000);
    expect(agentReplies(store).length).toBeGreaterThan(beforeReset);
  });

  it('isolates the autonomous-turn brake and its human reset by thread root', async () => {
    const { binder, store } = makeBinder({
      build: () => new MockProtocolAdapterV2({ connectMs: 1, stepMs: 1 }),
      targets: MOCK_TARGETS,
      knownProviderIds: ['mock'],
    });
    const first = store.appendComplete({
      channelId: CH,
      sender: OPERATOR,
      text: 'first root',
    });
    const second = store.appendComplete({
      channelId: CH,
      sender: OPERATOR,
      text: 'second root',
    });

    for (let index = 0; index < MAX_CONSECUTIVE_AGENT_TURNS; index += 1) {
      postAgentTurnRow(
        store,
        binder,
        `first-${index}`,
        'item-0',
        '@mock continue first',
        ['mock'],
        'runtime:first',
        AGENT_SENDER,
        first.id
      );
    }
    await waitFor(
      () =>
        agentReplies(store, 'mock').filter(
          (message) => message.threadId === first.id
        ).length === MAX_CONSECUTIVE_AGENT_TURNS
    );
    postAgentTurnRow(
      store,
      binder,
      'first-cap',
      'item-0',
      '@mock pause first',
      ['mock'],
      'runtime:first',
      AGENT_SENDER,
      first.id
    );
    await waitFor(() =>
      systemRows(store).some(
        (message) =>
          message.threadId === first.id &&
          message.body.text.includes('Mention chain paused')
      )
    );

    // A separate conversation still admits autonomous work, and a human there
    // must not reset the paused chain above.
    postAgentTurnRow(
      store,
      binder,
      'second-first',
      'item-0',
      '@mock continue second',
      ['mock'],
      'runtime:second',
      AGENT_SENDER,
      second.id
    );
    await waitFor(() =>
      agentReplies(store, 'mock').some(
        (message) => message.threadId === second.id
      )
    );
    post(store, binder, '@mock human second', ['mock'], OPERATOR, second.id);
    await new Promise((resolve) => setTimeout(resolve, 30));
    const firstRepliesBefore = agentReplies(store, 'mock').filter(
      (message) => message.threadId === first.id
    ).length;
    postAgentTurnRow(
      store,
      binder,
      'first-still-paused',
      'item-0',
      '@mock remain paused',
      ['mock'],
      'runtime:first',
      AGENT_SENDER,
      first.id
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(
      agentReplies(store, 'mock').filter(
        (message) => message.threadId === first.id
      )
    ).toHaveLength(firstRepliesBefore);
  });
});

describe('channel-agent-binder — roster + availability', () => {
  it('projects one provider launch failure onto every profile roster row', async () => {
    const profiles = createAgentProfileStore(':memory:');
    cleanup.push(() => profiles.close());
    profiles.seedBuiltIns([{ id: 'prime-agent' }]);
    profiles.create({
      providerId: 'prime-agent',
      displayName: 'Prime Reviewer',
    });
    const reason =
      'prime-agent is not installed on this node (not found on PATH).';
    const { binder } = makeBinder({
      build: () => new MockProtocolAdapterV2({ connectMs: 1, stepMs: 1 }),
      targets: [
        {
          id: 'prime-agent',
          displayName: 'Prime Agent',
          kind: 'framework',
          available: false,
          reason,
          command: 'prime-agent',
        },
      ],
      knownProviderIds: ['prime-agent'],
      agentProfileStore: profiles,
    });

    const roster = await binder.rosterForChannel(CH);
    expect(roster).toHaveLength(2);
    expect(
      roster.every(
        (entry) => entry.available === false && entry.reason === reason
      )
    ).toBe(true);
  });

  it('pins the dsh not-installed reason text on its roster rows', async () => {
    const profiles = createAgentProfileStore(':memory:');
    cleanup.push(() => profiles.close());
    profiles.seedBuiltIns([{ id: 'dsh' }]);
    const reason = 'dsh is not installed on this node (not found on PATH).';
    const { binder } = makeBinder({
      build: () => new MockProtocolAdapterV2({ connectMs: 1, stepMs: 1 }),
      targets: [
        {
          id: 'dsh',
          displayName: 'DeepSeek Harness',
          kind: 'framework',
          available: false,
          reason,
          command: 'dsh',
        },
      ],
      knownProviderIds: ['dsh'],
      agentProfileStore: profiles,
    });

    const roster = await binder.rosterForChannel(CH);
    expect(roster).toHaveLength(1);
    expect(roster[0]).toMatchObject({ available: false, reason });
  });

  it('pins the cursor not-installed reason text on its roster rows', async () => {
    const profiles = createAgentProfileStore(':memory:');
    cleanup.push(() => profiles.close());
    profiles.seedBuiltIns([{ id: 'cursor' }]);
    const reason =
      'cursor-agent is not installed on this node (not found on PATH).';
    const { binder } = makeBinder({
      build: () => new MockProtocolAdapterV2({ connectMs: 1, stepMs: 1 }),
      targets: [
        {
          id: 'cursor',
          displayName: 'Cursor',
          kind: 'framework',
          available: false,
          reason,
          command: 'cursor-agent',
        },
      ],
      knownProviderIds: ['cursor'],
      agentProfileStore: profiles,
    });

    const roster = await binder.rosterForChannel(CH);
    expect(roster).toHaveLength(1);
    expect(roster[0]).toMatchObject({ available: false, reason });
  });

  it.each(CHANNEL_COMMAND_CONTRACTS)(
    'resolves %s command availability against built-in and named-profile PATH',
    async (providerId, command) => {
      const binDir = fs.mkdtempSync(
        path.join(os.tmpdir(), `relay-${providerId}-profile-bin-`)
      );
      const executableName =
        process.platform === 'win32' ? `${command}.EXE` : command;
      fs.writeFileSync(
        path.join(binDir, executableName),
        '#!/bin/sh\nexit 0\n',
        { mode: 0o755 }
      );
      const profiles = createAgentProfileStore(':memory:');
      cleanup.push(() => profiles.close());
      profiles.seedBuiltIns([{ id: providerId }]);
      const configured = profiles.create({
        providerId,
        displayName: `Configured ${providerId}`,
        envVars: { PATH: binDir },
      });
      const { binder } = makeBinder({
        build: () => new MockProtocolAdapterV2({ connectMs: 1, stepMs: 1 }),
        targets: [
          {
            id: providerId,
            displayName: providerId,
            kind: 'framework',
            available: true,
            reason: null,
            command,
          },
        ],
        knownProviderIds: [providerId],
        agentProfileStore: profiles,
        processEnv: { PATH: '' },
      });

      const roster = await binder.rosterForChannel(CH);
      expect(
        roster.find((entry) => entry.id === builtInAgentProfileId(providerId))
      ).toMatchObject({
        available: false,
        reason: `${command} is not installed on this node (not found on PATH).`,
      });
      expect(roster.find((entry) => entry.id === configured.id)).toMatchObject({
        available: true,
        reason: null,
      });
    }
  );

  it('turns a raced ENOENT spawn into an actionable system row', async () => {
    const spawnError = Object.assign(new Error('spawn prime-agent ENOENT'), {
      code: 'ENOENT',
    });
    const { binder, store } = makeBinder({
      build: () => new MockProtocolAdapterV2({ connectMs: 1, stepMs: 1 }),
      targets: [
        {
          id: 'prime-agent',
          displayName: 'Prime Agent',
          kind: 'framework',
          available: true,
          reason: null,
          command: 'prime-agent',
        },
      ],
      knownProviderIds: ['prime-agent'],
      createError: spawnError,
      processEnv: { PATH: '' },
    });

    let directError: unknown;
    try {
      await binder.ensureBinding(CH, 'prime-agent');
    } catch (error) {
      directError = error;
    }
    expect(directError).toBeInstanceOf(Error);
    expect((directError as Error).message).toContain(
      'configured command "prime-agent" is not available on this node'
    );
    expect((directError as Error).message).not.toContain('ENOENT');

    post(store, binder, '@prime-agent go', ['prime-agent']);
    await waitFor(() => systemRows(store).length > 0);

    const text = systemRows(store).at(-1)!.body.text;
    expect(text).toContain(
      'prime-agent is not installed on this node (not found on PATH)'
    );
    expect(text).not.toContain('ENOENT');
    expect(text).not.toContain('spawn prime-agent');
  });

  it('does not misdiagnose an ENOENT from a missing working directory as a missing command', async () => {
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-cwd-bin-'));
    fs.writeFileSync(path.join(binDir, 'prime-agent'), '#!/bin/sh\nexit 0\n', {
      mode: 0o755,
    });
    const spawnError = Object.assign(new Error('spawn prime-agent ENOENT'), {
      code: 'ENOENT',
    });
    const { binder } = makeBinder({
      build: () => new MockProtocolAdapterV2({ connectMs: 1, stepMs: 1 }),
      targets: [
        {
          id: 'prime-agent',
          displayName: 'Prime Agent',
          kind: 'framework',
          available: true,
          reason: null,
          command: 'prime-agent',
        },
      ],
      knownProviderIds: ['prime-agent'],
      createError: spawnError,
      processEnv: { PATH: binDir },
    });

    let error: unknown;
    try {
      await binder.ensureBinding(CH, 'prime-agent');
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(
      'The command "prime-agent" is installed; verify the channel repo/worktree path'
    );
    expect((error as Error).message).not.toContain(
      'configured command "prime-agent" is not available'
    );
  });

  it('discards an in-flight target probe when shutdown invalidates its generation', async () => {
    const stale: MentionTarget[] = [
      {
        id: 'stale',
        displayName: 'Stale',
        kind: 'framework',
        available: true,
        reason: null,
      },
    ];
    let resolveFirst: ((targets: MentionTarget[]) => void) | undefined;
    let calls = 0;
    const { binder } = makeBinder({
      build: () => new MockProtocolAdapterV2({ connectMs: 1, stepMs: 1 }),
      targets: [],
      mentionTargets: () => {
        calls += 1;
        if (calls === 1) {
          return new Promise<MentionTarget[]>((resolve) => {
            resolveFirst = resolve;
          });
        }
        throw new Error('closed binder must not start a fresh target probe');
      },
      knownProviderIds: ['stale'],
    });

    const firstRoster = binder.rosterForChannel(CH);
    const joinedRoster = binder.rosterForChannel(CH);
    await waitFor(() => calls === 1);
    binder.close();
    resolveFirst?.(stale);

    await expect(firstRoster).resolves.toEqual([]);
    await expect(joinedRoster).resolves.toEqual([]);
    expect(calls).toBe(1);
  });

  it('includes the default profile for an unseeded target provider without duplicating stored providers', async () => {
    const profiles = createAgentProfileStore(':memory:');
    cleanup.push(() => profiles.close());
    profiles.seedBuiltIns([{ id: 'mock' }]);
    const { binder } = makeBinder({
      build: () => new MockProtocolAdapterV2({ connectMs: 1, stepMs: 1 }),
      targets: [
        ...MOCK_TARGETS,
        {
          id: 'worker',
          displayName: 'Worker',
          kind: 'framework',
          available: true,
          reason: null,
        },
      ],
      knownProviderIds: ['mock', 'worker'],
      agentProfileStore: profiles,
    });

    const roster = await binder.rosterForChannel(CH);
    expect(roster.filter((entry) => entry.providerId === 'mock')).toHaveLength(
      1
    );
    expect(roster).toContainEqual(
      expect.objectContaining({
        id: builtInAgentProfileId('worker'),
        providerId: 'worker',
        isDefault: true,
      })
    );
  });

  it('surfaces bound session roles in the channel roster', async () => {
    const { binder, sessions } = makeBinder({
      build: () => new MockProtocolAdapterV2({ connectMs: 1, stepMs: 1 }),
      targets: [
        ...MOCK_TARGETS,
        {
          id: 'worker',
          displayName: 'Worker',
          kind: 'framework',
          available: true,
          reason: null,
        },
      ],
      knownProviderIds: ['mock', 'worker'],
    });

    await binder.ensureOrchestrator(CH, 'mock');
    await binder.ensureBinding(CH, 'worker');

    const roster = await binder.rosterForChannel(CH);
    expect(
      roster.find((entry) => entry.id === builtInAgentProfileId('mock'))?.role
    ).toBe('orchestrator');
    expect(
      roster.find((entry) => entry.id === builtInAgentProfileId('worker'))?.role
    ).toBeUndefined();
    expect(sessions.spawns()).toBe(2);
  });

  it('reports availability, reasons, and live binding status', async () => {
    const { binder, store } = makeBinder({
      build: () => new MockProtocolAdapterV2({ connectMs: 1, stepMs: 1 }),
      targets: [
        ...MOCK_TARGETS,
        {
          id: 'codex',
          displayName: 'Codex',
          kind: 'framework',
          available: false,
          reason: 'Codex is not currently available in channels.',
        },
      ],
      knownProviderIds: ['mock', 'codex'],
    });
    let roster = await binder.rosterForChannel(CH);
    const codex = roster.find((r) => r.id === builtInAgentProfileId('codex'))!;
    expect(codex.available).toBe(false);
    expect(codex.reason).toContain('not currently available in channels');
    expect(
      roster.find((r) => r.id === builtInAgentProfileId('mock'))!.binding
    ).toBeNull();

    post(store, binder, '@mock hi', ['mock', 'codex']);
    await waitFor(() => agentReplies(store, 'mock').length === 1);
    roster = await binder.rosterForChannel(CH);
    expect(
      roster.find((r) => r.id === builtInAgentProfileId('mock'))!.binding
    ).not.toBeNull();
    expect(
      roster.find((r) => r.id === builtInAgentProfileId('mock'))!.binding
        ?.status
    ).toBe('idle');
  });

  it('clears presence to idle when a turn finalizes with an idle live-state and no turn-completed (#1181)', async () => {
    const { binder, store } = makeBinder({
      build: (agentType) => new IdleWithoutTurnCompletedAdapter(agentType),
      targets: [
        {
          id: 'hermes',
          displayName: 'Hermes',
          kind: 'framework',
          available: true,
          reason: null,
        },
      ],
      knownProviderIds: ['hermes'],
    });
    const statuses: string[] = [];
    binder.setStatusBroadcaster((_type, data) => {
      if (data['agentId'] === builtInAgentProfileId('hermes'))
        statuses.push(String(data['status']));
    });
    post(store, binder, '@hermes hi', ['hermes']);
    // The turn must reach 'thinking' (proving it was delivered) and then settle
    // back to 'idle' — NOT wedge on 'thinking' — even though no
    // agent-turn-completed-v2 fired; the trailing idle live-state finalizes it.
    await waitFor(
      () => statuses.includes('thinking') && statuses.at(-1) === 'idle',
      3000
    );
    expect(statuses).toContain('thinking');
    expect(statuses.at(-1)).toBe('idle');
  });

  it('an unavailable named profile posts a de-advertise row, rate-limited', async () => {
    const profiles = createAgentProfileStore(':memory:');
    cleanup.push(() => profiles.close());
    profiles.seedBuiltIns([{ id: 'codex' }]);
    profiles.create({
      id: 'agent-profile:codex:backend-unavailable',
      providerId: 'codex',
      displayName: 'Backend',
    });
    const { binder, store, sessions } = makeBinder({
      build: () => new MockProtocolAdapterV2(),
      targets: [
        {
          id: 'codex',
          displayName: 'Codex',
          kind: 'framework',
          available: false,
          reason: 'Codex is not currently available in channels.',
        },
      ],
      knownProviderIds: ['codex'],
      agentProfileStore: profiles,
    });
    const root = store.appendComplete({
      channelId: CH,
      sender: OPERATOR,
      text: 'root',
    });
    const trigger = post(
      store,
      binder,
      '@Backend fix it',
      ['codex'],
      OPERATOR,
      root.id
    );
    await waitFor(() =>
      systemRows(store).some((m) =>
        m.body.text.includes('not currently available in channels')
      )
    );
    const secondTrigger = post(
      store,
      binder,
      '@Backend fix it again',
      ['codex'],
      OPERATOR,
      root.id
    );
    // brief settle
    await new Promise((r) => setTimeout(r, 40));
    expect(
      systemRows(store).filter((m) => m.body.text.includes('not available'))
    ).toHaveLength(2); // distinct trigger parents must not suppress each other
    const unavailable = systemRows(store).find(
      (m) =>
        m.body.text.includes('not available') &&
        m.parentMessageId === trigger.id
    )!;
    expect(unavailable.body.text).toBe(
      '@Backend is not available in channels yet — Codex is not currently available in channels.'
    );
    expect(unavailable.threadId).toBe(root.id);
    expect(unavailable.parentMessageId).toBe(trigger.id);
    expect(
      systemRows(store).some(
        (m) =>
          m.body.text.includes('not available') &&
          m.parentMessageId === secondTrigger.id
      )
    ).toBe(true);
    expect(sessions.spawns()).toBe(0);
  });
});

describe('channel-agent-binder — watchdog + cross-node + interrupt', () => {
  it('force-drains a stuck turn once the watchdog fires', async () => {
    const { binder, store, sessions } = makeBinder({
      build: () => new ScriptedAdapter('stall', { mode: 'stall' }),
      targets: [
        {
          id: 'stall',
          displayName: 'Stall',
          kind: 'framework',
          available: true,
          reason: null,
        },
      ],
      knownProviderIds: ['stall'],
      watchdogMs: 25,
    });
    post(store, binder, '@stall a', ['stall']);
    await waitFor(() => sessions.spawns() === 1);
    const adapter = sessions.adapterFor(
      sessions.firstSessionId()
    ) as ScriptedAdapter;
    await waitFor(() => adapter.sendCalls.length === 1);
    // Watchdog (25ms) force-drains the stuck turn → the next mention delivers.
    await new Promise((r) => setTimeout(r, 60));
    post(store, binder, '@stall b', ['stall']);
    await waitFor(() => adapter.sendCalls.length === 2, 4000);
    expect(adapter.sendCalls).toHaveLength(2);
  });

  it('never drains a turn that keeps emitting, however long it runs (#1541)', async () => {
    const { binder, store, hub, sessions } = makeBinder({
      build: (t) => new HeartbeatAdapter(t, 10),
      targets: MOCK_TARGETS,
      knownProviderIds: ['mock'],
      watchdogMs: 60,
    });
    const { run } = postWithAsyncRun(store, binder, '@mock long job', ['mock']);
    await waitFor(() => sessions.spawns() === 1);
    const adapter = sessions.adapterFor(
      sessions.firstSessionId()
    ) as HeartbeatAdapter;
    await waitFor(() => adapter.sendCalls.length === 1);
    // Four full inactivity windows of steady activity. The old wall-clock
    // watchdog force-drained this turn at the first one and flipped the run to
    // `failed` while the provider carried on working (#1541).
    await waitFor(() => adapter.beats >= 24, 4000);
    expect(
      collectReceipts(hub, CH).some((r) => r.state === 'expired_watchdog')
    ).toBe(false);
    expect(adapter.interruptCalls).toEqual([]);
    expect(store.getAsyncRun(run.id)?.targets[0]?.state).toBe('working');

    adapter.complete();
    await waitFor(() => store.getAsyncRun(run.id)?.state === 'completed', 4000);
    expect(store.getAsyncRun(run.id)).toMatchObject({
      state: 'completed',
      targets: [
        { targetId: builtInAgentProfileId('mock'), state: 'completed' },
      ],
    });
  });

  it('drains a SILENT turn with an interrupt and a system row (#1541)', async () => {
    const { binder, store, hub, sessions } = makeBinder({
      build: (t) => new ScriptedAdapter(t, { mode: 'stall' }),
      targets: MOCK_TARGETS,
      knownProviderIds: ['mock'],
      watchdogMs: 25,
    });
    const { run } = postWithAsyncRun(store, binder, '@mock stuck', ['mock']);
    await waitFor(() => sessions.spawns() === 1);
    const adapter = sessions.adapterFor(
      sessions.firstSessionId()
    ) as ScriptedAdapter;
    await waitFor(() => adapter.sendCalls.length === 1);
    await waitFor(
      () =>
        systemRows(store).some((m) => m.body.text.includes('force-drained')),
      4000
    );
    // The runtime is stopped, not abandoned: the drain interrupts the turn it
    // is about to call failed, so the run state cannot outrun the provider.
    expect(adapter.interruptCalls).toEqual([adapter.sendCalls[0]]);
    const drainRow = systemRows(store).find((m) =>
      m.body.text.includes('force-drained')
    )!;
    expect(drainRow.body.text).toContain('sent nothing for 25 ms');
    const wd = collectReceipts(hub, CH).find(
      (r) => r.state === 'expired_watchdog'
    )!;
    expect(wd.reasonCode).toBe('watchdog_force_drain');
    expect(store.getAsyncRun(run.id)?.targets[0]?.state).toBe('failed');
  });

  it('a stale patch from a FINISHED turn never extends a silent turn (#1541)', async () => {
    const { binder, store, hub, sessions } = makeBinder({
      build: (t) => new HeartbeatAdapter(t, 60_000), // never beats on its own
      targets: MOCK_TARGETS,
      knownProviderIds: ['mock'],
      watchdogMs: 60,
    });
    post(store, binder, '@mock first', ['mock']);
    await waitFor(() => sessions.spawns() === 1);
    const adapter = sessions.adapterFor(
      sessions.firstSessionId()
    ) as HeartbeatAdapter;
    await waitFor(() => adapter.sendCalls.length === 1);
    adapter.complete('first done');
    await waitFor(() => agentReplies(store, 'mock').length === 1);
    const finishedTurnId = adapter.sendCalls[0]!;

    // A second turn opens and then says nothing at all, while the runtime keeps
    // echoing the FINISHED turn (a real provider replays late items, and the
    // exact-turn tombstone keeps that id resolvable for a minute). Liveness on
    // a turn that already ended is not liveness on this one.
    post(store, binder, '@mock second', ['mock']);
    await waitFor(() => adapter.sendCalls.length === 2);
    const stale = setInterval(() => adapter.emitDeltaFor(finishedTurnId), 15);
    try {
      await waitFor(
        () =>
          systemRows(store).some((m) => m.body.text.includes('force-drained')),
        4000
      );
    } finally {
      clearInterval(stale);
    }
    // The drain hit the SILENT second turn, on schedule.
    expect(adapter.interruptCalls).toEqual([adapter.sendCalls[1]]);
    expect(
      collectReceipts(hub, CH).some((r) => r.state === 'expired_watchdog')
    ).toBe(true);
  });

  it('interrupts a busy turn that reaches the hard ceiling (#1541)', async () => {
    const { binder, store, hub, sessions } = makeBinder({
      build: (t) => new HeartbeatAdapter(t, 5),
      targets: MOCK_TARGETS,
      knownProviderIds: ['mock'],
      // The turn never goes quiet, so the inactivity watchdog never fires: the
      // ceiling is the only bound left, which is exactly why it exists.
      watchdogMs: 10_000,
      turnCeilingMs: 60,
    });
    const { run } = postWithAsyncRun(store, binder, '@mock forever', ['mock']);
    await waitFor(() => sessions.spawns() === 1);
    const adapter = sessions.adapterFor(
      sessions.firstSessionId()
    ) as HeartbeatAdapter;
    await waitFor(() => adapter.sendCalls.length === 1);
    await waitFor(
      () => systemRows(store).some((m) => m.body.text.includes('turn limit')),
      4000
    );
    expect(adapter.interruptCalls).toEqual([adapter.sendCalls[0]]);
    const ceiling = collectReceipts(hub, CH).find(
      (r) => r.reasonCode === 'turn_ceiling'
    )!;
    expect(ceiling.state).toBe('expired_watchdog');
    // Relay cancelled this turn; the provider did not fail it.
    expect(store.getAsyncRun(run.id)?.targets[0]?.state).toBe('cancelled');
    adapter.complete(); // stop the heartbeat
  });

  it('never drains a turn sitting inside an OPEN tool call (#1548)', async () => {
    const { binder, store, hub, sessions } = makeBinder({
      build: (t) => new HeartbeatAdapter(t, 60_000), // never beats on its own
      targets: MOCK_TARGETS,
      knownProviderIds: ['mock'],
      watchdogMs: 40,
    });
    const { run } = postWithAsyncRun(store, binder, '@mock check', ['mock']);
    await waitFor(() => sessions.spawns() === 1);
    const adapter = sessions.adapterFor(
      sessions.firstSessionId()
    ) as HeartbeatAdapter;
    await waitFor(() => adapter.sendCalls.length === 1);

    // One long command: the tool item opens and the runtime says NOTHING for
    // three full inactivity windows, which is exactly what `npm run check`
    // looks like on the wire.
    adapter.startTool();
    await new Promise((r) => setTimeout(r, 40 * 3 + 40));
    expect(
      systemRows(store).some((m) => m.body.text.includes('force-drained'))
    ).toBe(false);
    expect(
      collectReceipts(hub, CH).some((r) => r.state === 'expired_watchdog')
    ).toBe(false);
    expect(adapter.interruptCalls).toEqual([]);
    expect(store.getAsyncRun(run.id)?.targets[0]?.state).toBe('working');

    adapter.finishTool();
    adapter.complete('check passed');
    await waitFor(() => store.getAsyncRun(run.id)?.state === 'completed', 4000);
    expect(store.getAsyncRun(run.id)?.targets[0]?.state).toBe('completed');
  });

  it('an open tool call still hits the hard ceiling (#1548)', async () => {
    const { binder, store, hub, sessions } = makeBinder({
      build: (t) => new HeartbeatAdapter(t, 60_000),
      targets: MOCK_TARGETS,
      knownProviderIds: ['mock'],
      // The open tool call disarms the inactivity drain entirely, so the
      // ceiling is the only bound left — which is the point of having one.
      watchdogMs: 10_000,
      turnCeilingMs: 60,
    });
    const { run } = postWithAsyncRun(store, binder, '@mock forever', ['mock']);
    await waitFor(() => sessions.spawns() === 1);
    const adapter = sessions.adapterFor(
      sessions.firstSessionId()
    ) as HeartbeatAdapter;
    await waitFor(() => adapter.sendCalls.length === 1);
    adapter.startTool('tool-forever', 'sleep infinity');
    await waitFor(
      () => systemRows(store).some((m) => m.body.text.includes('turn limit')),
      4000
    );
    expect(adapter.interruptCalls).toEqual([adapter.sendCalls[0]]);
    const ceiling = collectReceipts(hub, CH).find(
      (r) => r.reasonCode === 'turn_ceiling'
    )!;
    expect(ceiling.state).toBe('expired_watchdog');
    expect(store.getAsyncRun(run.id)?.targets[0]?.state).toBe('cancelled');
  });

  it('drops open tool calls when the binding rebinds to a new runtime (#1548)', async () => {
    let spawnNumber = 0;
    let firstAdapter: DeferredAdapter | null = null;
    let secondAdapter: HeartbeatAdapter | null = null;
    const { binder, store, hub, sessions } = makeBinder({
      build: (agentType) => {
        spawnNumber++;
        if (spawnNumber === 1) {
          firstAdapter = new DeferredAdapter(agentType);
          return firstAdapter;
        }
        // Silent replacement: whatever bounds this turn now, it is not activity.
        secondAdapter = new HeartbeatAdapter(agentType, 60_000);
        return secondAdapter;
      },
      targets: MOCK_TARGETS,
      knownProviderIds: ['mock'],
      watchdogMs: 40,
    });
    post(store, binder, '@mock retry', ['mock']);
    await waitFor(
      () => firstAdapter !== null && firstAdapter.sendCalls.length === 1
    );
    const turnId = firstAdapter!.sendCalls[0]!;

    // The dying runtime got as far as opening a tool call. Its replacement will
    // never emit a terminal update for that item — different runtime, different
    // item ids — so a carried-over entry would hold the watchdog off forever.
    firstAdapter!.openTool(turnId);
    sessions.forgetWithoutEnd(sessions.firstSessionId());
    firstAdapter!.rejectSend(turnId);
    await waitFor(() => secondAdapter !== null && sessions.spawns() === 2);

    // The rebound runtime says nothing at all: the idle drain must fire on
    // schedule rather than deferring to the dead runtime's ghost tool call.
    await waitFor(
      () =>
        systemRows(store).some((m) => m.body.text.includes('force-drained')),
      4000
    );
    expect(
      collectReceipts(hub, CH).some((r) => r.state === 'expired_watchdog')
    ).toBe(true);
  });

  it('an idle live-state heartbeat never refreshes a silent turn (#1548)', async () => {
    const { binder, store, hub, sessions } = makeBinder({
      build: (t) => new HeartbeatAdapter(t, 60_000),
      targets: MOCK_TARGETS,
      knownProviderIds: ['mock'],
      watchdogMs: 60,
    });
    postWithAsyncRun(store, binder, '@mock quiet', ['mock']);
    await waitFor(() => sessions.spawns() === 1);
    const adapter = sessions.adapterFor(
      sessions.firstSessionId()
    ) as HeartbeatAdapter;
    await waitFor(() => adapter.sendCalls.length === 1);

    // A wedged runtime pinging "no turn in flight" is the opposite of liveness
    // on the turn being bounded, so it must not buy the turn another window.
    const ping = setInterval(() => adapter.emitIdleHeartbeat(), 15);
    try {
      await waitFor(
        () =>
          systemRows(store).some((m) => m.body.text.includes('force-drained')),
        4000
      );
    } finally {
      clearInterval(ping);
    }
    expect(adapter.interruptCalls).toEqual([adapter.sendCalls[0]]);
    expect(
      collectReceipts(hub, CH).some((r) => r.state === 'expired_watchdog')
    ).toBe(true);
  });

  it('a stale-turn terminal tool delta never closes the ACTIVE turn tool (#1548)', async () => {
    const { binder, store, sessions } = makeBinder({
      build: (t) => new HeartbeatAdapter(t, 60_000),
      targets: MOCK_TARGETS,
      knownProviderIds: ['mock'],
      watchdogMs: 40,
    });
    post(store, binder, '@mock first', ['mock']);
    await waitFor(() => sessions.spawns() === 1);
    const adapter = sessions.adapterFor(
      sessions.firstSessionId()
    ) as HeartbeatAdapter;
    await waitFor(() => adapter.sendCalls.length === 1);
    adapter.complete('first done');
    await waitFor(() => agentReplies(store, 'mock').length === 1);
    const finishedTurnId = adapter.sendCalls[0]!;

    post(store, binder, '@mock second', ['mock']);
    await waitFor(() => adapter.sendCalls.length === 2);
    adapter.startTool();

    // The finished turn replays a terminal delta for the SAME item id (a real
    // provider replays late items, and the exact-turn tombstone keeps that id
    // resolvable). It must not close the live turn's tool call — nor drain it.
    const stale = setInterval(
      () => adapter.emitToolTerminalDeltaFor(finishedTurnId),
      15
    );
    try {
      await new Promise((r) => setTimeout(r, 40 * 3 + 40));
      expect(
        systemRows(store).some((m) => m.body.text.includes('force-drained'))
      ).toBe(false);
    } finally {
      clearInterval(stale);
    }

    // Closing it on the ACTIVE turn does restart the budget, and the drain then
    // fires — proving the tool was still open the whole time.
    adapter.finishTool();
    await waitFor(
      () =>
        systemRows(store).some((m) => m.body.text.includes('force-drained')),
      4000
    );
  });

  it('restarts the idle window when the last tool call closes (#1548)', async () => {
    const { binder, store, hub, sessions } = makeBinder({
      build: (t) => new HeartbeatAdapter(t, 60_000),
      targets: MOCK_TARGETS,
      knownProviderIds: ['mock'],
      watchdogMs: 60,
    });
    postWithAsyncRun(store, binder, '@mock check', ['mock']);
    await waitFor(() => sessions.spawns() === 1);
    const adapter = sessions.adapterFor(
      sessions.firstSessionId()
    ) as HeartbeatAdapter;
    await waitFor(() => adapter.sendCalls.length === 1);
    adapter.startTool();
    await new Promise((r) => setTimeout(r, 150));
    expect(
      systemRows(store).some((m) => m.body.text.includes('force-drained'))
    ).toBe(false);

    // The tool ends and the runtime then wedges: the silence budget restarts
    // from the completion, and a full window later the drain fires.
    adapter.finishTool();
    const closedAt = Date.now();
    await waitFor(
      () =>
        systemRows(store).some((m) => m.body.text.includes('force-drained')),
      4000
    );
    expect(Date.now() - closedAt).toBeGreaterThanOrEqual(45);
    expect(adapter.interruptCalls).toEqual([adapter.sendCalls[0]]);
    expect(
      collectReceipts(hub, CH).some((r) => r.state === 'expired_watchdog')
    ).toBe(true);
  });

  it('cross-node topics fail visibly and never spawn a local stand-in', async () => {
    const topicStore = {
      get: () => ({
        id: CH,
        source: 'persisted',
        display: { title: 'general' },
        routingDefaults: { nodeId: 'remote-node' },
      }),
    } as unknown as WorkspaceTopicStore;
    const { binder, store, sessions } = makeBinder({
      build: () => new MockProtocolAdapterV2(),
      targets: MOCK_TARGETS,
      knownProviderIds: ['mock'],
      topicStore,
    });
    post(store, binder, '@mock go', ['mock']);
    await waitFor(() =>
      systemRows(store).some((m) => m.body.text.includes('other nodes'))
    );
    expect(sessions.spawns()).toBe(0);
  });

  it('interrupt finalizes the partial row as interrupted (bridge status-map fix)', async () => {
    const { binder, store } = makeBinder({
      build: () => new MockProtocolAdapterV2({ connectMs: 1, stepMs: 60 }),
      targets: MOCK_TARGETS,
      knownProviderIds: ['mock'],
    });
    post(store, binder, '@mock slow please', ['mock']);
    await waitFor(() =>
      rows(store).some(
        (m) => m.sender.providerId === 'mock' && m.status === 'streaming'
      )
    );
    await binder.interrupt(CH, 'mock');
    await waitFor(() =>
      rows(store).some(
        (m) => m.sender.providerId === 'mock' && m.status === 'interrupted'
      )
    );
    expect(
      rows(store).some(
        (m) => m.sender.providerId === 'mock' && m.status === 'interrupted'
      )
    ).toBe(true);
  });

  it('interrupt throws NO_ACTIVE_TURN when idle and NOT_FOUND when unbound', async () => {
    const { binder, store } = makeBinder({
      build: () => new MockProtocolAdapterV2({ connectMs: 1, stepMs: 1 }),
      targets: MOCK_TARGETS,
      knownProviderIds: ['mock'],
    });
    await expect(binder.interrupt(CH, 'mock')).rejects.toThrow(); // not bound
    post(store, binder, '@mock hi', ['mock']);
    await waitFor(() => agentReplies(store, 'mock').length === 1);
    await expect(binder.interrupt(CH, 'mock')).rejects.toThrow(); // idle
  });

  it('interrupts only the selected thread runtime for a shared profile', async () => {
    const { binder, store, sessions } = makeBinder({
      build: () => new MockProtocolAdapterV2({ connectMs: 1, stepMs: 80 }),
      targets: MOCK_TARGETS,
      knownProviderIds: ['mock'],
    });
    const first = store.appendComplete({
      channelId: CH,
      sender: OPERATOR,
      text: 'first root',
    });
    const second = store.appendComplete({
      channelId: CH,
      sender: OPERATOR,
      text: 'second root',
    });
    post(store, binder, '@mock first', ['mock'], OPERATOR, first.id);
    post(store, binder, '@mock second', ['mock'], OPERATOR, second.id);
    await waitFor(
      () =>
        rows(store).filter(
          (message) =>
            message.sender.providerId === 'mock' &&
            message.status === 'streaming'
        ).length >= 2
    );
    expect(sessions.spawns()).toBe(2);

    await binder.interrupt(CH, 'mock', first.id);
    await waitFor(() =>
      rows(store).some(
        (message) =>
          message.sender.providerId === 'mock' &&
          message.threadId === first.id &&
          message.status === 'interrupted'
      )
    );
    expect(
      rows(store).some(
        (message) =>
          message.sender.providerId === 'mock' &&
          message.threadId === second.id &&
          message.status === 'interrupted'
      )
    ).toBe(false);
  });
});

// ── #1180 review findings ─────────────────────────────────────────────────────

describe('channel-agent-binder — gateway agent-sender loop brake (P1 #1180)', () => {
  it('does not route a provider-default gateway self mention', async () => {
    const { binder, store, sessions } = makeBinder({
      build: () => new MockProtocolAdapterV2({ connectMs: 1, stepMs: 1 }),
      targets: [
        {
          id: 'claude',
          displayName: 'Claude',
          kind: 'framework',
          available: true,
          reason: null,
        },
      ],
      knownProviderIds: ['claude'],
    });

    const gatewayPost = post(store, binder, '@claude', ['claude'], {
      kind: 'agent',
      id: 'agent:claude',
      providerId: 'claude',
      displayName: 'Claude',
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sessions.spawns()).toBe(0);
    expect(
      agentReplies(store, 'claude').filter(
        (message) => message.id !== gatewayPost.id
      )
    ).toHaveLength(0);
  });

  it('agent-sender posts count toward the cap and pause; a human post resets', async () => {
    const { binder, store } = makeBinder({
      build: () => new MockProtocolAdapterV2({ connectMs: 1, stepMs: 1 }),
      targets: MOCK_TARGETS,
      knownProviderIds: ['mock'],
    });
    // MAX+1 gateway agent-sender posts: MAX route, the last one pauses. The mock
    // reply carries no @mention, so ONLY the gateway posts move the counter.
    for (let i = 0; i < MAX_CONSECUTIVE_AGENT_TURNS + 1; i++) {
      post(store, binder, `@mock ${i}`, ['mock'], AGENT_SENDER);
    }
    await waitFor(() =>
      systemRows(store).some((m) =>
        m.body.text.includes('Mention chain paused')
      )
    );
    await waitFor(
      () => agentReplies(store, 'mock').length === MAX_CONSECUTIVE_AGENT_TURNS
    );
    await new Promise((r) => setTimeout(r, 40)); // settle: no capped turn slips
    expect(agentReplies(store, 'mock')).toHaveLength(
      MAX_CONSECUTIVE_AGENT_TURNS
    );
    expect(
      systemRows(store).filter((m) =>
        m.body.text.includes('Mention chain paused')
      )
    ).toHaveLength(1);

    // A fresh HUMAN post resets the brake → the chain resumes.
    const before = agentReplies(store, 'mock').length;
    post(store, binder, '@mock human', ['mock'], OPERATOR);
    await waitFor(() => agentReplies(store, 'mock').length === before + 1);
    expect(agentReplies(store, 'mock').length).toBe(before + 1);
  });

  it('a mixed human/agent chain only brakes on consecutive agent turns', async () => {
    const { binder, store } = makeBinder({
      build: () => new MockProtocolAdapterV2({ connectMs: 1, stepMs: 1 }),
      targets: MOCK_TARGETS,
      knownProviderIds: ['mock'],
    });
    // Two agent posts (counter 1,2), then a human post resets, then two more
    // agent posts (counter 1,2) — never reaches the cap, so no pause row.
    post(store, binder, '@mock a1', ['mock'], AGENT_SENDER);
    post(store, binder, '@mock a2', ['mock'], AGENT_SENDER);
    post(store, binder, '@mock h1', ['mock'], OPERATOR);
    post(store, binder, '@mock a3', ['mock'], AGENT_SENDER);
    post(store, binder, '@mock a4', ['mock'], AGENT_SENDER);
    await waitFor(() => agentReplies(store, 'mock').length === 5);
    await new Promise((r) => setTimeout(r, 40));
    expect(agentReplies(store, 'mock')).toHaveLength(5);
    expect(
      systemRows(store).filter((m) =>
        m.body.text.includes('Mention chain paused')
      )
    ).toHaveLength(0);
  });
});

describe('channel-agent-binder — buildPacket failure recovery (P2 #1180)', () => {
  it('a store mention-context throw does not wedge the binding; the next mention routes', async () => {
    const { binder, store, sessions } = makeBinder({
      build: () => new MockProtocolAdapterV2({ connectMs: 1, stepMs: 1 }),
      targets: MOCK_TARGETS,
      knownProviderIds: ['mock'],
    });
    const realMentionContext = store.mentionContext.bind(store);
    let thrown = false;
    store.mentionContext = (input) => {
      if (!thrown) {
        thrown = true;
        throw new Error('db boom');
      }
      return realMentionContext(input);
    };

    post(store, binder, '@mock one', ['mock']);
    await waitFor(() =>
      systemRows(store).some((m) =>
        m.body.text.includes('could not build the message context')
      )
    );
    post(store, binder, '@mock two', ['mock']);
    await waitFor(() => agentReplies(store, 'mock').length === 1);
    expect(sessions.spawns()).toBe(1);
    expect(agentReplies(store, 'mock')).toHaveLength(1);
  });

  it('a threaded mention-context throw does not wedge the binding; the next mention routes', async () => {
    const { binder, store, sessions } = makeBinder({
      build: () => new MockProtocolAdapterV2({ connectMs: 1, stepMs: 1 }),
      targets: MOCK_TARGETS,
      knownProviderIds: ['mock'],
    });
    const realMentionContext = store.mentionContext.bind(store);
    let thrown = false;
    store.mentionContext = (input) => {
      if (!thrown && input.threadRootId !== null) {
        thrown = true;
        throw new Error('db boom');
      }
      return realMentionContext(input);
    };

    const root = store.appendComplete({
      channelId: CH,
      sender: OPERATOR,
      text: 'root',
    });
    const failedTrigger = post(
      store,
      binder,
      '@mock one',
      ['mock'],
      OPERATOR,
      root.id
    );
    await waitFor(() =>
      systemRows(store).some((m) =>
        m.body.text.includes('could not build the message context')
      )
    );
    const failure = systemRows(store).find((m) =>
      m.body.text.includes('could not build the message context')
    )!;
    expect(failure.threadId).toBe(root.id);
    expect(failure.parentMessageId).toBe(failedTrigger.id);
    // Binding recovered (not stuck turn-active): the next mention delivers.
    post(store, binder, '@mock two', ['mock'], OPERATOR, root.id);
    await waitFor(() => agentReplies(store, 'mock').length === 1);
    expect(sessions.spawns()).toBe(1); // reused, not respawned/wedged
    expect(agentReplies(store, 'mock')).toHaveLength(1);
  });
});

describe('channel-agent-binder — send-failure rebind clobber guard (P2 #1180)', () => {
  it('re-enqueues the failed turn instead of clobbering a newer active turn', async () => {
    const built: DeferredAdapter[] = [];
    const { binder, store, sessions } = makeBinder({
      build: (t) => {
        const a = new DeferredAdapter(t);
        built.push(a);
        return a;
      },
      targets: MOCK_TARGETS,
      knownProviderIds: ['mock'],
    });
    // M1 → session 1, turn T1 delivered, send parked (pending).
    const m1 = post(store, binder, '@mock one', ['mock']);
    await waitFor(() => built.length === 1 && built[0]!.sendCalls.length === 1);
    const a1 = built[0]!;
    const t1 = `chturn-${m1.id}-${builtInAgentProfileId('mock')}`;
    expect(a1.sendCalls).toEqual([t1]);
    const sid1 = sessions.firstSessionId();

    // Session dies → binder clears the live entry (activeTurnId reset, row null).
    sessions.fireEnd(sid1);

    // M2 → fresh session 2, turn T2 delivered, send parked.
    const m2 = post(store, binder, '@mock two', ['mock']);
    await waitFor(() => built.length === 2 && built[1]!.sendCalls.length === 1);
    const a2 = built[1]!;
    const t2 = `chturn-${m2.id}-${builtInAgentProfileId('mock')}`;
    expect(a2.sendCalls).toEqual([t2]);

    // Reject T1's original send: handleSendFailure rebinds → binding with T2
    // active. The failed turn must NOT clobber T2 with a concurrent send.
    a1.rejectSend(t1);
    await new Promise((r) => setTimeout(r, 40));
    expect(a2.sendCalls).toEqual([t2]); // T1 re-enqueued, not redelivered

    // T2 completes → the re-enqueued T1 drains to the SAME (live) session.
    a2.completeReply(t2, 'reply two');
    await waitFor(() => a2.sendCalls.length === 2, 4000);
    expect(a2.sendCalls[1]).toBe(t1);
    a2.completeReply(t1, 'reply one');
    await waitFor(() => agentReplies(store, 'mock').length === 2, 4000);
  });
});

describe('channel-agent-binder — close() gates in-flight spawns (P2 #1180)', () => {
  it('close() racing an in-flight ensureBinding leaves no binding and no store write', async () => {
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const { binder, store, sessions } = makeBinder({
      build: () => new MockProtocolAdapterV2({ connectMs: 1, stepMs: 1 }),
      targets: MOCK_TARGETS,
      knownProviderIds: ['mock'],
      gate,
    });
    const pending = binder.ensureBinding(CH, 'mock');
    await waitFor(() => sessions.spawns() === 1); // runtime creation parked at the gate
    binder.close();
    releaseGate(); // spawn resolves AFTER close
    await expect(pending).rejects.toThrow(); // BinderClosedError — no attach
    expect(
      store.getBinding(CH, builtInAgentProfileId('mock'))?.runtimeId ?? null
    ).toBeNull();
    expect(systemRows(store)).toHaveLength(0); // no post-close store writes
  });
});

describe('channel-agent-binder — YOLO spawn permission mode (locked decision #1167)', () => {
  it('binder spawns pass permissionMode bypassPermissions when the yolo default is on', async () => {
    const { binder, store, sessions } = makeBinder({
      build: () => new MockProtocolAdapterV2({ connectMs: 1, stepMs: 1 }),
      targets: MOCK_TARGETS,
      knownProviderIds: ['mock'],
      // yolo omitted → defaults to CHANNEL_BINDING_YOLO_DEFAULT.
    });
    post(store, binder, '@mock hi', ['mock']);
    await waitFor(() => sessions.spawns() === 1);
    expect(CHANNEL_BINDING_YOLO_DEFAULT).toBe(true);
    expect(sessions.lastCreateParams()?.permissionMode).toBe(
      'bypassPermissions'
    );
  });

  it('binder spawns omit permissionMode when yolo is disabled (framework default)', async () => {
    const { binder, store, sessions } = makeBinder({
      build: () => new MockProtocolAdapterV2({ connectMs: 1, stepMs: 1 }),
      targets: MOCK_TARGETS,
      knownProviderIds: ['mock'],
      yolo: false,
    });
    post(store, binder, '@mock hi', ['mock']);
    await waitFor(() => sessions.spawns() === 1);
    expect(sessions.lastCreateParams()).toBeDefined();
    expect(sessions.lastCreateParams()!.permissionMode).toBeUndefined();
  });
});

describe('channel-agent-binder — approval round-trip + watchdog pause (Amendment 2 #1180)', () => {
  it('approval item posts a meta-tagged system row; the respond verb maps the decision and resolves', async () => {
    const built: ApprovalAdapter[] = [];
    const { binder, store, sessions } = makeBinder({
      build: (t) => {
        const a = new ApprovalAdapter(t);
        built.push(a);
        return a;
      },
      targets: MOCK_TARGETS,
      knownProviderIds: ['mock'],
    });
    const root = store.appendComplete({
      channelId: CH,
      sender: OPERATOR,
      text: 'root',
    });
    const trigger = post(
      store,
      binder,
      '@mock please approve',
      ['mock'],
      OPERATOR,
      root.id
    );
    await waitFor(() =>
      systemRows(store).some((m) => m.body.text.includes('requests approval'))
    );
    const turnId = `chturn-${trigger.id}-${builtInAgentProfileId('mock')}`;
    const requestId = `appr-${turnId}`;
    const approvalRow = systemRows(store).find((m) =>
      m.body.text.includes('requests approval')
    )!;
    expect(approvalRow.meta).toMatchObject({
      approvalRequestId: requestId,
      agentId: builtInAgentProfileId('mock'),
    });
    expect(approvalRow.meta?.['runtimeId']).toBe(sessions.firstSessionId());
    expect(approvalRow.threadId).toBe(root.id);
    expect(approvalRow.parentMessageId).toBe(trigger.id);

    const a = built[0]!;
    await binder.respondToApproval(
      CH,
      'mock',
      requestId,
      { kind: 'accept' },
      root.id
    );
    // Adapter received the mapped decision.
    expect(a.respondCalls).toHaveLength(1);
    expect(a.respondCalls[0]).toMatchObject({
      requestId,
      decision: { kind: 'accept' },
    });
    // Row updated (resolved-approval system row) + the streamed reply.
    await waitFor(() =>
      systemRows(store).some((m) => m.body.text.includes('approval accept'))
    );
    const resolvedRow = systemRows(store).find((m) =>
      m.body.text.includes('approval accept')
    )!;
    expect(resolvedRow.threadId).toBe(root.id);
    expect(resolvedRow.parentMessageId).toBe(trigger.id);
    await waitFor(() => agentReplies(store, 'mock').length === 1);
    expect(agentReplies(store, 'mock')[0]!.body.text).toBe('approved and done');
  });

  it('the watchdog is PAUSED while waitingOn is set (turn not force-drained) and resumes on approval', async () => {
    const built: ApprovalAdapter[] = [];
    const { binder, store, hub } = makeBinder({
      build: (t) => {
        const a = new ApprovalAdapter(t);
        built.push(a);
        return a;
      },
      targets: MOCK_TARGETS,
      knownProviderIds: ['mock'],
      watchdogMs: 25,
    });
    const t1msg = post(store, binder, '@mock approve one', ['mock']);
    await waitFor(() => built.length === 1 && built[0]!.sendCalls.length === 1);
    const a = built[0]!;
    await waitFor(() =>
      systemRows(store).some((m) => m.body.text.includes('requests approval'))
    );
    post(store, binder, '@mock two', ['mock']); // queues behind the parked turn
    // Well past the 25ms watchdog: a fired watchdog would finishTurn → pump → T2.
    await new Promise((r) => setTimeout(r, 90));
    expect(a.sendCalls).toHaveLength(1); // PAUSED: T2 not pumped
    // A pause, not a quiet drain (#1541): no watchdog receipt, no drain row,
    // and the parked turn was never interrupted out from under the approval.
    expect(
      collectReceipts(hub, CH).some((r) => r.state === 'expired_watchdog')
    ).toBe(false);
    expect(
      systemRows(store).some((m) => m.body.text.includes('force-drained'))
    ).toBe(false);
    expect(a.interruptCalls).toEqual([]);

    const requestId = `appr-chturn-${t1msg.id}-${builtInAgentProfileId('mock')}`;
    await binder.respondToApproval(CH, 'mock', requestId, { kind: 'accept' });
    await waitFor(() => a.sendCalls.length === 2, 4000); // resumes → T2 drains
    expect(a.sendCalls).toHaveLength(2);
  });

  it('an approval that never resolves is still recoverable via interrupt', async () => {
    const built: ApprovalAdapter[] = [];
    const { binder, store } = makeBinder({
      build: (t) => {
        const a = new ApprovalAdapter(t);
        built.push(a);
        return a;
      },
      targets: MOCK_TARGETS,
      knownProviderIds: ['mock'],
      watchdogMs: 10_000, // watchdog never fires in-window: recovery is via interrupt
    });
    post(store, binder, '@mock approve stuck', ['mock']);
    await waitFor(() => built.length === 1 && built[0]!.sendCalls.length === 1);
    const a = built[0]!;
    await waitFor(() =>
      systemRows(store).some((m) => m.body.text.includes('requests approval'))
    );
    post(store, binder, '@mock next', ['mock']); // queues behind the stuck turn
    await new Promise((r) => setTimeout(r, 30));
    expect(a.sendCalls).toHaveLength(1);

    await binder.interrupt(CH, 'mock'); // operator recovery
    await waitFor(() => a.sendCalls.length === 2, 4000); // parked turn drained
    expect(a.interruptCalls).toHaveLength(1);
    expect(a.sendCalls).toHaveLength(2);
  });

  it('the trailing idle live-state during an approval never finalizes the turn (#1181 re-review)', async () => {
    const built: ApprovalAdapter[] = [];
    const { binder, store } = makeBinder({
      build: (t) => {
        const a = new ApprovalAdapter(t);
        built.push(a);
        return a;
      },
      targets: MOCK_TARGETS,
      knownProviderIds: ['mock'],
      watchdogMs: 25,
    });
    const t1 = post(store, binder, '@mock please approve', ['mock']);
    await waitFor(() => built.length === 1 && built[0]!.sendCalls.length === 1);
    const a = built[0]!;
    await waitFor(() =>
      systemRows(store).some((m) => m.body.text.includes('requests approval'))
    );
    // Queue a second turn behind the parked (approval-pending) turn.
    post(store, binder, '@mock two', ['mock']);

    // Well past the 25ms watchdog: the trailing bare `idle` live-state must NOT
    // have finalized the turn (which would pump T2) nor re-armed the watchdog
    // (which would force-drain the parked turn and pump T2). Without the guard
    // this is where the concurrent turn leaks.
    await new Promise((r) => setTimeout(r, 90));
    expect(a.sendCalls).toHaveLength(1); // T2 NOT pumped — turn stayed parked
    // Presence stayed 'waiting' — never flipped to idle/thinking mid-approval.
    expect(
      (await binder.rosterForChannel(CH)).find(
        (r) => r.id === builtInAgentProfileId('mock')
      )!.binding?.status
    ).toBe('waiting');

    // Resolving the approval resumes the turn: it completes normally, then T2 drains.
    const requestId = `appr-chturn-${t1.id}-${builtInAgentProfileId('mock')}`;
    await binder.respondToApproval(CH, 'mock', requestId, { kind: 'accept' });
    await waitFor(() => agentReplies(store, 'mock').length === 1, 4000);
    expect(agentReplies(store, 'mock')[0]!.body.text).toBe('approved and done');
    await waitFor(() => a.sendCalls.length === 2, 4000); // queued turn drained
    expect(a.sendCalls).toHaveLength(2);
  });
});

// ── #1287: channels state their participants instead of being guessed ────────

describe('channel-agent-binder — topic participant links', () => {
  function makeTopicStore(): WorkspaceTopicStore {
    const topicStore = createWorkspaceTopicStore({ dbPath: ':memory:' });
    cleanup.push(() => topicStore.close());
    return topicStore;
  }

  it('links its spawned runtime into the topic and never relinks on reuse', async () => {
    const topicStore = makeTopicStore();
    topicStore.create({
      id: CH,
      workspaceId: 'ws:local',
      title: 'general',
      routingDefaults: { repoPath: '/repo/relay', cwd: '/repo/relay' },
    });
    const { binder, store, sessions } = makeBinder({
      build: () => new MockProtocolAdapterV2({ connectMs: 1, stepMs: 1 }),
      targets: MOCK_TARGETS,
      knownProviderIds: ['mock'],
      topicStore,
    });

    post(store, binder, '@mock hi', ['mock']);
    await waitFor(() => agentReplies(store, 'mock').length === 1);
    const runtimeId = sessions.firstSessionId();
    const linked = topicStore.get(CH)!;
    expect(linked.linkedRefs.agentRuntimeIds).toEqual([runtimeId]);
    // The runtime is NOT a Relay session and must never be filed as one.
    expect(linked.linkedRefs.sessionIds).toBeUndefined();

    // Reuse: same runtime, so the topic keeps one entry and takes no write.
    post(store, binder, '@mock again', ['mock']);
    await waitFor(() => agentReplies(store, 'mock').length === 2);
    expect(sessions.spawns()).toBe(1);
    expect(topicStore.get(CH)?.linkedRefs.agentRuntimeIds).toEqual([runtimeId]);
    expect(topicStore.get(CH)?.updatedAt).toBe(linked.updatedAt);
  });

  it('links on reuse when the topic row only appears after the bind', async () => {
    const topicStore = makeTopicStore();
    const { binder, store, sessions } = makeBinder({
      build: () => new MockProtocolAdapterV2({ connectMs: 1, stepMs: 1 }),
      targets: MOCK_TARGETS,
      knownProviderIds: ['mock'],
      topicStore,
    });

    post(store, binder, '@mock hi', ['mock']);
    await waitFor(() => agentReplies(store, 'mock').length === 1);
    expect(topicStore.get(CH)).toBeNull();

    topicStore.create({ id: CH, workspaceId: 'ws:local', title: 'general' });
    post(store, binder, '@mock again', ['mock']);
    await waitFor(() => agentReplies(store, 'mock').length === 2);
    expect(sessions.spawns()).toBe(1);
    expect(topicStore.get(CH)?.linkedRefs.agentRuntimeIds).toEqual([
      sessions.firstSessionId(),
    ]);
  });
});

// ── #1166 routing half: a DM is "a channel with one agent", so addressing the
// channel IS the mention. Before this lane a DM message with no literal @name
// resolved zero profiles and returned with zero rows and zero logs — the agent
// never heard you and nothing said so.

describe('channel-agent-binder — DM implicit routing', () => {
  const DM_WORKSPACE = 'ws:local';
  const DM_CH = dmChannelTopicId('hermes', DM_WORKSPACE);
  const HERMES_TARGETS: MentionTarget[] = [
    {
      id: 'hermes',
      displayName: 'Hermes',
      kind: 'framework',
      available: true,
      reason: null,
    },
  ];
  /** A bound hermes reply posting back into its own DM (self-trigger bait). */
  const HERMES_AGENT_SENDER: ChannelSenderRef = {
    kind: 'agent',
    id: builtInAgentProfileId('hermes'),
    providerId: 'hermes',
    displayName: 'Hermes',
  };

  function makeTopics(): WorkspaceTopicStore {
    const topics = createWorkspaceTopicStore({ dbPath: ':memory:' });
    cleanup.push(() => topics.close());
    return topics;
  }

  function createDmTopic(topics: WorkspaceTopicStore): void {
    topics.create(
      dmChannelCreateInput({
        providerId: 'hermes',
        providerDisplayName: 'Hermes',
        workspaceId: DM_WORKSPACE,
      })
    );
  }

  function postTo(
    store: ChannelMessageStore,
    binder: ChannelAgentBinder,
    channelId: string,
    text: string,
    sender: ChannelSenderRef = OPERATOR,
    providers: string[] = ['hermes']
  ): ChannelMessage {
    const mentions = parseMentions(text, providers);
    const message = store.appendComplete({
      channelId,
      sender,
      text,
      ...(mentions.length ? { mentions } : {}),
    });
    binder.handleMessagePosted(message, message.mentions ?? []);
    return message;
  }

  function repliesIn(store: ChannelMessageStore, channelId: string) {
    return store
      .history(channelId, { limit: 200 })
      .filter(
        (m) =>
          m.sender.kind === 'agent' && m.status === 'complete' && !m.agentDetail
      );
  }

  function systemRowsIn(store: ChannelMessageStore, channelId: string) {
    return store
      .history(channelId, { limit: 200 })
      .filter((m) => m.kind === 'system');
  }

  /** Let every queued microtask + availability probe drain before asserting a negative. */
  const settle = () => new Promise((r) => setTimeout(r, 60));

  it('routes an unmentioned human DM message to the channel agent', async () => {
    const topics = makeTopics();
    createDmTopic(topics);
    const adapter = new ScriptedAdapter('hermes', {
      mode: 'reply',
      text: 'on it',
    });
    const { binder, store, sessions } = makeBinder({
      build: () => adapter,
      targets: HERMES_TARGETS,
      knownProviderIds: ['hermes'],
      topicStore: topics,
    });

    postTo(store, binder, DM_CH, 'what is the state of the build?');

    await waitFor(() => repliesIn(store, DM_CH).length === 1);
    expect(repliesIn(store, DM_CH)[0]!.body.text).toBe('on it');
    expect(adapter.sendCalls).toHaveLength(1);
    // The DM's single agent is that provider's DEFAULT profile actor.
    expect(sessions.lastCreateParams()).toMatchObject({
      providerId: 'hermes',
      profileActorId: builtInAgentProfileId('hermes'),
    });
  });

  // #1455 slice 1: a DM is deterministic, so its membership is too — the two
  // participants, with no invite verb needed.
  it('enrols the DM agent from the addressed message alone', async () => {
    const topics = makeTopics();
    createDmTopic(topics);
    const { binder, store } = makeBinder({
      build: () =>
        new ScriptedAdapter('hermes', { mode: 'reply', text: 'on it' }),
      targets: HERMES_TARGETS,
      knownProviderIds: ['hermes'],
      topicStore: topics,
    });

    postTo(store, binder, DM_CH, 'what is the state of the build?');

    await waitFor(() => repliesIn(store, DM_CH).length === 1);
    // Addressing the channel IS the mention in a DM, so the one agent is
    // enrolled with no literal @name and no invite verb, credited to the human
    // who addressed it. (The human half is enrolled by the router's post path,
    // which this binder-level fixture deliberately bypasses.)
    expect(store.listMembers(DM_CH)).toMatchObject([
      {
        kind: 'agent',
        id: builtInAgentProfileId('hermes'),
        invitedBy: 'human:operator',
      },
    ]);
    expect(
      store.isMember(DM_CH, 'agent', builtInAgentProfileId('hermes'))
    ).toBe(true);
    // ...and the vendor spelling a gateway credential would arrive under
    // resolves to that same member.
    expect(store.isMember(DM_CH, 'agent', 'agent:hermes')).toBe(true);
  });

  // #1455 slice 2: the mention auto-add and `channels.invite` are the SAME
  // store verb, so a mention re-admits a profile a member had removed. That is
  // the intended reading of `channels.remove-member`: it revokes the standing
  // membership, and naming the profile again grants it back under the new
  // inviter — it does not blacklist the profile from the channel forever.
  it('re-admits a removed profile when a member mentions it again', async () => {
    const topics = makeTopics();
    createDmTopic(topics);
    const { binder, store } = makeBinder({
      build: () =>
        new ScriptedAdapter('hermes', { mode: 'reply', text: 'on it' }),
      targets: HERMES_TARGETS,
      knownProviderIds: ['hermes'],
      topicStore: topics,
    });

    postTo(store, binder, DM_CH, 'first pass');
    await waitFor(() => repliesIn(store, DM_CH).length === 1);
    const removed = store.removeMember({
      channelId: DM_CH,
      kind: 'agent',
      id: builtInAgentProfileId('hermes'),
      removedBy: 'human:operator',
    });
    expect(removed).not.toBeNull();
    expect(store.isMember(DM_CH, 'agent', 'agent:hermes')).toBe(false);

    postTo(store, binder, DM_CH, 'second pass');
    await waitFor(() => repliesIn(store, DM_CH).length === 2);
    expect(store.isMember(DM_CH, 'agent', 'agent:hermes')).toBe(true);
    expect(
      store
        .listMembers(DM_CH)
        .find((m) => m.id === builtInAgentProfileId('hermes'))
    ).toMatchObject({ invitedBy: 'human:operator' });
  });

  // #1408: a DM has exactly one agent profile, so the multi-party framing was
  // both false and paid for on every single turn.
  it('addresses the DM agent directly instead of as one of many participants', async () => {
    const topics = makeTopics();
    createDmTopic(topics);
    const adapter = new ScriptedAdapter('hermes', {
      mode: 'reply',
      text: 'on it',
    });
    const { binder, store } = makeBinder({
      build: () => adapter,
      targets: HERMES_TARGETS,
      knownProviderIds: ['hermes'],
      topicStore: topics,
    });

    const trigger = postTo(
      store,
      binder,
      DM_CH,
      'what is the state of the build?'
    );
    await waitFor(() => adapter.sendInputs.length === 1);

    const lines = adapter.sendInputs[0]!.content.split('\n');
    expect(lines[0]).toBe('[Relay DM #Hermes — you are @hermes]');
    expect(adapter.sendInputs[0]!.content).not.toContain('multi-party chat');

    // The handle is the DM's durable channel id — never the private runtime id.
    expect(lines[1]).toBe(
      `[relay channel-id=${DM_CH} trigger-seq=${trigger.seq}]`
    );
  });

  // #1408. "DM" is a claim about who else is here, and it is only true for the
  // DM's OWN agent. An explicitly @-mentioned guest shares the channel with the
  // human AND the DM agent, so promising it a private 1:1 is the over-claim the
  // fail-closed default exists to avoid.
  it('keeps the multi-party header for an explicitly mentioned guest in a DM', async () => {
    const topics = makeTopics();
    createDmTopic(topics);
    const adapters = new Map<string, ScriptedAdapter>();
    const { binder, store } = makeBinder({
      build: (agentType) => {
        const adapter = new ScriptedAdapter(agentType, {
          mode: 'reply',
          text: 'ack',
        });
        adapters.set(agentType, adapter);
        return adapter;
      },
      targets: [...HERMES_TARGETS, ...MOCK_TARGETS],
      knownProviderIds: ['hermes', 'mock'],
      topicStore: topics,
    });

    postTo(store, binder, DM_CH, 'settle the build question', OPERATOR, [
      'hermes',
    ]);
    await waitFor(() => adapters.get('hermes')?.sendInputs.length === 1);
    postTo(store, binder, DM_CH, '@mock second opinion?', OPERATOR, [
      'hermes',
      'mock',
    ]);
    await waitFor(() => adapters.get('mock')?.sendInputs.length === 1);

    const guest = adapters.get('mock')!.sendInputs[0]!.content;
    expect(guest.split('\n')[0]).toBe(
      `[Relay channel #Hermes — you are @mock, one participant in a multi-party chat]`
    );
    expect(guest).not.toContain('[Relay DM #');
    // The DM's own agent keeps the direct framing in the same channel.
    expect(adapters.get('hermes')!.sendInputs[0]!.content.split('\n')[0]).toBe(
      '[Relay DM #Hermes — you are @hermes]'
    );
  });

  it('does not double-route an explicit @mention in a DM', async () => {
    const topics = makeTopics();
    createDmTopic(topics);
    const adapter = new ScriptedAdapter('hermes', {
      mode: 'reply',
      text: 'ack',
    });
    const { binder, store, sessions } = makeBinder({
      build: () => adapter,
      targets: HERMES_TARGETS,
      knownProviderIds: ['hermes'],
      topicStore: topics,
    });

    postTo(store, binder, DM_CH, '@hermes ship it');

    await waitFor(() => repliesIn(store, DM_CH).length === 1);
    await settle();
    // Exactly ONE turn: the explicit mention resolved, so the implicit DM path
    // must not fire a second copy of the same message.
    expect(adapter.sendCalls).toHaveLength(1);
    expect(repliesIn(store, DM_CH)).toHaveLength(1);
    expect(sessions.spawns()).toBe(1);
  });

  it('never self-routes an agent-authored DM post', async () => {
    const topics = makeTopics();
    createDmTopic(topics);
    const adapter = new ScriptedAdapter('hermes', {
      mode: 'reply',
      text: 'loop',
    });
    const { binder, store, sessions } = makeBinder({
      build: () => adapter,
      targets: HERMES_TARGETS,
      knownProviderIds: ['hermes'],
      topicStore: topics,
    });

    // An unmentioned post from the DM's OWN agent. `eligibleProfiles`' self
    // filter cannot catch this — there are no mentions to filter — so the
    // implicit path must be gated on sender kind instead.
    postTo(store, binder, DM_CH, 'still working on it', HERMES_AGENT_SENDER);

    await settle();
    expect(adapter.sendCalls).toHaveLength(0);
    expect(sessions.spawns()).toBe(0);
    expect(systemRowsIn(store, DM_CH)).toHaveLength(0);
  });

  it('never blames the human for an AGENT-authored unroutable mention in a DM', async () => {
    const topics = makeTopics();
    createDmTopic(topics);
    // The DM agent's own reply mentions a provider that is MENTIONABLE
    // (`knownProviderIds` = every built-in adapter) but not a configured
    // routing target (`mentionTargets` = the configured frameworks).
    const adapter = new ScriptedAdapter('hermes', {
      mode: 'reply',
      text: 'looking now — @codex can you diff the branch?',
    });
    const { binder, store, sessions } = makeBinder({
      build: () => adapter,
      targets: HERMES_TARGETS, // codex resolves, but is not a target
      knownProviderIds: ['hermes', 'codex'],
      topicStore: topics,
    });

    postTo(store, binder, DM_CH, 'what is the state of the build?');

    await waitFor(() => repliesIn(store, DM_CH).length === 1);
    await settle();
    // The human's message routed and WAS answered. `routeOne` is shared with
    // the agent lanes, so the DM "nothing was routed" row must be gated on the
    // trigger's sender kind, not on DM-ness alone: otherwise the agent's own
    // dead @mention stamps a failure row under the human's trigger claiming
    // nothing was routed, while the human was in fact answered.
    expect(systemRowsIn(store, DM_CH)).toHaveLength(0);
    expect(sessions.spawns()).toBe(1);

    // Same gate for the other agent lane: a gateway agent post in the DM.
    postTo(store, binder, DM_CH, '@codex following up', HERMES_AGENT_SENDER, [
      'hermes',
      'codex',
    ]);
    await settle();
    expect(systemRowsIn(store, DM_CH)).toHaveLength(0);
    expect(sessions.spawns()).toBe(1);
  });

  it('says so out loud when a DM agent is not routable', async () => {
    const topics = makeTopics();
    createDmTopic(topics);
    const adapter = new ScriptedAdapter('hermes', {
      mode: 'reply',
      text: 'never',
    });
    const { binder, store, sessions } = makeBinder({
      build: () => adapter,
      targets: [], // hermes is not a known framework on this hub
      knownProviderIds: ['hermes'],
      topicStore: topics,
    });

    postTo(store, binder, DM_CH, 'are you there?');

    await waitFor(() => systemRowsIn(store, DM_CH).length === 1);
    expect(systemRowsIn(store, DM_CH)[0]!.body.text).toContain(
      'nothing was routed'
    );
    expect(sessions.spawns()).toBe(0);
    expect(adapter.sendCalls).toHaveLength(0);
  });

  it('stays silent in a multi-party channel with no mentions', async () => {
    const topics = makeTopics();
    createDmTopic(topics); // the DM exists; this post just is not in it
    topics.create({ id: CH, workspaceId: DM_WORKSPACE, title: 'general' });
    const adapter = new ScriptedAdapter('hermes', {
      mode: 'reply',
      text: 'never',
    });
    const { binder, store, sessions } = makeBinder({
      build: () => adapter,
      targets: HERMES_TARGETS,
      knownProviderIds: ['hermes'],
      topicStore: topics,
    });

    postTo(store, binder, CH, 'morning everyone');

    await settle();
    expect(adapter.sendCalls).toHaveLength(0);
    expect(sessions.spawns()).toBe(0);
    // Humans chat without addressing an agent — a system row here is spam.
    expect(systemRowsIn(store, CH)).toHaveLength(0);
    expect(repliesIn(store, CH)).toHaveLength(0);
  });
});

// ── #1353: unmentioned product-channel posts use the designated orchestrator
// binding, while explicit recipient and sender-kind gates remain authoritative.

describe('channel-agent-binder — orchestrator default-routing matrix', () => {
  const TARGETS: MentionTarget[] = [
    {
      id: 'orchestrator',
      displayName: 'Orchestrator',
      kind: 'framework',
      available: true,
      reason: null,
    },
    {
      id: 'worker',
      displayName: 'Worker',
      kind: 'framework',
      available: true,
      reason: null,
    },
  ];

  function makeProductTopics(): WorkspaceTopicStore {
    const topics = createWorkspaceTopicStore({ dbPath: ':memory:' });
    cleanup.push(() => topics.close());
    topics.create({
      id: CH,
      workspaceId: 'ws:local',
      title: 'product',
    });
    return topics;
  }

  it.each([
    {
      name: 'human + bare + designated => orchestrator',
      designate: true,
      sender: OPERATOR,
      kind: 'message' as const,
      text: 'please take the next step',
      expected: { orchestrator: 1, worker: 0 },
    },
    {
      name: 'human + explicit worker + designated => worker only',
      designate: true,
      sender: OPERATOR,
      kind: 'message' as const,
      text: '@worker please inspect this',
      expected: { orchestrator: 0, worker: 1 },
    },
    {
      name: 'human + bare + no designation => no dispatch',
      designate: false,
      sender: OPERATOR,
      kind: 'message' as const,
      text: 'morning everyone',
      expected: { orchestrator: 0, worker: 0 },
    },
    {
      name: 'human + bare + collaborator binding => no role upgrade',
      designate: false,
      collaborator: true,
      sender: OPERATOR,
      kind: 'message' as const,
      text: 'do not infer a driver',
      expected: { orchestrator: 0, worker: 0 },
    },
    {
      name: 'agent + bare + designated => no default loop',
      designate: true,
      sender: AGENT_SENDER,
      kind: 'message' as const,
      text: 'still coordinating',
      expected: { orchestrator: 0, worker: 0 },
    },
    {
      name: 'system row + designated => no default loop',
      designate: true,
      sender: { kind: 'system' as const, id: 'system' },
      kind: 'system' as const,
      text: 'runtime notice',
      expected: { orchestrator: 0, worker: 0 },
    },
  ])(
    '$name',
    async ({ designate, collaborator, sender, kind, text, expected }) => {
      const adapters = new Map<string, ScriptedAdapter[]>();
      const topics = makeProductTopics();
      const { binder, store } = makeBinder({
        build: (providerId) => {
          const adapter = new ScriptedAdapter(providerId, {
            mode: 'reply',
            text: `${providerId} ack`,
          });
          const list = adapters.get(providerId) ?? [];
          list.push(adapter);
          adapters.set(providerId, list);
          return adapter;
        },
        targets: TARGETS,
        knownProviderIds: ['orchestrator', 'worker'],
        topicStore: topics,
      });
      if (designate) {
        await binder.ensureOrchestrator(CH, 'orchestrator');
      } else if (collaborator) {
        await binder.ensureBinding(CH, 'orchestrator');
      }

      const mentions = parseMentions(text, ['orchestrator', 'worker']);
      const message = store.appendComplete({
        channelId: CH,
        kind,
        sender,
        text,
        ...(mentions.length ? { mentions } : {}),
      });
      binder.handleMessagePosted(message, message.mentions ?? []);
      await new Promise((resolve) => setTimeout(resolve, 60));

      expect(
        (adapters.get('orchestrator') ?? []).reduce(
          (count, adapter) => count + adapter.sendCalls.length,
          0
        )
      ).toBe(expected.orchestrator);
      expect(
        (adapters.get('worker') ?? []).reduce(
          (count, adapter) => count + adapter.sendCalls.length,
          0
        )
      ).toBe(expected.worker);
    }
  );

  it('cold-resumes a durable orchestrator designation after a store and hub restart', async () => {
    const topics = makeProductTopics();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-binder-restart-'));
    cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const storePath = path.join(dir, 'channel-chat.db');
    const profileActorId = builtInAgentProfileId('orchestrator');
    const beforeRestart = createChannelMessageStore(storePath);
    beforeRestart.designateSoleOrchestrator({
      channelId: CH,
      profileActorId,
      agentFramework: 'orchestrator',
      runtimeId: null,
    });
    beforeRestart.close();

    // Fresh store, hub, binder, and runtime registry model a full hub restart.
    const { binder, store, sessions } = makeBinder({
      build: (providerId) =>
        new ScriptedAdapter(providerId, {
          mode: 'reply',
          text: 'cold ack',
        }),
      targets: TARGETS,
      knownProviderIds: ['orchestrator', 'worker'],
      topicStore: topics,
      storePath,
    });
    expect((await binder.rosterForChannel(CH))[0]).toMatchObject({
      id: profileActorId,
      role: 'orchestrator',
      binding: null,
    });
    await expect(binder.ensureOrchestrator(CH, 'worker')).rejects.toMatchObject(
      {
        status: 409,
        code: 'channel_orchestrator_conflict',
      }
    );
    expect(sessions.spawns()).toBe(0);
    expect(store.getSoleOrchestratorBinding(CH)?.profileActorId).toBe(
      profileActorId
    );

    post(store, binder, 'resume the plan', ['orchestrator']);

    await waitFor(() => sessions.spawns() === 1);
    const adapter = sessions.adapterFor(
      sessions.firstSessionId()
    ) as ScriptedAdapter;
    await waitFor(() => adapter.sendCalls.length === 1);
    expect(sessions.lastCreateParams()).toMatchObject({
      providerId: 'orchestrator',
      profileActorId,
      role: 'orchestrator',
    });
    expect(agentReplies(store, 'orchestrator')[0]?.body.text).toBe('cold ack');
  });

  it('does not discard the required orchestrator role when joining a collaborator spawn', async () => {
    const topics = makeProductTopics();
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const { binder, store, sessions } = makeBinder({
      build: (providerId) => new ScriptedAdapter(providerId, { mode: 'stall' }),
      targets: [TARGETS[0]!],
      knownProviderIds: ['orchestrator'],
      topicStore: topics,
      gate,
    });
    const profileActorId = builtInAgentProfileId('orchestrator');
    const collaborator = binder.ensureBinding(CH, 'orchestrator');
    await waitFor(() => sessions.spawns() === 1);
    // The ordinary spawn has already captured no role and is parked. Model a
    // concurrent durable designation becoming visible before the bare post.
    store.designateSoleOrchestrator({
      channelId: CH,
      profileActorId,
      agentFramework: 'orchestrator',
      runtimeId: null,
    });
    post(store, binder, 'must not enter the collaborator runtime', [
      'orchestrator',
    ]);
    await new Promise((resolve) => setTimeout(resolve, 20));

    releaseGate();
    const collaboratorBinding = await collaborator;
    await new Promise((resolve) => setTimeout(resolve, 40));

    const adapter = sessions.adapterFor(
      collaboratorBinding.runtimeId!
    ) as ScriptedAdapter;
    expect(sessions.createParams()).toEqual([
      expect.not.objectContaining({ role: 'orchestrator' }),
    ]);
    expect(adapter.sendCalls).toHaveLength(0);
    expect(sessions.spawns()).toBe(1);
    expect(store.getBinding(CH, profileActorId)?.role).toBe('orchestrator');
  });

  it('keeps an implicit orchestrator reply in the triggering thread', async () => {
    const topics = makeProductTopics();
    const adapters: ScriptedAdapter[] = [];
    const { binder, store, sessions } = makeBinder({
      build: () => {
        const adapter = new ScriptedAdapter('orchestrator', {
          mode: 'reply',
          text: 'threaded ack',
        });
        adapters.push(adapter);
        return adapter;
      },
      targets: [TARGETS[0]!],
      knownProviderIds: ['orchestrator'],
      topicStore: topics,
    });
    await binder.ensureOrchestrator(CH, 'orchestrator');
    const root = store.appendComplete({
      channelId: CH,
      sender: OPERATOR,
      text: 'root',
    });
    const trigger = post(
      store,
      binder,
      'threaded implicit instruction',
      ['orchestrator'],
      OPERATOR,
      root.id
    );

    await waitFor(() => agentReplies(store, 'orchestrator').length === 1);
    expect(sessions.spawns()).toBe(2);
    expect(adapters).toHaveLength(2);
    expect(agentReplies(store, 'orchestrator')[0]).toMatchObject({
      threadId: root.id,
      parentMessageId: trigger.id,
    });
  });

  it('preserves FIFO queue semantics for implicit thread turns', async () => {
    const topics = makeProductTopics();
    const adapters: ScriptedAdapter[] = [];
    const { binder, store, sessions } = makeBinder({
      build: () => {
        const adapter = new ScriptedAdapter('orchestrator', { mode: 'stall' });
        adapters.push(adapter);
        return adapter;
      },
      targets: [TARGETS[0]!],
      knownProviderIds: ['orchestrator'],
      topicStore: topics,
    });
    await binder.ensureOrchestrator(CH, 'orchestrator');
    const root = store.appendComplete({
      channelId: CH,
      sender: OPERATOR,
      text: 'root',
    });

    const first = post(
      store,
      binder,
      'first implicit instruction',
      ['orchestrator'],
      OPERATOR,
      root.id
    );
    await waitFor(
      () => adapters.length === 2 && adapters[1]!.sendCalls.length === 1
    );
    const threadAdapter = adapters[1]!;
    post(
      store,
      binder,
      'second implicit instruction',
      ['orchestrator'],
      OPERATOR,
      root.id
    );
    await waitFor(() =>
      binder.archiveActivityForChannel(CH).reasons.includes('queued-turn')
    );
    expect(sessions.spawns()).toBe(2);

    expect(threadAdapter.sendInputs[0]?.turnId).toBe(
      channelTurnId(first.id, builtInAgentProfileId('orchestrator'))
    );
    expect(threadAdapter.sendCalls).toHaveLength(1);
    expect(
      store.getBinding(CH, builtInAgentProfileId('orchestrator'), root.id)
        ?.runtimeId
    ).toBeTruthy();
  });
});

// ── retry (#1308 slice 1 item 2) ─────────────────────────────────────────────

describe('channel-agent-binder — retry', () => {
  const MOCK_PROFILE = builtInAgentProfileId('mock');

  /**
   * Exactly what the bridge writes for a lost turn: a streaming row stamped with
   * the binder-minted `source.turnId`, finalized to a terminal non-complete
   * status. Built through the store (not by driving a provider into failing) so
   * the retry contract is exercised deterministically and without timers.
   */
  function failedAgentRow(
    store: ChannelMessageStore,
    trigger: ChannelMessage,
    status: 'failed' | 'interrupted' | 'truncated' = 'failed',
    turnId = channelTurnId(trigger.id, MOCK_PROFILE)
  ): ChannelMessage {
    const stream = store.beginStream({
      channelId: CH,
      sender: {
        kind: 'agent',
        id: MOCK_PROFILE,
        providerId: 'mock',
        displayName: 'Mock',
      },
      source: { runtimeId: 'runtime:mock', turnId, itemId: 'assistant-0' },
    });
    return store.finalizeStream(stream.id, { text: 'half a re', status })!;
  }

  function humanRows(store: ChannelMessageStore): ChannelMessage[] {
    return rows(store).filter((m) => m.sender.kind === 'human');
  }

  it('re-routes the original trigger exactly once and never duplicates the human message', async () => {
    const adapter = new ScriptedAdapter('mock', { mode: 'stall' });
    const { binder, store } = makeBinder({
      build: () => adapter,
      targets: MOCK_TARGETS,
      knownProviderIds: ['mock'],
    });
    const trigger = store.appendComplete({
      channelId: CH,
      sender: OPERATOR,
      text: '@mock ship the anchor',
    });
    const failed = failedAgentRow(store, trigger);

    const result = await binder.retryMessage(CH, failed.id);
    await waitFor(() => adapter.sendCalls.length > 0);

    expect(result).toEqual({
      messageId: failed.id,
      triggerMessageId: trigger.id,
      profileActorId: MOCK_PROFILE,
    });
    // Exactly one delivery, carrying the SAME deterministic turn identity the
    // lost turn had — a retry re-runs a turn, it does not open a new one.
    expect(adapter.sendCalls).toEqual([
      channelTurnId(trigger.id, MOCK_PROFILE),
    ]);
    // The load-bearing invariant: the operator's message is re-routed, never
    // re-posted, so the timeline still holds exactly one copy of it.
    expect(humanRows(store).map((m) => m.id)).toEqual([trigger.id]);
    expect(adapter.sendInputs[0]?.content).toContain('ship the anchor');
  });

  it('supersedes the retried row with a system row carrying its id', async () => {
    const adapter = new ScriptedAdapter('mock', { mode: 'stall' });
    const { binder, store } = makeBinder({
      build: () => adapter,
      targets: MOCK_TARGETS,
      knownProviderIds: ['mock'],
    });
    const trigger = store.appendComplete({
      channelId: CH,
      sender: OPERATOR,
      text: '@mock ship the anchor',
    });
    const failed = failedAgentRow(store, trigger);

    await binder.retryMessage(CH, failed.id);
    await waitFor(() => adapter.sendCalls.length > 0);

    const marker = systemRows(store).find(
      (row) => row.meta?.[CHANNEL_RETRY_OF_META_KEY] === failed.id
    );
    expect(marker).toBeDefined();
    expect(marker?.body.text).toContain('retrying');
    // The failed row itself is untouched: it stays the durable record of what
    // went wrong, and the supersede mark lives on a separate durable row.
    expect(store.getMessage(failed.id)?.status).toBe('failed');
  });

  it('refuses to retry while the same profile is mid-turn (storm brake)', async () => {
    const adapter = new ScriptedAdapter('mock', { mode: 'stall' });
    const { binder, store } = makeBinder({
      build: () => adapter,
      targets: MOCK_TARGETS,
      knownProviderIds: ['mock'],
    });
    // Drive a real turn that never completes so the binding is genuinely busy.
    const live = post(store, binder, '@mock keep going', ['mock']);
    await waitFor(() => adapter.sendCalls.length === 1);

    const trigger = store.appendComplete({
      channelId: CH,
      sender: OPERATOR,
      text: '@mock the earlier one',
    });
    const failed = failedAgentRow(store, trigger);

    await expect(binder.retryMessage(CH, failed.id)).rejects.toBeInstanceOf(
      ChannelAgentBusyError
    );
    // Nothing was delivered and nothing was superseded by the refused retry.
    expect(adapter.sendCalls).toEqual([channelTurnId(live.id, MOCK_PROFILE)]);
    expect(
      systemRows(store).filter(
        (row) => row.meta?.[CHANNEL_RETRY_OF_META_KEY] !== undefined
      )
    ).toHaveLength(0);
  });

  it('admits exactly one of two concurrent retries (brake is not a TOCTOU)', async () => {
    const adapter = new ScriptedAdapter('mock', { mode: 'stall' });
    const { binder, store } = makeBinder({
      build: () => adapter,
      targets: MOCK_TARGETS,
      knownProviderIds: ['mock'],
    });
    const trigger = store.appendComplete({
      channelId: CH,
      sender: OPERATOR,
      text: '@mock ship the anchor',
    });
    // Two different lost rows for the SAME profile — two devices pressing retry
    // in the same tick. Nothing is bound yet (cold binding after a hub restart),
    // so the `live` map cannot answer "busy" for either caller.
    const first = failedAgentRow(store, trigger);
    const trigger2 = store.appendComplete({
      channelId: CH,
      sender: OPERATOR,
      text: '@mock and the other one',
    });
    const second = failedAgentRow(store, trigger2);

    const results = await Promise.allSettled([
      binder.retryMessage(CH, first.id),
      binder.retryMessage(CH, second.id),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const refused = results.find((r) => r.status === 'rejected');
    expect(refused?.status === 'rejected' && refused.reason).toBeInstanceOf(
      ChannelAgentBusyError
    );
    await waitFor(() => adapter.sendCalls.length > 0);
    expect(adapter.sendCalls).toHaveLength(1);
    // The refused retry never wrote a supersede mark either — the row it names
    // keeps its own retry affordance.
    expect(
      systemRows(store).filter(
        (row) => row.meta?.[CHANNEL_RETRY_OF_META_KEY] !== undefined
      )
    ).toHaveLength(1);
  });

  it('rejects rows no routed turn can be recovered from', async () => {
    const adapter = new ScriptedAdapter('mock', { mode: 'stall' });
    const { binder, store } = makeBinder({
      build: () => adapter,
      targets: MOCK_TARGETS,
      knownProviderIds: ['mock'],
    });
    const trigger = store.appendComplete({
      channelId: CH,
      sender: OPERATOR,
      text: '@mock ship the anchor',
    });

    await expect(binder.retryMessage(CH, 'chm:nope')).rejects.toMatchObject({
      reasonCode: 'CHANNEL_MESSAGE_NOT_FOUND',
      notFound: true,
    });
    // A human row is not an agent turn.
    await expect(binder.retryMessage(CH, trigger.id)).rejects.toMatchObject({
      reasonCode: 'MESSAGE_NOT_RETRYABLE',
      notFound: false,
    });
    // A provider-labelled turn id (Hermes emits `turn-0`) names no trigger.
    const orphan = failedAgentRow(store, trigger, 'failed', 'turn-0');
    await expect(binder.retryMessage(CH, orphan.id)).rejects.toMatchObject({
      reasonCode: 'MESSAGE_NOT_RETRYABLE',
    });
    expect(adapter.sendCalls).toHaveLength(0);
  });

  it('refuses to re-run a turn whose trigger the operator deleted (#1308 item 4)', async () => {
    const adapter = new ScriptedAdapter('mock', { mode: 'stall' });
    const { binder, store } = makeBinder({
      build: () => adapter,
      targets: MOCK_TARGETS,
      knownProviderIds: ['mock'],
    });
    const trigger = store.appendComplete({
      channelId: CH,
      sender: OPERATOR,
      text: '@mock ship the anchor',
    });
    const failed = failedAgentRow(store, trigger);
    // A tombstone keeps its id, so the trigger still RESOLVES — re-running the
    // turn would hand the provider exactly the text the operator erased.
    store.deleteMessage({
      channelId: CH,
      messageId: trigger.id,
      deleterId: OPERATOR.id,
    });

    await expect(binder.retryMessage(CH, failed.id)).rejects.toMatchObject({
      reasonCode: 'RETRY_TRIGGER_DELETED',
      notFound: false,
    });
    expect(adapter.sendCalls).toHaveLength(0);
    // Refused before the supersede mark: a mark for a turn that never ran would
    // disable the row's own retry affordance forever.
    expect(
      systemRows(store).filter(
        (row) => row.meta?.[CHANNEL_RETRY_OF_META_KEY] !== undefined
      )
    ).toHaveLength(0);
  });

  it('retries interrupted and truncated rows too — every lost turn, not just failed', async () => {
    const adapter = new ScriptedAdapter('mock', { mode: 'stall' });
    const { binder, store } = makeBinder({
      build: () => adapter,
      targets: MOCK_TARGETS,
      knownProviderIds: ['mock'],
    });
    const trigger = store.appendComplete({
      channelId: CH,
      sender: OPERATOR,
      text: '@mock ship the anchor',
    });
    const interrupted = failedAgentRow(store, trigger, 'interrupted');

    await binder.retryMessage(CH, interrupted.id);
    await waitFor(() => adapter.sendCalls.length > 0);
    expect(adapter.sendCalls).toEqual([
      channelTurnId(trigger.id, MOCK_PROFILE),
    ]);
  });
});

describe('channel-agent-binder — retry availability', () => {
  it('refuses (and does not supersede) when the framework is unavailable', async () => {
    const adapter = new ScriptedAdapter('mock', { mode: 'stall' });
    const { binder, store } = makeBinder({
      build: () => adapter,
      targets: [
        {
          id: 'mock',
          displayName: 'Mock',
          kind: 'framework',
          available: false,
          reason: 'cli not installed',
        },
      ],
      knownProviderIds: ['mock'],
    });
    const trigger = store.appendComplete({
      channelId: CH,
      sender: OPERATOR,
      text: '@mock ship the anchor',
    });
    const profileId = builtInAgentProfileId('mock');
    const stream = store.beginStream({
      channelId: CH,
      sender: { kind: 'agent', id: profileId, providerId: 'mock' },
      source: {
        runtimeId: 'runtime:mock',
        turnId: channelTurnId(trigger.id, profileId),
        itemId: 'assistant-0',
      },
    });
    const failed = store.finalizeStream(stream.id, {
      text: '',
      status: 'failed',
    })!;

    await expect(binder.retryMessage(CH, failed.id)).rejects.toMatchObject({
      reasonCode: 'AGENT_UNAVAILABLE',
    });
    // No supersede mark: the row keeps its retry affordance for when the
    // framework comes back, instead of being stranded by a turn that never ran.
    expect(
      systemRows(store).filter(
        (row) => row.meta?.[CHANNEL_RETRY_OF_META_KEY] !== undefined
      )
    ).toHaveLength(0);
    expect(adapter.sendCalls).toHaveLength(0);
  });
});

// ── #1308 slice 4: mid-turn steering ─────────────────────────────────────────

const STEER_TARGETS: MentionTarget[] = [
  {
    id: 'steer',
    displayName: 'Steer',
    kind: 'framework',
    available: true,
    reason: null,
  },
];

/**
 * First `sendMessage` parks forever until the test fails it — the shape a dead
 * transport has when the send hangs and only later rejects. Everything else is
 * `SteerableAdapter`.
 */
class ParkedSendAdapter extends SteerableAdapter {
  private rejectSend: ((err: unknown) => void) | null = null;
  override sendMessage(input: AgentSendMessageInputV2): Promise<void> {
    this.sendCalls.push(input.turnId);
    this.sendInputs.push(input);
    return new Promise<void>((_resolve, reject) => {
      this.rejectSend = reject;
    });
  }
  failParkedSend(): void {
    const reject = this.rejectSend;
    this.rejectSend = null;
    reject?.(new Error('boom: transport gone'));
  }
}

/** Refuses every cancellation so the steering failure row is observable. */
class RefusingInterruptAdapter extends SteerableAdapter {
  override async interrupt(): Promise<void> {
    throw new Error('boom: interrupt refused');
  }
}

/** Post with an explicit steering choice, exactly as the post route forwards it. */
function postSteering(
  store: ChannelMessageStore,
  binder: ChannelAgentBinder,
  text: string,
  knownIds: string[],
  steering: 'interrupt' | undefined,
  sender: ChannelSenderRef = OPERATOR,
  parentMessageId?: string
): ChannelMessage {
  const mentions = parseMentions(text, knownIds);
  const message = store.appendComplete({
    channelId: CH,
    sender,
    text,
    ...(mentions.length ? { mentions } : {}),
    ...(parentMessageId ? { parentMessageId } : {}),
  });
  binder.handleMessagePosted(
    message,
    message.mentions ?? [],
    steering ? { steering } : undefined
  );
  return message;
}

/** Image-bearing post. The payload never resolves — only the turn shape matters. */
function postSteerImage(
  store: ChannelMessageStore,
  binder: ChannelAgentBinder,
  text: string,
  partId: ChannelAttachmentId
): ChannelMessage {
  const mentions = parseMentions(text, ['steer']);
  const part: ChannelImagePart = {
    type: 'image',
    id: partId,
    mime: 'image/png',
    w: 1,
    h: 1,
    bytes: 7,
  };
  const message = store.appendComplete({
    channelId: CH,
    sender: OPERATOR,
    text,
    ...(mentions.length ? { mentions } : {}),
    parts: [part],
  });
  binder.handleMessagePosted(message, message.mentions ?? []);
  return message;
}

function makeSteerBinder(supportsSafeBoundarySteer = false) {
  const harness = makeBinder({
    build: (agentType) =>
      new SteerableAdapter(agentType, supportsSafeBoundarySteer),
    targets: STEER_TARGETS,
    knownProviderIds: ['steer'],
  });
  const events: Array<Record<string, unknown>> = [];
  harness.binder.setStatusBroadcaster((_type, data) => events.push(data));
  return { ...harness, events };
}

async function steerAdapter(
  sessions: ReturnType<typeof makeBinder>['sessions']
): Promise<SteerableAdapter> {
  await waitFor(() => sessions.spawns() === 1);
  return sessions.adapterFor(sessions.firstSessionId()) as SteerableAdapter;
}

describe('channel-agent-binder — mid-turn steering (#1308 slice 4)', () => {
  it('uses the native safe-boundary steer lane for an unmentioned orchestrator post', async () => {
    const topics = createWorkspaceTopicStore({ dbPath: ':memory:' });
    cleanup.push(() => topics.close());
    topics.create({
      id: CH,
      workspaceId: 'ws:local',
      title: 'product',
    });
    const harness = makeBinder({
      build: (agentType) => new SteerableAdapter(agentType, true),
      targets: STEER_TARGETS,
      knownProviderIds: ['steer'],
      topicStore: topics,
    });
    await harness.binder.ensureOrchestrator(CH, 'steer');

    postSteering(
      harness.store,
      harness.binder,
      'first implicit instruction',
      ['steer'],
      undefined
    );
    const adapter = await steerAdapter(harness.sessions);
    await waitFor(() => adapter.sendCalls.length === 1);
    postSteering(
      harness.store,
      harness.binder,
      'second implicit instruction',
      ['steer'],
      undefined
    );

    await waitFor(() => adapter.steerInputs.length === 1);
    expect(adapter.steerInputs[0]?.content).toContain(
      'second implicit instruction'
    );
  });

  // #1408: the live turn already read the envelope. A steer is an interjection
  // into that turn, so it ships the handle, any interim rows, and the
  // instruction — and still advances the delivery cursor on acceptance.
  it('ships a steer as handle + instruction with no envelope, and still advances the cursor', async () => {
    const topics = createWorkspaceTopicStore({ dbPath: ':memory:' });
    cleanup.push(() => topics.close());
    topics.create({ id: CH, workspaceId: 'ws:local', title: 'product' });
    const harness = makeBinder({
      build: (agentType) => new SteerableAdapter(agentType, true),
      targets: STEER_TARGETS,
      knownProviderIds: ['steer'],
      topicStore: topics,
    });

    postSteering(
      harness.store,
      harness.binder,
      '@steer opener',
      ['steer'],
      undefined
    );
    const adapter = await steerAdapter(harness.sessions);
    await waitFor(() => adapter.sendCalls.length === 1);
    // The ordinary turn that opened this run DOES carry the full envelope.
    expect(adapter.sendInputs[0]!.content).toContain('[Relay channel #product');

    const steerTrigger = postSteering(
      harness.store,
      harness.binder,
      '@steer instead inspect the conflict',
      ['steer'],
      undefined
    );
    await waitFor(() => adapter.steerInputs.length === 1);

    const steered = adapter.steerInputs[0]!.content;
    expect(steered.split('\n')[0]).toBe(
      `[relay channel-id=${CH} trigger-seq=${steerTrigger.seq}]`
    );
    expect(steered).not.toContain('[Relay channel #');
    expect(steered).not.toContain('since your last turn');
    expect(steered).not.toContain('[Thread scope —');
    expect(steered).toContain(
      '[operator [human] — new instruction for your current turn]'
    );
    expect(steered).toContain('@steer instead inspect the conflict');

    // Acceptance advanced the cursor past the steered trigger, so the next
    // ordinary turn must not re-deliver it as a context row.
    adapter.completeLatest('redirected reply');
    postSteering(
      harness.store,
      harness.binder,
      '@steer now summarise',
      ['steer'],
      undefined
    );
    await waitFor(() => adapter.sendCalls.length === 2);
    expect(adapter.sendInputs[1]!.content).toContain('@steer now summarise');
    expect(adapter.sendInputs[1]!.content).not.toContain(
      'instead inspect the conflict'
    );
  });

  it('bounds accepted native steers at the aggregate queue cap', async () => {
    const { binder, store, sessions } = makeSteerBinder(true);
    postSteering(store, binder, '@steer opener', ['steer'], undefined);
    const adapter = await steerAdapter(sessions);
    await waitFor(() => adapter.sendCalls.length === 1);
    for (let i = 0; i < 8; i++) {
      postSteering(store, binder, `@steer ${i}`, ['steer'], undefined);
    }
    await waitFor(() => adapter.steerInputs.length === 8);
    postSteering(store, binder, '@steer overflow', ['steer'], undefined);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(adapter.steerInputs).toHaveLength(8);
    expect(
      rows(store).some((row) => row.body.text.includes('8 messages pending'))
    ).toBe(true);
  });

  it('falls back to one ordinary FIFO turn after a definite native steer rejection', async () => {
    const harness = makeBinder({
      build: (agentType) => new SteerableAdapter(agentType, true, true),
      targets: STEER_TARGETS,
      knownProviderIds: ['steer'],
    });
    postSteering(
      harness.store,
      harness.binder,
      '@steer opener',
      ['steer'],
      undefined
    );
    const adapter = await steerAdapter(harness.sessions);
    await waitFor(() => adapter.sendCalls.length === 1);
    postSteering(
      harness.store,
      harness.binder,
      '@steer fallback',
      ['steer'],
      undefined
    );
    await waitFor(() => adapter.steerAttempts.length === 1);
    adapter.completeLatest();
    await waitFor(() => adapter.sendCalls.length === 2);
    expect(adapter.sendInputs[1]!.content).toContain('@steer fallback');
  });

  it('does not replay a steer after an ambiguous transport failure', async () => {
    const harness = makeBinder({
      build: (agentType) => new SteerableAdapter(agentType, true, false, true),
      targets: STEER_TARGETS,
      knownProviderIds: ['steer'],
    });
    postSteering(
      harness.store,
      harness.binder,
      '@steer opener',
      ['steer'],
      undefined
    );
    const adapter = await steerAdapter(harness.sessions);
    await waitFor(() => adapter.sendCalls.length === 1);
    postSteering(
      harness.store,
      harness.binder,
      '@steer uncertain',
      ['steer'],
      undefined
    );
    await waitFor(() => adapter.steerAttempts.length === 1);
    await waitFor(() =>
      systemRows(harness.store).some((row) =>
        row.body.text.includes('could not accept the steering message')
      )
    );

    adapter.completeLatest();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(adapter.sendCalls).toHaveLength(1);
    expect(adapter.steerInputs).toHaveLength(0);
  });

  it('refuses release while a terminal patch races an unresolved native steer', async () => {
    const { binder, store, sessions } = makeBinder({
      build: (agentType) =>
        new SteerableAdapter(agentType, true, false, false, true),
      targets: STEER_TARGETS,
      knownProviderIds: ['steer'],
    });
    postSteering(store, binder, '@steer opener', ['steer'], undefined);
    const adapter = await steerAdapter(sessions);
    await waitFor(() => adapter.sendCalls.length === 1);
    postSteering(
      store,
      binder,
      '@steer ambiguous native request',
      ['steer'],
      undefined
    );
    await waitFor(() => adapter.steerAttempts.length === 1);

    // The provider may already have accepted the steer even though its RPC has
    // not returned. Its turn terminal races ahead and makes the binding look
    // idle; release must not destroy the runtime in that ambiguity window.
    adapter.completeLatest();
    await expect(
      binder.release(CH, builtInAgentProfileId('steer'))
    ).rejects.toMatchObject({ reasonCode: 'CHANNEL_AGENT_NOT_IDLE' });
    expect(sessions.destroyCalls()).toEqual([]);
  });

  it('uses a native safe-boundary steer by default and preserves FIFO without a concurrent turn', async () => {
    const { binder, store, sessions, events } = makeSteerBinder(true);
    postSteering(store, binder, '@steer long task', ['steer'], undefined);
    const adapter = await steerAdapter(sessions);
    await waitFor(() => adapter.sendCalls.length === 1);

    // No explicit field: a harness that advertises a native steer primitive
    // receives the operator's next instruction at that provider boundary.
    postSteering(
      store,
      binder,
      '@steer instead inspect the conflict',
      ['steer'],
      undefined
    );
    await waitFor(() => adapter.steerInputs.length === 1);
    expect(adapter.sendCalls).toHaveLength(1);
    expect(adapter.concurrentPeak).toBe(1);
    expect(adapter.steerInputs[0]!.content).toContain(
      '@steer instead inspect the conflict'
    );
    // Status is deliberately not the old queued lane: the UI can say
    // "steering pending" rather than falsely claiming a future turn.
    expect(events.some((event) => event['steeringCount'] === 1)).toBe(true);
    expect(events.at(-1)?.['queuedCount']).toBe(0);

    adapter.completeLatest('redirected reply');
    await waitFor(() => events.at(-1)?.['steeringCount'] === 0);
  });

  it('clears pending native steer status when its runtime dies', async () => {
    const harness = makeBinder({
      build: (agentType) =>
        new SteerableAdapter(agentType, true, false, false, true),
      targets: STEER_TARGETS,
      knownProviderIds: ['steer'],
    });
    const events: Array<Record<string, unknown>> = [];
    harness.binder.setStatusBroadcaster((_type, data) => events.push(data));
    postSteering(
      harness.store,
      harness.binder,
      '@steer long task',
      ['steer'],
      undefined
    );
    const adapter = await steerAdapter(harness.sessions);
    await waitFor(() => adapter.sendCalls.length === 1);
    postSteering(
      harness.store,
      harness.binder,
      '@steer redirect',
      ['steer'],
      undefined
    );
    await waitFor(() => adapter.steerAttempts.length === 1);
    await waitFor(() => events.at(-1)?.['steeringCount'] === 1);

    harness.sessions.fireEnd(harness.sessions.firstSessionId());
    await waitFor(() => events.at(-1)?.['status'] === 'idle');
    expect(events.at(-1)).toMatchObject({
      queuedCount: 0,
      steeringCount: 0,
    });
  });

  it('queues posts that land mid-turn and drains them all into ONE next turn', async () => {
    const { binder, store, sessions, events } = makeSteerBinder();
    postSteering(store, binder, '@steer one', ['steer'], undefined);
    const adapter = await steerAdapter(sessions);
    await waitFor(() => adapter.sendCalls.length === 1);

    // Three more posts land while the first turn is still live.
    postSteering(store, binder, '@steer two', ['steer'], undefined);
    postSteering(store, binder, '@steer three', ['steer'], undefined);
    postSteering(store, binder, '@steer four', ['steer'], undefined);
    await waitFor(() => events.some((event) => event['queuedCount'] === 3));
    // No concurrent dispatch while the first turn is open — all three queued.
    expect(adapter.sendCalls).toHaveLength(1);

    adapter.completeLatest('first reply');
    // Exactly ONE further turn for the three queued posts (coalesced).
    await waitFor(() => adapter.sendCalls.length === 2);
    await new Promise((r) => setTimeout(r, 40));
    expect(adapter.sendCalls).toHaveLength(2);
    expect(adapter.concurrentPeak).toBe(1);

    // ...and all three ride that one context packet.
    const packet = adapter.sendInputs[1]!.content;
    expect(packet).toContain('@steer two');
    expect(packet).toContain('@steer three');
    expect(packet).toContain('@steer four');
    // The newest queued post is the trigger in the packet footer.
    expect(packet.trimEnd().endsWith('@steer four')).toBe(true);
  });

  it('never drops a queued trigger and never double-dispatches across finishTurn', async () => {
    const { binder, store, sessions } = makeSteerBinder();
    postSteering(store, binder, '@steer first', ['steer'], undefined);
    const adapter = await steerAdapter(sessions);
    await waitFor(() => adapter.sendCalls.length === 1);

    // Interleave a post with the completion of the live turn: the post enqueues
    // while the previous turn is still active, then finishTurn pumps it. Only
    // ONE dispatch may result, and it must not be lost.
    postSteering(store, binder, '@steer second', ['steer'], undefined);
    adapter.completeLatest('first reply');
    await waitFor(() => adapter.sendCalls.length === 2);
    postSteering(store, binder, '@steer third', ['steer'], undefined);
    adapter.completeLatest('second reply');
    await waitFor(() => adapter.sendCalls.length === 3);
    await new Promise((r) => setTimeout(r, 40));

    expect(adapter.sendCalls).toHaveLength(3);
    expect(adapter.concurrentPeak).toBe(1);
    expect(new Set(adapter.sendCalls).size).toBe(3); // no re-sent turn identity
    expect(adapter.sendInputs[1]!.content).toContain('@steer second');
    expect(adapter.sendInputs[2]!.content).toContain('@steer third');
  });

  it('steering:"interrupt" overrides native steer and cancels the live turn', async () => {
    const { binder, store, sessions } = makeSteerBinder(true);
    postSteering(store, binder, '@steer long task', ['steer'], undefined);
    const adapter = await steerAdapter(sessions);
    await waitFor(() => adapter.sendCalls.length === 1);
    await waitFor(() =>
      rows(store).some(
        (m) => m.sender.providerId === 'steer' && m.status === 'streaming'
      )
    );
    const firstTurn = adapter.sendCalls[0]!;

    postSteering(
      store,
      binder,
      '@steer stop, do this instead',
      ['steer'],
      'interrupt'
    );

    await waitFor(() => adapter.interruptCalls.length === 1);
    expect(adapter.interruptCalls[0]).toBe(firstTurn);
    expect(adapter.steerAttempts).toHaveLength(0);
    // Existing interrupt semantics: the partial row finalizes `interrupted`.
    await waitFor(() =>
      rows(store).some(
        (m) => m.sender.providerId === 'steer' && m.status === 'interrupted'
      )
    );
    // ...and the steering message triggers its own turn immediately after.
    await waitFor(() => adapter.sendCalls.length === 2);
    expect(adapter.concurrentPeak).toBe(1);
    expect(adapter.sendInputs[1]!.content).toContain(
      '@steer stop, do this instead'
    );
  });

  it('steering:"interrupt" on an idle agent degrades to a plain send', async () => {
    const { binder, store, sessions } = makeSteerBinder();
    postSteering(store, binder, '@steer go now', ['steer'], 'interrupt');
    const adapter = await steerAdapter(sessions);
    await waitFor(() => adapter.sendCalls.length === 1);
    await new Promise((r) => setTimeout(r, 40));
    expect(adapter.interruptCalls).toHaveLength(0);
    expect(adapter.sendCalls).toHaveLength(1);
  });

  // The idempotent-replay lane applies the steering half to an already-stored
  // row. If the row DRAINED between the two posts, the live turn is the reply
  // the operator is waiting for — replaying the interrupt there would cancel
  // their own answer, the exact opposite of "interrupt and send".
  it('an idempotent steering replay never cancels the turn that message triggered', async () => {
    const { binder, store, sessions } = makeSteerBinder();
    postSteering(store, binder, '@steer long task', ['steer'], undefined);
    const adapter = await steerAdapter(sessions);
    await waitFor(() => adapter.sendCalls.length === 1);
    const steerProfile = builtInAgentProfileId('steer');

    // First "interrupt & send": cancels the opener, queues behind it. The
    // cancellation's terminal patch then releases the binding, so m2 drains and
    // becomes the LIVE turn — exactly the state the second POST arrives into.
    const m2 = postSteering(
      store,
      binder,
      '@steer do this',
      ['steer'],
      'interrupt'
    );
    await waitFor(() => adapter.interruptCalls.length === 1);
    await waitFor(() => adapter.sendCalls.length === 2);
    expect(adapter.sendCalls[1]).toBe(channelTurnId(m2.id, steerProfile));

    // The operator's first POST looked like it failed, so they press the button
    // again with the same clientMessageId — the route replays the steering half.
    binder.steerExisting(m2, 'interrupt');
    await new Promise((r) => setTimeout(r, 40));
    expect(adapter.interruptCalls).toHaveLength(1);
    expect(adapter.sendCalls).toHaveLength(2);
  });

  it('an agent-authored post never steers: no interrupt, one turn per trigger', async () => {
    const { binder, store, sessions } = makeSteerBinder();
    postSteering(store, binder, '@steer human opener', ['steer'], undefined);
    const adapter = await steerAdapter(sessions);
    await waitFor(() => adapter.sendCalls.length === 1);

    // A CLI-gateway agent post carrying the same flag must not cancel the turn.
    postSteering(
      store,
      binder,
      '@steer agent one',
      ['steer'],
      'interrupt',
      AGENT_SENDER
    );
    postSteering(
      store,
      binder,
      '@steer agent two',
      ['steer'],
      'interrupt',
      AGENT_SENDER
    );
    await new Promise((r) => setTimeout(r, 40));
    expect(adapter.interruptCalls).toHaveLength(0);
    expect(adapter.sendCalls).toHaveLength(1);

    // Agent triggers are never coalesced away — each keeps its own turn.
    adapter.completeLatest('reply one');
    await waitFor(() => adapter.sendCalls.length === 2);
    adapter.completeLatest('reply two');
    await waitFor(() => adapter.sendCalls.length === 3);
    expect(adapter.concurrentPeak).toBe(1);
    expect(adapter.sendInputs[1]!.content).toContain('@steer agent one');
    expect(adapter.sendInputs[2]!.content).toContain('@steer agent two');
  });

  it('supersedes the queue tail instead of dropping fast operator typing at the cap', async () => {
    const { binder, store, sessions } = makeSteerBinder();
    postSteering(store, binder, '@steer opener', ['steer'], undefined);
    const adapter = await steerAdapter(sessions);
    await waitFor(() => adapter.sendCalls.length === 1);

    // Far past QUEUE_CAP: they all collapse into the one next turn, so no slot
    // pressure and no "message dropped" row is honest here.
    const total = 20;
    let last: ChannelMessage | null = null;
    for (let i = 0; i < total; i += 1) {
      last = postSteering(
        store,
        binder,
        `@steer burst ${i}`,
        ['steer'],
        undefined
      );
    }
    await waitFor(
      () =>
        store.getMessage(last!.id) !== null && adapter.sendCalls.length === 1
    );
    await new Promise((r) => setTimeout(r, 60));
    expect(
      systemRows(store).filter((row) =>
        row.body.text.includes('message dropped')
      )
    ).toHaveLength(0);

    adapter.completeLatest('opener reply');
    await waitFor(() => adapter.sendCalls.length === 2);
    const packet = adapter.sendInputs[1]!.content;
    expect(packet.trimEnd().endsWith(`@steer burst ${total - 1}`)).toBe(true);
    expect(packet).toContain(
      `${total - 1} messages since your last turn (${PACKET_MAX_ROWS} shown, 0 activity rows filtered).`
    );
    expect(packet).toContain('[…earlier messages omitted]');
    expect(packet).toContain(`@steer burst ${total - 1 - PACKET_MAX_ROWS}`);
    expect(adapter.concurrentPeak).toBe(1);
  });

  it('publishes queuedCount on the status event and the roster payload', async () => {
    const { binder, store, sessions, events } = makeSteerBinder();
    postSteering(store, binder, '@steer one', ['steer'], undefined);
    const adapter = await steerAdapter(sessions);
    await waitFor(() => adapter.sendCalls.length === 1);
    // Every status event carries the field, additively.
    expect(events.length).toBeGreaterThan(0);
    expect(
      events.every((event) => typeof event['queuedCount'] === 'number')
    ).toBe(true);

    postSteering(store, binder, '@steer two', ['steer'], undefined);
    postSteering(store, binder, '@steer three', ['steer'], undefined);
    await waitFor(() => events.some((event) => event['queuedCount'] === 2));
    const roster = await binder.rosterForChannel(CH);
    const entry = roster.find((row) => row.providerId === 'steer');
    expect(entry?.binding?.queuedCount).toBe(2);
    expect(entry?.binding?.status).toBe('streaming');

    adapter.completeLatest('reply');
    await waitFor(() => adapter.sendCalls.length === 2);
    // The drain is reported, not left stale on the last busy count.
    expect(events[events.length - 1]?.['queuedCount']).toBe(0);
    expect(
      (await binder.rosterForChannel(CH)).find(
        (row) => row.providerId === 'steer'
      )?.binding?.queuedCount
    ).toBe(0);
  });

  // The queue is NOT seq-ordered: `handleSendFailure` re-enqueues an older,
  // already-failed trigger BEHIND whatever arrived while the transport was
  // failing. Coalescing folds older members into the newest one's packet, so a
  // run that admitted a stale head would splice a newer post out of the queue
  // while producing neither a turn for it nor a context row carrying it.
  it('a re-enqueued failed trigger never swallows a newer queued post', async () => {
    const built: SteerableAdapter[] = [];
    const { binder, store, sessions } = makeBinder({
      build: (agentType) => {
        const adapter =
          built.length === 0
            ? new ParkedSendAdapter(agentType)
            : new SteerableAdapter(agentType);
        built.push(adapter);
        return adapter;
      },
      targets: STEER_TARGETS,
      knownProviderIds: ['steer'],
    });
    const events: Array<Record<string, unknown>> = [];
    binder.setStatusBroadcaster((_type, data) => events.push(data));
    const steerProfile = builtInAgentProfileId('steer');

    const m1 = postSteering(store, binder, '@steer one', ['steer'], undefined);
    await waitFor(() => built.length === 1 && built[0]!.sendCalls.length === 1);
    const parked = built[0] as ParkedSendAdapter;

    // The runtime dies while m1's send is still in flight, so the retry lands on
    // a DIFFERENT binding and takes the re-enqueue branch rather than redeliver.
    sessions.fireEnd(sessions.firstSessionId());

    // A newer post rebinds and opens its own turn, which stalls...
    postSteering(store, binder, '@steer two', ['steer'], undefined);
    await waitFor(() => built.length === 2 && built[1]!.sendCalls.length === 1);
    const live = built[1]!;

    // ...and a newer-still post queues behind that live turn.
    const m3 = postSteering(
      store,
      binder,
      '@steer three',
      ['steer'],
      undefined
    );
    await waitFor(() => events[events.length - 1]?.['queuedCount'] === 1);

    // Only now does m1's parked send fail: it re-enqueues BEHIND m3.
    parked.failParkedSend();
    await waitFor(() => events[events.length - 1]?.['queuedCount'] === 2);

    // The drain must trigger on the NEWEST queued post, not the queue tail.
    live.completeLatest('two reply');
    await waitFor(() => live.sendCalls.length === 2);
    expect(live.sendCalls[1]).toBe(channelTurnId(m3.id, steerProfile));
    expect(live.sendInputs[1]!.content).toContain('@steer three');

    // ...and the re-enqueued older trigger is not lost either — it drains next.
    live.completeLatest('three reply');
    await waitFor(() => live.sendCalls.length === 3);
    expect(live.sendCalls[2]).toBe(channelTurnId(m1.id, steerProfile));
    expect(live.concurrentPeak).toBe(1);
  });

  // Same setup as above with ONE reordering: m1's parked send fails BEFORE the
  // third post, so the re-enqueued trigger is the run's HEAD rather than a
  // coalescing candidate. The seq-monotonicity guard does not fire here
  // (m3.seq > m1.seq), so without the `reEnqueued` rule `pump` would splice both
  // out and trigger on m3 — and m1 could not come back as a context row either,
  // because m2's successful send already advanced `lastDeliveredSeq` past it.
  it('gives a re-enqueued failed trigger its own turn when it heads the queue', async () => {
    const built: SteerableAdapter[] = [];
    const { binder, store, sessions } = makeBinder({
      build: (agentType) => {
        const adapter =
          built.length === 0
            ? new ParkedSendAdapter(agentType)
            : new SteerableAdapter(agentType);
        built.push(adapter);
        return adapter;
      },
      targets: STEER_TARGETS,
      knownProviderIds: ['steer'],
    });
    const events: Array<Record<string, unknown>> = [];
    binder.setStatusBroadcaster((_type, data) => events.push(data));
    const steerProfile = builtInAgentProfileId('steer');

    const m1 = postSteering(store, binder, '@steer one', ['steer'], undefined);
    await waitFor(() => built.length === 1 && built[0]!.sendCalls.length === 1);
    const parked = built[0] as ParkedSendAdapter;

    sessions.fireEnd(sessions.firstSessionId());

    // m2 rebinds, delivers (advancing the delivery cursor past m1), and stalls.
    postSteering(store, binder, '@steer two', ['steer'], undefined);
    await waitFor(() => built.length === 2 && built[1]!.sendCalls.length === 1);
    const live = built[1]!;

    // m1's parked send fails FIRST, so it re-enqueues at the head of the queue.
    parked.failParkedSend();
    await waitFor(() => events[events.length - 1]?.['queuedCount'] === 1);

    // ...and only then does a newer post land behind it.
    const m3 = postSteering(
      store,
      binder,
      '@steer three',
      ['steer'],
      undefined
    );
    await waitFor(() => events[events.length - 1]?.['queuedCount'] === 2);

    // m1 must reach the adapter as its OWN trigger — the footer renders a
    // trigger unconditionally, which is the only place it can still be carried.
    live.completeLatest('two reply');
    await waitFor(() => live.sendCalls.length === 2);
    expect(live.sendCalls[1]).toBe(channelTurnId(m1.id, steerProfile));
    expect(live.sendInputs[1]!.content).toContain('@steer one');

    // ...and the newer post is not lost to the re-enqueue either.
    live.completeLatest('one reply');
    await waitFor(() => live.sendCalls.length === 3);
    expect(live.sendCalls[2]).toBe(channelTurnId(m3.id, steerProfile));
    expect(live.sendInputs[2]!.content).toContain('@steer three');
    expect(live.concurrentPeak).toBe(1);
    expect(systemRows(store)).toHaveLength(0);
  });

  // The packet image budget is per PACKET, not per message, so folding N
  // image-bearing posts into one turn would silently spend one budget on all of
  // them. Attachments are operator content the slice promised not to drop.
  it('never coalesces image-bearing posts, so each keeps its own image budget', async () => {
    const { binder, store, sessions, events } = makeSteerBinder();
    postSteering(store, binder, '@steer opener', ['steer'], undefined);
    const adapter = await steerAdapter(sessions);
    await waitFor(() => adapter.sendCalls.length === 1);
    const steerProfile = builtInAgentProfileId('steer');

    const shotA = postSteerImage(store, binder, '@steer shot a', 'cha:shot-a');
    const shotB = postSteerImage(store, binder, '@steer shot b', 'cha:shot-b');
    await waitFor(() => events[events.length - 1]?.['queuedCount'] === 2);

    adapter.completeLatest('opener reply');
    await waitFor(() => adapter.sendCalls.length === 2);
    expect(adapter.sendCalls[1]).toBe(channelTurnId(shotA.id, steerProfile));
    adapter.completeLatest('shot a reply');
    await waitFor(() => adapter.sendCalls.length === 3);
    expect(adapter.sendCalls[2]).toBe(channelTurnId(shotB.id, steerProfile));
    expect(adapter.concurrentPeak).toBe(1);
  });

  it('parents a refused steering interrupt to the thread it was issued from', async () => {
    const { binder, store, sessions } = makeBinder({
      build: (agentType) => new RefusingInterruptAdapter(agentType),
      targets: STEER_TARGETS,
      knownProviderIds: ['steer'],
    });
    const root = store.appendComplete({
      channelId: CH,
      sender: OPERATOR,
      text: 'thread root',
    });
    post(store, binder, '@steer long task', ['steer'], OPERATOR, root.id);
    await waitFor(() => sessions.spawns() === 1);
    const adapter = sessions.adapterFor(
      sessions.firstSessionId()
    ) as RefusingInterruptAdapter;
    await waitFor(() => adapter.sendCalls.length === 1);

    const steer = postSteering(
      store,
      binder,
      '@steer stop that',
      ['steer'],
      'interrupt',
      OPERATOR,
      root.id
    );
    await waitFor(() =>
      systemRows(store).some((row) =>
        row.body.text.includes('could not be interrupted')
      )
    );
    const failure = systemRows(store).find((row) =>
      row.body.text.includes('could not be interrupted')
    )!;
    // Without this the explanation lands at channel top level, away from the
    // thread the operator was actually working in.
    expect(failure.threadId).toBe(root.id);
    expect(failure.parentMessageId).toBe(steer.id);
  });
});

// ── presence teardown (#1307) ────────────────────────────────────────────────
// A runtime that dies without a terminal transition used to pin channel-agent
// presence at thinking/streaming/waiting: the header chip AND the in-timeline
// presence row render the same broadcast, and the watchdog cannot bound the
// worst case (it is disarmed for as long as `waitingOn !== null`). Every
// teardown path must therefore end in an `idle` broadcast of its own.

const PARKED_TARGETS: MentionTarget[] = [
  {
    id: 'parked',
    displayName: 'Parked',
    kind: 'framework',
    available: true,
    reason: null,
  },
];

function makeParkedBinder(cfg: { presenceSweepMs?: number } = {}) {
  const harness = makeBinder({
    build: (agentType) => new ParkedOnApprovalAdapter(agentType),
    targets: PARKED_TARGETS,
    knownProviderIds: ['parked'],
    ...(cfg.presenceSweepMs !== undefined
      ? { presenceSweepMs: cfg.presenceSweepMs }
      : {}),
  });
  const events: Array<Record<string, unknown>> = [];
  const statuses: string[] = [];
  harness.binder.setStatusBroadcaster((_type, data) => {
    if (data['agentId'] === builtInAgentProfileId('parked')) {
      events.push(data);
      statuses.push(String(data['status']));
    }
  });
  return { ...harness, events, statuses };
}

async function parkedOnApproval(
  harness: ReturnType<typeof makeParkedBinder>
): Promise<ParkedOnApprovalAdapter> {
  await waitFor(() => harness.sessions.spawns() === 1);
  const adapter = harness.sessions.adapterFor(
    harness.sessions.firstSessionId()
  ) as ParkedOnApprovalAdapter;
  await waitFor(() => adapter.sendCalls.length === 1);
  await waitFor(() => harness.statuses.at(-1) === 'waiting');
  return adapter;
}

describe('channel-agent-binder — presence teardown (#1307)', () => {
  it('broadcasts a terminal idle when the runtime dies under a turn parked on approval', async () => {
    const harness = makeParkedBinder();
    const { binder, store, statuses } = harness;
    post(store, binder, '@parked go', ['parked']);
    const adapter = await parkedOnApproval(harness);

    // The watchdog is explicitly disarmed in this state, so nothing else can
    // ever move this binding off 'waiting'.
    adapter.die();
    await waitFor(() => statuses.at(-1) === 'idle');
    expect(statuses).toContain('waiting');
    expect(statuses.at(-1)).toBe('idle');
  });

  it('drops the queue on the same broadcast as the terminal idle, so no chip stays lit against a dead runtime', async () => {
    // `onRuntimeEnd` never fires here (the death is the adapter's own report),
    // so this covers the window BEFORE `releaseBinding` — up to a whole sweep
    // interval when the teardown event never arrives at all. An idle broadcast
    // carrying `queuedCount > 0` would leave the #1308 queued-send chips lit
    // with nothing left to drain them.
    const harness = makeParkedBinder();
    const { binder, store, events, statuses } = harness;
    post(store, binder, '@parked one', ['parked']);
    const adapter = await parkedOnApproval(harness);
    post(store, binder, '@parked two', ['parked']);
    await waitFor(() => events.at(-1)?.['queuedCount'] === 1);

    adapter.die();
    await waitFor(() => statuses.at(-1) === 'idle');
    expect(events.at(-1)?.['queuedCount']).toBe(0);
    // One row per dropped trigger, and nothing was pumped into the dead adapter.
    expect(
      systemRows(store).filter((row) =>
        row.body.text.includes(
          'runtime ended before delivering a queued message'
        )
      )
    ).toHaveLength(1);
    expect(adapter.sendCalls).toHaveLength(1);
  });

  it('sweeps a binding whose runtime vanished with no end event to idle, drains its queue, and durably unbinds', async () => {
    const harness = makeParkedBinder({ presenceSweepMs: 10 });
    const { binder, store, sessions, events, statuses } = harness;
    post(store, binder, '@parked one', ['parked']);
    await parkedOnApproval(harness);
    post(store, binder, '@parked two', ['parked']);
    await waitFor(() => events.at(-1)?.['queuedCount'] === 1);

    // The runtime disappears WITHOUT `onRuntimeEnd` ever firing — a release that
    // threw halfway, a manager torn down out from under the binder, any teardown
    // path that never reaches the one event the binder subscribes to.
    sessions.forgetWithoutEnd(sessions.firstSessionId());

    await waitFor(() => statuses.at(-1) === 'idle');
    expect(events.at(-1)?.['queuedCount']).toBe(0);
    expect(
      store.getBinding(CH, builtInAgentProfileId('parked'))?.runtimeId
    ).toBeNull();
    const ended = systemRows(store).filter((row) =>
      row.body.text.includes('runtime ended before delivering a queued message')
    );
    expect(ended).toHaveLength(1);
    // Nothing re-routes on its own: a swept binding stays down until the next
    // mention, so the operator never gets a silent respawn they did not ask for.
    expect(sessions.spawns()).toBe(1);
  });

  it('leaves a live runtime alone: the sweep never retires a binding that is genuinely waiting', async () => {
    const harness = makeParkedBinder({ presenceSweepMs: 5 });
    const { binder, store, statuses } = harness;
    post(store, binder, '@parked go', ['parked']);
    await parkedOnApproval(harness);
    // Many sweep ticks with the runtime still registered and healthy.
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(statuses.at(-1)).toBe('waiting');
  });

  it('broadcasts a terminal idle for a busy binding on shutdown', async () => {
    const harness = makeParkedBinder();
    const { binder, store, statuses } = harness;
    post(store, binder, '@parked go', ['parked']);
    await parkedOnApproval(harness);
    binder.close();
    expect(statuses.at(-1)).toBe('idle');
  });
});

// ── typed delivery receipts (#1442) ──────────────────────────────────────────
// Every outcome that already produces a prose system row must ALSO emit one
// content-free `channel-delivery-receipt-v1` event through the hub. These tests
// read the hub side of the fan-out (the receipts ring), so the transport and
// query surface are exercised together with the emission points.

function collectReceipts(
  hub: ChannelHub,
  channelId: string
): ChannelDeliveryReceiptV1[] {
  return hub.listDeliveryReceipts({ channelId }).reverse(); // oldest-first
}

describe('channel-agent-binder — delivery receipts (#1442)', () => {
  it('emits queued → turn_started in order with a content-free payload', async () => {
    const { binder, store, hub, sessions } = makeBinder({
      build: (agentType) => new ScriptedAdapter(agentType, { mode: 'stall' }),
      targets: MOCK_TARGETS,
      knownProviderIds: ['mock'],
    });
    const trigger = post(store, binder, '@mock go', ['mock']);
    await waitFor(() => sessions.spawns() === 1);
    const adapter = sessions.adapterFor(
      sessions.firstSessionId()
    ) as ScriptedAdapter;
    await waitFor(() => adapter.sendCalls.length === 1);
    const forMessage = collectReceipts(hub, CH).filter(
      (r) => r.messageId === trigger.id
    );
    // The scripted stall adapter ACCEPTS the send (stall models a stuck
    // provider turn, not a rejected transport), so acceptance lands too.
    expect(forMessage.map((r) => r.state)).toEqual([
      'queued',
      'turn_started',
      'delivered_to_runtime',
    ]);
    expect(forMessage[0]).toMatchObject({
      channelId: CH,
      targetProfileId: builtInAgentProfileId('mock'),
      senderProfileId: null,
    });
    // Content-free by construction: identity/outcome keys only, no text field.
    const allowedKeys = [
      'channelId',
      'messageId',
      'reasonCode',
      'senderProfileId',
      'state',
      'targetBindingId',
      'targetProfileId',
      'ts',
    ];
    for (const r of forMessage) {
      for (const key of Object.keys(r)) {
        expect(allowedKeys).toContain(key);
      }
      expect(JSON.stringify(r)).not.toContain('"text"');
    }
  });

  it('marks an over-cap steering drop as dropped_queue_full alongside the prose row', async () => {
    const { binder, store, hub, sessions } = makeBinder({
      build: (agentType) => new SteerableAdapter(agentType, true),
      targets: STEER_TARGETS,
      knownProviderIds: ['steer'],
    });
    postSteering(store, binder, '@steer opener', ['steer'], undefined);
    const adapter = await steerAdapter(sessions);
    await waitFor(() => adapter.sendCalls.length === 1);
    // Accepted steers hold aggregate slots; the overflow post takes the drop.
    let overflow: ChannelMessage | null = null;
    for (let i = 0; i < 9; i++) {
      overflow = postSteering(
        store,
        binder,
        `@steer ${i}`,
        ['steer'],
        undefined
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(overflow).not.toBeNull();
    const drops = collectReceipts(hub, CH).filter(
      (r) => r.messageId === overflow!.id && r.state === 'dropped_queue_full'
    );
    expect(drops).toHaveLength(1);
    expect(drops[0]!.reasonCode).toBe('steering_queue_cap');
    expect(
      systemRows(store).some((row) => row.body.text.includes('message dropped'))
    ).toBe(true);
  });

  it('emits superseded + queued for a queue-merge supersede', async () => {
    const { binder, store, hub } = makeBinder({
      build: () => new ScriptedAdapter('stall', { mode: 'stall' }),
      targets: [
        {
          id: 'stall',
          displayName: 'Stall',
          kind: 'framework',
          available: true,
          reason: null,
        },
      ],
      knownProviderIds: ['stall'],
    });
    const root = store.appendComplete({
      channelId: CH,
      sender: OPERATOR,
      text: 'root',
    });
    // One live turn plus cap+1 coalescing posts: each over-cap post supersedes
    // the queue tail instead of being dropped.
    const posted: ChannelMessage[] = [];
    let last: ChannelMessage | null = null;
    for (let i = 1; i <= 10; i++) {
      last = post(store, binder, `@stall t${i}`, ['stall'], OPERATOR, root.id);
      posted.push(last);
    }
    await new Promise((resolve) => setTimeout(resolve, 60));
    const receipts = collectReceipts(hub, CH);
    const supersededIds = new Set(
      receipts.filter((r) => r.state === 'superseded').map((r) => r.messageId)
    );
    expect(supersededIds.size).toBeGreaterThanOrEqual(1);
    // Every superseded id is one of the queued posts (never the live trigger).
    const liveTrigger = receipts.find(
      (r) => r.state === 'turn_started'
    )!.messageId;
    for (const id of supersededIds) {
      expect(posted.some((m) => m.id === id)).toBe(true);
      expect(id).not.toBe(liveTrigger);
    }
    const superseded = receipts.find((r) => r.state === 'superseded')!;
    expect(superseded.reasonCode).toBe('superseded_by_newer');
    expect(
      receipts.some((r) => r.messageId === last!.id && r.state === 'queued')
    ).toBe(true);
  });

  it('marks watchdog expiry as expired_watchdog', async () => {
    const { binder, store, hub, sessions } = makeBinder({
      build: () => new ScriptedAdapter('stall', { mode: 'stall' }),
      targets: [
        {
          id: 'stall',
          displayName: 'Stall',
          kind: 'framework',
          available: true,
          reason: null,
        },
      ],
      knownProviderIds: ['stall'],
      watchdogMs: 25,
    });
    post(store, binder, '@stall stuck', ['stall']);
    await waitFor(() => sessions.spawns() === 1);
    const adapter = sessions.adapterFor(
      sessions.firstSessionId()
    ) as ScriptedAdapter;
    await waitFor(() => adapter.sendCalls.length === 1);
    await waitFor(() =>
      collectReceipts(hub, CH).some((r) => r.state === 'expired_watchdog')
    );
    const wd = collectReceipts(hub, CH).find(
      (r) => r.state === 'expired_watchdog'
    )!;
    expect(wd.reasonCode).toBe('watchdog_force_drain');
  });

  it('marks a rejected send as failed_runtime after retries are exhausted', async () => {
    const { binder, store, hub } = makeBinder({
      build: () => new ScriptedAdapter('x', { mode: 'reject' }),
      targets: [
        {
          id: 'x',
          displayName: 'X',
          kind: 'framework',
          available: true,
          reason: null,
        },
      ],
      knownProviderIds: ['x'],
    });
    const trigger = post(store, binder, '@x go', ['x']);
    await waitFor(() =>
      systemRows(store).some((m) => m.body.text.includes('could not receive'))
    );
    const failures = collectReceipts(hub, CH).filter(
      (r) => r.messageId === trigger.id && r.state === 'failed_runtime'
    );
    expect(failures.length).toBeGreaterThanOrEqual(1);
  });

  it('marks runtime death mid-queue as failed_runtime/runtime_ended per queued trigger', async () => {
    const harness = makeParkedBinder();
    const { binder, store, hub, events } = harness;
    post(store, binder, '@parked one', ['parked']);
    const adapter = await parkedOnApproval(harness);
    const queued = post(store, binder, '@parked two', ['parked']);
    await waitFor(() => events.at(-1)?.['queuedCount'] === 1);
    adapter.die();
    await waitFor(() =>
      systemRows(store).some((row) =>
        row.body.text.includes('runtime ended before delivering')
      )
    );
    const ended = collectReceipts(hub, CH).filter(
      (r) => r.messageId === queued.id && r.state === 'failed_runtime'
    );
    expect(ended).toHaveLength(1);
    expect(ended[0]!.reasonCode).toBe('runtime_ended');
  });

  it('marks an unavailable provider as unreachable_offline', async () => {
    const { binder, store, hub } = makeBinder({
      build: () => new ScriptedAdapter('gone', { mode: 'reply', text: 'hi' }),
      targets: [
        {
          id: 'gone',
          displayName: 'Gone',
          kind: 'framework',
          available: false,
          reason: 'framework unavailable',
        },
      ],
      knownProviderIds: ['gone'],
    });
    const trigger = post(store, binder, '@gone hi', ['gone']);
    await waitFor(() =>
      systemRows(store).some((m) => m.body.text.includes('not available'))
    );
    const offline = collectReceipts(hub, CH).filter(
      (r) => r.messageId === trigger.id && r.state === 'unreachable_offline'
    );
    expect(offline).toHaveLength(1);
    expect(offline[0]!.reasonCode).toBe('runtime_unavailable');
  });
});

describe('channel-agent-binder — host-local CLI requester (#1533)', () => {
  /** `deriveSender` stamps the #1467 host-local CLI credential like this. */
  const LOCAL_CLI_SENDER: ChannelSenderRef = {
    kind: 'agent',
    id: 'agent:local-cli',
    providerId: 'local-cli',
    displayName: 'relay-ide local CLI',
  };

  it('schedules no completion callback for a host-local CLI post', async () => {
    const { binder, store } = makeBinder({
      build: (agentType) =>
        new ScriptedAdapter(agentType, { mode: 'reply', text: 'done' }),
      targets: MOCK_TARGETS,
      knownProviderIds: ['mock'],
    });
    const { run } = postWithAsyncRun(
      store,
      binder,
      '@mock do the thing',
      ['mock'],
      LOCAL_CLI_SENDER
    );
    await waitFor(() => agentReplies(store, 'mock').length === 1);
    await waitFor(() => store.getAsyncRun(run.id)?.state === 'completed');
    expect(store.getAsyncRun(run.id)).toMatchObject({
      state: 'completed',
      targets: [
        { targetId: builtInAgentProfileId('mock'), state: 'completed' },
      ],
    });
    // No `agent-profile:local-cli:default` edge was ever created, so nothing
    // can terminalize as `requester-profile-unavailable` (#1533).
    expect(store.claimSatisfiedCompletionCallbacks()).toEqual([]);
  });

  it('records an unavailable requester as undeliverable without failing a running target', async () => {
    const { binder, store } = makeBinder({
      build: (agentType) => new ScriptedAdapter(agentType, { mode: 'stall' }),
      targets: MOCK_TARGETS,
      knownProviderIds: ['mock'],
    });
    const { run } = postWithAsyncRun(store, binder, '@mock long job', ['mock']);
    await waitFor(
      () => store.getAsyncRun(run.id)?.targets[0]?.state === 'working'
    );

    const edge = store.createCompletionCallback({
      id: 'chcb:unavailable-requester-running-target',
      channelId: CH,
      threadId: null,
      triggerMessageId: run.requestMessageId,
      requesterProfileId: 'agent-profile:missing',
      targetProfileId: builtInAgentProfileId('mock'),
      targetRuntimeId: 'runtime:mock',
      targetTurnId: 'turn:unavailable-requester-running-target',
    });
    store.satisfyCompletionCallback({
      channelId: edge.channelId,
      targetProfileId: edge.targetProfileId,
      targetTurnId: edge.targetTurnId,
      terminalReason: 'completed',
      messageDisposition: 'no-terminal-message',
    });
    await binder.recoverCompletionCallbacks();
    await waitFor(
      () => store.getCompletionCallback(edge.id)?.state === 'undeliverable'
    );

    expect(store.getCompletionCallback(edge.id)).toMatchObject({
      state: 'undeliverable',
      deliveryReason: 'requester-profile-unavailable',
    });
    // The target is still working: an undeliverable callback records delivery,
    // it never terminalizes the run it rode in on (#1533).
    expect(store.getAsyncRun(run.id)).toMatchObject({
      state: 'working',
      targets: [{ targetId: builtInAgentProfileId('mock'), state: 'working' }],
    });
  });
});

describe('channel-agent-binder — topic routing cwd (#1534)', () => {
  const WORKTREE = '/repo/relay/.worktrees/lane';

  function makeTopicStore(): WorkspaceTopicStore {
    const topicStore = createWorkspaceTopicStore({ dbPath: ':memory:' });
    cleanup.push(() => topicStore.close());
    return topicStore;
  }

  it('spawns the runtime in the topic worktree cwd, verbatim', async () => {
    const topicStore = makeTopicStore();
    topicStore.create({
      id: CH,
      workspaceId: 'ws:local',
      title: 'lane',
      routingDefaults: { repoPath: '/repo/relay', cwd: WORKTREE },
    });
    const { binder, store, sessions } = makeBinder({
      build: (agentType) =>
        new ScriptedAdapter(agentType, { mode: 'reply', text: 'ok' }),
      targets: MOCK_TARGETS,
      knownProviderIds: ['mock'],
      topicStore,
    });

    post(store, binder, '@mock where am i', ['mock']);
    await waitFor(() => agentReplies(store, 'mock').length === 1);
    // The worktree wins over repoPath: a worktree cwd is the whole point of
    // `routingDefaults.cwd`, and nothing between here and `spawn` rewrites it.
    expect(sessions.createParams()[0]).toMatchObject({
      cwd: WORKTREE,
      repoPath: '/repo/relay',
    });
  });

  it('reports a reused runtime whose cwd no longer matches the topic routing cwd', async () => {
    const topicStore = makeTopicStore();
    topicStore.create({
      id: CH,
      workspaceId: 'ws:local',
      title: 'lane',
      routingDefaults: { cwd: '/repo/relay' },
    });
    const { binder, store, sessions } = makeBinder({
      build: (agentType) =>
        new ScriptedAdapter(agentType, { mode: 'reply', text: 'ok' }),
      targets: MOCK_TARGETS,
      knownProviderIds: ['mock'],
      topicStore,
    });

    post(store, binder, '@mock first', ['mock']);
    await waitFor(() => agentReplies(store, 'mock').length === 1);
    expect(sessions.createParams()[0]).toMatchObject({ cwd: '/repo/relay' });

    // Point the topic at a worktree AFTER the runtime is live. The runtime
    // keeps its spawn cwd, so the operator has to be told (#1534).
    topicStore.update(CH, { routingDefaults: { cwd: WORKTREE } });
    post(store, binder, '@mock second', ['mock']);
    await waitFor(() =>
      systemRows(store).some((m) => m.body.text.includes(WORKTREE))
    );
    const diverged = systemRows(store).filter((m) =>
      m.body.text.includes(WORKTREE)
    );
    expect(diverged).toHaveLength(1);
    expect(diverged[0]!.body.text).toContain('/repo/relay');
    expect(sessions.spawns()).toBe(1); // reuse never restarts behind the operator

    // The same divergence is reported once, not once per turn.
    post(store, binder, '@mock third', ['mock']);
    await waitFor(() => agentReplies(store, 'mock').length === 3);
    expect(
      systemRows(store).filter((m) => m.body.text.includes(WORKTREE))
    ).toHaveLength(1);
  });
});
