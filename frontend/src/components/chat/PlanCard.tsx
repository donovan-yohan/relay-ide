import React from 'react';
import './PlanCard.css';
import type { AgentPlanItemV2 } from '../../../../shared/agent-chat-protocol-v2.js';

/** TUI-style checklist glyph per Codex plan step status. */
function stepGlyph(status: 'pending' | 'inProgress' | 'completed'): string {
  switch (status) {
    case 'completed':
      return '[x]';
    case 'inProgress':
      return '[~]';
    case 'pending':
    default:
      return '[ ]';
  }
}

interface PlanCardProps {
  item: AgentPlanItemV2;
}

/**
 * Structured plan card for `AgentPlanItemV2` (codex `turn/plan/updated`
 * steps). Renders a checklist with a status glyph per step and an
 * approval-state badge when present; falls back to the free-text `item.text`
 * when the adapter has not sent a structured `steps[]` yet.
 */
export const PlanCard: React.FC<PlanCardProps> = ({ item }) => {
  const hasSteps = Boolean(item.steps && item.steps.length > 0);

  return (
    <div className="pcard" role="article" aria-label="plan">
      <div className="pcard__h">
        <span className="pcard__label">plan</span>
        {item.approvalState && (
          <span
            className={`pcard__approval pcard__approval--${item.approvalState}`}
          >
            {item.approvalState}
          </span>
        )}
      </div>
      {hasSteps ? (
        <ul className="pcard__steps">
          {item.steps!.map((step, index) => (
            <li
              key={index}
              className={`pcard__step pcard__step--${step.status}`}
            >
              <span className="pcard__glyph">{stepGlyph(step.status)}</span>
              <span className="pcard__step-text">{step.step}</span>
            </li>
          ))}
        </ul>
      ) : (
        item.text && <pre className="pcard__text">{item.text}</pre>
      )}
    </div>
  );
};

export default PlanCard;
