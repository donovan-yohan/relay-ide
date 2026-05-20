import * as express from 'express';
import {
  createConfirmationChallengeStore,
  type ConfirmationChallengeStore,
} from '../confirmation-challenges.js';
import { type HubNodeRegistry } from '../hub-node-registry.js';
import {
  RELAY_NODE_LINK_PROTOCOL_VERSION,
  type RelayNodeError,
} from '../../shared/relay-node-protocol.js';
import { HubNodeLinkError, type HubNodeLinkManager } from '../hub-node-link.js';
import {
  bodyRecord,
  coldReopenSessionPayload,
  findColdReopenTarget,
  paramsWithoutConfirmation,
  recordField,
  relayError,
  scopedNodeSession,
  sendPolicyDecision,
  sendRelayError,
  sendRegistryError,
  sessionFromPayload,
  type RoutedSessionAuditSink,
} from '../hub-node-router.js';
import {
  evaluateHubPolicy,
  isSessionCreateType,
  sessionCreateCapabilities,
  type SessionCreateType,
} from '../hub-policy-evaluator.js';
import type { RepoInventoryFeature } from './repo-inventory.js';
import {
  summarizeRepoIdentityGroups,
  type RepoInventoryReport,
} from '../../shared/repo-inventory.js';
import {
  expiresAtFromLifecycleInput,
  lifecycleInputError,
  sessionEnvelopeRegistry,
  type InMemorySessionEnvelopeRegistry,
} from '../session-envelope-registry.js';

export interface RepoFeatureRouterOptions {
  registry: HubNodeRegistry;
  requireAuth: express.RequestHandler;
  repoInventoryFeature: RepoInventoryFeature;
  collectLocalRepoInventory?: () => Promise<RepoInventoryReport>;
  nodeLinks?: HubNodeLinkManager;
  sessionEnvelopes?: InMemorySessionEnvelopeRegistry;
  confirmations?: ConfirmationChallengeStore;
  auditSink?: RoutedSessionAuditSink;
  now?: () => Date;
}

function sessionCreateTypeFromBody(body: Record<string, unknown>): SessionCreateType | RelayNodeError {
  const rawSessionType = body['type'];
  if (rawSessionType === undefined) return 'agent';
  if (isSessionCreateType(rawSessionType)) return rawSessionType;
  return relayError('INVALID_REQUEST', 'type must be agent or terminal', false, {
    reasonCode: 'INVALID_SESSION_TYPE',
    field: 'type',
  });
}

// Repo-feature HTTP surface. These routes used to live in
// `hub-node-router.ts` mixed in with pairing / heartbeat / node-list
// concerns. Per #425.2 / #433 they move here so the core router stays
// repo-agnostic.
//
// Endpoints:
// - GET  /hub/repo-inventory                      → aggregate repo inventory across nodes (full payload)
// - GET  /hub/repo-groups                         → slim cross-node project groups keyed by RepoIdentity (#624)
// - POST /hub/nodes/:nodeId/sessions/reopen       → cold-reopen a session on a target node from inventory state
//
// Pure routing (pairing, heartbeat, node list/lifecycle, direct
// sessions create) stays in `hub-node-router.ts`.
export function createRepoFeatureRouter(
  options: RepoFeatureRouterOptions
): express.Router {
  const router = express.Router();
  const { registry, requireAuth, repoInventoryFeature } = options;
  const sessionEnvelopes = options.sessionEnvelopes ?? sessionEnvelopeRegistry;
  const confirmations = options.confirmations ?? createConfirmationChallengeStore();
  const now = () => options.now?.() ?? new Date();

  router.get('/hub/repo-inventory', requireAuth, async (_req, res) => {
    try {
      const reports = [...repoInventoryFeature.listInventoryReports()];
      if (options.collectLocalRepoInventory) {
        reports.push(await options.collectLocalRepoInventory());
      }
      // Both /hub/repo-inventory and /hub/repo-groups honour the router's
      // `options.now` injection point so `generatedAt` is deterministic in
      // tests and consistent between the two endpoints (Copilot review on
      // PR #639).
      res.json(repoInventoryFeature.aggregateInventoryReports(reports, now()));
    } catch (error) {
      sendRegistryError(registry, res, error);
    }
  });

  // GET /hub/repo-groups (#624): lightweight read of cross-node project
  // groups keyed by canonical RepoIdentity. Drops dirty/divergence/worktree
  // payloads so the picker (#615) and external agents can dedupe "same repo
  // on N nodes" without paying for full inventory bytes. Non-git or
  // remote-less checkouts surface as `repoIdentity === null` groups
  // (graceful absence, not an error per #624 AC).
  router.get('/hub/repo-groups', requireAuth, async (_req, res) => {
    try {
      const reports = [...repoInventoryFeature.listInventoryReports()];
      if (options.collectLocalRepoInventory) {
        reports.push(await options.collectLocalRepoInventory());
      }
      res.json(summarizeRepoIdentityGroups(reports, now()));
    } catch (error) {
      sendRegistryError(registry, res, error);
    }
  });

  router.post(
    '/hub/nodes/:nodeId/sessions/reopen',
    requireAuth,
    async (req, res) => {
      const { nodeId } = req.params;
      if (!nodeId) {
        sendRelayError(
          res,
          relayError('INVALID_REQUEST', 'nodeId is required')
        );
        return;
      }
      const node = registry
        .listNodes()
        .find((candidate) => candidate.nodeId === nodeId);
      if (!node || node.status === 'revoked') {
        sendRelayError(res, relayError('NOT_FOUND', 'node is not paired'));
        return;
      }
      if (node.protocolVersion !== RELAY_NODE_LINK_PROTOCOL_VERSION) {
        const [nodeMajor] = node.protocolVersion.split('.');
        const [hubMajor] = RELAY_NODE_LINK_PROTOCOL_VERSION.split('.');
        sendRelayError(
          res,
          relayError(
            nodeMajor === hubMajor ? 'VERSION_SKEW' : 'PROTOCOL_INCOMPATIBLE',
            `relay-node-link protocol ${node.protocolVersion} must exactly match hub protocol ${RELAY_NODE_LINK_PROTOCOL_VERSION}`
          )
        );
        return;
      }
      if (node.capabilities.core.tmux !== 'available') {
        sendRelayError(
          res,
          relayError(
            'NODE_UNSUPPORTED',
            `node ${nodeId} cannot host tmux-backed PTY sessions`
          )
        );
        return;
      }
      if (
        node.status !== 'online' ||
        !options.nodeLinks?.hasActiveNode(nodeId)
      ) {
        sendRelayError(
          res,
          relayError(
            'NODE_OFFLINE',
            `node ${nodeId} has no live reverse link`,
            true
          )
        );
        return;
      }

      const body = bodyRecord(req);
      const routedBody = paramsWithoutConfirmation(body);
      const lifecycleError = lifecycleInputError(routedBody);
      if (lifecycleError) {
        sendRelayError(
          res,
          relayError('INVALID_REQUEST', lifecycleError.message, false, {
            reasonCode: 'INVALID_LIFECYCLE_INPUT',
            field: lifecycleError.field,
          })
        );
        return;
      }
      const reopenNow = now();
      const expiresAt = expiresAtFromLifecycleInput(routedBody, reopenNow);
      if (
        expiresAt !== undefined &&
        expiresAt !== null &&
        Date.parse(expiresAt) <= reopenNow.getTime()
      ) {
        sendRelayError(
          res,
          relayError(
            'SESSION_EXPIRED',
            'routed session envelope is already expired',
            false,
            { reasonCode: 'SESSION_EXPIRED', expiresAt }
          )
        );
        return;
      }
      const sessionType = sessionCreateTypeFromBody(routedBody);
      if (typeof sessionType !== 'string') {
        sendRelayError(res, sessionType);
        return;
      }
      try {
        const reports = [...repoInventoryFeature.listInventoryReports()];
        if (options.collectLocalRepoInventory) {
          reports.push(await options.collectLocalRepoInventory());
        }
        const target = findColdReopenTarget(reports, nodeId, body);
        if ('code' in target) {
          sendRelayError(res, target as RelayNodeError);
          return;
        }

        const policyDecision = evaluateHubPolicy({
          peer: { kind: 'hub' },
          node,
          nodeId,
          intent: { action: 'sessions.create', target: nodeId },
          scope: {
            kind: target.worktree ? 'worktree' : 'repo',
            nodeId,
            cwd: target.worktree?.localPath ?? target.repo.localPath,
            repoPath: target.repo.localPath,
            ...(target.worktree ? { worktreePath: target.worktree.localPath } : {}),
          },
          requiredCapabilities: sessionCreateCapabilities({
            sessionType,
            controlMode: routedBody['controlMode'],
          }),
          ...(expiresAt !== undefined ? { expiresAt } : {}),
          params: routedBody,
          now: reopenNow,
        });
        if (
          sendPolicyDecision(options.auditSink, res, policyDecision, routedBody, {
            confirmations,
            req,
            canonicalParams: routedBody,
            now: reopenNow,
          })
        ) return;

        const sessionPayload = coldReopenSessionPayload(routedBody, target);
        const payload = await options.nodeLinks.request(
          nodeId,
          'sessions.create',
          sessionPayload
        );
        const session = scopedNodeSession(nodeId, sessionFromPayload(payload), {
          ...(expiresAt !== undefined ? { expiresAt } : {}),
        });
        if (session.sessionEnvelope) sessionEnvelopes.upsert(session.sessionEnvelope);
        res.status(201).json({
          session,
          transfer: {
            mode: 'cold-reopen',
            livePtyMigrated: false,
            message:
              'cold reopen started a new session from git/worktree state; it did not migrate live tmux/PTY process state',
            source: recordField(body, 'source'),
            target: {
              nodeId,
              repoPath: target.repo.localPath,
              worktreePath: target.worktree?.localPath ?? null,
              branchName: target.branchName,
              repoInstanceId: target.repo.repoInstanceId,
              ...(target.worktree
                ? { worktreeInstanceId: target.worktree.worktreeInstanceId }
                : {}),
            },
            warnings: target.warnings,
          },
        });
      } catch (error) {
        if (error instanceof HubNodeLinkError) {
          sendRelayError(res, error.relayNodeError);
          return;
        }
        sendRegistryError(registry, res, error);
      }
    }
  );

  return router;
}
