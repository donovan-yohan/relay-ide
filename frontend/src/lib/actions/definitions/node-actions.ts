import {
  relayEmptyObjectSchema,
  relayUnknownErrorSchema,
  relayVoidResultSchema,
  type RelayActionDescriptor,
} from '../../../../../shared/action-descriptor.js';
import { relayActionDescriptorFromCommandDefinition } from '../../../../../shared/action-descriptor.js';
import { relayCommandDefinition } from '../../../../../shared/relay-command-manifest.js';
import type { RelayCliGatewayCommand } from '../../../../../shared/cli-gateway-contract.js';
import type { HubNodeSummary } from '../../../../../shared/relay-node-protocol.js';
import { nodeHasTerminalBackend } from '../../../../../shared/relay-node-protocol.js';
import type { NodePairingRequestSummary } from '../../../../../shared/node-pairing-requests.js';
import type { ActionContext, ActionMeta } from '../types.js';

export const NODE_PAIR_COMMAND = 'relay-ide node pair <hub-url>';
export const NODE_INSTALL_INSTRUCTIONS =
  'relay-ide node install --hub <hub> --service <launchd|systemd-user|wsl-systemd|manual>\nrelay-ide node link --hub <hub>';

const NODE_ACTION_ALIASES = ['node', 'nodes', 'pair', 'pair device', 'settings nodes'];

export type NodeCommandCenterActionKind =
  | 'add-node'
  | 'show-pending-requests'
  | 'approve-request'
  | 'deny-request'
  | 'edit-access'
  | 'copy-pair-command'
  | 'show-install-instructions'
  | 'open-terminal'
  | 'rotate-credential'
  | 'revoke-node';

export interface NodeCommandCenterActionMeta extends ActionMeta {
  nodeActionKind: NodeCommandCenterActionKind;
}

function uiOnlyDescriptor(input: {
  id: NodeCommandCenterActionMeta['id'];
  label: string;
  description: string;
  rationale: string;
  sideEffect?: RelayActionDescriptor['sideEffect'];
  confirmation?: RelayActionDescriptor['confirmation'];
}): RelayActionDescriptor {
  return {
    id: input.id,
    title: input.label,
    label: input.label,
    description: `${input.description} ui-only: ${input.rationale}`,
    input: { kind: 'typed-shape', type: 'ActionContext', schema: relayEmptyObjectSchema },
    availability: { state: 'unknown', reason: 'resolved from Settings → Nodes state at execution time' },
    sideEffect: input.sideEffect ?? 'ui',
    confirmation: input.confirmation ?? { required: false, controlRequirements: [] },
    surfaces: ['web', 'command-center'],
    result: { kind: 'json-schema', schema: relayVoidResultSchema },
    error: { kind: 'json-schema', schema: relayUnknownErrorSchema },
    stable: false,
    source: 'ui-action-registry',
    ui: { actionId: input.id, category: 'settings', aliases: NODE_ACTION_ALIASES },
  };
}

function commandDescriptor(commandName: RelayCliGatewayCommand): RelayActionDescriptor {
  return relayActionDescriptorFromCommandDefinition(relayCommandDefinition(commandName), {
    availability: {
      state: 'unknown',
      reason: 'resolved from Settings → Nodes state at execution time',
      capabilityHints: relayCommandDefinition(commandName).capabilityHints,
    },
    surfaces: ['web', 'command-center'],
  });
}

function nodeAction(input: {
  id: NodeCommandCenterActionMeta['id'];
  label: string;
  description: string;
  aliases: string[];
  kind: NodeCommandCenterActionKind;
  descriptor: RelayActionDescriptor;
  disabledReason?: (ctx: ActionContext) => string | undefined;
}): NodeCommandCenterActionMeta {
  return {
    id: input.id,
    label: input.label,
    description: input.description,
    category: 'settings',
    icon: 'node',
    aliases: [...NODE_ACTION_ALIASES, ...input.aliases],
    when: () => true,
    ...(input.disabledReason ? { disabledReason: input.disabledReason } : {}),
    descriptor: input.descriptor,
    nodeActionKind: input.kind,
  };
}

export function pendingNodeRequestReason(
  requests: readonly NodePairingRequestSummary[] | undefined
): string | undefined {
  if (!requests) return 'node pairing API unavailable';
  if (!requests.some((request) => request.state === 'pending')) {
    return 'no pending request';
  }
  return undefined;
}

export function nodeTerminalUnavailableReason(
  nodes: readonly HubNodeSummary[] | undefined
): string | undefined {
  if (!nodes) return 'nodes API unavailable';
  if (nodes.length === 0) return 'missing approval';
  const usable = nodes.find((node) => node.status !== 'revoked' && node.credentialState !== 'revoked');
  if (!usable) return 'credential revoked';
  const online = nodes.filter((node) => node.status === 'online' && node.credentialState !== 'revoked');
  if (online.length === 0) return 'offline';
  if (!online.some((node) => nodeHasTerminalBackend(node))) return 'unsupported capability';
  return undefined;
}

export function nodeCredentialActionUnavailableReason(
  nodes: readonly HubNodeSummary[] | undefined
): string | undefined {
  if (!nodes) return 'nodes API unavailable';
  if (nodes.length === 0) return 'missing approval';
  if (nodes.every((node) => node.status === 'revoked' || node.credentialState === 'revoked')) {
    return 'credential revoked';
  }
  return undefined;
}

export function firstPendingNodeRequest(
  requests: readonly NodePairingRequestSummary[]
): NodePairingRequestSummary | undefined {
  return requests.find((request) => request.state === 'pending');
}

export function firstManageableNode(
  nodes: readonly HubNodeSummary[]
): HubNodeSummary | undefined {
  return nodes.find(
    (node) => node.status !== 'revoked' && node.credentialState !== 'revoked'
  );
}

export function firstTerminalNode(
  nodes: readonly HubNodeSummary[]
): HubNodeSummary | undefined {
  return nodes.find(
    (node) =>
      node.status === 'online' &&
      node.credentialState !== 'revoked' &&
      nodeHasTerminalBackend(node)
  );
}

export const nodeCommandCenterActions: NodeCommandCenterActionMeta[] = [
  nodeAction({
    id: 'settings.nodes.add-node',
    label: 'add node',
    description: 'open Settings → Nodes add-node wizard',
    aliases: ['add node', 'pair new node', 'device code'],
    kind: 'add-node',
    descriptor: uiOnlyDescriptor({
      id: 'settings.nodes.add-node',
      label: 'add node',
      description: 'open Settings → Nodes add-node wizard',
      rationale:
        'the wizard is a browser navigation surface; node pairing itself is handled by nodes.pair.* descriptors and Settings → Nodes API state.',
    }),
  }),
  nodeAction({
    id: 'settings.nodes.pending-requests',
    label: 'show pending node requests',
    description: 'open Settings → Nodes pending pairing requests',
    aliases: ['pending node requests', 'pairing requests', 'nodes.pair.requests'],
    kind: 'show-pending-requests',
    descriptor: commandDescriptor('nodes.pair.requests'),
  }),
  nodeAction({
    id: 'settings.nodes.approve-request',
    label: 'approve node request',
    description: 'approve the first pending node pairing request through Settings → Nodes',
    aliases: ['approve pairing', 'nodes.pair.approve'],
    kind: 'approve-request',
    descriptor: commandDescriptor('nodes.pair.approve'),
  }),
  nodeAction({
    id: 'settings.nodes.deny-request',
    label: 'deny node request',
    description: 'deny the first pending node pairing request through Settings → Nodes',
    aliases: ['deny pairing', 'nodes.pair.deny'],
    kind: 'deny-request',
    descriptor: commandDescriptor('nodes.pair.deny'),
  }),
  nodeAction({
    id: 'settings.nodes.edit-access',
    label: 'edit node access',
    description: 'open Settings → Nodes request access editor',
    aliases: ['edit pairing access', 'trust profile', 'nodes.pair.editAccess'],
    kind: 'edit-access',
    descriptor: commandDescriptor('nodes.pair.editAccess'),
  }),
  nodeAction({
    id: 'settings.nodes.copy-pair-command',
    label: 'copy pair command',
    description: 'copy the redaction-safe node pair command placeholder',
    aliases: ['copy pair command', NODE_PAIR_COMMAND],
    kind: 'copy-pair-command',
    descriptor: uiOnlyDescriptor({
      id: 'settings.nodes.copy-pair-command',
      label: 'copy pair command',
      description: 'copy the redaction-safe node pair command placeholder',
      rationale:
        'copying a local clipboard placeholder is a UI helper; it intentionally does not mint or expose any credential/token.',
      sideEffect: 'ui',
    }),
  }),
  nodeAction({
    id: 'settings.nodes.install-instructions',
    label: 'show install instructions',
    description: 'open Settings → Nodes install/service instructions',
    aliases: ['install node', 'service instructions', 'node link'],
    kind: 'show-install-instructions',
    descriptor: uiOnlyDescriptor({
      id: 'settings.nodes.install-instructions',
      label: 'show install instructions',
      description: 'open Settings → Nodes install/service instructions',
      rationale:
        'install/service copy is static guidance in Settings → Nodes; there is no hub gateway mutation to execute.',
    }),
  }),
  nodeAction({
    id: 'settings.nodes.open-terminal',
    label: 'open terminal on node',
    description: 'create a terminal session on the first online paired node',
    aliases: ['remote terminal', 'terminal on node', 'sessions.create'],
    kind: 'open-terminal',
    descriptor: relayActionDescriptorFromCommandDefinition(relayCommandDefinition('sessions.create'), {
      availability: {
        state: 'unknown',
        reason: 'requires an online paired node with relay-pty capability',
        capabilityHints: ['session:create:terminal'],
      },
      surfaces: ['web', 'command-center'],
    }),
  }),
  nodeAction({
    id: 'settings.nodes.rotate-credential',
    label: 'rotate node credential',
    description: 'rotate the first manageable node credential after confirmation',
    aliases: ['rotate credential', 'nodes.rotateCredential'],
    kind: 'rotate-credential',
    descriptor: commandDescriptor('nodes.rotateCredential'),
  }),
  nodeAction({
    id: 'settings.nodes.revoke',
    label: 'revoke node',
    description: 'revoke the first manageable node credential after confirmation',
    aliases: ['revoke node credential', 'nodes.revoke'],
    kind: 'revoke-node',
    descriptor: commandDescriptor('nodes.revoke'),
  }),
];
