import * as crypto from 'node:crypto';

import {
  normalizeControlStateSummary,
  type ControlActor,
  type ControlMode,
} from '../shared/control-state.js';
import {
  SUPERVISOR_SEND_KEY_NAMES,
  supervisorActionCommandId,
  type SupervisorActionAuditSummary,
  type SupervisorActionCounts,
  type SupervisorActionError,
  type SupervisorActionRedactionMetadata,
  type SupervisorActionResponse,
  type SupervisorActionTargetResult,
  type SupervisorActionType,
  type SupervisorSendKeyName,
  type SupervisorSessionEligibility,
  type SupervisorSessionsResponse,
  type SupervisorSubmitObservation,
  type SupervisorSubmitStep,
} from '../shared/supervisor-actions.js';
import {
  DEFAULT_LOCAL_NODE_ID,
  createGlobalSessionId,
} from '../shared/identity.js';
import {
  encodeTerminalInput,
  type TerminalInputKey,
} from './terminal-model-backend.js';
import type { Session, SessionSummary } from './types.js';

const MAX_SUPERVISOR_TEXT_CHARS = 1000;
// A submit body is the typed primitive's "paste-ish" lane (#958): it may carry
// multi-line prompts, so its cap is much larger than the single-line sendText
// limit, but it is still bounded so this never becomes an unbounded write API.
const MAX_SUPERVISOR_SUBMIT_TEXT_CHARS = 100_000;
// The submit primitive owns the carriage return so callers never need to send a
// second `\r`. We reuse the canonical Enter encoding (CR, not LF) — the LF the
// old submit wrote is exactly what left text sitting unsubmitted in TUIs (#958).
const SUBMIT_ENTER_SEQUENCE = encodeTerminalInput({
  type: 'key',
  key: 'Enter',
}).sequence;
// Ctrl-U (unix-line-discard): a best-effort, provider-generic "clear the current
// input line" before typing. Not provider-specific magic; standard readline/TUI.
const CLEAR_INPUT_SEQUENCE = '\u0015';
// DEC 2004 bracketed paste markers. Wrapping a multi-line/long body lets the TUI
// treat embedded newlines as literal content instead of premature submissions.
const BRACKETED_PASTE_START = '\u001b[200~';
const BRACKETED_PASTE_END = '\u001b[201~';
const SUPERVISOR_SEND_KEY_INPUTS: Record<
  SupervisorSendKeyName,
  TerminalInputKey
> = {
  escape: 'Escape',
  tab: 'Tab',
  'arrow-up': 'ArrowUp',
  'arrow-down': 'ArrowDown',
  'arrow-left': 'ArrowLeft',
  'arrow-right': 'ArrowRight',
  'ctrl-c': 'CtrlC',
  'ctrl-d': 'CtrlD',
  home: 'Home',
  end: 'End',
  'page-up': 'PageUp',
  'page-down': 'PageDown',
};
const SUPERVISOR_SEND_KEY_NAME_SET = new Set<string>(SUPERVISOR_SEND_KEY_NAMES);
const DEFAULT_SUPERVISOR_ACTOR: ControlActor = {
  kind: 'agent',
  id: 'relay-supervisor',
  displayName: 'Relay supervisor',
};

export interface SupervisorActionSessionBoundary {
  list(): SessionSummary[];
  get(id: string): Session | undefined;
  supervisorWrite(
    id: string,
    input: {
      action: SupervisorActionType;
      actor: ControlActor;
      payload: string;
      deferredTail?: string;
    }
  ): { eventId: string; modeBefore?: ControlMode; modeAfter?: ControlMode };
}

function sha256(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

function actorSummary(
  actor: ControlActor
): SupervisorActionAuditSummary['actor'] {
  return {
    kind: actor.kind,
    ...(actor.id ? { idHash: sha256(actor.id) } : {}),
    ...(actor.displayName ? { displayName: actor.displayName } : {}),
    ...(actor.nodeId ? { nodeId: actor.nodeId } : {}),
    ...(actor.sessionId ? { sessionId: actor.sessionId } : {}),
  };
}

function targetIdentity(
  session: Session | SessionSummary | undefined,
  requestedId: string
) {
  const nodeId = session?.nodeId ?? DEFAULT_LOCAL_NODE_ID;
  const explicitGlobalSessionId =
    session && 'globalSessionId' in session
      ? session.globalSessionId
      : undefined;
  return {
    sessionId: session?.id ?? requestedId,
    ...(explicitGlobalSessionId
      ? { globalSessionId: explicitGlobalSessionId }
      : {
          globalSessionId: createGlobalSessionId(
            nodeId,
            session?.id ?? requestedId
          ),
        }),
    nodeId,
  };
}

function validationError(
  validation:
    | { ok: true; text: string }
    | { ok: true; key: SupervisorSendKeyName; payload: string }
    | { ok: false; error: SupervisorActionError }
): SupervisorActionError | undefined {
  return 'error' in validation ? validation.error : undefined;
}

function validateActionPayload(
  action: SupervisorActionType,
  text: unknown,
  key: unknown
):
  | { ok: true; text: string }
  | { ok: true; key: SupervisorSendKeyName; payload: string }
  | { ok: false; error: SupervisorActionError } {
  if (action === 'sendText') {
    return validateLiteralText(text);
  }
  if (action === 'sendKey') {
    return validateSendKey(key);
  }
  // `submit` is handled by buildSubmitPlan() (#958), not here. This fallback is
  // unreachable for submit but kept for exhaustiveness of the action union.
  return { ok: true, text: SUBMIT_ENTER_SEQUENCE };
}

function payloadForValidation(
  validation:
    | { ok: true; text: string }
    | { ok: true; key: SupervisorSendKeyName; payload: string }
    | { ok: false; error: SupervisorActionError }
): string {
  if (!validation.ok) return '';
  return 'payload' in validation ? validation.payload : validation.text;
}

function keyForValidation(
  validation:
    | { ok: true; text: string }
    | { ok: true; key: SupervisorSendKeyName; payload: string }
    | { ok: false; error: SupervisorActionError }
): SupervisorSendKeyName | undefined {
  return validation.ok && 'key' in validation ? validation.key : undefined;
}

function countLines(input: string): number {
  if (input.length === 0) return 0;
  return input.split(/\r\n|\r|\n/).length;
}

function redactionForPayload(
  payload: string,
  action: SupervisorActionType,
  classesOverride?: readonly string[]
): SupervisorActionRedactionMetadata {
  const classes =
    classesOverride ??
    (action === 'submit'
      ? ['submit']
      : action === 'sendKey'
        ? ['named-key']
        : ['literal-text']);
  return {
    rawContentAvailable: false,
    hashSha256: sha256(payload),
    byteCount: Buffer.byteLength(payload, 'utf8'),
    charCount: Array.from(payload).length,
    lineCount: countLines(payload),
    classes: [...classes],
    redacted: true,
  };
}

function error(
  code: SupervisorActionError['code'],
  reasonCode: SupervisorActionError['reasonCode'],
  message: string,
  retryable: boolean,
  details?: Record<string, unknown>
): SupervisorActionError {
  return {
    code,
    reasonCode,
    message,
    retryable,
    ...(details ? { details } : {}),
  };
}

function validateLiteralText(
  text: unknown
): { ok: true; text: string } | { ok: false; error: SupervisorActionError } {
  if (typeof text !== 'string' || text.length === 0) {
    return {
      ok: false,
      error: error(
        'INVALID_ARGUMENT',
        'TEXT_REQUIRED',
        'sendText requires non-empty literal text',
        false
      ),
    };
  }
  if (Array.from(text).length > MAX_SUPERVISOR_TEXT_CHARS) {
    return {
      ok: false,
      error: error(
        'INVALID_ARGUMENT',
        'TEXT_TOO_LARGE',
        `sendText is limited to ${MAX_SUPERVISOR_TEXT_CHARS} characters`,
        false,
        {
          maxChars: MAX_SUPERVISOR_TEXT_CHARS,
        }
      ),
    };
  }
  if (
    /\r|\n/.test(text) ||
    Array.from(text).some((char) => {
      const code = char.charCodeAt(0);
      return code === 0x1b || code === 0x7f || (code < 0x20 && code !== 0x09);
    })
  ) {
    return {
      ok: false,
      error: error(
        'INVALID_ARGUMENT',
        'TEXT_MUST_BE_LITERAL',
        'sendText accepts literal text only; use supervisor.submit for Enter and do not send control sequences',
        false
      ),
    };
  }
  return { ok: true, text };
}

function validateSendKey(
  key: unknown
):
  | { ok: true; key: SupervisorSendKeyName; payload: string }
  | { ok: false; error: SupervisorActionError } {
  if (typeof key !== 'string' || key.length === 0) {
    return {
      ok: false,
      error: error(
        'INVALID_ARGUMENT',
        'KEY_REQUIRED',
        'sendKey requires one canonical --key name',
        false,
        { allowedKeys: SUPERVISOR_SEND_KEY_NAMES }
      ),
    };
  }
  if (!SUPERVISOR_SEND_KEY_NAME_SET.has(key)) {
    return {
      ok: false,
      error: error(
        'INVALID_ARGUMENT',
        'KEY_INVALID',
        'sendKey accepts only canonical closed-enum key names',
        false,
        { field: 'key', allowedKeys: SUPERVISOR_SEND_KEY_NAMES }
      ),
    };
  }
  const canonicalKey = key as SupervisorSendKeyName;
  return {
    ok: true,
    key: canonicalKey,
    payload: encodeTerminalInput({
      type: 'key',
      key: SUPERVISOR_SEND_KEY_INPUTS[canonicalKey],
    }).sequence,
  };
}

/**
 * The fully-resolved byte plan + evidence for one `supervisor.submit` (#958).
 * Computed once per request and reused for every target (the bytes are
 * identical across targets); per-target evidence is layered on at write time.
 */
interface SupervisorSubmitPlan {
  /** Exact bytes written to the PTY: [clear?] + [body|bracketed-body] + CR. */
  payload: string;
  /**
   * When a body is typed, the owned CR is written as a separate deferred PTY
   * write instead of riding the same chunk: TUI input loops (crossterm et al)
   * treat text+CR arriving together as one paste and leave the text sitting
   * unsubmitted in the composer. `payload` stays the full byte evidence;
   * `typedPayload`/`submitTail` describe the actual two-write split.
   */
  typedPayload: string;
  submitTail: string;
  /** The normalized text body (no control framing, trailing newlines stripped). */
  body: string;
  charsAccepted: number;
  bytesAccepted: number;
  plannedBytes: number;
  clearInputPerformed: boolean;
  pasteBracketed: boolean;
  steps: SupervisorSubmitStep[];
  classes: string[];
}

/**
 * Normalize a submit body: collapse CRLF / lone CR to LF so embedded line breaks
 * are consistent, then strip trailing newlines. The primitive appends exactly
 * one owned carriage return, so callers never need to send a second `\r` (#958).
 */
function normalizeSubmitBody(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n+$/u, '');
}

function validateSubmitText(
  text: string
): { ok: true; text: string } | { ok: false; error: SupervisorActionError } {
  if (Array.from(text).length > MAX_SUPERVISOR_SUBMIT_TEXT_CHARS) {
    return {
      ok: false,
      error: error(
        'INVALID_ARGUMENT',
        'TEXT_TOO_LARGE',
        `supervisor.submit text is limited to ${MAX_SUPERVISOR_SUBMIT_TEXT_CHARS} characters`,
        false,
        { maxChars: MAX_SUPERVISOR_SUBMIT_TEXT_CHARS }
      ),
    };
  }
  // Newlines (\n, \r) and tabs are allowed in a submit body — multi-line prompts
  // are the whole point. Other C0 control bytes and ESC (0x1b) / DEL (0x7f) are
  // rejected so this stays a typed text primitive, not a raw byte-injection API.
  const hasDisallowedControl = Array.from(text).some((char) => {
    const code = char.charCodeAt(0);
    return (
      code === 0x1b ||
      code === 0x7f ||
      (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d)
    );
  });
  if (hasDisallowedControl) {
    return {
      ok: false,
      error: error(
        'INVALID_ARGUMENT',
        'TEXT_MUST_BE_LITERAL',
        'supervisor.submit text accepts literal text (newlines and tabs allowed); control/escape sequences are not permitted',
        false
      ),
    };
  }
  return { ok: true, text };
}

/**
 * Build the submit byte plan. Order: optional clear-input (Ctrl-U), optional
 * typed body (raw or bracketed-paste-wrapped), then the owned carriage return.
 */
function buildSubmitPlan(input: {
  text?: unknown;
  clearInput?: boolean | undefined;
  paste?: boolean | undefined;
}):
  | { ok: true; plan: SupervisorSubmitPlan }
  | { ok: false; error: SupervisorActionError } {
  let body = '';
  const hasText = input.text !== undefined && input.text !== null;
  if (hasText) {
    if (typeof input.text !== 'string') {
      return {
        ok: false,
        error: error(
          'INVALID_ARGUMENT',
          'TEXT_REQUIRED',
          'supervisor.submit text must be a string when provided',
          false
        ),
      };
    }
    const validated = validateSubmitText(input.text);
    if (!validated.ok) return validated;
    body = normalizeSubmitBody(validated.text);
  }

  const clearInputPerformed = input.clearInput === true;
  const pasteBracketed = input.paste === true && body.length > 0;
  const steps: SupervisorSubmitStep[] = [];
  const parts: string[] = [];
  if (clearInputPerformed) {
    parts.push(CLEAR_INPUT_SEQUENCE);
    steps.push('clear-input');
  }
  if (body.length > 0) {
    parts.push(
      pasteBracketed
        ? `${BRACKETED_PASTE_START}${body}${BRACKETED_PASTE_END}`
        : body
    );
    steps.push('type-text');
  }
  steps.push('submit');

  const typedPayload = parts.join('');
  const payload = typedPayload + SUBMIT_ENTER_SEQUENCE;
  const classes = [
    'submit',
    ...(body.length > 0 ? ['literal-text'] : []),
    ...(pasteBracketed ? ['paste'] : []),
    ...(clearInputPerformed ? ['clear-input'] : []),
  ];
  return {
    ok: true,
    plan: {
      payload,
      typedPayload,
      submitTail: SUBMIT_ENTER_SEQUENCE,
      body,
      charsAccepted: Array.from(body).length,
      bytesAccepted: Buffer.byteLength(body, 'utf8'),
      plannedBytes: Buffer.byteLength(payload, 'utf8'),
      clearInputPerformed,
      pasteBracketed,
      steps,
      classes,
    },
  };
}

/**
 * Best-effort derived post-submit state (#958). Reads the last-known terminal activity state
 * from the resolved session snapshot; returns `available: false` when no derived
 * state exists yet (mock/dry-run/unclassified). Never exposes raw bytes.
 */
function observePostSubmit(
  session: Session,
  observedAt: string
): SupervisorSubmitObservation {
  const activityState = (session as { activityState?: unknown }).activityState;
  if (typeof activityState === 'string' && activityState.length > 0) {
    const idle = (session as { idle?: unknown }).idle;
    return {
      available: true,
      activityState,
      ...(typeof idle === 'boolean' ? { idle } : {}),
      source: 'session-snapshot',
      observedAt,
    };
  }
  return { available: false };
}

function missingSessionError(requestedId: string): SupervisorActionError {
  return error(
    'NOT_FOUND',
    'SESSION_NOT_FOUND',
    'session was not found or is not locally writable',
    false,
    { sessionId: requestedId }
  );
}

function targetPreflight(session: Session): SupervisorActionError | undefined {
  const control = normalizeControlStateSummary(session.controlState);
  if (session.status === 'disconnected') {
    return error(
      'SESSION_CONFLICT',
      'SESSION_DISCONNECTED',
      'cannot run supervisor action on a disconnected session',
      false,
      { sessionId: session.id }
    );
  }
  if (session.mode !== 'pty') {
    return error(
      'SESSION_CONFLICT',
      'SESSION_MODE_UNSUPPORTED',
      'typed supervisor actions are only supported for PTY sessions',
      false,
      { sessionId: session.id, mode: session.mode }
    );
  }
  if (control.controlFreshness === 'stale') {
    return error(
      'CONTROL_STATE_STALE',
      'CONTROL_STATE_STALE',
      'cannot run supervisor action from stale control state',
      true,
      { sessionId: session.id }
    );
  }
  if (control.controlFreshness !== 'fresh') {
    return error(
      'CONTROL_STATE_UNKNOWN',
      'CONTROL_STATE_UNKNOWN',
      'cannot run supervisor action from unknown control state',
      true,
      { sessionId: session.id }
    );
  }
  return undefined;
}

function emptyCounts(requested: number): SupervisorActionCounts {
  return { requested, succeeded: 0, denied: 0, failed: 0, skipped: 0 };
}

function tally(
  results: SupervisorActionTargetResult[]
): SupervisorActionCounts {
  const counts = emptyCounts(results.length);
  for (const result of results) {
    if (result.ok) counts.succeeded += 1;
    else if (result.error?.code === 'FORBIDDEN') counts.denied += 1;
    else counts.failed += 1;
  }
  return counts;
}

export function listSupervisorSessions(
  sessions: readonly SessionSummary[]
): SupervisorSessionsResponse {
  return {
    command: 'supervisor.sessions',
    sessions: sessions.map((session): SupervisorSessionEligibility => {
      const common = targetIdentity(session, session.id);
      const reason =
        session.status === 'disconnected'
          ? 'SESSION_DISCONNECTED'
          : session.mode !== 'pty'
            ? 'SESSION_MODE_UNSUPPORTED'
            : session.controlFreshness === 'stale'
              ? 'CONTROL_STATE_STALE'
              : session.controlFreshness !== 'fresh'
                ? 'CONTROL_STATE_UNKNOWN'
                : undefined;
      const allowed = reason === undefined;
      return {
        ...common,
        mode: session.mode,
        status: session.status,
        ...(session.controlMode === undefined
          ? {}
          : { controlMode: session.controlMode }),
        ...(session.controlFreshness === undefined
          ? {}
          : { controlFreshness: session.controlFreshness }),
        actions: {
          sendText: { allowed, ...(reason ? { reasonCode: reason } : {}) },
          sendKey: { allowed, ...(reason ? { reasonCode: reason } : {}) },
          submit: { allowed, ...(reason ? { reasonCode: reason } : {}) },
        },
      };
    }),
    count: sessions.length,
  };
}

/** Resolved byte plan + redaction for one action, shared across all targets. */
interface PreparedSupervisorAction {
  payload: string;
  canonicalKey?: SupervisorSendKeyName;
  payloadValidationError?: SupervisorActionError;
  auditContent?: SupervisorActionRedactionMetadata;
  submitPlan?: SupervisorSubmitPlan;
}

interface SupervisorTargetContext {
  action: SupervisorActionType;
  actor: ControlActor;
  dryRun: boolean;
  boundary: SupervisorActionSessionBoundary;
  timestamp: string;
  deniedByCapability?: SupervisorActionError;
}

/**
 * Resolve the byte plan + redaction once. Submit composes optional clear-input +
 * optional typed text + an owned carriage return (#958); sendText/sendKey keep
 * their existing literal/named-key validation.
 */
function prepareSupervisorAction(
  action: SupervisorActionType,
  text: unknown,
  key: unknown,
  clearInput: boolean | undefined,
  paste: boolean | undefined
): PreparedSupervisorAction {
  if (action === 'submit') {
    const planResult = buildSubmitPlan({ text, clearInput, paste });
    if (!planResult.ok) {
      return { payload: '', payloadValidationError: planResult.error };
    }
    return {
      payload: planResult.plan.payload,
      submitPlan: planResult.plan,
      auditContent: redactionForPayload(
        planResult.plan.body,
        'submit',
        planResult.plan.classes
      ),
    };
  }
  const validation = validateActionPayload(action, text, key);
  const payload = payloadForValidation(validation);
  const canonicalKey = keyForValidation(validation);
  const payloadValidationError = validationError(validation);
  return {
    payload,
    ...(canonicalKey === undefined ? {} : { canonicalKey }),
    ...(payloadValidationError ? { payloadValidationError } : {}),
    ...(validation.ok
      ? { auditContent: redactionForPayload(payload, action) }
      : {}),
  };
}

/** Submit evidence layered onto a successful real (non-dry-run) write (#958). */
function submitSuccessEvidence(
  submitPlan: SupervisorSubmitPlan,
  session: Session,
  timestamp: string
): Partial<SupervisorActionTargetResult> {
  return {
    charsAccepted: submitPlan.charsAccepted,
    bytesAccepted: submitPlan.bytesAccepted,
    submitPerformed: true,
    submitKey: 'enter',
    clearInputPerformed: submitPlan.clearInputPerformed,
    pasteBracketed: submitPlan.pasteBracketed,
    steps: submitPlan.steps,
    postSubmit: observePostSubmit(session, timestamp),
  };
}

/** Submit dry-run preview: planned evidence with nothing written (#958). */
function submitDryRunResult(
  identity: ReturnType<typeof targetIdentity>,
  submitPlan: SupervisorSubmitPlan
): SupervisorActionTargetResult {
  return {
    ...identity,
    ok: true,
    action: 'submit',
    dryRun: true,
    plannedBytes: submitPlan.plannedBytes,
    charsAccepted: submitPlan.charsAccepted,
    bytesAccepted: submitPlan.bytesAccepted,
    submitPerformed: false,
    submitKey: 'enter',
    clearInputPerformed: submitPlan.clearInputPerformed,
    pasteBracketed: submitPlan.pasteBracketed,
    steps: submitPlan.steps,
    postSubmit: { available: false },
  };
}

/** Run one target: guard checks, then dry-run preview or a real write. */
function runSupervisorTarget(
  id: string,
  prepared: PreparedSupervisorAction,
  ctx: SupervisorTargetContext
): SupervisorActionTargetResult {
  const session = id ? ctx.boundary.get(id) : undefined;
  const identity = targetIdentity(session, id);
  const fail = (
    error: SupervisorActionError
  ): SupervisorActionTargetResult => ({
    ...identity,
    ok: false,
    action: ctx.action,
    error,
  });

  if (ctx.deniedByCapability) return fail(ctx.deniedByCapability);
  if (prepared.payloadValidationError)
    return fail(prepared.payloadValidationError);
  if (!session) return fail(missingSessionError(id));
  const preflight = targetPreflight(session);
  if (preflight) return fail(preflight);

  if (prepared.submitPlan && ctx.dryRun) {
    return submitDryRunResult(identity, prepared.submitPlan);
  }

  try {
    const splitSubmit =
      prepared.submitPlan && prepared.submitPlan.typedPayload.length > 0;
    const write = ctx.boundary.supervisorWrite(session.id, {
      action: ctx.action,
      actor: ctx.actor,
      ...(splitSubmit && prepared.submitPlan
        ? {
            payload: prepared.submitPlan.typedPayload,
            deferredTail: prepared.submitPlan.submitTail,
          }
        : { payload: prepared.payload }),
    });
    return {
      ...identity,
      ok: true,
      action: ctx.action,
      bytesWritten: Buffer.byteLength(prepared.payload, 'utf8'),
      ...(prepared.canonicalKey === undefined
        ? {}
        : { key: prepared.canonicalKey }),
      interventionEventId: write.eventId,
      ...(write.modeBefore === undefined
        ? {}
        : { controlModeBefore: write.modeBefore }),
      ...(write.modeAfter === undefined
        ? {}
        : { controlModeAfter: write.modeAfter }),
      ...(prepared.submitPlan
        ? submitSuccessEvidence(prepared.submitPlan, session, ctx.timestamp)
        : {}),
    };
  } catch (caught) {
    const message =
      caught instanceof Error
        ? caught.message
        : 'failed to write supervisor action';
    return fail(
      error('UPSTREAM_ERROR', 'UPSTREAM_WRITE_FAILED', message, true, {
        sessionId: session.id,
      })
    );
  }
}

export function executeSupervisorAction(input: {
  boundary: SupervisorActionSessionBoundary;
  action: SupervisorActionType;
  targetIds: readonly string[];
  text?: unknown;
  key?: unknown;
  /** Submit-only (#958): clear the current input buffer before typing. */
  clearInput?: boolean;
  /** Submit-only (#958): wrap a multi-line/long body in bracketed-paste markers. */
  paste?: boolean;
  /** Submit-only (#958): preview the plan + evidence without writing/auditing. */
  dryRun?: boolean;
  actor?: ControlActor;
  now?: Date;
  deniedByCapability?: SupervisorActionError;
}): SupervisorActionResponse {
  const actor = input.actor ?? DEFAULT_SUPERVISOR_ACTOR;
  const timestamp = (input.now ?? new Date()).toISOString();
  const dryRun = input.action === 'submit' && input.dryRun === true;
  const prepared = prepareSupervisorAction(
    input.action,
    input.text,
    input.key,
    input.clearInput,
    input.paste
  );

  const uniqueTargetIds = Array.from(
    new Set(input.targetIds.filter((id) => id.trim().length > 0))
  );
  if (uniqueTargetIds.length === 0) {
    uniqueTargetIds.push('');
  }

  const ctx: SupervisorTargetContext = {
    action: input.action,
    actor,
    dryRun,
    boundary: input.boundary,
    timestamp,
    ...(input.deniedByCapability
      ? { deniedByCapability: input.deniedByCapability }
      : {}),
  };
  const results = uniqueTargetIds.map((id) =>
    runSupervisorTarget(id, prepared, ctx)
  );

  const counts = tally(results);
  const audit: SupervisorActionAuditSummary = {
    action: input.action,
    actor: actorSummary(actor),
    targetSessionIds: results.map((result) => result.sessionId),
    targetCount: results.length,
    ...(prepared.canonicalKey === undefined
      ? {}
      : { key: prepared.canonicalKey }),
    timestamp,
    ...(prepared.auditContent ? { content: prepared.auditContent } : {}),
    counts,
    rawContentStored: false,
    partialFailure:
      counts.failed > 0 || counts.denied > 0 || counts.skipped > 0,
    ...(dryRun ? { dryRun: true } : {}),
  };
  return {
    command: supervisorActionCommandId(input.action),
    action: input.action,
    results,
    counts,
    audit,
    redaction: {
      rawContentAvailable: false,
      rawContentStored: false,
      hashesOnly: true,
    },
  };
}
