import type {
  ArtifactKind,
  TaskRefKind,
  WorkContextActorKind,
  WorkContextId,
} from './work-context.js';

export const WORK_CONTEXT_MESSAGE_SCHEMA_VERSION = 1 as const;
export const WORK_CONTEXT_MESSAGE_PAYLOAD_MAX_BYTES = 256 * 1024;
export const WORK_CONTEXT_MESSAGE_SUMMARY_MAX_CHARS = 2000;

export const CORE_WORK_CONTEXT_MESSAGE_KINDS = [
  'handoff',
  'question',
  'status',
  'evidence',
  'decision',
  'artifact',
  'custom',
] as const;

export const WORK_CONTEXT_MESSAGE_VISIBILITIES = [
  'private',
  'internal',
  'public',
] as const;

export type CoreWorkContextMessageKind = (typeof CORE_WORK_CONTEXT_MESSAGE_KINDS)[number];
export type WorkContextMessageKind = CoreWorkContextMessageKind | (string & {});
export type WorkContextMessageId = `wcm:${string}`;
export type WorkContextMessageVisibility = (typeof WORK_CONTEXT_MESSAGE_VISIBILITIES)[number];
export type WorkContextMessagePayloadEncoding = 'json' | 'markdown' | 'text' | 'artifact-ref';

export interface WorkContextMessageActor {
  kind: WorkContextActorKind;
  id: string;
  displayName?: string;
  providerId?: string;
  nodeId?: string;
  sessionId?: string;
}

export interface WorkContextMessageAudience {
  kind: 'actor' | 'role' | 'session' | 'work-context' | 'broadcast' | 'custom';
  id?: string;
  displayName?: string;
}

export interface WorkContextMessageTaskRef {
  kind: TaskRefKind | (string & {});
  id: string;
  title?: string;
  url?: string;
}

export interface WorkContextMessageSessionRef {
  nodeId?: string;
  sessionId?: string;
  globalSessionId?: string;
}

export interface WorkContextMessageArtifactRef {
  id: string;
  kind?: ArtifactKind | (string & {});
  uri?: string;
  title?: string;
}

export interface WorkContextMessageExternalRef {
  kind: string;
  id: string;
  url?: string;
  label?: string;
}

export interface WorkContextMessageRepoRef {
  ownerRepo?: string;
  remoteUrl?: string;
  localPath?: string;
  branchName?: string;
  headSha?: string;
  baseRef?: string;
}

export interface WorkContextMessageRefs {
  repo?: WorkContextMessageRepoRef;
  taskRefs?: WorkContextMessageTaskRef[];
  sessions?: WorkContextMessageSessionRef[];
  artifacts?: WorkContextMessageArtifactRef[];
  workflowRunIds?: string[];
  parentMessageId?: WorkContextMessageId;
  replyToMessageId?: WorkContextMessageId;
  threadId?: WorkContextMessageId;
  external?: WorkContextMessageExternalRef[];
}

export interface WorkContextMessagePayload {
  mediaType: string;
  encoding: WorkContextMessagePayloadEncoding;
  body?: unknown;
  artifactRefs?: WorkContextMessageArtifactRef[];
  sha256?: string;
  byteCount?: number;
}

export interface WorkContextMessageRedactionMetadata {
  rawPayloadStored: boolean;
  payloadBytes: number;
  truncated: false;
  omittedKeys: string[];
}

export interface WorkContextMessageEnvelope {
  schemaVersion: typeof WORK_CONTEXT_MESSAGE_SCHEMA_VERSION;
  id: WorkContextMessageId;
  workContextId: WorkContextId;
  kind: WorkContextMessageKind;
  sender: WorkContextMessageActor;
  audience: WorkContextMessageAudience[];
  summary: string;
  refs: WorkContextMessageRefs;
  payloadSchema?: string;
  payload: WorkContextMessagePayload;
  visibility: WorkContextMessageVisibility;
  createdAt: string;
  updatedAt: string;
  redaction: WorkContextMessageRedactionMetadata;
}

export interface WorkContextMessageCreateInput {
  workContextId: WorkContextId;
  kind: WorkContextMessageKind;
  sender: WorkContextMessageActor;
  audience?: WorkContextMessageAudience[];
  summary: string;
  refs?: WorkContextMessageRefs;
  parentMessageId?: WorkContextMessageId;
  replyToMessageId?: WorkContextMessageId;
  payloadSchema?: string;
  payload?: WorkContextMessagePayload;
  visibility?: WorkContextMessageVisibility;
}

export interface WorkContextMessageListFilter {
  workContextId?: WorkContextId;
  kind?: string;
  senderId?: string;
  audienceKind?: string;
  audienceId?: string;
  payloadSchema?: string;
  threadId?: WorkContextMessageId;
  parentMessageId?: WorkContextMessageId;
  refKind?: string;
  refValue?: string;
  limit?: number;
}

export class WorkContextMessageValidationError extends Error {
  constructor(
    message: string,
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'WorkContextMessageValidationError';
  }
}

const ACTOR_KINDS = new Set(['human', 'agent', 'system', 'service', 'node']);
const AUDIENCE_KINDS = new Set(['actor', 'role', 'session', 'work-context', 'broadcast', 'custom']);
const VISIBILITIES = new Set<string>(WORK_CONTEXT_MESSAGE_VISIBILITIES);
const PAYLOAD_ENCODINGS = new Set(['json', 'markdown', 'text', 'artifact-ref']);
const FORBIDDEN_PAYLOAD_KEYS = new Set([
  '__proto__',
  'constructor',
  'prototype',
  'rawpayload',
  'rawtranscript',
  'providerprivatestate',
  'secret',
  'secrets',
  'token',
  'accesstoken',
  'refreshtoken',
  'password',
  'credential',
  'credentials',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function requiredString(value: unknown, field: string): string {
  const parsed = stringField(value);
  if (!parsed) throw new WorkContextMessageValidationError(`${field} is required`, { field });
  return parsed;
}

function optionalString(value: unknown): string | undefined {
  return stringField(value);
}

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9_]/g, '');
}

function parseSender(value: unknown): WorkContextMessageActor {
  if (!isRecord(value)) {
    throw new WorkContextMessageValidationError('sender is required', { field: 'sender' });
  }
  const kind = requiredString(value['kind'], 'sender.kind');
  if (!ACTOR_KINDS.has(kind)) {
    throw new WorkContextMessageValidationError('sender.kind is invalid', {
      field: 'sender.kind',
      allowed: Array.from(ACTOR_KINDS),
    });
  }
  const sender: WorkContextMessageActor = {
    kind: kind as WorkContextActorKind,
    id: requiredString(value['id'], 'sender.id'),
  };
  for (const [key, parsed] of [
    ['displayName', optionalString(value['displayName'])],
    ['providerId', optionalString(value['providerId'])],
    ['nodeId', optionalString(value['nodeId'])],
    ['sessionId', optionalString(value['sessionId'])],
  ] as const) {
    if (parsed) sender[key] = parsed;
  }
  return sender;
}

function parseAudienceEntry(value: unknown): WorkContextMessageAudience {
  if (!isRecord(value)) {
    throw new WorkContextMessageValidationError('audience entries must be objects', {
      field: 'audience',
    });
  }
  const kind = requiredString(value['kind'], 'audience.kind');
  if (!AUDIENCE_KINDS.has(kind)) {
    throw new WorkContextMessageValidationError('audience.kind is invalid', {
      field: 'audience.kind',
      allowed: Array.from(AUDIENCE_KINDS),
    });
  }
  const audience: WorkContextMessageAudience = {
    kind: kind as WorkContextMessageAudience['kind'],
  };
  const id = optionalString(value['id']);
  const displayName = optionalString(value['displayName']);
  if (id) audience.id = id;
  if (displayName) audience.displayName = displayName;
  return audience;
}

function parseAudience(value: unknown): WorkContextMessageAudience[] {
  if (value === undefined) return [{ kind: 'work-context' }];
  if (!Array.isArray(value)) {
    throw new WorkContextMessageValidationError('audience must be an array', { field: 'audience' });
  }
  return value.map(parseAudienceEntry);
}

function parseTaskRef(value: unknown): WorkContextMessageTaskRef {
  if (!isRecord(value)) throw new WorkContextMessageValidationError('taskRefs entries must be objects');
  const ref: WorkContextMessageTaskRef = {
    kind: requiredString(value['kind'], 'taskRefs.kind'),
    id: requiredString(value['id'], 'taskRefs.id'),
  };
  const title = optionalString(value['title']);
  const url = optionalString(value['url']);
  if (title) ref.title = title;
  if (url) ref.url = url;
  return ref;
}

function parseRefs(value: unknown, parentMessageId?: string, replyToMessageId?: string): WorkContextMessageRefs {
  const source = isRecord(value) ? value : {};
  const refs: WorkContextMessageRefs = {};
  if (isRecord(source['repo'])) {
    const repo: WorkContextMessageRepoRef = {};
    for (const key of ['ownerRepo', 'remoteUrl', 'localPath', 'branchName', 'headSha', 'baseRef'] as const) {
      const parsed = optionalString(source['repo'][key]);
      if (parsed) repo[key] = parsed;
    }
    if (Object.keys(repo).length > 0) refs.repo = repo;
  }
  if (Array.isArray(source['taskRefs'])) refs.taskRefs = source['taskRefs'].map(parseTaskRef);
  if (Array.isArray(source['sessions'])) {
    refs.sessions = source['sessions'].flatMap((entry) => {
      if (!isRecord(entry)) return [];
      const ref: WorkContextMessageSessionRef = {};
      for (const key of ['nodeId', 'sessionId', 'globalSessionId'] as const) {
        const parsed = optionalString(entry[key]);
        if (parsed) ref[key] = parsed;
      }
      return Object.keys(ref).length ? [ref] : [];
    });
  }
  if (Array.isArray(source['artifacts'])) {
    refs.artifacts = source['artifacts'].flatMap((entry) => {
      if (!isRecord(entry)) return [];
      const id = optionalString(entry['id']);
      if (!id) return [];
      const ref: WorkContextMessageArtifactRef = { id };
      for (const key of ['kind', 'uri', 'title'] as const) {
        const parsed = optionalString(entry[key]);
        if (parsed) ref[key] = parsed;
      }
      return [ref];
    });
  }
  if (Array.isArray(source['workflowRunIds'])) {
    refs.workflowRunIds = source['workflowRunIds'].flatMap((entry) => {
      const parsed = optionalString(entry);
      return parsed ? [parsed] : [];
    });
  }
  if (Array.isArray(source['external'])) {
    refs.external = source['external'].flatMap((entry) => {
      if (!isRecord(entry)) return [];
      const kind = optionalString(entry['kind']);
      const id = optionalString(entry['id']);
      if (!kind || !id) return [];
      const ref: WorkContextMessageExternalRef = { kind, id };
      const url = optionalString(entry['url']);
      const label = optionalString(entry['label']);
      if (url) ref.url = url;
      if (label) ref.label = label;
      return [ref];
    });
  }
  const parent = optionalString(parentMessageId) ?? optionalString(source['parentMessageId']);
  const replyTo = optionalString(replyToMessageId) ?? optionalString(source['replyToMessageId']);
  const thread = optionalString(source['threadId']);
  if (parent) refs.parentMessageId = parent as WorkContextMessageId;
  if (replyTo) refs.replyToMessageId = replyTo as WorkContextMessageId;
  if (thread) refs.threadId = thread as WorkContextMessageId;
  return refs;
}

function sanitizePayloadValue(value: unknown, path: string, omitted: string[]): unknown {
  if (Array.isArray(value)) return value.map((entry, index) => sanitizePayloadValue(entry, `${path}[${index}]`, omitted));
  if (!isRecord(value)) return value;
  const cleaned: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_PAYLOAD_KEYS.has(normalizeKey(key))) {
      omitted.push(path ? `${path}.${key}` : key);
      continue;
    }
    cleaned[key] = sanitizePayloadValue(child, path ? `${path}.${key}` : key, omitted);
  }
  return cleaned;
}

function parsePayload(value: unknown): { payload: WorkContextMessagePayload; redaction: WorkContextMessageRedactionMetadata } {
  const source = isRecord(value) ? value : {};
  const mediaType = optionalString(source['mediaType']) ?? 'application/json';
  const encoding = optionalString(source['encoding']) ?? (mediaType === 'text/markdown' ? 'markdown' : 'json');
  if (!PAYLOAD_ENCODINGS.has(encoding)) {
    throw new WorkContextMessageValidationError('payload.encoding is invalid', {
      field: 'payload.encoding',
      allowed: Array.from(PAYLOAD_ENCODINGS),
    });
  }
  const omittedKeys: string[] = [];
  const payload: WorkContextMessagePayload = {
    mediaType,
    encoding: encoding as WorkContextMessagePayloadEncoding,
  };
  if (Object.prototype.hasOwnProperty.call(source, 'body')) {
    payload.body = sanitizePayloadValue(source['body'], 'payload.body', omittedKeys);
  }
  if (Array.isArray(source['artifactRefs'])) {
    payload.artifactRefs = source['artifactRefs'].flatMap((entry) => {
      if (!isRecord(entry)) return [];
      const id = optionalString(entry['id']);
      if (!id) return [];
      const ref: WorkContextMessageArtifactRef = { id };
      for (const key of ['kind', 'uri', 'title'] as const) {
        const parsed = optionalString(entry[key]);
        if (parsed) ref[key] = parsed;
      }
      return [ref];
    });
  }
  const sha256 = optionalString(source['sha256']);
  if (sha256) payload.sha256 = sha256;
  const payloadBytes = Buffer.byteLength(JSON.stringify(payload), 'utf8');
  if (payloadBytes > WORK_CONTEXT_MESSAGE_PAYLOAD_MAX_BYTES) {
    throw new WorkContextMessageValidationError('message payload is too large; store large bodies as artifacts and reference them', {
      field: 'payload',
      payloadBytes,
      maxBytes: WORK_CONTEXT_MESSAGE_PAYLOAD_MAX_BYTES,
    });
  }
  payload.byteCount = payloadBytes;
  return {
    payload,
    redaction: {
      rawPayloadStored: true,
      payloadBytes,
      truncated: false,
      omittedKeys,
    },
  };
}

export function parseWorkContextMessageCreateInput(raw: unknown): WorkContextMessageCreateInput {
  if (!isRecord(raw)) {
    throw new WorkContextMessageValidationError('message input must be an object');
  }
  const summary = requiredString(raw['summary'], 'summary');
  if (summary.length > WORK_CONTEXT_MESSAGE_SUMMARY_MAX_CHARS) {
    throw new WorkContextMessageValidationError('summary is too long', {
      field: 'summary',
      maxChars: WORK_CONTEXT_MESSAGE_SUMMARY_MAX_CHARS,
    });
  }
  const visibility = optionalString(raw['visibility']) ?? 'internal';
  if (!VISIBILITIES.has(visibility)) {
    throw new WorkContextMessageValidationError('visibility is invalid', {
      field: 'visibility',
      allowed: Array.from(VISIBILITIES),
    });
  }
  const input: WorkContextMessageCreateInput = {
    workContextId: requiredString(raw['workContextId'], 'workContextId'),
    kind: requiredString(raw['kind'], 'kind'),
    sender: parseSender(raw['sender']),
    audience: parseAudience(raw['audience']),
    summary,
    refs: parseRefs(raw['refs'], optionalString(raw['parentMessageId']), optionalString(raw['replyToMessageId'])),
    payload: parsePayload(raw['payload']).payload,
    visibility: visibility as WorkContextMessageVisibility,
  };
  const payloadSchema = optionalString(raw['payloadSchema']);
  if (payloadSchema) input.payloadSchema = payloadSchema;
  return input;
}

export function parseWorkContextMessageEnvelope(raw: unknown): WorkContextMessageEnvelope {
  if (!isRecord(raw)) {
    throw new WorkContextMessageValidationError('stored message envelope must be an object');
  }
  const schemaVersion = raw['schemaVersion'];
  if (schemaVersion !== WORK_CONTEXT_MESSAGE_SCHEMA_VERSION) {
    throw new WorkContextMessageValidationError('unsupported message schema version', {
      schemaVersion,
      supported: WORK_CONTEXT_MESSAGE_SCHEMA_VERSION,
    });
  }
  const parsed = parseWorkContextMessageCreateInput(raw);
  const createdAt = requiredString(raw['createdAt'], 'createdAt');
  const updatedAt = requiredString(raw['updatedAt'], 'updatedAt');
  const redaction = isRecord(raw['redaction']) ? raw['redaction'] : {};
  return {
    schemaVersion: WORK_CONTEXT_MESSAGE_SCHEMA_VERSION,
    id: requiredString(raw['id'], 'id') as WorkContextMessageId,
    workContextId: parsed.workContextId,
    kind: parsed.kind,
    sender: parsed.sender,
    audience: parsed.audience ?? [{ kind: 'work-context' }],
    summary: parsed.summary,
    refs: parsed.refs ?? {},
    ...(parsed.payloadSchema ? { payloadSchema: parsed.payloadSchema } : {}),
    payload: parsed.payload as WorkContextMessagePayload,
    visibility: parsed.visibility ?? 'internal',
    createdAt,
    updatedAt,
    redaction: {
      rawPayloadStored: redaction['rawPayloadStored'] !== false,
      payloadBytes: typeof redaction['payloadBytes'] === 'number' ? redaction['payloadBytes'] : 0,
      truncated: false,
      omittedKeys: Array.isArray(redaction['omittedKeys'])
        ? redaction['omittedKeys'].flatMap((entry) => (typeof entry === 'string' ? [entry] : []))
        : [],
    },
  };
}

export function normalizeWorkContextMessageCreateInput(
  raw: unknown
): WorkContextMessageCreateInput & { redaction: WorkContextMessageRedactionMetadata } {
  if (!isRecord(raw)) throw new WorkContextMessageValidationError('message input must be an object');
  const payloadResult = parsePayload(raw['payload']);
  const input = parseWorkContextMessageCreateInput({ ...raw, payload: payloadResult.payload });
  return { ...input, redaction: payloadResult.redaction };
}
