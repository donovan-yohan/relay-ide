import { Router } from 'express';
import type { Request, RequestHandler, Response } from 'express';

import type { RelayCliGatewayErrorCode } from '../../shared/cli-gateway-contract.js';
import {
  projectRosterEntry,
  type AgentRole,
  type RosterEntry,
  type RosterSessionInput,
} from '../../shared/agent-roster.js';

// `roster.list` (#953): a read-only, redacted, DERIVED projection of the live
// session read model so humans and agents can discover already-running
// collaborators in the same repo / WorkContext. No new persistence; not an
// event stream. Capability-gated on `session:read` like `sessions.list`, and
// optionally WorkContext-scoped (see the mount in `server/index.ts`).

const SESSION_READ = 'session:read';

export interface AgentRosterRouterDeps {
  /**
   * Live sessions to project, already WorkContext-decorated. Async so a future
   * cross-node aggregation can drop in without changing the contract.
   */
  listSessions: () => RosterSessionInput[] | Promise<RosterSessionInput[]>;
  /** Framework capability flags for an agent kind. Defaults to none. */
  resolveCapabilities?: (agent: string) => readonly string[];
  /** Open (queued/delivered) inbox count targeting a session — drives attention. */
  pendingInboxCount?: (session: RosterSessionInput) => number;
  /** Per-provider role overrides (defaults from `DEFAULT_AGENT_ROLE_MAP`). */
  roleOverrides?: Readonly<Record<string, AgentRole>>;
  /** Node id stamped on the roster envelope. */
  nodeId?: string;
  requireAuth?: RequestHandler;
  requireReadAuth?: { list?: RequestHandler };
  /** Optional now() override for deterministic tests. */
  now?: () => Date;
}

function parseCapabilityHeader(value: string | undefined): Set<string> {
  if (!value) return new Set();
  return new Set(
    value
      .split(/[\s,]+/)
      .map((entry) => entry.trim())
      .filter(Boolean)
  );
}

function sendGatewayError(
  res: Response,
  code: RelayCliGatewayErrorCode,
  message: string,
  retryable = false,
  details?: Record<string, unknown>
): void {
  const status =
    code === 'NOT_FOUND'
      ? 404
      : code === 'FORBIDDEN'
        ? 403
        : code === 'SERVER_UNAVAILABLE'
          ? 503
          : code === 'INTERNAL'
            ? 500
            : 400;
  res.status(status).json({
    error: { code, message, retryable, ...(details ? { details } : {}) },
  });
}

function denyMissingCapability(
  req: Request,
  res: Response,
  required: string[]
): boolean {
  const caps = parseCapabilityHeader(req.header('x-relay-capabilities'));
  const missing = required.filter((cap) => !caps.has(cap));
  if (missing.length === 0) return false;
  sendGatewayError(
    res,
    'FORBIDDEN',
    `missing required capability: ${missing.join(', ')}`,
    false,
    {
      capability: missing[0],
    }
  );
  return true;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readBool(value: unknown): boolean | undefined {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return undefined;
}

function readLimit(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0
    ? Math.min(parsed, 200)
    : undefined;
}

/** Repo filter: match an exact path, a repo name, or a trailing path segment. */
function matchesRepo(entry: RosterEntry, repo: string): boolean {
  if (entry.repoPath === repo) return true;
  if (entry.repoName === repo) return true;
  if (
    entry.repoPath &&
    (entry.repoPath.endsWith(`/${repo}`) ||
      entry.repoPath.endsWith(`\\${repo}`) ||
      entry.cwd === repo)
  )
    return true;
  return false;
}

export function createAgentRosterRouter(deps: AgentRosterRouterDeps): Router {
  const router = Router();
  const auth =
    deps.requireAuth ?? ((_req: Request, _res: Response, next) => next());
  const readAuth = deps.requireReadAuth ?? {};
  const now = deps.now ?? (() => new Date());

  router.get('/roster', readAuth.list ?? auth, async (req, res) => {
    if (denyMissingCapability(req, res, [SESSION_READ])) return;

    const workContextId = readString(req.query['workContextId']);
    const repo = readString(req.query['repo']);
    const nodeId = readString(req.query['nodeId']);
    const provider = readString(req.query['provider']);
    const role = readString(req.query['role'])?.toLowerCase();
    const includeTerminals = readBool(req.query['includeTerminals']) ?? false;
    const needsAttention = readBool(req.query['needsAttention']);
    const limit = readLimit(req.query['limit']);

    let sessions: RosterSessionInput[];
    try {
      sessions = await deps.listSessions();
    } catch {
      sendGatewayError(
        res,
        'SERVER_UNAVAILABLE',
        'session read model is unavailable',
        true,
        {
          reasonCode: 'ROSTER_SESSIONS_UNAVAILABLE',
        }
      );
      return;
    }

    let entries: RosterEntry[] = sessions.map((session) =>
      projectRosterEntry(session, {
        capabilities: deps.resolveCapabilities?.(session.agent ?? '') ?? [],
        pendingInboxCount: deps.pendingInboxCount?.(session) ?? 0,
        ...(deps.roleOverrides ? { roleOverrides: deps.roleOverrides } : {}),
      })
    );

    entries = entries.filter((entry) => {
      if (!includeTerminals && entry.sessionType !== 'agent') return false;
      if (workContextId && entry.workContextId !== workContextId) return false;
      if (nodeId && entry.nodeId !== nodeId) return false;
      if (provider && entry.provider.toLowerCase() !== provider.toLowerCase())
        return false;
      if (role && entry.role !== role) return false;
      if (
        needsAttention !== undefined &&
        entry.attention.needsAttention !== needsAttention
      )
        return false;
      if (repo && !matchesRepo(entry, repo)) return false;
      return true;
    });

    // Stable order: most recently active first, attention-needing ahead of ties.
    entries.sort((a, b) => {
      if (a.attention.needsAttention !== b.attention.needsAttention) {
        return a.attention.needsAttention ? -1 : 1;
      }
      return (b.lastActivity ?? '').localeCompare(a.lastActivity ?? '');
    });

    if (limit) entries = entries.slice(0, limit);

    res.json({
      roster: entries,
      generatedAt: now().toISOString(),
      count: entries.length,
      ...(deps.nodeId ? { nodeId: deps.nodeId } : {}),
    });
  });

  return router;
}
