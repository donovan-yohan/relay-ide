import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import './ChatView.css';
import { useAgentChatSocket } from '../../hooks/useAgentChatSocket.js';
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
  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [eventVerbosity, setEventVerbosity] =
    React.useState<EventVerbosity>('normal');

  const itemCount = useMemo(
    () =>
      session?.turns.reduce((count, turn) => count + turn.items.length, 0) ?? 0,
    [session]
  );

  // Auto-follow the bottom of the timeline as new items arrive AND as a
  // single streaming item (e.g. an assistantMessage growing via deltas)
  // grows the content height without changing itemCount. A ResizeObserver on
  // the content wrapper catches both cases; scrolling only happens if the
  // user was already near the bottom, so scrolling up to read history is
  // never interrupted.
  useEffect(() => {
    const container = containerRef.current;
    const content = contentRef.current;
    if (!container || !content) return;

    const followIfNearBottom = () => {
      if (
        isNearBottom({
          scrollHeight: container.scrollHeight,
          scrollTop: container.scrollTop,
          clientHeight: container.clientHeight,
        })
      ) {
        bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
      }
    };

    followIfNearBottom();

    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(followIfNearBottom);
    observer.observe(content);
    return () => observer.disconnect();
  }, [itemCount]);

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
      const turnId = crypto.randomUUID();
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
      >
        {(canResume || resumeFailed) && (
          <div className="tl-resume-banner">
            <span className="tl-resume-hint">
              {resumeFailed
                ? 'resume failed — retry or start a new context'
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
          <div className="tl-empty">no messages yet</div>
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
