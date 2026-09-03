/**
 * Conformance fixture for the `dsh` adapter (DeepSeek Harness ACP stdio lane).
 *
 * Every `session/update` payload below is transcribed from a real capture of
 * `deepseek-harness-acp` 0.0.1, committed redacted under `test/fixtures/dsh/`:
 * a prompt that ran `bash` and answered, a second prompt in the same session,
 * a cancelled prompt, and a `write` turn followed by a close/resume round trip.
 * The `session/request_permission` payload is transcribed from the harness's
 * own `packages/acp/acp/src/index.ts` `approval/request` bridge, which
 * hard-codes exactly those two one-shot options. No grammar is invented.
 *
 * Three protocol facts shape the script:
 *  - `session/prompt` is answered only when the WHOLE turn has settled, so the
 *    Relay turn ends on a `transport-reply` carrying its `stopReason` rather
 *    than on any notification.
 *  - `session/cancel` is a real cancellation: the same pending prompt settles
 *    with `stopReason: 'cancelled'`, and nothing is killed or respawned.
 *  - `session/request_permission` is a server-to-client REQUEST that blocks the
 *    agent until it is answered.
 *
 * Transport injection uses the adapter's existing client-factory seam — zero
 * production change. See `../stubs/dsh.stub.ts`.
 */
import { DshProtocolAdapter } from '../../../../../server/protocol-adapters/dsh-adapter.js';
import type {
  AcpNotification,
  AcpPeerRequest,
} from '../../../../../server/acp-client.js';
import { DSH_SESSION_ID, makeDshAcpClientDouble } from '../stubs/dsh.stub.js';
import type {
  AdapterConformanceFixture,
  FixtureFeedStep,
} from '../fixture-types.js';

/** One `session/update` notification, the envelope the server always uses. */
function update(
  body: Record<string, unknown>,
  label?: string
): FixtureFeedStep {
  const notification: AcpNotification = {
    method: 'session/update',
    params: { sessionId: DSH_SESSION_ID, update: body },
  };
  return label === undefined
    ? { kind: 'native', event: notification }
    : { kind: 'native', event: notification, label };
}

/** Settle the in-flight `session/prompt` — the ACP turn boundary. */
function settle(stopReason: string, label: string): FixtureFeedStep {
  return {
    kind: 'transport-reply',
    id: 'session/prompt',
    payload: stopReason,
    label,
  };
}

const BASH_CALL_ID = 'call_c480662a7758c60e63ff787b01b3ac60';
const WRITE_CALL_ID = 'call_fe4cde6217019bba8c1a45d8034732e4';

function updateKind(step: FixtureFeedStep): string | undefined {
  if (step.kind !== 'native') return undefined;
  const notification = step.event as AcpNotification;
  if (notification.method !== 'session/update') return undefined;
  const body = notification.params.update as { sessionUpdate?: string };
  return body.sessionUpdate;
}

const fixture: AdapterConformanceFixture = {
  adapterId: 'dsh',

  createRig() {
    const acp = makeDshAcpClientDouble();
    const adapter = new DshProtocolAdapter(acp.factory);

    return {
      adapter,
      config: {
        cwd: '/workspace',
        port: 3000,
        sessionId: 'conf-dsh',
        hookToken: 'conf',
        configDir: '/tmp/conf-config',
      },
      feed: (step) => {
        if (step.kind === 'native') {
          acp.emitNotification(step.event as AcpNotification);
          return;
        }
        if (step.kind === 'server-request') {
          acp.emitPeerRequest({
            id: step.id,
            method: step.method,
            params: (step.params ?? {}) as Record<string, unknown>,
          } satisfies AcpPeerRequest);
          return;
        }
        if (step.kind === 'transport-reply') {
          if (!acp.settlePrompt(String(step.payload)))
            throw new Error(
              'dsh conformance rig: no session/prompt is in flight to settle'
            );
          return;
        }
        throw new Error(`dsh conformance rig cannot feed a ${step.kind} step`);
      },
      dispose: async () => {
        // The double owns no child process, socket, or file — `stop()` is spied
        // and `disconnect()` already drove it.
      },
    };
  },

  // `connect()` resolves on the spied `start()` plus `session/new`, so no
  // server traffic can land while it is in flight.
  connect: { steps: [] },

  simpleTurn: {
    steps: [
      update(
        {
          sessionUpdate: 'agent_thought_chunk',
          messageId: '5ab4b814-9b85-46d1-b2ab-afb1a83a9b2f',
          content: {
            type: 'text',
            text: 'Run the command and reply with exactly DSH_LIVE_OK.',
          },
        },
        'committed thought'
      ),
      update(
        { sessionUpdate: 'usage_update', used: 9432, size: 1000000 },
        'context occupancy after the first model call'
      ),
      update(
        {
          sessionUpdate: 'tool_call',
          toolCallId: BASH_CALL_ID,
          title: 'bash',
          kind: 'other',
          status: 'in_progress',
          rawInput: {
            command: 'echo relay-acp',
            description: 'Echo the string relay-acp',
          },
        },
        'bash tool opens'
      ),
      update(
        {
          sessionUpdate: 'tool_call_update',
          toolCallId: BASH_CALL_ID,
          status: 'completed',
          content: [
            { type: 'content', content: { type: 'text', text: 'relay-acp\n' } },
          ],
        },
        'bash tool completes'
      ),
      update(
        {
          sessionUpdate: 'tool_call',
          toolCallId: WRITE_CALL_ID,
          title: 'write',
          kind: 'other',
          status: 'in_progress',
          rawInput: { file_path: '/workspace/acp-note.txt', content: 'done' },
        },
        'file editor opens'
      ),
      update(
        {
          sessionUpdate: 'tool_call_update',
          toolCallId: WRITE_CALL_ID,
          status: 'completed',
          content: [
            {
              type: 'content',
              content: {
                type: 'text',
                text: '<path>/workspace/acp-note.txt</path>',
              },
            },
          ],
        },
        'file editor completes'
      ),
      update(
        {
          sessionUpdate: 'agent_message_chunk',
          messageId: '44378f44-df27-4f8b-9621-b3a5663f412c',
          content: { type: 'text', text: 'DSH_LIVE_OK' },
        },
        'committed answer'
      ),
      update(
        { sessionUpdate: 'usage_update', used: 9238, size: 1000000 },
        'context occupancy after the final model call'
      ),
      settle('end_turn', 'session/prompt answers — the Relay turn boundary'),
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
      textIncludes: [
        'DSH_LIVE_OK',
        'Run the command and reply with exactly DSH_LIVE_OK.',
      ],
    },
  },

  interruptedTurn: {
    steps: [
      update(
        {
          sessionUpdate: 'agent_message_chunk',
          messageId: 'b556d5f4-ab82-4d52-a680-62e2dbebaa73',
          content: { type: 'text', text: 'partial answer before the stop' },
        },
        'partial answer before the interrupt'
      ),
      // interruptAfter: 1 → the harness calls interrupt() here. The adapter
      // sends `session/cancel` and the SAME pending prompt settles cancelled;
      // no process is killed and the ACP session survives for the next turn.
      settle('cancelled', 'session/prompt answers cancelled'),
    ],
    interruptAfter: 1,
    expect: {
      terminalStatus: 'interrupted',
      requiredPatchTypes: [
        'agent-item-delta-v2',
        'agent-item-updated-v2',
        'agent-turn-completed-v2',
      ],
    },
  },

  errorTurn: {
    steps: [
      update(
        {
          sessionUpdate: 'tool_call',
          toolCallId: BASH_CALL_ID,
          title: 'bash',
          kind: 'other',
          status: 'in_progress',
          rawInput: { command: 'echo relay-acp' },
        },
        'tool still running when the turn ends badly'
      ),
      settle('max_tokens', 'session/prompt answers with a failing stop reason'),
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

  approvalFlow: {
    request: [
      update(
        {
          sessionUpdate: 'tool_call',
          toolCallId: BASH_CALL_ID,
          title: 'bash',
          kind: 'other',
          status: 'in_progress',
          rawInput: { command: 'echo relay-acp' },
        },
        'the tool the permission request is about'
      ),
      {
        kind: 'server-request',
        id: 12,
        method: 'session/request_permission',
        params: {
          sessionId: DSH_SESSION_ID,
          toolCall: { toolCallId: BASH_CALL_ID },
          options: [
            { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
            { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
          ],
        },
        label: 'server asks the client for permission and blocks',
      },
    ],
    decision: { kind: 'accept', scope: 'once' },
    resolution: [
      update(
        {
          sessionUpdate: 'tool_call_update',
          toolCallId: BASH_CALL_ID,
          status: 'completed',
          content: [
            { type: 'content', content: { type: 'text', text: 'relay-acp\n' } },
          ],
        },
        'the approved tool runs'
      ),
      update(
        {
          sessionUpdate: 'agent_message_chunk',
          messageId: '1fe7c4cb-033e-453b-9db7-fb82cf97192c',
          content: { type: 'text', text: 'read' },
        },
        'answer after the approval'
      ),
      settle('end_turn', 'session/prompt answers'),
    ],
    expect: {
      terminalStatus: 'completed',
      requiredPatchTypes: [
        'agent-item-started-v2',
        'agent-item-updated-v2',
        'agent-turn-completed-v2',
      ],
    },
  },

  allowedSilentEvents: [
    {
      match: (step) => updateKind(step) === 'usage_update',
      reason:
        'usage_update reports context OCCUPANCY, not per-turn tokens; it is folded into the turn total and published once on agent-turn-completed-v2. A patch per reading would emit a token count for a turn that has not ended, and the readings go DOWN as well as up (compaction), so they are a level, not an event',
    },
  ],

  exercised: [
    'reasoning',
    'commandExecution',
    'fileChanges',
    'streaming',
    'telemetry',
    'approvals',
  ],

  unexercisable: [
    {
      capability: 'tools',
      reason:
        'the `tools` detector looks for mcpToolCall/dynamicToolCall, but the captured turns only used `bash` (mapped to commandExecution) and `write` (mapped to fileChange); driving dynamicToolCall would mean inventing a tool name no captured dsh stream contains. It is deep-tested with a real `todo_write` shape in dsh-adapter.test.ts',
    },
    {
      capability: 'questions',
      reason:
        'declared false and respondToInput throws "dsh ACP questions are not mapped"; the ACP server documents elicitation as unsupported and sends no question frame, so there is nothing to script',
    },
    {
      capability: 'queue',
      reason:
        'the Relay-local send queue only fills when a second sendMessage arrives while a turn is active, which the single-turn conformance script never does; it is deep-tested in dsh-adapter.test.ts',
    },
    {
      capability: 'resume',
      reason:
        'resume is a CONNECT-time behavior (`session/resume` instead of `session/new`), and the conformance rig connects exactly once with no resumeSessionId; the request shape and the refused-resume fallback are deep-tested in dsh-adapter.test.ts against a real captured close/resume round trip',
    },
  ],
};

export default fixture;
