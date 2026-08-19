/**
 * Conformance fixture for the `opencode-attached` adapter
 * (`OpenCodeAttachedAdapter` behind `LegacyProtocolAdapterV2Bridge`).
 *
 * Transport: no spawn. The rig builds the same two-plane twin the registry
 * builds — inner `new OpenCodeAttachedAdapter()` pointed at
 * `config.extra.endpoint`, wrapped in the bridge with the capability set
 * transcribed from
 * `PROVIDER_DESCRIPTORS['opencode-attached'].bridgedCapabilities`
 * (`server/protocol-adapters/index.ts`) — and hands
 * it an offline `fetch` double (`../stubs/opencode-attached.stub.ts`) serving
 * `/global/health` plus a held-open `/event` SSE stream.
 *
 * Native payloads below are transcribed from real captured OpenCode streams,
 * not invented:
 *   - `message.part.updated` (`{ part, delta }`) — `opencode-adapter.test.ts`
 *     lines 158-187 (both the web and attached drives) and the recorded server
 *     double `test/fixtures/opencode-serve-stub.cjs` `emitTurn()`.
 *   - `session.status` — same serve stub; see the note below on the wire
 *     encoding this fixture scripts.
 *   - `tool.execute.before` / `tool.execute.after` / `permission.asked` — the
 *     property names both OpenCode adapters read off the wire
 *     (`opencode-adapter.ts` `handleToolStarted` / `handleToolFinished` /
 *     `handlePermissionAsked` accept exactly these keys, and the real plugin
 *     hook payloads in `server/opencode-relay.ts` carry the same `tool` /
 *     `result` nesting).
 *
 * ── #1412, now closed: the terminal turn patch ──────────────────────────────
 * This adapter used to be the only registered OpenCode surface that never
 * fired `chat:turn-completed`, so `agent-turn-completed-v2` was unreachable in
 * every form and no transcript could end a turn. Every invariant that reads a
 * terminal was gapped on that one root cause. The adapter now ends its turns
 * from `session.status` idle/error, from `session.error` (whose `chat:error`
 * carries the `turnId` so the failure binds to the turn), and from `interrupt()`
 * — so all of those gaps are gone and the terminal is asserted, per segment,
 * per status. The `a-terminal` escape in `harness.ts` went with them.
 *
 * `session.status` is scripted in its REAL wire encoding — `{ status: { type:
 * 'busy' | 'idle' } }`, exactly what `test/fixtures/opencode-serve-stub.cjs`
 * `emitTurn()` sends. Before #1412 the handler compared `status === 'idle'` as
 * a bare string and the object encoding mapped to nothing at all, so scripting
 * the true shape here is what keeps that regression out.
 *
 * One shape gap is documented but deliberately kept OUT of the transcript, so
 * invariant (c) keeps its teeth: `question.asked` fires `chat:input-request`,
 * for which `mapChatEventToAgentPatchV2` has no case — a guaranteed silent drop
 * through the bridge, the same class as the hermes `chat:telemetry` trap, and
 * consistent with `questions: false` in the registry.
 */
import { OpenCodeAttachedAdapter } from '../../../../../server/protocol-adapters/opencode-attached-adapter.js';
import { LegacyProtocolAdapterV2Bridge } from '../../../../../server/protocol-adapters/legacy-v2-bridge.js';
import {
  CONFORMANCE_OPENCODE_ENDPOINT,
  makeOpenCodeAttachedServerDouble,
} from '../stubs/opencode-attached.stub.js';
import type {
  AdapterConformanceFixture,
  FixtureFeedStep,
} from '../fixture-types.js';

/** Relay session id; the adapter builds every session route from it. */
const SESSION = 'conf-opencode-attached';

/**
 * Capability set transcribed from
 * `PROVIDER_DESCRIPTORS['opencode-attached'].bridgedCapabilities` in
 * `server/protocol-adapters/index.ts`. The registry-parity test compares this
 * against the real factory, so any registry edit that is not mirrored here fails
 * loudly instead of quietly weakening the floor. The registry transcription is
 * total over `AgentCapabilitySetV2`, so this twin is too.
 */
const REGISTERED_CAPABILITIES = {
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
} as const;

function native(event: unknown, label?: string): FixtureFeedStep {
  return label === undefined
    ? { kind: 'native', event }
    : { kind: 'native', event, label };
}

/**
 * `session.status` in the encoding the real server sends — the nested
 * `{ status: { type } }` form `test/fixtures/opencode-serve-stub.cjs`
 * `emitTurn()` emits, with `busy` (not `active`) as the running state.
 */
function sessionStatus(status: 'busy' | 'idle' | 'error'): unknown {
  return {
    type: 'session.status',
    properties: { sessionID: SESSION, status: { type: status } },
  };
}

/** One streamed assistant text chunk, real `{ part, delta }` shape. */
function textDelta(partText: string, delta: string): unknown {
  return {
    type: 'message.part.updated',
    properties: {
      sessionID: SESSION,
      part: {
        id: 'prt_conf_1',
        sessionID: SESSION,
        messageID: 'msg_conf_1',
        type: 'text',
        text: partText,
      },
      delta,
    },
  };
}

const fixture: AdapterConformanceFixture = {
  adapterId: 'opencode-attached',

  createRig() {
    const server = makeOpenCodeAttachedServerDouble();
    const adapter = new LegacyProtocolAdapterV2Bridge(
      new OpenCodeAttachedAdapter(),
      { ...REGISTERED_CAPABILITIES }
    );

    return {
      adapter,
      config: {
        cwd: '/tmp/conformance-opencode-attached',
        port: 3000,
        sessionId: SESSION,
        hookToken: 'conf',
        configDir: '/tmp/conf-config',
        extra: { endpoint: CONFORMANCE_OPENCODE_ENDPOINT },
      },
      feed: (step) => {
        if (step.kind === 'close') {
          server.closeEventStream();
          return;
        }
        if (step.kind !== 'native') {
          throw new Error(
            `opencode-attached conformance rig only feeds native SSE events, got ${step.kind}`
          );
        }
        server.push(step.event);
      },
      dispose: async () => {
        server.dispose();
      },
    };
  },

  // `connect()` does the health probe and opens `/event` itself; the double
  // answers both synchronously, so there is nothing to script here.
  connect: { steps: [] },

  simpleTurn: {
    steps: [
      native(sessionStatus('busy'), 'server acknowledges the prompt'),
      native(textDelta('conformance ', 'conformance '), 'streamed text chunk'),
      native(
        textDelta('conformance says hi', 'says hi'),
        'streamed text chunk'
      ),
      native(
        {
          type: 'tool.execute.before',
          properties: {
            sessionID: SESSION,
            toolCallId: 'tool_conf_bash',
            tool: {
              name: 'bash',
              description: 'Run a shell command',
              input: { command: 'pwd' },
            },
          },
        },
        'bash tool starts (→ commandExecution item)'
      ),
      native(
        {
          type: 'tool.execute.after',
          properties: {
            sessionID: SESSION,
            toolCallId: 'tool_conf_bash',
            toolName: 'bash',
            result: {
              output: '/tmp/conformance-opencode-attached',
              durationMs: 3,
            },
          },
        },
        'bash tool finishes'
      ),
      native(
        {
          type: 'tool.execute.before',
          properties: {
            sessionID: SESSION,
            toolCallId: 'tool_conf_read',
            tool: {
              name: 'read',
              description: 'Read a file',
              input: { filePath: 'README.md' },
            },
          },
        },
        'non-command tool starts (→ dynamicToolCall item)'
      ),
      native(
        {
          type: 'tool.execute.after',
          properties: {
            sessionID: SESSION,
            toolCallId: 'tool_conf_read',
            toolName: 'read',
            result: { output: '# relay-ide', durationMs: 1 },
          },
        },
        'non-command tool finishes'
      ),
      native(sessionStatus('idle'), 'server goes idle — the turn is over'),
    ],
    expect: {
      terminalStatus: 'completed',
      // `agent-turn-completed-v2` is listed explicitly: it is the patch #1412
      // made unreachable, so naming it here — not only in invariant (a) — is
      // what stops the gap silently reopening.
      requiredPatchTypes: [
        'agent-turn-started-v2',
        'agent-item-delta-v2',
        'agent-item-updated-v2',
        'agent-live-state-updated-v2',
        'agent-turn-completed-v2',
      ],
      textIncludes: ['pwd'],
    },
  },

  interruptedTurn: {
    steps: [
      native(sessionStatus('busy'), 'server acknowledges the prompt'),
      native(
        textDelta('conformance long ', 'conformance long '),
        'partial answer before the interrupt'
      ),
      // interruptAfter: 2 → the harness calls interrupt() here; the adapter
      // POSTs `/session/<id>/abort` and the server settles back to idle.
      native(sessionStatus('idle'), 'server idles after the abort'),
    ],
    interruptAfter: 2,
    expect: { terminalStatus: 'interrupted' },
  },

  errorTurn: {
    steps: [
      native(sessionStatus('busy'), 'server acknowledges the prompt'),
      native(
        {
          type: 'session.error',
          properties: {
            sessionID: SESSION,
            error: 'conformance provider failure',
          },
        },
        'provider failure'
      ),
    ],
    expect: { terminalStatus: 'failed' },
  },

  approvalFlow: {
    request: [
      native(sessionStatus('busy'), 'server acknowledges the prompt'),
      native(
        {
          type: 'permission.asked',
          properties: {
            sessionID: SESSION,
            requestID: 'per_conf_1',
            toolName: 'bash',
            description: 'Run pwd in the workspace',
            target: 'pwd',
          },
        },
        'permission prompt for the bash tool'
      ),
    ],
    decision: { kind: 'accept', scope: 'once' },
    resolution: [
      native(sessionStatus('idle'), 'server idles after the permission reply'),
    ],
    expect: { terminalStatus: 'completed' },
  },

  exercised: ['tools', 'commandExecution', 'streaming'],

  unexercisable: [
    {
      capability: 'reasoning',
      reason:
        'OpenCodeAttachedAdapter has no chat:reasoning emitter at all (its whole handler table is session.status / message.part.updated / permission.asked / question.asked / tool.execute.before / tool.execute.after / session.error), so no transcript can drive the flag — suspected unbacked capability, flagged not asserted',
    },
    {
      capability: 'fileChanges',
      reason:
        'the attached adapter never fires chat:file-change; edits surface only as tool.execute.* events, which map to tool items, so a fileChange item is unreachable from this transport — suspected unbacked capability, flagged not asserted',
    },
    {
      capability: 'telemetry',
      reason:
        'the attached adapter has no chat:telemetry emitter (only OpenCodeProtocolAdapter.handleTelemetry does), and mapChatEventToAgentPatchV2 has no chat:telemetry case anyway — the same trap index.ts documents on hermes, here still declared true',
    },
  ],

  // No known gaps. Everything #1412 gapped is asserted — (a) terminal, every
  // (b) approval invariant, and (e) capability drift — and #1407 with it: the
  // bridge now denies the outstanding permission through
  // `inner.respondToApproval` and publishes the cancelled card itself, so
  // `onDetach()` aborting its controllers no longer strands the approval.
};

export default fixture;
