import {
  applyAgentPatchV2,
  emptyAgentSessionV2,
  type AgentPatchV2,
  type AgentProviderV2,
  type AgentSessionV2,
} from '../shared/agent-chat-protocol-v2.js';
import type { AgentCapabilitySetV2 } from '../shared/agent-chat-protocol-v2.js';
import type { WebSession } from './types.js';

const AGENT_PATCH_BUFFER_MAX = 1000;

export interface CreateInitialAgentSessionV2Params {
  id: string;
  provider: string;
  cwd: string;
  capabilities?: AgentCapabilitySetV2;
  providerSession?: Record<string, string>;
  model?: string;
  permissionMode?: string;
  additionalDirs?: string[];
  providerOptions?: Record<string, unknown>;
}

export function createInitialAgentSessionV2(
  params: CreateInitialAgentSessionV2Params
): AgentSessionV2 {
  return emptyAgentSessionV2({
    id: params.id,
    provider: params.provider as AgentProviderV2,
    cwd: params.cwd,
    capabilities: params.capabilities ?? {},
    ...(params.providerSession !== undefined
      ? { providerSession: params.providerSession }
      : {}),
    config: {
      ...(params.model !== undefined ? { model: params.model } : {}),
      ...(params.permissionMode !== undefined
        ? { permissionMode: params.permissionMode }
        : {}),
      ...(params.additionalDirs !== undefined
        ? { additionalDirectories: params.additionalDirs }
        : {}),
      ...(params.providerOptions !== undefined
        ? { providerOptions: params.providerOptions }
        : {}),
    },
  });
}

export function applyWebSessionPatchV2(
  session: WebSession,
  patch: AgentPatchV2
): void {
  session.agentSessionV2 = applyAgentPatchV2(session.agentSessionV2, patch);
  pushAgentPatchToBuffer(session, patch);
}

export function pushAgentPatchToBuffer(
  session: WebSession,
  patch: AgentPatchV2
): void {
  if (session.agentPatchesV2.length >= AGENT_PATCH_BUFFER_MAX) {
    const evictIdx = session.agentPatchesV2.findIndex(
      (candidate) => !isPendingApprovalPatch(candidate, session.agentSessionV2)
    );
    if (evictIdx !== -1) {
      session.agentPatchesV2.splice(evictIdx, 1);
    } else {
      session.agentPatchesV2.shift();
    }
  }

  session.agentPatchesV2.push(patch);
}

export function createAgentSessionSnapshotPatch(
  session: WebSession
): AgentPatchV2 {
  return {
    type: 'agent-session-snapshot-v2',
    sessionId: session.id,
    timestamp: new Date().toISOString(),
    session: session.agentSessionV2,
  };
}

function isPendingApprovalPatch(
  patch: AgentPatchV2,
  agentSession: AgentSessionV2
): boolean {
  return (
    patch.type === 'agent-item-started-v2' &&
    patch.item.type === 'approval' &&
    agentSession.live.activeRequestIds.includes(patch.item.requestId)
  );
}
