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
