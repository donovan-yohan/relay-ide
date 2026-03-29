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

export const settingsActions: ActionMeta[] = [
  settingsOpen,
  settingsConnectGithub,
  settingsToggleYolo,
  settingsCheckUpdates,
];
