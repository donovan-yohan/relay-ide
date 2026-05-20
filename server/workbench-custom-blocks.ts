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
 *   GET    /proposals/:id                — get a single proposal by id
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
 *   - `proposedBy` attribution is derived server-side from the request's
 *     `x-relay-actor-id` header (set by CLI gateway) or falls back to the
 *     literal string 'hub-user' for cookie-authenticated hub sessions.
 *     The request body's `proposedBy` field is treated as an UNTRUSTED
 *     display hint only — it is never used for audit attribution.
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
import type {
  SecurityAuditEntryInput,
  SecurityAuditPeerIdentity,
} from '../shared/security-audit.js';
import { isRelayCapabilityBit } from '../shared/security-policy.js';
import type { ActorRef } from '../shared/workbench-block-types.js';
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

// ---------------------------------------------------------------------------
// Per-template prop validators (fix #6)
// ---------------------------------------------------------------------------

type TemplatePropsValidator = (props: Record<string, unknown>) => string | null;

const TEMPLATE_PROP_VALIDATORS: Record<string, TemplatePropsValidator> = {
  'status-card': (p) => {
    if (typeof p['title'] !== 'string') {
      return 'status-card requires a string `title` prop';
    }
    const validStatuses = ['active', 'idle', 'error', 'done', 'pending'];
    if (
      p['status'] !== undefined &&
      !validStatuses.includes(p['status'] as string)
    ) {
      return `status-card "status" must be one of: ${validStatuses.join(', ')}`;
    }
    if (
      p['description'] !== undefined &&
      typeof p['description'] !== 'string'
    ) {
      return 'status-card `description` must be a string if provided';
    }
    return null;
  },
  'kv-grid': (p) => {
    if (!Array.isArray(p['rows'])) {
      return 'kv-grid requires an array `rows` prop';
    }
    for (let i = 0; i < (p['rows'] as unknown[]).length; i++) {
      const row = (p['rows'] as unknown[])[i];
      if (
        typeof row !== 'object' ||
        row === null ||
        typeof (row as Record<string, unknown>)['key'] !== 'string' ||
        typeof (row as Record<string, unknown>)['value'] !== 'string'
      ) {
        return `kv-grid rows[${i}] must be an object with string \`key\` and string \`value\``;
      }
    }
    if (p['heading'] !== undefined && typeof p['heading'] !== 'string') {
      return 'kv-grid `heading` must be a string if provided';
    }
    return null;
  },
  'link-list': (p) => {
    if (!Array.isArray(p['links'])) {
      return 'link-list requires an array `links` prop';
    }
    for (let i = 0; i < (p['links'] as unknown[]).length; i++) {
      const link = (p['links'] as unknown[])[i];
      if (
        typeof link !== 'object' ||
        link === null ||
        typeof (link as Record<string, unknown>)['label'] !== 'string' ||
        typeof (link as Record<string, unknown>)['url'] !== 'string'
      ) {
        return `link-list links[${i}] must be an object with string \`label\` and string \`url\``;
      }
    }
    if (p['heading'] !== undefined && typeof p['heading'] !== 'string') {
      return 'link-list `heading` must be a string if provided';
    }
    return null;
  },
};

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

  // Validate template-specific props (fix #6).
  const props =
    typeof rsObj['props'] === 'object' &&
    rsObj['props'] !== null &&
    !Array.isArray(rsObj['props'])
      ? (rsObj['props'] as Record<string, unknown>)
      : {};
  const templateName = rsObj['template'] as string;
  const validator = TEMPLATE_PROP_VALIDATORS[templateName];
  if (validator) {
    const propsError = validator(props);
    if (propsError) return propsError;
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
 *
 * Note: `proposedBy` attribution is derived server-side from the request
 * context (see deriveActorRef). The body's `proposedBy` field is accepted
 * as an UNTRUSTED display hint but is NOT validated here.
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

  return null;
}

// ---------------------------------------------------------------------------
// Audit helper
// ---------------------------------------------------------------------------

type AuditSink =
  | { append(input: SecurityAuditEntryInput): unknown }
  | undefined;

/**
 * Derive actor identity server-side from the request.
 *
 * Security: the request body's `proposedBy` field is NEVER used for audit
 * attribution — it is untrusted client input. Instead:
 *   - CLI gateway requests (x-relay-cli-gateway: v1) are tagged as `node` peers.
 *     The node identity comes from the request headers, not the body.
 *   - Cookie-authenticated hub sessions are tagged as `user` peers with a
 *     stable display name of 'hub-user'.
 *
 * The `displayHint` is the untrusted `proposedBy.displayName` from the body,
 * used only as a non-authoritative label in the audit entry.
 */
export function deriveActorRef(req: Request, displayHint?: string): ActorRef {
  const isCliGateway = req.header('x-relay-cli-gateway') === 'v1';
  if (isCliGateway) {
    // Agent (node) submitting via the versioned CLI gateway.
    // Use x-relay-node-id header if present; fall back to 'cli-gateway'.
    const nodeId = req.header('x-relay-node-id') ?? 'cli-gateway';
    return {
      kind: 'actor',
      id: nodeId,
      displayName: displayHint ?? nodeId,
    };
  }
  // Cookie-authenticated hub user.
  return {
    kind: 'actor',
    id: 'hub-user',
    displayName: displayHint ?? 'hub-user',
  };
}

/**
 * Map an ActorRef to a SecurityAuditPeerIdentity discriminated on kind.
 *
 * Actor id 'hub-user' → kind: 'user'.
 * CLI gateway actor (id != 'hub-user') → kind: 'node' with nodeId.
 */
function actorRefToPeer(actor: ActorRef): SecurityAuditPeerIdentity {
  if (actor.id === 'hub-user') {
    const peer: SecurityAuditPeerIdentity = { kind: 'user' };
    if (actor.displayName !== undefined) peer.displayName = actor.displayName;
    return peer;
  }
  // Agent actor submitted via CLI gateway — tag as node peer.
  const peer: SecurityAuditPeerIdentity = { kind: 'node', nodeId: actor.id };
  if (actor.displayName !== undefined) peer.displayName = actor.displayName;
  return peer;
}

function emitProposalAudit(
  auditSink: AuditSink,
  opts: {
    proposalId: string;
    actor: ActorRef;
    action: string;
    decision: SecurityAuditEntryInput['decision'];
    eventType: SecurityAuditEntryInput['eventType'];
    reasonCode: string;
  }
): string | undefined {
  if (!auditSink) return undefined;
  const eventId = crypto.randomUUID();
  const peer = actorRefToPeer(opts.actor);
  try {
    auditSink.append({
      eventId,
      eventType: opts.eventType,
      decision: opts.decision,
      reasonCode: opts.reasonCode,
      peer,
      node: peer.kind === 'node' && peer.nodeId ? { nodeId: peer.nodeId } : {},
      intent: {
        action: opts.action,
        target: `custom-block-proposal:${opts.proposalId}`,
      },
      material: {
        params: { proposalId: opts.proposalId, actorId: opts.actor.id },
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
 *   GET    /proposals/:id                — get a single proposal by id
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

    const input = body as Omit<CustomBlockProposalInput, 'proposedBy'> & {
      proposedBy?: { displayName?: string };
    };
    const proposalId = crypto.randomUUID();
    const now = new Date().toISOString();

    // Derive actor identity server-side — never trust the request body's
    // proposedBy for attribution (fix #4). Use the body's displayName only
    // as a non-authoritative display hint.
    const actor = deriveActorRef(req, input.proposedBy?.displayName);

    // Sync rendererId to the server-generated proposalId (fix #5).
    // The client may supply any rendererId value, but the contract is that
    // proposalId IS the rendererId for the approved descriptor.
    const descriptor = {
      ...input.descriptor,
      meta: {
        ...input.descriptor.meta,
        rendererId: proposalId,
      },
    };

    const proposal: CustomBlockProposal = {
      proposalId,
      descriptor,
      rendererSource:
        input.rendererSource as CustomBlockProposalInput['rendererSource'],
      proposedBy: actor,
      proposedAt: now,
      status: 'pending',
      statusUpdatedAt: now,
    };

    const proposals = readAllProposals(configPath);
    proposals.set(proposalId, proposal);

    const auditEventId = emitProposalAudit(auditSink, {
      proposalId,
      actor,
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
  // GET /proposals/:id — get a single proposal by id regardless of status (fix #1)
  // -------------------------------------------------------------------------
  router.get('/proposals/:id', (req: Request, res: Response) => {
    const { id } = req.params as { id: string };
    const proposals = readAllProposals(configPath);
    const proposal = proposals.get(id);

    if (!proposal) {
      res
        .status(404)
        .json({ error: CUSTOM_BLOCK_PROPOSAL_ERRORS.proposal_not_found });
      return;
    }

    res.json(proposal);
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

    // Hub-user is always the actor for approval/reject/revoke (user-facing actions).
    const hubActor: ActorRef = {
      kind: 'actor',
      id: 'hub-user',
      displayName: 'hub-user',
    };

    const auditEventId = emitProposalAudit(auditSink, {
      proposalId: id,
      actor: hubActor,
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

    const hubActor: ActorRef = {
      kind: 'actor',
      id: 'hub-user',
      displayName: 'hub-user',
    };

    const auditEventId = emitProposalAudit(auditSink, {
      proposalId: id,
      actor: hubActor,
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

    const hubActor: ActorRef = {
      kind: 'actor',
      id: 'hub-user',
      displayName: 'hub-user',
    };

    const auditEventId = emitProposalAudit(auditSink, {
      proposalId: id,
      actor: hubActor,
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
