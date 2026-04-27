import type { ProtocolAdapter } from '../protocol-adapter.js';
import type { ProtocolAdapterV2 } from '../protocol-adapter-v2.js';
import { MockProtocolAdapter } from './mock-adapter.js';
import { MockProtocolAdapterV2 } from './mock-v2-adapter.js';
import { CodexProtocolAdapter } from './codex-adapter.js';
import { ClaudeProtocolAdapter } from './claude-adapter.js';
import { LegacyProtocolAdapterV2Bridge } from './legacy-v2-bridge.js';
import { OpenCodeProtocolAdapter } from './opencode-adapter.js';
import { OpenCodeAttachedAdapter } from './opencode-attached-adapter.js';

import { HermesProtocolAdapter } from './hermes-adapter.js';

export const adapters: Record<string, () => ProtocolAdapter> = {
  mock: () => new MockProtocolAdapter(),
  codex: () => new CodexProtocolAdapter(),
  opencode: () => new OpenCodeProtocolAdapter(),
  'opencode-attached': () => new OpenCodeAttachedAdapter(),
  hermes: () => new HermesProtocolAdapter(),
};

export function createAdapter(agentType: string): ProtocolAdapter {
  const factory = adapters[agentType];
  if (!factory)
    throw new Error(
      `No protocol adapter registered for agent type: ${agentType}`
    );
  return factory();
}

export const v2Adapters: Record<string, () => ProtocolAdapterV2> = {
  mock: () => new MockProtocolAdapterV2(),
  claude: () => new ClaudeProtocolAdapter(),
  codex: () =>
    new LegacyProtocolAdapterV2Bridge(new CodexProtocolAdapter(), {
      text: true,
      reasoning: true,
      tools: true,
      commandExecution: true,
      fileChanges: true,
      approvals: true,
      slashCommands: false,
      queue: false,
      interrupt: true,
      cancelQueued: false,
      resume: false,
      telemetry: true,
      rateLimits: true,
    }),
  opencode: () =>
    new LegacyProtocolAdapterV2Bridge(new OpenCodeProtocolAdapter(), {
      text: true,
      reasoning: true,
      tools: true,
      commandExecution: true,
      fileChanges: true,
      approvals: true,
      slashCommands: false,
      queue: false,
      interrupt: true,
      cancelQueued: false,
      resume: false,
      telemetry: true,
    }),
  'opencode-attached': () =>
    new LegacyProtocolAdapterV2Bridge(new OpenCodeAttachedAdapter(), {
      text: true,
      reasoning: true,
      tools: true,
      commandExecution: true,
      fileChanges: true,
      approvals: true,
      slashCommands: false,
      queue: false,
      interrupt: true,
      cancelQueued: false,
      resume: false,
      telemetry: true,
    }),
};

export function createAdapterV2(agentType: string): ProtocolAdapterV2 {
  const factory = v2Adapters[agentType];
  if (!factory)
    throw new Error(
      `No v2 protocol adapter registered for agent type: ${agentType}`
    );
  return factory();
}
