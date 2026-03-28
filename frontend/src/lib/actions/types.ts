export type ActionCategory = 'session' | 'workspace' | 'pr' | 'settings';

export type ActionContext = {
  view: 'workspace' | 'session' | 'dashboard' | 'settings' | 'org';
  workspacePath?: string;
  sessionId?: string;
  agentRunning?: boolean;
  isMobile?: boolean;
  // TODO Phase 4: populate prState from workspace PR data
  prState?: 'none' | 'draft' | 'open' | 'merged' | 'closed';
};

export type Action = {
  id: `${ActionCategory}.${string}`;
  label: string;
  description?: string;
  aliases?: string[];
  category: ActionCategory;
  icon?: string;
  shortcut?: { key: string; global?: boolean };
  when?: (ctx: ActionContext) => boolean;
  handler: (ctx: ActionContext) => void | Promise<void>;
  mobile?: { showInSheet?: boolean; label?: string };
};

export type ActionMeta = Omit<Action, 'handler'>;
