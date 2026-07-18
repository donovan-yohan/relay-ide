import { describe, expect, it } from 'vitest';

import {
  buildMentionContextPacket,
  PACKET_MAX_ROWS,
  PACKET_ROW_MAX_CHARS,
  PACKET_MAX_BYTES,
} from '../server/channel-context-packet.js';
import type {
  ChannelMessage,
  ChannelSenderRef,
} from '../shared/channel-chat-protocol.js';

const OPERATOR: ChannelSenderRef = {
  kind: 'human',
  id: 'human:operator',
  displayName: 'operator',
};
const HERMES: ChannelSenderRef = {
  kind: 'agent',
  id: 'agent:hermes',
  providerId: 'hermes',
  displayName: 'hermes',
};
const SYSTEM: ChannelSenderRef = { kind: 'system', id: 'system' };
const CLAUDE: ChannelSenderRef = {
  kind: 'agent',
  id: 'agent:claude',
  providerId: 'claude',
  displayName: 'claude',
};

function msg(
  seq: number,
  sender: ChannelSenderRef,
  text: string,
  kind: 'message' | 'system' = 'message'
): ChannelMessage {
  return {
    schemaVersion: 1,
    id: `chm:row-${seq}`,
    channelId: 'general',
    seq,
    kind,
    status: 'complete',
    sender,
    body: { text, format: 'markdown' },
    threadId: null,
    parentMessageId: null,
    createdAt: 't',
    updatedAt: 't',
  };
}

function inThread(
  message: ChannelMessage,
  rootMessageId: string,
  parentMessageId: string
): ChannelMessage {
  return {
    ...message,
    threadId: rootMessageId,
    parentMessageId,
  };
}

describe('buildMentionContextPacket', () => {
  it('renders the exact golden packet (own rows skipped, sender labels, footer)', () => {
    const rows = [
      msg(1, OPERATOR, 'hey team, the build is red'),
      msg(2, HERMES, 'bisecting now'),
      msg(3, SYSTEM, 'codex is not available in channels yet', 'system'),
      msg(4, CLAUDE, 'i already looked at this'), // OWN row — must be skipped
    ];
    const trigger = msg(
      5,
      OPERATOR,
      '@claude please fix the flaky channel-hub test'
    );
    const packet = buildMentionContextPacket({
      channelTitle: 'general',
      framework: 'claude',
      rows,
      trigger,
      lastDeliveredSeq: 0,
    });
    expect(packet).toBe(
      [
        '[Relay channel #general — you are @claude, one participant in a multi-party chat]',
        'Recent messages, oldest first. Lines are "sender: text"; agents tagged [agent], system rows tagged [system].',
        'operator: hey team, the build is red',
        'hermes [agent]: bisecting now',
        '[system]: codex is not available in channels yet',
        '',
        '[operator [human] mentioned you — reply to this message; your reply is posted to the channel]',
        '@claude please fix the flaky channel-hub test',
      ].join('\n')
    );
  });

  it('renders an exact thread-scoped packet and excludes unrelated channel rows', () => {
    const root = msg(1, OPERATOR, 'root question');
    const reply = inThread(msg(2, HERMES, 'thread detail'), root.id, root.id);
    const system = inThread(
      msg(3, SYSTEM, 'thread system notice', 'system'),
      root.id,
      reply.id
    );
    const streaming = {
      ...inThread(
        msg(4, OPERATOR, 'thread row still streaming'),
        root.id,
        system.id
      ),
      status: 'streaming' as const,
    };
    const unrelated = msg(5, OPERATOR, 'unrelated top-level update');
    const trigger = inThread(
      msg(6, OPERATOR, '@claude answer this thread'),
      root.id,
      streaming.id
    );
    const packet = buildMentionContextPacket({
      channelTitle: 'general',
      framework: 'claude',
      rows: [root, reply, system, streaming, unrelated],
      trigger,
      lastDeliveredSeq: 999,
    });
    expect(packet).toBe(
      [
        '[Relay channel #general — you are @claude, one participant in a multi-party chat]',
        '[Thread scope — only this thread is shown; its root message is always included]',
        'Recent messages, oldest first. Lines are "sender: text"; agents tagged [agent], system rows tagged [system].',
        'operator: root question',
        'hermes [agent]: thread detail',
        '[system]: thread system notice',
        'operator: thread row still streaming',
        '',
        '[operator [human] mentioned you — reply to this message; your reply is posted to the channel]',
        '@claude answer this thread',
      ].join('\n')
    );
  });

  it('keeps an own-agent root but excludes same-framework reply rows', () => {
    const root = { ...msg(1, CLAUDE, 'claude-authored root'), id: 'chm:root' };
    const ownReply = inThread(
      msg(2, CLAUDE, 'already retained by provider context'),
      root.id,
      root.id
    );
    const humanReply = inThread(
      msg(3, OPERATOR, 'new human detail'),
      root.id,
      ownReply.id
    );
    const trigger = inThread(
      msg(4, OPERATOR, '@claude continue'),
      root.id,
      humanReply.id
    );
    const packet = buildMentionContextPacket({
      channelTitle: 'general',
      framework: 'claude',
      rows: [root, ownReply, humanReply],
      trigger,
      lastDeliveredSeq: 999,
    });
    expect(packet).toBe(
      [
        '[Relay channel #general — you are @claude, one participant in a multi-party chat]',
        '[Thread scope — only this thread is shown; its root message is always included]',
        'Recent messages, oldest first. Lines are "sender: text"; agents tagged [agent], system rows tagged [system].',
        'claude [agent]: claude-authored root',
        'operator: new human detail',
        '',
        '[operator [human] mentioned you — reply to this message; your reply is posted to the channel]',
        '@claude continue',
      ].join('\n')
    );
  });

  it('excludes a reply row belonging to a different thread', () => {
    const root = { ...msg(1, OPERATOR, 'target root'), id: 'chm:root' };
    const targetReply = inThread(
      msg(2, OPERATOR, 'target detail'),
      root.id,
      root.id
    );
    const otherReply = inThread(
      msg(3, OPERATOR, 'different-thread detail'),
      'chm:other-root',
      'chm:other-root'
    );
    const trigger = inThread(
      msg(4, OPERATOR, '@claude answer target'),
      root.id,
      targetReply.id
    );
    const packet = buildMentionContextPacket({
      channelTitle: 'general',
      framework: 'claude',
      rows: [root, targetReply, otherReply],
      trigger,
      lastDeliveredSeq: 0,
    });
    expect(packet).toContain('operator: target detail');
    expect(packet).not.toContain('different-thread detail');
  });

  it('keeps an own-agent root despite a high cursor and retains only newest replies', () => {
    const root = { ...msg(1, CLAUDE, 'load-bearing root'), id: 'chm:root' };
    const rows = [root];
    for (let seq = 2; seq <= 25; seq++) {
      rows.push(
        inThread(msg(seq, OPERATOR, `thread line ${seq}`), root.id, root.id)
      );
    }
    const trigger = inThread(
      msg(26, OPERATOR, '@claude continue'),
      root.id,
      rows.at(-1)!.id
    );
    const packet = buildMentionContextPacket({
      channelTitle: 'general',
      framework: 'claude',
      rows,
      trigger,
      lastDeliveredSeq: 999,
    });
    expect(packet).toContain('claude [agent]: load-bearing root');
    expect(packet).toContain('[…earlier messages omitted]');
    expect(packet).not.toContain('operator: thread line 6\n');
    expect(packet).toContain('operator: thread line 7');
    expect(packet).toContain('operator: thread line 25');
    expect(packet.indexOf('claude [agent]: load-bearing root')).toBeLessThan(
      packet.indexOf('[…earlier messages omitted]')
    );
    expect(packet.indexOf('[…earlier messages omitted]')).toBeLessThan(
      packet.indexOf('operator: thread line 7')
    );
    const contextLines = packet
      .split('\n')
      .filter(
        (line) =>
          line.startsWith('operator: thread line') ||
          line === 'claude [agent]: load-bearing root'
      );
    expect(contextLines).toHaveLength(PACKET_MAX_ROWS);
  });

  it('drops oldest thread replies to meet the byte cap but never drops the root', () => {
    const root = { ...msg(1, OPERATOR, 'load-bearing root'), id: 'chm:root' };
    const rows = [root];
    for (let seq = 2; seq <= 20; seq++) {
      rows.push(
        inThread(
          msg(seq, OPERATOR, `${seq}:` + 'z'.repeat(1900)),
          root.id,
          root.id
        )
      );
    }
    const trigger = inThread(
      msg(21, OPERATOR, '@claude continue'),
      root.id,
      rows.at(-1)!.id
    );
    const packet = buildMentionContextPacket({
      channelTitle: 'general',
      framework: 'claude',
      rows,
      trigger,
      lastDeliveredSeq: 0,
    });
    expect(Buffer.byteLength(packet, 'utf8')).toBeLessThanOrEqual(
      PACKET_MAX_BYTES
    );
    expect(packet).toContain('operator: load-bearing root');
    expect(packet).toContain('[…earlier messages omitted]');
    expect(packet).not.toContain('operator: 2:');
    expect(packet).toContain('operator: 20:');
    expect(packet).toContain('@claude continue');
  });

  it('tags an AGENT-authored trigger in the footer (attribution, not impersonation)', () => {
    const trigger = msg(5, HERMES, '@claude take a look at my bisect');
    const packet = buildMentionContextPacket({
      channelTitle: 'general',
      framework: 'claude',
      rows: [],
      trigger,
      lastDeliveredSeq: 4,
    });
    expect(packet).toBe(
      [
        '[Relay channel #general — you are @claude, one participant in a multi-party chat]',
        '',
        '[hermes [agent:hermes] mentioned you — reply to this message; your reply is posted to the channel]',
        '@claude take a look at my bisect',
      ].join('\n')
    );
    // A human mention is unambiguously distinguishable from the agent one above.
    const humanTrigger = msg(6, OPERATOR, '@claude and you look too');
    const humanPacket = buildMentionContextPacket({
      channelTitle: 'general',
      framework: 'claude',
      rows: [],
      trigger: humanTrigger,
      lastDeliveredSeq: 5,
    });
    expect(humanPacket).toContain('[operator [human] mentioned you —');
    expect(humanPacket).not.toContain('[agent:');
  });

  it('caps to the newest N rows and prepends the omitted marker', () => {
    const rows: ChannelMessage[] = [];
    for (let seq = 1; seq <= 25; seq++)
      rows.push(msg(seq, OPERATOR, `line ${seq}`));
    const trigger = msg(26, OPERATOR, '@claude look');
    const packet = buildMentionContextPacket({
      channelTitle: 'c',
      framework: 'claude',
      rows,
      trigger,
      lastDeliveredSeq: 0,
    });
    expect(packet).toContain('[…earlier messages omitted]');
    // Newest 20 kept: rows 6..25 present, rows 1..5 omitted.
    expect(packet).toContain('operator: line 6');
    expect(packet).toContain('operator: line 25');
    expect(packet).not.toContain('operator: line 5\n');
    const contextLines = packet
      .split('\n')
      .filter((l) => l.startsWith('operator: line'));
    expect(contextLines).toHaveLength(PACKET_MAX_ROWS);
  });

  it('truncates an over-long row body with the ellipsis marker', () => {
    const big = 'x'.repeat(PACKET_ROW_MAX_CHARS + 500);
    const rows = [msg(1, OPERATOR, big)];
    const trigger = msg(2, OPERATOR, '@claude go');
    const packet = buildMentionContextPacket({
      channelTitle: 'c',
      framework: 'claude',
      rows,
      trigger,
      lastDeliveredSeq: 0,
    });
    expect(packet).toContain('…[truncated]');
    expect(packet).not.toContain('x'.repeat(PACKET_ROW_MAX_CHARS + 1));
  });

  it('drops oldest context rows to stay under the whole-packet byte budget', () => {
    const rows: ChannelMessage[] = [];
    // Each row ~1.9KB; 20 rows ~38KB > 24KB budget → oldest drop.
    for (let seq = 1; seq <= 20; seq++) {
      rows.push(msg(seq, OPERATOR, `${seq}:` + 'y'.repeat(1900)));
    }
    const trigger = msg(21, OPERATOR, '@claude go');
    const packet = buildMentionContextPacket({
      channelTitle: 'c',
      framework: 'claude',
      rows,
      trigger,
      lastDeliveredSeq: 0,
    });
    expect(Buffer.byteLength(packet, 'utf8')).toBeLessThanOrEqual(
      PACKET_MAX_BYTES
    );
    // The trigger/footer always survives.
    expect(packet).toContain('@claude go');
  });

  it('honors the delivery cursor: only rows after lastDeliveredSeq', () => {
    const rows = [
      msg(1, OPERATOR, 'old one'),
      msg(2, OPERATOR, 'old two'),
      msg(3, OPERATOR, 'interim three'),
    ];
    const trigger = msg(4, OPERATOR, '@claude go');
    const packet = buildMentionContextPacket({
      channelTitle: 'c',
      framework: 'claude',
      rows,
      trigger,
      lastDeliveredSeq: 2,
    });
    expect(packet).not.toContain('old one');
    expect(packet).not.toContain('old two');
    expect(packet).toContain('operator: interim three');
  });

  it('reused session with no interim rows → header + footer only', () => {
    const trigger = msg(10, OPERATOR, '@claude go');
    const packet = buildMentionContextPacket({
      channelTitle: 'general',
      framework: 'claude',
      rows: [],
      trigger,
      lastDeliveredSeq: 9,
    });
    expect(packet).toBe(
      [
        '[Relay channel #general — you are @claude, one participant in a multi-party chat]',
        '',
        '[operator [human] mentioned you — reply to this message; your reply is posted to the channel]',
        '@claude go',
      ].join('\n')
    );
    expect(packet).not.toContain('Recent messages');
  });

  it('indents multi-line row bodies under the sender line', () => {
    const rows = [msg(1, OPERATOR, 'first line\nsecond line')];
    const trigger = msg(2, OPERATOR, '@claude go');
    const packet = buildMentionContextPacket({
      channelTitle: 'c',
      framework: 'claude',
      rows,
      trigger,
      lastDeliveredSeq: 0,
    });
    expect(packet).toContain('operator: first line\n    second line');
  });
});
