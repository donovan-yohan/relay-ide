import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

import {
  WORKFLOW_RUN_SCHEMA_VERSION,
  parseWorkflowRunPublishInput,
  parseWorkflowRunUpdateInput,
  type WorkflowRunProjection,
  type WorkflowRunState,
} from '../shared/workflow-run.js';

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS workflow_runs (
  id                TEXT PRIMARY KEY,
  run_id            TEXT NOT NULL,
  provider_runtime  TEXT NOT NULL,
  work_context_id   TEXT NOT NULL,
  state             TEXT NOT NULL,
  definition_hash   TEXT NOT NULL,
  projection_json   TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  version           INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_context
  ON workflow_runs(work_context_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_run_id
  ON workflow_runs(run_id);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_runtime_context
  ON workflow_runs(provider_runtime, work_context_id);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_state_context
  ON workflow_runs(state, work_context_id);
`;

interface WorkflowRunRow {
  projection_json: string;
}

export interface WorkflowRunListInput {
  workContextId: string;
  state?: WorkflowRunState;
  providerRuntime?: string;
  limit?: number;
}

export interface WorkflowRunStore {
  close(): void;
  publish(input: unknown): WorkflowRunProjection;
  update(id: string, input: unknown): WorkflowRunProjection;
  get(id: string): WorkflowRunProjection | null;
  list(input: WorkflowRunListInput): WorkflowRunProjection[];
}

export class WorkflowRunStoreError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message = code,
    public readonly details: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = 'WorkflowRunStoreError';
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function parseRow(
  row: WorkflowRunRow | undefined
): WorkflowRunProjection | null {
  if (!row) return null;
  return JSON.parse(row.projection_json) as WorkflowRunProjection;
}

function cleanLimit(limit: number | undefined): number {
  if (!limit || !Number.isInteger(limit) || limit < 1) return 50;
  return Math.min(limit, 100);
}

export function createWorkflowRunStore(input: {
  dbPath: string;
}): WorkflowRunStore {
  const db = new Database(input.dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA_SQL);

  const insertStmt = db.prepare(`
    INSERT INTO workflow_runs (
      id, run_id, provider_runtime, work_context_id, state, definition_hash,
      projection_json, created_at, updated_at, version
    ) VALUES (
      @id, @runId, @providerRuntime, @workContextId, @state, @definitionHash,
      @projectionJson, @createdAt, @updatedAt, @version
    )
  `);
  const updateStmt = db.prepare(`
    UPDATE workflow_runs
       SET state = @state,
           projection_json = @projectionJson,
           updated_at = @updatedAt,
           version = @version
     WHERE id = @id
  `);
  const getStmt = db.prepare(
    'SELECT projection_json FROM workflow_runs WHERE id = ?'
  );

  return {
    close() {
      db.close();
    },
    publish(rawInput) {
      const parsed = parseWorkflowRunPublishInput(rawInput);
      const createdAt = parsed.createdAt ?? nowIso();
      const updatedAt = parsed.updatedAt ?? createdAt;
      const id = parsed.id ?? `workflow-run:${randomUUID()}`;
      const projection: WorkflowRunProjection = {
        schemaVersion: WORKFLOW_RUN_SCHEMA_VERSION,
        id,
        runId: parsed.runId,
        providerRuntime: parsed.providerRuntime,
        ...(parsed.runKind ? { runKind: parsed.runKind } : {}),
        workContextId: parsed.workContextId,
        definition: parsed.definition,
        state: parsed.state ?? 'queued',
        ...(parsed.progress ? { progress: parsed.progress } : {}),
        ...(parsed.phases ? { phases: parsed.phases } : {}),
        ...(parsed.steps ? { steps: parsed.steps } : {}),
        ...(parsed.resultSummary
          ? { resultSummary: parsed.resultSummary }
          : {}),
        ...(parsed.errorSummary ? { errorSummary: parsed.errorSummary } : {}),
        ...(parsed.journal ? { journal: parsed.journal } : {}),
        ...(parsed.links ? { links: parsed.links } : {}),
        ...(parsed.orchestration
          ? { orchestration: parsed.orchestration }
          : {}),
        createdAt,
        updatedAt,
        version: 1,
        redaction: parsed.redaction,
      };
      try {
        insertStmt.run({
          id: projection.id,
          runId: projection.runId,
          providerRuntime: projection.providerRuntime,
          workContextId: projection.workContextId,
          state: projection.state,
          definitionHash: projection.definition.hash,
          projectionJson: JSON.stringify(projection),
          createdAt: projection.createdAt,
          updatedAt: projection.updatedAt,
          version: projection.version,
        });
      } catch (error) {
        if (error instanceof Error && error.message.includes('UNIQUE')) {
          throw new WorkflowRunStoreError(
            409,
            'workflow_run_conflict',
            'workflow run already exists',
            {
              workflowRunId: projection.id,
            }
          );
        }
        throw error;
      }
      return projection;
    },
    update(id, rawInput) {
      const existing = parseRow(getStmt.get(id) as WorkflowRunRow | undefined);
      if (!existing) {
        throw new WorkflowRunStoreError(
          404,
          'workflow_run_not_found',
          'workflow run not found',
          {
            workflowRunId: id,
          }
        );
      }
      const parsed = parseWorkflowRunUpdateInput(rawInput);
      if (
        parsed.expectedVersion !== undefined &&
        parsed.expectedVersion !== existing.version
      ) {
        throw new WorkflowRunStoreError(
          409,
          'workflow_run_stale_version',
          'workflow run version is stale',
          {
            workflowRunId: id,
            expectedVersion: parsed.expectedVersion,
            currentVersion: existing.version,
          }
        );
      }
      const updatedAt = parsed.updatedAt ?? nowIso();
      const next: WorkflowRunProjection = {
        ...existing,
        ...(parsed.state ? { state: parsed.state } : {}),
        ...(parsed.progress ? { progress: parsed.progress } : {}),
        ...(parsed.phases ? { phases: parsed.phases } : {}),
        ...(parsed.steps ? { steps: parsed.steps } : {}),
        ...(parsed.resultSummary
          ? { resultSummary: parsed.resultSummary }
          : {}),
        ...(parsed.errorSummary ? { errorSummary: parsed.errorSummary } : {}),
        ...(parsed.journal ? { journal: parsed.journal } : {}),
        ...(parsed.links ? { links: parsed.links } : {}),
        ...(parsed.orchestration
          ? { orchestration: parsed.orchestration }
          : {}),
        updatedAt,
        version: existing.version + 1,
        redaction: {
          rawPayloadStored: false,
          rawTranscriptStored: false,
          providerPrivateStateStored: false,
          truncated:
            existing.redaction.truncated || parsed.redactionPatch.truncated,
          omittedKeys: [
            ...existing.redaction.omittedKeys,
            ...parsed.redactionPatch.omittedKeys.filter(
              (key) => !existing.redaction.omittedKeys.includes(key)
            ),
          ],
        },
      };
      updateStmt.run({
        id,
        state: next.state,
        projectionJson: JSON.stringify(next),
        updatedAt: next.updatedAt,
        version: next.version,
      });
      return next;
    },
    get(id) {
      return parseRow(getStmt.get(id) as WorkflowRunRow | undefined);
    },
    list(input) {
      const clauses = ['work_context_id = @workContextId'];
      const params: Record<string, unknown> = {
        workContextId: input.workContextId,
      };
      if (input.state) {
        clauses.push('state = @state');
        params['state'] = input.state;
      }
      if (input.providerRuntime) {
        clauses.push('provider_runtime = @providerRuntime');
        params['providerRuntime'] = input.providerRuntime;
      }
      params['limit'] = cleanLimit(input.limit);
      const rows = db
        .prepare(
          `SELECT projection_json FROM workflow_runs WHERE ${clauses.join(
            ' AND '
          )} ORDER BY updated_at DESC LIMIT @limit`
        )
        .all(params) as WorkflowRunRow[];
      return rows.flatMap((row) => {
        const parsed = parseRow(row);
        return parsed ? [parsed] : [];
      });
    },
  };
}

export function initWorkflowRunStore(configDir: string): WorkflowRunStore {
  return createWorkflowRunStore({
    dbPath: path.join(configDir, 'workflow-runs.db'),
  });
}
