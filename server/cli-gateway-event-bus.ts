export type CliGatewayMetadataTopic =
  | 'context'
  | 'inbox'
  | 'attention'
  | 'work-context-artifacts'
  | 'handoff-artifacts'
  | 'workflow-runs'
  | 'automation-runs'
  | 'pr-overseer'
  | 'native-sessions';

export interface CliGatewayEventRedaction {
  rawPayloadIncluded: false;
  rawTranscriptIncluded: false;
  artifactBodyIncluded: false;
}

export interface CliGatewayMetadataEvent {
  cursor: string;
  topic: CliGatewayMetadataTopic;
  type: string;
  occurredAt: string;
  workContextId?: string;
  sessionId?: string;
  globalSessionId?: string;
  /**
   * Repo checkout path this event is scoped to, when the source carries one
   * (currently the `attention` topic). Indexed so `--repo-path` can filter the
   * stream without exposing repo bodies. Other topics omit it and therefore
   * never match a repoPath filter.
   */
  repoPath?: string;
  nodeId?: string;
  actor?: { id?: string; kind?: string };
  payload: Record<string, unknown>;
  redaction: CliGatewayEventRedaction;
}

export interface CliGatewayEventFilter {
  workContextId?: string;
  sessionId?: string;
  globalSessionId?: string;
  /** Exact repo checkout path match (only `attention` events carry repoPath). */
  repoPath?: string;
}

export interface CliGatewayEventReplayResult {
  events: CliGatewayMetadataEvent[];
  replayDropped: boolean;
}

export interface CliGatewayEventBus {
  publish(
    input: Omit<CliGatewayMetadataEvent, 'cursor' | 'occurredAt' | 'redaction'> & {
      occurredAt?: string;
      redaction?: CliGatewayEventRedaction;
    }
  ): CliGatewayMetadataEvent;
  subscribe(topic: CliGatewayMetadataTopic, cb: (event: CliGatewayMetadataEvent) => void): () => void;
  replay(topic: CliGatewayMetadataTopic, cursor?: string): CliGatewayEventReplayResult;
}

const METADATA_PAYLOAD_FORBIDDEN_KEYS = new Set([
  'rawcontent',
  'rawpayload',
  'rawtranscript',
  'terminaltranscript',
  'transcript',
  'prompt',
  'prompts',
  'messages',
  'secret',
  'secrets',
  'env',
  'token',
  'apikey',
  'api_key',
  'providerauth',
  'providerprivate',
  'providerprivatestate',
]);

function cleanMetadataPayload(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => cleanMetadataPayload(item));
  if (!value || typeof value !== 'object') return value;
  const cleaned: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    const normalized = key.toLowerCase().replace(/[^a-z0-9_]/g, '');
    if (METADATA_PAYLOAD_FORBIDDEN_KEYS.has(normalized)) continue;
    cleaned[key] = cleanMetadataPayload(child);
  }
  return cleaned;
}

export function eventMatchesFilter(
  event: CliGatewayMetadataEvent,
  filter: CliGatewayEventFilter
): boolean {
  if (filter.workContextId && event.workContextId !== filter.workContextId) return false;
  if (filter.sessionId && event.sessionId !== filter.sessionId) return false;
  if (filter.globalSessionId && event.globalSessionId !== filter.globalSessionId) return false;
  if (filter.repoPath && event.repoPath !== filter.repoPath) return false;
  return true;
}

export function createCliGatewayEventBus(input: { maxEventsPerTopic?: number } = {}): CliGatewayEventBus {
  const maxEvents = input.maxEventsPerTopic ?? 1000;
  const listeners = new Map<CliGatewayMetadataTopic, Set<(event: CliGatewayMetadataEvent) => void>>();
  const buffers = new Map<CliGatewayMetadataTopic, CliGatewayMetadataEvent[]>();
  let sequence = 0;

  function topicBuffer(topic: CliGatewayMetadataTopic): CliGatewayMetadataEvent[] {
    const existing = buffers.get(topic);
    if (existing) return existing;
    const created: CliGatewayMetadataEvent[] = [];
    buffers.set(topic, created);
    return created;
  }

  return {
    publish(inputEvent) {
      const cursor = `cg:${Date.now()}:${sequence++}`;
      const event: CliGatewayMetadataEvent = {
        ...inputEvent,
        payload: cleanMetadataPayload(inputEvent.payload) as Record<string, unknown>,
        cursor,
        occurredAt: inputEvent.occurredAt ?? new Date().toISOString(),
        redaction: inputEvent.redaction ?? {
          rawPayloadIncluded: false,
          rawTranscriptIncluded: false,
          artifactBodyIncluded: false,
        },
      };
      const buffer = topicBuffer(event.topic);
      buffer.push(event);
      if (buffer.length > maxEvents) buffer.splice(0, buffer.length - maxEvents);
      for (const listener of listeners.get(event.topic) ?? []) listener(event);
      return event;
    },
    subscribe(topic, cb) {
      const bucket = listeners.get(topic) ?? new Set<(event: CliGatewayMetadataEvent) => void>();
      bucket.add(cb);
      listeners.set(topic, bucket);
      return () => {
        bucket.delete(cb);
        if (bucket.size === 0) listeners.delete(topic);
      };
    },
    replay(topic, cursor) {
      const buffer = topicBuffer(topic);
      // No cursor = live-only subscribe: the consumer asked for events from
      // "now", so buffered history is not backfilled.
      if (!cursor) return { events: [], replayDropped: false };
      const index = buffer.findIndex((event) => event.cursor === cursor);
      if (index >= 0) return { events: buffer.slice(index + 1), replayDropped: false };
      return { events: [...buffer], replayDropped: buffer.length > 0 };
    },
  };
}
