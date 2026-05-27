/**
 * Prompt fanout run schema — issue #705.
 *
 * Relay-owned model for comparing one prompt across an explicit set of
 * selected agent/session targets. This is a mock/workbench data contract only:
 * no terminal input, provider chrome parsing, or rmux dependency lives here.
 */

import type { SessionRef, WorkContextRef } from './work-context.js';

export const PROMPT_FANOUT_RUN_SCHEMA_VERSION = 1;

export type PromptFanoutRunId = string;
export type PromptFanoutTargetId = string;

export type PromptFanoutRunState =
  | 'draft'
  | 'loading'
  | 'running'
  | 'completed'
  | 'partial-failure'
  | 'denied'
  | 'timeout'
  | 'empty';

export type PromptFanoutTargetStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'denied'
  | 'timeout'
  | 'skipped';

export interface PromptFanoutActorRef {
  kind: 'actor';
  id: string;
  displayName?: string;
  runtime?: 'claude' | 'codex' | 'opencode' | 'hermes' | 'custom';
  providerId?: string;
}

export interface PromptFanoutTarget {
  id: PromptFanoutTargetId;
  label: string;
  actorRef?: PromptFanoutActorRef;
  sessionRef?: SessionRef;
  nodeLabel?: string;
  selected: boolean;
  eligible: boolean;
  deniedReason?: string;
}

export interface PromptFanoutPromptMetadata {
  id: string;
  title: string;
  summary: string;
  bodyPreview: string;
  authorActorId?: string;
  createdAt: string;
  tokenEstimate?: number;
  dryRun: boolean;
  source: 'manual' | 'fixture' | 'work-context';
}

export interface PromptFanoutResponseSummary {
  summary: string;
  excerpt: string;
  normalizedAt: string;
  tokenCount?: number;
}

export interface PromptFanoutErrorSummary {
  code: string;
  message: string;
  retryable: boolean;
}

export interface PromptFanoutTargetResult {
  targetId: PromptFanoutTargetId;
  status: PromptFanoutTargetStatus;
  response?: PromptFanoutResponseSummary;
  error?: PromptFanoutErrorSummary;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
}

export interface PromptFanoutRun {
  schemaVersion: typeof PROMPT_FANOUT_RUN_SCHEMA_VERSION;
  id: PromptFanoutRunId;
  workContextId: WorkContextRef;
  state: PromptFanoutRunState;
  prompt: PromptFanoutPromptMetadata;
  allTargets: ReadonlyArray<PromptFanoutTarget>;
  selectedTargetIds: ReadonlyArray<PromptFanoutTargetId>;
  results: ReadonlyArray<PromptFanoutTargetResult>;
  errors: ReadonlyArray<PromptFanoutErrorSummary>;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
}

export function selectedPromptFanoutTargets(
  run: PromptFanoutRun
): PromptFanoutTarget[] {
  const selectedIds = new Set(run.selectedTargetIds);
  return run.allTargets.filter(
    (target) => target.selected && selectedIds.has(target.id)
  );
}

export function unselectedPromptFanoutTargets(
  run: PromptFanoutRun
): PromptFanoutTarget[] {
  const selectedIds = new Set(run.selectedTargetIds);
  return run.allTargets.filter(
    (target) => !target.selected || !selectedIds.has(target.id)
  );
}

export function promptFanoutHasPartialFailure(run: PromptFanoutRun): boolean {
  const statuses = run.results.map((result) => result.status);
  return (
    statuses.includes('succeeded') &&
    statuses.some((status) =>
      ['failed', 'denied', 'timeout', 'skipped'].includes(status)
    )
  );
}

export function promptFanoutStatusCounts(
  run: PromptFanoutRun
): Record<PromptFanoutTargetStatus, number> {
  const counts: Record<PromptFanoutTargetStatus, number> = {
    queued: 0,
    running: 0,
    succeeded: 0,
    failed: 0,
    denied: 0,
    timeout: 0,
    skipped: 0,
  };
  for (const result of run.results) {
    counts[result.status] += 1;
  }
  return counts;
}
