import React, { useMemo, useState } from 'react';
import {
  ChevronRight,
  CircleDot,
  FileDiff,
  MessageSquare,
  Terminal,
  Wrench,
} from 'lucide-react';
import type { AgentDetailCardV2 } from '../../../../shared/agent-chat-protocol-v2.js';
import { useShikiHighlight } from '../../hooks/useShikiHighlight.js';
import './AgentDetailCard.css';

interface AgentDetailCardProps {
  card: AgentDetailCardV2;
  /** Stable outer item id; isolates syntax-highlight cache entries. */
  itemId: string;
  onUserToggle?: (itemId: string) => void;
}

export const AGENT_DETAIL_RENDER_MAX_CHARS = 64 * 1024;
export const AGENT_DETAIL_RENDER_MAX_LINES = 1_000;
export const AGENT_DETAIL_HIGHLIGHT_MAX_CHARS = 24 * 1024;

function CardIcon({ kind }: Pick<AgentDetailCardV2, 'kind'>) {
  const props = { size: 14, strokeWidth: 1.5, 'aria-hidden': true } as const;
  switch (kind) {
    case 'message':
      return <MessageSquare {...props} />;
    case 'thought':
      return <CircleDot {...props} />;
    case 'tool_call':
      return <Wrench {...props} />;
    case 'output':
      return <Terminal {...props} />;
    case 'diff':
      return <FileDiff {...props} />;
  }
}

function statusClass(status: AgentDetailCardV2['status']): string {
  switch (status) {
    case 'running':
      return 'ch-agent-card__status--running';
    case 'completed':
      return 'ch-agent-card__status--completed';
    case 'failed':
      return 'ch-agent-card__status--failed';
    case 'cancelled':
      return 'ch-agent-card__status--cancelled';
    case 'pending':
    default:
      return 'ch-agent-card__status--pending';
  }
}

function byteLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes}b`;
  const kib = bytes / 1024;
  if (kib < 1024) return `${kib < 10 ? kib.toFixed(1) : Math.round(kib)}kb`;
  const mib = kib / 1024;
  return `${mib < 10 ? mib.toFixed(1) : Math.round(mib)}mb`;
}

function charLabel(characters: number): string {
  return `${characters} char${characters === 1 ? '' : 's'}`;
}

function contentSize(card: AgentDetailCardV2): string | null {
  if (card.kind === 'diff') {
    const additions = card.additions ?? 0;
    const deletions = card.deletions ?? 0;
    return `+${additions} -${deletions}`;
  }
  const content = card.content ?? '';
  const magnitude = card.sizeBytes ?? content.length;
  if (magnitude === 0) return null;
  const magnitudeLabel =
    card.sizeBytes === undefined
      ? charLabel(content.length)
      : byteLabel(card.sizeBytes);
  if (
    card.status === 'running' ||
    content.length > AGENT_DETAIL_RENDER_MAX_CHARS
  ) {
    return magnitudeLabel;
  }
  let lines = 1;
  for (let index = 0; index < content.length; index += 1) {
    if (content.charCodeAt(index) === 10) lines += 1;
  }
  return `${lines} line${lines === 1 ? '' : 's'} · ${magnitudeLabel}`;
}

function lineClass(kind: AgentDetailCardV2['kind'], line: string): string {
  if (kind !== 'diff' || line.startsWith('+++') || line.startsWith('---')) {
    return 'ch-agent-card__line';
  }
  if (line.startsWith('+')) {
    return 'ch-agent-card__line ch-agent-card__line--added';
  }
  if (line.startsWith('-')) {
    return 'ch-agent-card__line ch-agent-card__line--removed';
  }
  return 'ch-agent-card__line';
}

interface CardContentProps {
  card: AgentDetailCardV2;
  itemId: string;
}

interface BoundedCardContent {
  content: string;
  truncated: 'start' | 'end' | null;
}

function boundCardContent(card: AgentDetailCardV2): BoundedCardContent {
  const source = card.content ?? '';
  const keepTail = card.kind === 'output' || card.kind === 'tool_call';
  const charBounded =
    source.length <= AGENT_DETAIL_RENDER_MAX_CHARS
      ? source
      : keepTail
        ? source.slice(-AGENT_DETAIL_RENDER_MAX_CHARS)
        : source.slice(0, AGENT_DETAIL_RENDER_MAX_CHARS);
  const lines = charBounded.split('\n');
  const lineTruncated = lines.length > AGENT_DETAIL_RENDER_MAX_LINES;
  const visibleLines = lineTruncated
    ? keepTail
      ? lines.slice(-AGENT_DETAIL_RENDER_MAX_LINES)
      : lines.slice(0, AGENT_DETAIL_RENDER_MAX_LINES)
    : lines;
  return {
    content: visibleLines.join('\n'),
    truncated:
      source.length > AGENT_DETAIL_RENDER_MAX_CHARS
        ? keepTail
          ? 'start'
          : 'end'
        : lineTruncated
          ? keepTail
            ? 'start'
            : 'end'
          : null,
  };
}

function CardContent({ card, itemId }: CardContentProps) {
  const bounded = useMemo(() => boundCardContent(card), [card]);
  const content = bounded.content;
  const language = card.kind === 'diff' ? 'diff' : card.language;
  const cacheKey = `agent-detail:${itemId}:${language ?? 'text'}`;
  const highlightContent =
    language &&
    card.status !== 'running' &&
    content.length <= AGENT_DETAIL_HIGHLIGHT_MAX_CHARS
      ? content
      : '';
  const { tokens } = useShikiHighlight(
    cacheKey,
    highlightContent,
    language ?? 'text'
  );
  const rawLines = useMemo(() => content.split('\n'), [content]);

  return (
    <>
      {bounded.truncated ? (
        <div className="ch-agent-card__truncated" role="note">
          {bounded.truncated === 'start'
            ? 'showing latest bounded output'
            : 'showing first bounded output'}
        </div>
      ) : null}
      <pre className="ch-agent-card__code">
        <code>
          {rawLines.map((line, lineIndex) => (
            <span className={lineClass(card.kind, line)} key={lineIndex}>
              {tokens?.[lineIndex]?.map((token, tokenIndex) => (
                <span
                  key={tokenIndex}
                  style={{ color: token.color ?? 'var(--text)' }}
                >
                  {token.content}
                </span>
              )) ?? line}
              {'\n'}
            </span>
          ))}
        </code>
      </pre>
    </>
  );
}

/**
 * Framework-agnostic ACP-style detail card. The adapter owns normalization;
 * this component only consumes the durable typed card contract.
 */
export const AgentDetailCard: React.FC<AgentDetailCardProps> = ({
  card,
  itemId,
  onUserToggle,
}) => {
  const [expanded, setExpanded] = useState(false);
  const hasContent = Boolean(card.content);
  const size = contentSize(card);
  const title = card.path ?? card.title;

  return (
    <div
      className="ch-agent-card"
      data-agent-card-kind={card.kind}
      role="article"
      aria-label={`${card.kind.replace('_', ' ')} ${title}`}
    >
      <button
        type="button"
        className="ch-agent-card__toggle"
        aria-expanded={expanded}
        disabled={!hasContent}
        onClick={() => {
          onUserToggle?.(itemId);
          setExpanded((value) => !value);
        }}
      >
        {hasContent ? (
          <ChevronRight
            className={`ch-agent-card__chevron${expanded ? ' ch-agent-card__chevron--open' : ''}`}
            size={14}
            strokeWidth={1.5}
            aria-hidden="true"
          />
        ) : (
          <span
            className="ch-agent-card__chevron-placeholder"
            aria-hidden="true"
          />
        )}
        <span className="ch-agent-card__icon">
          <CardIcon kind={card.kind} />
        </span>
        <span className="ch-agent-card__title">{title}</span>
        {size ? <span className="ch-agent-card__size">{size}</span> : null}
        <span className={`ch-agent-card__status ${statusClass(card.status)}`}>
          {card.status}
        </span>
      </button>
      {expanded && hasContent ? (
        <div className="ch-agent-card__body">
          <CardContent card={card} itemId={itemId} />
        </div>
      ) : null}
    </div>
  );
};

export default AgentDetailCard;
