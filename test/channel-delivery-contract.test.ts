import { describe, expect, it } from 'vitest';

import {
  ChannelDeliveryContractParseError,
  parseChannelDeliveryContract,
  parseChannelDeliveryExpectation,
} from '../shared/channel-delivery-contract.js';
import { evaluateDeliveryContract } from '../server/channel-delivery-contract-evaluator.js';

describe('channel delivery contract parsing (#1569)', () => {
  it('parses the supported kinds', () => {
    expect(parseChannelDeliveryExpectation('commit')).toEqual({
      kind: 'commit',
    });
    expect(parseChannelDeliveryExpectation('pr')).toEqual({ kind: 'pr' });
    expect(parseChannelDeliveryExpectation('pr:feat/x')).toEqual({
      kind: 'pr',
      branch: 'feat/x',
    });
    expect(parseChannelDeliveryExpectation('file:docs/README.md')).toEqual({
      kind: 'file',
      path: 'docs/README.md',
    });
    expect(parseChannelDeliveryExpectation('text:hello')).toEqual({
      kind: 'text',
      regex: 'hello',
    });
  });

  it('rejects unknown kinds and invalid regex', () => {
    expect(() => parseChannelDeliveryExpectation('nope')).toThrow(
      ChannelDeliveryContractParseError
    );
    expect(() => parseChannelDeliveryExpectation('text:(')).toThrow(
      ChannelDeliveryContractParseError
    );
    expect(() => parseChannelDeliveryExpectation('text:(a+)+$')).toThrow(
      ChannelDeliveryContractParseError
    );
    expect(() => parseChannelDeliveryExpectation('text:(a)\\1')).toThrow(
      ChannelDeliveryContractParseError
    );
  });

  it('rejects absolute file paths', () => {
    expect(() => parseChannelDeliveryExpectation('file:/etc/passwd')).toThrow(
      ChannelDeliveryContractParseError
    );
  });

  it('rejects file paths that escape the routing cwd', () => {
    expect(() =>
      parseChannelDeliveryExpectation('file:../../etc/passwd')
    ).toThrow(ChannelDeliveryContractParseError);
  });

  it('parses a full contract and trims specs', () => {
    const contract = parseChannelDeliveryContract([
      ' commit ',
      'file:README.md',
    ]);
    expect(contract?.expect).toEqual(['commit', 'file:README.md']);
    expect(contract?.parsed.map((p) => p.kind)).toEqual(['commit', 'file']);
  });
});

describe('channel delivery contract evaluator (pure; injected probes)', () => {
  it('evaluates unmet items deterministically without touching network', async () => {
    const result = await evaluateDeliveryContract(
      {
        expect: ['commit', 'pr:feat/x', 'file:README.md', 'text:done'],
        cwd: '/tmp/repo',
        finalAssistantText: 'not yet',
      },
      {
        git: {
          currentBranch: async () => ({ kind: 'ok', value: 'feat/x' }),
          aheadCount: async () => ({ kind: 'ok', value: 0 }),
        },
        pr: {
          hasOpenPrForBranch: async () => ({ kind: 'ok', value: false }),
        },
        fs: {
          exists: async () => ({ kind: 'ok', value: false }),
        },
      }
    );
    expect(result.met).toBe(false);
    expect(result.unmet).toEqual([
      'commit',
      'pr:feat/x',
      'file:README.md',
      'text:done',
    ]);
    expect(result.unknown).toEqual([]);
  });

  it('reports met when all expectations pass', async () => {
    const result = await evaluateDeliveryContract(
      {
        expect: ['commit', 'pr', 'file:out.txt', 'text:hello'],
        cwd: '/tmp/repo',
        finalAssistantText: 'hello world',
      },
      {
        git: {
          currentBranch: async () => ({ kind: 'ok', value: 'feat/y' }),
          aheadCount: async () => ({ kind: 'ok', value: 1 }),
        },
        pr: {
          hasOpenPrForBranch: async (branch) => ({
            kind: 'ok',
            value: branch === 'feat/y',
          }),
        },
        fs: {
          exists: async (p) => ({ kind: 'ok', value: p === 'out.txt' }),
        },
      }
    );
    expect(result).toEqual({ met: true, unmet: [], unknown: [] });
  });

  it('caps text matching at 64KiB', async () => {
    const text = `${'a'.repeat(64 * 1024)}Z`;
    const result = await evaluateDeliveryContract(
      {
        expect: ['text:Z$'],
        cwd: '/tmp/repo',
        finalAssistantText: text,
      },
      {
        git: {
          currentBranch: async () => ({ kind: 'ok', value: null }),
          aheadCount: async () => ({ kind: 'ok', value: 0 }),
        },
        pr: {
          hasOpenPrForBranch: async () => ({ kind: 'ok', value: false }),
        },
        fs: {
          exists: async () => ({ kind: 'ok', value: false }),
        },
      }
    );
    expect(result.unmet).toEqual(['text:Z$']);
  });

  it('returns promptly for a pathological pattern under the match budget', async () => {
    const start = Date.now();
    const result = await evaluateDeliveryContract(
      {
        expect: ['text:^(a|aa)+$'],
        cwd: '/tmp/repo',
        finalAssistantText: 'a'.repeat(50_000),
      },
      {
        git: {
          currentBranch: async () => ({ kind: 'ok', value: null }),
          aheadCount: async () => ({ kind: 'ok', value: 0 }),
        },
        pr: {
          hasOpenPrForBranch: async () => ({ kind: 'ok', value: false }),
        },
        fs: {
          exists: async () => ({ kind: 'ok', value: false }),
        },
      }
    );
    expect(Date.now() - start).toBeLessThan(1000);
    expect(typeof result.met).toBe('boolean');
  });
});
