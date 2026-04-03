import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createEventAdapter } from '../server/agent-events.js';
import type { AgentEvent, AgentEventType } from '../server/agent-events.js';

function makeEvent(overrides: Partial<AgentEvent> = {}): AgentEvent {
  return {
    type: 'session.started',
    sessionId: 'test-session-1',
    timestamp: new Date().toISOString(),
    source: 'hooks',
    data: {},
    ...overrides,
  };
}

describe('createEventAdapter', () => {
  describe('emit() with type-specific listeners', () => {
    it('delivers events to type-specific listeners', () => {
      const adapter = createEventAdapter();
      const received: AgentEvent[] = [];
      adapter.on('session.started', (e) => received.push(e));
      const event = makeEvent({ type: 'session.started' });
      adapter.emit(event);
      assert.strictEqual(received.length, 1);
      assert.strictEqual(received[0], event);
    });

    it('does not deliver to listeners of other event types', () => {
      const adapter = createEventAdapter();
      const received: AgentEvent[] = [];
      adapter.on('session.ended', (e) => received.push(e));
      adapter.emit(makeEvent({ type: 'session.started' }));
      assert.strictEqual(received.length, 0);
    });

    it('fires multiple listeners on the same event type', () => {
      const adapter = createEventAdapter();
      let count = 0;
      adapter.on('tool.started', () => count++);
      adapter.on('tool.started', () => count++);
      adapter.on('tool.started', () => count++);
      adapter.emit(makeEvent({ type: 'tool.started' }));
      assert.strictEqual(count, 3);
    });
  });

  describe('emit() with wildcard (onAny) listeners', () => {
    it('delivers events to wildcard listeners', () => {
      const adapter = createEventAdapter();
      const received: AgentEvent[] = [];
      adapter.onAny((e) => received.push(e));
      const event = makeEvent({ type: 'prompt.submitted' });
      adapter.emit(event);
      assert.strictEqual(received.length, 1);
      assert.strictEqual(received[0], event);
    });

    it('delivers every event type to wildcard listeners', () => {
      const adapter = createEventAdapter();
      const types: AgentEventType[] = [];
      adapter.onAny((e) => types.push(e.type));

      const eventTypes: AgentEventType[] = [
        'session.started',
        'tool.started',
        'permission.requested',
        'telemetry.updated',
      ];
      for (const type of eventTypes) {
        adapter.emit(makeEvent({ type }));
      }
      assert.deepStrictEqual(types, eventTypes);
    });
  });

  describe('emit() with no listeners', () => {
    it('does not throw when no listeners are registered', () => {
      const adapter = createEventAdapter();
      assert.doesNotThrow(() => {
        adapter.emit(makeEvent({ type: 'state.changed' }));
      });
    });

    it('does not throw after removeAll() is called', () => {
      const adapter = createEventAdapter();
      adapter.on('session.idle', () => {});
      adapter.onAny(() => {});
      adapter.removeAll();
      assert.doesNotThrow(() => {
        adapter.emit(makeEvent({ type: 'session.idle' }));
      });
    });
  });

  describe('on() unsubscribe', () => {
    it('returns an unsubscribe function that stops delivery', () => {
      const adapter = createEventAdapter();
      const received: AgentEvent[] = [];
      const unsub = adapter.on('tool.finished', (e) => received.push(e));

      adapter.emit(makeEvent({ type: 'tool.finished' }));
      assert.strictEqual(received.length, 1);

      unsub();

      adapter.emit(makeEvent({ type: 'tool.finished' }));
      assert.strictEqual(received.length, 1); // still 1, not 2
    });
  });

  describe('onAny() unsubscribe', () => {
    it('returns an unsubscribe function that stops delivery', () => {
      const adapter = createEventAdapter();
      const received: AgentEvent[] = [];
      const unsub = adapter.onAny((e) => received.push(e));

      adapter.emit(makeEvent({ type: 'permission.resolved' }));
      assert.strictEqual(received.length, 1);

      unsub();

      adapter.emit(makeEvent({ type: 'permission.resolved' }));
      assert.strictEqual(received.length, 1); // still 1, not 2
    });
  });

  describe('removeAll()', () => {
    it('clears all type-specific and wildcard listeners', () => {
      const adapter = createEventAdapter();
      let typeCount = 0;
      let anyCount = 0;

      adapter.on('session.ended', () => typeCount++);
      adapter.on('session.started', () => typeCount++);
      adapter.onAny(() => anyCount++);

      adapter.emit(makeEvent({ type: 'session.started' }));
      assert.strictEqual(typeCount, 1);
      assert.strictEqual(anyCount, 1);

      adapter.removeAll();

      adapter.emit(makeEvent({ type: 'session.started' }));
      adapter.emit(makeEvent({ type: 'session.ended' }));
      assert.strictEqual(typeCount, 1); // unchanged
      assert.strictEqual(anyCount, 1); // unchanged
    });
  });

  describe('event shape', () => {
    it('events have the correct shape: type, sessionId, timestamp, source, data', () => {
      const adapter = createEventAdapter();
      let received: AgentEvent | undefined;
      adapter.on('telemetry.updated', (e) => {
        received = e;
      });

      const now = new Date().toISOString();
      const event: AgentEvent = {
        type: 'telemetry.updated',
        sessionId: 'session-abc',
        timestamp: now,
        source: 'parser',
        data: { key: 'value', count: 42 },
      };
      adapter.emit(event);

      assert.ok(received !== undefined);
      assert.strictEqual(received.type, 'telemetry.updated');
      assert.strictEqual(received.sessionId, 'session-abc');
      assert.strictEqual(received.timestamp, now);
      assert.strictEqual(received.source, 'parser');
      assert.deepStrictEqual(received.data, { key: 'value', count: 42 });
    });
  });
});
