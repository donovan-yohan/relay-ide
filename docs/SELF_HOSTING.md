# Self-hosting Relay IDE

Use this when developing Relay IDE from inside an already-running Relay IDE instance.

## One-command path

From an isolated Relay worktree:

```bash
npm run dev:self
```

Then open the printed frontend URL, usually `http://127.0.0.1:<allocated-frontend-port>`.

`npm run dev:self` builds the local backend entrypoint, then runs:

```bash
node dist/bin/relay-ide.js dev --self-host
```

## What self-host mode isolates

Self-host mode is deliberately separate from the installed/global Relay daemon:

- Config: `~/.config/relay-ide/self-host/<worktree-slug>-<hash>/config.json`
- Backend/frontend ports: allocated per worktree through Relay's port allocator
- `.env`: only the Relay-managed port block is updated; existing content is preserved
- Auth: `NO_PIN=1`, same as normal local dev
- Tmux prefix: `relay-self-`, distinct from production `relay-ide-` and ordinary dev `relay-dev-`
- Orphan cleanup: dev/no-PIN servers skip orphan cleanup, and production only cleans its own prefix

The port allocator persists assignments in Relay's user config state, not in tracked repo files. The worktree `.env` is ignored by git and exists only to make the chosen ports visible/reusable for local tooling.

## Running inside Relay

1. In production Relay, create or open a Relay worktree.
2. Start a terminal session in that worktree.
3. Run `npm run dev:self`.
4. Open the printed Vite URL in a browser tab.
5. Edit frontend files for Vite HMR; edit backend files for supervised rebuild/restart.

Backend restarts emit the normal dev restart signal, so the browser may show a brief reconnect state. Tmux-owned agent and terminal sessions keep their server-side process identity during the restart path.

## Overrides

Self-host mode still honors explicit overrides when needed:

```bash
RELAY_IDE_DEV_BACKEND_PORT=4567 RELAY_IDE_DEV_FRONTEND_PORT=5174 npm run dev:self
```

Use overrides sparingly. The default allocator path is safer for multiple Relay worktrees.

## macOS e2e / global daemon caveats

Playwright e2e tests that assume fixed ports or a single Relay daemon can collide with the installed launchd service. On macOS, stop the global service before e2e runs that need exclusive ownership:

```bash
launchctl stop com.relay-ide
npm run test:e2e
launchctl start com.relay-ide
```

If the service was installed with different launchd label settings, use `relay-ide status` and the matching launchd command for that install. Do not run destructive cleanup against tmux sessions by hand unless you have checked the prefix: production sessions start with `relay-ide-`, ordinary dev sessions with `relay-dev-`, and self-host sessions with `relay-self-`.
