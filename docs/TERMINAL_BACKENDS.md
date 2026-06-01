# Terminal backends and relay-pty rollout

Relay supports two PTY execution backends for local sessions:

- `tmux-compat` (default): the existing stable path. Relay launches sessions through tmux and reattaches to tmux sessions across browser reconnects and server restarts.
- `relay-pty`: the new direct `RelayPtySession` runtime using Relay's PTY/libghostty-vt pipeline. It is opt-in while it rolls out.

The rollout is intentionally conservative. Existing installs and existing sessions stay on `tmux-compat` unless a new session is explicitly created with `terminalBackend: "relay-pty"` or an operator/repo/workspace default selects `relay-pty`.

## Configuration and precedence

`terminalBackend` can be set globally, per workspace, per repo, or per session request. Effective session settings use this order, most-specific first:

1. Explicit session override: `POST /sessions` or `PATCH /config/terminalBackend` request fields such as `terminalBackend: "relay-pty"` or legacy `useTmux: false`.
2. Repo settings: `repoSettings[repoPath].terminalBackend`.
3. Workspace settings: `workspaces[].settings.terminalBackend`.
4. Global default: `RELAY_IDE_TERMINAL_BACKEND`, then `config.terminalBackend`, then the hardcoded default `tmux-compat`.

`RELAY_IDE_TERMINAL_BACKEND` is a global default, not an absolute operator lock. A repo or workspace configured for `tmux-compat` must continue to resolve to `tmux-compat` even when the process environment default is `relay-pty`. Explicit per-session overrides still win over all saved defaults.

Legacy `useTmux` maps to the same backend contract for compatibility:

- `useTmux: true` => `terminalBackend: "tmux-compat"`
- `useTmux: false` => `terminalBackend: "relay-pty"`

New code should prefer `terminalBackend`; `useTmux` exists so older callers and saved settings keep working during migration.

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
- Missing or unknown `terminalBackend` values fall back to `tmux-compat` rather than silently selecting the experimental runtime.
- Startup only requires tmux when the effective default backend is `tmux-compat`, but any session resolved to `tmux-compat` still needs tmux available.
- Relay-pty sessions do not import existing tmux process state. They start new `RelayPtySession` processes and expose `RELAY_IDE_SESSION_RUNTIME=relay-pty/libghostty-vt` to the child environment.

## Operator rollout pattern

Recommended staged rollout:

1. Leave the global default at `tmux-compat`.
2. Opt one repo or workspace into `relay-pty` and start new sessions there.
3. Keep critical or long-lived repos explicitly pinned to `tmux-compat` while testing.
4. After relay-pty is proven for new sessions, change the global default if desired.
5. Do not expect existing tmux sessions to convert in place; close/recreate them when they are ready to move.
