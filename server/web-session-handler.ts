import crypto from 'node:crypto';
import type { WebSession, Session } from './types.js';
import type { AgentType } from './types.js';
import { createAdapterV2 } from './protocol-adapters/index.js';
import type { AdapterConfig } from './protocol-adapter.js';
import type { ProtocolAdapterV2 } from './protocol-adapter-v2.js';
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
const restoreSnapshotFencedAdapters = new WeakSet<ProtocolAdapterV2>();
const retiredWebSessionAdapters = new WeakSet<ProtocolAdapterV2>();
const webSessionPatchSubscribers = new WeakMap<
  WebSession,
  Set<(patch: AgentPatchV2) => void>
>();

export function onWebSessionPatch(
  session: WebSession,
  handler: (patch: AgentPatchV2) => void
): () => void {
  let subscribers = webSessionPatchSubscribers.get(session);
  if (!subscribers) {
    subscribers = new Set();
    webSessionPatchSubscribers.set(session, subscribers);
  }
  subscribers.add(handler);
  return () => {
    subscribers?.delete(handler);
    if (subscribers?.size === 0) webSessionPatchSubscribers.delete(session);
  };
}

function notifyWebSessionPatchSubscribers(
  session: WebSession,
  patch: AgentPatchV2
): void {
  for (const handler of webSessionPatchSubscribers.get(session) ?? []) {
    try {
      handler(patch);
    } catch (err) {
      logger.warn('web session patch subscriber failed', err);
    }
  }
}

export function retireWebSessionAdapter(adapter: ProtocolAdapterV2): void {
  retiredWebSessionAdapters.add(adapter);
}

export function setWebSessionRestoreSnapshotFence(
  adapter: ProtocolAdapterV2,
  fenced: boolean
): void {
  if (fenced) {
    restoreSnapshotFencedAdapters.add(adapter);
  } else {
    restoreSnapshotFencedAdapters.delete(adapter);
  }
}

export interface CreateWebParams {
  id?: string;
  spawnedBySessionId?: string;
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

export async function createWebSession(
  params: CreateWebParams,
  sessionsMap: Map<string, Session>,
  onBackendStateChanged: (session: Session) => void,
  options: { skipInitialPersist?: boolean; deferConnect?: boolean } = {}
): Promise<{ session: WebSession; config: AdapterConfig }> {
  const id = params.id ?? crypto.randomBytes(8).toString('hex');
  const adapterV2 = createAdapterV2(params.agentType);
  const activeRuntime = adapterV2;
  const hookToken = params.hookToken ?? crypto.randomBytes(16).toString('hex');
  const createdAt = new Date().toISOString();
  const normalizedControlState = normalizeControlStateSummary(
    params.controlState ?? createLegacyControlStateSummary()
  );

  const session: WebSession = {
    mode: 'web',
    id,
    ...(params.spawnedBySessionId !== undefined
      ? { spawnedBySessionId: params.spawnedBySessionId }
      : {}),
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
    if (sessionsMap.get(id) !== session) return;
    if (session.adapterV2 !== adapterV2) return;
    if (retiredWebSessionAdapters.has(adapterV2)) return;
    if (
      patch.type === 'agent-session-snapshot-v2' &&
      restoreSnapshotFencedAdapters.has(adapterV2)
    ) {
      return;
    }
    // A timed-out boot reattach is authoritative. Providers that resolve or
    // emit after cancellation must not resurrect the failed session.
    if (session.restoreState === 'reattach-failed') return;
    handleAgentPatchV2(session, patch, onBackendStateChanged);
    notifyWebSessionPatchSubscribers(session, patch);
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

  if (!options.deferConnect) {
    try {
      await adapterV2.connect(config);
    } catch (err) {
      // Clean up zombie: remove from map and disconnect adapter to clear handlers
      sessionsMap.delete(id);
      await adapterV2.disconnect().catch(() => {});
      session.agentState = 'error';
      throw err;
    }
  }

  logger.info('web session created', { id, agentType: params.agentType });

  // Restore path passes skipInitialPersist=true so the freshly-created blank
  // transcript doesn't overwrite the persisted row before sessions.ts copies
  // back agentSessionV2.
  if (!options.skipInitialPersist) {
    upsertWebSessionNow(session);
  }

  return { session, config };
}

/**
 * Extract the provider-specific session ID from a stored providerSession map.
 *
 * Each provider stores its resumable ID under a known key:
 *   claude → claudeSessionId
 *   codex  → threadId  (PR 5)
 *   hermes → hermesResponseId  (last completed gateway response, #1087)
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
  return reconnectWebSessionAdapter(session, session.adapterV2);
}

export async function reconnectWebSessionAdapter(
  session: WebSession,
  adapterV2: ProtocolAdapterV2
): Promise<void> {
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
 * 2. Best-effort disconnect the current adapter.
 * 3. Clear the stored vendor session ID from the in-memory session so that
 *    a subsequent `reconnectWebSession` (or any DB read) sees no stale ID.
 * 4. Replace it with a new adapter instance and register the state reducer.
 * 5. Call `adapter.connect()` with the same config but no resume argument.
 *
 * The Relay session ID (`session.id`) is never changed — all URLs and
 * external refs remain stable.
 */
export async function continueHereWebSession(
  session: WebSession,
  config: AdapterConfig,
  onBackendStateChanged: (session: Session) => void,
  options: { replaceAdapter?: boolean } = {}
): Promise<boolean> {
  const staleAdapter = session.adapterV2;

  // Issue 6 fix: guard against accidental teardown of an active session.
  // Only proceed when the session live state is disconnected or the adapter
  // itself reports disconnected. An active/waiting session must not be torn
  // down by a stale or unexpected client command.
  const liveStatus = session.agentSessionV2.live.status;
  const isDisconnected =
    options.replaceAdapter === true ||
    liveStatus === 'disconnected' ||
    staleAdapter.status === 'disconnected';
  if (!isDisconnected) {
    logger.warn(
      'continue-here: ignoring request for non-disconnected session (skipping)',
      {
        id: session.id,
        liveStatus,
        adapterStatus: staleAdapter.status,
      }
    );
    return false;
  }

  const replacementAdapter = options.replaceAdapter
    ? createAdapterV2(session.adapterType)
    : undefined;
  if (replacementAdapter) {
    session.adapterV2 = replacementAdapter;
    session.runtimeOwnership = replacementAdapter.runtimeOwnership;
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
    staleAdapter.broadcastPatch(itemPatch);
    if (replacementAdapter) {
      notifyWebSessionPatchSubscribers(session, itemPatch);
    }
  }

  logger.info('continue-here: disconnecting current adapter', {
    id: session.id,
    agentType: session.adapterType,
  });

  const disconnectStaleAdapter = staleAdapter
    .disconnect()
    .catch((err: unknown) => {
      // Non-fatal: adapter may already be in a bad state after resume failure.
      logger.warn('continue-here: disconnect error (continuing anyway)', {
        id: session.id,
        err: String(err),
      });
    });
  if (options.replaceAdapter) {
    // A timed-out provider may never finish cleanup. The replacement adapter
    // is isolated, so stale cleanup stays detached from the fresh connection.
    void disconnectStaleAdapter;
  } else {
    await disconnectStaleAdapter;
  }

  // Clear vendor session ID so no stale resume ID remains in memory.
  if (session.agentSessionV2.providerSession !== undefined) {
    session.agentSessionV2 = {
      ...session.agentSessionV2,
      providerSession: {},
    };
  }

  const adapterV2 = replacementAdapter ?? staleAdapter;

  // Register the reducer on the replacement adapter. Identity fencing keeps
  // late patches from the superseded provider from mutating this session.
  adapterV2.onPatch((patch) => {
    if (session.adapterV2 !== adapterV2) return;
    handleAgentPatchV2(session, patch, onBackendStateChanged);
    notifyWebSessionPatchSubscribers(session, patch);
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
