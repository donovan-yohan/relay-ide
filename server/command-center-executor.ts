import { createHash } from 'node:crypto';

import {
  COMMAND_CENTER_RESOLVER_CATALOG,
  validateCommandCenterArgs,
  type CommandCenterResolverCatalog,
  type CommandCenterResolverCatalogEntry,
} from '../shared/command-center-resolver.js';
import type { RelayCliGatewayCommand } from '../shared/cli-gateway-contract.js';
import type { RelayCapabilityBit } from '../shared/security-policy.js';
import type {
  CommandCenterExecutionAudit,
  CommandCenterExecutionConfirmationOutcome,
  CommandCenterExecutionPolicyOutcome,
  CommandCenterExecutionResult,
  CommandCenterExecutionResultKind,
} from '../shared/command-center-execution.js';

export interface CommandCenterExecutionRequest {
  commandId: string;
  args?: unknown;
}

export type CommandCenterReadOnlyHandlerResult =
  | { ok: true; data: unknown }
  | {
      ok: false;
      kind: 'unavailable' | 'error';
      reason: string;
      message: string;
      details?: Record<string, unknown>;
    };

export type CommandCenterReadOnlyHandler = (
  args: Record<string, unknown>
) =>
  | Promise<CommandCenterReadOnlyHandlerResult>
  | CommandCenterReadOnlyHandlerResult;

export interface CommandCenterExecutionDeps {
  catalog?: CommandCenterResolverCatalog;
  handlers: Partial<
    Record<RelayCliGatewayCommand, CommandCenterReadOnlyHandler>
  >;
  trustedCapabilities?:
    | {
        source: 'browser-session' | 'actor-grant';
        capabilities: readonly RelayCapabilityBit[];
      }
    | undefined;
  now?: () => number;
  auditSink?: (audit: CommandCenterExecutionAudit) => void;
}

const EMPTY_ARGS_HASH = sha256(canonicalJson({}));
const MAX_COMMAND_CENTER_ARG_DEPTH = 12;
const MAX_COMMAND_CENTER_ARG_KEYS = 100;
const MAX_COMMAND_CENTER_ARG_CHARS = 16_384;

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function jsonType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (Number.isInteger(value)) return 'integer';
  return typeof value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return jsonType(value) === 'object';
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => [key, canonicalize(child)])
  );
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function argKeys(args: unknown): string[] {
  if (!isPlainObject(args)) return [];
  return Object.keys(args).sort();
}

function capabilityOutcome(
  required: readonly RelayCapabilityBit[],
  trusted: CommandCenterExecutionDeps['trustedCapabilities']
): CommandCenterExecutionAudit['capabilityOutcome'] {
  if (required.length === 0) return 'not-required';
  if (!trusted) return 'blocked';
  if (trusted.source === 'browser-session') return 'allowed-browser-session';
  const granted = new Set(trusted.capabilities);
  return required.every((capability) => granted.has(capability))
    ? 'allowed-explicit'
    : 'blocked';
}

function argsBudgetOk(value: unknown): boolean {
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let keys = 0;
  let chars = 0;

  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current.depth > MAX_COMMAND_CENTER_ARG_DEPTH) return false;
    const child = current.value;
    if (typeof child === 'string') chars += child.length;
    else if (typeof child === 'number' || typeof child === 'boolean')
      chars += 8;
    else if (Array.isArray(child)) {
      keys += child.length;
      for (const item of child) {
        stack.push({ value: item, depth: current.depth + 1 });
      }
    } else if (isPlainObject(child)) {
      const entries = Object.entries(child);
      keys += entries.length;
      chars += entries.reduce((total, [key]) => total + key.length, 0);
      for (const [, item] of entries) {
        stack.push({ value: item, depth: current.depth + 1 });
      }
    }
    if (
      keys > MAX_COMMAND_CENTER_ARG_KEYS ||
      chars > MAX_COMMAND_CENTER_ARG_CHARS
    ) {
      return false;
    }
  }
  return true;
}

function auditFor(input: {
  commandId: string;
  resultKind: CommandCenterExecutionResultKind;
  entry?: CommandCenterResolverCatalogEntry;
  args: unknown;
  durationMs: number;
  policyOutcome: CommandCenterExecutionPolicyOutcome;
  confirmationOutcome: CommandCenterExecutionConfirmationOutcome;
  capabilityOutcome: CommandCenterExecutionAudit['capabilityOutcome'];
  reason?: string;
}): CommandCenterExecutionAudit {
  const args = isPlainObject(input.args) ? input.args : {};
  return {
    commandId: input.commandId,
    resultKind: input.resultKind,
    ...(input.entry ? { sideEffectClass: input.entry.sideEffect } : {}),
    durationMs: input.durationMs,
    args: {
      rawArgsReturned: false,
      argKeys: argKeys(args),
      argsSha256: isPlainObject(input.args)
        ? sha256(canonicalJson(args))
        : EMPTY_ARGS_HASH,
    },
    policyOutcome: input.policyOutcome,
    confirmationOutcome: input.confirmationOutcome,
    scopeKinds: input.entry?.scopeKinds ?? [],
    ...(input.entry
      ? { availabilityState: input.entry.availability.state }
      : {}),
    capabilityOutcome: input.capabilityOutcome,
    ...(input.reason ? { reason: input.reason } : {}),
  };
}

function finish(
  result: CommandCenterExecutionResult,
  sink: CommandCenterExecutionDeps['auditSink']
): CommandCenterExecutionResult {
  sink?.(result.audit);
  return result;
}

function duration(start: number, now: () => number): number {
  return Math.max(0, now() - start);
}

export async function executeCommandCenterCommand(
  request: CommandCenterExecutionRequest,
  deps: CommandCenterExecutionDeps
): Promise<CommandCenterExecutionResult> {
  const now = deps.now ?? Date.now;
  const start = now();
  const catalog = deps.catalog ?? COMMAND_CENTER_RESOLVER_CATALOG;
  const rawArgs = request.args ?? {};
  const baseCommandId =
    typeof request.commandId === 'string' ? request.commandId : 'unknown';

  if (!argsBudgetOk(rawArgs)) {
    const audit = auditFor({
      commandId: baseCommandId,
      resultKind: 'blocked',
      args: {},
      durationMs: duration(start, now),
      policyOutcome: 'blocked',
      confirmationOutcome: 'blocked',
      capabilityOutcome: 'not-required',
      reason: 'args-over-budget',
    });
    return finish(
      {
        kind: 'blocked',
        commandId: baseCommandId,
        reason: 'invalid-args',
        message:
          'Command Center command args exceeded the bounded read-only budget.',
        audit,
      },
      deps.auditSink
    );
  }

  const entry = catalog.byCommandId.get(
    baseCommandId as RelayCliGatewayCommand
  );
  if (!entry) {
    const audit = auditFor({
      commandId: baseCommandId,
      resultKind: 'blocked',
      args: rawArgs,
      durationMs: duration(start, now),
      policyOutcome: 'blocked',
      confirmationOutcome: 'blocked',
      capabilityOutcome: 'not-required',
      reason: 'unknown-command',
    });
    return finish(
      {
        kind: 'blocked',
        commandId: baseCommandId,
        reason: 'unknown-command',
        message:
          'Command Center can only execute Relay-owned typed command ids.',
        audit,
      },
      deps.auditSink
    );
  }

  const caps = capabilityOutcome(
    entry.capabilityHints,
    deps.trustedCapabilities
  );
  const blockedAudit = (
    resultKind: CommandCenterExecutionResultKind,
    policyOutcome: CommandCenterExecutionPolicyOutcome,
    confirmationOutcome: CommandCenterExecutionConfirmationOutcome,
    reason: string
  ) =>
    auditFor({
      commandId: entry.commandId,
      resultKind,
      entry,
      args: rawArgs,
      durationMs: duration(start, now),
      policyOutcome,
      confirmationOutcome,
      capabilityOutcome: caps,
      reason,
    });

  if (!isPlainObject(rawArgs)) {
    const audit = blockedAudit('blocked', 'blocked', 'blocked', 'invalid-args');
    return finish(
      {
        kind: 'blocked',
        commandId: entry.commandId,
        reason: 'invalid-args',
        message: 'Command Center command args must be a JSON object.',
        audit,
      },
      deps.auditSink
    );
  }

  const argErrors = validateCommandCenterArgs(rawArgs, entry.inputSchema);
  if (argErrors.length > 0) {
    const audit = blockedAudit('blocked', 'blocked', 'blocked', 'invalid-args');
    return finish(
      {
        kind: 'blocked',
        commandId: entry.commandId,
        reason: 'invalid-args',
        message: argErrors.slice(0, 3).join('; '),
        audit,
      },
      deps.auditSink
    );
  }

  if (entry.requiresConfirmation) {
    const audit = blockedAudit(
      'confirmation_required',
      'confirmation-required',
      'required',
      'confirmation-required'
    );
    return finish(
      {
        kind: 'confirmation_required',
        commandId: entry.commandId,
        reason: 'confirmation-required',
        message:
          'Natural-language execution cannot satisfy confirmation-gated commands in this slice.',
        audit,
      },
      deps.auditSink
    );
  }

  if (entry.controlRequirements.length > 0) {
    const audit = blockedAudit(
      'confirmation_required',
      'confirmation-required',
      'required',
      'control-requirement'
    );
    return finish(
      {
        kind: 'confirmation_required',
        commandId: entry.commandId,
        reason: 'control-requirement',
        message:
          'This command requires fresh control/intervention state and is preview-only in this slice.',
        audit,
      },
      deps.auditSink
    );
  }

  if (entry.sideEffect !== 'read') {
    const audit = blockedAudit(
      'blocked',
      'blocked',
      'blocked',
      'unsafe-command'
    );
    return finish(
      {
        kind: 'blocked',
        commandId: entry.commandId,
        reason: 'unsafe-command',
        message:
          'Natural-language execution is limited to read-only Relay commands.',
        audit,
      },
      deps.auditSink
    );
  }

  if (entry.availability.state !== 'available') {
    const audit = blockedAudit(
      'unavailable',
      'blocked',
      'blocked',
      'command-unavailable'
    );
    return finish(
      {
        kind: 'unavailable',
        commandId: entry.commandId,
        reason: 'command-unavailable',
        message: entry.availability.reason ?? 'command is unavailable',
        audit,
      },
      deps.auditSink
    );
  }

  if (caps === 'blocked') {
    const audit = blockedAudit(
      'blocked',
      'blocked',
      'blocked',
      'missing-capability'
    );
    return finish(
      {
        kind: 'blocked',
        commandId: entry.commandId,
        reason: 'missing-capability',
        message: `missing required capability: ${entry.capabilityHints.join(', ')}`,
        audit,
      },
      deps.auditSink
    );
  }

  const handler = deps.handlers[entry.commandId];
  if (!handler) {
    const audit = blockedAudit(
      'blocked',
      'blocked',
      'blocked',
      'unsupported-command'
    );
    return finish(
      {
        kind: 'blocked',
        commandId: entry.commandId,
        reason: 'unsupported-command',
        message:
          'This read-only command is typed, but Command Center execution is not wired for it yet.',
        audit,
      },
      deps.auditSink
    );
  }

  try {
    const handlerResult = await handler(rawArgs);
    if (handlerResult.ok === false) {
      const resultKind = handlerResult.kind;
      const audit = auditFor({
        commandId: entry.commandId,
        resultKind,
        entry,
        args: rawArgs,
        durationMs: duration(start, now),
        policyOutcome: 'allowed',
        confirmationOutcome: 'not-required',
        capabilityOutcome: caps,
        reason: handlerResult.reason,
      });
      if (handlerResult.kind === 'unavailable') {
        return finish(
          {
            kind: 'unavailable',
            commandId: entry.commandId,
            reason: handlerResult.reason as 'not-found',
            message: handlerResult.message,
            ...(handlerResult.details
              ? { details: handlerResult.details }
              : {}),
            audit,
          },
          deps.auditSink
        );
      }
      return finish(
        {
          kind: 'error',
          commandId: entry.commandId,
          reason: 'handler-error',
          message: handlerResult.message,
          audit,
        },
        deps.auditSink
      );
    }

    const audit = auditFor({
      commandId: entry.commandId,
      resultKind: 'success',
      entry,
      args: rawArgs,
      durationMs: duration(start, now),
      policyOutcome: 'allowed',
      confirmationOutcome: 'not-required',
      capabilityOutcome: caps,
    });
    return finish(
      {
        kind: 'success',
        commandId: entry.commandId,
        data: handlerResult.data,
        audit,
      },
      deps.auditSink
    );
  } catch {
    const audit = auditFor({
      commandId: entry.commandId,
      resultKind: 'error',
      entry,
      args: rawArgs,
      durationMs: duration(start, now),
      policyOutcome: 'allowed',
      confirmationOutcome: 'not-required',
      capabilityOutcome: caps,
      reason: 'internal-error',
    });
    return finish(
      {
        kind: 'error',
        commandId: entry.commandId,
        reason: 'internal-error',
        message: 'Command Center command handler failed.',
        audit,
      },
      deps.auditSink
    );
  }
}
