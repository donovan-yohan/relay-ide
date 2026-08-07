import React, { useState } from 'react';
import { ChevronRight, CircleDot } from 'lucide-react';
import type {
  AgentDetailCardStatusV2,
  AgentDetailCardV2,
} from '../../../../shared/agent-chat-protocol-v2.js';
import {
  shouldRenderReasoningDetail,
  type ReasoningTerminalState,
} from '../../lib/chat/reasoning-detail.js';
import { useReasoningDetailSettingsStore } from '../../lib/stores/reasoning-detail-settings.js';
import {
  fallbackReasoningDetailState,
  type ReasoningDetailStateApi,
} from './ReasoningDetailState.js';

export { shouldRenderReasoningDetail } from '../../lib/chat/reasoning-detail.js';
export type { ReasoningTerminalState } from '../../lib/chat/reasoning-detail.js';

interface ReasoningDetailProps {
  card: AgentDetailCardV2;
  itemId: string;
  stateKey?: string;
  size: string | null;
  terminalState?: ReasoningTerminalState;
  viewState?: ReasoningDetailStateApi;
  onUserToggle?: (itemId: string) => void;
  children: React.ReactNode;
}

type ReasoningStatusLabel =
  | AgentDetailCardStatusV2
  | ReasoningTerminalState
  | 'reasoning…';

export const REASONING_STATUS_CLASS = {
  pending: 'ch-agent-card__status--pending',
  running: 'ch-agent-card__status--running',
  'reasoning…': 'ch-agent-card__status--running',
  completed: 'ch-agent-card__status--completed',
  failed: 'ch-agent-card__status--failed',
  cancelled: 'ch-agent-card__status--cancelled',
  interrupted: 'ch-agent-card__status--cancelled',
  truncated: 'ch-agent-card__status--cancelled',
} satisfies Record<ReasoningStatusLabel, string>;

function reasoningStatusLabel(
  card: AgentDetailCardV2,
  terminalState?: ReasoningTerminalState
): ReasoningStatusLabel {
  if (terminalState === 'interrupted' || terminalState === 'truncated') {
    return terminalState;
  }
  if (terminalState === 'failed') return 'failed';
  if (
    terminalState === 'completed' &&
    (card.status === 'pending' || card.status === 'running')
  ) {
    return 'completed';
  }
  if (card.status === 'running') return 'reasoning…';
  return card.status;
}

/**
 * Provider-neutral disclosure for provider-visible reasoning summaries. Its
 * local state is seeded once from the persisted preference, so later setting
 * changes affect new blocks without undoing a manual toggle on a live block.
 */
export const ReasoningDetail: React.FC<ReasoningDetailProps> = ({
  card,
  itemId,
  stateKey = itemId,
  size,
  terminalState,
  viewState = fallbackReasoningDetailState,
  onUserToggle,
  children,
}) => {
  const defaultState = useReasoningDetailSettingsStore(
    (state) => state.settings.defaultState
  );
  const [expanded, setExpanded] = useState(() => {
    const override = viewState.get(stateKey);
    return override ? override === 'expanded' : defaultState === 'expanded';
  });
  const hasContent = Boolean(card.content?.trim());

  if (!shouldRenderReasoningDetail(card, terminalState)) return null;

  const bodyId = `reasoning-detail-body-${itemId}`;
  const status = reasoningStatusLabel(card, terminalState);
  const statusClass = REASONING_STATUS_CLASS[status];

  return (
    <div
      className="ch-agent-card ch-reasoning-detail"
      data-agent-card-kind="thought"
      data-agent-card-expandable={hasContent ? 'true' : 'false'}
      data-reasoning-detail-state={expanded ? 'expanded' : 'collapsed'}
      role="article"
      aria-label="Reasoning summary"
    >
      {hasContent ? (
        <button
          type="button"
          className="ch-agent-card__toggle"
          aria-expanded={expanded}
          aria-controls={bodyId}
          aria-label={`${expanded ? 'Collapse' : 'Expand'} Reasoning summary (${status})`}
          onClick={() => {
            onUserToggle?.(itemId);
            setExpanded((value) => {
              const next = !value;
              viewState.set(stateKey, next ? 'expanded' : 'collapsed');
              return next;
            });
          }}
        >
          <ChevronRight
            className={`ch-agent-card__chevron${expanded ? ' ch-agent-card__chevron--open' : ''}`}
            size={14}
            strokeWidth={1.5}
            aria-hidden="true"
          />
          <span className="ch-agent-card__icon">
            <CircleDot size={14} strokeWidth={1.5} aria-hidden="true" />
          </span>
          <span className="ch-agent-card__title">Reasoning summary</span>
          {size ? <span className="ch-agent-card__size">{size}</span> : null}
          <span className={`ch-agent-card__status ${statusClass}`}>
            {status}
          </span>
        </button>
      ) : (
        <div className="ch-agent-card__summary" aria-live="polite">
          <span className="ch-agent-card__icon">
            <CircleDot size={14} strokeWidth={1.5} aria-hidden="true" />
          </span>
          <span className="ch-agent-card__title">Reasoning summary</span>
          <span className={`ch-agent-card__status ${statusClass}`}>
            {status}
          </span>
        </div>
      )}
      {expanded && hasContent ? (
        <div id={bodyId} className="ch-agent-card__body">
          {children}
        </div>
      ) : null}
    </div>
  );
};

export default ReasoningDetail;
