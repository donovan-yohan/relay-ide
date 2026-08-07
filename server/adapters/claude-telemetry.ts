import fs from 'node:fs';
import path from 'node:path';

import type { AccountTelemetry, TelemetryData } from '../types.js';
import type {
  TelemetryAdapter,
  TelemetryDeps,
  TelemetrySession,
} from '../telemetry-adapter.js';
import {
  asNumber,
  asString,
  registerTelemetryAdapter,
} from '../telemetry-adapter.js';
import { createLogger } from '../logger.js';

const logger = createLogger('telemetry:claude');

type IncomingTelemetryData = Omit<TelemetryData, 'updatedAt'>;

function telemetryDir(configDir: string): string {
  return path.join(configDir, 'telemetry');
}

function extractTelemetry(
  sessionId: string,
  payload: unknown
): {
  session: IncomingTelemetryData;
  account: Omit<AccountTelemetry, 'framework' | 'updatedAt'> | null;
} | null {
  if (!payload || typeof payload !== 'object') return null;

  const data = payload as Record<string, unknown>;
  const contextWindow = (data.context_window ?? {}) as Record<string, unknown>;
  const currentUsage = (contextWindow.current_usage ?? {}) as Record<
    string,
    unknown
  >;
  const cost = (data.cost ?? {}) as Record<string, unknown>;
  const rateLimits = (data.rate_limits ?? {}) as Record<string, unknown>;
  const fiveHour = (rateLimits.five_hour ?? {}) as Record<string, unknown>;
  const sevenDay = (rateLimits.seven_day ?? {}) as Record<string, unknown>;
  const model = (data.model ?? {}) as Record<string, unknown>;

  const session: IncomingTelemetryData = {
    sessionId,
    model: typeof model.display_name === 'string' ? model.display_name : null,
    totalInputTokens: asNumber(contextWindow.total_input_tokens, 0),
    totalOutputTokens: asNumber(contextWindow.total_output_tokens, 0),
    totalCacheRead: asNumber(currentUsage.cache_read_input_tokens, 0),
    totalCacheWrite: asNumber(currentUsage.cache_creation_input_tokens, 0),
    reasoningOutputTokens: asNumber(
      currentUsage.reasoning_output_tokens ?? data.reasoning_output_tokens,
      0
    ),
    contextPercent: asNumber(contextWindow.used_percentage, -1),
    contextWindowSize: asNumber(contextWindow.context_window_size, 0),
    costUsd:
      typeof cost.total_cost_usd === 'number' ? cost.total_cost_usd : null,
    source: 'statusLine',
  };

  const account =
    typeof fiveHour.used_percentage === 'number' ||
    typeof sevenDay.used_percentage === 'number' ||
    typeof fiveHour.resets_at === 'string' ||
    typeof sevenDay.resets_at === 'string'
      ? {
          rateLimits: [
            {
              name: 'five_hour',
              usedPercent: asNumber(fiveHour.used_percentage, -1),
              resetsAt: asString(fiveHour.resets_at),
              windowMinutes: 300,
            },
            {
              name: 'seven_day',
              usedPercent: asNumber(sevenDay.used_percentage, -1),
              resetsAt: asString(sevenDay.resets_at),
              windowMinutes: 10080,
            },
          ],
        }
      : null;

  return { session, account };
}

export class ClaudeTelemetryAdapter implements TelemetryAdapter {
  readonly framework = 'claude';

  private deps: TelemetryDeps;
  // Account telemetry is adapter-specific side channel — updated during collectSnapshot
  private _accountTelemetry: AccountTelemetry | null = null;

  constructor(deps: TelemetryDeps) {
    this.deps = deps;
  }

  attach(_session: TelemetrySession): void {
    // No async setup needed for Claude — telemetry is read from files on demand
  }

  /**
   * collectSnapshot reads the Claude telemetry JSON file for the session.
   * As a side channel it also updates internal account telemetry state.
   * Must stay under 5ms — synchronous file read only.
   */
  collectSnapshot(sessionId: string): TelemetryData | null {
    const filePath = path.join(
      telemetryDir(this.deps.configDir),
      `${sessionId}.json`
    );
    let raw: string;
    try {
      raw = fs.readFileSync(filePath, 'utf-8');
    } catch (err) {
      const error = err as NodeJS.ErrnoException;
      if (error.code !== 'ENOENT') {
        logger.warn(`Failed to read telemetry for session ${sessionId}:`, err);
      }
      return null;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch (err) {
      logger.warn(`Malformed telemetry JSON for session ${sessionId}:`, err);
      return null;
    }

    const extracted = extractTelemetry(sessionId, payload);
    if (!extracted) return null;

    // Update internal account telemetry side channel (broadcast handled by telemetry.ts)
    if (extracted.account) {
      this._accountTelemetry = {
        framework: 'claude',
        rateLimits: extracted.account.rateLimits,
        updatedAt: new Date().toISOString(),
      };
    }

    return {
      ...extracted.session,
      updatedAt: new Date().toISOString(),
    };
  }

  detach(_sessionId: string): void {
    // No cleanup needed — stateless file reads
  }

  /** Returns the most recently observed account telemetry, or null if none seen yet. */
  collectAccountTelemetry(): AccountTelemetry | null {
    return this._accountTelemetry;
  }
}

// Self-register when this module is imported
registerTelemetryAdapter('claude', (deps) => new ClaudeTelemetryAdapter(deps));
