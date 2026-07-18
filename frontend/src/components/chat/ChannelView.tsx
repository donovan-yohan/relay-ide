import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import './ChannelView.css';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useChannelChatSocket } from '../../hooks/useChannelChatSocket.js';
import {
  fetchWorkspaceTopic,
  restoreWorkspaceTopic,
  HttpError,
} from '../../lib/api.js';
import { isDmChannel } from '../../lib/dm-channels.js';
import { resolveSenderIdentity } from '../../lib/chat/sender-identity.js';
import { channelLastReadKey } from '../../lib/stores/channel-activity.js';
import { useUiStore } from '../../lib/stores/ui.js';
import { AgentBadge } from '../AgentBadge.js';
import { ChannelTimeline } from './ChannelTimeline.js';
import { ChannelComposer } from './ChannelComposer.js';

const READ_WRITE_VISIBLE_GRACE_MS = 10_000;

interface ChannelViewProps {
  channelId: string;
}

export const ChannelView: React.FC<ChannelViewProps> = ({ channelId }) => {
  const {
    channel,
    reducer,
    connected,
    notFound,
    hasMoreOlder,
    loadingOlder,
    loadOlder,
    post,
    postPending,
    postError,
    resync,
  } = useChannelChatSocket(channelId);
  const queryClient = useQueryClient();
  const setActiveChannelId = useUiStore((s) => s.setActiveChannelId);

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
        id: `agent:${dmProviderId}`,
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
      try {
        localStorage.setItem(
          channelLastReadKey(channelId),
          String(lastSeqRef.current)
        );
      } catch {
        /* localStorage unavailable */
      }
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

  const handleSend = useCallback(
    async (text: string, clientMessageId: string) => {
      await post(text, { clientMessageId });
    },
    [post]
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

  const hasMessages = reducer.messages.length > 0;

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
        <span className="ch-header__spacer" />
        <span
          className={`ch-conn-dot${connected ? ' ch-conn-dot--on' : ''}`}
          title={connected ? 'connected' : 'reconnecting'}
          aria-label={connected ? 'connected' : 'reconnecting'}
        />
      </div>

      {hasMessages ? (
        <ChannelTimeline
          messages={reducer.messages}
          lastReadSeq={lastReadSeq}
          channelTitle={title}
          hasMoreOlder={hasMoreOlder}
          loadingOlder={loadingOlder}
          loadOlder={loadOlder}
          needsCatchup={reducer.needsCatchup}
          onResync={resync}
        />
      ) : (
        <div className="ch-empty">
          <span>{emptyCopy}</span>
        </div>
      )}

      <ChannelComposer
        channelTitle={title}
        onSend={handleSend}
        postPending={postPending}
        storeDown={storeDown}
        archived={archived}
        onRestore={handleRestore}
        restorePending={restorePending}
      />
    </div>
  );
};

export default ChannelView;
