import React from 'react';
import type { AgentItemV2 } from '../../../../shared/agent-chat-protocol-v2.js';
import { AgentRequestPanel } from './AgentRequestPanel.js';
import '../chat/MessageTimeline.css';
import '../chat/ToolCard.css';

interface AgentItemRendererProps {
  item: AgentItemV2;
  onApprove: (
    requestId: string,
    decision: 'allow' | 'allow-always' | 'deny'
  ) => void;
}

export const AgentItemRenderer: React.FC<AgentItemRendererProps> = ({
  item,
  onApprove,
}) => {
  switch (item.type) {
    case 'userMessage':
      return <pre className="message-timeline__text">{item.text}</pre>;
    case 'assistantMessage':
      return item.text ? (
        <pre className="message-timeline__text">{item.text}</pre>
      ) : null;
    case 'reasoning':
      return (
        <pre className="message-timeline__text">thinking: {item.summary}</pre>
      );
    case 'approval':
      return <AgentRequestPanel item={item} onApprove={onApprove} />;
    case 'commandExecution':
      return (
        <div className="tool-card" role="article" aria-label="command">
          <div className="tool-card__header">
            <span className="tool-card__name">command</span>
            <span className="tool-card__description">{item.command}</span>
            {item.status && (
              <span className="tool-card__status">{item.status}</span>
            )}
          </div>
          {item.output && (
            <pre className="tool-card__output">{item.output}</pre>
          )}
        </div>
      );
    case 'fileChange':
      return (
        <pre className="message-timeline__text">
          {item.paths.map((path) => path.path).join('\n')}
          {item.patch ? `\n${item.patch}` : ''}
        </pre>
      );
    case 'mcpToolCall':
      return (
        <pre className="message-timeline__text">
          {item.server}/{item.tool}
        </pre>
      );
    case 'dynamicToolCall':
      return (
        <pre className="message-timeline__text">
          {item.namespace ? `${item.namespace}.` : ''}
          {item.tool}
          {item.content ? `\n${item.content}` : ''}
        </pre>
      );
    case 'question':
      return <pre className="message-timeline__text">{item.question}</pre>;
    case 'plan':
      return <pre className="message-timeline__text">{item.text}</pre>;
    case 'compaction':
      return <pre className="message-timeline__text">{item.summary}</pre>;
    case 'webSearch':
      return <pre className="message-timeline__text">{item.query}</pre>;
    case 'imageView':
      return <pre className="message-timeline__text">{item.source}</pre>;
    case 'imageGeneration':
      return <pre className="message-timeline__text">{item.prompt}</pre>;
    case 'hookPrompt':
      return <pre className="message-timeline__text">{item.prompt}</pre>;
    case 'providerExtension':
      return (
        <pre className="message-timeline__text">
          {JSON.stringify(item.payload, null, 2)}
        </pre>
      );
  }
};
