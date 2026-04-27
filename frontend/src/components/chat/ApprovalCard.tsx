import React from 'react';
import './ApprovalCard.css';
import type { AgentApprovalItemV2 } from '../../../../shared/agent-chat-protocol-v2.js';
import type { ApprovalRequestEvent } from '../../../../shared/chat-events.js';

interface ApprovalCardProps {
  item?: AgentApprovalItemV2;
  event?: ApprovalRequestEvent;
  onApprove: (
    requestId: string,
    decision: 'allow' | 'allow-always' | 'deny'
  ) => void;
  responded?: boolean;
  decision?: 'allow' | 'allow-always' | 'deny' | undefined;
}

function getApprovalView(
  item: AgentApprovalItemV2 | undefined,
  event: ApprovalRequestEvent | undefined,
  responded: boolean,
  decision: 'allow' | 'allow-always' | 'deny' | undefined
): {
  requestId: string;
  tool: string;
  description: string;
  target: string;
  detail: string | undefined;
  responded: boolean;
  decision: 'allow' | 'allow-always' | 'deny' | undefined;
} {
  if (item) {
    return {
      requestId: item.requestId,
      tool: item.kind,
      description: item.description,
      target: item.target,
      detail: item.detail,
      responded:
        item.decision !== undefined || item.status === 'completed' || responded,
      decision: item.decision ?? decision,
    };
  }

  return {
    requestId: event?.requestId ?? '',
    tool: event?.toolName.toLowerCase() ?? 'approval',
    description: event?.description ?? '',
    target: event?.target ?? '',
    detail: event?.detail,
    responded,
    decision,
  };
}

export const ApprovalCard: React.FC<ApprovalCardProps> = ({
  item,
  event,
  onApprove,
  responded = false,
  decision,
}) => {
  const view = getApprovalView(item, event, responded, decision);

  return (
    <div
      className="acard"
      role="alert"
      aria-live="assertive"
      aria-label="permission request"
    >
      <div className="acard__h">
        <span className="acard__tool">{view.tool.toLowerCase()}</span>
        {view.description && (
          <span className="acard__desc">{view.description}</span>
        )}
      </div>
      <div className="acard__target">{view.target}</div>
      {view.detail && <div className="acard__detail">{view.detail}</div>}
      <div className="acard__actions">
        {view.responded && view.decision ? (
          <span className="acard__responded">{view.decision}</span>
        ) : (
          <>
            <button
              className="acard__btn acard__btn--allow"
              type="button"
              disabled={view.responded}
              onClick={() => onApprove(view.requestId, 'allow')}
              aria-label="allow command"
            >
              allow
            </button>
            <button
              className="acard__btn acard__btn--always"
              type="button"
              disabled={view.responded}
              onClick={() => onApprove(view.requestId, 'allow-always')}
              aria-label="allow command always"
            >
              allow always
            </button>
            <button
              className="acard__btn acard__btn--deny"
              type="button"
              disabled={view.responded}
              onClick={() => onApprove(view.requestId, 'deny')}
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
