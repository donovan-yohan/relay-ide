import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
  type CSSProperties,
  type ReactNode,
} from 'react';
import {
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { useShallow } from 'zustand/react/shallow';
import {
  CircleAlert,
  Folder,
  GitBranch,
  LoaderCircle,
  MessageSquare,
  TriangleAlert,
} from 'lucide-react';
import type {
  WorkflowRunProjection,
  WorkflowRunSessionLink,
  WorkflowRunState,
} from '../../../shared/workflow-run.js';
import type { RosterAttention } from '../../../shared/agent-roster.js';
import { builtInAgentProfileId } from '../../../shared/agent-profile.js';
import {
  parseMentions,
  type ChannelMessage,
} from '../../../shared/channel-chat-protocol.js';
import {
  createGlobalSessionId,
  DEFAULT_LOCAL_NODE_ID,
} from '../../../shared/identity.js';
import type { WorkspaceSurface } from '../../../shared/workspace-surfaces.js';
import {
  resolveTopicActiveContext,
  type WorkspaceTopic,
  type WorkspaceTopicSearchResult,
} from '../../../shared/workspace-topics.js';
import {
  fetchHubNodes,
  fetchAgentRoster,
  fetchChannelRoster,
  fetchChannelHistory,
  fetchWorkflowRuns,
  fetchWorkspaceSurfaces,
  fetchWorkspaceTopics,
  interruptChannelAgent,
  postChannelMessage,
  restoreWorkspaceTopic,
  searchWorkspaceTopics,
  sendSessionInput,
  type ChannelAgentStatus,
} from '../lib/api.js';
import { deriveColor } from '../lib/colors.js';
import { resolveSenderIdentity } from '../lib/chat/sender-identity.js';
import {
  hasUnseenActivity,
  useChannelActivityStore,
} from '../lib/stores/channel-activity.js';
import { AgentAvatar } from './chat/AgentAvatar.js';
import { openTopicTaskRoom } from '../lib/topic-task-room.js';
import type { SessionSummary } from '../lib/types.js';
import { formatRelativeTimeCompact } from '../lib/utils.js';
import { useSessionsStore } from '../lib/stores/sessions.js';
import { useUiStore } from '../lib/stores/ui.js';
import { useToastStore } from '../lib/stores/toasts.js';
import {
  channelAgentStatusKey,
  resolveEffectiveAgentStatus,
  useChannelAgentStatusStore,
} from '../lib/stores/channel-agent-status.js';
import { useIaWorkspacesQuery } from '../lib/hooks/use-ia-workspaces.js';
import { durabilityDisabledReason } from '../lib/session-durability.js';
import {
  buildTopicNavModel,
  formatTaskRefLabel,
  selectChannelRailTree,
  type ChannelRailNode,
  type ChannelRailSection,
  type ChannelRailTree,
  type TopicNavItem,
  type TopicNavModel,
  type TopicNavNode,
  type TopicNavWorkspace,
  type TopicNavParticipantRef,
  type TopicNavSessionRef,
  type TopicNavSurfaceRef,
  type TopicNavTone,
} from '../lib/state/topic-nav.js';
import { MarqueeText } from './MarqueeText.js';
import {
  CockpitPresenceChip,
  MobileCockpitAttentionLane,
  MobileCockpitRowActions,
} from './MobileCockpitAttentionLane.js';
import './TopicSidebarShell.css';

function AttentionIcon({ tone }: { tone: TopicNavItem['tone'] }) {
  if (tone === 'active') {
    return (
      <LoaderCircle className="topic-status__spinner" aria-hidden size={13} />
    );
  }
  if (tone === 'attention') return <CircleAlert aria-hidden size={13} />;
  if (tone === 'error') return <TriangleAlert aria-hidden size={13} />;
  return null;
}

function StatusGlyph({ tone }: { tone: TopicNavItem['tone'] }) {
  const attention = AttentionIcon({ tone });
  return (
    <span className={`topic-status topic-status--${tone}`} aria-hidden>
      {attention}
    </span>
  );
}

function TopicKindIcon({ kind }: { kind: TopicNavItem['kind'] }) {
  if (kind === 'repo') return <GitBranch aria-hidden size={13} />;
  if (kind === 'folder') return <Folder aria-hidden size={13} />;
  return <MessageSquare aria-hidden size={13} />;
}

type TopicSendInput = typeof sendSessionInput;

const DISCONNECTED_SESSION_CONTROL_REASON =
  'session offline/disconnected — controls unavailable until reconnect';
const TOPIC_LATEST_STATUS_MAX_LENGTH = 96;
const WORKFLOW_RUNS_LIMIT = 5;
const MOBILE_COCKPIT_ROSTER_BATCH_SIZE = 12;
const CURRENT_OPERATOR_SENDER_ID = 'human:operator';
const CURRENT_OPERATOR_MENTION_NAME = 'operator';
const EMPTY_WORKFLOW_RUNS: WorkflowRunProjection[] = [];

function useMobileCockpitViewport(): boolean {
  const [matches, setMatches] = useState(
    () =>
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(max-width: 600px)').matches
  );
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return undefined;
    const media = window.matchMedia('(max-width: 600px)');
    const update = () => setMatches(media.matches);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  return matches;
}

function messageMentionsCurrentOperator(message: ChannelMessage): boolean {
  if (message.sender.id === CURRENT_OPERATOR_SENDER_ID) return false;
  // Browser-authored channel posts are canonically `human:operator` with the
  // display name `Operator` (channel-chat-router deriveSender). Persisted
  // mentions come from this same parser; parse older rows when metadata is
  // absent rather than introducing a cockpit-only regex/tokenizer.
  const mentions = message.mentions ?? parseMentions(message.body.text);
  return mentions.some(
    (mention) =>
      mention.raw.slice(1).toLowerCase() === CURRENT_OPERATOR_MENTION_NAME
  );
}

function boundedTopicLatestStatus(value: string): string {
  const trimmed = value.trim();
  return trimmed.length > TOPIC_LATEST_STATUS_MAX_LENGTH
    ? `${trimmed.slice(0, TOPIC_LATEST_STATUS_MAX_LENGTH - 3)}...`
    : trimmed;
}

function topicPrimarySession(
  item: TopicNavItem
): TopicNavSessionRef | undefined {
  return [...item.sessions].sort((a, b) => {
    if (a.displayState !== b.displayState) {
      const priority = {
        permission: 0,
        'needs-answer': 1,
        error: 2,
        running: 3,
        initializing: 4,
        'unseen-idle': 5,
        'seen-idle': 6,
        inactive: 7,
      } satisfies Record<TopicNavSessionRef['displayState'], number>;
      return priority[a.displayState] - priority[b.displayState];
    }
    return (b.lastActivity ?? '').localeCompare(a.lastActivity ?? '');
  })[0];
}

function sessionAttachDisabledReason(
  session: TopicNavSessionRef | undefined
): string | null {
  if (!session) return 'no session linked to this topic';
  if (session.status === 'disconnected') {
    return DISCONNECTED_SESSION_CONTROL_REASON;
  }
  const durabilityReason = durabilityDisabledReason(
    session.durability ?? undefined
  );
  if (durabilityReason) return durabilityReason;
  return null;
}

function sessionControlDisabledReason(
  session: TopicNavSessionRef | undefined
): string | null {
  if (!session) return 'no session linked to this topic';
  const attachReason = sessionAttachDisabledReason(session);
  if (attachReason) return attachReason;
  if (session.controlFreshness === 'stale') return 'stale control state';
  if (session.controlFreshness !== 'fresh') return 'unknown control state';
  if (session.mode === 'web') return 'web session input is unsupported here';
  return null;
}

function topicPrimaryAction(item: TopicNavItem): {
  label: string;
  detail: string;
  disabledReason: string | null;
} {
  const session = topicPrimarySession(item);
  const controlDisabledReason = session
    ? sessionControlDisabledReason(session)
    : null;
  const attachDisabledReason = session
    ? sessionAttachDisabledReason(session)
    : null;
  if (session?.displayState === 'permission') {
    return {
      label: 'approve',
      detail: 'send an audited approval reply to the live session',
      disabledReason: controlDisabledReason,
    };
  }
  if (session?.displayState === 'needs-answer') {
    return {
      label: 'reply',
      detail: 'send a short audited reply without opening the terminal first',
      disabledReason: controlDisabledReason,
    };
  }
  if (session && attachDisabledReason) {
    return {
      label: 'waiting',
      detail:
        'last known session context remains readable; live controls are disabled',
      disabledReason: attachDisabledReason,
    };
  }
  if (session) {
    return {
      label: 'resume',
      detail: 'open the linked Relay tab; raw PTY remains the fallback',
      disabledReason: null,
    };
  }
  if (item.surfaces.length > 0) {
    return {
      label: 'view artifact',
      detail: 'open or copy the top linked topic surface',
      disabledReason: null,
    };
  }
  return {
    label: 'waiting',
    detail: 'no live session or artifact is linked yet',
    disabledReason: 'no live control target',
  };
}

function shouldShowMobileControlPanel(item: TopicNavItem | undefined): boolean {
  if (!item) return false;
  const action = topicPrimaryAction(item);
  return (
    action.label === 'approve' ||
    action.label === 'reply' ||
    action.label === 'waiting'
  );
}

function topicLatestStatus(item: TopicNavItem): string {
  const session = topicPrimarySession(item);
  if (session?.agentState === 'permission-prompt') {
    const status = session.currentActivity?.detail
      ? `${item.statusLabel} · ${session.currentActivity.detail}`
      : item.statusLabel;
    return boundedTopicLatestStatus(status);
  }
  if (session?.currentActivity) {
    const detail = session.currentActivity.detail
      ? ` · ${session.currentActivity.detail}`
      : '';
    return boundedTopicLatestStatus(`${session.currentActivity.tool}${detail}`);
  }
  if (item.surfaces.length > 0) {
    return boundedTopicLatestStatus(
      `${item.statusLabel} · ${item.surfaces[0]!.label}`
    );
  }
  return boundedTopicLatestStatus(item.routingLabel ?? item.statusLabel);
}

function TopicBadge({ item }: { item: TopicNavItem }) {
  // #1166: DM rows show the agent's colored glyph on a muted-variant background
  // (the same color-mix recipe repo-identity badges use), not a generic icon.
  if (item.isDirectMessage && item.dmProviderId) {
    const identity = resolveSenderIdentity({
      kind: 'agent',
      // A DM row targets a vendor, i.e. its DEFAULT profile — key on the profile
      // Actor id so the sidebar dot keeps the curated vendor token (#1234).
      id: builtInAgentProfileId(item.dmProviderId),
      providerId: item.dmProviderId,
    });
    return (
      <AgentAvatar
        className="topic-row__dm-avatar"
        identity={identity}
        name={identity.label}
        size={22}
        title={`direct message with ${identity.label}`}
      />
    );
  }
  const background = item.color ?? deriveColor(item.badgeSeed);
  const label = item.channelKind
    ? `${item.channelKind} channel`
    : `${item.kindLabel} workspace`;
  return (
    <span
      className="topic-row__badge"
      data-kind={item.channelKind ?? item.kind}
      style={{ background }}
      aria-label={label}
      title={label}
    >
      {item.icon ? (
        <span className="topic-row__channel-icon" aria-hidden="true">
          {item.icon}
        </span>
      ) : (
        <TopicKindIcon kind={item.kind} />
      )}
    </span>
  );
}

type TopicRoomSessionGroupKey =
  | 'needs-input'
  | 'approval'
  | 'running'
  | 'idle'
  | 'stale-offline'
  | 'crashed';

const TOPIC_ROOM_SESSION_GROUPS: {
  key: TopicRoomSessionGroupKey;
  label: string;
}[] = [
  { key: 'needs-input', label: 'needs input' },
  { key: 'approval', label: 'approval' },
  { key: 'running', label: 'running' },
  { key: 'idle', label: 'idle' },
  { key: 'stale-offline', label: 'stale/offline' },
  { key: 'crashed', label: 'crashed' },
];

function topicRoomSessionGroup(
  session: TopicNavSessionRef
): TopicRoomSessionGroupKey {
  if (
    session.status === 'disconnected' ||
    session.durability === 'stale-node' ||
    session.durability === 'ended' ||
    session.controlFreshness === 'stale'
  ) {
    return 'stale-offline';
  }
  if (session.displayState === 'error' || session.durability === 'error') {
    return 'crashed';
  }
  if (session.displayState === 'needs-answer') return 'needs-input';
  if (session.displayState === 'permission') return 'approval';
  if (
    session.displayState === 'running' ||
    session.displayState === 'initializing'
  ) {
    return 'running';
  }
  return 'idle';
}

function topicRoomGroupedSessions(item: TopicNavItem): {
  key: TopicRoomSessionGroupKey;
  label: string;
  sessions: TopicNavSessionRef[];
}[] {
  return TOPIC_ROOM_SESSION_GROUPS.map((group) => ({
    ...group,
    sessions: item.sessions.filter(
      (session) => topicRoomSessionGroup(session) === group.key
    ),
  })).filter((group) => group.sessions.length > 0);
}

function topicRoomFreshnessLabel(item: TopicNavItem): string {
  const groups = new Set(item.sessions.map(topicRoomSessionGroup));
  if (groups.has('stale-offline')) return 'stale/offline';
  if (groups.has('crashed')) return 'crashed';
  if (groups.has('needs-input') || groups.has('approval')) return 'needs input';
  if (groups.has('running')) return 'fresh';
  if (item.surfaces.some((surface) => surface.health === 'unreachable')) {
    return 'surface error';
  }
  if (
    item.sessions.length === 0 &&
    item.surfaces.length === 0 &&
    item.taskRefs.length === 0 &&
    item.artifactIds.length === 0
  ) {
    return 'empty';
  }
  return 'last known';
}

function topicRoomLatestSummary(item: TopicNavItem): string {
  const session = topicPrimarySession(item);
  if (session?.currentActivity) return topicLatestStatus(item);
  if (session) return `${session.label} · ${session.displayState}`;
  if (item.surfaces[0]) return `newest surface · ${item.surfaces[0].label}`;
  if (item.taskRefs[0]) {
    return `task ref · ${item.taskRefs[0].title ?? item.taskRefs[0].id}`;
  }
  return 'no sessions linked yet';
}

function topicRoomAnchorLabel(item: TopicNavItem): string {
  return item.routingLabel ?? 'no repo binding';
}

function SurfaceButton({ surface }: { surface: TopicNavSurfaceRef }) {
  const canOpen =
    surface.openMode === 'direct' && surface.target?.startsWith('http');
  const label = `${surface.kind}: ${surface.label}`;
  if (canOpen) {
    return (
      <a
        className={`topic-action topic-action--${surface.health}`}
        href={surface.target ?? undefined}
        rel="noreferrer"
        target="_blank"
        title={`${label} · ${surface.health}`}
      >
        {surface.kind}
      </a>
    );
  }
  return (
    <button
      className={`topic-action topic-action--${surface.health}`}
      type="button"
      disabled={!surface.target}
      title={`${label} · ${surface.openMode}`}
      onClick={() => {
        if (surface.target) void navigator.clipboard?.writeText(surface.target);
      }}
    >
      {surface.kind}
    </button>
  );
}

function participantLastActivityLabel(
  participant: TopicNavParticipantRef
): string {
  return participant.lastActivity
    ? `last ${formatRelativeTimeCompact(participant.lastActivity)}`
    : 'last unknown';
}

function ParticipantChildRow({
  participant,
  onSelectSession,
}: {
  participant: TopicNavParticipantRef;
  onSelectSession?: ((id: string) => void) | undefined;
}) {
  const handleSelect = onSelectSession
    ? () => onSelectSession(participant.selectKey)
    : undefined;
  return (
    <li className={`topic-child-row topic-child-row--${participant.tone}`}>
      <button
        type="button"
        className="topic-child-row__button"
        {...(handleSelect ? { onClick: handleSelect } : { disabled: true })}
        title={`open existing session ${participant.label}`}
      >
        <span className="topic-child-row__icon" aria-hidden="true">
          <MessageSquare size={12} />
        </span>
        <span className="topic-child-row__label">
          <MarqueeText>{participant.label}</MarqueeText>
        </span>
        <StatusGlyph tone={participant.tone} />
      </button>
    </li>
  );
}

function participantGroups(participants: TopicNavParticipantRef[]) {
  const groups = new Map<string, TopicNavParticipantRef[]>();
  for (const participant of participants) {
    const key = `${participant.roleLabel} · ${participant.providerLabel}`;
    const existing = groups.get(key) ?? [];
    existing.push(participant);
    groups.set(key, existing);
  }
  return Array.from(groups.entries());
}

function ParticipantRoster({
  item,
  onSelectSession,
}: {
  item: TopicNavItem;
  onSelectSession?: ((id: string) => void) | undefined;
}) {
  if (item.participants.length === 0) return null;
  return (
    <section className="topic-participants" aria-label="participant roster">
      <div className="topic-participants__header">
        <span>participants</span>
        <span>{item.participants.length} linked</span>
      </div>
      {participantGroups(item.participants).map(([group, participants]) => (
        <div className="topic-participant-group" key={group}>
          <div className="topic-participant-group__label">{group}</div>
          <div className="topic-participant-group__grid">
            {participants.map((participant) => {
              const handleSelect = onSelectSession
                ? () => onSelectSession(participant.selectKey)
                : undefined;
              const lastActivityLabel =
                participantLastActivityLabel(participant);
              return (
                <button
                  key={participant.id}
                  type="button"
                  className={`topic-participant-card topic-participant-card--${participant.tone}`}
                  {...(handleSelect
                    ? { onClick: handleSelect }
                    : { disabled: true })}
                  title={`open existing session ${participant.label}`}
                >
                  <span className="topic-participant-card__topline">
                    <span className="topic-participant-card__name">
                      {participant.label}
                    </span>
                    <span className="topic-participant-card__status">
                      {participant.statusLabel}
                    </span>
                  </span>
                  <span className="topic-participant-card__meta">
                    {participant.roleLabel} · {participant.providerLabel}
                  </span>
                  <span className="topic-participant-card__meta">
                    {participant.runtimeLabel}
                    {participant.nodeLabel ? ` · ${participant.nodeLabel}` : ''}
                  </span>
                  <span className="topic-participant-card__meta">
                    {lastActivityLabel} · {participant.controlLabel}
                  </span>
                  {participant.summaryLabel ? (
                    <span className="topic-participant-card__summary">
                      {participant.summaryLabel}
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </section>
  );
}

function TopicRoomSessionRow({
  session,
  onSelectSession,
}: {
  session: TopicNavSessionRef;
  onSelectSession?: ((id: string) => void) | undefined;
}) {
  const disabledReason = sessionControlDisabledReason(session);
  return (
    <li className={`topic-room-session topic-room-session--${session.tone}`}>
      <button
        type="button"
        className="topic-room-session__button"
        title={`open exact session ${session.label}`}
        onClick={() => onSelectSession?.(session.selectKey)}
      >
        <span className="topic-room-session__main">
          <span className="topic-room-session__label">
            <MarqueeText>{session.label}</MarqueeText>
          </span>
          <span className="topic-room-session__meta">
            {session.agent} · {session.type} · {session.displayState}
          </span>
        </span>
        <span className="topic-room-session__anchor">
          {session.nodeLabel ? `${session.nodeLabel} · ` : ''}
          {session.branch ?? session.cwd}
        </span>
        <StatusGlyph tone={session.tone} />
      </button>
      {disabledReason ? (
        <span className="topic-room-session__disabled">
          live controls disabled: {disabledReason}
        </span>
      ) : null}
    </li>
  );
}

function workflowRunTone(state: WorkflowRunState): TopicNavTone {
  if (state === 'failed' || state === 'cancelled' || state === 'stale') {
    return 'error';
  }
  if (state === 'waiting') return 'attention';
  if (state === 'queued' || state === 'running') return 'active';
  if (state === 'succeeded') return 'idle';
  return 'empty';
}

function orchestrationLaneTone(link: WorkflowRunSessionLink): TopicNavTone {
  if (link.attention?.needsAttention) return 'attention';
  return workflowRunTone(link.state ?? 'unknown');
}

function orchestrationLaneSelectKey(
  link: WorkflowRunSessionLink
): string | null {
  if (link.globalSessionId) return link.globalSessionId;
  if (link.nodeId && link.nodeId !== DEFAULT_LOCAL_NODE_ID && link.sessionId) {
    return createGlobalSessionId(link.nodeId, link.sessionId);
  }
  return link.sessionId ?? null;
}

function orchestrationLaneLabel(link: WorkflowRunSessionLink): string {
  return (
    link.displayName ??
    link.sessionId ??
    link.globalSessionId ??
    `${link.role} lane`
  );
}

function orchestrationLaneStatus(link: WorkflowRunSessionLink): string {
  const pending = link.attention?.pendingInboxCount ?? 0;
  if (pending > 0) return `${pending} pending`;
  if (link.attention?.needsAttention) {
    const reasons = link.attention.reasons?.slice(0, 2).join(', ');
    return reasons ? `attention · ${reasons}` : 'needs attention';
  }
  return link.state ?? 'linked';
}

function orchestrationRunSummary(run: WorkflowRunProjection): string {
  if (run.errorSummary) return run.errorSummary;
  if (run.resultSummary) return run.resultSummary;
  const latest = run.journal?.[run.journal.length - 1];
  return latest?.summary ?? 'no run journal yet';
}

function orchestrationRunEvidenceRefs(run: WorkflowRunProjection): string[] {
  return [
    ...(run.links?.artifactIds ?? []),
    ...(run.links?.handoffArtifactIds ?? []),
  ];
}

function orchestrationRunMailCount(run: WorkflowRunProjection): number {
  const links = [
    run.orchestration?.planner,
    ...(run.orchestration?.children ?? []),
  ].filter((link): link is WorkflowRunSessionLink => Boolean(link));
  const attentionCount = links.reduce(
    (sum, link) => sum + (link.attention?.pendingInboxCount ?? 0),
    0
  );
  return Math.max(run.links?.inboxMessageIds?.length ?? 0, attentionCount);
}

function isOrchestrationWorkflowRun(run: WorkflowRunProjection): boolean {
  return run.runKind === 'relay-orchestration' || Boolean(run.orchestration);
}

function OrchestrationLaneRow({
  link,
  laneKind,
  onSelectSession,
}: {
  link: WorkflowRunSessionLink;
  laneKind: 'planner' | 'worker';
  onSelectSession?: ((id: string) => void) | undefined;
}) {
  const selectKey = orchestrationLaneSelectKey(link);
  const handleSelect =
    selectKey && onSelectSession ? () => onSelectSession(selectKey) : undefined;
  const tone = orchestrationLaneTone(link);
  return (
    <li
      className={`topic-orchestration-lane topic-orchestration-lane--${tone}`}
    >
      <button
        type="button"
        className="topic-orchestration-lane__button"
        {...(handleSelect ? { onClick: handleSelect } : { disabled: true })}
        title={
          handleSelect ? `open ${link.role} session` : 'session not linked'
        }
      >
        <span className="topic-orchestration-lane__icon" aria-hidden="true">
          <MessageSquare size={12} />
        </span>
        <span className="topic-orchestration-lane__main">
          <span className="topic-orchestration-lane__label">
            <MarqueeText>{orchestrationLaneLabel(link)}</MarqueeText>
          </span>
          <span className="topic-orchestration-lane__meta">
            {laneKind} · {link.role} · {link.provider ?? 'provider unknown'}
          </span>
        </span>
        <span className="topic-orchestration-lane__state">
          {orchestrationLaneStatus(link)}
        </span>
        <StatusGlyph tone={tone} />
      </button>
    </li>
  );
}

function OrchestrationRunCard({
  run,
  onSelectSession,
}: {
  run: WorkflowRunProjection;
  onSelectSession?: ((id: string) => void) | undefined;
}) {
  const planner = run.orchestration?.planner;
  const children = run.orchestration?.children ?? [];
  const lanes = (planner ? 1 : 0) + children.length;
  const evidenceRefs = orchestrationRunEvidenceRefs(run);
  const mailCount = orchestrationRunMailCount(run);
  return (
    <article
      className={`topic-orchestration-run topic-orchestration-run--${workflowRunTone(run.state)}`}
    >
      <div className="topic-orchestration-run__header">
        <span className="topic-orchestration-run__title">
          <MarqueeText>{run.definition.templateId ?? run.runId}</MarqueeText>
        </span>
        <span className="topic-orchestration-run__state">{run.state}</span>
      </div>
      <p className="topic-orchestration-run__summary">
        {orchestrationRunSummary(run)}
      </p>
      <div className="topic-orchestration-run__meta">
        <span>{lanes} lanes</span>
        <span>{mailCount} mail</span>
        <span>{evidenceRefs.length} evidence refs</span>
        <span>updated {formatRelativeTimeCompact(run.updatedAt)}</span>
      </div>
      {evidenceRefs.length > 0 ? (
        <div
          className="topic-orchestration-run__evidence"
          aria-label="orchestration evidence refs"
        >
          {evidenceRefs.slice(0, 3).map((ref) => (
            <span key={ref}>{ref}</span>
          ))}
          {evidenceRefs.length > 3 ? (
            <span>+{evidenceRefs.length - 3} more</span>
          ) : null}
        </div>
      ) : null}
      <ul className="topic-orchestration-run__lanes">
        {planner ? (
          <OrchestrationLaneRow
            link={planner}
            laneKind="planner"
            {...(onSelectSession ? { onSelectSession } : {})}
          />
        ) : null}
        {children.map((child, index) => (
          <OrchestrationLaneRow
            key={
              child.globalSessionId ??
              child.sessionId ??
              `${child.role}:${child.provider ?? 'worker'}:${index}`
            }
            link={child}
            laneKind="worker"
            {...(onSelectSession ? { onSelectSession } : {})}
          />
        ))}
        {!planner && children.length === 0 ? (
          <li className="topic-room-empty">no visible lanes linked yet</li>
        ) : null}
      </ul>
    </article>
  );
}

function TopicRoomOrchestrationRuns({
  item,
  workflowRuns,
  loading,
  error,
  onSelectSession,
}: {
  item: TopicNavItem;
  workflowRuns: WorkflowRunProjection[];
  loading: boolean;
  error: boolean;
  onSelectSession?: ((id: string) => void) | undefined;
}) {
  const workContextId = item.workContextIds[0];
  if (!workContextId) {
    return <p className="topic-room-empty">no WorkContext linked yet</p>;
  }
  if (loading && workflowRuns.length === 0) {
    return <p className="topic-room-empty">orchestration runs loading...</p>;
  }
  if (error && workflowRuns.length === 0) {
    return (
      <p className="topic-room-empty error">orchestration runs unavailable</p>
    );
  }
  const orchestrationRuns = workflowRuns.filter(isOrchestrationWorkflowRun);
  if (orchestrationRuns.length === 0) {
    return <p className="topic-room-empty">no orchestration runs linked yet</p>;
  }
  return (
    <div className="topic-orchestration-list">
      {orchestrationRuns.map((run) => (
        <OrchestrationRunCard
          key={run.id}
          run={run}
          {...(onSelectSession ? { onSelectSession } : {})}
        />
      ))}
      {error ? (
        <p className="topic-room-empty error">
          orchestration runs partially unavailable
        </p>
      ) : null}
    </div>
  );
}

function TopicRoomTaskRefs({ item }: { item: TopicNavItem }) {
  if (item.taskRefs.length === 0) {
    return <p className="topic-room-empty">no task refs linked yet</p>;
  }
  return (
    <ul className="topic-room-ref-list" aria-label="task refs">
      {item.taskRefs.map((taskRef) => {
        const label = formatTaskRefLabel(taskRef);
        const content = (
          <>
            <span>{taskRef.kind}</span>
            <strong>{label}</strong>
            {taskRef.status ? <span>{taskRef.status}</span> : null}
          </>
        );
        return (
          <li key={`${taskRef.kind}:${taskRef.id}`}>
            {taskRef.url ? (
              <a href={taskRef.url} rel="noreferrer" target="_blank">
                {content}
              </a>
            ) : (
              <span>{content}</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function TopicRoomSurfaceStrip({
  item,
  surfacesError,
  surfacesLoading,
}: {
  item: TopicNavItem;
  surfacesError?: boolean | undefined;
  surfacesLoading?: boolean | undefined;
}) {
  if (surfacesLoading && item.surfaces.length === 0) {
    return <p className="topic-room-empty">surfaces loading…</p>;
  }
  if (surfacesError && item.surfaces.length === 0) {
    return <p className="topic-room-empty error">surfaces unavailable</p>;
  }
  if (item.surfaces.length === 0 && item.artifactIds.length === 0) {
    return (
      <p className="topic-room-empty">no artifacts or surfaces linked yet</p>
    );
  }
  return (
    <ul
      className="topic-room-surface-list"
      aria-label="artifact and surface strip"
    >
      {item.surfaces.map((surface) => (
        <li key={surface.id}>
          <SurfaceButton surface={surface} />
          <span className="topic-room-surface-list__label">
            {surface.label}
          </span>
          <span className="topic-room-surface-list__safety">
            {surface.openMode === 'direct'
              ? 'direct open'
              : `${surface.openMode} only`}
          </span>
        </li>
      ))}
      {item.artifactIds.map((artifactId) => (
        <li key={artifactId}>
          <span className="topic-action">artifact</span>
          <span className="topic-room-surface-list__label">{artifactId}</span>
          <span className="topic-room-surface-list__safety">
            metadata ref only
          </span>
        </li>
      ))}
      {surfacesError ? (
        <li className="topic-room-empty error">
          surfaces partially unavailable
        </li>
      ) : null}
    </ul>
  );
}

/** Friendly workspace name for a topic; `null` (never a raw id) when unresolved. */
function resolveWorkspaceName(
  item: TopicNavItem,
  workspaceNameById: Map<string, string>
): string | null {
  if (!item.workspaceId) return null;
  return workspaceNameById.get(item.workspaceId) ?? null;
}

function TopicDetail({
  item,
  workspaceName,
  surfacesError,
  surfacesLoading,
  workflowRuns,
  workflowRunsError,
  workflowRunsLoading,
  onSelectSession,
  onRestoreTopic,
  restoringTopicId,
  onOpenEvidenceDashboard,
}: {
  item: TopicNavItem;
  /** Friendly workspace name for the meta strip; omitted entirely (never a raw id) when unresolved. */
  workspaceName?: string | null | undefined;
  surfacesError?: boolean | undefined;
  surfacesLoading?: boolean | undefined;
  workflowRuns: WorkflowRunProjection[];
  workflowRunsError: boolean;
  workflowRunsLoading: boolean;
  onSelectSession?: ((id: string) => void) | undefined;
  onRestoreTopic?: ((topicId: string) => void) | undefined;
  restoringTopicId?: string | undefined;
  onOpenEvidenceDashboard?: (() => void) | undefined;
}) {
  const action = topicPrimaryAction(item);
  const session = topicPrimarySession(item);
  const topSurface = item.surfaces[0];
  const groupedSessions = topicRoomGroupedSessions(item);
  const orchestrationRunCount = workflowRuns.filter(
    isOrchestrationWorkflowRun
  ).length;
  const primaryDisabled =
    Boolean(action.disabledReason) || (!session && !topSurface?.target);
  return (
    <section
      className={`topic-detail topic-room topic-room--${item.tone}`}
      aria-label={`${item.title} task room`}
    >
      <header className="topic-room__header">
        <div className="topic-room__identity">
          <span className="topic-room__eyebrow">task room</span>
          <div className="topic-detail__title topic-room__title">
            <MarqueeText>{item.title}</MarqueeText>
          </div>
        </div>
        <TopicBadge item={item} />
      </header>
      {item.description ? (
        <p className="topic-detail__description">{item.description}</p>
      ) : (
        <p className="topic-detail__description muted">no topic brief yet</p>
      )}
      <div className="topic-detail__meta topic-room__meta">
        {workspaceName ? <span>{workspaceName}</span> : null}
        <span>{item.lifecycleLabel}</span>
        <span>{topicRoomFreshnessLabel(item)}</span>
        <span>{topicRoomAnchorLabel(item)}</span>
        <span>updated {item.updatedAt}</span>
        {item.lifecycleLabel === 'archived' && onRestoreTopic ? (
          <button
            type="button"
            className="topic-detail__restore"
            disabled={restoringTopicId === item.id}
            onClick={() => onRestoreTopic(item.id)}
          >
            {restoringTopicId === item.id ? 'restoring…' : 'restore'}
          </button>
        ) : null}
      </div>

      <div className="topic-room__action-band">
        <div>
          <span>primary action</span>
          <strong>{action.label}</strong>
          <p>{action.detail}</p>
        </div>
        <button
          type="button"
          className="topic-room__primary"
          disabled={primaryDisabled}
          title={action.disabledReason ?? action.detail}
          onClick={() => {
            if (session) {
              onSelectSession?.(session.selectKey);
              return;
            }
            if (!topSurface?.target) return;
            if (
              topSurface.openMode === 'direct' &&
              topSurface.target.startsWith('http')
            ) {
              window.open(topSurface.target, '_blank', 'noopener,noreferrer');
              return;
            }
            void navigator.clipboard?.writeText(topSurface.target);
          }}
        >
          {action.label}
        </button>
        {action.disabledReason ? (
          <p className="topic-room__disabled">
            controls disabled: {action.disabledReason}
          </p>
        ) : null}
      </div>

      <div className="topic-room__status-card">
        <span>latest bounded status</span>
        <strong>{topicRoomLatestSummary(item)}</strong>
      </div>

      <section className="topic-room__section" aria-label="orchestration runs">
        <div className="topic-room__section-header">
          <span>orchestration</span>
          <span>{orchestrationRunCount} runs</span>
        </div>
        <TopicRoomOrchestrationRuns
          item={item}
          workflowRuns={workflowRuns}
          loading={workflowRunsLoading}
          error={workflowRunsError}
          onSelectSession={onSelectSession}
        />
      </section>

      <section className="topic-room__section" aria-label="grouped sessions">
        <div className="topic-room__section-header">
          <span>sessions</span>
          <span>{item.sessions.length}</span>
        </div>
        {groupedSessions.length > 0 ? (
          groupedSessions.map((group) => (
            <div className="topic-room-session-group" key={group.key}>
              <div className="topic-room-session-group__label">
                {group.label} · {group.sessions.length}
              </div>
              <ul>
                {group.sessions.map((groupSession) => (
                  <TopicRoomSessionRow
                    key={groupSession.id}
                    session={groupSession}
                    onSelectSession={onSelectSession}
                  />
                ))}
              </ul>
            </div>
          ))
        ) : (
          <p className="topic-room-empty">no sessions linked yet</p>
        )}
      </section>

      <section className="topic-room__section" aria-label="task refs">
        <div className="topic-room__section-header">
          <span>refs</span>
          <span>{item.taskRefs.length} task refs</span>
        </div>
        <TopicRoomTaskRefs item={item} />
      </section>

      <section
        className="topic-room__section"
        aria-label="artifacts and surfaces"
      >
        <div className="topic-room__section-header">
          <span>artifacts/surfaces</span>
          <span>{item.surfaces.length + item.artifactIds.length}</span>
          {onOpenEvidenceDashboard ? (
            <button
              type="button"
              className="topic-room__evidence-link"
              onClick={onOpenEvidenceDashboard}
            >
              open evidence dashboard
            </button>
          ) : null}
        </div>
        <TopicRoomSurfaceStrip
          item={item}
          surfacesError={surfacesError}
          surfacesLoading={surfacesLoading}
        />
      </section>

      <div className="topic-room__fallback">
        raw terminal attach stays secondary; select a session row for exact tab
        fallback.
      </div>

      <ParticipantRoster item={item} onSelectSession={onSelectSession} />
    </section>
  );
}

function TopicMobileAttentionRow({
  node,
  statusByChannelAgent,
  onNudge,
  onInterrupt,
  depth,
  selected,
  onSelect,
}: {
  node: ChannelRailNode;
  statusByChannelAgent: Readonly<Record<string, ChannelAgentStatus>>;
  onNudge: (
    channelId: string,
    text: string,
    clientMessageId: string
  ) => Promise<void>;
  onInterrupt: (channelId: string, agentId: string) => Promise<void>;
  depth: number;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  const { item, unread } = node;
  const action = topicPrimaryAction(item);
  const session = topicPrimarySession(item);
  const resumeDisabledReason = sessionAttachDisabledReason(session);
  const resumesDerivedSession = Boolean(
    item.source === 'derived' &&
    action.label === 'resume' &&
    session &&
    !resumeDisabledReason
  );
  const rowStyle = { '--topic-depth': depth } as CSSProperties;
  return (
    <div className="topic-mobile-row-shell">
      <button
        type="button"
        className={`topic-mobile-row topic-mobile-row--${item.tone}${selected ? ' selected' : ''}`}
        style={rowStyle}
        data-topic-id={item.id}
        data-unread={unread ? 'true' : 'false'}
        onClick={() => onSelect(item.id)}
        title={
          resumesDerivedSession && session
            ? `resume chat ${session.label}`
            : action.label === 'resume'
              ? 'open channel timeline'
              : (resumeDisabledReason ?? action.detail)
        }
        aria-current={selected ? 'page' : undefined}
      >
        <CockpitPresenceChip
          item={item}
          statuses={statusByChannelAgent}
          unread={unread}
        />
        <span className="topic-mobile-row__main">
          <span className="topic-mobile-row__title">{item.title}</span>
          <span className="topic-mobile-row__status">
            {topicLatestStatus(item)}
          </span>
        </span>
        <span className="topic-mobile-row__cta">
          {resumesDerivedSession
            ? 'resume'
            : action.label === 'resume'
              ? 'open'
              : action.label}
        </span>
        <span className="topic-mobile-row__trail">
          {unread ? (
            <span
              className="topic-row__activity-dot"
              aria-label="unread activity"
              title="unread activity"
            />
          ) : null}
          <StatusGlyph tone={item.tone} />
        </span>
      </button>
      <MobileCockpitRowActions
        item={item}
        statuses={statusByChannelAgent}
        onNudge={onNudge}
        onInterrupt={onInterrupt}
      />
    </div>
  );
}

function TopicMobileControlPanel({
  item,
  showDiagnostics,
  onSelectSession,
  onSendInput,
}: {
  item: TopicNavItem;
  showDiagnostics: boolean;
  onSelectSession?: ((id: string) => void) | undefined;
  onSendInput: TopicSendInput;
}) {
  const session = topicPrimarySession(item);
  const action = topicPrimaryAction(item);
  const [inputValue, setInputValue] = useState('');
  const [pendingValue, setPendingValue] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const needsInput = action.label === 'approve' || action.label === 'reply';
  const canSend = Boolean(session && needsInput && !action.disabledReason);
  const resumeDisabledReason = sessionAttachDisabledReason(session);
  const canResume = Boolean(session && !resumeDisabledReason);
  const topSurface = item.surfaces[0];
  const approvalPresets =
    action.label === 'approve'
      ? [
          { label: 'approve', value: 'y' },
          { label: 'deny', value: 'n' },
        ]
      : [];

  useEffect(() => {
    setInputValue('');
    setPendingValue(null);
    setStatus(null);
  }, [action.label, item.id, session?.id, session?.selectKey]);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const value = String(formData.get('controlInput') ?? inputValue).trimEnd();
    if (!session || !canSend || !value || sending) return;
    if (value !== inputValue) setInputValue(value);
    if (pendingValue !== value) {
      setPendingValue(value);
      setStatus(
        showDiagnostics
          ? 'preview ready · tap send again to record the intervention'
          : 'review before sending'
      );
      return;
    }
    setSending(true);
    setStatus(
      showDiagnostics ? 'sending audited control input...' : 'sending…'
    );
    try {
      await onSendInput(session.id, `${value}\r`, session.nodeId ?? undefined);
      setInputValue('');
      setPendingValue(null);
      setStatus(
        showDiagnostics
          ? 'sent · audit/intervention trail preserved by session control'
          : 'sent'
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatus(`failed: ${message}`);
    } finally {
      setSending(false);
    }
  };

  const handleResume = () => {
    if (session) onSelectSession?.(session.selectKey);
  };

  const handleSurface = () => {
    if (!topSurface?.target) return;
    if (
      topSurface.openMode === 'direct' &&
      topSurface.target.startsWith('http')
    ) {
      window.open(topSurface.target, '_blank', 'noopener,noreferrer');
      return;
    }
    const clipboard = navigator.clipboard;
    setStatus(`surface target ready to copy: ${topSurface.target}`);
    if (clipboard?.writeText) {
      void clipboard.writeText(topSurface.target).then(
        () => setStatus('surface target copied for safe mobile handoff'),
        (error: unknown) => {
          const message =
            error instanceof Error ? error.message : String(error);
          setStatus(
            `surface copy unavailable: ${message}; target ${topSurface.target}`
          );
        }
      );
    }
  };

  return (
    <section
      className="topic-mobile-detail"
      aria-label={`${item.title} mobile controls`}
    >
      <div className="topic-mobile-detail__header">
        <div>
          <div className="topic-mobile-detail__eyebrow">{item.statusLabel}</div>
          <h3>{item.title}</h3>
        </div>
        <TopicBadge item={item} />
      </div>
      {showDiagnostics ? (
        <>
          <p className="topic-mobile-detail__latest">
            {topicLatestStatus(item)}
          </p>
          <div className="topic-mobile-detail__meta">
            <span>{item.kindLabel}</span>
            {item.routingLabel ? <span>{item.routingLabel}</span> : null}
            {session ? (
              <span>
                {session.agent} · {session.type}
              </span>
            ) : null}
            {session?.nodeLabel ? <span>{session.nodeLabel}</span> : null}
          </div>
          {item.description ? (
            <p className="topic-mobile-detail__description">
              {item.description}
            </p>
          ) : null}
        </>
      ) : null}

      <form className="topic-mobile-control" onSubmit={handleSubmit}>
        <label htmlFor={`topic-mobile-input-${item.id}`}>{action.label}</label>
        <input
          id={`topic-mobile-input-${item.id}`}
          name="controlInput"
          value={inputValue}
          onChange={(event) => {
            setInputValue(event.target.value);
            setPendingValue(null);
          }}
          disabled={!canSend || sending}
          placeholder={
            action.label === 'approve'
              ? 'approval reply, e.g. y / n / exact text'
              : action.label === 'reply'
                ? 'short reply to waiting agent'
                : action.detail
          }
          maxLength={1000}
        />
        {approvalPresets.length > 0 ? (
          <div
            className="topic-mobile-control__presets"
            aria-label="approval reply presets"
          >
            {approvalPresets.map((preset) => (
              <button
                key={preset.label}
                type="button"
                className="topic-mobile-control__preset"
                disabled={!canSend || sending}
                onClick={() => {
                  setInputValue(preset.value);
                  setPendingValue(null);
                  setStatus(
                    `${preset.label} selected · preview before sending`
                  );
                }}
              >
                {preset.label}
              </button>
            ))}
          </div>
        ) : null}
        <button
          type="submit"
          className="topic-mobile-control__primary"
          disabled={!canSend || inputValue.trim().length === 0 || sending}
          title={
            showDiagnostics
              ? (action.disabledReason ?? action.detail)
              : `review and send ${action.label}`
          }
        >
          {pendingValue === inputValue.trimEnd() && pendingValue
            ? `send ${action.label}`
            : `preview ${action.label}`}
        </button>
      </form>

      {pendingValue ? (
        <div className="topic-mobile-confirm" role="status">
          <span>confirmation preview</span>
          <code>{pendingValue}</code>
          <span>
            {session?.label} ·{' '}
            {showDiagnostics
              ? 'carriage return appended'
              : 'review before sending'}
          </span>
        </div>
      ) : null}

      {showDiagnostics ? (
        <>
          <div
            className="topic-mobile-actions"
            aria-label="topic quick actions"
          >
            <button
              type="button"
              disabled={!canResume}
              onClick={handleResume}
              title={
                resumeDisabledReason ??
                'open the linked Relay tab for this topic'
              }
            >
              resume topic
            </button>
            <button
              type="button"
              disabled={!canResume}
              onClick={handleResume}
              title={
                resumeDisabledReason ??
                'same linked Relay tab as resume; raw PTY is the fallback once open'
              }
            >
              open terminal tab
            </button>
            <button
              type="button"
              disabled={!topSurface?.target}
              onClick={handleSurface}
            >
              {topSurface ? `${topSurface.kind} artifact` : 'artifact'}
            </button>
          </div>
          {action.disabledReason ? (
            <p className="topic-mobile-disabled">
              controls disabled: {action.disabledReason}
            </p>
          ) : null}
        </>
      ) : null}
      {status ? (
        <p className="topic-mobile-status" role="status">
          {status}
        </p>
      ) : null}
    </section>
  );
}

function TopicMobileControlPanelGate({
  item,
  showDiagnostics,
  onSelectSession,
  onSendInput,
}: {
  item: TopicNavItem | undefined;
  showDiagnostics: boolean;
  onSelectSession?: ((id: string) => void) | undefined;
  onSendInput: TopicSendInput;
}) {
  if (!item || !shouldShowMobileControlPanel(item)) return null;
  return (
    <TopicMobileControlPanel
      item={item}
      showDiagnostics={showDiagnostics}
      onSelectSession={onSelectSession}
      onSendInput={onSendInput}
    />
  );
}

function TopicAdvancedDetailGate({
  item,
  show,
  workspaceNameById,
  surfacesError,
  surfacesLoading,
  onSelectSession,
  onRestoreTopic,
  restoringTopicId,
  onOpenEvidenceDashboard,
}: {
  item: TopicNavItem | undefined;
  show: boolean;
  workspaceNameById: Map<string, string>;
  surfacesError: boolean;
  surfacesLoading: boolean;
  onSelectSession?: ((id: string) => void) | undefined;
  onRestoreTopic?: ((topicId: string) => void) | undefined;
  restoringTopicId?: string | undefined;
  onOpenEvidenceDashboard?: (() => void) | undefined;
}) {
  const workContextId = item?.workContextIds[0] ?? null;
  const workflowRunsQuery = useQuery({
    queryKey: ['workflow-runs', workContextId, WORKFLOW_RUNS_LIMIT],
    queryFn: () => {
      if (!workContextId) return Promise.resolve(EMPTY_WORKFLOW_RUNS);
      return fetchWorkflowRuns({
        workContextId,
        limit: WORKFLOW_RUNS_LIMIT,
      });
    },
    enabled: Boolean(item && show && workContextId),
    staleTime: 10_000,
  });
  if (!item || !show) return null;
  return (
    <div className="topic-shell__advanced-detail">
      <TopicDetail
        item={item}
        workspaceName={resolveWorkspaceName(item, workspaceNameById)}
        surfacesError={surfacesError}
        surfacesLoading={surfacesLoading}
        workflowRuns={workflowRunsQuery.data ?? EMPTY_WORKFLOW_RUNS}
        workflowRunsError={workflowRunsQuery.isError}
        workflowRunsLoading={
          workflowRunsQuery.isLoading || workflowRunsQuery.isFetching
        }
        onSelectSession={onSelectSession}
        onRestoreTopic={onRestoreTopic}
        restoringTopicId={restoringTopicId}
        onOpenEvidenceDashboard={onOpenEvidenceDashboard}
      />
    </div>
  );
}

function TopicRow({
  node,
  depth,
  expandedIds,
  selectedId,
  onToggle,
  onSelect,
  onSelectSession,
}: {
  node: ChannelRailNode;
  depth: number;
  expandedIds: Set<string>;
  selectedId: string | null;
  onToggle: (id: string) => void;
  onSelect: (id: string) => void;
  onSelectSession?: ((id: string) => void) | undefined;
}) {
  const { item, unread, children } = node;
  const hasNested = children.length > 0 || item.participants.length > 0;
  const expanded = expandedIds.has(item.id);
  const selected = selectedId === item.id;

  const activate = () => {
    onSelect(item.id);
    if (hasNested) onToggle(item.id);
  };

  const rowStyle = { '--topic-depth': depth } as CSSProperties;
  const rowClassName = [
    'topic-row',
    `topic-row--${item.tone}`,
    selected && 'selected',
    item.muted && 'muted',
    item.lifecycleLabel === 'archived' && 'archived',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <li
      className={['topic-node', expanded && hasNested && 'expanded']
        .filter(Boolean)
        .join(' ')}
      style={rowStyle}
      data-topic-id={item.id}
      data-unread={unread ? 'true' : 'false'}
    >
      <div className={rowClassName}>
        <button
          type="button"
          className="topic-row__main"
          aria-expanded={hasNested ? expanded : undefined}
          aria-current={selected ? 'page' : undefined}
          onClick={activate}
          onKeyDown={(event) => {
            if (event.key === 'ArrowRight' && hasNested && !expanded) {
              event.preventDefault();
              onToggle(item.id);
            } else if (event.key === 'ArrowLeft' && hasNested && expanded) {
              event.preventDefault();
              onToggle(item.id);
            }
          }}
        >
          <TopicBadge item={item} />
          <span className="topic-row__title">
            <MarqueeText>{item.title}</MarqueeText>
          </span>
        </button>
        <span className="topic-row__trail" aria-label={item.statusLabel}>
          {unread ? (
            <span
              className="topic-row__activity-dot"
              aria-label="unread activity"
              title="unread activity"
            />
          ) : null}
          <StatusGlyph tone={item.tone} />
        </span>
      </div>
      {expanded ? (
        <>
          {item.participants.length > 0 ? (
            <ul className="topic-child-list">
              {item.participants.map((participant) => (
                <ParticipantChildRow
                  key={participant.id}
                  participant={participant}
                  onSelectSession={onSelectSession}
                />
              ))}
            </ul>
          ) : null}
          {children.length > 0 ? (
            <ul className="topic-child-list topic-child-list--topics">
              {children.map((child) => (
                <TopicRow
                  key={child.item.id}
                  node={child}
                  depth={depth + 1}
                  expandedIds={expandedIds}
                  selectedId={selectedId}
                  onToggle={onToggle}
                  onSelect={onSelect}
                  onSelectSession={onSelectSession}
                />
              ))}
            </ul>
          ) : null}
        </>
      ) : null}
    </li>
  );
}

function searchMatchSummary(result: WorkspaceTopicSearchResult): string {
  const primary = result.matches[0];
  if (!primary) return 'matched chat metadata';
  return `${primary.label}: ${primary.value}`;
}

function TopicSearchResults({
  results,
  truncated,
  onSelectSession,
}: {
  results: WorkspaceTopicSearchResult[];
  truncated: boolean;
  onSelectSession?: ((id: string) => void) | undefined;
}) {
  if (results.length === 0 && !truncated) return null;
  return (
    <div
      className="topic-search-results"
      aria-label="chat search result details"
    >
      {results.map((result) => {
        const disabledReason = result.action.disabledReason;
        const primarySessionId = result.action.primarySessionId;
        const actionDisabled = Boolean(disabledReason) || !primarySessionId;
        const actionTitle =
          disabledReason ?? (primarySessionId ? 'open chat' : 'no linked chat');
        return (
          <div
            key={result.topic.id}
            className={`topic-search-result topic-search-result--${result.freshness}`}
          >
            <div className="topic-search-result__main">
              <span className="topic-search-result__title">
                {result.topic.display.title}
              </span>
              <span className="topic-search-result__meta">
                {searchMatchSummary(result)}
              </span>
            </div>
            <span className="topic-search-result__freshness">
              {result.freshness}
            </span>
            <button
              type="button"
              className="topic-action topic-search-result__action"
              disabled={actionDisabled}
              title={actionTitle}
              onClick={() => {
                if (primarySessionId && !actionDisabled) {
                  onSelectSession?.(primarySessionId);
                }
              }}
            >
              open
            </button>
            {disabledReason ? (
              <span className="topic-search-result__disabled">
                {disabledReason}
              </span>
            ) : null}
          </div>
        );
      })}
      {truncated ? (
        <div className="topic-search-result__truncated">
          results truncated; refine search
        </div>
      ) : null}
    </div>
  );
}

function topicEmptyStateText(input: {
  searchActive: boolean;
  searchUnavailableReason?: string | undefined;
  searchQuery: string;
}): string {
  if (!input.searchActive) return 'no chats yet';
  if (input.searchUnavailableReason === 'empty_query') {
    return 'type to search chat history';
  }
  return `no chat matches for “${input.searchQuery.trim()}”`;
}

function MobileRailRows({
  nodes,
  statusByChannelAgent,
  onNudge,
  onInterrupt,
  selectedId,
  onSelect,
  depth = 0,
}: {
  nodes: ChannelRailNode[];
  statusByChannelAgent: Readonly<Record<string, ChannelAgentStatus>>;
  onNudge: (
    channelId: string,
    text: string,
    clientMessageId: string
  ) => Promise<void>;
  onInterrupt: (channelId: string, agentId: string) => Promise<void>;
  selectedId: string | null;
  onSelect: (id: string) => void;
  depth?: number;
}) {
  return nodes.map((node) => (
    <div className="topic-mobile-node" key={node.item.id}>
      <TopicMobileAttentionRow
        node={node}
        statusByChannelAgent={statusByChannelAgent}
        onNudge={onNudge}
        onInterrupt={onInterrupt}
        depth={depth}
        selected={selectedId === node.item.id}
        onSelect={onSelect}
      />
      {node.children.length > 0 ? (
        <MobileRailRows
          nodes={node.children}
          statusByChannelAgent={statusByChannelAgent}
          onNudge={onNudge}
          onInterrupt={onInterrupt}
          selectedId={selectedId}
          onSelect={onSelect}
          depth={depth + 1}
        />
      ) : null}
    </div>
  ));
}

function MobileRailSection({
  section,
  statusByChannelAgent,
  onNudge,
  onInterrupt,
  selectedId,
  onSelect,
}: {
  section: ChannelRailSection;
  statusByChannelAgent: Readonly<Record<string, ChannelAgentStatus>>;
  onNudge: (
    channelId: string,
    text: string,
    clientMessageId: string
  ) => Promise<void>;
  onInterrupt: (channelId: string, agentId: string) => Promise<void>;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <>
      <div data-rail-section="channels">
        <MobileRailRows
          nodes={section.channels}
          statusByChannelAgent={statusByChannelAgent}
          onNudge={onNudge}
          onInterrupt={onInterrupt}
          selectedId={selectedId}
          onSelect={onSelect}
        />
      </div>
      {section.directMessages.length > 0 ? (
        <>
          <div className="topic-mobile-group__dm-header">direct messages</div>
          <div data-rail-section="direct-messages">
            <MobileRailRows
              nodes={section.directMessages}
              statusByChannelAgent={statusByChannelAgent}
              onNudge={onNudge}
              onInterrupt={onInterrupt}
              selectedId={selectedId}
              onSelect={onSelect}
            />
          </div>
        </>
      ) : null}
    </>
  );
}

function TopicMobileCockpit({
  tree,
  unreadByChannel,
  statusByChannelAgent,
  mentionsMeByChannel,
  rosterAttentionBySessionKey,
  selectedId,
  onSelect,
  onNudge,
  onInterrupt,
  onCreateTaskRoom,
  onResumeLast,
}: {
  tree: ChannelRailTree;
  unreadByChannel: Readonly<Record<string, boolean>>;
  statusByChannelAgent: Readonly<Record<string, ChannelAgentStatus>>;
  mentionsMeByChannel: Readonly<Record<string, boolean>>;
  rosterAttentionBySessionKey: Readonly<Record<string, RosterAttention>>;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onNudge: (
    channelId: string,
    text: string,
    clientMessageId: string
  ) => Promise<void>;
  onInterrupt: (channelId: string, agentId: string) => Promise<void>;
  onCreateTaskRoom?: (() => void) | undefined;
  onResumeLast?: (() => void) | undefined;
}) {
  const [collapsedGroupIds, setCollapsedGroupIds] = useState<Set<string>>(
    () => new Set()
  );
  const toggleGroup = useCallback((id: string) => {
    setCollapsedGroupIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  const hasOrphans =
    tree.orphans.channels.length > 0 || tree.orphans.directMessages.length > 0;
  return (
    <section className="topic-mobile-cockpit" aria-label="mobile chat switcher">
      <div
        className="topic-mobile-cockpit__bar"
        aria-label="mobile chat actions"
      >
        <span className="topic-mobile-cockpit__hint">search chat history</span>
        <div className="topic-mobile-cockpit__actions">
          <button
            type="button"
            className="topic-mobile-cockpit__resume"
            disabled={!onResumeLast}
            title={
              onResumeLast
                ? 'resume your most recent session'
                : 'no recent session to resume'
            }
            onClick={onResumeLast}
          >
            resume last
          </button>
          <button
            type="button"
            disabled={!onCreateTaskRoom}
            title={
              onCreateTaskRoom
                ? 'start a new chat in the main pane'
                : 'chat creation unavailable'
            }
            onClick={onCreateTaskRoom}
          >
            new
          </button>
        </div>
      </div>
      <MobileCockpitAttentionLane
        tree={tree}
        unreadByChannel={unreadByChannel}
        statusByChannelAgent={statusByChannelAgent}
        mentionsMeByChannel={mentionsMeByChannel}
        rosterAttentionBySessionKey={rosterAttentionBySessionKey}
        onSelect={onSelect}
        actionLabelForItem={(item) => topicPrimaryAction(item).label}
        statusTextForItem={topicLatestStatus}
        onNudge={onNudge}
        onInterrupt={onInterrupt}
      />
      <div className="topic-cockpit__all-chats-header">all chats</div>
      <div className="topic-mobile-list" aria-label="workspace-grouped chats">
        {tree.groups.map((group) => {
          const expanded = !collapsedGroupIds.has(group.id);
          return (
            <section
              key={group.id}
              className="topic-mobile-group"
              aria-label={group.title}
              data-workspace-id={group.id}
            >
              <button
                type="button"
                className="topic-mobile-group__header"
                aria-expanded={expanded}
                onClick={() => toggleGroup(group.id)}
              >
                {group.icon ? (
                  <span className="topic-mobile-group__icon" aria-hidden="true">
                    {group.icon}
                  </span>
                ) : null}
                <span className="topic-mobile-group__name">{group.title}</span>
                {!expanded && group.unread ? (
                  <span
                    className="topic-row__activity-dot"
                    aria-label="unread activity"
                    title="unread activity"
                  />
                ) : null}
                <span className="topic-mobile-group__toggle" aria-hidden="true">
                  {expanded ? '−' : '+'}
                </span>
              </button>
              {expanded ? (
                <MobileRailSection
                  section={group}
                  statusByChannelAgent={statusByChannelAgent}
                  onNudge={onNudge}
                  onInterrupt={onInterrupt}
                  selectedId={selectedId}
                  onSelect={onSelect}
                />
              ) : null}
            </section>
          );
        })}
        {hasOrphans ? (
          <section
            className="topic-mobile-group topic-mobile-group--orphan"
            aria-label="no workspace"
            data-workspace-id="orphan"
          >
            {tree.groups.length > 0 ? (
              <div className="topic-mobile-group__header topic-mobile-group__header--static">
                <span className="topic-mobile-group__name">no workspace</span>
              </div>
            ) : null}
            <MobileRailSection
              section={tree.orphans}
              statusByChannelAgent={statusByChannelAgent}
              onNudge={onNudge}
              onInterrupt={onInterrupt}
              selectedId={selectedId}
              onSelect={onSelect}
            />
          </section>
        ) : null}
      </div>
    </section>
  );
}

function TopicSearchPanel({
  model,
  searchQuery,
  searchLoading,
  searchError,
  searchResults,
  searchTruncated,
  searchUnavailableReason,
  onSearchQueryChange,
  onSearchRetry,
  onSearchClear,
  onSelectSession,
  searchScope = 'all',
  onToggleSearchScope,
  canScope = false,
}: {
  model: TopicNavModel;
  searchQuery: string;
  searchLoading: boolean;
  searchError: boolean;
  searchResults: WorkspaceTopicSearchResult[];
  searchTruncated: boolean;
  searchUnavailableReason?: string | undefined;
  onSearchQueryChange?: ((query: string) => void) | undefined;
  onSearchRetry?: (() => void) | undefined;
  onSearchClear?: (() => void) | undefined;
  onSelectSession?: ((id: string) => void) | undefined;
  searchScope?: 'all' | 'workspace';
  onToggleSearchScope?: (() => void) | undefined;
  canScope?: boolean;
}) {
  const searchActive = searchQuery.trim().length > 0;
  return (
    <>
      <label className="topic-search" aria-label="search chat history">
        <span className="topic-search__prompt">/</span>
        <input
          className="topic-search__input"
          value={searchQuery}
          onChange={(event) => onSearchQueryChange?.(event.target.value)}
          placeholder="search chats..."
          spellCheck={false}
        />
        {canScope ? (
          <button
            type="button"
            className={`topic-search__scope${searchScope === 'workspace' ? ' is-active' : ''}`}
            aria-pressed={searchScope === 'workspace'}
            title={
              searchScope === 'workspace'
                ? 'searching this workspace'
                : 'searching all workspaces'
            }
            onClick={onToggleSearchScope}
          >
            {searchScope === 'workspace' ? 'this workspace' : 'all'}
          </button>
        ) : null}
        {searchLoading ? <span className="topic-search__state">…</span> : null}
      </label>
      {searchError ? (
        <div className="topic-shell-state topic-search-state error">
          <span>chat search unavailable</span>
          <span className="topic-search-state__actions">
            {onSearchRetry ? (
              <button type="button" onClick={onSearchRetry}>
                retry
              </button>
            ) : null}
            {onSearchClear ? (
              <button type="button" onClick={onSearchClear}>
                clear
              </button>
            ) : null}
          </span>
        </div>
      ) : null}
      {searchLoading && model.items.length === 0 ? (
        <div className="topic-shell-state topic-search-state">
          searching chat history…
        </div>
      ) : null}
      {model.items.length === 0 && !searchLoading && !searchError ? (
        <div className="topic-shell-state">
          {topicEmptyStateText({
            searchActive,
            searchUnavailableReason,
            searchQuery,
          })}
        </div>
      ) : null}
      {searchActive ? (
        <TopicSearchResults
          results={searchResults}
          truncated={searchTruncated}
          onSelectSession={onSelectSession}
        />
      ) : null}
    </>
  );
}

const EMPTY_TOPICS: WorkspaceTopic[] = [];
const EMPTY_SURFACES: WorkspaceSurface[] = [];
const EMPTY_SEARCH_RESULTS: WorkspaceTopicSearchResult[] = [];
const EMPTY_WORKSPACES: TopicNavWorkspace[] = [];

/** Show/hide older chats toggle; renders nothing without a handler. */
function ArchivedToggle({
  showArchived,
  onToggle,
}: {
  showArchived: boolean;
  onToggle?: (() => void) | undefined;
}) {
  if (!onToggle) return null;
  return (
    <div className="topic-archived-toggle">
      <button
        type="button"
        className={`topic-archived-toggle__btn${showArchived ? ' is-active' : ''}`}
        aria-pressed={showArchived}
        onClick={onToggle}
      >
        {showArchived ? 'hide older chats' : 'show older chats'}
      </button>
    </div>
  );
}

/** Regular channels then, if any, a `direct messages` sub-section (#1166). */
function ChannelsAndDmsLists({
  section,
  renderRow,
}: {
  section: ChannelRailSection;
  renderRow: (node: ChannelRailNode) => ReactNode;
}) {
  return (
    <>
      <ul className="topic-tree__list" data-rail-section="channels">
        {section.channels.map(renderRow)}
      </ul>
      {section.directMessages.length > 0 ? (
        <>
          <div className="topic-workspace-group__dm-header">
            direct messages
          </div>
          <ul
            className="topic-tree__list topic-tree__list--dm"
            data-rail-section="direct-messages"
          >
            {section.directMessages.map(renderRow)}
          </ul>
        </>
      ) : null}
    </>
  );
}

function GroupedTopicTree({
  tree,
  renderRow,
}: {
  tree: ChannelRailTree;
  renderRow: (node: ChannelRailNode) => ReactNode;
}) {
  return (
    <div className="topic-tree" aria-label="workspace chats">
      {tree.groups.map((group) => (
        <section
          key={group.id}
          className="topic-workspace-group"
          aria-label={group.title}
          data-workspace-id={group.id}
        >
          <div className="topic-workspace-group__header">
            {group.icon ? (
              <span className="topic-workspace-group__icon" aria-hidden="true">
                {group.icon}
              </span>
            ) : null}
            <span className="topic-workspace-group__name">{group.title}</span>
          </div>
          <ChannelsAndDmsLists section={group} renderRow={renderRow} />
        </section>
      ))}
      {tree.orphans.channels.length > 0 ||
      tree.orphans.directMessages.length > 0 ? (
        <section
          className="topic-workspace-group topic-workspace-group--orphan"
          aria-label="no workspace"
          data-workspace-id="orphan"
        >
          {tree.groups.length > 0 ? (
            <div className="topic-workspace-group__header">
              <span className="topic-workspace-group__name">no workspace</span>
            </div>
          ) : null}
          <ChannelsAndDmsLists section={tree.orphans} renderRow={renderRow} />
        </section>
      ) : null}
    </div>
  );
}

function applyTopicActiveContext(topic: WorkspaceTopic | undefined): void {
  if (!topic) return;
  const context = resolveTopicActiveContext(topic);
  const ui = useUiStore.getState();
  ui.setActiveWorkspaceId(context.workspaceId);
  if (context.repoPath) ui.setActiveRepoPath(context.repoPath);
}

function TopicShellHeader({
  derived,
  onCreateTaskRoom,
  searchQuery,
}: {
  derived: boolean;
  onCreateTaskRoom?: (() => void) | undefined;
  searchQuery: string;
}) {
  const badge = searchQuery.trim() ? 'search' : derived ? 'derived' : null;
  return (
    <div className="topic-shell__header">
      <span>chats</span>
      {onCreateTaskRoom ? (
        <button
          className="topic-shell__create"
          type="button"
          onClick={onCreateTaskRoom}
        >
          new chat
        </button>
      ) : null}
      {badge ? <span className="topic-shell__derived">{badge}</span> : null}
    </div>
  );
}

export function TopicSidebarView({
  topics,
  sessions,
  surfaces,
  loading = false,
  error = false,
  derived = false,
  surfacesLoading = false,
  searchQuery = '',
  searchLoading = false,
  searchError = false,
  searchResults = [],
  searchTruncated = false,
  searchUnavailableReason,
  surfacesError = false,
  onSearchQueryChange,
  onSearchRetry,
  onSearchClear,
  onSelectSession,
  onSendInput = sendSessionInput,
  onCreateTaskRoom,
  workspaces = EMPTY_WORKSPACES,
  nodes,
  activeWorkspaceId = null,
  searchScope = 'all',
  onToggleSearchScope,
  showArchived = false,
  onToggleArchived,
  onRestoreTopic,
  restoringTopicId,
  showAdvancedDetail = false,
}: {
  topics: WorkspaceTopic[];
  sessions: SessionSummary[];
  surfaces: WorkspaceSurface[];
  workspaces?: TopicNavWorkspace[];
  /** Known node roster; resolves raw routing node ids to friendly names. */
  nodes?: TopicNavNode[];
  activeWorkspaceId?: string | null;
  searchScope?: 'all' | 'workspace';
  onToggleSearchScope?: (() => void) | undefined;
  showArchived?: boolean;
  onToggleArchived?: (() => void) | undefined;
  onRestoreTopic?: ((topicId: string) => void) | undefined;
  restoringTopicId?: string | undefined;
  loading?: boolean;
  error?: boolean;
  derived?: boolean;
  surfacesLoading?: boolean;
  searchQuery?: string;
  searchLoading?: boolean;
  searchError?: boolean;
  searchResults?: WorkspaceTopicSearchResult[];
  searchTruncated?: boolean;
  searchUnavailableReason?: string | undefined;
  surfacesError?: boolean;
  onSearchQueryChange?: ((query: string) => void) | undefined;
  onSearchRetry?: (() => void) | undefined;
  onSearchClear?: (() => void) | undefined;
  onSelectSession?: ((id: string) => void) | undefined;
  onSendInput?: TopicSendInput | undefined;
  onCreateTaskRoom?: (() => void) | undefined;
  showAdvancedDetail?: boolean | undefined;
}) {
  const model = useMemo(
    () => buildTopicNavModel({ topics, sessions, surfaces, derived, nodes }),
    [topics, sessions, surfaces, derived, nodes]
  );
  const topicsById = useMemo(
    () => new Map(topics.map((topic) => [topic.id, topic])),
    [topics]
  );
  const activeChannelId = useUiStore((s) => s.activeChannelId);
  const advancedMode = useUiStore((s) => s.advancedMode);
  const sidebarOpen = useUiStore((s) => s.sidebarOpen);
  const mobileCockpitViewport = useMobileCockpitViewport();
  const activityIds = useMemo(
    () => model.items.map((item) => item.id),
    [model.items]
  );
  const relevantActivity = useChannelActivityStore(
    useShallow((state) =>
      activityIds.flatMap((id) => [
        state.latestSeqByChannel[id],
        state.lastReadByChannel[id],
      ])
    )
  );
  const statusByChannelAgent = useChannelAgentStatusStore(
    (state) => state.statusByChannelAgent
  );
  const statusUpdatedAtByChannelAgent = useChannelAgentStatusStore(
    (state) => state.updatedAtByChannelAgent
  );
  const workspaceNameById = useMemo(
    () =>
      new Map(workspaces.map((workspace) => [workspace.id, workspace.name])),
    [workspaces]
  );
  // Resolve unread once (including the persisted last-read fallback) and feed
  // the same pure rail projection to desktop and mobile.
  const unreadByChannel = useMemo(
    () =>
      Object.fromEntries(
        model.items.map((item, index) => [
          item.id,
          relevantActivity[index * 2] !== undefined &&
            hasUnseenActivity(item.id, activeChannelId),
        ])
      ),
    [activeChannelId, model.items, relevantActivity]
  );
  const latestSeqByChannel = useMemo(
    () =>
      Object.fromEntries(
        activityIds.flatMap((id, index) => {
          const latestSeq = relevantActivity[index * 2];
          return typeof latestSeq === 'number' ? [[id, latestSeq]] : [];
        })
      ),
    [activityIds, relevantActivity]
  );
  // The channel roster endpoint is per-channel, so reconcile only while the
  // mobile cockpit is actually open. High-signal rows lead rolling batches;
  // every persisted channel is eventually covered without a request burst.
  // Query keys intentionally match ChannelView for cache reuse.
  const allRosterChannelIds = useMemo(() => {
    if (!mobileCockpitViewport || !sidebarOpen) return [];
    const rawPresencePriority = (item: TopicNavItem): number => {
      const prefix = `${item.id} `;
      const statuses = Object.entries(statusByChannelAgent).flatMap(
        ([key, status]) => (key.startsWith(prefix) ? [status] : [])
      );
      if (statuses.includes('waiting')) return 5;
      if (statuses.some((status) => status !== 'idle')) return 4;
      if (item.tone === 'attention' || item.tone === 'error') return 3;
      if (unreadByChannel[item.id]) return 2;
      if (item.pinned) return 1;
      return 0;
    };
    return model.items
      .filter((item) => item.source === 'persisted')
      .sort(
        (a, b) =>
          rawPresencePriority(b) - rawPresencePriority(a) ||
          b.attentionPriority - a.attentionPriority ||
          Number(b.pinned) - Number(a.pinned) ||
          b.updatedAt.localeCompare(a.updatedAt) ||
          a.id.localeCompare(b.id)
      )
      .map((item) => item.id);
  }, [
    mobileCockpitViewport,
    model.items,
    sidebarOpen,
    statusByChannelAgent,
    unreadByChannel,
  ]);
  const rosterBatchScope = JSON.stringify(allRosterChannelIds);
  const [rosterBatch, setRosterBatch] = useState({
    scope: '',
    end: MOBILE_COCKPIT_ROSTER_BATCH_SIZE,
  });
  const rosterBatchEnd =
    rosterBatch.scope === rosterBatchScope
      ? rosterBatch.end
      : MOBILE_COCKPIT_ROSTER_BATCH_SIZE;
  const rosterChannelIds = useMemo(
    () => allRosterChannelIds.slice(0, rosterBatchEnd),
    [allRosterChannelIds, rosterBatchEnd]
  );
  const rosterQueries = useQueries({
    queries: rosterChannelIds.map((channelId) => ({
      queryKey: ['channel-roster', channelId],
      queryFn: () => fetchChannelRoster(channelId),
      staleTime: 30_000,
      retry: false,
    })),
  });
  const activeRosterBatchEnd = rosterChannelIds.length;
  const currentRosterBatchStart = Math.max(
    0,
    activeRosterBatchEnd - MOBILE_COCKPIT_ROSTER_BATCH_SIZE
  );
  const currentRosterBatchSettled =
    activeRosterBatchEnd > 0 &&
    rosterQueries
      .slice(currentRosterBatchStart, activeRosterBatchEnd)
      .every((query) => !query.isPending && !query.isFetching);
  const latestUnreadTargets = useMemo(
    () =>
      rosterChannelIds.flatMap((channelId, index) => {
        const rosterQuery = rosterQueries[index];
        const latestSeq = latestSeqByChannel[channelId];
        return unreadByChannel[channelId] &&
          typeof latestSeq === 'number' &&
          rosterQuery &&
          !rosterQuery.isPending &&
          !rosterQuery.isFetching
          ? [{ channelId, latestSeq }]
          : [];
      }),
    [latestSeqByChannel, rosterChannelIds, rosterQueries, unreadByChannel]
  );
  const latestUnreadQueries = useQueries({
    queries: latestUnreadTargets.map(({ channelId, latestSeq }) => ({
      queryKey: ['channel-history', channelId, 'latest-unread', latestSeq],
      queryFn: () => fetchChannelHistory(channelId, { limit: 1 }),
      staleTime: Number.POSITIVE_INFINITY,
      gcTime: 60_000,
      retry: false,
    })),
  });
  const currentRosterBatchIds = rosterChannelIds.slice(
    currentRosterBatchStart,
    activeRosterBatchEnd
  );
  const latestUnreadQueryByChannel = new Map(
    latestUnreadTargets.map((target, index) => [
      target.channelId,
      latestUnreadQueries[index],
    ])
  );
  const currentMentionBatchSettled = currentRosterBatchIds.every(
    (channelId) => {
      if (!unreadByChannel[channelId]) return true;
      const query = latestUnreadQueryByChannel.get(channelId);
      return Boolean(query && !query.isPending && !query.isFetching);
    }
  );
  useEffect(() => {
    if (rosterBatch.scope !== rosterBatchScope) {
      setRosterBatch({
        scope: rosterBatchScope,
        end: MOBILE_COCKPIT_ROSTER_BATCH_SIZE,
      });
      return;
    }
    if (
      currentRosterBatchSettled &&
      currentMentionBatchSettled &&
      rosterBatch.end < allRosterChannelIds.length
    ) {
      setRosterBatch((current) => ({
        ...current,
        end: Math.min(
          allRosterChannelIds.length,
          current.end + MOBILE_COCKPIT_ROSTER_BATCH_SIZE
        ),
      }));
    }
  }, [
    allRosterChannelIds.length,
    currentMentionBatchSettled,
    currentRosterBatchSettled,
    rosterBatch.end,
    rosterBatch.scope,
    rosterBatchScope,
  ]);
  const mentionsMeByChannel = useMemo(() => {
    const mentioned: Record<string, boolean> = {};
    latestUnreadTargets.forEach((target, index) => {
      const message = latestUnreadQueries[index]?.data?.messages.at(-1);
      if (
        message &&
        message.seq === target.latestSeq &&
        messageMentionsCurrentOperator(message)
      ) {
        mentioned[target.channelId] = true;
      }
    });
    return mentioned;
  }, [latestUnreadQueries, latestUnreadTargets]);
  const effectiveStatusByChannelAgent = useMemo(() => {
    const effective: Record<string, ChannelAgentStatus> = {
      ...statusByChannelAgent,
    };
    rosterQueries.forEach((query, index) => {
      const channelId = rosterChannelIds[index];
      if (!channelId || !query.data) return;
      const rosterById = new Map(query.data.map((entry) => [entry.id, entry]));
      const candidateAgentIds = new Set(rosterById.keys());
      const prefix = `${channelId} `;
      for (const key of Object.keys(statusByChannelAgent)) {
        if (key.startsWith(prefix))
          candidateAgentIds.add(key.slice(prefix.length));
      }
      for (const agentId of candidateAgentIds) {
        const entry = rosterById.get(agentId);
        const key = channelAgentStatusKey(channelId, agentId);
        const status = resolveEffectiveAgentStatus({
          socketStatus: statusByChannelAgent[key],
          socketUpdatedAt: statusUpdatedAtByChannelAgent[key],
          rosterStatus: entry?.binding?.status,
          rosterUpdatedAt: query.dataUpdatedAt,
          streaming: false,
        });
        // A fresh unbound roster row supersedes a stale idle socket entry. A
        // newer active socket transition still wins through the resolver.
        if (entry?.binding == null && status === 'idle') delete effective[key];
        else effective[key] = status;
      }
    });
    return effective;
  }, [
    rosterChannelIds,
    rosterQueries,
    statusByChannelAgent,
    statusUpdatedAtByChannelAgent,
  ]);
  const mobileAgentRosterQuery = useQuery({
    queryKey: ['agent-roster', 'mobile-cockpit', 200],
    queryFn: () =>
      fetchAgentRoster({
        includeTerminals: false,
        needsAttention: true,
        limit: 200,
      }),
    enabled: mobileCockpitViewport && sidebarOpen,
    staleTime: 30_000,
    retry: false,
  });
  const rosterAttentionBySessionKey = useMemo(() => {
    const attentionBySessionKey: Record<string, RosterAttention> = {};
    for (const entry of mobileAgentRosterQuery.data?.entries ?? []) {
      attentionBySessionKey[entry.sessionId] = entry.attention;
      if (entry.globalSessionId) {
        attentionBySessionKey[entry.globalSessionId] = entry.attention;
      } else if (entry.nodeId) {
        attentionBySessionKey[
          createGlobalSessionId(entry.nodeId, entry.sessionId)
        ] = entry.attention;
      }
    }
    return attentionBySessionKey;
  }, [mobileAgentRosterQuery.data]);
  const railTree = useMemo(
    () => selectChannelRailTree(model, workspaces, { unreadByChannel }),
    [model, unreadByChannel, workspaces]
  );
  const firstId = model.rootIds[0] ?? model.items[0]?.id ?? null;
  const [selectedId, setSelectedId] = useState<string | null>(firstId);
  const [mobileControlTopicId, setMobileControlTopicId] = useState<
    string | null
  >(null);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(
    () => new Set(model.rootIds)
  );

  useEffect(() => {
    setSelectedId((current) =>
      current && model.byId.has(current) ? current : firstId
    );
    setExpandedIds((current) => {
      const next = new Set(current);
      for (const id of model.rootIds) next.add(id);
      return next;
    });
  }, [firstId, model.byId, model.rootIds]);

  const toggle = useCallback((id: string) => {
    setExpandedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // Selecting a topic establishes its node + cwd context so terminals, agents,
  // and the workspace pane operate in the topic's node/repo. Only fires on an
  // explicit user selection — the initial/auto-selection sets `selectedId`
  // directly and never clobbers the active repo.
  // #1166: for a persisted channel (anything backed by GET /channels), clicking
  // the row also opens it in the main pane (activeChannelId) and closes the
  // composer — "selected in sidebar" and "open in main pane" become one state
  // for channels. Derived (non-persisted) topics never route to a channel.
  const select = useCallback(
    (id: string) => {
      setSelectedId(id);
      setMobileControlTopicId(null);
      const topic = topicsById.get(id);
      applyTopicActiveContext(topic);
      if (topic?.source === 'persisted') {
        const ui = useUiStore.getState();
        ui.setActiveChannelId(id);
        ui.setTopicComposerOpen(false);
      }
    },
    [topicsById]
  );
  const selectMobile = useCallback(
    (id: string) => {
      select(id);
      const item = model.byId.get(id);
      const action = item ? topicPrimaryAction(item) : null;
      const actionable =
        action?.label === 'approve' || action?.label === 'reply';
      setMobileControlTopicId(actionable ? id : null);
      const session = item ? topicPrimarySession(item) : null;
      const resumesDerivedSession = Boolean(
        item?.source === 'derived' &&
        action?.label === 'resume' &&
        session &&
        !sessionAttachDisabledReason(session) &&
        onSelectSession
      );
      if (resumesDerivedSession && session) {
        onSelectSession?.(session.selectKey);
        useUiStore.getState().closeSidebar();
        return;
      }
      if (!actionable && topicsById.get(id)?.source === 'persisted') {
        useUiStore.getState().closeSidebar();
      }
    },
    [model.byId, onSelectSession, select, topicsById]
  );
  const postMobileNudge = useCallback(
    async (channelId: string, text: string, clientMessageId: string) => {
      await postChannelMessage(channelId, {
        text,
        format: 'text',
        clientMessageId,
      });
    },
    []
  );
  const interruptMobileAgent = useCallback(
    async (channelId: string, agentId: string) => {
      await interruptChannelAgent(channelId, agentId);
    },
    []
  );
  useEffect(() => {
    if (!mobileControlTopicId) return;
    if (selectedId !== mobileControlTopicId) {
      setMobileControlTopicId(null);
      return;
    }
    const item = model.byId.get(mobileControlTopicId);
    const action = item ? topicPrimaryAction(item) : null;
    if (action?.label !== 'approve' && action?.label !== 'reply') {
      setMobileControlTopicId(null);
    }
  }, [mobileControlTopicId, model.byId, selectedId]);
  const openCreateTaskRoom = useCallback(() => {
    applyTopicActiveContext(
      selectedId ? topicsById.get(selectedId) : undefined
    );
    onCreateTaskRoom?.();
  }, [onCreateTaskRoom, selectedId, topicsById]);
  const renderTopicRow = (node: ChannelRailNode): ReactNode => {
    const item = node.item;
    return (
      <TopicRow
        key={item.id}
        node={node}
        depth={0}
        expandedIds={expandedIds}
        selectedId={selectedId}
        onToggle={toggle}
        onSelect={select}
        onSelectSession={onSelectSession}
      />
    );
  };
  const selectedItem = selectedId ? model.byId.get(selectedId) : undefined;
  const selectedTopic = selectedId ? topicsById.get(selectedId) : undefined;
  const selectedRepoPath = selectedTopic
    ? resolveTopicActiveContext(selectedTopic).repoPath
    : null;
  const openEvidenceDashboard = useCallback(() => {
    if (!selectedTopic || !selectedRepoPath) return;
    const context = resolveTopicActiveContext(selectedTopic);
    const ui = useUiStore.getState();
    ui.requestRepoDashboardTab(selectedRepoPath, 'evidence');
    ui.setActiveWorkspaceId(context.workspaceId);
    ui.setActiveRepoPath(selectedRepoPath);
    ui.setActiveChannelId(null);
    ui.setTopicComposerOpen(false);
    ui.setAnalyticsView(null);
    ui.setForceOrgCockpit(false);
    useSessionsStore.getState().setActiveSessionId(null);
    ui.closeSidebar();
  }, [selectedRepoPath, selectedTopic]);
  // One-tap resume-last: the select key of the most recently active session
  // across every topic. Null when nothing resumable exists yet.
  const resumeLastSelectKey = useMemo(() => {
    let bestKey: string | null = null;
    let bestAt = '';
    for (const item of model.items) {
      for (const session of item.sessions) {
        if (session.lastActivity && session.lastActivity > bestAt) {
          bestAt = session.lastActivity;
          bestKey = session.selectKey;
        }
      }
    }
    return bestKey;
  }, [model.items]);
  const activeSearchLoading = Boolean(searchQuery.trim() && searchLoading);

  if (loading && !activeSearchLoading) {
    return <div className="topic-shell-state">loading chats…</div>;
  }
  if (error) {
    return <div className="topic-shell-state error">chat list unavailable</div>;
  }

  return (
    <div className="topic-shell" data-track="topic-shell">
      <TopicShellHeader
        derived={model.derived}
        searchQuery={searchQuery}
        {...(onCreateTaskRoom ? { onCreateTaskRoom: openCreateTaskRoom } : {})}
      />
      <TopicMobileCockpit
        tree={railTree}
        unreadByChannel={unreadByChannel}
        statusByChannelAgent={effectiveStatusByChannelAgent}
        mentionsMeByChannel={mentionsMeByChannel}
        rosterAttentionBySessionKey={rosterAttentionBySessionKey}
        selectedId={selectedId}
        onSelect={selectMobile}
        onNudge={postMobileNudge}
        onInterrupt={interruptMobileAgent}
        {...(onCreateTaskRoom ? { onCreateTaskRoom: openCreateTaskRoom } : {})}
        {...(resumeLastSelectKey && onSelectSession
          ? { onResumeLast: () => onSelectSession(resumeLastSelectKey) }
          : {})}
      />
      <TopicSearchPanel
        model={model}
        searchQuery={searchQuery}
        searchLoading={searchLoading}
        searchError={searchError}
        searchResults={searchResults}
        searchTruncated={searchTruncated}
        searchUnavailableReason={searchUnavailableReason}
        onSearchQueryChange={onSearchQueryChange}
        onSearchRetry={onSearchRetry}
        onSearchClear={onSearchClear}
        onSelectSession={onSelectSession}
        searchScope={searchScope}
        onToggleSearchScope={onToggleSearchScope}
        canScope={activeWorkspaceId != null}
      />
      <ArchivedToggle showArchived={showArchived} onToggle={onToggleArchived} />
      <GroupedTopicTree tree={railTree} renderRow={renderTopicRow} />
      <TopicAdvancedDetailGate
        item={selectedItem}
        show={advancedMode && showAdvancedDetail}
        workspaceNameById={workspaceNameById}
        surfacesError={surfacesError}
        surfacesLoading={surfacesLoading}
        onSelectSession={onSelectSession}
        onRestoreTopic={onRestoreTopic}
        restoringTopicId={restoringTopicId}
        {...(selectedRepoPath
          ? { onOpenEvidenceDashboard: openEvidenceDashboard }
          : {})}
      />
      {advancedMode || mobileControlTopicId === selectedItem?.id ? (
        <TopicMobileControlPanelGate
          item={selectedItem}
          showDiagnostics={advancedMode}
          onSelectSession={onSelectSession}
          onSendInput={onSendInput}
        />
      ) : null}
    </div>
  );
}

export function TopicSidebarShell({
  onSelectSession,
}: {
  onSelectSession?: ((id: string) => void) | undefined;
}) {
  const queryClient = useQueryClient();
  const sessions = useSessionsStore((s) => s.sessions);
  const activeWorkspaceId = useUiStore((s) => s.activeWorkspaceId);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchScope, setSearchScope] = useState<'all' | 'workspace'>('all');
  const scopedWorkspaceId =
    searchScope === 'workspace' ? activeWorkspaceId : null;
  const normalizedSearchQuery = searchQuery.trim();
  const [showArchived, setShowArchived] = useState(false);
  const topicsQuery = useQuery({
    // Keep the canonical key for the default (active) view so shared cache and
    // invalidations still hit; the archived view uses a distinct key.
    queryKey: showArchived
      ? ['workspace-topics', 'with-archived']
      : ['workspace-topics'],
    queryFn: () => fetchWorkspaceTopics({ includeArchived: showArchived }),
    staleTime: 30_000,
  });
  const restoreTopicMutation = useMutation({
    mutationFn: (topicId: string) => restoreWorkspaceTopic(topicId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['workspace-topics'] });
    },
    onError: (err: unknown) => {
      useToastStore
        .getState()
        .showToast(
          err instanceof Error ? err.message : 'failed to restore topic'
        );
    },
  });
  const workspacesQuery = useIaWorkspacesQuery();
  const viewWorkspaces = useMemo<TopicNavWorkspace[]>(
    () => workspacesQuery.data ?? EMPTY_WORKSPACES,
    [workspacesQuery.data]
  );
  const topicSearchQuery = useQuery({
    queryKey: [
      'workspace-topics',
      'search',
      normalizedSearchQuery,
      scopedWorkspaceId ?? 'all',
    ],
    queryFn: () =>
      searchWorkspaceTopics({
        q: normalizedSearchQuery,
        limit: 20,
        ...(scopedWorkspaceId ? { workspaceId: scopedWorkspaceId } : {}),
      }),
    enabled: normalizedSearchQuery.length > 0,
    staleTime: 10_000,
  });
  const surfacesQuery = useQuery<WorkspaceSurface[]>({
    queryKey: ['workspace-surfaces', 'topic-shell'],
    queryFn: () => fetchWorkspaceSurfaces(),
    staleTime: 30_000,
  });
  const nodesQuery = useQuery({
    queryKey: ['hub-nodes'],
    queryFn: fetchHubNodes,
    staleTime: 60_000,
  });
  const searchActive = normalizedSearchQuery.length > 0;
  const searchData = topicSearchQuery.data;
  const searchResults = useMemo(
    () => searchData?.results ?? EMPTY_SEARCH_RESULTS,
    [searchData]
  );
  // Keep the arrays passed to TopicSidebarView referentially stable so its
  // model/topicsById memoization is not invalidated on every render.
  const viewTopics = useMemo(
    () =>
      searchActive
        ? searchResults.map((result) => result.topic)
        : (topicsQuery.data?.topics ?? EMPTY_TOPICS),
    [searchActive, searchResults, topicsQuery.data]
  );
  const viewSurfaces = useMemo(
    () => surfacesQuery.data ?? EMPTY_SURFACES,
    [surfacesQuery.data]
  );
  const viewNodes = useMemo<TopicNavNode[]>(
    () =>
      (nodesQuery.data ?? []).map((node) => ({
        nodeId: node.nodeId,
        displayName: node.displayName,
      })),
    [nodesQuery.data]
  );
  return (
    <TopicSidebarView
      topics={viewTopics}
      sessions={sessions}
      surfaces={viewSurfaces}
      workspaces={viewWorkspaces}
      nodes={viewNodes}
      activeWorkspaceId={activeWorkspaceId}
      searchScope={searchScope}
      onToggleSearchScope={() =>
        setSearchScope((scope) => (scope === 'all' ? 'workspace' : 'all'))
      }
      showArchived={showArchived}
      onToggleArchived={() => setShowArchived((prev) => !prev)}
      onRestoreTopic={(topicId) => restoreTopicMutation.mutate(topicId)}
      restoringTopicId={
        restoreTopicMutation.isPending
          ? restoreTopicMutation.variables
          : undefined
      }
      loading={!searchActive && topicsQuery.isLoading && !topicsQuery.data}
      error={topicsQuery.isError && !topicsQuery.data && !searchActive}
      surfacesLoading={surfacesQuery.isLoading && !surfacesQuery.data}
      surfacesError={surfacesQuery.isError}
      derived={
        searchActive
          ? (searchData?.derived ?? false)
          : (topicsQuery.data?.derived ?? false)
      }
      searchQuery={searchQuery}
      searchLoading={topicSearchQuery.isFetching && searchActive}
      searchError={topicSearchQuery.isError && searchActive}
      searchResults={searchResults}
      searchTruncated={searchData?.truncated ?? false}
      searchUnavailableReason={searchData?.unavailableReason}
      onSearchQueryChange={setSearchQuery}
      onSearchRetry={() => void topicSearchQuery.refetch()}
      onSearchClear={() => setSearchQuery('')}
      onSelectSession={onSelectSession}
      onCreateTaskRoom={openTopicTaskRoom}
      showAdvancedDetail={!(surfacesQuery.isLoading && !surfacesQuery.data)}
    />
  );
}

export default TopicSidebarShell;
