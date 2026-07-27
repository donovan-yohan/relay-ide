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

const UI_ACTION_BY_GATEWAY_COMMAND: Partial<
  Record<RelayCliGatewayCommand, string>
> = {
  'settings.get': 'settings.open',
};

const COMMAND_LABELS: Record<RelayCliGatewayCommand, string> = {
  'contract.list': 'gateway commands list',
  'contract.schema': 'gateway schema',
  'nodes.manifest': 'local node manifest',
  'nodes.list': 'relay nodes list',
  'nodes.pair.requests': 'pending node requests',
  'nodes.pair.approve': 'approve node request',
  'nodes.pair.deny': 'deny node request',
  'nodes.pair.editAccess': 'edit node access',
  'nodes.rotateCredential': 'rotate node credential',
  'nodes.revoke': 'revoke node',
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
  'sessions.wait': 'wait for session output',
  'sessions.screen': 'read rendered terminal screen snapshot',
  'sessions.input': 'send session input',
  'sessions.interventions': 'session interventions',
  'files.list': 'list session files',
  'files.stat': 'stat session file',
  'files.read': 'read session file',
  'files.write': 'write session file',
  'work-contexts.get': 'work context details',
  'work-contexts.resume': 'work context resume packet',
  'work-context-messages.append': 'append work context message',
  'work-context-messages.list': 'list work context messages',
  'work-context-messages.show': 'show work context message',
  'work-context-messages.query': 'query work context messages',
  'work-context-messages.templates.list': 'list message templates',
  'work-context-messages.templates.show': 'show message template',
  'work-context-messages.templates.render': 'render message template',
  'context.create': 'create context packet',
  'context.get': 'context packet details',
  'context.list': 'list context packets',
  'context.pin': 'pin context packet',
  'context.unpin': 'unpin context packet',
  'work-context-artifacts.publish': 'publish workcontext artifact',
  'work-context-artifacts.list': 'list workcontext artifacts',
  'work-context-artifacts.show': 'show workcontext artifact',
  'work-context-artifacts.pin': 'pin workcontext artifact',
  'work-context-artifacts.unpin': 'unpin workcontext artifact',
  'work-context-artifacts.export': 'export workcontext artifact',
  'work-context-artifacts.doctor': 'doctor workcontext artifact store',
  'handoff-artifacts.attach': 'attach pipeline handoff artifact',
  'handoff-artifacts.list': 'list pipeline handoff artifacts',
  'handoff-artifacts.show': 'show pipeline handoff artifact',
  'handoff-artifacts.copy': 'copy pipeline handoff artifact',
  'workflow-runs.publish': 'publish workflow run projection',
  'workflow-runs.update': 'update workflow run projection',
  'workflow-runs.list': 'list workflow run projections',
  'workflow-runs.get': 'workflow run details',
  'automation-runs.register': 'register automation/watchdog run',
  'automation-runs.observe': 'observe automation/watchdog run',
  'automation-runs.retire': 'retire automation/watchdog run',
  'automation-runs.list': 'list automation/watchdog runs',
  'automation-runs.get': 'automation/watchdog run details',
  'pr-overseer.register': 'register pr/check/review overseer',
  'pr-overseer.observe': 'observe pr checks/reviews/mergeability',
  'pr-overseer.retire': 'retire pr overseer',
  'pr-overseer.list': 'list pr overseers',
  'pr-overseer.get': 'pr overseer details + handoff readiness',
  'workspace-surfaces.list': 'list workspace surfaces',
  'workspace-surfaces.publish': 'publish workspace surface',
  'workspace-topics.list': 'list workspace topics',
  'workspace-topics.search': 'search bounded workspace topic history',
  'workspace-topics.get': 'workspace topic details',
  'workspace-topics.create': 'create workspace topic',
  'workspace-topics.update': 'update workspace topic',
  'workspace-topics.archive': 'archive workspace topic',
  'channels.post': 'post channel message',
  'cockpit.list': 'terminal attention cockpit',
  'cockpit.get': 'terminal cockpit detail',
  'inbox.send': 'send inbox message',
  'inbox.list': 'list inbox messages',
  'inbox.get': 'inbox message details',
  'inbox.ack': 'acknowledge inbox message',
  'inbox.resolve': 'resolve inbox message',
  'inbox.ignore': 'ignore inbox message',
  'handoffs.plan': 'plan cold handoff',
  'artifacts.read': 'read handoff artifact',
  'supervisor.snapshot': 'supervisor snapshot',
  'supervisor.sessions': 'supervisor sessions',
  'supervisor.sendText': 'supervisor send text',
  'supervisor.sendKey': 'supervisor send key',
  'supervisor.submit': 'supervisor submit',
  'events.subscribe': 'subscribe gateway events',
  'settings.get': 'safe settings get',
  'settings.update': 'safe settings update',
  'webhooks.status': 'webhook status',
  'webhooks.ping': 'webhook ping',
};

const STREAM_GATEWAY_COMMANDS = new Set<RelayCliGatewayCommand>([
  'sessions.stream',
  'sessions.wait',
  'events.subscribe',
]);

const DESTRUCTIVE_GATEWAY_COMMANDS = new Set<RelayCliGatewayCommand>([
  'nodes.revoke',
  'sessions.kill',
  'worktrees.delete',
  'worktrees.archive',
  'workspace-topics.archive',
]);

const WRITE_GATEWAY_COMMANDS = new Set<RelayCliGatewayCommand>([
  'nodes.pair.approve',
  'nodes.pair.deny',
  'nodes.pair.editAccess',
  'nodes.rotateCredential',
  'sessions.create',
  'tickets.startWork',
  'branches.openSession',
  'sessions.renew',
  'sessions.detach',
  'sessions.rename',
  'sessions.input',
  'supervisor.sendText',
  'supervisor.sendKey',
  'supervisor.submit',
  'files.write',
  'context.create',
  'context.pin',
  'context.unpin',
  'work-context-messages.append',
  'work-context-artifacts.publish',
  'work-context-artifacts.pin',
  'work-context-artifacts.unpin',
  'handoff-artifacts.attach',
  'workflow-runs.publish',
  'workflow-runs.update',
  'automation-runs.register',
  'automation-runs.observe',
  'automation-runs.retire',
  'pr-overseer.register',
  'pr-overseer.observe',
  'pr-overseer.retire',
  'workspace-surfaces.publish',
  'workspace-topics.create',
  'workspace-topics.update',
  'channels.post',
  'repos.add',
  'workspaces.launch',
  'worktrees.create',
  'inbox.send',
  'inbox.ack',
  'inbox.resolve',
  'inbox.ignore',
  'settings.update',
  'webhooks.ping',
]);

const WORK_CONTEXT_ONLY_SCOPE_PREFIXES = [
  'work-contexts.',
  'work-context-messages.',
  'work-context-artifacts.',
  'handoff-artifacts.',
  'workflow-runs.',
  'workspace-topics.',
] as const;

function startsWithAny(
  name: RelayCliGatewayCommand,
  prefixes: readonly string[]
): boolean {
  return prefixes.some((prefix) => name.startsWith(prefix));
}

function sideEffectForGatewayCommand(
  spec: RelayCliGatewayCommandSpec
): RelayCommandSideEffect {
  if (STREAM_GATEWAY_COMMANDS.has(spec.name)) return 'stream';
  if (DESTRUCTIVE_GATEWAY_COMMANDS.has(spec.name)) return 'destructive';
  if (WRITE_GATEWAY_COMMANDS.has(spec.name)) return 'write';
  return 'read';
}

function scopeKindsForGatewayCommand(
  name: RelayCliGatewayCommand
): readonly RelayCommandScopeKind[] {
  if (name.startsWith('contract.')) return ['node'];
  if (name.startsWith('nodes.')) return ['node'];
  if (name.startsWith('repos.')) return ['repo'];
  if (name.startsWith('workspaces.'))
    return ['work-context', 'repo', 'worktree'];
  if (name.startsWith('worktrees.')) return ['repo', 'worktree'];
  if (name.startsWith('files.')) return ['session'];
  if (startsWithAny(name, WORK_CONTEXT_ONLY_SCOPE_PREFIXES))
    return ['work-context'];
  if (name.startsWith('automation-runs.'))
    return ['work-context', 'repo', 'session'];
  if (name.startsWith('pr-overseer.'))
    return ['work-context', 'repo', 'session'];
  if (name.startsWith('workspace-surfaces.'))
    return ['work-context', 'repo', 'worktree', 'node'];
  if (name.startsWith('cockpit.')) return ['work-context', 'session'];
  if (name.startsWith('context.')) return ['work-context', 'session'];
  if (name.startsWith('channels.')) return ['work-context', 'session'];
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
    spec.name === 'nodes.pair.approve' ||
    spec.name === 'nodes.rotateCredential' ||
    spec.name === 'nodes.revoke' ||
    spec.name === 'sessions.kill' ||
    spec.name === 'settings.update' ||
    spec.name === 'worktrees.delete' ||
    spec.name === 'worktrees.archive' ||
    spec.name === 'workspace-topics.archive' ||
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
    spec.name === 'supervisor.sendKey' ||
    spec.name === 'supervisor.submit'
  ) {
    requirements.push('fresh-control-state');
  }
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
  if (STREAM_GATEWAY_COMMANDS.has(spec.name)) return 'stream-redacted';
  if (
    spec.name === 'supervisor.snapshot' ||
    spec.name === 'supervisor.sendText' ||
    spec.name === 'supervisor.sendKey' ||
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
  const uiAction = UI_ACTION_BY_GATEWAY_COMMAND[spec.name];
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
    handler: { cli: spec.cli, ...(uiAction ? { uiAction } : {}) },
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
