/**
 * Conformance fixture for the `hermes` adapter (Responses-API gateway, wrapped
 * by `LegacyProtocolAdapterV2Bridge`).
 *
 * Every native payload below is transcribed from a real captured Hermes
 * Responses stream already asserted elsewhere in this repo:
 *
 * - `test/fixtures/agent-detail/hermes.ts` — the sanitized recorded transcript
 *   (`response.created`, `reasoning_summary_text.delta/.done`,
 *   `output_item.added/.done` for `run_command` and `apply_patch`).
 * - `test/server/protocol-adapters/hermes-adapter.test.ts` — the v0.18.2
 *   `message` output-item reply shape (lines 838-873), the
 *   `function_call_arguments.delta/.done` buffering shape (lines 463-540), the
 *   `apply_patch` unified-diff shape (lines 542-580), the `response.error`
 *   failure shape (lines 348-379) and the `response.completed` usage payload
 *   (lines 777-809).
 *
 * DELIBERATELY ABSENT: `response.output_text.delta`. The adapter maps it and
 * `hermes-adapter.test.ts` scripts it, but the shipping Hermes gateway
 * (v0.18.2) never emits it — it delivers the reply as a `message` output-item
 * (#1305, continuing #1181). A floor fixture that manufactured token deltas
 * would assert a stream the provider does not produce, so this transcript uses
 * the shape the gateway actually sends and leaves `output_text.delta` to the
 * deep tests.
 *
 * The permission shape is the one derived (not recorded) payload and is called
 * out below.
 *
 * Transport: an in-process gateway (`../stubs/hermes.stub.ts`) reached through
 * `config.extra.endpoint`/`apiToken`, which outrank every env and `config.yaml`
 * lookup in `resolveHermesGatewaySettings` — so this fixture never touches HOME
 * and cannot reach a developer's live Hermes.
 */
import { HermesProtocolAdapter } from '../../../../../server/protocol-adapters/hermes-adapter.js';
import { LegacyProtocolAdapterV2Bridge } from '../../../../../server/protocol-adapters/legacy-v2-bridge.js';
import {
  startHermesGatewayStub,
  type HermesGatewayStub,
} from '../stubs/hermes.stub.js';
import type {
  AdapterConformanceFixture,
  FixtureFeedStep,
} from '../fixture-types.js';

const SESSION = 'conf-hermes';

/**
 * Hand-transcribed twin of the `hermes` capability block in
 * `PROVIDER_DESCRIPTORS.hermes.bridgedCapabilities`
 * (`server/protocol-adapters/index.ts`), including the
 * `telemetry: false` honesty note. The suite's registry-parity test compares
 * this against the registered factory, so a drifted copy fails loudly. The
 * registry set is total over `AgentCapabilitySetV2`, so this twin is too.
 */
const HERMES_CAPABILITIES = {
  text: true,
  reasoning: true,
  tools: true,
  commandExecution: true,
  fileChanges: true,
  approvals: true,
  questions: false,
  plans: false,
  slashCommands: false,
  queue: false,
  steer: false,
  interrupt: true,
  cancelQueued: false,
  resume: true,
  fork: false,
  rollback: false,
  compact: false,
  // `HermesProtocolAdapter` emits `chat:telemetry`, but
  // `mapChatEventToAgentPatchV2` has no case for it, so the bridge drops it
  // before the V2 stream (#1104). The flag stays false until that mapping
  // exists; this fixture drives a real `usage` payload to keep that honest.
  telemetry: false,
  rateLimits: false,
  // Unset in the registry until the gateway emits `response.output_text.delta`
  // (#1305); stated here because the transcription is total.
  streaming: false,
} as const;

/** Captured `apply_patch` output: a created-file unified diff. */
const ADDED_FILE_DIFF =
  '--- /dev/null\n+++ b/src/created.ts\n@@ -0,0 +1 @@\n+export const created = true;\n';

const COMMAND_OUTPUT =
  'export interface SyntheticHermesValue {\n  ready: boolean;\n}';

const REASONING =
  'Hermes synthetic thought: inspect the tool event before returning output.';

const ASSISTANT_TEXT = 'Hello from the hermes conformance floor';

function native(event: unknown, label?: string): FixtureFeedStep {
  return label === undefined
    ? { kind: 'native', event }
    : { kind: 'native', event, label };
}

/**
 * Hermes ends a turn on the SSE stream, but `sendMessage` only resolves once
 * `consumeResponsesSse` sees end-of-stream — so every turn script closes the
 * stream after its terminal frame. `close` steps are exempt from the
 * no-silent-drop ledger by construction.
 */
const CLOSE_STREAM: FixtureFeedStep = {
  kind: 'close',
  label: 'gateway ends the response stream',
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function eventType(step: FixtureFeedStep): string | undefined {
  if (step.kind !== 'native') return undefined;
  const type = (step.event as { type?: unknown }).type;
  return typeof type === 'string' ? type : undefined;
}

const fixture: AdapterConformanceFixture = {
  adapterId: 'hermes',

  async createRig() {
    const gateway: HermesGatewayStub = await startHermesGatewayStub();
    const adapter = new LegacyProtocolAdapterV2Bridge(
      new HermesProtocolAdapter(),
      HERMES_CAPABILITIES
    );

    // The rig counts patches itself so `settle()` can wait for real quiescence
    // over a loopback socket: unlike an in-process stdout double, an SSE frame
    // needs a kernel round trip before the adapter maps it, and the harness's
    // default 3×1ms quiet poll can win that race and mis-file a live event as a
    // silent drop.
    let seen = 0;
    adapter.onPatch(() => {
      seen += 1;
    });

    return {
      adapter,
      config: {
        cwd: '/tmp/conformance-hermes',
        port: 3000,
        sessionId: SESSION,
        hookToken: 'conf',
        configDir: '/tmp/conf-config',
        extra: { endpoint: gateway.endpoint, apiToken: 'conf-hermes-key' },
      },
      feed: async (step) => {
        if (step.kind === 'close') {
          gateway.endStream();
          return;
        }
        if (step.kind !== 'native') {
          throw new Error(
            `hermes conformance rig only feeds native SSE frames, got ${step.kind}`
          );
        }
        await gateway.push(step.event);
      },
      settle: async () => {
        const deadline = Date.now() + 500;
        let stable = 0;
        let last = seen;
        while (Date.now() < deadline) {
          await sleep(2);
          if (seen === last) {
            stable += 1;
            if (stable >= 10) return;
          } else {
            stable = 0;
            last = seen;
          }
        }
      },
      dispose: async () => {
        await gateway.close();
      },
    };
  },

  // `connect()` only probes `/health` + `/v1/models` and then announces the
  // session; there is no native frame to script.
  connect: { steps: [] },

  simpleTurn: {
    prompt: 'run the synthetic check and patch the created file',
    steps: [
      native(
        { type: 'response.created', response: { id: 'resp_conf_simple' } },
        'response.created'
      ),
      native(
        { type: 'response.reasoning_summary_text.delta', delta: REASONING },
        'reasoning summary delta'
      ),
      native(
        { type: 'response.reasoning_summary_text.done', text: REASONING },
        'reasoning summary done'
      ),
      native(
        {
          type: 'response.output_item.added',
          item: {
            id: 'item_conf_command',
            type: 'function_call',
            call_id: 'call_conf_command',
            name: 'run_command',
            arguments: '{"command":"node scripts/synthetic-check.mjs"}',
          },
        },
        'run_command function_call added'
      ),
      native(
        {
          type: 'response.output_item.done',
          item: {
            id: 'item_conf_command',
            type: 'function_call',
            call_id: 'call_conf_command',
            name: 'run_command',
            arguments: '{"command":"node scripts/synthetic-check.mjs"}',
            status: 'completed',
            output: COMMAND_OUTPUT,
          },
        },
        'run_command function_call done'
      ),
      native(
        {
          type: 'response.output_item.added',
          item: {
            id: 'item_conf_read',
            type: 'function_call',
            call_id: 'call_conf_read',
            name: 'read_file',
            arguments: '',
          },
        },
        'read_file function_call added (empty arguments)'
      ),
      native(
        {
          type: 'response.function_call_arguments.delta',
          item_id: 'item_conf_read',
          delta: '{"path":',
        },
        'read_file arguments delta 1'
      ),
      native(
        {
          type: 'response.function_call_arguments.delta',
          item_id: 'item_conf_read',
          delta: '"a.txt"}',
        },
        'read_file arguments delta 2'
      ),
      native(
        {
          type: 'response.function_call_arguments.done',
          item_id: 'item_conf_read',
          arguments: '{"path":"a.txt"}',
        },
        'read_file arguments done'
      ),
      native(
        {
          type: 'response.output_item.done',
          item: {
            id: 'item_conf_read',
            type: 'function_call',
            call_id: 'call_conf_read',
            name: 'read_file',
            arguments: '{"path":"a.txt"}',
            status: 'completed',
            output: 'file contents',
          },
        },
        'read_file function_call done'
      ),
      native(
        {
          type: 'response.output_item.added',
          item: {
            id: 'item_conf_patch',
            type: 'function_call',
            call_id: 'call_conf_patch',
            name: 'apply_patch',
            arguments: JSON.stringify({ input: ADDED_FILE_DIFF }),
          },
        },
        'apply_patch function_call added'
      ),
      native(
        {
          type: 'response.output_item.done',
          item: {
            id: 'item_conf_patch',
            type: 'function_call',
            call_id: 'call_conf_patch',
            name: 'apply_patch',
            arguments: JSON.stringify({ input: ADDED_FILE_DIFF }),
            status: 'completed',
            output: ADDED_FILE_DIFF,
          },
        },
        'apply_patch function_call done (unified diff output)'
      ),
      native(
        {
          type: 'response.output_item.done',
          item: {
            id: 'msg_conf_out',
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [
              { type: 'output_text', text: ASSISTANT_TEXT, annotations: [] },
            ],
          },
        },
        'v0.18.2 assistant reply as a message output-item'
      ),
      native(
        {
          type: 'response.completed',
          response: {
            id: 'resp_conf_simple',
            status: 'completed',
            model: 'hermes-conformance',
            usage: {
              input_tokens: 12,
              output_tokens: 34,
              input_tokens_details: { cached_tokens: 5 },
            },
          },
        },
        'response.completed with usage'
      ),
      CLOSE_STREAM,
    ],
    expect: {
      terminalStatus: 'completed',
      requiredPatchTypes: [
        'agent-turn-started-v2',
        'agent-item-delta-v2',
        'agent-item-updated-v2',
        'agent-session-updated-v2',
        'agent-turn-completed-v2',
      ],
      textIncludes: [ASSISTANT_TEXT, 'node scripts/synthetic-check.mjs'],
    },
  },

  interruptedTurn: {
    // A turn cut in flight: the model has streamed a partial reasoning summary
    // and nothing else when the operator interrupts. The adapter's abort path
    // (`hermes-adapter.ts` ~line 933) owns the terminal patch, and `interrupt()`
    // additionally posts `/session/:id/abort` (~line 978); the stub answers
    // that route, which is what lets the harness's `guard(interrupt())` resolve
    // rather than time out.
    steps: [
      native(
        { type: 'response.created', response: { id: 'resp_conf_interrupt' } },
        'response.created'
      ),
      native(
        {
          type: 'response.reasoning_summary_text.delta',
          delta: 'Hermes synthetic thought: ',
        },
        'partial reasoning before the interrupt'
      ),
      CLOSE_STREAM,
    ],
    interruptAfter: 2,
    expect: {
      terminalStatus: 'interrupted',
      requiredPatchTypes: ['agent-item-updated-v2', 'agent-turn-completed-v2'],
    },
  },

  errorTurn: {
    steps: [
      native(
        { type: 'response.created', response: { id: 'resp_conf_error' } },
        'response.created'
      ),
      native(
        { type: 'response.error', message: 'gateway blew up' },
        'provider failure'
      ),
      CLOSE_STREAM,
    ],
    expect: {
      terminalStatus: 'failed',
      requiredPatchTypes: ['agent-error-v2', 'agent-turn-completed-v2'],
    },
  },

  approvalFlow: {
    request: [
      native(
        { type: 'response.created', response: { id: 'resp_conf_approval' } },
        'response.created'
      ),
      // NOTE ON PROVENANCE: this repo has no captured Hermes permission stream
      // — the SSE hardening tests never exercise `permission.requested`. The
      // payload is therefore transcribed field-for-field from the only
      // authority available, `HermesProtocolAdapter.handlePermissionRequested`
      // (`hermes-adapter.ts` ~line 1535), using its primary key spellings
      // (`requestID`, `permission.tool/description/target`) rather than its
      // fallbacks. Treat it as derived, not recorded, until a live capture
      // lands.
      native(
        {
          type: 'permission.requested',
          requestID: 'perm_conf_1',
          permission: {
            tool: 'run_command',
            description: 'Run the synthetic check script',
            target: 'node scripts/synthetic-check.mjs',
          },
        },
        'permission.requested'
      ),
    ],
    decision: { kind: 'accept', scope: 'once' },
    resolution: [
      native(
        {
          type: 'response.completed',
          response: { id: 'resp_conf_approval', status: 'completed' },
        },
        'post-approval terminal'
      ),
      CLOSE_STREAM,
    ],
    expect: {
      terminalStatus: 'completed',
      requiredPatchTypes: ['agent-item-started-v2', 'agent-turn-completed-v2'],
    },
  },

  allowedSilentEvents: [
    {
      match: (step) => eventType(step) === 'response.created',
      reason:
        "`handleResponseCreated` only records the response id as the next turn's `previous_response_id` chaining anchor. It has no user-visible consequence of its own; the id surfaces later as `agent-session-updated-v2` when the response completes.",
    },
    {
      match: (step) =>
        eventType(step) === 'response.function_call_arguments.delta' ||
        eventType(step) === 'response.function_call_arguments.done',
      reason:
        'Tool arguments are buffered into `_pendingToolCalls` until the call is complete — emitting a patch per argument fragment would publish half-parsed JSON as tool input. The buffered value lands on the matching `response.output_item.done`.',
    },
  ],

  exercised: [
    'reasoning',
    'commandExecution',
    'tools',
    'fileChanges',
    // `telemetry` is attempted on purpose: the transcript drives a real
    // `response.completed` usage payload so the reconciliation table records
    // `declared=false attempted=true manifested=false → honest false`, which is
    // the standing claim of the `telemetry: false` note in index.ts (#1104).
    'telemetry',
  ],

  knownGaps: {
    'a-terminal': {
      issue: '#1411',
      reason:
        "the error turn emits TWO agent-turn-completed-v2 patches for conf-error: mapChatEventToAgentPatchV2 synthesizes one from chat:error (it carries a turnId) and hermes's failCurrentTurn then fires its own chat:turn-completed. Every hermes failure path fires both events, so no fixture can script a single-terminal failed turn. The simple and interrupted turns DO emit exactly one terminal patch each — that half stays asserted through expect.requiredPatchTypes on every segment",
    },
    'b-abandoned-approval': {
      issue: '#1407',
      reason:
        'LegacyProtocolAdapterV2Bridge.onDisconnect unsubscribes from the inner adapter BEFORE calling inner.disconnect(), so the abort-driven chat:turn-completed and idle chat:session-status that would drain the approval are mapped to nothing. Same family as the claude/mock/codex gaps: the wire side is fine, the patch stream keeps a permanently actionable approval card',
    },
    'e-capability-drift': {
      issue: '#1305',
      // Scoped: only the `streaming` row is gapped, so `fixtureErrors` and the
      // other nineteen rows — telemetry honesty included — keep biting.
      capabilities: ['streaming'],
      reason:
        "streaming reads as DRIFT (manifested, declared false) without any token streaming happening: hermes deliberately leaves the flag unset until the gateway emits response.output_text.delta (#1305 names the one-line index.ts change as step (b) behind an upstream bump), while the compat bridge carries a COMPLETED tool result on agent-item-delta-v2 — which is all the harness's streaming detector looks for. Tightening that detector to require delta.text would clear this without touching the adapter. Every other row reconciles OK today, telemetry included",
    },
  },

  unexercisable: [
    {
      capability: 'resume',
      reason:
        'hermes resume is `previous_response_id` chaining restored by `resumeSession`, which needs a second connect generation against the same gateway; deep-tested in hermes-adapter.test.ts.',
    },
    {
      capability: 'questions',
      reason:
        '`respondToInput` is a documented no-op — the Hermes gateway has no structured question channel, so no fixture can drive one.',
    },
  ],
};

export default fixture;
