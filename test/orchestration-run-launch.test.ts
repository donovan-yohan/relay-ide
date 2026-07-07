import { describe, expect, it } from 'vitest';

import {
  OrchestrationLaunchValidationError,
  launchOrchestrationRun,
  type OrchestrationLaunchDeps,
} from '../shared/orchestration-run-launch.js';

function createDeps(
  overrides: Partial<OrchestrationLaunchDeps> = {}
): OrchestrationLaunchDeps & {
  published: Record<string, unknown>[];
  updated: { id: string; input: Record<string, unknown> }[];
  sessions: Record<string, unknown>[];
  inbox: Record<string, unknown>[];
} {
  const published: Record<string, unknown>[] = [];
  const updated: { id: string; input: Record<string, unknown> }[] = [];
  const sessions: Record<string, unknown>[] = [];
  const inbox: Record<string, unknown>[] = [];
  return {
    published,
    updated,
    sessions,
    inbox,
    now: () => new Date('2026-07-07T20:00:00.000Z'),
    publishWorkflowRun: async (input) => {
      published.push(input);
      return {
        workflowRun: {
          id: 'workflow-run:launch',
          runId: input['runId'],
          workContextId: input['workContextId'],
          version: 1,
        },
      };
    },
    updateWorkflowRun: async (id, input) => {
      updated.push({ id, input });
      return {
        workflowRun: {
          id,
          version: 2,
          state: input['state'],
          orchestration: input['orchestration'],
        },
      };
    },
    createSession: async (input) => {
      sessions.push(input);
      const agent = String(input['agent'] ?? 'terminal');
      return {
        id: `session:${agent}`,
        globalSessionId: `local:session:${agent}`,
        nodeId: 'local',
        agent,
        cwd: input['worktreePath'] ?? input['repoPath'],
        repoPath: input['repoPath'],
        worktreePath: input['worktreePath'],
      };
    },
    sendInboxMessage: async (input) => {
      inbox.push(input);
      return { message: { id: `inbox:${inbox.length}` } };
    },
    ...overrides,
  };
}

describe('launchOrchestrationRun', () => {
  it('creates a run, launches visible worker sessions, sends messages, and patches topology', async () => {
    const deps = createDeps();

    const result = await launchOrchestrationRun(
      {
        workContextId: 'wc:test',
        runId: 'relay-orchestration:test',
        planner: {
          role: 'planner',
          sessionId: 'session:planner',
          provider: 'hermes',
        },
        lanes: [
          {
            role: 'implementer',
            provider: 'claude',
            repoPath: '/repo/relay-ide',
            worktreePath: '/repo/relay-ide',
            initialPrompt: 'Implement the launcher slice.',
            inboxMessage: 'Use the bounded task brief.',
          },
          {
            role: 'reviewer',
            agent: 'codex',
            repoPath: '/repo/relay-ide',
            worktreePath: '/repo/relay-ide',
          },
        ],
      },
      deps
    );

    expect(result).toMatchObject({
      workflowRunId: 'workflow-run:launch',
      runId: 'relay-orchestration:test',
      workContextId: 'wc:test',
      partialFailure: false,
      lanes: [
        {
          role: 'implementer',
          provider: 'claude',
          launched: true,
          sessionId: 'session:claude',
          inboxMessageId: 'inbox:1',
        },
        {
          role: 'reviewer',
          provider: 'codex',
          launched: true,
          sessionId: 'session:codex',
        },
      ],
    });
    expect(deps.published[0]).toMatchObject({
      runKind: 'relay-orchestration',
      workContextId: 'wc:test',
      orchestration: { planner: { sessionId: 'session:planner' } },
    });
    expect(deps.sessions).toHaveLength(2);
    expect(deps.sessions[0]).toMatchObject({
      workContextId: 'wc:test',
      type: 'agent',
      agent: 'claude',
      initialPrompt: 'Implement the launcher slice.',
    });
    expect(deps.inbox[0]).toMatchObject({
      targetSessionId: 'session:claude',
      text: 'Use the bounded task brief.',
      createdBy: 'orchestration-runs.launch',
    });
    expect(deps.updated[0]).toMatchObject({
      id: 'workflow-run:launch',
      input: {
        expectedVersion: 1,
        state: 'running',
        orchestration: {
          children: [
            { role: 'implementer', sessionId: 'session:claude' },
            { role: 'reviewer', sessionId: 'session:codex' },
          ],
        },
      },
    });
  });

  it('fails closed when workContextId or lane provider is missing', async () => {
    const deps = createDeps();
    await expect(
      launchOrchestrationRun({ lanes: [] }, deps)
    ).rejects.toBeInstanceOf(OrchestrationLaunchValidationError);
    await expect(
      launchOrchestrationRun(
        { workContextId: 'wc:test', lanes: [{ role: 'implementer' }] },
        deps
      )
    ).rejects.toMatchObject({
      details: { field: 'lanes[0].provider' },
    });
    expect(deps.published).toHaveLength(0);
  });

  it('reports partial failure when one worker session cannot be created', async () => {
    const deps = createDeps({
      createSession: async (input) => {
        deps.sessions.push(input);
        if (input['agent'] === 'codex') throw new Error('codex unavailable');
        return { id: 'session:claude', nodeId: 'local', agent: 'claude' };
      },
    });

    const result = await launchOrchestrationRun(
      {
        workContextId: 'wc:test',
        lanes: [
          { role: 'implementer', provider: 'claude', repoPath: '/repo' },
          { role: 'reviewer', provider: 'codex', repoPath: '/repo' },
        ],
      },
      deps
    );

    expect(result.partialFailure).toBe(true);
    expect(result.lanes).toEqual([
      expect.objectContaining({
        role: 'implementer',
        launched: true,
        sessionId: 'session:claude',
      }),
      expect.objectContaining({
        role: 'reviewer',
        launched: false,
        failureStage: 'session-create',
        error: 'codex unavailable',
      }),
    ]);
    expect(deps.updated[0].input).toMatchObject({
      state: 'waiting',
      errorSummary: 'one or more orchestration launch lanes need attention',
      orchestration: {
        children: [{ role: 'implementer', sessionId: 'session:claude' }],
      },
    });
  });

  it('keeps launched sessions linked when inbox delivery fails', async () => {
    const deps = createDeps({
      sendInboxMessage: async (input) => {
        deps.inbox.push(input);
        throw new Error('inbox unavailable');
      },
    });

    const result = await launchOrchestrationRun(
      {
        workContextId: 'wc:test',
        lanes: [
          {
            role: 'implementer',
            provider: 'claude',
            repoPath: '/repo',
            inboxMessage: 'Please start here.',
          },
        ],
      },
      deps
    );

    expect(result).toMatchObject({
      partialFailure: true,
      lanes: [
        {
          launched: true,
          failureStage: 'message-delivery',
          error: 'inbox unavailable',
        },
      ],
      children: [
        {
          state: 'waiting',
          attention: {
            needsAttention: true,
            reasons: ['message-delivery-failed'],
          },
        },
      ],
    });
    expect(deps.updated[0].input).toMatchObject({
      state: 'waiting',
      orchestration: {
        children: [
          {
            role: 'implementer',
            attention: { reasons: ['message-delivery-failed'] },
          },
        ],
      },
    });
  });
});
