import React from 'react';
import type { AgentApprovalItemV2 } from '../../../../shared/agent-chat-protocol-v2.js';
import '../chat/ApprovalCard.css';

interface AgentRequestPanelProps {
  item: AgentApprovalItemV2;
  onApprove: (
    requestId: string,
    decision: 'allow' | 'allow-always' | 'deny'
  ) => void;
}

export const AgentRequestPanel: React.FC<AgentRequestPanelProps> = ({
  item,
  onApprove,
}) => {
  const responded = item.decision !== undefined;

  return (
    <div
      className="approval-card"
      role="alert"
      aria-live="assertive"
      aria-label="permission request"
    >
      <div className="approval-card__header">
        <span className="approval-card__tool">{item.kind}</span>
        {item.description && (
          <span className="approval-card__description">{item.description}</span>
        )}
      </div>
      <div className="approval-card__target">{item.target}</div>
      {item.detail && (
        <div className="approval-card__detail">{item.detail}</div>
      )}
      <div className="approval-card__actions">
        {responded ? (
          <span className="approval-card__responded">{item.decision}</span>
        ) : (
          <>
            <button
              className="approval-card__btn approval-card__btn--allow"
              type="button"
              onClick={() => onApprove(item.requestId, 'allow')}
            >
              allow
            </button>
            <button
              className="approval-card__btn approval-card__btn--allow-always"
              type="button"
              onClick={() => onApprove(item.requestId, 'allow-always')}
            >
              allow always
            </button>
            <button
              className="approval-card__btn approval-card__btn--deny"
              type="button"
              onClick={() => onApprove(item.requestId, 'deny')}
            >
              deny
            </button>
          </>
        )}
      </div>
    </div>
  );
};
