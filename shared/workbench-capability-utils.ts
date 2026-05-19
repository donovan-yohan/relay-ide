/**
 * Pure capability-gating helpers for Workbench blocks.
 *
 * No React, no CSS, no DOM — safe to import from any environment
 * (node, jsdom, vitest, server-side). Lives in shared/ so tests can import
 * the real logic without pulling in the React/DOM frontend stack.
 *
 * BlockHost re-exports these; tests import from here directly.
 */

import type {
  WorkbenchBlockDescriptor,
  WorkbenchBlockContext,
} from './workbench-block-types.js';
import type { RelayCapabilityBit } from './security-policy.js';

/**
 * Derive the set of capability bits actually granted by context.capabilityGrants.
 * A CapabilityGrantRef can carry a single `.capability` or a list `.capabilities`.
 */
export function grantedBits(
  context: WorkbenchBlockContext
): ReadonlySet<RelayCapabilityBit> {
  const bits = new Set<RelayCapabilityBit>();
  for (const grant of context.capabilityGrants) {
    if (grant.capability) bits.add(grant.capability);
    if (grant.capabilities) {
      for (const bit of grant.capabilities) {
        bits.add(bit);
      }
    }
  }
  return bits;
}

/**
 * Return the capability requirements that are NOT satisfied by the context.
 */
export function missingCapabilities(
  descriptor: WorkbenchBlockDescriptor,
  context: WorkbenchBlockContext
): readonly RelayCapabilityBit[] {
  const granted = grantedBits(context);
  return descriptor.capabilityRequirements.filter((bit) => !granted.has(bit));
}
