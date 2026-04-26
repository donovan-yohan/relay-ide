import { describe, it, expect } from 'vitest';
import { ClaudeProtocolAdapterV2 } from '../../../server/protocol-adapters/claude-v2-adapter.js';

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
