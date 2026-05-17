# Self-hosting Relay IDE

Use this runbook when developing Relay IDE from inside an already-running Relay IDE instance. The goal is to run the source checkout with isolated config, ports, and tmux sessions so it does not collide with the installed/global daemon that is hosting your work.

Self-host mode proves local source behavior only. When a change needs proof on
the shared devbox hub or the `macbook-relay-node` link, use the
[`devbox hub deploy runbook`](./references/devbox-hub-deploy.md) instead of
treating a local self-host run as federated evidence.

## Recommended loop

Start from a real Relay worktree, not the main checkout:

```bash
cd /path/to/relay-ide/.worktrees/<branch>
nvm use
npm install
npm run dev:self
```

Open the printed frontend URL. In self-host mode this is usually `http://127.0.0.1:<allocated-frontend-port>`, not the production daemon at `http://localhost:3456`.

`npm run dev:self` is the one-command path. It runs:

```bash
npm run build:server
node dist/bin/relay-ide.js dev --self-host
```

The `dev` command starts the real Express/WebSocket backend under a supervisor and starts Vite for frontend HMR. Frontend TSX/CSS changes update through Vite. Backend source changes trigger a supervised backend restart after rebuild.

## Dev modes

| Mode                 | Command                         | Backend                   | Frontend                  | Config                                                             | Tmux prefix   | Use when                                          |
| -------------------- | ------------------------------- | ------------------------- | ------------------------- | ------------------------------------------------------------------ | ------------- | ------------------------------------------------- |
| Production/global    | `relay-ide` or `relay-ide --bg` | `0.0.0.0:3456` by default | compiled `dist/frontend/` | `~/.config/relay-ide/config.json`                                  | `relay-ide-`  | Daily hosted Relay instance                       |
| Ordinary source dev  | `npm run dev`                   | `127.0.0.1:3457`          | `127.0.0.1:5173`          | `./config.dev.json`                                                | `relay-dev-`  | Local source development outside production Relay |
| Self-host source dev | `npm run dev:self`              | allocator-chosen          | allocator-chosen          | `~/.config/relay-ide/self-host/<worktree-slug>-<hash>/config.json` | `relay-self-` | Building Relay from inside Relay                  |

Both dev modes run with `NO_PIN=1`. Self-host mode can also be selected by running the CLI entrypoint directly with `relay-ide dev --self-host` from a source checkout, or by setting `RELAY_IDE_SELF_HOST=1` for the dev command.

## What self-host mode isolates

Self-host mode separates the child Relay instance from the installed/global daemon in four places:

- Config: per-worktree config under `~/.config/relay-ide/self-host/`, or `$XDG_CONFIG_HOME/relay-ide/self-host/` when `XDG_CONFIG_HOME` is set.
- Ports: backend and frontend ports are allocated per worktree through `server/port-allocator.ts`.
- `.env`: only the Relay-managed port block in the current worktree is written.
- Tmux: sessions use the `relay-self-` prefix instead of production `relay-ide-` or ordinary dev `relay-dev-`.

The allocator persists assignments under user config state:

```text
~/.config/relay-ide/workspaces/<config-slug>-<hash>/port-assignments.json
```

It allocates from `10000-10999`, then `11000-11999`, then falls back to any OS-available port if both ranges are exhausted. Existing assignments are verified at startup and reassigned when a port is already in use.

The worktree `.env` block looks like this:

```dotenv
# --- relay-ide managed ports (do not edit) ---
RELAY_IDE_DEV_BACKEND_PORT=10000
RELAY_IDE_DEV_FRONTEND_PORT=10001
# --- end relay-ide managed ports ---
```

Content outside that block is preserved. Do not hand-edit the managed block. If it drifts, restart `npm run dev:self`; the allocator rewrites it from the current assignment state. When the self-host UI adds the current Relay worktree as a normal workspace, ordinary workspace `PORT` reconciliation must preserve the existing `RELAY_IDE_DEV_BACKEND_PORT` and `RELAY_IDE_DEV_FRONTEND_PORT` entries instead of replacing the block with only `PORT`.

## Port and host overrides

Prefer allocator defaults for self-hosting. Use overrides only for a known integration or debugging case:

```bash
RELAY_IDE_DEV_BACKEND_PORT=4567 \
RELAY_IDE_DEV_FRONTEND_PORT=5174 \
npm run dev:self
```

Supported dev override variables:

| Variable                      | Default in ordinary dev           | Self-host behavior                                                                                                                       |
| ----------------------------- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `RELAY_IDE_DEV_BACKEND_PORT`  | `3457`                            | Overrides allocator backend port                                                                                                         |
| `RELAY_IDE_PORT`              | unset                             | Ignored to avoid inherited production daemon collisions; use `--port` or `RELAY_IDE_DEV_BACKEND_PORT` for an explicit self-host override |
| `RELAY_IDE_DEV_FRONTEND_PORT` | `5173`                            | Overrides allocator frontend port                                                                                                        |
| `RELAY_IDE_DEV_BACKEND_HOST`  | `127.0.0.1`                       | Backend bind host                                                                                                                        |
| `RELAY_IDE_DEV_FRONTEND_HOST` | `127.0.0.1`                       | Vite bind host                                                                                                                           |
| `RELAY_IDE_DEV_BACKEND_URL`   | `http://127.0.0.1:<backend-port>` | Vite proxy target                                                                                                                        |
| `RELAY_IDE_CONFIG`            | `./config.dev.json`               | Ignored to avoid inherited production config; pass `--config <path>` for an explicit self-host config override                           |
| `RELAY_IDE_TMUX_PREFIX`       | mode-specific                     | Overrides the tmux prefix after normalization                                                                                            |

Invalid self-host port overrides are treated as unset, so the allocator remains the fallback instead of fixed ordinary-dev ports. If you override ports, the effective backend/frontend ports are still written to the worktree `.env` managed block. Generic parent-process `RELAY_IDE_CONFIG` and `RELAY_IDE_PORT` values are intentionally ignored in self-host mode; this prevents a child Relay launched from production Relay from reusing the production config or port by accident.

## Running inside production Relay

1. In the production Relay UI, create or open a Relay worktree for the feature branch.
2. Start a terminal session in that worktree.
3. Run `npm run dev:self`.
4. Open the printed Vite frontend URL in a separate browser tab.
5. Use the self-host UI to create sessions against the same or another worktree.
6. Keep the production tab open as the recovery path if the self-host instance breaks.

Do not start self-hosting with `npm start`; that serves the compiled production bundle and uses production-style defaults. Do not use the production/global URL when testing self-host behavior. The signal that you are in the child instance is the startup output showing `self-host mode: on`, `config: .../self-host/.../config.json`, and `tmux prefix: relay-self-`.

## Avoiding daemon collisions

The installed/global daemon can stay running during normal self-host development because config, ports, and tmux prefixes are separate. Avoid these collision patterns:

- Do not bind the self-host backend to `3456` unless the global daemon is stopped.
- Do not reuse `~/.config/relay-ide/config.json` as `RELAY_IDE_CONFIG` for self-host mode.
- Do not kill tmux sessions by broad patterns like `tmux kill-server`; inspect prefixes first.
- Do not run Playwright e2e against fixed production ports while the global daemon owns them.

Useful checks:

```bash
relay-ide status
lsof -nP -iTCP:3456 -sTCP:LISTEN
lsof -nP -iTCP:<self-host-backend-port> -sTCP:LISTEN
tmux ls | grep '^relay-'
```

## macOS e2e / global daemon caveats

Playwright e2e tests that assume fixed ports or a single daemon can collide with the installed launchd service. On macOS, stop the global service before e2e runs that need exclusive ownership:

```bash
launchctl stop com.relay-ide
npm run test:e2e
launchctl start com.relay-ide
```

If the service was installed differently, use `relay-ide status` and the matching launchd label for that install. The default launchd label is `com.relay-ide`; the plist lives at `~/Library/LaunchAgents/com.relay-ide.plist`.

For normal unit/integration verification, the global daemon usually does not need to stop:

```bash
npm test
npm run check
npm run build
```

## Recovery and debugging

Use these commands from the self-host worktree unless noted otherwise.

### Confirm mode and assigned ports

```bash
npm run dev:self
# look for:
# relay dev backend:  http://127.0.0.1:<port>
# relay dev frontend: http://127.0.0.1:<port>
# config:              .../relay-ide/self-host/<worktree-slug>-<hash>/config.json
# tmux prefix:         relay-self-
# self-host mode:      on
```

Check the worktree `.env`:

```bash
sed -n '/relay-ide managed ports/,/end relay-ide managed ports/p' .env
```

### Port is busy or the URL does not load

```bash
lsof -nP -iTCP:<port> -sTCP:LISTEN
```

If the listener is a stale self-host dev process, stop that process with `Ctrl-C` in its terminal or kill the specific PID shown by `lsof`. Then rerun `npm run dev:self`; allocator startup verifies assignments and can move busy ports.

To reset only this self-host worktree's state, remove the printed self-host config directory and restart:

```bash
rm -rf ~/.config/relay-ide/self-host/<worktree-slug>-<hash>
npm run dev:self
```

If `XDG_CONFIG_HOME` is set, remove `$XDG_CONFIG_HOME/relay-ide/self-host/<worktree-slug>-<hash>` instead.

### Tmux session looks orphaned

List Relay-owned sessions by prefix:

```bash
tmux ls | grep '^relay-ide-\|^relay-dev-\|^relay-self-'
```

Kill only the self-host session you intend to remove:

```bash
tmux kill-session -t relay-self-<slug>-<id8>
```

Never use `tmux kill-server` as a cleanup shortcut; it kills production Relay sessions too.

### Backend keeps restarting

Run the same path in a plain terminal to see supervisor output without the browser in the loop:

```bash
npm run dev:self
npm run check
```

Backend restarts are expected after source edits. Repeated restarts without edits usually mean a TypeScript/runtime error in the backend path. Fix the error, then rerun `npm run dev:self`.

### Frontend connects to the wrong backend

Verify the Vite proxy target printed by startup:

```text
proxy target:        http://127.0.0.1:<backend-port>
```

If it points at production or an old backend, clear the override and restart:

```bash
unset RELAY_IDE_DEV_BACKEND_URL RELAY_IDE_DEV_BACKEND_PORT RELAY_IDE_DEV_FRONTEND_PORT RELAY_IDE_PORT
npm run dev:self
```

### Return to the installed/global daemon

Close the self-host terminal with `Ctrl-C`, then open the production Relay URL. If you stopped launchd for e2e, restart it:

```bash
launchctl start com.relay-ide
```
