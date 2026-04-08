import React, { useState } from 'react';
import './ToolCard.css';
import type {
  ToolCallEvent,
  ToolCallStatus,
} from '../../../../server/chat-events.js';

interface ToolCardProps {
  event: ToolCallEvent;
}

const EXPANDED_BY_DEFAULT = new Set(['bash', 'edit', 'multiedit', 'write']);

function statusLabel(status: ToolCallStatus): string {
  switch (status) {
    case 'pending':
      return 'pending';
    case 'running':
      return 'running';
    case 'completed':
      return 'completed';
    case 'error':
      return 'error';
    case 'declined':
      return 'declined';
  }
}

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

export const ToolCard: React.FC<ToolCardProps> = ({ event }) => {
  const defaultExpanded = EXPANDED_BY_DEFAULT.has(event.toolName.toLowerCase());
  const [expanded, setExpanded] = useState(defaultExpanded);

  const hasInput = Object.keys(event.input).length > 0;

  return (
    <div className="tool-card">
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
        <span className={`tool-card__status ${statusClass(event.status)}`}>
          {statusLabel(event.status)}
        </span>
      </button>
      {expanded && hasInput && (
        <div className="tool-card__body">
          <pre className="tool-card__input">
            {JSON.stringify(event.input, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
};

export default ToolCard;
