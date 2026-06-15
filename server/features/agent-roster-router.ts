import { Router } from 'express';
import type { Request, RequestHandler, Response } from 'express';

import type { RelayCliGatewayErrorCode } from '../../shared/cli-gateway-contract.js';
import {
  projectRosterEntry,
  type AgentRole,
  type RosterEntry,
  type RosterSessionInput,
} from '../../shared/agent-roster.js';
import {
  mergeRosterWithPresence,
  type AgentPresence,
} from '../../shared/agent-presence.js';

// `roster.list` (#953): a read-only, redacted, DERIVED projection of the live
// session read model so humans and agents can discover already-running
// collaborators in the same repo / WorkContext.
//
// `roster.register` / `roster.updateSelf` (#964): explicit, self-declared agent
// presence. An agent registers/updates its own role/use-case/status/capability
// hints (capability-gated on `context:write`); the GET projection MERGES this
// self-declared overlay into the derived entries — derived identity/control
// fields always win, self-declaration only decorates the soft collaboration
// subset, and stale (TTL-expired) presence is dropped. The merge surfaces
// non-Relay-launched agents that have no live session as `self-declared` rows.

const SESSION_READ = 'session:read';
const CONTEXT_WRITE = 'context:write';

/**
 * Minimal port the router needs from the presence store. Kept structural so the
 * router unit-tests can inject a fake without booting SQLite. Implemented by
 * `server/agent-presence-store.ts`.
 */
export interface RosterPresencePort {
  register(input: Record<string, unknown>): AgentPresence;
  updateSelf(input: Record<string, unknown>): AgentPresence;
  list(filter: {
    workContextId?: string;
    nodeId?: string;
    repoPath?: string;
  }): AgentPresence[];
}

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
  /** Explicit self-declared presence store (#964). Omit to disable the overlay. */
  presence?: RosterPresencePort | undefined;
  requireAuth?: RequestHandler;
  requireReadAuth?: { list?: RequestHandler };
  /** Write-command actor-auth factory (mirrors the inbox/workflow routers). */
  requireWriteActorAuth?: (
    expectedCommand: 'roster.register' | 'roster.updateSelf',
    options?: {
      scopeForRequest?: (req: Request) =>
        | {
            workContextIds?: string[];
            sessionIds?: string[];
            globalSessionIds?: string[];
            repoIds?: string[];
            taskRefs?: string[];
          }
        | undefined;
    }
  ) => RequestHandler;
  /** Resolve the authenticated actor id (audit attribution for register/update). */
  resolveActorId?: (req: Request) => string | undefined;
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

function bodyRecord(req: Request): Record<string, unknown> {
  return typeof req.body === 'object' &&
    req.body !== null &&
    !Array.isArray(req.body)
    ? (req.body as Record<string, unknown>)
    : {};
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

/** Map a thrown presence-store error (duck-typed status/code) to a gateway error. */
function presenceErrorToGateway(err: unknown): {
  code: RelayCliGatewayErrorCode;
  message: string;
  details?: Record<string, unknown>;
} {
  if (err && typeof err === 'object' && 'status' in err) {
    const record = err as Record<string, unknown>;
    const status = record['status'];
    const code = record['code'];
    const message =
      typeof record['message'] === 'string'
        ? record['message']
        : 'presence write failed';
    const reasonCode = typeof code === 'string' ? code : undefined;
    const gatewayCode: RelayCliGatewayErrorCode =
      status === 404
        ? 'NOT_FOUND'
        : status === 403
          ? 'FORBIDDEN'
          : status === 400
            ? 'INVALID_ARGUMENT'
            : 'INTERNAL';
    return {
      code: gatewayCode,
      message,
      ...(reasonCode ? { details: { reasonCode } } : {}),
    };
  }
  return { code: 'INTERNAL', message: 'presence write failed' };
}

export function createAgentRosterRouter(deps: AgentRosterRouterDeps): Router {
  const router = Router();
  const auth =
    deps.requireAuth ?? ((_req: Request, _res: Response, next) => next());
  const readAuth = deps.requireReadAuth ?? {};
  const now = deps.now ?? (() => new Date());
  const writeAuth = (
    command: 'roster.register' | 'roster.updateSelf'
  ): RequestHandler => deps.requireWriteActorAuth?.(command) ?? auth;

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

    // Merge explicit self-declared presence (#964). Failure here is non-fatal:
    // the roster degrades to derived-only rather than 503 on a presence glitch.
    if (deps.presence) {
      try {
        const presenceRecords = deps.presence.list({
          ...(workContextId ? { workContextId } : {}),
          ...(nodeId ? { nodeId } : {}),
          ...(repo ? { repoPath: repo } : {}),
        });
        entries = mergeRosterWithPresence(entries, presenceRecords, {
          now: now(),
          ...(deps.roleOverrides ? { roleOverrides: deps.roleOverrides } : {}),
        });
      } catch {
        // Leave `entries` as the derived projection.
      }
    }

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

  const presenceWrite =
    (kind: 'register' | 'updateSelf'): RequestHandler =>
    (req, res) => {
      if (denyMissingCapability(req, res, [CONTEXT_WRITE])) return;
      if (!deps.presence) {
        sendGatewayError(
          res,
          'SERVER_UNAVAILABLE',
          'agent presence store is unavailable',
          true,
          { reasonCode: 'PRESENCE_STORE_UNAVAILABLE' }
        );
        return;
      }
      const body = bodyRecord(req);
      const registeredBy =
        deps.resolveActorId?.(req) ??
        readString(body['createdBy']) ??
        readString(body['registeredBy']);
      const input: Record<string, unknown> = {
        ...body,
        ...(registeredBy ? { registeredBy } : {}),
      };
      try {
        const presence =
          kind === 'register'
            ? deps.presence.register(input)
            : deps.presence.updateSelf(input);
        res.json({ presence });
      } catch (err) {
        const mapped = presenceErrorToGateway(err);
        sendGatewayError(
          res,
          mapped.code,
          mapped.message,
          false,
          mapped.details
        );
      }
    };

  router.post(
    '/roster/register',
    writeAuth('roster.register'),
    presenceWrite('register')
  );
  router.post(
    '/roster/update-self',
    writeAuth('roster.updateSelf'),
    presenceWrite('updateSelf')
  );

  return router;
}
