import * as sessionsModule from './sessions.js';
import type { CreateResult } from './sessions.js';
import type { CreateParams } from './sessions.js';
import type { CreateWebParams } from './web-session-handler.js';
import type { SessionRenewResult } from './session-envelope-registry.js';
import type { Session, SessionSummary } from './types.js';
import type { InterventionRecord, TabControlEvent, ControlActor } from '../shared/control-state.js';
import type { SessionControlError } from './session-control-api.js';
import {
  DEFAULT_LOCAL_ENVIRONMENT_ID,
  createLocalEventAuthority,
  createNodeScopedFileEvent,
  createNodeScopedSessionEvent,
  type EnvironmentId,
  type NodeEventAuthority,
  type NodeScopedFileEvent,
  type NodeScopedSessionEvent,
} from '../shared/node-boundary.js';
import { DEFAULT_LOCAL_NODE_ID, type NodeId } from '../shared/identity.js';

export interface NodeSessionBoundary {
  list(): SessionSummary[];
  get(id: string): Session | undefined;
  create(params: CreateParams): CreateResult;
  renew(input: {
    id: string;
    expiresAt: string;
    now?: Date;
  }): SessionRenewResult;
  createWeb(params: CreateWebParams): Promise<{ session: SessionSummary }>;
  kill(id: string): void;
  updateDisplayName(
    id: string,
    displayName: string
  ): { id: string; displayName: string };
  write(id: string, data: string): void;
  getInterventions(id: string, options?: { nodeId?: string; limit?: number }): InterventionRecord[];
  handBackToAgent(input: {
    id: string;
    latestSeenInterventionEventId?: string;
    actor?: ControlActor;
  }):
    | { ok: true; events: TabControlEvent[]; ackedHumanInterventions: number }
    | { ok: false; error: SessionControlError };
}

type LocalRelayNodeSessionOverrides = Partial<{
  [K in keyof NodeSessionBoundary]: (
    ...args: Parameters<NodeSessionBoundary[K]>
  ) => ReturnType<NodeSessionBoundary[K]>;
}>;

export interface LocalRelayNodeDeps {
  sessions?: LocalRelayNodeSessionOverrides;
  nodeId?: NodeId;
  environmentId?: EnvironmentId;
}

export interface LocalRelayNode {
  nodeId: NodeId;
  environmentId: EnvironmentId;
  authority(): NodeEventAuthority;
  sessionEventScope(sessionId: string): NodeScopedSessionEvent;
  fileEventScope(input: {
    workspacePath: string;
    worktreePath?: string | null;
  }): NodeScopedFileEvent;
  sessions: NodeSessionBoundary;
}

const defaultSessionBoundary: NodeSessionBoundary = {
  list: sessionsModule.list,
  get: sessionsModule.get,
  create: sessionsModule.create,
  renew: sessionsModule.renew,
  createWeb: sessionsModule.createWeb,
  kill: sessionsModule.kill,
  updateDisplayName: sessionsModule.updateDisplayName,
  write: sessionsModule.write,
  getInterventions: sessionsModule.getInterventions,
  handBackToAgent: sessionsModule.handBackToAgent,
};

export function createLocalRelayNode(
  deps: LocalRelayNodeDeps = {}
): LocalRelayNode {
  const nodeId = deps.nodeId ?? DEFAULT_LOCAL_NODE_ID;
  const environmentId = deps.environmentId ?? DEFAULT_LOCAL_ENVIRONMENT_ID;
  const sessionBoundary = {
    ...defaultSessionBoundary,
    ...deps.sessions,
  } as NodeSessionBoundary;

  return {
    nodeId,
    environmentId,
    authority: () => createLocalEventAuthority({ nodeId, environmentId }),
    sessionEventScope: (sessionId: string) =>
      createNodeScopedSessionEvent(sessionId, { nodeId, environmentId }),
    fileEventScope: ({ workspacePath, worktreePath }) =>
      createNodeScopedFileEvent({
        workspacePath,
        ...(worktreePath !== undefined ? { worktreePath } : {}),
        nodeId,
        environmentId,
      }),
    sessions: sessionBoundary,
  };
}
