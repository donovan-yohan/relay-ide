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
}

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

function contentSize(card: AgentDetailCardV2): string | null {
  if (card.kind === 'diff') {
    const additions = card.additions ?? 0;
    const deletions = card.deletions ?? 0;
    return `+${additions} -${deletions}`;
  }
  const content = card.content ?? '';
  const bytes = card.sizeBytes ?? new TextEncoder().encode(content).byteLength;
  if (bytes === 0) return null;
  const lines = content.split('\n').length;
  return `${lines} line${lines === 1 ? '' : 's'} · ${byteLabel(bytes)}`;
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

function CardContent({ card, itemId }: CardContentProps) {
  const content = card.content ?? '';
  const language = card.kind === 'diff' ? 'diff' : card.language;
  const cacheKey = `agent-detail:${itemId}:${language ?? 'text'}`;
  const { tokens } = useShikiHighlight(
    cacheKey,
    language ? content : '',
    language ?? 'text'
  );
  const rawLines = useMemo(() => content.split('\n'), [content]);

  return (
    <pre className="ch-agent-card__code">
      <code>
        {rawLines.map((line, lineIndex) => (
          <span
            className={lineClass(card.kind, line)}
            key={`${lineIndex}:${line}`}
          >
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
  );
}

/**
 * Framework-agnostic ACP-style detail card. The adapter owns normalization;
 * this component only consumes the durable typed card contract.
 */
export const AgentDetailCard: React.FC<AgentDetailCardProps> = ({
  card,
  itemId,
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
        onClick={() => setExpanded((value) => !value)}
      >
        <ChevronRight
          className={`ch-agent-card__chevron${expanded ? ' ch-agent-card__chevron--open' : ''}`}
          size={14}
          strokeWidth={1.5}
          aria-hidden="true"
        />
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
