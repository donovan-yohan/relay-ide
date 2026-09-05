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
  });

  it('rejects absolute file paths', () => {
    expect(() => parseChannelDeliveryExpectation('file:/etc/passwd')).toThrow(
      ChannelDeliveryContractParseError
    );
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
          currentBranch: async () => 'feat/x',
          aheadCount: async () => 0,
        },
        pr: {
          hasOpenPrForBranch: async () => false,
        },
        fs: {
          exists: async () => false,
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
          currentBranch: async () => 'feat/y',
          aheadCount: async () => 1,
        },
        pr: {
          hasOpenPrForBranch: async (branch) => branch === 'feat/y',
        },
        fs: {
          exists: async (p) => p === 'out.txt',
        },
      }
    );
    expect(result).toEqual({ met: true, unmet: [] });
  });
});
