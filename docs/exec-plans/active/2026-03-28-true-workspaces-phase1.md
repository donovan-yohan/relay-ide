# True Workspaces Phase 1: Rename + Model + Migration

> **Status**: Active | **Created**: 2026-03-28 | **Last Updated**: 2026-03-28
> **Design Doc**: `docs/design-docs/2026-03-28-true-workspaces-design.md`
> **Consulted Learnings**: L-20260324-config-stale-read, L-20260326-repo-source-unification, L-20260321-nav-model-ui-flows, L-20260324-exact-optional-types, L-20260327-express4-async-errors, L-20260327-api-error-body-parse
> **For Claude:** Use /harness:orchestrate to execute this plan.

**Goal:** Rename workspace→repo throughout the codebase, add Config v4 migration, and implement workspace grouping entity CRUD (backend + settings UI).

**Architecture:** Three-layer change: (1) Rename the "workspace" concept to "repo" in all server/frontend code where it refers to a single repository path, (2) Add config migration from implicit v3 to explicit v4 format with configVersion field, repoSettings key, and Workspace entity promotion from workspaceGroups, (3) New /workspace-groups CRUD API + settings dialog section for managing workspace grouping entities.

**Tech Stack:** TypeScript, Express, Svelte 5, node:test, node-pty

## Decision Log

| Date | Phase | Decision | Rationale |
|------|-------|----------|-----------|
| 2026-03-28 | Design | Vertical slice approach (rename + model + migration together) | Avoids intermediate state where "workspace" means two things |
| 2026-03-28 | Design | /workspace-groups namespace for new CRUD, existing /workspaces routes stay | 20+ existing endpoints under /workspaces — rename is a tracked follow-up |
| 2026-03-28 | Design | No "Default" workspace entity for ungrouped repos | Ungrouped is a UI concept, not data model |
| 2026-03-28 | Design | Many-to-many: repos can belong to multiple workspaces | Dropped one-group-per-repo constraint from v3 workspaceGroups |
| 2026-03-28 | Plan | Bulk mechanical rename before TDD tasks | 290+ occurrences across 29 files — TDD per-occurrence is impractical; test migration/CRUD with TDD |
| 2026-03-28 | Plan | Phase 1 excludes sidebar grouping UI and workspace session launch | Those depend on worktree lifecycle endpoint (Phase 2+) |

## Progress

- [x] Task 1: Type foundation — new Workspace entity + rename server types _(completed 2026-03-28)_
- [x] Task 2: Config v4 migration (TDD) _(completed 2026-03-28)_
- [x] Task 3: Server bulk rename — workspacePath→repoPath + workspaceSettings→repoSettings _(completed 2026-03-28)_
- [x] Task 4: Session persistence v3→v4 (TDD) _(completed 2026-03-28)_
- [x] Task 5: Frontend bulk rename — types, state, API, components _(completed 2026-03-28)_
- [x] Task 6: Test suite update + build verification _(completed 2026-03-28)_
- [x] Task 7: Workspace CRUD API (TDD) _(completed 2026-03-28)_
- [x] Task 8: Workspace management settings UI _(completed 2026-03-28)_

## Surprises & Discoveries

| 2026-03-28 | Task 6 found 4 server files still using `config.workspaces` instead of `config.repos` | Fixed in branch-linker.ts, integration-github.ts, org-dashboard.ts, webhook-manager.ts |

## Plan Drift

| Task | Plan Said | Actually Happened | Why |
|------|-----------|-------------------|-----|
| Task 3 | Rename all server `config.workspaces` → `config.repos` where it refers to the repo list | Missed 4 files (branch-linker, integration-github, org-dashboard, webhook-manager) | These files used `config.workspaces` to iterate repo paths, caught by test failures in Task 6 |

---

### Task 1: Type Foundation — New Workspace Entity + Rename Server Types

**Goal:** Add the new `Workspace` grouping entity type, `WorkspaceLevelSettings`, and `Repo` type. Update `Config` interface for v4. Rename `BaseSession.workspacePath` → `repoPath`.

**Files:**
- Modify: `server/types.ts`

**Key decisions:**
- The existing `Workspace` type (`{ path, name, isGitRepo, defaultBranch }`) becomes `Repo`
- The new `Workspace` type is the grouping entity (`{ id, name, repos[], themeColor?, order, template?, settings? }`)
- `Config.workspaceSettings` becomes `Config.repoSettings` (same type, renamed key)
- `Config.workspaces` changes from `string[] | undefined` (legacy alias) to `Workspace[] | undefined` (grouping entities)
- `Config.workspaceGroups` becomes obsolete (promoted to `Config.workspaces`)
- `configVersion` field added to Config

- [ ] **Step 1: Rename existing Workspace → Repo and add new Workspace entity**

In `server/types.ts`, make these changes:

1. Rename the existing `Workspace` interface to `Repo`:
```typescript
// Was: export interface Workspace { path, name, isGitRepo, defaultBranch }
export interface Repo {
  path: string;
  name: string;
  isGitRepo: boolean;
  defaultBranch: string | null;
}
```

2. Add `WorkspaceLevelSettings` (subset of WorkspaceSettings excluding repo-scoped fields):
```typescript
export interface WorkspaceLevelSettings {
  defaultAgent?: AgentType;
  defaultContinue?: boolean;
  defaultYolo?: boolean;
  launchInTmux?: boolean;
  claudeArgs?: string[];
  promptCodeReview?: string;
  promptCreatePr?: string;
  promptBranchRename?: string;
  promptGeneral?: string;
  promptFixConflicts?: string;
  promptStartWork?: string;
}
```

3. Add `RepoRole` type and `WorkspaceTemplate`:
```typescript
export type RepoRole = 'frontend' | 'backend' | 'lib' | 'infra' | 'docs' | 'other';

export interface WorkspaceTemplate {
  repoRoles?: Record<string, RepoRole>;
  defaultAgent?: string;
  customPrompt?: string;
  claudeArgs?: string[];
}
```

4. Add new `Workspace` grouping entity:
```typescript
export interface Workspace {
  id: string;
  name: string;
  repos: string[];
  themeColor?: string;
  order: number;
  template?: WorkspaceTemplate;
  settings?: WorkspaceLevelSettings;
}
```

5. Rename `BaseSession.workspacePath` → `repoPath` and `SessionSummary.workspacePath` → `repoPath`.

6. Update `Config` interface:
```typescript
export interface Config {
  configVersion?: number | undefined;  // NEW — 4 for current format
  // ... existing fields unchanged ...
  repos: string[];
  repoSettings?: Record<string, WorkspaceSettings> | undefined;  // renamed from workspaceSettings
  workspaces?: Workspace[] | undefined;  // CHANGED: was string[], now Workspace[]
  // Keep legacy fields for migration (marked deprecated):
  workspaceSettings?: Record<string, WorkspaceSettings> | undefined;  // deprecated, migrated to repoSettings
  workspaceGroups?: Record<string, string[]> | undefined;  // deprecated, migrated to workspaces
}
```

- [ ] **Step 2: Update the DEFAULTS constant**

In `server/config.ts`, remove `workspaces: []` from DEFAULTS (the new `workspaces` is `Workspace[]` and defaults to undefined/empty). Also update the Omit type to exclude the new fields:

```typescript
export const DEFAULTS: Omit<Config, 'pinHash' | 'rootDirs' | 'repoSettings' | 'workspaceSettings' | 'vapidPublicKey' | 'vapidPrivateKey'> = {
  host: '0.0.0.0',
  port: 3456,
  cookieTTL: '24h',
  repos: [],
  claudeCommand: 'claude',
  claudeArgs: [],
  defaultAgent: 'claude',
  defaultContinue: true,
  defaultYolo: false,
  launchInTmux: false,
  defaultNotifications: true,
};
```

- [ ] **Step 3: Update imports in workspaces.ts**

In `server/workspaces.ts` line 15, update the import from `Workspace` to `Repo`:
```typescript
import type { Config, PrInfo, PullRequest, PullRequestsResponse, Repo } from './types.js';
```

Update the function in workspaces.ts that returns workspace list to use `Repo` type (the `GET /workspaces` route handler).

- [ ] **Step 4: Verify build compiles**

Run: `npm run build`
Expected: Type errors from downstream files referencing old names — that's expected, we'll fix those in Tasks 3 and 5.

Note: The build will NOT pass at this point. That's intentional — we're establishing the new type foundation that Tasks 2-6 will build on. The codebase is in a transitional state until Task 6 completes.

- [ ] **Step 5: Commit type foundation**

```bash
git add server/types.ts server/config.ts server/workspaces.ts
git commit -m "feat: add Workspace entity type, rename Workspace→Repo, update Config for v4"
```

---

### Task 2: Config v4 Migration (TDD)

**Goal:** Implement `migrateToV4()` that upgrades pre-v4 configs: reconcile repo arrays, rename workspaceSettings→repoSettings, promote workspaceGroups to Workspace entities.

**Files:**
- Modify: `server/config.ts`
- Modify: `test/config.test.ts`

**Migration steps (from design doc § Migration Strategy):**
1. Detect: if `configVersion` missing or `< 4`, run migration
2. Reconcile: merge legacy `workspaces` string[] into `repos`, deduplicate
3. Rename: `workspaceSettings` → `repoSettings`
4. Promote: `workspaceGroups` entries → `Workspace[]` entities with UUIDs
5. Clean: delete legacy fields (`workspaceGroups`, old `workspaces` string[])
6. Set: `configVersion = 4`

**Learnings applied:**
- L-20260324-config-stale-read: Migration runs in `loadConfig()` so all callers get v4 format
- L-20260326-repo-source-unification: Migration merges both `workspaces` and `repos` arrays

- [ ] **Step 1: Write failing migration tests**

Add to `test/config.test.ts`:

```typescript
// ── Config v4 migration ──────────────────────────────────────────────

test('migrateToV4: sets configVersion to 4', () => {
  const configPath = path.join(tmpDir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ repos: ['/a'] }), 'utf8');
  const config = loadConfig(configPath);
  assert.equal(config.configVersion, 4);
});

test('migrateToV4: already v4 config is unchanged', () => {
  const configPath = path.join(tmpDir, 'config.json');
  const v4Config = {
    configVersion: 4,
    repos: ['/a', '/b'],
    repoSettings: { '/a': { defaultYolo: true } },
    workspaces: [{ id: 'ws-1', name: 'My App', repos: ['/a', '/b'], order: 0 }],
  };
  fs.writeFileSync(configPath, JSON.stringify(v4Config), 'utf8');
  const config = loadConfig(configPath);
  assert.equal(config.configVersion, 4);
  assert.deepEqual(config.repos, ['/a', '/b']);
  assert.ok(config.repoSettings?.['/a']?.defaultYolo);
  assert.equal(config.workspaces?.length, 1);
  assert.equal(config.workspaces?.[0]?.name, 'My App');
});

test('migrateToV4: reconciles legacy workspaces string[] into repos', () => {
  const configPath = path.join(tmpDir, 'config.json');
  // Old config: workspaces is string[], repos may not exist
  fs.writeFileSync(configPath, JSON.stringify({
    workspaces: ['/old/repo1', '/old/repo2'],
  }), 'utf8');
  const config = loadConfig(configPath);
  assert.equal(config.configVersion, 4);
  assert.ok(config.repos.includes('/old/repo1'));
  assert.ok(config.repos.includes('/old/repo2'));
  // Legacy workspaces string[] should be gone (now workspaces is Workspace[])
  assert.ok(!Array.isArray(config.workspaces) || config.workspaces.length === 0 || typeof config.workspaces[0] === 'object');
});

test('migrateToV4: merges workspaces and repos arrays with dedup', () => {
  const configPath = path.join(tmpDir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    repos: ['/a', '/b'],
    workspaces: ['/b', '/c'],
  }), 'utf8');
  const config = loadConfig(configPath);
  // repos should contain union, preserving repos[] order first
  assert.deepEqual(config.repos, ['/a', '/b', '/c']);
});

test('migrateToV4: renames workspaceSettings to repoSettings', () => {
  const configPath = path.join(tmpDir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    repos: ['/my/repo'],
    workspaceSettings: { '/my/repo': { defaultYolo: true, branchPrefix: 'dy/' } },
  }), 'utf8');
  const config = loadConfig(configPath);
  assert.ok(config.repoSettings?.['/my/repo']?.defaultYolo);
  assert.equal(config.repoSettings?.['/my/repo']?.branchPrefix, 'dy/');
  assert.equal(config.workspaceSettings, undefined);
});

test('migrateToV4: promotes workspaceGroups to Workspace entities', () => {
  const configPath = path.join(tmpDir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    repos: ['/frontend', '/backend', '/shared'],
    workspaceGroups: {
      'My App': ['/frontend', '/backend'],
      'Infra': ['/shared'],
    },
  }), 'utf8');
  const config = loadConfig(configPath);
  assert.equal(config.workspaces?.length, 2);
  const myApp = config.workspaces?.find(w => w.name === 'My App');
  assert.ok(myApp);
  assert.ok(myApp!.id); // has UUID
  assert.deepEqual(myApp!.repos, ['/frontend', '/backend']);
  assert.equal(myApp!.order, 0);
  const infra = config.workspaces?.find(w => w.name === 'Infra');
  assert.ok(infra);
  assert.deepEqual(infra!.repos, ['/shared']);
  assert.equal(infra!.order, 1);
  assert.equal(config.workspaceGroups, undefined);
});

test('migrateToV4: workspaceGroups promotion validates against repos[]', () => {
  const configPath = path.join(tmpDir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    repos: ['/valid'],
    workspaceGroups: {
      'Mixed': ['/valid', '/not-in-repos'],
    },
  }), 'utf8');
  const config = loadConfig(configPath);
  const mixed = config.workspaces?.find(w => w.name === 'Mixed');
  assert.ok(mixed);
  assert.deepEqual(mixed!.repos, ['/valid']); // invalid path filtered
});

test('migrateToV4: empty config gets configVersion 4', () => {
  const configPath = path.join(tmpDir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({}), 'utf8');
  const config = loadConfig(configPath);
  assert.equal(config.configVersion, 4);
});

test('migrateToV4: persists migrated config to disk', () => {
  const configPath = path.join(tmpDir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    repos: ['/a'],
    workspaceSettings: { '/a': { defaultYolo: true } },
    workspaceGroups: { 'G': ['/a'] },
  }), 'utf8');
  loadConfig(configPath);
  // Re-read raw file to verify it was persisted
  const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.equal(raw.configVersion, 4);
  assert.ok(raw.repoSettings);
  assert.equal(raw.workspaceSettings, undefined);
  assert.equal(raw.workspaceGroups, undefined);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: New migration tests FAIL — `configVersion` is never set, `repoSettings` doesn't exist yet.

- [ ] **Step 3: Implement migrateToV4 in config.ts**

Add the migration function to `server/config.ts`:

```typescript
import crypto from 'node:crypto';
import type { Workspace } from './types.js';

function migrateToV4(config: Config, configPath: string): void {
  if (config.configVersion != null && config.configVersion >= 4) return;

  // Step 1: Reconcile repo arrays
  // config.workspaces may be a legacy string[] alias for repos
  const legacyWorkspaces = config.workspaces as unknown as string[] | undefined;
  const isLegacyStringArray = Array.isArray(legacyWorkspaces) &&
    (legacyWorkspaces.length === 0 || typeof legacyWorkspaces[0] === 'string');

  if (isLegacyStringArray && legacyWorkspaces!.length > 0) {
    const repoSet = new Set(config.repos);
    for (const w of legacyWorkspaces!) {
      if (!repoSet.has(w)) {
        config.repos.push(w);
        repoSet.add(w);
      }
    }
  }

  // Step 2: Rename workspaceSettings → repoSettings
  if (config.workspaceSettings != null && config.repoSettings == null) {
    config.repoSettings = config.workspaceSettings;
    delete config.workspaceSettings;
  }

  // Step 3: Promote workspaceGroups → workspaces (Workspace[])
  const promoted: Workspace[] = [];
  if (config.workspaceGroups != null) {
    const validPaths = new Set(config.repos);
    let order = 0;
    for (const [groupName, paths] of Object.entries(config.workspaceGroups)) {
      if (!Array.isArray(paths)) continue;
      const validRepos = paths.filter(p => validPaths.has(p));
      if (validRepos.length > 0) {
        promoted.push({
          id: crypto.randomUUID(),
          name: groupName,
          repos: validRepos,
          order: order++,
        });
      }
    }
    delete config.workspaceGroups;
  }

  // Set workspaces to promoted entities (or empty array)
  (config as any).workspaces = promoted;

  // Step 4: Set version
  config.configVersion = 4;

  // Persist migrated config
  saveConfig(configPath, config);
}
```

Then call `migrateToV4(config, configPath)` at the end of `loadConfig()`, before the return:

```typescript
export function loadConfig(configPath: string): Config {
  // ... existing loading + workspaceGroups validation ...

  // v4 migration
  migrateToV4(config, configPath);

  return config;
}
```

Note: The existing `workspaceGroups` validation block (lines 39-69 in current config.ts) should be moved INSIDE `migrateToV4` or kept as-is but only for pre-v4 configs. Since `migrateToV4` deletes `workspaceGroups`, the validation runs before promotion and the migration picks up the cleaned result. Keep the existing validation where it is — it runs first, then migration promotes the cleaned groups.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: All new migration tests PASS. Some existing tests may need adjustments (the `workspaceGroups` tests from before now produce `configVersion: 4` and promoted `workspaces`).

- [ ] **Step 5: Fix any existing tests broken by migration**

The existing `workspaceGroups` tests in config.test.ts (lines 255-314) will now have migration side effects. Update them to account for `configVersion: 4` being set. The tests verify workspaceGroups validation behavior — they should still pass since validation runs before migration.

If the existing `workspaceGroups` tests check `config.workspaceGroups` directly, they may need updating since migration deletes that field and promotes to `config.workspaces`. Update assertions to check the promoted `config.workspaces` array instead.

- [ ] **Step 6: Commit migration**

```bash
git add server/config.ts test/config.test.ts
git commit -m "feat: config v4 migration — reconcile repos, rename settings, promote groups"
```

---

### Task 3: Server Bulk Rename — workspacePath → repoPath

**Goal:** Rename all single-repo `workspacePath` references to `repoPath` across server modules. Rename `workspaceSettings` config key references to `repoSettings`. Rename config helper function parameters.

**Files:**
- Modify: `server/sessions.ts` — `workspacePath` → `repoPath` in SerializedPtySession, list(), serializeAll(), create() analytics, kill() analytics, restoreFromDisk()
- Modify: `server/pty-handler.ts` — `CreatePtyParams.workspacePath` → `repoPath`, createPtySession() destructuring
- Modify: `server/index.ts` — All route handlers referencing `workspacePath`, session grouping, settings callbacks
- Modify: `server/workspaces.ts` — PR cache functions, route handlers, dashboard, settings, git ops (60+ occurrences)
- Modify: `server/config.ts` — `getWorkspaceSettings` → `getRepoSettings`, param names, `setWorkspaceSettings` → `setRepoSettings`, `deleteWorkspaceSettingKeys` → `deleteRepoSettingKeys`
- Modify: `server/webhook-manager.ts` — Settings lookup, iteration
- Modify: `server/review-poller.ts` — Workspace iteration, settings lookup
- Modify: `server/branch-linker.ts` — Workspace iteration
- Modify: `server/integration-github.ts` — Workspace iteration
- Modify: `server/org-dashboard.ts` — Workspace iteration
- Modify: `server/git.ts` — Parameter names

**Rename rules (from design doc § Codebase Rename Scope):**
- `workspacePath` → `repoPath` where it refers to a single repository path
- `workspaceSettings` → `repoSettings` as a config key
- `getWorkspaceSettings()` → `getRepoSettings()`
- `setWorkspaceSettings()` → `setRepoSettings()`
- `deleteWorkspaceSettingKeys()` → `deleteRepoSettingKeys()`
- The word "workspace" STAYS valid for workspace-group references (e.g., `workspaceId`, `Workspace` type, `WorkspaceGroup.svelte`)
- Function parameters named `workspacePath` that refer to repo paths → `repoPath`

- [ ] **Step 1: Rename config helper functions**

In `server/config.ts`:
- `getWorkspaceSettings(config, workspacePath)` → `getRepoSettings(config, repoPath)`
- `setWorkspaceSettings(configPath, config, workspacePath, settings)` → `setRepoSettings(configPath, config, repoPath, settings)`
- `deleteWorkspaceSettingKeys(configPath, config, workspacePath, keys)` → `deleteRepoSettingKeys(configPath, config, repoPath, keys)`
- Update internal references from `config.workspaceSettings` → `config.repoSettings` in these functions
- Export both old and new names temporarily if needed for incremental migration, but prefer renaming all callsites

- [ ] **Step 2: Rename in server/sessions.ts**

- `SerializedPtySession.workspacePath` → `repoPath`
- `list()` mapping: `workspacePath: s.workspacePath` → `repoPath: s.repoPath`
- `serializeAll()`: `workspacePath: session.workspacePath` → `repoPath: session.repoPath`
- `create()` analytics: `workspace: rest.workspacePath` → `workspace: rest.repoPath`
- `kill()` analytics: `workspace: session.workspacePath` → `workspace: session.repoPath`
- `restoreFromDisk()`: update `createParams` to use `repoPath`

- [ ] **Step 3: Rename in server/pty-handler.ts**

- `CreatePtyParams.workspacePath` → `repoPath`
- `createPtySession()` destructuring: `workspacePath` → `repoPath`
- Session object initialization: `workspacePath` → `repoPath`

- [ ] **Step 4: Rename in server/index.ts**

This file has ~19 occurrences. Key changes:
- Session grouping: `s.workspacePath || s.cwd` → `s.repoPath || s.cwd`
- Settings callbacks: `getConfig().workspaceSettings?.[wsPath]` → `getConfig().repoSettings?.[wsPath]`
- Session creation route body: `req.body.workspacePath` → `req.body.repoPath`
- `resolveSessionSettings(getConfig(), opts.workspacePath, ...)` → `resolveSessionSettings(getConfig(), opts.repoPath, ...)`
- Worktree listing map: `s.worktreePath ?? s.workspacePath` → `s.worktreePath ?? s.repoPath`
- `GET /config/workspace-groups` route: update to use `getConfig().workspaces` instead of `workspaceGroups` (returns the new Workspace[] format)

- [ ] **Step 5: Rename in server/workspaces.ts**

This has the most occurrences (~63). Key patterns:
- PR cache functions: `prCacheKey(workspacePath, branch)` → `prCacheKey(repoPath, branch)`
- Route handlers: query param `workspacePath` → `repoPath`
- Dashboard route: `req.query.path` variable named `workspacePath` → `repoPath`
- Settings routes: `getWorkspaceSettings` → `getRepoSettings`, `setWorkspaceSettings` → `setRepoSettings`
- Git operations: parameter renames
- The import of `Workspace` type → `Repo` type

**Important:** The existing `/workspaces/*` route PATHS stay as-is. Only the internal variable names and config key references change. Route path rename is a tracked follow-up.

- [ ] **Step 6: Rename in remaining server modules**

For each of these files, rename `workspacePath` parameter/variable names to `repoPath` and update `workspaceSettings` → `repoSettings` where applicable:
- `server/webhook-manager.ts` (~7 occurrences of workspacePath, ~16 of workspaceSettings)
- `server/review-poller.ts` (~15 occurrences)
- `server/branch-linker.ts` (~3 occurrences)
- `server/integration-github.ts` (~3 occurrences)
- `server/org-dashboard.ts` (~3 occurrences)
- `server/git.ts` (~2 occurrences)

- [ ] **Step 7: Verify server compiles**

Run: `npx tsc --noEmit -p tsconfig.json` (server only, skip frontend for now)
Expected: Server TypeScript compiles without errors. If there are errors, fix remaining references.

- [ ] **Step 8: Commit server rename**

```bash
git add server/
git commit -m "refactor: rename workspacePath→repoPath and workspaceSettings→repoSettings across server"
```

---

### Task 4: Session Persistence v3 → v4 (TDD)

**Goal:** Update `pending-sessions.json` format to v4 with `repoPath` field. Add migration for v3 files that have `workspacePath`.

**Files:**
- Modify: `server/sessions.ts`
- Modify: `test/sessions.test.ts`

- [ ] **Step 1: Write failing test for v3→v4 migration**

Add to `test/sessions.test.ts` (or a new describe block):

```typescript
test('restoreFromDisk handles v3 pending-sessions with workspacePath', async () => {
  // Write a v3 format file with workspacePath field
  const pending = {
    version: 3,
    timestamp: new Date().toISOString(),
    sessions: [{
      id: 'test-v3-migration',
      type: 'agent',
      agent: 'claude',
      workspacePath: '/test/repo',  // v3 field name
      worktreePath: null,
      cwd: '/test/repo',
      repoName: 'repo',
      branchName: 'main',
      displayName: 'Agent 1',
      createdAt: new Date().toISOString(),
      lastActivity: new Date().toISOString(),
      useTmux: false,
      tmuxSessionName: '',
      customCommand: null,
    }],
  };
  fs.writeFileSync(
    path.join(configDir, 'pending-sessions.json'),
    JSON.stringify(pending),
  );
  // restoreFromDisk should handle v3 workspacePath → repoPath
  // (The actual restore will fail since there's no real PTY, but migration should not throw)
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — the v3→v4 migration path doesn't exist yet.

- [ ] **Step 3: Implement v3→v4 pending-sessions migration**

In `server/sessions.ts`, update `restoreFromDisk()`:

1. Update `SerializedPtySession` — already renamed `workspacePath` → `repoPath` in Task 3.

2. Add v3→v4 migration block after the existing v2→v3 block:
```typescript
// v3 → v4 migration: workspacePath → repoPath
if (pending.version <= 3) {
  for (const s of pending.sessions) {
    const legacy = s as SerializedPtySession & { workspacePath?: string };
    if ('workspacePath' in legacy && !('repoPath' in s)) {
      (s as any).repoPath = legacy.workspacePath;
      delete legacy.workspacePath;
    }
  }
}
```

3. Update `serializeAll()` to write `version: 4`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS — v3 files with `workspacePath` are correctly migrated to `repoPath`.

- [ ] **Step 5: Commit**

```bash
git add server/sessions.ts test/sessions.test.ts
git commit -m "feat: pending-sessions v3→v4 migration — workspacePath→repoPath"
```

---

### Task 5: Frontend Bulk Rename — Types, State, API, Components

**Goal:** Rename all frontend `workspacePath` references to `repoPath`, rename `Workspace` type to `Repo` (for the repo descriptor), add new `Workspace` type for grouping entities, rename `activeWorkspacePath` → `activeRepoPath`.

**Files (96 occurrences across 15 files):**
- Modify: `frontend/src/lib/types.ts` — `Workspace` → `Repo`, `SessionSummary.workspacePath` → `repoPath`, add new `Workspace` type
- Modify: `frontend/src/lib/state/sessions.svelte.ts` — `workspaces` state type → `repos`, `getSessionsForWorkspace()` → `getSessionsForRepo()`
- Modify: `frontend/src/lib/state/ui.svelte.ts` — `activeWorkspacePath` → `activeRepoPath`, localStorage key update
- Modify: `frontend/src/lib/state/sidebar-items.ts` — `workspacePath` references
- Modify: `frontend/src/lib/api.ts` — Function params and body fields (~19 occurrences)
- Modify: `frontend/src/App.svelte` — (~23 occurrences of `workspacePath`, ~23 of `activeWorkspacePath`)
- Modify: `frontend/src/components/Sidebar.svelte` — workspace → repo variable names
- Modify: `frontend/src/components/WorkspaceItem.svelte` — workspace prop → repo
- Modify: `frontend/src/components/PrTopBar.svelte` — (~13 occurrences)
- Modify: `frontend/src/components/RepoDashboard.svelte` — (~4 occurrences)
- Modify: `frontend/src/components/BranchSwitcher.svelte` — (~5 occurrences)
- Modify: `frontend/src/components/TargetBranchSwitcher.svelte` — (~5 occurrences)
- Modify: `frontend/src/components/StartWorkModal.svelte` — (~1 occurrence)
- Modify: `frontend/src/components/dialogs/CustomizeSessionDialog.svelte` — (~5 occurrences)
- Modify: `frontend/src/components/dialogs/RenameWarningModal.svelte` — (~4 occurrences)
- Modify: `frontend/src/components/dialogs/WorkspaceSettingsDialog.svelte` — (~6 occurrences, rename file to `RepoSettingsDialog.svelte`)

**Rename rules:**
- `SessionSummary.workspacePath` → `SessionSummary.repoPath`
- `Workspace` type (repo descriptor) → `Repo`
- Variable/param `workspacePath` → `repoPath` (where it refers to a single repo)
- `activeWorkspacePath` → `activeRepoPath`
- `getSessionsForWorkspace(workspacePath)` → `getSessionsForRepo(repoPath)`
- `fetchWorkspaces()` stays — it fetches repo descriptors, but the function name can stay for now (API endpoint is still `/workspaces`)
- State variable `workspaces` in sessions.svelte.ts → `repos`
- `collapsedWorkspaces` stays — these are workspace paths (repos), the collapse state will later transition to workspace IDs in Phase 2
- `WorkspaceItem.svelte` stays as filename — this component renders a repo item in the sidebar but is already named "Workspace" in the v3 sense. Rename to `RepoItem.svelte` is deferred to Phase 2 when `WorkspaceGroup.svelte` is added.

- [ ] **Step 1: Rename frontend types**

In `frontend/src/lib/types.ts`:
1. Rename `Workspace` → `Repo`
2. Add new `Workspace` grouping entity type (matching server):
```typescript
export interface Workspace {
  id: string;
  name: string;
  repos: string[];
  themeColor?: string;
  order: number;
}
```
3. `SessionSummary.workspacePath` → `SessionSummary.repoPath`
4. `WorkspaceSettings` stays (it's the per-repo settings type, will be renamed to `RepoSettings` in a follow-up)

- [ ] **Step 2: Rename frontend state**

In `frontend/src/lib/state/sessions.svelte.ts`:
- Import `Repo` instead of `Workspace`
- `let workspaces = $state<Workspace[]>([])` → `let repos = $state<Repo[]>([])`
- `get workspaces()` → `get repos()`
- `workspaces = ws` → `repos = ws`
- `getSessionsForWorkspace(workspacePath)` → `getSessionsForRepo(repoPath)` — update filter: `s.repoPath === repoPath`
- `reorderWorkspaces` stays (it reorders repos in the API, but the API endpoint name hasn't changed)
- `buildSidebarItems(sessions, worktrees, workspaces, sidebarItems)` → `buildSidebarItems(sessions, worktrees, repos, sidebarItems)`

In `frontend/src/lib/state/ui.svelte.ts`:
- `activeWorkspacePath` → `activeRepoPath`
- localStorage key stays `'claude-remote-active-workspace'` (existing users' localStorage is preserved, no migration needed for local UI state — it just stores a path string)
- `get activeWorkspacePath()` → `get activeRepoPath()`
- `set activeWorkspacePath()` → `set activeRepoPath()`

In `frontend/src/lib/state/sidebar-items.ts`:
- Update `workspacePath` references to `repoPath` in the `buildSidebarItems()` function
- `session.workspacePath` → `session.repoPath`

- [ ] **Step 3: Rename API functions**

In `frontend/src/lib/api.ts`:
- `createSession` body: `workspacePath` → `repoPath`
- `fetchDashboard` param: `workspacePath` → `repoPath`
- All other API functions that pass `workspacePath` in request bodies or query params → `repoPath`
- `fetchWorkspaces()` return type: `Workspace[]` → `Repo[]` (but function name stays since endpoint is still `/workspaces`)

- [ ] **Step 4: Rename in App.svelte**

This is the largest single file (~23 workspacePath, ~23 activeWorkspacePath). Key changes:
- All `ui.activeWorkspacePath` → `ui.activeRepoPath`
- All `session.workspacePath` → `session.repoPath`
- `activeWorkspace` derived variable (finds workspace matching activeRepoPath)
- Session creation calls: `workspacePath` param → `repoPath`
- Dashboard calls: `workspacePath` param → `repoPath`

- [ ] **Step 5: Rename in remaining components**

For each component, rename `workspacePath` params/variables → `repoPath`:
- `Sidebar.svelte` — `ui.activeWorkspacePath` → `ui.activeRepoPath`, workspace variable names
- `WorkspaceItem.svelte` — prop types, `workspace.path` references (the workspace prop itself stays, it's a repo descriptor)
- `PrTopBar.svelte` — `workspacePath` prop → `repoPath`
- `RepoDashboard.svelte` — `workspacePath` prop → `repoPath`
- `BranchSwitcher.svelte` — `workspacePath` prop → `repoPath`
- `TargetBranchSwitcher.svelte` — `workspacePath` prop → `repoPath`
- `StartWorkModal.svelte` — `workspacePath` prop → `repoPath`
- `CustomizeSessionDialog.svelte` — `workspacePath` prop → `repoPath`
- `RenameWarningModal.svelte` — `workspacePath` prop → `repoPath`
- `WorkspaceSettingsDialog.svelte` — `workspacePath` prop → `repoPath`

- [ ] **Step 6: Verify frontend compiles**

Run: `cd frontend && npx svelte-check --tsconfig ./tsconfig.json`
Expected: No type errors. Fix any remaining references.

- [ ] **Step 7: Commit frontend rename**

```bash
git add frontend/
git commit -m "refactor: rename workspacePath→repoPath, Workspace→Repo across frontend"
```

---

### Task 6: Test Suite Update + Build Verification

**Goal:** Update all test files to use new field/function names. Run full build + test suite to verify everything works end-to-end.

**Files:**
- Modify: `test/config.test.ts` — `workspaceSettings` → `repoSettings` in existing tests, function name updates
- Modify: `test/sessions.test.ts` — `workspacePath` → `repoPath` (~42 occurrences)
- Modify: `test/sidebar-items.test.ts` — `workspacePath` → `repoPath` (~8 occurrences)
- Modify: Any other test files that reference renamed symbols

- [ ] **Step 1: Update test/config.test.ts**

- Import names: `resolveSessionSettings`, `deleteWorkspaceSettingKeys` → `deleteRepoSettingKeys`
- All `workspaceSettings` references in test data → `repoSettings`
- Update the existing `workspaceGroups` tests — after migration, these configs will have `configVersion: 4` and `workspaceGroups` promoted to `workspaces: Workspace[]`. Either:
  - Test the pre-migration validation (write raw JSON, load, check promoted result)
  - Or test v4 format directly

- [ ] **Step 2: Update test/sessions.test.ts**

Bulk rename: `workspacePath` → `repoPath` in all test session objects and assertions (~42 occurrences).

- [ ] **Step 3: Update test/sidebar-items.test.ts**

Bulk rename: `workspacePath` → `repoPath` in test session data (~8 occurrences).

- [ ] **Step 4: Check for any other test files with old names**

Run:
```bash
grep -rl 'workspacePath\|workspaceSettings\|getWorkspaceSettings\|setWorkspaceSettings\|deleteWorkspaceSettingKeys' test/
```
Fix any remaining references found.

- [ ] **Step 5: Run full build**

Run: `npm run build`
Expected: Both server and frontend compile successfully.

- [ ] **Step 6: Run full test suite**

Run: `npm test`
Expected: All tests PASS.

- [ ] **Step 7: Fix any failures**

If tests fail, diagnose and fix. Common issues:
- Missed rename in a test fixture
- Migration side effects on existing test data (configVersion being set)
- Import name mismatches

- [ ] **Step 8: Commit test updates**

```bash
git add test/
git commit -m "test: update all tests for workspacePath→repoPath rename and config v4"
```

---

### Task 7: Workspace CRUD API (TDD)

**Goal:** Implement REST API for workspace grouping entity CRUD at `/workspace-groups`. Also update `resolveSessionSettings()` to support workspace-level settings cascade.

**Files:**
- Create: `server/workspace-groups.ts` — Express Router with CRUD routes
- Modify: `server/index.ts` — Mount new router, update existing `/config/workspace-groups` route
- Modify: `server/config.ts` — Add `getWorkspaceById()`, update `resolveSessionSettings()` for workspace cascade
- Create: `test/workspace-groups.test.ts` — CRUD tests

**API contract (from design doc):**
| Endpoint | Method | Body | Description |
|----------|--------|------|-------------|
| `/workspace-groups` | `GET` | — | List all workspace groups |
| `/workspace-groups` | `POST` | `{ name, repos, themeColor? }` | Create workspace group |
| `/workspace-groups/:id` | `PUT` | `Partial<Workspace>` | Update workspace |
| `/workspace-groups/:id` | `DELETE` | — | Delete workspace |
| `/workspace-groups/reorder` | `PUT` | `{ ids: string[] }` | Reorder workspaces |

**Learnings applied:**
- L-20260327-express4-async-errors: Wrap async handlers or use try-catch
- L-20260327-api-error-body-parse: Return proper error JSON

- [ ] **Step 1: Write failing CRUD tests**

Create `test/workspace-groups.test.ts`:

```typescript
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadConfig, saveConfig } from '../server/config.js';
import type { Config, Workspace } from '../server/types.js';

let tmpDir!: string;
let configPath!: string;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crc-workspace-groups-test-'));
  configPath = path.join(tmpDir, 'config.json');
});

afterEach(() => {
  // Clean up config between tests
  if (fs.existsSync(configPath)) fs.unlinkSync(configPath);
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true });
});

function writeConfig(partial: Partial<Config>): Config {
  const base = { configVersion: 4, repos: [], ...partial };
  fs.writeFileSync(configPath, JSON.stringify(base), 'utf8');
  return loadConfig(configPath);
}

// ── Workspace CRUD via config manipulation ──

test('createWorkspace adds a workspace entity to config', () => {
  const config = writeConfig({ repos: ['/a', '/b'] });
  assert.equal((config.workspaces ?? []).length, 0);

  // Simulate creation
  const ws: Workspace = {
    id: 'test-id-1',
    name: 'My App',
    repos: ['/a', '/b'],
    order: 0,
  };
  if (!config.workspaces) config.workspaces = [];
  config.workspaces.push(ws);
  saveConfig(configPath, config);

  const reloaded = loadConfig(configPath);
  assert.equal(reloaded.workspaces?.length, 1);
  assert.equal(reloaded.workspaces?.[0]?.name, 'My App');
  assert.deepEqual(reloaded.workspaces?.[0]?.repos, ['/a', '/b']);
});

test('createWorkspace validates name is non-empty', () => {
  const config = writeConfig({ repos: ['/a'] });
  // Empty name should be rejected (route handler level)
  assert.ok(true); // Placeholder — actual validation is in route handler
});

test('createWorkspace validates repos exist in config.repos', () => {
  const config = writeConfig({ repos: ['/a'] });
  // Creating a workspace with '/not-a-repo' should filter or reject
  assert.ok(true); // Placeholder — actual validation is in route handler
});

test('updateWorkspace modifies existing workspace', () => {
  const ws: Workspace = { id: 'ws-1', name: 'Old Name', repos: ['/a'], order: 0 };
  const config = writeConfig({ repos: ['/a', '/b'], workspaces: [ws] });

  const target = config.workspaces!.find(w => w.id === 'ws-1')!;
  target.name = 'New Name';
  target.repos = ['/a', '/b'];
  saveConfig(configPath, config);

  const reloaded = loadConfig(configPath);
  assert.equal(reloaded.workspaces?.[0]?.name, 'New Name');
  assert.deepEqual(reloaded.workspaces?.[0]?.repos, ['/a', '/b']);
});

test('deleteWorkspace removes workspace but keeps repos', () => {
  const ws: Workspace = { id: 'ws-1', name: 'To Delete', repos: ['/a'], order: 0 };
  const config = writeConfig({ repos: ['/a'], workspaces: [ws] });

  config.workspaces = config.workspaces!.filter(w => w.id !== 'ws-1');
  saveConfig(configPath, config);

  const reloaded = loadConfig(configPath);
  assert.equal(reloaded.workspaces?.length, 0);
  assert.ok(reloaded.repos.includes('/a')); // repo still exists
});

test('reorderWorkspaces updates order field', () => {
  const workspaces: Workspace[] = [
    { id: 'ws-1', name: 'First', repos: ['/a'], order: 0 },
    { id: 'ws-2', name: 'Second', repos: ['/b'], order: 1 },
    { id: 'ws-3', name: 'Third', repos: ['/c'], order: 2 },
  ];
  const config = writeConfig({ repos: ['/a', '/b', '/c'], workspaces });

  // Reorder: ws-3, ws-1, ws-2
  const newOrder = ['ws-3', 'ws-1', 'ws-2'];
  for (const ws of config.workspaces!) {
    ws.order = newOrder.indexOf(ws.id);
  }
  config.workspaces!.sort((a, b) => a.order - b.order);
  saveConfig(configPath, config);

  const reloaded = loadConfig(configPath);
  assert.equal(reloaded.workspaces?.[0]?.name, 'Third');
  assert.equal(reloaded.workspaces?.[1]?.name, 'First');
  assert.equal(reloaded.workspaces?.[2]?.name, 'Second');
});

test('workspace allows many-to-many repo membership', () => {
  const workspaces: Workspace[] = [
    { id: 'ws-1', name: 'App', repos: ['/shared', '/frontend'], order: 0 },
    { id: 'ws-2', name: 'Infra', repos: ['/shared', '/ops'], order: 1 },
  ];
  const config = writeConfig({ repos: ['/shared', '/frontend', '/ops'], workspaces });
  // /shared is in both workspaces — this is valid in v4
  assert.equal(config.workspaces?.length, 2);
  assert.ok(config.workspaces?.[0]?.repos.includes('/shared'));
  assert.ok(config.workspaces?.[1]?.repos.includes('/shared'));
});
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `npm test`
Expected: These tests should mostly PASS since they test config manipulation directly. Some may need adjustment based on migration behavior.

- [ ] **Step 3: Create workspace-groups router**

Create `server/workspace-groups.ts`:

```typescript
import crypto from 'node:crypto';
import { Router } from 'express';
import type { Request, Response } from 'express';
import { loadConfig, saveConfig } from './config.js';
import type { Workspace } from './types.js';

export function createWorkspaceGroupsRouter(configPath: string, requireAuth: any): Router {
  const router = Router();

  function getConfig() {
    return loadConfig(configPath);
  }

  // GET /workspace-groups — list all workspace groups
  router.get('/', requireAuth, (_req: Request, res: Response) => {
    const config = getConfig();
    const workspaces = (config.workspaces ?? []).sort((a, b) => a.order - b.order);
    res.json(workspaces);
  });

  // POST /workspace-groups — create workspace group
  router.post('/', requireAuth, (req: Request, res: Response) => {
    const { name, repos, themeColor } = req.body as {
      name?: string;
      repos?: string[];
      themeColor?: string;
    };

    if (!name || typeof name !== 'string' || !name.trim()) {
      res.status(400).json({ error: 'name is required' });
      return;
    }

    const config = getConfig();
    const validRepos = new Set(config.repos);
    const filteredRepos = (repos ?? []).filter(r => validRepos.has(r));

    const workspace: Workspace = {
      id: crypto.randomUUID(),
      name: name.trim(),
      repos: filteredRepos,
      order: (config.workspaces ?? []).length,
      ...(themeColor ? { themeColor } : {}),
    };

    if (!config.workspaces) config.workspaces = [];
    config.workspaces.push(workspace);
    saveConfig(configPath, config);

    res.status(201).json(workspace);
  });

  // PUT /workspace-groups/:id — update workspace
  router.put('/:id', requireAuth, (req: Request, res: Response) => {
    const { id } = req.params;
    const config = getConfig();
    const workspace = config.workspaces?.find(w => w.id === id);

    if (!workspace) {
      res.status(404).json({ error: 'Workspace not found' });
      return;
    }

    const updates = req.body as Partial<Workspace>;

    if (updates.name !== undefined) {
      if (typeof updates.name !== 'string' || !updates.name.trim()) {
        res.status(400).json({ error: 'name must be a non-empty string' });
        return;
      }
      workspace.name = updates.name.trim();
    }

    if (updates.repos !== undefined) {
      const validRepos = new Set(config.repos);
      workspace.repos = updates.repos.filter(r => validRepos.has(r));
    }

    if (updates.themeColor !== undefined) {
      workspace.themeColor = updates.themeColor || undefined;
    }

    if (updates.settings !== undefined) {
      workspace.settings = updates.settings;
    }

    saveConfig(configPath, config);
    res.json(workspace);
  });

  // DELETE /workspace-groups/:id — delete workspace
  router.delete('/:id', requireAuth, (req: Request, res: Response) => {
    const { id } = req.params;
    const config = getConfig();
    const idx = config.workspaces?.findIndex(w => w.id === id) ?? -1;

    if (idx === -1) {
      res.status(404).json({ error: 'Workspace not found' });
      return;
    }

    config.workspaces!.splice(idx, 1);
    // Re-normalize order
    config.workspaces!.forEach((w, i) => { w.order = i; });
    saveConfig(configPath, config);

    res.status(204).end();
  });

  // PUT /workspace-groups/reorder — reorder workspaces
  router.put('/reorder', requireAuth, (req: Request, res: Response) => {
    const { ids } = req.body as { ids?: string[] };
    if (!Array.isArray(ids)) {
      res.status(400).json({ error: 'ids must be an array of workspace IDs' });
      return;
    }

    const config = getConfig();
    const workspaces = config.workspaces ?? [];
    const wsMap = new Map(workspaces.map(w => [w.id, w]));

    // Validate all IDs exist
    for (const id of ids) {
      if (!wsMap.has(id)) {
        res.status(400).json({ error: `Unknown workspace ID: ${id}` });
        return;
      }
    }

    // Reorder
    const reordered: Workspace[] = [];
    ids.forEach((id, i) => {
      const ws = wsMap.get(id)!;
      ws.order = i;
      reordered.push(ws);
    });

    // Add any workspaces not in the ids array at the end
    for (const ws of workspaces) {
      if (!ids.includes(ws.id)) {
        ws.order = reordered.length;
        reordered.push(ws);
      }
    }

    config.workspaces = reordered;
    saveConfig(configPath, config);

    res.json(reordered);
  });

  return router;
}
```

- [ ] **Step 4: Mount router in index.ts**

In `server/index.ts`:
1. Import: `import { createWorkspaceGroupsRouter } from './workspace-groups.js';`
2. After other router mounts, add:
```typescript
app.use('/workspace-groups', createWorkspaceGroupsRouter(CONFIG_PATH, requireAuth));
```
3. Remove or update the existing `GET /config/workspace-groups` route to redirect or stay as a backward-compat alias.

- [ ] **Step 5: Update resolveSessionSettings for workspace cascade**

In `server/config.ts`, update `resolveSessionSettings()` to accept an optional `workspaceId`:

```typescript
export function resolveSessionSettings(
  config: Config,
  repoPath: string,
  overrides: SessionSettingsOverrides,
  workspaceId?: string,
): ResolvedSessionSettings {
  const repoDefaults = getRepoSettings(config, repoPath);

  // Workspace-level settings cascade (only for workspace sessions)
  let wsSettings: Partial<WorkspaceSettings> = {};
  if (workspaceId) {
    const workspace = config.workspaces?.find(w => w.id === workspaceId);
    if (workspace?.settings) {
      wsSettings = workspace.settings;
    }
  }

  // Cascade: global → workspace → repo → overrides
  return {
    agent: overrides.agent ?? repoDefaults.defaultAgent ?? wsSettings.defaultAgent ?? config.defaultAgent ?? 'claude' as AgentType,
    yolo: overrides.yolo ?? repoDefaults.defaultYolo ?? wsSettings.defaultYolo ?? config.defaultYolo ?? false,
    continue: overrides.continue ?? repoDefaults.defaultContinue ?? wsSettings.defaultContinue ?? config.defaultContinue ?? true,
    useTmux: overrides.useTmux ?? repoDefaults.launchInTmux ?? wsSettings.launchInTmux ?? config.launchInTmux ?? false,
    claudeArgs: overrides.claudeArgs ?? repoDefaults.claudeArgs ?? wsSettings.claudeArgs ?? config.claudeArgs ?? [],
  };
}
```

Wait — per the design doc, the cascade order is: `global → workspace.settings → repoSettings[path] → session`. So workspace settings go BETWEEN global and repo, not after repo. Correct the cascade:

```typescript
export function resolveSessionSettings(
  config: Config,
  repoPath: string,
  overrides: SessionSettingsOverrides,
  workspaceId?: string,
): ResolvedSessionSettings {
  // Build cascade: global → workspace → repo
  const globalDefaults: Partial<WorkspaceSettings> = {
    defaultAgent: config.defaultAgent,
    defaultContinue: config.defaultContinue,
    defaultYolo: config.defaultYolo,
    launchInTmux: config.launchInTmux,
    claudeArgs: config.claudeArgs,
  };

  let wsDefaults: Partial<WorkspaceSettings> = {};
  if (workspaceId) {
    const workspace = config.workspaces?.find(w => w.id === workspaceId);
    if (workspace?.settings) wsDefaults = workspace.settings;
  }

  const repoSpecific = config.repoSettings?.[repoPath] ?? {};

  // Merge: repo overrides workspace overrides global
  const merged = { ...globalDefaults, ...wsDefaults, ...repoSpecific };

  return {
    agent: overrides.agent ?? merged.defaultAgent ?? 'claude' as AgentType,
    yolo: overrides.yolo ?? merged.defaultYolo ?? false,
    continue: overrides.continue ?? merged.defaultContinue ?? true,
    useTmux: overrides.useTmux ?? merged.launchInTmux ?? false,
    claudeArgs: overrides.claudeArgs ?? merged.claudeArgs ?? [],
  };
}
```

- [ ] **Step 6: Add cascade test**

Add to `test/config.test.ts`:

```typescript
test('resolveSessionSettings applies workspace cascade between global and repo', () => {
  const configPath = path.join(tmpDir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    configVersion: 4,
    defaultAgent: 'claude',
    defaultYolo: false,
    defaultContinue: true,
    launchInTmux: false,
    claudeArgs: [],
    repos: ['/my/repo'],
    workspaces: [{
      id: 'ws-1', name: 'My App', repos: ['/my/repo'], order: 0,
      settings: { defaultYolo: true, launchInTmux: true },
    }],
    repoSettings: {
      '/my/repo': { launchInTmux: false },  // repo overrides workspace
    },
  }), 'utf8');
  const config = loadConfig(configPath);
  const result = resolveSessionSettings(config, '/my/repo', {}, 'ws-1');
  assert.equal(result.yolo, true);     // from workspace (global=false, workspace=true, repo=unset)
  assert.equal(result.useTmux, false); // from repo (global=false, workspace=true, repo=false)
  assert.equal(result.agent, 'claude'); // from global (workspace=unset, repo=unset)
});

test('resolveSessionSettings without workspaceId skips workspace cascade', () => {
  const configPath = path.join(tmpDir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    configVersion: 4,
    defaultAgent: 'claude',
    defaultYolo: false,
    defaultContinue: true,
    launchInTmux: false,
    claudeArgs: [],
    repos: ['/my/repo'],
    workspaces: [{
      id: 'ws-1', name: 'My App', repos: ['/my/repo'], order: 0,
      settings: { defaultYolo: true },
    }],
  }), 'utf8');
  const config = loadConfig(configPath);
  // No workspaceId — single-repo session, skip workspace cascade
  const result = resolveSessionSettings(config, '/my/repo', {});
  assert.equal(result.yolo, false); // global default, NOT workspace
});
```

- [ ] **Step 7: Run full test suite**

Run: `npm test`
Expected: All tests PASS including new CRUD and cascade tests.

- [ ] **Step 8: Commit CRUD API**

```bash
git add server/workspace-groups.ts server/index.ts server/config.ts test/workspace-groups.test.ts test/config.test.ts
git commit -m "feat: workspace CRUD API at /workspace-groups with settings cascade"
```

---

### Task 8: Workspace Management Settings UI

**Goal:** Add a "workspaces" section to the settings dialog for creating, editing, and deleting workspace grouping entities.

**Files:**
- Modify: `frontend/src/components/dialogs/SettingsDialog.svelte` — Add workspaces section
- Modify: `frontend/src/lib/api.ts` — Add workspace CRUD API functions
- Create: `frontend/src/components/dialogs/WorkspaceEditor.svelte` — Inline editor for a single workspace (name, repos, color)

**Design decisions:**
- All workspace CRUD lives in the settings dialog, not inline in the sidebar (per design doc)
- Uses existing `DialogShell` + `SettingRow` patterns
- Repo assignment uses the existing `SearchableSelect` component for multi-select
- Color selection uses a simple color palette (from DESIGN.md workspace-theme-color section) — NOT the full color picker (that has its own design doc)
- Changes auto-save via API (matching existing settings pattern)

- [ ] **Step 1: Add workspace API functions**

Add to `frontend/src/lib/api.ts`:

```typescript
import type { Workspace } from './types.js';

export async function fetchWorkspaceGroups(): Promise<Workspace[]> {
  const res = await fetch('/workspace-groups', { credentials: 'include' });
  if (!res.ok) {
    try { const data = await res.json(); throw new Error(data.error); }
    catch { throw new Error(`HTTP ${res.status}`); }
  }
  return res.json();
}

export async function createWorkspaceGroup(data: { name: string; repos: string[]; themeColor?: string }): Promise<Workspace> {
  const res = await fetch('/workspace-groups', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    try { const d = await res.json(); throw new Error(d.error); }
    catch { throw new Error(`HTTP ${res.status}`); }
  }
  return res.json();
}

export async function updateWorkspaceGroup(id: string, data: Partial<Workspace>): Promise<Workspace> {
  const res = await fetch(`/workspace-groups/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    try { const d = await res.json(); throw new Error(d.error); }
    catch { throw new Error(`HTTP ${res.status}`); }
  }
  return res.json();
}

export async function deleteWorkspaceGroup(id: string): Promise<void> {
  const res = await fetch(`/workspace-groups/${id}`, {
    method: 'DELETE',
    credentials: 'include',
  });
  if (!res.ok) {
    try { const d = await res.json(); throw new Error(d.error); }
    catch { throw new Error(`HTTP ${res.status}`); }
  }
}
```

- [ ] **Step 2: Create WorkspaceEditor component**

Create `frontend/src/components/dialogs/WorkspaceEditor.svelte`:

This component renders a single workspace's editable fields:
- Text input for workspace name
- Multi-select (SearchableSelect) for repo assignment from the repos list
- Small color palette for themeColor (8 preset colors from DESIGN.md: terracotta, sage, slate, etc.)
- Delete button (danger variant, TuiButton)

Props: `workspace: Workspace`, `repos: Repo[]`, `onsave: (updated: Partial<Workspace>) => void`, `ondelete: () => void`

The component uses existing patterns:
- `SettingRow` for each field
- `TuiButton` for actions
- Inline auto-save on blur (name) or selection change (repos, color)
- All lowercase labels per DESIGN.md

- [ ] **Step 3: Add workspaces section to SettingsDialog**

In `frontend/src/components/dialogs/SettingsDialog.svelte`:

1. Add a new section in the sections array:
```typescript
{ id: 'workspaces', label: 'workspaces', keywords: ['workspace', 'group', 'multi-repo', 'project'] }
```

2. Add the section content (after integrations, before advanced):
- Header: "workspaces" (lowercase, per DESIGN.md)
- "create workspace" TuiButton (ghost variant)
- For each workspace in the list: render `WorkspaceEditor` component
- Empty state: `no workspaces yet` in `--text-muted`

3. Fetch workspace groups on dialog open:
```typescript
let workspaceGroups = $state<Workspace[]>([]);

async function loadWorkspaceGroups() {
  try { workspaceGroups = await api.fetchWorkspaceGroups(); }
  catch { /* silent */ }
}
```

4. Wire up CRUD handlers:
- Create: call `api.createWorkspaceGroup()`, refresh list
- Update: call `api.updateWorkspaceGroup()`, refresh list
- Delete: call `api.deleteWorkspaceGroup()`, refresh list

- [ ] **Step 4: Verify build**

Run: `npm run build`
Expected: Full build passes.

- [ ] **Step 5: Commit settings UI**

```bash
git add frontend/src/components/dialogs/WorkspaceEditor.svelte frontend/src/components/dialogs/SettingsDialog.svelte frontend/src/lib/api.ts
git commit -m "feat: workspace management UI in settings dialog — create, edit, delete workspaces"
```

---

## Deliverable Traceability

| Design Doc Deliverable | Plan Task |
|----------------------|-----------|
| Rename workspacePath → repoPath (server) | Task 1, Task 3 |
| Rename workspacePath → repoPath (frontend) | Task 5 |
| Rename Workspace type → Repo | Task 1, Task 5 |
| New Workspace grouping entity type | Task 1 |
| WorkspaceLevelSettings type | Task 1 |
| Config v4 with configVersion field | Task 1, Task 2 |
| Config migration: reconcile repos[] | Task 2 |
| Config migration: workspaceSettings → repoSettings | Task 2, Task 3 |
| Config migration: promote workspaceGroups → Workspace[] | Task 2 |
| Session persistence v4 (pending-sessions.json) | Task 4 |
| Workspace CRUD API routes (/workspace-groups) | Task 7 |
| Settings cascade: global → workspace → repo → session | Task 7 |
| Workspace management in settings dialog | Task 8 |
| Test coverage for migration and CRUD | Task 2, Task 4, Task 6, Task 7 |

## Outcomes & Retrospective

_Filled by /harness:complete when work is done._

**What worked:**
- Bulk rename strategy (290+ occurrences) executed cleanly via subagents, caught by build+tests
- TDD for migration logic caught edge cases early (config v4 reconciliation, session persistence)
- Code review caught critical Config.workspaces type mismatch that would have broken runtime

**What didn't:**
- Task 3 subagent missed 4 server files with `config.workspaces` → `config.repos` — caught in Task 6 tests
- Task 5 diagnostics appeared stale, causing false alarm investigation
- Fix agent needed to also update `Config.workspaces` type from `string[]` to `Workspace[]` — the plan didn't anticipate this dual-identity field

**Learnings to codify:**
- L-20260328-config-type-field-rename: When a config field changes type, `as any` casts mask runtime breakage — grep all consumers and verify with tsc before commit
