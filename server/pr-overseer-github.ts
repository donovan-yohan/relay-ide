import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { createLogger } from './logger.js';
import {
  PR_OVERSEER_MAX_NAMES,
  type PrObservation,
  type PrObservationBotComments,
  type PrObservationChecks,
  type PrObservationReviews,
  type PrOverseerMergeableState,
  type PrOverseerPrState,
  type PrOverseerReviewDecision,
  type PrOverseerUnavailableReason,
} from '../shared/pr-overseer.js';

const execFileAsync = promisify(execFile);
const logger = createLogger('pr-overseer-github');

const GH_VIEW_TIMEOUT_MS = 10_000;
const GH_GRAPHQL_TIMEOUT_MS = 10_000;

/** Minimal injectable exec so the observer is fully testable without `gh`. */
export type PrOverseerExec = (
  file: string,
  args: string[],
  options: { cwd?: string | undefined; timeout?: number | undefined }
) => Promise<{ stdout: string; stderr: string }>;

/** What to observe. `repoPath` is an optional cwd for `gh` auth context. */
export interface PrObserveTarget {
  ownerRepo: string;
  number: number;
  repoPath?: string | undefined;
}

/**
 * Observe a PR and return a bounded, redaction-safe snapshot. Implementations
 * MUST NOT throw — a missing/unauthenticated `gh`, a deleted PR, or a network
 * blip degrades to `{ ok: false, unavailableReason }` so the overseer registry
 * keeps working (the snapshot just carries no fresh evidence).
 */
export type PrObserver = (target: PrObserveTarget) => Promise<PrObservation>;

// ─── gh JSON shapes (only the fields we read) ──────────────────────────────────

interface GhStatusCheck {
  __typename?: string;
  // CheckRun
  status?: string;
  conclusion?: string;
  name?: string;
  // StatusContext
  state?: string;
  context?: string;
}

interface GhReview {
  author?: { login?: string } | null;
  state?: string;
}

interface GhComment {
  author?: { login?: string } | null;
}

interface GhPrView {
  number: number;
  url?: string;
  state?: string;
  isDraft?: boolean;
  headRefName?: string;
  baseRefName?: string;
  headRefOid?: string;
  mergeable?: string;
  mergeStateStatus?: string;
  reviewDecision?: string | null;
  latestReviews?: GhReview[];
  reviews?: GhReview[];
  statusCheckRollup?: GhStatusCheck[];
  comments?: GhComment[];
  closingIssuesReferences?: Array<{ number?: number }>;
  updatedAt?: string;
}

const PR_VIEW_FIELDS = [
  'number',
  'url',
  'state',
  'isDraft',
  'headRefName',
  'baseRefName',
  'headRefOid',
  'mergeable',
  'mergeStateStatus',
  'reviewDecision',
  'latestReviews',
  'statusCheckRollup',
  'comments',
  'closingIssuesReferences',
  'updatedAt',
].join(',');

const KNOWN_BOT_LOGINS = new Set<string>([
  'coderabbitai',
  'gemini-code-assist',
  'github-actions',
  'dependabot',
  'codecov',
  'vercel',
  'sonarcloud',
  'greptile-apps',
]);

function isBotLogin(login: string): boolean {
  const lower = login.toLowerCase();
  if (lower.endsWith('[bot]')) return true;
  return KNOWN_BOT_LOGINS.has(lower.replace(/\[bot\]$/, ''));
}

function mapPrState(state: string | undefined): PrOverseerPrState {
  const upper = (state ?? '').toUpperCase();
  if (upper === 'MERGED') return 'MERGED';
  if (upper === 'CLOSED') return 'CLOSED';
  return 'OPEN';
}

function mapMergeable(mergeable: string | undefined): PrOverseerMergeableState {
  const upper = (mergeable ?? '').toUpperCase();
  if (upper === 'MERGEABLE') return 'MERGEABLE';
  if (upper === 'CONFLICTING') return 'CONFLICTING';
  return 'UNKNOWN';
}

function mapReviewDecision(decision: string | null | undefined): PrOverseerReviewDecision | null {
  const upper = (decision ?? '').toUpperCase();
  if (upper === 'APPROVED') return 'APPROVED';
  if (upper === 'CHANGES_REQUESTED') return 'CHANGES_REQUESTED';
  if (upper === 'REVIEW_REQUIRED') return 'REVIEW_REQUIRED';
  return null;
}

/**
 * Classify a `statusCheckRollup` entry. Handles both CheckRun (status/conclusion)
 * and StatusContext (state) shapes. Returns `passing | failing | pending`.
 */
function classifyRollupEntry(check: GhStatusCheck): 'passing' | 'failing' | 'pending' {
  // CheckRun: COMPLETED + conclusion, or in-progress/queued.
  if (check.conclusion !== undefined || check.status !== undefined) {
    const status = (check.status ?? '').toUpperCase();
    if (status && status !== 'COMPLETED') return 'pending';
    const conclusion = (check.conclusion ?? '').toUpperCase();
    if (conclusion === 'SUCCESS' || conclusion === 'SKIPPED' || conclusion === 'NEUTRAL') {
      return 'passing';
    }
    if (
      conclusion === 'FAILURE' ||
      conclusion === 'CANCELLED' ||
      conclusion === 'TIMED_OUT' ||
      conclusion === 'STARTUP_FAILURE' ||
      conclusion === 'ACTION_REQUIRED'
    ) {
      return 'failing';
    }
    return 'pending';
  }
  // StatusContext: state only.
  const state = (check.state ?? '').toUpperCase();
  if (state === 'SUCCESS') return 'passing';
  if (state === 'FAILURE' || state === 'ERROR') return 'failing';
  return 'pending';
}

function checkName(check: GhStatusCheck): string {
  return check.name ?? check.context ?? 'check';
}

function summarizeChecks(rollup: GhStatusCheck[] | undefined): PrObservationChecks {
  const checks = Array.isArray(rollup) ? rollup : [];
  let passing = 0;
  let failing = 0;
  let pending = 0;
  const failingNames: string[] = [];
  for (const check of checks) {
    const verdict = classifyRollupEntry(check);
    if (verdict === 'passing') passing++;
    else if (verdict === 'failing') {
      failing++;
      if (failingNames.length < PR_OVERSEER_MAX_NAMES) failingNames.push(checkName(check));
    } else pending++;
  }
  return { total: checks.length, passing, failing, pending, failingNames };
}

function summarizeReviews(
  decision: string | null | undefined,
  latestReviews: GhReview[] | undefined,
  unresolvedThreadCount: number
): PrObservationReviews {
  const reviews = Array.isArray(latestReviews) ? latestReviews : [];
  const changesRequestedBy: string[] = [];
  const approvedBy: string[] = [];
  for (const review of reviews) {
    const login = review.author?.login;
    if (!login) continue;
    const state = (review.state ?? '').toUpperCase();
    if (state === 'CHANGES_REQUESTED' && !changesRequestedBy.includes(login)) {
      changesRequestedBy.push(login);
    } else if (state === 'APPROVED' && !approvedBy.includes(login)) {
      approvedBy.push(login);
    }
  }
  return {
    decision: mapReviewDecision(decision),
    changesRequestedBy: changesRequestedBy.slice(0, PR_OVERSEER_MAX_NAMES),
    approvedBy: approvedBy.slice(0, PR_OVERSEER_MAX_NAMES),
    unresolvedThreadCount,
  };
}

function summarizeBotComments(comments: GhComment[] | undefined): PrObservationBotComments {
  const list = Array.isArray(comments) ? comments : [];
  let count = 0;
  const sources: string[] = [];
  for (const comment of list) {
    const login = comment.author?.login;
    if (!login || !isBotLogin(login)) continue;
    count++;
    if (!sources.includes(login) && sources.length < PR_OVERSEER_MAX_NAMES) sources.push(login);
  }
  return { count, sources };
}

function classifyGhError(err: unknown): PrOverseerUnavailableReason {
  if (!err || typeof err !== 'object') return 'error';
  const e = err as { code?: string; message?: string; stderr?: string };
  if (e.code === 'ENOENT') return 'gh-missing';
  const text = `${e.stderr ?? ''} ${e.message ?? ''}`.toLowerCase();
  if (text.includes('not logged into') || text.includes('authentication') || text.includes('gh auth')) {
    return 'auth';
  }
  if (text.includes('not found') || text.includes('could not resolve') || text.includes('no pull requests')) {
    return 'not-found';
  }
  return 'error';
}

/**
 * Unresolved-review-thread count via GraphQL. `gh pr view --json` does not
 * expose thread resolution, so this is a separate bounded query. Throws on any
 * error — callers must handle failure as `ok: false` (fail-closed).
 */
async function fetchUnresolvedThreadCount(
  target: PrObserveTarget,
  exec: PrOverseerExec
): Promise<number> {
  const [owner, repo] = target.ownerRepo.split('/');
  if (!owner || !repo) return 0;
  const query = `query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviewThreads(first: 100) {
        nodes { isResolved }
        pageInfo { hasNextPage }
      }
    }
  }
}`;
  const { stdout } = await exec(
    'gh',
    [
      'api',
      'graphql',
      '-f',
      `query=${query}`,
      '-f',
      `owner=${owner}`,
      '-f',
      `repo=${repo}`,
      '-F',
      `number=${target.number}`,
    ],
    { cwd: target.repoPath, timeout: GH_GRAPHQL_TIMEOUT_MS }
  );
  const parsed = JSON.parse(stdout) as {
    errors?: unknown[];
    data?: {
      repository?: {
        pullRequest?: {
          reviewThreads?: {
            nodes?: Array<{ isResolved?: boolean } | null>;
            pageInfo?: { hasNextPage?: boolean };
          } | null;
        } | null;
      } | null;
    };
  };
  if (Array.isArray(parsed.errors) && parsed.errors.length > 0) {
    throw new Error('GraphQL reviewThreads query returned errors');
  }
  const reviewThreads = parsed.data?.repository?.pullRequest?.reviewThreads;
  if (!reviewThreads || !Array.isArray(reviewThreads.nodes)) {
    throw new Error('GraphQL reviewThreads query returned no nodes');
  }
  if (reviewThreads.pageInfo?.hasNextPage === true) {
    throw new Error('GraphQL reviewThreads query returned a partial page');
  }
  for (const node of reviewThreads.nodes) {
    if (!node || typeof node.isResolved !== 'boolean') {
      throw new Error('GraphQL reviewThreads query returned malformed nodes');
    }
  }
  return reviewThreads.nodes.filter((n) => n?.isResolved === false).length;
}

export interface GhPrObserverOptions {
  exec?: PrOverseerExec;
  /** Set false to skip the extra GraphQL review-thread query (defaults true). */
  includeReviewThreads?: boolean;
}

/**
 * Create the default `gh`-CLI-backed observer. All GitHub access goes through the
 * `gh` CLI so auth is handled by the operator's existing `gh` login — no PATs are
 * plumbed through Relay. Fully injectable for tests.
 */
export function createGhPrObserver(options: GhPrObserverOptions = {}): PrObserver {
  const exec = options.exec ?? (execFileAsync as PrOverseerExec);
  const includeReviewThreads = options.includeReviewThreads ?? true;

  return async (target) => {
    const fetchedAt = new Date().toISOString();
    let raw: GhPrView;
    try {
      const { stdout } = await exec(
        'gh',
        ['pr', 'view', String(target.number), '--repo', target.ownerRepo, '--json', PR_VIEW_FIELDS],
        { cwd: target.repoPath, timeout: GH_VIEW_TIMEOUT_MS }
      );
      if (!stdout.trim()) {
        return { ok: false, fetchedAt, unavailableReason: 'not-found' };
      }
      raw = JSON.parse(stdout) as GhPrView;
    } catch (err) {
      const reason = classifyGhError(err);
      if (reason === 'error') {
        logger.warn(
          `pr-overseer observe failed for ${target.ownerRepo}#${target.number}:`,
          err instanceof Error ? err.message : err
        );
      }
      return { ok: false, fetchedAt, unavailableReason: reason };
    }

    const state = mapPrState(raw.state);
    let unresolvedThreadCount = 0;
    if (includeReviewThreads && state === 'OPEN') {
      try {
        unresolvedThreadCount = await fetchUnresolvedThreadCount(target, exec);
      } catch (threadErr) {
        logger.warn(
          `pr-overseer graphql thread query failed for ${target.ownerRepo}#${target.number}:`,
          threadErr instanceof Error ? threadErr.message : threadErr
        );
        return { ok: false, fetchedAt, unavailableReason: 'error' };
      }
    }

    return {
      ok: true,
      fetchedAt,
      pr: {
        number: raw.number,
        state,
        isDraft: Boolean(raw.isDraft),
        mergeable: mapMergeable(raw.mergeable),
        ...(raw.url ? { url: raw.url } : {}),
        ...(raw.headRefName ? { headRefName: raw.headRefName } : {}),
        ...(raw.baseRefName ? { baseRefName: raw.baseRefName } : {}),
        ...(raw.headRefOid ? { headSha: raw.headRefOid.toLowerCase() } : {}),
        ...(raw.mergeStateStatus ? { mergeStateStatus: raw.mergeStateStatus } : {}),
        ...(raw.updatedAt ? { updatedAt: raw.updatedAt } : {}),
      },
      checks: summarizeChecks(raw.statusCheckRollup),
      reviews: summarizeReviews(raw.reviewDecision, raw.latestReviews, unresolvedThreadCount),
      botComments: summarizeBotComments(raw.comments),
      closingIssueNumbers: Array.isArray(raw.closingIssuesReferences)
        ? raw.closingIssuesReferences
            .map((ref) => ref.number)
            .filter((n): n is number => typeof n === 'number')
        : [],
    };
  };
}
