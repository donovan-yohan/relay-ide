import { describe, expect, it } from 'vitest';
import {
  buildRelayHermesMetadata,
  resolveHermesGatewaySettings,
  sanitizeResponsesMetadata,
} from '../server/protocol-adapters/hermes-adapter.js';

describe('sanitizeResponsesMetadata', () => {
  it('coerces an object to a bounded string map', () => {
    expect(sanitizeResponsesMetadata({ a: 'x', n: 3, b: true })).toEqual({
      a: 'x',
      n: '3',
      b: 'true',
    });
  });

  it('drops null/undefined values and returns undefined when empty', () => {
    expect(
      sanitizeResponsesMetadata({ a: null, b: undefined })
    ).toBeUndefined();
    expect(sanitizeResponsesMetadata({})).toBeUndefined();
  });

  it('rejects non-objects', () => {
    expect(sanitizeResponsesMetadata('nope')).toBeUndefined();
    expect(sanitizeResponsesMetadata(['a'])).toBeUndefined();
    expect(sanitizeResponsesMetadata(null)).toBeUndefined();
  });

  it('caps at 16 keys and bounds value length', () => {
    const many: Record<string, number> = {};
    for (let i = 0; i < 40; i++) many[`k${i}`] = i;
    expect(Object.keys(sanitizeResponsesMetadata(many) ?? {})).toHaveLength(16);
    const long = sanitizeResponsesMetadata({ big: 'a'.repeat(1000) });
    expect(long?.big.length).toBe(512);
  });
});

describe('buildRelayHermesMetadata', () => {
  it('includes only present anchors under relay_ keys', () => {
    expect(
      buildRelayHermesMetadata({
        topicId: 'topic:alpha',
        workspaceId: 'ws:alpha',
        repoPath: '/repo/relay',
        branchName: 'nightly',
        nodeId: 'local',
      })
    ).toEqual({
      relay_topic_id: 'topic:alpha',
      relay_workspace_id: 'ws:alpha',
      relay_repo_path: '/repo/relay',
      relay_branch: 'nightly',
      relay_node_id: 'local',
    });
  });

  it('omits absent anchors', () => {
    expect(
      buildRelayHermesMetadata({ topicId: 'topic:x', repoPath: null })
    ).toEqual({ relay_topic_id: 'topic:x' });
  });
});

// Live integration: only runs when a real Hermes gateway is reachable (skips in
// CI). Proves the live gateway accepts our metadata shape on /v1/responses.
describe('live Hermes gateway metadata acceptance', () => {
  it('accepts a metadata-tagged responses request', async () => {
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
    const metadata = buildRelayHermesMetadata({
      topicId: 'topic:relay-test',
      repoPath: '/repo/relay',
      nodeId: 'local',
    });
    const res = await fetch(`${settings.endpoint}/v1/responses`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        input: 'ok',
        stream: false,
        store: true,
        session_id: 'relay-metadata-itest',
        metadata,
      }),
      signal: AbortSignal.timeout(30000),
    });
    expect(res.ok).toBe(true);
  });
});
