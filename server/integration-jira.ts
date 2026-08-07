import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { Router } from 'express';
import type { Request, Response } from 'express';

import type { JiraIssue, JiraIssuesResponse, JiraStatus } from './types.js';

const execFileAsync = promisify(execFile);

const JIRA_TIMEOUT_MS = 10_000;
const CACHE_TTL_MS = 60_000;
const JIRA_ISSUES_CACHE_KEY = 'jira_issues';

// Deps type

export interface IntegrationJiraDeps {
  configPath: string;
  /** Injected so tests can override execFile calls */
  execAsync?: typeof execFileAsync;
}

// In-memory cache (single key since Jira is cross-workspace)
interface CacheEntry {
  issues: JiraIssue[];
  fetchedAt: number;
}

// Raw shape returned by acli jira workitem search --json
interface AcliWorkItem {
  key: string;
  fields: {
    summary: string;
    status: { id: string; name: string };
    priority?: { name: string } | null;
    assignee?: { displayName: string } | null;
  };
}

/**
 * Creates and returns an Express Router that handles all /integration-jira routes.
 *
 * Caller is responsible for mounting and applying auth middleware:
 *   app.use('/integration-jira', requireAuth, createIntegrationJiraRouter({ configPath }));
 */
export function createIntegrationJiraRouter(deps: IntegrationJiraDeps): Router {
  const exec = deps.execAsync ?? execFileAsync;

  const router = Router();

  // Single 60s in-memory cache (Jira is cross-workspace, not per-repo)
  const issuesCache = new Map<string, CacheEntry>();

  // Cached site URL — resolved once per server lifetime
  let cachedSiteUrl: string | null = null;

  async function getSiteUrl(): Promise<string> {
    if (cachedSiteUrl !== null) return cachedSiteUrl;

    const { stdout } = await exec('acli', ['jira', 'auth', 'status'], {
      timeout: JIRA_TIMEOUT_MS,
    });
    const match = /Site:\s*([\w-]+\.atlassian\.net)/.exec(stdout);
    if (!match || !match[1]) {
      throw new Error(
        'Could not parse site URL from acli jira auth status output'
      );
    }
    cachedSiteUrl = match[1];
    return cachedSiteUrl;
  }

  // GET /integrations/jira/issues — search issues assigned to currentUser
  router.get('/issues', async (_req: Request, res: Response) => {
    const now = Date.now();

    // Return cached result if still fresh
    const cached = issuesCache.get(JIRA_ISSUES_CACHE_KEY);
    if (cached && now - cached.fetchedAt < CACHE_TTL_MS) {
      const response: JiraIssuesResponse = { issues: cached.issues };
      res.json(response);
      return;
    }

    let siteUrl: string;
    try {
      siteUrl = await getSiteUrl();
    } catch (err) {
      const errCode = (err as NodeJS.ErrnoException).code;
      if (errCode === 'ENOENT') {
        const response: JiraIssuesResponse = {
          issues: [],
          error: 'acli_not_in_path',
        };
        res.json(response);
        return;
      }
      const stderr = (err as { stderr?: string }).stderr ?? '';
      if (
        stderr.includes('not logged') ||
        stderr.includes('auth') ||
        stderr.includes('unauthorized')
      ) {
        const response: JiraIssuesResponse = {
          issues: [],
          error: 'acli_not_authenticated',
        };
        res.json(response);
        return;
      }
      const response: JiraIssuesResponse = {
        issues: [],
        error: 'jira_fetch_failed',
      };
      res.json(response);
      return;
    }

    let stdout: string;
    try {
      ({ stdout } = await exec(
        'acli',
        [
          'jira',
          'workitem',
          'search',
          '--jql',
          'assignee=currentUser() AND status NOT IN (Done, Closed) ORDER BY updated DESC',
          '--json',
          '--limit',
          '50',
        ],
        { timeout: JIRA_TIMEOUT_MS }
      ));
    } catch (err) {
      const errCode = (err as NodeJS.ErrnoException).code;
      if (errCode === 'ENOENT') {
        const response: JiraIssuesResponse = {
          issues: [],
          error: 'acli_not_in_path',
        };
        res.json(response);
        return;
      }
      const stderr = (err as { stderr?: string }).stderr ?? '';
      if (
        stderr.includes('not logged') ||
        stderr.includes('auth') ||
        stderr.includes('unauthorized')
      ) {
        const response: JiraIssuesResponse = {
          issues: [],
          error: 'acli_not_authenticated',
        };
        res.json(response);
        return;
      }
      const response: JiraIssuesResponse = {
        issues: [],
        error: 'jira_fetch_failed',
      };
      res.json(response);
      return;
    }

    let items: AcliWorkItem[];
    try {
      items = JSON.parse(stdout) as AcliWorkItem[];
    } catch {
      const response: JiraIssuesResponse = {
        issues: [],
        error: 'jira_fetch_failed',
      };
      res.json(response);
      return;
    }

    const issues: JiraIssue[] = items.map((item) => ({
      key: item.key,
      title: item.fields.summary,
      url: `https://${siteUrl}/browse/${item.key}`,
      status: item.fields.status.name,
      priority: item.fields.priority?.name ?? null,
      assignee: item.fields.assignee?.displayName ?? null,
      projectKey: item.key.split('-')[0] ?? item.key,
      updatedAt: '',
      sprint: null,
      storyPoints: null,
    }));

    // Update cache
    issuesCache.set(JIRA_ISSUES_CACHE_KEY, { issues, fetchedAt: now });

    const response: JiraIssuesResponse = { issues };
    res.json(response);
  });

  // GET /integrations/jira/statuses?projectKey=X — fetch unique statuses for a project
  router.get('/statuses', async (req: Request, res: Response) => {
    const projectKey = req.query['projectKey'];
    if (!projectKey || typeof projectKey !== 'string') {
      res.status(400).json({ statuses: [], error: 'missing_project_key' });
      return;
    }

    // Sanitize: only allow [A-Z0-9]+ to prevent command injection
    if (!/^[A-Z0-9]+$/.test(projectKey)) {
      res.status(400).json({ statuses: [], error: 'invalid_project_key' });
      return;
    }

    let stdout: string;
    try {
      ({ stdout } = await exec(
        'acli',
        [
          'jira',
          'workitem',
          'search',
          '--jql',
          `project = ${projectKey}`,
          '--fields',
          'status',
          '--json',
          '--limit',
          '50',
        ],
        { timeout: JIRA_TIMEOUT_MS }
      ));
    } catch (err) {
      const errCode = (err as NodeJS.ErrnoException).code;
      if (errCode === 'ENOENT') {
        res.json({ statuses: [], error: 'acli_not_in_path' });
        return;
      }
      const stderr = (err as { stderr?: string }).stderr ?? '';
      if (
        stderr.includes('not logged') ||
        stderr.includes('auth') ||
        stderr.includes('unauthorized')
      ) {
        res.json({ statuses: [], error: 'acli_not_authenticated' });
        return;
      }
      res.json({ statuses: [], error: 'jira_fetch_failed' });
      return;
    }

    let items: AcliWorkItem[];
    try {
      items = JSON.parse(stdout) as AcliWorkItem[];
    } catch {
      res.json({ statuses: [], error: 'jira_fetch_failed' });
      return;
    }

    // Deduplicate statuses by id
    const seen = new Set<string>();
    const statuses: JiraStatus[] = [];
    for (const item of items) {
      const { id, name } = item.fields.status;
      if (!seen.has(id)) {
        seen.add(id);
        statuses.push({ id, name });
      }
    }

    res.json({ statuses });
  });

  return router;
}
