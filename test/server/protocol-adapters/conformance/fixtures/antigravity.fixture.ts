/**
 * Conformance fixture for the `antigravity` adapter (stream-json subprocess).
 *
 * Every native payload below is transcribed from a real captured stream-json
 * capture: `p1` (init, user_input, planning DONE, write_to_file, view_file,
 * text delta, result SUCCESS), `p5d` (interrupt over run_command + result ERROR),
 * and `p6` (startup/model result ERROR).
 */
import { AntigravityProtocolAdapter } from '../../../../../server/protocol-adapters/antigravity-adapter.js';
import { AdapterProcessRegistry } from '../../../../../server/protocol-adapters/adapter-utils.js';
import {
  ANTIGRAVITY_SESSION,
  makeAntigravityChildHarness,
} from '../stubs/antigravity.stub.js';
import type { MockChild } from '../../support/claude-child-double.js';
import type {
  AdapterConformanceFixture,
  FixtureFeedStep,
} from '../fixture-types.js';

function native(event: unknown, label?: string): FixtureFeedStep {
  return label === undefined
    ? { kind: 'native', event }
    : { kind: 'native', event, label };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const fixture: AdapterConformanceFixture = {
  adapterId: 'antigravity',

  createRig() {
    const harness = makeAntigravityChildHarness();
    const adapter = new AntigravityProtocolAdapter(
      harness.spawnFn,
      new AdapterProcessRegistry(1_000_000)
    );

    const currentChild = async (): Promise<MockChild> => {
      const deadline = Date.now() + 1_000;
      while (Date.now() < deadline) {
        const record = harness.spawns[harness.spawns.length - 1];
        if (record) return record.child;
        await sleep(1);
      }
      throw new Error(
        'antigravity conformance rig: no child process was spawned'
      );
    };

    return {
      adapter,
      config: {
        cwd: '/tmp/conformance-antigravity',
        port: 3000,
        sessionId: 'conf-antigravity',
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
            `antigravity conformance rig only feeds native stdout lines, got ${step.kind}`
          );
        }
        child.serverWrite(step.event);
      },
      dispose: async () => {},
    };
  },

  connect: {
    steps: [
      native(
        {
          event: 'init',
          conversation_id: ANTIGRAVITY_SESSION,
          init: {
            cwd: '/tmp/conformance-antigravity',
            tools: [
              'write_to_file',
              'view_file',
              'run_command',
              'invoke_subagent',
            ],
            permission_mode: 'always-proceed',
          },
        },
        'stream-json init'
      ),
    ],
  },

  simpleTurn: {
    steps: [
      native(
        {
          event: 'step_update',
          step_update: {
            conversation_id: ANTIGRAVITY_SESSION,
            step_index: 0,
            state: 'DONE',
            step_type: 'user_input',
          },
        },
        'user_input echo'
      ),
      native(
        {
          event: 'step_update',
          step_update: {
            conversation_id: ANTIGRAVITY_SESSION,
            step_index: 1,
            state: 'DONE',
            step_type: 'agent_response',
            duration_seconds: 3.00221003,
            usage: {
              input_tokens: 13935,
              output_tokens: 700,
              thinking_tokens: 620,
              cache_read_tokens: 0,
              total_tokens: 14635,
            },
          },
        },
        'tool planning step'
      ),
      native(
        {
          event: 'step_update',
          step_update: {
            conversation_id: ANTIGRAVITY_SESSION,
            step_index: 2,
            state: 'ACTIVE',
            step_type: 'tool',
            tool_name: 'write_to_file',
            tool_info: {
              name: 'write_to_file',
              parameters: {
                TargetFile: '/tmp/conformance-antigravity/hello.txt',
              },
            },
          },
        },
        'write_to_file active'
      ),
      native(
        {
          event: 'step_update',
          step_update: {
            conversation_id: ANTIGRAVITY_SESSION,
            step_index: 2,
            state: 'DONE',
            step_type: 'tool',
            tool_name: 'write_to_file',
            duration_seconds: 0.056964863,
            tool_info: {
              name: 'write_to_file',
              parameters: {
                TargetFile: '/tmp/conformance-antigravity/hello.txt',
              },
            },
          },
        },
        'write_to_file done'
      ),
      native(
        {
          event: 'step_update',
          step_update: {
            conversation_id: ANTIGRAVITY_SESSION,
            step_index: 3,
            state: 'DONE',
            step_type: 'agent_response',
            duration_seconds: 1.019744999,
            usage: {
              input_tokens: 14752,
              output_tokens: 64,
              thinking_tokens: 9,
              cache_read_tokens: 0,
              total_tokens: 14816,
            },
          },
        },
        'second tool planning step'
      ),
      native(
        {
          event: 'step_update',
          step_update: {
            conversation_id: ANTIGRAVITY_SESSION,
            step_index: 4,
            state: 'ACTIVE',
            step_type: 'tool',
            tool_name: 'view_file',
            tool_info: {
              name: 'view_file',
              parameters: {
                AbsolutePath: '/tmp/conformance-antigravity/hello.txt',
              },
            },
          },
        },
        'view_file active'
      ),
      native(
        {
          event: 'step_update',
          step_update: {
            conversation_id: ANTIGRAVITY_SESSION,
            step_index: 4,
            state: 'DONE',
            step_type: 'tool',
            tool_name: 'view_file',
            duration_seconds: 0.072764443,
            tool_info: {
              name: 'view_file',
              parameters: {
                AbsolutePath: '/tmp/conformance-antigravity/hello.txt',
              },
              output: '2 lines, 10 bytes',
            },
          },
        },
        'view_file done'
      ),
      native(
        {
          event: 'step_update',
          step_update: {
            conversation_id: ANTIGRAVITY_SESSION,
            step_index: 5,
            state: 'ACTIVE',
            step_type: 'agent_response',
            text_delta: 'Contents of hello.txt',
          },
        },
        'text delta active'
      ),
      native(
        {
          event: 'step_update',
          step_update: {
            conversation_id: ANTIGRAVITY_SESSION,
            step_index: 5,
            state: 'DONE',
            step_type: 'agent_response',
            text_delta: '\n',
            duration_seconds: 1.365073748,
            usage: {
              input_tokens: 15005,
              output_tokens: 91,
              thinking_tokens: 53,
              cache_read_tokens: 0,
              total_tokens: 15096,
            },
          },
        },
        'text delta done'
      ),
      native(
        {
          event: 'result',
          result: {
            conversation_id: ANTIGRAVITY_SESSION,
            status: 'SUCCESS',
            response: 'Contents of hello.txt\n',
            duration_seconds: 5.435564963,
            num_turns: 1,
            usage: {
              input_tokens: 43692,
              output_tokens: 855,
              thinking_tokens: 682,
              cache_read_tokens: 0,
              total_tokens: 44547,
            },
          },
        },
        'terminal result success'
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
      textIncludes: ['Contents of hello.txt'],
    },
  },

  interruptedTurn: {
    steps: [
      native(
        {
          event: 'step_update',
          step_update: {
            conversation_id: ANTIGRAVITY_SESSION,
            step_index: 0,
            state: 'DONE',
            step_type: 'user_input',
          },
        },
        'user_input echo'
      ),
      native(
        {
          event: 'step_update',
          step_update: {
            conversation_id: ANTIGRAVITY_SESSION,
            step_index: 1,
            state: 'DONE',
            step_type: 'agent_response',
            duration_seconds: 2.0,
            usage: {
              input_tokens: 13930,
              output_tokens: 788,
              thinking_tokens: 715,
              cache_read_tokens: 0,
              total_tokens: 14718,
            },
          },
        },
        'agent planning'
      ),
      native(
        {
          event: 'step_update',
          step_update: {
            conversation_id: ANTIGRAVITY_SESSION,
            step_index: 2,
            state: 'ACTIVE',
            step_type: 'tool',
            tool_name: 'run_command',
            tool_info: {
              name: 'run_command',
              parameters: {
                CommandLine: 'sleep 25 && echo finished',
              },
            },
          },
        },
        'run_command active before interrupt'
      ),
      native(
        {
          event: 'result',
          result: {
            conversation_id: ANTIGRAVITY_SESSION,
            status: 'ERROR',
            response: '',
            error: 'timeout waiting for response',
            duration_seconds: 3.1,
            num_turns: 1,
            usage: {
              input_tokens: 13930,
              output_tokens: 788,
              thinking_tokens: 715,
              cache_read_tokens: 0,
              total_tokens: 14718,
            },
          },
        },
        'result error after SIGINT'
      ),
      { kind: 'close', code: 1, label: 'child exits after SIGINT' },
    ],
    interruptAfter: 3,
    expect: { terminalStatus: 'interrupted' },
  },

  errorTurn: {
    steps: [
      native(
        {
          event: 'step_update',
          step_update: {
            conversation_id: ANTIGRAVITY_SESSION,
            step_index: 0,
            state: 'DONE',
            step_type: 'user_input',
          },
        },
        'user_input echo'
      ),
      native(
        {
          event: 'result',
          result: {
            conversation_id: ANTIGRAVITY_SESSION,
            status: 'ERROR',
            response: '',
            error: 'invalid model selection',
            duration_seconds: 0,
            num_turns: 0,
            usage: {
              input_tokens: 0,
              output_tokens: 0,
              thinking_tokens: 0,
              cache_read_tokens: 0,
              total_tokens: 0,
            },
          },
        },
        'result error terminal'
      ),
      { kind: 'close', code: 1, label: 'child exits after error' },
    ],
    expect: {
      terminalStatus: 'failed',
      requiredPatchTypes: ['agent-error-v2', 'agent-turn-completed-v2'],
    },
  },

  allowedSilentEvents: [
    {
      match: (step) =>
        step.kind === 'native' &&
        (step.event as { step_update?: { step_type?: string } }).step_update
          ?.step_type === 'user_input',
      reason:
        'user_input echo produces no patch because Relay already emitted the userMessage item for the turn',
    },
    {
      match: (step) => {
        if (step.kind !== 'native') return false;
        const su = (
          step.event as {
            step_update?: {
              step_type?: string;
              state?: string;
              text_delta?: string;
            };
          }
        ).step_update;
        return (
          su?.step_type === 'agent_response' &&
          su?.state === 'DONE' &&
          su?.text_delta === undefined
        );
      },
      reason:
        'agent_response DONE without text represents tool planning; its token usage is accumulated into turn completion without emitting an assistant card',
    },
  ],

  exercised: [
    'commandExecution',
    'fileChanges',
    'tools',
    'streaming',
    'telemetry',
  ],

  unexercisable: [
    {
      capability: 'approvals',
      reason:
        'Antigravity stream-json declares approvals:false and has no permission request/answer protocol; respondToApproval throws',
    },
    {
      capability: 'questions',
      reason:
        'Antigravity stream-json declares questions:false; respondToInput throws',
    },
    {
      capability: 'queue',
      reason:
        'Relay-local turn queueing requires concurrent in-flight turns which the single-turn conformance transcript does not drive',
    },
    {
      capability: 'resume',
      reason:
        'resume requires a second connect generation carrying --conversation which the single-rig transcript does not script',
    },
    {
      capability: 'reasoning',
      reason:
        'Antigravity stream-json does not stream reasoning text; thinking tokens are reported only in step usage metrics',
    },
  ],
};

export default fixture;
