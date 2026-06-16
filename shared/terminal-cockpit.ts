import type { ControlActor, ControlMode } from './control-state.js';
import type { SessionDurabilityState } from './session-durability.js';
import type { ArtifactRef, TaskRef } from './work-context.js';

export type TerminalCockpitNodeStatus =
  | 'online'
  | 'stale'
  | 'offline'
  | 'revoked'
  | 'unknown';

export interface TerminalCockpitSessionInput {
  id: string;
  nodeId: string;
  globalSessionId?: string;
  tabKind?: string;
  type?: string;
  mode?: string;
  agent?: string;
  cwd?: string;
  repoPath?: string;
  worktreePath?: string | null;
  repoName?: string;
  branchName?: string;
  displayName?: string;
  status?: string;
  agentState?: string;
  currentActivity?: { tool?: string; detail?: string };
  controlMode?: ControlMode;
  activeActors?: ControlActor[];
  activeWorker?: ControlActor;
  lastInterventionAt?: string | null;
  lastInterventionBy?: ControlActor | null;
  lastInterventionEventId?: string | null;
  controlFreshness?: 'fresh' | 'stale' | 'unknown';
  controlReason?: string;
  lastActivity?: string;
  relationship?: string;
  associatedAt?: string;
  live: boolean;
  durability?: SessionDurabilityState;
}

export interface TerminalCockpitWorkContextInput {
  id: string;
  title?: string;
  updatedAt?: string;
  tasks?: TaskRef[];
  artifacts?: ArtifactRef[];
}

export interface TerminalCockpitActiveGroupInput {
  id: string;
  context: TerminalCockpitWorkContextInput | null;
  node: {
    nodeId: string;
    status: TerminalCockpitNodeStatus;
    displayName?: string;
    lastSeenAt?: string;
  };
  sessions: TerminalCockpitSessionInput[];
  staleReadModel: boolean;
}

export interface TerminalCockpitActionState {
  enabled: boolean;
  command?: string;
  disabledReason: string | null;
}

export interface TerminalCockpitItem {
  rank: number;
  priority: number;
  attention: {
    needsAttention: boolean;
    label: string;
    reasons: string[];
  };
  workContext: {
    id: string;
    title?: string;
    updatedAt?: string;
    taskRefs: Array<Pick<TaskRef, 'kind' | 'id' | 'title' | 'status' | 'url'>>;
    artifacts: {
      count: number;
      latest: Array<
        Pick<ArtifactRef, 'id' | 'kind' | 'title' | 'summary' | 'producedAt'>
      >;
    };
  };
  node: {
    id: string;
    status: TerminalCockpitNodeStatus;
    freshness: 'fresh' | 'stale' | 'offline' | 'revoked' | 'unknown';
    displayName?: string;
    lastSeenAt?: string;
  };
  session: {
    id: string;
    globalSessionId?: string;
    displayName?: string;
    type?: string;
    mode?: string;
    agent?: string;
    state?: string;
    status?: string;
    durability?: SessionDurabilityState;
    live: boolean;
    cwd?: string;
    repoPath?: string;
    worktreePath?: string | null;
    repoName?: string;
    branchName?: string;
    controlMode?: ControlMode;
    controlFreshness?: 'fresh' | 'stale' | 'unknown';
    controlReason?: string;
    activeActors?: Array<Pick<ControlActor, 'kind' | 'id' | 'displayName'>>;
    activeWorker?: Pick<ControlActor, 'kind' | 'id' | 'displayName'> | undefined;
    lastActivity?: string;
    associatedAt?: string;
  };
  actions: {
    attach: TerminalCockpitActionState;
    smallInput: TerminalCockpitActionState;
    destructive: TerminalCockpitActionState;
  };
}

export interface TerminalCockpitView {
  generatedAt: string;
  count: number;
  next: TerminalCockpitItem | null;
  items: TerminalCockpitItem[];
  readFirst: true;
}

function durabilityDisabledReason(
  state: SessionDurabilityState | undefined
): string | null {
  if (state === 'stale-node') {
    return 'stale node — live controls disabled until the node is fresh';
  }
  if (state === 'ended') return 'session ended — no process to control';
  if (state === 'error') return 'session in error state — live controls disabled';
  return null;
}

function activeWorkAttentionPriority(
  group: TerminalCockpitActiveGroupInput
): number {
  const needsOperator = group.sessions.some(
    (session) =>
      session.agentState === 'permission-prompt' ||
      session.agentState === 'waiting-for-input'
  );
  if (needsOperator) return 0;
  if (group.node.status === 'offline' || group.node.status === 'revoked')
    return 1;
  if (group.node.status === 'stale' || group.staleReadModel) return 2;
  if (group.sessions.some((session) => session.agentState === 'error')) return 3;
  if (group.sessions.some((session) => session.agentState === 'processing'))
    return 4;
  if (group.sessions.some((session) => session.live)) return 5;
  return 6;
}

function primarySession(
  group: TerminalCockpitActiveGroupInput
): TerminalCockpitSessionInput | undefined {
  return (
    group.sessions.find(
      (session) =>
        session.live &&
        (session.agentState === 'permission-prompt' ||
          session.agentState === 'waiting-for-input')
    ) ??
    group.sessions.find((session) => session.live) ??
    group.sessions[0]
  );
}

function stateLabel(group: TerminalCockpitActiveGroupInput): string {
  if (group.sessions.some((session) => session.agentState === 'permission-prompt'))
    return 'needs approval';
  if (group.sessions.some((session) => session.agentState === 'waiting-for-input'))
    return 'needs input';
  if (group.node.status === 'offline' || group.node.status === 'revoked')
    return 'offline';
  if (group.node.status === 'stale') return 'stale';
  if (group.staleReadModel) return 'stale read model';
  if (group.sessions.some((session) => session.agentState === 'error'))
    return 'error';
  if (group.sessions.some((session) => session.agentState === 'processing'))
    return 'running';
  if (group.sessions.some((session) => session.live)) return 'live';
  return 'inactive';
}

function attentionReasons(
  group: TerminalCockpitActiveGroupInput,
  session: TerminalCockpitSessionInput
): string[] {
  const reasons: string[] = [];
  if (session.agentState === 'permission-prompt') reasons.push('permission-prompt');
  if (session.agentState === 'waiting-for-input') reasons.push('waiting-for-input');
  if (session.agentState === 'error') reasons.push('error');
  if (group.node.status !== 'online') reasons.push(`${group.node.status}-node`);
  if (group.staleReadModel) reasons.push('stale-read-model');
  if (!session.live) reasons.push('last-known-session');
  return reasons;
}

function nodeFreshness(
  status: TerminalCockpitNodeStatus
): TerminalCockpitItem['node']['freshness'] {
  if (status === 'online') return 'fresh';
  if (status === 'stale') return 'stale';
  if (status === 'offline') return 'offline';
  if (status === 'revoked') return 'revoked';
  return 'unknown';
}

function liveControlDisabledReason(
  group: TerminalCockpitActiveGroupInput,
  session: TerminalCockpitSessionInput
): string | null {
  const durabilityReason = durabilityDisabledReason(session.durability);
  if (durabilityReason) return durabilityReason;
  if (!session.live) return 'last-known session only — live controls disabled';
  if (group.node.status !== 'online')
    return `${group.node.status} node — live controls disabled`;
  if (group.staleReadModel) return 'stale read model — live controls disabled';
  return null;
}

function freshControlDisabledReason(
  session: TerminalCockpitSessionInput
): string | null {
  if (session.controlFreshness === 'stale') return 'stale control state';
  if (session.controlFreshness && session.controlFreshness !== 'fresh')
    return 'unknown control state';
  return null;
}

function actorProjection(
  actor: ControlActor
): Pick<ControlActor, 'kind' | 'id' | 'displayName'> {
  return {
    kind: actor.kind,
    ...(actor.id ? { id: actor.id } : {}),
    ...(actor.displayName ? { displayName: actor.displayName } : {}),
  };
}

function inverseTimestamp(value: string | undefined): string {
  const timestamp = Date.parse(value ?? '');
  const sortable = Number.isFinite(timestamp)
    ? Number.MAX_SAFE_INTEGER - timestamp
    : Number.MAX_SAFE_INTEGER;
  return String(sortable).padStart(16, '0');
}

function sortKey(input: {
  group: TerminalCockpitActiveGroupInput;
  session: TerminalCockpitSessionInput;
  priority: number;
}): string {
  return [
    input.priority.toString().padStart(2, '0'),
    inverseTimestamp(input.session.lastActivity ?? input.session.associatedAt),
    input.group.id,
    input.session.globalSessionId ?? input.session.id,
  ].join('\u0000');
}

export function buildTerminalCockpitView(input: {
  groups: TerminalCockpitActiveGroupInput[];
  generatedAt?: string;
  limit?: number;
}): TerminalCockpitView {
  const candidates = input.groups.flatMap((group) => {
    const session = primarySession(group);
    if (!session) return [];
    return [{ group, session, priority: activeWorkAttentionPriority(group) }];
  });

  const sorted = [...candidates].sort((a, b) =>
    sortKey(a).localeCompare(sortKey(b))
  );
  const limited =
    input.limit && input.limit > 0 ? sorted.slice(0, input.limit) : sorted;
  // eslint-disable-next-line complexity -- Terminal cockpit projection keeps one bounded, redaction-safe output mapper.
  const items = limited.map(({ group, session, priority }, index) => {
    const context = group.context;
    const liveReason = liveControlDisabledReason(group, session);
    const freshReason = freshControlDisabledReason(session);
    const inputReason =
      liveReason ??
      freshReason ??
      (session.mode === 'web' ? 'web session input is unsupported here' : null);
    const sessionKey = session.globalSessionId ?? session.id;
    return {
      rank: index + 1,
      priority,
      attention: {
        needsAttention: priority <= 3,
        label: stateLabel(group),
        reasons: attentionReasons(group, session),
      },
      workContext: {
        id: context?.id ?? group.id,
        ...(context?.title ? { title: context.title } : {}),
        ...(context?.updatedAt ? { updatedAt: context.updatedAt } : {}),
        taskRefs: (context?.tasks ?? []).map((task) => ({
          kind: task.kind,
          id: task.id,
          ...(task.title ? { title: task.title } : {}),
          ...(task.status ? { status: task.status } : {}),
          ...(task.url ? { url: task.url } : {}),
        })),
        artifacts: {
          count: context?.artifacts?.length ?? 0,
          latest: [...(context?.artifacts ?? [])]
            .sort((a, b) => (b.producedAt ?? '').localeCompare(a.producedAt ?? ''))
            .slice(0, 3)
            .map((artifact) => ({
              id: artifact.id,
              kind: artifact.kind,
              ...(artifact.title ? { title: artifact.title } : {}),
              ...(artifact.summary ? { summary: artifact.summary } : {}),
              ...(artifact.producedAt ? { producedAt: artifact.producedAt } : {}),
            })),
        },
      },
      node: {
        id: group.node.nodeId,
        status: group.node.status,
        freshness: nodeFreshness(group.node.status),
        ...(group.node.displayName ? { displayName: group.node.displayName } : {}),
        ...(group.node.lastSeenAt ? { lastSeenAt: group.node.lastSeenAt } : {}),
      },
      session: {
        id: session.id,
        ...(session.globalSessionId ? { globalSessionId: session.globalSessionId } : {}),
        ...(session.displayName ? { displayName: session.displayName } : {}),
        ...(session.type ? { type: session.type } : {}),
        ...(session.mode ? { mode: session.mode } : {}),
        ...(session.agent ? { agent: session.agent } : {}),
        ...(session.agentState ? { state: session.agentState } : {}),
        ...(session.status ? { status: session.status } : {}),
        ...(session.durability ? { durability: session.durability } : {}),
        live: session.live,
        ...(session.cwd ? { cwd: session.cwd } : {}),
        ...(session.repoPath ? { repoPath: session.repoPath } : {}),
        ...(session.worktreePath !== undefined
          ? { worktreePath: session.worktreePath }
          : {}),
        ...(session.repoName ? { repoName: session.repoName } : {}),
        ...(session.branchName ? { branchName: session.branchName } : {}),
        ...(session.controlMode ? { controlMode: session.controlMode } : {}),
        ...(session.controlFreshness
          ? { controlFreshness: session.controlFreshness }
          : {}),
        ...(session.controlReason ? { controlReason: session.controlReason } : {}),
        ...(session.activeActors
          ? {
              activeActors: session.activeActors.map((actor) => ({
                kind: actor.kind,
                ...(actor.id ? { id: actor.id } : {}),
                ...(actor.displayName ? { displayName: actor.displayName } : {}),
              })),
            }
          : {}),
        ...(session.activeWorker
          ? { activeWorker: actorProjection(session.activeWorker) }
          : {}),
        ...(session.lastActivity ? { lastActivity: session.lastActivity } : {}),
        ...(session.associatedAt ? { associatedAt: session.associatedAt } : {}),
      },
      actions: {
        attach: {
          enabled: liveReason === null,
          ...(liveReason === null
            ? { command: `relay-ide v1 sessions attach --id ${sessionKey} --json` }
            : {}),
          disabledReason: liveReason,
        },
        smallInput: {
          enabled: false,
          disabledReason:
            inputReason ??
            'read-first cockpit — small input requires an explicit scoped control grant',
        },
        destructive: {
          enabled: false,
          disabledReason: 'destructive controls are outside the terminal cockpit MVP',
        },
      },
    } satisfies TerminalCockpitItem;
  });

  return {
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    count: items.length,
    next: items[0] ?? null,
    items,
    readFirst: true,
  };
}

function fmt(value: unknown): string {
  return typeof value === 'string' && value.trim() ? value : 'n/a';
}

export function renderTerminalCockpit(view: TerminalCockpitView): string {
  const lines = [
    'Relay terminal cockpit',
    `generated: ${view.generatedAt}`,
    `read-first: ${view.readFirst ? 'yes' : 'no'}; destructive controls: disabled`,
    '',
  ];
  if (!view.next) {
    lines.push('No WorkContext/session needs attention.');
    return `${lines.join('\n')}\n`;
  }
  lines.push(`Next: ${view.next.workContext.id} / ${view.next.session.id}`);
  lines.push('');
  for (const item of view.items) {
    lines.push(`#${item.rank} ${item.attention.label} — ${item.workContext.id}`);
    if (item.workContext.title) lines.push(`  title: ${item.workContext.title}`);
    lines.push(
      `  why: ${item.attention.reasons.length ? item.attention.reasons.join(', ') : item.attention.label}`
    );
    lines.push(
      `  node: ${item.node.id} (${item.node.status}; freshness=${item.node.freshness}${item.node.lastSeenAt ? `; lastSeen=${item.node.lastSeenAt}` : ''})`
    );
    lines.push(
      `  session: ${item.session.id}${item.session.globalSessionId ? ` (${item.session.globalSessionId})` : ''} ${fmt(item.session.agent)} ${fmt(item.session.state)} durability=${fmt(item.session.durability)} live=${item.session.live}`
    );
    lines.push(
      `  control: mode=${fmt(item.session.controlMode)} freshness=${fmt(item.session.controlFreshness)} actors=${item.session.activeActors?.map((a) => a.displayName ?? a.id ?? a.kind).join(', ') ?? 'n/a'}`
    );
    if (item.workContext.taskRefs.length > 0) {
      lines.push(
        `  task: ${item.workContext.taskRefs
          .map((task) => `${task.kind}:${task.id}${task.status ? ` (${task.status})` : ''}`)
          .join(', ')}`
      );
    }
    lines.push(
      `  artifacts: ${item.workContext.artifacts.count}${item.workContext.artifacts.latest.length ? ` latest=${item.workContext.artifacts.latest.map((a) => a.title ?? a.id).join(', ')}` : ''}`
    );
    lines.push(
      `  attach: ${item.actions.attach.enabled ? item.actions.attach.command : `disabled — ${item.actions.attach.disabledReason}`}`
    );
    lines.push(
      `  input: ${item.actions.smallInput.enabled ? 'enabled for small scoped input' : `disabled — ${item.actions.smallInput.disabledReason}`}`
    );
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}
