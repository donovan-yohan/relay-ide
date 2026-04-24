import type { ActionMeta } from '../types.js';

export const settingsOpen: ActionMeta = {
  id: 'settings.open',
  label: 'open settings',
  description: 'app preferences and integrations',
  category: 'settings',
  icon: '>',
};

export const settingsConnectGithub: ActionMeta = {
  id: 'settings.connect-github',
  label: 'connect github',
  description: 'link your github account',
  category: 'settings',
  icon: '>',
};

export const settingsToggleYolo: ActionMeta = {
  id: 'settings.toggle-yolo',
  label: 'toggle yolo mode',
  description: 'skip permission checks',
  category: 'settings',
  icon: '!',
};

export const settingsCheckUpdates: ActionMeta = {
  id: 'settings.check-updates',
  label: 'check for updates',
  description: 'see if a new version is available',
  category: 'settings',
  icon: '↻',
};

export const settingsDisconnectGithub: ActionMeta = {
  id: 'settings.disconnect-github',
  label: 'disconnect github',
  description: 'remove github account connection',
  category: 'settings',
  icon: '×',
};

export const settingsSetupWebhooks: ActionMeta = {
  id: 'settings.setup-webhooks',
  label: 'setup webhooks',
  description: 'configure webhook integrations',
  category: 'settings',
  icon: '>',
};

export const settingsRemoveWebhook: ActionMeta = {
  id: 'settings.remove-webhook',
  label: 'remove webhook',
  description: 'delete a webhook configuration',
  category: 'settings',
  icon: '×',
};

export const settingsTestWebhook: ActionMeta = {
  id: 'settings.test-webhook',
  label: 'test webhook',
  description: 'send a test webhook payload',
  category: 'settings',
  icon: '▸',
};

export const settingsConnectJira: ActionMeta = {
  id: 'settings.connect-jira',
  label: 'connect jira',
  description: 'link your jira account',
  category: 'settings',
  icon: '>',
};

export const settingsDisconnectJira: ActionMeta = {
  id: 'settings.disconnect-jira',
  label: 'disconnect jira',
  description: 'remove jira account connection',
  category: 'settings',
  icon: '×',
};

export const settingsToggleDevTools: ActionMeta = {
  id: 'settings.toggle-devtools',
  label: 'toggle developer tools',
  description: 'show or hide debug panel',
  category: 'settings',
  icon: '>',
};

export const settingsClearAnalytics: ActionMeta = {
  id: 'settings.clear-analytics',
  label: 'clear analytics',
  description: 'delete local usage data',
  category: 'settings',
  icon: '×',
};

export const settingsToggleContinue: ActionMeta = {
  id: 'settings.toggle-continue',
  label: 'toggle continue session',
  description: 'resume last session when opening a repo',
  category: 'settings',
  icon: '↻',
};

export const settingsToggleNotifications: ActionMeta = {
  id: 'settings.toggle-notifications',
  label: 'toggle notifications',
  description: 'enable or disable push notifications',
  category: 'settings',
  icon: '●',
};

export const settingsChangeDefaultAgent: ActionMeta = {
  id: 'settings.change-default-agent',
  label: 'change default agent',
  description: 'set the default coding agent',
  category: 'settings',
  icon: '>',
};

export const settingsActions: ActionMeta[] = [
  settingsOpen,
  settingsConnectGithub,
  settingsToggleYolo,
  settingsCheckUpdates,
  settingsDisconnectGithub,
  settingsSetupWebhooks,
  settingsRemoveWebhook,
  settingsTestWebhook,
  settingsConnectJira,
  settingsDisconnectJira,
  settingsToggleDevTools,
  settingsClearAnalytics,
  settingsToggleContinue,
  settingsToggleNotifications,
  settingsChangeDefaultAgent,
];
