import crypto from 'node:crypto';

import type {
  AgentPatchV2,
  AgentSessionLiveStateV2,
} from '../shared/agent-chat-protocol-v2.js';
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
          : providerId === 'prime-agent'
            ? 'primeAgentSessionId'
            : providerId === 'pi'
              ? 'piSessionId'
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

type ChannelAgentState = ChannelAgentRuntime['agentState'];

/** A state that owes its answer to a human, not to the model. */
function parkedOnOperator(state: ChannelAgentState): boolean {
  return state === 'permission-prompt' || state === 'waiting-for-input';
}

/**
 * Map a live state onto a run state.
 *
 * `authoritative` marks a COMPLETE live state (the one embedded in
 * `agent-session-snapshot-v2`), whose `waitingOn` can be trusted. An incremental
 * `agent-live-state-updated-v2` is a `Partial`, and its `idle` may be a compat
 * artifact rather than a real one — see `nextAgentState`.
 */
function stateFromLive(
  current: ChannelAgentState,
  live: Partial<AgentSessionLiveStateV2>,
  authoritative: boolean
): ChannelAgentState | undefined {
  const status = live.status;
  if (!status) return undefined;
  switch (status) {
    case 'working':
      return 'processing';
    case 'waiting':
      switch (live.waitingOn) {
        case 'approval':
          return 'permission-prompt';
        case 'question':
        case 'plan':
          return 'waiting-for-input';
        default:
          // `tool`/`network` — and a wait that names no counterparty — are the
          // runtime waiting on itself. The turn is still running and nobody owes
          // it an answer, so this must NOT park the machine: a system wait that
          // parked would swallow the real `idle` that ends the turn.
          return 'processing';
      }
    case 'error':
      return 'error';
    default:
      // `idle` and `disconnected` both claim "no turn is running", which is a
      // lie while a prompt is outstanding.
      return !authoritative && parkedOnOperator(current) ? undefined : 'idle';
  }
}

/**
 * Derive the next `agentState` from an adapter patch, or `undefined` when the
 * patch carries no run-state signal at all (#1254).
 *
 * `agentState` is internal runtime bookkeeping: the status the channel UI
 * renders is `ChannelAgentBinder`'s separate `binding.status`. This reducer
 * exists so the field stops contradicting itself, not to move a rendered
 * surface.
 *
 * Three rules keep the machine honest:
 *
 *  - `agent-live-state-updated-v2` carries a PARTIAL live state: every field is
 *    optional and a patch may narrow to a single key. `rejectQueued` emits a
 *    bare `{ queueLength: 0 }`, and in `claude-adapter` that fires MID-TURN when
 *    a runtime-env refresh boundary fails. A statusless patch says nothing about
 *    the run state, so it must not be read as "idle" — the previous mapping
 *    collapsed every statusless patch to `idle` while forcing `runtime.idle` to
 *    `false`, so the two fields disagreed.
 *  - A bare `idle` cannot clear a prompt the operator still owes an answer to.
 *    `hermes-adapter` fires `chat:session-status {status:'idle',
 *    waitingOn:'approval'}` next to a permission prompt, and
 *    `shared/agent-chat-v1-compat.ts` maps every `idle` to `{status:'idle',
 *    waitingOn:null}` — so a bare mid-approval idle is indistinguishable from a
 *    real one. Ignore it while parked, the same rule `ChannelAgentBinder`
 *    applies (#1181 defect 3). Only waits a HUMAN owes an answer to park the
 *    machine; a `tool`/`network` wait keeps running. The exits from a parked
 *    state are a turn terminal (it ends the turn that owned the prompt), the
 *    next live state that names a status, and a complete snapshot.
 *  - Turn lifecycle is a run-state signal in its own right. Nothing in the
 *    protocol requires an adapter to pair a full live state with every turn, so
 *    a started turn — or the first output item of one — moves a fresh runtime
 *    off `initializing`, and a completed turn lands it on `idle`.
 *    `agent-session-snapshot-v2` carries a complete live state for the same
 *    reason: a resume that delivers only a snapshot still has to leave
 *    `initializing`.
 *
 * `agent-error-v2` is deliberately NOT a run-state signal: adapters also use it
 * for input-validation complaints that leave the run untouched (codex answers a
 * malformed `/resume` or `/goal` with one). The run state comes from the turn
 * terminal or live `status:'error'` that follows a real failure.
 */
function nextAgentState(
  current: ChannelAgentState,
  patch: AgentPatchV2
): ChannelAgentState | undefined {
  switch (patch.type) {
    case 'agent-live-state-updated-v2':
      return stateFromLive(current, patch.live, false);
    case 'agent-session-snapshot-v2':
      return stateFromLive(current, patch.session.live, true);
    case 'agent-turn-started-v2':
      return 'processing';
    case 'agent-turn-completed-v2':
      return 'idle';
    case 'agent-item-started-v2':
      // An approval item IS the prompt, whatever live state the adapter pairs
      // with it (codex pairs `waiting`/`approval`; not every adapter does).
      if (patch.item.type === 'approval') return 'permission-prompt';
      return current === 'initializing' ? 'processing' : undefined;
    case 'agent-item-delta-v2':
      // First output of the first turn. Only promote out of `initializing`:
      // mid-turn items must never clobber an outstanding prompt.
      return current === 'initializing' ? 'processing' : undefined;
    default:
      return undefined;
  }
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
      if (
        patch.type === 'agent-live-state-updated-v2' &&
        patch.live.status === 'disconnected'
      ) {
        // Unexpected process/transport death (#1307). Adapters emit this only
        // when the child went away on its own — a deliberate `disconnect()`
        // detaches first — and none of them respawn on the next send, so the
        // runtime is dead, not resting. Ending it here is what turns a silent
        // death into the terminal `onRuntimeEnd` notification the channel binder
        // needs to release its binding and broadcast idle presence; without it
        // the runtime stays 'active' in this registry forever.
        //
        // This runs BEFORE `nextAgentState` (#1254) deliberately: that reducer
        // maps `disconnected` onto `idle` — and drops it entirely while the
        // machine is parked on an operator prompt — which is the right reading
        // for a live runtime but would leave a dead one wedged.
        logger.warn('channel runtime reported disconnected; ending it', {
          runtimeId: id,
          providerId: runtime.providerId,
        });
        runtime.agentState = 'error';
        runtime.idle = true;
        void this.destroy(id);
        return;
      }
      const next = nextAgentState(runtime.agentState, patch);
      if (next) {
        runtime.agentState = next;
        runtime.idle = next === 'idle';
      }
    });
    this.patchUnlisteners.set(id, unlisten);

    const savedResumeId = providerResumeId(
      params.providerId,
      params.providerSession
    );

    const config: AdapterConfig = {
      cwd: params.cwd,
      port: params.port,
      sessionId: id,
      hookToken,
      configDir: params.configDir,
      ...(savedResumeId && adapter.resumesProviderSessionDuringConnect
        ? { resumeSessionId: savedResumeId }
        : {}),
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

    try {
      await adapter.connect(config);
      if (
        savedResumeId &&
        adapter.capabilities.resume &&
        !adapter.resumesProviderSessionDuringConnect
      ) {
        await adapter.resumeSession(savedResumeId);
      }
      // The child can die INSIDE those awaits (#1307). Adapters flip to
      // 'connected' partway through connect/resume, so the disconnect listener
      // above is live and may already have ended this runtime — dropping it from
      // the registry and disconnecting its adapter. Returning it anyway would
      // hand the caller a corpse: the channel binder would attach a bridge to a
      // dead adapter and persist `runtimeId` durably for a runtime that no
      // longer exists. Fail instead, so the caller's normal spawn-failure path
      // runs.
      if (this.runtimes.get(id) !== runtime) {
        throw new Error('Channel agent runtime died during connect');
      }
      // Promote out of `initializing` only (#1254). Adapters emit patches from
      // inside `connect()`/`resumeSession()` (codex emits its snapshot and live
      // state before `connect` resolves), so the listener above can already have
      // recorded a live turn — stamping `idle` unconditionally here erased it.
      if (runtime.agentState === 'initializing') {
        runtime.agentState = 'idle';
        runtime.idle = true;
      }
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
