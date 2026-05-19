/**
 * BlockHost — Workbench slice 2 of epic #612.
 *
 * Renders one block given its descriptor + current context.
 * Responsibilities:
 *   1. Capability gating — if descriptor.capabilityRequirements aren't
 *      satisfied by context.capabilityGrants, renders a denied-state card
 *      listing missing capabilities.
 *   2. Unknown-kind fallback — if no renderer is registered for the descriptor
 *      kind, renders a safe placeholder card. Never throws.
 *   3. Error boundary — wraps the renderer so a render-time throw from a
 *      renderer does not crash the outer application.
 *
 * Does NOT own layout/persistence (slice 3) or canvas integration — the host
 * is a pure render-a-block-given-its-descriptor component.
 */

import React from 'react';

import type {
  WorkbenchBlockDescriptor,
  WorkbenchBlockContext,
} from '../../../shared/workbench-block-types.js';
import type { RelayCapabilityBit } from '../../../shared/security-policy.js';
import { getBlockRenderer } from './block-registry.js';
import './block-host.css';

// ---------------------------------------------------------------------------
// Capability gating helpers
// ---------------------------------------------------------------------------

/**
 * Derive the set of capability bits actually granted by context.capabilityGrants.
 * A CapabilityGrantRef can carry a single `.capability` or a list `.capabilities`.
 */
function grantedBits(
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
function missingCapabilities(
  descriptor: WorkbenchBlockDescriptor,
  context: WorkbenchBlockContext
): readonly RelayCapabilityBit[] {
  const granted = grantedBits(context);
  return descriptor.capabilityRequirements.filter((bit) => !granted.has(bit));
}

// ---------------------------------------------------------------------------
// DeniedCard — rendered when capability requirements are not met
// ---------------------------------------------------------------------------

interface DeniedCardProps {
  kind: string;
  title: string;
  missing: readonly RelayCapabilityBit[];
}

function DeniedCard({ kind, title, missing }: DeniedCardProps) {
  return (
    <div
      className="block-card block-denied"
      role="alert"
      aria-label={`access denied: ${title}`}
    >
      <div className="block-card__kind">{kind}</div>
      <div className="block-card__title">{title}</div>
      <div className="block-denied__heading">
        access denied — missing capabilities
      </div>
      <div className="block-denied__bits">
        {missing.map((bit) => (
          <div key={bit} className="block-denied__bit">
            {bit}
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// UnknownKindCard — rendered when no renderer is found for the descriptor kind
// ---------------------------------------------------------------------------

interface UnknownKindCardProps {
  kind: string;
  title: string;
  capabilityRequirements: readonly RelayCapabilityBit[];
}

function UnknownKindCard({
  kind,
  title,
  capabilityRequirements,
}: UnknownKindCardProps) {
  return (
    <div
      className="block-card"
      role="region"
      aria-label={`unknown block kind: ${kind}`}
    >
      <div className="block-card__kind">unknown block kind: {kind}</div>
      <div className="block-card__title">{title}</div>
      {capabilityRequirements.length > 0 && (
        <div className="block-card__body">
          requires: {capabilityRequirements.join(', ')}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// BlockErrorBoundary — catches renderer throws
// ---------------------------------------------------------------------------

interface BlockErrorBoundaryProps {
  children: React.ReactNode;
  blockId: string;
  blockKind: string;
}

interface BlockErrorBoundaryState {
  error: Error | null;
}

export class BlockErrorBoundary extends React.Component<
  BlockErrorBoundaryProps,
  BlockErrorBoundaryState
> {
  constructor(props: BlockErrorBoundaryProps) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): BlockErrorBoundaryState {
    return { error };
  }

  handleRetry = () => {
    this.setState({ error: null });
  };

  override render() {
    if (this.state.error) {
      return (
        <div
          className="block-card block-error"
          role="alert"
          aria-label="block render error"
        >
          <div className="block-card__kind">
            {this.props.blockKind} · {this.props.blockId}
          </div>
          <div className="block-error__heading">renderer error</div>
          <div className="block-error__detail">{this.state.error.message}</div>
          <button className="block-error__retry" onClick={this.handleRetry}>
            retry
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

// ---------------------------------------------------------------------------
// BlockHost
// ---------------------------------------------------------------------------

export interface BlockHostProps {
  descriptor: WorkbenchBlockDescriptor;
  context: WorkbenchBlockContext;
}

/**
 * BlockHost renders one Workbench block given its descriptor and context.
 *
 * Rendering pipeline (in order):
 *   1. Capability gate — missing requirements → DeniedCard.
 *   2. Registry lookup — unknown kind → UnknownKindCard.
 *   3. Renderer wrapped in BlockErrorBoundary.
 */
export function BlockHost({
  descriptor,
  context,
}: BlockHostProps): React.ReactElement {
  const missing = missingCapabilities(descriptor, context);

  if (missing.length > 0) {
    return (
      <div className="block-host">
        <DeniedCard
          kind={descriptor.kind}
          title={descriptor.title}
          missing={missing}
        />
      </div>
    );
  }

  const Renderer = getBlockRenderer(descriptor.kind);

  if (!Renderer) {
    return (
      <div className="block-host">
        <UnknownKindCard
          kind={descriptor.kind}
          title={descriptor.title}
          capabilityRequirements={descriptor.capabilityRequirements}
        />
      </div>
    );
  }

  return (
    <div className="block-host">
      <BlockErrorBoundary blockId={descriptor.id} blockKind={descriptor.kind}>
        {/* The cast is safe: getBlockRenderer<K> returns WorkbenchBlockRenderer<K>
            whose descriptor prop is Extract<WorkbenchBlockDescriptor, { kind: K }>.
            descriptor.kind matched during the registry lookup above, so the
            discriminated-union type matches. We use an explicit cast here because
            the registry map stores WorkbenchBlockRenderer<any> internally. */}
        <Renderer
          descriptor={
            descriptor as Parameters<typeof Renderer>[0]['descriptor']
          }
          context={context}
        />
      </BlockErrorBoundary>
    </div>
  );
}

export default BlockHost;
