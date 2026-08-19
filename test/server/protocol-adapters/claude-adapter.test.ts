/**
 * Unit tests for the ClaudeProtocolAdapter persistent-subprocess transport.
 *
 * Every test injects a fake ChildProcess via `spawnFn` — no real `claude`
 * binary is invoked. stdout stream-json is scripted per test; stdin frames are
 * captured and asserted. Emitted patches are validated by the base class
 * (`isAgentPatchV2` throws on an invalid emit) and, for the happy path, reduced
 * through `applyAgentPatchV2` to assert reducer legality.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ClaudeProtocolAdapter,
  ClaudeProcessRegistry,
} from '../../../server/protocol-adapters/claude-adapter.js';
import type { AdapterConfig } from '../../../server/protocol-adapter-v2.js';
import type { ClaudeSpawnFn } from '../../../server/claude-stream-client.js';
import { CHANNEL_ADAPTER_LAUNCH_CONTRACTS } from '../../../server/protocol-adapters/index.js';
import claudeDetailFixture from '../../fixtures/agent-detail/claude.js';
import { makeHarness } from './support/claude-child-double.js';
import {
  applyAgentPatchV2,
  emptyAgentSessionV2,
  isAgentPatchV2,
  type AgentPatchV2,
  type AgentSessionV2,
} from '../../../shared/agent-chat-protocol-v2.js';

// A registry with no live GC timer — tests drive gcSweep() manually.
function inertRegistry(): ClaudeProcessRegistry {
  return new ClaudeProcessRegistry(1_000_000);
}

function baseConfig(extra?: Record<string, unknown>): AdapterConfig {
  return {
    cwd: '/tmp/repo',
    port: 3000,
    sessionId: 'session-1',
    hookToken: 'token',
    configDir: '/tmp/config',
    ...(extra ? { extra } : {}),
  };
}

function collectPatches(adapter: ClaudeProtocolAdapter): AgentPatchV2[] {
  const patches: AgentPatchV2[] = [];
  adapter.onPatch((patch) => patches.push(patch));
  return patches;
}

function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - started > timeoutMs)
        return reject(new Error('timed out waiting for adapter condition'));
      setTimeout(tick, 1);
    };
    tick();
  });
}

function tick(ms = 15): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function successResult(
  overrides?: Record<string, unknown>
): Record<string, unknown> {
  return {
    type: 'result',
    subtype: 'success',
    duration_ms: 1,
    total_cost_usd: 0,
    usage: {},
    session_id: 'claude-session-1',
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('ClaudeProtocolAdapter (stream-json subprocess)', () => {
  it('advertises the claude v2 capability set with questions/slashCommands gated off', () => {
    const adapter = new ClaudeProtocolAdapter(
      makeHarness().spawnFn,
      inertRegistry()
    );
    expect(adapter.capabilities).toMatchObject({
      text: true,
      reasoning: true,
      tools: true,
      approvals: true,
      resume: true,
      steer: true,
      interrupt: true,
      streaming: true,
      questions: false,
      slashCommands: false,
    });
  });

  it('connect does not advertise dead Relay controls without a control executor', async () => {
    const harness = makeHarness();
    const adapter = new ClaudeProtocolAdapter(harness.spawnFn, inertRegistry());
    const patches = collectPatches(adapter);

    await adapter.connect({ ...baseConfig(), extra: { effort: ' high ' } });

    expect(harness.spawns).toHaveLength(0);
    expect(patches.map((p) => p.type)).toEqual([
      'agent-session-snapshot-v2',
      'agent-live-state-updated-v2',
      'agent-session-updated-v2',
    ]);
    const slash = patches.find((p) => p.type === 'agent-session-updated-v2');
    expect(
      slash?.type === 'agent-session-updated-v2' && slash.slashCommands
    ).toEqual([]);
    expect(adapter.executeControlCommand).toBeUndefined();
    expect(patches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'agent-session-snapshot-v2',
          session: expect.objectContaining({
            config: expect.objectContaining({ effort: 'high' }),
          }),
        }),
        expect.objectContaining({
          type: 'agent-live-state-updated-v2',
          live: expect.objectContaining({ fastModeAvailable: false }),
        }),
      ])
    );

    await adapter.disconnect();
  });

  it('first send spawns with the exact argv (fixed + config + denylist + yolo) and strips CLAUDECODE', async () => {
    const harness = makeHarness();
    const adapter = new ClaudeProtocolAdapter(harness.spawnFn, inertRegistry());
    const config: AdapterConfig = {
      ...baseConfig(),
      model: 'sonnet',
      permissionMode: 'default',
      processEnv: {
        RELAY_IDE_ACTOR_TOKEN: 'relay-sac-v1.runtime-only.test-token',
        CLAUDECODE: 'must-still-be-stripped',
        CLAUDE_CODE_ENTRYPOINT: 'must-also-be-stripped',
      },
      systemPromptAppendix: 'Relay orchestrator playbook',
      extra: {
        additionalDirectories: ['/extra/dir'],
        effort: 'high',
        yolo: true,
        claudeArgs: [
          '--append-system-prompt',
          'hi',
          '--verbose', // reserved (bool) → dropped
          '--resume', // reserved (value) → dropped with its value token
          'SHOULD_DROP',
          '--output-format=json', // reserved (=form) → dropped
          '-c', // short alias of --continue (bool) → dropped
          '-r', // short alias of --resume (value) → dropped with its value token
          'SHOULD_DROP_R',
          '-r=alias-session', // short alias (=form) → dropped
          '--effort', // canonical profile effort wins over raw args
          'SHOULD_DROP_EFFORT',
          '--keep-me',
        ],
      },
    };
    await adapter.connect(config);

    process.env.CLAUDECODE = '1';
    try {
      await adapter.sendMessage({ turnId: 'turn-1', content: 'hello' });
    } finally {
      delete process.env.CLAUDECODE;
    }

    expect(harness.spawns).toHaveLength(1);
    const { command, args, options } = harness.latest();
    const launchRequirement =
      CHANNEL_ADAPTER_LAUNCH_CONTRACTS.claude.requirement;
    expect(launchRequirement.kind).toBe('command');
    if (launchRequirement.kind !== 'command') {
      throw new Error('Claude must remain a command-backed channel adapter');
    }
    expect(command).toBe(launchRequirement.command);

    expect(args.slice(0, 11)).toEqual([
      '-p',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--permission-prompt-tool',
      'stdio',
      '--permission-mode',
      'default',
    ]);
    expect(args).toContain('--model');
    expect(args[args.indexOf('--model') + 1]).toBe('sonnet');
    expect(args).toContain('--effort');
    expect(args[args.indexOf('--effort') + 1]).toBe('high');
    expect(args).toContain('--add-dir');
    expect(args[args.indexOf('--add-dir') + 1]).toBe('/extra/dir');
    expect(args).toContain('--append-system-prompt');
    expect(args[args.indexOf('--append-system-prompt') + 1]).toBe(
      'Relay orchestrator playbook'
    );
    expect(args).toContain('--dangerously-skip-permissions');
    // No --resume on a first spawn (no session id yet).
    expect(args).not.toContain('--resume');
    // claudeArgs denylist: kept the safe flags, dropped the reserved ones.
    expect(args).toContain('--append-system-prompt');
    expect(args).toContain('--keep-me');
    expect(args).not.toContain('SHOULD_DROP');
    expect(args).not.toContain('--output-format=json');
    // Short aliases of reserved flags are denied too (-c/--continue, -r/--resume).
    expect(args).not.toContain('-c');
    expect(args).not.toContain('-r');
    expect(args).not.toContain('SHOULD_DROP_R');
    expect(args).not.toContain('-r=alias-session');
    expect(args).not.toContain('SHOULD_DROP_EFFORT');
    // CLAUDECODE stripped from the child env.
    for (const key of CHANNEL_ADAPTER_LAUNCH_CONTRACTS.claude
      .processEnvDenylist) {
      expect(options.env).not.toHaveProperty(key);
    }
    expect(options.env.RELAY_IDE_ACTOR_TOKEN).toBe(
      'relay-sac-v1.runtime-only.test-token'
    );

    await adapter.disconnect();
  });

  it('interrupts and requeues a long active turn before refreshing runtime env', async () => {
    const harness = makeHarness();
    const adapter = new ClaudeProtocolAdapter(harness.spawnFn, inertRegistry());
    const patches = collectPatches(adapter);
    await adapter.connect({
      ...baseConfig(),
      processEnv: {
        RELAY_IDE_ACTOR_TOKEN: 'relay-sac-v1.credential-old.redacted',
      },
    });

    await adapter.sendMessage({ turnId: 'turn-A', content: 'a' });
    const oldChild = harness.latest().child;
    await oldChild.waitForFrames(1);
    oldChild.serverWrite({
      type: 'system',
      subtype: 'init',
      session_id: 'claude-session-refresh',
    });
    const queuedTurn = adapter.sendMessage({
      turnId: 'turn-B',
      content: 'b',
    });
    const refresh = adapter.refreshRuntimeEnv({
      RELAY_IDE_ACTOR_TOKEN: 'relay-sac-v1.credential-new.redacted',
    });

    expect(harness.spawns).toHaveLength(1);
    await oldChild.waitForFrames(2);
    expect(oldChild.frames()[1]).toMatchObject({
      type: 'control_request',
      request: { subtype: 'interrupt' },
    });
    oldChild.serverWrite({
      type: 'control_response',
      response: { subtype: 'success', request_id: 'relay-int-1' },
    });

    await refresh;

    expect(harness.spawns).toHaveLength(2);
    expect(harness.spawns[0]?.options.env.RELAY_IDE_ACTOR_TOKEN).toBe(
      'relay-sac-v1.credential-old.redacted'
    );
    const replacement = harness.latest();
    expect(replacement.options.env.RELAY_IDE_ACTOR_TOKEN).toBe(
      'relay-sac-v1.credential-new.redacted'
    );
    expect(replacement.args).toContain('--resume');
    expect(replacement.child.frames()[0]).toMatchObject({
      message: { content: 'a' },
    });
    expect(
      patches.some(
        (patch) =>
          patch.type === 'agent-turn-completed-v2' &&
          patch.turnId === 'turn-A' &&
          patch.status === 'interrupted'
      )
    ).toBe(true);
    expect(
      patches.some(
        (patch) =>
          patch.type === 'agent-turn-started-v2' &&
          patch.turn.id === 'turn-A-credential-refresh-1'
      )
    ).toBe(true);

    replacement.child.serverWrite({
      type: 'system',
      subtype: 'init',
      session_id: 'claude-session-refresh',
    });
    replacement.child.serverWrite(successResult());
    await queuedTurn;
    expect(replacement.child.frames()[1]).toMatchObject({
      message: { content: 'b' },
    });
    replacement.child.serverWrite(successResult());
    await adapter.disconnect();
  });

  it('does not requeue when the active turn completes during the refresh interrupt race', async () => {
    const harness = makeHarness();
    const adapter = new ClaudeProtocolAdapter(harness.spawnFn, inertRegistry());
    const patches = collectPatches(adapter);
    await adapter.connect({
      ...baseConfig(),
      processEnv: {
        RELAY_IDE_ACTOR_TOKEN: 'relay-sac-v1.credential-old.redacted',
      },
    });

    await adapter.sendMessage({ turnId: 'turn-A', content: 'a' });
    const oldChild = harness.latest().child;
    await oldChild.waitForFrames(1);
    oldChild.serverWrite({
      type: 'system',
      subtype: 'init',
      session_id: 'claude-session-refresh-race',
    });
    const queuedTurn = adapter.sendMessage({
      turnId: 'turn-B',
      content: 'b',
    });
    const refresh = adapter.refreshRuntimeEnv({
      RELAY_IDE_ACTOR_TOKEN: 'relay-sac-v1.credential-new.redacted',
    });
    await oldChild.waitForFrames(2);

    oldChild.serverWrite(successResult());
    oldChild.serverWrite({
      type: 'control_response',
      response: { subtype: 'success', request_id: 'relay-int-1' },
    });

    await refresh;
    await queuedTurn;

    expect(harness.spawns).toHaveLength(2);
    const replacement = harness.latest();
    expect(replacement.child.frames()[0]).toMatchObject({
      message: { content: 'b' },
    });
    expect(
      patches.some(
        (patch) =>
          patch.type === 'agent-turn-started-v2' &&
          patch.turn.id.includes('credential-refresh')
      )
    ).toBe(false);
    expect(
      patches.filter(
        (patch) =>
          patch.type === 'agent-turn-completed-v2' && patch.turnId === 'turn-A'
      )
    ).toHaveLength(1);

    replacement.child.serverWrite({
      type: 'system',
      subtype: 'init',
      session_id: 'claude-session-refresh-race',
    });
    replacement.child.serverWrite(successResult());
    await adapter.disconnect();
  });

  it('writes a realtime stream-json user frame to steer the active turn without queueing or interrupting', async () => {
    const harness = makeHarness();
    const adapter = new ClaudeProtocolAdapter(harness.spawnFn, inertRegistry());
    const patches = collectPatches(adapter);
    await adapter.connect(baseConfig());
    await adapter.sendMessage({ turnId: 'turn-1', content: 'run the check' });
    const child = harness.latest().child;
    await child.waitForFrames(1);

    await adapter.steerMessage({
      turnId: 'turn-1',
      content: 'after this tool, inspect the merge conflict instead',
    });
    await child.waitForFrames(2);

    expect(child.frames()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'user',
          message: expect.objectContaining({
            role: 'user',
            content: 'after this tool, inspect the merge conflict instead',
          }),
        }),
      ])
    );
    expect(
      child.frames().some((frame) => frame.type === 'control_request')
    ).toBe(false);
    expect(
      patches.filter((patch) => patch.type === 'agent-turn-started-v2')
    ).toHaveLength(1);

    child.serverWrite(successResult());
    await adapter.disconnect();
  });

  it('rejects a steer before any Claude turn is active', async () => {
    const harness = makeHarness();
    const adapter = new ClaudeProtocolAdapter(harness.spawnFn, inertRegistry());
    await adapter.connect(baseConfig());

    await expect(
      adapter.steerMessage({ turnId: 'turn-none', content: 'redirect' })
    ).rejects.toThrow('Cannot steer Claude without an active turn');
    expect(harness.spawns).toHaveLength(0);
    await adapter.disconnect();
  });

  it('happy path: init → deltas → assistant echo → result reduces to one user + one assistant message with summed iteration usage', async () => {
    const harness = makeHarness();
    const adapter = new ClaudeProtocolAdapter(harness.spawnFn, inertRegistry());
    const patches = collectPatches(adapter);
    await adapter.connect(baseConfig());

    await adapter.sendMessage({ turnId: 'turn-1', content: 'hello' });
    const child = harness.latest().child;
    await child.waitForFrames(1);
    expect(child.frames()[0]).toMatchObject({
      type: 'user',
      message: { role: 'user', content: 'hello' },
    });

    child.serverWrite({
      type: 'system',
      subtype: 'init',
      session_id: 'claude-session-1',
      slash_commands: ['compact'],
    });
    child.serverWrite({
      type: 'stream_event',
      event: { type: 'message_start', message: { id: 'm-1' } },
    });
    child.serverWrite({
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text' },
      },
    });
    child.serverWrite({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'ok' },
      },
    });
    child.serverWrite({
      type: 'stream_event',
      event: { type: 'content_block_stop', index: 0 },
    });
    // The assistant line duplicates the streamed text — must be echo-dropped.
    child.serverWrite({
      type: 'assistant',
      message: { id: 'm-1', content: [{ type: 'text', text: 'ok' }] },
    });
    child.serverWrite(
      successResult({
        usage: {
          input_tokens: 3, // top-level = last iteration only
          output_tokens: 1,
          iterations: [
            { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 2 },
            { input_tokens: 3, output_tokens: 1, cache_read_input_tokens: 1 },
          ],
        },
        total_cost_usd: 0.05,
      })
    );

    await waitFor(() =>
      patches.some((p) => p.type === 'agent-turn-completed-v2')
    );

    // Reduce the whole stream to assert reducer legality + no duplicate text.
    const session = reduce(patches);
    const turn = session.turns.find((t) => t.id === 'turn-1')!;
    const userMsgs = turn.items.filter((i) => i.type === 'userMessage');
    const assistantMsgs = turn.items.filter(
      (i) => i.type === 'assistantMessage'
    );
    expect(userMsgs).toHaveLength(1);
    expect(assistantMsgs).toHaveLength(1);
    expect(assistantMsgs[0]).toMatchObject({ text: 'ok', status: 'completed' });
    expect(turn.status).toBe('completed');
    expect(turn.usage).toMatchObject({
      inputTokens: 13, // 10 + 3 summed across iterations
      outputTokens: 21,
      cacheReadTokens: 3,
      costUsd: 0.05,
    });
    // Session-updated providerSession captured once.
    const providerUpdates = patches.filter(
      (p) =>
        p.type === 'agent-session-updated-v2' && p.providerSession !== undefined
    );
    expect(providerUpdates).toHaveLength(1);

    await adapter.disconnect();
  });

  it('maps thinking, Bash, Edit, and mcp__ tool_use with tool_result closures', async () => {
    const harness = makeHarness();
    const adapter = new ClaudeProtocolAdapter(harness.spawnFn, inertRegistry());
    const patches = collectPatches(adapter);
    await adapter.connect(baseConfig());

    await adapter.sendMessage({ turnId: 'turn-tools', content: 'do work' });
    const child = harness.latest().child;
    await child.waitForFrames(1);
    child.serverWrite({
      type: 'system',
      subtype: 'init',
      session_id: 'claude-session-1',
    });

    child.serverWrite({
      type: 'assistant',
      message: {
        id: 'm-tools',
        content: [
          { type: 'thinking', thinking: 'plan' },
          {
            type: 'tool_use',
            id: 'tu-bash',
            name: 'Bash',
            input: { command: 'echo hi' },
          },
          {
            type: 'tool_use',
            id: 'tu-edit',
            name: 'Edit',
            input: { file_path: '/repo/a.ts' },
          },
          {
            type: 'tool_use',
            id: 'tu-mcp',
            name: 'mcp__github__create_issue',
            input: { title: 'x' },
          },
        ],
      },
    });
    child.serverWrite({
      type: 'user',
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'tu-bash', content: 'hi' },
        ],
      },
      tool_use_result: { stdout: 'hi\n', stderr: '' },
    });
    child.serverWrite({
      type: 'user',
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'tu-mcp', content: 'created' },
        ],
      },
      tool_use_result: { issue: 42 },
    });
    child.serverWrite(successResult());

    await waitFor(() =>
      patches.some((p) => p.type === 'agent-turn-completed-v2')
    );

    const startedTypes = patches
      .filter((p) => p.type === 'agent-item-started-v2')
      .map((p) => (p.type === 'agent-item-started-v2' ? p.item.type : ''));
    expect(startedTypes).toEqual(
      expect.arrayContaining([
        'reasoning',
        'commandExecution',
        'fileChange',
        'mcpToolCall',
      ])
    );

    const thought = patches.find(
      (patch) =>
        patch.type === 'agent-item-started-v2' &&
        patch.item.type === 'reasoning'
    );
    expect(
      thought?.type === 'agent-item-started-v2' && thought.item.card
    ).toMatchObject({
      kind: 'thought',
      title: 'plan',
      content: 'plan',
      status: 'completed',
    });

    const command = patches.find(
      (patch) =>
        patch.type === 'agent-item-updated-v2' &&
        patch.item.type === 'commandExecution'
    );
    expect(
      command?.type === 'agent-item-updated-v2' && command.item.card
    ).toMatchObject({
      kind: 'output',
      title: 'echo hi',
      command: 'echo hi',
      content: 'hi\n',
      language: 'bash',
      status: 'completed',
    });

    const file = patches.find(
      (patch) =>
        patch.type === 'agent-item-started-v2' &&
        patch.item.type === 'fileChange'
    );
    expect(
      file?.type === 'agent-item-started-v2' && file.item.card
    ).toMatchObject({
      kind: 'diff',
      title: '/repo/a.ts',
      path: '/repo/a.ts',
      status: 'pending',
    });

    const mcpUpdate = patches.find(
      (p) => p.type === 'agent-item-updated-v2' && p.item.type === 'mcpToolCall'
    );
    expect(
      mcpUpdate?.type === 'agent-item-updated-v2' && mcpUpdate.item
    ).toMatchObject({
      type: 'mcpToolCall',
      server: 'github',
      tool: 'create_issue',
      status: 'completed',
    });

    await adapter.disconnect();
  });

  it('maps a direct persistent-subprocess file patch into a populated diff card', async () => {
    const harness = makeHarness();
    const adapter = new ClaudeProtocolAdapter(harness.spawnFn, inertRegistry());
    const patches = collectPatches(adapter);
    await adapter.connect(baseConfig());
    await adapter.sendMessage({ turnId: 'turn-direct-patch', content: 'edit' });
    const child = harness.latest().child;
    await child.waitForFrames(1);
    child.serverWrite({
      type: 'system',
      subtype: 'init',
      session_id: 'claude-session-direct-patch',
    });
    child.serverWrite({
      type: 'assistant',
      message: {
        id: 'message-direct-patch',
        content: [
          {
            type: 'tool_use',
            id: 'tool-direct-patch',
            name: 'Edit',
            input: { file_path: '/workspace/example/src/direct.ts' },
          },
        ],
      },
    });
    const directPatch =
      '--- a/src/direct.ts\n+++ b/src/direct.ts\n@@ -1 +1 @@\n-old\n+new\n';
    child.serverWrite({
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tool-direct-patch',
            content: directPatch,
          },
        ],
      },
      tool_use_result: {
        filePath: '/workspace/example/src/direct.ts',
        patch: directPatch,
      },
    });
    child.serverWrite(successResult());

    await waitFor(() =>
      patches.some((patch) => patch.type === 'agent-turn-completed-v2')
    );
    const file = patches.find(
      (patch) =>
        patch.type === 'agent-item-updated-v2' &&
        patch.item.type === 'fileChange'
    );
    expect(file).toMatchObject({
      item: {
        id: 'file-tool-direct-patch',
        patch: directPatch,
        status: 'completed',
        card: {
          kind: 'diff',
          path: '/workspace/example/src/direct.ts',
          content: directPatch,
          additions: 1,
          deletions: 1,
        },
      },
    });

    await adapter.disconnect();
  });

  it('replays the sanitized Claude detail fixture into normalized cards', async () => {
    const harness = makeHarness();
    const adapter = new ClaudeProtocolAdapter(harness.spawnFn, inertRegistry());
    const patches = collectPatches(adapter);
    await adapter.connect(baseConfig());
    await adapter.sendMessage({ turnId: 'turn-fixture', content: 'fixture' });
    const child = harness.latest().child;
    await child.waitForFrames(1);

    for (const event of claudeDetailFixture.nativeEvents) {
      child.serverWrite(event);
    }
    child.serverWrite(successResult());
    await waitFor(() =>
      patches.some((patch) => patch.type === 'agent-turn-completed-v2')
    );

    const session = reduce(patches);
    const cards = session.turns
      .flatMap((turn) => turn.items)
      .flatMap((item) =>
        item.card && item.card.kind !== 'message' ? [item.card] : []
      );
    const expectedCards = claudeDetailFixture.session.turns
      .flatMap((turn) => turn.items)
      .flatMap((item) =>
        item.card && item.card.kind !== 'message' ? [item.card] : []
      );
    expect(cards).toEqual(expectedCards);
    expect(claudeDetailFixture.sanitization.containsLiveTranscriptBytes).toBe(
      false
    );

    await adapter.disconnect();
  });

  it('reuses the same subprocess for a second send and dedupes per-turn init', async () => {
    const harness = makeHarness();
    const adapter = new ClaudeProtocolAdapter(harness.spawnFn, inertRegistry());
    const patches = collectPatches(adapter);
    await adapter.connect(baseConfig());

    await adapter.sendMessage({ turnId: 'turn-1', content: 'one' });
    const child = harness.latest().child;
    await child.waitForFrames(1);
    child.serverWrite({
      type: 'system',
      subtype: 'init',
      session_id: 'claude-session-1',
    });
    child.serverWrite(successResult());
    await waitFor(() =>
      patches.some((p) => p.type === 'agent-turn-completed-v2')
    );

    await adapter.sendMessage({ turnId: 'turn-2', content: 'two' });
    await child.waitForFrames(2);
    // init re-emitted every turn — providerSession must not be re-emitted.
    child.serverWrite({
      type: 'system',
      subtype: 'init',
      session_id: 'claude-session-1',
    });
    child.serverWrite(successResult());
    await waitFor(
      () =>
        patches.filter((p) => p.type === 'agent-turn-completed-v2').length === 2
    );

    expect(harness.spawns).toHaveLength(1); // same process reused
    const providerUpdates = patches.filter(
      (p) =>
        p.type === 'agent-session-updated-v2' && p.providerSession !== undefined
    );
    expect(providerUpdates).toHaveLength(1);

    await adapter.disconnect();
  });

  it('queues a second send and starts it after the first turn completes', async () => {
    const harness = makeHarness();
    const adapter = new ClaudeProtocolAdapter(harness.spawnFn, inertRegistry());
    const patches = collectPatches(adapter);
    await adapter.connect(baseConfig());

    const first = adapter.sendMessage({ turnId: 'turn-1', content: 'one' });
    const child = harness.latest().child;
    await child.waitForFrames(1);
    const second = adapter.sendMessage({ turnId: 'turn-2', content: 'two' });
    await tick(); // second must NOT have written a frame yet
    expect(child.frames()).toHaveLength(1);

    child.serverWrite(successResult());
    await first;
    await child.waitForFrames(2);
    expect(child.frames()[1]).toMatchObject({ message: { content: 'two' } });
    child.serverWrite(successResult());
    await second;

    await waitFor(
      () =>
        patches.filter((p) => p.type === 'agent-turn-completed-v2').length === 2
    );
    const completed = patches.filter(
      (p) => p.type === 'agent-turn-completed-v2'
    );
    expect(
      completed.map((p) =>
        p.type === 'agent-turn-completed-v2' ? p.turnId : ''
      )
    ).toEqual(['turn-1', 'turn-2']);

    await adapter.disconnect();
  });

  it('routes can_use_tool to an approval and replies with request_id nested inside response (accept)', async () => {
    const harness = makeHarness();
    const adapter = new ClaudeProtocolAdapter(harness.spawnFn, inertRegistry());
    const patches = collectPatches(adapter);
    await adapter.connect(baseConfig());

    await adapter.sendMessage({ turnId: 'turn-approval', content: 'go' });
    const child = harness.latest().child;
    await child.waitForFrames(1);
    child.serverWrite({
      type: 'system',
      subtype: 'init',
      session_id: 'claude-session-1',
    });
    child.serverWrite({
      type: 'control_request',
      request_id: 'req-1',
      request: {
        subtype: 'can_use_tool',
        tool_name: 'Bash',
        input: { command: 'npm test' },
      },
    });

    await waitFor(() =>
      patches.some(
        (p) =>
          p.type === 'agent-live-state-updated-v2' &&
          p.live.waitingOn === 'approval'
      )
    );
    const approvalStart = patches.find(
      (p) => p.type === 'agent-item-started-v2' && p.item.type === 'approval'
    );
    expect(
      approvalStart?.type === 'agent-item-started-v2' && approvalStart.item
    ).toMatchObject({
      type: 'approval',
      requestId: 'req-1',
      target: 'npm test',
      supported: {
        scopes: ['once', 'permanent'],
        amendmentTypes: [],
        canCancel: false,
      },
    });

    await adapter.respondToApproval({
      requestId: 'req-1',
      decision: { kind: 'accept', scope: 'once' },
    });
    await child.waitForFrames(2);
    const reply = child.frames()[1] as {
      type: string;
      request_id?: unknown;
      response: {
        subtype: string;
        request_id: string;
        response: { behavior: string };
      };
    };
    expect(reply.type).toBe('control_response');
    // WIRE INVARIANT: request_id nests INSIDE response, never top-level.
    expect(reply.request_id).toBeUndefined();
    expect(reply.response.request_id).toBe('req-1');
    expect(reply.response.subtype).toBe('success');
    expect(reply.response.response.behavior).toBe('allow');

    child.serverWrite(successResult());
    await waitFor(() =>
      patches.some((p) => p.type === 'agent-turn-completed-v2')
    );
    await adapter.disconnect();
  });

  it('replies deny for a declined approval', async () => {
    const harness = makeHarness();
    const adapter = new ClaudeProtocolAdapter(harness.spawnFn, inertRegistry());
    const patches = collectPatches(adapter);
    await adapter.connect(baseConfig());
    await adapter.sendMessage({ turnId: 'turn-deny', content: 'go' });
    const child = harness.latest().child;
    await child.waitForFrames(1);
    child.serverWrite({
      type: 'control_request',
      request_id: 'req-deny',
      request: {
        subtype: 'can_use_tool',
        tool_name: 'Bash',
        input: { command: 'rm -rf /' },
      },
    });
    await waitFor(() =>
      patches.some(
        (p) => p.type === 'agent-item-started-v2' && p.item.type === 'approval'
      )
    );

    await adapter.respondToApproval({
      requestId: 'req-deny',
      decision: { kind: 'decline' },
    });
    await child.waitForFrames(2);
    const reply = child.frames()[1] as {
      response: {
        request_id: string;
        response: { behavior: string; message?: string };
      };
    };
    expect(reply.response.request_id).toBe('req-deny');
    expect(reply.response.response.behavior).toBe('deny');

    child.serverWrite(successResult());
    await adapter.disconnect();
  });

  it('auto-denies a stalled approval after approvalStallMs', async () => {
    const harness = makeHarness();
    const adapter = new ClaudeProtocolAdapter(harness.spawnFn, inertRegistry());
    const patches = collectPatches(adapter);
    await adapter.connect(baseConfig({ approvalStallMs: 20 }));
    await adapter.sendMessage({ turnId: 'turn-stall', content: 'go' });
    const child = harness.latest().child;
    await child.waitForFrames(1);
    child.serverWrite({
      type: 'control_request',
      request_id: 'req-stall',
      request: {
        subtype: 'can_use_tool',
        tool_name: 'Bash',
        input: { command: 'ls' },
      },
    });

    await child.waitForFrames(2); // the auto-deny reply
    const reply = child.frames()[1] as {
      response: { request_id: string; response: { behavior: string } };
    };
    expect(reply.response.request_id).toBe('req-stall');
    expect(reply.response.response.behavior).toBe('deny');
    const updated = patches.find(
      (p) => p.type === 'agent-item-updated-v2' && p.item.type === 'approval'
    );
    expect(
      updated?.type === 'agent-item-updated-v2' && updated.item
    ).toMatchObject({
      respondedBy: 'timeout',
    });

    child.serverWrite(successResult());
    await adapter.disconnect();
  });

  it('auto-cancels request_user_dialog and elicitation control requests', async () => {
    const harness = makeHarness();
    const adapter = new ClaudeProtocolAdapter(harness.spawnFn, inertRegistry());
    await adapter.connect(baseConfig());
    await adapter.sendMessage({ turnId: 'turn-dialog', content: 'go' });
    const child = harness.latest().child;
    await child.waitForFrames(1);

    child.serverWrite({
      type: 'control_request',
      request_id: 'req-dialog',
      request: { subtype: 'request_user_dialog' },
    });
    child.serverWrite({
      type: 'control_request',
      request_id: 'req-elicit',
      request: { subtype: 'elicitation' },
    });

    const frames = await child.waitForFrames(3);
    const dialog = frames.find(
      (f) =>
        (f.response as { request_id?: string } | undefined)?.request_id ===
        'req-dialog'
    ) as { response: { response: unknown } };
    const elicit = frames.find(
      (f) =>
        (f.response as { request_id?: string } | undefined)?.request_id ===
        'req-elicit'
    ) as { response: { response: unknown } };
    expect(dialog.response.response).toBe('cancelled');
    expect(elicit.response.response).toBe('cancel');

    child.serverWrite(successResult());
    await adapter.disconnect();
  });

  it('maps AskUserQuestion can_use_tool to a question item', async () => {
    const harness = makeHarness();
    const adapter = new ClaudeProtocolAdapter(harness.spawnFn, inertRegistry());
    const patches = collectPatches(adapter);
    await adapter.connect(baseConfig());
    await adapter.sendMessage({ turnId: 'turn-q', content: 'go' });
    const child = harness.latest().child;
    await child.waitForFrames(1);
    child.serverWrite({
      type: 'control_request',
      request_id: 'req-q',
      request: {
        subtype: 'can_use_tool',
        tool_name: 'AskUserQuestion',
        question: 'Which one?',
      },
    });

    await waitFor(() =>
      patches.some(
        (p) => p.type === 'agent-item-started-v2' && p.item.type === 'question'
      )
    );
    const question = patches.find(
      (p) => p.type === 'agent-item-started-v2' && p.item.type === 'question'
    );
    expect(
      question?.type === 'agent-item-started-v2' && question.item
    ).toMatchObject({
      type: 'question',
      requestId: 'req-q',
      question: 'Which one?',
    });

    child.serverWrite(successResult());
    await adapter.disconnect();
  });

  it('interrupt writes a control_request then falls back to the SIGTERM ladder on no ack', async () => {
    const harness = makeHarness();
    const adapter = new ClaudeProtocolAdapter(harness.spawnFn, inertRegistry());
    const patches = collectPatches(adapter);
    harness.setNextChildOptions({ closeOnStdinEnd: false });
    await adapter.connect(
      baseConfig({
        interruptAckMs: 20,
        teardownAfterStdinMs: 10,
        teardownAfterSigtermMs: 10,
      })
    );
    await adapter.sendMessage({ turnId: 'turn-int', content: 'long task' });
    const child = harness.latest().child;
    await child.waitForFrames(1);
    child.serverWrite({
      type: 'system',
      subtype: 'init',
      session_id: 'claude-session-1',
    });
    // The child never acks; kill() must close it so stop() resolves.
    child.kill.mockImplementation((_sig?: string) => {
      if (_sig === 'SIGKILL')
        setImmediate(() => child.emitClose(null, 'SIGKILL'));
      return true;
    });

    await adapter.interrupt({ turnId: 'turn-int' });

    const interruptFrame = child
      .frames()
      .find(
        (f) =>
          f.type === 'control_request' &&
          (f.request as { subtype?: string })?.subtype === 'interrupt'
      );
    expect(interruptFrame).toBeDefined();
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    const completed = patches.find((p) => p.type === 'agent-turn-completed-v2');
    expect(
      completed?.type === 'agent-turn-completed-v2' && completed.status
    ).toBe('interrupted');

    await adapter.disconnect();
  });

  it('reports a mid-turn crash with stderr tail and terminalizes the adapter', async () => {
    const harness = makeHarness();
    const adapter = new ClaudeProtocolAdapter(harness.spawnFn, inertRegistry());
    const patches = collectPatches(adapter);
    await adapter.connect(baseConfig());
    await adapter.sendMessage({ turnId: 'turn-crash', content: 'go' });
    const child = harness.latest().child;
    await child.waitForFrames(1);
    child.serverWrite({
      type: 'system',
      subtype: 'init',
      session_id: 'claude-abc',
    });
    child.emitStderr('fatal: boom');
    await tick();
    child.emitClose(1, null);

    await waitFor(() =>
      patches.some(
        (p) =>
          p.type === 'agent-turn-completed-v2' &&
          p.type === 'agent-turn-completed-v2' &&
          p.status === 'failed'
      )
    );
    const error = patches.find((p) => p.type === 'agent-error-v2');
    expect(error?.type === 'agent-error-v2' && error.message).toMatch(/exited/);
    expect(error?.type === 'agent-error-v2' && error.message).toMatch(/boom/);

    expect(adapter.status).toBe('disconnected');
    expect(adapter.ownedProcessRootPids()).toEqual([child.pid]);
    await expect(
      adapter.sendMessage({ turnId: 'turn-after-crash', content: 'again' })
    ).rejects.toThrow(/before connect/);
    expect(harness.spawns).toHaveLength(1);

    await adapter.disconnect();
  });

  it('requires an explicit reconnect before retrying a crashed turn', async () => {
    const harness = makeHarness();
    const adapter = new ClaudeProtocolAdapter(harness.spawnFn, inertRegistry());
    await adapter.connect(baseConfig());

    await adapter.sendMessage({ turnId: 'turn-crash', content: 'go' });
    const child = harness.latest().child;
    await child.waitForFrames(1);
    child.emitClose(1, null);
    await waitFor(() => adapter.status === 'disconnected');

    await expect(
      adapter.sendMessage({ turnId: 'turn-before-reconnect', content: 'go' })
    ).rejects.toThrow(/before connect/);

    await adapter.reconnect();
    await expect(
      adapter.sendMessage({ turnId: 'turn-after-reconnect', content: 'go' })
    ).resolves.toBeUndefined();
    expect(harness.spawns).toHaveLength(2);

    await adapter.disconnect();
  });

  it('idle eviction kills the child, stays connected, and respawns with --resume', async () => {
    const harness = makeHarness();
    const adapter = new ClaudeProtocolAdapter(harness.spawnFn, inertRegistry());
    const patches = collectPatches(adapter);
    await adapter.connect(baseConfig());
    await adapter.sendMessage({ turnId: 'turn-1', content: 'go' });
    const child = harness.latest().child;
    await child.waitForFrames(1);
    child.serverWrite({
      type: 'system',
      subtype: 'init',
      session_id: 'claude-evict',
    });
    child.serverWrite(successResult({ session_id: 'claude-evict' }));
    await waitFor(() =>
      patches.some((p) => p.type === 'agent-turn-completed-v2')
    );

    const before = patches.length;
    // Force the warm-idle → evicted transition.
    adapter.gcSweep(Date.now() + 15 * 60_000 + 5_000);
    await tick(30);

    expect(adapter.status).toBe('connected');
    // No UI-visible disconnected live-state leaked by the eviction.
    const leaked = patches
      .slice(before)
      .some(
        (p) =>
          p.type === 'agent-live-state-updated-v2' &&
          p.live.status === 'disconnected'
      );
    expect(leaked).toBe(false);

    await adapter.sendMessage({ turnId: 'turn-2', content: 'again' });
    expect(harness.spawns).toHaveLength(2);
    const args = harness.latest().args;
    expect(args[args.indexOf('--resume') + 1]).toBe('claude-evict');

    await adapter.disconnect();
  });

  it('resumeSession stores the id, emits a providerSession snapshot without spawning, then respawns with --resume', async () => {
    const harness = makeHarness();
    const adapter = new ClaudeProtocolAdapter(harness.spawnFn, inertRegistry());
    const patches = collectPatches(adapter);
    await adapter.connect({ ...baseConfig(), extra: { effort: 'high' } });

    await adapter.resumeSession('resume-xyz');
    expect(harness.spawns).toHaveLength(0);
    const resumeSnap = patches
      .filter((p) => p.type === 'agent-session-snapshot-v2')
      .at(-1);
    expect(
      resumeSnap?.type === 'agent-session-snapshot-v2' && resumeSnap.session
    ).toMatchObject({
      providerSession: { claudeSessionId: 'resume-xyz' },
      config: { effort: 'high' },
    });
    expect(
      patches
        .filter((patch) => patch.type === 'agent-live-state-updated-v2')
        .at(-1)
    ).toMatchObject({ live: { fastModeAvailable: false } });

    await adapter.sendMessage({ turnId: 'turn-1', content: 'go' });
    expect(harness.spawns).toHaveLength(1);
    const args = harness.latest().args;
    expect(args[args.indexOf('--resume') + 1]).toBe('resume-xyz');

    await adapter.disconnect();
  });

  it('frames image attachments as base64 blocks and rejects bad ones loudly', async () => {
    const harness = makeHarness();
    const adapter = new ClaudeProtocolAdapter(harness.spawnFn, inertRegistry());
    const patches = collectPatches(adapter);
    await adapter.connect(baseConfig());

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-img-'));
    const pngPath = path.join(dir, 'good.png');
    const pngBytes = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3,
    ]);
    fs.writeFileSync(pngPath, pngBytes);

    try {
      await adapter.sendMessage({
        turnId: 'turn-img',
        content: 'look',
        attachments: [
          {
            type: 'image',
            path: '/does/not/matter.bmp',
            mimeType: 'image/bmp',
          },
          { type: 'image', path: pngPath, mimeType: 'image/png' },
        ],
      });
      const child = harness.latest().child;
      const frames = await child.waitForFrames(1);
      const content = (frames[0] as { message: { content: unknown } }).message
        .content as Array<Record<string, unknown>>;
      expect(Array.isArray(content)).toBe(true);
      const imageBlock = content.find((b) => b.type === 'image') as {
        source: { media_type: string; data: string };
      };
      expect(imageBlock.source.media_type).toBe('image/png');
      expect(imageBlock.source.data).toBe(pngBytes.toString('base64'));
      // The unsupported bmp was rejected with a loud errorMessage naming the file.
      const err = patches.find(
        (p) =>
          p.type === 'agent-item-started-v2' && p.item.type === 'errorMessage'
      );
      expect(
        err?.type === 'agent-item-started-v2' &&
          (err.item as { message: string }).message
      ).toMatch(/matter\.bmp/);

      child.serverWrite(successResult());
      await adapter.disconnect();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('surfaces an ENOENT spawn failure as an install/login error', async () => {
    const spawnFn: ClaudeSpawnFn = () => {
      const err = new Error('spawn claude ENOENT') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    };
    const adapter = new ClaudeProtocolAdapter(spawnFn, inertRegistry());
    const patches = collectPatches(adapter);
    await adapter.connect(baseConfig());

    await adapter.sendMessage({ turnId: 'turn-enoent', content: 'go' });
    await waitFor(() =>
      patches.some(
        (p) =>
          p.type === 'agent-error-v2' && /not found on PATH/.test(p.message)
      )
    );
    const err = patches.find((p) => p.type === 'agent-error-v2');
    expect(err?.type === 'agent-error-v2' && err.message).toMatch(
      /claude login/
    );

    await adapter.disconnect();
  });

  it('every emitted patch passes isAgentPatchV2 (base-class guard is exercised)', async () => {
    const harness = makeHarness();
    const adapter = new ClaudeProtocolAdapter(harness.spawnFn, inertRegistry());
    const patches = collectPatches(adapter);
    await adapter.connect(baseConfig());
    await adapter.sendMessage({ turnId: 'turn-1', content: 'hi' });
    const child = harness.latest().child;
    await child.waitForFrames(1);
    child.serverWrite({ type: 'system', subtype: 'init', session_id: 's' });
    child.serverWrite(successResult());
    await waitFor(() =>
      patches.some((p) => p.type === 'agent-turn-completed-v2')
    );

    expect(patches.length).toBeGreaterThan(0);
    for (const patch of patches) expect(isAgentPatchV2(patch)).toBe(true);

    await adapter.disconnect();
  });

  it('interrupt whose ack lands after the turn already completed does not touch the drained turn', async () => {
    const harness = makeHarness();
    const adapter = new ClaudeProtocolAdapter(harness.spawnFn, inertRegistry());
    const patches = collectPatches(adapter);
    await adapter.connect(baseConfig({ interruptAckMs: 10_000 }));

    const first = adapter.sendMessage({ turnId: 'turn-A', content: 'a' });
    const child = harness.latest().child;
    await child.waitForFrames(1);
    const second = adapter.sendMessage({ turnId: 'turn-B', content: 'b' }); // queued

    const interruptP = adapter.interrupt({ turnId: 'turn-A' });
    await child.waitForFrames(2); // interrupt control_request written

    // A's own result lands first → A completes 'completed' → B drains onto the
    // warm child (its user line = frame 3).
    child.serverWrite(successResult());
    await child.waitForFrames(3);
    await first;

    // Only now does the interrupt ack arrive — it must NOT complete/kill turn B.
    child.serverWrite({
      type: 'control_response',
      response: { subtype: 'success', request_id: 'relay-int-1' },
    });
    await interruptP;

    const aCompletions = patches.filter(
      (p) => p.type === 'agent-turn-completed-v2' && p.turnId === 'turn-A'
    );
    expect(aCompletions).toHaveLength(1);
    expect(
      aCompletions[0]?.type === 'agent-turn-completed-v2' &&
        aCompletions[0].status
    ).toBe('completed'); // NOT 'interrupted'
    // B is still running — nothing completed it.
    expect(
      patches.some(
        (p) => p.type === 'agent-turn-completed-v2' && p.turnId === 'turn-B'
      )
    ).toBe(false);

    child.serverWrite(successResult());
    await second;
    const bCompletions = patches.filter(
      (p) => p.type === 'agent-turn-completed-v2' && p.turnId === 'turn-B'
    );
    expect(bCompletions).toHaveLength(1);
    expect(
      bCompletions[0]?.type === 'agent-turn-completed-v2' &&
        bCompletions[0].status
    ).toBe('completed');

    await adapter.disconnect();
  });

  it('interrupt timeout path with a queued message: A is interrupted and B survives to run', async () => {
    const harness = makeHarness();
    const adapter = new ClaudeProtocolAdapter(harness.spawnFn, inertRegistry());
    const patches = collectPatches(adapter);
    harness.setNextChildOptions({ closeOnStdinEnd: false });
    await adapter.connect(
      baseConfig({
        interruptAckMs: 20,
        teardownAfterStdinMs: 10,
        teardownAfterSigtermMs: 10,
      })
    );

    const first = adapter.sendMessage({ turnId: 'turn-A', content: 'a' });
    const child = harness.latest().child;
    await child.waitForFrames(1);
    child.kill.mockImplementation((_sig?: string) => {
      if (_sig === 'SIGKILL')
        setImmediate(() => child.emitClose(null, 'SIGKILL'));
      return true;
    });
    const second = adapter.sendMessage({ turnId: 'turn-B', content: 'b' }); // queued

    await adapter.interrupt({ turnId: 'turn-A' });
    await first;

    const aCompletion = patches.find(
      (p) => p.type === 'agent-turn-completed-v2' && p.turnId === 'turn-A'
    );
    expect(
      aCompletion?.type === 'agent-turn-completed-v2' && aCompletion.status
    ).toBe('interrupted');

    // B survives the interrupt-kill and runs on a fresh respawn.
    expect(harness.spawns).toHaveLength(2);
    const child2 = harness.latest().child;
    await child2.waitForFrames(1);
    expect(child2.frames()[0]).toMatchObject({ message: { content: 'b' } });
    child2.serverWrite(successResult());
    await second;
    const bCompletion = patches.find(
      (p) => p.type === 'agent-turn-completed-v2' && p.turnId === 'turn-B'
    );
    expect(
      bCompletion?.type === 'agent-turn-completed-v2' && bCompletion.status
    ).toBe('completed');

    await adapter.disconnect();
  });

  it('turn timeout drains a queued message onto a fresh child', async () => {
    const harness = makeHarness();
    const adapter = new ClaudeProtocolAdapter(harness.spawnFn, inertRegistry());
    const patches = collectPatches(adapter);
    await adapter.connect(baseConfig({ turnTimeoutMs: 1 }));

    await adapter.sendMessage({ turnId: 'turn-A', content: 'a' });
    const firstChild = harness.latest().child;
    await firstChild.waitForFrames(1);
    const queued = adapter.sendMessage({ turnId: 'turn-B', content: 'b' });

    adapter.gcSweep(Date.now() + 10_000);

    await waitFor(() => harness.spawns.length === 2);
    const secondChild = harness.latest().child;
    await secondChild.waitForFrames(1);
    expect(secondChild.frames()[0]).toMatchObject({
      message: { content: 'b' },
    });
    secondChild.serverWrite(successResult());
    await queued;

    expect(
      patches.some(
        (patch) =>
          patch.type === 'agent-turn-completed-v2' &&
          patch.turnId === 'turn-A' &&
          patch.status === 'failed'
      )
    ).toBe(true);
    expect(
      patches.some(
        (patch) =>
          patch.type === 'agent-turn-completed-v2' &&
          patch.turnId === 'turn-B' &&
          patch.status === 'completed'
      )
    ).toBe(true);

    await adapter.disconnect();
  });

  it('terminalizes an active unexpected close without respawning queued work', async () => {
    const harness = makeHarness();
    const adapter = new ClaudeProtocolAdapter(harness.spawnFn, inertRegistry());
    const patches = collectPatches(adapter);
    await adapter.connect(baseConfig());
    await adapter.sendMessage({ turnId: 'turn-A', content: 'a' });
    const child = harness.latest().child;
    await child.waitForFrames(1);
    const queuedResult = adapter
      .sendMessage({ turnId: 'turn-B', content: 'b' })
      .then(
        () => undefined,
        (error: unknown) => error
      );

    child.emitClose(1, null);

    await waitFor(() =>
      patches.some(
        (patch) =>
          patch.type === 'agent-live-state-updated-v2' &&
          patch.live.status === 'disconnected'
      )
    );
    expect(adapter.status).toBe('disconnected');
    expect(adapter.ownedProcessRootPids()).toEqual([child.pid]);
    await expect(queuedResult).resolves.toBeInstanceOf(Error);
    expect(harness.spawns).toHaveLength(1);

    await adapter.disconnect();
  });

  it('post-interrupt-ack stale wire lines are dropped, not attributed to the drained turn', async () => {
    const harness = makeHarness();
    const adapter = new ClaudeProtocolAdapter(harness.spawnFn, inertRegistry());
    const patches = collectPatches(adapter);
    await adapter.connect(baseConfig({ interruptAckMs: 10_000 }));

    const first = adapter.sendMessage({ turnId: 'turn-A', content: 'a' });
    const child = harness.latest().child;
    await child.waitForFrames(1);
    const second = adapter.sendMessage({ turnId: 'turn-B', content: 'b' }); // queued

    const interruptP = adapter.interrupt({ turnId: 'turn-A' });
    await child.waitForFrames(2);
    // Ack arrives (no result yet) → A interrupted, B drains onto the warm child.
    child.serverWrite({
      type: 'control_response',
      response: { subtype: 'success', request_id: 'relay-int-1' },
    });
    await interruptP;
    await first;
    await child.waitForFrames(3); // B's user line

    // Aborted turn A's trailing tail flushes onto the warm child AFTER B is
    // active — it must be suppressed, not injected into B.
    child.serverWrite({
      type: 'assistant',
      message: {
        id: 'm-A-stale',
        content: [{ type: 'text', text: 'STALE-A' }],
      },
    });
    child.serverWrite(successResult()); // A's terminal result → dropped + clears suppression

    // B's real stream follows and completes cleanly.
    child.serverWrite({
      type: 'system',
      subtype: 'init',
      session_id: 'claude-session-1',
    });
    child.serverWrite({
      type: 'stream_event',
      event: { type: 'message_start', message: { id: 'm-B' } },
    });
    child.serverWrite({
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text' },
      },
    });
    child.serverWrite({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'B-REAL' },
      },
    });
    child.serverWrite({
      type: 'stream_event',
      event: { type: 'content_block_stop', index: 0 },
    });
    child.serverWrite(successResult());
    await second;

    const bCompletions = patches.filter(
      (p) => p.type === 'agent-turn-completed-v2' && p.turnId === 'turn-B'
    );
    expect(bCompletions).toHaveLength(1); // NOT completed early by A's stale result
    expect(
      bCompletions[0]?.type === 'agent-turn-completed-v2' &&
        bCompletions[0].status
    ).toBe('completed');

    const session = reduce(patches);
    const turnB = session.turns.find((t) => t.id === 'turn-B')!;
    const assistantMsgs = turnB.items.filter(
      (i) => i.type === 'assistantMessage'
    );
    expect(assistantMsgs).toHaveLength(1);
    expect(assistantMsgs[0]).toMatchObject({ text: 'B-REAL' });
    // The stale turn-A text never leaked into turn B.
    expect(
      turnB.items.some(
        (i) => i.type === 'assistantMessage' && i.text === 'STALE-A'
      )
    ).toBe(false);

    await adapter.disconnect();
  });

  it('keeps both assistant messages in one turn (content_block index restarts per message)', async () => {
    const harness = makeHarness();
    const adapter = new ClaudeProtocolAdapter(harness.spawnFn, inertRegistry());
    const patches = collectPatches(adapter);
    await adapter.connect(baseConfig());

    await adapter.sendMessage({ turnId: 'turn-multi', content: 'go' });
    const child = harness.latest().child;
    await child.waitForFrames(1);
    child.serverWrite({
      type: 'system',
      subtype: 'init',
      session_id: 'claude-session-1',
    });

    // ── API message 1: text "first" (index 0) then a Bash tool_use (index 1) ──
    child.serverWrite({
      type: 'stream_event',
      event: { type: 'message_start', message: { id: 'm-1' } },
    });
    child.serverWrite({
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text' },
      },
    });
    child.serverWrite({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'first' },
      },
    });
    child.serverWrite({
      type: 'stream_event',
      event: { type: 'content_block_stop', index: 0 },
    });
    child.serverWrite({
      type: 'assistant',
      message: {
        id: 'm-1',
        content: [
          { type: 'text', text: 'first' },
          {
            type: 'tool_use',
            id: 'tu-1',
            name: 'Bash',
            input: { command: 'echo hi' },
          },
        ],
      },
    });
    child.serverWrite({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tu-1', content: 'hi' }],
      },
      tool_use_result: { stdout: 'hi\n', stderr: '' },
    });

    // ── API message 2: text "second" — content_block index restarts at 0 ──
    child.serverWrite({
      type: 'stream_event',
      event: { type: 'message_start', message: { id: 'm-2' } },
    });
    child.serverWrite({
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text' },
      },
    });
    child.serverWrite({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'second' },
      },
    });
    child.serverWrite({
      type: 'stream_event',
      event: { type: 'content_block_stop', index: 0 },
    });
    child.serverWrite({
      type: 'assistant',
      message: { id: 'm-2', content: [{ type: 'text', text: 'second' }] },
    });
    child.serverWrite(successResult());

    await waitFor(() =>
      patches.some((p) => p.type === 'agent-turn-completed-v2')
    );

    const session = reduce(patches);
    const turn = session.turns.find((t) => t.id === 'turn-multi')!;
    const assistantMsgs = turn.items.filter(
      (i) => i.type === 'assistantMessage'
    );
    // Both messages survive the per-message index restart (no id collision), and
    // both echoes were still dropped (exactly two, not four).
    expect(assistantMsgs).toHaveLength(2);
    expect(
      assistantMsgs.map((m) => (m.type === 'assistantMessage' ? m.text : ''))
    ).toEqual(['first', 'second']);
    expect(
      assistantMsgs.every(
        (m) => m.type === 'assistantMessage' && m.status === 'completed'
      )
    ).toBe(true);

    await adapter.disconnect();
  });

  it('keeps multiple text slots when non-text blocks shift raw stream indexes', async () => {
    const harness = makeHarness();
    const adapter = new ClaudeProtocolAdapter(harness.spawnFn, inertRegistry());
    const patches = collectPatches(adapter);
    await adapter.connect(baseConfig());

    await adapter.sendMessage({ turnId: 'turn-slots', content: 'go' });
    const child = harness.latest().child;
    await child.waitForFrames(1);
    child.serverWrite({
      type: 'stream_event',
      event: { type: 'message_start', message: { id: 'm-slots' } },
    });
    child.serverWrite({
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'thinking' },
      },
    });
    child.serverWrite({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: 'plan' },
      },
    });
    child.serverWrite({
      type: 'stream_event',
      event: { type: 'content_block_stop', index: 0 },
    });
    for (const [index, text] of [
      [1, 'first'],
      [2, 'second'],
    ] as const) {
      child.serverWrite({
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          index,
          content_block: { type: 'text' },
        },
      });
      child.serverWrite({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index,
          delta: { type: 'text_delta', text },
        },
      });
      child.serverWrite({
        type: 'stream_event',
        event: { type: 'content_block_stop', index },
      });
    }
    // The echo omits thinking, so its two text blocks are ordinals 0 and 1
    // even though the stream addressed them by raw indexes 1 and 2.
    child.serverWrite({
      type: 'assistant',
      message: {
        id: 'm-slots',
        content: [
          { type: 'text', text: 'first' },
          { type: 'text', text: 'second' },
        ],
      },
    });
    child.serverWrite(successResult());

    await waitFor(() =>
      patches.some((p) => p.type === 'agent-turn-completed-v2')
    );
    const turn = reduce(patches).turns.find((t) => t.id === 'turn-slots')!;
    const assistantMsgs = turn.items.filter(
      (item) => item.type === 'assistantMessage'
    );
    expect(assistantMsgs).toHaveLength(2);
    expect(
      assistantMsgs.map((item) =>
        item.type === 'assistantMessage' ? item.text : ''
      )
    ).toEqual(['first', 'second']);

    await adapter.disconnect();
  });

  it('does not preempt an outstanding approval with the stuck-turn kill; auto-deny keeps the turn alive', async () => {
    const harness = makeHarness();
    const adapter = new ClaudeProtocolAdapter(harness.spawnFn, inertRegistry());
    const patches = collectPatches(adapter);
    // Both deadlines small; the approval outstrips the raw turn-timeout budget.
    await adapter.connect(
      baseConfig({ turnTimeoutMs: 20, approvalStallMs: 40 })
    );
    await adapter.sendMessage({ turnId: 'turn-approve', content: 'go' });
    const child = harness.latest().child;
    await child.waitForFrames(1);
    child.serverWrite({
      type: 'control_request',
      request_id: 'req-appr',
      request: {
        subtype: 'can_use_tool',
        tool_name: 'Bash',
        input: { command: 'ls' },
      },
    });
    await waitFor(() =>
      patches.some(
        (p) =>
          p.type === 'agent-live-state-updated-v2' &&
          p.live.waitingOn === 'approval'
      )
    );

    // Drive the GC sweep well past turnTimeoutMs while the approval is still
    // outstanding — the stuck-turn kill must NOT fire.
    adapter.gcSweep(Date.now() + 10_000);
    expect(child.kill).not.toHaveBeenCalled();
    expect(
      patches.some(
        (p) =>
          p.type === 'agent-turn-completed-v2' && p.turnId === 'turn-approve'
      )
    ).toBe(false);
    expect(adapter.status).toBe('connected');

    // The approval-stall timer auto-denies (child stays warm); the turn then
    // completes normally on its result.
    await child.waitForFrames(2); // the auto-deny control_response
    const denied = patches.find(
      (p) => p.type === 'agent-item-updated-v2' && p.item.type === 'approval'
    );
    expect(
      denied?.type === 'agent-item-updated-v2' && denied.item
    ).toMatchObject({ respondedBy: 'timeout' });

    child.serverWrite(successResult());
    await waitFor(() =>
      patches.some((p) => p.type === 'agent-turn-completed-v2')
    );
    const completed = patches.find((p) => p.type === 'agent-turn-completed-v2');
    expect(
      completed?.type === 'agent-turn-completed-v2' && completed.status
    ).toBe('completed');

    await adapter.disconnect();
  });

  it('resolves pending approval cards when a turn is crash-completed (no lingering pending)', async () => {
    const harness = makeHarness();
    const adapter = new ClaudeProtocolAdapter(harness.spawnFn, inertRegistry());
    const patches = collectPatches(adapter);
    await adapter.connect(baseConfig());
    await adapter.sendMessage({ turnId: 'turn-crash-appr', content: 'go' });
    const child = harness.latest().child;
    await child.waitForFrames(1);
    child.serverWrite({
      type: 'control_request',
      request_id: 'req-orphan',
      request: {
        subtype: 'can_use_tool',
        tool_name: 'Bash',
        input: { command: 'rm x' },
      },
    });
    await waitFor(() =>
      patches.some(
        (p) => p.type === 'agent-item-started-v2' && p.item.type === 'approval'
      )
    );

    // Child crashes mid-approval.
    child.emitClose(1, null);
    await waitFor(() =>
      patches.some(
        (p) => p.type === 'agent-turn-completed-v2' && p.status === 'failed'
      )
    );

    const session = reduce(patches);
    const turn = session.turns.find((t) => t.id === 'turn-crash-appr')!;
    const approvals = turn.items.filter((i) => i.type === 'approval');
    expect(approvals.length).toBeGreaterThan(0);
    expect(approvals.every((a) => a.status !== 'pending')).toBe(true);
    expect(approvals[0]?.status).toBe('cancelled');

    await adapter.disconnect();
  });

  it('does not count interrupt-kills toward the crash-loop breaker', async () => {
    const harness = makeHarness();
    const adapter = new ClaudeProtocolAdapter(harness.spawnFn, inertRegistry());
    await adapter.connect(
      baseConfig({
        interruptAckMs: 10,
        teardownAfterStdinMs: 5,
        teardownAfterSigtermMs: 5,
      })
    );

    // Two interrupt-kills (deliberate SIGTERM/SIGKILL ladder — NOT crashes).
    for (let i = 0; i < 2; i++) {
      harness.setNextChildOptions({ closeOnStdinEnd: false });
      const send = adapter.sendMessage({ turnId: `turn-${i}`, content: 'go' });
      const child = harness.latest().child;
      await child.waitForFrames(1);
      child.kill.mockImplementation((_sig?: string) => {
        if (_sig === 'SIGKILL')
          setImmediate(() => child.emitClose(null, 'SIGKILL'));
        return true;
      });
      await adapter.interrupt({ turnId: `turn-${i}` });
      await send;
    }
    expect(harness.spawns).toHaveLength(2);

    // A third send within the 5-minute window must still spawn — the breaker
    // only counts unexpected exits, of which there were none.
    await expect(
      adapter.sendMessage({ turnId: 'turn-final', content: 'go' })
    ).resolves.toBeUndefined();
    expect(harness.spawns).toHaveLength(3);

    await adapter.disconnect();
  });

  it('replays the sanitized live fixture end-to-end to one user + one assistant message', async () => {
    const harness = makeHarness();
    const adapter = new ClaudeProtocolAdapter(harness.spawnFn, inertRegistry());
    const patches = collectPatches(adapter);
    await adapter.connect(baseConfig());
    await adapter.sendMessage({ turnId: 'turn-replay', content: 'hello' });
    const child = harness.latest().child;
    await child.waitForFrames(1);

    const here = path.dirname(fileURLToPath(import.meta.url));
    const fixturePath = path.join(
      here,
      '..',
      '..',
      'fixtures',
      'claude-stream',
      'hello.jsonl'
    );
    const lines = fs
      .readFileSync(fixturePath, 'utf8')
      .split('\n')
      .filter((l) => l.trim().length > 0);
    for (const line of lines) child.serverWrite(JSON.parse(line));

    await waitFor(() =>
      patches.some((p) => p.type === 'agent-turn-completed-v2')
    );

    const session = reduce(patches);
    const turn = session.turns.find((t) => t.id === 'turn-replay')!;
    const userMsgs = turn.items.filter((i) => i.type === 'userMessage');
    const assistantMsgs = turn.items.filter(
      (i) => i.type === 'assistantMessage'
    );
    expect(userMsgs).toHaveLength(1);
    expect(assistantMsgs).toHaveLength(1);
    expect(assistantMsgs[0]).toMatchObject({ text: 'ok', status: 'completed' });
    expect(turn.status).toBe('completed');
    // The fixture's system/init session_id was captured (and follows the hook
    // events; the system/status line follows init).
    const providerUpdate = patches.find(
      (p) =>
        p.type === 'agent-session-updated-v2' && p.providerSession !== undefined
    );
    expect(
      providerUpdate?.type === 'agent-session-updated-v2' &&
        providerUpdate.providerSession
    ).toMatchObject({
      claudeSessionId: '00000000-0000-4000-8000-000000000001',
    });

    await adapter.disconnect();
  });

  it('replays sanitized text-index drift as one assistant item', async () => {
    const harness = makeHarness();
    const adapter = new ClaudeProtocolAdapter(harness.spawnFn, inertRegistry());
    const patches = collectPatches(adapter);
    await adapter.connect(baseConfig());
    await adapter.sendMessage({ turnId: 'turn-index-drift', content: 'hello' });
    const child = harness.latest().child;
    await child.waitForFrames(1);

    const here = path.dirname(fileURLToPath(import.meta.url));
    const fixturePath = path.join(
      here,
      '..',
      '..',
      'fixtures',
      'claude-stream',
      'text-index-drift.jsonl'
    );
    const lines = fs
      .readFileSync(fixturePath, 'utf8')
      .split('\n')
      .filter((line) => line.trim().length > 0);
    for (const line of lines) child.serverWrite(JSON.parse(line));

    await waitFor(() =>
      patches.some((patch) => patch.type === 'agent-turn-completed-v2')
    );
    const turn = reduce(patches).turns.find(
      (candidate) => candidate.id === 'turn-index-drift'
    )!;
    const assistantMsgs = turn.items.filter(
      (item) => item.type === 'assistantMessage'
    );
    expect(assistantMsgs).toHaveLength(1);
    expect(assistantMsgs[0]).toMatchObject({
      text: 'synthetic answer',
      status: 'completed',
    });

    await adapter.disconnect();
  });

  it('replays two blank-id assistant messages as distinct items in one turn', async () => {
    const harness = makeHarness();
    const adapter = new ClaudeProtocolAdapter(harness.spawnFn, inertRegistry());
    const patches = collectPatches(adapter);
    await adapter.connect(baseConfig());
    await adapter.sendMessage({ turnId: 'turn-blank-ids', content: 'hello' });
    const child = harness.latest().child;
    await child.waitForFrames(1);

    const here = path.dirname(fileURLToPath(import.meta.url));
    const fixturePath = path.join(
      here,
      '..',
      '..',
      'fixtures',
      'claude-stream',
      'two-blank-message-ids.jsonl'
    );
    const lines = fs
      .readFileSync(fixturePath, 'utf8')
      .split('\n')
      .filter((line) => line.trim().length > 0);
    for (const line of lines) child.serverWrite(JSON.parse(line));

    await waitFor(() =>
      patches.some((patch) => patch.type === 'agent-turn-completed-v2')
    );
    const turn = reduce(patches).turns.find(
      (candidate) => candidate.id === 'turn-blank-ids'
    )!;
    const assistantMsgs = turn.items.filter(
      (item) => item.type === 'assistantMessage'
    );
    expect(assistantMsgs).toHaveLength(2);
    expect(
      assistantMsgs.map((item) =>
        item.type === 'assistantMessage' ? item.text : ''
      )
    ).toEqual(['synthetic first', 'synthetic second']);
    expect(new Set(assistantMsgs.map((item) => item.id)).size).toBe(2);

    await adapter.disconnect();
  });
});

// Reduce a patch stream to a session, asserting reducer legality along the way.
function reduce(patches: AgentPatchV2[]): AgentSessionV2 {
  let session: AgentSessionV2 = emptyAgentSessionV2({
    id: 'session-1',
    provider: 'claude',
    cwd: '/tmp/repo',
  });
  for (const patch of patches) {
    expect(isAgentPatchV2(patch)).toBe(true);
    session = applyAgentPatchV2(session, patch);
  }
  return session;
}
