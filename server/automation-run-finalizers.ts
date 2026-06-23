import {
  AutomationRunStoreError,
  type AutomationRunStore,
} from './automation-runs.js';
import type { AutomationRunRecord } from '../shared/automation-run.js';

export const RELAY_AUTOMATION_RUN_RETIRE_ACTION =
  'relay.automation_run.retire' as const;
export const RELAY_FINALIZER_ACTIONS = [
  RELAY_AUTOMATION_RUN_RETIRE_ACTION,
] as const;

export type RelayFinalizerAction = (typeof RELAY_FINALIZER_ACTIONS)[number];

export interface RelayFinalizerContext {
  resource?: unknown;
  finalizer?: unknown;
  trigger?: unknown;
}

export interface RelayFinalizerResult {
  ok: boolean;
  summary?: string;
  error?: string;
  evidence?: Record<string, unknown>[];
}

export interface RelayAutomationRunFinalizerOptions {
  store: AutomationRunStore;
  /** Optional owner/orchestrator guard. When set, mismatched runs are not retired. */
  ownerOrchestrator?: string | undefined;
  retiredBy?: string | undefined;
}

export class RelayAutomationRunFinalizerAdapter {
  readonly store: AutomationRunStore;
  readonly ownerOrchestrator?: string | undefined;
  readonly retiredBy?: string | undefined;

  constructor(options: RelayAutomationRunFinalizerOptions) {
    this.store = options.store;
    this.ownerOrchestrator = options.ownerOrchestrator;
    this.retiredBy = options.retiredBy;
  }

  retireAutomationRun(context: RelayFinalizerContext): RelayFinalizerResult {
    const contextRecord = asRecord(context);
    const finalizer = asRecord(contextRecord.finalizer);
    const action = readString(finalizer.action);
    if (action && action !== RELAY_AUTOMATION_RUN_RETIRE_ACTION) {
      return failed(
        `unsupported Relay finalizer action ${JSON.stringify(action)}`,
        action
      );
    }

    const automationRunId = automationRunIdFromContext(contextRecord);
    if (!automationRunId) {
      return failed(
        'Relay automation-run finalizer requires resource.handle.automationRunId',
        RELAY_AUTOMATION_RUN_RETIRE_ACTION
      );
    }

    const existing = this.store.get(automationRunId);
    if (!existing) {
      return {
        ok: true,
        summary: 'Relay automation run already absent',
        evidence: [
          {
            kind: RELAY_AUTOMATION_RUN_RETIRE_ACTION,
            automationRunId,
            found: false,
            retired: false,
            statusAfter: 'absent',
          },
        ],
      };
    }

    if (
      this.ownerOrchestrator &&
      existing.owner.orchestrator !== this.ownerOrchestrator
    ) {
      return failed(
        'Relay automation run owner does not match finalizer adapter owner',
        RELAY_AUTOMATION_RUN_RETIRE_ACTION,
        {
          kind: RELAY_AUTOMATION_RUN_RETIRE_ACTION,
          automationRunId,
          found: true,
          ownerMatched: false,
          ownerOrchestrator: existing.owner.orchestrator,
          statusBefore: existing.status,
          cleanupStateBefore: existing.cleanup.state,
        }
      );
    }

    try {
      const retired = this.store.retire(automationRunId, {
        reason: retireReason(contextRecord),
        retiredBy: this.retiredBy ?? 'dynamic-workflows-finalizer',
      });
      return success(existing, retired);
    } catch (error) {
      if (error instanceof AutomationRunStoreError && error.status === 404) {
        return {
          ok: true,
          summary: 'Relay automation run already absent',
          evidence: [
            {
              kind: RELAY_AUTOMATION_RUN_RETIRE_ACTION,
              automationRunId,
              found: false,
              retired: false,
              statusAfter: 'absent',
            },
          ],
        };
      }
      return failed(
        'Relay automation run could not be retired',
        RELAY_AUTOMATION_RUN_RETIRE_ACTION,
        {
          kind: RELAY_AUTOMATION_RUN_RETIRE_ACTION,
          automationRunId,
          found: true,
          statusBefore: existing.status,
          cleanupStateBefore: existing.cleanup.state,
          errorClass: error instanceof Error ? error.name : typeof error,
        }
      );
    }
  }
}

export function buildRelayAutomationRunFinalizerAdapter(
  options: RelayAutomationRunFinalizerOptions
): RelayAutomationRunFinalizerAdapter {
  return new RelayAutomationRunFinalizerAdapter(options);
}

export function registerRelayAutomationRunFinalizers(
  finalizerRegistry: {
    register(
      action: string,
      handler: (context: RelayFinalizerContext) => unknown,
      options?: { replace?: boolean }
    ): unknown;
  },
  options: RelayAutomationRunFinalizerOptions & { replace?: boolean }
): unknown {
  const adapter = buildRelayAutomationRunFinalizerAdapter(options);
  return finalizerRegistry.register(
    RELAY_AUTOMATION_RUN_RETIRE_ACTION,
    adapter.retireAutomationRun.bind(adapter),
    options.replace === undefined ? undefined : { replace: options.replace }
  );
}

function success(
  before: AutomationRunRecord,
  after: AutomationRunRecord
): RelayFinalizerResult {
  const wasRetired = before.cleanup.state === 'retired';
  return {
    ok: true,
    summary: wasRetired
      ? 'Relay automation run already retired'
      : 'Relay automation run retired',
    evidence: [
      {
        kind: RELAY_AUTOMATION_RUN_RETIRE_ACTION,
        automationRunId: after.id,
        found: true,
        wasRetired,
        retired: after.cleanup.state === 'retired',
        statusBefore: before.status,
        statusAfter: after.status,
        cleanupStateBefore: before.cleanup.state,
        cleanupStateAfter: after.cleanup.state,
        versionBefore: before.version,
        versionAfter: after.version,
        workContextId: after.workContextId,
        targetCount: after.targets.length,
      },
    ],
  };
}

function failed(
  message: string,
  action: string = RELAY_AUTOMATION_RUN_RETIRE_ACTION,
  evidence?: Record<string, unknown>
): RelayFinalizerResult {
  return {
    ok: false,
    error: message,
    evidence: [
      {
        kind: RELAY_AUTOMATION_RUN_RETIRE_ACTION,
        action,
        ...(evidence ?? {}),
      },
    ],
  };
}

function retireReason(context: Record<string, unknown>): string {
  const trigger = readString(context.trigger) ?? 'terminal';
  return `dynamic-workflows finalizer trigger=${trigger}`;
}

function automationRunIdFromContext(
  context: Record<string, unknown>
): string | undefined {
  const resource = asRecord(context.resource);
  const finalizer = asRecord(context.finalizer);
  const handle = asRecord(resource.handle);
  const args = asRecord(finalizer.args);
  return (
    readString(handle.automationRunId) ??
    readString(handle.automation_run_id) ??
    readString(handle.id) ??
    readString(args.automationRunId) ??
    readString(args.automation_run_id)
  );
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
