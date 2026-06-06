import {
  RELAY_CLI_GATEWAY_CONTRACT,
  type RelayCliGatewayCommand,
  type RelayCliGatewayCommandSpec,
  type RelayCliGatewayErrorCode,
  type RelayJsonSchema,
} from './cli-gateway-contract.js';
import type { RelayCapabilityBit } from './security-policy.js';

export type RelayCommandSurface = 'web' | 'cli' | 'agent';
export type RelayCommandSideEffect =
  | 'read'
  | 'write'
  | 'destructive'
  | 'stream';
export type RelayCommandScopeKind =
  | 'node'
  | 'repo'
  | 'worktree'
  | 'work-context'
  | 'session';
export type RelayCommandControlRequirement =
  | 'fresh-control-state'
  | 'latest-intervention-ack'
  | 'confirmation-challenge';
export type RelayCommandAuditExpectation =
  | 'schema-only'
  | 'bounded-redacted'
  | 'hashes-only'
  | 'action-summary'
  | 'stream-redacted';

export interface RelayCommandAuditRedaction {
  expectation: RelayCommandAuditExpectation;
  storesRawPrompt: false;
  storesRawTranscript: false;
  storesRawPtyInput: false;
  storesRawProviderState: false;
}

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
  controlRequirements: readonly RelayCommandControlRequirement[];
  auditRedaction: RelayCommandAuditRedaction;
  errorCodes: readonly RelayCliGatewayErrorCode[];
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
  'repos.add': 'add repo workspace',
  'workspaces.launch': 'launch workspace',
  'worktrees.create': 'create worktree',
  'worktrees.status': 'worktree cleanup preflight',
  'worktrees.delete': 'delete worktree',
  'worktrees.archive': 'archive worktree',
  'sessions.list': 'sessions list',
  'sessions.get': 'session details',
  'sessions.create': 'create session',
  'tickets.startWork': 'start ticket work',
  'branches.openSession': 'open branch session',
  'sessions.renew': 'renew session',
  'sessions.attach': 'attach session descriptor',
  'sessions.detach': 'detach session handle',
  'sessions.kill': 'kill session process',
  'sessions.rename': 'rename session',
  'sessions.stream': 'stream session output',
  'sessions.input': 'send session input',
  'sessions.interventions': 'session interventions',
  'sessions.handBack': 'hand back session control',
  'files.list': 'list session files',
  'files.stat': 'stat session file',
  'files.read': 'read session file',
  'files.write': 'write session file',
  'work-contexts.get': 'work context details',
  'context.create': 'create context packet',
  'context.get': 'context packet details',
  'context.list': 'list context packets',
  'context.pin': 'pin context packet',
  'context.unpin': 'unpin context packet',
  'inbox.send': 'send inbox message',
  'inbox.list': 'list inbox messages',
  'inbox.get': 'inbox message details',
  'inbox.ack': 'acknowledge inbox message',
  'inbox.resolve': 'resolve inbox message',
  'inbox.ignore': 'ignore inbox message',
  'handoffs.plan': 'plan cold handoff',
  'handoffs.create': 'create cold handoff',
  'handoffs.status': 'handoff status',
  'handoffs.cancel': 'cancel handoff',
  'handoffs.resume': 'handoff resume bundle',
  'handoffs.launch': 'launch handoff destination',
  'artifacts.read': 'read handoff artifact',
  'supervisor.snapshot': 'supervisor snapshot',
  'supervisor.sessions': 'supervisor sessions',
  'supervisor.sendText': 'supervisor send text',
  'supervisor.submit': 'supervisor submit',
  'events.subscribe': 'subscribe gateway events',
  'settings.get': 'safe settings get',
  'settings.update': 'safe settings update',
  'webhooks.status': 'webhook status',
  'webhooks.ping': 'webhook ping',
};

function sideEffectForGatewayCommand(
  spec: RelayCliGatewayCommandSpec
): RelayCommandSideEffect {
  if (spec.name === 'sessions.stream' || spec.name === 'events.subscribe')
    return 'stream';
  if (
    spec.name === 'handoffs.create' ||
    spec.name === 'handoffs.launch' ||
    spec.name === 'sessions.kill' ||
    spec.name === 'worktrees.delete' ||
    spec.name === 'worktrees.archive'
  )
    return 'destructive';
  if (
    spec.name === 'sessions.create' ||
    spec.name === 'tickets.startWork' ||
    spec.name === 'branches.openSession' ||
    spec.name === 'sessions.renew' ||
    spec.name === 'sessions.detach' ||
    spec.name === 'sessions.rename' ||
    spec.name === 'sessions.input' ||
    spec.name === 'sessions.handBack' ||
    spec.name === 'supervisor.sendText' ||
    spec.name === 'supervisor.submit' ||
    spec.name === 'files.write' ||
    spec.name === 'handoffs.cancel' ||
    spec.name === 'context.create' ||
    spec.name === 'context.pin' ||
    spec.name === 'context.unpin' ||
    spec.name === 'repos.add' ||
    spec.name === 'workspaces.launch' ||
    spec.name === 'worktrees.create' ||
    spec.name === 'inbox.send' ||
    spec.name === 'inbox.ack' ||
    spec.name === 'inbox.resolve' ||
    spec.name === 'inbox.ignore' ||
    spec.name === 'settings.update' ||
    spec.name === 'webhooks.ping'
  ) {
    return 'write';
  }
  return 'read';
}

function scopeKindsForGatewayCommand(
  name: RelayCliGatewayCommand
): readonly RelayCommandScopeKind[] {
  if (name.startsWith('nodes.')) return ['node'];
  if (name.startsWith('repos.')) return ['repo'];
  if (name.startsWith('workspaces.')) return ['work-context', 'repo', 'worktree'];
  if (name.startsWith('worktrees.')) return ['repo', 'worktree'];
  if (name.startsWith('files.')) return ['session'];
  if (name.startsWith('work-contexts.')) return ['work-context'];
  if (name.startsWith('context.')) return ['work-context', 'session'];
  if (name.startsWith('inbox.')) return ['session', 'work-context'];
  if (name.startsWith('handoffs.'))
    return ['repo', 'worktree', 'work-context', 'session'];
  if (name.startsWith('tickets.') || name.startsWith('branches.'))
    return ['repo', 'worktree', 'work-context', 'session'];
  if (name.startsWith('artifacts.')) return ['work-context'];
  if (name.startsWith('supervisor.')) return ['session'];
  if (name.startsWith('events.')) return ['node', 'session'];
  if (name.startsWith('settings.') || name.startsWith('webhooks.'))
    return ['node'];
  if (name.startsWith('sessions.')) return ['session'];
  return [];
}

function requiresConfirmationForGatewayCommand(
  spec: RelayCliGatewayCommandSpec
): boolean {
  return (
    spec.name === 'files.write' ||
    spec.name === 'sessions.kill' ||
    spec.name === 'settings.update' ||
    spec.name === 'worktrees.delete' ||
    spec.name === 'worktrees.archive' ||
    spec.name === 'handoffs.create' ||
    spec.name === 'handoffs.launch' ||
    spec.capabilityHints.includes('pty:exec:arbitrary') ||
    spec.capabilityHints.includes('rpc:fs:write')
  );
}

function controlRequirementsForGatewayCommand(
  spec: RelayCliGatewayCommandSpec
): readonly RelayCommandControlRequirement[] {
  const requirements: RelayCommandControlRequirement[] = [];
  if (requiresConfirmationForGatewayCommand(spec))
    requirements.push('confirmation-challenge');
  if (spec.name === 'supervisor.snapshot') {
    requirements.push('fresh-control-state', 'latest-intervention-ack');
  }
  if (
    spec.name === 'supervisor.sendText' ||
    spec.name === 'supervisor.submit'
  ) {
    requirements.push('fresh-control-state');
  }
  if (spec.name === 'sessions.handBack')
    requirements.push('latest-intervention-ack');
  return requirements;
}

function auditExpectationForGatewayCommand(
  spec: RelayCliGatewayCommandSpec
): RelayCommandAuditExpectation {
  if (
    spec.name === 'contract.list' ||
    spec.name === 'contract.schema' ||
    spec.name === 'nodes.manifest'
  ) {
    return 'schema-only';
  }
  if (spec.name === 'sessions.stream' || spec.name === 'events.subscribe')
    return 'stream-redacted';
  if (
    spec.name === 'supervisor.snapshot' ||
    spec.name === 'supervisor.sendText' ||
    spec.name === 'supervisor.submit'
  )
    return 'hashes-only';
  if (sideEffectForGatewayCommand(spec) === 'read') return 'bounded-redacted';
  return 'action-summary';
}

function auditRedactionForGatewayCommand(
  spec: RelayCliGatewayCommandSpec
): RelayCommandAuditRedaction {
  return {
    expectation: auditExpectationForGatewayCommand(spec),
    storesRawPrompt: false,
    storesRawTranscript: false,
    storesRawPtyInput: false,
    storesRawProviderState: false,
  };
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
    controlRequirements: controlRequirementsForGatewayCommand(spec),
    auditRedaction: auditRedactionForGatewayCommand(spec),
    errorCodes: spec.errorCodes,
    scopeKinds: scopeKindsForGatewayCommand(spec.name),
    handler: { cli: spec.cli },
    stable: spec.stable,
    source: 'cli-gateway-v1',
  };
}

export const RELAY_COMMAND_MANIFEST: RelayCommandManifest = {
  schemaVersion: 1,
  generatedFrom: 'shared/cli-gateway-contract.ts',
  commands: RELAY_CLI_GATEWAY_CONTRACT.commandSchemas.map(
    relayCommandDefinitionFromCliGatewaySpec
  ),
};

export function relayCommandDefinition(
  name: RelayCliGatewayCommand
): RelayCommandDefinition {
  const definition = RELAY_COMMAND_MANIFEST.commands.find(
    (entry) => entry.name === name
  );
  if (!definition) throw new Error(`unknown Relay command definition: ${name}`);
  return definition;
}

export function relayCommandDefinitionsForSurface(
  surface: RelayCommandSurface
): RelayCommandDefinition[] {
  return RELAY_COMMAND_MANIFEST.commands.filter((command) =>
    command.surfaces.includes(surface)
  );
}
