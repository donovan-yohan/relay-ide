import crypto from 'node:crypto';
import type { ChildProcess } from 'node:child_process';
import type { WebSession, Session } from './types.js';
import type { AgentType } from './types.js';
import type { ChatEvent } from '../shared/chat-events.js';
import { createAdapter } from './protocol-adapters/index.js';
import type { AdapterConfig } from './protocol-adapter.js';
import { createLogger } from './logger.js';

const logger = createLogger('web-session');
const MESSAGE_BUFFER_MAX = 1000;

export interface CreateWebParams {
  id?: string;
  agentType: string;
  cwd: string;
  repoPath: string;
  repoName: string;
  worktreePath?: string | null;
  branchName: string;
  displayName: string;
  port: number;
  configDir: string;
  permissionMode?: string;
  model?: string;
  workspaceId?: string;
  additionalDirs?: string[];
  process?: ChildProcess;
}

export function pushToBuffer(session: WebSession, event: ChatEvent): void {
  if (session.messages.length >= MESSAGE_BUFFER_MAX) {
    // Prefer evicting non-approval events so approval state is preserved for reconnecting clients.
    // If the entire buffer is approvals (pathological case), fall back to FIFO eviction of the
    // oldest approval to prevent unbounded growth — losing a stale approval is better than OOM.
    const evictIdx = session.messages.findIndex(
      (e) =>
        e.type !== 'chat:approval-request' &&
        e.type !== 'chat:approval-response'
    );
    if (evictIdx !== -1) {
      session.messages.splice(evictIdx, 1);
    } else {
      session.messages.shift();
    }
  }
  session.messages.push(event);
}

export async function createWebSession(
  params: CreateWebParams,
  sessionsMap: Map<string, Session>,
  onBackendStateChanged: (session: Session) => void
): Promise<{ session: WebSession }> {
  const id = params.id ?? crypto.randomBytes(8).toString('hex');
  const adapter = createAdapter(params.agentType);

  const session: WebSession = {
    mode: 'web',
    id,
    type: 'agent',
    agent: params.agentType as AgentType,
    repoPath: params.repoPath,
    worktreePath: params.worktreePath ?? null,
    cwd: params.cwd,
    repoName: params.repoName,
    branchName: params.branchName,
    displayName: params.displayName,
    createdAt: new Date().toISOString(),
    lastActivity: new Date().toISOString(),
    idle: true,
    customCommand: null,
    status: 'active',
    needsBranchRename: false,
    agentState: 'initializing',
    ...(params.workspaceId !== undefined
      ? { workspaceId: params.workspaceId }
      : {}),
    ...(params.additionalDirs !== undefined
      ? { additionalDirs: params.additionalDirs }
      : {}),
    adapter,
    adapterType: params.agentType,
    messages: [],
    currentTurnId: null,
    ...(params.process !== undefined ? { process: params.process } : {}),
  };

  sessionsMap.set(id, session);

  adapter.on((event) => {
    pushToBuffer(session, event);

    if (event.type === 'chat:turn-started') {
      session.currentTurnId = event.turnId;
      session.agentState = 'processing';
      session.idle = false;
      onBackendStateChanged(session);
    } else if (event.type === 'chat:turn-completed') {
      session.currentTurnId = null;
      session.agentState = 'idle';
      session.idle = true;
      onBackendStateChanged(session);
    } else if (event.type === 'chat:approval-request') {
      session.agentState = 'permission-prompt';
      onBackendStateChanged(session);
    } else if (event.type === 'chat:approval-response') {
      session.agentState = 'processing';
      session.idle = false;
      onBackendStateChanged(session);
    } else if (event.type === 'chat:session-status') {
      if (event.status === 'idle') {
        session.agentState = 'idle';
        session.idle = true;
        onBackendStateChanged(session);
      } else if (event.status === 'active') {
        session.agentState = 'processing';
        session.idle = false;
        onBackendStateChanged(session);
      } else if (event.status === 'error') {
        session.agentState = 'error';
        session.idle = true;
        onBackendStateChanged(session);
      } else if (event.status === 'disconnected') {
        session.agentState = 'idle';
        session.idle = true;
        onBackendStateChanged(session);
      }
    }

    session.lastActivity = new Date().toISOString();
  });

  const config: AdapterConfig = {
    cwd: params.cwd,
    port: params.port,
    sessionId: id,
    hookToken: crypto.randomBytes(16).toString('hex'),
    configDir: params.configDir,
    ...(params.permissionMode !== undefined
      ? { permissionMode: params.permissionMode }
      : {}),
    ...(params.model !== undefined ? { model: params.model } : {}),
  };

  try {
    await adapter.connect(config);
  } catch (err) {
    // Clean up zombie: remove from map and disconnect adapter to clear handlers
    sessionsMap.delete(id);
    await adapter.disconnect().catch(() => {});
    session.agentState = 'error';
    throw err;
  }

  logger.info('web session created', { id, agentType: params.agentType });

  return { session };
}
