import { describe, expect, it, vi } from 'vitest';
import {
  ABANDONED_APPROVAL_REASON,
  AGENT_NESTING_STRIP_KEYS,
  buildChildEnv,
  createPatchSink,
  emitErrorPatch,
  emitLiveStatePatch,
  emitProviderExtensionPatch,
  emitSessionUpdatePatch,
  emitTurnCompletedPatch,
  emitTurnStartedPatch,
  createTurnQueue,
  AdapterProcessRegistry,
  TurnGuardrails,
  readSseStream,
  reconnectWithStoredConfig,
  resolveAbandonedApprovals,
  type AbandonedApprovalV2,
  type SseRecord,
} from '../../../server/protocol-adapters/adapter-utils.js';
import { CHANNEL_ADAPTER_LAUNCH_CONTRACTS } from '../../../server/protocol-adapters/index.js';
import type { AgentPatchV2 } from '../../../shared/agent-chat-protocol-v2.js';
import { ClaudeProtocolAdapter } from '../../../server/protocol-adapters/claude-adapter.js';
import { CodexNativeProtocolAdapter } from '../../../server/protocol-adapters/codex-native-adapter.js';
import { HermesProtocolAdapter } from '../../../server/protocol-adapters/hermes-adapter.js';
import { OpenCodeProtocolAdapter } from '../../../server/protocol-adapters/opencode-adapter.js';
import { PiAgentProtocolAdapter } from '../../../server/protocol-adapters/pi-agent-adapter.js';
import { PrimeAgentProtocolAdapter } from '../../../server/protocol-adapters/prime-agent-adapter.js';
import type { AdapterConfig } from '../../../server/protocol-adapter-v2.js';

const storedConfig: AdapterConfig = {
  cwd: '/tmp',
  port: 1,
  sessionId: 'relay-session',
  hookToken: 'hook-token',
  configDir: '/tmp',
};

describe('reconnectWithStoredConfig', () => {
  it('tears down and reconnects with the stored config', async () => {
    const order: string[] = [];
    const connect = vi.fn(async () => {
      order.push('connect');
    });

    await reconnectWithStoredConfig({
      config: storedConfig,
      disconnect: async () => {
        order.push('disconnect');
      },
      connect,
    });

    expect(order).toEqual(['disconnect', 'connect']);
    expect(connect).toHaveBeenCalledWith(storedConfig);
  });

  it('throws the default message when no config was stored', async () => {
    const disconnect = vi.fn();
    const connect = vi.fn();

    await expect(
      reconnectWithStoredConfig({ config: null, disconnect, connect })
    ).rejects.toThrow('Cannot reconnect before connect');
    expect(disconnect).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
  });

  it('throws the adapter-supplied message when one is given', async () => {
    await expect(
      reconnectWithStoredConfig({
        config: undefined,
        notConnectedMessage: 'Cannot reconnect before initial connect',
        disconnect: vi.fn(),
        connect: vi.fn(),
      })
    ).rejects.toThrow('Cannot reconnect before initial connect');
  });

  // pi-agent/prime-agent fold the provider session id into the config, and they
  // read it *before* teardown clears adapter state — so the hook must run first.
  it('applies the config transform before disconnect runs', async () => {
    const order: string[] = [];
    const connect = vi.fn(async () => {
      order.push('connect');
    });

    await reconnectWithStoredConfig({
      config: storedConfig,
      transformConfig: (config) => {
        order.push('transform');
        return { ...config, resumeSessionId: 'provider-session' };
      },
      disconnect: async () => {
        order.push('disconnect');
      },
      connect,
    });

    expect(order).toEqual(['transform', 'disconnect', 'connect']);
    expect(connect).toHaveBeenCalledWith({
      ...storedConfig,
      resumeSessionId: 'provider-session',
    });
  });

  it('leaves the stored config untouched when transforming', async () => {
    const config = { ...storedConfig };

    await reconnectWithStoredConfig({
      config,
      transformConfig: (stored) => ({
        ...stored,
        resumeSessionId: 'provider-session',
      }),
      disconnect: vi.fn(),
      connect: vi.fn(),
    });

    expect(config).toEqual(storedConfig);
  });

  it('propagates a connect failure to the caller', async () => {
    await expect(
      reconnectWithStoredConfig({
        config: storedConfig,
        disconnect: vi.fn(),
        connect: async () => {
          throw new Error('transport refused');
        },
      })
    ).rejects.toThrow('transport refused');
  });
});

describe('resolveAbandonedApprovals (#1407)', () => {
  const approval = (
    requestId: string,
    turnId = 'turn-1'
  ): AbandonedApprovalV2 => ({
    requestId,
    turnId,
    card: {
      id: `approval-${requestId}`,
      kind: 'permission',
      description: 'Agent wants to use Bash',
      target: 'rm -rf /',
    },
  });

  it('publishes a terminal card per approval, then one live-state drain', () => {
    const patches: AgentPatchV2[] = [];
    resolveAbandonedApprovals({
      sessionId: 'session-1',
      approvals: [approval('req-a'), approval('req-b', 'turn-2')],
      emitPatch: (patch) => patches.push(patch),
    });

    expect(patches.map((patch) => patch.type)).toEqual([
      'agent-item-updated-v2',
      'agent-item-updated-v2',
      'agent-live-state-updated-v2',
    ]);

    const first = patches[0];
    expect(first?.type === 'agent-item-updated-v2' && first.item).toMatchObject(
      {
        type: 'approval',
        id: 'approval-req-a',
        requestId: 'req-a',
        status: 'cancelled',
        respondedBy: 'timeout',
        decision: { kind: 'cancel' },
        error: ABANDONED_APPROVAL_REASON,
      }
    );
    expect(first?.type === 'agent-item-updated-v2' && first.turnId).toBe(
      'turn-1'
    );
    const second = patches[1];
    expect(second?.type === 'agent-item-updated-v2' && second.turnId).toBe(
      'turn-2'
    );

    const drain = patches[2];
    expect(drain?.type === 'agent-live-state-updated-v2' && drain.live).toEqual(
      {
        waitingOn: null,
        activeRequestIds: [],
      }
    );
  });

  // The transcript must never claim a resolution the wire refused to carry, so
  // the provider is released first and the card follows.
  it('releases the wire before publishing the card', () => {
    const order: string[] = [];
    resolveAbandonedApprovals({
      sessionId: 'session-1',
      approvals: [approval('req-a')],
      emitPatch: (patch) => order.push(patch.type),
      denyOnWire: ({ requestId }) => order.push(`deny:${requestId}`),
    });

    expect(order).toEqual([
      'deny:req-a',
      'agent-item-updated-v2',
      'agent-live-state-updated-v2',
    ]);
  });

  it('emits nothing at all when no approval was outstanding', () => {
    const emitPatch = vi.fn();
    resolveAbandonedApprovals({
      sessionId: 'session-1',
      approvals: [],
      emitPatch,
      denyOnWire: emitPatch,
    });
    expect(emitPatch).not.toHaveBeenCalled();
  });

  it('carries the caller-supplied reason instead of the disconnect default', () => {
    const patches: AgentPatchV2[] = [];
    resolveAbandonedApprovals({
      sessionId: 'session-1',
      approvals: [approval('req-a')],
      emitPatch: (patch) => patches.push(patch),
      reason: 'Approval cancelled: the turn ended before it was answered.',
    });
    const card = patches[0];
    expect(card?.type === 'agent-item-updated-v2' && card.item.error).toBe(
      'Approval cancelled: the turn ended before it was answered.'
    );
  });

  // Provider vocabulary is copied through untouched — the helper only owns how
  // the card ENDS.
  it('preserves the harness-shaped card fields', () => {
    const patches: AgentPatchV2[] = [];
    resolveAbandonedApprovals({
      sessionId: 'session-1',
      approvals: [
        {
          requestId: 'cmd-7',
          turnId: 'turn-1',
          card: {
            id: 'approval-cmd-7',
            kind: 'command',
            description: 'Run command: ls',
            target: 'ls',
            details: { kind: 'command', command: 'ls', cwd: '/tmp' },
            supported: {
              scopes: ['once'],
              amendmentTypes: [],
              canCancel: true,
            },
          },
        },
      ],
      emitPatch: (patch) => patches.push(patch),
    });
    const card = patches[0];
    expect(card?.type === 'agent-item-updated-v2' && card.item).toMatchObject({
      kind: 'command',
      details: { kind: 'command', command: 'ls', cwd: '/tmp' },
      supported: { scopes: ['once'], amendmentTypes: [], canCancel: true },
    });
  });
});

// The shared helper replaced six hand-written reconnect() bodies whose
// not-connected wording already disagreed. The wording is observable, so pin
// each adapter's exact string against the real adapter, not the helper.
describe('adapter reconnect-before-connect messages are unchanged', () => {
  const cases: Array<[string, { reconnect(): Promise<void> }, string]> = [
    ['claude', new ClaudeProtocolAdapter(), 'Cannot reconnect before connect'],
    [
      'codex-native',
      new CodexNativeProtocolAdapter(),
      'Cannot reconnect before connect',
    ],
    [
      'hermes',
      new HermesProtocolAdapter(),
      'Cannot reconnect before initial connect',
    ],
    [
      'opencode',
      new OpenCodeProtocolAdapter(),
      'Cannot reconnect before initial connect',
    ],
    [
      'pi-agent',
      new PiAgentProtocolAdapter(),
      'Cannot reconnect before connect',
    ],
    [
      'prime-agent',
      new PrimeAgentProtocolAdapter(),
      'Cannot reconnect before connect',
    ],
  ];

  for (const [name, adapter, message] of cases) {
    it(`${name} throws "${message}"`, async () => {
      await expect(adapter.reconnect()).rejects.toThrow(message);
    });
  }
});

describe('buildChildEnv', () => {
  const witness = 'RELAY_BUILD_CHILD_ENV_WITNESS';

  function withProcessEnv<T>(
    overrides: Record<string, string>,
    body: () => T
  ): T {
    const saved = new Map<string, string | undefined>();
    for (const [key, value] of Object.entries(overrides)) {
      saved.set(key, process.env[key]);
      process.env[key] = value;
    }
    try {
      return body();
    } finally {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }

  it('strips the whole nesting set, not just CLAUDECODE', () => {
    // Only claude-adapter used to strip CLAUDE_CODE_ENTRYPOINT; codex, pi,
    // prime, and opencode inherited whatever launched the hub.
    const env = withProcessEnv(
      { CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', [witness]: 'kept' },
      () => buildChildEnv({ platform: 'linux' })
    );
    expect(env).not.toHaveProperty('CLAUDECODE');
    expect(env).not.toHaveProperty('CLAUDE_CODE_ENTRYPOINT');
    expect(env[witness]).toBe('kept');
  });

  it('exposes the nesting set as the exact constant the denylists compose from', () => {
    expect([...AGENT_NESTING_STRIP_KEYS]).toEqual([
      'CLAUDECODE',
      'CLAUDE_CODE_ENTRYPOINT',
    ]);
  });

  it('lays the profile overlay over the hub env', () => {
    const env = withProcessEnv({ [witness]: 'from-hub' }, () =>
      buildChildEnv({
        processEnv: { [witness]: 'from-profile', EXTRA: 'added' },
        platform: 'linux',
      })
    );
    expect(env[witness]).toBe('from-profile');
    expect(env.EXTRA).toBe('added');
  });

  it('strips AFTER the overlay so a profile cannot reintroduce a denied key', () => {
    // The ordering is the whole reason these are deletes and not a filter on
    // the base env: the overlay is trusted for values, never for these keys.
    const env = buildChildEnv({
      processEnv: {
        CLAUDECODE: 'reintroduced',
        CLAUDE_CODE_ENTRYPOINT: 'reintroduced',
        OPENCODE_SERVER_PASSWORD: 'reintroduced',
      },
      denylist: ['OPENCODE_SERVER_PASSWORD'],
      platform: 'linux',
    });
    expect(env).not.toHaveProperty('CLAUDECODE');
    expect(env).not.toHaveProperty('CLAUDE_CODE_ENTRYPOINT');
    expect(env).not.toHaveProperty('OPENCODE_SERVER_PASSWORD');
  });

  it('merges the provider denylist with the nesting set rather than replacing it', () => {
    const env = buildChildEnv({
      processEnv: { CLAUDECODE: 'x', PROVIDER_SECRET: 'y', SAFE: 'z' },
      denylist: ['PROVIDER_SECRET'],
      platform: 'linux',
    });
    expect(env).not.toHaveProperty('CLAUDECODE');
    expect(env).not.toHaveProperty('PROVIDER_SECRET');
    expect(env.SAFE).toBe('z');
  });

  it('is case-sensitive off win32', () => {
    const env = buildChildEnv({
      processEnv: { ClaudeCode: 'mixed-case' },
      platform: 'linux',
    });
    expect(env.ClaudeCode).toBe('mixed-case');
  });

  it('folds case on win32, matching Windows env semantics and sanitizeChannelAdapterProcessEnv', () => {
    const env = buildChildEnv({
      processEnv: {
        ClaudeCode: 'mixed-case',
        claude_code_entrypoint: 'lower',
        OpenCode_Server_Password: 'mixed-case',
        Safe: 'kept',
      },
      denylist: ['OPENCODE_SERVER_PASSWORD'],
      platform: 'win32',
    });
    expect(env).not.toHaveProperty('ClaudeCode');
    expect(env).not.toHaveProperty('claude_code_entrypoint');
    expect(env).not.toHaveProperty('OpenCode_Server_Password');
    expect(env.Safe).toBe('kept');
  });

  it('every provider descriptor denylist contains the nesting set', () => {
    // The spawn-time strip (buildChildEnv) and the profile-time strip
    // (sanitizeChannelAdapterProcessEnv, which reads these) must not disagree:
    // a key enforced against profiles but not at spawn is silently inherited.
    for (const contract of Object.values(CHANNEL_ADAPTER_LAUNCH_CONTRACTS)) {
      if (contract.requirement.kind !== 'command') continue;
      for (const key of AGENT_NESTING_STRIP_KEYS) {
        expect(contract.processEnvDenylist).toContain(key);
      }
    }
  });
});

describe('readSseStream', () => {
  /** A ReadableStream that yields exactly the given chunks, as bytes. */
  function streamOf(chunks: (string | Uint8Array)[]): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    return new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(
            typeof chunk === 'string' ? encoder.encode(chunk) : chunk
          );
        }
        controller.close();
      },
    });
  }

  async function collect(
    chunks: (string | Uint8Array)[]
  ): Promise<SseRecord[]> {
    const records: SseRecord[] = [];
    await readSseStream(streamOf(chunks), (record) => records.push(record));
    return records;
  }

  it('dispatches a data-only record on the blank line', async () => {
    expect(await collect(['data: {"a":1}\n\n'])).toEqual([{ data: '{"a":1}' }]);
  });

  it('carries the event: name when the stream sends one', async () => {
    expect(
      await collect(['event: response.created\ndata: {"a":1}\n\n'])
    ).toEqual([{ event: 'response.created', data: '{"a":1}' }]);
  });

  it('omits `event` entirely when the stream sends none', async () => {
    const [record] = await collect(['data: {"a":1}\n\n']);
    expect(record).not.toHaveProperty('event');
  });

  it('joins multi-line data with \\n in arrival order', async () => {
    expect(await collect(['data: line one\ndata: line two\n\n'])).toEqual([
      { data: 'line one\nline two' },
    ]);
  });

  it('resets the event name between records so it does not leak forward', async () => {
    expect(
      await collect([
        'event: first\ndata: 1\n\n',
        'data: 2\n\n',
        'event: third\ndata: 3\n\n',
      ])
    ).toEqual([
      { event: 'first', data: '1' },
      { data: '2' },
      { event: 'third', data: '3' },
    ]);
  });

  it('reassembles a record split across chunks at any boundary', async () => {
    const source = 'event: e1\ndata: {"a":1}\n\nevent: e2\ndata: {"b":2}\n\n';
    for (let split = 1; split < source.length; split += 1) {
      expect(await collect([source.slice(0, split), source.slice(split)])).toEqual(
        [
          { event: 'e1', data: '{"a":1}' },
          { event: 'e2', data: '{"b":2}' },
        ]
      );
    }
  });

  it('keeps a record whose data and terminating blank line arrive in different chunks', async () => {
    // The opencode-attached bug: with `eventData` declared inside the read
    // loop, the accumulator was wiped between chunks and this event vanished.
    expect(await collect(['data: {"type":"straddled"}\n', '\n'])).toEqual([
      { data: '{"type":"straddled"}' },
    ]);
  });

  it('reassembles a multi-byte character split across chunks', async () => {
    const bytes = new TextEncoder().encode('data: {"t":"世界"}\n\n');
    for (let split = 1; split < bytes.length; split += 1) {
      const records = await collect([
        bytes.subarray(0, split),
        bytes.subarray(split),
      ]);
      expect(records).toEqual([{ data: '{"t":"世界"}' }]);
    }
  });

  it('ignores a blank line with nothing accumulated (SSE keep-alives)', async () => {
    expect(await collect(['\n\n\n', 'data: 1\n\n', '\n\n'])).toEqual([
      { data: '1' },
    ]);
  });

  it('ignores comment lines and unknown fields', async () => {
    expect(await collect([': keep-alive\nid: 7\ndata: 1\n\n'])).toEqual([
      { data: '1' },
    ]);
  });

  it('trims one space after the field colon, as all three adapters did', async () => {
    expect(await collect(['data:no-space\n\n'])).toEqual([{ data: 'no-space' }]);
    expect(await collect(['data:   padded   \n\n'])).toEqual([
      { data: 'padded' },
    ]);
  });

  it('discards a record left unterminated at end of stream', async () => {
    // No blank line ever arrives; all three hand-written loops dropped it.
    expect(await collect(['data: {"a":1}\n'])).toEqual([]);
  });

  it('resolves on an empty stream', async () => {
    expect(await collect([])).toEqual([]);
  });
});

describe('patch emission conventions', () => {
  function harness(sessionId = 'session-1') {
    const patches: AgentPatchV2[] = [];
    let current = sessionId;
    const sink = createPatchSink(
      () => current,
      (patch) => patches.push(patch)
    );
    return {
      sink,
      patches,
      setSessionId: (value: string) => {
        current = value;
      },
    };
  }

  it('reads sessionId live, so a reconnect under a new id is not stale', () => {
    const { sink, patches, setSessionId } = harness('first');
    emitLiveStatePatch(sink, { status: 'idle' });
    setSessionId('second');
    emitLiveStatePatch(sink, { status: 'idle' });
    expect(patches.map((p) => p.sessionId)).toEqual(['first', 'second']);
  });

  describe('emitLiveStatePatch', () => {
    it('publishes the live delta untouched', () => {
      const { sink, patches } = harness();
      emitLiveStatePatch(sink, { status: 'busy', queueLength: 2 });
      expect(patches).toHaveLength(1);
      expect(patches[0]).toMatchObject({
        type: 'agent-live-state-updated-v2',
        sessionId: 'session-1',
        live: { status: 'busy', queueLength: 2 },
      });
      expect(patches[0]?.timestamp).toBeTypeOf('string');
    });
  });

  describe('emitSessionUpdatePatch', () => {
    it('omits absent fields entirely rather than sending undefined', () => {
      // The reducer distinguishes "not in this patch" from "explicitly
      // cleared", so an `undefined` key is not the same as no key.
      const { sink, patches } = harness();
      emitSessionUpdatePatch(sink, { providerSession: { id: 'abc' } });
      const patch = patches[0] as Record<string, unknown>;
      expect(patch.providerSession).toEqual({ id: 'abc' });
      expect(patch).not.toHaveProperty('capabilities');
      expect(patch).not.toHaveProperty('config');
      expect(patch).not.toHaveProperty('slashCommands');
      expect(Object.keys(patch)).not.toContain('capabilities');
    });

    it('carries every field the caller does supply', () => {
      const { sink, patches } = harness();
      emitSessionUpdatePatch(sink, {
        providerSession: { id: 'abc' },
        config: { model: 'test-model' },
        slashCommands: [],
      });
      expect(patches[0]).toMatchObject({
        type: 'agent-session-updated-v2',
        providerSession: { id: 'abc' },
        config: { model: 'test-model' },
        slashCommands: [],
      });
    });

    it('emits an empty slashCommands array rather than treating it as absent', () => {
      const { sink, patches } = harness();
      emitSessionUpdatePatch(sink, { slashCommands: [] });
      expect(patches[0]).toHaveProperty('slashCommands', []);
    });
  });

  describe('emitProviderExtensionPatch', () => {
    it('builds the transcript-durable id as ext-<namespace>-<turnId>-<seq>', () => {
      const { sink, patches } = harness();
      emitProviderExtensionPatch(sink, {
        turnId: 'turn-3',
        namespace: 'codex',
        seq: 7,
        payload: { kind: 'note' },
      });
      expect(patches[0]).toMatchObject({
        type: 'agent-item-started-v2',
        turnId: 'turn-3',
        item: {
          type: 'providerExtension',
          id: 'ext-codex-turn-3-7',
          namespace: 'codex',
          payload: { kind: 'note' },
          status: 'completed',
        },
      });
    });

    it('adds no visibility metadata for the default `normal`', () => {
      const { sink, patches } = harness();
      emitProviderExtensionPatch(sink, {
        turnId: 't',
        namespace: 'pi',
        seq: 1,
        payload: {},
      });
      const patch = patches[0] as { item: Record<string, unknown> };
      expect(patch.item).not.toHaveProperty('metadata');
    });

    it('tags debug and trace alike — any non-normal visibility is metadata', () => {
      const { sink, patches } = harness();
      emitProviderExtensionPatch(sink, {
        turnId: 't',
        namespace: 'pi',
        seq: 1,
        payload: {},
        visibility: 'debug',
      });
      emitProviderExtensionPatch(sink, {
        turnId: 't',
        namespace: 'claude',
        seq: 2,
        payload: {},
        visibility: 'trace',
      });
      expect((patches[0] as { item: Record<string, unknown> }).item).toMatchObject(
        { metadata: { eventVisibility: 'debug' } }
      );
      expect((patches[1] as { item: Record<string, unknown> }).item).toMatchObject(
        { metadata: { eventVisibility: 'trace' } }
      );
    });

    it('stamps timestamp, startedAt, and completedAt from one clock read', () => {
      // claude and codex each called nowIso() three times here, which could
      // stamp an item as having started after the patch announcing it.
      const { sink, patches } = harness();
      emitProviderExtensionPatch(sink, {
        turnId: 't',
        namespace: 'pi',
        seq: 1,
        payload: {},
      });
      const patch = patches[0] as {
        timestamp: string;
        item: { startedAt: string; completedAt: string };
      };
      expect(patch.item.startedAt).toBe(patch.timestamp);
      expect(patch.item.completedAt).toBe(patch.timestamp);
    });
  });

  describe('emitErrorPatch', () => {
    it('attaches the turn id when there is an active turn', () => {
      const { sink, patches } = harness();
      emitErrorPatch(sink, 'boom', 'turn-9');
      expect(patches[0]).toMatchObject({
        type: 'agent-error-v2',
        sessionId: 'session-1',
        message: 'boom',
        turnId: 'turn-9',
      });
    });

    it('omits turnId entirely when there is no active turn', () => {
      const { sink, patches } = harness();
      emitErrorPatch(sink, 'boom');
      emitErrorPatch(sink, 'boom', null);
      for (const patch of patches) {
        expect(patch).not.toHaveProperty('turnId');
      }
    });
  });

  describe('emitTurnStartedPatch', () => {
    it('opens a turn with an empty item list and a user- input message id', () => {
      const { sink, patches } = harness();
      emitTurnStartedPatch(sink, { turnId: 't1', startedAt: '2020-01-01T00:00:00.000Z' });
      expect(patches[0]).toEqual({
        type: 'agent-turn-started-v2',
        sessionId: 'session-1',
        timestamp: '2020-01-01T00:00:00.000Z',
        turn: {
          id: 't1',
          status: 'running',
          inputMessageId: 'user-t1',
          items: [],
          startedAt: '2020-01-01T00:00:00.000Z',
        },
      });
    });
  });

  describe('emitTurnCompletedPatch', () => {
    it('stamps timestamp and completedAt from one clock read', () => {
      const { sink, patches } = harness();
      emitTurnCompletedPatch(sink, {
        turnId: 't1',
        status: 'completed',
        completedAt: '2020-01-01T00:00:05.000Z',
      });
      const patch = patches[0] as { timestamp: string; completedAt: string };
      expect(patch.timestamp).toBe(patch.completedAt);
    });

    it('omits durationMs, usage, and error rather than sending undefined', () => {
      const { sink, patches } = harness();
      emitTurnCompletedPatch(sink, {
        turnId: 't1',
        status: 'completed',
        completedAt: '2020-01-01T00:00:05.000Z',
        durationMs: undefined,
        usage: undefined,
        error: undefined,
      });
      expect(patches[0]).not.toHaveProperty('durationMs');
      expect(patches[0]).not.toHaveProperty('usage');
      expect(patches[0]).not.toHaveProperty('error');
    });
  });

  describe('createTurnQueue', () => {
    function queueHarness(
      overrides: Partial<Parameters<typeof createTurnQueue<string>>[0]> = {}
    ) {
      const started: string[] = [];
      const lengths: Array<[number, string]> = [];
      let draining = true;
      const queue = createTurnQueue<string>({
        canDrain: () => draining,
        startTurn: (input) => {
          started.push(input);
        },
        onLengthChange: (length, reason) => lengths.push([length, reason]),
        ...overrides,
      });
      return {
        queue,
        started,
        lengths,
        block: () => {
          draining = false;
        },
        unblock: () => {
          draining = true;
        },
      };
    }

    it('settles an entry when its turn starts, not when it is queued', async () => {
      const { queue, started, block, unblock } = queueHarness();
      block();
      let settled = false;
      const pending = queue.enqueue('a').then(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);
      expect(started).toEqual([]);

      unblock();
      queue.drain();
      await pending;
      expect(settled).toBe(true);
      expect(started).toEqual(['a']);
    });

    it('waits for an async startTurn before settling the entry', async () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const { queue } = queueHarness({ startTurn: () => gate });
      const pending = queue.enqueue('a');
      queue.drain();
      let settled = false;
      void pending.then(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);
      release();
      await pending;
      expect(settled).toBe(true);
    });

    it('rejects a failed start and keeps draining the rest', async () => {
      const started: string[] = [];
      const queue = createTurnQueue<string>({
        canDrain: () => true,
        startTurn: (input) => {
          if (input === 'poison') throw new Error('cannot start');
          started.push(input);
        },
        onLengthChange: () => {},
      });
      const poisoned = queue.enqueue('poison');
      const next = queue.enqueue('good');
      queue.drain();
      await expect(poisoned).rejects.toThrow('cannot start');
      await next;
      // One poisoned message must not wedge the queue behind it.
      expect(started).toEqual(['good']);
    });

    it('rejects every waiting entry on rejectAll and reports depth once', async () => {
      const { queue, lengths, block } = queueHarness();
      block();
      const first = queue.enqueue('a');
      const second = queue.enqueue('b');
      queue.rejectAll(new Error('transport gone'));
      await expect(first).rejects.toThrow('transport gone');
      await expect(second).rejects.toThrow('transport gone');
      expect(lengths).toEqual([
        [1, 'enqueued'],
        [2, 'enqueued'],
        [0, 'rejected'],
      ]);
    });

    it('stays silent on rejectAll when nothing was waiting', () => {
      const { queue, lengths } = queueHarness();
      queue.rejectAll(new Error('transport gone'));
      expect(lengths).toEqual([]);
    });

    it('requeues work at the front without announcing a depth change', async () => {
      const { queue, started, lengths, block, unblock } = queueHarness();
      block();
      const queued = queue.enqueue('later');
      queue.requeueFront('resumed');
      expect(lengths).toEqual([[1, 'enqueued']]);
      expect(queue.length).toBe(2);

      unblock();
      queue.drain();
      queue.drain();
      await queued;
      expect(started).toEqual(['resumed', 'later']);
    });
  });

  describe('TurnGuardrails', () => {
    function guardrails(
      limits: Partial<{ turnTimeoutMs: number; idleTtlMs: number }> = {}
    ) {
      const values = { turnTimeoutMs: 1_000, idleTtlMs: 5_000, ...limits };
      return new TurnGuardrails({
        turnTimeoutMs: () => values.turnTimeoutMs,
        idleTtlMs: () => values.idleTtlMs,
        crashWindowMs: 10_000,
        maxRespawns: 3,
      });
    }

    it('reports a turn overdue only once its budget is exceeded', () => {
      const g = guardrails();
      g.noteTurnStart(0);
      expect(g.isTurnOverdue(1_000)).toBe(false);
      expect(g.isTurnOverdue(1_001)).toBe(true);
    });

    it('never reports an overdue turn when none is running', () => {
      const g = guardrails();
      expect(g.isTurnOverdue(Number.MAX_SAFE_INTEGER)).toBe(false);
      g.noteTurnStart(0);
      g.noteTurnEnd();
      expect(g.isTurnOverdue(Number.MAX_SAFE_INTEGER)).toBe(false);
    });

    it('excludes approval deliberation from the turn budget', () => {
      const g = guardrails();
      g.noteTurnStart(0);
      g.enterApprovalWait(100);
      // 5s of human deliberation on a 1s turn budget.
      g.settleApprovalWait(0, 5_100);
      // Wall clock is far past the budget, worked time is not.
      expect(g.isTurnOverdue(5_500)).toBe(false);
      expect(g.isTurnOverdue(6_101)).toBe(true);
    });

    it('measures overlapping approvals as one continuous wait', () => {
      const g = guardrails();
      g.noteTurnStart(0);
      g.enterApprovalWait(100);
      g.enterApprovalWait(2_000); // second approval must not restart the clock
      g.settleApprovalWait(0, 5_100);
      expect(g.isTurnOverdue(6_000)).toBe(false);
      expect(g.isTurnOverdue(6_101)).toBe(true);
    });

    it('keeps waiting while approvals remain outstanding', () => {
      const g = guardrails();
      g.noteTurnStart(0);
      g.enterApprovalWait(100);
      g.settleApprovalWait(1, 5_100); // one still open — no credit yet
      expect(g.isTurnOverdue(1_500)).toBe(true);
      g.settleApprovalWait(0, 5_100);
      expect(g.isTurnOverdue(1_500)).toBe(false);
    });

    it('evicts only after the idle window elapses, and any activity defers it', () => {
      const g = guardrails();
      g.noteActivity(0);
      expect(g.isIdle(5_000)).toBe(false);
      expect(g.isIdle(5_001)).toBe(true);
      g.noteActivity(5_001);
      expect(g.isIdle(5_001)).toBe(false);
    });

    it('opens the breaker at the respawn limit inside the window', () => {
      const g = guardrails();
      g.recordCrash(0);
      g.recordCrash(1_000);
      expect(g.isCrashLooping(1_500)).toBe(false);
      g.recordCrash(2_000);
      expect(g.isCrashLooping(2_500)).toBe(true);
    });

    it('prunes crashes that aged out of the window before judging', () => {
      const g = guardrails();
      g.recordCrash(0);
      g.recordCrash(1_000);
      g.recordCrash(2_000);
      expect(g.isCrashLooping(2_500)).toBe(true);
      // The first two are older than the 10s window by now.
      expect(g.isCrashLooping(11_500)).toBe(false);
    });

    it('drops every deadline and the crash history on reset', () => {
      const g = guardrails();
      g.recordCrash(0);
      g.recordCrash(1_000);
      g.recordCrash(2_000);
      g.noteTurnStart(0);
      g.reset(2_500);
      expect(g.isCrashLooping(2_500)).toBe(false);
      expect(g.isTurnOverdue(Number.MAX_SAFE_INTEGER)).toBe(false);
      expect(g.isIdle(2_500)).toBe(false);
    });
  });

  describe('AdapterProcessRegistry', () => {
    function entry(id: string) {
      return {
        registrySessionId: id,
        gcSweep: vi.fn(),
        forceStop: vi.fn(async () => {}),
      };
    }

    it('sweeps registered entries and drops them on unregister', async () => {
      vi.useFakeTimers();
      try {
        const registry = new AdapterProcessRegistry(1_000);
        const a = entry('a');
        registry.register(a);
        vi.advanceTimersByTime(1_000);
        expect(a.gcSweep).toHaveBeenCalledTimes(1);

        registry.unregister('a');
        vi.advanceTimersByTime(5_000);
        // Timer stopped with the last entry: no further sweeps.
        expect(a.gcSweep).toHaveBeenCalledTimes(1);
        expect(registry.size()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it('keeps sweeping siblings when one entry throws', () => {
      vi.useFakeTimers();
      try {
        const registry = new AdapterProcessRegistry(1_000);
        const bad = entry('bad');
        bad.gcSweep.mockImplementation(() => {
          throw new Error('sweep exploded');
        });
        const good = entry('good');
        registry.register(bad);
        registry.register(good);
        vi.advanceTimersByTime(1_000);
        expect(good.gcSweep).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it('force-stops everything on killAll and empties itself', async () => {
      const registry = new AdapterProcessRegistry(1_000_000);
      const a = entry('a');
      const b = entry('b');
      b.forceStop.mockRejectedValue(new Error('already gone'));
      registry.register(a);
      registry.register(b);
      // One failing teardown must not strand the others.
      await registry.killAll();
      expect(a.forceStop).toHaveBeenCalled();
      expect(registry.size()).toBe(0);
    });
  });
});
