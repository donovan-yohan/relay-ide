import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

import {
  PR_OVERSEER_SCHEMA_VERSION,
  boundPrObservation,
  derivePrOverseerView,
  parsePrOverseerObserveInput,
  parsePrOverseerRegisterInput,
  parsePrOverseerRetireInput,
  type PrObservation,
  type PrOverseerLastFetch,
  type PrOverseerLastObservation,
  type PrOverseerListFilter,
  type PrOverseerReadOptions,
  type PrOverseerRecord,
} from '../shared/pr-overseer.js';

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS pr_overseers (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  orchestrator     TEXT NOT NULL,
  owner_repo       TEXT NOT NULL,
  pr_number        INTEGER NOT NULL,
  repo_path        TEXT,
  work_context_id  TEXT,
  cleanup_state    TEXT NOT NULL,
  record_json      TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  version          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pr_overseers_work_context
  ON pr_overseers(work_context_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_pr_overseers_repo
  ON pr_overseers(repo_path, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_pr_overseers_orchestrator
  ON pr_overseers(orchestrator, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_pr_overseers_owner_repo
  ON pr_overseers(owner_repo, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_pr_overseers_cleanup
  ON pr_overseers(cleanup_state, updated_at DESC);
`;

interface PrOverseerRow {
  record_json: string;
}

/**
 * Persisted base record. `status`, `blockers`, `requiredNextAction`, `handoff`,
 * and `staleHeadRisk` are derived at read time via {@link finalizeRecord}; the
 * persisted `cleanup.state` is only ever `none` or `retired`. Reads (`get`/`list`)
 * never hit GitHub — they overlay the read-time derivation (age, heartbeat,
 * caller-asserted head) on the last stored observation so they are cheap and
 * rate-limit-safe. A fresh GitHub fetch happens only on explicit `observe`.
 */
type StoredPrOverseer = PrOverseerRecord;

export interface PrOverseerStore {
  close(): void;
  register(input: unknown): PrOverseerRecord;
  /**
   * Record a heartbeat/observation. `observation` is the freshly-fetched GitHub
   * snapshot from the injected observer (the router fetches it async, then calls
   * this sync store). A successful snapshot replaces the stored evidence; a failed
   * one (`ok: false`) only records the failed attempt and keeps the last good
   * snapshot, so a transient gh/auth/network blip never destroys evidence.
   * `undefined` is a bare heartbeat (refresh TTL only).
   */
  observe(id: string, input: unknown, observation?: PrObservation): PrOverseerRecord;
  retire(id: string, input: unknown): PrOverseerRecord;
  get(id: string, opts?: PrOverseerReadOptions): PrOverseerRecord | null;
  list(filter: PrOverseerListFilter): PrOverseerRecord[];
}

export class PrOverseerStoreError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message = code,
    public readonly details: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = 'PrOverseerStoreError';
  }
}

function defaultClock(): string {
  return new Date().toISOString();
}

function cleanLimit(limit: number | undefined): number {
  if (!limit || !Number.isInteger(limit) || limit < 1) return 50;
  return Math.min(limit, 100);
}

function parseRow(row: PrOverseerRow | undefined): StoredPrOverseer | null {
  if (!row) return null;
  return JSON.parse(row.record_json) as StoredPrOverseer;
}

/** Produce the read view of a stored record: derive status/blockers/handoff/etc. */
function finalizeRecord(
  stored: StoredPrOverseer,
  now: string,
  opts: PrOverseerReadOptions
): PrOverseerRecord {
  const view = derivePrOverseerView(
    {
      pr: stored.pr,
      ...(stored.expectedHeadSha ? { expectedHeadSha: stored.expectedHeadSha } : {}),
      ...(stored.issue ? { issue: stored.issue } : {}),
      heartbeat: stored.heartbeat,
      ...(stored.lastObservation ? { lastObservation: stored.lastObservation } : {}),
      ...(stored.lastFetch ? { lastFetch: stored.lastFetch } : {}),
      cleanup: stored.cleanup,
    },
    now,
    opts
  );
  return {
    ...stored,
    status: view.status,
    blockers: view.blockers,
    requiredNextAction: view.requiredNextAction,
    handoff: view.handoff,
    staleHeadRisk: view.staleHeadRisk,
  };
}

export function createPrOverseerStore(input: {
  dbPath: string;
  now?: () => string;
}): PrOverseerStore {
  const db = new Database(input.dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA_SQL);
  const clock = input.now ?? defaultClock;

  const getStmt = db.prepare('SELECT record_json FROM pr_overseers WHERE id = ?');
  const upsertStmt = db.prepare(`
    INSERT INTO pr_overseers (
      id, name, orchestrator, owner_repo, pr_number, repo_path, work_context_id,
      cleanup_state, record_json, created_at, updated_at, version
    ) VALUES (
      @id, @name, @orchestrator, @ownerRepo, @prNumber, @repoPath, @workContextId,
      @cleanupState, @recordJson, @createdAt, @updatedAt, @version
    )
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      orchestrator = excluded.orchestrator,
      owner_repo = excluded.owner_repo,
      pr_number = excluded.pr_number,
      repo_path = excluded.repo_path,
      work_context_id = excluded.work_context_id,
      cleanup_state = excluded.cleanup_state,
      record_json = excluded.record_json,
      updated_at = excluded.updated_at,
      version = excluded.version
  `);

  function persist(record: StoredPrOverseer): void {
    upsertStmt.run({
      id: record.id,
      name: record.name,
      orchestrator: record.owner.orchestrator,
      ownerRepo: record.pr.ownerRepo,
      prNumber: record.pr.number,
      repoPath: record.repoPath ?? null,
      workContextId: record.workContextId ?? null,
      cleanupState: record.cleanup.state,
      recordJson: JSON.stringify(record),
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      version: record.version,
    });
  }

  /** Placeholder derived fields for a freshly persisted (pre-finalize) base record. */
  const PLACEHOLDER_DERIVED = {
    status: 'pending' as const,
    blockers: [],
    requiredNextAction: {
      action: 'observe-first' as const,
      actor: 'operator' as const,
      summary: '',
      blockers: [],
    },
    handoff: { ready: false, exactHeadEvidenceCurrent: false, blockedBy: [], recommendedActor: 'operator' as const },
    staleHeadRisk: { diverged: false, heartbeatExpired: false, lastFetchFailed: false },
  };

  return {
    close() {
      db.close();
    },

    register(rawInput) {
      const parsed = parsePrOverseerRegisterInput(rawInput);
      const now = clock();
      const id = parsed.id ?? `pr-overseer:${randomUUID()}`;
      const existing = parseRow(getStmt.get(id) as PrOverseerRow | undefined);
      // workContextId is immutable across re-registration: the register write-auth
      // scope is checked against the request's workContextId, so allowing it to
      // change would let a credential scoped to one WorkContext overwrite/revive a
      // run belonging to another. To move a run, retire it and register a new id.
      if (existing && existing.workContextId !== parsed.workContextId) {
        throw new PrOverseerStoreError(
          409,
          'pr_overseer_work_context_immutable',
          "a pr overseer's workContextId cannot change on re-registration",
          {
            prOverseerId: id,
            ...(existing.workContextId ? { existingWorkContextId: existing.workContextId } : {}),
            ...(parsed.workContextId ? { requestedWorkContextId: parsed.workContextId } : {}),
          }
        );
      }
      const createdAt = parsed.createdAt ?? existing?.createdAt ?? now;
      const heartbeatExpiresAt = new Date(Date.parse(now) + parsed.ttlSeconds * 1000).toISOString();
      // Register (or re-register) is create-or-replace: it always resets to a live,
      // non-retired state and clears any prior observation (a new link starts fresh).
      const base: StoredPrOverseer = {
        schemaVersion: PR_OVERSEER_SCHEMA_VERSION,
        id,
        name: parsed.name,
        owner: parsed.owner,
        ...(parsed.repoPath ? { repoPath: parsed.repoPath } : {}),
        ...(parsed.workContextId ? { workContextId: parsed.workContextId } : {}),
        ...(parsed.session ? { session: parsed.session } : {}),
        ...(parsed.issue ? { issue: parsed.issue } : {}),
        pr: parsed.pr,
        ...(parsed.expectedHeadSha ? { expectedHeadSha: parsed.expectedHeadSha } : {}),
        ...(parsed.links ? { links: parsed.links } : {}),
        ...PLACEHOLDER_DERIVED,
        heartbeat: { ttlSeconds: parsed.ttlSeconds, lastObservedAt: now, expiresAt: heartbeatExpiresAt },
        ...(parsed.observationSummary
          ? {
              lastObservation: {
                observedAt: now,
                summary: parsed.observationSummary,
                snapshot: { ok: false, fetchedAt: now },
              } satisfies PrOverseerLastObservation,
            }
          : {}),
        cleanup: { state: 'none' },
        createdAt,
        updatedAt: now,
        version: existing ? existing.version + 1 : 1,
        redaction: parsed.redaction,
      };
      // A register-time observationSummary is a note only — it carries no real PR
      // snapshot, so drop it back to no-observation rather than seeding fake
      // evidence (status stays `pending` until a real observe).
      if (base.lastObservation && !base.lastObservation.snapshot.ok) {
        delete base.lastObservation;
      }
      persist(base);
      return finalizeRecord(base, now, {});
    },

    observe(id, rawInput, observation) {
      const existing = parseRow(getStmt.get(id) as PrOverseerRow | undefined);
      if (!existing) {
        throw new PrOverseerStoreError(404, 'pr_overseer_not_found', 'pr overseer not found', {
          prOverseerId: id,
        });
      }
      if (existing.cleanup.state === 'retired') {
        throw new PrOverseerStoreError(
          409,
          'pr_overseer_retired',
          'pr overseer is retired; re-register to revive it',
          { prOverseerId: id }
        );
      }
      const parsed = parsePrOverseerObserveInput(rawInput);
      const now = clock();
      const ttlSeconds = parsed.ttlSeconds ?? existing.heartbeat.ttlSeconds;
      const heartbeatExpiresAt = new Date(Date.parse(now) + ttlSeconds * 1000).toISOString();

      let lastObservation = existing.lastObservation;
      let lastFetch: PrOverseerLastFetch | undefined = existing.lastFetch;
      if (observation) {
        const snapshot = boundPrObservation({ ...observation, fetchedAt: now });
        lastFetch = {
          at: now,
          ok: snapshot.ok,
          ...(snapshot.unavailableReason ? { unavailableReason: snapshot.unavailableReason } : {}),
        };
        if (snapshot.ok) {
          // A successful fetch replaces the stored evidence with the new head.
          lastObservation = {
            observedAt: now,
            ...(parsed.summary ?? existing.lastObservation?.summary
              ? { summary: parsed.summary ?? existing.lastObservation?.summary }
              : {}),
            snapshot,
          };
        } else if (parsed.summary && lastObservation) {
          // Keep the last good snapshot but refresh the operator note.
          lastObservation = { ...lastObservation, summary: parsed.summary };
        }
      } else if (parsed.summary && lastObservation) {
        lastObservation = { ...lastObservation, summary: parsed.summary };
      }

      const next: StoredPrOverseer = {
        ...existing,
        ...(parsed.expectedHeadSha
          ? { expectedHeadSha: parsed.expectedHeadSha }
          : existing.expectedHeadSha
            ? { expectedHeadSha: existing.expectedHeadSha }
            : {}),
        heartbeat: { ttlSeconds, lastObservedAt: now, expiresAt: heartbeatExpiresAt },
        ...(lastObservation ? { lastObservation } : {}),
        ...(lastFetch ? { lastFetch } : {}),
        cleanup: { state: 'none' },
        updatedAt: now,
        version: existing.version + 1,
        redaction: {
          ...existing.redaction,
          truncated: existing.redaction.truncated || parsed.truncated,
        },
      };
      persist(next);
      return finalizeRecord(next, now, {});
    },

    retire(id, rawInput) {
      const existing = parseRow(getStmt.get(id) as PrOverseerRow | undefined);
      if (!existing) {
        throw new PrOverseerStoreError(404, 'pr_overseer_not_found', 'pr overseer not found', {
          prOverseerId: id,
        });
      }
      const parsed = parsePrOverseerRetireInput(rawInput);
      // Idempotent: retiring an already-retired run returns it unchanged.
      if (existing.cleanup.state === 'retired') {
        return finalizeRecord(existing, existing.updatedAt, {});
      }
      const now = clock();
      const next: StoredPrOverseer = {
        ...existing,
        cleanup: {
          state: 'retired',
          ...(parsed.reason ? { reason: parsed.reason } : {}),
          retiredAt: now,
          ...(parsed.retiredBy ? { retiredBy: parsed.retiredBy } : {}),
        },
        updatedAt: now,
        version: existing.version + 1,
      };
      persist(next);
      return finalizeRecord(next, now, {});
    },

    get(id, opts) {
      const stored = parseRow(getStmt.get(id) as PrOverseerRow | undefined);
      if (!stored) return null;
      return finalizeRecord(stored, clock(), opts ?? {});
    },

    list(filter) {
      const clauses: string[] = [];
      const params: Record<string, unknown> = {};
      if (filter.workContextId) {
        clauses.push('work_context_id = @workContextId');
        params['workContextId'] = filter.workContextId;
      }
      if (filter.repoPath) {
        clauses.push('repo_path = @repoPath');
        params['repoPath'] = filter.repoPath;
      }
      if (filter.orchestrator) {
        clauses.push('orchestrator = @orchestrator');
        params['orchestrator'] = filter.orchestrator;
      }
      if (filter.ownerRepo) {
        clauses.push('owner_repo = @ownerRepo');
        params['ownerRepo'] = filter.ownerRepo;
      }
      if (!filter.includeRetired && filter.status !== 'retired') {
        clauses.push("cleanup_state != 'retired'");
      }
      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
      // Status is derived (heartbeat/blockers), not stored, so it cannot be a SQL
      // predicate. When filtering by derived status, scan all rows matching the
      // (already-scoped) WHERE rather than a capped superset: a stale/blocked run
      // has an old updated_at and would otherwise sort past a cap and silently
      // vanish from a `--status blocked` listing — the runs an operator most needs.
      const limit = cleanLimit(filter.limit);
      let sql = `SELECT record_json FROM pr_overseers ${where} ORDER BY updated_at DESC`;
      if (!filter.status) {
        sql += ' LIMIT @limit';
        params['limit'] = limit;
      }
      const rows = db.prepare(sql).all(params) as PrOverseerRow[];
      const now = clock();
      const out: PrOverseerRecord[] = [];
      for (const row of rows) {
        const stored = parseRow(row);
        if (!stored) continue;
        const record = finalizeRecord(stored, now, {});
        if (filter.status && record.status !== filter.status) continue;
        out.push(record);
        if (out.length >= limit) break;
      }
      return out;
    },
  };
}

export function initPrOverseerStore(
  configDir: string,
  options?: { now?: () => string }
): PrOverseerStore {
  return createPrOverseerStore({
    dbPath: path.join(configDir, 'pr-overseers.db'),
    ...(options?.now ? { now: options.now } : {}),
  });
}
