import { test, expect, beforeEach, afterEach } from 'vitest';
import { OpenCodeTelemetryAdapter } from '../../server/adapters/opencode-telemetry.js';
import { getAdapterForFramework } from '../../server/telemetry-adapter.js';
import type { TelemetryDeps } from '../../server/telemetry-adapter.js';
import { createEventAdapter } from '../../server/agent-events.js';
import type { AgentEventAdapter, AgentEvent } from '../../server/agent-events.js';

let adapter: OpenCodeTelemetryAdapter | null = null;
let eventBus: AgentEventAdapter;
let events: Array<{ type: string; data?: Record<string, unknown> }> = [];

function makeDeps(bus?: AgentEventAdapter): TelemetryDeps {
  return {
    configDir: '/tmp/test',
    getActiveSessions: () => [],
    broadcastEvent: (type, data) => {
      if (data === undefined) events.push({ type });
      else events.push({ type, data });
    },
    eventAdapter: bus,
  };
}

function makeTelemetryEvent(
  sessionId: string,
  data: Record<string, unknown>
): AgentEvent {
  return {
    type: 'telemetry.updated',
    sessionId,
    timestamp: new Date().toISOString(),
    source: 'plugin',
    data,
  };
}

beforeEach(() => {
  events = [];
  eventBus = createEventAdapter();
  adapter = new OpenCodeTelemetryAdapter(makeDeps(eventBus));
});

afterEach(() => {
  if (adapter) {
    adapter.detach('test-session');
    adapter = null;
  }
});

test('registry returns OpenCode adapter for opencode framework', () => {
  const deps = makeDeps(eventBus);
  const registeredAdapter = getAdapterForFramework('opencode', deps);
  expect(registeredAdapter).not.toBeNull();
  expect(registeredAdapter?.framework).toBe('opencode');
});

test('registry returns null for unsupported framework', () => {
  const deps = makeDeps(eventBus);
  const registeredAdapter = getAdapterForFramework('unknown-framework', deps);
  expect(registeredAdapter).toBeNull();
});

test('adapter subscribes to telemetry.updated events on attach', () => {
  adapter!.attach({ id: 'test-session' });

  const event = makeTelemetryEvent('test-session', {
    model: 'gpt-4',
    tokens: { input: 100, output: 50 },
    context: { used_percent: 25 },
    rate_limits: [
      {
        name: 'rpm',
        used_percent: 30,
        resets_at: '2026-04-06T12:00:00Z',
        window_minutes: 1,
      },
    ],
  });

  eventBus.emit(event);

  const snapshot = adapter!.collectSnapshot('test-session');
  expect(snapshot).not.toBeNull();
  expect(snapshot!.model).toBe('gpt-4');
  expect(snapshot!.totalInputTokens).toBe(100);
  expect(snapshot!.totalOutputTokens).toBe(50);
  expect(snapshot!.contextPercent).toBe(25);
});

test('collectSnapshot returns cached data from latest event', () => {
  adapter!.attach({ id: 'test-session' });

  const event1 = makeTelemetryEvent('test-session', {
    model: 'gpt-4',
    tokens: { input: 100 },
  });
  eventBus.emit(event1);

  let snapshot = adapter!.collectSnapshot('test-session');
  expect(snapshot!.model).toBe('gpt-4');
  expect(snapshot!.totalInputTokens).toBe(100);

  const event2 = makeTelemetryEvent('test-session', {
    model: 'gpt-4-turbo',
    tokens: { input: 200 },
  });
  eventBus.emit(event2);

  snapshot = adapter!.collectSnapshot('test-session');
  expect(snapshot!.model).toBe('gpt-4-turbo');
  expect(snapshot!.totalInputTokens).toBe(200);
});

test('collectSnapshot returns null when no telemetry received', () => {
  adapter!.attach({ id: 'test-session' });
  const snapshot = adapter!.collectSnapshot('test-session');
  expect(snapshot).toBeNull();
});

test('ignores events for sessions not attached', () => {
  adapter!.attach({ id: 'session-a' });

  const event = makeTelemetryEvent('session-b', {
    model: 'gpt-4',
    tokens: { input: 100 },
  });
  eventBus.emit(event);

  expect(adapter!.collectSnapshot('session-a')).toBeNull();
  expect(adapter!.collectSnapshot('session-b')).toBeNull();
});

test('caches telemetry per session independently', () => {
  adapter!.attach({ id: 'session-a' });
  adapter!.attach({ id: 'session-b' });

  eventBus.emit(makeTelemetryEvent('session-a', {
    model: 'gpt-4',
    tokens: { input: 100 },
  }));
  eventBus.emit(makeTelemetryEvent('session-b', {
    model: 'claude-3-opus',
    tokens: { input: 200 },
  }));

  const snapshotA = adapter!.collectSnapshot('session-a');
  const snapshotB = adapter!.collectSnapshot('session-b');

  expect(snapshotA!.model).toBe('gpt-4');
  expect(snapshotA!.totalInputTokens).toBe(100);
  expect(snapshotB!.model).toBe('claude-3-opus');
  expect(snapshotB!.totalInputTokens).toBe(200);
});

test('detach clears cache for that session only', () => {
  adapter!.attach({ id: 'session-a' });
  adapter!.attach({ id: 'session-b' });

  eventBus.emit(makeTelemetryEvent('session-a', {
    model: 'gpt-4',
    tokens: { input: 100 },
  }));
  eventBus.emit(makeTelemetryEvent('session-b', {
    model: 'claude-3-opus',
    tokens: { input: 200 },
  }));

  adapter!.detach('session-a');

  expect(adapter!.collectSnapshot('session-a')).toBeNull();
  expect(adapter!.collectSnapshot('session-b')).not.toBeNull();

  // Events for detached session are ignored
  eventBus.emit(makeTelemetryEvent('session-a', {
    model: 'gpt-4-turbo',
    tokens: { input: 300 },
  }));
  expect(adapter!.collectSnapshot('session-a')).toBeNull();
});

test('detach unsubscribes when no sessions remain', () => {
  adapter!.attach({ id: 'test-session' });

  eventBus.emit(makeTelemetryEvent('test-session', {
    model: 'gpt-4',
    tokens: { input: 100 },
  }));

  let snapshot = adapter!.collectSnapshot('test-session');
  expect(snapshot).not.toBeNull();

  adapter!.detach('test-session');

  snapshot = adapter!.collectSnapshot('test-session');
  expect(snapshot).toBeNull();

  // Re-emitting should have no effect (unsubscribed)
  eventBus.emit(makeTelemetryEvent('test-session', {
    model: 'gpt-4-turbo',
    tokens: { input: 200 },
  }));

  snapshot = adapter!.collectSnapshot('test-session');
  expect(snapshot).toBeNull();
});

test('collectAccountTelemetry returns cached account data', () => {
  adapter!.attach({ id: 'test-session' });

  const event = makeTelemetryEvent('test-session', {
    model: 'gpt-4',
    rate_limits: [
      {
        name: 'rpm',
        used_percent: 30,
        resets_at: '2026-04-06T12:00:00Z',
        window_minutes: 1,
      },
      {
        name: 'tpm',
        used_percent: 50,
        resets_at: '2026-04-06T13:00:00Z',
        window_minutes: 60,
      },
    ],
  });
  eventBus.emit(event);

  const account = adapter!.collectAccountTelemetry();
  expect(account).not.toBeNull();
  expect(account!.framework).toBe('opencode');
  expect(account!.rateLimits).toHaveLength(2);
  expect(account!.rateLimits[0]!.name).toBe('rpm');
  expect(account!.rateLimits[0]!.usedPercent).toBe(30);
  expect(account!.rateLimits[1]!.name).toBe('tpm');
  expect(account!.rateLimits[1]!.usedPercent).toBe(50);
});

test('collectAccountTelemetry returns null when no account telemetry received', () => {
  adapter!.attach({ id: 'test-session' });
  const account = adapter!.collectAccountTelemetry();
  expect(account).toBeNull();
});

test('handles array format rate_limits', () => {
  adapter!.attach({ id: 'test-session' });

  const event = makeTelemetryEvent('test-session', {
    rate_limits: [
      {
        name: 'limit1',
        used_percent: 25,
        resets_at: '2026-04-06T12:00:00Z',
        window_minutes: 5,
      },
      { name: 'limit2', used_percent: 75, resets_at: '2026-04-06T13:00:00Z' },
    ],
  });
  eventBus.emit(event);

  const account = adapter!.collectAccountTelemetry();
  expect(account!.rateLimits).toHaveLength(2);
  expect(account!.rateLimits[0]!.windowMinutes).toBe(5);
});

test('handles record/object format rate_limits', () => {
  adapter!.attach({ id: 'test-session' });

  const event = makeTelemetryEvent('test-session', {
    rate_limits: {
      daily: {
        used_percent: 40,
        resets_at: '2026-04-07T00:00:00Z',
        window_minutes: 1440,
      },
      hourly: { used_percent: 20, resets_at: '2026-04-06T11:00:00Z' },
    },
  });
  eventBus.emit(event);

  const account = adapter!.collectAccountTelemetry();
  expect(account!.rateLimits).toHaveLength(2);
  expect(account!.rateLimits.some((r) => r.name === 'daily')).toBe(true);
  expect(account!.rateLimits.some((r) => r.name === 'hourly')).toBe(true);
});

test('handles model as string', () => {
  adapter!.attach({ id: 'test-session' });

  const event = makeTelemetryEvent('test-session', {
    model: 'claude-3-opus',
  });
  eventBus.emit(event);

  const snapshot = adapter!.collectSnapshot('test-session');
  expect(snapshot!.model).toBe('claude-3-opus');
});

test('handles model as object with display_name', () => {
  adapter!.attach({ id: 'test-session' });

  const event = makeTelemetryEvent('test-session', {
    model: { display_name: 'Claude 3 Opus', id: 'claude-3-opus-20240229' },
  });
  eventBus.emit(event);

  const snapshot = adapter!.collectSnapshot('test-session');
  expect(snapshot!.model).toBe('Claude 3 Opus');
});

test('handles model as object with name', () => {
  adapter!.attach({ id: 'test-session' });

  const event = makeTelemetryEvent('test-session', {
    model: { name: 'GPT-4 Turbo', id: 'gpt-4-turbo' },
  });
  eventBus.emit(event);

  const snapshot = adapter!.collectSnapshot('test-session');
  expect(snapshot!.model).toBe('GPT-4 Turbo');
});

test('handles missing or null model', () => {
  adapter!.attach({ id: 'test-session' });

  const event = makeTelemetryEvent('test-session', {
    tokens: { input: 100 },
  });
  eventBus.emit(event);

  const snapshot = adapter!.collectSnapshot('test-session');
  expect(snapshot!.model).toBeNull();
});

test('handles malformed telemetry data gracefully', () => {
  adapter!.attach({ id: 'test-session' });

  const event = makeTelemetryEvent(
    'test-session',
    null as unknown as Record<string, unknown>
  );
  expect(() => {
    eventBus.emit(event);
  }).not.toThrow();

  const snapshot = adapter!.collectSnapshot('test-session');
  expect(snapshot).toBeNull();
});

test('extracts cost from event data', () => {
  adapter!.attach({ id: 'test-session' });

  const event = makeTelemetryEvent('test-session', {
    cost: { total_usd: 1.23 },
  });
  eventBus.emit(event);

  const snapshot = adapter!.collectSnapshot('test-session');
  expect(snapshot!.costUsd).toBe(1.23);
});

test('handles missing cost data', () => {
  adapter!.attach({ id: 'test-session' });

  const event = makeTelemetryEvent('test-session', {});
  eventBus.emit(event);

  const snapshot = adapter!.collectSnapshot('test-session');
  expect(snapshot!.costUsd).toBeNull();
});

test('broadcasts session-telemetry event when telemetry received', () => {
  adapter!.attach({ id: 'test-session' });
  events = [];

  const event = makeTelemetryEvent('test-session', {
    model: 'gpt-4',
    tokens: { input: 100 },
  });
  eventBus.emit(event);

  const sessionTelemetryEvents = events.filter(
    (e) => e.type === 'session-telemetry'
  );
  expect(sessionTelemetryEvents.length).toBe(1);
  expect(sessionTelemetryEvents[0]!.data!.sessionId).toBe('test-session');
});

test('broadcasts account-telemetry event when rate limits received', () => {
  adapter!.attach({ id: 'test-session' });
  events = [];

  const event = makeTelemetryEvent('test-session', {
    rate_limits: [
      { name: 'rpm', used_percent: 30, resets_at: '2026-04-06T12:00:00Z' },
    ],
  });
  eventBus.emit(event);

  const accountTelemetryEvents = events.filter(
    (e) => e.type === 'account-telemetry'
  );
  expect(accountTelemetryEvents.length).toBe(1);
  const accountData = accountTelemetryEvents[0]!.data;
  expect(accountData).toBeDefined();
  expect(
    (accountData as Record<string, { framework: string }>).data.framework
  ).toBe('opencode');
});

test('handles tokens from context when tokens object missing', () => {
  adapter!.attach({ id: 'test-session' });

  const event = makeTelemetryEvent('test-session', {
    context: { total_input: 500, total_output: 200 },
  });
  eventBus.emit(event);

  const snapshot = adapter!.collectSnapshot('test-session');
  expect(snapshot!.totalInputTokens).toBe(500);
  expect(snapshot!.totalOutputTokens).toBe(200);
});

test('handles cache read/write tokens', () => {
  adapter!.attach({ id: 'test-session' });

  const event = makeTelemetryEvent('test-session', {
    tokens: { cache_read: 1000, cache_write: 500 },
  });
  eventBus.emit(event);

  const snapshot = adapter!.collectSnapshot('test-session');
  expect(snapshot!.totalCacheRead).toBe(1000);
  expect(snapshot!.totalCacheWrite).toBe(500);
});

test('handles reasoning tokens', () => {
  adapter!.attach({ id: 'test-session' });

  const event = makeTelemetryEvent('test-session', {
    tokens: { reasoning: 150 },
  });
  eventBus.emit(event);

  const snapshot = adapter!.collectSnapshot('test-session');
  expect(snapshot!.reasoningOutputTokens).toBe(150);
});

test('handles context window size', () => {
  adapter!.attach({ id: 'test-session' });

  const event = makeTelemetryEvent('test-session', {
    context: { window_size: 128000 },
  });
  eventBus.emit(event);

  const snapshot = adapter!.collectSnapshot('test-session');
  expect(snapshot!.contextWindowSize).toBe(128000);
});
