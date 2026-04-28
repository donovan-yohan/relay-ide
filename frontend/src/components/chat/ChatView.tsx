import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import './ChatView.css';
import { useAgentChatSocket } from '../../hooks/useAgentChatSocket.js';
import { Composer, type ClientCommandHandler } from './Composer.js';
import { LiveBar } from './LiveBar.js';
import { QueueChips } from './QueueChips.js';
import { Turn, type EventVerbosity } from './Turn.js';
import type { AgentSlashCommandV2 } from '../../../../shared/agent-chat-protocol-v2.js';

const VERBOSITY_LEVELS: readonly EventVerbosity[] = ['normal', 'debug', 'trace'];

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
  const { session, sendMessage, interrupt, approve, resume, pushClientError } =
    useAgentChatSocket(sessionId);
  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [eventVerbosity, setEventVerbosity] =
    React.useState<EventVerbosity>('normal');

  const itemCount = useMemo(
    () =>
      session?.turns.reduce((count, turn) => count + turn.items.length, 0) ?? 0,
    [session]
  );

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const nearBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight <
      150;
    if (nearBottom) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
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
    (content: string) => {
      const turnId = crypto.randomUUID();
      sendMessage(turnId, content);
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
      session.live.status === 'idle',
    [session]
  );

  const handleResume = useCallback(() => {
    resume();
  }, [resume]);

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
        {canResume && (
          <div className="tl-resume-banner">
            <span className="tl-resume-hint">session paused — resume where you left off</span>
            <button
              type="button"
              className="tl-resume-btn"
              onClick={handleResume}
            >
              resume session
            </button>
          </div>
        )}
        {!session || session.turns.length === 0 ? (
          <div className="tl-empty">no messages yet</div>
        ) : (
          <>
            {session.turns.map((turn, index) => (
              <Turn
                key={turn.id}
                turn={turn}
                index={index}
                session={session}
                eventVerbosity={eventVerbosity}
                onApprove={approve}
                slashCommands={mergedSlashCommands}
              />
            ))}
            <LiveBar live={session.live} usage={latestUsage} />
            <QueueChips session={session} />
          </>
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
