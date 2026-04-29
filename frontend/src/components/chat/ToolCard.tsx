import React, { useMemo, useState } from 'react';
import './ToolCard.css';
import type {
  AgentCommandExecutionItemV2,
  AgentDynamicToolCallItemV2,
  AgentMcpToolCallItemV2,
} from '../../../../shared/agent-chat-protocol-v2.js';
import type {
  ToolCallEvent,
  ToolCallStatus,
  ToolResultEvent,
} from '../../../../shared/chat-events.js';

type ToolItemV2 =
  | AgentCommandExecutionItemV2
  | AgentDynamicToolCallItemV2
  | AgentMcpToolCallItemV2;

interface ToolCardProps {
  item?: ToolItemV2;
  event?: ToolCallEvent;
  result?: ToolResultEvent | undefined;
}

const EXPANDED_BY_DEFAULT = new Set([
  'bash',
  'edit',
  'multiedit',
  'write',
  'command',
]);

function statusClass(status: string | undefined): string {
  switch (status) {
    case 'running':
      return 'tcard__status--running';
    case 'completed':
      return 'tcard__status--completed';
    case 'failed':
    case 'error':
      return 'tcard__status--error';
    case 'cancelled':
    case 'declined':
      return 'tcard__status--declined';
    case 'pending':
    default:
      return 'tcard__status--pending';
  }
}

function legacyStatus(status: ToolCallStatus): string {
  return status;
}

function stringify(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  return JSON.stringify(value, null, 2);
}

function getToolView(
  item: ToolItemV2 | undefined,
  event: ToolCallEvent | undefined,
  result: ToolResultEvent | undefined
): {
  name: string;
  description: string;
  status: string;
  durationLabel: string | null;
  input: string;
  output: string;
  error: string;
} {
  if (item?.type === 'commandExecution') {
    return {
      name: 'command',
      description: item.command,
      status: item.status ?? 'pending',
      durationLabel: item.durationMs != null ? `${item.durationMs}ms` : null,
      input: item.cwd ? `cwd: ${item.cwd}\n${item.command}` : item.command,
      output: item.output,
      error: item.error ?? '',
    };
  }

  if (item?.type === 'dynamicToolCall') {
    return {
      name: item.tool,
      description: item.namespace,
      status: item.status ?? 'pending',
      durationLabel: null,
      input: stringify(item.arguments),
      output: item.content || stringify(item.result),
      error: item.error ?? '',
    };
  }

  if (item?.type === 'mcpToolCall') {
    return {
      name: item.tool,
      description: item.server,
      status: item.status ?? 'pending',
      durationLabel: null,
      input: stringify(item.arguments),
      output: item.progress || stringify(item.result),
      error: item.error ?? '',
    };
  }

  if (event) {
    return {
      name: event.toolName.toLowerCase(),
      description: event.description ?? '',
      status: legacyStatus(event.status),
      durationLabel:
        result?.durationMs != null ? `${result.durationMs}ms` : null,
      input: Object.keys(event.input).length > 0 ? stringify(event.input) : '',
      output: result?.output ?? '',
      error: result?.error ?? '',
    };
  }

  return {
    name: 'tool',
    description: '',
    status: 'pending',
    durationLabel: null,
    input: '',
    output: '',
    error: '',
  };
}

export const ToolCard: React.FC<ToolCardProps> = ({ item, event, result }) => {
  const view = useMemo(
    () => getToolView(item, event, result),
    [event, item, result]
  );
  const defaultExpanded = EXPANDED_BY_DEFAULT.has(view.name.toLowerCase());
  const [expanded, setExpanded] = useState(defaultExpanded);
  const hasBody = Boolean(view.input || view.output || view.error);

  return (
    <div className="tcard" role="article" aria-label={view.name.toLowerCase()}>
      <button
        className="tcard__h"
        onClick={() => setExpanded((value) => !value)}
        type="button"
        aria-expanded={expanded}
      >
        <span className="tcard__name">{view.name.toLowerCase()}</span>
        {view.description && (
          <span className="tcard__desc">{view.description}</span>
        )}
        {view.durationLabel && (
          <span className="tcard__dur">{view.durationLabel}</span>
        )}
        <span className={`tcard__status ${statusClass(view.status)}`}>
          {view.status}
        </span>
      </button>
      {expanded && hasBody && (
        <div className="tcard__body">
          {view.input && <pre>{view.input}</pre>}
          {view.output && <pre className="out">{view.output}</pre>}
          {view.error && <pre className="err">{view.error}</pre>}
        </div>
      )}
    </div>
  );
};

export default ToolCard;
