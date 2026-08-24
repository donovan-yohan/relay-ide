import type { NativeSessionLiveEvent } from '../../shared/provider-native-live-events.js';
import { NATIVE_LIVE_TEXT_LIMIT } from '../../shared/provider-native-live-events.js';
import { createLogger } from '../logger.js';

const logger = createLogger('provider-state:live-normalize');

/**
 * Shared redaction for live-tail payloads (#1428). Mirrors the pattern-level
 * redaction used by the read-only state adapters so a secret that slips into
 * a provider transcript is not rebroadcast onto the gateway bus.
 */
export function redactLiveText(text: string): string {
  return text
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[redacted-secret]')
    .replace(/\bgh[pousr]_[A-Za-z0-9_]{8,}\b/g, '[redacted-secret]')
    .replace(
      /\b(api[_-]?key|token|secret|password)\s*[:=]\s*[^\s,;]+/gi,
      '$1=[redacted]'
    );
}

function truncate(text: string): string {
  return text.length > NATIVE_LIVE_TEXT_LIMIT
    ? `${text.slice(0, NATIVE_LIVE_TEXT_LIMIT - 1)}…`
    : text;
}

interface LiveContext {
  sourcePath: string;
  fallbackNativeId?: string;
}

function liveBase(
  provider: 'claude' | 'codex',
  record: Record<string, unknown>,
  context: LiveContext
): Omit<
  NativeSessionLiveEvent,
  'kind' | 'text' | 'providerEvent' | 'nativeId'
> {
  const timestamp = timestampOf(record);
  return {
    provider,
    sourcePath: context.sourcePath,
    ...(timestamp ? { timestamp } : {}),
  };
}

function objectField(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringField(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

/** Extract the message content array/string from a Claude/Codex record. */
function contentBlocks(
  record: Record<string, unknown>
): Record<string, unknown>[] {
  const message = objectField(record.message);
  const content = message.content ?? record.content;
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (!Array.isArray(content)) return [];
  return content.filter(
    (block): block is Record<string, unknown> =>
      typeof block === 'object' && block !== null
  );
}

function roleOf(record: Record<string, unknown>): string {
  const message = objectField(record.message);
  return (
    stringField(message.role) ||
    stringField(record.role) ||
    stringField(record.type)
  );
}

function timestampOf(record: Record<string, unknown>): string | undefined {
  for (const key of ['timestamp', 'created_at', 'time', 'ts']) {
    const value = record[key];
    if (typeof value === 'string' && value) return value;
  }
  if (typeof record['timestamp'] === 'number') {
    try {
      return new Date(record['timestamp']).toISOString();
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function nativeIdOf(record: Record<string, unknown>): string | undefined {
  for (const key of [
    'sessionId',
    'session_id',
    'conversationId',
    'conversation_id',
  ]) {
    const value = record[key];
    if (typeof value === 'string' && value) return value;
  }
  return undefined;
}

/**
 * Ordered, typed view over a content-block array. One native record can carry
 * several streamable blocks (thinking + tool_use + text); fidelity requires
 * emitting ALL of them, in file order, never collapsing.
 */
type BlockView =
  | { kind: 'reasoning'; text: string }
  | { kind: 'tool-call'; block: Record<string, unknown> }
  | { kind: 'text'; text: string };

function blockViews(blocks: Record<string, unknown>[]): {
  views: BlockView[];
  toolResultText: string[];
} {
  const views: BlockView[] = [];
  const toolResultText: string[] = [];
  for (const block of blocks) {
    const type = stringField(block.type);
    if (type === 'text') {
      const text = stringField(block.text);
      if (text) views.push({ kind: 'text', text });
    } else if (type === 'thinking' || type === 'reasoning') {
      const text =
        stringField(block.thinking) ||
        stringField(block.text) ||
        stringField(block.summary);
      if (text) views.push({ kind: 'reasoning', text });
    } else if (type === 'tool_use' || type === 'function_call') {
      views.push({ kind: 'tool-call', block });
    } else if (type === 'tool_result' || type === 'tool_use_result') {
      appendBlockContentText(block.content, toolResultText);
    }
  }
  return { views, toolResultText };
}

function appendBlockContentText(content: unknown, parts: string[]): void {
  if (typeof content === 'string') {
    parts.push(content);
    return;
  }
  if (!Array.isArray(content)) return;
  for (const item of content) {
    if (
      typeof item === 'object' &&
      item !== null &&
      typeof (item as Record<string, unknown>).text === 'string'
    ) {
      parts.push((item as Record<string, unknown>).text as string);
    }
  }
}

function isToolResultOnly(blocks: Record<string, unknown>[]): boolean {
  return (
    blocks.length > 0 &&
    blocks.every((block) => {
      const type = stringField(block.type);
      return type === 'tool_result' || type === 'tool_use_result';
    })
  );
}

function gapEvent(
  base: ReturnType<typeof liveBase>,
  nativeId: string,
  providerEvent: string
): NativeSessionLiveEvent {
  logger.info(
    `Unmapped native live event '${providerEvent}' reported as gap (${nativeId}).`
  );
  return { ...base, nativeId, kind: 'gap', text: '', providerEvent };
}

function toolCallEvent(
  base: ReturnType<typeof liveBase>,
  nativeId: string,
  toolCall: Record<string, unknown>,
  providerEvent: string
): NativeSessionLiveEvent {
  const input = objectField(toolCall.input ?? toolCall.args);
  const command = stringField(input.command);
  const name = stringField(
    toolCall.name,
    stringField(toolCall.tool, 'unknown-tool')
  );
  return {
    ...base,
    nativeId,
    kind: 'tool-call',
    text: truncate(redactLiveText(`${name} ${command}`.trim())),
    providerEvent,
  };
}

/**
 * Map one raw Claude Code JSONL record onto zero or more shared live events.
 * A record whose role/type is known but which carries no attributable payload
 * yields an attributed `gap` event — published and logged, never silently
 * dropped (fidelity invariant, server/protocol-adapters/AGENTS.md).
 */
export function normalizeClaudeLiveEvent(
  record: Record<string, unknown>,
  context: LiveContext
): NativeSessionLiveEvent[] {
  const type = stringField(record.type);
  const nativeId = nativeIdOf(record) ?? context.fallbackNativeId ?? '';
  const base = liveBase('claude', record, context);

  // Claude writes system/summary wrapper lines; they are known but carry no
  // streamable conversation payload. Attribute them without inventing text.
  if (type === 'summary' || type === 'system') {
    return [gapEvent(base, nativeId, type)];
  }

  const role = roleOf(record);
  const blocks = contentBlocks(record);
  const { views, toolResultText } = blockViews(blocks);

  if (role === 'user') {
    if (isToolResultOnly(blocks)) {
      return [
        {
          ...base,
          nativeId,
          kind: 'tool-result',
          text: truncate(redactLiveText(toolResultText.join('\n'))),
          providerEvent: type || 'user',
        },
      ];
    }
    const text = redactLiveText(
      views
        .filter((view): view is Extract<BlockView, { kind: 'text' }> => view.kind === 'text')
        .map((view) => view.text)
        .join('\n')
    );
    if (!text) {
      return [gapEvent(base, nativeId, type || 'user')];
    }
    return [
      {
        ...base,
        nativeId,
        kind: 'user-message',
        text: truncate(text),
        providerEvent: type || 'user',
      },
    ];
  }

  if (role === 'assistant') {
    const events: NativeSessionLiveEvent[] = [];
    let emitted = false;
    for (const view of views) {
      if (view.kind === 'tool-call') {
        events.push(toolCallEvent(base, nativeId, view.block, type || 'assistant'));
        emitted = true;
      } else if (view.kind === 'reasoning') {
        events.push({
          ...base,
          nativeId,
          kind: 'reasoning',
          text: truncate(redactLiveText(view.text)),
          providerEvent: type || 'assistant',
        });
        emitted = true;
      } else {
        const text = redactLiveText(view.text);
        if (!text) continue;
        events.push({
          ...base,
          nativeId,
          kind: 'assistant-message',
          text: truncate(text),
          providerEvent: type || 'assistant',
        });
        emitted = true;
      }
    }
    if (!emitted) {
      return [gapEvent(base, nativeId, type || 'assistant')];
    }
    return events;
  }

  return [gapEvent(base, nativeId, type || 'unknown')];
}

/**
 * Map one raw Codex JSONL record onto zero or more shared live events. The
 * Codex transcript layout matches telemetry knowledge in
 * `codex-telemetry.ts` plus the user/assistant/tool_use layout already
 * normalized by the read-only state adapter.
 */
export function normalizeCodexLiveEvent(
  record: Record<string, unknown>,
  context: LiveContext
): NativeSessionLiveEvent[] {
  const type = stringField(record.type);
  const nativeId = nativeIdOf(record) ?? context.fallbackNativeId ?? '';
  const base = liveBase('codex', record, context);

  if (type === 'session.started' || type === 'session_config') {
    return [
      {
        ...base,
        nativeId,
        kind: 'session-started',
        text: '',
        providerEvent: type,
      },
    ];
  }

  const role = roleOf(record);
  const blocks = contentBlocks(record);
  const { views, toolResultText } = blockViews(blocks);

  if (role === 'user') {
    if (isToolResultOnly(blocks)) {
      return [
        {
          ...base,
          nativeId,
          kind: 'tool-result',
          text: truncate(redactLiveText(toolResultText.join('\n'))),
          providerEvent: type || 'user',
        },
      ];
    }
    const text = redactLiveText(
      views
        .filter((view): view is Extract<BlockView, { kind: 'text' }> => view.kind === 'text')
        .map((view) => view.text)
        .join('\n')
    );
    if (!text) {
      return [gapEvent(base, nativeId, type || 'user')];
    }
    return [
      {
        ...base,
        nativeId,
        kind: 'user-message',
        text: truncate(text),
        providerEvent: type || 'user',
      },
    ];
  }

  if (role === 'assistant') {
    const events: NativeSessionLiveEvent[] = [];
    let emitted = false;
    for (const view of views) {
      if (view.kind === 'tool-call') {
        events.push(toolCallEvent(base, nativeId, view.block, type || 'assistant'));
        emitted = true;
      } else if (view.kind === 'reasoning') {
        events.push({
          ...base,
          nativeId,
          kind: 'reasoning',
          text: truncate(redactLiveText(view.text)),
          providerEvent: type || 'assistant',
        });
        emitted = true;
      } else {
        const text = redactLiveText(view.text);
        if (!text) continue;
        events.push({
          ...base,
          nativeId,
          kind: 'assistant-message',
          text: truncate(text),
          providerEvent: type || 'assistant',
        });
        emitted = true;
      }
    }
    if (!emitted) {
      return [gapEvent(base, nativeId, type || 'assistant')];
    }
    return events;
  }

  // Telemetry-style events (token_count/rate_limits/turn_context) are consumed
  // by the telemetry adapters; on this surface they are attributed gaps, never
  // silent drops.
  return [gapEvent(base, nativeId, type || 'unknown')];
}
