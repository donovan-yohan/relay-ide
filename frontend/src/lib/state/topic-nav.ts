import type { WorkspaceSurface } from '../../../../shared/workspace-surfaces.js';
import type {
  WorkspaceTopic,
  WorkspaceTopicId,
} from '../../../../shared/workspace-topics.js';
import type { SessionSummary } from '../types.js';
import { isAttentionState, type DisplayState } from './display-state.js';
import { highestPriorityState } from './attention.js';
import { scopedSessionKey, sessionKeyMatches } from '../session-keys.js';

export type TopicNavTone = 'active' | 'attention' | 'idle' | 'empty' | 'error';
export type TopicNavKind = 'repo' | 'folder' | 'thread';

const DISPLAY_PRIORITY: Record<DisplayState, number> = {
  permission: 1000,
  'needs-answer': 900,
  error: 800,
  'unseen-idle': 500,
  running: 100,
  initializing: 50,
  'seen-idle': 10,
  inactive: 1,
};

export interface TopicNavSessionRef {
  id: string;
  selectKey: string;
  label: string;
  type: SessionSummary['type'];
  agent: SessionSummary['agent'];
  mode: SessionSummary['mode'] | null;
  status: SessionSummary['status'] | null;
  tone: TopicNavTone;
  displayState: DisplayState;
  agentState: SessionSummary['agentState'] | null;
  permissionType: SessionSummary['permissionType'] | null;
  branch: string | null;
  nodeId: string | null;
  cwd: string;
  controlFreshness: SessionSummary['controlFreshness'] | null;
  durability: SessionSummary['durability'] | null;
  currentActivity: SessionSummary['currentActivity'] | null;
  lastActivity: string | null;
}

export interface TopicNavParticipantRef {
  id: string;
  sessionId: string;
  selectKey: string;
  label: string;
  roleLabel: string;
  providerLabel: string;
  runtimeLabel: string;
  nodeId: string | null;
  tone: TopicNavTone;
  statusLabel: string;
  controlLabel: string;
  summaryLabel: string | null;
  lastActivity: string | null;
}

export interface TopicNavSurfaceRef {
  id: string;
  label: string;
  kind: WorkspaceSurface['kind'];
  health: WorkspaceSurface['health'];
  openMode: WorkspaceSurface['openMode'];
  target: string | null;
}

export interface TopicNavItem {
  id: WorkspaceTopicId;
  parentId: WorkspaceTopicId | null;
  title: string;
  description: string | null;
  badgeSeed: string;
  kind: TopicNavKind;
  kindLabel: string;
  pinned: boolean;
  muted: boolean;
  order: number;
  tone: TopicNavTone;
  statusLabel: string;
  attentionPriority: number;
  sessions: TopicNavSessionRef[];
  participants: TopicNavParticipantRef[];
  surfaces: TopicNavSurfaceRef[];
  taskRefs: NonNullable<WorkspaceTopic['linkedRefs']['taskRefs']>;
  childIds: WorkspaceTopicId[];
  routingLabel: string | null;
}

export interface TopicNavModel {
  items: TopicNavItem[];
  rootIds: WorkspaceTopicId[];
  byId: Map<WorkspaceTopicId, TopicNavItem>;
  derived: boolean;
}

function basename(path: string | undefined): string | null {
  if (!path) return null;
  const trimmed = path.replace(/[\\/]+$/, '');
  const segment = trimmed.split(/[\\/]/).pop();
  return segment && segment.length > 0 ? segment : trimmed || null;
}

function sessionSelectKey(session: SessionSummary): string {
  return scopedSessionKey(session);
}

function sessionTone(session: SessionSummary): TopicNavTone {
  if (session.agentState === 'error') return 'error';
  if (session.agentState === 'permission-prompt') return 'attention';
  if (session.agentState === 'waiting-for-input') return 'attention';
  if (session.status === 'disconnected') return 'error';
  if (session.controlFreshness === 'stale') return 'attention';
  if (
    session.agentState === 'processing' ||
    session.agentState === 'initializing'
  ) {
    return 'active';
  }
  return session.idle ? 'idle' : 'active';
}

function sessionDisplayState(session: SessionSummary): DisplayState {
  if (session.agentState === 'permission-prompt') {
    return session.permissionType === 'question'
      ? 'needs-answer'
      : 'permission';
  }
  if (session.agentState === 'waiting-for-input') return 'needs-answer';
  if (session.agentState === 'error') return 'error';
  if (session.status === 'disconnected') return 'error';
  if (session.agentState === 'processing') return 'running';
  if (session.agentState === 'initializing') return 'initializing';
  return 'seen-idle';
}

function sessionMatchesTopic(
  topic: WorkspaceTopic,
  session: SessionSummary
): boolean {
  const linked = topic.linkedRefs;
  if (linked.sessionIds?.some((id) => sessionKeyMatches(session, id))) {
    return true;
  }
  if (
    session.workContextId &&
    linked.workContextIds?.includes(session.workContextId)
  ) {
    return true;
  }
  const routing = topic.routingDefaults;
  if (routing.worktreePath && session.worktreePath === routing.worktreePath)
    return true;
  if (routing.repoPath && session.repoPath === routing.repoPath) return true;
  if (routing.cwd && session.cwd === routing.cwd) return true;
  return false;
}

function surfaceMatchesTopic(
  topic: WorkspaceTopic,
  surface: WorkspaceSurface
): boolean {
  if (topic.linkedRefs.workspaceSurfaceIds?.includes(surface.id)) return true;
  if (surface.workspaceId && surface.workspaceId === topic.workspaceId)
    return true;
  if (
    topic.routingDefaults.repoPath &&
    surface.repoPath === topic.routingDefaults.repoPath
  ) {
    return true;
  }
  return false;
}

function surfaceTarget(surface: WorkspaceSurface): string | null {
  return surface.url ?? surface.command ?? surface.logRef ?? null;
}

function topicKind(topic: WorkspaceTopic): {
  kind: TopicNavKind;
  label: string;
} {
  const routing = topic.routingDefaults;
  if (routing.repoPath || routing.worktreePath) {
    return { kind: 'repo', label: 'git repo' };
  }
  if (routing.cwd) {
    return { kind: 'folder', label: 'folder' };
  }
  return { kind: 'thread', label: 'topic' };
}

function routingLabel(topic: WorkspaceTopic): string | null {
  const routing = topic.routingDefaults;
  const parts = [
    routing.providerId,
    routing.nodeId,
    basename(routing.worktreePath) ??
      basename(routing.repoPath) ??
      basename(routing.cwd),
  ].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(' · ') : null;
}

type TopicParticipantRole = {
  label: string;
  patterns: RegExp[];
};

const TOPIC_PARTICIPANT_ROLES: TopicParticipantRole[] = [
  { label: 'product', patterns: [/\bkoi\b/i, /product/i] },
  { label: 'planner', patterns: [/\btako\b/i, /planner/i, /plan/i] },
  { label: 'frontend', patterns: [/\bika\b/i, /front.?end/i, /ui/i] },
  { label: 'backend', patterns: [/\bkani\b/i, /back.?end/i, /server/i] },
  { label: 'qa', patterns: [/\bkame\b/i, /\bqa\b/i, /test/i] },
  { label: 'review', patterns: [/\bfugu\b/i, /review/i] },
  { label: 'ops', patterns: [/\bkujira\b/i, /ops/i, /release/i] },
  { label: 'design', patterns: [/\bhotate\b/i, /design/i] },
];

function actorLabel(
  actor: NonNullable<SessionSummary['activeActors']>[number] | undefined
): string | null {
  if (!actor) return null;
  return actor.displayName ?? actor.id ?? actor.kind ?? null;
}

function sessionRoleLabel(session: SessionSummary): string {
  const peer = session.sessionEnvelope?.peerIdentity;
  const candidates = [
    actorLabel(session.activeWorker),
    ...((session.activeActors ?? [])
      .map(actorLabel)
      .filter(Boolean) as string[]),
    peer && 'displayName' in peer ? peer.displayName : undefined,
    peer && 'id' in peer ? peer.id : undefined,
    peer && 'adapter' in peer ? peer.adapter : undefined,
    session.displayName,
    session.agent,
  ].filter((value): value is string => Boolean(value));

  for (const candidate of candidates) {
    for (const role of TOPIC_PARTICIPANT_ROLES) {
      if (role.patterns.some((pattern) => pattern.test(candidate))) {
        return role.label;
      }
    }
  }

  if (session.type === 'terminal') return 'terminal';
  return 'agent';
}

function sessionProviderLabel(session: SessionSummary): string {
  const peer = session.sessionEnvelope?.peerIdentity;
  if (peer?.kind === 'agent') return peer.adapter;
  if (peer?.kind === 'local-user') return 'local user';
  if (peer?.kind === 'relay-node') return 'relay node';
  return session.agent || session.type;
}

function sessionRuntimeLabel(session: SessionSummary): string {
  const mode = session.mode ?? 'pty';
  return `${session.type} · ${mode}`;
}

function boundedSummary(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return trimmed.length > 96 ? `${trimmed.slice(0, 93)}...` : trimmed;
}

function sessionParticipantStatus(session: SessionSummary): {
  label: string;
  summary: string | null;
} {
  if (session.status === 'disconnected') {
    return { label: 'offline', summary: 'session disconnected' };
  }
  if (session.controlFreshness === 'stale') {
    return {
      label: 'stale',
      summary: boundedSummary(session.controlReason) ?? 'stale control state',
    };
  }
  if (session.agentState === 'permission-prompt') {
    return {
      label:
        session.permissionType === 'question'
          ? 'needs answer'
          : 'needs approval',
      summary: boundedSummary(
        session.currentActivity?.detail ?? session.currentActivity?.tool
      ),
    };
  }
  if (session.agentState === 'waiting-for-input') {
    return {
      label: 'needs input',
      summary: boundedSummary(
        session.currentActivity?.detail ?? session.currentActivity?.tool
      ),
    };
  }
  if (session.agentState === 'error') {
    return { label: 'error', summary: boundedSummary(session.controlReason) };
  }
  if (session.agentState === 'processing') {
    return {
      label: 'running',
      summary: boundedSummary(
        session.currentActivity?.detail ?? session.currentActivity?.tool
      ),
    };
  }
  if (session.agentState === 'initializing') {
    return { label: 'starting', summary: 'initializing session' };
  }
  return {
    label: session.idle ? 'idle' : 'active',
    summary: boundedSummary(
      session.currentActivity?.detail ?? session.controlReason
    ),
  };
}

function sessionControlLabel(session: SessionSummary): string {
  if (session.controlFreshness === 'stale') return 'control stale';
  if (session.controlFreshness === 'unknown') return 'control unknown';
  return session.controlMode ?? 'control unknown';
}

function topicParticipantRef(session: SessionSummary): TopicNavParticipantRef {
  const status = sessionParticipantStatus(session);
  const selectKey = sessionSelectKey(session);
  return {
    id: selectKey,
    sessionId: session.id,
    selectKey,
    label: session.displayName || basename(session.cwd) || session.id,
    roleLabel: sessionRoleLabel(session),
    providerLabel: sessionProviderLabel(session),
    runtimeLabel: sessionRuntimeLabel(session),
    nodeId: session.nodeId ?? null,
    tone: sessionTone(session),
    statusLabel: status.label,
    controlLabel: sessionControlLabel(session),
    summaryLabel: status.summary,
    lastActivity: session.lastActivity ?? null,
  };
}

function topicTone(
  sessions: TopicNavSessionRef[],
  surfaces: TopicNavSurfaceRef[],
  topic: WorkspaceTopic
): { tone: TopicNavTone; label: string; priority: number } {
  if (topic.status === 'archived') {
    return { tone: 'empty', label: 'archived', priority: 0 };
  }

  const displayStates = sessions.map((session) => session.displayState);
  if (surfaces.some((surface) => surface.health === 'unreachable')) {
    displayStates.push('error');
  }

  const attentionState = highestPriorityState(
    displayStates.filter(isAttentionState)
  );
  if (attentionState === 'permission' || attentionState === 'needs-answer') {
    return {
      tone: 'attention',
      label: 'needs input',
      priority: DISPLAY_PRIORITY[attentionState],
    };
  }
  if (attentionState === 'error') {
    return {
      tone: 'error',
      label: 'blocked',
      priority: DISPLAY_PRIORITY.error,
    };
  }
  if (attentionState === 'unseen-idle') {
    return {
      tone: 'attention',
      label: 'unread',
      priority: DISPLAY_PRIORITY['unseen-idle'],
    };
  }
  if (displayStates.includes('running')) {
    return {
      tone: 'active',
      label: 'active',
      priority: DISPLAY_PRIORITY.running,
    };
  }
  if (displayStates.includes('initializing')) {
    return {
      tone: 'active',
      label: 'starting',
      priority: DISPLAY_PRIORITY.initializing,
    };
  }
  if (sessions.length > 0) {
    return {
      tone: 'idle',
      label: 'idle',
      priority: DISPLAY_PRIORITY['seen-idle'],
    };
  }
  if (surfaces.length > 0) {
    return {
      tone: 'idle',
      label: 'surfaces',
      priority: DISPLAY_PRIORITY.inactive,
    };
  }
  return { tone: 'empty', label: 'empty', priority: 0 };
}

function compareItems(a: TopicNavItem, b: TopicNavItem): number {
  if (a.attentionPriority !== b.attentionPriority) {
    return b.attentionPriority - a.attentionPriority;
  }
  if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
  if (a.order !== b.order) return a.order - b.order;
  return a.title.localeCompare(b.title);
}

function wouldCreateCycle(
  childId: WorkspaceTopicId,
  parentId: WorkspaceTopicId,
  byId: Map<WorkspaceTopicId, TopicNavItem>
): boolean {
  const seen = new Set<WorkspaceTopicId>();
  let currentId: WorkspaceTopicId | null = parentId;
  while (currentId) {
    if (currentId === childId || seen.has(currentId)) return true;
    seen.add(currentId);
    currentId = byId.get(currentId)?.parentId ?? null;
  }
  return false;
}

export function buildTopicNavModel(input: {
  topics: WorkspaceTopic[];
  sessions: SessionSummary[];
  surfaces: WorkspaceSurface[];
  derived?: boolean;
}): TopicNavModel {
  const items: TopicNavItem[] = input.topics.map((topic) => {
    const matchedSessions = input.sessions.filter((session) =>
      sessionMatchesTopic(topic, session)
    );
    const sessions = matchedSessions
      .map(
        (session): TopicNavSessionRef => ({
          id: session.id,
          selectKey: sessionSelectKey(session),
          label: session.displayName || basename(session.cwd) || session.id,
          type: session.type,
          agent: session.agent,
          mode: session.mode ?? null,
          status: session.status ?? null,
          tone: sessionTone(session),
          displayState: sessionDisplayState(session),
          agentState: session.agentState ?? null,
          permissionType: session.permissionType ?? null,
          branch: session.branchName ?? null,
          nodeId: session.nodeId ?? null,
          cwd: session.cwd,
          controlFreshness: session.controlFreshness ?? null,
          durability: session.durability ?? null,
          currentActivity: session.currentActivity ?? null,
          lastActivity: session.lastActivity ?? null,
        })
      )
      .sort((a, b) => a.label.localeCompare(b.label));

    const surfaces = input.surfaces
      .filter((surface) => surfaceMatchesTopic(topic, surface))
      .map(
        (surface): TopicNavSurfaceRef => ({
          id: surface.id,
          label: surface.label,
          kind: surface.kind,
          health: surface.health,
          openMode: surface.openMode,
          target: surfaceTarget(surface),
        })
      )
      .sort((a, b) => a.label.localeCompare(b.label));

    const tone = topicTone(sessions, surfaces, topic);
    const participants = matchedSessions
      .map(topicParticipantRef)
      .sort((a, b) => {
        if (a.roleLabel !== b.roleLabel) {
          return a.roleLabel.localeCompare(b.roleLabel);
        }
        if (a.providerLabel !== b.providerLabel) {
          return a.providerLabel.localeCompare(b.providerLabel);
        }
        return a.label.localeCompare(b.label);
      });
    const kind = topicKind(topic);
    const order = topic.grouping.order ?? Number.MAX_SAFE_INTEGER;
    return {
      id: topic.id,
      parentId: topic.grouping.parentTopicId ?? null,
      title: topic.display.title,
      description: topic.display.description ?? null,
      badgeSeed: topic.workspaceId || topic.display.title,
      kind: kind.kind,
      kindLabel: kind.label,
      pinned: topic.state.pinned,
      muted: topic.state.muted,
      order,
      tone: tone.tone,
      statusLabel: tone.label,
      attentionPriority: tone.priority,
      sessions,
      participants,
      surfaces,
      taskRefs: topic.linkedRefs.taskRefs ?? [],
      childIds: [],
      routingLabel: routingLabel(topic),
    };
  });

  const byId = new Map<WorkspaceTopicId, TopicNavItem>();
  for (const item of items) byId.set(item.id, item);
  const rootIds: WorkspaceTopicId[] = [];
  for (const item of items) {
    if (
      item.parentId &&
      item.parentId !== item.id &&
      byId.has(item.parentId) &&
      !wouldCreateCycle(item.id, item.parentId, byId)
    ) {
      byId.get(item.parentId)!.childIds.push(item.id);
    } else {
      rootIds.push(item.id);
    }
  }
  for (const item of items)
    item.childIds.sort((a, b) => compareItems(byId.get(a)!, byId.get(b)!));
  rootIds.sort((a, b) => compareItems(byId.get(a)!, byId.get(b)!));

  return { items, rootIds, byId, derived: input.derived ?? false };
}
