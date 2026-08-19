/**
 * Conformance fixture for the `opencode` adapter (HTTP + SSE, bridged to V2).
 *
 * Shape provenance — nothing below is invented grammar:
 *
 * - `message.part.updated` is transcribed from the captured shape asserted in
 *   `opencode-adapter.test.ts` lines 157-188 (`properties.part = { type:'text',
 *   id, messageID, text }` plus a sibling `properties.delta` string).
 * - the HTTP script (`/global/health` 200, `POST /session` → fixed id,
 *   `/global/event` 200) is the same responder that test installs at lines
 *   41-108, extended with the message / abort / permission routes the adapter
 *   actually calls.
 * - `message.updated`, `tool.execute.before`, `tool.execute.after`,
 *   `permission.asked`, `permission.replied` and `tui.toast.show` are the
 *   remaining `mapOpenCodeEvent` cases in
 *   `server/protocol-adapters/opencode-adapter.ts`; each payload carries
 *   exactly the fields its handler reads, and the terminal/error vocabulary is
 *   the one `shared/agent-chat-v1-compat.ts` maps into `AgentPatchV2`.
 *
 * Rig shape: the registry builds `LegacyProtocolAdapterV2Bridge(new
 * OpenCodeProtocolAdapter(), <capability literal>)`, so the rig builds the same
 * pair with the spawn seam injected. The capability object is hand-copied from
 * `PROVIDER_DESCRIPTORS.opencode.bridgedCapabilities`
 * (`server/protocol-adapters/index.ts`) and the suite's registry
 * parity test guards the copy against drift.
 *
 * Turn boundary quirk: an OpenCode turn is bounded by the message POST, not by
 * an event. `chat:turn-completed` fires when `POST /session/:id/message`
 * resolves, so every completing turn ends with a `transport-reply` step that
 * hands the double the provider's HTTP reply. Interrupt and the toast-driven
 * failure path both end the turn by aborting that same request instead.
 */
import { LegacyProtocolAdapterV2Bridge } from '../../../../../server/protocol-adapters/legacy-v2-bridge.js';
import { OpenCodeProtocolAdapter } from '../../../../../server/protocol-adapters/opencode-adapter.js';
import type { AgentCapabilitySetV2 } from '../../../../../shared/agent-chat-protocol-v2.js';
import {
  makeOpenCodeTransportStub,
  OPENCODE_SESSION_ID,
} from '../stubs/opencode.stub.js';
import type {
  AdapterConformanceFixture,
  FixtureFeedStep,
} from '../fixture-types.js';

/**
 * Hand-copied from `PROVIDER_DESCRIPTORS.opencode.bridgedCapabilities` in
 * `server/protocol-adapters/index.ts`.
 * The suite's `registry parity` test asserts this equals the registered set, so
 * a registry edit that skips this file fails there rather than silently
 * reconciling against a stale literal. The registry transcription is total over
 * `AgentCapabilitySetV2`, so this twin is too.
 */
const OPENCODE_BRIDGE_CAPABILITIES: AgentCapabilitySetV2 = {
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
  resume: false,
  fork: false,
  rollback: false,
  compact: false,
  telemetry: true,
  rateLimits: false,
  streaming: true,
};

interface OpenCodeEventLike {
  type: string;
  properties?: Record<string, unknown>;
}

function native(event: OpenCodeEventLike, label: string): FixtureFeedStep {
  return { kind: 'native', event, label };
}

/**
 * The step that ends a completing turn: the deferred `POST /session/:id/message`
 * the ADAPTER issued finally gets its reply. That is a transport reply, not a
 * server-initiated request, so it uses the harness's `transport-reply` kind.
 */
function messageResponse(
  messageId: string,
  text: string,
  label: string
): FixtureFeedStep {
  return {
    kind: 'transport-reply',
    id: messageId,
    payload: {
      info: {
        id: messageId,
        role: 'assistant',
        sessionID: OPENCODE_SESSION_ID,
      },
      parts: [
        {
          id: `${messageId}-text`,
          sessionID: OPENCODE_SESSION_ID,
          messageID: messageId,
          type: 'text',
          text,
        },
      ],
    },
    label,
  };
}

function textPart(
  messageId: string,
  text: string,
  delta: string
): OpenCodeEventLike {
  return {
    type: 'message.part.updated',
    properties: {
      part: {
        id: `${messageId}-text`,
        sessionID: OPENCODE_SESSION_ID,
        messageID: messageId,
        type: 'text',
        text,
      },
      delta,
    },
  };
}

const SIMPLE_TEXT = 'Conformance floor holds.';

const fixture: AdapterConformanceFixture = {
  adapterId: 'opencode',

  createRig() {
    const stub = makeOpenCodeTransportStub();
    const inner = new OpenCodeProtocolAdapter(stub.spawnFn);
    const adapter = new LegacyProtocolAdapterV2Bridge(
      inner,
      OPENCODE_BRIDGE_CAPABILITIES
    );

    // The event plane. `mapOpenCodeEvent` is the dispatcher every SSE frame
    // reaches after parsing, and the seam the existing deep tests already drive
    // (`driveOpenCodeEvent`, opencode-adapter.test.ts lines 23-37).
    const dispatch = inner as unknown as {
      mapOpenCodeEvent(event: OpenCodeEventLike): void;
    };

    // Patch-count quiescence, rig-owned. The harness default assumes a fed step
    // produces its patches synchronously; here a turn-ending step resolves an
    // HTTP request whose body still has to be read, so the wait has to outlast
    // a `Response.json()`.
    let seen = 0;
    adapter.onPatch(() => {
      seen += 1;
    });
    const tick = (ms: number): Promise<void> =>
      new Promise((resolve) => setTimeout(resolve, ms));

    return {
      adapter,
      config: {
        cwd: '/tmp/conformance-opencode',
        port: 3000,
        sessionId: 'conf-opencode',
        hookToken: 'conf',
        configDir: '/tmp/conf-config',
      },
      feed: async (step) => {
        if (step.kind === 'native') {
          dispatch.mapOpenCodeEvent(step.event as OpenCodeEventLike);
          return;
        }
        if (step.kind === 'transport-reply') {
          await stub.completeMessagePost(step.payload);
          return;
        }
        throw new Error(
          `opencode conformance rig cannot feed step: ${JSON.stringify(step)}`
        );
      },
      settle: async () => {
        // Let any in-flight body read and its continuation land before the
        // stability count starts; otherwise a real patch can arrive after the
        // wait and read as a silent drop.
        for (let i = 0; i < 3; i += 1) await tick(2);
        let stable = 0;
        let last = seen;
        const deadline = Date.now() + 400;
        while (stable < 6 && Date.now() < deadline) {
          await tick(2);
          if (seen === last) stable += 1;
          else {
            stable = 0;
            last = seen;
          }
        }
      },
      dispose: async () => {
        stub.restore();
      },
    };
  },

  // `connect()` is self-driving over the command plane: health probe, then
  // `POST /session`, then the SSE subscription. Nothing to script.
  connect: { steps: [] },

  simpleTurn: {
    steps: [
      native(
        {
          type: 'message.updated',
          properties: {
            info: {
              id: 'msg-conf-simple',
              role: 'assistant',
              sessionID: OPENCODE_SESSION_ID,
            },
          },
        },
        'message.updated: classify msg-conf-simple as assistant'
      ),
      native(
        textPart('msg-conf-simple', 'Conformance floor ', 'Conformance floor '),
        'streamed text delta'
      ),
      native(
        {
          type: 'tool.execute.before',
          properties: {
            sessionID: OPENCODE_SESSION_ID,
            toolCallId: 'call-conf-bash',
            tool: {
              name: 'bash',
              description: 'Print the working directory',
              input: { command: 'pwd' },
            },
          },
        },
        'bash tool starts'
      ),
      native(
        {
          type: 'tool.execute.after',
          properties: {
            sessionID: OPENCODE_SESSION_ID,
            toolCallId: 'call-conf-bash',
            tool: { name: 'bash' },
            result: { output: '/tmp/conformance-opencode\n', durationMs: 3 },
          },
        },
        'bash tool finishes'
      ),
      native(
        {
          type: 'tool.execute.before',
          properties: {
            sessionID: OPENCODE_SESSION_ID,
            toolCallId: 'call-conf-read',
            tool: {
              name: 'read',
              description: 'Read a file',
              input: { filePath: 'README.md' },
            },
          },
        },
        'non-command tool starts'
      ),
      native(
        {
          type: 'tool.execute.after',
          properties: {
            sessionID: OPENCODE_SESSION_ID,
            toolCallId: 'call-conf-read',
            tool: { name: 'read' },
            result: { output: '# relay-ide\n', durationMs: 1 },
          },
        },
        'non-command tool finishes'
      ),
      native(
        textPart('msg-conf-simple', SIMPLE_TEXT, 'holds.'),
        'final text delta'
      ),
      messageResponse('msg-conf-simple', SIMPLE_TEXT, 'turn reply lands'),
    ],
    expect: {
      terminalStatus: 'completed',
      requiredPatchTypes: [
        'agent-turn-started-v2',
        'agent-item-delta-v2',
        'agent-item-updated-v2',
        'agent-turn-completed-v2',
      ],
      textIncludes: [SIMPLE_TEXT],
    },
  },

  interruptedTurn: {
    steps: [
      native(
        textPart(
          'msg-conf-interrupt',
          'Working on the long ',
          'Working on the long '
        ),
        'partial answer before the interrupt'
      ),
      // interruptAfter: 1 → `interrupt()` aborts the in-flight message POST and
      // fires `POST /session/:id/abort`; the aborted request is what terminates
      // the turn, so there is no provider frame left to script.
    ],
    interruptAfter: 1,
    expect: { terminalStatus: 'interrupted' },
  },

  errorTurn: {
    steps: [
      native(
        {
          type: 'tui.toast.show',
          properties: {
            sessionID: OPENCODE_SESSION_ID,
            variant: 'error',
            title: 'OpenCode',
            message: 'conformance provider failure',
          },
        },
        'error toast fails the live turn'
      ),
    ],
    expect: { terminalStatus: 'failed' },
  },

  approvalFlow: {
    request: [
      native(
        {
          type: 'permission.asked',
          properties: {
            sessionID: OPENCODE_SESSION_ID,
            requestID: 'perm-conf-1',
            permission: {
              tool: 'bash',
              description: 'Run pwd in the workspace',
              target: 'pwd',
            },
          },
        },
        'permission prompt'
      ),
    ],
    decision: { kind: 'accept', scope: 'once' },
    resolution: [
      native(
        {
          type: 'permission.replied',
          properties: { sessionID: OPENCODE_SESSION_ID },
        },
        'provider acknowledges the reply and resumes'
      ),
      messageResponse(
        'msg-conf-approval',
        'Approved command finished.',
        'post-approval turn reply'
      ),
    ],
    expect: { terminalStatus: 'completed' },
  },

  allowedSilentEvents: [
    {
      match: (step) =>
        step.kind === 'native' &&
        (step.event as OpenCodeEventLike).type === 'message.updated',
      reason:
        '`handleMessageUpdated` is pure bookkeeping: it records whether a message id belongs to the user or the assistant so a later `message.part.updated` echoing the prompt can be suppressed. Its user-visible consequence is the ABSENCE of a duplicated user bubble, and it arrives on the part events, so emitting a patch of its own would be wrong rather than missing.',
    },
  ],

  exercised: ['commandExecution', 'tools', 'streaming'],

  unexercisable: [
    {
      capability: 'reasoning',
      reason:
        'SUSPECTED REGISTRY DRIFT, not a fixture gap: `OpenCodeProtocolAdapter` never fires `chat:reasoning` on any code path (`handleMessagePartUpdated` returns early unless `part.type === "text"`), so no transcript over this transport can manifest it. Reported as UNKNOWN rather than DRIFT because the harness cannot distinguish "adapter has no path" from "fixture did not drive it".',
    },
    {
      capability: 'fileChanges',
      reason:
        'SUSPECTED REGISTRY DRIFT, same shape as `reasoning`: the adapter never fires `chat:file-change`, and OpenCode edit/write tools arrive as `tool.execute.*`, which `mapChatEventToAgentPatchV2` maps to `dynamicToolCall`, never to a `fileChange` item.',
    },
    {
      capability: 'telemetry',
      reason:
        'SUSPECTED REGISTRY DRIFT: the only producer is `handleTelemetry`, reachable solely through `handleHookEvent("telemetry.updated")` on the legacy hook-router plane, not through `mapOpenCodeEvent`; and even from there `mapChatEventToAgentPatchV2` has no `chat:telemetry` case, so the bridge drops it — the exact gap `index.ts` cites when it keeps hermes at `telemetry: false`.',
    },
    {
      capability: 'questions',
      reason:
        'declared false and honest to leave alone: `question.asked` does fire `chat:input-request`, but the compat bridge has no case for it, so the floor would have to license a genuine drop to script it.',
    },
    {
      capability: 'resume',
      reason:
        'declared false: `resumeSession` is a documented no-op and the bridge throws on resume when the flag is false',
    },
    {
      capability: 'queue',
      reason:
        'declared false: the floor transcript never has two turns in flight, which is what queueing would mean here',
    },
  ],

  // No known gaps. #1407 is fixed for the whole legacy family at once:
  // `LegacyProtocolAdapterV2Bridge` keeps its own approval ledger — fed by the
  // patches it publishes, so it needs no opencode vocabulary — and resolves
  // whatever is still outstanding on teardown instead of hoping an inner
  // teardown event it has already unsubscribed from would do it.
};

export default fixture;
