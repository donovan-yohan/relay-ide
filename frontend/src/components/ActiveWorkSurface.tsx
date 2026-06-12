import {
  useMemo,
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { DEFAULT_LOCAL_NODE_ID } from '../../../shared/identity.js';
import type {
  Repo,
  WorkContextActiveGroup,
  WorkContextSessionSummary,
} from '../lib/types.js';
import { fetchActiveWork, sendSessionInput } from '../lib/api.js';
import { useSessionsStore } from '../lib/stores/sessions.js';
import { useUiStore } from '../lib/stores/ui.js';
import {
  activeWorkAttentionPriority,
  activeWorkMobileControlState,
  activeWorkPrimarySession,
  activeWorkSessionActivationKey,
  activeWorkSessionActivationRepoPath,
  activeWorkStateLabel,
} from '../lib/active-work-control.js';
import SessionMailboxPanel, {
  SessionMailboxBadge,
} from './SessionMailboxPanel.js';
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
  const firstTask = context?.tasks?.[0];
  return (
    context?.title ??
    firstTask?.title ??
    firstTask?.id ??
    'unassigned active work'
  );
}

export function activeWorkContextLabel(group: WorkContextActiveGroup): string {
  if (group.context?.id) return `workcontext ${shortId(group.context.id)}`;
  return `unbound session group ${shortId(group.id)}`;
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

function latestStatus(group: WorkContextActiveGroup): string {
  const prompt = group.sessions.find(
    (session) =>
      session.agentState === 'permission-prompt' ||
      session.agentState === 'waiting-for-input'
  );
  if (prompt?.agentState === 'permission-prompt') {
    return prompt.currentActivity?.detail
      ? `approval requested · ${prompt.currentActivity.detail}`
      : 'approval requested';
  }
  if (prompt?.agentState === 'waiting-for-input') {
    return prompt.currentActivity?.detail
      ? `waiting for input · ${prompt.currentActivity.detail}`
      : 'waiting for input';
  }
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
  const artifact = group.context?.artifacts?.[0];
  if (artifact?.summary) return artifact.summary;
  const session = group.sessions[0];
  if (session?.agentState)
    return `${session.agent ?? session.type ?? session.tabKind} · ${session.agentState}`;
  return group.context
    ? 'context linked, waiting for bounded status'
    : 'session has no work context yet';
}

type SessionRepoBinding = {
  repo: Repo;
  kind: 'repo' | 'directory';
};

export function repoKind(
  session: WorkContextSessionSummary,
  repos: Repo[]
): 'repo' | 'directory' | null {
  return resolveSessionRepoBinding(session, repos)?.kind ?? null;
}

function repoKindFor(repo: Repo): 'repo' | 'directory' {
  return repo.kind ?? (repo.isGitRepo ? 'repo' : 'directory');
}

function normalizedNodeId(nodeId: string | undefined): string {
  return nodeId ?? DEFAULT_LOCAL_NODE_ID;
}

function resolveSessionRepoBinding(
  session: WorkContextSessionSummary,
  repos: Repo[]
): SessionRepoBinding | null {
  const repoPath = session.repoPath;
  if (!repoPath) return null;
  const sessionNodeId = normalizedNodeId(session.nodeId);
  const repo = repos.find(
    (candidate) =>
      candidate.path === repoPath &&
      normalizedNodeId(candidate.nodeId) === sessionNodeId
  );
  if (!repo) return null;
  return { repo, kind: repoKindFor(repo) };
}

function formatRepoBindingLabel(
  session: WorkContextSessionSummary,
  binding: SessionRepoBinding
): string | null {
  const repoPath = session.repoPath;

  if (binding.kind === 'directory') {
    const nodeLabel =
      session.nodeId && session.nodeId !== DEFAULT_LOCAL_NODE_ID
        ? session.nodeId
        : 'local';
    const cwd = session.cwd || repoPath || '';
    return `${nodeLabel} · ${cwd} · directory`;
  }

  if (!repoPath) return null;

  const repoName = session.repoName ?? binding.repo.name;
  const branch = session.branchName;
  return [repoName ?? repoPath, branch].filter(Boolean).join(' · ');
}

export function repoBindingLabel(
  session: WorkContextSessionSummary,
  repos: Repo[]
): string | null {
  const binding = resolveSessionRepoBinding(session, repos);
  if (!binding) return null;
  return formatRepoBindingLabel(session, binding);
}

export function activeWorkAnchorLabel(
  group: WorkContextActiveGroup,
  session: WorkContextSessionSummary | undefined,
  repos: Repo[]
): string {
  const nodeLabel = group.node.displayName ?? group.node.nodeId;
  const nodeKind = group.node.kind ?? 'remote';
  const cwd = session?.cwd ?? group.context?.anchors?.session?.cwd ?? 'no cwd reported';
  if (session) {
    const binding = resolveSessionRepoBinding(session, repos);
    if (binding?.kind === 'directory') {
      return `${nodeLabel} · ${cwd} · directory`;
    }
    const repoLabel = binding
      ? formatRepoBindingLabel(session, binding)
      : null;
    if (repoLabel) return `repo ${repoLabel}`;
  }
  const anchorPrefix =
    session?.nodeId && session.nodeId !== DEFAULT_LOCAL_NODE_ID
      ? `remote ${nodeLabel}`
      : nodeKind === 'local'
        ? 'local'
        : `${nodeKind} ${nodeLabel}`;
  return `${anchorPrefix} · ${cwd} · no repo binding`;
}

function controlSummary(
  controlState: ReturnType<typeof activeWorkMobileControlState>,
  session?: WorkContextSessionSummary
): string {
  const mode = session?.controlMode ?? 'unknown control mode';
  const freshness = session?.controlFreshness
    ? `control ${session.controlFreshness}`
    : 'control freshness unknown';
  const disabled = [
    controlState.attachDisabledReason
      ? `attach disabled: ${controlState.attachDisabledReason}`
      : 'attach available',
    controlState.smallInputDisabledReason
      ? `input disabled: ${controlState.smallInputDisabledReason}`
      : 'input available',
  ];
  return [mode, freshness, ...disabled].join(' · ');
}

function sessionMeta(
  group: WorkContextActiveGroup,
  session: WorkContextSessionSummary,
  repos: Repo[]
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
  const binding = resolveSessionRepoBinding(session, repos);
  const bindingLabel = binding ? formatRepoBindingLabel(session, binding) : null;
  if (binding?.kind === 'directory') {
    // directory-kind: hide git-only meta (branch, PR chips handled at card level)
    if (bindingLabel) meta.push(bindingLabel);
  } else if (bindingLabel) {
    meta.push(`repo ${bindingLabel}`);
  } else {
    meta.push('no repo binding');
  }
  return meta;
}

function ActiveWorkCard({ group }: { group: WorkContextActiveGroup }) {
  const queryClient = useQueryClient();
  const refreshAll = useSessionsStore((s) => s.refreshAll);
  const setActiveSessionId = useSessionsStore((s) => s.setActiveSessionId);
  const setActiveRepoPath = useUiStore((s) => s.setActiveRepoPath);
  const repos = useSessionsStore((s) => s.repos);
  const [inputValue, setInputValue] = useState('');
  const [inputStatus, setInputStatus] = useState<string | null>(null);
  const [isSubmittingInput, setIsSubmittingInput] = useState(false);
  const isSubmittingInputRef = useRef(false);
  const primarySession = activeWorkPrimarySession(group);
  const controlState = activeWorkMobileControlState(group, primarySession);
  const actors = actorLabels(group);
  const refs = taskRefs(group);
  const artifacts = group.context?.artifacts ?? [];

  const handleAttach = useCallback(() => {
    if (!primarySession || controlState.attachDisabledReason) return;
    const activationKey = activeWorkSessionActivationKey(primarySession);
    setActiveRepoPath(activeWorkSessionActivationRepoPath(primarySession));
    setActiveSessionId(activationKey);
    void refreshAll().then(() => setActiveSessionId(activationKey));
  }, [
    controlState.attachDisabledReason,
    primarySession,
    refreshAll,
    setActiveRepoPath,
    setActiveSessionId,
  ]);

  const handleSmallInput = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const value = inputValue.trimEnd();
      if (
        !primarySession ||
        controlState.smallInputDisabledReason ||
        !value ||
        isSubmittingInputRef.current
      ) {
        return;
      }
      isSubmittingInputRef.current = true;
      setIsSubmittingInput(true);
      setInputStatus('sending...');
      try {
        await sendSessionInput(
          activeWorkSessionActivationKey(primarySession),
          `${value}\r`,
          primarySession.nodeId
        );
        setInputValue('');
        setInputStatus('sent · recorded as control intervention');
        void queryClient.invalidateQueries({ queryKey: ['active-work'] });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setInputStatus(`failed: ${message}`);
      } finally {
        isSubmittingInputRef.current = false;
        setIsSubmittingInput(false);
      }
    },
    [
      controlState.smallInputDisabledReason,
      inputValue,
      primarySession,
      queryClient,
    ]
  );

  return (
    <article className="active-work-card" data-node-status={group.node.status}>
      <div className="active-work-card__status-strip" aria-hidden="true" />
      <div className="active-work-card__main">
        <div className="active-work-card__header">
          <div>
            <div className="active-work-card__eyebrow">
              {activeWorkStateLabel(group)}
            </div>
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
            <span className="active-work-label">workcontext</span>
            <span>{activeWorkContextLabel(group)}</span>
          </div>
          <div>
            <span className="active-work-label">anchor</span>
            <span>{activeWorkAnchorLabel(group, primarySession, repos)}</span>
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
            <span className="active-work-label">session</span>
            <span>
              {primarySession
                ? `${shortId(primarySession.globalSessionId ?? primarySession.id)} · ${primarySession.relationship}`
                : 'no session selected'}
            </span>
          </div>
          <div>
            <span className="active-work-label">control</span>
            <span>{controlSummary(controlState, primarySession)}</span>
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
                <SessionMailboxBadge
                  targetSessionId={activeWorkSessionActivationKey(session)}
                />
              </div>
              <div className="active-work-session__cwd">{session.cwd}</div>
              <div className="active-work-session__meta">
                {sessionMeta(group, session, repos).map((item) => (
                  <span key={item}>{item}</span>
                ))}
              </div>
            </div>
          ))}
        </div>

        <SessionMailboxPanel
          compact
          targetSessionId={
            primarySession ? activeWorkSessionActivationKey(primarySession) : null
          }
          title="primary session mailbox"
        />

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
            disabled={!!controlState.attachDisabledReason}
            title={
              controlState.attachDisabledReason ?? 'attach to live session'
            }
            onClick={handleAttach}
          >
            attach
          </TuiButton>
          <form className="active-work-input" onSubmit={handleSmallInput}>
            <label
              className="active-work-label"
              htmlFor={`active-work-input-${group.id}`}
            >
              {controlState.smallInputLabel}
            </label>
            <input
              id={`active-work-input-${group.id}`}
              value={inputValue}
              onChange={(event) => setInputValue(event.target.value)}
              disabled={!!controlState.smallInputDisabledReason}
              placeholder={controlState.smallInputPlaceholder}
              maxLength={1000}
              aria-describedby={`active-work-input-status-${group.id}`}
            />
            <TuiButton
              size="sm"
              variant="primary"
              type="submit"
              disabled={
                !!controlState.smallInputDisabledReason ||
                inputValue.trim().length === 0 ||
                isSubmittingInput
              }
              title={
                controlState.smallInputDisabledReason ??
                'send audited small input to the live PTY session'
              }
            >
              send
            </TuiButton>
          </form>
          <TuiButton
            size="sm"
            variant="danger"
            disabled
            title={controlState.destructiveDisabledReason}
          >
            kill
          </TuiButton>
          <TuiButton
            size="sm"
            variant="info"
            title="open fixture dry-run handoff plan"
            onClick={() =>
              useUiStore.getState().setActiveModal({ modal: 'handoff-plan' })
            }
          >
            handoff
          </TuiButton>
          <TuiButton
            size="sm"
            variant="ghost"
            disabled
            title="pause/retry require explicit control capability contracts before mobile can route them"
          >
            pause/retry
          </TuiButton>
          {(controlState.attachDisabledReason ||
            controlState.smallInputDisabledReason) && (
            <span className="active-work-disabled-reason">
              controls disabled:{' '}
              {controlState.attachDisabledReason ??
                controlState.smallInputDisabledReason}
            </span>
          )}
          {inputStatus && (
            <span
              id={`active-work-input-status-${group.id}`}
              className="active-work-disabled-reason"
              role="status"
            >
              {inputStatus}
            </span>
          )}
        </div>
      </div>
    </article>
  );
}

export default function ActiveWorkSurface() {
  const queryClient = useQueryClient();
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

  useEffect(() => {
    const invalidateActiveWork = () => {
      void queryClient.invalidateQueries({ queryKey: ['active-work'] });
    };
    window.addEventListener('relay-active-work-changed', invalidateActiveWork);
    return () => {
      window.removeEventListener('relay-active-work-changed', invalidateActiveWork);
    };
  }, [queryClient]);

  const groups = useMemo(
    () =>
      [...data].sort(
        (a, b) =>
          activeWorkAttentionPriority(a) - activeWorkAttentionPriority(b)
      ),
    [data]
  );
  const attentionCount = groups.filter(
    (group) => activeWorkAttentionPriority(group) <= 3
  ).length;

  if (isLoading)
    return (
      <div className="state-message">
        loading active work cockpit — checking workcontexts, node freshness,
        mailbox refs, and artifacts...
      </div>
    );
  if (isError) {
    return (
      <div className="state-message state-message--error">
        <span>
          could not load active work cockpit. prs, tickets, nodes, and audit stay
          available as secondary tabs; retry to refresh workcontext status.
        </span>
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
          <p>
            primary operator cockpit grouped by workcontext across local, remote,
            repo-bound, and free sessions
          </p>
        </div>
        <div className="active-work-surface__summary">
          <span>{groups.length} contexts</span>
          <span>{attentionCount} stale/needs attention</span>
        </div>
      </div>
      {groups.length === 0 ? (
        <div className="active-work-empty">
          <span>no active work in the cockpit</span>
          <span>
            start from an issue, assistant, or node terminal; workcontexts,
            mailboxes, artifacts, and stale/offline node state will appear here.
            prs, tickets, nodes, and audit stay available above as secondary
            context.
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
