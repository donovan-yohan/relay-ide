import type { GlobalSessionId } from './identity.js';
import type { TaskRef, TaskRefKind, WorkContextId } from './work-context.js';

/**
 * PR / check / review overseer primitive (#960, refs #956).
 *
 * A Relay-visible record that links a Relay-driven implementation session to the
 * GitHub PR it is shipping, observes that PR's checks/reviews/mergeability/issue
 * closeout, and derives structured blockers + a required next action so an
 * orchestrator can steer the session and a tester/release-train agent can safely
 * hand off.
 *
 * The overnight #956 run only worked because Ebi *manually* polled GitHub PRs,
 * review comments, CI/check state, mergeability, and issue state and then steered
 * Claude or patched branches. This module turns that ad-hoc polling into a
 * Relay-owned, provider-neutral product surface (Claude/Codex/OpenCode/Hermes/
 * custom all consume the same record).
 *
 * Safety constraints baked in:
 *  - Exact-head evidence: every observation records the PR's `headSha`; a stored
 *    snapshot is only valid for the head it covers. A divergent expected head, a
 *    divergent caller-supplied `currentHeadSha`, or a lapsed observe heartbeat all
 *    flag the evidence as stale so a release agent never QAs/merges the wrong head.
 *  - No force merge: this primitive NEVER merges, approves, or mutates the PR. It
 *    only observes and emits evidence. The release decision/action stays with the
 *    authorized tester/release agent. Status is never `ready` on stale, failed, or
 *    unknown evidence (the #960 non-goals: "do not auto-merge failed or unknown
 *    checks", "do not depend on CodeRabbit/Gemini being available").
 *
 * Pure module: schema, parse/validate (secret-key rejection + bounds), and the
 * read-time derivation of status/blockers/handoff/next-action. The SQLite store
 * (`server/pr-overseer.ts`) and the gh-CLI-backed observer
 * (`server/pr-overseer-github.ts`) layer persistence and network on top.
 */
export const PR_OVERSEER_SCHEMA_VERSION = 1 as const;

/** Derived overall status of an overseen PR run. Never written directly. */
export const PR_OVERSEER_STATUSES = [
  'pending',
  'observing',
  'blocked',
  'ready',
  'merged',
  'closed',
  'stale',
  'retired',
] as const;
export type PrOverseerStatus = (typeof PR_OVERSEER_STATUSES)[number];

/**
 * Derived, typed blockers surfaced for a steering/release agent. `hard` blockers
 * make the run `blocked` (the implementation session must act); `soft` blockers
 * keep it `observing` (in progress / awaiting an external signal). Either kind
 * keeps the run out of `ready`, so a handoff is gated until they all clear.
 */
export const PR_OVERSEER_BLOCKER_KINDS = [
  'pr-draft',
  'checks-pending',
  'checks-failed',
  'review-changes-requested',
  'review-required',
  'unresolved-review-threads',
  'merge-conflict',
  'mergeability-unknown',
  'stale-head',
  'issue-closeout-mismatch',
] as const;
export type PrOverseerBlockerKind = (typeof PR_OVERSEER_BLOCKER_KINDS)[number];

/** Blockers that force `blocked` (vs merely keeping the run out of `ready`). */
export const PR_OVERSEER_HARD_BLOCKERS = new Set<PrOverseerBlockerKind>([
  'checks-failed',
  'review-changes-requested',
  'unresolved-review-threads',
  'merge-conflict',
  'stale-head',
  'issue-closeout-mismatch',
]);

export function isHardBlocker(kind: PrOverseerBlockerKind): boolean {
  return PR_OVERSEER_HARD_BLOCKERS.has(kind);
}

/** Structured next-action verbs for the steering/release contract. */
export const PR_OVERSEER_NEXT_ACTIONS = [
  'observe-first',
  're-observe',
  'fix-checks',
  'await-checks',
  'address-review',
  'await-review',
  'resolve-review-threads',
  'resolve-merge-conflict',
  'await-mergeability',
  'resync-head',
  'mark-pr-ready',
  'fix-issue-closeout',
  'verify-issue-closeout',
  'hand-off-to-release-train',
  'none',
] as const;
export type PrOverseerNextAction = (typeof PR_OVERSEER_NEXT_ACTIONS)[number];

/** Who the next action is addressed to. A collaboration hint, not an auth boundary. */
export const PR_OVERSEER_ACTORS = ['implementer', 'release-train', 'operator', 'none'] as const;
export type PrOverseerActor = (typeof PR_OVERSEER_ACTORS)[number];

export const PR_OVERSEER_PR_STATES = ['OPEN', 'CLOSED', 'MERGED'] as const;
export type PrOverseerPrState = (typeof PR_OVERSEER_PR_STATES)[number];

export const PR_OVERSEER_REVIEW_DECISIONS = [
  'APPROVED',
  'CHANGES_REQUESTED',
  'REVIEW_REQUIRED',
] as const;
export type PrOverseerReviewDecision = (typeof PR_OVERSEER_REVIEW_DECISIONS)[number];

export const PR_OVERSEER_MERGEABLE_STATES = ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] as const;
export type PrOverseerMergeableState = (typeof PR_OVERSEER_MERGEABLE_STATES)[number];

/** Why a fresh GitHub observation could not be taken. */
export const PR_OVERSEER_UNAVAILABLE_REASONS = [
  'gh-missing',
  'auth',
  'not-found',
  'error',
] as const;
export type PrOverseerUnavailableReason = (typeof PR_OVERSEER_UNAVAILABLE_REASONS)[number];

// ─── Reference shapes ──────────────────────────────────────────────────────────

/** The PR being overseen. `ownerRepo` is `owner/repo`. */
export interface PrOverseerPrRef {
  ownerRepo: string;
  number: number;
  url?: string | undefined;
}

/** The issue this run is shipping (so issue auto-close can be cross-checked). */
export interface PrOverseerIssueRef {
  ownerRepo?: string | undefined;
  number: number;
  url?: string | undefined;
}

/** The implementation session being steered. */
export interface PrOverseerSessionRef {
  sessionId?: string | undefined;
  globalSessionId?: GlobalSessionId | undefined;
}

export interface PrOverseerOwner {
  /** Orchestrator label, e.g. `ebi`, `hermes`, `operator`. */
  orchestrator: string;
  actorId?: string | undefined;
  actorType?: string | undefined;
}

export interface PrOverseerLinks {
  taskRefs?: Pick<TaskRef, 'kind' | 'id' | 'title' | 'url' | 'status'>[] | undefined;
  prUrls?: string[] | undefined;
  issueUrls?: string[] | undefined;
}

// ─── Observation snapshot ────────────────────────────────────────────────────

/** Bounded, redaction-safe per-check rollup. No raw logs/bodies. */
export interface PrObservationChecks {
  total: number;
  passing: number;
  failing: number;
  pending: number;
  /** Bounded names of failing checks (informational, never bodies). */
  failingNames: string[];
}

/** Bounded review summary. Logins only; never comment bodies. */
export interface PrObservationReviews {
  decision: PrOverseerReviewDecision | null;
  changesRequestedBy: string[];
  approvedBy: string[];
  unresolvedThreadCount: number;
}

/**
 * Informational bot-comment summary. Counts + bot logins only — bot feedback is
 * surfaced as evidence but NEVER gates readiness, so the overseer does not depend
 * on CodeRabbit/Gemini being present (#960 non-goal).
 */
export interface PrObservationBotComments {
  count: number;
  sources: string[];
}

export interface PrObservationPr {
  number: number;
  url?: string | undefined;
  state: PrOverseerPrState;
  isDraft: boolean;
  headRefName?: string | undefined;
  baseRefName?: string | undefined;
  /** Exact current head SHA (GitHub `headRefOid`). The evidence anchor. */
  headSha?: string | undefined;
  mergeable: PrOverseerMergeableState;
  mergeStateStatus?: string | undefined;
  updatedAt?: string | undefined;
}

/**
 * One observation of the PR. Produced by a `PrObserver`; bounded + redaction-safe.
 * `ok: false` (with `unavailableReason`) is a graceful degrade — the observer
 * never throws, so a missing/unauthenticated `gh` does not break the registry.
 */
export interface PrObservation {
  ok: boolean;
  fetchedAt: string;
  unavailableReason?: PrOverseerUnavailableReason | undefined;
  pr?: PrObservationPr | undefined;
  checks?: PrObservationChecks | undefined;
  reviews?: PrObservationReviews | undefined;
  botComments?: PrObservationBotComments | undefined;
  /** Issue numbers the PR will auto-close on merge (`closingIssuesReferences`). */
  closingIssueNumbers?: number[] | undefined;
}

// ─── Persisted record ──────────────────────────────────────────────────────────

export interface PrOverseerHeartbeat {
  /** A run that does not re-`observe` within this window derives `stale`. */
  ttlSeconds: number;
  lastObservedAt: string;
  expiresAt: string;
}

/** The most recent successful observation (snapshot only updates on success). */
export interface PrOverseerLastObservation {
  observedAt: string;
  summary?: string | undefined;
  snapshot: PrObservation;
}

/** The most recent fetch attempt (success OR failure), for staleness signalling. */
export interface PrOverseerLastFetch {
  at: string;
  ok: boolean;
  unavailableReason?: PrOverseerUnavailableReason | undefined;
}

export const PR_OVERSEER_CLEANUP_STATES = ['none', 'needed', 'retired'] as const;
export type PrOverseerCleanupState = (typeof PR_OVERSEER_CLEANUP_STATES)[number];

export interface PrOverseerCleanup {
  state: PrOverseerCleanupState;
  reason?: string | undefined;
  retiredAt?: string | undefined;
  retiredBy?: string | undefined;
}

export interface PrOverseerRedaction {
  rawPayloadStored: false;
  rawTranscriptStored: false;
  truncated: boolean;
  omittedKeys: string[];
}

// ─── Derived (read-time) shapes ────────────────────────────────────────────────

/** Exact-head / freshness risk for the stored evidence. */
export interface PrOverseerStaleHeadRisk {
  diverged: boolean;
  /** Head the last successful observation covers. */
  observedHeadSha?: string | undefined;
  /** Head the linked session believes it pushed. */
  expectedHeadSha?: string | undefined;
  /** Head a caller (e.g. a release agent) asked about via `currentHeadSha`. */
  currentHeadSha?: string | undefined;
  /** Seconds since the last successful observation (undefined if never observed). */
  evidenceAgeSeconds?: number | undefined;
  /** Heartbeat lapsed — evidence may not reflect the current PR head. */
  heartbeatExpired: boolean;
  /** The most recent fetch attempt failed (transient gh/auth/network issue). */
  lastFetchFailed: boolean;
}

export interface PrOverseerRequiredNextAction {
  action: PrOverseerNextAction;
  actor: PrOverseerActor;
  summary: string;
  blockers: PrOverseerBlockerKind[];
}

/**
 * The safe-handoff gate. `ready` is true ONLY when the run is `ready` (no
 * blockers, exact-head evidence current, heartbeat fresh) — a tester/release
 * agent must treat `ready: false` as "do not QA/review/merge yet".
 */
export interface PrOverseerHandoff {
  ready: boolean;
  exactHeadEvidenceCurrent: boolean;
  evidenceHeadSha?: string | undefined;
  evidenceAgeSeconds?: number | undefined;
  blockedBy: PrOverseerBlockerKind[];
  recommendedActor: PrOverseerActor;
}

export interface PrOverseerRecord {
  schemaVersion: typeof PR_OVERSEER_SCHEMA_VERSION;
  id: string;
  name: string;
  owner: PrOverseerOwner;
  repoPath?: string | undefined;
  workContextId?: WorkContextId | undefined;
  session?: PrOverseerSessionRef | undefined;
  issue?: PrOverseerIssueRef | undefined;
  pr: PrOverseerPrRef;
  /** Head SHA the linked session believes it pushed (optional divergence check). */
  expectedHeadSha?: string | undefined;
  links?: PrOverseerLinks | undefined;
  /** Derived. */
  status: PrOverseerStatus;
  /** Derived. */
  blockers: PrOverseerBlockerKind[];
  /** Derived. */
  requiredNextAction: PrOverseerRequiredNextAction;
  /** Derived. */
  handoff: PrOverseerHandoff;
  /** Derived. */
  staleHeadRisk: PrOverseerStaleHeadRisk;
  heartbeat: PrOverseerHeartbeat;
  lastObservation?: PrOverseerLastObservation | undefined;
  lastFetch?: PrOverseerLastFetch | undefined;
  cleanup: PrOverseerCleanup;
  createdAt: string;
  updatedAt: string;
  version: number;
  redaction: PrOverseerRedaction;
}

// ─── Inputs ──────────────────────────────────────────────────────────────────

export interface PrOverseerRegisterInput {
  id?: string | undefined;
  name: string;
  owner: PrOverseerOwner;
  repoPath?: string | undefined;
  workContextId?: WorkContextId | undefined;
  session?: PrOverseerSessionRef | undefined;
  issue?: PrOverseerIssueRef | undefined;
  pr: PrOverseerPrRef;
  expectedHeadSha?: string | undefined;
  links?: PrOverseerLinks | undefined;
  ttlSeconds: number;
  observationSummary?: string | undefined;
  createdAt?: string | undefined;
}

export interface PrOverseerObserveInput {
  summary?: string | undefined;
  /** Refresh the session's expected head on observe (e.g. it just pushed). */
  expectedHeadSha?: string | undefined;
  ttlSeconds?: number | undefined;
}

export interface PrOverseerRetireInput {
  reason?: string | undefined;
  retiredBy?: string | undefined;
}

export interface PrOverseerListFilter {
  workContextId?: string | undefined;
  repoPath?: string | undefined;
  status?: PrOverseerStatus | undefined;
  orchestrator?: string | undefined;
  ownerRepo?: string | undefined;
  includeRetired?: boolean | undefined;
  limit?: number | undefined;
}

/** Read-time options: a caller can assert the head it is about to act on. */
export interface PrOverseerReadOptions {
  /** Head the caller (release agent) is QAing/merging — must match the evidence. */
  currentHeadSha?: string | undefined;
}

// ─── Bounds + secret rejection ─────────────────────────────────────────────────

export const PR_OVERSEER_SUMMARY_MAX_BYTES = 4 * 1024;
export const PR_OVERSEER_MAX_LINKS = 50;
export const PR_OVERSEER_MAX_NAMES = 50;
export const PR_OVERSEER_MAX_INPUT_DEPTH = 20;
export const PR_OVERSEER_TTL_MIN_SECONDS = 30;
export const PR_OVERSEER_TTL_MAX_SECONDS = 7 * 24 * 60 * 60;
export const PR_OVERSEER_TTL_DEFAULT_SECONDS = 600;
export const PR_OVERSEER_SHA_MAX_LEN = 64;

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
/**
 * Unambiguous secret stems matched as substrings (in addition to the exact set
 * above) so compound key names — `githubToken`, `accessToken`, `myPassword`,
 * `userApiKey` — are rejected too. Kept to stems with effectively no English
 * false-positive (deliberately excludes short/ambiguous stems like `auth`,
 * `key`, `env` to avoid rejecting legitimate keys such as `author`/`environment`).
 */
const SECRET_KEY_SUBSTRINGS = [
  'token',
  'secret',
  'password',
  'passwd',
  'apikey',
  'api_key',
  'credential',
  'privatekey',
  'private_key',
  'accesskey',
  'access_key',
  'bearer',
] as const;
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

export class PrOverseerValidationError extends Error {
  constructor(
    message: string,
    public readonly details: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = 'PrOverseerValidationError';
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
  if (!value) throw new PrOverseerValidationError(`${key} is required`, { field: key });
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
  if (depth > PR_OVERSEER_MAX_INPUT_DEPTH) {
    throw new PrOverseerValidationError('pr overseer payload exceeds maximum nested depth', {
      path,
      maxDepth: PR_OVERSEER_MAX_INPUT_DEPTH,
    });
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectForbiddenKeys(item, `${path}[${index}]`, found, depth + 1));
    return found;
  }
  if (!isRecord(value)) return found;
  for (const [key, child] of Object.entries(value)) {
    const normalized = key.toLowerCase().replace(/[^a-z0-9_]/g, '');
    if (
      SECRETISH_KEYS.has(normalized) ||
      SECRET_KEY_SUBSTRINGS.some((stem) => normalized.includes(stem))
    ) {
      found.push(`${path}.${key}`);
      continue;
    }
    collectForbiddenKeys(child, `${path}.${key}`, found, depth + 1);
  }
  return found;
}

function rejectForbiddenKeys(input: Record<string, unknown>): void {
  const omittedKeys = collectForbiddenKeys(input);
  if (omittedKeys.length > 0) {
    throw new PrOverseerValidationError(
      'pr overseer payload contains forbidden raw/private fields',
      { omittedKeys }
    );
  }
}

function clampTtl(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  const rounded = Math.round(value);
  return Math.min(PR_OVERSEER_TTL_MAX_SECONDS, Math.max(PR_OVERSEER_TTL_MIN_SECONDS, rounded));
}

function normalizeComparisonSha(value: string | undefined): string | undefined {
  return value ? value.toLowerCase() : undefined;
}

/** Normalize a head SHA: hex only, lowercased, bounded. Returns undefined if empty/invalid. */
export function normalizeHeadSha(value: unknown): string | undefined {
  const raw = optionalString(value);
  if (!raw) return undefined;
  const hex = raw.toLowerCase();
  if (!/^[0-9a-f]{7,64}$/.test(hex)) {
    throw new PrOverseerValidationError('head sha must be a 7-64 char hex string', {
      field: 'headSha',
    });
  }
  return hex.slice(0, PR_OVERSEER_SHA_MAX_LEN);
}

function parsePositiveInt(value: unknown, field: string): number {
  const num = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  if (!Number.isInteger(num) || num <= 0) {
    throw new PrOverseerValidationError(`${field} must be a positive integer`, { field });
  }
  return num;
}

function parseOwnerRepo(value: unknown, field: string): string {
  const raw = optionalString(value);
  if (!raw || !/^[^/\s]+\/[^/\s]+$/.test(raw)) {
    throw new PrOverseerValidationError(`${field} must be in owner/repo form`, { field });
  }
  return raw;
}

function parseOwner(value: unknown): PrOverseerOwner {
  if (!isRecord(value)) {
    throw new PrOverseerValidationError('owner is required', { field: 'owner' });
  }
  return {
    orchestrator: requireString(value, 'orchestrator'),
    ...(stringField(value, 'actorId') ? { actorId: stringField(value, 'actorId') } : {}),
    ...(stringField(value, 'actorType') ? { actorType: stringField(value, 'actorType') } : {}),
  };
}

function parsePrRef(value: unknown): PrOverseerPrRef {
  if (!isRecord(value)) {
    throw new PrOverseerValidationError('pr is required (ownerRepo + number)', { field: 'pr' });
  }
  return {
    ownerRepo: parseOwnerRepo(value['ownerRepo'], 'pr.ownerRepo'),
    number: parsePositiveInt(value['number'], 'pr.number'),
    ...(stringField(value, 'url') ? { url: stringField(value, 'url') } : {}),
  };
}

function parseIssueRef(value: unknown): PrOverseerIssueRef | undefined {
  if (!isRecord(value)) return undefined;
  return {
    number: parsePositiveInt(value['number'], 'issue.number'),
    ...(value['ownerRepo'] !== undefined
      ? { ownerRepo: parseOwnerRepo(value['ownerRepo'], 'issue.ownerRepo') }
      : {}),
    ...(stringField(value, 'url') ? { url: stringField(value, 'url') } : {}),
  };
}

function parseSessionRef(value: unknown): PrOverseerSessionRef | undefined {
  if (!isRecord(value)) return undefined;
  const sessionId = stringField(value, 'sessionId');
  const globalSessionId = stringField(value, 'globalSessionId');
  if (!sessionId && !globalSessionId) return undefined;
  return {
    ...(sessionId ? { sessionId } : {}),
    ...(globalSessionId ? { globalSessionId: globalSessionId as GlobalSessionId } : {}),
  };
}

function parseStringList(value: unknown, limit: number): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const strings = value
    .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    .map((item) => item.trim())
    .slice(0, limit);
  return strings.length ? strings : undefined;
}

function parseTaskRefs(value: unknown): PrOverseerLinks['taskRefs'] | undefined {
  if (!Array.isArray(value)) return undefined;
  const refs: NonNullable<PrOverseerLinks['taskRefs']> = [];
  for (const entry of value.slice(0, PR_OVERSEER_MAX_LINKS)) {
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

function parseLinks(value: unknown): PrOverseerLinks | undefined {
  if (!isRecord(value)) return undefined;
  const links: PrOverseerLinks = {};
  const taskRefs = parseTaskRefs(value['taskRefs']);
  if (taskRefs?.length) links.taskRefs = taskRefs;
  const prUrls = parseStringList(value['prUrls'], PR_OVERSEER_MAX_LINKS);
  if (prUrls?.length) links.prUrls = prUrls;
  const issueUrls = parseStringList(value['issueUrls'], PR_OVERSEER_MAX_LINKS);
  if (issueUrls?.length) links.issueUrls = issueUrls;
  return Object.keys(links).length ? links : undefined;
}

export function parsePrOverseerStatus(value: unknown): PrOverseerStatus | undefined {
  return typeof value === 'string' && (PR_OVERSEER_STATUSES as readonly string[]).includes(value)
    ? (value as PrOverseerStatus)
    : undefined;
}

export function parsePrOverseerRegisterInput(value: unknown): PrOverseerRegisterInput & {
  redaction: PrOverseerRedaction;
} {
  if (!isRecord(value)) {
    throw new PrOverseerValidationError('pr overseer register payload must be an object');
  }
  rejectForbiddenKeys(value);
  const summaryRaw = optionalString(value['observationSummary']);
  const summary = summaryRaw ? truncateUtf8(summaryRaw, PR_OVERSEER_SUMMARY_MAX_BYTES) : undefined;
  const links = parseLinks(value['links']);
  const issue = parseIssueRef(value['issue']);
  const session = parseSessionRef(value['session']);
  return {
    name: requireString(value, 'name'),
    owner: parseOwner(value['owner']),
    pr: parsePrRef(value['pr']),
    ttlSeconds: clampTtl(value['ttlSeconds'], PR_OVERSEER_TTL_DEFAULT_SECONDS),
    ...(stringField(value, 'id') ? { id: stringField(value, 'id') } : {}),
    ...(stringField(value, 'repoPath') ? { repoPath: stringField(value, 'repoPath') } : {}),
    ...(stringField(value, 'workContextId')
      ? { workContextId: stringField(value, 'workContextId') as WorkContextId }
      : {}),
    ...(session ? { session } : {}),
    ...(issue ? { issue } : {}),
    ...(normalizeHeadSha(value['expectedHeadSha'])
      ? { expectedHeadSha: normalizeHeadSha(value['expectedHeadSha']) }
      : {}),
    ...(links ? { links } : {}),
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

export function parsePrOverseerObserveInput(value: unknown): PrOverseerObserveInput & {
  truncated: boolean;
} {
  if (value === undefined || value === null) return { truncated: false };
  if (!isRecord(value)) {
    throw new PrOverseerValidationError('pr overseer observe payload must be an object');
  }
  rejectForbiddenKeys(value);
  const summaryRaw = optionalString(value['summary']);
  const summary = summaryRaw ? truncateUtf8(summaryRaw, PR_OVERSEER_SUMMARY_MAX_BYTES) : undefined;
  return {
    ...(summary ? { summary: summary.value } : {}),
    ...(normalizeHeadSha(value['expectedHeadSha'])
      ? { expectedHeadSha: normalizeHeadSha(value['expectedHeadSha']) }
      : {}),
    ...(value['ttlSeconds'] !== undefined
      ? { ttlSeconds: clampTtl(value['ttlSeconds'], PR_OVERSEER_TTL_DEFAULT_SECONDS) }
      : {}),
    truncated: Boolean(summary?.truncated),
  };
}

export function parsePrOverseerRetireInput(value: unknown): PrOverseerRetireInput {
  if (value === undefined || value === null) return {};
  if (!isRecord(value)) {
    throw new PrOverseerValidationError('pr overseer retire payload must be an object');
  }
  rejectForbiddenKeys(value);
  const reasonRaw = optionalString(value['reason']);
  const reason = reasonRaw ? truncateUtf8(reasonRaw, PR_OVERSEER_SUMMARY_MAX_BYTES).value : undefined;
  return {
    ...(reason ? { reason } : {}),
    ...(stringField(value, 'retiredBy') ? { retiredBy: stringField(value, 'retiredBy') } : {}),
  };
}

// ─── Observation sanitization ──────────────────────────────────────────────────

function boundNames(value: unknown, limit: number): string[] {
  return parseStringList(value, limit) ?? [];
}

function boundInt(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

/**
 * Clamp an observer-produced snapshot to bounded, redaction-safe shape. The
 * observer is trusted Relay code, but this guarantees no unbounded array or stray
 * field leaks into the persisted record even if the observer changes.
 */
export function boundPrObservation(raw: PrObservation): PrObservation {
  const out: PrObservation = { ok: Boolean(raw.ok), fetchedAt: raw.fetchedAt };
  if (raw.unavailableReason) out.unavailableReason = raw.unavailableReason;
  if (raw.pr) {
    const pr = raw.pr;
    out.pr = {
      number: pr.number,
      state: (PR_OVERSEER_PR_STATES as readonly string[]).includes(pr.state) ? pr.state : 'OPEN',
      isDraft: Boolean(pr.isDraft),
      mergeable: (PR_OVERSEER_MERGEABLE_STATES as readonly string[]).includes(pr.mergeable)
        ? pr.mergeable
        : 'UNKNOWN',
      ...(pr.url ? { url: pr.url } : {}),
      ...(pr.headRefName ? { headRefName: pr.headRefName } : {}),
      ...(pr.baseRefName ? { baseRefName: pr.baseRefName } : {}),
      ...(pr.headSha ? { headSha: pr.headSha } : {}),
      ...(pr.mergeStateStatus ? { mergeStateStatus: pr.mergeStateStatus } : {}),
      ...(pr.updatedAt ? { updatedAt: pr.updatedAt } : {}),
    };
  }
  if (raw.checks) {
    out.checks = {
      total: boundInt(raw.checks.total),
      passing: boundInt(raw.checks.passing),
      failing: boundInt(raw.checks.failing),
      pending: boundInt(raw.checks.pending),
      failingNames: boundNames(raw.checks.failingNames, PR_OVERSEER_MAX_NAMES),
    };
  }
  if (raw.reviews) {
    out.reviews = {
      decision: (PR_OVERSEER_REVIEW_DECISIONS as readonly string[]).includes(
        raw.reviews.decision as string
      )
        ? (raw.reviews.decision as PrOverseerReviewDecision)
        : null,
      changesRequestedBy: boundNames(raw.reviews.changesRequestedBy, PR_OVERSEER_MAX_NAMES),
      approvedBy: boundNames(raw.reviews.approvedBy, PR_OVERSEER_MAX_NAMES),
      unresolvedThreadCount: boundInt(raw.reviews.unresolvedThreadCount),
    };
  }
  if (raw.botComments) {
    out.botComments = {
      count: boundInt(raw.botComments.count),
      sources: boundNames(raw.botComments.sources, PR_OVERSEER_MAX_NAMES),
    };
  }
  if (Array.isArray(raw.closingIssueNumbers)) {
    out.closingIssueNumbers = raw.closingIssueNumbers
      .filter((n): n is number => typeof n === 'number' && Number.isInteger(n) && n > 0)
      .slice(0, PR_OVERSEER_MAX_NAMES);
  }
  return out;
}

// ─── Derivation ────────────────────────────────────────────────────────────────

/** Input shape for the pure derivation (a subset of the stored record). */
export interface PrOverseerDerivationInput {
  pr: PrOverseerPrRef;
  expectedHeadSha?: string | undefined;
  issue?: PrOverseerIssueRef | undefined;
  heartbeat: Pick<PrOverseerHeartbeat, 'expiresAt'>;
  lastObservation?: PrOverseerLastObservation | undefined;
  lastFetch?: PrOverseerLastFetch | undefined;
  cleanup: Pick<PrOverseerCleanup, 'state'>;
}

export interface PrOverseerDerivedView {
  status: PrOverseerStatus;
  blockers: PrOverseerBlockerKind[];
  staleHeadRisk: PrOverseerStaleHeadRisk;
  requiredNextAction: PrOverseerRequiredNextAction;
  handoff: PrOverseerHandoff;
}

/**
 * Compute typed blockers from a successful snapshot. Only blockers meaningful for
 * the PR's current state are emitted (a merged PR only checks issue closeout; a
 * closed PR emits none). `currentHeadSha` (a caller's asserted head) and a
 * divergent `expectedHeadSha` both produce a `stale-head` blocker so evidence for
 * the wrong head can never read as `ready`.
 */
export function computePrOverseerBlockers(input: {
  snapshot: PrObservation;
  expectedHeadSha?: string | undefined;
  issue?: PrOverseerIssueRef | undefined;
  currentHeadSha?: string | undefined;
}): PrOverseerBlockerKind[] {
  const { snapshot, expectedHeadSha, issue, currentHeadSha } = input;
  const pr = snapshot.pr;
  if (!pr) return [];
  const blockers: PrOverseerBlockerKind[] = [];
  const observedHead = normalizeComparisonSha(pr.headSha);
  const normalizedExpectedHead = normalizeComparisonSha(expectedHeadSha);
  const normalizedCurrentHead = normalizeComparisonSha(currentHeadSha);

  const issueClosesOut = (): boolean => {
    if (!issue) return true; // no linked issue → nothing to cross-check
    const closing = snapshot.closingIssueNumbers ?? [];
    return closing.includes(issue.number);
  };

  if (pr.state === 'MERGED') {
    // Post-merge, the only steering-relevant signal is whether the linked issue
    // will actually have closed (issue auto-close mismatch — a #960 test case).
    if (!issueClosesOut()) blockers.push('issue-closeout-mismatch');
    return blockers;
  }
  if (pr.state === 'CLOSED') {
    return blockers; // closed unmerged → status handles it; no actionable blockers
  }

  // OPEN PR.
  if (pr.isDraft) blockers.push('pr-draft');
  if (snapshot.checks) {
    if (snapshot.checks.failing > 0) blockers.push('checks-failed');
    else if (snapshot.checks.pending > 0) blockers.push('checks-pending');
  }
  if (snapshot.reviews) {
    if (
      snapshot.reviews.decision === 'CHANGES_REQUESTED' ||
      snapshot.reviews.changesRequestedBy.length > 0
    ) {
      blockers.push('review-changes-requested');
    } else if (snapshot.reviews.decision !== 'APPROVED') {
      blockers.push('review-required');
    }
    if (snapshot.reviews.unresolvedThreadCount > 0) blockers.push('unresolved-review-threads');
  } else {
    // Successful OPEN observations with missing review evidence are unknown, not
    // approved. Future/injected observers may emit partial snapshots; never let a
    // partial snapshot hand off to the release train.
    blockers.push('review-required');
  }
  if (pr.mergeable === 'CONFLICTING') blockers.push('merge-conflict');
  else if (pr.mergeable === 'UNKNOWN') blockers.push('mergeability-unknown');

  // Exact-head divergence: the session's expected head, or a caller's asserted
  // head, must match the head the evidence covers. A stated expected/asserted
  // head with NO observed head (e.g. gh returned an empty `headRefOid` for a
  // cross-fork PR whose head ref was deleted) is also divergence — the evidence
  // covers an UNKNOWN head and must never read as exact-head-current.
  const headDiverged =
    !observedHead ||
    (normalizedExpectedHead && observedHead && normalizedExpectedHead !== observedHead) ||
    (normalizedCurrentHead && observedHead && normalizedCurrentHead !== observedHead);
  if (headDiverged) blockers.push('stale-head');

  if (!issueClosesOut()) blockers.push('issue-closeout-mismatch');

  return blockers;
}

export function derivePrOverseerStaleHeadRisk(
  input: PrOverseerDerivationInput,
  nowIso: string,
  opts: PrOverseerReadOptions = {}
): PrOverseerStaleHeadRisk {
  const now = Date.parse(nowIso);
  const observedHeadSha = normalizeComparisonSha(input.lastObservation?.snapshot.pr?.headSha);
  const expectedHeadSha = normalizeComparisonSha(input.expectedHeadSha);
  const currentHeadSha = normalizeComparisonSha(opts.currentHeadSha);
  const observedAt = input.lastObservation?.observedAt;
  const evidenceAgeSeconds =
    observedAt && !Number.isNaN(Date.parse(observedAt))
      ? Math.max(0, Math.round((now - Date.parse(observedAt)) / 1000))
      : undefined;
  const heartbeatExpired = Date.parse(input.heartbeat.expiresAt) <= now;
  const hasPrSnapshot = Boolean(input.lastObservation?.snapshot.pr);
  const diverged = Boolean(
    (hasPrSnapshot && !observedHeadSha) ||
      (expectedHeadSha && observedHeadSha && expectedHeadSha !== observedHeadSha) ||
      (currentHeadSha && observedHeadSha && currentHeadSha !== observedHeadSha)
  );
  return {
    diverged,
    ...(observedHeadSha ? { observedHeadSha } : {}),
    ...(expectedHeadSha ? { expectedHeadSha } : {}),
    ...(currentHeadSha ? { currentHeadSha } : {}),
    ...(evidenceAgeSeconds !== undefined ? { evidenceAgeSeconds } : {}),
    heartbeatExpired,
    lastFetchFailed: Boolean(input.lastFetch && !input.lastFetch.ok),
  };
}

/**
 * Derive the run status. Precedence is chosen so a `ready` is NEVER reported on
 * stale, merged-into-closed, or unobserved evidence, while a genuine hard block
 * still surfaces as `blocked` even if the heartbeat also lapsed (the block is the
 * signal the operator most needs):
 *
 *   retired > pending > merged > closed > blocked > stale > observing > ready
 */
export function derivePrOverseerStatus(
  input: PrOverseerDerivationInput,
  nowIso: string,
  opts: PrOverseerReadOptions = {}
): { status: PrOverseerStatus; blockers: PrOverseerBlockerKind[] } {
  if (input.cleanup.state === 'retired') return { status: 'retired', blockers: [] };
  if (!input.lastObservation) return { status: 'pending', blockers: [] };
  const snapshot = input.lastObservation.snapshot;
  // A stored observation with no PR object is not usable evidence (defensive: the
  // production observer always attaches `pr` on success). Never derive `ready`
  // from it — fall back to `pending` so a real observe is required first.
  if (!snapshot.pr) return { status: 'pending', blockers: [] };
  const blockers = computePrOverseerBlockers({
    snapshot,
    ...(input.expectedHeadSha ? { expectedHeadSha: input.expectedHeadSha } : {}),
    ...(input.issue ? { issue: input.issue } : {}),
    ...(opts.currentHeadSha ? { currentHeadSha: opts.currentHeadSha } : {}),
  });
  const prState = snapshot.pr?.state;
  if (prState === 'MERGED') return { status: 'merged', blockers };
  if (prState === 'CLOSED') return { status: 'closed', blockers };
  if (blockers.some(isHardBlocker)) return { status: 'blocked', blockers };
  const heartbeatExpired = Date.parse(input.heartbeat.expiresAt) <= Date.parse(nowIso);
  const lastFetchFailed = Boolean(input.lastFetch && !input.lastFetch.ok);
  // A lapsed heartbeat OR a failed most-recent fetch means we could not confirm
  // the PR is still in its last-known good state — bias to `stale` (re-observe)
  // rather than ever reporting `ready` on unconfirmed evidence.
  if (heartbeatExpired || lastFetchFailed) return { status: 'stale', blockers };
  if (blockers.length > 0) return { status: 'observing', blockers };
  return { status: 'ready', blockers };
}

function firstBlocker(
  blockers: PrOverseerBlockerKind[],
  order: PrOverseerBlockerKind[]
): PrOverseerBlockerKind | undefined {
  for (const kind of order) if (blockers.includes(kind)) return kind;
  return undefined;
}

export function derivePrOverseerRequiredNextAction(
  status: PrOverseerStatus,
  blockers: PrOverseerBlockerKind[],
  input: PrOverseerDerivationInput,
  staleHeadRisk: PrOverseerStaleHeadRisk
): PrOverseerRequiredNextAction {
  const issueNum = input.issue?.number;
  const make = (
    action: PrOverseerNextAction,
    actor: PrOverseerActor,
    summary: string
  ): PrOverseerRequiredNextAction => ({ action, actor, summary, blockers });

  if (status === 'retired') return make('none', 'none', 'Overseer retired; no further action.');
  if (status === 'pending') {
    if (input.lastFetch && !input.lastFetch.ok) {
      return make(
        're-observe',
        'operator',
        'The PR has not been observed successfully yet and the last GitHub fetch failed; re-run pr-overseer observe (check gh auth/availability).'
      );
    }
    return make('observe-first', 'operator', 'Run pr-overseer observe to take the first PR snapshot.');
  }
  if (status === 'merged') {
    if (blockers.includes('issue-closeout-mismatch')) {
      return make(
        'verify-issue-closeout',
        'release-train',
        `PR merged but issue #${issueNum ?? '?'} is not referenced as auto-closing — verify/close it manually.`
      );
    }
    return make('none', 'none', 'PR merged; release complete.');
  }
  if (status === 'closed') {
    return make('none', 'operator', 'PR closed without merge; re-open or retire the overseer.');
  }
  if (status === 'stale') {
    return make(
      're-observe',
      'operator',
      staleHeadRisk.lastFetchFailed
        ? 'Last GitHub fetch failed; re-run pr-overseer observe to refresh evidence.'
        : 'Observe heartbeat lapsed; re-run pr-overseer observe before trusting the evidence.'
    );
  }
  if (status === 'blocked') {
    const hard = firstBlocker(blockers, [
      'stale-head',
      'merge-conflict',
      'checks-failed',
      'review-changes-requested',
      'unresolved-review-threads',
      'issue-closeout-mismatch',
    ]);
    switch (hard) {
      case 'stale-head':
        return make(
          'resync-head',
          'implementer',
          'Evidence head diverged from the PR head — push/rebase so the session and PR share a head, then re-observe.'
        );
      case 'merge-conflict':
        return make('resolve-merge-conflict', 'implementer', 'PR has merge conflicts; rebase onto the base branch.');
      case 'checks-failed':
        return make('fix-checks', 'implementer', 'One or more checks failed; fix and push.');
      case 'review-changes-requested':
        return make('address-review', 'implementer', 'A reviewer requested changes; address the feedback and push.');
      case 'unresolved-review-threads':
        return make('resolve-review-threads', 'implementer', 'Unresolved review threads remain; resolve them.');
      case 'issue-closeout-mismatch':
        return make(
          'fix-issue-closeout',
          'implementer',
          `PR does not reference issue #${issueNum ?? '?'} as closing — add "Closes #${issueNum ?? '?'}" to the PR body.`
        );
      default:
        return make('re-observe', 'operator', 'Blocked; re-observe for current evidence.');
    }
  }
  // observing (soft blockers only)
  const soft = firstBlocker(blockers, [
    'checks-pending',
    'mergeability-unknown',
    'review-required',
    'pr-draft',
  ]);
  switch (soft) {
    case 'checks-pending':
      return make('await-checks', 'none', 'Checks are still running; wait for the rollup to settle.');
    case 'mergeability-unknown':
      return make('await-mergeability', 'none', 'GitHub is still computing mergeability; re-observe shortly.');
    case 'review-required':
      return make('await-review', 'release-train', 'Required review not yet approved; request/await review.');
    case 'pr-draft':
      return make('mark-pr-ready', 'implementer', 'PR is a draft; mark it ready for review when implementation is done.');
    default:
      return make(
        'hand-off-to-release-train',
        'release-train',
        'Exact-head evidence is current and unblocked; safe to QA/review/merge.'
      );
  }
}

export function derivePrOverseerHandoff(
  status: PrOverseerStatus,
  blockers: PrOverseerBlockerKind[],
  staleHeadRisk: PrOverseerStaleHeadRisk,
  requiredNextAction: PrOverseerRequiredNextAction
): PrOverseerHandoff {
  const exactHeadEvidenceCurrent =
    Boolean(staleHeadRisk.observedHeadSha) &&
    !staleHeadRisk.diverged &&
    !staleHeadRisk.heartbeatExpired &&
    !staleHeadRisk.lastFetchFailed;
  // `ready` is the safe-handoff gate. It conjoins exact-head currency so the gate
  // can never be true on evidence whose head is unverifiable (no observed head),
  // even if `status` derived `ready` because no other blocker was present. This
  // guarantees `handoff.ready` and `exactHeadEvidenceCurrent` can never disagree.
  const ready = status === 'ready' && exactHeadEvidenceCurrent;
  return {
    ready,
    exactHeadEvidenceCurrent,
    ...(staleHeadRisk.observedHeadSha ? { evidenceHeadSha: staleHeadRisk.observedHeadSha } : {}),
    ...(staleHeadRisk.evidenceAgeSeconds !== undefined
      ? { evidenceAgeSeconds: staleHeadRisk.evidenceAgeSeconds }
      : {}),
    blockedBy: blockers,
    recommendedActor: requiredNextAction.actor,
  };
}

/** Full read-time derivation: status + blockers + risk + next action + handoff. */
export function derivePrOverseerView(
  input: PrOverseerDerivationInput,
  nowIso: string,
  opts: PrOverseerReadOptions = {}
): PrOverseerDerivedView {
  const staleHeadRisk = derivePrOverseerStaleHeadRisk(input, nowIso, opts);
  const { status, blockers } = derivePrOverseerStatus(input, nowIso, opts);
  const requiredNextAction = derivePrOverseerRequiredNextAction(status, blockers, input, staleHeadRisk);
  const handoff = derivePrOverseerHandoff(status, blockers, staleHeadRisk, requiredNextAction);
  return { status, blockers, staleHeadRisk, requiredNextAction, handoff };
}

/** Bounded, redaction-safe event payload (ids/refs/derived state only). */
export function prOverseerSummaryPayload(record: PrOverseerRecord): Record<string, unknown> {
  return {
    prOverseerId: record.id,
    name: record.name,
    orchestrator: record.owner.orchestrator,
    ownerRepo: record.pr.ownerRepo,
    prNumber: record.pr.number,
    status: record.status,
    blockers: record.blockers,
    nextAction: record.requiredNextAction.action,
    handoffReady: record.handoff.ready,
    ...(record.handoff.evidenceHeadSha ? { evidenceHeadSha: record.handoff.evidenceHeadSha } : {}),
    staleHeadDiverged: record.staleHeadRisk.diverged,
    version: record.version,
    updatedAt: record.updatedAt,
    ...(record.workContextId ? { workContextId: record.workContextId } : {}),
    ...(record.issue ? { issueNumber: record.issue.number } : {}),
  };
}
