import type { ProtocolAdapterV2 } from '../protocol-adapter-v2.js';
import { MockProtocolAdapterV2 } from './mock-v2-adapter.js';
import { ClaudeProtocolAdapter } from './claude-adapter.js';
import { LegacyProtocolAdapterV2Bridge } from './legacy-v2-bridge.js';
import { OpenCodeProtocolAdapter } from './opencode-adapter.js';
import { OpenCodeAttachedAdapter } from './opencode-attached-adapter.js';
import { HermesProtocolAdapter } from './hermes-adapter.js';
import { CodexNativeProtocolAdapter } from './codex-native-adapter.js';

export const v2Adapters: Record<string, () => ProtocolAdapterV2> = {
  mock: () => new MockProtocolAdapterV2(),
  claude: () => new ClaudeProtocolAdapter(),
  codex: () => new CodexNativeProtocolAdapter(),
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
      // `OpenCodeProtocolAdapter.handleMessagePartUpdated` fires
      // `chat:text-delta` per `message.part.updated`, and
      // `mapChatEventToAgentPatchV2` DOES have a case for it, so the bridge
      // really does surface `agent-item-delta-v2` token-by-token. Unlike the
      // hermes `telemetry` gap below, the compat mapping exists — the flag was
      // just never set.
      streaming: true,
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
      // Same as `opencode`: the attached adapter's `message.part.updated`
      // handler fires `chat:text-delta` whenever the event carries a string
      // delta.
      streaming: true,
    }),
  hermes: () =>
    new LegacyProtocolAdapterV2Bridge(new HermesProtocolAdapter(), {
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
      resume: true,
      // `HermesProtocolAdapter` emits `chat:telemetry`, but
      // `mapChatEventToAgentPatchV2` has no case for it yet, so
      // `LegacyProtocolAdapterV2Bridge` silently drops it before it reaches the
      // V2 stream/UI (same pre-existing gap as opencode/opencode-attached
      // above). Keep this `false` until that compat mapping exists so the
      // capability bit doesn't advertise a feature that can't render.
      telemetry: false,
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
