import type { ProtocolAdapterV2 } from '../protocol-adapter-v2.js';
import { MockProtocolAdapterV2 } from './mock-v2-adapter.js';
import { ClaudeProtocolAdapter } from './claude-adapter.js';
import { LegacyProtocolAdapterV2Bridge } from './legacy-v2-bridge.js';
import { OpenCodeProtocolAdapter } from './opencode-adapter.js';
import {
  OpenCodeAttachedAdapter,
  probeOpenCodeAttachedApi,
} from './opencode-attached-adapter.js';
import {
  HermesProtocolAdapter,
  probeHermesGatewayApi,
} from './hermes-adapter.js';
import { CodexNativeProtocolAdapter } from './codex-native-adapter.js';
import { PrimeAgentProtocolAdapter } from './prime-agent-adapter.js';
import { PiAgentProtocolAdapter } from './pi-agent-adapter.js';
import {
  CLAUDE_CHANNEL_COMMAND,
  CODEX_CHANNEL_COMMAND,
  OPENCODE_CHANNEL_COMMAND,
  PI_AGENT_CHANNEL_COMMAND,
  PRIME_AGENT_CHANNEL_COMMAND,
} from './launch-commands.js';

/**
 * External process requirement for a channel adapter. Kept beside the adapter
 * factories so availability probes cannot drift toward terminal-only framework
 * overrides that the channel adapter never consumes.
 */
export interface ChannelGatewayProbeResult {
  available: boolean;
  endpoint: string;
  reason?: string;
}

export type ChannelGatewayProbe = (
  extra: Record<string, unknown> | undefined,
  timeoutMs?: number
) => Promise<ChannelGatewayProbeResult>;

export type ChannelAdapterLaunchRequirement =
  | { kind: 'command'; command: string }
  | { kind: 'gateway'; gateway: string; probe: ChannelGatewayProbe }
  | { kind: 'embedded' };

export interface ChannelAdapterLaunchContract {
  requirement: ChannelAdapterLaunchRequirement;
  /** Keys that a named profile may not reintroduce into a child process. */
  processEnvDenylist: readonly string[];
}

export const v2Adapters = {
  mock: () => new MockProtocolAdapterV2(),
  claude: () => new ClaudeProtocolAdapter(),
  codex: () => new CodexNativeProtocolAdapter(),
  'prime-agent': () => new PrimeAgentProtocolAdapter(),
  pi: () => new PiAgentProtocolAdapter(),
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
} satisfies Record<string, () => ProtocolAdapterV2>;

/**
 * Kept exhaustive against the adapter factory keys. Adding a registered adapter
 * without declaring how it launches is therefore a type error rather than a
 * silently unavailable roster entry.
 */
export const CHANNEL_ADAPTER_LAUNCH_CONTRACTS = {
  mock: { requirement: { kind: 'embedded' }, processEnvDenylist: [] },
  claude: {
    requirement: { kind: 'command', command: CLAUDE_CHANNEL_COMMAND },
    processEnvDenylist: ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT'],
  },
  codex: {
    requirement: { kind: 'command', command: CODEX_CHANNEL_COMMAND },
    processEnvDenylist: ['CLAUDECODE'],
  },
  'prime-agent': {
    requirement: { kind: 'command', command: PRIME_AGENT_CHANNEL_COMMAND },
    processEnvDenylist: ['CLAUDECODE'],
  },
  pi: {
    requirement: { kind: 'command', command: PI_AGENT_CHANNEL_COMMAND },
    processEnvDenylist: ['CLAUDECODE'],
  },
  opencode: {
    requirement: { kind: 'command', command: OPENCODE_CHANNEL_COMMAND },
    processEnvDenylist: [
      'CLAUDECODE',
      'OPENCODE_SERVER_PASSWORD',
      'OPENCODE_SERVER_USERNAME',
    ],
  },
  'opencode-attached': {
    requirement: {
      kind: 'gateway',
      gateway: 'opencode-attached',
      probe: probeOpenCodeAttachedApi,
    },
    processEnvDenylist: [],
  },
  // Hermes channel sessions attach to the HTTP gateway and spawn no local CLI.
  hermes: {
    requirement: {
      kind: 'gateway',
      gateway: 'hermes',
      probe: probeHermesGatewayApi,
    },
    processEnvDenylist: [],
  },
} satisfies Record<keyof typeof v2Adapters, ChannelAdapterLaunchContract>;

export function channelAdapterLaunchRequirement(
  providerId: string
): ChannelAdapterLaunchRequirement | undefined {
  return (
    CHANNEL_ADAPTER_LAUNCH_CONTRACTS as Record<
      string,
      ChannelAdapterLaunchContract
    >
  )[providerId]?.requirement;
}

export function sanitizeChannelAdapterProcessEnv(
  providerId: string,
  processEnv: Record<string, string>,
  platform: NodeJS.Platform = process.platform
): Record<string, string> {
  const sanitized = { ...processEnv };
  const contract = (
    CHANNEL_ADAPTER_LAUNCH_CONTRACTS as Record<
      string,
      ChannelAdapterLaunchContract
    >
  )[providerId];
  const denied = contract?.processEnvDenylist ?? [];
  if (platform === 'win32') {
    const foldedDenylist = new Set(denied.map((key) => key.toUpperCase()));
    for (const key of Object.keys(sanitized)) {
      if (foldedDenylist.has(key.toUpperCase())) delete sanitized[key];
    }
  } else {
    for (const key of denied) delete sanitized[key];
  }
  return sanitized;
}

export function createAdapterV2(agentType: string): ProtocolAdapterV2 {
  const factory = (v2Adapters as Record<string, () => ProtocolAdapterV2>)[
    agentType
  ];
  if (!factory)
    throw new Error(
      `No v2 protocol adapter registered for agent type: ${agentType}`
    );
  return factory();
}
