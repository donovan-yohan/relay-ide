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
import { isNearBottom } from './scrollNearBottom.js';
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
  for (const item of items) {
    const rect = item.getBoundingClientRect();
    if (rect.bottom < containerTop) continue;
    const itemId = item.dataset.agentItemId;
    if (!itemId) continue;
    return { itemId, offsetTop: rect.top - containerTop };
  }
  return null;
}

function findAnchoredItem(
  container: HTMLDivElement,
  itemId: string
): HTMLElement | null {
  for (const item of container.querySelectorAll<HTMLElement>(
    '[data-agent-item-id]'
  )) {
    if (item.dataset.agentItemId === itemId) return item;
  }
  return null;
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

export function useAgentTimelineScroll({
  timelineId,
  itemCount,
}: UseAgentTimelineScrollOptions) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const shouldFollowRef = useRef(true);
  const readerAnchorRef = useRef<ReaderAnchor | null>(null);
  const previousTimelineIdRef = useRef(timelineId);

  // Session identity is part of the scroll state. Equal item counts across two
  // sessions must not preserve the old reader anchor/follow intent and open the
  // next conversation halfway up its history.
  useLayoutEffect(() => {
    if (previousTimelineIdRef.current === timelineId) return;
    previousTimelineIdRef.current = timelineId;
    shouldFollowRef.current = true;
    readerAnchorRef.current = null;
    const container = containerRef.current;
    if (container) container.scrollTop = container.scrollHeight;
    bottomRef.current?.scrollIntoView({ behavior: 'auto' });
  }, [timelineId]);

  const handleTimelineScroll = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    shouldFollowRef.current = isNearBottom({
      scrollHeight: container.scrollHeight,
      scrollTop: container.scrollTop,
      clientHeight: container.clientHeight,
    });
    readerAnchorRef.current = shouldFollowRef.current
      ? null
      : captureReaderAnchor(container);
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
      if (shouldFollowRef.current) {
        bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
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
        }
      }
      readerAnchorRef.current = captureReaderAnchor(container);
    };

    preserveViewport();

    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(preserveViewport);
    observer.observe(content);
    return () => observer.disconnect();
  }, [itemCount, timelineId]);

  return { bottomRef, containerRef, contentRef, handleTimelineScroll };
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

  const { bottomRef, containerRef, contentRef, handleTimelineScroll } =
    useAgentTimelineScroll({ timelineId: sessionId, itemCount });

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
              />
            ))}
            <QueueChips session={session} />
          </div>
        )}
        <div ref={bottomRef} />
      </div>
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
