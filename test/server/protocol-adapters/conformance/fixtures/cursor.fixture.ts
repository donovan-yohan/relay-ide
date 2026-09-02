/**
 * Conformance fixture for the `cursor` adapter (Cursor CLI ACP stdio lane).
 *
 * Transcribed from real Cursor Agent ACP interactions on stdio.
 */
import { CursorProtocolAdapter } from '../../../../../server/protocol-adapters/cursor-adapter.js';
import type {
  AcpNotification,
  AcpPeerRequest,
} from '../../../../../server/acp-client.js';
import {
  CURSOR_SESSION_ID,
  makeCursorAcpClientDouble,
} from '../stubs/cursor.stub.js';
import type {
  AdapterConformanceFixture,
  FixtureFeedStep,
} from '../fixture-types.js';

function update(
  body: Record<string, unknown>,
  label?: string
): FixtureFeedStep {
  const notification: AcpNotification = {
    method: 'session/update',
    params: { sessionId: CURSOR_SESSION_ID, update: body },
  };
  return label === undefined
    ? { kind: 'native', event: notification }
    : { kind: 'native', event: notification, label };
}

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
  adapterId: 'cursor',

  createRig() {
    const acp = makeCursorAcpClientDouble();
    const adapter = new CursorProtocolAdapter(acp.factory);

    return {
      adapter,
      config: {
        cwd: '/workspace',
        port: 3000,
        sessionId: 'conf-cursor',
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
              'cursor conformance rig: no session/prompt is in flight to settle'
            );
          return;
        }
        throw new Error(
          `cursor conformance rig cannot feed a ${step.kind} step`
        );
      },
      dispose: async () => {},
    };
  },

  connect: { steps: [] },

  simpleTurn: {
    steps: [
      update(
        {
          sessionUpdate: 'agent_thought_chunk',
          messageId: '5ab4b814-9b85-46d1-b2ab-afb1a83a9b2f',
          content: {
            type: 'text',
            text: 'Run the command and reply with exactly CURSOR_LIVE_OK.',
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
          status: 'in_progress',
          rawInput: {
            file_path: '/workspace/cursor-note.txt',
            content: 'done',
          },
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
                text: 'done',
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
          content: { type: 'text', text: 'CURSOR_LIVE_OK' },
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
        'CURSOR_LIVE_OK',
        'Run the command and reply with exactly CURSOR_LIVE_OK.',
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
          sessionId: CURSOR_SESSION_ID,
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
        'usage_update reports context OCCUPANCY, not per-turn tokens; it is folded into the turn total and published once on agent-turn-completed-v2.',
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
        'the `tools` detector looks for mcpToolCall/dynamicToolCall, but the simpleTurn uses `bash` (mapped to commandExecution) and `write` (mapped to fileChange). Dynamic tool calls are deep-tested in cursor-adapter.test.ts',
    },
    {
      capability: 'questions',
      reason:
        'questions arrive as `cursor/ask_question` server peer requests outside the standard 4-turn conformance lifecycle; elicitation and response mapping are deep-tested in cursor-adapter.test.ts',
    },
    {
      capability: 'plans',
      reason:
        'plans arrive as `cursor/create_plan` server peer requests outside the standard 4-turn conformance lifecycle; plan creation and auto-acceptance are deep-tested in cursor-adapter.test.ts',
    },
    {
      capability: 'queue',
      reason:
        'the Relay-local send queue only fills when a second sendMessage arrives while a turn is active, which the single-turn conformance script never does; it is deep-tested in cursor-adapter.test.ts',
    },
    {
      capability: 'resume',
      reason:
        'resume is a CONNECT-time behavior (`session/load` instead of `session/new`), and the conformance rig connects once with no resumeSessionId; session/load and refused-resume fallbacks are deep-tested in cursor-adapter.test.ts',
    },
  ],
};

export default fixture;
