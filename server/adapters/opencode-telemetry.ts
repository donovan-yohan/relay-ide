import type {
  AccountTelemetry,
  RateLimitWindow,
  TelemetryData,
} from '../types.js';
import type {
  TelemetryAdapter,
  TelemetryDeps,
  TelemetrySession,
} from '../telemetry-adapter.js';
import { registerTelemetryAdapter } from '../telemetry-adapter.js';
import { createLogger } from '../logger.js';
import { createEventAdapter } from '../agent-events.js';
import type { AgentEventAdapter, AgentEvent } from '../agent-events.js';

const logger = createLogger('telemetry:opencode');

// Incoming telemetry structure from OpenCode events
interface OpenCodeTelemetryPayload {
  sessionId?: string;
  model?: string | { display_name?: string; name?: string };
  tokens?: {
    input?: number;
    output?: number;
    cache_read?: number;
    cache_write?: number;
    reasoning?: number;
  };
  context?: {
    used_percent?: number;
    window_size?: number;
    total_input?: number;
    total_output?: number;
  };
  cost?: {
    total_usd?: number;
  };
  rate_limits?:
    | Array<{
        name?: string;
        used_percent?: number;
        resets_at?: string;
        window_minutes?: number;
      }>
    | Record<string, unknown>;
  source?: 'statusLine' | 'jsonl';
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function extractModelName(model: unknown): string | null {
  if (typeof model === 'string') return model;
  if (model && typeof model === 'object') {
    const m = model as Record<string, unknown>;
    return typeof m.display_name === 'string'
      ? m.display_name
      : typeof m.name === 'string'
        ? m.name
        : null;
  }
  return null;
}

function buildRateLimitWindow(
  name: string,
  usedPercent: number,
  resetsAt: string,
  windowMinutesRaw: number | undefined
): RateLimitWindow {
  const window: RateLimitWindow = {
    name,
    usedPercent,
    resetsAt,
  };
  if (windowMinutesRaw !== undefined && windowMinutesRaw > 0) {
    Object.assign(window, { windowMinutes: windowMinutesRaw });
  }
  return window;
}

function extractRateLimits(payload: unknown): RateLimitWindow[] | null {
  if (!payload || typeof payload !== 'object') return null;

  const data = payload as Record<string, unknown>;
  const rateLimitsRaw = data.rate_limits;

  if (!rateLimitsRaw) return null;

  if (Array.isArray(rateLimitsRaw)) {
    const windows: RateLimitWindow[] = [];
    for (const rl of rateLimitsRaw) {
      if (rl && typeof rl === 'object') {
        const r = rl as Record<string, unknown>;
        const name = asString(r.name, '');
        if (!name) continue;
        windows.push(
          buildRateLimitWindow(
            name,
            asNumber(r.used_percent, -1),
            asString(r.resets_at),
            asNumber(r.window_minutes, 0) || undefined
          )
        );
      }
    }
    return windows.length > 0 ? windows : null;
  }

  if (typeof rateLimitsRaw === 'object') {
    const windows: RateLimitWindow[] = [];
    const rl = rateLimitsRaw as Record<string, unknown>;
    for (const [key, value] of Object.entries(rl)) {
      if (value && typeof value === 'object') {
        const v = value as Record<string, unknown>;
        windows.push(
          buildRateLimitWindow(
            key,
            asNumber(v.used_percent ?? v.usedPercentage, -1),
            asString(v.resets_at ?? v.resetsAt),
            asNumber(v.window_minutes ?? v.windowMinutes, 0) || undefined
          )
        );
      }
    }
    return windows.length > 0 ? windows : null;
  }

  return null;
}

function extractTelemetry(
  sessionId: string,
  payload: unknown
): {
  session: Omit<TelemetryData, 'updatedAt'>;
  account: Omit<AccountTelemetry, 'framework' | 'updatedAt'> | null;
} | null {
  if (!payload || typeof payload !== 'object') return null;

  const data = payload as OpenCodeTelemetryPayload;
  const tokens = data.tokens ?? {};
  const context = data.context ?? {};
  const cost = data.cost ?? {};

  const session: Omit<TelemetryData, 'updatedAt'> = {
    sessionId,
    model: extractModelName(data.model),
    totalInputTokens: asNumber(tokens.input ?? context.total_input, 0),
    totalOutputTokens: asNumber(tokens.output ?? context.total_output, 0),
    totalCacheRead: asNumber(tokens.cache_read, 0),
    totalCacheWrite: asNumber(tokens.cache_write, 0),
    reasoningOutputTokens: asNumber(tokens.reasoning, 0),
    contextPercent: asNumber(context.used_percent, -1),
    contextWindowSize: asNumber(context.window_size, 0),
    costUsd: typeof cost.total_usd === 'number' ? cost.total_usd : null,
    source: data.source ?? 'jsonl',
  };

  const rateLimits = extractRateLimits(payload);
  const account = rateLimits ? { rateLimits } : null;

  return { session, account };
}

export class OpenCodeTelemetryAdapter implements TelemetryAdapter {
  readonly framework = 'opencode';

  private deps: TelemetryDeps;
  private eventAdapter: AgentEventAdapter;
  private unsubscribe: (() => void) | null = null;
  // Cached telemetry from latest event
  private cachedTelemetry: Omit<TelemetryData, 'updatedAt'> | null = null;
  // Cached account telemetry from latest event
  private cachedAccount: Omit<
    AccountTelemetry,
    'framework' | 'updatedAt'
  > | null = null;

  constructor(deps: TelemetryDeps) {
    this.deps = deps;
    this.eventAdapter = createEventAdapter();
  }

  attach(_session: TelemetrySession): void {
    // Subscribe to telemetry.updated events from the event bus
    this.unsubscribe = this.eventAdapter.on(
      'telemetry.updated',
      (event: AgentEvent) => {
        this.handleTelemetryEvent(event);
      }
    );
  }

  private handleTelemetryEvent(event: AgentEvent): void {
    try {
      const extracted = extractTelemetry(event.sessionId, event.data);
      if (!extracted) return;

      this.cachedTelemetry = extracted.session;
      if (extracted.account) {
        this.cachedAccount = extracted.account;
      }

      // Broadcast the updated telemetry
      const telemetryData: TelemetryData = {
        ...extracted.session,
        updatedAt: new Date().toISOString(),
      };
      this.deps.broadcastEvent('session-telemetry', {
        sessionId: event.sessionId,
        data: telemetryData,
      });

      // Broadcast account telemetry if available
      if (extracted.account) {
        const accountTelemetry: AccountTelemetry = {
          framework: this.framework,
          rateLimits: extracted.account.rateLimits,
          updatedAt: new Date().toISOString(),
        };
        this.deps.broadcastEvent('account-telemetry', {
          data: accountTelemetry,
        });
      }
    } catch (err) {
      logger.warn(
        `Failed to process telemetry event for session ${event.sessionId}:`,
        err
      );
    }
  }

  /**
   * Returns the cached telemetry data from the latest event.
   * If no telemetry has been received yet, returns null.
   */
  collectSnapshot(_sessionId: string): TelemetryData | null {
    if (!this.cachedTelemetry) return null;

    return {
      ...this.cachedTelemetry,
      updatedAt: new Date().toISOString(),
    };
  }

  /** Returns the most recently observed account telemetry, or null if none seen yet. */
  collectAccountTelemetry(): AccountTelemetry | null {
    if (!this.cachedAccount) return null;

    return {
      framework: this.framework,
      rateLimits: this.cachedAccount.rateLimits,
      updatedAt: new Date().toISOString(),
    };
  }

  detach(_sessionId: string): void {
    // Unsubscribe from events
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    // Clear cached data
    this.cachedTelemetry = null;
    this.cachedAccount = null;
  }
}

// Self-register when this module is imported
registerTelemetryAdapter(
  'opencode',
  (deps) => new OpenCodeTelemetryAdapter(deps)
);
