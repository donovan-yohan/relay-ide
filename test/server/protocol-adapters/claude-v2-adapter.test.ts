import { describe, it, expect } from 'vitest';
import { ClaudeProtocolAdapterV2 } from '../../../server/protocol-adapters/claude-v2-adapter.js';

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
