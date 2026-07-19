// Channel conversation core wire protocol (#1165, epic #1163).
//
// `ChannelEventV1` is a NEW, purpose-built multi-sender envelope. It deliberately
// does NOT extend `AgentPatchV2` (shared/agent-chat-protocol-v2.ts), whose reducer
// is structurally single-agent (singular `live.activeTurnId`); grafting sender
// attribution onto it would corrupt every adapter. A channel is a durable,
// multi-party timeline: humans and agents post into one seq-ordered log. Two
// agents streaming at once are two independent `streaming` rows with distinct ids
// and distinct (already-assigned) seqs — cross-sender corruption is structurally
// impossible because no reducer field is shared between senders.

export const CHANNEL_CHAT_PROTOCOL_VERSION = 1 as const;
export const CHANNEL_MESSAGE_MAX_IMAGE_PARTS = 4;
export const CHANNEL_IMAGE_ALT_MAX_LENGTH = 500;

/** 256KB per-message body cap, parity with WORK_CONTEXT_MESSAGE_PAYLOAD_MAX_BYTES. */
export const CHANNEL_MESSAGE_BODY_MAX_BYTES = 256 * 1024;

export type ChannelMessageId = `chm:${string}`;
export type ChannelAttachmentId = `cha:${string}`;

export type ChannelImageMime =
  | 'image/png'
  | 'image/jpeg'
  | 'image/webp'
  | 'image/gif';

/** Sender-neutral durable image reference. Raw bytes never enter the message row. */
export interface ChannelImagePart {
  type: 'image';
  id: ChannelAttachmentId;
  mime: ChannelImageMime;
  w: number;
  h: number;
  bytes: number;
  alt?: string;
}

export type ChannelMessagePart = ChannelImagePart;

export type ChannelSenderKind = 'human' | 'agent' | 'system';
export type ChannelMessageKind = 'message' | 'system';
export type ChannelMessageStatus =
  | 'streaming'
  | 'complete'
  | 'truncated'
  | 'interrupted'
  | 'failed';
export type ChannelTruncationReason =
  | 'size-limit'
  | 'missing-terminal'
  | 'restart';
export type ChannelBodyFormat = 'markdown' | 'text';

export interface ChannelSenderRef {
  kind: ChannelSenderKind;
  /** 'human:<actorId>' | 'agent:<frameworkId>' | 'system' */
  id: string;
  displayName?: string;
  /** agent framework id (claude/codex/hermes/opencode) */
  providerId?: string;
  /** backing adapter session (slice 4 fills) */
  sessionId?: string;
}

export interface ChannelMemberRef {
  kind: 'human' | 'agent';
  id: string;
  joinedAt: string;
}

export interface ChannelMention {
  raw: string;
  providerId?: string;
}

export interface ChannelMessageSource {
  sessionId: string;
  turnId?: string;
  itemId?: string;
}

export interface ChannelMessage {
  schemaVersion: 1;
  id: ChannelMessageId;
  channelId: string;
  seq: number;
  kind: ChannelMessageKind;
  status: ChannelMessageStatus;
  sender: ChannelSenderRef;
  body: { text: string; format: ChannelBodyFormat };
  /** Typed parts persisted as content-addressed refs inside `meta_json.parts`. */
  parts?: ChannelMessagePart[];
  threadId: ChannelMessageId | null;
  parentMessageId: ChannelMessageId | null;
  /** Number of replies whose canonical thread root is this message. */
  replyCount?: number;
  mentions?: ChannelMention[];
  source?: ChannelMessageSource;
  /**
   * Opaque row metadata surfaced to clients (#1167). System rows carry actionable
   * payloads here — e.g. an approval request `{ approvalRequestId, agentId,
   * sessionId }` the timeline renders approve/deny controls for. Additive and
   * optional: rows without meta are unaffected.
   */
  meta?: Record<string, unknown>;
  truncated?: boolean;
  clientMessageId?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface ChannelInFlightRef {
  messageId: ChannelMessageId;
  deltaIndex: number;
}

interface ChannelEventBaseV1 {
  channelId: string;
  timestamp: string;
}

export interface ChannelSnapshotEventV1 extends ChannelEventBaseV1 {
  type: 'channel-snapshot-v1';
  /** full: replace state; catchup: merge by seq/id */
  mode: 'full' | 'catchup';
  /** seq-ascending; streaming rows carry accumulated in-memory text */
  messages: ChannelMessage[];
  members: ChannelMemberRef[];
  latestSeq: number;
  inFlight: ChannelInFlightRef[];
  /** true when a full snapshot did not reach seq 1 */
  truncated: boolean;
}

export interface ChannelMessageCreatedEventV1 extends ChannelEventBaseV1 {
  type: 'channel-message-created-v1';
  /** status 'complete' (post) or 'streaming' (stream open) */
  message: ChannelMessage;
}

export interface ChannelMessageDeltaEventV1 extends ChannelEventBaseV1 {
  type: 'channel-message-delta-v1';
  messageId: ChannelMessageId;
  /** server-assigned 0,1,2,... per message, per coalesced flush */
  deltaIndex: number;
  delta: { text: string };
}

export interface ChannelMessageCompletedEventV1 extends ChannelEventBaseV1 {
  type: 'channel-message-completed-v1';
  /** authoritative full row; status complete|truncated|interrupted|failed */
  message: ChannelMessage;
}

export interface ChannelResyncRequiredEventV1 extends ChannelEventBaseV1 {
  type: 'channel-resync-required-v1';
  latestSeq: number;
}

export type ChannelEventV1 =
  | ChannelSnapshotEventV1
  | ChannelMessageCreatedEventV1
  | ChannelMessageDeltaEventV1
  | ChannelMessageCompletedEventV1
  | ChannelResyncRequiredEventV1;

// ── runtime validators ──────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const SENDER_KINDS = new Set<string>(['human', 'agent', 'system']);
const MESSAGE_KINDS = new Set<string>(['message', 'system']);
const MESSAGE_STATUSES = new Set<string>([
  'streaming',
  'complete',
  'truncated',
  'interrupted',
  'failed',
]);
const BODY_FORMATS = new Set<string>(['markdown', 'text']);
const IMAGE_MIMES = new Set<string>([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
]);

export function isChannelMessagePart(
  value: unknown
): value is ChannelMessagePart {
  return (
    isRecord(value) &&
    value.type === 'image' &&
    typeof value.id === 'string' &&
    value.id.startsWith('cha:') &&
    typeof value.mime === 'string' &&
    IMAGE_MIMES.has(value.mime) &&
    typeof value.w === 'number' &&
    Number.isSafeInteger(value.w) &&
    value.w > 0 &&
    typeof value.h === 'number' &&
    Number.isSafeInteger(value.h) &&
    value.h > 0 &&
    typeof value.bytes === 'number' &&
    Number.isSafeInteger(value.bytes) &&
    value.bytes > 0 &&
    (value.alt === undefined ||
      (typeof value.alt === 'string' &&
        value.alt.length <= CHANNEL_IMAGE_ALT_MAX_LENGTH))
  );
}

function isSenderRef(value: unknown): value is ChannelSenderRef {
  return (
    isRecord(value) &&
    typeof value.kind === 'string' &&
    SENDER_KINDS.has(value.kind) &&
    typeof value.id === 'string' &&
    (value.displayName === undefined ||
      typeof value.displayName === 'string') &&
    (value.providerId === undefined || typeof value.providerId === 'string') &&
    (value.sessionId === undefined || typeof value.sessionId === 'string')
  );
}

function isMemberRef(value: unknown): value is ChannelMemberRef {
  return (
    isRecord(value) &&
    (value.kind === 'human' || value.kind === 'agent') &&
    typeof value.id === 'string' &&
    typeof value.joinedAt === 'string'
  );
}

export function isChannelMessage(value: unknown): value is ChannelMessage {
  if (!isRecord(value)) return false;
  if (value.schemaVersion !== CHANNEL_CHAT_PROTOCOL_VERSION) return false;
  if (typeof value.id !== 'string' || !value.id.startsWith('chm:'))
    return false;
  if (typeof value.channelId !== 'string') return false;
  if (typeof value.seq !== 'number' || !Number.isFinite(value.seq))
    return false;
  if (typeof value.kind !== 'string' || !MESSAGE_KINDS.has(value.kind))
    return false;
  if (typeof value.status !== 'string' || !MESSAGE_STATUSES.has(value.status))
    return false;
  if (!isSenderRef(value.sender)) return false;
  if (
    !isRecord(value.body) ||
    typeof value.body.text !== 'string' ||
    typeof value.body.format !== 'string' ||
    !BODY_FORMATS.has(value.body.format)
  ) {
    return false;
  }
  if (
    value.parts !== undefined &&
    (!Array.isArray(value.parts) ||
      value.parts.length > CHANNEL_MESSAGE_MAX_IMAGE_PARTS ||
      !value.parts.every(isChannelMessagePart))
  ) {
    return false;
  }
  if (value.threadId !== null && typeof value.threadId !== 'string')
    return false;
  if (
    value.parentMessageId !== null &&
    typeof value.parentMessageId !== 'string'
  )
    return false;
  if (
    value.replyCount !== undefined &&
    (typeof value.replyCount !== 'number' ||
      !Number.isSafeInteger(value.replyCount) ||
      value.replyCount < 0)
  )
    return false;
  if (
    typeof value.createdAt !== 'string' ||
    typeof value.updatedAt !== 'string'
  )
    return false;
  return true;
}

function isMessageArray(value: unknown): value is ChannelMessage[] {
  return Array.isArray(value) && value.every(isChannelMessage);
}

function isInFlightArray(value: unknown): value is ChannelInFlightRef[] {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) =>
        isRecord(entry) &&
        typeof entry.messageId === 'string' &&
        typeof entry.deltaIndex === 'number'
    )
  );
}

export function isChannelEventV1(value: unknown): value is ChannelEventV1 {
  if (!isRecord(value)) return false;
  if (typeof value.type !== 'string') return false;
  if (typeof value.channelId !== 'string') return false;
  if (typeof value.timestamp !== 'string') return false;
  switch (value.type) {
    case 'channel-snapshot-v1':
      return (
        (value.mode === 'full' || value.mode === 'catchup') &&
        isMessageArray(value.messages) &&
        Array.isArray(value.members) &&
        value.members.every(isMemberRef) &&
        typeof value.latestSeq === 'number' &&
        isInFlightArray(value.inFlight) &&
        typeof value.truncated === 'boolean'
      );
    case 'channel-message-created-v1':
      return isChannelMessage(value.message);
    case 'channel-message-delta-v1':
      return (
        typeof value.messageId === 'string' &&
        typeof value.deltaIndex === 'number' &&
        isRecord(value.delta) &&
        typeof value.delta.text === 'string'
      );
    case 'channel-message-completed-v1':
      return isChannelMessage(value.message);
    case 'channel-resync-required-v1':
      return typeof value.latestSeq === 'number';
    default:
      return false;
  }
}

// ── pure reducer ────────────────────────────────────────────────────────────

export interface ChannelReducerState {
  channelId: string;
  /** seq-ordered */
  messages: ChannelMessage[];
  byId: Record<string, ChannelMessage>;
  lastSeq: number;
  /** last applied deltaIndex per streaming message */
  inFlightDelta: Record<string, number>;
  /** streams that received an out-of-order delta; drop further deltas until completed heals */
  quarantined: Record<string, true>;
  /** self-diagnosis flag: the client re-syncs via afterSeq/sinceSeq when set */
  needsCatchup: boolean;
}

export function initialChannelReducerState(
  channelId: string
): ChannelReducerState {
  return {
    channelId,
    messages: [],
    byId: {},
    lastSeq: 0,
    inFlightDelta: {},
    quarantined: {},
    needsCatchup: false,
  };
}

function sortedInsert(
  messages: ChannelMessage[],
  message: ChannelMessage
): ChannelMessage[] {
  const next = messages.filter((existing) => existing.id !== message.id);
  let index = next.findIndex((existing) => existing.seq > message.seq);
  if (index === -1) index = next.length;
  next.splice(index, 0, message);
  return next;
}

function rebuildById(
  messages: ChannelMessage[]
): Record<string, ChannelMessage> {
  const byId: Record<string, ChannelMessage> = {};
  for (const message of messages) byId[message.id] = message;
  return byId;
}

function inFlightFromRefs(
  inFlight: ChannelInFlightRef[]
): Record<string, number> {
  const map: Record<string, number> = {};
  for (const ref of inFlight) map[ref.messageId] = ref.deltaIndex;
  return map;
}

/**
 * Pure reducer for `ChannelEventV1`. It is self-diagnosing: it can never silently
 * render a corrupted timeline. On any gap or unknown-id surprise it sets
 * `needsCatchup` (drives the client to `channels.history?afterSeq=lastSeq` or a
 * reconnect with `sinceSeq=lastSeq`) instead of guessing. Deterministic under
 * replay: applying the same event stream twice yields the same state.
 */
export function applyChannelEventV1(
  state: ChannelReducerState,
  event: ChannelEventV1
): ChannelReducerState {
  switch (event.type) {
    case 'channel-snapshot-v1': {
      if (event.mode === 'full') {
        const messages = [...event.messages].sort((a, b) => a.seq - b.seq);
        return {
          channelId: state.channelId,
          messages,
          byId: rebuildById(messages),
          lastSeq: event.latestSeq,
          inFlightDelta: inFlightFromRefs(event.inFlight),
          quarantined: {},
          needsCatchup: false,
        };
      }
      // catchup: merge ascending
      let messages = state.messages;
      for (const message of [...event.messages].sort((a, b) => a.seq - b.seq)) {
        if (state.byId[message.id] || message.seq > state.lastSeq) {
          messages = sortedInsert(messages, message);
        }
      }
      return {
        ...state,
        messages,
        byId: rebuildById(messages),
        lastSeq: Math.max(state.lastSeq, event.latestSeq),
        inFlightDelta: inFlightFromRefs(event.inFlight),
        quarantined: {},
        needsCatchup: false,
      };
    }

    case 'channel-message-created-v1': {
      const message = event.message;
      if (state.byId[message.id]) return state; // idempotent replay
      if (message.seq <= state.lastSeq) return state; // idempotent replay
      if (message.seq > state.lastSeq + 1) {
        return { ...state, needsCatchup: true }; // gap — do not apply
      }
      const messages = sortedInsert(state.messages, message);
      return {
        ...state,
        messages,
        byId: rebuildById(messages),
        lastSeq: message.seq,
      };
    }

    case 'channel-message-delta-v1': {
      const existing = state.byId[event.messageId];
      if (!existing) return { ...state, needsCatchup: true };
      if (existing.status !== 'streaming') return state; // late delta after finalize
      if (state.quarantined[event.messageId]) return state; // dropped until completed heals
      const expected = (state.inFlightDelta[event.messageId] ?? -1) + 1;
      if (event.deltaIndex !== expected) {
        // out-of-order — quarantine THIS message only
        return {
          ...state,
          quarantined: { ...state.quarantined, [event.messageId]: true },
        };
      }
      const updated: ChannelMessage = {
        ...existing,
        body: { ...existing.body, text: existing.body.text + event.delta.text },
      };
      const messages = state.messages.map((message) =>
        message.id === updated.id ? updated : message
      );
      return {
        ...state,
        messages,
        byId: { ...state.byId, [updated.id]: updated },
        inFlightDelta: {
          ...state.inFlightDelta,
          [event.messageId]: event.deltaIndex,
        },
      };
    }

    case 'channel-message-completed-v1': {
      const message = event.message;
      if (!state.byId[message.id]) return { ...state, needsCatchup: true };
      const messages = state.messages.map((existing) =>
        existing.id === message.id ? message : existing
      );
      const inFlightDelta = { ...state.inFlightDelta };
      delete inFlightDelta[message.id];
      const quarantined = { ...state.quarantined };
      delete quarantined[message.id];
      return {
        ...state,
        messages,
        byId: { ...state.byId, [message.id]: message },
        inFlightDelta,
        quarantined,
      };
    }

    case 'channel-resync-required-v1':
      return { ...state, needsCatchup: true };

    default:
      return state;
  }
}

/**
 * Merge a page of history (`channels.history` REST response) into an existing
 * reducer state. Pure + additive: dedupes by id via `sortedInsert` (so a
 * re-merge of overlapping pages is idempotent), keeps `messages` seq-ascending,
 * and never lowers `lastSeq` (older pages carry lower seqs; `lastSeq` stays the
 * max). Used by the reverse-infinite-scroll `loadOlder()` path in
 * `useChannelChatSocket`, which reads history via REST rather than the socket.
 */
export function mergeHistoryPage(
  state: ChannelReducerState,
  page: ChannelMessage[]
): ChannelReducerState {
  if (page.length === 0) return state;
  let messages = state.messages;
  for (const message of [...page].sort((a, b) => a.seq - b.seq)) {
    messages = sortedInsert(messages, message);
  }
  const highestSeq = messages.length
    ? messages[messages.length - 1]!.seq
    : state.lastSeq;
  return {
    ...state,
    messages,
    byId: rebuildById(messages),
    lastSeq: Math.max(state.lastSeq, highestSeq),
  };
}

// ── mention parser (stored, not routed in slice 2) ──────────────────────────

/**
 * Extract `@mention` tokens from message text, skipping code fences, inline code,
 * and email-like `local@domain` spans. Returns both the raw token and, when the
 * name matches a known framework provider id (case-insensitive), the resolved
 * `providerId`. Both are persisted so alias policy (`@Claude` vs `@claude`,
 * custom providers) can change later without a data migration. #1167 inherits
 * this hardened tokenizer.
 */
export function parseMentions(
  text: string,
  knownProviderIds: readonly string[] = []
): ChannelMention[] {
  const known = new Map<string, string>();
  for (const id of knownProviderIds) known.set(id.toLowerCase(), id);

  const masked = maskCodeSpans(text);
  const mentionPattern = /(^|[^A-Za-z0-9_.])@([A-Za-z][A-Za-z0-9_-]*)/g;
  const seen = new Set<string>();
  const mentions: ChannelMention[] = [];
  let match: RegExpExecArray | null;
  while ((match = mentionPattern.exec(masked)) !== null) {
    const name = match[2];
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const providerId = known.get(key);
    mentions.push({
      raw: `@${name}`,
      ...(providerId ? { providerId } : {}),
    });
  }
  return mentions;
}

/** Replace fenced + inline code spans with equal-length spaces so mention offsets stay aligned. */
function maskCodeSpans(text: string): string {
  const maskRun = (source: string, pattern: RegExp): string =>
    source.replace(pattern, (span) => ' '.repeat(span.length));
  let masked = maskRun(text, /```[\s\S]*?```/g);
  masked = maskRun(masked, /`[^`]*`/g);
  return masked;
}
