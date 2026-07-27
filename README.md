# relay-ide

Relay is a channel-first workspace for collaborating with AI coding agents from
any device. A channel is the durable conversation, a DM is a channel with one
agent profile, and agents participate alongside people. Relay keeps the
conversation, mentions, threads, agent output, and orchestration in one
Slack-style interface while local or paired nodes run the actual coding tools
and terminals.

The hub serves the React application and stable JSON gateway. Nodes provide
agent CLIs, shells, files, repositories, and `relay-pty` terminal execution.
Claude Code, Codex, OpenCode, Hermes, and custom profiles can participate in
channels without turning provider-specific process state into the product
model.

## What is built

- Durable channels and DMs backed by SQLite conversation history.
- Human, agent, and system messages with Markdown, streaming updates, native
  image attachments, mentions, and threaded replies.
- Rich agent output in the live channel timeline: collapsible reasoning, tool,
  code, output, and diff cards with syntax highlighting.
- Agent profiles with built-in vendor profiles, custom profile configuration,
  availability state, and channel rosters.
- Mention routing that starts or reuses the addressed profile's runtime,
  supplies bounded channel context, and mirrors the response into the same
  conversation.
- A persistent channel orchestrator that can route work to child agents;
  lineage is visible in the operator cockpit.
- Mobile-ready channel navigation, unread state, agent status, approvals,
  interrupt controls, and terminal fallback.
- A hub/node execution model for local and paired machines, plus a versioned
  `relay-ide v1 ... --json` gateway for agent-operable actions.

## Prerequisites

| Dependency                                             | Why                                                                                   |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| [Node.js 24+](https://nodejs.org/)                     | Runtime and build target                                                              |
| Agent CLI such as Claude Code, Codex, OpenCode, Hermes | Relay launches configured frameworks as private channel runtimes from the node `PATH` |
| [GitHub CLI (`gh`)](https://cli.github.com/)           | Optional PR and CI integration                                                        |
| [Tailscale](https://tailscale.com/)                    | Recommended private phone/tablet access                                               |

## Install and run

```bash
npm install -g relay-ide
relay-ide
```

Or install the background hub service:

```bash
relay-ide hub install
```

Open `http://localhost:3456`. Relay requires a PIN before accepting browser
traffic. Foreground startup prompts in an interactive terminal when needed;
background startup can complete setup in the browser.

Reset the PIN from the host:

```bash
relay-ide pin reset
```

Do not expose Relay directly to the public internet. For another device, prefer
Tailscale and open `http://<tailscale-ip>:3456` from the same tailnet.

## Start a conversation

1. Open a workspace in Relay.
2. Choose a channel or start a DM with an agent profile.
3. Write normally or mention a profile, such as `@codex`, in a channel.
4. Keep follow-up discussion in the channel or open a message thread.
5. Use the channel roster and orchestrator controls to inspect or interrupt
   active agents.

Channels own conversation history. Agent runtimes are replaceable execution
details bound behind profile identities; they are not separate chat
destinations.

## Source development

```bash
npm install
npm run dev
```

`npm run dev` builds the TypeScript backend, starts an isolated backend on
`127.0.0.1:3457`, and runs the Vite frontend on `127.0.0.1:5173`. Vite proxies
REST and WebSocket traffic to the backend.

Useful commands:

```bash
npm run dev:self
npm run dev:backend
npm run dev:vite
npm run check
npm test
npm run build
```

Use `npm run dev:self` when Relay is developing Relay so the child instance gets
isolated config, ports, and process identity. See
[`docs/SELF_HOSTING.md`](docs/SELF_HOSTING.md).

## Hub and nodes

Bare `relay-ide` and `relay-ide hub` run the hub. A node can pair with the hub,
publish a capability manifest, and hold a reverse node-link WebSocket:

```bash
relay-ide manifest
relay-ide node doctor --hub http://hub.example:3456
relay-ide node pair http://hub.example:3456
relay-ide node link --hub http://hub.example:3456
```

The hub owns browser auth, channels, routing, policy, and federated views. Each
node owns its local processes, filesystem paths, and repository checkouts.
Remote file browsing is available for online nodes; remote git actions remain
more limited than local repository actions.

## Configuration

Runtime data lives under the configured Relay config directory, not in the
source checkout:

- global: `~/.config/relay-ide/`
- source development: `~/.config/relay-ide/dev/<slug>-<hash>/`

The main config file is `config.json`. Common fields include `host`, `port`,
`cookieTTL`, `rootDirs`, `repos`, `workspaces`, `defaultFramework`,
`frameworks`, `updateChannel`, and optional GitHub integration settings.
Channel history and other durable stores live beside it.

## CLI

Run `relay-ide --help` for the exact installed command set. Main command
families:

```text
relay-ide                    run the hub
relay-ide hub ...            install, status, logs, nodes, doctor
relay-ide node ...           pair, connect, install, link, diagnose
relay-ide v1 ... --json      stable agent-facing gateway
relay-ide worktree ...       git worktree helper
relay-ide browser <path>     open an HTML artifact
relay-ide diag bundle ...    write a redacted diagnostics bundle
relay-ide audit verify ...   verify the security audit chain
relay-ide pin reset          reset browser authentication
```

## Architecture

```text
browser
  ├─ ChannelView → ChannelTimeline → ChannelMessageRow
  ├─ ChannelComposer / ChannelThreadPanel / roster controls
  └─ terminal, file, diff, artifact, and settings surfaces
          │
          ▼
Relay hub
  ├─ channel router + durable message/attachment stores
  ├─ live channel fan-out + mention binder + agent bridge
  ├─ profile, roster, orchestration, auth, policy, and CLI gateway
  └─ local node + routed paired-node links
          │
          ▼
local and paired nodes
  └─ agent CLIs, relay-pty terminals, files, repos, worktrees
```

Start with [`docs/README.md`](docs/README.md), then read:

- [`docs/CHANNEL_CHAT.md`](docs/CHANNEL_CHAT.md) — conversation and agent model
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — backend and protocol map
- [`docs/FRONTEND.md`](docs/FRONTEND.md) — live React surface map
- [`DESIGN.md`](DESIGN.md) — visual system
- [`docs/QUALITY.md`](docs/QUALITY.md) — tests and release gates

## Platform support

Linux and macOS are the primary host platforms. WSL2 nodes are supported with
documented limitations. Browser access works from desktop and mobile devices;
mobile behavior should be verified on the real target browser when changed.

## License

MIT
