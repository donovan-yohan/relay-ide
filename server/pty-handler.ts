import pty from 'node-pty';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  TerminalActivityState,
  PtySession,
  Session,
  SessionStatus,
  SessionSummary,
  TerminalBackend,
} from './types.js';
import { readMeta, writeMeta } from './config.js';
import { cleanEnv } from './utils.js';
import { createLogger } from './logger.js';
import { getDefaultAllocator, type PortAllocator } from './port-allocator.js';
import { DEFAULT_LOCAL_NODE_ID } from '../shared/identity.js';
import { fileURLToPath } from 'node:url';
import type { SessionLane } from '../shared/session-lane.js';
import {
  createLegacyControlStateSummary,
  normalizeControlStateSummary,
  type ControlStateSummary,
} from '../shared/control-state.js';
import {
  appendTerminalStreamData,
  createTerminalStreamState,
} from '../shared/session-replay.js';
import {
  createLibghosttyTerminalModelBackend,
  type TerminalModelBackend,
} from './terminal-model-backend.js';
import { detectTerminalAttentionPrompt } from './terminal-attention.js';
import { buildRelayPtySessionEnv } from './relay-pty-session.js';

const IDLE_TIMEOUT_MS = 5000;
/** Default per-session scrollback cap. Overridable via createPtySession options. */
const DEFAULT_MAX_SCROLLBACK_PER_SESSION = 256 * 1024; // 256KB
const logger = createLogger('pty');

function shellQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\"'\"'") + "'";
}

export type CreatePtyParams = {
  id: string;
  type?: 'terminal' | undefined;
  repoName?: string | undefined;
  repoPath?: string | undefined;
  worktreePath?: string | null | undefined;
  cwd: string;
  branchName?: string | undefined;
  displayName?: string | undefined;
  command?: string | undefined;
  args?: string[] | undefined;
  cols?: number | undefined;
  rows?: number | undefined;
  configPath?: string | undefined;
  configDir?: string | undefined;
  terminalBackend?: TerminalBackend | undefined;
  sessionCustomCommand?: string | null | undefined;
  sessionLane?: SessionLane | undefined;
  initialScrollback?: string[] | undefined;
  restored?: boolean | undefined;
  port?: number | undefined;
  controlState?: ControlStateSummary | undefined;
  /** Environment variable names to inject with allocated ports (per-worktree) */
  portVariables?: string[] | undefined;
  /** Optional port allocator instance (uses default if not provided) */
  portAllocator?: PortAllocator | undefined;
  /** Per-session scrollback cap in bytes. Defaults to 256 KB. */
  maxScrollbackBytes?: number | undefined;
  /** Relay node ID to inject as RELAY_NODE_ID (defaults to DEFAULT_LOCAL_NODE_ID). */
  nodeId?: string | undefined;
  /** WorkContext ID to inject as RELAY_WORK_CONTEXT_ID (omitted when not set). */
  workContextId?: string | undefined;
  /**
   * Additional env vars layered on top of the base session env (#740: a Tab
   * inherits its anchoring Bench's persisted `envOverrides`). Applied
   * ADDITIVELY before Relay-owned identity injection, so Relay's own
   * `RELAY_*`/`RELAY_HUB_URL` vars and the per-session relayctl PATH shim
   * always win — caller env can never clobber them. An empty/undefined record
   * is a no-op (unchanged behavior).
   */
  envOverrides?: Record<string, string> | undefined;
  callbacks?:
    | {
        onStateChange?: Array<
          (sessionId: string, state: TerminalActivityState) => void
        >;
        onSessionEnd?: Array<
          (sessionId: string, cwd: string, branchName?: string) => void
        >;
        fireBackendStateIfChanged?: (session: Session) => void;
        /**
         * Called after each scrollback append so the global cap can be enforced.
         * Receives the ID of the session that just appended and the size of the
         * appended chunk in bytes so callers can maintain an incremental total.
         */
        onScrollbackAppend?: (sessionId: string, appendedBytes: number) => void;
      }
    | undefined;
};

export type CreatePtyResult = SessionSummary & { pid: number | undefined };

type PortInjectionParams = {
  repoPath: string;
  worktreePath: string | null | undefined;
  cwd: string;
  portVariables?: string[] | undefined;
  portAllocator?: PortAllocator | undefined;
};

/**
 * Inject per-worktree allocated port environment variables into the PTY environment.
 *
 * Uses the port allocator to look up existing allocations for the worktree
 * identified by worktreePath (or cwd if no worktree). Ports are injected as
 * environment variables matching the configured port variable names.
 */
function injectPortEnvVars(
  env: Record<string, string>,
  params: PortInjectionParams
): void {
  const { repoPath, worktreePath, cwd, portVariables, portAllocator } = params;

  // Skip if no port variable names configured
  if (!portVariables || portVariables.length === 0) return;

  // Get the port allocator - use provided instance or fall back to default
  let allocator: PortAllocator;
  try {
    allocator = portAllocator ?? getDefaultAllocator();
  } catch {
    // Default allocator not initialized - skip silently
    logger.debug('Port env injection skipped: allocator not available');
    return;
  }

  // Derive worktree ID: use worktreePath if available, otherwise cwd
  const worktreeId = worktreePath ?? cwd;
  if (!worktreeId) return;

  // Get existing port allocations (synchronous)
  const portMapping = allocator.getPortsForWorktree(repoPath, worktreeId);
  if (!portMapping) return;

  // Inject allocated ports as environment variables
  for (const [varName, port] of Object.entries(portMapping)) {
    if (portVariables.includes(varName)) {
      env[varName] = String(port);
    }
  }
}

/**
 * Resolve the path to the compiled relayctl binary.
 * Searches relative to this file's location in dist/ (compiled output).
 */
function resolveRelayctlBinaryPath(): string | null {
  try {
    const selfPath = fileURLToPath(import.meta.url);
    // selfPath is something like /…/dist/server/pty-handler.js
    // relayctl is compiled to /…/dist/bin/relayctl.js
    const distDir = path.dirname(path.dirname(selfPath));
    const candidate = path.join(distDir, 'bin', 'relayctl.js');
    if (fs.existsSync(candidate)) return candidate;
  } catch {
    // non-ESM context or path not resolvable — skip
  }
  return null;
}

/**
 * Write a per-session bin directory containing a `relayctl` shim that delegates
 * to the compiled relayctl.js binary via node. Returns the bin dir path, or null
 * if the relayctl binary cannot be located.
 *
 * The shim is written to `{tmpdir}/relay-ide/{sessionId}/bin/relayctl`.
 * Callers must prepend this path to PATH in the session environment so that
 * `relayctl` is only discoverable from within a Relay-spawned PTY.
 */
function writeRelayctlShim(sessionId: string): string | null {
  const binaryPath = resolveRelayctlBinaryPath();
  if (!binaryPath) return null;
  try {
    const binDir = path.join(os.tmpdir(), 'relay-ide', sessionId, 'bin');
    fs.mkdirSync(binDir, { recursive: true, mode: 0o700 });
    const shimPath = path.join(binDir, 'relayctl');
    const shim = `#!/bin/sh\nexec node ${shellQuote(binaryPath)} "$@"\n`;
    fs.writeFileSync(shimPath, shim, { encoding: 'utf-8', mode: 0o755 });
    fs.chmodSync(shimPath, 0o755);
    return binDir;
  } catch (err) {
    logger.warn(`Failed to write relayctl shim for session ${sessionId}:`, err);
    return null;
  }
}

type RelaySessionEnvParams = {
  sessionId: string;
  nodeId: string;
  port: number | undefined;
  workContextId: string | undefined;
};

/**
 * Inject Relay-owned session identity env vars into the PTY environment.
 *
 * - RELAY_NODE_ID — the node this session is running on
 * - RELAY_SESSION_ID — the local session ID
 * - RELAY_HUB_URL — the local hub base URL (http://127.0.0.1:{port})
 * - RELAY_SOCKET — alias for the local hub endpoint for terminal mailroom CLIs
 * - RELAY_WORK_CONTEXT_ID — set only when a WorkContext is bound
 *
 * Also writes a per-session bin dir with a `relayctl` shim and prepends it
 * to PATH so relayctl is only discoverable from within a Relay-spawned PTY.
 *
 * These env vars are injected here (inside Relay's PTY spawn path) so they
 * never appear in shells the user opens outside Relay.
 *
 * @internal exported for testing only; use `createPtySession` in production.
 */
export function injectRelaySessionEnvForTest(
  env: Record<string, string>,
  params: RelaySessionEnvParams
): void {
  return injectRelaySessionEnv(env, params);
}

function injectRelaySessionEnv(
  env: Record<string, string>,
  params: RelaySessionEnvParams
): void {
  const { sessionId, nodeId, port, workContextId } = params;

  env.RELAY_NODE_ID = nodeId;
  env.RELAY_SESSION_ID = sessionId;

  if (port !== undefined) {
    const hubUrl = `http://127.0.0.1:${port}`;
    env.RELAY_HUB_URL = hubUrl;
    env.RELAY_SOCKET = hubUrl;
  }

  if (workContextId) {
    env.RELAY_WORK_CONTEXT_ID = workContextId;
  }

  // Write per-session relayctl shim and prepend to PATH so it is only
  // reachable from within Relay-spawned PTY sessions.
  const shimBinDir = writeRelayctlShim(sessionId);
  if (shimBinDir) {
    const currentPath = env.PATH ?? process.env.PATH ?? '';
    env.PATH = `${shimBinDir}:${currentPath}`;
  }
}

/**
 * Reserved env keys that bench overrides may NOT set. These are Relay-owned:
 * `PATH` carries the per-session relayctl shim, and any `RELAY_*` var is part
 * of the session identity/control contract. A bench override targeting one of
 * these is dropped (logged once) rather than applied, so a misconfigured bench
 * can never break session identity or shim discovery.
 */
function isReservedEnvKey(key: string): boolean {
  return key === 'PATH' || key.startsWith('RELAY_');
}

/**
 * Layer a Bench's persisted `envOverrides` onto the base PTY env (#740).
 * Additive: each non-reserved key is set (or overwritten) on both the process
 * env. Reserved keys (`PATH`, `RELAY_*`)
 * are skipped so Relay's own injection always wins. Empty record is a no-op.
 *
 * @internal exported as injectBenchEnvOverridesForTest for testing only.
 */
function applyBenchEnvOverrides(
  env: Record<string, string>,
  overrides: Record<string, string>
): void {
  for (const [key, value] of Object.entries(overrides)) {
    if (typeof key !== 'string' || key.length === 0) continue;
    if (typeof value !== 'string') continue;
    if (isReservedEnvKey(key)) {
      logger.warn(
        `Skipping reserved bench env override "${key}" (Relay-owned, not overridable)`
      );
      continue;
    }
    env[key] = value;
  }
}

/** @internal Exposed for unit tests of bench env-override precedence. */
export function injectBenchEnvOverridesForTest(
  env: Record<string, string>,
  overrides: Record<string, string>
): void {
  applyBenchEnvOverrides(env, overrides);
}

function buildPortInjectionParams(
  repoPath: string | undefined,
  worktreePath: string | null,
  cwd: string,
  portVariables: string[] | undefined,
  portAllocator: PortAllocator | undefined
): PortInjectionParams | undefined {
  if (!repoPath || (!portVariables && !portAllocator)) return undefined;
  return { repoPath, worktreePath, cwd, portVariables, portAllocator };
}

function resolveSpawnTarget(
  resolvedCommand: string,
  args: string[],
  paramTerminalBackend: TerminalBackend | undefined,
  workContextId: string | undefined,
  id: string,
  env: NodeJS.ProcessEnv
): {
  spawnCommand: string;
  spawnArgs: string[];
  spawnEnv: NodeJS.ProcessEnv;
  terminalBackend: TerminalBackend;
} {
  if (paramTerminalBackend && paramTerminalBackend !== 'relay-pty') {
    throw new Error(
      `Unsupported terminal backend "${paramTerminalBackend}"; Relay now supports relay-pty only.`
    );
  }
  return {
    spawnCommand: resolvedCommand,
    spawnArgs: args,
    spawnEnv: buildRelayPtySessionEnv({
      id,
      env,
      ...(workContextId ? { workContextId } : {}),
    }),
    terminalBackend: 'relay-pty',
  };
}

function buildSessionObject(
  params: CreatePtyParams,
  ptyProcess: pty.IPty,
  scrollback: string[],
  terminalBackend: TerminalBackend,
  terminalModel: TerminalModelBackend | undefined,
  createdAt: string,
  scrollbackCapacityBytes: number
): PtySession {
  const {
    id,
    type,
    repoName,
    repoPath,
    worktreePath = null,
    cwd,
    branchName,
    displayName,
    command,
    sessionCustomCommand,
    restored: paramRestored,
    controlState,
  } = params;

  const normalizedControlState = normalizeControlStateSummary(
    controlState ?? createLegacyControlStateSummary()
  );

  return {
    id,
    nodeId: DEFAULT_LOCAL_NODE_ID,
    type: type || 'terminal',
    mode: 'pty' as const,
    ...(repoPath ? { repoPath } : {}),
    ...(repoPath ? { worktreePath: worktreePath ?? null } : {}),
    ...(repoName ? { repoName } : {}),
    ...(repoPath ? { branchName: branchName ?? '' } : {}),
    displayName: displayName || repoName || path.basename(cwd) || '',
    pty: ptyProcess,
    createdAt,
    lastActivity: createdAt,
    scrollback,
    scrollbackBytesEvicted: 0,
    scrollbackCapacityBytes,
    terminalStream: createTerminalStreamState({
      sessionId: id,
      capacityBytes: scrollbackCapacityBytes,
      initialChunks: scrollback,
    }),
    terminalStreamSubscribers: [],
    terminalBackend,
    ...(terminalModel ? { terminalModel } : {}),
    idle: false,
    cwd,
    customCommand:
      sessionCustomCommand !== undefined
        ? sessionCustomCommand
        : command || null,
    onPtyReplacedCallbacks: [],
    status: 'active' as SessionStatus,
    restored: paramRestored || false,
    needsBranchRename: false,
    activityState: 'initializing',
    cleanedUp: false,
    controlState: normalizedControlState,
  };
}

export function handleTerminalAttentionUpdate(
  session: PtySession,
  stateChangeCallbacks: Array<
    (sessionId: string, state: TerminalActivityState) => void
  >,
  fireBackendStateIfChanged: ((session: PtySession) => void) | undefined
): void {
  const terminalModel = session.terminalModel;
  if (!terminalModel) return;

  const attention = detectTerminalAttentionPrompt(
    terminalModel.getVisibleText()
  );
  if (!attention) {
    if (
      session.activityState === 'permission-prompt' &&
      session.permissionPromptSource === 'terminal-model'
    ) {
      delete session.permissionType;
      delete session.permissionPromptSource;
      session.activityState = 'idle';
      for (const cb of stateChangeCallbacks) cb(session.id, 'idle');
      fireBackendStateIfChanged?.(session);
    }
    return;
  }

  session.permissionType = attention.kind;
  session.permissionPromptSource = attention.source;
  if (session.activityState !== 'permission-prompt') {
    session.activityState = 'permission-prompt';
    for (const cb of stateChangeCallbacks) cb(session.id, 'permission-prompt');
  }
  fireBackendStateIfChanged?.(session);
}

type ResolvedPtyCallbacks = {
  stateChangeCallbacks: Array<
    (sessionId: string, state: TerminalActivityState) => void
  >;
  sessionEndCallbacks: Array<
    (sessionId: string, cwd: string, branchName?: string) => void
  >;
  fireBackendStateIfChanged: ((session: Session) => void) | undefined;
  onScrollbackAppend:
    | ((sessionId: string, appendedBytes: number) => void)
    | undefined;
};

function resolveCallbacks(
  callbacks: CreatePtyParams['callbacks']
): ResolvedPtyCallbacks {
  return {
    stateChangeCallbacks: callbacks?.onStateChange ?? [],
    sessionEndCallbacks: callbacks?.onSessionEnd ?? [],
    fireBackendStateIfChanged: callbacks?.fireBackendStateIfChanged,
    onScrollbackAppend: callbacks?.onScrollbackAppend,
  };
}

export function createPtySession(
  params: CreatePtyParams,
  sessionsMap: Map<string, Session>
): { session: PtySession; result: CreatePtyResult } {
  if (params.type !== undefined && params.type !== 'terminal') {
    throw new Error(
      'Agent conversations run in channels; PTY sessions only support terminals.'
    );
  }
  if (!params.command) {
    throw new Error('PTY terminal sessions require an explicit command.');
  }
  const {
    stateChangeCallbacks,
    sessionEndCallbacks,
    fireBackendStateIfChanged,
    onScrollbackAppend,
  } = resolveCallbacks(params.callbacks);
  const {
    id,
    repoPath,
    worktreePath = null,
    cwd,
    command,
    args: rawArgs = [],
    cols = 80,
    rows = 24,
    configPath,
    initialScrollback,
    port,
    portVariables,
    portAllocator,
    maxScrollbackBytes: paramMaxScrollbackBytes,
    nodeId: paramNodeId,
    workContextId: paramWorkContextId,
    envOverrides: paramEnvOverrides,
  } = params;

  const maxScrollbackPerSession =
    paramMaxScrollbackBytes ?? DEFAULT_MAX_SCROLLBACK_PER_SESSION;

  const createdAt = new Date().toISOString();

  const resolvedCommand = command;

  const portInjectionParams = buildPortInjectionParams(
    repoPath,
    worktreePath,
    cwd,
    portVariables,
    portAllocator
  );

  const relaySessionEnvParams: RelaySessionEnvParams = {
    sessionId: id,
    nodeId: paramNodeId ?? DEFAULT_LOCAL_NODE_ID,
    port,
    workContextId: paramWorkContextId,
  };

  const env = cleanEnv();
  if (portInjectionParams) injectPortEnvVars(env, portInjectionParams);
  if (paramEnvOverrides) applyBenchEnvOverrides(env, paramEnvOverrides);
  injectRelaySessionEnv(env, relaySessionEnvParams);
  const args = rawArgs;

  const { spawnCommand, spawnArgs, spawnEnv, terminalBackend } =
    resolveSpawnTarget(
      resolvedCommand,
      args,
      params.terminalBackend,
      params.workContextId,
      id,
      env
    );

  const ptyProcess = pty.spawn(spawnCommand, spawnArgs, {
    name: 'xterm-256color',
    cols,
    rows,
    cwd,
    env: spawnEnv,
  });

  const scrollback: string[] = initialScrollback ? [...initialScrollback] : [];
  const terminalModel = createLibghosttyTerminalModelBackend({
    cols,
    rows,
    scrollbackLimit: 1000,
  });
  for (const chunk of scrollback) terminalModel.feed(chunk);
  // Use a ref so tryRetrySpawn (called from onExit) can reset the byte counter
  const scrollbackRef = {
    bytes: initialScrollback
      ? initialScrollback.reduce((sum, s) => sum + s.length, 0)
      : 0,
  };

  const session = buildSessionObject(
    params,
    ptyProcess,
    scrollback,
    terminalBackend,
    terminalModel,
    createdAt,
    maxScrollbackPerSession
  );
  sessionsMap.set(id, session);

  if (configPath && worktreePath) {
    const existing = readMeta(configPath, worktreePath);
    if (existing && existing.displayName) {
      session.displayName = existing.displayName;
    }
    writeMeta(configPath, {
      worktreePath,
      displayName: session.displayName,
      lastActivity: createdAt,
    });
  }

  let metaFlushTimer: ReturnType<typeof setTimeout> | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  function resetIdleTimer(): void {
    if (session.idle) {
      session.idle = false;
      fireBackendStateIfChanged?.(session);
    }
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (!session.idle) {
        session.idle = true;
        fireBackendStateIfChanged?.(session);
      }
    }, IDLE_TIMEOUT_MS);
  }

  function attachHandlers(proc: pty.IPty): void {
    const restoredClearTimer = session.restored
      ? setTimeout(() => {
          session.restored = false;
        }, 3000)
      : null;

    proc.onData((data) => {
      session.lastActivity = new Date().toISOString();
      resetIdleTimer();
      scrollback.push(data);
      session.terminalModel?.feed(data);
      scrollbackRef.bytes += data.length;
      const terminalStreamEnvelope = session.terminalStream
        ? appendTerminalStreamData(session.terminalStream, data)
        : null;
      if (terminalStreamEnvelope) {
        for (const cb of session.terminalStreamSubscribers ?? []) {
          cb(terminalStreamEnvelope);
        }
      }
      // Trim oldest entries if over limit; track total bytes evicted so
      // `SessionReplaySnapshot.bytesDropped` can report lost history.
      while (
        scrollbackRef.bytes > maxScrollbackPerSession &&
        scrollback.length > 1
      ) {
        const evicted = (scrollback.shift() as string).length;
        scrollbackRef.bytes -= evicted;
        session.scrollbackBytesEvicted += evicted;
      }
      // Notify sessions layer so global cap can be enforced.
      // Pass the session id and chunk size so the caller can maintain an
      // incremental total and skip the O(N) walk when still under cap.
      onScrollbackAppend?.(id, data.length);
      if (configPath && worktreePath && !metaFlushTimer) {
        metaFlushTimer = setTimeout(() => {
          metaFlushTimer = null;
          writeMeta(configPath, {
            worktreePath,
            displayName: session.displayName,
            lastActivity: session.lastActivity,
          });
        }, 5000);
      }

      handleTerminalAttentionUpdate(
        session,
        stateChangeCallbacks,
        fireBackendStateIfChanged
      );
    });

    proc.onExit(() => {
      if (session.cleanedUp) return;
      session.cleanedUp = true;

      if (restoredClearTimer) clearTimeout(restoredClearTimer);

      if (session.restored) {
        session.status = 'disconnected';
        session.restored = false;
        if (idleTimer) clearTimeout(idleTimer);
        if (metaFlushTimer) clearTimeout(metaFlushTimer);
        releasePtySessionResources(session, id);
        return;
      }

      runExitCleanup(
        session,
        idleTimer,
        metaFlushTimer,
        configPath,
        worktreePath,
        sessionEndCallbacks,
        sessionsMap,
        id,
        cwd
      );
    });
  }

  attachHandlers(ptyProcess);

  const result: CreatePtyResult = {
    id,
    type: session.type,
    mode: 'pty' as const,
    ...(session.repoPath ? { repoPath: session.repoPath } : {}),
    ...(session.worktreePath !== undefined
      ? { worktreePath: session.worktreePath }
      : {}),
    ...(session.repoName ? { repoName: session.repoName } : {}),
    ...(session.branchName !== undefined
      ? { branchName: session.branchName }
      : {}),
    displayName: session.displayName,
    pid: ptyProcess.pid,
    createdAt,
    lastActivity: createdAt,
    idle: false,
    cwd,
    customCommand: session.customCommand,
    terminalBackend,
    status: 'active' as SessionStatus,
    needsBranchRename: false,
    activityState: 'initializing',
    ...session.controlState,
  };

  return { session, result };
}

function runExitCleanup(
  session: PtySession,
  idleTimer: ReturnType<typeof setTimeout> | null,
  metaFlushTimer: ReturnType<typeof setTimeout> | null,
  configPath: string | undefined,
  worktreePath: string | null | undefined,
  sessionEndCallbacks: Array<
    (sessionId: string, cwd: string, branchName?: string) => void
  >,
  sessionsMap: Map<string, Session>,
  id: string,
  cwd: string
): void {
  if (idleTimer) clearTimeout(idleTimer);
  if (metaFlushTimer) clearTimeout(metaFlushTimer);
  if (configPath && worktreePath) {
    writeMeta(configPath, {
      worktreePath,
      displayName: session.displayName,
      lastActivity: session.lastActivity,
    });
  }
  for (const cb of sessionEndCallbacks) {
    try {
      cb(id, cwd, session.branchName);
    } catch (err) {
      logger.error('sessionEnd callback error:', err);
    }
  }
  sessionsMap.delete(id);
  releasePtySessionResources(session, id);
}

/**
 * Release the heavyweight live PTY/vt state while leaving session metadata and
 * scrollback available to cold-resume callers. Idempotent for overlapping
 * explicit-kill and PTY-exit cleanup.
 */
function releasePtySessionResources(session: PtySession, id: string): void {
  session.terminalModel?.dispose();
  delete session.terminalModel;
  delete session.terminalStream;
  session.terminalStreamSubscribers?.splice(0);
  delete session.terminalStreamSubscribers;
  if (!session.preserveRuntimeFilesOnExit) {
    const tmpDir = path.join(os.tmpdir(), 'relay-ide', id);
    fs.rm(tmpDir, { recursive: true, force: true }, () => {});
  }
}
