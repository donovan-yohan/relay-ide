// #759: integration tests for the context-inbox store adapter.
// Exercises the real #758 SQLite store (in-memory) through the #765 router's
// `ContextInboxStore` seam: method renames, throw→result-union remap, the
// `listPackets` filter, and the PULL-as-delivery flip (idempotent, terminal-safe).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createContextPacketStore,
  type ContextPacketStore,
} from '../server/context-packets.js';
import { createContextInboxStoreAdapter } from '../server/features/context-inbox-store-adapter.js';
import type { ContextInboxStore } from '../server/features/context-inbox-router.js';
import type { GlobalSessionId } from '../shared/identity.js';

vi.mock('../server/logger.js', () => ({
  createLogger: () => ({
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

const SESSION_A = 'node-a:sess-1' as GlobalSessionId;
const SESSION_B = 'node-a:sess-2' as GlobalSessionId;

let store: ContextPacketStore;
let adapter: ContextInboxStore;

beforeEach(() => {
  store = createContextPacketStore(':memory:');
  adapter = createContextInboxStoreAdapter(store);
});

afterEach(() => {
  store.close();
});

function seedMessage(target: GlobalSessionId = SESSION_A) {
  const packet = adapter.createPacket({ kind: 'note', note: 'hi', createdBy: 'agent_1' });
  return adapter.createInboxMessage({
    targetSessionId: target,
    contextPacketIds: [packet.id],
    text: 'do the thing',
    createdBy: 'agent_1',
  });
}

describe('context-inbox store adapter — method renames + packet filter', () => {
  it('round-trips createPacket/getPacket/listPackets', () => {
    const created = adapter.createPacket({ kind: 'note', note: 'remember', createdBy: 'agent_1' });
    expect(created.id).toMatch(/^cp:/);
    expect(adapter.getPacket(created.id)?.id).toBe(created.id);
    expect(adapter.listPackets().map((p) => p.id)).toContain(created.id);
  });

  it('listPackets filters by nodeId (denormalized binding) and limit', () => {
    adapter.createPacket({
      kind: 'note',
      note: 'on node-a',
      binding: { nodeId: 'node-a' },
      createdBy: 'agent_1',
    });
    adapter.createPacket({
      kind: 'note',
      note: 'on node-b',
      binding: { nodeId: 'node-b' },
      createdBy: 'agent_1',
    });
    expect(adapter.listPackets({ nodeId: 'node-a' })).toHaveLength(1);
    expect(adapter.listPackets({ nodeId: 'node-a' })[0]?.binding?.nodeId).toBe('node-a');
    expect(adapter.listPackets({ limit: 1 })).toHaveLength(1);
  });
});

describe('context-inbox store adapter — PULL-as-delivery flip', () => {
  it('getInboxMessage flips queued → delivered (read side effect)', () => {
    const msg = seedMessage();
    expect(msg.state).toBe('queued');
    const fetched = adapter.getInboxMessage(msg.id);
    expect(fetched?.state).toBe('delivered');
    expect(fetched?.deliveredAt).toBeTruthy();
    // The store now reflects delivered — the flip persisted, not just decorated.
    expect(store.getInboxMessage(msg.id)?.state).toBe('delivered');
  });

  it('listInboxMessages flips queued → delivered for the target', () => {
    const msg = seedMessage();
    const listed = adapter.listInboxMessages({ targetSessionId: SESSION_A });
    expect(listed).toHaveLength(1);
    expect(listed[0]?.state).toBe('delivered');
    expect(store.getInboxMessage(msg.id)?.state).toBe('delivered');
  });

  it('re-fetching a delivered message is idempotent (no-op, timestamp preserved)', () => {
    const msg = seedMessage();
    const first = adapter.getInboxMessage(msg.id);
    const deliveredAt = first?.deliveredAt;
    const second = adapter.getInboxMessage(msg.id);
    expect(second?.state).toBe('delivered');
    expect(second?.deliveredAt).toBe(deliveredAt);
  });

  it('does NOT flip an acknowledged or terminal message back to delivered', () => {
    const msg = seedMessage();
    adapter.updateInboxState(msg.id, 'acknowledged');
    expect(adapter.getInboxMessage(msg.id)?.state).toBe('acknowledged');
    adapter.updateInboxState(msg.id, 'resolved');
    expect(adapter.getInboxMessage(msg.id)?.state).toBe('resolved');
    // A read of a terminal message leaves it terminal.
    expect(adapter.listInboxMessages({ targetSessionId: SESSION_A })[0]?.state).toBe('resolved');
  });

  it('only flips messages addressed to the fetched target', () => {
    const a = seedMessage(SESSION_A);
    const b = seedMessage(SESSION_B);
    adapter.listInboxMessages({ targetSessionId: SESSION_A });
    expect(store.getInboxMessage(a.id)?.state).toBe('delivered');
    expect(store.getInboxMessage(b.id)?.state).toBe('queued');
  });
});

describe('context-inbox store adapter — throw → result-union remap', () => {
  it('updateInboxState returns { ok: true } on a valid forward transition', () => {
    const msg = seedMessage();
    const result = adapter.updateInboxState(msg.id, 'acknowledged');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.message.state).toBe('acknowledged');
  });

  it('remaps not-found throw to { ok: false, reason: "not_found" }', () => {
    const result = adapter.updateInboxState(
      'im:does-not-exist' as never,
      'acknowledged'
    );
    expect(result).toEqual({ ok: false, reason: 'not_found' });
  });

  it('remaps terminal-state throw to { ok: false, reason: "terminal", currentState }', () => {
    const msg = seedMessage();
    adapter.updateInboxState(msg.id, 'resolved');
    const result = adapter.updateInboxState(msg.id, 'acknowledged');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('terminal');
      if (result.reason === 'terminal') expect(result.currentState).toBe('resolved');
    }
  });

  it('remaps illegal (backward) transition to { ok: false, reason: "invalid_transition" }', () => {
    const msg = seedMessage();
    adapter.updateInboxState(msg.id, 'acknowledged');
    const result = adapter.updateInboxState(msg.id, 'delivered'); // backward
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('invalid_transition');
      if (result.reason === 'invalid_transition') {
        expect(result.currentState).toBe('acknowledged');
      }
    }
  });

  it('treats a same-state re-ack as idempotent success', () => {
    const msg = seedMessage();
    adapter.updateInboxState(msg.id, 'acknowledged');
    const result = adapter.updateInboxState(msg.id, 'acknowledged');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.message.state).toBe('acknowledged');
  });
});
