import { useEffect, useRef, useState } from 'react';
import type {
  ChannelMessage,
  ChannelMessageId,
} from '../../../../shared/channel-chat-protocol.js';

interface ReplyGrowthTracker {
  resetKey: string;
  seenReplyIds: Set<ChannelMessageId>;
  latestSeq: number;
  rootFloors: Map<ChannelMessageId, number>;
}

const EMPTY_GROWTH = new Map<ChannelMessageId, number>();

function seedTracker(
  resetKey: string,
  messages: ChannelMessage[]
): ReplyGrowthTracker {
  return {
    resetKey,
    seenReplyIds: new Set(
      messages
        .filter((message) => message.threadId !== null)
        .map((message) => message.id)
    ),
    latestSeq: messages[messages.length - 1]?.seq ?? 0,
    rootFloors: new Map(
      messages
        .filter((message) => message.threadId === null)
        .map((message) => [message.id, message.replyCount ?? 0])
    ),
  };
}

/**
 * Count reply IDs first observed beyond the reducer's previous high-water seq.
 * Initial-window and older-history rows seed/dedupe the tracker; only genuinely
 * appended WS/catch-up rows grow a persisted replyCount floor.
 */
export function useLiveReplyGrowth(
  messages: ChannelMessage[],
  resetKey: string
): Map<ChannelMessageId, number> {
  const trackerRef = useRef<ReplyGrowthTracker | null>(null);
  const [growth, setGrowth] = useState<Map<ChannelMessageId, number>>(
    () => new Map()
  );

  useEffect(() => {
    const tracker = trackerRef.current;
    if (tracker === null || tracker.resetKey !== resetKey) {
      trackerRef.current = seedTracker(resetKey, messages);
      setGrowth((current) => (current.size === 0 ? current : new Map()));
      return;
    }

    const rebasedRoots = new Set<ChannelMessageId>();
    for (const message of messages) {
      if (message.threadId !== null) continue;
      const nextFloor = message.replyCount ?? 0;
      const previousFloor = tracker.rootFloors.get(message.id);
      tracker.rootFloors.set(message.id, nextFloor);
      // A refetch that advances the authoritative floor has absorbed prior live
      // growth. A truncated snapshot with the root absent cannot rebase it.
      if (previousFloor !== undefined && previousFloor !== nextFloor) {
        rebasedRoots.add(message.id);
      }
    }

    const previousLatestSeq = tracker.latestSeq;
    const increments = new Map<ChannelMessageId, number>();
    let latestSeq = previousLatestSeq;
    for (const message of messages) {
      latestSeq = Math.max(latestSeq, message.seq);
      if (message.threadId === null || tracker.seenReplyIds.has(message.id)) {
        continue;
      }
      tracker.seenReplyIds.add(message.id);
      if (message.seq <= previousLatestSeq) continue;
      increments.set(
        message.threadId,
        (increments.get(message.threadId) ?? 0) + 1
      );
    }
    tracker.latestSeq = latestSeq;
    if (increments.size === 0 && rebasedRoots.size === 0) return;
    setGrowth((current) => {
      const next = new Map(current);
      for (const rootId of rebasedRoots) next.delete(rootId);
      for (const [rootId, increment] of increments) {
        next.set(rootId, (next.get(rootId) ?? 0) + increment);
      }
      return next;
    });
  }, [messages, resetKey]);

  const activeTracker = trackerRef.current;
  if (activeTracker?.resetKey !== resetKey) return EMPTY_GROWTH;
  const pendingRebases = messages
    .filter((message) => message.threadId === null)
    .filter((message) => {
      const floor = activeTracker.rootFloors.get(message.id);
      return floor !== undefined && floor !== (message.replyCount ?? 0);
    });
  if (pendingRebases.length === 0) return growth;
  const effective = new Map(growth);
  for (const root of pendingRebases) effective.delete(root.id);
  return effective;
}
