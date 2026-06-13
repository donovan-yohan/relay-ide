import type { ControlActor, ControlMode } from './control-state.js';

// Active-agent roster primitive (#953). A roster entry is a redaction-safe,
// metadata-only projection of one live Relay session so humans and other agents
// can DISCOVER already-running collaborators in the same repo / WorkContext and
// decide who to message. It is DERIVED from the existing session read model
// (`SessionSummary`) plus a few cheap joins (framework capabilities, pending
// inbox count); it introduces no new persistence and is not an event stream.
//
// Hard rule: a roster entry NEVER carries transcript text, prompts, raw PTY
// bytes, provider-private state, tokens, or env. Only identity, control, and
// coarse status/attention metadata. Keep this module free of `server/` imports
// so the contract/tests can reuse it without pulling the runtime.

/**
 * Lightweight collaboration role / use-case hint for an agent. NOT an
 * authorization boundary and NOT a hard-coded architecture: it is a default
 * label so a roster reader can tell "who implements" from "who reviews" at a
 * glance. Providers/operators may override per session; unknown providers fall
 * back to `collaborator`.
 */
export type AgentRole =
  | 'implementer'
  | 'reviewer'
  | 'orchestrator'
  | 'context'
  | 'collaborator';

export const AGENT_ROLES: readonly AgentRole[] = [
  'implementer',
  'reviewer',
  'orchestrator',
  'context',
  'collaborator',
] as const;

/**
 * Default provider/agent-kind → role map. Keyed by the lowercased agent kind
 * (the gateway `agent` field / framework id), deliberately NOT by a closed
 * `BuiltinFrameworkId` union so custom providers and aliases (e.g. `ebi`) can
 * register a default without a type change. This is a HINT map, not the
 * architecture: Relay projects one collaboration vocabulary across providers
 * and does not assume these three agents are the only consumers.
 */
export const DEFAULT_AGENT_ROLE_MAP: Readonly<Record<string, AgentRole>> = {
  claude: 'implementer',
  codex: 'reviewer',
  opencode: 'implementer',
  hermes: 'orchestrator',
  ebi: 'orchestrator',
};

/** Resolve the default role for an agent kind, with optional per-call overrides. */
export function roleForAgent(
  agent: string | undefined,
  overrides?: Readonly<Record<string, AgentRole>>
): AgentRole {
  if (!agent) return 'collaborator';
  const key = agent.trim().toLowerCase();
  if (!key) return 'collaborator';
  return overrides?.[key] ?? DEFAULT_AGENT_ROLE_MAP[key] ?? 'collaborator';
}

/** Why a roster entry is flagged as needing attention. */
export type RosterAttentionReason =
  | 'permission-prompt'
  | 'waiting-for-input'
  | 'error'
  | 'pending-inbox';

export interface RosterAttention {
  /** True when any attention reason is present. */
  needsAttention: boolean;
  /** Distinct reasons, stable order. */
  reasons: RosterAttentionReason[];
  /** Open (queued/delivered, non-acked, non-terminal) inbox messages targeting this session. */
  pendingInboxCount: number;
}

/**
 * Derive the attention signal for a session. Mirrors the frontend
 * `activeWorkAttentionPriority` heuristic (agent waiting on a human) and folds
 * in the evented inbox backlog (#945) so the roster answers "who needs me /
 * who is waiting on a message" without a polling loop.
 */
export function deriveRosterAttention(input: {
  agentState?: string | undefined;
  pendingInboxCount?: number | undefined;
}): RosterAttention {
  const reasons: RosterAttentionReason[] = [];
  if (input.agentState === 'permission-prompt')
    reasons.push('permission-prompt');
  else if (input.agentState === 'waiting-for-input')
    reasons.push('waiting-for-input');
  if (input.agentState === 'error') reasons.push('error');
  const pendingInboxCount = Math.max(
    0,
    Math.trunc(input.pendingInboxCount ?? 0)
  );
  if (pendingInboxCount > 0) reasons.push('pending-inbox');
  return { needsAttention: reasons.length > 0, reasons, pendingInboxCount };
}

/** Metadata-only control actor projection (no raw bytes/state). */
export interface RosterActor {
  kind: ControlActor['kind'];
  id?: string;
  displayName?: string;
}

/**
 * One active agent/session in the roster. Redaction-safe: identity + control +
 * coarse status only. Field set tracks the #953 acceptance list.
 */
export interface RosterEntry {
  sessionId: string;
  globalSessionId?: string;
  nodeId?: string;
  /** Provider / agent kind (framework id), e.g. `claude` | `codex` | `hermes`. */
  provider: string;
  /** `agent` | `terminal`. */
  sessionType: string;
  /** Collaboration role hint (see `AgentRole`). */
  role: AgentRole;
  displayName: string;
  repoPath?: string;
  repoName?: string;
  worktreePath?: string | null;
  branchName?: string;
  cwd?: string;
  workContextId?: string;
  controlMode?: ControlMode;
  /** `active` | `disconnected`. */
  status?: string;
  /** `initializing` | `waiting-for-input` | `processing` | `permission-prompt` | `error` | `idle`. */
  agentState?: string;
  attention: RosterAttention;
  /** Framework capability flags that are enabled, e.g. `['hooks','continue']`. */
  capabilities: string[];
  /** Active control actors (kind/id/displayName only). */
  activeActors?: RosterActor[];
  lastActivity?: string;
  createdAt?: string;
}

export interface AgentRoster {
  generatedAt: string;
  nodeId?: string;
  count: number;
  entries: RosterEntry[];
}

/**
 * Structural input the projector reads. `SessionSummary` (server/types.ts) is a
 * superset, so the router passes it directly; tests can pass a minimal literal.
 */
export interface RosterSessionInput {
  id: string;
  globalSessionId?: string | undefined;
  nodeId?: string | undefined;
  agent?: string | undefined;
  type?: string | undefined;
  displayName?: string | undefined;
  repoPath?: string | undefined;
  repoName?: string | undefined;
  worktreePath?: string | null | undefined;
  branchName?: string | undefined;
  cwd?: string | undefined;
  workContextId?: string | undefined;
  controlMode?: ControlMode | undefined;
  status?: string | undefined;
  agentState?: string | undefined;
  activeActors?: ReadonlyArray<ControlActor> | undefined;
  lastActivity?: string | undefined;
  createdAt?: string | undefined;
}

function projectActors(
  actors: ReadonlyArray<ControlActor> | undefined
): RosterActor[] | undefined {
  if (!actors || actors.length === 0) return undefined;
  return actors.map((actor) => ({
    kind: actor.kind,
    ...(actor.id ? { id: actor.id } : {}),
    ...(actor.displayName ? { displayName: actor.displayName } : {}),
  }));
}

/**
 * Project one live session into a redaction-safe roster entry. Pure: all
 * external joins (capabilities, pending inbox count, role overrides) are passed
 * in by the caller so this stays unit-testable without the runtime.
 */
export function projectRosterEntry(
  session: RosterSessionInput,
  extras: {
    capabilities?: readonly string[];
    pendingInboxCount?: number;
    roleOverrides?: Readonly<Record<string, AgentRole>>;
  } = {}
): RosterEntry {
  const provider = (session.agent ?? '').trim();
  const attention = deriveRosterAttention({
    agentState: session.agentState,
    pendingInboxCount: extras.pendingInboxCount,
  });
  const actors = projectActors(session.activeActors);
  return {
    sessionId: session.id,
    ...(session.globalSessionId
      ? { globalSessionId: session.globalSessionId }
      : {}),
    ...(session.nodeId ? { nodeId: session.nodeId } : {}),
    provider,
    sessionType: session.type ?? 'agent',
    role: roleForAgent(provider, extras.roleOverrides),
    displayName: session.displayName ?? session.id,
    ...(session.repoPath ? { repoPath: session.repoPath } : {}),
    ...(session.repoName ? { repoName: session.repoName } : {}),
    ...(session.worktreePath !== undefined
      ? { worktreePath: session.worktreePath }
      : {}),
    ...(session.branchName ? { branchName: session.branchName } : {}),
    ...(session.cwd ? { cwd: session.cwd } : {}),
    ...(session.workContextId ? { workContextId: session.workContextId } : {}),
    ...(session.controlMode ? { controlMode: session.controlMode } : {}),
    ...(session.status ? { status: session.status } : {}),
    ...(session.agentState ? { agentState: session.agentState } : {}),
    attention,
    capabilities: [...(extras.capabilities ?? [])],
    ...(actors ? { activeActors: actors } : {}),
    ...(session.lastActivity ? { lastActivity: session.lastActivity } : {}),
    ...(session.createdAt ? { createdAt: session.createdAt } : {}),
  };
}

/**
 * Collaboration system-prompt appendix (#953). A succinct, provider-neutral
 * block teaching a Relay-launched agent how to collaborate through Relay's
 * owned CLI/API primitives instead of acting like an isolated terminal. This is
 * the AUTHORING source; wiring it into the live launch path (e.g. Claude
 * `--append-system-prompt`) is a follow-up slice — there is no prompt-injection
 * seam today (`server/protocol-adapter.ts` `systemPrompt` is inert). Exposed as
 * a tested building block so docs and any future launcher agree on one text.
 */
export function collaborationPromptAppendix(
  input: {
    role?: AgentRole;
    provider?: string;
  } = {}
): string {
  const role = input.role ?? roleForAgent(input.provider);
  return [
    `You are a Relay-managed agent session (role: ${role}). You are not an isolated terminal — other agents and operators can see and message you through Relay. Use Relay's CLI gateway to collaborate instead of polling:`,
    '',
    '- Identify yourself / your work context: `relay-ide v1 sessions list --json` and `relay-ide v1 work-contexts get --json`.',
    '- Discover active collaborators in this repo / work context: `relay-ide v1 roster list --json` (filter with `--repo` or `--work-context-id`).',
    '- Send a direct message / context to another session: `relay-ide v1 inbox send --json`.',
    '- Check and acknowledge your inbox at task boundaries: `relay-ide v1 inbox list --json`, then `inbox ack` / `inbox resolve` / `inbox ignore`.',
    '- React to messages and attention without a polling loop: subscribe to `relay-ide v1 events subscribe --topic inbox --json`.',
    '- Escalate a blocker or question by sending an inbox message to the relevant session or work context rather than spamming status checks.',
  ].join('\n');
}
