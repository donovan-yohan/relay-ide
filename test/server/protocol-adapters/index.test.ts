import { describe, it, expect } from 'vitest';
import { createAdapterV2 } from '../../../server/protocol-adapters/index.js';
import { ClaudeProtocolAdapterV2 } from '../../../server/protocol-adapters/claude-v2-adapter.js';
import { MockProtocolAdapterV2 } from '../../../server/protocol-adapters/mock-v2-adapter.js';

describe('createAdapterV2', () => {
  it('returns MockProtocolAdapterV2 for "mock"', () => {
    expect(createAdapterV2('mock')).toBeInstanceOf(MockProtocolAdapterV2);
  });

  it('returns ClaudeProtocolAdapterV2 for "claude"', () => {
    expect(createAdapterV2('claude')).toBeInstanceOf(ClaudeProtocolAdapterV2);
  });

  it('throws for unknown agent type', () => {
    expect(() => createAdapterV2('definitely-not-real')).toThrow(
      /v2 protocol adapter/i
    );
  });
});
