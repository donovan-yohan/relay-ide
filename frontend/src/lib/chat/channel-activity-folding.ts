import type {
  ChannelMessage,
  ChannelMessageId,
} from '../../../../shared/channel-chat-protocol.js';
import type { AgentDetailCardV2 } from '../../../../shared/agent-chat-protocol-v2.js';

/** A durable activity row that may yield to the responses-first projection. */
export function isCompletedAgentActivity(message: ChannelMessage): boolean {
  return (
    message.sender.kind === 'agent' &&
    message.agentDetail !== undefined &&
    message.status === 'complete' &&
    message.agentDetail.card.status === 'completed'
  );
}

export interface AgentActivityRun {
  kind: 'agent-activity-run';
  /** First durable id is an opaque, globally unique local disclosure key. */
  runKey: ChannelMessageId;
  messages: ChannelMessage[];
  counts: Partial<Record<AgentDetailCardV2['kind'], number>>;
}

export type AgentActivityFoldNode =
  | { kind: 'message'; message: ChannelMessage }
  | AgentActivityRun;

/**
 * Replace only contiguous, terminal agent-detail rows. Prose, attachments,
 * pending/running activity and failed/interrupted activity remain individual
 * rows, so the responses-first control cannot conceal live or actionable work.
 */
export function buildAgentActivityFoldNodes(
  messages: ChannelMessage[],
  collapsed: boolean
): AgentActivityFoldNode[] {
  if (!collapsed) return messages.map((message) => ({ kind: 'message', message }));

  const nodes: AgentActivityFoldNode[] = [];
  let run: ChannelMessage[] = [];
  const flush = (): void => {
    if (run.length === 0) return;
    const counts: AgentActivityRun['counts'] = {};
    for (const message of run) {
      const kind = message.agentDetail!.card.kind;
      counts[kind] = (counts[kind] ?? 0) + 1;
    }
    nodes.push({
      kind: 'agent-activity-run',
      runKey: run[0]!.id,
      messages: run,
      counts,
    });
    run = [];
  };

  for (const message of messages) {
    if (isCompletedAgentActivity(message)) {
      run.push(message);
      continue;
    }
    flush();
    nodes.push({ kind: 'message', message });
  }
  flush();
  return nodes;
}

export function activityRunContains(
  run: AgentActivityRun,
  messageId: ChannelMessageId
): boolean {
  return run.messages.some((message) => message.id === messageId);
}

export function formatAgentActivityRunCounts(
  counts: AgentActivityRun['counts']
): string {
  const labels: Array<[AgentDetailCardV2['kind'], string]> = [
    ['tool_call', 'tool call'],
    ['thought', 'reasoning'],
    ['output', 'output'],
    ['diff', 'diff'],
    ['message', 'agent message'],
  ];
  return labels
    .flatMap(([kind, label]) => {
      const count = counts[kind] ?? 0;
      if (count === 0) return [];
      return [`${count} ${label}${count === 1 ? '' : 's'}`];
    })
    .join(' · ');
}
