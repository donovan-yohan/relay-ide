import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  buildMentionContextPacket,
  buildMentionContextPacketEnvelope,
  CLAUDE_PACKET_IMAGE_MAX_RAW_BYTES,
  PACKET_FRAMEWORK_IMAGE_SUPPORT,
  PACKET_IMAGE_MAX_COUNT,
  PACKET_MAX_ROWS,
  PACKET_ROW_MAX_CHARS,
  PACKET_MAX_BYTES,
  resolveMentionContextPacket,
} from '../server/channel-context-packet.js';
import type { ChannelAttachmentStore } from '../server/channel-attachments.js';
import type {
  ChannelAttachmentId,
  ChannelImagePart,
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

/** A row in the shape `deleteMessage` leaves behind: body wiped, stamp set. */
function deletedRow(message: ChannelMessage): ChannelMessage {
  return {
    ...message,
    body: { ...message.body, text: '' },
    meta: { ...message.meta, deletedAt: '2026-08-03T02:00:00.000Z' },
  };
}

function imagePart(id: string): ChannelImagePart {
  return {
    type: 'image',
    id: id as ChannelAttachmentId,
    mime: 'image/png',
    w: 1,
    h: 1,
    bytes: 8,
  };
}

describe('buildMentionContextPacket', () => {
  it('carries image refs only for the exact retained rows and trigger', () => {
    const rows = Array.from({ length: PACKET_MAX_ROWS + 2 }, (_, index) => {
      const seq = index + 1;
      return {
        ...msg(seq, OPERATOR, `row ${seq}`),
        parts: [imagePart(`cha:row-${seq}`)],
      };
    });
    const trigger = {
      ...msg(PACKET_MAX_ROWS + 3, OPERATOR, '@claude inspect'),
      parts: [imagePart('cha:trigger')],
    };

    const packet = buildMentionContextPacketEnvelope({
      channelTitle: 'general',
      framework: 'claude',
      rows,
      trigger,
      lastDeliveredSeq: 0,
    });

    expect(packet.retainedMessageIds).toEqual([
      ...rows.slice(-PACKET_MAX_ROWS).map((row) => row.id),
      trigger.id,
    ]);
    expect(packet.images.map((image) => image.part.id)).toEqual([
      'cha:trigger',
      ...rows
        .slice(-PACKET_MAX_ROWS)
        .reverse()
        .map((row) => row.parts[0]!.id),
    ]);
  });

  it('resolves local payloads and states missing ones in packet text', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'channel-packet-image-'));
    const payloadPath = path.join(dir, 'present.png');
    fs.writeFileSync(payloadPath, Buffer.from('fixture'));
    const present = imagePart('cha:present');
    const missing = { ...imagePart('cha:missing'), alt: 'missing diagram' };
    const store = {
      get: (id: string) =>
        id === present.id
          ? {
              part: present,
              sha256: 'present',
              payloadPath,
              createdAt: 't',
            }
          : null,
    } as ChannelAttachmentStore;

    try {
      const resolved = resolveMentionContextPacket(
        {
          content: 'packet',
          framework: 'hermes',
          retainedMessageIds: ['chm:trigger'],
          images: [present, missing].map((part) => ({
            part,
            messageId: 'chm:trigger',
            trigger: true,
          })),
        },
        store
      );
      expect(resolved.attachments).toEqual([
        { type: 'image', path: payloadPath, mimeType: 'image/png' },
      ]);
      expect(resolved.content).toBe(
        'packet\n\n[Relay image attachment unavailable: missing diagram]'
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('states framework degradation instead of silently dropping OpenCode images', () => {
    const part = {
      ...imagePart('cha:opencode-image'),
      alt: 'architecture diagram',
      w: 640,
      h: 480,
    };
    let storeReads = 0;
    const resolved = resolveMentionContextPacket(
      {
        content: 'packet',
        framework: 'opencode',
        retainedMessageIds: ['chm:trigger'],
        images: [{ part, messageId: 'chm:trigger', trigger: true }],
      },
      {
        get: () => {
          storeReads += 1;
          return null;
        },
      } as ChannelAttachmentStore
    );

    expect(PACKET_FRAMEWORK_IMAGE_SUPPORT.opencode).toBe(false);
    expect(PACKET_FRAMEWORK_IMAGE_SUPPORT.mock).toBe(true);
    expect(storeReads).toBe(0);
    expect(resolved.attachments).toEqual([]);
    expect(resolved.content).toBe(
      'packet\n\n[image attachment not deliverable to opencode: architecture diagram, 640x480]'
    );
  });

  it('dedupes a chained attachment id in packet priority order', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'packet-image-dedupe-'));
    const payloadPath = path.join(dir, 'shared.png');
    fs.writeFileSync(payloadPath, Buffer.from('fixture'));
    const triggerPart = {
      ...imagePart('cha:shared'),
      alt: 'trigger copy',
    };
    const contextPart = {
      ...imagePart('cha:shared'),
      alt: 'context copy',
    };
    let storeReads = 0;
    const store = {
      get: () => {
        storeReads += 1;
        return {
          part: triggerPart,
          sha256: 'shared',
          payloadPath,
          createdAt: 't',
        };
      },
    } as ChannelAttachmentStore;

    try {
      const resolved = resolveMentionContextPacket(
        {
          content: 'packet',
          framework: 'claude',
          retainedMessageIds: ['chm:context', 'chm:trigger'],
          images: [
            {
              part: triggerPart,
              messageId: 'chm:trigger',
              trigger: true,
            },
            {
              part: contextPart,
              messageId: 'chm:context',
              trigger: false,
            },
          ],
        },
        store
      );
      expect(storeReads).toBe(1);
      expect(resolved.attachments).toEqual([
        { type: 'image', path: payloadPath, mimeType: 'image/png' },
      ]);
      expect(resolved.content).toBe('packet');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('delivers at most four Hermes images, trigger first then newest context', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'packet-hermes-cap-'));
    const triggerParts = [
      imagePart('cha:trigger-1'),
      imagePart('cha:trigger-2'),
    ];
    const rows = Array.from({ length: 4 }, (_, index) => ({
      ...msg(index + 1, OPERATOR, `context ${index + 1}`),
      parts: [imagePart(`cha:context-${index + 1}`)],
    }));
    const trigger = {
      ...msg(5, OPERATOR, '@hermes inspect'),
      parts: triggerParts,
    };
    const allParts = [...triggerParts, ...rows.flatMap((row) => row.parts)];
    const records = new Map(
      allParts.map((part) => {
        const payloadPath = path.join(dir, `${part.id.slice(4)}.png`);
        fs.writeFileSync(payloadPath, Buffer.from('x'));
        return [
          part.id,
          { part, sha256: part.id, payloadPath, createdAt: 't' },
        ] as const;
      })
    );
    const store = {
      get: (id: string) => records.get(id as ChannelAttachmentId) ?? null,
    } as ChannelAttachmentStore;

    try {
      const resolved = resolveMentionContextPacket(
        buildMentionContextPacketEnvelope({
          channelTitle: 'general',
          framework: 'hermes',
          rows,
          trigger,
          lastDeliveredSeq: 0,
        }),
        store
      );
      expect(resolved.attachments).toHaveLength(PACKET_IMAGE_MAX_COUNT);
      expect(
        resolved.attachments.map((item) => path.basename(item.path))
      ).toEqual([
        'trigger-1.png',
        'trigger-2.png',
        'context-4.png',
        'context-3.png',
      ]);
      expect(resolved.content).toContain(
        '[Relay image attachment omitted: cha:context-2 (packet image count limit)]'
      );
      expect(resolved.content).toContain(
        '[Relay image attachment omitted: cha:context-1 (packet image count limit)]'
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps Claude raw images below the conservative JSONL/base64 budget', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'packet-claude-cap-'));
    const triggerOne = {
      ...imagePart('cha:trigger-large'),
      bytes: 4 * 1024 * 1024,
    };
    const triggerTwo = {
      ...imagePart('cha:trigger-overflow'),
      bytes: 3 * 1024 * 1024,
    };
    const context = {
      ...imagePart('cha:context-fits'),
      bytes: 2 * 1024 * 1024,
    };
    const parts = [triggerOne, triggerTwo, context];
    const records = new Map(
      parts.map((part) => {
        const payloadPath = path.join(dir, `${part.id.slice(4)}.png`);
        fs.writeFileSync(payloadPath, Buffer.from('x'));
        return [
          part.id,
          { part, sha256: part.id, payloadPath, createdAt: 't' },
        ] as const;
      })
    );
    const store = {
      get: (id: string) => records.get(id as ChannelAttachmentId) ?? null,
    } as ChannelAttachmentStore;
    const row = { ...msg(1, OPERATOR, 'context'), parts: [context] };
    const trigger = {
      ...msg(2, OPERATOR, '@claude inspect'),
      parts: [triggerOne, triggerTwo],
    };

    try {
      const resolved = resolveMentionContextPacket(
        buildMentionContextPacketEnvelope({
          channelTitle: 'general',
          framework: 'claude',
          rows: [row],
          trigger,
          lastDeliveredSeq: 0,
        }),
        store
      );
      expect(CLAUDE_PACKET_IMAGE_MAX_RAW_BYTES).toBe(6 * 1024 * 1024);
      expect(
        resolved.attachments.map((item) => path.basename(item.path))
      ).toEqual(['trigger-large.png', 'context-fits.png']);
      expect(resolved.content).toContain(
        '[Relay image attachment omitted: cha:trigger-overflow (packet image byte limit)]'
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('filters blank activity/detail/system rows before they consume the text window', () => {
    const detail = {
      ...msg(2, HERMES, ''),
      agentDetail: {
        itemId: 'reasoning-1',
        card: {
          kind: 'thought' as const,
          title: 'Reasoning summary',
          status: 'complete' as const,
          content: 'provider-visible reasoning',
        },
      },
    };
    const rows = [
      msg(1, OPERATOR, 'real question'),
      detail,
      msg(3, SYSTEM, 'collab:wait', 'system'),
      msg(4, HERMES, '   '),
      msg(5, HERMES, 'real agent prose'),
    ];
    const packet = buildMentionContextPacket({
      channelTitle: 'general',
      framework: 'claude',
      rows,
      trigger: msg(6, OPERATOR, '@claude continue'),
      lastDeliveredSeq: 0,
    });

    expect(packet).toContain(
      '5 messages since your last turn (2 shown, 3 activity rows filtered).'
    );
    expect(packet).toContain('operator: real question');
    expect(packet).toContain('hermes [agent]: real agent prose');
    expect(packet).not.toContain('provider-visible reasoning');
    expect(packet).not.toContain('collab:wait');
    expect(packet).not.toContain('hermes [agent]:    ');
  });

  it('labels bounded candidate counts as lower bounds', () => {
    const packet = buildMentionContextPacket({
      channelTitle: 'general',
      framework: 'claude',
      rows: [
        msg(3, OPERATOR, 'recent prose'),
        msg(4, SYSTEM, 'activity', 'system'),
      ],
      trigger: msg(5, OPERATOR, '@claude continue'),
      lastDeliveredSeq: 0,
      summary: {
        totalCount: 2,
        activityFilteredCount: 1,
        candidateScanBudget: 3,
        candidateScanTruncated: true,
        scope: 'channel',
      },
    });

    expect(packet).toContain(
      'At least 2 messages since your last turn (1 shown; activity rows filtered: at least 1; newest 3 raw candidates scanned).'
    );
    expect(packet).toContain('[…earlier messages omitted]');
  });

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
        '3 messages since your last turn (2 shown, 1 activity rows filtered).',
        'Recent text messages, oldest first. Lines are "sender: text"; agents tagged [agent].',
        'operator: hey team, the build is red',
        'hermes [agent]: bisecting now',
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
        '4 prior thread rows (3 shown, 1 activity rows filtered).',
        '[Thread scope — only this thread is shown; its root message is always included]',
        'Recent text messages, oldest first. Lines are "sender: text"; agents tagged [agent].',
        'operator: root question',
        'hermes [agent]: thread detail',
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
        '2 prior thread rows (2 shown, 0 activity rows filtered).',
        '[Thread scope — only this thread is shown; its root message is always included]',
        'Recent text messages, oldest first. Lines are "sender: text"; agents tagged [agent].',
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
    expect(packet).not.toContain('operator: thread line 10\n');
    expect(packet).toContain('operator: thread line 11');
    expect(packet).toContain('operator: thread line 25');
    expect(packet.indexOf('claude [agent]: load-bearing root')).toBeLessThan(
      packet.indexOf('[…earlier messages omitted]')
    );
    expect(packet.indexOf('[…earlier messages omitted]')).toBeLessThan(
      packet.indexOf('operator: thread line 11')
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
        '0 messages since your last turn (0 shown, 0 activity rows filtered).',
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
    // Newest PACKET_MAX_ROWS kept: rows 10..25 present, rows 1..9 omitted.
    expect(packet).toContain('operator: line 10');
    expect(packet).toContain('operator: line 25');
    expect(packet).not.toContain('operator: line 9\n');
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
        '0 messages since your last turn (0 shown, 0 activity rows filtered).',
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

  // #1308 slice 1 item 4. A deleted row survives as a tombstone in the store, so
  // it reaches the builder like any other row — and must never be rendered as an
  // empty message the agent tries to interpret.
  it('drops deleted rows from the context window entirely', () => {
    const rows = [
      msg(1, OPERATOR, 'keep this'),
      deletedRow(msg(2, OPERATOR, '')),
      msg(3, OPERATOR, 'keep this too'),
    ];
    const trigger = msg(4, OPERATOR, '@claude go');
    const envelope = buildMentionContextPacketEnvelope({
      channelTitle: 'general',
      framework: 'claude',
      rows,
      trigger,
      lastDeliveredSeq: 0,
    });
    expect(envelope.retainedMessageIds).toEqual([
      'chm:row-1',
      'chm:row-3',
      trigger.id,
    ]);
    expect(envelope.content).toContain('operator: keep this');
    expect(envelope.content).not.toContain('[message deleted]');
    // No blank `operator:` line where the deleted row used to be.
    expect(envelope.content).not.toMatch(/operator: *\n/);
  });

  it('never carries a deleted row’s attachments', () => {
    const rows = [
      {
        ...deletedRow(msg(1, OPERATOR, '')),
        parts: [imagePart('cha:erased')],
      },
    ];
    const trigger = msg(2, OPERATOR, '@claude go');
    const envelope = buildMentionContextPacketEnvelope({
      channelTitle: 'general',
      framework: 'claude',
      rows,
      trigger,
      lastDeliveredSeq: 0,
    });
    expect(envelope.images).toEqual([]);
    expect(envelope.retainedMessageIds).toEqual([trigger.id]);
  });

  it('keeps a deleted thread root as a marked anchor instead of dropping it', () => {
    // The root is structural — a thread packet without it is not buildable — so
    // it is the one deleted row that stays, standing in as a marker rather than
    // as a blank line.
    const root = deletedRow(msg(1, OPERATOR, ''));
    const rows = [
      root,
      inThread(msg(2, OPERATOR, 'reply one'), root.id, root.id),
    ];
    const trigger = inThread(
      msg(3, OPERATOR, '@claude go'),
      root.id,
      'chm:row-2'
    );
    const packet = buildMentionContextPacket({
      channelTitle: 'general',
      framework: 'claude',
      rows,
      trigger,
      lastDeliveredSeq: 0,
    });
    expect(packet).toContain(
      '2 prior thread rows (2 shown, 0 activity rows filtered).'
    );
    expect(packet).toContain('operator: [message deleted]');
    expect(packet).toContain('operator: reply one');
    expect(packet).not.toContain('[…earlier messages omitted]');
  });
});
