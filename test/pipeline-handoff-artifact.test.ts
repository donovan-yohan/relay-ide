import { describe, expect, it } from 'vitest';

import {
  PIPELINE_HANDOFF_ARTIFACT_SCHEMA_VERSION,
  PIPELINE_HANDOFF_COMMAND_STATUSES,
  PIPELINE_HANDOFF_EVIDENCE_DISPOSITIONS,
  isPipelineHandoffArtifact,
  isPipelineHandoffArtifactStale,
  renderPipelineHandoffMarkdown,
  sanitizePipelineHandoffArtifactForPublic,
  validatePipelineHandoffArtifact,
  validatePublicPipelineHandoffArtifact,
  type PipelineHandoffArtifact,
  type PipelineHandoffImplementationStage,
  type PipelineHandoffQaStage,
  type PipelineHandoffReleaseStage,
  type PipelineHandoffReviewStage,
  type PipelineHandoffStage,
} from '../shared/pipeline-handoff-artifact.js';

const now = '2026-06-08T01:02:03Z';
const headSha = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const nextHeadSha = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

function evidence(
  disposition: PipelineHandoffStage['acceptanceEvidence'][number]['disposition'] =
    'provided'
): PipelineHandoffStage['acceptanceEvidence'][number] {
  return {
    label: 'acceptance evidence',
    disposition,
    summary: disposition === 'provided' ? 'bounded proof ref recorded' : 'not run',
    ...(disposition === 'provided'
      ? {}
      : { reason: `${disposition} is machine-readable` }),
  };
}

function command(
  status: PipelineHandoffStage['commands'][number]['status'] = 'passed'
): PipelineHandoffStage['commands'][number] {
  return {
    label: 'targeted tests',
    command: 'npm test -- test/pipeline-handoff-artifact.test.ts',
    status,
    summary: status === 'passed' ? 'passed' : 'not run',
    ...(status === 'passed' ? { exitCode: 0 } : { reason: `${status} reason` }),
  };
}

function implementationStage(): PipelineHandoffImplementationStage {
  return {
    stage: 'implementation',
    addedAt: now,
    actorId: 'agent:kani-backend',
    summary: 'implemented the shared schema foundation',
    acceptanceEvidence: [evidence()],
    commands: [command()],
    downstreamFocus: ['verify schema fields and public redaction'],
    nonGoals: ['no workflow engine'],
    decision: 'implemented',
    changedFiles: ['shared/pipeline-handoff-artifact.ts'],
    migrationOrStateRisk: 'none',
  };
}

function qaStage(): PipelineHandoffQaStage {
  return {
    stage: 'qa',
    addedAt: now,
    actorId: 'agent:kame-qa',
    summary: 'QA passed exact head',
    acceptanceEvidence: [evidence('not-applicable')],
    commands: [command('skipped-time')],
    downstreamFocus: ['review exact head SHA'],
    nonGoals: ['no release approval'],
    verdict: 'passed',
    testedHeadSha: headSha,
    findings: [],
  };
}

function reviewStage(): PipelineHandoffReviewStage {
  return {
    stage: 'review',
    addedAt: now,
    actorId: 'agent:fugu-reviewer',
    summary: 'review approved exact head',
    acceptanceEvidence: [evidence('skipped-blocked')],
    commands: [command('skipped-blocked')],
    downstreamFocus: ['release should verify checks and head'],
    nonGoals: ['no auto-merge by reviewer'],
    verdict: 'approved',
    reviewedHeadSha: headSha,
    blockers: [],
    nitsOrFollowUps: ['consider API integration follow-up'],
  };
}

function releaseStage(): PipelineHandoffReleaseStage {
  return {
    stage: 'release',
    addedAt: now,
    actorId: 'agent:kujira-ops',
    summary: 'release deferred pending CI',
    acceptanceEvidence: [evidence('skipped-deferred')],
    commands: [command('skipped-deferred')],
    downstreamFocus: ['merge only this exact head after checks'],
    nonGoals: ['no release auto-approval'],
    verdict: 'deferred',
    target: 'nightly',
    verifiedHeadSha: headSha,
  };
}

function baseArtifact(stages: PipelineHandoffStage[] = [implementationStage()]): PipelineHandoffArtifact {
  return {
    schemaVersion: PIPELINE_HANDOFF_ARTIFACT_SCHEMA_VERSION,
    id: 'pipeline-handoff:883:aaaaaaaa',
    title: 'Define pipeline handoff artifact schema and templates',
    createdAt: now,
    updatedAt: now,
    scope: {
      summary: 'shared/backend schema plus markdown/JSON template foundation',
      risk: 'low',
      taskRefs: [
        {
          kind: 'github-issue',
          id: '883',
          url: 'https://github.com/donovan-yohan/relay-ide/issues/883',
        },
        {
          kind: 'kanban-task',
          id: 't_93c3c750',
          status: 'running',
        },
      ],
      acceptance: [
        'stage-required implementation/QA/review/release fields exist',
        'exact headSha freshness is machine-readable',
      ],
      nonGoals: ['no workflow engine', 'no GitHub/Kanban state replacement'],
    },
    head: {
      repo: { ownerRepo: 'donovan-yohan/relay-ide' },
      base: { name: 'nightly' },
      branch: { name: 'issue-883-handoff-schema' },
      pr: { number: 883, url: 'https://github.com/donovan-yohan/relay-ide/pull/883' },
      headSha,
      staleIf: { headShaChanges: true },
      capturedAt: now,
    },
    stages,
  };
}

function fullStageArtifact(): PipelineHandoffArtifact {
  return baseArtifact([implementationStage(), qaStage(), reviewStage(), releaseStage()]);
}

describe('PipelineHandoffArtifact schema', () => {
  it('validates append-only implementation/QA/review/release stage layers', () => {
    const artifact = fullStageArtifact();
    const result = validatePipelineHandoffArtifact(artifact);

    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
    expect(isPipelineHandoffArtifact(artifact)).toBe(true);
    expect(PIPELINE_HANDOFF_EVIDENCE_DISPOSITIONS).toEqual([
      'provided',
      'not-applicable',
      'skipped-time',
      'skipped-blocked',
      'skipped-deferred',
    ]);
    expect(PIPELINE_HANDOFF_COMMAND_STATUSES).toContain('not-applicable');
  });

  it('rejects non-append-only stage order and stale exact-head verdicts', () => {
    const artifact = baseArtifact([
      implementationStage(),
      {
        ...reviewStage(),
        reviewedHeadSha: nextHeadSha,
      },
      qaStage(),
    ]);

    const result = validatePipelineHandoffArtifact(artifact);

    expect(result.valid).toBe(false);
    expect(result.errors.join('\n')).toContain('reviewedHeadSha must equal artifact head.headSha');
    expect(result.errors.join('\n')).toContain('implementation -> QA -> review -> release order');
  });

  it('evaluates staleIf.headShaChanges by exact head SHA only', () => {
    const artifact = baseArtifact();

    expect(isPipelineHandoffArtifactStale(artifact, headSha)).toBe(false);
    expect(isPipelineHandoffArtifactStale(artifact, nextHeadSha)).toBe(true);
  });

  it('accepts a minimal low-risk implementation artifact', () => {
    const artifact = baseArtifact([
      {
        ...implementationStage(),
        decision: 'minimal-low-risk',
        changedFiles: ['docs/typo.md'],
        commands: [command('not-applicable')],
        migrationOrStateRisk: 'none; docs-only typo-level change',
      },
    ]);

    const result = validatePipelineHandoffArtifact(artifact);

    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it('rejects unsafe raw fields instead of storing transcripts/env/auth/logs', () => {
    const unsafe = {
      ...baseArtifact(),
      env: { OPENAI_API_KEY: 'sk-nope' },
      stages: [
        {
          ...implementationStage(),
          rawTranscript: 'full chat bytes, absolutely not',
        },
      ],
    };

    const result = validatePipelineHandoffArtifact(unsafe);

    expect(result.valid).toBe(false);
    expect(result.errors.join('\n')).toContain('$.env');
    expect(result.errors.join('\n')).toContain('$.stages[0].rawTranscript');
  });

  it('rejects Relay auth/grant/pair-token fields and token forms', () => {
    const unsafe = {
      ...baseArtifact(),
      relayGrantHandle: 'relay-grant-v1.secretmaterial',
      stages: [
        {
          ...implementationStage(),
          pairToken: 'pair_abcd1234',
          summary: 'minted pair_abcd1234 for local pairing',
        },
      ],
    };

    const schemaResult = validatePipelineHandoffArtifact(unsafe);
    const publicResult = validatePublicPipelineHandoffArtifact(unsafe as PipelineHandoffArtifact);

    expect(schemaResult.valid).toBe(false);
    expect(schemaResult.errors.join('\n')).toContain('$.relayGrantHandle');
    expect(schemaResult.errors.join('\n')).toContain('$.stages[0].pairToken');
    expect(publicResult.valid).toBe(false);
    expect(publicResult.errors.join('\n')).toContain('secret-looking text rejected');
    expect(publicResult.errors.join('\n')).not.toContain('pair_abcd1234');
  });

  it('requires exact sha256 artifact hashes and runtime ArtifactKind values', () => {
    const validHash = 'c'.repeat(64);
    const artifact = baseArtifact([
      {
        ...implementationStage(),
        acceptanceEvidence: [
          {
            ...evidence(),
            artifacts: [
              { id: 'diff-1', kind: 'diff', hashSha256: validHash },
              { id: 'report-1', kind: 'not-a-kind', hashSha256: 'd'.repeat(40) },
            ],
          },
        ],
      },
    ] as PipelineHandoffStage[]);

    const result = validatePipelineHandoffArtifact(artifact);

    expect(result.valid).toBe(false);
    expect(result.errors.join('\n')).toContain('kind must be a valid artifact kind');
    expect(result.errors.join('\n')).toContain('hashSha256 must be a 64-character sha256');
    expect(result.errors.join('\n')).not.toContain(validHash);
  });

  it('rejects Windows/UNC absolute paths in changedFiles', () => {
    const artifact = baseArtifact([
      {
        ...implementationStage(),
        changedFiles: ['C:\\Users\\donovan\\secret.txt', '\\\\server\\share\\secret.txt'],
      },
    ]);

    const result = validatePipelineHandoffArtifact(artifact);

    expect(result.valid).toBe(false);
    expect(result.errors.join('\n')).toContain('changedFiles must be relative');
    expect(result.errors.join('\n')).not.toContain('C:\\Users\\donovan');
    expect(result.errors.join('\n')).not.toContain('\\\\server\\share');
  });

  it('redacts/omits unsafe fields for public PR or issue handoff comments', () => {
    const artifact = baseArtifact([
      {
        ...implementationStage(),
        summary:
          'ran from /home/donovanyohan/private/worktree, C:\\Users\\donovan\\Relay, \\\\server\\share\\relay, t_93c3c750 with Bearer abcdefghijk and pair_abcd1234',
        commands: [
          {
            ...command(),
            command: 'cd /home/donovanyohan/private/worktree && npm test -- test/pipeline-handoff-artifact.test.ts',
          },
        ],
      },
    ]);

    const publicResult = validatePublicPipelineHandoffArtifact(artifact);
    expect(publicResult.valid).toBe(false);
    expect(publicResult.errors.join('\n')).toContain('local absolute path rejected');
    expect(publicResult.errors.join('\n')).toContain('private Kanban task id rejected');
    expect(publicResult.errors.join('\n')).toContain('secret-looking text rejected');
    expect(publicResult.errors.join('\n')).not.toContain('C:\\Users\\donovan');
    expect(publicResult.errors.join('\n')).not.toContain('\\\\server\\share');
    expect(publicResult.errors.join('\n')).not.toContain('t_93c3c750');
    expect(publicResult.errors.join('\n')).not.toContain('pair_abcd1234');

    const sanitized = sanitizePipelineHandoffArtifactForPublic(artifact);
    const publicMarkdown = renderPipelineHandoffMarkdown(artifact, { public: true });

    expect(sanitized.scope.taskRefs.map((taskRef) => taskRef.kind)).toEqual([
      'github-issue',
    ]);
    expect(validatePublicPipelineHandoffArtifact(sanitized).errors).toEqual([]);
    expect(publicMarkdown).not.toContain('/home/donovanyohan');
    expect(publicMarkdown).not.toContain('C:\\Users\\donovan');
    expect(publicMarkdown).not.toContain('\\\\server\\share');
    expect(publicMarkdown).not.toContain('t_93c3c750');
    expect(publicMarkdown).not.toContain('Bearer abcdefghijk');
    expect(publicMarkdown).not.toContain('pair_abcd1234');
    expect(publicMarkdown).toContain('[redacted-local-path]');
    expect(publicMarkdown).toContain('[redacted-kanban-task]');
    expect(publicMarkdown).toContain('[redacted-secret]');
  });
});
