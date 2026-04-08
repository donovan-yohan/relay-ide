import React from 'react';
import './ApprovalCard.css';
import type { ApprovalRequestEvent } from '../../../../server/chat-events.js';

interface ApprovalCardProps {
  event: ApprovalRequestEvent;
  onApprove: (
    requestId: string,
    decision: 'allow' | 'allow-always' | 'deny'
  ) => void;
  responded?: boolean;
  decision?: 'allow' | 'allow-always' | 'deny' | undefined;
}

export const ApprovalCard: React.FC<ApprovalCardProps> = ({
  event,
  onApprove,
  responded = false,
  decision,
}) => {
  return (
    <div
      className="approval-card"
      role="alertdialog"
      aria-label="permission request"
    >
      <div className="approval-card__header">
        <span className="approval-card__tool">
          {event.toolName.toLowerCase()}
        </span>
        {event.description && (
          <span className="approval-card__description">
            {event.description}
          </span>
        )}
      </div>
      <div className="approval-card__target">{event.target}</div>
      {event.detail && (
        <div className="approval-card__detail">{event.detail}</div>
      )}
      <div className="approval-card__actions">
        {responded && decision ? (
          <span className="approval-card__responded">{decision}</span>
        ) : (
          <>
            <button
              className="approval-card__btn approval-card__btn--allow"
              type="button"
              disabled={responded}
              onClick={() => onApprove(event.requestId, 'allow')}
              aria-label="allow command"
            >
              allow
            </button>
            <button
              className="approval-card__btn approval-card__btn--allow-always"
              type="button"
              disabled={responded}
              onClick={() => onApprove(event.requestId, 'allow-always')}
              aria-label="allow command always"
            >
              allow always
            </button>
            <button
              className="approval-card__btn approval-card__btn--deny"
              type="button"
              disabled={responded}
              onClick={() => onApprove(event.requestId, 'deny')}
              aria-label="deny command"
            >
              deny
            </button>
          </>
        )}
      </div>
    </div>
  );
};

export default ApprovalCard;
