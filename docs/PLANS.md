# Plans

Execution plans for active and completed work.

## Active Plans

| Plan | Created | Topic |
|------|---------|-------|
| `bg-pin-setup-blocked` | 2026-03-28 | Fix --bg first-run crash loop: remove non-TTY exit, trust web-based PIN setup flow |

## Stalled Plans

| Plan | Created | Topic | Status |
|------|---------|-------|--------|
| `mobile-input-redesign` | 2026-02-25 | Event-intent architecture replacing value-diffing for mobile input | 5/6 tasks done — pending on-device manual testing |
| `filesystem-browser-api` | 2026-03-19 | File system browser API + tree UI for workspace selection with bulk import | 4/8 tasks done — backend complete, frontend integration incomplete |
| `repo-root-click-dashboard` | 2026-03-19 | Fix clicking inactive repo root going to dashboard instead of creating session | 0/2 tasks — never started, trivial fix |

## Tech Debt

No tech debt tracked yet.

## Completed Plans

See `docs/exec-plans/completed/` for historical plans (77 completed).

| Plan | Completed | Topic |
|------|-----------|-------|
| `worktree-lifecycle` | 2026-03-28 | Branch lifecycle layer: continuePolicy, worktree detection+fetch, tmux naming, auto-archive |
| `hooks-403-after-restart` | 2026-03-28 | Fix hookToken lost during serialization causing 403 on all hooks after restart + TMUX_PREFIX env pollution |
| `pin-unlock-json-parse-error` | 2026-03-27 | Fix PIN unlock error, add PIN setup via web UI, CLI `pin reset`, defensive error handling |
| `tui-design-system-overhaul` | 2026-03-26 | TUI-native component library: 9 new primitives, micro-interactions, alignment architecture |
| `desktop-drag-broken-reorder-mode-jarring` | 2026-03-25 | Remove reorderMode, restore always-on desktop drag-and-drop, add mobile-only long-press gating |
| `push-notification-permission-fix` | 2026-03-25 | Fix push notifications — wire permission request, show state, chain subscription |
| `github-device-flow` | 2026-03-24 | Replace OAuth web flow with GitHub Device Flow for zero-config auth |
| `session-worktree-separation` | 2026-03-23 | Separate session and worktree concerns — unified POST /sessions, collision retry, v2→v3 migration |
| `relay-phase1-data-tables` | 2026-03-23 | Shared DataTable component, filter chips, sortable columns, keyboard nav, row grouping, saved presets |
| `settings-webhooks` | 2026-03-25 | Full-screen Settings modal, DialogShell + SettingRow + SettingsToc components, webhook self-service backend (webhook-manager.ts), GitHub/Webhook/Jira integration panels |
| `relay-phase2-github-api` | 2026-03-23 | GitHub App OAuth, GraphQL API, smee.io webhooks, real-time updates, CI status, sidebar PR enrichment |
| `jira-acli-rewrite` | 2026-03-22 | Rewrite Jira integration to use acli CLI, remove Linear integration |
| `codex-review-fixes` | 2026-03-22 | Codex review fixes — org dashboard cleanup (premature idempotency, BranchLink source, etc.) |
| `session-flags-lost-on-restart` | 2026-03-22 | Preserve yolo/claudeArgs flags across auto-update restart |
| `org-dashboard-phase4` | 2026-03-21 | Jira + Linear integrations + status mapping UI (Phase 4 of org dashboard) |
| `hooks-state-detection` | 2026-03-20 | Replace output parser with Claude Code hooks for state detection + branch rename |
| `local-analytics` | 2026-03-20 | SQLite-backed local analytics and user behavior tracking |
| `enriched-sidebar-sessions` | 2026-03-19 | Two-line sidebar rows with relative time, worktree name, PR#, diff stats |
| `sidebar-session-model-mismatch` | 2026-03-19 | Fix sidebar showing 1 row per session instead of 1 row per folder |
| `workspace-reorder` | 2026-03-19 | Drag-and-drop workspace reordering, sidebar header simplification |
| `pr-dashboard-usability` | 2026-03-19 | PR dashboard: scroll, links, per-PR session button, search |
| `branch-lifecycle-fix` | 2026-03-19 | Unique branch names on worktree reuse, auto-rename on first message, display names |
| `settings-centralization` | 2026-03-19 | Centralize settings resolution server-side; fix sidebar ignoring yolo/agent/tmux defaults |
| `sidebar-ux-and-branch-pr-bugs` | 2026-03-19 | 7 sidebar fixes: menu readability, triple-dots UX, branch listener, PR filter, grip dots, footer layout, repo branch name |
| `output-parser-sideband-rename` | 2026-03-19 | Vendor-extensible output parser + sideband branch rename (replaces PTY injection) |
| `default-repo-session-sidebar-fix` | 2026-03-19 | Fix 6 sidebar bugs: hidden repo root, wrong name, wrong click, missing 2nd row, item order, dots alignment |
| `sdk-chat-ui-remnant` | 2026-03-19 | Remove dead SDK chat UI code — PTY-only architecture (2,814 lines removed) |
| `workspace-redesign` | 2026-03-18 | v3 rearchitecture — workspace-first sidebar, PR top bar, multi-tab sessions, terminal aesthetic |
| `session-persistence-fix` | 2026-03-17 | Fix sessions lost after auto-update restart |
| `mobile-keyboard-testing` | 2026-03-16 | Fixture-based testing for mobile input event-intent pipeline |
| `continue-retry-exit-code-fix` | 2026-03-14 | Fix --continue retry to fire regardless of exit code (tmux masks to 0) |
| `osc52-clipboard-utf8-fix` | 2026-03-13 | Fix OSC 52 clipboard handler to properly decode UTF-8 from base64 |
| `push-notifications` | 2026-03-13 | Push notifications (Browser Notification + Web Push PWA) when sessions need input |
| `status-indicator-oscillation-fix` | 2026-03-13 | Fix attention status oscillation with cooldown-based suppression |
| `mobile-autocorrect-and-selection` | 2026-03-12 | Fix mobile autocorrect recovery + tmux copy-mode for text selection |
| `mobile-touch-scroll-tmux` | 2026-03-12 | Fix mobile touch scroll in tmux/alternate screen via SGR mouse wheel sequences |
| `continue-flag-pty-replacement` | 2026-03-11 | Fix --continue retry: WebSocket PTY reattachment + tmux name collision |
| `tmux-clipboard-support` | 2026-03-11 | OSC 52 clipboard passthrough + Shift+click selection bypass for tmux sessions |
| `fix-global-defaults-and-tmux-utf8` | 2026-03-11 | Fix stale config defaults on quick-start + tmux UTF-8 rendering |
| `global-session-defaults-tmux` | 2026-03-10 | Global session defaults (continue, yolo, tmux) + tmux launch wrapping |
| `mobile-scroll-fixes` | 2026-03-07 | Fix FAB keyboard flicker, scroll-to-top bug, add skip-to-bottom + swipe sidebar |
| `multi-agent-cli` | 2026-03-05 | Choose between Claude and Codex as the underlying coding agent per session |
| `handle-existing-worktrees` | 2026-02-26 | Auto-redirect to existing worktrees on branch conflict + git-based delete validation |
| `publish-command` | 2026-02-26 | /publish slash command for full release lifecycle from feature branch |
| `session-loading-shimmer` | 2026-02-26 | Loading shimmer overlay for session list items during async actions |

## See Also

- [Architecture](ARCHITECTURE.md) — module boundaries and invariants
- [Design](DESIGN.md) — patterns and conventions
- Design documents for brainstorm outputs: `design-docs/`
