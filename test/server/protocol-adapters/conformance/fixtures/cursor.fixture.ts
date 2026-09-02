/**
 * Conformance fixture for the `cursor` adapter (Cursor CLI ACP stdio lane).
 *
 * Transcribed from real Cursor Agent ACP wire captures:
 * - test/fixtures/cursor/acp-turn-capture.redacted.ndjson
 * - test/fixtures/cursor/acp-resume-capture.redacted.ndjson
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

const EXEC_CALL_ID =
  'call-43505e8d-57f2-465c-8b98-90ccb69d7a29-0\nfc_72f1634d-bd62-9da8-8795-1bacc0114f7d_0';
const EDIT_CALL_ID = 'replay-0-2';

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
          content: {
            type: 'text',
            text: 'Running `echo CURSOR_LIVE_OK` and replying with exactly that text.',
          },
        },
        'committed thought'
      ),
      update(
        {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'Running that now.' },
        },
        'initial message stream'
      ),
      update(
        {
          sessionUpdate: 'tool_call',
          toolCallId: EXEC_CALL_ID,
          title: '`echo CURSOR_LIVE_OK`',
          kind: 'execute',
          status: 'pending',
          rawInput: { command: 'echo CURSOR_LIVE_OK' },
        },
        'execute tool opens'
      ),
      update(
        {
          sessionUpdate: 'tool_call_update',
          toolCallId: EXEC_CALL_ID,
          status: 'completed',
          rawOutput: {
            exitCode: 0,
            stdout: 'CURSOR_LIVE_OK\n',
            stderr: '',
          },
        },
        'execute tool completes with exit code and stdout'
      ),
      update(
        {
          sessionUpdate: 'tool_call',
          toolCallId: EDIT_CALL_ID,
          title: 'Edit `/workspace/cursor-note.txt`',
          kind: 'edit',
          status: 'pending',
          rawInput: { path: '/workspace/cursor-note.txt' },
          locations: [{ path: '/workspace/cursor-note.txt' }],
        },
        'file edit tool opens'
      ),
      update(
        {
          sessionUpdate: 'tool_call_update',
          toolCallId: EDIT_CALL_ID,
          status: 'completed',
          content: [
            {
              type: 'diff',
              path: '/workspace/cursor-note.txt',
              oldText: '-- /dev/null',
              newText: '++ b//workspace/cursor-note.txt\nrelay-cursor-proof',
            },
          ],
        },
        'file edit completes with unified diff content'
      ),
      update(
        {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'CURSOR_LIVE_OK' },
        },
        'committed answer'
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
        'Running `echo CURSOR_LIVE_OK` and replying with exactly that text.',
      ],
    },
  },

  interruptedTurn: {
    steps: [
      update(
        {
          sessionUpdate: 'agent_message_chunk',
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
          toolCallId: EXEC_CALL_ID,
          title: '`echo CURSOR_LIVE_OK`',
          kind: 'execute',
          status: 'pending',
          rawInput: { command: 'echo CURSOR_LIVE_OK' },
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
          toolCallId: EXEC_CALL_ID,
          title: '`echo CURSOR_LIVE_OK`',
          kind: 'execute',
          status: 'pending',
          rawInput: { command: 'echo CURSOR_LIVE_OK' },
        },
        'the tool the permission request is about'
      ),
      {
        kind: 'server-request',
        id: 12,
        method: 'session/request_permission',
        params: {
          sessionId: CURSOR_SESSION_ID,
          toolCall: {
            toolCallId: EXEC_CALL_ID,
            title: '`echo CURSOR_LIVE_OK`',
            kind: 'execute',
            status: 'pending',
            content: [
              {
                type: 'content',
                content: { type: 'text', text: 'Not in allowlist: echo' },
              },
            ],
          },
          options: [
            {
              optionId: 'allow-once',
              name: 'Allow once',
              kind: 'allow_once',
            },
            {
              optionId: 'allow-always',
              name: 'Allow always',
              kind: 'allow_always',
            },
            {
              optionId: 'reject-once',
              name: 'Reject',
              kind: 'reject_once',
            },
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
          toolCallId: EXEC_CALL_ID,
          status: 'completed',
          rawOutput: {
            exitCode: 0,
            stdout: 'CURSOR_LIVE_OK\n',
            stderr: '',
          },
        },
        'the approved tool runs'
      ),
      update(
        {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'CURSOR_LIVE_OK' },
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

  allowedSilentEvents: [],

  exercised: [
    'reasoning',
    'commandExecution',
    'fileChanges',
    'streaming',
    'approvals',
  ],

  unexercisable: [
    {
      capability: 'telemetry',
      reason:
        'Cursor ACP stdio lane in 2026.08.31 does not emit usage_update notifications; telemetry is handled when present.',
    },
    {
      capability: 'tools',
      reason:
        'the `tools` detector looks for dynamicToolCall, but the simpleTurn uses `execute` (mapped to commandExecution) and `edit` (mapped to fileChange). Dynamic tool calls are deep-tested in cursor-adapter.test.ts',
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
