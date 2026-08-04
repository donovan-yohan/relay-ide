import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { loadConfig, saveConfig } from './config.js';
import { extractOwnerRepo } from './git.js';
import { findOrCreateWorktreeForBranch } from './watcher.js';
import type { Config } from './types.js';
import { createLogger } from './logger.js';

const execFileAsync = promisify(execFile);

const GH_TIMEOUT_MS = 15_000;
const DEFAULT_POLL_INTERVAL_MS = 300_000; // 5 minutes
const logger = createLogger('review-poller');

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ReviewPollerDeps {
  configPath: string;
  getWorkspacePaths: () => string[];
  broadcastEvent: (event: string, data?: Record<string, unknown>) => void;
  execAsync?: typeof execFileAsync;
}

interface GhNotification {
  id: string;
  reason: string;
  subject: {
    title: string;
    url: string; // e.g. "https://api.github.com/repos/owner/repo/pulls/123"
    type: string;
  };
  repository: {
    full_name: string; // e.g. "owner/repo"
  };
  updated_at: string;
}

// ─── Module state ─────────────────────────────────────────────────────────────

let timer: ReturnType<typeof setInterval> | null = null;
let ghMissingWarned = false;
let pollInFlight = false;
let activePollPromise: Promise<void> | null = null;

// ─── Public API ───────────────────────────────────────────────────────────────

export function startPolling(deps: ReviewPollerDeps): void {
  if (timer !== null) return;

  const config = loadConfig(deps.configPath);
  const intervalMs =
    config.automations?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  activePollPromise = pollOnce(deps);
  activePollPromise.finally(() => {
    activePollPromise = null;
  });
  timer = setInterval(() => {
    activePollPromise = pollOnce(deps);
    activePollPromise.finally(() => {
      activePollPromise = null;
    });
  }, intervalMs);
}

export async function stopPolling(): Promise<void> {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
  if (activePollPromise) {
    await activePollPromise;
    activePollPromise = null;
  }
  ghMissingWarned = false;
}

export function isPolling(): boolean {
  return timer !== null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Extracts the PR number from a GitHub API URL like .../pulls/123 */
function extractPrNumber(subjectUrl: string): number | null {
  const match = subjectUrl.match(/\/pulls\/(\d+)$/);
  if (!match) return null;
  const num = parseInt(match[1] ?? '', 10);
  return isNaN(num) ? null : num;
}

/** Returns the workspace path whose git remote matches the given owner/repo, or null. */
async function findWorkspaceForRepo(
  ownerRepo: string,
  workspacePaths: string[],
  exec: typeof execFileAsync
): Promise<string | null> {
  for (const repoPath of workspacePaths) {
    try {
      const { stdout } = await exec('git', ['remote', 'get-url', 'origin'], {
        cwd: repoPath,
        timeout: GH_TIMEOUT_MS,
      });
      const remoteOwnerRepo = extractOwnerRepo(stdout.trim());
      if (
        remoteOwnerRepo &&
        remoteOwnerRepo.toLowerCase() === ownerRepo.toLowerCase()
      ) {
        return repoPath;
      }
    } catch (err) {
      // Not a git repo, no remote, or timed out — skip this repo
      const error = err as NodeJS.ErrnoException;
      if (error.code && error.code !== 'ENOENT') {
        logger.warn(`Error checking remote for ${repoPath}:`, error.message);
      }
    }
  }
  return null;
}

// ─── Core poll logic ──────────────────────────────────────────────────────────

/** Fetches review_requested notifications from GitHub. Returns null if polling should stop. */
async function fetchReviewNotifications(
  exec: typeof execFileAsync
): Promise<GhNotification[] | null> {
  try {
    const { stdout } = await exec(
      'gh',
      [
        'api',
        '/notifications',
        '--jq',
        '.[] | select(.reason == "review_requested") | {id, reason, subject, repository, updated_at}',
      ],
      { timeout: GH_TIMEOUT_MS }
    );

    const lines = stdout.trim().split('\n').filter(Boolean);
    const notifications: GhNotification[] = [];
    let parseFailures = 0;
    for (const line of lines) {
      try {
        notifications.push(JSON.parse(line) as GhNotification);
      } catch {
        parseFailures++;
      }
    }
    if (parseFailures > 0 && notifications.length === 0) {
      logger.warn(
        `All ${parseFailures} notification lines failed to parse — gh output format may have changed`
      );
    }
    return notifications;
  } catch (err) {
    const error = err as NodeJS.ErrnoException & { killed?: boolean };
    if (error.code === 'ENOENT') {
      if (!ghMissingWarned) {
        logger.warn('gh CLI not found — stopping poller');
        ghMissingWarned = true;
      }
      void stopPolling();
      return null;
    }
    if (error.killed) {
      logger.warn('gh notifications timed out, skipping cycle');
      return null;
    }
    logger.warn('gh notifications failed, skipping cycle:', error.message);
    return null;
  }
}

/** Processes a single PR notification: fetches its branch and creates a worktree. */
async function processNotification(
  notification: GhNotification,
  deps: ReviewPollerDeps,
  exec: typeof execFileAsync
): Promise<void> {
  if (notification.subject.type !== 'PullRequest') return;

  const prNumber = extractPrNumber(notification.subject.url);
  if (prNumber === null) {
    logger.warn('Could not extract PR number from:', notification.subject.url);
    return;
  }

  const ownerRepo = notification.repository.full_name;
  const workspacePaths = deps.getWorkspacePaths();

  let repoPath: string | null;
  try {
    repoPath = await findWorkspaceForRepo(ownerRepo, workspacePaths, exec);
  } catch (err) {
    logger.warn('Error finding workspace for', ownerRepo, ':', err);
    return;
  }

  if (repoPath === null) {
    return;
  }

  const localBranch = `review-pr-${prNumber}`;

  try {
    await exec(
      'git',
      ['fetch', 'origin', `pull/${prNumber}/head:${localBranch}`],
      { cwd: repoPath, timeout: GH_TIMEOUT_MS }
    );
  } catch (err) {
    const errMsg = (err as Error).message ?? '';
    if (!errMsg.includes('already exists')) {
      logger.warn(`Failed to fetch PR #${prNumber}:`, err);
      return;
    }
  }

  let result;
  try {
    result = await findOrCreateWorktreeForBranch(repoPath, localBranch, exec);
  } catch (err) {
    logger.warn(`Failed to create worktree for PR #${prNumber}:`, err);
    return;
  }

  if (result.existing) {
    return;
  }

  deps.broadcastEvent('review-checkout', {
    prNumber,
    ownerRepo,
    worktreePath: result.worktreePath,
    branchName: localBranch,
    title: notification.subject.title,
  });
}

/** Persists the poll watermark timestamp to config, re-reading first to avoid clobbering concurrent changes. */
function savePollTimestamp(configPath: string, timestamp: string): void {
  try {
    const freshConfig = loadConfig(configPath);
    freshConfig.automations = {
      ...freshConfig.automations,
      lastPollTimestamp: timestamp,
    };
    saveConfig(configPath, freshConfig);
  } catch (err) {
    logger.warn('Failed to save config after poll:', err);
  }
}

async function pollOnce(deps: ReviewPollerDeps): Promise<void> {
  if (pollInFlight) return;
  pollInFlight = true;

  try {
    const exec = deps.execAsync ?? execFileAsync;

    let config: Config;
    try {
      config = loadConfig(deps.configPath);
    } catch (err) {
      logger.warn('Failed to load config:', err);
      return;
    }

    if (!config.automations?.autoCheckoutReviewRequests) return;

    // Capture poll-start time as watermark — avoids gap where notifications
    // arriving between fetch and save would be skipped permanently
    const pollStartTimestamp = new Date().toISOString();

    // First run: default to "now" so we skip all historical notifications.
    // The first poll cycle always produces zero checkouts — only notifications
    // arriving after this timestamp will be processed.
    const lastPollTimestamp =
      config.automations?.lastPollTimestamp ?? new Date().toISOString();

    const notifications = await fetchReviewNotifications(exec);
    if (notifications === null) return;

    const newNotifications = notifications.filter(
      (n) => new Date(n.updated_at) > new Date(lastPollTimestamp)
    );

    for (const notification of newNotifications) {
      await processNotification(notification, deps, exec);
    }

    savePollTimestamp(deps.configPath, pollStartTimestamp);
  } finally {
    pollInFlight = false;
  }
}
