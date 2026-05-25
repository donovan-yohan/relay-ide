import { describe, expect, it } from 'vitest';

import {
  createSupervisorSnapshot,
  SUPERVISOR_SNAPSHOT_REQUIRED_CAPABILITIES,
} from '../../server/supervisor-snapshot.js';
import type { SessionSummary } from '../../server/types.js';

function session(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: 'session-a',
    type: 'agent',
    agent: 'claude',
    mode: 'pty',
    cwd: '/repo',
    displayName: 'Claude /repo',
    createdAt: '2026-05-25T00:00:00.000Z',
    lastActivity: '2026-05-25T00:00:01.000Z',
    idle: false,
    customCommand: null,
    status: 'active',
    needsBranchRename: false,
    agentState: 'idle',
    controlMode: 'agent-driven',
    activeActors: [{ kind: 'agent', id: 'claude', displayName: 'Claude Code' }],
    activeWorker: { kind: 'agent', id: 'claude', displayName: 'Claude Code' },
    lastInterventionAt: null,
    lastInterventionBy: null,
    lastInterventionEventId: null,
    controlFreshness: 'fresh',
    nodeId: 'node-a',
    globalSessionId: 'global:node-a:session-a',
    repoPath: '/repo',
    worktreePath: null,
    workContextId: 'wc-a',
    ...overrides,
  };
}

describe('supervisor snapshot contract', () => {
  it('returns a read-only typed snapshot with redacted intervention and audit metadata', async () => {
    const result = await createSupervisorSnapshot({
      session: session({ rawPrompt: 'secret prompt that must not leak' } as unknown as Partial<SessionSummary>),
      grantedCapabilities: SUPERVISOR_SNAPSHOT_REQUIRED_CAPABILITIES,
      actorId: 'brain-a',
      now: new Date('2026-05-25T01:02:03.000Z'),
      readInterventions: () => [
        {
          id: 'int-a',
          timestamp: '2026-05-25T01:00:00.000Z',
          source: 'pty-input',
          kind: 'human-input',
          authorKind: 'human',
          redacted: true,
          hashSha256: 'hash-only',
          byteCount: 42,
          lineCount: 1,
        },
      ],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected snapshot to be allowed');
    expect(result.snapshot).toMatchObject({
      command: 'supervisor.snapshot',
      capturedAt: '2026-05-25T01:02:03.000Z',
      session: {
        sessionId: 'session-a',
        nodeId: 'node-a',
        workContextId: 'wc-a',
      },
      control: { controlMode: 'agent-driven', controlFreshness: 'fresh' },
      provider: {
        providerId: 'claude',
        capabilityBoundary: 'relay-command-contract',
        readOnlyAdapterState: true,
        rawProviderStateStored: false,
      },
      interventions: {
        available: true,
        rawPayloadAvailable: false,
        transcriptExportAvailable: false,
      },
      redaction: {
        rawPtyInputAvailable: false,
        rawTranscriptAvailable: false,
        rawPromptAvailable: false,
        rawProviderStateAvailable: false,
        auditStoresHashesOnly: true,
      },
      partialFailures: [],
    });
    expect(result.snapshot.interventions.items).toHaveLength(1);
    expect(result.audit).toMatchObject({
      command: 'supervisor.snapshot',
      decision: 'allowed',
      actorId: 'brain-a',
      missingCapabilities: [],
      partialFailureCount: 0,
      redaction: {
        rawPromptStored: false,
        rawTranscriptStored: false,
        rawPtyInputStored: false,
        rawProviderStateStored: false,
      },
    });
    expect(JSON.stringify(result)).not.toContain('secret prompt');
  });

  it('denies snapshots without both session and intervention read capabilities', async () => {
    const result = await createSupervisorSnapshot({
      session: session(),
      grantedCapabilities: ['session:read'],
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'FORBIDDEN', retryable: false },
      audit: {
        decision: 'denied',
        missingCapabilities: ['tab:intervention:read'],
      },
    });
  });

  it('refuses stale or mismatched control-mode preflight instead of supervising blindly', async () => {
    const result = await createSupervisorSnapshot({
      session: session({ controlMode: 'human-driven', controlFreshness: 'stale' }),
      grantedCapabilities: SUPERVISOR_SNAPSHOT_REQUIRED_CAPABILITIES,
      policy: { expectedControlMode: 'agent-driven' },
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'CONTROL_STATE_STALE', retryable: true },
      audit: { decision: 'denied', controlMode: 'human-driven', controlFreshness: 'stale' },
    });
  });

  it('requires callers to observe the latest human intervention before continuing typed actions', async () => {
    const result = await createSupervisorSnapshot({
      session: session({
        controlMode: 'co-driven',
        lastInterventionEventId: 'intervention-latest-secret-ish-id',
      }),
      grantedCapabilities: SUPERVISOR_SNAPSHOT_REQUIRED_CAPABILITIES,
      policy: { latestSeenInterventionEventId: 'intervention-old' },
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected ack-required denial');
    expect(result.error).toMatchObject({ code: 'INTERVENTION_ACK_REQUIRED', retryable: true });
    expect(result.audit.latestInterventionEventIdHash).toBeDefined();
    expect(JSON.stringify(result.audit)).not.toContain('intervention-latest-secret-ish-id');
  });

  it('returns partial-failure metadata when optional redacted intervention reads fail', async () => {
    const result = await createSupervisorSnapshot({
      session: session(),
      grantedCapabilities: SUPERVISOR_SNAPSHOT_REQUIRED_CAPABILITIES,
      readInterventions: () => {
        throw new Error('intervention db unavailable');
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected snapshot with partial failure');
    expect(result.snapshot.interventions.available).toBe(false);
    expect(result.snapshot.partialFailures).toEqual([
      {
        source: 'interventions',
        code: 'UPSTREAM_ERROR',
        message: 'intervention db unavailable',
      },
    ]);
    expect(result.audit.partialFailureCount).toBe(1);
  });
});
