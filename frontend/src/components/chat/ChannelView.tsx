import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type {
  ChannelMessage,
  ChannelMessageId,
  ChannelMessagePart,
  ChannelPostSteering,
} from '../../../../shared/channel-chat-protocol.js';
import { builtInAgentProfileId } from '../../../../shared/agent-profile.js';
import type { AgentRole } from '../../../../shared/agent-roster.js';
import './ChannelView.css';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useChannelChatSocket } from '../../hooks/useChannelChatSocket.js';
import {
  fetchWorkspaceTopic,
  updateWorkspaceTopic,
  createChannelThread,
  renameChannelThread,
  fetchChannelRoster,
  designateChannelOrchestrator,
  deleteChannelMessage,
  editChannelMessage,
  interruptChannelAgent,
  restartChannelAgentRuntimes,
  retryChannelMessage,
  HttpError,
  type ChannelAgentStatus,
  type RosterEntry,
} from '../../lib/api.js';
import { isArchivedChannelPostError } from '../../lib/agent-channels.js';
import { useArchiveTopicMutation } from '../../lib/hooks/use-archive-topic.js';
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
  resolveEffectiveQueuedCount,
  shouldPollRosterForPresence,
  useChannelAgentStatusStore,
} from '../../lib/stores/channel-agent-status.js';
import {
  queuedSendCopy,
  snapshotQueueDrainSeqs,
  useChannelQueuedSendsStore,
} from '../../lib/stores/channel-queued-sends.js';
import { useUiStore } from '../../lib/stores/ui.js';
import { useChannelActivityPresentationStore } from '../../lib/stores/channel-activity-presentation.js';
import {
  resolvedChannelSearchAlias,
  useChannelSearchPanelStore,
} from '../../lib/stores/channel-search-panel.js';
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
const DESIGNATE_ORCHESTRATOR_ROLE_CONFLICT =
  'channel already has a non-orchestrator agent bound';
const DESIGNATE_ORCHESTRATOR_GENERIC_ERROR =
  'could not designate orchestrator — try again';

function implicitCommandProviderForDm(
  providerId: string | null
): string | undefined {
  return providerId ?? undefined;
}

function designateOrchestratorErrorCopy(error: unknown): string {
  if (
    error instanceof HttpError &&
    (error.code === 'SESSION_CONFLICT' ||
      error.details?.['reasonCode'] === 'CHANNEL_ROLE_CONFLICT')
  ) {
    return DESIGNATE_ORCHESTRATOR_ROLE_CONFLICT;
  }

  return DESIGNATE_ORCHESTRATOR_GENERIC_ERROR;
}

function ChannelArchiveControl({
  channelId,
  archived,
  busyAgentCount,
  rosterStatus,
}: {
  channelId: string;
  archived: boolean;
  busyAgentCount: number;
  rosterStatus: 'pending' | 'error' | 'ready';
}) {
  const queryClient = useQueryClient();
  const setActiveChannelId = useUiStore((s) => s.setActiveChannelId);
  const {
    mutateAsync: archiveChannel,
    isPending: archivePending,
    isError: archiveFailed,
    error: archiveError,
    reset: resetArchive,
  } = useArchiveTopicMutation();
  const [confirming, setConfirming] = useState(false);
  const [freshCheckPending, setFreshCheckPending] = useState(false);
  const [freshCheckBlock, setFreshCheckBlock] = useState<string | null>(null);
  const currentChannelIdRef = useRef<string | null>(channelId);
  const archiveTriggerRef = useRef<HTMLButtonElement>(null);
  const confirmButtonRef = useRef<HTMLButtonElement>(null);
  const restoreTriggerFocusRef = useRef(false);

  useEffect(() => {
    currentChannelIdRef.current = channelId;
    setConfirming(false);
    setFreshCheckPending(false);
    setFreshCheckBlock(null);
    resetArchive();
    return () => {
      if (currentChannelIdRef.current === channelId) {
        currentChannelIdRef.current = null;
      }
    };
  }, [channelId, resetArchive]);

  useLayoutEffect(() => {
    if (confirming) {
      confirmButtonRef.current?.focus();
      return;
    }
    if (restoreTriggerFocusRef.current) {
      restoreTriggerFocusRef.current = false;
      archiveTriggerRef.current?.focus();
    }
  }, [confirming]);

  if (archived) return null;

  // Fail closed until the authoritative roster lands: offering archive during
  // the initial query (or after a roster failure) creates a click window where
  // a bound busy runtime exists but the header has not learned about it yet.
  const blocked = rosterStatus !== 'ready' || busyAgentCount > 0;
  let blockedCopy = '';
  let blockedTitle = '';
  if (rosterStatus === 'pending') {
    blockedCopy = 'archive unavailable · checking agents';
    blockedTitle = 'checking bound agent status before archiving';
  } else if (rosterStatus === 'error') {
    blockedCopy = 'archive unavailable · agent status unknown';
    blockedTitle = 'agent status is unavailable; retry before archiving';
  } else if (busyAgentCount > 0) {
    blockedCopy =
      busyAgentCount === 1
        ? 'archive unavailable · agent active'
        : `archive unavailable · ${busyAgentCount} agents active`;
    blockedTitle = 'wait for every bound agent to become idle before archiving';
  }

  const confirmArchive = async (): Promise<void> => {
    if (blocked || archivePending || freshCheckPending) return;
    const requestedChannelId = channelId;
    const isCurrentChannel = () =>
      currentChannelIdRef.current === requestedChannelId;
    resetArchive();
    setFreshCheckBlock(null);
    setFreshCheckPending(true);
    let freshRoster: RosterEntry[];
    try {
      // Confirmation deliberately bypasses the 30s query freshness window.
      // The server repeats the invariant authoritatively; this fresh read keeps
      // the operator from firing a request we already know must be rejected.
      freshRoster = await fetchChannelRoster(requestedChannelId);
      if (!isCurrentChannel()) return;
      queryClient.setQueryData(
        ['channel-roster', requestedChannelId],
        freshRoster
      );
    } catch {
      if (!isCurrentChannel()) return;
      setFreshCheckBlock(
        'agent status could not be verified — retry before archiving'
      );
      return;
    } finally {
      if (isCurrentChannel()) setFreshCheckPending(false);
    }
    if (!isCurrentChannel()) return;
    const freshBusy = freshRoster.filter(
      (entry) =>
        entry.binding !== null &&
        (entry.binding.status !== 'idle' ||
          (entry.binding.queuedCount ?? 0) > 0 ||
          (entry.binding.steeringCount ?? 0) > 0)
    );
    if (freshBusy.length > 0) {
      setFreshCheckBlock(
        freshBusy.length === 1
          ? 'archive blocked — a bound agent is active'
          : `archive blocked — ${freshBusy.length} bound agents are active`
      );
      return;
    }
    try {
      await archiveChannel(requestedChannelId);
      if (!isCurrentChannel()) return;
      // The shared mutation does not resolve until every mounted topic/channel
      // projection has reconciled. Only then leave this now-archived channel,
      // preventing the active-only rail from immediately selecting it again.
      if (useUiStore.getState().activeChannelId === requestedChannelId) {
        setActiveChannelId(null);
      }
    } catch {
      // Shared mutation owns the operator toast; the inline error below keeps
      // the failed confirmation actionable in the header as well.
    }
  };

  return (
    <>
      {confirming ? (
        <span
          className="ch-archive-channel ch-archive-channel--confirming"
          role="group"
          aria-label="confirm archive channel"
        >
          <span className="ch-archive-channel__prompt">archive?</span>
          <button
            ref={confirmButtonRef}
            type="button"
            className="ch-archive-channel__button ch-archive-channel__button--confirm"
            onClick={() => void confirmArchive()}
            disabled={blocked || archivePending || freshCheckPending}
          >
            {freshCheckPending ? (
              <>
                <TuiProgress
                  variant="braille"
                  className="ch-archive-channel__progress"
                />{' '}
                checking agents
              </>
            ) : archivePending ? (
              <>
                <TuiProgress
                  variant="braille"
                  className="ch-archive-channel__progress"
                />{' '}
                archiving
              </>
            ) : blocked ? (
              blockedCopy
            ) : (
              'yes'
            )}
          </button>
          <button
            type="button"
            className="ch-archive-channel__button"
            onClick={() => {
              resetArchive();
              setFreshCheckBlock(null);
              restoreTriggerFocusRef.current = true;
              setConfirming(false);
            }}
            disabled={archivePending || freshCheckPending}
          >
            cancel
          </button>
        </span>
      ) : (
        <button
          ref={archiveTriggerRef}
          type="button"
          className="ch-archive-channel__button"
          onClick={() => {
            resetArchive();
            setFreshCheckBlock(null);
            setConfirming(true);
          }}
          disabled={blocked}
          title={blocked ? blockedTitle : 'archive channel'}
          aria-label={blocked ? blockedCopy : 'archive channel'}
        >
          {blocked ? blockedCopy : 'archive'}
        </button>
      )}
      {archiveFailed ? (
        <span className="ch-archive-channel__error" role="alert">
          {archiveError instanceof Error
            ? archiveError.message
            : 'failed to archive channel'}
        </span>
      ) : freshCheckBlock ? (
        <span className="ch-archive-channel__error" role="alert">
          {freshCheckBlock}
        </span>
      ) : null}
    </>
  );
}

/**
 * #1308 item 1: how many older-history pages a `#msg-…` deep link may pull
 * before it gives up. Unbounded, a link to a deleted/foreign message id would
 * walk the channel to seq 1 on every open; bounded, the worst case is a fixed
 * number of page fetches and one toast.
 */
const ANCHOR_WALK_MAX_PAGES = 8;
/**
 * #1307: how often the roster snapshot is re-fetched while a busy socket status
 * in this channel is still newer than that snapshot. `staleTime` alone never
 * refetches on its own, so a terminal 'idle' that never reached this client
 * (socket down when the runtime died, tab asleep) had nothing to reconcile it —
 * the chip and the presence row stayed busy for as long as the view stayed
 * mounted. See `shouldPollRosterForPresence`: one poll is normally enough, since
 * the snapshot it lands then outranks every socket transition and disarms the
 * interval until the next live transition arrives.
 */
const PRESENCE_ROSTER_POLL_MS = 30_000;

interface ChannelViewProps {
  channelId: string;
}

interface SteerTargets {
  agentIds: string[];
  labels: string[];
  queueAgentIds: string[];
  queueLabels: string[];
  mode: 'all' | 'some' | 'none';
}

interface ScopedSteerTargets {
  root: SteerTargets;
  activeThreadRootId: ChannelMessageId | null;
  activeThread: SteerTargets;
}

const EMPTY_STEER_TARGETS: SteerTargets = {
  agentIds: [],
  labels: [],
  queueAgentIds: [],
  queueLabels: [],
  mode: 'none',
};

function targetsForConversation(
  scopedTargets: ScopedSteerTargets,
  threadId: ChannelMessageId | null
): SteerTargets {
  if (threadId === null) return scopedTargets.root;
  if (scopedTargets.activeThreadRootId === threadId) {
    return scopedTargets.activeThread;
  }
  return EMPTY_STEER_TARGETS;
}

function ChannelDesignateControl({
  available,
  pending,
  error,
  onDesignate,
}: {
  available: boolean;
  pending: boolean;
  error: string | null;
  onDesignate: () => void;
}) {
  if (!available && error === null) return null;
  return (
    <>
      {available ? (
        <button
          type="button"
          className="ch-designate-orchestrator"
          onClick={onDesignate}
          disabled={pending}
        >
          {pending ? (
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
      {error ? (
        <span className="ch-designate-orchestrator__error" role="alert">
          {error}
        </span>
      ) : null}
    </>
  );
}

function ChannelConversationActions({
  visible,
  applyPending,
  onCreateThread,
  onEditInstructions,
  onApplyInstructions,
}: {
  visible: boolean;
  applyPending: boolean;
  onCreateThread: () => void;
  onEditInstructions: () => void;
  onApplyInstructions: () => void;
}) {
  if (!visible) return null;
  return (
    <>
      <button
        type="button"
        className="ch-reconnect-btn"
        onClick={onCreateThread}
      >
        new conversation
      </button>
      <button
        type="button"
        className="ch-reconnect-btn"
        onClick={onEditInstructions}
        title="saves defaults; current runtimes keep their prompt until applied"
      >
        instructions
      </button>
      <button
        type="button"
        className="ch-reconnect-btn"
        onClick={onApplyInstructions}
        disabled={applyPending}
        title="restarts idle runtimes in this conversation; busy turns keep their current instructions"
      >
        {applyPending ? 'applying instructions' : 'apply instructions'}
      </button>
    </>
  );
}

function ChannelConnectionStatus({
  connected,
  disconnected,
  onReconnect,
}: {
  connected: boolean;
  disconnected: boolean;
  onReconnect: () => void;
}) {
  const state = connected
    ? 'connected'
    : disconnected
      ? 'disconnected'
      : 'reconnecting';
  return (
    <>
      {disconnected ? (
        <button
          type="button"
          className="ch-reconnect-btn"
          onClick={onReconnect}
          title="disconnected — reconnect"
        >
          reconnect
        </button>
      ) : null}
      <span
        className={`ch-conn-dot${connected ? ' ch-conn-dot--on' : ''}${
          disconnected ? ' ch-conn-dot--off' : ''
        }`}
        title={state}
        aria-label={state}
      />
    </>
  );
}

function ChannelSearchTrigger({
  channelId,
  searchAlias,
}: {
  channelId: string;
  searchAlias: string | null;
}) {
  const searchPanelOpen = useChannelSearchPanelStore((state) => state.open);
  const openSearchForAlias = useChannelSearchPanelStore(
    (state) => state.openForAlias
  );
  const label = searchAlias
    ? `search message history in ${searchAlias}`
    : 'search all message history';

  return (
    <button
      type="button"
      className="ch-search-toggle"
      aria-expanded={searchPanelOpen}
      aria-controls="channel-search-panel"
      aria-label={label}
      data-channel-search-trigger="true"
      title={searchAlias ? `search messages in ${searchAlias}` : label}
      onClick={() => {
        useUiStore.getState().closeSidebar();
        if (searchPanelOpen) {
          document.getElementById('channel-search-panel-input')?.focus();
          return;
        }
        openSearchForAlias(searchAlias, searchAlias ? channelId : null);
      }}
    >
      search
    </button>
  );
}

function ChannelActivityToggle() {
  const presentation = useChannelActivityPresentationStore(
    (state) => state.presentation
  );
  const togglePresentation = useChannelActivityPresentationStore(
    (state) => state.togglePresentation
  );
  const collapsed = presentation === 'collapsed';
  return (
    <button
      type="button"
      className="ch-activity-toggle"
      aria-pressed={collapsed}
      aria-label={
        collapsed
          ? 'show completed agent activity'
          : 'collapse completed agent activity'
      }
      title="toggle agent activity (mod+shift+a)"
      onClick={togglePresentation}
    >
      activity: {collapsed ? 'collapsed' : 'shown'}
    </button>
  );
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
  const collapseCompletedAgentActivity = useChannelActivityPresentationStore(
    (state) => state.presentation === 'collapsed'
  );
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
  // A DM supplies one exact provider target. The composers resolve that
  // provider's current default profile and live control catalog from the
  // roster, matching binder DM routing without a vendor-specific UI branch.
  const implicitCommandProviderId = implicitCommandProviderForDm(dmProviderId);

  // A DM addresses its one agent implicitly — the binder routes an unmentioned
  // message to it — so the composer must not tell you to type `@` at the very
  // agent the header already says you are talking to.
  const dmPlaceholder =
    isDm && dmIdentity
      ? `message @${dmIdentity.label}…  ·  shift+enter for newline`
      : null;

  const title = channel?.title ?? topicQuery.data?.display.title ?? channelId;
  const searchAlias = resolvedChannelSearchAlias(
    channel?.title,
    topicQuery.data?.display.title
  );
  const activeThreadTitle =
    channel?.threads?.find(
      (thread) => thread.rootMessageId === activeThreadRootId
    )?.title ?? undefined;
  const [applyInstructionsPending, setApplyInstructionsPending] =
    useState(false);

  const refreshThreadNavigation = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: ['channels'] });
  }, [queryClient]);

  const handleCreateThread = useCallback(async () => {
    const requested = window.prompt('new conversation title');
    if (!requested?.trim()) return;
    try {
      const thread = await createChannelThread(channelId, requested);
      await refreshThreadNavigation();
      setActiveThreadRootId(thread.rootMessageId as ChannelMessageId);
    } catch {
      showToast('could not create conversation');
    }
  }, [channelId, refreshThreadNavigation, setActiveThreadRootId]);

  const handleRenameThread = useCallback(
    async (rootMessageId: ChannelMessageId, requested: string) => {
      try {
        await renameChannelThread(channelId, rootMessageId, requested);
        await refreshThreadNavigation();
      } catch {
        showToast('could not rename conversation');
        throw new Error('conversation rename failed');
      }
    },
    [channelId, refreshThreadNavigation]
  );

  const handleEditChannelInstructions = useCallback(async () => {
    const current = topicQuery.data?.promptDefaults ?? {};
    const systemPrompt = window.prompt(
      'shared channel system prompt (blank clears)',
      current.systemPrompt ?? ''
    );
    if (systemPrompt === null) return;
    const instructions = window.prompt(
      'shared channel instructions (blank clears)',
      current.instructions ?? ''
    );
    if (instructions === null) return;
    try {
      await updateWorkspaceTopic(channelId, {
        promptDefaults: {
          ...(current.starterPrompt
            ? { starterPrompt: current.starterPrompt }
            : {}),
          ...(current.contextPacketIds
            ? { contextPacketIds: current.contextPacketIds }
            : {}),
          ...(systemPrompt.trim() ? { systemPrompt: systemPrompt.trim() } : {}),
          ...(instructions.trim() ? { instructions: instructions.trim() } : {}),
        },
      });
      await queryClient.invalidateQueries({
        queryKey: ['workspace-topic', channelId],
      });
      showToast(
        'instructions saved — apply them to restart idle runtimes in this conversation'
      );
    } catch {
      showToast('could not save channel instructions');
    }
  }, [channelId, queryClient, topicQuery.data?.promptDefaults]);

  const handleApplyChannelInstructions = useCallback(async () => {
    if (applyInstructionsPending) return;
    const scopeLabel = activeThreadRootId ? 'this conversation' : 'the channel';
    setApplyInstructionsPending(true);
    try {
      const result = await restartChannelAgentRuntimes(
        channelId,
        activeThreadRootId
      );
      await queryClient.invalidateQueries({
        queryKey: ['channel-roster', channelId],
      });
      showToast(
        result.restarted > 0
          ? `instructions applied — restarted ${result.restarted} idle runtime${
              result.restarted === 1 ? '' : 's'
            } in ${scopeLabel}`
          : `instructions are saved — no runtime is active in ${scopeLabel}`
      );
    } catch (error) {
      showToast(
        error instanceof HttpError && error.status === 409
          ? 'instructions are saved — the active turn keeps its current instructions. Wait until it is idle, then apply again.'
          : 'could not apply channel instructions'
      );
    } finally {
      setApplyInstructionsPending(false);
    }
  }, [activeThreadRootId, applyInstructionsPending, channelId, queryClient]);

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
  const [designateError, setDesignateError] = useState<string | null>(null);

  useEffect(() => {
    setDesignateError(null);
  }, [channelId]);

  /**
   * The busy agents this view would be steering RIGHT NOW, mirrored at render
   * time (same discipline as `lastSeqRef` above) so the send callbacks can read
   * the current set without being rebuilt on every status transition. Assigned
   * further down, once `agentChips` exists.
   */
  const steerTargetsRef = useRef<ScopedSteerTargets>({
    root: EMPTY_STEER_TARGETS,
    activeThreadRootId: null,
    activeThread: EMPTY_STEER_TARGETS,
  });

  /**
   * One send path for both composers (#1308 slice 4 item 2). It carries the
   * operator's explicit steering choice to the post route AND owns the queued
   * chip's bookkeeping, because this is the only place that knows both what the
   * agent was doing when the message left and which durable row it became.
   */
  const postSteered = useCallback(
    async (
      text: string,
      clientMessageId: string,
      parts: ChannelMessagePart[],
      steering: ChannelPostSteering | undefined,
      threadId: ChannelMessageId | null
    ) => {
      const scopedTargets = steerTargetsRef.current;
      // The main and thread composers send through this one callback. Choose
      // targets from the same conversation scope as the outgoing row; falling
      // back to root here would mark an idle thread as queued behind unrelated
      // root work.
      const targets = targetsForConversation(scopedTargets, threadId);
      const statusStore = useChannelAgentStatusStore.getState();
      // Snapshot BEFORE the round trip: a turn that drains while the POST is in
      // flight must not leave a chip behind on a message it already consumed.
      const drainSeqs = snapshotQueueDrainSeqs(
        channelId,
        targets.queueAgentIds,
        threadId,
        statusStore.queueDrainSeqByChannelAgent
      );
      const message = await post(text, {
        clientMessageId,
        parts,
        ...(threadId !== null ? { threadId } : {}),
        ...(steering ? { steering } : {}),
      });
      // Nothing was busy → nothing to wait behind. An explicit interrupt is not
      // a wait either: the operator asked for the live turn to be cancelled, so
      // announcing the message as "queued" would describe the opposite of what
      // they chose.
      if (
        targets.agentIds.length === 0 ||
        steering === 'interrupt' ||
        // The native lane is not a future queued turn. Avoid a row chip that
        // says otherwise; its presence/status copy says "steering pending".
        targets.queueAgentIds.length === 0
      ) {
        return;
      }
      const current =
        useChannelAgentStatusStore.getState().queueDrainSeqByChannelAgent;
      for (const [key, seq] of Object.entries(drainSeqs)) {
        if ((current[key] ?? 0) !== seq) return;
      }
      useChannelQueuedSendsStore.getState().markQueuedSend(message.id, {
        channelId,
        agentIds: targets.queueAgentIds,
        label: queuedSendCopy(targets.queueLabels),
        drainSeqs,
      });
    },
    [channelId, post]
  );

  const handleSend = useCallback(
    async (
      text: string,
      clientMessageId: string,
      parts: ChannelMessagePart[],
      steering?: ChannelPostSteering
    ) => {
      await postSteered(text, clientMessageId, parts, steering, null);
    },
    [postSteered]
  );

  const handleThreadSend = useCallback(
    async (
      text: string,
      clientMessageId: string,
      parts: ChannelMessagePart[],
      steering?: ChannelPostSteering
    ) => {
      if (activeThreadRootId === null) return;
      await postSteered(
        text,
        clientMessageId,
        parts,
        steering,
        activeThreadRootId
      );
    },
    [activeThreadRootId, postSteered]
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
  const statusMap = useChannelAgentStatusStore((s) => s.statusByChannelAgent);
  const statusUpdatedAtMap = useChannelAgentStatusStore(
    (s) => s.updatedAtByChannelAgent
  );
  const queuedCountMap = useChannelAgentStatusStore(
    (s) => s.queuedCountByChannelAgent
  );
  const steeringCountMap = useChannelAgentStatusStore(
    (s) => s.steeringCountByChannelAgent
  );
  const steerSupportedMap = useChannelAgentStatusStore(
    (s) => s.steerSupportedByChannelAgent
  );
  // #1307: a busy socket status the roster has not yet superseded is exactly the
  // state that can go stale, so it is what arms the roster poll — and because the
  // predicate is the same tie-break the resolver uses, the poll self-disarms: the
  // first snapshot that lands is newer than every socket transition here, so the
  // roster becomes authoritative and this returns false. `refetchInterval` is a
  // function so TanStack re-evaluates it against the CURRENT `dataUpdatedAt`
  // after each fetch settles, not just on re-render.
  const rosterPollInterval = useCallback(
    (query: { state: { dataUpdatedAt: number } }): number | false =>
      shouldPollRosterForPresence({
        statusByChannelAgent: statusMap,
        updatedAtByChannelAgent: statusUpdatedAtMap,
        channelId,
        rosterUpdatedAt: query.state.dataUpdatedAt,
      })
        ? PRESENCE_ROSTER_POLL_MS
        : false,
    [statusMap, statusUpdatedAtMap, channelId]
  );
  const rosterChipsQuery = useQuery({
    queryKey: ['channel-roster', channelId],
    queryFn: () => fetchChannelRoster(channelId),
    staleTime: 30_000,
    retry: false,
    refetchInterval: rosterPollInterval,
  });

  // On channel switch, drop this channel's per-agent socket statuses so the
  // freshly-fetched roster is authoritative on open; live transitions repopulate
  // as they arrive. Without this the previously dead `clearChannel` reconciliation
  // never ran and a stale busy chip could survive a channel round-trip (#1167).
  useEffect(() => {
    const { clearChannel } = useChannelAgentStatusStore.getState();
    const clearQueuedSends = useChannelQueuedSendsStore.getState().clearChannel;
    clearChannel(channelId);
    // Queued-send marks are anchored to drain generations that this very reset
    // discards, so they must go with them — otherwise a mark snapshotted at
    // generation N would match the fresh zero of a re-entered channel and light
    // a chip for a send that has long since been answered (#1308 slice 4).
    clearQueuedSends(channelId);
    return () => {
      clearChannel(channelId);
      clearQueuedSends(channelId);
    };
  }, [channelId]);

  const streamingProfiles = useMemo(() => {
    const profiles = new Map<
      string,
      { agentId: string; threadId: string | null; providerId?: string }
    >();
    for (const message of reducer.messages) {
      if (message.status !== 'streaming' || message.sender.kind !== 'agent')
        continue;
      // Agent sender ids are profile Actor ids. Keep stream state in the same
      // identity namespace as roster/status rather than collapsing profiles by
      // provider.
      const key = channelAgentStatusKey(
        channelId,
        message.sender.id,
        message.threadId
      );
      profiles.set(key, {
        agentId: message.sender.id,
        threadId: message.threadId,
        ...(message.sender.providerId
          ? { providerId: message.sender.providerId }
          : {}),
      });
    }
    return profiles;
  }, [channelId, reducer.messages]);

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
    const candidates = new Map<
      string,
      { agentId: string; threadId: string | null }
    >();
    for (const entry of roster) {
      if (entry.binding != null) {
        candidates.set(channelAgentStatusKey(channelId, entry.id), {
          agentId: entry.id,
          threadId: null,
        });
      }
    }
    const prefix = `${channelId} `;
    for (const key of Object.keys(statusMap)) {
      if (!key.startsWith(prefix)) continue;
      const encoded = key.slice(prefix.length);
      const scopeStart = encoded.indexOf('\u0000');
      const agentId = encoded.slice(
        0,
        scopeStart === -1 ? undefined : scopeStart
      );
      if (!agentId) continue;
      candidates.set(key, {
        agentId,
        threadId: scopeStart === -1 ? null : encoded.slice(scopeStart + 1),
      });
    }
    for (const [key, candidate] of streamingProfiles) {
      candidates.set(key, candidate);
    }

    const chips: Array<{
      agentId: string;
      threadId: string | null;
      status: ChannelAgentStatus;
      role?: AgentRole;
      queuedCount: number;
      steeringCount: number;
      steerSupported: boolean;
      identity: ReturnType<typeof resolveSenderIdentity>;
    }> = [];
    for (const { agentId, threadId } of candidates.values()) {
      const entry = rosterById.get(agentId);
      const key = channelAgentStatusKey(channelId, agentId, threadId);
      const streaming = streamingProfiles.has(key);
      // The roster represents the channel-root binding only. A thread must
      // derive solely from its thread-scoped status/message lanes.
      const rosterBinding = threadId === null ? entry?.binding : undefined;
      const status = resolveEffectiveAgentStatus({
        socketStatus: statusMap[key],
        socketUpdatedAt: statusUpdatedAtMap[key],
        rosterStatus: rosterBinding?.status,
        rosterUpdatedAt,
        streaming,
        // Staleness floor (#1307): only a roster that says "nothing is bound"
        // may retire a busy socket status, so a long live turn keeps its chip.
        rosterHasLiveBinding: rosterBinding != null,
      });
      // Same lane the status came from (#1308 slice 4 item 2c), so the presence
      // row can never pair a live status with a stale count or the reverse.
      const queuedCount = resolveEffectiveQueuedCount({
        socketQueuedCount: queuedCountMap[key],
        socketUpdatedAt: statusUpdatedAtMap[key],
        rosterQueuedCount: rosterBinding?.queuedCount,
        rosterUpdatedAt,
      });
      const steeringCount = resolveEffectiveQueuedCount({
        socketQueuedCount: steeringCountMap[key],
        socketUpdatedAt: statusUpdatedAtMap[key],
        rosterQueuedCount: rosterBinding?.steeringCount,
        rosterUpdatedAt,
      });
      const socketSteerSupported = Object.hasOwn(steerSupportedMap, key)
        ? steerSupportedMap[key]
          ? 1
          : 0
        : undefined;
      const steerSupported =
        resolveEffectiveQueuedCount({
          socketQueuedCount: socketSteerSupported,
          socketUpdatedAt: statusUpdatedAtMap[key],
          rosterQueuedCount: rosterBinding?.steerSupported ? 1 : 0,
          rosterUpdatedAt,
        }) > 0;
      // Show a chip for a bound agent (even when idle) or one that is currently
      // active/streaming — but drop an unbound agent whose only signal is a stale
      // socket status the roster has since superseded to idle.
      if (rosterBinding == null && status === 'idle' && !streaming) continue;
      const providerId =
        entry?.providerId ?? streamingProfiles.get(key)?.providerId;
      const identity = resolveSenderIdentity({
        kind: 'agent',
        id: agentId,
        ...(providerId ? { providerId } : {}),
        ...(entry?.displayName ? { displayName: entry.displayName } : {}),
      });
      chips.push({
        agentId,
        threadId,
        status,
        queuedCount,
        steeringCount,
        steerSupported,
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
    queuedCountMap,
    steeringCountMap,
    steerSupportedMap,
    streamingProfiles,
    channelId,
  ]);

  const rootAgentChips = useMemo(
    () => agentChips.filter((chip) => chip.threadId === null),
    [agentChips]
  );
  const activeConversationAgentChips = useMemo(
    () => agentChips.filter((chip) => chip.threadId === activeThreadRootId),
    [activeThreadRootId, agentChips]
  );

  // In-timeline presence rows (#1277). Same chip signal, so a reload rebuilds
  // the rows from `resolveEffectiveAgentStatus` for free — no new WS event. The
  // suppression set is "owns a live main-lane streaming row", plus a trailing
  // hold so the gap between two assistant items of one turn does not strobe the
  // row in and out.
  const presenceSuppression = useStreamingPresenceHold(
    topLevelStreamingAgentIds
  );
  const agentPresence = useMemo(
    () => selectChannelAgentPresence(rootAgentChips, presenceSuppression),
    [rootAgentChips, presenceSuppression]
  );

  // #1308 item 2 storm brake, client half. Same `agentChips` signal the presence
  // rows use, so the disabled state cannot disagree with what the header says
  // the agent is doing. The server refuses independently — this only keeps the
  // operator from firing a request that is already known to be rejected.
  const busyAgentIds = useMemo(() => {
    const ids = new Set<string>();
    for (const chip of rootAgentChips) {
      if (chip.status !== 'idle') ids.add(chip.agentId);
    }
    return ids;
  }, [rootAgentChips]);
  const archiveBusyAgentCount = useMemo(
    () =>
      agentChips.filter(
        (chip) =>
          chip.status !== 'idle' ||
          chip.queuedCount > 0 ||
          chip.steeringCount > 0
      ).length,
    [agentChips]
  );

  // #1308 slice 4 item 2b. The composer's steering cluster keys on the SAME chip
  // signal, so what the composer offers and what the header says the agent is
  // doing can never disagree.
  const busyAgentLabels = useMemo(
    () =>
      rootAgentChips
        .filter((chip) => chip.status !== 'idle')
        .map((chip) => chip.identity.label),
    [rootAgentChips]
  );
  const busyAgentSteeringMode = useMemo((): 'all' | 'some' | 'none' => {
    const busy = rootAgentChips.filter((chip) => chip.status !== 'idle');
    if (busy.length === 0 || busy.every((chip) => !chip.steerSupported)) {
      return 'none';
    }
    return busy.every((chip) => chip.steerSupported) ? 'all' : 'some';
  }, [rootAgentChips]);
  const busyQueueFallback = useMemo(
    () =>
      rootAgentChips.filter(
        (chip) => chip.status !== 'idle' && !chip.steerSupported
      ),
    [rootAgentChips]
  );
  const activeThreadBusyAgentLabels = useMemo(
    () =>
      activeConversationAgentChips
        .filter((chip) => chip.status !== 'idle')
        .map((chip) => chip.identity.label),
    [activeConversationAgentChips]
  );
  const activeThreadBusySteeringMode = useMemo((): 'all' | 'some' | 'none' => {
    const busy = activeConversationAgentChips.filter(
      (chip) => chip.status !== 'idle'
    );
    if (busy.length === 0 || busy.every((chip) => !chip.steerSupported)) {
      return 'none';
    }
    return busy.every((chip) => chip.steerSupported) ? 'all' : 'some';
  }, [activeConversationAgentChips]);
  const activeThreadBusyQueueFallback = useMemo(
    () =>
      activeConversationAgentChips.filter(
        (chip) => chip.status !== 'idle' && !chip.steerSupported
      ),
    [activeConversationAgentChips]
  );
  const steerTargets = useMemo<SteerTargets>(
    () => ({
      agentIds: [...busyAgentIds],
      labels: busyAgentLabels,
      queueAgentIds: busyQueueFallback.map((chip) => chip.agentId),
      queueLabels: busyQueueFallback.map((chip) => chip.identity.label),
      mode: busyAgentSteeringMode,
    }),
    [busyAgentIds, busyAgentLabels, busyQueueFallback, busyAgentSteeringMode]
  );
  const activeThreadSteerTargets = useMemo<SteerTargets>(
    () => ({
      agentIds: activeConversationAgentChips
        .filter((chip) => chip.status !== 'idle')
        .map((chip) => chip.agentId),
      labels: activeThreadBusyAgentLabels,
      queueAgentIds: activeThreadBusyQueueFallback.map((chip) => chip.agentId),
      queueLabels: activeThreadBusyQueueFallback.map(
        (chip) => chip.identity.label
      ),
      mode: activeThreadBusySteeringMode,
    }),
    [
      activeConversationAgentChips,
      activeThreadBusyAgentLabels,
      activeThreadBusyQueueFallback,
      activeThreadBusySteeringMode,
    ]
  );
  // Send handlers must only observe a committed UI state. Updating the ref
  // during render lets an abandoned concurrent render steer a different set of
  // agents than the operator could actually see.
  useLayoutEffect(() => {
    steerTargetsRef.current = {
      root: steerTargets,
      activeThreadRootId,
      activeThread: activeThreadSteerTargets,
    };
  }, [activeThreadRootId, activeThreadSteerTargets, steerTargets]);

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
    (agentId: string, threadId: string | null = null) => {
      // 404 (no live binding) / 409 (NO_ACTIVE_TURN) both mean "already idle" —
      // swallow so a race between the click and the agent finishing is silent.
      void interruptChannelAgent(channelId, agentId, threadId).catch(() => {});
    },
    [channelId]
  );

  const handleDesignateOrchestrator = useCallback(async () => {
    setDesignateError(null);
    setDesignatePending(true);
    try {
      await designateChannelOrchestrator(channelId);
      await queryClient.invalidateQueries({
        queryKey: ['channel-roster', channelId],
      });
    } catch (error) {
      // Keep the affordance available for a retry, but make the server's stable
      // role-conflict signal legible beside the operator control.
      setDesignateError(designateOrchestratorErrorCopy(error));
    } finally {
      setDesignatePending(false);
    }
  }, [channelId, queryClient]);

  const hasOrchestrator = rootAgentChips.some(
    (chip) => chip.role === 'orchestrator'
  );

  // A designation write can commit while its response is lost. The next roster
  // snapshot is authoritative: once its chip says orchestrator, retire any
  // local failure from that write. Keep the render gate below as well so no
  // intermediate commit can announce success and failure at the same time.
  useEffect(() => {
    if (hasOrchestrator && designateError !== null) setDesignateError(null);
  }, [designateError, hasOrchestrator]);

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
                  key={`${chip.agentId}\u0000${chip.threadId ?? ''}`}
                  className={`ch-agent-chip ch-agent-chip--${chip.status}`}
                  title={`${chip.identity.label}${
                    chip.role ? ` · ${chip.role}` : ''
                  } · ${chip.status}${
                    chip.threadId ? ' · conversation runtime' : ''
                  }`}
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
                      aria-label={`interrupt ${chip.identity.label}${
                        chip.threadId ? ' in conversation' : ''
                      }`}
                      title="interrupt"
                      onClick={() =>
                        handleInterruptAgent(chip.agentId, chip.threadId)
                      }
                    >
                      ■
                    </button>
                  ) : null}
                </span>
              );
            })}
          </span>
        ) : null}
        <ChannelDesignateControl
          available={
            topicQuery.isSuccess &&
            !isDm &&
            rosterChipsQuery.isSuccess &&
            !hasOrchestrator
          }
          pending={designatePending}
          error={hasOrchestrator ? null : designateError}
          onDesignate={() => void handleDesignateOrchestrator()}
        />
        <span className="ch-header__spacer" />
        <ChannelSearchTrigger channelId={channelId} searchAlias={searchAlias} />
        <ChannelActivityToggle />
        <ChannelConversationActions
          visible={!isDm && !archived}
          applyPending={applyInstructionsPending}
          onCreateThread={() => void handleCreateThread()}
          onEditInstructions={() => void handleEditChannelInstructions()}
          onApplyInstructions={() => void handleApplyChannelInstructions()}
        />
        <ChannelArchiveControl
          key={channelId}
          channelId={channelId}
          archived={archived}
          busyAgentCount={archiveBusyAgentCount}
          rosterStatus={
            rosterChipsQuery.isPending
              ? 'pending'
              : rosterChipsQuery.isError
                ? 'error'
                : 'ready'
          }
        />
        {/* Reconnect is intentionally not gated on needsCatchup: a dead socket
            cannot receive the transition that sets it (#1178). */}
        <ChannelConnectionStatus
          connected={connected}
          disconnected={disconnected}
          onReconnect={resync}
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
              collapseCompletedAgentActivity={collapseCompletedAgentActivity}
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
            implicitCommandProviderId={implicitCommandProviderId}
            onSend={handleSend}
            busyAgentLabels={busyAgentLabels}
            busyAgentSteeringMode={busyAgentSteeringMode}
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
            {...(activeThreadTitle ? { threadTitle: activeThreadTitle } : {})}
            isDm={isDm}
            implicitCommandProviderId={implicitCommandProviderId}
            rootId={activeThreadRootId}
            liveMessages={reducer.messages}
            onClose={() => setActiveThreadRootId(null)}
            onRename={(next) => handleRenameThread(activeThreadRootId, next)}
            onSend={handleThreadSend}
            busyAgentLabels={activeThreadBusyAgentLabels}
            busyAgentSteeringMode={activeThreadBusySteeringMode}
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
