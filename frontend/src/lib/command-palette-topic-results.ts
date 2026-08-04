import type { WorkspaceTopic } from '../../../shared/workspace-topics.js';

export interface TopicPaletteResult {
  type: 'topic';
  id: string;
  label: string;
  sublabel: string;
  data: WorkspaceTopic;
}

function searchableText(topic: WorkspaceTopic): string[] {
  return [
    topic.display.title ?? '',
    topic.display.description ?? '',
    topic.routingDefaults.repoPath ?? '',
    topic.routingDefaults.nodeId ?? '',
  ];
}

function toResult(topic: WorkspaceTopic): TopicPaletteResult {
  return {
    type: 'topic',
    id: `topic-${topic.id}`,
    label: topic.display.title || topic.id,
    sublabel: topic.routingDefaults.repoPath ?? topic.workspaceId,
    data: topic,
  };
}

/** Active, non-archived topics ordered as provided, for the empty-query view. */
export function recentTopicPaletteResults(
  topics: WorkspaceTopic[],
  limit = 5
): TopicPaletteResult[] {
  return topics
    .filter((topic) => topic.status !== 'archived')
    .slice(0, limit)
    .map(toResult);
}

/** Topics whose title/description/repo/node match the query. */
export function buildTopicPaletteResults(
  query: string,
  topics: WorkspaceTopic[],
  limit = 5
): TopicPaletteResult[] {
  const q = query.toLowerCase();
  return topics
    .filter((topic) => topic.status !== 'archived')
    .filter((topic) =>
      searchableText(topic).some((value) => value.toLowerCase().includes(q))
    )
    .slice(0, limit)
    .map(toResult);
}
