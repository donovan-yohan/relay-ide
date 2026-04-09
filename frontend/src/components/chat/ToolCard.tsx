import React, { useState } from 'react';
import './ToolCard.css';
import type {
  ToolCallEvent,
  ToolCallStatus,
  ToolResultEvent,
} from '../../../../server/chat-events.js';

interface ToolCardProps {
  event: ToolCallEvent;
  result?: ToolResultEvent | undefined;
}

const EXPANDED_BY_DEFAULT = new Set(['bash', 'edit', 'multiedit', 'write']);

function statusClass(status: ToolCallStatus): string {
  switch (status) {
    case 'pending':
      return 'tool-card__status--pending';
    case 'running':
      return 'tool-card__status--running';
    case 'completed':
      return 'tool-card__status--completed';
    case 'error':
      return 'tool-card__status--error';
    case 'declined':
      return 'tool-card__status--declined';
  }
}

export const ToolCard: React.FC<ToolCardProps> = ({ event, result }) => {
  const defaultExpanded = EXPANDED_BY_DEFAULT.has(event.toolName.toLowerCase());
  const [expanded, setExpanded] = useState(defaultExpanded);

  const hasInput = Object.keys(event.input).length > 0;
  const durationLabel =
    result?.durationMs != null ? `${result.durationMs}ms` : null;

  return (
    <div
      className="tool-card"
      role="article"
      aria-label={event.toolName.toLowerCase()}
    >
      <button
        className="tool-card__header"
        onClick={() => setExpanded((v) => !v)}
        type="button"
        aria-expanded={expanded}
      >
        <span className="tool-card__name">{event.toolName.toLowerCase()}</span>
        {event.description && (
          <span className="tool-card__description">{event.description}</span>
        )}
        {durationLabel && (
          <span className="tool-card__duration">{durationLabel}</span>
        )}
        <span className={`tool-card__status ${statusClass(event.status)}`}>
          {event.status}
        </span>
      </button>
      {expanded && (
        <div className="tool-card__body">
          {hasInput && (
            <pre className="tool-card__input">
              {JSON.stringify(event.input, null, 2)}
            </pre>
          )}
          {result?.output && (
            <pre className="tool-card__output">{result.output}</pre>
          )}
          {result?.error && (
            <pre className="tool-card__error">{result.error}</pre>
          )}
        </div>
      )}
    </div>
  );
};

export default ToolCard;
