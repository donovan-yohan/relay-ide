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
import { builtInAgentProfileId } from '../shared/agent-profile.js';

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
  it('migrates a v2 binding to its built-in profile without changing durable fields on reopen', () => {
    const file = dbPath();
    const legacy = new Database(file);
    legacy.exec(`
      CREATE TABLE schema_version (version INTEGER NOT NULL);
      INSERT INTO schema_version VALUES (2);
      CREATE TABLE channel_messages (
        id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, seq INTEGER NOT NULL,
        kind TEXT NOT NULL, status TEXT NOT NULL, sender_kind TEXT NOT NULL,
        sender_id TEXT NOT NULL, sender_display TEXT, thread_id TEXT,
        parent_message_id TEXT, body_text TEXT NOT NULL, body_format TEXT NOT NULL,
        meta_json TEXT, source_session_id TEXT, source_turn_id TEXT,
        source_item_id TEXT, client_message_id TEXT, created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL, completed_at TEXT, UNIQUE(channel_id, seq)
      );
      CREATE TABLE channel_members (
        channel_id TEXT NOT NULL, member_kind TEXT NOT NULL, member_id TEXT NOT NULL,
        joined_at TEXT NOT NULL, metadata_json TEXT NOT NULL DEFAULT '{}',
        PRIMARY KEY(channel_id, member_kind, member_id)
      );
      CREATE UNIQUE INDEX idx_chm_source_dedupe
        ON channel_messages(source_session_id, source_turn_id, source_item_id)
        WHERE source_session_id IS NOT NULL
          AND source_turn_id IS NOT NULL
          AND source_item_id IS NOT NULL;
      CREATE UNIQUE INDEX idx_chm_client_dedupe
        ON channel_messages(channel_id, sender_id, client_message_id)
        WHERE client_message_id IS NOT NULL;
      CREATE TABLE channel_agent_bindings (
        channel_id TEXT NOT NULL, agent_framework TEXT NOT NULL,
        session_id TEXT, provider_session_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        PRIMARY KEY (channel_id, agent_framework)
      );
      INSERT INTO channel_agent_bindings VALUES (
        'topic:v2', 'claude', 'sess-v2', '{"lastDeliveredSeq":7}',
        '2026-07-01T00:00:00.000Z', '2026-07-02T00:00:00.000Z'
      );
    `);
    legacy.close();

    const migrated = store(file);
    const profileId = builtInAgentProfileId('claude');
    expect(migrated.getBinding('topic:v2', profileId)).toMatchObject({
      profileActorId: profileId,
      agentFramework: 'claude',
      sessionId: 'sess-v2',
      providerSession: { lastDeliveredSeq: 7 },
      createdAt: '2026-07-01T00:00:00.000Z',
      updatedAt: '2026-07-02T00:00:00.000Z',
    });
    const reopened = store(file);
    expect(reopened.getBinding('topic:v2', profileId)).toMatchObject({
      sessionId: 'sess-v2',
      providerSession: { lastDeliveredSeq: 7 },
      createdAt: '2026-07-01T00:00:00.000Z',
      updatedAt: '2026-07-02T00:00:00.000Z',
    });
    const inspect = new Database(file, { readonly: true });
    cleanup.push(() => inspect.close());
    expect(
      inspect
        .prepare('SELECT COUNT(*) AS count FROM channel_agent_bindings')
        .get()
    ).toEqual({ count: 1 });
  });

  it('widens v1 status, heals its known aliases, and preserves durable rows through v3', () => {
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
      INSERT INTO channel_messages VALUES (
        'chm:claude-live-keeper', 'topic:live-heal', 1, 'message', 'complete',
        'agent', 'agent:claude', 'claude', NULL, NULL,
        'synthetic live duplicate', 'markdown', '{"providerId":"claude"}',
        'session-live', 'turn-live', 'msg-turn-live-provider-1', NULL,
        '2026-07-18T12:00:12.892Z', '2026-07-18T12:00:12.892Z',
        '2026-07-18T12:00:12.892Z'
      );
      INSERT INTO channel_messages VALUES (
        'chm:claude-live-duplicate', 'topic:live-heal', 2, 'message', 'complete',
        'agent', 'agent:claude', 'claude', NULL, NULL,
        'synthetic live duplicate', 'markdown', '{"providerId":"claude"}',
        'session-live', 'turn-live', 'msg-turn-live-provider-0', NULL,
        '2026-07-18T12:00:12.893Z', '2026-07-18T12:00:12.893Z',
        '2026-07-18T12:00:12.891Z'
      );
      INSERT INTO channel_messages VALUES (
        'chm:reply-to-duplicate', 'topic:live-heal', 3, 'message', 'complete',
        'human', 'human:operator', 'operator', 'chm:claude-live-duplicate',
        'chm:claude-live-duplicate', 'reply', 'markdown', NULL,
        NULL, NULL, NULL, NULL,
        '2026-07-18T12:00:13.000Z', '2026-07-18T12:00:13.000Z',
        '2026-07-18T12:00:13.000Z'
      );
      INSERT INTO channel_messages VALUES (
        'chm:tail', 'topic:live-heal', 4, 'message', 'complete',
        'human', 'human:operator', 'operator', NULL, NULL, 'tail', 'markdown',
        NULL, NULL, NULL, NULL, NULL,
        '2026-07-18T12:00:14.000Z', '2026-07-18T12:00:14.000Z',
        '2026-07-18T12:00:14.000Z'
      );
      INSERT INTO channel_agent_bindings VALUES (
        'topic:live-heal', 'claude', 'session-live',
        '{"claudeSessionId":"session-live","lastDeliveredSeq":3}',
        '2026-07-18T12:00:00.000Z', '2026-07-18T12:00:00.000Z'
      );
      INSERT INTO channel_messages VALUES (
        'chm:legitimate-item-0', 'topic:no-heal', 1, 'message', 'complete',
        'agent', 'agent:claude', 'claude', NULL, NULL,
        'same legitimate body', 'markdown', '{"providerId":"claude"}',
        'session-no-heal', 'turn-no-heal', 'msg-turn-no-heal-provider-0', NULL,
        '2026-07-18T12:00:20.000Z', '2026-07-18T12:00:20.000Z',
        '2026-07-18T12:00:20.000Z'
      );
      INSERT INTO channel_messages VALUES (
        'chm:legitimate-item-1', 'topic:no-heal', 2, 'message', 'complete',
        'agent', 'agent:claude', 'claude', NULL, NULL,
        'same legitimate body', 'markdown', '{"providerId":"claude"}',
        'session-no-heal', 'turn-no-heal', 'msg-turn-no-heal-provider-1', NULL,
        '2026-07-18T12:00:20.001Z', '2026-07-18T12:00:20.001Z',
        '2026-07-18T12:00:20.001Z'
      );
      INSERT INTO channel_messages VALUES (
        'chm:late-alias-1', 'topic:late-no-heal', 1, 'message', 'complete',
        'agent', 'agent:claude', 'claude', NULL, NULL,
        'same late body', 'markdown', '{"providerId":"claude"}',
        'session-late', 'turn-late', 'msg-turn-late-provider-1', NULL,
        '2026-07-18T12:00:30.000Z', '2026-07-18T12:00:30.000Z',
        '2026-07-18T12:00:30.000Z'
      );
      INSERT INTO channel_messages VALUES (
        'chm:late-alias-0', 'topic:late-no-heal', 2, 'message', 'complete',
        'agent', 'agent:claude', 'claude', NULL, NULL,
        'same late body', 'markdown', '{"providerId":"claude"}',
        'session-late', 'turn-late', 'msg-turn-late-provider-0', NULL,
        '2026-07-18T12:00:30.501Z', '2026-07-18T12:00:30.501Z',
        '2026-07-18T12:00:30.001Z'
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

    const healed = migrated.history('topic:live-heal', { limit: 20 });
    expect(healed.map((message) => [message.id, message.seq])).toEqual([
      ['chm:claude-live-keeper', 1],
      ['chm:reply-to-duplicate', 2],
      ['chm:tail', 3],
    ]);
    expect(migrated.getMessage('chm:claude-live-duplicate')).toBeNull();
    expect(migrated.getMessage('chm:reply-to-duplicate')).toMatchObject({
      threadId: 'chm:claude-live-keeper',
      parentMessageId: 'chm:claude-live-keeper',
    });
    expect(
      migrated.threadHistory('topic:live-heal', 'chm:claude-live-keeper')
    ).toHaveLength(2);
    expect(migrated.getMessage('chm:claude-live-keeper')?.replyCount).toBe(1);
    expect(
      migrated.getBinding('topic:live-heal', builtInAgentProfileId('claude'))?.providerSession[
        'lastDeliveredSeq'
      ]
    ).toBe(2);
    expect(migrated.getBinding('topic:live-heal', builtInAgentProfileId('claude'))).toMatchObject({
      profileActorId: builtInAgentProfileId('claude'),
      agentFramework: 'claude',
      sessionId: 'session-live',
    });
    expect(migrated.latestSeq('topic:live-heal')).toBe(3);
    expect(
      migrated
        .history('topic:no-heal', { limit: 20 })
        .map((message) => message.id)
    ).toEqual(['chm:legitimate-item-0', 'chm:legitimate-item-1']);
    expect(
      migrated
        .history('topic:late-no-heal', { limit: 20 })
        .map((message) => message.id)
    ).toEqual(['chm:late-alias-1', 'chm:late-alias-0']);
    expect(
      migrated.appendComplete({
        channelId: 'topic:live-heal',
        sender: HUMAN,
        text: 'post-migration',
      }).seq
    ).toBe(4);

    // Reopening the v3 database is an idempotent no-op: the healed row set,
    // references, gap-free sequence, and translated delivery cursor survive.
    const reopened = store(file);
    expect(
      reopened
        .history('topic:live-heal', { limit: 20 })
        .map((message) => [message.id, message.seq])
    ).toEqual([
      ['chm:claude-live-keeper', 1],
      ['chm:reply-to-duplicate', 2],
      ['chm:tail', 3],
      [expect.any(String), 4],
    ]);
    expect(
      reopened.getBinding('topic:live-heal', builtInAgentProfileId('claude'))?.providerSession[
        'lastDeliveredSeq'
      ]
    ).toBe(2);

    const inspect = new Database(file, { readonly: true });
    cleanup.push(() => inspect.close());
    expect(
      (
        inspect.prepare('SELECT version FROM schema_version').get() as {
          version: number;
        }
      ).version
    ).toBe(3);

    // The v3 conversion is reopen-idempotent: exactly one legacy binding is
    // backfilled, with its session and provider cursor byte-for-byte intact.
    const bindingRows = (
      inspect
        .prepare(
          'SELECT profile_actor_id, agent_framework, session_id, provider_session_json FROM channel_agent_bindings'
        )
        .all() as Array<{
        profile_actor_id: string;
        agent_framework: string;
        session_id: string | null;
        provider_session_json: string;
      }>
    );
    expect(bindingRows).toEqual([
      {
        profile_actor_id: builtInAgentProfileId('claude'),
        agent_framework: 'claude',
        session_id: 'session-live',
        provider_session_json: '{"claudeSessionId":"session-live","lastDeliveredSeq":2}',
      },
    ]);
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

  it('persists one typed agent card in place across reopen and snapshot reads', () => {
    const file = dbPath();
    const first = createChannelMessageStore(file);
    const begun = first.beginStream({
      channelId: 'topic:cards',
      sender: AGENT,
      source: { sessionId: 'sess-1', turnId: 't1', itemId: 'reason-1' },
      agentDetail: {
        itemId: 'reason-1',
        card: {
          kind: 'thought',
          title: 'thinking',
          status: 'running',
          content: 'inspect',
        },
      },
    });
    const updated = first.updateAgentDetail(begun.id, {
      itemId: 'reason-1',
      card: {
        kind: 'thought',
        title: 'inspect the channel',
        status: 'running',
        content: 'inspect the channel bridge',
      },
    });
    expect(updated?.id).toBe(begun.id);
    const finalized = first.finalizeStream(begun.id, {
      text: '',
      status: 'complete',
      agentDetail: {
        itemId: 'reason-1',
        card: {
          kind: 'thought',
          title: 'inspect the channel',
          status: 'completed',
          content: 'inspect the channel bridge',
          sizeBytes: 26,
        },
      },
    });
    expect(finalized).toMatchObject({
      id: begun.id,
      seq: begun.seq,
      agentDetail: {
        itemId: 'reason-1',
        card: { status: 'completed', content: 'inspect the channel bridge' },
      },
    });
    first.close();

    const reopened = store(file);
    expect(reopened.history('topic:cards')).toEqual([
      expect.objectContaining({
        id: begun.id,
        seq: begun.seq,
        agentDetail: expect.objectContaining({
          itemId: 'reason-1',
          card: expect.objectContaining({
            kind: 'thought',
            status: 'completed',
            content: 'inspect the channel bridge',
          }),
        }),
      }),
    ]);
  });

  it('atomically resolves a provisional detail terminal once and makes explicit terminal absorbing', () => {
    const s = store();
    const begun = s.beginStream({
      channelId: 'topic:detail-fsm',
      sender: AGENT,
      source: { sessionId: 'sess', turnId: 'turn', itemId: 'reason' },
      agentDetail: {
        itemId: 'reason',
        card: { kind: 'thought', title: 'thinking', status: 'running' },
      },
    });
    s.finalizeStream(begun.id, {
      text: '',
      status: 'complete',
      agentDetail: {
        itemId: 'reason',
        card: { kind: 'thought', title: 'thinking', status: 'completed' },
      },
      agentDetailTerminalAuthority: 'provisional',
    });
    const first = s.resolveProvisionalAgentDetailTerminal(begun.id, {
      text: '',
      status: 'failed',
      agentDetail: {
        itemId: 'reason',
        card: {
          kind: 'thought',
          title: 'provider failure',
          status: 'failed',
          content: 'explicit failure',
        },
      },
    });
    expect(first.transitioned).toBe(true);
    expect(first.message).toMatchObject({
      status: 'failed',
      agentDetail: { card: { status: 'failed', content: 'explicit failure' } },
    });

    const replay = s.resolveProvisionalAgentDetailTerminal(begun.id, {
      text: '',
      status: 'complete',
      agentDetail: {
        itemId: 'reason',
        card: {
          kind: 'thought',
          title: 'late replay',
          status: 'completed',
          content: 'must not win',
        },
      },
    });
    expect(replay.transitioned).toBe(false);
    expect(replay.message).toMatchObject({
      status: 'failed',
      agentDetail: { card: { status: 'failed', content: 'explicit failure' } },
    });
    s.updateAgentDetail(begun.id, {
      itemId: 'reason',
      card: {
        kind: 'thought',
        title: 'late streaming mutation',
        status: 'running',
      },
    });
    expect(s.getMessage(begun.id)).toMatchObject({
      status: 'failed',
      agentDetail: { card: { status: 'failed', content: 'explicit failure' } },
    });
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

  it('enforces the existing 256KB cap across body plus typed card metadata', () => {
    const s = store();
    expect(() =>
      s.beginStream({
        channelId: 'topic:bounded-card',
        sender: AGENT,
        source: { sessionId: 'sess', turnId: 'turn', itemId: 'detail' },
        text: 'x'.repeat(200 * 1024),
        agentDetail: {
          itemId: 'detail',
          card: {
            kind: 'output',
            title: 'large output',
            status: 'running',
            content: 'y'.repeat(100 * 1024),
          },
        },
      })
    ).toThrowError(
      expect.objectContaining({ code: 'channel_message_payload_too_large' })
    );
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
});

describe('channel-message-store posts, threads, idempotency', () => {
  it('round-trips image parts at the message boundary without leaking storage metadata', () => {
    const s = store();
    const image = {
      type: 'image' as const,
      id: 'cha:abc123' as const,
      mime: 'image/webp' as const,
      w: 640,
      h: 480,
      bytes: 2048,
      alt: 'whiteboard sketch',
    };
    const created = s.appendComplete({
      channelId: 'topic:c',
      sender: HUMAN,
      text: '',
      parts: [image],
    });

    expect(created.parts).toEqual([image]);
    expect(created.meta ?? {}).not.toHaveProperty('parts');
    expect(s.getMessage(created.id)).toMatchObject({
      body: { text: '' },
      parts: [image],
    });
    expect(s.history('topic:c')).toMatchObject([{ parts: [image] }]);
    expect(() =>
      s.appendComplete({
        channelId: 'topic:c',
        sender: HUMAN,
        text: '',
        parts: Array.from({ length: 5 }, () => image),
      })
    ).toThrow(/at most 4 valid image parts/);

    const maxAlt = { ...image, alt: 'a'.repeat(500) };
    expect(
      s.appendComplete({
        channelId: 'topic:c',
        sender: HUMAN,
        text: '',
        parts: [maxAlt],
      }).parts
    ).toEqual([maxAlt]);
    const oversizedAlt = { ...image, alt: 'a'.repeat(501) };
    expect(() =>
      s.appendComplete({
        channelId: 'topic:c',
        sender: HUMAN,
        text: '',
        parts: [oversizedAlt],
      })
    ).toThrow(/valid image parts/);
    expect(() =>
      s.appendComplete({
        channelId: 'topic:c',
        sender: HUMAN,
        text: '',
        meta: { parts: [oversizedAlt] },
      })
    ).toThrow(/valid image parts/);
    expect(s.history('topic:c')).toHaveLength(2);
  });

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

  it('previews the newest prose row when a turn ends on a detail card', () => {
    const s = store();
    s.appendComplete({
      channelId: 'topic:d',
      sender: HUMAN,
      text: 'first prose',
    });
    s.appendComplete({
      channelId: 'topic:d',
      sender: AGENT,
      text: 'last prose message',
    });
    // A detail card ends the turn: it persists body_text='' and is the newest
    // row, so previewing off the literal last row would blank the summary.
    const begun = s.beginStream({
      channelId: 'topic:d',
      sender: AGENT,
      source: { sessionId: 'sess-d', turnId: 't-d', itemId: 'reason-d' },
      agentDetail: {
        itemId: 'reason-d',
        card: {
          kind: 'thought',
          title: 'thinking',
          status: 'running',
          content: 'inspect',
        },
      },
    });
    s.finalizeStream(begun.id, {
      text: '',
      status: 'complete',
      agentDetail: {
        itemId: 'reason-d',
        card: {
          kind: 'thought',
          title: 'thinking',
          status: 'completed',
          content: 'inspect',
        },
      },
    });

    const viaGet = s.getChannelSummary('topic:d');
    // latestSeq stays the true highest seq (the detail card) so reconnect
    // head-checks and unread math are unaffected.
    expect(viaGet?.latestSeq).toBe(begun.seq);
    expect(viaGet?.messageCount).toBe(3);
    expect(viaGet?.lastMessage?.preview).toBe('last prose message');

    const viaList = s
      .listChannelSummaries()
      .find((x) => x.channelId === 'topic:d');
    expect(viaList?.latestSeq).toBe(begun.seq);
    expect(viaList?.messageCount).toBe(3);
    expect(viaList?.lastMessage?.preview).toBe('last prose message');
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

    // Arbitrary profile ids are real actor ids, never rewritten by a prefix
    // heuristic or legacy provider fallback.
    s.upsertBinding({
      channelId: 'topic:c',
      profileActorId: 'reviewer',
      agentFramework: 'claude',
      sessionId: 'sess-reviewer',
      providerSession: { lastDeliveredSeq: 9 },
    });
    expect(s.getBinding('topic:c', 'reviewer')).toMatchObject({
      profileActorId: 'reviewer',
      sessionId: 'sess-reviewer',
      providerSession: { lastDeliveredSeq: 9 },
    });
  });

  it('lists distinct non-null bound session ids (reaper protection) (#1248)', () => {
    const s = store();
    // Bound sessions across two channels; one binding has no session yet.
    s.upsertBinding({
      channelId: 'topic:a',
      agentFramework: 'claude',
      sessionId: 'sess-a',
    });
    s.upsertBinding({
      channelId: 'topic:b',
      agentFramework: 'codex',
      sessionId: 'sess-b',
    });
    s.upsertBinding({
      channelId: 'topic:c',
      agentFramework: 'claude',
      providerSession: { claudeSessionId: 'no-session-yet' },
    });

    const bound = s.listBoundSessionIds().sort();
    expect(bound).toEqual(['sess-a', 'sess-b']);
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

  it('atomically marks a stale detail row and its card restart-provisional', () => {
    const s = store();
    const stuck = s.beginStream({
      channelId: 'topic:restart-detail',
      sender: AGENT,
      source: { sessionId: 'sess', turnId: 'turn', itemId: 'reason' },
      agentDetail: {
        itemId: 'reason',
        card: {
          kind: 'thought',
          title: 'thinking',
          status: 'running',
          content: 'partial thought',
        },
      },
    });
    s.sweepStaleStreaming();
    expect(s.getMessage(stuck.id)).toMatchObject({
      status: 'truncated',
      meta: { truncationReason: 'restart' },
      agentDetail: {
        card: { status: 'cancelled', content: 'partial thought' },
      },
    });
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
