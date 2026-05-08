# relay-ide

Control Claude Code from your phone or any browser — manage multiple terminal sessions across repos and worktrees with a mobile-friendly web UI.

## Prerequisites

| Dependency                                                            | Why                                                                              |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| **[Node.js 24+](https://nodejs.org/)**                                | Runtime for the server                                                           |
| **[tmux](https://github.com/tmux/tmux/wiki)**                         | Required server-side PTY/session substrate for all interactive sessions          |
| **[Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code)** | Default coding agent — must be in your `PATH`                                    |
| **[Codex CLI](https://github.com/openai/codex)**                      | _Optional_ — alternative coding agent. Install if you want to use Codex sessions |
| **[GitHub CLI (`gh`)](https://cli.github.com/)**                      | _Optional_ — required for the **PRs tab**. Run `gh auth login` after installing. |

## Getting Started

### 1. Install

```bash
npm install -g relay-ide
```

### 2. Start the server

```bash
relay-ide --bg
```

This installs a persistent background service (launchd on macOS, systemd on Linux) that starts on login and restarts on crash. See [Background Service](#background-service) for more options.

Or run in the foreground:

```bash
relay-ide
```

### 3. Set your PIN

Open `http://localhost:3456` in your browser. On first visit you'll be prompted to create a PIN that protects access to your Claude sessions.

If you started the server in the foreground, you can set the PIN in the terminal instead.

### 4. Add your project directories

Click **Settings** in the app to add root directories — these are parent folders that contain your git repos (scanned one level deep).

You can also edit `~/.config/relay-ide/config.json` directly:

```json
{
  "rootDirs": ["/home/you/projects", "/home/you/work"]
}
```

### 5. Access from your phone

Relay IDE binds to `0.0.0.0` by default, but you should **not** expose it to the public internet. Use [Tailscale](https://tailscale.com/) for a private encrypted connection between your devices — see [Remote Access](#remote-access) below.

## Remote Access

The recommended way to access Relay IDE from another device (phone, tablet, laptop) is [Tailscale](https://tailscale.com/), which creates a private encrypted network using WireGuard.

1. **Install Tailscale** on your computer and on your phone/tablet
   - macOS: `brew install tailscale` or download from [tailscale.com/download](https://tailscale.com/download)
   - Linux: follow the [install guide](https://tailscale.com/download/linux)
   - iOS/Android: install the Tailscale app from your app store

2. **Sign in** to the same Tailscale account on both devices

3. **Find your computer's Tailscale IP** — run `tailscale ip` or check the admin console (looks like `100.x.y.z`)

4. **Open the app** on your phone at `http://100.x.y.z:3456`

Your traffic is encrypted end-to-end, no ports are exposed to the internet, and only devices on your Tailscale network can reach the server.

> **Alternatives:** [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) or [ngrok](https://ngrok.com/) also work, but they expose your server to the public internet and rely on the PIN as your only defense.

## Platform Support

Tested on **macOS** and **Linux**. Windows is not currently tested — file watching and PTY spawning may behave differently.

## CLI Usage

```
Usage: relay-ide [options]
       relay-ide <command>

Commands:
  dev                Run backend + Vite frontend with HMR (source checkout)
  update             Update to the latest version from npm
  install            Install as a background service (survives reboot)
  uninstall          Stop and remove the background service
  status             Show whether the service is running
  worktree           Manage git worktrees (wraps git worktree)
    add [path] [-b branch] [--yolo]   Create worktree and launch Claude
    remove <path>                      Forward to git worktree remove
    list                               Forward to git worktree list
  pin                Manage authentication PIN
    reset              Reset the PIN (interactive, requires TTY)

Options:
  --bg               Shortcut: install and start as background service
  --port <port>      Override server port (default: 3456)
  --host <host>      Override bind address (default: 0.0.0.0)
  --config <path>    Path to config.json (default: ~/.config/relay-ide/config.json)
  --yolo             With 'worktree add': pass --dangerously-skip-permissions to Claude
  --version, -v      Show version
  --help, -h         Show this help
```

## Background Service

Run as a persistent service that starts on login and restarts on crash:

```bash
relay-ide --bg
```

Or with custom options:

```bash
relay-ide install --port 4000
```

Manage the service:

```bash
relay-ide status      # Check if running
relay-ide uninstall   # Stop and remove
```

- **macOS**: Uses launchd (`~/Library/LaunchAgents/`)
- **Linux**: Uses systemd user units (`~/.config/systemd/user/`)
- **Logs (macOS)**: `~/.config/relay-ide/logs/`
- **Logs (Linux)**: `journalctl --user -u relay-ide -f`

## Configuration

Config is stored at `~/.config/relay-ide/config.json` (created on first run).

When running from source, it uses `./config.json` in the project root instead.

| Field           | Default   | Description                                                    |
| --------------- | --------- | -------------------------------------------------------------- |
| `host`          | `0.0.0.0` | Bind address                                                   |
| `port`          | `3456`    | Server port                                                    |
| `cookieTTL`     | `24h`     | Auth cookie lifetime (e.g. `30m`, `12h`, `7d`)                 |
| `rootDirs`      | `[]`      | Directories containing your git repos (scanned one level deep) |
| `claudeCommand` | `claude`  | Path to the Claude Code CLI binary                             |
| `claudeArgs`    | `[]`      | Extra arguments passed to every session                        |
| `defaultAgent`  | `claude`  | Default coding agent CLI (`claude` or `codex`)                 |

Root directories can also be managed from the **Settings** button in the app.

## Source development with Vite HMR

From a source checkout, run:

```bash
npm run dev
```

This builds the TypeScript backend once, starts the real Relay backend in no-PIN dev mode on `127.0.0.1:3457`, and starts the Vite frontend on `127.0.0.1:5173`. Open `http://127.0.0.1:5173`; frontend TSX/CSS changes hot-update through Vite without rebuilding `dist/frontend`. The backend remains the real Express/WebSocket server, and Vite proxies relative REST requests plus `/ws/events` and `/ws/:sessionId` upgrades to the backend, so frontend code keeps using relative URLs.

Useful overrides:

| Environment variable              | Default                     | Description                                      |
| --------------------------------- | --------------------------- | ------------------------------------------------ |
| `RELAY_IDE_DEV_BACKEND_PORT`      | `3457`                      | Backend port used by `npm run dev` and the proxy |
| `RELAY_IDE_DEV_BACKEND_HOST`      | `127.0.0.1`                 | Backend bind host                                |
| `RELAY_IDE_DEV_BACKEND_URL`       | `http://127.0.0.1:<port>`   | Explicit Vite proxy target                       |
| `RELAY_IDE_DEV_FRONTEND_PORT`     | `5173`                      | Vite dev-server port                             |
| `RELAY_IDE_DEV_FRONTEND_HOST`     | `127.0.0.1`                 | Vite bind host                                   |
| `RELAY_IDE_CONFIG`                | `./config.dev.json`         | Dev-mode config path                             |

For split terminals, `npm run dev:backend` starts only the backend and `npm run dev:vite` starts only Vite with the same proxy defaults.

### PIN Management

The PIN hash is stored in config under `pinHash`.

**Reset via CLI** (recommended):

```bash
relay-ide pin reset
```

This requires an interactive terminal. You'll be asked to verify your current PIN (if set), then enter a new one.

**Reset manually:**

1. Delete the `pinHash` field from `~/.config/relay-ide/config.json`
2. Restart the server (`relay-ide uninstall && relay-ide --bg`)
3. Open the web UI and set a new PIN

## Features

### Session Management

- **Multi-agent support** — choose between Claude Code and Codex as the coding agent per session, with a configurable default in Settings
- **Repo sessions** — click any idle repo to instantly open Claude with `--continue` (no dialog), or start fresh from the new-session dialog
- **Branch-aware worktrees** — create worktrees from new or existing branches with a type-to-search branch picker
- **Worktree isolation** — each worktree session runs in its own git worktree under `.worktrees/`
- **Tmux-backed sessions** — every interactive agent or terminal session runs inside tmux on the server; xterm.js remains the browser renderer
- **Resume sessions** — click inactive worktrees to reconnect to the surviving tmux session, falling back to agent continue args only if the tmux session is gone
- **Persistent session names** — display names, branch names, and timestamps survive server restarts
- **Scrollback buffer** — reconnect to a session and see prior output
- **Yolo mode** — skip permission prompts with `--dangerously-skip-permissions` (per-session pill button)
- **Worktree cleanup** — delete inactive worktrees via the trash pill button (removes worktree, prunes refs, deletes branch)

### Pull Requests

- **Pull requests tab** — view your open PRs (authored and review-requested) via `gh` CLI, organized in collapsible per-repo groups with count badges, Author/Reviewer filter, and one-click session creation from any PR branch

### GitHub Webhooks (real-time PR / CI updates)

By default the app polls GitHub every 30 seconds for PR and CI status. Connect a webhook for instant updates instead:

1. **Connect GitHub** — open **Settings → Integrations → GitHub** and authorise the OAuth App. This requests the `repo` and `admin:repo_hook` scopes so the app can manage webhooks on your behalf.
2. **Set up webhooks** — open **Settings → Integrations → Webhooks**. Click **Setup Webhook** next to any repo. The app creates a GitHub webhook pointing at a [smee.io](https://smee.io/) proxy channel and starts a local smee client to relay events.
3. **Verify** — the webhook panel shows a health indicator (last event timestamp). Once connected, polling stops for that repo and updates arrive in real time.

> No public server is required. The smee.io proxy forwards GitHub webhook payloads to your local instance over a persistent SSE connection.

### UI

- **Tabbed sidebar** — switch between Repos, Worktrees, and PRs views with shared filters and item counts
- **Sidebar filters** — filter by root directory, repo, or text search
- **Inline actions** — pill buttons on session cards for rename, YOLO, worktree creation, and delete (hover on desktop, long-press on mobile)
- **Resizable sidebar** — drag the sidebar edge to resize; collapse/expand with a button (persisted to localStorage)
- **Responsive layout** — works on desktop and mobile with slide-out sidebar
- **Touch toolbar** — mobile-friendly buttons for special keys (hidden on desktop)
- **Clipboard image paste** — paste screenshots directly into remote terminal sessions (macOS clipboard + xclip on Linux)

### Settings

- **Full-screen Settings dialog** — redesigned as a scrollable full-screen modal with a table-of-contents drawer for quick section navigation
- **GitHub integration** — connect via OAuth App (Device Flow) for PR data, CI status, and webhook management
- **Webhook management** — self-service webhook CRUD per repo with smee.io proxy, health state, and auto-provision backfill
- **Jira integration** — connect Jira and configure project mappings for the org dashboard tickets panel

### Operations

- **PIN-protected access** with rate limiting
- **Real-time updates** — worktree changes on disk are pushed to the browser instantly via WebSocket
- **Webhook status** — `/workspaces` reports whether each repo is using live webhooks, manual refresh, limited access, or an error state, plus the latest webhook receipt timestamp when available
- **Update notifications** — toast notification when a new version is available, with one-click update
- **CLI self-update** — `relay-ide update` to update from npm

## Terminal Renderer And Session Substrate

relay-ide uses xterm.js as the browser terminal renderer and tmux as the required server-side PTY/session substrate. xterm.js owns display, input capture, fit/resize, and renderer fallback in the browser. tmux owns the durable process tree on the host, including session survival across browser disconnects, server restarts, and workspace tab changes.

The browser never talks to tmux directly. The server attaches `node-pty` to tmux, relays I/O over WebSocket, and lets xterm.js render the resulting terminal stream.

relay-ide uses a [fork of xterm.js](https://github.com/donovan-yohan/xterm.js) instead of the official npm package. the fork adds the experimental WebGPU renderer ([xtermjs/xterm.js#5666](https://github.com/xtermjs/xterm.js/pull/5666)) and gives us the ability to patch terminal behavior for our use case.

the fork stays as close to upstream as possible. you can verify the exact differences from upstream and reproduce the build artifacts yourself — see the fork's [FORK.md](https://github.com/donovan-yohan/xterm.js/blob/master/FORK.md) for details.

the dependency in `package.json` is pinned to a specific commit hash so every install is deterministic and auditable.

## Architecture

TypeScript + ESM backend (Express + node-pty + tmux + WebSocket) compiled to `dist/`. React 19 frontend (Zustand + TanStack Query + Vite) compiled to `dist/frontend/`.

```
relay-ide/
├── bin/
│   └── relay-ide.ts  # CLI entry point
├── server/
│   ├── index.ts        # Express server, REST API routes
│   ├── sessions.ts     # tmux-backed PTY session manager (node-pty)
│   ├── ws.ts           # WebSocket relay (PTY ↔ browser)
│   ├── watcher.ts      # File watcher for .worktrees/ changes
│   ├── auth.ts         # PIN hashing, verification, rate limiting
│   ├── config.ts       # Config loading/saving, worktree metadata
│   ├── clipboard.ts    # System clipboard operations (image paste)
│   ├── service.ts      # Background service management (launchd/systemd)
│   └── types.ts        # Shared TypeScript interfaces
├── frontend/
│   └── src/
│       ├── components/  # React components (Sidebar, Terminal, WorkspaceArea, etc.)
│       ├── lib/state/   # Pure UI state modules
│       ├── lib/api.ts   # REST API client
│       ├── lib/ws.ts    # WebSocket connection management
│       ├── lib/types.ts # Frontend TypeScript interfaces
│       ├── lib/utils.ts # Shared utilities (path display, time formatting, device detection)
│       └── hooks/       # React hooks for app behavior
├── test/               # Unit/integration tests (Vitest)
├── dist/               # Compiled output (gitignored)
├── config.example.json
└── package.json
```

## License

MIT
