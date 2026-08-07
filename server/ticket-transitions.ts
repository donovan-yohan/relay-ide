import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { Router } from 'express';

import { loadConfig } from './config.js';
import type {
  Config,
  TicketContext,
  TransitionState,
  BranchLink,
} from './types.js';
import { createLogger } from './logger.js';

const execFileAsync = promisify(execFile);
const logger = createLogger('ticket-transitions');

const GH_TIMEOUT_MS = 10_000;
const LABEL_IN_PROGRESS = 'in-progress';
const LABEL_CODE_REVIEW = 'code-review';
const LABEL_READY_FOR_QA = 'ready-for-qa';

export interface TicketTransitionsDeps {
  configPath: string;
  execAsync?: typeof execFileAsync;
}

// Minimal PR shape needed for transition checks
interface PrForTransition {
  number: number;
  headRefName: string;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  repoPath?: string | undefined;
}

function ghIssueNumber(ticketId: string): string | null {
  const match = ticketId.match(/^GH-(\d+)$/i);
  return match ? match[1]! : null;
}

async function addLabel(
  exec: typeof execFileAsync,
  repoPath: string,
  issueNumber: string,
  label: string
): Promise<boolean> {
  try {
    await exec('gh', ['issue', 'edit', issueNumber, '--add-label', label], {
      cwd: repoPath,
      timeout: GH_TIMEOUT_MS,
    });
    return true;
  } catch (err) {
    logger.error(
      `[ticket-transitions] Failed to add label "${label}" to #${issueNumber}:`,
      err
    );
    return false;
  }
}

async function removeLabel(
  exec: typeof execFileAsync,
  repoPath: string,
  issueNumber: string,
  label: string
): Promise<void> {
  try {
    await exec('gh', ['issue', 'edit', issueNumber, '--remove-label', label], {
      cwd: repoPath,
      timeout: GH_TIMEOUT_MS,
    });
  } catch {
    // Label may not exist — non-fatal
  }
}

/** Call a Jira transition by name via acli. Returns true on success, false on failure. */
async function jiraTransition(
  exec: typeof execFileAsync,
  ticketId: string,
  transitionName: string
): Promise<boolean> {
  try {
    await exec(
      'acli',
      [
        'jira',
        'workitem',
        'transition',
        '--key',
        ticketId,
        '--status',
        transitionName,
        '--yes',
      ],
      { timeout: 10_000 }
    );
    return true;
  } catch (err) {
    logger.error(
      `[ticket-transitions] Jira transition failed for ${ticketId}:`,
      err
    );
    return false;
  }
}

/**
 * Best-effort source detection from a ticket ID pattern.
 */
function detectTicketSource(
  ticketId: string,
  links?: BranchLink[]
): 'github' | 'jira' {
  // Use explicit source from branch link if available
  if (links) {
    const linkWithSource = links.find((l) => l.source);
    if (linkWithSource?.source) return linkWithSource.source;
  }
  if (ticketId.startsWith('GH-')) return 'github';
  // Prefer Jira for PROJECT-style keys (>= 3 uppercase letters before dash).
  const prefix = ticketId.split('-')[0] ?? '';
  if (prefix.length >= 3) return 'jira';
  return 'github'; // fallback
}

export function createTicketTransitionsRouter(deps: TicketTransitionsDeps) {
  // In-memory idempotency guard: ticketId -> last transitioned state
  const transitionMap = new Map<string, TransitionState>();
  const exec = deps.execAsync ?? execFileAsync;
  const { configPath } = deps;
  const router = Router();

  /** Get Jira status mapping for a transition state from config */
  function getJiraStatusMapping(
    config: Config,
    state: TransitionState
  ): string | undefined {
    return config.integrations?.jira?.statusMappings?.[state];
  }

  async function transitionOnSessionCreate(ctx: TicketContext): Promise<void> {
    const current = transitionMap.get(ctx.ticketId);
    if (current && current !== 'none') return;

    if (ctx.source === 'github') {
      const issueNum = ghIssueNumber(ctx.ticketId);
      if (!issueNum) return;
      const ok = await addLabel(
        exec,
        ctx.repoPath,
        issueNum,
        LABEL_IN_PROGRESS
      );
      if (ok) transitionMap.set(ctx.ticketId, LABEL_IN_PROGRESS);
    } else if (ctx.source === 'jira') {
      const config = loadConfig(configPath);
      const transitionName = getJiraStatusMapping(config, LABEL_IN_PROGRESS);
      if (transitionName) {
        const ok = await jiraTransition(exec, ctx.ticketId, transitionName);
        if (ok) transitionMap.set(ctx.ticketId, LABEL_IN_PROGRESS);
      }
    }
  }

  async function applyGithubTransition(
    ticketId: string,
    links: BranchLink[],
    removeFrom: string,
    addTo: TransitionState
  ): Promise<boolean> {
    const issueNum = ghIssueNumber(ticketId);
    if (!issueNum) return false;
    const repoPath = links[0]?.repoPath;
    if (!repoPath) return false;
    await removeLabel(exec, repoPath, issueNum, removeFrom);
    return addLabel(exec, repoPath, issueNum, addTo);
  }

  async function applyJiraTransition(
    config: Config,
    ticketId: string,
    targetState: TransitionState
  ): Promise<boolean> {
    const transitionName = getJiraStatusMapping(config, targetState);
    if (!transitionName) return false;
    return jiraTransition(exec, ticketId, transitionName);
  }

  async function transitionToCodeReview(
    config: Config,
    ticketId: string,
    links: BranchLink[],
    source: 'github' | 'jira'
  ): Promise<void> {
    let ok = false;
    if (source === 'github') {
      ok = await applyGithubTransition(
        ticketId,
        links,
        LABEL_IN_PROGRESS,
        LABEL_CODE_REVIEW
      );
    } else if (source === 'jira') {
      ok = await applyJiraTransition(config, ticketId, LABEL_CODE_REVIEW);
    }
    if (ok) transitionMap.set(ticketId, LABEL_CODE_REVIEW);
  }

  async function transitionToReadyForQa(
    config: Config,
    ticketId: string,
    links: BranchLink[],
    source: 'github' | 'jira'
  ): Promise<void> {
    let ok = false;
    if (source === 'github') {
      ok = await applyGithubTransition(
        ticketId,
        links,
        LABEL_CODE_REVIEW,
        LABEL_READY_FOR_QA
      );
    } else if (source === 'jira') {
      ok = await applyJiraTransition(config, ticketId, LABEL_READY_FOR_QA);
    }
    if (ok) transitionMap.set(ticketId, LABEL_READY_FOR_QA);
  }

  async function checkPrTransitions(
    prs: PrForTransition[],
    branchLinks: Record<string, BranchLink[]>
  ): Promise<void> {
    const config = loadConfig(configPath);
    for (const pr of prs) {
      for (const [ticketId, links] of Object.entries(branchLinks)) {
        const linked = links.some((l) => l.branchName === pr.headRefName);
        if (!linked) continue;

        const current = transitionMap.get(ticketId);
        const source = detectTicketSource(ticketId, links);

        if (
          pr.state === 'OPEN' &&
          current !== LABEL_CODE_REVIEW &&
          current !== LABEL_READY_FOR_QA
        ) {
          await transitionToCodeReview(config, ticketId, links, source);
        } else if (pr.state === 'MERGED' && current !== LABEL_READY_FOR_QA) {
          await transitionToReadyForQa(config, ticketId, links, source);
        }
      }
    }
  }

  return { router, transitionOnSessionCreate, checkPrTransitions };
}
