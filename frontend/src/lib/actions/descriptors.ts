import {
  relayEmptyObjectSchema,
  relayUnknownErrorSchema,
  relayVoidResultSchema,
  type RelayActionAvailability,
  type RelayActionDescriptor,
} from '../../../../shared/action-descriptor.js';
import type { ActionContext, ActionMeta } from './types.js';

function capabilityAvailability(
  state: RelayActionAvailability['state'],
  reason: string | undefined,
  fallback: RelayActionAvailability | undefined
): RelayActionAvailability {
  return {
    state,
    ...(reason ? { reason } : {}),
    ...(fallback?.capabilityHints
      ? { capabilityHints: fallback.capabilityHints }
      : {}),
  };
}

function uiMetadata(meta: ActionMeta): NonNullable<RelayActionDescriptor['ui']> {
  return {
    actionId: meta.id,
    category: meta.category,
    ...(meta.icon ? { icon: meta.icon } : {}),
    ...(meta.aliases ? { aliases: meta.aliases } : {}),
    ...(meta.shortcut ? { shortcut: meta.shortcut } : {}),
    ...(meta.mobile ? { mobile: meta.mobile } : {}),
  };
}

function availabilityFromActionMeta(
  meta: ActionMeta,
  ctx: ActionContext | undefined,
  fallback: RelayActionAvailability | undefined
): RelayActionAvailability {
  if (!ctx) {
    return fallback ?? { state: 'unknown', reason: 'action context not supplied' };
  }

  const enabled = meta.when?.(ctx) ?? true;

  if (!enabled) {
    const disabledReason = meta.disabledReason?.(ctx);
    return capabilityAvailability(
      'unavailable',
      disabledReason ?? fallback?.reason ?? 'not available in the current context',
      fallback
    );
  }

  return capabilityAvailability('available', undefined, fallback);
}

/**
 * Project frontend ActionMeta into the shared descriptor bridge.
 *
 * This is intentionally a projection, not a new execution registry: UI-only
 * actions remain `source: ui-action-registry`, while stable Relay commands keep
 * their `descriptor.contract` from `shared/relay-command-manifest.ts`.
 */
export function actionDescriptorFromMeta(
  meta: ActionMeta,
  ctx?: ActionContext
): RelayActionDescriptor {
  const availability = availabilityFromActionMeta(
    meta,
    ctx,
    meta.descriptor?.availability
  );

  if (meta.descriptor) {
    return {
      ...meta.descriptor,
      availability,
      ui: {
        ...uiMetadata(meta),
        ...meta.descriptor.ui,
      },
    };
  }

  return {
    id: meta.id,
    title: meta.label,
    label: meta.label,
    ...(meta.description ? { description: meta.description } : {}),
    input: {
      kind: 'typed-shape',
      type: 'ActionContext',
      schema: relayEmptyObjectSchema,
    },
    availability,
    sideEffect: 'ui',
    confirmation: {
      required: false,
      controlRequirements: [],
    },
    surfaces: ['web', 'command-center'],
    result: { kind: 'json-schema', schema: relayVoidResultSchema },
    error: { kind: 'json-schema', schema: relayUnknownErrorSchema },
    stable: false,
    source: 'ui-action-registry',
    ui: uiMetadata(meta),
  };
}
