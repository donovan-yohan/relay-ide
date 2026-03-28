# TODOs

Backlog of ideas, bugs, and features. Each item is tagged with its harness entry point so any session can pick one up cold.

## Quick Fixes

> Entry: `/harness:bug` → `/harness:plan` → `/harness:orchestrate`
> These have clear root causes and known solutions. No brainstorm needed.

### Sidenav double-click to expand/collapse
Double-clicking a sidenav item (anywhere on the row) should toggle expand/collapse, so users don't have to aim for the tiny chevron icon.

**Scope:** Add click handler to the full row element, distinguish single-click (navigate) from double-click (toggle). **Files:** Sidebar workspace/repo row component.

### Existing worktrees not detected — duplicate checkout fails
Opening a PR branch session fails with `fatal: 'tui-outline-aesthetic' is already used by worktree at '.worktrees/rainier'` because the branch is already checked out in another worktree. The app used to detect existing worktrees and show them in the sidebar, but this is broken — only `everest-9436` shows, not the `rainier` worktree that has `tui-outline-aesthetic` checked out. Should detect all existing worktrees on load, show them in the sidebar, and redirect to the existing worktree instead of trying to create a duplicate.

**Scope:** Fix worktree discovery (likely `git worktree list` parsing is broken or filtered), and fix the "open PR session" flow to check for existing checkouts before `git worktree add`. **Files:** `server/worktree-manager.ts`, sidebar worktree listing, session creation flow.

**Added:** 2026-03-26

### Branch picker dropdown broken
The new branch picker renders as a text input showing the current branch name but doesn't open a dropdown to select other branches. Likely a missing click handler or broken SearchableSelect binding.

**Scope:** Debug why the SearchableSelect isn't opening, fix the binding. **Files:** Branch bar component, SearchableSelect.

### Delete worktree dialog shows session name instead of worktree name
"Are you sure you want to delete the worktree **Agent 30**?" — Agent 30 is the session name. Should show the worktree branch name (e.g. `claude-nice-elbakyan`) or path instead.

**Scope:** Fix the prop passed to the confirmation dialog — use worktree branch/path, not session display name. **Files:** Delete worktree dialog component.

### PR branch session fails if remote branch not fetched locally
Opening a session from a PR fails with `fatal: invalid reference` when the branch only exists on the remote. The flow needs to `git fetch origin <branch>` before `git worktree add`.

**Scope:** Add a fetch step in the worktree creation path when the ref doesn't exist locally. **Files:** `server/worktree-manager.ts` or session creation handler.

### Sidenav branch name goes stale when agent switches branches
Active sessions don't update their branch name in the sidenav when Claude checks out a different branch. The branch shown stays stuck on whatever it was when the session started.

**Root cause:** The frontend has no periodic polling for session data. `refreshAll()` is only called on discrete events (WebSocket messages, user actions). The server's `GET /sessions` handler *does* refresh branch names (10s rate-limited `git rev-parse`), but nothing on the client calls it on an interval. The `ref-changed` WebSocket event only fires for upstream tracking ref changes (push/fetch), not local branch switches — and even when it fires, it only invalidates PR queries, not session data.

**Fix options:**
1. **Periodic poll:** Add a `setInterval` on the frontend that calls `refreshAll()` every ~15–30s
2. **Filesystem watch:** Have the server watch `.git/HEAD` for each session's cwd and broadcast a `session-branch-changed` event
3. **Hybrid:** Watch `.git/HEAD` for real-time detection, with a slow poll as fallback

Option 2 is best — low overhead, instant updates, no wasted HTTP requests.

**Scope:** Server: watch `.git/HEAD` per active session, broadcast branch change event. Frontend: handle the event and update session branch name. **Files:** `server/index.ts` or new watcher module, `server/ws.ts`, `frontend/src/App.svelte`, `frontend/src/lib/state/sessions.svelte.ts`.

**Added:** 2026-03-28

### Missing loading state on app load / refresh
On page load, the empty "Add workspace" state flashes before real content loads. Need a skeleton/shimmer until workspaces have loaded.

**Scope:** Add a loading state to the root app layout that shows until the initial workspace data fetch resolves. **Files:** Root layout component, workspace store initialization.

### Inactive sidenav repo items show stale "default" name and "master" branch
Inactive repo items always show "default" as session name and "master" as branch, even when the repo is on a different branch or the session was renamed.

**Scope:** Read actual branch from repo git state on load; preserve custom session names in config. **Files:** Sidebar repo item component, session/workspace store.

### PR row missing "Review PR" CTA when review is requested
A PR with "review requested" status and Role=Review only shows "Merge" and "+". Should show a "Review" button that launches a review agent session.

**Scope:** Check review request status in the PR row action mapping; add "Review" CTA that opens a session with the review prompt. **Files:** PR table row component, PR action logic.

## Investigation Required

> Entry: `/harness:bug` (investigate phase) → root cause → then plan
> Don't propose fixes until root cause is confirmed.

### [Recurring] "Continue" default breaks new worktree sessions
When "Continue" is enabled as a repo default, new worktree sessions start and immediately close for Claude agent. This was supposedly fixed before but keeps recurring. Only workaround is disabling "Continue" for the repo.

**Investigation:** What does `--continue` do when there's no previous session in a new worktree? Does it find a stale session from a different worktree? Does it exit with a specific code? Check PTY spawn logs and `--continue` resolution logic. **Files:** Session creation, PTY spawn, continue flag resolution.

### Repo-based tmux session names and per-repo agent counters
Tmux sessions are named `crc-<displayName>-<id>` which is opaque in `tmux ls` output. Agent counters ("Agent 1", "Agent 2") are global — counter increments across all repos. Both should be repo-aware:
- **Tmux names:** Include the repo name so `tmux ls` shows which repo each session belongs to (e.g. `crc-myrepo-agent-1-abcdef12`)
- **Agent counters:** Track per-repo so each repo starts at "Agent 1" instead of continuing from the global counter

**Scope:** Redesign `generateTmuxSessionName` in `pty-handler.ts`, change `nextAgentName` in `sessions.ts` to accept repo context, update session creation and restore paths. **Files:** `server/pty-handler.ts`, `server/sessions.ts`, `server/index.ts` (session creation route).

**Added:** 2026-03-28

## Small Features

> Entry: `/harness:brainstorm` → `/harness:plan` → `/harness:orchestrate`
> Need design decisions before implementation.

### Sidenav status indicators redesign
**Combines:** "session count → meaningful indicators" + "clarify idle vs inactive dots"

The static number badges next to repo names don't convey useful info, and the blue/gray dots on sessions aren't visually distinct enough. Redesign both:
- **Repo badges:** Replace count with status summary (e.g. running count, attention dot, idle indicator)
- **Session dots:** Audit current states (active/running, idle/waiting-for-input, inactive/exited) and make them obviously different — distinct shapes, animations (pulse for waiting), or opacity

**Questions to resolve:** What are all the session states? What's the most useful info to surface at the repo level? Should we animate?

### Richer PR status icons in sidenav
Add distinct icons for each PR status (draft, open, review requested, changes requested, approved, merged, closed) alongside the status colour dot on session rows.

**Questions to resolve:** Icon set — use existing icon library or custom? Where exactly do they render relative to the dot and session name?

### Sidebar header / home button redesign
The "Relay" text + collapse icon at the top of the sidebar is a poor use of space and doesn't read as a home button. Redesign to be obviously clickable-as-home and visually compact.

**Questions to resolve:** What does "home" navigate to — dashboard? Should it show a logo/icon? How does it interact with the collapse behavior?

### Settings prompts: show actual defaults, not "e.g."
The prompt preference textareas show placeholder hints like `e.g. focus on security`. Instead, load the actual default prompt text so users see exactly what gets sent and can edit it directly. Also support global-level defaults (not just per-repo).

**Questions to resolve:** Where are the current default prompts defined? Should global defaults live in the global config file? What's the override order (global → repo → session)?

### Auto-archive merged branches and worktree cleanup
After a PR merges, auto-archive or prompt for cleanup without requiring manual session close first. Today: close sessions → delete worktree → branch lingers.

**Questions to resolve:** Auto vs prompted? Batch cleanup UI? How to detect merged PRs (webhook vs poll)? Should it cascade (session close + worktree delete + branch prune) in one action?

## Epics

> Entry: `/harness:brainstorm` → break into phases → multiple loops per phase
> Too large for a single plan. Need to be decomposed first.

### True Workspaces
Current "workspaces" are really just repos. True workspaces should be an arbitrary grouping of repos/folders.

**Phases:**
1. **Rename:** Current workspace → repo throughout UI and codebase
2. **Workspace model:** New entity that groups multiple repos/folders with name, icon, ordering
3. **Workspace sessions:** Launch Claude/Codex with all repos in a workspace as `--add-dir` working directories — enables fullstack and cross-repo work
4. **View modes:** "All repos", "Workspaces", "All sessions" (flat list with repo as sub-label) — easy to swap between
5. **Migration:** Existing single-repo "workspaces" auto-migrate to repos within a default workspace

### Code & File Tools
Add Warp/VS Code-style file utilities to the remote web UI.

**Phases:**
1. **File browser:** File tree panel — navigate filesystem, preview files, open folders
2. **Changed file previews:** List changed files (git status/diff) with inline previews — see what an agent changed
3. **Diff viewer:** Side-by-side or unified diff for staged changes, branch comparisons, PR diffs
4. **Open in external editor:** "Open in VS Code / Cursor" actions for repos, branches, worktrees — detect installed editors, quick-launch from context menu or command center

### Command Center Audit
The command palette needs a full overhaul.

**Phases:**
1. **Audit:** Catalog all features and check which are missing from the command palette (e.g. "Add Repo" is missing)
2. **Architecture:** Add a registration convention/guide so new features always register their commands — prevent drift
3. **Keyboard shortcuts:** Audit, improve, and document shortcuts; make them consistent and discoverable
4. **Discoverability:** Show shortcuts inline, add recently-used section, contextual commands based on current view

## Research / Blocked

> Entry: investigate first, then decide whether to scope as a feature
> Don't plan implementation until the research question is answered.

### Investigate gstack multi-repo mode and proactive mode
Find out what "multi-repo mode" and "proactive mode" mean in gstack — how do they work, what do they enable, and are there ideas to steal or integrate?

**Action:** Read gstack docs/source, try them out, write a summary of what's useful.

### Linear CLI integration — proper ticket source tracking
Re-add Linear integration via CLI with proper `BranchLink.source` field support (no prefix-length heuristic).

**Blocked on:** Linear CLI (`schpet/linear-cli`) getting `--json` support on `linear issue list` (upstream issue #127).

**What needs to happen when unblocked:**
1. Add `'linear'` to `BranchLink.source` type
2. Extend `server/branch-linker.ts` to set `source: 'linear'` during scanning
3. Update `detectTicketSource()` in `server/ticket-transitions.ts` to handle `'linear'` via explicit source value

### CI state display in PrTopBar + mobile scaling
Richer CI status in the PR top bar — individual check names, progress indicators, mobile-responsive.

**Blocked on:** Webhook self-service feature shipping (real-time CI events needed).
**Design doc:** `docs/design-docs/2026-03-24-webhook-self-service-design.md`
