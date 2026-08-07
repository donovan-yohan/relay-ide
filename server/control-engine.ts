import * as crypto from 'node:crypto';
import type { Session } from './types.js';
import {
  DEFAULT_LOCAL_NODE_ID,
  createGlobalSessionId,
} from '../shared/identity.js';
import {
  LEGACY_CONTROL_ACTOR,
  normalizeControlStateSummary,
  type ControlActor,
  type ControlMode,
  type ControlStateSummary,
  type InterventionKind,
  type InterventionRecord,
  type InterventionRedactionMetadata,
  type InterventionSource,
  type TabControlEvent,
  type TabControlIdentity,
} from '../shared/control-state.js';
import { appendIntervention } from './intervention-log.js';

export type SupervisorInterventionAction = 'sendText' | 'sendKey' | 'submit';

export interface ControlEngineOptions {
  inputDebounceMs?: number;
  autoRevertMs?: number;
  now?: () => Date;
  idFactory?: () => string;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
  emitEvent?: (event: TabControlEvent) => void;
  append?: (record: InterventionRecord) => void;
}

export interface InterventionSessionScope {
  sessionId: string;
  nodeId?: string;
  globalSessionId?: string;
}

interface PendingBurst {
  session: Session;
  chunks: string[];
  record: InterventionRecord;
  timer: ReturnType<typeof setTimeout>;
}

const DEFAULT_INPUT_DEBOUNCE_MS = 750;
const MAX_PREVIEW_CHARS = 96;
const pendingBursts = new Map<string, PendingBurst>();

const LOCAL_HUMAN_ACTOR: ControlActor = { ...LEGACY_CONTROL_ACTOR };

function nowIso(options?: ControlEngineOptions): string {
  return (options?.now?.() ?? new Date()).toISOString();
}

function nextId(options?: ControlEngineOptions): string {
  return options?.idFactory?.() ?? crypto.randomUUID();
}

function sha256(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

function countLines(input: string): number {
  if (input.length === 0) return 0;
  return input.split(/\r\n|\r|\n/).length;
}

function isUnsafeControlCode(code: number): boolean {
  return (
    code === 0x1b ||
    code === 0x7f ||
    (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d)
  );
}

function hasUnsafeControlSequence(input: string): boolean {
  return Array.from(input).some((char) =>
    isUnsafeControlCode(char.charCodeAt(0))
  );
}

function hasSecretLikeContent(input: string): boolean {
  return /(?:password|passwd|secret|token|api[_-]?key|authorization|bearer\s+[a-z0-9._~+/=-]{12,}|gh[pousr]_[a-z0-9_]{20,}|sk-[a-z0-9_-]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|[a-z0-9+/]{48,}={0,2})/i.test(
    input
  );
}

function printablePreview(input: string): string {
  return Array.from(input)
    .map((char) => {
      const code = char.charCodeAt(0);
      if (char === '\r') return '\\r';
      if (char === '\n') return '\\n';
      if (char === '\t') return '\\t';
      return isUnsafeControlCode(code) ? '�' : char;
    })
    .join('')
    .slice(0, MAX_PREVIEW_CHARS);
}

export function redactInterventionPayload(input: string): {
  payloadPreview?: string;
  redaction: InterventionRedactionMetadata;
} {
  const classes: string[] = [];
  const controlSequence = hasUnsafeControlSequence(input);
  const secretLike = hasSecretLikeContent(input);
  const multiline = /\r|\n/.test(input);
  const longPaste = input.length > MAX_PREVIEW_CHARS;

  if (controlSequence) classes.push('control-sequence');
  if (secretLike) classes.push('secret-like');
  if (multiline || longPaste) classes.push('paste');
  if (classes.length === 0) classes.push('plain-text');

  const redacted = controlSequence || secretLike;
  const redaction: InterventionRedactionMetadata = {
    redacted,
    byteCount: Buffer.byteLength(input),
    charCount: Array.from(input).length,
    lineCount: countLines(input),
    hashSha256: sha256(input),
    classes,
  };

  if (redacted) {
    return {
      payloadPreview: `[redacted:${classes.join(',')}] bytes=${redaction.byteCount} sha256=${redaction.hashSha256.slice(0, 12)}`,
      redaction,
    };
  }

  return { payloadPreview: printablePreview(input), redaction };
}

function humanActor(session: Session): ControlActor {
  return {
    ...LOCAL_HUMAN_ACTOR,
    nodeId: session.nodeId ?? DEFAULT_LOCAL_NODE_ID,
    sessionId: session.id,
  };
}

export function identityForSession(session: Session): TabControlIdentity {
  const nodeId = session.nodeId ?? DEFAULT_LOCAL_NODE_ID;
  return {
    nodeId,
    sessionId: session.id,
    globalSessionId: createGlobalSessionId(nodeId, session.id),
    cwd: session.cwd,
    ...(session.repoPath ? { repoPath: session.repoPath } : {}),
    ...(session.worktreePath !== undefined
      ? { worktreePath: session.worktreePath }
      : {}),
    ...(session.repoName ? { repoName: session.repoName } : {}),
    ...(session.branchName ? { branchName: session.branchName } : {}),
  };
}

function scopeForSession(session: Session): InterventionSessionScope {
  const identity = identityForSession(session);
  return {
    sessionId: identity.sessionId,
    nodeId: identity.nodeId,
    ...(identity.globalSessionId
      ? { globalSessionId: identity.globalSessionId }
      : {}),
  };
}

function pendingBurstKey(session: Session): string {
  const scope = scopeForSession(session);
  return (
    scope.globalSessionId ??
    `${scope.nodeId ?? DEFAULT_LOCAL_NODE_ID}:${scope.sessionId}`
  );
}

function buildRecord(input: {
  session: Session;
  actor: ControlActor;
  source: InterventionSource;
  kind: InterventionKind;
  payload?: string;
  modeBefore: ControlMode;
  modeAfter?: ControlMode;
  options?: ControlEngineOptions;
  acked?: boolean;
  includePayloadPreview?: boolean;
}): InterventionRecord {
  const identity = identityForSession(input.session);
  const payload = input.payload ?? '';
  const redacted = redactInterventionPayload(payload);
  const timestamp = nowIso(input.options);
  const record: InterventionRecord = {
    id: nextId(input.options),
    sessionId: identity.sessionId,
    tabId: identity.globalSessionId ?? identity.sessionId,
    nodeId: identity.nodeId,
    ...(identity.globalSessionId
      ? { globalSessionId: identity.globalSessionId }
      : {}),
    cwd: identity.cwd,
    timestamp,
    author: input.actor,
    source: input.source,
    kind: input.kind,
    redaction: redacted.redaction,
    modeBefore: input.modeBefore,
    ...(input.modeAfter ? { modeAfter: input.modeAfter } : {}),
    ...(input.includePayloadPreview !== false && redacted.payloadPreview
      ? { payloadPreview: redacted.payloadPreview }
      : {}),
  };
  if (input.acked) {
    record.ackedBy = input.actor;
    record.ackedAt = timestamp;
  }
  return record;
}

function eventControlStateFields(
  session: Session
): Pick<ControlStateSummary, 'activeActors'> {
  const summary = normalizeControlStateSummary(session.controlState);
  return {
    activeActors: summary.activeActors,
  };
}

function updateControlState(input: {
  session: Session;
  actor: ControlActor;
  eventId: string;
  occurredAt: string;
  reason: string;
}): ControlStateSummary {
  const next: ControlStateSummary = {
    controlMode: 'human-driven',
    activeActors: [humanActor(input.session)],
    lastInterventionAt: input.occurredAt,
    lastInterventionBy: input.actor,
    lastInterventionEventId: input.eventId,
    controlFreshness: 'fresh',
    controlReason: input.reason,
  };
  input.session.controlState = next;
  return next;
}

function emitIntervention(
  session: Session,
  actor: ControlActor,
  controlMode: ControlMode,
  record: InterventionRecord,
  reason: string,
  options?: ControlEngineOptions
): TabControlEvent {
  const event: TabControlEvent = {
    eventId: record.id,
    type: 'tab.intervention',
    occurredAt: record.timestamp,
    identity: identityForSession(session),
    actor,
    ...eventControlStateFields(session),
    reason,
    controlMode,
    intervention: record,
  };
  options?.emitEvent?.(event);
  return event;
}

function flushBurst(key: string, options?: ControlEngineOptions): void {
  const pending = pendingBursts.get(key);
  if (!pending) return;
  pendingBursts.delete(key);
  const clear = options?.clearTimeoutFn ?? clearTimeout;
  clear(pending.timer);

  const payload = pending.chunks.join('');
  const redacted = redactInterventionPayload(payload);
  if (redacted.payloadPreview) {
    pending.record.payloadPreview = redacted.payloadPreview;
  } else {
    delete pending.record.payloadPreview;
  }
  pending.record.redaction = redacted.redaction;
  pending.record.timestamp = nowIso(options);
  const append = options?.append ?? appendIntervention;
  append(pending.record);
  updateControlState({
    session: pending.session,
    actor: pending.record.author,
    eventId: pending.record.id,
    occurredAt: pending.record.timestamp,
    reason: 'human input',
  });
  emitIntervention(
    pending.session,
    pending.record.author,
    'human-driven',
    pending.record,
    'human input',
    options
  );
}

function flushBurstForSession(
  session: Session,
  options?: ControlEngineOptions
): void {
  flushBurst(pendingBurstKey(session), options);
}

export function recordHumanPtyInput(
  session: Session,
  data: string,
  options: ControlEngineOptions = {}
): void {
  if (session.mode !== 'pty' || data.length === 0) return;
  const key = pendingBurstKey(session);
  const existing = pendingBursts.get(key);
  if (existing) {
    existing.chunks.push(data);
    updateControlState({
      session: existing.session,
      actor: existing.record.author,
      eventId: existing.record.id,
      occurredAt: nowIso(options),
      reason: 'human input',
    });
    const clear = options.clearTimeoutFn ?? clearTimeout;
    const set = options.setTimeoutFn ?? setTimeout;
    clear(existing.timer);
    existing.timer = set(
      () => flushBurst(key, options),
      options.inputDebounceMs ?? DEFAULT_INPUT_DEBOUNCE_MS
    );
    return;
  }

  const before = normalizeControlStateSummary(session.controlState);
  const actor = humanActor(session);
  const record = buildRecord({
    session,
    actor,
    source: 'pty-input',
    kind: 'human-input',
    payload: data,
    modeBefore: before.controlMode,
    modeAfter: 'human-driven',
    options,
  });
  updateControlState({
    session,
    actor,
    eventId: record.id,
    occurredAt: record.timestamp,
    reason: 'human input',
  });
  const set = options.setTimeoutFn ?? setTimeout;
  pendingBursts.set(key, {
    session,
    chunks: [data],
    record,
    timer: set(
      () => flushBurst(key, options),
      options.inputDebounceMs ?? DEFAULT_INPUT_DEBOUNCE_MS
    ),
  });
}

export function recordSupervisorAction(
  session: Session,
  input: {
    action: SupervisorInterventionAction;
    actor: ControlActor;
    payload: string;
  },
  options: ControlEngineOptions = {}
): TabControlEvent {
  flushBurstForSession(session, options);
  const before = normalizeControlStateSummary(session.controlState);
  const record = buildRecord({
    session,
    actor: input.actor,
    source: 'supervisor-action',
    kind:
      input.action === 'sendText'
        ? 'supervisor-send-text'
        : input.action === 'sendKey'
          ? 'supervisor-send-key'
          : 'supervisor-submit',
    payload: input.payload,
    modeBefore: before.controlMode,
    modeAfter: 'human-driven',
    options,
    acked: true,
    includePayloadPreview: false,
  });
  const append = options.append ?? appendIntervention;
  append(record);
  updateControlState({
    session,
    actor: input.actor,
    eventId: record.id,
    occurredAt: record.timestamp,
    reason: `supervisor ${input.action}`,
  });
  return emitIntervention(
    session,
    input.actor,
    'human-driven',
    record,
    `supervisor ${input.action}`,
    options
  );
}

export function clearPendingControlBurstsForTests(): void {
  for (const pending of Array.from(pendingBursts.values()))
    clearTimeout(pending.timer);
  pendingBursts.clear();
}
