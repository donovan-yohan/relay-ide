import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  PiAgentRpcClient,
  type PiAgentRpcClientOptions,
} from '../../../server/pi-agent-rpc-client.js';
import { PiAgentProtocolAdapter } from '../../../server/protocol-adapters/pi-agent-adapter.js';
import { CHANNEL_ADAPTER_LAUNCH_CONTRACTS } from '../../../server/protocol-adapters/index.js';

const config = {
  cwd: '/tmp',
  port: 1,
  sessionId: 'relay-session',
  hookToken: 'x',
  configDir: '/tmp',
};

function harness() {
  const client = new PiAgentRpcClient();
  vi.spyOn(client, 'start').mockResolvedValue({
    type: 'response',
    command: 'get_state',
    success: true,
    data: {
      sessionId: 'pi-1',
      sessionFile: '/tmp/pi-1.jsonl',
      isStreaming: false,
    },
  });
  const call = vi
    .spyOn(client, 'call')
    .mockResolvedValue({ type: 'response', command: 'prompt', success: true });
  vi.spyOn(client, 'stop').mockResolvedValue();
  const clientFactoryOptions: PiAgentRpcClientOptions[] = [];
  const adapter = new PiAgentProtocolAdapter((options) => {
    clientFactoryOptions.push(options);
    return client;
  });
  const patches: Array<Record<string, unknown>> = [];
  adapter.onPatch((patch) =>
    patches.push(patch as unknown as Record<string, unknown>)
  );
  return { adapter, client, call, patches, clientFactoryOptions };
}

describe('PiAgentProtocolAdapter', () => {
  it('publishes honest capabilities and provider session identity after get_state', async () => {
    const { adapter, patches, clientFactoryOptions } = harness();
    await adapter.connect({
      ...config,
      processEnv: {
        CLAUDECODE: 'must-be-stripped',
        RELAY_PROFILE_SAFE: 'preserved',
      },
    });
    const launchRequirement = CHANNEL_ADAPTER_LAUNCH_CONTRACTS.pi.requirement;
    expect(launchRequirement.kind).toBe('command');
    if (launchRequirement.kind !== 'command') {
      throw new Error('Pi must remain a command-backed channel adapter');
    }
    expect(clientFactoryOptions[0]?.command).toBe(launchRequirement.command);
    expect(clientFactoryOptions[0]?.env?.RELAY_PROFILE_SAFE).toBe('preserved');
    for (const key of CHANNEL_ADAPTER_LAUNCH_CONTRACTS.pi.processEnvDenylist) {
      expect(clientFactoryOptions[0]?.env).not.toHaveProperty(key);
    }
    expect(adapter.agentType).toBe('pi');
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
      provider: 'pi',
      providerSession: {
        piSessionId: 'pi-1',
        piSessionFile: '/tmp/pi-1.jsonl',
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
    client.emit('event', { type: 'agent_settled' });
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
    expect(call.mock.calls.map(([type]) => type)).toEqual(['prompt', 'abort']);
  });

  it('combines Relay and native Pi queues in its live queue count', async () => {
    const { adapter, client, patches } = harness();
    await adapter.connect(config);
    await adapter.sendMessage({ turnId: 't1', content: 'one' });
    await adapter.sendMessage({ turnId: 't2', content: 'two' });

    client.emit('event', {
      type: 'queue_update',
      steering: ['native steer'],
      followUp: ['native follow-up'],
    });

    expect(patches.at(-1)).toMatchObject({
      type: 'agent-live-state-updated-v2',
      live: { queueLength: 3 },
    });
  });

  it('publishes only a finite non-negative Pi pending count at connect', async () => {
    const { adapter, client, patches } = harness();
    vi.spyOn(client, 'start').mockResolvedValue({
      type: 'response',
      command: 'get_state',
      success: true,
      data: { pendingMessageCount: Number.NaN },
    });
    await adapter.connect(config);
    expect(patches.at(-1)).toMatchObject({
      type: 'agent-live-state-updated-v2',
      live: { queueLength: 0 },
    });
  });

  it('submits queued Relay turns as fresh prompts after real agent_settled boundaries', async () => {
    const { adapter, client, call, patches } = harness();
    await adapter.connect(config);
    await adapter.sendMessage({ turnId: 't1', content: 'one' });
    await adapter.sendMessage({ turnId: 't2', content: 'two' });
    await adapter.sendMessage({ turnId: 't3', content: 'three' });

    client.emit('event', { type: 'turn_end' });
    expect(
      patches.filter((patch) => patch.type === 'agent-turn-completed-v2')
    ).toHaveLength(0);

    client.emit('event', { type: 'agent_settled' });
    await vi.waitFor(() =>
      expect(
        patches
          .filter((patch) => patch.type === 'agent-turn-started-v2')
          .map((patch) => (patch.turn as { id: string }).id)
      ).toEqual(['t1', 't2'])
    );
    client.emit('event', { type: 'agent_settled' });
    await vi.waitFor(() =>
      expect(
        patches
          .filter((patch) => patch.type === 'agent-turn-started-v2')
          .map((patch) => (patch.turn as { id: string }).id)
      ).toEqual(['t1', 't2', 't3'])
    );
    client.emit('event', { type: 'agent_settled' });

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
    client.emit('event', { type: 'agent_settled' });

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
    ).rejects.toThrow('Cannot read Pi image attachment');
    expect(call).not.toHaveBeenCalled();
  });

  it('fails an invalidated queued attachment locally and advances later turns', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'relay-pi-queued-image-'));
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

      client.emit('event', { type: 'agent_settled' });
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
            message: expect.stringContaining('Cannot read Pi image attachment'),
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

  it('assigns unique item ids when Pi omits tool call ids', async () => {
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

  it('reuses an anonymous streamed tool id through Pi execution completion', async () => {
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

  it('routes interleaved anonymous Pi tools by name and args', async () => {
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
    const directory = mkdtempSync(join(tmpdir(), 'relay-pi-image-'));
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
    client.emit('event', { type: 'agent_settled' });
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
    expect(call.mock.calls.map(([type]) => type)).toEqual(['compact']);
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
    const client = new PiAgentRpcClient();
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
    const adapter = new PiAgentProtocolAdapter((options) => {
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

  it('resumes a durable session by exact pi project session id', async () => {
    const client = new PiAgentRpcClient();
    vi.spyOn(client, 'start').mockResolvedValue({
      type: 'response',
      command: 'get_state',
      success: true,
      data: { sessionId: 'pi-session-1', sessionFile: '/tmp/s.jsonl' },
    });
    vi.spyOn(client, 'stop').mockResolvedValue();
    let args: string[] | undefined;
    const adapter = new PiAgentProtocolAdapter((options) => {
      args = options.args;
      return client;
    });
    await adapter.connect({ ...config, resumeSessionId: 'pi-session-1' });
    expect(args).toEqual([
      '--mode',
      'rpc',
      '--no-extensions',
      '--session-id',
      'pi-session-1',
    ]);
  });

  it('completes a turn only on agent_settled, not on the earlier agent_end', async () => {
    const { adapter, client, patches } = harness();
    await adapter.connect(config);
    await adapter.sendMessage({ turnId: 't1', content: 'one' });
    client.emit('event', { type: 'agent_end', messages: [] });
    expect(
      patches.filter((patch) => patch.type === 'agent-turn-completed-v2')
    ).toHaveLength(0);
    client.emit('event', { type: 'agent_settled' });
    expect(
      patches
        .filter((patch) => patch.type === 'agent-turn-completed-v2')
        .map((patch) => patch.turnId)
    ).toEqual(['t1']);
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
    client.emit('event', { type: 'agent_settled' });
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
    failed.client.emit('event', { type: 'agent_settled' });
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
    aborted.client.emit('event', { type: 'agent_settled' });
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
    const clients = [new PiAgentRpcClient(), new PiAgentRpcClient()];
    for (const client of clients) {
      vi.spyOn(client, 'start').mockResolvedValue({
        type: 'response',
        command: 'get_state',
        success: true,
        data: { sessionId: 'pi' },
      });
      vi.spyOn(client, 'stop').mockResolvedValue();
      vi.spyOn(client, 'call').mockResolvedValue({
        type: 'response',
        command: 'prompt',
        success: true,
      });
    }
    let index = 0;
    const adapter = new PiAgentProtocolAdapter(() => clients[index++]!);
    const patches: Array<Record<string, unknown>> = [];
    adapter.onPatch((patch) =>
      patches.push(patch as unknown as Record<string, unknown>)
    );
    await adapter.connect(config);
    await adapter.reconnect();
    clients[0]!.emit('close', 1);
    expect(adapter.status).toBe('connected');
    await adapter.sendMessage({ turnId: 'after-reconnect', content: 'alive' });
    clients[1]!.emit('event', { type: 'agent_settled' });
    expect(patches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'agent-turn-completed-v2',
          turnId: 'after-reconnect',
        }),
      ])
    );
  });

  it('guards empty-args command calls and steers after repeated empty calls', async () => {
    const { adapter, client, call, patches } = harness();
    await adapter.connect(config);
    await adapter.sendMessage({ turnId: 't-empty', content: 'do it' });

    // Empty bash call: no command.
    client.emit('event', {
      type: 'tool_execution_start',
      toolCallId: 'empty-1',
      toolName: 'bash',
      args: {},
    });
    client.emit('event', {
      type: 'tool_execution_start',
      toolCallId: 'empty-2',
      toolName: 'bash',
      args: {},
    });
    // Only the third consecutive empty call injects a corrective steer.
    client.emit('event', {
      type: 'tool_execution_start',
      toolCallId: 'empty-3',
      toolName: 'bash',
      args: {},
    });

    expect(patches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'agent-error-v2',
          message: expect.stringContaining('empty arguments'),
        }),
      ])
    );
    // Corrective is a `steer` (pi rejects `prompt` during streaming), not a bare
    // `prompt`, so the first two empty calls must not have called anything.
    const steerCalls = call.mock.calls.filter(([type]) => type === 'steer');
    expect(steerCalls.length).toBe(1);
    expect(steerCalls[0]?.[1]).toMatchObject({
      message: expect.stringContaining('bash'),
    });
    expect(call.mock.calls.filter(([type]) => type === 'prompt').length).toBe(
      1
    ); // the initial sendMessage
  });

  it('does not recreate a suppressed empty tool when its end event arrives', async () => {
    const { adapter, client, patches } = harness();
    await adapter.connect(config);
    await adapter.sendMessage({ turnId: 't-empty-end', content: 'go' });
    client.emit('event', {
      type: 'tool_execution_start',
      toolCallId: 'empty-end',
      toolName: 'bash',
      args: {},
    });
    client.emit('event', {
      type: 'tool_execution_end',
      toolCallId: 'empty-end',
      toolName: 'bash',
      args: {},
      result: { content: [{ type: 'text', text: 'invalid' }] },
      isError: true,
    });
    expect(
      patches.filter(
        (patch) =>
          patch.type === 'agent-item-started-v2' &&
          (patch.item as { id?: string }).id === 'empty-end'
      )
    ).toHaveLength(0);
  });

  it('does not throw when corrective steering loses its client', async () => {
    const { adapter } = harness();
    await adapter.connect(config);
    await adapter.disconnect();
    expect(() =>
      (
        adapter as unknown as {
          injectCorrectivePrompt(name: string): void;
        }
      ).injectCorrectivePrompt('bash')
    ).not.toThrow();
  });

  it('does not inject after interleaved empty calls from different tools', async () => {
    const { adapter, client, call } = harness();
    await adapter.connect(config);
    await adapter.sendMessage({ turnId: 't-mixed', content: 'go' });

    // bash, then edit, then edit: the edit counter is per-tool, so only two
    // consecutive empty `edit` calls do not yet trigger a steer.
    client.emit('event', {
      type: 'tool_execution_start',
      toolCallId: 'b1',
      toolName: 'bash',
      args: {},
    });
    client.emit('event', {
      type: 'tool_execution_start',
      toolCallId: 'e1',
      toolName: 'edit',
      args: {},
    });
    client.emit('event', {
      type: 'tool_execution_start',
      toolCallId: 'e2',
      toolName: 'edit',
      args: {},
    });

    expect(call.mock.calls.filter(([type]) => type === 'steer').length).toBe(0);

    // A third consecutive empty `edit` now injects.
    client.emit('event', {
      type: 'tool_execution_start',
      toolCallId: 'e3',
      toolName: 'edit',
      args: {},
    });
    expect(call.mock.calls.filter(([type]) => type === 'steer').length).toBe(1);
  });

  it('keeps an empty-bash streak despite interleaved valid calls of other tools', async () => {
    const { adapter, client, call } = harness();
    await adapter.connect(config);
    await adapter.sendMessage({ turnId: 't-interleave', content: 'go' });

    // Empty bash, then a VALID edit, then empty bash, then empty bash: the valid
    // edit clears only the edit tool's streak, so the bash count still reaches 3
    // and steers despite the interleaved valid call.
    const emptyBash = (i: string) => ({
      type: 'tool_execution_start',
      toolCallId: i,
      toolName: 'bash',
      args: {},
    });
    client.emit('event', emptyBash('e1'));
    client.emit('event', {
      type: 'tool_execution_start',
      toolCallId: 'v1',
      toolName: 'edit',
      args: { path: '/tmp/a.ts' },
    });
    client.emit('event', emptyBash('e2'));
    client.emit('event', emptyBash('e3'));

    expect(call.mock.calls.filter(([type]) => type === 'steer').length).toBe(1);
  });

  it('clears only the matching tool streak on a valid invocation', async () => {
    const { adapter, client, call } = harness();
    await adapter.connect(config);
    await adapter.sendMessage({ turnId: 't-valid', content: 'go' });

    // Two empty bash calls, then a valid bash call: the valid call clears only
    // bash's streak, so the next empty bash is back to count 1 (no steer yet).
    const emptyBash = (i: string) => ({
      type: 'tool_execution_start',
      toolCallId: i,
      toolName: 'bash',
      args: {},
    });
    client.emit('event', emptyBash('e1'));
    client.emit('event', emptyBash('e2'));
    client.emit('event', {
      type: 'tool_execution_start',
      toolCallId: 'v1',
      toolName: 'bash',
      args: { command: 'pwd' },
    });
    client.emit('event', emptyBash('e3'));
    client.emit('event', emptyBash('e4'));

    expect(call.mock.calls.filter(([type]) => type === 'steer').length).toBe(0);

    // A third consecutive empty bash call after the valid reset triggers.
    client.emit('event', emptyBash('e5'));
    expect(call.mock.calls.filter(([type]) => type === 'steer').length).toBe(1);
  });

  it('queues only one corrective steer per empty-call burst', async () => {
    const { adapter, client, call } = harness();
    await adapter.connect(config);
    await adapter.sendMessage({ turnId: 't-burst', content: 'go' });

    // A burst of five empty bash calls triggers a steer at count 3 only — counts
    // 4 and 5 must not queue additional steers.
    for (let i = 1; i <= 5; i += 1) {
      client.emit('event', {
        type: 'tool_execution_start',
        toolCallId: `b${i}`,
        toolName: 'bash',
        args: {},
      });
    }

    expect(call.mock.calls.filter(([type]) => type === 'steer').length).toBe(1);
  });
});
