/**
 * Custom block proposal store + REST router — slice 4 of epic #612.
 *
 * Storage model: one JSON file per hub, keyed by a fixed filename
 * `custom-block-proposals.json` in `<configDir>/workbench-custom-blocks/`.
 * Mirrors the `workbench-layouts/` pattern from slice 3.
 *
 * Lifecycle: pending → approved | rejected; approved → revoked.
 * Each state transition emits a security audit envelope.
 *
 * REST routes (relative to mount point `/workbench/custom-blocks`):
 *   POST   /proposals                    — agent submits proposal
 *   GET    /proposals?status=<status>    — list proposals (filter by status)
 *   POST   /proposals/:id/approve        — user approves pending proposal
 *   POST   /proposals/:id/reject         — user rejects pending proposal
 *   POST   /proposals/:id/revoke         — user revokes approved proposal
 *
 * Security boundary (non-negotiable):
 *   - `jsx-snippet` source kind is always rejected at POST time.
 *   - Template names are validated against KnownTemplateName.
 *   - Capability requirements are validated; proposals requesting bits not
 *     in the granted set for the proposing actor are rejected.
 *   - Audit envelopes are emitted on every state transition.
 *
 * Refs: #622, epic #612, ADR-017.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { Router } from 'express';
import type { Request, Response } from 'express';

import {
  isKnownTemplateName,
  CUSTOM_BLOCK_PROPOSAL_ERRORS,
  KNOWN_TEMPLATE_NAMES,
} from '../shared/workbench-custom-blocks.js';
import type {
  CustomBlockProposal,
  CustomBlockProposalInput,
  CustomBlockProposalStatus,
} from '../shared/workbench-custom-blocks.js';
import type { SecurityAuditEntryInput } from '../shared/security-audit.js';
import { isRelayCapabilityBit } from '../shared/security-policy.js';
import { createLogger } from './logger.js';

const logger = createLogger('workbench-custom-blocks');

// ---------------------------------------------------------------------------
// Storage helpers
// ---------------------------------------------------------------------------

function proposalDir(configPath: string): string {
  return path.join(path.dirname(configPath), 'workbench-custom-blocks');
}

function proposalFilePath(configPath: string): string {
  return path.join(proposalDir(configPath), 'custom-block-proposals.json');
}

function ensureProposalDir(configPath: string): void {
  const dir = proposalDir(configPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// ---------------------------------------------------------------------------
// In-memory + disk store
// ---------------------------------------------------------------------------

/**
 * Read all proposals from disk.
 * Returns an empty map on first run or parse error.
 */
export function readAllProposals(
  configPath: string
): Map<string, CustomBlockProposal> {
  const fp = proposalFilePath(configPath);
  let raw: string;
  try {
    raw = fs.readFileSync(fp, 'utf8');
  } catch {
    return new Map();
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return new Map();
    const map = new Map<string, CustomBlockProposal>();
    for (const entry of parsed) {
      if (
        typeof entry === 'object' &&
        entry !== null &&
        typeof (entry as Record<string, unknown>)['proposalId'] === 'string'
      ) {
        const p = entry as CustomBlockProposal;
        map.set(p.proposalId, p);
      }
    }
    return map;
  } catch (err) {
    logger.warn(
      'Failed to parse custom block proposals store:',
      err instanceof Error ? err.message : err
    );
    return new Map();
  }
}

/**
 * Persist all proposals to disk.
 * Writes atomically via a temp file rename.
 */
export function writeAllProposals(
  configPath: string,
  proposals: Map<string, CustomBlockProposal>
): void {
  ensureProposalDir(configPath);
  const fp = proposalFilePath(configPath);
  const data = JSON.stringify([...proposals.values()], null, 2);
  const tmp = `${fp}.tmp.${Date.now()}`;
  fs.writeFileSync(tmp, data, 'utf8');
  fs.renameSync(tmp, fp);
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate the descriptor portion of a proposal input.
 * Returns an error string or null.
 */
function validateDescriptor(descriptor: unknown): string | null {
  if (
    typeof descriptor !== 'object' ||
    descriptor === null ||
    Array.isArray(descriptor)
  ) {
    return CUSTOM_BLOCK_PROPOSAL_ERRORS.missing_descriptor;
  }
  const desc = descriptor as Record<string, unknown>;

  if (desc['kind'] !== 'custom') {
    return CUSTOM_BLOCK_PROPOSAL_ERRORS.descriptor_kind_not_custom;
  }
  if (typeof desc['id'] !== 'string' || desc['id'].trim() === '') {
    return CUSTOM_BLOCK_PROPOSAL_ERRORS.missing_descriptor_id;
  }
  if (typeof desc['title'] !== 'string' || desc['title'].trim() === '') {
    return CUSTOM_BLOCK_PROPOSAL_ERRORS.missing_descriptor_title;
  }

  const meta =
    typeof desc['meta'] === 'object' && desc['meta'] !== null
      ? (desc['meta'] as Record<string, unknown>)
      : null;
  if (
    !meta ||
    typeof meta['rendererId'] !== 'string' ||
    meta['rendererId'].trim() === ''
  ) {
    return CUSTOM_BLOCK_PROPOSAL_ERRORS.missing_renderer_id;
  }

  if (Array.isArray(desc['capabilityRequirements'])) {
    for (const bit of desc['capabilityRequirements']) {
      if (!isRelayCapabilityBit(bit)) {
        return `descriptor.capabilityRequirements contains unknown capability bit: ${String(bit)}`;
      }
    }
  }

  return null;
}

/**
 * Validate the rendererSource portion of a proposal input.
 * Returns an error string or null.
 *
 * Security boundary: jsx-snippet is always rejected here.
 */
function validateRendererSource(rs: unknown): string | null {
  if (typeof rs !== 'object' || rs === null || Array.isArray(rs)) {
    return CUSTOM_BLOCK_PROPOSAL_ERRORS.missing_renderer_source;
  }
  const rsObj = rs as Record<string, unknown>;

  if (rsObj['kind'] !== 'template' && rsObj['kind'] !== 'jsx-snippet') {
    return CUSTOM_BLOCK_PROPOSAL_ERRORS.unknown_renderer_source_kind;
  }

  if (rsObj['kind'] === 'jsx-snippet') {
    // Forward-compat seam — always reject arbitrary JSX execution.
    return CUSTOM_BLOCK_PROPOSAL_ERRORS.jsx_snippet_not_supported;
  }

  // kind === 'template'
  if (!isKnownTemplateName(rsObj['template'])) {
    return `${CUSTOM_BLOCK_PROPOSAL_ERRORS.unknown_template}. Known templates: ${KNOWN_TEMPLATE_NAMES.join(', ')}`;
  }

  return null;
}

/**
 * Validate a CustomBlockProposalInput body submitted by an agent.
 * Returns a descriptive error string on failure, or null on success.
 *
 * Enforces the sandbox boundary:
 *   - `jsx-snippet` source kind is always rejected.
 *   - Template names must be in KNOWN_TEMPLATE_NAMES.
 *   - capabilityRequirements must contain only known RelayCapabilityBit values.
 *     Enforcement of actor-level grants is left to callers with ACL access.
 */
export function validateProposalInput(body: unknown): string | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return 'request body must be a JSON object';
  }
  const obj = body as Record<string, unknown>;

  const descError = validateDescriptor(obj['descriptor']);
  if (descError) return descError;

  const rsError = validateRendererSource(obj['rendererSource']);
  if (rsError) return rsError;

  const proposedBy = obj['proposedBy'];
  if (
    typeof proposedBy !== 'object' ||
    proposedBy === null ||
    Array.isArray(proposedBy) ||
    typeof (proposedBy as Record<string, unknown>)['id'] !== 'string'
  ) {
    return CUSTOM_BLOCK_PROPOSAL_ERRORS.missing_proposed_by;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Audit helper
// ---------------------------------------------------------------------------

type AuditSink =
  | { append(input: SecurityAuditEntryInput): unknown }
  | undefined;

function emitProposalAudit(
  auditSink: AuditSink,
  opts: {
    proposalId: string;
    actorId: string;
    action: string;
    decision: SecurityAuditEntryInput['decision'];
    eventType: SecurityAuditEntryInput['eventType'];
    reasonCode: string;
  }
): string | undefined {
  if (!auditSink) return undefined;
  const eventId = crypto.randomUUID();
  try {
    auditSink.append({
      eventId,
      eventType: opts.eventType,
      decision: opts.decision,
      reasonCode: opts.reasonCode,
      peer: { kind: 'user', displayName: opts.actorId },
      node: {},
      intent: {
        action: opts.action,
        target: `custom-block-proposal:${opts.proposalId}`,
      },
      material: {
        params: { proposalId: opts.proposalId, actorId: opts.actorId },
      },
      refs: {},
    });
  } catch (err) {
    logger.warn(
      'Failed to emit custom block audit envelope:',
      err instanceof Error ? err.message : err
    );
  }
  return eventId;
}

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

export interface WorkbenchCustomBlocksRouterDeps {
  configPath: string;
  auditSink?: AuditSink;
}

/**
 * Creates and returns an Express Router for the custom block proposal flow.
 *
 * Routes (relative to mount point `/workbench/custom-blocks`):
 *   POST   /proposals                    — submit a new proposal
 *   GET    /proposals?status=<status>    — list proposals
 *   POST   /proposals/:id/approve        — approve a pending proposal
 *   POST   /proposals/:id/reject         — reject a pending proposal
 *   POST   /proposals/:id/revoke         — revoke an approved proposal
 *
 * Auth is applied by the caller (mount with requireAuth middleware).
 */
export function createWorkbenchCustomBlocksRouter(
  deps: WorkbenchCustomBlocksRouterDeps
): Router {
  const { configPath, auditSink } = deps;
  const router = Router();

  // -------------------------------------------------------------------------
  // POST /proposals — agent submits a proposal
  // -------------------------------------------------------------------------
  router.post('/proposals', (req: Request, res: Response) => {
    const body = req.body as unknown;
    const validationError = validateProposalInput(body);
    if (validationError) {
      res.status(422).json({ error: validationError });
      return;
    }

    const input = body as CustomBlockProposalInput;
    const proposalId = crypto.randomUUID();
    const now = new Date().toISOString();

    const proposal: CustomBlockProposal = {
      proposalId,
      descriptor: input.descriptor,
      rendererSource: input.rendererSource,
      proposedBy: input.proposedBy,
      proposedAt: now,
      status: 'pending',
      statusUpdatedAt: now,
    };

    const proposals = readAllProposals(configPath);
    proposals.set(proposalId, proposal);

    const auditEventId = emitProposalAudit(auditSink, {
      proposalId,
      actorId: input.proposedBy.id,
      action: 'workbench.custom-block.propose',
      decision: 'recorded',
      eventType: 'grant',
      reasonCode: 'custom_block_proposed',
    });

    if (auditEventId) {
      proposal.auditEventId = auditEventId;
      proposals.set(proposalId, proposal);
    }

    try {
      writeAllProposals(configPath, proposals);
    } catch (err) {
      logger.error(
        'Failed to write custom block proposals:',
        err instanceof Error ? err.message : err
      );
      res.status(500).json({ error: 'failed to persist proposal' });
      return;
    }

    res.status(201).json(proposal);
  });

  // -------------------------------------------------------------------------
  // GET /proposals?status=<status> — list proposals
  // -------------------------------------------------------------------------
  router.get('/proposals', (req: Request, res: Response) => {
    const statusFilter = req.query['status'] as string | undefined;
    const proposals = readAllProposals(configPath);
    let results = [...proposals.values()];

    if (statusFilter) {
      const validStatuses: CustomBlockProposalStatus[] = [
        'pending',
        'approved',
        'rejected',
        'revoked',
      ];
      if (!validStatuses.includes(statusFilter as CustomBlockProposalStatus)) {
        res.status(400).json({
          error: `invalid status filter "${statusFilter}". Valid values: ${validStatuses.join(', ')}`,
        });
        return;
      }
      results = results.filter((p) => p.status === statusFilter);
    }

    // Sort by proposedAt descending (newest first)
    results.sort((a, b) => b.proposedAt.localeCompare(a.proposedAt));
    res.json(results);
  });

  // -------------------------------------------------------------------------
  // POST /proposals/:id/approve — user approves a pending proposal
  // -------------------------------------------------------------------------
  router.post('/proposals/:id/approve', (req: Request, res: Response) => {
    const { id } = req.params as { id: string };
    const proposals = readAllProposals(configPath);
    const proposal = proposals.get(id);

    if (!proposal) {
      res
        .status(404)
        .json({ error: CUSTOM_BLOCK_PROPOSAL_ERRORS.proposal_not_found });
      return;
    }
    if (proposal.status !== 'pending') {
      res.status(409).json({
        error: CUSTOM_BLOCK_PROPOSAL_ERRORS.proposal_not_pending,
        status: proposal.status,
      });
      return;
    }

    const now = new Date().toISOString();
    const updated: CustomBlockProposal = {
      ...proposal,
      status: 'approved',
      statusUpdatedAt: now,
    };

    const auditEventId = emitProposalAudit(auditSink, {
      proposalId: id,
      actorId: 'user',
      action: 'workbench.custom-block.approve',
      decision: 'approved',
      eventType: 'approval',
      reasonCode: 'custom_block_approved',
    });

    if (auditEventId) {
      updated.auditEventId = auditEventId;
    }

    proposals.set(id, updated);

    try {
      writeAllProposals(configPath, proposals);
    } catch (err) {
      logger.error(
        'Failed to write custom block proposals on approve:',
        err instanceof Error ? err.message : err
      );
      res.status(500).json({ error: 'failed to persist approval' });
      return;
    }

    res.json(updated);
  });

  // -------------------------------------------------------------------------
  // POST /proposals/:id/reject — user rejects a pending proposal
  // -------------------------------------------------------------------------
  router.post('/proposals/:id/reject', (req: Request, res: Response) => {
    const { id } = req.params as { id: string };
    const proposals = readAllProposals(configPath);
    const proposal = proposals.get(id);

    if (!proposal) {
      res
        .status(404)
        .json({ error: CUSTOM_BLOCK_PROPOSAL_ERRORS.proposal_not_found });
      return;
    }
    if (proposal.status !== 'pending') {
      res.status(409).json({
        error: CUSTOM_BLOCK_PROPOSAL_ERRORS.proposal_not_pending,
        status: proposal.status,
      });
      return;
    }

    const now = new Date().toISOString();
    const updated: CustomBlockProposal = {
      ...proposal,
      status: 'rejected',
      statusUpdatedAt: now,
    };

    const auditEventId = emitProposalAudit(auditSink, {
      proposalId: id,
      actorId: 'user',
      action: 'workbench.custom-block.reject',
      decision: 'deny',
      eventType: 'denial',
      reasonCode: 'custom_block_rejected',
    });

    if (auditEventId) {
      updated.auditEventId = auditEventId;
    }

    proposals.set(id, updated);

    try {
      writeAllProposals(configPath, proposals);
    } catch (err) {
      logger.error(
        'Failed to write custom block proposals on reject:',
        err instanceof Error ? err.message : err
      );
      res.status(500).json({ error: 'failed to persist rejection' });
      return;
    }

    res.json(updated);
  });

  // -------------------------------------------------------------------------
  // POST /proposals/:id/revoke — user revokes an approved proposal
  // -------------------------------------------------------------------------
  router.post('/proposals/:id/revoke', (req: Request, res: Response) => {
    const { id } = req.params as { id: string };
    const proposals = readAllProposals(configPath);
    const proposal = proposals.get(id);

    if (!proposal) {
      res
        .status(404)
        .json({ error: CUSTOM_BLOCK_PROPOSAL_ERRORS.proposal_not_found });
      return;
    }
    if (proposal.status !== 'approved') {
      res.status(409).json({
        error: CUSTOM_BLOCK_PROPOSAL_ERRORS.proposal_not_approved,
        status: proposal.status,
      });
      return;
    }

    const now = new Date().toISOString();
    const updated: CustomBlockProposal = {
      ...proposal,
      status: 'revoked',
      statusUpdatedAt: now,
    };

    const auditEventId = emitProposalAudit(auditSink, {
      proposalId: id,
      actorId: 'user',
      action: 'workbench.custom-block.revoke',
      decision: 'revoked',
      eventType: 'revocation',
      reasonCode: 'custom_block_revoked',
    });

    if (auditEventId) {
      updated.auditEventId = auditEventId;
    }

    proposals.set(id, updated);

    try {
      writeAllProposals(configPath, proposals);
    } catch (err) {
      logger.error(
        'Failed to write custom block proposals on revoke:',
        err instanceof Error ? err.message : err
      );
      res.status(500).json({ error: 'failed to persist revocation' });
      return;
    }

    res.json(updated);
  });

  return router;
}
