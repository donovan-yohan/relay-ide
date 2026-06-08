import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

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
} from '../shared/pipeline-handoff-artifact.js';

const now = '2026-06-08T12:00:00.000Z';
const headSha = 'a'.repeat(40);
const nextHeadSha = 'b'.repeat(40);

const cleanup: Array<() => void> = [];

function tmpStore(): { root: string; store: WorkContextArtifactStore } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'work-context-artifacts-'));
  cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = createWorkContextArtifactStore({
    dbPath: path.join(root, 'index.db'),
    payloadRoot: path.join(root, 'payloads'),
  });
  cleanup.push(() => store.close());
  return { root, store };
}

afterEach(() => {
  for (const dispose of cleanup.splice(0).reverse()) dispose();
});

function artifact(input: Partial<PipelineHandoffArtifact> = {}): PipelineHandoffArtifact {
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
      nonGoals: ['no raw transcript ingestion', 'no internal dispatcher or local worktree public copy'],
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
        summary: 'stored payload file from /home/operator/example while keeping index metadata bounded',
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
        downstreamFocus: ['verify append-only metadata and public sanitizer boundaries'],
        nonGoals: ['no UI or resume-packet integration in this slice'],
        decision: 'implemented',
        changedFiles: ['server/work-context-artifacts.ts'],
        migrationOrStateRisk: 'new isolated SQLite index and payload directory only',
      },
    ],
    ...input,
  };
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
    expect(stored.payloadPath.startsWith(path.join(root, 'payloads'))).toBe(true);
    expect(fs.existsSync(stored.payloadPath)).toBe(true);

    const byContext = store.list({ workContextId: 'wc:example' });
    expect(byContext).toHaveLength(1);
    expect(byContext[0]?.metadata.payloadSha256).toBe(stored.metadata.payloadSha256);

    const byTask = store.list({ taskRef: { kind: 'github-issue', id: '42' } });
    expect(byTask.map((entry) => entry.metadata.id)).toEqual([
      'pipeline-handoff:example:aaaaaaaa',
    ]);

    const read = store.read(stored.metadata.id);
    expect(read?.payload?.title).toBe('Example Project implementation handoff');
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
    expect(() => store.read(stored.metadata.id)).toThrow(SyntaxError);
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

    const replacementArtifact = artifact({
      id: 'pipeline-handoff:example:bbbbbbbb',
      updatedAt: '2026-06-08T12:10:00.000Z',
      head: {
        ...artifact().head,
        headSha: nextHeadSha,
        capturedAt: '2026-06-08T12:10:00.000Z',
      },
    });
    const replacement = store.storePipelineHandoffArtifact({
      workContextId: 'wc:append-only',
      artifact: replacementArtifact,
      supersedesArtifactId: first.metadata.id,
    });

    expect(replacement.metadata.supersedesArtifactId).toBe(first.metadata.id);
    expect(store.get(first.metadata.id)?.metadata.headSha).toBe(headSha);
    expect(store.list({ workContextId: 'wc:append-only' }).map((entry) => entry.metadata.id)).toEqual([
      replacement.metadata.id,
    ]);
    expect(
      store
        .list({ workContextId: 'wc:append-only', includeSuperseded: true })
        .map((entry) => entry.metadata.id)
        .sort()
    ).toEqual([first.metadata.id, replacement.metadata.id].sort());
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
    expect(publicCopy?.metadata).not.toHaveProperty('payloadPath');
    expect(publicCopy?.metadata.taskRef).toMatchObject({
      kind: 'github-issue',
      id: '42',
    });
    expect(publicCopy?.payload?.scope.taskRefs).toEqual([
      {
        kind: 'github-issue',
        id: '42',
        url: 'https://github.com/example-org/example-project/issues/42',
      },
    ]);
    expect(publicCopy?.payload?.stages[0]?.actorId).toBe('agent');
    expect(publicCopy?.payload?.stages[0]?.summary).toContain('[redacted-local-path]');
    expect(
      publicCopy?.payload?.scope.nonGoals.some((item) => /kanban|dispatcher|worktree/i.test(item))
    ).toBe(false);
    expect(validatePublicPipelineHandoffArtifact(publicCopy?.payload as PipelineHandoffArtifact).valid).toBe(true);
  });
});
