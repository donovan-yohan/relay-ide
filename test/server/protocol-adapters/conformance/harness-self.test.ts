/**
 * The conformance floor is only worth landing if it actually bites. These tests
 * mutate the claude fixture on purpose and assert the harness reports the
 * violation, so a future refactor cannot quietly turn the suite vacuous.
 */
import { describe, expect, it } from 'vitest';
import claudeFixture from './fixtures/claude.fixture.js';
import {
  CAPABILITIES_WITHOUT_DETECTOR,
  describeMalformedGap,
  normalizePatchForReplay,
  pendingApprovalIds,
  reconcileCapabilities,
  renderableText,
  runAbandonedApprovalProbe,
  runLifecycle,
  type LifecycleRun,
} from './harness.js';
import type {
  AdapterConformanceFixture,
  FixtureFeedStep,
} from './fixture-types.js';
import type { AgentPatchV2 } from '../../../../shared/agent-chat-protocol-v2.js';

/**
 * A second `system/init` carrying the session id the adapter already knows is
 * real stream-json traffic that maps to no patch — the exact shape invariant
 * (c) exists to notice.
 */
const REDUNDANT_INIT: FixtureFeedStep = {
  kind: 'native',
  event: { type: 'system', subtype: 'init', session_id: 'claude-conf-1' },
  label: 'redundant init (already-known session id)',
};

function withRedundantInit(
  overrides?: Partial<AdapterConformanceFixture>
): AdapterConformanceFixture {
  return {
    ...claudeFixture,
    simpleTurn: {
      ...claudeFixture.simpleTurn,
      steps: [
        ...claudeFixture.simpleTurn.steps.slice(0, 1),
        REDUNDANT_INIT,
        ...claudeFixture.simpleTurn.steps.slice(1),
      ],
    },
    ...overrides,
  };
}

function withoutApprovalFlow(
  fixture: AdapterConformanceFixture
): AdapterConformanceFixture {
  const { approvalFlow: _approvalFlow, ...rest } = fixture;
  return rest;
}

function stubRun(patches: AgentPatchV2[]): LifecycleRun {
  return {
    adapterId: 'stub',
    patches,
    segments: {
      connect: [],
      'simple-turn': patches,
      'interrupted-turn': [],
      'error-turn': [],
      'approval-flow': [],
      teardown: [],
    },
    turnIds: {},
    expectedTerminal: {},
    silentDrops: [],
    approvalIdTimeline: [],
    finalSession: {
      id: 'stub',
      provider: 'mock',
      capabilities: {},
      config: { cwd: '/tmp' },
      live: {
        status: 'idle',
        activeTurnId: null,
        waitingOn: null,
        activeRequestIds: [],
        proposedPlanItemId: null,
        queueLength: 0,
        fastModeAvailable: false,
        error: null,
      },
      turns: [],
    },
  };
}

const interruptedTerminal: AgentPatchV2 = {
  type: 'agent-turn-completed-v2',
  sessionId: 'stub',
  timestamp: '2026-01-01T00:00:00.000Z',
  turnId: 'turn-1',
  status: 'interrupted',
};

describe('conformance harness self-tests', () => {
  it('(c) records a native event that produced no patch', async () => {
    const run = await runLifecycle(withRedundantInit());
    expect(
      run.silentDrops.map((drop) => drop.step.label ?? drop.step.kind)
    ).toEqual(['redundant init (already-known session id)']);
    expect(run.silentDrops[0]?.segment).toBe('simple-turn');
  }, 30_000);

  it('(c) an allowedSilentEvents entry suppresses that same drop', async () => {
    const run = await runLifecycle(
      withRedundantInit({
        allowedSilentEvents: [
          ...(claudeFixture.allowedSilentEvents ?? []),
          {
            match: (step) =>
              step.kind === 'native' &&
              (step.event as { subtype?: string }).subtype === 'init',
            reason: 'self-test only',
          },
        ],
      })
    );
    expect(run.silentDrops).toEqual([]);
  }, 30_000);

  it('(d) normalization blanks wall-clock and nothing else', () => {
    const patch: AgentPatchV2 = {
      type: 'agent-item-started-v2',
      sessionId: 'session-1',
      timestamp: '2026-01-01T00:00:00.000Z',
      turnId: 'turn-1',
      item: {
        type: 'assistantMessage',
        id: 'msg-turn-1-0',
        text: 'hello',
        startedAt: '2026-01-01T00:00:00.000Z',
        completedAt: '2026-01-01T00:00:01.000Z',
      },
    };
    expect(normalizePatchForReplay(patch)).toEqual({
      type: 'agent-item-started-v2',
      sessionId: 'session-1',
      timestamp: '<volatile>',
      turnId: 'turn-1',
      item: {
        type: 'assistantMessage',
        // Ids are deliberately NOT normalized — id stability is part of
        // determinism, so a rig with random ids must fail invariant (d).
        id: 'msg-turn-1-0',
        text: 'hello',
        startedAt: '<volatile>',
        completedAt: '<volatile>',
      },
    });
  });

  it('(d) two runs of the same fixture agree, and a changed id would not', async () => {
    const first = await runLifecycle(claudeFixture);
    const second = await runLifecycle(claudeFixture);
    const normalize = (patches: AgentPatchV2[]): unknown[] =>
      patches.map((patch) => normalizePatchForReplay(patch));
    expect(normalize(second.patches)).toEqual(normalize(first.patches));
    expect(first.patches.length).toBeGreaterThan(20);

    const tampered = structuredClone(second.patches);
    const target = tampered.find(
      (patch) => patch.type === 'agent-item-started-v2'
    );
    if (target?.type !== 'agent-item-started-v2')
      throw new Error('expected an item-started patch to tamper with');
    target.item = { ...target.item, id: `${target.item.id}-tampered` };
    expect(normalize(tampered)).not.toEqual(normalize(first.patches));
  }, 60_000);

  it('(e) records exactly which capabilities are UNKNOWN-only in v1', () => {
    // Live documentation of the floor's ceiling: adding a detector must update
    // this list, so "UNKNOWN" never quietly grows to cover a real regression.
    expect([...CAPABILITIES_WITHOUT_DETECTOR]).toEqual([
      'plans',
      'slashCommands',
      'queue',
      'steer',
      'cancelQueued',
      'resume',
      'fork',
      'rollback',
      'compact',
      'rateLimits',
    ]);
  });

  it('(e) a capability that manifests while declared false is DRIFT', () => {
    const report = reconcileCapabilities({
      declared: { text: true, interrupt: false },
      run: stubRun([interruptedTerminal]),
      fixture: claudeFixture,
    });
    const row = report.rows.find((entry) => entry.capability === 'interrupt');
    expect(row?.verdict).toBe('drift');
    expect(report.drift.map((entry) => entry.capability)).toContain(
      'interrupt'
    );
  });

  it('(e) a declared capability that was exercised and never manifested is DRIFT', () => {
    const report = reconcileCapabilities({
      declared: { text: true, interrupt: true },
      run: stubRun([]),
      fixture: claudeFixture,
    });
    expect(
      report.drift.map((entry) => `${entry.capability}:${entry.note}`)
    ).toContain('interrupt:declared true and exercised, but never manifested');
  });

  it('(e) an unexercised capability is UNKNOWN, never drift, whatever it declares', () => {
    const report = reconcileCapabilities({
      declared: { fileChanges: true, questions: true, text: true },
      run: stubRun([interruptedTerminal]),
      fixture: { ...withoutApprovalFlow(claudeFixture), exercised: [] },
    });
    for (const capability of ['fileChanges', 'questions'] as const) {
      expect(
        report.rows.find((entry) => entry.capability === capability)?.verdict
      ).toBe('unknown');
    }
    expect(report.drift.map((entry) => entry.capability)).not.toContain(
      'fileChanges'
    );
  });

  it('(e) rejects a fixture that attests a capability the harness cannot observe', () => {
    const report = reconcileCapabilities({
      declared: { text: true, interrupt: true },
      run: stubRun([interruptedTerminal]),
      fixture: { ...claudeFixture, exercised: ['resume'] },
    });
    expect(report.fixtureErrors.join('\n')).toMatch(
      /exercised\['resume'\] has no conformance detector/
    );
  });

  it('(e) rejects an unexercisable claim on a built-in the harness always drives', () => {
    const report = reconcileCapabilities({
      declared: { text: true, interrupt: true },
      run: stubRun([interruptedTerminal]),
      fixture: {
        ...claudeFixture,
        unexercisable: [{ capability: 'interrupt', reason: 'nope' }],
      },
    });
    expect(report.fixtureErrors.join('\n')).toMatch(
      /unexercisable\['interrupt'\] is a built-in/
    );
  });

  it('(b) the abandoned-approval probe reports the stranded approval claude leaves (#1407)', async () => {
    // Red-to-green pin for #1407. The probe is otherwise dead code today (every
    // approval-bearing fixture gaps `b-abandoned-approval`), so this is the one
    // place it actually runs — and it must SEE the defect, not shrug at it.
    // When #1407 lands, this expectation flips to `toEqual([])` and the
    // per-fixture `b-abandoned-approval` gaps come out.
    const abandoned = await runAbandonedApprovalProbe(claudeFixture);
    expect(
      pendingApprovalIds(abandoned).length,
      'claude disconnects with the approval still pending — if this is now empty, #1407 is fixed: drop the knownGaps entries and invert this test'
    ).toBeGreaterThan(0);
  }, 30_000);

  it('(b) the probe fails loudly when a transcript surfaces no approval at all', async () => {
    // Without this the probe would pass vacuously against an adapter that
    // regressed to never raising the approval item in the first place.
    await expect(
      runAbandonedApprovalProbe({
        ...claudeFixture,
        approvalFlow: { ...claudeFixture.approvalFlow!, request: [] },
      })
    ).rejects.toThrow(/surfaced no pending approval item/);
  }, 30_000);

  it('textIncludes matches rendered text, not raw item JSON', () => {
    // The needle must not be satisfiable by a key name, an id, or a tool
    // argument blob the timeline never renders.
    const rendered = renderableText({
      type: 'commandExecution',
      id: 'cmd-1',
      command: 'pwd',
      output: '/tmp',
    });
    expect(rendered).toContain('pwd');
    expect(rendered).not.toContain('cmd-1');
    expect(
      renderableText({
        type: 'mcpToolCall',
        id: 'mcp-1',
        server: 'github',
        tool: 'search',
        arguments: { query: 'secret-needle' },
      })
    ).not.toContain('secret-needle');
  });

  it('known gaps must cite a #issue and a written reason', () => {
    expect(
      describeMalformedGap('a-terminal', {
        issue: 'TODO',
        reason: 'a perfectly long written justification',
      })
    ).toMatch(/must be a '#<number>' citation/);
    expect(
      describeMalformedGap('a-terminal', { issue: '#1412', reason: 'nope' })
    ).toMatch(/needs a written justification/);
    expect(
      describeMalformedGap('c-no-silent-drop', {
        issue: '#1412',
        reason: 'a perfectly long written justification',
        capabilities: ['streaming'],
      })
    ).toMatch(/only narrows 'e-capability-drift'/);
    expect(
      describeMalformedGap('e-capability-drift', {
        issue: '#1305',
        reason: 'a perfectly long written justification',
        capabilities: ['streaming'],
      })
    ).toBeUndefined();
  });

  it('(e) a declared-true capability that is neither exercised nor waived is a fixture error', () => {
    const report = reconcileCapabilities({
      declared: { text: true, interrupt: true, questions: true },
      run: stubRun([interruptedTerminal]),
      fixture: { ...claudeFixture, exercised: [], unexercisable: [] },
    });
    expect(report.fixtureErrors.join('\n')).toMatch(
      /declared-true capability 'questions' is neither exercised nor waived/
    );
  });

  it('(e) rejects an approvals:true adapter with no approvalFlow and no waiver', () => {
    const report = reconcileCapabilities({
      declared: { approvals: true, text: true, interrupt: true },
      run: stubRun([interruptedTerminal]),
      fixture: withoutApprovalFlow(claudeFixture),
    });
    expect(report.fixtureErrors.join('\n')).toMatch(
      /declares approvals:true but the fixture has no approvalFlow/
    );
  });
});
