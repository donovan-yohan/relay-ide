import { describe, expect, it, vi } from 'vitest';
import { ClaudeProtocolAdapter } from '../../../server/protocol-adapters/claude-adapter.js';
import type { AdapterConfig } from '../../../server/protocol-adapter-v2.js';
import type { ClaudeQueryFunction } from '../../../server/protocol-adapters/claude-adapter.js';
import type { AgentPatchV2 } from '../../../shared/agent-chat-protocol-v2.js';

const config: AdapterConfig = {
  cwd: '/tmp/repo',
  port: 3000,
  sessionId: 'session-1',
  hookToken: 'token',
  configDir: '/tmp/config',
  model: 'sonnet',
};

function collectPatches(adapter: ClaudeProtocolAdapter): AgentPatchV2[] {
  const patches: AgentPatchV2[] = [];
  adapter.onPatch((patch) => patches.push(patch));
  return patches;
}

interface ScriptedQuery {
  emit: (message: unknown) => void;
  end: () => void;
  initializationResult?: unknown;
  supportedCommandsResult?: unknown[];
  initializationResultCalls: number;
  supportedCommandsCalls: number;
  interruptCalls: number;
  closeCalls: number;
  inputs: unknown[];
}

interface ScriptedQueryFn {
  (): ClaudeQueryFunction;
  current: ScriptedQuery | null;
}

function makeScriptedQuery(): ScriptedQueryFn {
  const fn = (() => {
    const controller: ScriptedQuery = {
      emit: () => undefined,
      end: () => undefined,
      supportedCommandsCalls: 0,
      initializationResultCalls: 0,
      interruptCalls: 0,
      closeCalls: 0,
      inputs: [],
    };
    fn.current = controller;
    return ((params) => {
      const queue: unknown[] = [];
      let waiter: ((msg: IteratorResult<unknown>) => void) | null = null;
      let ended = false;

      controller.emit = (message: unknown) => {
        if (waiter) {
          const w = waiter;
          waiter = null;
          w({ value: message, done: false });
        } else {
          queue.push(message);
        }
      };
      controller.end = () => {
        ended = true;
        if (waiter) {
          const w = waiter;
          waiter = null;
          w({ value: undefined, done: true });
        }
      };

      // Drain user inputs from the streaming prompt iterator.
      void (async () => {
        const prompt = params.prompt;
        if (typeof prompt === 'string' || prompt === undefined) return;
        for await (const userMessage of prompt) {
          controller.inputs.push(userMessage);
        }
      })();

      const generator: AsyncGenerator<unknown, void, unknown> & {
        interrupt?: () => Promise<void>;
        close?: () => void;
        initializationResult?: () => Promise<unknown>;
        supportedCommands?: () => Promise<unknown[]>;
      } = (async function* () {
        while (true) {
          if (queue.length > 0) {
            yield queue.shift();
            continue;
          }
          if (ended) return;
          const next = await new Promise<IteratorResult<unknown>>((resolve) => {
            waiter = resolve;
          });
          if (next.done) return;
          yield next.value;
        }
      })();
      generator.interrupt = async () => {
        controller.interruptCalls++;
      };
      generator.close = () => {
        controller.closeCalls++;
        controller.end();
      };
      generator.initializationResult = async () => {
        controller.initializationResultCalls++;
        return (
          controller.initializationResult ?? {
            commands: controller.supportedCommandsResult ?? [],
          }
        );
      };
      generator.supportedCommands = async () => {
        controller.supportedCommandsCalls++;
        return controller.supportedCommandsResult ?? [];
      };
      return generator as unknown as ReturnType<ClaudeQueryFunction>;
    }) as ClaudeQueryFunction;
  }) as unknown as ScriptedQueryFn;
  fn.current = null;
  return fn;
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
        reject(new Error('timed out waiting for Claude adapter condition'));
        return;
      }
      setTimeout(tick, 1);
    };
    tick();
  });
}

describe('ClaudeProtocolAdapter V2', () => {
  it('advertises the claude v2 capability set', () => {
    const adapter = new ClaudeProtocolAdapter((() => {
      const gen: AsyncGenerator<unknown, void, unknown> = (async function* () {})();
      return gen as unknown as ReturnType<ClaudeQueryFunction>;
    }) as ClaudeQueryFunction);

    expect(adapter.capabilities).toMatchObject({
      text: true,
      reasoning: true,
      tools: true,
      commandExecution: true,
      fileChanges: true,
      approvals: true,
      queue: true,
      interrupt: true,
      cancelQueued: false,
      resume: true,
      compact: true,
      slashCommands: true,
    });
  });

  it('opens streaming query on connect, fetches supportedCommands, and pushes user input to the SDK', async () => {
    const queryFn = makeScriptedQuery();
    const adapter = new ClaudeProtocolAdapter(queryFn());
    const patches = collectPatches(adapter);
    const controller = queryFn.current!;
    expect(controller).not.toBeNull();
    controller.supportedCommandsResult = [
      { name: 'compact', description: 'compact context', argumentHint: '' },
      {
        name: 'review',
        description: 'review the diff',
        argumentHint: '<scope>',
        aliases: ['rev'],
      },
    ];

    await adapter.connect(config);

    controller.emit({
      type: 'system',
      subtype: 'init',
      session_id: 'claude-session-1',
      cwd: '/tmp/repo',
      model: 'sonnet',
      tools: ['Bash', 'Edit'],
      slash_commands: ['compact', 'review'],
      skills: ['compact'],
      plugins: [],
    });

    await waitFor(() =>
      patches.some(
        (patch) =>
          patch.type === 'agent-session-updated-v2' && patch.slashCommands !== undefined
      )
    );

    const slashPatch = patches.find(
      (patch) =>
        patch.type === 'agent-session-updated-v2' && patch.slashCommands !== undefined
    );
    expect(slashPatch?.type).toBe('agent-session-updated-v2');
    expect(controller.initializationResultCalls).toBe(1);
    expect(controller.supportedCommandsCalls).toBe(0);
    expect(slashPatch?.slashCommands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'compact',
          description: 'compact context',
          source: 'sdk',
        }),
        expect.objectContaining({
          name: 'review',
          description: 'review the diff',
          argumentHint: '<scope>',
          aliases: ['rev'],
          source: 'sdk',
        }),
        expect.objectContaining({ name: 'resume', aliases: ['continue'], source: 'relay' }),
      ])
    );

    const sendPromise = adapter.sendMessage({ turnId: 'turn-1', content: 'hello' });

    await waitFor(() => controller.inputs.length > 0);
    expect(controller.inputs[0]).toMatchObject({
      type: 'user',
      message: { role: 'user', content: 'hello' },
    });

    controller.emit({
      type: 'assistant',
      message: {
        id: 'msg-native-1',
        content: [{ type: 'text', text: 'hello from claude' }],
      },
      session_id: 'claude-session-1',
    });
    controller.emit({
      type: 'result',
      subtype: 'success',
      duration_ms: 12,
      total_cost_usd: 0.01,
      usage: {
        input_tokens: 10,
        output_tokens: 20,
        cache_read_input_tokens: 3,
        cache_creation_input_tokens: 4,
      },
      session_id: 'claude-session-1',
    });

    await sendPromise;
    await waitFor(() => patches.some((patch) => patch.type === 'agent-turn-completed-v2'));

    expect(patches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'agent-session-snapshot-v2',
          session: expect.objectContaining({ provider: 'claude' }),
        }),
        expect.objectContaining({
          type: 'agent-session-updated-v2',
          providerSession: { claudeSessionId: 'claude-session-1' },
        }),
        expect.objectContaining({
          type: 'agent-item-delta-v2',
          turnId: 'turn-1',
          delta: { text: 'hello from claude' },
        }),
        expect.objectContaining({
          type: 'agent-turn-completed-v2',
          turnId: 'turn-1',
          status: 'completed',
          usage: expect.objectContaining({
            inputTokens: 10,
            outputTokens: 20,
            cacheReadTokens: 3,
            cacheWriteTokens: 4,
            costUsd: 0.01,
          }),
        }),
      ])
    );

    await adapter.disconnect();
    expect(controller.closeCalls).toBeGreaterThanOrEqual(1);
  });

  it('fetches SDK slash commands on connect before any streamed init message', async () => {
    const queryFn = makeScriptedQuery();
    const adapter = new ClaudeProtocolAdapter(queryFn());
    const patches = collectPatches(adapter);
    const controller = queryFn.current!;
    controller.supportedCommandsResult = [
      { name: 'ticket', description: 'create a GitHub issue', argumentHint: '<title>' },
      { name: 'scope', description: 'scope an issue', argumentHint: '' },
    ];

    await adapter.connect(config);

    await waitFor(() =>
      patches.some(
        (patch) =>
          patch.type === 'agent-session-updated-v2' && patch.slashCommands !== undefined
      )
    );

    expect(controller.initializationResultCalls).toBe(1);
    expect(controller.supportedCommandsCalls).toBe(0);
    const slashPatch = patches.find(
      (patch) =>
        patch.type === 'agent-session-updated-v2' && patch.slashCommands !== undefined
    );
    expect(slashPatch?.type).toBe('agent-session-updated-v2');
    expect(slashPatch?.slashCommands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'ticket',
          description: 'create a GitHub issue',
          argumentHint: '<title>',
          source: 'sdk',
        }),
        expect.objectContaining({ name: 'scope', description: 'scope an issue', source: 'sdk' }),
        expect.objectContaining({ name: 'resume', aliases: ['continue'], source: 'relay' }),
      ])
    );

    await adapter.disconnect();
  });

  it('adds Relay-owned Claude controls with aliases to the slash command catalog', async () => {
    const queryFn = makeScriptedQuery();
    const adapter = new ClaudeProtocolAdapter(queryFn());
    const patches = collectPatches(adapter);
    const controller = queryFn.current!;
    controller.initializationResult = {
      commands: [
        {
          name: 'compact',
          description: 'Free up context',
          argumentHint: '<instructions>',
        },
        {
          name: 'clear',
          description: 'Start a new session',
          argumentHint: '',
        },
      ],
    };

    await adapter.connect(config);

    await waitFor(() =>
      patches.some(
        (patch) =>
          patch.type === 'agent-session-updated-v2' && patch.slashCommands !== undefined
      )
    );

    expect(controller.initializationResultCalls).toBe(1);
    expect(controller.supportedCommandsCalls).toBe(0);
    const slashPatch = patches.find(
      (patch) =>
        patch.type === 'agent-session-updated-v2' && patch.slashCommands !== undefined
    );
    expect(slashPatch?.type).toBe('agent-session-updated-v2');
    expect(slashPatch?.slashCommands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'compact',
          description: 'Free up context',
          argumentHint: '<instructions>',
          source: 'sdk',
        }),
        expect.objectContaining({
          name: 'clear',
          description: 'Start a new session',
          aliases: ['reset', 'new'],
          source: 'sdk',
        }),
        expect.objectContaining({
          name: 'resume',
          aliases: ['continue'],
          source: 'relay',
          dispatch: 'relay-control',
        }),
        expect.objectContaining({
          name: 'model',
          source: 'relay',
          dispatch: 'relay-control',
        }),
      ])
    );

    await adapter.disconnect();
  });

  it('marks low-level Claude SDK events as trace provider extensions', async () => {
    const queryFn = makeScriptedQuery();
    const adapter = new ClaudeProtocolAdapter(queryFn());
    const patches = collectPatches(adapter);

    await adapter.connect(config);
    const controller = queryFn.current!;
    controller.emit({
      type: 'system',
      subtype: 'init',
      session_id: 'claude-session-1',
    });

    void adapter.sendMessage({ turnId: 'turn-events', content: 'hello' });
    await waitFor(() => controller.inputs.length === 1);

    controller.emit({
      type: 'stream_event',
      event: { type: 'message_delta' },
      session_id: 'claude-session-1',
    });
    controller.emit({
      type: 'system',
      subtype: 'hook_response',
      hook_name: 'Stop',
      outcome: 'success',
      stdout: '',
      stderr: '',
      session_id: 'claude-session-1',
    });
    controller.emit({
      type: 'rate_limit_event',
      rate_limit_info: { status: 'allowed' },
      session_id: 'claude-session-1',
    });
    controller.emit({
      type: 'result',
      subtype: 'success',
      duration_ms: 1,
      total_cost_usd: 0,
      usage: {},
      session_id: 'claude-session-1',
    });

    await waitFor(() => patches.some((patch) => patch.type === 'agent-turn-completed-v2'));
    const extensions = patches
      .filter((patch) => patch.type === 'agent-item-started-v2')
      .map((patch) => patch.item)
      .filter((item) => item.type === 'providerExtension');

    expect(extensions).toHaveLength(3);
    expect(extensions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          payload: expect.objectContaining({ type: 'stream_event' }),
          metadata: { eventVisibility: 'trace' },
        }),
        expect.objectContaining({
          payload: expect.objectContaining({ type: 'rate_limit_event' }),
          metadata: { eventVisibility: 'trace' },
        }),
      ])
    );

    await adapter.disconnect();
  });

  it('queues a second sendMessage and starts it after the first turn completes', async () => {
    const queryFn = makeScriptedQuery();
    const adapter = new ClaudeProtocolAdapter(queryFn());
    const patches = collectPatches(adapter);

    await adapter.connect(config);
    const controller = queryFn.current!;
    controller.emit({
      type: 'system',
      subtype: 'init',
      session_id: 'claude-session-1',
    });

    const first = adapter.sendMessage({ turnId: 'turn-1', content: 'one' });
    await waitFor(() => controller.inputs.length === 1);

    const second = adapter.sendMessage({ turnId: 'turn-2', content: 'two' });
    expect(controller.inputs.length).toBe(1);

    controller.emit({
      type: 'result',
      subtype: 'success',
      duration_ms: 1,
      total_cost_usd: 0,
      usage: {},
      session_id: 'claude-session-1',
    });

    await first;
    await waitFor(() => controller.inputs.length === 2);
    expect(controller.inputs[1]).toMatchObject({
      type: 'user',
      message: { role: 'user', content: 'two' },
    });

    controller.emit({
      type: 'result',
      subtype: 'success',
      duration_ms: 1,
      total_cost_usd: 0,
      usage: {},
      session_id: 'claude-session-1',
    });
    await second;
    await waitFor(
      () =>
        patches.filter((patch) => patch.type === 'agent-turn-completed-v2').length === 2
    );

    const completedTurns = patches.filter(
      (patch) => patch.type === 'agent-turn-completed-v2'
    );
    expect(completedTurns.map((patch) => patch.turnId)).toEqual(['turn-1', 'turn-2']);

    await adapter.disconnect();
  });

  it('maps SDK tool_use blocks to command, file, and dynamic tool items', async () => {
    const queryFn = makeScriptedQuery();
    const adapter = new ClaudeProtocolAdapter(queryFn());
    const patches = collectPatches(adapter);

    await adapter.connect(config);
    const controller = queryFn.current!;
    controller.emit({
      type: 'system',
      subtype: 'init',
      session_id: 'claude-session-1',
    });

    const sendPromise = adapter.sendMessage({ turnId: 'turn-tools', content: 'tools' });
    await waitFor(() => controller.inputs.length === 1);

    controller.emit({
      type: 'assistant',
      message: {
        id: 'msg-native-tools',
        content: [
          { type: 'thinking', thinking: 'inspect files' },
          { type: 'tool_use', id: 'tool-bash', name: 'Bash', input: { command: 'npm test' } },
          { type: 'tool_use', id: 'tool-edit', name: 'Edit', input: { file_path: 'src/a.ts' } },
          { type: 'tool_use', id: 'tool-grep', name: 'Grep', input: { pattern: 'x' } },
        ],
      },
      session_id: 'claude-session-1',
    });
    controller.emit({
      type: 'result',
      subtype: 'success',
      duration_ms: 1,
      total_cost_usd: 0,
      usage: {},
      session_id: 'claude-session-1',
    });

    await sendPromise;
    await waitFor(() => patches.some((patch) => patch.type === 'agent-turn-completed-v2'));

    const itemTypes = patches
      .filter((patch) => patch.type === 'agent-item-started-v2')
      .map((patch) => patch.item.type);

    expect(itemTypes).toEqual(
      expect.arrayContaining(['reasoning', 'commandExecution', 'fileChange', 'dynamicToolCall'])
    );

    await adapter.disconnect();
  });

  it('bridges SDK canUseTool approval through respondToApproval', async () => {
    const queryFn = makeScriptedQuery();
    let capturedCanUseTool:
      | NonNullable<Parameters<ClaudeQueryFunction>[0]['options']>['canUseTool']
      | undefined;
    const wrappedFn: ClaudeQueryFunction = (params) => {
      capturedCanUseTool = params.options?.canUseTool;
      return queryFn()(params);
    };
    const adapter = new ClaudeProtocolAdapter(wrappedFn);
    const patches = collectPatches(adapter);

    await adapter.connect(config);
    const controller = queryFn.current!;
    controller.emit({
      type: 'system',
      subtype: 'init',
      session_id: 'claude-session-1',
    });

    void adapter.sendMessage({ turnId: 'turn-approval', content: 'approval' });
    await waitFor(() => controller.inputs.length === 1);

    const decisionPromise = capturedCanUseTool?.(
      'Bash',
      { command: 'npm test' },
      {
        signal: new AbortController().signal,
        toolUseID: 'tool-approval',
        title: 'Claude wants to run tests',
        displayName: 'Run command',
        description: 'npm test',
      }
    );

    await waitFor(() =>
      patches.some(
        (patch) =>
          patch.type === 'agent-live-state-updated-v2' &&
          patch.live.waitingOn === 'approval'
      )
    );

    await adapter.respondToApproval({
      requestId: 'tool-approval',
      decision: { kind: 'accept', scope: 'once' },
    });
    const decision = await decisionPromise;
    expect(decision?.behavior).toBe('allow');

    controller.emit({
      type: 'result',
      subtype: 'success',
      duration_ms: 1,
      total_cost_usd: 0,
      usage: {},
      session_id: 'claude-session-1',
    });
    await waitFor(() => patches.some((patch) => patch.type === 'agent-turn-completed-v2'));

    expect(patches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'agent-item-started-v2',
          item: expect.objectContaining({
            type: 'approval',
            requestId: 'tool-approval',
            target: 'npm test',
            supported: {
              scopes: ['once', 'permanent'],
              amendmentTypes: [],
              canCancel: false,
            },
          }),
        }),
        expect.objectContaining({
          type: 'agent-item-updated-v2',
          item: expect.objectContaining({
            type: 'approval',
            decision: { kind: 'accept', scope: 'once' },
          }),
        }),
      ])
    );

    await adapter.disconnect();
  });

  it('maps accept/once V2 decision to allow_once SDK result', async () => {
    const queryFn = makeScriptedQuery();
    let capturedCanUseTool:
      | NonNullable<Parameters<ClaudeQueryFunction>[0]['options']>['canUseTool']
      | undefined;
    const wrappedFn: ClaudeQueryFunction = (params) => {
      capturedCanUseTool = params.options?.canUseTool;
      return queryFn()(params);
    };
    const adapter = new ClaudeProtocolAdapter(wrappedFn);

    await adapter.connect(config);
    const controller = queryFn.current!;
    controller.emit({ type: 'system', subtype: 'init', session_id: 's1' });
    void adapter.sendMessage({ turnId: 'turn-v2', content: 'go' });
    await waitFor(() => controller.inputs.length === 1);

    const decisionPromise = capturedCanUseTool?.(
      'Bash',
      { command: 'ls' },
      { signal: new AbortController().signal, toolUseID: 'req-once', title: 'run ls' }
    );
    await adapter.respondToApproval({ requestId: 'req-once', decision: { kind: 'accept', scope: 'once' } });
    const result = await decisionPromise;
    expect(result?.behavior).toBe('allow');
    expect((result as { decisionClassification?: string }).decisionClassification).toBe('user_temporary');

    controller.emit({ type: 'result', subtype: 'success', duration_ms: 1, total_cost_usd: 0, usage: {} });
    await adapter.disconnect();
  });

  it('maps accept/permanent V2 decision to allow_permanent SDK result', async () => {
    const queryFn = makeScriptedQuery();
    let capturedCanUseTool:
      | NonNullable<Parameters<ClaudeQueryFunction>[0]['options']>['canUseTool']
      | undefined;
    const wrappedFn: ClaudeQueryFunction = (params) => {
      capturedCanUseTool = params.options?.canUseTool;
      return queryFn()(params);
    };
    const adapter = new ClaudeProtocolAdapter(wrappedFn);

    await adapter.connect(config);
    const controller = queryFn.current!;
    controller.emit({ type: 'system', subtype: 'init', session_id: 's1' });
    void adapter.sendMessage({ turnId: 'turn-perm', content: 'go' });
    await waitFor(() => controller.inputs.length === 1);

    const decisionPromise = capturedCanUseTool?.(
      'Bash',
      { command: 'ls' },
      { signal: new AbortController().signal, toolUseID: 'req-perm', title: 'run ls' }
    );
    await adapter.respondToApproval({ requestId: 'req-perm', decision: { kind: 'accept', scope: 'permanent' } });
    const result = await decisionPromise;
    expect(result?.behavior).toBe('allow');
    expect((result as { decisionClassification?: string }).decisionClassification).toBe('user_permanent');

    controller.emit({ type: 'result', subtype: 'success', duration_ms: 1, total_cost_usd: 0, usage: {} });
    await adapter.disconnect();
  });

  it('maps decline V2 decision to deny SDK result', async () => {
    const queryFn = makeScriptedQuery();
    let capturedCanUseTool:
      | NonNullable<Parameters<ClaudeQueryFunction>[0]['options']>['canUseTool']
      | undefined;
    const wrappedFn: ClaudeQueryFunction = (params) => {
      capturedCanUseTool = params.options?.canUseTool;
      return queryFn()(params);
    };
    const adapter = new ClaudeProtocolAdapter(wrappedFn);

    await adapter.connect(config);
    const controller = queryFn.current!;
    controller.emit({ type: 'system', subtype: 'init', session_id: 's1' });
    void adapter.sendMessage({ turnId: 'turn-deny', content: 'go' });
    await waitFor(() => controller.inputs.length === 1);

    const decisionPromise = capturedCanUseTool?.(
      'Bash',
      { command: 'ls' },
      { signal: new AbortController().signal, toolUseID: 'req-deny', title: 'run ls' }
    );
    await adapter.respondToApproval({ requestId: 'req-deny', decision: { kind: 'decline' } });
    const result = await decisionPromise;
    expect(result?.behavior).toBe('deny');

    controller.emit({ type: 'result', subtype: 'success', duration_ms: 1, total_cost_usd: 0, usage: {} });
    await adapter.disconnect();
  });

  it('throws when cancel V2 decision is sent to Claude adapter', async () => {
    const queryFn = makeScriptedQuery();
    let capturedCanUseTool:
      | NonNullable<Parameters<ClaudeQueryFunction>[0]['options']>['canUseTool']
      | undefined;
    const wrappedFn: ClaudeQueryFunction = (params) => {
      capturedCanUseTool = params.options?.canUseTool;
      return queryFn()(params);
    };
    const adapter = new ClaudeProtocolAdapter(wrappedFn);

    await adapter.connect(config);
    const controller = queryFn.current!;
    controller.emit({ type: 'system', subtype: 'init', session_id: 's1' });
    void adapter.sendMessage({ turnId: 'turn-cancel', content: 'go' });
    await waitFor(() => controller.inputs.length === 1);

    const decisionPromise = capturedCanUseTool?.(
      'Bash',
      { command: 'ls' },
      { signal: new AbortController().signal, toolUseID: 'req-cancel', title: 'run ls' }
    );
    await adapter.respondToApproval({ requestId: 'req-cancel', decision: { kind: 'cancel' } });
    await expect(decisionPromise).rejects.toThrow(/cancel/i);

    controller.emit({ type: 'result', subtype: 'success', duration_ms: 1, total_cost_usd: 0, usage: {} });
    await adapter.disconnect();
  });

  it('throws when unsupported session scope V2 decision is sent to Claude adapter', async () => {
    const queryFn = makeScriptedQuery();
    let capturedCanUseTool:
      | NonNullable<Parameters<ClaudeQueryFunction>[0]['options']>['canUseTool']
      | undefined;
    const wrappedFn: ClaudeQueryFunction = (params) => {
      capturedCanUseTool = params.options?.canUseTool;
      return queryFn()(params);
    };
    const adapter = new ClaudeProtocolAdapter(wrappedFn);

    await adapter.connect(config);
    const controller = queryFn.current!;
    controller.emit({ type: 'system', subtype: 'init', session_id: 's1' });
    void adapter.sendMessage({ turnId: 'turn-scope', content: 'go' });
    await waitFor(() => controller.inputs.length === 1);

    const decisionPromise = capturedCanUseTool?.(
      'Bash',
      { command: 'ls' },
      { signal: new AbortController().signal, toolUseID: 'req-scope', title: 'run ls' }
    );
    await adapter.respondToApproval({
      requestId: 'req-scope',
      decision: { kind: 'accept', scope: 'session' },
    });
    await expect(decisionPromise).rejects.toThrow(/session/i);

    controller.emit({ type: 'result', subtype: 'success', duration_ms: 1, total_cost_usd: 0, usage: {} });
    await adapter.disconnect();
  });

  it('interrupt() ends the active turn and triggers SDK interrupt', async () => {
    const queryFn = makeScriptedQuery();
    const adapter = new ClaudeProtocolAdapter(queryFn());
    collectPatches(adapter);

    await adapter.connect(config);
    const controller = queryFn.current!;
    controller.emit({
      type: 'system',
      subtype: 'init',
      session_id: 'claude-session-1',
    });

    void adapter.sendMessage({ turnId: 'turn-int', content: 'long task' });
    await waitFor(() => controller.inputs.length === 1);

    await adapter.interrupt({ turnId: 'turn-int' });

    expect(controller.interruptCalls).toBe(1);
    await adapter.disconnect();
  });
});
// Suppress unused vitest helper warning when no top-level mocks are needed.
void vi;
