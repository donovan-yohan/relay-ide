import { describe, expect, it } from 'vitest';
import {
  buildHermesInstructions,
  buildRelayHermesSessionInstructions,
  resolveHermesGatewaySettings,
} from '../server/protocol-adapters/hermes-adapter.js';

describe('buildHermesInstructions', () => {
  it('combines systemPrompt and instructions', () => {
    expect(
      buildHermesInstructions({
        systemPrompt: 'You are the ops channel bot.',
        instructions: 'Prefer terse answers.',
      })
    ).toBe('You are the ops channel bot.\n\nPrefer terse answers.');
  });

  it('returns a single part when only one is set', () => {
    expect(buildHermesInstructions({ systemPrompt: 'sys' })).toBe('sys');
    expect(buildHermesInstructions({ instructions: 'inst' })).toBe('inst');
  });

  it('returns undefined when there is nothing to send', () => {
    expect(buildHermesInstructions({})).toBeUndefined();
    expect(buildHermesInstructions(undefined)).toBeUndefined();
    expect(
      buildHermesInstructions({ systemPrompt: '  ', instructions: null })
    ).toBeUndefined();
  });
});

describe('buildRelayHermesSessionInstructions', () => {
  it('builds a per-thread Relay context block for upstream Hermes instructions', () => {
    const instructions = buildRelayHermesSessionInstructions({
      sessionId: 'sess-1',
      cwd: '/repo/relay-ide',
      metadata: {
        relay_workspace_id: 'workspace-1',
        relay_topic_id: 'topic-1',
        relay_repo_path: '/repo/relay-ide',
        relay_worktree_path: '/repo/relay-ide/.worktrees/feature',
        relay_branch: 'feature',
        relay_node_id: 'local',
      },
    });

    expect(instructions).toContain('Relay session context:');
    expect(instructions).toContain('- relay_session_id: sess-1');
    expect(instructions).toContain('- cwd: /repo/relay-ide');
    expect(instructions).toContain('- repo_path: /repo/relay-ide');
    expect(instructions).toContain(
      '- worktree_path: /repo/relay-ide/.worktrees/feature'
    );
  });

  it('returns undefined when there is no session context to send', () => {
    expect(buildRelayHermesSessionInstructions({})).toBeUndefined();
  });
});

// Live: proves the gateway accepts channel instructions on a responses request.
describe('live Hermes gateway channel instructions', () => {
  it('accepts an instructions-tagged responses request', async () => {
    const settings = resolveHermesGatewaySettings(undefined);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(settings.apiKey
        ? { Authorization: `Bearer ${settings.apiKey}` }
        : {}),
    };
    let reachable: boolean;
    try {
      const health = await fetch(`${settings.endpoint}/health`, {
        headers,
        signal: AbortSignal.timeout(1000),
      });
      reachable = health.ok;
    } catch {
      reachable = false;
    }
    if (!reachable) {
      // eslint-disable-next-line no-console
      console.log('[skip] no live Hermes gateway at', settings.endpoint);
      return;
    }
    const instructions = buildHermesInstructions({
      systemPrompt: 'You are a relay channel assistant.',
      instructions: 'Reply in one short sentence.',
    });
    const res = await fetch(`${settings.endpoint}/v1/responses`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        input: 'ping',
        stream: false,
        store: true,
        session_id: 'relay-channel-instr-itest',
        instructions,
      }),
      signal: AbortSignal.timeout(60000),
    });
    expect(res.ok).toBe(true);
  });
});
