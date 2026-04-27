import { describe, expect, it } from 'vitest';
import { createAdapterV2 } from '../../../server/protocol-adapters/index.js';
import { LegacyProtocolAdapterV2Bridge } from '../../../server/protocol-adapters/legacy-v2-bridge.js';

describe('Hermes V2 web adapter registration', () => {
  it('registers hermes as a ProtocolAdapterV2 bridge while native gateway mapping is ported', () => {
    const adapter = createAdapterV2('hermes');

    expect(adapter).toBeInstanceOf(LegacyProtocolAdapterV2Bridge);
    expect(adapter.agentType).toBe('hermes');
    expect(adapter.capabilities).toMatchObject({
      text: true,
      commandExecution: true,
      fileChanges: true,
      approvals: true,
      interrupt: true,
    });
  });
});
