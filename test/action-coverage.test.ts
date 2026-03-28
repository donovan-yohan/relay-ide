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

// Phase 2 allowlist: 15 HIGH-priority action IDs
const PHASE2_ALLOWLIST = [
  'session.new-agent',
  'session.new-terminal',
  'session.close-active',
  'session.kill',
  'session.start-on-repo',
  'session.start-on-ticket',
  'workspace.add',
  'workspace.new-worktree',
  'pr.create',
  'pr.push-branch',
  'pr.switch-branch',
  'settings.open',
  'settings.connect-github',
  'settings.toggle-yolo',
  'settings.check-updates',
] as const;

const ALL_META: ActionMeta[] = [
  ...sessionActions,
  ...workspaceActions,
  ...prActions,
  ...settingsActions,
];

function toAction(meta: ActionMeta): Action {
  return { ...meta, handler: () => {} };
}

describe('Action Coverage', () => {
  beforeEach(() => {
    _resetForTesting();
  });

  it('all Phase 2 allowlist IDs have corresponding definitions', () => {
    const definedIds = new Set(ALL_META.map(a => a.id));
    const missing = PHASE2_ALLOWLIST.filter(id => !definedIds.has(id));
    assert.deepStrictEqual(missing, [], `Missing action definitions: ${missing.join(', ')}`);
  });

  it('all defined actions are in the Phase 2 allowlist', () => {
    const allowedIds = new Set<string>(PHASE2_ALLOWLIST);
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
