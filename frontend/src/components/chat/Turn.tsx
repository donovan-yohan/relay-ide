import React from 'react';
import type {
  AgentItemV2,
  AgentSessionV2,
  AgentTurnV2,
} from '../../../../shared/agent-chat-protocol-v2.js';
import { ApprovalCard } from './ApprovalCard.js';
import { FileChangeRow } from './FileChangeRow.js';
import { ToolCard } from './ToolCard.js';
import { TurnFooter } from './TurnFooter.js';
import { TurnHeader } from './TurnHeader.js';
import { renderProviderExtension } from './extensions/registry.js';

interface TurnProps {
  turn: AgentTurnV2;
  index: number;
  session: AgentSessionV2;
  onApprove: (
    requestId: string,
    decision: 'allow' | 'allow-always' | 'deny'
  ) => void;
}

function renderItem(
  item: AgentItemV2,
  onApprove: TurnProps['onApprove']
): React.ReactNode {
  switch (item.type) {
    case 'userMessage':
      return <pre className="tl-text tl-text--user">{item.text}</pre>;
    case 'assistantMessage':
      return item.text ? <pre className="tl-text">{item.text}</pre> : null;
    case 'reasoning':
      return (
        <details className="reasoning" open={item.visibility === 'full'}>
          <summary>thinking</summary>
          <pre className="tl-text">{item.detail ?? item.summary}</pre>
        </details>
      );
    case 'commandExecution':
    case 'dynamicToolCall':
    case 'mcpToolCall':
      return <ToolCard item={item} />;
    case 'fileChange':
      return <FileChangeRow item={item} />;
    case 'approval':
      return <ApprovalCard item={item} onApprove={onApprove} />;
    case 'providerExtension':
      return renderProviderExtension(item);
    case 'question':
      return <pre className="tl-text">{item.question}</pre>;
    case 'plan':
      return <pre className="tl-text">{item.text}</pre>;
    case 'compaction':
      return <pre className="tl-text">{item.summary}</pre>;
    case 'webSearch':
      return <pre className="tl-text">{item.query}</pre>;
    case 'imageView':
      return <pre className="tl-text">{item.source}</pre>;
    case 'imageGeneration':
      return <pre className="tl-text">{item.prompt}</pre>;
    case 'hookPrompt':
      return <pre className="tl-text">{item.prompt}</pre>;
  }
}

export const Turn: React.FC<TurnProps> = ({
  turn,
  index,
  session,
  onApprove,
}) => (
  <div className="turn" role="group" aria-label={`turn ${index + 1}`}>
    <TurnHeader turn={turn} index={index} session={session} />
    {turn.items.map((item) => (
      <React.Fragment key={item.id}>
        {renderItem(item, onApprove)}
      </React.Fragment>
    ))}
    {turn.error && (
      <div className="tl-error">
        <span>error</span>
        <span>{turn.error}</span>
      </div>
    )}
    <TurnFooter turn={turn} />
  </div>
);

export default Turn;
