import type { RelayActionDescriptor } from '../../../../shared/action-descriptor.js';

export type ActionCategory =
  | 'session'
  | 'workspace'
  | 'pr'
  | 'settings'
  | 'sidebar'
  | 'terminal'
  | 'navigation'
  | 'dashboard'
  | 'org'
  | 'ticket'
  | 'gateway';

export type ActionContext = {
  view: 'workspace' | 'session' | 'dashboard' | 'settings' | 'org';
  workspacePath?: string;
  cwd?: string;
  sessionId?: string;
  agentRunning?: boolean;
  isMobile?: boolean;
  // TODO Phase 4: populate prState from workspace PR data
  prState?: 'none' | 'draft' | 'open' | 'merged' | 'closed';
  /**
   * Whether File RPC is available on the active node. `undefined` = unknown
   * (no manifest data yet or pre-#651 node). `false` = explicitly unavailable.
   * Used by command predicate `when` fns to disable file-related commands when
   * the node's helper is degraded for file-rpc (#654).
   */
  activeNodeFileRpcAvailable?: boolean;
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
  /**
   * Returns a human-readable reason why this action is disabled in the current
   * context. If the action is not disabled, return `undefined`. The command
   * palette renders this as a tooltip on the disabled item and greys it out.
   *
   * Evaluated only when `when` returns `false` or is absent and the action
   * would otherwise be hidden. Providing a `disabledReason` keeps the command
   * visible (but inert) so the user knows the feature exists and why it's gated.
   */
  disabledReason?: (ctx: ActionContext) => string | undefined;
  handler: (ctx: ActionContext) => void | Promise<void>;
  mobile?: { showInSheet?: boolean; label?: string };
  /**
   * Optional shared descriptor bridge. Stable CLI/API/agent commands attach the
   * Relay-owned contract descriptor; UI-only helpers may be projected with
   * actionDescriptorFromMeta without becoming stable agent commands.
   */
  descriptor?: RelayActionDescriptor;
};

export type ActionMeta = Omit<Action, 'handler'>;
