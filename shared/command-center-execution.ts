import type { RelayCliGatewayCommand } from './cli-gateway-contract.js';
import type {
  RelayCommandScopeKind,
  RelayCommandSideEffect,
} from './relay-command-manifest.js';
import type { RelayCapabilityBit } from './security-policy.js';

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
  | 'confirmed'
  | 'denied'
  | 'stale'
  | 'blocked';

export type CommandCenterConfirmationDecision = 'confirm' | 'deny';

export interface CommandCenterExecutionConfirmationInput {
  challengeId: string;
  decision: CommandCenterConfirmationDecision;
}

export interface CommandCenterExecutionArgsRedaction {
  rawArgsReturned: false;
  argKeys: readonly string[];
  argsSha256: string;
}

export interface CommandCenterExecutionActorAudit {
  kind: 'browser-session' | 'actor-grant' | 'unknown';
  id?: string;
  capabilities?: readonly RelayCapabilityBit[];
}

export interface CommandCenterExecutionProviderAudit {
  rawProviderPayloadReturned: false;
  source?: string;
  model?: string;
  requestId?: string;
  metadataKeys: readonly string[];
  metadataSha256?: string;
}

export interface CommandCenterExecutionExpectedResultShape {
  kind: string;
  title?: string;
  schemaType?: string | readonly string[];
}

export interface CommandCenterExecutionConfirmationPreview {
  challengeId: string;
  expiresAtMs: number;
  commandId: RelayCliGatewayCommand;
  label: string;
  scopedTarget: string;
  sideEffectClass: RelayCommandSideEffect;
  capabilityHints: readonly RelayCapabilityBit[];
  controlRequirements: readonly string[];
  args: CommandCenterExecutionArgsRedaction;
  expectedResultShape: CommandCenterExecutionExpectedResultShape;
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
  actor: CommandCenterExecutionActorAudit;
  provider?: CommandCenterExecutionProviderAudit;
  confirmationChallengeId?: string;
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
    | 'actor-scope-denied'
    | 'control-requirement-unsatisfied'
    | 'confirmation-denied'
    | 'confirmation-stale'
    | 'metadata-mismatch';
  message: string;
  audit: CommandCenterExecutionAudit;
}

export interface CommandCenterExecutionConfirmationRequired {
  kind: 'confirmation_required';
  commandId: RelayCliGatewayCommand;
  reason: 'confirmation-required' | 'control-requirement';
  message: string;
  preview: CommandCenterExecutionConfirmationPreview;
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
