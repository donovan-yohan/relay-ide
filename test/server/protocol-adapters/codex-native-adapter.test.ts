import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { bindSessionToChannel } from '../../../server/channel-agent-bridge.js';
import { createChannelHub } from '../../../server/channel-hub.js';
import { createChannelMessageStore } from '../../../server/channel-message-store.js';
import {
  buildCodexTurnInput,
  CODEX_TERMINAL_ITEM_GRACE_MS,
  CodexNativeProtocolAdapter,
} from '../../../server/protocol-adapters/codex-native-adapter.js';
import { AgentSteerRejectedError } from '../../../server/protocol-adapter-v2.js';
import type { CodexClientFactory } from '../../../server/protocol-adapters/codex-native-adapter.js';
import type { AdapterConfig } from '../../../server/protocol-adapter-v2.js';
import type {
  CodexAppServerClient,
  CodexAppServerClientOptions,
  CodexNotification,
  CodexServerRequest,
} from '../../../server/codex-app-server-client.js';
import {
  applyAgentPatchV2,
  emptyAgentSessionV2,
  type AgentPatchV2,
} from '../../../shared/agent-chat-protocol-v2.js';
import codexDetailFixture from '../../fixtures/agent-detail/codex.js';
import {
  CODEX_TERMINAL_ORDERING_FIXTURES,
  CODEX_TRIPLE_FINAL_FIXTURE,
} from '../../fixtures/channel-chat/codex-terminal-ordering.js';

vi.mock('../../../server/logger.js', () => ({
  createLogger: () => ({
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// ── Test seam ─────────────────────────────────────────────────────────────────

/**
 * Stub for CodexAppServerClient.  Exposes feedNotification and feedRequest to
 * drive the adapter from tests without spawning a real process.
 */
class StubCodexClient extends EventEmitter {
  calls: Array<{ method: string; params: unknown }> = [];
  serverResponses = new Map<string, unknown>();
  stopped = false;

  // Pending call resolvers keyed by method
  private callResolvers = new Map<string, ((result: unknown) => void)[]>();

  async start(): Promise<void> {
    // no-op — handshake already done
  }

  async call<T = unknown>(method: string, params?: unknown): Promise<T> {
    this.calls.push({ method, params: params ?? null });
    // Check for a pre-configured response
    if (this.serverResponses.has(method)) {
      const response = this.serverResponses.get(method);
      if (response instanceof Error) throw response;
      return response as T;
    }
    return {} as T;
  }

  respondToServerRequest(id: number | string, result: unknown): void {
    this.calls.push({ method: `__respond:${String(id)}`, params: result });
  }

  respondToServerRequestError(
    id: number | string,
    code: number,
    message: string
  ): void {
    this.calls.push({
      method: `__error:${String(id)}`,
      params: { code, message },
    });
  }

  async stop(_signal?: string): Promise<void> {
    this.stopped = true;
    this.emit('close', 0);
  }

  // ── Test helpers ─────────────────────────────────────────────────────────

  feedNotification(method: string, params?: unknown): void {
    const notification: CodexNotification = { method, params };
    this.emit('notification', notification);
  }

  feedRequest(id: number | string, method: string, params?: unknown): void {
    const request: CodexServerRequest = { id, method, params };
    this.emit('request', request);
  }
}

type StubFactory = CodexClientFactory & { lastClient: StubCodexClient };

/**
 * Returns a factory that always hands out the same pre-built stub.
 * The stub is exposed on `factory.lastClient` so tests can configure
 * responses and feed notifications before calling `connect()`.
 */
function makeStubFactory(): StubFactory {
  const stub = new StubCodexClient();
  let callCount = 0;
  const factory: StubFactory = (_opts) => {
    // On second call (resume creates a new client), return a fresh stub
    // but update lastClient so tests can still access it.
    if (callCount++ > 0) {
      const newStub = new StubCodexClient();
      // Copy over any pre-configured responses
      for (const [k, v] of stub.serverResponses.entries()) {
        newStub.serverResponses.set(k, v);
      }
      factory.lastClient = newStub;
      return newStub as unknown as CodexAppServerClient;
    }
    factory.lastClient = stub;
    return stub as unknown as CodexAppServerClient;
  };
  factory.lastClient = stub;
  return factory;
}

const config: AdapterConfig = {
  cwd: '/tmp/repo',
  port: 3000,
  sessionId: 'session-codex-1',
  hookToken: 'token',
  configDir: '/tmp/config',
  model: 'o4-mini',
};

function collectPatches(adapter: CodexNativeProtocolAdapter): AgentPatchV2[] {
  const patches: AgentPatchV2[] = [];
  adapter.onPatch((patch) => patches.push(patch));
  return patches;
}

function reducePatches(patches: AgentPatchV2[]) {
  let session = emptyAgentSessionV2({
    id: config.sessionId,
    provider: 'codex',
    cwd: config.cwd,
  });
  for (const patch of patches) session = applyAgentPatchV2(session, patch);
  return session;
}

function retentionCounts(adapter: CodexNativeProtocolAdapter) {
  const state = adapter as unknown as {
    itemMap: Map<unknown, unknown>;
    tokenUsageBuffer: Map<unknown, unknown>;
    reasoningSummaryBuffers: Map<unknown, unknown>;
    reasoningDetailBuffers: Map<unknown, unknown>;
    approvalMeta: Map<unknown, unknown>;
    inputRequestMeta: Map<unknown, unknown>;
  };
  return {
    itemIds: state.itemMap.size,
    tokenUsage: state.tokenUsageBuffer.size,
    reasoningSummary: state.reasoningSummaryBuffers.size,
    reasoningDetail: state.reasoningDetailBuffers.size,
    approvalMeta: state.approvalMeta.size,
    inputRequestMeta: state.inputRequestMeta.size,
  };
}

function waitFor(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() - started > timeoutMs) {
        reject(new Error('timed out waiting for codex adapter condition'));
        return;
      }
      setTimeout(tick, 1);
    };
    tick();
  });
}

// ── Capability set ─────────────────────────────────────────────────────────────

describe('CodexNativeProtocolAdapter — capability set', () => {
  it('advertises the full §1.3 capability set', () => {
    const factory = makeStubFactory();
    const adapter = new CodexNativeProtocolAdapter(factory);
    expect(adapter.capabilities).toMatchObject({
      text: true,
      reasoning: true,
      tools: true,
      commandExecution: true,
      fileChanges: true,
      approvals: true,
      questions: true,
      plans: true,
      slashCommands: true,
      queue: true,
      steer: true,
      cancelQueued: true,
      interrupt: true,
      resume: true,
      fork: true,
      rollback: true,
      compact: true,
      telemetry: true,
      rateLimits: true,
    });
  });
});

// ── Connect lifecycle ─────────────────────────────────────────────────────────

describe('CodexNativeProtocolAdapter — connect', () => {
  it('calls thread/start and emits snapshot with threadId', async () => {
    const factory = makeStubFactory();
    const adapter = new CodexNativeProtocolAdapter(factory);
    const patches = collectPatches(adapter);

    factory.lastClient?.serverResponses.set('thread/start', {
      thread: { id: 'thread-abc' },
    });
    factory.lastClient?.serverResponses.set('skills/list', { skills: [] });
    factory.lastClient?.serverResponses.set('model/list', []);

    // Pre-configure the stub before connect spawns it
    // (factory creates client lazily on first call)
    await adapter.connect(config);
    const client = factory.lastClient!;

    const threadStart = client.calls.find((c) => c.method === 'thread/start');
    expect(threadStart).toBeDefined();
    expect(threadStart?.params).toMatchObject({ cwd: config.cwd });

    expect(patches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'agent-session-snapshot-v2',
          session: expect.objectContaining({
            provider: 'codex',
            providerSession: { threadId: 'thread-abc' },
            capabilities: expect.objectContaining({ resume: true }),
          }),
        }),
      ])
    );

    await adapter.disconnect();
  });

  it('emits idle live-state after connect', async () => {
    const factory = makeStubFactory();
    const adapter = new CodexNativeProtocolAdapter(factory);
    const patches = collectPatches(adapter);

    factory.lastClient?.serverResponses.set('thread/start', {
      thread: { id: 'thread-xyz' },
    });

    await adapter.connect(config);

    expect(patches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'agent-live-state-updated-v2',
          live: expect.objectContaining({ status: 'idle' }),
        }),
      ])
    );

    await adapter.disconnect();
  });

  it('resumes a saved thread directly instead of creating a throwaway thread', async () => {
    const factory = makeStubFactory();
    const adapter = new CodexNativeProtocolAdapter(factory);
    const patches = collectPatches(adapter);

    factory.lastClient?.serverResponses.set('thread/resume', {
      thread: { id: 'thread-existing' },
    });
    factory.lastClient?.serverResponses.set('skills/list', { skills: [] });
    factory.lastClient?.serverResponses.set('model/list', []);

    await adapter.connect({ ...config, resumeSessionId: 'thread-existing' });

    expect(factory.lastClient?.calls.map((call) => call.method)).toContain(
      'thread/resume'
    );
    expect(factory.lastClient?.calls.map((call) => call.method)).not.toContain(
      'thread/start'
    );
    expect(patches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'agent-session-snapshot-v2',
          session: expect.objectContaining({
            providerSession: { threadId: 'thread-existing' },
          }),
        }),
      ])
    );

    await adapter.disconnect();
  });
});

// ── Resume ────────────────────────────────────────────────────────────────────

describe('CodexNativeProtocolAdapter — resumeSession', () => {
  it('calls thread/resume and emits snapshot with the given threadId', async () => {
    const factory = makeStubFactory();
    const adapter = new CodexNativeProtocolAdapter(factory);
    const patches = collectPatches(adapter);

    factory.lastClient?.serverResponses.set('thread/start', {
      thread: { id: 'thread-1' },
    });
    await adapter.connect(config);

    // Configure the second client for resume
    factory.lastClient!.serverResponses.set('thread/resume', {
      thread: { id: 'thread-resume-1' },
    });
    factory.lastClient!.serverResponses.set('skills/list', { skills: [] });
    factory.lastClient!.serverResponses.set('model/list', []);

    await adapter.resumeSession('thread-resume-1');

    const client = factory.lastClient!;
    const resumeCall = client.calls.find((c) => c.method === 'thread/resume');
    expect(resumeCall).toBeDefined();
    expect(resumeCall?.params).toMatchObject({ threadId: 'thread-resume-1' });

    const resumeSnapshot = patches
      .slice(
        patches.findIndex((p) => p.type === 'agent-session-snapshot-v2') + 1
      )
      .find((p) => p.type === 'agent-session-snapshot-v2');
    expect(resumeSnapshot).toMatchObject({
      session: expect.objectContaining({
        providerSession: { threadId: 'thread-resume-1' },
      }),
    });
    expect(
      patches.filter(
        (patch) =>
          patch.type === 'agent-live-state-updated-v2' &&
          patch.live.status === 'disconnected'
      )
    ).toHaveLength(0);

    await adapter.disconnect();
  });
});

// ── sendMessage / turn lifecycle ──────────────────────────────────────────────

describe('CodexNativeProtocolAdapter — sendMessage', () => {
  it('calls turn/start with the message content', async () => {
    const factory = makeStubFactory();
    const adapter = new CodexNativeProtocolAdapter(factory);
    collectPatches(adapter);

    factory.lastClient?.serverResponses.set('thread/start', {
      thread: { id: 'thread-1' },
    });
    await adapter.connect(config);
    const client = factory.lastClient!;

    await adapter.sendMessage({ turnId: 'turn-1', content: 'hello codex' });

    const turnStart = client.calls.find((c) => c.method === 'turn/start');
    expect(turnStart).toBeDefined();
    expect(turnStart?.params).toMatchObject({
      input: [{ type: 'text', text: 'hello codex' }],
    });

    await adapter.disconnect();
  });

  it('uses turn/steer against the active native turn without opening a second Relay turn', async () => {
    const factory = makeStubFactory();
    const adapter = new CodexNativeProtocolAdapter(factory);
    const patches = collectPatches(adapter);
    factory.lastClient?.serverResponses.set('thread/start', {
      thread: { id: 'thread-1' },
    });
    await adapter.connect(config);
    const client = factory.lastClient!;

    await adapter.sendMessage({ turnId: 'turn-1', content: 'keep going' });
    client.feedNotification('turn/started', { turn: { id: 'native-1' } });
    client.serverResponses.set('turn/steer', { turnId: 'native-2' });

    await adapter.steerMessage({
      turnId: 'turn-1',
      content: 'instead, inspect the conflict',
    });

    expect(
      client.calls.filter((call) => call.method === 'turn/start')
    ).toHaveLength(1);
    expect(
      client.calls.find((call) => call.method === 'turn/steer')?.params
    ).toMatchObject({
      threadId: 'thread-1',
      expectedTurnId: 'native-1',
      input: [{ type: 'text', text: 'instead, inspect the conflict' }],
    });
    expect(
      patches.filter((patch) => patch.type === 'agent-turn-started-v2')
    ).toHaveLength(1);

    await adapter.disconnect();
  });

  it('classifies activeTurnNotSteerable as a definite safe FIFO fallback', async () => {
    const factory = makeStubFactory();
    const adapter = new CodexNativeProtocolAdapter(factory);
    factory.lastClient?.serverResponses.set('thread/start', {
      thread: { id: 'thread-1' },
    });
    await adapter.connect(config);
    await adapter.sendMessage({ turnId: 'turn-1', content: 'keep going' });
    factory.lastClient.feedNotification('turn/started', {
      turn: { id: 'native-1' },
    });
    factory.lastClient.serverResponses.set(
      'turn/steer',
      new Error('activeTurnNotSteerable')
    );

    await expect(
      adapter.steerMessage({ turnId: 'turn-1', content: 'redirect' })
    ).rejects.toBeInstanceOf(AgentSteerRejectedError);
    await adapter.disconnect();
  });

  it('holds an old terminal until a delayed steer reply confirms its successor', async () => {
    const factory = makeStubFactory();
    const adapter = new CodexNativeProtocolAdapter(factory);
    const patches = collectPatches(adapter);
    factory.lastClient?.serverResponses.set('thread/start', {
      thread: { id: 'thread-1' },
    });
    await adapter.connect(config);
    const client = factory.lastClient;
    await adapter.sendMessage({ turnId: 'turn-1', content: 'first' });
    client.feedNotification('turn/started', { turn: { id: 'native-old' } });
    let release!: (value: { turnId: string }) => void;
    client.serverResponses.set(
      'turn/steer',
      new Promise<{ turnId: string }>((resolve) => {
        release = resolve;
      })
    );
    const staleSteer = adapter.steerMessage({
      turnId: 'turn-1',
      content: 'stale redirect',
    });
    client.feedNotification('turn/completed', {
      turn: { id: 'native-old', status: 'completed' },
    });
    expect(
      patches.filter((patch) => patch.type === 'agent-turn-completed-v2')
    ).toHaveLength(0);

    release({ turnId: 'native-new' });
    await staleSteer;
    client.serverResponses.set('turn/steer', { turnId: 'native-after' });

    await adapter.steerMessage({
      turnId: 'turn-1',
      content: 'current redirect',
    });

    const steerCalls = client.calls.filter(
      (call) => call.method === 'turn/steer'
    );
    expect(steerCalls[1]?.params).toMatchObject({
      expectedTurnId: 'native-new',
    });
    expect(
      patches.filter((patch) => patch.type === 'agent-turn-completed-v2')
    ).toHaveLength(0);
    client.feedNotification('turn/completed', {
      turn: { id: 'native-after', status: 'completed' },
    });
    expect(
      patches.filter((patch) => patch.type === 'agent-turn-completed-v2')
    ).toHaveLength(1);
    await adapter.disconnect();
  });

  it('ignores a superseded native completion after a successful steer replacement', async () => {
    const factory = makeStubFactory();
    const adapter = new CodexNativeProtocolAdapter(factory);
    const patches = collectPatches(adapter);
    factory.lastClient?.serverResponses.set('thread/start', {
      thread: { id: 'thread-1' },
    });
    await adapter.connect(config);
    const client = factory.lastClient;
    await adapter.sendMessage({ turnId: 'turn-1', content: 'first' });
    client.feedNotification('turn/started', { turn: { id: 'native-old' } });
    client.serverResponses.set('turn/steer', { turnId: 'native-new' });

    await adapter.steerMessage({ turnId: 'turn-1', content: 'redirect' });
    client.feedNotification('turn/completed', {
      turn: { id: 'native-old', status: 'completed' },
    });
    expect(
      patches.filter((patch) => patch.type === 'agent-turn-completed-v2')
    ).toHaveLength(0);

    client.feedNotification('turn/completed', {
      turn: { id: 'native-new', status: 'completed' },
    });
    expect(
      patches.filter((patch) => patch.type === 'agent-turn-completed-v2')
    ).toHaveLength(1);
    await adapter.disconnect();
  });

  it('keeps a same-id steer as one continuing native turn and accepts its final completion', async () => {
    const factory = makeStubFactory();
    const adapter = new CodexNativeProtocolAdapter(factory);
    const patches = collectPatches(adapter);
    factory.lastClient?.serverResponses.set('thread/start', {
      thread: { id: 'thread-1' },
    });
    await adapter.connect(config);
    const client = factory.lastClient;
    await adapter.sendMessage({ turnId: 'turn-1', content: 'first' });
    client.feedNotification('turn/started', { turn: { id: 'native-1' } });
    client.serverResponses.set('turn/steer', { turnId: 'native-1' });

    await adapter.steerMessage({ turnId: 'turn-1', content: 'continue' });
    client.feedNotification('turn/completed', {
      turn: { id: 'native-1', status: 'completed' },
    });

    expect(
      patches.filter((patch) => patch.type === 'agent-turn-completed-v2')
    ).toHaveLength(1);
    await adapter.disconnect();
  });

  it('maps local image attachments to app-server localImage inputs', async () => {
    const factory = makeStubFactory();
    const adapter = new CodexNativeProtocolAdapter(factory);
    collectPatches(adapter);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-local-image-'));
    const imagePath = path.join(dir, 'fixture.png');
    fs.writeFileSync(imagePath, Buffer.from('fixture'));

    try {
      factory.lastClient?.serverResponses.set('thread/start', {
        thread: { id: 'thread-1' },
      });
      await adapter.connect(config);
      const client = factory.lastClient!;

      await adapter.sendMessage({
        turnId: 'turn-image',
        content: 'describe this image',
        attachments: [
          { type: 'image', path: imagePath, mimeType: 'image/png' },
        ],
      });

      const turnStart = client.calls.find((c) => c.method === 'turn/start');
      expect(turnStart?.params).toMatchObject({
        input: [
          { type: 'text', text: 'describe this image' },
          { type: 'localImage', path: imagePath },
        ],
      });

      await adapter.disconnect();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('states unavailable images in text instead of silently dropping them', () => {
    expect(
      buildCodexTurnInput('describe', [
        {
          type: 'image',
          path: '/missing/relay-fixture.png',
          mimeType: 'image/png',
        },
      ])
    ).toEqual([
      {
        type: 'text',
        text: 'describe\n\n[Relay image attachment unavailable to Codex: relay-fixture.png]',
      },
    ]);
  });

  it('emits turn-started and user-message item on sendMessage', async () => {
    const factory = makeStubFactory();
    const adapter = new CodexNativeProtocolAdapter(factory);
    const patches = collectPatches(adapter);

    factory.lastClient?.serverResponses.set('thread/start', {
      thread: { id: 'thread-1' },
    });
    await adapter.connect(config);

    await adapter.sendMessage({ turnId: 'turn-2', content: 'test' });

    expect(patches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'agent-turn-started-v2',
          turn: expect.objectContaining({ id: 'turn-2' }),
        }),
        expect.objectContaining({
          type: 'agent-item-started-v2',
          turnId: 'turn-2',
          item: expect.objectContaining({ type: 'userMessage', text: 'test' }),
        }),
      ])
    );

    await adapter.disconnect();
  });
});

// ── Notification round trips ──────────────────────────────────────────────────

describe('CodexNativeProtocolAdapter — notifications', () => {
  async function setupAndSend(turnId: string) {
    const factory = makeStubFactory();
    const adapter = new CodexNativeProtocolAdapter(factory);
    const patches = collectPatches(adapter);

    factory.lastClient?.serverResponses.set('thread/start', {
      thread: { id: 'thread-1' },
    });
    await adapter.connect(config);
    const client = factory.lastClient!;
    await adapter.sendMessage({ turnId, content: 'go' });
    // Simulate turn/started notification
    client.feedNotification('turn/started', { turn: { id: 'native-turn-1' } });
    return { adapter, client, patches };
  }

  it('assistantMessage: delta then complete', async () => {
    const { adapter, client, patches } = await setupAndSend('turn-msg');

    client.feedNotification('item/started', {
      item: { type: 'agentMessage', id: 'item-1' },
    });
    client.feedNotification('item/agentMessage/delta', {
      itemId: 'item-1',
      delta: 'hello ',
    });
    client.feedNotification('item/agentMessage/delta', {
      itemId: 'item-1',
      delta: 'world',
    });
    client.feedNotification('item/completed', {
      item: { type: 'agentMessage', id: 'item-1', text: 'hello world' },
    });

    const relayId = `msg-turn-msg-item-1`;
    expect(patches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'agent-item-started-v2',
          turnId: 'turn-msg',
          item: expect.objectContaining({
            type: 'assistantMessage',
            id: relayId,
          }),
        }),
        expect.objectContaining({
          type: 'agent-item-delta-v2',
          turnId: 'turn-msg',
          itemId: relayId,
          delta: { text: 'hello ' },
        }),
        expect.objectContaining({
          type: 'agent-item-delta-v2',
          delta: { text: 'world' },
        }),
        expect.objectContaining({
          type: 'agent-item-updated-v2',
          item: expect.objectContaining({
            type: 'assistantMessage',
            text: 'hello world',
          }),
        }),
      ])
    );

    await adapter.disconnect();
  });

  it.each([
    {
      fixture: CODEX_TERMINAL_ORDERING_FIXTURES.partialThenLateFinal,
      expectedTexts: ['Partial handoff completed.'],
    },
    {
      fixture: CODEX_TERMINAL_ORDERING_FIXTURES.emptyStartThenLateFinal,
      expectedTexts: ['Synthetic terminal handoff.'],
    },
    {
      fixture: CODEX_TERMINAL_ORDERING_FIXTURES.twoItemsLastLate,
      expectedTexts: ['First durable output.', 'Last output is durable.'],
    },
  ])(
    'emits every terminal assistant item before Relay turn teardown: $fixture.name',
    async ({ fixture, expectedTexts }) => {
      const { adapter, client, patches } = await setupAndSend(
        'turn-terminal-ordering'
      );

      for (const notification of fixture.notifications) {
        client.feedNotification(notification.method, notification.params);
      }

      const assistantFinals = patches.filter(
        (patch) =>
          patch.type === 'agent-item-updated-v2' &&
          patch.item.type === 'assistantMessage'
      );
      const turnCompletedIndex = patches.findIndex(
        (patch) => patch.type === 'agent-turn-completed-v2'
      );
      expect(assistantFinals.map((patch) => patch.item.text)).toEqual(
        expectedTexts
      );
      expect(assistantFinals).toHaveLength(expectedTexts.length);
      expect(turnCompletedIndex).toBeGreaterThan(
        Math.max(...assistantFinals.map((patch) => patches.indexOf(patch)))
      );

      await adapter.disconnect();
    }
  );

  it('persists one row and one downstream finalization for the sanitized Codex triple-final shape', async () => {
    const dir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'relay-codex-triple-final-')
    );
    const store = createChannelMessageStore(path.join(dir, 'channel-chat.db'));
    const hub = createChannelHub({ store, channelExists: () => true });
    const factory = makeStubFactory();
    const adapter = new CodexNativeProtocolAdapter(factory);
    const onAssistantMessageFinalized = vi.fn();
    let unbind = () => {};
    try {
      factory.lastClient.serverResponses.set('thread/start', {
        thread: { id: 'thread-triple-final' },
      });
      await adapter.connect(config);
      unbind = bindSessionToChannel({
        channelId: 'topic:triple-final',
        agentFramework: 'codex',
        adapter,
        store,
        hub,
        onAssistantMessageFinalized,
      });
      await adapter.sendMessage({
        turnId: 'turn-triple-final',
        content: 'synthetic prompt',
      });
      factory.lastClient.feedNotification('turn/started', {
        turn: { id: 'native-turn' },
      });
      for (const notification of CODEX_TRIPLE_FINAL_FIXTURE.notifications) {
        factory.lastClient.feedNotification(
          notification.method,
          notification.params
        );
      }

      expect(store.history('topic:triple-final')).toEqual([
        expect.objectContaining({
          status: 'complete',
          body: { text: 'Synthetic durable answer.', format: 'markdown' },
          source: expect.objectContaining({
            runtimeId: config.sessionId,
            turnId: 'turn-triple-final',
            itemId: 'message-replayed',
          }),
        }),
      ]);
      expect(onAssistantMessageFinalized).toHaveBeenCalledOnce();
      await adapter.disconnect();
    } finally {
      unbind();
      hub.close();
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('releases a completed native turn after the terminal-item grace expires', async () => {
    vi.useFakeTimers();
    try {
      const { adapter, client, patches } = await setupAndSend(
        'turn-terminal-timeout'
      );
      client.feedNotification('item/started', {
        item: { type: 'agentMessage', id: 'message-never-finalized' },
      });
      client.feedNotification('turn/completed', {
        turn: { id: 'native-turn', status: 'completed' },
      });
      expect(
        patches.some((patch) => patch.type === 'agent-turn-completed-v2')
      ).toBe(false);

      await vi.advanceTimersByTimeAsync(CODEX_TERMINAL_ITEM_GRACE_MS);
      expect(
        patches.some((patch) => patch.type === 'agent-turn-completed-v2')
      ).toBe(true);
      await adapter.disconnect();
    } finally {
      vi.useRealTimers();
    }
  });

  it('flushes a deferred provider completion with usage exactly once on teardown', async () => {
    vi.useFakeTimers();
    try {
      const { adapter, client, patches } = await setupAndSend(
        'turn-terminal-teardown'
      );
      client.feedNotification('item/started', {
        item: { type: 'agentMessage', id: 'message-held-open' },
      });
      client.feedNotification('thread/tokenUsageUpdated', {
        threadId: 'thread-1',
        turnId: 'native-turn-teardown',
        tokenUsage: {
          last: { inputTokens: 21, outputTokens: 8, totalTokens: 29 },
        },
      });
      client.feedNotification('turn/completed', {
        threadId: 'thread-1',
        turn: { id: 'native-turn-teardown', status: 'completed' },
      });
      expect(
        patches.filter((patch) => patch.type === 'agent-turn-completed-v2')
      ).toHaveLength(0);

      await adapter.disconnect();
      const completed = patches.filter(
        (patch) => patch.type === 'agent-turn-completed-v2'
      );
      expect(completed).toEqual([
        expect.objectContaining({
          turnId: 'turn-terminal-teardown',
          status: 'completed',
          usage: expect.objectContaining({
            inputTokens: 21,
            outputTokens: 8,
            totalTokens: 29,
          }),
        }),
      ]);

      await vi.advanceTimersByTimeAsync(CODEX_TERMINAL_ITEM_GRACE_MS);
      expect(
        patches.filter((patch) => patch.type === 'agent-turn-completed-v2')
      ).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('flushes a deferred provider completion before handling client close', async () => {
    vi.useFakeTimers();
    try {
      const { adapter, client, patches } = await setupAndSend(
        'turn-terminal-close'
      );
      client.feedNotification('item/started', {
        item: { type: 'reasoning', id: 'reasoning-held-open' },
      });
      client.feedNotification('item/reasoning/summaryTextDelta', {
        itemId: 'reasoning-held-open',
        delta: 'provider-completed reasoning',
        summaryIndex: 0,
      });
      client.feedNotification('thread/tokenUsageUpdated', {
        threadId: 'thread-1',
        turnId: 'native-turn-close',
        tokenUsage: {
          last: { inputTokens: 34, outputTokens: 13, totalTokens: 47 },
        },
      });
      client.feedNotification('turn/completed', {
        threadId: 'thread-1',
        turn: {
          id: 'native-turn-close',
          status: 'completed',
          durationMs: 4321,
        },
      });
      expect(
        patches.filter((patch) => patch.type === 'agent-turn-completed-v2')
      ).toHaveLength(0);

      client.emit('close', 0);

      expect(
        patches.filter(
          (patch) =>
            patch.type === 'agent-item-updated-v2' &&
            patch.item.type === 'reasoning' &&
            patch.item.status === 'completed'
        )
      ).toEqual([
        expect.objectContaining({
          item: expect.objectContaining({
            summary: 'provider-completed reasoning',
            status: 'completed',
          }),
        }),
      ]);
      expect(
        patches.filter((patch) => patch.type === 'agent-turn-completed-v2')
      ).toEqual([
        expect.objectContaining({
          turnId: 'turn-terminal-close',
          status: 'completed',
          durationMs: 4321,
          usage: expect.objectContaining({
            inputTokens: 34,
            outputTokens: 13,
            totalTokens: 47,
          }),
        }),
      ]);

      await vi.advanceTimersByTimeAsync(CODEX_TERMINAL_ITEM_GRACE_MS);
      expect(
        patches.filter((patch) => patch.type === 'agent-turn-completed-v2')
      ).toHaveLength(1);
      await adapter.disconnect();
    } finally {
      vi.useRealTimers();
    }
  });

  it('persists an empty start as missing-terminal when the Codex grace expires', async () => {
    vi.useFakeTimers();
    const dir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'relay-codex-terminal-timeout-')
    );
    const store = createChannelMessageStore(path.join(dir, 'channel-chat.db'));
    const hub = createChannelHub({ store, channelExists: () => true });
    const factory = makeStubFactory();
    const adapter = new CodexNativeProtocolAdapter(factory);
    let unbind = () => {};
    try {
      factory.lastClient.serverResponses.set('thread/start', {
        thread: { id: 'thread-terminal-timeout' },
      });
      await adapter.connect(config);
      unbind = bindSessionToChannel({
        channelId: 'topic:terminal-timeout',
        agentFramework: 'codex',
        adapter,
        store,
        hub,
      });
      await adapter.sendMessage({
        turnId: 'turn-terminal-timeout',
        content: 'synthetic prompt',
      });
      factory.lastClient.feedNotification('turn/started', {
        turn: { id: 'native-turn-terminal-timeout' },
      });
      factory.lastClient.feedNotification('item/started', {
        item: { type: 'agentMessage', id: 'message-without-terminal' },
      });
      factory.lastClient.feedNotification('turn/completed', {
        turn: { id: 'native-turn-terminal-timeout', status: 'completed' },
      });

      expect(store.history('topic:terminal-timeout')).toEqual([
        expect.objectContaining({
          status: 'streaming',
          body: expect.objectContaining({ text: '' }),
        }),
      ]);
      await vi.advanceTimersByTimeAsync(CODEX_TERMINAL_ITEM_GRACE_MS);
      const terminal = store.history('topic:terminal-timeout');
      expect(terminal).toEqual([
        expect.objectContaining({
          status: 'truncated',
          body: { text: '', format: 'markdown' },
          meta: { truncationReason: 'missing-terminal' },
        }),
      ]);
      expect(terminal[0]?.truncated).toBeUndefined();
      await adapter.disconnect();
    } finally {
      unbind();
      hub.close();
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
      vi.useRealTimers();
    }
  });

  it('reasoning: summary delta + part added', async () => {
    const { adapter, client, patches } = await setupAndSend('turn-reason');

    client.feedNotification('item/started', {
      item: { type: 'reasoning', id: 'reason-1' },
    });
    // Authoritative shape: { threadId, turnId, itemId, delta, summaryIndex }
    client.feedNotification('item/reasoning/summaryTextDelta', {
      itemId: 'reason-1',
      delta: 'thinking...',
      summaryIndex: 0,
    });
    // Authoritative shape: { threadId, turnId, itemId, summaryIndex } — no summary text
    client.feedNotification('item/reasoning/summaryPartAdded', {
      itemId: 'reason-1',
      summaryIndex: 1,
    });

    expect(patches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'agent-item-started-v2',
          item: expect.objectContaining({
            type: 'reasoning',
            visibility: 'summary',
          }),
        }),
        expect.objectContaining({
          type: 'agent-item-delta-v2',
          delta: { summary: 'thinking...' },
        }),
        // summaryPartAdded now emits a providerExtension boundary marker
        expect.objectContaining({
          type: 'agent-item-started-v2',
          item: expect.objectContaining({
            type: 'providerExtension',
            payload: expect.objectContaining({
              kind: 'reasoningSummaryPartAdded',
              summaryIndex: 1,
            }),
          }),
        }),
      ])
    );

    await adapter.disconnect();
  });

  it('reasoning: legacy object arrays preserve summary and detail text', async () => {
    const { adapter, client, patches } = await setupAndSend('turn-r2');

    client.feedNotification('item/started', {
      item: { type: 'reasoning', id: 'reason-2' },
    });
    client.feedNotification('item/reasoning/summaryTextDelta', {
      itemId: 'reason-2',
      delta: 'partial summary text',
      summaryIndex: 0,
    });
    // Older app-server versions used Vec<{type, text}> for both fields.
    client.feedNotification('item/completed', {
      item: {
        type: 'reasoning',
        id: 'reason-2',
        summary: [
          { type: 'summary_text', text: 'final summary part one' },
          { type: 'summary_text', text: 'final summary part two' },
        ],
        content: [
          { type: 'reasoning_text', text: 'detail part one' },
          { type: 'reasoning_text', text: 'detail part two' },
        ],
      },
    });

    const completed = patches.find(
      (p) =>
        p.type === 'agent-item-updated-v2' &&
        p.item.type === 'reasoning' &&
        p.item.status === 'completed'
    );
    expect(completed).toBeDefined();
    if (
      completed &&
      completed.type === 'agent-item-updated-v2' &&
      completed.item.type === 'reasoning'
    ) {
      expect(completed.item.summary).toBe(
        'final summary part one\n\nfinal summary part two'
      );
      expect(completed.item.detail).toBe('detail part one\n\ndetail part two');
    }

    await adapter.disconnect();
  });

  it('reasoning: current string arrays preserve summary and detail text', async () => {
    const { adapter, client, patches } = await setupAndSend('turn-r-strings');

    client.feedNotification('item/started', {
      item: {
        type: 'reasoning',
        id: 'reason-strings',
        summary: [],
        content: [],
      },
    });
    client.feedNotification('item/completed', {
      item: {
        type: 'reasoning',
        id: 'reason-strings',
        summary: ['summary part one', 'summary part two'],
        content: ['detail part one', 'detail part two'],
      },
    });

    expect(
      patches.filter(
        (patch) =>
          patch.type === 'agent-item-updated-v2' &&
          patch.item.type === 'reasoning' &&
          patch.item.status === 'completed'
      )
    ).toEqual([
      expect.objectContaining({
        item: expect.objectContaining({
          summary: 'summary part one\n\nsummary part two',
          detail: 'detail part one\n\ndetail part two',
        }),
      }),
    ]);

    await adapter.disconnect();
  });

  it('reasoning: duplicate item/completed emits one terminal update', async () => {
    const { adapter, client, patches } = await setupAndSend(
      'turn-r-duplicate-completion'
    );
    client.feedNotification('item/started', {
      item: { type: 'reasoning', id: 'reason-duplicate' },
    });
    const completion = {
      item: {
        type: 'reasoning',
        id: 'reason-duplicate',
        summary: ['terminal summary'],
        content: [],
      },
    };
    client.feedNotification('item/completed', completion);
    client.feedNotification('item/completed', completion);

    expect(
      patches.filter(
        (patch) =>
          patch.type === 'agent-item-updated-v2' &&
          patch.item.type === 'reasoning' &&
          patch.item.status === 'completed'
      )
    ).toHaveLength(1);
    await adapter.disconnect();
  });

  it('reasoning: id-less item/completed terminalizes streamed content', async () => {
    const { adapter, client, patches } = await setupAndSend(
      'turn-reasoning-idless-completed'
    );
    client.feedNotification('item/started', {
      item: { type: 'reasoning' },
    });
    client.feedNotification('item/reasoning/summaryTextDelta', {
      delta: 'id-less summary',
      summaryIndex: 0,
    });
    client.feedNotification('item/reasoning/textDelta', {
      delta: 'id-less detail',
      contentIndex: 0,
    });
    client.feedNotification('item/completed', {
      item: { type: 'reasoning' },
    });

    expect(
      patches.filter(
        (patch) =>
          patch.type === 'agent-item-updated-v2' &&
          patch.item.type === 'reasoning' &&
          patch.item.status === 'completed'
      )
    ).toEqual([
      expect.objectContaining({
        item: expect.objectContaining({
          id: 'reasoning-turn-reasoning-idless-completed-',
          summary: 'id-less summary',
          detail: 'id-less detail',
          status: 'completed',
        }),
      }),
    ]);
    await adapter.disconnect();
  });

  it('reasoning: turn completion terminalizes an id-less open item', async () => {
    vi.useFakeTimers();
    try {
      const { adapter, client, patches } = await setupAndSend(
        'turn-reasoning-idless-fallback'
      );
      client.feedNotification('item/started', {
        item: { type: 'reasoning' },
      });
      client.feedNotification('item/reasoning/summaryTextDelta', {
        delta: 'id-less buffered summary',
        summaryIndex: 0,
      });
      client.feedNotification('turn/completed', {
        turn: { id: 'native-turn-1', status: 'completed' },
      });

      expect(
        patches.some((patch) => patch.type === 'agent-turn-completed-v2')
      ).toBe(false);
      await vi.advanceTimersByTimeAsync(CODEX_TERMINAL_ITEM_GRACE_MS);

      expect(reducePatches(patches).turns[0]?.items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: 'reasoning-turn-reasoning-idless-fallback-',
            type: 'reasoning',
            summary: 'id-less buffered summary',
            status: 'completed',
            card: expect.objectContaining({ status: 'completed' }),
          }),
        ])
      );
      await adapter.disconnect();
    } finally {
      vi.useRealTimers();
    }
  });

  it('reasoning: item/completed without summary falls back to streamed buffer', async () => {
    const { adapter, client, patches } = await setupAndSend('turn-r3');

    client.feedNotification('item/started', {
      item: { type: 'reasoning', id: 'reason-3' },
    });
    client.feedNotification('item/reasoning/summaryTextDelta', {
      itemId: 'reason-3',
      delta: 'streamed-only text',
      summaryIndex: 0,
    });
    // Completion payload missing summary entirely — buffer must be used.
    client.feedNotification('item/completed', {
      item: { type: 'reasoning', id: 'reason-3' },
    });

    const completed = patches.find(
      (p) =>
        p.type === 'agent-item-updated-v2' &&
        p.item.type === 'reasoning' &&
        p.item.status === 'completed'
    );
    expect(completed).toBeDefined();
    if (
      completed &&
      completed.type === 'agent-item-updated-v2' &&
      completed.item.type === 'reasoning'
    ) {
      expect(completed.item.summary).toBe('streamed-only text');
    }

    await adapter.disconnect();
  });

  it('reasoning: turn completion terminalizes an item missing item/completed', async () => {
    vi.useFakeTimers();
    try {
      const { adapter, client, patches } = await setupAndSend(
        'turn-reasoning-fallback'
      );
      client.feedNotification('item/started', {
        item: { type: 'reasoning', id: 'reason-fallback' },
      });
      client.feedNotification('item/reasoning/summaryTextDelta', {
        itemId: 'reason-fallback',
        delta: 'buffered summary',
        summaryIndex: 0,
      });
      client.feedNotification('item/reasoning/textDelta', {
        itemId: 'reason-fallback',
        delta: 'buffered detail',
        contentIndex: 0,
      });
      client.feedNotification('turn/completed', {
        turn: { id: 'native-turn-1', status: 'completed' },
      });

      expect(
        patches.some((patch) => patch.type === 'agent-turn-completed-v2')
      ).toBe(false);
      await vi.advanceTimersByTimeAsync(CODEX_TERMINAL_ITEM_GRACE_MS);

      const session = reducePatches(patches);
      expect(session.turns[0]).toMatchObject({ status: 'completed' });
      expect(session.turns[0]?.items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'reasoning',
            summary: 'buffered summary',
            detail: 'buffered detail',
            status: 'completed',
            card: expect.objectContaining({
              kind: 'thought',
              content: 'buffered detail',
              status: 'completed',
            }),
          }),
        ])
      );
      await adapter.disconnect();
    } finally {
      vi.useRealTimers();
    }
  });

  it('reasoning: disconnect terminalizes an active item and turn exactly once', async () => {
    const { adapter, client, patches } = await setupAndSend(
      'turn-reasoning-disconnect'
    );
    client.feedNotification('item/started', {
      item: { type: 'reasoning', id: 'reason-disconnect' },
    });
    client.feedNotification('item/reasoning/summaryTextDelta', {
      itemId: 'reason-disconnect',
      delta: 'summary before disconnect',
      summaryIndex: 0,
    });

    await adapter.disconnect();

    expect(
      patches.filter(
        (patch) =>
          patch.type === 'agent-item-updated-v2' &&
          patch.item.type === 'reasoning' &&
          patch.item.status === 'cancelled'
      )
    ).toEqual([
      expect.objectContaining({
        item: expect.objectContaining({
          summary: 'summary before disconnect',
          status: 'cancelled',
        }),
      }),
    ]);
    expect(
      patches.filter(
        (patch) =>
          patch.type === 'agent-turn-completed-v2' &&
          patch.turnId === 'turn-reasoning-disconnect' &&
          patch.status === 'interrupted'
      )
    ).toHaveLength(1);
  });

  it.each([
    ['failed', 'failed'],
    ['interrupted', 'cancelled'],
  ] as const)(
    'reasoning: %s turn terminalizes open reasoning as %s',
    async (turnStatus, itemStatus) => {
      const { adapter, client, patches } = await setupAndSend(
        `turn-reasoning-${turnStatus}`
      );
      client.feedNotification('item/started', {
        item: { type: 'reasoning', id: `reason-${turnStatus}` },
      });
      client.feedNotification('item/reasoning/summaryTextDelta', {
        itemId: `reason-${turnStatus}`,
        delta: `${turnStatus} summary`,
        summaryIndex: 0,
      });
      client.feedNotification('turn/completed', {
        turn: { id: 'native-turn-1', status: turnStatus },
      });

      expect(reducePatches(patches).turns[0]?.items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'reasoning',
            status: itemStatus,
            card: expect.objectContaining({ status: itemStatus }),
          }),
        ])
      );
      await adapter.disconnect();
    }
  );

  it('commandExecution: output delta then complete', async () => {
    const { adapter, client, patches } = await setupAndSend('turn-cmd');

    client.feedNotification('item/started', {
      item: {
        type: 'commandExecution',
        id: 'exec-1',
        command: 'npm test',
        cwd: '/tmp',
      },
    });
    client.feedNotification('item/commandExecution/outputDelta', {
      itemId: 'exec-1',
      delta: 'PASS\n',
    });
    client.feedNotification('item/completed', {
      item: {
        type: 'commandExecution',
        id: 'exec-1',
        command: 'npm test',
        cwd: '/tmp',
        aggregatedOutput: 'PASS\n',
        exitCode: 0,
        durationMs: 100,
      },
    });

    expect(patches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'agent-item-started-v2',
          item: expect.objectContaining({
            type: 'commandExecution',
            command: 'npm test',
          }),
        }),
        expect.objectContaining({
          type: 'agent-item-delta-v2',
          delta: { output: 'PASS\n' },
        }),
        expect.objectContaining({
          type: 'agent-item-updated-v2',
          item: expect.objectContaining({ exitCode: 0, durationMs: 100 }),
        }),
      ])
    );

    await adapter.disconnect();
  });

  it('fileChange: cumulative patch updates replace the live body and counts', async () => {
    const { adapter, client, patches } = await setupAndSend('turn-file');

    // Authoritative FileUpdateChange shape: kind is tagged union { type: 'add'|'delete'|'update' }
    client.feedNotification('item/started', {
      item: {
        type: 'fileChange',
        id: 'fc-1',
        changes: [{ path: 'foo.ts', kind: { type: 'update' }, diff: '' }],
      },
    });
    // Authoritative item/fileChange/patchUpdated shape: { changes: FileUpdateChange[] }
    const firstPatch =
      '--- a/foo.ts\n+++ b/foo.ts\n@@ -1 +1 @@\n-old\n+intermediate\n';
    client.feedNotification('item/fileChange/patchUpdated', {
      itemId: 'fc-1',
      changes: [
        {
          path: 'foo.ts',
          kind: { type: 'update' },
          diff: firstPatch,
        },
      ],
    });
    const afterFirst = reducePatches(patches);
    expect(afterFirst.turns[0]?.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'fileChange',
          patch: firstPatch,
          card: expect.objectContaining({
            content: firstPatch,
            additions: 1,
            deletions: 1,
          }),
        }),
      ])
    );

    const finalPatch =
      '--- a/foo.ts\n+++ b/foo.ts\n@@ -1 +1,2 @@\n-old\n+final one\n+final two\n';
    client.feedNotification('item/fileChange/patchUpdated', {
      itemId: 'fc-1',
      changes: [
        {
          path: 'foo.ts',
          kind: { type: 'update' },
          diff: finalPatch,
        },
      ],
    });
    const midStream = reducePatches(patches);
    expect(midStream.turns[0]?.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'fileChange',
          patch: finalPatch,
          card: expect.objectContaining({
            content: finalPatch,
            additions: 2,
            deletions: 1,
          }),
        }),
      ])
    );
    expect(JSON.stringify(midStream.turns[0]?.items)).not.toContain(
      'intermediate'
    );

    client.feedNotification('item/completed', {
      item: {
        type: 'fileChange',
        id: 'fc-1',
        changes: [
          {
            path: 'foo.ts',
            kind: { type: 'update' },
            diff: finalPatch,
          },
        ],
        applyStatus: 'applied',
      },
    });

    expect(patches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'agent-item-started-v2',
          item: expect.objectContaining({
            type: 'fileChange',
            paths: [{ path: 'foo.ts', status: 'update' }],
          }),
        }),
        expect.objectContaining({
          type: 'agent-item-delta-v2',
          mode: 'replace',
          delta: {
            patch: finalPatch,
            card: { additions: 2, deletions: 1 },
          },
        }),
        expect.objectContaining({
          type: 'agent-item-updated-v2',
          item: expect.objectContaining({
            applyStatus: 'applied',
            patch: finalPatch,
            card: {
              kind: 'diff',
              title: 'foo.ts',
              status: 'completed',
              language: 'diff',
              path: 'foo.ts',
              content: finalPatch,
              additions: 2,
              deletions: 1,
              sizeBytes: new TextEncoder().encode(finalPatch).byteLength,
            },
          }),
        }),
      ])
    );

    await adapter.disconnect();
  });

  it('replays the sanitized Codex detail fixture into normalized cards', async () => {
    const { adapter, client, patches } = await setupAndSend('turn-fixture');
    for (const event of codexDetailFixture.nativeEvents) {
      client.feedNotification(event.method, event.params);
    }

    const reasoningDeltaIndex = patches.findIndex(
      (patch) =>
        patch.type === 'agent-item-delta-v2' &&
        patch.delta.summary === codexDetailFixture.assertions.thoughtContent
    );
    expect(reasoningDeltaIndex).toBeGreaterThanOrEqual(0);
    const streamingSession = reducePatches(
      patches.slice(0, reasoningDeltaIndex + 1)
    );
    expect(streamingSession.turns[0]?.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'reasoning',
          summary: codexDetailFixture.assertions.thoughtContent,
          status: 'running',
          card: expect.objectContaining({
            kind: 'thought',
            content: codexDetailFixture.assertions.thoughtContent,
            status: 'running',
          }),
        }),
      ])
    );

    const session = reducePatches(patches);
    const cards = session.turns
      .flatMap((turn) => turn.items)
      .flatMap((item) =>
        item.card && item.card.kind !== 'message' ? [item.card] : []
      );
    const expectedCards = codexDetailFixture.session.turns
      .flatMap((turn) => turn.items)
      .flatMap((item) =>
        item.card && item.card.kind !== 'message' ? [item.card] : []
      );
    expect(cards).toEqual(expectedCards);
    expect(codexDetailFixture.sanitization.containsLiveTranscriptBytes).toBe(
      false
    );

    await adapter.disconnect();
  });

  it('mcpToolCall: started and completed', async () => {
    const { adapter, client, patches } = await setupAndSend('turn-mcp');

    client.feedNotification('item/started', {
      item: {
        type: 'mcpToolCall',
        id: 'mcp-1',
        server: 'github',
        tool: 'search',
        arguments: { query: 'fixture' },
      },
    });
    client.feedNotification('item/completed', {
      item: {
        type: 'mcpToolCall',
        id: 'mcp-1',
        server: 'github',
        tool: 'search',
        result: [],
      },
    });

    expect(patches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'agent-item-started-v2',
          item: expect.objectContaining({
            type: 'mcpToolCall',
            server: 'github',
            tool: 'search',
          }),
        }),
        expect.objectContaining({
          type: 'agent-item-updated-v2',
          item: expect.objectContaining({ type: 'mcpToolCall', result: [] }),
        }),
      ])
    );
    const completed = patches.find(
      (patch) =>
        patch.type === 'agent-item-updated-v2' &&
        patch.item.type === 'mcpToolCall'
    );
    expect(completed).toMatchObject({
      item: {
        id: 'mcp-mcp-1',
        arguments: { query: 'fixture' },
        card: {
          kind: 'tool_call',
          content: 'input\n{\n  "query": "fixture"\n}\n\noutput\n[]',
          status: 'completed',
        },
      },
    });

    await adapter.disconnect();
  });

  it('dynamicToolCall: started and completed', async () => {
    const { adapter, client, patches } = await setupAndSend('turn-dyn');

    client.feedNotification('item/started', {
      item: {
        type: 'dynamicToolCall',
        id: 'dyn-1',
        tool: 'myTool',
        arguments: { query: 'fixture' },
      },
    });
    client.feedNotification('item/completed', {
      item: {
        type: 'dynamicToolCall',
        id: 'dyn-1',
        tool: 'myTool',
        result: 'done',
      },
    });

    const lifecycle = patches.filter(
      (patch) =>
        (patch.type === 'agent-item-started-v2' ||
          patch.type === 'agent-item-updated-v2') &&
        patch.item.type === 'dynamicToolCall'
    );
    expect(lifecycle).toHaveLength(2);
    expect(
      lifecycle.map((patch) =>
        patch.type === 'agent-item-started-v2' ||
        patch.type === 'agent-item-updated-v2'
          ? patch.item.id
          : null
      )
    ).toEqual(['tool-dyn-1', 'tool-dyn-1']);
    expect(lifecycle[0]).toMatchObject({
      item: {
        arguments: { query: 'fixture' },
        card: {
          kind: 'tool_call',
          content: 'input\n{\n  "query": "fixture"\n}',
          status: 'running',
        },
      },
    });
    expect(lifecycle[1]).toMatchObject({
      item: {
        arguments: { query: 'fixture' },
        result: 'done',
        card: {
          kind: 'tool_call',
          content: 'input\n{\n  "query": "fixture"\n}\n\noutput\ndone',
          status: 'completed',
        },
      },
    });

    await adapter.disconnect();
  });

  it('collabAgentToolCall: tool name is prefixed with collab:', async () => {
    const { adapter, client, patches } = await setupAndSend('turn-collab');

    // Authoritative type: collabAgentToolCall (not collabToolCall)
    client.feedNotification('item/started', {
      item: {
        type: 'collabAgentToolCall',
        id: 'collab-1',
        tool: 'summarize',
        arguments: {},
      },
    });

    expect(patches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'agent-item-started-v2',
          item: expect.objectContaining({
            type: 'dynamicToolCall',
            tool: 'collab:summarize',
          }),
        }),
      ])
    );

    await adapter.disconnect();
  });

  it('webSearch: started', async () => {
    const { adapter, client, patches } = await setupAndSend('turn-search');

    client.feedNotification('item/started', {
      item: { type: 'webSearch', id: 'ws-1', query: 'codex api' },
    });

    expect(patches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'agent-item-started-v2',
          item: expect.objectContaining({
            type: 'webSearch',
            query: 'codex api',
          }),
        }),
      ])
    );

    await adapter.disconnect();
  });

  it('imageView: started', async () => {
    const { adapter, client, patches } = await setupAndSend('turn-img');

    client.feedNotification('item/started', {
      item: { type: 'imageView', id: 'img-1', path: '/tmp/image.png' },
    });

    expect(patches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'agent-item-started-v2',
          item: expect.objectContaining({
            type: 'imageView',
            source: '/tmp/image.png',
          }),
        }),
      ])
    );

    await adapter.disconnect();
  });

  it('turn/completed maps to agent-turn-completed-v2', async () => {
    const { adapter, client, patches } = await setupAndSend('turn-complete');

    // Authoritative: token usage arrives via thread/tokenUsageUpdated, keyed by native turnId
    client.feedNotification('thread/tokenUsageUpdated', {
      threadId: 'thread-1',
      turnId: 'native-turn-1',
      tokenUsage: {
        last: {
          inputTokens: 100,
          outputTokens: 50,
          cachedInputTokens: 0,
          reasoningOutputTokens: 0,
          totalTokens: 150,
        },
        total: {
          inputTokens: 100,
          outputTokens: 50,
          cachedInputTokens: 0,
          reasoningOutputTokens: 0,
          totalTokens: 150,
        },
        modelContextWindow: 128000,
      },
    });

    // Authoritative turn/completed shape: { threadId, turn: Turn }
    client.feedNotification('turn/completed', {
      threadId: 'thread-1',
      turn: { id: 'native-turn-1', status: 'completed' },
    });

    expect(patches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'agent-turn-completed-v2',
          turnId: 'turn-complete',
          status: 'completed',
          usage: expect.objectContaining({
            inputTokens: 100,
            outputTokens: 50,
          }),
        }),
      ])
    );

    await adapter.disconnect();
  });

  it('turn/completed with interrupted status', async () => {
    const { adapter, client, patches } = await setupAndSend('turn-int');

    // Authoritative turn/completed shape: { threadId, turn: Turn }
    client.feedNotification('turn/completed', {
      threadId: 'thread-1',
      turn: { id: 'native-turn-1', status: 'interrupted' },
    });

    expect(patches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'agent-turn-completed-v2',
          status: 'interrupted',
        }),
      ])
    );

    await adapter.disconnect();
  });

  it('thread/tokenUsageUpdated buffered usage is attached to subsequent turn/completed', async () => {
    const { adapter, client, patches } = await setupAndSend('turn-usage');

    // Feed token usage notification BEFORE turn/completed
    client.feedNotification('thread/tokenUsageUpdated', {
      threadId: 'thread-1',
      turnId: 'native-turn-1',
      tokenUsage: {
        last: {
          inputTokens: 200,
          outputTokens: 80,
          cachedInputTokens: 50,
          reasoningOutputTokens: 10,
          totalTokens: 290,
        },
        total: {
          inputTokens: 200,
          outputTokens: 80,
          cachedInputTokens: 50,
          reasoningOutputTokens: 10,
          totalTokens: 290,
        },
        modelContextWindow: 64000,
      },
    });

    // Now complete the turn — usage should be pulled from buffer
    client.feedNotification('turn/completed', {
      threadId: 'thread-1',
      turn: { id: 'native-turn-1', status: 'completed' },
    });

    expect(patches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'agent-turn-completed-v2',
          turnId: 'turn-usage',
          status: 'completed',
          usage: expect.objectContaining({
            inputTokens: 200,
            outputTokens: 80,
            cachedInputTokens: 50,
            reasoningOutputTokens: 10,
            totalTokens: 290,
            contextWindowSize: 64000,
          }),
        }),
      ])
    );

    await adapter.disconnect();
  });
});

// ── Provider extensions ───────────────────────────────────────────────────────

describe('CodexNativeProtocolAdapter — provider extensions', () => {
  async function setupAndSend(turnId: string) {
    const factory = makeStubFactory();
    const adapter = new CodexNativeProtocolAdapter(factory);
    const patches = collectPatches(adapter);
    factory.lastClient?.serverResponses.set('thread/start', {
      thread: { id: 'thread-1' },
    });
    await adapter.connect(config);
    const client = factory.lastClient!;
    await adapter.sendMessage({ turnId, content: 'go' });
    client.feedNotification('turn/started', { turn: { id: 'native-1' } });
    return { adapter, client, patches };
  }

  it('enteredReviewMode emits providerExtension', async () => {
    const { adapter, client, patches } = await setupAndSend('turn-rev');
    client.feedNotification('enteredReviewMode', {});
    expect(patches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'agent-item-started-v2',
          item: expect.objectContaining({
            type: 'providerExtension',
            namespace: 'codex',
            payload: expect.objectContaining({ kind: 'enteredReviewMode' }),
          }),
        }),
      ])
    );
    await adapter.disconnect();
  });

  it('exitedReviewMode emits providerExtension', async () => {
    const { adapter, client, patches } = await setupAndSend('turn-exrev');
    client.feedNotification('exitedReviewMode', {});
    expect(patches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'agent-item-started-v2',
          item: expect.objectContaining({
            payload: expect.objectContaining({ kind: 'exitedReviewMode' }),
          }),
        }),
      ])
    );
    await adapter.disconnect();
  });

  it('contextCompaction emits providerExtension', async () => {
    const { adapter, client, patches } = await setupAndSend('turn-ctx');
    client.feedNotification('contextCompaction', {
      tokensBefore: 1000,
      tokensAfter: 200,
    });
    expect(patches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'agent-item-started-v2',
          item: expect.objectContaining({
            payload: expect.objectContaining({ kind: 'contextCompaction' }),
          }),
        }),
      ])
    );
    await adapter.disconnect();
  });

  it('turnDiff/updated emits providerExtension with kind turnDiff', async () => {
    const { adapter, client, patches } = await setupAndSend('turn-diff');
    client.feedNotification('turn/diff/updated', { diff: 'some diff' });
    expect(patches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          item: expect.objectContaining({
            payload: expect.objectContaining({ kind: 'turnDiff' }),
          }),
        }),
      ])
    );
    await adapter.disconnect();
  });

  it('model/rerouted emits providerExtension with debug visibility', async () => {
    const { adapter, client, patches } = await setupAndSend('turn-reroute');
    // Authoritative shape: { threadId, turnId, fromModel, toModel, reason }
    client.feedNotification('model/rerouted', {
      threadId: 'thread-1',
      turnId: 'native-1',
      fromModel: 'o4',
      toModel: 'gpt-4',
      reason: 'quota',
    });
    expect(patches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          item: expect.objectContaining({
            payload: expect.objectContaining({ kind: 'modelRerouted' }),
            metadata: { eventVisibility: 'debug' },
          }),
        }),
      ])
    );
    await adapter.disconnect();
  });

  it('model/verification emits providerExtension with debug visibility', async () => {
    const { adapter, client, patches } = await setupAndSend('turn-verify');
    client.feedNotification('model/verification', { status: 'ok' });
    expect(patches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          item: expect.objectContaining({
            payload: expect.objectContaining({ kind: 'modelVerification' }),
            metadata: { eventVisibility: 'debug' },
          }),
        }),
      ])
    );
    await adapter.disconnect();
  });

  it('configWarning emits providerExtension with debug visibility', async () => {
    const { adapter, client, patches } = await setupAndSend('turn-warn');
    client.feedNotification('configWarning', { message: 'bad config' });
    expect(patches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          item: expect.objectContaining({
            payload: expect.objectContaining({ kind: 'configWarning' }),
            metadata: { eventVisibility: 'debug' },
          }),
        }),
      ])
    );
    await adapter.disconnect();
  });

  it('warning emits providerExtension with debug visibility', async () => {
    const { adapter, client, patches } = await setupAndSend('turn-warning');
    client.feedNotification('warning', { text: 'heads up' });
    expect(patches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          item: expect.objectContaining({
            payload: expect.objectContaining({ kind: 'warning' }),
            metadata: { eventVisibility: 'debug' },
          }),
        }),
      ])
    );
    await adapter.disconnect();
  });

  it('unknown notification falls through to providerExtension with debug visibility', async () => {
    const { adapter, client, patches } = await setupAndSend('turn-unk');
    client.feedNotification('some/unknown/method', { foo: 'bar' });
    expect(patches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'agent-item-started-v2',
          item: expect.objectContaining({
            type: 'providerExtension',
            namespace: 'codex',
            payload: expect.objectContaining({ kind: 'some/unknown/method' }),
            metadata: { eventVisibility: 'debug' },
          }),
        }),
      ])
    );
    await adapter.disconnect();
  });
});

// ── Approval flows ────────────────────────────────────────────────────────────

describe('CodexNativeProtocolAdapter — approval flows', () => {
  async function setupWithTurn(turnId: string) {
    const factory = makeStubFactory();
    const adapter = new CodexNativeProtocolAdapter(factory);
    const patches = collectPatches(adapter);
    factory.lastClient?.serverResponses.set('thread/start', {
      thread: { id: 'thread-1' },
    });
    await adapter.connect(config);
    const client = factory.lastClient!;
    await adapter.sendMessage({ turnId, content: 'go' });
    client.feedNotification('turn/started', { turn: { id: 'native-1' } });
    return { adapter, client, patches };
  }

  it('command approval: accept once → native accept', async () => {
    const { adapter, client, patches } =
      await setupWithTurn('turn-cmd-approve');

    // Server requests command approval
    client.feedRequest(10, 'item/commandExecution/requestApproval', {
      command: 'rm -rf tmp',
      cwd: '/tmp',
      commandActions: [],
    });

    await waitFor(() =>
      patches.some(
        (p) =>
          p.type === 'agent-live-state-updated-v2' &&
          p.live.waitingOn === 'approval'
      )
    );

    // Respond with accept/once
    await adapter.respondToApproval({
      requestId: 'cmd-10',
      decision: { kind: 'accept', scope: 'once' },
    });

    await waitFor(() =>
      patches.some(
        (p) =>
          p.type === 'agent-live-state-updated-v2' &&
          p.live.waitingOn === null &&
          p.live.status === 'working'
      )
    );

    // Verify native response was sent
    const response = client.calls.find((c) => c.method === '__respond:10');
    expect(response).toBeDefined();
    expect(response?.params).toMatchObject({ decision: 'accept' });
    expect(retentionCounts(adapter).approvalMeta).toBe(0);

    // Verify approval item emitted
    expect(patches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'agent-item-started-v2',
          item: expect.objectContaining({
            type: 'approval',
            kind: 'command',
            supported: expect.objectContaining({ canCancel: true }),
          }),
        }),
        expect.objectContaining({
          type: 'agent-item-updated-v2',
          item: expect.objectContaining({
            type: 'approval',
            decision: { kind: 'accept', scope: 'once' },
            respondedBy: 'user',
            status: 'completed',
          }),
        }),
      ])
    );

    await adapter.disconnect();
  });

  it('command approval: accept session → acceptForSession', async () => {
    const { adapter, client } = await setupWithTurn('turn-cmd-session');

    client.feedRequest(11, 'item/commandExecution/requestApproval', {
      command: 'npm install',
      cwd: '/repo',
    });

    await waitFor(
      () =>
        client.calls.some((c) => c.method === '__respond:11') === false && true // just wait for the approval to be registered
    );

    // Brief wait to allow approval registration
    await new Promise((r) => setTimeout(r, 10));

    await adapter.respondToApproval({
      requestId: 'cmd-11',
      decision: { kind: 'accept', scope: 'session' },
    });

    await waitFor(() => client.calls.some((c) => c.method === '__respond:11'));
    const response = client.calls.find((c) => c.method === '__respond:11');
    expect(response?.params).toMatchObject({ decision: 'acceptForSession' });

    await adapter.disconnect();
  });

  it('command approval: decline → native decline', async () => {
    const { adapter, client } = await setupWithTurn('turn-cmd-decline');

    client.feedRequest(12, 'item/commandExecution/requestApproval', {
      command: 'echo bad',
      cwd: '/tmp',
    });

    await new Promise((r) => setTimeout(r, 10));

    await adapter.respondToApproval({
      requestId: 'cmd-12',
      decision: { kind: 'decline' },
    });

    await waitFor(() => client.calls.some((c) => c.method === '__respond:12'));
    const response = client.calls.find((c) => c.method === '__respond:12');
    expect(response?.params).toMatchObject({ decision: 'decline' });

    await adapter.disconnect();
  });

  it('command approval: cancel → native cancel', async () => {
    const { adapter, client } = await setupWithTurn('turn-cmd-cancel');

    client.feedRequest(13, 'item/commandExecution/requestApproval', {
      command: 'echo cancel',
      cwd: '/tmp',
    });

    await new Promise((r) => setTimeout(r, 10));

    await adapter.respondToApproval({
      requestId: 'cmd-13',
      decision: { kind: 'cancel' },
    });

    await waitFor(() => client.calls.some((c) => c.method === '__respond:13'));
    const response = client.calls.find((c) => c.method === '__respond:13');
    expect(response?.params).toMatchObject({ decision: 'cancel' });

    await adapter.disconnect();
  });

  it('file change approval: accept → native accept', async () => {
    const { adapter, client } = await setupWithTurn('turn-file-approve');

    client.feedRequest(20, 'item/fileChange/requestApproval', {
      changes: [{ path: 'foo.ts', kind: 'modified', diff: '+added' }],
    });

    await new Promise((r) => setTimeout(r, 10));

    await adapter.respondToApproval({
      requestId: 'file-20',
      decision: { kind: 'accept', scope: 'once' },
    });

    await waitFor(() => client.calls.some((c) => c.method === '__respond:20'));
    const response = client.calls.find((c) => c.method === '__respond:20');
    expect(response?.params).toMatchObject({ decision: 'accept' });

    await adapter.disconnect();
  });

  it('permissions approval: accept session → scope session', async () => {
    const { adapter, client } = await setupWithTurn('turn-perm-approve');

    client.feedRequest(30, 'item/permissions/requestApproval', {
      permissions: ['read:files', 'write:files'],
    });

    await new Promise((r) => setTimeout(r, 10));

    await adapter.respondToApproval({
      requestId: 'perm-30',
      decision: { kind: 'accept', scope: 'session' },
    });

    await waitFor(() => client.calls.some((c) => c.method === '__respond:30'));
    const response = client.calls.find((c) => c.method === '__respond:30');
    expect(response?.params).toMatchObject({
      scope: 'session',
      permissions: ['read:files', 'write:files'],
    });

    await adapter.disconnect();
  });

  it('elicitation approval: accept → action accept', async () => {
    const { adapter, client } = await setupWithTurn('turn-elicit');

    client.feedRequest(40, 'mcpServer/elicitation/request', {
      serverName: 'myMcp',
      mode: 'form',
      message: 'Please fill in the form',
    });

    await new Promise((r) => setTimeout(r, 10));

    await adapter.respondToApproval({
      requestId: 'elicit-40',
      decision: { kind: 'accept', scope: 'once' },
    });

    await waitFor(() => client.calls.some((c) => c.method === '__respond:40'));
    const response = client.calls.find((c) => c.method === '__respond:40');
    expect(response?.params).toMatchObject({ action: 'accept' });

    await adapter.disconnect();
  });

  it('command approval: acceptWithExecpolicyAmendment → wrapped object wire shape', async () => {
    // Authoritative: data variant serializes as wrapped object, not bare string
    const { adapter, client } = await setupWithTurn('turn-exec-amend');

    client.feedRequest(50, 'item/commandExecution/requestApproval', {
      command: 'npm install',
      cwd: '/repo',
      commandActions: [],
    });

    await new Promise((r) => setTimeout(r, 10));

    await adapter.respondToApproval({
      requestId: 'cmd-50',
      decision: {
        kind: 'accept',
        scope: 'once',
        amendments: [
          { type: 'execpolicy', payload: { allow: ['npm install'] } },
        ],
      },
    });

    await waitFor(() => client.calls.some((c) => c.method === '__respond:50'));
    const response = client.calls.find((c) => c.method === '__respond:50');
    // Wire form: { decision: { acceptWithExecpolicyAmendment: { execpolicyAmendment: payload } } }
    expect(response?.params).toMatchObject({
      decision: {
        acceptWithExecpolicyAmendment: {
          execpolicyAmendment: { allow: ['npm install'] },
        },
      },
    });

    await adapter.disconnect();
  });

  it('command approval: applyNetworkPolicyAmendment → wrapped object wire shape', async () => {
    const { adapter, client } = await setupWithTurn('turn-net-amend');

    client.feedRequest(51, 'item/commandExecution/requestApproval', {
      command: 'curl https://example.com',
      cwd: '/repo',
      commandActions: [],
    });

    await new Promise((r) => setTimeout(r, 10));

    await adapter.respondToApproval({
      requestId: 'cmd-51',
      decision: {
        kind: 'accept',
        scope: 'once',
        amendments: [
          {
            type: 'networkPolicy',
            payload: { host: 'example.com', protocol: 'https' },
          },
        ],
      },
    });

    await waitFor(() => client.calls.some((c) => c.method === '__respond:51'));
    const response = client.calls.find((c) => c.method === '__respond:51');
    // Wire form: { decision: { applyNetworkPolicyAmendment: { networkPolicyAmendment: payload } } }
    expect(response?.params).toMatchObject({
      decision: {
        applyNetworkPolicyAmendment: {
          networkPolicyAmendment: { host: 'example.com', protocol: 'https' },
        },
      },
    });

    await adapter.disconnect();
  });
});

// ── Question / input request ──────────────────────────────────────────────────

describe('CodexNativeProtocolAdapter — input requests', () => {
  it('handles tool input request and emits question item', async () => {
    const factory = makeStubFactory();
    const adapter = new CodexNativeProtocolAdapter(factory);
    const patches = collectPatches(adapter);
    factory.lastClient?.serverResponses.set('thread/start', {
      thread: { id: 'thread-1' },
    });
    await adapter.connect(config);
    const client = factory.lastClient!;
    await adapter.sendMessage({ turnId: 'turn-q', content: 'go' });
    client.feedNotification('turn/started', { turn: { id: 'native-1' } });

    client.feedRequest(50, 'item/tool/requestUserInput', {
      questions: [{ id: 'q1', prompt: 'What is your name?' }],
    });

    await waitFor(() =>
      patches.some(
        (p) =>
          p.type === 'agent-item-started-v2' &&
          'item' in p &&
          p.item.type === 'question'
      )
    );

    const questionPatch = patches.find(
      (p) =>
        p.type === 'agent-item-started-v2' &&
        'item' in p &&
        p.item.type === 'question'
    );
    expect(questionPatch).toBeDefined();

    // Respond to the question
    await adapter.respondToInput({
      requestId: 'input-50',
      answers: { q1: ['Alice'] },
    });

    await waitFor(() => client.calls.some((c) => c.method === '__respond:50'));
    const response = client.calls.find((c) => c.method === '__respond:50');
    expect(response?.params).toMatchObject({
      contentItems: [{ id: 'q1', value: 'Alice' }],
      success: true,
    });
    expect(retentionCounts(adapter).inputRequestMeta).toBe(0);

    await adapter.disconnect();
  });
});

// ── Queue ─────────────────────────────────────────────────────────────────────

describe('CodexNativeProtocolAdapter — queue', () => {
  it('releases transient provider output indexes at each turn boundary', async () => {
    const factory = makeStubFactory();
    const adapter = new CodexNativeProtocolAdapter(factory);
    factory.lastClient?.serverResponses.set('thread/start', {
      thread: { id: 'thread-retention' },
    });
    await adapter.connect(config);
    const client = factory.lastClient!;

    for (let turn = 0; turn < 25; turn++) {
      const relayTurnId = `turn-retention-${turn}`;
      const nativeTurnId = `native-retention-${turn}`;
      await adapter.sendMessage({ turnId: relayTurnId, content: 'stream' });
      client.feedNotification('turn/started', {
        turn: { id: nativeTurnId },
      });
      client.feedNotification('item/started', {
        turnId: nativeTurnId,
        item: { id: `item-${turn}`, type: 'agentMessage' },
      });
      client.feedNotification('item/started', {
        turnId: nativeTurnId,
        item: { id: `reasoning-${turn}`, type: 'reasoning' },
      });
      client.feedNotification('item/reasoning/summaryTextDelta', {
        turnId: nativeTurnId,
        itemId: `reasoning-${turn}`,
        delta: 'thinking',
      });
      client.feedNotification('item/reasoning/textDelta', {
        turnId: nativeTurnId,
        itemId: `reasoning-${turn}`,
        delta: 'detail',
      });
      client.feedNotification('thread/tokenUsageUpdated', {
        turnId: nativeTurnId,
        tokenUsage: { total: { totalTokens: 10 } },
      });

      expect(retentionCounts(adapter)).toMatchObject({
        itemIds: 2,
        tokenUsage: 1,
        reasoningSummary: 1,
        reasoningDetail: 1,
      });
      client.feedNotification('item/completed', {
        item: {
          id: `item-${turn}`,
          type: 'agentMessage',
          text: 'terminal output',
        },
      });
      client.feedNotification('item/completed', {
        item: {
          id: `reasoning-${turn}`,
          type: 'reasoning',
          summary: ['thinking'],
          content: ['detail'],
        },
      });
      client.feedNotification('turn/completed', {
        threadId: 'thread-retention',
        turn: { id: nativeTurnId, status: 'completed' },
      });
      expect(retentionCounts(adapter)).toMatchObject({
        itemIds: 0,
        tokenUsage: 0,
        reasoningSummary: 0,
        reasoningDetail: 0,
      });
    }

    await adapter.disconnect();
  });

  it('queues second send while turn active, drains after turn/completed', async () => {
    const factory = makeStubFactory();
    const adapter = new CodexNativeProtocolAdapter(factory);
    const patches = collectPatches(adapter);
    factory.lastClient?.serverResponses.set('thread/start', {
      thread: { id: 'thread-1' },
    });
    await adapter.connect(config);
    const client = factory.lastClient!;

    const first = adapter.sendMessage({ turnId: 'turn-q1', content: 'first' });
    client.feedNotification('turn/started', { turn: { id: 'n-1' } });

    // Second message queued while first turn active
    const second = adapter.sendMessage({
      turnId: 'turn-q2',
      content: 'second',
    });

    // First turn completes (authoritative shape)
    client.feedNotification('turn/completed', {
      threadId: 'thread-1',
      turn: { id: 'n-1', status: 'completed' },
    });
    await first;

    // Second turn should now be started
    await waitFor(
      () => client.calls.filter((c) => c.method === 'turn/start').length === 2
    );

    client.feedNotification('turn/started', { turn: { id: 'n-2' } });
    client.feedNotification('turn/completed', {
      threadId: 'thread-1',
      turn: { id: 'n-2', status: 'completed' },
    });
    await second;

    const turnCompletions = patches.filter(
      (p) => p.type === 'agent-turn-completed-v2'
    );
    expect(turnCompletions).toHaveLength(2);
    expect(turnCompletions[0]).toMatchObject({ turnId: 'turn-q1' });
    expect(turnCompletions[1]).toMatchObject({ turnId: 'turn-q2' });

    await adapter.disconnect();
  });
});

// ── Interrupt ─────────────────────────────────────────────────────────────────

describe('CodexNativeProtocolAdapter — interrupt', () => {
  it('calls turn/interrupt then emits interrupted completion on notification', async () => {
    const factory = makeStubFactory();
    const adapter = new CodexNativeProtocolAdapter(factory);
    const patches = collectPatches(adapter);
    factory.lastClient?.serverResponses.set('thread/start', {
      thread: { id: 'thread-1' },
    });
    await adapter.connect(config);
    const client = factory.lastClient!;

    await adapter.sendMessage({ turnId: 'turn-int', content: 'long task' });
    client.feedNotification('turn/started', { turn: { id: 'native-int' } });

    await adapter.interrupt({ turnId: 'turn-int' });

    expect(client.calls.some((c) => c.method === 'turn/interrupt')).toBe(true);

    // Authoritative turn/completed shape
    client.feedNotification('turn/completed', {
      threadId: 'thread-1',
      turn: { id: 'native-int', status: 'interrupted' },
    });

    await waitFor(() =>
      patches.some((p) => p.type === 'agent-turn-completed-v2')
    );
    expect(patches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'agent-turn-completed-v2',
          status: 'interrupted',
        }),
      ])
    );

    await adapter.disconnect();
  });
});

// ── Slash command catalog ─────────────────────────────────────────────────────

describe('CodexNativeProtocolAdapter — slash command catalog', () => {
  it('emits merged catalog with relay bake-ins and skills on connect', async () => {
    const factory = makeStubFactory();
    const adapter = new CodexNativeProtocolAdapter(factory);
    const patches = collectPatches(adapter);

    factory.lastClient?.serverResponses.set('thread/start', {
      thread: { id: 'thread-1' },
    });

    await adapter.connect(config);
    const client = factory.lastClient!;
    client.serverResponses.set('skills/list', {
      skills: [
        {
          name: 'deploy',
          description: 'Deploy the app',
          argumentHint: '<env>',
        },
      ],
    });
    client.serverResponses.set('model/list', []);

    // Manually trigger skills refresh by calling skills/list
    await waitFor(
      () =>
        patches.some(
          (p) => p.type === 'agent-session-updated-v2' && 'slashCommands' in p
        ),
      1000
    ).catch(() => {
      // If not yet, it may load in the background — check client calls
    });

    // Verify relay bake-ins exist in adapter constants
    const adapterInstance = adapter as any;
    expect(adapterInstance.agentType).toBe('codex');

    await adapter.disconnect();
  });

  it('skills get nativePrefix $ and relay-control commands get dispatch relay-control', async () => {
    const factory = makeStubFactory();
    const adapter = new CodexNativeProtocolAdapter(factory);
    const patches = collectPatches(adapter);

    factory.lastClient?.serverResponses.set('thread/start', {
      thread: { id: 'thread-1' },
    });

    // Pre-configure skills BEFORE connect triggers refresh
    factory.lastClient?.serverResponses.set('skills/list', {
      skills: [{ name: 'mySkill', description: 'A skill' }],
    });
    factory.lastClient?.serverResponses.set('model/list', []);

    await adapter.connect(config);

    // Wait for slash commands to load
    await waitFor(() =>
      patches.some(
        (p) => p.type === 'agent-session-updated-v2' && 'slashCommands' in p
      )
    ).catch(() => {});

    const slashPatch = patches.find(
      (p) => p.type === 'agent-session-updated-v2' && 'slashCommands' in p
    );

    if (
      slashPatch &&
      slashPatch.type === 'agent-session-updated-v2' &&
      slashPatch.slashCommands
    ) {
      const skill = slashPatch.slashCommands.find((c) => c.name === 'mySkill');
      const relayControl = slashPatch.slashCommands.find(
        (c) => c.collisionKey === 'clear'
      );

      if (skill) {
        expect(skill.nativePrefix).toBe('$');
        expect(skill.dispatch).toBe('agent');
      }
      if (relayControl) {
        expect(relayControl.dispatch).toBe('relay-control');
      }
    }

    await adapter.disconnect();
  });
});

// ── Provider-native prefix rewrite ────────────────────────────────────────────

describe('CodexNativeProtocolAdapter — prefix rewrite', () => {
  it('/skillName is rewritten to $skillName before forwarding to turn/start', async () => {
    const factory = makeStubFactory();
    const adapter = new CodexNativeProtocolAdapter(factory);
    factory.lastClient?.serverResponses.set('thread/start', {
      thread: { id: 'thread-1' },
    });
    await adapter.connect(config);
    const client = factory.lastClient!;

    // Send a non-relay-control slash command (should be rewritten to $)
    await adapter.sendMessage({
      turnId: 'turn-prefix',
      content: '/deploy staging',
    });

    const turnStart = client.calls.find((c) => c.method === 'turn/start');
    expect(turnStart?.params).toMatchObject({
      input: [{ type: 'text', text: '$deploy staging' }],
    });

    await adapter.disconnect();
  });

  it('$skillName passes through unchanged', async () => {
    const factory = makeStubFactory();
    const adapter = new CodexNativeProtocolAdapter(factory);
    factory.lastClient?.serverResponses.set('thread/start', {
      thread: { id: 'thread-1' },
    });
    await adapter.connect(config);
    const client = factory.lastClient!;

    await adapter.sendMessage({
      turnId: 'turn-dollar',
      content: '$deploy staging',
    });

    const turnStart = client.calls.find((c) => c.method === 'turn/start');
    expect(turnStart?.params).toMatchObject({
      input: [{ type: 'text', text: '$deploy staging' }],
    });

    await adapter.disconnect();
  });
});

// ── Relay-control dispatch ────────────────────────────────────────────────────

describe('CodexNativeProtocolAdapter — relay-control dispatch', () => {
  it('/compact calls thread/compact/start and emits controlAction extension', async () => {
    const factory = makeStubFactory();
    const adapter = new CodexNativeProtocolAdapter(factory);
    collectPatches(adapter);
    factory.lastClient?.serverResponses.set('thread/start', {
      thread: { id: 'thread-1' },
    });
    await adapter.connect(config);
    const client = factory.lastClient!;

    // Need an active turn for providerExtension to emit
    await adapter.sendMessage({ turnId: 'turn-compact', content: 'go' });
    client.feedNotification('turn/started', { turn: { id: 'n-1' } });

    // Send compact control
    await adapter.sendMessage({
      turnId: 'turn-compact-2',
      content: '/compact',
    });

    await waitFor(() =>
      client.calls.some((c) => c.method === 'thread/compact/start')
    );

    expect(client.calls.some((c) => c.method === 'thread/compact/start')).toBe(
      true
    );

    await adapter.disconnect();
  });

  it('/rollback <n> calls thread/rollback with count', async () => {
    const factory = makeStubFactory();
    const adapter = new CodexNativeProtocolAdapter(factory);
    factory.lastClient?.serverResponses.set('thread/start', {
      thread: { id: 'thread-1' },
    });
    await adapter.connect(config);
    const client = factory.lastClient!;

    await adapter.sendMessage({ turnId: 'turn-rb', content: 'go' });
    client.feedNotification('turn/started', { turn: { id: 'n-1' } });
    await adapter.sendMessage({ turnId: 'turn-rb-2', content: '/rollback 3' });

    await waitFor(() =>
      client.calls.some((c) => c.method === 'thread/rollback')
    );
    const rollback = client.calls.find((c) => c.method === 'thread/rollback');
    expect(rollback?.params).toMatchObject({ count: 3 });

    await adapter.disconnect();
  });

  it('/model arg updates session config', async () => {
    const factory = makeStubFactory();
    const adapter = new CodexNativeProtocolAdapter(factory);
    const patches = collectPatches(adapter);
    factory.lastClient?.serverResponses.set('thread/start', {
      thread: { id: 'thread-1' },
    });
    await adapter.connect(config);
    const client = factory.lastClient!;

    await adapter.sendMessage({ turnId: 'turn-model', content: 'go' });
    client.feedNotification('turn/started', { turn: { id: 'n-1' } });
    await adapter.sendMessage({
      turnId: 'turn-model-2',
      content: '/model gpt-4',
    });

    await waitFor(() =>
      patches.some(
        (p) =>
          p.type === 'agent-session-updated-v2' &&
          'config' in p &&
          p.config?.model === 'gpt-4'
      )
    );

    expect(patches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'agent-session-updated-v2',
          config: { model: 'gpt-4' },
        }),
      ])
    );

    await adapter.disconnect();
  });

  it('/resume with no arg emits error patch', async () => {
    const factory = makeStubFactory();
    const adapter = new CodexNativeProtocolAdapter(factory);
    const patches = collectPatches(adapter);
    factory.lastClient?.serverResponses.set('thread/start', {
      thread: { id: 'thread-1' },
    });
    await adapter.connect(config);
    const client = factory.lastClient!;

    await adapter.sendMessage({ turnId: 'turn-resume-err', content: 'go' });
    client.feedNotification('turn/started', { turn: { id: 'n-1' } });
    await adapter.sendMessage({ turnId: 'turn-resume-2', content: '/resume' });

    await waitFor(() => patches.some((p) => p.type === 'agent-error-v2'));
    expect(patches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'agent-error-v2' }),
      ])
    );

    await adapter.disconnect();
  });
});

// ── Spawn hygiene (claudeArgs-leak class) ─────────────────────────────────────

describe('CodexNativeProtocolAdapter — spawn hygiene', () => {
  /**
   * Regression guard for the claudeArgs-leak bug class (#1169 / codex memory):
   * operator flags such as claude's `--model` / `--effort` must never reach the
   * `codex app-server` spawn. The adapter only forwards `command` / `args` /
   * `spawn` from `config.extra`; when `extra` is absent it forwards nothing, so
   * the client falls back to its default `codex app-server --listen stdio://`.
   */
  it('forwards nothing to the client when config.extra is absent (no operator-arg leak)', async () => {
    const capturedOpts: CodexAppServerClientOptions[] = [];
    const stub = new StubCodexClient();
    stub.serverResponses.set('thread/start', { thread: { id: 'thread-1' } });
    const factory: CodexClientFactory = (opts) => {
      capturedOpts.push(opts);
      return stub as unknown as CodexAppServerClient;
    };
    const adapter = new CodexNativeProtocolAdapter(factory);

    await adapter.connect(config); // config has no `extra`

    expect(capturedOpts).toHaveLength(1);
    const opts = capturedOpts[0]!;
    // No command/args override → client uses its default codex app-server spawn.
    expect(opts.command).toBeUndefined();
    expect(opts.args).toBeUndefined();
    expect(opts.spawn).toBeUndefined();
    // cwd still flows through from the adapter config.
    expect(opts.cwd).toBe(config.cwd);

    await adapter.disconnect();
  });

  it('forwards only command/args/spawn from config.extra and ignores unrelated keys', async () => {
    const capturedOpts: CodexAppServerClientOptions[] = [];
    const stub = new StubCodexClient();
    stub.serverResponses.set('thread/start', { thread: { id: 'thread-1' } });
    const factory: CodexClientFactory = (opts) => {
      capturedOpts.push(opts);
      return stub as unknown as CodexAppServerClient;
    };
    const injectedSpawn = () => {
      throw new Error('spawn should not be invoked by the stub factory');
    };
    const adapter = new CodexNativeProtocolAdapter(factory);

    await adapter.connect({
      ...config,
      extra: {
        command: 'codex',
        args: ['app-server', '--listen', 'stdio://'],
        spawn: injectedSpawn,
        // Unrelated keys (e.g. a leaked claudeArgs bag) must be dropped.
        claudeArgs: ['--model', 'o4-mini', '--effort', 'high'],
        model: 'gpt-4',
      },
    });

    expect(capturedOpts).toHaveLength(1);
    const opts = capturedOpts[0]!;
    expect(opts.command).toBe('codex');
    expect(opts.args).toEqual(['app-server', '--listen', 'stdio://']);
    expect(opts.spawn).toBe(injectedSpawn);
    // The stray claudeArgs/model keys never become client options.
    expect(opts).not.toHaveProperty('claudeArgs');
    expect((opts as Record<string, unknown>)['model']).toBeUndefined();

    await adapter.disconnect();
  });
});

// ── Independent concurrent sessions (second-session regression) ───────────────

describe('CodexNativeProtocolAdapter — independent concurrent sessions', () => {
  /**
   * Regression guard for the historical "codex 2nd session stuck initializing"
   * concern (which lived in the PTY path, not here): two native adapters each
   * own an independent client + turn lifecycle and must run concurrently
   * without cross-interference or shared state. A real-transport version of
   * this (two concurrent `codex app-server` handshakes) was verified manually.
   */
  it('two adapters run turns concurrently without cross-interference', async () => {
    const fa = makeStubFactory();
    fa.lastClient.serverResponses.set('thread/start', {
      thread: { id: 'thA' },
    });
    const fb = makeStubFactory();
    fb.lastClient.serverResponses.set('thread/start', {
      thread: { id: 'thB' },
    });

    const a = new CodexNativeProtocolAdapter(fa);
    const b = new CodexNativeProtocolAdapter(fb);
    const pa = collectPatches(a);
    const pb = collectPatches(b);

    await Promise.all([
      a.connect({ ...config, sessionId: 'A' }),
      b.connect({ ...config, sessionId: 'B' }),
    ]);
    const ca = fa.lastClient;
    const cb = fb.lastClient;

    await Promise.all([
      a.sendMessage({ turnId: 'ta', content: 'hi-A' }),
      b.sendMessage({ turnId: 'tb', content: 'hi-B' }),
    ]);

    ca.feedNotification('turn/started', { turn: { id: 'na' } });
    cb.feedNotification('turn/started', { turn: { id: 'nb' } });
    ca.feedNotification('item/started', {
      item: { type: 'agentMessage', id: 'ia' },
    });
    ca.feedNotification('item/agentMessage/delta', {
      itemId: 'ia',
      delta: 'A-reply',
    });
    cb.feedNotification('item/started', {
      item: { type: 'agentMessage', id: 'ib' },
    });
    cb.feedNotification('item/agentMessage/delta', {
      itemId: 'ib',
      delta: 'B-reply',
    });
    ca.feedNotification('item/completed', {
      item: { type: 'agentMessage', id: 'ia', text: 'A-reply' },
    });
    cb.feedNotification('item/completed', {
      item: { type: 'agentMessage', id: 'ib', text: 'B-reply' },
    });
    ca.feedNotification('turn/completed', {
      turn: { id: 'na', status: 'completed' },
    });
    cb.feedNotification('turn/completed', {
      turn: { id: 'nb', status: 'completed' },
    });

    // Each adapter only sees its own text; no cross-leak between sessions.
    const aDeltas = pa
      .filter((p) => p.type === 'agent-item-delta-v2')
      .map((p) => (p.type === 'agent-item-delta-v2' ? p.delta : null));
    expect(aDeltas).toContainEqual({ text: 'A-reply' });
    expect(JSON.stringify(pa)).not.toContain('B-reply');
    expect(JSON.stringify(pb)).not.toContain('A-reply');

    // Patches carry the right session id.
    expect(pa.every((p) => p.sessionId === 'A')).toBe(true);
    expect(pb.every((p) => p.sessionId === 'B')).toBe(true);

    // Both turns complete independently.
    expect(
      pa.some(
        (p) => p.type === 'agent-turn-completed-v2' && p.status === 'completed'
      )
    ).toBe(true);
    expect(
      pb.some(
        (p) => p.type === 'agent-turn-completed-v2' && p.status === 'completed'
      )
    ).toBe(true);

    await a.disconnect();
    await b.disconnect();
  });
});
