import type { RelayCliGatewayCommand } from './cli-gateway-contract.js';
import type {
  RelayCommandScopeKind,
  RelayCommandSideEffect,
} from './relay-command-manifest.js';

export type CommandCenterExecutionResultKind =
  | 'success'
  | 'blocked'
  | 'confirmation_required'
  | 'unavailable'
  | 'error';

export type CommandCenterExecutionPolicyOutcome =
  | 'allowed'
  | 'blocked'
  | 'confirmation-required';

export type CommandCenterExecutionConfirmationOutcome =
  | 'not-required'
  | 'required'
  | 'blocked';

export interface CommandCenterExecutionArgsRedaction {
  rawArgsReturned: false;
  argKeys: readonly string[];
  argsSha256: string;
}

export interface CommandCenterExecutionAudit {
  commandId: string;
  resultKind: CommandCenterExecutionResultKind;
  sideEffectClass?: RelayCommandSideEffect;
  durationMs: number;
  args: CommandCenterExecutionArgsRedaction;
  policyOutcome: CommandCenterExecutionPolicyOutcome;
  confirmationOutcome: CommandCenterExecutionConfirmationOutcome;
  scopeKinds: readonly RelayCommandScopeKind[];
  availabilityState?: 'available' | 'unavailable' | 'unknown';
  capabilityOutcome:
    | 'not-required'
    | 'allowed-browser-session'
    | 'allowed-explicit'
    | 'blocked';
  reason?: string;
}

export interface CommandCenterExecutionSuccess {
  kind: 'success';
  commandId: RelayCliGatewayCommand;
  data: unknown;
  audit: CommandCenterExecutionAudit;
}

export interface CommandCenterExecutionBlocked {
  kind: 'blocked';
  commandId?: string;
  reason:
    | 'unknown-command'
    | 'invalid-args'
    | 'unsafe-command'
    | 'missing-capability'
    | 'unsupported-command'
    | 'metadata-mismatch';
  message: string;
  audit: CommandCenterExecutionAudit;
}

export interface CommandCenterExecutionConfirmationRequired {
  kind: 'confirmation_required';
  commandId: RelayCliGatewayCommand;
  reason: 'confirmation-required' | 'control-requirement';
  message: string;
  audit: CommandCenterExecutionAudit;
}

export interface CommandCenterExecutionUnavailable {
  kind: 'unavailable';
  commandId: RelayCliGatewayCommand;
  reason:
    | 'command-unavailable'
    | 'node-unavailable'
    | 'session-unavailable'
    | 'workspace-unavailable'
    | 'provider-unavailable'
    | 'not-found';
  message: string;
  details?: Record<string, unknown>;
  audit: CommandCenterExecutionAudit;
}

export interface CommandCenterExecutionError {
  kind: 'error';
  commandId: RelayCliGatewayCommand;
  reason: 'handler-error' | 'internal-error';
  message: string;
  audit: CommandCenterExecutionAudit;
}

export type CommandCenterExecutionResult =
  | CommandCenterExecutionSuccess
  | CommandCenterExecutionBlocked
  | CommandCenterExecutionConfirmationRequired
  | CommandCenterExecutionUnavailable
  | CommandCenterExecutionError;
