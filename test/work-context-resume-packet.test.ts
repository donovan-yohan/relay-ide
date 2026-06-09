import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  buildWorkContextResumePacket,
  readWorkContextArtifactsForResume,
} from '../server/work-context-resume-packet.js';
import { createWorkContextArtifactStore } from '../server/work-context-artifacts.js';
import { createWorkContextStore } from '../server/work-contexts.js';
import {
  PIPELINE_HANDOFF_ARTIFACT_SCHEMA_VERSION,
  type PipelineHandoffArtifact,
  type PipelineHandoffStage,
} from '../shared/pipeline-handoff-artifact.js';
import {
  createWorkContextPrivacyMetadata,
  type ArtifactRef,
  type TaskRef,
} from '../shared/work-context.js';

const cleanup: Array<() => void> = [];
const now = '2026-06-09T10:00:00.000Z';
const currentHeadSha = 'c'.repeat(40);
const staleHeadSha = 'd'.repeat(40);

function tmpRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-resume-packet-'));
  cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

afterEach(() => {
  for (const dispose of cleanup.splice(0).reverse()) dispose();
});

const issueRef: TaskRef = {
  kind: 'github-issue',
  id: '891',
  title: 'WorkContext resume packet',
  url: 'https://github.com/donovan-yohan/relay-ide/issues/891',
};

function stage(input: Partial<PipelineHandoffStage> & Pick<PipelineHandoffStage, 'stage'>): PipelineHandoffStage {
  const base = {
    addedAt: now,
    actorId: 'agent:kani-backend',
    summary: `${input.stage} summary`,
    acceptanceEvidence: [
      {
        label: `${input.stage} evidence`,
        disposition: 'provided' as const,
        summary: `${input.stage} evidence provided`,
      },
    ],
    commands: [
      {
        label: `${input.stage} command`,
        command: 'npm test -- test/work-context-resume-packet.test.ts',
        status: 'passed' as const,
        summary: `${input.stage} command passed`,
        exitCode: 0,
      },
    ],
    downstreamFocus: [`continue after ${input.stage}`],
    nonGoals: ['no raw transcript ingestion'],
  };
  if (input.stage === 'implementation') {
    return {
      ...base,
      stage: 'implementation',
      decision: 'implemented',
      changedFiles: ['server/work-context-resume-packet.ts'],
      migrationOrStateRisk: 'new deterministic packet shape only',
      ...input,
    };
  }
  if (input.stage === 'qa') {
    return {
      ...base,
      stage: 'qa',
      verdict: 'passed',
      testedHeadSha: currentHeadSha,
      findings: [],
      ...input,
    };
  }
  if (input.stage === 'review') {
    return {
      ...base,
      stage: 'review',
      verdict: 'approved',
      reviewedHeadSha: currentHeadSha,
      blockers: [],
      nitsOrFollowUps: [],
      ...input,
    };
  }
  return {
    ...base,
    stage: 'release',
    verdict: 'released',
    target: 'nightly',
    verifiedHeadSha: currentHeadSha,
    ...input,
  };
}

function handoff(input: {
  id: string;
  headSha?: string;
  stages: PipelineHandoffStage[];
  taskRefs?: TaskRef[];
  summary?: string;
}): PipelineHandoffArtifact {
  const headSha = input.headSha ?? currentHeadSha;
  return {
    schemaVersion: PIPELINE_HANDOFF_ARTIFACT_SCHEMA_VERSION,
    id: input.id,
    title: `artifact ${input.id}`,
    createdAt: now,
    updatedAt: now,
    scope: {
      summary: input.summary ?? 'resume packet mission state',
      risk: 'medium',
      taskRefs: input.taskRefs ?? [issueRef],
      acceptance: ['deterministic bounded packet'],
      nonGoals: ['no raw logs by default', 'no raw transcripts by default'],
    },
    head: {
      repo: { ownerRepo: 'donovan-yohan/relay-ide' },
      base: { name: 'nightly' },
      branch: { name: 'issue-891-workcontext-resume-packet' },
      pr: {
        number: 901,
        url: 'https://github.com/donovan-yohan/relay-ide/pull/901',
      },
      headSha,
      staleIf: { headShaChanges: true },
      capturedAt: now,
    },
    stages: input.stages,
  };
}

function pinnedRef(id: string): ArtifactRef {
  return {
    id: `artifact:work-context-artifact:${id}`,
    kind: 'report',
    title: 'Pinned implementation handoff',
    uri: `relay://work-context-artifacts/${encodeURIComponent(id)}`,
    producedAt: now,
    summary: 'Pinned summary only; raw payload omitted.',
    privacy: createWorkContextPrivacyMetadata({
      classification: 'internal',
      retention: 'project',
      rawPayloadStored: false,
      redaction: { redacted: true, strategy: 'summary', classes: ['artifact'] },
    }),
  };
}

function stores() {
  const root = tmpRoot();
  const contextStore = createWorkContextStore(path.join(root, 'work-contexts.db'));
  const artifactStore = createWorkContextArtifactStore({
    dbPath: path.join(root, 'artifacts.db'),
    payloadRoot: path.join(root, 'payloads'),
  });
  cleanup.push(() => artifactStore.close());
  cleanup.push(() => contextStore.close());
  return { contextStore, artifactStore };
}

describe('WorkContext resume packet generator', () => {
  it('builds current evidence and pinned artifact summaries from deterministic stores', () => {
    const { contextStore, artifactStore } = stores();
    contextStore.create({ id: 'wc:resume', tasks: [issueRef] });
    const artifact = handoff({
      id: 'pipeline-handoff:current',
      stages: [stage({ stage: 'implementation' }), stage({ stage: 'qa' })],
    });
    artifactStore.storePipelineHandoffArtifact({
      workContextId: 'wc:resume',
      artifact,
      stage: 'qa',
      visibility: 'public',
    });
    contextStore.recordLifecycleEvent('wc:resume', {
      type: 'artifact.recorded',
      artifacts: [pinnedRef(artifact.id)],
      summary: 'Pinned current artifact',
    });

    const packet = buildWorkContextResumePacket({
      snapshot: contextStore.getResumeSnapshot('wc:resume', { sessions: [], nodes: [] }),
      artifactRecords: readWorkContextArtifactsForResume({
        store: artifactStore,
        workContextId: 'wc:resume',
        limit: 20,
      }),
      artifactStoreAvailable: true,
      options: { currentHeadSha },
      generatedAt: now,
    });

    expect(packet.goal.summary).toBe('resume packet mission state');
    expect(packet.nonGoals).toContain('no raw logs by default');
    expect(packet.pinnedArtifacts).toHaveLength(1);
    expect(packet.evidence.current.map((item) => item.stage)).toContain('qa');
    expect(packet.evidence.historical).toEqual([]);
    expect(packet.privacy.rawLogsIncluded).toBe(false);
    expect(packet.provenance.rawDbHistorySummarizedByLlm).toBe(false);
  });

  it('keeps stale-head evidence historical instead of current approval', () => {
    const { contextStore, artifactStore } = stores();
    contextStore.create({ id: 'wc:stale', tasks: [issueRef] });
    artifactStore.storePipelineHandoffArtifact({
      workContextId: 'wc:stale',
      artifact: handoff({
        id: 'pipeline-handoff:stale-review',
        headSha: staleHeadSha,
        stages: [
          stage({ stage: 'implementation' }),
          stage({ stage: 'review', reviewedHeadSha: staleHeadSha }),
        ],
      }),
      stage: 'review',
    });

    const packet = buildWorkContextResumePacket({
      snapshot: contextStore.getResumeSnapshot('wc:stale', { sessions: [], nodes: [] }),
      artifactRecords: readWorkContextArtifactsForResume({
        store: artifactStore,
        workContextId: 'wc:stale',
        limit: 20,
      }),
      artifactStoreAvailable: true,
      options: { currentHeadSha },
      generatedAt: now,
    });

    expect(packet.evidence.current).toEqual([]);
    expect(packet.evidence.historical.map((item) => item.stage)).toContain('review');
    expect(packet.evidence.historical.every((item) => item.stale)).toBe(true);
    expect(packet.suggestedNextAction.kind).toBe('resolve-blockers');
  });

  it('reports missing current evidence for task refs without artifacts', () => {
    const { contextStore } = stores();
    contextStore.create({ id: 'wc:missing', tasks: [issueRef] });

    const packet = buildWorkContextResumePacket({
      snapshot: contextStore.getResumeSnapshot('wc:missing', { sessions: [], nodes: [] }),
      artifactRecords: [],
      artifactStoreAvailable: false,
      options: { currentHeadSha },
      generatedAt: now,
    });

    expect(packet.evidence.missing[0]?.source).toBe('missing-current-evidence');
    expect(packet.suggestedNextAction.kind).toBe('resolve-blockers');
  });

  it('surfaces blocked gate evidence and unresolved decisions', () => {
    const { contextStore, artifactStore } = stores();
    contextStore.create({ id: 'wc:blocked', tasks: [issueRef] });
    artifactStore.storePipelineHandoffArtifact({
      workContextId: 'wc:blocked',
      artifact: handoff({
        id: 'pipeline-handoff:blocked',
        stages: [
          stage({ stage: 'implementation' }),
          stage({
            stage: 'qa',
            verdict: 'blocked',
            acceptanceEvidence: [
              {
                label: 'manual QA',
                disposition: 'skipped-blocked',
                summary: 'hub credentials unavailable',
                reason: 'missing scoped hub credential',
              },
            ],
          }),
        ],
      }),
      stage: 'qa',
    });

    const packet = buildWorkContextResumePacket({
      snapshot: contextStore.getResumeSnapshot('wc:blocked', { sessions: [], nodes: [] }),
      artifactRecords: readWorkContextArtifactsForResume({
        store: artifactStore,
        workContextId: 'wc:blocked',
        limit: 20,
      }),
      artifactStoreAvailable: true,
      options: { currentHeadSha },
      generatedAt: now,
    });

    expect(packet.blockers.open.some((item) => item.summary.includes('blocked'))).toBe(true);
    expect(packet.blockers.unresolvedDecisions[0]).toContain('qa decision blocked');
  });

  it('bounds packet output deterministically under many artifacts', () => {
    const { contextStore, artifactStore } = stores();
    contextStore.create({ id: 'wc:bounded', tasks: [issueRef] });
    for (let index = 0; index < 40; index += 1) {
      artifactStore.storePipelineHandoffArtifact({
        workContextId: 'wc:bounded',
        artifact: handoff({
          id: `pipeline-handoff:bounded-${index}`,
          stages: [stage({ stage: 'implementation', summary: `implementation ${index}` })],
        }),
        stage: 'implementation',
      });
    }

    const first = buildWorkContextResumePacket({
      snapshot: contextStore.getResumeSnapshot('wc:bounded', { sessions: [], nodes: [] }),
      artifactRecords: readWorkContextArtifactsForResume({
        store: artifactStore,
        workContextId: 'wc:bounded',
        limit: 200,
      }),
      artifactStoreAvailable: true,
      options: { currentHeadSha, maxArtifacts: 5, maxAuditRefs: 5, maxChars: 4_000 },
      generatedAt: now,
    });
    const second = buildWorkContextResumePacket({
      snapshot: contextStore.getResumeSnapshot('wc:bounded', { sessions: [], nodes: [] }),
      artifactRecords: readWorkContextArtifactsForResume({
        store: artifactStore,
        workContextId: 'wc:bounded',
        limit: 200,
      }),
      artifactStoreAvailable: true,
      options: { currentHeadSha, maxArtifacts: 5, maxAuditRefs: 5, maxChars: 4_000 },
      generatedAt: now,
    });

    expect(first.evidence.current.length).toBeLessThanOrEqual(5);
    expect(first.limits.approximateChars).toBeLessThanOrEqual(4_000);
    expect(first).toEqual(second);
  });

  it('does not count stale blocked evidence when current-head evidence passes', () => {
    const { contextStore, artifactStore } = stores();
    contextStore.create({ id: 'wc:stale-blocked-current-pass', tasks: [issueRef] });
    artifactStore.storePipelineHandoffArtifact({
      workContextId: 'wc:stale-blocked-current-pass',
      artifact: handoff({
        id: 'pipeline-handoff:stale-blocked',
        headSha: staleHeadSha,
        stages: [
          stage({ stage: 'implementation' }),
          stage({ stage: 'qa', verdict: 'blocked', testedHeadSha: staleHeadSha }),
        ],
      }),
      stage: 'qa',
    });
    artifactStore.storePipelineHandoffArtifact({
      workContextId: 'wc:stale-blocked-current-pass',
      artifact: handoff({
        id: 'pipeline-handoff:current-pass',
        stages: [
          stage({ stage: 'implementation' }),
          stage({ stage: 'qa', verdict: 'passed', testedHeadSha: currentHeadSha }),
        ],
      }),
      stage: 'qa',
    });

    const packet = buildWorkContextResumePacket({
      snapshot: contextStore.getResumeSnapshot('wc:stale-blocked-current-pass', { sessions: [], nodes: [] }),
      artifactRecords: readWorkContextArtifactsForResume({
        store: artifactStore,
        workContextId: 'wc:stale-blocked-current-pass',
        limit: 20,
      }),
      artifactStoreAvailable: true,
      options: { currentHeadSha },
      generatedAt: now,
    });

    expect(packet.evidence.current.some((item) => item.status === 'passed')).toBe(true);
    expect(packet.evidence.historical.some((item) => item.status === 'blocked')).toBe(true);
    expect(packet.blockers.open).toEqual([]);
    expect(packet.blockers.unresolvedDecisions).toEqual([]);
  });

  it('redacts public-safe workContext, session, and task refs', () => {
    const { contextStore } = stores();
    contextStore.create({ id: 'wc:public', tasks: [issueRef] });
    const snapshot = contextStore.getResumeSnapshot('wc:public', { sessions: [], nodes: [] });
    const packet = buildWorkContextResumePacket({
      snapshot: {
        ...snapshot,
        workContext: {
          ...snapshot.workContext,
          title: 'handoff t_deadbeef from /home/donovan/private',
          anchors: {
            session: {
              nodeId: 'local',
              sessionId: 'sess-secret',
              tabKind: 'agent',
              cwd: '/home/donovan/private/repo',
              agent: 'claude',
            },
            repo: { localPath: '/home/donovan/private/repo' },
            worktree: { localPath: '/home/donovan/private/repo/.worktrees/x' },
          },
          actors: [{ kind: 'agent', id: 'agent:kani-backend' }],
          tasks: [issueRef, { kind: 'kanban-task', id: 't_deadbeef', title: '/home/private task' }],
        },
        artifacts: [pinnedRef('t_deadbeef')],
        sessions: [
          {
            id: 'sess-secret',
            nodeId: 'local',
            tabKind: 'agent',
            agent: 'claude',
            cwd: '/home/donovan/private/repo',
            repoPath: '/home/donovan/private/repo',
            worktreePath: '/home/donovan/private/repo/.worktrees/x',
            displayName: 'session /home/donovan/private t_deadbeef',
            relationship: 'anchor',
            associatedAt: now,
            live: true,
          },
        ],
      },
      artifactRecords: [],
      options: { publicSafe: true, currentHeadSha },
      generatedAt: now,
    });

    const json = JSON.stringify(packet);
    expect(packet.workContext.anchors).toEqual({});
    expect(packet.workContext.actors).toEqual([]);
    expect(packet.workContext.tasks).toEqual([issueRef]);
    expect(json).not.toContain('/home/donovan');
    expect(json).not.toContain('t_deadbeef');
    expect(json).not.toContain('sess-secret');
    expect(json).not.toContain('repoPath');
    expect(json).toContain('[redacted-local-path]');
  });

  it('hard-enforces maxChars with oversized summaries and session fields', () => {
    const { contextStore, artifactStore } = stores();
    const oversized = 'x'.repeat(20_000);
    contextStore.create({ id: 'wc:oversized', title: oversized, tasks: [issueRef] });
    artifactStore.storePipelineHandoffArtifact({
      workContextId: 'wc:oversized',
      artifact: handoff({
        id: 'pipeline-handoff:oversized',
        summary: oversized,
        stages: [
          stage({
            stage: 'implementation',
            summary: oversized,
            downstreamFocus: [oversized],
            commands: [{ label: oversized, command: oversized, status: 'passed', summary: oversized }],
          }),
        ],
      }),
      stage: 'implementation',
    });
    const snapshot = contextStore.getResumeSnapshot('wc:oversized', { sessions: [], nodes: [] });
    const packet = buildWorkContextResumePacket({
      snapshot: {
        ...snapshot,
        sessions: [
          {
            id: 'session-oversized',
            nodeId: 'local',
            tabKind: 'agent',
            cwd: `/home/donovan/${oversized}`,
            displayName: oversized,
            relationship: oversized,
            associatedAt: now,
            live: true,
          },
        ],
      },
      artifactRecords: readWorkContextArtifactsForResume({
        store: artifactStore,
        workContextId: 'wc:oversized',
        limit: 20,
      }),
      artifactStoreAvailable: true,
      options: { currentHeadSha, maxChars: 4_000 },
      generatedAt: now,
    });

    expect(JSON.stringify(packet).length).toBeLessThanOrEqual(4_000);
    expect(packet.limits.approximateChars).toBeLessThanOrEqual(4_000);
    expect(packet.limits.truncated).toBe(true);
  });
});
