/**
 * Workbench prompt hooks server module — slice 5 of epic #612.
 *
 * Provides two surfaces:
 *
 * a) Layout → agent context (read-only)
 *    Wires the shared `summarizeWorkbenchBlocks` summarizer to the layout store
 *    so callers can call `getWorkbenchContextSummary(workspaceId)` without
 *    directly importing both modules.
 *
 * b) Agent → block proposal API
 *    REST router at `/workbench/propose-block`:
 *      POST /workbench/propose-block — agent submits a block descriptor.
 *        - `custom` kind → delegates to POST /workbench/custom-blocks/proposals
 *          and returns the proposal id + `pending` status.
 *        - First-party kinds → evaluates capability grants:
 *            * All requirements satisfied → `auto-approved`, stores in first-party
 *              proposal store.
 *            * Requirements unsatisfied → `pending`, stores in first-party store
 *              for user review.
 *        - Malformed descriptor → `rejected` at validation, HTTP 422.
 *
 *    GET /workbench/propose-block/proposals — list first-party proposals.
 *    POST /workbench/propose-block/proposals/:id/approve — user approves pending.
 *    POST /workbench/propose-block/proposals/:id/reject  — user rejects pending.
 *
 * Audit envelopes are emitted on:
 *   - proposal create (any status, including auto-approved)
 *   - auto-approve decision
 *   - user approve / reject
 *
 * Storage: first-party proposals are stored as a JSON file at
 * `<configDir>/workbench-prompt-hooks/first-party-proposals.json`.
 * Custom proposals are delegated to the existing slice-4 store.
 *
 * Refs: #625, epic #612.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { Router } from 'express';
import type { Request, Response } from 'express';

import {
  summarizeWorkbenchBlocks,
  evaluateBlockProposal,
} from '../shared/workbench-prompt-hooks.js';
import type {
  WorkbenchContextSummary,
  WorkbenchBlockProposalRequest,
  WorkbenchBlockProposalResult,
  FirstPartyBlockProposal,
} from '../shared/workbench-prompt-hooks.js';
import type { WorkbenchLayout } from '../shared/workbench-layout-types.js';
import { readWorkbenchLayout } from './workbench-layout.js';
import {
  readAllProposals as readCustomProposals,
  writeAllProposals as writeCustomProposals,
  validateProposalInput as validateCustomProposalInput,
} from './workbench-custom-blocks.js';
import type { SecurityAuditEntryInput } from '../shared/security-audit.js';
import { isRelayCapabilityBit } from '../shared/security-policy.js';
import type { WorkbenchBlockDescriptor } from '../shared/workbench-block-types.js';
import type { ActorRef } from '../shared/workbench-block-types.js';
import { createLogger } from './logger.js';

export type { WorkbenchContextSummary } from '../shared/workbench-prompt-hooks.js';

const logger = createLogger('workbench-prompt-hooks');

// ---------------------------------------------------------------------------
// Context summary helper (wires layout store + summarizer)
// ---------------------------------------------------------------------------

/**
 * Load the persisted layout for a workspace and produce a bounded context
 * summary safe for inclusion in an agent's turn context or system prompt.
 *
 * Returns `null` if no layout is stored yet for the workspace.
 */
export function getWorkbenchContextSummary(
  configPath: string,
  workspaceId: string
): WorkbenchContextSummary | null {
  const layout: WorkbenchLayout | null = readWorkbenchLayout(
    configPath,
    workspaceId
  );
  if (layout === null) return null;
  return summarizeWorkbenchBlocks(layout);
}

// ---------------------------------------------------------------------------
// Status constants
// ---------------------------------------------------------------------------

const STATUS_AUTO_APPROVED = 'auto-approved' as const;
const STATUS_PENDING = 'pending' as const;
const STATUS_REJECTED = 'rejected' as const;

// ---------------------------------------------------------------------------
// First-party proposal storage
// ---------------------------------------------------------------------------

function proposalDir(configPath: string): string {
  return path.join(path.dirname(configPath), 'workbench-prompt-hooks');
}

function proposalFilePath(configPath: string): string {
  return path.join(proposalDir(configPath), 'first-party-proposals.json');
}

function ensureProposalDir(configPath: string): void {
  const dir = proposalDir(configPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * Read all first-party proposals from disk.
 * Returns an empty map on first run or parse error.
 */
export function readFirstPartyProposals(
  configPath: string
): Map<string, FirstPartyBlockProposal> {
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
    const map = new Map<string, FirstPartyBlockProposal>();
    for (const entry of parsed) {
      if (
        typeof entry === 'object' &&
        entry !== null &&
        typeof (entry as Record<string, unknown>)['proposalId'] === 'string'
      ) {
        const p = entry as FirstPartyBlockProposal;
        map.set(p.proposalId, p);
      }
    }
    return map;
  } catch (err) {
    logger.warn(
      'Failed to parse first-party proposals store:',
      err instanceof Error ? err.message : err
    );
    return new Map();
  }
}

/**
 * Persist all first-party proposals to disk.
 * Writes atomically via a temp file rename.
 */
export function writeFirstPartyProposals(
  configPath: string,
  proposals: Map<string, FirstPartyBlockProposal>
): void {
  ensureProposalDir(configPath);
  const fp = proposalFilePath(configPath);
  const data = JSON.stringify([...proposals.values()], null, 2);
  const tmp = `${fp}.tmp.${Date.now()}`;
  fs.writeFileSync(tmp, data, 'utf8');
  fs.renameSync(tmp, fp);
}

// ---------------------------------------------------------------------------
// Descriptor validation (first-party kinds)
// ---------------------------------------------------------------------------

const FIRST_PARTY_KINDS = new Set([
  'terminal',
  'agent',
  'work-context',
  'file',
  'artifact',
  'markdown',
]);

/**
 * Validate a first-party block descriptor.
 * Returns an error string or null.
 */
function validateFirstPartyDescriptor(descriptor: unknown): string | null {
  if (
    typeof descriptor !== 'object' ||
    descriptor === null ||
    Array.isArray(descriptor)
  ) {
    return 'descriptor must be a JSON object';
  }
  const desc = descriptor as Record<string, unknown>;

  if (
    typeof desc['kind'] !== 'string' ||
    !FIRST_PARTY_KINDS.has(desc['kind'])
  ) {
    return `descriptor.kind must be one of: ${[...FIRST_PARTY_KINDS].join(', ')}`;
  }
  if (typeof desc['id'] !== 'string' || desc['id'].trim() === '') {
    return 'descriptor.id must be a non-empty string';
  }
  if (typeof desc['title'] !== 'string' || desc['title'].trim() === '') {
    return 'descriptor.title must be a non-empty string';
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
 * Validate the top-level request body for POST /propose-block.
 * Returns an error string or null.
 */
function validateProposeBlockBody(body: unknown): string | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return 'request body must be a JSON object';
  }
  const obj = body as Record<string, unknown>;

  if (typeof obj['actorId'] !== 'string' || obj['actorId'].trim() === '') {
    return 'actorId must be a non-empty string';
  }

  if (!Array.isArray(obj['actorGrantedBits'])) {
    return 'actorGrantedBits must be an array';
  }
  for (const bit of obj['actorGrantedBits'] as unknown[]) {
    if (!isRelayCapabilityBit(bit)) {
      return `actorGrantedBits contains unknown capability bit: ${String(bit)}`;
    }
  }

  const descriptor = obj['descriptor'];
  if (
    typeof descriptor !== 'object' ||
    descriptor === null ||
    Array.isArray(descriptor)
  ) {
    return 'descriptor must be a JSON object';
  }
  const desc = descriptor as Record<string, unknown>;
  if (typeof desc['kind'] !== 'string') {
    return 'descriptor.kind must be a string';
  }

  return null;
}

// ---------------------------------------------------------------------------
// Audit helper
// ---------------------------------------------------------------------------

type AuditSink =
  | { append(input: SecurityAuditEntryInput): unknown }
  | undefined;

function emitProposeAudit(
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
        target: `workbench-block-proposal:${opts.proposalId}`,
      },
      material: {
        params: { proposalId: opts.proposalId, actorId: opts.actorId },
      },
      refs: {},
    });
  } catch (err) {
    logger.warn(
      'Failed to emit propose-block audit envelope:',
      err instanceof Error ? err.message : err
    );
  }
  return eventId;
}

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

export interface WorkbenchProposeBlockRouterDeps {
  configPath: string;
  auditSink?: AuditSink;
}

/**
 * Creates the Express Router for the propose-block API.
 *
 * Routes (relative to mount point `/workbench`):
 *   POST /propose-block                          — agent proposes a block
 *   GET  /propose-block/proposals               — list first-party proposals
 *   POST /propose-block/proposals/:id/approve   — user approves pending
 *   POST /propose-block/proposals/:id/reject    — user rejects pending
 *
 * Custom-kind proposals are delegated to the slice-4 router at
 * `/workbench/custom-blocks/proposals` — the response from that endpoint
 * is proxied back with the proposalId and status.
 *
 * Auth is applied by the caller (mount with requireAuth middleware).
 */
export function createWorkbenchProposeBlockRouter(
  deps: WorkbenchProposeBlockRouterDeps
): Router {
  const { configPath, auditSink } = deps;
  const router = Router();

  // -------------------------------------------------------------------------
  // POST /propose-block — agent proposes a block descriptor
  // -------------------------------------------------------------------------
  router.post('/propose-block', (req: Request, res: Response) => {
    const body = req.body as unknown;

    // Top-level validation
    const topError = validateProposeBlockBody(body);
    if (topError) {
      res.status(422).json({ error: topError });
      return;
    }

    const obj = body as Record<string, unknown>;
    const descriptor = obj['descriptor'] as Record<string, unknown>;
    const kind = descriptor['kind'] as string;

    // -----------------------------------------------------------------------
    // Custom kind → delegate to slice-4 custom block store
    // -----------------------------------------------------------------------
    if (kind === 'custom') {
      // Validate using slice-4's validator (handles custom-specific fields)
      const customError = validateCustomProposalInput(body);
      if (customError) {
        res.status(422).json({ error: customError });
        return;
      }

      // Build a CustomBlockProposal record in the slice-4 store
      const input = body as {
        descriptor: WorkbenchBlockDescriptor;
        rendererSource: unknown;
        proposedBy: ActorRef;
      };
      const proposalId = crypto.randomUUID();
      const now = new Date().toISOString();

      // Persist in slice-4 store
      const customProposals = readCustomProposals(configPath);
      const customProposal = {
        proposalId,
        descriptor: input.descriptor,
        rendererSource: input.rendererSource,
        proposedBy: input.proposedBy,
        proposedAt: now,
        status: 'pending' as const,
        statusUpdatedAt: now,
      };

      const auditEventId = emitProposeAudit(auditSink, {
        proposalId,
        actorId: input.proposedBy.id,
        action: 'workbench.block.propose.custom',
        decision: 'recorded',
        eventType: 'grant',
        reasonCode: 'workbench_block_proposed_custom',
      });

      if (auditEventId) {
        (
          customProposal as typeof customProposal & { auditEventId?: string }
        ).auditEventId = auditEventId;
      }

      customProposals.set(
        proposalId,
        customProposal as Parameters<typeof customProposals.set>[1]
      );

      try {
        writeCustomProposals(configPath, customProposals);
      } catch (err) {
        logger.error(
          'Failed to write custom proposal in propose-block:',
          err instanceof Error ? err.message : err
        );
        res.status(500).json({ error: 'failed to persist proposal' });
        return;
      }

      const result: WorkbenchBlockProposalResult = {
        proposalId,
        status: STATUS_PENDING,
      };
      res.status(201).json(result);
      return;
    }

    // -----------------------------------------------------------------------
    // First-party kind → validate + evaluate capability grants
    // -----------------------------------------------------------------------
    const descError = validateFirstPartyDescriptor(descriptor);
    if (descError) {
      const proposalId = crypto.randomUUID();
      const result: WorkbenchBlockProposalResult = {
        proposalId,
        status: STATUS_REJECTED,
        rejectionReason: descError,
      };
      res.status(422).json(result);
      return;
    }

    const request: WorkbenchBlockProposalRequest = {
      descriptor: descriptor as unknown as WorkbenchBlockDescriptor,
      actorId: obj['actorId'] as string,
      actorGrantedBits: obj[
        'actorGrantedBits'
      ] as string[] as import('../shared/security-policy.js').RelayCapabilityBit[],
      ...(typeof obj['actorDisplayName'] === 'string'
        ? { actorDisplayName: obj['actorDisplayName'] }
        : {}),
      ...(typeof obj['workspaceScopeId'] === 'string'
        ? { workspaceScopeId: obj['workspaceScopeId'] }
        : {}),
    };

    const result = evaluateBlockProposal(request, () => crypto.randomUUID());

    // Emit audit on any state
    const auditAction =
      result.status === STATUS_AUTO_APPROVED
        ? 'workbench.block.propose.auto-approved'
        : result.status === STATUS_REJECTED
          ? 'workbench.block.propose.rejected'
          : 'workbench.block.propose.pending';
    const auditDecision: SecurityAuditEntryInput['decision'] =
      result.status === STATUS_AUTO_APPROVED
        ? 'approved'
        : result.status === STATUS_REJECTED
          ? 'deny'
          : 'recorded';

    const auditEventId = emitProposeAudit(auditSink, {
      proposalId: result.proposalId,
      actorId: request.actorId,
      action: auditAction,
      decision: auditDecision,
      eventType: result.status === STATUS_AUTO_APPROVED ? 'approval' : 'grant',
      reasonCode: `workbench_block_${result.status.replace('-', '_')}`,
    });

    if (result.status === STATUS_REJECTED) {
      res.status(422).json(result);
      return;
    }

    // Persist the first-party proposal
    const now = new Date().toISOString();
    const record: FirstPartyBlockProposal = {
      proposalId: result.proposalId,
      descriptor: request.descriptor,
      actorId: request.actorId,
      ...(request.actorDisplayName
        ? { actorDisplayName: request.actorDisplayName }
        : {}),
      ...(request.workspaceScopeId
        ? { workspaceScopeId: request.workspaceScopeId }
        : {}),
      proposedAt: now,
      status: result.status,
      statusUpdatedAt: now,
      ...(auditEventId ? { auditEventId } : {}),
    };

    const proposals = readFirstPartyProposals(configPath);
    proposals.set(record.proposalId, record);

    try {
      writeFirstPartyProposals(configPath, proposals);
    } catch (err) {
      logger.error(
        'Failed to write first-party proposal:',
        err instanceof Error ? err.message : err
      );
      res.status(500).json({ error: 'failed to persist proposal' });
      return;
    }

    res.status(201).json(result);
  });

  // -------------------------------------------------------------------------
  // GET /propose-block/proposals — list first-party proposals
  // -------------------------------------------------------------------------
  router.get('/propose-block/proposals', (req: Request, res: Response) => {
    const statusFilter = req.query['status'] as string | undefined;
    const proposals = readFirstPartyProposals(configPath);
    let results = [...proposals.values()];

    if (statusFilter) {
      const validStatuses = [
        STATUS_PENDING,
        STATUS_AUTO_APPROVED,
        STATUS_REJECTED,
      ];
      if (
        !validStatuses.includes(statusFilter as (typeof validStatuses)[number])
      ) {
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
  // POST /propose-block/proposals/:id/approve — user approves pending
  // -------------------------------------------------------------------------
  router.post(
    '/propose-block/proposals/:id/approve',
    (req: Request, res: Response) => {
      const { id } = req.params as { id: string };
      const proposals = readFirstPartyProposals(configPath);
      const proposal = proposals.get(id);

      if (!proposal) {
        res.status(404).json({ error: 'proposal not found' });
        return;
      }
      if (proposal.status !== STATUS_PENDING) {
        res.status(409).json({
          error: 'proposal is not in pending status',
          status: proposal.status,
        });
        return;
      }

      const now = new Date().toISOString();
      const auditEventId = emitProposeAudit(auditSink, {
        proposalId: id,
        actorId: 'user',
        action: 'workbench.block.propose.user-approved',
        decision: 'approved',
        eventType: 'approval',
        reasonCode: 'workbench_block_user_approved',
      });

      const updated: FirstPartyBlockProposal = {
        ...proposal,
        status: STATUS_AUTO_APPROVED, // treat user-approved as auto-approved state
        statusUpdatedAt: now,
        ...(auditEventId ? { auditEventId } : {}),
      };

      proposals.set(id, updated);

      try {
        writeFirstPartyProposals(configPath, proposals);
      } catch (err) {
        logger.error(
          'Failed to write first-party proposals on approve:',
          err instanceof Error ? err.message : err
        );
        res.status(500).json({ error: 'failed to persist approval' });
        return;
      }

      res.json(updated);
    }
  );

  // -------------------------------------------------------------------------
  // POST /propose-block/proposals/:id/reject — user rejects pending
  // -------------------------------------------------------------------------
  router.post(
    '/propose-block/proposals/:id/reject',
    (req: Request, res: Response) => {
      const { id } = req.params as { id: string };
      const proposals = readFirstPartyProposals(configPath);
      const proposal = proposals.get(id);

      if (!proposal) {
        res.status(404).json({ error: 'proposal not found' });
        return;
      }
      if (proposal.status !== STATUS_PENDING) {
        res.status(409).json({
          error: 'proposal is not in pending status',
          status: proposal.status,
        });
        return;
      }

      const now = new Date().toISOString();
      const auditEventId = emitProposeAudit(auditSink, {
        proposalId: id,
        actorId: 'user',
        action: 'workbench.block.propose.user-rejected',
        decision: 'deny',
        eventType: 'denial',
        reasonCode: 'workbench_block_user_rejected',
      });

      const updated: FirstPartyBlockProposal = {
        ...proposal,
        status: STATUS_REJECTED,
        statusUpdatedAt: now,
        ...(auditEventId ? { auditEventId } : {}),
      };

      proposals.set(id, updated);

      try {
        writeFirstPartyProposals(configPath, proposals);
      } catch (err) {
        logger.error(
          'Failed to write first-party proposals on reject:',
          err instanceof Error ? err.message : err
        );
        res.status(500).json({ error: 'failed to persist rejection' });
        return;
      }

      res.json(updated);
    }
  );

  return router;
}
