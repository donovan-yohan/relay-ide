import type { ProtocolAdapter } from '../protocol-adapter.js';
import { MockProtocolAdapter } from './mock-adapter.js';

export const adapters: Record<string, () => ProtocolAdapter> = {
  mock: () => new MockProtocolAdapter(),
};

export function createAdapter(agentType: string): ProtocolAdapter {
  const factory = adapters[agentType];
  if (!factory)
    throw new Error(
      `No protocol adapter registered for agent type: ${agentType}`
    );
  return factory();
}
