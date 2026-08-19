/**
 * Fixture contract for the adapter conformance suite.
 *
 * A fixture is DATA plus a rig builder. Every native `event` payload must be
 * transcribed from a real captured provider stream (the per-adapter deep tests
 * under `test/server/protocol-adapters/` and `test/fixtures/`), never invented
 * grammar. Provider quirks — event vocabularies, terminal shapes, which native
 * events legally produce no patch — live here in the fixture. All sequencing
 * and assertion choreography lives in `harness.ts`, mirroring the quirk vs
 * choreography rule in `server/protocol-adapters/AGENTS.md`.
 */
import type {
  AdapterConfig,
  ProtocolAdapterV2,
} from '../../../../server/protocol-adapter-v2.js';
import type {
  AgentApprovalDecisionV2,
  AgentCapabilitySetV2,
  AgentPatchV2,
} from '../../../../shared/agent-chat-protocol-v2.js';

/**
 * One scripted move against the rig's offline transport.
 *
 * `native` and `server-request` are PROVIDER grammar and are therefore
 * accountable to invariant (c). `operator` is a human action with no wire frame
 * of its own — the harness performs it against the adapter directly and it is
 * exempt from the silent-drop ledger, exactly like `close`. `transport-reply`
 * is the provider's answer to a request the ADAPTER made (an HTTP response, an
 * RPC reply): still provider grammar, still ledgered, but delivered through the
 * rig's own transport double rather than an inbound event channel.
 */
export type FixtureFeedStep =
  | { kind: 'native'; event: unknown; label?: string }
  | {
      kind: 'server-request';
      id: string | number;
      method: string;
      params?: unknown;
      label?: string;
    }
  /** The operator answers a structured question the agent asked. */
  | {
      kind: 'operator';
      action: 'respondToInput';
      requestId: string;
      answers: Record<string, string[]>;
      label?: string;
    }
  /** A reply to an adapter-initiated request lands now (deferred HTTP/RPC). */
  | {
      kind: 'transport-reply';
      id: string | number;
      payload?: unknown;
      label?: string;
    }
  | { kind: 'close'; code?: number | null; label?: string };

/**
 * A seam-injected twin of `v2Adapters[id]()` wired to an offline transport.
 * `createRig` must be callable repeatedly and must produce byte-identical
 * patch streams for the same script — fixed pids, fixed provider session ids,
 * scripted native ids.
 */
export interface ConformanceRig {
  adapter: ProtocolAdapterV2;
  config: AdapterConfig;
  feed(step: FixtureFeedStep): void | Promise<void>;
  /** Override the harness quiescence wait for transports that need longer. */
  settle?(): Promise<void>;
  dispose(): Promise<void>;
}

export interface TurnExpectation {
  /** Patch types that must appear at least once in the segment. */
  requiredPatchTypes?: AgentPatchV2['type'][];
  terminalStatus?: 'completed' | 'interrupted' | 'failed';
  /** Sanity substrings that must appear in the segment's item text. */
  textIncludes?: string[];
}

export interface TurnScript {
  /** Default: `conformance <segment> turn`. */
  prompt?: string;
  steps: FixtureFeedStep[];
  /**
   * Interrupted turn only. The harness feeds `steps[0..interruptAfter)`, calls
   * `interrupt()`, then feeds the remainder (provider ack / terminal frames).
   */
  interruptAfter?: number;
  expect?: TurnExpectation;
}

export interface ApprovalScript {
  prompt?: string;
  /** Steps that surface a pending approval item. May be empty (self-scripted). */
  request: FixtureFeedStep[];
  decision: AgentApprovalDecisionV2;
  /** Provider events after the decision, ending the turn. */
  resolution: FixtureFeedStep[];
  expect?: TurnExpectation;
}

export type InvariantId =
  | 'a-terminal'
  | 'b-approval-ids'
  /** Full-lifecycle log, teardown included, leaves nothing pending. */
  | 'b-teardown'
  /** Disconnecting ON a live approval leaves nothing pending. */
  | 'b-abandoned-approval'
  | 'c-no-silent-drop'
  | 'd-determinism'
  | 'e-capability-drift';

export interface AdapterConformanceFixture {
  adapterId: string;
  createRig(): ConformanceRig | Promise<ConformanceRig>;
  /** Handshake/init events fed while `connect()` is in flight. */
  connect: { steps: FixtureFeedStep[] };
  simpleTurn: TurnScript;
  interruptedTurn: TurnScript;
  /** `exempt` needs a written justification; invariant (a)-on-error → UNKNOWN. */
  errorTurn: TurnScript | { exempt: string };
  /** Required iff registry `capabilities.approvals === true`, else `unexercisable`. */
  approvalFlow?: ApprovalScript;
  teardown?: { steps?: FixtureFeedStep[] };
  /** Events that legally produce zero patches (acks, buffering). Reviewed prose. */
  allowedSilentEvents?: Array<{
    match: (step: FixtureFeedStep) => boolean;
    reason: string;
  }>;
  /** Capabilities beyond the built-ins this transcript genuinely attempts. */
  exercised?: Array<keyof AgentCapabilitySetV2>;
  /** Declared-true capabilities this fixture cannot script → UNKNOWN, never drift. */
  unexercisable?: Array<{
    capability: keyof AgentCapabilitySetV2;
    reason: string;
  }>;
  /**
   * Honest escape hatch for pre-existing violations. `issue` must be a real
   * `#<number>` citation and `reason` must be written prose — the harness
   * enforces both, so `{ issue: 'TODO' }` cannot buy a skip.
   *
   * `capabilities` narrows an `e-capability-drift` gap to the named rows: the
   * invariant still runs, still reports fixture-authoring errors, and still
   * fails on drift in every other row. Prefer it to a whole-invariant skip.
   */
  knownGaps?: Partial<
    Record<
      InvariantId,
      {
        issue: string;
        reason: string;
        capabilities?: Array<keyof AgentCapabilitySetV2>;
      }
    >
  >;
  /** Determinism escape hatch for adapter-generated noise. Prefer fixing the rig. */
  volatileJsonPaths?: string[];
}
