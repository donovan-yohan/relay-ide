import React from 'react';
import type {
  AgentApprovalDecisionV2,
  AgentItemV2,
  AgentSessionV2,
  AgentSlashCommandV2,
  AgentTurnV2,
} from '../../../../shared/agent-chat-protocol-v2.js';
import { agentDetailCardForItem } from '../../../../shared/agent-chat-protocol-v2.js';
import { AgentDetailCard } from './AgentDetailCard.js';
import { ApprovalCard } from './ApprovalCard.js';
import { AssistantMarkdown } from './AssistantMarkdown.js';
import {
  CompactionCard,
  HookPromptCard,
  ImageGenerationCard,
  ImageViewCard,
  WebSearchCard,
} from './MediaCard.js';
import { PlanCard } from './PlanCard.js';
import { QuestionCard } from './QuestionCard.js';
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
  onAnswer: (requestId: string, answers: Record<string, string[]>) => void;
  /** Slash command catalog for skill token highlighting in user messages. */
  slashCommands?: AgentSlashCommandV2[];
  onDetailCardToggle?: (itemId: string) => void;
}

const EVENT_VERBOSITY_RANK: Record<EventVerbosity, number> = {
  normal: 0,
  debug: 1,
  trace: 2,
};

function itemEventVisibility(item: AgentItemV2): EventVerbosity {
  const visibility = item.metadata?.eventVisibility;
  return visibility === 'debug' || visibility === 'trace'
    ? visibility
    : 'normal';
}

function shouldRenderItem(
  item: AgentItemV2,
  verbosity: EventVerbosity
): boolean {
  if (item.type !== 'providerExtension') return true;
  return (
    EVENT_VERBOSITY_RANK[itemEventVisibility(item)] <=
    EVENT_VERBOSITY_RANK[verbosity]
  );
}

function renderUserMessage(
  text: string,
  commandIndex: Set<string>
): React.ReactNode {
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
  onAnswer: (requestId: string, answers: Record<string, string[]>) => void,
  commandIndex: Set<string>,
  onDetailCardToggle?: (itemId: string) => void
): React.ReactNode {
  if (!shouldRenderItem(item, eventVerbosity)) return null;

  // Persisted sessions predating #1198 may not carry `card` yet. Project their
  // provider-neutral item type at render time, while live adapter patches
  // arrive with this same card already attached and updated in place.
  const detailCard = item.card ?? agentDetailCardForItem(item);
  if (detailCard && detailCard.kind !== 'message') {
    return (
      <AgentDetailCard
        card={detailCard}
        itemId={item.id}
        {...(onDetailCardToggle ? { onUserToggle: onDetailCardToggle } : {})}
      />
    );
  }

  switch (item.type) {
    case 'userMessage':
      return renderUserMessage(item.text, commandIndex);
    case 'assistantMessage':
      return item.text ? (
        <AssistantMarkdown text={item.text} keyPrefix={item.id} />
      ) : null;
    case 'reasoning':
      return null;
    case 'commandExecution':
    case 'dynamicToolCall':
    case 'mcpToolCall':
      return null;
    case 'fileChange':
      return null;
    case 'approval':
      return <ApprovalCard item={item} onApprove={onApprove} />;
    case 'providerExtension':
      return renderProviderExtension(item);
    case 'question':
      return <QuestionCard item={item} onAnswer={onAnswer} />;
    case 'plan':
      return <PlanCard item={item} />;
    case 'compaction':
      return <CompactionCard item={item} />;
    case 'sessionBreak':
      return (
        <div
          className="tl-session-break"
          role="separator"
          aria-label="context boundary"
        >
          <span className="tl-session-break__label">
            — continued without prior context —
          </span>
        </div>
      );
    case 'webSearch':
      return <WebSearchCard item={item} />;
    case 'imageView':
      return <ImageViewCard item={item} />;
    case 'imageGeneration':
      return <ImageGenerationCard item={item} />;
    case 'hookPrompt':
      return <HookPromptCard item={item} />;
    case 'errorMessage':
      return (
        <div
          className={`tl-error-msg tl-error-msg--${item.source}`}
          role="alert"
        >
          <span className="tl-error-msg__lbl">
            {item.source === 'client' ? 'client error' : 'agent error'}
          </span>
          <span className="tl-error-msg__body">
            {item.context ? `${item.context}: ${item.message}` : item.message}
          </span>
        </div>
      );
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
  onAnswer,
  slashCommands,
  onDetailCardToggle,
}) => {
  const commandIndex = slashCommands
    ? buildCommandIndex(slashCommands)
    : new Set<string>();

  return (
    <div className="turn" role="group" aria-label={`turn ${index + 1}`}>
      <TurnHeader turn={turn} />
      {turn.items.map((item) => {
        const rendered = renderItem(
          item,
          eventVerbosity,
          onApprove,
          onAnswer,
          commandIndex,
          onDetailCardToggle
        );
        if (rendered == null || typeof rendered === 'boolean') {
          return null;
        }
        return (
          <div
            className="turn__item"
            data-agent-item-id={item.id}
            key={item.id}
          >
            {rendered}
          </div>
        );
      })}
      {turn.error && (
        <div className="tl-error">
          <span>error</span>
          <span>{turn.error}</span>
        </div>
      )}
      <TurnFooter turn={turn} live={session.live} />
    </div>
  );
};

export default Turn;
