import { useMemo, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { DEFAULT_LOCAL_NODE_ID } from '../../../shared/identity.js';
import type {
  WorkContextActiveGroup,
  WorkContextSessionSummary,
} from '../lib/types.js';
import { fetchActiveWork } from '../lib/api.js';
import { useSessionsStore } from '../lib/stores/sessions.js';
import { useUiStore } from '../lib/stores/ui.js';
import { scopedSessionKey } from '../lib/session-keys.js';
import { TuiButton } from './TuiButton.js';
import './ActiveWorkSurface.css';

const ACTIVE_WORK_REFETCH_MS = 15_000;

function shortId(id: string): string {
  if (id.length <= 14) return id;
  return `${id.slice(0, 6)}…${id.slice(-4)}`;
}

function dateLabel(value?: string): string {
  if (!value) return 'unknown freshness';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const diffMs = Date.now() - date.getTime();
  const abs = Math.abs(diffMs);
  const suffix = diffMs >= 0 ? 'ago' : 'from now';
  if (abs < 60_000) return 'just now';
  if (abs < 3_600_000) return `${Math.round(abs / 60_000)}m ${suffix}`;
  if (abs < 86_400_000) return `${Math.round(abs / 3_600_000)}h ${suffix}`;
  return `${Math.round(abs / 86_400_000)}d ${suffix}`;
}

function taskLabel(group: WorkContextActiveGroup): string {
  const context = group.context;
  const firstTask = context?.tasks[0];
  return (
    context?.title ??
    firstTask?.title ??
    firstTask?.id ??
    'unassigned active work'
  );
}

function taskRefs(
  group: WorkContextActiveGroup
): Array<{ id: string; label: string; url?: string }> {
  return (group.context?.tasks ?? []).map((task) => ({
    id: task.id,
    label: task.title ? `${task.id} · ${task.title}` : task.id,
    ...(task.url ? { url: task.url } : {}),
  }));
}

function actorLabels(group: WorkContextActiveGroup): string[] {
  const seen = new Set<string>();
  const labels: string[] = [];
  for (const actor of group.context?.actors ?? []) {
    const label = actor.displayName ?? actor.providerId ?? actor.id;
    if (!seen.has(label)) {
      seen.add(label);
      labels.push(label);
    }
  }
  for (const session of group.sessions) {
    for (const actor of session.activeActors ?? []) {
      const label = actor.displayName ?? actor.id ?? actor.kind;
      if (!seen.has(label)) {
        seen.add(label);
        labels.push(label);
      }
    }
    const worker = session.activeWorker;
    if (worker) {
      const label = worker.displayName ?? worker.id ?? worker.kind;
      if (!seen.has(label)) {
        seen.add(label);
        labels.push(label);
      }
    }
  }
  return labels;
}

function statusPriority(group: WorkContextActiveGroup): number {
  const hasPrompt = group.sessions.some(
    (session) => session.agentState === 'permission-prompt'
  );
  if (hasPrompt) return 0;
  if (group.node.status === 'offline' || group.node.status === 'revoked')
    return 1;
  if (group.node.status === 'stale' || group.staleReadModel) return 2;
  if (group.sessions.some((session) => session.agentState === 'processing'))
    return 3;
  if (group.sessions.some((session) => session.live)) return 4;
  return 5;
}

function stateLabel(group: WorkContextActiveGroup): string {
  if (
    group.sessions.some((session) => session.agentState === 'permission-prompt')
  )
    return 'needs approval';
  if (group.node.status === 'offline' || group.node.status === 'revoked')
    return 'offline';
  if (group.node.status === 'stale') return 'stale';
  if (group.staleReadModel) return 'stale read model';
  if (group.sessions.some((session) => session.agentState === 'processing'))
    return 'running';
  if (group.sessions.some((session) => session.agentState === 'error'))
    return 'error';
  if (group.sessions.some((session) => session.live)) return 'live';
  return 'inactive';
}

function latestStatus(group: WorkContextActiveGroup): string {
  const active = group.sessions.find((session) => session.currentActivity);
  if (active?.currentActivity) {
    const detail = active.currentActivity.detail
      ? ` · ${active.currentActivity.detail}`
      : '';
    return `${active.currentActivity.tool}${detail}`;
  }
  const intervention = group.sessions.find(
    (session) => session.controlReason || session.lastInterventionAt
  );
  if (intervention?.controlReason) return intervention.controlReason;
  if (intervention?.lastInterventionAt) {
    const by =
      intervention.lastInterventionBy?.displayName ??
      intervention.lastInterventionBy?.id ??
      'human';
    return `latest intervention by ${by} · ${dateLabel(intervention.lastInterventionAt)}`;
  }
  const artifact = group.context?.artifacts[0];
  if (artifact?.summary) return artifact.summary;
  const session = group.sessions[0];
  if (session?.agentState)
    return `${session.agent ?? session.type ?? session.tabKind} · ${session.agentState}`;
  return group.context
    ? 'context linked, waiting for bounded status'
    : 'session has no work context yet';
}

function controlDisabledReason(
  group: WorkContextActiveGroup,
  session?: WorkContextSessionSummary
): string | null {
  if (!session) return 'no session selected';
  if (!session.live) return 'last-known session only';
  if (group.node.status !== 'online') return `${group.node.status} node`;
  if (group.staleReadModel) return 'stale read model';
  return null;
}

function repoBindingLabel(
  group: WorkContextActiveGroup,
  session: WorkContextSessionSummary
): string | null {
  const repo = session.repoName ?? group.context?.anchors.repo?.ownerRepo;
  const repoPath = session.repoPath ?? group.context?.anchors.repo?.localPath;
  if (!repo && !repoPath) return null;
  const branch = session.branchName ?? group.context?.anchors.repo?.branchName;
  return [repo ?? repoPath, branch].filter(Boolean).join(' · ');
}

function sessionMeta(
  group: WorkContextActiveGroup,
  session: WorkContextSessionSummary
): string[] {
  const meta = [
    session.tabKind,
    session.type,
    session.agent,
    session.controlMode,
    session.controlFreshness
      ? `control ${session.controlFreshness}`
      : undefined,
  ].filter(Boolean) as string[];
  const repo = repoBindingLabel(group, session);
  if (repo) meta.push(`repo ${repo}`);
  else meta.push('no repo binding');
  return meta;
}

function ActiveWorkCard({ group }: { group: WorkContextActiveGroup }) {
  const sessions = useSessionsStore((s) => s.sessions);
  const setActiveSessionId = useSessionsStore((s) => s.setActiveSessionId);
  const setActiveRepoPath = useUiStore((s) => s.setActiveRepoPath);
  const primarySession =
    group.sessions.find((session) => session.live) ?? group.sessions[0];
  const disabledReason = controlDisabledReason(group, primarySession);
  const actors = actorLabels(group);
  const refs = taskRefs(group);
  const artifacts = group.context?.artifacts ?? [];

  const handleAttach = useCallback(() => {
    if (!primarySession || disabledReason) return;
    const live = sessions.find(
      (session) =>
        session.id === primarySession.id &&
        (session.nodeId ?? DEFAULT_LOCAL_NODE_ID) === primarySession.nodeId
    );
    const nodeId = primarySession.nodeId ?? DEFAULT_LOCAL_NODE_ID;
    const isLocal = nodeId === DEFAULT_LOCAL_NODE_ID;
    setActiveRepoPath(isLocal ? (primarySession.repoPath ?? null) : null);
    setActiveSessionId(
      live
        ? scopedSessionKey(live)
        : (primarySession.globalSessionId ?? primarySession.id)
    );
  }, [
    disabledReason,
    primarySession,
    sessions,
    setActiveRepoPath,
    setActiveSessionId,
  ]);

  return (
    <article className="active-work-card" data-node-status={group.node.status}>
      <div className="active-work-card__status-strip" aria-hidden="true" />
      <div className="active-work-card__main">
        <div className="active-work-card__header">
          <div>
            <div className="active-work-card__eyebrow">{stateLabel(group)}</div>
            <h3>{taskLabel(group)}</h3>
          </div>
          <div className="active-work-node">
            <span className="active-work-node__dot" />
            <span>{group.node.displayName ?? group.node.nodeId}</span>
            <span className="active-work-muted">{group.node.status}</span>
          </div>
        </div>

        {refs.length > 0 && (
          <div className="active-work-chips" aria-label="task references">
            {refs.map((ref) =>
              ref.url ? (
                <a
                  key={ref.id}
                  className="active-work-chip"
                  href={ref.url}
                  target="_blank"
                  rel="noreferrer"
                >
                  {ref.label}
                </a>
              ) : (
                <span key={ref.id} className="active-work-chip">
                  {ref.label}
                </span>
              )
            )}
          </div>
        )}

        <div className="active-work-grid">
          <div>
            <span className="active-work-label">anchor</span>
            <span>
              {group.node.kind ?? 'remote'} · {primarySession?.cwd ?? 'no cwd'}
            </span>
          </div>
          <div>
            <span className="active-work-label">freshness</span>
            <span>
              {group.node.lastSeenAt
                ? `last seen ${dateLabel(group.node.lastSeenAt)}`
                : group.staleReadModel
                  ? 'stale read model'
                  : 'fresh'}
            </span>
          </div>
          <div>
            <span className="active-work-label">actors</span>
            <span>
              {actors.length
                ? actors.join(' / ')
                : (primarySession?.agent ?? 'unknown actor')}
            </span>
          </div>
          <div>
            <span className="active-work-label">latest</span>
            <span>{latestStatus(group)}</span>
          </div>
        </div>

        <div className="active-work-sessions">
          {group.sessions.map((session) => (
            <div
              className="active-work-session"
              key={`${session.nodeId}:${session.id}`}
            >
              <div className="active-work-session__title">
                <span>{session.displayName ?? shortId(session.id)}</span>
                <span className="active-work-muted">
                  {shortId(session.globalSessionId ?? session.id)}
                </span>
                {!session.live && (
                  <span className="active-work-chip active-work-chip--muted">
                    last known
                  </span>
                )}
              </div>
              <div className="active-work-session__cwd">{session.cwd}</div>
              <div className="active-work-session__meta">
                {sessionMeta(group, session).map((item) => (
                  <span key={item}>{item}</span>
                ))}
              </div>
            </div>
          ))}
        </div>

        {artifacts.length > 0 && (
          <div className="active-work-artifacts" aria-label="artifacts">
            <span className="active-work-label">artifacts</span>
            {artifacts.slice(0, 4).map((artifact) => {
              const label = artifact.title ?? artifact.summary ?? artifact.id;
              return artifact.uri ? (
                <a
                  key={artifact.id}
                  className="active-work-chip"
                  href={artifact.uri}
                  target="_blank"
                  rel="noreferrer"
                >
                  {artifact.kind} · {label}
                </a>
              ) : (
                <span key={artifact.id} className="active-work-chip">
                  {artifact.kind} · {label}
                </span>
              );
            })}
          </div>
        )}

        <div className="active-work-controls" aria-label="work controls">
          <TuiButton
            size="sm"
            variant="info"
            disabled={!!disabledReason}
            title={disabledReason ?? 'attach to live session'}
            onClick={handleAttach}
          >
            attach
          </TuiButton>
          <TuiButton
            size="sm"
            variant="ghost"
            disabled
            title={disabledReason ?? 'small input is #559 scope'}
          >
            small input
          </TuiButton>
          <TuiButton
            size="sm"
            variant="danger"
            disabled
            title={disabledReason ?? 'pause/kill requires capability contract'}
          >
            interrupt
          </TuiButton>
          {disabledReason && (
            <span className="active-work-disabled-reason">
              controls disabled: {disabledReason}
            </span>
          )}
        </div>
      </div>
    </article>
  );
}

export default function ActiveWorkSurface() {
  const {
    data = [],
    isLoading,
    isError,
    refetch,
  } = useQuery({
    queryKey: ['active-work'],
    queryFn: fetchActiveWork,
    staleTime: 5_000,
    refetchInterval: ACTIVE_WORK_REFETCH_MS,
  });

  const groups = useMemo(
    () => [...data].sort((a, b) => statusPriority(a) - statusPriority(b)),
    [data]
  );
  const attentionCount = groups.filter(
    (group) => statusPriority(group) <= 2
  ).length;

  if (isLoading)
    return <div className="state-message">loading active work...</div>;
  if (isError) {
    return (
      <div className="state-message state-message--error">
        <span>could not load active work.</span>
        <TuiButton size="sm" variant="ghost" onClick={() => void refetch()}>
          retry
        </TuiButton>
      </div>
    );
  }

  return (
    <section
      className="active-work-surface"
      aria-label="active work across nodes"
    >
      <div className="active-work-surface__header">
        <div>
          <h2>active work</h2>
          <p>grouped by workcontext across local and remote nodes</p>
        </div>
        <div className="active-work-surface__summary">
          <span>{groups.length} contexts</span>
          <span>{attentionCount} stale/needs attention</span>
        </div>
      </div>
      {groups.length === 0 ? (
        <div className="active-work-empty">
          <span>no active work yet</span>
          <span>
            start from assistant, issue, or desktop relay; this surface will
            group the resulting workcontext here.
          </span>
        </div>
      ) : (
        <div className="active-work-list">
          {groups.map((group) => (
            <ActiveWorkCard key={group.id} group={group} />
          ))}
        </div>
      )}
    </section>
  );
}
