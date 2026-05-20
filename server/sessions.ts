import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  AgentType,
  AgentState,
  AgentFramework,
  BackendDisplayState,
  ContinuePolicy,
  PtySession,
  Session,
  SessionSummary,
  SessionMeta,
  SessionType,
  WebSession,
} from './types.js';
export type { BackendDisplayState };
import {
  AGENT_CONTINUE_ARGS,
  AGENT_YOLO_ARGS,
  resolveFramework,
} from './types.js';
import {
  createPtySession,
  generateTmuxSessionName,
  upgradeHooksSettings,
} from './pty-handler.js';
import { cleanupCodexHooksAdapter } from './codex-hooks-adapter.js';
import type { CreatePtyParams } from './pty-handler.js';
import {
  createWebSession,
  reconnectWebSession,
  continueHereWebSession,
  type CreateWebParams,
} from './web-session-handler.js';
import {
  loadAllWebSessions,
  deleteWebSession,
  upsertWebSessionNow,
} from './relay-state-db.js';
import { applyWebSessionPatchV2 } from './web-session-v2-state.js';
import { getWorkingTreeDiff } from './git.js';
import {
  DEFAULT_LOCAL_NODE_ID,
  createGlobalSessionId,
  createRepoInstanceId,
  createWorktreeInstanceId,
} from '../shared/identity.js';
import { getPrForBranch, isStalePr } from './gh.js';
import {
  trackEvent,
  recordSessionEvent,
  upsertSessionRollup,
} from './analytics.js';
import { buildSessionEvent } from './session-attribution.js';
import { createLogger } from './logger.js';
import type { SessionLane } from '../shared/session-lane.js';
import {
  deriveSessionDurability,
  type SessionDurabilityNodeStatus,
  type SessionDurabilityState,
} from '../shared/session-durability.js';
import {
  DEFAULT_SESSION_REPLAY_CAPACITY_BYTES,
  type SessionReplaySnapshot,
} from '../shared/session-replay.js';
import {
  isControlStateSummary,
  normalizeControlStateSummary,
  type ControlStateSummary,
  type ControlActor,
  type TabControlEvent,
  type InterventionRecord,
} from '../shared/control-state.js';
import {
  LOCAL_COMPATIBILITY_SESSION_INTENT,
  normalizeSessionEnvelope,
} from '../shared/session-envelope.js';
import {
  sessionEnvelopeRegistry,
  type SessionRenewResult,
} from './session-envelope-registry.js';
import {
  acknowledgeHumanInput,
  applyControlModeAction,
  maybeAutoRevertToAgentDriven,
  recordHumanPtyInput,
  type ControlModeAction,
} from './control-engine.js';
import {
  listInterventions,
  listUnackedHumanInput,
} from './intervention-log.js';
import {
  validateAgentHandBackAck,
  type SessionControlError,
} from './session-control-api.js';
import {
  securityAuditEntryForTabControlEvent,
  type SecurityAuditEntryInput,
} from '../shared/security-audit.js';

const execFileAsync = promisify(execFile);
const logger = createLogger('sessions');
const TMUX_COMMAND = 'tmux';

// ── Global scrollback cap ──────────────────────────────────────────────────────

/** Default global scrollback cap across all sessions: 4 MB. */
const DEFAULT_GLOBAL_SCROLLBACK_CAP = 4 * 1024 * 1024;

/** Module-level global cap, overridden by configure(). */
let globalScrollbackCapBytes = DEFAULT_GLOBAL_SCROLLBACK_CAP;

/**
 * Running total of scrollback bytes across all PTY sessions.
 * Updated incrementally on append (via onScrollbackAppend) and decremented
 * when chunks are trimmed, so the enforcement hot-path can skip the O(N)
 * full-walk when the total is under the cap.
 */
let globalScrollbackTotalBytes = 0;

/**
 * Enforce the global scrollback cap across all PTY sessions.
 *
 * - Uses the pre-computed running total (fast path: returns early when under cap).
 * - If the total exceeds the cap, trims oldest scrollback from non-active
 *   sessions first (sorted by lastActivity ascending).
 * - Never trims the currently-focused (activeSessionId) session.
 *
 * @param activeSessionId - ID of the session currently being appended to (never trimmed).
 * @param sessionProvider - Optional override for the sessions list; defaults to the
 *   module-level `sessions` Map. Inject in tests to avoid spinning up live PTYs.
 *
 * Returns the number of bytes freed.
 */
function enforceGlobalScrollbackCap(
  activeSessionId?: string | null,
  sessionProvider?: () => PtySession[]
): number {
  const ptySessions = sessionProvider
    ? sessionProvider()
    : [...sessions.values()].filter((s): s is PtySession => s.mode === 'pty');

  // Recompute the running total from the canonical session list so the local
  // variable stays consistent with the actual scrollback state.
  let total = ptySessions.reduce(
    (sum, s) => sum + s.scrollback.reduce((b, chunk) => b + chunk.length, 0),
    0
  );
  // Keep the module-level counter in sync.
  globalScrollbackTotalBytes = total;

  if (total <= globalScrollbackCapBytes) return 0;

  // Sort non-active sessions oldest-activity-first.
  const eligible = ptySessions
    .filter((s) => s.id !== activeSessionId)
    .sort((a, b) => a.lastActivity.localeCompare(b.lastActivity));

  let freed = 0;
  for (const session of eligible) {
    if (total <= globalScrollbackCapBytes) break;
    // Trim oldest chunks one-by-one until this session's scrollback is clear.
    while (session.scrollback.length > 0 && total > globalScrollbackCapBytes) {
      const chunk = session.scrollback.shift()!;
      total -= chunk.length;
      freed += chunk.length;
    }
  }

  // Keep the running total in sync after trimming.
  globalScrollbackTotalBytes = total;

  if (freed > 0) {
    logger.debug(
      'global scrollback cap: freed %d bytes (cap=%d)',
      freed,
      globalScrollbackCapBytes
    );
  }

  return freed;
}

interface SerializedPtySession {
  id: string;
  type: SessionType;
  agent: AgentType;
  repoPath?: string;
  worktreePath?: string | null;
  cwd: string;
  repoName?: string;
  branchName?: string;
  displayName: string;
  createdAt: string;
  lastActivity: string;
  useTmux: boolean;
  tmuxSessionName: string;
  customCommand: string | null;
  yolo?: boolean;
  claudeArgs?: string[];
  hookToken?: string;
  hooksActive?: boolean;
  needsBranchRename?: boolean;
  branchRenamePrompt?: string;
  continuePolicy?: ContinuePolicy;
  workspaceId?: string;
  additionalDirs?: string[];
  controlState?: ControlStateSummary;
  pendingSince?: string;
}

type RestartReason =
  | 'update'
  | 'dev-restart'
  | 'signal-shutdown'
  | 'shutdown'
  | 'crash-recovery'
  | 'manual'
  | 'unspecified';

interface PendingSessionsFile {
  version: number; // now 7 — control-state summaries are serialized
  timestamp: string;
  reason?: RestartReason | string;
  sessions: SerializedPtySession[];
}

interface SerializeOptions {
  reason?: RestartReason | string;
}

const STALE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

export type CreateParams = Omit<CreatePtyParams, 'id' | 'callbacks'> & {
  id?: string;
  needsBranchRename?: boolean;
  branchRenamePrompt?: string;
  initialPrompt?: string;
  workspaceId?: string;
  additionalDirs?: string[];
  sessionLane?: SessionLane;
};

export type CreateResult = SessionSummary & { pid: number | undefined };

// In-memory registry: id -> Session
const sessions = new Map<string, Session>();
const routedPtyControlSessions = new Map<string, Session>();

// Session metadata cache: session ID or worktree path -> SessionMeta
const metaCache = new Map<string, SessionMeta>();

// Module-level defaults for hooks injection (set via configure())
let defaultPort: number | undefined;
let defaultForceOutputParser: boolean | undefined;
let defaultConfigDir: string | undefined;
let defaultInterventionDebounceMs: number | undefined;
let defaultCoDrivenAutoRevertMs: number | undefined;
let defaultSecurityAuditSink:
  | { append(input: SecurityAuditEntryInput): unknown }
  | undefined;
let defaultMaxScrollbackPerSessionBytes: number | undefined;

function configure(opts: {
  port?: number;
  forceOutputParser?: boolean;
  configDir?: string;
  interventionDebounceMs?: number;
  coDrivenAutoRevertMs?: number;
  securityAuditSink?: { append(input: SecurityAuditEntryInput): unknown };
  /** Global scrollback cap across all sessions in bytes. Default: 4 MB. */
  maxScrollbackGlobalBytes?: number;
  /** Per-session scrollback cap in bytes. Default: 256 KB. */
  maxScrollbackPerSessionBytes?: number;
}): void {
  defaultPort = opts.port;
  defaultForceOutputParser = opts.forceOutputParser;
  defaultConfigDir = opts.configDir;
  defaultInterventionDebounceMs = opts.interventionDebounceMs;
  defaultCoDrivenAutoRevertMs = opts.coDrivenAutoRevertMs;
  defaultSecurityAuditSink = opts.securityAuditSink;
  if (opts.maxScrollbackGlobalBytes !== undefined) {
    globalScrollbackCapBytes = opts.maxScrollbackGlobalBytes;
  }
  if (opts.maxScrollbackPerSessionBytes !== undefined) {
    defaultMaxScrollbackPerSessionBytes = opts.maxScrollbackPerSessionBytes;
  }
}

function withLocalIdentity<T extends SessionSummary>(
  summary: T
): T & { sessionEnvelope: NonNullable<SessionSummary['sessionEnvelope']> } {
  const nodeId = DEFAULT_LOCAL_NODE_ID;
  const globalSessionId = createGlobalSessionId(nodeId, summary.id);
  const base = {
    ...summary,
    nodeId,
    globalSessionId,
    ...(summary.repoPath
      ? { repoInstanceId: createRepoInstanceId(nodeId, summary.repoPath) }
      : {}),
    ...(summary.worktreePath
      ? {
          worktreeInstanceId: createWorktreeInstanceId(
            nodeId,
            summary.worktreePath
          ),
        }
      : {}),
  };
  return {
    ...base,
    sessionEnvelope: normalizeSessionEnvelope(
      summary.sessionEnvelope,
      {
        sessionId: summary.id,
        nodeId,
        globalSessionId,
        cwd: summary.cwd,
        ...(summary.repoPath ? { repoPath: summary.repoPath } : {}),
        ...(summary.worktreePath !== undefined
          ? { worktreePath: summary.worktreePath }
          : {}),
        issuedAt: summary.createdAt,
      },
      LOCAL_COMPATIBILITY_SESSION_INTENT
    ),
  } as T & { sessionEnvelope: NonNullable<SessionSummary['sessionEnvelope']> };
}

let terminalCounter = 0;
let agentCounter = 0;

type StateChangeCallback = (sessionId: string, state: AgentState) => void;
const stateChangeCallbacks: StateChangeCallback[] = [];

type ControlEventCallback = (event: TabControlEvent) => void;
const controlEventCallbacks: ControlEventCallback[] = [];

function onControlEvent(cb: ControlEventCallback): () => void {
  controlEventCallbacks.push(cb);
  return () => {
    const idx = controlEventCallbacks.indexOf(cb);
    if (idx >= 0) controlEventCallbacks.splice(idx, 1);
  };
}

function fireControlEvent(event: TabControlEvent): void {
  for (const cb of [...controlEventCallbacks]) {
    try {
      cb(event);
    } catch (err) {
      logger.warn(
        'control event listener failed for event %s: %s',
        event.eventId,
        err
      );
    }
  }
}

function auditControlEvent(event: TabControlEvent): void {
  if (!defaultSecurityAuditSink) return;
  try {
    defaultSecurityAuditSink.append(
      securityAuditEntryForTabControlEvent(event)
    );
  } catch (err) {
    logger.warn(
      'security audit append failed for control event %s: %s',
      event.eventId,
      err
    );
  }
}

function emitAndAuditControlEvent(event: TabControlEvent): void {
  fireControlEvent(event);
  auditControlEvent(event);
}

function controlEngineOptions() {
  return {
    ...(defaultInterventionDebounceMs !== undefined
      ? { inputDebounceMs: defaultInterventionDebounceMs }
      : {}),
    ...(defaultCoDrivenAutoRevertMs !== undefined
      ? { autoRevertMs: defaultCoDrivenAutoRevertMs }
      : {}),
    emitEvent: emitAndAuditControlEvent,
  };
}

function onStateChange(cb: StateChangeCallback): void {
  stateChangeCallbacks.push(cb);
}

export function __resetStateChangeCallbacksForTests(): void {
  stateChangeCallbacks.length = 0;
  controlEventCallbacks.length = 0;
}

type SessionCreateCallback = (
  sessionId: string,
  cwd: string,
  branchName?: string
) => void;
const sessionCreateCallbacks: SessionCreateCallback[] = [];

function onSessionCreate(cb: SessionCreateCallback): () => void {
  sessionCreateCallbacks.push(cb);
  return () => {
    const idx = sessionCreateCallbacks.indexOf(cb);
    if (idx >= 0) sessionCreateCallbacks.splice(idx, 1);
  };
}

function fireSessionCreate(
  sessionId: string,
  cwd: string,
  branchName?: string
): void {
  for (const cb of sessionCreateCallbacks) {
    try {
      cb(sessionId, cwd, branchName);
    } catch (err) {
      logger.error('sessionCreate callback error:', err);
    }
  }
}

type SessionEndCallback = (
  sessionId: string,
  cwd: string,
  branchName?: string
) => void;
const sessionEndCallbacks: SessionEndCallback[] = [];

function onSessionEnd(cb: SessionEndCallback): () => void {
  sessionEndCallbacks.push(cb);
  return () => {
    const idx = sessionEndCallbacks.indexOf(cb);
    if (idx >= 0) sessionEndCallbacks.splice(idx, 1);
  };
}

function fireSessionEnd(
  sessionId: string,
  cwd: string,
  branchName?: string
): void {
  for (const cb of sessionEndCallbacks) {
    try {
      cb(sessionId, cwd, branchName);
    } catch (err) {
      logger.error('sessionEnd callback error:', err);
    }
  }
}

export function fireStateChange(sessionId: string, state: AgentState): void {
  for (const cb of [...stateChangeCallbacks]) cb(sessionId, state);
  // Push durability transitions through the live state-change channel so
  // event-stream consumers see `permission-needed` / `error` / etc. without
  // waiting for the next `list()` poll.
  const session = sessions.get(sessionId);
  if (session) emitDurabilityIfChanged(session);
}

type DurabilityChangeCallback = (event: {
  sessionId: string;
  from: SessionDurabilityState | undefined;
  to: SessionDurabilityState;
  at: string;
}) => void;
const durabilityChangeCallbacks: DurabilityChangeCallback[] = [];

function onSessionDurabilityChanged(cb: DurabilityChangeCallback): () => void {
  durabilityChangeCallbacks.push(cb);
  return () => {
    const idx = durabilityChangeCallbacks.indexOf(cb);
    if (idx >= 0) durabilityChangeCallbacks.splice(idx, 1);
  };
}

// Resolver for hub-side node link health. Composition root wires this to
// `hubNodeRegistry`; defaults to `null` so unit tests and the local-only
// path do not need to think about it. Returning `null` means "no hub-side
// opinion" and trusts local signals.
type SessionNodeStatusResolver = (
  nodeId: string | undefined
) => SessionDurabilityNodeStatus;
let nodeStatusResolver: SessionNodeStatusResolver = () => null;

function setSessionNodeStatusResolver(
  resolver: SessionNodeStatusResolver | null
): void {
  nodeStatusResolver = resolver ?? (() => null);
}

function resolveNodeStatus(session: Session): SessionDurabilityNodeStatus {
  try {
    return nodeStatusResolver(session.nodeId ?? undefined);
  } catch (err) {
    logger.warn(
      'session node status resolver threw; treating as no-opinion: %s',
      err instanceof Error ? err.message : String(err)
    );
    return null;
  }
}

function emitDurabilityIfChanged(session: Session): SessionDurabilityState {
  const next = deriveSessionDurability({
    status: session.status,
    agentState: session.agentState,
    idle: session.idle,
    nodeStatus: resolveNodeStatus(session),
    ...(session.mode === 'pty' && session.cleanedUp ? { cleanedUp: true } : {}),
  });
  const previous = session._lastEmittedDurability;
  if (previous === next) return next;
  session._lastEmittedDurability = next;
  const event = {
    sessionId: session.id,
    from: previous,
    to: next,
    at: new Date().toISOString(),
  };
  for (const cb of [...durabilityChangeCallbacks]) {
    try {
      cb(event);
    } catch (err) {
      logger.error('durabilityChange callback error:', err);
    }
  }
  return next;
}

/**
 * Re-derive durability for the named sessions (or every session when no
 * filter is given) and emit transitions. Use this when a non-agent signal
 * changes — e.g. node link goes stale, attach socket count crosses zero.
 */
function refreshDurability(sessionIds?: Iterable<string>): void {
  const ids = sessionIds ? Array.from(sessionIds) : Array.from(sessions.keys());
  for (const id of ids) {
    const session = sessions.get(id);
    if (session) emitDurabilityIfChanged(session);
  }
}

export function computeBackendState(session: {
  agentState: AgentState;
  idle: boolean;
}): BackendDisplayState {
  if (session.agentState === 'permission-prompt') return 'permission';
  if (session.agentState === 'error') return 'error';
  if (session.agentState === 'processing') return 'running';
  if (session.agentState === 'initializing') return 'initializing';
  if (
    session.agentState === 'idle' ||
    session.agentState === 'waiting-for-input'
  )
    return 'idle';
  // Terminal/custom sessions don't report agentState — use the idle flag from PTY activity.
  return session.idle ? 'idle' : 'running';
}

type BackendStateChangeCallback = (
  sessionId: string,
  state: BackendDisplayState,
  permissionType?: 'approval' | 'question'
) => void;
const backendStateChangeCallbacks: BackendStateChangeCallback[] = [];

export function onBackendStateChange(cb: BackendStateChangeCallback): void {
  backendStateChangeCallbacks.push(cb);
}

export function fireBackendStateIfChanged(session: Session): void {
  const newState = computeBackendState(session);

  let permissionType: 'approval' | 'question' | undefined;
  if (newState === 'permission') {
    permissionType =
      session.currentActivity?.tool === 'AskUserQuestion'
        ? 'question'
        : 'approval';
  }

  if (
    session._lastEmittedBackendState === newState &&
    session._lastEmittedPermissionType === permissionType
  )
    return;
  session._lastEmittedBackendState = newState;
  session._lastEmittedPermissionType = permissionType;

  for (const cb of [...backendStateChangeCallbacks]) {
    try {
      cb(session.id, newState, permissionType);
    } catch (err) {
      logger.error('backendStateChange callback error:', err);
    }
  }
  // Backend state + status are the only inputs to durability that can flip
  // outside the `fireStateChange` path (e.g. the resume-failure setter
  // mutates `status` + `agentState` directly). Re-derive here so consumers
  // see the transition over the event stream immediately.
  emitDurabilityIfChanged(session);
}

function create({
  id: providedId,
  needsBranchRename,
  branchRenamePrompt,
  initialPrompt,
  workspaceId,
  additionalDirs,
  agent = 'claude',
  cols = 80,
  rows = 24,
  args = [],
  port,
  forceOutputParser,
  frameworks,
  ...rest
}: CreateParams): CreateResult {
  const id = providedId || crypto.randomBytes(8).toString('hex');

  const ptyParams: CreatePtyParams = {
    ...rest,
    id,
    agent,
    cols,
    rows,
    args,
    port: port ?? defaultPort,
    forceOutputParser: forceOutputParser ?? defaultForceOutputParser,
    configDir: rest.configDir ?? defaultConfigDir,
    frameworks,
    // Per-session cap: params override config default; pty-handler uses its own default if undefined.
    ...(rest.maxScrollbackBytes !== undefined
      ? { maxScrollbackBytes: rest.maxScrollbackBytes }
      : defaultMaxScrollbackPerSessionBytes !== undefined
        ? { maxScrollbackBytes: defaultMaxScrollbackPerSessionBytes }
        : {}),
  };

  const { session: ptySession, result } = createPtySession(
    {
      ...ptyParams,
      callbacks: {
        onStateChange: stateChangeCallbacks,
        onSessionEnd: [
          ...sessionEndCallbacks,
          (sessionId: string) => sessionEnvelopeRegistry.delete(sessionId),
        ],
        fireBackendStateIfChanged,
        onScrollbackAppend: (
          appendedSessionId: string,
          appendedBytes: number
        ) => {
          // Maintain the running total incrementally so the O(N) enforcement
          // walk is skipped entirely when we are still under the cap. This avoids
          // summing all scrollback chunks on every PTY data chunk.
          globalScrollbackTotalBytes += appendedBytes;
          if (globalScrollbackTotalBytes <= globalScrollbackCapBytes) return;
          // Cap exceeded — run the full enforcement. It recomputes the true total
          // and updates globalScrollbackTotalBytes so subsequent fast-path checks
          // reflect any chunks that were trimmed.
          enforceGlobalScrollbackCap(appendedSessionId);
        },
      },
    },
    sessions
  );
  trackEvent({
    category: 'session',
    action: 'created',
    target: id,
    properties: {
      agent,
      type: rest.type ?? 'agent',
      workspace: rest.repoPath,
      mode: rest.command ? 'terminal' : 'agent',
      ...(rest.sessionLane ? { sessionLane: rest.sessionLane } : {}),
    },
    session_id: id,
  });
  if (needsBranchRename) {
    ptySession.needsBranchRename = true;
  }
  if (branchRenamePrompt) {
    ptySession.branchRenamePrompt = branchRenamePrompt;
  }
  if (initialPrompt) {
    ptySession.initialPrompt = initialPrompt;
  }
  if (workspaceId) {
    ptySession.workspaceId = workspaceId;
  }
  if (additionalDirs?.length) {
    ptySession.additionalDirs = additionalDirs;
  }
  fireSessionCreate(id, ptySession.cwd, ptySession.branchName);
  // Record session start for analytics
  recordSessionEvent(
    buildSessionEvent(ptySession, { eventType: 'session_start' })
  );
  upsertSessionRollup({
    sessionId: id,
    ...(ptySession.repoPath ? { repoPath: ptySession.repoPath } : {}),
    ...(ptySession.repoName ? { repoName: ptySession.repoName } : {}),
    agentType: agent,
    startedAt: new Date().toISOString(),
  });
  if (initialPrompt) {
    const promptHandler = (changedId: string, state: AgentState) => {
      if (
        changedId === id &&
        state === 'waiting-for-input' &&
        ptySession.initialPrompt
      ) {
        const prompt = ptySession.initialPrompt;
        ptySession.initialPrompt = undefined; // one-shot
        // Small delay to ensure the agent's input handler is ready
        setTimeout(() => {
          try {
            ptySession.pty.write(prompt + '\n');
          } catch (err) {
            logger.error('Failed to inject initial prompt:', err);
          }
        }, 500);
        // Remove this handler after firing
        const idx = stateChangeCallbacks.indexOf(promptHandler);
        if (idx !== -1) stateChangeCallbacks.splice(idx, 1);
      }
    };
    stateChangeCallbacks.push(promptHandler);
  }
  const summary = withLocalIdentity({
    ...result,
    needsBranchRename: !!ptySession.needsBranchRename,
  });
  ptySession.sessionEnvelope = summary.sessionEnvelope;
  sessionEnvelopeRegistry.upsert(summary.sessionEnvelope);
  return summary;
}

function get(id: string): Session | undefined {
  return sessions.get(id);
}

function getReplaySnapshot(id: string): SessionReplaySnapshot | null {
  const session = sessions.get(id);
  if (!session || session.mode !== 'pty') return null;
  const payload = session.scrollback.join('');
  const bytesDropped = session.scrollbackBytesEvicted;
  return {
    sessionId: session.id,
    payload,
    bytesIncluded: payload.length,
    bytesDropped,
    capacityBytes: DEFAULT_SESSION_REPLAY_CAPACITY_BYTES,
    truncated: bytesDropped > 0,
    capturedAt: new Date().toISOString(),
  };
}

function renew(input: {
  id: string;
  expiresAt: string;
  now?: Date;
}): SessionRenewResult {
  const session = sessions.get(input.id);
  if (session) {
    const summary = list().find((candidate) => candidate.id === input.id);
    if (summary?.sessionEnvelope) {
      session.sessionEnvelope = summary.sessionEnvelope;
      sessionEnvelopeRegistry.upsert(summary.sessionEnvelope);
    }
  }
  const result = sessionEnvelopeRegistry.renew({
    sessionId: input.id,
    nodeId: DEFAULT_LOCAL_NODE_ID,
    expiresAt: input.expiresAt,
    ...(input.now ? { now: input.now } : {}),
  });
  if (result.ok === true && session) {
    session.sessionEnvelope = result.record.envelope;
  }
  return result;
}

function list(): SessionSummary[] {
  const summaries = Array.from(sessions.values())
    .map((s): SessionSummary => {
      const durability = emitDurabilityIfChanged(s);
      const summary = withLocalIdentity({
        id: s.id,
        type: s.type,
        agent: s.agent,
        mode: s.mode,
        ...(s.repoPath ? { repoPath: s.repoPath } : {}),
        ...(s.worktreePath !== undefined
          ? { worktreePath: s.worktreePath }
          : {}),
        cwd: s.cwd,
        ...(s.repoName ? { repoName: s.repoName } : {}),
        ...(s.branchName !== undefined ? { branchName: s.branchName } : {}),
        displayName: s.displayName,
        createdAt: s.createdAt,
        lastActivity: s.lastActivity,
        idle: s.idle,
        customCommand: s.customCommand,
        status: s.status,
        durability,
        needsBranchRename: !!s.needsBranchRename,
        agentState: s.agentState,
        currentActivity: s.currentActivity,
        ...normalizeControlStateSummary(s.controlState),
        ...(s.mode === 'pty'
          ? { useTmux: s.useTmux, tmuxSessionName: s.tmuxSessionName }
          : {}),
        ...(s.workspaceId ? { workspaceId: s.workspaceId } : {}),
        ...(s.additionalDirs?.length
          ? { additionalDirs: s.additionalDirs }
          : {}),
        ...(s.mode === 'pty' && s.dataQuality !== undefined
          ? { dataQuality: s.dataQuality }
          : {}),
        ...(s._lastEmittedPermissionType !== undefined
          ? { permissionType: s._lastEmittedPermissionType }
          : {}),
        ...(s.sessionEnvelope ? { sessionEnvelope: s.sessionEnvelope } : {}),
      });
      s.sessionEnvelope = summary.sessionEnvelope;
      sessionEnvelopeRegistry.upsert(summary.sessionEnvelope);
      return summary;
    })
    .sort((a, b) => b.lastActivity.localeCompare(a.lastActivity));
  return summaries;
}

function updateDisplayName(
  id: string,
  displayName: string
): { id: string; displayName: string } {
  const session = sessions.get(id);
  if (!session) throw new Error('Session not found: ' + id);
  session.displayName = displayName;
  return { id, displayName };
}

function kill(id: string): void {
  const session = sessions.get(id);
  if (!session) {
    throw new Error(`Session not found: ${id}`);
  }
  if (session.mode === 'pty') {
    try {
      session.pty.kill('SIGTERM');
    } catch {
      // PTY may already be dead (e.g. disconnected sessions) — still delete from registry
    }
    if (session.tmuxSessionName) {
      execFile(
        TMUX_COMMAND,
        ['kill-session', '-t', session.tmuxSessionName],
        () => {}
      );
    }
  } else {
    // Web session: disconnect adapter (tears down network connections and event handlers)
    session.adapterV2?.disconnect().catch(() => {
      // Adapter may already be disconnected — still proceed with cleanup
    });
    session.adapter.disconnect().catch(() => {
      // Adapter may already be disconnected — still proceed with cleanup
    });
  }
  const durationS = Math.round(
    (Date.now() - new Date(session.createdAt).getTime()) / 1000
  );
  trackEvent({
    category: 'session',
    action: 'ended',
    target: id,
    properties: {
      agent: session.agent,
      type: session.type,
      workspace: session.repoPath,
      duration_s: durationS,
    },
    session_id: id,
  });
  fireSessionEnd(id, session.cwd, session.branchName);

  // Clean up codex hooks adapter temp directory to avoid leaking temp files
  if (
    session.mode === 'pty' &&
    session.agent === 'codex' &&
    session.hooksActive
  ) {
    cleanupCodexHooksAdapter(id);
  }

  if (session.mode === 'web') {
    deleteWebSession(id);
  }

  sessions.delete(id);
  sessionEnvelopeRegistry.delete(id);
}

function detachForRestart(id: string): void {
  const session = sessions.get(id);
  if (!session) {
    throw new Error(`Session not found: ${id}`);
  }
  if (session.mode === 'pty') {
    session.preserveRuntimeFilesOnExit = true;
    if (session.tmuxSessionName) {
      try {
        execFileSync(
          TMUX_COMMAND,
          ['detach-client', '-s', session.tmuxSessionName],
          {
            stdio: 'ignore',
          }
        );
      } catch {
        // If no tmux client is attached, killing the PTY below is still safe.
      }
    }
    try {
      session.pty.kill('SIGTERM');
    } catch {
      // The tmux session is intentionally left alive for restore/reattach.
    }
  } else {
    session.adapterV2?.disconnect().catch(() => {
      // Adapter may already be disconnected during shutdown.
    });
    session.adapter.disconnect().catch(() => {
      // Adapter may already be disconnected during shutdown.
    });
  }
}

function killAllTmuxSessions(): void {
  for (const session of sessions.values()) {
    if (session.mode === 'pty' && session.tmuxSessionName) {
      execFile(
        TMUX_COMMAND,
        ['kill-session', '-t', session.tmuxSessionName],
        () => {}
      );
    }
  }
}

function resize(id: string, cols: number, rows: number): void {
  const session = sessions.get(id);
  if (!session) {
    throw new Error(`Session not found: ${id}`);
  }
  if (session.mode === 'pty') {
    session.pty.resize(cols, rows);
  } else {
    logger.warn(`resize() called on web session ${id} — no-op`);
  }
}

function write(id: string, data: string): void {
  const session = sessions.get(id);
  if (!session) {
    throw new Error(`Session not found: ${id}`);
  }
  if (session.mode === 'pty') {
    recordHumanPtyInput(session, data, controlEngineOptions());
    session.pty.write(data);
  } else {
    logger.warn(`write() called on web session ${id} — no-op`);
  }
}

function createRoutedPtyControlState(
  nodeId: string,
  sessionId: string
): ControlStateSummary {
  const activeWorker: ControlActor = {
    kind: 'agent',
    id: 'terminal',
    displayName: 'terminal',
    nodeId,
    sessionId,
  };
  return {
    controlMode: 'agent-driven',
    activeActors: [activeWorker],
    activeWorker,
    lastInterventionAt: null,
    lastInterventionBy: null,
    lastInterventionEventId: null,
    controlFreshness: 'fresh',
    controlReason: 'routed-session-created',
  };
}

function ensureRoutedPtyControlState(
  session: Session,
  nodeId: string,
  sessionId: string
): void {
  if (isControlStateSummary(session.controlState)) return;
  session.controlState = createRoutedPtyControlState(nodeId, sessionId);
}

function routedPtyControlSession(nodeId: string, sessionId: string): Session {
  const globalSessionId = createGlobalSessionId(nodeId, sessionId);
  const existing = routedPtyControlSessions.get(globalSessionId);
  if (existing) {
    ensureRoutedPtyControlState(existing, nodeId, sessionId);
    return existing;
  }

  const envelope = sessionEnvelopeRegistry.read(sessionId, nodeId);
  const now = new Date().toISOString();
  const session = {
    id: sessionId,
    nodeId,
    type: 'terminal',
    agent: 'terminal',
    mode: 'pty',
    pty: { write: () => {}, resize: () => {}, kill: () => {} },
    scrollback: [],
    useTmux: false,
    tmuxSessionName: `routed-${globalSessionId}`,
    onPtyReplacedCallbacks: [],
    restored: false,
    outputParser: 'codex',
    hookToken: '',
    hooksActive: false,
    cleanedUp: false,
    yolo: false,
    claudeArgs: [],
    continuePolicy: 'never',
    cwd: envelope?.scope.cwd ?? '/',
    repoPath: envelope?.scope.repoPath,
    worktreePath: envelope?.scope.worktreePath,
    displayName: `Remote ${nodeId}/${sessionId}`,
    createdAt: envelope?.issuedAt ?? now,
    lastActivity: now,
    idle: true,
    customCommand: null,
    status: 'active',
    needsBranchRename: false,
    agentState: 'idle',
    controlState: createRoutedPtyControlState(nodeId, sessionId),
  } as unknown as Session;
  routedPtyControlSessions.set(globalSessionId, session);
  return session;
}

function recordRoutedPtyInput(input: {
  nodeId: string;
  sessionId: string;
  data: string;
}): void {
  const session = routedPtyControlSession(input.nodeId, input.sessionId);
  session.lastActivity = new Date().toISOString();
  recordHumanPtyInput(session, input.data, controlEngineOptions());
}

function controlAction(
  id: string,
  action: ControlModeAction
): TabControlEvent[] {
  const session = sessions.get(id);
  if (!session) {
    throw new Error(`Session not found: ${id}`);
  }
  return applyControlModeAction(session, action, controlEngineOptions());
}

function acknowledgeInterventions(id: string, actor?: ControlActor): number {
  const session = sessions.get(id);
  if (!session) {
    throw new Error(`Session not found: ${id}`);
  }
  return acknowledgeHumanInput(session, actor, controlEngineOptions());
}

function interventionScopeForSession(session: Session) {
  const nodeId = session.nodeId ?? DEFAULT_LOCAL_NODE_ID;
  return {
    sessionId: session.id,
    nodeId,
    globalSessionId: createGlobalSessionId(nodeId, session.id),
  };
}

function handBackToAgent(input: {
  id: string;
  latestSeenInterventionEventId?: string;
  actor?: ControlActor;
}):
  | { ok: true; events: TabControlEvent[]; ackedHumanInterventions: number }
  | { ok: false; error: SessionControlError } {
  const session = sessions.get(input.id);
  const summary = session
    ? {
        id: session.id,
        status: session.status,
        ...normalizeControlStateSummary(session.controlState),
      }
    : undefined;
  const scope = session
    ? interventionScopeForSession(session)
    : { sessionId: input.id };
  const unackedHumanInterventions = listUnackedHumanInput(scope);
  const validation = validateAgentHandBackAck({
    session: summary,
    ...(input.latestSeenInterventionEventId === undefined
      ? {}
      : { latestSeenInterventionEventId: input.latestSeenInterventionEventId }),
    unackedHumanInterventions,
  });
  if (validation.ok === false) return { ok: false, error: validation.error };
  const ackedHumanInterventions = acknowledgeInterventions(
    input.id,
    input.actor
  );
  const events = controlAction(input.id, 'hand-back');
  return { ok: true, events, ackedHumanInterventions };
}

function maybeAutoRevert(id: string, nodeConnected?: boolean) {
  const session = sessions.get(id);
  if (!session) {
    throw new Error(`Session not found: ${id}`);
  }
  return maybeAutoRevertToAgentDriven({
    session,
    ...(nodeConnected !== undefined ? { nodeConnected } : {}),
    options: controlEngineOptions(),
  });
}

function getInterventions(
  id: string,
  options: { nodeId?: string; limit?: number } = {}
): InterventionRecord[] {
  return listInterventions({ sessionId: id, ...options });
}

function tmuxTargetForSession(id: string): string {
  const session = sessions.get(id);
  if (!session) {
    throw new Error(`Session not found: ${id}`);
  }
  if (session.mode !== 'pty' || !session.tmuxSessionName) {
    throw new Error(`Session ${id} does not have a tmux target`);
  }
  return session.tmuxSessionName;
}

async function sendTmuxKeys(id: string, keys: string[]): Promise<void> {
  const target = tmuxTargetForSession(id);
  await execFileAsync(TMUX_COMMAND, ['send-keys', '-t', target, ...keys]);
}

async function sendTmuxText(id: string, text: string): Promise<void> {
  const target = tmuxTargetForSession(id);
  await execFileAsync(TMUX_COMMAND, ['send-keys', '-t', target, '-l', text]);
}

async function captureTmuxPane(id: string): Promise<string> {
  const target = tmuxTargetForSession(id);
  const { stdout } = await execFileAsync(TMUX_COMMAND, [
    'capture-pane',
    '-p',
    '-t',
    target,
  ]);
  return stdout;
}

function nextTerminalName(): string {
  return `Terminal ${++terminalCounter}`;
}

function nextAgentName(): string {
  return `Agent ${++agentCounter}`;
}

function atomicWriteFileSync(filePath: string, data: string): void {
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmpPath, data, 'utf-8');
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try {
      fs.rmSync(tmpPath, { force: true });
    } catch {
      /* ignore */
    }
    throw err;
  }
}

function pendingSessionsPath(configDir: string): string {
  return path.join(configDir, 'pending-sessions.json');
}

function scrollbackDir(configDir: string): string {
  return path.join(configDir, 'scrollback');
}

function writePendingSessionsFile(
  configDir: string,
  pending: PendingSessionsFile
): void {
  fs.mkdirSync(configDir, { recursive: true });
  atomicWriteFileSync(
    pendingSessionsPath(configDir),
    JSON.stringify(pending, null, 2)
  );
}

function pruneScrollbackFiles(
  scrollbackDirPath: string,
  keepSessionIds: Set<string>
): number {
  let pruned = 0;
  let entries: string[];
  try {
    entries = fs.readdirSync(scrollbackDirPath);
  } catch (err) {
    if (
      err &&
      typeof err === 'object' &&
      'code' in err &&
      err.code === 'ENOENT'
    ) {
      return 0;
    }
    logger.warn(
      'failed to read scrollback dir for pruning %s: %s',
      scrollbackDirPath,
      err
    );
    return 0;
  }

  for (const entry of entries) {
    if (!entry.endsWith('.buf')) continue;
    const sessionId = entry.slice(0, -'.buf'.length);
    if (keepSessionIds.has(sessionId)) continue;
    try {
      fs.rmSync(path.join(scrollbackDirPath, entry), { force: true });
      pruned++;
    } catch (err) {
      logger.warn('failed to prune stale scrollback file %s: %s', entry, err);
    }
  }
  return pruned;
}

function removeScrollbackDir(configDir: string, reason: string): void {
  const dir = scrollbackDir(configDir);
  if (!fs.existsSync(dir)) return;
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    logger.info('removed scrollback dir after %s: %s', reason, dir);
  } catch (err) {
    logger.warn(
      'failed to remove scrollback dir after %s %s: %s',
      reason,
      dir,
      err
    );
  }
}

function preservedPendingRestoreFailures(
  configDir: string,
  serializedSessionIds: Set<string>
): PendingSessionsFile | null {
  const pendingPath = pendingSessionsPath(configDir);
  if (!fs.existsSync(pendingPath)) return null;

  const existing = readPendingSessionsFile(pendingPath);
  if (!existing) return null;

  const sessionsToPreserve = existing.sessions
    .filter((session) => !serializedSessionIds.has(session.id))
    .filter((session) => !isPendingSessionStale(existing, session))
    .map((session) => withPendingSince(existing, session));
  if (sessionsToPreserve.length === 0) return null;

  return {
    ...existing,
    sessions: sessionsToPreserve,
  };
}

function serializePtySession(
  session: PtySession,
  scrollbackDirPath: string
): SerializedPtySession {
  const scrollbackPath = path.join(scrollbackDirPath, session.id + '.buf');
  atomicWriteFileSync(scrollbackPath, session.scrollback.join(''));

  return {
    id: session.id,
    type: session.type,
    agent: session.agent,
    ...(session.repoPath ? { repoPath: session.repoPath } : {}),
    ...(session.worktreePath !== undefined
      ? { worktreePath: session.worktreePath }
      : {}),
    cwd: session.cwd,
    ...(session.repoName ? { repoName: session.repoName } : {}),
    ...(session.branchName !== undefined
      ? { branchName: session.branchName }
      : {}),
    displayName: session.displayName,
    createdAt: session.createdAt,
    lastActivity: session.lastActivity,
    useTmux: session.useTmux,
    tmuxSessionName: session.tmuxSessionName || '',
    customCommand: session.customCommand,
    yolo: session.yolo,
    claudeArgs: session.sessionArgs ?? session.claudeArgs,
    hookToken: session.hookToken,
    hooksActive: session.hooksActive,
    continuePolicy: session.continuePolicy,
    ...(session.needsBranchRename ? { needsBranchRename: true as const } : {}),
    ...(session.branchRenamePrompt
      ? { branchRenamePrompt: session.branchRenamePrompt }
      : {}),
    ...(session.workspaceId ? { workspaceId: session.workspaceId } : {}),
    ...(session.additionalDirs?.length
      ? { additionalDirs: session.additionalDirs }
      : {}),
    controlState: normalizeControlStateSummary(session.controlState),
  };
}

function serializeAll(configDir: string, options: SerializeOptions = {}): void {
  const scrollbackDirPath = scrollbackDir(configDir);
  fs.mkdirSync(scrollbackDirPath, { recursive: true });

  const serializedPty: SerializedPtySession[] = [];
  let webSessionCount = 0;

  for (const session of sessions.values()) {
    if (session.mode === 'pty') {
      serializedPty.push(serializePtySession(session, scrollbackDirPath));
    } else {
      webSessionCount++;
      // Web sessions persisted to relay-state.db on patch (debounced) +
      // structural events. Final shutdown snapshot for any not-yet-flushed
      // mutations is handled by upsertWebSessionNow before serializeAll.
      upsertWebSessionNow(session);
    }
  }

  const serializedAt = new Date().toISOString();
  const serializedSessionIds = new Set(serializedPty.map((s) => s.id));
  const preservedFailures = preservedPendingRestoreFailures(
    configDir,
    serializedSessionIds
  );
  const freshSerializedPty = serializedPty.map((session) => ({
    ...session,
    pendingSince: serializedAt,
  }));
  const sessionsToWrite = preservedFailures
    ? [...freshSerializedPty, ...preservedFailures.sessions]
    : freshSerializedPty;

  const reason = options.reason ?? 'unspecified';
  const pending: PendingSessionsFile = {
    version: Math.max(7, preservedFailures?.version ?? 7),
    timestamp: serializedAt,
    reason,
    sessions: sessionsToWrite,
  };

  writePendingSessionsFile(configDir, pending);
  const pruned = pruneScrollbackFiles(
    scrollbackDirPath,
    new Set(sessionsToWrite.map((s) => s.id))
  );

  logger.info(
    'serialized sessions for restart: reason=%s pty=%d preservedFailedPty=%d web=%d prunedScrollback=%d configDir=%s',
    reason,
    serializedPty.length,
    preservedFailures?.sessions.length ?? 0,
    webSessionCount,
    pruned,
    configDir
  );
}

interface RawV2Session extends Record<string, unknown> {
  cwd?: string;
  repoPath?: string;
  worktreePath?: string | null;
  type?: string;
  root?: string;
  worktreeName?: string;
}

function readPendingSessionsFile(
  pendingPath: string
): PendingSessionsFile | null {
  try {
    return JSON.parse(
      fs.readFileSync(pendingPath, 'utf-8')
    ) as PendingSessionsFile;
  } catch (err) {
    logger.warn(
      'failed to read pending sessions manifest %s: %s',
      pendingPath,
      err
    );
    removePendingSessionsFile(pendingPath);
    return null;
  }
}

function migrateV2ToV3(
  sessions: SerializedPtySession[],
  workspaces: string[]
): void {
  for (const s of sessions) {
    const raw = s as unknown as RawV2Session;
    // In v2 format, the field was called "repoPath" and stored the CWD
    const v2Cwd = raw['repoPath'] as string | undefined;
    if (!('cwd' in raw) && v2Cwd) {
      raw.cwd = v2Cwd;
    }
    if (!('repoPath' in raw) || v2Cwd === raw.repoPath) {
      const cwd = raw.cwd ?? v2Cwd ?? '';
      const matchedWorkspace = workspaces.find(
        (w) => cwd === w || cwd.startsWith(w + '/')
      );
      if (!matchedWorkspace) {
        logger.warn(
          `v2→v3 migration: no configured workspace matches cwd "${cwd}", using cwd as repoPath`
        );
      }
      raw.repoPath = matchedWorkspace ?? cwd;
    }
    if (!('worktreePath' in raw)) {
      const cwd = raw.cwd ?? '';
      const repoPath = raw.repoPath ?? '';
      // If cwd differs from repoPath, it's a worktree
      raw.worktreePath = cwd !== repoPath ? cwd : null;
    }
    // Map old types to new
    if (raw.type === 'repo' || raw.type === 'worktree') {
      raw.type = 'agent';
    }
    // Clean up legacy fields (repoPath is now kept as it's our real field)
    delete raw.root;
    delete raw.worktreeName;
  }
}

function migrateV3ToV4(sessions: SerializedPtySession[]): void {
  // v3 → v4 migration: workspacePath → repoPath
  // NOTE: This block also fires for v1/v2 files, but is a no-op for them because
  // the v2→v3 block above already sets `repoPath`, so the `!('repoPath' in s)`
  // guard is false. Correctness depends on sequential execution order.
  for (const s of sessions) {
    const legacy = s as SerializedPtySession & { workspacePath?: string };
    if ('workspacePath' in legacy && !('repoPath' in s)) {
      (legacy as unknown as RawV2Session).repoPath = legacy.workspacePath;
      delete legacy.workspacePath;
    }
  }
}

function loadScrollback(
  scrollbackDirPath: string,
  sessionId: string
): string[] | undefined {
  const scrollbackPath = path.join(scrollbackDirPath, sessionId + '.buf');
  try {
    const data = fs.readFileSync(scrollbackPath, 'utf-8');
    if (data.length > 0) return [data];
  } catch {
    // Missing scrollback is non-fatal
  }
  return undefined;
}

function buildAgentArgs(
  s: SerializedPtySession,
  frameworks?: Record<string, Partial<AgentFramework>>
): string[] {
  let continueArgsList: string[];
  let yoloArgsList: string[];
  try {
    const framework = resolveFramework(
      frameworks ? { frameworks } : {},
      s.agent
    );
    continueArgsList = framework.continueArgs;
    yoloArgsList = framework.yoloArgs;
  } catch {
    // Unknown framework — fall back to deprecated lookup tables
    continueArgsList = AGENT_CONTINUE_ARGS[s.agent] ?? [];
    yoloArgsList = AGENT_YOLO_ARGS[s.agent] ?? [];
  }
  return [
    ...continueArgsList,
    ...(s.claudeArgs ?? []),
    ...(s.yolo ? yoloArgsList : []),
  ];
}

type RestoredPtySpawnParams = {
  command: string | undefined;
  args: string[];
  tmuxSessionName: string;
  tmuxAttach: boolean;
};

function stableTmuxSessionName(s: SerializedPtySession): string {
  return (
    s.tmuxSessionName ||
    generateTmuxSessionName(s.displayName || s.repoName || 'session', s.id)
  );
}

async function resolveSessionSpawnParams(
  s: SerializedPtySession,
  frameworks?: Record<string, Partial<AgentFramework>>
): Promise<RestoredPtySpawnParams> {
  const tmuxSessionName = stableTmuxSessionName(s);

  if (tmuxSessionName) {
    let tmuxAlive = false;
    try {
      await execFileAsync(TMUX_COMMAND, ['has-session', '-t', tmuxSessionName]);
      tmuxAlive = true;
    } catch {
      // tmux session is gone
    }

    if (tmuxAlive) {
      // Upgrade hooks-settings.json to include statusLine if missing (migration for pre-telemetry sessions)
      if (s.hooksActive && defaultConfigDir) {
        const upgraded = upgradeHooksSettings(s.id, defaultConfigDir);
        if (upgraded) {
          logger.info(
            `Upgraded hooks settings for session ${s.id} (added statusLine relay)`
          );
        }
      }
      return {
        command: TMUX_COMMAND,
        args: ['-u', 'attach-session', '-t', tmuxSessionName],
        tmuxSessionName,
        tmuxAttach: true,
      };
    }
  }

  if (s.customCommand) {
    return {
      command: s.customCommand,
      args: [],
      tmuxSessionName,
      tmuxAttach: false,
    };
  }

  return {
    command: undefined,
    args: buildAgentArgs(s, frameworks),
    tmuxSessionName,
    tmuxAttach: false,
  };
}

function restoreSession(
  s: SerializedPtySession,
  spawn: RestoredPtySpawnParams,
  initialScrollback: string[] | undefined
): void {
  const createParams: CreateParams = {
    id: s.id,
    type: s.type,
    agent: s.agent,
    repoName: s.repoName,
    repoPath: s.repoPath,
    worktreePath: s.worktreePath,
    cwd: s.cwd,
    branchName: s.branchName,
    displayName: s.displayName,
    args: spawn.args,
    useTmux: true,
    tmuxSessionName: spawn.tmuxSessionName,
    tmuxAttach: spawn.tmuxAttach,
    sessionCustomCommand: s.customCommand,
    restored: true,
    yolo: s.yolo ?? false,
    claudeArgs: s.claudeArgs ?? [],
    hookToken: s.hookToken,
    hooksActive: s.hooksActive,
    continuePolicy: s.continuePolicy ?? 'never',
    ...(s.needsBranchRename ? { needsBranchRename: true as const } : {}),
    ...(s.branchRenamePrompt
      ? { branchRenamePrompt: s.branchRenamePrompt }
      : {}),
    ...(s.workspaceId ? { workspaceId: s.workspaceId } : {}),
    ...(s.additionalDirs?.length ? { additionalDirs: s.additionalDirs } : {}),
    controlState: normalizeControlStateSummary(s.controlState),
  };
  if (spawn.command) createParams.command = spawn.command;
  if (initialScrollback) createParams.initialScrollback = initialScrollback;
  create(createParams);
}

async function restoreWebSessionFromDb(
  row: import('./relay-state-db.js').LoadedWebSessionRow
): Promise<void> {
  // Restore persisted adapter runtime settings so the reconnected session
  // matches what was originally running rather than reverting to defaults.
  const persistedConfig = row.agentSessionV2.config;
  const restoredRepoPath =
    row.repoPath !== null && row.repoPath.length > 0 ? row.repoPath : undefined;
  const createParams: CreateWebParams = {
    id: row.id,
    agentType: row.meta.adapterType,
    cwd: row.cwd,
    ...(restoredRepoPath !== undefined
      ? {
          repoPath: restoredRepoPath,
          ...(row.meta.repoName ? { repoName: row.meta.repoName } : {}),
          worktreePath: row.worktreePath,
          branchName: row.branchName ?? '',
        }
      : {}),
    displayName: row.displayName ?? '',
    port: defaultPort ?? 3456,
    configDir: defaultConfigDir ?? '',
    runtimeOwnership: row.meta.runtimeOwnership,
    hookToken: row.meta.hookToken,
    ...(row.workspaceId !== null ? { workspaceId: row.workspaceId } : {}),
    ...(row.meta.additionalDirs !== undefined
      ? { additionalDirs: row.meta.additionalDirs }
      : {}),
    controlState: normalizeControlStateSummary(row.meta.controlState),
    ...(persistedConfig.model !== undefined
      ? { model: persistedConfig.model }
      : {}),
    ...(persistedConfig.permissionMode !== undefined
      ? { permissionMode: persistedConfig.permissionMode }
      : {}),
    ...(persistedConfig.providerOptions !== undefined
      ? { extra: persistedConfig.providerOptions }
      : {}),
  };

  // skipInitialPersist=true: createWebSession would otherwise overwrite the
  // persisted DB row with a freshly-initialized blank transcript before we
  // copy back agentSessionV2 below — a process death in that window would
  // lose the session.
  const { session } = await createWebSession(
    createParams,
    sessions,
    fireBackendStateIfChanged,
    { skipInitialPersist: true }
  );

  // Replace the freshly-created blank transcript with the persisted one.
  session.agentSessionV2 = row.agentSessionV2;
  session.customCommand = row.meta.customCommand;
  if (row.meta.needsBranchRename) {
    session.needsBranchRename = true;
  }

  // Restore top-level metadata from the row so sessions.list() ordering,
  // duration calculations, and backend-state display reflect the persisted
  // session rather than the freshly-created blank wrapper.
  session.createdAt = new Date(row.createdAt).toISOString();
  session.lastActivity = new Date(row.lastActivity).toISOString();
  session.status = row.status === 'archived' ? 'disconnected' : row.status;

  // Derive runtime state from the persisted live snapshot, mirroring the
  // mapping in web-session-handler's adapter listener.
  const live = session.agentSessionV2.live;
  session.currentTurnId = live.activeTurnId;
  if (live.status === 'working') {
    session.agentState = 'processing';
    session.idle = false;
  } else if (live.status === 'waiting') {
    session.agentState =
      live.waitingOn === 'approval' ? 'permission-prompt' : 'waiting-for-input';
    session.idle = false;
  } else if (live.status === 'error') {
    session.agentState = 'error';
    session.idle = true;
  } else {
    session.agentState = 'idle';
    session.idle = true;
  }
  fireBackendStateIfChanged(session);

  // Persist immediately so the freshly-restored row reflects current state
  // (vendor may not assign a new id, but live status flips).
  upsertWebSessionNow(session);

  // If the adapter supports resume and we have a stored vendor session ID,
  // reconnect via resumeSession so the provider continues the conversation.
  // On failure, surface a single client-source errorMessage into the timeline
  // and leave session disconnected — user must start a fresh session.
  try {
    await reconnectWebSession(session);
  } catch (err) {
    surfaceResumeFailure(session, err);
  }
}

function surfaceResumeFailure(session: WebSession, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  const timestamp = new Date().toISOString();

  // applyAgentPatchV2 only updates existing turns. After restore the active
  // turn is normally null, so we must aim the error at an existing turn (the
  // last one we have on the timeline) or synthesize a turn first when the
  // session has no turns yet. This mirrors the agent-error-v2 fallback.
  const targetTurnId = resolveResumeFailureTurnId(session, timestamp);

  const errorPatch: import('../shared/agent-chat-protocol-v2.js').AgentItemStartedPatchV2 =
    {
      type: 'agent-item-started-v2',
      sessionId: session.id,
      timestamp,
      turnId: targetTurnId,
      item: {
        type: 'errorMessage',
        id: `error-resume-${timestamp}`,
        message: `Resume failed: ${session.adapterType} session expired or rotated. Start a new session to continue. (${message})`,
        source: 'client',
        context: 'resume',
        status: 'completed',
        startedAt: timestamp,
        completedAt: timestamp,
      },
    };
  applyWebSessionPatchV2(session, errorPatch);

  const liveStatePatch: import('../shared/agent-chat-protocol-v2.js').AgentLiveStateUpdatedPatchV2 =
    {
      type: 'agent-live-state-updated-v2',
      sessionId: session.id,
      timestamp,
      live: {
        status: 'disconnected',
        activeTurnId: null,
        waitingOn: null,
        activeRequestIds: [],
        error: 'resume failed',
      },
    };
  applyWebSessionPatchV2(session, liveStatePatch);

  // Keep top-level session state in sync so sessions.list() and backend-state
  // listeners see the disconnected state immediately rather than the stale
  // pre-failure values until the next reload.
  session.status = 'disconnected';
  session.agentState = 'error';
  session.idle = true;
  session.currentTurnId = null;
  fireBackendStateIfChanged(session);

  upsertWebSessionNow(session);
}

function resolveResumeFailureTurnId(
  session: WebSession,
  timestamp: string
): string {
  const live = session.agentSessionV2.live.activeTurnId;
  if (typeof live === 'string' && live.length > 0) return live;

  const turns = session.agentSessionV2.turns;
  const lastTurn = turns[turns.length - 1];
  if (lastTurn) return lastTurn.id;

  const syntheticTurnId = `resume-failed-${timestamp}`;
  const turnPatch: import('../shared/agent-chat-protocol-v2.js').AgentTurnStartedPatchV2 =
    {
      type: 'agent-turn-started-v2',
      sessionId: session.id,
      timestamp,
      turn: {
        id: syntheticTurnId,
        status: 'failed',
        inputMessageId: '',
        items: [],
        startedAt: timestamp,
        completedAt: timestamp,
      },
    };
  applyWebSessionPatchV2(session, turnPatch);
  return syntheticTurnId;
}

function syncDisplayNameCounters(): void {
  for (const s of sessions.values()) {
    const agentMatch = s.displayName?.match(/^Agent (\d+)$/);
    if (agentMatch)
      agentCounter = Math.max(agentCounter, parseInt(agentMatch[1]!, 10));
    const termMatch = s.displayName?.match(/^Terminal (\d+)$/);
    if (termMatch)
      terminalCounter = Math.max(terminalCounter, parseInt(termMatch[1]!, 10));
  }
}

function assertRestorableCwd(s: SerializedPtySession): void {
  if (!s.cwd || !fs.existsSync(s.cwd)) {
    throw new Error(`restore cwd is unavailable: ${s.cwd || '<empty>'}`);
  }
}

function removePendingSessionsFile(pendingPath: string): void {
  try {
    fs.unlinkSync(pendingPath);
  } catch {
    /* ignore */
  }
}

function pendingSessionsAgeMs(pending: PendingSessionsFile): number | null {
  const timestampMs = Date.parse(pending.timestamp);
  if (!Number.isFinite(timestampMs)) return null;
  return Date.now() - timestampMs;
}

function pendingSessionAgeMs(
  pending: PendingSessionsFile,
  session: SerializedPtySession
): number | null {
  const timestampMs = Date.parse(session.pendingSince ?? pending.timestamp);
  if (!Number.isFinite(timestampMs)) return null;
  return Date.now() - timestampMs;
}

function isPendingSessionStale(
  pending: PendingSessionsFile,
  session: SerializedPtySession
): boolean {
  const ageMs = pendingSessionAgeMs(pending, session);
  return ageMs === null || ageMs > STALE_THRESHOLD_MS;
}

function withPendingSince(
  pending: PendingSessionsFile,
  session: SerializedPtySession
): SerializedPtySession {
  return {
    ...session,
    pendingSince: session.pendingSince ?? pending.timestamp,
  };
}

function migratePendingSessionsFile(
  pending: PendingSessionsFile,
  workspaces?: string[]
): void {
  if (pending.version <= 2) migrateV2ToV3(pending.sessions, workspaces ?? []);
  if (pending.version <= 3) migrateV3ToV4(pending.sessions);
}

async function tryRestorePtySession(
  s: SerializedPtySession,
  pendingVersion: number,
  scrollbackDirPath: string,
  frameworks?: Record<string, Partial<AgentFramework>>
): Promise<boolean> {
  const initialScrollback = loadScrollback(scrollbackDirPath, s.id);
  try {
    if (pendingVersion >= 6) assertRestorableCwd(s);
    const spawn = await resolveSessionSpawnParams(s, frameworks);
    restoreSession(s, spawn, initialScrollback);
    return true;
  } catch (err) {
    logger.error(`Failed to restore session ${s.id} (${s.displayName})`, err);
    return false;
  }
}

function preserveFailedPendingSessions(
  configDir: string,
  pending: PendingSessionsFile,
  failedSessions: SerializedPtySession[]
): void {
  // Keep the original timestamp so repeatedly-failed restore records still age
  // out under STALE_THRESHOLD_MS instead of being made fresh on every dev
  // restart. Rapid restart loops retry within the window; genuinely stale
  // failures are cleaned with their scrollback on a later startup.
  const retrySessions = failedSessions.map((session) =>
    withPendingSince(pending, session)
  );
  writePendingSessionsFile(configDir, {
    ...pending,
    sessions: retrySessions,
  });
  pruneScrollbackFiles(
    scrollbackDir(configDir),
    new Set(retrySessions.map((s) => s.id))
  );
}

async function restoreFreshPendingSessions(
  configDir: string,
  pending: PendingSessionsFile,
  workspaces?: string[],
  frameworks?: Record<string, Partial<AgentFramework>>
): Promise<number> {
  migratePendingSessionsFile(pending, workspaces);
  const failedSessions: SerializedPtySession[] = [];
  const scrollbackDirPath = scrollbackDir(configDir);
  let restored = 0;

  for (const s of pending.sessions) {
    const ok = await tryRestorePtySession(
      s,
      pending.version,
      scrollbackDirPath,
      frameworks
    );
    if (ok) restored++;
    else failedSessions.push(s);
  }

  if (failedSessions.length > 0) {
    preserveFailedPendingSessions(configDir, pending, failedSessions);
  } else {
    removePendingSessionsFile(pendingSessionsPath(configDir));
    removeScrollbackDir(configDir, 'successful pending restore');
  }

  return restored;
}

async function restorePendingSessionsFromDisk(
  configDir: string,
  workspaces?: string[],
  frameworks?: Record<string, Partial<AgentFramework>>
): Promise<number> {
  const pendingPath = pendingSessionsPath(configDir);
  if (!fs.existsSync(pendingPath)) {
    removeScrollbackDir(configDir, 'missing pending manifest');
    return 0;
  }

  const pending = readPendingSessionsFile(pendingPath);
  if (!pending) {
    removeScrollbackDir(configDir, 'unreadable pending manifest');
    return 0;
  }

  const ageMs = pendingSessionsAgeMs(pending);
  logger.info(
    'found pending sessions manifest: reason=%s version=%d pty=%d ageMs=%s configDir=%s',
    pending.reason ?? 'unspecified',
    pending.version,
    pending.sessions.length,
    ageMs === null ? 'invalid' : String(ageMs),
    configDir
  );

  const freshSessions = pending.sessions
    .filter((session) => !isPendingSessionStale(pending, session))
    .map((session) => withPendingSince(pending, session));
  const staleSessionCount = pending.sessions.length - freshSessions.length;
  if (freshSessions.length === 0) {
    logger.warn(
      'discarding stale pending sessions manifest: reason=%s version=%d pty=%d ageMs=%s configDir=%s',
      pending.reason ?? 'unspecified',
      pending.version,
      pending.sessions.length,
      ageMs === null ? 'invalid' : String(ageMs),
      configDir
    );
    removePendingSessionsFile(pendingPath);
    removeScrollbackDir(configDir, 'stale pending manifest');
    return 0;
  }
  if (staleSessionCount > 0) {
    logger.warn(
      'dropping stale pending session records: reason=%s version=%d stalePty=%d freshPty=%d ageMs=%s configDir=%s',
      pending.reason ?? 'unspecified',
      pending.version,
      staleSessionCount,
      freshSessions.length,
      ageMs === null ? 'invalid' : String(ageMs),
      configDir
    );
  }

  return restoreFreshPendingSessions(
    configDir,
    { ...pending, sessions: freshSessions },
    workspaces,
    frameworks
  );
}

async function restoreWebSessionsFromDb(): Promise<number> {
  let restored = 0;
  // Web sessions live in relay-state.db. No staleness wipe — DB rows persist
  // until user archives or closes the session.
  for (const row of loadAllWebSessions()) {
    try {
      await restoreWebSessionFromDb(row);
      restored++;
    } catch (err) {
      logger.error(
        `Failed to restore web session ${row.id} (${row.displayName ?? '<unnamed>'})`,
        err
      );
    }
  }
  return restored;
}

async function restoreFromDisk(
  configDir: string,
  workspaces?: string[],
  frameworks?: Record<string, Partial<AgentFramework>>
): Promise<number> {
  const restoredPty = await restorePendingSessionsFromDisk(
    configDir,
    workspaces,
    frameworks
  );
  const restoredWeb = await restoreWebSessionsFromDb();
  syncDisplayNameCounters();
  return restoredPty + restoredWeb;
}

/** Returns the set of tmux session names currently owned by restored sessions */
function activeTmuxSessionNames(): Set<string> {
  const names = new Set<string>();
  for (const session of sessions.values()) {
    if (session.mode === 'pty' && session.tmuxSessionName)
      names.add(session.tmuxSessionName);
  }
  return names;
}

async function fetchMetaForSession(
  session: SessionSummary
): Promise<SessionMeta> {
  const repoPath = session.cwd;
  const branch = session.branchName;

  let prNumber: number | null = null;
  let additions = 0;
  let deletions = 0;

  if (branch) {
    try {
      const pr = await getPrForBranch(repoPath, branch);
      if (pr && !isStalePr(pr)) {
        prNumber = pr.number;
        additions = pr.additions;
        deletions = pr.deletions;
      }
    } catch {
      /* gh CLI unavailable */
    }
  }

  // Fallback to working tree diff if no PR data
  if (additions === 0 && deletions === 0) {
    const diff = await getWorkingTreeDiff(repoPath);
    additions = diff.additions;
    deletions = diff.deletions;
  }

  return {
    prNumber,
    additions,
    deletions,
    fetchedAt: new Date().toISOString(),
  };
}

async function getSessionMeta(
  id: string,
  refresh = false
): Promise<SessionMeta | null> {
  if (!refresh && metaCache.has(id)) return metaCache.get(id)!;

  const session = sessions.get(id);
  if (!session) return metaCache.get(id) ?? null;

  const summary = list().find((s) => s.id === id);
  if (!summary) return null;

  const meta = await fetchMetaForSession(summary);
  metaCache.set(id, meta);
  return meta;
}

function getAllSessionMeta(): Record<string, SessionMeta> {
  const result: Record<string, SessionMeta> = {};
  for (const [key, meta] of metaCache) {
    result[key] = meta;
  }
  return result;
}

// Populate cache for all active sessions (called on startup or refresh)
async function populateMetaCache(): Promise<void> {
  const allSessions = list();
  await Promise.allSettled(
    allSessions.map(async (s) => {
      if (!metaCache.has(s.id)) {
        const meta = await fetchMetaForSession(s);
        metaCache.set(s.id, meta);
      }
    })
  );
}

async function createWeb(
  params: CreateWebParams
): Promise<{ session: WebSession }> {
  const result = await createWebSession(
    params,
    sessions,
    fireBackendStateIfChanged
  );
  if (result.session.sessionEnvelope) {
    sessionEnvelopeRegistry.upsert(result.session.sessionEnvelope);
  }
  trackEvent({
    category: 'session',
    action: 'created',
    target: result.session.id,
    properties: {
      agent: params.agentType,
      type: 'agent',
      workspace: params.repoPath,
      mode: 'web',
      ...(params.sessionLane ? { sessionLane: params.sessionLane } : {}),
    },
    session_id: result.session.id,
  });
  return result;
}

/**
 * Initiate a "continue here" recovery for a web session whose resume failed.
 *
 * Disconnects the existing adapter, clears the stale vendor session ID, and
 * starts a fresh provider session (no resume). Uses the module-level defaults
 * for port and configDir so callers (e.g. ws.ts) do not need to carry them.
 *
 * Throws if the session is not found or is not a web session.
 */
async function continueHereWeb(sessionId: string): Promise<void> {
  const session = sessions.get(sessionId);
  if (!session || session.mode !== 'web') {
    throw new Error(
      `continue-here: session ${sessionId} not found or not a web session`
    );
  }

  // Issue 6 fix: guard against spurious Continue Here on an active session.
  // Only allow the recovery flow when the session is in a disconnected/failed
  // state. An active or waiting session should not have its adapter torn down
  // by a stale or unexpected client command.
  const liveStatus = session.agentSessionV2.live.status;
  const isDisconnected =
    liveStatus === 'disconnected' ||
    session.adapterV2.status === 'disconnected';
  if (!isDisconnected) {
    logger.warn(
      'continue-here: ignoring request for non-disconnected session',
      {
        id: session.id,
        liveStatus,
        adapterStatus: session.adapterV2.status,
      }
    );
    return;
  }

  const config = {
    cwd: session.cwd,
    port: defaultPort ?? 3456,
    sessionId: session.id,
    hookToken: session.hookToken,
    configDir: defaultConfigDir ?? '',
    ...(session.agentSessionV2.config.permissionMode !== undefined
      ? { permissionMode: session.agentSessionV2.config.permissionMode }
      : {}),
    ...(session.agentSessionV2.config.model !== undefined
      ? { model: session.agentSessionV2.config.model }
      : {}),
    ...(session.agentSessionV2.config.providerOptions !== undefined
      ? { extra: session.agentSessionV2.config.providerOptions }
      : {}),
  };

  await continueHereWebSession(session, config, fireBackendStateIfChanged);
}

export {
  configure,
  create,
  renew,
  createWeb,
  get,
  list,
  kill,
  detachForRestart,
  killAllTmuxSessions,
  resize,
  sendTmuxKeys,
  sendTmuxText,
  captureTmuxPane,
  updateDisplayName,
  write,
  recordRoutedPtyInput,
  controlAction,
  acknowledgeInterventions,
  handBackToAgent,
  maybeAutoRevert,
  getInterventions,
  onControlEvent,
  onStateChange,
  onSessionCreate,
  onSessionEnd,
  onSessionDurabilityChanged,
  setSessionNodeStatusResolver,
  refreshDurability,
  getReplaySnapshot,
  nextTerminalName,
  nextAgentName,
  serializeAll,
  restoreFromDisk,
  activeTmuxSessionNames,
  getSessionMeta,
  getAllSessionMeta,
  populateMetaCache,
  // onGlobalScrollbackTrim intentionally omitted: no WS consumer wired yet.
  // Add back when the broadcast integration lands.
  enforceGlobalScrollbackCap,
  continueHereWeb,
};
export type { CreateWebParams };
