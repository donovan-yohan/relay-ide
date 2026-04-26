import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
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
  sessionId: 's1',
  hookToken: 't',
  configDir: '/tmp/cfg',
};

describe('ClaudeProtocolAdapterV2 — identity', () => {
  it('reports agentType = claude', () => {
    const a = new ClaudeProtocolAdapterV2();
    expect(a.agentType).toBe('claude');
  });

  it('reports runtimeOwnership = spawned', () => {
    const a = new ClaudeProtocolAdapterV2();
    expect(a.runtimeOwnership).toBe('spawned');
  });

  it('declares text/reasoning/tools/commandExecution/fileChanges/approvals capabilities', () => {
    const a = new ClaudeProtocolAdapterV2();
    expect(a.capabilities).toMatchObject({
      text: true,
      reasoning: true,
      tools: true,
      commandExecution: true,
      fileChanges: true,
      approvals: true,
      interrupt: true,
    });
  });
});

describe('ClaudeProtocolAdapterV2 — connect lifecycle', () => {
  it('connect transitions to status=connected and emits idle live state', async () => {
    const adapter = new ClaudeProtocolAdapterV2();
    const patches: AgentPatchV2[] = [];
    adapter.onPatch((p) => patches.push(p));

    await adapter.connect(baseConfig);

    expect(adapter.status).toBe('connected');
    const live = patches.find((p) => p.type === 'agent-live-state-updated-v2');
    expect(live).toMatchObject({
      sessionId: 's1',
      live: {
        status: 'idle',
        activeTurnId: null,
        waitingOn: null,
        activeRequestIds: [],
        queueLength: 0,
        error: null,
      },
    });
  });

  it('disconnect transitions to status=disconnected', async () => {
    const adapter = new ClaudeProtocolAdapterV2();
    await adapter.connect(baseConfig);
    await adapter.disconnect();
    expect(adapter.status).toBe('disconnected');
  });

  it('reconnect cycles disconnect → connect and re-emits idle live state', async () => {
    const adapter = new ClaudeProtocolAdapterV2();
    await adapter.connect(baseConfig);
    await adapter.reconnect();

    // Trigger another connect to verify post-reconnect emission still works.
    // Subscribe after disconnect so the handler is not cleared by it.
    await adapter.disconnect();
    const patches: AgentPatchV2[] = [];
    adapter.onPatch((p) => patches.push(p));
    await adapter.connect(baseConfig);
    expect(adapter.status).toBe('connected');
    expect(
      patches.find((p) => p.type === 'agent-live-state-updated-v2')
    ).toBeDefined();
  });

  it('reconnect before initial connect throws', async () => {
    const adapter = new ClaudeProtocolAdapterV2();
    await expect(adapter.reconnect()).rejects.toThrow(/cannot reconnect/i);
  });

  it('emits patches with sessionId taken from connect config', async () => {
    const adapter = new ClaudeProtocolAdapterV2();
    const patches: AgentPatchV2[] = [];
    adapter.onPatch((p) => patches.push(p));
    await adapter.connect({ ...baseConfig, sessionId: 'custom-id' });
    expect(patches[0]?.sessionId).toBe('custom-id');
  });
});

describe('ClaudeProtocolAdapterV2 — stream-json buffering', () => {
  it('ignores partial lines until newline arrives', async () => {
    const adapter = new ClaudeProtocolAdapterV2();
    const patches: AgentPatchV2[] = [];
    adapter.onPatch((p) => patches.push(p));
    await adapter.connect(baseConfig);
    (adapter as unknown as { _currentTurnId: string })._currentTurnId =
      'turn-1';

    const handle = (
      adapter as unknown as { handleStreamData: (s: string) => void }
    ).handleStreamData.bind(adapter);
    handle('{"type":"assistant","mess'); // partial — no patches yet
    const beforeCount = patches.length;
    handle('age":{"content":[{"type":"text","text":"hi"}]}}\n');
    expect(patches.length).toBeGreaterThan(beforeCount);
  });

  it('drops malformed JSON lines without throwing', async () => {
    const adapter = new ClaudeProtocolAdapterV2();
    await adapter.connect(baseConfig);
    (adapter as unknown as { _currentTurnId: string })._currentTurnId =
      'turn-1';
    const handle = (
      adapter as unknown as { handleStreamData: (s: string) => void }
    ).handleStreamData.bind(adapter);
    expect(() => handle('not-json\n{"type":"unknown"}\n')).not.toThrow();
  });

  it('routes unknown stream-json types to providerExtension', async () => {
    const adapter = new ClaudeProtocolAdapterV2();
    const patches: AgentPatchV2[] = [];
    adapter.onPatch((p) => patches.push(p));
    await adapter.connect(baseConfig);
    (adapter as unknown as { _currentTurnId: string })._currentTurnId =
      'turn-1';
    const handle = (
      adapter as unknown as { handleStreamData: (s: string) => void }
    ).handleStreamData.bind(adapter);
    handle('{"type":"unknown-type"}\n');
    const ext = patches.find(
      (p) =>
        p.type === 'agent-item-started-v2' &&
        p.item.type === 'providerExtension'
    );
    expect(ext).toBeDefined();
  });
});

describe('ClaudeProtocolAdapterV2 — text blocks', () => {
  it('emits item-started + item-delta + item-updated for a text block', async () => {
    const adapter = new ClaudeProtocolAdapterV2();
    const patches: AgentPatchV2[] = [];
    adapter.onPatch((p) => patches.push(p));
    await adapter.connect(baseConfig);
    (adapter as unknown as { _currentTurnId: string })._currentTurnId =
      'turn-1';

    const line =
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'hello world' }] },
      }) + '\n';
    (
      adapter as unknown as { handleStreamData: (s: string) => void }
    ).handleStreamData(line);

    const started = patches.find(
      (p) =>
        p.type === 'agent-item-started-v2' && p.item.type === 'assistantMessage'
    );
    expect(started).toMatchObject({
      turnId: 'turn-1',
      item: {
        id: 'msg-turn-1-0',
        text: '',
        phase: 'answer',
        status: 'running',
      },
    });
    const delta = patches.find((p) => p.type === 'agent-item-delta-v2');
    expect(delta).toMatchObject({
      itemId: 'msg-turn-1-0',
      delta: { text: 'hello world' },
    });
    const updated = patches.find(
      (p) =>
        p.type === 'agent-item-updated-v2' && p.item.type === 'assistantMessage'
    );
    expect(updated).toMatchObject({
      item: { id: 'msg-turn-1-0', text: 'hello world', status: 'completed' },
    });
  });

  it('uses incrementing block index for multiple text blocks in same turn', async () => {
    const adapter = new ClaudeProtocolAdapterV2();
    const patches: AgentPatchV2[] = [];
    adapter.onPatch((p) => patches.push(p));
    await adapter.connect(baseConfig);
    (adapter as unknown as { _currentTurnId: string })._currentTurnId =
      'turn-A';

    const line =
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'first' },
            { type: 'text', text: 'second' },
          ],
        },
      }) + '\n';
    (
      adapter as unknown as { handleStreamData: (s: string) => void }
    ).handleStreamData(line);

    const ids = patches
      .filter(
        (p) =>
          p.type === 'agent-item-started-v2' &&
          p.item.type === 'assistantMessage'
      )
      .map((p) => (p as { item: { id: string } }).item.id);
    expect(ids).toEqual(['msg-turn-A-0', 'msg-turn-A-1']);
  });
});

describe('ClaudeProtocolAdapterV2 — thinking blocks', () => {
  it('emits item-started + item-delta + item-updated for a thinking block', async () => {
    const adapter = new ClaudeProtocolAdapterV2();
    const patches: AgentPatchV2[] = [];
    adapter.onPatch((p) => patches.push(p));
    await adapter.connect(baseConfig);
    (adapter as unknown as { _currentTurnId: string })._currentTurnId =
      'turn-2';

    const line =
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'thinking', thinking: 'thinking text' }] },
      }) + '\n';
    (
      adapter as unknown as { handleStreamData: (s: string) => void }
    ).handleStreamData(line);

    const started = patches.find(
      (p) => p.type === 'agent-item-started-v2' && p.item.type === 'reasoning'
    );
    expect(started).toMatchObject({
      turnId: 'turn-2',
      item: {
        id: 'thinking-turn-2-0',
        summary: '',
        visibility: 'summary',
        status: 'running',
      },
    });
    const delta = patches.find((p) => p.type === 'agent-item-delta-v2');
    expect(delta).toMatchObject({
      itemId: 'thinking-turn-2-0',
      delta: { summary: 'thinking text' },
    });
    const updated = patches.find(
      (p) => p.type === 'agent-item-updated-v2' && p.item.type === 'reasoning'
    );
    expect(updated).toMatchObject({
      item: {
        id: 'thinking-turn-2-0',
        summary: 'thinking text',
        status: 'completed',
      },
    });
  });
});

describe('ClaudeProtocolAdapterV2 — tool_use blocks', () => {
  function makeToolUse(
    name: string,
    input: Record<string, unknown>,
    id = 'toolu_x'
  ) {
    return (
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id, name, input }] },
      }) + '\n'
    );
  }

  it('Bash → commandExecution item with exec- prefix', async () => {
    const adapter = new ClaudeProtocolAdapterV2();
    const patches: AgentPatchV2[] = [];
    adapter.onPatch((p) => patches.push(p));
    await adapter.connect(baseConfig);
    (adapter as unknown as { _currentTurnId: string })._currentTurnId =
      'turn-T';
    (
      adapter as unknown as { handleStreamData: (s: string) => void }
    ).handleStreamData(makeToolUse('Bash', { command: 'ls -la' }, 'toolu_b1'));

    const started = patches.find(
      (p) =>
        p.type === 'agent-item-started-v2' && p.item.type === 'commandExecution'
    );
    expect(started).toMatchObject({
      item: {
        id: 'exec-toolu_b1',
        command: 'ls -la',
        output: '',
        status: 'running',
      },
    });
  });

  it('Edit → fileChange item with file- prefix and paths', async () => {
    const adapter = new ClaudeProtocolAdapterV2();
    const patches: AgentPatchV2[] = [];
    adapter.onPatch((p) => patches.push(p));
    await adapter.connect(baseConfig);
    (adapter as unknown as { _currentTurnId: string })._currentTurnId =
      'turn-T';
    (
      adapter as unknown as { handleStreamData: (s: string) => void }
    ).handleStreamData(
      makeToolUse('Edit', { file_path: 'src/foo.ts' }, 'toolu_e1')
    );

    const started = patches.find(
      (p) => p.type === 'agent-item-started-v2' && p.item.type === 'fileChange'
    );
    expect(started).toMatchObject({
      item: {
        id: 'file-toolu_e1',
        paths: [{ path: 'src/foo.ts' }],
        applyStatus: 'pending',
      },
    });
  });

  it('Write → fileChange', async () => {
    const adapter = new ClaudeProtocolAdapterV2();
    const patches: AgentPatchV2[] = [];
    adapter.onPatch((p) => patches.push(p));
    await adapter.connect(baseConfig);
    (adapter as unknown as { _currentTurnId: string })._currentTurnId =
      'turn-T';
    (
      adapter as unknown as { handleStreamData: (s: string) => void }
    ).handleStreamData(
      makeToolUse(
        'Write',
        { file_path: 'src/bar.ts', content: 'x' },
        'toolu_w1'
      )
    );

    expect(
      patches.find(
        (p) =>
          p.type === 'agent-item-started-v2' && p.item.type === 'fileChange'
      )
    ).toBeDefined();
  });

  it('MultiEdit → fileChange', async () => {
    const adapter = new ClaudeProtocolAdapterV2();
    const patches: AgentPatchV2[] = [];
    adapter.onPatch((p) => patches.push(p));
    await adapter.connect(baseConfig);
    (adapter as unknown as { _currentTurnId: string })._currentTurnId =
      'turn-T';
    (
      adapter as unknown as { handleStreamData: (s: string) => void }
    ).handleStreamData(
      makeToolUse(
        'MultiEdit',
        { file_path: 'src/baz.ts', edits: [] },
        'toolu_m1'
      )
    );

    expect(
      patches.find(
        (p) =>
          p.type === 'agent-item-started-v2' && p.item.type === 'fileChange'
      )
    ).toBeDefined();
  });

  it('Other tool → dynamicToolCall with namespace=claude and tool name', async () => {
    const adapter = new ClaudeProtocolAdapterV2();
    const patches: AgentPatchV2[] = [];
    adapter.onPatch((p) => patches.push(p));
    await adapter.connect(baseConfig);
    (adapter as unknown as { _currentTurnId: string })._currentTurnId =
      'turn-T';
    (
      adapter as unknown as { handleStreamData: (s: string) => void }
    ).handleStreamData(
      makeToolUse('Read', { file_path: 'src/foo.ts' }, 'toolu_r1')
    );

    const started = patches.find(
      (p) =>
        p.type === 'agent-item-started-v2' && p.item.type === 'dynamicToolCall'
    );
    expect(started).toMatchObject({
      item: {
        id: 'tool-toolu_r1',
        namespace: 'claude',
        tool: 'Read',
        arguments: { file_path: 'src/foo.ts' },
        status: 'running',
      },
    });
  });
});

describe('ClaudeProtocolAdapterV2 — system/init', () => {
  it('captures session_id from system/init and emits snapshot with providerSession', async () => {
    const adapter = new ClaudeProtocolAdapterV2();
    const patches: AgentPatchV2[] = [];
    adapter.onPatch((p) => patches.push(p));
    await adapter.connect(baseConfig);

    const handle = (
      adapter as unknown as { handleStreamData: (s: string) => void }
    ).handleStreamData.bind(adapter);
    handle(
      JSON.stringify({
        type: 'system',
        subtype: 'init',
        session_id: 'abc-123',
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
      sessionId: 'abc-123',
    });
  });

  it('exposes captured provider session id via getter for sendMessage --resume', async () => {
    const adapter = new ClaudeProtocolAdapterV2();
    await adapter.connect(baseConfig);
    const handle = (
      adapter as unknown as { handleStreamData: (s: string) => void }
    ).handleStreamData.bind(adapter);
    handle(
      JSON.stringify({
        type: 'system',
        subtype: 'init',
        session_id: 'xyz-789',
      }) + '\n'
    );
    expect(
      (adapter as unknown as { providerSessionId: string | null })
        .providerSessionId
    ).toBe('xyz-789');
  });

  it('non-init system events still route to providerExtension', async () => {
    const adapter = new ClaudeProtocolAdapterV2();
    const patches: AgentPatchV2[] = [];
    adapter.onPatch((p) => patches.push(p));
    await adapter.connect(baseConfig);
    (adapter as unknown as { _currentTurnId: string })._currentTurnId =
      'turn-1';
    const handle = (
      adapter as unknown as { handleStreamData: (s: string) => void }
    ).handleStreamData.bind(adapter);
    handle(
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

describe('ClaudeProtocolAdapterV2 — sendMessage', () => {
  it('throws if called before connect', async () => {
    const adapter = new ClaudeProtocolAdapterV2();
    await expect(
      adapter.sendMessage({ turnId: 't1', content: 'hi' })
    ).rejects.toThrow();
  });

  it('emits turn-started + userMessage item + working live state on send', async () => {
    const fake = makeFakeChild();
    const spawn = vi.fn(() => fake as unknown as ChildProcess);
    const adapter = new ClaudeProtocolAdapterV2({ spawn });
    const patches: AgentPatchV2[] = [];
    adapter.onPatch((p) => patches.push(p));
    await adapter.connect(baseConfig);

    await adapter.sendMessage({ turnId: 'turn-X', content: 'hello' });

    expect(spawn).toHaveBeenCalledTimes(1);
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

  it('passes correct CLI args including --output-format stream-json and --permission-mode bypassPermissions', async () => {
    const fake = makeFakeChild();
    const spawn = vi.fn(() => fake as unknown as ChildProcess);
    const adapter = new ClaudeProtocolAdapterV2({ spawn });
    await adapter.connect(baseConfig);
    await adapter.sendMessage({ turnId: 't', content: 'hi' });

    const [cmd, args] = spawn.mock.calls[0] as unknown as [
      string,
      string[],
      unknown,
    ];
    expect(cmd).toBe('claude');
    expect(args).toEqual(
      expect.arrayContaining([
        '--output-format',
        'stream-json',
        '--print',
        '-p',
        'hi',
        '--permission-mode',
        'bypassPermissions',
      ])
    );
  });

  it('passes --resume when providerSessionId is set', async () => {
    const fake = makeFakeChild();
    const spawn = vi.fn(() => fake as unknown as ChildProcess);
    const adapter = new ClaudeProtocolAdapterV2({ spawn });
    await adapter.connect(baseConfig);
    // Simulate prior turn capturing provider session id
    (adapter as unknown as { _providerSessionId: string })._providerSessionId =
      'claude-sess-1';
    await adapter.sendMessage({ turnId: 't', content: 'continue' });

    const [, args] = spawn.mock.calls[0] as unknown as [
      string,
      string[],
      unknown,
    ];
    expect(args).toEqual(expect.arrayContaining(['--resume', 'claude-sess-1']));
  });

  it('passes --model when config.model is set', async () => {
    const fake = makeFakeChild();
    const spawn = vi.fn(() => fake as unknown as ChildProcess);
    const adapter = new ClaudeProtocolAdapterV2({ spawn });
    await adapter.connect({ ...baseConfig, model: 'claude-opus-4-7' });
    await adapter.sendMessage({ turnId: 't', content: 'hi' });

    const [, args] = spawn.mock.calls[0] as unknown as [
      string,
      string[],
      unknown,
    ];
    expect(args).toEqual(
      expect.arrayContaining(['--model', 'claude-opus-4-7'])
    );
  });

  it('strips CLAUDECODE from spawn env', async () => {
    const fake = makeFakeChild();
    const spawn = vi.fn(() => fake as unknown as ChildProcess);
    const prevEnv = process.env.CLAUDECODE;
    process.env.CLAUDECODE = '1';
    try {
      const adapter = new ClaudeProtocolAdapterV2({ spawn });
      await adapter.connect(baseConfig);
      await adapter.sendMessage({ turnId: 't', content: 'hi' });
      const [, , opts] = spawn.mock.calls[0] as unknown as [
        string,
        string[],
        { env: Record<string, string> },
      ];
      expect(opts.env).not.toHaveProperty('CLAUDECODE');
    } finally {
      if (prevEnv === undefined) delete process.env.CLAUDECODE;
      else process.env.CLAUDECODE = prevEnv;
    }
  });

  it('pipes stdout chunks into handleStreamData (text block end-to-end)', async () => {
    const fake = makeFakeChild();
    const spawn = vi.fn(() => fake as unknown as ChildProcess);
    const adapter = new ClaudeProtocolAdapterV2({ spawn });
    const patches: AgentPatchV2[] = [];
    adapter.onPatch((p) => patches.push(p));
    await adapter.connect(baseConfig);
    await adapter.sendMessage({ turnId: 'turn-Y', content: 'q' });

    const line =
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'answer' }] },
      }) + '\n';
    fake.stdout.write(Buffer.from(line, 'utf8'));

    const delta = patches.find((p) => p.type === 'agent-item-delta-v2');
    expect(delta).toMatchObject({ delta: { text: 'answer' } });
  });

  it('resets blockIdx to 0 at start of each new turn', async () => {
    const fake1 = makeFakeChild();
    const fake2 = makeFakeChild();
    const spawn = vi.fn().mockReturnValueOnce(fake1).mockReturnValueOnce(fake2);
    const adapter = new ClaudeProtocolAdapterV2({
      spawn: spawn as unknown as typeof import('node:child_process').spawn,
    });
    const patches: AgentPatchV2[] = [];
    adapter.onPatch((p) => patches.push(p));
    await adapter.connect(baseConfig);

    await adapter.sendMessage({ turnId: 'A', content: 'x' });
    fake1.stdout.write(
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: '1' }] },
      }) + '\n'
    );
    fake1.stdout.write(
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: '2' }] },
      }) + '\n'
    );

    await adapter.sendMessage({ turnId: 'B', content: 'y' });
    fake2.stdout.write(
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: '1' }] },
      }) + '\n'
    );

    const turnBStartedIds = patches
      .filter(
        (p) =>
          p.type === 'agent-item-started-v2' &&
          'turnId' in p &&
          p.turnId === 'B' &&
          p.item.type === 'assistantMessage'
      )
      .map((p) => (p as { item: { id: string } }).item.id);
    // First text block of turn B should have idx 0, not continue from turn A's counter
    expect(turnBStartedIds[0]).toBe('msg-B-0');
  });
});

describe('ClaudeProtocolAdapterV2 — interrupt', () => {
  it('kills active process', async () => {
    const fake = makeFakeChild();
    const killSpy = fake.kill as ReturnType<typeof vi.fn>;
    const spawn = vi.fn(() => fake as unknown as ChildProcess);
    const adapter = new ClaudeProtocolAdapterV2({ spawn });
    await adapter.connect(baseConfig);
    await adapter.sendMessage({ turnId: 't', content: 'hi' });
    await adapter.interrupt({ turnId: 't' });
    expect(killSpy).toHaveBeenCalled();
  });

  it('no-op when no active process', async () => {
    const adapter = new ClaudeProtocolAdapterV2();
    await adapter.connect(baseConfig);
    await expect(adapter.interrupt({})).resolves.toBeUndefined();
  });
});

describe('ClaudeProtocolAdapterV2 — respondToInput', () => {
  it('resolves silently (no-op for claude)', async () => {
    const adapter = new ClaudeProtocolAdapterV2();
    await adapter.connect(baseConfig);
    await expect(
      adapter.respondToInput({ requestId: 'r1', answers: {} })
    ).resolves.toBeUndefined();
  });
});

describe('ClaudeProtocolAdapterV2 — result event', () => {
  it('success result emits agent-turn-completed-v2 with usage', async () => {
    const adapter = new ClaudeProtocolAdapterV2();
    const patches: AgentPatchV2[] = [];
    adapter.onPatch((p) => patches.push(p));
    await adapter.connect(baseConfig);
    (adapter as unknown as { _currentTurnId: string })._currentTurnId =
      'turn-R';

    const handle = (
      adapter as unknown as { handleStreamData: (s: string) => void }
    ).handleStreamData.bind(adapter);
    handle(
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

  it('non-success result emits failed status + error message', async () => {
    const adapter = new ClaudeProtocolAdapterV2();
    const patches: AgentPatchV2[] = [];
    adapter.onPatch((p) => patches.push(p));
    await adapter.connect(baseConfig);
    (adapter as unknown as { _currentTurnId: string })._currentTurnId =
      'turn-R';

    const handle = (
      adapter as unknown as { handleStreamData: (s: string) => void }
    ).handleStreamData.bind(adapter);
    handle(
      JSON.stringify({
        type: 'result',
        subtype: 'error_during_execution',
        duration_ms: 5,
      }) + '\n'
    );

    const errPatch = patches.find((p) => p.type === 'agent-error-v2');
    const completed = patches.find((p) => p.type === 'agent-turn-completed-v2');
    expect(errPatch).toBeDefined();
    expect(completed).toMatchObject({ status: 'failed' });
  });

  it('result clears _currentTurnId and emits idle live state', async () => {
    const adapter = new ClaudeProtocolAdapterV2();
    const patches: AgentPatchV2[] = [];
    adapter.onPatch((p) => patches.push(p));
    await adapter.connect(baseConfig);
    (adapter as unknown as { _currentTurnId: string })._currentTurnId =
      'turn-R';

    const handle = (
      adapter as unknown as { handleStreamData: (s: string) => void }
    ).handleStreamData.bind(adapter);
    handle(
      JSON.stringify({ type: 'result', subtype: 'success', duration_ms: 1 }) +
        '\n'
    );

    expect(
      (adapter as unknown as { _currentTurnId: string | null })._currentTurnId
    ).toBeNull();
    const lastLive = [...patches]
      .reverse()
      .find((p) => p.type === 'agent-live-state-updated-v2');
    expect(lastLive).toMatchObject({
      live: { status: 'idle', activeTurnId: null },
    });
  });
});

describe('ClaudeProtocolAdapterV2 — tool_result blocks', () => {
  function feed(adapter: ClaudeProtocolAdapterV2, line: string): void {
    (
      adapter as unknown as { handleStreamData: (s: string) => void }
    ).handleStreamData(line + '\n');
  }
  function toolUseLine(
    name: string,
    id: string,
    input: Record<string, unknown>
  ): string {
    return JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id, name, input }] },
    });
  }
  function toolResultLine(
    toolUseId: string,
    content: string,
    isError = false
  ): string {
    return JSON.stringify({
      type: 'user',
      message: {
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
    const adapter = new ClaudeProtocolAdapterV2();
    const patches: AgentPatchV2[] = [];
    adapter.onPatch((p) => patches.push(p));
    await adapter.connect(baseConfig);
    (adapter as unknown as { _currentTurnId: string })._currentTurnId =
      'turn-X';

    feed(adapter, toolUseLine('Bash', 'tu_b1', { command: 'ls' }));
    feed(adapter, toolResultLine('tu_b1', 'file1\nfile2'));

    const delta = patches.find(
      (p) =>
        p.type === 'agent-item-delta-v2' &&
        (p as { itemId: string }).itemId === 'exec-tu_b1'
    );
    expect(delta).toMatchObject({ delta: { output: 'file1\nfile2' } });
    const updated = patches.find(
      (p) =>
        p.type === 'agent-item-updated-v2' &&
        p.item.type === 'commandExecution' &&
        p.item.id === 'exec-tu_b1'
    );
    expect(updated).toMatchObject({
      item: { output: 'file1\nfile2', status: 'completed' },
    });
  });

  it('Edit tool_result is_error → fileChange failed/applyStatus failed', async () => {
    const adapter = new ClaudeProtocolAdapterV2();
    const patches: AgentPatchV2[] = [];
    adapter.onPatch((p) => patches.push(p));
    await adapter.connect(baseConfig);
    (adapter as unknown as { _currentTurnId: string })._currentTurnId =
      'turn-X';

    feed(
      adapter,
      toolUseLine('Edit', 'tu_e1', {
        file_path: 'src/foo.ts',
        old_string: 'a',
        new_string: 'b',
      })
    );
    feed(adapter, toolResultLine('tu_e1', 'String not found', true));

    const updated = patches.find(
      (p) => p.type === 'agent-item-updated-v2' && p.item.type === 'fileChange'
    );
    expect(updated).toMatchObject({
      item: { id: 'file-tu_e1', applyStatus: 'failed', status: 'failed' },
    });
  });

  it('generic tool_result → dynamicToolCall completed with result', async () => {
    const adapter = new ClaudeProtocolAdapterV2();
    const patches: AgentPatchV2[] = [];
    adapter.onPatch((p) => patches.push(p));
    await adapter.connect(baseConfig);
    (adapter as unknown as { _currentTurnId: string })._currentTurnId =
      'turn-X';

    feed(adapter, toolUseLine('Read', 'tu_r1', { file_path: 'a.txt' }));
    feed(adapter, toolResultLine('tu_r1', 'file contents'));

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

  it('tool_result with unknown tool_use_id is ignored', async () => {
    const adapter = new ClaudeProtocolAdapterV2();
    const patches: AgentPatchV2[] = [];
    adapter.onPatch((p) => patches.push(p));
    await adapter.connect(baseConfig);
    (adapter as unknown as { _currentTurnId: string })._currentTurnId =
      'turn-X';
    feed(adapter, toolResultLine('unknown_id', 'data'));
    expect(
      patches.find((p) => p.type === 'agent-item-delta-v2')
    ).toBeUndefined();
  });
});

describe('ClaudeProtocolAdapterV2 — child exit/error', () => {
  it('non-zero exit emits error + turn-completed failed', async () => {
    const fake = makeFakeChild();
    const spawn = vi.fn(() => fake as unknown as ChildProcess);
    const adapter = new ClaudeProtocolAdapterV2({ spawn });
    const patches: AgentPatchV2[] = [];
    adapter.onPatch((p) => patches.push(p));
    await adapter.connect(baseConfig);
    await adapter.sendMessage({ turnId: 't', content: 'q' });

    fake.emit('exit', 1, null);

    expect(patches.find((p) => p.type === 'agent-error-v2')).toMatchObject({
      message: expect.stringContaining('exit'),
    });
    expect(
      patches.find((p) => p.type === 'agent-turn-completed-v2')
    ).toMatchObject({
      status: 'failed',
    });
  });

  it('zero exit does NOT emit failure (result event handles success)', async () => {
    const fake = makeFakeChild();
    const spawn = vi.fn(() => fake as unknown as ChildProcess);
    const adapter = new ClaudeProtocolAdapterV2({ spawn });
    const patches: AgentPatchV2[] = [];
    adapter.onPatch((p) => patches.push(p));
    await adapter.connect(baseConfig);
    await adapter.sendMessage({ turnId: 't', content: 'q' });

    fake.emit('exit', 0, null);

    expect(patches.find((p) => p.type === 'agent-error-v2')).toBeUndefined();
  });

  it('spawn error event emits error + turn-completed failed', async () => {
    const fake = makeFakeChild();
    const spawn = vi.fn(() => fake as unknown as ChildProcess);
    const adapter = new ClaudeProtocolAdapterV2({ spawn });
    const patches: AgentPatchV2[] = [];
    adapter.onPatch((p) => patches.push(p));
    await adapter.connect(baseConfig);
    await adapter.sendMessage({ turnId: 't', content: 'q' });

    fake.emit('error', new Error('ENOENT'));

    expect(patches.find((p) => p.type === 'agent-error-v2')).toMatchObject({
      message: 'ENOENT',
    });
    expect(
      patches.find((p) => p.type === 'agent-turn-completed-v2')
    ).toMatchObject({
      status: 'failed',
    });
  });
});
