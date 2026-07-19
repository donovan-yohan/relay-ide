import { useEffect, useRef, useState } from 'react';
import type {
  ChannelMessage,
  ChannelMessageId,
} from '../../../../shared/channel-chat-protocol.js';

interface AuthoritativeRoot {
  message: ChannelMessage;
  revision: number;
}

interface ReplyGrowthTracker {
  scopeKey: string;
  fullSnapshotRevision: number;
  seenReplyIds: Set<ChannelMessageId>;
  latestSeq: number;
  rootFloors: Map<ChannelMessageId, number>;
  authoritativeRootRevisions: Map<ChannelMessageId, number>;
}

interface UseLiveReplyGrowthOptions {
  scopeKey: string;
  fullSnapshotRevision: number;
  authoritativeRoots?: AuthoritativeRoot[];
}

const EMPTY_GROWTH = new Map<ChannelMessageId, number>();

function rootsIn(messages: ChannelMessage[]): ChannelMessage[] {
  return messages.filter((message) => message.threadId === null);
}

function seedTracker(
  messages: ChannelMessage[],
  options: UseLiveReplyGrowthOptions
): ReplyGrowthTracker {
  const roots = [
    ...rootsIn(messages),
    ...(options.authoritativeRoots ?? []).map((entry) => entry.message),
  ];
  return {
    scopeKey: options.scopeKey,
    fullSnapshotRevision: options.fullSnapshotRevision,
    seenReplyIds: new Set(
      messages
        .filter((message) => message.threadId !== null)
        .map((message) => message.id)
    ),
    latestSeq: messages[messages.length - 1]?.seq ?? 0,
    rootFloors: new Map(
      roots.map((message) => [message.id, message.replyCount ?? 0])
    ),
    authoritativeRootRevisions: new Map(
      (options.authoritativeRoots ?? []).map((entry) => [
        entry.message.id,
        entry.revision,
      ])
    ),
  };
}

/**
 * Track only reply IDs observed live after a root floor is known. Roots present
 * in a new full snapshot rebase and absorb that batch's replies; unseen replies
 * for tracked roots absent from the truncated snapshot remain growth. A REST
 * root revision is equally authoritative and rebases at merge time.
 */
export function useLiveReplyGrowth(
  messages: ChannelMessage[],
  options: UseLiveReplyGrowthOptions
): Map<ChannelMessageId, number> {
  const trackerRef = useRef<ReplyGrowthTracker | null>(null);
  const [growth, setGrowth] = useState<Map<ChannelMessageId, number>>(
    () => new Map()
  );

  useEffect(() => {
    const tracker = trackerRef.current;
    if (tracker === null || tracker.scopeKey !== options.scopeKey) {
      trackerRef.current = seedTracker(messages, options);
      setGrowth((current) => (current.size === 0 ? current : new Map()));
      return;
    }

    const snapshotChanged =
      tracker.fullSnapshotRevision !== options.fullSnapshotRevision;
    const snapshotRoots = rootsIn(messages);
    const authoritativeRoots = options.authoritativeRoots ?? [];
    const authoritativeRootIds = new Set(
      authoritativeRoots.map((entry) => entry.message.id)
    );
    const rebasedRoots = new Set<ChannelMessageId>();

    if (snapshotChanged) {
      tracker.fullSnapshotRevision = options.fullSnapshotRevision;
      for (const root of snapshotRoots) {
        tracker.rootFloors.set(root.id, root.replyCount ?? 0);
        rebasedRoots.add(root.id);
      }
    }

    // First floor observation and changed floors both rebase. This also covers
    // a root found by ordinary channel-history backfill after a truncated view.
    for (const root of snapshotRoots) {
      // The panel's merged REST root can carry a newer floor than the stale live
      // root. Let that authoritative entry win once instead of oscillating the
      // tracker down and up on every render.
      if (authoritativeRootIds.has(root.id)) continue;
      const floor = root.replyCount ?? 0;
      const previous = tracker.rootFloors.get(root.id);
      if (previous === undefined || previous !== floor) {
        tracker.rootFloors.set(root.id, floor);
        rebasedRoots.add(root.id);
      }
    }

    for (const entry of authoritativeRoots) {
      const root = entry.message;
      const floor = root.replyCount ?? 0;
      const previousFloor = tracker.rootFloors.get(root.id);
      const previousRevision = tracker.authoritativeRootRevisions.get(root.id);
      tracker.rootFloors.set(root.id, floor);
      tracker.authoritativeRootRevisions.set(root.id, entry.revision);
      if (
        previousFloor === undefined ||
        previousFloor !== floor ||
        previousRevision !== entry.revision
      ) {
        rebasedRoots.add(root.id);
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
      if (
        message.seq <= previousLatestSeq ||
        !tracker.rootFloors.has(message.threadId) ||
        rebasedRoots.has(message.threadId)
      ) {
        continue;
      }
      increments.set(
        message.threadId,
        (increments.get(message.threadId) ?? 0) + 1
      );
    }
    tracker.latestSeq = latestSeq;

    if (increments.size === 0 && rebasedRoots.size === 0) return;
    setGrowth((current) => {
      const next = new Map(current);
      let changed = false;
      for (const rootId of rebasedRoots) {
        changed = next.delete(rootId) || changed;
      }
      for (const [rootId, increment] of increments) {
        next.set(rootId, (next.get(rootId) ?? 0) + increment);
        changed = true;
      }
      return changed ? next : current;
    });
  }, [messages, options]);

  const tracker = trackerRef.current;
  if (tracker?.scopeKey !== options.scopeKey) return EMPTY_GROWTH;

  // Hide stale growth during the render that schedules an authoritative rebase;
  // the effect commits the same deletion immediately afterward.
  const pendingRebases = new Set<ChannelMessageId>();
  const authoritativeRootIds = new Set(
    (options.authoritativeRoots ?? []).map((entry) => entry.message.id)
  );
  if (tracker.fullSnapshotRevision !== options.fullSnapshotRevision) {
    for (const root of rootsIn(messages)) pendingRebases.add(root.id);
  }
  for (const root of rootsIn(messages)) {
    if (authoritativeRootIds.has(root.id)) continue;
    const floor = tracker.rootFloors.get(root.id);
    if (floor === undefined || floor !== (root.replyCount ?? 0)) {
      pendingRebases.add(root.id);
    }
  }
  for (const entry of options.authoritativeRoots ?? []) {
    const root = entry.message;
    if (
      tracker.rootFloors.get(root.id) !== (root.replyCount ?? 0) ||
      tracker.authoritativeRootRevisions.get(root.id) !== entry.revision
    ) {
      pendingRebases.add(root.id);
    }
  }
  if (pendingRebases.size === 0) return growth;
  const effective = new Map(growth);
  for (const rootId of pendingRebases) effective.delete(rootId);
  return effective;
}
