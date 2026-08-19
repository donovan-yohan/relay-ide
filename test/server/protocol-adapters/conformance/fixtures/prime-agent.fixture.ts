/**
 * Conformance fixture for the `prime-agent` adapter (JSONL RPC subprocess).
 *
 * Every native payload below is transcribed from a real captured Prime RPC
 * event already asserted in `prime-agent-adapter.test.ts` — `message_start`,
 * `message_update` with `text_delta` / `thinking_delta`,
 * `tool_execution_start` / `_update` / `_end`, `session_action_update`,
 * `extension_error`, `message_end` with its usage block, `turn_end`,
 * `auto_retry_end`, and the terminal `agent_end`. The `edit` tool shapes come
 * from the sibling Pi transcript (`pi-agent-adapter.test.ts` lines 940-990),
 * which is the same native Prime-family grammar the designer notes point at.
 * No grammar is invented here.
 *
 * Transport injection uses the adapter's existing `ClientFactory` constructor
 * seam — zero production change. See `../stubs/prime-agent.stub.ts`.
 */
import { PrimeAgentProtocolAdapter } from '../../../../../server/protocol-adapters/prime-agent-adapter.js';
import { makePrimeAgentTransportDouble } from '../stubs/prime-agent.stub.js';
import type {
  AdapterConformanceFixture,
  FixtureFeedStep,
} from '../fixture-types.js';

function native(event: unknown, label?: string): FixtureFeedStep {
  return label === undefined
    ? { kind: 'native', event }
    : { kind: 'native', event, label };
}

/** `{ content: [{ type: 'text', text }] }` — Prime's tool result envelope. */
function toolResult(text: string): Record<string, unknown> {
  return { content: [{ type: 'text', text }] };
}

const fixture: AdapterConformanceFixture = {
  adapterId: 'prime-agent',

  createRig() {
    const transport = makePrimeAgentTransportDouble();
    const adapter = new PrimeAgentProtocolAdapter(transport.clientFactory);

    return {
      adapter,
      config: {
        cwd: '/tmp/conformance-prime-agent',
        port: 3000,
        sessionId: 'conf-prime-agent',
        hookToken: 'conf',
        configDir: '/tmp/conf-config',
      },
      feed: (step) => {
        if (step.kind !== 'native') {
          throw new Error(
            `prime-agent conformance rig only feeds native RPC events, got ${step.kind}`
          );
        }
        transport.feed(step.event);
      },
      dispose: async () => {
        // The double owns no OS resources; `disconnect()` already stopped the
        // stubbed client and the adapter dropped its listeners with it.
      },
    };
  },

  // `connect()` spawns the RPC client, awaits its `start()` readiness
  // `get_state`, then discovers the model catalog over the control lane. Both
  // are request/response, so no event-channel frame is scriptable here.
  connect: { steps: [] },

  simpleTurn: {
    steps: [
      native(
        { type: 'message_start', message: { role: 'assistant' } },
        'assistant message boundary'
      ),
      native(
        {
          type: 'message_update',
          assistantMessageEvent: {
            type: 'text_delta',
            contentIndex: 0,
            delta: 'prime conformance answer',
          },
        },
        'streamed answer text'
      ),
      native(
        {
          type: 'message_update',
          assistantMessageEvent: {
            type: 'thinking_delta',
            contentIndex: 1,
            delta: 'prime conformance reasoning',
          },
        },
        'streamed reasoning summary'
      ),
      native(
        {
          type: 'tool_execution_start',
          toolCallId: 'conf-tool-bash',
          toolName: 'bash',
          args: { command: 'pwd' },
        },
        'bash tool start → commandExecution'
      ),
      native(
        {
          type: 'tool_execution_update',
          toolCallId: 'conf-tool-bash',
          toolName: 'bash',
          args: { command: 'pwd' },
          partialResult: toolResult('/tmp'),
        },
        'partial bash output (replace-mode delta)'
      ),
      native(
        {
          type: 'tool_execution_end',
          toolCallId: 'conf-tool-bash',
          toolName: 'bash',
          args: { command: 'pwd' },
          result: toolResult('/tmp/conformance-prime-agent'),
          isError: false,
        },
        'bash tool end'
      ),
      native(
        {
          type: 'tool_execution_start',
          toolCallId: 'conf-tool-edit',
          toolName: 'edit',
          args: { path: '/tmp/conformance-prime-agent/a.ts' },
        },
        'edit tool with a path → fileChange'
      ),
      native(
        {
          type: 'tool_execution_end',
          toolCallId: 'conf-tool-edit',
          toolName: 'edit',
          args: { path: '/tmp/conformance-prime-agent/a.ts' },
          result: toolResult('edited'),
          isError: false,
        },
        'edit tool end → applied'
      ),
      // Prime-local quirk, captured verbatim at pi-agent-adapter.test.ts:940 —
      // an `edit` can arrive with empty args. The adapter's file-tool branch is
      // gated on a non-empty path, so this real shape falls through to the
      // generic tool lane and is the only captured Prime event that reaches
      // `dynamicToolCall`. It proves the generic lane maps id, arguments, and
      // result; it does NOT claim a Prime MCP tool was exercised.
      native(
        {
          type: 'tool_execution_start',
          toolCallId: 'conf-tool-generic',
          toolName: 'edit',
          args: {},
        },
        'pathless edit → dynamicToolCall'
      ),
      native(
        {
          type: 'tool_execution_end',
          toolCallId: 'conf-tool-generic',
          toolName: 'edit',
          args: {},
          result: toolResult('missing path'),
          isError: false,
        },
        'pathless edit end'
      ),
      native(
        { type: 'session_action_update', actions: { queuedCount: 0 } },
        'native queue depth report'
      ),
      native(
        { type: 'extension_error', error: 'conformance hook failed' },
        'nonfatal extension diagnostic'
      ),
      native(
        {
          type: 'message_end',
          message: {
            role: 'assistant',
            usage: {
              input: 10,
              output: 4,
              cacheRead: 2,
              cacheWrite: 1,
              cost: { total: 0.25 },
            },
          },
        },
        'assistant message end + usage'
      ),
      native({ type: 'turn_end' }, 'native turn boundary'),
      native({ type: 'agent_end' }, 'terminal agent_end'),
    ],
    expect: {
      terminalStatus: 'completed',
      requiredPatchTypes: [
        'agent-turn-started-v2',
        'agent-item-started-v2',
        'agent-item-delta-v2',
        'agent-item-updated-v2',
        'agent-live-state-updated-v2',
        'agent-turn-completed-v2',
      ],
      textIncludes: ['prime conformance answer', 'prime conformance reasoning'],
    },
  },

  interruptedTurn: {
    steps: [
      native(
        {
          type: 'message_update',
          assistantMessageEvent: {
            type: 'text_delta',
            contentIndex: 0,
            delta: 'prime conformance partial answer',
          },
        },
        'partial answer before the interrupt'
      ),
      // interruptAfter: 1 → the harness calls interrupt() here, which issues an
      // `abort` RPC; Prime then closes the run with its ordinary agent_end and
      // the adapter attributes the abort it requested.
      native({ type: 'agent_end' }, 'agent_end after abort'),
    ],
    interruptAfter: 1,
    expect: {
      terminalStatus: 'interrupted',
      requiredPatchTypes: ['agent-turn-completed-v2'],
    },
  },

  errorTurn: {
    steps: [
      native(
        {
          type: 'tool_execution_start',
          toolCallId: 'conf-tool-running',
          toolName: 'bash',
          args: { command: 'sleep 1' },
        },
        'tool still running when the failure lands'
      ),
      native(
        {
          type: 'auto_retry_end',
          success: false,
          finalError: 'conformance quota exhausted',
        },
        'exhausted retry → generation failure'
      ),
      native({ type: 'agent_end' }, 'terminal agent_end after failure'),
    ],
    expect: {
      terminalStatus: 'failed',
      requiredPatchTypes: ['agent-error-v2', 'agent-turn-completed-v2'],
    },
  },

  // No `approvalFlow`: the registry declares `approvals: false` and
  // `respondToApproval()` throws "Prime Agent RPC approvals are not mapped".
  // Prime's RPC surface has no permission-request frame to transcribe.

  allowedSilentEvents: [
    {
      match: (step) =>
        step.kind === 'native' &&
        (step.event as { type?: string }).type === 'message_start',
      reason:
        "message_start only advances the adapter-local assistant-message sequence so a tool loop's second assistant message gets fresh item ids; the content it announces arrives on later message_update frames, so emitting a patch here would invent an empty item",
    },
    {
      match: (step) =>
        step.kind === 'native' &&
        ((step.event as { type?: string }).type === 'turn_start' ||
          (step.event as { type?: string }).type === 'turn_end'),
      reason:
        'a Prime run contains several native turns but exactly one Relay turn; only agent_end is the Relay turn boundary, so mapping turn_start/turn_end to patches would terminalize a turn that is still running',
    },
  ],

  exercised: [
    'reasoning',
    'tools',
    'commandExecution',
    'fileChanges',
    'streaming',
    'telemetry',
  ],

  unexercisable: [
    {
      capability: 'resume',
      reason:
        'resume needs a second scripted client generation (--resume respawn) and is deep-tested in prime-agent-adapter.test.ts; the floor fixture drives one connection',
    },
    {
      capability: 'queue',
      reason:
        'queueing here means a second Relay turn in flight behind an unfinished one, which the one-turn-at-a-time floor transcript never creates; deep-tested in prime-agent-adapter.test.ts',
    },
    {
      capability: 'slashCommands',
      reason:
        'the /model and /thinking catalog is discovered over the control lane and executed via executeControlCommand, which the lifecycle harness does not drive; deep-tested in prime-agent-adapter.test.ts',
    },
  ],
};

export default fixture;
