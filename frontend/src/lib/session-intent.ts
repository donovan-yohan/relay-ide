import type {
  PullRequest,
  SessionSummary,
  WorktreeInfo,
  GitHubIssue,
} from './types.js';
import {
  derivePrAction,
  getActionPrompt,
  buildPrStateInput,
} from './pr-state.js';
import type { StatusColor, PrActionType } from './pr-state.js';

export type SessionIntentType =
  | 'review-pr'
  | 'fix-conflicts'
  | 'fix-errors'
  | 'resolve-comments'
  | 'merge-pr'
  | 'create-pr'
  | 'open-branch'
  | 'start-from-issue'
  | 'resume-session'
  | 'archive';

const RESUME_SESSION = 'resume-session' as const;
const OPEN_BRANCH = 'open-branch' as const;

// TODO: refine into a discriminated union so resume-session requires existingSessionId at compile time:
//   type SessionIntent = ResumeIntent | ActionIntent;
//   interface ResumeIntent { type: 'resume-session'; existingSessionId: string; ... }
//   interface ActionIntent { type: Exclude<SessionIntentType, 'resume-session'>; ... }
export interface SessionIntent {
  type: SessionIntentType;
  label: string;
  color: StatusColor;
  prompt: string | null;
  existingSessionId?: string;
  existingWorktreePath?: string;
}

export type PickerItem =
  | { kind: 'pr'; pr: PullRequest }
  | {
      kind: 'branch';
      name: string;
      ahead: number;
      behind: number;
      prNumber: number | null;
      repoPath: string;
    }
  | { kind: 'issue'; issue: GitHubIssue };

/**
 * Resolve the available actions for a picker item based on role and existing state.
 * Returns at least one intent. First is primary, rest are secondary.
 */
export function resolveIntent(
  item: PickerItem,
  _role: 'author' | 'reviewer',
  sessions: SessionSummary[],
  worktrees: WorktreeInfo[]
): SessionIntent[] {
  switch (item.kind) {
    case 'pr':
      return resolvePrIntent(item.pr, sessions, worktrees);
    case 'branch':
      return resolveBranchIntent(item, sessions, worktrees);
    case 'issue':
      return resolveIssueIntent(item.issue, sessions);
  }
}

function resolvePrIntent(
  pr: PullRequest,
  sessions: SessionSummary[],
  _worktrees: WorktreeInfo[]
): SessionIntent[] {
  const intents: SessionIntent[] = [];

  // Check for existing session on this PR's branch
  const existingSession = sessions.find((s) => s.branchName === pr.headRefName);

  const prStateInput = buildPrStateInput(pr);

  const prAction = derivePrAction(prStateInput);
  const actionCtx = {
    branchName: pr.headRefName,
    baseBranch: pr.baseRefName,
    prNumber: pr.number,
    unresolvedCommentCount: prStateInput.unresolvedCommentCount,
  };
  const prompt = getActionPrompt(prAction, actionCtx);

  // Map PrAction to SessionIntent
  const intentType = mapPrActionToIntent(prAction.type);
  const primaryIntent: SessionIntent = {
    type: intentType,
    label: prAction.label,
    color: prAction.color,
    prompt,
  };
  if (existingSession?.id) primaryIntent.existingSessionId = existingSession.id;
  if (existingSession?.worktreePath)
    primaryIntent.existingWorktreePath = existingSession.worktreePath;
  intents.push(primaryIntent);

  // Add resume-session if session exists and primary isn't already resume
  if (existingSession && intentType !== RESUME_SESSION) {
    const resumeIntent: SessionIntent = {
      type: RESUME_SESSION,
      label: 'Resume',
      color: 'muted',
      prompt: null,
      existingSessionId: existingSession.id,
    };
    if (existingSession.worktreePath)
      resumeIntent.existingWorktreePath = existingSession.worktreePath;
    intents.push(resumeIntent);
  }

  return intents;
}

function mapPrActionToIntent(actionType: PrActionType): SessionIntentType {
  switch (actionType) {
    case 'review-pr':
      return 'review-pr';
    case 'merge-pr':
      return 'merge-pr';
    case 'fix-conflicts':
      return 'fix-conflicts';
    case 'fix-errors':
      return 'fix-errors';
    case 'resolve-comments':
      return 'resolve-comments';
    case 'create-pr':
      return 'create-pr';
    case 'archive-merged':
    case 'archive-closed':
      return 'archive';
    case 'ready-for-review':
      return OPEN_BRANCH;
    case 'checks-running':
      return OPEN_BRANCH;
    case 'none':
      return OPEN_BRANCH;
  }
}

function resolveBranchIntent(
  item: {
    kind: 'branch';
    name: string;
    ahead: number;
    behind: number;
    prNumber: number | null;
    repoPath: string;
  },
  sessions: SessionSummary[],
  worktrees: WorktreeInfo[]
): SessionIntent[] {
  const existingSession = sessions.find((s) => s.branchName === item.name);
  const existingWorktree = worktrees.find((w) => w.branchName === item.name);

  if (existingSession) {
    const resumeIntent: SessionIntent = {
      type: 'resume-session',
      label: 'Resume',
      color: 'accent',
      prompt: null,
      existingSessionId: existingSession.id,
    };
    if (existingSession.worktreePath)
      resumeIntent.existingWorktreePath = existingSession.worktreePath;
    return [resumeIntent];
  }

  const openIntent: SessionIntent = {
    type: 'open-branch',
    label: 'Open',
    color: 'accent',
    prompt: `Continue working on branch "${item.name}".`,
  };
  if (existingWorktree?.path)
    openIntent.existingWorktreePath = existingWorktree.path;
  return [openIntent];
}

function resolveIssueIntent(
  issue: GitHubIssue,
  sessions: SessionSummary[]
): SessionIntent[] {
  // Check if a session already exists for a branch matching this issue
  // Use regex with word boundary to avoid false-positives (e.g., issue-12 matching issue-123)
  const issueBranchPattern = new RegExp(`issue-${issue.number}(?:-|$)`);
  const existingSession = sessions.find((s) =>
    issueBranchPattern.test(s.branchName)
  );

  if (existingSession) {
    const resumeIntent: SessionIntent = {
      type: 'resume-session',
      label: 'Resume',
      color: 'accent',
      prompt: null,
      existingSessionId: existingSession.id,
    };
    if (existingSession.worktreePath)
      resumeIntent.existingWorktreePath = existingSession.worktreePath;
    return [
      resumeIntent,
      {
        type: 'start-from-issue',
        label: 'Start New',
        color: 'muted',
        prompt: buildIssuePrompt(issue),
      },
    ];
  }

  return [
    {
      type: 'start-from-issue',
      label: 'Start',
      color: 'accent',
      prompt: buildIssuePrompt(issue),
    },
  ];
}

function buildIssuePrompt(issue: GitHubIssue): string {
  const labels = issue.labels.map((l) => l.name).join(', ');
  return `Work on issue #${issue.number}: ${issue.title}\n\nLabels: ${labels}`;
}

/**
 * Derive a branch name from a GitHub issue.
 * Format: {type}/issue-{number}-{slug}
 * Type is derived from labels: bug → fix, all others → feat
 * Slug is first 5 words of title, lowercased and hyphenated.
 */
export function issueToBranchName(issue: GitHubIssue): string {
  const labelNames = issue.labels.map((l) => l.name.toLowerCase());
  const type = labelNames.includes('bug') ? 'fix' : 'feat';
  const slug = issue.title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .split(/\s+/)
    .slice(0, 5)
    .join('-');
  return `${type}/issue-${issue.number}-${slug}`;
}
