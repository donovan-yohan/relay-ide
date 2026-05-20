/**
 * Workbench prompt hooks — slice 5 of epic #612.
 *
 * Two contracts:
 *
 * a) Layout → agent context (read-only)
 *    `summarizeWorkbenchBlocks` converts the current Workbench layout into a
 *    bounded, safe context summary suitable for inclusion in an agent's system
 *    prompt or turn context. NO secrets, NO env, NO raw transcripts, NO file
 *    contents are included.
 *
 * b) Agent → block proposal API (typed)
 *    `WorkbenchBlockProposalRequest` / `WorkbenchBlockProposalResult` describe
 *    the typed propose-block API surface exposed to agents. First-party kinds
 *    auto-approve when the actor's capability grants satisfy requirements.
 *    Custom blocks route through the slice-4 approval flow.
 *
 * Size cap (documented):
 *   - WORKBENCH_CONTEXT_SUMMARY_MAX_BYTES = 4096 bytes
 *   - WORKBENCH_CONTEXT_SUMMARY_MAX_BLOCKS = 20 blocks
 *   Summaries that exceed the byte cap are truncated at the last complete block
 *   entry before the limit. Blocks beyond the block cap are omitted entirely.
 *   Both caps are enforced independently; whichever triggers first wins.
 *
 * Safety invariants:
 *   - per-block status excerpts are limited to descriptor-level metadata fields.
 *   - `markdown` blocks emit only `title`; `.meta.content` is never included.
 *   - `file` blocks emit only the `fileRef.kind` discriminant (`'file'`).
 *   - `agent` blocks emit only the `actorRef.id` and `actorRef.displayName`.
 *   - `terminal` blocks emit only the `sessionRef.sessionId`.
 *   - `custom` blocks emit only `rendererId` and `proposalId` (if present).
 *   - `work-context` blocks emit only the `workContextRef` id string.
 *   - `artifact` blocks emit only `artifactRef.kind` and `artifactRef.title`.
 *
 * Refs: #625, epic #612.
 */

import type {
  WorkbenchBlockDescriptor,
  WorkbenchBlockKind,
} from './workbench-block-types.js';
import type { WorkbenchLayout } from './workbench-layout-types.js';
import type { WorkspaceScopeRef } from './workbench-layout-types.js';
import type { RelayCapabilityBit } from './security-policy.js';

// ---------------------------------------------------------------------------
// Known block-kind guard (forward-compat helper)
// ---------------------------------------------------------------------------

const KNOWN_BLOCK_KINDS: ReadonlySet<WorkbenchBlockKind> = new Set([
  'terminal',
  'agent',
  'work-context',
  'file',
  'artifact',
  'markdown',
  'custom',
]);

function isKnownBlockKind(kind: string): kind is WorkbenchBlockKind {
  return KNOWN_BLOCK_KINDS.has(kind as WorkbenchBlockKind);
}

// ---------------------------------------------------------------------------
// Size caps (documented)
// ---------------------------------------------------------------------------

/** Maximum byte size of the serialized context summary (4 KB). */
export const WORKBENCH_CONTEXT_SUMMARY_MAX_BYTES = 4096 as const;

/** Maximum number of block entries in a summary. Blocks beyond this are omitted. */
export const WORKBENCH_CONTEXT_SUMMARY_MAX_BLOCKS = 20 as const;

// ---------------------------------------------------------------------------
// Per-kind status excerpt shapes
// ---------------------------------------------------------------------------

/**
 * Status excerpt for a `terminal` block.
 * Only the sessionId is safe to surface — never raw PTY bytes.
 */
export interface TerminalBlockExcerpt {
  kind: 'terminal';
  sessionId: string | undefined;
}

/**
 * Status excerpt for an `agent` block.
 * Only the actorRef id and displayName — never raw transcript bytes.
 */
export interface AgentBlockExcerpt {
  kind: 'agent';
  actorId: string;
  actorDisplayName?: string | undefined;
}

/**
 * Status excerpt for a `work-context` block.
 * Only the opaque workContextRef string — never full work context data.
 */
export interface WorkContextBlockExcerpt {
  kind: 'work-context';
  workContextRef: string;
}

/**
 * Status excerpt for a `file` block.
 * Only the file ref kind discriminant — never a path, never file contents.
 */
export interface FileBlockExcerpt {
  kind: 'file';
  fileRefKind: 'file';
  mode?: 'read' | 'diff' | undefined;
}

/**
 * Status excerpt for an `artifact` block.
 * Only the artifact kind and title — never the artifact content or URI.
 */
export interface ArtifactBlockExcerpt {
  kind: 'artifact';
  artifactKind: string | undefined;
  artifactTitle: string | undefined;
}

/**
 * Status excerpt for a `markdown` block.
 * Only the block title is emitted — never the raw markdown content.
 */
export interface MarkdownBlockExcerpt {
  kind: 'markdown';
}

/**
 * Status excerpt for a `custom` block.
 * Only the rendererId and proposalId metadata — never raw props or data refs.
 */
export interface CustomBlockExcerpt {
  kind: 'custom';
  rendererId: string;
  proposalId?: string | undefined;
}

/** Discriminated union of all per-kind status excerpts. */
export type WorkbenchBlockExcerpt =
  | TerminalBlockExcerpt
  | AgentBlockExcerpt
  | WorkContextBlockExcerpt
  | FileBlockExcerpt
  | ArtifactBlockExcerpt
  | MarkdownBlockExcerpt
  | CustomBlockExcerpt;

// ---------------------------------------------------------------------------
// WorkbenchBlockSummary — per-block summary entry
// ---------------------------------------------------------------------------

/**
 * A single block's summary as presented to the agent context.
 * Includes only descriptor-level metadata and the bounded per-kind excerpt.
 */
export interface WorkbenchBlockSummary {
  /** Stable block id from the descriptor. */
  id: string;
  /** Block kind — used to dispatch on excerpt shape. */
  kind: WorkbenchBlockKind;
  /** User-visible title. */
  title: string;
  /** Capability requirements the block declares. Safe to expose — no secrets. */
  capabilityRequirements: readonly RelayCapabilityBit[];
  /** Per-kind status excerpt (bounded, no secrets, no raw content). */
  excerpt: WorkbenchBlockExcerpt;
}

// ---------------------------------------------------------------------------
// WorkbenchContextSummary — the full summary handed to the agent
// ---------------------------------------------------------------------------

/**
 * The bounded context summary handed to an agent at turn start.
 *
 * Design notes:
 *   - `truncated` is true when either the byte cap or block cap triggered.
 *   - `totalBlocks` reflects the layout count before truncation.
 *   - `summaryBytes` is the byte length of the serialized `blocks` array.
 *   - The summary is safe to embed as-is in a system prompt or turn context.
 */
export interface WorkbenchContextSummary {
  /** Workspace scope owning the layout. */
  workspaceScope: WorkspaceScopeRef;
  /** Summarized blocks (capped by WORKBENCH_CONTEXT_SUMMARY_MAX_BLOCKS and byte limit). */
  blocks: readonly WorkbenchBlockSummary[];
  /** Total number of blocks in the layout before truncation. */
  totalBlocks: number;
  /** Whether truncation was applied (byte or block cap). */
  truncated: boolean;
  /** Byte length of the serialized `blocks` array (for debugging). */
  summaryBytes: number;
}

// ---------------------------------------------------------------------------
// Per-kind excerpt builders
// ---------------------------------------------------------------------------

function excerptForDescriptor(
  descriptor: WorkbenchBlockDescriptor
): WorkbenchBlockExcerpt {
  switch (descriptor.kind) {
    case 'terminal': {
      const sessionRef = descriptor.meta.sessionRef;
      return {
        kind: 'terminal',
        sessionId: sessionRef?.sessionId,
      };
    }
    case 'agent': {
      const actorRef = descriptor.meta.actorRef;
      return {
        kind: 'agent',
        actorId: actorRef.id,
        ...(actorRef.displayName
          ? { actorDisplayName: actorRef.displayName }
          : {}),
      };
    }
    case 'work-context': {
      return {
        kind: 'work-context',
        workContextRef: descriptor.meta.workContextRef,
      };
    }
    case 'file': {
      return {
        kind: 'file',
        fileRefKind: 'file',
        ...(descriptor.meta.mode ? { mode: descriptor.meta.mode } : {}),
      };
    }
    case 'artifact': {
      const artifactRef = descriptor.meta.artifactRef;
      return {
        kind: 'artifact',
        artifactKind:
          typeof artifactRef === 'object' && artifactRef !== null
            ? (artifactRef as { kind?: string }).kind
            : undefined,
        artifactTitle:
          typeof artifactRef === 'object' && artifactRef !== null
            ? (artifactRef as { title?: string }).title
            : undefined,
      };
    }
    case 'markdown': {
      // Never emit .meta.content — title only, via base descriptor field.
      return { kind: 'markdown' };
    }
    case 'custom': {
      return {
        kind: 'custom',
        rendererId: descriptor.meta.rendererId,
        // proposalId is not stored directly in the descriptor — rendererId IS
        // the proposalId once approved (per slice-4 design). Surface it here.
        proposalId: descriptor.meta.rendererId,
      };
    }
  }
}

function summarizeBlock(
  descriptor: WorkbenchBlockDescriptor
): WorkbenchBlockSummary {
  return {
    id: descriptor.id,
    kind: descriptor.kind,
    title: descriptor.title,
    capabilityRequirements: descriptor.capabilityRequirements,
    excerpt: excerptForDescriptor(descriptor),
  };
}

// ---------------------------------------------------------------------------
// summarizeWorkbenchBlocks — main public function
// ---------------------------------------------------------------------------

/**
 * Convert the current Workbench layout into a bounded, safe context summary.
 *
 * Caps applied (both independent; first-to-trigger wins):
 *   - WORKBENCH_CONTEXT_SUMMARY_MAX_BLOCKS (20) block entries max.
 *   - WORKBENCH_CONTEXT_SUMMARY_MAX_BYTES (4096) byte cap on the serialized
 *     `blocks` array — truncated at the last complete block before the limit.
 *
 * Safety guarantees:
 *   - No secrets, no env, no raw transcripts, no file contents.
 *   - Only descriptor-level metadata + bounded per-kind excerpts.
 *
 * @param layout The current workspace layout (from slice 3 persistence).
 * @returns WorkbenchContextSummary safe for inclusion in agent context.
 */
export function summarizeWorkbenchBlocks(
  layout: WorkbenchLayout
): WorkbenchContextSummary {
  const totalBlocks = layout.blocks.length;

  // Step 1: cap by block count
  const cappedByCount = layout.blocks.slice(
    0,
    WORKBENCH_CONTEXT_SUMMARY_MAX_BLOCKS
  );

  // Step 2: summarize each block. Forward-compat: skip placements whose `kind`
  // is not in the closed `WorkbenchBlockKind` union (future block kinds the
  // client doesn't yet recognize). They still round-trip in the layout via the
  // widened `WorkbenchBlockPlacementDescriptor`, but agent context only includes
  // recognized kinds for now.
  const summaries: WorkbenchBlockSummary[] = cappedByCount.flatMap(
    (placement) => {
      if (!isKnownBlockKind(placement.descriptor.kind)) return [];
      return [summarizeBlock(placement.descriptor as WorkbenchBlockDescriptor)];
    }
  );

  // Step 3: cap by byte size — serialize incrementally and stop before limit
  const finalBlocks: WorkbenchBlockSummary[] = [];
  let accumulatedJson = '[]';
  for (const summary of summaries) {
    const candidate = [...finalBlocks, summary];
    const candidateJson = JSON.stringify(candidate);
    const byteLen = Buffer.byteLength(candidateJson, 'utf8');
    if (byteLen > WORKBENCH_CONTEXT_SUMMARY_MAX_BYTES) {
      break;
    }
    finalBlocks.push(summary);
    accumulatedJson = candidateJson;
  }

  const truncated =
    finalBlocks.length < totalBlocks ||
    finalBlocks.length < cappedByCount.length;

  return {
    workspaceScope: layout.workspaceScope,
    blocks: finalBlocks,
    totalBlocks,
    truncated,
    summaryBytes: Buffer.byteLength(accumulatedJson, 'utf8'),
  };
}

// ---------------------------------------------------------------------------
// Agent → block proposal API types
// ---------------------------------------------------------------------------

/**
 * Result of a `proposeWorkbenchBlock` call.
 *
 * Status semantics:
 *   - `pending`       — proposal stored; user must approve (custom kind, or
 *                       first-party with unsatisfied capability requirements).
 *   - `auto-approved` — first-party kind with all requirements satisfied by
 *                       the actor's granted capability set.
 *   - `rejected`      — descriptor failed validation (returned synchronously).
 */
export interface WorkbenchBlockProposalResult {
  proposalId: string;
  status: 'pending' | 'auto-approved' | 'rejected';
  /** Human-readable reason for rejection (only set when status === 'rejected'). */
  rejectionReason?: string;
}

/**
 * Input to the `proposeWorkbenchBlock` REST endpoint.
 *
 * For `custom` kind: routes through slice-4's proposal flow (POST to
 * `/workbench/custom-blocks/proposals`). Status always `pending`.
 *
 * For first-party kinds: auto-approved if all `capabilityRequirements` in the
 * descriptor are satisfied by `actorGrantedBits`. Otherwise `pending`.
 */
export interface WorkbenchBlockProposalRequest {
  /** The block descriptor the agent wants to create. */
  descriptor: WorkbenchBlockDescriptor;
  /** The actor id making the request. */
  actorId: string;
  /** Optional display name for the actor. */
  actorDisplayName?: string;
  /**
   * The capability bits currently granted to this actor.
   * Used to decide auto-approve vs. pending for first-party kinds.
   */
  actorGrantedBits: readonly RelayCapabilityBit[];
  /** Workspace scope to place the block in (optional). */
  workspaceScopeId?: string;
}

// ---------------------------------------------------------------------------
// proposeWorkbenchBlock — pure business logic (no I/O)
// ---------------------------------------------------------------------------

/**
 * Pure validation and approval-decision logic for a block proposal.
 *
 * Does NOT perform I/O. The caller (server router) is responsible for:
 *   - Persisting the result (via the custom-blocks store or a first-party store)
 *   - Emitting audit envelopes
 *
 * Auto-approval rules for first-party kinds:
 *   - All `descriptor.capabilityRequirements` must be present in
 *     `request.actorGrantedBits`.
 *   - If all requirements are satisfied → `auto-approved`.
 *   - If any requirement is missing → `pending` (queued for user approval).
 *
 * Custom kind:
 *   - Always → `pending` (routes to slice-4 approval flow).
 *
 * @param request The proposal request from the agent.
 * @returns WorkbenchBlockProposalResult with proposalId and status.
 */
export function evaluateBlockProposal(
  request: WorkbenchBlockProposalRequest,
  generateId: () => string
): WorkbenchBlockProposalResult {
  const { descriptor, actorGrantedBits } = request;

  // Validate required descriptor fields
  if (!descriptor.id || !descriptor.title || !descriptor.kind) {
    return {
      proposalId: generateId(),
      status: 'rejected',
      rejectionReason: 'descriptor must have id, title, and kind',
    };
  }

  // Custom kind always routes to slice-4 approval flow
  if (descriptor.kind === 'custom') {
    return {
      proposalId: generateId(),
      status: 'pending',
    };
  }

  // First-party kind: check capability grants
  const grantedSet = new Set<string>(actorGrantedBits);
  const unsatisfied = descriptor.capabilityRequirements.filter(
    (bit) => !grantedSet.has(bit)
  );

  if (unsatisfied.length > 0) {
    // Some requirements not met — queue for user approval
    return {
      proposalId: generateId(),
      status: 'pending',
    };
  }

  // All requirements satisfied — auto-approve
  return {
    proposalId: generateId(),
    status: 'auto-approved',
  };
}

// ---------------------------------------------------------------------------
// Serialized proposal record (for first-party kinds)
// ---------------------------------------------------------------------------

export type FirstPartyBlockProposalStatus =
  | 'pending'
  | 'auto-approved'
  | 'rejected';

/**
 * Persisted proposal record for first-party block kinds.
 * Custom blocks use the slice-4 CustomBlockProposal shape.
 */
export interface FirstPartyBlockProposal {
  proposalId: string;
  descriptor: WorkbenchBlockDescriptor;
  actorId: string;
  actorDisplayName?: string;
  workspaceScopeId?: string;
  proposedAt: string;
  status: FirstPartyBlockProposalStatus;
  statusUpdatedAt: string;
  /** Audit event ID for the status-change event. */
  auditEventId?: string;
}
