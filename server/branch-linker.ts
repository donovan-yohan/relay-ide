import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { Router } from 'express';
import type { Request, Response } from 'express';

import { loadConfig } from './config.js';
import type { Config, BranchLink, BranchLinksResponse } from './types.js';

const execFileAsync = promisify(execFile);

const GIT_TIMEOUT_MS = 10_000;
const CACHE_TTL_MS = 60_000;

// Deps type

export interface BranchLinkerDeps {
  configPath: string;
  /** Injected so tests can override execFile calls */
  execAsync?: typeof execFileAsync;
  /** Returns a map of repoPath -> set of active branch names */
  getActiveBranchNames?: () => Map<string, Set<string>>;
}

// Module-level cache
interface CacheEntry {
  links: BranchLinksResponse;
  fetchedAt: number;
}

let cache: CacheEntry | null = null;

/** Clears the branch linker cache (call when sessions are created or ended). */
export function invalidateBranchLinkerCache(): void {
  cache = null;
}

/**
 * Extracts all ticket IDs from a branch name.
 * Returns an array of normalized ticket IDs (e.g. "PROJ-123", "GH-456").
 */
function extractTicketIds(branchName: string): string[] {
  const ids: string[] = [];

  // Jira style: PROJECT-123 (2+ uppercase letters, dash, digits)
  // Skip "GH" prefix — that's our GitHub Issues namespace, handled separately below.
  const jiraRegex = /([A-Z]{2,}-\d+)/gi;
  let match: RegExpExecArray | null;
  while ((match = jiraRegex.exec(branchName)) !== null) {
    if (match[1] && match[1].toUpperCase().split('-')[0] !== 'GH') {
      ids.push(match[1]!.toUpperCase());
    }
  }

  // GitHub Issues: gh-123 at word boundaries (start/end or preceded/followed by dash or slash)
  const ghRegex = /(?:^|[-/])gh-(\d+)(?:[-/]|$)/gi;
  while ((match = ghRegex.exec(branchName)) !== null) {
    ids.push(`GH-${match[1]!}`);
  }

  return ids;
}

/**
 * Creates and returns an Express Router that handles all /branch-linker routes.
 *
 * Caller is responsible for mounting and applying auth middleware:
 *   app.use('/branch-linker', requireAuth, createBranchLinkerRouter({ configPath }));
 */
export function createBranchLinkerRouter(deps: BranchLinkerDeps): Router & { fetchLinks: () => Promise<BranchLinksResponse> } {
  const { configPath } = deps;
  const exec = deps.execAsync ?? execFileAsync;
  const getActiveBranchNames = deps.getActiveBranchNames ?? (() => new Map<string, Set<string>>());

  const router = Router();

  function getConfig(): Config {
    return loadConfig(configPath);
  }

  /** Core link-building logic, usable both from the HTTP handler and internal callers. */
  async function fetchLinks(): Promise<BranchLinksResponse> {
    const config = getConfig();
    const workspacePaths = config.repos ?? [];

    if (workspacePaths.length === 0) {
      return {};
    }

    const now = Date.now();

    // Return cached result if still fresh
    if (cache && now - cache.fetchedAt < CACHE_TTL_MS) {
      return cache.links;
    }

    // Get active branch names per repo from sessions
    const activeBranchNames = getActiveBranchNames();

    // Fetch branches per workspace using Promise.allSettled (partial failures are non-fatal)
    const results = await Promise.allSettled(
      workspacePaths.map(async (wsPath) => {
        let stdout: string;
        try {
          ({ stdout } = await exec(
            'git',
            ['branch', '--format=%(refname:short)'],
            { cwd: wsPath, timeout: GIT_TIMEOUT_MS },
          ));
        } catch {
          // Not a git repo or git not available — non-fatal
          return [];
        }

        const repoName = path.basename(wsPath);
        const activeInRepo = activeBranchNames.get(wsPath) ?? new Set<string>();

        const branchNames = stdout.split('\n').map((b) => b.trim()).filter(Boolean);
        const links: Array<{ ticketId: string; link: BranchLink }> = [];

        for (const branchName of branchNames) {
          const ticketIds = extractTicketIds(branchName);
          for (const ticketId of ticketIds) {
            // Infer ticket source from ID pattern
            let source: 'github' | 'jira' | undefined;
            if (ticketId.startsWith('GH-')) {
              source = 'github';
            } else {
              // Non-GH ticket IDs (e.g., PROJ-123) assumed to be Jira
              source = 'jira';
            }
            links.push({
              ticketId,
              link: {
                repoPath: wsPath,
                repoName,
                branchName,
                hasActiveSession: activeInRepo.has(branchName),
                source,
              },
            });
          }
        }

        return links;
      }),
    );

    // Build the ticket -> BranchLink[] map
    const linksMap = new Map<string, BranchLink[]>();

    for (const result of results) {
      if (result.status === 'fulfilled') {
        for (const { ticketId, link } of result.value) {
          const existing = linksMap.get(ticketId);
          if (existing) {
            existing.push(link);
          } else {
            linksMap.set(ticketId, [link]);
          }
        }
      }
    }

    // Convert Map to plain object for JSON serialization
    const response: BranchLinksResponse = {};
    for (const [ticketId, links] of linksMap) {
      response[ticketId] = links;
    }

    // Update module-level cache
    cache = { links: response, fetchedAt: now };

    return response;
  }

  // GET /branch-linker/links — map of ticketId -> BranchLink[]
  router.get('/links', async (_req: Request, res: Response) => {
    const response = await fetchLinks();
    res.json(response);
  });

  return Object.assign(router, { fetchLinks });
}
