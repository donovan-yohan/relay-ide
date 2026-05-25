import {
  RELAY_CLI_GATEWAY_CONTRACT,
  type RelayCliGatewayCommand,
  type RelayCliGatewayCommandSpec,
  type RelayJsonSchema,
} from './cli-gateway-contract.js';
import type { RelayCapabilityBit } from './security-policy.js';

export type RelayCommandSurface = 'web' | 'cli' | 'agent';
export type RelayCommandSideEffect = 'read' | 'write' | 'destructive' | 'stream';
export type RelayCommandScopeKind = 'node' | 'repo' | 'worktree' | 'work-context' | 'session';

export interface RelayCommandHandler {
  /** Public CLI argv projection for the stable `relay-ide v1 ... --json` gateway. */
  cli?: readonly string[];
  /** Future hub/API execution projection; absent means this manifest does not expose a private route. */
  api?: { method: string; path: string };
  /** Existing Command Center action id when execution is wired through the UI registry. */
  uiAction?: string;
}

export interface RelayCommandDefinition {
  /** Stable Relay-owned command id. For gateway commands this is the v1 command name. */
  id: RelayCliGatewayCommand;
  /** Alias kept for agent/tool generators that call the command field `name`. */
  name: RelayCliGatewayCommand;
  label: string;
  description: string;
  summary: string;
  surfaces: readonly RelayCommandSurface[];
  inputSchema: RelayJsonSchema;
  outputSchema: RelayJsonSchema;
  capabilityHints: readonly RelayCapabilityBit[];
  sideEffect: RelayCommandSideEffect;
  requiresConfirmation: boolean;
  scopeKinds: readonly RelayCommandScopeKind[];
  handler: RelayCommandHandler;
  stable: boolean;
  source: 'cli-gateway-v1';
}

export interface RelayCommandManifest {
  schemaVersion: 1;
  generatedFrom: 'shared/cli-gateway-contract.ts';
  commands: readonly RelayCommandDefinition[];
}

const CLI_AGENT_WEB_SURFACES = ['cli', 'agent', 'web'] as const;

const COMMAND_LABELS: Record<RelayCliGatewayCommand, string> = {
  'contract.list': 'gateway commands list',
  'contract.schema': 'gateway schema',
  'nodes.manifest': 'local node manifest',
  'nodes.list': 'relay nodes list',
  'sessions.list': 'sessions list',
  'sessions.get': 'session details',
  'sessions.create': 'create session',
  'sessions.renew': 'renew session',
  'sessions.attach': 'attach session descriptor',
  'sessions.detach': 'detach session handle',
  'sessions.stream': 'stream session output',
  'sessions.input': 'send session input',
  'sessions.interventions': 'session interventions',
  'sessions.handBack': 'hand back session control',
  'files.list': 'list session files',
  'files.stat': 'stat session file',
  'files.read': 'read session file',
  'files.write': 'write session file',
  'work-contexts.get': 'work context details',
  'handoffs.plan': 'plan cold handoff',
  'handoffs.create': 'create cold handoff',
  'handoffs.status': 'handoff status',
  'handoffs.cancel': 'cancel handoff',
  'handoffs.resume': 'handoff resume bundle',
  'handoffs.launch': 'launch handoff destination',
  'artifacts.read': 'read handoff artifact',
  'events.subscribe': 'subscribe gateway events',
};

function sideEffectForGatewayCommand(spec: RelayCliGatewayCommandSpec): RelayCommandSideEffect {
  if (spec.name === 'sessions.stream' || spec.name === 'events.subscribe') return 'stream';
  if (spec.name === 'handoffs.create' || spec.name === 'handoffs.launch') return 'destructive';
  if (
    spec.name === 'sessions.create' ||
    spec.name === 'sessions.renew' ||
    spec.name === 'sessions.detach' ||
    spec.name === 'sessions.input' ||
    spec.name === 'sessions.handBack' ||
    spec.name === 'files.write' ||
    spec.name === 'handoffs.cancel'
  ) {
    return 'write';
  }
  return 'read';
}

function scopeKindsForGatewayCommand(name: RelayCliGatewayCommand): readonly RelayCommandScopeKind[] {
  if (name.startsWith('nodes.')) return ['node'];
  if (name.startsWith('files.')) return ['session'];
  if (name.startsWith('work-contexts.')) return ['work-context'];
  if (name.startsWith('handoffs.')) return ['repo', 'worktree', 'work-context', 'session'];
  if (name.startsWith('artifacts.')) return ['work-context'];
  if (name.startsWith('events.')) return ['node', 'session'];
  if (name.startsWith('sessions.')) return ['session'];
  return [];
}

function requiresConfirmationForGatewayCommand(spec: RelayCliGatewayCommandSpec): boolean {
  return (
    spec.name === 'files.write' ||
    spec.name === 'handoffs.create' ||
    spec.name === 'handoffs.launch' ||
    spec.capabilityHints.includes('pty:exec:arbitrary') ||
    spec.capabilityHints.includes('rpc:fs:write')
  );
}

export function relayCommandDefinitionFromCliGatewaySpec(
  spec: RelayCliGatewayCommandSpec
): RelayCommandDefinition {
  return {
    id: spec.name,
    name: spec.name,
    label: COMMAND_LABELS[spec.name],
    description: spec.summary,
    summary: spec.summary,
    surfaces: CLI_AGENT_WEB_SURFACES,
    inputSchema: spec.inputSchema,
    outputSchema: spec.outputSchema,
    capabilityHints: spec.capabilityHints as readonly RelayCapabilityBit[],
    sideEffect: sideEffectForGatewayCommand(spec),
    requiresConfirmation: requiresConfirmationForGatewayCommand(spec),
    scopeKinds: scopeKindsForGatewayCommand(spec.name),
    handler: { cli: spec.cli },
    stable: spec.stable,
    source: 'cli-gateway-v1',
  };
}

export const RELAY_COMMAND_MANIFEST: RelayCommandManifest = {
  schemaVersion: 1,
  generatedFrom: 'shared/cli-gateway-contract.ts',
  commands: RELAY_CLI_GATEWAY_CONTRACT.commandSchemas.map(relayCommandDefinitionFromCliGatewaySpec),
};

export function relayCommandDefinition(name: RelayCliGatewayCommand): RelayCommandDefinition {
  const definition = RELAY_COMMAND_MANIFEST.commands.find((entry) => entry.name === name);
  if (!definition) throw new Error(`unknown Relay command definition: ${name}`);
  return definition;
}

export function relayCommandDefinitionsForSurface(
  surface: RelayCommandSurface
): RelayCommandDefinition[] {
  return RELAY_COMMAND_MANIFEST.commands.filter((command) => command.surfaces.includes(surface));
}
