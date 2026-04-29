import React from 'react';
import './ApprovalCard.css';
import type {
  AgentApprovalDecisionV2,
  AgentApprovalDetailsV2,
  AgentApprovalItemV2,
  AgentApprovalSupportV2,
} from '../../../../shared/agent-chat-protocol-v2.js';
import type { ApprovalRequestEvent } from '../../../../shared/chat-events.js';

interface ApprovalCardProps {
  item?: AgentApprovalItemV2;
  event?: ApprovalRequestEvent;
  onApprove: (requestId: string, decision: AgentApprovalDecisionV2) => void;
}

function decisionLabel(decision: AgentApprovalDecisionV2): string {
  if (decision.kind === 'decline') return 'denied';
  if (decision.kind === 'cancel') return 'cancelled';
  const scope = decision.scope ?? 'once';
  if (scope === 'permanent') return 'allowed always';
  if (scope === 'session') return 'allowed for session';
  if (scope === 'turn') return 'allowed for turn';
  return 'allowed';
}

function renderDetails(details: AgentApprovalDetailsV2 | undefined, description: string, target: string, detail: string | undefined): React.ReactNode {
  if (!details) {
    return (
      <>
        <div className="acard__target">{target}</div>
        {detail && <div className="acard__detail">{detail}</div>}
      </>
    );
  }

  switch (details.kind) {
    case 'command':
      return (
        <div className="acard__details">
          <div className="acard__detail-label">cwd: {details.cwd}</div>
          <pre className="acard__code">{details.command}</pre>
        </div>
      );
    case 'patch':
      return (
        <div className="acard__details">
          {details.changes && details.changes.length > 0 && (
            <ul className="acard__patch-files">
              {details.changes.map((change, i) => (
                <li key={i} className="acard__patch-file">
                  <span className="acard__patch-kind">{change.kind}</span>
                  <span className="acard__patch-path">{change.path}</span>
                </li>
              ))}
            </ul>
          )}
          {details.diff && <pre className="acard__code acard__code--diff">{details.diff}</pre>}
        </div>
      );
    case 'permissionsGrant':
      return (
        <ul className="acard__permissions">
          {details.permissions.map((perm, i) => (
            <li key={i} className="acard__permission">{perm}</li>
          ))}
        </ul>
      );
    case 'elicitation':
      return (
        <div className="acard__details">
          <div className="acard__detail-label">{details.serverName}</div>
          <div className="acard__detail">{details.message}</div>
        </div>
      );
    default:
      return (
        <>
          <div className="acard__target">{target}</div>
          {detail && <div className="acard__detail">{detail}</div>}
        </>
      );
  }
}

interface ApprovalView {
  requestId: string;
  tool: string;
  description: string;
  target: string;
  detail: string | undefined;
  details: AgentApprovalDetailsV2 | undefined;
  supported: AgentApprovalSupportV2;
  responded: boolean;
  decision: AgentApprovalDecisionV2 | undefined;
}

/** Default support for items with no `supported` field (e.g. legacy v1 compat items). */
const DEFAULT_SUPPORT: AgentApprovalSupportV2 = {
  scopes: ['once', 'permanent'],
  amendmentTypes: [],
  canCancel: false,
};

function getApprovalView(
  item: AgentApprovalItemV2 | undefined,
  event: ApprovalRequestEvent | undefined
): ApprovalView {
  if (item) {
    return {
      requestId: item.requestId,
      tool: item.kind,
      description: item.description,
      target: item.target,
      detail: item.detail,
      details: item.details,
      supported: item.supported ?? DEFAULT_SUPPORT,
      responded: item.decision !== undefined || item.status === 'completed',
      decision: item.decision,
    };
  }

  return {
    requestId: event?.requestId ?? '',
    tool: event?.toolName.toLowerCase() ?? 'approval',
    description: event?.description ?? '',
    target: event?.target ?? '',
    detail: event?.detail,
    details: undefined,
    supported: DEFAULT_SUPPORT,
    responded: false,
    decision: undefined,
  };
}

const SCOPE_LABELS: Record<string, string> = {
  session: 'allow for session',
  turn: 'allow for turn',
  permanent: 'allow always',
};

const AMENDMENT_LABELS: Record<string, string> = {
  execpolicy: 'allow with exec policy',
  networkPolicy: 'allow with network policy',
  permissionGrant: 'allow with permission grant',
};

export const ApprovalCard: React.FC<ApprovalCardProps> = ({
  item,
  event,
  onApprove,
}) => {
  const view = getApprovalView(item, event);

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
      {renderDetails(view.details, view.target, view.target, view.detail)}
      <div className="acard__actions">
        {view.responded && view.decision ? (
          <span className="acard__responded">{decisionLabel(view.decision)}</span>
        ) : (
          <>
            <button
              className="acard__btn acard__btn--allow"
              type="button"
              onClick={() => onApprove(view.requestId, { kind: 'accept', scope: 'once' })}
              aria-label="allow command"
            >
              allow
            </button>
            {view.supported.scopes
              .filter((scope) => scope !== 'once')
              .map((scope) => (
                <button
                  key={scope}
                  className={`acard__btn ${scope === 'permanent' ? 'acard__btn--always' : 'acard__btn--scope'}`}
                  type="button"
                  onClick={() => onApprove(view.requestId, { kind: 'accept', scope })}
                  aria-label={SCOPE_LABELS[scope] ?? `allow ${scope}`}
                >
                  {SCOPE_LABELS[scope] ?? `allow ${scope}`}
                </button>
              ))}
            {view.supported.amendmentTypes.map((amendmentType) => (
              <button
                key={amendmentType}
                className="acard__btn acard__btn--amendment"
                type="button"
                onClick={() =>
                  onApprove(view.requestId, {
                    kind: 'accept',
                    scope: 'once',
                    amendments: [
                      amendmentType === 'permissionGrant'
                        ? { type: 'permissionGrant', permissions: [] }
                        : { type: amendmentType, payload: {} },
                    ],
                  })
                }
                aria-label={AMENDMENT_LABELS[amendmentType] ?? `allow with ${amendmentType}`}
              >
                {AMENDMENT_LABELS[amendmentType] ?? `allow with ${amendmentType}`}
              </button>
            ))}
            <button
              className="acard__btn acard__btn--deny"
              type="button"
              onClick={() => onApprove(view.requestId, { kind: 'decline' })}
              aria-label="deny command"
            >
              deny
            </button>
            {view.supported.canCancel && (
              <button
                className="acard__btn acard__btn--cancel"
                type="button"
                onClick={() => onApprove(view.requestId, { kind: 'cancel' })}
                aria-label="cancel"
              >
                cancel
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
};

export default ApprovalCard;
