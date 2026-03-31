<script lang="ts">
  import DialogShell from './DialogShell.svelte';
  import TuiButton from '../TuiButton.svelte';
  import TuiCheckbox from '../TuiCheckbox.svelte';
  import SettingRow from './SettingRow.svelte';
  import SettingsToc from './SettingsToc.svelte';
  import GitHubIntegration from './integrations/GitHubIntegration.svelte';
  import WebhookIntegration from './integrations/WebhookIntegration.svelte';
  import JiraIntegration from './integrations/JiraIntegration.svelte';
  import WorkspaceEditor from './WorkspaceEditor.svelte';
  import type { Workspace } from '../../lib/types.js';
  import * as api from '../../lib/api.js';
  import {
    setDefaultAgent,
    setDefaultContinue,
    setDefaultYolo,
    setLaunchInTmux,
    setDefaultNotifications,
    checkVersion,
    triggerUpdate,
    fetchAnalyticsSize,
    clearAnalytics,
    fetchGitHubStatus,
    fetchWebhookStatus,
  } from '../../lib/api.js';
  import { refreshAll, getNotificationSessionIds, getSessionState } from '../../lib/state/sessions.svelte.js';
  import { getConfigState, refreshConfig } from '../../lib/state/config.svelte.js';
  import { requestPermission, getPermissionState, syncPushSubscription } from '../../lib/notifications.js';

  let shellRef = $state<ReturnType<typeof DialogShell> | undefined>(undefined);
  let contentEl = $state<HTMLDivElement | undefined>(undefined);

  const config = getConfigState();
  const sessionState = getSessionState();
  let error = $state('');

  // Workspace groups state
  let workspaceGroups = $state<Workspace[]>([]);

  // Version state
  let currentVersion = $state('');
  let latestVersion = $state<string | null>(null);
  let updateAvailable = $state(false);
  let versionChecked = $state(false);
  let updating = $state(false);
  let updateStatus = $state('');

  // Analytics state
  let analyticsSize = $state<number | null>(null);
  let clearing = $state(false);

  // GitHub state (for integration props)
  let githubConnected = $state(false);
  let webhookCount = $state(0);

  // Notification permission state
  let notificationPermission = $state<NotificationPermission | 'unsupported'>(getPermissionState());

  // Devtools state
  let devtoolsEnabled = $state(false);

  // Search state
  let searchQuery = $state('');

  // TOC drawer state
  let tocOpen = $state(false);

  function matchesSearch(sectionId: string): boolean {
    if (!searchQuery.trim()) return true;
    const q = searchQuery.toLowerCase();
    if (sectionId.includes(q)) return true;
    const sectionData: Record<string, string[]> = {
      general: ['default coding agent', 'continue existing session', 'yolo mode', 'launch in tmux', 'notifications', 'push notifications'],
      integrations: ['github', 'webhooks', 'jira', 'real-time', 'ci', 'pr', 'tickets'],
      workspaces: ['workspace', 'group', 'multi-repo', 'project'],
      advanced: ['developer tools', 'analytics', 'debug panel', 'usage data'],
      about: ['version', 'update'],
    };
    return sectionData[sectionId]?.some(term => term.includes(q)) ?? false;
  }

  async function loadWorkspaceGroups() {
    try { workspaceGroups = await api.fetchWorkspaceGroups(); } catch { /* silent */ }
  }

  async function checkVersionAsync() {
    updateStatus = '';
    try {
      const data = await checkVersion();
      currentVersion = data.current;
      latestVersion = data.latest;
      updateAvailable = data.updateAvailable;
      versionChecked = true;
    } catch {
      updateStatus = 'Failed to check for updates.';
    }
  }

  async function fetchAnalyticsSizeAsync() {
    try {
      const d = await fetchAnalyticsSize();
      analyticsSize = d.bytes;
    } catch {
      // ignore
    }
  }

  async function fetchGitHubStatusAsync() {
    try {
      const s = await fetchGitHubStatus();
      githubConnected = s.connected;
      // Check if webhooks are configured for disconnect confirmation
      if (s.connected) {
        try {
          const ws = await fetchWebhookStatus();
          if (ws.configured) webhookCount = 1; // indicates webhooks exist
        } catch { /* webhook status fetch is best-effort */ }
      }
    } catch {
      // ignore — githubConnected stays false
    }
  }

  export function open(scrollToId?: string) {
    error = '';
    updateStatus = '';
    versionChecked = false;
    updating = false;
    devtoolsEnabled = localStorage.getItem('devtools-enabled') === 'true';
    notificationPermission = getPermissionState();
    refreshConfig();
    checkVersionAsync();
    fetchAnalyticsSizeAsync();
    fetchGitHubStatusAsync();
    loadWorkspaceGroups();
    shellRef?.open();
    if (scrollToId) {
      requestAnimationFrame(() => {
        contentEl?.querySelector(`#${scrollToId}`)?.scrollIntoView({ behavior: 'smooth' });
      });
    }
  }

  export function close() {
    shellRef?.close();
    refreshAll();
  }

  // -- Handler functions (API calls with optimistic updates) --

  async function handleAgentChange() {
    const prev = config.defaultAgent;
    error = '';
    try {
      await setDefaultAgent(config.defaultAgent);
    } catch {
      config.defaultAgent = prev;
      error = 'Failed to update default agent.';
    }
  }

  async function handleContinueChange() {
    const prev = config.defaultContinue;
    error = '';
    try {
      await setDefaultContinue(config.defaultContinue);
    } catch {
      config.defaultContinue = prev;
      error = 'Failed to update continue default.';
    }
  }

  async function handleYoloChange() {
    const prev = config.defaultYolo;
    error = '';
    try {
      await setDefaultYolo(config.defaultYolo);
    } catch {
      config.defaultYolo = prev;
      error = 'Failed to update yolo default.';
    }
  }

  async function handleTmuxChange() {
    const prev = config.launchInTmux;
    error = '';
    try {
      await setLaunchInTmux(config.launchInTmux);
    } catch (err) {
      config.launchInTmux = prev;
      error = err instanceof Error ? err.message : 'Failed to update tmux setting.';
    }
  }

  async function handleNotificationsChange() {
    const prev = config.defaultNotifications;
    error = '';

    // When toggling ON, request browser permission if not already granted
    if (config.defaultNotifications && notificationPermission !== 'granted') {
      const permission = await requestPermission();
      notificationPermission = permission;

      if (permission !== 'granted') {
        config.defaultNotifications = prev;
        error = permission === 'unsupported'
          ? 'Notifications are not supported in this browser.'
          : permission === 'default'
          ? 'Notification permission is required. Please allow when prompted.'
          : 'Notifications blocked by browser. Check site settings to enable.';
        return;
      }
    }

    try {
      await setDefaultNotifications(config.defaultNotifications);

      // Register push subscription whenever notifications are enabled and permission is granted
      if (notificationPermission === 'granted') {
        await syncPushSubscription(getNotificationSessionIds());
      }
    } catch {
      config.defaultNotifications = prev;
      error = 'Failed to update notifications default.';
    }
  }

  function handleDevtoolsChange() {
    localStorage.setItem('devtools-enabled', devtoolsEnabled ? 'true' : 'false');
    window.dispatchEvent(new Event('devtools-changed'));
  }

  async function handleClearAnalytics() {
    if (!confirm('Clear all analytics data? This cannot be undone.')) return;
    clearing = true;
    try {
      await clearAnalytics();
      analyticsSize = 0;
    } catch {
      error = 'Failed to clear analytics.';
    } finally {
      clearing = false;
    }
  }

  async function handleUpdate() {
    updating = true;
    updateStatus = '';
    try {
      const result = await triggerUpdate();
      if (result.restarting) {
        updateStatus = 'Updated! Restarting server\u2026';
        setTimeout(() => { location.reload(); }, 5000);
      } else {
        updateStatus = 'Updated! Please restart the server manually.';
      }
      updateAvailable = false;
    } catch {
      updateStatus = 'Update failed. Please try again.';
      updating = false;
    }
  }

  function handleGitHubDisconnect() {
    githubConnected = false;
  }

  function scrollToSection(sectionId: string) {
    tocOpen = false;
    contentEl?.querySelector(`#${sectionId}`)?.scrollIntoView({ behavior: 'smooth' });
  }
</script>

{#snippet headerExtra()}
  <div class="header-extra-content">
    <button class="hamburger-btn" onclick={() => tocOpen = !tocOpen} aria-label="Navigation">&#9776;</button>
    <input
      class="search-input"
      type="text"
      placeholder="Search..."
      bind:value={searchQuery}
      aria-label="Search settings"
    />
  </div>
{/snippet}

<DialogShell bind:this={shellRef} title="settings" variant="fullscreen" header-extra={headerExtra}>
  <div class="settings-content" bind:this={contentEl}>
    {#if error}
      <p class="error-msg">{error}</p>
    {/if}

    <!-- TOC drawer with IntersectionObserver scroll tracking -->
    <SettingsToc
      open={tocOpen}
      onclose={() => tocOpen = false}
      {contentEl}
      sections={[
        { id: 'section-general', label: 'general' },
        { id: 'section-integrations', label: 'integrations', children: [
          { id: 'integration-github', label: 'GitHub' },
          { id: 'integration-webhooks', label: 'Webhooks' },
          { id: 'integration-jira', label: 'Jira' },
        ]},
        { id: 'section-workspaces', label: 'workspaces' },
        { id: 'section-advanced', label: 'advanced' },
        { id: 'section-about', label: 'about' },
      ]}
    />

    <div class="settings-sections">
    <!-- GENERAL section -->
    <section id="section-general" class="settings-section" class:dimmed={!matchesSearch('general')}>
      <h3 class="section-heading">general</h3>

      <SettingRow name="Default Coding Agent" description="Which AI agent to use for new sessions">
        <select bind:value={config.defaultAgent} onchange={handleAgentChange}>
          <option value="claude">Claude</option>
          <option value="codex">Codex</option>
        </select>
      </SettingRow>

      <SettingRow name="Continue existing session" description="Resume the last session when opening a repo">
        <TuiCheckbox bind:checked={config.defaultContinue} onchange={handleContinueChange} />
      </SettingRow>

      <SettingRow name="YOLO mode" description="Skip permission checks for all sessions">
        <TuiCheckbox bind:checked={config.defaultYolo} onchange={handleYoloChange} />
      </SettingRow>

      <SettingRow name="Launch in tmux" description="Wrap sessions in tmux for scroll and copy">
        <TuiCheckbox bind:checked={config.launchInTmux} onchange={handleTmuxChange} />
      </SettingRow>

      <SettingRow name="Notifications" description={
        notificationPermission === 'denied' ? 'Blocked by browser — check site settings to enable'
        : notificationPermission === 'unsupported' ? 'Not supported in this browser'
        : 'Notify when sessions need attention'
      }>
        <TuiCheckbox bind:checked={config.defaultNotifications} onchange={handleNotificationsChange}
          disabled={(notificationPermission === 'denied' || notificationPermission === 'unsupported') && !config.defaultNotifications} />
      </SettingRow>
    </section>

    <!-- INTEGRATIONS section -->
    <section id="section-integrations" class="settings-section" class:dimmed={!matchesSearch('integrations')}>
      <h3 class="section-heading">integrations</h3>
      <div id="integration-github">
        <GitHubIntegration
          onDisconnect={handleGitHubDisconnect}
          webhookCount={webhookCount}
        />
      </div>
      <div id="integration-webhooks">
        <WebhookIntegration
          githubConnected={githubConnected}
        />
      </div>
      <div id="integration-jira">
        <JiraIntegration />
      </div>
    </section>

    <!-- WORKSPACES section -->
    <section id="section-workspaces" class="settings-section" class:dimmed={!matchesSearch('workspaces')}>
      <h3 class="section-heading">workspaces</h3>
      <p class="section-description">group repos into workspaces for multi-repo sessions</p>

      {#if workspaceGroups.length === 0}
        <p style="color: var(--text-muted); font-size: var(--font-size-xs);">no workspaces yet</p>
      {/if}

      {#each workspaceGroups as ws (ws.id)}
        <WorkspaceEditor
          workspace={ws}
          repos={sessionState.repos}
          onsave={async (updates) => {
            await api.updateWorkspaceGroup(ws.id, updates);
            await loadWorkspaceGroups();
          }}
          ondelete={async () => {
            await api.deleteWorkspaceGroup(ws.id);
            await loadWorkspaceGroups();
          }}
        />
      {/each}

      <button
        class="ghost-btn"
        onclick={async () => {
          await api.createWorkspaceGroup({ name: 'new workspace', repos: [] });
          await loadWorkspaceGroups();
        }}
      >[ + new workspace ]</button>
    </section>

    <!-- ADVANCED section -->
    <section id="section-advanced" class="settings-section" class:dimmed={!matchesSearch('advanced')}>
      <h3 class="section-heading">advanced</h3>

      <SettingRow name="Developer Tools" description="Mobile debug panel">
        <TuiCheckbox bind:checked={devtoolsEnabled} onchange={handleDevtoolsChange} />
      </SettingRow>

      <SettingRow name="Analytics" description="Local usage data">
        <div class="analytics-action">
          {#if analyticsSize !== null}
            <span class="analytics-size">{(analyticsSize / 1024 / 1024).toFixed(1)} MB</span>
          {/if}
          <TuiButton variant="ghost" size="sm" onclick={handleClearAnalytics} disabled={clearing}>
            {clearing ? 'Clearing\u2026' : 'Clear'}
          </TuiButton>
        </div>
      </SettingRow>
    </section>

    <!-- ABOUT section -->
    <section id="section-about" class="settings-section" class:dimmed={!matchesSearch('about')}>
      <h3 class="section-heading">about</h3>

      <SettingRow name="Version" description={currentVersion ? `v${currentVersion}` : ''}>
        {#if updateAvailable}
          <TuiButton variant="primary" size="sm" onclick={handleUpdate} disabled={updating}>
            {updating ? 'Updating\u2026' : `Update to v${latestVersion}`}
          </TuiButton>
        {:else if versionChecked}
          <span class="version-ok">Up to date</span>
        {/if}
      </SettingRow>

      {#if updateStatus}
        <p class="update-status">{updateStatus}</p>
      {/if}
    </section>
    </div>
  </div>
</DialogShell>

<style>
  .header-extra-content {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .settings-content {
    display: flex;
    flex-direction: column;
    gap: 32px;
    position: relative;
  }

  .settings-sections {
    display: flex;
    flex-direction: column;
    gap: 32px;
    flex: 1;
    min-width: 0;
    padding: 16px 20px;
  }

  /* Desktop: side-by-side TOC + scrollable content */
  @media (min-width: 601px) {
    .settings-content {
      flex-direction: row;
      gap: 0;
      height: 100%;
      overflow: hidden;
    }

    .settings-sections {
      overflow-y: auto;
    }
  }

  .settings-section {
    transition: opacity 200ms ease, max-height 200ms ease;
  }

  .settings-section.dimmed {
    opacity: 0.3;
    max-height: 0;
    overflow: hidden;
    padding: 0;
    margin: 0;
  }

  .section-heading {
    font-size: var(--font-size-xs);
    color: var(--text-muted);
    letter-spacing: 0.08em;
    margin: 0 -20px 12px;
    padding: 0 20px 8px;
    border-bottom: 1px solid var(--border);
  }

  .search-input {
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 0;
    color: var(--text);
    font-family: var(--font-mono);
    font-size: var(--font-size-sm);
    padding: 8px 12px;
    flex: 1;
    max-width: 200px;
    outline: none;
  }

  .search-input:focus {
    border-color: var(--accent);
  }

  .search-input::placeholder {
    color: var(--text-muted);
  }

  .hamburger-btn {
    background: none;
    border: 1px solid var(--border);
    border-radius: 0;
    color: var(--text-muted);
    font-size: var(--font-size-lg);
    cursor: pointer;
    padding: 4px 8px;
    line-height: 1;
    font-family: var(--font-mono);
  }

  .hamburger-btn:hover {
    background: var(--border);
    color: var(--text);
  }

  /* Desktop: hide hamburger, TOC is always visible */
  @media (min-width: 601px) {
    .hamburger-btn { display: none; }
  }

  .analytics-action {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .analytics-size {
    font-size: var(--font-size-sm);
    color: var(--text-muted);
    font-family: var(--font-mono);
  }

  .version-ok {
    font-size: var(--font-size-sm);
    color: var(--status-success);
  }

  .update-status {
    font-size: var(--font-size-sm);
    color: var(--text-muted);
    margin: 0;
  }

  select {
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 0;
    color: var(--text);
    font-family: var(--font-mono);
    font-size: var(--font-size-sm);
    padding: 8px 8px;
    cursor: pointer;
  }

  select:focus {
    border-color: var(--accent);
    outline: none;
  }

  .section-description {
    font-size: var(--font-size-xs);
    color: var(--text-muted);
    margin: 0 0 12px;
    font-family: var(--font-mono);
  }

  .ghost-btn {
    background: none;
    border: 1px solid var(--border);
    color: var(--text-muted);
    font-family: var(--font-mono);
    font-size: var(--font-size-xs);
    padding: 6px 10px;
    cursor: pointer;
    margin-top: 4px;
  }

  .ghost-btn:hover {
    border-color: var(--accent);
    color: var(--accent);
  }
</style>
