# relay-ide

Relay IDE is an agentic development environment for running AI coding agents and terminals from a browser or CLI. A Relay hub hosts the web UI and stable JSON gateway; local or remote nodes provide shells, agent CLIs, repo inventory, and `relay-pty`/libghostty-vt terminal session execution. `relay-pty` is the only supported terminal backend; legacy `tmux-compat` state is unsupported and not restored. Repos and worktrees are first-class development context, but they are optional bindings on sessions/tabs rather than the definition of a workspace.

## Current model

Relay's current direction uses this IA vocabulary:

- View — a UI mode or surface.
- Workspace — a saved grouping/config layer for related projects, repos, defaults, and visual organization. It is not synonymous with one repo.
- Project — product/work scope, usually represented by issue/PR/docs context.
- Instance — a concrete local or remote node/repo/worktree occurrence.
- Bench — an arrangement of working surfaces.
- Tab — the leaf working surface: terminal, agent session, file/diff/html surface, PR view, or other active context.

Current docs and UI copy should use these nouns for product IA. Repo/worktree flows remain supported as git-specific context carried by sessions and tabs.

## Prerequisites

| Dependency                                             | Why                                                             |
| ------------------------------------------------------ | --------------------------------------------------------------- |
| [Node.js 24+](https://nodejs.org/)                     | Runtime and build target                                        |
| Agent CLI such as Claude Code, Codex, OpenCode, Hermes | Relay launches configured agent frameworks from the node `PATH` |
| [GitHub CLI (`gh`)](https://cli.github.com/)           | Optional; used by PR/CI surfaces when available                 |
| [Tailscale](https://tailscale.com/)                    | Optional but recommended for private phone/tablet access        |

## Install and run

Install the published package:

```bash
npm install -g relay-ide
```

Start the hub in the foreground:

```bash
relay-ide
```

Or install/start the background service:

```bash
relay-ide --bg
# equivalent long form:
relay-ide hub install
```

If no PIN exists, Relay sets one before accepting traffic: foreground starts with a terminal prompt when stdin is a TTY, while background/non-TTY starts fall back to browser setup. Then open `http://localhost:3456`. To reset the PIN later, run this on the host from an interactive terminal:

```bash
relay-ide pin reset
```

Do not expose Relay directly to the public internet. For phone/tablet use, prefer Tailscale and open `http://<tailscale-ip>:3456` from another device on the same tailnet.

## Source development

From a source checkout:

```bash
npm install
npm run dev
```

`npm run dev` builds the TypeScript backend once, starts the backend as an isolated dev instance on `127.0.0.1:3457`, and starts the Vite frontend on `127.0.0.1:5173`. Open the Vite URL for frontend HMR; Vite proxies REST and WebSocket traffic to the real backend. Dev instances use separate config/process identity but still require the normal PIN/browser-session auth flow.

Useful split commands:

```bash
npm run dev:backend
npm run dev:vite
```

When developing Relay from inside an already-running Relay instance, use the self-hosting wrapper so the child instance gets isolated config, ports, and process identity:

```bash
npm run dev:self
```

See `docs/SELF_HOSTING.md` for the self-hosting workflow.

## CLI usage

The source-of-truth help lives in `bin/relay-ide.ts` and the built binary. Current command shape:

```text
Usage: relay-ide [options]
       relay-ide <command>

Commands:
  dev [--self-host]  Run backend + Vite frontend with HMR (source checkout)
  update             Update this single relay-ide package from npm
  hub                Run the Relay hub web server (same as bare relay-ide)
    install                           Install/start the hub background service
    uninstall                         Stop and remove the hub background service
    status                            Show hub service status
    logs [--lines <n>] [--follow]     Print or follow local hub log files
    nodes [--json]                    List paired nodes with status/capability summary
    doctor [--json]                   Run bounded hub/node diagnostics
    node-logs <nodeId> [--lines <n>] [--follow]
                                       Print or follow logs from a paired remote node
  install            Alias for relay-ide hub install
  uninstall          Alias for relay-ide hub uninstall
  status             Alias for relay-ide hub status
  manifest           Print local node capability manifest as JSON
  v1 ... --json      Versioned CLI gateway JSON contract for nodes/sessions/files
  diag               Collect local diagnostics
    bundle [--output <dir>] [--lines <n>] [--json]
                                       Write a timestamped redacted diagnostics directory
  audit              Manage local security audit logs
    verify [--db <path>] [--json]
                                       Verify the hash-chained security audit log
  node               Manage relay-node pairing and diagnostics
    status                             Show local node/service status
    logs [--lines <n>] [--follow]      Print or follow local node log files
    doctor [--hub <url>] [--json]      Diagnose local node health and hub reachability; surfaces all degraded reasons
    pair <hub> [--json]               Request a device code, wait for operator approval, store the credential, and send one heartbeat
    pair --hub <url> --pair-token <token>
                                       Exchange an operator-minted pair token with a hub and send one heartbeat
    mint-pair-token --hub <url> --operator-grant <handle> [--display-name <name>] [--platform <name>] [--task-ref <ref>] [--json]
                                       Mint a short-lived node pair token through the scoped operator-grant lane
    install --hub <url> [--service auto|manual|launchd|systemd-user|wsl-systemd|wsl-manual]
                                       Install relay-ide globally via npm and optionally set up the local service (no pairing)
    connect --hub <url> --pair-token <token>
                                       Alias for token-based node pairing
    ssh-bootstrap --target <host> --hub <url>
                                       Print a paste-able bash script to install and pair on a remote host via SSH
    link --hub <url>                   Open and hold the persistent /hub/node-link reverse WebSocket (foreground)
  worktree           Manage git worktrees (wraps git worktree)
    add [path] [-b branch] [--yolo]   Create worktree and launch Claude
    remove <path>                      Forward to git worktree remove
    list                               Forward to git worktree list
  browser            Open an HTML file in the remote viewer
    <path>             Path to HTML file
  pin                Manage authentication PIN
    reset              Reset the PIN (interactive, requires TTY)

Options:
  --bg               Shortcut: install and start as background service
  --port <port>      Override server port (default: 3456)
  --host <host>      Override bind address (default: 0.0.0.0)
  --config <path>    Path to config.json (default: ~/.config/relay-ide/config.json)
  --compact          With 'manifest': print compact JSON
  --debug-log        Enable SDK event debug logging to ~/.config/relay-ide/debug/
  --yolo             With 'worktree add': pass --dangerously-skip-permissions to Claude
  --version, -v      Show version
  --help, -h         Show this help
```

## Configuration

Global config is stored at `~/.config/relay-ide/config.json`. Source dev defaults to a local dev config where the dev scripts set it explicitly.

Common fields:

| Field              | Meaning                                                                  |
| ------------------ | ------------------------------------------------------------------------ |
| `host`, `port`     | Hub bind address and port                                                |
| `cookieTTL`        | Auth cookie lifetime                                                     |
| `pinHash`          | PIN verifier, created by the app or `relay-ide pin reset`                |
| `repos`            | Explicit repo paths known to the local node                              |
| `rootDirs`         | Parent directories scanned for repos                                     |
| `workspaces`       | Saved workspace groupings: name, repo membership, order, color, settings |
| `defaultFramework` | Default agent framework id, for example `claude`, `codex`, `opencode`    |
| `frameworks`       | Built-in framework overrides or custom framework definitions             |
| `claudeArgs`       | Back-compat/default extra args still used by Claude-oriented flows       |
| `updateChannel`    | `stable` or `nightly` self-update channel                                |
| `github`           | Optional GitHub integration settings                                     |

## Hub/node mode

Bare `relay-ide` and `relay-ide hub` run the hub web server. A node can pair with a hub, report its local capability manifest, and hold a reverse `/hub/node-link` WebSocket for routed work:

```bash
relay-ide manifest
relay-ide node doctor --hub http://hub.example:3456
relay-ide node pair http://hub.example:3456
relay-ide node link --hub http://hub.example:3456
```

`relay-ide node pair <hub>` is the interactive device-code flow and sends one heartbeat after approval (pair-only, no service). `relay-ide node pair --hub <url> --pair-token <token>` is the token-based pairing flow for automation/operator grants; `relay-ide node connect` is an alias for that flow. `relay-ide node install` installs relay-ide globally and optionally sets up the local service (no pairing). Hub commands can inspect paired nodes and retrieve node logs through the documented CLI surfaces above.

## Features

### Agent and terminal sessions

- Launch agent or terminal sessions from the browser or stable JSON gateway.
- Built-in framework definitions exist for Claude Code, Codex, OpenCode, and Hermes; config can override or add frameworks.
- Session rows carry agent type, node/cwd/repo/worktree context when available, state, scrollback, and reconnect behavior. Browser reconnect can reattach to a live Relay process; Relay server restart is cold resume from saved metadata/scrollback, not live child-process continuity.
- Scriptable gateway commands let adapters list/create/attach/detach/kill/rename sessions, stream raw PTY output, send bounded input, publish artifacts, and call typed supervisor actions without private browser or node-link APIs.
- `worktree add` is a git helper that creates a worktree and launches the configured agent command for that repo context.

### Repo and worktree context

- Relay can scan configured roots and explicit repos.
- Git worktree management wraps `git worktree` for add/remove/list flows.
- Repo identity and worktree inventory are a feature layer on top of the hub/node core; local paths are node-specific.
- Workspace groups organize repos/defaults/settings, but a Workspace is not the same thing as a repo.

### Pull requests and integrations

- PR surfaces use `gh` and/or GitHub integration state where configured.
- GitHub webhooks can be managed through the app when OAuth/webhook config is available.
- Jira integration fields exist for org-dashboard/ticket mapping, but exact behavior should be verified against current integration docs/code before making product claims.

### UI surfaces

- Browser terminal rendering uses xterm.js. Process ownership is handled by `relay-pty`/libghostty-vt, the only supported terminal backend.
- Active Work and workbench/control surfaces organize WorkContexts, nodes, actors, artifacts, approvals, and capability-gated actions; terminal attach is one surface, not the whole product.
- The frontend is React 19 with Zustand and TanStack Query.
- Vite HMR is available in source dev. Non-dev runtime serves `dist/frontend`: `npm start` rebuilds before starting, but package/global runs (`relay-ide`) or direct `node dist/server/index.js` use the already-built bundle, so run `npm run build` after frontend source edits when you are not using Vite HMR.

## Background service

Install/start:

```bash
relay-ide --bg
# or
relay-ide hub install
```

Manage:

```bash
relay-ide hub status
relay-ide hub logs
relay-ide hub uninstall
```

Short aliases:

```bash
relay-ide status
relay-ide uninstall
```

macOS uses launchd. Linux uses user-level systemd where available.

## Remote access

Recommended path:

1. Install Tailscale on the hub machine and the client device.
2. Sign into the same tailnet.
3. Run `tailscale ip` on the hub machine.
4. Open `http://<tailscale-ip>:3456` from the phone/tablet/laptop.

Cloudflare Tunnel and ngrok can work, but they place the hub behind a public ingress; use them only when you understand the exposure and PIN limitations.

## Documentation

Start with `docs/README.md`. It separates current source-of-truth docs from historical plans/spikes so stale implementation plans do not look like shipped behavior.

## Architecture snapshot

```text
relay-ide/
├── bin/                 CLI entry point
├── server/              Express hub, services, sessions, PTY, node-link, integrations
├── shared/              Shared protocol/types for frontend, server, and node surfaces
├── frontend/src/        React UI, state, hooks, API/WebSocket clients
├── docs/                Current docs plus historical plans/spikes
├── test/                Vitest tests
├── scripts/             Build/dev/postinstall helper scripts
├── dist/                Compiled output (gitignored)
└── package.json
```

## Tests and quality gates

```bash
npm test
npm run check
npm run build
```

Use targeted Vitest files for narrow changes when possible; run the broader gates before PR handoff when the change can affect build, types, lint, or runtime packaging.

## Platform support

Relay is tested on macOS and Linux. Windows is not currently tested; file watching, service management, and PTY spawning may behave differently.

## License

MIT
