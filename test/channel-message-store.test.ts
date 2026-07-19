import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import {
  buildChannelThreadHistorySql,
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

describe('channel-message-store schema migration', () => {
  it('widens v1 status safely and preserves durable rows', () => {
    const file = dbPath();
    const legacy = new Database(file);
    legacy.exec(`
      CREATE TABLE schema_version (version INTEGER NOT NULL);
      INSERT INTO schema_version VALUES (1);
      CREATE TABLE channel_messages (
        id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, seq INTEGER NOT NULL,
        kind TEXT NOT NULL DEFAULT 'message' CHECK (kind IN ('message','system')),
        status TEXT NOT NULL DEFAULT 'complete'
          CHECK (status IN ('streaming','complete','interrupted','failed')),
        sender_kind TEXT NOT NULL CHECK (sender_kind IN ('human','agent','system')),
        sender_id TEXT NOT NULL, sender_display TEXT, thread_id TEXT,
        parent_message_id TEXT, body_text TEXT NOT NULL DEFAULT '',
        body_format TEXT NOT NULL DEFAULT 'markdown', meta_json TEXT,
        source_session_id TEXT, source_turn_id TEXT, source_item_id TEXT,
        client_message_id TEXT, created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL, completed_at TEXT,
        UNIQUE (channel_id, seq)
      );
      CREATE INDEX idx_chm_channel_seq ON channel_messages(channel_id, seq);
      CREATE INDEX idx_chm_thread ON channel_messages(thread_id, seq)
        WHERE thread_id IS NOT NULL;
      CREATE UNIQUE INDEX idx_chm_source_dedupe
        ON channel_messages(source_session_id, source_turn_id, source_item_id)
        WHERE source_session_id IS NOT NULL;
      CREATE UNIQUE INDEX idx_chm_client_dedupe
        ON channel_messages(channel_id, sender_id, client_message_id)
        WHERE client_message_id IS NOT NULL;
      CREATE TABLE channel_members (
        channel_id TEXT NOT NULL, member_kind TEXT NOT NULL,
        member_id TEXT NOT NULL, joined_at TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        PRIMARY KEY (channel_id, member_kind, member_id)
      );
      CREATE TABLE channel_agent_bindings (
        channel_id TEXT NOT NULL, agent_framework TEXT NOT NULL,
        session_id TEXT, provider_session_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        PRIMARY KEY (channel_id, agent_framework)
      );
      INSERT INTO channel_messages VALUES (
        'chm:legacy', 'topic:migration', 1, 'message', 'complete',
        'agent', 'agent:codex', NULL, NULL, NULL, 'preserved', 'markdown',
        NULL, 'session', 'turn', 'item', NULL,
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z',
        '2026-01-01T00:00:00.000Z'
      );
    `);
    legacy.close();

    const migrated = store(file);
    expect(migrated.getMessage('chm:legacy')?.body.text).toBe('preserved');
    const stream = migrated.beginStream({
      channelId: 'topic:migration',
      sender: AGENT,
      source: { sessionId: 'session', turnId: 'turn-2', itemId: 'item-2' },
    });
    expect(
      migrated.finalizeStream(stream.id, {
        text: 'partial',
        status: 'truncated',
        truncated: true,
      })
    ).toMatchObject({
      status: 'truncated',
      truncated: true,
      meta: { truncationReason: 'size-limit' },
    });

    const inspect = new Database(file, { readonly: true });
    cleanup.push(() => inspect.close());
    expect(
      (
        inspect.prepare('SELECT version FROM schema_version').get() as {
          version: number;
        }
      ).version
    ).toBe(2);
  });
});

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

  it('returns one finalized row when a source triple is replayed through another store handle', () => {
    const p = dbPath();
    const firstStore = store(p);
    const replayStore = store(p);
    const source = { sessionId: 'sess-1', turnId: 't1', itemId: 'a1' };
    const first = firstStore.beginStream({
      channelId: 'topic:c',
      sender: AGENT,
      source,
      text: 'partial',
    });
    firstStore.finalizeStream(first.id, {
      text: 'durable',
      status: 'complete',
    });

    const replay = replayStore.beginStream({
      channelId: 'topic:c',
      sender: AGENT,
      source,
      text: 'duplicate replay',
    });

    expect(replay.id).toBe(first.id);
    expect(replay.status).toBe('complete');
    expect(replay.body.text).toBe('durable');
    expect(replayStore.history('topic:c')).toHaveLength(1);
    expect(replayStore.getChannelSummary('topic:c')?.messageCount).toBe(1);
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
      status: 'truncated',
      truncated: true,
    });
    expect(final?.truncated).toBe(true);
    expect(final?.meta).toMatchObject({ truncationReason: 'size-limit' });
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

  it('keeps replyCount on point reads, finalization rows, and resync replacements', () => {
    const s = store();
    const root = s.beginStream({
      channelId: 'topic:c',
      sender: AGENT,
      source: {
        sessionId: 'root-session',
        turnId: 'root-turn',
        itemId: 'root',
      },
    });
    s.finalizeStream(root.id, { text: 'root', status: 'complete' });
    const statuses = ['complete', 'failed', 'interrupted'] as const;
    for (const [index, status] of statuses.entries()) {
      const reply = s.beginStream({
        channelId: 'topic:c',
        sender: AGENT,
        source: {
          sessionId: `reply-session-${index}`,
          turnId: `reply-turn-${index}`,
          itemId: `reply-${index}`,
        },
        parentMessageId: root.id,
      });
      s.finalizeStream(reply.id, { text: status, status });
    }
    const streaming = s.beginStream({
      channelId: 'topic:c',
      sender: AGENT,
      source: {
        sessionId: 'reply-session-stream',
        turnId: 'reply-turn-stream',
        itemId: 'reply-stream',
      },
      parentMessageId: root.id,
    });
    expect(streaming.status).toBe('streaming');

    // replyCount intentionally includes every persisted reply status: a thread
    // badge counts rows, not only cleanly completed agent output.
    expect(s.getMessage(root.id)?.replyCount).toBe(4);
    expect(
      s.finalizeStream(root.id, { text: 'ignored', status: 'failed' })
        ?.replyCount
    ).toBe(4);
    expect(
      s
        .listResyncRows('topic:c', Number.MAX_SAFE_INTEGER, 500)
        .find((message) => message.id === root.id)?.replyCount
    ).toBe(4);
  });

  it('derives reply and channel counts from distinct durable source rows', () => {
    const p = dbPath();
    const s = store(p);
    const root = s.appendComplete({
      channelId: 'topic:c',
      sender: HUMAN,
      text: 'root',
    });
    const reply = s.beginStream({
      channelId: 'topic:c',
      sender: AGENT,
      source: { sessionId: 'sess-1', turnId: 'turn-1', itemId: 'item-1' },
      parentMessageId: root.id,
    });
    s.finalizeStream(reply.id, { text: 'reply', status: 'complete' });

    // Mutation-shaped fixture: bypass the public idempotent insert and inject a
    // physical replay of the same source row. Derived counters must still count
    // the durable source identity once.
    const raw = new Database(p);
    cleanup.push(() => raw.close());
    raw.exec('DROP INDEX idx_chm_source_dedupe');
    raw
      .prepare(
        `INSERT INTO channel_messages (
           id, channel_id, seq, kind, status, sender_kind, sender_id,
           sender_display, thread_id, parent_message_id, body_text, body_format,
           meta_json, source_session_id, source_turn_id, source_item_id,
           client_message_id, created_at, updated_at, completed_at
         )
         SELECT @duplicateId, channel_id, @duplicateSeq, kind, status,
                sender_kind, sender_id, sender_display, thread_id,
                parent_message_id, body_text, body_format, meta_json,
                source_session_id, source_turn_id, source_item_id,
                client_message_id, created_at, updated_at, completed_at
           FROM channel_messages WHERE id = @sourceId`
      )
      .run({
        duplicateId: 'chm:duplicate-source-replay',
        duplicateSeq: 3,
        sourceId: reply.id,
      });

    expect(s.history('topic:c')).toHaveLength(3);
    expect(s.getMessage(root.id)?.replyCount).toBe(1);
    expect(s.getChannelSummary('topic:c')?.messageCount).toBe(2);
    expect(s.listChannelSummaries()[0]?.messageCount).toBe(2);
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

  it('inherits thread_id from parent and validates parent identity/channel', () => {
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
    try {
      s.appendComplete({
        channelId: 'topic:other',
        sender: HUMAN,
        text: 'x',
        parentMessageId: root.id,
      });
      throw new Error('expected cross-channel parent rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(ChannelMessageStoreError);
      expect((error as ChannelMessageStoreError).status).toBe(409);
      expect((error as ChannelMessageStoreError).code).toBe(
        'parent_channel_mismatch'
      );
    }
    try {
      s.appendComplete({
        channelId: 'topic:c',
        sender: HUMAN,
        text: 'x',
        parentMessageId: 'chm:missing',
      });
      throw new Error('expected missing parent rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(ChannelMessageStoreError);
      expect((error as ChannelMessageStoreError).status).toBe(404);
      expect((error as ChannelMessageStoreError).code).toBe(
        'parent_message_not_found'
      );
    }

    const history = s.history('topic:c');
    expect(history.find((message) => message.id === root.id)?.replyCount).toBe(
      2
    );
    expect(
      s.threadHistory('topic:c', root.id).map((message) => message.id)
    ).toEqual([root.id, reply.id, nested.id]);
  });

  it('plans thread history as a root PK probe plus thread-index range', () => {
    const p = dbPath();
    const s = store(p);
    const root = s.appendComplete({
      channelId: 'topic:c',
      sender: HUMAN,
      text: 'root',
    });
    s.appendComplete({
      channelId: 'topic:c',
      sender: HUMAN,
      text: 'reply',
      parentMessageId: root.id,
    });

    const raw = new Database(p, { readonly: true });
    cleanup.push(() => raw.close());
    // EXPLAIN the exact production query: one root-id lookup plus a range over
    // idx_chm_thread, never a hand-copied approximation or channel walk.
    const plan = raw
      .prepare(`EXPLAIN QUERY PLAN ${buildChannelThreadHistorySql('after')}`)
      .all({
        rootMessageId: root.id,
        channelId: 'topic:c',
        afterSeq: 0,
        limit: 51,
      }) as Array<{ detail: string }>;
    const details = plan.map((row) => row.detail).join('\n');
    expect(details).toMatch(/SEARCH root USING INDEX .*\(id=\?\)/);
    expect(details).toMatch(
      /SEARCH thread_reply USING INDEX idx_chm_thread \(thread_id=\? AND seq>\?\)/
    );
    expect(details).not.toContain('idx_chm_channel_seq');
    expect(details).not.toMatch(/SCAN (?:root|thread_reply)/);
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
  it('marks stale streaming rows truncated by restart and appends a system message', () => {
    const s = store();
    const stuck = s.beginStream({
      channelId: 'topic:c',
      sender: AGENT,
      source: { sessionId: 'sess-1' },
    });
    const results = s.sweepStaleStreaming();
    expect(results).toHaveLength(1);
    expect(results[0]?.truncatedIds).toContain(stuck.id);
    expect(s.getMessage(stuck.id)).toMatchObject({
      status: 'truncated',
      meta: { truncationReason: 'restart' },
    });
    expect(s.getMessage(stuck.id)?.truncated).toBeUndefined();
    const system = s.getMessage(results[0]!.systemMessage.id);
    expect(system?.kind).toBe('system');
    expect(system?.sender.kind).toBe('system');
    expect(system?.body.text).toContain('restarted before terminal output');
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
