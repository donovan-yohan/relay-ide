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
  | 'pending-inbox'
  // Self-declared via the explicit presence overlay (#964). Additive only: it
  // can raise `needsAttention`, never clear a derived reason.
  | 'self-declared';

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
  const rawPendingInboxCount = Math.trunc(input.pendingInboxCount ?? 0);
  const pendingInboxCount = Number.isFinite(rawPendingInboxCount)
    ? Math.max(0, rawPendingInboxCount)
    : 0;
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
 * Provenance of a roster entry once the explicit presence overlay (#964) is
 * folded in: `derived` (session read model only), `self-declared` (an explicit
 * presence record with no matching live session — e.g. a non-Relay-launched
 * agent), or `merged` (a live session decorated with its self-declared overlay).
 */
export type RosterEntryOrigin = 'derived' | 'self-declared' | 'merged';

/**
 * The safe, self-declared overlay echoed onto a `merged` / `self-declared`
 * roster entry. Mirrors the sanitized presence fields; carries no secrets,
 * tokens, transcripts, or raw payloads (see `agent-presence.ts`).
 */
export interface SelfDeclaredPresence {
  presenceId: string;
  registeredBy?: string;
  role?: AgentRole;
  displayName?: string;
  useCase?: string;
  statusText?: string;
  needsAttention?: boolean;
  capabilityHints?: string[];
  updatedAt: string;
  expiresAt: string;
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
  /**
   * Provenance once explicit presence (#964) is merged in. Omitted on a purely
   * derived entry (treat as `derived`); set to `merged` / `self-declared` by the
   * presence merge so a reader can tell which fields are self-declared.
   */
  origin?: RosterEntryOrigin;
  /** Sanitized self-declared overlay applied to this entry, when present. */
  selfDeclared?: SelfDeclaredPresence;
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
 * Metadata-only `attention` event projection (#963, child of #952). Pure shape
 * builder so the live emitter in `server/index.ts` stays a thin adapter and the
 * projection is unit-testable without booting the hub. The result is fed to the
 * CLI-gateway metadata event bus (`topic: 'attention'`), which stamps
 * cursor/occurredAt/redaction and applies the payload redaction pass.
 *
 * Hard rule (same boundary as `RosterEntry`): NEVER include transcript text,
 * prompts, raw PTY bytes, provider-private state, tokens, or env. Only identity,
 * control, and coarse attention/session-state metadata.
 */
export interface AttentionEventInput {
  topic: 'attention';
  type: 'attention.state-changed';
  /** Local session id (also the primary `--session-id` filter key). */
  sessionId: string;
  /** Node-scoped session id (the `--global-session-id` filter key). */
  globalSessionId?: string;
  workContextId?: string;
  nodeId: string;
  /** Repo checkout path — the `--repo-path` filter key. */
  repoPath?: string;
  payload: Record<string, unknown>;
}

/**
 * Project one session-state transition into an `attention` event input. Derives
 * `needsAttention`/`reasons` via {@link deriveRosterAttention} so the roster and
 * the event stream agree on what "needs attention" means.
 */
export function buildAttentionEventInput(
  session: RosterSessionInput,
  opts: {
    /** Backend display state (idle|running|permission|error|initializing). */
    backendState: string;
    /** Prior backend display state, if known (omitted on first transition). */
    previousBackendState?: string | undefined;
    /** Open (queued/delivered) inbox count targeting this session. */
    pendingInboxCount?: number | undefined;
    /** Permission prompt kind when the transition is into a permission state. */
    permissionType?: string | undefined;
    /** Owning node id. */
    nodeId: string;
    roleOverrides?: Readonly<Record<string, AgentRole>> | undefined;
  }
): AttentionEventInput {
  const provider = (session.agent ?? '').trim();
  const attention = deriveRosterAttention({
    agentState: session.agentState,
    pendingInboxCount: opts.pendingInboxCount,
  });
  return {
    topic: 'attention',
    type: 'attention.state-changed',
    sessionId: session.id,
    ...(session.globalSessionId
      ? { globalSessionId: session.globalSessionId }
      : {}),
    ...(session.workContextId ? { workContextId: session.workContextId } : {}),
    nodeId: opts.nodeId,
    ...(session.repoPath ? { repoPath: session.repoPath } : {}),
    payload: {
      sessionId: session.id,
      ...(session.globalSessionId
        ? { globalSessionId: session.globalSessionId }
        : {}),
      backendState: opts.backendState,
      ...(opts.previousBackendState
        ? { previousBackendState: opts.previousBackendState }
        : {}),
      ...(session.agentState ? { agentState: session.agentState } : {}),
      needsAttention: attention.needsAttention,
      reasons: attention.reasons,
      pendingInboxCount: attention.pendingInboxCount,
      ...(opts.permissionType ? { permissionType: opts.permissionType } : {}),
      provider,
      role: roleForAgent(provider, opts.roleOverrides),
      sessionType: session.type ?? 'agent',
      ...(session.repoName ? { repoName: session.repoName } : {}),
      ...(session.branchName ? { branchName: session.branchName } : {}),
      ...(session.worktreePath !== undefined && session.worktreePath !== null
        ? { worktreePath: session.worktreePath }
        : {}),
    },
  };
}

/**
 * Collaboration system-prompt appendix (#953). A succinct, provider-neutral
 * block teaching a Relay-launched agent how to collaborate through Relay's
 * owned CLI/API primitives instead of acting like an isolated terminal. This is
 * the single AUTHORING source for that text.
 *
 * It is wired into the live PTY launch path for providers that declare support
 * (#955): `collaborationPromptArgsForFramework` (server/types.ts) pairs this
 * text with the framework's `collaborationPromptArg` (Claude
 * `--append-system-prompt`) and `createPtySession` appends it at launch.
 * Providers without that capability skip safely and may render this same text
 * into their own launch prompt. The string carries only Relay CLI-gateway
 * guidance — never transcripts, prompts, raw PTY bytes, tokens, or env — so it
 * is safe to pass as a launch argument.
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
    '- Announce yourself so others can find you, then heartbeat: `relay-ide v1 roster register --input-json \'{"role":"implementer","useCase":"<what you are doing>","sessionId":"<your session id>"}\' --json`, and periodically `relay-ide v1 roster update-self --input-json \'{"sessionId":"<your session id>","statusText":"<current status>"}\' --json`. Declare only role/use-case/status/capability hints — keep it metadata-only and never include anything sensitive.',
    '- Send a direct message / context to another session: `relay-ide v1 inbox send --json`.',
    '- Check and acknowledge your inbox at task boundaries: `relay-ide v1 inbox list --json`, then `inbox ack` / `inbox resolve` / `inbox ignore`.',
    '- React to messages and attention without a polling loop: subscribe to `relay-ide v1 events subscribe --topic inbox --json` and `relay-ide v1 events subscribe --topic attention --json` (use the per-event `cursor` with `--cursor` to resume).',
    '- Escalate a blocker or question by sending an inbox message to the relevant session or work context rather than spamming status checks.',
  ].join('\n');
}
