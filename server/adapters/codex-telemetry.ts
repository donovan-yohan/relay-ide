import fs from 'node:fs';
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

const logger = createLogger('telemetry:codex');

type IncomingTelemetryData = Omit<TelemetryData, 'updatedAt'>;

/**
 * Codex JSONL event types we care about
 */
interface TokenCountEvent {
  input_tokens?: number;
  output_tokens?: number;
  cached_tokens?: number;
  reasoning_output_tokens?: number;
}

interface RateLimitsEvent {
  [windowName: string]: {
    used_percentage?: number;
    resets_at?: string;
    window_minutes?: number;
  };
}

interface TurnContextEvent {
  model?: string;
}

interface CodexJsonlEvent {
  type?: string;
  token_count?: TokenCountEvent;
  rate_limits?: RateLimitsEvent;
  turn_context?: TurnContextEvent;
}

/**
 * Per-session state for the Codex telemetry adapter
 */
interface CodexSessionState {
  transcriptPath: string | null;
  lastByteOffset: number;
  cachedTelemetry: IncomingTelemetryData | null;
  cachedAccountTelemetry: Omit<
    AccountTelemetry,
    'framework' | 'updatedAt'
  > | null;
}

/**
 * Parse a single JSONL line into a Codex event
 */
function parseJsonlLine(line: string): CodexJsonlEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as CodexJsonlEvent;
  } catch {
    return null;
  }
}

/**
 * Extract telemetry data from accumulated events
 */
function extractTelemetryFromEvents(
  sessionId: string,
  events: CodexJsonlEvent[]
): {
  session: IncomingTelemetryData;
  account: Omit<AccountTelemetry, 'framework' | 'updatedAt'> | null;
} | null {
  // Find the latest token_count event
  let latestTokenCount: TokenCountEvent | null = null;
  let latestRateLimits: RateLimitsEvent | null = null;
  let latestModel: string | null = null;

  for (const event of events) {
    if (event.type === 'token_count' && event.token_count) {
      latestTokenCount = event.token_count;
    }
    if (event.type === 'rate_limits' && event.rate_limits) {
      latestRateLimits = event.rate_limits;
    }
    if (event.type === 'turn_context' && event.turn_context?.model) {
      latestModel = event.turn_context.model;
    }
  }

  // If we have no token count data, we can't report telemetry
  if (!latestTokenCount) {
    return null;
  }

  const session: IncomingTelemetryData = {
    sessionId,
    model: latestModel,
    totalInputTokens: latestTokenCount.input_tokens ?? 0,
    totalOutputTokens: latestTokenCount.output_tokens ?? 0,
    totalCacheRead: latestTokenCount.cached_tokens ?? 0,
    totalCacheWrite: 0, // Codex doesn't track this separately
    reasoningOutputTokens: latestTokenCount.reasoning_output_tokens ?? 0,
    contextPercent: -1, // Not provided by Codex JSONL
    contextWindowSize: 0, // Not provided by Codex JSONL
    costUsd: null, // Not provided by Codex JSONL
    source: 'jsonl',
  };

  // Extract rate limits if available
  let account: Omit<AccountTelemetry, 'framework' | 'updatedAt'> | null = null;
  if (latestRateLimits) {
    const rateLimits: RateLimitWindow[] = Object.entries(latestRateLimits).map(
      ([name, data]) => ({
        name,
        usedPercent: data.used_percentage ?? -1,
        resetsAt: data.resets_at ?? '',
        ...(data.window_minutes !== undefined && {
          windowMinutes: data.window_minutes,
        }),
      })
    );

    if (rateLimits.length > 0) {
      account = { rateLimits };
    }
  }

  return { session, account };
}

/**
 * Tail the JSONL file from the last known offset and parse new events
 */
function tailFile(
  filePath: string,
  startOffset: number
): { events: CodexJsonlEvent[]; newOffset: number } {
  try {
    // Get current file size
    const stats = fs.statSync(filePath);
    const fileSize = stats.size;

    // If file hasn't grown or was truncated, return empty
    if (startOffset >= fileSize) {
      return { events: [], newOffset: startOffset };
    }

    // Read only new bytes since last poll
    const bytesToRead = fileSize - startOffset;
    const buffer = Buffer.alloc(bytesToRead);
    const fd = fs.openSync(filePath, 'r');
    try {
      fs.readSync(fd, buffer, 0, bytesToRead, startOffset);
    } finally {
      fs.closeSync(fd);
    }

    // Parse new content as lines
    const newContent = buffer.toString('utf-8');
    const lines = newContent.split('\n');

    const events: CodexJsonlEvent[] = [];
    for (const line of lines) {
      const event = parseJsonlLine(line);
      if (event) {
        events.push(event);
      }
    }

    return { events, newOffset: fileSize };
  } catch (err) {
    const error = err as NodeJS.ErrnoException;
    if (error.code !== 'ENOENT') {
      logger.warn(`Failed to tail Codex telemetry file ${filePath}:`, err);
    }
    return { events: [], newOffset: startOffset };
  }
}

export class CodexTelemetryAdapter implements TelemetryAdapter {
  readonly framework = 'codex';

  private deps: TelemetryDeps;
  private sessionStates = new Map<string, CodexSessionState>();
  private _accountTelemetry: AccountTelemetry | null = null;

  constructor(deps: TelemetryDeps) {
    this.deps = deps;
  }

  attach(session: TelemetrySession): void {
    // Initialize session state - transcript_path will be set via handleHookEvent
    this.sessionStates.set(session.id, {
      transcriptPath: null,
      lastByteOffset: 0,
      cachedTelemetry: null,
      cachedAccountTelemetry: null,
    });
  }

  /**
   * Handle hook events from the Codex hooks adapter.
   * Call this when a session.started hook is received to capture transcript_path.
   */
  handleHookEvent(
    sessionId: string,
    eventType: string,
    data: Record<string, unknown>
  ): void {
    if (eventType !== 'session.started') return;

    const transcriptPath =
      typeof data.transcript_path === 'string' ? data.transcript_path : null;
    if (!transcriptPath) return;

    const state = this.sessionStates.get(sessionId);
    if (state) {
      state.transcriptPath = transcriptPath;
      logger.debug(
        `Set transcript path for session ${sessionId}: ${transcriptPath}`
      );
    }
  }

  /**
   * Collect telemetry snapshot by tailing the JSONL file.
   * Must stay under 5ms - only reads new bytes since last poll.
   */
  collectSnapshot(sessionId: string): TelemetryData | null {
    const state = this.sessionStates.get(sessionId);
    if (!state) return null;

    // If we haven't discovered the transcript path yet, return null (no crash)
    if (!state.transcriptPath) {
      return null;
    }

    // Tail the file for new events
    const { events, newOffset } = tailFile(
      state.transcriptPath,
      state.lastByteOffset
    );

    // Update offset for next poll
    state.lastByteOffset = newOffset;

    // If no new events, return cached telemetry if available
    if (events.length === 0) {
      if (state.cachedTelemetry) {
        return {
          ...state.cachedTelemetry,
          updatedAt: new Date().toISOString(),
        };
      }
      return null;
    }

    // Extract telemetry from accumulated events
    const extracted = extractTelemetryFromEvents(sessionId, events);
    if (!extracted) {
      // No valid token_count event yet, return cached if available
      if (state.cachedTelemetry) {
        return {
          ...state.cachedTelemetry,
          updatedAt: new Date().toISOString(),
        };
      }
      return null;
    }

    // Cache the telemetry for future polls
    state.cachedTelemetry = extracted.session;
    if (extracted.account) {
      state.cachedAccountTelemetry = extracted.account;
      this._accountTelemetry = {
        framework: 'codex',
        rateLimits: extracted.account.rateLimits,
        updatedAt: new Date().toISOString(),
      };
    }

    return {
      ...extracted.session,
      updatedAt: new Date().toISOString(),
    };
  }

  detach(sessionId: string): void {
    this.sessionStates.delete(sessionId);
  }

  /**
   * Returns the most recently observed account telemetry, or null if none seen yet.
   */
  collectAccountTelemetry(): AccountTelemetry | null {
    return this._accountTelemetry;
  }
}

// Self-register when this module is imported
registerTelemetryAdapter('codex', (deps) => new CodexTelemetryAdapter(deps));
