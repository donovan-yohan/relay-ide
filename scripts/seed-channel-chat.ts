#!/usr/bin/env node
/* eslint-disable no-console */
//
// Dev-only channel seeding (#1166). Loads a ChannelMessage fixture into a given
// channel's `channel-chat.db` so the mixed human+agent timeline (grouping,
// sender colors, streaming/interrupted/failed/truncated/system rows, a
// day-boundary crossing, and a reply breadcrumb) can be validated in the real
// UI before #1167 wires any live agent posting. Refuses to run in production.
//
// Usage:
//   node dist/scripts/seed-channel-chat.js \
//     --db <path-to>/channel-chat.db \
//     --channel topic:<id> \
//     [--fixture test/fixtures/channel-chat/mixed-timeline.json]
//
// The channel must already exist as a persisted workspace topic (create it via
// POST /workspace-topics or the DM entry point) so GET /channels/:id resolves.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createChannelMessageStore } from '../server/channel-message-store.js';
import type { ChannelMessage } from '../shared/channel-chat-protocol.js';

function getArg(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function main(): void {
  if (process.env['NODE_ENV'] === 'production') {
    console.error('seed-channel-chat refuses to run with NODE_ENV=production');
    process.exit(1);
  }

  const dbPath = getArg('--db');
  const channelId = getArg('--channel');
  const fixturePath =
    getArg('--fixture') ??
    path.join('test', 'fixtures', 'channel-chat', 'mixed-timeline.json');

  if (!dbPath || !channelId) {
    console.error(
      'usage: seed-channel-chat --db <channel-chat.db> --channel <topic:id> [--fixture <path>]'
    );
    process.exit(1);
  }

  const fixture = JSON.parse(
    readFileSync(fixturePath, 'utf8')
  ) as ChannelMessage[];
  const store = createChannelMessageStore(dbPath);

  // The store assigns fresh ids on insert, so the fixture's literal
  // parentMessageId values are stale — remap fixture id → newly-created id.
  const idMap = new Map<string, string>();
  const resolveParent = (raw: string | null): string | undefined => {
    if (!raw) return undefined;
    return idMap.get(raw) ?? undefined;
  };

  let seeded = 0;
  for (const message of fixture) {
    const sender = message.sender;
    const format = message.body.format;
    const text = message.body.text;
    const parentMessageId = resolveParent(message.parentMessageId);

    if (message.kind === 'system') {
      const created = store.appendComplete({
        channelId,
        kind: 'system',
        sender,
        text,
        format,
      });
      idMap.set(message.id, created.id);
      seeded += 1;
      continue;
    }

    if (message.status === 'streaming') {
      const created = store.beginStream({
        channelId,
        sender,
        source: { sessionId: 'seed-session' },
        text,
        ...(parentMessageId ? { parentMessageId } : {}),
      });
      idMap.set(message.id, created.id);
      seeded += 1;
      continue;
    }

    if (message.status === 'interrupted' || message.status === 'failed') {
      const started = store.beginStream({
        channelId,
        sender,
        source: { sessionId: 'seed-session' },
        text: '',
        ...(parentMessageId ? { parentMessageId } : {}),
      });
      const finalized = store.finalizeStream(started.id, {
        text,
        status: message.status,
        ...(message.truncated ? { truncated: true } : {}),
      });
      idMap.set(message.id, finalized?.id ?? started.id);
      seeded += 1;
      continue;
    }

    const created = store.appendComplete({
      channelId,
      sender,
      text,
      format,
      ...(parentMessageId ? { parentMessageId } : {}),
      ...(message.truncated ? { meta: { truncated: true } } : {}),
    });
    idMap.set(message.id, created.id);
    seeded += 1;
  }

  console.log(`seeded ${seeded} messages into ${channelId} (${dbPath})`);
}

main();
