import { test, afterAll, expect } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';

import {
  createIntegrationJiraRouter,
  type IntegrationJiraDeps,
} from '../server/integration-jira.js';
import type {
  JiraIssue,
  JiraIssuesResponse,
  JiraStatus,
} from '../server/types.js';

// ─── Types ────────────────────────────────────────────────────────────────────

interface StatusesResponse {
  statuses: JiraStatus[];
  error?: string;
}

// Loose mock type — cast to IntegrationJiraDeps['execAsync'] at call sites
type MockExec = (
  ...args: unknown[]
) => Promise<{ stdout: string; stderr: string }>;

// ─── Mock stdout constants ────────────────────────────────────────────────────

const AUTH_STATUS_STDOUT = `✓ Authenticated
  Site: fake-jira.atlassian.net
  Email: test@example.com
  Authentication Type: oauth
`;

// ─── Globals ──────────────────────────────────────────────────────────────────

let server: Server;
let baseUrl: string;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Builds a minimal AcliWorkItem for use in mock stdout payloads.
 */
function makeAcliWorkItem(overrides: {
  key?: string;
  summary?: string;
  statusId?: string;
  statusName?: string;
  priorityName?: string | null;
  assigneeDisplayName?: string | null;
}): object {
  const {
    key = 'TEST-1',
    summary = 'Test issue',
    statusId = '3',
    statusName = 'In Progress',
    priorityName = 'Medium',
    assigneeDisplayName = 'Jane Doe',
  } = overrides;

  return {
    key,
    fields: {
      summary,
      status: { id: statusId, name: statusName },
      ...(priorityName !== null
        ? { priority: { name: priorityName } }
        : { priority: null }),
      ...(assigneeDisplayName !== null
        ? { assignee: { displayName: assigneeDisplayName } }
        : { assignee: null }),
    },
  };
}

/**
 * Creates a mock execAsync that routes calls based on the acli subcommand args:
 * - `acli jira auth status` → returns AUTH_STATUS_STDOUT (or throws)
 * - `acli jira workitem search` → returns the provided items as JSON stdout (or throws)
 */
function makeMockExec(opts: {
  authError?: Error;
  searchItems?: object[];
  searchError?: Error;
}): MockExec {
  return async (_cmd: unknown, args: unknown) => {
    const argv = args as string[];

    if (argv.includes('auth') && argv.includes('status')) {
      if (opts.authError) throw opts.authError;
      return { stdout: AUTH_STATUS_STDOUT, stderr: '' };
    }

    if (argv.includes('workitem') && argv.includes('search')) {
      if (opts.searchError) throw opts.searchError;
      return { stdout: JSON.stringify(opts.searchItems ?? []), stderr: '' };
    }

    throw new Error(`Unexpected exec call: acli ${argv.join(' ')}`);
  };
}

// ─── Server lifecycle ─────────────────────────────────────────────────────────

function startServer(execAsyncFn: MockExec): Promise<void> {
  return new Promise((resolve) => {
    const app = express();
    app.use(express.json());
    const deps = {
      configPath: '',
      execAsync: execAsyncFn,
    } as unknown as IntegrationJiraDeps;
    app.use('/integration-jira', createIntegrationJiraRouter(deps));
    server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (typeof addr === 'object' && addr) {
        baseUrl = `http://127.0.0.1:${addr.port}`;
      }
      resolve();
    });
  });
}

function stopServer(): Promise<void> {
  return new Promise((resolve) => {
    if (server) server.close(() => resolve());
    else resolve();
  });
}

// ─── Suite teardown ───────────────────────────────────────────────────────────

afterAll(async () => {
  await stopServer();
});

// ─── Tests ────────────────────────────────────────────────────────────────────

test('GET /issues returns mapped JiraIssue[] from mocked acli JSON output', async () => {
  await stopServer();

  const searchItems = [
    makeAcliWorkItem({
      key: 'PROJ-42',
      summary: 'Fix the login bug',
      statusId: '3',
      statusName: 'In Progress',
      priorityName: 'High',
      assigneeDisplayName: 'Alice',
    }),
    makeAcliWorkItem({
      key: 'PROJ-10',
      summary: 'Update docs',
      statusId: '1',
      statusName: 'To Do',
      priorityName: null,
      assigneeDisplayName: null,
    }),
  ];

  const exec = makeMockExec({ searchItems });
  await startServer(exec);

  const res = await fetch(`${baseUrl}/integration-jira/issues`);
  expect(res.status).toBe(200);
  const data = (await res.json()) as JiraIssuesResponse;

  expect(data.error).toBe(undefined);
  expect(data.issues.length).toBe(2);

  const issue42 = data.issues.find((i: JiraIssue) => i.key === 'PROJ-42');
  expect(issue42).toBeTruthy();
  expect(issue42.title).toBe('Fix the login bug');
  expect(issue42.status).toBe('In Progress');
  expect(issue42.priority).toBe('High');
  expect(issue42.assignee).toBe('Alice');
  expect(issue42.url).toBe('https://fake-jira.atlassian.net/browse/PROJ-42');
  expect(issue42.projectKey).toBe('PROJ');
  expect(issue42.updatedAt).toBe('');
  expect(issue42.sprint).toBe(null);
  expect(issue42.storyPoints).toBe(null);

  const issue10 = data.issues.find((i: JiraIssue) => i.key === 'PROJ-10');
  expect(issue10).toBeTruthy();
  expect(issue10.priority).toBe(null);
  expect(issue10.assignee).toBe(null);
  expect(issue10.url).toBe('https://fake-jira.atlassian.net/browse/PROJ-10');
  expect(issue10.projectKey).toBe('PROJ');
});

test('GET /issues returns acli_not_in_path when exec throws ENOENT', async () => {
  await stopServer();

  const err = new Error('spawn acli ENOENT') as NodeJS.ErrnoException;
  err.code = 'ENOENT';

  const exec = makeMockExec({ authError: err });
  await startServer(exec);

  const res = await fetch(`${baseUrl}/integration-jira/issues`);
  expect(res.status).toBe(200);
  const data = (await res.json()) as JiraIssuesResponse;

  expect(data.error).toBe('acli_not_in_path');
  expect(data.issues.length).toBe(0);
});

test('GET /issues returns acli_not_authenticated when exec stderr contains auth message', async () => {
  await stopServer();

  const err = Object.assign(new Error('acli auth error'), {
    stderr: "not logged in, use 'acli jira auth login' to authenticate",
  });

  const exec = makeMockExec({ authError: err });
  await startServer(exec);

  const res = await fetch(`${baseUrl}/integration-jira/issues`);
  expect(res.status).toBe(200);
  const data = (await res.json()) as JiraIssuesResponse;

  expect(data.error).toBe('acli_not_authenticated');
  expect(data.issues.length).toBe(0);
});

test('GET /issues caches results within TTL — exec called only once for two requests', async () => {
  await stopServer();

  let searchCallCount = 0;

  const baseExec = makeMockExec({
    searchItems: [
      makeAcliWorkItem({ key: 'CACHE-1', summary: 'Cached issue' }),
    ],
  });

  const countingExec: MockExec = async (...args: unknown[]) => {
    const argv = args[1] as string[];
    if (argv.includes('workitem') && argv.includes('search')) {
      searchCallCount++;
    }
    return baseExec(...args);
  };

  await startServer(countingExec);

  // First request — populates cache
  const firstRes = await fetch(`${baseUrl}/integration-jira/issues`);
  const first = (await firstRes.json()) as JiraIssuesResponse;
  expect(first.error).toBe(undefined);
  expect(first.issues.length).toBe(1);
  expect(searchCallCount).toBe(1);

  // Second request — should be served from cache, no additional exec call
  const secondRes = await fetch(`${baseUrl}/integration-jira/issues`);
  const second = (await secondRes.json()) as JiraIssuesResponse;
  expect(second.error).toBe(undefined);
  expect(second.issues.length).toBe(1);
  expect(searchCallCount).toBe(1);
});

test('GET /statuses?projectKey=TEST returns deduplicated statuses', async () => {
  await stopServer();

  // Items with overlapping status IDs — deduplication should collapse to 3 unique statuses
  const searchItems = [
    makeAcliWorkItem({ key: 'TEST-1', statusId: '1', statusName: 'To Do' }),
    makeAcliWorkItem({
      key: 'TEST-2',
      statusId: '2',
      statusName: 'In Progress',
    }),
    makeAcliWorkItem({
      key: 'TEST-3',
      statusId: '2',
      statusName: 'In Progress',
    }), // duplicate
    makeAcliWorkItem({ key: 'TEST-4', statusId: '3', statusName: 'Done' }),
  ];

  const exec = makeMockExec({ searchItems });
  await startServer(exec);

  const res = await fetch(
    `${baseUrl}/integration-jira/statuses?projectKey=TEST`
  );
  expect(res.status).toBe(200);
  const data = (await res.json()) as StatusesResponse;

  expect(data.error).toBe(undefined);
  expect(data.statuses.length).toBe(3);

  const ids = data.statuses.map((s: JiraStatus) => s.id);
  expect(ids).toEqual(['1', '2', '3']);

  const names = data.statuses.map((s: JiraStatus) => s.name);
  expect(names).toEqual(['To Do', 'In Progress', 'Done']);
});

test('GET /statuses returns 400 when projectKey query param is missing', async () => {
  await stopServer();

  const exec = makeMockExec({ searchItems: [] });
  await startServer(exec);

  const res = await fetch(`${baseUrl}/integration-jira/statuses`);
  expect(res.status).toBe(400);
  const data = (await res.json()) as StatusesResponse;

  expect(data.error).toBe('missing_project_key');
});

test('GET /statuses returns 400 for invalid projectKey (lowercase or special chars)', async () => {
  await stopServer();

  const exec = makeMockExec({ searchItems: [] });
  await startServer(exec);

  // Lowercase key
  const resLower = await fetch(
    `${baseUrl}/integration-jira/statuses?projectKey=test`
  );
  expect(resLower.status).toBe(400);
  const dataLower = (await resLower.json()) as StatusesResponse;
  expect(dataLower.error).toBe('invalid_project_key');

  // Key with special characters
  const resSpecial = await fetch(
    `${baseUrl}/integration-jira/statuses?projectKey=TEST%20PROJ`
  );
  expect(resSpecial.status).toBe(400);
  const dataSpecial = (await resSpecial.json()) as StatusesResponse;
  expect(dataSpecial.error).toBe('invalid_project_key');
});
