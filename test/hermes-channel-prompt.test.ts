import { describe, expect, it } from 'vitest';
import {
  buildHermesInstructions,
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
