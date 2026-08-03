import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { useShallow } from 'zustand/react/shallow';
import {
  CircleAlert,
  Folder,
  GitBranch,
  LoaderCircle,
  MessageSquare,
  TriangleAlert,
} from 'lucide-react';
import {
  builtInAgentProfileId,
  parseAgentProfileProviderId,
} from '../../../shared/agent-profile.js';
import {
  parseChannelSearchSnippet,
  parseMentions,
  type ChannelMessageId,
  type ChannelMessageSearchResult,
} from '../../../shared/channel-chat-protocol.js';
import type { WorkspaceSurface } from '../../../shared/workspace-surfaces.js';
import {
  resolveTopicActiveContext,
  type WorkspaceTopic,
  type WorkspaceTopicSearchResult,
} from '../../../shared/workspace-topics.js';
import {
  fetchHubNodes,
  fetchChannelRoster,
  fetchChannels,
  fetchWorkspaceSurfaces,
  fetchWorkspaceTopics,
  interruptChannelAgent,
  postChannelMessage,
  searchChannelMessages,
  searchWorkspaceTopics,
  sendSessionInput,
  type ChannelAgentStatus,
} from '../lib/api.js';
import type { CockpitRosterAttention } from '../lib/state/cockpit-attention.js';
import { deriveColor } from '../lib/colors.js';
import { resolveSenderIdentity } from '../lib/chat/sender-identity.js';
import { resolveSessionByKey, scopedSessionKey } from '../lib/session-keys.js';
import {
  hasUnseenActivity,
  useChannelActivityStore,
} from '../lib/stores/channel-activity.js';
import { AgentAvatar } from './chat/AgentAvatar.js';
import { leaveChatSurface, openTopicTaskRoom } from '../lib/topic-task-room.js';
import {
  applyTopicActiveContext,
  openTopicSelection,
} from '../lib/topic-selection.js';
import type { SessionSummary } from '../lib/types.js';
import { formatRelativeTimeCompact } from '../lib/utils.js';
import { useSessionsStore } from '../lib/stores/sessions.js';
import { useUiStore } from '../lib/stores/ui.js';
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
  indexChannelSummaries,
  railThreadFoldId,
  selectChannelRailTree,
  selectExpandedRailIds,
  selectRailRowThreads,
  type ChannelRailNode,
  type ChannelRailSection,
  type ChannelRailSummary,
  type ChannelRailThreadSummary,
  type ChannelRailTree,
  type ChannelRailWorkspaceGroup,
  type TopicNavItem,
  type TopicNavModel,
  type TopicNavNode,
  type TopicNavWorkspace,
  type TopicNavParticipantRef,
  type TopicNavSessionRef,
  type TopicNavSurfaceRef,
} from '../lib/state/topic-nav.js';
import {
  PRESENCE_TOKENS,
  selectRailRowPresence,
} from '../lib/state/cockpit-presence.js';
import { MarqueeText } from './MarqueeText.js';
import { TuiProgress } from './TuiProgress.js';
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
const MOBILE_COCKPIT_ROSTER_BATCH_SIZE = 12;
/**
 * Trailing-edge window for the channel-list refresh a live activity burst
 * triggers. `GET /channels` costs a per-channel summary + member read on the
 * hub, and a streaming agent turn emits a badge per message create / stream
 * open / stream complete, so the window is sized for "the rail's snippets stay
 * roughly current" rather than per-message freshness: unread state already
 * arrives live over the socket, and the open channel renders from its own
 * timeline. Paired with the hidden-tab gate below, an unwatched turn costs zero
 * refetches.
 */
const CHANNEL_SUMMARY_REFRESH_THROTTLE_MS = 10_000;
const CURRENT_OPERATOR_SENDER_ID = 'human:operator';
const CURRENT_OPERATOR_MENTION_NAME = 'operator';

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

/**
 * Mention signal read off the channel-list summary (#1287). Replaces a limit-1
 * `channel-history` fetch per unread channel: the list payload already carries
 * the newest prose row's sender + mention refs, so one call covers the whole
 * rail. The summary preview is the newest row that carries prose (detail cards
 * persist an empty body), which is exactly the row an operator would read as
 * "the last message".
 *
 * `lastMessage.mentions` is authoritative: the server computes it over the FULL
 * body (persisted mentions when the write path resolved them), so a mention past
 * the 200-char preview cut-off still counts. The preview parse below is only the
 * fallback for a payload predating that field.
 */
function summaryMentionsCurrentOperator(
  summary: ChannelRailSummary | null
): boolean {
  const last = summary?.lastMessage;
  if (!last) return false;
  if (last.senderId === CURRENT_OPERATOR_SENDER_ID) return false;
  // Browser-authored channel posts are canonically `human:operator` with the
  // display name `Operator` (channel-chat-router deriveSender).
  const mentions =
    last.mentions ??
    // Legacy payload without the field: parse the truncated preview with the
    // shared parser rather than introducing a cockpit-only tokenizer.
    parseMentions(last.preview);
  return mentions.some(
    (mention) =>
      mention.raw.slice(1).toLowerCase() === CURRENT_OPERATOR_MENTION_NAME
  );
}

/**
 * Slack-style row snippet: `sender: text` for the newest message, bounded to the
 * same length cap the status line uses. Null when the row has no summary yet or
 * the channel holds no messages — callers fall back to the topic status line.
 */
function channelRowPreview(summary: ChannelRailSummary | null): string | null {
  const last = summary?.lastMessage;
  if (!last) return null;
  const text = last.preview.replace(/\s+/g, ' ').trim();
  if (!text) return null;
  const sender = channelRowSenderLabel(last);
  return boundedTopicLatestStatus(sender ? `${sender}: ${text}` : text);
}

/**
 * Short sender label for a row snippet. NEVER derived by splitting `senderId`:
 * an agent's id is its profile Actor id (`agent-profile:<vendor>:default`, or
 * `agent-profile:<vendor>:<uuid>` for a custom profile), so the trailing segment
 * is `default`/a uuid, not a name (#1234, `shared/channel-chat-protocol.ts`).
 * Read the server-resolved `senderDisplayName`, then `providerId`, and only then
 * fall back to the vendor segment of a profile id / the name half of a
 * `human:<actorId>` ref.
 */
function channelRowSenderLabel(
  last: NonNullable<ChannelRailSummary['lastMessage']>
): string {
  return senderShortLabel(last);
}

/**
 * The rule itself, over the three fields any sender-bearing row carries. Split
 * out of `channelRowSenderLabel` (#1308 slice 2) so a message-search hit — which
 * is not a `ChannelRailSummary` — labels its sender by the SAME precedence
 * instead of growing a second, drifting copy.
 */
function senderShortLabel(sender: {
  senderId: string;
  senderDisplayName?: string | undefined;
  providerId?: string | undefined;
}): string {
  if (sender.senderId === CURRENT_OPERATOR_SENDER_ID) return 'you';
  const label =
    sender.senderDisplayName?.trim() ||
    sender.providerId?.trim() ||
    senderLabelFromId(sender.senderId);
  return label === 'operator' ? 'you' : label;
}

/** Last-resort label for a sender id with no server-resolved name/vendor. */
function senderLabelFromId(senderId: string): string {
  // CLI-gateway actor rows are `agent:<actorId>` where the actor id may itself
  // be a profile id (`deriveSender`), so unwrap that prefix first.
  const withoutAgentPrefix = senderId.startsWith('agent:')
    ? senderId.slice('agent:'.length)
    : senderId;
  // `agent-profile:<vendor>:<rest>` — the VENDOR segment names the sender; the
  // trailing segment is `default` or a uuid.
  const vendor = parseAgentProfileProviderId(withoutAgentPrefix);
  if (vendor) return vendor;
  const separator = withoutAgentPrefix.indexOf(':');
  return separator === -1
    ? withoutAgentPrefix
    : withoutAgentPrefix.slice(separator + 1);
}

/**
 * Rail snippet for one thread (#1287 slice 5 item 18): the ROOT's prose labelled
 * by its sender, exactly like a channel row's snippet — a thread is named by the
 * message it hangs off, not by its newest reply.
 */
function threadRowPreview(thread: ChannelRailThreadSummary): string {
  const text = thread.preview.replace(/\s+/g, ' ').trim();
  const sender = channelRowSenderLabel({
    seq: 0,
    preview: thread.preview,
    senderId: thread.rootSenderId,
    senderKind: thread.rootSenderKind,
    createdAt: thread.lastReplyAt,
    ...(thread.rootSenderDisplayName
      ? { senderDisplayName: thread.rootSenderDisplayName }
      : {}),
    ...(thread.providerId ? { providerId: thread.providerId } : {}),
  });
  if (!text) return boundedTopicLatestStatus(`${sender}: thread`);
  return boundedTopicLatestStatus(`${sender}: ${text}`);
}

function replyCountLabel(replyCount: number): string {
  return `${replyCount} repl${replyCount === 1 ? 'y' : 'ies'}`;
}

/** Compact last-activity stamp for a hydrated row; null without a summary. */
function channelRowTimestamp(
  summary: ChannelRailSummary | null
): string | null {
  const createdAt = summary?.lastMessage?.createdAt;
  if (!createdAt) return null;
  const label = formatRelativeTimeCompact(createdAt);
  return label || null;
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

/**
 * Structural, not `TopicNavSessionRef`: the rail asks about a nav ref, chat
 * search asks about the raw `SessionSummary` it resolved an id against, and
 * both must get the same verdict or the two entry points disagree about
 * whether a session is attachable (#1287 slice 5 item 20).
 */
function sessionAttachDisabledReason(
  session:
    | {
        status?: SessionSummary['status'] | null;
        durability?: SessionSummary['durability'] | null;
      }
    | undefined
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

function topicPrimaryAction(item: TopicNavItem): {
  label: string;
  detail: string;
  disabledReason: string | null;
} {
  const session = topicPrimarySession(item);
  const attachDisabledReason = session
    ? sessionAttachDisabledReason(session)
    : null;
  if (session?.displayState === 'permission') {
    return {
      label: 'approve',
      detail: 'send an audited approval reply to the live session',
      disabledReason: attachDisabledReason,
    };
  }
  if (session?.displayState === 'needs-answer') {
    return {
      label: 'reply',
      detail: 'send a short audited reply without opening the terminal first',
      disabledReason: attachDisabledReason,
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
  if (session?.activityState === 'permission-prompt') {
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
    session.durability === 'ended'
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
                    {lastActivityLabel}
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

function sessionLineageStatus(session: SessionSummary): 'idle' | 'active' {
  return session.idle ? 'idle' : 'active';
}

function SessionLineageRow({
  session,
  depth,
  onSelectSession,
}: {
  session: SessionSummary;
  depth: number;
  onSelectSession?: ((id: string) => void) | undefined;
}) {
  const status = sessionLineageStatus(session);
  const selectKey = scopedSessionKey(session);
  const rowStyle = { '--session-lineage-depth': depth } as CSSProperties;
  return (
    <li className="session-lineage-tree__item" style={rowStyle}>
      <button
        type="button"
        className={`session-lineage-tree__row session-lineage-tree__row--${status}`}
        disabled={!onSelectSession}
        data-session-id={session.id}
        title={`open session ${session.displayName}`}
        onClick={() => onSelectSession?.(selectKey)}
      >
        <span className="session-lineage-tree__icon" aria-hidden="true">
          ›_
        </span>
        <span className="session-lineage-tree__content">
          <span className="session-lineage-tree__name">
            <MarqueeText>{session.displayName}</MarqueeText>
          </span>
          <span className="session-lineage-tree__meta">
            <span>{status}</span>
          </span>
        </span>
        <span className="session-lineage-tree__action" aria-hidden="true">
          {status === 'active' ? '⠿' : '·'}
        </span>
      </button>
    </li>
  );
}

/** Operator-facing list of live terminal sessions. */
function SessionLineageTree({
  sessions,
  onSelectSession,
}: {
  sessions: SessionSummary[];
  onSelectSession?: ((id: string) => void) | undefined;
}) {
  if (sessions.length === 0) return null;
  return (
    <section
      className="session-lineage-tree session-lineage-tree--flat"
      aria-label="session lineage"
    >
      <div className="session-lineage-tree__header">
        <span>session tree</span>
        <span>{sessions.length} live</span>
      </div>
      <ul className="session-lineage-tree__list">
        {sessions.map((session) => (
          <SessionLineageRow
            key={scopedSessionKey(session)}
            session={session}
            depth={0}
            onSelectSession={onSelectSession}
          />
        ))}
      </ul>
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
  const disabledReason = sessionAttachDisabledReason(session);
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
            terminal · {session.displayState}
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
  sessions,
  workspaceName,
  surfacesError,
  surfacesLoading,
  onSelectSession,
  onOpenEvidenceDashboard,
}: {
  item: TopicNavItem;
  sessions: SessionSummary[];
  /** Friendly workspace name for the meta strip; omitted entirely (never a raw id) when unresolved. */
  workspaceName?: string | null | undefined;
  surfacesError?: boolean | undefined;
  surfacesLoading?: boolean | undefined;
  onSelectSession?: ((id: string) => void) | undefined;
  onOpenEvidenceDashboard?: (() => void) | undefined;
}) {
  const action = topicPrimaryAction(item);
  const session = topicPrimarySession(item);
  const topSurface = item.surfaces[0];
  const groupedSessions = topicRoomGroupedSessions(item);
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
        {/* #1287: no restore button here. This panel only exists under advanced
            mode, while opening the archived row puts the ungated composer
            restore bar in front of the operator at every breakpoint — one
            affordance, one shared mutation (`useRestoreTopicMutation`). */}
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

      <SessionLineageTree
        sessions={sessions}
        onSelectSession={onSelectSession}
      />
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
  const { item, unread, summary } = node;
  const action = topicPrimaryAction(item);
  const session = topicPrimarySession(item);
  // Same hydrated row payload as the desktop rail (#1287); the live session
  // status line remains the fallback for rows the channel list does not cover.
  const preview = channelRowPreview(summary);
  const timestamp = channelRowTimestamp(summary);
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
            {preview ?? topicLatestStatus(item)}
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
          {timestamp ? (
            <span className="topic-mobile-row__time">{timestamp}</span>
          ) : null}
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
            {session ? <span>terminal</span> : null}
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
  sessions,
  show,
  workspaceNameById,
  surfacesError,
  surfacesLoading,
  onSelectSession,
  onOpenEvidenceDashboard,
}: {
  item: TopicNavItem | undefined;
  sessions: SessionSummary[];
  show: boolean;
  workspaceNameById: Map<string, string>;
  surfacesError: boolean;
  surfacesLoading: boolean;
  onSelectSession?: ((id: string) => void) | undefined;
  onOpenEvidenceDashboard?: (() => void) | undefined;
}) {
  if (!item || !show) return null;
  return (
    <div className="topic-shell__advanced-detail">
      <TopicDetail
        item={item}
        sessions={sessions}
        workspaceName={resolveWorkspaceName(item, workspaceNameById)}
        surfacesError={surfacesError}
        surfacesLoading={surfacesLoading}
        onSelectSession={onSelectSession}
        onOpenEvidenceDashboard={onOpenEvidenceDashboard}
      />
    </div>
  );
}

/**
 * Compact agent presence for a desktop rail row (#1287 slice 5).
 *
 * Mirrors what the mobile cockpit chip shows, but sourced from the channel
 * summary the rail already holds joined with the live status store — never a
 * per-row roster fetch. A 50% status dot carries the rolled-up state per
 * `DESIGN.md`; a working channel swaps the dot for the braille spinner so
 * liveness is text motion, not a shimmer. The count is suppressed for a single
 * agent (the common DM case) and stays in the accessible label.
 *
 * `role="img"` is load-bearing, not decoration: ARIA does not permit naming a
 * generic element, so an `aria-label` on a bare `<span>` is discarded and the
 * dot/spinner children are `aria-hidden` — presence would reach a mouse
 * tooltip and nothing else. The role makes the indicator a single nameable
 * graphic, which is the accessibility half of desktop presence parity.
 */
function TopicRowPresence({
  channelId,
  summary,
  statusByChannelAgent,
}: {
  channelId: string;
  summary: ChannelRailSummary | null;
  statusByChannelAgent: Readonly<Record<string, ChannelAgentStatus>>;
}) {
  const presence = selectRailRowPresence(
    channelId,
    summary,
    statusByChannelAgent
  );
  if (!presence) return null;
  const token = PRESENCE_TOKENS[presence.presence];
  const style = {
    '--cockpit-presence-color': token.colorVar,
  } as CSSProperties;
  return (
    <span
      className={`topic-row__presence topic-row__presence--${presence.presence}`}
      style={style}
      role="img"
      aria-label={presence.label}
      title={presence.label}
      data-presence={presence.presence}
      data-agent-count={presence.count}
    >
      {token.glyph === 'spinner' ? (
        <TuiProgress
          variant="braille"
          className="topic-row__presence-spinner"
          aria-hidden
        />
      ) : (
        <span className="topic-row__presence-dot" aria-hidden />
      )}
      {presence.count > 1 ? (
        <span className="topic-row__presence-count" aria-hidden>
          {presence.count}
        </span>
      ) : null}
    </span>
  );
}

/**
 * Threads on a rail row (#1287 slice 5 item 18).
 *
 * Threads were fully implemented server-side and in `ChannelView`, but the only
 * product entry point was the in-timeline "N replies" chip — so a thread was
 * unreachable, and its reply growth invisible, until its channel was already
 * open. This is the missing navigation half: a compact "N threads · latest" line
 * on the row, opening to one clickable row per live thread.
 *
 * Folded through the SAME persisted expansion record as item 16, under a
 * `#threads`-namespaced id. That id is never a `rootIds` entry, so the structural
 * default is CLOSED (roots are the only rows that auto-open) while an operator
 * who opens it keeps it open across reloads.
 */
function TopicRowThreads({
  channelId,
  channelTitle,
  summary,
  expandedIds,
  onToggle,
  onOpenThread,
}: {
  channelId: string;
  channelTitle: string;
  summary: ChannelRailSummary | null;
  expandedIds: Set<string>;
  onToggle: (id: string) => void;
  onOpenThread?:
    | ((channelId: string, rootMessageId: string) => void)
    | undefined;
}) {
  const { threads, threadCount } = selectRailRowThreads(summary);
  if (threads.length === 0) return null;
  const foldId = railThreadFoldId(channelId);
  const expanded = expandedIds.has(foldId);
  const latest = threads[0];
  const countLabel = `${threadCount} thread${threadCount === 1 ? '' : 's'}`;
  return (
    <div className="topic-threads" data-thread-count={threadCount}>
      <button
        type="button"
        className="topic-threads__toggle"
        aria-expanded={expanded}
        aria-label={`${expanded ? 'collapse' : 'expand'} ${countLabel} in ${channelTitle}`}
        onClick={() => onToggle(foldId)}
      >
        <span className="topic-threads__glyph" aria-hidden>
          {expanded ? '−' : '+'}
        </span>
        <span className="topic-threads__count">{countLabel}</span>
        {!expanded && latest ? (
          <span
            className="topic-threads__latest"
            title={threadRowPreview(latest)}
          >
            {threadRowPreview(latest)}
          </span>
        ) : null}
      </button>
      {expanded ? (
        <ul
          className="topic-child-list topic-child-list--threads"
          aria-label={`threads in ${channelTitle}`}
        >
          {threads.map((thread) => {
            const preview = threadRowPreview(thread);
            const stamp = formatRelativeTimeCompact(thread.lastReplyAt);
            return (
              <li
                key={thread.rootMessageId}
                className="topic-child-row topic-thread-row"
                data-thread-root-id={thread.rootMessageId}
              >
                <button
                  type="button"
                  className="topic-child-row__button topic-thread-row__button"
                  aria-label={`open thread — ${preview} · ${replyCountLabel(thread.replyCount)}`}
                  disabled={!onOpenThread}
                  onClick={() =>
                    onOpenThread?.(channelId, thread.rootMessageId)
                  }
                >
                  <span className="topic-thread-row__lines">
                    <span className="topic-thread-row__preview" title={preview}>
                      {preview}
                    </span>
                    <span className="topic-thread-row__meta">
                      {replyCountLabel(thread.replyCount)}
                      {stamp ? ` · ${stamp}` : ''}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}

function TopicRow({
  node,
  depth,
  expandedIds,
  selectedId,
  statusByChannelAgent,
  onToggle,
  onSelect,
  onSelectSession,
  onOpenThread,
}: {
  node: ChannelRailNode;
  depth: number;
  expandedIds: Set<string>;
  selectedId: string | null;
  statusByChannelAgent: Readonly<Record<string, ChannelAgentStatus>>;
  onToggle: (id: string) => void;
  onSelect: (id: string) => void;
  onSelectSession?: ((id: string) => void) | undefined;
  onOpenThread?:
    | ((channelId: string, rootMessageId: string) => void)
    | undefined;
}) {
  const { item, unread, summary, children } = node;
  const hasNested = children.length > 0 || item.participants.length > 0;
  const expanded = expandedIds.has(item.id);
  const selected = selectedId === item.id;
  // Slack-browser row payload (#1287): last message + stamp, hydrated from the
  // channel list the rail already fetches. Rows the list does not cover (derived
  // topics) keep the bare title.
  const preview = channelRowPreview(summary);
  const timestamp = channelRowTimestamp(summary);

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
          <span className="topic-row__lines">
            <span className="topic-row__title">
              <MarqueeText>{item.title}</MarqueeText>
            </span>
            {preview ? (
              <span className="topic-row__preview" title={preview}>
                {preview}
              </span>
            ) : null}
          </span>
        </button>
        {/* `role="group"` so the row's status name is actually exposed: a bare
            span cannot be named, and unlike `role="img"` a group does not turn
            the presence indicator and unread dot inside it into presentational
            children that lose their own names. */}
        <span
          className="topic-row__trail"
          role="group"
          aria-label={item.statusLabel}
        >
          <TopicRowPresence
            channelId={item.id}
            summary={summary}
            statusByChannelAgent={statusByChannelAgent}
          />
          {timestamp ? (
            <span className="topic-row__time">{timestamp}</span>
          ) : null}
          {unread ? (
            <span
              className="topic-row__activity-dot"
              role="img"
              aria-label="unread activity"
              title="unread activity"
            />
          ) : null}
          <StatusGlyph tone={item.tone} />
        </span>
      </div>
      {/* Outside the row's own fold: the thread line IS the signal that this
          channel has live side-conversations, so folding the row's participants
          must not hide it. It carries its own collapsed-by-default fold. */}
      <TopicRowThreads
        channelId={item.id}
        channelTitle={item.title}
        summary={summary}
        expandedIds={expandedIds}
        onToggle={onToggle}
        onOpenThread={onOpenThread}
      />
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
                  statusByChannelAgent={statusByChannelAgent}
                  onToggle={onToggle}
                  onSelect={onSelect}
                  onSelectSession={onSelectSession}
                  onOpenThread={onOpenThread}
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

/**
 * Whether a derived search hit's linked session is actually attachable, and
 * under which key (#1287 slice 5 item 20).
 *
 * `action.primarySessionId` is a STRING carried on a WorkContext record, not
 * proof the session still exists: derived hits come from `fallbackTopics` over
 * the WorkContext store, whose `linkedRefs.sessionIds[0]` routinely names a
 * session the client no longer holds. Enabling `resume` on id presence alone
 * let the operator click into `activeSessionId = <gone id>`, which App's
 * channel/session mutual exclusion reads as "a session opened" and clears the
 * channel they were reading — closing their chat and landing on neither
 * surface. So resolve the id and run the same attach gate the rail's
 * `selectMobile` runs, and hand back the scoped select key the rail passes
 * (`sessionSelectKey`), never the raw id.
 */
interface SearchResumeTarget {
  selectKey: string | null;
  disabledReason: string | null;
}

function searchResultResumeTarget(
  result: WorkspaceTopicSearchResult,
  sessions: SessionSummary[],
  canOpenSession: boolean
): SearchResumeTarget {
  const linkedId = result.action.primarySessionId;
  if (!linkedId || !canOpenSession) {
    // Nothing was ever linked, or there is no session surface to open it in —
    // the row's generic dead-hit copy is the honest label, not a claim that a
    // session went away.
    return { selectKey: null, disabledReason: null };
  }
  const session = resolveSessionByKey(sessions, linkedId);
  if (!session) {
    return {
      selectKey: null,
      disabledReason: 'linked session is no longer available',
    };
  }
  const reason = sessionAttachDisabledReason(session);
  if (reason) return { selectKey: null, disabledReason: reason };
  return { selectKey: scopedSessionKey(session), disabledReason: null };
}

/**
 * What a search row's action can actually reach (#1287 slice 5 item 20).
 *
 * A persisted hit IS a channel, so it opens one. But `collectSearchTopics`
 * deliberately appends derived topics from the WorkContext store, and those are
 * backed by a session rather than a channel — `openTopicSelection` returns
 * early for them, so routing one through the channel path would render an
 * enabled `open` button that opens nothing. Those resume their linked session,
 * exactly as the rail row does for the same topic; a derived hit whose session
 * is gone or unattachable is a dead row, and that row says so.
 */
function searchResultOpenTarget(
  result: WorkspaceTopicSearchResult,
  resume: SearchResumeTarget
): { label: string; title: string } | null {
  if (result.topic.source === 'persisted') {
    return { label: 'open', title: 'open chat' };
  }
  if (resume.selectKey) {
    return { label: 'resume', title: 'resume the linked session' };
  }
  return null;
}

/**
 * #1287 slice 5 item 20: a search hit is a chat, so its action opens the chat.
 *
 * The row used to attach `action.primarySessionId` and disable itself whenever
 * that id was missing — which was every channel-native chat, i.e. the entire
 * product. `action.topicId` is the identity the server actually hands back, and
 * `onOpenTopic` routes it through the same gate as a rail row (item 9 routing).
 * A stale `disabledReason` describes linked surfaces, not the channel, so it
 * renders as a caveat and never blocks opening the conversation.
 *
 * `resumeTargetFor` rather than the session handler itself: the derived fallback
 * lives in `openSearchResult` beside the rail's own resume path, so this row
 * only needs the verdict that path will reach.
 */
function TopicSearchResults({
  results,
  truncated,
  onOpenTopic,
  resumeTargetFor,
}: {
  results: WorkspaceTopicSearchResult[];
  truncated: boolean;
  onOpenTopic: (result: WorkspaceTopicSearchResult) => void;
  resumeTargetFor: (result: WorkspaceTopicSearchResult) => SearchResumeTarget;
}) {
  if (results.length === 0 && !truncated) return null;
  return (
    <div
      className="topic-search-results"
      aria-label="chat search result details"
    >
      {results.map((result) => {
        const caveat = result.action.disabledReason;
        const resume = resumeTargetFor(result);
        const target = searchResultOpenTarget(result, resume);
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
              disabled={!target}
              title={
                target?.title ??
                resume.disabledReason ??
                'no chat or session to open for this hit'
              }
              onClick={() => onOpenTopic(result)}
            >
              {target?.label ?? 'open'}
            </button>
            {caveat ? (
              <span className="topic-search-result__caveat">{caveat}</span>
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

function messageEmptyStateText(input: {
  unavailableReason?: string | undefined;
  searchQuery: string;
}): string {
  if (input.unavailableReason === 'empty_query') {
    return 'type to search messages';
  }
  return `no message matches for “${input.searchQuery.trim()}”`;
}

/**
 * The matched runs of a hit's snippet (#1308 slice 2 item 2).
 *
 * The server delimits matches with two Private Use Area sentinels rather than
 * markup precisely so this stays a TEXT render: every run becomes a text node
 * and the emphasis is our own element, so an operator or agent message
 * containing `<mark>` cannot forge a highlight. Emphasis is color
 * (`var(--accent)`), never a background wash or a weight change — DESIGN.md
 * keeps one accent and the row is already at caption size, where bolding a
 * two-character run just makes it blurry.
 */
function MessageSnippet({ snippet }: { snippet: string }) {
  const segments = parseChannelSearchSnippet(snippet);
  return (
    <span className="topic-message-result__snippet">
      {segments.map((segment, index) =>
        segment.highlight ? (
          <mark
            // Index keys: segments are a pure function of one immutable
            // snippet string, so a given row's runs never reorder.
            key={index}
            className="topic-message-result__hit"
          >
            {segment.text}
          </mark>
        ) : (
          <span key={index}>{segment.text}</span>
        )
      )}
    </span>
  );
}

/**
 * The `messages` half of sidebar search (#1308 slice 2 item 2).
 *
 * A row is ONE button, not a row plus an `open` action: unlike a chat hit —
 * which may reach a channel, resume a session, or be dead — every message hit
 * has exactly one destination (that message, in that channel), so a separate
 * action control would be a second control for the row's only gesture and a
 * smaller tap target on a phone.
 */
function MessageSearchResults({
  results,
  truncated,
  onOpenMessage,
}: {
  results: ChannelMessageSearchResult[];
  truncated: boolean;
  onOpenMessage: (hit: ChannelMessageSearchResult) => void;
}) {
  return (
    <div
      className="topic-message-results"
      aria-label="message search result details"
    >
      {results.map((hit) => (
        <button
          key={hit.messageId}
          type="button"
          className="topic-message-result"
          data-message-id={hit.messageId}
          title={`open ${hit.channelTitle} at this message`}
          onClick={() => onOpenMessage(hit)}
        >
          <span className="topic-message-result__head">
            <span className="topic-message-result__channel">
              {hit.channelTitle}
            </span>
            <span className="topic-message-result__sender">
              {senderShortLabel(hit)}
            </span>
            {hit.threadId ? (
              <span className="topic-message-result__thread">thread</span>
            ) : null}
            {hit.archived ? (
              <span className="topic-message-result__archived">older</span>
            ) : null}
            <span className="topic-message-result__time">
              {formatRelativeTimeCompact(hit.createdAt)}
            </span>
          </span>
          <MessageSnippet snippet={hit.snippet} />
        </button>
      ))}
      {truncated ? (
        <div className="topic-message-result__truncated">
          results truncated; refine search
        </div>
      ) : null}
    </div>
  );
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
  sessions,
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
  onSelectSession,
  onSelectWorkspace,
  onStartChatInWorkspace,
}: {
  tree: ChannelRailTree;
  sessions: SessionSummary[];
  unreadByChannel: Readonly<Record<string, boolean>>;
  statusByChannelAgent: Readonly<Record<string, ChannelAgentStatus>>;
  mentionsMeByChannel: Readonly<Record<string, boolean>>;
  rosterAttentionBySessionKey: Readonly<Record<string, CockpitRosterAttention>>;
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
  onSelectSession?: ((id: string) => void) | undefined;
  onSelectWorkspace: (workspaceId: string) => void;
  onStartChatInWorkspace?: ((workspaceId: string) => void) | undefined;
}) {
  // #1287 slice 5: lane folds are persisted operator intent, not per-mount
  // `useState` that a reload (or any remount of the cockpit) silently discards.
  const collapsedGroupIds = useUiStore((s) => s.collapsedTopicGroups);
  const toggleGroup = useUiStore((s) => s.toggleTopicGroupCollapsed);
  const hasOrphans =
    tree.orphans.channels.length > 0 || tree.orphans.directMessages.length > 0;
  return (
    <section className="topic-mobile-cockpit" aria-label="mobile chat switcher">
      <div
        className="topic-mobile-cockpit__bar"
        aria-label="mobile chat actions"
      >
        {/* #1287 slice 5 item 12: this bar used to lead with a static
            `search chat history` label that had no handler and no input — it
            named a capability the bar did not provide. The real search field
            now sits above this cockpit, so the bar carries actions only. */}
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
      <SessionLineageTree
        sessions={sessions}
        onSelectSession={onSelectSession}
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
              <WorkspaceLaneHeader
                block="topic-mobile-group"
                group={group}
                expanded={expanded}
                onSelectWorkspace={onSelectWorkspace}
                onToggleCollapsed={toggleGroup}
              />
              {!expanded ? null : group.empty ? (
                <WorkspaceLaneStartChat
                  workspaceId={group.id}
                  workspaceTitle={group.title}
                  className="topic-mobile-group__empty"
                  onStartChat={onStartChatInWorkspace}
                />
              ) : (
                <MobileRailSection
                  section={group}
                  statusByChannelAgent={statusByChannelAgent}
                  onNudge={onNudge}
                  onInterrupt={onInterrupt}
                  selectedId={selectedId}
                  onSelect={onSelect}
                />
              )}
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
  messageResults,
  messageLoading,
  messageError,
  messageTruncated,
  messageUnavailableReason,
  onSearchQueryChange,
  onSearchRetry,
  onSearchClear,
  onOpenTopic,
  onOpenMessage,
  searchScope = 'all',
  onToggleSearchScope,
  canScope = false,
  resumeTargetFor,
}: {
  model: TopicNavModel;
  searchQuery: string;
  searchLoading: boolean;
  searchError: boolean;
  searchResults: WorkspaceTopicSearchResult[];
  searchTruncated: boolean;
  searchUnavailableReason?: string | undefined;
  messageResults: ChannelMessageSearchResult[];
  messageLoading: boolean;
  messageError: boolean;
  messageTruncated: boolean;
  messageUnavailableReason?: string | undefined;
  onSearchQueryChange?: ((query: string) => void) | undefined;
  onSearchRetry?: (() => void) | undefined;
  onSearchClear?: (() => void) | undefined;
  onOpenTopic: (result: WorkspaceTopicSearchResult) => void;
  onOpenMessage: (hit: ChannelMessageSearchResult) => void;
  searchScope?: 'all' | 'workspace';
  onToggleSearchScope?: (() => void) | undefined;
  canScope?: boolean;
  resumeTargetFor: (result: WorkspaceTopicSearchResult) => SearchResumeTarget;
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
      {!searchActive &&
      model.items.length === 0 &&
      !searchLoading &&
      !searchError ? (
        <div className="topic-shell-state">
          {topicEmptyStateText({
            searchActive,
            searchUnavailableReason,
            searchQuery,
          })}
        </div>
      ) : null}
      {/* #1308 slice 2 item 2: search answers two different questions — "which
          chat was that?" and "where was that said?" — so the results are two
          labelled sections rather than one ranked list. Merging them would put
          a bm25 message score in the same order as a topic-title score, two
          scales that share no unit, and the operator could not tell which kind
          of answer they were looking at. */}
      {searchActive ? (
        <div className="topic-search-sections" aria-label="search results">
          <section
            className="topic-search-section"
            aria-label="chat search results"
          >
            <div className="topic-search-section__header">chats</div>
            {searchResults.length > 0 || searchTruncated ? (
              <TopicSearchResults
                results={searchResults}
                truncated={searchTruncated}
                onOpenTopic={onOpenTopic}
                resumeTargetFor={resumeTargetFor}
              />
            ) : searchLoading || searchError ? null : (
              <div className="topic-search-section__empty">
                {topicEmptyStateText({
                  searchActive,
                  searchUnavailableReason,
                  searchQuery,
                })}
              </div>
            )}
          </section>
          <section
            className="topic-search-section"
            aria-label="message search results"
          >
            <div className="topic-search-section__header">messages</div>
            {messageResults.length > 0 ? (
              <MessageSearchResults
                results={messageResults}
                truncated={messageTruncated}
                onOpenMessage={onOpenMessage}
              />
            ) : messageError ? (
              <div className="topic-search-section__empty error">
                message search unavailable
              </div>
            ) : messageLoading ? null : (
              <div className="topic-search-section__empty">
                {messageEmptyStateText({
                  unavailableReason: messageUnavailableReason,
                  searchQuery,
                })}
              </div>
            )}
          </section>
        </div>
      ) : null}
    </>
  );
}

const EMPTY_TOPICS: WorkspaceTopic[] = [];
const EMPTY_SURFACES: WorkspaceSurface[] = [];
const EMPTY_SEARCH_RESULTS: WorkspaceTopicSearchResult[] = [];
const EMPTY_MESSAGE_RESULTS: ChannelMessageSearchResult[] = [];

const EMPTY_WORKSPACES: TopicNavWorkspace[] = [];
const EMPTY_CHANNEL_SUMMARIES: ChannelRailSummary[] = [];

/**
 * Settle window for the sidebar search input (#1308 slice 2 item 2). Matches
 * the command palette's 150ms so the two search affordances feel identical.
 */
const SEARCH_DEBOUNCE_MS = 150;

/**
 * `value`, held back until it has stopped changing for `delayMs`.
 *
 * Used for the search field: every keystroke used to mint a fresh TanStack key
 * and a fresh request, and item 2 adds a SECOND query behind the same field —
 * doubling that. The debounce lives above both queries rather than inside
 * either, so one settled value drives both sections.
 */
function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    if (Object.is(settled, value)) return;
    const timer = setTimeout(() => setSettled(value), delayMs);
    return () => clearTimeout(timer);
  }, [delayMs, settled, value]);
  return settled;
}

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

/**
 * Start-a-chat affordance for a workspace lane that holds no channels yet
 * (#1287). Deliberately the SAME control as the rail header's `new chat`
 * button — same label, same button treatment — so an empty lane introduces no
 * second visual language. Clicking stamps this lane's real workspace id so the
 * chat the operator then creates is filed under THIS workspace.
 */
function WorkspaceLaneStartChat({
  workspaceId,
  workspaceTitle,
  className,
  onStartChat,
}: {
  workspaceId: string;
  workspaceTitle: string;
  className: string;
  onStartChat?: ((workspaceId: string) => void) | undefined;
}) {
  return (
    <button
      type="button"
      className={`topic-shell__create ${className}`}
      data-workspace-start-chat={workspaceId}
      disabled={!onStartChat}
      title={
        onStartChat
          ? `start a chat in ${workspaceTitle}`
          : 'chat creation unavailable'
      }
      onClick={onStartChat ? () => onStartChat(workspaceId) : undefined}
    >
      new chat
    </button>
  );
}

/**
 * The workspace lane header, shared by the desktop rail and the mobile cockpit
 * (#1287 slice 5 item 17).
 *
 * Desktop used to render a select-only header while mobile rendered the very
 * same lane as a collapsible button — so a desktop operator could neither fold
 * a lane nor see the `group.unread` rollup `selectChannelRailTree()` had
 * already computed for both breakpoints, and desktop simply discarded it. One
 * component now owns the whole lane gesture, so the two surfaces cannot drift
 * apart again.
 *
 * The gesture itself is per-breakpoint on purpose. Selecting a lane is how the
 * rail picks the create target for `new chat`, so binding select and fold to
 * one click would collapse the lane the operator just aimed at — two clicks to
 * see the channels they were selecting. Mobile ships that coupling because a
 * tap is the only lane-scale gesture a phone has; desktop has hover, focus and
 * room for a dedicated glyph, so the name selects and the trailing `−`/`+`
 * folds. `aria-expanded` rides whichever control owns the fold.
 *
 * The affordance is text (`−`/`+`), not an icon: it is the same character pair
 * the mobile cockpit shipped with, and it needs no stroke geometry to stay
 * legible at caption size. Deliberately NO channel count — the audit calls the
 * absence intentional.
 */
function WorkspaceLaneHeader({
  block,
  group,
  expanded,
  onSelectWorkspace,
  onToggleCollapsed,
}: {
  block: 'topic-workspace-group' | 'topic-mobile-group';
  group: ChannelRailWorkspaceGroup;
  expanded: boolean;
  onSelectWorkspace: (workspaceId: string) => void;
  onToggleCollapsed: (workspaceId: string) => void;
}) {
  const foldLabel = `${expanded ? 'collapse' : 'expand'} ${group.title}`;
  const icon = group.icon ? (
    <span className={`${block}__icon`} aria-hidden="true">
      {group.icon}
    </span>
  ) : null;
  const unreadRollup =
    !expanded && group.unread ? (
      <span
        className="topic-row__activity-dot"
        role="img"
        aria-label="unread activity"
        title="unread activity"
      />
    ) : null;

  if (block === 'topic-mobile-group') {
    return (
      <button
        type="button"
        className={`${block}__header ${block}__header--select`}
        aria-expanded={expanded}
        title={foldLabel}
        onClick={() => {
          // One tap is the only lane-scale gesture at this breakpoint, so it
          // both selects the lane (it is the create target) and folds it.
          onSelectWorkspace(group.id);
          onToggleCollapsed(group.id);
        }}
      >
        {icon}
        <span className={`${block}__name`}>{group.title}</span>
        {unreadRollup}
        <span className={`${block}__toggle`} aria-hidden="true">
          {expanded ? '−' : '+'}
        </span>
      </button>
    );
  }

  return (
    <div className={`${block}__header ${block}__header--split`}>
      <button
        type="button"
        className={`${block}__select`}
        title={`select ${group.title}`}
        onClick={() => onSelectWorkspace(group.id)}
      >
        {icon}
        <span className={`${block}__name`}>{group.title}</span>
      </button>
      {unreadRollup}
      <button
        type="button"
        className={`${block}__toggle`}
        aria-expanded={expanded}
        aria-label={foldLabel}
        title={foldLabel}
        onClick={() => onToggleCollapsed(group.id)}
      >
        {expanded ? '−' : '+'}
      </button>
    </div>
  );
}

function GroupedTopicTree({
  tree,
  renderRow,
  onSelectWorkspace,
  onStartChatInWorkspace,
}: {
  tree: ChannelRailTree;
  renderRow: (node: ChannelRailNode) => ReactNode;
  onSelectWorkspace: (workspaceId: string) => void;
  onStartChatInWorkspace?: ((workspaceId: string) => void) | undefined;
}) {
  // #1287 slice 5: the same persisted lane folds the mobile cockpit reads, so
  // folding a lane is one operator decision per workspace rather than one per
  // breakpoint.
  const collapsedGroupIds = useUiStore((s) => s.collapsedTopicGroups);
  const toggleGroup = useUiStore((s) => s.toggleTopicGroupCollapsed);
  return (
    <div className="topic-tree" aria-label="workspace chats">
      {tree.groups.map((group) => {
        const expanded = !collapsedGroupIds.has(group.id);
        return (
          <section
            key={group.id}
            className="topic-workspace-group"
            aria-label={group.title}
            data-workspace-id={group.id}
          >
            <WorkspaceLaneHeader
              block="topic-workspace-group"
              group={group}
              expanded={expanded}
              onSelectWorkspace={onSelectWorkspace}
              onToggleCollapsed={toggleGroup}
            />
            {!expanded ? null : group.empty ? (
              <WorkspaceLaneStartChat
                workspaceId={group.id}
                workspaceTitle={group.title}
                className="topic-workspace-group__empty"
                onStartChat={onStartChatInWorkspace}
              />
            ) : (
              <ChannelsAndDmsLists section={group} renderRow={renderRow} />
            )}
          </section>
        );
      })}
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
  messageResults = EMPTY_MESSAGE_RESULTS,
  messageSearchLoading = false,
  messageSearchError = false,
  messageSearchTruncated = false,
  messageSearchUnavailableReason,
  surfacesError = false,
  onSearchQueryChange,
  onSearchRetry,
  onSearchClear,
  onSelectSession,
  onSendInput = sendSessionInput,
  onCreateTaskRoom,
  workspaces = EMPTY_WORKSPACES,
  nodes,
  channelSummaries = EMPTY_CHANNEL_SUMMARIES,
  activeWorkspaceId = null,
  searchScope = 'all',
  onToggleSearchScope,
  showArchived = false,
  onToggleArchived,
  showAdvancedDetail = false,
}: {
  topics: WorkspaceTopic[];
  sessions: SessionSummary[];
  surfaces: WorkspaceSurface[];
  workspaces?: TopicNavWorkspace[];
  /** Known node roster; resolves raw routing node ids to friendly names. */
  nodes?: TopicNavNode[];
  /**
   * `GET /channels` rows (#1287). Joined onto topic rows by id to hydrate the
   * last-message snippet, stamp, and mention signal. Optional: the rail renders
   * from topics alone until it lands, and derived topics never appear here.
   */
  channelSummaries?: ChannelRailSummary[];
  activeWorkspaceId?: string | null;
  searchScope?: 'all' | 'workspace';
  onToggleSearchScope?: (() => void) | undefined;
  showArchived?: boolean;
  onToggleArchived?: (() => void) | undefined;
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
  /** #1308 slice 2: full-text message hits for the search panel's second section. */
  messageResults?: ChannelMessageSearchResult[];
  messageSearchLoading?: boolean;
  messageSearchError?: boolean;
  messageSearchTruncated?: boolean;
  messageSearchUnavailableReason?: string | undefined;
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
          hasUnseenActivity(item.id, activeChannelId, {
            latestSeq: relevantActivity[index * 2],
            lastRead: relevantActivity[index * 2 + 1],
          }),
        ])
      ),
    [activeChannelId, model.items, relevantActivity]
  );
  // One channel-list payload hydrates every row (#1287): last message, stamp,
  // members, and the mention signal the cockpit used to fan out limit-1 history
  // fetches for. Unread stays owned by the clamp-fenced activity store above.
  const summaryByChannel = useMemo(
    () => indexChannelSummaries(channelSummaries),
    [channelSummaries]
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
    currentRosterBatchSettled,
    rosterBatch.end,
    rosterBatch.scope,
    rosterBatchScope,
  ]);
  // #1287: derived from the one channel-list payload the rail already holds.
  // This replaced a limit-1 `channel-history` fetch per unread channel — the
  // list summary carries the same newest-prose sender + text. Still gated on
  // unread so a read channel never keeps its mention bonus in the lane.
  const mentionsMeByChannel = useMemo(() => {
    const mentioned: Record<string, boolean> = {};
    for (const [channelId, summary] of Object.entries(summaryByChannel)) {
      if (!unreadByChannel[channelId]) continue;
      if (summaryMentionsCurrentOperator(summary)) mentioned[channelId] = true;
    }
    return mentioned;
  }, [summaryByChannel, unreadByChannel]);
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
  const rosterAttentionBySessionKey: Record<string, CockpitRosterAttention> =
    {};
  const railTree = useMemo(
    () =>
      selectChannelRailTree(model, workspaces, {
        unreadByChannel,
        summaryByChannel,
      }),
    [model, summaryByChannel, unreadByChannel, workspaces]
  );
  const firstId = model.rootIds[0] ?? model.items[0]?.id ?? null;
  const [selectedId, setSelectedId] = useState<string | null>(firstId);
  const [mobileControlTopicId, setMobileControlTopicId] = useState<
    string | null
  >(null);
  // #1287 slice 5: rail fold state is persisted operator intent, derived on
  // every render instead of being seeded into component state by an effect.
  // The old effect re-added every root to a local `expandedIds` set whenever
  // the nav model changed identity, and the sessions store hands out a fresh
  // `sessions` array on every activity/status/branch/rename WS event — so a
  // collapsed root sprang back open within seconds of any live agent turn.
  const topicRailExpansion = useUiStore((s) => s.topicRailExpansion);
  const setTopicRailExpanded = useUiStore((s) => s.setTopicRailExpanded);
  const expandedIds = useMemo(
    () => selectExpandedRailIds(model.rootIds, topicRailExpansion),
    [model.rootIds, topicRailExpansion]
  );

  useEffect(() => {
    setSelectedId((current) =>
      current && model.byId.has(current) ? current : firstId
    );
  }, [firstId, model.byId]);

  const toggle = useCallback(
    (id: string) => {
      setTopicRailExpanded(id, !expandedIds.has(id));
    },
    [expandedIds, setTopicRailExpanded]
  );

  // Selecting a topic establishes its node + cwd context so terminals, agents,
  // and the workspace pane operate in the topic's node/repo. Only fires on an
  // explicit user selection — the initial/auto-selection sets `selectedId`
  // directly and never clobbers the active repo.
  // #1166: for a persisted channel (anything backed by GET /channels), clicking
  // the row also opens it in the main pane (activeChannelId) and closes the
  // composer — "selected in sidebar" and "open in main pane" become one state
  // for channels. Derived (non-persisted) topics never route to a channel.
  // `fallbackTopic` covers callers that hold their own copy of the topic (chat
  // search), so a selection still routes while the rail list is a beat behind.
  const select = useCallback(
    (id: string, fallbackTopic?: WorkspaceTopic) => {
      setSelectedId(id);
      setMobileControlTopicId(null);
      openTopicSelection(topicsById.get(id) ?? fallbackTopic);
    },
    [topicsById]
  );
  // #1287 slice 5 item 20: opening a search hit is opening a chat, so it lands
  // on the channel through the same `openTopicSelection` gate a rail row uses —
  // one routing path, no attach-a-session shortcut that skipped it. The drawer
  // close mirrors the mobile row and the palette: on desktop `sidebarOpen` is
  // already false, so it is a no-op there.
  //
  // Chat search also returns DERIVED topics (the server appends `fallbackTopics`
  // over the WorkContext store), and those have no channel — the gate returns
  // early for them. They resume their linked session instead, the same
  // disposition `selectMobile` gives the same topic on the rail, so the two
  // entry points cannot disagree about what a session-backed chat does.
  const searchResumeTargetFor = useCallback(
    (result: WorkspaceTopicSearchResult) =>
      searchResultResumeTarget(result, sessions, Boolean(onSelectSession)),
    [onSelectSession, sessions]
  );
  const openSearchResult = useCallback(
    (result: WorkspaceTopicSearchResult) => {
      const resume = searchResumeTargetFor(result);
      // Only a resolved, attachable session is worth switching to. A dead id
      // would still flip `activeSessionId`, which App reads as "a session
      // opened" and uses to clear `activeChannelId` — the row would close the
      // chat the operator was reading and open nothing.
      if (result.topic.source !== 'persisted' && !resume.selectKey) return;
      select(result.action.topicId, result.topic);
      if (result.topic.source !== 'persisted' && resume.selectKey) {
        onSelectSession?.(resume.selectKey);
      }
      useUiStore.getState().closeSidebar();
    },
    [onSelectSession, searchResumeTargetFor, select]
  );
  // #1308 slice 2 item 2: a message hit opens its channel AND asks that channel
  // to land on the exact message. The anchor is written AFTER the channel open
  // on purpose — `setActiveChannelId` clears any un-consumed anchor, so the
  // other order would erase the intent it had just recorded (same contract the
  // `#msg-` deep link in `useUrlNav` follows, and the same reason
  // `openThread` records its thread intent second).
  //
  // Nothing here resolves, scrolls, or paginates: `ChannelView` already owns the
  // bounded backwards walk, the not-in-recent-history toast, and the jump
  // emphasis (#1308 slice 1), and it opens the thread panel by itself when the
  // landed row turns out to be a reply. Reimplementing any of that here would
  // give search a second scroll path that could disagree with the deep link.
  //
  // A hit's channel is routinely ABSENT from `topicsById`: while searching, the
  // rail renders the chat-search topics, and a message can match in a channel
  // whose title does not. `openTopicSelection` is a no-op for anything it
  // cannot prove persisted, so an unresolved (or non-persisted) id falls back to
  // the two writes that gate performs rather than silently dropping the click
  // and leaving an anchor pointed at a channel nobody opened.
  const openMessageResult = useCallback(
    (hit: ChannelMessageSearchResult) => {
      const topic = topicsById.get(hit.channelId);
      if (topic?.source === 'persisted') {
        // Known topic: route through the shared gate so the hit also lands the
        // channel's workspace/repo context, exactly like clicking its rail row.
        select(hit.channelId, topic);
      } else {
        setSelectedId(hit.channelId);
        setMobileControlTopicId(null);
        const ui = useUiStore.getState();
        ui.setActiveChannelId(hit.channelId);
        ui.setTopicComposerOpen(false);
      }
      useUiStore.getState().requestChannelMessage(hit.channelId, hit.messageId);
      useUiStore.getState().closeSidebar();
    },
    [select, topicsById]
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
  // #1287: `activeWorkspaceId` and `activeRepoPath` are two halves of ONE
  // routing decision — `useTopicRoomCreate` files the channel by the first and
  // derives `routingDefaults.repoPath`/`cwd` from the second. Moving only the
  // lane pointer would file the chat in the newly chosen project while still
  // pointing it at the ABANDONED project's repo: a split across two projects,
  // strictly worse than the consistent-but-stale state it replaced. The lane
  // row already carries the anchor (`ensureProjectWorkspace` stamps
  // `defaultRepoPath` on every add-project lane), so the create paths stamp it
  // alongside the id.
  //
  // Applied on the CREATE paths only, never on a bare lane click:
  // `resolveAppViewMode` returns 'dashboard' the moment `activeRepoPath` is set
  // and nothing above it is, so writing the repo pointer outside a create would
  // silently turn selecting a lane into a navigation off the chat landing onto
  // RepoDashboard. Here the composer opens immediately after and outranks it.
  // A lane with no repo of its own leaves the pointer untouched — that is the
  // documented inheritance fallback (`activeSession ?? activeRepoPath ??
  // repos[0]`), and only add-project lanes carry an anchor.
  const applyWorkspaceLaneRouting = useCallback(
    (workspaceId: string | null) => {
      if (!workspaceId) return;
      const laneRepoPath = workspaces.find(
        (workspace) => workspace.id === workspaceId
      )?.defaultRepoPath;
      if (laneRepoPath) useUiStore.getState().setActiveRepoPath(laneRepoPath);
    },
    [workspaces]
  );
  const openCreateTaskRoom = useCallback(() => {
    const selectedTopic = selectedId ? topicsById.get(selectedId) : undefined;
    // #1287: the still-highlighted row may belong to a lane the operator has
    // since navigated away from (select a fresh, empty lane while a channel
    // from the old workspace stays selected). `applyTopicActiveContext` stamps
    // `activeWorkspaceId` from the topic, so re-applying it here would file the
    // new chat back in the OLD lane. An explicit lane selection is the more
    // recent intent and wins; when the row still lives in the active lane the
    // context (including repo/worktree inheritance) is applied as before.
    // Read the live pointer rather than the prop: `selectWorkspaceLane` writes
    // it straight to the store, so the prop can lag the operator's newest
    // lane choice within the same interaction.
    const activeLaneId = useUiStore.getState().activeWorkspaceId;
    const rowIsInActiveLane =
      activeLaneId === null || selectedTopic?.workspaceId === activeLaneId;
    if (rowIsInActiveLane) applyTopicActiveContext(selectedTopic);
    else applyWorkspaceLaneRouting(activeLaneId);
    onCreateTaskRoom?.();
  }, [applyWorkspaceLaneRouting, onCreateTaskRoom, selectedId, topicsById]);
  // #1287: a workspace lane is selectable in its own right, so a workspace
  // that holds no channels yet can still become the active one. Selecting a
  // channel inside a lane already does this through the topic's context; this
  // is the only path for an empty lane.
  const selectWorkspaceLane = useCallback((workspaceId: string) => {
    useUiStore.getState().setActiveWorkspaceId(workspaceId);
  }, []);
  // Start a chat in a specific lane: stamp the lane's real workspace id first,
  // because every create path (composer + DM) resolves its workspace from
  // `activeWorkspaceId`. Without this the chat would land in whatever lane was
  // selected last, and the empty lane could never fill. Then hand off to the
  // SAME `openCreateTaskRoom` the rail header uses, so both new-chat buttons
  // resolve lane-vs-row precedence and repo routing through one body instead of
  // two that can drift.
  const startChatInWorkspace = useCallback(
    (workspaceId: string) => {
      selectWorkspaceLane(workspaceId);
      openCreateTaskRoom();
    },
    [openCreateTaskRoom, selectWorkspaceLane]
  );
  // #1287 slice 5 item 18: open the channel AND its thread panel. The intent is
  // recorded after `select()` on purpose — opening a channel clears any pending
  // thread — and `ChannelView` adopts it once it is the channel on screen. No
  // URL segment: `activeThreadRootId` is session-transient by design (#1170), so
  // this rides item 9's `/channel/<id>` route without extending it.
  const openThread = useCallback(
    (channelId: string, rootMessageId: string) => {
      select(channelId);
      useUiStore
        .getState()
        .requestChannelThread(channelId, rootMessageId as ChannelMessageId);
    },
    [select]
  );
  const renderTopicRow = (node: ChannelRailNode): ReactNode => {
    const item = node.item;
    return (
      <TopicRow
        key={item.id}
        node={node}
        depth={0}
        expandedIds={expandedIds}
        selectedId={selectedId}
        statusByChannelAgent={effectiveStatusByChannelAgent}
        onToggle={toggle}
        onSelect={select}
        onSelectSession={onSelectSession}
        onOpenThread={openThread}
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
    leaveChatSurface();
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
      {/* #1287 slice 5 item 12: search and the older-chats toggle are DOM
          siblings of both breakpoints' lists, so their position in this column
          IS the mobile reading order. They render before the cockpit: on a
          phone the search field and its results are the first thing under the
          header instead of being buried past the attention lane, the session
          tree, and every channel row. Desktop is unchanged — the cockpit is
          `display: none` above 600px, so the visible desktop order stays
          header → search → older chats → tree. */}
      <TopicSearchPanel
        model={model}
        searchQuery={searchQuery}
        searchLoading={searchLoading}
        searchError={searchError}
        searchResults={searchResults}
        searchTruncated={searchTruncated}
        searchUnavailableReason={searchUnavailableReason}
        messageResults={messageResults}
        messageLoading={messageSearchLoading}
        messageError={messageSearchError}
        messageTruncated={messageSearchTruncated}
        messageUnavailableReason={messageSearchUnavailableReason}
        onSearchQueryChange={onSearchQueryChange}
        onSearchRetry={onSearchRetry}
        onSearchClear={onSearchClear}
        onOpenTopic={openSearchResult}
        onOpenMessage={openMessageResult}
        searchScope={searchScope}
        onToggleSearchScope={onToggleSearchScope}
        canScope={activeWorkspaceId != null}
        resumeTargetFor={searchResumeTargetFor}
      />
      <ArchivedToggle showArchived={showArchived} onToggle={onToggleArchived} />
      <TopicMobileCockpit
        tree={railTree}
        sessions={sessions}
        unreadByChannel={unreadByChannel}
        statusByChannelAgent={effectiveStatusByChannelAgent}
        mentionsMeByChannel={mentionsMeByChannel}
        rosterAttentionBySessionKey={rosterAttentionBySessionKey}
        selectedId={selectedId}
        onSelect={selectMobile}
        onNudge={postMobileNudge}
        onInterrupt={interruptMobileAgent}
        onSelectSession={onSelectSession}
        onSelectWorkspace={selectWorkspaceLane}
        {...(onCreateTaskRoom
          ? { onStartChatInWorkspace: startChatInWorkspace }
          : {})}
        {...(onCreateTaskRoom ? { onCreateTaskRoom: openCreateTaskRoom } : {})}
        {...(resumeLastSelectKey && onSelectSession
          ? { onResumeLast: () => onSelectSession(resumeLastSelectKey) }
          : {})}
      />
      <GroupedTopicTree
        tree={railTree}
        renderRow={renderTopicRow}
        onSelectWorkspace={selectWorkspaceLane}
        {...(onCreateTaskRoom
          ? { onStartChatInWorkspace: startChatInWorkspace }
          : {})}
      />
      <TopicAdvancedDetailGate
        item={selectedItem}
        sessions={sessions}
        show={advancedMode && showAdvancedDetail}
        workspaceNameById={workspaceNameById}
        surfacesError={surfacesError}
        surfacesLoading={surfacesLoading}
        onSelectSession={onSelectSession}
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
  const typedSearchQuery = searchQuery.trim();
  // ONE debounce for ONE input (#1308 slice 2 item 2). Both sections read this
  // settled value, so a keystroke costs one topic query and one message query,
  // and the two sections can never answer different prefixes of what the
  // operator typed. Sharing it is also why the pending window below is a single
  // flag: with a debounce per section, "searching…" would clear twice.
  const normalizedSearchQuery = useDebouncedValue(
    typedSearchQuery,
    SEARCH_DEBOUNCE_MS
  );
  // Still-typing counts as loading. Without it the panel renders a confident
  // "no matches" for the PREVIOUS settled query while a newer one is pending.
  const searchDebouncePending = typedSearchQuery !== normalizedSearchQuery;
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
      showArchived ? 'with-archived' : 'active-only',
    ],
    queryFn: () =>
      searchWorkspaceTopics({
        q: normalizedSearchQuery,
        limit: 20,
        includeArchived: showArchived,
        ...(scopedWorkspaceId ? { workspaceId: scopedWorkspaceId } : {}),
      }),
    enabled: normalizedSearchQuery.length > 0,
    staleTime: 10_000,
  });
  // #1308 slice 2: the `messages` section. `showArchived` rides the KEY, not
  // just the request — the #1288 lesson: two archive states sharing one key
  // serve the first answer to the second question, and the operator sees the
  // toggle do nothing.
  const messageSearchQuery = useQuery({
    queryKey: [
      'channel-message-search',
      normalizedSearchQuery,
      scopedWorkspaceId ?? 'all',
      showArchived ? 'with-archived' : 'active-only',
    ],
    queryFn: () =>
      searchChannelMessages({
        q: normalizedSearchQuery,
        // Same page size the chats section asks for: the sidebar is a jump
        // affordance, and 50 message rows under a 240px rail is a transcript.
        // The server's `truncated` flag then says "refine" rather than lying
        // about having found everything.
        limit: 20,
        includeArchived: showArchived,
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
  // Unread head seqs only arrive over `/ws/events` for channels that move while
  // the socket is open, so a reload would render every row as read. Seed them
  // from the channel list once the rail mounts (#1287). The same payload is a
  // full summary (members + last message) per channel, so it also hydrates every
  // sidebar row — one list call in place of the per-channel fan-out the mobile
  // cockpit used to run.
  const channelsQuery = useQuery({
    queryKey: ['channels'],
    queryFn: fetchChannels,
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });
  const channelRows = channelsQuery.data;
  const channelRowsFetchedAt = channelsQuery.dataUpdatedAt;
  useEffect(() => {
    if (!channelRows) return;
    useChannelActivityStore
      .getState()
      .seedChannelActivity(channelRows, channelRowsFetchedAt);
  }, [channelRows, channelRowsFetchedAt]);
  // Row snippets/stamps would otherwise freeze at the mount payload, so refresh
  // the list when channels move. Subscribed imperatively (never as a selector)
  // because the rail must not re-render on unrelated channel activity, and
  // trailing-edge throttled so a busy agent turn costs one refetch per window
  // instead of the removed per-channel history fetches.
  //
  // `GET /channels` is O(channels) server-side, so this lane is deliberately
  // BACKGROUND-SILENT: a hidden tab records the pending refresh and fires it
  // once on the way back to visible, instead of holding the hub at a steady
  // refetch cadence for the whole length of an agent turn nobody is watching.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let pendingWhileHidden = false;
    const documentRef = typeof document === 'undefined' ? null : document;
    const refresh = () => {
      void queryClient.invalidateQueries({ queryKey: ['channels'] });
    };
    const schedule = () => {
      if (documentRef?.hidden) {
        // Nothing is rendering these rows: remember the debt and arm no timer.
        pendingWhileHidden = true;
        return;
      }
      if (timer !== undefined) return;
      timer = setTimeout(() => {
        timer = undefined;
        if (documentRef?.hidden) {
          pendingWhileHidden = true;
          return;
        }
        refresh();
      }, CHANNEL_SUMMARY_REFRESH_THROTTLE_MS);
    };
    const onVisibilityChange = () => {
      if (documentRef?.hidden || !pendingWhileHidden) return;
      pendingWhileHidden = false;
      refresh();
    };
    documentRef?.addEventListener('visibilitychange', onVisibilityChange);
    const unsubscribe = useChannelActivityStore.subscribe((state, previous) => {
      if (state.latestSeqByChannel === previous.latestSeqByChannel) return;
      schedule();
    });
    return () => {
      unsubscribe();
      documentRef?.removeEventListener('visibilitychange', onVisibilityChange);
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [queryClient]);
  // The panel is "searching" from the first keystroke, so the sections mount
  // against what the operator typed rather than against the settled value.
  const searchActive = typedSearchQuery.length > 0;
  const searchSettled = normalizedSearchQuery.length > 0;
  const searchData = topicSearchQuery.data;
  const searchResults = useMemo(
    () => searchData?.results ?? EMPTY_SEARCH_RESULTS,
    [searchData]
  );
  const messageSearchData = messageSearchQuery.data;
  const messageResults = useMemo(
    () => messageSearchData?.results ?? EMPTY_MESSAGE_RESULTS,
    [messageSearchData]
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
      channelSummaries={channelRows ?? EMPTY_CHANNEL_SUMMARIES}
      activeWorkspaceId={activeWorkspaceId}
      searchScope={searchScope}
      onToggleSearchScope={() =>
        setSearchScope((scope) => (scope === 'all' ? 'workspace' : 'all'))
      }
      showArchived={showArchived}
      onToggleArchived={() => setShowArchived((prev) => !prev)}
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
      searchLoading={
        searchActive &&
        (searchDebouncePending ||
          (topicSearchQuery.isFetching && searchSettled))
      }
      searchError={topicSearchQuery.isError && searchSettled}
      searchResults={searchResults}
      searchTruncated={searchData?.truncated ?? false}
      searchUnavailableReason={searchData?.unavailableReason}
      messageResults={messageResults}
      messageSearchLoading={
        searchActive &&
        (searchDebouncePending ||
          (messageSearchQuery.isFetching && searchSettled))
      }
      messageSearchError={messageSearchQuery.isError && searchSettled}
      messageSearchTruncated={messageSearchData?.truncated ?? false}
      messageSearchUnavailableReason={messageSearchData?.unavailableReason}
      onSearchQueryChange={setSearchQuery}
      onSearchRetry={() => {
        void topicSearchQuery.refetch();
        void messageSearchQuery.refetch();
      }}
      onSearchClear={() => setSearchQuery('')}
      onSelectSession={onSelectSession}
      onCreateTaskRoom={openTopicTaskRoom}
      showAdvancedDetail={!(surfacesQuery.isLoading && !surfacesQuery.data)}
    />
  );
}

export default TopicSidebarShell;
