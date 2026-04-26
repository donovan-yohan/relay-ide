import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { describe, it, expect, vi } from 'vitest';
import { ClaudeProtocolAdapterV2 } from '../../../server/protocol-adapters/claude-v2-adapter.js';
import type { AgentPatchV2 } from '../../../shared/agent-chat-protocol-v2.js';

interface FakeChild extends EventEmitter {
  stdout: PassThrough;
  stderr: PassThrough;
  stdin: PassThrough;
  kill: (signal?: NodeJS.Signals | number) => boolean;
}

function makeFakeChild(): FakeChild {
  const ee = new EventEmitter() as FakeChild;
  ee.stdout = new PassThrough();
  ee.stderr = new PassThrough();
  ee.stdin = new PassThrough();
  ee.kill = vi.fn(() => true);
  return ee;
}

const baseConfig = {
  cwd: '/tmp',
  port: 0,
  sessionId: 'relay-s1',
  hookToken: 't',
  configDir: '/tmp/cfg',
};

describe('ClaudeProtocolAdapterV2 — identity', () => {
  it('reports agentType=claude, runtimeOwnership=spawned', () => {
    const a = new ClaudeProtocolAdapterV2();
    expect(a.agentType).toBe('claude');
    expect(a.runtimeOwnership).toBe('spawned');
  });

  it('declares full Conductor-aligned capability set', () => {
    const a = new ClaudeProtocolAdapterV2();
    expect(a.capabilities).toMatchObject({
      text: true,
      reasoning: true,
      tools: true,
      commandExecution: true,
      fileChanges: true,
      approvals: true,
      questions: false,
      plans: true,
      slashCommands: true,
      queue: false,
      interrupt: true,
      cancelQueued: false,
      resume: true,
      fork: true,
      rollback: false,
      compact: true,
      telemetry: true,
      rateLimits: true,
    });
  });

  it('accepts spawn injection in constructor for testing', () => {
    const fakeSpawn = (() => undefined as unknown as never) as never;
    expect(
      () => new ClaudeProtocolAdapterV2({ spawn: fakeSpawn })
    ).not.toThrow();
  });
});

describe('ClaudeProtocolAdapterV2 — connect lifecycle', () => {
  it('connect spawns claude with Conductor args + relay session id', async () => {
    const fake = makeFakeChild();
    const spawn = vi.fn(() => fake as unknown as ChildProcess);
    const adapter = new ClaudeProtocolAdapterV2({ spawn });
    await adapter.connect(baseConfig);
    expect(spawn).toHaveBeenCalledTimes(1);
    const call = spawn.mock.calls[0] as unknown as [
      string,
      string[],
      { cwd: string; env: Record<string, string>; stdio: unknown[] },
    ];
    const [cmd, args, opts] = call;
    expect(cmd).toBe('claude');
    expect(args).toEqual(
      expect.arrayContaining([
        '--output-format',
        'stream-json',
        '--verbose',
        '--input-format',
        'stream-json',
        '--include-partial-messages',
        '--include-hook-events',
        '--permission-prompt-tool',
        'stdio',
        '--no-session-persistence',
        '--session-id',
        'relay-s1',
      ])
    );
    expect(opts.cwd).toBe('/tmp');
    expect(opts.env).not.toHaveProperty('CLAUDECODE');
    expect(opts.stdio).toEqual(['pipe', 'pipe', 'pipe']);
  });

  it('connect emits idle live state and sets status=connected', async () => {
    const fake = makeFakeChild();
    const adapter = new ClaudeProtocolAdapterV2({
      spawn: vi.fn(() => fake as unknown as ChildProcess),
    });
    const patches: AgentPatchV2[] = [];
    adapter.onPatch((p) => patches.push(p));
    await adapter.connect(baseConfig);
    expect(adapter.status).toBe('connected');
    const live = patches.find((p) => p.type === 'agent-live-state-updated-v2');
    expect(live).toMatchObject({
      sessionId: 'relay-s1',
      live: {
        status: 'idle',
        activeTurnId: null,
        waitingOn: null,
        error: null,
      },
    });
  });

  it('passes optional --model when config.model set', async () => {
    const fake = makeFakeChild();
    const spawn = vi.fn(() => fake as unknown as ChildProcess);
    const adapter = new ClaudeProtocolAdapterV2({ spawn });
    await adapter.connect({ ...baseConfig, model: 'sonnet' });
    const [, args] = spawn.mock.calls[0] as unknown as [
      string,
      string[],
      unknown,
    ];
    expect(args).toEqual(expect.arrayContaining(['--model', 'sonnet']));
  });

  it('passes --permission-mode when config.permissionMode set', async () => {
    const fake = makeFakeChild();
    const spawn = vi.fn(() => fake as unknown as ChildProcess);
    const adapter = new ClaudeProtocolAdapterV2({ spawn });
    await adapter.connect({ ...baseConfig, permissionMode: 'acceptEdits' });
    const [, args] = spawn.mock.calls[0] as unknown as [
      string,
      string[],
      unknown,
    ];
    expect(args).toEqual(
      expect.arrayContaining(['--permission-mode', 'acceptEdits'])
    );
  });

  it('strips CLAUDECODE from spawn env even when set in process.env', async () => {
    const prev = process.env.CLAUDECODE;
    process.env.CLAUDECODE = '1';
    try {
      const fake = makeFakeChild();
      const spawn = vi.fn(() => fake as unknown as ChildProcess);
      const adapter = new ClaudeProtocolAdapterV2({ spawn });
      await adapter.connect(baseConfig);
      const [, , opts] = spawn.mock.calls[0] as unknown as [
        string,
        string[],
        { env: Record<string, string> },
      ];
      expect(opts.env).not.toHaveProperty('CLAUDECODE');
    } finally {
      if (prev === undefined) delete process.env.CLAUDECODE;
      else process.env.CLAUDECODE = prev;
    }
  });

  it('disconnect kills the child process and sets status=disconnected', async () => {
    const fake = makeFakeChild();
    const adapter = new ClaudeProtocolAdapterV2({
      spawn: vi.fn(() => fake as unknown as ChildProcess),
    });
    await adapter.connect(baseConfig);
    await adapter.disconnect();
    expect(fake.kill).toHaveBeenCalled();
    expect(adapter.status).toBe('disconnected');
  });

  it('reconnect cycles disconnect→connect (spawn called twice)', async () => {
    const spawn = vi.fn(() => makeFakeChild() as unknown as ChildProcess);
    const adapter = new ClaudeProtocolAdapterV2({ spawn });
    await adapter.connect(baseConfig);
    await adapter.reconnect();
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it('reconnect before initial connect throws', async () => {
    const adapter = new ClaudeProtocolAdapterV2();
    await expect(adapter.reconnect()).rejects.toThrow(/cannot reconnect/i);
  });
});

describe('ClaudeProtocolAdapterV2 — stream-json buffering', () => {
  it('buffers partial lines until newline', async () => {
    const fake = makeFakeChild();
    const adapter = new ClaudeProtocolAdapterV2({
      spawn: vi.fn(() => fake as unknown as ChildProcess),
    });
    const patches: AgentPatchV2[] = [];
    adapter.onPatch((p) => patches.push(p));
    await adapter.connect(baseConfig);
    (adapter as unknown as { _currentTurnId: string })._currentTurnId =
      'turn-buf';
    const before = patches.length;
    fake.stdout.write('{"type":"unknown-type-A","subt');
    expect(patches.length).toBe(before);
    fake.stdout.write('ype":"x"}\n');
    expect(patches.length).toBeGreaterThan(before);
  });

  it('drops malformed JSON lines without throwing', async () => {
    const fake = makeFakeChild();
    const adapter = new ClaudeProtocolAdapterV2({
      spawn: vi.fn(() => fake as unknown as ChildProcess),
    });
    await adapter.connect(baseConfig);
    expect(() => fake.stdout.write('not-json\n{also bad}\n')).not.toThrow();
  });

  it('routes unknown stream-json types to providerExtension', async () => {
    const fake = makeFakeChild();
    const adapter = new ClaudeProtocolAdapterV2({
      spawn: vi.fn(() => fake as unknown as ChildProcess),
    });
    const patches: AgentPatchV2[] = [];
    adapter.onPatch((p) => patches.push(p));
    await adapter.connect(baseConfig);
    (adapter as unknown as { _currentTurnId: string })._currentTurnId =
      'turn-ext';
    fake.stdout.write(
      JSON.stringify({ type: 'attribution-snapshot', stuff: 1 }) + '\n'
    );
    expect(
      patches.find(
        (p) =>
          p.type === 'agent-item-started-v2' &&
          p.item.type === 'providerExtension'
      )
    ).toMatchObject({
      item: { namespace: 'claude' },
    });
  });

  it('routes events with hook_event_name discriminator to hook handler stub (no patch)', async () => {
    const fake = makeFakeChild();
    const adapter = new ClaudeProtocolAdapterV2({
      spawn: vi.fn(() => fake as unknown as ChildProcess),
    });
    const patches: AgentPatchV2[] = [];
    adapter.onPatch((p) => patches.push(p));
    await adapter.connect(baseConfig);
    (adapter as unknown as { _currentTurnId: string })._currentTurnId =
      'turn-h';
    fake.stdout.write(
      JSON.stringify({
        hook_event_name: 'PreToolUse',
        hook_event_payload: {},
      }) + '\n'
    );
    // Hook handler stub does nothing — no patches emitted by THIS task.
    // (Task 1.8 will fill it in.)
    const hookExt = patches.find(
      (p) =>
        p.type === 'agent-item-started-v2' &&
        p.item.type === 'providerExtension' &&
        (p.item.payload as Record<string, unknown>)['hook_event_name'] ===
          'PreToolUse'
    );
    expect(hookExt).toBeUndefined(); // hook events don't fall through to providerExtension
  });
});

describe('ClaudeProtocolAdapterV2 — system/init', () => {
  it('captures session_id, emits snapshot with providerSession', async () => {
    const fake = makeFakeChild();
    const adapter = new ClaudeProtocolAdapterV2({
      spawn: vi.fn(() => fake as unknown as ChildProcess),
    });
    const patches: AgentPatchV2[] = [];
    adapter.onPatch((p) => patches.push(p));
    await adapter.connect(baseConfig);

    fake.stdout.write(
      JSON.stringify({
        type: 'system',
        subtype: 'init',
        session_id: 'claude-abc-123',
        model: 'claude-opus-4-7',
        tools: ['Bash', 'Edit'],
        cwd: '/proj',
      }) + '\n'
    );

    const snapshot = patches.find(
      (p) => p.type === 'agent-session-snapshot-v2'
    );
    expect(snapshot).toBeDefined();
    expect(
      snapshot && 'session' in snapshot && snapshot.session.providerSession
    ).toMatchObject({
      sessionId: 'claude-abc-123',
      model: 'claude-opus-4-7',
      cwd: '/proj',
    });
    // session.id stays the relay session id, not claude's
    expect(snapshot && 'session' in snapshot && snapshot.session.id).toBe(
      'relay-s1'
    );
  });

  it('exposes captured provider session id via private getter for --resume use', async () => {
    const fake = makeFakeChild();
    const adapter = new ClaudeProtocolAdapterV2({
      spawn: vi.fn(() => fake as unknown as ChildProcess),
    });
    await adapter.connect(baseConfig);
    fake.stdout.write(
      JSON.stringify({
        type: 'system',
        subtype: 'init',
        session_id: 'xyz-789',
      }) + '\n'
    );
    expect(
      (adapter as unknown as { _providerSessionId: string | null })
        ._providerSessionId
    ).toBe('xyz-789');
  });

  it('drops non-string fields from providerSession (e.g. tools array)', async () => {
    const fake = makeFakeChild();
    const adapter = new ClaudeProtocolAdapterV2({
      spawn: vi.fn(() => fake as unknown as ChildProcess),
    });
    const patches: AgentPatchV2[] = [];
    adapter.onPatch((p) => patches.push(p));
    await adapter.connect(baseConfig);
    fake.stdout.write(
      JSON.stringify({
        type: 'system',
        subtype: 'init',
        session_id: 'abc',
        tools: ['Bash', 'Edit'],
      }) + '\n'
    );
    const snapshot = patches.find(
      (p) => p.type === 'agent-session-snapshot-v2'
    );
    expect(
      snapshot && 'session' in snapshot && snapshot.session.providerSession
    ).not.toHaveProperty('tools');
  });

  it('non-init system events fall back to providerExtension', async () => {
    const fake = makeFakeChild();
    const adapter = new ClaudeProtocolAdapterV2({
      spawn: vi.fn(() => fake as unknown as ChildProcess),
    });
    const patches: AgentPatchV2[] = [];
    adapter.onPatch((p) => patches.push(p));
    await adapter.connect(baseConfig);
    (adapter as unknown as { _currentTurnId: string })._currentTurnId =
      'turn-x';
    fake.stdout.write(
      JSON.stringify({ type: 'system', subtype: 'something-else' }) + '\n'
    );
    expect(
      patches.find(
        (p) =>
          p.type === 'agent-item-started-v2' &&
          p.item.type === 'providerExtension'
      )
    ).toBeDefined();
  });
});

describe('ClaudeProtocolAdapterV2 — assistant content blocks (final state)', () => {
  function feed(
    adapter: ClaudeProtocolAdapterV2,
    fake: FakeChild,
    content: Array<Record<string, unknown>>
  ): void {
    fake.stdout.write(
      JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content },
      }) + '\n'
    );
  }

  it('text block emits assistantMessage started + updated with msg- prefix', async () => {
    const fake = makeFakeChild();
    const adapter = new ClaudeProtocolAdapterV2({
      spawn: vi.fn(() => fake as unknown as ChildProcess),
    });
    const patches: AgentPatchV2[] = [];
    adapter.onPatch((p) => patches.push(p));
    await adapter.connect(baseConfig);
    (adapter as unknown as { _currentTurnId: string })._currentTurnId =
      'turn-T';

    feed(adapter, fake, [{ type: 'text', text: 'hi there' }]);

    const started = patches.find(
      (p) =>
        p.type === 'agent-item-started-v2' && p.item.type === 'assistantMessage'
    );
    expect(started).toMatchObject({
      turnId: 'turn-T',
      item: {
        id: 'msg-turn-T-0',
        text: '',
        phase: 'answer',
        status: 'running',
      },
    });
    const updated = patches.find(
      (p) =>
        p.type === 'agent-item-updated-v2' && p.item.type === 'assistantMessage'
    );
    expect(updated).toMatchObject({
      item: {
        id: 'msg-turn-T-0',
        text: 'hi there',
        phase: 'answer',
        status: 'completed',
      },
    });
  });

  it('thinking block emits reasoning started + updated with thinking- prefix', async () => {
    const fake = makeFakeChild();
    const adapter = new ClaudeProtocolAdapterV2({
      spawn: vi.fn(() => fake as unknown as ChildProcess),
    });
    const patches: AgentPatchV2[] = [];
    adapter.onPatch((p) => patches.push(p));
    await adapter.connect(baseConfig);
    (adapter as unknown as { _currentTurnId: string })._currentTurnId =
      'turn-T';

    feed(adapter, fake, [{ type: 'thinking', thinking: 'reasoning here' }]);

    const updated = patches.find(
      (p) => p.type === 'agent-item-updated-v2' && p.item.type === 'reasoning'
    );
    expect(updated).toMatchObject({
      item: {
        id: 'thinking-turn-T-0',
        summary: 'reasoning here',
        visibility: 'summary',
        status: 'completed',
      },
    });
  });

  it('tool_use Bash → commandExecution started with exec- prefix', async () => {
    const fake = makeFakeChild();
    const adapter = new ClaudeProtocolAdapterV2({
      spawn: vi.fn(() => fake as unknown as ChildProcess),
    });
    const patches: AgentPatchV2[] = [];
    adapter.onPatch((p) => patches.push(p));
    await adapter.connect(baseConfig);
    (adapter as unknown as { _currentTurnId: string })._currentTurnId =
      'turn-T';

    feed(adapter, fake, [
      {
        type: 'tool_use',
        id: 'tu_b1',
        name: 'Bash',
        input: { command: 'ls -la' },
      },
    ]);

    const started = patches.find(
      (p) =>
        p.type === 'agent-item-started-v2' && p.item.type === 'commandExecution'
    );
    expect(started).toMatchObject({
      item: {
        id: 'exec-tu_b1',
        command: 'ls -la',
        output: '',
        status: 'running',
      },
    });
  });

  it('tool_use Edit/Write/MultiEdit → fileChange started with file- prefix', async () => {
    const fake = makeFakeChild();
    const adapter = new ClaudeProtocolAdapterV2({
      spawn: vi.fn(() => fake as unknown as ChildProcess),
    });
    const patches: AgentPatchV2[] = [];
    adapter.onPatch((p) => patches.push(p));
    await adapter.connect(baseConfig);
    (adapter as unknown as { _currentTurnId: string })._currentTurnId =
      'turn-T';

    feed(adapter, fake, [
      {
        type: 'tool_use',
        id: 'tu_e1',
        name: 'Edit',
        input: { file_path: 'src/foo.ts' },
      },
    ]);

    const started = patches.find(
      (p) => p.type === 'agent-item-started-v2' && p.item.type === 'fileChange'
    );
    expect(started).toMatchObject({
      item: {
        id: 'file-tu_e1',
        paths: [{ path: 'src/foo.ts' }],
        applyStatus: 'pending',
      },
    });
  });

  it('tool_use other → dynamicToolCall started with tool- prefix', async () => {
    const fake = makeFakeChild();
    const adapter = new ClaudeProtocolAdapterV2({
      spawn: vi.fn(() => fake as unknown as ChildProcess),
    });
    const patches: AgentPatchV2[] = [];
    adapter.onPatch((p) => patches.push(p));
    await adapter.connect(baseConfig);
    (adapter as unknown as { _currentTurnId: string })._currentTurnId =
      'turn-T';

    feed(adapter, fake, [
      {
        type: 'tool_use',
        id: 'tu_r1',
        name: 'Read',
        input: { file_path: 'a.txt' },
      },
    ]);

    const started = patches.find(
      (p) =>
        p.type === 'agent-item-started-v2' && p.item.type === 'dynamicToolCall'
    );
    expect(started).toMatchObject({
      item: {
        id: 'tool-tu_r1',
        namespace: 'claude',
        tool: 'Read',
        arguments: { file_path: 'a.txt' },
        status: 'running',
      },
    });
  });

  it('tool_use registers entry in toolUseRegistry for later tool_result lookup', async () => {
    const fake = makeFakeChild();
    const adapter = new ClaudeProtocolAdapterV2({
      spawn: vi.fn(() => fake as unknown as ChildProcess),
    });
    await adapter.connect(baseConfig);
    (adapter as unknown as { _currentTurnId: string })._currentTurnId =
      'turn-T';

    fake.stdout.write(
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'tu_x',
              name: 'Bash',
              input: { command: 'pwd' },
            },
          ],
        },
      }) + '\n'
    );

    const registry = (
      adapter as unknown as {
        toolUseRegistry: Map<
          string,
          { itemId: string; discriminator: string; name: string }
        >;
      }
    ).toolUseRegistry;
    expect(registry.get('tu_x')).toMatchObject({
      itemId: 'exec-tu_x',
      discriminator: 'commandExecution',
      name: 'Bash',
    });
  });

  it('multiple text blocks get incrementing block indices', async () => {
    const fake = makeFakeChild();
    const adapter = new ClaudeProtocolAdapterV2({
      spawn: vi.fn(() => fake as unknown as ChildProcess),
    });
    const patches: AgentPatchV2[] = [];
    adapter.onPatch((p) => patches.push(p));
    await adapter.connect(baseConfig);
    (adapter as unknown as { _currentTurnId: string })._currentTurnId =
      'turn-A';

    feed(adapter, fake, [
      { type: 'text', text: 'first' },
      { type: 'text', text: 'second' },
    ]);

    const ids = patches
      .filter(
        (p) =>
          p.type === 'agent-item-started-v2' &&
          p.item.type === 'assistantMessage'
      )
      .map((p) => (p as { item: { id: string } }).item.id);
    expect(ids).toEqual(['msg-turn-A-0', 'msg-turn-A-1']);
  });

  it('no-op when _currentTurnId is null', async () => {
    const fake = makeFakeChild();
    const adapter = new ClaudeProtocolAdapterV2({
      spawn: vi.fn(() => fake as unknown as ChildProcess),
    });
    const patches: AgentPatchV2[] = [];
    adapter.onPatch((p) => patches.push(p));
    await adapter.connect(baseConfig);
    const before = patches.length;
    feed(adapter, fake, [{ type: 'text', text: 'orphan' }]);
    expect(patches.length).toBe(before);
  });
});

describe('ClaudeProtocolAdapterV2 — stream_event partial messages', () => {
  function streamEvent(event: Record<string, unknown>): string {
    return JSON.stringify({ type: 'stream_event', event }) + '\n';
  }

  it('content_block_start text → assistantMessage item-started with msg- prefix using event.index', async () => {
    const fake = makeFakeChild();
    const adapter = new ClaudeProtocolAdapterV2({
      spawn: vi.fn(() => fake as unknown as ChildProcess),
    });
    const patches: AgentPatchV2[] = [];
    adapter.onPatch((p) => patches.push(p));
    await adapter.connect(baseConfig);
    (adapter as unknown as { _currentTurnId: string })._currentTurnId =
      'turn-S';

    fake.stdout.write(
      streamEvent({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      })
    );

    const started = patches.find(
      (p) =>
        p.type === 'agent-item-started-v2' && p.item.type === 'assistantMessage'
    );
    expect(started).toMatchObject({
      item: {
        id: 'msg-turn-S-0',
        text: '',
        phase: 'answer',
        status: 'running',
      },
    });
  });

  it('content_block_delta text_delta → item-delta with text field', async () => {
    const fake = makeFakeChild();
    const adapter = new ClaudeProtocolAdapterV2({
      spawn: vi.fn(() => fake as unknown as ChildProcess),
    });
    const patches: AgentPatchV2[] = [];
    adapter.onPatch((p) => patches.push(p));
    await adapter.connect(baseConfig);
    (adapter as unknown as { _currentTurnId: string })._currentTurnId =
      'turn-S';

    fake.stdout.write(
      streamEvent({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      })
    );
    fake.stdout.write(
      streamEvent({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'hel' },
      })
    );
    fake.stdout.write(
      streamEvent({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'lo' },
      })
    );

    const deltas = patches.filter((p) => p.type === 'agent-item-delta-v2');
    expect(deltas).toHaveLength(2);
    expect(deltas[0]).toMatchObject({
      itemId: 'msg-turn-S-0',
      delta: { text: 'hel' },
    });
    expect(deltas[1]).toMatchObject({
      itemId: 'msg-turn-S-0',
      delta: { text: 'lo' },
    });
  });

  it('content_block_start thinking + thinking_delta → reasoning with summary delta', async () => {
    const fake = makeFakeChild();
    const adapter = new ClaudeProtocolAdapterV2({
      spawn: vi.fn(() => fake as unknown as ChildProcess),
    });
    const patches: AgentPatchV2[] = [];
    adapter.onPatch((p) => patches.push(p));
    await adapter.connect(baseConfig);
    (adapter as unknown as { _currentTurnId: string })._currentTurnId =
      'turn-S';

    fake.stdout.write(
      streamEvent({
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'thinking', thinking: '' },
      })
    );
    fake.stdout.write(
      streamEvent({
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'thinking_delta', thinking: 'pondering' },
      })
    );

    const started = patches.find(
      (p) => p.type === 'agent-item-started-v2' && p.item.type === 'reasoning'
    );
    expect(started).toMatchObject({
      item: { id: 'thinking-turn-S-1', visibility: 'summary' },
    });
    const delta = patches.find((p) => p.type === 'agent-item-delta-v2');
    expect(delta).toMatchObject({
      itemId: 'thinking-turn-S-1',
      delta: { summary: 'pondering' },
    });
  });

  it('content_block_start tool_use → started + populates toolUseRegistry', async () => {
    const fake = makeFakeChild();
    const adapter = new ClaudeProtocolAdapterV2({
      spawn: vi.fn(() => fake as unknown as ChildProcess),
    });
    const patches: AgentPatchV2[] = [];
    adapter.onPatch((p) => patches.push(p));
    await adapter.connect(baseConfig);
    (adapter as unknown as { _currentTurnId: string })._currentTurnId =
      'turn-S';

    fake.stdout.write(
      streamEvent({
        type: 'content_block_start',
        index: 2,
        content_block: {
          type: 'tool_use',
          id: 'tu_stream',
          name: 'Bash',
          input: {},
        },
      })
    );

    const started = patches.find(
      (p) =>
        p.type === 'agent-item-started-v2' && p.item.type === 'commandExecution'
    );
    expect(started).toMatchObject({
      item: { id: 'exec-tu_stream', status: 'running' },
    });
    const registry = (
      adapter as unknown as { toolUseRegistry: Map<string, { itemId: string }> }
    ).toolUseRegistry;
    expect(registry.get('tu_stream')?.itemId).toBe('exec-tu_stream');
  });

  it('content_block_delta input_json_delta on tool_use → delta with content field', async () => {
    const fake = makeFakeChild();
    const adapter = new ClaudeProtocolAdapterV2({
      spawn: vi.fn(() => fake as unknown as ChildProcess),
    });
    const patches: AgentPatchV2[] = [];
    adapter.onPatch((p) => patches.push(p));
    await adapter.connect(baseConfig);
    (adapter as unknown as { _currentTurnId: string })._currentTurnId =
      'turn-S';

    fake.stdout.write(
      streamEvent({
        type: 'content_block_start',
        index: 0,
        content_block: {
          type: 'tool_use',
          id: 'tu_x',
          name: 'Read',
          input: {},
        },
      })
    );
    fake.stdout.write(
      streamEvent({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"file_path":"' },
      })
    );

    const delta = patches.find((p) => p.type === 'agent-item-delta-v2');
    expect(delta).toMatchObject({
      itemId: 'tool-tu_x',
      delta: { content: '{"file_path":"' },
    });
  });

  it('content_block_stop emits item-updated marking running item completed', async () => {
    const fake = makeFakeChild();
    const adapter = new ClaudeProtocolAdapterV2({
      spawn: vi.fn(() => fake as unknown as ChildProcess),
    });
    const patches: AgentPatchV2[] = [];
    adapter.onPatch((p) => patches.push(p));
    await adapter.connect(baseConfig);
    (adapter as unknown as { _currentTurnId: string })._currentTurnId =
      'turn-S';

    fake.stdout.write(
      streamEvent({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      })
    );
    fake.stdout.write(
      streamEvent({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'hi' },
      })
    );
    fake.stdout.write(streamEvent({ type: 'content_block_stop', index: 0 }));

    const updated = patches.find(
      (p) =>
        p.type === 'agent-item-updated-v2' && p.item.type === 'assistantMessage'
    );
    expect(updated).toMatchObject({
      item: { id: 'msg-turn-S-0', status: 'completed' },
    });
  });

  it('message_delta caches usage on adapter for later turn-completed', async () => {
    const fake = makeFakeChild();
    const adapter = new ClaudeProtocolAdapterV2({
      spawn: vi.fn(() => fake as unknown as ChildProcess),
    });
    await adapter.connect(baseConfig);
    (adapter as unknown as { _currentTurnId: string })._currentTurnId =
      'turn-S';

    fake.stdout.write(
      streamEvent({
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_read_input_tokens: 20,
        },
      })
    );

    const cached = (
      adapter as unknown as {
        pendingMessageDelta: {
          usage?: Record<string, number>;
          stopReason?: string;
        };
      }
    ).pendingMessageDelta;
    expect(cached.usage).toMatchObject({
      input_tokens: 100,
      output_tokens: 50,
      cache_read_input_tokens: 20,
    });
    expect(cached.stopReason).toBe('end_turn');
  });

  it('no-op when _currentTurnId is null', async () => {
    const fake = makeFakeChild();
    const adapter = new ClaudeProtocolAdapterV2({
      spawn: vi.fn(() => fake as unknown as ChildProcess),
    });
    const patches: AgentPatchV2[] = [];
    adapter.onPatch((p) => patches.push(p));
    await adapter.connect(baseConfig);
    const before = patches.length;
    fake.stdout.write(
      streamEvent({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      })
    );
    expect(patches.length).toBe(before);
  });

  it('content_block_delta against unknown index is silently ignored', async () => {
    const fake = makeFakeChild();
    const adapter = new ClaudeProtocolAdapterV2({
      spawn: vi.fn(() => fake as unknown as ChildProcess),
    });
    const patches: AgentPatchV2[] = [];
    adapter.onPatch((p) => patches.push(p));
    await adapter.connect(baseConfig);
    (adapter as unknown as { _currentTurnId: string })._currentTurnId =
      'turn-S';
    fake.stdout.write(
      streamEvent({
        type: 'content_block_delta',
        index: 99,
        delta: { type: 'text_delta', text: 'orphan' },
      })
    );
    expect(
      patches.find((p) => p.type === 'agent-item-delta-v2')
    ).toBeUndefined();
  });
});

describe('ClaudeProtocolAdapterV2 — tool_result blocks', () => {
  function feed(
    adapter: ClaudeProtocolAdapterV2,
    fake: FakeChild,
    line: string
  ): void {
    fake.stdout.write(line + '\n');
  }
  function toolUseLine(
    name: string,
    id: string,
    input: Record<string, unknown>
  ): string {
    return JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id, name, input }],
      },
    });
  }
  function toolResultLine(
    toolUseId: string,
    content: unknown,
    isError = false
  ): string {
    return JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: toolUseId,
            content,
            is_error: isError,
          },
        ],
      },
    });
  }

  it('Bash tool_result → output delta + commandExecution completed', async () => {
    const fake = makeFakeChild();
    const adapter = new ClaudeProtocolAdapterV2({
      spawn: vi.fn(() => fake as unknown as ChildProcess),
    });
    const patches: AgentPatchV2[] = [];
    adapter.onPatch((p) => patches.push(p));
    await adapter.connect(baseConfig);
    (adapter as unknown as { _currentTurnId: string })._currentTurnId =
      'turn-X';

    feed(adapter, fake, toolUseLine('Bash', 'tu_b1', { command: 'pwd' }));
    feed(adapter, fake, toolResultLine('tu_b1', '/tmp/proj'));

    const delta = patches.find(
      (p) =>
        p.type === 'agent-item-delta-v2' &&
        (p as { itemId: string }).itemId === 'exec-tu_b1'
    );
    expect(delta).toMatchObject({ delta: { output: '/tmp/proj' } });
    const updated = patches.find(
      (p) =>
        p.type === 'agent-item-updated-v2' &&
        p.item.type === 'commandExecution' &&
        p.item.id === 'exec-tu_b1'
    );
    expect(updated).toMatchObject({
      item: { command: 'pwd', output: '/tmp/proj', status: 'completed' },
    });
  });

  it('Edit tool_result is_error → fileChange failed/applyStatus failed', async () => {
    const fake = makeFakeChild();
    const adapter = new ClaudeProtocolAdapterV2({
      spawn: vi.fn(() => fake as unknown as ChildProcess),
    });
    const patches: AgentPatchV2[] = [];
    adapter.onPatch((p) => patches.push(p));
    await adapter.connect(baseConfig);
    (adapter as unknown as { _currentTurnId: string })._currentTurnId =
      'turn-X';

    feed(
      adapter,
      fake,
      toolUseLine('Edit', 'tu_e1', {
        file_path: 'src/foo.ts',
        old_string: 'a',
        new_string: 'b',
      })
    );
    feed(
      adapter,
      fake,
      toolResultLine('tu_e1', 'String not found in file', true)
    );

    const updated = patches.find(
      (p) => p.type === 'agent-item-updated-v2' && p.item.type === 'fileChange'
    );
    expect(updated).toMatchObject({
      item: { id: 'file-tu_e1', applyStatus: 'failed', status: 'failed' },
    });
  });

  it('generic tool_result → dynamicToolCall completed with result', async () => {
    const fake = makeFakeChild();
    const adapter = new ClaudeProtocolAdapterV2({
      spawn: vi.fn(() => fake as unknown as ChildProcess),
    });
    const patches: AgentPatchV2[] = [];
    adapter.onPatch((p) => patches.push(p));
    await adapter.connect(baseConfig);
    (adapter as unknown as { _currentTurnId: string })._currentTurnId =
      'turn-X';

    feed(adapter, fake, toolUseLine('Read', 'tu_r1', { file_path: 'a.txt' }));
    feed(adapter, fake, toolResultLine('tu_r1', 'file contents'));

    const updated = patches.find(
      (p) =>
        p.type === 'agent-item-updated-v2' && p.item.type === 'dynamicToolCall'
    );
    expect(updated).toMatchObject({
      item: {
        id: 'tool-tu_r1',
        tool: 'Read',
        result: 'file contents',
        status: 'completed',
      },
    });
  });

  it('tool_result content as array of {text} blocks → joined string', async () => {
    const fake = makeFakeChild();
    const adapter = new ClaudeProtocolAdapterV2({
      spawn: vi.fn(() => fake as unknown as ChildProcess),
    });
    const patches: AgentPatchV2[] = [];
    adapter.onPatch((p) => patches.push(p));
    await adapter.connect(baseConfig);
    (adapter as unknown as { _currentTurnId: string })._currentTurnId =
      'turn-X';

    feed(adapter, fake, toolUseLine('Bash', 'tu_arr', { command: 'echo hi' }));
    feed(
      adapter,
      fake,
      toolResultLine('tu_arr', [
        { type: 'text', text: 'part1' },
        { type: 'text', text: 'part2' },
      ])
    );

    const updated = patches.find(
      (p) =>
        p.type === 'agent-item-updated-v2' && p.item.type === 'commandExecution'
    );
    expect(updated).toMatchObject({ item: { output: 'part1part2' } });
  });

  it('tool_result with unknown tool_use_id is silently ignored', async () => {
    const fake = makeFakeChild();
    const adapter = new ClaudeProtocolAdapterV2({
      spawn: vi.fn(() => fake as unknown as ChildProcess),
    });
    const patches: AgentPatchV2[] = [];
    adapter.onPatch((p) => patches.push(p));
    await adapter.connect(baseConfig);
    (adapter as unknown as { _currentTurnId: string })._currentTurnId =
      'turn-X';

    feed(adapter, fake, toolResultLine('tu_unknown', 'whatever'));
    expect(
      patches.find((p) => p.type === 'agent-item-delta-v2')
    ).toBeUndefined();
    expect(
      patches.find(
        (p) =>
          p.type === 'agent-item-updated-v2' &&
          p.item.type !== 'providerExtension'
      )
    ).toBeUndefined();
  });

  it('no-op when _currentTurnId is null', async () => {
    const fake = makeFakeChild();
    const adapter = new ClaudeProtocolAdapterV2({
      spawn: vi.fn(() => fake as unknown as ChildProcess),
    });
    const patches: AgentPatchV2[] = [];
    adapter.onPatch((p) => patches.push(p));
    await adapter.connect(baseConfig);
    feed(adapter, fake, toolResultLine('tu_x', 'data'));
    expect(
      patches.find((p) => p.type === 'agent-item-delta-v2')
    ).toBeUndefined();
  });
});

describe('ClaudeProtocolAdapterV2 — hook events embedded in stream', () => {
  function hookLine(
    eventName: string,
    payload: Record<string, unknown>
  ): string {
    return (
      JSON.stringify({
        hook_event_name: eventName,
        hook_event_payload: payload,
      }) + '\n'
    );
  }

  it('PreToolUse for new tool emits started; for tool already registered → no-op', async () => {
    const fake = makeFakeChild();
    const adapter = new ClaudeProtocolAdapterV2({
      spawn: vi.fn(() => fake as unknown as ChildProcess),
    });
    const patches: AgentPatchV2[] = [];
    adapter.onPatch((p) => patches.push(p));
    await adapter.connect(baseConfig);
    (adapter as unknown as { _currentTurnId: string })._currentTurnId =
      'turn-H';

    // Case A: tool seen via assistant block FIRST, then PreToolUse hook is dedup'd.
    fake.stdout.write(
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'tu_dup',
              name: 'Bash',
              input: { command: 'ls' },
            },
          ],
        },
      }) + '\n'
    );
    const before = patches.filter(
      (p) =>
        p.type === 'agent-item-started-v2' && p.item.type === 'commandExecution'
    ).length;
    fake.stdout.write(
      hookLine('PreToolUse', {
        tool_name: 'Bash',
        tool_use_id: 'tu_dup',
        tool_input: { command: 'ls' },
      })
    );
    const after = patches.filter(
      (p) =>
        p.type === 'agent-item-started-v2' && p.item.type === 'commandExecution'
    ).length;
    expect(after).toBe(before); // no new started

    // Case B: PreToolUse for tool NOT in registry emits new started.
    fake.stdout.write(
      hookLine('PreToolUse', {
        tool_name: 'Bash',
        tool_use_id: 'tu_new',
        tool_input: { command: 'pwd' },
      })
    );
    const cmdItems = patches.filter(
      (p) =>
        p.type === 'agent-item-started-v2' && p.item.type === 'commandExecution'
    );
    expect(cmdItems.find((p) => p.item.id === 'exec-tu_new')).toBeDefined();
  });

  it('PostToolUse Bash → commandExecution updated with output + exit_code + duration', async () => {
    const fake = makeFakeChild();
    const adapter = new ClaudeProtocolAdapterV2({
      spawn: vi.fn(() => fake as unknown as ChildProcess),
    });
    const patches: AgentPatchV2[] = [];
    adapter.onPatch((p) => patches.push(p));
    await adapter.connect(baseConfig);
    (adapter as unknown as { _currentTurnId: string })._currentTurnId =
      'turn-H';

    fake.stdout.write(
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'tu_p',
              name: 'Bash',
              input: { command: 'date' },
            },
          ],
        },
      }) + '\n'
    );

    fake.stdout.write(
      hookLine('PostToolUse', {
        tool_name: 'Bash',
        tool_use_id: 'tu_p',
        output: 'Sat Apr 26 10:00:00',
        exit_code: 0,
        duration_ms: 25,
      })
    );

    const updated = patches.find(
      (p) =>
        p.type === 'agent-item-updated-v2' &&
        p.item.type === 'commandExecution' &&
        p.item.id === 'exec-tu_p'
    );
    expect(updated).toMatchObject({
      item: {
        command: 'date',
        output: 'Sat Apr 26 10:00:00',
        exitCode: 0,
        durationMs: 25,
        status: 'completed',
      },
    });
  });

  it('PostToolUse with error → fileChange failed', async () => {
    const fake = makeFakeChild();
    const adapter = new ClaudeProtocolAdapterV2({
      spawn: vi.fn(() => fake as unknown as ChildProcess),
    });
    const patches: AgentPatchV2[] = [];
    adapter.onPatch((p) => patches.push(p));
    await adapter.connect(baseConfig);
    (adapter as unknown as { _currentTurnId: string })._currentTurnId =
      'turn-H';

    fake.stdout.write(
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'tu_ed',
              name: 'Edit',
              input: { file_path: 'src/x.ts' },
            },
          ],
        },
      }) + '\n'
    );

    fake.stdout.write(
      hookLine('PostToolUse', {
        tool_name: 'Edit',
        tool_use_id: 'tu_ed',
        error: 'String not found',
      })
    );

    const updated = patches.find(
      (p) =>
        p.type === 'agent-item-updated-v2' &&
        p.item.type === 'fileChange' &&
        p.item.id === 'file-tu_ed'
    );
    expect(updated).toMatchObject({
      item: { applyStatus: 'failed', status: 'failed' },
    });
  });

  it('PostToolUse for EnterPlanMode → plan item started with proposed plan', async () => {
    const fake = makeFakeChild();
    const adapter = new ClaudeProtocolAdapterV2({
      spawn: vi.fn(() => fake as unknown as ChildProcess),
    });
    const patches: AgentPatchV2[] = [];
    adapter.onPatch((p) => patches.push(p));
    await adapter.connect(baseConfig);
    (adapter as unknown as { _currentTurnId: string })._currentTurnId =
      'turn-H';

    fake.stdout.write(
      hookLine('PostToolUse', {
        tool_name: 'EnterPlanMode',
        plan: 'Step 1: do X\nStep 2: do Y',
      })
    );

    const planItem = patches.find(
      (p) => p.type === 'agent-item-started-v2' && p.item.type === 'plan'
    );
    expect(planItem).toMatchObject({
      item: { text: 'Step 1: do X\nStep 2: do Y', approvalState: 'pending' },
    });
  });

  it('Notification permission_prompt → approval item + waiting live state', async () => {
    const fake = makeFakeChild();
    const adapter = new ClaudeProtocolAdapterV2({
      spawn: vi.fn(() => fake as unknown as ChildProcess),
    });
    const patches: AgentPatchV2[] = [];
    adapter.onPatch((p) => patches.push(p));
    await adapter.connect(baseConfig);
    (adapter as unknown as { _currentTurnId: string })._currentTurnId =
      'turn-H';

    fake.stdout.write(
      hookLine('Notification', {
        type: 'permission_prompt',
        request_id: 'req-abc',
        description: 'Allow Bash command?',
        target: 'rm -rf /',
      })
    );

    const approval = patches.find(
      (p) => p.type === 'agent-item-started-v2' && p.item.type === 'approval'
    );
    expect(approval).toMatchObject({
      item: {
        id: 'approval-req-abc',
        requestId: 'req-abc',
        kind: 'permission',
        target: 'rm -rf /',
      },
    });
    const live = [...patches]
      .reverse()
      .find((p) => p.type === 'agent-live-state-updated-v2');
    expect(live).toMatchObject({
      live: { status: 'waiting', waitingOn: 'approval' },
    });
  });

  it('Stop hook emits idle live state', async () => {
    const fake = makeFakeChild();
    const adapter = new ClaudeProtocolAdapterV2({
      spawn: vi.fn(() => fake as unknown as ChildProcess),
    });
    const patches: AgentPatchV2[] = [];
    adapter.onPatch((p) => patches.push(p));
    await adapter.connect(baseConfig);
    (adapter as unknown as { _currentTurnId: string })._currentTurnId =
      'turn-H';

    fake.stdout.write(hookLine('Stop', {}));

    const lives = patches.filter(
      (p) => p.type === 'agent-live-state-updated-v2'
    );
    expect(lives[lives.length - 1]).toMatchObject({ live: { status: 'idle' } });
  });

  it('unknown hook event → providerExtension', async () => {
    const fake = makeFakeChild();
    const adapter = new ClaudeProtocolAdapterV2({
      spawn: vi.fn(() => fake as unknown as ChildProcess),
    });
    const patches: AgentPatchV2[] = [];
    adapter.onPatch((p) => patches.push(p));
    await adapter.connect(baseConfig);
    (adapter as unknown as { _currentTurnId: string })._currentTurnId =
      'turn-H';

    fake.stdout.write(hookLine('SubagentStop', { foo: 'bar' }));

    const ext = patches.find(
      (p) =>
        p.type === 'agent-item-started-v2' &&
        p.item.type === 'providerExtension'
    );
    expect(ext).toBeDefined();
  });

  it('hook event no-ops when _currentTurnId is null', async () => {
    const fake = makeFakeChild();
    const adapter = new ClaudeProtocolAdapterV2({
      spawn: vi.fn(() => fake as unknown as ChildProcess),
    });
    const patches: AgentPatchV2[] = [];
    adapter.onPatch((p) => patches.push(p));
    await adapter.connect(baseConfig);
    const before = patches.length;
    fake.stdout.write(
      hookLine('PreToolUse', { tool_name: 'Bash', tool_use_id: 'tu_orphan' })
    );
    expect(patches.length).toBe(before);
  });
});

describe('ClaudeProtocolAdapterV2 — control_request from claude', () => {
  function controlReqLine(
    requestId: string,
    request: Record<string, unknown>
  ): string {
    return (
      JSON.stringify({
        type: 'control_request',
        request_id: requestId,
        request,
      }) + '\n'
    );
  }

  it('can_use_tool emits approval item with kind=permission + waiting live state', async () => {
    const fake = makeFakeChild();
    const adapter = new ClaudeProtocolAdapterV2({
      spawn: vi.fn(() => fake as unknown as ChildProcess),
    });
    const patches: AgentPatchV2[] = [];
    adapter.onPatch((p) => patches.push(p));
    await adapter.connect(baseConfig);
    (adapter as unknown as { _currentTurnId: string })._currentTurnId =
      'turn-C';

    fake.stdout.write(
      controlReqLine('req-xyz', {
        subtype: 'can_use_tool',
        tool_use_id: 'tu_a1',
        tool_name: 'Bash',
        tool_input: { command: 'rm -rf /' },
      })
    );

    const approval = patches.find(
      (p) => p.type === 'agent-item-started-v2' && p.item.type === 'approval'
    );
    expect(approval).toMatchObject({
      item: {
        id: 'approval-req-xyz',
        requestId: 'req-xyz',
        kind: 'permission',
        description: 'Bash',
        status: 'pending',
      },
    });
    const live = [...patches]
      .reverse()
      .find((p) => p.type === 'agent-live-state-updated-v2');
    expect(live).toMatchObject({
      live: {
        status: 'waiting',
        waitingOn: 'approval',
        activeRequestIds: ['req-xyz'],
      },
    });
  });

  it('approval target is truncated tool_input JSON', async () => {
    const fake = makeFakeChild();
    const adapter = new ClaudeProtocolAdapterV2({
      spawn: vi.fn(() => fake as unknown as ChildProcess),
    });
    const patches: AgentPatchV2[] = [];
    adapter.onPatch((p) => patches.push(p));
    await adapter.connect(baseConfig);
    (adapter as unknown as { _currentTurnId: string })._currentTurnId =
      'turn-C';

    const longInput = { command: 'a'.repeat(500) };
    fake.stdout.write(
      controlReqLine('req-long', {
        subtype: 'can_use_tool',
        tool_use_id: 'tu_l',
        tool_name: 'Bash',
        tool_input: longInput,
      })
    );

    const approval = patches.find(
      (p) => p.type === 'agent-item-started-v2' && p.item.type === 'approval'
    );
    expect(approval).toMatchObject({ item: { id: 'approval-req-long' } });
    const target = (approval as { item: { target: string } }).item.target;
    expect(target.length).toBeLessThanOrEqual(200);
    expect(target.startsWith('{"command":"aaaa')).toBe(true);
  });

  it('pendingApprovals map populated for round-trip lookup', async () => {
    const fake = makeFakeChild();
    const adapter = new ClaudeProtocolAdapterV2({
      spawn: vi.fn(() => fake as unknown as ChildProcess),
    });
    await adapter.connect(baseConfig);
    (adapter as unknown as { _currentTurnId: string })._currentTurnId =
      'turn-C';

    fake.stdout.write(
      controlReqLine('req-track', {
        subtype: 'can_use_tool',
        tool_use_id: 'tu_t',
        tool_name: 'Edit',
        tool_input: { file_path: 'src/x.ts' },
      })
    );

    const map = (
      adapter as unknown as {
        pendingApprovals: Map<string, { claudeRequestId: string }>;
      }
    ).pendingApprovals;
    expect(map.get('req-track')).toMatchObject({
      claudeRequestId: 'req-track',
    });
  });

  it('hook_callback subtype falls through to providerExtension', async () => {
    const fake = makeFakeChild();
    const adapter = new ClaudeProtocolAdapterV2({
      spawn: vi.fn(() => fake as unknown as ChildProcess),
    });
    const patches: AgentPatchV2[] = [];
    adapter.onPatch((p) => patches.push(p));
    await adapter.connect(baseConfig);
    (adapter as unknown as { _currentTurnId: string })._currentTurnId =
      'turn-C';

    fake.stdout.write(
      controlReqLine('req-h', {
        subtype: 'hook_callback',
        hook_event_name: 'SessionStart',
      })
    );

    expect(
      patches.find(
        (p) =>
          p.type === 'agent-item-started-v2' &&
          p.item.type === 'providerExtension'
      )
    ).toBeDefined();
  });

  it('unknown subtype → providerExtension', async () => {
    const fake = makeFakeChild();
    const adapter = new ClaudeProtocolAdapterV2({
      spawn: vi.fn(() => fake as unknown as ChildProcess),
    });
    const patches: AgentPatchV2[] = [];
    adapter.onPatch((p) => patches.push(p));
    await adapter.connect(baseConfig);
    (adapter as unknown as { _currentTurnId: string })._currentTurnId =
      'turn-C';

    fake.stdout.write(controlReqLine('req-u', { subtype: 'unknown_subtype' }));
    expect(
      patches.find(
        (p) =>
          p.type === 'agent-item-started-v2' &&
          p.item.type === 'providerExtension'
      )
    ).toBeDefined();
  });

  it('control_request no-ops when _currentTurnId is null', async () => {
    const fake = makeFakeChild();
    const adapter = new ClaudeProtocolAdapterV2({
      spawn: vi.fn(() => fake as unknown as ChildProcess),
    });
    const patches: AgentPatchV2[] = [];
    adapter.onPatch((p) => patches.push(p));
    await adapter.connect(baseConfig);
    const before = patches.length;
    fake.stdout.write(
      controlReqLine('req-orphan', {
        subtype: 'can_use_tool',
        tool_use_id: 'x',
        tool_name: 'Bash',
        tool_input: {},
      })
    );
    expect(patches.length).toBe(before);
  });
});

function captureStdin(fake: FakeChild): string[] {
  const writes: string[] = [];
  const origWrite = fake.stdin.write.bind(fake.stdin);
  // typed `as never` to satisfy overload variants
  fake.stdin.write = ((chunk: unknown) => {
    writes.push(
      typeof chunk === 'string'
        ? chunk
        : Buffer.from(chunk as Buffer).toString('utf8')
    );
    return origWrite(chunk as never);
  }) as never;
  return writes;
}

describe('ClaudeProtocolAdapterV2 — sendMessage', () => {
  it('throws if not connected', async () => {
    const adapter = new ClaudeProtocolAdapterV2();
    await expect(
      adapter.sendMessage({ turnId: 't', content: 'hi' })
    ).rejects.toThrow();
  });

  it('emits turn-started + userMessage + working live state', async () => {
    const fake = makeFakeChild();
    const adapter = new ClaudeProtocolAdapterV2({
      spawn: vi.fn(() => fake as unknown as ChildProcess),
    });
    const patches: AgentPatchV2[] = [];
    adapter.onPatch((p) => patches.push(p));
    await adapter.connect(baseConfig);
    await adapter.sendMessage({ turnId: 'turn-X', content: 'hello' });

    expect(
      patches.find((p) => p.type === 'agent-turn-started-v2')
    ).toMatchObject({
      turn: { id: 'turn-X', status: 'running', inputMessageId: 'user-turn-X' },
    });
    expect(
      patches.find(
        (p) =>
          p.type === 'agent-item-started-v2' && p.item.type === 'userMessage'
      )
    ).toMatchObject({
      turnId: 'turn-X',
      item: { id: 'user-turn-X', text: 'hello', status: 'completed' },
    });
    expect(
      patches.find(
        (p) =>
          p.type === 'agent-live-state-updated-v2' &&
          p.live.status === 'working'
      )
    ).toBeDefined();
  });

  it('writes JSONL user message to claude stdin', async () => {
    const fake = makeFakeChild();
    const writes = captureStdin(fake);
    const adapter = new ClaudeProtocolAdapterV2({
      spawn: vi.fn(() => fake as unknown as ChildProcess),
    });
    await adapter.connect(baseConfig);
    await adapter.sendMessage({ turnId: 't', content: 'hello' });
    const stdinJSON = writes.join('').trim().split('\n').filter(Boolean);
    expect(stdinJSON.length).toBeGreaterThan(0);
    const parsed = JSON.parse(stdinJSON[stdinJSON.length - 1] as string);
    expect(parsed).toMatchObject({
      type: 'user',
      message: { role: 'user', content: 'hello' },
    });
  });

  it('resets per-turn state (blockIdx, blockIndexToItem, pendingMessageDelta) on new send', async () => {
    const fake = makeFakeChild();
    const adapter = new ClaudeProtocolAdapterV2({
      spawn: vi.fn(() => fake as unknown as ChildProcess),
    });
    await adapter.connect(baseConfig);
    await adapter.sendMessage({ turnId: 'A', content: 'a' });
    (adapter as unknown as { blockIdx: number }).blockIdx = 5;
    (
      adapter as unknown as { blockIndexToItem: Map<number, unknown> }
    ).blockIndexToItem.set(99, {
      itemId: 'x',
      discriminator: 'assistantMessage',
    } as never);
    (
      adapter as unknown as { pendingMessageDelta: { usage?: unknown } }
    ).pendingMessageDelta.usage = { foo: 1 };
    await adapter.sendMessage({ turnId: 'B', content: 'b' });
    expect((adapter as unknown as { blockIdx: number }).blockIdx).toBe(0);
    expect(
      (adapter as unknown as { blockIndexToItem: Map<number, unknown> })
        .blockIndexToItem.size
    ).toBe(0);
    expect(
      (adapter as unknown as { pendingMessageDelta: { usage?: unknown } })
        .pendingMessageDelta.usage
    ).toBeUndefined();
  });
});

describe('ClaudeProtocolAdapterV2 — interrupt', () => {
  it('writes control_request{subtype:interrupt} to stdin', async () => {
    const fake = makeFakeChild();
    const writes = captureStdin(fake);
    const adapter = new ClaudeProtocolAdapterV2({
      spawn: vi.fn(() => fake as unknown as ChildProcess),
    });
    await adapter.connect(baseConfig);
    await adapter.sendMessage({ turnId: 't', content: 'hi' });
    writes.length = 0; // ignore prior writes
    await adapter.interrupt({ turnId: 't' });
    const lines = writes.join('').trim().split('\n').filter(Boolean);
    const parsed = JSON.parse(lines[lines.length - 1] as string);
    expect(parsed).toMatchObject({
      type: 'control_request',
      request: { subtype: 'interrupt' },
    });
    expect(typeof parsed.request_id).toBe('string');
  });

  it('does not throw when no active turn', async () => {
    const fake = makeFakeChild();
    const adapter = new ClaudeProtocolAdapterV2({
      spawn: vi.fn(() => fake as unknown as ChildProcess),
    });
    await adapter.connect(baseConfig);
    await expect(adapter.interrupt({})).resolves.toBeUndefined();
  });
});

describe('ClaudeProtocolAdapterV2 — respondToApproval', () => {
  it('writes control_response with mapped decision + emits approval updated', async () => {
    const fake = makeFakeChild();
    const writes = captureStdin(fake);
    const adapter = new ClaudeProtocolAdapterV2({
      spawn: vi.fn(() => fake as unknown as ChildProcess),
    });
    const patches: AgentPatchV2[] = [];
    adapter.onPatch((p) => patches.push(p));
    await adapter.connect(baseConfig);
    (adapter as unknown as { _currentTurnId: string })._currentTurnId =
      'turn-A';

    fake.stdout.write(
      JSON.stringify({
        type: 'control_request',
        request_id: 'req-1',
        request: {
          subtype: 'can_use_tool',
          tool_use_id: 'tu_x',
          tool_name: 'Bash',
          tool_input: { command: 'ls' },
        },
      }) + '\n'
    );

    writes.length = 0;
    await adapter.respondToApproval({ requestId: 'req-1', decision: 'allow' });

    const lines = writes.join('').trim().split('\n').filter(Boolean);
    const parsed = JSON.parse(lines[0] as string);
    expect(parsed).toMatchObject({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: 'req-1',
        response: { decision: 'allow' },
      },
    });

    const updated = patches.find(
      (p) => p.type === 'agent-item-updated-v2' && p.item.type === 'approval'
    );
    expect(updated).toMatchObject({
      item: {
        id: 'approval-req-1',
        decision: 'allow',
        respondedBy: 'user',
        status: 'completed',
      },
    });

    const live = [...patches]
      .reverse()
      .find((p) => p.type === 'agent-live-state-updated-v2');
    expect(live).toMatchObject({
      live: { status: 'working', waitingOn: null },
    });
  });

  it('maps "allow-always" → "allow_for_session"', async () => {
    const fake = makeFakeChild();
    const writes = captureStdin(fake);
    const adapter = new ClaudeProtocolAdapterV2({
      spawn: vi.fn(() => fake as unknown as ChildProcess),
    });
    await adapter.connect(baseConfig);
    (adapter as unknown as { _currentTurnId: string })._currentTurnId =
      'turn-A';
    fake.stdout.write(
      JSON.stringify({
        type: 'control_request',
        request_id: 'r2',
        request: {
          subtype: 'can_use_tool',
          tool_use_id: 't',
          tool_name: 'Bash',
          tool_input: {},
        },
      }) + '\n'
    );
    writes.length = 0;
    await adapter.respondToApproval({
      requestId: 'r2',
      decision: 'allow-always',
    });
    const parsed = JSON.parse(
      writes.join('').trim().split('\n').filter(Boolean)[0] as string
    );
    expect(parsed.response.response).toMatchObject({
      decision: 'allow_for_session',
    });
  });

  it('maps "deny" → "deny"', async () => {
    const fake = makeFakeChild();
    const writes = captureStdin(fake);
    const adapter = new ClaudeProtocolAdapterV2({
      spawn: vi.fn(() => fake as unknown as ChildProcess),
    });
    await adapter.connect(baseConfig);
    (adapter as unknown as { _currentTurnId: string })._currentTurnId =
      'turn-A';
    fake.stdout.write(
      JSON.stringify({
        type: 'control_request',
        request_id: 'r3',
        request: {
          subtype: 'can_use_tool',
          tool_use_id: 't',
          tool_name: 'Bash',
          tool_input: {},
        },
      }) + '\n'
    );
    writes.length = 0;
    await adapter.respondToApproval({ requestId: 'r3', decision: 'deny' });
    const parsed = JSON.parse(
      writes.join('').trim().split('\n').filter(Boolean)[0] as string
    );
    expect(parsed.response.response).toMatchObject({ decision: 'deny' });
  });

  it('silent no-op when requestId not in pendingApprovals', async () => {
    const fake = makeFakeChild();
    const writes = captureStdin(fake);
    const adapter = new ClaudeProtocolAdapterV2({
      spawn: vi.fn(() => fake as unknown as ChildProcess),
    });
    await adapter.connect(baseConfig);
    writes.length = 0;
    await adapter.respondToApproval({ requestId: 'nope', decision: 'allow' });
    expect(writes.join('')).toBe('');
  });
});

describe('ClaudeProtocolAdapterV2 — respondToInput', () => {
  it('silent no-op (claude has no structured input flow)', async () => {
    const adapter = new ClaudeProtocolAdapterV2();
    await adapter.connect(baseConfig);
    await expect(
      adapter.respondToInput({ requestId: 'r', answers: {} })
    ).resolves.toBeUndefined();
  });
});

describe('ClaudeProtocolAdapterV2 — result event', () => {
  it('success result emits turn-completed with usage', async () => {
    const fake = makeFakeChild();
    const adapter = new ClaudeProtocolAdapterV2({
      spawn: vi.fn(() => fake as unknown as ChildProcess),
    });
    const patches: AgentPatchV2[] = [];
    adapter.onPatch((p) => patches.push(p));
    await adapter.connect(baseConfig);
    (adapter as unknown as { _currentTurnId: string })._currentTurnId =
      'turn-R';

    fake.stdout.write(
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        duration_ms: 1234,
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_read_input_tokens: 20,
          cache_creation_input_tokens: 10,
        },
      }) + '\n'
    );

    const completed = patches.find((p) => p.type === 'agent-turn-completed-v2');
    expect(completed).toMatchObject({
      turnId: 'turn-R',
      status: 'completed',
      durationMs: 1234,
      usage: {
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 20,
        cacheWriteTokens: 10,
      },
    });
  });

  it('uses pendingMessageDelta.usage when result has none', async () => {
    const fake = makeFakeChild();
    const adapter = new ClaudeProtocolAdapterV2({
      spawn: vi.fn(() => fake as unknown as ChildProcess),
    });
    const patches: AgentPatchV2[] = [];
    adapter.onPatch((p) => patches.push(p));
    await adapter.connect(baseConfig);
    (adapter as unknown as { _currentTurnId: string })._currentTurnId =
      'turn-R';
    (
      adapter as unknown as {
        pendingMessageDelta: { usage?: Record<string, number> };
      }
    ).pendingMessageDelta.usage = { input_tokens: 7, output_tokens: 3 };

    fake.stdout.write(
      JSON.stringify({ type: 'result', subtype: 'success', duration_ms: 5 }) +
        '\n'
    );

    const completed = patches.find((p) => p.type === 'agent-turn-completed-v2');
    expect(completed).toMatchObject({
      usage: { inputTokens: 7, outputTokens: 3 },
    });
  });

  it('error subtype emits agent-error-v2 + turn-completed failed', async () => {
    const fake = makeFakeChild();
    const adapter = new ClaudeProtocolAdapterV2({
      spawn: vi.fn(() => fake as unknown as ChildProcess),
    });
    const patches: AgentPatchV2[] = [];
    adapter.onPatch((p) => patches.push(p));
    await adapter.connect(baseConfig);
    (adapter as unknown as { _currentTurnId: string })._currentTurnId =
      'turn-R';

    fake.stdout.write(
      JSON.stringify({
        type: 'result',
        subtype: 'error_during_execution',
        duration_ms: 2,
      }) + '\n'
    );

    expect(patches.find((p) => p.type === 'agent-error-v2')).toBeDefined();
    expect(
      patches.find((p) => p.type === 'agent-turn-completed-v2')
    ).toMatchObject({ status: 'failed' });
  });

  it('clears per-turn state on result', async () => {
    const fake = makeFakeChild();
    const adapter = new ClaudeProtocolAdapterV2({
      spawn: vi.fn(() => fake as unknown as ChildProcess),
    });
    await adapter.connect(baseConfig);
    (adapter as unknown as { _currentTurnId: string })._currentTurnId =
      'turn-R';
    (adapter as unknown as { blockIdx: number }).blockIdx = 3;
    (
      adapter as unknown as { blockIndexToItem: Map<number, unknown> }
    ).blockIndexToItem.set(0, {
      itemId: 'x',
      discriminator: 'assistantMessage',
    } as never);

    fake.stdout.write(
      JSON.stringify({ type: 'result', subtype: 'success', duration_ms: 1 }) +
        '\n'
    );

    expect(
      (adapter as unknown as { _currentTurnId: string | null })._currentTurnId
    ).toBeNull();
    expect((adapter as unknown as { blockIdx: number }).blockIdx).toBe(0);
    expect(
      (adapter as unknown as { blockIndexToItem: Map<number, unknown> })
        .blockIndexToItem.size
    ).toBe(0);
  });
});

describe('ClaudeProtocolAdapterV2 — process exit/error', () => {
  it('non-zero exit emits error + turn-completed failed when turn active', async () => {
    const fake = makeFakeChild();
    const adapter = new ClaudeProtocolAdapterV2({
      spawn: vi.fn(() => fake as unknown as ChildProcess),
    });
    const patches: AgentPatchV2[] = [];
    adapter.onPatch((p) => patches.push(p));
    await adapter.connect(baseConfig);
    await adapter.sendMessage({ turnId: 't', content: 'hi' });

    fake.emit('exit', 1, null);

    expect(patches.find((p) => p.type === 'agent-error-v2')).toBeDefined();
    expect(
      patches.find((p) => p.type === 'agent-turn-completed-v2')
    ).toMatchObject({ status: 'failed' });
  });

  it('zero exit WITHOUT active turn is silent (result event handles success)', async () => {
    const fake = makeFakeChild();
    const adapter = new ClaudeProtocolAdapterV2({
      spawn: vi.fn(() => fake as unknown as ChildProcess),
    });
    const patches: AgentPatchV2[] = [];
    adapter.onPatch((p) => patches.push(p));
    await adapter.connect(baseConfig);
    // No active turn — simulate result arriving before exit clears _currentTurnId
    // by not calling sendMessage at all.

    fake.emit('exit', 0, null);

    // No turn active → no error or turn-completed emitted
    expect(patches.find((p) => p.type === 'agent-error-v2')).toBeUndefined();
    expect(
      patches.find((p) => p.type === 'agent-turn-completed-v2')
    ).toBeUndefined();
  });

  it('error event emits error + turn-completed failed', async () => {
    const fake = makeFakeChild();
    const adapter = new ClaudeProtocolAdapterV2({
      spawn: vi.fn(() => fake as unknown as ChildProcess),
    });
    const patches: AgentPatchV2[] = [];
    adapter.onPatch((p) => patches.push(p));
    await adapter.connect(baseConfig);
    await adapter.sendMessage({ turnId: 't', content: 'hi' });

    fake.emit('error', new Error('ENOENT'));

    expect(patches.find((p) => p.type === 'agent-error-v2')).toMatchObject({
      message: 'ENOENT',
    });
  });

  // B1: clean exit (code 0) WITH active turn → emits failed turn-completed + error
  it('B1: zero exit WITH active turn emits failed turn-completed + error patch', async () => {
    const fake = makeFakeChild();
    const adapter = new ClaudeProtocolAdapterV2({
      spawn: vi.fn(() => fake as unknown as ChildProcess),
    });
    const patches: AgentPatchV2[] = [];
    adapter.onPatch((p) => patches.push(p));
    await adapter.connect(baseConfig);
    await adapter.sendMessage({ turnId: 'turn-b1', content: 'hi' });

    fake.emit('exit', 0, null);

    const errorPatch = patches.find((p) => p.type === 'agent-error-v2');
    expect(errorPatch).toBeDefined();
    expect(errorPatch).toMatchObject({
      message: 'claude exited before result',
    });

    const completedPatch = patches.find(
      (p) => p.type === 'agent-turn-completed-v2'
    );
    expect(completedPatch).toMatchObject({
      status: 'failed',
      turnId: 'turn-b1',
    });

    // turn state cleared
    expect(
      (adapter as unknown as { _currentTurnId: string | null })._currentTurnId
    ).toBeNull();
  });

  // B1: null exit code WITH active turn → also treated as premature
  it('B1: null exit code WITH active turn emits failed turn-completed + error patch', async () => {
    const fake = makeFakeChild();
    const adapter = new ClaudeProtocolAdapterV2({
      spawn: vi.fn(() => fake as unknown as ChildProcess),
    });
    const patches: AgentPatchV2[] = [];
    adapter.onPatch((p) => patches.push(p));
    await adapter.connect(baseConfig);
    await adapter.sendMessage({ turnId: 'turn-b1b', content: 'hi' });

    fake.emit('exit', null, null);

    expect(patches.find((p) => p.type === 'agent-error-v2')).toMatchObject({
      message: 'claude exited before result',
    });
    expect(
      patches.find((p) => p.type === 'agent-turn-completed-v2')
    ).toMatchObject({ status: 'failed' });
  });

  // B2: process error BEFORE any sendMessage → status becomes 'error', not 'connected'
  it('B2: process error before sendMessage sets status=error and emits error live state', async () => {
    const fake = makeFakeChild();
    const adapter = new ClaudeProtocolAdapterV2({
      spawn: vi.fn(() => fake as unknown as ChildProcess),
    });
    const patches: AgentPatchV2[] = [];
    adapter.onPatch((p) => patches.push(p));
    await adapter.connect(baseConfig);
    // No sendMessage — _currentTurnId is null

    fake.emit('error', new Error('ENOENT'));

    expect(adapter.status).toBe('error');
    const livePatches = patches.filter(
      (p) => p.type === 'agent-live-state-updated-v2'
    );
    const errorLive = livePatches.find(
      (p) => (p as { live?: { status?: string } }).live?.status === 'error'
    );
    expect(errorLive).toBeDefined();
    // No turn-level patches when no turn was active
    expect(
      patches.find((p) => p.type === 'agent-turn-completed-v2')
    ).toBeUndefined();
  });

  // B2: non-zero exit before sendMessage → status becomes 'error'
  it('B2: non-zero exit before sendMessage sets status=error', async () => {
    const fake = makeFakeChild();
    const adapter = new ClaudeProtocolAdapterV2({
      spawn: vi.fn(() => fake as unknown as ChildProcess),
    });
    const patches: AgentPatchV2[] = [];
    adapter.onPatch((p) => patches.push(p));
    await adapter.connect(baseConfig);
    // No sendMessage

    fake.emit('exit', 1, null);

    expect(adapter.status).toBe('error');
  });
});

describe('ClaudeProtocolAdapterV2 — disconnect cleanup (B3)', () => {
  it('B3: disconnect clears pendingApprovals, toolUseRegistry, _providerSessionId', async () => {
    const adapter = new ClaudeProtocolAdapterV2({
      spawn: vi.fn(() => makeFakeChild() as unknown as ChildProcess),
    });
    await adapter.connect(baseConfig);

    // Seed per-session state via internal access
    (
      adapter as unknown as { pendingApprovals: Map<string, unknown> }
    ).pendingApprovals.set('req-1', { claudeRequestId: 'req-1' });
    (
      adapter as unknown as {
        toolUseRegistry: Map<string, unknown>;
      }
    ).toolUseRegistry.set('tu-1', {
      itemId: 'exec-tu-1',
      discriminator: 'commandExecution',
      name: 'Bash',
      input: {},
    });
    (adapter as unknown as { _providerSessionId: string })._providerSessionId =
      'claude-session-xyz';
    (adapter as unknown as { _currentTurnId: string })._currentTurnId =
      'turn-active';
    (adapter as unknown as { blockIdx: number }).blockIdx = 5;
    (adapter as unknown as { streamBuffer: string }).streamBuffer = 'partial';

    await adapter.disconnect();

    expect(
      (adapter as unknown as { pendingApprovals: Map<string, unknown> })
        .pendingApprovals.size
    ).toBe(0);
    expect(
      (adapter as unknown as { toolUseRegistry: Map<string, unknown> })
        .toolUseRegistry.size
    ).toBe(0);
    expect(
      (adapter as unknown as { _providerSessionId: string | null })
        ._providerSessionId
    ).toBeNull();
    expect(
      (adapter as unknown as { _currentTurnId: string | null })._currentTurnId
    ).toBeNull();
    expect((adapter as unknown as { blockIdx: number }).blockIdx).toBe(0);
    expect((adapter as unknown as { streamBuffer: string }).streamBuffer).toBe(
      ''
    );
  });

  it('B3: reconnect after disconnect starts fresh (no stale approvals)', async () => {
    const fake1 = makeFakeChild();
    const fake2 = makeFakeChild();
    let callCount = 0;
    const spawn = vi.fn(() => {
      return (callCount++ === 0 ? fake1 : fake2) as unknown as ChildProcess;
    });
    const adapter = new ClaudeProtocolAdapterV2({ spawn });
    await adapter.connect(baseConfig);

    // Seed stale approval
    (
      adapter as unknown as { pendingApprovals: Map<string, unknown> }
    ).pendingApprovals.set('stale-req', { claudeRequestId: 'stale-req' });

    await adapter.reconnect();

    expect(
      (adapter as unknown as { pendingApprovals: Map<string, unknown> })
        .pendingApprovals.size
    ).toBe(0);
    expect(adapter.status).toBe('connected');
  });
});

describe('ClaudeProtocolAdapterV2 — PostToolUse output preservation (B6)', () => {
  it('B6: tool_result output preserved when PostToolUse has no output field', async () => {
    const fake = makeFakeChild();
    const adapter = new ClaudeProtocolAdapterV2({
      spawn: vi.fn(() => fake as unknown as ChildProcess),
    });
    const patches: AgentPatchV2[] = [];
    adapter.onPatch((p) => patches.push(p));
    await adapter.connect(baseConfig);
    await adapter.sendMessage({ turnId: 'turn-b6', content: 'run it' });

    // 1. assistant block: tool_use Bash
    fake.stdout.write(
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'tu-b6',
              name: 'Bash',
              input: { command: 'echo hello' },
            },
          ],
        },
      }) + '\n'
    );

    // 2. user block: tool_result with rich output
    fake.stdout.write(
      JSON.stringify({
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tu-b6',
              content: 'hello world',
            },
          ],
        },
      }) + '\n'
    );

    // 3. hook event: PostToolUse WITHOUT output field (simulates hook that omits output)
    fake.stdout.write(
      JSON.stringify({
        hook_event_name: 'PostToolUse',
        hook_event_payload: {
          tool_name: 'Bash',
          tool_use_id: 'tu-b6',
          exit_code: 0,
          duration_ms: 42,
          // intentionally no 'output' field
        },
      }) + '\n'
    );

    // Find all item-updated patches for the exec item
    const execItemId = 'exec-tu-b6';
    const updatedPatches = patches.filter(
      (p) =>
        p.type === 'agent-item-updated-v2' &&
        'item' in p &&
        (p as { item?: { id?: string } }).item?.id === execItemId
    );

    // The LAST updated patch must preserve the tool_result output, not overwrite with ''
    const lastUpdated = updatedPatches[updatedPatches.length - 1];
    expect(lastUpdated).toBeDefined();
    expect((lastUpdated as { item?: { output?: string } }).item?.output).toBe(
      'hello world'
    );
  });

  it('B6: dynamicToolCall result omitted when PostToolUse has no output', async () => {
    const fake = makeFakeChild();
    const adapter = new ClaudeProtocolAdapterV2({
      spawn: vi.fn(() => fake as unknown as ChildProcess),
    });
    const patches: AgentPatchV2[] = [];
    adapter.onPatch((p) => patches.push(p));
    await adapter.connect(baseConfig);
    await adapter.sendMessage({ turnId: 'turn-b6b', content: 'call tool' });

    // 1. assistant: tool_use for a custom tool
    fake.stdout.write(
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'tu-dyn',
              name: 'CustomTool',
              input: { param: 'value' },
            },
          ],
        },
      }) + '\n'
    );

    // 2. PostToolUse WITHOUT output
    fake.stdout.write(
      JSON.stringify({
        hook_event_name: 'PostToolUse',
        hook_event_payload: {
          tool_name: 'CustomTool',
          tool_use_id: 'tu-dyn',
          // no output
        },
      }) + '\n'
    );

    const toolItemId = 'tool-tu-dyn';
    const updatedPatches = patches.filter(
      (p) =>
        p.type === 'agent-item-updated-v2' &&
        'item' in p &&
        (p as { item?: { id?: string } }).item?.id === toolItemId
    );
    const lastUpdated = updatedPatches[updatedPatches.length - 1];
    expect(lastUpdated).toBeDefined();
    // result field should be absent (not set to '')
    expect(
      (lastUpdated as { item?: { result?: unknown } }).item
    ).not.toHaveProperty('result');
  });
});
