import * as crypto from 'node:crypto';

import { normalizeControlStateSummary, type ControlActor, type ControlMode } from '../shared/control-state.js';
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
} from '../shared/supervisor-actions.js';
import { DEFAULT_LOCAL_NODE_ID, createGlobalSessionId } from '../shared/identity.js';
import { encodeTerminalInput, type TerminalInputKey } from './terminal-model-backend.js';
import type { Session, SessionSummary } from './types.js';

const MAX_SUPERVISOR_TEXT_CHARS = 1000;
const SUPERVISOR_SEND_KEY_INPUTS: Record<SupervisorSendKeyName, TerminalInputKey> = {
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
  supervisorWrite(id: string, input: { action: SupervisorActionType; actor: ControlActor; payload: string }): { eventId: string; modeBefore?: ControlMode; modeAfter?: ControlMode };
}

function sha256(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

function actorSummary(actor: ControlActor): SupervisorActionAuditSummary['actor'] {
  return {
    kind: actor.kind,
    ...(actor.id ? { idHash: sha256(actor.id) } : {}),
    ...(actor.displayName ? { displayName: actor.displayName } : {}),
    ...(actor.nodeId ? { nodeId: actor.nodeId } : {}),
    ...(actor.sessionId ? { sessionId: actor.sessionId } : {}),
  };
}

function targetIdentity(session: Session | SessionSummary | undefined, requestedId: string) {
  const nodeId = session?.nodeId ?? DEFAULT_LOCAL_NODE_ID;
  const explicitGlobalSessionId =
    session && 'globalSessionId' in session ? session.globalSessionId : undefined;
  return {
    sessionId: session?.id ?? requestedId,
    ...(explicitGlobalSessionId
      ? { globalSessionId: explicitGlobalSessionId }
      : { globalSessionId: createGlobalSessionId(nodeId, session?.id ?? requestedId) }),
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
  return { ok: true, text: '\n' };
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
  action: SupervisorActionType
): SupervisorActionRedactionMetadata {
  const classes =
    action === 'submit'
      ? ['submit']
      : action === 'sendKey'
        ? ['named-key']
        : ['literal-text'];
  return {
    rawContentAvailable: false,
    hashSha256: sha256(payload),
    byteCount: Buffer.byteLength(payload, 'utf8'),
    charCount: Array.from(payload).length,
    lineCount: countLines(payload),
    classes,
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
  return { code, reasonCode, message, retryable, ...(details ? { details } : {}) };
}

function validateLiteralText(text: unknown): { ok: true; text: string } | { ok: false; error: SupervisorActionError } {
  if (typeof text !== 'string' || text.length === 0) {
    return {
      ok: false,
      error: error('INVALID_ARGUMENT', 'TEXT_REQUIRED', 'sendText requires non-empty literal text', false),
    };
  }
  if (Array.from(text).length > MAX_SUPERVISOR_TEXT_CHARS) {
    return {
      ok: false,
      error: error('INVALID_ARGUMENT', 'TEXT_TOO_LARGE', `sendText is limited to ${MAX_SUPERVISOR_TEXT_CHARS} characters`, false, {
        maxChars: MAX_SUPERVISOR_TEXT_CHARS,
      }),
    };
  }
  if (/\r|\n/.test(text) || Array.from(text).some((char) => {
    const code = char.charCodeAt(0);
    return code === 0x1b || code === 0x7f || (code < 0x20 && code !== 0x09);
  })) {
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

function missingSessionError(requestedId: string): SupervisorActionError {
  return error('NOT_FOUND', 'SESSION_NOT_FOUND', 'session was not found or is not locally writable', false, { sessionId: requestedId });
}

function targetPreflight(session: Session): SupervisorActionError | undefined {
  const control = normalizeControlStateSummary(session.controlState);
  if (session.status === 'disconnected') {
    return error('SESSION_CONFLICT', 'SESSION_DISCONNECTED', 'cannot run supervisor action on a disconnected session', false, { sessionId: session.id });
  }
  if (session.mode !== 'pty') {
    return error('SESSION_CONFLICT', 'SESSION_MODE_UNSUPPORTED', 'typed supervisor actions are only supported for PTY sessions', false, { sessionId: session.id, mode: session.mode });
  }
  if (control.controlFreshness === 'stale') {
    return error('CONTROL_STATE_STALE', 'CONTROL_STATE_STALE', 'cannot run supervisor action from stale control state', true, { sessionId: session.id });
  }
  if (control.controlFreshness !== 'fresh') {
    return error('CONTROL_STATE_UNKNOWN', 'CONTROL_STATE_UNKNOWN', 'cannot run supervisor action from unknown control state', true, { sessionId: session.id });
  }
  return undefined;
}

function emptyCounts(requested: number): SupervisorActionCounts {
  return { requested, succeeded: 0, denied: 0, failed: 0, skipped: 0 };
}

function tally(results: SupervisorActionTargetResult[]): SupervisorActionCounts {
  const counts = emptyCounts(results.length);
  for (const result of results) {
    if (result.ok) counts.succeeded += 1;
    else if (result.error?.code === 'FORBIDDEN') counts.denied += 1;
    else counts.failed += 1;
  }
  return counts;
}

export function listSupervisorSessions(sessions: readonly SessionSummary[]): SupervisorSessionsResponse {
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
        ...(session.controlMode === undefined ? {} : { controlMode: session.controlMode }),
        ...(session.controlFreshness === undefined ? {} : { controlFreshness: session.controlFreshness }),
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

export function executeSupervisorAction(input: {
  boundary: SupervisorActionSessionBoundary;
  action: SupervisorActionType;
  targetIds: readonly string[];
  text?: unknown;
  key?: unknown;
  actor?: ControlActor;
  now?: Date;
  deniedByCapability?: SupervisorActionError;
}): SupervisorActionResponse {
  const actor = input.actor ?? DEFAULT_SUPERVISOR_ACTOR;
  const timestamp = (input.now ?? new Date()).toISOString();
  const validation = validateActionPayload(input.action, input.text, input.key);
  const payload = payloadForValidation(validation);
  const canonicalKey = keyForValidation(validation);
  const payloadValidationError = validationError(validation);
  const results: SupervisorActionTargetResult[] = [];

  const uniqueTargetIds = Array.from(new Set(input.targetIds.filter((id) => id.trim().length > 0)));
  if (uniqueTargetIds.length === 0) {
    uniqueTargetIds.push('');
  }

  for (const id of uniqueTargetIds) {
    const session = id ? input.boundary.get(id) : undefined;
    const identity = targetIdentity(session, id);
    if (input.deniedByCapability) {
      results.push({ ...identity, ok: false, action: input.action, error: input.deniedByCapability });
      continue;
    }
    if (payloadValidationError) {
      results.push({ ...identity, ok: false, action: input.action, error: payloadValidationError });
      continue;
    }
    if (!session) {
      results.push({ ...identity, ok: false, action: input.action, error: missingSessionError(id) });
      continue;
    }
    const preflight = targetPreflight(session);
    if (preflight) {
      results.push({ ...identity, ok: false, action: input.action, error: preflight });
      continue;
    }
    try {
      const write = input.boundary.supervisorWrite(session.id, {
        action: input.action,
        actor,
        payload,
      });
      const targetResult: SupervisorActionTargetResult = {
        ...identity,
        ok: true,
        action: input.action,
        bytesWritten: Buffer.byteLength(payload, 'utf8'),
        ...(canonicalKey === undefined ? {} : { key: canonicalKey }),
        interventionEventId: write.eventId,
        ...(write.modeBefore === undefined ? {} : { controlModeBefore: write.modeBefore }),
        ...(write.modeAfter === undefined ? {} : { controlModeAfter: write.modeAfter }),
      };
      results.push(targetResult);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : 'failed to write supervisor action';
      results.push({
        ...identity,
        ok: false,
        action: input.action,
        error: error('UPSTREAM_ERROR', 'UPSTREAM_WRITE_FAILED', message, true, { sessionId: session.id }),
      });
    }
  }

  const counts = tally(results);
  const audit: SupervisorActionAuditSummary = {
    action: input.action,
    actor: actorSummary(actor),
    targetSessionIds: results.map((result) => result.sessionId),
    targetCount: results.length,
    ...(canonicalKey === undefined ? {} : { key: canonicalKey }),
    timestamp,
    ...(validation.ok ? { content: redactionForPayload(payload, input.action) } : {}),
    counts,
    rawContentStored: false,
    partialFailure: counts.failed > 0 || counts.denied > 0 || counts.skipped > 0,
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
