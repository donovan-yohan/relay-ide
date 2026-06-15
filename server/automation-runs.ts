import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

import {
  AUTOMATION_RUN_SCHEMA_VERSION,
  deriveAutomationRunStatus,
  parseAutomationRunObserveInput,
  parseAutomationRunRegisterInput,
  parseAutomationRunRetireInput,
  refreshTargetLiveness,
  type AutomationRunCleanupState,
  type AutomationRunLivenessResolver,
  type AutomationRunListFilter,
  type AutomationRunRecord,
  type AutomationRunTarget,
} from '../shared/automation-run.js';

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS automation_runs (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  kind             TEXT NOT NULL,
  run_id           TEXT,
  orchestrator     TEXT NOT NULL,
  repo_path        TEXT,
  work_context_id  TEXT,
  cleanup_state    TEXT NOT NULL,
  record_json      TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  version          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_automation_runs_work_context
  ON automation_runs(work_context_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_automation_runs_repo
  ON automation_runs(repo_path, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_automation_runs_orchestrator
  ON automation_runs(orchestrator, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_automation_runs_cleanup
  ON automation_runs(cleanup_state, updated_at DESC);
`;

interface AutomationRunRow {
  record_json: string;
}

/**
 * Persisted base record. `status`, `staleReasons`, and the displayed
 * `cleanup.state` are derived at read time via {@link finalizeRecord}; the
 * persisted `cleanup.state` is only ever `none` or `retired` (the durable retire
 * intent). Reads (`get`/`list`) never persist — they overlay a fresh liveness
 * probe so the registry always reflects current target truth.
 */
type StoredAutomationRun = AutomationRunRecord;

export interface AutomationRunStore {
  close(): void;
  register(input: unknown, resolver?: AutomationRunLivenessResolver): AutomationRunRecord;
  observe(
    id: string,
    input: unknown,
    resolver?: AutomationRunLivenessResolver
  ): AutomationRunRecord;
  retire(id: string, input: unknown): AutomationRunRecord;
  get(id: string, resolver?: AutomationRunLivenessResolver): AutomationRunRecord | null;
  list(
    filter: AutomationRunListFilter,
    resolver?: AutomationRunLivenessResolver
  ): AutomationRunRecord[];
}

export class AutomationRunStoreError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message = code,
    public readonly details: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = 'AutomationRunStoreError';
  }
}

function defaultClock(): string {
  return new Date().toISOString();
}

function cleanLimit(limit: number | undefined): number {
  if (!limit || !Number.isInteger(limit) || limit < 1) return 50;
  return Math.min(limit, 100);
}

function parseRow(row: AutomationRunRow | undefined): StoredAutomationRun | null {
  if (!row) return null;
  return JSON.parse(row.record_json) as StoredAutomationRun;
}

/**
 * Produce the read view of a stored run: optionally refresh target liveness,
 * derive status + stale reasons, and compute the displayed cleanup state.
 */
function finalizeRecord(
  stored: StoredAutomationRun,
  resolver: AutomationRunLivenessResolver | undefined,
  now: string
): AutomationRunRecord {
  const targets: AutomationRunTarget[] = resolver
    ? refreshTargetLiveness(stored.targets, resolver, now)
    : stored.targets;
  const derived = deriveAutomationRunStatus(
    {
      targets,
      heartbeat: stored.heartbeat,
      ...(stored.expiresAt ? { expiresAt: stored.expiresAt } : {}),
      cleanup: stored.cleanup,
    },
    now
  );
  const displayCleanupState: AutomationRunCleanupState =
    stored.cleanup.state === 'retired'
      ? 'retired'
      : derived.status === 'active'
        ? 'none'
        : 'needed';
  return {
    ...stored,
    targets,
    status: derived.status,
    staleReasons: derived.staleReasons,
    cleanup: { ...stored.cleanup, state: displayCleanupState },
  };
}

export function createAutomationRunStore(input: {
  dbPath: string;
  now?: () => string;
}): AutomationRunStore {
  const db = new Database(input.dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA_SQL);
  const clock = input.now ?? defaultClock;

  const getStmt = db.prepare('SELECT record_json FROM automation_runs WHERE id = ?');
  const upsertStmt = db.prepare(`
    INSERT INTO automation_runs (
      id, name, kind, run_id, orchestrator, repo_path, work_context_id,
      cleanup_state, record_json, created_at, updated_at, version
    ) VALUES (
      @id, @name, @kind, @runId, @orchestrator, @repoPath, @workContextId,
      @cleanupState, @recordJson, @createdAt, @updatedAt, @version
    )
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      kind = excluded.kind,
      run_id = excluded.run_id,
      orchestrator = excluded.orchestrator,
      repo_path = excluded.repo_path,
      work_context_id = excluded.work_context_id,
      cleanup_state = excluded.cleanup_state,
      record_json = excluded.record_json,
      updated_at = excluded.updated_at,
      version = excluded.version
  `);

  function persist(record: StoredAutomationRun): void {
    upsertStmt.run({
      id: record.id,
      name: record.name,
      kind: record.kind,
      runId: record.runId ?? null,
      orchestrator: record.owner.orchestrator,
      repoPath: record.repoPath ?? null,
      workContextId: record.workContextId ?? null,
      cleanupState: record.cleanup.state,
      recordJson: JSON.stringify(record),
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      version: record.version,
    });
  }

  return {
    close() {
      db.close();
    },

    register(rawInput, resolver) {
      const parsed = parseAutomationRunRegisterInput(rawInput);
      const now = clock();
      const id = parsed.id ?? `automation-run:${randomUUID()}`;
      const existing = parseRow(getStmt.get(id) as AutomationRunRow | undefined);
      // A run's workContextId is immutable across re-registration: the register
      // write-auth scope is checked against the request's workContextId, so
      // allowing it to change would let a credential scoped to one WorkContext
      // overwrite or revive a run belonging to another. To move a run, retire it
      // and register a new id.
      if (existing && existing.workContextId !== parsed.workContextId) {
        throw new AutomationRunStoreError(
          409,
          'automation_run_work_context_immutable',
          "an automation run's workContextId cannot change on re-registration",
          {
            automationRunId: id,
            ...(existing.workContextId ? { existingWorkContextId: existing.workContextId } : {}),
            ...(parsed.workContextId ? { requestedWorkContextId: parsed.workContextId } : {}),
          }
        );
      }
      const createdAt = parsed.createdAt ?? existing?.createdAt ?? now;
      const heartbeatExpiresAt = new Date(
        Date.parse(now) + parsed.ttlSeconds * 1000
      ).toISOString();
      const targets = resolver
        ? refreshTargetLiveness(parsed.targets, resolver, now)
        : parsed.targets;
      // Registering (or re-registering) is the create-or-replace primitive and
      // always resets the run to a live, non-retired state.
      const base: StoredAutomationRun = {
        schemaVersion: AUTOMATION_RUN_SCHEMA_VERSION,
        id,
        name: parsed.name,
        kind: parsed.kind,
        ...(parsed.runId ? { runId: parsed.runId } : {}),
        owner: parsed.owner,
        ...(parsed.repoPath ? { repoPath: parsed.repoPath } : {}),
        ...(parsed.workContextId ? { workContextId: parsed.workContextId } : {}),
        targets,
        ...(parsed.links ? { links: parsed.links } : {}),
        ...(parsed.expiresAt ? { expiresAt: parsed.expiresAt } : {}),
        status: 'active',
        staleReasons: [],
        heartbeat: {
          ttlSeconds: parsed.ttlSeconds,
          lastObservedAt: now,
          expiresAt: heartbeatExpiresAt,
        },
        ...(parsed.observationSummary
          ? { lastObservation: { observedAt: now, summary: parsed.observationSummary } }
          : {}),
        cleanup: { state: 'none' },
        createdAt,
        updatedAt: now,
        version: existing ? existing.version + 1 : 1,
        redaction: parsed.redaction,
      };
      persist(base);
      return finalizeRecord(base, resolver, now);
    },

    observe(id, rawInput, resolver) {
      const existing = parseRow(getStmt.get(id) as AutomationRunRow | undefined);
      if (!existing) {
        throw new AutomationRunStoreError(404, 'automation_run_not_found', 'automation run not found', {
          automationRunId: id,
        });
      }
      if (existing.cleanup.state === 'retired') {
        throw new AutomationRunStoreError(
          409,
          'automation_run_retired',
          'automation run is retired; re-register to revive it',
          { automationRunId: id }
        );
      }
      const parsed = parseAutomationRunObserveInput(rawInput);
      const now = clock();
      const ttlSeconds = parsed.ttlSeconds ?? existing.heartbeat.ttlSeconds;
      const baseTargets = parsed.targets ?? existing.targets;
      const targets = resolver
        ? refreshTargetLiveness(baseTargets, resolver, now)
        : baseTargets;
      const heartbeatExpiresAt = new Date(Date.parse(now) + ttlSeconds * 1000).toISOString();
      const expiresAt = parsed.expiresAt ?? existing.expiresAt;
      const next: StoredAutomationRun = {
        ...existing,
        targets,
        ...(expiresAt ? { expiresAt } : {}),
        heartbeat: { ttlSeconds, lastObservedAt: now, expiresAt: heartbeatExpiresAt },
        lastObservation: {
          observedAt: now,
          // Carry the prior note forward on a bare heartbeat so an observe with
          // no summary refreshes the timestamp without erasing the last note.
          ...(parsed.summary ?? existing.lastObservation?.summary
            ? { summary: parsed.summary ?? existing.lastObservation?.summary }
            : {}),
        },
        cleanup: { state: 'none' },
        updatedAt: now,
        version: existing.version + 1,
        redaction: {
          ...existing.redaction,
          truncated: existing.redaction.truncated || parsed.truncated,
        },
      };
      persist(next);
      return finalizeRecord(next, resolver, now);
    },

    retire(id, rawInput) {
      const existing = parseRow(getStmt.get(id) as AutomationRunRow | undefined);
      if (!existing) {
        throw new AutomationRunStoreError(404, 'automation_run_not_found', 'automation run not found', {
          automationRunId: id,
        });
      }
      const parsed = parseAutomationRunRetireInput(rawInput);
      // Idempotent: retiring an already-retired run returns it unchanged (no
      // version bump, no clobbered retiredAt/retiredBy/reason).
      if (existing.cleanup.state === 'retired') {
        return finalizeRecord(existing, undefined, existing.updatedAt);
      }
      const now = clock();
      const next: StoredAutomationRun = {
        ...existing,
        status: 'retired',
        staleReasons: [],
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
      return finalizeRecord(next, undefined, now);
    },

    get(id, resolver) {
      const stored = parseRow(getStmt.get(id) as AutomationRunRow | undefined);
      if (!stored) return null;
      return finalizeRecord(stored, resolver, clock());
    },

    list(filter, resolver) {
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
      if (filter.kind) {
        clauses.push('kind = @kind');
        params['kind'] = filter.kind;
      }
      if (filter.orchestrator) {
        clauses.push('orchestrator = @orchestrator');
        params['orchestrator'] = filter.orchestrator;
      }
      if (!filter.includeRetired && filter.status !== 'retired') {
        clauses.push("cleanup_state != 'retired'");
      }
      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
      // Status is derived (heartbeat/liveness), not stored, so it cannot be a
      // SQL predicate. Scan all rows matching the (already-scoped) WHERE rather
      // than an arbitrary superset cap: a stale/cleanup-needed run has an old
      // updated_at and would otherwise sort past a cap and silently vanish from
      // a `--status cleanup-needed` listing — the exact runs #959 must surface.
      // The set is operator-watchdog scale and further bounded by the WHERE.
      const rows = db
        .prepare(`SELECT record_json FROM automation_runs ${where} ORDER BY updated_at DESC`)
        .all(params) as AutomationRunRow[];
      const now = clock();
      const limit = cleanLimit(filter.limit);
      const out: AutomationRunRecord[] = [];
      for (const row of rows) {
        const stored = parseRow(row);
        if (!stored) continue;
        const record = finalizeRecord(stored, resolver, now);
        if (filter.status && record.status !== filter.status) continue;
        out.push(record);
        if (out.length >= limit) break;
      }
      return out;
    },
  };
}

export function initAutomationRunStore(
  configDir: string,
  options?: { now?: () => string }
): AutomationRunStore {
  return createAutomationRunStore({
    dbPath: path.join(configDir, 'automation-runs.db'),
    ...(options?.now ? { now: options.now } : {}),
  });
}
