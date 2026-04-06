import { test, expect, beforeEach, afterEach } from 'vitest';
import { OpenCodeTelemetryAdapter } from '../../server/adapters/opencode-telemetry.js';
import { getAdapterForFramework } from '../../server/telemetry-adapter.js';
import type { TelemetryDeps } from '../../server/telemetry-adapter.js';
import type { AgentEvent } from '../../server/agent-events.js';

let adapter: OpenCodeTelemetryAdapter | null = null;
let events: Array<{ type: string; data?: Record<string, unknown> }> = [];

function makeDeps(): TelemetryDeps {
  return {
    configDir: '/tmp/test',
    getActiveSessions: () => [],
    broadcastEvent: (type, data) => {
      if (data === undefined) events.push({ type });
      else events.push({ type, data });
    },
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

function emitEvent(
  adapterInstance: OpenCodeTelemetryAdapter,
  event: AgentEvent
): void {
  (
    adapterInstance as unknown as {
      eventAdapter: { emit: (e: AgentEvent) => void };
    }
  ).eventAdapter.emit(event);
}

beforeEach(() => {
  events = [];
  adapter = new OpenCodeTelemetryAdapter(makeDeps());
});

afterEach(() => {
  if (adapter) {
    adapter.detach('test-session');
    adapter = null;
  }
});

test('registry returns OpenCode adapter for opencode framework', () => {
  const deps = makeDeps();
  const registeredAdapter = getAdapterForFramework('opencode', deps);
  expect(registeredAdapter).not.toBeNull();
  expect(registeredAdapter?.framework).toBe('opencode');
});

test('registry returns null for unsupported framework', () => {
  const deps = makeDeps();
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

  emitEvent(adapter!, event);

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
  emitEvent(adapter!, event1);

  let snapshot = adapter!.collectSnapshot('test-session');
  expect(snapshot!.model).toBe('gpt-4');
  expect(snapshot!.totalInputTokens).toBe(100);

  const event2 = makeTelemetryEvent('test-session', {
    model: 'gpt-4-turbo',
    tokens: { input: 200 },
  });
  emitEvent(adapter!, event2);

  snapshot = adapter!.collectSnapshot('test-session');
  expect(snapshot!.model).toBe('gpt-4-turbo');
  expect(snapshot!.totalInputTokens).toBe(200);
});

test('collectSnapshot returns null when no telemetry received', () => {
  adapter!.attach({ id: 'test-session' });
  const snapshot = adapter!.collectSnapshot('test-session');
  expect(snapshot).toBeNull();
});

test('detach clears cache and unsubscribes from events', () => {
  adapter!.attach({ id: 'test-session' });

  const event = makeTelemetryEvent('test-session', {
    model: 'gpt-4',
    tokens: { input: 100 },
  });
  emitEvent(adapter!, event);

  let snapshot = adapter!.collectSnapshot('test-session');
  expect(snapshot).not.toBeNull();

  adapter!.detach('test-session');

  snapshot = adapter!.collectSnapshot('test-session');
  expect(snapshot).toBeNull();

  const event2 = makeTelemetryEvent('test-session', {
    model: 'gpt-4-turbo',
    tokens: { input: 200 },
  });
  emitEvent(adapter!, event2);

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
  emitEvent(adapter!, event);

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
  emitEvent(adapter!, event);

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
  emitEvent(adapter!, event);

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
  emitEvent(adapter!, event);

  const snapshot = adapter!.collectSnapshot('test-session');
  expect(snapshot!.model).toBe('claude-3-opus');
});

test('handles model as object with display_name', () => {
  adapter!.attach({ id: 'test-session' });

  const event = makeTelemetryEvent('test-session', {
    model: { display_name: 'Claude 3 Opus', id: 'claude-3-opus-20240229' },
  });
  emitEvent(adapter!, event);

  const snapshot = adapter!.collectSnapshot('test-session');
  expect(snapshot!.model).toBe('Claude 3 Opus');
});

test('handles model as object with name', () => {
  adapter!.attach({ id: 'test-session' });

  const event = makeTelemetryEvent('test-session', {
    model: { name: 'GPT-4 Turbo', id: 'gpt-4-turbo' },
  });
  emitEvent(adapter!, event);

  const snapshot = adapter!.collectSnapshot('test-session');
  expect(snapshot!.model).toBe('GPT-4 Turbo');
});

test('handles missing or null model', () => {
  adapter!.attach({ id: 'test-session' });

  const event = makeTelemetryEvent('test-session', {
    tokens: { input: 100 },
  });
  emitEvent(adapter!, event);

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
    emitEvent(adapter!, event);
  }).not.toThrow();

  const snapshot = adapter!.collectSnapshot('test-session');
  expect(snapshot).toBeNull();
});

test('extracts cost from event data', () => {
  adapter!.attach({ id: 'test-session' });

  const event = makeTelemetryEvent('test-session', {
    cost: { total_usd: 1.23 },
  });
  emitEvent(adapter!, event);

  const snapshot = adapter!.collectSnapshot('test-session');
  expect(snapshot!.costUsd).toBe(1.23);
});

test('handles missing cost data', () => {
  adapter!.attach({ id: 'test-session' });

  const event = makeTelemetryEvent('test-session', {});
  emitEvent(adapter!, event);

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
  emitEvent(adapter!, event);

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
  emitEvent(adapter!, event);

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
  emitEvent(adapter!, event);

  const snapshot = adapter!.collectSnapshot('test-session');
  expect(snapshot!.totalInputTokens).toBe(500);
  expect(snapshot!.totalOutputTokens).toBe(200);
});

test('handles cache read/write tokens', () => {
  adapter!.attach({ id: 'test-session' });

  const event = makeTelemetryEvent('test-session', {
    tokens: { cache_read: 1000, cache_write: 500 },
  });
  emitEvent(adapter!, event);

  const snapshot = adapter!.collectSnapshot('test-session');
  expect(snapshot!.totalCacheRead).toBe(1000);
  expect(snapshot!.totalCacheWrite).toBe(500);
});

test('handles reasoning tokens', () => {
  adapter!.attach({ id: 'test-session' });

  const event = makeTelemetryEvent('test-session', {
    tokens: { reasoning: 150 },
  });
  emitEvent(adapter!, event);

  const snapshot = adapter!.collectSnapshot('test-session');
  expect(snapshot!.reasoningOutputTokens).toBe(150);
});

test('handles context window size', () => {
  adapter!.attach({ id: 'test-session' });

  const event = makeTelemetryEvent('test-session', {
    context: { window_size: 128000 },
  });
  emitEvent(adapter!, event);

  const snapshot = adapter!.collectSnapshot('test-session');
  expect(snapshot!.contextWindowSize).toBe(128000);
});
