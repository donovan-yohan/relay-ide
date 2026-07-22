import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { bindSessionToChannel } from '../server/channel-agent-bridge.js';
import type { ChannelBridgeRetentionSnapshot } from '../server/channel-agent-bridge.js';
import { createChannelHub, type ChannelSocket } from '../server/channel-hub.js';
import { createChannelMessageStore } from '../server/channel-message-store.js';
import {
  formatHealthMemoryLine,
  readHealthMemorySnapshot,
} from '../server/health.js';
import { createLogger } from '../server/logger.js';
import { MockProtocolAdapterV2 } from '../server/protocol-adapters/mock-v2-adapter.js';
import type { ChannelEventV1 } from '../shared/channel-chat-protocol.js';

const logger = createLogger('health');
const channelId = 'topic:memory-load';

function parseTurns(): number {
  const raw = process.argv[2] ?? process.env.RELAY_CHANNEL_LOAD_TURNS ?? '100';
  const turns = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(turns) || turns < 1 || turns > 10_000) {
    throw new Error('turn count must be an integer between 1 and 10000');
  }
  return turns;
}

class SinkSocket implements ChannelSocket {
  readyState = 1;
  bufferedAmount = 0;
  eventCount = 0;
  wireBytes = 0;
  private readonly handlers = new Map<string, () => void>();

  send(data: string): void {
    // Parse to exercise the actual wire shape without retaining event payloads.
    JSON.parse(data) as ChannelEventV1;
    this.eventCount++;
    this.wireBytes += Buffer.byteLength(data, 'utf8');
  }

  close(): void {
    this.readyState = 3;
    this.handlers.get('close')?.();
  }

  on(event: 'close' | 'error', handler: () => void): void {
    this.handlers.set(event, handler);
  }
}

function heapSlope(samples: number[]): number {
  if (samples.length < 2) return 0;
  const meanX = (samples.length - 1) / 2;
  const meanY = samples.reduce((sum, value) => sum + value, 0) / samples.length;
  let numerator = 0;
  let denominator = 0;
  for (let index = 0; index < samples.length; index++) {
    const dx = index - meanX;
    numerator += dx * (samples[index]! - meanY);
    denominator += dx * dx;
  }
  return denominator === 0 ? 0 : numerator / denominator;
}

async function main(): Promise<void> {
  const turns = parseTurns();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-channel-load-'));
  const store = createChannelMessageStore(path.join(dir, 'channel-chat.db'));
  const hub = createChannelHub({ store, channelExists: () => true });
  const adapter = new MockProtocolAdapterV2({ connectMs: 0, stepMs: 0 });
  let socket = new SinkSocket();
  let retention: ChannelBridgeRetentionSnapshot = {
    openStreams: 0,
    openDetailStreams: 0,
    assistantItemIds: 0,
    detailItemIds: 0,
    turnsWithRows: 0,
    retainedTextBytes: 0,
    retainedDetailBytes: 0,
  };
  let durableTranscriptBytes = 0;
  const heapSamples: number[] = [];

  try {
    await adapter.connect({
      cwd: dir,
      port: 0,
      sessionId: 'memory-load-mock',
      hookToken: 'diagnostic-only',
      configDir: dir,
    });
    const unbind = bindSessionToChannel({
      channelId,
      agentFramework: 'mock',
      adapter,
      store,
      hub,
      onRetentionSnapshot: (snapshot) => {
        retention = snapshot;
      },
      onAssistantMessageFinalized: (message) => {
        durableTranscriptBytes += Buffer.byteLength(message.body.text, 'utf8');
      },
    });
    hub.handleConnection(socket, { channelId, sinceSeq: null });

    for (let turn = 1; turn <= turns; turn++) {
      const trigger = store.appendComplete({
        channelId,
        sender: { kind: 'human', id: 'human:load-harness' },
        text: `mock streaming turn ${turn}`,
      });
      durableTranscriptBytes += Buffer.byteLength(trigger.body.text, 'utf8');
      hub.broadcastCreated(trigger);
      await adapter.sendMessage({
        turnId: `load-turn-${turn}`,
        content: trigger.body.text,
      });

      // Periodically reconnect from the previous cursor to exercise durable
      // SQLite catch-up without retaining an application-level event ring.
      if (turn % 10 === 0 && turn < turns) {
        const sinceSeq = Math.max(0, store.latestSeq(channelId) - 4);
        socket.close();
        socket = new SinkSocket();
        hub.handleConnection(socket, { channelId, sinceSeq });
      }

      global.gc?.();
      const snapshot = readHealthMemorySnapshot();
      heapSamples.push(snapshot.heapUsed);
      logger.info(
        `load turn=${turn} ${formatHealthMemoryLine(snapshot)} ` +
          `bridgeRetainedBytes=${retention.retainedTextBytes} ` +
          `durableTranscriptBytes=${durableTranscriptBytes}`
      );
    }

    const slope = heapSlope(heapSamples);
    logger.info(
      `load complete turns=${turns} heapGrowthPerTurn=${Math.round(slope)} ` +
        `bridgeOpenStreams=${retention.openStreams} ` +
        `bridgeItemIds=${retention.assistantItemIds} ` +
        `bridgeTurns=${retention.turnsWithRows} ` +
        `bridgeRetainedBytes=${retention.retainedTextBytes} ` +
        `durableTranscriptBytes=${durableTranscriptBytes} ` +
        `socketEvents=${socket.eventCount} socketWireBytes=${socket.wireBytes}`
    );
    unbind();
  } finally {
    socket.close();
    await adapter.disconnect();
    hub.close();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

await main();
