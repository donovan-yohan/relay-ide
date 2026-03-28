import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AgentType, AgentState, BackendDisplayState, Session, SessionSummary, SessionMeta, SessionType } from './types.js';
export type { BackendDisplayState };
import { AGENT_COMMANDS, AGENT_CONTINUE_ARGS, AGENT_YOLO_ARGS } from './types.js';
import { createPtySession } from './pty-handler.js';
import type { CreatePtyParams } from './pty-handler.js';
import { getPrForBranch, isStalePr, getWorkingTreeDiff } from './git.js';
import { trackEvent } from './analytics.js';

const execFileAsync = promisify(execFile);

interface SerializedPtySession {
  id: string;
  type: SessionType;
  agent: AgentType;
  workspacePath: string;
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
}

interface PendingSessionsFile {
  version: number;  // now 3
  timestamp: string;
  sessions: SerializedPtySession[];
}

const STALE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

type CreateParams = Omit<CreatePtyParams, 'id'> & {
  id?: string;
  needsBranchRename?: boolean;
  branchRenamePrompt?: string;
  initialPrompt?: string;
};

type CreateResult = SessionSummary & { pid: number | undefined };

// In-memory registry: id -> Session
const sessions = new Map<string, Session>();

// Session metadata cache: session ID or worktree path -> SessionMeta
const metaCache = new Map<string, SessionMeta>();

// Module-level defaults for hooks injection (set via configure())
let defaultPort: number | undefined;
let defaultForceOutputParser: boolean | undefined;

function configure(opts: { port?: number; forceOutputParser?: boolean }): void {
  defaultPort = opts.port;
  defaultForceOutputParser = opts.forceOutputParser;
}

let terminalCounter = 0;
let agentCounter = 0;

type StateChangeCallback = (sessionId: string, state: AgentState) => void;
const stateChangeCallbacks: StateChangeCallback[] = [];

function onStateChange(cb: StateChangeCallback): void {
  stateChangeCallbacks.push(cb);
}

type SessionCreateCallback = (sessionId: string, cwd: string, branchName?: string) => void;
const sessionCreateCallbacks: SessionCreateCallback[] = [];

function onSessionCreate(cb: SessionCreateCallback): void {
  sessionCreateCallbacks.push(cb);
}

function fireSessionCreate(sessionId: string, cwd: string, branchName?: string): void {
  for (const cb of sessionCreateCallbacks) {
    try { cb(sessionId, cwd, branchName); }
    catch (err) { console.error('[sessions] sessionCreate callback error:', err); }
  }
}

type SessionEndCallback = (sessionId: string, cwd: string, branchName?: string) => void;
const sessionEndCallbacks: SessionEndCallback[] = [];

function onSessionEnd(cb: SessionEndCallback): void {
  sessionEndCallbacks.push(cb);
}

function fireSessionEnd(sessionId: string, cwd: string, branchName?: string): void {
  for (const cb of sessionEndCallbacks) {
    try { cb(sessionId, cwd, branchName); }
    catch (err) { console.error('[sessions] sessionEnd callback error:', err); }
  }
}

export function fireStateChange(sessionId: string, state: AgentState): void {
  for (const cb of [...stateChangeCallbacks]) cb(sessionId, state);
}

export function computeBackendState(session: { agentState: AgentState; idle: boolean }): BackendDisplayState {
  // permission-prompt takes highest priority
  if (session.agentState === 'permission-prompt') return 'permission';
  // processing or error = running
  if (session.agentState === 'processing' || session.agentState === 'error') return 'running';
  // initializing
  if (session.agentState === 'initializing') return 'initializing';
  // idle or waiting-for-input = idle (explicitly idle-like agent states)
  if (session.agentState === 'idle' || session.agentState === 'waiting-for-input') return 'idle';
  // For sessions without a recognized agentState (terminal/custom), fall back to idle flag
  return session.idle ? 'idle' : 'running';
}

type BackendStateChangeCallback = (sessionId: string, state: BackendDisplayState) => void;
const backendStateChangeCallbacks: BackendStateChangeCallback[] = [];

export function onBackendStateChange(cb: BackendStateChangeCallback): void {
  backendStateChangeCallbacks.push(cb);
}

export function fireBackendStateIfChanged(session: Session): void {
  const newState = computeBackendState(session);
  if (session._lastEmittedBackendState === newState) return;
  session._lastEmittedBackendState = newState;
  for (const cb of [...backendStateChangeCallbacks]) {
    try { cb(session.id, newState); }
    catch (err) { console.error('[sessions] backendStateChange callback error:', err); }
  }
}

function create({ id: providedId, needsBranchRename, branchRenamePrompt, initialPrompt, agent = 'claude', cols = 80, rows = 24, args = [], port, forceOutputParser, ...rest }: CreateParams): CreateResult {
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
  };

  const { session: ptySession, result } = createPtySession(ptyParams, sessions, stateChangeCallbacks, sessionEndCallbacks, fireBackendStateIfChanged);
  trackEvent({
    category: 'session',
    action: 'created',
    target: id,
    properties: {
      agent,
      type: rest.type ?? 'agent',
      workspace: rest.workspacePath,
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
  fireSessionCreate(id, ptySession.cwd, ptySession.branchName);
  if (initialPrompt) {
    const promptHandler = (changedId: string, state: AgentState) => {
      if (changedId === id && state === 'waiting-for-input' && ptySession.initialPrompt) {
        const prompt = ptySession.initialPrompt;
        ptySession.initialPrompt = undefined; // one-shot
        // Small delay to ensure the agent's input handler is ready
        setTimeout(() => {
          try { ptySession.pty.write(prompt + '\n'); }
          catch (err) { console.error('[sessions] Failed to inject initial prompt:', err); }
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
    .map((s): SessionSummary => ({
      id: s.id,
      type: s.type,
      agent: s.agent,
      mode: s.mode,
      workspacePath: s.workspacePath,
      worktreePath: s.worktreePath,
      cwd: s.cwd,
      repoName: s.repoName,
      branchName: s.branchName,
      displayName: s.displayName,
      createdAt: s.createdAt,
      lastActivity: s.lastActivity,
      idle: s.idle,
      customCommand: s.customCommand,
      useTmux: s.useTmux,
      tmuxSessionName: s.tmuxSessionName,
      status: s.status,
      needsBranchRename: !!s.needsBranchRename,
      agentState: s.agentState,
      currentActivity: s.currentActivity,
    }))
    .sort((a, b) => b.lastActivity.localeCompare(a.lastActivity));
}

function updateDisplayName(id: string, displayName: string): { id: string; displayName: string } {
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
  try {
    session.pty.kill('SIGTERM');
  } catch {
    // PTY may already be dead (e.g. disconnected sessions) — still delete from registry
  }
  if (session.tmuxSessionName) {
    execFile('tmux', ['kill-session', '-t', session.tmuxSessionName], () => {});
  }
  const durationS = Math.round((Date.now() - new Date(session.createdAt).getTime()) / 1000);
  trackEvent({
    category: 'session',
    action: 'ended',
    target: id,
    properties: {
      agent: session.agent,
      type: session.type,
      workspace: session.workspacePath,
      duration_s: durationS,
    },
    session_id: id,
  });
  fireSessionEnd(id, session.cwd, session.branchName);
  sessions.delete(id);
}

function killAllTmuxSessions(): void {
  for (const session of sessions.values()) {
    if (session.tmuxSessionName) {
      execFile('tmux', ['kill-session', '-t', session.tmuxSessionName], () => {});
    }
  }
}

function resize(id: string, cols: number, rows: number): void {
  const session = sessions.get(id);
  if (!session) {
    throw new Error(`Session not found: ${id}`);
  }
  session.pty.resize(cols, rows);
}

function write(id: string, data: string): void {
  const session = sessions.get(id);
  if (!session) {
    throw new Error(`Session not found: ${id}`);
  }
  session.pty.write(data);
}

function nextTerminalName(): string {
  return `Terminal ${++terminalCounter}`;
}

function nextAgentName(): string {
  return `Agent ${++agentCounter}`;
}

function serializeAll(configDir: string): void {
  const scrollbackDirPath = path.join(configDir, 'scrollback');
  fs.mkdirSync(scrollbackDirPath, { recursive: true });

  const serializedPty: SerializedPtySession[] = [];

  for (const session of sessions.values()) {
    // Write scrollback to disk
    const scrollbackPath = path.join(scrollbackDirPath, session.id + '.buf');
    fs.writeFileSync(scrollbackPath, session.scrollback.join(''), 'utf-8');

    serializedPty.push({
      id: session.id,
      type: session.type,
      agent: session.agent,
      workspacePath: session.workspacePath,
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
      claudeArgs: session.claudeArgs,
      hookToken: session.hookToken,
      hooksActive: session.hooksActive,
      ...(session.needsBranchRename ? { needsBranchRename: true as const } : {}),
      ...(session.branchRenamePrompt ? { branchRenamePrompt: session.branchRenamePrompt } : {}),
    });
  }

  const pending: PendingSessionsFile = {
    version: 3,
    timestamp: new Date().toISOString(),
    sessions: serializedPty,
  };

  fs.writeFileSync(path.join(configDir, 'pending-sessions.json'), JSON.stringify(pending, null, 2), 'utf-8');
}

async function restoreFromDisk(configDir: string, workspaces?: string[]): Promise<number> {
  const pendingPath = path.join(configDir, 'pending-sessions.json');
  if (!fs.existsSync(pendingPath)) return 0;

  let pending: PendingSessionsFile;
  try {
    pending = JSON.parse(fs.readFileSync(pendingPath, 'utf-8')) as PendingSessionsFile;
  } catch {
    fs.unlinkSync(pendingPath);
    return 0;
  }

  // Ignore stale files (>5 minutes old)
  if (Date.now() - new Date(pending.timestamp).getTime() > STALE_THRESHOLD_MS) {
    fs.unlinkSync(pendingPath);
    return 0;
  }

  // v2 → v3 migration
  if (pending.version <= 2) {
    for (const s of pending.sessions) {
      const legacy = s as SerializedPtySession & { repoPath?: string; root?: string; worktreeName?: string };
      if (!('cwd' in s) && legacy.repoPath) {
        (s as any).cwd = legacy.repoPath;
      }
      if (!('workspacePath' in s)) {
        // Derive workspacePath: find configured workspace that contains this cwd
        const configuredWorkspaces = workspaces ?? [];
        const cwd = (s as any).cwd ?? legacy.repoPath ?? '';
        const matchedWorkspace = configuredWorkspaces.find(w => cwd === w || cwd.startsWith(w + '/'));
        if (!matchedWorkspace) {
          console.warn(`[sessions] v2→v3 migration: no configured workspace matches cwd "${cwd}", using cwd as workspacePath`);
        }
        (s as any).workspacePath = matchedWorkspace ?? cwd;
      }
      if (!('worktreePath' in s)) {
        const cwd = (s as any).cwd ?? '';
        const workspacePath = (s as any).workspacePath ?? '';
        // If cwd differs from workspacePath, it's a worktree
        (s as any).worktreePath = cwd !== workspacePath ? cwd : null;
      }
      // Map old types to new
      if ((s as any).type === 'repo' || (s as any).type === 'worktree') {
        (s as any).type = 'agent';
      }
      // Clean up legacy fields
      delete legacy.repoPath;
      delete legacy.root;
      delete legacy.worktreeName;
    }
  }

  const scrollbackDirPath = path.join(configDir, 'scrollback');
  let restored = 0;

  // Restore PTY sessions
  for (const s of pending.sessions) {
    // Load scrollback from disk
    let initialScrollback: string[] | undefined;
    const scrollbackPath = path.join(scrollbackDirPath, s.id + '.buf');
    try {
      const data = fs.readFileSync(scrollbackPath, 'utf-8');
      if (data.length > 0) initialScrollback = [data];
    } catch {
      // Missing scrollback is non-fatal
    }

    // Determine spawn command and args
    let command: string | undefined;
    let args: string[] = [];

    if (s.customCommand) {
      // Terminal session — respawn the shell
      command = s.customCommand;
    } else if (s.useTmux && s.tmuxSessionName) {
      // Tmux session — check if tmux session is still alive
      let tmuxAlive = false;
      try {
        await execFileAsync('tmux', ['has-session', '-t', s.tmuxSessionName]);
        tmuxAlive = true;
      } catch {
        // tmux session is gone
      }

      if (tmuxAlive) {
        // Attach to surviving tmux session
        command = 'tmux';
        args = ['-u', 'attach-session', '-t', s.tmuxSessionName];
      } else {
        // Tmux session died — fall back to agent with continue args + preserved flags
        // Continue args first: Codex uses subcommands (resume --last) that must precede flags
        args = [
          ...AGENT_CONTINUE_ARGS[s.agent],
          ...(s.claudeArgs ?? []),
          ...(s.yolo ? AGENT_YOLO_ARGS[s.agent] : []),
        ];
      }
    } else {
      // Non-tmux agent session — respawn with continue args + preserved flags
      // Continue args first: Codex uses subcommands (resume --last) that must precede flags
      args = [
        ...AGENT_CONTINUE_ARGS[s.agent],
        ...(s.claudeArgs ?? []),
        ...(s.yolo ? AGENT_YOLO_ARGS[s.agent] : []),
      ];
    }

    try {
      const createParams: CreateParams = {
        id: s.id,
        type: s.type,
        agent: s.agent,
        repoName: s.repoName,
        workspacePath: s.workspacePath,
        worktreePath: s.worktreePath,
        cwd: s.cwd,
        branchName: s.branchName,
        displayName: s.displayName,
        args,
        useTmux: false, // Don't re-wrap in tmux — either attaching to existing or using plain agent
        tmuxSessionName: s.tmuxSessionName,
        restored: true,
        yolo: s.yolo ?? false,
        claudeArgs: s.claudeArgs ?? [],
        hookToken: s.hookToken,
        hooksActive: s.hooksActive,
        ...(s.needsBranchRename ? { needsBranchRename: true as const } : {}),
        ...(s.branchRenamePrompt ? { branchRenamePrompt: s.branchRenamePrompt } : {}),
      };
      if (command) createParams.command = command;
      if (initialScrollback) createParams.initialScrollback = initialScrollback;
      create(createParams);
      restored++;
    } catch (err) {
      console.error(`Failed to restore session ${s.id} (${s.displayName})`, err);
    }

    // Clean up scrollback file
    try { fs.unlinkSync(scrollbackPath); } catch { /* ignore */ }
  }

  // Clean up
  try { fs.unlinkSync(pendingPath); } catch { /* ignore */ }
  try { fs.rmdirSync(path.join(configDir, 'scrollback')); } catch { /* ignore — may not be empty */ }

  // Sync counters to avoid duplicate display names after restore
  for (const s of sessions.values()) {
    const agentMatch = s.displayName?.match(/^Agent (\d+)$/);
    if (agentMatch) agentCounter = Math.max(agentCounter, parseInt(agentMatch[1]!, 10));
    const termMatch = s.displayName?.match(/^Terminal (\d+)$/);
    if (termMatch) terminalCounter = Math.max(terminalCounter, parseInt(termMatch[1]!, 10));
  }

  return restored;
}

/** Returns the set of tmux session names currently owned by restored sessions */
function activeTmuxSessionNames(): Set<string> {
  const names = new Set<string>();
  for (const session of sessions.values()) {
    if (session.tmuxSessionName) names.add(session.tmuxSessionName);
  }
  return names;
}

async function fetchMetaForSession(session: SessionSummary): Promise<SessionMeta> {
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
    } catch { /* gh CLI unavailable */ }
  }

  // Fallback to working tree diff if no PR data
  if (additions === 0 && deletions === 0) {
    const diff = await getWorkingTreeDiff(repoPath);
    additions = diff.additions;
    deletions = diff.deletions;
  }

  return { prNumber, additions, deletions, fetchedAt: new Date().toISOString() };
}

async function getSessionMeta(id: string, refresh = false): Promise<SessionMeta | null> {
  if (!refresh && metaCache.has(id)) return metaCache.get(id)!;

  const session = sessions.get(id);
  if (!session) return metaCache.get(id) ?? null;

  const summary = list().find(s => s.id === id);
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
    }),
  );
}

export { configure, create, get, list, kill, killAllTmuxSessions, resize, updateDisplayName, write, onStateChange, onSessionCreate, onSessionEnd, nextTerminalName, nextAgentName, serializeAll, restoreFromDisk, activeTmuxSessionNames, getSessionMeta, getAllSessionMeta, populateMetaCache, AGENT_COMMANDS, AGENT_CONTINUE_ARGS, AGENT_YOLO_ARGS };
