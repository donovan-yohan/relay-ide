/**
 * Conformance fixture for the `codex` adapter (app-server JSON-RPC subprocess).
 *
 * Every native payload below is transcribed from a real captured app-server
 * frame already asserted elsewhere in the repo:
 *
 * - `turn/started` / `turn/completed` / `thread/tokenUsageUpdated`
 *   — `codex-native-adapter.test.ts` (turn lifecycle + usage buffering).
 * - `item/started` + `item/agentMessage/delta` + `item/completed`
 *   — `codex-native-adapter.test.ts` and
 *     `test/fixtures/channel-chat/codex-terminal-ordering.ts`.
 * - `reasoning` / `commandExecution` / `fileChange` item shapes
 *   — `test/fixtures/agent-detail/codex.ts` (hand-sanitized capture).
 * - `mcpToolCall`, `item/commandExecution/requestApproval`,
 *   `item/tool/requestUserInput` — `codex-native-adapter.test.ts`.
 *
 * No grammar is invented here.
 *
 * Transport injection uses the adapter's existing constructor seam
 * (`new CodexNativeProtocolAdapter(factory)`) — zero production change. The
 * stub client hands out fixed thread/turn/item ids so a replayed transcript is
 * byte-identical.
 *
 * Codex-local sequencing rule: every streamed item is completed *before* its
 * `turn/completed`. Codex defers a completed Relay turn for
 * `CODEX_TERMINAL_ITEM_GRACE_MS` when an agentMessage/reasoning item is still
 * open, and a floor transcript that leans on that timer would be measuring a
 * wall clock instead of the contract.
 */
import { CodexNativeProtocolAdapter } from '../../../../../server/protocol-adapters/codex-native-adapter.js';
import {
  makeCodexClientStubHarness,
  type StubCodexClient,
} from '../stubs/codex.stub.js';
import type {
  AdapterConformanceFixture,
  FixtureFeedStep,
} from '../fixture-types.js';

const THREAD_ID = 'thread-conformance-codex';
const CWD = '/workspace/example';

/** One app-server `notification` frame. */
function notify(
  method: string,
  params: Record<string, unknown>,
  label?: string
): FixtureFeedStep {
  const event = { method, params };
  return label === undefined
    ? { kind: 'native', event }
    : { kind: 'native', event, label };
}

/** One app-server server-initiated `request` frame. */
function request(
  id: number,
  method: string,
  params: Record<string, unknown>,
  label: string
): FixtureFeedStep {
  return { kind: 'server-request', id, method, params, label };
}

/**
 * Codex answers an `item/tool/requestUserInput` server-request through
 * `respondToInput()` — an operator move with no native frame of its own, so it
 * rides the harness's first-class `operator` step kind rather than a
 * fixture-local marker smuggled through `native`.
 */
function operatorAnswer(
  requestId: string,
  answers: Record<string, string[]>,
  label: string
): FixtureFeedStep {
  return {
    kind: 'operator',
    action: 'respondToInput',
    requestId,
    answers,
    label,
  };
}

// ── Captured payload bodies ───────────────────────────────────────────────

const REASONING_SUMMARY =
  'Codex synthetic thought: verify the reducer contract before applying the patch.';
const ANSWER_TEXT = 'Conformance codex answer.';
const COMMAND = 'node scripts/synthetic-check.mjs';
const COMMAND_OUTPUT =
  'export const syntheticCodexValue = {\n  ready: true,\n};';
const DIFF_PATH = 'src/synthetic/example.ts';
const DIFF =
  '--- a/src/synthetic/example.ts\n' +
  '+++ b/src/synthetic/example.ts\n' +
  '@@ -1 +1,2 @@\n' +
  '-const ready = false;\n' +
  '+const ready = true;\n' +
  '+export default ready;\n';

const TOKEN_USAGE = {
  last: {
    inputTokens: 100,
    outputTokens: 50,
    cachedInputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 150,
  },
  total: {
    inputTokens: 100,
    outputTokens: 50,
    cachedInputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 150,
  },
  modelContextWindow: 128000,
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const fixture: AdapterConformanceFixture = {
  adapterId: 'codex',

  createRig() {
    const harness = makeCodexClientStubHarness({
      'thread/start': { thread: { id: THREAD_ID } },
      // Empty catalogs keep the post-connect `model/list` / `skills/list`
      // refresh deterministic without pretending the floor exercises
      // slash-command discovery.
      'model/list': [],
      'skills/list': { skills: [] },
    });
    const adapter = new CodexNativeProtocolAdapter(harness.factory);

    const client = (): StubCodexClient => harness.client;

    return {
      adapter,
      config: {
        cwd: CWD,
        port: 3000,
        sessionId: 'conf-codex',
        hookToken: 'conf',
        configDir: '/tmp/conf-config',
        model: 'o4-mini',
      },
      feed: async (step) => {
        if (step.kind === 'close') {
          client().emit('close', step.code ?? 0);
        } else if (step.kind === 'server-request') {
          client().feedRequest(step.id, step.method, step.params);
        } else if (step.kind === 'native') {
          const { method, params } = step.event as {
            method: string;
            params: Record<string, unknown>;
          };
          client().feedNotification(method, params);
        } else {
          throw new Error(
            `codex conformance rig cannot feed step kind '${step.kind}'`
          );
        }
        // Codex's approval and input handlers are async: they park on a promise
        // and resume only once the adapter settles it. Yield a macrotask so any
        // continuation this frame released has emitted its patches before the
        // harness samples the stream for this step.
        await sleep(0);
      },
      dispose: async () => {
        // The stub client dies with `disconnect()`; nothing else is owned.
      },
    };
  },

  // `connect()` drives `thread/start` (and the `model/list` / `skills/list`
  // catalog refresh) over pre-seeded stub responses, so there is no inbound
  // frame to script here.
  connect: { steps: [] },

  simpleTurn: {
    prompt: 'conformance simple-turn',
    steps: [
      notify(
        'turn/started',
        { threadId: THREAD_ID, turn: { id: 'native-conf-simple' } },
        'native turn opens'
      ),
      notify(
        'item/started',
        {
          threadId: THREAD_ID,
          turnId: 'native-conf-simple',
          item: {
            type: 'reasoning',
            id: 'reason-conf-simple',
            summary: [],
            content: [],
          },
        },
        'reasoning item opens'
      ),
      notify(
        'item/reasoning/summaryTextDelta',
        {
          threadId: THREAD_ID,
          turnId: 'native-conf-simple',
          itemId: 'reason-conf-simple',
          delta: REASONING_SUMMARY,
          summaryIndex: 0,
        },
        'reasoning summary delta'
      ),
      notify(
        'item/completed',
        {
          threadId: THREAD_ID,
          turnId: 'native-conf-simple',
          item: {
            type: 'reasoning',
            id: 'reason-conf-simple',
            summary: [REASONING_SUMMARY],
            content: [],
          },
        },
        'reasoning item terminal'
      ),
      notify(
        'item/started',
        { item: { type: 'agentMessage', id: 'message-conf-simple' } },
        'assistant message opens'
      ),
      notify(
        'item/agentMessage/delta',
        { itemId: 'message-conf-simple', delta: ANSWER_TEXT },
        'assistant message delta'
      ),
      notify(
        'item/completed',
        {
          item: {
            type: 'agentMessage',
            id: 'message-conf-simple',
            text: ANSWER_TEXT,
          },
        },
        'assistant message terminal'
      ),
      notify(
        'item/started',
        {
          item: {
            type: 'commandExecution',
            id: 'command-conf-simple',
            command: COMMAND,
            cwd: CWD,
          },
        },
        'command execution opens'
      ),
      notify(
        'item/commandExecution/outputDelta',
        { itemId: 'command-conf-simple', delta: COMMAND_OUTPUT },
        'command output delta'
      ),
      notify(
        'item/completed',
        {
          item: {
            type: 'commandExecution',
            id: 'command-conf-simple',
            command: COMMAND,
            cwd: CWD,
            aggregatedOutput: COMMAND_OUTPUT,
            exitCode: 0,
          },
        },
        'command execution terminal'
      ),
      notify(
        'item/started',
        {
          item: {
            type: 'fileChange',
            id: 'file-conf-simple',
            changes: [{ path: DIFF_PATH, kind: { type: 'update' }, diff: '' }],
          },
        },
        'file change opens'
      ),
      notify(
        'item/fileChange/patchUpdated',
        {
          itemId: 'file-conf-simple',
          changes: [{ path: DIFF_PATH, kind: { type: 'update' }, diff: DIFF }],
        },
        'cumulative patch update'
      ),
      notify(
        'item/completed',
        {
          item: {
            type: 'fileChange',
            id: 'file-conf-simple',
            changes: [
              { path: DIFF_PATH, kind: { type: 'update' }, diff: DIFF },
            ],
            applyStatus: 'applied',
          },
        },
        'file change terminal'
      ),
      notify(
        'item/started',
        {
          item: {
            type: 'mcpToolCall',
            id: 'mcp-conf-simple',
            server: 'github',
            tool: 'search',
            arguments: { query: 'fixture' },
          },
        },
        'mcp tool call opens'
      ),
      notify(
        'item/completed',
        {
          item: {
            type: 'mcpToolCall',
            id: 'mcp-conf-simple',
            server: 'github',
            tool: 'search',
            result: [],
          },
        },
        'mcp tool call terminal'
      ),
      request(
        60,
        'item/tool/requestUserInput',
        { questions: [{ id: 'q1', prompt: 'What is your name?' }] },
        'tool asks the operator a question'
      ),
      operatorAnswer(
        'input-60',
        { q1: ['Alice'] },
        'operator answers the question'
      ),
      notify(
        'thread/tokenUsageUpdated',
        {
          threadId: THREAD_ID,
          turnId: 'native-conf-simple',
          tokenUsage: TOKEN_USAGE,
        },
        'usage buffered for the terminal frame'
      ),
      notify(
        'turn/completed',
        {
          threadId: THREAD_ID,
          turn: { id: 'native-conf-simple', status: 'completed' },
        },
        'terminal turn frame'
      ),
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
      textIncludes: [ANSWER_TEXT, REASONING_SUMMARY, COMMAND],
    },
  },

  interruptedTurn: {
    prompt: 'conformance interrupted-turn',
    steps: [
      notify(
        'turn/started',
        { threadId: THREAD_ID, turn: { id: 'native-conf-interrupt' } },
        'native turn opens'
      ),
      notify(
        'item/started',
        { item: { type: 'agentMessage', id: 'message-conf-interrupt' } },
        'assistant message opens'
      ),
      notify(
        'item/agentMessage/delta',
        { itemId: 'message-conf-interrupt', delta: 'Partial handoff' },
        'partial answer before the interrupt'
      ),
      // interruptAfter: 3 → the harness calls interrupt() here, which sends
      // `turn/interrupt` against the live native turn id; the app-server then
      // terminalizes the partial item and reports the interrupted turn.
      notify(
        'item/completed',
        {
          item: {
            type: 'agentMessage',
            id: 'message-conf-interrupt',
            text: 'Partial handoff',
          },
        },
        'partial assistant message terminal'
      ),
      notify(
        'turn/completed',
        {
          threadId: THREAD_ID,
          turn: { id: 'native-conf-interrupt', status: 'interrupted' },
        },
        'interrupted terminal turn frame'
      ),
    ],
    interruptAfter: 3,
    expect: { terminalStatus: 'interrupted' },
  },

  errorTurn: {
    prompt: 'conformance error-turn',
    steps: [
      notify(
        'turn/started',
        { threadId: THREAD_ID, turn: { id: 'native-conf-error' } },
        'native turn opens'
      ),
      notify(
        'turn/completed',
        {
          threadId: THREAD_ID,
          turn: {
            id: 'native-conf-error',
            status: 'failed',
            error: { message: 'conformance provider failure' },
          },
        },
        'failed terminal turn frame'
      ),
    ],
    expect: { terminalStatus: 'failed' },
  },

  approvalFlow: {
    prompt: 'conformance approval-flow',
    request: [
      notify(
        'turn/started',
        { threadId: THREAD_ID, turn: { id: 'native-conf-approval' } },
        'native turn opens'
      ),
      request(
        70,
        'item/commandExecution/requestApproval',
        { command: 'rm -rf tmp', cwd: CWD, commandActions: [] },
        'command approval prompt'
      ),
    ],
    decision: { kind: 'accept', scope: 'once' },
    resolution: [
      notify(
        'turn/completed',
        {
          threadId: THREAD_ID,
          turn: { id: 'native-conf-approval', status: 'completed' },
        },
        'post-approval terminal turn frame'
      ),
    ],
    expect: { terminalStatus: 'completed' },
  },

  allowedSilentEvents: [
    {
      match: (step) =>
        step.kind === 'native' &&
        (step.event as { method?: string }).method ===
          'thread/tokenUsageUpdated',
      reason:
        'Codex reports usage on its own cadence, decoupled from the turn boundary. The adapter buffers the breakdown by native turn id and attaches it to the terminal agent-turn-completed-v2 patch, so the frame itself is deliberately patch-free — the user-visible consequence arrives on the completion, which the telemetry detector asserts.',
    },
  ],

  knownGaps: {
    'b-abandoned-approval': {
      issue: '#1407',
      reason:
        'teardownState() clears pendingApprovals/approvalMeta without settling the resolver, so handleCommandApprovalRequest never resumes: no native decision reaches the app-server and no agent-item-updated-v2 resolves the approval item. completeActiveTurn does drain live.activeRequestIds, but the reduced session keeps a permanently actionable approval card — the same shape as the claude gap',
    },
  },

  exercised: [
    'reasoning',
    'tools',
    'commandExecution',
    'fileChanges',
    'questions',
    'streaming',
    'telemetry',
  ],

  unexercisable: [
    {
      capability: 'plans',
      reason:
        'turn/plan/updated has no captured frame anywhere in the repo to transcribe, and the floor may not invent provider grammar; plan rendering is covered by the shared item mapping tests',
    },
    {
      capability: 'slashCommands',
      reason:
        'the catalog is built from model/list + skills/list at connect; the floor seeds empty catalogs so the transcript stays deterministic, and catalog merging is deep-tested in codex-native-adapter.test.ts',
    },
    {
      capability: 'steer',
      reason:
        'turn/steer choreography (successor ids, held terminals, rejection races) needs several turns in flight and is deep-tested in codex-native-adapter.test.ts',
    },
    {
      capability: 'queue',
      reason:
        'the floor transcript never has two Relay turns in flight, which is what queueing means here',
    },
    {
      capability: 'cancelQueued',
      reason:
        'nothing is ever queued in the floor transcript, so there is nothing to cancel',
    },
    {
      capability: 'resume',
      reason:
        'resume needs a second client generation (thread/resume against a saved threadId); deep-tested in codex-native-adapter.test.ts',
    },
    {
      capability: 'fork',
      reason:
        'forking a thread is a relay-control dispatch that opens a second provider conversation the floor lifecycle does not model',
    },
    {
      capability: 'rollback',
      reason:
        'thread/rollback rewinds provider history; the floor drives one forward transcript and asserts nothing about rewound turns',
    },
    {
      capability: 'compact',
      reason:
        'thread/compact/start is a relay-control dispatch, not a scripted native frame in this transcript',
    },
    {
      capability: 'rateLimits',
      reason: 'no rate-limit patch shape exists in AgentPatchV2 yet to detect',
    },
  ],
};

export default fixture;
