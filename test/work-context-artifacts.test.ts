import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createWorkContextArtifactStore,
  WorkContextArtifactStoreError,
  type WorkContextArtifactStore,
} from '../server/work-context-artifacts.js';
import {
  PIPELINE_HANDOFF_ARTIFACT_SCHEMA_VERSION,
  validatePublicPipelineHandoffArtifact,
  type PipelineHandoffArtifact,
  type PipelineHandoffQaStage,
} from '../shared/pipeline-handoff-artifact.js';
import {
  AGENT_VIEW_MANIFEST_KIND,
  AGENT_VIEW_SCHEMA_VERSION,
  type ViewArtifactPackage,
} from '../shared/agent-view-artifact.js';

const now = '2026-06-08T12:00:00.000Z';
const headSha = 'a'.repeat(40);
const nextHeadSha = 'b'.repeat(40);

const cleanup: Array<() => void> = [];

function tmpStore(): { root: string; store: WorkContextArtifactStore } {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'work-context-artifacts-')
  );
  cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = createWorkContextArtifactStore({
    dbPath: path.join(root, 'index.db'),
    payloadRoot: path.join(root, 'payloads'),
  });
  cleanup.push(() => store.close());
  return { root, store };
}

function tmpRoot(prefix = 'work-context-artifacts-'): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

afterEach(() => {
  for (const dispose of cleanup.splice(0).reverse()) dispose();
});

function artifact(
  input: Partial<PipelineHandoffArtifact> = {}
): PipelineHandoffArtifact {
  return {
    schemaVersion: PIPELINE_HANDOFF_ARTIFACT_SCHEMA_VERSION,
    id: 'pipeline-handoff:example:aaaaaaaa',
    title: 'Example Project implementation handoff',
    createdAt: now,
    updatedAt: now,
    scope: {
      summary: 'artifact store foundation for generic project work',
      risk: 'medium',
      taskRefs: [
        {
          kind: 'github-issue',
          id: '42',
          url: 'https://github.com/example-org/example-project/issues/42',
        },
        {
          kind: 'kanban-task',
          id: 't_12345678',
          status: 'running',
        },
      ],
      acceptance: [
        'payload files are separate from indexed metadata',
        'list queries are bounded by the metadata index',
      ],
      nonGoals: [
        'no raw transcript ingestion',
        'no internal dispatcher or local worktree public copy',
      ],
    },
    head: {
      repo: { ownerRepo: 'example-org/example-project' },
      base: { name: 'nightly' },
      branch: { name: 'issue-42-artifact-store' },
      pr: {
        number: 123,
        url: 'https://github.com/example-org/example-project/pull/123',
      },
      headSha,
      staleIf: { headShaChanges: true },
      capturedAt: now,
    },
    stages: [
      {
        stage: 'implementation',
        addedAt: now,
        actorId: 'agent:kani-backend',
        summary:
          'stored payload file from /home/operator/example while keeping index metadata bounded',
        acceptanceEvidence: [
          {
            label: 'storage/index',
            disposition: 'provided',
            summary: 'metadata row and sha-addressed payload file recorded',
          },
        ],
        commands: [
          {
            label: 'targeted tests',
            command: 'npm test -- test/work-context-artifacts.test.ts',
            status: 'passed',
            summary: 'focused artifact store tests passed',
            exitCode: 0,
          },
        ],
        downstreamFocus: [
          'verify append-only metadata and public sanitizer boundaries',
        ],
        nonGoals: ['no UI or resume-packet integration in this slice'],
        decision: 'implemented',
        changedFiles: ['server/work-context-artifacts.ts'],
        migrationOrStateRisk:
          'new isolated SQLite index and payload directory only',
      },
    ],
    ...input,
  };
}

/**
 * Builds the QA layer that every append-only fixture below stacks on top of
 * the implementation layer, reusing the implementation stage's shared base
 * fields.
 *
 * TODO(#1498): these fixtures used to spread the whole implementation
 * stage and add `decision: 'validated'`. A QA stage carries `verdict`, never
 * `decision` (implementation-only), so that key — plus the inherited
 * `changedFiles`/`migrationOrStateRisk` — was dead fixture data the store never
 * read.
 */
function qaStage(predecessor: PipelineHandoffArtifact): PipelineHandoffQaStage {
  const implementation = predecessor.stages[0]!;
  return {
    stage: 'qa',
    addedAt: '2026-06-08T12:10:00.000Z',
    actorId: 'agent:kani-validator',
    summary: 'validated the immutable canonical handoff root',
    acceptanceEvidence: implementation.acceptanceEvidence,
    commands: implementation.commands,
    downstreamFocus: implementation.downstreamFocus,
    nonGoals: implementation.nonGoals,
    verdict: 'passed',
    testedHeadSha: predecessor.head.headSha,
    findings: [],
  };
}

function appendedArtifact(
  predecessor: PipelineHandoffArtifact,
  id: string
): PipelineHandoffArtifact {
  return {
    ...predecessor,
    id,
    supersedesArtifactId: predecessor.id,
    updatedAt: '2026-06-08T12:10:00.000Z',
    stages: [...predecessor.stages, qaStage(predecessor)],
  };
}

function structuredReviewArtifact(): PipelineHandoffArtifact {
  const implementation = artifact({
    id: 'pipeline-handoff:structured-public:aaaaaaaa',
    head: {
      ...artifact().head,
      base: { name: 'nightly', sha: 'c'.repeat(40) },
    },
  });
  const qa = appendedArtifact(
    implementation,
    'pipeline-handoff:structured-public:qa'
  ).stages[1]!;
  return {
    ...implementation,
    stages: [
      implementation.stages[0]!,
      qa,
      {
        ...implementation.stages[0]!,
        stage: 'review',
        actorId: 'agent:structured-reviewer',
        summary: 'independent review approved the exact head',
        verdict: 'approved',
        reviewedHeadSha: implementation.head.headSha,
        blockers: [],
        nitsOrFollowUps: [],
        adversarialReview: {
          promptVersion: 'adversarial-review-v1',
          baseSha: 'c'.repeat(40),
          diffSha256: 'd'.repeat(64),
          implementation: {
            actorId: implementation.stages[0]!.actorId,
            sessionId: 'session:implementation',
            runId: 'run:implementation',
            relayGlobalSessionId: 'global:implementation',
            provider: 'prime-agent',
            model: 'gpt-5.6',
          },
          reviewer: {
            actorId: 'agent:structured-reviewer',
            sessionId: 'session:review',
            runId: 'run:review',
            relayGlobalSessionId: 'global:review',
            provider: 'codex',
            model: 'gpt-5.6',
            independentFromImplementation: true,
            conflictOfInterest: 'none',
          },
          trustedProvenance: {
            disposition: 'declared-unverified',
            summary: 'auditable declaration pending a trusted resolver',
          },
          context: {
            digestSha256: 'e'.repeat(64),
            refs: ['docs/context-map.md#handoff-evidence'],
          },
          findings: [],
          containsNoRawTranscriptOrSecrets: true,
        },
      },
    ],
  };
}

function expectStoreErrorCode(fn: () => unknown, code: string): void {
  let didThrow = false;
  let caught: unknown;
  try {
    fn();
  } catch (err) {
    didThrow = true;
    caught = err;
  }
  if (!didThrow) {
    throw new Error(`store unexpectedly accepted input; expected ${code}`);
  }
  expect(caught).toBeInstanceOf(WorkContextArtifactStoreError);
  expect((caught as WorkContextArtifactStoreError).code).toBe(code);
}

function viewArtifact(
  input: Partial<ViewArtifactPackage> = {}
): ViewArtifactPackage {
  const manifest = {
    kind: AGENT_VIEW_MANIFEST_KIND,
    schemaVersion: AGENT_VIEW_SCHEMA_VERSION,
    title: 'Example static dashboard',
    description: 'A static view for issue 830',
    entry: 'index.html',
    authoring: { actorId: 'agent:kani-backend', harness: 'vitest' },
    createdAt: now,
    updatedAt: now,
    scope: {
      repo: 'example-org/example-project',
      taskRefs: [
        {
          kind: 'github-issue',
          id: '830',
          url: 'https://github.com/example-org/example-project/issues/830',
        },
      ],
    },
    sources: [
      {
        label: 'Issue 830',
        url: 'https://github.com/example-org/example-project/issues/830',
        kind: 'github-issue',
      },
    ],
    capabilities: [],
    export: { policy: 'private' },
    revision: { id: 'agent-view:example:aaaaaaaa' },
  } satisfies ViewArtifactPackage['manifest'];
  return {
    manifest,
    files: {
      'index.html': '<main><h1>Issue 830</h1><p>static bytes</p></main>',
      'style.css': 'main { color: #111; }',
    },
    ...input,
  };
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function createLegacyV1Store(input: {
  root: string;
  payload: PipelineHandoffArtifact;
  primaryTaskRef: { kind: string; id: string };
}): { dbPath: string; payloadPath: string } {
  const dbPath = path.join(input.root, 'index.db');
  const payloadRoot = path.join(input.root, 'payloads');
  fs.mkdirSync(payloadRoot, { recursive: true });
  const payloadJson = JSON.stringify(input.payload, null, 2);
  const payloadSha256 = sha256Hex(payloadJson);
  const payloadPath = path.join(payloadRoot, `${payloadSha256}.json`);
  fs.writeFileSync(payloadPath, payloadJson);

  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE work_context_artifact_schema_version (version INTEGER NOT NULL);
    INSERT INTO work_context_artifact_schema_version (version) VALUES (1);
    CREATE TABLE work_context_artifacts (
      id                    TEXT PRIMARY KEY,
      work_context_id       TEXT NOT NULL,
      project_id            TEXT,
      task_ref_kind         TEXT NOT NULL,
      task_ref_id           TEXT NOT NULL,
      stage                 TEXT,
      provenance_actor_id   TEXT,
      kind                  TEXT NOT NULL,
      title                 TEXT NOT NULL,
      summary               TEXT NOT NULL,
      visibility            TEXT NOT NULL,
      created_at            TEXT NOT NULL,
      updated_at            TEXT NOT NULL,
      captured_at           TEXT NOT NULL,
      payload_kind          TEXT NOT NULL,
      payload_media_type    TEXT NOT NULL,
      payload_path          TEXT NOT NULL,
      payload_sha256        TEXT NOT NULL,
      payload_bytes         INTEGER NOT NULL,
      pr_number             INTEGER,
      head_sha              TEXT,
      base_name             TEXT,
      branch_name           TEXT,
      supersedes_artifact_id TEXT,
      metadata_json         TEXT NOT NULL,
      CHECK (visibility IN ('private', 'public'))
    );
  `);
  db.prepare(
    `
    INSERT INTO work_context_artifacts (
      id, work_context_id, project_id, task_ref_kind, task_ref_id, stage,
      provenance_actor_id, kind, title, summary, visibility, created_at,
      updated_at, captured_at, payload_kind, payload_media_type, payload_path,
      payload_sha256, payload_bytes, pr_number, head_sha, base_name,
      branch_name, supersedes_artifact_id, metadata_json
    ) VALUES (
      @id, @workContextId, @projectId, @taskRefKind, @taskRefId, @stage,
      @provenanceActorId, @kind, @title, @summary, @visibility, @createdAt,
      @updatedAt, @capturedAt, @payloadKind, @payloadMediaType, @payloadPath,
      @payloadSha256, @payloadBytes, @prNumber, @headSha, @baseName,
      @branchName, @supersedesArtifactId, @metadataJson
    )
  `
  ).run({
    id: input.payload.id,
    workContextId: 'wc:legacy-v1',
    projectId: 'project:example-org/example-project',
    taskRefKind: input.primaryTaskRef.kind,
    taskRefId: input.primaryTaskRef.id,
    stage: 'implementation',
    provenanceActorId: 'agent:kani-backend',
    kind: 'report',
    title: input.payload.title,
    summary: input.payload.scope.summary,
    visibility: 'private',
    createdAt: input.payload.createdAt,
    updatedAt: input.payload.updatedAt,
    capturedAt: input.payload.head.capturedAt,
    payloadKind: 'pipeline-handoff-artifact',
    payloadMediaType: 'application/json',
    payloadPath,
    payloadSha256,
    payloadBytes: Buffer.byteLength(payloadJson, 'utf8'),
    prNumber: input.payload.head.pr?.number ?? null,
    headSha: input.payload.head.headSha,
    baseName: input.payload.head.base.name,
    branchName: input.payload.head.branch?.name ?? null,
    supersedesArtifactId: null,
    metadataJson: JSON.stringify({
      taskRef: {
        kind: input.primaryTaskRef.kind,
        id: input.primaryTaskRef.id,
      },
    }),
  });
  db.close();
  return { dbPath, payloadPath };
}

describe('WorkContext artifact store/index', () => {
  it('persists validated handoff artifacts as payload files plus indexed metadata', () => {
    const { root, store } = tmpStore();

    const stored = store.storePipelineHandoffArtifact({
      workContextId: 'wc:example',
      projectId: 'project:example-org/example-project',
      stage: 'implementation',
      provenanceActorId: 'agent:kani-backend',
      artifact: artifact(),
    });

    expect(stored.metadata).toMatchObject({
      id: 'pipeline-handoff:example:aaaaaaaa',
      workContextId: 'wc:example',
      projectId: 'project:example-org/example-project',
      taskRef: { kind: 'github-issue', id: '42' },
      stage: 'implementation',
      kind: 'report',
      visibility: 'private',
      payloadKind: 'pipeline-handoff-artifact',
      prNumber: 123,
      headSha,
      baseName: 'nightly',
      branchName: 'issue-42-artifact-store',
    });
    expect(stored.payloadPath.startsWith(path.join(root, 'payloads'))).toBe(
      true
    );
    expect(fs.existsSync(stored.payloadPath)).toBe(true);

    const byContext = store.list({ workContextId: 'wc:example' });
    expect(byContext).toHaveLength(1);
    expect(byContext[0]?.metadata.payloadSha256).toBe(
      stored.metadata.payloadSha256
    );

    const byTask = store.list({ taskRef: { kind: 'github-issue', id: '42' } });
    expect(byTask.map((entry) => entry.metadata.id)).toEqual([
      'pipeline-handoff:example:aaaaaaaa',
    ]);

    const read = store.read(stored.metadata.id);
    expect((read?.payload as PipelineHandoffArtifact | undefined)?.title).toBe(
      'Example Project implementation handoff'
    );
  });

  it('stores agent view artifacts with agent-view payload kind and sha-addressed packages', () => {
    const { root, store } = tmpStore();
    const pkg = viewArtifact();

    const stored = store.storeAgentViewArtifact({
      workContextId: 'wc:view',
      projectId: 'project:example-org/example-project',
      provenanceActorId: 'agent:kani-backend',
      viewArtifact: pkg,
    });

    const payloadJson = JSON.stringify(pkg, null, 2);
    expect(stored.metadata).toMatchObject({
      id: 'agent-view:example:aaaaaaaa',
      workContextId: 'wc:view',
      projectId: 'project:example-org/example-project',
      taskRef: { kind: 'github-issue', id: '830' },
      kind: 'report',
      visibility: 'private',
      payloadKind: 'agent-view-artifact',
      payloadSha256: sha256Hex(payloadJson),
      payloadBytes: Buffer.byteLength(payloadJson, 'utf8'),
    });
    expect(stored.payloadPath.startsWith(path.join(root, 'payloads'))).toBe(
      true
    );
    expect(JSON.parse(fs.readFileSync(stored.payloadPath, 'utf8'))).toEqual(
      pkg
    );
    expect(store.readViewArtifactPackage(stored.metadata.id)?.payload).toEqual(
      pkg
    );
    expect(store.read(stored.metadata.id)?.payload).toEqual(pkg);
  });

  it('normalizes agent view timestamps accepted by the shared contract', () => {
    const { store } = tmpStore();
    const pkg = viewArtifact({
      manifest: {
        ...viewArtifact().manifest,
        updatedAt: '2026-06-08T12:00:03Z',
      },
    });

    const stored = store.storeAgentViewArtifact({
      workContextId: 'wc:view-timestamp',
      viewArtifact: pkg,
    });

    expect(stored.metadata.capturedAt).toBe('2026-06-08T12:00:03.000Z');
  });

  it('rejects impossible agent view timestamps without date rollover', () => {
    const { store } = tmpStore();
    const pkg = viewArtifact({
      manifest: {
        ...viewArtifact().manifest,
        updatedAt: '2026-02-30T12:00:03Z',
      },
    });

    expect(() =>
      store.storeAgentViewArtifact({
        workContextId: 'wc:view-invalid-timestamp',
        viewArtifact: pkg,
      })
    ).toThrow(WorkContextArtifactStoreError);
  });

  it('derives agent view supersession from manifest revision when top-level field is omitted', () => {
    const { store } = tmpStore();
    const first = store.storeAgentViewArtifact({
      workContextId: 'wc:view-manifest-supersede',
      viewArtifact: viewArtifact(),
    });
    const replacementPkg = viewArtifact({
      manifest: {
        ...viewArtifact().manifest,
        updatedAt: '2026-06-08T12:10:00.000Z',
        revision: {
          id: 'agent-view:example:manifest-supersedes',
          supersedes: first.metadata.id,
        },
      },
    });

    const replacement = store.storeAgentViewArtifact({
      workContextId: 'wc:view-manifest-supersede',
      viewArtifact: replacementPkg,
    });

    expect(replacement.metadata.supersedesArtifactId).toBe(first.metadata.id);
    expect(
      store
        .list({ workContextId: 'wc:view-manifest-supersede' })
        .map((entry) => entry.metadata.id)
    ).toEqual([replacement.metadata.id]);
  });

  it('rejects cross-kind agent view predecessor edges', () => {
    const { store } = tmpStore();
    const handoff = store.storePipelineHandoffArtifact({
      workContextId: 'wc:view-cross-kind',
      artifact: artifact({ id: 'pipeline-handoff:cross-kind:aaaaaaaa' }),
    });
    const pkg = viewArtifact({
      manifest: {
        ...viewArtifact().manifest,
        revision: {
          id: 'agent-view:cross-kind:bbbbbbbb',
          supersedes: handoff.metadata.id,
        },
      },
    });

    expectStoreErrorCode(
      () =>
        store.storeAgentViewArtifact({
          workContextId: 'wc:view-cross-kind',
          viewArtifact: pkg,
        }),
      'superseded_artifact_payload_kind_mismatch'
    );
    expect(
      store
        .list({ workContextId: 'wc:view-cross-kind' })
        .map((entry) => entry.metadata.id)
    ).toEqual([handoff.metadata.id]);
  });

  it('maps contended agent view writes to a stable busy store error', async () => {
    const root = tmpRoot('work-context-artifacts-view-busy-');
    const store = createWorkContextArtifactStore({
      dbPath: path.join(root, 'index.db'),
      payloadRoot: path.join(root, 'payloads'),
      busyTimeoutMs: 25,
    });
    cleanup.push(() => store.close());
    const worker = new Worker(
      `
        const { parentPort, workerData } = require('node:worker_threads');
        const Database = require(workerData.betterSqlitePath);
        const db = new Database(workerData.dbPath);
        db.exec('BEGIN IMMEDIATE');
        parentPort.postMessage('locked');
        setTimeout(() => {
          db.exec('COMMIT');
          db.close();
          parentPort.postMessage('released');
        }, 100);
      `,
      {
        eval: true,
        workerData: {
          betterSqlitePath: createRequire(import.meta.url).resolve(
            'better-sqlite3'
          ),
          dbPath: path.join(root, 'index.db'),
        },
      }
    );
    cleanup.push(() => void worker.terminate());
    const message = (expected: string) =>
      new Promise<void>((resolve, reject) => {
        const onMessage = (value: unknown) => {
          if (value !== expected) return;
          worker.off('error', reject);
          resolve();
        };
        worker.once('error', reject);
        worker.on('message', onMessage);
      });
    await message('locked');
    const released = message('released');

    expectStoreErrorCode(
      () =>
        store.storeAgentViewArtifact({
          workContextId: 'wc:view-busy',
          viewArtifact: viewArtifact({
            manifest: {
              ...viewArtifact().manifest,
              revision: { id: 'agent-view:busy:aaaaaaaa' },
            },
          }),
        }),
      'artifact_store_busy'
    );
    await released;
  });

  it('rejects top-level visibility that disagrees with an agent view export policy', () => {
    const { store } = tmpStore();

    expect(() =>
      store.storeAgentViewArtifact({
        workContextId: 'wc:view-visibility',
        viewArtifact: viewArtifact(),
        visibility: 'public',
      })
    ).toThrow(WorkContextArtifactStoreError);
  });

  it('preserves supersede history for agent view artifacts without changing handoff rows', () => {
    const { store } = tmpStore();
    const first = store.storeAgentViewArtifact({
      workContextId: 'wc:view-supersede',
      viewArtifact: viewArtifact(),
    });
    const handoff = store.storePipelineHandoffArtifact({
      workContextId: 'wc:view-supersede',
      artifact: artifact({ id: 'pipeline-handoff:example:view-supersede' }),
    });
    const replacementPkg = viewArtifact({
      manifest: {
        ...viewArtifact().manifest,
        updatedAt: '2026-06-08T12:10:00.000Z',
        revision: {
          id: 'agent-view:example:bbbbbbbb',
          supersedes: first.metadata.id,
        },
      },
    });

    const replacement = store.storeAgentViewArtifact({
      workContextId: 'wc:view-supersede',
      viewArtifact: replacementPkg,
      supersedesArtifactId: first.metadata.id,
    });

    expect(replacement.metadata.supersedesArtifactId).toBe(first.metadata.id);
    expect(store.get(first.metadata.id)?.metadata.payloadKind).toBe(
      'agent-view-artifact'
    );
    expect(store.get(handoff.metadata.id)?.metadata.payloadKind).toBe(
      'pipeline-handoff-artifact'
    );
    expect(
      store
        .list({ workContextId: 'wc:view-supersede' })
        .map((entry) => entry.metadata.id)
        .sort()
    ).toEqual([handoff.metadata.id, replacement.metadata.id].sort());
  });

  it('backfills agent view task refs from manifest scope during migration', () => {
    const { root, store } = tmpStore();
    const pkg = viewArtifact({
      manifest: {
        ...viewArtifact().manifest,
        scope: {
          ...viewArtifact().manifest.scope,
          taskRefs: [
            { kind: 'github-issue', id: '830' },
            { kind: 'github-pr', id: '920' },
          ],
        },
      },
    });
    const stored = store.storeAgentViewArtifact({
      workContextId: 'wc:view-backfill',
      viewArtifact: pkg,
    });
    const db = new Database(path.join(root, 'index.db'));
    cleanup.push(() => db.close());
    db.prepare(
      'DELETE FROM work_context_artifact_task_refs WHERE artifact_id = ?'
    ).run(stored.metadata.id);

    const reopened = createWorkContextArtifactStore({
      dbPath: path.join(root, 'index.db'),
      payloadRoot: path.join(root, 'payloads'),
    });
    cleanup.push(() => reopened.close());

    expect(
      reopened.list({ taskRef: { kind: 'github-pr', id: '920' } })[0]?.metadata
        .id
    ).toBe(stored.metadata.id);
  });

  it('indexes every task ref from a handoff artifact payload', () => {
    const { store } = tmpStore();
    const multiRefArtifact = artifact({
      scope: {
        ...artifact().scope,
        taskRefs: [
          {
            kind: 'github-issue',
            id: '889',
            url: 'https://github.com/example-org/example-project/issues/889',
          },
          {
            kind: 'github-pr',
            id: '893',
            url: 'https://github.com/example-org/example-project/pull/893',
          },
        ],
      },
      head: {
        ...artifact().head,
        pr: {
          number: 893,
          url: 'https://github.com/example-org/example-project/pull/893',
        },
      },
    });

    const stored = store.storePipelineHandoffArtifact({
      workContextId: 'wc:multi-task-ref',
      artifact: multiRefArtifact,
    });

    expect(
      store.list({ taskRef: { kind: 'github-issue', id: '889' } })
    ).toHaveLength(1);
    expect(
      store.list({ taskRef: { kind: 'github-pr', id: '893' } })
    ).toHaveLength(1);
    expect(
      store.list({ taskRef: { kind: 'github-pr', id: '893' } })[0]?.metadata.id
    ).toBe(stored.metadata.id);
  });

  it('backfills v1 artifact rows from every valid payload task ref during migration', () => {
    const root = tmpRoot('work-context-artifacts-v1-');
    const legacyPayload = artifact({
      id: 'pipeline-handoff:legacy-v1:aaaaaaaa',
      scope: {
        ...artifact().scope,
        taskRefs: [
          {
            kind: 'github-issue',
            id: '889',
            url: 'https://github.com/example-org/example-project/issues/889',
          },
          {
            kind: 'github-pr',
            id: '893',
            url: 'https://github.com/example-org/example-project/pull/893',
          },
        ],
      },
      head: {
        ...artifact().head,
        pr: {
          number: 893,
          url: 'https://github.com/example-org/example-project/pull/893',
        },
      },
    });
    const { dbPath } = createLegacyV1Store({
      root,
      payload: legacyPayload,
      primaryTaskRef: { kind: 'github-issue', id: '889' },
    });
    const store = createWorkContextArtifactStore({
      dbPath,
      payloadRoot: path.join(root, 'payloads'),
    });
    cleanup.push(() => store.close());

    expect(
      store.list({ taskRef: { kind: 'github-issue', id: '889' } })
    ).toHaveLength(1);
    expect(
      store.list({ taskRef: { kind: 'github-pr', id: '893' } })
    ).toHaveLength(1);
    expect(
      store.list({ taskRef: { kind: 'github-pr', id: '893' } })[0]?.metadata.id
    ).toBe(legacyPayload.id);
  });

  it('falls back to the legacy primary task ref when a v1 payload is tampered', () => {
    const root = tmpRoot('work-context-artifacts-v1-tampered-');
    const legacyPayload = artifact({
      id: 'pipeline-handoff:legacy-v1-tampered:aaaaaaaa',
      scope: {
        ...artifact().scope,
        taskRefs: [
          { kind: 'github-issue', id: '889' },
          { kind: 'github-pr', id: '893' },
        ],
      },
    });
    const { dbPath, payloadPath } = createLegacyV1Store({
      root,
      payload: legacyPayload,
      primaryTaskRef: { kind: 'github-issue', id: '889' },
    });
    fs.writeFileSync(
      payloadPath,
      '{"scope":{"taskRefs":[{"kind":"github-pr","id":"893"}]}}'
    );
    const store = createWorkContextArtifactStore({
      dbPath,
      payloadRoot: path.join(root, 'payloads'),
    });
    cleanup.push(() => store.close());

    expect(
      store.list({ taskRef: { kind: 'github-issue', id: '889' } })
    ).toHaveLength(1);
    expect(
      store.list({ taskRef: { kind: 'github-pr', id: '893' } })
    ).toHaveLength(0);
  });

  it('lists from the SQLite index without reading payload files', () => {
    const { store } = tmpStore();
    const stored = store.storePipelineHandoffArtifact({
      workContextId: 'wc:bounded-list',
      artifact: artifact(),
    });
    fs.writeFileSync(stored.payloadPath, '{ definitely not valid json');

    const listed = store.list({ workContextId: 'wc:bounded-list' });
    expect(listed).toHaveLength(1);
    expect(listed[0]?.metadata.summary).toBe(
      'artifact store foundation for generic project work'
    );
    expect(() => store.read(stored.metadata.id)).toThrow(
      WorkContextArtifactStoreError
    );
  });

  it('supports hub-wide q search over metadata only, most-recent-first, capped at 20', () => {
    const { store } = tmpStore();
    store.storePipelineHandoffArtifact({
      workContextId: 'wc:search-alpha',
      artifact: artifact({
        id: 'pipeline-handoff:search:aaaaaaaa',
        title: 'Alpha widget rollout handoff',
        createdAt: now,
        updatedAt: now,
      }),
    });
    store.storePipelineHandoffArtifact({
      workContextId: 'wc:search-beta',
      artifact: artifact({
        id: 'pipeline-handoff:search:bbbbbbbb',
        title: 'Beta gadget rollout handoff',
        createdAt: '2026-06-08T12:00:01.000Z',
        updatedAt: '2026-06-08T12:00:01.000Z',
        head: {
          ...artifact().head,
          capturedAt: '2026-06-08T12:00:01.000Z',
        },
      }),
    });

    const byTitle = store.list({ q: 'widget' });
    expect(byTitle.map((entry) => entry.metadata.id)).toEqual([
      'pipeline-handoff:search:aaaaaaaa',
    ]);

    const byWorkContext = store.list({ q: 'search-beta' });
    expect(byWorkContext.map((entry) => entry.metadata.id)).toEqual([
      'pipeline-handoff:search:bbbbbbbb',
    ]);

    // Never matches on body/summary content — metadata only.
    const bySummaryContent = store.list({
      q: 'foundation for generic project work',
    });
    expect(bySummaryContent).toHaveLength(0);

    // Most-recent-first across matching contexts.
    const both = store.list({ q: 'rollout handoff' });
    expect(both.map((entry) => entry.metadata.id)).toEqual([
      'pipeline-handoff:search:bbbbbbbb',
      'pipeline-handoff:search:aaaaaaaa',
    ]);
  });

  it('caps q search at 20 results even when 25 rows match and a larger limit is requested', () => {
    const { store } = tmpStore();
    for (let i = 0; i < 25; i += 1) {
      store.storePipelineHandoffArtifact({
        workContextId: `wc:search-cap-${i}`,
        artifact: artifact({
          id: `pipeline-handoff:search-cap:${i.toString().padStart(8, '0')}`,
          title: `Search cap fixture #${i}`,
        }),
      });
    }

    const uncapped = store.list({ q: 'search cap fixture', limit: 200 });
    expect(uncapped).toHaveLength(20);

    const defaultLimit = store.list({ q: 'search cap fixture' });
    expect(defaultLimit).toHaveLength(20);
  });

  it('narrows q search results with an exact kind filter', () => {
    const { store } = tmpStore();
    store.storePipelineHandoffArtifact({
      workContextId: 'wc:search-kind',
      artifact: artifact({ id: 'pipeline-handoff:search-kind:aaaaaaaa' }),
    });
    const view = store.storeAgentViewArtifact({
      workContextId: 'wc:search-kind',
      kind: 'screenshot',
      viewArtifact: viewArtifact(),
    });

    const anyKind = store.list({ q: 'search-kind' });
    expect(anyKind.map((entry) => entry.metadata.id).sort()).toEqual(
      ['pipeline-handoff:search-kind:aaaaaaaa', view.metadata.id].sort()
    );

    const onlyScreenshots = store.list({
      q: 'search-kind',
      kind: 'screenshot',
    });
    expect(onlyScreenshots.map((entry) => entry.metadata.id)).toEqual([
      view.metadata.id,
    ]);
  });

  it('preserves append-only history and models superseded refs without rewriting prior rows', () => {
    const { store } = tmpStore();
    const first = store.storePipelineHandoffArtifact({
      workContextId: 'wc:append-only',
      artifact: artifact(),
    });

    expect(() =>
      store.storePipelineHandoffArtifact({
        workContextId: 'wc:append-only',
        artifact: artifact(),
      })
    ).toThrow(WorkContextArtifactStoreError);

    const originalArtifact = artifact();
    const replacementArtifact = artifact({
      id: 'pipeline-handoff:example:bbbbbbbb',
      updatedAt: '2026-06-08T12:10:00.000Z',
      stages: [...originalArtifact.stages, qaStage(originalArtifact)],
    });
    const replacement = store.storePipelineHandoffArtifact({
      workContextId: 'wc:append-only',
      artifact: replacementArtifact,
      supersedesArtifactId: first.metadata.id,
    });

    expect(replacement.metadata.supersedesArtifactId).toBe(first.metadata.id);
    expect(store.read(replacement.metadata.id)?.payload).toMatchObject({
      supersedesArtifactId: first.metadata.id,
    });
    expect(store.get(first.metadata.id)?.metadata.headSha).toBe(headSha);
    expect(
      store
        .list({ workContextId: 'wc:append-only' })
        .map((entry) => entry.metadata.id)
    ).toEqual([replacement.metadata.id]);
    expect(
      store
        .list({ workContextId: 'wc:append-only', includeSuperseded: true })
        .map((entry) => entry.metadata.id)
        .sort()
    ).toEqual([first.metadata.id, replacement.metadata.id].sort());
  });

  it('uses payload supersedes identity as canonical index metadata', () => {
    const { store } = tmpStore();
    const predecessor = artifact({ id: 'pipeline-handoff:canonical:aaaaaaaa' });
    store.storePipelineHandoffArtifact({
      workContextId: 'wc:canonical-payload',
      artifact: predecessor,
    });
    const successor = appendedArtifact(
      predecessor,
      'pipeline-handoff:canonical:bbbbbbbb'
    );

    const stored = store.storePipelineHandoffArtifact({
      workContextId: 'wc:canonical-payload',
      visibility: 'public',
      artifact: successor,
    });

    expect(stored.metadata.supersedesArtifactId).toBe(predecessor.id);
    expect(store.read(stored.metadata.id)?.payload).toEqual(successor);
    expect(store.publicSummary(stored.metadata.id)).toMatchObject({
      metadata: { supersedesArtifactId: predecessor.id },
      payload: { supersedesArtifactId: predecessor.id },
    });
  });

  it('rejects conflicting request and payload predecessor identities', () => {
    const { store } = tmpStore();
    const predecessor = artifact({ id: 'pipeline-handoff:mismatch:aaaaaaaa' });
    const successor = appendedArtifact(
      predecessor,
      'pipeline-handoff:mismatch:bbbbbbbb'
    );

    expectStoreErrorCode(
      () =>
        store.storePipelineHandoffArtifact({
          workContextId: 'wc:canonical-mismatch',
          artifact: successor,
          supersedesArtifactId: 'pipeline-handoff:other:cccccccc',
        }),
      'artifact_supersedes_mismatch'
    );
  });

  it('enforces same-head immutable-root append-only chains and rejects forks', () => {
    const { store } = tmpStore();
    const predecessor = artifact({ id: 'pipeline-handoff:chain:aaaaaaaa' });
    store.storePipelineHandoffArtifact({
      workContextId: 'wc:canonical-chain',
      artifact: predecessor,
    });
    const valid = appendedArtifact(
      predecessor,
      'pipeline-handoff:chain:bbbbbbbb'
    );

    expectStoreErrorCode(
      () =>
        store.storePipelineHandoffArtifact({
          workContextId: 'wc:canonical-chain',
          artifact: {
            ...valid,
            id: 'pipeline-handoff:chain:stale-head',
            head: { ...valid.head, headSha: nextHeadSha },
            stages: [
              valid.stages[0]!,
              {
                ...(valid.stages[1] as PipelineHandoffQaStage),
                testedHeadSha: nextHeadSha,
              },
            ],
          },
        }),
      'artifact_supersedes_stale_head'
    );
    expectStoreErrorCode(
      () =>
        store.storePipelineHandoffArtifact({
          workContextId: 'wc:canonical-chain',
          artifact: {
            ...valid,
            id: 'pipeline-handoff:chain:changed-root',
            title: 'Rewritten handoff title',
          },
        }),
      'artifact_supersedes_append_only_violation'
    );
    expectStoreErrorCode(
      () =>
        store.storePipelineHandoffArtifact({
          workContextId: 'wc:canonical-chain',
          artifact: {
            ...valid,
            id: 'pipeline-handoff:chain:changed-stage',
            stages: [
              { ...valid.stages[0]!, summary: 'rewritten prior stage' },
              valid.stages[1]!,
            ],
          },
        }),
      'artifact_supersedes_append_only_violation'
    );

    store.storePipelineHandoffArtifact({
      workContextId: 'wc:canonical-chain',
      artifact: valid,
    });
    expectStoreErrorCode(
      () =>
        store.storePipelineHandoffArtifact({
          workContextId: 'wc:canonical-chain',
          artifact: {
            ...valid,
            id: 'pipeline-handoff:chain:cccccccc',
          },
        }),
      'artifact_supersedes_fork'
    );
  });

  it('waits across SQLite handles and returns a stable fork conflict', async () => {
    const { root, store } = tmpStore();
    const predecessor = artifact({ id: 'pipeline-handoff:race:aaaaaaaa' });
    store.storePipelineHandoffArtifact({
      workContextId: 'wc:canonical-race',
      artifact: predecessor,
    });
    const successor = appendedArtifact(
      predecessor,
      'pipeline-handoff:race:bbbbbbbb'
    );
    const worker = new Worker(
      `
        const { parentPort, workerData } = require('node:worker_threads');
        const Database = require(workerData.betterSqlitePath);
        const db = new Database(workerData.dbPath);
        db.pragma('busy_timeout = 5000');
        db.exec('BEGIN IMMEDIATE');
        parentPort.postMessage('locked');
        setTimeout(() => {
          db.prepare(\`
            INSERT INTO work_context_artifacts (
              id, work_context_id, project_id, task_ref_kind, task_ref_id,
              stage, provenance_actor_id, kind, title, summary, visibility,
              created_at, updated_at, captured_at, payload_kind,
              payload_media_type, payload_path, payload_sha256, payload_bytes,
              pr_number, head_sha, base_name, branch_name,
              supersedes_artifact_id, metadata_json
            )
            SELECT ?, work_context_id, project_id, task_ref_kind, task_ref_id,
              stage, provenance_actor_id, kind, title, summary, visibility,
              created_at, updated_at, captured_at, payload_kind,
              payload_media_type, payload_path, payload_sha256, payload_bytes,
              pr_number, head_sha, base_name, branch_name, ?, metadata_json
            FROM work_context_artifacts WHERE id = ?
          \`).run(workerData.childId, workerData.predecessorId, workerData.predecessorId);
          db.exec('COMMIT');
          db.close();
          parentPort.postMessage('committed');
        }, 100);
      `,
      {
        eval: true,
        workerData: {
          betterSqlitePath: createRequire(import.meta.url).resolve(
            'better-sqlite3'
          ),
          dbPath: path.join(root, 'index.db'),
          predecessorId: predecessor.id,
          childId: 'pipeline-handoff:race:worker-child',
        },
      }
    );
    cleanup.push(() => void worker.terminate());
    const message = (expected: string) =>
      new Promise<void>((resolve, reject) => {
        const onMessage = (value: unknown) => {
          if (value !== expected) return;
          worker.off('error', reject);
          resolve();
        };
        worker.once('error', reject);
        worker.on('message', onMessage);
      });
    await message('locked');
    const committed = message('committed');

    expectStoreErrorCode(
      () =>
        store.storePipelineHandoffArtifact({
          workContextId: 'wc:canonical-race',
          artifact: successor,
        }),
      'artifact_supersedes_fork'
    );
    await committed;

    const db = new Database(path.join(root, 'index.db'), { readonly: true });
    const children = db
      .prepare(
        'SELECT id FROM work_context_artifacts WHERE supersedes_artifact_id = ?'
      )
      .all(predecessor.id) as Array<{ id: string }>;
    db.close();
    expect(children.map((row) => row.id)).toEqual([
      'pipeline-handoff:race:worker-child',
    ]);
  });

  it('rejects a pipeline predecessor that names another artifact payload kind', () => {
    const { store } = tmpStore();
    const view = store.storeAgentViewArtifact({
      workContextId: 'wc:canonical-kind',
      viewArtifact: viewArtifact(),
    });
    const predecessor = artifact({ id: view.metadata.id });
    const successor = appendedArtifact(
      predecessor,
      'pipeline-handoff:canonical-kind:bbbbbbbb'
    );

    expectStoreErrorCode(
      () =>
        store.storePipelineHandoffArtifact({
          workContextId: 'wc:canonical-kind',
          artifact: successor,
        }),
      'superseded_artifact_payload_kind_mismatch'
    );
  });

  it('rejects invalid handoff payloads before indexing metadata', () => {
    const { store } = tmpStore();
    const unsafe = {
      ...artifact(),
      stages: [
        {
          ...artifact().stages[0],
          rawTranscript: 'nope',
        },
      ],
    };

    try {
      store.storePipelineHandoffArtifact({
        workContextId: 'wc:rejects-raw',
        artifact: unsafe as PipelineHandoffArtifact,
      });
      throw new Error('store unexpectedly accepted raw transcript payload');
    } catch (err) {
      expect(err).toBeInstanceOf(WorkContextArtifactStoreError);
      expect((err as WorkContextArtifactStoreError).code).toBe(
        'invalid_pipeline_handoff_artifact'
      );
    }
    expect(store.list({ workContextId: 'wc:rejects-raw' })).toHaveLength(0);
  });

  it('returns public summaries without local paths, private task refs, or payload file paths', () => {
    const { store } = tmpStore();
    const stored = store.storePipelineHandoffArtifact({
      workContextId: 'wc:public-copy',
      visibility: 'public',
      artifact: artifact(),
    });

    const publicCopy = store.publicSummary(stored.metadata.id);
    const publicPayload = publicCopy?.payload as
      | PipelineHandoffArtifact
      | undefined;
    expect(publicCopy?.metadata).not.toHaveProperty('payloadPath');
    expect(publicCopy?.metadata.taskRef).toMatchObject({
      kind: 'github-issue',
      id: '42',
    });
    expect(publicPayload?.scope.taskRefs).toEqual([
      {
        kind: 'github-issue',
        id: '42',
        url: 'https://github.com/example-org/example-project/issues/42',
      },
    ]);
    expect(publicPayload?.stages[0]?.actorId).toBe('agent');
    expect(publicPayload?.stages[0]?.summary).toContain(
      '[redacted-local-path]'
    );
    expect(
      publicPayload?.scope.nonGoals.some((item) =>
        /kanban|dispatcher|worktree/i.test(item)
      )
    ).toBe(false);
    expect(
      validatePublicPipelineHandoffArtifact(
        publicPayload as PipelineHandoffArtifact
      ).valid
    ).toBe(true);
  });

  it('keeps structured review identity bindings valid in public summaries', () => {
    const { store } = tmpStore();
    const stored = store.storePipelineHandoffArtifact({
      workContextId: 'wc:structured-public-copy',
      visibility: 'public',
      artifact: structuredReviewArtifact(),
    });

    const publicCopy = store.publicSummary(stored.metadata.id);
    const payload = publicCopy?.payload as PipelineHandoffArtifact;
    expect(validatePublicPipelineHandoffArtifact(payload).errors).toEqual([]);
    const review = payload.stages[2] as Extract<
      PipelineHandoffArtifact['stages'][number],
      { stage: 'review' }
    >;
    expect(review.adversarialReview?.implementation.actorId).toBe(
      payload.stages[0]?.actorId
    );
    expect(review.adversarialReview?.reviewer.actorId).toBe(review.actorId);
    expect(review.actorId).not.toBe(payload.stages[0]?.actorId);
  });

  it('returns public summaries for agent view artifacts with sanitized manifest only', () => {
    const { store } = tmpStore();
    const pkg = viewArtifact({
      manifest: {
        ...viewArtifact().manifest,
        description:
          'Public view from /home/operator/relay with t_12345678 internal scratch id',
        export: { policy: 'public' },
        revision: { id: 'agent-view:example:public' },
      },
      files: {
        'index.html':
          '<main>raw html bytes mention /home/operator/relay and t_12345678</main>',
      },
    });
    const stored = store.storeAgentViewArtifact({
      workContextId: 'wc:view-public-copy',
      viewArtifact: pkg,
    });

    const publicCopy = store.publicSummary(stored.metadata.id);
    expect(publicCopy?.metadata.payloadKind).toBe('agent-view-artifact');
    expect(publicCopy?.payload).toMatchObject({
      manifest: {
        revision: { id: 'agent-view:example:public' },
        description: expect.stringContaining('[redacted-local-path]'),
      },
    });
    expect(JSON.stringify(publicCopy)).toContain('[redacted-kanban-task]');
    expect(JSON.stringify(publicCopy)).not.toContain('raw html bytes mention');
    expect(JSON.stringify(publicCopy)).not.toContain('files');
  });

  it('does not expose private artifacts through publicSummary', () => {
    const { store } = tmpStore();
    const stored = store.storePipelineHandoffArtifact({
      workContextId: 'wc:private-copy',
      visibility: 'private',
      artifact: artifact(),
    });

    expect(store.publicSummary(stored.metadata.id)).toBeNull();
  });

  it('verifies sha-addressed payload integrity when reading stored artifacts', () => {
    const { store } = tmpStore();
    const stored = store.storePipelineHandoffArtifact({
      workContextId: 'wc:tamper-proof',
      visibility: 'public',
      artifact: artifact(),
    });
    fs.writeFileSync(
      stored.payloadPath,
      JSON.stringify(
        artifact({
          id: 'pipeline-handoff:example:tampered',
          head: { ...artifact().head, headSha: nextHeadSha },
        }),
        null,
        2
      )
    );

    expect(() => store.read(stored.metadata.id)).toThrow(
      WorkContextArtifactStoreError
    );
    expect(() => store.publicSummary(stored.metadata.id)).toThrow(
      WorkContextArtifactStoreError
    );
  });

  it('rejects supersedes edges across WorkContexts', () => {
    const { store } = tmpStore();
    const first = store.storePipelineHandoffArtifact({
      workContextId: 'wc:a',
      artifact: artifact(),
    });

    expect(() =>
      store.storePipelineHandoffArtifact({
        workContextId: 'wc:b',
        artifact: artifact({
          id: 'pipeline-handoff:example:bbbbbbbb',
          head: { ...artifact().head, headSha: nextHeadSha },
        }),
        supersedesArtifactId: first.metadata.id,
      })
    ).toThrow(WorkContextArtifactStoreError);
    expect(
      store.list({ workContextId: 'wc:a' }).map((entry) => entry.metadata.id)
    ).toEqual([first.metadata.id]);
  });

  it('rejects loose timestamps and mismatched store ids', () => {
    const { store } = tmpStore();

    expect(() =>
      store.storePipelineHandoffArtifact({
        workContextId: 'wc:validation',
        capturedAt: '2026-06-08 12:00:00',
        artifact: artifact(),
      })
    ).toThrow(WorkContextArtifactStoreError);

    expect(() =>
      store.storePipelineHandoffArtifact({
        id: 'different-id',
        workContextId: 'wc:validation',
        artifact: artifact(),
      })
    ).toThrow(WorkContextArtifactStoreError);
  });
});
