import {
  DEFAULT_LOCAL_NODE_ID,
} from '../../../shared/identity.js';
import type {
  WorkContextActiveGroup,
  WorkContextSessionSummary,
} from './types.js';
import { durabilityDisabledReason } from './session-durability.js';
import { scopedSessionKey } from './session-keys.js';

export interface ActiveWorkMobileControlState {
  attachDisabledReason: string | null;
  smallInputDisabledReason: string | null;
  destructiveDisabledReason: string;
  promptKind: 'approval' | 'input' | null;
  smallInputLabel: string;
  smallInputPlaceholder: string;
}

export function activeWorkSessionActivationKey(
  session: WorkContextSessionSummary
): string {
  return scopedSessionKey({
    ...session,
    nodeId: session.nodeId ?? DEFAULT_LOCAL_NODE_ID,
  });
}

export function activeWorkAttentionPriority(
  group: WorkContextActiveGroup
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
  if (group.sessions.some((session) => session.agentState === 'error'))
    return 3;
  if (group.sessions.some((session) => session.agentState === 'processing'))
    return 4;
  if (group.sessions.some((session) => session.live)) return 5;
  return 6;
}

export function activeWorkPrimarySession(
  group: WorkContextActiveGroup
): WorkContextSessionSummary | undefined {
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

export function activeWorkSessionActivationRepoPath(
  session: WorkContextSessionSummary
): string | null {
  const nodeId = session.nodeId ?? DEFAULT_LOCAL_NODE_ID;
  return nodeId === DEFAULT_LOCAL_NODE_ID ? (session.repoPath ?? null) : null;
}

export interface ActiveWorkNextAttentionTarget {
  group: WorkContextActiveGroup;
  session: WorkContextSessionSummary;
  activationKey: string;
  activationRepoPath: string | null;
  priority: number;
}

function inverseTimestamp(value: string | undefined): string {
  const timestamp = Date.parse(value ?? '');
  const sortable = Number.isFinite(timestamp)
    ? Number.MAX_SAFE_INTEGER - timestamp
    : Number.MAX_SAFE_INTEGER;
  return String(sortable).padStart(16, '0');
}

function activeWorkTargetSortKey(target: ActiveWorkNextAttentionTarget): string {
  const lastActivity = target.session.lastActivity ?? target.session.associatedAt;
  return [
    target.priority.toString().padStart(2, '0'),
    // Newer activity wins inside the same Active Work priority bucket.
    inverseTimestamp(lastActivity),
    target.group.id,
    target.activationKey,
  ].join('\u0000');
}

export function activeWorkNextAttentionTarget(
  groups: WorkContextActiveGroup[]
): ActiveWorkNextAttentionTarget | null {
  const targets = groups.flatMap((group) => {
    const session = activeWorkPrimarySession(group);
    if (!session) return [];
    const controlState = activeWorkMobileControlState(group, session);
    if (controlState.attachDisabledReason) return [];
    return [
      {
        group,
        session,
        activationKey: activeWorkSessionActivationKey(session),
        activationRepoPath: activeWorkSessionActivationRepoPath(session),
        priority: activeWorkAttentionPriority(group),
      },
    ];
  });

  return (
    [...targets].sort((a, b) =>
      activeWorkTargetSortKey(a).localeCompare(activeWorkTargetSortKey(b))
    )[0] ?? null
  );
}

export function activeWorkStateLabel(group: WorkContextActiveGroup): string {
  if (
    group.sessions.some((session) => session.agentState === 'permission-prompt')
  )
    return 'needs approval';
  if (
    group.sessions.some((session) => session.agentState === 'waiting-for-input')
  )
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

function liveControlDisabledReason(
  group: WorkContextActiveGroup,
  session?: WorkContextSessionSummary
): string | null {
  if (!session) return 'no session selected';
  // Session-level durability overrides coarse live/node checks: a session
  // that landed in `stale-node` / `ended` / `error` should disable
  // controls even if other signals say "online", and the typed reason is
  // more honest than the legacy `${status} node` message.
  const durabilityReason = durabilityDisabledReason(session.durability);
  if (durabilityReason) return durabilityReason;
  if (!session.live) return 'last-known session only';
  if (group.node.status !== 'online') return `${group.node.status} node`;
  if (group.staleReadModel) return 'stale read model';
  return null;
}

function freshControlDisabledReason(
  session?: WorkContextSessionSummary
): string | null {
  if (!session) return 'no session selected';
  if (session.controlFreshness === 'stale') return 'stale control state';
  if (session.controlFreshness !== 'fresh') return 'unknown control state';
  return null;
}

export function activeWorkMobileControlState(
  group: WorkContextActiveGroup,
  session?: WorkContextSessionSummary
): ActiveWorkMobileControlState {
  const liveReason = liveControlDisabledReason(group, session);
  const freshReason = freshControlDisabledReason(session);
  const promptKind =
    session?.agentState === 'permission-prompt'
      ? 'approval'
      : session?.agentState === 'waiting-for-input'
        ? 'input'
        : null;

  let smallInputDisabledReason = liveReason ?? freshReason;
  if (!smallInputDisabledReason && session?.mode === 'web') {
    smallInputDisabledReason = 'web session input is unsupported here';
  }

  return {
    attachDisabledReason: liveReason,
    smallInputDisabledReason,
    destructiveDisabledReason:
      liveReason ??
      freshReason ??
      'requires explicit session:control:kill grant; no mobile allow decision is present',
    promptKind,
    smallInputLabel:
      promptKind === 'approval' ? 'reply to approval' : 'send input',
    smallInputPlaceholder:
      promptKind === 'approval'
        ? 'approval reply (example: y, n, or exact prompt text)'
        : 'short input to send to the session',
  };
}
