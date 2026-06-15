import { parseGlobalSessionId, type GlobalSessionId } from './identity.js';
import type { TaskRef, TaskRefKind, WorkContextId } from './work-context.js';

/**
 * Automation-run / watchdog registry (#959).
 *
 * A Relay-visible record of an operator cron, watchdog, or automation that is
 * driving one or more Relay sessions. The point of the registry is that the
 * *target* state (which sessions a watcher points at) and the *liveness* of
 * those targets become visible from Relay itself, so a watchdog cron that keeps
 * firing at a session id that no longer exists is obvious and retirable instead
 * of silent. This is intentionally separate from `workflow-run.ts`, which is the
 * provider-runtime workflow-VM projection (Hermes dynamic workflows), not an
 * operator watcher registry.
 */
export const AUTOMATION_RUN_SCHEMA_VERSION = 1 as const;

/** Coarse kind of automation. A hint, not an authorization boundary. */
export const AUTOMATION_RUN_KINDS = [
  'watchdog',
  'cron',
  'automation',
  'oversight',
  'manual',
] as const;
export type AutomationRunKind = (typeof AUTOMATION_RUN_KINDS)[number];

/** Derived run status. Never written directly; always computed from targets + heartbeat. */
export const AUTOMATION_RUN_STATUSES = [
  'active',
  'stale',
  'cleanup-needed',
  'retired',
] as const;
export type AutomationRunStatus = (typeof AUTOMATION_RUN_STATUSES)[number];

/** Derived liveness of a single target session. */
export const AUTOMATION_RUN_TARGET_STATES = [
  'alive',
  'gone',
  'ended',
  'unknown',
] as const;
export type AutomationRunTargetState = (typeof AUTOMATION_RUN_TARGET_STATES)[number];

/** Derived reasons a run is stale / needs cleanup. */
export const AUTOMATION_RUN_STALE_REASONS = [
  'target-session-gone',
  'target-session-ended',
  'heartbeat-expired',
  'hard-expiry',
] as const;
export type AutomationRunStaleReason = (typeof AUTOMATION_RUN_STALE_REASONS)[number];

/** Cleanup lifecycle of a run. `retired` is terminal. */
export const AUTOMATION_RUN_CLEANUP_STATES = ['none', 'needed', 'retired'] as const;
export type AutomationRunCleanupState = (typeof AUTOMATION_RUN_CLEANUP_STATES)[number];

export interface AutomationRunTarget {
  /** Local session id (`<session-id>`). */
  sessionId?: string | undefined;
  /** Scoped global session key (`local:<id>` / `<nodeId>:<id>`). */
  globalSessionId?: GlobalSessionId | undefined;
  label?: string | undefined;
  /** Last resolved liveness for this target. */
  lastKnownState: AutomationRunTargetState;
  lastCheckedAt?: string | undefined;
}

export interface AutomationRunOwner {
  /** Orchestrator label, e.g. `hermes`, `ebi`, `operator`. */
  orchestrator: string;
  actorId?: string | undefined;
  actorType?: string | undefined;
}

export interface AutomationRunLinks {
  taskRefs?: Pick<TaskRef, 'kind' | 'id' | 'title' | 'url' | 'status'>[] | undefined;
  /** Linked PR URLs (e.g. the PR a watchdog oversees). */
  prUrls?: string[] | undefined;
  /** Linked issue URLs. */
  issueUrls?: string[] | undefined;
}

export interface AutomationRunHeartbeat {
  /** Heartbeat TTL: a run that does not re-observe within this window goes stale. */
  ttlSeconds: number;
  lastObservedAt: string;
  /** `lastObservedAt + ttlSeconds`. A read after this instant derives `heartbeat-expired`. */
  expiresAt: string;
}

export interface AutomationRunObservation {
  observedAt: string;
  summary?: string | undefined;
}

export interface AutomationRunCleanup {
  state: AutomationRunCleanupState;
  reason?: string | undefined;
  retiredAt?: string | undefined;
  retiredBy?: string | undefined;
}

export interface AutomationRunRedaction {
  rawPayloadStored: false;
  rawTranscriptStored: false;
  truncated: boolean;
  omittedKeys: string[];
}

export interface AutomationRunRecord {
  schemaVersion: typeof AUTOMATION_RUN_SCHEMA_VERSION;
  id: string;
  name: string;
  kind: AutomationRunKind;
  /** External runtime/cron id (e.g. a Hermes cron `e059bf471bd0`). */
  runId?: string | undefined;
  owner: AutomationRunOwner;
  repoPath?: string | undefined;
  workContextId?: WorkContextId | undefined;
  targets: AutomationRunTarget[];
  links?: AutomationRunLinks | undefined;
  /** Optional hard deadline; past it the run derives `hard-expiry` regardless of heartbeat. */
  expiresAt?: string | undefined;
  /** Derived. */
  status: AutomationRunStatus;
  /** Derived. */
  staleReasons: AutomationRunStaleReason[];
  heartbeat: AutomationRunHeartbeat;
  lastObservation?: AutomationRunObservation | undefined;
  cleanup: AutomationRunCleanup;
  createdAt: string;
  updatedAt: string;
  version: number;
  redaction: AutomationRunRedaction;
}

export interface AutomationRunRegisterInput {
  id?: string | undefined;
  name: string;
  kind: AutomationRunKind;
  runId?: string | undefined;
  owner: AutomationRunOwner;
  repoPath?: string | undefined;
  workContextId?: WorkContextId | undefined;
  targets: AutomationRunTarget[];
  links?: AutomationRunLinks | undefined;
  expiresAt?: string | undefined;
  ttlSeconds: number;
  observationSummary?: string | undefined;
  createdAt?: string | undefined;
}

export interface AutomationRunObserveInput {
  summary?: string | undefined;
  /** Optionally replace the target set on observe (e.g. the watcher reattached). */
  targets?: AutomationRunTarget[] | undefined;
  ttlSeconds?: number | undefined;
  expiresAt?: string | undefined;
}

export interface AutomationRunRetireInput {
  reason?: string | undefined;
  retiredBy?: string | undefined;
}

export interface AutomationRunListFilter {
  workContextId?: string | undefined;
  repoPath?: string | undefined;
  status?: AutomationRunStatus | undefined;
  kind?: AutomationRunKind | undefined;
  orchestrator?: string | undefined;
  includeRetired?: boolean | undefined;
  limit?: number | undefined;
}

/** A pure resolver from a target descriptor to its current liveness. */
export type AutomationRunLivenessResolver = (target: {
  sessionId?: string | undefined;
  globalSessionId?: string | undefined;
}) => AutomationRunTargetState;

/** Minimal session shape the production liveness probe needs. */
export interface AutomationRunSessionLiveness {
  id?: string | undefined;
  globalSessionId?: string | undefined;
  /** #614 derived durability; `ended` marks a finished/cleaned-up (done) session. */
  durability?: string | undefined;
}

/**
 * Pure production liveness probe: resolve a target session against a snapshot
 * of the local session registry.
 *
 * - A target whose `globalSessionId` is scoped to a **non-local** node resolves
 *   `unknown` — cross-node target liveness is a documented follow-up, and
 *   reporting `gone` would falsely flag a healthy remote watcher as stale.
 * - A present session whose durability is `ended` (finished / cleaned up)
 *   resolves `ended` (the "done" half of #959's 404/killed/done).
 * - A present, non-ended session resolves `alive`.
 * - An absent local target resolves `gone` (404 / killed).
 */
export function resolveAutomationRunTargetLiveness(
  target: { sessionId?: string | undefined; globalSessionId?: string | undefined },
  sessions: readonly AutomationRunSessionLiveness[],
  localNodeId: string
): AutomationRunTargetState {
  if (target.globalSessionId) {
    const parsed = parseGlobalSessionId(target.globalSessionId);
    if (parsed && parsed.nodeId !== localNodeId) return 'unknown';
  }
  const match = sessions.find((session) => {
    if (
      target.sessionId &&
      (session.id === target.sessionId || session.globalSessionId === target.sessionId)
    ) {
      return true;
    }
    if (
      target.globalSessionId &&
      (session.globalSessionId === target.globalSessionId || session.id === target.globalSessionId)
    ) {
      return true;
    }
    return false;
  });
  if (!match) return 'gone';
  return match.durability === 'ended' ? 'ended' : 'alive';
}

export const AUTOMATION_RUN_SUMMARY_MAX_BYTES = 4 * 1024;
export const AUTOMATION_RUN_MAX_TARGETS = 100;
export const AUTOMATION_RUN_MAX_LINKS = 50;
export const AUTOMATION_RUN_MAX_INPUT_DEPTH = 20;
export const AUTOMATION_RUN_TTL_MIN_SECONDS = 30;
export const AUTOMATION_RUN_TTL_MAX_SECONDS = 7 * 24 * 60 * 60;
export const AUTOMATION_RUN_TTL_DEFAULT_SECONDS = 300;

const SECRETISH_KEYS = new Set<string>([
  'rawcontent',
  'rawpayload',
  'rawtranscript',
  'terminaltranscript',
  'transcript',
  'prompt',
  'prompts',
  'messages',
  'secret',
  'secrets',
  'env',
  'token',
  'apikey',
  'api_key',
  'providerauth',
  'providerprivate',
  'providerprivatestate',
  'cookie',
  'cookies',
  'password',
  'credential',
  'credentials',
]);
const TASK_REF_KINDS = new Set<string>([
  'github-issue',
  'github-pr',
  'kanban-task',
  'jira-ticket',
  'linear-issue',
  'external',
]);
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export class AutomationRunValidationError extends Error {
  constructor(
    message: string,
    public readonly details: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = 'AutomationRunValidationError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function stringField(input: Record<string, unknown>, key: string): string | undefined {
  return optionalString(input[key]);
}

function requireString(input: Record<string, unknown>, key: string): string {
  const value = stringField(input, key);
  if (!value) throw new AutomationRunValidationError(`${key} is required`, { field: key });
  return value;
}

function truncateUtf8(value: string, maxBytes: number): { value: string; truncated: boolean } {
  const encoded = textEncoder.encode(value);
  if (encoded.length <= maxBytes) return { value, truncated: false };
  return {
    value: textDecoder.decode(encoded.slice(0, maxBytes)).replace(/�+$/u, ''),
    truncated: true,
  };
}

function collectForbiddenKeys(
  value: unknown,
  path = '$',
  found: string[] = [],
  depth = 0
): string[] {
  if (depth > AUTOMATION_RUN_MAX_INPUT_DEPTH) {
    throw new AutomationRunValidationError('automation run payload exceeds maximum nested depth', {
      path,
      maxDepth: AUTOMATION_RUN_MAX_INPUT_DEPTH,
    });
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      collectForbiddenKeys(item, `${path}[${index}]`, found, depth + 1)
    );
    return found;
  }
  if (!isRecord(value)) return found;
  for (const [key, child] of Object.entries(value)) {
    const normalized = key.toLowerCase().replace(/[^a-z0-9_]/g, '');
    if (SECRETISH_KEYS.has(normalized)) {
      found.push(`${path}.${key}`);
      continue;
    }
    collectForbiddenKeys(child, `${path}.${key}`, found, depth + 1);
  }
  return found;
}

function parseKind(value: unknown): AutomationRunKind {
  if (typeof value !== 'string' || !(AUTOMATION_RUN_KINDS as readonly string[]).includes(value)) {
    throw new AutomationRunValidationError('kind must be a known AutomationRunKind', {
      field: 'kind',
      allowed: AUTOMATION_RUN_KINDS,
    });
  }
  return value as AutomationRunKind;
}

export function parseAutomationRunStatus(value: unknown): AutomationRunStatus | undefined {
  return typeof value === 'string' &&
    (AUTOMATION_RUN_STATUSES as readonly string[]).includes(value)
    ? (value as AutomationRunStatus)
    : undefined;
}

function clampTtl(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  const rounded = Math.round(value);
  return Math.min(
    AUTOMATION_RUN_TTL_MAX_SECONDS,
    Math.max(AUTOMATION_RUN_TTL_MIN_SECONDS, rounded)
  );
}

function parseExpiresAt(value: unknown): string | undefined {
  const raw = optionalString(value);
  if (!raw) return undefined;
  if (Number.isNaN(Date.parse(raw))) {
    throw new AutomationRunValidationError('expiresAt must be an ISO date-time string', {
      field: 'expiresAt',
    });
  }
  return new Date(raw).toISOString();
}

function parseOwner(value: unknown): AutomationRunOwner {
  if (!isRecord(value)) {
    throw new AutomationRunValidationError('owner is required', { field: 'owner' });
  }
  return {
    orchestrator: requireString(value, 'orchestrator'),
    ...(stringField(value, 'actorId') ? { actorId: stringField(value, 'actorId') } : {}),
    ...(stringField(value, 'actorType') ? { actorType: stringField(value, 'actorType') } : {}),
  };
}

function parseTargets(value: unknown): AutomationRunTarget[] {
  if (!Array.isArray(value)) {
    throw new AutomationRunValidationError('targets must be a non-empty array', {
      field: 'targets',
    });
  }
  const targets: AutomationRunTarget[] = [];
  for (const entry of value.slice(0, AUTOMATION_RUN_MAX_TARGETS)) {
    if (!isRecord(entry)) continue;
    const sessionId = stringField(entry, 'sessionId');
    const globalSessionId = stringField(entry, 'globalSessionId');
    if (!sessionId && !globalSessionId) {
      throw new AutomationRunValidationError(
        'each target requires sessionId or globalSessionId',
        { field: 'targets' }
      );
    }
    const lastKnownState =
      typeof entry['lastKnownState'] === 'string' &&
      (AUTOMATION_RUN_TARGET_STATES as readonly string[]).includes(entry['lastKnownState'])
        ? (entry['lastKnownState'] as AutomationRunTargetState)
        : 'unknown';
    targets.push({
      ...(sessionId ? { sessionId } : {}),
      ...(globalSessionId ? { globalSessionId: globalSessionId as GlobalSessionId } : {}),
      ...(stringField(entry, 'label') ? { label: stringField(entry, 'label') } : {}),
      lastKnownState,
      ...(stringField(entry, 'lastCheckedAt')
        ? { lastCheckedAt: stringField(entry, 'lastCheckedAt') }
        : {}),
    });
  }
  if (targets.length === 0) {
    throw new AutomationRunValidationError('targets must include at least one session', {
      field: 'targets',
    });
  }
  return targets;
}

function parseStringList(value: unknown, limit: number): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const strings = value
    .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    .map((item) => item.trim())
    .slice(0, limit);
  return strings.length ? strings : undefined;
}

function parseTaskRefs(value: unknown): AutomationRunLinks['taskRefs'] | undefined {
  if (!Array.isArray(value)) return undefined;
  const refs: NonNullable<AutomationRunLinks['taskRefs']> = [];
  for (const entry of value.slice(0, AUTOMATION_RUN_MAX_LINKS)) {
    if (!isRecord(entry)) continue;
    const kind = stringField(entry, 'kind');
    const id = stringField(entry, 'id');
    if (!kind || !id || !TASK_REF_KINDS.has(kind)) continue;
    const ref: Pick<TaskRef, 'kind' | 'id' | 'title' | 'url' | 'status'> = {
      kind: kind as TaskRefKind,
      id,
    };
    const title = stringField(entry, 'title');
    const url = stringField(entry, 'url');
    const status = stringField(entry, 'status');
    if (title) ref.title = title;
    if (url) ref.url = url;
    if (status) ref.status = status;
    refs.push(ref);
  }
  return refs.length ? refs : undefined;
}

function parseLinks(value: unknown): AutomationRunLinks | undefined {
  if (!isRecord(value)) return undefined;
  const links: AutomationRunLinks = {};
  const taskRefs = parseTaskRefs(value['taskRefs']);
  if (taskRefs?.length) links.taskRefs = taskRefs;
  const prUrls = parseStringList(value['prUrls'], AUTOMATION_RUN_MAX_LINKS);
  if (prUrls?.length) links.prUrls = prUrls;
  const issueUrls = parseStringList(value['issueUrls'], AUTOMATION_RUN_MAX_LINKS);
  if (issueUrls?.length) links.issueUrls = issueUrls;
  return Object.keys(links).length ? links : undefined;
}

function rejectForbiddenKeys(input: Record<string, unknown>): void {
  const omittedKeys = collectForbiddenKeys(input);
  if (omittedKeys.length > 0) {
    throw new AutomationRunValidationError(
      'automation run payload contains forbidden raw/private fields',
      { omittedKeys }
    );
  }
}

export function parseAutomationRunRegisterInput(value: unknown): AutomationRunRegisterInput & {
  redaction: AutomationRunRedaction;
} {
  if (!isRecord(value)) {
    throw new AutomationRunValidationError('automation run register payload must be an object');
  }
  rejectForbiddenKeys(value);
  const summaryRaw = optionalString(value['observationSummary']);
  const summary = summaryRaw
    ? truncateUtf8(summaryRaw, AUTOMATION_RUN_SUMMARY_MAX_BYTES)
    : undefined;
  const links = parseLinks(value['links']);
  return {
    name: requireString(value, 'name'),
    kind: parseKind(value['kind']),
    owner: parseOwner(value['owner']),
    targets: parseTargets(value['targets']),
    ttlSeconds: clampTtl(value['ttlSeconds'], AUTOMATION_RUN_TTL_DEFAULT_SECONDS),
    ...(stringField(value, 'id') ? { id: stringField(value, 'id') } : {}),
    ...(stringField(value, 'runId') ? { runId: stringField(value, 'runId') } : {}),
    ...(stringField(value, 'repoPath') ? { repoPath: stringField(value, 'repoPath') } : {}),
    ...(stringField(value, 'workContextId')
      ? { workContextId: stringField(value, 'workContextId') as WorkContextId }
      : {}),
    ...(links ? { links } : {}),
    ...(parseExpiresAt(value['expiresAt']) ? { expiresAt: parseExpiresAt(value['expiresAt']) } : {}),
    ...(summary ? { observationSummary: summary.value } : {}),
    ...(stringField(value, 'createdAt') ? { createdAt: stringField(value, 'createdAt') } : {}),
    redaction: {
      rawPayloadStored: false,
      rawTranscriptStored: false,
      truncated: Boolean(summary?.truncated),
      omittedKeys: [],
    },
  };
}

export function parseAutomationRunObserveInput(value: unknown): AutomationRunObserveInput & {
  truncated: boolean;
} {
  if (!isRecord(value)) {
    throw new AutomationRunValidationError('automation run observe payload must be an object');
  }
  rejectForbiddenKeys(value);
  const summaryRaw = optionalString(value['summary']);
  const summary = summaryRaw
    ? truncateUtf8(summaryRaw, AUTOMATION_RUN_SUMMARY_MAX_BYTES)
    : undefined;
  return {
    ...(summary ? { summary: summary.value } : {}),
    ...(value['targets'] !== undefined ? { targets: parseTargets(value['targets']) } : {}),
    ...(value['ttlSeconds'] !== undefined
      ? { ttlSeconds: clampTtl(value['ttlSeconds'], AUTOMATION_RUN_TTL_DEFAULT_SECONDS) }
      : {}),
    ...(parseExpiresAt(value['expiresAt']) ? { expiresAt: parseExpiresAt(value['expiresAt']) } : {}),
    truncated: Boolean(summary?.truncated),
  };
}

export function parseAutomationRunRetireInput(value: unknown): AutomationRunRetireInput {
  if (value === undefined || value === null) return {};
  if (!isRecord(value)) {
    throw new AutomationRunValidationError('automation run retire payload must be an object');
  }
  rejectForbiddenKeys(value);
  const reasonRaw = optionalString(value['reason']);
  const reason = reasonRaw ? truncateUtf8(reasonRaw, AUTOMATION_RUN_SUMMARY_MAX_BYTES).value : undefined;
  return {
    ...(reason ? { reason } : {}),
    ...(stringField(value, 'retiredBy') ? { retiredBy: stringField(value, 'retiredBy') } : {}),
  };
}

/**
 * Apply a liveness resolver to a target set, returning refreshed targets.
 * Pure: does not mutate the input.
 */
export function refreshTargetLiveness(
  targets: AutomationRunTarget[],
  resolver: AutomationRunLivenessResolver,
  now: string
): AutomationRunTarget[] {
  return targets.map((target) => {
    const state = resolver({
      ...(target.sessionId ? { sessionId: target.sessionId } : {}),
      ...(target.globalSessionId ? { globalSessionId: target.globalSessionId } : {}),
    });
    return { ...target, lastKnownState: state, lastCheckedAt: now };
  });
}

/**
 * Derive the run status + stale reasons from targets, heartbeat, and hard expiry.
 *
 * - A target that is `gone` (404 / killed) or `ended` (done) makes the run
 *   `cleanup-needed`: it is pointing at a session that no longer exists, exactly
 *   the #959 incident.
 * - A run past its hard `expiresAt` is `cleanup-needed`.
 * - A run whose heartbeat lapsed (no `observe` within ttl) is `stale`: the
 *   watcher stopped reporting. This is the "no silent infinite watchdog" guard —
 *   a watchdog can never stay green forever without checking in.
 * - A retired run is always `retired`.
 */
export function deriveAutomationRunStatus(
  input: {
    targets: AutomationRunTarget[];
    heartbeat: Pick<AutomationRunHeartbeat, 'expiresAt'>;
    expiresAt?: string | undefined;
    cleanup: Pick<AutomationRunCleanup, 'state'>;
  },
  nowIso: string
): { status: AutomationRunStatus; staleReasons: AutomationRunStaleReason[] } {
  if (input.cleanup.state === 'retired') {
    return { status: 'retired', staleReasons: [] };
  }
  const now = Date.parse(nowIso);
  const reasons: AutomationRunStaleReason[] = [];
  if (input.targets.some((t) => t.lastKnownState === 'gone')) {
    reasons.push('target-session-gone');
  }
  if (input.targets.some((t) => t.lastKnownState === 'ended')) {
    reasons.push('target-session-ended');
  }
  if (input.expiresAt && Date.parse(input.expiresAt) <= now) {
    reasons.push('hard-expiry');
  }
  if (Date.parse(input.heartbeat.expiresAt) <= now) {
    reasons.push('heartbeat-expired');
  }
  const cleanupNeeded = reasons.some(
    (reason) =>
      reason === 'target-session-gone' ||
      reason === 'target-session-ended' ||
      reason === 'hard-expiry'
  );
  if (cleanupNeeded) return { status: 'cleanup-needed', staleReasons: reasons };
  if (reasons.length > 0) return { status: 'stale', staleReasons: reasons };
  return { status: 'active', staleReasons: [] };
}

/** Bounded, redaction-safe event payload for a run (no raw bodies). */
export function automationRunSummaryPayload(run: AutomationRunRecord): Record<string, unknown> {
  return {
    automationRunId: run.id,
    name: run.name,
    kind: run.kind,
    ...(run.runId ? { runId: run.runId } : {}),
    orchestrator: run.owner.orchestrator,
    status: run.status,
    staleReasons: run.staleReasons,
    cleanupState: run.cleanup.state,
    targetCount: run.targets.length,
    version: run.version,
    updatedAt: run.updatedAt,
    ...(run.workContextId ? { workContextId: run.workContextId } : {}),
  };
}
