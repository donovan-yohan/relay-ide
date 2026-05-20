/**
 * Custom block proposal contracts — slice 4 of epic #612.
 *
 * This module defines the shared TypeScript contracts for the agent-authored
 * custom block proposal/approval flow. It also exports a small set of runtime
 * constants and predicates used by both the server and frontend:
 *   - KNOWN_TEMPLATE_NAMES, isKnownTemplateName
 *   - CUSTOM_BLOCK_PROPOSAL_ERRORS
 *
 * # Proposal lifecycle
 *
 *   pending  →  approved  →  revoked
 *          ↘
 *           rejected
 *
 * An agent submits a CustomBlockProposal via POST /workbench/custom-blocks/proposals.
 * The user reviews the proposed block in the CustomBlockProposalPreview UI, then
 * either approves or rejects it. An approved proposal becomes addressable as a
 * real custom block (its proposalId becomes the descriptor's rendererId). A
 * previously-approved proposal can be revoked (e.g. on capability concerns).
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
 * Template renderers receive ONLY:
 *   - `descriptor` — the CustomBlockDescriptor for this block
 *   - `context.workContextId` and `context.workContextStatus` — id + status only,
 *     never full transcripts, never raw session bytes
 *   - `context.capabilityGrants` — list of granted bit names (strings), read-only
 *   - `api` — a whitelisted, typed side-effect API (see TemplateRendererApi)
 *
 * Template renderers CANNOT access:
 *   - `process.env` or any Node.js globals
 *   - `window.fetch` / `fetch` (network calls)
 *   - `localStorage` / `sessionStorage`
 *   - Raw session transcripts or terminal output
 *   - Secrets, credentials, or ungranted node/file operations
 *
 * The api object is the ONLY channel for side effects. It is passed as a
 * typed parameter — renderers cannot import modules.
 *
 * Refs: #622, epic #612 (workbench blocks), ADR-017 (brain-as-peer).
 */

import type { RelayCapabilityBit } from './security-policy.js';
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
 * Extensibility: new templates are added here and registered in
 * `frontend/src/workbench/blocks/custom-templates.tsx`. No agent-side changes
 * are needed — agents discover available templates at runtime.
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
// Template prop schemas
// ---------------------------------------------------------------------------

/**
 * Props schema for the `status-card` template.
 *
 * Renders a card with a title, a coloured status badge, and an optional
 * description paragraph.
 */
export interface StatusCardProps {
  title: string;
  status: 'active' | 'idle' | 'error' | 'done' | 'pending';
  description?: string | undefined;
}

/**
 * Props schema for the `kv-grid` template.
 *
 * Renders a two-column table of key/value pairs. Values are plain strings;
 * the renderer does NOT eval them or treat them as markup.
 */
export interface KvGridProps {
  rows: Array<{ key: string; value: string }>;
  heading?: string | undefined;
}

/**
 * Props schema for the `link-list` template.
 *
 * Renders an ordered list of labelled links. URLs must be absolute HTTPS
 * links or relative paths — the renderer validates this at render time.
 */
export interface LinkListProps {
  links: Array<{ label: string; url: string }>;
  heading?: string | undefined;
}

/**
 * Union of all known template prop shapes, keyed by template name.
 * Used for type-safe prop validation in the server proposal handler.
 */
export type TemplatePropsMap = {
  'status-card': StatusCardProps;
  'kv-grid': KvGridProps;
  'link-list': LinkListProps;
};

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
// Sandbox API surface (whitelisted side-effect channel for template renderers)
// ---------------------------------------------------------------------------

/**
 * The ONLY side-effect API available to template renderers.
 *
 * Renderers are pure functions of (descriptor, context, api). They cannot
 * import modules, access global objects, or call unlisted APIs.
 *
 * The api object is constructed by the BlockHost and passed as a parameter.
 * Any attempt to access `process`, `fetch`, `localStorage`, etc. from inside
 * a renderer is blocked because renderers are typed functions that only
 * receive this typed object — they do not have import access.
 *
 * ALLOWED:
 *   - getWorkContextStatus(workContextId) — returns the status string only
 *   - listGrantedCapabilities() — returns the list of granted capability bit names
 *
 * NOT ALLOWED (and not present on this type):
 *   - fetch / XMLHttpRequest / network access
 *   - process.env / Node globals
 *   - localStorage / sessionStorage
 *   - readFile / writeFile / exec
 *   - raw session transcripts or terminal bytes
 */
export interface TemplateRendererApi {
  /**
   * Returns the status string of the given work context, or null if unknown.
   * The resolver is injected by the host from its own (validated) state.
   * Only `id` and `status` are exposed — never full transcripts.
   */
  getWorkContextStatus(workContextId: string): string | null;

  /**
   * Returns the list of granted RelayCapabilityBit names for this block.
   * Read-only; cannot be used to request new capabilities.
   */
  listGrantedCapabilities(): RelayCapabilityBit[];
}

/**
 * Sandboxed context passed to template renderers.
 *
 * Exposes only the minimum information needed for rendering — no raw
 * transcripts, no secrets, no ungranted capability data.
 */
export interface TemplateRendererContext {
  /** Opaque work context id — never the full WorkContext object. */
  workContextId?: string | undefined;
  /** Status string from the work context, if known. */
  workContextStatus?: string | undefined;
  /** Granted capability bit names for this block. */
  capabilityGrants: readonly RelayCapabilityBit[];
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

export type CustomBlockProposalErrorCode =
  keyof typeof CUSTOM_BLOCK_PROPOSAL_ERRORS;
