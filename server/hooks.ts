import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { Router } from 'express';
import express from 'express';
import type { Request, Response } from 'express';

import type { Session } from './types.js';
import type { AgentState } from './output-parsers/index.js';
import { stripAnsi, cleanEnv } from './utils.js';
import { branchToDisplayName } from './git.js';
import { writeMeta } from './config.js';
import { recordSessionEvent } from './analytics.js';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LOCALHOST_ADDRS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const DEFAULT_RENAME_PROMPT =
  'Output ONLY a short kebab-case git branch name (no explanation, no backticks, no prefix, just the name) that describes this task:';
const RENAME_RETRY_DELAY_MS = 5000;
const BRANCH_CHECK_DEBOUNCE_MS = 1000;

// ---------------------------------------------------------------------------
// Deps type
// ---------------------------------------------------------------------------

export interface HookDeps {
  getSession: (id: string) => Session | undefined;
  broadcastEvent: (type: string, data?: Record<string, unknown>) => void;
  fireBackendStateIfChanged: (session: Session) => void;
  notifySessionAttention: (sessionId: string, session: { displayName: string; type: string }) => void;
  configPath?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Branch change detection — debounced per-session check via git
// ---------------------------------------------------------------------------

const branchCheckTimers = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Schedule a debounced git branch check for a session. If the branch changed
 * since the last known value, update the session and broadcast session-renamed.
 * Uses trailing-edge debounce: each call resets the timer so the check runs
 * after activity settles.
 */
function scheduleBranchCheck(session: Session, deps: HookDeps, delayMs = BRANCH_CHECK_DEBOUNCE_MS): void {
  if (!session.cwd) return;
  const existing = branchCheckTimers.get(session.id);
  if (existing) clearTimeout(existing);

  branchCheckTimers.set(session.id, setTimeout(async () => {
    branchCheckTimers.delete(session.id);
    if (!deps.getSession(session.id)) return; // session may have ended
    try {
      const { stdout } = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
        cwd: session.cwd,
        timeout: 5000,
      });
      const currentBranch = stdout.trim();
      if (currentBranch && currentBranch !== session.branchName) {
        session.branchName = currentBranch;
        deps.broadcastEvent('session-renamed', {
          sessionId: session.id,
          branchName: currentBranch,
          displayName: session.displayName,
        });
      }
    } catch { /* non-fatal — repo may be mid-rebase or detached */ }
  }, delayMs));
}

function setAgentState(session: Session, state: AgentState, deps: HookDeps): void {
  session.agentState = state;
  deps.fireBackendStateIfChanged(session);
  session._lastHookTime = Date.now();

  // Check for branch changes on meaningful pauses (agent stopped or waiting for user)
  if (state === 'idle' || state === 'permission-prompt' || state === 'waiting-for-input') {
    scheduleBranchCheck(session, deps, 0);
  }
}

function extractToolDetail(_toolName: string, toolInput: unknown): string | undefined {
  if (toolInput && typeof toolInput === 'object') {
    const input = toolInput as Record<string, unknown>;
    if (typeof input.file_path === 'string') return input.file_path;
    if (typeof input.path === 'string') return input.path;
    if (typeof input.command === 'string') return input.command.slice(0, 80);
  }
  return undefined;
}

async function spawnBranchRename(
  session: Session,
  promptText: string,
  deps: HookDeps,
): Promise<void> {
  const cleanedPrompt = stripAnsi(promptText).slice(0, 500);
  const renamePrompt = session.branchRenamePrompt ?? DEFAULT_RENAME_PROMPT;
  const fullPrompt = renamePrompt + '\n\n' + cleanedPrompt;
  const env = cleanEnv();

  for (let attempt = 0; attempt < 2; attempt++) {
    // Check session still exists before attempting
    if (!deps.getSession(session.id)) return;

    if (attempt > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, RENAME_RETRY_DELAY_MS));
      // Re-check after delay
      if (!deps.getSession(session.id)) return;
    }

    try {
      const { stdout } = await execFileAsync(
        'claude',
        ['-p', '--model', 'haiku', fullPrompt],
        { cwd: session.cwd, timeout: 30000, env },
      );

      // Sanitize output
      let branchName = stdout
        .replace(/`/g, '')
        .replace(/[^a-zA-Z0-9-]/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-+|-+$/g, '')
        .toLowerCase()
        .slice(0, 60);

      if (!branchName) continue;

      // Check session still exists before renaming
      if (!deps.getSession(session.id)) return;

      await execFileAsync('git', ['branch', '-m', branchName], { cwd: session.cwd });

      session.branchName = branchName;
      session.displayName = branchToDisplayName(branchName);
      deps.broadcastEvent('session-renamed', {
        sessionId: session.id,
        branchName: session.branchName,
        displayName: session.displayName,
      });

      if (deps.configPath) {
        writeMeta(deps.configPath, {
          worktreePath: session.cwd,
          displayName: session.displayName,
          lastActivity: session.lastActivity,
          branchName: session.branchName,
        });
      }

      return; // success
    } catch (err) {
      if (attempt === 1) {
        console.error('[hooks] branch rename failed after 2 attempts:', err);
        session.needsBranchRename = true;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createHooksRouter(deps: HookDeps): Router {
  const router = Router();

  // Middleware: IP allowlist — only localhost, do NOT trust X-Forwarded-For
  router.use((req: Request, res: Response, next) => {
    const remoteAddr = req.socket.remoteAddress;
    if (!remoteAddr || !LOCALHOST_ADDRS.has(remoteAddr)) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }
    next();
  });

  // Middleware: parse JSON with generous limit for PostToolUse payloads
  router.use(express.json({ limit: '5mb' }));

  // Middleware: token verification
  router.use((req: Request, res: Response, next) => {
    const sessionId = req.query.sessionId;
    const token = req.query.token;

    if (typeof sessionId !== 'string' || !sessionId) {
      res.status(400).json({ error: 'Missing sessionId' });
      return;
    }
    if (typeof token !== 'string' || !token) {
      res.status(400).json({ error: 'Missing token' });
      return;
    }

    const session = deps.getSession(sessionId);
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    const tokenBuf = Buffer.from(token);
    const hookTokenBuf = Buffer.from(session.hookToken);
    if (tokenBuf.length !== hookTokenBuf.length || !crypto.timingSafeEqual(tokenBuf, hookTokenBuf)) {
      res.status(403).json({ error: 'Invalid token' });
      return;
    }

    (req as unknown as Record<string, unknown>)._hookSession = session;
    next();
  });

  // ---------------------------------------------------------------------------
  // Route handlers
  // ---------------------------------------------------------------------------

  // POST /stop → idle
  router.post('/stop', (req: Request, res: Response) => {
    const session = (req as unknown as Record<string, unknown>)._hookSession as Session;
    setAgentState(session, 'idle', deps);
    recordSessionEvent({
      session_id: session.id,
      repo_path: session.repoPath,
      event_type: 'agent_stop',
      timestamp: new Date().toISOString(),
    });
    res.json({ ok: true });
  });

  // POST /notification → permission-prompt | waiting-for-input
  router.post('/notification', (req: Request, res: Response) => {
    const session = (req as unknown as Record<string, unknown>)._hookSession as Session;
    const type = req.query.type;

    if (type === 'permission_prompt') {
      setAgentState(session, 'permission-prompt', deps);
      session.lastAttentionNotifiedAt = Date.now();
      deps.notifySessionAttention(session.id, { displayName: session.displayName, type: session.type });
    } else if (type === 'idle_prompt') {
      setAgentState(session, 'waiting-for-input', deps);
      session.lastAttentionNotifiedAt = Date.now();
      deps.notifySessionAttention(session.id, { displayName: session.displayName, type: session.type });
    }

    recordSessionEvent({
      session_id: session.id,
      repo_path: session.repoPath,
      event_type: 'notification',
      event_data: { notificationType: type as string },
      timestamp: new Date().toISOString(),
    });
    res.json({ ok: true });
  });

  // POST /prompt-submit → processing (+ optional branch rename on first message)
  router.post('/prompt-submit', (req: Request, res: Response) => {
    const session = (req as unknown as Record<string, unknown>)._hookSession as Session;
    setAgentState(session, 'processing', deps);

    recordSessionEvent({
      session_id: session.id,
      repo_path: session.repoPath,
      event_type: 'user_prompt',
      timestamp: new Date().toISOString(),
    });

    if (session.needsBranchRename === true) {
      session.needsBranchRename = false;
      const promptText: string = typeof req.body?.prompt === 'string' ? req.body.prompt : '';
      spawnBranchRename(session, promptText, deps).catch((err) => {
        console.error('[hooks] spawnBranchRename error:', err);
      });
    }

    res.json({ ok: true });
  });

  // POST /session-end → acknowledge hook (PTY onExit owns actual cleanup and cleanedUp flag)
  router.post('/session-end', (req: Request, res: Response) => {
    const session = (req as unknown as Record<string, unknown>)._hookSession as Session;
    recordSessionEvent({
      session_id: session.id,
      repo_path: session.repoPath,
      event_type: 'session_end',
      timestamp: new Date().toISOString(),
    });
    // Acknowledge hook — PTY onExit owns actual cleanup and cleanedUp flag
    res.json({ ok: true });
  });

  // POST /tool-use → set currentActivity
  router.post('/tool-use', (req: Request, res: Response) => {
    const session = (req as unknown as Record<string, unknown>)._hookSession as Session;
    const body = req.body as Record<string, unknown> | undefined;
    const toolName = typeof body?.tool_name === 'string' ? body.tool_name : '';
    const toolInput = body?.tool_input;
    const detail = extractToolDetail(toolName, toolInput);
    session.currentActivity = detail !== undefined ? { tool: toolName, detail } : { tool: toolName };
    deps.broadcastEvent('session-activity-changed', { sessionId: session.id });
    recordSessionEvent({
      session_id: session.id,
      repo_path: session.repoPath,
      event_type: 'tool_use',
      event_data: { tool: toolName, target: detail },
      timestamp: new Date().toISOString(),
    });
    res.json({ ok: true });
  });

  // POST /tool-result → clear currentActivity + debounced branch check
  router.post('/tool-result', (req: Request, res: Response) => {
    const session = (req as unknown as Record<string, unknown>)._hookSession as Session;
    session.currentActivity = undefined;
    deps.broadcastEvent('session-activity-changed', { sessionId: session.id });
    recordSessionEvent({
      session_id: session.id,
      repo_path: session.repoPath,
      event_type: 'tool_complete',
      timestamp: new Date().toISOString(),
    });
    // Debounced branch check — catches git checkout/switch during tool execution
    scheduleBranchCheck(session, deps);
    res.json({ ok: true });
  });

  return router;
}
