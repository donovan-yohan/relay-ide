import { describe, expect, it, vi } from 'vitest';
import { PrimeAgentRpcClient } from '../../../server/prime-agent-rpc-client.js';
import { PrimeAgentProtocolAdapter } from '../../../server/protocol-adapters/prime-agent-adapter.js';

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
    },
  });
  const call = vi
    .spyOn(client, 'call')
    .mockResolvedValue({ type: 'response', command: 'prompt', success: true });
  vi.spyOn(client, 'stop').mockResolvedValue();
  const adapter = new PrimeAgentProtocolAdapter(() => client);
  const patches: Array<Record<string, unknown>> = [];
  adapter.onPatch((patch) =>
    patches.push(patch as unknown as Record<string, unknown>)
  );
  return { adapter, client, call, patches };
}

describe('PrimeAgentProtocolAdapter', () => {
  it('publishes honest capabilities and provider session identity after get_state', async () => {
    const { adapter, patches } = harness();
    await adapter.connect(config);
    expect(adapter.agentType).toBe('prime-agent');
    expect(adapter.capabilities).toMatchObject({
      text: true,
      queue: true,
      interrupt: true,
      resume: true,
      approvals: false,
      questions: false,
      compact: false,
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

  it('uses steer while active and abort for interrupt', async () => {
    const { adapter, call } = harness();
    await adapter.connect(config);
    await adapter.sendMessage({ turnId: 't1', content: 'one' });
    await adapter.sendMessage({ turnId: 't2', content: 'two' });
    await adapter.interrupt({ turnId: 't1' });
    expect(call.mock.calls.map(([type]) => type)).toEqual([
      'set_steering_mode',
      'prompt',
      'steer',
      'abort',
    ]);
  });

  it('advances multiple accepted steer turns at agent_end boundaries', async () => {
    const { adapter, client, patches } = harness();
    await adapter.connect(config);
    await adapter.sendMessage({ turnId: 't1', content: 'one' });
    await adapter.sendMessage({ turnId: 't2', content: 'two' });
    await adapter.sendMessage({ turnId: 't3', content: 'three' });
    client.emit('event', { type: 'agent_end' });
    client.emit('event', { type: 'agent_start' });
    client.emit('event', { type: 'turn_start' });
    client.emit('event', { type: 'agent_end' });
    client.emit('event', { type: 'agent_start' });
    client.emit('event', { type: 'agent_end' });
    expect(
      patches
        .filter((patch) => patch.type === 'agent-turn-started-v2')
        .map((patch) => (patch.turn as { id: string }).id)
    ).toEqual(['t1', 't2', 't3']);
    expect(
      patches
        .filter((patch) => patch.type === 'agent-turn-completed-v2')
        .map((patch) => patch.turnId)
    ).toEqual(['t1', 't2', 't3']);
  });

  it('does not promote a steer turn before its acknowledgement', async () => {
    const { adapter, client, call, patches } = harness();
    let rejectSteer: ((error: Error) => void) | undefined;
    call.mockImplementation(async (type) => {
      if (type === 'steer') {
        return new Promise((_, reject) => {
          rejectSteer = reject;
        });
      }
      return { type: 'response', command: type, success: true };
    });
    await adapter.connect(config);
    await adapter.sendMessage({ turnId: 't1', content: 'one' });
    const queued = adapter.sendMessage({ turnId: 't2', content: 'two' });
    const rejected = expect(queued).rejects.toThrow('steer rejected');

    client.emit('event', { type: 'agent_end' });
    expect(
      patches
        .filter((patch) => patch.type === 'agent-turn-started-v2')
        .map((patch) => (patch.turn as { id: string }).id)
    ).toEqual(['t1']);

    rejectSteer?.(new Error('steer rejected'));
    await rejected;
    expect(adapter.status).toBe('disconnected');
    expect(
      patches.some(
        (patch) =>
          patch.type === 'agent-turn-started-v2' &&
          (patch.turn as { id: string }).id === 't2'
      )
    ).toBe(false);
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
      'set_steering_mode',
    ]);
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
