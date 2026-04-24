import type { ProtocolAdapter } from '../protocol-adapter.js';
import { MockProtocolAdapter } from './mock-adapter.js';
import { ClaudeProtocolAdapter } from './claude-adapter.js';
import { CodexProtocolAdapter } from './codex-adapter.js';
import { OpenCodeProtocolAdapter } from './opencode-adapter.js';
import { OpenCodeAttachedAdapter } from './opencode-attached-adapter.js';

export const adapters: Record<string, () => ProtocolAdapter> = {
  mock: () => new MockProtocolAdapter(),
  claude: () => new ClaudeProtocolAdapter(),
  codex: () => new CodexProtocolAdapter(),
  opencode: () => new OpenCodeProtocolAdapter(),
  'opencode-attached': () => new OpenCodeAttachedAdapter(),
};

export function createAdapter(agentType: string): ProtocolAdapter {
  const factory = adapters[agentType];
  if (!factory)
    throw new Error(
      `No protocol adapter registered for agent type: ${agentType}`
    );
  return factory();
}
