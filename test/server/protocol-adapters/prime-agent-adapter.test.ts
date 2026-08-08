import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  PrimeAgentRpcClient,
  PrimeAgentRpcResponseError,
  type PrimeAgentRpcClientOptions,
} from '../../../server/prime-agent-rpc-client.js';
import { AgentControlUnavailableError } from '../../../server/protocol-adapter-v2.js';
import { PrimeAgentProtocolAdapter } from '../../../server/protocol-adapters/prime-agent-adapter.js';
import { CHANNEL_ADAPTER_LAUNCH_CONTRACTS } from '../../../server/protocol-adapters/index.js';

const config = {
  cwd: '/tmp',
  port: 1,
  sessionId: 'relay-session',
  hookToken: 'x',
  configDir: '/tmp',
};

function harness() {
  const client = new PrimeAgentRpcClient();
  vi.spyOn(client, 'start').mockResolvedValue({
    type: 'response',
    command: 'get_state',
    success: true,
    data: {
      sessionId: 'prime-1',
      sessionFile: '/tmp/prime-1.jsonl',
      isStreaming: false,
      thinkingLevel: 'medium',
      model: {
        id: 'gpt-prime',
        name: 'GPT Prime',
        provider: 'prime-inference',
        reasoning: true,
        thinkingLevelMap: { xhigh: 'xhigh' },
      },
    },
  });
  let activeSession = {
    id: 'prime-1',
    file: '/tmp/prime-1.jsonl',
  };
  const call = vi.spyOn(client, 'call').mockImplementation(async (type) => {
    if (type === 'new_session') {
      activeSession = { id: 'prime-2', file: '/tmp/prime-2.jsonl' };
      return {
        type: 'response',
        command: type,
        success: true,
        data: { cancelled: false },
      };
    }
    if (type === 'get_available_models') {
      return {
        type: 'response',
        command: type,
        success: true,
        data: {
          models: [
            {
              id: 'gpt-prime',
              name: 'GPT Prime',
              provider: 'prime-inference',
              reasoning: true,
              thinkingLevelMap: { xhigh: 'xhigh' },
            },
            {
              id: 'claude-prime',
              name: 'Claude Prime',
              provider: 'prime-inference',
              reasoning: true,
            },
          ],
        },
      };
    }
    if (type === 'get_state') {
      return {
        type: 'response',
        command: type,
        success: true,
        data: {
          sessionId: activeSession.id,
          sessionFile: activeSession.file,
          thinkingLevel: 'medium',
          model: {
            id: 'gpt-prime',
            name: 'GPT Prime',
            provider: 'prime-inference',
            reasoning: true,
            thinkingLevelMap: { xhigh: 'xhigh' },
          },
        },
      };
    }
    return { type: 'response', command: type, success: true };
  });
  vi.spyOn(client, 'stop').mockResolvedValue();
  const clientFactoryOptions: PrimeAgentRpcClientOptions[] = [];
  const adapter = new PrimeAgentProtocolAdapter((options) => {
    clientFactoryOptions.push(options);
    return client;
  });
  const patches: Array<Record<string, unknown>> = [];
  adapter.onPatch((patch) =>
    patches.push(patch as unknown as Record<string, unknown>)
  );
  return { adapter, client, call, patches, clientFactoryOptions };
}

describe('PrimeAgentProtocolAdapter', () => {
  it('publishes honest capabilities and provider session identity after get_state', async () => {
    const { adapter, patches, clientFactoryOptions } = harness();
    await adapter.connect({
      ...config,
      processEnv: {
        CLAUDECODE: 'must-be-stripped',
        RELAY_PROFILE_SAFE: 'preserved',
      },
    });
    const launchRequirement =
      CHANNEL_ADAPTER_LAUNCH_CONTRACTS['prime-agent'].requirement;
    expect(launchRequirement.kind).toBe('command');
    if (launchRequirement.kind !== 'command') {
      throw new Error(
        'Prime Agent must remain a command-backed channel adapter'
      );
    }
    expect(clientFactoryOptions[0]?.command).toBe(launchRequirement.command);
    expect(clientFactoryOptions[0]?.env?.RELAY_PROFILE_SAFE).toBe('preserved');
    for (const key of CHANNEL_ADAPTER_LAUNCH_CONTRACTS['prime-agent']
      .processEnvDenylist) {
      expect(clientFactoryOptions[0]?.env).not.toHaveProperty(key);
    }
    expect(adapter.agentType).toBe('prime-agent');
    expect(adapter.capabilities).toMatchObject({
      text: true,
      queue: true,
      interrupt: true,
      resume: true,
      approvals: false,
      questions: false,
      compact: true,
      telemetry: true,
    });
    const snapshot = patches.find(
      (patch) => patch.type === 'agent-session-snapshot-v2'
    );
    expect(snapshot?.session).toMatchObject({
      provider: 'prime-agent',
      providerSession: {
        primeAgentSessionId: 'prime-1',
        primeAgentSessionFile: '/tmp/prime-1.jsonl',
      },
    });
  });

  it('discovers live Prime controls and executes them on the RPC control lane', async () => {
    const { adapter, call, patches } = harness();
    await adapter.connect(config);

    expect(adapter.getSlashCommands()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'new', destructive: true }),
        expect.objectContaining({
          name: 'model',
          args: expect.arrayContaining([
            expect.objectContaining({
              value: 'prime-inference/gpt-prime',
              label: 'GPT Prime',
            }),
          ]),
        }),
        expect.objectContaining({
          name: 'thinking',
          args: expect.arrayContaining([{ value: 'xhigh' }]),
        }),
        expect.objectContaining({ name: 'compact' }),
      ])
    );

    await expect(
      adapter.executeControlCommand({
        command: 'model',
        args: 'other/model',
      })
    ).rejects.toThrow('live Prime Agent catalog');
    await expect(
      adapter.executeControlCommand({
        command: 'thinking',
        args: 'turbo',
      })
    ).rejects.toThrow('thinking must be one of');

    await adapter.executeControlCommand({
      command: 'model',
      args: 'prime-inference/claude-prime',
    });
    await adapter.executeControlCommand({
      command: 'thinking',
      args: 'high',
    });
    await adapter.executeControlCommand({ command: 'compact' });
    await expect(
      adapter.executeControlCommand({ command: 'new' })
    ).rejects.toThrow('requires confirmation');
    await adapter.executeControlCommand({ command: 'new', confirmed: true });

    expect(call.mock.calls).toEqual(
      expect.arrayContaining([
        ['set_model', { provider: 'prime-inference', modelId: 'claude-prime' }],
        ['set_thinking_level', { level: 'high' }],
        ['compact'],
        ['new_session'],
      ])
    );
    expect(patches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'agent-session-updated-v2',
          slashCommands: expect.any(Array),
        }),
        expect.objectContaining({
          type: 'agent-session-updated-v2',
          providerSession: {
            primeAgentSessionId: 'prime-2',
            primeAgentSessionFile: '/tmp/prime-2.jsonl',
          },
        }),
      ])
    );
  });

  it('keeps the catalog empty until delayed current-runtime discovery completes', async () => {
    const { adapter, call } = harness();
    let releaseDiscovery!: (value: Record<string, unknown>) => void;
    const discovery = new Promise<Record<string, unknown>>((resolve) => {
      releaseDiscovery = resolve;
    });
    call.mockImplementation(async (type) => {
      if (type === 'get_available_models') return await discovery;
      return { type: 'response', command: type, success: true };
    });

    const connected = adapter.connect(config);
    await vi.waitFor(() =>
      expect(call).toHaveBeenCalledWith('get_available_models')
    );
    expect(adapter.getSlashCommands()).toEqual([]);

    releaseDiscovery({
      type: 'response',
      command: 'get_available_models',
      success: true,
      data: {
        models: [
          {
            id: 'delayed-prime',
            provider: 'prime-inference',
            reasoning: false,
          },
        ],
      },
    });
    await connected;

    expect(adapter.getSlashCommands().map((command) => command.name)).toEqual(
      expect.arrayContaining(['new', 'model', 'thinking', 'compact'])
    );
  });

  it('retracts only a native method-not-found control and returns typed unavailability', async () => {
    const { adapter, call } = harness();
    await adapter.connect(config);
    call.mockImplementation(async (type) => {
      if (type === 'set_model') {
        throw new PrimeAgentRpcResponseError('set_model', {
          type: 'response',
          command: 'set_model',
          success: false,
          error: 'unknown command: set_model',
        });
      }
      return { type: 'response', command: type, success: true };
    });

    await expect(
      adapter.executeControlCommand({
        command: 'model',
        args: 'prime-inference/gpt-prime',
      })
    ).rejects.toBeInstanceOf(AgentControlUnavailableError);
    expect(adapter.getSlashCommands().map((command) => command.name)).toEqual(
      expect.not.arrayContaining(['model'])
    );
    expect(adapter.getSlashCommands().map((command) => command.name)).toEqual(
      expect.arrayContaining(['new', 'thinking', 'compact'])
    );
  });

  it('does not retract controls for ordinary provider or validation failures', async () => {
    const { adapter, call } = harness();
    await adapter.connect(config);
    call.mockImplementation(async (type) => {
      if (type === 'set_model') {
        throw new PrimeAgentRpcResponseError('set_model', {
          type: 'response',
          command: 'set_model',
          success: false,
          error: 'unknown model: prime-inference/gpt-prime',
        });
      }
      return { type: 'response', command: type, success: true };
    });

    await expect(
      adapter.executeControlCommand({
        command: 'model',
        args: 'prime-inference/gpt-prime',
      })
    ).rejects.toThrow('unknown model');
    await expect(
      adapter.executeControlCommand({
        command: 'thinking',
        args: 'turbo',
      })
    ).rejects.toThrow('thinking must be one of');
    expect(adapter.getSlashCommands().map((command) => command.name)).toContain(
      'model'
    );
  });

  it('fences stale discovery when a reconnect replaces its RPC client', async () => {
    const first = new PrimeAgentRpcClient();
    const second = new PrimeAgentRpcClient();
    const startResponse = {
      type: 'response',
      command: 'get_state',
      success: true,
      data: {
        sessionId: 'prime-session',
        model: {
          id: 'current',
          provider: 'prime-inference',
          reasoning: false,
        },
      },
    };
    vi.spyOn(first, 'start').mockResolvedValue(startResponse);
    vi.spyOn(second, 'start').mockResolvedValue(startResponse);
    vi.spyOn(first, 'stop').mockResolvedValue();
    vi.spyOn(second, 'stop').mockResolvedValue();
    let releaseFirstDiscovery!: (value: Record<string, unknown>) => void;
    const firstDiscovery = new Promise<Record<string, unknown>>((resolve) => {
      releaseFirstDiscovery = resolve;
    });
    const firstCall = vi
      .spyOn(first, 'call')
      .mockImplementation(async (type) => {
        if (type === 'get_available_models') return await firstDiscovery;
        return { type: 'response', command: type, success: true };
      });
    vi.spyOn(second, 'call').mockResolvedValue({
      type: 'response',
      command: 'get_available_models',
      success: true,
      data: {
        models: [
          {
            id: 'fresh',
            provider: 'prime-inference',
            reasoning: false,
          },
        ],
      },
    });
    const clients = [first, second];
    const adapter = new PrimeAgentProtocolAdapter(() => {
      const client = clients.shift();
      if (!client) throw new Error('unexpected Prime client');
      return client;
    });

    const staleConnect = adapter.connect(config);
    await vi.waitFor(() =>
      expect(firstCall).toHaveBeenCalledWith('get_available_models')
    );
    first.emit('close', 0);
    await adapter.reconnect();
    const modelArgs = () =>
      adapter.getSlashCommands().find((command) => command.name === 'model')
        ?.args;
    expect(modelArgs()).toEqual([
      {
        value: 'prime-inference/fresh',
        label: 'fresh',
        description: 'prime-inference',
      },
    ]);

    releaseFirstDiscovery({
      type: 'response',
      command: 'get_available_models',
      success: true,
      data: {
        models: [
          {
            id: 'stale',
            provider: 'prime-inference',
            reasoning: false,
          },
        ],
      },
    });
    await staleConnect;
    expect(modelArgs()).toEqual([
      {
        value: 'prime-inference/fresh',
        label: 'fresh',
        description: 'prime-inference',
      },
    ]);
  });

  it('clears stale optional state after a fresh Prime session', async () => {
    const { adapter, call, patches } = harness();
    await adapter.connect(config);
    call.mockImplementation(async (type) => {
      if (type === 'new_session') {
        return {
          type: 'response',
          command: type,
          success: true,
          data: { cancelled: false },
        };
      }
      if (type === 'get_state') {
        return {
          type: 'response',
          command: type,
          success: true,
          data: { sessionId: 'prime-empty' },
        };
      }
      return { type: 'response', command: type, success: true };
    });

    const result = await adapter.executeControlCommand({
      command: 'new',
      confirmed: true,
    });
    expect(result.config).toEqual({});
    expect(patches.at(-1)).toMatchObject({
      type: 'agent-session-updated-v2',
      providerSession: { primeAgentSessionId: 'prime-empty' },
      config: {},
    });
    expect(
      (patches.at(-1)?.providerSession as Record<string, unknown>)?.[
        'primeAgentSessionFile'
      ]
    ).toBeUndefined();
  });

  it('serializes controls against prompts and other controls', async () => {
    const { adapter, call } = harness();
    await adapter.connect(config);
    let releaseModel!: () => void;
    const modelGate = new Promise<void>((resolve) => {
      releaseModel = resolve;
    });
    call.mockImplementation(async (type) => {
      if (type === 'set_model') await modelGate;
      if (type === 'get_state') {
        return {
          type: 'response',
          command: type,
          success: true,
          data: {
            sessionId: 'prime-1',
            sessionFile: '/tmp/prime-1.jsonl',
            thinkingLevel: 'medium',
            model: {
              id: 'gpt-prime',
              provider: 'prime-inference',
              reasoning: true,
            },
          },
        };
      }
      return { type: 'response', command: type, success: true };
    });

    const changingModel = adapter.executeControlCommand({
      command: 'model',
      args: 'prime-inference/gpt-prime',
    });
    await vi.waitFor(() =>
      expect(call).toHaveBeenCalledWith('set_model', {
        provider: 'prime-inference',
        modelId: 'gpt-prime',
      })
    );
    await expect(
      adapter.sendMessage({ turnId: 'racing-turn', content: 'hello' })
    ).rejects.toThrow('control command is in progress');
    await expect(
      adapter.executeControlCommand({ command: 'compact' })
    ).rejects.toThrow('another Prime Agent control command is in progress');

    releaseModel();
    await changingModel;
  });

  it('fails closed when live model discovery is unavailable', async () => {
    const { adapter, call } = harness();
    call.mockRejectedValueOnce(new Error('unknown command'));
    await adapter.connect(config);
    expect(adapter.getSlashCommands()).toEqual([]);
    await expect(
      adapter.executeControlCommand({
        command: 'model',
        args: 'guessed/model',
      })
    ).rejects.toThrow('unsupported Prime Agent control command');
  });

  it('maps streaming text, thinking, and command tools to V2 patches', async () => {
    const { adapter, client, patches } = harness();
    await adapter.connect(config);
    await adapter.sendMessage({ turnId: 't1', content: 'hello' });
    client.emit('event', {
      type: 'message_update',
      assistantMessageEvent: {
        type: 'text_delta',
        contentIndex: 0,
        delta: 'answer',
      },
    });
    client.emit('event', {
      type: 'message_update',
      assistantMessageEvent: {
        type: 'thinking_delta',
        contentIndex: 1,
        delta: 'thought',
      },
    });
    client.emit('event', {
      type: 'tool_execution_start',
      toolCallId: 'tool-1',
      toolName: 'bash',
      args: { command: 'pwd' },
    });
    client.emit('event', {
      type: 'tool_execution_end',
      toolCallId: 'tool-1',
      toolName: 'bash',
      result: { content: [{ type: 'text', text: '/tmp' }] },
      isError: false,
    });
    client.emit('event', {
      type: 'message_end',
      message: {
        role: 'assistant',
        usage: {
          input: 10,
          output: 4,
          cacheRead: 2,
          cacheWrite: 1,
          cost: { total: 0.25 },
        },
      },
    });
    client.emit('event', { type: 'agent_end' });
    expect(patches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'agent-item-delta-v2',
          itemId: 't1-assistant-0-0',
          delta: { text: 'answer' },
        }),
        expect.objectContaining({
          type: 'agent-item-delta-v2',
          itemId: 't1-reasoning-0-1',
          delta: { summary: 'thought' },
        }),
        expect.objectContaining({
          type: 'agent-turn-completed-v2',
          turnId: 't1',
          status: 'completed',
          usage: {
            inputTokens: 10,
            outputTokens: 4,
            cacheReadTokens: 2,
            cacheWriteTokens: 1,
            costUsd: 0.25,
          },
        }),
      ])
    );
    expect(
      patches.some(
        (patch) =>
          patch.type === 'agent-item-started-v2' &&
          (patch.item as { type?: string }).type === 'commandExecution'
      )
    ).toBe(true);
  });

  it('queues locally while active and uses abort for interrupt', async () => {
    const { adapter, call } = harness();
    await adapter.connect(config);
    await adapter.sendMessage({ turnId: 't1', content: 'one' });
    await adapter.sendMessage({ turnId: 't2', content: 'two' });
    await adapter.interrupt({ turnId: 't1' });
    expect(call.mock.calls.map(([type]) => type)).toEqual([
      'get_available_models',
      'prompt',
      'abort',
    ]);
  });

  it('validates Prime native queue counts and preserves local queued work', async () => {
    const { adapter, client, patches } = harness();
    vi.spyOn(client, 'start').mockResolvedValue({
      type: 'response',
      command: 'get_state',
      success: true,
      data: { sessionActions: { queuedCount: Number.POSITIVE_INFINITY } },
    });
    await adapter.connect(config);
    expect(patches.at(-1)).toMatchObject({
      type: 'agent-live-state-updated-v2',
      live: { queueLength: 0 },
    });

    await adapter.sendMessage({ turnId: 't1', content: 'one' });
    await adapter.sendMessage({ turnId: 't2', content: 'two' });
    client.emit('event', {
      type: 'session_action_update',
      actions: { queuedCount: 'not-a-number' },
    });
    expect(patches.at(-1)).toMatchObject({
      type: 'agent-live-state-updated-v2',
      live: { queueLength: 1 },
    });
    client.emit('event', {
      type: 'session_action_update',
      actions: { queuedCount: 2 },
    });
    expect(patches.at(-1)).toMatchObject({
      type: 'agent-live-state-updated-v2',
      live: { queueLength: 3 },
    });
  });

  it('submits queued Relay turns as fresh prompts after real agent_end boundaries', async () => {
    const { adapter, client, call, patches } = harness();
    await adapter.connect(config);
    await adapter.sendMessage({ turnId: 't1', content: 'one' });
    await adapter.sendMessage({ turnId: 't2', content: 'two' });
    await adapter.sendMessage({ turnId: 't3', content: 'three' });

    client.emit('event', { type: 'turn_end' });
    expect(
      patches.filter((patch) => patch.type === 'agent-turn-completed-v2')
    ).toHaveLength(0);

    client.emit('event', { type: 'agent_end' });
    await vi.waitFor(() =>
      expect(
        patches
          .filter((patch) => patch.type === 'agent-turn-started-v2')
          .map((patch) => (patch.turn as { id: string }).id)
      ).toEqual(['t1', 't2'])
    );
    client.emit('event', { type: 'agent_end' });
    await vi.waitFor(() =>
      expect(
        patches
          .filter((patch) => patch.type === 'agent-turn-started-v2')
          .map((patch) => (patch.turn as { id: string }).id)
      ).toEqual(['t1', 't2', 't3'])
    );
    client.emit('event', { type: 'agent_end' });

    expect(
      patches
        .filter((patch) => patch.type === 'agent-turn-completed-v2')
        .map((patch) => patch.turnId)
    ).toEqual(['t1', 't2', 't3']);
    expect(
      call.mock.calls
        .filter(([type]) => type === 'prompt')
        .map(([, payload]) => (payload as { message: string }).message)
    ).toEqual(['one', 'two', 'three']);
  });

  it('fails closed when a queued prompt acknowledgement is ambiguous', async () => {
    const { adapter, client, call, patches } = harness();
    call.mockImplementation(async (type, payload) => {
      if (
        type === 'prompt' &&
        (payload as { message?: string }).message === 'two'
      )
        throw new Error('prompt timed out');
      return { type: 'response', command: type, success: true };
    });
    await adapter.connect(config);
    await adapter.sendMessage({ turnId: 't1', content: 'one' });
    await adapter.sendMessage({ turnId: 't2', content: 'two' });
    client.emit('event', { type: 'agent_end' });

    await vi.waitFor(() => expect(adapter.status).toBe('disconnected'));
    expect(patches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'agent-turn-completed-v2',
          turnId: 't2',
          status: 'failed',
        }),
      ])
    );
  });

  it('fails closed on protocol corruption and unexpected close', async () => {
    const corrupted = harness();
    await corrupted.adapter.connect(config);
    corrupted.client.emit('protocolError', new Error('bad record'));
    expect(corrupted.adapter.status).toBe('disconnected');
    expect(corrupted.patches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'agent-live-state-updated-v2',
          live: expect.objectContaining({ status: 'disconnected' }),
        }),
      ])
    );

    const closed = harness();
    await closed.adapter.connect(config);
    await closed.adapter.sendMessage({ turnId: 't1', content: 'one' });
    closed.client.emit('close', 1);
    expect(closed.adapter.status).toBe('disconnected');
    expect(closed.patches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'agent-turn-completed-v2',
          turnId: 't1',
          status: 'failed',
        }),
        expect.objectContaining({
          type: 'agent-live-state-updated-v2',
          live: expect.objectContaining({ status: 'disconnected' }),
        }),
      ])
    );
  });

  it('rejects unreadable image attachments explicitly', async () => {
    const { adapter, call } = harness();
    await adapter.connect(config);
    await expect(
      adapter.sendMessage({
        turnId: 't1',
        content: 'image',
        attachments: [
          {
            type: 'image',
            path: '/definitely/missing.png',
            mimeType: 'image/png',
          },
        ],
      })
    ).rejects.toThrow('Cannot read Prime Agent image attachment');
    expect(call.mock.calls.map(([type]) => type)).toEqual([
      'get_available_models',
    ]);
  });

  it('fails an invalidated queued attachment locally and advances later turns', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'relay-prime-queued-image-'));
    const path = join(directory, 'image.png');
    writeFileSync(
      path,
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    );
    try {
      const { adapter, client, call, patches } = harness();
      await adapter.connect(config);
      await adapter.sendMessage({ turnId: 't1', content: 'one' });
      await adapter.sendMessage({
        turnId: 't2',
        content: 'image',
        attachments: [{ type: 'image', path, mimeType: 'image/png' }],
      });
      await adapter.sendMessage({ turnId: 't3', content: 'three' });
      rmSync(path);

      client.emit('event', { type: 'agent_end' });
      await vi.waitFor(() =>
        expect(
          call.mock.calls
            .filter(([type]) => type === 'prompt')
            .map(([, payload]) => (payload as { message: string }).message)
        ).toEqual(['one', 'three'])
      );
      expect(adapter.status).toBe('connected');
      expect(patches).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'agent-error-v2',
            turnId: 't2',
            message: expect.stringContaining(
              'Cannot read Prime Agent image attachment'
            ),
          }),
          expect.objectContaining({
            type: 'agent-turn-completed-v2',
            turnId: 't2',
            status: 'failed',
          }),
        ])
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('assigns unique item ids when Prime omits tool call ids', async () => {
    const { adapter, client, patches } = harness();
    await adapter.connect(config);
    await adapter.sendMessage({ turnId: 't1', content: 'tools' });
    client.emit('event', {
      type: 'tool_execution_start',
      toolName: 'bash',
      args: { command: 'one' },
    });
    client.emit('event', {
      type: 'tool_execution_start',
      toolName: 'bash',
      args: { command: 'two' },
    });
    const ids = patches
      .filter(
        (patch) =>
          patch.type === 'agent-item-started-v2' &&
          (patch.item as { type?: string }).type === 'commandExecution'
      )
      .map((patch) => (patch.item as { id: string }).id);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });

  it('reuses an anonymous streamed tool id through Prime execution completion', async () => {
    const { adapter, client, patches } = harness();
    await adapter.connect(config);
    await adapter.sendMessage({ turnId: 't1', content: 'tool' });
    client.emit('event', {
      type: 'message_update',
      assistantMessageEvent: {
        type: 'toolcall_end',
        contentIndex: 0,
        toolCall: { name: 'bash', arguments: { command: 'pwd' } },
      },
    });
    client.emit('event', {
      type: 'tool_execution_start',
      toolName: 'bash',
      args: { command: 'pwd' },
    });
    client.emit('event', {
      type: 'tool_execution_update',
      toolName: 'bash',
      args: { command: 'pwd' },
      partialResult: { content: [{ type: 'text', text: '/tm' }] },
    });
    client.emit('event', {
      type: 'tool_execution_end',
      toolName: 'bash',
      args: { command: 'pwd' },
      result: { content: [{ type: 'text', text: '/tmp' }] },
      isError: false,
    });

    const started = patches.filter(
      (patch) =>
        patch.type === 'agent-item-started-v2' &&
        (patch.item as { type?: string }).type === 'commandExecution'
    );
    expect(started).toHaveLength(1);
    const id = (started[0]!.item as { id: string }).id;
    expect(patches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'agent-item-delta-v2',
          itemId: id,
          delta: { output: '/tm' },
        }),
        expect.objectContaining({
          type: 'agent-item-updated-v2',
          item: expect.objectContaining({
            id,
            output: '/tmp',
            status: 'completed',
          }),
        }),
      ])
    );
  });

  it('routes interleaved anonymous Prime tools by name and args', async () => {
    const { adapter, client, patches } = harness();
    await adapter.connect(config);
    await adapter.sendMessage({ turnId: 't1', content: 'tools' });
    for (const command of ['one', 'two'])
      client.emit('event', {
        type: 'tool_execution_start',
        toolName: 'bash',
        args: { command },
      });
    client.emit('event', {
      type: 'tool_execution_end',
      toolName: 'bash',
      args: { command: 'two' },
      result: { content: [{ type: 'text', text: 'second' }] },
      isError: false,
    });
    client.emit('event', {
      type: 'tool_execution_end',
      toolName: 'bash',
      args: { command: 'one' },
      result: { content: [{ type: 'text', text: 'first' }] },
      isError: false,
    });
    const started = patches
      .filter((patch) => patch.type === 'agent-item-started-v2')
      .map((patch) => patch.item as { id: string; command?: string })
      .filter((item) => item.command);
    const idByCommand = new Map(started.map((item) => [item.command, item.id]));
    const completed = patches
      .filter((patch) => patch.type === 'agent-item-updated-v2')
      .map((patch) => patch.item as { id: string; output?: string });
    expect(completed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: idByCommand.get('one'),
          output: 'first',
        }),
        expect.objectContaining({
          id: idByCommand.get('two'),
          output: 'second',
        }),
      ])
    );
  });

  it('bounds image count and rejects MIME-mismatched bytes', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'relay-prime-image-'));
    const path = join(directory, 'image.png');
    try {
      writeFileSync(path, 'not an image');
      const mismatched = harness();
      await mismatched.adapter.connect(config);
      await expect(
        mismatched.adapter.sendMessage({
          turnId: 'bad-image',
          content: 'image',
          attachments: [{ type: 'image', path, mimeType: 'image/png' }],
        })
      ).rejects.toThrow('do not match the declared image');

      const excessive = harness();
      await excessive.adapter.connect(config);
      await expect(
        excessive.adapter.sendMessage({
          turnId: 'many-images',
          content: 'images',
          attachments: Array.from({ length: 5 }, () => ({
            type: 'image' as const,
            path,
            mimeType: 'image/png',
          })),
        })
      ).rejects.toThrow('at most 4 images');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('fails closed on an ambiguous initial prompt acknowledgement', async () => {
    const { adapter, client, call, patches } = harness();
    call.mockImplementation(async (type) => {
      if (type === 'prompt') throw new Error('prompt timed out');
      return { type: 'response', command: type, success: true };
    });
    await adapter.connect(config);
    await expect(
      adapter.sendMessage({ turnId: 'timeout', content: 'hello' })
    ).rejects.toThrow('prompt timed out');
    expect(adapter.status).toBe('disconnected');
    expect(client.stop).toHaveBeenCalled();
    expect(
      patches.filter(
        (patch) =>
          patch.type === 'agent-turn-completed-v2' && patch.turnId === 'timeout'
      )
    ).toEqual([expect.objectContaining({ status: 'failed' })]);
  });

  it('maps extension errors to nonfatal debug diagnostics', async () => {
    const { adapter, client, patches } = harness();
    await adapter.connect(config);
    await adapter.sendMessage({ turnId: 't1', content: 'hello' });
    client.emit('event', { type: 'extension_error', error: 'hook failed' });
    client.emit('event', { type: 'agent_end' });
    expect(patches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'agent-item-started-v2',
          item: expect.objectContaining({
            type: 'providerExtension',
            payload: { kind: 'extensionError', error: 'hook failed' },
          }),
        }),
        expect.objectContaining({
          type: 'agent-turn-completed-v2',
          turnId: 't1',
          status: 'completed',
        }),
      ])
    );
  });

  it('runs /compact through native RPC and terminalizes the Relay turn', async () => {
    const { adapter, call, patches } = harness();
    call.mockImplementation(async (type) => ({
      type: 'response',
      command: type,
      success: true,
      ...(type === 'compact' ? { data: { tokensBefore: 100 } } : {}),
    }));
    await adapter.connect(config);
    await adapter.sendMessage({ turnId: 'compact', content: '/compact' });
    expect(call.mock.calls.map(([type]) => type)).toEqual([
      'get_available_models',
      'compact',
    ]);
    expect(patches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'agent-turn-completed-v2',
          turnId: 'compact',
          status: 'completed',
        }),
      ])
    );
  });

  it('disables extensions until extension UI requests are mapped', async () => {
    const client = new PrimeAgentRpcClient();
    vi.spyOn(client, 'start').mockResolvedValue({
      type: 'response',
      command: 'get_state',
      success: true,
      data: {},
    });
    vi.spyOn(client, 'call').mockResolvedValue({
      type: 'response',
      command: 'set_steering_mode',
      success: true,
    });
    vi.spyOn(client, 'stop').mockResolvedValue();
    let args: string[] | undefined;
    const adapter = new PrimeAgentProtocolAdapter((options) => {
      args = options.args;
      return client;
    });
    await adapter.connect({
      ...config,
      model: 'gpt-5.6-sol',
      extra: { provider: 'openai-codex', effort: 'high' },
    });
    expect(args).toEqual([
      '--mode',
      'rpc',
      '--no-extensions',
      '--provider',
      'openai-codex',
      '--model',
      'gpt-5.6-sol',
      '--thinking',
      'high',
    ]);
  });

  it('uses unique assistant ids across a tool-loop second assistant message', async () => {
    const { adapter, client, patches } = harness();
    await adapter.connect(config);
    await adapter.sendMessage({ turnId: 't1', content: 'loop' });
    client.emit('event', {
      type: 'message_start',
      message: { role: 'assistant' },
    });
    client.emit('event', {
      type: 'message_update',
      assistantMessageEvent: {
        type: 'text_delta',
        contentIndex: 0,
        delta: 'first',
      },
    });
    client.emit('event', {
      type: 'tool_execution_start',
      toolCallId: 'tool-loop',
      toolName: 'bash',
      args: { command: 'pwd' },
    });
    client.emit('event', {
      type: 'tool_execution_end',
      toolCallId: 'tool-loop',
      toolName: 'bash',
      result: { content: [{ type: 'text', text: '/tmp' }] },
      isError: false,
    });
    client.emit('event', {
      type: 'message_start',
      message: { role: 'assistant' },
    });
    client.emit('event', {
      type: 'message_update',
      assistantMessageEvent: {
        type: 'text_delta',
        contentIndex: 0,
        delta: 'second',
      },
    });
    client.emit('event', { type: 'agent_end' });
    const assistantIds = patches
      .filter(
        (patch) =>
          patch.type === 'agent-item-started-v2' &&
          (patch.item as { type: string }).type === 'assistantMessage'
      )
      .map((patch) => (patch.item as { id: string }).id);
    expect(assistantIds).toEqual(['t1-assistant-0-0', 't1-assistant-1-0']);
  });

  it('fails generation errors and terminalizes running tools; abort cancels them', async () => {
    const failed = harness();
    await failed.adapter.connect(config);
    await failed.adapter.sendMessage({ turnId: 'failed', content: 'fail' });
    failed.client.emit('event', {
      type: 'tool_execution_start',
      toolCallId: 'running-tool',
      toolName: 'bash',
      args: { command: 'sleep 1' },
    });
    failed.client.emit('event', {
      type: 'auto_retry_end',
      success: false,
      finalError: 'quota exhausted',
    });
    failed.client.emit('event', { type: 'agent_end' });
    expect(failed.patches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'agent-item-updated-v2',
          item: expect.objectContaining({
            id: 'running-tool',
            status: 'failed',
          }),
        }),
        expect.objectContaining({
          type: 'agent-turn-completed-v2',
          turnId: 'failed',
          status: 'failed',
          error: 'quota exhausted',
        }),
      ])
    );

    const aborted = harness();
    await aborted.adapter.connect(config);
    await aborted.adapter.sendMessage({ turnId: 'aborted', content: 'abort' });
    aborted.client.emit('event', {
      type: 'tool_execution_start',
      toolCallId: 'abort-tool',
      toolName: 'bash',
      args: { command: 'sleep 1' },
    });
    await aborted.adapter.interrupt({ turnId: 'aborted' });
    aborted.client.emit('event', { type: 'agent_end' });
    expect(aborted.patches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'agent-item-updated-v2',
          item: expect.objectContaining({
            id: 'abort-tool',
            status: 'cancelled',
          }),
        }),
        expect.objectContaining({
          type: 'agent-turn-completed-v2',
          turnId: 'aborted',
          status: 'interrupted',
        }),
      ])
    );
  });

  it('ignores stale old-client close after reconnect and keeps patch listeners', async () => {
    const clients = [new PrimeAgentRpcClient(), new PrimeAgentRpcClient()];
    for (const client of clients) {
      vi.spyOn(client, 'start').mockResolvedValue({
        type: 'response',
        command: 'get_state',
        success: true,
        data: { sessionId: 'prime' },
      });
      vi.spyOn(client, 'stop').mockResolvedValue();
      vi.spyOn(client, 'call').mockResolvedValue({
        type: 'response',
        command: 'prompt',
        success: true,
      });
    }
    let index = 0;
    const adapter = new PrimeAgentProtocolAdapter(() => clients[index++]!);
    const patches: Array<Record<string, unknown>> = [];
    adapter.onPatch((patch) =>
      patches.push(patch as unknown as Record<string, unknown>)
    );
    await adapter.connect(config);
    await adapter.reconnect();
    clients[0]!.emit('close', 1);
    expect(adapter.status).toBe('connected');
    await adapter.sendMessage({ turnId: 'after-reconnect', content: 'alive' });
    clients[1]!.emit('event', { type: 'agent_end' });
    expect(patches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'agent-turn-completed-v2',
          turnId: 'after-reconnect',
        }),
      ])
    );
  });
});
