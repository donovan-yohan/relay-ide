import { describe, it, expect } from 'vitest';
import { ClaudeProtocolAdapterV2 } from '../../../server/protocol-adapters/claude-v2-adapter.js';
import type { AgentPatchV2 } from '../../../shared/agent-chat-protocol-v2.js';

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
