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
  trailingFragment: string;
  lastSeenModel: string | null;
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
 * Extract rate limit data from a rate_limits event
 */
function extractRateLimits(
  rateLimitsEvent: RateLimitsEvent
): Omit<AccountTelemetry, 'framework' | 'updatedAt'> | null {
  const rateLimits: RateLimitWindow[] = Object.entries(rateLimitsEvent).map(
    ([name, data]) => ({
      name,
      usedPercent: data.used_percentage ?? -1,
      resetsAt: data.resets_at ?? '',
      ...(data.window_minutes !== undefined && {
        windowMinutes: data.window_minutes,
      }),
    })
  );
  return rateLimits.length > 0 ? { rateLimits } : null;
}

/**
 * Extract telemetry data from accumulated events.
 * Accepts persisted state (model, account) so data from earlier polls isn't lost.
 */
function extractTelemetryFromEvents(
  sessionId: string,
  events: CodexJsonlEvent[],
  state: CodexSessionState
): {
  session: IncomingTelemetryData | null;
  account: Omit<AccountTelemetry, 'framework' | 'updatedAt'> | null;
  model: string | null;
} {
  let latestTokenCount: TokenCountEvent | null = null;
  let latestRateLimits: RateLimitsEvent | null = null;
  let model: string | null = state.lastSeenModel;

  for (const event of events) {
    if (event.type === 'token_count' && event.token_count) {
      latestTokenCount = event.token_count;
    }
    if (event.type === 'rate_limits' && event.rate_limits) {
      latestRateLimits = event.rate_limits;
    }
    if (event.type === 'turn_context' && event.turn_context?.model) {
      model = event.turn_context.model;
    }
  }

  // Rate limits are extracted independently of token_count
  const account = latestRateLimits ? extractRateLimits(latestRateLimits) : null;

  // Session telemetry requires token_count data
  if (!latestTokenCount) {
    return { session: null, account, model };
  }

  const session: IncomingTelemetryData = {
    sessionId,
    model,
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

  return { session, account, model };
}

/**
 * Tail the JSONL file from the last known offset and parse new events.
 * Returns a trailing fragment (incomplete line) to be prepended on the next poll.
 */
function tailFile(
  filePath: string,
  startOffset: number,
  leadingFragment: string
): { events: CodexJsonlEvent[]; newOffset: number; trailing: string } {
  try {
    const stats = fs.statSync(filePath);
    const fileSize = stats.size;

    // If the file was truncated/rotated, reset to the beginning
    const effectiveOffset = startOffset > fileSize ? 0 : startOffset;

    // If file hasn't grown, nothing to read
    if (effectiveOffset === fileSize) {
      return {
        events: [],
        newOffset: effectiveOffset,
        trailing: leadingFragment,
      };
    }

    // Read only new bytes since last poll
    const bytesToRead = fileSize - effectiveOffset;
    const buffer = Buffer.alloc(bytesToRead);
    const fd = fs.openSync(filePath, 'r');
    let bytesRead: number;
    try {
      bytesRead = fs.readSync(fd, buffer, 0, bytesToRead, effectiveOffset);
    } finally {
      fs.closeSync(fd);
    }

    // Prepend any trailing fragment from the previous poll
    const newContent =
      leadingFragment + buffer.subarray(0, bytesRead).toString('utf-8');
    const lines = newContent.split('\n');

    // Last element may be an incomplete line — save it for next poll
    const trailing = lines.pop() ?? '';

    const events: CodexJsonlEvent[] = [];
    for (const line of lines) {
      const event = parseJsonlLine(line);
      if (event) {
        events.push(event);
      }
    }

    // Advance offset by actual bytes read (not including the trailing fragment
    // which will be re-processed next poll)
    const newOffset = effectiveOffset + bytesRead;
    return { events, newOffset, trailing };
  } catch (err) {
    const error = err as NodeJS.ErrnoException;
    if (error.code !== 'ENOENT') {
      logger.warn(`Failed to tail Codex telemetry file ${filePath}:`, err);
    }
    return { events: [], newOffset: startOffset, trailing: leadingFragment };
  }
}

export class CodexTelemetryAdapter implements TelemetryAdapter {
  readonly framework = 'codex';

  private sessionStates = new Map<string, CodexSessionState>();
  private _accountTelemetry: AccountTelemetry | null = null;

  constructor(_deps: TelemetryDeps) {
    // deps unused — Codex adapter relies on JSONL file tailing, not deps
  }

  attach(session: TelemetrySession): void {
    this.sessionStates.set(session.id, {
      transcriptPath: null,
      lastByteOffset: 0,
      trailingFragment: '',
      lastSeenModel: null,
      cachedTelemetry: null,
      cachedAccountTelemetry: null,
    });
  }

  /**
   * Handle hook events from the Codex hooks adapter.
   * Captures transcript_path and seeks to end of file so the first poll
   * only reads new data instead of the entire transcript.
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
      // Seek to end so the first collectSnapshot only reads new data
      try {
        const stats = fs.statSync(transcriptPath);
        state.lastByteOffset = stats.size;
      } catch {
        // File may not exist yet — offset stays at 0
      }
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

    if (!state.transcriptPath) {
      return null;
    }

    const { events, newOffset, trailing } = tailFile(
      state.transcriptPath,
      state.lastByteOffset,
      state.trailingFragment
    );

    state.lastByteOffset = newOffset;
    state.trailingFragment = trailing;

    if (events.length === 0) {
      if (state.cachedTelemetry) {
        return {
          ...state.cachedTelemetry,
          updatedAt: new Date().toISOString(),
        };
      }
      return null;
    }

    const extracted = extractTelemetryFromEvents(sessionId, events, state);

    // Persist model across polls
    state.lastSeenModel = extracted.model;

    // Update account telemetry independently of session telemetry
    if (extracted.account) {
      state.cachedAccountTelemetry = extracted.account;
      this._accountTelemetry = {
        framework: 'codex',
        rateLimits: extracted.account.rateLimits,
        updatedAt: new Date().toISOString(),
      };
    }

    if (extracted.session) {
      state.cachedTelemetry = extracted.session;
      return { ...extracted.session, updatedAt: new Date().toISOString() };
    }

    // No token_count yet — return cached if available
    if (state.cachedTelemetry) {
      return { ...state.cachedTelemetry, updatedAt: new Date().toISOString() };
    }
    return null;
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
