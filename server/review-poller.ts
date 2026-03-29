import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { loadConfig, saveConfig } from './config.js';
import { extractOwnerRepo } from './git.js';
import { findOrCreateWorktreeForBranch } from './watcher.js';
import type { Config, WorkspaceSettings } from './types.js';

const execFileAsync = promisify(execFile);

const GH_TIMEOUT_MS = 15_000;
const DEFAULT_POLL_INTERVAL_MS = 300_000; // 5 minutes

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ReviewPollerDeps {
  configPath: string;
  getWorkspacePaths: () => string[];
  getRepoSettings: (repoPath: string) => WorkspaceSettings | undefined;
  createSession: (opts: {
    repoPath: string;
    worktreePath: string;
    branchName: string;
    initialPrompt?: string;
  }) => Promise<void>;
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
  const intervalMs = config.automations?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  activePollPromise = pollOnce(deps);
  activePollPromise.finally(() => { activePollPromise = null; });
  timer = setInterval(() => {
    activePollPromise = pollOnce(deps);
    activePollPromise.finally(() => { activePollPromise = null; });
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
  exec: typeof execFileAsync,
): Promise<string | null> {
  for (const repoPath of workspacePaths) {
    try {
      const { stdout } = await exec('git', ['remote', 'get-url', 'origin'], {
        cwd: repoPath,
        timeout: GH_TIMEOUT_MS,
      });
      const remoteOwnerRepo = extractOwnerRepo(stdout.trim());
      if (remoteOwnerRepo && remoteOwnerRepo.toLowerCase() === ownerRepo.toLowerCase()) {
        return repoPath;
      }
    } catch (err) {
      // Not a git repo, no remote, or timed out — skip this repo
      const error = err as NodeJS.ErrnoException;
      if (error.code && error.code !== 'ENOENT') {
        console.warn(`[review-poller] Error checking remote for ${repoPath}:`, error.message);
      }
    }
  }
  return null;
}

// ─── Core poll logic ──────────────────────────────────────────────────────────

async function pollOnce(deps: ReviewPollerDeps): Promise<void> {
  if (pollInFlight) return;
  pollInFlight = true;

  try {
    const exec = deps.execAsync ?? execFileAsync;

    let config: Config;
    try {
      config = loadConfig(deps.configPath);
    } catch (err) {
      console.warn('[review-poller] Failed to load config:', err);
      return;
    }

    if (!config.automations?.autoCheckoutReviewRequests) return;

    // Capture poll-start time as watermark — avoids gap where notifications
    // arriving between fetch and save would be skipped permanently
    const pollStartTimestamp = new Date().toISOString();

    // First run: default to "now" so we skip all historical notifications.
    // The first poll cycle always produces zero checkouts — only notifications
    // arriving after this timestamp will be processed.
    const lastPollTimestamp = config.automations?.lastPollTimestamp ?? new Date().toISOString();

    // Fetch review_requested notifications from GitHub
    let notifications: GhNotification[];
    try {
      const { stdout } = await exec(
        'gh',
        [
          'api',
          '/notifications',
          '--jq',
          '.[] | select(.reason == "review_requested") | {id, reason, subject, repository, updated_at}',
        ],
        { timeout: GH_TIMEOUT_MS },
      );

      // gh --jq with select returns newline-delimited JSON objects
      const lines = stdout.trim().split('\n').filter(Boolean);
      notifications = [];
      let parseFailures = 0;
      for (const line of lines) {
        try {
          notifications.push(JSON.parse(line) as GhNotification);
        } catch {
          parseFailures++;
        }
      }
      if (parseFailures > 0 && notifications.length === 0) {
        console.warn(`[review-poller] All ${parseFailures} notification lines failed to parse — gh output format may have changed`);
      }
    } catch (err) {
      const error = err as NodeJS.ErrnoException & { killed?: boolean };
      if (error.code === 'ENOENT') {
        if (!ghMissingWarned) {
          console.warn('[review-poller] gh CLI not found — stopping poller');
          ghMissingWarned = true;
        }
        void stopPolling();
        return;
      }
      if (error.killed) {
        console.warn('[review-poller] gh notifications timed out, skipping cycle');
        return;
      }
      // Auth failures and other gh errors come through stderr in the error message
      console.warn('[review-poller] gh notifications failed, skipping cycle:', error.message);
      return;
    }

    // Filter to notifications newer than the last poll
    const newNotifications = notifications.filter(
      (n) => new Date(n.updated_at) > new Date(lastPollTimestamp),
    );

    const workspacePaths = deps.getWorkspacePaths();

    for (const notification of newNotifications) {
      if (notification.subject.type !== 'PullRequest') continue;

      const prNumber = extractPrNumber(notification.subject.url);
      if (prNumber === null) {
        console.warn('[review-poller] Could not extract PR number from:', notification.subject.url);
        continue;
      }

      const ownerRepo = notification.repository.full_name;

      let repoPath: string | null;
      try {
        repoPath = await findWorkspaceForRepo(ownerRepo, workspacePaths, exec);
      } catch (err) {
        console.warn('[review-poller] Error finding workspace for', ownerRepo, ':', err);
        continue;
      }

      if (repoPath === null) {
        // No local workspace for this repo — skip silently
        continue;
      }

      const localBranch = `review-pr-${prNumber}`;

      // Fetch the PR's head ref into a local branch
      try {
        await exec(
          'git',
          ['fetch', 'origin', `pull/${prNumber}/head:${localBranch}`],
          { cwd: repoPath, timeout: GH_TIMEOUT_MS },
        );
      } catch (err) {
        // Branch may already exist from a prior fetch — continue to worktree creation
        const errMsg = (err as Error).message ?? '';
        if (!errMsg.includes('already exists')) {
          console.warn(`[review-poller] Failed to fetch PR #${prNumber}:`, err);
          continue;
        }
      }

      // Find existing worktree for this branch or create a new one
      let result;
      try {
        result = await findOrCreateWorktreeForBranch(repoPath, localBranch, exec);
      } catch (err) {
        console.warn(`[review-poller] Failed to create worktree for PR #${prNumber}:`, err);
        continue;
      }

      // Skip session creation if worktree already existed (previous poll already handled it)
      if (result.existing) {
        continue;
      }

      // Optionally start a review session
      const settings = deps.getRepoSettings(repoPath);
      if (config.automations?.autoReviewOnCheckout && settings?.promptCodeReview) {
        try {
          await deps.createSession({
            repoPath,
            worktreePath: result.worktreePath,
            branchName: localBranch,
            initialPrompt: settings.promptCodeReview,
          });
        } catch (err) {
          console.warn(`[review-poller] Failed to create review session for PR #${prNumber}:`, err);
        }
      }

      deps.broadcastEvent('review-checkout', {
        prNumber,
        ownerRepo,
        worktreePath: result.worktreePath,
        branchName: localBranch,
        title: notification.subject.title,
      });
    }

    // Update lastPollTimestamp — re-read config to avoid overwriting concurrent changes
    try {
      const freshConfig = loadConfig(deps.configPath);
      freshConfig.automations = {
        ...freshConfig.automations,
        lastPollTimestamp: pollStartTimestamp,
      };
      saveConfig(deps.configPath, freshConfig);
    } catch (err) {
      console.warn('[review-poller] Failed to save config after poll:', err);
    }
  } finally {
    pollInFlight = false;
  }
}
