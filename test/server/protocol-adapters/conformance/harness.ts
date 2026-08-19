/**
 * Shared lifecycle harness for the adapter conformance suite.
 *
 * One transcript discipline drives every registered `ProtocolAdapterV2`:
 * connect → simple turn → interrupted turn → error turn → approval flow →
 * teardown, feeding one scripted native event at a time and letting the patch
 * stream go quiet between steps. That serialization is what makes invariant (c)
 * (no native event silently dropped) accountable per event and invariant (d)
 * (identical replay) free of race noise.
 *
 * Everything in this file is provider-agnostic CHOREOGRAPHY. Provider quirks
 * belong in `fixtures/<id>.fixture.ts`.
 */
import { beforeAll, expect, it } from 'vitest';
import {
  applyAgentPatchV2,
  emptyAgentSessionV2,
  type AgentApprovalItemV2,
  type AgentCapabilitySetV2,
  type AgentItemV2,
  type AgentPatchV2,
  type AgentSessionV2,
} from '../../../../shared/agent-chat-protocol-v2.js';
import type { ProtocolAdapterV2 } from '../../../../server/protocol-adapter-v2.js';
import { v2Adapters } from '../../../../server/protocol-adapters/index.js';
import type {
  AdapterConformanceFixture,
  ApprovalScript,
  ConformanceRig,
  FixtureFeedStep,
  InvariantId,
  TurnScript,
} from './fixture-types.js';

// ── Tunables ─────────────────────────────────────────────────────────────────

/** Consecutive quiet polls before a fed step is considered fully drained. */
const QUIESCENCE_POLLS = 3;
/** Upper bound on one step's quiescence wait. */
const QUIESCENCE_BUDGET_MS = 250;
/** Upper bound on any single `waitFor` predicate. */
const WAIT_TIMEOUT_MS = 3_000;
/**
 * Shorter budget for a wait the fixture has already told us will fail (a cited
 * `a-terminal` gap). Spending the full budget four times per run, twice per
 * determinism check, is pure wall clock — nothing is asserted on the result.
 */
const GAPPED_WAIT_TIMEOUT_MS = 500;
/** Upper bound on one whole lifecycle run. */
export const LIFECYCLE_TIMEOUT_MS = 30_000;

export type SegmentName =
  | 'connect'
  | 'simple-turn'
  | 'interrupted-turn'
  | 'error-turn'
  | 'approval-flow'
  | 'teardown';

const TURN_SEGMENTS = {
  'simple-turn': 'conf-simple',
  'interrupted-turn': 'conf-interrupt',
  'error-turn': 'conf-error',
  'approval-flow': 'conf-approval',
} as const;

type TurnSegmentName = keyof typeof TURN_SEGMENTS;

export type TerminalStatus = 'completed' | 'interrupted' | 'failed';

const DEFAULT_TERMINAL: Record<TurnSegmentName, TerminalStatus> = {
  'simple-turn': 'completed',
  'interrupted-turn': 'interrupted',
  'error-turn': 'failed',
  'approval-flow': 'completed',
};

// ── Capability reconciliation table ──────────────────────────────────────────

/**
 * Every flag on `AgentCapabilitySetV2`. The discovery suite cross-checks this
 * list against what registered adapters actually declare, so a new protocol
 * flag cannot slip past reconciliation unnoticed.
 */
export const ALL_CAPABILITIES = [
  'text',
  'reasoning',
  'tools',
  'commandExecution',
  'fileChanges',
  'approvals',
  'questions',
  'plans',
  'slashCommands',
  'queue',
  'steer',
  'interrupt',
  'cancelQueued',
  'resume',
  'fork',
  'rollback',
  'compact',
  'telemetry',
  'rateLimits',
  'streaming',
] as const satisfies readonly (keyof AgentCapabilitySetV2)[];

export type CapabilityName = (typeof ALL_CAPABILITIES)[number];

/**
 * Patch-evidence predicates. Adapter-agnostic by construction: a capability
 * "manifested" only when the V2 stream carried the shape a renderer needs.
 * Flags absent from this table are UNKNOWN-only in v1 — detectors are added as
 * the floor rises.
 */
const CAPABILITY_DETECTORS: Partial<
  Record<CapabilityName, (run: LifecycleRun) => boolean>
> = {
  text: (run) =>
    runItems(run).some(
      (item) => item.type === 'assistantMessage' && item.text.length > 0
    ) ||
    run.patches.some(
      (patch) =>
        patch.type === 'agent-item-delta-v2' &&
        typeof patch.delta.text === 'string' &&
        patch.delta.text.length > 0
    ),
  reasoning: (run) => runItems(run).some((item) => item.type === 'reasoning'),
  tools: (run) =>
    runItems(run).some(
      (item) => item.type === 'mcpToolCall' || item.type === 'dynamicToolCall'
    ),
  commandExecution: (run) =>
    runItems(run).some((item) => item.type === 'commandExecution'),
  fileChanges: (run) =>
    runItems(run).some((item) => item.type === 'fileChange'),
  approvals: (run) =>
    runItems(run).some(
      (item) => item.type === 'approval' && item.status === 'pending'
    ),
  questions: (run) => runItems(run).some((item) => item.type === 'question'),
  streaming: (run) =>
    run.patches.some((patch) => patch.type === 'agent-item-delta-v2'),
  interrupt: (run) =>
    run.patches.some(
      (patch) =>
        patch.type === 'agent-turn-completed-v2' &&
        patch.status === 'interrupted'
    ),
  telemetry: (run) =>
    run.patches.some(
      (patch) =>
        patch.type === 'agent-turn-completed-v2' &&
        patch.usage !== undefined &&
        Object.keys(patch.usage).length > 0
    ),
};

export const CAPABILITIES_WITHOUT_DETECTOR: readonly CapabilityName[] =
  ALL_CAPABILITIES.filter((name) => CAPABILITY_DETECTORS[name] === undefined);

// ── Lifecycle run ────────────────────────────────────────────────────────────

export interface SilentDrop {
  segment: SegmentName;
  index: number;
  step: FixtureFeedStep;
}

export interface ApprovalIdEvent {
  requestId: string;
  itemId: string;
  phase: 'requested' | 'resolved';
}

export interface LifecycleRun {
  adapterId: string;
  patches: AgentPatchV2[];
  segments: Record<SegmentName, AgentPatchV2[]>;
  /** Turn id opened by the harness per turn-bearing segment that actually ran. */
  turnIds: Partial<Record<TurnSegmentName, string>>;
  expectedTerminal: Partial<Record<TurnSegmentName, TerminalStatus>>;
  silentDrops: SilentDrop[];
  approvalIdTimeline: ApprovalIdEvent[];
  finalSession: AgentSessionV2;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function emptySegments(): Record<SegmentName, AgentPatchV2[]> {
  return {
    connect: [],
    'simple-turn': [],
    'interrupted-turn': [],
    'error-turn': [],
    'approval-flow': [],
    teardown: [],
  };
}

/** The turn a patch belongs to, or undefined for session-scoped patches. */
export function patchTurnId(patch: AgentPatchV2): string | undefined {
  switch (patch.type) {
    case 'agent-turn-started-v2':
      return patch.turn.id;
    case 'agent-item-started-v2':
    case 'agent-item-updated-v2':
    case 'agent-item-delta-v2':
    case 'agent-turn-completed-v2':
      return patch.turnId;
    case 'agent-error-v2':
      return patch.turnId;
    default:
      return undefined;
  }
}

function patchItems(patch: AgentPatchV2): AgentItemV2[] {
  switch (patch.type) {
    case 'agent-item-started-v2':
    case 'agent-item-updated-v2':
      return [patch.item];
    case 'agent-turn-started-v2':
      return patch.turn.items;
    case 'agent-session-snapshot-v2':
      return patch.session.turns.flatMap((turn) => turn.items);
    default:
      return [];
  }
}

function runItems(run: LifecycleRun): AgentItemV2[] {
  return run.patches.flatMap(patchItems);
}

function approvalItems(patches: AgentPatchV2[]): AgentApprovalItemV2[] {
  return patches
    .flatMap(patchItems)
    .filter((item): item is AgentApprovalItemV2 => item.type === 'approval');
}

/** Approval items a reduced session still shows as awaiting a human. */
export function pendingApprovalIds(session: AgentSessionV2): string[] {
  return session.turns
    .flatMap((turn) => turn.items)
    .filter(
      (item) =>
        item.type === 'approval' &&
        (item.status === 'pending' || item.status === 'running')
    )
    .map((item) => item.id);
}

function hasTerminal(patches: AgentPatchV2[], turnId: string): boolean {
  return patches.some(
    (patch) =>
      patch.type === 'agent-turn-completed-v2' && patch.turnId === turnId
  );
}

/**
 * Renderable text only. `textIncludes` needles are a content assertion, so
 * matching them against `JSON.stringify(item)` would let a needle be satisfied
 * by a key name, an item id, or a raw tool-argument blob the UI never shows.
 * This projection is the set of fields a renderer actually puts on screen.
 */
type RenderableFields = {
  [K in AgentItemV2['type']]?: (
    item: Extract<AgentItemV2, { type: K }>
  ) => Array<string | undefined>;
};

/**
 * `sessionBreak` and `providerExtension` are absent on purpose: neither renders
 * free text a fixture could legitimately assert on.
 */
const RENDERABLE_FIELDS: RenderableFields = {
  userMessage: (item) => [item.text, item.expandedText, item.command?.name],
  assistantMessage: (item) => [item.text],
  reasoning: (item) => [item.summary, item.detail],
  plan: (item) => [item.text, ...(item.steps ?? []).map((step) => step.step)],
  commandExecution: (item) => [
    item.command,
    item.output,
    ...(item.parsedActions ?? []),
  ],
  fileChange: (item) => [
    ...item.paths.flatMap((entry) => [entry.path, entry.oldPath]),
    item.patch,
  ],
  mcpToolCall: (item) => [item.server, item.tool, item.progress],
  dynamicToolCall: (item) => [item.namespace, item.tool, item.content],
  approval: (item) => [item.description, item.target, item.detail],
  question: (item) => [item.question],
  compaction: (item) => [item.summary],
  webSearch: (item) => [item.query, item.action],
  imageView: (item) => [item.source, item.description],
  imageGeneration: (item) => [item.prompt],
  hookPrompt: (item) => [item.prompt, item.source],
  errorMessage: (item) => [item.message, item.context],
};

export function renderableText(item: AgentItemV2): string {
  const project = RENDERABLE_FIELDS[item.type] as
    | ((value: AgentItemV2) => Array<string | undefined>)
    | undefined;
  return (project?.(item) ?? [])
    .filter((value): value is string => typeof value === 'string')
    .join('\n');
}

class SegmentTimeoutError extends Error {}

/**
 * Perform one operator action against the adapter. Operator moves are
 * choreography, not provider grammar: every adapter answers a question the same
 * way, so the harness drives them rather than each rig inventing a marker.
 */
async function runOperatorAction(
  adapter: ProtocolAdapterV2,
  step: Extract<FixtureFeedStep, { kind: 'operator' }>
): Promise<void> {
  if (step.action === 'respondToInput') {
    await adapter.respondToInput({
      requestId: step.requestId,
      answers: step.answers,
    });
    return;
  }
  throw new Error(
    `unknown conformance operator action: ${JSON.stringify(step)}`
  );
}

/**
 * Drive one fixture through the full lifecycle. Every wait is bounded and
 * `disconnect()`/`dispose()` are guaranteed, so a broken adapter fails the
 * suite instead of hanging it.
 */
export async function runLifecycle(
  fixture: AdapterConformanceFixture
): Promise<LifecycleRun> {
  const rig: ConformanceRig = await fixture.createRig();
  const adapter = rig.adapter;
  const patches: AgentPatchV2[] = [];
  const segments = emptySegments();
  const silentDrops: SilentDrop[] = [];
  const turnIds: LifecycleRun['turnIds'] = {};
  const expectedTerminal: LifecycleRun['expectedTerminal'] = {};

  const unsubscribe = adapter.onPatch((patch) => {
    patches.push(patch);
  });

  const settle = async (): Promise<void> => {
    if (rig.settle) {
      await rig.settle();
      return;
    }
    let stable = 0;
    let last = patches.length;
    const deadline = Date.now() + QUIESCENCE_BUDGET_MS;
    while (stable < QUIESCENCE_POLLS && Date.now() < deadline) {
      await sleep(1);
      if (patches.length === last) stable += 1;
      else {
        stable = 0;
        last = patches.length;
      }
    }
  };

  const waitFor = async (
    predicate: () => boolean,
    label: string,
    budgetMs: number = WAIT_TIMEOUT_MS
  ): Promise<void> => {
    const deadline = Date.now() + budgetMs;
    while (Date.now() < deadline) {
      if (predicate()) return;
      await sleep(1);
    }
    throw new SegmentTimeoutError(
      `[${fixture.adapterId}] timed out after ${budgetMs}ms waiting for ${label}`
    );
  };

  const guard = async <T>(
    promise: Promise<T>,
    label: string,
    budgetMs: number = WAIT_TIMEOUT_MS
  ): Promise<T> => {
    let timer: NodeJS.Timeout | undefined;
    const bomb = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new SegmentTimeoutError(
              `[${fixture.adapterId}] ${label} did not settle within ${budgetMs}ms`
            )
          ),
        budgetMs
      );
    });
    try {
      return await Promise.race([promise, bomb]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  const feedTracked = async (
    segment: SegmentName,
    index: number,
    step: FixtureFeedStep
  ): Promise<void> => {
    if (step.kind === 'operator') {
      // Not provider grammar: the harness performs the operator move itself and
      // it never enters the silent-drop ledger.
      await guard(
        runOperatorAction(adapter, step),
        `operator ${step.action}()`
      );
      await settle();
      return;
    }
    const before = patches.length;
    await rig.feed(step);
    await settle();
    if (patches.length !== before) return;
    if (step.kind === 'close') return;
    if (fixture.allowedSilentEvents?.some((allowed) => allowed.match(step)))
      return;
    silentDrops.push({ segment, index, step });
  };

  /**
   * Invariant (a) is the one gap that can abort the whole run: an adapter that
   * never ends a turn stalls every later segment. When the fixture cites an
   * `a-terminal` gap the harness keeps going, so the remaining invariants stay
   * assessable instead of collapsing into one un-diagnosable timeout. Any other
   * adapter still fails here, loudly.
   */
  const terminalGapped = fixture.knownGaps?.['a-terminal'] !== undefined;
  const turnBudgetMs = terminalGapped
    ? GAPPED_WAIT_TIMEOUT_MS
    : WAIT_TIMEOUT_MS;

  const awaitTerminal = async (
    segment: TurnSegmentName,
    turnId: string
  ): Promise<void> => {
    try {
      await waitFor(
        () => hasTerminal(patches, turnId),
        `${segment} terminal turn patch (${turnId})`,
        turnBudgetMs
      );
    } catch (err) {
      if (!terminalGapped) throw err;
    }
  };

  /** Same tolerance for the promises a never-ending turn can strand. */
  const guardTurnPromise = async (
    promise: Promise<unknown>,
    label: string
  ): Promise<void> => {
    try {
      await guard(promise, label, turnBudgetMs);
    } catch (err) {
      if (!terminalGapped) throw err;
    }
  };

  const runTurnSegment = async (
    segment: TurnSegmentName,
    script: TurnScript
  ): Promise<void> => {
    const turnId = TURN_SEGMENTS[segment];
    const start = patches.length;
    turnIds[segment] = turnId;
    expectedTerminal[segment] =
      script.expect?.terminalStatus ?? DEFAULT_TERMINAL[segment];

    const send = adapter.sendMessage({
      turnId,
      content: script.prompt ?? `conformance ${segment} turn`,
    });
    void send.catch(() => undefined);

    const cut = Math.min(
      script.interruptAfter ?? script.steps.length,
      script.steps.length
    );
    for (let i = 0; i < cut; i += 1) {
      await feedTracked(segment, i, script.steps[i]!);
    }

    let interrupted: Promise<void> | undefined;
    if (script.interruptAfter !== undefined) {
      interrupted = adapter.interrupt({ turnId });
      void interrupted.catch(() => undefined);
      await settle();
    }

    for (let i = cut; i < script.steps.length; i += 1) {
      await feedTracked(segment, i, script.steps[i]!);
    }

    await awaitTerminal(segment, turnId);
    if (interrupted)
      await guardTurnPromise(interrupted, `${segment} interrupt()`);
    await guardTurnPromise(send, `${segment} sendMessage()`);
    await settle();
    segments[segment] = patches.slice(start);
  };

  const runApprovalSegment = async (script: ApprovalScript): Promise<void> => {
    const segment = 'approval-flow' as const;
    const turnId = TURN_SEGMENTS[segment];
    const start = patches.length;
    turnIds[segment] = turnId;
    expectedTerminal[segment] =
      script.expect?.terminalStatus ?? DEFAULT_TERMINAL[segment];

    const send = adapter.sendMessage({
      turnId,
      content: script.prompt ?? `conformance ${segment} turn`,
    });
    void send.catch(() => undefined);

    for (let i = 0; i < script.request.length; i += 1) {
      await feedTracked(segment, i, script.request[i]!);
    }

    const pendingOf = (): AgentApprovalItemV2 | undefined =>
      approvalItems(patches.slice(start)).find(
        (item) => item.status === 'pending'
      );
    await waitFor(() => pendingOf() !== undefined, 'pending approval item');
    const pending = pendingOf()!;

    await guard(
      adapter.respondToApproval({
        requestId: pending.requestId,
        decision: script.decision,
      }),
      'respondToApproval()'
    );
    await settle();

    for (let i = 0; i < script.resolution.length; i += 1) {
      await feedTracked(
        segment,
        script.request.length + i,
        script.resolution[i]!
      );
    }

    await awaitTerminal(segment, turnId);
    await guardTurnPromise(send, `${segment} sendMessage()`);
    await settle();
    segments[segment] = patches.slice(start);
  };

  try {
    // 1. connect
    const connectStart = patches.length;
    const connecting = adapter.connect(rig.config);
    void connecting.catch(() => undefined);
    for (let i = 0; i < fixture.connect.steps.length; i += 1) {
      await feedTracked('connect', i, fixture.connect.steps[i]!);
    }
    await guard(connecting, 'connect()');
    await settle();
    segments.connect = patches.slice(connectStart);
    expect(
      adapter.status,
      `[${fixture.adapterId}] connect() must leave the adapter connected`
    ).toBe('connected');

    // 2-4. turn segments
    await runTurnSegment('simple-turn', fixture.simpleTurn);
    await runTurnSegment('interrupted-turn', fixture.interruptedTurn);
    if (!('exempt' in fixture.errorTurn)) {
      await runTurnSegment('error-turn', fixture.errorTurn);
    }

    // 5. approval flow
    if (fixture.approvalFlow) await runApprovalSegment(fixture.approvalFlow);

    // 6. teardown
    const teardownStart = patches.length;
    const teardownSteps = fixture.teardown?.steps ?? [];
    for (let i = 0; i < teardownSteps.length; i += 1) {
      await feedTracked('teardown', i, teardownSteps[i]!);
    }
    await guard(adapter.disconnect(), 'disconnect()');
    await settle();
    segments.teardown = patches.slice(teardownStart);
  } finally {
    // A failed segment must not leak a live adapter into the next run: a
    // scripted transcript that times out mid-turn still owes teardown.
    if (adapter.status !== 'disconnected') {
      await adapter.disconnect().catch(() => undefined);
    }
    unsubscribe();
    await rig.dispose();
  }

  return {
    adapterId: fixture.adapterId,
    patches,
    segments,
    turnIds,
    expectedTerminal,
    silentDrops,
    approvalIdTimeline: approvalItems(patches).map((item) => ({
      requestId: item.requestId,
      itemId: item.id,
      phase: item.status === 'pending' ? 'requested' : 'resolved',
    })),
    finalSession: reducePatches(patches, rig, adapter),
  };
}

function reducePatches(
  patches: AgentPatchV2[],
  rig: ConformanceRig,
  adapter: ProtocolAdapterV2
): AgentSessionV2 {
  let session = emptyAgentSessionV2({
    id: rig.config.sessionId,
    provider: adapter.agentType,
    cwd: rig.config.cwd,
    capabilities: adapter.capabilities,
  });
  for (const patch of patches) session = applyAgentPatchV2(session, patch);
  return session;
}

/**
 * The teardown half of invariant (b): abandon a live approval and disconnect.
 * Returns the session reduced from everything the adapter emitted.
 */
export async function runAbandonedApprovalProbe(
  fixture: AdapterConformanceFixture
): Promise<AgentSessionV2> {
  const script = fixture.approvalFlow;
  if (!script) throw new Error('runAbandonedApprovalProbe needs approvalFlow');
  const rig = await fixture.createRig();
  const adapter = rig.adapter;
  const patches: AgentPatchV2[] = [];
  adapter.onPatch((patch) => patches.push(patch));

  const settle = async (): Promise<void> => {
    if (rig.settle) return rig.settle();
    let stable = 0;
    let last = patches.length;
    const deadline = Date.now() + QUIESCENCE_BUDGET_MS;
    while (stable < QUIESCENCE_POLLS && Date.now() < deadline) {
      await sleep(1);
      if (patches.length === last) stable += 1;
      else {
        stable = 0;
        last = patches.length;
      }
    }
  };

  try {
    const connecting = adapter.connect(rig.config);
    void connecting.catch(() => undefined);
    for (const step of fixture.connect.steps) {
      await rig.feed(step);
      await settle();
    }
    await connecting;

    const send = adapter.sendMessage({
      turnId: 'conf-approval-abandoned',
      content: script.prompt ?? 'conformance approval-flow turn',
    });
    void send.catch(() => undefined);
    for (const step of script.request) {
      await rig.feed(step);
      await settle();
    }

    // The probe is only meaningful if there IS a live approval to abandon. An
    // adapter that never surfaces the pending item would otherwise sail through
    // the "nothing left pending" assertion vacuously, so a missing approval is
    // a hard failure of the probe rather than a silent skip.
    const deadline = Date.now() + WAIT_TIMEOUT_MS;
    let surfaced = false;
    while (Date.now() < deadline) {
      if (approvalItems(patches).some((item) => item.status === 'pending')) {
        surfaced = true;
        break;
      }
      await sleep(1);
    }
    if (!surfaced) {
      throw new Error(
        `[${fixture.adapterId}] abandoned-approval probe: the scripted approvalFlow surfaced no pending approval item within ${WAIT_TIMEOUT_MS}ms, so there is nothing to abandon`
      );
    }

    await adapter.disconnect();
    await settle();
    await send.catch(() => undefined);
  } finally {
    if (adapter.status !== 'disconnected') {
      await adapter.disconnect().catch(() => undefined);
    }
    await rig.dispose();
  }

  return reducePatches(patches, rig, adapter);
}

// ── Replay normalization ─────────────────────────────────────────────────────

/** Wall-clock fields an adapter legitimately re-derives on every run. */
const VOLATILE_KEYS = new Set([
  'timestamp',
  'startedAt',
  'completedAt',
  'durationMs',
]);
const VOLATILE_PLACEHOLDER = '<volatile>';

function blankPath(root: unknown, path: string): void {
  const segments = path.split('.');
  const last = segments.pop();
  if (!last) return;
  let cursors: unknown[] = [root];
  for (const segment of segments) {
    cursors = cursors.flatMap((cursor) => {
      if (Array.isArray(cursor)) return cursor.flatMap((entry) => [entry]);
      if (cursor && typeof cursor === 'object')
        return [(cursor as Record<string, unknown>)[segment]];
      return [];
    });
  }
  for (const cursor of cursors) {
    if (Array.isArray(cursor)) {
      for (const entry of cursor) {
        if (entry && typeof entry === 'object')
          (entry as Record<string, unknown>)[last] = VOLATILE_PLACEHOLDER;
      }
      continue;
    }
    if (cursor && typeof cursor === 'object')
      (cursor as Record<string, unknown>)[last] = VOLATILE_PLACEHOLDER;
  }
}

/**
 * Blank wall-clock only. IDs are deliberately NOT normalized: id stability is
 * part of determinism, so rigs must pin pids, provider session ids, and any
 * scripted native ids.
 */
export function normalizePatchForReplay(
  patch: AgentPatchV2,
  volatilePaths: string[] = []
): unknown {
  const clone: unknown = structuredClone(patch);
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const entry of node) walk(entry);
      return;
    }
    if (!node || typeof node !== 'object') return;
    const record = node as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (VOLATILE_KEYS.has(key)) record[key] = VOLATILE_PLACEHOLDER;
      else walk(record[key]);
    }
  };
  walk(clone);
  for (const path of volatilePaths) blankPath(clone, path);
  return clone;
}

// ── Capability reconciliation ────────────────────────────────────────────────

export type CapabilityVerdict = 'ok' | 'drift' | 'unknown';

export interface CapabilityRow {
  capability: CapabilityName;
  declared: boolean;
  attempted: boolean;
  manifested: boolean;
  verdict: CapabilityVerdict;
  note: string;
}

export interface CapabilityReport {
  rows: CapabilityRow[];
  drift: CapabilityRow[];
  /** Fixture-authoring mistakes: fake attestations, missing approval scripts. */
  fixtureErrors: string[];
  table: string;
}

function builtInAttempts(
  fixture: AdapterConformanceFixture
): Set<CapabilityName> {
  const attempts = new Set<CapabilityName>(['text', 'interrupt']);
  if (fixture.approvalFlow) attempts.add('approvals');
  return attempts;
}

/**
 * DRIFT is only ever claimed from evidence: a capability the transcript SAW
 * working while the registry declares it false, or one the transcript actively
 * exercised while the registry declares it true and nothing manifested. A
 * capability the fixture never drove is UNKNOWN and never fails.
 */
export function reconcileCapabilities(input: {
  declared: AgentCapabilitySetV2;
  run: LifecycleRun;
  fixture: AdapterConformanceFixture;
}): CapabilityReport {
  const { declared, run, fixture } = input;
  const fixtureErrors: string[] = [];
  const builtIns = builtInAttempts(fixture);

  const attempted = new Set<CapabilityName>(builtIns);
  for (const capability of fixture.exercised ?? []) {
    if (CAPABILITY_DETECTORS[capability as CapabilityName] === undefined) {
      fixtureErrors.push(
        `exercised['${capability}'] has no conformance detector — a fixture may not attest a capability the harness cannot observe`
      );
      continue;
    }
    attempted.add(capability as CapabilityName);
  }

  const unexercisable = new Map<CapabilityName, string>();
  for (const entry of fixture.unexercisable ?? []) {
    const capability = entry.capability as CapabilityName;
    if (builtIns.has(capability)) {
      fixtureErrors.push(
        `unexercisable['${capability}'] is a built-in the harness always exercises — remove the entry or fix the transcript`
      );
      continue;
    }
    unexercisable.set(capability, entry.reason);
  }

  if (declared.approvals === true && !fixture.approvalFlow) {
    if (!unexercisable.has('approvals')) {
      fixtureErrors.push(
        'registry declares approvals:true but the fixture has no approvalFlow and no unexercisable entry for it'
      );
    }
  }

  const rows: CapabilityRow[] = ALL_CAPABILITIES.map((capability) => {
    const detector = CAPABILITY_DETECTORS[capability];
    const isDeclared = declared[capability] === true;
    const isAttempted = attempted.has(capability);
    const manifested = detector ? detector(run) : false;
    let verdict: CapabilityVerdict;
    let note = '';
    if (manifested && !isDeclared) {
      verdict = 'drift';
      note = 'observed working but declared false';
    } else if (manifested) {
      verdict = 'ok';
    } else if (!isAttempted) {
      verdict = 'unknown';
      note = detector
        ? (unexercisable.get(capability) ?? 'not exercised by this fixture')
        : 'no detector in v1';
    } else if (isDeclared) {
      verdict = 'drift';
      note = 'declared true and exercised, but never manifested';
    } else {
      verdict = 'ok';
      note = 'honest false';
    }
    return {
      capability,
      declared: isDeclared,
      attempted: isAttempted,
      manifested,
      verdict,
      note,
    };
  });

  // Fixture silence is not free. A capability the registry declares true, that
  // the harness CAN observe, must either be driven by the transcript or carry a
  // written `unexercisable` waiver — otherwise deleting a transcript step
  // quietly downgrades a real row to UNKNOWN and the floor stops biting there.
  for (const row of rows) {
    if (!row.declared || row.attempted || row.manifested) continue;
    if (CAPABILITY_DETECTORS[row.capability] === undefined) continue;
    if (unexercisable.has(row.capability)) continue;
    // Already reported above with a more specific message.
    if (row.capability === 'approvals' && !fixture.approvalFlow) continue;
    fixtureErrors.push(
      `declared-true capability '${row.capability}' is neither exercised nor waived — add it to \`exercised\` (and drive it in the transcript) or write an \`unexercisable\` entry saying why this fixture cannot`
    );
  }

  return {
    rows,
    drift: rows.filter((row) => row.verdict === 'drift'),
    fixtureErrors,
    table: formatCapabilityTable(run.adapterId, rows),
  };
}

function formatCapabilityTable(
  adapterId: string,
  rows: CapabilityRow[]
): string {
  const header = `capability reconciliation — ${adapterId}`;
  const body = rows.map((row) =>
    [
      row.capability.padEnd(17),
      `declared=${String(row.declared).padEnd(5)}`,
      `attempted=${String(row.attempted).padEnd(5)}`,
      `manifested=${String(row.manifested).padEnd(5)}`,
      row.verdict.toUpperCase().padEnd(7),
      row.note,
    ].join(' ')
  );
  return [header, ...body].join('\n');
}

// ── Suite registration ───────────────────────────────────────────────────────

function registeredAdapter(adapterId: string): ProtocolAdapterV2 {
  const factory = (v2Adapters as Record<string, () => ProtocolAdapterV2>)[
    adapterId
  ];
  if (!factory) throw new Error(`no registered adapter for '${adapterId}'`);
  return factory();
}

/** A skip must cite a real issue and say why, on the record. */
const GAP_ISSUE_PATTERN = /^#\d+$/;
/** Same floor the `errorTurn.exempt` escape hatch already carries. */
const MIN_JUSTIFICATION_LENGTH = 10;

export function describeMalformedGap(
  id: InvariantId,
  gap: { issue: string; reason: string; capabilities?: readonly string[] }
): string | undefined {
  if (!GAP_ISSUE_PATTERN.test(gap.issue)) {
    return `knownGaps['${id}'].issue must be a '#<number>' citation, got ${JSON.stringify(gap.issue)}`;
  }
  if (gap.reason.trim().length <= MIN_JUSTIFICATION_LENGTH) {
    return `knownGaps['${id}'].reason needs a written justification (>${MIN_JUSTIFICATION_LENGTH} chars), got ${JSON.stringify(gap.reason)}`;
  }
  if (gap.capabilities !== undefined && id !== 'e-capability-drift') {
    return `knownGaps['${id}'].capabilities only narrows 'e-capability-drift'`;
  }
  if (gap.capabilities?.length === 0) {
    return `knownGaps['${id}'].capabilities is empty — drop the field to skip the whole invariant, or name the drifting rows`;
  }
  return undefined;
}

function describeDrop(drop: SilentDrop): string {
  const label =
    'label' in drop.step && drop.step.label ? ` (${drop.step.label})` : '';
  const body =
    drop.step.kind === 'native'
      ? JSON.stringify(drop.step.event)
      : JSON.stringify(drop.step);
  return `${drop.segment}[${drop.index}]${label}: ${body}`;
}

/**
 * Register the conformance floor for one adapter. Every `it` here is generic —
 * a fixture contributes data and a rig, never assertions.
 */
export function describeAdapterConformance(
  adapterId: string,
  fixture: AdapterConformanceFixture
): void {
  let run: LifecycleRun | undefined;
  let runError: unknown;

  beforeAll(async () => {
    try {
      run = await runLifecycle(fixture);
    } catch (err) {
      runError = err;
    }
  }, LIFECYCLE_TIMEOUT_MS);

  const requireRun = (): LifecycleRun => {
    if (runError) throw runError;
    if (!run)
      throw new Error(`[${adapterId}] lifecycle run did not produce a result`);
    return run;
  };

  const invariant = (
    id: InvariantId,
    name: string,
    fn: () => Promise<void> | void
  ): void => {
    const gap = fixture.knownGaps?.[id];
    if (gap) {
      // A skip is only honest if it cites something a reader can go read. An
      // unparseable citation buys a FAILING test, not a green skip.
      const malformed = describeMalformedGap(id, gap);
      if (malformed) {
        it(`${name} [invalid known gap]`, () => {
          expect.fail(`[${adapterId}] ${malformed}`);
        });
        return;
      }
      it.skip(`${name} [known gap ${gap.issue}: ${gap.reason}]`, fn);
      return;
    }
    it(name, fn, LIFECYCLE_TIMEOUT_MS);
  };

  it('fixture adapterId matches its registration', () => {
    expect(fixture.adapterId).toBe(adapterId);
  });

  it('every known gap cites a real issue and a written reason', () => {
    const malformed = Object.entries(fixture.knownGaps ?? {}).flatMap(
      ([id, gap]) => {
        const problem = describeMalformedGap(id as InvariantId, gap);
        return problem ? [problem] : [];
      }
    );
    expect(
      malformed,
      `[${adapterId}] knownGaps entries must cite an issue as '#<number>' and carry a written reason`
    ).toEqual([]);
  });

  it(
    'registry parity: rig adapter is a faithful twin of the registered factory',
    async () => {
      const registered = registeredAdapter(adapterId);
      const rig = await fixture.createRig();
      try {
        expect(rig.adapter.agentType).toBe(registered.agentType);
        expect(
          rig.adapter.capabilities,
          `[${adapterId}] the rig's seam-injected twin must declare the registry's exact capability set`
        ).toEqual(registered.capabilities);
      } finally {
        await rig.dispose();
      }
    },
    LIFECYCLE_TIMEOUT_MS
  );

  it('scripted segment expectations hold', () => {
    const result = requireRun();
    const expectations: Array<[TurnSegmentName, TurnScript | ApprovalScript]> =
      [
        ['simple-turn', fixture.simpleTurn],
        ['interrupted-turn', fixture.interruptedTurn],
      ];
    if (!('exempt' in fixture.errorTurn))
      expectations.push(['error-turn', fixture.errorTurn]);
    if (fixture.approvalFlow)
      expectations.push(['approval-flow', fixture.approvalFlow]);

    for (const [segment, script] of expectations) {
      const expectation = script.expect;
      if (!expectation) continue;
      const patches = result.segments[segment];
      for (const patchType of expectation.requiredPatchTypes ?? []) {
        expect(
          patches.map((patch) => patch.type),
          `[${adapterId}/${segment}] required patch type ${patchType} never appeared`
        ).toContain(patchType);
      }

      // The declared terminal STATUS is asserted here as well as in invariant
      // (a), because an `a-terminal` gap is whole-invariant: without this the
      // status floor would vanish for every segment of a fixture whose gap is
      // really about one segment (hermes double-terminals only its error turn).
      if (expectation.terminalStatus) {
        const completions = patches.filter(
          (patch) => patch.type === 'agent-turn-completed-v2'
        );
        if (completions.length === 0) {
          expect(
            fixture.knownGaps?.['a-terminal'],
            `[${adapterId}/${segment}] no agent-turn-completed-v2 in the segment and no cited a-terminal known gap`
          ).toBeDefined();
        } else {
          const terminal = completions[completions.length - 1]!;
          expect(
            terminal.type === 'agent-turn-completed-v2' && terminal.status,
            `[${adapterId}/${segment}] terminal status`
          ).toBe(expectation.terminalStatus);
        }
      }

      if (!expectation.textIncludes?.length) continue;
      // Renderable text only — see `renderableText`. Matching raw JSON would
      // let a needle pass on a key name, an id, or a tool-argument blob.
      const text = patches.flatMap(patchItems).map(renderableText).join('\n');
      for (const needle of expectation.textIncludes) {
        expect(
          text.includes(needle),
          `[${adapterId}/${segment}] expected rendered item text to include ${JSON.stringify(needle)}`
        ).toBe(true);
      }
    }
  });

  invariant(
    'a-terminal',
    '(a) every turn ends with exactly one terminal turn-completed patch',
    () => {
      const result = requireRun();
      const segmentNames = Object.keys(result.turnIds) as TurnSegmentName[];
      expect(
        segmentNames.length,
        `[${adapterId}] no turn segments ran`
      ).toBeGreaterThan(0);
      for (const segment of segmentNames) {
        const turnId = result.turnIds[segment]!;
        const completions = result.patches.filter(
          (patch) =>
            patch.type === 'agent-turn-completed-v2' && patch.turnId === turnId
        );
        expect(
          completions.length,
          `[${adapterId}/${segment}] expected exactly one agent-turn-completed-v2 for ${turnId}`
        ).toBe(1);
        const terminal = completions[0]!;
        const carrying = result.patches.filter(
          (patch) => patchTurnId(patch) === turnId
        );
        expect(
          carrying[carrying.length - 1],
          `[${adapterId}/${segment}] a patch for ${turnId} was emitted after its terminal patch`
        ).toBe(terminal);
        expect(
          terminal.type === 'agent-turn-completed-v2' && terminal.status,
          `[${adapterId}/${segment}] terminal status`
        ).toBe(result.expectedTerminal[segment]);
      }
      if ('exempt' in fixture.errorTurn) {
        expect(
          fixture.errorTurn.exempt.length,
          `[${adapterId}] errorTurn exemption needs a written justification`
        ).toBeGreaterThan(10);
      } else {
        const errorTurnId = result.turnIds['error-turn']!;
        const failedByPatch = result.patches.some(
          (patch) =>
            patch.type === 'agent-error-v2' && patch.turnId === errorTurnId
        );
        const failedByField = result.patches.some(
          (patch) =>
            patch.type === 'agent-turn-completed-v2' &&
            patch.turnId === errorTurnId &&
            typeof patch.error === 'string' &&
            patch.error.length > 0
        );
        expect(
          failedByPatch || failedByField,
          `[${adapterId}] a failed turn must carry an agent-error-v2 patch or an error on its completion`
        ).toBe(true);
      }
    }
  );

  invariant(
    'b-approval-ids',
    '(b) approval ids stay stable across the approval lifecycle',
    () => {
      const result = requireRun();
      const byRequest = new Map<string, Set<string>>();
      for (const event of result.approvalIdTimeline) {
        const ids = byRequest.get(event.requestId) ?? new Set<string>();
        ids.add(event.itemId);
        byRequest.set(event.requestId, ids);
      }
      for (const [requestId, itemIds] of byRequest) {
        expect(
          [...itemIds],
          `[${adapterId}] approval ${requestId} changed item id mid-lifecycle`
        ).toHaveLength(1);
      }
      if (fixture.approvalFlow) {
        expect(
          byRequest.size,
          `[${adapterId}] approvalFlow surfaced no approval item`
        ).toBeGreaterThan(0);
        expect(
          result.approvalIdTimeline.some((event) => event.phase === 'resolved'),
          `[${adapterId}] the approval never reached a resolved state`
        ).toBe(true);
      }
    }
  );

  invariant(
    'b-teardown',
    '(b) no approval is left pending after teardown',
    () => {
      const result = requireRun();
      expect(
        pendingApprovalIds(result.finalSession),
        `[${adapterId}] approval item still pending in the reduced session after teardown`
      ).toEqual([]);
      expect(
        result.finalSession.live.activeRequestIds,
        `[${adapterId}] live.activeRequestIds not drained after teardown`
      ).toEqual([]);
    }
  );

  // The harder half: tear down while an approval is still outstanding. A
  // fixture without an approvalFlow has nothing to abandon.
  if (fixture.approvalFlow) {
    invariant(
      'b-abandoned-approval',
      '(b) disconnecting on a live approval resolves it',
      async () => {
        requireRun();
        const abandoned = await runAbandonedApprovalProbe(fixture);
        expect(
          pendingApprovalIds(abandoned),
          `[${adapterId}] disconnecting on a live approval left it pending`
        ).toEqual([]);
        expect(
          abandoned.live.activeRequestIds,
          `[${adapterId}] disconnecting on a live approval left live.activeRequestIds populated`
        ).toEqual([]);
      }
    );
  }

  invariant(
    'c-no-silent-drop',
    '(c) no scripted native event is silently dropped',
    () => {
      const result = requireRun();
      expect(
        result.silentDrops.map(describeDrop),
        `[${adapterId}] these native events produced no patch and no allowedSilentEvents entry covers them`
      ).toEqual([]);
    }
  );

  invariant(
    'd-determinism',
    '(d) replaying the transcript yields an identical patch sequence',
    async () => {
      const first = requireRun();
      const second = await runLifecycle(fixture);
      const normalize = (patches: AgentPatchV2[]): unknown[] =>
        patches.map((patch) =>
          normalizePatchForReplay(patch, fixture.volatileJsonPaths ?? [])
        );
      expect(
        second.patches.map((patch) => patch.type),
        `[${adapterId}] replay produced a different patch-type sequence`
      ).toEqual(first.patches.map((patch) => patch.type));
      expect(
        normalize(second.patches),
        `[${adapterId}] replay produced different patch payloads`
      ).toEqual(normalize(first.patches));
    }
  );

  // Invariant (e) is the one gap that can be scoped: a `capabilities` list on
  // the gap excludes only the cited rows, so `fixtureErrors` and the other
  // rows keep biting instead of the whole reconciliation table going dark.
  const capabilityGap = fixture.knownGaps?.['e-capability-drift'];
  const gappedCapabilities = new Set<string>(capabilityGap?.capabilities ?? []);
  const capabilityInvariantName =
    gappedCapabilities.size > 0 && capabilityGap
      ? `(e) declared capabilities reconcile with observed behavior [known gap ${capabilityGap.issue} scoped to ${[...gappedCapabilities].join(', ')}]`
      : '(e) declared capabilities reconcile with observed behavior';

  const reconcile = (): void => {
    const result = requireRun();
    const declared = registeredAdapter(adapterId).capabilities;
    const report = reconcileCapabilities({ declared, run: result, fixture });
    expect(
      report.fixtureErrors,
      `[${adapterId}] fixture authoring errors`
    ).toEqual([]);
    const drift = report.drift.filter(
      (row) => !gappedCapabilities.has(row.capability)
    );
    expect(
      drift.map((row) => `${row.capability}: ${row.note}`),
      `[${adapterId}] capability drift\n\n${report.table}\n`
    ).toEqual([]);
    // A scoped gap that no longer drifts is a stale gap: delete the entry.
    for (const capability of gappedCapabilities) {
      expect(
        report.drift.some((row) => row.capability === capability),
        `[${adapterId}] knownGaps['e-capability-drift'].capabilities still cites '${capability}', but it no longer drifts — remove it`
      ).toBe(true);
    }
  };

  if (gappedCapabilities.size > 0) {
    it(capabilityInvariantName, reconcile, LIFECYCLE_TIMEOUT_MS);
  } else {
    invariant('e-capability-drift', capabilityInvariantName, reconcile);
  }
}
