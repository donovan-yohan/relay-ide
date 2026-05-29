import { describe, expect, it } from 'vitest';
import {
  evaluateRelayNodeSource,
  sourcesMatch,
} from '../server/node-source-diagnostics.js';

describe('relay node source diagnostics', () => {
  it('strict-denies unavailable source when a Tailscale source is already bound', () => {
    const evaluation = evaluateRelayNodeSource({
      expected: { tailnetIp: '100.64.0.9' },
      observed: undefined,
      strictDeny: true,
      now: '2026-01-02T03:04:05.000Z',
    });

    expect(evaluation.matchesExpected).toBe(false);
    expect(evaluation.diagnostics).toMatchObject({
      state: 'strict-deny',
      policy: 'strict-deny',
      reasonCode: 'NODE_SOURCE_STRICT_DENY',
    });
  });

  it('matches stable Tailscale signals even when hostname display hints change', () => {
    expect(
      sourcesMatch(
        {
          tailnetIp: '100.64.0.9',
          magicDnsName: 'old-host.tailnet.ts.net',
          hostname: 'old-host',
        },
        {
          tailnetIp: '100.64.0.9',
          magicDnsName: 'new-host.tailnet.ts.net',
          hostname: 'new-host',
        }
      )
    ).toBe(true);
  });

  it('normalizes uppercase IPv4-mapped Tailscale addresses', () => {
    const evaluation = evaluateRelayNodeSource({
      expected: { tailnetIp: '100.64.0.9' },
      observed: { tailnetIp: '::FFFF:100.64.0.9' },
      now: '2026-01-02T03:04:05.000Z',
    });

    expect(evaluation.matchesExpected).toBe(true);
    expect(evaluation.normalizedObserved).toMatchObject({ tailnetIp: '100.64.0.9' });
    expect(evaluation.diagnostics.state).toBe('source-match');
  });
});
