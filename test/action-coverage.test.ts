import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  registerGlobal,
  getAllActions,
  _resetForTesting,
} from '../frontend/src/lib/actions/registry.js';
import type { Action, ActionMeta } from '../frontend/src/lib/actions/types.js';
import { sessionActions } from '../frontend/src/lib/actions/definitions/session.js';
import { workspaceActions } from '../frontend/src/lib/actions/definitions/workspace.js';
import { prActions } from '../frontend/src/lib/actions/definitions/pr.js';
import { settingsActions } from '../frontend/src/lib/actions/definitions/settings.js';
import { sidebarActions } from '../frontend/src/lib/actions/definitions/sidebar.js';
import { dashboardActions } from '../frontend/src/lib/actions/definitions/dashboard.js';
import { terminalActions } from '../frontend/src/lib/actions/definitions/terminal.js';
import { navigationActions } from '../frontend/src/lib/actions/definitions/navigation.js';

// Full allowlist: 60 palettable action IDs (15 Phase 2 + 45 Phase 3)
const ACTION_ALLOWLIST = [
  // Session (9)
  'session.new-agent',
  'session.new-terminal',
  'session.close-active',
  'session.kill',
  'session.start-on-repo',
  'session.start-on-ticket',
  'session.customize',
  'session.switch-to-tab',
  'session.rename',
  // Workspace (2)
  'workspace.add',
  'workspace.new-worktree',
  // PR (11)
  'pr.create',
  'pr.push-branch',
  'pr.switch-branch',
  'pr.fix-conflicts',
  'pr.archive-branch',
  'pr.rename-branch',
  'pr.copy-branch-name',
  'pr.open-external',
  'pr.refresh',
  'pr.change-target',
  'pr.skip-checks',
  // Settings (16)
  'settings.open',
  'settings.connect-github',
  'settings.toggle-yolo',
  'settings.check-updates',
  'settings.disconnect-github',
  'settings.setup-webhooks',
  'settings.remove-webhook',
  'settings.test-webhook',
  'settings.connect-jira',
  'settings.disconnect-jira',
  'settings.toggle-devtools',
  'settings.clear-analytics',
  'settings.toggle-continue',
  'settings.toggle-tmux',
  'settings.toggle-notifications',
  'settings.change-default-agent',
  // Sidebar (7)
  'sidebar.collapse',
  'sidebar.navigate-dashboard',
  'sidebar.workspace-settings',
  'sidebar.rename-session',
  'sidebar.delete-worktree',
  'sidebar.resume-session',
  'sidebar.resume-yolo',
  // Dashboard (3)
  'dashboard.open-pr-session',
  'dashboard.sort-prs',
  'dashboard.clear-filters',
  // Org (5)
  'org.switch-tab',
  'org.save-filter',
  'org.delete-filter',
  'org.toggle-pr-status',
  'org.navigate-to-workspace',
  // Ticket (2)
  'ticket.switch-provider',
  'ticket.open-external',
  // Terminal (2)
  'terminal.scroll-top',
  'terminal.scroll-bottom',
  // Navigation (3)
  'navigation.previous-tab',
  'navigation.next-tab',
  'navigation.switch-to-tab',
] as const;

const ALL_META: ActionMeta[] = [
  ...sessionActions,
  ...workspaceActions,
  ...prActions,
  ...settingsActions,
  ...sidebarActions,
  ...dashboardActions,
  ...terminalActions,
  ...navigationActions,
];

function toAction(meta: ActionMeta): Action {
  return { ...meta, handler: () => {} };
}

describe('Action Coverage', () => {
  beforeEach(() => {
    _resetForTesting();
  });

  it('all allowlist IDs have corresponding definitions', () => {
    const definedIds = new Set(ALL_META.map(a => a.id));
    const missing = ACTION_ALLOWLIST.filter(id => !definedIds.has(id));
    assert.deepStrictEqual(missing, [], `Missing action definitions: ${missing.join(', ')}`);
  });

  it('all defined actions are in the allowlist', () => {
    const allowedIds = new Set<string>(ACTION_ALLOWLIST);
    const extra = ALL_META.filter(a => !allowedIds.has(a.id)).map(a => a.id);
    assert.deepStrictEqual(extra, [], `Defined actions not in allowlist: ${extra.join(', ')}`);
  });

  it('all registered action IDs are unique', () => {
    registerGlobal(ALL_META.map(toAction));
    const all = getAllActions();
    const ids = all.map((a: Action) => a.id);
    const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
    assert.deepStrictEqual(dupes, [], `Duplicate action IDs: ${dupes.join(', ')}`);
  });

  it('all required Action fields are present and well-formed', () => {
    for (const meta of ALL_META) {
      assert.ok(meta.id, `Action missing id`);
      assert.ok(meta.id.includes('.'), `Action id "${meta.id}" must use category.verb-noun format`);
      assert.ok(meta.label, `Action "${meta.id}" missing label`);
      assert.ok(meta.category, `Action "${meta.id}" missing category`);
      assert.strictEqual(meta.label, meta.label.toLowerCase(), `Action "${meta.id}" label must be lowercase`);
    }
  });

  it('no conflicting keyboard shortcuts', () => {
    const shortcuts = ALL_META
      .filter((a: ActionMeta) => a.shortcut)
      .map((a: ActionMeta) => ({ id: a.id, key: a.shortcut!.key }));
    const seen = new Map<string, string>();
    for (const { id, key } of shortcuts) {
      if (seen.has(key)) {
        assert.fail(`Shortcut conflict: "${key}" claimed by both "${seen.get(key)}" and "${id}"`);
      }
      seen.set(key, id);
    }
  });
});
