import { describe, expect, it, vi } from 'vitest';
import { AntigravityProtocolAdapter } from '../../../server/protocol-adapters/antigravity-adapter.js';
import { AdapterProcessRegistry } from '../../../server/protocol-adapters/adapter-utils.js';
import { CHANNEL_ADAPTER_LAUNCH_CONTRACTS } from '../../../server/protocol-adapters/index.js';
import {
  makeClaudeChildHarness,
  type ClaudeChildHarness,
  type SpawnRecord,
} from './support/claude-child-double.js';
import type { AdapterConfig } from '../../../server/protocol-adapter-v2.js';
import type { AgentPatchV2 } from '../../../shared/agent-chat-protocol-v2.js';

type SendInput = Parameters<AntigravityProtocolAdapter['sendMessage']>[0];

function queueSend(
  adapter: { sendMessage: (input: SendInput) => Promise<void> },
  input: SendInput
): Promise<void> {
  const pending = adapter.sendMessage(input);
  void pending.catch(() => {});
  return pending;
}

const config: AdapterConfig = {
  cwd: '/tmp/repo',
  port: 1,
  sessionId: 'relay-session',
  hookToken: 'x',
  configDir: '/tmp',
};

// Capture p1 line 1 trimmed
const INIT_FRAME = {
  event: 'init',
  conversation_id: '7b6b76fd-d4d5-4863-911c-5b21efad715e',
  init: {
    cwd: '/tmp/repo',
    tools: ['write_to_file', 'view_file', 'run_command', 'invoke_subagent'],
    permission_mode: 'always-proceed',
  },
};

function harness() {
  const h: ClaudeChildHarness = makeClaudeChildHarness();
  const adapter = new AntigravityProtocolAdapter(
    h.spawnFn,
    new AdapterProcessRegistry(1_000_000)
  );
  const patches: AgentPatchV2[] = [];
  adapter.onPatch((p) => patches.push(p));
  return { adapter, spawns: h.spawns, patches, harness: h };
}

async function connect(
  adapter: AntigravityProtocolAdapter,
  spawns: SpawnRecord[],
  cfg: Partial<AdapterConfig> = {}
) {
  const p = adapter.connect({ ...config, ...cfg });
  // Child was spawned synchronously in start
  const child = spawns[spawns.length - 1]!.child;
  child.serverWrite(INIT_FRAME);
  await p;
}

describe('AntigravityProtocolAdapter', () => {
  // Test 1
  it('spawns agy with the pinned argv, cwd, and sanitized env', async () => {
    const { adapter, spawns } = harness();
    await connect(adapter, spawns, {
      model: 'gemini-3.7-flash',
      extra: { effort: 'high' },
      processEnv: {
        CLAUDECODE: 'must-be-stripped',
        CLAUDE_CODE_ENTRYPOINT: 'must-be-stripped',
        RELAY_PROFILE_SAFE: 'preserved',
      },
    });

    const spawn = spawns[0]!;
    expect(spawn.command).toBe('agy');
    expect(spawn.args).toEqual([
      '--add-dir',
      '/tmp/repo',
      '--disable-slash-commands',
      '--mode',
      'accept-edits',
      '--print-timeout',
      '24h',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--model',
      'gemini-3.7-flash',
      '--effort',
      'high',
      '-p',
      '',
    ]);
    expect(spawn.options.cwd).toBe('/tmp/repo');
    expect(spawn.options.env.RELAY_PROFILE_SAFE).toBe('preserved');
    for (const key of CHANNEL_ADAPTER_LAUNCH_CONTRACTS.antigravity
      .processEnvDenylist) {
      expect(spawn.options.env).not.toHaveProperty(key);
    }
  });

  // Test 2
  it('appends --dangerously-skip-permissions only for permissionMode always-proceed', async () => {
    const { adapter: a1, spawns: s1 } = harness();
    await connect(a1, s1, { permissionMode: 'default' });
    expect(s1[0]!.args).toContain('--mode');
    expect(s1[0]!.args).toContain('accept-edits');
    expect(s1[0]!.args).not.toContain('--dangerously-skip-permissions');

    const { adapter: a2, spawns: s2 } = harness();
    await connect(a2, s2, { permissionMode: 'always-proceed' });
    expect(s2[0]!.args).toContain('--mode');
    expect(s2[0]!.args).toContain('accept-edits');
    expect(s2[0]!.args).toContain('--dangerously-skip-permissions');
  });

  // Test 3
  it('publishes honest capabilities and the conversation id after init', async () => {
    const { adapter, spawns, patches } = harness();
    await connect(adapter, spawns);

    expect(adapter.agentType).toBe('antigravity');
    expect(adapter.capabilities).toMatchObject({
      text: true,
      reasoning: false,
      tools: true,
      commandExecution: true,
      fileChanges: true,
      approvals: false,
      questions: false,
      plans: false,
      slashCommands: false,
      queue: true,
      steer: false,
      interrupt: true,
      cancelQueued: false,
      resume: true,
      fork: false,
      rollback: false,
      compact: false,
      telemetry: true,
      rateLimits: false,
      streaming: true,
    });

    const snapshot = patches.find(
      (p) => p.type === 'agent-session-snapshot-v2'
    ) as Extract<AgentPatchV2, { type: 'agent-session-snapshot-v2' }>;
    expect(snapshot).toBeTruthy();
    expect(snapshot.session.providerSession).toEqual({
      antigravityConversationId: '7b6b76fd-d4d5-4863-911c-5b21efad715e',
    });
  });

  // Test 4
  it('rejects connect on a result before init', async () => {
    const { adapter, spawns } = harness();
    const connectPromise = adapter.connect(config);
    // Capture p6 line 1
    spawns[0]!.child.serverWrite({
      event: 'result',
      result: {
        conversation_id: '',
        status: 'ERROR',
        response: '',
        error:
          'invalid model selection (--model "bogus" --effort ""): model bogus is not recognized',
        duration_seconds: 0,
        num_turns: 0,
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          thinking_tokens: 0,
          cache_read_tokens: 0,
          total_tokens: 0,
        },
      },
    });

    await expect(connectPromise).rejects.toThrow('invalid model selection');
    expect(adapter.status).toBe('disconnected');
  });

  // Test 5
  it('warns and adopts the fresh id when --conversation is unknown', async () => {
    const { adapter, spawns, patches } = harness();
    const connectPromise = adapter.connect({
      ...config,
      resumeSessionId: 'bogus-not-a-uuid',
    });
    expect(spawns[0]!.args).toContain('--conversation');
    expect(spawns[0]!.args).toContain('bogus-not-a-uuid');

    spawns[0]!.child.serverWrite({
      event: 'init',
      conversation_id: 'fresh-generated-uuid-1234',
      init: { cwd: '/tmp/repo', tools: [], permission_mode: 'always-proceed' },
    });
    await connectPromise;

    const errorPatch = patches.find(
      (p) => p.type === 'agent-error-v2'
    ) as Extract<AgentPatchV2, { type: 'agent-error-v2' }>;
    expect(errorPatch).toBeTruthy();
    expect(errorPatch.message).toContain('bogus-not-a-uuid');

    const snapshot = patches.find(
      (p) => p.type === 'agent-session-snapshot-v2'
    ) as Extract<AgentPatchV2, { type: 'agent-session-snapshot-v2' }>;
    expect(snapshot.session.providerSession).toEqual({
      antigravityConversationId: 'fresh-generated-uuid-1234',
    });
  });

  // Test 6
  it('writes one stdin frame per turn and completes the turn only on result', async () => {
    const { adapter, spawns, patches } = harness();
    await connect(adapter, spawns);

    const child = spawns[0]!.child;
    const sendPromise = adapter.sendMessage({
      turnId: 't1',
      content: 'hello',
    });

    await sendPromise;
    expect(child.frames()).toEqual([
      { event: 'user', message: { role: 'user', content: 'hello' } },
    ]);

    // Feed p2 lines 2-3 (user_input echo, agent_response text_delta)
    child.serverWrite({
      event: 'step_update',
      step_update: {
        conversation_id: '7b6b76fd-d4d5-4863-911c-5b21efad715e',
        step_index: 0,
        state: 'DONE',
        step_type: 'user_input',
      },
    });
    child.serverWrite({
      event: 'step_update',
      step_update: {
        conversation_id: '7b6b76fd-d4d5-4863-911c-5b21efad715e',
        step_index: 1,
        state: 'DONE',
        step_type: 'agent_response',
        text_delta: 'hello back',
      },
    });

    expect(patches.some((p) => p.type === 'agent-turn-completed-v2')).toBe(
      false
    );

    // Feed p2 line 4 (result SUCCESS)
    child.serverWrite({
      event: 'result',
      result: {
        conversation_id: '7b6b76fd-d4d5-4863-911c-5b21efad715e',
        status: 'SUCCESS',
        response: 'hello back',
        duration_seconds: 1.0,
        num_turns: 1,
        usage: {
          input_tokens: 100,
          output_tokens: 20,
          thinking_tokens: 10,
          cache_read_tokens: 0,
          total_tokens: 120,
        },
      },
    });

    const completed = patches.find(
      (p) => p.type === 'agent-turn-completed-v2'
    ) as Extract<AgentPatchV2, { type: 'agent-turn-completed-v2' }>;
    expect(completed).toBeTruthy();
    expect(completed.turnId).toBe('t1');
    expect(completed.status).toBe('completed');
  });

  // Test 7
  it('prefixes the Relay appendix on the first turn of a fresh conversation only', async () => {
    const { adapter, spawns } = harness();
    await connect(adapter, spawns, {
      systemPromptAppendix: 'Remember to be concise.',
    });

    const child = spawns[0]!.child;
    await adapter.sendMessage({ turnId: 't1', content: 'first turn' });
    expect(child.frames()[0]).toEqual({
      event: 'user',
      message: {
        role: 'user',
        content:
          '<relay_context>\nRemember to be concise.\n</relay_context>\n\nfirst turn',
      },
    });

    // Complete t1
    child.serverWrite({
      event: 'result',
      result: { status: 'SUCCESS', response: 'ok' },
    });

    // Second turn
    await adapter.sendMessage({ turnId: 't2', content: 'second turn' });
    expect(child.frames()[1]).toEqual({
      event: 'user',
      message: { role: 'user', content: 'second turn' },
    });

    // Resumed session should NOT prefix appendix
    const { adapter: aResumed, spawns: sResumed } = harness();
    await connect(aResumed, sResumed, {
      resumeSessionId: 'existing-conv-id',
      systemPromptAppendix: 'Remember to be concise.',
    });
    await aResumed.sendMessage({ turnId: 't3', content: 'resumed turn' });
    expect(sResumed[0]!.child.frames()[0]).toEqual({
      event: 'user',
      message: { role: 'user', content: 'resumed turn' },
    });
  });

  // Test 8
  it('maps p1 tool steps to fileChange, dynamicToolCall and one per-turn assistant item', async () => {
    const { adapter, spawns, patches } = harness();
    await connect(adapter, spawns);

    const child = spawns[0]!.child;
    await adapter.sendMessage({ turnId: 't1', content: 'do p1 probe' });

    // Feed p1 lines 2-11
    // p1:2 user_input
    child.serverWrite({
      event: 'step_update',
      step_update: {
        conversation_id: '7b6b76fd-d4d5-4863-911c-5b21efad715e',
        step_index: 0,
        state: 'DONE',
        step_type: 'user_input',
      },
    });
    // p1:3 agent_response planning
    child.serverWrite({
      event: 'step_update',
      step_update: {
        conversation_id: '7b6b76fd-d4d5-4863-911c-5b21efad715e',
        step_index: 1,
        state: 'DONE',
        step_type: 'agent_response',
        duration_seconds: 3.0,
        usage: {
          input_tokens: 13935,
          output_tokens: 700,
          thinking_tokens: 620,
          cache_read_tokens: 0,
          total_tokens: 14635,
        },
      },
    });
    // p1:4 write_to_file ACTIVE
    child.serverWrite({
      event: 'step_update',
      step_update: {
        conversation_id: '7b6b76fd-d4d5-4863-911c-5b21efad715e',
        step_index: 2,
        state: 'ACTIVE',
        step_type: 'tool',
        tool_name: 'write_to_file',
        tool_info: {
          name: 'write_to_file',
          parameters: {
            TargetFile:
              '/home/donovanyohan/.gemini/antigravity-cli/scratch/hello.txt',
          },
        },
      },
    });
    // p1:5 write_to_file DONE
    child.serverWrite({
      event: 'step_update',
      step_update: {
        conversation_id: '7b6b76fd-d4d5-4863-911c-5b21efad715e',
        step_index: 2,
        state: 'DONE',
        step_type: 'tool',
        tool_name: 'write_to_file',
        duration_seconds: 0.05,
        tool_info: {
          name: 'write_to_file',
          parameters: {
            TargetFile:
              '/home/donovanyohan/.gemini/antigravity-cli/scratch/hello.txt',
          },
        },
      },
    });
    // p1:6 agent_response planning
    child.serverWrite({
      event: 'step_update',
      step_update: {
        conversation_id: '7b6b76fd-d4d5-4863-911c-5b21efad715e',
        step_index: 3,
        state: 'DONE',
        step_type: 'agent_response',
        duration_seconds: 1.0,
        usage: {
          input_tokens: 14752,
          output_tokens: 64,
          thinking_tokens: 9,
          cache_read_tokens: 0,
          total_tokens: 14816,
        },
      },
    });
    // p1:7 view_file ACTIVE
    child.serverWrite({
      event: 'step_update',
      step_update: {
        conversation_id: '7b6b76fd-d4d5-4863-911c-5b21efad715e',
        step_index: 4,
        state: 'ACTIVE',
        step_type: 'tool',
        tool_name: 'view_file',
        tool_info: {
          name: 'view_file',
          parameters: {
            AbsolutePath:
              '/home/donovanyohan/.gemini/antigravity-cli/scratch/hello.txt',
          },
        },
      },
    });
    // p1:8 view_file DONE
    child.serverWrite({
      event: 'step_update',
      step_update: {
        conversation_id: '7b6b76fd-d4d5-4863-911c-5b21efad715e',
        step_index: 4,
        state: 'DONE',
        step_type: 'tool',
        tool_name: 'view_file',
        duration_seconds: 0.07,
        tool_info: {
          name: 'view_file',
          parameters: {
            AbsolutePath:
              '/home/donovanyohan/.gemini/antigravity-cli/scratch/hello.txt',
          },
          output: '2 lines, 10 bytes',
        },
      },
    });
    // p1:9 agent_response ACTIVE text_delta
    child.serverWrite({
      event: 'step_update',
      step_update: {
        conversation_id: '7b6b76fd-d4d5-4863-911c-5b21efad715e',
        step_index: 5,
        state: 'ACTIVE',
        step_type: 'agent_response',
        text_delta: 'Contents of hello.txt:',
      },
    });
    // p1:10 agent_response DONE text_delta
    child.serverWrite({
      event: 'step_update',
      step_update: {
        conversation_id: '7b6b76fd-d4d5-4863-911c-5b21efad715e',
        step_index: 5,
        state: 'DONE',
        step_type: 'agent_response',
        text_delta: '\n',
        duration_seconds: 1.3,
        usage: {
          input_tokens: 15005,
          output_tokens: 91,
          thinking_tokens: 53,
          cache_read_tokens: 0,
          total_tokens: 15096,
        },
      },
    });
    // p1:11 result SUCCESS
    child.serverWrite({
      event: 'result',
      result: {
        conversation_id: '7b6b76fd-d4d5-4863-911c-5b21efad715e',
        status: 'SUCCESS',
        response: 'Contents of hello.txt:\n',
        duration_seconds: 5.4,
        num_turns: 1,
        usage: {
          input_tokens: 43692,
          output_tokens: 855,
          thinking_tokens: 682,
          cache_read_tokens: 0,
          total_tokens: 44547,
        },
      },
    });

    // Check item started & updated for fileChange (t1-tool-2)
    const startedTool2 = patches.find(
      (p) =>
        p.type === 'agent-item-started-v2' &&
        p.item.id === 't1-tool-2' &&
        p.item.type === 'fileChange'
    ) as Extract<AgentPatchV2, { type: 'agent-item-started-v2' }>;
    expect(startedTool2).toBeTruthy();
    expect((startedTool2.item as any).applyStatus).toBe('pending');

    const updatedTool2 = patches.find(
      (p) =>
        p.type === 'agent-item-updated-v2' &&
        p.item.id === 't1-tool-2' &&
        p.item.type === 'fileChange'
    ) as Extract<AgentPatchV2, { type: 'agent-item-updated-v2' }>;
    expect(updatedTool2).toBeTruthy();
    expect((updatedTool2.item as any).applyStatus).toBe('applied');

    // Check dynamicToolCall (t1-tool-4)
    const updatedTool4 = patches.find(
      (p) =>
        p.type === 'agent-item-updated-v2' &&
        p.item.id === 't1-tool-4' &&
        p.item.type === 'dynamicToolCall'
    ) as Extract<AgentPatchV2, { type: 'agent-item-updated-v2' }>;
    expect(updatedTool4).toBeTruthy();
    expect((updatedTool4.item as any).tool).toBe('view_file');
    expect((updatedTool4.item as any).result).toBe('2 lines, 10 bytes');

    // Check assistant item — ONE per turn, never per agent_response step (#1532)
    const startedAssistant = patches.find(
      (p) =>
        p.type === 'agent-item-started-v2' &&
        p.item.id === 't1-assistant' &&
        p.item.type === 'assistantMessage'
    );
    expect(startedAssistant).toBeTruthy();

    const completedTurn = patches.find(
      (p) => p.type === 'agent-turn-completed-v2'
    ) as Extract<AgentPatchV2, { type: 'agent-turn-completed-v2' }>;
    expect(completedTurn).toBeTruthy();
    // Sum of input_tokens across steps 1, 3, 5 = 13935 + 14752 + 15005 = 43692
    expect(completedTurn.usage?.inputTokens).toBe(13935 + 14752 + 15005);
  });

  // Test 9
  it('maps run_command to commandExecution without an exit code', async () => {
    const { adapter, spawns, patches } = harness();
    await connect(adapter, spawns);

    const child = spawns[0]!.child;
    await adapter.sendMessage({ turnId: 't1', content: 'run exit 3' });

    // Capture p7:7-8
    child.serverWrite({
      event: 'step_update',
      step_update: {
        step_index: 4,
        state: 'ACTIVE',
        step_type: 'tool',
        tool_name: 'run_command',
        tool_info: {
          name: 'run_command',
          parameters: { CommandLine: 'exit 3' },
        },
      },
    });
    child.serverWrite({
      event: 'step_update',
      step_update: {
        step_index: 4,
        state: 'DONE',
        step_type: 'tool',
        tool_name: 'run_command',
        duration_seconds: 0.06,
        tool_info: {
          name: 'run_command',
          parameters: { CommandLine: 'exit 3' },
        },
      },
    });

    const updated = patches.find(
      (p) =>
        p.type === 'agent-item-updated-v2' &&
        p.item.id === 't1-tool-4' &&
        p.item.type === 'commandExecution'
    ) as Extract<AgentPatchV2, { type: 'agent-item-updated-v2' }>;
    expect(updated).toBeTruthy();
    const item = updated.item as any;
    expect(item.command).toBe('exit 3');
    expect(item.exitCode).toBeUndefined();
    expect(item.status).toBe('completed');
  });

  // Test 10
  it('marks a tool ERROR failed and keeps the turn running', async () => {
    const { adapter, spawns, patches } = harness();
    await connect(adapter, spawns);

    const child = spawns[0]!.child;
    await adapter.sendMessage({ turnId: 't1', content: 'failing tool' });

    // Capture p7:4-6
    child.serverWrite({
      event: 'step_update',
      step_update: {
        step_index: 2,
        state: 'ACTIVE',
        step_type: 'tool',
        tool_name: 'view_file',
        tool_info: {
          name: 'view_file',
          parameters: { AbsolutePath: '/missing/file' },
        },
      },
    });
    child.serverWrite({
      event: 'step_update',
      step_update: {
        step_index: 2,
        state: 'ERROR',
        step_type: 'tool',
        tool_name: 'view_file',
        tool_info: {
          name: 'view_file',
          parameters: { AbsolutePath: '/missing/file' },
          error: {
            type: 'TOOL_ERROR',
            message: 'failed to read file: no such file',
          },
        },
      },
    });

    const updated = patches.find(
      (p) =>
        p.type === 'agent-item-updated-v2' &&
        p.item.id === 't1-tool-2' &&
        p.item.status === 'failed'
    );
    expect(updated).toBeTruthy();
    expect(patches.some((p) => p.type === 'agent-turn-completed-v2')).toBe(
      false
    );
  });

  // Test 11
  it('fails a CANCELED turn with the stderr jetski reason', async () => {
    const { adapter, spawns, patches } = harness();
    await connect(adapter, spawns);

    const child = spawns[0]!.child;
    await adapter.sendMessage({ turnId: 't1', content: 'test perm denial' });

    child.emitStderr(
      'jetski: no output produced — a tool required the "command" permission that headless mode cannot prompt for. Re-run with --dangerously-skip-permissions to auto-approve all tools.\n'
    );

    // Feed p4:4-6
    child.serverWrite({
      event: 'step_update',
      step_update: {
        step_index: 2,
        state: 'ACTIVE',
        step_type: 'tool',
        tool_name: 'run_command',
        tool_info: {
          name: 'run_command',
          parameters: { CommandLine: 'touch perm-probe.txt' },
        },
      },
    });
    child.serverWrite({
      event: 'step_update',
      step_update: {
        step_index: 2,
        state: 'DONE',
        step_type: 'tool',
        tool_name: 'run_command',
        tool_info: {
          name: 'run_command',
          parameters: { CommandLine: 'touch perm-probe.txt' },
        },
      },
    });
    child.serverWrite({
      event: 'result',
      result: {
        conversation_id: '1b7792aa-c599-4250-a7a2-ccf25c593380',
        status: 'CANCELED',
        response: '',
        num_turns: 1,
      },
    });

    const errorPatch = patches.find(
      (p) => p.type === 'agent-error-v2'
    ) as Extract<AgentPatchV2, { type: 'agent-error-v2' }>;
    expect(errorPatch).toBeTruthy();
    expect(errorPatch.message).toContain('--dangerously-skip-permissions');

    const completed = patches.find(
      (p) => p.type === 'agent-turn-completed-v2'
    ) as Extract<AgentPatchV2, { type: 'agent-turn-completed-v2' }>;
    expect(completed.status).toBe('failed');
    expect(child.closed).toBe(false);
  });

  // Test 12
  it('treats result ERROR as failed and discards the child', async () => {
    const { adapter, spawns, patches } = harness();
    await connect(adapter, spawns);

    const child = spawns[0]!.child;
    await adapter.sendMessage({ turnId: 't1', content: 'timeout turn' });

    // Feed p10b:5
    child.serverWrite({
      event: 'result',
      result: {
        conversation_id: 'a53994f2-9dbe-4977-8bed-96343b8f7a47',
        status: 'ERROR',
        response: '',
        error: 'timeout waiting for response',
        num_turns: 1,
      },
    });

    const completed = patches.find(
      (p) => p.type === 'agent-turn-completed-v2'
    ) as Extract<AgentPatchV2, { type: 'agent-turn-completed-v2' }>;
    expect(completed.status).toBe('failed');

    // Next sendMessage should respawn
    await adapter.sendMessage({ turnId: 't2', content: 'after timeout' });
    expect(spawns.length).toBe(2);
    expect(spawns[1]!.args).toContain('--conversation');
  });

  // Test 13
  it('interrupt sends SIGINT and completes the turn as interrupted, then respawns with --conversation', async () => {
    const { adapter, spawns, patches } = harness();
    await connect(adapter, spawns);

    const child = spawns[0]!.child;
    await adapter.sendMessage({ turnId: 't1', content: 'run long sleep' });

    const interruptPromise = adapter.interrupt({ turnId: 't1' });
    expect(child.kill).toHaveBeenCalledWith('SIGINT');

    // Feed p5d:5 result ERROR + close
    child.serverWrite({
      event: 'result',
      result: {
        conversation_id: '7b6b76fd-d4d5-4863-911c-5b21efad715e',
        status: 'ERROR',
        error: 'timeout waiting for response',
      },
    });
    child.emitClose(1, null);
    await interruptPromise;

    const completed = patches.find(
      (p) => p.type === 'agent-turn-completed-v2'
    ) as Extract<AgentPatchV2, { type: 'agent-turn-completed-v2' }>;
    expect(completed.status).toBe('interrupted');

    // Follow-up turn respawns with --conversation
    await adapter.sendMessage({ turnId: 't2', content: 'after interrupt' });
    expect(spawns.length).toBe(2);
    expect(spawns[1]!.args).toContain('--conversation');
  });

  // Test 14
  it('interrupt is a no-op without an active turn or on turn mismatch', async () => {
    const { adapter, spawns } = harness();
    await connect(adapter, spawns);

    await adapter.interrupt({ turnId: 'nonexistent' });
    expect(spawns[0]!.child.kill).not.toHaveBeenCalled();

    await adapter.sendMessage({ turnId: 't1', content: 'hi' });
    await adapter.interrupt({ turnId: 'mismatched-turn' });
    expect(spawns[0]!.child.kill).not.toHaveBeenCalled();
  });

  // Test 15
  it('queues a second message and writes it only after the first result', async () => {
    const { adapter, spawns, patches } = harness();
    await connect(adapter, spawns);

    const child = spawns[0]!.child;
    await adapter.sendMessage({ turnId: 't1', content: 'msg 1' });
    expect(child.frames().length).toBe(1);

    const q = queueSend(adapter, { turnId: 't2', content: 'msg 2' });
    expect(child.frames().length).toBe(1);

    // Complete t1
    child.serverWrite({
      event: 'result',
      result: { status: 'SUCCESS', response: 'reply 1' },
    });
    await q;

    expect(child.frames().length).toBe(2);
    expect(child.frames()[1]).toEqual({
      event: 'user',
      message: { role: 'user', content: 'msg 2' },
    });

    const starts = patches.filter((p) => p.type === 'agent-turn-started-v2');
    expect(starts.map((s: any) => s.turn.id)).toEqual(['t1', 't2']);
  });

  // Test 16
  it('rejects queued messages and fails the active turn when the child dies', async () => {
    const { adapter, spawns, patches } = harness();
    await connect(adapter, spawns);

    const child = spawns[0]!.child;
    await adapter.sendMessage({ turnId: 't1', content: 'active msg' });
    const q = queueSend(adapter, { turnId: 't2', content: 'queued msg' });

    child.emitClose(137, 'SIGKILL');

    await expect(q).rejects.toThrow(
      'Antigravity session ended before this queued message was sent.'
    );

    const completed = patches.find(
      (p) => p.type === 'agent-turn-completed-v2'
    ) as Extract<AgentPatchV2, { type: 'agent-turn-completed-v2' }>;
    expect(completed.status).toBe('failed');
    expect(completed.error).toContain('exited');

    expect(adapter.status).toBe('disconnected');
  });

  // Test 17
  it('emits every unmapped step and event as a providerExtension, never silently', async () => {
    const { adapter, spawns, patches } = harness();
    await connect(adapter, spawns);

    const child = spawns[0]!.child;
    await adapter.sendMessage({ turnId: 't1', content: 'unmapped probe' });

    // 1. unknown step (p12:4)
    child.serverWrite({
      event: 'step_update',
      step_update: {
        step_index: 2,
        state: 'DONE',
        step_type: 'unknown',
      },
    });

    // 2. system_message (p3:3)
    child.serverWrite({
      event: 'step_update',
      step_update: {
        step_index: 7,
        state: 'DONE',
        step_type: 'system_message',
        duration_seconds: 0.0001,
      },
    });

    // 3. command_result event
    child.serverWrite({
      event: 'command_result',
      data: { some: 'value' },
    });

    // 4. browser step_type
    child.serverWrite({
      event: 'step_update',
      step_update: {
        step_type: 'browser',
        state: 'DONE',
        step_index: 9,
      },
    });

    const extensions = patches.filter(
      (p) =>
        p.type === 'agent-item-started-v2' &&
        p.item.type === 'providerExtension'
    );
    expect(extensions.length).toBe(4);
    expect(extensions.map((e: any) => e.item.id)).toEqual([
      'ext-antigravity-t1-1',
      'ext-antigravity-t1-2',
      'ext-antigravity-t1-3',
      'ext-antigravity-t1-4',
    ]);
  });

  // Test 17b (#1548)
  it('turns a checkpoint step during an open tool call into turn-scoped activity, not a warn', async () => {
    const { adapter, spawns, patches } = harness();
    await connect(adapter, spawns);
    const child = spawns[0]!.child;
    await adapter.sendMessage({ turnId: 't1', content: 'run the checks' });

    // A long command opens and stays open — this is the shape that used to be
    // force-drained by the channel binder's inactivity watchdog.
    child.serverWrite({
      event: 'step_update',
      step_update: {
        step_index: 1,
        state: 'ACTIVE',
        step_type: 'tool',
        tool_name: 'run_command',
        tool_info: {
          name: 'run_command',
          parameters: { CommandLine: 'npm run check' },
        },
      },
    });
    const started = patches.filter((p) => p.type === 'agent-item-started-v2');
    expect(
      started.some(
        (p) =>
          p.type === 'agent-item-started-v2' &&
          p.item.type === 'commandExecution' &&
          p.item.status === 'running'
      )
    ).toBe(true);

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const before = patches.length;
    try {
      // agy's keep-alive through the command. Nothing maps it to an item, but
      // it names the turn, so it MUST reach the binder as activity.
      child.serverWrite({
        event: 'step_update',
        step_update: {
          step_index: 2,
          state: 'DONE',
          step_type: 'checkpoint',
        },
      });
      expect(
        warn.mock.calls.some((call) =>
          String(call[0] ?? '').includes('unmapped step_update')
        )
      ).toBe(false);
    } finally {
      warn.mockRestore();
    }

    const live = patches
      .slice(before)
      .filter((p) => p.type === 'agent-live-state-updated-v2');
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({
      type: 'agent-live-state-updated-v2',
      live: { activeTurnId: 't1' },
    });
    // A bare activity ping: it must not restate status or waiting state.
    expect(
      Object.keys((live[0] as { live: Record<string, unknown> }).live)
    ).toEqual(['activeTurnId']);
  });

  // Test 17c (#1548)
  it('an idle heartbeat names no turn, so it can never read as activity', async () => {
    const { adapter, spawns, patches } = harness();
    await connect(adapter, spawns);
    const child = spawns[0]!.child;
    await adapter.sendMessage({ turnId: 't1', content: 'go' });
    child.serverWrite({
      event: 'result',
      result: { status: 'SUCCESS', response: 'ok' },
    });

    // The turn's own terminal live-state is EXPLICIT about having no turn in
    // flight; the binder collapses that to "names no turn", which is what stops
    // an idle ping from refreshing a silence budget.
    const live = patches.filter(
      (p) => p.type === 'agent-live-state-updated-v2'
    );
    const terminal = live.at(-1) as { live: Record<string, unknown> };
    expect(terminal.live).toMatchObject({ activeTurnId: null });
    expect(Object.hasOwn(terminal.live, 'activeTurnId')).toBe(true);

    // A late step for a turn that is over emits no heartbeat at all — there is
    // no turn to attribute it to, so it can never revive one.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const before = patches.length;
    try {
      child.serverWrite({
        event: 'step_update',
        step_update: { step_index: 9, state: 'DONE', step_type: 'checkpoint' },
      });
    } finally {
      warn.mockRestore();
    }
    expect(
      patches
        .slice(before)
        .filter((p) => p.type === 'agent-live-state-updated-v2')
    ).toEqual([]);
  });

  // Test 18
  it('emits an assistant fallback item from result.response when nothing streamed', async () => {
    const { adapter, spawns, patches } = harness();
    await connect(adapter, spawns);

    const child = spawns[0]!.child;
    await adapter.sendMessage({ turnId: 't1', content: 'ping' });

    child.serverWrite({
      event: 'step_update',
      step_update: {
        step_index: 0,
        state: 'DONE',
        step_type: 'user_input',
      },
    });
    child.serverWrite({
      event: 'result',
      result: {
        status: 'SUCCESS',
        response: 'PONG\n',
      },
    });

    const fallbackItem = patches.find(
      (p) =>
        p.type === 'agent-item-started-v2' &&
        p.item.id === 't1-assistant-final' &&
        p.item.type === 'assistantMessage'
    ) as Extract<AgentPatchV2, { type: 'agent-item-started-v2' }>;
    expect(fallbackItem).toBeTruthy();
    expect((fallbackItem.item as any).text).toBe('PONG\n');
  });

  // Test 19
  it('does not deliver image attachments and says so', async () => {
    const { adapter, spawns, patches } = harness();
    await connect(adapter, spawns);

    const child = spawns[0]!.child;
    await adapter.sendMessage({
      turnId: 't1',
      content: 'image msg',
      attachments: [
        { type: 'image', path: '/tmp/x.png', mimeType: 'image/png' },
      ],
    });

    const errorPatch = patches.find(
      (p) => p.type === 'agent-error-v2'
    ) as Extract<AgentPatchV2, { type: 'agent-error-v2' }>;
    expect(errorPatch).toBeTruthy();
    expect(errorPatch.turnId).toBe('t1');
    expect(errorPatch.message).toContain('deliversImages: false');

    expect(child.frames().length).toBe(1);
    expect(child.frames()[0]).toEqual({
      event: 'user',
      message: { role: 'user', content: 'image msg' },
    });
  });

  // Test 20
  it('respondToApproval / respondToInput throw', async () => {
    const { adapter, spawns } = harness();
    await connect(adapter, spawns);

    await expect(
      adapter.respondToApproval({
        requestId: 'r1',
        decision: { kind: 'accept' },
      } as any)
    ).rejects.toThrow(
      'Antigravity stream-json approvals/questions are not mapped'
    );

    await expect(
      adapter.respondToInput({ requestId: 'r1', answers: {} } as any)
    ).rejects.toThrow(
      'Antigravity stream-json approvals/questions are not mapped'
    );
  });

  // Test 21
  it('crash-loop breaker refuses a fourth respawn within the window', async () => {
    const { adapter, spawns } = harness();
    await connect(adapter, spawns);

    for (let i = 0; i < 3; i++) {
      await adapter.sendMessage({ turnId: `t${i}`, content: `crash ${i}` });
      spawns[i]!.child.serverWrite({
        event: 'result',
        result: {
          status: 'ERROR',
          error: `crash error ${i}`,
        },
      });
    }

    await expect(
      adapter.sendMessage({ turnId: 't4', content: 'should fail' })
    ).rejects.toThrow('crash-looping');
  });

  // #1532 — one assistant row per turn, never one per agent_response step
  it('folds every agent_response step into ONE assistant item and never emits an empty one', async () => {
    const { adapter, spawns, patches } = harness();
    await connect(adapter, spawns);
    const child = spawns[0]!.child;
    await adapter.sendMessage({ turnId: 't1', content: 'multi-tool turn' });

    const step = (su: Record<string, unknown>) =>
      child.serverWrite({
        event: 'step_update',
        step_update: {
          conversation_id: '7b6b76fd-d4d5-4863-911c-5b21efad715e',
          ...su,
        },
      });
    const command = (stepIndex: number, state: string, cmd: string) =>
      step({
        step_index: stepIndex,
        state,
        step_type: 'tool',
        tool_name: 'run_command',
        tool_info: { name: 'run_command', parameters: { CommandLine: cmd } },
      });

    step({ step_index: 0, state: 'DONE', step_type: 'user_input' });
    // Narration burst 1: text arrives ACTIVE, DONE carries only usage.
    step({
      step_index: 1,
      state: 'ACTIVE',
      step_type: 'agent_response',
      text_delta: 'Checking the tests.',
    });
    step({
      step_index: 1,
      state: 'DONE',
      step_type: 'agent_response',
      usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 },
    });
    command(2, 'ACTIVE', 'npm test');
    command(2, 'DONE', 'npm test');
    // Narration burst 2: text arrives on DONE.
    step({
      step_index: 3,
      state: 'DONE',
      step_type: 'agent_response',
      text_delta: 'They passed.',
    });
    command(4, 'ACTIVE', 'git status');
    command(4, 'DONE', 'git status');
    // A text-free narration step must open no row at all.
    step({ step_index: 5, state: 'ACTIVE', step_type: 'agent_response' });
    step({ step_index: 5, state: 'DONE', step_type: 'agent_response' });

    child.serverWrite({
      event: 'result',
      result: {
        conversation_id: '7b6b76fd-d4d5-4863-911c-5b21efad715e',
        status: 'SUCCESS',
        response: 'Checking the tests.\n\nThey passed.',
      },
    });

    const assistantStarted = patches.filter(
      (p) =>
        p.type === 'agent-item-started-v2' && p.item.type === 'assistantMessage'
    );
    expect(assistantStarted.map((p) => (p as any).item.id)).toEqual([
      't1-assistant',
    ]);

    const assistantTerminal = patches.filter(
      (p) =>
        p.type === 'agent-item-updated-v2' &&
        p.item.type === 'assistantMessage' &&
        p.item.status === 'completed'
    ) as Array<Extract<AgentPatchV2, { type: 'agent-item-updated-v2' }>>;
    expect(assistantTerminal).toHaveLength(1);
    expect((assistantTerminal[0]!.item as any).id).toBe('t1-assistant');
    expect((assistantTerminal[0]!.item as any).text).toBe(
      'Checking the tests.\n\nThey passed.'
    );
    // Never an empty completed assistant row (#1532).
    for (const patch of assistantTerminal) {
      expect((patch.item as any).text.trim().length).toBeGreaterThan(0);
    }

    const tools = patches.filter(
      (p) =>
        p.type === 'agent-item-started-v2' && p.item.type === 'commandExecution'
    );
    expect(tools.map((p) => (p as any).item.id)).toEqual([
      't1-tool-2',
      't1-tool-4',
    ]);
    expect(
      patches.filter((p) => p.type === 'agent-turn-completed-v2')
    ).toHaveLength(1);
  });

  // #1532 — agy error_message steps are diagnostics, not turn boundaries
  it('surfaces an agy error_message step without terminalizing the turn', async () => {
    const { adapter, spawns, patches } = harness();
    await connect(adapter, spawns);
    const child = spawns[0]!.child;
    await adapter.sendMessage({ turnId: 't1', content: 'quota probe' });

    child.serverWrite({
      event: 'step_update',
      step_update: {
        conversation_id: '7b6b76fd-d4d5-4863-911c-5b21efad715e',
        step_index: 2,
        state: 'DONE',
        step_type: 'error_message',
        message: 'Individual quota reached.',
      },
    });

    const diagnostic = patches.find(
      (p) =>
        p.type === 'agent-item-started-v2' &&
        p.item.type === 'providerExtension' &&
        (p.item as any).payload?.kind === 'errorMessage'
    );
    expect(diagnostic).toBeTruthy();
    expect((diagnostic as any).item.payload.message).toBe(
      'Individual quota reached.'
    );
    // agy keeps working after an error_message; only `result` ends the turn.
    expect(patches.some((p) => p.type === 'agent-error-v2')).toBe(false);
    expect(patches.some((p) => p.type === 'agent-turn-completed-v2')).toBe(
      false
    );
    expect(
      patches.some(
        (p) =>
          p.type === 'agent-item-started-v2' &&
          p.item.type === 'providerExtension' &&
          (p.item as any).payload?.kind === 'unmappedStep'
      )
    ).toBe(false);
  });

  // #1534 — the child runs in the topic's worktree, and says so to agy too
  it('spawns in the topic worktree cwd and pins it with --add-dir', async () => {
    const worktree = '/repo/relay/.worktrees/lane';
    const { adapter, spawns } = harness();
    const p = adapter.connect({ ...config, cwd: worktree });
    const child = spawns[spawns.length - 1]!.child;
    child.serverWrite({
      ...INIT_FRAME,
      init: { ...INIT_FRAME.init, cwd: worktree },
    });
    await p;

    const spawn = spawns[0]!;
    // agy honors the process cwd (its `init.cwd` echoes it) — the `--add-dir`
    // is what also puts the worktree on its writable-roots list.
    expect(spawn.options.cwd).toBe(worktree);
    expect(spawn.args.slice(0, 2)).toEqual(['--add-dir', worktree]);
  });

  // #1532 review P2: a tool step can precede any narration text
  it('creates the assistant item lazily after a leading tool step, once and in order', async () => {
    const { adapter, spawns, patches } = harness();
    await connect(adapter, spawns);
    const child = spawns[0]!.child;
    await adapter.sendMessage({ turnId: 't1', content: 'tool first' });

    const step = (su: Record<string, unknown>) =>
      child.serverWrite({
        event: 'step_update',
        step_update: {
          conversation_id: '7b6b76fd-d4d5-4863-911c-5b21efad715e',
          ...su,
        },
      });
    const command = (stepIndex: number, state: string, cmd: string) =>
      step({
        step_index: stepIndex,
        state,
        step_type: 'tool',
        tool_name: 'run_command',
        tool_info: { name: 'run_command', parameters: { CommandLine: cmd } },
      });

    step({ step_index: 0, state: 'DONE', step_type: 'user_input' });
    // The turn opens with a tool, before a single character of narration.
    command(1, 'ACTIVE', 'ls');
    command(1, 'DONE', 'ls');
    step({
      step_index: 2,
      state: 'ACTIVE',
      step_type: 'agent_response',
      text_delta: 'Here is what I found.',
    });
    command(3, 'ACTIVE', 'git status');
    command(3, 'DONE', 'git status');
    step({
      step_index: 4,
      state: 'DONE',
      step_type: 'agent_response',
      text_delta: 'All clean.',
    });
    child.serverWrite({
      event: 'result',
      result: {
        conversation_id: '7b6b76fd-d4d5-4863-911c-5b21efad715e',
        status: 'SUCCESS',
        response: 'Here is what I found.\n\nAll clean.',
      },
    });

    // Lazy creation must not reorder the cards: the leading tool opened first.
    const startedIds = patches
      .filter((p) => p.type === 'agent-item-started-v2')
      .map((p) => (p as any).item.id)
      .filter((id: string) => id !== 'user-t1');
    expect(startedIds).toEqual(['t1-tool-1', 't1-assistant', 't1-tool-3']);

    const assistantStarted = patches.filter(
      (p) =>
        p.type === 'agent-item-started-v2' && p.item.type === 'assistantMessage'
    );
    expect(assistantStarted).toHaveLength(1);

    const assistantTerminal = patches.filter(
      (p) =>
        p.type === 'agent-item-updated-v2' &&
        p.item.type === 'assistantMessage' &&
        p.item.status === 'completed'
    );
    expect(assistantTerminal).toHaveLength(1);
    expect((assistantTerminal[0]! as any).item.text).toBe(
      'Here is what I found.\n\nAll clean.'
    );
  });

  // #1532 review P2: the step seam is normalized, not skipped
  it('always leaves a blank line between two agent_response steps, whatever the chunk ends in', async () => {
    const cases: Array<[string, string, string]> = [
      ['no trailing newline', 'One.', 'One.\n\nTwo.'],
      ['one trailing newline', 'One.\n', 'One.\n\nTwo.'],
      ['two trailing newlines', 'One.\n\n', 'One.\n\nTwo.'],
      // Deltas are append-only: an existing wider gap is left as agy sent it.
      ['many trailing newlines', 'One.\n\n\n\n', 'One.\n\n\n\nTwo.'],
    ];
    for (const [, first, expected] of cases) {
      const { adapter, spawns, patches } = harness();
      await connect(adapter, spawns);
      const child = spawns[0]!.child;
      await adapter.sendMessage({ turnId: 't1', content: 'seam' });
      const step = (su: Record<string, unknown>) =>
        child.serverWrite({
          event: 'step_update',
          step_update: {
            conversation_id: '7b6b76fd-d4d5-4863-911c-5b21efad715e',
            ...su,
          },
        });
      step({
        step_index: 1,
        state: 'DONE',
        step_type: 'agent_response',
        text_delta: first,
      });
      step({
        step_index: 3,
        state: 'DONE',
        step_type: 'agent_response',
        text_delta: 'Two.',
      });
      child.serverWrite({
        event: 'result',
        result: { status: 'SUCCESS', response: expected },
      });

      const terminal = patches.filter(
        (p) =>
          p.type === 'agent-item-updated-v2' &&
          p.item.type === 'assistantMessage' &&
          p.item.status === 'completed'
      );
      expect(terminal).toHaveLength(1);
      expect((terminal[0]! as any).item.text).toBe(expected);
    }
  });

  // #1532 review P2: agy's diagnostic text is provider-authored and unbounded
  it('caps an oversized error_message diagnostic before it reaches a channel row', async () => {
    const { adapter, spawns, patches } = harness();
    await connect(adapter, spawns);
    const child = spawns[0]!.child;
    await adapter.sendMessage({ turnId: 't1', content: 'traceback' });

    const huge = `Traceback (most recent call last):\n${'x'.repeat(20_000)}`;
    child.serverWrite({
      event: 'step_update',
      step_update: {
        conversation_id: '7b6b76fd-d4d5-4863-911c-5b21efad715e',
        step_index: 2,
        state: 'DONE',
        step_type: 'error_message',
        message: huge,
      },
    });

    const diagnostic = patches.find(
      (p) =>
        p.type === 'agent-item-started-v2' &&
        p.item.type === 'providerExtension' &&
        (p.item as any).payload?.kind === 'errorMessage'
    );
    expect(diagnostic).toBeTruthy();
    const message = (diagnostic as any).item.payload.message as string;
    expect(Buffer.byteLength(message, 'utf8')).toBeLessThanOrEqual(4096);
    expect(message.endsWith('… [truncated]')).toBe(true);
    expect(message.startsWith('Traceback (most recent call last):')).toBe(true);

    // A message inside the cap is passed through untouched.
    const { adapter: a2, spawns: s2, patches: p2 } = harness();
    await connect(a2, s2);
    await a2.sendMessage({ turnId: 't1', content: 'short' });
    s2[0]!.child.serverWrite({
      event: 'step_update',
      step_update: {
        conversation_id: '7b6b76fd-d4d5-4863-911c-5b21efad715e',
        step_index: 1,
        state: 'DONE',
        step_type: 'error_message',
        message: 'Individual quota reached.',
      },
    });
    const small = p2.find(
      (p) =>
        p.type === 'agent-item-started-v2' &&
        p.item.type === 'providerExtension' &&
        (p.item as any).payload?.kind === 'errorMessage'
    );
    expect((small as any).item.payload.message).toBe(
      'Individual quota reached.'
    );
  });
});
