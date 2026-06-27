import type { WorkspaceSurface } from '../../../../shared/workspace-surfaces.js';
import type {
  WorkspaceTopic,
  WorkspaceTopicId,
} from '../../../../shared/workspace-topics.js';
import type { SessionSummary } from '../types.js';
import { isAttentionState, type DisplayState } from './display-state.js';
import { highestPriorityState } from './attention.js';

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
  badgeText: string;
  kind: TopicNavKind;
  kindLabel: string;
  pinned: boolean;
  muted: boolean;
  order: number;
  tone: TopicNavTone;
  statusLabel: string;
  attentionPriority: number;
  sessions: TopicNavSessionRef[];
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
  return session.globalSessionId ?? session.id;
}

function sessionTone(session: SessionSummary): TopicNavTone {
  if (session.agentState === 'error') return 'error';
  if (session.agentState === 'permission-prompt') return 'attention';
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
  if (session.agentState === 'error') return 'error';
  if (session.agentState === 'processing') return 'running';
  if (session.agentState === 'initializing') return 'initializing';
  return 'seen-idle';
}

function sessionMatchesTopic(
  topic: WorkspaceTopic,
  session: SessionSummary
): boolean {
  const linked = topic.linkedRefs;
  if (
    linked.sessionIds?.some(
      (id) => id === session.id || id === session.globalSessionId
    )
  ) {
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
    return { tone: 'error', label: 'error', priority: DISPLAY_PRIORITY.error };
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
  const items: TopicNavItem[] = input.topics.map((topic, index) => {
    const sessions = input.sessions
      .filter((session) => sessionMatchesTopic(topic, session))
      .map(
        (session): TopicNavSessionRef => ({
          id: session.id,
          selectKey: sessionSelectKey(session),
          label: session.displayName || basename(session.cwd) || session.id,
          type: session.type,
          agent: session.agent,
          mode: session.mode ?? null,
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
    const kind = topicKind(topic);
    const order = topic.grouping.order ?? Number.MAX_SAFE_INTEGER;
    const badgeText = String(
      Number.isSafeInteger(topic.grouping.order)
        ? topic.grouping.order! + 1
        : index + 1
    );
    return {
      id: topic.id,
      parentId: topic.grouping.parentTopicId ?? null,
      title: topic.display.title,
      description: topic.display.description ?? null,
      badgeSeed: topic.workspaceId || topic.display.title,
      badgeText,
      kind: kind.kind,
      kindLabel: kind.label,
      pinned: topic.state.pinned,
      muted: topic.state.muted,
      order,
      tone: tone.tone,
      statusLabel: tone.label,
      attentionPriority: tone.priority,
      sessions,
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
