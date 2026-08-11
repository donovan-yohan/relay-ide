import React, { useMemo } from 'react';
import type {
  ChannelMessage,
  ChannelMessageId,
  ChannelMessagePart,
  ChannelPostSteering,
} from '../../../../shared/channel-chat-protocol.js';
import { useChannelThread } from '../../hooks/useChannelThread.js';
import { shouldRenderChannelMessage } from '../../lib/chat/reasoning-detail.js';
import {
  buildTimelineNodes,
  deriveReplyCounts,
  displayedReplyCount,
  formatDayLabel,
} from '../../lib/chat/channel-timeline-layout.js';
import { ChannelComposer } from './ChannelComposer.js';
import { ChannelMessageGroup } from './ChannelMessageGroup.js';
import { ChannelMessageRow } from './ChannelMessageRow.js';
import { useReasoningDetailStateScope } from './ReasoningDetailState.js';
import { useFollowingScroll } from './useFollowingScroll.js';
import { useLiveReplyGrowth } from './useLiveReplyGrowth.js';

/** Default thread copy: `@` is required to reach an agent in a group channel. */
const THREAD_PLACEHOLDER =
  'reply in thread…  ·  @ to mention · shift+enter for newline';
/**
 * DM thread copy. `handleMessagePosted` has no `threadId` gate, so an
 * unmentioned reply inside a DM thread routes implicitly exactly like a
 * top-level DM message — the composer must not ask for the `@` it does not
 * need. Kept name-free (unlike the channel composer) because the thread header
 * already says "thread" and the DM header already names the agent.
 */
const DM_THREAD_PLACEHOLDER = 'reply in thread…  ·  shift+enter for newline';

interface ChannelThreadPanelProps {
  channelId: string;
  channelTitle: string;
  threadTitle?: string;
  /** True when the channel is a DM (one agent, implicit routing). */
  isDm?: boolean;
  /** Codex DM provider hint for bare `/command` syntax. */
  implicitCommandProviderId?: string | undefined;
  rootId: ChannelMessageId;
  liveMessages: ChannelMessage[];
  onClose: () => void;
  onRename?: (title: string) => Promise<void>;
  onSend: (
    text: string,
    clientMessageId: string,
    parts: ChannelMessagePart[],
    steering?: ChannelPostSteering
  ) => Promise<void>;
  /**
   * Busy agent labels for the thread composer's steering cluster (#1308 slice
   * 4 item 2d). The thread lane has its OWN send path (`threadId` is attached
   * there, not in the composer), so it has to be handed the signal explicitly —
   * a reply into a busy agent queues exactly like a top-level message.
   */
  busyAgentLabels?: readonly string[];
  /** Whether busy harnesses use native steer or the legacy queue fallback. */
  busyAgentSteeringMode?: 'all' | 'some' | 'none';
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
  threadTitle,
  isDm = false,
  implicitCommandProviderId,
  rootId,
  liveMessages,
  onClose,
  onRename,
  onSend,
  busyAgentLabels,
  busyAgentSteeringMode,
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
    threadTitle: fetchedThreadTitle,
  } = useChannelThread(channelId, rootId, liveMessages);
  const durableThreadTitle = threadTitle?.trim() || fetchedThreadTitle?.trim();
  const reasoningViewState = useReasoningDetailStateScope(
    `thread:${channelId}:${rootId}`
  );
  const visibleReplies = useMemo(
    () => replies.filter(shouldRenderChannelMessage),
    [replies]
  );

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
  const nodes = useMemo(
    () => buildTimelineNodes(visibleReplies, null),
    [visibleReplies]
  );
  const {
    containerRef,
    contentRef,
    handleScroll,
    scrollToBottom,
    newMessageCount,
  } = useFollowingScroll({
    messages: visibleReplies,
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
        <span className="ch-thread__title">
          {durableThreadTitle || 'thread'}
        </span>
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
        {onRename ? (
          <button
            type="button"
            className="ch-thread__rename"
            onClick={() => {
              const next = window.prompt(
                'conversation title',
                durableThreadTitle ?? ''
              );
              if (next?.trim()) void onRename(next);
            }}
          >
            rename
          </button>
        ) : null}
      </header>

      <div className="ch-thread__root">
        {root ? (
          <ChannelMessageGroup
            sender={root.sender}
            messages={[root]}
            channelId={channelId}
            reasoningViewState={reasoningViewState}
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
                // Threads are short and already scoped to one turn, so the run
                // node is rendered flat here — the #1308 item 5 fold is a
                // main-lane noise control, not a thread-panel one.
                return node.messages.map((message) => (
                  <ChannelMessageRow
                    key={message.id}
                    message={message}
                    channelId={channelId}
                    reasoningViewState={reasoningViewState}
                    variant="system"
                  />
                ));
              }
              if (node.kind === 'unread-line') return null;
              const firstId = node.messages[0]?.id ?? `thread-group-${index}`;
              return (
                <ChannelMessageGroup
                  key={firstId}
                  sender={node.sender}
                  messages={node.messages}
                  channelId={channelId}
                  reasoningViewState={reasoningViewState}
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
        threadId={rootId}
        placeholder={isDm ? DM_THREAD_PLACEHOLDER : THREAD_PLACEHOLDER}
        {...(implicitCommandProviderId ? { implicitCommandProviderId } : {})}
        onSend={onSend}
        {...(busyAgentLabels ? { busyAgentLabels } : {})}
        {...(busyAgentSteeringMode ? { busyAgentSteeringMode } : {})}
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
