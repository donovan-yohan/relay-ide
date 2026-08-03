import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type {
  ChannelMessage,
  ChannelMessageId,
  ChannelMessagePart,
} from '../../../../shared/channel-chat-protocol.js';
import { builtInAgentProfileId } from '../../../../shared/agent-profile.js';
import type { AgentRole } from '../../../../shared/agent-roster.js';
import './ChannelView.css';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useChannelChatSocket } from '../../hooks/useChannelChatSocket.js';
import {
  fetchWorkspaceTopic,
  fetchChannelRoster,
  designateChannelOrchestrator,
  deleteChannelMessage,
  editChannelMessage,
  interruptChannelAgent,
  retryChannelMessage,
  HttpError,
  type ChannelAgentStatus,
} from '../../lib/api.js';
import { isArchivedChannelPostError } from '../../lib/agent-channels.js';
import { useRestoreTopicMutation } from '../../lib/hooks/use-restore-topic.js';
import { isDmChannel } from '../../lib/dm-channels.js';
import { resolveSenderIdentity } from '../../lib/chat/sender-identity.js';
import { selectChannelAgentPresence } from '../../lib/chat/channel-agent-presence.js';
import { useStreamingPresenceHold } from './useStreamingPresenceHold.js';
import {
  channelLastReadKey,
  useChannelActivityStore,
} from '../../lib/stores/channel-activity.js';
import {
  channelAgentStatusKey,
  resolveEffectiveAgentStatus,
  useChannelAgentStatusStore,
} from '../../lib/stores/channel-agent-status.js';
import { useUiStore } from '../../lib/stores/ui.js';
import { showToast } from '../../lib/stores/toasts.js';
import { AgentBadge } from '../AgentBadge.js';
import { TuiProgress } from '../TuiProgress.js';
import { ChannelTimeline, type TimelineJumpTarget } from './ChannelTimeline.js';
import { ChannelComposer } from './ChannelComposer.js';
import { ChannelThreadPanel } from './ChannelThreadPanel.js';

const READ_WRITE_VISIBLE_GRACE_MS = 10_000;
const AUTO_BACKFILL_MAX_ATTEMPTS = 3;
const AUTO_BACKFILL_RETRY_BASE_MS = 200;
const AUTO_BACKFILL_MAX_CURSOR_PAGES = 4;
/**
 * #1308 item 1: how many older-history pages a `#msg-…` deep link may pull
 * before it gives up. Unbounded, a link to a deleted/foreign message id would
 * walk the channel to seq 1 on every open; bounded, the worst case is a fixed
 * number of page fetches and one toast.
 */
const ANCHOR_WALK_MAX_PAGES = 8;

interface ChannelViewProps {
  channelId: string;
}

export const ChannelView: React.FC<ChannelViewProps> = ({ channelId }) => {
  const {
    channel,
    reducer,
    connected,
    disconnected,
    notFound,
    hasMoreOlder,
    loadingOlder,
    loadOlder,
    fullSnapshotRevision,
    post,
    postPending,
    postError,
    resync,
  } = useChannelChatSocket(channelId);
  const queryClient = useQueryClient();
  const setActiveChannelId = useUiStore((s) => s.setActiveChannelId);
  const activeThreadRootId = useUiStore((s) => s.activeThreadRootId);
  const setActiveThreadRootId = useUiStore((s) => s.setActiveThreadRootId);
  const pendingChannelThread = useUiStore((s) => s.pendingChannelThread);

  useEffect(() => {
    setActiveThreadRootId(null);
  }, [channelId, setActiveThreadRootId]);

  // #1287 slice 5 item 18: adopt a thread the rail asked us to open. Kept
  // separate from (and ordered after) the reset above so both a cold open —
  // where the reset fires on mount — and a re-open of the channel already on
  // screen land the panel. Watching the store value rather than reading it once
  // is what makes the second case work: `channelId` never changes there, so an
  // effect keyed on it alone would never re-run.
  useEffect(() => {
    if (pendingChannelThread?.channelId !== channelId) return;
    setActiveThreadRootId(pendingChannelThread.rootMessageId);
    useUiStore.getState().consumeChannelThreadIntent(channelId);
  }, [channelId, pendingChannelThread, setActiveThreadRootId]);

  // Self-derive DM-ness: ChannelSummaryView does not expose routingDefaults, so
  // fetch the topic (cached) and run the pure id derivation. Cheaper than
  // threading an isDm prop through every caller (spec §7.2, logged deviation).
  const topicQuery = useQuery({
    queryKey: ['workspace-topic', channelId],
    queryFn: () => fetchWorkspaceTopic(channelId),
    staleTime: 30_000,
    retry: false,
  });
  const dmProviderId = topicQuery.data ? isDmChannel(topicQuery.data) : null;
  const isDm = dmProviderId !== null;
  const dmIdentity = dmProviderId
    ? resolveSenderIdentity({
        kind: 'agent',
        // A DM targets a vendor, i.e. its DEFAULT profile — key on the profile
        // Actor id so it keeps the curated vendor token (#1234).
        id: builtInAgentProfileId(dmProviderId),
        providerId: dmProviderId,
      })
    : null;

  // A DM addresses its one agent implicitly — the binder routes an unmentioned
  // message to it — so the composer must not tell you to type `@` at the very
  // agent the header already says you are talking to.
  const dmPlaceholder =
    isDm && dmIdentity
      ? `message @${dmIdentity.label}…  ·  shift+enter for newline`
      : null;

  const title = channel?.title ?? topicQuery.data?.display.title ?? channelId;

  // Unread line: captured once on mount (per channelId, since ChatHome keys this
  // component by channelId). Absent marker → null → no unread line drawn.
  const [lastReadSeq] = useState<number | null>(() => {
    try {
      const raw = localStorage.getItem(channelLastReadKey(channelId));
      return raw !== null ? Number(raw) : null;
    } catch {
      return null;
    }
  });

  // Write the last-read marker on unmount (channel closed/navigated) and on a
  // focus-loss after a 10s-visible grace, mirroring Slack's read semantics.
  const lastSeqRef = useRef(0);
  lastSeqRef.current = reducer.lastSeq;
  useEffect(() => {
    const mountedAt =
      typeof performance !== 'undefined' ? performance.now() : Date.now();
    const now = (): number =>
      typeof performance !== 'undefined' ? performance.now() : Date.now();
    const write = (): void => {
      if (lastSeqRef.current <= 0) return;
      // Reactive store write (not a raw localStorage set) so the sidebar's
      // unread dot recomputes the moment this channel is read (#1178). The store
      // mirrors the value to localStorage for cross-reload persistence.
      useChannelActivityStore
        .getState()
        .markChannelRead(channelId, lastSeqRef.current);
    };
    const onVisibility = (): void => {
      if (document.hidden && now() - mountedAt > READ_WRITE_VISIBLE_GRACE_MS) {
        write();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      write();
    };
  }, [channelId]);

  // #1287 item 8: a bare 409 from the post path is NOT proof the channel is
  // archived — `isArchivedChannelPostError` reads the reason code, and it is
  // shared with the launch path so both surfaces agree on what "archived" is.
  const archived =
    channel?.archived === true || isArchivedChannelPostError(postError);
  const storeDown = postError instanceof HttpError && postError.status === 503;

  // Shared with every other restore affordance (#1287) so one restore refreshes
  // the channel, its topic, and every topic list — and a failure toasts instead
  // of leaving the archived bar sitting there with no explanation.
  const { mutate: restoreChannel, isPending: restorePending } =
    useRestoreTopicMutation();
  const handleRestore = useCallback(() => {
    restoreChannel(channelId);
  }, [channelId, restoreChannel]);

  const [designatePending, setDesignatePending] = useState(false);

  const handleSend = useCallback(
    async (
      text: string,
      clientMessageId: string,
      parts: ChannelMessagePart[]
    ) => {
      await post(text, { clientMessageId, parts });
    },
    [post]
  );

  const handleThreadSend = useCallback(
    async (
      text: string,
      clientMessageId: string,
      parts: ChannelMessagePart[]
    ) => {
      if (activeThreadRootId === null) return;
      await post(text, {
        clientMessageId,
        threadId: activeThreadRootId,
        parts,
      });
    },
    [activeThreadRootId, post]
  );

  const hasTopLevelMessages = reducer.messages.some(
    (message) => message.threadId === null
  );
  const earliestSeq = reducer.messages[0]?.seq;
  const [replyOnlyBackfillPaused, setReplyOnlyBackfillPaused] = useState(false);
  const [backfillContinuation, setBackfillContinuation] = useState(0);
  const autoBackfillRef = useRef<{
    channelId: string;
    cursorKey: string | null;
    cursorPages: number;
    attempts: number;
    retryTimer: ReturnType<typeof setTimeout> | null;
  }>({
    channelId,
    cursorKey: null,
    cursorPages: 0,
    attempts: 0,
    retryTimer: null,
  });
  useEffect(() => {
    const state = autoBackfillRef.current;
    const clearRetry = (): void => {
      if (state.retryTimer !== null) clearTimeout(state.retryTimer);
      state.retryTimer = null;
    };
    if (state.channelId !== channelId) {
      clearRetry();
      state.channelId = channelId;
      state.cursorKey = null;
      state.cursorPages = 0;
      state.attempts = 0;
      setReplyOnlyBackfillPaused(false);
    }
    if (hasTopLevelMessages || !hasMoreOlder) {
      clearRetry();
      state.cursorKey = null;
      state.cursorPages = 0;
      state.attempts = 0;
      setReplyOnlyBackfillPaused(false);
      return;
    }
    if (loadingOlder) return;
    if (earliestSeq === undefined) return;
    const cursorKey = `${channelId}:${earliestSeq}`;
    if (state.cursorKey !== cursorKey) {
      clearRetry();
      if (state.cursorPages >= AUTO_BACKFILL_MAX_CURSOR_PAGES) {
        setReplyOnlyBackfillPaused(true);
        return;
      }
      state.cursorKey = cursorKey;
      state.cursorPages += 1;
      state.attempts = 0;
      setReplyOnlyBackfillPaused(false);
    }
    if (
      state.retryTimer !== null ||
      state.attempts >= AUTO_BACKFILL_MAX_ATTEMPTS
    ) {
      return;
    }
    if (state.attempts === 0) {
      state.attempts = 1;
      void loadOlder();
      return;
    }
    const delay = AUTO_BACKFILL_RETRY_BASE_MS * 2 ** (state.attempts - 1);
    state.retryTimer = setTimeout(() => {
      if (state.cursorKey !== cursorKey) return;
      state.retryTimer = null;
      state.attempts += 1;
      void loadOlder();
    }, delay);
  }, [
    backfillContinuation,
    channelId,
    earliestSeq,
    hasMoreOlder,
    hasTopLevelMessages,
    loadOlder,
    loadingOlder,
  ]);

  const continueReplyOnlyBackfill = useCallback(() => {
    const state = autoBackfillRef.current;
    if (state.retryTimer !== null) clearTimeout(state.retryTimer);
    state.retryTimer = null;
    state.cursorKey = null;
    state.cursorPages = 0;
    state.attempts = 0;
    setReplyOnlyBackfillPaused(false);
    setBackfillContinuation((value) => value + 1);
  }, []);

  useEffect(
    () => () => {
      const timer = autoBackfillRef.current.retryTimer;
      if (timer !== null) clearTimeout(timer);
    },
    []
  );

  // ── Deep-link message anchor (#1308 item 1) ────────────────────────────────
  // A `/channel/<id>#msg-<messageId>` link lands here as a store intent. The
  // target may be far outside the loaded window, so resolving it is a bounded
  // walk backwards through history rather than a single lookup; the timeline
  // only ever receives a target it can already render.
  const pendingChannelMessage = useUiStore((s) => s.pendingChannelMessage);
  const [anchorWalk, setAnchorWalk] = useState<{
    messageId: ChannelMessageId;
    pages: number;
  } | null>(null);
  const [jumpTarget, setJumpTarget] = useState<TimelineJumpTarget | null>(null);
  const jumpTokenRef = useRef(0);
  const anchorLoadingRef = useRef(false);

  // Drop an in-flight walk when the channel changes: its message id belongs to
  // the channel that is leaving, and the new one's history would never match.
  // Declared BEFORE the adopt effect so a channel switch that also carries an
  // anchor resets first and adopts second — the other order would erase the
  // anchor it had just accepted (effects run in declaration order).
  useEffect(() => {
    anchorLoadingRef.current = false;
    setAnchorWalk(null);
    setJumpTarget(null);
  }, [channelId]);

  useEffect(() => {
    if (pendingChannelMessage?.channelId !== channelId) return;
    setAnchorWalk({ messageId: pendingChannelMessage.messageId, pages: 0 });
    useUiStore.getState().consumeChannelMessageIntent(channelId);
  }, [channelId, pendingChannelMessage]);

  const [anchorWalkTick, setAnchorWalkTick] = useState(0);
  useEffect(() => {
    if (anchorWalk === null) return;
    const target = reducer.messages.find(
      (message) => message.id === anchorWalk.messageId
    );
    if (target) {
      setAnchorWalk(null);
      jumpTokenRef.current += 1;
      // A reply's row lives in the thread panel, not the main lane. Open the
      // thread and put the emphasis on its root, which IS a main-lane row —
      // otherwise the link resolves to a scroll that finds nothing.
      if (target.threadId !== null) setActiveThreadRootId(target.threadId);
      setJumpTarget({
        messageId: target.threadId ?? target.id,
        token: jumpTokenRef.current,
      });
      return;
    }
    if (anchorLoadingRef.current || loadingOlder) return;
    // Cold boot is the primary case for this feature: a pasted
    // `/channel/<id>#msg-…` link writes the intent BEFORE this component
    // mounts, so the adopt effect above fires on the first commit — while
    // `reducer.messages` is still `[]` and `hasMoreOlder` is still its `false`
    // default (it is only ever set from the WS snapshot's `truncated` flag).
    // "No older history" is not an answer until the channel has actually
    // answered: hold the walk until the first full snapshot lands.
    if (fullSnapshotRevision === 0) return;
    if (!hasMoreOlder || anchorWalk.pages >= ANCHOR_WALK_MAX_PAGES) {
      setAnchorWalk(null);
      showToast('that message is not in this chat’s recent history', 'info');
      return;
    }
    anchorLoadingRef.current = true;
    setAnchorWalk((walk) =>
      walk === null ? null : { ...walk, pages: walk.pages + 1 }
    );
    void loadOlder()
      .catch(() => {})
      .finally(() => {
        anchorLoadingRef.current = false;
        setAnchorWalkTick((tick) => tick + 1);
      });
  }, [
    anchorWalk,
    anchorWalkTick,
    fullSnapshotRevision,
    hasMoreOlder,
    loadOlder,
    loadingOlder,
    reducer.messages,
    setActiveThreadRootId,
  ]);

  // The jump is one-shot: `jumpTarget` is what forces a collapsed system run
  // open and paints the emphasis, so leaving it set for the lifetime of the
  // channel view would pin that run open (the summary's toggle would have no
  // visible effect). The timeline calls this once the jump has been consumed.
  const handleJumpConsumed = useCallback(() => setJumpTarget(null), []);

  // Agent presence chips (#1167). One chip per agent that is bound (roster
  // binding) OR currently non-idle in the live status store, with a `streaming`
  // fallback derived from the timeline reducer so the header degrades gracefully
  // if the events socket lags.
  const rosterChipsQuery = useQuery({
    queryKey: ['channel-roster', channelId],
    queryFn: () => fetchChannelRoster(channelId),
    staleTime: 30_000,
    retry: false,
  });
  const statusMap = useChannelAgentStatusStore((s) => s.statusByChannelAgent);
  const statusUpdatedAtMap = useChannelAgentStatusStore(
    (s) => s.updatedAtByChannelAgent
  );

  // On channel switch, drop this channel's per-agent socket statuses so the
  // freshly-fetched roster is authoritative on open; live transitions repopulate
  // as they arrive. Without this the previously dead `clearChannel` reconciliation
  // never ran and a stale busy chip could survive a channel round-trip (#1167).
  useEffect(() => {
    const { clearChannel } = useChannelAgentStatusStore.getState();
    clearChannel(channelId);
    return () => clearChannel(channelId);
  }, [channelId]);

  const streamingProfileProviders = useMemo(() => {
    const providers = new Map<string, string | undefined>();
    for (const message of reducer.messages) {
      if (message.status !== 'streaming' || message.sender.kind !== 'agent')
        continue;
      // Agent sender ids are profile Actor ids. Keep stream state in the same
      // identity namespace as roster/status rather than collapsing profiles by
      // provider.
      providers.set(message.sender.id, message.sender.providerId);
    }
    return providers;
  }, [reducer.messages]);

  // Presence suppression keys on MAIN-LANE streaming rows only. `ChannelTimeline`
  // renders `selectTopLevel(messages)`, so an agent streaming a reply inside a
  // thread draws its block cursor in the thread panel — the main lane shows
  // nothing and must still announce "X is responding…" (#1277 review).
  const topLevelStreamingAgentIds = useMemo(() => {
    const ids = new Set<string>();
    for (const message of reducer.messages) {
      if (message.status !== 'streaming' || message.sender.kind !== 'agent')
        continue;
      if (message.threadId !== null) continue;
      ids.add(message.sender.id);
    }
    return ids;
  }, [reducer.messages]);

  const rosterUpdatedAt = rosterChipsQuery.dataUpdatedAt;
  const agentChips = useMemo(() => {
    const roster = rosterChipsQuery.data ?? [];
    const rosterById = new Map(roster.map((entry) => [entry.id, entry]));
    const candidateIds = new Set<string>();
    for (const entry of roster) {
      if (entry.binding != null) candidateIds.add(entry.id);
    }
    const prefix = `${channelId} `;
    for (const key of Object.keys(statusMap)) {
      if (key.startsWith(prefix)) candidateIds.add(key.slice(prefix.length));
    }
    for (const profileId of streamingProfileProviders.keys())
      candidateIds.add(profileId);

    const chips: Array<{
      agentId: string;
      status: ChannelAgentStatus;
      role?: AgentRole;
      identity: ReturnType<typeof resolveSenderIdentity>;
    }> = [];
    for (const agentId of candidateIds) {
      const entry = rosterById.get(agentId);
      const key = channelAgentStatusKey(channelId, agentId);
      const streaming = streamingProfileProviders.has(agentId);
      const status = resolveEffectiveAgentStatus({
        socketStatus: statusMap[key],
        socketUpdatedAt: statusUpdatedAtMap[key],
        rosterStatus: entry?.binding?.status,
        rosterUpdatedAt,
        streaming,
      });
      // Show a chip for a bound agent (even when idle) or one that is currently
      // active/streaming — but drop an unbound agent whose only signal is a stale
      // socket status the roster has since superseded to idle.
      if (entry?.binding == null && status === 'idle' && !streaming) continue;
      const providerId =
        entry?.providerId ?? streamingProfileProviders.get(agentId);
      const identity = resolveSenderIdentity({
        kind: 'agent',
        id: agentId,
        ...(providerId ? { providerId } : {}),
        ...(entry?.displayName ? { displayName: entry.displayName } : {}),
      });
      chips.push({
        agentId,
        status,
        ...(entry?.role ? { role: entry.role } : {}),
        identity,
      });
    }
    return chips;
  }, [
    rosterChipsQuery.data,
    rosterUpdatedAt,
    statusMap,
    statusUpdatedAtMap,
    streamingProfileProviders,
    channelId,
  ]);

  // In-timeline presence rows (#1277). Same chip signal, so a reload rebuilds
  // the rows from `resolveEffectiveAgentStatus` for free — no new WS event. The
  // suppression set is "owns a live main-lane streaming row", plus a trailing
  // hold so the gap between two assistant items of one turn does not strobe the
  // row in and out.
  const presenceSuppression = useStreamingPresenceHold(
    topLevelStreamingAgentIds
  );
  const agentPresence = useMemo(
    () => selectChannelAgentPresence(agentChips, presenceSuppression),
    [agentChips, presenceSuppression]
  );

  // #1308 item 2 storm brake, client half. Same `agentChips` signal the presence
  // rows use, so the disabled state cannot disagree with what the header says
  // the agent is doing. The server refuses independently — this only keeps the
  // operator from firing a request that is already known to be rejected.
  const busyAgentIds = useMemo(() => {
    const ids = new Set<string>();
    for (const chip of agentChips) {
      if (chip.status !== 'idle') ids.add(chip.agentId);
    }
    return ids;
  }, [agentChips]);

  // Wired only while the channel is live, exactly like edit/delete below: a
  // retry re-runs a turn against an archived (read-only) channel, so the route
  // refuses it with CHANNEL_ARCHIVED and offering the button would be dead.
  const handleRetryMessage = useCallback(
    async (message: ChannelMessage) => {
      try {
        await retryChannelMessage(channelId, message.id);
      } catch (error) {
        // 409 is the storm brake (agent busy) or an unretryable row; both are
        // operator-legible states rather than faults, so they get the message
        // the server sent instead of a generic failure.
        showToast(
          error instanceof HttpError && error.status === 409
            ? 'could not retry — the agent is busy'
            : 'could not retry this message'
        );
      }
    },
    [channelId]
  );

  // #1308 item 3. Wired only while the channel is live — an archived channel is
  // read-only (its composer is already a restore bar), so offering an edit the
  // route would refuse with CHANNEL_ARCHIVED is a dead affordance. The edited row
  // arrives back through the socket
  // (`channel-message-edited-v1`), so nothing is applied optimistically here —
  // same discipline as posting. Rethrown so the row keeps the operator's draft
  // on screen instead of closing over a failed write.
  const handleEditMessage = useCallback(
    async (message: ChannelMessage, text: string) => {
      try {
        await editChannelMessage(channelId, message.id, text);
      } catch (error) {
        showToast(
          error instanceof HttpError && error.status === 409
            ? 'could not edit — this message is no longer editable'
            : 'could not edit this message'
        );
        throw error;
      }
    },
    [channelId]
  );

  // #1308 item 4. Same wiring rule as the edit lane: live channels only, no
  // optimistic apply (the tombstone arrives through
  // `channel-message-deleted-v1`), rethrown so the row's confirm stays open on a
  // failed write instead of pretending the row is gone.
  const handleDeleteMessage = useCallback(
    async (message: ChannelMessage) => {
      try {
        await deleteChannelMessage(channelId, message.id);
      } catch (error) {
        showToast(
          error instanceof HttpError && error.status === 409
            ? 'could not delete — this message is no longer deletable'
            : 'could not delete this message'
        );
        throw error;
      }
    },
    [channelId]
  );

  const handleInterruptAgent = useCallback(
    (agentId: string) => {
      // 404 (no live binding) / 409 (NO_ACTIVE_TURN) both mean "already idle" —
      // swallow so a race between the click and the agent finishing is silent.
      void interruptChannelAgent(channelId, agentId).catch(() => {});
    },
    [channelId]
  );

  const handleDesignateOrchestrator = useCallback(async () => {
    setDesignatePending(true);
    try {
      await designateChannelOrchestrator(channelId);
      await queryClient.invalidateQueries({
        queryKey: ['channel-roster', channelId],
      });
    } catch {
      // Keep the affordance available for a retry; API errors stay local to this
      // operator control just as interrupt races do.
    } finally {
      setDesignatePending(false);
    }
  }, [channelId, queryClient]);

  const hasOrchestrator = agentChips.some(
    (chip) => chip.role === 'orchestrator'
  );

  const channelNotFound =
    notFound ||
    (topicQuery.error instanceof HttpError && topicQuery.error.status === 404);

  const emptyCopy = useMemo(() => {
    if (isDm && dmIdentity)
      return `no messages yet — say hi to ${dmIdentity.label}`;
    return 'no messages yet';
  }, [isDm, dmIdentity]);

  if (channelNotFound) {
    return (
      <div className="ch-view" role="main" aria-label="channel">
        <div className="ch-unavailable">
          <span>this chat no longer exists</span>
          <button
            type="button"
            className="ch-back-btn"
            onClick={() => setActiveChannelId(null)}
          >
            back to chat
          </button>
        </div>
      </div>
    );
  }

  // Live presence mounts the timeline even with zero history so a DM's very
  // first turn shows "<agent> is thinking…" instead of the static empty state
  // (#1277). Smaller diff than duplicating the row inside `.ch-empty`, and the
  // empty copy comes back the moment every agent goes idle again.
  const hasHistory =
    reducer.messages.length > 0 ||
    hasMoreOlder ||
    loadingOlder ||
    agentPresence.length > 0;

  return (
    <div className="ch-view" role="main" aria-label="channel">
      <div className="ch-header">
        {isDm && dmIdentity?.glyph ? (
          <span
            className="ch-header__glyph"
            style={{ color: dmIdentity.colorVar }}
            aria-hidden="true"
          >
            <AgentBadge agent={dmIdentity.glyph} />
          </span>
        ) : null}
        <span className="ch-header__title">
          {isDm && dmIdentity ? `@${dmIdentity.label}` : `#${title}`}
        </span>
        {!isDm && channel ? (
          <span className="ch-header__meta">
            · {channel.members.length} member
            {channel.members.length === 1 ? '' : 's'}
          </span>
        ) : null}
        {agentChips.length > 0 ? (
          <span className="ch-header__agents" aria-label="active agents">
            {agentChips.map((chip) => {
              const canInterrupt =
                chip.status === 'streaming' ||
                chip.status === 'thinking' ||
                chip.status === 'waiting';
              return (
                <span
                  key={chip.agentId}
                  className={`ch-agent-chip ch-agent-chip--${chip.status}`}
                  title={`${chip.identity.label}${
                    chip.role ? ` · ${chip.role}` : ''
                  } · ${chip.status}`}
                >
                  {chip.identity.glyph ? (
                    <span
                      className="ch-agent-chip__glyph"
                      style={{ color: chip.identity.colorVar }}
                      aria-hidden="true"
                    >
                      <AgentBadge agent={chip.identity.glyph} />
                    </span>
                  ) : null}
                  <span className="ch-agent-chip__dot" aria-hidden="true" />
                  <span className="ch-agent-chip__name">
                    {chip.identity.label}
                  </span>
                  {chip.role === 'orchestrator' ? (
                    <span className="ch-agent-chip__role">orchestrator</span>
                  ) : null}
                  {canInterrupt ? (
                    <button
                      type="button"
                      className="ch-agent-chip__stop"
                      aria-label={`interrupt ${chip.identity.label}`}
                      title="interrupt"
                      onClick={() => handleInterruptAgent(chip.agentId)}
                    >
                      ■
                    </button>
                  ) : null}
                </span>
              );
            })}
          </span>
        ) : null}
        {rosterChipsQuery.isSuccess && !hasOrchestrator ? (
          <button
            type="button"
            className="ch-designate-orchestrator"
            onClick={() => void handleDesignateOrchestrator()}
            disabled={designatePending}
          >
            {designatePending ? (
              <>
                <TuiProgress
                  variant="braille"
                  className="ch-designate-orchestrator__progress"
                />{' '}
                designating
              </>
            ) : (
              'designate orchestrator'
            )}
          </button>
        ) : null}
        <span className="ch-header__spacer" />
        {disconnected ? (
          // Reconnect gave up (server outage/deploy > backoff budget). Surface a
          // manual affordance — NOT gated on needsCatchup, which can never flip
          // true while the socket is dead (#1178).
          <button
            type="button"
            className="ch-reconnect-btn"
            onClick={resync}
            title="disconnected — reconnect"
          >
            reconnect
          </button>
        ) : null}
        <span
          className={`ch-conn-dot${connected ? ' ch-conn-dot--on' : ''}${
            disconnected ? ' ch-conn-dot--off' : ''
          }`}
          title={
            connected
              ? 'connected'
              : disconnected
                ? 'disconnected'
                : 'reconnecting'
          }
          aria-label={
            connected
              ? 'connected'
              : disconnected
                ? 'disconnected'
                : 'reconnecting'
          }
        />
      </div>

      <div className="ch-body">
        <div className="ch-main">
          {hasHistory ? (
            <ChannelTimeline
              messages={reducer.messages}
              lastReadSeq={lastReadSeq}
              channelId={channelId}
              channelTitle={title}
              hasMoreOlder={hasMoreOlder}
              loadingOlder={loadingOlder}
              loadOlder={loadOlder}
              fullSnapshotRevision={fullSnapshotRevision}
              needsCatchup={reducer.needsCatchup}
              onResync={resync}
              replyOnlyBackfillPaused={replyOnlyBackfillPaused}
              onContinueHistory={continueReplyOnlyBackfill}
              onOpenThread={setActiveThreadRootId}
              agentPresence={agentPresence}
              jumpTarget={jumpTarget}
              onJumpConsumed={handleJumpConsumed}
              {...(archived
                ? {}
                : {
                    // Retry belongs with edit/delete, not outside the fence: it
                    // writes a durable system row and appends a whole new agent
                    // turn, which the route now refuses with CHANNEL_ARCHIVED.
                    onRetryMessage: handleRetryMessage,
                    onEditMessage: handleEditMessage,
                    onDeleteMessage: handleDeleteMessage,
                  })}
              busyAgentIds={busyAgentIds}
            />
          ) : (
            <div className="ch-empty">
              <span>{emptyCopy}</span>
            </div>
          )}

          <ChannelComposer
            channelId={channelId}
            channelTitle={title}
            {...(dmPlaceholder ? { placeholder: dmPlaceholder } : {})}
            {...(channel?.members ? { members: channel.members } : {})}
            onSend={handleSend}
            postPending={postPending}
            storeDown={storeDown}
            archived={archived}
            onRestore={handleRestore}
            restorePending={restorePending}
          />
        </div>

        {activeThreadRootId !== null ? (
          <ChannelThreadPanel
            key={activeThreadRootId}
            channelId={channelId}
            channelTitle={title}
            isDm={isDm}
            rootId={activeThreadRootId}
            liveMessages={reducer.messages}
            onClose={() => setActiveThreadRootId(null)}
            onSend={handleThreadSend}
            postPending={postPending}
            storeDown={storeDown}
            archived={archived}
            onRestore={handleRestore}
            restorePending={restorePending}
            fullSnapshotRevision={fullSnapshotRevision}
          />
        ) : null}
      </div>
    </div>
  );
};

export default ChannelView;
