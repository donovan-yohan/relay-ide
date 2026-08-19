/**
 * Conformance fixture for the `opencode-attached` adapter
 * (`OpenCodeAttachedAdapter` behind `LegacyProtocolAdapterV2Bridge`).
 *
 * Transport: no spawn. The rig builds the same two-plane twin the registry
 * builds — inner `new OpenCodeAttachedAdapter()` pointed at
 * `config.extra.endpoint`, wrapped in the bridge with the capability set
 * transcribed from `server/protocol-adapters/index.ts` lines 80-98 — and hands
 * it an offline `fetch` double (`../stubs/opencode-attached.stub.ts`) serving
 * `/global/health` plus a held-open `/event` SSE stream.
 *
 * Native payloads below are transcribed from real captured OpenCode streams,
 * not invented:
 *   - `message.part.updated` (`{ part, delta }`) — `opencode-adapter.test.ts`
 *     lines 158-187 (both the web and attached drives) and the recorded server
 *     double `test/fixtures/opencode-serve-stub.cjs` `emitTurn()`.
 *   - `session.status` — same serve stub; see the QUIRK note below on the two
 *     status encodings.
 *   - `tool.execute.before` / `tool.execute.after` / `permission.asked` — the
 *     property names both OpenCode adapters read off the wire
 *     (`opencode-adapter.ts` `handleToolStarted` / `handleToolFinished` /
 *     `handlePermissionAsked` accept exactly these keys, and the real plugin
 *     hook payloads in `server/opencode-relay.ts` carry the same `tool` /
 *     `result` nesting).
 *
 * ── Known adapter shortfalls this fixture pins (#1412, all `knownGaps`) ──────
 * The attached adapter is the only registered OpenCode surface that never
 * fires `chat:turn-completed`: `OpenCodeProtocolAdapter.handleSessionStatus`
 * closes the turn on `session.status` idle/error, the attached adapter's
 * `session.status` handler only re-broadcasts `chat:session-status`. Nothing
 * else in it produces a terminal either — its `chat:error` carries no `turnId`,
 * so `mapChatEventToAgentPatchV2` cannot synthesize the failed terminal it
 * synthesizes for turn-scoped errors. Consequence: no turn this adapter starts
 * can ever end, for any transcript.
 *
 * The harness's cited-gap escape (see `awaitTerminal` in `harness.ts`) lets the
 * lifecycle run past a terminal that never arrives when — and only when — a
 * fixture cites an `a-terminal` gap. So (c) no-silent-drop and (d) determinism
 * are NOT gapped here: both are asserted and both hold. Only the invariants the
 * missing terminal genuinely blocks are skipped.
 *
 * Not a UI hang today: `channel-agent-binder.ts` `handleLiveState` finalizes a
 * channel turn on a bare `live.status === 'idle'` "even when a matching
 * `agent-turn-completed-v2` never fired". The floor still asserts it, because
 * the invariant is stated at the ADAPTER boundary — and that compensation is
 * explicitly skipped while an approval is outstanding, which is exactly the
 * state this adapter can also never leave (see the `b-*` gaps).
 *
 * Two smaller shape gaps are documented here but deliberately kept OUT of the
 * scripted transcript, so invariant (c) keeps its teeth for whoever fixes the
 * terminal gap:
 *   - `session.status` on the real wire is `{ status: { type: 'idle' } }`
 *     (serve stub `emitTurn()`; `opencode-adapter.ts` `statusType()` unwraps
 *     both encodings). The attached handler compares `status === 'idle'` as a
 *     bare string, so the object encoding maps to nothing at all.
 *   - `question.asked` fires `chat:input-request`, for which
 *     `mapChatEventToAgentPatchV2` has no case — a guaranteed silent drop
 *     through the bridge.
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

/** Root cause every gap below shares. */
const NO_TERMINAL_TURN_PATCH =
  'OpenCodeAttachedAdapter never fires chat:turn-completed (its session.status handler only re-broadcasts chat:session-status, unlike OpenCodeProtocolAdapter.handleSessionStatus which closes the turn) and its chat:error carries no turnId, so the compat bridge cannot synthesize a failed terminal either. No scripted transcript can end a turn, so every invariant that reads a terminal patch is unevaluable.';

/**
 * Capability set transcribed from `index.ts` lines 80-98. The registry-parity
 * test compares this against the real factory, so any registry edit that is not
 * mirrored here fails loudly instead of quietly weakening the floor.
 */
const REGISTERED_CAPABILITIES = {
  text: true,
  reasoning: true,
  tools: true,
  commandExecution: true,
  fileChanges: true,
  approvals: true,
  slashCommands: false,
  queue: false,
  interrupt: true,
  cancelQueued: false,
  resume: false,
  telemetry: true,
  streaming: true,
} as const;

function native(event: unknown, label?: string): FixtureFeedStep {
  return label === undefined
    ? { kind: 'native', event }
    : { kind: 'native', event, label };
}

/** `session.status` in the string encoding this adapter's handler accepts. */
function sessionStatus(status: 'active' | 'idle' | 'error'): unknown {
  return {
    type: 'session.status',
    properties: { sessionID: SESSION, status },
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
      native(sessionStatus('active'), 'server acknowledges the prompt'),
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
      // `agent-turn-completed-v2` is deliberately absent: it is the one patch
      // this adapter can never emit (#1412), and invariant (a) — not this
      // sanity list — is where that is recorded. Re-add it the moment the
      // adapter closes turns, so the gap cannot silently reopen.
      requiredPatchTypes: [
        'agent-turn-started-v2',
        'agent-item-delta-v2',
        'agent-item-updated-v2',
        'agent-live-state-updated-v2',
      ],
      textIncludes: ['pwd'],
    },
  },

  interruptedTurn: {
    steps: [
      native(sessionStatus('active'), 'server acknowledges the prompt'),
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
      native(sessionStatus('active'), 'server acknowledges the prompt'),
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
      native(sessionStatus('active'), 'server acknowledges the prompt'),
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

  knownGaps: {
    'a-terminal': { issue: '#1412', reason: NO_TERMINAL_TURN_PATCH },
    'b-approval-ids': {
      issue: '#1412',
      reason: `${NO_TERMINAL_TURN_PATCH} Independently: respondToApproval() POSTs /permission/<id>/allow and fires nothing, so the pending approval item never reaches a resolved state either.`,
    },
    'b-teardown': {
      issue: '#1412',
      reason: `${NO_TERMINAL_TURN_PATCH} Independently: nothing drains live.activeRequestIds, so the approval raised by permission.asked stays pending through disconnect().`,
    },
    'b-abandoned-approval': {
      issue: '#1412',
      reason: `${NO_TERMINAL_TURN_PATCH} Independently: onDetach() only aborts the SSE and message controllers — it neither denies the outstanding permission on the wire nor emits any patch resolving the approval item.`,
    },
    // (c) and (d) are NOT gapped: with the harness's cited-gap escape the run
    // completes, and both hold — every scripted event maps to a patch and two
    // replays agree. They stay asserted so the terminal gap cannot be used as
    // cover for a second regression.
    'e-capability-drift': {
      issue: '#1412',
      reason: `${NO_TERMINAL_TURN_PATCH} Independently: capabilities.interrupt is declared true, but with no terminal patch of any status the interrupt detector can never see an interrupted turn, so the flag is unbacked end to end.`,
    },
  },
};

export default fixture;
