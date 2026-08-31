import { describe, expect, it } from 'vitest';

import type { PipelineHandoffArtifact } from '../shared/pipeline-handoff-artifact.js';
import {
  formatDownstreamFocus,
  formatHandoffArtifactCopy,
  missingHandoffArtifactSummary,
  safeExternalUrl,
  summarizeHandoffArtifact,
  type PipelineHandoffArtifactEnvelope,
} from '../frontend/src/lib/pipeline-handoff-timeline.js';

const HEAD_A = '1111111111111111111111111111111111111111';
const HEAD_B = '2222222222222222222222222222222222222222';
const NOW = '2026-06-09T00:00:00.000Z';

function artifact(
  overrides: Partial<PipelineHandoffArtifact> = {}
): PipelineHandoffArtifact {
  return {
    schemaVersion: 1,
    id: 'pipeline-handoff:demo',
    title: 'handoff artifact timeline',
    createdAt: NOW,
    updatedAt: NOW,
    scope: {
      summary: 'show handoff state in WorkContext',
      risk: 'medium',
      taskRefs: [
        {
          kind: 'github-issue',
          id: '885',
          title: 'Show pipeline handoff artifact state',
          url: 'https://github.com/donovan-yohan/relay-ide/issues/885',
        },
      ],
      acceptance: ['timeline renders current/stale state'],
      nonGoals: ['raw logs'],
    },
    head: {
      repo: { ownerRepo: 'donovan-yohan/relay-ide' },
      base: { name: 'nightly' },
      branch: { name: 'issue-885-handoff-timeline' },
      pr: { number: 901, url: 'https://github.com/donovan-yohan/relay-ide/pull/901' },
      headSha: HEAD_A,
      staleIf: { headShaChanges: true },
      capturedAt: NOW,
    },
    stages: [
      {
        stage: 'implementation',
        addedAt: NOW,
        actorId: 'agent:ika-frontend',
        summary: 'implemented timeline UI',
        acceptanceEvidence: [
          { label: 'component', disposition: 'provided', summary: 'timeline card rendered' },
        ],
        commands: [
          { label: 'unit', command: 'npm test -- pipeline-handoff-timeline', status: 'passed', summary: 'passed' },
        ],
        downstreamFocus: ['qa stale-head indicator', 'review sanitized copy'],
        nonGoals: ['release decisions'],
        decision: 'implemented',
        changedFiles: ['frontend/src/workbench/blocks/work-context.tsx'],
        migrationOrStateRisk: 'read-only WorkContext artifact query',
      },
    ],
    ...overrides,
  };
}

function envelope(
  payload: PipelineHandoffArtifact,
  extra: Partial<PipelineHandoffArtifactEnvelope> = {}
): PipelineHandoffArtifactEnvelope {
  const taskRef = payload.scope.taskRefs[0];
  const stage = payload.stages.at(-1)?.stage;
  const prNumber = payload.head.pr?.number;
  const branchName = payload.head.branch?.name;
  return {
    metadata: {
      id: payload.id,
      workContextId: 'wc:885',
      ...(taskRef !== undefined ? { taskRef } : {}),
      ...(stage !== undefined ? { stage } : {}),
      kind: 'report',
      title: payload.title,
      summary: payload.scope.summary,
      visibility: 'public',
      capturedAt: payload.head.capturedAt,
      payloadKind: 'pipeline-handoff-artifact',
      payloadSha256: '0'.repeat(64),
      payloadBytes: 1234,
      ...(prNumber !== undefined ? { prNumber } : {}),
      headSha: payload.head.headSha,
      baseName: payload.head.base.name,
      ...(branchName !== undefined ? { branchName } : {}),
    },
    payload,
    ...extra,
  };
}

describe('pipeline handoff timeline summary', () => {
  it('summarizes current artifact stage, head, evidence, focus, and open URL', () => {
    const summary = summarizeHandoffArtifact(envelope(artifact()), HEAD_A);

    expect(summary.state).toBe('current');
    expect(summary.stageLabel).toBe('implementation');
    expect(summary.shortHeadSha).toBe('1111111');
    expect(summary.evidenceCount).toBe(2);
    expect(summary.verdict).toBe('implemented');
    expect(summary.downstreamFocus).toEqual(['qa stale-head indicator', 'review sanitized copy']);
    expect(summary.openUrl).toBe('https://github.com/donovan-yohan/relay-ide/issues/885');
    expect(summary.stages.map((stage) => [stage.stage, stage.status])).toEqual([
      ['implementation', 'present'],
      ['qa', 'missing'],
      ['review', 'missing'],
      ['release', 'missing'],
    ]);
  });

  it('reports missing artifact state without pretending approval exists', () => {
    const summary = missingHandoffArtifactSummary();

    expect(summary.state).toBe('missing');
    expect(summary.shortHeadSha).toBeNull();
    expect(summary.evidenceCount).toBe(0);
    expect(summary.verdict).toBe('missing');
    expect(summary.stages.every((stage) => stage.status === 'missing')).toBe(true);
  });

  it('marks artifacts stale when the lane head differs', () => {
    const summary = summarizeHandoffArtifact(envelope(artifact()), HEAD_B);

    expect(summary.state).toBe('stale');
    expect(summary.stateLabel).toBe('stale');
    expect(summary.shortHeadSha).toBe('1111111');
  });

  it('marks artifacts current when API staleness is exact-head clean', () => {
    const summary = summarizeHandoffArtifact(
      envelope(artifact(), {
        staleness: {
          stale: false,
          staleIf: { headShaChanges: true },
          artifactHeadSha: HEAD_A,
          currentHeadSha: HEAD_A,
        },
      })
    );

    expect(summary.state).toBe('current');
    expect(summary.stateLabel).toBe('current');
  });

  it('marks an isolated payload fetch failure as failed without losing metadata', () => {
    // exactOptionalPropertyTypes: omit `payload` entirely rather than set it to undefined.
    const { payload: _droppedPayload, ...metadataOnly } = envelope(artifact());
    const summary = summarizeHandoffArtifact(
      { ...metadataOnly, payloadError: 'HTTP 404' },
      HEAD_A
    );

    expect(summary.state).toBe('failed');
    expect(summary.stateLabel).toBe('failed');
    expect(summary.payloadError).toBe('HTTP 404');
    expect(summary.stageLabel).toBe('implementation');
  });

  it('filters unsafe open URLs and formats truncated downstream focus', () => {
    expect(safeExternalUrl('javascript:alert(1)')).toBeNull();
    expect(safeExternalUrl('http://example.test')).toBeNull();
    expect(safeExternalUrl('https://github.com/donovan-yohan/relay-ide')).toBe(
      'https://github.com/donovan-yohan/relay-ide'
    );
    const unsafeTaskRef = artifact({
      scope: {
        ...artifact().scope,
        taskRefs: [
          {
            kind: 'github-issue',
            id: '885',
            url: 'javascript:alert(1)',
          },
        ],
      },
    });
    expect(summarizeHandoffArtifact(envelope(unsafeTaskRef), HEAD_A).openUrl).toBe(
      'https://github.com/donovan-yohan/relay-ide/pull/901'
    );
    expect(formatDownstreamFocus(['qa', 'review', 'release'])).toBe('qa · review · +1');
  });

  it('surfaces failed or blocking downstream verdicts', () => {
    const failed = artifact({
      stages: [
        ...artifact().stages,
        {
          stage: 'qa',
          addedAt: NOW,
          actorId: 'agent:kame-qa',
          summary: 'blocked stale evidence copy',
          acceptanceEvidence: [
            { label: 'browser', disposition: 'provided', summary: 'stale pill visible' },
          ],
          commands: [],
          downstreamFocus: ['fix stale status copy'],
          nonGoals: [],
          verdict: 'failed',
          testedHeadSha: HEAD_A,
          findings: ['stale evidence was styled as approved'],
        },
      ],
    });

    const summary = summarizeHandoffArtifact(envelope(failed), HEAD_A);

    expect(summary.stageLabel).toBe('qa');
    expect(summary.verdict).toBe('failed');
    expect(summary.downstreamFocus).toEqual(['fix stale status copy']);
  });

  it('formats only the sanitized public copy envelope supplied by the API', () => {
    const text = formatHandoffArtifactCopy({
      metadata: {
        id: 'pipeline-handoff:public',
        workContextId: 'wc:public',
        kind: 'report',
        title: 'public handoff summary',
        summary: 'sanitized; raw logs unavailable',
        visibility: 'public',
        capturedAt: NOW,
        payloadKind: 'pipeline-handoff-artifact',
        payloadSha256: 'a'.repeat(64),
        payloadBytes: 456,
        headSha: HEAD_A,
      },
    });

    expect(text).toContain('public handoff summary');
    expect(text).not.toContain('/home/');
    expect(text).not.toContain('t_86f5a998');
    expect(text).not.toContain('secret');
  });
});
