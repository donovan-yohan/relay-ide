import type { AgentSlashCommandV2 } from './agent-chat-protocol-v2.js';

/** Static, redaction-safe Relay controls. Provider adapters add live commands. */
const CODEX_CONTROLS: AgentSlashCommandV2[] = [
  {
    id: 'relay:clear',
    name: 'new',
    aliases: ['clear', 'reset'],
    description: 'Start a fresh Codex thread',
    source: 'relay',
    sourceLabel: 'Relay',
    dispatch: 'relay-control',
    collisionKey: 'clear',
    destructive: true,
  },
  {
    id: 'relay:resume',
    name: 'continue',
    aliases: ['resume'],
    description: 'Resume a saved Codex thread by id',
    argumentHint: '<threadId>',
    source: 'relay',
    sourceLabel: 'Relay',
    dispatch: 'relay-control',
    collisionKey: 'resume',
  },
  {
    id: 'relay:model',
    name: 'model',
    description: 'Switch model for subsequent Codex responses',
    argumentHint: '<model>',
    source: 'relay',
    sourceLabel: 'Relay',
    dispatch: 'relay-control',
    collisionKey: 'model',
  },
  {
    id: 'relay:effort',
    name: 'effort',
    description: 'Set Codex reasoning effort for subsequent responses',
    argumentHint: '<low|medium|high|xhigh|max|ultra>',
    args: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].map((value) => ({
      value,
    })),
    source: 'relay',
    sourceLabel: 'Relay',
    dispatch: 'relay-control',
    collisionKey: 'effort',
  },
  {
    id: 'relay:fast',
    name: 'fast',
    description: 'Enable or disable Codex Fast Mode for subsequent responses',
    argumentHint: '<on|off>',
    args: [
      { value: 'on', label: 'on', description: 'Use the fast service tier' },
      {
        value: 'off',
        label: 'off',
        description: 'Use the default service tier',
      },
    ],
    source: 'relay',
    sourceLabel: 'Relay',
    dispatch: 'relay-control',
    collisionKey: 'fast',
  },
  {
    id: 'relay:compact',
    name: 'compact',
    description: 'Compact the current Codex thread context',
    source: 'relay',
    sourceLabel: 'Relay',
    dispatch: 'relay-control',
    collisionKey: 'compact',
  },
  {
    id: 'relay:rollback',
    name: 'rollback',
    description: 'Roll back N turns in the current thread',
    argumentHint: '<n>',
    source: 'relay',
    sourceLabel: 'Relay',
    dispatch: 'relay-control',
    collisionKey: 'rollback',
    destructive: true,
  },
  {
    id: 'relay:archive',
    name: 'archive',
    description: 'Archive the current Codex thread',
    source: 'relay',
    sourceLabel: 'Relay',
    dispatch: 'relay-control',
    collisionKey: 'archive',
    destructive: true,
  },
  {
    id: 'relay:unarchive',
    name: 'unarchive',
    description: 'Unarchive the current Codex thread',
    source: 'relay',
    sourceLabel: 'Relay',
    dispatch: 'relay-control',
    collisionKey: 'unarchive',
  },
  {
    id: 'relay:goal',
    name: 'goal',
    description: 'Get, set, or clear the goal for the current thread',
    argumentHint: 'set <text> | get | clear',
    source: 'relay',
    sourceLabel: 'Relay',
    dispatch: 'relay-control',
    collisionKey: 'goal',
  },
  {
    id: 'relay:review',
    name: 'review',
    description: 'Enter review mode for the current thread',
    source: 'relay',
    sourceLabel: 'Relay',
    dispatch: 'relay-control',
    collisionKey: 'review',
  },
  {
    id: 'relay:fork',
    name: 'fork',
    description: 'Fork the current Codex thread',
    source: 'relay',
    sourceLabel: 'Relay',
    dispatch: 'relay-control',
    collisionKey: 'fork',
  },
];

/**
 * Prime controls are definitions for its connected adapter, not a pre-bind
 * preview. Unlike Codex, Prime has no static control contract that Relay can
 * safely promise before the current RPC runtime has completed discovery.
 */
const PRIME_AGENT_CONTROL_DEFINITIONS: AgentSlashCommandV2[] = [
  {
    id: 'relay:prime-agent:model',
    name: 'model',
    description: 'Switch the model for subsequent Prime Agent responses',
    argumentHint: '<provider/model>',
    source: 'builtin',
    sourceLabel: 'Prime Agent',
    dispatch: 'relay-control',
    collisionKey: 'model',
  },
  {
    id: 'relay:prime-agent:thinking',
    name: 'thinking',
    aliases: ['effort'],
    description: 'Set Prime Agent reasoning depth',
    argumentHint: '<off|minimal|low|medium|high|xhigh|max>',
    args: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].map(
      (value) => ({ value })
    ),
    source: 'builtin',
    sourceLabel: 'Prime Agent',
    dispatch: 'relay-control',
    collisionKey: 'thinking',
  },
];

/** One provider's Relay controls: what it advertises, and what it reserves. */
export interface RelayControlCatalog {
  /** Advertised to the composer and roster before any runtime has bound. */
  readonly advertised: readonly AgentSlashCommandV2[];
  /**
   * Reserved from ordinary channel prose. Always a superset of `advertised`: a
   * control that can be dispatched but not reserved would leak onto the
   * ordinary-message lane.
   */
  readonly guarded: readonly AgentSlashCommandV2[];
}

/** A provider with no Relay controls. Shared so the empty case has one identity. */
export const EMPTY_RELAY_CONTROL_CATALOG: RelayControlCatalog = Object.freeze({
  advertised: Object.freeze([]),
  guarded: Object.freeze([]),
});

/**
 * Provider control membership, keyed by provider id.
 *
 * This lives in `shared/` because the frontend composer reads it directly
 * (`frontend/src/components/chat/ChannelComposer.tsx`) and `shared/` must not
 * import from `server/`. The channel-provider descriptor
 * (`server/protocol-adapters/index.ts`) therefore *references* these entries by
 * value rather than restating them, and `test/provider-registry-drift.test.ts`
 * asserts the reference identity so the two homes can never disagree.
 */
export const RELAY_CONTROL_CATALOGS = {
  codex: { advertised: CODEX_CONTROLS, guarded: CODEX_CONTROLS },
  // Prime's controls are definitions for its connected adapter to narrow by
  // live discovery, so nothing is advertised pre-bind — but they stay reserved.
  'prime-agent': {
    advertised: EMPTY_RELAY_CONTROL_CATALOG.advertised,
    guarded: PRIME_AGENT_CONTROL_DEFINITIONS,
  },
} satisfies Record<string, RelayControlCatalog>;

/** The catalog a provider uses, or the shared empty one. */
export function relayControlCatalogEntryForProvider(
  providerId: string
): RelayControlCatalog {
  return (
    (RELAY_CONTROL_CATALOGS as Record<string, RelayControlCatalog | undefined>)[
      providerId
    ] ?? EMPTY_RELAY_CONTROL_CATALOG
  );
}

export function relayControlCatalogForProvider(
  providerId: string
): AgentSlashCommandV2[] {
  return cloneCatalog(
    relayControlCatalogEntryForProvider(providerId).advertised
  );
}

/**
 * Returns Prime's candidate controls for a connected adapter to narrow using
 * the current RPC runtime's live discovery result.
 */
export function primeAgentControlDefinitions(): AgentSlashCommandV2[] {
  return cloneCatalog(PRIME_AGENT_CONTROL_DEFINITIONS);
}

/**
 * Controls reserved from ordinary channel prose. Prime's candidate set is
 * limited to controls that its connected adapter can discover and execute;
 * undiscovered candidates are not advertised, but are still kept off the
 * ordinary-message lane.
 */
export function relayControlInputGuardCatalogForProvider(
  providerId: string
): AgentSlashCommandV2[] {
  return cloneCatalog(relayControlCatalogEntryForProvider(providerId).guarded);
}

function cloneCatalog(
  controls: readonly AgentSlashCommandV2[]
): AgentSlashCommandV2[] {
  return controls.map((command) => ({
    ...command,
    ...(command.aliases ? { aliases: [...command.aliases] } : {}),
    ...(command.args ? { args: command.args.map((arg) => ({ ...arg })) } : {}),
  }));
}
