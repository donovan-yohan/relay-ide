import { describe, expect, it } from 'vitest';

import {
  generateHandoffBrief,
  isAgentResumeBundle,
  isAgentStateExportPlan,
  isHarnessDescriptor,
  isResumeExcludeClass,
  RESUME_EXCLUDE_CLASSES,
  RESUME_MODES,
  type DestinationReadinessSignal,
  type HarnessDescriptor,
  type SafeExcludeMetadata,
} from '../shared/agent-continuation.js';
import { HANDOFF_SCHEMA_VERSION } from '../shared/handoff.js';
import { DEFAULT_LOCAL_NODE_ID } from '../shared/identity.js';
import {
  createWorkContextPrivacyMetadata,
  WORK_CONTEXT_SCHEMA_VERSION,
  type WorkContext,
} from '../shared/work-context.js';

const now = '2026-05-21T12:00:00.000Z';
const workContextId = 'wc:continuation:686';
const sourceNodeId = DEFAULT_LOCAL_NODE_ID;
const destinationNodeId = 'devbox-1';
const sourceCwd = '/repos/relay-ide/.worktrees/686-agent-continuation';
const destinationCwd = '/srv/relay-ide/.worktrees/686-agent-continuation';
const manifestHash = 'd'.repeat(64);

const privacy = createWorkContextPrivacyMetadata({
  classification: 'internal',
  retention: 'project',
  rawPayloadStored: false,
});

function baseWorkContext(): WorkContext {
  return {
    schemaVersion: WORK_CONTEXT_SCHEMA_VERSION,
    id: workContextId,
    title: 'Implement #686 agent continuation bundle',
    createdAt: now,
    updatedAt: now,
    source: 'kanban',
    anchors: {
      node: {
        nodeId: sourceNodeId,
        kind: 'local',
        displayName: 'macbook',
        online: true,
      },
      session: {
        nodeId: sourceNodeId,
        sessionId: 'session-source-1',
        globalSessionId: 'global-session-source-1',
        tabKind: 'agent',
        cwd: sourceCwd,
        controlMode: 'agent-driven',
      },
      repo: {
        repoIdentity: 'github.com/donovan-yohan/relay-ide',
        ownerRepo: 'donovan-yohan/relay-ide',
        remoteUrl: 'git@github.com:donovan-yohan/relay-ide.git',
        localPath: '/repos/relay-ide',
        branchName: 'feat/686-agent-continuation',
      },
      worktree: {
        localPath: sourceCwd,
        branchName: 'feat/686-agent-continuation',
      },
    },
    actors: [
      {
        kind: 'agent',
        id: 'kani-backend',
        displayName: 'Kani Backend',
        providerId: 'hermes',
        nodeId: sourceNodeId,
        sessionId: 'session-source-1',
      },
    ],
    tasks: [
      {
        kind: 'github-issue',
        id: '686',
        title: 'Handoff: agent continuation schema and handoff brief generator',
        url: 'https://github.com/donovan-yohan/relay-ide/issues/686',
        status: 'in-progress',
      },
      {
        kind: 'kanban-task',
        id: 't_ab15cda4',
        title: '#686 implement agent continuation bundle + handoff brief',
        status: 'running',
      },
    ],
    artifacts: [
      {
        id: 'artifact-summary-1',
        kind: 'report',
        title: 'bounded source summary',
        uri: 'relay://work-context/wc:continuation:686/artifacts/source-summary',
        summary:
          'Shared schema exists; implement continuation contract and tests.',
        producedByActorId: 'kani-backend',
        producedAt: now,
        privacy,
      },
      {
        id: 'artifact-test-report',
        kind: 'command-output-ref',
        title: 'targeted test output',
        uri: 'relay://work-context/wc:continuation:686/artifacts/test-output',
        summary: 'vitest handoff target should pass before PR',
        privacy,
      },
    ],
    auditRefs: [
      {
        id: 'audit-1',
        eventId: 'evt-1',
        type: 'handoff.summary.created',
        occurredAt: now,
        actorId: 'kani-backend',
        logRef: 'relay://audit/evt-1',
        privacy,
      },
    ],
    capabilityGrants: [],
    privacy,
  };
}

function readiness(ready = true): DestinationReadinessSignal[] {
  return [
    {
      kind: 'node-online',
      summary: 'destination node is online',
      ready,
    },
    {
      kind: 'runtime-auth-ready',
      summary: 'destination runtime auth is ready',
      ready,
    },
  ];
}

function harness(
  id: string,
  supportedResumeModes: HarnessDescriptor['supportedResumeModes']
): HarnessDescriptor {
  return {
    id,
    providerId: 'claude-code',
    displayName: 'Claude Code',
    supportedResumeModes,
    safeStateLocations: [
      {
        kind: 'bounded-summary-ref',
        ref: 'relay://work-context/wc:continuation:686/artifacts/source-summary',
        summary: 'bounded source summary ref',
        portable: true,
        includeByDefault: true,
        privacy,
      },
      {
        kind: 'native-session',
        ref: 'claude-session:43c3949b',
        summary: 'native session id only; no provider auth copied',
        portable: supportedResumeModes.includes('native-cross-node'),
        includeByDefault: true,
      },
    ],
    unsafeStateLocations: [
      {
        kind: 'provider-auth-store',
        ref: '~/.claude/auth.json',
        summary: 'provider auth store excluded from Relay continuation',
        portable: false,
        includeByDefault: false,
        exclude: {
          class: 'provider-auth',
          reason: 'provider auth is never copied by Relay handoff',
        },
      },
      {
        kind: 'raw-transcript',
        ref: '~/.claude/projects/session.jsonl',
        summary: 'raw transcript excluded; use bounded summary refs instead',
        portable: false,
        includeByDefault: false,
        exclude: {
          class: 'raw-transcript',
          reason: 'raw transcripts are unbounded and may contain secrets',
        },
      },
    ],
    nativeResumeCommand: {
      commandSummary: 'claude --resume <native-session-id>',
      argvPreview: ['claude', '--resume', '<native-session-id>'],
      requiresSameNode: !supportedResumeModes.includes('native-cross-node'),
      requiresAuth: true,
      requiredCapabilities: ['session:create:terminal'],
    },
    destinationReadiness: readiness(true),
  };
}

describe('agent continuation shared contract', () => {
  it('exports explicit resume modes and safe exclude classes', () => {
    expect(RESUME_MODES).toEqual([
      'summary-only',
      'native-same-node',
      'native-cross-node',
      'relay-managed-timeline',
    ]);
    expect(RESUME_EXCLUDE_CLASSES).toContain('provider-auth');
    expect(RESUME_EXCLUDE_CLASSES).toContain('profile-db');
    expect(RESUME_EXCLUDE_CLASSES).toContain('raw-transcript');
    expect(isResumeExcludeClass('env')).toBe(true);
    expect(isResumeExcludeClass('full-home-directory')).toBe(false);
  });

  it('falls back to summary-only when no native harness is available', () => {
    const bundle = generateHandoffBrief({
      id: 'resume-bundle-summary-only',
      createdAt: now,
      workContext: baseWorkContext(),
      destination: {
        nodeId: destinationNodeId,
        cwd: destinationCwd,
      },
      manifest: {
        hash: manifestHash,
        fileCount: 7,
      },
    });

    expect(bundle.schemaVersion).toBe(HANDOFF_SCHEMA_VERSION);
    expect(bundle.mode).toBe('summary-only');
    expect(bundle.confidence).toBe('low');
    expect(bundle.harness).toBeUndefined();
    expect(bundle.exportPlan.excludes.map((item) => item.class)).toEqual(
      expect.arrayContaining([
        'credential',
        'provider-auth',
        'profile-db',
        'raw-transcript',
        'env',
        'cache',
      ])
    );
    expect(isAgentResumeBundle(bundle)).toBe(true);
  });

  it('ignores native or relay requestedMode when no harness is present', () => {
    for (const requestedMode of [
      'native-same-node',
      'native-cross-node',
      'relay-managed-timeline',
    ] as const) {
      const bundle = generateHandoffBrief({
        id: `resume-bundle-requested-${requestedMode}-without-harness`,
        createdAt: now,
        workContext: baseWorkContext(),
        destination: {
          nodeId: destinationNodeId,
          cwd: destinationCwd,
        },
        requestedMode,
        readiness: readiness(true),
      });

      expect(bundle.mode).toBe('summary-only');
      expect(bundle.confidence).toBe('low');
      expect(bundle.harness).toBeUndefined();
      expect(bundle.instruction.provider).toBeUndefined();
      expect(bundle.exportPlan.nativeSessionRef).toBeUndefined();
      expect(isAgentResumeBundle(bundle)).toBe(true);
    }
  });

  it('accepts native same-node and native cross-node descriptors as schema data', () => {
    const sameNode = harness('claude-same-node', [
      'summary-only',
      'native-same-node',
    ]);
    const crossNode = harness('claude-cross-node', [
      'summary-only',
      'native-same-node',
      'native-cross-node',
    ]);

    expect(isHarnessDescriptor(sameNode)).toBe(true);
    expect(isHarnessDescriptor(crossNode)).toBe(true);
    expect(
      isHarnessDescriptor({
        ...sameNode,
        supportedResumeModes: ['live-process-migration'],
      })
    ).toBe(false);
  });

  it('rejects unsafe state locations unless they are explicitly excluded', () => {
    const descriptor = harness('claude-unsafe-state-validation', [
      'summary-only',
      'native-same-node',
    ]);

    expect(isHarnessDescriptor(descriptor)).toBe(true);
    expect(
      isHarnessDescriptor({
        ...descriptor,
        safeStateLocations: [
          ...descriptor.safeStateLocations,
          {
            kind: 'raw-transcript',
            ref: '~/.claude/projects/session.jsonl',
            summary: 'raw transcripts are unsafe even with exclude metadata',
            portable: false,
            includeByDefault: false,
            exclude: {
              class: 'raw-transcript',
              reason: 'raw transcripts are not safe state locations',
            },
          },
        ],
      })
    ).toBe(false);
    expect(
      isHarnessDescriptor({
        ...descriptor,
        unsafeStateLocations: [
          {
            kind: 'provider-auth-store',
            ref: '~/.claude/auth.json',
            summary:
              'provider auth should not be portable or copied by default',
            portable: true,
            includeByDefault: true,
          },
        ],
      })
    ).toBe(false);
    expect(
      isHarnessDescriptor({
        ...descriptor,
        unsafeStateLocations: [
          {
            kind: 'raw-transcript',
            ref: '~/.claude/projects/session.jsonl',
            summary: 'raw transcript without explicit exclude metadata',
            portable: false,
            includeByDefault: false,
          },
        ],
      })
    ).toBe(false);
    expect(
      isHarnessDescriptor({
        ...descriptor,
        unsafeStateLocations: [
          {
            kind: 'raw-transcript',
            ref: '~/.claude/projects/session.jsonl',
            summary: 'raw transcript with mismatched exclude class',
            portable: false,
            includeByDefault: false,
            exclude: {
              class: 'provider-auth',
              reason: 'wrong exclusion class for raw transcripts',
            },
          },
        ],
      })
    ).toBe(false);
  });

  it('rejects forbidden raw auth/profile/transcript keys anywhere in continuation shapes', () => {
    const plan = generateHandoffBrief({
      id: 'resume-bundle-forbidden',
      createdAt: now,
      workContext: baseWorkContext(),
      destination: {
        nodeId: destinationNodeId,
        cwd: destinationCwd,
      },
    }).exportPlan;

    expect(isAgentStateExportPlan(plan)).toBe(true);
    expect(
      isAgentStateExportPlan({
        ...plan,
        providerAuth: { token: 'nope' },
      })
    ).toBe(false);
    expect(
      isAgentResumeBundle({
        ...generateHandoffBrief({
          id: 'resume-bundle-raw-transcript',
          createdAt: now,
          workContext: baseWorkContext(),
          destination: {
            nodeId: destinationNodeId,
            cwd: destinationCwd,
          },
        }),
        instruction: {
          ...generateHandoffBrief({
            id: 'resume-bundle-raw-transcript-2',
            createdAt: now,
            workContext: baseWorkContext(),
            destination: {
              nodeId: destinationNodeId,
              cwd: destinationCwd,
            },
          }).instruction,
          transcript: 'raw hidden text',
        },
      })
    ).toBe(false);
  });

  it('rejects continuation privacy metadata with invalid enum strings', () => {
    const bundle = generateHandoffBrief({
      id: 'resume-bundle-invalid-privacy',
      createdAt: now,
      workContext: baseWorkContext(),
      destination: {
        nodeId: destinationNodeId,
        cwd: destinationCwd,
      },
    });

    expect(isAgentResumeBundle(bundle)).toBe(true);

    expect(
      isAgentResumeBundle({
        ...bundle,
        exportPlan: {
          ...bundle.exportPlan,
          artifactRefs: bundle.exportPlan.artifactRefs.map((artifact, index) =>
            index === 0
              ? {
                  ...artifact,
                  privacy: {
                    ...artifact.privacy,
                    classification: 'totally-not-an-enum',
                    retention: 'also-invalid',
                  },
                }
              : artifact
          ),
        },
      })
    ).toBe(false);
  });

  it('rejects bundles with instruction confidence mismatched from the bundle', () => {
    const bundle = generateHandoffBrief({
      id: 'resume-bundle-mismatched-instruction-confidence',
      createdAt: now,
      workContext: baseWorkContext(),
      destination: {
        nodeId: destinationNodeId,
        cwd: destinationCwd,
      },
    });

    expect(isAgentResumeBundle(bundle)).toBe(true);

    expect(
      isAgentResumeBundle({
        ...bundle,
        instruction: {
          ...bundle.instruction,
          confidence: bundle.confidence === 'low' ? 'high' : 'low',
        },
      })
    ).toBe(false);
  });

  it('preserves explicit exclude metadata classes', () => {
    const excludes: SafeExcludeMetadata[] = [
      {
        class: 'provider-auth',
        reason: 'do not copy Claude OAuth token state',
        sourceRef: '~/.claude/.credentials.json',
      },
      {
        class: 'profile-db',
        reason: 'do not copy Hermes profile SQLite stores',
        sourceRef: '~/.hermes/profiles/ebi/*.db',
      },
      {
        class: 'raw-transcript',
        reason: 'raw transcript is replaced by bounded summary ref',
        replacementRef:
          'relay://work-context/wc:continuation:686/artifacts/source-summary',
        count: 1,
      },
    ];
    const bundle = generateHandoffBrief({
      id: 'resume-bundle-excludes',
      createdAt: now,
      workContext: baseWorkContext(),
      destination: {
        nodeId: destinationNodeId,
        cwd: destinationCwd,
      },
      excludes,
    });

    expect(bundle.exportPlan.excludes).toEqual(excludes);
    expect(isAgentResumeBundle(bundle)).toBe(true);
  });

  it('generates a bounded provider-neutral brief with parseable mode, confidence, readiness, and refs', () => {
    const bundle = generateHandoffBrief({
      id: 'resume-bundle-rich',
      createdAt: now,
      workContext: baseWorkContext(),
      destination: {
        nodeId: destinationNodeId,
        cwd: destinationCwd,
      },
      harness: harness('claude-cross-node', [
        'summary-only',
        'native-same-node',
        'native-cross-node',
      ]),
      requestedMode: 'native-cross-node',
      manifest: {
        hash: manifestHash,
        fileCount: 11,
        byteCount: 2048,
      },
      baseCommit: 'abc1234',
      currentObjective: 'finish the continuation schema and handoff brief',
      recentEvidence: ['shared/handoff.ts has #685 base schema'],
      openBlockers: ['need targeted test pass before PR'],
      requiredFirstAction: 'run npm test -- test/agent-continuation.test.ts',
      readiness: readiness(true),
    });

    expect(bundle.mode).toBe('native-cross-node');
    expect(bundle.confidence).toBe('high');
    expect(bundle.exportPlan.authRuntimeReadiness).toHaveLength(2);
    expect(bundle.instruction.provider?.providerId).toBe('claude-code');
    expect(bundle.exportPlan.manifest).toEqual({
      hash: manifestHash,
      fileCount: 11,
      byteCount: 2048,
    });

    const brief = bundle.instruction.providerNeutralBrief;
    expect(brief).toContain(`WorkContext: ${workContextId}`);
    expect(brief).toContain('github-issue:686');
    expect(brief).toContain('kanban-task:t_ab15cda4');
    expect(brief).toContain(
      'Repo identity: github.com/donovan-yohan/relay-ide'
    );
    expect(brief).toContain(`Source node: ${sourceNodeId}`);
    expect(brief).toContain(`Destination node: ${destinationNodeId}`);
    expect(brief).toContain(`Source cwd metadata: cwd=${sourceCwd}`);
    expect(brief).toContain(`Destination cwd: ${destinationCwd}`);
    expect(brief).toContain(
      'Branch/base: feat/686-agent-continuation / abc1234'
    );
    expect(brief).toContain(`Manifest: hash=${manifestHash}, files=11`);
    expect(brief).toContain('Excluded classes: credential');
    expect(brief).toContain(
      'Current objective: finish the continuation schema and handoff brief'
    );
    expect(brief).toContain(
      'Recent evidence: shared/handoff.ts has #685 base schema'
    );
    expect(brief).toContain('Open blockers: need targeted test pass before PR');
    expect(brief).toContain(
      'Required first action: run npm test -- test/agent-continuation.test.ts'
    );
    expect(brief).not.toContain('providerAuth');
    expect(brief).not.toContain('raw transcript text');
    expect(isAgentResumeBundle(bundle)).toBe(true);
  });
});
