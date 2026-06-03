import {
  relayActionDescriptorFromCommandDefinition,
  type RelayActionDescriptor,
} from '../../../../../shared/action-descriptor.js';
import {
  RELAY_COMMAND_MANIFEST,
  type RelayCommandDefinition,
} from '../../../../../shared/relay-command-manifest.js';
import type { ActionMeta } from '../types.js';

export type CliGatewayCommandActionMeta = ActionMeta & {
  relayCommand: RelayCommandDefinition;
  descriptor: RelayActionDescriptor;
};

export function cliGatewayActionId(command: RelayCommandDefinition): `gateway.${string}` {
  return `gateway.${command.name}`;
}

function gatewayDisabledReason(command: RelayCommandDefinition): string {
  const argv = command.handler.cli?.join(' ') ?? command.name;
  return `stable cli gateway command; run via ${argv}. Command Center execution is not wired yet.`;
}

function cliGatewayCommandAction(
  command: RelayCommandDefinition
): CliGatewayCommandActionMeta {
  const reason = gatewayDisabledReason(command);
  return {
    id: cliGatewayActionId(command),
    label: command.label,
    description: command.description,
    aliases: [
      command.name,
      `relay ${command.name}`,
      command.handler.cli?.join(' ') ?? command.name,
      command.sideEffect,
      ...command.capabilityHints,
      ...command.scopeKinds,
    ],
    category: 'gateway',
    icon: 'v1',
    when: () => false,
    disabledReason: () => reason,
    relayCommand: command,
    descriptor: relayActionDescriptorFromCommandDefinition(command, {
      availability: {
        state: 'unavailable',
        reason,
        capabilityHints: command.capabilityHints,
      },
      surfaces: [...command.surfaces, 'command-center'],
    }),
  };
}

export const cliGatewayCommandActions: CliGatewayCommandActionMeta[] =
  RELAY_COMMAND_MANIFEST.commands.map(cliGatewayCommandAction);
