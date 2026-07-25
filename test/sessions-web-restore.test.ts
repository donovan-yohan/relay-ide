import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { emptyAgentSessionV2 } from '../shared/agent-chat-protocol-v2.js';
import type {
  AgentCapabilitySetV2,
  AgentPatchV2,
  AgentSessionV2,
} from '../shared/agent-chat-protocol-v2.js';
import type { LoadedWebSessionRow } from '../server/relay-state-db.js';
import type {
  AgentApprovalResponseInputV2,
  AgentInputResponseInputV2,
  AgentInterruptInputV2,
  AgentPatchHandlerV2,
  AgentSendMessageInputV2,
  AdapterConfig,
  AdapterStatus,
  ProtocolAdapterV2,
} from '../server/protocol-adapter-v2.js';
import { getSessionCategory } from '../server/session-attribution.js';
import type { WebSession } from '../server/types.js';
import type { ScopedActorCredentialRecord } from '../shared/scoped-actor-credentials.js';

const capabilities: AgentCapabilitySetV2 = {
  text: true,
  reasoning: true,
  tools: true,
  commandExecution: true,
  fileChanges: true,
  approvals: true,
  questions: true,
  plans: false,
  slashCommands: false,
  queue: false,
  interrupt: true,
  cancelQueued: false,
  resume: true,
  fork: false,
  rollback: false,
  compact: false,
  telemetry: false,
  rateLimits: false,
  streaming: true,
};

const loadAllWebSessions = vi.fn<() => LoadedWebSessionRow[]>();
const upsertWebSessionNow = vi.fn();
const deleteWebSession = vi.fn();
const scheduleWebSessionUpsert = vi.fn();
const resumeSession = vi.fn();
const reconnect = vi.fn();
const connect = vi.fn();
const disconnect = vi.fn();
const refreshRuntimeEnv = vi.fn();
let supportsRuntimeEnvRefresh = true;
let emitBlankSnapshotOnConnect = false;
let emitPatchOnDisconnect: AgentPatchV2 | undefined;

class RestoreFailureAdapter implements ProtocolAdapterV2 {
  readonly agentType = 'claude';
  readonly runtimeOwnership = 'attached' as const;
  readonly capabilities = capabilities;
  private adapterStatus: AdapterStatus = 'disconnected';
  private handlers = new Set<AgentPatchHandlerV2>();
  refreshRuntimeEnv?: (processEnv: Record<string, string>) => Promise<void>;

  constructor() {
    if (supportsRuntimeEnvRefresh) {
      this.refreshRuntimeEnv = async (processEnv) => {
        await refreshRuntimeEnv(processEnv);
      };
    }
  }

  get status(): AdapterStatus {
    return this.adapterStatus;
  }

  async connect(config: AdapterConfig): Promise<void> {
    await connect(config);
    this.adapterStatus = 'connected';
    if (emitBlankSnapshotOnConnect) {
      this.emit({
        type: 'agent-session-snapshot-v2',
        sessionId: config.sessionId,
        timestamp: new Date().toISOString(),
        session: emptyAgentSessionV2({
          id: config.sessionId,
          provider: 'claude',
          cwd: config.cwd,
          capabilities,
        }),
      });
    }
  }
  async disconnect(): Promise<void> {
    this.adapterStatus = 'disconnected';
    if (emitPatchOnDisconnect) this.emit(emitPatchOnDisconnect);
    this.handlers.clear();
    await disconnect();
  }
  async reconnect(): Promise<void> {
    await reconnect();
  }
  async resumeSession(sessionId: string): Promise<void> {
    await resumeSession(sessionId);
  }
  async sendMessage(_input: AgentSendMessageInputV2): Promise<void> {}
  async interrupt(_input: AgentInterruptInputV2): Promise<void> {}
  async respondToApproval(
    _input: AgentApprovalResponseInputV2
  ): Promise<void> {}
  async respondToInput(_input: AgentInputResponseInputV2): Promise<void> {}
  onPatch(handler: AgentPatchHandlerV2): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }
  emit(patch: AgentPatchV2): void {
    for (const handler of this.handlers) handler(patch);
  }
  broadcastPatch(patch: AgentPatchV2): void {
    this.emit(patch);
  }
}

let latestAdapter: RestoreFailureAdapter | undefined;
const createdAdapters: RestoreFailureAdapter[] = [];

vi.mock('../server/relay-state-db.js', () => ({
  loadAllWebSessions,
  upsertWebSessionNow,
  deleteWebSession,
  scheduleWebSessionUpsert,
}));

vi.mock('../server/protocol-adapters/index.js', () => ({
  createAdapterV2: () => {
    latestAdapter = new RestoreFailureAdapter();
    createdAdapters.push(latestAdapter);
    return latestAdapter;
  },
}));

function restoredOrchestratorCredential(
  id: string,
  sessionId: string
): { token: string; credential: ScopedActorCredentialRecord } {
  const issuedAt = Date.now();
  return {
    token: `relay-sac-v1.${id}.redacted`,
    credential: {
      id,
      actor: { type: 'agent', id: sessionId },
      issuer: { id: 'relay-ide' },
      audience: 'relay:cli-gateway:v1',
      capabilities: [
        'session:read',
        'context:read',
        'context:write',
        'session:create:agent',
      ],
      scope: { taskRefs: ['relay:cli-gateway:v1:read'] },
      metadata: { reason: 'persistent-orchestrator' },
      issuedAt: new Date(issuedAt).toISOString(),
      expiresAt: new Date(issuedAt + 15 * 60 * 1000).toISOString(),
      correlationId: `correlation-${id}`,
    },
  };
}

describe('web session restore failure recovery', () => {
  let configDir: string;

  beforeEach(() => {
    configDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'relay-ide-web-restore-')
    );
    loadAllWebSessions.mockReset();
    upsertWebSessionNow.mockReset();
    deleteWebSession.mockReset();
    scheduleWebSessionUpsert.mockReset();
    reconnect.mockReset();
    resumeSession.mockReset();
    connect.mockReset();
    disconnect.mockReset();
    refreshRuntimeEnv.mockReset();
    supportsRuntimeEnvRefresh = true;
    latestAdapter = undefined;
    createdAdapters.length = 0;
    emitBlankSnapshotOnConnect = false;
    emitPatchOnDisconnect = undefined;
  });

  afterEach(async () => {
    const sessions = await import('../server/sessions.js');
    for (const session of sessions.list()) {
      try {
        sessions.kill(session.id);
      } catch {
        /* ignore */
      }
    }
    fs.rmSync(configDir, { recursive: true, force: true });
  });

  it('restores persisted web metadata and surfaces resume failure as recoverable session state', async () => {
    resumeSession.mockRejectedValueOnce(new Error('provider session expired'));
    loadAllWebSessions.mockReturnValueOnce([
      {
        id: 'web-restore-failure',
        vendor: 'claude',
        vendorSessionId: 'stored-provider-session',
        cwd: configDir,
        repoPath: configDir,
        worktreePath: null,
        branchName: 'feature/restart',
        displayName: 'web restart session',
        workspaceId: 'workspace-1',
        agentSessionV2: emptyAgentSessionV2({
          id: 'web-restore-failure',
          provider: 'claude',
          cwd: configDir,
          capabilities,
          providerSession: { claudeSessionId: 'stored-provider-session' },
          config: {
            model: 'sonnet',
            permissionMode: 'acceptEdits',
          },
        }),
        meta: {
          type: 'agent',
          agent: 'claude',
          role: 'orchestrator',
          spawnedBySessionId: 'orchestrator-session',
          repoName: 'relay-ide',
          customCommand: null,
          runtimeOwnership: 'attached',
          hookToken: 'restored-hook-token',
          adapterType: 'claude',
          needsBranchRename: true,
          additionalDirs: [path.join(configDir, 'extra')],
          controlState: {
            controlMode: 'co-driven',
            activeActors: [
              { kind: 'human', id: 'operator' },
              { kind: 'agent', id: 'claude' },
            ],
            activeWorker: { kind: 'agent', id: 'claude' },
            lastInterventionAt: '2026-01-02T03:04:05.000Z',
            lastInterventionBy: { kind: 'human', id: 'operator' },
            lastInterventionEventId: 'evt-restored-web',
            controlFreshness: 'fresh',
          },
        },
        createdAt: Date.now() - 10_000,
        lastActivity: Date.now() - 5_000,
        status: 'active',
      },
    ]);

    const sessions = await import('../server/sessions.js');
    sessions.configure({
      port: 4567,
      configDir,
      orchestratorCredentials: {
        issueCredential: () =>
          restoredOrchestratorCredential(
            'restore-credential',
            'web-restore-failure'
          ),
        revokeCredential: vi.fn(),
      },
    });

    const restored = await sessions.restoreFromDisk(configDir);

    expect(restored).toBe(1);
    await vi.waitFor(() =>
      expect(resumeSession).toHaveBeenCalledWith('stored-provider-session')
    );
    expect(reconnect).not.toHaveBeenCalled();

    const session = sessions.get('web-restore-failure');
    expect(session).toBeTruthy();
    expect(session!.mode).toBe('web');
    if (session?.mode !== 'web') throw new Error('expected web session');
    expect(session.hookToken).toBe('restored-hook-token');
    expect(session.spawnedBySessionId).toBe('orchestrator-session');
    expect(session.role).toBe('orchestrator');
    expect(sessions.list().find((entry) => entry.id === session.id)?.role).toBe(
      'orchestrator'
    );
    expect(session.needsBranchRename).toBe(true);
    expect(session.workspaceId).toBe('workspace-1');
    expect(session.additionalDirs).toEqual([path.join(configDir, 'extra')]);
    await vi.waitFor(() => {
      expect(session.restoreState).toBe('reattach-failed');
      expect(session.status).toBe('disconnected');
      expect(session.agentState).toBe('error');
    });
    expect(session.controlState).toMatchObject({
      controlMode: 'co-driven',
      controlFreshness: 'fresh',
      lastInterventionEventId: 'evt-restored-web',
    });
    expect(session.agentSessionV2.live.status).toBe('disconnected');
    expect(session.agentSessionV2.live.error).toBe('resume failed');
    expect(
      session.agentSessionV2.turns.some((turn) =>
        turn.items.some(
          (item) =>
            item.type === 'errorMessage' &&
            item.context === 'resume' &&
            item.message.includes('provider session expired')
        )
      )
    ).toBe(true);
    expect(upsertWebSessionNow).toHaveBeenLastCalledWith(session);
  });

  it('retains an explicit orchestrator credential through successful restore and revokes it on kill', async () => {
    loadAllWebSessions.mockReturnValueOnce([
      {
        id: 'web-restore-orchestrator-success',
        vendor: 'claude',
        vendorSessionId: 'stored-orchestrator-provider-session',
        cwd: configDir,
        repoPath: null,
        worktreePath: null,
        branchName: null,
        displayName: 'restored orchestrator',
        workspaceId: null,
        agentSessionV2: emptyAgentSessionV2({
          id: 'web-restore-orchestrator-success',
          provider: 'claude',
          cwd: configDir,
          capabilities,
          providerSession: {
            claudeSessionId: 'stored-orchestrator-provider-session',
          },
        }),
        meta: {
          type: 'agent',
          agent: 'claude',
          role: 'orchestrator',
          customCommand: null,
          runtimeOwnership: 'attached',
          hookToken: 'orchestrator-success-hook-token',
          adapterType: 'claude',
        },
        createdAt: Date.now() - 10_000,
        lastActivity: Date.now() - 5_000,
        status: 'active',
      },
    ]);
    const revokeCredential = vi.fn();
    const sessions = await import('../server/sessions.js');
    sessions.configure({
      port: 4567,
      configDir,
      orchestratorCredentials: {
        issueCredential: () =>
          restoredOrchestratorCredential(
            'orchestrator-success-credential',
            'web-restore-orchestrator-success'
          ),
        revokeCredential,
      },
    });

    expect(await sessions.restoreFromDisk(configDir)).toBe(1);
    await vi.waitFor(() =>
      expect(resumeSession).toHaveBeenCalledWith(
        'stored-orchestrator-provider-session'
      )
    );
    const session = sessions.get('web-restore-orchestrator-success');
    expect(session?.role).toBe('orchestrator');
    await vi.waitFor(() => expect(session?.restoreState).toBeUndefined());
    expect(revokeCredential).not.toHaveBeenCalled();

    sessions.kill('web-restore-orchestrator-success');
    expect(revokeCredential).toHaveBeenCalledTimes(1);
    expect(revokeCredential).toHaveBeenCalledWith(
      'orchestrator-success-credential',
      {
        revokedBy: 'relay-ide',
        reason: 'orchestrator-session-ended',
      }
    );
  });

  it('fences blank connect snapshots and resumes from the persisted transcript identity', async () => {
    emitBlankSnapshotOnConnect = true;
    const persisted = emptyAgentSessionV2({
      id: 'web-restore-snapshot',
      provider: 'claude',
      cwd: configDir,
      capabilities,
      providerSession: { claudeSessionId: 'durable-provider-session' },
    });
    const now = new Date().toISOString();
    persisted.turns = [
      {
        id: 'durable-turn',
        status: 'completed',
        inputMessageId: 'durable-input',
        items: [
          {
            type: 'assistantMessage',
            id: 'durable-item',
            text: 'persisted transcript',
            status: 'completed',
            startedAt: now,
            completedAt: now,
          },
        ],
        startedAt: now,
        completedAt: now,
      },
    ];
    const persistedWrites: AgentSessionV2[] = [];
    upsertWebSessionNow.mockImplementation((session: WebSession) => {
      persistedWrites.push(structuredClone(session.agentSessionV2));
    });
    loadAllWebSessions.mockReturnValueOnce([
      {
        id: 'web-restore-snapshot',
        vendor: 'claude',
        vendorSessionId: 'durable-provider-session',
        cwd: configDir,
        repoPath: null,
        worktreePath: null,
        branchName: null,
        displayName: 'snapshot restore',
        workspaceId: null,
        agentSessionV2: persisted,
        meta: {
          type: 'agent',
          agent: 'claude',
          customCommand: null,
          runtimeOwnership: 'attached',
          hookToken: 'snapshot-hook-token',
          adapterType: 'claude',
        },
        createdAt: Date.now() - 10_000,
        lastActivity: Date.now() - 5_000,
        status: 'active',
      },
    ]);

    const sessions = await import('../server/sessions.js');
    sessions.configure({ port: 4567, configDir });
    await sessions.restoreFromDisk(configDir);
    await vi.waitFor(() =>
      expect(resumeSession).toHaveBeenCalledWith('durable-provider-session')
    );

    const session = sessions.get('web-restore-snapshot');
    if (session?.mode !== 'web') throw new Error('expected web session');
    expect(session.agentSessionV2.providerSession).toEqual({
      claudeSessionId: 'durable-provider-session',
    });
    expect(session.agentSessionV2.turns).toHaveLength(1);
    expect(session.agentSessionV2.turns[0]?.id).toBe('durable-turn');
    expect(persistedWrites.length).toBeGreaterThan(0);
    expect(
      persistedWrites.every(
        (write) =>
          write.turns[0]?.id === 'durable-turn' &&
          write.providerSession?.['claudeSessionId'] ===
            'durable-provider-session'
      )
    ).toBe(true);
  });

  it('materializes a hanging transport as restoring, then fails it at the hard deadline', async () => {
    connect.mockImplementationOnce(() => new Promise<void>(() => {}));
    loadAllWebSessions.mockReturnValueOnce([
      {
        id: 'web-restore-hangs',
        vendor: 'claude',
        vendorSessionId: 'stored-provider-session',
        cwd: configDir,
        repoPath: null,
        worktreePath: null,
        branchName: null,
        displayName: 'hung transport',
        workspaceId: null,
        agentSessionV2: emptyAgentSessionV2({
          id: 'web-restore-hangs',
          provider: 'claude',
          cwd: configDir,
          capabilities,
          providerSession: { claudeSessionId: 'stored-provider-session' },
        }),
        meta: {
          type: 'agent',
          agent: 'claude',
          customCommand: null,
          runtimeOwnership: 'attached',
          hookToken: 'hung-restored-hook-token',
          adapterType: 'claude',
        },
        createdAt: Date.now() - 10_000,
        lastActivity: Date.now() - 5_000,
        status: 'active',
      },
    ]);

    const sessions = await import('../server/sessions.js');
    sessions.configure({ port: 4567, configDir });

    const restored = await sessions.restoreFromDisk(
      configDir,
      undefined,
      undefined,
      { webSessionReattachTimeoutMs: 20 }
    );

    expect(restored).toBe(1);
    const session = sessions.get('web-restore-hangs');
    expect(session?.mode).toBe('web');
    if (session?.mode !== 'web') throw new Error('expected web session');
    expect(session.restoreState).toBe('restoring');
    expect(sessions.list()).toContainEqual(
      expect.objectContaining({
        id: 'web-restore-hangs',
        restoreState: 'restoring',
      })
    );
    expect(resumeSession).not.toHaveBeenCalled();

    await vi.waitFor(() => {
      expect(session.restoreState).toBe('reattach-failed');
      expect(session.agentSessionV2.live.status).toBe('disconnected');
      expect(disconnect).toHaveBeenCalled();
    });
    expect(sessions.list()).toContainEqual(
      expect.objectContaining({
        id: 'web-restore-hangs',
        restoreState: 'reattach-failed',
      })
    );
  });

  it('keeps timeout failure authoritative when a late resume settles', async () => {
    let settleResume: (() => void) | undefined;
    resumeSession.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          settleResume = resolve;
        })
    );
    loadAllWebSessions.mockReturnValueOnce([
      {
        id: 'web-restore-late',
        vendor: 'claude',
        vendorSessionId: 'stored-provider-session',
        cwd: configDir,
        repoPath: null,
        worktreePath: null,
        branchName: null,
        displayName: 'late transport',
        workspaceId: null,
        agentSessionV2: emptyAgentSessionV2({
          id: 'web-restore-late',
          provider: 'claude',
          cwd: configDir,
          capabilities,
          providerSession: { claudeSessionId: 'stored-provider-session' },
        }),
        meta: {
          type: 'agent',
          agent: 'claude',
          customCommand: null,
          runtimeOwnership: 'attached',
          hookToken: 'late-restored-hook-token',
          adapterType: 'claude',
        },
        createdAt: Date.now() - 10_000,
        lastActivity: Date.now() - 5_000,
        status: 'active',
      },
    ]);

    const sessions = await import('../server/sessions.js');
    sessions.configure({ port: 4567, configDir });
    await sessions.restoreFromDisk(configDir, undefined, undefined, {
      webSessionReattachTimeoutMs: 20,
    });
    const session = sessions.get('web-restore-late');
    if (session?.mode !== 'web') throw new Error('expected web session');

    await vi.waitFor(() =>
      expect(session.restoreState).toBe('reattach-failed')
    );
    settleResume?.();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    latestAdapter?.emit({
      type: 'agent-live-state-updated-v2',
      sessionId: session.id,
      timestamp: new Date().toISOString(),
      live: {
        status: 'idle',
        activeTurnId: null,
        waitingOn: null,
        activeRequestIds: [],
        error: null,
      },
    });

    expect(session.restoreState).toBe('reattach-failed');
    expect(session.status).toBe('disconnected');
    expect(session.agentSessionV2.live.status).toBe('disconnected');
    expect(disconnect.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('isolates Continue Here from a superseded restore that settles late', async () => {
    let settleResume: (() => void) | undefined;
    resumeSession.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          settleResume = resolve;
        })
    );
    loadAllWebSessions.mockReturnValueOnce([
      {
        id: 'web-restore-superseded',
        vendor: 'claude',
        vendorSessionId: 'stored-provider-session',
        cwd: configDir,
        repoPath: null,
        worktreePath: null,
        branchName: null,
        displayName: 'superseded transport',
        workspaceId: null,
        agentSessionV2: emptyAgentSessionV2({
          id: 'web-restore-superseded',
          provider: 'claude',
          cwd: configDir,
          capabilities,
          providerSession: { claudeSessionId: 'stored-provider-session' },
        }),
        meta: {
          type: 'agent',
          agent: 'claude',
          customCommand: null,
          runtimeOwnership: 'attached',
          hookToken: 'superseded-restored-hook-token',
          adapterType: 'claude',
        },
        createdAt: Date.now() - 10_000,
        lastActivity: Date.now() - 5_000,
        status: 'active',
      },
    ]);

    const sessions = await import('../server/sessions.js');
    sessions.configure({ port: 4567, configDir });
    await sessions.restoreFromDisk(configDir, undefined, undefined, {
      webSessionReattachTimeoutMs: 20,
    });
    const session = sessions.get('web-restore-superseded');
    if (session?.mode !== 'web') throw new Error('expected web session');
    const staleAdapter = session.adapterV2;
    const { onWebSessionPatch } =
      await import('../server/web-session-handler.js');
    const forwardedPatches: AgentPatchV2[] = [];
    const unlisten = onWebSessionPatch(session, (patch) => {
      forwardedPatches.push(patch);
    });

    await vi.waitFor(() =>
      expect(session.restoreState).toBe('reattach-failed')
    );
    const failureTurnId = session.agentSessionV2.turns[0]?.id;
    emitPatchOnDisconnect = {
      type: 'agent-session-snapshot-v2',
      sessionId: session.id,
      timestamp: new Date().toISOString(),
      session: emptyAgentSessionV2({
        id: session.id,
        provider: 'claude',
        cwd: configDir,
        capabilities,
      }),
    };
    await sessions.continueHereWeb(session.id);

    expect(createdAdapters).toHaveLength(2);
    expect(session.adapterV2).not.toBe(staleAdapter);
    expect(session.agentSessionV2.turns[0]?.id).toBe(failureTurnId);
    expect(
      forwardedPatches.filter(
        (patch) =>
          patch.type === 'agent-item-started-v2' &&
          patch.item.type === 'sessionBreak'
      )
    ).toHaveLength(1);
    const freshAdapter = session.adapterV2 as RestoreFailureAdapter;
    freshAdapter.emit({
      type: 'agent-live-state-updated-v2',
      sessionId: session.id,
      timestamp: new Date().toISOString(),
      live: {
        status: 'idle',
        activeTurnId: null,
        waitingOn: null,
        activeRequestIds: [],
        error: null,
      },
    });
    expect(session.agentSessionV2.live.status).toBe('idle');
    expect(forwardedPatches.at(-1)).toMatchObject({
      type: 'agent-live-state-updated-v2',
      live: { status: 'idle' },
    });

    settleResume?.();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    staleAdapter.emit({
      type: 'agent-live-state-updated-v2',
      sessionId: session.id,
      timestamp: new Date().toISOString(),
      live: {
        status: 'disconnected',
        activeTurnId: null,
        waitingOn: null,
        activeRequestIds: [],
        error: 'late stale restore',
      },
    });
    freshAdapter.emit({
      type: 'agent-live-state-updated-v2',
      sessionId: session.id,
      timestamp: new Date().toISOString(),
      live: {
        status: 'working',
        activeTurnId: 'fresh-turn',
        waitingOn: null,
        activeRequestIds: [],
        error: null,
      },
    });

    expect(session.adapterV2).toBe(freshAdapter);
    expect(session.agentSessionV2.live.status).toBe('working');
    expect(session.agentState).toBe('processing');
    unlisten();
  });

  it('supersedes a still-restoring adapter when Continue Here runs before timeout', async () => {
    let settleResume: (() => void) | undefined;
    resumeSession.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          settleResume = resolve;
        })
    );
    loadAllWebSessions.mockReturnValueOnce([
      {
        id: 'web-restore-midflight',
        vendor: 'claude',
        vendorSessionId: 'stored-provider-session',
        cwd: configDir,
        repoPath: null,
        worktreePath: null,
        branchName: null,
        displayName: 'midflight transport',
        workspaceId: null,
        agentSessionV2: emptyAgentSessionV2({
          id: 'web-restore-midflight',
          provider: 'claude',
          cwd: configDir,
          capabilities,
          providerSession: { claudeSessionId: 'stored-provider-session' },
        }),
        meta: {
          type: 'agent',
          agent: 'claude',
          customCommand: null,
          runtimeOwnership: 'attached',
          hookToken: 'midflight-restored-hook-token',
          adapterType: 'claude',
        },
        createdAt: Date.now() - 10_000,
        lastActivity: Date.now() - 5_000,
        status: 'active',
      },
    ]);

    const sessions = await import('../server/sessions.js');
    sessions.configure({ port: 4567, configDir });
    await sessions.restoreFromDisk(configDir, undefined, undefined, {
      webSessionReattachTimeoutMs: 1_000,
    });
    const session = sessions.get('web-restore-midflight');
    if (session?.mode !== 'web') throw new Error('expected web session');
    await vi.waitFor(() => expect(resumeSession).toHaveBeenCalledOnce());
    expect(session.restoreState).toBe('restoring');
    const staleAdapter = session.adapterV2;

    await sessions.continueHereWeb(session.id);
    const freshAdapter = session.adapterV2 as RestoreFailureAdapter;
    expect(freshAdapter).not.toBe(staleAdapter);
    freshAdapter.emit({
      type: 'agent-live-state-updated-v2',
      sessionId: session.id,
      timestamp: new Date().toISOString(),
      live: { status: 'idle', error: null },
    });
    settleResume?.();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    staleAdapter.emit({
      type: 'agent-session-snapshot-v2',
      sessionId: session.id,
      timestamp: new Date().toISOString(),
      session: emptyAgentSessionV2({
        id: session.id,
        provider: 'claude',
        cwd: configDir,
        capabilities,
      }),
    });
    freshAdapter.emit({
      type: 'agent-live-state-updated-v2',
      sessionId: session.id,
      timestamp: new Date().toISOString(),
      live: { status: 'working', activeTurnId: 'fresh-midflight-turn' },
    });

    expect(session.adapterV2).toBe(freshAdapter);
    expect(session.agentSessionV2.live.status).toBe('working');
    expect(session.agentSessionV2.live.activeTurnId).toBe(
      'fresh-midflight-turn'
    );
  });

  it('supersedes a killed restoring session and blocks every late persistence path', async () => {
    let settleResume: (() => void) | undefined;
    resumeSession.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          settleResume = resolve;
        })
    );
    loadAllWebSessions.mockReturnValueOnce([
      {
        id: 'web-restore-killed',
        vendor: 'claude',
        vendorSessionId: 'stored-provider-session',
        cwd: configDir,
        repoPath: null,
        worktreePath: null,
        branchName: null,
        displayName: 'killed transport',
        workspaceId: null,
        agentSessionV2: emptyAgentSessionV2({
          id: 'web-restore-killed',
          provider: 'claude',
          cwd: configDir,
          capabilities,
          providerSession: { claudeSessionId: 'stored-provider-session' },
        }),
        meta: {
          type: 'agent',
          agent: 'claude',
          customCommand: null,
          runtimeOwnership: 'attached',
          hookToken: 'killed-restored-hook-token',
          adapterType: 'claude',
        },
        createdAt: Date.now() - 10_000,
        lastActivity: Date.now() - 5_000,
        status: 'active',
      },
    ]);

    const sessions = await import('../server/sessions.js');
    sessions.configure({ port: 4567, configDir });
    await sessions.restoreFromDisk(configDir, undefined, undefined, {
      webSessionReattachTimeoutMs: 1_000,
    });
    const session = sessions.get('web-restore-killed');
    if (session?.mode !== 'web') throw new Error('expected web session');
    await vi.waitFor(() => expect(resumeSession).toHaveBeenCalledOnce());
    const staleAdapter = session.adapterV2 as RestoreFailureAdapter;
    upsertWebSessionNow.mockClear();

    sessions.kill(session.id);
    expect(deleteWebSession).toHaveBeenCalledWith(session.id);
    expect(sessions.get(session.id)).toBeUndefined();
    settleResume?.();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    staleAdapter.emit({
      type: 'agent-live-state-updated-v2',
      sessionId: session.id,
      timestamp: new Date().toISOString(),
      live: { status: 'idle', error: null },
    });

    expect(sessions.get(session.id)).toBeUndefined();
    expect(upsertWebSessionNow).not.toHaveBeenCalled();
    expect(disconnect).toHaveBeenCalled();
  });

  it('restores persisted free web sessions without synthesizing repo bindings', async () => {
    loadAllWebSessions.mockReturnValueOnce([
      {
        id: 'web-restore-free',
        vendor: 'claude',
        vendorSessionId: 'stored-free-provider-session',
        cwd: configDir,
        repoPath: null,
        worktreePath: null,
        branchName: null,
        displayName: 'free web restart session',
        workspaceId: null,
        agentSessionV2: emptyAgentSessionV2({
          id: 'web-restore-free',
          provider: 'claude',
          cwd: configDir,
          capabilities,
          providerSession: { claudeSessionId: 'stored-free-provider-session' },
        }),
        meta: {
          type: 'agent',
          agent: 'claude',
          customCommand: null,
          runtimeOwnership: 'attached',
          hookToken: 'free-restored-hook-token',
          adapterType: 'claude',
        },
        createdAt: Date.now() - 10_000,
        lastActivity: Date.now() - 5_000,
        status: 'active',
      },
    ]);

    const sessions = await import('../server/sessions.js');
    sessions.configure({ port: 4567, configDir });

    const restored = await sessions.restoreFromDisk(configDir);

    expect(restored).toBe(1);
    await vi.waitFor(() =>
      expect(resumeSession).toHaveBeenCalledWith('stored-free-provider-session')
    );

    const session = sessions.get('web-restore-free');
    expect(session).toBeTruthy();
    expect(session).not.toHaveProperty('repoPath');
    expect(session).not.toHaveProperty('worktreePath');
    expect(session).not.toHaveProperty('repoName');
    expect(session).not.toHaveProperty('branchName');
    expect(getSessionCategory(session!)).toBe('free');

    const summary = sessions.list().find((s) => s.id === 'web-restore-free');
    expect(summary).toBeDefined();
    expect(summary).not.toHaveProperty('repoPath');
    expect(summary).not.toHaveProperty('branchName');
    expect(summary).not.toHaveProperty('repoInstanceId');
    expect(summary).not.toHaveProperty('worktreeInstanceId');
    expect(summary).toMatchObject({
      mode: 'web',
      cwd: configDir,
      controlMode: 'human-driven',
      controlFreshness: 'unknown',
      lastInterventionAt: null,
      lastInterventionBy: null,
      lastInterventionEventId: null,
    });
    expect(upsertWebSessionNow).toHaveBeenLastCalledWith(session);
  });

  it('resumes a persisted Hermes session from its stored response id as a normal worker', async () => {
    supportsRuntimeEnvRefresh = false;
    loadAllWebSessions.mockReturnValueOnce([
      {
        id: 'web-restore-hermes',
        vendor: 'hermes',
        vendorSessionId: 'resp_stored',
        cwd: configDir,
        repoPath: null,
        worktreePath: null,
        branchName: null,
        displayName: 'hermes restart session',
        workspaceId: null,
        agentSessionV2: emptyAgentSessionV2({
          id: 'web-restore-hermes',
          provider: 'hermes',
          cwd: configDir,
          capabilities,
          // Hermes persists the last completed gateway response id under this
          // key; extractProviderSessionId must read it to resume chaining.
          providerSession: { hermesResponseId: 'resp_stored' },
        }),
        meta: {
          type: 'agent',
          agent: 'hermes',
          customCommand: null,
          runtimeOwnership: 'attached',
          hookToken: 'hermes-restored-hook-token',
          adapterType: 'hermes',
        },
        createdAt: Date.now() - 10_000,
        lastActivity: Date.now() - 5_000,
        status: 'active',
      },
    ]);

    const sessions = await import('../server/sessions.js');
    sessions.configure({ port: 4567, configDir });

    const restored = await sessions.restoreFromDisk(configDir);

    expect(restored).toBe(1);
    await vi.waitFor(() =>
      expect(resumeSession).toHaveBeenCalledWith('resp_stored')
    );
    expect(sessions.get('web-restore-hermes')?.role).toBeUndefined();
    expect(reconnect).not.toHaveBeenCalled();
  });
});
