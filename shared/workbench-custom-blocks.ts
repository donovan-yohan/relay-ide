/**
 * Custom block proposal contracts — slice 4 of epic #612.
 *
 * This module defines the shared TypeScript contracts for the agent-authored
 * custom block proposal/approval flow. It also exports a small set of runtime
 * constants and predicates used by both the server and frontend:
 *   - KNOWN_TEMPLATE_NAMES, isKnownTemplateName
 *   - CUSTOM_BLOCK_PROPOSAL_ERRORS
 *
 * # Retained-without-a-consumer (epic #1287 slice 0)
 *
 * The whole proposal stack below the UI is INTENTIONALLY retained even though
 * nothing renders it today. Slice 0 deleted only `frontend/src/workbench/`
 * (the pre-channel block canvas); the server halves stay by design:
 *   - `server/workbench-custom-blocks.ts` + `server/workbench-prompt-hooks.ts`
 *     (routes `/workbench/custom-blocks` + `/workbench/propose-block`)
 *   - the `frontend/src/lib/api.ts` client functions
 *     (`fetchCustomBlockProposals`, `fetchCustomBlockProposalById`,
 *     `approveCustomBlockProposal`, `rejectCustomBlockProposal`,
 *     `revokeCustomBlockProposal`) — zero `.tsx` callers as of slice 0, pinned
 *     in place by `test/workbench-custom-blocks.test.ts` section 5.
 * A channel-era renderer is expected to bind against this same contract. Do
 * not re-discover this as dead code in the next hygiene pass: it is a scope
 * boundary, not an oversight.
 *
 * # Proposal lifecycle
 *
 *   pending  →  approved  →  revoked
 *          ↘
 *           rejected
 *
 * An agent submits a CustomBlockProposal via POST /workbench/custom-blocks/proposals.
 * The user then either approves or rejects it. An approved proposal becomes
 * addressable as a real custom block (its proposalId becomes the descriptor's
 * rendererId). A previously-approved proposal can be revoked (e.g. on
 * capability concerns). The review UI that used to drive that decision
 * (`CustomBlockProposalPreview`) was deleted with the pre-channel block canvas
 * in epic #1287 slice 0; the lifecycle and its REST surface are unchanged and
 * currently have no UI consumer (see "Extensibility" below).
 *
 * # Renderer source kinds
 *
 * Two source kinds are defined for forward-compatibility:
 *
 * - `template` (ACTIVE): the agent fills in props on a pre-vetted React
 *   component. Templates are registered in the host and the agent cannot
 *   introduce arbitrary code. This is the only source kind with real execution.
 *
 * - `jsx-snippet` (NO-OP / forward-compat seam): defined in the type system
 *   for future use, but proposals with this source kind are ALWAYS REJECTED at
 *   registration time in this PR. Arbitrary JSX sandboxing is out of scope.
 *   See `CUSTOM_BLOCK_PROPOSAL_ERRORS.jsx_snippet_not_supported`.
 *
 * # Sandbox boundary (non-negotiable)
 *
 * A template renderer must receive ONLY its `CustomBlockDescriptor`, the work
 * context id + status (never transcripts or raw session bytes), the granted
 * capability bit names, and a whitelisted typed side-effect API — never
 * `process.env`, `fetch`, storage, transcripts, secrets, or ungranted
 * node/file operations. The renderer host that carried those typed shapes was
 * the pre-channel `BlockHost`, deleted in epic #1287 slice 0; a channel-era
 * host must re-declare them under the same boundary.
 *
 * Refs: #622, epic #612 (workbench blocks), ADR-017 (brain-as-peer).
 */

import type {
  ActorRef,
  CustomBlockDescriptor,
  JsonValue,
} from './workbench-block-types.js';

// ---------------------------------------------------------------------------
// Known template names
// ---------------------------------------------------------------------------

/**
 * Pre-vetted templates available for agent use.
 *
 * Templates are pure React components registered in the host. The agent
 * cannot introduce custom code — only props within each template's schema.
 *
 * Starter set (this PR):
 *   - `status-card` — a card showing a title, status badge, and optional
 *     description. Suitable for work-context summaries, pipeline state, etc.
 *   - `kv-grid` — a two-column key/value grid. Suitable for metadata tables,
 *     environment summaries, structured output.
 *   - `link-list` — an ordered list of labelled links (title + url pairs).
 *     Suitable for artifact indexes, reference collections.
 *
 * Extensibility: new templates are added here. The renderer that used to
 * register them (`frontend/src/workbench/blocks/custom-templates.tsx`) was
 * deleted with the pre-channel block canvas in epic #1287 slice 0, so this
 * name set and the proposal REST surface currently have no UI consumer; a
 * channel-era renderer would register against the same names. No agent-side
 * changes are needed either way — agents discover templates at runtime.
 */
export type KnownTemplateName = 'status-card' | 'kv-grid' | 'link-list';

export const KNOWN_TEMPLATE_NAMES: readonly KnownTemplateName[] = [
  'status-card',
  'kv-grid',
  'link-list',
];

export function isKnownTemplateName(
  value: unknown
): value is KnownTemplateName {
  return (
    typeof value === 'string' &&
    (KNOWN_TEMPLATE_NAMES as readonly string[]).includes(value)
  );
}

// ---------------------------------------------------------------------------
// CustomRendererSource
// ---------------------------------------------------------------------------

/**
 * Source of the renderer to use for an approved custom block.
 *
 * Two kinds are defined; only `template` has real execution in this PR.
 * `jsx-snippet` is a forward-compat seam — proposals with this kind are
 * always rejected at registration time (see validation in server module).
 */
export type CustomRendererSource =
  | {
      kind: 'template';
      /** Must be a KnownTemplateName; validated at proposal POST time. */
      template: KnownTemplateName;
      /** Props forwarded verbatim to the template component. */
      props: Record<string, JsonValue>;
    }
  | {
      /**
       * Forward-compat seam for future arbitrary-JSX sandboxing.
       *
       * NOT EXECUTED in this PR. Proposals with this source kind are always
       * rejected at POST /workbench/custom-blocks/proposals with HTTP 422.
       * The type exists so agent clients can express intent without breaking
       * the schema when sandboxed JSX execution is added in a future slice.
       */
      kind: 'jsx-snippet';
      snippet: string;
    };

// ---------------------------------------------------------------------------
// CustomBlockProposal
// ---------------------------------------------------------------------------

export type CustomBlockProposalStatus =
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'revoked';

/**
 * A proposal submitted by an agent for a custom block renderer.
 *
 * The proposal is stored server-side with a server-generated proposalId.
 * When approved, the proposalId becomes the descriptor's `rendererId`.
 */
export interface CustomBlockProposal {
  /** Server-generated stable opaque identifier. */
  proposalId: string;
  /** The descriptor shape for the block this proposal will power. */
  descriptor: CustomBlockDescriptor;
  /** The renderer source — template (active) or jsx-snippet (no-op). */
  rendererSource: CustomRendererSource;
  /** Reference to the agent actor that submitted this proposal. */
  proposedBy: ActorRef;
  /** ISO 8601 timestamp of when the proposal was submitted. */
  proposedAt: string;
  /** Current lifecycle status. */
  status: CustomBlockProposalStatus;
  /** ISO 8601 timestamp of last status change. */
  statusUpdatedAt: string;
  /** Audit event ID for the status-change event (create/approve/reject/revoke). */
  auditEventId?: string;
}

// ---------------------------------------------------------------------------
// Proposal request body (POST /workbench/custom-blocks/proposals)
// ---------------------------------------------------------------------------

/**
 * Request body shape for submitting a new proposal.
 * The server generates proposalId, proposedAt, statusUpdatedAt, and status.
 */
export interface CustomBlockProposalInput {
  descriptor: CustomBlockDescriptor;
  rendererSource: CustomRendererSource;
  proposedBy: ActorRef;
}

// ---------------------------------------------------------------------------
// Proposal validation error codes
// ---------------------------------------------------------------------------

export const CUSTOM_BLOCK_PROPOSAL_ERRORS = {
  jsx_snippet_not_supported:
    'jsx-snippet source kind is not supported in this version; use template',
  unknown_template: 'rendererSource.template is not a known template name',
  missing_descriptor: 'descriptor is required',
  missing_descriptor_id: 'descriptor.id must be a non-empty string',
  missing_descriptor_title: 'descriptor.title must be a non-empty string',
  descriptor_kind_not_custom: 'descriptor.kind must be "custom"',
  missing_renderer_id: 'descriptor.meta.rendererId must be a non-empty string',
  missing_proposed_by: 'proposedBy is required',
  capability_exceeds_grant:
    'descriptor.capabilityRequirements includes capability not granted to this actor',
  missing_renderer_source: 'rendererSource is required',
  unknown_renderer_source_kind:
    'rendererSource.kind must be "template" or "jsx-snippet"',
  proposal_not_found: 'proposal not found',
  proposal_not_pending: 'proposal is not in pending status',
  proposal_not_approved: 'proposal is not in approved status',
} as const;
