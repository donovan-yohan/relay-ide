---
status: implemented
created: 2026-03-21
branch: new-agent-quick-open
supersedes: 2026-03-06-customize-session-flow-design.md
implemented-by:
consulted-learnings: []
---

# New Tab Quick-Create & Customize Redesign

## Problem

The "+" tab bar dropdown was designed for the old repo-selection model and is broken in workspace-driven mode:

1. **"New Claude Session" label** — vendor-specific, should be generic
2. **Terminal creation impossible** — "New Terminal" opens the same agent modal instead of calling `createTerminalSession()`
3. **Modal shows irrelevant Repo/Worktree tabs** — workspace already knows its folder
4. **No instant creation** — both options force a modal for every new session
5. **New tabs appear leftmost** — should append to the right
6. **Tab names are redundant** — tabs show the repo name which is the same for every tab in a workspace

## Design

### D1: Three-option "+" dropdown

The "+" button dropdown changes from 2 to 3 options:

| Option | Icon | Behavior |
|--------|------|----------|
| **New Agent** | 🤖 | Instant create — no modal. Uses workspace path + global defaults |
| **New Terminal** | 🖥 | Instant create — no modal. Calls `createTerminalSession()` with workspace path |
| **Customize...** | ⚙ | Opens simplified modal for agent customization only |

"New Agent" and "New Terminal" are the fast paths. "Customize..." is for when users want non-default settings.

### D2: Instant creation flow

Both quick-create options bypass the modal entirely:

**New Agent:**
1. Read workspace path from `activeWorkspace`
2. Read defaults from config state (`defaultAgent`, `defaultContinue`, `defaultYolo`, `launchInTmux`)
3. Call `createRepoSession()` with workspace path and defaults
4. On success, `refreshAll()` and select the new session
5. On 409 conflict (existing session), select the conflicting session

**New Terminal:**
1. Read workspace path from `activeWorkspace`
2. Call `createTerminalSession()` (already exists in `api.ts`, currently unused)
3. Backend needs update: `POST /sessions/terminal` should accept optional `cwd` parameter so terminal starts in the workspace directory, not `~`
4. On success, `refreshAll()` and select the new session

### D3: Simplified Customize modal

`NewSessionDialog.svelte` → renamed to `CustomizeSessionDialog.svelte`.

The modal is stripped down:
- **Remove:** "Repo Session" / "Worktree" tab bar (no tabs at all)
- **Remove:** Branch name input (workspace context handles this)
- **Title:** "New Agent Session" with workspace name subtitle (e.g., "— olympus")
- **Keep:** Agent select (Claude / Codex), Continue existing, Yolo mode, Launch in tmux, Extra args
- **Submit button:** "Start Session"

The modal always creates via `createRepoSession()` with the active workspace's path. No repo selection needed.

### D4: Tab naming

Tabs get auto-generated type-based names instead of showing the repo name:

- Agent sessions: "Agent 1", "Agent 2", "Agent 3", ...
- Terminal sessions: "Terminal 1", "Terminal 2", "Terminal 3", ...

Counters are per-workspace and increment based on the number of existing tabs of that type when creating. If "Agent 1" is closed and a new agent is created, it becomes "Agent 3" (not reusing names).

The `displayName` field on sessions stores this. Users can still rename via context menu.

### D5: Tabs append rightmost

New sessions must appear at the end of the tab list, not the beginning.

**Root cause:** The sessions array order depends on how sessions are returned from the API or inserted into state. The fix is to ensure new sessions are appended to the end of the `sessions` array in `sessions.svelte.ts` when received, or that the tab bar sorts by creation time (ascending).

### D6: Keyboard shortcut update

`Cmd/Ctrl+T` currently opens the modal. Change it to instant-create a new agent session (same as clicking "New Agent" in dropdown). Users who want customization can use the dropdown's "Customize..." option.

## Component Changes

### SessionTabBar.svelte

```
Current dropdown:
  🤖 New Claude Session    → opens modal
  🖥 New Terminal           → opens modal (broken)

New dropdown:
  🤖 New Agent             → instant create
  🖥 New Terminal           → instant create
  ⚙ Customize...           → opens modal
```

Props change:
```typescript
// Before
onNewSession: () => void;
onNewTerminal: () => void;

// After
onNewAgent: () => void;
onNewTerminal: () => void;
onCustomize: () => void;
```

### App.svelte

Replace `handleOpenNewSession()` with three distinct handlers:

```typescript
async function handleQuickAgent() {
  if (!activeWorkspace) return;
  const session = await createRepoSession({
    repoPath: activeWorkspace.path,
    repoName: activeWorkspace.name,
    continue: config.defaultContinue,
    yolo: config.defaultYolo,
    agent: config.defaultAgent,
    useTmux: config.launchInTmux,
    cols, rows,
  });
  await refreshAll();
  if (session?.id) selectSession(session.id);
}

async function handleQuickTerminal() {
  if (!activeWorkspace) return;
  const session = await createTerminalSession(activeWorkspace.path);
  await refreshAll();
  if (session?.id) selectSession(session.id);
}

function handleCustomize() {
  customizeDialogRef?.open(activeWorkspace);
}
```

### CustomizeSessionDialog.svelte (renamed from NewSessionDialog.svelte)

- Remove `activeTab` state and tab rendering
- Remove branch input, branch autocomplete, branch refresh
- Remove all worktree-related logic
- `open()` signature: `open(workspace: { name: string; path: string })`
- Always calls `createRepoSession()` on submit
- Title: "New Agent Session — {workspaceName}"

### api.ts

Update `createTerminalSession()` to accept workspace path:
```typescript
export async function createTerminalSession(cwd?: string): Promise<SessionSummary> {
  const res = await fetch('/sessions/terminal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cwd }),
  });
  return json<SessionSummary>(res);
}
```

### Backend: POST /sessions/terminal

Accept optional `cwd` in request body. Default to `os.homedir()` if not provided.

### sessions.svelte.ts

Ensure new sessions are appended to the end of the sessions array (or sort by `createdAt` ascending) so tabs appear rightmost.

## Tab Display Name Assignment

When creating a session, the backend (or frontend before calling the API) assigns a `displayName`:

- Count existing sessions of the same type for the workspace
- Assign "Agent {n+1}" or "Terminal {n+1}"
- This is stored in the session's `displayName` field

The `tabIcon` function in SessionTabBar already distinguishes by `session.type`:
- `'terminal'` → 🖥
- All others → 🤖

## Files Changed

| File | Change |
|------|--------|
| `frontend/src/components/SessionTabBar.svelte` | 3-option dropdown, rename props, update labels |
| `frontend/src/components/dialogs/NewSessionDialog.svelte` | Rename to `CustomizeSessionDialog.svelte`, strip tabs/branch UI |
| `frontend/src/App.svelte` | Split into `handleQuickAgent`, `handleQuickTerminal`, `handleCustomize`; update Cmd+T |
| `frontend/src/lib/api.ts` | Update `createTerminalSession()` to accept `cwd` |
| `server/index.ts` | Update `POST /sessions/terminal` to accept `cwd` body param |
| `frontend/src/lib/state/sessions.svelte.ts` | Ensure new sessions append rightmost (sort by createdAt) |

## Supersedes

- `2026-03-06-customize-session-flow-design.md` — the "Customize" context menu action still exists but now routes to `CustomizeSessionDialog` instead of `NewSessionDialog`. The pre-fill concept remains valid but the dialog is simplified.

## Non-changes

- Backend session creation APIs (`POST /sessions/repo`, `POST /sessions`) are unchanged
- Context menu "Customize" action on sidebar items still works — it calls the same (renamed) dialog
- No changes to workspace selection, sidebar, or PR flows
- `createSession()` (worktree creation) is unchanged — worktrees are created from the sidebar, not the tab bar
