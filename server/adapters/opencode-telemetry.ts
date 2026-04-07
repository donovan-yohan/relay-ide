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
  private attachedSessions = new Set<string>();
  private cachedTelemetry = new Map<string, Omit<TelemetryData, 'updatedAt'>>();
  private cachedAccount: Omit<
    AccountTelemetry,
    'framework' | 'updatedAt'
  > | null = null;

  constructor(deps: TelemetryDeps) {
    this.deps = deps;
    this.eventAdapter = deps.eventAdapter ?? createEventAdapter();
  }

  attach(session: TelemetrySession): void {
    this.attachedSessions.add(session.id);
    // Subscribe once on first attach
    if (!this.unsubscribe) {
      this.unsubscribe = this.eventAdapter.on(
        'telemetry.updated',
        (event: AgentEvent) => {
          this.handleTelemetryEvent(event);
        }
      );
    }
  }

  private handleTelemetryEvent(event: AgentEvent): void {
    // Ignore events for sessions we're not tracking
    if (!this.attachedSessions.has(event.sessionId)) return;

    try {
      const extracted = extractTelemetry(event.sessionId, event.data);
      if (!extracted) return;

      this.cachedTelemetry.set(event.sessionId, extracted.session);
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

  collectSnapshot(sessionId: string): TelemetryData | null {
    const cached = this.cachedTelemetry.get(sessionId);
    if (!cached) return null;

    return {
      ...cached,
      updatedAt: new Date().toISOString(),
    };
  }

  collectAccountTelemetry(): AccountTelemetry | null {
    if (!this.cachedAccount) return null;

    return {
      framework: this.framework,
      rateLimits: this.cachedAccount.rateLimits,
      updatedAt: new Date().toISOString(),
    };
  }

  detach(sessionId: string): void {
    this.attachedSessions.delete(sessionId);
    this.cachedTelemetry.delete(sessionId);

    // Unsubscribe when no sessions remain
    if (this.attachedSessions.size === 0 && this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
      this.cachedAccount = null;
    }
  }
}

// Self-register when this module is imported
registerTelemetryAdapter(
  'opencode',
  (deps) => new OpenCodeTelemetryAdapter(deps)
);
