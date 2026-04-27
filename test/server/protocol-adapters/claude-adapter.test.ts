import { describe, expect, it } from 'vitest';
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

function makeQuery(messages: unknown[]): ClaudeQueryFunction {
  return () => {
    async function* generator() {
      for (const message of messages) {
        yield message;
      }
    }
    const query = generator() as ReturnType<ClaudeQueryFunction>;
    query.interrupt = async () => {};
    query.close = () => {};
    return query;
  };
}

function waitFor(predicate: () => boolean, timeoutMs = 250): Promise<void> {
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
    const adapter = new ClaudeProtocolAdapter(makeQuery([]));

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
    });
  });

  it('maps SDK init, assistant text, and result messages to V2 patches', async () => {
    const adapter = new ClaudeProtocolAdapter(
      makeQuery([
        {
          type: 'system',
          subtype: 'init',
          session_id: 'claude-session-1',
          cwd: '/tmp/repo',
          model: 'sonnet',
          tools: ['Bash', 'Edit'],
          slash_commands: ['/compact'],
        },
        {
          type: 'assistant',
          message: {
            id: 'msg-native-1',
            content: [{ type: 'text', text: 'hello from claude' }],
          },
          session_id: 'claude-session-1',
        },
        {
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
        },
      ])
    );
    const patches = collectPatches(adapter);

    await adapter.connect(config);
    await adapter.sendMessage({ turnId: 'turn-1', content: 'hello' });
    await waitFor(() => patches.some((patch) => patch.type === 'agent-turn-completed-v2'));

    expect(patches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'agent-session-snapshot-v2',
          session: expect.objectContaining({
            provider: 'claude',
            providerSession: { claudeSessionId: 'claude-session-1' },
          }),
        }),
        expect.objectContaining({
          type: 'agent-item-started-v2',
          turnId: 'turn-1',
          item: expect.objectContaining({
            type: 'assistantMessage',
            text: '',
          }),
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
  });

  it('maps SDK tool_use blocks to command, file, and dynamic tool items', async () => {
    const adapter = new ClaudeProtocolAdapter(
      makeQuery([
        {
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
        },
        {
          type: 'result',
          subtype: 'success',
          duration_ms: 1,
          total_cost_usd: 0,
          usage: {},
          session_id: 'claude-session-1',
        },
      ])
    );
    const patches = collectPatches(adapter);

    await adapter.connect(config);
    await adapter.sendMessage({ turnId: 'turn-tools', content: 'tools' });
    await waitFor(() => patches.some((patch) => patch.type === 'agent-turn-completed-v2'));

    const itemTypes = patches
      .filter((patch) => patch.type === 'agent-item-started-v2')
      .map((patch) => patch.item.type);

    expect(itemTypes).toEqual(
      expect.arrayContaining(['reasoning', 'commandExecution', 'fileChange', 'dynamicToolCall'])
    );
  });

  it('bridges SDK canUseTool approval through respondToApproval', async () => {
    let capturedCanUseTool:
      | NonNullable<Parameters<ClaudeQueryFunction>[0]['options']>['canUseTool']
      | undefined;
    const queryFn: ClaudeQueryFunction = (params) => {
      capturedCanUseTool = params.options?.canUseTool;
      async function* generator() {
        const decision = await capturedCanUseTool?.('Bash', { command: 'npm test' }, {
          signal: new AbortController().signal,
          toolUseID: 'tool-approval',
          title: 'Claude wants to run tests',
          displayName: 'Run command',
          description: 'npm test',
        });
        yield {
          type: 'result',
          subtype: decision?.behavior === 'allow' ? 'success' : 'error_during_execution',
          duration_ms: 1,
          total_cost_usd: 0,
          usage: {},
          errors: [],
          session_id: 'claude-session-1',
        };
      }
      const query = generator() as ReturnType<ClaudeQueryFunction>;
      query.interrupt = async () => {};
      query.close = () => {};
      return query;
    };
    const adapter = new ClaudeProtocolAdapter(queryFn);
    const patches = collectPatches(adapter);

    await adapter.connect(config);
    void adapter.sendMessage({ turnId: 'turn-approval', content: 'approval' });
    await waitFor(() =>
      patches.some(
        (patch) => patch.type === 'agent-live-state-updated-v2' && patch.live.waitingOn === 'approval'
      )
    );

    await adapter.respondToApproval({ requestId: 'tool-approval', decision: 'allow' });
    await waitFor(() => patches.some((patch) => patch.type === 'agent-turn-completed-v2'));

    expect(patches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'agent-item-started-v2',
          item: expect.objectContaining({
            type: 'approval',
            requestId: 'tool-approval',
            target: 'npm test',
          }),
        }),
        expect.objectContaining({
          type: 'agent-item-updated-v2',
          item: expect.objectContaining({
            type: 'approval',
            decision: 'allow',
          }),
        }),
      ])
    );
  });
});
