import { describe, expect, it } from 'vitest';
import { createAdapterV2 } from '../../../server/protocol-adapters/index.js';
import { LegacyProtocolAdapterV2Bridge } from '../../../server/protocol-adapters/legacy-v2-bridge.js';

describe('OpenCode V2 web adapter registration', () => {
  it('registers opencode as a ProtocolAdapterV2 bridge while native mapping is ported', () => {
    const adapter = createAdapterV2('opencode');

    expect(adapter).toBeInstanceOf(LegacyProtocolAdapterV2Bridge);
    expect(adapter.agentType).toBe('opencode');
    expect(adapter.capabilities).toMatchObject({
      text: true,
      commandExecution: true,
      fileChanges: true,
      approvals: true,
      interrupt: true,
      telemetry: true,
    });
  });

  it('registers opencode-attached as a ProtocolAdapterV2 bridge', () => {
    const adapter = createAdapterV2('opencode-attached');

    expect(adapter).toBeInstanceOf(LegacyProtocolAdapterV2Bridge);
    expect(adapter.agentType).toBe('opencode');
  });
});
