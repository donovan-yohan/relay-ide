import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
} from 'react';
import './ChatView.css';
import { useAgentChatSocket } from '../../hooks/useAgentChatSocket.js';
import { createBrowserId } from '../../lib/browserId.js';
import {
  Composer,
  type ClientCommandHandler,
  type ComposerSendAttachment,
} from './Composer.js';
import { QueueChips } from './QueueChips.js';
import {
  deriveFollowIntent,
  readTimelineScrollMetrics,
} from './followingScrollPrimitives.js';
import { Turn, type EventVerbosity } from './Turn.js';
import type { AgentSlashCommandV2 } from '../../../../shared/agent-chat-protocol-v2.js';

const VERBOSITY_LEVELS: readonly EventVerbosity[] = [
  'normal',
  'debug',
  'trace',
];

const RELAY_CLIENT_COMMANDS: AgentSlashCommandV2[] = [
  {
    id: 'relay:relay-verbosity',
    name: 'relay-verbosity',
    description: 'set event verbosity (normal | debug | trace)',
    argumentHint: '<level>',
    aliases: ['verbosity'],
    source: 'relay',
    sourceLabel: 'Relay',
    dispatch: 'client',
    collisionKey: 'relay-verbosity',
  },
];

interface ChatViewProps {
  sessionId: string | null;
}

interface ReaderAnchor {
  itemId: string;
  offsetTop: number;
}

function captureReaderAnchor(container: HTMLDivElement): ReaderAnchor | null {
  const containerTop = container.getBoundingClientRect().top;
  const items = container.querySelectorAll<HTMLElement>('[data-agent-item-id]');
  let low = 0;
  let high = items.length - 1;
  let firstVisible = -1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const rect = items[middle]!.getBoundingClientRect();
    if (rect.bottom >= containerTop) {
      firstVisible = middle;
      high = middle - 1;
    } else {
      low = middle + 1;
    }
  }
  if (firstVisible < 0) return null;
  const item = items[firstVisible]!;
  const itemId = item.dataset.agentItemId;
  if (!itemId) return null;
  return {
    itemId,
    offsetTop: item.getBoundingClientRect().top - containerTop,
  };
}

function findAnchoredItem(
  container: HTMLDivElement,
  itemId: string
): HTMLElement | null {
  return container.querySelector<HTMLElement>(
    `[data-agent-item-id="${CSS.escape(itemId)}"]`
  );
}

/**
 * Exact production scroll model for an agent-detail timeline. Exported so the
 * static evidence harness can exercise follow intent and anchor restoration
 * without opening a real adapter WebSocket.
 */
interface UseAgentTimelineScrollOptions {
  timelineId: string | null;
  itemCount: number;
}

interface AgentTimelineScrollState {
  bottomRef: React.RefObject<HTMLDivElement | null>;
  containerRef: React.RefObject<HTMLDivElement | null>;
  contentRef: React.RefObject<HTMLDivElement | null>;
  handleTimelineScroll: () => void;
  prepareUserReflow: (itemId: string) => void;
  scrollToBottom: () => void;
  showJumpToLatest: boolean;
}

export function useAgentTimelineScroll({
  timelineId,
  itemCount,
}: UseAgentTimelineScrollOptions): AgentTimelineScrollState {
  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const shouldFollowRef = useRef(true);
  const readerAnchorRef = useRef<ReaderAnchor | null>(null);
  const userReflowAnchorRef = useRef<ReaderAnchor | null>(null);
  const previousTimelineIdRef = useRef(timelineId);
  const lastScrollTopRef = useRef(0);
  const programmaticFollowUntilRef = useRef(0);
  const [showJumpToLatest, setShowJumpToLatest] = React.useState(false);

  const scrollToBottom = useCallback((): void => {
    const container = containerRef.current;
    if (!container) return;
    const previousScrollTop = container.scrollTop;
    shouldFollowRef.current = true;
    readerAnchorRef.current = null;
    userReflowAnchorRef.current = null;
    setShowJumpToLatest(false);
    // Direct assignment matches #1197 and avoids smooth-scroll frames that can
    // masquerade as reader input. The guard remains for any browser-emitted
    // intermediate/programmatic frames.
    programmaticFollowUntilRef.current = performance.now() + 500;
    container.scrollTop = container.scrollHeight;
    // Keep the pre-scroll baseline until the browser reports the scroll. This
    // makes every downward intermediate frame programmatic while a genuine
    // upward gesture still disengages follow immediately.
    lastScrollTopRef.current = previousScrollTop;
  }, []);

  // Session identity is part of the scroll state. Equal item counts across two
  // sessions must not preserve the old reader anchor/follow intent and open the
  // next conversation halfway up its history.
  useLayoutEffect(() => {
    if (previousTimelineIdRef.current === timelineId) return;
    previousTimelineIdRef.current = timelineId;
    shouldFollowRef.current = true;
    readerAnchorRef.current = null;
    userReflowAnchorRef.current = null;
    programmaticFollowUntilRef.current = 0;
    scrollToBottom();
  }, [timelineId, scrollToBottom]);

  const handleTimelineScroll = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    const metrics = readTimelineScrollMetrics(container);
    const intent = deriveFollowIntent(metrics, lastScrollTopRef.current);
    const inProgrammaticFollow =
      performance.now() <= programmaticFollowUntilRef.current &&
      !intent.movingUp;
    if (inProgrammaticFollow) {
      shouldFollowRef.current = true;
      readerAnchorRef.current = null;
      if (intent.atBottom) programmaticFollowUntilRef.current = 0;
    } else {
      programmaticFollowUntilRef.current = 0;
      shouldFollowRef.current = intent.follow;
      readerAnchorRef.current = intent.follow
        ? null
        : captureReaderAnchor(container);
      setShowJumpToLatest(!intent.follow);
    }
    lastScrollTopRef.current = metrics.scrollTop;
  }, []);

  const prepareUserReflow = useCallback((itemId: string): void => {
    const container = containerRef.current;
    if (!container) return;
    const item = findAnchoredItem(container, itemId);
    if (!item) return;
    const containerRect = container.getBoundingClientRect();
    const itemRect = item.getBoundingClientRect();
    const toggledCardIsVisible =
      itemRect.bottom >= containerRect.top &&
      itemRect.top <= containerRect.bottom;
    const toggledCardAnchor = {
      itemId,
      offsetTop: itemRect.top - containerRect.top,
    };
    // A visible card header is the user's focal point. If the card is above
    // or below the viewport (for example, a programmatic fixture click), keep
    // the current first-visible row fixed instead of jumping to the card.
    const anchor = toggledCardIsVisible
      ? toggledCardAnchor
      : (captureReaderAnchor(container) ?? toggledCardAnchor);
    userReflowAnchorRef.current = anchor;
    readerAnchorRef.current = anchor;
    shouldFollowRef.current = false;
    programmaticFollowUntilRef.current = 0;
    setShowJumpToLatest(true);
  }, []);

  // #1197 scroll invariant, reused for agent-detail rows: follow intent is
  // sticky while at the bottom; a reader who scrolled up keeps the same first
  // visible item at the same offset when streaming or card expansion reflows
  // content above it.
  useEffect(() => {
    const container = containerRef.current;
    const content = contentRef.current;
    if (!container || !content) return;

    const preserveViewport = () => {
      const userAnchor = userReflowAnchorRef.current;
      if (userAnchor) {
        userReflowAnchorRef.current = null;
        const item = findAnchoredItem(container, userAnchor.itemId);
        if (item) {
          const offsetTop =
            item.getBoundingClientRect().top -
            container.getBoundingClientRect().top;
          container.scrollTop += offsetTop - userAnchor.offsetTop;
          lastScrollTopRef.current = container.scrollTop;
        }
        readerAnchorRef.current = captureReaderAnchor(container);
        return;
      }
      if (shouldFollowRef.current) {
        scrollToBottom();
        return;
      }
      const anchor = readerAnchorRef.current;
      if (anchor) {
        const item = findAnchoredItem(container, anchor.itemId);
        if (item) {
          const offsetTop =
            item.getBoundingClientRect().top -
            container.getBoundingClientRect().top;
          container.scrollTop += offsetTop - anchor.offsetTop;
          lastScrollTopRef.current = container.scrollTop;
        }
      }
      readerAnchorRef.current = captureReaderAnchor(container);
    };

    preserveViewport();

    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(preserveViewport);
    observer.observe(content);
    return () => observer.disconnect();
  }, [itemCount, timelineId, scrollToBottom]);

  return {
    bottomRef,
    containerRef,
    contentRef,
    handleTimelineScroll,
    prepareUserReflow,
    scrollToBottom,
    showJumpToLatest,
  };
}

export const ChatView: React.FC<ChatViewProps> = ({ sessionId }) => {
  const {
    session,
    sendMessage,
    interrupt,
    approve,
    answer,
    resume,
    continueHere,
    pushClientError,
  } = useAgentChatSocket(sessionId);
  const [eventVerbosity, setEventVerbosity] =
    React.useState<EventVerbosity>('normal');

  const itemCount = useMemo(
    () =>
      session?.turns.reduce((count, turn) => count + turn.items.length, 0) ?? 0,
    [session]
  );

  const {
    bottomRef,
    containerRef,
    contentRef,
    handleTimelineScroll,
    prepareUserReflow,
    scrollToBottom,
    showJumpToLatest,
  } = useAgentTimelineScroll({ timelineId: sessionId, itemCount });

  const isActive = useMemo(
    () =>
      session?.live.status === 'working' || session?.live.status === 'waiting',
    [session]
  );

  const latestUsage = useMemo(() => {
    const turns = session?.turns;
    if (!turns || turns.length === 0) return undefined;
    return (
      turns[turns.length - 1]?.usage ??
      [...turns].reverse().find((turn) => turn.usage)?.usage
    );
  }, [session]);

  const handleSend = useCallback(
    (content: string, attachments?: ComposerSendAttachment[]) => {
      const turnId = createBrowserId('turn');
      sendMessage(turnId, content, attachments);
    },
    [sendMessage]
  );

  const handleInterrupt = useCallback(() => {
    interrupt(session?.live.activeTurnId ?? undefined);
  }, [interrupt, session]);

  const canResume = useMemo(
    () =>
      session?.capabilities.resume === true &&
      session.providerSession !== undefined &&
      Object.keys(session.providerSession).length > 0 &&
      session.live.status === 'disconnected',
    [session]
  );

  /**
   * A session is in "resume failed" state when the live status is disconnected
   * AND live.error indicates the resume attempt failed. Both Resume (retry) and
   * Continue here (force-new) are offered in this state.
   */
  const resumeFailed = useMemo(
    () =>
      session?.live.status === 'disconnected' &&
      session.live.error === 'resume failed',
    [session]
  );

  const handleResume = useCallback(() => {
    resume();
  }, [resume]);

  const handleContinueHere = useCallback(() => {
    continueHere();
  }, [continueHere]);

  const clientHandlers = useMemo<Record<string, ClientCommandHandler>>(
    () => ({
      'relay-verbosity': (args: string) => {
        const level = args.trim().toLowerCase();
        if (!VERBOSITY_LEVELS.includes(level as EventVerbosity)) {
          return {
            ok: false,
            error: `verbosity must be one of: ${VERBOSITY_LEVELS.join(', ')}`,
          };
        }
        setEventVerbosity(level as EventVerbosity);
        return { ok: true };
      },
    }),
    []
  );

  const mergedSlashCommands = useMemo<AgentSlashCommandV2[]>(() => {
    const base = session?.slashCommands ?? [];
    const known = new Set(
      base.map((c) => (c.collisionKey ?? c.name).toLowerCase())
    );
    const additions = RELAY_CLIENT_COMMANDS.filter(
      (c) => !known.has((c.collisionKey ?? c.name).toLowerCase())
    );
    return [...base, ...additions];
  }, [session?.slashCommands]);

  return (
    <div className="chat-view" role="main" aria-label="chat">
      <div
        ref={containerRef}
        className="tl"
        role="log"
        aria-live="polite"
        aria-label="message timeline"
        onScroll={handleTimelineScroll}
      >
        {(canResume || resumeFailed) && (
          <div className="tl-resume-banner">
            <span className="tl-resume-hint">
              {resumeFailed
                ? 'could not resume this chat — retry or continue here'
                : 'session paused — resume where you left off'}
            </span>
            {resumeFailed ? (
              <>
                {/* Issue 3+4: resume-failed shows retry + continue here only */}
                <button
                  type="button"
                  className="tl-resume-btn"
                  onClick={handleResume}
                >
                  resume
                </button>
                <button
                  type="button"
                  className="tl-resume-btn"
                  onClick={handleContinueHere}
                >
                  continue here
                </button>
              </>
            ) : (
              /* Normal paused state: standard resume only, no continue here */
              <button
                type="button"
                className="tl-resume-btn"
                onClick={handleResume}
              >
                resume session
              </button>
            )}
          </div>
        )}
        {!session || session.turns.length === 0 ? (
          <div className="tl-empty">
            send the first message to start this chat
          </div>
        ) : (
          <div ref={contentRef} className="tl-content">
            {session.turns.map((turn, index) => (
              <Turn
                key={turn.id}
                turn={turn}
                index={index}
                session={session}
                eventVerbosity={eventVerbosity}
                onApprove={approve}
                onAnswer={answer}
                slashCommands={mergedSlashCommands}
                onDetailCardToggle={prepareUserReflow}
              />
            ))}
            <QueueChips session={session} />
          </div>
        )}
        <div ref={bottomRef} />
      </div>
      {showJumpToLatest ? (
        <button
          type="button"
          className="tl-jump-latest"
          onClick={scrollToBottom}
        >
          jump to latest
        </button>
      ) : null}
      <Composer
        onSend={handleSend}
        onInterrupt={handleInterrupt}
        isActive={isActive}
        capabilities={session?.capabilities}
        live={session?.live}
        usage={latestUsage}
        slashCommands={mergedSlashCommands}
        clientHandlers={clientHandlers}
        modelName={session?.config.model}
        pushClientError={pushClientError}
      />
    </div>
  );
};

export default ChatView;
