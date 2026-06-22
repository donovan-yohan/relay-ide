import type {
  CommandCenterNoMatchReason,
  CommandCenterResolution,
} from '../../../shared/command-center-resolver.js';
import type { Action, ActionContext } from './actions/types.js';

export interface CommandCenterIntentAuditView {
  outcome: string;
  reason?: string;
  commandId?: string;
  confidence?: number;
  durationMs?: number;
  suggestionCount: number;
}

export interface CommandCenterAssistantResult {
  resolution: CommandCenterResolution;
  audit: CommandCenterIntentAuditView;
}

export interface CommandCenterAssistantCopy {
  title: string;
  detail: string;
  tone: 'info' | 'success' | 'warning' | 'error';
  cta?: string;
}

const REASON_COPY: Record<CommandCenterNoMatchReason, string> = {
  'provider-missing': 'assistant resolver is not configured',
  'provider-unhealthy': 'assistant resolver is unhealthy',
  'provider-no-match': 'assistant could not map that to Relay',
  timeout: 'assistant resolver timed out',
  'provider-error': 'assistant resolver failed',
  'malformed-output': 'assistant returned malformed output',
  'low-confidence': 'assistant confidence was too low',
  'unknown-command': 'assistant picked an unknown command',
  'invalid-args': 'assistant needs more fields',
  'metadata-mismatch': 'assistant metadata did not match the action contract',
  'unsafe-command': 'policy blocked this action',
};

export function commandCenterAssistantCopy(
  resolution: CommandCenterResolution,
  options: { mobile?: boolean } = {}
): CommandCenterAssistantCopy {
  if (resolution.kind === 'open_ui') {
    return {
      title: 'guided ui match',
      detail: `${resolution.entry.label} can open an existing Relay surface. Review before continuing.`,
      tone: 'success',
      cta: options.mobile ? 'open guided sheet' : 'open ui',
    };
  }
  if (resolution.kind === 'ask_followup') {
    return {
      title: 'needs one more detail',
      detail: resolution.question,
      tone: 'warning',
    };
  }
  if (resolution.kind === 'explain') {
    return {
      title: 'assistant explanation',
      detail: resolution.message,
      tone: 'info',
    };
  }
  if (resolution.kind === 'execute_command') {
    return {
      title: 'preview only',
      detail: `${resolution.entry.label} is read-only, but natural-language execution is deferred to a later slice. Use the deterministic command entry below instead.`,
      tone: 'info',
    };
  }

  return {
    title: REASON_COPY[resolution.reason],
    detail:
      resolution.detail ??
      noMatchRecoveryCopy(resolution.reason, options.mobile === true),
    tone:
      resolution.reason === 'provider-missing' ||
      resolution.reason === 'provider-unhealthy' ||
      resolution.reason === 'timeout'
        ? 'warning'
        : resolution.reason === 'unsafe-command'
          ? 'error'
          : 'info',
  };
}

function noMatchRecoveryCopy(
  reason: CommandCenterNoMatchReason,
  mobile: boolean
): string {
  if (reason === 'provider-missing') {
    return 'deterministic Command Center search still works below.';
  }
  if (reason === 'provider-unhealthy' || reason === 'timeout') {
    return 'try again, or use deterministic Command Center search below.';
  }
  if (reason === 'invalid-args') {
    return mobile
      ? 'pick a guided action below so Relay can ask for missing fields.'
      : 'add the missing field or choose a deterministic action below.';
  }
  if (reason === 'unsafe-command') {
    return 'natural-language write, destructive, stream, and policy-gated execution is blocked in this slice.';
  }
  return 'try a more specific request, or choose a deterministic result below.';
}

export interface OpenUiActionDecision {
  canOpen: boolean;
  reason?: string;
  label?: string;
}

export function decideOpenUiAction(
  action: Action | undefined,
  ctx: ActionContext
): OpenUiActionDecision {
  if (!action) return { canOpen: false, reason: 'ui target is not registered' };
  const disabledReason =
    action.when && !action.when(ctx)
      ? (action.disabledReason?.(ctx) ?? 'not available in the current context')
      : undefined;
  if (disabledReason) return { canOpen: false, reason: disabledReason };
  if (action.category === 'gateway') {
    return {
      canOpen: false,
      reason: 'stable CLI gateway commands are preview-only in this shell',
      label: action.label,
    };
  }
  const descriptor = action.descriptor;
  if (descriptor?.confirmation.required) {
    return {
      canOpen: false,
      reason: 'confirmation-gated actions require the later execution slice',
      label: action.label,
    };
  }
  if (
    descriptor?.sideEffect === 'destructive' ||
    descriptor?.sideEffect === 'stream'
  ) {
    return {
      canOpen: false,
      reason: 'policy blocked direct natural-language execution',
      label: action.label,
    };
  }
  if (
    descriptor?.sideEffect === 'write' &&
    action.id !== 'session.start-work-in-env'
  ) {
    return {
      canOpen: false,
      reason: ctx.isMobile
        ? 'mobile assistant only opens guided flows for write-shaped actions'
        : 'write-shaped actions require a guided UI handoff',
      label: action.label,
    };
  }
  return { canOpen: true, label: action.label };
}

export function commandCenterSuggestionLabels(
  resolution: CommandCenterResolution,
  limit = 3
): string[] {
  return resolution.suggestions.slice(0, limit).map((hit) => hit.entry.label);
}
