/**
 * Provider-registry drift guards.
 *
 * `server/protocol-adapters/index.ts` holds ONE record — `PROVIDER_DESCRIPTORS` —
 * for every fact about a provider that code outside that directory needs to know
 * by name. Each of those facts used to be a hand-maintained table in the module
 * that consumed it, and at least one failed silently: a provider missing from the
 * old `providerResumeId` ladder connected, then never resumed, with no error, no
 * type error, and no test.
 *
 * `v2Adapters satisfies Record<RegisteredChannelProviderId, …>` is the primary
 * gate and it is a COMPILE error in both directions (adapter without descriptor,
 * descriptor without adapter). This file is the second half: it holds each
 * CONSUMING SEAM to the descriptor, so collapsing the old tables into a registry
 * cannot quietly disconnect the registry from the code that reads it. The
 * expectation table records what the code does today — a row that looks wrong is a
 * finding to fix in its own slice, not something to silently "generalize" here.
 *
 * Compile-time backpressure lives in both the source and the tests:
 * `test/tsconfig.json` typechecks all tests during `npm run check`, so the
 * `satisfies` clause below is an enforced gate.
 *
 * Run: `npx vitest run test/provider-registry-drift.test.ts`
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CHANNEL_ADAPTER_LAUNCH_CONTRACTS,
  DEFAULT_ORCHESTRATOR_PROVIDER_ID,
  PROVIDER_DESCRIPTORS,
  providerDescriptor,
  providerDescriptors,
  v2Adapters,
  type ProviderDescriptor,
  type RegisteredChannelProviderId,
} from '../server/protocol-adapters/index.js';
import { LegacyProtocolAdapterV2Bridge } from '../server/protocol-adapters/legacy-v2-bridge.js';
import type { ProtocolAdapterV2 } from '../server/protocol-adapter-v2.js';
import type { AgentCapabilitySetV2 } from '../shared/agent-chat-protocol-v2.js';
import { providerResumeId } from '../server/channel-agent-runtime.js';
import { DEFAULT_KNOWN_PROVIDER_IDS } from '../server/channel-chat-router.js';
import { BUILTIN_PROVIDER_IDS } from '../shared/workspace-topics.js';
import { BUILTIN_FRAMEWORKS } from '../server/types.js';
import { frameworkCapabilitiesWithChannelLane } from '../server/frameworks.js';
import { isRelayOwnedAgentProcess } from '../server/process-tree.js';
import { probeAgentAuthStatus } from '../server/node-manifest-build.js';
import {
  relayControlCatalogEntryForProvider,
  relayControlCatalogForProvider,
  relayControlInputGuardCatalogForProvider,
} from '../shared/agent-command-catalog.js';
import { isChatEvent } from '../shared/chat-events.js';

/**
 * Every flag on `AgentCapabilitySetV2`. `Record<keyof …>` requires all of them,
 * so a new protocol capability fails to compile here until this list is updated
 * — which is the prompt to audit each adapter's declaration for it.
 */
const ALL_CAPABILITY_FLAGS = {
  text: true,
  reasoning: true,
  tools: true,
  commandExecution: true,
  fileChanges: true,
  approvals: true,
  questions: true,
  plans: true,
  slashCommands: true,
  queue: true,
  steer: true,
  interrupt: true,
  cancelQueued: true,
  resume: true,
  fork: true,
  rollback: true,
  compact: true,
  telemetry: true,
  rateLimits: true,
  streaming: true,
} satisfies Record<keyof AgentCapabilitySetV2, true>;

const CAPABILITY_FLAG_NAMES = Object.keys(
  ALL_CAPABILITY_FLAGS
) as (keyof AgentCapabilitySetV2)[];

interface ProviderDriftExpectation {
  /**
   * `adapter.agentType`. NOT always the registry key: the bridged
   * `opencode-attached` adapter reports its inner adapter's `'opencode'`.
   */
  agentType: string;
  /** Wrapped by `LegacyProtocolAdapterV2Bridge` (capabilities live in the descriptor). */
  legacyBridged: boolean;
  /** `descriptor.resumeStateKey`. `null` = this provider has no resume key. */
  resumeKey: string | null;
  /** `adapter.capabilities.resume`. */
  declaresResumeCapability: boolean;
  /**
   * Why `declaresResumeCapability` and `resumeKey` disagree. MUST be `null` when
   * they agree — a non-null value is an acknowledged gap, not a free pass.
   */
  resumeLadderExemption: string | null;
  /** `descriptor.deliversImages` (context-packet image lane). */
  deliversImages: boolean;
  /** `descriptor.imageRawByteBudget`, in MiB. */
  imageRawBudgetMiB: number;
  /** Terminal framework catalog id, or `null` for a channel-only provider. */
  terminalFrameworkId: keyof typeof BUILTIN_FRAMEWORKS | null;
  /** `descriptor.supportsChannelAgents` — may this provider serve a channel. */
  supportsChannelAgents: boolean;
  /** `shared/workspace-topics.ts` `BUILTIN_PROVIDER_IDS` (topic routing default). */
  inTopicProviderAllowlist: boolean;
  /** `DEFAULT_KNOWN_PROVIDER_IDS` fallback mention roster. */
  inRouterFallbackRoster: boolean;
  /** `relayControlCatalogForProvider` names (advertised Relay controls). */
  advertisedControlNames: readonly string[];
  /** `relayControlInputGuardCatalogForProvider` names (reserved from prose). */
  guardedControlNames: readonly string[];
  /** Command-line substrings / basenames that mark a process as this provider's. */
  processMatch: { commandLineSubstrings: string[]; commandBasenames: string[] };
  /** Home-relative credential files the node auth probe accepts. */
  authCredentialPaths: string[][];
  /** Permission-mode word for a yolo spawn; `null` = this provider has none. */
  yoloPermissionMode: string | null;
  /**
   * `AgentProfile` field this provider consumes as a gateway-scoping binding,
   * forwarded into adapter `extra` by `server/channel-agent-binder.ts`; `null`
   * = this provider has no such concept and must receive nothing.
   */
  agentProfileGatewayBindingKey: 'hermesProfile' | null;
  /**
   * Adapter `extra` key carrying this provider's WRITE-ONLY per-profile gateway
   * secret; `null` = this provider has none and must receive nothing. A secret
   * rides only alongside a present binding value.
   */
  agentProfileGatewaySecretKey: 'hermesApiKey' | null;
  /** Chosen when an orchestrator is designated with no framework named. */
  isDefaultOrchestratorProvider: boolean;
  /** Legacy v1 `ChatEventSource` — only the bridged lane needs one. */
  validLegacyChatEventSource: boolean;
}

const CODEX_CONTROL_NAMES = [
  'new',
  'continue',
  'model',
  'effort',
  'fast',
  'compact',
  'rollback',
  'archive',
  'unarchive',
  'goal',
  'review',
  'fork',
] as const;

const PRIME_AGENT_CONTROL_NAMES = ['model', 'thinking'] as const;

const PROVIDER_DRIFT_EXPECTATIONS = {
  mock: {
    agentType: 'mock',
    legacyBridged: false,
    resumeKey: null,
    declaresResumeCapability: true,
    resumeLadderExemption:
      'fixture double: it persists `mockSessionId`, but test/channel-agent-binder.test.ts pins that key as inert (#1408). Relay has never resumed a mock runtime.',
    deliversImages: true,
    imageRawBudgetMiB: 10,
    terminalFrameworkId: null,
    supportsChannelAgents: true,
    inTopicProviderAllowlist: false,
    inRouterFallbackRoster: false,
    advertisedControlNames: [],
    guardedControlNames: [],
    processMatch: { commandLineSubstrings: [], commandBasenames: [] },
    authCredentialPaths: [],
    // The double exists to exercise Relay's plumbing, and the binder's yolo lane
    // is part of that plumbing (test/channel-agent-binder.test.ts).
    yoloPermissionMode: 'bypassPermissions',
    agentProfileGatewayBindingKey: null,
    agentProfileGatewaySecretKey: null,
    isDefaultOrchestratorProvider: false,
    validLegacyChatEventSource: true,
  },
  claude: {
    agentType: 'claude',
    legacyBridged: false,
    resumeKey: 'claudeSessionId',
    declaresResumeCapability: true,
    resumeLadderExemption: null,
    deliversImages: true,
    imageRawBudgetMiB: 6,
    terminalFrameworkId: 'claude',
    supportsChannelAgents: true,
    inTopicProviderAllowlist: true,
    inRouterFallbackRoster: true,
    advertisedControlNames: [],
    guardedControlNames: [],
    processMatch: { commandLineSubstrings: ['claude'], commandBasenames: [] },
    authCredentialPaths: [
      ['.claude', '.credentials.json'],
      ['.config', 'claude', 'credentials.json'],
    ],
    yoloPermissionMode: 'bypassPermissions',
    agentProfileGatewayBindingKey: null,
    agentProfileGatewaySecretKey: null,
    isDefaultOrchestratorProvider: true,
    validLegacyChatEventSource: true,
  },
  codex: {
    agentType: 'codex',
    legacyBridged: false,
    resumeKey: 'threadId',
    declaresResumeCapability: true,
    resumeLadderExemption: null,
    deliversImages: true,
    imageRawBudgetMiB: 10,
    terminalFrameworkId: 'codex',
    supportsChannelAgents: true,
    inTopicProviderAllowlist: true,
    inRouterFallbackRoster: true,
    advertisedControlNames: CODEX_CONTROL_NAMES,
    guardedControlNames: CODEX_CONTROL_NAMES,
    processMatch: { commandLineSubstrings: ['codex'], commandBasenames: [] },
    authCredentialPaths: [['.codex', 'auth.json']],
    yoloPermissionMode: null,
    agentProfileGatewayBindingKey: null,
    agentProfileGatewaySecretKey: null,
    isDefaultOrchestratorProvider: false,
    validLegacyChatEventSource: true,
  },
  'prime-agent': {
    agentType: 'prime-agent',
    legacyBridged: false,
    resumeKey: 'primeAgentSessionId',
    declaresResumeCapability: true,
    resumeLadderExemption: null,
    deliversImages: false,
    imageRawBudgetMiB: 10,
    terminalFrameworkId: 'prime-agent',
    supportsChannelAgents: true,
    inTopicProviderAllowlist: true,
    inRouterFallbackRoster: true,
    // Prime's controls are candidates for a CONNECTED adapter to narrow by live
    // discovery, so nothing is advertised pre-bind — but they stay reserved.
    advertisedControlNames: [],
    guardedControlNames: PRIME_AGENT_CONTROL_NAMES,
    processMatch: {
      commandLineSubstrings: ['prime-agent'],
      commandBasenames: [],
    },
    authCredentialPaths: [],
    yoloPermissionMode: null,
    agentProfileGatewayBindingKey: null,
    agentProfileGatewaySecretKey: null,
    isDefaultOrchestratorProvider: false,
    validLegacyChatEventSource: false,
  },
  pi: {
    agentType: 'pi',
    legacyBridged: false,
    resumeKey: 'piSessionId',
    declaresResumeCapability: true,
    resumeLadderExemption: null,
    deliversImages: false,
    imageRawBudgetMiB: 10,
    terminalFrameworkId: 'pi',
    supportsChannelAgents: true,
    inTopicProviderAllowlist: true,
    inRouterFallbackRoster: true,
    advertisedControlNames: [],
    guardedControlNames: [],
    // `pi` is too short to match as a command-line substring.
    processMatch: { commandLineSubstrings: [], commandBasenames: ['pi'] },
    authCredentialPaths: [],
    yoloPermissionMode: null,
    agentProfileGatewayBindingKey: null,
    agentProfileGatewaySecretKey: null,
    isDefaultOrchestratorProvider: false,
    validLegacyChatEventSource: false,
  },
  antigravity: {
    agentType: 'antigravity',
    legacyBridged: false,
    resumeKey: 'antigravityConversationId',
    declaresResumeCapability: true,
    resumeLadderExemption: null,
    deliversImages: false,
    imageRawBudgetMiB: 10,
    terminalFrameworkId: 'antigravity',
    supportsChannelAgents: true,
    inTopicProviderAllowlist: true,
    inRouterFallbackRoster: true,
    advertisedControlNames: [],
    guardedControlNames: [],
    processMatch: { commandLineSubstrings: [], commandBasenames: ['agy'] },
    authCredentialPaths: [
      ['.gemini', 'antigravity-cli', 'antigravity-oauth-token'],
    ],
    yoloPermissionMode: 'always-proceed',
    agentProfileGatewayBindingKey: null,
    agentProfileGatewaySecretKey: null,
    isDefaultOrchestratorProvider: false,
    validLegacyChatEventSource: false,
  },
  opencode: {
    agentType: 'opencode',
    legacyBridged: true,
    resumeKey: null,
    declaresResumeCapability: false,
    resumeLadderExemption: null,
    deliversImages: false,
    imageRawBudgetMiB: 10,
    terminalFrameworkId: 'opencode',
    supportsChannelAgents: true,
    inTopicProviderAllowlist: true,
    inRouterFallbackRoster: true,
    advertisedControlNames: [],
    guardedControlNames: [],
    processMatch: { commandLineSubstrings: ['opencode'], commandBasenames: [] },
    authCredentialPaths: [],
    yoloPermissionMode: null,
    agentProfileGatewayBindingKey: null,
    agentProfileGatewaySecretKey: null,
    isDefaultOrchestratorProvider: false,
    validLegacyChatEventSource: true,
  },
  'opencode-attached': {
    // The bridge inherits the inner adapter's identity: attached and spawned
    // OpenCode are one provider on the wire, two registry lanes.
    agentType: 'opencode',
    legacyBridged: true,
    resumeKey: null,
    declaresResumeCapability: false,
    resumeLadderExemption: null,
    deliversImages: false,
    imageRawBudgetMiB: 10,
    terminalFrameworkId: null,
    supportsChannelAgents: true,
    inTopicProviderAllowlist: false,
    inRouterFallbackRoster: false,
    advertisedControlNames: [],
    guardedControlNames: [],
    // Attached sessions reach an already-running server; Relay spawns nothing.
    processMatch: { commandLineSubstrings: [], commandBasenames: [] },
    authCredentialPaths: [],
    yoloPermissionMode: null,
    agentProfileGatewayBindingKey: null,
    agentProfileGatewaySecretKey: null,
    isDefaultOrchestratorProvider: false,
    validLegacyChatEventSource: true,
  },
  hermes: {
    agentType: 'hermes',
    legacyBridged: true,
    resumeKey: 'hermesResponseId',
    declaresResumeCapability: true,
    resumeLadderExemption: null,
    deliversImages: true,
    imageRawBudgetMiB: 10,
    terminalFrameworkId: 'hermes',
    supportsChannelAgents: true,
    inTopicProviderAllowlist: true,
    inRouterFallbackRoster: true,
    advertisedControlNames: [],
    guardedControlNames: [],
    processMatch: { commandLineSubstrings: ['hermes'], commandBasenames: [] },
    authCredentialPaths: [],
    yoloPermissionMode: null,
    agentProfileGatewayBindingKey: 'hermesProfile',
    agentProfileGatewaySecretKey: 'hermesApiKey',
    isDefaultOrchestratorProvider: false,
    validLegacyChatEventSource: true,
  },
} satisfies Record<RegisteredChannelProviderId, ProviderDriftExpectation>;

/** Non-adapter ids that legitimately appear in provider allowlists. */
const NON_ADAPTER_PROVIDER_IDS: Readonly<Record<string, string>> = {
  terminal:
    'the non-agent routing lane: a topic that opens a PTY, not a channel agent',
};

const PROVIDER_IDS = Object.keys(v2Adapters) as RegisteredChannelProviderId[];
const MIB = 1024 * 1024;

function expectationFor(
  providerId: RegisteredChannelProviderId
): ProviderDriftExpectation {
  const expectation = PROVIDER_DRIFT_EXPECTATIONS[providerId] as
    | ProviderDriftExpectation
    | undefined;
  if (!expectation) {
    throw new Error(
      `No drift expectation for registered provider '${providerId}'. Add a row to ` +
        `PROVIDER_DRIFT_EXPECTATIONS in test/provider-registry-drift.test.ts and ` +
        `answer every scatter site it names — each field is a seam a new provider ` +
        `must be wired into.`
    );
  }
  return expectation;
}

function descriptorFor(
  providerId: RegisteredChannelProviderId
): ProviderDescriptor {
  const descriptor = providerDescriptor(providerId);
  if (!descriptor)
    throw new Error(`no provider descriptor registered for '${providerId}'`);
  return descriptor;
}

function adapterFor(providerId: string): ProtocolAdapterV2 {
  return (v2Adapters as Record<string, () => ProtocolAdapterV2>)[providerId]!();
}

function emptyHomeDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'relay-drift-home-'));
}

describe('provider registry drift guards', () => {
  it('registers exactly one descriptor per adapter', () => {
    // Compile-enforced by `v2Adapters satisfies Record<RegisteredChannelProviderId,
    // …>`; asserted here too because `test/tsconfig.json` typechecks only
    // `shared/**` plus one named file, so a test-file `satisfies` is not a gate.
    expect(Object.keys(PROVIDER_DESCRIPTORS).sort()).toEqual(
      [...PROVIDER_IDS].sort()
    );
    expect(Object.keys(PROVIDER_DRIFT_EXPECTATIONS).sort()).toEqual(
      [...PROVIDER_IDS].sort()
    );
  });

  it.each(PROVIDER_IDS)('keys the descriptor for %s on its own id', (id) => {
    expect(descriptorFor(id).id).toBe(id);
  });

  it.each(PROVIDER_IDS)('declares the real adapter identity for %s', (id) => {
    const adapter = adapterFor(id);
    const expected = expectationFor(id);
    const descriptor = descriptorFor(id);

    expect(adapter.agentType).toBe(expected.agentType);
    expect(descriptor.agentType).toBe(adapter.agentType);
    expect(adapter instanceof LegacyProtocolAdapterV2Bridge).toBe(
      expected.legacyBridged
    );
    // A bridged adapter has no capabilities of its own — the descriptor's
    // transcription IS its capability set, so the two must not diverge.
    expect(descriptor.bridgedCapabilities !== null).toBe(
      expected.legacyBridged
    );
    if (descriptor.bridgedCapabilities)
      expect(adapter.capabilities).toEqual(descriptor.bridgedCapabilities);
  });

  it.each(PROVIDER_IDS)('hands out an immutable descriptor for %s', (id) => {
    const descriptor = descriptorFor(id);

    expect(Object.isFrozen(descriptor)).toBe(true);
    expect(Object.isFrozen(descriptor.launch)).toBe(true);
    expect(Object.isFrozen(descriptor.launch.requirement)).toBe(true);
    expect(Object.isFrozen(descriptor.launch.processEnvDenylist)).toBe(true);
    expect(Object.isFrozen(descriptor.processMatch)).toBe(true);
    expect(Object.isFrozen(descriptor.processMatch.commandLineSubstrings)).toBe(
      true
    );
    expect(Object.isFrozen(descriptor.processMatch.commandBasenames)).toBe(
      true
    );
    expect(Object.isFrozen(descriptor.authCredentialPaths)).toBe(true);
    for (const segments of descriptor.authCredentialPaths)
      expect(Object.isFrozen(segments)).toBe(true);

    if (!descriptor.bridgedCapabilities) return;
    // ONE capability object serves every bridge instance of this provider as its
    // public `adapter.capabilities`, so an unfrozen one would let a single
    // mutation poison every other live instance and the registry with it.
    expect(Object.isFrozen(descriptor.bridgedCapabilities)).toBe(true);
    const first = adapterFor(id);
    const second = adapterFor(id);
    expect(first.capabilities).toBe(descriptor.bridgedCapabilities);
    expect(second.capabilities).toBe(first.capabilities);
  });

  describe('resume ladder (server/channel-agent-runtime.ts)', () => {
    it.each(PROVIDER_IDS)('resumes %s from its declared key only', (id) => {
      const { resumeKey } = expectationFor(id);
      expect(descriptorFor(id).resumeStateKey).toBe(resumeKey);

      if (resumeKey === null) {
        // Every other provider's key must stay inert on this provider's blob.
        for (const other of PROVIDER_IDS) {
          const foreign = descriptorFor(other).resumeStateKey;
          if (foreign === null) continue;
          expect(
            providerResumeId(id, { [foreign]: 'foreign' })
          ).toBeUndefined();
        }
        return;
      }

      expect(providerResumeId(id, { [resumeKey]: 'session-1' })).toBe(
        'session-1'
      );
      // A persisted blob that names anything else replays nothing (#1408).
      expect(
        providerResumeId(id, { lastDeliveredSeq: 7, unrelatedKey: 'x' })
      ).toBeUndefined();
      expect(providerResumeId(id, { [resumeKey]: '' })).toBeUndefined();
      expect(providerResumeId(id, undefined)).toBeUndefined();
    });

    it.each(PROVIDER_IDS)(
      'keeps %s resume capability and resume key consistent',
      (id) => {
        const expected = expectationFor(id);
        const declared = adapterFor(id).capabilities.resume === true;

        expect(declared).toBe(expected.declaresResumeCapability);

        const agrees = declared === (expected.resumeKey !== null);
        if (agrees) {
          expect(
            expected.resumeLadderExemption,
            `${id} agrees, so it must not carry an exemption`
          ).toBeNull();
          return;
        }
        // Disagreement is the silent-resume bug class. It ships only with a
        // written reason, so the next provider cannot inherit it by accident.
        expect(
          expected.resumeLadderExemption,
          `${id} declares capabilities.resume=${declared} but its resume key is ` +
            `${JSON.stringify(expected.resumeKey)}. Either set resumeStateKey on ` +
            `its descriptor or write a resumeLadderExemption saying why resume is ` +
            `never invoked for this provider.`
        ).toBeTruthy();
      }
    );

    it('has no resume key for an unregistered provider', () => {
      expect(
        providerResumeId('future-agent', { futureAgentSessionId: 'x' })
      ).toBeUndefined();
    });
  });

  describe('capability declarations', () => {
    it.each(PROVIDER_IDS)('declares every protocol flag for %s', (id) => {
      const declared = adapterFor(id).capabilities;
      const missing = CAPABILITY_FLAG_NAMES.filter(
        (flag) => !Object.hasOwn(declared, flag)
      );

      expect(
        missing,
        `${id} omits capability flags, which read as false without ever being ` +
          `audited. State them explicitly (see ProviderDescriptor.bridgedCapabilities ` +
          `in server/protocol-adapters/index.ts).`
      ).toEqual([]);
    });

    it.each(PROVIDER_IDS)('declares no unknown flag for %s', (id) => {
      const unknown = Object.keys(adapterFor(id).capabilities).filter(
        (flag) => !(flag in ALL_CAPABILITY_FLAGS)
      );
      expect(unknown).toEqual([]);
    });

    it.each(PROVIDER_IDS)(
      'backs a declared steer flag with a method for %s',
      (id) => {
        const adapter = adapterFor(id);
        if (adapter.capabilities.steer !== true) return;
        expect(
          typeof adapter.steerMessage,
          `${id} declares capabilities.steer but has no steerMessage()`
        ).toBe('function');
      }
    );
  });

  describe('image delivery (server/channel-context-packet.ts)', () => {
    it.each(PROVIDER_IDS)('matches the declared image lane for %s', (id) => {
      const expected = expectationFor(id);
      const descriptor = descriptorFor(id);
      expect(descriptor.deliversImages).toBe(expected.deliversImages);
      expect(descriptor.imageRawByteBudget).toBe(
        expected.imageRawBudgetMiB * MIB
      );
    });
  });

  describe('terminal framework catalog (server/types.ts)', () => {
    it.each(PROVIDER_IDS)('matches the declared catalog entry for %s', (id) => {
      const expected = expectationFor(id);
      const descriptor = descriptorFor(id);

      expect(descriptor.terminalFrameworkId).toBe(expected.terminalFrameworkId);
      expect(descriptor.supportsChannelAgents).toBe(
        expected.supportsChannelAgents
      );

      if (!expected.terminalFrameworkId) {
        expect(Object.hasOwn(BUILTIN_FRAMEWORKS, id)).toBe(false);
        return;
      }

      const framework = BUILTIN_FRAMEWORKS[expected.terminalFrameworkId];
      expect(framework, `no BUILTIN_FRAMEWORKS entry for ${id}`).toBeTruthy();
      // The catalog is the display-identity map: a provider with no label falls
      // back to its bare id in every sender ref and roster row.
      expect(framework.displayName.trim().length).toBeGreaterThan(0);
      // The catalog no longer declares the channel lane; `server/frameworks.ts`
      // projects it from the descriptor, so the two cannot disagree.
      expect(framework.capabilities.supportsChannelAgents).toBeUndefined();
      expect(
        frameworkCapabilitiesWithChannelLane(framework).supportsChannelAgents
      ).toBe(descriptor.supportsChannelAgents);
    });

    it('backs every terminal framework catalog entry with a descriptor', () => {
      // Two INDEPENDENT sources: the catalog keys (`server/types.ts`) and the
      // framework ids the descriptors claim. Filtering the catalog by the
      // projected `supportsChannelAgents` instead would be tautological — the
      // projection is derived from descriptor existence, so a deleted descriptor
      // would remove the framework from its own guard while the roster quietly
      // started answering "no registered channel runtime" for it.
      const catalogIds = Object.keys(BUILTIN_FRAMEWORKS).sort();

      // `server/frameworks.ts` looks a framework up by its CATALOG id, so that
      // is the lookup this guard performs.
      expect(
        catalogIds.filter(
          (id) => providerDescriptor(id)?.terminalFrameworkId === id
        ),
        'a framework catalog entry has no provider descriptor keyed on its id — its roster row reports "no registered channel runtime"'
      ).toEqual(catalogIds);

      // Reverse direction: every claimed framework id exists in the catalog, and
      // no two descriptors claim the same one.
      expect(
        providerDescriptors()
          .map((descriptor) => descriptor.terminalFrameworkId)
          .filter((id): id is NonNullable<typeof id> => id !== null)
          .sort(),
        'a descriptor claims a terminal framework id the catalog does not define, or two descriptors claim the same one'
      ).toEqual(catalogIds);
    });
  });

  describe('provider id allowlists', () => {
    it.each(PROVIDER_IDS)('matches the topic allowlist for %s', (id) => {
      const expected = expectationFor(id);
      expect(descriptorFor(id).allowedAsTopicRoutingDefault).toBe(
        expected.inTopicProviderAllowlist
      );
      // `shared/` cannot import `server/`, so the shared set is a restatement.
      // This is the bind that keeps the restatement honest.
      expect(BUILTIN_PROVIDER_IDS.has(id)).toBe(
        descriptorFor(id).allowedAsTopicRoutingDefault
      );
    });

    it.each(PROVIDER_IDS)('matches the router fallback roster for %s', (id) => {
      const expected = expectationFor(id);
      expect(descriptorFor(id).mentionableByDefault).toBe(
        expected.inRouterFallbackRoster
      );
      expect(DEFAULT_KNOWN_PROVIDER_IDS.includes(id)).toBe(
        descriptorFor(id).mentionableByDefault
      );
    });

    it('lists no unknown id in the topic allowlist', () => {
      const unknown = [...BUILTIN_PROVIDER_IDS].filter(
        (id) => !(id in v2Adapters) && !(id in NON_ADAPTER_PROVIDER_IDS)
      );
      expect(
        unknown,
        'topic routing allows a provider id no adapter serves (renamed or removed?)'
      ).toEqual([]);
    });

    it('lists no unknown id in the router fallback roster', () => {
      const unknown = DEFAULT_KNOWN_PROVIDER_IDS.filter(
        (id) => !(id in v2Adapters)
      );
      expect(
        unknown,
        'the fallback mention roster names a provider id no adapter serves'
      ).toEqual([]);
    });
  });

  describe('relay control catalog (shared/agent-command-catalog.ts)', () => {
    it.each(PROVIDER_IDS)('advertises the declared controls for %s', (id) => {
      expect(
        relayControlCatalogForProvider(id).map((command) => command.name)
      ).toEqual([...expectationFor(id).advertisedControlNames]);
    });

    it.each(PROVIDER_IDS)('guards the declared controls for %s', (id) => {
      const guarded = relayControlInputGuardCatalogForProvider(id).map(
        (command) => command.name
      );
      expect(guarded).toEqual([...expectationFor(id).guardedControlNames]);
      // A control that can be dispatched but not reserved would leak onto the
      // ordinary-message lane, so the guard set is always a superset.
      for (const advertised of expectationFor(id).advertisedControlNames) {
        expect(guarded).toContain(advertised);
      }
    });

    it.each(PROVIDER_IDS)(
      'points the descriptor at the same catalog entry the frontend reads for %s',
      (id) => {
        // The specs live in `shared/` because the composer reads them and
        // `shared/` cannot import `server/`. Reference identity is what keeps the
        // descriptor from becoming a second, divergent membership table.
        expect(descriptorFor(id).relayControls).toBe(
          relayControlCatalogEntryForProvider(id)
        );
      }
    );
  });

  describe('process ownership heuristic (server/process-tree.ts)', () => {
    it.each(PROVIDER_IDS)('declares the process match for %s', (id) => {
      const expected = expectationFor(id);
      const { processMatch } = descriptorFor(id);
      expect({
        commandLineSubstrings: [...processMatch.commandLineSubstrings],
        commandBasenames: [...processMatch.commandBasenames],
      }).toEqual(expected.processMatch);
    });

    it.each(PROVIDER_IDS)('recognizes the launch command for %s', (id) => {
      const requirement = CHANNEL_ADAPTER_LAUNCH_CONTRACTS[id].requirement;
      if (requirement.kind !== 'command') return;

      const command = requirement.command;
      expect(
        isRelayOwnedAgentProcess({
          command,
          commandLine: `/usr/local/bin/${command} --relay-channel`,
        }),
        `${command} is not recognized as a Relay-owned process, so its language-server children are attributed to nobody`
      ).toBe(true);
    });

    it.each(PROVIDER_IDS)('recognizes every declared pattern for %s', (id) => {
      const { processMatch } = descriptorFor(id);
      for (const substring of processMatch.commandLineSubstrings) {
        expect(
          isRelayOwnedAgentProcess({
            command: 'node',
            commandLine: `/opt/wrap/${substring} --serve`,
          })
        ).toBe(true);
      }
      for (const basename of processMatch.commandBasenames) {
        expect(
          isRelayOwnedAgentProcess({
            command: `/usr/local/bin/${basename}`,
            commandLine: 'unrelated command line',
          })
        ).toBe(true);
      }
    });

    it('still recognizes Relay’s own entrypoints', () => {
      expect(
        isRelayOwnedAgentProcess({
          command: 'node',
          commandLine: '/usr/bin/node /opt/relay-ide/dist/server/index.js',
        })
      ).toBe(true);
      expect(
        isRelayOwnedAgentProcess({
          command: 'relayctl',
          commandLine: 'relayctl status',
        })
      ).toBe(true);
    });

    it('does not claim an unrelated process', () => {
      expect(
        isRelayOwnedAgentProcess({
          command: 'python3',
          commandLine: '/usr/bin/python3 -m http.server',
        })
      ).toBe(false);
    });
  });

  describe('node manifest auth probe (server/node-manifest-build.ts)', () => {
    it.each(PROVIDER_IDS)(
      'matches the declared credential paths for %s',
      (id) => {
        const expected = expectationFor(id);
        expect(
          descriptorFor(id).authCredentialPaths.map((segments) => [...segments])
        ).toEqual(expected.authCredentialPaths);
      }
    );

    it.each(PROVIDER_IDS)('probes %s from its declared paths only', (id) => {
      const declared = descriptorFor(id).authCredentialPaths;
      const homeDir = emptyHomeDir();

      if (declared.length === 0) {
        expect(probeAgentAuthStatus(id, { homeDir })).toBe('unknown');
        return;
      }

      expect(probeAgentAuthStatus(id, { homeDir })).toBe('unauthed');
      for (const segments of declared) {
        const authedHome = emptyHomeDir();
        const file = path.join(authedHome, ...segments);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, '{}');
        expect(
          probeAgentAuthStatus(id, { homeDir: authedHome }),
          `${id} declares ${segments.join('/')} but the probe ignored it`
        ).toBe('authed');
      }
    });
  });

  describe('claude-flavored defaults, now named', () => {
    it.each(PROVIDER_IDS)('names the yolo permission mode for %s', (id) => {
      expect(descriptorFor(id).yoloPermissionMode).toBe(
        expectationFor(id).yoloPermissionMode
      );
    });

    it.each(PROVIDER_IDS)(
      'names the agent-profile gateway binding key for %s',
      (id) => {
        expect(descriptorFor(id).agentProfileGatewayBindingKey).toBe(
          expectationFor(id).agentProfileGatewayBindingKey
        );
      }
    );

    it.each(PROVIDER_IDS)(
      'names the agent-profile gateway secret key for %s',
      (id) => {
        expect(descriptorFor(id).agentProfileGatewaySecretKey).toBe(
          expectationFor(id).agentProfileGatewaySecretKey
        );
      }
    );

    it('gives a gateway secret key only to a provider that has a binding key', () => {
      // The binder forwards the secret ONLY alongside a present binding value.
      // A provider that declared a secret key with no binding key would supply
      // credential material that nothing scopes.
      for (const id of PROVIDER_IDS) {
        const descriptor = descriptorFor(id);
        if (descriptor.agentProfileGatewaySecretKey === null) continue;
        expect(descriptor.agentProfileGatewayBindingKey).not.toBeNull();
      }
      expect(
        PROVIDER_IDS.filter(
          (id) => descriptorFor(id).agentProfileGatewaySecretKey !== null
        )
      ).toEqual(['hermes']);
    });

    it('gives exactly one provider a gateway binding key', () => {
      // `server/channel-agent-binder.ts` forwards this field and nothing else
      // into adapter `extra`. A second provider claiming a key is fine, but it
      // must be a deliberate descriptor edit, not drift from a copied row.
      expect(
        PROVIDER_IDS.filter(
          (id) => descriptorFor(id).agentProfileGatewayBindingKey !== null
        )
      ).toEqual(['hermes']);
    });

    it('resolves the default orchestrator from exactly one descriptor', () => {
      const declared = PROVIDER_IDS.filter(
        (id) => descriptorFor(id).isDefaultOrchestratorProvider
      );
      expect(declared).toHaveLength(1);
      expect(DEFAULT_ORCHESTRATOR_PROVIDER_ID).toBe(declared[0]);
      expect(
        declared.map((id) => expectationFor(id).isDefaultOrchestratorProvider)
      ).toEqual([true]);
    });
  });

  describe('legacy v1 chat-event source (shared/chat-events.ts)', () => {
    it.each(PROVIDER_IDS)('matches the declared v1 source for %s', (id) => {
      const adapter = adapterFor(id);
      const accepted = isChatEvent({
        sessionId: 's1',
        timestamp: new Date(0).toISOString(),
        type: 'chat:text-delta',
        source: adapter.agentType,
      });
      expect(accepted).toBe(expectationFor(id).validLegacyChatEventSource);
    });

    it('accepts the v1 source of every bridged adapter', () => {
      const rejected = PROVIDER_IDS.filter((id) => {
        const adapter = adapterFor(id);
        if (!(adapter instanceof LegacyProtocolAdapterV2Bridge)) return false;
        return !isChatEvent({
          sessionId: 's1',
          timestamp: new Date(0).toISOString(),
          type: 'chat:text-delta',
          source: adapter.agentType,
        });
      });

      expect(
        rejected,
        'a legacy-bridged adapter emits chat events whose source isChatEvent rejects — the compat layer would drop the whole stream'
      ).toEqual([]);
    });
  });
});
