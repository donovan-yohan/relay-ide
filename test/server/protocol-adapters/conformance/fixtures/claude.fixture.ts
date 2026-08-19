/**
 * Conformance fixture for the `claude` adapter (stream-json subprocess).
 *
 * Every native payload below is transcribed from a real captured stream-json
 * shape already asserted in `claude-adapter.test.ts` — `system/init`,
 * `assistant` content blocks (thinking / text / tool_use), the `user`
 * tool_result echo, `control_request:can_use_tool`, `control_response`, and the
 * terminal `result` line in both its success and `error_during_execution`
 * forms. No grammar is invented here.
 *
 * Transport injection uses the adapter's existing `spawnFn` seam — zero
 * production change. The fake child hands out a fixed pid so a replayed
 * transcript is byte-identical.
 */
import {
  ClaudeProcessRegistry,
  ClaudeProtocolAdapter,
} from '../../../../../server/protocol-adapters/claude-adapter.js';
import {
  makeClaudeChildHarness,
  type MockChild,
} from '../../support/claude-child-double.js';
import type {
  AdapterConformanceFixture,
  FixtureFeedStep,
} from '../fixture-types.js';

const SESSION = 'claude-conf-1';

/**
 * Claude-local quirk: the interrupt ack must echo the `request_id` the ADAPTER
 * generated on stdin, which the fixture cannot know statically. The rig
 * substitutes this placeholder with the id it reads back off the fake child's
 * stdin frames. Kept fixture-local — the harness never learns about it.
 */
const INTERRUPT_ACK_ID = '__HARNESS_LAST_INTERRUPT__';

function native(event: unknown, label?: string): FixtureFeedStep {
  return label === undefined
    ? { kind: 'native', event }
    : { kind: 'native', event, label };
}

function result(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    type: 'result',
    subtype: 'success',
    duration_ms: 1,
    total_cost_usd: 0,
    usage: { input_tokens: 10, output_tokens: 4 },
    session_id: SESSION,
    ...overrides,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForInterruptRequestId(child: MockChild): Promise<string> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    for (const frame of child.frames()) {
      const request = frame.request as { subtype?: string } | undefined;
      if (
        frame.type === 'control_request' &&
        request?.subtype === 'interrupt'
      ) {
        const requestId = frame.request_id;
        if (typeof requestId === 'string') return requestId;
      }
    }
    await sleep(1);
  }
  throw new Error(
    'claude conformance rig: no interrupt control_request appeared on stdin'
  );
}

const fixture: AdapterConformanceFixture = {
  adapterId: 'claude',

  createRig() {
    const harness = makeClaudeChildHarness();
    // Inert registry: the conformance floor drives the lifecycle explicitly and
    // never wants a background GC sweep racing the transcript.
    const adapter = new ClaudeProtocolAdapter(
      harness.spawnFn,
      new ClaudeProcessRegistry(1_000_000)
    );

    const currentChild = async (): Promise<MockChild> => {
      const deadline = Date.now() + 1_000;
      while (Date.now() < deadline) {
        const record = harness.spawns[harness.spawns.length - 1];
        if (record) return record.child;
        await sleep(1);
      }
      throw new Error('claude conformance rig: no child process was spawned');
    };

    return {
      adapter,
      config: {
        cwd: '/tmp/conformance-claude',
        port: 3000,
        sessionId: 'conf-claude',
        hookToken: 'conf',
        configDir: '/tmp/conf-config',
      },
      feed: async (step) => {
        const child = await currentChild();
        if (step.kind === 'close') {
          child.emitClose(step.code ?? 0, null);
          return;
        }
        if (step.kind !== 'native') {
          throw new Error(
            `claude conformance rig only feeds native stdout lines, got ${step.kind}`
          );
        }
        const raw = JSON.stringify(step.event);
        if (!raw.includes(INTERRUPT_ACK_ID)) {
          child.serverWrite(step.event);
          return;
        }
        const requestId = await waitForInterruptRequestId(child);
        child.serverWrite(
          JSON.parse(raw.replaceAll(INTERRUPT_ACK_ID, requestId))
        );
      },
      dispose: async () => {
        // The fake children die with `disconnect()`; nothing else is owned.
      },
    };
  },

  // The adapter spawns lazily on the first `sendMessage`, so `connect()`
  // completes with no stdout at all — there is nothing to script here.
  connect: { steps: [] },

  simpleTurn: {
    steps: [
      native(
        { type: 'system', subtype: 'init', session_id: SESSION },
        'stream-json init'
      ),
      native(
        {
          type: 'assistant',
          message: {
            id: 'msg-conf-1',
            content: [
              { type: 'thinking', thinking: 'conformance reasoning summary' },
              { type: 'text', text: 'conformance says hi' },
              {
                type: 'tool_use',
                id: 'tu-conf-1',
                name: 'Bash',
                input: { command: 'pwd' },
              },
            ],
          },
          session_id: SESSION,
        },
        'assistant echo: thinking + text + Bash tool_use'
      ),
      native(
        {
          type: 'user',
          message: {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'tu-conf-1',
                content: '/tmp/conformance-claude',
              },
            ],
          },
          tool_use_result: { stdout: '/tmp/conformance-claude\n', stderr: '' },
        },
        'tool_result for the Bash call'
      ),
      native(result(), 'terminal result'),
    ],
    expect: {
      terminalStatus: 'completed',
      requiredPatchTypes: [
        'agent-turn-started-v2',
        'agent-item-started-v2',
        'agent-item-delta-v2',
        'agent-item-updated-v2',
        'agent-turn-completed-v2',
      ],
      textIncludes: ['conformance says hi'],
    },
  },

  interruptedTurn: {
    steps: [
      native(
        {
          type: 'assistant',
          message: {
            id: 'msg-conf-2',
            content: [{ type: 'text', text: 'conformance long answer' }],
          },
          session_id: SESSION,
        },
        'partial answer before the interrupt'
      ),
      // interruptAfter: 1 → the harness calls interrupt() here and the adapter
      // writes a control_request(interrupt) frame to stdin; the CLI acks it.
      native(
        {
          type: 'control_response',
          response: { subtype: 'success', request_id: INTERRUPT_ACK_ID },
        },
        'interrupt ack'
      ),
    ],
    interruptAfter: 1,
    expect: { terminalStatus: 'interrupted' },
  },

  errorTurn: {
    steps: [
      native(
        result({
          subtype: 'error_during_execution',
          is_error: true,
          error: 'conformance provider failure',
        }),
        'provider failure terminal'
      ),
    ],
    expect: { terminalStatus: 'failed' },
  },

  approvalFlow: {
    request: [
      native(
        {
          type: 'control_request',
          request_id: 'ctrl-conf-approval',
          request: {
            subtype: 'can_use_tool',
            tool_name: 'Bash',
            input: { command: 'pwd' },
          },
        },
        'can_use_tool permission prompt'
      ),
    ],
    decision: { kind: 'accept', scope: 'once' },
    resolution: [native(result(), 'post-approval terminal')],
    expect: { terminalStatus: 'completed' },
  },

  allowedSilentEvents: [
    {
      match: (step) =>
        step.kind === 'native' &&
        (step.event as { type?: string }).type === 'control_response',
      reason:
        'a control_response resolves an in-flight control promise inside the adapter; emitting no patch of its own is the contract, and any user-visible consequence arrives from the control continuation',
    },
  ],

  knownGaps: {
    'b-abandoned-approval': {
      issue: '#1407',
      reason:
        'onDisconnect writes the deny control_response to the child (correct on the wire) but emits no agent-item-updated-v2 resolving the approval item and no live-state patch draining activeRequestIds, so the reduced session keeps a permanently actionable approval card',
    },
  },

  exercised: ['reasoning', 'commandExecution', 'streaming', 'telemetry'],

  unexercisable: [
    {
      capability: 'resume',
      reason:
        'resume needs a second scripted process generation (--resume respawn); deep-tested in claude-adapter.test.ts',
    },
    {
      capability: 'steer',
      reason:
        'steer frame choreography and its rejection races are deep-tested in claude-adapter.test.ts; the floor fixture drives one turn at a time',
    },
    {
      capability: 'queue',
      reason:
        'the floor transcript never has two turns in flight, which is what queueing means here',
    },
    {
      capability: 'compact',
      reason:
        'compaction arrives on a system/compact_boundary line the floor transcript does not script',
    },
    {
      capability: 'tools',
      reason:
        'the scripted Bash tool_use maps to commandExecution; an mcp__ tool call is deep-tested in claude-adapter.test.ts',
    },
    {
      capability: 'fileChanges',
      reason:
        'Edit/Write tool_use → fileChange mapping is deep-tested in claude-adapter.test.ts; the floor transcript scripts one Bash call instead',
    },
    {
      capability: 'rateLimits',
      reason: 'no rate-limit patch shape exists in AgentPatchV2 yet to detect',
    },
  ],
};

export default fixture;
