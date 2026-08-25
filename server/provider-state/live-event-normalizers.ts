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
  provider: 'claude' | 'codex' | 'pi' | 'prime-agent' | 'dsh',
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
    } else if (
      type === 'tool_use' ||
      type === 'function_call' ||
      type === 'toolCall'
    ) {
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
        .filter(
          (view): view is Extract<BlockView, { kind: 'text' }> =>
            view.kind === 'text'
        )
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
        events.push(
          toolCallEvent(base, nativeId, view.block, type || 'assistant')
        );
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
        .filter(
          (view): view is Extract<BlockView, { kind: 'text' }> =>
            view.kind === 'text'
        )
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
        events.push(
          toolCallEvent(base, nativeId, view.block, type || 'assistant')
        );
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

/**
 * Map one raw Prime Agent JSONL record onto zero or more shared live events.
 * Prime's transcript layout (verified against real `~/.prime/agent/sessions`
 * files): a `type:"session"` header line, then typed records whose conversational
 * payloads ride in `message` envelopes with roles user/assistant/toolResult and
 * content blocks text/thinking/toolCall. Everything else is an attributed gap.
 */
export function normalizePrimeAgentLiveEvent(
  record: Record<string, unknown>,
  context: LiveContext
): NativeSessionLiveEvent[] {
  const type = stringField(record.type);
  const nativeId = nativeIdOf(record) ?? context.fallbackNativeId ?? '';
  const base = liveBase('prime-agent', record, context);

  if (type === 'session') {
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

  if (type !== 'message') {
    return [gapEvent(base, nativeId, type || 'unknown')];
  }

  const role = roleOf(record);
  const blocks = contentBlocks(record);
  const { views } = blockViews(blocks);

  if (role === 'user') {
    const text = redactLiveText(
      views
        .filter(
          (view): view is Extract<BlockView, { kind: 'text' }> =>
            view.kind === 'text'
        )
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

  if (role === 'toolResult') {
    const toolResultText = blocks
      .filter((block) => stringField(block.type) === 'text')
      .map((block) => stringField(block.text))
      .join('\n');
    return [
      {
        ...base,
        nativeId,
        kind: 'tool-result',
        text: truncate(redactLiveText(toolResultText)),
        providerEvent: type || 'toolResult',
      },
    ];
  }

  if (role === 'assistant') {
    const events: NativeSessionLiveEvent[] = [];
    let emitted = false;
    for (const view of views) {
      if (view.kind === 'tool-call') {
        events.push(
          toolCallEvent(
            base,
            nativeId,
            primeToolCallShape(view.block),
            type || 'assistant'
          )
        );
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
 * Prime tool-call blocks use `{name, arguments}`, and their executable payload
 * rides in `arguments.code` / `arguments.command`; the shared toolCallEvent
 * reads `{name|tool, input|args}.command`. Normalize the shape without
 * mutating the original record.
 */
function primeToolCallShape(
  block: Record<string, unknown>
): Record<string, unknown> {
  if (!('arguments' in block) || 'input' in block || 'args' in block) {
    return block;
  }
  const args = objectField(block['arguments']);
  const command = stringField(args['command']) || stringField(args['code']);
  return { ...block, input: { ...args, command } };
}

/**
 * Map one raw Pi agent JSONL record onto zero or more shared live events.
 * Layout verified against real `~/.pi/agent/sessions` stores (#1426):
 * `type: 'session'` header, `type: 'message'` records with
 * `message.role` user|assistant|toolResult and content blocks
 * text|thinking|toolCall, plus model_change/thinking_level_change/compaction
 * metadata records.
 */
export function normalizePiLiveEvent(
  record: Record<string, unknown>,
  context: LiveContext
): NativeSessionLiveEvent[] {
  const type = stringField(record.type);
  // Pi records carry event-chain ids (id/parentId), NOT the session uuid —
  // the session identity comes from the watched file's fallback nativeId.
  const nativeId = context.fallbackNativeId || '';
  const base = liveBase('pi', record, context);

  if (type === 'session') {
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

  if (type !== 'message') {
    // Metadata records (model_change / thinking_level_change / compaction) are
    // known but carry no conversation payload here: attributed gaps, never
    // silent drops.
    return [gapEvent(base, nativeId, type || 'unknown')];
  }

  const message = objectField(record.message);
  const role = stringField(message.role);
  const blocks = contentBlocks({ ...record, message });
  // Pi names tool-invocation blocks `toolCall` and puts the payload under
  // `arguments`; normalize onto the shared `input` shape so the common block
  // extractor sees a tool call (#1426).
  const piBlocks = blocks.map((block) =>
    stringField(block.type) === 'toolCall'
      ? { ...block, input: block.arguments ?? block.input }
      : block
  );
  const { views, toolResultText } = blockViews(piBlocks);

  if (role === 'user') {
    const text = redactLiveText(
      views
        .filter(
          (view): view is Extract<BlockView, { kind: 'text' }> =>
            view.kind === 'text'
        )
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
        providerEvent: `${type}:user`,
      },
    ];
  }

  if (role === 'assistant') {
    const events: NativeSessionLiveEvent[] = [];
    let emitted = false;
    for (const view of views) {
      if (view.kind === 'tool-call') {
        events.push(
          toolCallEvent(base, nativeId, view.block, `${type}:assistant`)
        );
        emitted = true;
      } else if (view.kind === 'reasoning') {
        events.push({
          ...base,
          nativeId,
          kind: 'reasoning',
          text: truncate(redactLiveText(view.text)),
          providerEvent: `${type}:assistant`,
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
          providerEvent: `${type}:assistant`,
        });
        emitted = true;
      }
    }
    if (!emitted) {
      return [gapEvent(base, nativeId, `${type}:assistant`)];
    }
    return events;
  }

  if (role === 'toolResult') {
    // Pi tool results are plain text blocks on a role='toolResult' message,
    // not `tool_result` content blocks; extract their text directly.
    const resultText =
      toolResultText.length > 0
        ? toolResultText.join('\n')
        : piBlocks
            .filter((block) => stringField(block.type) === 'text')
            .map((block) => stringField(block.text))
            .join('\n');
    return [
      {
        ...base,
        nativeId,
        kind: 'tool-result',
        text: truncate(redactLiveText(resultText)),
        providerEvent: `${type}:${role}`,
      },
    ];
  }

  return [gapEvent(base, nativeId, `${type}:${role || 'unknown-role'}`)];
}

/**
 * Map one raw DeepSeek Harness (DSH) session record onto zero or more shared
 * live events. Layout verified against real `~/.dsh/sessions` stores (#1426):
 * typed records with epoch-ms `time` and a `data` payload — `user/message`
 * (role/source-kind + content blocks), `assistant/chunk` stream deltas,
 * `reasoning-chunks` thinking deltas, consolidated `assistant/message`, plus
 * operational metadata (`session/title`, `permission/preset`,
 * `sandbox/mode`, `approval/policy`, turn/step markers, ...).
 *
 * Deterministic-and-simple choice: `assistant/chunk` deltas are attributed
 * gaps (`assistant/chunk:folded-into-assistant-message`) rather than partial
 * assistant-message updates — the consolidated `assistant/message` already
 * carries the final text, so emitting both would double-count; the gap keeps
 * the fidelity invariant without inventing incremental state.
 */
export function normalizeDshLiveEvent(
  record: Record<string, unknown>,
  context: LiveContext
): NativeSessionLiveEvent[] {
  const type = stringField(record.type);
  // DSH records carry seq numbers, not the session uuid — session identity
  // comes from the watched file's fallback nativeId.
  const nativeId = context.fallbackNativeId || '';
  const base = liveBase('dsh', record, context);
  const data = objectField(record.data);

  if (type === 'session') {
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

  if (type === 'user/message') {
    const sourceKind = stringField(objectField(data.source).kind, 'user');
    if (sourceKind !== 'user') {
      return [gapEvent(base, nativeId, `${type}:${sourceKind}`)];
    }
    const text = redactLiveText(textFromContent(data.content));
    if (!text) {
      return [gapEvent(base, nativeId, `${type}:user(empty)`)];
    }
    return [
      {
        ...base,
        nativeId,
        kind: 'user-message',
        text: truncate(text),
        providerEvent: `${type}:user`,
      },
    ];
  }

  if (type === 'assistant/message') {
    const message = objectField(data.message);
    const text = redactLiveText(textFromContent(message.content));
    if (!text) {
      return [gapEvent(base, nativeId, `${type}:assistant(empty)`)];
    }
    return [
      {
        ...base,
        nativeId,
        kind: 'assistant-message',
        text: truncate(text),
        providerEvent: type,
      },
    ];
  }

  if (type === 'reasoning-chunks') {
    const texts = Array.isArray(data.texts)
      ? data.texts.filter((t): t is string => typeof t === 'string')
      : [];
    const joined = texts.join('');
    if (!joined) {
      return [gapEvent(base, nativeId, `${type}:empty`)];
    }
    return [
      {
        ...base,
        nativeId,
        kind: 'reasoning',
        text: truncate(redactLiveText(joined)),
        providerEvent: type,
      },
    ];
  }

  if (
    type === 'assistant/chunk' ||
    type === 'turn/start' ||
    type === 'step/start' ||
    type === 'step/end' ||
    type === 'turn/end'
  ) {
    return [
      gapEvent(
        base,
        nativeId,
        type === 'assistant/chunk'
          ? `${type}:folded-into-assistant-message`
          : type
      ),
    ];
  }

  // Everything else (permission/preset, sandbox/mode, approval/policy,
  // request/header|context, agent/inbox/spliced, session/title, ...) is an
  // attributed gap — published and logged, never a silent drop.
  return [gapEvent(base, nativeId, type || 'unknown')];
}

/** Flatten DSH content blocks (or a bare string) into redactable text. */
function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (
      typeof block === 'object' &&
      block !== null &&
      !Array.isArray(block) &&
      (block as Record<string, unknown>).type === 'text' &&
      typeof (block as Record<string, unknown>).text === 'string'
    ) {
      parts.push((block as Record<string, unknown>).text as string);
    }
  }
  return parts.join('\n');
}
