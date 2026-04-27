import crypto from 'node:crypto';
import type { WebSession, Session } from './types.js';
import type { AgentType } from './types.js';
import type { ChatEvent } from '../shared/chat-events.js';
import { createAdapterV2 } from './protocol-adapters/index.js';
import type { AdapterConfig, ProtocolAdapter } from './protocol-adapter.js';
import type { AgentPatchV2 } from '../shared/agent-chat-protocol-v2.js';
import { createLogger } from './logger.js';
import {
  applyWebSessionPatchV2,
  createInitialAgentSessionV2,
} from './web-session-v2-state.js';

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
  runtimeOwnership?: 'spawned' | 'attached';
  hookToken?: string;
  /** Additional agent-specific configuration passed through to the protocol adapter */
  extra?: Record<string, unknown>;
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
  const adapterV2 = createAdapterV2(params.agentType);
  const adapter = createV2OnlyLegacyAdapter(
    params.agentType,
    adapterV2.runtimeOwnership
  );
  const activeRuntime = adapterV2;
  const hookToken = params.hookToken ?? crypto.randomBytes(16).toString('hex');

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
    adapterV2,
    adapterType: params.agentType,
    agentSessionV2: createInitialAgentSessionV2({
      id,
      provider: params.agentType,
      cwd: params.cwd,
      capabilities: adapterV2.capabilities,
      ...(params.model !== undefined ? { model: params.model } : {}),
      ...(params.permissionMode !== undefined
        ? { permissionMode: params.permissionMode }
        : {}),
      ...(params.additionalDirs !== undefined
        ? { additionalDirs: params.additionalDirs }
        : {}),
      ...(params.extra !== undefined ? { providerOptions: params.extra } : {}),
    }),
    agentPatchesV2: [],
    protocolVersion: 2,
    messages: [],
    currentTurnId: null,
    runtimeOwnership: params.runtimeOwnership ?? activeRuntime.runtimeOwnership,
    hookToken,
    hooksActive: true,
  };

  sessionsMap.set(id, session);

  adapterV2.onPatch((patch) => {
    handleAgentPatchV2(session, patch, onBackendStateChanged);
  });

  const config: AdapterConfig = {
    cwd: params.cwd,
    port: params.port,
    sessionId: id,
    hookToken,
    configDir: params.configDir,
    ...(params.permissionMode !== undefined
      ? { permissionMode: params.permissionMode }
      : {}),
    ...(params.model !== undefined ? { model: params.model } : {}),
    ...(params.extra !== undefined ? { extra: params.extra } : {}),
  };

  try {
    await adapterV2.connect(config);
  } catch (err) {
    // Clean up zombie: remove from map and disconnect adapter to clear handlers
    sessionsMap.delete(id);
    await adapterV2.disconnect().catch(() => {});
    await adapter.disconnect().catch(() => {});
    session.agentState = 'error';
    throw err;
  }

  logger.info('web session created', { id, agentType: params.agentType });

  return { session };
}

function createV2OnlyLegacyAdapter(
  agentType: string,
  runtimeOwnership: 'spawned' | 'attached'
): ProtocolAdapter {
  return {
    agentType,
    runtimeOwnership,
    status: 'connected',
    async connect() {},
    async disconnect() {},
    async reconnect() {},
    async createSession() {
      return '';
    },
    async resumeSession() {},
    async forkSession() {
      return '';
    },
    async sendMessage() {
      throw new Error(`${agentType} web sessions use ProtocolAdapterV2`);
    },
    async interrupt() {},
    async respondToApproval() {},
    async respondToInput() {},
    on() {
      return () => {};
    },
  };
}

function handleAgentPatchV2(
  session: WebSession,
  patch: AgentPatchV2,
  onBackendStateChanged: (session: Session) => void
): void {
  applyWebSessionPatchV2(session, patch);

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

  session.lastActivity = new Date().toISOString();
  onBackendStateChanged(session);
}
