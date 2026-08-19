/**
 * Conformance fixture for the `mock` adapter (`MockProtocolAdapterV2`).
 *
 * The mock is the harness's own smoke test: it proves the suite can drive a
 * registered adapter end to end with ZERO transport doubles. Every segment is
 * self-scripted by the adapter, so `feed()` is never called — a feed step here
 * would mean the harness drifted away from the mock's contract.
 *
 * Note the registry has exactly one mock key (`mock` → `MockProtocolAdapterV2`).
 * The v1 `mock-adapter.ts` is not in `v2Adapters`, so discovery correctly
 * ignores it and no exemption list is needed.
 */
import { MockProtocolAdapterV2 } from '../../../../../server/protocol-adapters/mock-v2-adapter.js';
import type { AdapterConformanceFixture } from '../fixture-types.js';

const fixture: AdapterConformanceFixture = {
  adapterId: 'mock',

  createRig() {
    // Same class the registry builds; only the scripted delays differ, and
    // delays are not part of the capability set the parity test compares.
    // `stepMs` is wide enough that the harness's interrupt lands inside the
    // first scripted sleep on every machine.
    const adapter = new MockProtocolAdapterV2({ connectMs: 1, stepMs: 30 });
    return {
      adapter,
      config: {
        cwd: '/tmp/conformance-mock',
        port: 3000,
        sessionId: 'conf-mock',
        hookToken: 'conf',
        configDir: '/tmp/conf-config',
      },
      feed: (step) => {
        throw new Error(
          `mock conformance rig is self-scripted and has no transport to feed: ${JSON.stringify(step)}`
        );
      },
      dispose: async () => {
        // Nothing to tear down — the mock owns no process, socket, or file.
      },
    };
  },

  connect: { steps: [] },

  simpleTurn: {
    steps: [],
    expect: {
      terminalStatus: 'completed',
      requiredPatchTypes: [
        'agent-turn-started-v2',
        'agent-item-started-v2',
        'agent-item-delta-v2',
        'agent-turn-completed-v2',
      ],
      textIncludes: ['Mock v2 response complete.'],
    },
  },

  interruptedTurn: {
    // The mock aborts through its AbortController: the harness interrupts
    // before any scripted step, while `runHappyPath` is parked in its sleep.
    steps: [],
    interruptAfter: 0,
    expect: { terminalStatus: 'interrupted' },
  },

  errorTurn: {
    exempt:
      'MockProtocolAdapterV2.runTurn only distinguishes abort (interrupted) from a thrown error (failed), and nothing outside the adapter can make it throw — there is no scriptable provider-failure path. Adding one means a prompt-keyword failure trigger in mock-v2-adapter.ts; flagged, not taken, in this slice.',
  },

  approvalFlow: {
    // `isApprovalScenario` matches /\bapproval\b/i on the prompt.
    prompt: 'please request approval before running the command',
    request: [],
    decision: { kind: 'accept', scope: 'once' },
    resolution: [],
    expect: { terminalStatus: 'completed' },
  },

  exercised: [
    'reasoning',
    'commandExecution',
    'fileChanges',
    'tools',
    'streaming',
  ],

  // No known gaps. #1407 is fixed: `onDisconnect` no longer leans on the
  // aborted turn to publish the resolution a microtask later — where
  // `BaseProtocolAdapterV2.disconnect()` had already dropped every handler —
  // and resolves the card synchronously instead.

  unexercisable: [
    {
      capability: 'telemetry',
      reason:
        'no input to MockProtocolAdapterV2 produces a usage payload on its completion patch, so the flag cannot be driven from a fixture',
    },
    {
      capability: 'questions',
      reason:
        'the v2 mock has no question/input scenario (respondToInput is a documented no-op)',
    },
  ],
};

export default fixture;
