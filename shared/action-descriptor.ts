import type {
  RelayCliGatewayCommand,
  RelayCliGatewayErrorCode,
  RelayJsonSchema,
} from './cli-gateway-contract.js';
import { gatewayErrorSchema } from './cli-gateway-contract.js';
import type {
  RelayCommandControlRequirement,
  RelayCommandDefinition,
  RelayCommandSideEffect,
  RelayCommandSurface,
} from './relay-command-manifest.js';
import type { RelayCapabilityBit } from './security-policy.js';

export type RelayActionSurface = RelayCommandSurface | 'command-center';
export type RelayActionSideEffectClass = RelayCommandSideEffect | 'ui';
export type RelayActionAvailabilityState =
  | 'available'
  | 'unavailable'
  | 'unknown';

export interface RelayActionAvailability {
  state: RelayActionAvailabilityState;
  reason?: string;
  capabilityHints?: readonly RelayCapabilityBit[];
}

export type RelayActionShapeDescriptor =
  | {
      kind: 'json-schema';
      schema: RelayJsonSchema;
    }
  | {
      kind: 'typed-shape';
      type: string;
      schema?: RelayJsonSchema;
    };

export interface RelayActionConfirmationDescriptor {
  required: boolean;
  controlRequirements: readonly RelayCommandControlRequirement[];
  reason?: string;
}

/**
 * Shared bridge descriptor for Relay actions.
 *
 * Field ownership is deliberately split:
 * - Top-level `id`, `input`, `result`, `error`, `sideEffect`, `confirmation`,
 *   `surfaces`, and `availability` are the stable cross-surface contract.
 * - `contract` is populated only for commands sourced from
 *   `shared/relay-command-manifest.ts` / `RELAY_CLI_GATEWAY_CONTRACT` and is
 *   safe for CLI/API/agent tooling to treat as a stable Relay command.
 * - `ui` is Command Center metadata only. UI-only helpers can be searchable and
 *   typed without pretending they are part of the stable CLI/agent gateway.
 */
export interface RelayActionDescriptor {
  id: string;
  title: string;
  label: string;
  description?: string;
  input: RelayActionShapeDescriptor;
  availability: RelayActionAvailability;
  sideEffect: RelayActionSideEffectClass;
  confirmation: RelayActionConfirmationDescriptor;
  surfaces: readonly RelayActionSurface[];
  result: RelayActionShapeDescriptor;
  error: RelayActionShapeDescriptor;
  stable: boolean;
  source: 'cli-gateway-v1' | 'ui-action-registry';
  contract?: {
    relayCommandName: RelayCliGatewayCommand;
    stable: boolean;
    source: 'shared/relay-command-manifest.ts';
    cli?: readonly string[];
    errorCodes?: readonly RelayCliGatewayErrorCode[];
  };
  ui?: {
    actionId: string;
    category: string;
    icon?: string;
    aliases?: readonly string[];
    shortcut?: { key: string; global?: boolean };
    mobile?: { showInSheet?: boolean; label?: string };
  };
}

export const relayEmptyObjectSchema: RelayJsonSchema = {
  title: 'EmptyObject',
  type: 'object',
  additionalProperties: false,
};

export const relayVoidResultSchema: RelayJsonSchema = {
  title: 'VoidResult',
  type: 'object',
  additionalProperties: false,
  properties: {},
};

export const relayUnknownErrorSchema: RelayJsonSchema = {
  title: 'RelayActionError',
  type: 'object',
  additionalProperties: true,
};

function uiActionCategory(actionId: string): string {
  return actionId.split('.', 1)[0] || 'ui';
}

export function relayActionDescriptorFromCommandDefinition(
  command: RelayCommandDefinition,
  options: {
    availability?: RelayActionAvailability;
    surfaces?: readonly RelayActionSurface[];
  } = {}
): RelayActionDescriptor {
  return {
    id: command.id,
    title: command.label,
    label: command.label,
    description: command.description,
    input: { kind: 'json-schema', schema: command.inputSchema },
    availability: options.availability ?? {
      state: 'available',
      capabilityHints: command.capabilityHints,
    },
    sideEffect: command.sideEffect,
    confirmation: {
      required: command.requiresConfirmation,
      controlRequirements: command.controlRequirements,
    },
    surfaces: options.surfaces ?? command.surfaces,
    result: { kind: 'json-schema', schema: command.outputSchema },
    error: {
      kind: 'typed-shape',
      type: 'RelayCliGatewayErrorEnvelope',
      schema: gatewayErrorSchema,
    },
    stable: command.stable,
    source: 'cli-gateway-v1',
    ...(command.handler.uiAction
      ? {
          ui: {
            actionId: command.handler.uiAction,
            category: uiActionCategory(command.handler.uiAction),
          },
        }
      : {}),
    contract: {
      relayCommandName: command.name,
      stable: command.stable,
      source: 'shared/relay-command-manifest.ts',
      ...(command.handler.cli ? { cli: command.handler.cli } : {}),
      errorCodes: command.errorCodes,
    },
  };
}
