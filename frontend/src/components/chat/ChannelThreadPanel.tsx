import React, { useMemo } from 'react';
import type {
  ChannelMessage,
  ChannelMessageId,
} from '../../../../shared/channel-chat-protocol.js';
import { useChannelThread } from '../../hooks/useChannelThread.js';
import {
  buildTimelineNodes,
  deriveReplyCounts,
  displayedReplyCount,
  formatDayLabel,
} from '../../lib/chat/channel-timeline-layout.js';
import { ChannelComposer } from './ChannelComposer.js';
import { ChannelMessageGroup } from './ChannelMessageGroup.js';
import { ChannelMessageRow } from './ChannelMessageRow.js';
import { useFollowingScroll } from './useFollowingScroll.js';
import { useLiveReplyGrowth } from './useLiveReplyGrowth.js';

interface ChannelThreadPanelProps {
  channelId: string;
  channelTitle: string;
  rootId: ChannelMessageId;
  liveMessages: ChannelMessage[];
  onClose: () => void;
  onSend: (text: string, clientMessageId: string) => Promise<void>;
  postPending: boolean;
  storeDown: boolean;
  archived: boolean;
  onRestore: () => void;
  restorePending: boolean;
  fullSnapshotRevision: number;
}

export const ChannelThreadPanel: React.FC<ChannelThreadPanelProps> = ({
  channelId,
  channelTitle,
  rootId,
  liveMessages,
  onClose,
  onSend,
  postPending,
  storeDown,
  archived,
  onRestore,
  restorePending,
  fullSnapshotRevision,
}) => {
  const {
    root,
    replies,
    hasMoreOlder,
    loadingOlder,
    loadOlder,
    loading,
    error,
    rootFloorRevision,
  } = useChannelThread(channelId, rootId, liveMessages);

  const replyActivity = useMemo(
    () => deriveReplyCounts(root ? [root, ...replies] : replies),
    [root, replies]
  );
  const liveReplyGrowth = useLiveReplyGrowth(liveMessages, {
    scopeKey: `${channelId}:${rootId}`,
    fullSnapshotRevision,
    ...(root
      ? {
          authoritativeRoots: [{ message: root, revision: rootFloorRevision }],
        }
      : {}),
  });
  const replyCount = root
    ? displayedReplyCount(
        root,
        replyActivity.get(root.id),
        liveReplyGrowth.get(root.id) ?? 0
      )
    : replies.length;
  const nodes = useMemo(() => buildTimelineNodes(replies, null), [replies]);
  const {
    containerRef,
    contentRef,
    handleScroll,
    scrollToBottom,
    newMessageCount,
  } = useFollowingScroll({
    messages: replies,
    hasMoreOlder,
    loadingOlder,
    loadOlder,
  });

  return (
    <section
      className="ch-thread"
      aria-label="channel thread"
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || event.defaultPrevented) return;
        event.preventDefault();
        onClose();
      }}
    >
      <header className="ch-thread__header">
        <span className="ch-thread__title">thread</span>
        <span className="ch-thread__count">
          · {replyCount} repl{replyCount === 1 ? 'y' : 'ies'}
        </span>
        <button
          type="button"
          className="ch-thread__close"
          onClick={onClose}
          aria-label="close thread"
        >
          <span className="ch-thread__close-desktop" aria-hidden="true">
            ×
          </span>
          <span className="ch-thread__close-mobile" aria-hidden="true">
            ‹ back
          </span>
        </button>
      </header>

      <div className="ch-thread__root">
        {root ? (
          <ChannelMessageGroup
            sender={root.sender}
            messages={[root]}
            channelId={channelId}
          />
        ) : loading ? (
          <div className="ch-thread__state">loading thread…</div>
        ) : (
          <div className="ch-thread__state" role="alert">
            {error ? 'thread unavailable' : 'thread root unavailable'}
          </div>
        )}
        <div className="ch-thread__root-divider" role="separator">
          <span>
            {replyCount} repl{replyCount === 1 ? 'y' : 'ies'}
          </span>
        </div>
      </div>

      <div className="ch-thread__scroll-shell">
        <div
          ref={containerRef}
          className="ch-thread__scroll"
          role="log"
          aria-live="polite"
          aria-label="thread replies"
          onScroll={handleScroll}
        >
          {!hasMoreOlder && replies.length > 0 ? (
            <div className="ch-top-marker">beginning of thread</div>
          ) : loadingOlder ? (
            <div className="ch-loading-older">loading older replies…</div>
          ) : null}
          {error && replies.length > 0 ? (
            <div className="ch-thread__state" role="status">
              older replies unavailable — scroll to retry
            </div>
          ) : null}
          <div ref={contentRef} className="ch-thread__content">
            {nodes.map((node, index) => {
              if (node.kind === 'day-divider') {
                return (
                  <div
                    key={`thread-day-${node.date}-${index}`}
                    className="ch-day-divider"
                    role="separator"
                  >
                    <span className="ch-day-divider__label">
                      {formatDayLabel(node.date)}
                    </span>
                  </div>
                );
              }
              if (node.kind === 'system') {
                return (
                  <ChannelMessageRow
                    key={node.message.id}
                    message={node.message}
                    channelId={channelId}
                    variant="system"
                  />
                );
              }
              if (node.kind === 'unread-line') return null;
              const firstId = node.messages[0]?.id ?? `thread-group-${index}`;
              return (
                <ChannelMessageGroup
                  key={firstId}
                  sender={node.sender}
                  messages={node.messages}
                  channelId={channelId}
                />
              );
            })}
          </div>
        </div>
        {newMessageCount > 0 ? (
          <button
            type="button"
            className="ch-new-messages"
            onClick={scrollToBottom}
          >
            {newMessageCount} new message{newMessageCount === 1 ? '' : 's'}
          </button>
        ) : null}
      </div>

      <ChannelComposer
        channelId={channelId}
        channelTitle={channelTitle}
        placeholder="reply in thread…  ·  @ to mention · shift+enter for newline"
        onSend={onSend}
        postPending={postPending}
        storeDown={storeDown}
        archived={archived}
        onRestore={onRestore}
        restorePending={restorePending}
      />
    </section>
  );
};

export default ChannelThreadPanel;
