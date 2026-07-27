import crypto from 'node:crypto';

import type { AgentPatchV2 } from '../shared/agent-chat-protocol-v2.js';
import {
  collaborationPromptAppendix,
  type AgentRole,
} from '../shared/agent-roster.js';
import type { ControlStateSummary } from '../shared/control-state.js';
import type {
  OrchestratorCredentialLifecycle,
  OrchestratorCredentialLifecycleDeps,
} from './orchestrator-credential-lifecycle.js';
import { startOrchestratorCredentialLifecycle } from './orchestrator-credential-lifecycle.js';
import type { AdapterConfig } from './protocol-adapter.js';
import type { ProtocolAdapterV2 } from './protocol-adapter-v2.js';
import { createAdapterV2 } from './protocol-adapters/index.js';
import { createLogger } from './logger.js';

const logger = createLogger('channel-agent-runtime');

export interface CreateChannelAgentRuntimeParams {
  id?: string;
  providerId: string;
  profileActorId: string;
  role?: AgentRole;
  cwd: string;
  repoPath?: string;
  worktreePath?: string | null;
  displayName: string;
  port: number;
  configDir: string;
  permissionMode?: string;
  model?: string;
  systemPrompt?: string;
  processEnv?: Record<string, string>;
  additionalDirs?: string[];
  controlState?: ControlStateSummary;
  providerSession?: Record<string, unknown>;
  extra?: Record<string, unknown>;
}

/**
 * Private execution handle for one agent participant in a channel.
 *
 * This is deliberately not a Relay Session. It is absent from session lists,
 * REST session controls, terminal WebSockets, WorkContext tabs, and startup
 * session restoration. ChannelAgentBinder is its sole product-facing owner.
 */
export interface ChannelAgentRuntime {
  id: string;
  providerId: string;
  profileActorId: string;
  role?: AgentRole;
  cwd: string;
  repoPath?: string;
  worktreePath?: string | null;
  displayName: string;
  hookToken: string;
  hooksActive: boolean;
  status: 'active' | 'disconnected';
  agentState:
    | 'initializing'
    | 'idle'
    | 'processing'
    | 'waiting-for-input'
    | 'permission-prompt'
    | 'error';
  idle: boolean;
  currentActivity?: { tool: string; detail?: string };
  branchName?: string;
  needsBranchRename: boolean;
  lastActivity: string;
  adapter: ProtocolAdapterV2;
  providerSession: Record<string, string>;
}

type RuntimeEndHandler = (runtimeId: string) => void;

let orchestratorCredentialAuthority:
  | Pick<
      OrchestratorCredentialLifecycleDeps,
      'issueCredential' | 'revokeCredential'
    >
  | undefined;

export function configureChannelAgentRuntimes(input: {
  orchestratorCredentials?: Pick<
    OrchestratorCredentialLifecycleDeps,
    'issueCredential' | 'revokeCredential'
  >;
}): void {
  orchestratorCredentialAuthority = input.orchestratorCredentials;
}

function providerResumeId(
  providerId: string,
  state: Record<string, unknown> | undefined
): string | undefined {
  if (!state) return undefined;
  const key =
    providerId === 'claude'
      ? 'claudeSessionId'
      : providerId === 'codex'
        ? 'threadId'
        : providerId === 'hermes'
          ? 'hermesResponseId'
          : undefined;
  if (!key) return undefined;
  const value = state[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function providerSessionFromPatch(
  patch: AgentPatchV2
): Record<string, string> | undefined {
  if (patch.type === 'agent-session-updated-v2') {
    return patch.providerSession;
  }
  if (patch.type === 'agent-session-snapshot-v2') {
    return patch.session.providerSession;
  }
  return undefined;
}

export class ChannelAgentRuntimeManager {
  private readonly runtimes = new Map<string, ChannelAgentRuntime>();
  private readonly endHandlers = new Set<RuntimeEndHandler>();
  private readonly leases = new Map<string, OrchestratorCredentialLifecycle>();
  private readonly patchUnlisteners = new Map<string, () => void>();

  get(id: string): ChannelAgentRuntime | undefined {
    return this.runtimes.get(id);
  }

  onRuntimeEnd(handler: RuntimeEndHandler): () => void {
    this.endHandlers.add(handler);
    return () => this.endHandlers.delete(handler);
  }

  async create(
    params: CreateChannelAgentRuntimeParams
  ): Promise<ChannelAgentRuntime> {
    const id = params.id ?? crypto.randomBytes(8).toString('hex');
    if (this.runtimes.has(id)) {
      throw new Error(`Channel agent runtime already exists: ${id}`);
    }
    const adapter = createAdapterV2(params.providerId);
    const hookToken = crypto.randomBytes(16).toString('hex');
    let lease: OrchestratorCredentialLifecycle | undefined;
    let processEnv = { ...(params.processEnv ?? {}) };

    if (params.role === 'orchestrator') {
      if (!adapter.refreshRuntimeEnv) {
        throw new Error(
          `Agent adapter ${params.providerId} does not support orchestrator credential refresh`
        );
      }
      if (!orchestratorCredentialAuthority) {
        throw new Error(
          'Orchestrator actor credential authority is not configured'
        );
      }
      lease = startOrchestratorCredentialLifecycle(
        {
          runtimeId: id,
          profileActorId: params.profileActorId,
          port: params.port,
          ...(params.displayName ? { displayName: params.displayName } : {}),
        },
        {
          ...orchestratorCredentialAuthority,
          applyRuntimeEnv: async (nextEnv) => {
            const runtime = this.runtimes.get(id);
            if (
              !runtime ||
              runtime.status !== 'active' ||
              runtime.role !== 'orchestrator' ||
              !runtime.adapter.refreshRuntimeEnv
            ) {
              throw new Error(
                'Orchestrator runtime unavailable during credential refresh'
              );
            }
            await runtime.adapter.refreshRuntimeEnv(nextEnv);
          },
          failClosed: () => {
            void this.destroy(id);
          },
        }
      );
      processEnv = { ...processEnv, ...lease.processEnv };
    }

    const now = new Date().toISOString();
    const runtime: ChannelAgentRuntime = {
      id,
      providerId: params.providerId,
      profileActorId: params.profileActorId,
      ...(params.role ? { role: params.role } : {}),
      cwd: params.cwd,
      ...(params.repoPath ? { repoPath: params.repoPath } : {}),
      ...(params.worktreePath !== undefined
        ? { worktreePath: params.worktreePath }
        : {}),
      displayName: params.displayName,
      hookToken,
      hooksActive: true,
      status: 'active',
      agentState: 'initializing',
      idle: true,
      needsBranchRename: false,
      lastActivity: now,
      adapter,
      providerSession: {},
    };
    this.runtimes.set(id, runtime);
    if (lease) this.leases.set(id, lease);

    const unlisten = adapter.onPatch((patch) => {
      if (this.runtimes.get(id) !== runtime) return;
      const providerSession = providerSessionFromPatch(patch);
      if (providerSession) {
        runtime.providerSession = {
          ...runtime.providerSession,
          ...providerSession,
        };
      }
      runtime.lastActivity = new Date().toISOString();
      if (patch.type === 'agent-live-state-updated-v2') {
        runtime.idle = patch.live.status === 'idle';
        runtime.agentState =
          patch.live.status === 'working'
            ? 'processing'
            : patch.live.status === 'waiting'
              ? patch.live.waitingOn === 'approval'
                ? 'permission-prompt'
                : 'waiting-for-input'
              : patch.live.status === 'error'
                ? 'error'
                : 'idle';
      }
    });
    this.patchUnlisteners.set(id, unlisten);

    const config: AdapterConfig = {
      cwd: params.cwd,
      port: params.port,
      sessionId: id,
      hookToken,
      configDir: params.configDir,
      systemPromptAppendix: [
        collaborationPromptAppendix({
          provider: params.providerId,
          ...(params.role ? { role: params.role } : {}),
        }),
        params.systemPrompt,
      ]
        .filter((part): part is string => Boolean(part?.trim()))
        .join('\n\n'),
      ...(Object.keys(processEnv).length > 0 ? { processEnv } : {}),
      ...(params.permissionMode
        ? { permissionMode: params.permissionMode }
        : {}),
      ...(params.model ? { model: params.model } : {}),
      ...(params.extra ? { extra: params.extra } : {}),
    };

    const savedResumeId = providerResumeId(
      params.providerId,
      params.providerSession
    );
    try {
      await adapter.connect(config);
      if (savedResumeId && adapter.capabilities.resume) {
        await adapter.resumeSession(savedResumeId);
      }
      runtime.agentState = 'idle';
      runtime.idle = true;
      return runtime;
    } catch (error) {
      this.runtimes.delete(id);
      this.patchUnlisteners.get(id)?.();
      this.patchUnlisteners.delete(id);
      this.leases.get(id)?.stop();
      this.leases.delete(id);
      runtime.status = 'disconnected';
      runtime.agentState = 'error';
      await adapter.disconnect().catch(() => {});
      throw error;
    }
  }

  async destroy(id: string): Promise<void> {
    const runtime = this.runtimes.get(id);
    if (!runtime) return;
    this.runtimes.delete(id);
    this.patchUnlisteners.get(id)?.();
    this.patchUnlisteners.delete(id);
    this.leases.get(id)?.stop();
    this.leases.delete(id);
    runtime.status = 'disconnected';
    runtime.hooksActive = false;
    await runtime.adapter.disconnect().catch(() => {});
    for (const handler of [...this.endHandlers]) {
      try {
        handler(id);
      } catch (error) {
        logger.warn('channel runtime end handler failed', {
          runtimeId: id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  async close(): Promise<void> {
    await Promise.allSettled(
      [...this.runtimes.keys()].map((id) => this.destroy(id))
    );
    this.endHandlers.clear();
  }
}

export const channelAgentRuntimes = new ChannelAgentRuntimeManager();
