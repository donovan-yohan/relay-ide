import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ChannelMessagePart } from '../../../../shared/channel-chat-protocol.js';
import { builtInAgentProfileId } from '../../../../shared/agent-profile.js';
import type { AgentRole } from '../../../../shared/agent-roster.js';
import './ChannelView.css';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useChannelChatSocket } from '../../hooks/useChannelChatSocket.js';
import {
  fetchWorkspaceTopic,
  restoreWorkspaceTopic,
  fetchChannelRoster,
  designateChannelOrchestrator,
  interruptChannelAgent,
  HttpError,
  type ChannelAgentStatus,
} from '../../lib/api.js';
import { isDmChannel } from '../../lib/dm-channels.js';
import { resolveSenderIdentity } from '../../lib/chat/sender-identity.js';
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
import { AgentBadge } from '../AgentBadge.js';
import { TuiProgress } from '../TuiProgress.js';
import { ChannelTimeline } from './ChannelTimeline.js';
import { ChannelComposer } from './ChannelComposer.js';
import { ChannelThreadPanel } from './ChannelThreadPanel.js';

const READ_WRITE_VISIBLE_GRACE_MS = 10_000;
const AUTO_BACKFILL_MAX_ATTEMPTS = 3;
const AUTO_BACKFILL_RETRY_BASE_MS = 200;
const AUTO_BACKFILL_MAX_CURSOR_PAGES = 4;

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

  useEffect(() => {
    setActiveThreadRootId(null);
  }, [channelId, setActiveThreadRootId]);

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

  const archived =
    channel?.archived === true ||
    (postError instanceof HttpError && postError.status === 409);
  const storeDown = postError instanceof HttpError && postError.status === 503;

  const [restorePending, setRestorePending] = useState(false);
  const handleRestore = useCallback(async () => {
    setRestorePending(true);
    try {
      await restoreWorkspaceTopic(channelId);
      await queryClient.invalidateQueries({ queryKey: ['channel', channelId] });
      await queryClient.invalidateQueries({
        queryKey: ['workspace-topic', channelId],
      });
    } catch {
      /* leave the archived bar in place; the user can retry */
    } finally {
      setRestorePending(false);
    }
  }, [channelId, queryClient]);

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

  const hasHistory =
    reducer.messages.length > 0 || hasMoreOlder || loadingOlder;

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
            />
          ) : (
            <div className="ch-empty">
              <span>{emptyCopy}</span>
            </div>
          )}

          <ChannelComposer
            channelId={channelId}
            channelTitle={title}
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
