import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { emptyAgentSessionV2 } from '../shared/agent-chat-protocol-v2.js';
import type {
  AgentCapabilitySetV2,
  AgentPatchV2,
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

class RestoreFailureAdapter implements ProtocolAdapterV2 {
  readonly agentType = 'claude';
  readonly runtimeOwnership = 'attached' as const;
  readonly capabilities = capabilities;
  readonly status: AdapterStatus = 'connected';
  private handlers = new Set<AgentPatchHandlerV2>();

  async connect(_config: AdapterConfig): Promise<void> {}
  async disconnect(): Promise<void> {
    this.handlers.clear();
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
}

vi.mock('../server/relay-state-db.js', () => ({
  loadAllWebSessions,
  upsertWebSessionNow,
  deleteWebSession,
  scheduleWebSessionUpsert,
}));

vi.mock('../server/protocol-adapters/index.js', () => ({
  createAdapterV2: () => new RestoreFailureAdapter(),
}));

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
          repoName: 'relay-ide',
          customCommand: null,
          runtimeOwnership: 'attached',
          hookToken: 'restored-hook-token',
          adapterType: 'claude',
          needsBranchRename: true,
          additionalDirs: [path.join(configDir, 'extra')],
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
    expect(resumeSession).toHaveBeenCalledWith('stored-provider-session');
    expect(reconnect).not.toHaveBeenCalled();

    const session = sessions.get('web-restore-failure');
    expect(session).toBeTruthy();
    expect(session!.mode).toBe('web');
    if (session?.mode !== 'web') throw new Error('expected web session');
    expect(session.hookToken).toBe('restored-hook-token');
    expect(session.needsBranchRename).toBe(true);
    expect(session.workspaceId).toBe('workspace-1');
    expect(session.additionalDirs).toEqual([path.join(configDir, 'extra')]);
    expect(session.status).toBe('disconnected');
    expect(session.agentState).toBe('error');
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
    expect(resumeSession).toHaveBeenCalledWith('stored-free-provider-session');

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
    expect(summary).toMatchObject({ mode: 'web', cwd: configDir });
    expect(upsertWebSessionNow).toHaveBeenLastCalledWith(session);
  });
});
