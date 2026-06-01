# Terminal backends and relay-pty rollout

Relay supports two PTY execution backends for local and routed node sessions:

- `relay-pty` (default): the direct `RelayPtySession` runtime using Relay's PTY/libghostty-vt pipeline.
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
- Relay-pty sessions do not import existing tmux process state. They start new `RelayPtySession` processes and expose `RELAY_IDE_SESSION_RUNTIME=relay-pty/libghostty-vt` to the child environment.

## Operator rollout pattern

Recommended operating pattern:

1. Leave existing long-running tmux sessions alone; they continue through `tmux-compat`.
2. Start new sessions on the default `relay-pty` backend.
3. Pin only the repos/workspaces that still require tmux behavior to `tmux-compat`.
4. Do not expect existing tmux sessions to convert in place; close/recreate them when they are ready to move.
