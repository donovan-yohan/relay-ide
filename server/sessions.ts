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
  type CreateWebParams,
} from './web-session-handler.js';
import { getWorkingTreeDiff } from './git.js';
import { getPrForBranch, isStalePr } from './gh.js';
import {
  trackEvent,
  recordSessionEvent,
  upsertSessionRollup,
} from './analytics.js';
import { createLogger } from './logger.js';

const execFileAsync = promisify(execFile);
const logger = createLogger('sessions');
const TMUX_COMMAND = 'tmux';

interface SerializedPtySession {
  id: string;
  type: SessionType;
  agent: AgentType;
  repoPath: string;
  worktreePath: string | null;
  cwd: string;
  repoName: string;
  branchName: string;
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
}

interface SerializedWebSession {
  id: string;
  type: SessionType;
  agent: AgentType;
  repoPath: string;
  worktreePath: string | null;
  cwd: string;
  repoName: string;
  branchName: string;
  displayName: string;
  createdAt: string;
  lastActivity: string;
  customCommand: string | null;
  runtimeOwnership: 'spawned' | 'attached';
  hookToken: string;
  adapterType: string;
  needsBranchRename?: boolean;
  workspaceId?: string;
  additionalDirs?: string[];
  /** Messages buffer persisted for replay (up to 1000 events) */
  messages?: import('../shared/chat-events.js').ChatEvent[];
  /** Canonical v2 state persisted for web-chat reconnect/restore */
  agentSessionV2?: import('../shared/agent-chat-protocol-v2.js').AgentSessionV2;
  /** Recent v2 patches persisted for reconnect catch-up */
  agentPatchesV2?: import('../shared/agent-chat-protocol-v2.js').AgentPatchV2[];
}

interface PendingSessionsFile {
  version: number; // now 5
  timestamp: string;
  sessions: SerializedPtySession[];
  webSessions?: SerializedWebSession[];
}

const STALE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

export type CreateParams = Omit<CreatePtyParams, 'id' | 'callbacks'> & {
  id?: string;
  needsBranchRename?: boolean;
  branchRenamePrompt?: string;
  initialPrompt?: string;
  workspaceId?: string;
  additionalDirs?: string[];
};

export type CreateResult = SessionSummary & { pid: number | undefined };

// In-memory registry: id -> Session
const sessions = new Map<string, Session>();

// Session metadata cache: session ID or worktree path -> SessionMeta
const metaCache = new Map<string, SessionMeta>();

// Module-level defaults for hooks injection (set via configure())
let defaultPort: number | undefined;
let defaultForceOutputParser: boolean | undefined;
let defaultConfigDir: string | undefined;

function configure(opts: {
  port?: number;
  forceOutputParser?: boolean;
  configDir?: string;
}): void {
  defaultPort = opts.port;
  defaultForceOutputParser = opts.forceOutputParser;
  defaultConfigDir = opts.configDir;
}

let terminalCounter = 0;
let agentCounter = 0;

type StateChangeCallback = (sessionId: string, state: AgentState) => void;
const stateChangeCallbacks: StateChangeCallback[] = [];

function onStateChange(cb: StateChangeCallback): void {
  stateChangeCallbacks.push(cb);
}

export function __resetStateChangeCallbacksForTests(): void {
  stateChangeCallbacks.length = 0;
}

type SessionCreateCallback = (
  sessionId: string,
  cwd: string,
  branchName?: string
) => void;
const sessionCreateCallbacks: SessionCreateCallback[] = [];

function onSessionCreate(cb: SessionCreateCallback): void {
  sessionCreateCallbacks.push(cb);
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

function onSessionEnd(cb: SessionEndCallback): void {
  sessionEndCallbacks.push(cb);
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
  };

  const { session: ptySession, result } = createPtySession(
    {
      ...ptyParams,
      callbacks: {
        onStateChange: stateChangeCallbacks,
        onSessionEnd: sessionEndCallbacks,
        fireBackendStateIfChanged,
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
  recordSessionEvent({
    session_id: id,
    repo_path: ptySession.repoPath,
    event_type: 'session_start',
    timestamp: new Date().toISOString(),
  });
  upsertSessionRollup({
    sessionId: id,
    repoPath: ptySession.repoPath,
    repoName: ptySession.repoName,
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
  return { ...result, needsBranchRename: !!ptySession.needsBranchRename };
}

function get(id: string): Session | undefined {
  return sessions.get(id);
}

function list(): SessionSummary[] {
  return Array.from(sessions.values())
    .map(
      (s): SessionSummary => ({
        id: s.id,
        type: s.type,
        agent: s.agent,
        mode: s.mode,
        repoPath: s.repoPath,
        worktreePath: s.worktreePath,
        cwd: s.cwd,
        repoName: s.repoName,
        branchName: s.branchName,
        displayName: s.displayName,
        createdAt: s.createdAt,
        lastActivity: s.lastActivity,
        idle: s.idle,
        customCommand: s.customCommand,
        status: s.status,
        needsBranchRename: !!s.needsBranchRename,
        agentState: s.agentState,
        currentActivity: s.currentActivity,
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
      })
    )
    .sort((a, b) => b.lastActivity.localeCompare(a.lastActivity));
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

  sessions.delete(id);
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
    session.pty.write(data);
  } else {
    logger.warn(`write() called on web session ${id} — no-op`);
  }
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

function serializePtySession(
  session: PtySession,
  scrollbackDirPath: string
): SerializedPtySession {
  const scrollbackPath = path.join(scrollbackDirPath, session.id + '.buf');
  fs.writeFileSync(scrollbackPath, session.scrollback.join(''), 'utf-8');

  return {
    id: session.id,
    type: session.type,
    agent: session.agent,
    repoPath: session.repoPath,
    worktreePath: session.worktreePath,
    cwd: session.cwd,
    repoName: session.repoName,
    branchName: session.branchName,
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
  };
}

function serializeWebSession(session: WebSession): SerializedWebSession {
  return {
    id: session.id,
    type: session.type,
    agent: session.agent,
    repoPath: session.repoPath,
    worktreePath: session.worktreePath,
    cwd: session.cwd,
    repoName: session.repoName,
    branchName: session.branchName,
    displayName: session.displayName,
    createdAt: session.createdAt,
    lastActivity: session.lastActivity,
    customCommand: session.customCommand,
    runtimeOwnership: session.runtimeOwnership,
    hookToken: session.hookToken,
    adapterType: session.adapterType,
    ...(session.needsBranchRename ? { needsBranchRename: true as const } : {}),
    ...(session.workspaceId ? { workspaceId: session.workspaceId } : {}),
    ...(session.additionalDirs?.length
      ? { additionalDirs: session.additionalDirs }
      : {}),
    ...(session.messages.length
      ? { messages: session.messages.slice(-1000) }
      : {}),
    agentSessionV2: session.agentSessionV2,
    ...(session.agentPatchesV2.length
      ? { agentPatchesV2: session.agentPatchesV2.slice(-1000) }
      : {}),
  };
}

function serializeAll(configDir: string): void {
  const scrollbackDirPath = path.join(configDir, 'scrollback');
  fs.mkdirSync(scrollbackDirPath, { recursive: true });

  const serializedPty: SerializedPtySession[] = [];
  const serializedWeb: SerializedWebSession[] = [];

  for (const session of sessions.values()) {
    if (session.mode === 'pty') {
      serializedPty.push(serializePtySession(session, scrollbackDirPath));
    } else {
      serializedWeb.push(serializeWebSession(session));
    }
  }

  const pending: PendingSessionsFile = {
    version: 5,
    timestamp: new Date().toISOString(),
    sessions: serializedPty,
    webSessions: serializedWeb,
  };

  fs.writeFileSync(
    path.join(configDir, 'pending-sessions.json'),
    JSON.stringify(pending, null, 2),
    'utf-8'
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
  } catch {
    fs.unlinkSync(pendingPath);
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
  };
  if (spawn.command) createParams.command = spawn.command;
  if (initialScrollback) createParams.initialScrollback = initialScrollback;
  create(createParams);
}

async function restoreWebSession(s: SerializedWebSession): Promise<void> {
  const createParams: CreateWebParams = {
    id: s.id,
    agentType: s.adapterType,
    cwd: s.cwd,
    repoPath: s.repoPath,
    repoName: s.repoName,
    worktreePath: s.worktreePath,
    branchName: s.branchName,
    displayName: s.displayName,
    port: defaultPort ?? 3456,
    configDir: defaultConfigDir ?? '',
    runtimeOwnership: s.runtimeOwnership,
    hookToken: s.hookToken,
    ...(s.workspaceId !== undefined ? { workspaceId: s.workspaceId } : {}),
    ...(s.additionalDirs !== undefined
      ? { additionalDirs: s.additionalDirs }
      : {}),
  };

  const { session } = await createWebSession(
    createParams,
    sessions,
    fireBackendStateIfChanged
  );

  // Restore persisted message buffer so reconnecting clients see transcript
  if (s.messages && s.messages.length > 0) {
    session.messages = s.messages.slice(-1000);
  }
  if (s.agentSessionV2) {
    session.agentSessionV2 = s.agentSessionV2;
  }
  if (s.agentPatchesV2 && s.agentPatchesV2.length > 0) {
    session.agentPatchesV2 = s.agentPatchesV2.slice(-1000);
  }

  // If the adapter supports resume and we have a stored provider session ID,
  // reconnect via resumeSession so the provider reattaches to the prior conversation.
  // This replaces the fresh connect done by createWebSession above.
  await reconnectWebSession(session);
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

async function restoreFromDisk(
  configDir: string,
  workspaces?: string[],
  frameworks?: Record<string, Partial<AgentFramework>>
): Promise<number> {
  const pendingPath = path.join(configDir, 'pending-sessions.json');
  if (!fs.existsSync(pendingPath)) return 0;

  const pending = readPendingSessionsFile(pendingPath);
  if (!pending) return 0;

  // Ignore stale files (>5 minutes old)
  if (Date.now() - new Date(pending.timestamp).getTime() > STALE_THRESHOLD_MS) {
    fs.unlinkSync(pendingPath);
    return 0;
  }

  if (pending.version <= 2) {
    migrateV2ToV3(pending.sessions, workspaces ?? []);
  }

  if (pending.version <= 3) {
    migrateV3ToV4(pending.sessions);
  }

  const scrollbackDirPath = path.join(configDir, 'scrollback');
  let restored = 0;

  for (const s of pending.sessions) {
    const scrollbackPath = path.join(scrollbackDirPath, s.id + '.buf');
    const initialScrollback = loadScrollback(scrollbackDirPath, s.id);

    const spawn = await resolveSessionSpawnParams(s, frameworks);

    try {
      restoreSession(s, spawn, initialScrollback);
      restored++;
    } catch (err) {
      logger.error(`Failed to restore session ${s.id} (${s.displayName})`, err);
    }

    try {
      fs.unlinkSync(scrollbackPath);
    } catch {
      /* ignore */
    }
  }

  // Restore web sessions (v5+)
  for (const s of pending.webSessions ?? []) {
    try {
      await restoreWebSession(s);
      restored++;
    } catch (err) {
      logger.error(
        `Failed to restore web session ${s.id} (${s.displayName})`,
        err
      );
    }
  }

  try {
    fs.unlinkSync(pendingPath);
  } catch {
    /* ignore */
  }
  try {
    fs.rmdirSync(path.join(configDir, 'scrollback'));
  } catch {
    /* ignore — may not be empty */
  }

  syncDisplayNameCounters();

  return restored;
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
  trackEvent({
    category: 'session',
    action: 'created',
    target: result.session.id,
    properties: {
      agent: params.agentType,
      type: 'agent',
      workspace: params.repoPath,
      mode: 'web',
    },
    session_id: result.session.id,
  });
  return result;
}

export {
  configure,
  create,
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
  onStateChange,
  onSessionCreate,
  onSessionEnd,
  nextTerminalName,
  nextAgentName,
  serializeAll,
  restoreFromDisk,
  activeTmuxSessionNames,
  getSessionMeta,
  getAllSessionMeta,
  populateMetaCache,
};
export type { CreateWebParams };
