import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

// #1181 defect 4: a cleanly-completed bound-agent turn that produces zero
// channel rows is a silent failure and must be warn-logged (log only — never a
// system row). Mock the logger so the warn hook is assertable.
const { warnSpy } = vi.hoisted(() => ({ warnSpy: vi.fn() }));
vi.mock('../server/logger.js', () => ({
  createLogger: () => ({
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: warnSpy,
    error: vi.fn(),
  }),
}));

import { MockProtocolAdapterV2 } from '../server/protocol-adapters/mock-v2-adapter.js';
import type { AgentPatchV2 } from '../shared/agent-chat-protocol-v2.js';
import {
  createChannelMessageStore,
  type ChannelMessageStore,
} from '../server/channel-message-store.js';
import { createChannelHub, type ChannelHub } from '../server/channel-hub.js';
import { bindSessionToChannel } from '../server/channel-agent-bridge.js';

const cleanup: Array<() => void> = [];

afterEach(() => {
  while (cleanup.length > 0) cleanup.pop()?.();
  warnSpy.mockClear();
});

function makeStore(): { store: ChannelMessageStore; hub: ChannelHub } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-zero-row-'));
  cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = createChannelMessageStore(path.join(dir, 'channel-chat.db'));
  cleanup.push(() => store.close());
  const hub = createChannelHub({ store, channelExists: () => true });
  cleanup.push(() => hub.close());
  return { store, hub };
}

function turnCompleted(turnId: string): AgentPatchV2 {
  return {
    type: 'agent-turn-completed-v2',
    sessionId: 's',
    timestamp: 't',
    turnId,
    status: 'completed',
  };
}

describe('channel-agent-bridge zero-row finalization (#1181)', () => {
  it('warn-logs when a completed turn produced no message rows', () => {
    const { store, hub } = makeStore();
    const adapter = new MockProtocolAdapterV2();
    bindSessionToChannel({
      channelId: 'topic:zr',
      agentFramework: 'hermes',
      adapter,
      store,
      hub,
    });
    adapter.broadcastPatch(turnCompleted('turn-empty'));

    // No channel rows, and no system row was posted.
    expect(store.history('topic:zr')).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalledWith(
      'channel bridge turn finalized with no message rows',
      expect.objectContaining({
        channelId: 'topic:zr',
        agentFramework: 'hermes',
        turnId: 'turn-empty',
      })
    );
  });

  it('does NOT warn when the turn produced a row', () => {
    const { store, hub } = makeStore();
    const adapter = new MockProtocolAdapterV2();
    bindSessionToChannel({
      channelId: 'topic:ok',
      agentFramework: 'hermes',
      adapter,
      store,
      hub,
    });
    adapter.broadcastPatch({
      type: 'agent-item-updated-v2',
      sessionId: 's',
      timestamp: 't',
      turnId: 'turn-ok',
      item: { type: 'assistantMessage', id: 'msg-turn-ok', text: 'ok' },
    });
    adapter.broadcastPatch(turnCompleted('turn-ok'));

    expect(store.history('topic:ok')).toHaveLength(1);
    expect(
      warnSpy.mock.calls.some(
        (call) =>
          call[0] === 'channel bridge turn finalized with no message rows'
      )
    ).toBe(false);
  });
});
