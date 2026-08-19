/**
 * #1184 live-shape regression: a single Claude assistant reply must persist as
 * exactly one channel row, whether or not the streamed item id and the
 * `assistant` echo message id diverge.
 *
 * Root cause: when `message_start` carries no message id,
 * `streamProviderMessageId` is null so the streamed assistant item is keyed
 * `msg-<turnId>-<index>` (bare), while the echo message carries its own real
 * id and is keyed `msg-<turnId>-<realId>-<index>`. The two ids diverge, the
 * adapter's echo-drop misses, the bridge opens a second stream, and the store's
 * source-triple dedupe (session/turn/item) treats them as different → two rows.
 *
 * The dogfood duplicate pairs shared session + turn + body length but differed
 * only by the final text-item suffix (`-1` from the raw stream index versus
 * `-0` from the assistant echo's text ordinal). This replays that sanitized
 * live shape through the real adapter → bridge → store and asserts one row
 * for both the matching-id and divergent-id shapes.
 */
import { describe, expect, it, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ChildProcess } from 'node:child_process';
import { ClaudeProtocolAdapter } from '../server/protocol-adapters/claude-adapter.js';
import { AdapterProcessRegistry } from '../server/protocol-adapters/adapter-utils.js';
import type { ClaudeSpawnFn } from '../server/claude-stream-client.js';
import type { AdapterConfig } from '../server/protocol-adapter-v2.js';
import {
  createChannelMessageStore,
  type ChannelMessageStore,
} from '../server/channel-message-store.js';
import { createChannelHub } from '../server/channel-hub.js';
import { bindSessionToChannel } from '../server/channel-agent-bridge.js';

interface MockChild extends EventEmitter {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  kill: ReturnType<typeof vi.fn>;
  pid: number;
  serverWrite(obj: unknown): void;
  waitForFrames(count: number): Promise<void>;
}

function makeMockChild(): MockChild {
  const child = new EventEmitter() as MockChild;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.pid = Math.floor(Math.random() * 100000);
  let frames = 0;
  const waiters: Array<{ count: number; resolve: () => void }> = [];
  child.stdin.on('data', (chunk: Buffer) => {
    for (const line of chunk.toString().split('\n')) {
      if (!line.trim()) continue;
      frames++;
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (frames >= waiters[i]!.count) waiters.splice(i, 1)[0]!.resolve();
      }
    }
  });
  child.kill = vi.fn(() => true);
  child.serverWrite = (obj) => child.stdout.push(JSON.stringify(obj) + '\n');
  child.waitForFrames = (count) =>
    new Promise((resolve) => {
      if (frames >= count) return resolve();
      waiters.push({ count, resolve });
    });
  return child;
}

function makeHarness(): { spawnFn: ClaudeSpawnFn; latest: () => MockChild } {
  const spawns: MockChild[] = [];
  const spawnFn: ClaudeSpawnFn = () => {
    const child = makeMockChild();
    spawns.push(child);
    return child as unknown as ChildProcess;
  };
  return { spawnFn, latest: () => spawns[spawns.length - 1]! };
}

function baseConfig(): AdapterConfig {
  return {
    cwd: '/tmp/repo',
    port: 3000,
    sessionId: 'session-1',
    hookToken: 'token',
    configDir: '/tmp/config',
  };
}

function waitFor(pred: () => boolean, timeoutMs = 2000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (pred()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error('timeout'));
      setTimeout(tick, 2);
    };
    tick();
  });
}

async function replayToRows(lines: unknown[]) {
  const harness = makeHarness();
  const adapter = new ClaudeProtocolAdapter(
    harness.spawnFn,
    new AdapterProcessRegistry(1_000_000)
  );
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-claude-dup-'));
  const store: ChannelMessageStore = createChannelMessageStore(
    path.join(dir, 'channel-chat.db')
  );
  const hub = createChannelHub({ store, channelExists: () => true });
  const unbind = bindSessionToChannel({
    channelId: 'topic:general',
    agentFramework: 'claude',
    adapter,
    store,
    hub,
  });
  await adapter.connect(baseConfig());
  await adapter.sendMessage({ turnId: 'turn-replay', content: 'hello' });
  const child = harness.latest();
  await child.waitForFrames(1);
  for (const line of lines) child.serverWrite(line);
  await waitFor(() => store.history('topic:general').length >= 1);
  await new Promise((r) => setTimeout(r, 50));
  const rows = store
    .history('topic:general')
    .filter((m) => m.sender.kind === 'agent' && !m.agentDetail);
  unbind();
  hub.close();
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
  return rows;
}

async function replayToRowCount(lines: unknown[]): Promise<number> {
  return (await replayToRows(lines)).length;
}

describe('claude single reply → one channel row (#1181)', () => {
  it('persists one row for the matching-id fixture', async () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const lines = fs
      .readFileSync(
        path.join(here, 'fixtures', 'claude-stream', 'hello.jsonl'),
        'utf8'
      )
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as unknown);
    expect(await replayToRowCount(lines)).toBe(1);
  });

  it('persists one row when the streamed raw index differs from the echo text ordinal', async () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const lines = fs
      .readFileSync(
        path.join(here, 'fixtures', 'claude-stream', 'text-index-drift.jsonl'),
        'utf8'
      )
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as unknown);
    expect(await replayToRowCount(lines)).toBe(1);
  });

  it('persists one row when message_start carries no id (divergent stream/echo ids)', async () => {
    const sid = '00000000-0000-4000-8000-000000000001';
    const lines: unknown[] = [
      { type: 'system', subtype: 'init', session_id: sid, uuid: 'u-init' },
      {
        type: 'stream_event',
        event: {
          type: 'message_start',
          message: { id: '', type: 'message', role: 'assistant', content: [] },
        },
        session_id: sid,
        uuid: 'u1',
      },
      {
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' },
        },
        session_id: sid,
        uuid: 'u2',
      },
      {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'ok' },
        },
        session_id: sid,
        uuid: 'u3',
      },
      {
        // Echo carries its own real message id — diverges from the bare streamed id.
        type: 'assistant',
        message: {
          id: 'msg_real_001',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'ok' }],
        },
        session_id: sid,
        uuid: 'u4',
      },
      {
        type: 'stream_event',
        event: { type: 'content_block_stop', index: 0 },
        session_id: sid,
        uuid: 'u5',
      },
      {
        type: 'stream_event',
        event: { type: 'message_stop' },
        session_id: sid,
        uuid: 'u6',
      },
      {
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'ok',
        session_id: sid,
        uuid: 'u7',
      },
    ];
    expect(await replayToRowCount(lines)).toBe(1);
  });

  it('persists two rows for two blank-id assistant messages in one turn', async () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const lines = fs
      .readFileSync(
        path.join(
          here,
          'fixtures',
          'claude-stream',
          'two-blank-message-ids.jsonl'
        ),
        'utf8'
      )
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as unknown);

    const rows = await replayToRows(lines);
    expect(rows.map((row) => row.body.text)).toEqual([
      'synthetic first',
      'synthetic second',
    ]);
    expect(new Set(rows.map((row) => row.source?.itemId)).size).toBe(2);
    expect(new Set(rows.map((row) => row.source?.turnId)).size).toBe(1);
  });
});
