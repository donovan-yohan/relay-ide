# Terminal backends and relay-pty rollout

Relay supports two PTY execution backends for local and routed node sessions:

- `relay-pty` (default): Relay's direct PTY/libghostty-vt-backed pipeline for new sessions. Production session creation currently runs through `pty-handler` with `node-pty` plus a terminal model; the standalone `RelayPtySession` class is not the production registry owner yet.
- `tmux-compat`: the legacy compatibility path. Relay launches sessions through tmux and reattaches to tmux sessions across browser reconnects and server restarts.

Existing tmux sessions and legacy saved state stay on `tmux-compat`, but new sessions use `relay-pty` unless an explicit session/repo/workspace/global setting selects `tmux-compat`.

## Configuration and precedence

`terminalBackend` can be set globally, per workspace, per repo, or per session request. Effective session settings use this order, most-specific first:

1. Explicit session override: `POST /sessions`, routed `sessions.create`, or `PATCH /config/terminalBackend` request fields such as `terminalBackend: "relay-pty"`.
2. Repo settings: `repoSettings[repoPath].terminalBackend`.
3. Workspace settings: `workspaces[].settings.terminalBackend`.
4. Global default: `RELAY_IDE_TERMINAL_BACKEND`, then `config.terminalBackend`, then the hardcoded default `relay-pty`.

`RELAY_IDE_TERMINAL_BACKEND` is a global default, not an absolute operator lock. A repo or workspace configured for `tmux-compat` must continue to resolve to `tmux-compat` even when the process environment default is `relay-pty`. Explicit per-session overrides still win over all saved defaults.

`terminalBackend` is the public create/config knob. Legacy serialized/runtime `useTmux` still maps to the same backend contract when restoring old state, but it is no longer part of the CLI gateway `sessions.create` surface:

- legacy `useTmux: true` => `terminalBackend: "tmux-compat"`
- legacy `useTmux: false` => `terminalBackend: "relay-pty"`

New code must send `terminalBackend`; `useTmux` is runtime/status compatibility only.

## Which sessions migrate

Backend selection happens when a session is created or restored from saved session metadata. Relay does not live-migrate a running PTY process from one backend to the other.

- Running tmux-backed sessions continue as tmux-backed sessions. Browser reconnects and normal server restarts reattach to the existing tmux session.
- Serialized sessions that already include `terminalBackend` restore with that stored backend.
- Legacy serialized sessions without `terminalBackend` restore as `tmux-compat`. This keeps old session files safe even if the current global default has changed to `relay-pty`.
- New sessions created after a default changes use the effective default from the precedence rules above.
- To move a tab from tmux compatibility to relay-pty, start a new session with `terminalBackend: "relay-pty"`. To keep a repo/workspace on tmux while testing relay-pty globally, set its repo/workspace `terminalBackend` to `tmux-compat`.

## Import and fallback behavior

`tmux-compat` remains the fallback/import path for old Relay state:

- Old session manifests that only have `useTmux` are normalized into a backend before launch/restore.
- Missing or unknown new-session `terminalBackend` values fall back to `relay-pty`; legacy serialized sessions without `terminalBackend` still restore as `tmux-compat`.
- Startup only requires tmux when the effective backend is `tmux-compat`, but any session resolved to `tmux-compat` still needs tmux available.
- Relay-pty sessions do not import existing tmux process state. They start a new direct PTY session and expose `RELAY_IDE_SESSION_RUNTIME=relay-pty/libghostty-vt` to the child environment.

## Automation and rendered-screen boundary

`relay-pty` keeps Relay on the path toward Boo-style terminal automation: Relay owns the PTY process path, can maintain a libghostty-backed terminal model, and can expose backend-neutral control primitives without depending on tmux pane scraping. That does **not** mean every terminal-model capability is already public API.

Public stable adapter contract today:

- raw stream/input through `relay-ide v1 sessions stream` and `relay-ide v1 sessions input`;
- typed supervisor actions through `relay-ide v1 supervisor send-text` and `relay-ide v1 supervisor submit`.

Built internally, not adapter-facing: relay-pty visible-text/model helpers used by backend code.

Not stable today:

- rendered-screen snapshot JSON with rows, cols, cursor, title, modes, viewport, and scrollback;
- rendered-screen wait predicates such as “screen contains text,” “title changed,” or “terminal is idle”;
- direct adapter access to libghostty state, browser xterm.js internals, `tmux capture-pane`, or private `/hub/node-link` frames.

Promote any new screen/read/wait primitive through `shared/cli-gateway-contract.ts` and `docs/CLI_GATEWAY.md` before external adapters rely on it. See `BOO_PHILOSOPHY.md` for the current audit and boundary rules.

## Backend-neutral terminal helpers

Internal session control code should prefer backend-neutral terminal names:

- `sendTerminalText` writes literal terminal input text to the active PTY backend.
- `sendTerminalKeys` writes key/control input such as `Enter`, arrows, or `CtrlC`.
- `captureTerminalVisibleText` captures the currently rendered/visible terminal text.

For `relay-pty`, these helpers write through Relay's terminal input encoder and read the Relay terminal model's visible screen. For `tmux-compat`, they translate to the equivalent tmux target/capture commands. Legacy `sendTmuxText`, `sendTmuxKeys`, and `captureTmuxPane` exports remain compatibility aliases only; new code should not use tmux-shaped helper names unless it is explicitly working inside the `tmux-compat` adapter boundary.

## Rendered screen snapshots

The rendered screen API is intentionally backed by the `relay-pty` terminal model, not tmux text scraping. `GET /sessions/:id/screen` and `relay-ide v1 sessions screen --id <session-id-or-global-id> --json` return the libghostty-vt visible rows/text, cursor/title/mode metadata, geometry, freshness metadata, and optional bounded scrollback (`--scrollback --max-lines <n>`, capped server-side).

Fail-closed behavior is part of the contract:

- `tmux-compat` sessions return `UNSUPPORTED` / `SESSION_SCREEN_UNSUPPORTED_BACKEND`.
- disconnected or cleaned-up sessions return `SESSION_CONFLICT` / `SESSION_SCREEN_STALE` rather than stale rendered output.
- remote sessions that cannot be resolved by the local gateway return a typed `NODE_OFFLINE` / `SESSION_SCREEN_ROUTED_UNAVAILABLE` response.

## Operator rollout pattern

Recommended operating pattern:

1. Leave existing long-running tmux sessions alone; they continue through `tmux-compat`.
2. Start new sessions on the default `relay-pty` backend.
3. Pin only the repos/workspaces that still require tmux behavior to `tmux-compat`.
4. Do not expect existing tmux sessions to convert in place; close/recreate them when they are ready to move.
