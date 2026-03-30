# Bug Analysis: New Agent button ignores repo-level yolo setting

> **Status**: Confirmed | **Date**: 2026-03-29
> **Severity**: Medium
> **Affected Area**: frontend session creation (App.svelte, CustomizeSessionDialog.svelte)

## Symptoms
- User sets `defaultYolo: true` in per-repo workspace settings
- Clicking "New Agent" button starts session without `--dangerously-skip-permissions`
- The "Customize" dialog also initializes with the global default (unchecked), but the user can manually toggle it as a workaround

## Reproduction Steps
1. Open workspace settings for a repo and enable "Bypass Permissions" (defaultYolo)
2. Click the "+" tab bar button → "New Agent"
3. Observe the spawned Claude session does NOT have `--dangerously-skip-permissions`
4. Compare: open "Customize..." dialog, manually check the yolo box, create session — this works

## Root Cause

`handleQuickAgent()` at `App.svelte:501` explicitly passes `configState.defaultYolo` (the **global** default, typically `false`) as a per-request override:

```ts
const session = await createSession({
  ...
  yolo: configState.defaultYolo,   // ← global default, not repo setting
  agent: configState.defaultAgent,
  continue: configState.defaultContinue,
  useTmux: configState.launchInTmux,
  ...
});
```

On the server, `resolveSessionSettings()` at `config.ts:233` uses nullish coalescing:

```ts
yolo: overrides.yolo ?? merged.defaultYolo ?? false
```

Since `??` only falls through on `null`/`undefined` (not `false`), the explicit `false` from the global config **always overrides** the repo-level `true` from `merged.defaultYolo`. The per-repo setting never gets a chance to apply.

The same issue exists in `CustomizeSessionDialog.svelte:46-48` which initializes its form fields from `config.defaultYolo` (global) instead of merged repo settings.

## Evidence
- `App.svelte:501` — `yolo: configState.defaultYolo` sends global default as override
- `config.ts:233` — `overrides.yolo ?? merged.defaultYolo` — `false ?? true` = `false`
- `CustomizeSessionDialog.svelte:47` — `yoloMode = config.defaultYolo` initializes from global
- `config.svelte.ts:5` — `defaultYolo: false` is the initial global state
- The `GET /workspaces/settings/merged` endpoint exists and returns properly merged settings, but neither `handleQuickAgent()` nor `CustomizeSessionDialog` uses it

## Impact Assessment
- All four quick-launch settings are affected: `yolo`, `continue`, `agent`, `useTmux`
- Users who set per-repo defaults must use the Customize dialog as a workaround (and manually toggle each field)
- The server-side merge logic (`resolveSessionSettings`) works correctly — the bug is entirely in the frontend passing explicit global overrides that shadow repo settings
- `WorkspaceItem.svelte` call sites that don't pass these fields are NOT affected (they let the server resolve correctly)

## Recommended Fix Direction

**Option 1 (simplest, recommended):** Don't pass `yolo`/`continue`/`agent`/`useTmux` from `handleQuickAgent()`. Let them be `undefined` so the server's `resolveSessionSettings()` properly merges global -> workspace -> repo settings.

**Option 2 (for CustomizeSessionDialog):** Initialize form fields from `fetchMergedWorkspaceSettings(repoPath)` instead of `configState.defaultYolo`. This endpoint already exists and is used by `WorkspaceSettingsDialog`.

## Architecture Review

### Systemic Spread
- `App.svelte:500-503` — `handleQuickAgent()` sends all four global defaults as overrides (the reported bug)
- `CustomizeSessionDialog.svelte:46-48` — `open()` initializes form from global state, not merged repo settings
- Other `createSession()` call sites (`App.svelte:567`, `App.svelte:628`, `App.svelte:672`, `WorkspaceItem.svelte:162`, `WorkspaceItem.svelte:298`, `WorkspaceItem.svelte:333`, `StartWorkModal.svelte:108`) — these do NOT pass session-default fields and correctly let the server resolve. Not affected.

### Design Gap
The frontend has two independent sources of session defaults:
1. `configState` (global state loaded once at boot from `GET /config/*` endpoints) — unaware of per-repo overrides
2. Server-side `resolveSessionSettings()` — properly merges global -> workspace -> repo -> per-request

There is no frontend-side concept of "resolved defaults for the current workspace." The `configState` only holds global defaults. The `fetchMergedWorkspaceSettings()` API exists but is only used by the settings editor, not by session creation flows.

The design gap is an **implicit contract**: callers of `createSession()` are expected to know that passing explicit values as overrides will shadow repo settings. There's no type-level distinction between "user explicitly chose this value" and "I'm just forwarding the global default." The server's `??` operator treats both identically.

A better design would be: quick-launch functions should omit fields they don't have explicit user input for, letting the server resolve from the settings cascade. The `CustomizeSessionDialog` should fetch merged settings to show correct defaults.

### Testing Gaps
- **Missing test cases:** No test verifies that `POST /sessions` with omitted `yolo` field resolves from `repoSettings[path].defaultYolo`. A test should: (1) set `config.repoSettings['/some/repo'].defaultYolo = true`, (2) POST `/sessions` with `repoPath: '/some/repo'` and no `yolo` field, (3) assert the created session has `yolo: true` and args include `--dangerously-skip-permissions`.
- **Infrastructure gaps:** No integration tests exist for the settings resolution cascade. The `resolveSessionSettings` function has no unit tests verifying the merge order (global < workspace < repo < override) or the distinction between `false` and `undefined` overrides.

### Harness Context Gaps
- `docs/DESIGN.md` and `docs/FRONTEND.md` do not document that session creation should defer settings resolution to the server. There's no guidance warning frontend developers against sending global defaults as explicit overrides.
- `docs/LEARNINGS.md` has `L-20260322-session-creation-params` about persisting flags across restarts, but nothing about the settings resolution cascade or the `??` pitfall.
