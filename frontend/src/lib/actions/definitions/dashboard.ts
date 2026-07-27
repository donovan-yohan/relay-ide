import type { ActionMeta } from '../types.js';

export const dashboardOpenPrSession: ActionMeta = {
  id: 'dashboard.open-pr-session',
  label: 'open pr chat',
  description: 'open the pull request in an agent chat',
  category: 'dashboard',
  icon: '+',
  when: (ctx) => !!ctx.workspacePath,
};

export const dashboardSortPrs: ActionMeta = {
  id: 'dashboard.sort-prs',
  label: 'sort pr table',
  description: 'change sort order for pull requests',
  category: 'dashboard',
  icon: '↕',
  when: (ctx) => !!ctx.workspacePath,
};

export const dashboardClearFilters: ActionMeta = {
  id: 'dashboard.clear-filters',
  label: 'clear filters',
  description: 'reset all active filters',
  category: 'dashboard',
  icon: '×',
};

export const orgSwitchTab: ActionMeta = {
  id: 'org.switch-tab',
  label: 'switch prs/tickets tab',
  description: 'toggle between prs and tickets view',
  category: 'org',
  icon: '⇄',
};

export const orgSaveFilter: ActionMeta = {
  id: 'org.save-filter',
  label: 'save filter preset',
  description: 'save current filter configuration',
  category: 'org',
  icon: '+',
};

export const orgDeleteFilter: ActionMeta = {
  id: 'org.delete-filter',
  label: 'delete filter preset',
  description: 'remove a saved filter',
  category: 'org',
  icon: '×',
};

export const orgTogglePrStatus: ActionMeta = {
  id: 'org.toggle-pr-status',
  label: 'toggle pr status filter',
  description: 'show or hide prs by status',
  category: 'org',
  icon: '●',
};

export const orgNavigateToWorkspace: ActionMeta = {
  id: 'org.navigate-to-workspace',
  label: 'open workspace from pr',
  description: 'navigate to the workspace for a pull request',
  category: 'org',
  icon: '→',
};

export const ticketSwitchProvider: ActionMeta = {
  id: 'ticket.switch-provider',
  label: 'switch github/jira tab',
  description: 'toggle between github and jira tickets',
  category: 'ticket',
  icon: '⇄',
};

export const ticketOpenExternal: ActionMeta = {
  id: 'ticket.open-external',
  label: 'open ticket externally',
  description: 'view ticket in browser',
  category: 'ticket',
  icon: '⇗',
};

export const dashboardActions: ActionMeta[] = [
  dashboardOpenPrSession,
  dashboardSortPrs,
  dashboardClearFilters,
  orgSwitchTab,
  orgSaveFilter,
  orgDeleteFilter,
  orgTogglePrStatus,
  orgNavigateToWorkspace,
  ticketSwitchProvider,
  ticketOpenExternal,
];
