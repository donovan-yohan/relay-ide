/**
 * Every cached projection whose membership or archived state changes when a
 * topic crosses the active/archive boundary. Prefix keys intentionally cover
 * active/archived variants and search entries below each namespace.
 */
export function topicLifecycleQueryKeys(topicId: string): string[][] {
  return [
    ['channel', topicId],
    ['workspace-topic', topicId],
    ['workspace-topics'],
    ['channels'],
    ['channel-message-search'],
  ];
}
