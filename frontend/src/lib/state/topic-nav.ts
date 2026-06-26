import type { WorkspaceSurface } from '../../../../shared/workspace-surfaces.js';
import type {
  WorkspaceTopic,
  WorkspaceTopicId,
} from '../../../../shared/workspace-topics.js';
import type { SessionSummary } from '../types.js';
import { isAttentionState } from './display-state.js';
import { highestPriorityState } from './attention.js';

export type TopicNavTone = 'active' | 'attention' | 'idle' | 'empty' | 'error';

export interface TopicNavSessionRef {
  id: string;
  selectKey: string;
  label: string;
  tone: TopicNavTone;
  branch: string | null;
  nodeId: string | null;
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
  badgeText: string;
  badgeSeed: string;
  pinned: boolean;
  muted: boolean;
  order: number;
  tone: TopicNavTone;
  statusLabel: string;
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

function sessionDisplayState(session: SessionSummary) {
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
): { tone: TopicNavTone; label: string } {
  if (topic.status === 'archived') return { tone: 'empty', label: 'archived' };
  if (sessions.some((session) => session.tone === 'error')) {
    return { tone: 'error', label: 'error' };
  }
  if (surfaces.some((surface) => surface.health === 'unreachable')) {
    return { tone: 'error', label: 'surface down' };
  }
  if (sessions.some((session) => session.tone === 'attention')) {
    return { tone: 'attention', label: 'needs input' };
  }
  if (sessions.some((session) => session.tone === 'active')) {
    return { tone: 'active', label: 'active' };
  }
  if (sessions.length > 0) return { tone: 'idle', label: 'idle' };
  if (surfaces.length > 0) return { tone: 'idle', label: 'surfaces' };
  return { tone: 'empty', label: 'empty' };
}

function compareItems(a: TopicNavItem, b: TopicNavItem): number {
  if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
  if (a.order !== b.order) return a.order - b.order;
  return a.title.localeCompare(b.title);
}

export function buildTopicNavModel(input: {
  topics: WorkspaceTopic[];
  sessions: SessionSummary[];
  surfaces: WorkspaceSurface[];
  derived?: boolean;
}): TopicNavModel {
  const workspaceNumbers = new Map<string, number>();
  for (const topic of input.topics) {
    if (!workspaceNumbers.has(topic.workspaceId)) {
      workspaceNumbers.set(topic.workspaceId, workspaceNumbers.size + 1);
    }
  }

  const items: TopicNavItem[] = input.topics.map((topic) => {
    const sessions = input.sessions
      .filter((session) => sessionMatchesTopic(topic, session))
      .map(
        (session): TopicNavSessionRef => ({
          id: session.id,
          selectKey: sessionSelectKey(session),
          label: session.displayName || basename(session.cwd) || session.id,
          tone: sessionTone(session),
          branch: session.branchName ?? null,
          nodeId: session.nodeId ?? null,
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
    const number = workspaceNumbers.get(topic.workspaceId) ?? 0;
    const order = topic.grouping.order ?? Number.MAX_SAFE_INTEGER;
    return {
      id: topic.id,
      parentId: topic.grouping.parentTopicId ?? null,
      title: topic.display.title,
      description: topic.display.description ?? null,
      badgeText: number > 0 ? String(number).padStart(2, '0') : 'ws',
      badgeSeed: topic.workspaceId || topic.display.title,
      pinned: topic.state.pinned,
      muted: topic.state.muted,
      order,
      tone: tone.tone,
      statusLabel: tone.label,
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
    if (item.parentId && byId.has(item.parentId)) {
      byId.get(item.parentId)!.childIds.push(item.id);
    } else {
      rootIds.push(item.id);
    }
  }
  for (const item of items)
    item.childIds.sort((a, b) => compareItems(byId.get(a)!, byId.get(b)!));
  rootIds.sort((a, b) => compareItems(byId.get(a)!, byId.get(b)!));

  // Touch the same attention priority helper the rest of the sidebar uses, so a
  // future tone expansion does not drift into a second status model.
  void highestPriorityState(
    input.sessions.map(sessionDisplayState).filter(isAttentionState)
  );

  return { items, rootIds, byId, derived: input.derived ?? false };
}
