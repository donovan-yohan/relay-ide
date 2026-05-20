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

import React, { useMemo } from 'react';

import type {
  WorkbenchBlockDescriptor,
  WorkbenchBlockContext,
} from '../../../shared/workbench-block-types.js';
import type { RelayCapabilityBit } from '../../../shared/security-policy.js';
import { getBlockRenderer } from './block-registry.js';
// Helpers live in shared/workbench-capability-utils.ts (no React/CSS) so
// tests can import the real logic without pulling in the DOM frontend stack.
import { missingCapabilities } from '../../../shared/workbench-capability-utils.js';
import './block-host.css';

// ---------------------------------------------------------------------------
// Capability gating helpers — re-exported from shared/workbench-capability-utils
// so tests import the real implementation and regressions are caught.
// ---------------------------------------------------------------------------

export {
  grantedBits,
  missingCapabilities,
} from '../../../shared/workbench-capability-utils.js';

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
// NodeDegradedCard — rendered when node helper cannot satisfy file RPC
// ---------------------------------------------------------------------------

/**
 * Kinds that require File RPC to function. When `context.nodeFileRpcAvailable`
 * is explicitly `false`, BlockHost renders a NodeDegradedCard instead of
 * attempting to mount the renderer (which would fail at the node level).
 *
 * Distinct from DeniedCard (capability-grant denied by policy) — this card
 * tells the user it's a *node-helper* issue, not a permission issue.
 */
const FILE_RPC_KINDS: ReadonlySet<string> = new Set(['file', 'artifact']);

interface NodeDegradedCardProps {
  kind: string;
  title: string;
}

function NodeDegradedCard({ kind, title }: NodeDegradedCardProps) {
  return (
    <div
      className="block-card block-node-degraded"
      role="alert"
      aria-label={`node helper unavailable: ${title}`}
    >
      <div className="block-card__kind">{kind}</div>
      <div className="block-card__title">{title}</div>
      <div className="block-node-degraded__heading">
        file rpc unavailable on this node
      </div>
      <div className="block-node-degraded__detail">
        the relay helper on this node does not support file rpc — check the
        node&apos;s helper version and degraded reasons in the nodes panel
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
          <button
            type="button"
            className="block-error__retry"
            onClick={this.handleRetry}
          >
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
 *   1. Node-degraded gate — if the node explicitly reports file RPC unavailable
 *      AND the block kind requires file RPC → NodeDegradedCard. This is checked
 *      BEFORE the capability gate so the user sees a node-helper message, not a
 *      generic capability-denied message.
 *   2. Capability gate — missing requirements → DeniedCard.
 *   3. Registry lookup — unknown kind → UnknownKindCard.
 *   4. Renderer wrapped in BlockErrorBoundary.
 */
export function BlockHost({
  descriptor,
  context,
}: BlockHostProps): React.ReactElement {
  // Always call hooks before any conditional return (Rules of Hooks).
  const missing = useMemo(
    () => missingCapabilities(descriptor, context),
    [descriptor, context]
  );

  // Step 1: node-degraded gate (file RPC unavailable on the helper side).
  // Checked before capability gate so the user sees a node-helper message
  // rather than a generic capability-denied message.
  if (
    context.nodeFileRpcAvailable === false &&
    FILE_RPC_KINDS.has(descriptor.kind)
  ) {
    return (
      <div className="block-host">
        <NodeDegradedCard kind={descriptor.kind} title={descriptor.title} />
      </div>
    );
  }

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
