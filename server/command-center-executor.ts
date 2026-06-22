import { createHash, randomUUID } from 'node:crypto';

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
  CommandCenterExecutionConfirmationInput,
  CommandCenterExecutionConfirmationPreview,
  CommandCenterExecutionConfirmationOutcome,
  CommandCenterExecutionProviderAudit,
  CommandCenterExecutionPolicyOutcome,
  CommandCenterExecutionResult,
  CommandCenterExecutionResultKind,
} from '../shared/command-center-execution.js';

export interface CommandCenterExecutionRequest {
  commandId: string;
  args?: unknown;
  confirmation?: CommandCenterExecutionConfirmationInput;
  providerMetadata?: Record<string, unknown>;
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

export type CommandCenterCommandHandler = CommandCenterReadOnlyHandler;

export interface CommandCenterConfirmationChallengeRecord {
  challengeId: string;
  commandId: RelayCliGatewayCommand;
  argsSha256: string;
  expiresAtMs: number;
}

export interface CommandCenterConfirmationStore {
  create(
    record: Omit<CommandCenterConfirmationChallengeRecord, 'challengeId'>
  ): CommandCenterConfirmationChallengeRecord;
  consume(input: {
    challengeId: string;
    commandId: RelayCliGatewayCommand;
    argsSha256: string;
    nowMs: number;
  }):
    | { ok: true; record: CommandCenterConfirmationChallengeRecord }
    | { ok: false; reason: 'missing' | 'mismatch' | 'expired' };
}

export interface CommandCenterExecutionDeps {
  catalog?: CommandCenterResolverCatalog;
  handlers: Partial<
    Record<RelayCliGatewayCommand, CommandCenterCommandHandler>
  >;
  trustedCapabilities?:
    | {
        source: 'browser-session' | 'actor-grant';
        capabilities: readonly RelayCapabilityBit[];
        actorId?: string;
      }
    | undefined;
  now?: () => number;
  auditSink?: (audit: CommandCenterExecutionAudit) => void;
  confirmationStore?: CommandCenterConfirmationStore;
}

const EMPTY_ARGS_HASH = sha256(canonicalJson({}));
const MAX_COMMAND_CENTER_ARG_DEPTH = 12;
const MAX_COMMAND_CENTER_ARG_KEYS = 100;
const MAX_COMMAND_CENTER_ARG_CHARS = 16_384;
const COMMAND_CENTER_CONFIRMATION_TTL_MS = 2 * 60 * 1000;
const MAX_COMMAND_CENTER_CONFIRMATIONS = 512;
const PROVIDER_AUDIT_FIELDS = ['source', 'model', 'requestId'] as const;
const MAX_PROVIDER_AUDIT_VALUE_CHARS = 256;

export function createCommandCenterConfirmationStore(): CommandCenterConfirmationStore {
  const records = new Map<string, CommandCenterConfirmationChallengeRecord>();
  const sweepExpired = (nowMs: number) => {
    for (const [challengeId, record] of Array.from(records.entries())) {
      if (record.expiresAtMs < nowMs) records.delete(challengeId);
    }
  };
  return {
    create(record) {
      sweepExpired(Date.now());
      while (records.size >= MAX_COMMAND_CENTER_CONFIRMATIONS) {
        const oldestChallengeId = records.keys().next().value;
        if (typeof oldestChallengeId !== 'string') break;
        records.delete(oldestChallengeId);
      }
      const challenge = { ...record, challengeId: randomUUID() };
      records.set(challenge.challengeId, challenge);
      return challenge;
    },
    consume(input) {
      const record = records.get(input.challengeId);
      if (!record) return { ok: false, reason: 'missing' };
      records.delete(input.challengeId);
      sweepExpired(input.nowMs);
      if (record.expiresAtMs < input.nowMs)
        return { ok: false, reason: 'expired' };
      if (
        record.commandId !== input.commandId ||
        record.argsSha256 !== input.argsSha256
      ) {
        return { ok: false, reason: 'mismatch' };
      }
      return { ok: true, record };
    },
  };
}

const DEFAULT_CONFIRMATION_STORE = createCommandCenterConfirmationStore();

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

function argsRedaction(args: unknown) {
  const safeArgs = isPlainObject(args) ? args : {};
  return {
    rawArgsReturned: false as const,
    argKeys: argKeys(safeArgs),
    argsSha256: sha256(canonicalJson(safeArgs)),
  };
}

function actorAudit(
  trusted: CommandCenterExecutionDeps['trustedCapabilities']
): CommandCenterExecutionAudit['actor'] {
  if (!trusted) return { kind: 'unknown' };
  return {
    kind: trusted.source,
    ...(trusted.actorId ? { id: trusted.actorId } : {}),
    capabilities: trusted.capabilities,
  };
}

function providerAudit(
  metadata: Record<string, unknown> | undefined
): CommandCenterExecutionProviderAudit | undefined {
  if (!metadata) return undefined;
  const safeMetadata: Partial<
    Record<(typeof PROVIDER_AUDIT_FIELDS)[number], string>
  > = {};
  for (const key of PROVIDER_AUDIT_FIELDS) {
    const value = metadata[key];
    if (typeof value !== 'string') continue;
    safeMetadata[key] = value.slice(0, MAX_PROVIDER_AUDIT_VALUE_CHARS);
  }
  const metadataKeys = Object.keys(safeMetadata).sort();
  return {
    rawProviderPayloadReturned: false,
    ...(typeof safeMetadata['source'] === 'string'
      ? { source: safeMetadata['source'] }
      : {}),
    ...(typeof safeMetadata['model'] === 'string'
      ? { model: safeMetadata['model'] }
      : {}),
    ...(typeof safeMetadata['requestId'] === 'string'
      ? { requestId: safeMetadata['requestId'] }
      : {}),
    metadataKeys,
    ...(metadataKeys.length > 0
      ? { metadataSha256: sha256(canonicalJson(safeMetadata)) }
      : {}),
  };
}

function expectedResultShape(
  entry: CommandCenterResolverCatalogEntry
): CommandCenterExecutionConfirmationPreview['expectedResultShape'] {
  return {
    kind: 'json-schema',
    ...(entry.outputSchema.title ? { title: entry.outputSchema.title } : {}),
    ...(entry.outputSchema.type ? { schemaType: entry.outputSchema.type } : {}),
  };
}

function scopedTarget(
  entry: CommandCenterResolverCatalogEntry,
  args: Record<string, unknown>
): string {
  for (const key of [
    'sessionId',
    'globalSessionId',
    'nodeId',
    'repoPath',
    'worktreePath',
    'workContextId',
    'id',
  ]) {
    const value = args[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      return `${key}:${sha256(value).slice(0, 12)}`;
    }
  }
  return entry.scopeKinds.length > 0
    ? `${entry.scopeKinds.join('+')}:unspecified`
    : 'global:unspecified';
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

function unsupportedControlRequirements(
  entry: CommandCenterResolverCatalogEntry
): string[] {
  return entry.controlRequirements.filter(
    (requirement) => requirement !== 'confirmation-challenge'
  );
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
  actor?: CommandCenterExecutionAudit['actor'];
  provider?: CommandCenterExecutionProviderAudit;
  confirmationChallengeId?: string;
  reason?: string;
}): CommandCenterExecutionAudit {
  const redactedArgs = isPlainObject(input.args)
    ? argsRedaction(input.args)
    : { ...argsRedaction({}), argsSha256: EMPTY_ARGS_HASH };
  return {
    commandId: input.commandId,
    resultKind: input.resultKind,
    ...(input.entry ? { sideEffectClass: input.entry.sideEffect } : {}),
    durationMs: input.durationMs,
    args: redactedArgs,
    policyOutcome: input.policyOutcome,
    confirmationOutcome: input.confirmationOutcome,
    scopeKinds: input.entry?.scopeKinds ?? [],
    ...(input.entry
      ? { availabilityState: input.entry.availability.state }
      : {}),
    capabilityOutcome: input.capabilityOutcome,
    actor: input.actor ?? { kind: 'unknown' },
    ...(input.provider ? { provider: input.provider } : {}),
    ...(input.confirmationChallengeId
      ? { confirmationChallengeId: input.confirmationChallengeId }
      : {}),
    ...(input.reason ? { reason: input.reason } : {}),
  };
}

function confirmationPreview(input: {
  store: CommandCenterConfirmationStore;
  entry: CommandCenterResolverCatalogEntry;
  args: Record<string, unknown>;
  nowMs: number;
}): CommandCenterExecutionConfirmationPreview {
  const redaction = argsRedaction(input.args);
  const challenge = input.store.create({
    commandId: input.entry.commandId,
    argsSha256: redaction.argsSha256,
    expiresAtMs: input.nowMs + COMMAND_CENTER_CONFIRMATION_TTL_MS,
  });
  return {
    challengeId: challenge.challengeId,
    expiresAtMs: challenge.expiresAtMs,
    commandId: input.entry.commandId,
    label: input.entry.label,
    scopedTarget: scopedTarget(input.entry, input.args),
    sideEffectClass: input.entry.sideEffect,
    capabilityHints: input.entry.capabilityHints,
    controlRequirements: input.entry.controlRequirements,
    args: redaction,
    expectedResultShape: expectedResultShape(input.entry),
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
  const auditActor = actorAudit(deps.trustedCapabilities);
  const auditProvider = providerAudit(request.providerMetadata);
  const confirmationStore =
    deps.confirmationStore ?? DEFAULT_CONFIRMATION_STORE;
  const makeAudit = (
    input: Omit<Parameters<typeof auditFor>[0], 'actor' | 'provider'>
  ) =>
    auditFor({
      ...input,
      actor: auditActor,
      ...(auditProvider ? { provider: auditProvider } : {}),
    });

  if (!argsBudgetOk(rawArgs)) {
    const audit = makeAudit({
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
    const audit = makeAudit({
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
    reason: string,
    confirmationChallengeId?: string
  ) =>
    makeAudit({
      commandId: entry.commandId,
      resultKind,
      entry,
      args: rawArgs,
      durationMs: duration(start, now),
      policyOutcome,
      confirmationOutcome,
      capabilityOutcome: caps,
      ...(confirmationChallengeId ? { confirmationChallengeId } : {}),
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

  const unsupportedControls = unsupportedControlRequirements(entry);
  if (unsupportedControls.length > 0) {
    const audit = blockedAudit(
      'blocked',
      'blocked',
      'blocked',
      'control-requirement-unsatisfied'
    );
    return finish(
      {
        kind: 'blocked',
        commandId: entry.commandId,
        reason: 'control-requirement-unsatisfied',
        message: `Command Center cannot execute ${entry.commandId} until these control requirements are validated: ${unsupportedControls.join(', ')}`,
        audit,
      },
      deps.auditSink
    );
  }
  const confirmationRequired =
    entry.requiresConfirmation ||
    entry.controlRequirements.includes('confirmation-challenge') ||
    entry.sideEffect !== 'read';
  let executionConfirmationOutcome: CommandCenterExecutionConfirmationOutcome =
    'not-required';

  if (confirmationRequired) {
    const reason =
      entry.controlRequirements.length > 0
        ? 'control-requirement'
        : 'confirmation-required';
    if (!request.confirmation) {
      const preview = confirmationPreview({
        store: confirmationStore,
        entry,
        args: rawArgs,
        nowMs: now(),
      });
      const audit = blockedAudit(
        'confirmation_required',
        'confirmation-required',
        'required',
        reason,
        preview.challengeId
      );
      return finish(
        {
          kind: 'confirmation_required',
          commandId: entry.commandId,
          reason,
          message: `${entry.label} requires explicit confirmation. Review the redacted preview and confirm or deny before execution.`,
          preview,
          audit,
        },
        deps.auditSink
      );
    }

    const consumed = confirmationStore.consume({
      challengeId: request.confirmation.challengeId,
      commandId: entry.commandId,
      argsSha256: argsRedaction(rawArgs).argsSha256,
      nowMs: now(),
    });
    if (consumed.ok === false) {
      const audit = blockedAudit(
        'blocked',
        'blocked',
        'stale',
        `confirmation-${consumed.reason}`,
        request.confirmation.challengeId
      );
      return finish(
        {
          kind: 'blocked',
          commandId: entry.commandId,
          reason: 'confirmation-stale',
          message:
            'The Command Center confirmation was stale, missing, or did not match the original redacted args.',
          audit,
        },
        deps.auditSink
      );
    }
    if (request.confirmation.decision === 'deny') {
      const audit = blockedAudit(
        'blocked',
        'blocked',
        'denied',
        'confirmation-denied',
        request.confirmation.challengeId
      );
      return finish(
        {
          kind: 'blocked',
          commandId: entry.commandId,
          reason: 'confirmation-denied',
          message: 'The operator denied the Command Center confirmation.',
          audit,
        },
        deps.auditSink
      );
    }
    executionConfirmationOutcome = 'confirmed';
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
          'This typed command passed policy checks, but Command Center execution is not wired for it yet.',
        audit,
      },
      deps.auditSink
    );
  }

  try {
    const handlerResult = await handler(rawArgs);
    if (handlerResult.ok === false) {
      const resultKind = handlerResult.kind;
      const audit = makeAudit({
        commandId: entry.commandId,
        resultKind,
        entry,
        args: rawArgs,
        durationMs: duration(start, now),
        policyOutcome: 'allowed',
        confirmationOutcome: executionConfirmationOutcome,
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

    const audit = makeAudit({
      commandId: entry.commandId,
      resultKind: 'success',
      entry,
      args: rawArgs,
      durationMs: duration(start, now),
      policyOutcome: 'allowed',
      confirmationOutcome: executionConfirmationOutcome,
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
    const audit = makeAudit({
      commandId: entry.commandId,
      resultKind: 'error',
      entry,
      args: rawArgs,
      durationMs: duration(start, now),
      policyOutcome: 'allowed',
      confirmationOutcome: executionConfirmationOutcome,
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
