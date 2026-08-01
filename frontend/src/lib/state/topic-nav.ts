import type { WorkspaceSurface } from '../../../../shared/workspace-surfaces.js';
import {
  workspaceTopicHasExplicitParticipantLinks,
  type WorkspaceTopic,
  type WorkspaceTopicChannelKind,
  type WorkspaceTopicId,
} from '../../../../shared/workspace-topics.js';
import type { SessionSummary } from '../types.js';
import { isAttentionState, type DisplayState } from './display-state.js';
import { highestPriorityState } from './attention.js';
import { scopedSessionKey, sessionKeyMatches } from '../session-keys.js';
import { isDmChannel } from '../dm-channels.js';

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
  mode: SessionSummary['mode'] | null;
  status: SessionSummary['status'] | null;
  tone: TopicNavTone;
  displayState: DisplayState;
  activityState: SessionSummary['activityState'] | null;
  permissionType: SessionSummary['permissionType'] | null;
  branch: string | null;
  /** Raw routing node id — only for functional routing, never render directly. */
  nodeId: string | null;
  /** Friendly node display name, resolved against the known node roster; null when unresolved (never a raw id). */
  nodeLabel: string | null;
  cwd: string;
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
  /** Raw routing node id — only for functional routing, never render directly. */
  nodeId: string | null;
  /** Friendly node display name, resolved against the known node roster; null when unresolved (never a raw id). */
  nodeLabel: string | null;
  tone: TopicNavTone;
  statusLabel: string;
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
  source: WorkspaceTopic['source'];
  workspaceId: WorkspaceTopic['workspaceId'];
  parentId: WorkspaceTopicId | null;
  title: string;
  description: string | null;
  badgeSeed: string;
  kind: TopicNavKind;
  kindLabel: string;
  /** User-chosen Discord-style channel taxonomy (repo/product-area/…). */
  channelKind: WorkspaceTopicChannelKind | null;
  /** #1166: true when this topic is a DM channel (deterministic-id derivation). */
  isDirectMessage: boolean;
  /** Provider id of the DM partner, or null for a regular channel. */
  dmProviderId: string | null;
  icon: string | null;
  color: string | null;
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
  artifactIds: NonNullable<WorkspaceTopic['linkedRefs']['artifactIds']>;
  workContextIds: NonNullable<WorkspaceTopic['linkedRefs']['workContextIds']>;
  childIds: WorkspaceTopicId[];
  routingLabel: string | null;
  lifecycleLabel: WorkspaceTopic['status'];
  updatedAt: string;
}

export interface TopicNavModel {
  items: TopicNavItem[];
  rootIds: WorkspaceTopicId[];
  byId: Map<WorkspaceTopicId, TopicNavItem>;
  derived: boolean;
}

/** Minimal workspace shape the topic sidebar groups channels under. */
export interface TopicNavWorkspace {
  id: string;
  name: string;
  order: number;
  pinned: boolean;
  color: string | null;
  icon: string | null;
}

/**
 * Minimal node identity the topic sidebar resolves raw routing node ids
 * against for display. Unknown/unpaired node ids simply fail to resolve —
 * callers must never fall back to rendering the raw id (#1061).
 */
export interface TopicNavNode {
  nodeId: string;
  displayName: string | null | undefined;
}

/**
 * Per-row channel payload hydrated from `GET /channels` (#1287). Structural
 * subset of the route's `channelSummaryView` — last message, member roster, and
 * counts — so `ChannelSummaryView` from the API client assigns directly without
 * the rail projection depending on the fetch layer.
 */
export interface ChannelRailSummary {
  id: string;
  latestSeq: number;
  messageCount: number;
  members: { kind: 'human' | 'agent'; id: string; joinedAt: string }[];
  lastMessage: {
    seq: number;
    preview: string;
    senderId: string;
    senderKind: 'human' | 'agent' | 'system';
    /**
     * Server-resolved label + vendor for the sender. The rail labels snippets
     * from these; `senderId` is a profile Actor id and must never be split for
     * a name (#1234).
     */
    senderDisplayName?: string;
    providerId?: string;
    /**
     * Mention refs the server computed over the FULL body (not the truncated
     * preview), so the cockpit's mention lane is not capped at 200 chars.
     */
    mentions?: { raw: string }[];
    createdAt: string;
  } | null;
}

export interface ChannelRailNode {
  item: TopicNavItem;
  unread: boolean;
  /**
   * Channel summary joined by id, or null for a row the channel list does not
   * cover (derived/fallback topics, and persisted rows outside the list's own
   * 200-row window). Renderers must degrade to the topic record alone.
   */
  summary: ChannelRailSummary | null;
  children: ChannelRailNode[];
}

export interface ChannelRailSection {
  channels: ChannelRailNode[];
  directMessages: ChannelRailNode[];
  unread: boolean;
}

export interface ChannelRailWorkspaceGroup extends ChannelRailSection {
  id: string;
  title: string;
  color: string | null;
  icon: string | null;
  pinned: boolean;
  /**
   * True when this known workspace holds no root channels and no DMs yet. The
   * lane still renders (#1287) — renderers show a start-a-chat affordance
   * instead of the channel lists.
   */
  empty: boolean;
}

export interface ChannelRailTree {
  groups: ChannelRailWorkspaceGroup[];
  /** Root topics whose workspace is unknown/unset (the "no workspace" lane). */
  orphans: ChannelRailSection;
}

export interface ChannelRailActivitySnapshot {
  unreadByChannel: Readonly<Record<string, boolean>>;
  /**
   * Channel summaries keyed by channel id (#1287). Optional: the rail renders
   * from the topic list alone before the summaries land, and derived topics
   * never get one.
   */
  summaryByChannel?: Readonly<Record<string, ChannelRailSummary>>;
}

/**
 * Resolve which rail rows render expanded (#1287 slice 5).
 *
 * Fold state is DERIVED, never seeded into state by an effect. A root row is
 * open unless the operator explicitly closed it; any other row is closed unless
 * the operator explicitly opened it. `expansion` therefore only ever holds rows
 * the operator actually touched, and it is the whole "have we seen this id
 * before" record: an id missing from it has never been decided, so a brand new
 * root still opens on its own, while an id recorded `false` stays closed for
 * good.
 *
 * The predecessor was an effect that re-added every `model.rootIds` entry to a
 * component-local set whenever the nav model changed identity. `useSessionsStore`
 * rebuilds its `sessions` array via `.map()` on every activity/status/branch/
 * rename WS event, so that effect re-fired — and re-expanded the rail — within
 * seconds of any collapse during a live session.
 */
export function selectExpandedRailIds(
  rootIds: readonly WorkspaceTopicId[],
  expansion: Readonly<Record<string, boolean>>
): Set<string> {
  const expanded = new Set<string>();
  for (const id of rootIds) {
    if (expansion[id] !== false) expanded.add(id);
  }
  for (const [id, isExpanded] of Object.entries(expansion)) {
    if (isExpanded) expanded.add(id);
  }
  return expanded;
}

/** Key a `GET /channels` payload by channel id for the rail join (#1287). */
export function indexChannelSummaries(
  rows: readonly ChannelRailSummary[]
): Record<string, ChannelRailSummary> {
  const byId: Record<string, ChannelRailSummary> = {};
  for (const row of rows) byId[row.id] = row;
  return byId;
}

/**
 * One render-neutral channel rail projection shared by desktop and mobile.
 * Workspaces sort pinned-first then by authored order; root channels retain the
 * topic model's order and split into regular-channel and direct-message
 * sections. Descendants stay nested under their canonical root instead of being
 * flattened into workspace peers. Unread is computed once from the same
 * activity snapshot for both consumers, and each row carries the channel
 * summary joined by id (#1287) so neither renderer needs a per-channel fetch.
 *
 * EVERY known workspace becomes a lane, including one holding zero channels
 * (#1287). Dropping an empty bucket made a freshly added workspace invisible
 * until a chat existed inside it — impossible while the lane it needed was
 * never rendered, and therefore never selectable as the create target.
 */
export function selectChannelRailTree(
  model: TopicNavModel,
  workspaces: TopicNavWorkspace[],
  activity: ChannelRailActivitySnapshot
): ChannelRailTree {
  const buildNode = (id: WorkspaceTopicId): ChannelRailNode | null => {
    const item = model.byId.get(id);
    if (!item) return null;
    const children = item.childIds
      .map(buildNode)
      .filter((node): node is ChannelRailNode => node !== null);
    return {
      item,
      unread: activity.unreadByChannel[item.id] ?? false,
      summary: activity.summaryByChannel?.[item.id] ?? null,
      children,
    };
  };
  const partition = (ids: WorkspaceTopicId[]): ChannelRailSection => {
    const channels: ChannelRailNode[] = [];
    const directMessages: ChannelRailNode[] = [];
    for (const id of ids) {
      const node = buildNode(id);
      if (!node) continue;
      (node.item.isDirectMessage ? directMessages : channels).push(node);
    }
    return {
      channels,
      directMessages,
      unread: [...channels, ...directMessages].some(hasUnreadNode),
    };
  };

  const rootsByWorkspace = new Map<string, WorkspaceTopicId[]>();
  const orphanIds: WorkspaceTopicId[] = [];
  const knownIds = new Set(workspaces.map((w) => w.id));
  for (const id of model.rootIds) {
    const workspaceId = model.byId.get(id)?.workspaceId;
    if (workspaceId && knownIds.has(workspaceId)) {
      const bucket = rootsByWorkspace.get(workspaceId);
      if (bucket) bucket.push(id);
      else rootsByWorkspace.set(workspaceId, [id]);
    } else {
      orphanIds.push(id);
    }
  }

  const ordered = [...workspaces].sort(
    (a, b) =>
      Number(b.pinned) - Number(a.pinned) ||
      a.order - b.order ||
      a.id.localeCompare(b.id)
  );

  const groups: ChannelRailWorkspaceGroup[] = ordered.map((workspace) => {
    const section = partition(rootsByWorkspace.get(workspace.id) ?? []);
    return {
      id: workspace.id,
      title: workspace.name,
      color: workspace.color,
      icon: workspace.icon,
      pinned: workspace.pinned,
      ...section,
      empty:
        section.channels.length === 0 && section.directMessages.length === 0,
    };
  });

  return {
    groups,
    orphans: partition(orphanIds),
  };
}

function hasUnreadNode(node: ChannelRailNode): boolean {
  return node.unread || node.children.some(hasUnreadNode);
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
  if (session.activityState === 'error') return 'error';
  if (session.activityState === 'permission-prompt') return 'attention';
  if (session.activityState === 'waiting-for-input') return 'attention';
  if (session.status === 'disconnected') return 'error';
  if (
    session.activityState === 'processing' ||
    session.activityState === 'initializing'
  ) {
    return 'active';
  }
  return session.idle ? 'idle' : 'active';
}

function sessionDisplayState(session: SessionSummary): DisplayState {
  if (session.activityState === 'permission-prompt') {
    return session.permissionType === 'question'
      ? 'needs-answer'
      : 'permission';
  }
  if (session.activityState === 'waiting-for-input') return 'needs-answer';
  if (session.activityState === 'error') return 'error';
  if (session.status === 'disconnected') return 'error';
  if (session.activityState === 'processing') return 'running';
  if (session.activityState === 'initializing') return 'initializing';
  return 'seen-idle';
}

export function sessionMatchesTopic(
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
  // Explicitly linked topics answer for themselves. `agentRuntimeIds` counts
  // even though a channel agent runtime never resolves to a session row: its
  // presence proves the binder recorded this topic's participants, so an
  // unmatched session here is genuinely NOT a participant (#1287).
  if (workspaceTopicHasExplicitParticipantLinks(topic)) return false;

  // DEPRECATED legacy lane (#1287): topics with NO explicit refs at all — rows
  // written before the binder linked its runtimes, plus raw
  // `POST /workspace-topics` and CLI-gateway `workspace-topics.create` callers
  // that never pass `linkedRefs`. Path matching is a display-only guess that
  // can adopt an unrelated terminal into a channel's participant list. Every
  // writer that links explicitly skips this branch; delete it once none are
  // left.
  const routing = topic.routingDefaults;
  // Never guess across machines: the same path on another node is a different
  // checkout, not this topic's work.
  if (routing.nodeId && session.nodeId && session.nodeId !== routing.nodeId) {
    return false;
  }
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

/**
 * Resolve a raw routing node id to its friendly display name. Never returns
 * the raw id itself — an unresolved/unknown node id resolves to `null` so
 * callers omit the node affordance rather than leak a raw substrate id
 * (#1061).
 */
function nodeLabelFor(
  nodeId: string | null | undefined,
  nodeNameById: Map<string, string>
): string | null {
  if (!nodeId) return null;
  return nodeNameById.get(nodeId) ?? null;
}

function routingLabel(
  topic: WorkspaceTopic,
  nodeNameById: Map<string, string>
): string | null {
  const routing = topic.routingDefaults;
  const parts = [
    routing.providerId,
    nodeLabelFor(routing.nodeId, nodeNameById),
    basename(routing.worktreePath) ??
      basename(routing.repoPath) ??
      basename(routing.cwd),
  ].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(' · ') : null;
}

/**
 * Human-friendly label for a linked task ref. Already-human refs (an
 * authored `title`, or ids like `PROJ-123` for ticket trackers) render as-is;
 * kind-specific formatting fills the gap when only a bare id is known (e.g.
 * a github issue/PR number becomes `#1234` instead of the raw numeric id).
 */
export function formatTaskRefLabel(taskRef: {
  kind: string;
  id: string;
  title?: string | null;
}): string {
  const title = taskRef.title?.trim();
  if (title) return title;
  if (taskRef.kind === 'github-issue' || taskRef.kind === 'github-pr') {
    return `#${taskRef.id}`;
  }
  return taskRef.id;
}

function sessionRoleLabel(_session: SessionSummary): string {
  return 'terminal';
}

function sessionProviderLabel(session: SessionSummary): string {
  return sessionParticipantStatus(session).label;
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
  if (session.activityState === 'permission-prompt') {
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
  if (session.activityState === 'waiting-for-input') {
    return {
      label: 'needs input',
      summary: boundedSummary(
        session.currentActivity?.detail ?? session.currentActivity?.tool
      ),
    };
  }
  if (session.activityState === 'error') {
    return {
      label: 'error',
      summary: boundedSummary(
        session.currentActivity?.detail ?? session.currentActivity?.tool
      ),
    };
  }
  if (session.activityState === 'processing') {
    return {
      label: 'running',
      summary: boundedSummary(
        session.currentActivity?.detail ?? session.currentActivity?.tool
      ),
    };
  }
  if (session.activityState === 'initializing') {
    return { label: 'starting', summary: 'initializing session' };
  }
  return {
    label: session.idle ? 'idle' : 'active',
    summary: boundedSummary(
      session.currentActivity?.detail ?? session.currentActivity?.tool
    ),
  };
}

function topicParticipantRef(
  session: SessionSummary,
  nodeNameById: Map<string, string>
): TopicNavParticipantRef {
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
    nodeLabel: nodeLabelFor(session.nodeId, nodeNameById),
    tone: sessionTone(session),
    statusLabel: status.label,
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
  /** Known node roster, used to resolve raw routing node ids to display names. */
  nodes?: TopicNavNode[] | undefined;
}): TopicNavModel {
  const nodeNameById = new Map<string, string>();
  for (const node of input.nodes ?? []) {
    const name = node.displayName?.trim();
    if (name) nodeNameById.set(node.nodeId, name);
  }
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
          mode: session.mode ?? null,
          status: session.status ?? null,
          tone: sessionTone(session),
          displayState: sessionDisplayState(session),
          activityState: session.activityState ?? null,
          permissionType: session.permissionType ?? null,
          branch: session.branchName ?? null,
          nodeId: session.nodeId ?? null,
          nodeLabel: nodeLabelFor(session.nodeId, nodeNameById),
          cwd: session.cwd,
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
      .map((session) => topicParticipantRef(session, nodeNameById))
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
    const dmProviderId = isDmChannel(topic);
    return {
      id: topic.id,
      source: topic.source,
      workspaceId: topic.workspaceId,
      parentId: topic.grouping.parentTopicId ?? null,
      title: topic.display.title,
      description: topic.display.description ?? null,
      badgeSeed: topic.workspaceId || topic.display.title,
      kind: kind.kind,
      kindLabel: kind.label,
      channelKind: topic.display.kind ?? null,
      isDirectMessage: dmProviderId !== null,
      dmProviderId,
      icon: topic.display.icon ?? null,
      color: topic.display.color ?? null,
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
      artifactIds: topic.linkedRefs.artifactIds ?? [],
      workContextIds: topic.linkedRefs.workContextIds ?? [],
      childIds: [],
      routingLabel: routingLabel(topic, nodeNameById),
      lifecycleLabel: topic.status,
      updatedAt: topic.updatedAt,
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
