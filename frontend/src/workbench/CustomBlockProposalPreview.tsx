/**
 * CustomBlockProposalPreview — slice 4 of epic #612.
 *
 * Shows the list of pending custom block proposals. For each proposal:
 *   1. Renders the proposed block in a sandboxed preview (same template
 *      renderer used on approval — preview = same execution path).
 *   2. Displays a prominent capability requirements disclosure.
 *   3. Provides Approve / Reject action buttons.
 *
 * Uses TanStack Query for fetching the pending list, and mutations for
 * approve/reject. Mutation success invalidates the pending proposals query.
 *
 * Sandbox boundary: the preview renders via TemplateRenderer, which receives
 * only typed props. No eval, no fetch, no process.env, no localStorage.
 *
 * Refs: #622, epic #612.
 */

import React from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';

import {
  fetchCustomBlockProposals,
  approveCustomBlockProposal,
  rejectCustomBlockProposal,
} from '../lib/api.js';
import type { CustomBlockProposal } from '../../../shared/workbench-custom-blocks.js';
import { isKnownTemplateName } from '../../../shared/workbench-custom-blocks.js';
import { TemplateRenderer } from './blocks/custom-templates.js';

import './CustomBlockProposalPreview.css';
import './blocks/custom-templates.css';

// ---------------------------------------------------------------------------
// Capability descriptions (human-readable disclosures)
// ---------------------------------------------------------------------------

const CAPABILITY_DESCRIPTIONS: Record<string, string> = {
  'session:read': 'read session list and metadata',
  'session:create:terminal': 'create new terminal sessions',
  'session:create:agent': 'create new agent sessions',
  'session:attach': 'attach to existing sessions',
  'session:control:kill': 'terminate sessions',
  'tab:mode:set-agent': 'switch tabs to agent-driven mode',
  'tab:intervention:read': 'read human interventions on agent tabs',
  'rpc:fs:list': 'list files and directories',
  'rpc:fs:read': 'read file contents',
  'rpc:fs:tail': 'tail file contents in real-time',
  'rpc:fs:write': 'write file contents',
  'rpc:fs:delete': 'delete files',
  'rpc:git:read': 'read git state (branches, commits, status)',
  'rpc:git:write': 'write git state (commit, branch, push)',
  'pty:exec:arbitrary': 'execute arbitrary shell commands',
  'preview:port-forward': 'forward ports for preview',
  'logs:read': 'read system logs',
};

function capabilityDescription(bit: string): string {
  return CAPABILITY_DESCRIPTIONS[bit] ?? bit;
}

// ---------------------------------------------------------------------------
// SingleProposalPreview — renders one proposal with preview + actions
// ---------------------------------------------------------------------------

interface SingleProposalPreviewProps {
  proposal: CustomBlockProposal;
  onApproved: () => void;
  onRejected: () => void;
}

function SingleProposalPreview({
  proposal,
  onApproved,
  onRejected,
}: SingleProposalPreviewProps) {
  const [actionError, setActionError] = React.useState<string | null>(null);

  const approveMutation = useMutation({
    mutationFn: () => approveCustomBlockProposal(proposal.proposalId),
    onSuccess: onApproved,
    onError: (err: Error) => setActionError(err.message),
  });

  const rejectMutation = useMutation({
    mutationFn: () => rejectCustomBlockProposal(proposal.proposalId),
    onSuccess: onRejected,
    onError: (err: Error) => setActionError(err.message),
  });

  const isPending = approveMutation.isPending || rejectMutation.isPending;
  const { descriptor, rendererSource, proposedBy } = proposal;
  const caps = descriptor.capabilityRequirements ?? [];

  // Build a no-op sandboxed context and api for the preview render.
  // The preview uses the same execution path as a live approved block
  // (TemplateRenderer), ensuring what the user sees is exactly what will run.
  const previewContext = {
    capabilityGrants: caps,
  };
  const previewApi = {
    getWorkContextStatus: (_id: string): string | null => null,
    listGrantedCapabilities: () => [...caps],
  };

  const canRenderPreview =
    rendererSource.kind === 'template' &&
    isKnownTemplateName(rendererSource.template);

  return (
    <div className="proposal-preview">
      {/* --- header --- */}
      <div className="proposal-preview__section-label">
        proposed block: {descriptor.title}
      </div>

      {/* --- sandboxed preview --- */}
      <div>
        <div className="proposal-preview__section-label">preview</div>
        <div className="proposal-preview__frame">
          {canRenderPreview && rendererSource.kind === 'template' ? (
            <TemplateRenderer
              descriptor={descriptor}
              context={previewContext}
              api={previewApi}
              template={rendererSource.template}
              props={rendererSource.props as Record<string, unknown>}
            />
          ) : (
            <span style={{ color: 'var(--text-muted)', fontStyle: 'italic' }}>
              preview unavailable (source kind: {rendererSource.kind})
            </span>
          )}
        </div>
      </div>

      {/* --- capability disclosure --- */}
      <div>
        <div className="proposal-preview__section-label">
          capability requirements
        </div>
        <div className="proposal-preview__capabilities">
          {caps.length === 0 ? (
            <div className="proposal-preview__no-caps">
              no capabilities required
            </div>
          ) : (
            caps.map((bit) => (
              <div key={bit} className="proposal-preview__cap-item">
                <span className="proposal-preview__cap-bit">{bit}</span>
                <span className="proposal-preview__cap-desc">
                  {capabilityDescription(bit)}
                </span>
              </div>
            ))
          )}
        </div>
      </div>

      {/* --- proposed by --- */}
      <div className="proposal-preview__actor">
        proposed by{' '}
        <span className="proposal-preview__actor-name">
          {proposedBy.displayName ?? proposedBy.id}
        </span>{' '}
        at {proposal.proposedAt}
      </div>

      {/* --- actions --- */}
      <div className="proposal-preview__actions">
        <button
          type="button"
          className="proposal-preview__btn proposal-preview__btn--approve"
          onClick={() => {
            setActionError(null);
            approveMutation.mutate();
          }}
          disabled={isPending}
          aria-label="approve custom block proposal"
        >
          {approveMutation.isPending ? 'approving...' : 'approve'}
        </button>
        <button
          type="button"
          className="proposal-preview__btn proposal-preview__btn--reject"
          onClick={() => {
            setActionError(null);
            rejectMutation.mutate();
          }}
          disabled={isPending}
          aria-label="reject custom block proposal"
        >
          {rejectMutation.isPending ? 'rejecting...' : 'reject'}
        </button>
        {actionError && (
          <span className="proposal-preview__error">{actionError}</span>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// CustomBlockProposalList — fetches and renders pending proposals
// ---------------------------------------------------------------------------

const PENDING_PROPOSALS_QUERY_KEY = [
  'custom-block-proposals',
  'pending',
] as const;

/**
 * Renders the list of pending custom block proposals.
 * Each proposal shows a preview + capability disclosure + approve/reject buttons.
 *
 * Consumers mount this wherever the user should review pending proposals.
 * After approve or reject, the proposal list is re-fetched automatically.
 */
export function CustomBlockProposalList() {
  const queryClient = useQueryClient();

  const { data, isLoading, error } = useQuery({
    queryKey: PENDING_PROPOSALS_QUERY_KEY,
    queryFn: () => fetchCustomBlockProposals('pending'),
  });

  function handleDecision() {
    void queryClient.invalidateQueries({
      queryKey: PENDING_PROPOSALS_QUERY_KEY,
    });
  }

  if (isLoading) {
    return (
      <div className="proposal-preview-list__loading">
        loading pending proposals...
      </div>
    );
  }

  if (error) {
    return (
      <div className="proposal-preview-list__error">
        failed to load proposals: {(error as Error).message}
      </div>
    );
  }

  if (!data || data.length === 0) {
    return (
      <div className="proposal-preview-list__empty">
        no pending custom block proposals
      </div>
    );
  }

  return (
    <div className="proposal-preview-list">
      {data.map((proposal: CustomBlockProposal) => (
        <div key={proposal.proposalId} className="proposal-preview-list__item">
          <div className="proposal-preview-list__item-header">
            <span className="proposal-preview-list__item-title">
              {proposal.descriptor.title}
            </span>
            <span className="proposal-preview-list__item-id">
              {proposal.proposalId}
            </span>
          </div>
          <SingleProposalPreview
            proposal={proposal}
            onApproved={handleDecision}
            onRejected={handleDecision}
          />
        </div>
      ))}
    </div>
  );
}

export default CustomBlockProposalList;
