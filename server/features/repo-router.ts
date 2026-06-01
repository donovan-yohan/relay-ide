import * as express from 'express';
import {
  createConfirmationChallengeStore,
  type ConfirmationChallengeStore,
} from '../confirmation-challenges.js';
import { type HubNodeRegistry } from '../hub-node-registry.js';
import {
  nodeHasTerminalBackend,
  nodeTerminalBackends,
  RELAY_NODE_LINK_PROTOCOL_VERSION,
  type HubNodeSummary,
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
  buildIaTree,
  type IaNodeStatus,
  type IaWorkspaceGroupInput,
} from './ia-tree.js';
import { IaStoreError, type IaStore } from '../ia-store.js';
import {
  createBenchId,
  parseBenchId,
  type BenchId,
} from '../../shared/bench.js';
import { parseInstanceId } from '../../shared/project.js';
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
  /**
   * Legacy workspace groups (config.workspaces) used ONLY to group derived
   * projects in `GET /hub/ia/tree`. Config-agnostic by injection so this router
   * never reaches into config directly. Optional: omit → no grouping.
   */
  listWorkspaceGroups?: () => IaWorkspaceGroupInput[];
  /**
   * IA persistence store (#737). Backs the Bench overlay CRUD routes (#735):
   * user-authored env/label overrides + arbitrary-cwd (non-git) benches on a
   * node instance. Optional: omit (or pass null) → the overlay routes return
   * 503 (persistence unavailable), exactly like the boot guard degrades when
   * the SQLite file fails to open. The DERIVED git-worktree benches in
   * `GET /hub/ia/tree` do not depend on this store.
   */
  iaStore?: IaStore | null;
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

// ── Bench overlay validation (#735) ─────────────────────────────────────────
// All structural/paranoid: the hub mints a BenchId from caller-supplied
// instanceId + cwd, so both are validated before they ever reach the store.
// The hub cannot stat a remote node's filesystem, so cwd validation is
// path-shape only (absolute, no `..` traversal, no NUL/control chars). It
// deliberately does NOT require the instance to exist in current inventory:
// an overlay may target an offline node, and coupling persistence to live
// presence would silently drop legitimate state.

function validateInstanceId(value: unknown): RelayNodeError | null {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return relayError('INVALID_REQUEST', 'instanceId is required', false, {
      reasonCode: 'INSTANCE_ID_REQUIRED',
      field: 'instanceId',
    });
  }
  if (!parseInstanceId(value)) {
    return relayError('INVALID_REQUEST', 'instanceId is malformed', false, {
      reasonCode: 'INVALID_INSTANCE_ID',
      field: 'instanceId',
    });
  }
  return null;
}

function validateBenchCwd(value: unknown): RelayNodeError | null {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return relayError('INVALID_REQUEST', 'cwd is required', false, {
      reasonCode: 'CWD_REQUIRED',
      field: 'cwd',
    });
  }
  // NUL or other control chars never belong in a path; reject before they can
  // reach SQLite or a downstream node shell.
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(value)) {
    return relayError('INVALID_REQUEST', 'cwd contains control characters', false, {
      reasonCode: 'INVALID_CWD',
      field: 'cwd',
    });
  }
  // Absolute path only (POSIX or Windows). A relative cwd is meaningless once
  // it leaves the requesting context, and `..` traversal is never trusted.
  const isPosixAbs = value.startsWith('/');
  const isWindowsAbs = /^[a-zA-Z]:[\\/]/.test(value);
  if (!isPosixAbs && !isWindowsAbs) {
    return relayError('INVALID_REQUEST', 'cwd must be an absolute path', false, {
      reasonCode: 'CWD_NOT_ABSOLUTE',
      field: 'cwd',
    });
  }
  const segments = value.split(/[\\/]+/);
  if (segments.includes('..')) {
    return relayError('INVALID_REQUEST', 'cwd must not contain ".." traversal', false, {
      reasonCode: 'CWD_TRAVERSAL',
      field: 'cwd',
    });
  }
  return null;
}

type ParseResult<T> = { value: T } | { error: RelayNodeError };

// envOverrides: a plain string→string record. Non-string values are an
// explicit client error (the store would silently strip them; surfacing a 400
// keeps the contract honest for FE #740). `undefined` → `{}`.
function readEnvOverrides(value: unknown): ParseResult<Record<string, string>> {
  if (value === undefined || value === null) return { value: {} };
  if (
    typeof value !== 'object' ||
    Array.isArray(value)
  ) {
    return {
      error: relayError(
        'INVALID_REQUEST',
        'envOverrides must be an object of string values',
        false,
        { reasonCode: 'INVALID_ENV_OVERRIDES', field: 'envOverrides' }
      ),
    };
  }
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof key !== 'string' || key.length === 0) continue;
    if (typeof raw !== 'string') {
      return {
        error: relayError(
          'INVALID_REQUEST',
          `envOverrides.${key} must be a string`,
          false,
          { reasonCode: 'INVALID_ENV_OVERRIDE_VALUE', field: `envOverrides.${key}` }
        ),
      };
    }
    out[key] = raw;
  }
  return { value: out };
}

// label: optional display override. `undefined`/missing → leave unset; `null`
// → clear (fall back to derived label); a string → use it.
function readLabel(value: unknown): ParseResult<string | null | undefined> {
  if (value === undefined) return { value: undefined };
  if (value === null) return { value: null };
  if (typeof value !== 'string') {
    return {
      error: relayError('INVALID_REQUEST', 'label must be a string or null', false, {
        reasonCode: 'INVALID_LABEL',
        field: 'label',
      }),
    };
  }
  return { value };
}

// Map an IaStoreError (or anything else) onto a relay error envelope. Store
// validation rejections become 400; everything else is a 500.
function sendIaStoreError(res: express.Response, error: unknown): void {
  if (error instanceof IaStoreError) {
    sendRelayError(
      res,
      relayError('INVALID_REQUEST', error.code, false, { reasonCode: error.code })
    );
    return;
  }
  sendRelayError(
    res,
    relayError(
      'INTERNAL',
      error instanceof Error ? error.message : 'bench overlay write failed'
    )
  );
}

function sendNodeTerminalBackendUnavailable(
  res: express.Response,
  nodeId: string,
  node: HubNodeSummary
): void {
  const terminalBackends = nodeTerminalBackends(node);
  sendRelayError(
    res,
    relayError(
      'NODE_UNSUPPORTED',
      `node ${nodeId} cannot host PTY sessions: no terminal backend is available`,
      false,
      {
        reasonCode: 'NODE_TERMINAL_BACKEND_UNAVAILABLE',
        capability: 'terminalBackend',
        terminalBackends,
        tmuxStatus: node.capabilities.core.tmux,
      }
    )
  );
}

function validateReopenTargetNode(
  res: express.Response,
  nodeId: string,
  registry: HubNodeRegistry,
  nodeLinks?: HubNodeLinkManager
): HubNodeSummary | null {
  const node = registry
    .listNodes()
    .find((candidate) => candidate.nodeId === nodeId);
  if (!node || node.status === 'revoked') {
    sendRelayError(res, relayError('NOT_FOUND', 'node is not paired'));
    return null;
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
    return null;
  }
  if (node.capabilities.core.shell !== 'available') {
    sendRelayError(
      res,
      relayError(
        'NODE_UNSUPPORTED',
        `node ${nodeId} cannot host shell-backed terminal sessions`,
        false,
        {
          reasonCode: 'NODE_TERMINAL_SHELL_UNAVAILABLE',
          capability: 'shell',
          status: node.capabilities.core.shell,
        }
      )
    );
    return null;
  }
  if (!nodeHasTerminalBackend(node)) {
    sendNodeTerminalBackendUnavailable(res, nodeId, node);
    return null;
  }
  if (node.status !== 'online' || !nodeLinks?.hasActiveNode(nodeId)) {
    sendRelayError(
      res,
      relayError(
        'NODE_OFFLINE',
        `node ${nodeId} has no live reverse link`,
        true
      )
    );
    return null;
  }
  return node;
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

  // GET /hub/ia/tree (#734): server-side DERIVED six-layer IA read model —
  // Project (with ProjectIdentity) → Instance → Bench — from the SAME
  // authoritative cross-node inventory reports `/hub/repo-inventory` uses,
  // joined with hub node status (online/stale/offline) and optional workspace
  // grouping. Non-destructive: pure read/derive, no persistence/migration. This
  // is the server source-of-truth the frontend `view-tree` derive can later
  // consume instead of deriving client-side.
  router.get('/hub/ia/tree', requireAuth, async (_req, res) => {
    try {
      const reports = [...repoInventoryFeature.listInventoryReports()];
      if (options.collectLocalRepoInventory) {
        reports.push(await options.collectLocalRepoInventory());
      }
      // Join hub node status for host labels + online/stale/offline. Local node
      // is implicitly online and may be absent from the registry list — the
      // builder handles that (degrades cleanly, never crashes).
      const nodes: IaNodeStatus[] = registry.listNodes().map((node) => ({
        nodeId: node.nodeId,
        displayName: node.displayName,
        status: node.status,
        lastSeenAt: node.lastSeenAt,
      }));
      const tree = buildIaTree({
        reports,
        nodes,
        ...(options.listWorkspaceGroups
          ? { workspaceGroups: options.listWorkspaceGroups() }
          : {}),
        generatedAt: now().toISOString(),
      });
      res.json(tree);
    } catch (error) {
      sendRegistryError(registry, res, error);
    }
  });

  // ── Bench overlay CRUD (#735) ───────────────────────────────────────────────
  // The PERSISTED, user-authored overlay layer on top of the DERIVED bench
  // (`GET /hub/ia/tree`). Carries env overrides + an optional label override
  // and supports arbitrary-cwd (non-git) benches on a node instance — facts
  // the inventory-derive cannot know. Backed by the #737 IaStore BenchOverlay
  // table; non-destructive (own SQLite file, new tables only). When the store
  // is unavailable these routes 503 rather than crashing (mirrors the boot
  // guard in server/index.ts).
  const iaStore = options.iaStore ?? null;

  function requireIaStore(res: express.Response): IaStore | null {
    if (!iaStore) {
      res.status(503).json({
        error: relayError(
          'INTERNAL',
          'IA persistence is unavailable',
          true,
          { reasonCode: 'IA_STORE_UNAVAILABLE' }
        ),
      });
      return null;
    }
    return iaStore;
  }

  // GET /hub/ia/benches[?instanceId=...] — list bench overlays, optionally
  // filtered to a single instance. Returns [] (never 404) when none exist.
  router.get('/hub/ia/benches', requireAuth, async (req, res) => {
    const store = requireIaStore(res);
    if (!store) return;
    try {
      const rawInstanceId = req.query['instanceId'];
      const instanceId =
        typeof rawInstanceId === 'string' && rawInstanceId.length > 0
          ? rawInstanceId
          : null;
      if (instanceId !== null && !parseInstanceId(instanceId)) {
        sendRelayError(
          res,
          relayError('INVALID_REQUEST', 'instanceId is malformed', false, {
            reasonCode: 'INVALID_INSTANCE_ID',
            field: 'instanceId',
          })
        );
        return;
      }
      const all = store.listBenchOverlays();
      const benches =
        instanceId === null
          ? all
          : all.filter((b) => b.instanceId === instanceId);
      res.json({ benches });
    } catch (error) {
      sendIaStoreError(res, error);
    }
  });

  // POST /hub/ia/benches — create a bench overlay. Mints the BenchId from a
  // (validated) instanceId + cwd, so an arbitrary node-instance cwd becomes a
  // first-class Bench. Path validation is structural/paranoid (absolute, no
  // traversal, no NUL): the hub cannot stat a remote node's filesystem, so it
  // refuses to mint ids it cannot trust rather than guessing.
  router.post('/hub/ia/benches', requireAuth, async (req, res) => {
    const store = requireIaStore(res);
    if (!store) return;
    const body = bodyRecord(req);
    const instanceId = body['instanceId'];
    const cwd = body['cwd'];

    const instanceErr = validateInstanceId(instanceId);
    if (instanceErr) {
      sendRelayError(res, instanceErr);
      return;
    }
    const cwdErr = validateBenchCwd(cwd);
    if (cwdErr) {
      sendRelayError(res, cwdErr);
      return;
    }
    const envResult = readEnvOverrides(body['envOverrides']);
    if ('error' in envResult) {
      sendRelayError(res, envResult.error);
      return;
    }
    const labelResult = readLabel(body['label']);
    if ('error' in labelResult) {
      sendRelayError(res, labelResult.error);
      return;
    }

    let id: BenchId;
    try {
      // Both inputs are validated to be non-blank strings above; createBenchId
      // throws only on blank values, which validation already rejects. The
      // casts are sound because validate*() returned no error.
      id = createBenchId(instanceId as string, cwd as string);
    } catch {
      sendRelayError(
        res,
        relayError('INVALID_REQUEST', 'could not derive a bench id')
      );
      return;
    }

    try {
      const overlay = store.upsertBenchOverlay({
        id,
        envOverrides: envResult.value,
        ...(labelResult.value !== undefined ? { label: labelResult.value } : {}),
      });
      res.status(201).json({ bench: overlay });
    } catch (error) {
      sendIaStoreError(res, error);
    }
  });

  // PUT/PATCH /hub/ia/benches/:id — update label and/or env overrides on an
  // existing overlay. The id is opaque (URL-encoded BenchId); a missing
  // overlay is a 404. Omitted fields are left unchanged.
  async function updateBenchOverlay(
    req: express.Request,
    res: express.Response
  ): Promise<void> {
    const store = requireIaStore(res);
    if (!store) return;
    const id = req.params['id'];
    if (typeof id !== 'string' || !parseBenchId(id)) {
      sendRelayError(
        res,
        relayError('INVALID_REQUEST', 'bench id is malformed', false, {
          reasonCode: 'INVALID_BENCH_ID',
        })
      );
      return;
    }
    const existing = store.getBenchOverlay(id);
    if (!existing) {
      sendRelayError(res, relayError('NOT_FOUND', 'bench overlay not found'));
      return;
    }
    const body = bodyRecord(req);
    const hasEnv = Object.prototype.hasOwnProperty.call(body, 'envOverrides');
    const hasLabel = Object.prototype.hasOwnProperty.call(body, 'label');

    let envOverrides = existing.envOverrides;
    if (hasEnv) {
      const envResult = readEnvOverrides(body['envOverrides']);
      if ('error' in envResult) {
        sendRelayError(res, envResult.error);
        return;
      }
      envOverrides = envResult.value;
    }

    let label: string | null = existing.label;
    if (hasLabel) {
      const labelResult = readLabel(body['label']);
      if ('error' in labelResult) {
        sendRelayError(res, labelResult.error);
        return;
      }
      label = labelResult.value ?? null;
    }

    try {
      const overlay = store.upsertBenchOverlay({ id, envOverrides, label });
      res.json({ bench: overlay });
    } catch (error) {
      sendIaStoreError(res, error);
    }
  }
  router.put('/hub/ia/benches/:id', requireAuth, updateBenchOverlay);
  router.patch('/hub/ia/benches/:id', requireAuth, updateBenchOverlay);

  // DELETE /hub/ia/benches/:id — remove an overlay. Idempotent-ish: a missing
  // overlay is a 404 so callers can distinguish "deleted now" from "never
  // existed"; the derived git-worktree bench is unaffected either way.
  router.delete('/hub/ia/benches/:id', requireAuth, async (req, res) => {
    const store = requireIaStore(res);
    if (!store) return;
    const id = req.params['id'];
    if (typeof id !== 'string' || !parseBenchId(id)) {
      sendRelayError(
        res,
        relayError('INVALID_REQUEST', 'bench id is malformed', false, {
          reasonCode: 'INVALID_BENCH_ID',
        })
      );
      return;
    }
    try {
      const removed = store.deleteBenchOverlay(id);
      if (!removed) {
        sendRelayError(res, relayError('NOT_FOUND', 'bench overlay not found'));
        return;
      }
      res.json({ deleted: true, id });
    } catch (error) {
      sendIaStoreError(res, error);
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
      const node = validateReopenTargetNode(
        res,
        nodeId,
        registry,
        options.nodeLinks
      );
      if (!node) return;

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
        const payload = await options.nodeLinks!.request(
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
