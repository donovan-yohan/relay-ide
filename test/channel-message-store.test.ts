import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { format } from 'node:util';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildChannelMentionContextBoundarySql,
  buildChannelMentionContextCountSql,
  buildChannelMentionContextRowsSql,
  buildChannelMessageSearchSql,
  buildChannelSearchMatchQuery,
  buildChannelThreadHistorySql,
  buildChannelThreadSummarySql,
  channelSearchPrefixRange,
  channelSearchUnavailableReason,
  createChannelMessageStore,
  registerChannelSearchTick,
  ChannelMessageStoreError,
  ChannelSearchRefusedError,
  MENTION_CONTEXT_CANDIDATE_SCAN_BUDGET,
  type ChannelMessageStore,
} from '../server/channel-message-store.js';
import {
  CHANNEL_SEARCH_MIN_QUERY_CHARS,
  CHANNEL_SEARCH_PREFIX_DOC_BUDGET,
  CHANNEL_SEARCH_PREFIX_TERM_BUDGET,
  CHANNEL_SEARCH_TIME_BUDGET_MS,
  type ChannelSenderRef,
} from '../shared/channel-chat-protocol.js';
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

function store(
  pathOverride?: string,
  options?: {
    mentionContextCandidateScanBudget?: number;
    searchTimeBudgetMs?: number;
    searchCostPreflight?: 'auto' | 'unavailable';
  }
): ChannelMessageStore {
  const s = createChannelMessageStore(pathOverride ?? dbPath(), options ?? {});
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
  it('rebuilds a v13 callback ledger without losing recoverable rows', () => {
    const file = dbPath();
    const current = store(file);
    current.createCompletionCallback({
      id: 'chcb:v13-keeper',
      channelId: 'topic:v13',
      threadId: 'chm:thread-v13',
      triggerMessageId: 'chm:trigger-v13',
      requesterProfileId: 'agent-profile:external:default',
      targetProfileId: 'agent-profile:mock:default',
      targetRuntimeId: 'runtime:mock:v13',
      targetTurnId: 'turn:v13',
    });
    current.close();
    const legacy = new Database(file);
    legacy.exec(`
      DROP INDEX IF EXISTS idx_chcc_recovery;
      DROP INDEX IF EXISTS idx_chcc_target_turn;
      DROP INDEX IF EXISTS idx_chcc_continuation_parent;
      DROP INDEX IF EXISTS idx_chcc_settled_retention;
      CREATE TABLE channel_completion_callbacks_v13 (
        id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, thread_id TEXT,
        trigger_message_id TEXT NOT NULL, requester_profile_id TEXT NOT NULL,
        target_profile_id TEXT NOT NULL, target_runtime_id TEXT NOT NULL,
        target_turn_id TEXT NOT NULL, continuation_parent_callback_id TEXT,
        awaiting_child INTEGER NOT NULL DEFAULT 0,
        pending_child_intents INTEGER NOT NULL DEFAULT 0,
        continuation_completed_at TEXT, state TEXT NOT NULL
          CHECK (state IN ('pending','satisfied','delivered','consumed')),
        terminal_reason TEXT, terminal_message_id TEXT, message_disposition TEXT,
        created_at TEXT NOT NULL, satisfied_at TEXT, delivered_at TEXT,
        consumed_at TEXT, updated_at TEXT NOT NULL,
        UNIQUE(channel_id, target_profile_id, target_turn_id)
      );
      INSERT INTO channel_completion_callbacks_v13
        (id, channel_id, thread_id, trigger_message_id, requester_profile_id,
         target_profile_id, target_runtime_id, target_turn_id,
         continuation_parent_callback_id, awaiting_child, pending_child_intents,
         continuation_completed_at, state, terminal_reason, terminal_message_id,
         message_disposition, created_at, satisfied_at, delivered_at, consumed_at,
         updated_at)
      SELECT id, channel_id, thread_id, trigger_message_id, requester_profile_id,
             target_profile_id, target_runtime_id, target_turn_id,
             continuation_parent_callback_id, awaiting_child, pending_child_intents,
             continuation_completed_at, state, terminal_reason, terminal_message_id,
             message_disposition, created_at, satisfied_at, delivered_at, consumed_at,
             updated_at
        FROM channel_completion_callbacks;
      DROP TABLE channel_completion_callbacks;
      ALTER TABLE channel_completion_callbacks_v13 RENAME TO channel_completion_callbacks;
      UPDATE schema_version SET version = 13;
    `);
    legacy.close();

    const migrated = store(file);
    expect(migrated.getCompletionCallback('chcb:v13-keeper')).toMatchObject({
      state: 'pending',
      channelId: 'topic:v13',
      threadId: 'chm:thread-v13',
      deliveryReason: null,
      undeliverableAt: null,
    });
    const inspect = new Database(file, { readonly: true });
    cleanup.push(() => inspect.close());
    expect(
      (
        inspect.prepare('SELECT version FROM schema_version').get() as {
          version: number;
        }
      ).version
    ).toBe(15);
    expect(
      (
        inspect
          .prepare('PRAGMA table_info(channel_completion_callbacks)')
          .all() as Array<{ name: string }>
      ).map((column) => column.name)
    ).toEqual(expect.arrayContaining(['delivery_reason', 'undeliverable_at']));
  });

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
      runtimeId: 'sess-v2',
      providerSession: { lastDeliveredSeq: 7 },
      createdAt: '2026-07-01T00:00:00.000Z',
      updatedAt: '2026-07-02T00:00:00.000Z',
    });
    const reopened = store(file);
    expect(reopened.getBinding('topic:v2', profileId)).toMatchObject({
      runtimeId: 'sess-v2',
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

  it('repairs missing mention-context indexes before preparing bounded reads', () => {
    const file = dbPath();
    store(file).close();
    const damaged = new Database(file);
    damaged.exec(`
      DROP INDEX idx_chm_channel_seq;
      DROP INDEX idx_chm_thread;
    `);
    damaged.close();

    // `createChannelMessageStore` prepares INDEXED BY statements before return;
    // reopening therefore proves repair happened before the bounded reads load.
    store(file).close();
    const inspect = new Database(file, { readonly: true });
    cleanup.push(() => inspect.close());
    const indexNames = (
      inspect
        .prepare(
          `SELECT name FROM sqlite_master
            WHERE type = 'index' AND name IN ('idx_chm_channel_seq', 'idx_chm_thread')
            ORDER BY name`
        )
        .all() as Array<{ name: string }>
    ).map((row) => row.name);
    expect(indexNames).toEqual(['idx_chm_channel_seq', 'idx_chm_thread']);
  });

  it('clears ambiguous v7 orchestrators, preserves sole rows, and creates the unique index', () => {
    const file = dbPath();
    store(file).close();
    const legacy = new Database(file);
    legacy.exec(`
      DROP INDEX idx_chab_sole_orchestrator;
      UPDATE schema_version SET version = 7;
      DELETE FROM channel_agent_bindings;
      INSERT INTO channel_agent_bindings VALUES
        ('topic:ambiguous', '', 'profile:a', 'claude', 'runtime:a', 'orchestrator', '{"cursor":1}', '2026-08-01', '2026-08-02'),
        ('topic:ambiguous', '', 'profile:b', 'codex', 'runtime:b', 'orchestrator', '{"cursor":2}', '2026-08-03', '2026-08-04'),
        ('topic:valid', '', 'profile:c', 'claude', 'runtime:c', 'orchestrator', '{"cursor":3}', '2026-08-05', '2026-08-06');
    `);
    legacy.close();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    cleanup.push(() => warnSpy.mockRestore());

    const migrated = store(file);
    expect(migrated.getBinding('topic:ambiguous', 'profile:a')).toMatchObject({
      role: null,
      runtimeId: 'runtime:a',
      providerSession: { cursor: 1 },
    });
    expect(migrated.getBinding('topic:ambiguous', 'profile:b')).toMatchObject({
      role: null,
      runtimeId: 'runtime:b',
      providerSession: { cursor: 2 },
    });
    expect(migrated.getSoleOrchestratorBinding('topic:valid')).toMatchObject({
      profileActorId: 'profile:c',
      role: 'orchestrator',
      providerSession: { cursor: 3 },
    });
    const warning = warnSpy.mock.calls.find(
      (call) =>
        typeof call[0] === 'string' &&
        call[0].includes('ambiguous legacy orchestrator')
    );
    expect(format(...(warning as [string, ...unknown[]]))).toBe(
      '[channel-message-store] cleared ambiguous legacy orchestrator designations before sole-role migration: channel_count=1 binding_count=2'
    );
    expect(format(...(warning as [string, ...unknown[]]))).not.toContain(
      'topic:ambiguous'
    );
    const inspect = new Database(file, { readonly: true });
    cleanup.push(() => inspect.close());
    expect(
      inspect
        .prepare(
          `SELECT name FROM sqlite_master
            WHERE type = 'index' AND name = 'idx_chab_sole_orchestrator'`
        )
        .get()
    ).toEqual({ name: 'idx_chab_sole_orchestrator' });
    expect(
      inspect
        .prepare(
          `SELECT channel_id, COUNT(*) AS count
             FROM channel_agent_bindings
            WHERE binding_role = 'orchestrator'
            GROUP BY channel_id
           HAVING COUNT(*) > 1`
        )
        .all()
    ).toEqual([]);
  });

  it.each([0, 1, 2, 3, 4, 5, 6, 7])(
    'installs the sole-orchestrator invariant from schema version %i',
    (version) => {
      const file = dbPath();
      const seeded = store(file);
      seeded.upsertBinding({
        channelId: `topic:upgrade-${version}`,
        profileActorId: 'profile:keeper',
        agentFramework: 'claude',
        runtimeId: 'runtime:keeper',
        providerSession: { cursor: version },
      });
      seeded.close();
      const legacy = new Database(file);
      legacy.exec('DROP INDEX idx_chab_sole_orchestrator');
      // Reconstruct the column names each numbered migration actually expects;
      // older schemas could not yet carry a binding role.
      if (version >= 1 && version <= 4) {
        legacy.exec(
          'ALTER TABLE channel_messages RENAME COLUMN source_runtime_id TO source_session_id'
        );
      }
      if (version >= 1 && version <= 3) {
        legacy.exec(
          'ALTER TABLE channel_agent_bindings RENAME COLUMN runtime_id TO session_id'
        );
      }
      legacy.prepare('UPDATE schema_version SET version = ?').run(version);
      legacy.close();

      const migrated = store(file);
      const expectedProfile =
        version === 1 || version === 2
          ? builtInAgentProfileId('claude')
          : 'profile:keeper';
      expect(
        migrated.getBinding(`topic:upgrade-${version}`, expectedProfile)
      ).toMatchObject({
        profileActorId: expectedProfile,
        runtimeId: 'runtime:keeper',
        role: null,
        providerSession: { cursor: version },
      });
      expect(
        migrated.getSoleOrchestratorBinding(`topic:upgrade-${version}`)
      ).toBeNull();
      migrated.designateSoleOrchestrator({
        channelId: `topic:upgrade-${version}`,
        profileActorId: expectedProfile,
        agentFramework: 'claude',
      });
      expect(() =>
        migrated.designateSoleOrchestrator({
          channelId: `topic:upgrade-${version}`,
          profileActorId: 'profile:loser',
          agentFramework: 'codex',
        })
      ).toThrowError(expect.objectContaining({ status: 409 }));
      const inspect = new Database(file, { readonly: true });
      cleanup.push(() => inspect.close());
      expect(
        inspect
          .prepare(
            `SELECT name FROM sqlite_master
              WHERE type = 'index' AND name = 'idx_chab_sole_orchestrator'`
          )
          .get()
      ).toEqual({ name: 'idx_chab_sole_orchestrator' });
      expect(
        inspect
          .prepare(
            `SELECT channel_id
               FROM channel_agent_bindings
              WHERE binding_role = 'orchestrator'
              GROUP BY channel_id
             HAVING COUNT(*) > 1`
          )
          .all()
      ).toEqual([]);
    }
  );

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
    expect(migrated.getMessage('chm:legacy')).toMatchObject({
      body: { text: 'preserved' },
      sender: { runtimeId: 'session' },
      source: {
        runtimeId: 'session',
        turnId: 'turn',
        itemId: 'item',
      },
    });
    const stream = migrated.beginStream({
      channelId: 'topic:migration',
      sender: AGENT,
      source: { runtimeId: 'runtime', turnId: 'turn-2', itemId: 'item-2' },
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
      migrated.getBinding('topic:live-heal', builtInAgentProfileId('claude'))
        ?.providerSession['lastDeliveredSeq']
    ).toBe(2);
    expect(
      migrated.getBinding('topic:live-heal', builtInAgentProfileId('claude'))
    ).toMatchObject({
      profileActorId: builtInAgentProfileId('claude'),
      agentFramework: 'claude',
      runtimeId: 'session-live',
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

    // Reopening the v5 database is an idempotent no-op: the healed row set,
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
      reopened.getBinding('topic:live-heal', builtInAgentProfileId('claude'))
        ?.providerSession['lastDeliveredSeq']
    ).toBe(2);

    const inspect = new Database(file, { readonly: true });
    cleanup.push(() => inspect.close());
    expect(
      (
        inspect.prepare('SELECT version FROM schema_version').get() as {
          version: number;
        }
      ).version
    ).toBe(15);
    expect(
      (
        inspect.prepare('PRAGMA table_info(channel_messages)').all() as Array<{
          name: string;
        }>
      ).map((column) => column.name)
    ).toContain('source_runtime_id');

    // The v5 conversion is reopen-idempotent: exactly one legacy binding is
    // backfilled, with its runtime and provider cursor byte-for-byte intact.
    const bindingRows = inspect
      .prepare(
        'SELECT profile_actor_id, agent_framework, runtime_id, provider_session_json FROM channel_agent_bindings'
      )
      .all() as Array<{
      profile_actor_id: string;
      agent_framework: string;
      runtime_id: string | null;
      provider_session_json: string;
    }>;
    expect(bindingRows).toEqual([
      {
        profile_actor_id: builtInAgentProfileId('claude'),
        agent_framework: 'claude',
        runtime_id: 'session-live',
        provider_session_json:
          '{"claudeSessionId":"session-live","lastDeliveredSeq":2}',
      },
    ]);

    // The repair is recorded as a marker row rather than an additional schema
    // bump, so re-arming remains a DELETE instead of a schema-version rewind.
    // Schema-version compatibility is governed separately. Two pairs matched
    // the SQL predicate; only the one carrying the bounded echo signature was
    // removed.
    expect(
      inspect
        .prepare('SELECT heal_id, candidates, healed FROM channel_heal_state')
        .all()
    ).toEqual([{ heal_id: 'claude-echo-alias-v1', candidates: 2, healed: 1 }]);
  });

  // #1209: the dogfood hub migrated a live db to the v2 schema and healed ZERO
  // rows, while the identical predicate healed correctly when the same db was
  // re-run offline. The reported suspect was WAL state; it is refuted by the
  // `hot, uncheckpointed WAL` case below. The real defect is structural — the
  // heal was welded to the one-shot v2 rebuild, so a db that arrived at v2 or
  // later without that exact lane running its heal could never heal again, and
  // said nothing about it. The repair is now gated on a marker ROW, so it runs
  // whenever it has not run, whatever the schema version says.
  it('heals a head-schema db that never ran the repair, and translates its cursors', () => {
    const file = dbPath();
    // Build a REAL head-schema db (search table + triggers included), clear the
    // heal marker, and plant the un-healed rows: exactly the shape #1209 found
    // in dogfood — modern schema, version stamped past the v2 heal, duplicates
    // still present.
    store(file).close();
    const seeded = new Database(file);
    seeded.exec(`
      DELETE FROM channel_heal_state;
      INSERT INTO channel_messages VALUES (
        'chm:stranded-keeper', 'topic:stranded-heal', 1, 'message', 'complete',
        'agent', 'agent:claude', 'claude', NULL, NULL,
        'unhealed echo body', 'markdown', '{"providerId":"claude"}',
        'runtime-stranded', 'turn-stranded', 'msg-turn-stranded-provider-1', NULL,
        '2026-07-19T09:00:00.100Z', '2026-07-19T09:00:00.100Z',
        '2026-07-19T09:00:00.100Z'
      );
      INSERT INTO channel_messages VALUES (
        'chm:stranded-duplicate', 'topic:stranded-heal', 2, 'message', 'complete',
        'agent', 'agent:claude', 'claude', NULL, NULL,
        'unhealed echo body', 'markdown', '{"providerId":"claude"}',
        'runtime-stranded', 'turn-stranded', 'msg-turn-stranded-provider-0', NULL,
        '2026-07-19T09:00:00.180Z', '2026-07-19T09:00:00.180Z',
        '2026-07-19T09:00:00.102Z'
      );
      INSERT INTO channel_messages VALUES (
        'chm:stranded-reply', 'topic:stranded-heal', 3, 'message', 'complete',
        'human', 'human:operator', 'operator', 'chm:stranded-duplicate',
        'chm:stranded-duplicate', 'reply to the echo', 'markdown', NULL,
        NULL, NULL, NULL, NULL,
        '2026-07-19T09:00:01.000Z', '2026-07-19T09:00:01.000Z',
        '2026-07-19T09:00:01.000Z'
      );
      INSERT INTO channel_messages VALUES (
        'chm:stranded-tail', 'topic:stranded-heal', 4, 'message', 'complete',
        'human', 'human:operator', 'operator', NULL, NULL, 'tail', 'markdown',
        NULL, NULL, NULL, NULL, NULL,
        '2026-07-19T09:00:02.000Z', '2026-07-19T09:00:02.000Z',
        '2026-07-19T09:00:02.000Z'
      );
      INSERT INTO channel_messages VALUES (
        'chm:stranded-legit-0', 'topic:stranded-no-heal', 1, 'message', 'complete',
        'agent', 'agent:claude', 'claude', NULL, NULL,
        'legitimate repeated body', 'markdown', '{"providerId":"claude"}',
        'runtime-legit', 'turn-legit', 'msg-turn-legit-provider-0', NULL,
        '2026-07-19T09:10:00.000Z', '2026-07-19T09:10:00.000Z',
        '2026-07-19T09:10:00.000Z'
      );
      INSERT INTO channel_messages VALUES (
        'chm:stranded-legit-1', 'topic:stranded-no-heal', 2, 'message', 'complete',
        'agent', 'agent:claude', 'claude', NULL, NULL,
        'legitimate repeated body', 'markdown', '{"providerId":"claude"}',
        'runtime-legit', 'turn-legit', 'msg-turn-legit-provider-1', NULL,
        '2026-07-19T09:10:00.001Z', '2026-07-19T09:10:00.001Z',
        '2026-07-19T09:10:00.001Z'
      );
      INSERT INTO channel_agent_bindings VALUES (
        'topic:stranded-heal', '', 'agent-profile:claude:default', 'claude',
        'runtime-stranded', NULL,
        '{"claudeSessionId":"runtime-stranded","lastDeliveredSeq":4}',
        '2026-07-19T08:00:00.000Z', '2026-07-19T08:00:00.000Z'
      );
      INSERT INTO channel_agent_bindings VALUES (
        'topic:stranded-heal', '', 'agent-profile:claude:reviewer', 'claude',
        'runtime-b', NULL,
        '{"claudeSessionId":"runtime-b","lastDeliveredSeq":2}',
        '2026-07-19T08:00:00.000Z', '2026-07-19T08:00:00.000Z'
      );
      INSERT INTO channel_read_state VALUES (
        'topic:stranded-heal', 3, '2026-07-19T09:00:05.000Z'
      );
    `);
    seeded.close();

    const healed = store(file);
    // The echo alias is collapsed onto the earliest durable id, its references
    // are repointed, and the channel is left gap-free.
    expect(
      healed
        .history('topic:stranded-heal', { limit: 20 })
        .map((m) => [m.id, m.seq])
    ).toEqual([
      ['chm:stranded-keeper', 1],
      ['chm:stranded-reply', 2],
      ['chm:stranded-tail', 3],
    ]);
    expect(healed.getMessage('chm:stranded-duplicate')).toBeNull();
    expect(healed.getMessage('chm:stranded-reply')).toMatchObject({
      threadId: 'chm:stranded-keeper',
      parentMessageId: 'chm:stranded-keeper',
    });
    expect(healed.getMessage('chm:stranded-keeper')?.replyCount).toBe(1);
    // A same-turn pair that does NOT carry the bounded echo signature is a
    // legitimate multi-item turn and must survive untouched.
    expect(
      healed.history('topic:stranded-no-heal', { limit: 20 }).map((m) => m.id)
    ).toEqual(['chm:stranded-legit-0', 'chm:stranded-legit-1']);
    // The removed row leaves the search index with it: the heal tears the index
    // down and `ensureChannelSearchIndex` rebuilds it from the healed rows.
    expect(
      healed.searchMessages({ query: 'unhealed' }).map((hit) => hit.messageId)
    ).toEqual(['chm:stranded-keeper']);
    // Each binding's own delivery cursor is translated: 4 -> 3 and 2 -> 1. Two
    // profiles of one provider share a channel and a framework, so a cursor
    // keyed by framework would overwrite its sibling.
    expect(
      healed.getBinding('topic:stranded-heal', 'agent-profile:claude:default')
        ?.providerSession['lastDeliveredSeq']
    ).toBe(3);
    expect(
      healed.getBinding('topic:stranded-heal', 'agent-profile:claude:reviewer')
        ?.providerSession['lastDeliveredSeq']
    ).toBe(1);
    // The operator's durable read mark is translated with the rows: it pointed
    // at `chm:stranded-reply` (seq 3 of 4) with `chm:stranded-tail` unread, and
    // it still does (seq 2 of 3). Left untranslated it would read 3 — the head —
    // and swallow the unread tail, which the head clamp in `listReadState`
    // cannot detect because the mark moved DOWN with the log, not above it.
    expect(healed.listReadState()).toEqual([
      {
        channelId: 'topic:stranded-heal',
        lastReadSeq: 2,
        updatedAt: '2026-07-19T09:00:05.000Z',
      },
    ]);

    const inspect = new Database(file, { readonly: true });
    cleanup.push(() => inspect.close());
    // The repair itself records a marker rather than owning a schema version;
    // the independent binding-role migration still advances this old fixture.
    expect(
      (
        inspect.prepare('SELECT version FROM schema_version').get() as {
          version: number;
        }
      ).version
    ).toBe(15);
    expect(
      inspect
        .prepare('SELECT heal_id, candidates, healed FROM channel_heal_state')
        .all()
    ).toEqual([{ heal_id: 'claude-echo-alias-v1', candidates: 1, healed: 1 }]);

    // Reopening is a no-op: the pass is idempotent and cannot re-collapse the
    // rows it already healed.
    const reopened = store(file);
    expect(
      reopened
        .history('topic:stranded-heal', { limit: 20 })
        .map((m) => [m.id, m.seq])
    ).toEqual([
      ['chm:stranded-keeper', 1],
      ['chm:stranded-reply', 2],
      ['chm:stranded-tail', 3],
    ]);
    expect(
      reopened.getBinding('topic:stranded-heal', 'agent-profile:claude:default')
        ?.providerSession['lastDeliveredSeq']
    ).toBe(3);
  });

  // The other half of #1209: the v2 pass logged only when it removed rows, so a
  // pass that healed nothing was indistinguishable from a pass that never ran.
  it('logs a zero heal pass so a silent no-op is visible in the hub log', () => {
    const file = dbPath();
    const seeded = store(file);
    seeded.appendComplete({
      channelId: 'topic:nothing-to-heal',
      sender: HUMAN,
      text: 'no duplicates here',
    });
    seeded.close();
    // Re-arming is a DELETE against the marker ledger — the operator recovery
    // #1209 asked for, instead of rewinding `schema_version` past migrations
    // that must not replay.
    const rearm = new Database(file);
    rearm.exec('DELETE FROM channel_heal_state');
    rearm.close();

    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    cleanup.push(() => infoSpy.mockRestore());
    store(file);
    const healLine = infoSpy.mock.calls.find(
      (call) =>
        typeof call[0] === 'string' &&
        call[0].includes('Claude echo alias heal')
    );
    expect(healLine).toBeDefined();
    expect(format(...(healLine as [string, ...unknown[]]))).toBe(
      '[channel-message-store] channel Claude echo alias heal: 0 candidate pair(s) matched, 0 duplicate row(s) removed'
    );
  });

  // A db that has already run the repair does not scan for it again: the marker
  // row is the gate, so an unrelated later boot cannot pay for the self-join or
  // print a second line about it.
  it('does not re-run or re-log the repair once the marker row exists', () => {
    const file = dbPath();
    store(file).close();

    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    cleanup.push(() => infoSpy.mockRestore());
    store(file).close();
    expect(
      infoSpy.mock.calls.filter(
        (call) =>
          typeof call[0] === 'string' &&
          call[0].includes('Claude echo alias heal')
      )
    ).toHaveLength(0);
  });

  // The repair renumbers `seq` for every row of an affected channel. With the
  // FTS sync triggers live that is one index delete + re-insert per row inside
  // the boot transaction — and on a db whose FTS TABLE was dropped while its
  // triggers survived (an operator poking at the db, a backup restored
  // mid-migration) the very first write raises `no such table:
  // channel_messages_fts` and the hub cannot boot at all. The heal therefore
  // drops the index itself and lets `ensureChannelSearchIndex` rebuild it.
  it('heals a db whose FTS table was dropped while its triggers survived', () => {
    const file = dbPath();
    store(file).close();
    const seeded = new Database(file);
    seeded.exec(`
      DELETE FROM channel_heal_state;
      INSERT INTO channel_messages VALUES (
        'chm:fts-keeper', 'topic:fts-heal', 1, 'message', 'complete',
        'agent', 'agent:claude', 'claude', NULL, NULL,
        'orphan trigger echo body', 'markdown', '{"providerId":"claude"}',
        'runtime-fts', 'turn-fts', 'msg-turn-fts-provider-1', NULL,
        '2026-07-19T11:00:00.100Z', '2026-07-19T11:00:00.100Z',
        '2026-07-19T11:00:00.100Z'
      );
      INSERT INTO channel_messages VALUES (
        'chm:fts-duplicate', 'topic:fts-heal', 2, 'message', 'complete',
        'agent', 'agent:claude', 'claude', NULL, NULL,
        'orphan trigger echo body', 'markdown', '{"providerId":"claude"}',
        'runtime-fts', 'turn-fts', 'msg-turn-fts-provider-0', NULL,
        '2026-07-19T11:00:00.180Z', '2026-07-19T11:00:00.180Z',
        '2026-07-19T11:00:00.102Z'
      );
    `);
    // Drop the index table only. All three sync triggers survive, so any write
    // to `channel_messages` now references a table that no longer exists.
    seeded.exec('DROP TABLE channel_messages_fts');
    expect(
      seeded
        .prepare(
          `SELECT COUNT(*) AS count FROM sqlite_master
            WHERE type = 'trigger' AND name LIKE 'channel_messages_fts%'`
        )
        .get()
    ).toEqual({ count: 3 });
    seeded.close();

    const healed = store(file);
    expect(
      healed.history('topic:fts-heal', { limit: 20 }).map((m) => [m.id, m.seq])
    ).toEqual([['chm:fts-keeper', 1]]);
    // The index is back, rebuilt over the healed rows.
    expect(
      healed.searchMessages({ query: 'orphan' }).map((hit) => hit.messageId)
    ).toEqual(['chm:fts-keeper']);
  });

  // #1209 refutation evidence for the FIRST of the issue's two suspects: that
  // the boot-time connection read a pre-checkpoint WAL snapshot in which the
  // duplicate rows were not yet visible. It cannot work that way — the old v2
  // lane copied every row through
  // `INSERT INTO channel_messages_v2 SELECT ... FROM channel_messages` and then
  // healed the renamed table inside the SAME transaction on the SAME
  // connection, so a row that survived the rebuild was by definition visible to
  // the heal. This pins that behaviour against a db carrying a hot,
  // uncheckpointed WAL written by a still-open connection.
  //
  // The issue's second suspect (another connection holding the db) is NOT
  // exercised here. It cannot produce the reported outcome either — rows a
  // read snapshot hid from the heal would equally have been hidden from the
  // rebuild's own SELECT, so they would not be in the table afterwards, and the
  // dogfood db still had them — but that is an argument, not a fixture. It is
  // also moot for recovery now: the repair is gated on a marker row, so a pass
  // that saw nothing is re-armed with a DELETE rather than stranded forever.
  it('heals a v1 db copied with a hot, uncheckpointed WAL', () => {
    const sourceFile = dbPath();
    const source = new Database(sourceFile);
    source.pragma('journal_mode = WAL');
    source.pragma('synchronous = NORMAL');
    source.exec(`
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
        'chm:wal-keeper', 'topic:wal-heal', 1, 'message', 'complete',
        'agent', 'agent:claude', 'claude', NULL, NULL,
        'hot wal echo body', 'markdown', '{"providerId":"claude"}',
        'session-wal', 'turn-wal', 'msg-turn-wal-provider-1', NULL,
        '2026-07-19T10:00:00.100Z', '2026-07-19T10:00:00.100Z',
        '2026-07-19T10:00:00.100Z'
      );
      INSERT INTO channel_messages VALUES (
        'chm:wal-duplicate', 'topic:wal-heal', 2, 'message', 'complete',
        'agent', 'agent:claude', 'claude', NULL, NULL,
        'hot wal echo body', 'markdown', '{"providerId":"claude"}',
        'session-wal', 'turn-wal', 'msg-turn-wal-provider-0', NULL,
        '2026-07-19T10:00:00.180Z', '2026-07-19T10:00:00.180Z',
        '2026-07-19T10:00:00.102Z'
      );
    `);
    // The source hub is STILL RUNNING: nothing has checkpointed, so the main db
    // file holds only its header page and every row lives in the -wal.
    const walSize = fs.statSync(`${sourceFile}-wal`).size;
    expect(walSize).toBeGreaterThan(0);
    const copyFile = dbPath();
    for (const suffix of ['', '-wal', '-shm']) {
      if (fs.existsSync(`${sourceFile}${suffix}`)) {
        fs.copyFileSync(`${sourceFile}${suffix}`, `${copyFile}${suffix}`);
      }
    }
    source.close();

    const migrated = store(copyFile);
    expect(
      migrated.history('topic:wal-heal', { limit: 20 }).map((m) => m.id)
    ).toEqual(['chm:wal-keeper']);
    expect(migrated.getMessage('chm:wal-duplicate')).toBeNull();
  });
});

describe('channel-message-store async-run migration (#1391)', () => {
  it('upgrades a v14 store with its existing durable transcript intact', () => {
    const file = dbPath();
    const seeded = createChannelMessageStore(file);
    seeded.appendComplete({
      channelId: 'topic:migrate-run',
      sender: HUMAN,
      text: 'existing durable row',
    });
    seeded.close();
    const legacy = new Database(file);
    legacy.exec(`
      DROP INDEX idx_chart_run_state;
      DROP INDEX idx_char_channel_thread_created;
      DROP TABLE channel_async_run_targets;
      DROP TABLE channel_async_runs;
      UPDATE schema_version SET version = 14;
    `);
    legacy.close();

    const migrated = store(file);
    expect(migrated.history('topic:migrate-run')).toMatchObject([
      { body: { text: 'existing durable row' } },
    ]);
    const inspect = new Database(file, { readonly: true });
    cleanup.push(() => inspect.close());
    expect(inspect.prepare('SELECT version FROM schema_version').get()).toEqual(
      { version: 15 }
    );
    expect(
      inspect
        .prepare(
          `SELECT name FROM sqlite_master
             WHERE type = 'table' AND name IN
               ('channel_async_runs', 'channel_async_run_targets')
             ORDER BY name`
        )
        .all()
    ).toEqual([
      { name: 'channel_async_run_targets' },
      { name: 'channel_async_runs' },
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
      source: { runtimeId: 'runtime-1', turnId: 't1', itemId: 'a1' },
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
      source: {
        runtimeId: 'runtime-1',
        turnId: 't1',
        itemId: 'reason-1',
      },
      agentDetail: {
        itemId: 'reason-1',
        card: {
          kind: 'thought',
          title: 'thinking',
          status: 'running',
          content: 'inspect',
        },
      },
      agentAttribution: { model: 'claude-sonnet', effort: 'high' },
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
        agentAttribution: { model: 'claude-sonnet', effort: 'high' },
      }),
    ]);
  });

  it('atomically resolves a provisional detail terminal once and makes explicit terminal absorbing', () => {
    const s = store();
    const begun = s.beginStream({
      channelId: 'topic:detail-fsm',
      sender: AGENT,
      source: { runtimeId: 'runtime', turnId: 'turn', itemId: 'reason' },
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
      source: { runtimeId: 'runtime-1', turnId: 't1', itemId: 'a1' },
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
      source: { runtimeId: 'runtime-1', turnId: 't1', itemId: 'a1' },
    });
    const two = s.beginStream({
      channelId: 'topic:c',
      sender: AGENT,
      source: { runtimeId: 'runtime-1', turnId: 't1', itemId: 'a1' },
    });
    expect(two.id).toBe(one.id);
    expect(s.history('topic:c')).toHaveLength(1);
  });

  it('returns one finalized row when a source triple is replayed through another store handle', () => {
    const p = dbPath();
    const firstStore = store(p);
    const replayStore = store(p);
    const source = { runtimeId: 'runtime-1', turnId: 't1', itemId: 'a1' };
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
      source: { runtimeId: 'runtime-1' },
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
        source: { runtimeId: 'runtime', turnId: 'turn', itemId: 'detail' },
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
      source: { runtimeId: 'x', turnId: 't', itemId: 'i' },
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

  it('listResyncRows also carries edited human rows so a reconnect heals them', () => {
    // #1308 slice 1 item 3: an edit mutates a row in place under a seq the
    // client already consumed, so `history({ afterSeq })` never re-sends it.
    // Without this the device that was offline during the edit renders the old
    // text until a full reload.
    const s = store();
    const human = s.appendComplete({
      channelId: 'topic:c',
      sender: HUMAN,
      text: 'deploy at 3pm',
    });
    s.appendComplete({ channelId: 'topic:c', sender: HUMAN, text: 'unedited' });
    expect(s.listResyncRows('topic:c', 2, 500)).toHaveLength(0);

    s.editMessage({
      channelId: 'topic:c',
      messageId: human.id,
      editorId: HUMAN.id,
      text: 'deploy at 5pm',
    });
    const resync = s.listResyncRows('topic:c', 2, 500);
    expect(resync.map((m) => m.id)).toEqual([human.id]);
    expect(resync[0]?.body.text).toBe('deploy at 5pm');
  });

  it('editMessage rewrites the body in place and refuses rows it does not own', () => {
    const s = store();
    const human = s.appendComplete({
      channelId: 'topic:c',
      sender: HUMAN,
      text: 'ship @claude the anchor',
      mentions: [{ raw: '@claude', providerId: 'claude' }],
    });
    s.appendComplete({ channelId: 'topic:c', sender: HUMAN, text: 'after' });

    const edited = s.editMessage({
      channelId: 'topic:c',
      messageId: human.id,
      editorId: HUMAN.id,
      text: 'ship the anchor tomorrow',
      mentions: [],
    });
    // Identity survives: the whole point of an in-place edit is that nothing
    // indexing the timeline by id/seq has to move.
    expect(edited.id).toBe(human.id);
    expect(edited.seq).toBe(human.seq);
    expect(edited.createdAt).toBe(human.createdAt);
    expect(edited.body.text).toBe('ship the anchor tomorrow');
    expect(typeof edited.meta?.['editedAt']).toBe('string');
    // Mentions are a projection of the body, so a removed @claude must not keep
    // lighting the mention lane.
    expect(edited.mentions).toBeUndefined();
    expect(s.getMessage(human.id)?.body.text).toBe('ship the anchor tomorrow');
    expect(s.latestSeq('topic:c')).toBe(2);

    // Agent rows are a durable record of what a provider actually said.
    const agent = s.beginStream({
      channelId: 'topic:c',
      sender: AGENT,
      source: { runtimeId: 'r', turnId: 't', itemId: 'i' },
    });
    s.finalizeStream(agent.id, { text: 'agent said this', status: 'complete' });
    expect(() =>
      s.editMessage({
        channelId: 'topic:c',
        messageId: agent.id,
        editorId: HUMAN.id,
        text: 'agent said something else',
      })
    ).toThrowError(
      expect.objectContaining({ code: 'channel_message_not_editable' })
    );
    expect(s.getMessage(agent.id)?.body.text).toBe('agent said this');

    // Another identity cannot edit the operator's row...
    expect(() =>
      s.editMessage({
        channelId: 'topic:c',
        messageId: human.id,
        editorId: 'agent:claude',
        text: 'rewritten by an agent',
      })
    ).toThrowError(
      expect.objectContaining({ code: 'channel_message_not_editable' })
    );
    // ...and a row in another channel reads as absent, never as a conflict.
    expect(() =>
      s.editMessage({
        channelId: 'topic:other',
        messageId: human.id,
        editorId: HUMAN.id,
        text: 'cross-channel',
      })
    ).toThrowError(
      expect.objectContaining({ code: 'channel_message_not_found' })
    );
    expect(() =>
      s.editMessage({
        channelId: 'topic:c',
        messageId: human.id,
        editorId: HUMAN.id,
        text: '',
      })
    ).toThrowError(
      expect.objectContaining({ code: 'channel_message_body_empty' })
    );
  });

  // #1308 slice 1 item 4 — deleting one of the operator's own rows. Deletion is
  // a TOMBSTONE: the row is the substrate's seq log, and a hole in it would
  // break every catch-up cursor, deep link and thread parent that already names
  // the seq.
  it('deleteMessage tombstones the row, keeping id, seq and the seq log intact', () => {
    const s = store();
    const first = s.appendComplete({
      channelId: 'topic:c',
      sender: HUMAN,
      text: 'first',
    });
    const target = s.appendComplete({
      channelId: 'topic:c',
      sender: HUMAN,
      text: 'ship @claude the anchor',
      mentions: [{ raw: '@claude', providerId: 'claude' }],
    });
    const after = s.appendComplete({
      channelId: 'topic:c',
      sender: HUMAN,
      text: 'after',
    });

    const tombstone = s.deleteMessage({
      channelId: 'topic:c',
      messageId: target.id,
      deleterId: HUMAN.id,
    });
    expect(tombstone.id).toBe(target.id);
    expect(tombstone.seq).toBe(target.seq);
    expect(tombstone.createdAt).toBe(target.createdAt);
    expect(tombstone.body.text).toBe('');
    expect(typeof tombstone.meta?.['deletedAt']).toBe('string');
    // Mentions go with the body: a removed message must not keep lighting the
    // sidebar's mention lane.
    expect(tombstone.mentions).toBeUndefined();

    // The log is unchanged in length AND in numbering. Renumbering `seq` would
    // be the one unrecoverable mistake here.
    const history = s.history('topic:c', { limit: 50 });
    expect(history.map((m) => m.seq)).toEqual([1, 2, 3]);
    expect(history.map((m) => m.id)).toEqual([first.id, target.id, after.id]);
    expect(history[1]?.body.text).toBe('');
    expect(s.latestSeq('topic:c')).toBe(3);
    expect(s.getMessage(target.id)?.body.text).toBe('');
  });

  it('deleteMessage is idempotent and refuses rows the operator does not own', () => {
    const s = store();
    const human = s.appendComplete({
      channelId: 'topic:c',
      sender: HUMAN,
      text: 'operator says hi',
    });
    const first = s.deleteMessage({
      channelId: 'topic:c',
      messageId: human.id,
      deleterId: HUMAN.id,
    });
    // A second delete (another device, a double tap) converges on the SAME
    // tombstone rather than restamping or throwing.
    const again = s.deleteMessage({
      channelId: 'topic:c',
      messageId: human.id,
      deleterId: HUMAN.id,
    });
    expect(again.meta?.['deletedAt']).toBe(first.meta?.['deletedAt']);

    // A tombstone is not an editable row — an edit would be an undelete.
    expect(() =>
      s.editMessage({
        channelId: 'topic:c',
        messageId: human.id,
        editorId: HUMAN.id,
        text: 'back from the dead',
      })
    ).toThrowError(
      expect.objectContaining({ code: 'channel_message_not_editable' })
    );
    expect(s.getMessage(human.id)?.body.text).toBe('');

    // Agent rows are a durable record of what a provider actually said.
    const agent = s.beginStream({
      channelId: 'topic:c',
      sender: AGENT,
      source: { runtimeId: 'r', turnId: 't', itemId: 'i' },
    });
    s.finalizeStream(agent.id, { text: 'agent said this', status: 'complete' });
    expect(() =>
      s.deleteMessage({
        channelId: 'topic:c',
        messageId: agent.id,
        deleterId: HUMAN.id,
      })
    ).toThrowError(
      expect.objectContaining({ code: 'channel_message_not_deletable' })
    );
    expect(s.getMessage(agent.id)?.body.text).toBe('agent said this');

    // Another identity cannot delete the operator's row...
    const other = s.appendComplete({
      channelId: 'topic:c',
      sender: HUMAN,
      text: 'still here',
    });
    expect(() =>
      s.deleteMessage({
        channelId: 'topic:c',
        messageId: other.id,
        deleterId: 'agent:claude',
      })
    ).toThrowError(
      expect.objectContaining({ code: 'channel_message_not_deletable' })
    );
    // ...and a row in another channel reads as absent, never as a conflict.
    expect(() =>
      s.deleteMessage({
        channelId: 'topic:other',
        messageId: other.id,
        deleterId: HUMAN.id,
      })
    ).toThrowError(
      expect.objectContaining({ code: 'channel_message_not_found' })
    );
    expect(s.getMessage(other.id)?.body.text).toBe('still here');
  });

  it('keeps a deleted thread parent as the anchor its replies still point at', () => {
    const s = store();
    const root = s.appendComplete({
      channelId: 'topic:c',
      sender: HUMAN,
      text: 'root question',
    });
    const reply = s.appendComplete({
      channelId: 'topic:c',
      sender: HUMAN,
      text: 'a reply',
      parentMessageId: root.id,
    });
    expect(reply.threadId).toBe(root.id);

    s.deleteMessage({
      channelId: 'topic:c',
      messageId: root.id,
      deleterId: HUMAN.id,
    });

    // The root still resolves, still roots the thread, and still counts replies:
    // removing the row would have orphaned every reply pointing at it.
    const thread = s.threadHistory('topic:c', root.id, { limit: 50 });
    expect(thread.map((m) => m.id)).toEqual([root.id, reply.id]);
    expect(thread[0]?.body.text).toBe('');
    expect(s.getMessage(root.id)?.replyCount).toBe(1);
    expect(
      s
        .listChannelThreadSummaries('topic:c')
        .threads.map((t) => t.rootMessageId)
    ).toEqual([root.id]);
  });

  it('carries tombstones on catch-up and keeps them out of the sidebar preview', () => {
    const s = store();
    const kept = s.appendComplete({
      channelId: 'topic:c',
      sender: HUMAN,
      text: 'the visible one',
    });
    const doomed = s.appendComplete({
      channelId: 'topic:c',
      sender: HUMAN,
      text: 'about to go',
    });
    expect(s.getChannelSummary('topic:c').lastMessage?.preview).toBe(
      'about to go'
    );

    s.deleteMessage({
      channelId: 'topic:c',
      messageId: doomed.id,
      deleterId: HUMAN.id,
    });

    // A deletion mutates a row under a seq the client already consumed, so
    // `history({ afterSeq })` never re-sends it — without catch-up a device that
    // was offline keeps rendering the deleted body.
    const resync = s.listResyncRows('topic:c', 2, 500);
    expect(resync.map((m) => m.id)).toEqual([doomed.id]);
    expect(resync[0]?.body.text).toBe('');

    // A body-less newest row must not blank the sidebar, the same rule detail
    // cards already follow.
    expect(s.getChannelSummary('topic:c').lastMessage?.preview).toBe(
      'the visible one'
    );
    expect(s.getChannelSummary('topic:c').lastMessage?.id).toBe(kept.id);
    expect(s.getChannelSummary('topic:c').latestSeq).toBe(2);
    expect(
      s.listChannelSummaries().find((c) => c.channelId === 'topic:c')
        ?.lastMessage?.preview
    ).toBe('the visible one');
  });

  it('keeps replyCount on point reads, finalization rows, and resync replacements', () => {
    const s = store();
    const root = s.beginStream({
      channelId: 'topic:c',
      sender: AGENT,
      source: {
        runtimeId: 'root-runtime',
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
          runtimeId: `reply-runtime-${index}`,
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
        runtimeId: 'reply-runtime-stream',
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

describe('channel-message-store async runs (#1391)', () => {
  it('atomically creates and replays one requester post/run without re-routing', () => {
    const file = dbPath();
    const s = store(file);
    const first = s.appendCompleteWithAsyncRun({
      channelId: 'topic:async',
      sender: HUMAN,
      text: '@a @b compare plans',
      clientMessageId: 'client-async-1',
      targetIds: ['agent-profile:b:default', 'agent-profile:a:default'],
    });

    expect(first).toMatchObject({
      replayed: false,
      message: {
        channelId: 'topic:async',
        clientMessageId: 'client-async-1',
      },
      run: {
        id: expect.stringMatching(/^chrun:/),
        channelId: 'topic:async',
        requesterId: HUMAN.id,
        state: 'submitted',
        targets: [
          { targetId: 'agent-profile:a:default', state: 'queued' },
          { targetId: 'agent-profile:b:default', state: 'queued' },
        ],
      },
    });
    expect(first.run.requestMessageId).toBe(first.message.id);

    const replay = s.appendCompleteWithAsyncRun({
      channelId: 'topic:async',
      sender: HUMAN,
      text: 'this replacement must not be persisted',
      clientMessageId: 'client-async-1',
      targetIds: ['agent-profile:unexpected:default'],
    });
    expect(replay.replayed).toBe(true);
    expect(replay.message).toEqual(first.message);
    expect(replay.run).toEqual(first.run);
    expect(s.history('topic:async')).toEqual([first.message]);
    expect(s.getAsyncRun(first.run.id)).toEqual(first.run);
    expect(s.getAsyncRunForRequestMessage(first.message.id)).toEqual(first.run);

    // A reopen proves the correlation is a durable store projection rather
    // than a router-local map and remains queryable from history/reconnect.
    s.close();
    const reopened = store(file);
    expect(reopened.getAsyncRun(first.run.id)).toMatchObject({
      id: first.run.id,
      state: 'cancelled',
      reason: 'server-restarted',
      targets: [
        { targetId: 'agent-profile:a:default', state: 'cancelled' },
        { targetId: 'agent-profile:b:default', state: 'cancelled' },
      ],
    });
  });

  it('derives aggregate terminal state from durable per-target CAS outcomes', () => {
    const s = store();
    const { run } = s.appendCompleteWithAsyncRun({
      channelId: 'topic:async',
      sender: HUMAN,
      text: '@a @b investigate',
      targetIds: ['agent-profile:a:default', 'agent-profile:b:default'],
    });

    const working = s.transitionAsyncRunTarget({
      runId: run.id,
      targetId: 'agent-profile:a:default',
      state: 'working',
    })!;
    expect(working.state).toBe('working');
    expect(working.targets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          targetId: 'agent-profile:a:default',
          state: 'working',
        }),
      ])
    );

    s.transitionAsyncRunTarget({
      runId: run.id,
      targetId: 'agent-profile:a:default',
      state: 'completed',
    });
    const awaitingInput = s.transitionAsyncRunTarget({
      runId: run.id,
      targetId: 'agent-profile:b:default',
      state: 'input-required',
      approvalState: 'requested',
    })!;
    expect(awaitingInput).toMatchObject({
      state: 'input-required',
      targets: expect.arrayContaining([
        expect.objectContaining({
          targetId: 'agent-profile:b:default',
          state: 'input-required',
          approvalState: 'requested',
        }),
      ]),
    });

    const failed = s.transitionAsyncRunTarget({
      runId: run.id,
      targetId: 'agent-profile:b:default',
      state: 'rejected',
      reason: 'target-revoked',
    })!;
    expect(failed).toMatchObject({
      state: 'failed',
      completedAt: expect.any(String),
      targets: expect.arrayContaining([
        expect.objectContaining({
          targetId: 'agent-profile:a:default',
          state: 'completed',
          completedAt: expect.any(String),
        }),
        expect.objectContaining({
          targetId: 'agent-profile:b:default',
          state: 'rejected',
          reason: 'target-revoked',
          completedAt: expect.any(String),
        }),
      ]),
    });

    // A terminal target is a CAS fence: a late provider patch cannot rewrite
    // its terminal result or alter the already-derived aggregate state.
    expect(
      s.transitionAsyncRunTarget({
        runId: run.id,
        targetId: 'agent-profile:b:default',
        state: 'completed',
      })
    ).toEqual(failed);
  });

  it('rejects a run with no eligible target without inventing a provider identity', () => {
    const s = store();
    const { run } = s.appendCompleteWithAsyncRun({
      channelId: 'topic:async',
      sender: HUMAN,
      text: 'nobody eligible',
      targetIds: [],
    });
    expect(run).toMatchObject({
      state: 'rejected',
      reason: 'no-eligible-target',
      completedAt: expect.any(String),
      targets: [],
    });
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

  // A summary sender id is a profile Actor id, so clients cannot label a row
  // from it (#1234) — and the 200-char preview cannot answer "was I mentioned?"
  // for a long agent status update. Both signals ride the payload instead.
  it('carries the resolved sender identity and full-body mentions on a summary', () => {
    const s = store();
    const longStatus = `${'status update. '.repeat(40)}@operator please confirm`;
    s.appendComplete({
      channelId: 'topic:e',
      sender: {
        kind: 'agent',
        id: builtInAgentProfileId('claude'),
        providerId: 'claude',
        displayName: 'Reviewer Claude',
      },
      text: longStatus,
    });

    const summary = s.getChannelSummary('topic:e');
    expect(summary?.lastMessage?.senderId).toBe(
      builtInAgentProfileId('claude')
    );
    expect(summary?.lastMessage?.senderDisplayName).toBe('Reviewer Claude');
    expect(summary?.lastMessage?.providerId).toBe('claude');
    // The mention sits well past the truncated preview...
    expect(summary?.lastMessage?.preview).not.toContain('@operator');
    // ...but is still visible to the rail.
    expect(summary?.lastMessage?.mentions?.map((m) => m.raw)).toEqual([
      '@operator',
    ]);
    const viaList = s
      .listChannelSummaries()
      .find((x) => x.channelId === 'topic:e');
    expect(viaList?.lastMessage?.mentions?.map((m) => m.raw)).toEqual([
      '@operator',
    ]);
  });

  it('prefers persisted mentions over a re-parse of the body', () => {
    const s = store();
    s.appendComplete({
      channelId: 'topic:f',
      sender: HUMAN,
      text: '@Reviewer Claude take a look',
      mentions: [
        {
          raw: '@Reviewer Claude',
          providerId: 'claude',
          profileId: 'agent-profile:claude:reviewer',
        },
      ],
    });

    // Server-resolved contact-set mentions (#1236) survive verbatim — a plain
    // re-parse of the body could not reproduce the multi-word name or profileId.
    expect(s.getChannelSummary('topic:f')?.lastMessage?.mentions).toEqual([
      {
        raw: '@Reviewer Claude',
        providerId: 'claude',
        profileId: 'agent-profile:claude:reviewer',
      },
    ]);
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
      source: {
        runtimeId: 'runtime-d',
        turnId: 't-d',
        itemId: 'reason-d',
      },
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

// #1287 slice 5 item 18: the rail surfaces threads, so the channel list needs a
// thread projection that agrees with the in-timeline "N replies" chip.
describe('channel-message-store mention context (#1358)', () => {
  it('counts the exact candidate range while returning only newest eligible prose', () => {
    const s = store();
    const channelId = 'topic:context';
    s.appendComplete({ channelId, sender: HUMAN, text: 'before cursor' });
    const cursor = s.latestSeq(channelId);
    s.appendComplete({ channelId, sender: HUMAN, text: 'older prose' });
    s.appendComplete({ channelId, sender: AGENT, text: 'own provider prose' });
    s.appendComplete({
      channelId,
      kind: 'system',
      sender: { kind: 'system', id: 'system:relay' },
      text: 'collab:wait',
    });
    s.appendComplete({ channelId, sender: HUMAN, text: '\t \n ' });
    const detail = s.beginStream({
      channelId,
      sender: {
        kind: 'agent',
        id: 'agent:other',
        providerId: 'other',
      },
      source: {
        runtimeId: 'runtime:other',
        turnId: 'turn:detail',
        itemId: 'item:detail',
      },
      agentDetail: {
        itemId: 'item:detail',
        card: {
          kind: 'thought',
          title: 'Reasoning summary',
          status: 'running',
          content: 'not prose',
        },
      },
    });
    s.finalizeStream(detail.id, { text: '', status: 'complete' });
    for (let index = 0; index < 18; index += 1) {
      s.appendComplete({ channelId, sender: HUMAN, text: `prose ${index}` });
    }
    const trigger = s.appendComplete({
      channelId,
      sender: HUMAN,
      text: '@claude inspect',
    });

    const context = s.mentionContext({
      channelId,
      framework: 'claude',
      triggerSeq: trigger.seq,
      afterSeq: cursor,
      threadRootId: null,
      limit: 16,
    });
    expect(context).toMatchObject({
      totalCount: 22,
      activityFilteredCount: 3,
      candidateScanBudget: MENTION_CONTEXT_CANDIDATE_SCAN_BUDGET,
      candidateScanTruncated: false,
      scope: 'channel',
    });
    expect(context.rows).toHaveLength(16);
    expect(context.rows.map((row) => row.body.text)).toEqual(
      Array.from({ length: 16 }, (_, index) => `prose ${index + 2}`)
    );
  });

  it.each([
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    MENTION_CONTEXT_CANDIDATE_SCAN_BUDGET + 1,
    Number.MAX_SAFE_INTEGER,
  ])(
    'rejects invalid candidate budget %s at store creation',
    (candidateBudget) => {
      expect(() =>
        store(undefined, {
          mentionContextCandidateScanBudget: candidateBudget,
        })
      ).toThrow(
        new RangeError(
          `mentionContextCandidateScanBudget must be an integer from 1 through ${MENTION_CONTEXT_CANDIDATE_SCAN_BUDGET}`
        )
      );
    }
  );

  it('degrades channel context deterministically to the newest candidate budget', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    cleanup.push(() => warnSpy.mockRestore());
    const s = store(undefined, { mentionContextCandidateScanBudget: 3 });
    const channelId = 'topic:context-budget';
    for (let index = 0; index < 5; index += 1) {
      s.appendComplete({ channelId, sender: HUMAN, text: `prose ${index}` });
    }
    const trigger = s.appendComplete({
      channelId,
      sender: HUMAN,
      text: '@claude inspect',
    });

    const context = s.mentionContext({
      channelId,
      framework: 'claude',
      triggerSeq: trigger.seq,
      afterSeq: 0,
      threadRootId: null,
      limit: 16,
    });

    expect(context).toMatchObject({
      totalCount: 3,
      activityFilteredCount: 0,
      candidateScanBudget: 3,
      candidateScanTruncated: true,
      scope: 'channel',
    });
    expect(context.rows.map((row) => row.body.text)).toEqual([
      'prose 2',
      'prose 3',
      'prose 4',
    ]);
    const budgetLine = warnSpy.mock.calls.find(
      (call) =>
        typeof call[0] === 'string' &&
        call[0].includes('mention_context_candidate_budget_truncated')
    );
    expect(format(...(budgetLine as [string, ...unknown[]]))).toBe(
      '[channel-message-store] mention_context_candidate_budget_truncated channel_id=topic:context-budget scope=channel raw_index_entries_at_least=4 candidate_budget=3'
    );
  });

  it('keeps a structural thread root outside the bounded reply window', () => {
    const s = store(undefined, { mentionContextCandidateScanBudget: 3 });
    const channelId = 'topic:thread-context-budget';
    const root = s.appendComplete({ channelId, sender: HUMAN, text: '' });
    for (let index = 0; index < 5; index += 1) {
      s.appendComplete({
        channelId,
        sender: HUMAN,
        text: `reply ${index}`,
        parentMessageId: root.id,
      });
    }
    const trigger = s.appendComplete({
      channelId,
      sender: HUMAN,
      text: '@claude inspect',
      parentMessageId: root.id,
    });

    const context = s.mentionContext({
      channelId,
      framework: 'claude',
      triggerSeq: trigger.seq,
      afterSeq: 0,
      threadRootId: root.id,
      limit: 16,
    });

    expect(context).toMatchObject({
      totalCount: 4,
      activityFilteredCount: 0,
      candidateScanBudget: 3,
      candidateScanTruncated: true,
      scope: 'thread',
    });
    expect(context.rows.map((row) => row.body.text)).toEqual([
      '',
      'reply 2',
      'reply 3',
      'reply 4',
    ]);
  });

  it('bounds corrupt cross-channel thread collisions without leaking their rows', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    cleanup.push(() => warnSpy.mockRestore());
    const file = dbPath();
    const s = store(file, { mentionContextCandidateScanBudget: 3 });
    const channelId = 'topic:thread-owner';
    const root = s.appendComplete({
      channelId,
      sender: HUMAN,
      text: 'owner root',
    });
    s.appendComplete({
      channelId,
      sender: HUMAN,
      text: 'owner reply outside conservative window',
      parentMessageId: root.id,
    });
    for (let index = 0; index < 5; index += 1) {
      s.appendComplete({
        channelId,
        sender: HUMAN,
        text: `owner filler ${index}`,
      });
    }

    const corrupt = new Database(file);
    const insert = corrupt.prepare(`
      INSERT INTO channel_messages (
        id, channel_id, seq, kind, status, sender_kind, sender_id,
        thread_id, parent_message_id, body_text, body_format, created_at, updated_at
      ) VALUES (
        @id, @channelId, @seq, 'message', 'complete', 'human', 'human:other',
        @threadId, @threadId, @body, 'markdown', @now, @now
      )
    `);
    for (let seq = 3; seq <= 6; seq += 1) {
      insert.run({
        id: `chm:corrupt-cross-channel-${seq}`,
        channelId: 'topic:other',
        seq,
        threadId: root.id,
        body: `must-not-leak-${seq}`,
        now: '2026-08-07T00:00:00.000Z',
      });
    }
    corrupt.close();
    const trigger = s.appendComplete({
      channelId,
      sender: HUMAN,
      text: '@claude inspect',
      parentMessageId: root.id,
    });

    const context = s.mentionContext({
      channelId,
      framework: 'claude',
      triggerSeq: trigger.seq,
      afterSeq: 0,
      threadRootId: root.id,
      limit: 16,
    });

    expect(context).toMatchObject({
      totalCount: 1,
      activityFilteredCount: 0,
      candidateScanBudget: 3,
      candidateScanTruncated: true,
      scope: 'thread',
    });
    expect(context.rows.map((row) => row.id)).toEqual([root.id]);
    expect(JSON.stringify(context)).not.toContain('must-not-leak');
    const budgetLine = warnSpy.mock.calls.find(
      (call) =>
        typeof call[0] === 'string' &&
        call[0].includes('mention_context_candidate_budget_truncated')
    );
    expect(format(...(budgetLine as [string, ...unknown[]]))).toBe(
      '[channel-message-store] mention_context_candidate_budget_truncated channel_id=topic:thread-owner scope=thread raw_index_entries_at_least=4 candidate_budget=3'
    );
  });

  it('plans counts and bounded rows as direct indexed range reads', () => {
    const file = dbPath();
    const s = store(file);
    const root = s.appendComplete({
      channelId: 'topic:plan',
      sender: HUMAN,
      text: 'thread root',
    });
    const db = new Database(file, { readonly: true });
    cleanup.push(() => db.close());
    const params = {
      channelId: 'topic:plan',
      framework: 'claude',
      triggerSeq: 100,
      afterSeq: 0,
      candidateAfterSeq: 0,
      candidateBudget: 4096,
      threadRootId: root.id,
      limit: 16,
      replyLimit: 15,
    };
    const explain = (sql: string): string =>
      (
        db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(params) as Array<{
          detail: string;
        }>
      )
        .map((step) => step.detail)
        .join('\n');

    const channelBoundary = explain(
      buildChannelMentionContextBoundarySql('channel')
    );
    expect(channelBoundary).toMatch(
      /SEARCH channel_row USING COVERING INDEX idx_chm_channel_seq \(channel_id=\? AND seq>\? AND seq<\?\)/
    );
    expect(channelBoundary).not.toContain('USE TEMP B-TREE');
    const threadBoundarySql = buildChannelMentionContextBoundarySql('thread');
    // The raw thread probe intentionally omits channel_id: idx_chm_thread is
    // keyed by thread+seq, so every visited entry must count toward the budget,
    // including corrupt cross-channel collisions.
    expect(threadBoundarySql).not.toContain('channel_id');
    const threadBoundary = explain(threadBoundarySql);
    expect(threadBoundary).toMatch(
      /SEARCH reply USING (?:COVERING )?INDEX idx_chm_thread \(thread_id=\? AND seq<\?\)/
    );
    expect(threadBoundary).not.toContain('USE TEMP B-TREE');

    const channelCount = explain(buildChannelMentionContextCountSql('channel'));
    expect(channelCount).toMatch(
      /SEARCH channel_row USING INDEX idx_chm_channel_seq \(channel_id=\? AND seq>\? AND seq<\?\)/
    );
    const channelRows = explain(buildChannelMentionContextRowsSql('channel'));
    expect(channelRows).toMatch(
      /SEARCH m USING INDEX idx_chm_channel_seq \(channel_id=\? AND seq>\? AND seq<\?\)/
    );
    expect(channelRows).not.toContain('USE TEMP B-TREE');
    expect(channelRows).not.toMatch(/SCAN m/);

    const threadCount = explain(buildChannelMentionContextCountSql('thread'));
    expect(threadCount).toMatch(/SEARCH root USING INDEX .*\(id=\?\)/);
    expect(threadCount).toMatch(
      /SEARCH reply USING INDEX idx_chm_thread \(thread_id=\? AND seq>\? AND seq<\?\)/
    );
    const threadRows = explain(buildChannelMentionContextRowsSql('thread'));
    expect(threadRows).toMatch(/SEARCH root USING INDEX .*\(id=\?\)/);
    expect(threadRows).toMatch(
      /SEARCH reply USING INDEX idx_chm_thread \(thread_id=\? AND seq>\? AND seq<\?\)/
    );
    expect(threadRows).not.toContain('USE TEMP B-TREE');
    expect(threadRows).not.toMatch(/SCAN (?:root|reply)/);
  });
});

describe('channel-message-store thread summaries', () => {
  it('reports live threads newest-active first with the chip reply count', () => {
    const s = store();
    const design = s.appendComplete({
      channelId: 'topic:t',
      sender: HUMAN,
      text: 'how should the binder key runtimes?',
    });
    const rollout = s.appendComplete({
      channelId: 'topic:t',
      sender: HUMAN,
      text: 'rollout plan',
    });
    // A top-level row with no replies is not a thread.
    s.appendComplete({
      channelId: 'topic:t',
      sender: HUMAN,
      text: 'unrelated top-level chatter',
    });
    s.appendComplete({
      channelId: 'topic:t',
      sender: AGENT,
      text: 'by profile actor id',
      parentMessageId: design.id,
    });
    s.appendComplete({
      channelId: 'topic:t',
      sender: HUMAN,
      text: 'agreed',
      parentMessageId: design.id,
    });
    // Detail cards persist inside the thread for cold resume but are NOT
    // conversational replies — `replyCountSql` excludes them and so must this.
    const card = s.beginStream({
      channelId: 'topic:t',
      sender: AGENT,
      source: { runtimeId: 'runtime-t', turnId: 't-1', itemId: 'reason-1' },
      parentMessageId: design.id,
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
    s.finalizeStream(card.id, {
      text: '',
      status: 'complete',
      agentDetail: {
        itemId: 'reason-1',
        card: {
          kind: 'thought',
          title: 'thinking',
          status: 'completed',
          content: 'inspect',
        },
      },
    });
    // Newest reply overall lands in the OTHER thread, which must therefore lead.
    s.appendComplete({
      channelId: 'topic:t',
      sender: AGENT,
      text: 'ship behind the fold',
      parentMessageId: rollout.id,
    });

    const page = s.listChannelThreadSummaries('topic:t');
    expect(page.threadCount).toBe(2);
    expect(page.threads.map((thread) => thread.rootMessageId)).toEqual([
      rollout.id,
      design.id,
    ]);
    // The design thread has three rows under it; only two are replies.
    expect(page.threads[1]).toMatchObject({
      replyCount: 2,
      preview: 'how should the binder key runtimes?',
      rootSenderId: HUMAN.id,
      rootSenderKind: 'human',
    });
    expect(page.threads[0]?.replyCount).toBe(1);
    // Agreement with the in-timeline chip, which reads the derived reply count
    // history hands back for the same root.
    expect(
      s.threadHistory('topic:t', design.id).find((m) => m.id === design.id)
        ?.replyCount
    ).toBe(2);
    // Threads live in exactly one channel.
    expect(s.listChannelThreadSummaries('topic:other')).toEqual({
      threads: [],
      threadCount: 0,
    });
  });

  it('caps the page while still counting every live thread', () => {
    const s = store();
    const roots = Array.from({ length: 5 }, (_, index) =>
      s.appendComplete({
        channelId: 'topic:t',
        sender: HUMAN,
        text: `root ${index}`,
      })
    );
    for (const root of roots) {
      s.appendComplete({
        channelId: 'topic:t',
        sender: AGENT,
        text: 'reply',
        parentMessageId: root.id,
      });
    }

    const defaulted = s.listChannelThreadSummaries('topic:t');
    expect(defaulted.threads).toHaveLength(3);
    // A capped page must not under-report how many threads the channel holds —
    // the rail's "N threads" line reads this, not `threads.length`.
    expect(defaulted.threadCount).toBe(5);
    expect(defaulted.threads.map((thread) => thread.rootMessageId)).toEqual([
      roots[4]?.id,
      roots[3]?.id,
      roots[2]?.id,
    ]);
    expect(s.listChannelThreadSummaries('topic:t', 5).threads).toHaveLength(5);
    expect(s.listChannelThreadSummaries('topic:t', 0).threads).toHaveLength(1);
  });

  it('counts only threads whose root still resolves in this channel', () => {
    // `COUNT(*) OVER ()` used to be computed inside the aggregate, i.e. BEFORE
    // the join that drops a group whose root row is gone — so the rail could
    // render "2 threads" over one thread row. The frontend clamp only guards
    // under-reporting, so nothing downstream caught it.
    const file = dbPath();
    const s = store(file);
    const kept = s.appendComplete({
      channelId: 'topic:t',
      sender: HUMAN,
      text: 'kept root',
    });
    s.appendComplete({
      channelId: 'topic:t',
      sender: AGENT,
      text: 'kept reply',
      parentMessageId: kept.id,
    });
    const orphaned = s.appendComplete({
      channelId: 'topic:t',
      sender: HUMAN,
      text: 'doomed root',
    });
    s.appendComplete({
      channelId: 'topic:t',
      sender: AGENT,
      text: 'orphan reply',
      parentMessageId: orphaned.id,
    });
    expect(s.listChannelThreadSummaries('topic:t').threadCount).toBe(2);

    const raw = new Database(file);
    cleanup.push(() => raw.close());
    raw.prepare(`DELETE FROM channel_messages WHERE id = ?`).run(orphaned.id);

    const page = s.listChannelThreadSummaries('topic:t');
    expect(page.threads.map((thread) => thread.rootMessageId)).toEqual([
      kept.id,
    ]);
    expect(page.threadCount).toBe(page.threads.length);
  });

  it('plans channel-list conversations from the durable recent-thread index', () => {
    const p = dbPath();
    const s = store(p);
    const root = s.appendComplete({
      channelId: 'topic:t',
      sender: HUMAN,
      text: 'root',
    });
    s.appendComplete({
      channelId: 'topic:t',
      sender: AGENT,
      text: 'reply',
      parentMessageId: root.id,
    });

    const raw = new Database(p, { readonly: true });
    cleanup.push(() => raw.close());
    // EXPLAIN the exact SQL `GET /channels` runs once per channel — the reason
    // the builder is exported rather than inlined.
    const plan = raw
      .prepare(`EXPLAIN QUERY PLAN ${buildChannelThreadSummarySql()}`)
      .all({ channelId: 'topic:t', limit: 3 }) as Array<{ detail: string }>;
    const details = plan.map((row) => row.detail).join('\n');
    // Durable conversations, including intentionally empty ones, drive the
    // page by most-recent activity. Roots and replies remain point/index
    // lookups rather than a channel_messages walk.
    expect(details).toMatch(
      /SEARCH thread USING INDEX idx_channel_threads_recent \(channel_id=\?\)/
    );
    expect(details).toMatch(
      /SEARCH root USING (?:COVERING )?INDEX sqlite_autoindex_channel_messages_1 \(id=\?\)/
    );
    expect(details).toMatch(
      /SEARCH reply USING INDEX idx_chm_thread \(thread_id=\?\)/
    );
    expect(details).not.toContain('idx_chm_channel_seq');
    expect(details).not.toMatch(/SCAN (?:channel_messages|root|reply)\b/);
    expect(details).not.toContain('AUTOMATIC COVERING INDEX');
  });

  it('carries the server-resolved root sender label and vendor', () => {
    const s = store();
    const root = s.appendComplete({
      channelId: 'topic:t',
      sender: { ...AGENT, displayName: 'Claude Bot' },
      text: 'status update',
    });
    s.appendComplete({
      channelId: 'topic:t',
      sender: HUMAN,
      text: 'noted',
      parentMessageId: root.id,
    });

    expect(s.listChannelThreadSummaries('topic:t').threads[0]).toMatchObject({
      rootSenderDisplayName: 'Claude Bot',
      providerId: 'claude',
      rootSenderKind: 'agent',
    });
  });

  it('persists explicit conversation titles, including an empty conversation, across reopen', () => {
    const file = dbPath();
    const initial = store(file);
    const created = initial.createThread({
      channelId: 'topic:named',
      title: 'Investigate provider resume semantics',
    });
    expect(created).toMatchObject({
      title: 'Investigate provider resume semantics',
      replyCount: 0,
    });
    expect(initial.listChannelThreadSummaries('topic:named')).toEqual({
      threadCount: 1,
      threads: [
        expect.objectContaining({
          rootMessageId: created.rootMessageId,
          title: 'Investigate provider resume semantics',
          replyCount: 0,
        }),
      ],
    });

    expect(
      initial.renameThread({
        channelId: 'topic:named',
        rootMessageId: created.rootMessageId,
        title: 'Provider restart notes',
      })
    ).toMatchObject({ title: 'Provider restart notes' });
    initial.close();

    const reopened = store(file);
    expect(reopened.getThreadTitle('topic:named', created.rootMessageId)).toBe(
      'Provider restart notes'
    );
    expect(
      reopened.threadHistory('topic:named', created.rootMessageId)
    ).toHaveLength(1);
  });
});

describe('channel-message-store members and bindings', () => {
  it('keeps one profile binding per thread scope without replacing its siblings', () => {
    const s = store();
    const first = s.createThread({ channelId: 'topic:scope', title: 'first' });
    const second = s.createThread({
      channelId: 'topic:scope',
      title: 'second',
    });
    for (const [threadId, runtimeId] of [
      [first.rootMessageId, 'runtime:first'],
      [second.rootMessageId, 'runtime:second'],
    ] as const) {
      s.upsertBinding({
        channelId: 'topic:scope',
        threadId,
        profileActorId: 'agent-profile:mock:default',
        agentFramework: 'mock',
        runtimeId,
        providerSession: { providerThread: threadId },
      });
    }

    expect(
      s.getBinding(
        'topic:scope',
        'agent-profile:mock:default',
        first.rootMessageId
      )
    ).toMatchObject({
      runtimeId: 'runtime:first',
      providerSession: { providerThread: first.rootMessageId },
    });
    expect(
      s.getBinding(
        'topic:scope',
        'agent-profile:mock:default',
        second.rootMessageId
      )
    ).toMatchObject({
      runtimeId: 'runtime:second',
      providerSession: { providerThread: second.rootMessageId },
    });
    expect(
      s.getBinding('topic:scope', 'agent-profile:mock:default')
    ).toBeNull();
  });

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

  it('enforces one idempotent durable orchestrator and rejects another profile', () => {
    const s = store();
    const first = s.designateSoleOrchestrator({
      channelId: 'topic:sole',
      profileActorId: 'profile:a',
      agentFramework: 'claude',
      runtimeId: 'runtime:a',
      providerSession: { cursor: 7 },
    });
    const repeated = s.designateSoleOrchestrator({
      channelId: 'topic:sole',
      profileActorId: 'profile:a',
      agentFramework: 'claude',
    });
    expect(repeated).toMatchObject({
      profileActorId: 'profile:a',
      runtimeId: 'runtime:a',
      role: 'orchestrator',
      providerSession: { cursor: 7 },
      createdAt: first.createdAt,
    });
    expect(s.getSoleOrchestratorBinding('topic:sole')).toEqual(repeated);

    expect(() =>
      s.designateSoleOrchestrator({
        channelId: 'topic:sole',
        profileActorId: 'profile:b',
        agentFramework: 'codex',
      })
    ).toThrowError(
      expect.objectContaining({
        status: 409,
        code: 'channel_orchestrator_conflict',
        details: {
          channelId: 'topic:sole',
          designatedProfileActorId: 'profile:a',
          requestedProfileActorId: 'profile:b',
        },
      })
    );
    expect(s.getSoleOrchestratorBinding('topic:sole')?.profileActorId).toBe(
      'profile:a'
    );
    expect(s.getBinding('topic:sole', 'profile:b')).toBeNull();
    expect(() =>
      s.upsertBinding({
        channelId: 'topic:other',
        profileActorId: 'profile:b',
        agentFramework: 'codex',
        role: 'orchestrator',
      } as never)
    ).toThrowError(
      expect.objectContaining({
        status: 400,
        code: 'orchestrator_requires_sole_designation',
      })
    );
  });

  it('keeps the sole designation across reopen and rejects raw duplicates', () => {
    const file = dbPath();
    const initial = store(file);
    initial.designateSoleOrchestrator({
      channelId: 'topic:restart-sole',
      profileActorId: 'profile:a',
      agentFramework: 'claude',
    });
    initial.close();
    const malformed = new Database(file);
    malformed
      .prepare(
        `UPDATE channel_agent_bindings
            SET provider_session_json = '{'
          WHERE channel_id = 'topic:restart-sole'`
      )
      .run();
    malformed.close();

    const reopened = store(file);
    expect(
      reopened.getSoleOrchestratorBinding('topic:restart-sole')?.profileActorId
    ).toBe('profile:a');
    expect(
      reopened.designateSoleOrchestrator({
        channelId: 'topic:restart-sole',
        profileActorId: 'profile:a',
        agentFramework: 'claude',
      }).providerSession
    ).toEqual({});
    expect(() =>
      reopened.designateSoleOrchestrator({
        channelId: 'topic:restart-sole',
        profileActorId: 'profile:b',
        agentFramework: 'codex',
      })
    ).toThrowError(expect.objectContaining({ status: 409 }));
    expect(() => {
      const raw = new Database(file);
      try {
        raw
          .prepare(
            `INSERT INTO channel_agent_bindings
              (channel_id, profile_actor_id, agent_framework, runtime_id,
               binding_role, provider_session_json, created_at, updated_at)
             VALUES (?, ?, ?, NULL, 'orchestrator', '{}', ?, ?)`
          )
          .run(
            'topic:restart-sole',
            'profile:raw-loser',
            'codex',
            '2026-08-07T00:00:00.000Z',
            '2026-08-07T00:00:00.000Z'
          );
      } finally {
        raw.close();
      }
    }).toThrow(/UNIQUE constraint failed/);
  });

  it('stores and reads agent bindings (slice-4 landing pad)', () => {
    const s = store();
    const created = s.designateSoleOrchestrator({
      channelId: 'topic:c',
      profileActorId: builtInAgentProfileId('claude'),
      agentFramework: 'claude',
      providerSession: { claudeSessionId: 'abc' },
    });
    expect(created.runtimeId).toBeNull();
    expect(created.role).toBe('orchestrator');
    const updated = s.upsertBinding({
      channelId: 'topic:c',
      profileActorId: builtInAgentProfileId('claude'),
      agentFramework: 'claude',
      runtimeId: 'runtime-9',
    });
    expect(updated.runtimeId).toBe('runtime-9');
    // Omitting role updates runtime state without erasing the designation.
    expect(updated.role).toBe('orchestrator');
    expect(updated.providerSession).toEqual({ claudeSessionId: 'abc' });

    // Arbitrary profile ids are real actor ids, never rewritten by a prefix
    // heuristic or legacy provider fallback.
    s.upsertBinding({
      channelId: 'topic:c',
      profileActorId: 'reviewer',
      agentFramework: 'claude',
      runtimeId: 'runtime-reviewer',
      providerSession: { lastDeliveredSeq: 9 },
    });
    expect(s.getBinding('topic:c', 'reviewer')).toMatchObject({
      profileActorId: 'reviewer',
      runtimeId: 'runtime-reviewer',
      providerSession: { lastDeliveredSeq: 9 },
    });
  });
});

describe('channel-message-store boot sweeps', () => {
  it('marks stale streaming rows truncated by restart and appends a system message', () => {
    const s = store();
    const stuck = s.beginStream({
      channelId: 'topic:c',
      sender: AGENT,
      source: { runtimeId: 'runtime-1' },
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
      source: { runtimeId: 'runtime', turnId: 'turn', itemId: 'reason' },
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

describe('channel-message-store full-text search (#1308 slice 2 item 1)', () => {
  function seq(s: ChannelMessageStore, channelId: string, text: string) {
    return s.appendComplete({ channelId, sender: HUMAN, text });
  }

  it('indexes a durable row on insert and finds it by term', () => {
    const s = store();
    const posted = seq(s, 'topic:alpha', 'the deployment pipeline is wedged');
    const hits = s.searchMessages({ query: 'wedged' });
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      messageId: posted.id,
      channelId: 'topic:alpha',
      seq: posted.seq,
      senderKind: 'human',
      senderId: 'human:operator',
      threadId: null,
      createdAt: posted.createdAt,
    });
    expect(hits[0]?.snippet).toContain('wedged');
    expect(hits[0]?.score).toBeLessThan(0);
  });

  it('re-indexes an edited body and stops matching the replaced text', () => {
    const s = store();
    const posted = seq(s, 'topic:alpha', 'original haystack sentence');
    s.editMessage({
      channelId: 'topic:alpha',
      messageId: posted.id,
      editorId: 'human:operator',
      text: 'replacement needle sentence',
    });
    expect(s.searchMessages({ query: 'haystack' })).toHaveLength(0);
    expect(
      s.searchMessages({ query: 'needle' }).map((hit) => hit.messageId)
    ).toEqual([posted.id]);
  });

  it('drops a tombstoned row out of the index', () => {
    const s = store();
    const posted = seq(s, 'topic:alpha', 'secret budget spreadsheet');
    expect(s.searchMessages({ query: 'spreadsheet' })).toHaveLength(1);
    s.deleteMessage({
      channelId: 'topic:alpha',
      messageId: posted.id,
      deleterId: 'human:operator',
    });
    expect(s.searchMessages({ query: 'spreadsheet' })).toHaveLength(0);
  });

  it('indexes a streaming row only once it is finalized', () => {
    const s = store();
    const streaming = s.beginStream({
      channelId: 'topic:alpha',
      sender: AGENT,
      source: { runtimeId: 'runtime-1', turnId: 'turn-1', itemId: 'item-1' },
      text: 'partial migrat',
    });
    s.updateStreamText(streaming.id, 'partial migration plan');
    expect(s.searchMessages({ query: 'migration' })).toHaveLength(0);

    s.finalizeStream(streaming.id, {
      text: 'complete migration plan',
      status: 'complete',
    });
    const hits = s.searchMessages({ query: 'migration' });
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      messageId: streaming.id,
      senderKind: 'agent',
      providerId: 'claude',
    });
  });

  it('excludes agent detail cards and system rows, and includes thread replies', () => {
    const s = store();
    const root = seq(s, 'topic:alpha', 'kubernetes rollout question');
    const reply = s.appendComplete({
      channelId: 'topic:alpha',
      sender: HUMAN,
      text: 'kubernetes rollout answer',
      parentMessageId: root.id,
    });
    s.appendComplete({
      channelId: 'topic:alpha',
      kind: 'system',
      sender: { kind: 'system', id: 'system' },
      text: 'kubernetes agent restarted',
    });
    const detail = s.beginStream({
      channelId: 'topic:alpha',
      sender: AGENT,
      source: { runtimeId: 'runtime-2', turnId: 'turn-2', itemId: 'detail-1' },
      agentDetail: {
        itemId: 'detail-1',
        card: {
          kind: 'thought',
          title: 'kubernetes get pods',
          status: 'running',
          content: 'kubernetes tool payload',
        },
      },
    });
    s.finalizeStream(detail.id, { text: '', status: 'complete' });

    const ids = s
      .searchMessages({ query: 'kubernetes' })
      .map((hit) => hit.messageId);
    expect(ids).toHaveLength(2);
    expect(new Set(ids)).toEqual(new Set([root.id, reply.id]));
    expect(
      s
        .searchMessages({ query: 'kubernetes' })
        .find((h) => h.messageId === reply.id)?.threadId
    ).toBe(root.id);
  });

  it('ranks the denser match first and caps results', () => {
    const s = store();
    seq(s, 'topic:alpha', 'a long note that mentions relay once in passing');
    const dense = seq(s, 'topic:alpha', 'relay relay relay');
    const ranked = s.searchMessages({ query: 'relay' });
    expect(ranked[0]?.messageId).toBe(dense.id);
    expect(ranked[0]!.score).toBeLessThan(ranked[1]!.score);

    for (let i = 0; i < 60; i += 1) {
      seq(s, 'topic:alpha', `bulk relay row ${i}`);
    }
    expect(s.searchMessages({ query: 'relay' })).toHaveLength(50);
    expect(s.searchMessages({ query: 'relay', limit: 3 })).toHaveLength(3);
  });

  it('scopes results to the caller-supplied channel allowlist', () => {
    const s = store();
    const visible = seq(s, 'topic:visible', 'shared incident report');
    seq(s, 'topic:hidden', 'shared incident report');
    expect(
      s
        .searchMessages({ query: 'incident', channelIds: ['topic:visible'] })
        .map((hit) => hit.messageId)
    ).toEqual([visible.id]);
    // An EMPTY allowlist means "nothing visible", never "no filter".
    expect(s.searchMessages({ query: 'incident', channelIds: [] })).toEqual([]);
    expect(s.searchMessages({ query: 'incident' })).toHaveLength(2);
  });

  it('treats operator text as literal terms, never as FTS5 operators', () => {
    const s = store();
    const posted = seq(s, 'topic:alpha', 'the NOT gate inverts a signal');
    expect(buildChannelSearchMatchQuery('NOT gate')).toBe('"NOT" AND "gate" *');
    expect(
      s.searchMessages({ query: 'NOT gate' }).map((hit) => hit.messageId)
    ).toEqual([posted.id]);
    // A quote cannot terminate the generated phrase. `hi` is under the minimum
    // prefix length, so it stays an EXACT phrase — the AND already bounds the
    // match set, so a short trailing term needs no prefix expansion.
    expect(buildChannelSearchMatchQuery('say "hi"')).toBe('"say" AND "hi"');
    // Nothing tokenizable is not a query at all.
    expect(buildChannelSearchMatchQuery('  ***  ')).toBeNull();
    expect(s.searchMessages({ query: '***' })).toEqual([]);
  });

  it('never builds a prefix expression for a short trailing term', () => {
    // The P0 guard: `*` on a one-character term expands to nearly the whole
    // term dictionary, and bm25 must rank every match before LIMIT drops it —
    // synchronously, on the hub's event loop. Asserted on the EXPRESSION, not
    // on latency, so the guard cannot be lost to a faster machine.
    expect(CHANNEL_SEARCH_MIN_QUERY_CHARS).toBe(3);
    expect(buildChannelSearchMatchQuery('a')).toBeNull();
    expect(buildChannelSearchMatchQuery('ab')).toBeNull();
    expect(buildChannelSearchMatchQuery('  a  ')).toBeNull();
    expect(buildChannelSearchMatchQuery('abc')).toBe('"abc" *');
    // Astral characters count once: length is code points, not UTF-16 units.
    expect(buildChannelSearchMatchQuery('𝟙𝟚')).toBeNull();
    // A short term next to a real one keeps its exact-phrase filter.
    expect(buildChannelSearchMatchQuery('deploy a')).toBe('"deploy" AND "a"');
    expect(buildChannelSearchMatchQuery('a deploy')).toBe('"a" AND "deploy" *');
  });

  it('names why a refused query was never dispatched to the index', () => {
    const s = store();
    seq(s, 'topic:alpha', 'a note that would match almost any prefix');
    expect(channelSearchUnavailableReason('   ')).toBe('empty_query');
    expect(channelSearchUnavailableReason('***')).toBe('no_searchable_term');
    expect(channelSearchUnavailableReason('a')).toBe('query_too_short');
    expect(channelSearchUnavailableReason('ab')).toBe('query_too_short');
    expect(channelSearchUnavailableReason('abc')).toBeNull();
    expect(channelSearchUnavailableReason('a note')).toBeNull();
    // The store agrees with the predicate: every refused shape returns no hits
    // WITHOUT reading the index, so the caller must not read an empty array as
    // "searched and found nothing".
    for (const query of ['   ', '***', 'a', 'ab']) {
      expect(s.searchMessages({ query })).toEqual([]);
    }
    expect(s.searchMessages({ query: 'note' })).toHaveLength(1);
  });

  it('bounds the prefix range the way the FTS5 tokenizer stored the terms', () => {
    // Only the FINAL term takes `*`, and only at the minimum length — the range
    // must agree with `buildChannelSearchMatchQuery` or the gate would cost a
    // prefix the query never runs.
    expect(channelSearchPrefixRange('')).toBeNull();
    expect(channelSearchPrefixRange('ab')).toBeNull();
    expect(channelSearchPrefixRange('deploy a')).toBeNull();
    expect(channelSearchPrefixRange('deploy')).toEqual({
      low: 'deploy',
      high: 'deploz',
    });
    expect(channelSearchPrefixRange('a deploy')).toEqual({
      low: 'deploy',
      high: 'deploz',
    });
    // Folded the way `unicode61 remove_diacritics 2` folds: case and combining
    // marks are gone before the range is computed, so an operator typing
    // `Déploy` probes the same terms the query will actually match.
    expect(channelSearchPrefixRange('Déploy')).toEqual({
      low: 'deploy',
      high: 'deploz',
    });
    // `"foo-bar" *` is the two-token phrase `foo bar` with the prefix on the
    // LAST token, so that is the token the range has to cover.
    expect(channelSearchPrefixRange('foo-bar')).toEqual({
      low: 'bar',
      high: 'bas',
    });
    // Pinned because it is the documented LIMIT of the fold, not a success case.
    // Two divergences compound on this input: `remove_diacritics 2` KEEPS the
    // Greek tonos (FTS5 stores `ΣΊΣΥΦΟΣ` as `σίσυφοσ`, U+03AF intact) where NFD
    // mark-stripping removes it, and `String.toLowerCase` maps a trailing Σ to
    // FINAL sigma U+03C2 where unicode61 always folds to U+03C3. The probe range
    // is therefore [σις, σισ) while the stored term begins `σί` — U+03AF sorts
    // below U+03B9, so the term is outside the range entirely and the walk counts
    // ZERO. Disjoint, not a conservative subset, which is exactly what the
    // `channelSearchPrefixRange` docblock now says instead of claiming the gate
    // always fails open. Asserted so a tokenizer or fold change surfaces here
    // rather than as a silently mis-costed gate.
    expect(channelSearchPrefixRange('ΣΊΣ')).toEqual({
      low: 'σις',
      high: 'σισ',
    });
  });

  it('refuses a prefix this corpus cannot afford, before reading the index', () => {
    const file = dbPath();
    const s = store(file);
    // Every row contributes one term under the shared `zzq` prefix, so the
    // prefix expansion is exactly the row count — the pathological shape #1316
    // measured, reproduced at a size a test can afford.
    const overBudget = CHANNEL_SEARCH_PREFIX_TERM_BUDGET + 8;
    for (let i = 0; i < overBudget; i += 1) {
      seq(s, 'topic:alpha', `broadcast zzq${i.toString(36)} payload`);
    }
    expect(() => s.searchMessages({ query: 'zzq' })).toThrow(
      ChannelSearchRefusedError
    );
    try {
      s.searchMessages({ query: 'zzq' });
      expect.unreachable('over-broad prefix must be refused');
    } catch (error) {
      expect((error as ChannelSearchRefusedError).reason).toBe(
        'search_query_too_broad'
      );
    }
    // The gate is on the PREFIX expansion, not on the corpus: an exact term in
    // the same store still answers, and a longer prefix over the same rows
    // narrows back under the budget instead of staying refused.
    expect(s.searchMessages({ query: 'broadcast' })).toHaveLength(50);
    expect(s.searchMessages({ query: 'zzq1' }).length).toBeGreaterThan(0);
    // A trailing term below the minimum never gets `*`, so it is never costed —
    // it is refused by the older, cheaper guard instead.
    expect(s.searchMessages({ query: 'zz' })).toEqual([]);

    // DEGRADED CONTRACT. The pre-flight fails OPEN when the `fts5vocab` view
    // cannot be built, which is right for the mid-rebuild window it was written
    // for and a real loss of coverage if it becomes permanent — so what the
    // fallback actually does is asserted here rather than left an untested
    // branch. Same file, same corpus, second connection (the view is `temp.`,
    // so it is genuinely per-connection): the store still ANSWERS, and the
    // prefix the gate would have refused now runs under the wall-clock ceiling
    // alone. That ceiling is a per-ROW hook, so this is strictly weaker than the
    // guarded path, not equivalent to it.
    const degraded = store(file, { searchCostPreflight: 'unavailable' });
    expect(() => degraded.searchMessages({ query: 'zzq' })).not.toThrow();
    expect(degraded.searchMessages({ query: 'broadcast' })).toHaveLength(50);
  });

  it('pins the search cost budgets to the band they were measured against', () => {
    // Mirrors of the measurements recorded in the CHANNEL_SEARCH_PREFIX_*
    // docblocks (shared/channel-chat-protocol.ts). Re-measuring the corpus means
    // updating BOTH — this test is what makes moving a budget out of the
    // measured band fail here instead of on a production hub, which the store
    // tests above cannot do because they seed relative to the constant and stay
    // green at any value.
    const heaviestLegitimatePrefixTerms = 973; // `"con" *`, 108ms
    const pathologicalPrefixTerms = 4281; // `"a" *`, 1086ms — must stay refused
    const docsRankedPerMs = 4300;
    const measuredLegitimateWorstMs = 158; // #1316, three-char prefix at 50k

    // Headroom over the heaviest LEGITIMATE prefix, because prefix expansion
    // grows with vocabulary while this budget is an absolute count: too tight
    // and ordinary words start answering `search_query_too_broad` on every
    // keystroke as the transcript grows, with nothing saying the guard is why.
    expect(CHANNEL_SEARCH_PREFIX_TERM_BUDGET).toBeGreaterThanOrEqual(
      heaviestLegitimatePrefixTerms * 2
    );
    expect(CHANNEL_SEARCH_PREFIX_TERM_BUDGET).toBeLessThan(
      pathologicalPrefixTerms
    );

    // The doc budget is the ONLY bound on a query that emits no rows — an AND
    // whose intersection is empty never reaches the per-row ceiling at all — so
    // what it permits IS an un-interruptible synchronous window. Keeping that
    // window inside the interruptible ceiling is the invariant; ten times this
    // budget is ~2.3s of frozen event loop, which is the defect #1316 was filed
    // for.
    expect(
      CHANNEL_SEARCH_PREFIX_DOC_BUDGET / docsRankedPerMs
    ).toBeLessThanOrEqual(CHANNEL_SEARCH_TIME_BUDGET_MS);

    // And the ceiling has to stay clear of the legitimate band it backstops, or
    // it stops being a backstop and becomes a second gate on honest queries.
    expect(CHANNEL_SEARCH_TIME_BUDGET_MS).toBeGreaterThan(
      measuredLegitimateWorstMs * 2
    );
  });

  it('abandons a read that outruns its wall-clock budget', () => {
    // Budget 0 makes the ceiling fire on the FIRST matched row, which is what
    // keeps this a contract test rather than a latency test: a faster CI box
    // cannot quietly turn it green, and it needs no pathological corpus.
    const s = store(undefined, { searchTimeBudgetMs: 0 });
    seq(s, 'topic:alpha', 'the deployment pipeline is wedged');
    try {
      s.searchMessages({ query: 'deployment' });
      expect.unreachable('an exhausted budget must abandon the read');
    } catch (error) {
      expect(error).toBeInstanceOf(ChannelSearchRefusedError);
      expect((error as ChannelSearchRefusedError).reason).toBe(
        'search_timeout'
      );
    }
    // The ceiling is armed per call and disarmed afterwards, so it can only
    // ever abort the read it was armed for — a store on the shipped budget
    // answers the same query normally.
    const normal = store();
    seq(normal, 'topic:alpha', 'the deployment pipeline is wedged');
    expect(normal.searchMessages({ query: 'deployment' })).toHaveLength(1);
    expect(CHANNEL_SEARCH_TIME_BUDGET_MS).toBeGreaterThan(0);
  });

  it('backfills an existing db idempotently and rebuilds a dropped index', () => {
    const file = dbPath();
    const seeded = createChannelMessageStore(file);
    seeded.appendComplete({
      channelId: 'topic:alpha',
      sender: HUMAN,
      text: 'durable backfill subject',
    });
    const tombstoned = seeded.appendComplete({
      channelId: 'topic:alpha',
      sender: HUMAN,
      text: 'backfill tombstone subject',
    });
    seeded.deleteMessage({
      channelId: 'topic:alpha',
      messageId: tombstoned.id,
      deleterId: 'human:operator',
    });
    seeded.close();

    // Rewind to a genuine pre-#1308 (v5) db: no index, no triggers, older
    // schema_version — the exact shape an upgrading hub opens.
    const raw = new Database(file);
    raw.exec('DROP TRIGGER channel_messages_fts_ai');
    raw.exec('DROP TRIGGER channel_messages_fts_au');
    raw.exec('DROP TRIGGER channel_messages_fts_ad');
    raw.exec('DROP TABLE channel_messages_fts');
    raw.exec('UPDATE schema_version SET version = 5');
    raw.close();

    const reopened = store(file);
    expect(
      reopened.searchMessages({ query: 'backfill' }).map((h) => h.snippet)
    ).toHaveLength(1);
    expect(reopened.searchMessages({ query: 'tombstone' })).toHaveLength(0);
    reopened.close();

    // Reopening a healthy db must not duplicate index entries.
    const again = store(file);
    expect(again.searchMessages({ query: 'backfill' })).toHaveLength(1);
    const counted = new Database(file);
    const rows = counted
      .prepare(
        'SELECT COUNT(*) AS count FROM channel_messages_fts WHERE channel_messages_fts MATCH \'"backfill"\''
      )
      .get() as { count: number };
    const version = counted
      .prepare('SELECT version FROM schema_version')
      .get() as { version: number };
    counted.close();
    expect(rows.count).toBe(1);
    expect(version.version).toBe(15);
  });

  it('backfills across more than one batch without dropping or duplicating rows', () => {
    const file = dbPath();
    const seeded = store(file);
    seeded.appendComplete({
      channelId: 'topic:alpha',
      sender: HUMAN,
      text: 'batchword anchor row',
    });
    seeded.close();

    // Raw inserts so the fixture crosses the 5k-row commit boundary quickly.
    // The point is the rowid-range cursor: a batched backfill that mis-bounds a
    // range silently skips or double-indexes whole 5k blocks, and a small
    // fixture would never leave the first batch to notice.
    const total = 5_200;
    const raw = new Database(file);
    const insert = raw.prepare(
      `INSERT INTO channel_messages
         (id, channel_id, seq, kind, sender_kind, sender_id, body_text, created_at, updated_at)
       VALUES (?, 'topic:alpha', ?, ?, 'human', 'human:operator', ?, ?, ?)`
    );
    const now = new Date().toISOString();
    raw.transaction(() => {
      for (let i = 0; i < total; i += 1) {
        // Every tenth row is hub bookkeeping: the predicate must be applied per
        // batch, not only to the first one.
        const systemRow = i % 10 === 0;
        insert.run(
          `chm:bulk-${i}`,
          i + 2,
          systemRow ? 'system' : 'message',
          `batchword bulk row ${i}`,
          now,
          now
        );
      }
    })();
    raw.exec('DROP TRIGGER channel_messages_fts_ai');
    raw.exec('DROP TRIGGER channel_messages_fts_au');
    raw.exec('DROP TRIGGER channel_messages_fts_ad');
    raw.exec('DROP TABLE channel_messages_fts');
    raw.close();

    const reopened = store(file);
    const counted = new Database(file);
    const indexed = counted
      .prepare(
        `SELECT COUNT(*) AS count FROM channel_messages_fts
          WHERE channel_messages_fts MATCH '"batchword"'`
      )
      .get() as { count: number };
    counted.close();
    // 1 anchor + every non-system bulk row, each exactly once.
    expect(indexed.count).toBe(1 + total - total / 10);
    expect(reopened.searchMessages({ query: 'batchword' })).toHaveLength(50);
  });

  it('finishes a crash-truncated backfill instead of trusting the DDL', () => {
    const file = dbPath();
    const seeded = createChannelMessageStore(file);
    for (let i = 0; i < 6; i += 1) {
      seeded.appendComplete({
        channelId: 'topic:alpha',
        sender: HUMAN,
        text: `needle${i} shared subject`,
      });
    }
    seeded.close();

    // Reproduce the exact on-disk state a kill mid-backfill leaves behind:
    // table + all three triggers committed, the marker still claiming
    // `building`, and index entries present only up to the cursor. Batches walk
    // rowid ASCENDING, so what is missing is the NEWEST messages — the ones an
    // operator is most likely to search for, and the shape that a
    // presence-only integrity check reports as healthy forever.
    const raw = new Database(file);
    const cutoff = (
      raw
        .prepare(
          'SELECT rowid AS id FROM channel_messages ORDER BY rowid LIMIT 1 OFFSET 2'
        )
        .get() as { id: number }
    ).id;
    raw
      .prepare(
        `INSERT INTO channel_messages_fts(channel_messages_fts, rowid, id, channel_id, body_text)
         SELECT 'delete', m.rowid, m.id, m.channel_id, m.body_text
           FROM channel_messages m WHERE m.rowid > ?`
      )
      .run(cutoff);
    raw
      .prepare(
        `UPDATE channel_search_state
            SET status = 'building',
                indexed_through_rowid = ?,
                snapshot_max_rowid =
                  (SELECT MAX(rowid) FROM channel_messages)`
      )
      .run(cutoff);
    const truncatedTail = (
      raw
        .prepare(
          `SELECT COUNT(*) AS count FROM channel_messages_fts
            WHERE channel_messages_fts MATCH '"needle5"'`
        )
        .get() as { count: number }
    ).count;
    raw.close();
    // Pre-condition: the tail really is unsearchable in the crashed db.
    expect(truncatedTail).toBe(0);

    const reopened = store(file);
    expect(reopened.searchMessages({ query: 'needle5' })).toHaveLength(1);
    expect(reopened.searchMessages({ query: 'needle0' })).toHaveLength(1);
    // Exactly once each: a resume that re-ran an already-committed range would
    // double-index the head, and external-content FTS5 has no upsert to absorb
    // it. This is also why the cursor advances inside the batch transaction.
    expect(reopened.searchMessages({ query: 'shared' })).toHaveLength(6);
    reopened.close();

    const marked = new Database(file);
    const state = marked
      .prepare(
        'SELECT status, indexed_through_rowid FROM channel_search_state WHERE id = 1'
      )
      .get() as { status: string; indexed_through_rowid: number };
    const headEntries = marked
      .prepare(
        `SELECT COUNT(*) AS count FROM channel_messages_fts
          WHERE channel_messages_fts MATCH '"needle0"'`
      )
      .get() as { count: number };
    marked.close();
    expect(state.status).toBe('complete');
    expect(state.indexed_through_rowid).toBeGreaterThanOrEqual(cutoff);
    expect(headEntries.count).toBe(1);

    // A second open must be a no-op: the marker, not the DDL, is what says so.
    const again = store(file);
    expect(again.searchMessages({ query: 'shared' })).toHaveLength(6);
  });

  it('rebuilds when the completeness marker is absent under an intact index', () => {
    const file = dbPath();
    const seeded = store(file);
    seeded.appendComplete({
      channelId: 'topic:alpha',
      sender: HUMAN,
      text: 'markerless subject',
    });
    seeded.close();

    // A db written before the marker existed (or one an operator edited) has an
    // index nothing can vouch for. It is not resumable — there is no cursor to
    // resume from — so it must be rebuilt from scratch, exactly once.
    const raw = new Database(file);
    raw.exec('DELETE FROM channel_search_state');
    raw.close();

    const reopened = store(file);
    expect(reopened.searchMessages({ query: 'markerless' })).toHaveLength(1);
    reopened.close();

    const counted = new Database(file);
    const entries = counted
      .prepare(
        `SELECT COUNT(*) AS count FROM channel_messages_fts
          WHERE channel_messages_fts MATCH '"markerless"'`
      )
      .get() as { count: number };
    const state = counted
      .prepare('SELECT status FROM channel_search_state WHERE id = 1')
      .get() as { status: string };
    counted.close();
    expect(entries.count).toBe(1);
    expect(state.status).toBe('complete');
  });

  it('keeps the implicit-rowid contract the external-content index rides on', () => {
    const file = dbPath();
    const s = store(file);
    s.appendComplete({
      channelId: 'topic:alpha',
      sender: HUMAN,
      text: 'rowid contract subject',
    });
    const raw = new Database(file);
    const ddl = (
      raw
        .prepare(
          `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'channel_messages'`
        )
        .get() as { sql: string }
    ).sql;
    raw.close();
    // `id` is TEXT PRIMARY KEY, so the FTS join key is the table's IMPLICIT
    // rowid. WITHOUT ROWID would remove that mapping outright and break every
    // index entry; assert the declaration can never acquire it.
    expect(ddl).not.toMatch(/WITHOUT\s+ROWID/i);
    expect(ddl).toMatch(/id\s+TEXT PRIMARY KEY/);

    // Implicit rowids are renumbered by VACUUM, which would silently repoint
    // every index entry at a different message — search answering with another
    // channel's body under a correct-looking snippet. No maintenance path in
    // the store may issue one without rebuilding the index afterwards.
    const source = fs.readFileSync(
      new URL('../server/channel-message-store.ts', import.meta.url),
      'utf8'
    );
    expect(source).not.toMatch(/^\s*[^*/\n]*\bVACUUM\b/im);
  });

  it('drives the search from the FTS index, probing messages by rowid', () => {
    const file = dbPath();
    const s = store(file);
    s.appendComplete({
      channelId: 'topic:alpha',
      sender: HUMAN,
      text: 'query plan subject',
    });
    const raw = new Database(file);
    // The production SQL carries the #1316 wall-clock hook, and SQLite resolves
    // function names at PREPARE time, so a second handle has to install it too.
    // A no-op is the right stub: the assertion is about the plan, and the whole
    // point of putting the hook in the WHERE clause is that it never adds to one.
    registerChannelSearchTick(raw, () => false);
    const plan = raw
      .prepare(`EXPLAIN QUERY PLAN ${buildChannelMessageSearchSql(1)}`)
      .all('', '', '…', '"plan"', 'topic:alpha', 10) as Array<{
      detail: string;
    }>;
    raw.close();
    const details = plan.map((row) => row.detail);
    // The FTS index must DRIVE (first) and `channel_messages` must be probed by
    // rowid — not the reverse, which walks every message in every allowed
    // channel. A plain JOIN regresses to exactly that; see the CROSS JOIN note
    // on `buildChannelMessageSearchSql`.
    expect(details[0]).toMatch(
      /channel_messages_fts VIRTUAL TABLE INDEX .*M\d/
    );
    expect(details[1]).toMatch(/SEARCH m USING INTEGER PRIMARY KEY/);
  });
});

describe('channel-message-store read state (#1308 slice 3 item 1)', () => {
  function post(s: ChannelMessageStore, channelId: string, text: string) {
    return s.appendComplete({ channelId, sender: HUMAN, text });
  }

  it('starts empty and records a mark keyed by channel', () => {
    const s = store();
    expect(s.listReadState()).toEqual([]);
    post(s, 'topic:alpha', 'one');
    post(s, 'topic:alpha', 'two');
    const result = s.markChannelRead('topic:alpha', 2);
    expect(result).toMatchObject({
      channelId: 'topic:alpha',
      lastReadSeq: 2,
      advanced: true,
    });
    expect(typeof result.updatedAt).toBe('string');
    expect(s.listReadState()).toEqual([
      { channelId: 'topic:alpha', lastReadSeq: 2, updatedAt: result.updatedAt },
    ]);
  });

  it('ignores a mark at or below the stored one so a lagging device cannot regress another', () => {
    const s = store();
    for (let i = 0; i < 5; i += 1) post(s, 'topic:alpha', `m${i}`);
    // Desktop reads to the head.
    const desktop = s.markChannelRead('topic:alpha', 5);
    expect(desktop.advanced).toBe(true);

    // Phone, asleep since seq 2, reports its stale position.
    const phone = s.markChannelRead('topic:alpha', 2);
    expect(phone.advanced).toBe(false);
    // The response reports the DURABLE mark, not the rejected input, so the
    // laggard converges from its own reply.
    expect(phone.lastReadSeq).toBe(5);
    expect(phone.updatedAt).toBe(desktop.updatedAt);
    expect(s.listReadState()).toEqual([
      {
        channelId: 'topic:alpha',
        lastReadSeq: 5,
        updatedAt: desktop.updatedAt,
      },
    ]);

    // Equal is a no-op too (idempotent retry), and a higher mark still advances.
    expect(s.markChannelRead('topic:alpha', 5).advanced).toBe(false);
    expect(s.markChannelRead('topic:alpha', 5).lastReadSeq).toBe(5);
  });

  it('clamps a mark to the channel head instead of storing a position past the last row', () => {
    const s = store();
    post(s, 'topic:alpha', 'only');
    const ahead = s.markChannelRead('topic:alpha', 99);
    expect(ahead).toMatchObject({ lastReadSeq: 1, advanced: true });
    // A channel with no durable rows has nothing to mark read.
    expect(s.markChannelRead('topic:empty', 7)).toMatchObject({
      lastReadSeq: 0,
      advanced: false,
    });
    expect(s.listReadState().map((row) => row.channelId)).toEqual([
      'topic:alpha',
    ]);
  });

  it('reports a mark stranded above a rewound head as the head, and lets the channel be marked again', () => {
    // A DM deleted and recreated under the same deterministic id restarts its
    // seq low (#1178). If the sweep has not yet collected the marker, the stored
    // mark now sits ABOVE the head. Clamping matches the client's own #1178
    // repair (`clampChannelStores`): the mark drops to the head, so messages
    // posted from here on are unread again.
    const file = dbPath();
    const s = store(file);
    for (let i = 0; i < 4; i += 1) post(s, 'topic:dm', `old${i}`);
    s.markChannelRead('topic:dm', 4);

    // Drop the transcript WITHOUT touching the marker (the sweep is what would
    // normally take both), then rebuild a shorter one: head 2, stored mark 4.
    const raw = new Database(file);
    raw
      .prepare('DELETE FROM channel_messages WHERE channel_id = ?')
      .run('topic:dm');
    raw.close();
    post(s, 'topic:dm', 'recreated 1');
    post(s, 'topic:dm', 'recreated 2');
    expect(s.latestSeq('topic:dm')).toBe(2);
    expect(s.listReadState()[0]?.lastReadSeq).toBe(2);

    // The write path clamps the same way, so its reply agrees with the GET seed
    // instead of echoing the stranded 4 back at the device that just wrote.
    expect(s.markChannelRead('topic:dm', 2)).toMatchObject({
      lastReadSeq: 2,
      advanced: false,
    });

    // And the channel is not frozen: once it grows past the stranded mark,
    // marks land again and the stale row is overwritten.
    for (let i = 3; i <= 5; i += 1) post(s, 'topic:dm', `recreated ${i}`);
    expect(s.markChannelRead('topic:dm', 5)).toMatchObject({
      lastReadSeq: 5,
      advanced: true,
    });
    expect(s.listReadState()[0]?.lastReadSeq).toBe(5);
  });

  it('sweeps read marks for channels the topic store no longer knows', () => {
    const s = store();
    post(s, 'topic:live', 'keep');
    post(s, 'topic:gone', 'orphan');
    s.markChannelRead('topic:live', 1);
    s.markChannelRead('topic:gone', 1);
    expect(s.listReadState().map((row) => row.channelId)).toEqual([
      'topic:gone',
      'topic:live',
    ]);

    const result = s.sweepOrphans(new Set(['topic:live']));
    expect(result.channelsDeleted).toEqual(['topic:gone']);
    expect(s.listReadState()).toEqual([
      {
        channelId: 'topic:live',
        lastReadSeq: 1,
        updatedAt: expect.any(String),
      },
    ]);
  });

  it('sweeps a channel whose only surviving row is a read mark', () => {
    const file = dbPath();
    const s = store(file);
    post(s, 'topic:live', 'keep');
    s.markChannelRead('topic:live', 1);
    // Mark-only channel: nothing in messages/members/bindings names it, so it is
    // reachable as an orphan candidate only because the sweep enumerates this
    // table too. Reached here by deleting the transcript out from under a mark
    // (the shape a partial cleanup leaves behind).
    post(s, 'topic:markonly', 'gone soon');
    s.markChannelRead('topic:markonly', 1);
    const raw = new Database(file);
    raw
      .prepare('DELETE FROM channel_messages WHERE channel_id = ?')
      .run('topic:markonly');
    raw.close();
    expect(s.listReadState().map((row) => row.channelId)).toContain(
      'topic:markonly'
    );

    const result = s.sweepOrphans(new Set(['topic:live']));
    expect(result.channelsDeleted).toEqual(['topic:markonly']);
    expect(s.listReadState().map((row) => row.channelId)).toEqual([
      'topic:live',
    ]);
  });

  it('sweeps a channel whose only surviving durable rows are async runs', () => {
    const file = dbPath();
    const s = store(file);
    const { run } = s.appendCompleteWithAsyncRun({
      channelId: 'topic:run-only',
      sender: HUMAN,
      text: 'orphaned request',
      targetIds: ['agent-profile:mock:default'],
    });
    const raw = new Database(file);
    raw
      .prepare('DELETE FROM channel_messages WHERE channel_id = ?')
      .run('topic:run-only');
    raw.close();

    expect(s.getAsyncRun(run.id)?.id).toBe(run.id);
    expect(s.sweepOrphans(new Set()).channelsDeleted).toEqual([
      'topic:run-only',
    ]);
    expect(s.getAsyncRun(run.id)).toBeNull();
  });

  it('survives a reopen and repairs a dropped read-state table', () => {
    const file = dbPath();
    const first = store(file);
    first.appendComplete({
      channelId: 'topic:alpha',
      sender: HUMAN,
      text: 'a',
    });
    first.markChannelRead('topic:alpha', 1);
    first.close();

    const reopened = store(file);
    expect(reopened.listReadState()).toEqual([
      {
        channelId: 'topic:alpha',
        lastReadSeq: 1,
        updatedAt: expect.any(String),
      },
    ]);
    reopened.close();

    // The table is created on EVERY open, not behind a one-shot numbered
    // migration, so a dropped table is repaired rather than stranded.
    const raw = new Database(file);
    raw.exec('DROP TABLE channel_read_state');
    raw.close();
    const repaired = store(file);
    expect(repaired.listReadState()).toEqual([]);
    expect(repaired.markChannelRead('topic:alpha', 1)).toMatchObject({
      lastReadSeq: 1,
      advanced: true,
    });
  });
});

describe('channel completion callback edge store', () => {
  function edgeInput(overrides: Record<string, unknown> = {}) {
    return {
      id: 'chcb:turn:delegatee:1',
      channelId: 'topic:callbacks',
      threadId: null,
      triggerMessageId: 'chm:trigger',
      requesterProfileId: 'agent-profile:claude:default',
      targetProfileId: 'agent-profile:codex:default',
      targetRuntimeId: 'runtime:codex:1',
      targetTurnId: 'turn:delegatee:1',
      ...overrides,
    };
  }

  it('persists one target-turn edge and CASes pending through consumed exactly once', () => {
    const file = dbPath();
    const first = store(file);
    const created = first.createCompletionCallback(edgeInput());
    expect(created).toMatchObject({
      state: 'pending',
      channelId: 'topic:callbacks',
      requesterProfileId: 'agent-profile:claude:default',
      targetProfileId: 'agent-profile:codex:default',
      targetRuntimeId: 'runtime:codex:1',
      targetTurnId: 'turn:delegatee:1',
    });
    // The target turn is the durable idempotency boundary, not binder memory.
    expect(
      first.createCompletionCallback(
        edgeInput({ id: 'different-id', targetRuntimeId: 'runtime:retry' })
      )
    ).toMatchObject({ id: created.id, targetRuntimeId: 'runtime:codex:1' });
    expect(
      first.satisfyCompletionCallback({
        channelId: 'topic:callbacks',
        targetProfileId: 'agent-profile:codex:default',
        targetTurnId: 'turn:delegatee:1',
        terminalReason: 'completed',
        terminalMessageId: 'chm:final',
        messageDisposition: 'final-message',
      })
    ).toMatchObject({ state: 'satisfied', terminalReason: 'completed' });
    expect(
      first.satisfyCompletionCallback({
        channelId: 'topic:callbacks',
        targetProfileId: 'agent-profile:codex:default',
        targetTurnId: 'turn:delegatee:1',
        terminalReason: 'error',
        messageDisposition: 'no-terminal-message',
      })
    ).toBeNull();
    expect(first.claimSatisfiedCompletionCallbacks()).toMatchObject([
      { id: created.id, state: 'delivered', terminalReason: 'completed' },
    ]);
    expect(first.consumeCompletionCallback(created.id)).toBe(true);
    expect(first.consumeCompletionCallback(created.id)).toBe(false);
    first.close();

    const reopened = store(file);
    expect(reopened.recoverCompletionCallbacks()).toEqual([]);
  });

  it('CAS-terminalizes an unavailable requester without recovery, while retaining bounded evidence', async () => {
    const s = store();
    const edge = s.createCompletionCallback(
      edgeInput({ threadId: 'chm:thread-root' })
    );
    s.satisfyCompletionCallback({
      channelId: edge.channelId,
      targetProfileId: edge.targetProfileId,
      targetTurnId: edge.targetTurnId,
      terminalReason: 'completed',
      terminalMessageId: 'chm:delegatee-final',
      messageDisposition: 'final-message',
    });
    expect(s.claimSatisfiedCompletionCallbacks()).toHaveLength(1);
    // Thread scope participates in the CAS; a root-scope caller cannot spend a
    // claimed callback from a named conversation.
    expect(
      s.terminalizeDeliveredCompletionCallback({
        id: edge.id,
        channelId: edge.channelId,
        threadId: null,
        deliveryReason: 'requester-profile-unavailable',
      })
    ).toBeNull();
    expect(
      s.terminalizeDeliveredCompletionCallback({
        id: edge.id,
        channelId: edge.channelId,
        threadId: edge.threadId,
        deliveryReason: 'requester-profile-unavailable',
      })
    ).toMatchObject({
      state: 'undeliverable',
      terminalReason: 'completed',
      deliveryReason: 'requester-profile-unavailable',
      terminalMessageId: 'chm:delegatee-final',
      undeliverableAt: expect.any(String),
    });
    expect(s.claimSatisfiedCompletionCallbacks()).toEqual([]);
    expect(s.recoverCompletionCallbacks()).toEqual([]);
    expect(
      s.terminalizeDeliveredCompletionCallback({
        id: edge.id,
        channelId: edge.channelId,
        threadId: edge.threadId,
        deliveryReason: 'requester-profile-unavailable',
      })
    ).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(s.pruneConsumedCompletionCallbacks(0)).toBe(1);
    expect(s.getCompletionCallback(edge.id)).toBeNull();
  });

  it('terminalizes unresolved continuation ancestry rather than fabricating an upward callback', () => {
    const s = store();
    const parent = s.createCompletionCallback(edgeInput({ id: 'chcb:parent' }));
    s.deferCompletionCallbackForChild({
      channelId: parent.channelId,
      targetProfileId: parent.targetProfileId,
      targetTurnId: parent.targetTurnId,
      expectedChildCount: 1,
    });
    const child = s.createCompletionCallback(
      edgeInput({
        id: 'chcb:child',
        requesterProfileId: parent.targetProfileId,
        targetProfileId: 'agent-profile:hermes:default',
        targetRuntimeId: 'runtime:hermes:1',
        targetTurnId: 'turn:child',
        continuationParentCallbackId: parent.id,
      })
    );
    s.satisfyCompletionCallback({
      channelId: child.channelId,
      targetProfileId: child.targetProfileId,
      targetTurnId: child.targetTurnId,
      terminalReason: 'completed',
      messageDisposition: 'no-terminal-message',
    });
    expect(s.claimSatisfiedCompletionCallbacks()).toMatchObject([
      { id: child.id, state: 'delivered' },
    ]);
    s.terminalizeDeliveredCompletionCallback({
      id: child.id,
      channelId: child.channelId,
      threadId: child.threadId,
      deliveryReason: 'requester-profile-unavailable',
    });
    expect(s.getCompletionCallback(child.id)).toMatchObject({
      state: 'undeliverable',
      deliveryReason: 'requester-profile-unavailable',
    });
    expect(s.getCompletionCallback(parent.id)).toMatchObject({
      state: 'undeliverable',
      deliveryReason: 'continuation-undeliverable',
    });
    expect(s.recoverCompletionCallbacks()).toEqual([]);
  });

  it('recovers volatile delivery and terminalizes restart-orphaned pending turns from durable evidence only', () => {
    const s = store();
    const final = s.beginStream({
      channelId: 'topic:callbacks',
      sender: {
        kind: 'agent',
        id: 'agent-profile:codex:default',
        providerId: 'codex',
      },
      source: {
        runtimeId: 'runtime:codex:1',
        turnId: 'turn:delegatee:1',
        itemId: 'assistant:final',
      },
    });
    const finalized = s.finalizeStream(final.id, {
      text: 'finished without mentioning the requester',
      status: 'complete',
    })!;
    const evidenced = s.createCompletionCallback(edgeInput());
    const silent = s.createCompletionCallback(
      edgeInput({
        id: 'chcb:turn:silent',
        targetRuntimeId: 'runtime:codex:2',
        targetTurnId: 'turn:silent',
      })
    );
    s.satisfyCompletionCallback({
      channelId: evidenced.channelId,
      targetProfileId: evidenced.targetProfileId,
      targetTurnId: evidenced.targetTurnId,
      terminalReason: 'completed',
      terminalMessageId: finalized.id,
      messageDisposition: 'final-message',
    });
    expect(s.claimSatisfiedCompletionCallbacks()).toHaveLength(1);

    const recovered = s.recoverCompletionCallbacks();
    expect(recovered).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: evidenced.id,
          state: 'satisfied',
          terminalReason: 'completed',
          terminalMessageId: finalized.id,
          messageDisposition: 'final-message',
        }),
        expect.objectContaining({
          id: silent.id,
          state: 'satisfied',
          terminalReason: 'unexpected-disconnect',
          messageDisposition: 'no-terminal-message',
        }),
      ])
    );
    expect(s.claimSatisfiedCompletionCallbacks()).toHaveLength(2);
  });

  it('persists an ancestor defer until its child callback continuation terminalizes', () => {
    const s = store();
    const parent = s.createCompletionCallback(edgeInput());
    expect(
      s.deferCompletionCallbackForChild({
        channelId: parent.channelId,
        targetProfileId: parent.targetProfileId,
        targetTurnId: parent.targetTurnId,
        expectedChildCount: 1,
      })
    ).toMatchObject({ id: parent.id, state: 'pending', awaitingChild: true });
    // B's first terminal event records its row but does not wake A yet.
    expect(
      s.satisfyCompletionCallback({
        channelId: parent.channelId,
        targetProfileId: parent.targetProfileId,
        targetTurnId: parent.targetTurnId,
        terminalReason: 'completed',
        terminalMessageId: 'chm:b-delegated-c',
        messageDisposition: 'final-message',
      })
    ).toBeNull();
    const child = s.createCompletionCallback(
      edgeInput({
        id: 'chcb:turn:c',
        requesterProfileId: parent.targetProfileId,
        targetProfileId: 'agent-profile:hermes:default',
        targetRuntimeId: 'runtime:hermes:1',
        targetTurnId: 'turn:c',
        continuationParentCallbackId: parent.id,
      })
    );
    expect(child.continuationParentCallbackId).toBe(parent.id);
    expect(s.getCompletionCallback(parent.id)).toMatchObject({
      awaitingChild: true,
      pendingChildIntents: 0,
    });
    s.satisfyCompletionCallback({
      channelId: child.channelId,
      targetProfileId: child.targetProfileId,
      targetTurnId: child.targetTurnId,
      terminalReason: 'completed',
      messageDisposition: 'no-terminal-message',
    });
    s.claimSatisfiedCompletionCallbacks();
    expect(s.consumeCompletionCallback(child.id)).toBe(true);
    expect(s.getCompletionCallback(child.id)).toMatchObject({
      state: 'consumed',
      continuationCompletedAt: null,
    });
    expect(s.getCompletionCallback(parent.id)).toMatchObject({
      state: 'pending',
      awaitingChild: true,
      pendingChildIntents: 0,
    });
    const continuation = s.completeChildContinuation({
      callbackId: child.id,
      terminalReason: 'completed',
      terminalMessageId: 'chm:b-final',
      messageDisposition: 'final-message',
    });
    expect(s.getCompletionCallback(child.id)).toMatchObject({
      continuationCompletedAt: expect.any(String),
    });
    expect(continuation).toMatchObject({
      id: parent.id,
      state: 'satisfied',
      terminalMessageId: 'chm:b-final',
      awaitingChild: false,
    });
    expect(s.claimSatisfiedCompletionCallbacks()).toMatchObject([
      { id: parent.id, state: 'delivered' },
    ]);
  });

  it('fans in staggered child continuations without releasing the parent twice', () => {
    const s = store();
    const parent = s.createCompletionCallback(edgeInput());
    s.deferCompletionCallbackForChild({
      channelId: parent.channelId,
      targetProfileId: parent.targetProfileId,
      targetTurnId: parent.targetTurnId,
      expectedChildCount: 2,
    });
    s.satisfyCompletionCallback({
      channelId: parent.channelId,
      targetProfileId: parent.targetProfileId,
      targetTurnId: parent.targetTurnId,
      terminalReason: 'completed',
      messageDisposition: 'no-terminal-message',
    });
    const c = s.createCompletionCallback(
      edgeInput({
        id: 'chcb:turn:c',
        requesterProfileId: parent.targetProfileId,
        targetProfileId: 'agent-profile:hermes:default',
        targetRuntimeId: 'runtime:hermes:1',
        targetTurnId: 'turn:c',
        continuationParentCallbackId: parent.id,
      })
    );
    const d = s.createCompletionCallback(
      edgeInput({
        id: 'chcb:turn:d',
        requesterProfileId: parent.targetProfileId,
        targetProfileId: 'agent-profile:gemini:default',
        targetRuntimeId: 'runtime:gemini:1',
        targetTurnId: 'turn:d',
        continuationParentCallbackId: parent.id,
      })
    );
    for (const child of [c, d]) {
      s.satisfyCompletionCallback({
        channelId: child.channelId,
        targetProfileId: child.targetProfileId,
        targetTurnId: child.targetTurnId,
        terminalReason: 'completed',
        messageDisposition: 'no-terminal-message',
      });
    }
    expect(s.claimSatisfiedCompletionCallbacks()).toHaveLength(2);
    expect(s.consumeCompletionCallback(c.id)).toBe(true);
    expect(s.consumeCompletionCallback(d.id)).toBe(true);
    expect(
      s.completeChildContinuation({
        callbackId: c.id,
        terminalReason: 'completed',
        messageDisposition: 'no-terminal-message',
      })
    ).toBeNull();
    // A duplicate or late terminal patch cannot finish C twice or release A.
    expect(
      s.completeChildContinuation({
        callbackId: c.id,
        terminalReason: 'error',
        messageDisposition: 'no-terminal-message',
      })
    ).toBeNull();
    expect(s.getCompletionCallback(parent.id)).toMatchObject({
      state: 'pending',
      awaitingChild: true,
    });
    expect(
      s.completeChildContinuation({
        callbackId: d.id,
        terminalReason: 'completed',
        terminalMessageId: 'chm:b-after-d',
        messageDisposition: 'final-message',
      })
    ).toMatchObject({
      id: parent.id,
      state: 'satisfied',
      terminalMessageId: 'chm:b-after-d',
    });
  });

  it('rolls back a corrupt child relation without spending its parent intent', () => {
    const file = dbPath();
    const s = store(file);
    const parent = s.createCompletionCallback(edgeInput());
    s.deferCompletionCallbackForChild({
      channelId: parent.channelId,
      targetProfileId: parent.targetProfileId,
      targetTurnId: parent.targetTurnId,
      expectedChildCount: 1,
    });
    expect(() =>
      s.createCompletionCallback(
        edgeInput({
          id: 'chcb:bad-child',
          targetProfileId: 'agent-profile:hermes:default',
          targetRuntimeId: 'runtime:hermes:1',
          targetTurnId: 'turn:bad-child',
          requesterProfileId: 'agent-profile:not-the-parent',
          continuationParentCallbackId: parent.id,
        })
      )
    ).toThrow('continuation parent is invalid');
    expect(s.getCompletionCallback(parent.id)).toMatchObject({
      state: 'pending',
      awaitingChild: true,
      pendingChildIntents: 1,
    });
    expect(s.getCompletionCallback('chcb:bad-child')).toBeNull();
    s.close();

    const reopened = store(file);
    expect(reopened.getCompletionCallback(parent.id)).toMatchObject({
      state: 'pending',
      pendingChildIntents: 1,
    });
  });

  it('prunes only settled callback subtrees after bounded retention', async () => {
    const s = store();
    const settled = s.createCompletionCallback(
      edgeInput({ id: 'chcb:settled' })
    );
    s.satisfyCompletionCallback({
      channelId: settled.channelId,
      targetProfileId: settled.targetProfileId,
      targetTurnId: settled.targetTurnId,
      terminalReason: 'completed',
      messageDisposition: 'no-terminal-message',
    });
    s.claimSatisfiedCompletionCallbacks();
    expect(s.consumeCompletionCallback(settled.id)).toBe(true);

    const parent = s.createCompletionCallback(
      edgeInput({
        id: 'chcb:retained-parent',
        targetTurnId: 'turn:retained-parent',
      })
    );
    s.deferCompletionCallbackForChild({
      channelId: parent.channelId,
      targetProfileId: parent.targetProfileId,
      targetTurnId: parent.targetTurnId,
      expectedChildCount: 1,
    });
    const child = s.createCompletionCallback(
      edgeInput({
        id: 'chcb:retained-child',
        requesterProfileId: parent.targetProfileId,
        targetProfileId: 'agent-profile:hermes:default',
        targetRuntimeId: 'runtime:hermes:1',
        targetTurnId: 'turn:retained-child',
        continuationParentCallbackId: parent.id,
      })
    );
    s.satisfyCompletionCallback({
      channelId: child.channelId,
      targetProfileId: child.targetProfileId,
      targetTurnId: child.targetTurnId,
      terminalReason: 'completed',
      messageDisposition: 'no-terminal-message',
    });
    s.claimSatisfiedCompletionCallbacks();
    expect(s.consumeCompletionCallback(child.id)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(s.pruneConsumedCompletionCallbacks(0)).toBe(1);
    expect(s.getCompletionCallback(settled.id)).toBeNull();
    // The child remains as idempotency and ancestry evidence until it completes
    // its continuation into the still-pending parent.
    expect(s.getCompletionCallback(child.id)).toMatchObject({
      state: 'consumed',
      continuationCompletedAt: null,
    });
    expect(s.getCompletionCallback(parent.id)).toMatchObject({
      state: 'pending',
    });
  });

  it('sweeps callback edges with their orphaned channels', () => {
    const s = store();
    s.createCompletionCallback(edgeInput({ channelId: 'topic:gone' }));
    s.createCompletionCallback(
      edgeInput({
        id: 'chcb:live',
        channelId: 'topic:live',
        targetTurnId: 'turn:live',
      })
    );
    expect(s.sweepOrphans(new Set(['topic:live']))).toMatchObject({
      channelsDeleted: ['topic:gone'],
    });
    expect(s.recoverCompletionCallbacks()).toMatchObject([
      { id: 'chcb:live', channelId: 'topic:live' },
    ]);
  });
});
