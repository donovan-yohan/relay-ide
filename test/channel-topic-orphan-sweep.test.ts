import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createChannelMessageStore } from '../server/channel-message-store.js';
import { createWorkspaceTopicStore } from '../server/workspace-topics.js';
import {
  WORKSPACE_TOPICS_MAX_LIST_ENTRIES,
  createWorkspaceTopicId,
  mintWorkspaceTopicId,
} from '../shared/workspace-topics.js';
import type { ChannelSenderRef } from '../shared/channel-chat-protocol.js';

const cleanup: Array<() => void> = [];

afterEach(() => {
  while (cleanup.length > 0) cleanup.pop()?.();
});

const HUMAN: ChannelSenderRef = { kind: 'human', id: 'human:operator' };

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-orphan-sweep-'));
  cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

describe('channel orphan sweep vs. capped topic list', () => {
  it('keeps channel messages for topics that rank beyond the 200-row list() cap', () => {
    const dir = tmpDir();
    // Monotonic clock so `updated_at DESC` ordering is deterministic — the
    // oldest-created topics fall out of the top-200 list() window.
    let tick = 0;
    const topicStore = createWorkspaceTopicStore({
      dbPath: path.join(dir, 'workspace-topics.db'),
      now: () => new Date(1_700_000_000_000 + tick++ * 1000).toISOString(),
    });
    cleanup.push(() => topicStore.close());
    const store = createChannelMessageStore(path.join(dir, 'channel-chat.db'));
    cleanup.push(() => store.close());

    const total = WORKSPACE_TOPICS_MAX_LIST_ENTRIES + 5; // 205, under the 500 store cap
    const ids: string[] = [];
    for (let i = 0; i < total; i++) {
      ids.push(topicStore.create({ workspaceId: 'ws', title: `T${i}` }).id);
    }

    // list() silently caps at 200; listAllTopicIds() returns the full 205.
    const capped = topicStore.list({ includeArchived: true });
    expect(capped).toHaveLength(WORKSPACE_TOPICS_MAX_LIST_ENTRIES);
    expect(topicStore.listAllTopicIds()).toHaveLength(total);

    // The oldest-created topic is a live, persisted channel — but absent from the
    // capped window. Post a channel message to it.
    const cappedIds = new Set(capped.map((t) => t.id));
    const evicted = ids[0]!;
    expect(cappedIds.has(evicted)).toBe(false); // the buggy path would sweep it
    store.appendComplete({
      channelId: evicted,
      sender: HUMAN,
      text: 'keep me',
    });

    // The FIXED boot sweep enumerates all ids uncapped, so the message survives.
    const result = store.sweepOrphans(new Set(topicStore.listAllTopicIds()));
    expect(result.channelsDeleted).not.toContain(evicted);
    expect(store.history(evicted)).toHaveLength(1);
  });

  // #1287 slice 4: existing title-slugged rows are grandfathered untouched.
  // Both id shapes are just opaque strings to the channel store.
  it('sweeps and keys transcripts identically for legacy slug ids and minted ids', () => {
    const dir = tmpDir();
    let tick = 0;
    const topicStore = createWorkspaceTopicStore({
      dbPath: path.join(dir, 'workspace-topics.db'),
      now: () => new Date(1_700_000_000_000 + tick++ * 1000).toISOString(),
    });
    cleanup.push(() => topicStore.close());
    const store = createChannelMessageStore(path.join(dir, 'channel-chat.db'));
    cleanup.push(() => store.close());

    // A row minted before this slice: id === slug(workspaceId + '-' + title).
    const legacyId = createWorkspaceTopicId('Fix bug #12', 'ws:alpha');
    expect(legacyId).toBe('topic:ws-alpha-fix-bug-12');
    const legacy = topicStore.create({
      id: legacyId,
      workspaceId: 'ws:alpha',
      title: 'Fix bug #12',
    });
    // A row minted after: same workspace, same title, opaque id.
    const minted = topicStore.create({
      workspaceId: 'ws:alpha',
      title: 'Fix bug #12',
    });
    const gone = mintWorkspaceTopicId();

    for (const channelId of [legacy.id, minted.id, gone]) {
      store.appendComplete({ channelId, sender: HUMAN, text: 'hello' });
    }
    // Transcripts key off the id, so the two same-titled channels stay separate.
    expect(store.history(legacy.id)).toHaveLength(1);
    expect(store.history(minted.id)).toHaveLength(1);

    // A rename touches display only; the sweep still recognizes the id.
    expect(topicStore.update(legacy.id, { title: 'Renamed' })?.id).toBe(
      legacyId
    );

    const result = store.sweepOrphans(new Set(topicStore.listAllTopicIds()));
    expect(result.channelsDeleted).toEqual([gone]);
    expect(store.history(legacy.id)).toHaveLength(1);
    expect(store.history(minted.id)).toHaveLength(1);
    expect(store.history(gone)).toHaveLength(0);
  });
});
