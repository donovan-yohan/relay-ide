# Relay Web — UI Kit

The Relay IDE web app — the only product surface. This kit shows the design system tokens composed into the canonical full-screen view: sidebar, session tabs, breadcrumb, terminal, command palette.

## Files

| File         | Role                                                                       |
| ------------ | -------------------------------------------------------------------------- |
| `index.html` | Live full-screen mock of the main view. ⌘K / ⌘P opens the command palette. |
| `tokens.css` | Re-export of `colors_and_type.css` plus shell-specific layout classes.     |

## What's mocked

- **Sidebar** — wordmark + connection status, three tabs (repos / worktrees / prs), filter input with `>` cursor, repo list grouped by workspace, expand/collapse, status dots, attention pulse, `+ add` rows, scanline overlay (drift disabled at `prefers-reduced-motion`).
- **Session tabs** — square, edge-to-edge, terracotta top-border for active, attention pulse, hover-only close `×`.
- **Breadcrumb** — repo badge → branch → agent + status dot, action buttons aligned right (resume / attach tmux / + branch).
- **Terminal** — color tokens used as ANSI roles: `--text-muted` for prose, `--status-success` for OK, `--status-warning` for permission prompts, `--status-info` for paths, `--accent` for `claude` mark and `>` prompt. Block cursor blinks at 1.06s.
- **Status bar** — bottom rail with tmux session, geometry, shell, diff stats, `⌘P` hint.
- **Command palette** — `surface` background, `0 4 16 rgba(0,0,0,.5)` shadow, FZF `>` cursor on the active row, `<em>` matches in `--accent`.

## Not mocked (yet)

- Settings dialog, PR detail view, merge-conflict UI, mobile collapsed-rail layout. The token system covers these — but they'd be repetitive given what's already shown. Add them by composing the same primitives.

## Caveats

- Fonts: `JetBrains Mono` is loaded from Google Fonts as a cross-platform fallback; SF Mono is preferred when available (macOS).
- The "claude" agent badge in the breadcrumb is text-only — see `preview/brand-iconography.html` for the proper SVG version that the production app uses.
- This is an HTML mock, not a React build. The component split (TuiButton, TuiCheckbox, StatusDot, RepoItem) lives in `_reference/relay-ide/frontend/src/components/`.
