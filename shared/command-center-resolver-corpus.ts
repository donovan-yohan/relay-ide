import type { RelayCliGatewayCommand } from './cli-gateway-contract.js';

export type CommandCenterExplainCoverage =
  | { kind: 'all-resolver-commands' }
  | { kind: 'commands'; commandIds: readonly RelayCliGatewayCommand[] };

export interface CommandCenterExplainCorpusEntry {
  id: string;
  sourcePath: string;
  lineRange: string;
  excerpt: string;
  coverage: CommandCenterExplainCoverage;
  relatedCommandIds?: readonly RelayCliGatewayCommand[];
  relatedActionIds?: readonly string[];
  optOutRationale?: string;
}

const NODE_PAIRING_COMMAND_IDS = [
  'nodes.list',
  'nodes.pair.requests',
  'nodes.pair.approve',
  'nodes.pair.deny',
  'nodes.pair.editAccess',
  'nodes.rotateCredential',
  'nodes.revoke',
] as const satisfies readonly RelayCliGatewayCommand[];

const NODE_PAIRING_ACTION_IDS = [
  'settings.nodes.pending-requests',
  'settings.nodes.approve-request',
  'settings.nodes.deny-request',
  'settings.nodes.edit-access',
  'settings.nodes.rotate-credential',
  'settings.nodes.revoke',
] as const;

const SESSION_READ_COMMAND_IDS = [
  'nodes.list',
  'sessions.list',
  'sessions.get',
  'sessions.screen',
  'work-contexts.get',
  'work-context-artifacts.list',
  'work-context-artifacts.show',
  'work-context-artifacts.export',
  'work-context-artifacts.doctor',
  'handoff-artifacts.list',
  'handoff-artifacts.show',
  'handoff-artifacts.copy',
] as const satisfies readonly RelayCliGatewayCommand[];

export const COMMAND_CENTER_RESOLVER_EXPLAIN_CORPUS = [
  {
    id: 'cli-gateway-command-taxonomy',
    sourcePath: 'docs/CLI_GATEWAY.md',
    lineRange: '284-296',
    excerpt:
      'Relay command metadata is defined in shared/relay-command-manifest.ts as a projection of the v1 gateway contract, carrying stable command ids, CLI projection, side-effect class, capability hints, confirmation/control requirements, scope kinds, and audit redaction expectations. Command Center may search and describe stable gateway commands before browser execution is wired.',
    coverage: { kind: 'all-resolver-commands' },
  },
  {
    id: 'frontend-action-contract-parity',
    sourcePath: 'docs/FRONTEND.md',
    lineRange: '173-180',
    excerpt:
      'The action registry is metadata-driven. Stable agent-facing commands come from shared/cli-gateway-contract.ts, shared/relay-command-manifest.ts, and shared/action-descriptor.ts; UI-only Command Center helpers must stay marked UI-only unless a stable command descriptor exists.',
    coverage: { kind: 'all-resolver-commands' },
  },
  {
    id: 'cli-gateway-scoped-read-commands',
    sourcePath: 'docs/CLI_GATEWAY.md',
    lineRange: '314-327',
    excerpt:
      'The scoped actor credential MVP exposes read-only commands such as nodes.list, sessions.list, sessions.get, sessions.screen, work-contexts.get, and bounded WorkContext artifact reads. These commands read descriptors or bounded metadata; raw payloads and private state stay outside the command contract.',
    coverage: { kind: 'commands', commandIds: SESSION_READ_COMMAND_IDS },
    relatedCommandIds: SESSION_READ_COMMAND_IDS,
  },
  {
    id: 'node-command-center-parity',
    sourcePath: 'docs/ADD_NODE_PAIR_DEVICE_UX.md',
    lineRange: '305-340',
    excerpt:
      'Command Center exposes node actions as searchable actions, but projects shared command/action descriptors and routes into Settings -> Nodes flows or stable gateway commands. It must never become a second pairing implementation or private React-only handler; drift tests fail when public node actions are missing descriptors or explicit UI-only annotations.',
    coverage: { kind: 'commands', commandIds: NODE_PAIRING_COMMAND_IDS },
    relatedCommandIds: NODE_PAIRING_COMMAND_IDS,
    relatedActionIds: NODE_PAIRING_ACTION_IDS,
  },
] as const satisfies readonly CommandCenterExplainCorpusEntry[];

function corpusAppliesToCommand(
  entry: CommandCenterExplainCorpusEntry,
  commandId: RelayCliGatewayCommand
): boolean {
  if (entry.coverage.kind === 'all-resolver-commands') return true;
  return entry.coverage.commandIds.includes(commandId);
}

export function commandCenterExplainCoverageForCommand(
  commandId: RelayCliGatewayCommand
): CommandCenterExplainCorpusEntry[] {
  return COMMAND_CENTER_RESOLVER_EXPLAIN_CORPUS.filter((entry) =>
    corpusAppliesToCommand(entry, commandId)
  );
}

export function isCommandCenterExplainCitationId(value: string): boolean {
  return COMMAND_CENTER_RESOLVER_EXPLAIN_CORPUS.some(
    (entry) => entry.id === value
  );
}

export function commandCenterExplainCorpusEntriesForCitations(
  citations: readonly string[]
): CommandCenterExplainCorpusEntry[] {
  const citationSet = new Set(citations);
  return COMMAND_CENTER_RESOLVER_EXPLAIN_CORPUS.filter((entry) =>
    citationSet.has(entry.id)
  );
}

export function commandCenterExplainRelatedCommandIds(
  citations: readonly string[]
): RelayCliGatewayCommand[] {
  return Array.from(
    new Set(
      commandCenterExplainCorpusEntriesForCitations(citations).flatMap(
        (entry) =>
          entry.coverage.kind === 'commands'
            ? (entry.relatedCommandIds ?? entry.coverage.commandIds)
            : (entry.relatedCommandIds ?? [])
      )
    )
  ).sort();
}

export function commandCenterExplainRelatedActionIds(
  citations: readonly string[]
): string[] {
  return Array.from(
    new Set(
      commandCenterExplainCorpusEntriesForCitations(citations).flatMap(
        (entry) => entry.relatedActionIds ?? []
      )
    )
  ).sort();
}
