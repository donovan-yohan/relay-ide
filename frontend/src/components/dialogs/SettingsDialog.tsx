import React, {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  useCallback,
} from 'react';
import DialogShell, { type DialogShellHandle } from './DialogShell.js';
import TuiButton from '../TuiButton.js';
import TuiCheckbox from '../TuiCheckbox.js';
import SettingRow from './SettingRow.js';
import SettingsToc from './SettingsToc.js';
import GitHubIntegration from './integrations/GitHubIntegration.js';
import WebhookIntegration from './integrations/WebhookIntegration.js';
import JiraIntegration from './integrations/JiraIntegration.js';
import {
  setDefaultAgent,
  setDefaultContinue,
  setDefaultYolo,
  setDefaultNotifications,
  setClaudeFullscreen,
  checkVersion,
  triggerUpdate,
  fetchAnalyticsSize,
  clearAnalytics,
  fetchGitHubStatus,
  fetchWebhookStatus,
  fetchDefaultAgent,
  fetchDefaultContinue,
  fetchDefaultYolo,
  fetchDefaultNotifications,
  fetchClaudeFullscreen,
  fetchUpdateChannel,
  setUpdateChannel,
} from '../../lib/api.js';
import { useSessionsStore } from '../../lib/stores/sessions.js';
import { useConfigStore } from '../../lib/stores/config.js';
import { useUiStore } from '../../lib/stores/ui.js';
import { isFrameworkAvailable } from './CustomizeSessionDialog.js';
import {
  requestPermission,
  getPermissionState,
  syncPushSubscription,
} from '../../lib/notifications.js';
import './SettingsDialog.css';

export interface SettingsDialogHandle {
  open(scrollToId?: string): void;
  close(): void;
}

interface ConfigState {
  defaultAgent: string;
  defaultContinue: boolean;
  defaultYolo: boolean;
  defaultNotifications: boolean;
  claudeFullscreen: boolean;
}

const DEFAULT_CONFIG: ConfigState = {
  defaultAgent: 'claude',
  defaultContinue: true,
  defaultYolo: false,
  defaultNotifications: true,
  claudeFullscreen: true,
};

const TOC_SECTIONS = [
  { id: 'section-general', label: 'general' },
  {
    id: 'section-agents',
    label: 'agents',
    children: [{ id: 'agent-claude-code', label: 'Claude Code' }],
  },
  {
    id: 'section-integrations',
    label: 'integrations',
    children: [
      { id: 'integration-github', label: 'GitHub' },
      { id: 'integration-webhooks', label: 'Webhooks' },
      { id: 'integration-jira', label: 'Jira' },
    ],
  },
  { id: 'section-advanced', label: 'advanced' },
  { id: 'section-about', label: 'about' },
];

const SECTION_KEYWORDS: Record<string, string[]> = {
  general: ['default coding agent', 'continue', 'yolo', 'notifications'],
  agents: ['claude', 'claude code', 'fullscreen', 'no flicker'],
  integrations: [
    'github',
    'webhooks',
    'jira',
    'real-time',
    'ci',
    'pr',
    'tickets',
  ],
  advanced: [
    'developer tools',
    'analytics',
    'debug panel',
    'workspace layout',
    'experimental',
    'tabs',
  ],
  about: ['version', 'update', 'channel', 'nightly', 'stable'],
};

async function loadConfig(): Promise<ConfigState> {
  const [agent, cont, yolo, notif, fullscreen] = await Promise.all([
    fetchDefaultAgent().catch(() => DEFAULT_CONFIG.defaultAgent),
    fetchDefaultContinue().catch(() => DEFAULT_CONFIG.defaultContinue),
    fetchDefaultYolo().catch(() => DEFAULT_CONFIG.defaultYolo),
    fetchDefaultNotifications().catch(
      () => DEFAULT_CONFIG.defaultNotifications
    ),
    fetchClaudeFullscreen().catch(() => DEFAULT_CONFIG.claudeFullscreen),
  ]);
  return {
    defaultAgent: agent,
    defaultContinue: cont,
    defaultYolo: yolo,
    defaultNotifications: notif,
    claudeFullscreen: fullscreen,
  };
}

function sectionClass(id: string, query: string): string {
  if (!query.trim()) return 'settings-dialog-section';
  const q = query.toLowerCase();
  const key = id.replace('section-', '');
  const matches =
    key.includes(q) ||
    (SECTION_KEYWORDS[key]?.some((t) => t.includes(q)) ?? false);
  return ['settings-dialog-section', !matches ? 'dimmed' : '']
    .filter(Boolean)
    .join(' ');
}

function useConfigHandlers(
  config: ConfigState,
  setConfig: React.Dispatch<React.SetStateAction<ConfigState>>,
  setError: (e: string) => void,
  notifPerm: NotificationPermission | 'unsupported',
  setNotifPerm: (p: NotificationPermission | 'unsupported') => void
) {
  async function handleAgentChange(v: string) {
    const prev = config.defaultAgent;
    setConfig((c) => ({ ...c, defaultAgent: v }));
    setError('');
    try {
      await setDefaultAgent(v);
    } catch {
      setConfig((c) => ({ ...c, defaultAgent: prev }));
      setError('Failed to update default agent.');
    }
  }
  async function handleContinueChange(v: boolean) {
    const prev = config.defaultContinue;
    setConfig((c) => ({ ...c, defaultContinue: v }));
    setError('');
    try {
      await setDefaultContinue(v);
    } catch {
      setConfig((c) => ({ ...c, defaultContinue: prev }));
      setError('Failed to update continue default.');
    }
  }
  async function handleYoloChange(v: boolean) {
    const prev = config.defaultYolo;
    setConfig((c) => ({ ...c, defaultYolo: v }));
    setError('');
    try {
      await setDefaultYolo(v);
    } catch {
      setConfig((c) => ({ ...c, defaultYolo: prev }));
      setError('Failed to update yolo default.');
    }
  }
  async function handleNotifChange(v: boolean) {
    const prev = config.defaultNotifications;
    setConfig((c) => ({ ...c, defaultNotifications: v }));
    setError('');
    if (v && notifPerm !== 'granted') {
      const perm = await requestPermission();
      setNotifPerm(perm);
      if (perm !== 'granted') {
        setConfig((c) => ({ ...c, defaultNotifications: prev }));
        setError(
          perm === 'unsupported'
            ? 'Notifications are not supported in this browser.'
            : perm === 'default'
              ? 'Notification permission is required.'
              : 'Notifications blocked by browser.'
        );
        return;
      }
    }
    try {
      await setDefaultNotifications(v);
      if (notifPerm === 'granted')
        await syncPushSubscription(
          useSessionsStore.getState().getNotificationSessionIds()
        );
    } catch {
      setConfig((c) => ({ ...c, defaultNotifications: prev }));
      setError('Failed to update notifications default.');
    }
  }
  async function handleClaudeFullscreenChange(v: boolean) {
    const prev = config.claudeFullscreen;
    setConfig((c) => ({ ...c, claudeFullscreen: v }));
    setError('');
    try {
      await setClaudeFullscreen(v);
      await useConfigStore.getState().refreshConfig();
    } catch {
      setConfig((c) => ({ ...c, claudeFullscreen: prev }));
      setError('Failed to update Claude fullscreen setting.');
    }
  }
  return {
    handleAgentChange,
    handleContinueChange,
    handleYoloChange,
    handleNotifChange,
    handleClaudeFullscreenChange,
  };
}

interface SettingsDialogProps {
  onClose?: () => void;
}

const SettingsDialog = forwardRef<SettingsDialogHandle, SettingsDialogProps>(
  function SettingsDialog({ onClose }, ref) {
    const shellRef = useRef<DialogShellHandle>(null);
    const contentElRef = useRef<HTMLDivElement | null>(null);
    const [contentEl, setContentEl] = useState<HTMLDivElement | undefined>(
      undefined
    );
    const [config, setConfig] = useState<ConfigState>(DEFAULT_CONFIG);
    const [error, setError] = useState('');
    const [versionInfo, setVersionInfo] = useState({
      current: '',
      latest: null as string | null,
      available: false,
      checked: false,
      updating: false,
      status: '',
    });
    const [analyticsSize, setAnalyticsSize] = useState<number | null>(null);
    const [clearing, setClearing] = useState(false);
    const [githubConnected, setGithubConnected] = useState(false);
    const [webhookCount, setWebhookCount] = useState(0);
    const [notifPerm, setNotifPerm] = useState<
      NotificationPermission | 'unsupported'
    >(getPermissionState());
    const [devtoolsEnabled, setDevtoolsEnabled] = useState(false);
    const workspaceLayoutEnabled = useUiStore((s) => s.workspaceLayoutEnabled);
    const setWorkspaceLayoutEnabled = useUiStore(
      (s) => s.setWorkspaceLayoutEnabled
    );
    const [searchQuery, setSearchQuery] = useState('');
    const [tocOpen, setTocOpen] = useState(false);

    const contentRefCallback = useCallback((el: HTMLDivElement | null) => {
      contentElRef.current = el;
      setContentEl(el ?? undefined);
    }, []);

    const configHandlers = useConfigHandlers(
      config,
      setConfig,
      setError,
      notifPerm,
      setNotifPerm
    );

    async function loadAllData() {
      const [cfg] = await Promise.all([
        loadConfig(),
        checkVersion()
          .then((d) =>
            setVersionInfo((v) => ({
              ...v,
              current: d.current,
              latest: d.latest,
              available: d.updateAvailable,
              checked: true,
            }))
          )
          .catch(() =>
            setVersionInfo((v) => ({
              ...v,
              status: 'Failed to check for updates.',
            }))
          ),
        fetchAnalyticsSize()
          .then((d) => setAnalyticsSize(d.bytes))
          .catch(() => undefined),
        fetchGitHubStatus()
          .then(async (s) => {
            setGithubConnected(s.connected);
            if (s.connected) {
              const ws = await fetchWebhookStatus().catch(() => null);
              if (ws?.configured) setWebhookCount(1);
            }
          })
          .catch(() => undefined),
      ]);
      setConfig(cfg);
    }

    useImperativeHandle(ref, () => ({
      open(scrollToId?: string) {
        setError('');
        setVersionInfo((v) => ({
          ...v,
          status: '',
          checked: false,
          updating: false,
        }));
        setDevtoolsEnabled(localStorage.getItem('devtools-enabled') === 'true');
        setNotifPerm(getPermissionState());
        void loadAllData();
        shellRef.current?.open();
        if (scrollToId)
          requestAnimationFrame(() =>
            contentElRef.current
              ?.querySelector(`#${scrollToId}`)
              ?.scrollIntoView({ behavior: 'smooth' })
          );
      },
      close() {
        shellRef.current?.close();
        void useSessionsStore.getState().refreshAll();
      },
    }));

    async function handleClearAnalytics() {
      if (!confirm('Clear all analytics data? This cannot be undone.')) return;
      setClearing(true);
      try {
        await clearAnalytics();
        setAnalyticsSize(0);
      } catch {
        setError('Failed to clear analytics.');
      } finally {
        setClearing(false);
      }
    }

    async function handleUpdate() {
      setVersionInfo((v) => ({ ...v, updating: true, status: '' }));
      try {
        const result = await triggerUpdate();
        if (result.restarting) {
          setVersionInfo((v) => ({
            ...v,
            status: 'Updated! Restarting\u2026',
            available: false,
          }));
          setTimeout(() => location.reload(), 5000);
        } else
          setVersionInfo((v) => ({
            ...v,
            status: 'Updated! Please restart the server manually.',
            available: false,
          }));
      } catch {
        setVersionInfo((v) => ({
          ...v,
          status: 'Update failed. Please try again.',
          updating: false,
        }));
      }
    }

    const notifDescription =
      notifPerm === 'denied'
        ? 'Blocked by browser — check site settings'
        : notifPerm === 'unsupported'
          ? 'Not supported in this browser'
          : 'Notify when sessions need attention';
    const headerExtra = (
      <div className="settings-dialog-header-extra">
        <button
          className="settings-dialog-hamburger-btn"
          onClick={() => setTocOpen((v) => !v)}
          aria-label="Navigation"
        >
          &#9776;
        </button>
        <input
          className="settings-dialog-search-input"
          type="text"
          placeholder="Search..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.currentTarget.value)}
          aria-label="Search settings"
        />
      </div>
    );

    return (
      <DialogShell
        ref={shellRef}
        title="settings"
        variant="fullscreen"
        headerExtra={headerExtra}
        onClose={onClose}
      >
        <div className="settings-dialog-content" ref={contentRefCallback}>
          {error && <p className="error-msg">{error}</p>}
          <SettingsToc
            open={tocOpen}
            onclose={() => setTocOpen(false)}
            {...(contentEl ? { contentEl } : {})}
            sections={TOC_SECTIONS}
          />
          <div className="settings-dialog-sections">
            <GeneralSection
              config={config}
              notifDescription={notifDescription}
              notifPerm={notifPerm}
              searchQuery={searchQuery}
              handlers={configHandlers}
            />
            <AgentsSection
              config={config}
              searchQuery={searchQuery}
              handlers={configHandlers}
            />
            <IntegrationsSection
              searchQuery={searchQuery}
              githubConnected={githubConnected}
              webhookCount={webhookCount}
              onGitHubDisconnect={() => setGithubConnected(false)}
            />
            <AdvancedSection
              searchQuery={searchQuery}
              analyticsSize={analyticsSize}
              clearing={clearing}
              devtoolsEnabled={devtoolsEnabled}
              onDevtoolsChange={(v) => {
                setDevtoolsEnabled(v);
                localStorage.setItem('devtools-enabled', v ? 'true' : 'false');
                window.dispatchEvent(new Event('devtools-changed'));
              }}
              workspaceLayoutEnabled={workspaceLayoutEnabled}
              onWorkspaceLayoutChange={setWorkspaceLayoutEnabled}
              onClearAnalytics={() => void handleClearAnalytics()}
            />
            <AboutSection
              searchQuery={searchQuery}
              versionInfo={versionInfo}
              onUpdate={() => void handleUpdate()}
            />
          </div>
        </div>
      </DialogShell>
    );
  }
);

// ── Sub-sections ─────────────────────────────────────────────────────────────

type ConfigHandlers = ReturnType<typeof useConfigHandlers>;

function GeneralSection({
  config,
  notifDescription,
  notifPerm,
  searchQuery,
  handlers,
}: {
  config: ConfigState;
  notifDescription: string;
  notifPerm: NotificationPermission | 'unsupported';
  searchQuery: string;
  handlers: ConfigHandlers;
}) {
  const notifDisabled =
    (notifPerm === 'denied' || notifPerm === 'unsupported') &&
    !config.defaultNotifications;
  const frameworks = useConfigStore((state) => state.frameworks);
  return (
    <section
      id="section-general"
      className={sectionClass('section-general', searchQuery)}
    >
      <h3 className="settings-dialog-section-heading">general</h3>
      <SettingRow
        name="Default Coding Agent"
        description="Which AI agent to use for new sessions"
      >
        <select
          className="settings-dialog-select"
          value={config.defaultAgent}
          onChange={(e) =>
            void handlers.handleAgentChange(e.currentTarget.value)
          }
        >
          {(frameworks.length > 0
            ? frameworks
            : [
                { id: 'claude', displayName: 'Claude' },
                { id: 'codex', displayName: 'Codex' },
                { id: 'opencode', displayName: 'OpenCode' },
              ]
          ).map((framework) => (
            <option
              key={framework.id}
              value={framework.id}
              disabled={
                'availability' in framework &&
                !isFrameworkAvailable(framework as (typeof frameworks)[number])
              }
            >
              {framework.displayName}
              {'availability' in framework &&
              !isFrameworkAvailable(framework as (typeof frameworks)[number])
                ? ' (not installed)'
                : ''}
            </option>
          ))}
        </select>
      </SettingRow>
      <SettingRow
        name="Continue existing session"
        description="Resume the last session when opening a repo"
      >
        <TuiCheckbox
          checked={config.defaultContinue}
          onChange={(v) => void handlers.handleContinueChange(v)}
        />
      </SettingRow>
      <SettingRow
        name="YOLO mode"
        description="Skip permission checks for all sessions"
      >
        <TuiCheckbox
          checked={config.defaultYolo}
          onChange={(v) => void handlers.handleYoloChange(v)}
        />
      </SettingRow>
      <SettingRow name="Notifications" description={notifDescription}>
        <TuiCheckbox
          checked={config.defaultNotifications}
          onChange={(v) => void handlers.handleNotifChange(v)}
          disabled={notifDisabled}
        />
      </SettingRow>
    </section>
  );
}

function AgentsSection({
  config,
  searchQuery,
  handlers,
}: {
  config: ConfigState;
  searchQuery: string;
  handlers: ConfigHandlers;
}) {
  return (
    <section
      id="section-agents"
      className={sectionClass('section-agents', searchQuery)}
    >
      <h3 className="settings-dialog-section-heading">agents</h3>
      <h4 id="agent-claude-code" className="settings-dialog-subsection-heading">
        Claude Code
      </h4>
      <SettingRow
        name="Fullscreen mode"
        description="Lock terminal to viewport height — Claude handles scrolling internally"
      >
        <TuiCheckbox
          checked={config.claudeFullscreen}
          onChange={(v) => void handlers.handleClaudeFullscreenChange(v)}
        />
      </SettingRow>
    </section>
  );
}

function IntegrationsSection({
  searchQuery,
  githubConnected,
  webhookCount,
  onGitHubDisconnect,
}: {
  searchQuery: string;
  githubConnected: boolean;
  webhookCount: number;
  onGitHubDisconnect: () => void;
}) {
  return (
    <section
      id="section-integrations"
      className={sectionClass('section-integrations', searchQuery)}
    >
      <h3 className="settings-dialog-section-heading">integrations</h3>
      <div id="integration-github">
        <GitHubIntegration
          onDisconnect={onGitHubDisconnect}
          webhookCount={webhookCount}
        />
      </div>
      <div id="integration-webhooks">
        <WebhookIntegration githubConnected={githubConnected} />
      </div>
      <div id="integration-jira">
        <JiraIntegration />
      </div>
    </section>
  );
}

function AdvancedSection({
  searchQuery,
  analyticsSize,
  clearing,
  devtoolsEnabled,
  onDevtoolsChange,
  workspaceLayoutEnabled,
  onWorkspaceLayoutChange,
  onClearAnalytics,
}: {
  searchQuery: string;
  analyticsSize: number | null;
  clearing: boolean;
  devtoolsEnabled: boolean;
  onDevtoolsChange: (v: boolean) => void;
  workspaceLayoutEnabled: boolean;
  onWorkspaceLayoutChange: (v: boolean) => void;
  onClearAnalytics: () => void;
}) {
  return (
    <section
      id="section-advanced"
      className={sectionClass('section-advanced', searchQuery)}
    >
      <h3 className="settings-dialog-section-heading">advanced</h3>
      <SettingRow name="Developer Tools" description="Mobile debug panel">
        <TuiCheckbox
          checked={devtoolsEnabled}
          onChange={(v) => onDevtoolsChange(v)}
        />
      </SettingRow>
      <SettingRow
        name="Workspace Layout"
        description="Experimental sessions-as-tabs view"
      >
        <TuiCheckbox
          checked={workspaceLayoutEnabled}
          onChange={(v) => onWorkspaceLayoutChange(v)}
        />
      </SettingRow>
      <SettingRow name="Analytics" description="Local usage data">
        <div className="settings-dialog-analytics-action">
          {analyticsSize !== null && (
            <span className="settings-dialog-analytics-size">
              {(analyticsSize / 1024 / 1024).toFixed(1)} MB
            </span>
          )}
          <TuiButton
            variant="ghost"
            size="sm"
            onClick={onClearAnalytics}
            disabled={clearing}
          >
            {clearing ? 'Clearing\u2026' : 'Clear'}
          </TuiButton>
        </div>
      </SettingRow>
    </section>
  );
}

interface VersionInfo {
  current: string;
  latest: string | null;
  available: boolean;
  checked: boolean;
  updating: boolean;
  status: string;
}
function AboutSection({
  searchQuery,
  versionInfo,
  onUpdate,
}: {
  searchQuery: string;
  versionInfo: VersionInfo;
  onUpdate: () => void;
}) {
  const [updateChannelValue, setUpdateChannelValue] = useState<
    'stable' | 'nightly'
  >('stable');
  const [savingChannel, setSavingChannel] = useState(false);

  useEffect(() => {
    fetchUpdateChannel().then(
      (ch) => setUpdateChannelValue(ch),
      () => setUpdateChannelValue('stable')
    );
  }, []);

  const handleChannelChange = useCallback(
    async (channel: 'stable' | 'nightly') => {
      if (savingChannel || channel === updateChannelValue) return;
      setSavingChannel(true);
      try {
        await setUpdateChannel(channel);
        setUpdateChannelValue(channel);
      } catch {
        // ignore
      } finally {
        setSavingChannel(false);
      }
    },
    [savingChannel, updateChannelValue]
  );

  return (
    <section
      id="section-about"
      className={sectionClass('section-about', searchQuery)}
    >
      <h3 className="settings-dialog-section-heading">about</h3>
      <SettingRow
        name="Version"
        description={versionInfo.current ? `v${versionInfo.current}` : ''}
      >
        {versionInfo.available ? (
          <TuiButton
            variant="primary"
            size="sm"
            onClick={onUpdate}
            disabled={versionInfo.updating}
          >
            {versionInfo.updating
              ? 'Updating\u2026'
              : `Update to v${versionInfo.latest}`}
          </TuiButton>
        ) : versionInfo.checked ? (
          <span className="settings-dialog-version-ok">Up to date</span>
        ) : null}
      </SettingRow>
      <SettingRow
        name="Update Channel"
        description={
          updateChannelValue === 'nightly'
            ? 'Nightly builds'
            : 'Stable releases'
        }
      >
        <div className="settings-dialog-channel-selector">
          <button
            className={`settings-dialog-channel-btn${updateChannelValue === 'stable' ? ' active' : ''}`}
            disabled={savingChannel}
            onClick={() => handleChannelChange('stable')}
          >
            stable
          </button>
          <button
            className={`settings-dialog-channel-btn${updateChannelValue === 'nightly' ? ' active' : ''}`}
            disabled={savingChannel}
            onClick={() => handleChannelChange('nightly')}
          >
            nightly
          </button>
        </div>
      </SettingRow>
      {versionInfo.status && (
        <p className="settings-dialog-update-status">{versionInfo.status}</p>
      )}
    </section>
  );
}

export default SettingsDialog;
