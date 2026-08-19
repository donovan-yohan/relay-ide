/**
 * Conformance fixture for the `pi` adapter (`pi --mode rpc` JSONL child).
 *
 * Every native payload below is transcribed from a real captured Pi RPC frame
 * already asserted in `pi-agent-adapter.test.ts`: the `get_state` start payload
 * (`sessionId` / `sessionFile` / `isStreaming`, lines 20-46), `message_start`,
 * `message_update` with `text_delta` / `thinking_delta`, the
 * `tool_execution_start` / `_update` / `_end` triple with its MCP-style
 * `{ content: [{ type: 'text', text }] }` result, `message_end` with the
 * `{ input, output, cacheRead, cacheWrite, cost: { total } }` usage payload,
 * `auto_retry_end`, `agent_end`, and `agent_settled`. No grammar is invented.
 *
 * Transport injection uses the adapter's existing client-factory seam — zero
 * production change. See `../stubs/pi.stub.ts`.
 *
 * Pi declares `approvals: false` (`respondToApproval` throws outright), so this
 * fixture scripts no approval flow and approvals reconciles as UNKNOWN.
 */
import { PiAgentProtocolAdapter } from '../../../../../server/protocol-adapters/pi-agent-adapter.js';
import type { PiAgentRpcMessage } from '../../../../../server/pi-agent-rpc-client.js';
import { makePiRpcClientDouble } from '../stubs/pi.stub.js';
import type {
  AdapterConformanceFixture,
  FixtureFeedStep,
} from '../fixture-types.js';

function native(event: unknown, label?: string): FixtureFeedStep {
  return label === undefined
    ? { kind: 'native', event }
    : { kind: 'native', event, label };
}

/** MCP-style tool result envelope Pi wraps every tool payload in. */
function toolResult(text: string): Record<string, unknown> {
  return { content: [{ type: 'text', text }] };
}

function eventType(step: FixtureFeedStep): string | undefined {
  return step.kind === 'native'
    ? (step.event as { type?: string }).type
    : undefined;
}

const fixture: AdapterConformanceFixture = {
  adapterId: 'pi',

  createRig() {
    const rpc = makePiRpcClientDouble();
    const adapter = new PiAgentProtocolAdapter(rpc.factory);

    return {
      adapter,
      config: {
        cwd: '/tmp/conformance-pi',
        port: 3000,
        sessionId: 'conf-pi',
        hookToken: 'conf',
        configDir: '/tmp/conf-config',
      },
      feed: (step) => {
        if (step.kind !== 'native') {
          throw new Error(
            `pi conformance rig only feeds native RPC frames, got ${step.kind}`
          );
        }
        rpc.emit(step.event as PiAgentRpcMessage);
      },
      dispose: async () => {
        // The double owns no child process, socket, or file — `stop()` is spied
        // and `disconnect()` already drove it.
      },
    };
  },

  // `connect()` resolves on the spied `start()` (the `get_state` response), so
  // no native frame can land while it is in flight.
  connect: { steps: [] },

  simpleTurn: {
    steps: [
      native(
        { type: 'message_start', message: { role: 'assistant' } },
        'assistant message opens'
      ),
      native(
        {
          type: 'message_update',
          assistantMessageEvent: {
            type: 'text_delta',
            contentIndex: 0,
            delta: 'Pi conformance ',
          },
        },
        'first text_delta'
      ),
      native(
        {
          type: 'message_update',
          assistantMessageEvent: {
            type: 'text_delta',
            contentIndex: 0,
            delta: 'answer',
          },
        },
        'second text_delta on the same content index'
      ),
      native(
        {
          type: 'message_update',
          assistantMessageEvent: {
            type: 'thinking_delta',
            contentIndex: 1,
            delta: 'conformance thought',
          },
        },
        'thinking_delta'
      ),
      native(
        {
          type: 'tool_execution_start',
          toolCallId: 'pi-conf-bash-1',
          toolName: 'bash',
          args: { command: 'pwd' },
        },
        'bash tool starts'
      ),
      native(
        {
          type: 'tool_execution_update',
          toolCallId: 'pi-conf-bash-1',
          toolName: 'bash',
          args: { command: 'pwd' },
          partialResult: toolResult('/tmp/conf'),
        },
        'partial bash output'
      ),
      native(
        {
          type: 'tool_execution_end',
          toolCallId: 'pi-conf-bash-1',
          toolName: 'bash',
          args: { command: 'pwd' },
          result: toolResult('/tmp/conformance-pi'),
          isError: false,
        },
        'bash tool completes'
      ),
      native(
        {
          type: 'tool_execution_start',
          toolCallId: 'pi-conf-edit-1',
          toolName: 'edit',
          args: { path: '/tmp/conformance-pi/answer.ts' },
        },
        'edit tool starts (fileChange item)'
      ),
      native(
        {
          type: 'tool_execution_end',
          toolCallId: 'pi-conf-edit-1',
          toolName: 'edit',
          args: { path: '/tmp/conformance-pi/answer.ts' },
          result: toolResult('applied'),
          isError: false,
        },
        'edit tool completes'
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
        'message_end carrying usage'
      ),
      native(
        { type: 'agent_end', messages: [] },
        'agent_end (not the boundary)'
      ),
      native(
        { type: 'agent_settled' },
        'agent_settled — the Relay turn boundary'
      ),
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
      textIncludes: ['Pi conformance answer', 'conformance thought'],
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
            delta: 'Pi conformance long answer',
          },
        },
        'partial answer before the interrupt'
      ),
      // interruptAfter: 1 → the harness calls interrupt() here; the adapter
      // sends the `abort` RPC and Pi still emits its settled boundary.
      native({ type: 'agent_settled' }, 'agent_settled after abort'),
    ],
    interruptAfter: 1,
    expect: {
      terminalStatus: 'interrupted',
      requiredPatchTypes: ['agent-item-delta-v2', 'agent-turn-completed-v2'],
    },
  },

  errorTurn: {
    steps: [
      native(
        {
          type: 'tool_execution_start',
          toolCallId: 'pi-conf-error-tool',
          toolName: 'bash',
          args: { command: 'sleep 1' },
        },
        'tool still running when generation fails'
      ),
      native(
        {
          type: 'auto_retry_end',
          success: false,
          finalError: 'Pi conformance quota exhausted',
        },
        'exhausted retry marks the turn failed'
      ),
      native({ type: 'agent_settled' }, 'agent_settled after the failure'),
    ],
    expect: {
      terminalStatus: 'failed',
      requiredPatchTypes: [
        'agent-error-v2',
        'agent-item-updated-v2',
        'agent-turn-completed-v2',
      ],
    },
  },

  allowedSilentEvents: [
    {
      match: (step) => eventType(step) === 'message_start',
      reason:
        'message_start only opens a native assistant message and advances the per-message index the adapter builds stable item ids from; nothing is renderable until the first content delta arrives, which is the patch that creates the item',
    },
    {
      match: (step) => eventType(step) === 'agent_end',
      reason:
        'Pi emits agent_end BEFORE agent_settled and may still follow it with an automatic retry, compaction retry, or queued continuation. Completing a Relay turn on agent_end would terminalize a turn the provider has not finished, so producing no patch here is the contract — agent_settled is the boundary (deep-tested in pi-agent-adapter.test.ts)',
    },
  ],

  exercised: [
    'reasoning',
    'commandExecution',
    'fileChanges',
    'streaming',
    'telemetry',
  ],

  unexercisable: [
    {
      capability: 'tools',
      reason:
        'the `tools` detector looks for mcpToolCall/dynamicToolCall, but Pi maps `bash` to commandExecution and `edit` to fileChange, and those are the only tool names present in any captured Pi stream in this repo — driving dynamicToolCall would mean inventing a tool name',
    },
    {
      capability: 'approvals',
      reason:
        'the registry declares approvals:false and respondToApproval throws "Pi RPC approvals are not mapped"; no permission-request frame exists in the captured Pi RPC grammar to script, so approvals stays UNKNOWN rather than a false pass',
    },
    {
      capability: 'questions',
      reason:
        'declared false and respondToInput throws "Pi RPC questions are not mapped"; no question/input frame appears in any captured Pi stream',
    },
    {
      capability: 'queue',
      reason:
        'Relay-local queueing means two overlapping turns, and the floor drives one turn at a time; the queue-advance ladder and its agent_settled boundaries are deep-tested in pi-agent-adapter.test.ts',
    },
    {
      capability: 'resume',
      reason:
        'resume needs a second connect generation carrying --session-id, which the single-rig floor transcript does not script; deep-tested in pi-agent-adapter.test.ts',
    },
    {
      capability: 'compact',
      reason:
        'compaction runs through the native `compact` RPC (a /compact prompt) or a compaction_end frame, neither of which the floor transcript scripts',
    },
  ],
};

export default fixture;
