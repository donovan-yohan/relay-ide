import type {
  SessionSummary,
  WorktreeInfo,
  Repo,
  DashboardData,
  CiStatus,
  PrInfo,
  PullRequest,
  ActivityEntry,
  WorkspaceSettings,
  OrgPrsResponse,
  GitHubIssuesResponse,
  BranchLinksResponse,
  JiraIssuesResponse,
  JiraStatus,
  AutomationSettings,
  FilterPreset,
  BranchInfo,
  Workspace,
  ChangedFilesResponse,
  FileDiffResponse,
  SessionTelemetry,
  AccountTelemetry,
  AnalyticsOverview,
  AnalyticsSessionsResponse,
  AnalyticsSessionDetail,
  AnalyticsTrend,
  AnalyticsToolBreakdown,
  AnalyticsRateLimitHistory,
  FrameworkInfo,
  BranchDivergenceSummary,
} from './types.js';
import { parseGlobalSessionId } from '../../../shared/identity.js';

export class ConflictError extends Error {
  sessionId: string;
  constructor(sessionId: string) {
    super('conflict');
    this.name = 'ConflictError';
    this.sessionId = sessionId;
  }
}

export class HttpError extends Error {
  status: number;
  code: string | undefined;
  constructor(
    status: number,
    message = httpErrorMessage(status),
    code?: string | undefined
  ) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
  }
}

function httpErrorMessage(status: number, fallback?: string): string {
  if (status === 502) {
    return 'Relay backend is unavailable (HTTP 502). The server may be restarting; try again in a moment.';
  }
  if (status === 503 || status === 504) {
    return `Relay backend is unavailable (HTTP ${status}). Try again in a moment.`;
  }
  return fallback ?? `HTTP ${status}`;
}

export interface BrowseEntry {
  name: string;
  path: string;
  isGitRepo: boolean;
  hasChildren: boolean;
  isDirectory?: boolean;
  size?: number;
}

export interface BrowseResponse {
  resolved: string;
  entries: BrowseEntry[];
  truncated: boolean;
  total: number;
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw await httpErrorFromResponse(res);
  return res.json() as Promise<T>;
}

async function jsonOrNull<T>(res: Response): Promise<T | null> {
  if (!res.ok) return null;
  return res.json() as Promise<T>;
}

async function jsonEither<T>(res: Response): Promise<T> {
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(
      `HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`
    );
  }
}

async function parseErrorBody(
  res: Response,
  fallback: string
): Promise<string> {
  return (await httpErrorFromResponse(res, fallback)).message;
}

async function httpErrorFromResponse(
  res: Response,
  fallback?: string
): Promise<HttpError> {
  try {
    const data = (await res.json()) as { error?: unknown; message?: unknown };
    const code = typeof data.error === 'string' ? data.error : undefined;
    const message =
      typeof data.message === 'string'
        ? data.message
        : typeof data.error === 'string'
          ? httpErrorMessage(res.status, data.error)
          : httpErrorMessage(res.status, fallback);
    return new HttpError(res.status, message, code);
  } catch {
    return new HttpError(res.status, httpErrorMessage(res.status, fallback));
  }
}

export async function authenticate(pin: string): Promise<void> {
  const res = await fetch('/auth', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pin }),
  });
  if (!res.ok) {
    const message = await parseErrorBody(res, 'Authentication failed');
    throw new Error(message);
  }
}

export async function checkAuth(): Promise<boolean> {
  const res = await fetch('/sessions');
  return res.ok;
}

export async function checkAuthStatus(): Promise<{
  hasPIN: boolean;
  noPin?: boolean;
}> {
  const data = await json<{ hasPIN?: boolean; noPin?: boolean }>(
    await fetch('/auth/status')
  );
  return { hasPIN: data.hasPIN === true, noPin: data.noPin === true };
}

export async function setupPin(pin: string, confirm: string): Promise<void> {
  const res = await fetch('/auth/setup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pin, confirm }),
  });
  if (!res.ok) {
    const message = await parseErrorBody(res, 'Failed to set PIN');
    throw new Error(message);
  }
}

export async function fetchSessions(): Promise<SessionSummary[]> {
  return json<SessionSummary[]>(await fetch('/sessions'));
}

function normalizeTelemetryMapEntry(
  mapKey: string,
  raw: Record<string, unknown>
): SessionTelemetry {
  const parsed = parseGlobalSessionId(mapKey);
  const rawSessionId =
    typeof raw.sessionId === 'string' ? raw.sessionId : undefined;
  return {
    ...(raw as Omit<SessionTelemetry, 'sessionId'>),
    sessionId: rawSessionId ?? parsed?.localSessionId ?? mapKey,
    ...(typeof raw.localSessionId === 'string'
      ? {}
      : parsed
        ? { localSessionId: parsed.localSessionId }
        : {}),
    ...(typeof raw.nodeId === 'string'
      ? {}
      : parsed
        ? { nodeId: parsed.nodeId }
        : {}),
    ...(typeof raw.globalSessionId === 'string'
      ? {}
      : parsed
        ? { globalSessionId: mapKey }
        : {}),
  };
}

function normalizeTelemetrySessions(data: unknown): SessionTelemetry[] {
  if (Array.isArray(data)) {
    return data.filter(
      (item): item is SessionTelemetry =>
        !!item && typeof item === 'object' && 'sessionId' in item
    ) as SessionTelemetry[];
  }
  if (data && typeof data === 'object') {
    const value = data as { sessions?: unknown; data?: unknown } & Record<
      string,
      unknown
    >;
    if (Array.isArray(value.sessions))
      return normalizeTelemetrySessions(value.sessions);
    if (value.sessions && typeof value.sessions === 'object') {
      return Object.entries(value.sessions as Record<string, unknown>).flatMap(
        ([sessionId, raw]) => {
          if (!raw || typeof raw !== 'object') return [];
          return [normalizeTelemetryMapEntry(sessionId, raw as Record<string, unknown>)];
        }
      );
    }
    if (Array.isArray(value.data))
      return normalizeTelemetrySessions(value.data);
    if (value.data && typeof value.data === 'object')
      return normalizeTelemetrySessions(value.data);
    return Object.entries(value).flatMap(([sessionId, raw]) => {
      if (!raw || typeof raw !== 'object') return [];
      return [normalizeTelemetryMapEntry(sessionId, raw as Record<string, unknown>)];
    });
  }
  return [];
}

function normalizeAccountTelemetry(data: unknown): AccountTelemetry | null {
  if (!data || typeof data !== 'object') return null;
  const value = data as { data?: unknown; account?: unknown };
  const raw = value.data ?? value.account ?? data;
  if (!raw || typeof raw !== 'object') return null;
  const candidate = raw as Partial<AccountTelemetry>;
  if (typeof candidate.updatedAt !== 'string') return null;
  return {
    framework:
      typeof candidate.framework === 'string' ? candidate.framework : 'unknown',
    rateLimits: Array.isArray(candidate.rateLimits) ? candidate.rateLimits : [],
    planType:
      typeof candidate.planType === 'string' ? candidate.planType : undefined,
    updatedAt: candidate.updatedAt,
  };
}

export async function fetchSessionTelemetry(): Promise<SessionTelemetry[]> {
  const res = await fetch('/telemetry/sessions');
  const data = await jsonOrNull<unknown>(res);
  return normalizeTelemetrySessions(data);
}

export async function fetchAccountTelemetry(): Promise<Record<
  string,
  AccountTelemetry
> | null> {
  const res = await fetch('/telemetry/account');
  const data = await jsonOrNull<unknown>(res);
  if (!data || typeof data !== 'object') return null;

  const result: Record<string, AccountTelemetry> = {};
  for (const [framework, telemetry] of Object.entries(
    data as Record<string, unknown>
  )) {
    if (
      telemetry &&
      typeof telemetry === 'object' &&
      'framework' in telemetry
    ) {
      const normalized = normalizeAccountTelemetry(
        telemetry as Partial<AccountTelemetry>
      );
      if (normalized) result[framework] = normalized;
    }
  }
  return Object.keys(result).length > 0 ? result : null;
}

export async function fetchTelemetrySetupStatus(): Promise<{
  installed: boolean;
}> {
  const res = await fetch('/telemetry/setup-status');
  const data = await jsonOrNull<unknown>(res);
  if (!data || typeof data !== 'object') return { installed: false };
  const value = data as { installed?: unknown };
  return { installed: value.installed === true };
}

export async function fetchWorktrees(): Promise<WorktreeInfo[]> {
  return json<WorktreeInfo[]>(await fetch('/git/worktrees'));
}

export async function fetchWorkspaces(): Promise<Repo[]> {
  const data = await json<{ workspaces: Repo[] }>(await fetch('/workspaces'));
  return data.workspaces;
}

export async function addWorkspace(path: string): Promise<void> {
  const res = await fetch('/workspaces', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path }),
  });
  if (!res.ok) {
    throw new Error(await parseErrorBody(res, 'Failed to add workspace'));
  }
}

export async function removeWorkspace(path: string): Promise<void> {
  const res = await fetch('/workspaces', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path }),
  });
  if (!res.ok) throw new Error('Failed to remove workspace');
}

export async function reorderWorkspaces(paths: string[]): Promise<Repo[]> {
  const data = await json<{ workspaces: Repo[] }>(
    await fetch('/workspaces/reorder', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths }),
    })
  );
  return data.workspaces;
}

export async function browseFsDirectory(
  dirPath?: string,
  options?: { prefix?: string; showHidden?: boolean; includeFiles?: boolean }
): Promise<BrowseResponse> {
  const params = new URLSearchParams();
  if (dirPath) params.set('path', dirPath);
  if (options?.prefix) params.set('prefix', options.prefix);
  if (options?.showHidden) params.set('showHidden', 'true');
  if (options?.includeFiles) params.set('includeFiles', 'true');
  return json<BrowseResponse>(
    await fetch('/workspaces/browse?' + params.toString())
  );
}

export interface BulkAddResult {
  added: Array<{
    path: string;
    name: string;
    isGitRepo: boolean;
    defaultBranch: string | null;
  }>;
  errors: Array<{ path: string; error: string }>;
}

export async function addWorkspacesBulk(
  paths: string[]
): Promise<BulkAddResult> {
  return json<BulkAddResult>(
    await fetch('/workspaces/bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths }),
    })
  );
}

export async function fetchDashboard(repoPath: string): Promise<DashboardData> {
  interface RawDashboard {
    pullRequests: { prs: PullRequest[]; error?: string };
    branches: string[];
    activity: ActivityEntry[];
  }
  const raw = await json<RawDashboard>(
    await fetch('/workspaces/dashboard?path=' + encodeURIComponent(repoPath))
  );
  return {
    prs: raw.pullRequests?.prs ?? [],
    activity: raw.activity ?? [],
    isGitRepo: true,
    defaultBranch: null,
    hasGhCli: !raw.pullRequests?.error,
  };
}

export async function fetchCiStatusOrNull(
  repoPath: string,
  branch: string
): Promise<CiStatus | null> {
  const res = await fetch(
    '/gh/ci-status?path=' +
      encodeURIComponent(repoPath) +
      '&branch=' +
      encodeURIComponent(branch)
  );
  return jsonOrNull<CiStatus>(res);
}

export async function fetchPrForBranchOrNull(
  repoPath: string,
  branch: string
): Promise<PrInfo | null> {
  const res = await fetch(
    '/gh/pr?path=' +
      encodeURIComponent(repoPath) +
      '&branch=' +
      encodeURIComponent(branch)
  );
  const data = await jsonOrNull<{ pr: PrInfo | null }>(res);
  return data?.pr ?? null;
}

export async function fetchCurrentBranch(
  repoPath: string
): Promise<string | null> {
  const data = await json<{ branch: string | null }>(
    await fetch(
      '/workspaces/current-branch?path=' + encodeURIComponent(repoPath)
    )
  );
  return data.branch;
}

export async function autocompletePath(prefix: string): Promise<string[]> {
  const data = await json<{ suggestions: string[] }>(
    await fetch('/workspaces/autocomplete?prefix=' + encodeURIComponent(prefix))
  );
  return data.suggestions;
}

export async function createWorktree(
  repoPath: string,
  branch?: string
): Promise<{
  branchName: string;
  mountainName: string;
  worktreePath: string | null;
}> {
  const res = await fetch(
    '/workspaces/worktree?path=' + encodeURIComponent(repoPath),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ branch }),
    }
  );
  if (!res.ok) {
    throw new Error(await parseErrorBody(res, 'Failed to create worktree'));
  }
  return jsonEither<{
    branchName: string;
    mountainName: string;
    worktreePath: string | null;
  }>(res);
}

export async function switchBranch(
  repoPath: string,
  branch: string
): Promise<{ success: boolean; error?: string }> {
  const res = await fetch(
    '/workspaces/branch?path=' + encodeURIComponent(repoPath),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ branch }),
    }
  );
  return jsonEither<{ success: boolean; error?: string }>(res);
}

export async function fetchBranches(
  repoPath: string,
  options: { refresh?: boolean } = {}
): Promise<BranchInfo[]> {
  const params = new URLSearchParams({ repo: repoPath });
  if (options.refresh) params.set('refresh', '1');
  return json<BranchInfo[]>(await fetch('/git/branches?' + params.toString()));
}

export interface EnrichBranchesResult {
  results: Record<string, { pr: PrInfo | null; stale: boolean }>;
}

/** Swallows HTTP errors and returns `{ results: {} }` on failure. */
export async function enrichBranches(
  branches: Array<{ repoPath: string; branchName: string }>
): Promise<EnrichBranchesResult> {
  const res = await fetch('/gh/enrich-branches', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ branches }),
  });
  if (!res.ok) return { results: {} };
  return jsonEither<EnrichBranchesResult>(res);
}

export async function createSession(body: {
  repoPath: string;
  worktreePath?: string | null | undefined;
  type?: 'agent' | 'terminal' | undefined;
  mode?: 'pty' | 'web' | undefined;
  continue?: boolean | undefined;
  branchName?: string | undefined;
  claudeArgs?: string[] | undefined;
  yolo?: boolean | undefined;
  agent?: string | undefined;
  useTmux?: boolean | undefined;
  cols?: number | undefined;
  rows?: number | undefined;
  needsBranchRename?: boolean | undefined;
  newWorktree?: boolean | undefined;
  branchRenamePrompt?: string | undefined;
  ticketContext?: {
    ticketId: string;
    title: string;
    description?: string;
    url: string;
    source: 'github' | 'jira';
    repoPath: string;
    repoName: string;
  };
}): Promise<SessionSummary> {
  const res = await fetch('/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.status === 409) {
    try {
      const data = await jsonEither<{ sessionId?: string }>(res);
      throw new ConflictError(data.sessionId ?? '');
    } catch (e) {
      if (e instanceof ConflictError) throw e;
      throw new ConflictError('');
    }
  }
  return json<SessionSummary>(res);
}

export async function killSession(id: string): Promise<void> {
  const res = await fetch('/sessions/' + id, { method: 'DELETE' });
  if (!res.ok) throw await httpErrorFromResponse(res, 'Failed to close session');
}

export async function renameSession(
  id: string,
  displayName: string
): Promise<void> {
  await fetch('/sessions/' + id, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ displayName }),
  });
}

export async function fetchWorktreeStatus(
  worktreePath: string
): Promise<{ activeSessions: string[]; hasUncommittedChanges: boolean }> {
  const res = await fetch(
    '/worktrees/status?path=' + encodeURIComponent(worktreePath)
  );
  if (!res.ok) {
    throw new Error(
      await parseErrorBody(res, 'Failed to fetch worktree status')
    );
  }
  return jsonEither<{
    activeSessions: string[];
    hasUncommittedChanges: boolean;
  }>(res);
}

export async function deleteWorktree(
  worktreePath: string,
  repoPath: string,
  force?: boolean
): Promise<void> {
  const res = await fetch('/worktrees', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ worktreePath, repoPath, force }),
  });
  if (!res.ok) {
    throw new Error(await parseErrorBody(res, 'Failed to delete worktree'));
  }
}

export async function uploadImage(
  sessionId: string,
  data: string,
  mimeType: string
): Promise<{ path: string; clipboardSet: boolean }> {
  return json<{ path: string; clipboardSet: boolean }>(
    await fetch('/sessions/' + sessionId + '/image', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data, mimeType }),
    })
  );
}

export async function checkVersion(): Promise<{
  current: string;
  latest: string | null;
  updateAvailable: boolean;
  channel: string;
}> {
  return json<{
    current: string;
    latest: string | null;
    updateAvailable: boolean;
    channel: string;
  }>(await fetch('/version'));
}

export async function triggerUpdate(): Promise<{
  ok: boolean;
  restarting?: boolean;
  error?: string;
}> {
  return json<{ ok: boolean; restarting?: boolean; error?: string }>(
    await fetch('/update', { method: 'POST' })
  );
}

export async function fetchUpdateChannel(): Promise<'stable' | 'nightly'> {
  const data = await json<{ channel: 'stable' | 'nightly' }>(
    await fetch('/update-channel')
  );
  return data.channel;
}

export async function setUpdateChannel(
  channel: 'stable' | 'nightly'
): Promise<void> {
  const res = await fetch('/update-channel', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel }),
  });
  if (!res.ok) throw new Error('Failed to update channel');
}

export async function fetchDefaultAgent(): Promise<string> {
  const data = await json<{ defaultAgent: string }>(
    await fetch('/config/defaultAgent')
  );
  return data.defaultAgent;
}

export async function setDefaultAgent(agent: string): Promise<void> {
  const res = await fetch('/config/defaultAgent', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ defaultAgent: agent }),
  });
  if (!res.ok) throw new Error('Failed to update default agent');
}

async function fetchConfigBool(key: string): Promise<boolean> {
  const data = await json<Record<string, boolean>>(
    await fetch(`/config/${key}`)
  );
  return data[key]!;
}

async function setConfigBool(key: string, value: boolean): Promise<void> {
  const res = await fetch(`/config/${key}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ [key]: value }),
  });
  if (!res.ok) {
    throw new Error(await parseErrorBody(res, `Failed to update ${key}`));
  }
}

export const fetchDefaultContinue = () => fetchConfigBool('defaultContinue');
export const setDefaultContinue = (v: boolean) =>
  setConfigBool('defaultContinue', v);
export const fetchDefaultYolo = () => fetchConfigBool('defaultYolo');
export const setDefaultYolo = (v: boolean) => setConfigBool('defaultYolo', v);
export const fetchDefaultNotifications = () =>
  fetchConfigBool('defaultNotifications');
export const setDefaultNotifications = (v: boolean) =>
  setConfigBool('defaultNotifications', v);
export const fetchClaudeFullscreen = () => fetchConfigBool('claudeFullscreen');
export const setClaudeFullscreen = (v: boolean) =>
  setConfigBool('claudeFullscreen', v);

export async function fetchVapidKey(): Promise<string | null> {
  try {
    const data = await json<{ vapidPublicKey: string }>(
      await fetch('/push/vapid-key')
    );
    return data.vapidPublicKey;
  } catch {
    return null;
  }
}

export async function pushSubscribe(
  subscription: PushSubscriptionJSON,
  sessionIds: string[]
): Promise<void> {
  const res = await fetch('/push/subscribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ subscription, sessionIds }),
  });
  if (!res.ok) throw new Error('Push subscribe failed');
}

export async function pushUnsubscribe(endpoint: string): Promise<void> {
  await fetch('/push/unsubscribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ endpoint }),
  });
}

export async function fetchWorkspaceSettings(
  repoPath: string
): Promise<WorkspaceSettings> {
  return json<WorkspaceSettings>(
    await fetch('/workspaces/settings?path=' + encodeURIComponent(repoPath))
  );
}

export interface MergedWorkspaceSettings {
  settings: WorkspaceSettings;
  overridden: string[];
}

export async function fetchMergedWorkspaceSettings(
  repoPath: string
): Promise<MergedWorkspaceSettings> {
  return json<MergedWorkspaceSettings>(
    await fetch(
      '/workspaces/settings/merged?path=' + encodeURIComponent(repoPath)
    )
  );
}

export async function updateWorkspaceSettings(
  repoPath: string,
  settings: WorkspaceSettings
): Promise<void> {
  const res = await fetch(
    '/workspaces/settings?path=' + encodeURIComponent(repoPath),
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settings),
    }
  );
  if (!res.ok) {
    throw new Error(
      await parseErrorBody(res, 'Failed to update workspace settings')
    );
  }
}

export async function fetchOrgPrs(): Promise<OrgPrsResponse> {
  const res = await fetch('/org-dashboard/prs');
  return json<OrgPrsResponse>(res);
}

export async function fetchGithubIssues(): Promise<GitHubIssuesResponse> {
  const res = await fetch('/integration-github/issues');
  return json<GitHubIssuesResponse>(res);
}

export async function fetchBranchLinks(): Promise<BranchLinksResponse> {
  const res = await fetch('/branch-linker/links');
  return json<BranchLinksResponse>(res);
}

export async function fetchJiraIssues(): Promise<JiraIssuesResponse> {
  const res = await fetch('/integration-jira/issues');
  return json<JiraIssuesResponse>(res);
}

export async function fetchJiraStatuses(
  projectKey: string
): Promise<JiraStatus[]> {
  const data = await json<{ statuses: JiraStatus[] }>(
    await fetch(
      '/integration-jira/statuses?projectKey=' + encodeURIComponent(projectKey)
    )
  );
  return data.statuses;
}

export async function fetchAnalyticsSize(): Promise<{ bytes: number }> {
  return json<{ bytes: number }>(await fetch('/analytics/size'));
}

export async function clearAnalytics(): Promise<void> {
  const res = await fetch('/analytics/events', { method: 'DELETE' });
  if (!res.ok) throw new Error('Failed to clear analytics');
}

export async function fetchAutomations(): Promise<AutomationSettings> {
  return json<AutomationSettings>(
    await fetch('/config/automations', { credentials: 'include' })
  );
}

export async function updateAutomations(
  settings: Partial<AutomationSettings>
): Promise<AutomationSettings> {
  const res = await fetch('/config/automations', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(settings),
  });
  return json<AutomationSettings>(res);
}

export async function fetchPresets(): Promise<FilterPreset[]> {
  const res = await fetch('/presets', { credentials: 'include' });
  return json<FilterPreset[]>(res);
}

export async function savePreset(preset: {
  name: string;
  filters: FilterPreset['filters'];
  sort: FilterPreset['sort'];
}): Promise<void> {
  const res = await fetch('/presets', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(preset),
  });
  if (!res.ok) throw new Error('Failed to save preset');
}

export async function deletePreset(name: string): Promise<void> {
  const res = await fetch(`/presets/${encodeURIComponent(name)}`, {
    method: 'DELETE',
    credentials: 'include',
  });
  if (!res.ok) throw new Error('Failed to delete preset');
}

export async function fetchGitHubStatus(): Promise<{
  connected: boolean;
  username: string | null;
  deviceFlowStatus?: 'polling' | 'denied' | 'expired';
}> {
  return json<{
    connected: boolean;
    username: string | null;
    deviceFlowStatus?: 'polling' | 'denied' | 'expired';
  }>(await fetch('/auth/github/status', { credentials: 'include' }));
}

export async function initiateGitHubDevice(): Promise<{
  userCode: string;
  verificationUri: string;
  expiresIn: number;
}> {
  return json<{ userCode: string; verificationUri: string; expiresIn: number }>(
    await fetch('/auth/github', { credentials: 'include' })
  );
}

export async function disconnectGitHub(): Promise<void> {
  const res = await fetch('/auth/github/disconnect', {
    method: 'POST',
    credentials: 'include',
  });
  if (!res.ok) throw new Error('Failed to disconnect GitHub');
}

// ── Webhook management ────────────────────────────────────────────────────────

export interface WebhookStatus {
  configured: boolean;
  smeeConnected: boolean;
  lastEventAt: string | null;
  autoProvision: boolean;
  secretPreview: string | null;
}

export interface BackfillResult {
  total: number;
  success: number;
  failed: number;
  results: Array<{
    path: string;
    ownerRepo: string | null;
    ok: boolean;
    error?: string;
  }>;
}

export async function fetchWebhookStatus(): Promise<WebhookStatus> {
  return json<WebhookStatus>(
    await fetch('/webhooks/manage/status', { credentials: 'include' })
  );
}

export async function setupWebhooks(): Promise<{
  ok: boolean;
  smeeUrl?: string;
  error?: string;
}> {
  return json<{ ok: boolean; smeeUrl?: string; error?: string }>(
    await fetch('/webhooks/manage/setup', {
      method: 'POST',
      credentials: 'include',
    })
  );
}

export async function removeWebhookSetup(): Promise<{ ok: boolean }> {
  return json<{ ok: boolean }>(
    await fetch('/webhooks/manage/setup', {
      method: 'DELETE',
      credentials: 'include',
    })
  );
}

export async function reloadWebhooks(): Promise<{ ok: boolean }> {
  return json<{ ok: boolean }>(
    await fetch('/webhooks/manage/reload', {
      method: 'POST',
      credentials: 'include',
    })
  );
}

export async function pingWebhook(): Promise<{ ok: boolean; error?: string }> {
  return json<{ ok: boolean; error?: string }>(
    await fetch('/webhooks/manage/ping', {
      method: 'POST',
      credentials: 'include',
    })
  );
}

export async function createRepoWebhook(
  repoPath: string
): Promise<{ ok: boolean; webhookId?: number; error?: string }> {
  return json<{ ok: boolean; webhookId?: number; error?: string }>(
    await fetch('/webhooks/manage/repos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ repoPath }),
    })
  );
}

export async function removeRepoWebhook(
  repoPath: string
): Promise<{ ok: boolean }> {
  return json<{ ok: boolean }>(
    await fetch('/webhooks/manage/repos/remove', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ repoPath }),
    })
  );
}

export async function backfillWebhooks(): Promise<BackfillResult> {
  return json<BackfillResult>(
    await fetch('/webhooks/manage/backfill', {
      method: 'POST',
      credentials: 'include',
    })
  );
}

export async function updateConfigAutoProvision(
  autoProvision: boolean
): Promise<void> {
  const res = await fetch('/config/autoProvision', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ autoProvision }),
  });
  if (!res.ok) throw new Error('Failed to update auto-provision setting');
}

// ── Workspace groups ──────────────────────────────────────────────────────────

export async function fetchWorkspaceGroups(): Promise<Workspace[]> {
  return json<Workspace[]>(await fetch('/workspace-groups'));
}

export async function createWorkspaceGroup(data: {
  name: string;
  repos: string[];
  themeColor?: string;
}): Promise<Workspace> {
  const res = await fetch('/workspace-groups', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!res.ok)
    throw new Error(await parseErrorBody(res, 'Failed to create workspace'));
  return jsonEither<Workspace>(res);
}

export async function updateWorkspaceGroup(
  id: string,
  data: Partial<Workspace>
): Promise<Workspace> {
  const res = await fetch(`/workspace-groups/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!res.ok)
    throw new Error(await parseErrorBody(res, 'Failed to update workspace'));
  return jsonEither<Workspace>(res);
}

export async function deleteWorkspaceGroup(id: string): Promise<void> {
  const res = await fetch(`/workspace-groups/${id}`, { method: 'DELETE' });
  if (!res.ok)
    throw new Error(await parseErrorBody(res, 'Failed to delete workspace'));
}

export async function launchWorkspaceSession(
  workspaceId: string,
  opts?: {
    agent?: string;
    yolo?: boolean;
    useTmux?: boolean;
    claudeArgs?: string[];
    cols?: number;
    rows?: number;
  }
): Promise<
  SessionSummary & { warnings?: Array<{ repoPath: string; error: string }> }
> {
  const res = await fetch(`/workspace-groups/${workspaceId}/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(opts ?? {}),
  });
  if (!res.ok)
    throw new Error(
      await parseErrorBody(res, 'Failed to launch workspace session')
    );
  return jsonEither<
    SessionSummary & { warnings?: Array<{ repoPath: string; error: string }> }
  >(res);
}

export interface FilesListResponse {
  files: string[];
  truncated: boolean;
  total: number;
  error?: string;
}

/** Swallows HTTP errors and returns empty list with an `error` field. */
export async function fetchFilesList(
  repoPath: string
): Promise<FilesListResponse> {
  const params = new URLSearchParams({ path: repoPath });
  const res = await fetch('/workspaces/files-list?' + params.toString());
  if (!res.ok) {
    return {
      files: [],
      truncated: false,
      total: 0,
      error: `HTTP ${res.status}`,
    };
  }
  return jsonEither<FilesListResponse>(res);
}

/** Swallows HTTP errors and returns an empty ChangedFilesResponse with an `error` field. */
export async function fetchChangedFiles(
  repoPath: string,
  base?: string
): Promise<ChangedFilesResponse> {
  const params = new URLSearchParams({ path: repoPath });
  if (base) params.set('base', base);
  const res = await fetch('/workspaces/changed-files?' + params.toString());
  if (!res.ok) {
    return {
      files: [],
      aggregate: { additions: 0, deletions: 0, fileCount: 0 },
      error: `HTTP ${res.status}`,
    };
  }
  return jsonEither<ChangedFilesResponse>(res);
}

function isBranchDivergenceSummary(
  value: unknown
): value is BranchDivergenceSummary {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<BranchDivergenceSummary>;
  return (
    typeof candidate.repoPath === 'string' &&
    typeof candidate.aheadCount === 'number' &&
    typeof candidate.behindCount === 'number' &&
    Boolean(candidate.lineDelta) &&
    Boolean(candidate.dirty) &&
    Boolean(candidate.commits) &&
    typeof candidate.state === 'string' &&
    Array.isArray(candidate.baseCandidates) &&
    Array.isArray(candidate.warnings) &&
    typeof candidate.generatedAt === 'string'
  );
}

function emptyDivergenceSummary(
  repoPath: string,
  error: string
): BranchDivergenceSummary {
  return {
    repoPath,
    currentBranch: null,
    headSha: null,
    selectedBase: null,
    baseCandidates: [],
    aheadCount: 0,
    behindCount: 0,
    lineDelta: { additions: 0, deletions: 0, fileCount: 0 },
    dirty: {
      stagedCount: 0,
      unstagedCount: 0,
      untrackedCount: 0,
      conflictedCount: 0,
      files: [],
      truncated: false,
    },
    commits: { ahead: [], behind: [] },
    state: 'missing_base',
    error,
    warnings: [],
    generatedAt: new Date().toISOString(),
  };
}

export async function fetchDivergence(
  repoPath: string,
  base?: string
): Promise<BranchDivergenceSummary> {
  const params = new URLSearchParams({ path: repoPath });
  if (base) params.set('base', base);
  const res = await fetch('/workspaces/divergence?' + params.toString());
  if (!res.ok) {
    try {
      const parsed = await jsonEither<unknown>(res);
      if (isBranchDivergenceSummary(parsed)) return parsed;
    } catch {
      // Fall through to the generic transport fallback below.
    }
    return emptyDivergenceSummary(repoPath, `HTTP ${res.status}`);
  }
  return jsonEither<BranchDivergenceSummary>(res);
}

/** Swallows HTTP errors and returns `{ diff: '', error }` on failure. */
export async function fetchFileDiff(
  repoPath: string,
  filePath: string,
  base?: string
): Promise<FileDiffResponse> {
  const params = new URLSearchParams({ path: repoPath, file: filePath });
  if (base) params.set('base', base);
  const res = await fetch('/workspaces/file-diff?' + params.toString());
  if (!res.ok) {
    return { diff: '', error: `HTTP ${res.status}` };
  }
  return jsonEither<FileDiffResponse>(res);
}

/** Swallows HTTP errors and returns `{ content: '', error }` on failure. */
export async function fetchFileContent(
  repoPath: string,
  filePath: string
): Promise<import('./types.js').FileContentResponse> {
  const params = new URLSearchParams({ path: repoPath, file: filePath });
  const res = await fetch('/workspaces/file-content?' + params.toString());
  if (!res.ok) {
    return { content: '', error: `HTTP ${res.status}` };
  }
  return jsonEither<import('./types.js').FileContentResponse>(res);
}

/** Swallows HTTP errors and returns `'main'` on failure or when the branch is empty. */
export async function fetchDefaultBranch(repoPath: string): Promise<string> {
  const params = new URLSearchParams({ path: repoPath });
  try {
    const data = await jsonOrNull<{ branch: string }>(
      await fetch('/workspaces/default-branch?' + params.toString())
    );
    return data?.branch || 'main';
  } catch {
    return 'main';
  }
}

// ── Session Analytics API ──

export async function fetchAnalyticsOverview(
  days = 7,
  repo?: string
): Promise<AnalyticsOverview> {
  const params = new URLSearchParams({ days: String(days) });
  if (repo) params.set('repo', repo);
  return json<AnalyticsOverview>(
    await fetch(`/api/analytics/overview?${params}`)
  );
}

export async function fetchAnalyticsSessions(opts?: {
  offset?: number;
  limit?: number;
  repo?: string;
  agent?: string;
  sort?: string;
}): Promise<AnalyticsSessionsResponse> {
  const params = new URLSearchParams();
  if (opts?.offset) params.set('offset', String(opts.offset));
  if (opts?.limit) params.set('limit', String(opts.limit));
  if (opts?.repo) params.set('repo', opts.repo);
  if (opts?.agent) params.set('agent', opts.agent);
  if (opts?.sort) params.set('sort', opts.sort);
  return json<AnalyticsSessionsResponse>(
    await fetch(`/api/analytics/sessions?${params}`)
  );
}

export async function fetchAnalyticsSessionDetail(
  id: string
): Promise<AnalyticsSessionDetail> {
  return json<AnalyticsSessionDetail>(
    await fetch(`/api/analytics/sessions/${encodeURIComponent(id)}`)
  );
}

export async function fetchAnalyticsTrends(
  days = 30,
  repo?: string
): Promise<{ days: AnalyticsTrend[] }> {
  const params = new URLSearchParams({ days: String(days) });
  if (repo) params.set('repo', repo);
  return json<{ days: AnalyticsTrend[] }>(
    await fetch(`/api/analytics/trends?${params}`)
  );
}

export async function fetchAnalyticsTools(
  days = 7,
  repo?: string,
  session?: string
): Promise<AnalyticsToolBreakdown> {
  const params = new URLSearchParams({ days: String(days) });
  if (repo) params.set('repo', repo);
  if (session) params.set('session', session);
  return json<AnalyticsToolBreakdown>(
    await fetch(`/api/analytics/tools?${params}`)
  );
}

export async function fetchAnalyticsRateLimits(
  hours = 24
): Promise<AnalyticsRateLimitHistory> {
  return json<AnalyticsRateLimitHistory>(
    await fetch(`/api/analytics/rate-limits?hours=${hours}`)
  );
}

export async function fetchFrameworks(): Promise<FrameworkInfo[]> {
  const data = await json<{ frameworks: FrameworkInfo[] }>(
    await fetch('/api/frameworks')
  );
  return data.frameworks;
}

// ── Workspace branch operations ───────────────────────────────────────────────

export async function renameBranch(
  path: string,
  newName: string
): Promise<{
  success?: boolean;
  oldName?: string;
  newName?: string;
  error?: string;
}> {
  const res = await fetch(
    '/workspaces/rename-branch?path=' + encodeURIComponent(path),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ newName }),
    }
  );
  return jsonEither<{
    success?: boolean;
    oldName?: string;
    newName?: string;
    error?: string;
  }>(res);
}

export async function pushBranch(
  path: string,
  branch: string,
  deleteOldBranch: string
): Promise<{ success?: boolean; error?: string }> {
  const res = await fetch(
    '/workspaces/push-branch?path=' + encodeURIComponent(path),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ branch, deleteOldBranch }),
    }
  );
  return jsonEither<{ success?: boolean; error?: string }>(res);
}

export async function setPrBase(
  path: string,
  prNumber: number,
  baseBranch: string
): Promise<{ success?: boolean; error?: string }> {
  const res = await fetch(
    '/workspaces/pr-base?path=' + encodeURIComponent(path),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prNumber, baseBranch }),
    }
  );
  return jsonEither<{ success?: boolean; error?: string }>(res);
}

export async function fetchWorkspaceBranches(
  path: string
): Promise<BranchInfo[]> {
  return json<BranchInfo[]>(
    await fetch('/branches?path=' + encodeURIComponent(path))
  );
}
