import * as crypto from 'node:crypto';
import type { Session } from './types.js';
import {
  DEFAULT_LOCAL_NODE_ID,
  createGlobalSessionId,
} from '../shared/identity.js';
import {
  LEGACY_CONTROL_ACTOR,
  normalizeControlActors,
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
import {
  ackSessionHumanInput,
  appendIntervention,
  hasUnackedHumanInput,
} from './intervention-log.js';

export type ControlModeAction = 'join' | 'take-over' | 'hand-back';

export interface ControlEngineOptions {
  inputDebounceMs?: number;
  autoRevertMs?: number;
  now?: () => Date;
  idFactory?: () => string;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
  emitEvent?: (event: TabControlEvent) => void;
  append?: (record: InterventionRecord) => void;
  hasUnacked?: (sessionId: string) => boolean;
  ackHumanInput?: (input: {
    sessionId: string;
    actor: ControlActor;
    ackedAt?: string;
  }) => number;
}

export interface AutoRevertResult {
  reverted: boolean;
  reason?:
    | 'not-co-driven'
    | 'not-fresh'
    | 'node-disconnected'
    | 'unacked-human-input'
    | 'not-idle-long-enough';
  event?: TabControlEvent;
}

interface PendingBurst {
  session: Session;
  chunks: string[];
  record: InterventionRecord;
  timer: ReturnType<typeof setTimeout>;
}

const DEFAULT_INPUT_DEBOUNCE_MS = 750;
const DEFAULT_AUTO_REVERT_MS = 5 * 60 * 1000;
const MAX_PREVIEW_CHARS = 96;
const pendingBursts = new Map<string, PendingBurst>();

const SYSTEM_ACTOR: ControlActor = {
  kind: 'system',
  id: 'relay-control-engine',
  displayName: 'Relay control engine',
};

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
  return code === 0x1b || code === 0x7f || (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d);
}

function hasUnsafeControlSequence(input: string): boolean {
  return Array.from(input).some((char) => isUnsafeControlCode(char.charCodeAt(0)));
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

function agentActor(session: Session): ControlActor {
  return {
    kind: 'agent',
    id: session.agent,
    displayName: session.agent,
    nodeId: session.nodeId ?? DEFAULT_LOCAL_NODE_ID,
    sessionId: session.id,
  };
}

function humanActor(session: Session): ControlActor {
  return {
    ...LOCAL_HUMAN_ACTOR,
    nodeId: session.nodeId ?? DEFAULT_LOCAL_NODE_ID,
    sessionId: session.id,
  };
}

function actorsForMode(
  session: Session,
  mode: ControlMode,
  actor: ControlActor
): ControlActor[] {
  if (mode === 'agent-driven') return [agentActor(session)];
  if (mode === 'human-driven') return [actor];
  return normalizeControlActors([actor, agentActor(session)]);
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
    ...(identity.globalSessionId ? { globalSessionId: identity.globalSessionId } : {}),
    cwd: identity.cwd,
    timestamp,
    author: input.actor,
    source: input.source,
    kind: input.kind,
    redaction: redacted.redaction,
    modeBefore: input.modeBefore,
    ...(input.modeAfter ? { modeAfter: input.modeAfter } : {}),
    ...(redacted.payloadPreview ? { payloadPreview: redacted.payloadPreview } : {}),
  };
  if (input.acked) {
    record.ackedBy = input.actor;
    record.ackedAt = timestamp;
  }
  return record;
}

function updateControlState(input: {
  session: Session;
  controlMode: ControlMode;
  actor: ControlActor;
  eventId: string;
  occurredAt: string;
  reason: string;
}): ControlStateSummary {
  const next: ControlStateSummary = {
    controlMode: input.controlMode,
    activeActors: actorsForMode(input.session, input.controlMode, input.actor),
    ...(input.controlMode === 'human-driven'
      ? {}
      : { activeWorker: agentActor(input.session) }),
    lastInterventionAt: input.occurredAt,
    lastInterventionBy: input.actor,
    lastInterventionEventId: input.eventId,
    controlFreshness: 'fresh',
    controlReason: input.reason,
  };
  input.session.controlState = next;
  return next;
}

function emitModeChanged(
  session: Session,
  actor: ControlActor,
  previousControlMode: ControlMode,
  controlMode: ControlMode,
  reason: string,
  options?: ControlEngineOptions
): TabControlEvent {
  const event: TabControlEvent = {
    eventId: nextId(options),
    type: 'tab.mode-changed',
    occurredAt: nowIso(options),
    identity: identityForSession(session),
    actor,
    reason,
    previousControlMode,
    controlMode,
  };
  options?.emitEvent?.(event);
  return event;
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
    reason,
    controlMode,
    intervention: record,
  };
  options?.emitEvent?.(event);
  return event;
}

function flushBurst(sessionId: string, options?: ControlEngineOptions): void {
  const pending = pendingBursts.get(sessionId);
  if (!pending) return;
  pendingBursts.delete(sessionId);

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
    controlMode: pending.record.modeAfter ?? pending.record.modeBefore,
    actor: pending.record.author,
    eventId: pending.record.id,
    occurredAt: pending.record.timestamp,
    reason: 'human input',
  });
  emitIntervention(
    pending.session,
    pending.record.author,
    pending.session.controlState?.controlMode ?? 'co-driven',
    pending.record,
    'human input',
    options
  );
}

export function recordHumanPtyInput(
  session: Session,
  data: string,
  options: ControlEngineOptions = {}
): void {
  if (session.mode !== 'pty' || data.length === 0) return;
  const existing = pendingBursts.get(session.id);
  if (existing) {
    existing.chunks.push(data);
    const clear = options.clearTimeoutFn ?? clearTimeout;
    const set = options.setTimeoutFn ?? setTimeout;
    clear(existing.timer);
    existing.timer = set(
      () => flushBurst(session.id, options),
      options.inputDebounceMs ?? DEFAULT_INPUT_DEBOUNCE_MS
    );
    return;
  }

  const before = normalizeControlStateSummary(session.controlState);
  if (before.controlMode !== 'agent-driven') return;

  const actor = humanActor(session);
  const after: ControlMode = 'co-driven';
  session.controlState = {
    ...before,
    controlMode: after,
    activeActors: actorsForMode(session, after, actor),
    activeWorker: agentActor(session),
    controlFreshness: 'fresh',
    controlReason: 'human input',
  };
  emitModeChanged(session, actor, before.controlMode, after, 'human input', options);

  const record = buildRecord({
    session,
    actor,
    source: 'pty-input',
    kind: 'human-input',
    payload: data,
    modeBefore: before.controlMode,
    modeAfter: after,
    options,
  });
  const set = options.setTimeoutFn ?? setTimeout;
  pendingBursts.set(session.id, {
    session,
    chunks: [data],
    record,
    timer: set(
      () => flushBurst(session.id, options),
      options.inputDebounceMs ?? DEFAULT_INPUT_DEBOUNCE_MS
    ),
  });
}

function targetModeForAction(action: ControlModeAction): ControlMode {
  if (action === 'join') return 'co-driven';
  if (action === 'take-over') return 'human-driven';
  return 'agent-driven';
}

function kindForAction(action: ControlModeAction): InterventionKind {
  if (action === 'take-over') return 'take-over';
  if (action === 'hand-back') return 'hand-back';
  return 'join';
}

export function applyControlModeAction(
  session: Session,
  action: ControlModeAction,
  options: ControlEngineOptions = {}
): TabControlEvent[] {
  const before = normalizeControlStateSummary(session.controlState);
  const actor = action === 'hand-back' ? humanActor(session) : humanActor(session);
  const modeAfter = targetModeForAction(action);
  const record = buildRecord({
    session,
    actor,
    source: 'mode-action',
    kind: kindForAction(action),
    modeBefore: before.controlMode,
    modeAfter,
    options,
    acked: true,
  });
  const append = options.append ?? appendIntervention;
  append(record);
  if (action === 'hand-back') {
    const ack = options.ackHumanInput ?? ackSessionHumanInput;
    ack({ sessionId: session.id, actor, ackedAt: record.timestamp });
  }
  updateControlState({
    session,
    controlMode: modeAfter,
    actor,
    eventId: record.id,
    occurredAt: record.timestamp,
    reason: action,
  });

  const events: TabControlEvent[] = [];
  if (before.controlMode !== modeAfter) {
    events.push(
      emitModeChanged(session, actor, before.controlMode, modeAfter, action, options)
    );
  }
  events.push(emitIntervention(session, actor, modeAfter, record, action, options));
  return events;
}

export function acknowledgeHumanInput(
  session: Session,
  actor: ControlActor = SYSTEM_ACTOR,
  options: ControlEngineOptions = {}
): number {
  const ack = options.ackHumanInput ?? ackSessionHumanInput;
  return ack({ sessionId: session.id, actor, ackedAt: nowIso(options) });
}

export function maybeAutoRevertToAgentDriven(input: {
  session: Session;
  nodeConnected?: boolean;
  options?: ControlEngineOptions;
}): AutoRevertResult {
  const options = input.options ?? {};
  const summary = normalizeControlStateSummary(input.session.controlState);
  if (summary.controlMode !== 'co-driven') {
    return { reverted: false, reason: 'not-co-driven' };
  }
  if (summary.controlFreshness !== 'fresh') {
    return { reverted: false, reason: 'not-fresh' };
  }
  if (input.session.status === 'disconnected' || input.nodeConnected === false) {
    return { reverted: false, reason: 'node-disconnected' };
  }
  const hasUnacked = options.hasUnacked ?? hasUnackedHumanInput;
  if (hasUnacked(input.session.id)) {
    return { reverted: false, reason: 'unacked-human-input' };
  }
  const last = summary.lastInterventionAt
    ? new Date(summary.lastInterventionAt).getTime()
    : NaN;
  const elapsed = (options.now?.() ?? new Date()).getTime() - last;
  if (!Number.isFinite(elapsed) || elapsed < (options.autoRevertMs ?? DEFAULT_AUTO_REVERT_MS)) {
    return { reverted: false, reason: 'not-idle-long-enough' };
  }

  const before = summary.controlMode;
  const modeAfter: ControlMode = 'agent-driven';
  const record = buildRecord({
    session: input.session,
    actor: SYSTEM_ACTOR,
    source: 'auto-revert',
    kind: 'auto-revert',
    modeBefore: before,
    modeAfter,
    options,
    acked: true,
  });
  const append = options.append ?? appendIntervention;
  append(record);
  updateControlState({
    session: input.session,
    controlMode: modeAfter,
    actor: SYSTEM_ACTOR,
    eventId: record.id,
    occurredAt: record.timestamp,
    reason: 'co-driven idle auto-revert',
  });
  emitModeChanged(
    input.session,
    SYSTEM_ACTOR,
    before,
    modeAfter,
    'co-driven idle auto-revert',
    options
  );
  const event = emitIntervention(
    input.session,
    SYSTEM_ACTOR,
    modeAfter,
    record,
    'co-driven idle auto-revert',
    options
  );
  return { reverted: true, event };
}

export function clearPendingControlBurstsForTests(): void {
  for (const pending of Array.from(pendingBursts.values())) clearTimeout(pending.timer);
  pendingBursts.clear();
}
