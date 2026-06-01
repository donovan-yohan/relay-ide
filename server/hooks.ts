import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { Router } from 'express';
import express from 'express';
import type { Request, Response } from 'express';

import type { Session, RenamerTool } from './types.js';
import type { AgentState } from './output-parsers/index.js';
import { stripAnsi } from './utils.js';
import { writeMeta } from './config.js';
import { recordSessionEvent } from './analytics.js';
import {
  buildSessionEvent,
  hasConcreteRepoBinding,
} from './session-attribution.js';
import { forwardHookEvent } from './telemetry.js';
import { createLogger } from './logger.js';
import {
  resolveSessionRename,
  type RenamerConfig,
} from './session-rename-resolver.js';

const execFileAsync = promisify(execFile);
const logger = createLogger('hooks');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LOCALHOST_ADDRS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const AGENT_STATE_PERMISSION_PROMPT = 'permission-prompt';
const BRANCH_CHECK_DEBOUNCE_MS = 1000;

// ---------------------------------------------------------------------------
// Deps type
// ---------------------------------------------------------------------------

export interface HookDeps {
  getSession: (id: string) => Session | undefined;
  broadcastEvent: (type: string, data?: Record<string, unknown>) => void;
  fireBackendStateIfChanged: (session: Session) => void;
  notifySessionAttention: (
    sessionId: string,
    session: { displayName: string; type: string }
  ) => void;
  configPath?: string;
  executeBranchRename?: (session: Session, promptText: string) => Promise<void>;
  /** Which renamer tool to use for the agent-suggested-name branch. Defaults to 'claude'. */
  renamerTool?: RenamerTool | undefined;
  /** Absolute path to custom renamer script when renamerTool === 'custom-script'. */
  renamerCustomScript?: string | undefined;
}

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
function scheduleBranchCheck(
  session: Session,
  deps: HookDeps,
  delayMs = BRANCH_CHECK_DEBOUNCE_MS
): void {
  if (!hasConcreteRepoBinding(session)) return;
  const existing = branchCheckTimers.get(session.id);
  if (existing) clearTimeout(existing);

  branchCheckTimers.set(
    session.id,
    setTimeout(async () => {
      branchCheckTimers.delete(session.id);
      if (!deps.getSession(session.id)) return; // session may have ended
      try {
        const { stdout } = await execFileAsync(
          'git',
          ['rev-parse', '--abbrev-ref', 'HEAD'],
          {
            cwd: session.cwd,
            timeout: 5000,
          }
        );
        const currentBranch = stdout.trim();
        if (currentBranch && currentBranch !== session.branchName) {
          session.branchName = currentBranch;
          deps.broadcastEvent('session-renamed', {
            sessionId: session.id,
            branchName: currentBranch,
            displayName: session.displayName,
          });
        }
      } catch {
        /* non-fatal — repo may be mid-rebase or detached */
      }
    }, delayMs)
  );
}

function setAgentState(
  session: Session,
  state: AgentState,
  deps: HookDeps
): void {
  if (state !== AGENT_STATE_PERMISSION_PROMPT) {
    delete session.permissionType;
    delete session.permissionPromptSource;
  }
  session.agentState = state;
  deps.fireBackendStateIfChanged(session);
  if (session.mode === 'pty') {
    session._lastHookTime = Date.now();
  }

  // Check for branch changes on meaningful pauses (agent stopped or waiting for user)
  if (
    state === 'idle' ||
    state === AGENT_STATE_PERMISSION_PROMPT ||
    state === 'waiting-for-input'
  ) {
    scheduleBranchCheck(session, deps, 0);
  }
}

function handleAgentEvent(
  session: Session,
  sessionId: string,
  eventType: string,
  data: Record<string, unknown> | undefined,
  deps: HookDeps
): void {
  // Map certain event types to agent state changes
  if (eventType === 'session.started') {
    setAgentState(session, 'processing', deps);
  } else if (eventType === 'session.idle' || eventType === 'session.ended') {
    setAgentState(session, 'idle', deps);
  } else if (eventType === 'permission.requested') {
    session.permissionType = 'approval';
    session.permissionPromptSource = 'hooks';
    setAgentState(session, AGENT_STATE_PERMISSION_PROMPT, deps);
    session.lastAttentionNotifiedAt = Date.now();
    deps.notifySessionAttention(session.id, {
      displayName: session.displayName,
      type: session.type,
    });
  } else if (eventType === 'tool.started') {
    setAgentState(session, 'processing', deps);
    if (data?.tool) {
      session.currentActivity = { tool: String(data.tool) };
    }
  } else if (eventType === 'tool.finished') {
    session.currentActivity = undefined;
  } else if (eventType === 'prompt.submitted') {
    setAgentState(session, 'processing', deps);
  } else if (eventType === 'state.changed') {
    // Generic state change from output parser or opencode status events
    // Only map recognized states
    const status = data?.status;
    if (status === 'error') setAgentState(session, 'error', deps);
  }
}

function createAgentEventHandler(deps: HookDeps) {
  return (req: Request, res: Response): void => {
    const { sessionId, token, eventType, data, timestamp } = req.body as {
      sessionId?: string;
      token?: string;
      eventType?: string;
      data?: Record<string, unknown>;
      timestamp?: string;
    };

    if (!sessionId || !token || !eventType) {
      res.status(400).json({
        error: 'Missing required fields: sessionId, token, eventType',
      });
      return;
    }

    // Find the session and validate token
    const session = deps.getSession(sessionId);
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    const tokenBuf = Buffer.from(token);
    const hookTokenBuf = Buffer.from(session.hookToken);
    if (
      tokenBuf.length !== hookTokenBuf.length ||
      !crypto.timingSafeEqual(tokenBuf, hookTokenBuf)
    ) {
      res.status(401).json({ error: 'Invalid token' });
      return;
    }

    // Record the event for analytics
    recordSessionEvent(
      buildSessionEvent(session, {
        eventType,
        ...(data !== undefined && { eventData: data }),
        timestamp: timestamp || new Date().toISOString(),
      })
    );

    // Forward to telemetry adapter (e.g. Codex adapter uses this for transcript_path)
    if (data) {
      forwardHookEvent(sessionId, eventType, data);
    }

    handleAgentEvent(session, sessionId, eventType, data, deps);

    res.status(204).end();
  };
}

function extractToolDetail(
  _toolName: string,
  toolInput: unknown
): string | undefined {
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
  deps: HookDeps
): Promise<void> {
  // When the user has explicitly disabled AI naming, do not rename at all.
  // The heuristic fallback is also skipped — 'none' means "no renaming from
  // this hook path". The branch stays as the mountain-name placeholder.
  if ((deps.renamerTool ?? 'claude') === 'none') {
    logger.debug(
      '[rename] renamerTool=none — skipping rename for session %s',
      session.id
    );
    return;
  }

  const renamerConfig: RenamerConfig = {
    tool: deps.renamerTool ?? 'claude',
    customScript: deps.renamerCustomScript,
  };

  const input = {
    promptText: stripAnsi(promptText),
    cwd: session.cwd,
    customRenamePrompt:
      session.mode === 'pty' ? session.branchRenamePrompt : undefined,
    repoName: session.repoName,
    branchName: session.branchName,
    createdAt: session.createdAt,
  };

  // Check session still exists before attempting
  if (!deps.getSession(session.id)) return;

  try {
    const resolved = await resolveSessionRename(
      undefined, // userSetName — not applicable here; hooks path has no explicit user name
      undefined, // pinnedName  — meta lookup happens at session-create time; hooks path uses resolver for agent-suggested tier only
      input,
      renamerConfig
    );

    // Check session still exists before renaming
    if (!deps.getSession(session.id)) return;

    await execFileAsync('git', ['branch', '-m', resolved.branchName], {
      cwd: session.cwd,
    });

    session.branchName = resolved.branchName;
    session.displayName = resolved.displayName;
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
  } catch (err) {
    // The resolver always returns a result (agent failures fall through to
    // heuristic/default), so this catch only fires when `git branch -m` itself
    // fails (e.g. detached HEAD, read-only fs).  Mark needsBranchRename so a
    // later hook or restart can retry.
    logger.error('git branch rename failed:', err);
    session.needsBranchRename = true;
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

  // POST /agent-event — receives relay events from opencode plugin and codex hooks adapter.
  // Registered BEFORE the query-param token middleware because it takes sessionId/token from body.
  router.post('/agent-event', createAgentEventHandler(deps));

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
    if (
      tokenBuf.length !== hookTokenBuf.length ||
      !crypto.timingSafeEqual(tokenBuf, hookTokenBuf)
    ) {
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
    const session = (req as unknown as Record<string, unknown>)
      ._hookSession as Session;
    setAgentState(session, 'idle', deps);
    recordSessionEvent(buildSessionEvent(session, { eventType: 'agent_stop' }));
    res.json({ ok: true });
  });

  // POST /notification → permission-prompt | waiting-for-input
  router.post('/notification', (req: Request, res: Response) => {
    const session = (req as unknown as Record<string, unknown>)
      ._hookSession as Session;
    const type = req.query.type;

    if (type === 'permission_prompt') {
      session.permissionType = 'approval';
      session.permissionPromptSource = 'hooks';
      setAgentState(session, AGENT_STATE_PERMISSION_PROMPT, deps);
      session.lastAttentionNotifiedAt = Date.now();
      deps.notifySessionAttention(session.id, {
        displayName: session.displayName,
        type: session.type,
      });
    } else if (type === 'idle_prompt') {
      setAgentState(session, 'waiting-for-input', deps);
      session.lastAttentionNotifiedAt = Date.now();
      deps.notifySessionAttention(session.id, {
        displayName: session.displayName,
        type: session.type,
      });
    }

    recordSessionEvent(
      buildSessionEvent(session, {
        eventType: 'notification',
        eventData: { notificationType: type as string },
      })
    );
    res.json({ ok: true });
  });

  // POST /prompt-submit → processing (+ optional branch rename on first message)
  router.post('/prompt-submit', (req: Request, res: Response) => {
    const session = (req as unknown as Record<string, unknown>)
      ._hookSession as Session;
    setAgentState(session, 'processing', deps);

    recordSessionEvent(
      buildSessionEvent(session, { eventType: 'user_prompt' })
    );

    if (session.needsBranchRename === true) {
      session.needsBranchRename = false;
      if (hasConcreteRepoBinding(session)) {
        const promptText: string =
          typeof req.body?.prompt === 'string' ? req.body.prompt : '';
        const renameRunner =
          deps.executeBranchRename ??
          ((targetSession, prompt) =>
            spawnBranchRename(targetSession, prompt, deps));
        renameRunner(session, promptText).catch((err) => {
          session.needsBranchRename = true;
          logger.error('spawnBranchRename error:', err);
        });
      }
    }

    res.json({ ok: true });
  });

  // POST /session-end → acknowledge hook (PTY onExit owns actual cleanup and cleanedUp flag)
  router.post('/session-end', (req: Request, res: Response) => {
    const session = (req as unknown as Record<string, unknown>)
      ._hookSession as Session;
    recordSessionEvent(
      buildSessionEvent(session, { eventType: 'session_end' })
    );
    // Acknowledge hook — PTY onExit owns actual cleanup and cleanedUp flag
    res.json({ ok: true });
  });

  // POST /tool-use → set currentActivity
  router.post('/tool-use', (req: Request, res: Response) => {
    const session = (req as unknown as Record<string, unknown>)
      ._hookSession as Session;
    const body = req.body as Record<string, unknown> | undefined;
    const toolName = typeof body?.tool_name === 'string' ? body.tool_name : '';
    const toolInput = body?.tool_input;
    const detail = extractToolDetail(toolName, toolInput);
    session.currentActivity =
      detail !== undefined ? { tool: toolName, detail } : { tool: toolName };
    deps.broadcastEvent('session-activity-changed', { sessionId: session.id });
    recordSessionEvent(
      buildSessionEvent(session, {
        eventType: 'tool_use',
        eventData: { tool: toolName, target: detail },
      })
    );
    res.json({ ok: true });
  });

  // POST /tool-result → clear currentActivity + debounced branch check
  router.post('/tool-result', (req: Request, res: Response) => {
    const session = (req as unknown as Record<string, unknown>)
      ._hookSession as Session;
    session.currentActivity = undefined;
    deps.broadcastEvent('session-activity-changed', { sessionId: session.id });
    // When a tool completes while in permission-prompt state, the user has answered
    // the question or approved the permission. Transition to processing so the
    // backend state reflects that Claude is actively working again.
    if (session.agentState === AGENT_STATE_PERMISSION_PROMPT) {
      setAgentState(session, 'processing', deps);
    }
    recordSessionEvent(
      buildSessionEvent(session, { eventType: 'tool_complete' })
    );
    // Debounced branch check — catches git checkout/switch during tool execution
    scheduleBranchCheck(session, deps);
    res.json({ ok: true });
  });

  return router;
}
