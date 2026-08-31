import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type {
  TerminalActivityState,
  BackendDisplayState,
  PtySession,
  Session,
  SessionSummary,
  SessionMeta,
  TerminalBackend,
  SessionType,
} from './types.js';
export type { BackendDisplayState };
import { createPtySession } from './pty-handler.js';
import type { CreatePtyParams } from './pty-handler.js';
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
  dropTerminalStreamPrefixBytes,
  type SessionReplaySnapshot,
} from '../shared/session-replay.js';
import {
  isControlStateSummary,
  normalizeControlStateSummary,
  type ControlStateSummary,
  type ControlActor,
  type ControlMode,
  type TabControlEvent,
  type InterventionRecord,
} from '../shared/control-state.js';
import {
  LOCAL_COMPATIBILITY_SESSION_INTENT,
  normalizeSessionEnvelope,
} from '../shared/session-envelope.js';
import {
  scheduleRelayProcessTreeReap,
  summarizeProcessReap,
} from './process-tree.js';
import {
  sessionEnvelopeRegistry,
  type SessionRenewResult,
} from './session-envelope-registry.js';
import {
  recordHumanPtyInput,
  recordSupervisorAction,
  type SupervisorInterventionAction,
} from './control-engine.js';
import { listInterventions } from './intervention-log.js';
import {
  securityAuditEntryForTabControlEvent,
  type SecurityAuditEntryInput,
} from '../shared/security-audit.js';
import {
  encodeTerminalInput,
  isTerminalInputKey,
  type TerminalInputKey,
} from './terminal-model-backend.js';
import { cleanupSessionImageTempDir } from './session-image-ingress.js';

const logger = createLogger('sessions');

/** Let pending HTTP, socket, and I/O callbacks run between cold-resume units. */
function yieldToEventLoop(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

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
      dropTerminalStreamPrefixBytes(session.terminalStream, chunk.length);
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
  spawnedBySessionId?: string;
  type: SessionType;
  repoPath?: string;
  worktreePath?: string | null;
  cwd: string;
  repoName?: string;
  branchName?: string;
  displayName: string;
  createdAt: string;
  lastActivity: string;
  terminalBackend?: TerminalBackend;
  customCommand: string | null;
  needsBranchRename?: boolean;
  branchRenamePrompt?: string;
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
const UNSUPPORTED_TMUX_SESSIONS_FILE = 'unsupported-tmux-sessions.json';

export type CreateParams = Omit<CreatePtyParams, 'id' | 'callbacks'> & {
  id?: string;
  spawnedBySessionId?: string;
  needsBranchRename?: boolean;
  branchRenamePrompt?: string;
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
let defaultConfigDir: string | undefined;
let defaultInterventionDebounceMs: number | undefined;
let defaultCoDrivenAutoRevertMs: number | undefined;
let defaultSecurityAuditSink:
  | { append(input: SecurityAuditEntryInput): unknown }
  | undefined;
let defaultMaxScrollbackPerSessionBytes: number | undefined;

function configure(opts: {
  port?: number;
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

type StateChangeCallback = (
  sessionId: string,
  state: TerminalActivityState
) => void;
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

export function fireStateChange(
  sessionId: string,
  state: TerminalActivityState
): void {
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
    activityState: session.activityState,
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
  activityState: TerminalActivityState;
  idle: boolean;
}): BackendDisplayState {
  if (session.activityState === 'permission-prompt') return 'permission';
  if (session.activityState === 'error') return 'error';
  if (session.activityState === 'processing') return 'running';
  if (session.activityState === 'initializing') return 'initializing';
  if (
    session.activityState === 'idle' ||
    session.activityState === 'waiting-for-input'
  )
    return 'idle';
  // Fall back to the PTY idle timer for activity states added by newer nodes.
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
      session.permissionType ??
      (session.currentActivity?.tool === 'AskUserQuestion'
        ? 'question'
        : 'approval');
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
  // mutates `status` + `activityState` directly). Re-derive here so consumers
  // see the transition over the event stream immediately.
  emitDurabilityIfChanged(session);
}

function create({
  id: providedId,
  spawnedBySessionId,
  needsBranchRename,
  branchRenamePrompt,
  workspaceId,
  additionalDirs,
  cols = 80,
  rows = 24,
  args = [],
  port,
  ...rest
}: CreateParams): CreateResult {
  if (rest.type !== undefined && rest.type !== 'terminal') {
    throw new Error(
      'Agent conversations run in channels; public sessions only support terminals.'
    );
  }
  if (!rest.command) {
    throw new Error(
      'Public terminal sessions require an explicit shell or command.'
    );
  }
  const id = providedId || crypto.randomBytes(8).toString('hex');

  const ptyParams: CreatePtyParams = {
    ...rest,
    id,
    type: 'terminal',
    cols,
    rows,
    args,
    port: port ?? defaultPort,
    configDir: rest.configDir ?? defaultConfigDir,
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
      agent: 'terminal',
      type: 'terminal',
      workspace: rest.repoPath,
      mode: 'terminal',
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
  if (workspaceId) {
    ptySession.workspaceId = workspaceId;
  }
  if (additionalDirs?.length) {
    ptySession.additionalDirs = additionalDirs;
  }
  if (spawnedBySessionId !== undefined) {
    ptySession.spawnedBySessionId = spawnedBySessionId;
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
    agentType: 'terminal',
    startedAt: new Date().toISOString(),
  });
  const summary = withLocalIdentity({
    ...result,
    ...(spawnedBySessionId !== undefined ? { spawnedBySessionId } : {}),
    needsBranchRename: !!ptySession.needsBranchRename,
  });
  ptySession.sessionEnvelope = summary.sessionEnvelope;
  sessionEnvelopeRegistry.upsert(summary.sessionEnvelope);
  return summary;
}

function get(id: string): Session | undefined {
  return sessions.get(id);
}

function sessionScrollbackCapacityMetadata(session: PtySession): {
  bytesDropped: number;
  capacityBytes: number;
} {
  return {
    bytesDropped: session.scrollbackBytesEvicted ?? 0,
    // Prefer the per-session effective cap so snapshots report the actual
    // eviction threshold; fall back only when a legacy/test record predates
    // the counter.
    capacityBytes:
      session.scrollbackCapacityBytes || DEFAULT_SESSION_REPLAY_CAPACITY_BYTES,
  };
}

function getReplaySnapshot(id: string): SessionReplaySnapshot | null {
  const session = sessions.get(id);
  if (!session || session.mode !== 'pty') return null;
  const payload = session.scrollback.join('');
  const { bytesDropped, capacityBytes } =
    sessionScrollbackCapacityMetadata(session);
  return {
    sessionId: session.id,
    payload,
    bytesIncluded: payload.length,
    bytesDropped,
    capacityBytes,
    truncated: bytesDropped > 0,
    capturedAt: new Date().toISOString(),
  };
}

const MAX_RENDERED_SCREEN_SCROLLBACK_LINES = 1000;
const DEFAULT_RENDERED_SCREEN_SCROLLBACK_LINES = 200;

export interface RenderedScreenSnapshotOptions {
  requestedId?: string;
  includeScrollback?: boolean;
  maxScrollbackLines?: number;
}

export interface RenderedScreenSnapshotError {
  code: 'NOT_FOUND' | 'UNSUPPORTED' | 'SESSION_CONFLICT' | 'UPSTREAM_ERROR';
  reasonCode: string;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
}

export type RenderedScreenSnapshotResult =
  | { ok: true; snapshot: Record<string, unknown> }
  | { ok: false; error: RenderedScreenSnapshotError };

function renderedScreenError(
  error: RenderedScreenSnapshotError
): RenderedScreenSnapshotResult {
  return { ok: false, error };
}

function boundedScrollbackLines(
  rows: unknown[],
  requested: boolean,
  maxLines: number
): {
  rows: unknown[];
  availableRows: number;
  includedRows: number;
  truncated: boolean;
  omittedRows: number;
} {
  if (!requested) {
    return {
      rows: [],
      availableRows: 0,
      includedRows: 0,
      truncated: false,
      omittedRows: 0,
    };
  }
  const availableRows = rows.length;
  const omittedRows = Math.max(0, availableRows - maxLines);
  const included = omittedRows > 0 ? rows.slice(omittedRows) : rows;
  return {
    rows: included,
    availableRows,
    includedRows: included.length,
    truncated: omittedRows > 0,
    omittedRows,
  };
}

function getRenderedScreenSnapshot(
  id: string,
  options: RenderedScreenSnapshotOptions = {}
): RenderedScreenSnapshotResult {
  const session = sessions.get(id);
  if (!session) {
    return renderedScreenError({
      code: 'NOT_FOUND',
      reasonCode: 'SESSION_NOT_FOUND',
      message: 'session was not found',
      retryable: false,
      details: { sessionId: id },
    });
  }
  if (session.mode !== 'pty') {
    return renderedScreenError({
      code: 'UNSUPPORTED',
      reasonCode: 'SESSION_SCREEN_UNSUPPORTED_MODE',
      message: 'rendered screen snapshots are only supported for PTY sessions',
      retryable: false,
      details: { sessionId: id, mode: session.mode },
    });
  }
  if (session.status !== 'active' || session.cleanedUp) {
    return renderedScreenError({
      code: 'SESSION_CONFLICT',
      reasonCode: 'SESSION_SCREEN_STALE',
      message:
        'rendered screen model is unavailable for a disconnected session',
      retryable: false,
      details: { sessionId: id, status: session.status },
    });
  }
  if (session.terminalBackend !== 'relay-pty') {
    return renderedScreenError({
      code: 'UNSUPPORTED',
      reasonCode: 'SESSION_SCREEN_UNSUPPORTED_BACKEND',
      message:
        'rendered screen snapshots require the relay-pty terminal backend; tmux scraping is intentionally unsupported',
      retryable: false,
      details: { sessionId: id, terminalBackend: session.terminalBackend },
    });
  }
  if (!session.terminalModel) {
    return renderedScreenError({
      code: 'UNSUPPORTED',
      reasonCode: 'SESSION_SCREEN_MODEL_UNAVAILABLE',
      message: 'relay-pty session does not have a terminal model attached',
      retryable: false,
      details: { sessionId: id, terminalBackend: session.terminalBackend },
    });
  }

  const includeScrollback = options.includeScrollback === true;
  const maxLines = Math.min(
    MAX_RENDERED_SCREEN_SCROLLBACK_LINES,
    Math.max(
      1,
      Math.floor(
        options.maxScrollbackLines ?? DEFAULT_RENDERED_SCREEN_SCROLLBACK_LINES
      )
    )
  );
  const nodeId = DEFAULT_LOCAL_NODE_ID;
  const globalSessionId = createGlobalSessionId(nodeId, session.id);

  try {
    const terminal = session.terminalModel.snapshot({
      includeScrollback,
      includeCells: false,
    });
    const scrollback = boundedScrollbackLines(
      (terminal.scrollbackLines ?? []) as unknown[],
      includeScrollback,
      maxLines
    );
    const { bytesDropped, capacityBytes } =
      sessionScrollbackCapacityMetadata(session);
    return {
      ok: true,
      snapshot: {
        session: {
          id: session.id,
          requestedId: options.requestedId ?? id,
          nodeId,
          globalSessionId,
          type: session.type,
          mode: session.mode,
          status: session.status,
          displayName: session.displayName,
        },
        backend: {
          terminalBackend: session.terminalBackend,
          modelBackend: terminal.backend,
          runtime: 'relay-pty/libghostty-vt',
          backendInfo: terminal.backendInfo,
        },
        geometry: { rows: terminal.rows, cols: terminal.cols },
        capturedAt: terminal.generatedAt,
        freshness: {
          state: 'fresh',
          lastActivityAt: session.lastActivity,
          modelGeneratedAt: terminal.generatedAt,
        },
        visible: {
          text: terminal.visibleText,
          rows: terminal.visibleLines,
        },
        cursor: terminal.cursor,
        title: terminal.title,
        modes: terminal.modes,
        scrollback: {
          requested: includeScrollback,
          included: includeScrollback,
          rows: scrollback.rows,
          availableRows: scrollback.availableRows,
          includedRows: scrollback.includedRows,
          ...(includeScrollback ? { maxLines } : {}),
          truncated: scrollback.truncated,
          omittedRows: scrollback.omittedRows,
          bytesDropped,
          capacityBytes,
        },
        unsupported: terminal.unsupported,
      },
    };
  } catch (error) {
    return renderedScreenError({
      code: 'UPSTREAM_ERROR',
      reasonCode: 'SESSION_SCREEN_MODEL_UNAVAILABLE',
      message:
        error instanceof Error
          ? error.message
          : 'terminal model snapshot failed unexpectedly',
      retryable: true,
      details: { sessionId: id },
    });
  }
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
        ...(s.spawnedBySessionId !== undefined
          ? { spawnedBySessionId: s.spawnedBySessionId }
          : {}),
        type: s.type,
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
        ...(s.restoreState !== undefined
          ? { restoreState: s.restoreState }
          : {}),
        durability,
        needsBranchRename: !!s.needsBranchRename,
        activityState: s.activityState,
        currentActivity: s.currentActivity,
        ...normalizeControlStateSummary(s.controlState),
        terminalBackend: s.terminalBackend,
        ...(s.workspaceId ? { workspaceId: s.workspaceId } : {}),
        ...(s.additionalDirs?.length
          ? { additionalDirs: s.additionalDirs }
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

async function sessionRuntimeRootPids(session: PtySession): Promise<number[]> {
  const pids = new Set<number>();
  const ptyPid = session.pty.pid;
  if (Number.isSafeInteger(ptyPid) && ptyPid > 1) pids.add(ptyPid);
  return Array.from(pids);
}

async function scheduleSessionRuntimeReap(
  session: PtySession,
  reason: string
): Promise<void> {
  const rootPids = await sessionRuntimeRootPids(session);
  if (rootPids.length === 0) return;

  const preview = summarizeProcessReap(rootPids);
  if (preview.languageServers.length > 0) {
    logger.warn(
      'reaping %d language-server descendants for session %s (%s)',
      preview.languageServers.length,
      session.id,
      reason
    );
  }
  scheduleRelayProcessTreeReap({
    rootPids,
    reason: `${reason}:${session.id}`,
    logger,
  });
}

async function terminatePtySession(
  session: PtySession,
  reason: string
): Promise<void> {
  try {
    await scheduleSessionRuntimeReap(session, reason);
  } finally {
    try {
      session.pty.kill('SIGTERM');
    } catch {
      // PTY may already be dead (e.g. disconnected sessions) — still delete from registry
    }
  }
}

function kill(id: string): void {
  const session = sessions.get(id);
  if (!session) {
    throw new Error(`Session not found: ${id}`);
  }
  void terminatePtySession(session, 'explicit-session-kill');
  const durationS = Math.round(
    (Date.now() - new Date(session.createdAt).getTime()) / 1000
  );
  trackEvent({
    category: 'session',
    action: 'ended',
    target: id,
    properties: {
      type: session.type,
      workspace: session.repoPath,
      duration_s: durationS,
    },
    session_id: id,
  });
  fireSessionEnd(id, session.cwd, session.branchName);

  cleanupSessionImageTempDir(id);
  sessions.delete(id);
  sessionEnvelopeRegistry.delete(id);
}

function detachForRestart(id: string): void {
  const session = sessions.get(id);
  if (!session) {
    throw new Error(`Session not found: ${id}`);
  }
  session.preserveRuntimeFilesOnExit = true;
  try {
    session.pty.kill('SIGTERM');
  } catch {
    // PTY may already have exited during shutdown.
  }
}

function resize(id: string, cols: number, rows: number): void {
  const session = sessions.get(id);
  if (!session) {
    throw new Error(`Session not found: ${id}`);
  }
  session.pty.resize(cols, rows);
  session.terminalModel?.resize(cols, rows);
}

function write(id: string, data: string): void {
  const session = sessions.get(id);
  if (!session) {
    throw new Error(`Session not found: ${id}`);
  }
  recordHumanPtyInput(session, data, controlEngineOptions());
  session.pty.write(data);
}

// Delay between a submit body and its deferred CR. TUI input loops coalesce
// bytes that arrive in one read into a paste, so the CR must land as its own
// key event for the submit to actually fire.
const SUPERVISOR_DEFERRED_TAIL_DELAY_MS = 50;

function supervisorWrite(
  id: string,
  input: {
    action: SupervisorInterventionAction;
    actor: ControlActor;
    payload: string;
    deferredTail?: string;
  }
): { eventId: string; modeBefore?: ControlMode; modeAfter?: ControlMode } {
  const session = sessions.get(id);
  if (!session) {
    throw new Error(`Session not found: ${id}`);
  }
  if (session.mode !== 'pty') {
    throw new Error(`Session ${id} is not a PTY session`);
  }
  try {
    session.pty.write(input.payload);
  } catch (error) {
    logger.warn(
      `supervisorWrite() failed to write to PTY session ${id}: ${String(error)}`
    );
    throw error;
  }
  const deferredTail = input.deferredTail;
  if (deferredTail !== undefined && deferredTail.length > 0) {
    const timer = setTimeout(() => {
      try {
        const liveSession = sessions.get(id);
        if (liveSession?.mode === 'pty') liveSession.pty.write(deferredTail);
      } catch (error) {
        logger.warn(
          `supervisorWrite() failed deferred tail write to PTY session ${id}: ${String(error)}`
        );
      }
    }, SUPERVISOR_DEFERRED_TAIL_DELAY_MS);
    timer.unref?.();
  }
  const auditInput = {
    action: input.action,
    actor: input.actor,
    payload: input.payload + (deferredTail ?? ''),
  };
  const event = recordSupervisorAction(
    session,
    auditInput,
    controlEngineOptions()
  );
  if (event.type !== 'tab.intervention') {
    throw new Error(
      `Supervisor action did not produce an intervention event for ${id}`
    );
  }
  session.lastActivity = new Date().toISOString();
  return {
    eventId: event.eventId,
    modeBefore: event.intervention.modeBefore,
    ...(event.intervention.modeAfter === undefined
      ? {}
      : { modeAfter: event.intervention.modeAfter }),
  };
}

function createRoutedPtyControlState(
  nodeId: string,
  sessionId: string
): ControlStateSummary {
  const activeHuman: ControlActor = {
    kind: 'human',
    id: 'browser-user',
    displayName: 'Browser user',
    nodeId,
    sessionId,
  };
  return {
    controlMode: 'human-driven',
    activeActors: [activeHuman],
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
    mode: 'pty',
    pty: { write: () => {}, resize: () => {}, kill: () => {} },
    scrollback: [],
    terminalBackend: 'relay-pty',
    onPtyReplacedCallbacks: [],
    restored: false,
    cleanedUp: false,
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
    activityState: 'idle',
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

function releaseRoutedPtyControlSession(
  nodeId: string,
  sessionId: string
): boolean {
  return routedPtyControlSessions.delete(
    createGlobalSessionId(nodeId, sessionId)
  );
}

function releaseRoutedPtyControlSessionsForNode(nodeId: string): number {
  let released = 0;
  for (const [globalSessionId, session] of routedPtyControlSessions) {
    if (session.nodeId !== nodeId) continue;
    routedPtyControlSessions.delete(globalSessionId);
    released++;
  }
  return released;
}

function getInterventions(
  id: string,
  options: { nodeId?: string; limit?: number } = {}
): InterventionRecord[] {
  return listInterventions({ sessionId: id, ...options });
}

function ptySessionForTerminalControl(id: string): PtySession {
  const session = sessions.get(id);
  if (!session) {
    throw new Error(`Session not found: ${id}`);
  }
  if (session.mode !== 'pty') {
    throw new Error(`Session ${id} is not a PTY session`);
  }
  return session;
}

function toTerminalInputKey(key: string): TerminalInputKey {
  if (isTerminalInputKey(key)) {
    return key;
  }
  throw new Error(`Unsupported relay-pty input key: ${key}`);
}

async function sendTerminalKeys(id: string, keys: string[]): Promise<void> {
  const session = ptySessionForTerminalControl(id);
  for (const key of keys) {
    const encoded = encodeTerminalInput({
      type: 'key',
      key: toTerminalInputKey(key),
    });
    session.pty.write(encoded.sequence);
  }
}

async function sendTerminalText(id: string, text: string): Promise<void> {
  const session = ptySessionForTerminalControl(id);
  const encoded = encodeTerminalInput({ type: 'text', text });
  session.pty.write(encoded.sequence);
}

async function captureTerminalVisibleText(id: string): Promise<string> {
  const session = ptySessionForTerminalControl(id);
  if (!session.terminalModel) {
    throw new Error(`Session ${id} does not have a terminal model`);
  }
  return session.terminalModel.getVisibleText();
}

function nextTerminalName(): string {
  return `Terminal ${++terminalCounter}`;
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
    ...(session.spawnedBySessionId !== undefined
      ? { spawnedBySessionId: session.spawnedBySessionId }
      : {}),
    type: session.type,
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
    terminalBackend: session.terminalBackend,
    customCommand: session.customCommand,
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

  for (const session of sessions.values()) {
    serializedPty.push(serializePtySession(session, scrollbackDirPath));
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
    'serialized sessions for restart: reason=%s pty=%d preservedFailedPty=%d prunedScrollback=%d configDir=%s',
    reason,
    serializedPty.length,
    preservedFailures?.sessions.length ?? 0,
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

async function migrateV2ToV3(
  sessions: SerializedPtySession[],
  workspaces: string[]
): Promise<void> {
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
    // Clean up legacy fields (repoPath is now kept as it's our real field)
    delete raw.root;
    delete raw.worktreeName;
    await yieldToEventLoop();
  }
}

async function migrateV3ToV4(sessions: SerializedPtySession[]): Promise<void> {
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
    await yieldToEventLoop();
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

type RestoredPtySpawnParams = {
  command: string | undefined;
  args: string[];
  terminalBackend: TerminalBackend;
};

function removedTmuxBackendReason(
  s: SerializedPtySession,
  pendingVersion: number
): string | null {
  const raw = s as SerializedPtySession & {
    useTmux?: unknown;
    tmuxSessionName?: unknown;
  };
  const rawTerminalBackend = (raw as unknown as Record<string, unknown>)[
    'terminalBackend'
  ];
  if (rawTerminalBackend === 'tmux-compat') {
    return 'terminalBackend is tmux-compat';
  }
  if (raw.useTmux === true) {
    return 'legacy useTmux flag is true';
  }
  if (
    typeof raw.tmuxSessionName === 'string' &&
    raw.tmuxSessionName.length > 0
  ) {
    return 'legacy tmuxSessionName is present';
  }
  if (pendingVersion < 7 && rawTerminalBackend === undefined) {
    return 'legacy manifest predates relay-pty terminalBackend state';
  }
  return null;
}

function writeUnsupportedTmuxSessionTombstones(
  configDir: string,
  pending: PendingSessionsFile,
  unsupportedSessions: SerializedPtySession[]
): void {
  if (unsupportedSessions.length === 0) return;
  const pathToWrite = path.join(configDir, UNSUPPORTED_TMUX_SESSIONS_FILE);
  const detectedAt = new Date().toISOString();
  const records = unsupportedSessions.map((session) => ({
    id: session.id,
    displayName: session.displayName,
    pendingVersion: pending.version,
    pendingReason: pending.reason ?? 'unspecified',
    reasonCode: 'REMOVED_TMUX_BACKEND',
    message:
      'This pending session used the removed tmux-compat backend and cannot be restored. Start a new relay-pty session.',
    detectedAt,
  }));
  fs.writeFileSync(
    pathToWrite,
    JSON.stringify(
      {
        version: 1,
        generatedAt: detectedAt,
        sessions: records,
      },
      null,
      2
    ) + '\n'
  );
}

function serializedTerminalBackend(s: SerializedPtySession): TerminalBackend {
  const rawBackend = (s as SerializedPtySession & Record<string, unknown>)
    .terminalBackend;
  if (rawBackend === undefined || rawBackend === 'relay-pty')
    return 'relay-pty';
  throw new Error(
    `serialized session ${s.id} uses removed terminal backend ${String(rawBackend)}; start a new session`
  );
}

async function resolveSessionSpawnParams(
  s: SerializedPtySession
): Promise<RestoredPtySpawnParams> {
  const terminalBackend = serializedTerminalBackend(s);

  if ((s.type as string) !== 'terminal') {
    throw new Error(
      `serialized session ${s.id} is a retired PTY agent session; agents now run only in channels`
    );
  }
  if (!s.customCommand) {
    throw new Error(
      `serialized terminal ${s.id} has no command and cannot be restored`
    );
  }
  return {
    command: s.customCommand,
    args: [],
    terminalBackend,
  };
}

function restoreSession(
  s: SerializedPtySession,
  spawn: RestoredPtySpawnParams,
  initialScrollback: string[] | undefined
): void {
  const createParams: CreateParams = {
    id: s.id,
    ...(s.spawnedBySessionId !== undefined
      ? { spawnedBySessionId: s.spawnedBySessionId }
      : {}),
    type: 'terminal',
    repoName: s.repoName,
    repoPath: s.repoPath,
    worktreePath: s.worktreePath,
    cwd: s.cwd,
    branchName: s.branchName,
    displayName: s.displayName,
    args: spawn.args,
    terminalBackend: spawn.terminalBackend,
    sessionCustomCommand: s.customCommand,
    restored: true,
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

function syncDisplayNameCounters(): void {
  for (const s of sessions.values()) {
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

async function migratePendingSessionsFile(
  pending: PendingSessionsFile,
  workspaces?: string[]
): Promise<void> {
  if (pending.version <= 2)
    await migrateV2ToV3(pending.sessions, workspaces ?? []);
  if (pending.version <= 3) await migrateV3ToV4(pending.sessions);
}

async function tryRestorePtySession(
  s: SerializedPtySession,
  pendingVersion: number,
  scrollbackDirPath: string
): Promise<boolean> {
  const initialScrollback = loadScrollback(scrollbackDirPath, s.id);
  try {
    if (pendingVersion >= 6) assertRestorableCwd(s);
    const spawn = await resolveSessionSpawnParams(s);
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
  workspaces?: string[]
): Promise<number> {
  await migratePendingSessionsFile(pending, workspaces);
  const failedSessions: SerializedPtySession[] = [];
  const scrollbackDirPath = scrollbackDir(configDir);
  let restored = 0;
  const unsupportedTmuxSessions: SerializedPtySession[] = [];

  for (const s of pending.sessions) {
    // Yield before each restore unit rather than after it. This gives HTTP/I/O
    // a turn between sessions without delaying restoreFromDisk's result after
    // the final child has been created.
    await yieldToEventLoop();
    if ((s.type as string) !== 'terminal') {
      logger.warn(
        'discarding retired PTY agent session %s (%s); agents now run only in channels',
        s.id,
        s.displayName
      );
      continue;
    }
    const removedTmuxReason = removedTmuxBackendReason(s, pending.version);
    if (removedTmuxReason) {
      logger.warn(
        'tombstoning unsupported tmux pending session %s (%s): %s',
        s.id,
        s.displayName,
        removedTmuxReason
      );
      unsupportedTmuxSessions.push(s);
      continue;
    }
    const ok = await tryRestorePtySession(
      s,
      pending.version,
      scrollbackDirPath
    );
    if (ok) restored++;
    else failedSessions.push(s);
  }

  writeUnsupportedTmuxSessionTombstones(
    configDir,
    pending,
    unsupportedTmuxSessions
  );

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
  workspaces?: string[]
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

  const freshSessions: SerializedPtySession[] = [];
  for (const session of pending.sessions) {
    if (!isPendingSessionStale(pending, session)) {
      freshSessions.push(withPendingSince(pending, session));
    }
    await yieldToEventLoop();
  }
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
    workspaces
  );
}

async function restoreFromDisk(
  configDir: string,
  workspaces?: string[]
): Promise<number> {
  // Startup restore is detached after `listening`, but an async function still
  // executes synchronously until its first await. Yield before manifest/DB work
  // so the listener can return to the event loop before any cold-resume burst.
  await yieldToEventLoop();
  const restored = await restorePendingSessionsFromDisk(configDir, workspaces);
  syncDisplayNameCounters();
  return restored;
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

export {
  configure,
  create,
  renew,
  get,
  list,
  kill,
  detachForRestart,
  resize,
  sendTerminalKeys,
  sendTerminalText,
  captureTerminalVisibleText,
  updateDisplayName,
  write,
  supervisorWrite,
  recordRoutedPtyInput,
  releaseRoutedPtyControlSession,
  releaseRoutedPtyControlSessionsForNode,
  getInterventions,
  onControlEvent,
  onStateChange,
  onSessionCreate,
  onSessionEnd,
  onSessionDurabilityChanged,
  setSessionNodeStatusResolver,
  refreshDurability,
  getReplaySnapshot,
  getRenderedScreenSnapshot,
  nextTerminalName,
  serializeAll,
  restoreFromDisk,
  getSessionMeta,
  getAllSessionMeta,
  populateMetaCache,
  // onGlobalScrollbackTrim intentionally omitted: no WS consumer wired yet.
  // Add back when the broadcast integration lands.
  enforceGlobalScrollbackCap,
};
