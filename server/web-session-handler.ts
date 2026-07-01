import crypto from 'node:crypto';
import type { WebSession, Session } from './types.js';
import type { AgentType } from './types.js';
import type { ChatEvent } from '../shared/chat-events.js';
import { createAdapterV2 } from './protocol-adapters/index.js';
import type { AdapterConfig, ProtocolAdapter } from './protocol-adapter.js';
import type {
  AgentPatchV2,
  AgentSessionBreakItemV2,
} from '../shared/agent-chat-protocol-v2.js';
import { createLogger } from './logger.js';
import {
  applyWebSessionPatchV2,
  createInitialAgentSessionV2,
} from './web-session-v2-state.js';
import { upsertWebSessionNow } from './relay-state-db.js';
import { DEFAULT_LOCAL_NODE_ID } from '../shared/identity.js';
import type { SessionLane } from '../shared/session-lane.js';
import {
  createLegacyControlStateSummary,
  normalizeControlStateSummary,
  type ControlStateSummary,
} from '../shared/control-state.js';
import { createLocalCompatibilitySessionEnvelope } from '../shared/session-envelope.js';

const logger = createLogger('web-session');
const MESSAGE_BUFFER_MAX = 1000;

export interface CreateWebParams {
  id?: string;
  agentType: string;
  cwd: string;
  repoPath?: string | undefined;
  repoName?: string | undefined;
  worktreePath?: string | null;
  branchName?: string | undefined;
  displayName: string;
  port: number;
  configDir: string;
  permissionMode?: string;
  model?: string;
  sessionLane?: SessionLane | undefined;
  workspaceId?: string;
  additionalDirs?: string[];
  runtimeOwnership?: 'spawned' | 'attached';
  hookToken?: string;
  controlState?: ControlStateSummary;
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
  onBackendStateChanged: (session: Session) => void,
  options: { skipInitialPersist?: boolean } = {}
): Promise<{ session: WebSession }> {
  const id = params.id ?? crypto.randomBytes(8).toString('hex');
  const adapterV2 = createAdapterV2(params.agentType);
  const adapter = createV2OnlyLegacyAdapter(
    params.agentType,
    adapterV2.runtimeOwnership
  );
  const activeRuntime = adapterV2;
  const hookToken = params.hookToken ?? crypto.randomBytes(16).toString('hex');
  const createdAt = new Date().toISOString();
  const normalizedControlState = normalizeControlStateSummary(
    params.controlState ?? createLegacyControlStateSummary()
  );

  const session: WebSession = {
    mode: 'web',
    id,
    nodeId: DEFAULT_LOCAL_NODE_ID,
    type: 'agent',
    agent: params.agentType as AgentType,
    ...(params.repoPath ? { repoPath: params.repoPath } : {}),
    ...(params.repoPath ? { worktreePath: params.worktreePath ?? null } : {}),
    cwd: params.cwd,
    ...(params.repoName ? { repoName: params.repoName } : {}),
    ...(params.repoPath ? { branchName: params.branchName ?? '' } : {}),
    displayName: params.displayName,
    createdAt,
    lastActivity: createdAt,
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
    controlState: normalizedControlState,
    sessionEnvelope: createLocalCompatibilitySessionEnvelope({
      sessionId: id,
      nodeId: DEFAULT_LOCAL_NODE_ID,
      cwd: params.cwd,
      ...(params.repoPath ? { repoPath: params.repoPath } : {}),
      ...(params.worktreePath !== undefined
        ? { worktreePath: params.worktreePath }
        : {}),
      issuedAt: createdAt,
    }),
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

  // Restore path passes skipInitialPersist=true so the freshly-created blank
  // transcript doesn't overwrite the persisted row before sessions.ts copies
  // back agentSessionV2.
  if (!options.skipInitialPersist) {
    upsertWebSessionNow(session);
  }

  return { session };
}

/**
 * Extract the provider-specific session ID from a stored providerSession map.
 *
 * Each provider stores its resumable ID under a known key:
 *   claude → claudeSessionId
 *   codex  → threadId  (PR 5)
 *
 * Returns undefined if no recognized key is present.
 */
function extractProviderSessionId(
  agentType: string,
  providerSession: Record<string, string> | undefined
): string | undefined {
  if (!providerSession) return undefined;
  if (agentType === 'claude') return providerSession['claudeSessionId'];
  if (agentType === 'codex') return providerSession['threadId'];
  if (agentType === 'hermes') return providerSession['hermesResponseId'];
  return undefined;
}

/**
 * Reconnect an existing web session after a transport drop.
 *
 * If the session's adapter supports resume (`capabilities.resume === true`)
 * and a prior provider-session ID is stored, calls `adapter.resumeSession(id)`
 * to reattach to the previous conversation. Otherwise falls back to `reconnect()`
 * which performs a clean transport-level reconnect with no history.
 */
export async function reconnectWebSession(session: WebSession): Promise<void> {
  const adapterV2 = session.adapterV2;
  const capabilities = adapterV2.capabilities;
  const providerSession = session.agentSessionV2.providerSession;

  const providerSessionId = extractProviderSessionId(
    session.adapterType,
    providerSession
  );

  if (capabilities.resume && providerSessionId) {
    logger.info('resuming web session via provider session id', {
      id: session.id,
      agentType: session.adapterType,
      providerSessionId,
    });
    await adapterV2.resumeSession(providerSessionId);
  } else {
    logger.info(
      'reconnecting web session (no resume capability or no stored id)',
      {
        id: session.id,
        agentType: session.adapterType,
        hasResume: capabilities.resume,
        hasProviderId: Boolean(providerSessionId),
      }
    );
    await adapterV2.reconnect();
  }
}

/**
 * "Continue here" recovery: force-start a fresh adapter session without resume.
 *
 * Steps:
 * 1. Emit a synthetic `sessionBreak` divider patch BEFORE disconnecting so
 *    all currently-registered onPatch listeners (session state reducer +
 *    per-WebSocket forwarders) receive and forward it to connected clients.
 * 2. Disconnect the current adapter (clears the handler set).
 * 3. Clear the stored vendor session ID from the in-memory session so that
 *    a subsequent `reconnectWebSession` (or any DB read) sees no stale ID.
 * 4. Re-register the session-level state reducer/persistence handler so new
 *    patches from the fresh connection are processed correctly.
 * 5. Call `adapter.connect()` with the same config but no resume argument.
 *
 * The Relay session ID (`session.id`) is never changed — all URLs and
 * external refs remain stable.
 */
export async function continueHereWebSession(
  session: WebSession,
  config: AdapterConfig,
  onBackendStateChanged: (session: Session) => void
): Promise<boolean> {
  const adapterV2 = session.adapterV2;

  // Issue 6 fix: guard against accidental teardown of an active session.
  // Only proceed when the session live state is disconnected or the adapter
  // itself reports disconnected. An active/waiting session must not be torn
  // down by a stale or unexpected client command.
  const liveStatus = session.agentSessionV2.live.status;
  const isDisconnected =
    liveStatus === 'disconnected' || adapterV2.status === 'disconnected';
  if (!isDisconnected) {
    logger.warn(
      'continue-here: ignoring request for non-disconnected session (skipping)',
      {
        id: session.id,
        liveStatus,
        adapterStatus: adapterV2.status,
      }
    );
    return false;
  }

  // Bug 2 fix: emit the synthetic sessionBreak BEFORE disconnect so that all
  // currently-registered onPatch handlers (session state reducer AND any live
  // per-WS forwarders) receive and forward it immediately. After disconnect()
  // those handlers are cleared, so emitting after would reach no one.
  const timestamp = new Date().toISOString();
  const breakItem: AgentSessionBreakItemV2 = {
    type: 'sessionBreak',
    id: `session-break-${timestamp}`,
    reason: 'continue-here',
    startedAt: timestamp,
    completedAt: timestamp,
    status: 'completed',
  };

  const turns = session.agentSessionV2.turns;
  const lastTurn = turns[turns.length - 1];

  if (lastTurn) {
    // Append the divider to the last existing turn so it renders at the bottom
    // of the transcript, clearly separating old and new model context.
    const itemPatch: AgentPatchV2 = {
      type: 'agent-item-started-v2',
      sessionId: session.id,
      timestamp,
      turnId: lastTurn.id,
      item: breakItem,
    };
    // Apply to session state and push to agentPatchesV2 for reconnect replay.
    applyWebSessionPatchV2(session, itemPatch);
    // Broadcast to all live onPatch listeners (session reducer + WS forwarders).
    adapterV2.broadcastPatch(itemPatch);
  }

  logger.info('continue-here: disconnecting current adapter', {
    id: session.id,
    agentType: session.adapterType,
  });

  await adapterV2.disconnect().catch((err: unknown) => {
    // Non-fatal: adapter may already be in a bad state after resume failure.
    logger.warn('continue-here: disconnect error (continuing anyway)', {
      id: session.id,
      err: String(err),
    });
  });

  // Clear vendor session ID so no stale resume ID remains in memory.
  if (session.agentSessionV2.providerSession !== undefined) {
    session.agentSessionV2 = {
      ...session.agentSessionV2,
      providerSession: {},
    };
  }

  // Bug 1 fix: re-register the session-level state reducer/persistence handler.
  // disconnect() clears all handlers registered via onPatch, including the one
  // set up at session-create time in createWebSession. Without re-registering,
  // patches from the fresh connect are not applied to session state and not
  // persisted to the DB.
  adapterV2.onPatch((patch) => {
    handleAgentPatchV2(session, patch, onBackendStateChanged);
  });

  logger.info('continue-here: connecting fresh adapter session', {
    id: session.id,
    agentType: session.adapterType,
  });

  await adapterV2.connect(config);

  // Persist: fresh connect may assign a new vendor session ID; the debounced
  // upsert in the adapter's patch handler will capture it. Persist now to
  // ensure the cleared vendor ID hits the DB before the new one arrives.
  upsertWebSessionNow(session);
  return true;
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
