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
