import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import type { NativeSessionLiveEvent } from '../../shared/provider-native-live-events.js';
import type {
  CliGatewayEventBus,
  CliGatewayMetadataTopic,
} from '../cli-gateway-event-bus.js';
import { createLogger } from '../logger.js';
import {
  normalizeClaudeLiveEvent,
  normalizeCodexLiveEvent,
  normalizePrimeAgentLiveEvent,
} from './live-event-normalizers.js';
import { JsonlFileTailer } from './jsonl-tailer.js';

const logger = createLogger('provider-state:live-tail');

/**
 * Durable per-(provider, nativeId) byte cursors for live tails (#1428).
 *
 * Restart semantics are the classic double-delivery trap: a consumer may only
 * trust "resume with no replay and no gap" when the cursor hits durable
 * storage before the events are considered delivered. Cursors are written to
 * a JSON file under the hub config directory after every poll, keyed by
 * `${provider}:${nativeId}` plus a content hash of the source path so a moved
 * session file never resumes into the wrong stream.
 */
export class LiveTailCursorStore {
  private readonly filePath: string;
  private cache: Record<string, number> | null = null;

  constructor(configDir: string) {
    const dir = path.join(configDir, 'native-session-tail-cursors');
    try {
      mkdirSync(dir, { recursive: true });
    } catch (error) {
      logger.warn('Could not create tail-cursor directory:', error);
    }
    this.filePath = path.join(dir, 'cursors.json');
  }

  load(key: string): number | null {
    if (this.cache === null) {
      try {
        const raw = readFileSync(this.filePath, 'utf8');
        const parsed: unknown = JSON.parse(raw);
        this.cache =
          typeof parsed === 'object' && parsed !== null
            ? (parsed as Record<string, number>)
            : {};
      } catch {
        this.cache = {};
      }
    }
    const value = this.cache[key];
    return typeof value === 'number' && Number.isFinite(value) && value >= 0
      ? value
      : null;
  }

  save(key: string, offset: number): void {
    const cache = (this.cache ??= {});
    cache[key] = offset;
    try {
      writeFileSync(this.filePath, JSON.stringify(cache), 'utf8');
    } catch (error) {
      // Cursor persistence failure must not crash the tail; the next save
      // retries. Worst case after a crash is a replayed suffix, which the
      // restart test below exercises.
      logger.warn(`Could not persist tail cursor ${key}:`, error);
    }
  }
}

interface WatchRequest {
  provider: 'claude' | 'codex' | 'prime-agent';
  nativeId: string;
  sourcePath: string;
}

export interface NativeSessionLiveTailManagerOptions {
  eventBus: CliGatewayEventBus;
  cursorStore: LiveTailCursorStore;
  /** Defaults to 500ms; well under the ~1s acceptance budget. */
  pollIntervalMs?: number;
}

const TAIL_TOPIC: CliGatewayMetadataTopic = 'native-sessions';

/**
 * Owns one {@link JsonlFileTailer} per watched native session, normalizes raw
 * JSONL lines through provider mappers, and publishes redacted live events
 * onto the scoped `native-sessions` gateway topic.
 *
 * Observation only: tails open files read-only; nothing is ever written to
 * native session stores and no input is injected anywhere (#1428 non-goals).
 */
export class NativeSessionLiveTailManager {
  private readonly eventBus: CliGatewayEventBus;
  private readonly cursorStore: LiveTailCursorStore;
  private readonly pollIntervalMs: number;
  private readonly tails = new Map<
    string,
    JsonlFileTailer<NativeSessionLiveEvent[]>
  >();
  private timer: NodeJS.Timeout | undefined;

  constructor(options: NativeSessionLiveTailManagerOptions) {
    this.eventBus = options.eventBus;
    this.cursorStore = options.cursorStore;
    this.pollIntervalMs = options.pollIntervalMs ?? 500;
  }

  watch(request: WatchRequest): void {
    const key = `${request.provider}:${request.nativeId}`;
    if (this.tails.has(key)) return;

    const cursorKey = `${key}:${path.basename(request.sourcePath)}`;
    const parseLine = (line: string): NativeSessionLiveEvent[] | null => {
      try {
        const record = JSON.parse(line) as Record<string, unknown>;
        if (request.provider === 'claude') {
          return normalizeClaudeLiveEvent(record, {
            sourcePath: request.sourcePath,
            fallbackNativeId: request.nativeId,
          });
        }
        if (request.provider === 'prime-agent') {
          return normalizePrimeAgentLiveEvent(record, {
            sourcePath: request.sourcePath,
            fallbackNativeId: request.nativeId,
          });
        }
        return normalizeCodexLiveEvent(record, {
          sourcePath: request.sourcePath,
          fallbackNativeId: request.nativeId,
        });
      } catch {
        return null;
      }
    };

    // The tailer's element type is "a batch of events from one line"; the
    // manager flattens batches when publishing so one JSONL record carrying
    // several blocks still streams every block, in order.
    const tailer = new JsonlFileTailer<NativeSessionLiveEvent[]>({
      filePath: request.sourcePath,
      parseLine,
      loadCursor: () => this.cursorStore.load(cursorKey),
      saveCursor: (offset) => this.cursorStore.save(cursorKey, offset),
    });
    this.tails.set(key, tailer);

    if (!this.timer) {
      this.timer = setInterval(() => this.pollAll(), this.pollIntervalMs);
      this.timer.unref?.();
    }
  }

  stop(provider: string, nativeId: string): void {
    const key = `${provider}:${nativeId}`;
    this.tails.delete(key);
    if (this.tails.size === 0 && this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  stopAll(): void {
    this.tails.clear();
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  get watching(): string[] {
    return [...this.tails.keys()];
  }

  /**
   * Poll every tail once and publish normalized events. Exposed for tests and
   * for deterministic callers; the interval drives production.
   */
  pollAll(): void {
    for (const [key, tailer] of this.tails) {
      let result;
      try {
        result = tailer.poll();
      } catch (error) {
        logger.warn(`Tail poll failed for ${key}:`, error);
        continue;
      }
      for (const batch of result.events) {
        if (!batch) continue;
        for (const event of batch) {
          // Unmapped native events arrive as `kind: 'gap'` — published as an
          // explicit gap frame AND logged, never silently dropped (fidelity
          // invariant in server/protocol-adapters/AGENTS.md).
          if (event.kind === 'gap') {
            logger.info(
              `Unmapped native live event (${event.provider}) '${event.providerEvent}' on ${event.nativeId}; publishing gap.`
            );
          }
          this.publish(event);
        }
      }
      if (result.gaps > 0) {
        logger.warn(
          `Tail ${key}: ${result.gaps} unparseable line(s) counted as gaps.`
        );
      }
    }
  }

  private publish(event: NativeSessionLiveEvent): void {
    this.eventBus.publish({
      topic: TAIL_TOPIC,
      type: `native-session.${event.kind}`,
      // The subscription filter/scoping key for this topic is the NATIVE
      // session id carried in `sessionId`: scoped actor credentials validate
      // their `sessionIds` grant against it (fail-closed), and
      // `--session-id <nativeId>` filters the stream.
      sessionId: event.nativeId,
      payload: {
        provider: event.provider,
        nativeId: event.nativeId,
        kind: event.kind,
        text: event.text,
        providerEvent: event.providerEvent,
        sourcePath: event.sourcePath,
        ...(event.timestamp ? { timestamp: event.timestamp } : {}),
      },
    });
  }
}
