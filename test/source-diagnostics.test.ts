import type { IncomingMessage } from 'node:http';
import type { Request } from 'express';
import { describe, expect, it } from 'vitest';
import {
  evaluateRelayNodeSource,
  sourceTupleFromIncomingMessage,
  sourceTupleFromRequest,
  sourcesMatch,
} from '../server/node-source-diagnostics.js';

function fakeExpressRequest(input: {
  remoteAddress?: string;
  ip?: string;
  headers?: Record<string, string>;
}): Request {
  const headers = new Map(
    Object.entries(input.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value])
  );
  return {
    socket: { remoteAddress: input.remoteAddress },
    ip: input.ip,
    header: (name: string) => headers.get(name.toLowerCase()),
  } as unknown as Request;
}

function fakeIncomingMessage(input: {
  remoteAddress?: string;
  headers?: Record<string, string>;
}): IncomingMessage {
  return {
    socket: { remoteAddress: input.remoteAddress },
    headers: input.headers ?? {},
  } as unknown as IncomingMessage;
}

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

  it('ignores caller-controlled source headers on HTTP requests', () => {
    expect(
      sourceTupleFromRequest(
        fakeExpressRequest({
          remoteAddress: '127.0.0.1',
          ip: '127.0.0.1',
          headers: {
            'x-relay-node-tailnet-ip': '100.64.0.9',
            'x-relay-node-magicdns-name': 'forged.tailnet.ts.net',
          },
        })
      )
    ).toBeUndefined();

    expect(
      sourceTupleFromRequest(
        fakeExpressRequest({
          remoteAddress: '100.64.0.10',
          ip: '100.64.0.10',
          headers: { 'x-relay-node-tailnet-ip': '100.64.0.9' },
        })
      )
    ).toEqual({ tailnetIp: '100.64.0.10' });
  });

  it('ignores caller-controlled source headers on websocket upgrade requests', () => {
    expect(
      sourceTupleFromIncomingMessage(
        fakeIncomingMessage({
          remoteAddress: '127.0.0.1',
          headers: {
            'x-relay-node-tailnet-ip': '100.64.0.9',
            'x-relay-node-magicdns-name': 'forged.tailnet.ts.net',
          },
        })
      )
    ).toBeUndefined();

    expect(
      sourceTupleFromIncomingMessage(
        fakeIncomingMessage({
          remoteAddress: '100.64.0.10',
          headers: { 'x-relay-node-tailnet-ip': '100.64.0.9' },
        })
      )
    ).toEqual({ tailnetIp: '100.64.0.10' });
  });
});
