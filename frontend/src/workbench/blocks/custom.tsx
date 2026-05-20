/**
 * CustomBlock — Workbench slice 4 of epic #612.
 *
 * Replaces the slice-2 scaffold. Renders an approved custom block via the
 * template renderer system. The block is identified by its descriptor's
 * `rendererId`, which is the `proposalId` of the approved proposal.
 *
 * # Rendering flow
 *
 *   1. Look up the approved proposal by descriptor.meta.rendererId
 *      (= proposalId) via TanStack Query.
 *   2. Validate the proposal is `approved` (not revoked, not rejected).
 *   3. Render via TemplateRenderer with a sandboxed api object.
 *
 * # Revoked state
 *
 *   If the proposal was revoked, render a clear "revoked" card. The block
 *   will not execute any renderer code. A link to the audit entry is shown
 *   if `auditEventId` is available.
 *
 * # Sandbox boundary (non-negotiable)
 *
 *   TemplateRenderer receives only typed props and a whitelisted api object.
 *   It cannot access env vars, make network calls, read browser storage,
 *   access raw transcripts, or reach any ungranted capability endpoint.
 *   The api is constructed here and passed as a parameter — the renderer
 *   cannot import or reconstruct it.
 *
 *   Template kinds: 'status-card', 'kv-grid', 'link-list'.
 *   'jsx-snippet' is defined in types but always rejected at proposal time —
 *   it is never executed here (and will never reach approved status).
 *
 * Refs: #622, epic #612.
 */

import React from 'react';
import { useQuery } from '@tanstack/react-query';

import type { WorkbenchBlockRenderer } from '../../../../shared/workbench-block-types.js';
import { isKnownTemplateName } from '../../../../shared/workbench-custom-blocks.js';
import type { RelayCapabilityBit } from '../../../../shared/security-policy.js';
import { fetchCustomBlockProposalById } from '../../lib/api.js';
import { TemplateRenderer } from './custom-templates.js';

import './custom.css';
import './custom-templates.css';

// ---------------------------------------------------------------------------
// Query key factory
// ---------------------------------------------------------------------------

function proposalByIdKey(proposalId: string) {
  return ['custom-block-proposal', proposalId] as const;
}

// ---------------------------------------------------------------------------
// Revoked card
// ---------------------------------------------------------------------------

interface RevokedCardProps {
  title: string;
  proposalId: string;
  auditEventId?: string | undefined;
}

function RevokedCard({ title, proposalId, auditEventId }: RevokedCardProps) {
  return (
    <div
      className="block-custom block-custom--revoked"
      role="alert"
      aria-label={`revoked custom block: ${title}`}
    >
      <div className="block-custom__header">
        <div className="block-custom__kind">custom block — revoked</div>
        <div className="block-custom__title">{title}</div>
      </div>
      <div className="block-custom__body">
        <div className="block-custom__notice block-custom__notice--revoked">
          this custom block renderer was revoked and can no longer render
        </div>
        <div className="block-custom__info">
          <div className="block-custom__row">
            <span className="block-custom__key">proposal</span>
            <span className="block-custom__value">{proposalId}</span>
          </div>
          {auditEventId && (
            <div className="block-custom__row">
              <span className="block-custom__key">audit event</span>
              <span className="block-custom__value">{auditEventId}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// PendingCard — proposal exists but is still pending (not yet approved)
// ---------------------------------------------------------------------------

function PendingCard({
  title,
  proposalId,
}: {
  title: string;
  proposalId: string;
}) {
  return (
    <div
      className="block-custom block-custom--pending"
      role="status"
      aria-label={`pending custom block: ${title}`}
    >
      <div className="block-custom__header">
        <div className="block-custom__kind">
          custom block — pending approval
        </div>
        <div className="block-custom__title">{title}</div>
      </div>
      <div className="block-custom__body">
        <div className="block-custom__notice">
          this custom block is waiting for user approval (proposal: {proposalId}
          )
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// NotFoundCard — no proposal found for the given rendererId
// ---------------------------------------------------------------------------

function NotFoundCard({
  title,
  rendererId,
}: {
  title: string;
  rendererId: string;
}) {
  return (
    <div
      className="block-custom block-custom--not-found"
      role="alert"
      aria-label={`unknown custom block: ${title}`}
    >
      <div className="block-custom__header">
        <div className="block-custom__kind">
          custom block — unknown renderer
        </div>
        <div className="block-custom__title">{title}</div>
      </div>
      <div className="block-custom__body">
        <div className="block-custom__notice">
          no approved proposal found for renderer: {rendererId}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// CustomBlock renderer
// ---------------------------------------------------------------------------

export const CustomBlock: WorkbenchBlockRenderer<'custom'> = ({
  descriptor,
  context,
}) => {
  const { rendererId } = descriptor.meta;

  // Fetch the proposal by id regardless of status. This ensures revoked and
  // pending proposals render the correct card instead of the unknown-renderer
  // fallback (fix #1).
  const {
    data: proposal,
    isLoading,
    error,
  } = useQuery({
    queryKey: proposalByIdKey(rendererId),
    queryFn: () => fetchCustomBlockProposalById(rendererId),
    // Treat 404 as a non-error to render the NotFoundCard gracefully.
    throwOnError: false,
  });

  if (isLoading) {
    return (
      <div
        className="block-custom"
        aria-label={`custom block: ${descriptor.title}`}
      >
        <div className="block-custom__header">
          <div className="block-custom__kind">custom block</div>
          <div className="block-custom__title">{descriptor.title}</div>
        </div>
        <div className="block-custom__body">
          <div className="block-custom__notice">loading renderer...</div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div
        className="block-custom"
        role="alert"
        aria-label={`custom block error: ${descriptor.title}`}
      >
        <div className="block-custom__header">
          <div className="block-custom__kind">custom block — error</div>
          <div className="block-custom__title">{descriptor.title}</div>
        </div>
        <div className="block-custom__body">
          <div className="block-custom__notice block-custom__notice--error">
            failed to load renderer: {(error as Error).message}
          </div>
        </div>
      </div>
    );
  }

  if (!proposal) {
    return <NotFoundCard title={descriptor.title} rendererId={rendererId} />;
  }

  if (proposal.status === 'revoked') {
    return (
      <RevokedCard
        title={descriptor.title}
        proposalId={proposal.proposalId}
        auditEventId={proposal.auditEventId}
      />
    );
  }

  if (proposal.status === 'pending') {
    return (
      <PendingCard title={descriptor.title} proposalId={proposal.proposalId} />
    );
  }

  // proposal.status === 'approved' — render via template
  const { rendererSource } = proposal;

  if (rendererSource.kind !== 'template') {
    // jsx-snippet or any future kind that is not yet implemented
    return (
      <div
        className="block-custom"
        role="alert"
        aria-label={`custom block unsupported renderer: ${descriptor.title}`}
      >
        <div className="block-custom__header">
          <div className="block-custom__kind">
            custom block — unsupported renderer
          </div>
          <div className="block-custom__title">{descriptor.title}</div>
        </div>
        <div className="block-custom__body">
          <div className="block-custom__notice">
            renderer source kind &ldquo;{rendererSource.kind}&rdquo; is not
            supported in this version
          </div>
        </div>
      </div>
    );
  }

  if (!isKnownTemplateName(rendererSource.template)) {
    return (
      <div
        className="block-custom"
        role="alert"
        aria-label={`custom block unknown template: ${descriptor.title}`}
      >
        <div className="block-custom__header">
          <div className="block-custom__kind">
            custom block — unknown template
          </div>
          <div className="block-custom__title">{descriptor.title}</div>
        </div>
        <div className="block-custom__body">
          <div className="block-custom__notice">
            unknown template: {rendererSource.template}
          </div>
        </div>
      </div>
    );
  }

  // Build the sandboxed api for the template renderer.
  //
  // SECURITY BOUNDARY: this api object is the ONLY side-effect channel
  // available to the template renderer. It is typed and constructed here —
  // the renderer cannot import or reconstruct it.
  //
  // Whitelisted:
  //   getWorkContextStatus — returns id+status only, never full transcript
  //   listGrantedCapabilities — returns granted bit names, read-only
  //
  // Blocked (not accessible from the renderer):
  //   env vars, network fetch, browser storage, raw session bytes, secrets
  // Flatten both `capability` (singular) and `capabilities` (array) from each
  // CapabilityGrantRef — the schema allows either or both fields (fix #2).
  const grantedBitNames: RelayCapabilityBit[] =
    context.capabilityGrants.flatMap((g) =>
      (
        [g.capability, ...(g.capabilities ?? [])] as Array<
          RelayCapabilityBit | undefined
        >
      ).filter((bit): bit is RelayCapabilityBit => bit !== undefined)
    );

  const sandboxApi = {
    getWorkContextStatus: (_workContextId: string): string | null => {
      // Returns work context status only — no full transcript
      // The context.workContext?.id check prevents cross-context info leakage
      if (context.workContext && context.workContext.id === _workContextId) {
        // WorkContext.source is the status field in the current schema
        return context.workContext.source ?? null;
      }
      return null;
    },
    listGrantedCapabilities: (): RelayCapabilityBit[] => grantedBitNames,
  };

  const sandboxContext: {
    workContextId?: string | undefined;
    workContextStatus?: string | undefined;
    capabilityGrants: readonly RelayCapabilityBit[];
  } = {
    ...(context.workContext?.id !== undefined
      ? { workContextId: context.workContext.id }
      : {}),
    ...(context.workContext?.source !== undefined
      ? { workContextStatus: context.workContext.source }
      : {}),
    capabilityGrants: grantedBitNames,
  };

  return (
    <div
      className="block-custom block-custom--active"
      aria-label={`custom block: ${descriptor.title}`}
    >
      <div className="block-custom__header">
        <div className="block-custom__kind">custom block</div>
        <div className="block-custom__title">{descriptor.title}</div>
      </div>
      <div className="block-custom__body block-custom__body--template">
        <TemplateRenderer
          descriptor={descriptor}
          context={sandboxContext}
          api={sandboxApi}
          template={rendererSource.template}
          props={rendererSource.props as Record<string, unknown>}
        />
      </div>
    </div>
  );
};

export default CustomBlock;
