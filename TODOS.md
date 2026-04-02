# TODOs

Backlog of ideas, bugs, and features. Each item is tagged with its entry point so any session can pick one up cold.

## Quick Fixes

> Clear root causes and known solutions. No brainstorm needed.

### Sidenav double-click to expand/collapse
Double-clicking a sidenav item (anywhere on the row) should toggle expand/collapse, so users don't have to aim for the tiny chevron icon.

**Scope:** Add click handler to the full row element, distinguish single-click (navigate) from double-click (toggle). **Files:** Sidebar workspace/repo row component.

### ~~Existing worktrees not detected — duplicate checkout fails~~
~~Opening a PR branch session fails with `fatal: 'tui-outline-aesthetic' is already used by worktree at '.worktrees/rainier'` because the branch is already checked out in another worktree.~~

**Completed:** v3.19.3 (2026-03-31) — `findOrCreateWorktreeForBranch` now uses `parseAllWorktrees` to detect branches in main repo. Returns `isMain: true` so server returns `worktreePath: null` for main-repo matches. Also added error toast system for user-visible error messages.

### Branch picker dropdown broken
The new branch picker renders as a text input showing the current branch name but doesn't open a dropdown to select other branches. Likely a missing click handler or broken SearchableSelect binding.

**Scope:** Debug why the SearchableSelect isn't opening, fix the binding. **Files:** Branch bar component, SearchableSelect.

### Delete worktree dialog shows session name instead of worktree name
"Are you sure you want to delete the worktree **Agent 30**?" — Agent 30 is the session name. Should show the worktree branch name (e.g. `claude-nice-elbakyan`) or path instead.

**Scope:** Fix the prop passed to the confirmation dialog — use worktree branch/path, not session display name. **Files:** Delete worktree dialog component.

### PR branch session fails if remote branch not fetched locally
Opening a session from a PR fails with `fatal: invalid reference` when the branch only exists on the remote. The flow needs to `git fetch origin <branch>` before `git worktree add`.

**Scope:** Add a fetch step in the worktree creation path when the ref doesn't exist locally. **Files:** `server/worktree-manager.ts` or session creation handler.

### ~~Sidenav branch name goes stale when agent switches branches~~
~~Active sessions don't update their branch name in the sidenav when Claude checks out a different branch. The branch shown stays stuck on whatever it was when the session started.~~

**Completed:** v3.19.3 (2026-03-31) — `BranchWatcher` watches `.git/HEAD` per active session (including worktrees), broadcasts `session-renamed` + `session-branch-changed` events. Frontend `handleBranchChanged()` updates session and sidebar item branch names in real time. Inode survival handled via watcher recreation after atomic checkout.

### Inactive sidenav repo items show stale "default" name and "master" branch
Inactive repo items always show "default" as session name and "master" as branch, even when the repo is on a different branch or the session was renamed.

**Scope:** Read actual branch from repo git state on load; preserve custom session names in config. **Files:** Sidebar repo item component, session/workspace store.

### Repo root click goes to dashboard instead of creating session
Clicking an inactive repo root in the sidebar navigates to the dashboard instead of creating a new session for that repo. Trivial fix.

**Scope:** Fix the click handler on inactive repo root items to create a session instead of navigating. **Files:** Sidebar repo item component.

### Fix --bg first-run crash loop
`claude-remote-cli --bg` crashes on first run if no PIN is configured. The non-TTY exit blocks the server from starting, but the web-based PIN setup flow (`POST /auth/setup` + PinGate) needs the server running. Remove the non-TTY exit and trust the web layer.

**Scope:** Remove the `!process.stdin.isTTY` exit in `server/index.ts`, ensure PinGate UI handles the no-PIN state. **Files:** `server/index.ts`, `server/auth.ts`.

**Added:** 2026-03-28

### PR row missing "Review PR" CTA when review is requested
A PR with "review requested" status and Role=Review only shows "Merge" and "+". Should show a "Review" button that launches a review agent session.

**Scope:** Check review request status in the PR row action mapping; add "Review" CTA that opens a session with the review prompt. **Files:** PR table row component, PR action logic.

## Investigation Required

> Use `/investigate` for root cause analysis. Don't propose fixes until root cause is confirmed.

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

> Need design decisions before implementation.

### UI preview mode for worktree QA testing
`node-pty` can't spawn PTY processes from git worktrees (`posix_spawnp failed`), which means the server crashes when creating sessions from a worktree. This blocks browser QA of any UI feature developed in a worktree.

Add a `--preview` flag to the server that starts everything except PTY spawning:
- Express, static frontend, WebSocket, all workspace/git/PR endpoints work normally
- `POST /sessions` returns a mock session ID with a stub terminal (no PTY)
- The frontend renders the full session view layout (PrTopBar, SessionTabBar, ChangedFiles panel, Toolbar) with the mock session
- All non-terminal UI (changed files, diffs, PR bar, sidebar, dashboard) is fully interactive and testable

This also enables Playwright/headless browser tests to run in CI without needing a real PTY:
```bash
# Start preview server in CI
claude-remote-cli --preview --port 7778 &
# Run Playwright tests against it
npx playwright test
```

**Scope:** Add `--preview` CLI flag, stub the `createPtySession` call in preview mode to return a fake session object, serve a "preview mode" banner in the terminal area. ~30-50 lines of server code + CLI flag wiring. **Files:** `bin/claude-remote-cli.ts` (flag), `server/index.ts` (session creation stub), `server/pty-handler.ts` (mock).

**Added:** 2026-03-28

### Playwright UI test suite
Add end-to-end browser tests using Playwright for UI components that can't be unit tested (Svelte components, WebSocket integration, real browser rendering). Run against the `--preview` mode server so no PTY is needed.

**Priority tests:**
1. Changed files panel: collapsible stats bar, file list rendering, inline diff expansion, mobile card layout
2. Session view layout: PrTopBar, SessionTabBar, terminal area, ChangedFiles ordering
3. Sidebar: workspace list, session items, context menus, search
4. Dashboard: PR table, activity feed, automation checkboxes
5. Dialogs: AddWorkspace (FileBrowser), Settings, CustomizeSession

**Depends on:** UI preview mode (above).
**Scope:** Add `playwright` as devDependency, create `e2e/` directory with test files, add `npm run test:e2e` script, CI workflow in `.github/workflows/test-e2e.yml`. **Files:** `package.json`, `playwright.config.ts`, `e2e/*.spec.ts`.

**Added:** 2026-03-28

### LLM-powered file change summaries
Opt-in feature: generate one-line summaries for each changed file in the Code & File Tools panel by piping the diff through `claude -p --bare` with Haiku (or the user's configured agent). Batch all changed files into one call, cache until next `files-changed` event. The +N -N fallback stats tell you HOW MUCH changed; LLM summaries tell you WHAT changed.

**Depends on:** Phase 2 changed files panel (needs the file list and diff infrastructure to exist first).

**Added:** 2026-03-28

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

> Too large for a single plan. Break into phases first.

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
1. ~~**File browser:** File tree panel — navigate filesystem, preview files, open folders~~ *(done — PR #X, filesystem-browser-api)*
2. ~~**Changed file previews:** List changed files (git status/diff) with inline previews — see what an agent changed~~ *(done — PR #69, code-file-tools)* **Note:** browser QA blocked by worktree PTY issue; needs `--preview` mode (see Small Features above) or manual QA from the main repo
3. **Diff viewer (full-page):** Side-by-side or unified diff for staged changes, branch comparisons, PR diffs. Phase 2's inline DiffViewer handles 90% — Phase 3 adds full-page mode, side-by-side toggle, keyboard nav, URL-addressable `/diff` route
4. **Open in external editor:** "Open in VS Code / Cursor" actions for repos, branches, worktrees — detect installed editors, quick-launch from context menu or command center *(low priority)*

### Verification-First Testing Strategy
Inspired by ["Cost to Implement vs Verify"](https://clifford.ressel.fyi/blog/cost-to-implement-vs-verify/) — as we lean harder on agents for implementation, our ability to *verify* what they produce must scale proportionally. Today we have `npm test` (unit tests via `node --test`) and nothing else. The goal: full end-to-end verification infrastructure that agents can both run against and author tests for.

**Core principle:** "How will I verify what was built?" must precede every agentic coding task. Reduce Cv (cost to verify) so agents can be delegated freely.

**Phases:**

1. **Sandbox mode (`--sandbox`):** Isolated server instance that can run the full app without affecting the production instance. Extends the existing `--preview` TODO (Small Features) but goes further:
   - Ephemeral data directory (temp config, temp sessions) — no writes to `~/.config/claude-remote-cli/`
   - Isolated port range (e.g. 7780-7789) to avoid conflicts with a running production server
   - Mock PTY that replays canned terminal output for deterministic test scenarios
   - Teardown on exit — no state leaks between runs
   - `npm run sandbox` script for local dev, usable in CI

2. **Playwright e2e foundation:** Build on the existing "Playwright UI test suite" TODO but with sandbox as the backend instead of just preview mode:
   - `playwright` devDependency, `playwright.config.ts`, `e2e/` directory
   - Sandbox server auto-start/stop in `globalSetup`/`globalTeardown`
   - `npm run test:e2e` script, CI workflow (`.github/workflows/test-e2e.yml`)
   - Core workflow tests: login → add repo → create session → verify terminal renders → create worktree → view changed files → close session
   - Page object model for stable selectors across UI changes

3. **Agent-authored test coverage:** Enable the coding agent (Claude/Codex) to write and run Playwright tests as part of its workflow:
   - Teach the agent (via CLAUDE.md or skill) to write a Playwright test *before* or *after* implementing a UI feature
   - Integrate the TDD superpowers skill — explore how `superpowers:test-driven-development` can drive the write-test-first → implement → verify loop for frontend work
   - Agent can run `npm run test:e2e -- --grep "feature name"` to verify its own work
   - Tests become the verification artifact: if the test passes, the feature is verified

4. **Verification CI gate:** No PR merges without passing e2e tests for affected areas:
   - Map changed files → relevant e2e test suites (e.g. changes to sidebar components → run sidebar e2e tests)
   - Required status check on PRs
   - Test failure screenshots and traces uploaded as artifacts

**Supersedes:** "UI preview mode" and "Playwright UI test suite" TODOs in Small Features (those become substeps of phases 1-2).

**Added:** 2026-03-31

### Command Center Audit
The command palette needs a full overhaul.

**Phases:**
1. **Audit:** Catalog all features and check which are missing from the command palette (e.g. "Add Repo" is missing)
2. **Architecture:** Add a registration convention/guide so new features always register their commands — prevent drift
3. **Keyboard shortcuts:** Audit, improve, and document shortcuts; make them consistent and discoverable
4. **Discoverability:** Show shortcuts inline, add recently-used section, contextual commands based on current view

## Stalled Work

> Partially completed work that needs to be picked back up.

### Mobile input redesign (5/6 done)
Event-intent architecture replacing value-diffing for mobile input. All tasks complete except on-device manual testing.

**Remaining:** Run the test suite on actual iOS/Android devices and verify the event-intent pipeline handles autocorrect, predictive text, and swipe keyboards correctly.

**Added:** 2026-02-25

### Filesystem browser frontend (4/8 done)
File system browser for workspace selection with bulk import. Backend API complete, frontend tree UI integration incomplete.

**Remaining:** Wire the file browser API into the AddWorkspace dialog, build the tree UI, add bulk import from a parent directory.

**Added:** 2026-03-19

## Tech Debt

### EventMessage discriminated union
Refactor `EventMessage` in `frontend/src/lib/ws.ts` from bag-of-optionals to a discriminated union keyed on `type`. Currently all fields except `type` are optional and `type` is `string` — `branch` and `branchName` coexist for different events. A union would give compile-time narrowing and catch missing fields on new event types.

## Research / Blocked

> Use `/investigate` first, then decide whether to scope as a feature.

### Investigate gstack multi-repo mode and proactive mode
Find out what "multi-repo mode" and "proactive mode" mean in gstack — how do they work, what do they enable, and are there ideas to steal or integrate?

**Action:** Read gstack docs/source, try them out, write a summary of what's useful.

### Investigate Codex engagement metrics — hook support or parser-based proxy
Codex sessions get no hook callbacks (hooks only injected for `agent === 'claude'`). The Codex output parser (`codex-parser.ts`) may be a stub. To show engagement metrics (human response latency, agent idle %) for Codex sessions, need to either: (a) verify if Codex CLI supports HTTP hooks similar to Claude Code, or (b) use parser state transitions (idle/processing timestamps) as engagement event proxies.

**Action:** Check Codex CLI docs/source for hook or callback support. If hooks exist, extend `writeHooksSettingsFile` for Codex. If not, extend `codex-parser.ts` to emit timestamped state events that the analytics module can consume. **Files:** `server/pty-handler.ts`, `server/output-parsers/codex-parser.ts`.

**Added:** 2026-04-01

### Research Claude HUD plugin — expose session info in our UI
The [Claude HUD](https://github.com/) plugin surfaces real-time Claude Code session internals as a status line: model type, context window usage (color-coded meter), tool activity (files read/edited/searched), subagent status (type, task, runtime), and todo progress. Research how it hooks into the engine and evaluate exposing similar data in our web UI.

**Action:** Install Claude HUD, read its source, identify what APIs/hooks it uses to pull session data (context usage, active tools, subagent list). Prototype a session info panel or status bar in the frontend showing context %, active model, tool activity, and agent count for the active session.

**Added:** 2026-03-31

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

---

## New (2026-03-30)

### Onboarding experience for new users
Replace the empty-state flash on first load with a proper onboarding flow:
- **Time-aware greeting loading state:** Pre-generate a batch of greetings keyed to time of day to reduce repetition. Include standard ones ("Good morning", "Good evening") and fun ones ("It's high noon", "Burning the midnight oil", "The witching hour").
- **Guided onboarding:** Walk new users through workspaces/repos setup, GitHub and Jira integration, and the command center.

### Codex integration improvements
Better support for Codex as an agent type — smoother spawning, configuration, and workflow integration.

### Gemini agent support
Add Gemini as a supported agent type alongside Claude and Codex.

### Quick agent spawning from new tab
Make it fast and easy to spawn agents of different types from the new tab button. Overhaul the UX so defaults apply but swapping agent types or using multi-agent flows has minimal friction.

### Mobile: hide top bar when keyboard is open
On mobile, hide top bar UI elements (tabs at minimum) when the software keyboard is open to maximize reading/terminal space.

### Bug: Clicking blinking+bold sidenav item doesn't always clear read status
Clicking a sidenav item that has unread attention state (blinking + bold) sometimes fails to clear it. The item stays highlighted as if it still has unread activity.

**Scope:** Debug the click handler that clears attention/unread state — likely a race condition or missed state update when the attention flag is set at the same time as the click. **Files:** Sidebar session item component, attention/read state management.

**Added:** 2026-03-31

### Bug: Sidenav colored bars are unclear — audit needed
The colored bars/indicators next to sidenav items have no obvious meaning. Need to audit what each color/state represents, whether the mapping is correct, and whether it's communicating anything useful. If not, redesign or remove.

**Scope:** Trace the code that renders sidebar status indicators, document what each color maps to, compare against actual session states, and decide whether to clarify, redesign, or remove. **Files:** Sidebar session item component, session state types, any status color mapping logic.

**Added:** 2026-03-31

### Missing hover tooltips on buttons
No buttons in the UI have tooltips on hover. Users have to guess what icon buttons do. Add tooltips to all icon/action buttons across the app — sidebar, toolbar, session tabs, PR bar, etc.

**Scope:** Add a tooltip component (or use an existing one), then sweep all icon buttons and add descriptive tooltips. Include the keyboard shortcut in the tooltip where applicable. **Files:** All components with icon buttons; may need a shared Tooltip component.

**Added:** 2026-03-31

### Command center discoverability — funnel users into it
Users don't know the command center exists. Add entry points that guide them there: empty states, onboarding hints, a persistent shortcut indicator (e.g. `⌘K` badge), and contextual nudges when users look lost or try to do something the command center handles.

**Scope:** Identify all places where a command center nudge makes sense, add subtle affordances. **Files:** Sidebar header, empty states, onboarding flow, toolbar.

**Added:** 2026-03-31

### PR table missing branch info
The repo PR table doesn't show the PR's source branch or target branch. Add columns or labels showing `head → base` branch names so users can tell at a glance which branch a PR is on and where it's merging to.

**Scope:** Add branch info to the PR table rows. Data likely already available from the GitHub API response. **Files:** PR table component, PR data types if branch fields aren't passed through.

**Added:** 2026-03-31

### Optimistic UI for long-running actions
Many actions (creating worktrees, deleting worktrees, session creation, etc.) block the UI while the server processes them. Users can click away mid-operation, causing janky states. Switch to optimistic updates: immediately reflect the expected state in the UI, then roll back and show a meaningful toast on failure.

**Key areas:**
- **Worktree creation:** Immediately add the worktree item to the sidebar, show a loading indicator, roll back + toast on failure
- **Worktree deletion:** Immediately remove from sidebar, roll back + toast on failure
- **Session creation/close:** Same pattern
- **Any other server-round-trip actions** that currently leave the UI unresponsive

**Scope:** Add an optimistic update pattern (update local state → fire request → confirm or roll back), a toast notification system for errors, and apply to all long-running UI actions. **Files:** Session/worktree state stores, sidebar components, toast system (may need new component), all action handlers that hit the server.

**Added:** 2026-03-31

### Bug: PR refresh shows stale data
The refresh button sometimes doesn't actually update PR state. Examples: PR is created but clicking refresh doesn't show PR info; PR is merged but old state persists until a full browser tab refresh.

**Added:** 2026-03-30

### Bug: Changed files viewport resizing on mobile
The changed files UI rapidly resizes the viewport on mobile devices, making it unusable. Likely a layout feedback loop between the changed files panel and the viewport resize observer.

**Added:** 2026-03-30

### Update channel UI (nightly vs stable)
Add UI to let users choose between nightly and stable update channels for auto-updates. Track dismissed version notifications so we don't re-show the notification for a version the user already dismissed.

**Added:** 2026-03-30

## Completed

### Missing loading state on app load / refresh
On page load, the empty "Add workspace" state flashes before real content loads. Replaced with systemd-inspired boot sequence with real API status lines, time-aware greeting, and degraded mode.

**Completed:** v3.19.3 (2026-03-30)
