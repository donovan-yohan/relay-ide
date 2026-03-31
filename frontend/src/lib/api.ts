import type { SessionSummary, WorktreeInfo, Repo, DashboardData, CiStatus, PrInfo, PullRequest, ActivityEntry, WorkspaceSettings, OrgPrsResponse, GitHubIssuesResponse, BranchLinksResponse, JiraIssuesResponse, JiraStatus, AutomationSettings, FilterPreset, BranchInfo, Workspace, ChangedFilesResponse, FileDiffResponse } from './types.js';

export class ConflictError extends Error {
  sessionId: string;
  constructor(sessionId: string) {
    super('conflict');
    this.name = 'ConflictError';
    this.sessionId = sessionId;
  }
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
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

async function parseErrorBody(res: Response, fallback: string): Promise<string> {
  try {
    const data = await res.json() as { error?: string };
    return data.error || fallback;
  } catch {
    return fallback;
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

export async function checkAuthStatus(): Promise<{ hasPIN: boolean }> {
  const res = await fetch('/auth/status');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json() as { hasPIN?: boolean };
  return { hasPIN: data.hasPIN === true };
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

export async function fetchWorktrees(): Promise<WorktreeInfo[]> {
  return json<WorktreeInfo[]>(await fetch('/worktrees'));
}

export async function fetchWorkspaces(): Promise<Repo[]> {
  const data = await json<{ workspaces: Repo[] }>(await fetch('/workspaces'));
  return data.workspaces;
}

export async function addWorkspace(path: string): Promise<void> {
  const res = await fetch('/workspaces', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path }) });
  if (!res.ok) { throw new Error(await parseErrorBody(res, 'Failed to add workspace')); }
}

export async function removeWorkspace(path: string): Promise<void> {
  const res = await fetch('/workspaces', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path }) });
  if (!res.ok) throw new Error('Failed to remove workspace');
}

export async function reorderWorkspaces(paths: string[]): Promise<Repo[]> {
  const data = await json<{ workspaces: Repo[] }>(
    await fetch('/workspaces/reorder', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths }),
    }),
  );
  return data.workspaces;
}

export async function browseFsDirectory(
  dirPath?: string,
  options?: { prefix?: string; showHidden?: boolean; includeFiles?: boolean },
): Promise<BrowseResponse> {
  const params = new URLSearchParams();
  if (dirPath) params.set('path', dirPath);
  if (options?.prefix) params.set('prefix', options.prefix);
  if (options?.showHidden) params.set('showHidden', 'true');
  if (options?.includeFiles) params.set('includeFiles', 'true');
  return json<BrowseResponse>(await fetch('/workspaces/browse?' + params.toString()));
}

export interface BulkAddResult {
  added: Array<{ path: string; name: string; isGitRepo: boolean; defaultBranch: string | null }>;
  errors: Array<{ path: string; error: string }>;
}

export async function addWorkspacesBulk(paths: string[]): Promise<BulkAddResult> {
  return json<BulkAddResult>(
    await fetch('/workspaces/bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths }),
    }),
  );
}

export async function fetchDashboard(repoPath: string): Promise<DashboardData> {
  interface RawDashboard {
    pullRequests: { prs: PullRequest[]; error?: string };
    branches: string[];
    activity: ActivityEntry[];
  }
  const raw = await json<RawDashboard>(await fetch('/workspaces/dashboard?path=' + encodeURIComponent(repoPath)));
  return {
    prs: raw.pullRequests?.prs ?? [],
    activity: raw.activity ?? [],
    isGitRepo: true,
    defaultBranch: null,
    hasGhCli: !raw.pullRequests?.error,
  };
}

export async function fetchCiStatusOrNull(repoPath: string, branch: string): Promise<CiStatus | null> {
  const res = await fetch('/workspaces/ci-status?path=' + encodeURIComponent(repoPath) + '&branch=' + encodeURIComponent(branch));
  if (!res.ok) return null;
  return res.json() as Promise<CiStatus>;
}

export async function fetchPrForBranchOrNull(repoPath: string, branch: string): Promise<PrInfo | null> {
  const res = await fetch('/workspaces/pr?path=' + encodeURIComponent(repoPath) + '&branch=' + encodeURIComponent(branch));
  if (!res.ok) return null;
  const data = await res.json() as { pr: PrInfo | null };
  return data.pr;
}

export async function fetchCurrentBranch(repoPath: string): Promise<string | null> {
  const data = await json<{ branch: string | null }>(await fetch('/workspaces/current-branch?path=' + encodeURIComponent(repoPath)));
  return data.branch;
}

export async function autocompletePath(prefix: string): Promise<string[]> {
  const data = await json<{ suggestions: string[] }>(await fetch('/workspaces/autocomplete?prefix=' + encodeURIComponent(prefix)));
  return data.suggestions;
}

export async function createWorktree(repoPath: string, branch?: string): Promise<{ branchName: string; mountainName: string; worktreePath: string }> {
  const res = await fetch('/workspaces/worktree?path=' + encodeURIComponent(repoPath), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ branch }),
  });
  if (!res.ok) {
    throw new Error(await parseErrorBody(res, 'Failed to create worktree'));
  }
  return res.json() as Promise<{ branchName: string; mountainName: string; worktreePath: string }>;
}

export async function switchBranch(repoPath: string, branch: string): Promise<{ success: boolean; error?: string }> {
  const res = await fetch('/workspaces/branch?path=' + encodeURIComponent(repoPath), {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ branch })
  });
  return res.json() as Promise<{ success: boolean; error?: string }>;
}

export async function fetchBranches(repoPath: string, options: { refresh?: boolean } = {}): Promise<BranchInfo[]> {
  const params = new URLSearchParams({ repo: repoPath });
  if (options.refresh) params.set('refresh', '1');
  return json<BranchInfo[]>(await fetch('/branches?' + params.toString()));
}

export async function createSession(body: {
  repoPath: string;
  worktreePath?: string | null | undefined;
  type?: 'agent' | 'terminal' | undefined;
  continue?: boolean | undefined;
  branchName?: string | undefined;
  claudeArgs?: string[] | undefined;
  yolo?: boolean | undefined;
  agent?: string | undefined;
  useTmux?: boolean | undefined;
  cols?: number | undefined;
  rows?: number | undefined;
  needsBranchRename?: boolean | undefined;
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
      const data = await res.json() as { sessionId?: string };
      throw new ConflictError(data.sessionId ?? '');
    } catch (e) {
      if (e instanceof ConflictError) throw e;
      throw new ConflictError('');
    }
  }
  return json<SessionSummary>(res);
}

export async function killSession(id: string): Promise<void> {
  await fetch('/sessions/' + id, { method: 'DELETE' });
}

export async function renameSession(id: string, displayName: string): Promise<void> {
  await fetch('/sessions/' + id, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ displayName }),
  });
}

export async function deleteWorktree(worktreePath: string, repoPath: string): Promise<void> {
  const res = await fetch('/worktrees', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ worktreePath, repoPath }),
  });
  if (!res.ok) {
    throw new Error(await parseErrorBody(res, 'Failed to delete worktree'));
  }
}

export async function uploadImage(
  sessionId: string,
  data: string,
  mimeType: string,
): Promise<{ path: string; clipboardSet: boolean }> {
  return json<{ path: string; clipboardSet: boolean }>(
    await fetch('/sessions/' + sessionId + '/image', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data, mimeType }),
    }),
  );
}

export async function checkVersion(): Promise<{ current: string; latest: string | null; updateAvailable: boolean }> {
  return json<{ current: string; latest: string | null; updateAvailable: boolean }>(await fetch('/version'));
}

export async function triggerUpdate(): Promise<{ ok: boolean; restarting?: boolean; error?: string }> {
  return json<{ ok: boolean; restarting?: boolean; error?: string }>(await fetch('/update', { method: 'POST' }));
}

export async function fetchDefaultAgent(): Promise<string> {
  const data = await json<{ defaultAgent: string }>(await fetch('/config/defaultAgent'));
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
  const data = await json<Record<string, boolean>>(await fetch(`/config/${key}`));
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
export const setDefaultContinue = (v: boolean) => setConfigBool('defaultContinue', v);
export const fetchDefaultYolo = () => fetchConfigBool('defaultYolo');
export const setDefaultYolo = (v: boolean) => setConfigBool('defaultYolo', v);
export const fetchLaunchInTmux = () => fetchConfigBool('launchInTmux');
export const setLaunchInTmux = (v: boolean) => setConfigBool('launchInTmux', v);
export const fetchDefaultNotifications = () => fetchConfigBool('defaultNotifications');
export const setDefaultNotifications = (v: boolean) => setConfigBool('defaultNotifications', v);

export async function fetchVapidKey(): Promise<string | null> {
  try {
    const data = await json<{ vapidPublicKey: string }>(await fetch('/push/vapid-key'));
    return data.vapidPublicKey;
  } catch { return null; }
}

export async function pushSubscribe(subscription: PushSubscriptionJSON, sessionIds: string[]): Promise<void> {
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

export async function fetchWorkspaceSettings(repoPath: string): Promise<WorkspaceSettings> {
  return json<WorkspaceSettings>(await fetch('/workspaces/settings?path=' + encodeURIComponent(repoPath)));
}

export interface MergedWorkspaceSettings {
  settings: WorkspaceSettings;
  overridden: string[];
}

export async function fetchMergedWorkspaceSettings(repoPath: string): Promise<MergedWorkspaceSettings> {
  return json<MergedWorkspaceSettings>(
    await fetch('/workspaces/settings/merged?path=' + encodeURIComponent(repoPath))
  );
}

export async function updateWorkspaceSettings(repoPath: string, settings: WorkspaceSettings): Promise<void> {
  const res = await fetch('/workspaces/settings?path=' + encodeURIComponent(repoPath), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(settings),
  });
  if (!res.ok) {
    throw new Error(await parseErrorBody(res, 'Failed to update workspace settings'));
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

export async function fetchJiraStatuses(projectKey: string): Promise<JiraStatus[]> {
  const data = await json<{ statuses: JiraStatus[] }>(await fetch('/integration-jira/statuses?projectKey=' + encodeURIComponent(projectKey)));
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
  return json<AutomationSettings>(await fetch('/config/automations', { credentials: 'include' }));
}

export async function updateAutomations(settings: Partial<AutomationSettings>): Promise<AutomationSettings> {
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

export async function savePreset(preset: { name: string; filters: FilterPreset['filters']; sort: FilterPreset['sort'] }): Promise<void> {
  const res = await fetch('/presets', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(preset),
  });
  if (!res.ok) throw new Error('Failed to save preset');
}

export async function deletePreset(name: string): Promise<void> {
  const res = await fetch(`/presets/${encodeURIComponent(name)}`, { method: 'DELETE', credentials: 'include' });
  if (!res.ok) throw new Error('Failed to delete preset');
}

export async function fetchGitHubStatus(): Promise<{ connected: boolean; username: string | null; deviceFlowStatus?: 'polling' | 'denied' | 'expired' }> {
  return json<{ connected: boolean; username: string | null; deviceFlowStatus?: 'polling' | 'denied' | 'expired' }>(await fetch('/auth/github/status', { credentials: 'include' }));
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
  const res = await fetch('/auth/github/disconnect', { method: 'POST', credentials: 'include' });
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
  results: Array<{ path: string; ownerRepo: string | null; ok: boolean; error?: string }>;
}

export async function fetchWebhookStatus(): Promise<WebhookStatus> {
  return json<WebhookStatus>(await fetch('/webhooks/manage/status', { credentials: 'include' }));
}

export async function setupWebhooks(): Promise<{ ok: boolean; smeeUrl?: string; error?: string }> {
  return json<{ ok: boolean; smeeUrl?: string; error?: string }>(
    await fetch('/webhooks/manage/setup', { method: 'POST', credentials: 'include' }),
  );
}

export async function removeWebhookSetup(): Promise<{ ok: boolean }> {
  return json<{ ok: boolean }>(
    await fetch('/webhooks/manage/setup', { method: 'DELETE', credentials: 'include' }),
  );
}

export async function reloadWebhooks(): Promise<{ ok: boolean }> {
  return json<{ ok: boolean }>(
    await fetch('/webhooks/manage/reload', { method: 'POST', credentials: 'include' }),
  );
}

export async function pingWebhook(): Promise<{ ok: boolean; error?: string }> {
  return json<{ ok: boolean; error?: string }>(
    await fetch('/webhooks/manage/ping', { method: 'POST', credentials: 'include' }),
  );
}

export async function createRepoWebhook(repoPath: string): Promise<{ ok: boolean; webhookId?: number; error?: string }> {
  return json<{ ok: boolean; webhookId?: number; error?: string }>(
    await fetch('/webhooks/manage/repos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ repoPath }),
    }),
  );
}

export async function removeRepoWebhook(repoPath: string): Promise<{ ok: boolean }> {
  return json<{ ok: boolean }>(
    await fetch('/webhooks/manage/repos/remove', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ repoPath }),
    }),
  );
}

export async function backfillWebhooks(): Promise<BackfillResult> {
  return json<BackfillResult>(
    await fetch('/webhooks/manage/backfill', { method: 'POST', credentials: 'include' }),
  );
}

export async function updateConfigAutoProvision(autoProvision: boolean): Promise<void> {
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

export async function createWorkspaceGroup(data: { name: string; repos: string[]; themeColor?: string }): Promise<Workspace> {
  const res = await fetch('/workspace-groups', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(await parseErrorBody(res, 'Failed to create workspace'));
  return res.json() as Promise<Workspace>;
}

export async function updateWorkspaceGroup(id: string, data: Partial<Workspace>): Promise<Workspace> {
  const res = await fetch(`/workspace-groups/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(await parseErrorBody(res, 'Failed to update workspace'));
  return res.json() as Promise<Workspace>;
}

export async function deleteWorkspaceGroup(id: string): Promise<void> {
  const res = await fetch(`/workspace-groups/${id}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(await parseErrorBody(res, 'Failed to delete workspace'));
}

export async function launchWorkspaceSession(workspaceId: string, opts?: {
  agent?: string;
  yolo?: boolean;
  useTmux?: boolean;
  claudeArgs?: string[];
  cols?: number;
  rows?: number;
}): Promise<SessionSummary & { warnings?: Array<{ repoPath: string; error: string }> }> {
  const res = await fetch(`/workspace-groups/${workspaceId}/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(opts ?? {}),
  });
  if (!res.ok) throw new Error(await parseErrorBody(res, 'Failed to launch workspace session'));
  return res.json() as Promise<SessionSummary & { warnings?: Array<{ repoPath: string; error: string }> }>;
}

export async function fetchChangedFiles(repoPath: string, base?: string): Promise<ChangedFilesResponse> {
  const params = new URLSearchParams({ path: repoPath });
  if (base) params.set('base', base);
  const res = await fetch('/workspaces/changed-files?' + params.toString());
  if (!res.ok) {
    return { files: [], aggregate: { additions: 0, deletions: 0, fileCount: 0 }, error: `HTTP ${res.status}` };
  }
  return res.json() as Promise<ChangedFilesResponse>;
}

export async function fetchFileDiff(repoPath: string, filePath: string, base?: string): Promise<FileDiffResponse> {
  const params = new URLSearchParams({ path: repoPath, file: filePath });
  if (base) params.set('base', base);
  const res = await fetch('/workspaces/file-diff?' + params.toString());
  if (!res.ok) {
    return { diff: '', error: `HTTP ${res.status}` };
  }
  return res.json() as Promise<FileDiffResponse>;
}

export async function fetchDefaultBranch(repoPath: string): Promise<string> {
  const params = new URLSearchParams({ path: repoPath });
  try {
    const res = await fetch('/workspaces/default-branch?' + params.toString());
    if (!res.ok) return 'main';
    const data = await res.json() as { branch: string };
    return data.branch || 'main';
  } catch {
    return 'main';
  }
}
