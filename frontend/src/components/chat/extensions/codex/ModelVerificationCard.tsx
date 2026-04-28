import React from 'react';
import type { AgentProviderExtensionItemV2 } from '../../../../../../shared/agent-chat-protocol-v2.js';

interface ModelVerificationCardProps {
  item: AgentProviderExtensionItemV2;
}

function renderVerification(
  v: unknown,
  idx: number
): React.ReactNode {
  if (typeof v === 'string') {
    return (
      <li key={idx} className="provider-extension__verification">
        {v}
      </li>
    );
  }
  if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
    const rec = v as Record<string, unknown>;
    const message = typeof rec.message === 'string' ? rec.message : null;
    if (message !== null) {
      return (
        <li key={idx} className="provider-extension__verification">
          {message}
        </li>
      );
    }
  }
  return (
    <li key={idx} className="provider-extension__verification">
      <code>{JSON.stringify(v)}</code>
    </li>
  );
}

export const ModelVerificationCard: React.FC<ModelVerificationCardProps> = ({
  item,
}) => {
  const threadId =
    typeof item.payload.threadId === 'string' ? item.payload.threadId : null;
  const turnId =
    typeof item.payload.turnId === 'string' ? item.payload.turnId : null;
  const verifications = Array.isArray(item.payload.verifications)
    ? (item.payload.verifications as unknown[])
    : null;

  return (
    <details
      className="provider-extension provider-extension--codex provider-extension--codex-modelVerification"
      role="article"
    >
      <summary className="provider-extension__h">
        codex.modelVerification
      </summary>
      <div className="provider-extension__body">
        {threadId !== null && (
          <div className="provider-extension__field">
            <span className="provider-extension__label">thread</span>
            <span className="provider-extension__value">{threadId}</span>
          </div>
        )}
        {turnId !== null && (
          <div className="provider-extension__field">
            <span className="provider-extension__label">turn</span>
            <span className="provider-extension__value">{turnId}</span>
          </div>
        )}
        {verifications !== null && verifications.length > 0 && (
          <ul className="provider-extension__list">
            {verifications.map((v, idx) => renderVerification(v, idx))}
          </ul>
        )}
      </div>
    </details>
  );
};

export default ModelVerificationCard;
