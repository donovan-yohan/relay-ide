import {
  RELAY_COMMAND_MANIFEST,
  type RelayCommandDefinition,
} from '../../../../../shared/relay-command-manifest.js';
import type { ActionMeta } from '../types.js';

export type CliGatewayCommandActionMeta = ActionMeta & {
  relayCommand: RelayCommandDefinition;
};

export function cliGatewayActionId(command: RelayCommandDefinition): `gateway.${string}` {
  return `gateway.${command.name}`;
}

function gatewayDisabledReason(command: RelayCommandDefinition): string {
  const argv = command.handler.cli?.join(' ') ?? command.name;
  return `stable cli gateway command; run via ${argv}. Command Center execution is not wired yet.`;
}

export const cliGatewayCommandActions: CliGatewayCommandActionMeta[] =
  RELAY_COMMAND_MANIFEST.commands.map((command) => ({
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
    disabledReason: () => gatewayDisabledReason(command),
    relayCommand: command,
  }));
