import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createChannelMessageStore,
  ChannelMessageStoreError,
  type ChannelMessageStore,
} from '../server/channel-message-store.js';
import type { ChannelSenderRef } from '../shared/channel-chat-protocol.js';

const cleanup: Array<() => void> = [];

afterEach(() => {
  while (cleanup.length > 0) cleanup.pop()?.();
});

function dbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-channel-store-'));
  cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'channel-chat.db');
}

function store(pathOverride?: string): ChannelMessageStore {
  const s = createChannelMessageStore(pathOverride ?? dbPath());
  cleanup.push(() => s.close());
  return s;
}

const HUMAN: ChannelSenderRef = { kind: 'human', id: 'human:operator' };
const AGENT: ChannelSenderRef = {
  kind: 'agent',
  id: 'agent:claude',
  providerId: 'claude',
};

describe('channel-message-store seq allocation', () => {
  it('assigns strictly monotonic, gap-free seq per channel across interleaved channels', () => {
    const s = store();
    const seqA: number[] = [];
    const seqB: number[] = [];
    for (let i = 0; i < 5; i++) {
      seqA.push(
        s.appendComplete({ channelId: 'topic:a', sender: HUMAN, text: `a${i}` })
          .seq
      );
      seqB.push(
        s.appendComplete({ channelId: 'topic:b', sender: HUMAN, text: `b${i}` })
          .seq
      );
    }
    expect(seqA).toEqual([1, 2, 3, 4, 5]);
    expect(seqB).toEqual([1, 2, 3, 4, 5]);
    expect(s.latestSeq('topic:a')).toBe(5);
  });

  it('allocates gap-free seq across two store handles on one db file and surfaces UNIQUE loudly', () => {
    const p = dbPath();
    const a = store(p);
    const b = store(p);
    const seqs: number[] = [];
    for (let i = 0; i < 6; i++) {
      seqs.push(
        a.appendComplete({
          channelId: 'topic:shared',
          sender: HUMAN,
          text: `a${i}`,
        }).seq
      );
      seqs.push(
        b.appendComplete({
          channelId: 'topic:shared',
          sender: HUMAN,
          text: `b${i}`,
        }).seq
      );
    }
    const sorted = [...seqs].sort((x, y) => x - y);
    expect(sorted).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]); // gap-free, unique
    expect(new Set(seqs).size).toBe(12);

    // The UNIQUE(channel_id, seq) backstop turns any residual race into a loud
    // constraint failure rather than a silent reorder.
    const raw = new Database(p);
    cleanup.push(() => raw.close());
    expect(() =>
      raw
        .prepare(
          `INSERT INTO channel_messages
             (id, channel_id, seq, kind, status, sender_kind, sender_id, body_text, body_format, created_at, updated_at)
           VALUES (?, 'topic:shared', 1, 'message', 'complete', 'human', 'human:operator', 'dup', 'markdown', 't', 't')`
        )
        .run('chm:dup')
    ).toThrow(/UNIQUE/);
  });
});

describe('channel-message-store streaming lifecycle', () => {
  it('keeps id/seq stable through begin → flush → finalize', () => {
    const s = store();
    const begun = s.beginStream({
      channelId: 'topic:c',
      sender: AGENT,
      source: { sessionId: 'sess-1', turnId: 't1', itemId: 'a1' },
    });
    expect(begun.status).toBe('streaming');
    const flushed = s.updateStreamText(begun.id, 'partial text');
    expect(flushed?.id).toBe(begun.id);
    expect(flushed?.seq).toBe(begun.seq);
    expect(flushed?.body.text).toBe('partial text');
    const final = s.finalizeStream(begun.id, {
      text: 'final text',
      status: 'complete',
    });
    expect(final?.id).toBe(begun.id);
    expect(final?.seq).toBe(begun.seq);
    expect(final?.status).toBe('complete');
    expect(final?.body.text).toBe('final text');
    expect(final?.completedAt).toBeTruthy();
  });

  it('finalizing an already-final row is an idempotent no-op', () => {
    const s = store();
    const begun = s.beginStream({
      channelId: 'topic:c',
      sender: AGENT,
      source: { sessionId: 'sess-1', turnId: 't1', itemId: 'a1' },
    });
    s.finalizeStream(begun.id, { text: 'done', status: 'complete' });
    const replay = s.finalizeStream(begun.id, {
      text: 'OVERWRITE',
      status: 'failed',
    });
    expect(replay?.status).toBe('complete');
    expect(replay?.body.text).toBe('done');
  });

  it('dedupes beginStream by source triple (one row)', () => {
    const s = store();
    const one = s.beginStream({
      channelId: 'topic:c',
      sender: AGENT,
      source: { sessionId: 'sess-1', turnId: 't1', itemId: 'a1' },
    });
    const two = s.beginStream({
      channelId: 'topic:c',
      sender: AGENT,
      source: { sessionId: 'sess-1', turnId: 't1', itemId: 'a1' },
    });
    expect(two.id).toBe(one.id);
    expect(s.history('topic:c')).toHaveLength(1);
  });

  it('persists a truncation marker on force-finalize', () => {
    const s = store();
    const begun = s.beginStream({
      channelId: 'topic:c',
      sender: AGENT,
      source: { sessionId: 'sess-1' },
    });
    const final = s.finalizeStream(begun.id, {
      text: 'capped',
      status: 'complete',
      truncated: true,
    });
    expect(final?.truncated).toBe(true);
    expect(s.getMessage(begun.id)?.truncated).toBe(true);
  });

  it('listResyncRows returns agent-origin rows at/below the cursor in current state', () => {
    const s = store();
    s.appendComplete({ channelId: 'topic:c', sender: HUMAN, text: 'human' }); // seq 1, no source
    const stream = s.beginStream({
      channelId: 'topic:c',
      sender: AGENT,
      source: { sessionId: 'x', turnId: 't', itemId: 'i' },
    }); // seq 2, agent-origin
    s.appendComplete({ channelId: 'topic:c', sender: HUMAN, text: 'later' }); // seq 3

    // Only the agent stream row is a resync candidate (human posts never go stale).
    const before = s.listResyncRows('topic:c', 3, 500);
    expect(before.map((m) => m.seq)).toEqual([2]);
    expect(before[0]?.status).toBe('streaming');

    // After it finalizes, the SAME query returns its final state — this is what
    // lets reconnect catch-up heal a stream that finalized while disconnected.
    s.finalizeStream(stream.id, { text: 'done', status: 'complete' });
    const after = s.listResyncRows('topic:c', 3, 500);
    expect(after[0]?.status).toBe('complete');
    expect(after[0]?.body.text).toBe('done');

    // A cursor below the agent row excludes it.
    expect(s.listResyncRows('topic:c', 1, 500)).toHaveLength(0);
  });
});

describe('channel-message-store posts, threads, idempotency', () => {
  it('returns the original row for a repeated clientMessageId', () => {
    const s = store();
    const first = s.appendComplete({
      channelId: 'topic:c',
      sender: HUMAN,
      text: 'hello',
      clientMessageId: 'client-1',
    });
    const second = s.appendComplete({
      channelId: 'topic:c',
      sender: HUMAN,
      text: 'hello again',
      clientMessageId: 'client-1',
    });
    expect(second.id).toBe(first.id);
    expect(second.body.text).toBe('hello');
    expect(s.history('topic:c')).toHaveLength(1);
  });

  it('inherits thread_id from parent and rejects a cross-channel parent', () => {
    const s = store();
    const root = s.appendComplete({
      channelId: 'topic:c',
      sender: HUMAN,
      text: 'root',
    });
    expect(root.threadId).toBeNull();
    const reply = s.appendComplete({
      channelId: 'topic:c',
      sender: HUMAN,
      text: 'reply',
      parentMessageId: root.id,
    });
    expect(reply.threadId).toBe(root.id);
    const nested = s.appendComplete({
      channelId: 'topic:c',
      sender: HUMAN,
      text: 'nested',
      parentMessageId: reply.id,
    });
    expect(nested.threadId).toBe(root.id);
    expect(() =>
      s.appendComplete({
        channelId: 'topic:other',
        sender: HUMAN,
        text: 'x',
        parentMessageId: root.id,
      })
    ).toThrow(ChannelMessageStoreError);
  });

  it('rejects a body over the 256KB cap', () => {
    const s = store();
    const big = 'x'.repeat(256 * 1024 + 1);
    expect(() =>
      s.appendComplete({ channelId: 'topic:c', sender: HUMAN, text: big })
    ).toThrow(/256KB|too large/i);
  });

  it('paginates history via beforeSeq/afterSeq/limit', () => {
    const s = store();
    for (let i = 1; i <= 10; i++) {
      s.appendComplete({ channelId: 'topic:c', sender: HUMAN, text: `m${i}` });
    }
    const newest = s.history('topic:c', { limit: 3 });
    expect(newest.map((m) => m.seq)).toEqual([8, 9, 10]);
    const older = s.history('topic:c', { beforeSeq: 8, limit: 3 });
    expect(older.map((m) => m.seq)).toEqual([5, 6, 7]);
    const after = s.history('topic:c', { afterSeq: 7, limit: 10 });
    expect(after.map((m) => m.seq)).toEqual([8, 9, 10]);
  });

  it('summarizes channels with latestSeq, count and preview', () => {
    const s = store();
    s.appendComplete({ channelId: 'topic:c', sender: HUMAN, text: 'first' });
    s.appendComplete({ channelId: 'topic:c', sender: AGENT, text: 'second' });
    const summaries = s.listChannelSummaries();
    const c = summaries.find((x) => x.channelId === 'topic:c');
    expect(c?.latestSeq).toBe(2);
    expect(c?.messageCount).toBe(2);
    expect(c?.lastMessage?.preview).toBe('second');
  });
});

describe('channel-message-store members and bindings', () => {
  it('upserts and lists members and finds a DM channel', () => {
    const s = store();
    s.upsertMember({
      channelId: 'topic:dm',
      kind: 'human',
      id: 'human:operator',
    });
    s.upsertMember({
      channelId: 'topic:dm',
      kind: 'agent',
      id: 'agent:claude',
    });
    s.upsertMember({
      channelId: 'topic:dm',
      kind: 'agent',
      id: 'agent:claude',
    }); // idempotent
    expect(s.listMembers('topic:dm')).toHaveLength(2);
    expect(s.findDmChannel('human:operator', 'agent:claude')).toBe('topic:dm');
    expect(s.findDmChannel('human:operator', 'agent:codex')).toBeNull();
  });

  it('stores and reads agent bindings (slice-4 landing pad)', () => {
    const s = store();
    const created = s.upsertBinding({
      channelId: 'topic:c',
      agentFramework: 'claude',
      providerSession: { claudeSessionId: 'abc' },
    });
    expect(created.sessionId).toBeNull();
    const updated = s.upsertBinding({
      channelId: 'topic:c',
      agentFramework: 'claude',
      sessionId: 'sess-9',
    });
    expect(updated.sessionId).toBe('sess-9');
    expect(updated.providerSession).toEqual({ claudeSessionId: 'abc' });
  });
});

describe('channel-message-store boot sweeps', () => {
  it('flips stale streaming rows to interrupted and appends a system message', () => {
    const s = store();
    const stuck = s.beginStream({
      channelId: 'topic:c',
      sender: AGENT,
      source: { sessionId: 'sess-1' },
    });
    const results = s.sweepStaleStreaming();
    expect(results).toHaveLength(1);
    expect(results[0]?.interruptedIds).toContain(stuck.id);
    expect(s.getMessage(stuck.id)?.status).toBe('interrupted');
    const system = s.getMessage(results[0]!.systemMessage.id);
    expect(system?.kind).toBe('system');
    expect(system?.sender.kind).toBe('system');
  });

  it('sweeps orphaned rows for channel ids not in the persisted topic set', () => {
    const s = store();
    s.appendComplete({ channelId: 'topic:live', sender: HUMAN, text: 'keep' });
    s.appendComplete({
      channelId: 'topic:gone',
      sender: HUMAN,
      text: 'orphan',
    });
    s.upsertMember({
      channelId: 'topic:gone',
      kind: 'human',
      id: 'human:operator',
    });
    const result = s.sweepOrphans(new Set(['topic:live']));
    expect(result.channelsDeleted).toEqual(['topic:gone']);
    expect(result.messagesDeleted).toBe(1);
    expect(s.history('topic:gone')).toHaveLength(0);
    expect(s.history('topic:live')).toHaveLength(1);
    expect(s.listMembers('topic:gone')).toHaveLength(0);
  });
});
