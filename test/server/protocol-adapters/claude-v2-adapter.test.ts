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
