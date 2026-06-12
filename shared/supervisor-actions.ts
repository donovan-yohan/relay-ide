import type {
  ControlActor,
  ControlFreshness,
  ControlMode,
} from './control-state.js';
import type { RelayCapabilityBit } from './security-policy.js';

export const SUPERVISOR_SESSIONS_COMMAND_ID = 'supervisor.sessions' as const;
export const SUPERVISOR_SEND_TEXT_COMMAND_ID = 'supervisor.sendText' as const;
export const SUPERVISOR_SEND_KEY_COMMAND_ID = 'supervisor.sendKey' as const;
export const SUPERVISOR_SUBMIT_COMMAND_ID = 'supervisor.submit' as const;

export const SUPERVISOR_READ_REQUIRED_CAPABILITIES = [
  'session:read',
  'tab:intervention:read',
] as const satisfies readonly RelayCapabilityBit[];

export const SUPERVISOR_SEND_TEXT_REQUIRED_CAPABILITIES = [
  'session:attach',
  'tab:intervention:send-text',
] as const satisfies readonly RelayCapabilityBit[];

export const SUPERVISOR_SEND_KEY_REQUIRED_CAPABILITIES = [
  'session:attach',
  'tab:intervention:send-key',
] as const satisfies readonly RelayCapabilityBit[];

export const SUPERVISOR_SUBMIT_REQUIRED_CAPABILITIES = [
  'session:attach',
  'tab:intervention:submit',
] as const satisfies readonly RelayCapabilityBit[];

export const SUPERVISOR_SEND_KEY_NAMES = [
  'escape',
  'tab',
  'arrow-up',
  'arrow-down',
  'arrow-left',
  'arrow-right',
  'ctrl-c',
  'ctrl-d',
  'home',
  'end',
  'page-up',
  'page-down',
] as const;

export type SupervisorSendKeyName = (typeof SUPERVISOR_SEND_KEY_NAMES)[number];

export type SupervisorActionType = 'sendText' | 'sendKey' | 'submit';

export type SupervisorActionErrorCode =
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'SESSION_CONFLICT'
  | 'CONTROL_STATE_STALE'
  | 'CONTROL_STATE_UNKNOWN'
  | 'INVALID_ARGUMENT'
  | 'UPSTREAM_ERROR';

export type SupervisorActionReasonCode =
  | 'CAPABILITY_REQUIRED'
  | 'SESSION_NOT_FOUND'
  | 'SESSION_DISCONNECTED'
  | 'CONTROL_STATE_STALE'
  | 'CONTROL_STATE_UNKNOWN'
  | 'SESSION_MODE_UNSUPPORTED'
  | 'TARGET_SELECTOR_REQUIRED'
  | 'TARGET_SELECTOR_INVALID'
  | 'TEXT_REQUIRED'
  | 'TEXT_TOO_LARGE'
  | 'TEXT_MUST_BE_LITERAL'
  | 'KEY_REQUIRED'
  | 'KEY_INVALID'
  | 'UPSTREAM_WRITE_FAILED';

export interface SupervisorActionError {
  code: SupervisorActionErrorCode;
  reasonCode: SupervisorActionReasonCode;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
}

export interface SupervisorActionRedactionMetadata {
  rawContentAvailable: false;
  hashSha256: string;
  byteCount: number;
  charCount: number;
  lineCount: number;
  classes: string[];
  redacted: boolean;
}

export interface SupervisorActionTargetResult {
  sessionId: string;
  globalSessionId?: string;
  nodeId?: string;
  ok: boolean;
  action: SupervisorActionType;
  bytesWritten?: number;
  key?: SupervisorSendKeyName;
  interventionEventId?: string;
  controlModeBefore?: ControlMode;
  controlModeAfter?: ControlMode;
  error?: SupervisorActionError;
}

export interface SupervisorActionCounts {
  requested: number;
  succeeded: number;
  denied: number;
  failed: number;
  skipped: number;
}

export interface SupervisorActionAuditSummary {
  action: SupervisorActionType;
  actor: {
    kind: ControlActor['kind'];
    idHash?: string;
    displayName?: string;
    nodeId?: string;
    sessionId?: string;
  };
  targetSessionIds: string[];
  targetCount: number;
  key?: SupervisorSendKeyName;
  timestamp: string;
  content?: SupervisorActionRedactionMetadata;
  counts: SupervisorActionCounts;
  rawContentStored: false;
  partialFailure: boolean;
}

export interface SupervisorActionResponse {
  command:
    | typeof SUPERVISOR_SEND_TEXT_COMMAND_ID
    | typeof SUPERVISOR_SEND_KEY_COMMAND_ID
    | typeof SUPERVISOR_SUBMIT_COMMAND_ID;
  action: SupervisorActionType;
  results: SupervisorActionTargetResult[];
  counts: SupervisorActionCounts;
  audit: SupervisorActionAuditSummary;
  redaction: {
    rawContentAvailable: false;
    rawContentStored: false;
    hashesOnly: true;
  };
}

export interface SupervisorSessionEligibility {
  sessionId: string;
  globalSessionId?: string;
  nodeId?: string;
  mode?: string;
  status?: string;
  controlMode?: ControlMode;
  controlFreshness?: ControlFreshness;
  actions: Record<
    SupervisorActionType,
    { allowed: boolean; reasonCode?: SupervisorActionReasonCode }
  >;
}

export interface SupervisorSessionsResponse {
  command: typeof SUPERVISOR_SESSIONS_COMMAND_ID;
  sessions: SupervisorSessionEligibility[];
  count: number;
}

export function supervisorActionRequiredCapabilities(
  action: SupervisorActionType
): readonly RelayCapabilityBit[] {
  if (action === 'sendText') return SUPERVISOR_SEND_TEXT_REQUIRED_CAPABILITIES;
  if (action === 'sendKey') return SUPERVISOR_SEND_KEY_REQUIRED_CAPABILITIES;
  return SUPERVISOR_SUBMIT_REQUIRED_CAPABILITIES;
}

export function supervisorActionCommandId(
  action: SupervisorActionType
):
  | typeof SUPERVISOR_SEND_TEXT_COMMAND_ID
  | typeof SUPERVISOR_SEND_KEY_COMMAND_ID
  | typeof SUPERVISOR_SUBMIT_COMMAND_ID {
  if (action === 'sendText') return SUPERVISOR_SEND_TEXT_COMMAND_ID;
  if (action === 'sendKey') return SUPERVISOR_SEND_KEY_COMMAND_ID;
  return SUPERVISOR_SUBMIT_COMMAND_ID;
}
