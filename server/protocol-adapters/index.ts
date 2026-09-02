import type { ProtocolAdapterV2 } from '../protocol-adapter-v2.js';
import type { AgentCapabilitySetV2 } from '../../shared/agent-chat-protocol-v2.js';
import {
  EMPTY_RELAY_CONTROL_CATALOG,
  RELAY_CONTROL_CATALOGS,
  type RelayControlCatalog,
} from '../../shared/agent-command-catalog.js';
import type { BuiltinFrameworkId } from '../types.js';
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
import { AntigravityProtocolAdapter } from './antigravity-adapter.js';
import { DshProtocolAdapter } from './dsh-adapter.js';
import {
  ANTIGRAVITY_ENV_DENYLIST,
  CLAUDE_ENV_DENYLIST,
  CODEX_ENV_DENYLIST,
  DSH_ENV_DENYLIST,
  OPENCODE_ENV_DENYLIST,
  PI_AGENT_ENV_DENYLIST,
  PRIME_AGENT_ENV_DENYLIST,
} from './provider-env.js';
import {
  ANTIGRAVITY_CHANNEL_COMMAND,
  CLAUDE_CHANNEL_COMMAND,
  CODEX_CHANNEL_COMMAND,
  DSH_CHANNEL_COMMAND,
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

/**
 * How Relay recognizes this provider's operating-system processes.
 *
 * Two lanes because one regex cannot serve both: long CLI names are matched as
 * substrings of a whole command line (paths, wrappers, and args all count),
 * while a name as short as `pi` would match almost anything that way and is
 * therefore matched against the command basename only.
 */
export interface ProviderProcessMatch {
  readonly commandLineSubstrings: readonly string[];
  readonly commandBasenames: readonly string[];
}

/**
 * Home-relative credential paths the node manifest's auth probe checks.
 *
 * Presence of any one file means `authed`; declaring none means this provider has
 * no non-destructive heuristic and reports `unknown`. Paths only — the probe
 * never reads or reports a token value.
 */
export type ProviderAuthCredentialPaths = readonly (readonly string[])[];

/**
 * Everything outside this directory that has to know a provider by NAME.
 *
 * Before this record, each fact below was a hand-maintained table in the module
 * that consumed it, and a new provider silently inherited whatever an absent key
 * meant there. The worst case was resume: a provider missing from the old
 * `providerResumeId` ladder connected, then never resumed, with no error and no
 * failing test. Those tables are now lookups into this one, and
 * `v2Adapters satisfies Record<RegisteredChannelProviderId, …>` makes a provider
 * with an adapter but no descriptor — or a descriptor with no adapter — a
 * COMPILE error.
 *
 * This is DATA consumed by seams that already exist. It is not a new branching
 * axis: the channel binder still gates on declared capabilities and adapter
 * method presence, never on a provider id.
 *
 * Two facts stay in `shared/` because the frontend reads them and `shared/` must
 * not import `server/`: the Relay control catalog (referenced by value in
 * `relayControls`) and the topic-routing allowlist (`BUILTIN_PROVIDER_IDS` in
 * `shared/workspace-topics.ts`, mirrored by `allowedAsTopicRoutingDefault`).
 * `test/provider-registry-drift.test.ts` binds both to this record.
 */
export interface ProviderDescriptor {
  /** Registry id. MUST equal this entry's key in `PROVIDER_DESCRIPTORS`. */
  readonly id: string;
  /**
   * `adapter.agentType` — the provider identity on the wire and in legacy v1
   * chat events. NOT always the registry id: the bridged `opencode-attached`
   * adapter reports its inner adapter's `'opencode'`.
   */
  readonly agentType: string;
  /**
   * Terminal framework catalog entry (`server/types.ts` `BUILTIN_FRAMEWORKS`),
   * or `null` for a channel-only lane with no PTY surface.
   */
  readonly terminalFrameworkId: BuiltinFrameworkId | null;
  /** How the channel adapter starts, and what env a profile may not reintroduce. */
  readonly launch: ChannelAdapterLaunchContract;
  /**
   * Capability set for a provider served through `LegacyProtocolAdapterV2Bridge`;
   * `null` for a native V2 adapter that declares its own.
   *
   * `Required<AgentCapabilitySetV2>` is the drift guard: every flag on the
   * protocol must be stated, so a new protocol capability is a COMPILE error at
   * each transcription site instead of an omission that silently reads false.
   * Stating a flag `false` is not a new claim — an omitted flag was already read
   * as false everywhere (`declared[capability] === true`); it is the honest
   * record that this bridge was audited against the flag and cannot back it.
   */
  readonly bridgedCapabilities: Required<AgentCapabilitySetV2> | null;
  /**
   * Advertised as a channel lane on the framework roster. This is the ONLY home
   * for that answer: `server/frameworks.ts` projects it onto
   * `AgentFramework.capabilities.supportsChannelAgents` instead of the framework
   * catalog declaring a second, independently-editable boolean.
   */
  readonly supportsChannelAgents: boolean;
  /** Mentionable when the host does not pass an explicit known-provider roster. */
  readonly mentionableByDefault: boolean;
  /**
   * Legal as a topic `routingDefaults.providerId` without the `custom:` prefix.
   * Mirrors `BUILTIN_PROVIDER_IDS` in `shared/workspace-topics.ts`.
   */
  readonly allowedAsTopicRoutingDefault: boolean;
  /**
   * The ONE persisted provider-session key a resume replays from.
   *
   * `null` is a decision, not a hole: it says this provider has no resume key, so
   * a respawn legitimately starts a fresh provider conversation. Disagreement
   * with `capabilities.resume` ships only with a written exemption in
   * `test/provider-registry-drift.test.ts`.
   */
  readonly resumeStateKey: string | null;
  /** Consumes local image attachments delivered in a context packet. */
  readonly deliversImages: boolean;
  /** Raw-image byte budget for one packet turn (bounds synchronous encoding). */
  readonly imageRawByteBudget: number;
  /** Relay control membership, by reference into the shared catalog. */
  readonly relayControls: RelayControlCatalog;
  /** How Relay recognizes this provider's OS processes. */
  readonly processMatch: ProviderProcessMatch;
  /** Credential paths for the node manifest auth probe; empty = no heuristic. */
  readonly authCredentialPaths: ProviderAuthCredentialPaths;
  /**
   * The permission-mode word THIS provider's adapter understands for yolo /
   * permission-bypass spawns, or `null` when it has no such vocabulary.
   *
   * `bypassPermissions` is Claude's word. It used to be sent to every provider
   * because the binder held one constant; audited here, `config.permissionMode`
   * is read by `claude-adapter.ts` alone, so the other providers declare `null`
   * rather than inherit a flag they ignore.
   */
  readonly yoloPermissionMode: string | null;
  /**
   * The `AgentProfile` field this provider consumes as a gateway-scoping
   * binding, forwarded verbatim into adapter `extra` under the same name — or
   * `null` when the provider has no such concept.
   *
   * Only hermes has one (#1453): `hermesProfile` selects which Hermes multiplex
   * profile the gateway serves that agent from. The `/p/<profile>/` URL shape
   * that consumes it is a Hermes QUIRK and stays in `hermes-adapter.ts`; this
   * row exists so the binder does not re-derive "hermes means hermesProfile"
   * outside this directory.
   */
  readonly agentProfileGatewayBindingKey: 'hermesProfile' | null;
  /**
   * The adapter `extra` key this provider's per-profile gateway SECRET is
   * forwarded as, or `null` when the provider has none.
   *
   * Only hermes has one (#1453): each named multiplex profile carries its own
   * `API_SERVER_KEY`, so a bound Relay profile must authenticate with that
   * profile's key instead of the gateway default's. The value is stored
   * write-only in the agent-profile store and read there through the neutral
   * `getGatewaySecret`; this row is the single place that says which `extra`
   * key carries it, so neither the binder nor the store spells a provider name.
   *
   * A secret is forwarded ONLY alongside a present `agentProfileGatewayBindingKey`
   * value: an unbound runtime talks to the gateway default and must keep using
   * the default credential.
   */
  readonly agentProfileGatewaySecretKey: 'hermesApiKey' | null;
  /**
   * The provider a channel gets when an orchestrator is designated with no
   * framework named. Exactly one descriptor may declare it (asserted at load).
   */
  readonly isDefaultOrchestratorProvider: boolean;
}

/**
 * General raw-image ceiling; bounds synchronous adapter encoding work. Also the
 * fallback for a framework name no descriptor claims.
 */
export const GENERAL_IMAGE_RAW_BYTE_BUDGET = 10 * 1024 * 1024;
/**
 * Claude frames images as base64 inside one JSONL stdin frame. Six raw MiB
 * expands to eight MiB, leaving over a MiB below its 9.5MB line ceiling for
 * packet text, JSON syntax, and per-block metadata.
 */
const CLAUDE_IMAGE_RAW_BYTE_BUDGET = 6 * 1024 * 1024;

export const PROVIDER_DESCRIPTORS = {
  mock: {
    id: 'mock',
    agentType: 'mock',
    terminalFrameworkId: null,
    launch: { requirement: { kind: 'embedded' }, processEnvDenylist: [] },
    bridgedCapabilities: null,
    // No framework catalog entry, so the double is never rostered; the flag
    // answers "may this provider serve a channel", which it can and does in the
    // binder and runtime suites.
    supportsChannelAgents: true,
    mentionableByDefault: false,
    allowedAsTopicRoutingDefault: false,
    // The fixture double persists `mockSessionId`, but Relay has never resumed
    // from it and `test/channel-agent-binder.test.ts` pins that key as inert
    // (#1408). Kept `null` so the record describes behavior instead of changing
    // it; the disagreement with `capabilities.resume` carries a written
    // exemption in the drift test.
    resumeStateKey: null,
    deliversImages: true,
    imageRawByteBudget: GENERAL_IMAGE_RAW_BYTE_BUDGET,
    relayControls: EMPTY_RELAY_CONTROL_CATALOG,
    processMatch: { commandLineSubstrings: [], commandBasenames: [] },
    authCredentialPaths: [],
    // The double exists to exercise Relay's own plumbing, and the binder's yolo
    // lane is part of that plumbing (test/channel-agent-binder.test.ts).
    yoloPermissionMode: 'bypassPermissions',
    agentProfileGatewayBindingKey: null,
    agentProfileGatewaySecretKey: null,
    isDefaultOrchestratorProvider: false,
  },
  claude: {
    id: 'claude',
    agentType: 'claude',
    terminalFrameworkId: 'claude',
    launch: {
      requirement: { kind: 'command', command: CLAUDE_CHANNEL_COMMAND },
      processEnvDenylist: CLAUDE_ENV_DENYLIST,
    },
    bridgedCapabilities: null,
    // Channel agents run the persistent-subprocess adapter over stream-json
    // (claude-adapter.ts + server/claude-stream-client.ts). Re-enabled by #1168
    // (closes #300): no Agent SDK, real assistant-text streaming, a
    // fixture-replayed end-to-end round trip, and one live hello-world proof.
    supportsChannelAgents: true,
    mentionableByDefault: true,
    allowedAsTopicRoutingDefault: true,
    resumeStateKey: 'claudeSessionId',
    deliversImages: true,
    imageRawByteBudget: CLAUDE_IMAGE_RAW_BYTE_BUDGET,
    relayControls: EMPTY_RELAY_CONTROL_CATALOG,
    processMatch: { commandLineSubstrings: ['claude'], commandBasenames: [] },
    authCredentialPaths: [
      ['.claude', '.credentials.json'],
      ['.config', 'claude', 'credentials.json'],
    ],
    yoloPermissionMode: 'bypassPermissions',
    agentProfileGatewayBindingKey: null,
    agentProfileGatewaySecretKey: null,
    isDefaultOrchestratorProvider: true,
  },
  codex: {
    id: 'codex',
    agentType: 'codex',
    terminalFrameworkId: 'codex',
    launch: {
      requirement: { kind: 'command', command: CODEX_CHANNEL_COMMAND },
      processEnvDenylist: CODEX_ENV_DENYLIST,
    },
    bridgedCapabilities: null,
    // Channel agents run the native `codex app-server` JSON-RPC adapter
    // (codex-native-adapter.ts + server/codex-app-server-client.ts).
    // Re-advertised by #1169 (closes #301): the adapter maps assistant text
    // end-to-end, the fake-app-server unit suite asserts the prompt → text-delta
    // → completion round trip, and one live hello-world proof drove a real
    // thread. The old `chat:text-delta` gap belonged to the retired hook adapter.
    supportsChannelAgents: true,
    mentionableByDefault: true,
    allowedAsTopicRoutingDefault: true,
    resumeStateKey: 'threadId',
    deliversImages: true,
    imageRawByteBudget: GENERAL_IMAGE_RAW_BYTE_BUDGET,
    relayControls: RELAY_CONTROL_CATALOGS.codex,
    processMatch: { commandLineSubstrings: ['codex'], commandBasenames: [] },
    authCredentialPaths: [['.codex', 'auth.json']],
    yoloPermissionMode: null,
    agentProfileGatewayBindingKey: null,
    agentProfileGatewaySecretKey: null,
    isDefaultOrchestratorProvider: false,
  },
  'prime-agent': {
    id: 'prime-agent',
    agentType: 'prime-agent',
    terminalFrameworkId: 'prime-agent',
    launch: {
      requirement: { kind: 'command', command: PRIME_AGENT_CHANNEL_COMMAND },
      processEnvDenylist: PRIME_AGENT_ENV_DENYLIST,
    },
    bridgedCapabilities: null,
    supportsChannelAgents: true,
    mentionableByDefault: true,
    allowedAsTopicRoutingDefault: true,
    resumeStateKey: 'primeAgentSessionId',
    deliversImages: false,
    imageRawByteBudget: GENERAL_IMAGE_RAW_BYTE_BUDGET,
    relayControls: RELAY_CONTROL_CATALOGS['prime-agent'],
    processMatch: {
      commandLineSubstrings: ['prime-agent'],
      commandBasenames: [],
    },
    authCredentialPaths: [],
    yoloPermissionMode: null,
    agentProfileGatewayBindingKey: null,
    agentProfileGatewaySecretKey: null,
    isDefaultOrchestratorProvider: false,
  },
  pi: {
    id: 'pi',
    agentType: 'pi',
    terminalFrameworkId: 'pi',
    launch: {
      requirement: { kind: 'command', command: PI_AGENT_CHANNEL_COMMAND },
      processEnvDenylist: PI_AGENT_ENV_DENYLIST,
    },
    bridgedCapabilities: null,
    supportsChannelAgents: true,
    mentionableByDefault: true,
    allowedAsTopicRoutingDefault: true,
    resumeStateKey: 'piSessionId',
    deliversImages: false,
    imageRawByteBudget: GENERAL_IMAGE_RAW_BYTE_BUDGET,
    relayControls: EMPTY_RELAY_CONTROL_CATALOG,
    // `pi` is too short to match as a command-line substring.
    processMatch: { commandLineSubstrings: [], commandBasenames: ['pi'] },
    authCredentialPaths: [],
    yoloPermissionMode: null,
    agentProfileGatewayBindingKey: null,
    agentProfileGatewaySecretKey: null,
    isDefaultOrchestratorProvider: false,
  },
  antigravity: {
    id: 'antigravity',
    agentType: 'antigravity',
    terminalFrameworkId: 'antigravity',
    launch: {
      requirement: {
        kind: 'command',
        command: ANTIGRAVITY_CHANNEL_COMMAND,
      },
      processEnvDenylist: ANTIGRAVITY_ENV_DENYLIST,
    },
    bridgedCapabilities: null,
    supportsChannelAgents: true,
    mentionableByDefault: true,
    allowedAsTopicRoutingDefault: true,
    resumeStateKey: 'antigravityConversationId',
    deliversImages: false,
    imageRawByteBudget: GENERAL_IMAGE_RAW_BYTE_BUDGET,
    relayControls: EMPTY_RELAY_CONTROL_CATALOG,
    // `agy` is short like pi and matched against command basename.
    processMatch: { commandLineSubstrings: [], commandBasenames: ['agy'] },
    authCredentialPaths: [
      ['.gemini', 'antigravity-cli', 'antigravity-oauth-token'],
    ],
    // agy init reports permission_mode: 'always-proceed' when --dangerously-skip-permissions is given.
    yoloPermissionMode: 'always-proceed',
    agentProfileGatewayBindingKey: null,
    agentProfileGatewaySecretKey: null,
    isDefaultOrchestratorProvider: false,
  },
  dsh: {
    id: 'dsh',
    agentType: 'dsh',
    terminalFrameworkId: 'dsh',
    launch: {
      requirement: { kind: 'command', command: DSH_CHANNEL_COMMAND },
      processEnvDenylist: DSH_ENV_DENYLIST,
    },
    bridgedCapabilities: null,
    supportsChannelAgents: true,
    mentionableByDefault: true,
    allowedAsTopicRoutingDefault: true,
    // The ACP server persists sessions and advertises
    // `sessionCapabilities.resume`; `session/resume` reopens this id with its
    // history intact, so a respawn continues the same conversation.
    resumeStateKey: 'dshSessionId',
    deliversImages: false,
    imageRawByteBudget: GENERAL_IMAGE_RAW_BYTE_BUDGET,
    relayControls: EMPTY_RELAY_CONTROL_CATALOG,
    // `dsh` is as short as `pi`/`agy` and is matched against the command
    // basename; `--profile acp` additionally catches a CLI reached through a
    // node shim, whose basename is `node`.
    processMatch: {
      commandLineSubstrings: ['--profile acp'],
      commandBasenames: ['dsh'],
    },
    // Credentials on this lane are env-only (DEEPSEEK_API_KEY); there is no
    // file heuristic, so the manifest auth probe reports `unknown`.
    authCredentialPaths: [],
    // The ACP composition derives both its sandbox mode and approval policy
    // from DSH_PERMISSION_MODE, and `danger-full-access` is the word that
    // turns both off; the adapter translates `config.permissionMode` into it.
    yoloPermissionMode: 'danger-full-access',
    agentProfileGatewayBindingKey: null,
    agentProfileGatewaySecretKey: null,
    isDefaultOrchestratorProvider: false,
  },
  opencode: {
    id: 'opencode',
    agentType: 'opencode',
    terminalFrameworkId: 'opencode',
    launch: {
      requirement: { kind: 'command', command: OPENCODE_CHANNEL_COMMAND },
      processEnvDenylist: OPENCODE_ENV_DENYLIST,
    },
    bridgedCapabilities: {
      text: true,
      reasoning: true,
      tools: true,
      commandExecution: true,
      fileChanges: true,
      approvals: true,
      questions: false,
      plans: false,
      slashCommands: false,
      queue: false,
      steer: false,
      interrupt: true,
      cancelQueued: false,
      resume: false,
      fork: false,
      rollback: false,
      compact: false,
      telemetry: true,
      rateLimits: false,
      // `OpenCodeProtocolAdapter.handleMessagePartUpdated` fires
      // `chat:text-delta` per `message.part.updated`, and
      // `mapChatEventToAgentPatchV2` DOES have a case for it, so the bridge
      // really does surface `agent-item-delta-v2` token-by-token. Unlike the
      // hermes `telemetry` gap below, the compat mapping exists — the flag was
      // just never set.
      streaming: true,
    },
    supportsChannelAgents: true,
    mentionableByDefault: true,
    allowedAsTopicRoutingDefault: true,
    resumeStateKey: null,
    deliversImages: false,
    imageRawByteBudget: GENERAL_IMAGE_RAW_BYTE_BUDGET,
    relayControls: EMPTY_RELAY_CONTROL_CATALOG,
    processMatch: { commandLineSubstrings: ['opencode'], commandBasenames: [] },
    authCredentialPaths: [],
    yoloPermissionMode: null,
    agentProfileGatewayBindingKey: null,
    agentProfileGatewaySecretKey: null,
    isDefaultOrchestratorProvider: false,
  },
  'opencode-attached': {
    id: 'opencode-attached',
    // The bridge inherits the inner adapter's identity: attached and spawned
    // OpenCode are one provider on the wire, two registry lanes.
    agentType: 'opencode',
    terminalFrameworkId: null,
    launch: {
      requirement: {
        kind: 'gateway',
        gateway: 'opencode-attached',
        probe: probeOpenCodeAttachedApi,
      },
      processEnvDenylist: [],
    },
    bridgedCapabilities: {
      text: true,
      reasoning: true,
      tools: true,
      commandExecution: true,
      fileChanges: true,
      approvals: true,
      questions: false,
      plans: false,
      slashCommands: false,
      queue: false,
      steer: false,
      interrupt: true,
      cancelQueued: false,
      resume: false,
      fork: false,
      rollback: false,
      compact: false,
      telemetry: true,
      rateLimits: false,
      // Same as `opencode`: the attached adapter's `message.part.updated`
      // handler fires `chat:text-delta` whenever the event carries a string
      // delta.
      streaming: true,
    },
    // Reachable by explicit provider id; not rostered, because attached OpenCode
    // has no framework catalog entry of its own (`terminalFrameworkId: null`).
    supportsChannelAgents: true,
    mentionableByDefault: false,
    allowedAsTopicRoutingDefault: false,
    resumeStateKey: null,
    deliversImages: false,
    imageRawByteBudget: GENERAL_IMAGE_RAW_BYTE_BUDGET,
    relayControls: EMPTY_RELAY_CONTROL_CATALOG,
    // Attached sessions reach an already-running server; Relay spawns nothing.
    processMatch: { commandLineSubstrings: [], commandBasenames: [] },
    authCredentialPaths: [],
    yoloPermissionMode: null,
    agentProfileGatewayBindingKey: null,
    agentProfileGatewaySecretKey: null,
    isDefaultOrchestratorProvider: false,
  },
  hermes: {
    id: 'hermes',
    agentType: 'hermes',
    terminalFrameworkId: 'hermes',
    // Hermes channel sessions attach to the HTTP gateway and spawn no local CLI.
    launch: {
      requirement: {
        kind: 'gateway',
        gateway: 'hermes',
        probe: probeHermesGatewayApi,
      },
      processEnvDenylist: [],
    },
    bridgedCapabilities: {
      text: true,
      reasoning: true,
      tools: true,
      commandExecution: true,
      fileChanges: true,
      approvals: true,
      questions: false,
      plans: false,
      slashCommands: false,
      queue: false,
      steer: false,
      interrupt: true,
      cancelQueued: false,
      resume: true,
      fork: false,
      rollback: false,
      compact: false,
      // `HermesProtocolAdapter` emits `chat:telemetry`, but
      // `mapChatEventToAgentPatchV2` has no case for it yet, so
      // `LegacyProtocolAdapterV2Bridge` silently drops it before it reaches the
      // V2 stream/UI (same pre-existing gap as opencode/opencode-attached
      // above). Keep this `false` until that compat mapping exists so the
      // capability bit doesn't advertise a feature that can't render.
      telemetry: false,
      rateLimits: false,
      // Left unset until the gateway emits `response.output_text.delta`
      // (#1305); now stated explicitly because the transcription must be total.
      streaming: false,
    },
    supportsChannelAgents: true,
    mentionableByDefault: true,
    allowedAsTopicRoutingDefault: true,
    resumeStateKey: 'hermesResponseId',
    deliversImages: true,
    imageRawByteBudget: GENERAL_IMAGE_RAW_BYTE_BUDGET,
    relayControls: EMPTY_RELAY_CONTROL_CATALOG,
    processMatch: { commandLineSubstrings: ['hermes'], commandBasenames: [] },
    authCredentialPaths: [],
    yoloPermissionMode: null,
    agentProfileGatewayBindingKey: 'hermesProfile',
    agentProfileGatewaySecretKey: 'hermesApiKey',
    isDefaultOrchestratorProvider: false,
  },
} satisfies Record<string, ProviderDescriptor>;

/**
 * The registered channel-provider roster: exactly the keys of
 * `PROVIDER_DESCRIPTORS`, which `v2Adapters` is held to below.
 *
 * Scatter sites outside this directory key their lookups on this so a new or
 * renamed provider is a compile error there rather than a silent omission.
 */
export type RegisteredChannelProviderId = keyof typeof PROVIDER_DESCRIPTORS;

/**
 * `satisfies Record<RegisteredChannelProviderId, …>` is the two-way gate:
 * a registered adapter with no descriptor is an excess-property error, and a
 * descriptor with no adapter is a missing-property error. Bridged adapters read
 * their capability transcription straight out of the descriptor so capability
 * truth has one home.
 */
export const v2Adapters = {
  mock: () => new MockProtocolAdapterV2(),
  claude: () => new ClaudeProtocolAdapter(),
  codex: () => new CodexNativeProtocolAdapter(),
  'prime-agent': () => new PrimeAgentProtocolAdapter(),
  pi: () => new PiAgentProtocolAdapter(),
  antigravity: () => new AntigravityProtocolAdapter(),
  dsh: () => new DshProtocolAdapter(),
  opencode: () =>
    new LegacyProtocolAdapterV2Bridge(
      new OpenCodeProtocolAdapter(),
      PROVIDER_DESCRIPTORS.opencode.bridgedCapabilities
    ),
  'opencode-attached': () =>
    new LegacyProtocolAdapterV2Bridge(
      new OpenCodeAttachedAdapter(),
      PROVIDER_DESCRIPTORS['opencode-attached'].bridgedCapabilities
    ),
  hermes: () =>
    new LegacyProtocolAdapterV2Bridge(
      new HermesProtocolAdapter(),
      PROVIDER_DESCRIPTORS.hermes.bridgedCapabilities
    ),
} satisfies Record<RegisteredChannelProviderId, () => ProtocolAdapterV2>;

// The registry is read from a dozen modules; nobody may mutate it. Statements,
// not an `Object.freeze(...)` expression, so the literal types survive.
//
// The freeze reaches every descriptor-owned object and array, not just the top
// level: `bridgedCapabilities` in particular is now ONE object handed to every
// `LegacyProtocolAdapterV2Bridge` instance of a provider as its public
// `adapter.capabilities`, so a single mutation there would poison every other
// live instance and the registry with it. (`relayControls` is a reference into
// `shared/agent-command-catalog.ts`, which owns its own immutability; readers
// there clone.)
for (const descriptor of Object.values(PROVIDER_DESCRIPTORS)) {
  Object.freeze(descriptor.launch.requirement);
  Object.freeze(descriptor.launch.processEnvDenylist);
  Object.freeze(descriptor.launch);
  Object.freeze(descriptor.processMatch.commandLineSubstrings);
  Object.freeze(descriptor.processMatch.commandBasenames);
  Object.freeze(descriptor.processMatch);
  for (const segments of descriptor.authCredentialPaths)
    Object.freeze(segments);
  Object.freeze(descriptor.authCredentialPaths);
  if (descriptor.bridgedCapabilities)
    Object.freeze(descriptor.bridgedCapabilities);
  Object.freeze(descriptor);
}
Object.freeze(PROVIDER_DESCRIPTORS);

const DESCRIPTOR_BY_ID = PROVIDER_DESCRIPTORS as Record<
  string,
  ProviderDescriptor | undefined
>;

/** The descriptor for a registered provider, or `undefined` for a stranger. */
export function providerDescriptor(
  providerId: string
): ProviderDescriptor | undefined {
  return DESCRIPTOR_BY_ID[providerId];
}

/** Every registered provider descriptor, in registration order. */
export function providerDescriptors(): readonly ProviderDescriptor[] {
  return Object.values(PROVIDER_DESCRIPTORS);
}

/**
 * Kept exhaustive against the descriptor roster, and therefore against the
 * adapter factories. Derived rather than declared so a launch contract cannot
 * drift from the descriptor that owns it; the shape is unchanged for callers.
 */
export const CHANNEL_ADAPTER_LAUNCH_CONTRACTS = Object.freeze(
  Object.fromEntries(
    Object.entries(PROVIDER_DESCRIPTORS).map(([providerId, descriptor]) => [
      providerId,
      descriptor.launch,
    ])
  )
) as {
  [K in RegisteredChannelProviderId]: (typeof PROVIDER_DESCRIPTORS)[K]['launch'];
};

export function channelAdapterLaunchRequirement(
  providerId: string
): ChannelAdapterLaunchRequirement | undefined {
  return providerDescriptor(providerId)?.launch.requirement;
}

/**
 * Does this provider advertise a channel lane at all?
 *
 * `server/frameworks.ts` projects this onto
 * `AgentFramework.capabilities.supportsChannelAgents` so channel availability is
 * decided by the descriptor rather than by a second boolean in the terminal
 * framework catalog that could disagree with it.
 */
export function providerSupportsChannelAgents(providerId: string): boolean {
  return providerDescriptor(providerId)?.supportsChannelAgents === true;
}

/** Providers mentionable when the host passes no explicit roster. */
export function defaultMentionableProviderIds(): readonly string[] {
  return providerDescriptors()
    .filter((descriptor) => descriptor.mentionableByDefault)
    .map((descriptor) => descriptor.id);
}

/**
 * The provider a channel gets when an orchestrator is designated without a
 * framework. Resolved from the descriptors so the default has one home instead
 * of a `'claude'` literal at each designation site.
 */
export const DEFAULT_ORCHESTRATOR_PROVIDER_ID = ((): string => {
  const declared = providerDescriptors().filter(
    (descriptor) => descriptor.isDefaultOrchestratorProvider
  );
  if (declared.length !== 1)
    throw new Error(
      `exactly one provider descriptor must set isDefaultOrchestratorProvider; found ${declared.length}`
    );
  return declared[0]!.id;
})();

export function sanitizeChannelAdapterProcessEnv(
  providerId: string,
  processEnv: Record<string, string>,
  platform: NodeJS.Platform = process.platform
): Record<string, string> {
  const sanitized = { ...processEnv };
  const denied =
    providerDescriptor(providerId)?.launch.processEnvDenylist ?? [];
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
