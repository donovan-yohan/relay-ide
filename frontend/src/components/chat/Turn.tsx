import React from 'react';
import type {
  AgentApprovalDecisionV2,
  AgentItemV2,
  AgentSessionV2,
  AgentSlashCommandV2,
  AgentTurnV2,
} from '../../../../shared/agent-chat-protocol-v2.js';
import { ApprovalCard } from './ApprovalCard.js';
import { FileChangeRow } from './FileChangeRow.js';
import { ToolCard } from './ToolCard.js';
import { TurnFooter } from './TurnFooter.js';
import { TurnHeader } from './TurnHeader.js';
import { renderProviderExtension } from './extensions/registry.js';
import { renderInlineSkillTokens } from './skillTokens.js';

export type EventVerbosity = 'normal' | 'debug' | 'trace';

interface TurnProps {
  turn: AgentTurnV2;
  index: number;
  session: AgentSessionV2;
  eventVerbosity?: EventVerbosity;
  onApprove: (requestId: string, decision: AgentApprovalDecisionV2) => void;
  /** Slash command catalog for skill token highlighting in user messages. */
  slashCommands?: AgentSlashCommandV2[];
}

const EVENT_VERBOSITY_RANK: Record<EventVerbosity, number> = {
  normal: 0,
  debug: 1,
  trace: 2,
};

function itemEventVisibility(item: AgentItemV2): EventVerbosity {
  const visibility = item.metadata?.eventVisibility;
  return visibility === 'debug' || visibility === 'trace' ? visibility : 'normal';
}

function shouldRenderItem(item: AgentItemV2, verbosity: EventVerbosity): boolean {
  if (item.type !== 'providerExtension') return true;
  return EVENT_VERBOSITY_RANK[itemEventVisibility(item)] <= EVENT_VERBOSITY_RANK[verbosity];
}

function renderUserMessage(text: string, commandIndex: Set<string>): React.ReactNode {
  if (commandIndex.size === 0) {
    return <pre className="tl-text tl-text--user">{text}</pre>;
  }
  const segments = renderInlineSkillTokens(text, commandIndex);
  const hasTokens = segments.some((s) => typeof s !== 'string');
  if (!hasTokens) {
    return <pre className="tl-text tl-text--user">{text}</pre>;
  }
  return (
    <pre className="tl-text tl-text--user">
      {segments.map((seg, i) => {
        if (typeof seg === 'string') return seg;
        return (
          <span key={i} className="token-skill">
            {seg.text}
          </span>
        );
      })}
    </pre>
  );
}

function renderItem(
  item: AgentItemV2,
  eventVerbosity: EventVerbosity,
  onApprove: (requestId: string, decision: AgentApprovalDecisionV2) => void,
  commandIndex: Set<string>
): React.ReactNode {
  if (!shouldRenderItem(item, eventVerbosity)) return null;

  switch (item.type) {
    case 'userMessage':
      return renderUserMessage(item.text, commandIndex);
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

/** Build a lowercased command name Set from a slash command catalog. */
function buildCommandIndex(commands: AgentSlashCommandV2[]): Set<string> {
  const index = new Set<string>();
  for (const cmd of commands) {
    const name = cmd.name.replace(/^[/$]/, '').toLowerCase();
    index.add(name);
    for (const alias of cmd.aliases ?? []) {
      index.add(alias.replace(/^[/$]/, '').toLowerCase());
    }
  }
  return index;
}

export const Turn: React.FC<TurnProps> = ({
  turn,
  index,
  session,
  eventVerbosity = 'normal',
  onApprove,
  slashCommands,
}) => {
  const commandIndex = slashCommands ? buildCommandIndex(slashCommands) : new Set<string>();

  return (
    <div className="turn" role="group" aria-label={`turn ${index + 1}`}>
      <TurnHeader turn={turn} />
      {turn.items.map((item) => (
        <React.Fragment key={item.id}>
          {renderItem(item, eventVerbosity, onApprove, commandIndex)}
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
};

export default Turn;
