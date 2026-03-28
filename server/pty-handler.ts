import pty from 'node-pty';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentType, AgentState, PtySession, SessionStatus, SessionSummary, SessionType } from './types.js';
import { AGENT_COMMANDS, AGENT_CONTINUE_ARGS } from './types.js';
import { readMeta, writeMeta } from './config.js';
import { cleanEnv } from './utils.js';
import { outputParsers } from './output-parsers/index.js';

const IDLE_TIMEOUT_MS = 5000;
const MAX_SCROLLBACK = 256 * 1024; // 256KB max

export function getTmuxPrefix(): string {
  return process.env.NO_PIN === '1' ? 'crcd-' : 'crc-';
}

export function generateTmuxSessionName(displayName: string, id: string): string {
  const sanitized = displayName.replace(/[^a-zA-Z0-9-]/g, '-').replace(/-+/g, '-').slice(0, 30);
  return `${getTmuxPrefix()}${sanitized}-${id.slice(0, 8)}`;
}

export function resolveTmuxSpawn(
  command: string,
  args: string[],
  tmuxSessionName: string,
): { command: string; args: string[] } {
  return {
    command: 'tmux',
    args: [
      '-u', 'new-session', '-s', tmuxSessionName, '--', command, ...args,
      ';', 'set', 'set-clipboard', 'on',
      ';', 'set', 'allow-passthrough', 'on',
      ';', 'set', 'mode-keys', 'vi',
    ],
  };
}

function writeHooksSettingsFile(sessionId: string, port: number, token: string): string {
  const dir = path.join(os.tmpdir(), 'claude-remote-cli', sessionId);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const filePath = path.join(dir, 'hooks-settings.json');
  const base = `http://127.0.0.1:${port}`;
  const q = `sessionId=${sessionId}&token=${token}`;
  const settings = {
    hooks: {
      Stop: [{ hooks: [{ type: 'http', url: `${base}/hooks/stop?${q}`, timeout: 5 }] }],
      Notification: [
        { matcher: 'permission_prompt', hooks: [{ type: 'http', url: `${base}/hooks/notification?${q}&type=permission_prompt`, timeout: 5 }] },
        { matcher: 'idle_prompt', hooks: [{ type: 'http', url: `${base}/hooks/notification?${q}&type=idle_prompt`, timeout: 5 }] },
      ],
      UserPromptSubmit: [{ hooks: [{ type: 'http', url: `${base}/hooks/prompt-submit?${q}`, timeout: 5 }] }],
      SessionEnd: [{ hooks: [{ type: 'http', url: `${base}/hooks/session-end?${q}`, timeout: 5 }] }],
      PreToolUse: [{ hooks: [{ type: 'http', url: `${base}/hooks/tool-use?${q}`, timeout: 5 }] }],
      PostToolUse: [{ hooks: [{ type: 'http', url: `${base}/hooks/tool-result?${q}`, timeout: 5 }] }],
    },
  };
  fs.writeFileSync(filePath, JSON.stringify(settings, null, 2), 'utf-8');
  fs.chmodSync(filePath, 0o600);
  return filePath;
}

export type CreatePtyParams = {
  id: string;
  type?: SessionType | undefined;
  agent?: AgentType | undefined;
  repoName?: string | undefined;
  workspacePath: string;
  worktreePath?: string | null | undefined;
  cwd: string;
  branchName?: string | undefined;
  displayName?: string | undefined;
  command?: string | undefined;
  args?: string[] | undefined;
  cols?: number | undefined;
  rows?: number | undefined;
  configPath?: string | undefined;
  useTmux?: boolean | undefined;
  tmuxSessionName?: string | undefined;
  initialScrollback?: string[] | undefined;
  restored?: boolean | undefined;
  port?: number | undefined;
  forceOutputParser?: boolean | undefined;
  yolo?: boolean | undefined;
  claudeArgs?: string[] | undefined;
  hookToken?: string | undefined;
  hooksActive?: boolean | undefined;
};

export type CreatePtyResult = SessionSummary & { pid: number | undefined };

export function createPtySession(
  params: CreatePtyParams,
  sessionsMap: Map<string, import('./types.js').Session>,
  stateChangeCallbacks: Array<(sessionId: string, state: AgentState) => void> = [],
  sessionEndCallbacks: Array<(sessionId: string, cwd: string, branchName?: string) => void> = [],
  fireBackendStateIfChanged?: (session: import('./types.js').Session) => void,
): { session: PtySession; result: CreatePtyResult } {
  const {
    id,
    type,
    agent = 'claude',
    repoName,
    workspacePath,
    worktreePath = null,
    cwd,
    branchName,
    displayName,
    command,
    args: rawArgs = [],
    cols = 80,
    rows = 24,
    configPath,
    useTmux: paramUseTmux,
    tmuxSessionName: paramTmuxSessionName,
    initialScrollback,
    restored: paramRestored,
    port,
    forceOutputParser,
    yolo: paramYolo,
    claudeArgs: paramClaudeArgs,
    hookToken: paramHookToken,
    hooksActive: paramHooksActive,
  } = params;

  let args = rawArgs;
  const createdAt = new Date().toISOString();
  const resolvedCommand = command || AGENT_COMMANDS[agent];

  const env = cleanEnv();

  // Inject hooks settings when spawning a real claude agent (not custom command, not forceOutputParser).
  // For restored sessions whose tmux died, reuse the preserved token but re-create the settings
  // file on disk — the new Claude process needs --settings even though the token is the same.
  // For surviving tmux sessions (command='tmux'), shouldInjectHooks is false — the old Claude
  // instance already has its settings file, and we just need the token for server-side validation.
  let hookToken = paramHookToken ?? '';
  let hooksActive = paramHooksActive ?? false;
  let settingsPath = '';
  const shouldInjectHooks = agent === 'claude' && !command && !forceOutputParser && port !== undefined;
  if (shouldInjectHooks) {
    if (!hookToken) {
      hookToken = crypto.randomBytes(32).toString('hex');
    }
    try {
      settingsPath = writeHooksSettingsFile(id, port, hookToken);
      args = ['--settings', settingsPath, ...args];
      hooksActive = true;
    } catch (err) {
      console.warn(`[pty-handler] Failed to generate hooks settings for session ${id}:`, err);
      hooksActive = false;
      hookToken = '';
    }
  }

  const useTmux = !command && !!paramUseTmux;
  let spawnCommand = resolvedCommand;
  let spawnArgs = args;
  const tmuxSessionName = paramTmuxSessionName || (useTmux ? generateTmuxSessionName(displayName || repoName || path.basename(cwd) || 'session', id) : '');

  if (useTmux) {
    const tmux = resolveTmuxSpawn(resolvedCommand, args, tmuxSessionName);
    spawnCommand = tmux.command;
    spawnArgs = tmux.args;
  }

  const ptyProcess = pty.spawn(spawnCommand, spawnArgs, {
    name: 'xterm-256color',
    cols,
    rows,
    cwd,
    env,
  });

  // Scrollback buffer: stores all PTY output so we can replay on WebSocket (re)connect
  const scrollback: string[] = initialScrollback ? [...initialScrollback] : [];
  let scrollbackBytes = initialScrollback ? initialScrollback.reduce((sum, s) => sum + s.length, 0) : 0;

  // Instantiate vendor-specific output parser (terminal/custom-command sessions get no parser)
  const parser = command ? outputParsers['claude']() : outputParsers[agent]();
  const session: PtySession = {
    id,
    type: type || 'agent',
    agent,
    mode: 'pty' as const,
    workspacePath: workspacePath || '',
    worktreePath: worktreePath ?? null,
    repoName: repoName || '',
    branchName: branchName || '',
    displayName: displayName || repoName || path.basename(cwd) || '',
    pty: ptyProcess,
    createdAt,
    lastActivity: createdAt,
    scrollback,
    idle: false,
    cwd,
    customCommand: command || null,
    useTmux,
    tmuxSessionName,
    onPtyReplacedCallbacks: [],
    status: 'active' as SessionStatus,
    restored: paramRestored || false,
    needsBranchRename: false,
    agentState: 'initializing',
    outputParser: parser,
    hookToken,
    hooksActive,
    cleanedUp: false,
    yolo: paramYolo ?? false,
    claudeArgs: paramClaudeArgs ?? [],
    _lastHookTime: undefined,
  };
  sessionsMap.set(id, session);

  // Load existing metadata to preserve a previously-set displayName
  if (configPath && worktreePath) {
    const existing = readMeta(configPath, worktreePath);
    if (existing && existing.displayName) {
      session.displayName = existing.displayName;
    }
    writeMeta(configPath, { worktreePath, displayName: session.displayName, lastActivity: createdAt });
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

  const continueArgs = AGENT_CONTINUE_ARGS[agent];

  function attachHandlers(proc: pty.IPty, canRetry: boolean): void {
    const spawnTime = Date.now();
    // Clear restored flag after 3s of running — means the PTY is healthy
    const restoredClearTimer = session.restored ? setTimeout(() => { session.restored = false; }, 3000) : null;

    proc.onData((data) => {
      session.lastActivity = new Date().toISOString();
      resetIdleTimer();
      scrollback.push(data);
      scrollbackBytes += data.length;
      // Trim oldest entries if over limit
      while (scrollbackBytes > MAX_SCROLLBACK && scrollback.length > 1) {
        scrollbackBytes -= (scrollback.shift() as string).length;
      }
      if (configPath && worktreePath && !metaFlushTimer) {
        metaFlushTimer = setTimeout(() => {
          metaFlushTimer = null;
          writeMeta(configPath, { worktreePath, displayName: session.displayName, lastActivity: session.lastActivity });
        }, 5000);
      }

      // Vendor-specific output parsing for semantic state detection
      const parseResult = session.outputParser.onData(data, scrollback.slice(-20));
      if (parseResult && parseResult.state !== session.agentState) {
        if (session.hooksActive) {
          // Hooks are authoritative — check 30s reconciliation timeout
          const lastHook = session._lastHookTime;
          const sessionAge = Date.now() - new Date(session.createdAt).getTime();
          if (lastHook && Date.now() - lastHook > 30000) {
            // No hook for 30s and parser disagrees — parser overrides
            session.agentState = parseResult.state;
            for (const cb of stateChangeCallbacks) cb(session.id, parseResult.state);
            fireBackendStateIfChanged?.(session);
          } else if (!lastHook && sessionAge > 30000) {
            // Hooks active but never fired in 30s — allow parser to override to prevent permanent suppression
            session.agentState = parseResult.state;
            for (const cb of stateChangeCallbacks) cb(session.id, parseResult.state);
            fireBackendStateIfChanged?.(session);
          }
          // else: suppress parser — hooks are still fresh
        } else {
          // No hooks — parser is primary (current behavior)
          session.agentState = parseResult.state;
          for (const cb of stateChangeCallbacks) cb(session.id, parseResult.state);
          fireBackendStateIfChanged?.(session);
        }
      }
    });

    proc.onExit(() => {
      if (canRetry && (Date.now() - spawnTime) < 3000) {
        let retryArgs = rawArgs.filter(a => !continueArgs.includes(a));
        // Re-inject hooks settings if active (settingsPath captured from outer scope)
        if (session.hooksActive && settingsPath) {
          retryArgs = ['--settings', settingsPath, ...retryArgs];
        }
        const retryNotice = '\r\n[claude-remote-cli] --continue not available; starting new session...\r\n';
        scrollback.length = 0;
        scrollbackBytes = 0;
        scrollback.push(retryNotice);
        scrollbackBytes = retryNotice.length;
        let retryCommand = resolvedCommand;
        let retrySpawnArgs = retryArgs;
        if (useTmux && tmuxSessionName) {
          const retryTmuxName = tmuxSessionName + '-retry';
          session.tmuxSessionName = retryTmuxName;
          const tmux = resolveTmuxSpawn(resolvedCommand, retryArgs, retryTmuxName);
          retryCommand = tmux.command;
          retrySpawnArgs = tmux.args;
        }
        let retryPty: pty.IPty;
        try {
          retryPty = pty.spawn(retryCommand, retrySpawnArgs, {
            name: 'xterm-256color',
            cols,
            rows,
            cwd,
            env,
          });
        } catch {
          // Retry spawn failed — fall through to normal exit cleanup
          if (restoredClearTimer) clearTimeout(restoredClearTimer);
          if (idleTimer) clearTimeout(idleTimer);
          if (metaFlushTimer) clearTimeout(metaFlushTimer);
          sessionsMap.delete(id);
          return;
        }
        session.pty = retryPty;
        for (const cb of session.onPtyReplacedCallbacks) cb(retryPty);
        attachHandlers(retryPty, false);
        return;
      }

      if (session.cleanedUp) return; // Dedup: SessionEnd hook already cleaned up
      session.cleanedUp = true;

      if (restoredClearTimer) clearTimeout(restoredClearTimer);

      // If PTY exited and this is a restored session, mark disconnected rather than delete
      if (session.restored) {
        session.status = 'disconnected';
        session.restored = false; // clear so user-initiated kills can delete normally
        if (idleTimer) clearTimeout(idleTimer);
        if (metaFlushTimer) clearTimeout(metaFlushTimer);
        return;
      }

      if (idleTimer) clearTimeout(idleTimer);
      if (metaFlushTimer) clearTimeout(metaFlushTimer);
      if (configPath && worktreePath) {
        writeMeta(configPath, { worktreePath, displayName: session.displayName, lastActivity: session.lastActivity });
      }
      for (const cb of sessionEndCallbacks) {
        try { cb(id, cwd, session.branchName); }
        catch (err) { console.error('[pty-handler] sessionEnd callback error:', err); }
      }
      sessionsMap.delete(id);
      const tmpDir = path.join(os.tmpdir(), 'claude-remote-cli', id);
      fs.rm(tmpDir, { recursive: true, force: true }, () => {});
    });
  }

  attachHandlers(ptyProcess, continueArgs.some(a => args.includes(a)));

  const result: CreatePtyResult = {
    id,
    type: session.type,
    agent: session.agent,
    mode: 'pty' as const,
    workspacePath: session.workspacePath,
    worktreePath: session.worktreePath,
    repoName: session.repoName,
    branchName: session.branchName,
    displayName: session.displayName,
    pid: ptyProcess.pid,
    createdAt,
    lastActivity: createdAt,
    idle: false,
    cwd,
    customCommand: command || null,
    useTmux,
    tmuxSessionName,
    status: 'active' as SessionStatus,
    needsBranchRename: false,
    agentState: 'initializing',
  };

  return { session, result };
}
