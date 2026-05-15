# Federated Relay

Relay IDE can run as a **hub** that tracks multiple **relay-nodes** — personal machines running Relay as execution hosts. From any browser connected to the hub, a user sees which nodes are online, what repositories each node has checked out, and can start terminal/agent sessions on the chosen node. This document describes the architecture, pairing lifecycle, steady-state reverse WebSocket model, session routing, security model, operator runbook, and explicitly out-of-scope items.

> Terminology is deliberate: `hub` (control plane + UI), `node` (execution host), `client` (browser). A hub is just a `relay-ide` server that has accepted node registrations; a node is just a `relay-ide` install on another host.

## Overview

```text
┌─────────────┐          ┌──────────┐          ┌──────────────────────────────┐
│  Browser    │◄─HTTPS──►│   Hub    │◄─WS────►│  Node (macOS/Linux/WSL)      │
│  (React UI) │          │relay-ide │  reverse │  relay-ide install           │
└─────────────┘          └──────────┘  link    │  tmux / node-pty / git / fs  │
                                               └──────────────────────────────┘
```

- **Hub** — serves the React UI, exposes REST/WebSocket APIs, stores the node registry, routes PTY streams and RPC requests to online nodes, and aggregates repo inventory.
- **Node** — executes PTY sessions, hosts git worktrees, runs agent CLIs, reports capability manifest and repo inventory to the hub. The node always initiates the outbound connection to the hub.
- **Client** — the browser. It may run on any device; execution happens on the selected node.

## Hub/Node/Client Terminology

| Term                  | Definition                                                                                                                                                                                                                                            |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Hub**               | A `relay-ide` server configured to accept node registrations. May also host its own local sessions (the hub can act as its own node).                                                                                                                 |
| **Node**              | A Relay install on a machine that pairs with a hub and executes sessions locally.                                                                                                                                                                     |
| **Client UI**         | The React 19 frontend running in a browser connected to the hub.                                                                                                                                                                                      |
| **Repo identity**     | Canonical repository identity derived from git remotes (e.g. `github.com/donovan-yohan/relay-ide`). Same repo cloned on different nodes shares one identity.                                                                                          |
| **Repo instance**     | A node-local checkout of a repo, identified by `(nodeId, repoPath)`.                                                                                                                                                                                  |
| **Worktree instance** | A node-local git worktree, identified by `(nodeId, worktreePath)`.                                                                                                                                                                                    |
| **Global session ID** | A node-scoped session identifier produced by `createGlobalSessionId` in `shared/identity.ts`: `{encodeURIComponent(nodeId)}:{encodeURIComponent(localSessionId)}`. No prefix — the node ID and local ID are URL-encoded and joined by a single colon. |

## Six-Layer Vocabulary Mapping (#444)

Federated Relay keeps its precise low-level hub/node/repo/session terms, but maps them into the product IA so docs do not imply `repo = Workspace` or `worktree = universal cwd`. The source vocabulary is **View -> Workspace -> Project -> Instance -> Bench -> Tab**.

| Product term  | Federated meaning                                                               | Low-level term that remains valid                                                                                                                  |
| ------------- | ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| **View**      | Browser lens over nodes, projects, tabs, workers, or a workspace-scoped subset. | Hub/client filters and future saved views.                                                                                                         |
| **Workspace** | User grouping/pins across Projects.                                             | Existing workspace/repo-folder APIs are migration compatibility, not the federation identity model.                                                |
| **Project**   | Canonical “what” being worked on.                                               | `Repo identity` is a repo-kind Project identity derived from git remotes. Node/agent/playbook Projects may not have repo inventory.                |
| **Instance**  | A Project realized on a node/host.                                              | `Repo instance` `(nodeId, repoPath)` is a git-specific Instance compatibility shape.                                                               |
| **Bench**     | cwd + env inside an Instance.                                                   | `Worktree instance` `(nodeId, worktreePath)` is a git Bench compatibility shape. Free/non-git remote cwd is also a Bench-like anchor once modeled. |
| **Tab**       | User-visible terminal/file/diff/agent-chat/preview surface.                     | A hub/node session and PTY stream back a Tab; `globalSessionId` remains internal routing identity.                                                 |

Worker/agent identity is dynamic decoration on Bench/Tab, not a federated tree node. Use node/host labels for where work runs, repo/project labels for what is being worked on, and worker badges for who is active.

### Compatibility boundaries

- `globalSessionId` is an internal stream/routing id. It is useful in API diagnostics and reconnect paths, but users should primarily see Tab, node, cwd, and process status.
- `repoPath` and `worktreePath` remain compatibility fields while old session creation, repo inventory, and git routes are migrated. They must stay node-scoped; never treat a path alone as global identity.
- Repo inventory is deliberately git-specific. It can seed repo-kind Projects/Instances, but it is not the full future Project inventory.
- Remote file browsing remains unavailable until #428 file RPC lands; do not document hub-local filesystem fallback as supported behavior.

## Reverse WebSocket Model

The steady-state transport is a **reverse WebSocket** opened by the node to the hub. This avoids NAT, firewall, and WSL inbound-port problems.

### Endpoint

```http
GET /hub/node-link  (upgrade to WebSocket)
Authorization: Bearer ***
```

The node presents its persistent credential as a Bearer token during the HTTP upgrade. The hub verifies it against `HubNodeRegistry` using a timing-safe SHA256 comparison.

### Link Channels

Once authenticated, the WebSocket carries multiplexed JSON envelopes:

| Channel   | Direction               | Purpose                                                                                                                                         |
| --------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `control` | Node → Hub              | `hello` on connect, periodic `heartbeat` with manifest and optional repo inventory. Hub replies with `hello.result` / `heartbeat.ack`.          |
| `rpc`     | Hub → Node / Node → Hub | Hub requests remote procedure calls (e.g. `sessions.create`) keyed by `requestId`. Node replies on the same `rpc` channel with the `requestId`. |
| `events`  | Node → Hub              | Node-to-hub async events (e.g. telemetry, session lifecycle).                                                                                   |
| `pty`     | Bidirectional           | Browser-to-node PTY byte relay. `pty.attach`, `pty.input`, `pty.resize` from hub; `pty.data`, `pty.exit`, `pty.error` from node.                |
| `preview` | (future)                | Port-forward / preview URL tunneling. Not implemented in v1.                                                                                    |

### Envelope Format

```ts
{
  protocol: 'relay-node-link',
  protocolVersion: '1.0',
  nodeId: string,
  channel: 'control' | 'rpc' | 'events' | 'pty' | 'preview',
  type: string,
  timestamp: string,
  requestId?: string,
  streamId?: string,
  payload?: unknown,
  error?: { code, message, retryable }
}
```

### Reconnection

- A node reconnecting with a newer WebSocket replaces the previous link (old link receives close code `1012`).
- On revocation, the hub sends a `control.error` with code `NODE_REVOKED` and closes the WebSocket with code `4003`.
- Pending RPCs and active PTY streams tied to a closed link are cleaned up immediately.

### Heartbeat and Offline Detection

- Default heartbeat is implicit: any `control.hello` or `control.heartbeat` refreshes the node's `lastSeenAt`.
- Node status transitions:
  - `online` → `stale` after 45s without heartbeat
  - `stale` → `offline` after 90s without heartbeat
- Heartbeat state is persisted to disk with a 5s debounce (`DEFAULT_HEARTBEAT_PERSIST_DEBOUNCE_MS`).

## Pairing and Credential Lifecycle

### Step 1: Generate a pair token

An authenticated hub user creates a short-lived, one-time token:

```http
POST /hub/pair-tokens
Cookie: token={auth-cookie}
Content-Type: application/json

{
  "displayName": "dev-macbook",
  "ttlSeconds": 600,
  "hubUrl": "https://hub.example.com",
  "sshTarget": "dev@example.internal",
  "tailscaleTarget": "dev@tail-host",
  "serviceModes": ["manual", "launchd", "systemd-user", "wsl-systemd", "wsl-manual"]
}
```

Response includes the raw `pairToken` and redacted-safe bootstrap commands for local, SSH, and Tailscale installation.

### Step 2: Bootstrap the node

On the target machine:

```bash
# Pair-only (one-shot credential exchange + heartbeat, then exit)
relay-ide node connect \
  --hub https://hub.example.com \
  --pair-token <pairToken>

# Pair + install a persistent background service
relay-ide node install \
  --hub https://hub.example.com \
  --pair-token <pairToken> \
  --service launchd          # or systemd-user, wsl-systemd, wsl-manual, manual
```

Both commands exchange the pair token, receive a persistent credential, and send an initial heartbeat. `node install` additionally writes a launchd plist or systemd user unit and starts the service.

> Bootstrap diagnostics pair credentials and install/start the generic Relay service. The persistent `/hub/node-link` reverse WebSocket is opened by `relay-ide node link --hub <url>` (foreground), which can be wrapped by your platform service manager.

### Step 3: Credential storage

The node writes its credential to:

```text
<configDir>/node-credential.json   (mode 0600)
```

Format:

```json
{
  "protocol": "relay-node-link",
  "protocolVersion": "1.0",
  "nodeId": "node_...",
  "credentialId": "cred_...",
  "token": "node_....secret_...",
  "issuedAt": "2026-05-12T..."
}
```

### Step 4: Steady-state heartbeats

```bash
relay-ide node link --hub https://hub.example.com
```

`node link` reads `node-credential.json`, opens the reverse WebSocket to `/hub/node-link`, sends `control.hello` with manifest + repo inventory, and then emits a `control.heartbeat` every 20s. The hub reports the node `online` while the link is up. The client reconnects with jittered exponential backoff (1s → 60s cap) on transient close, and exits permanently on `NODE_REVOKED`, `UNAUTHORIZED`, or `PROTOCOL_INCOMPATIBLE`. Routed PTY is handled end-to-end: hub `attachPty` → `pty.attach` over the reverse link → node-side `node-pty` spawn → `pty.data` / `pty.input` / `pty.resize` / `pty.detach` round-trip. Node-side RPC method handlers (manifest refresh, repo listing) and file/git RPC remain follow-ups.

### Revocation

```http
DELETE /nodes/{nodeId}
Cookie: token={auth-cookie}
```

Revoking a node:

- Marks the node `revoked` in the registry
- Notifies active WebSocket links (close code `4003`)
- Clears pending RPCs and PTY streams
- The credential is permanently rejected on subsequent authentication attempts

The registry is stored in `<configDir>/hub-node-registry.json` (mode `0600`) with a JSON schema version of `1`.

### Security Properties

| Property                             | Implementation                                                    |
| ------------------------------------ | ----------------------------------------------------------------- |
| Pair token storage (hub)             | SHA256 hash only; raw token is never stored                       |
| Node credential storage (hub)        | SHA256 hash only; raw `token` is never stored                     |
| Node credential storage (node-local) | Raw token in `<configDir>/node-credential.json`; file mode `0600` |
| Comparison                           | `crypto.timingSafeEqual` on hex buffers                           |
| Pair token lifetime                  | Default 10 minutes; single-use; consumed on exchange              |
| Registry file                        | Written with `0600` mode; atomic write via temp+rename            |
| Revocation                           | Immediate; active links are killed; no grace period               |

## Node Manifest and Capabilities

Nodes report a capability manifest during pairing and on every heartbeat. The manifest is produced locally by `server/node-manifest.ts` and `relay-ide manifest` CLI.

### Probed Capabilities

| Capability          | Meaning                                                       |
| ------------------- | ------------------------------------------------------------- |
| `tmux`              | Tmux is installed and available for session substrate         |
| `git`               | Git CLI is available                                          |
| `clipboard`         | Clipboard image set is available (`osascript` / `xclip`)      |
| `browserAutomation` | Playwright Chromium automation is available                   |
| `githubCli`         | `gh` CLI is available                                         |
| `tailscale`         | `tailscale` CLI is available                                  |
| `ssh`               | `ssh` client is available                                     |
| `sessionResume`     | How the node persists PTYs across detach (#467)               |
| `agents`            | Map of agent CLI IDs (e.g. `claude`, `codex`) to availability |

`sessionResume` is one of:

| Value                | Meaning                                                                              |
| -------------------- | ------------------------------------------------------------------------------------ |
| `tmux`               | Node owns a tmux session per relay session; browser reload reattaches the same shell |
| `canonical-emulator` | Reserved for #469 (server-side canonical terminal)                                   |
| `none`               | Raw shell only — browser reload kills the shell                                      |

The frontend reads `sessionResume` from `HubNodeSummary.capabilities.sessionResume` and renders a `resumable` badge on the terminal-node picker when the value is non-`none`. Hubs and clients **never** reference tmux verbs directly — the capability flag is the sole interface, so phase 2 can drop in `canonical-emulator` without touching browser code.

### Service Manager

The manifest also reports the detected service manager:

| Kind             | Platform                                                 |
| ---------------- | -------------------------------------------------------- |
| `launchd`        | macOS                                                    |
| `systemd-user`   | Linux with systemd user manager                          |
| `systemd-system` | Linux with systemd system manager (not used for install) |
| `wsl-systemd`    | WSL2 with systemd enabled                                |
| `wsl-manual`     | WSL2 without systemd                                     |
| `manual`         | No supported service manager detected                    |
| `unsupported`    | Unknown / unhandled platform                             |

### WSL Detection

WSL state is reported in the manifest:

```ts
{
  detected: boolean,
  version: 1 | 2 | null,
  distroName?: string,
  systemd: boolean,
  message?: string
}
```

## Session Routing

### Creating a session on a node

```http
POST /hub/nodes/{nodeId}/sessions
Cookie: token={auth-cookie}
Content-Type: application/json

{
  "type": "agent",
  "repoPath": "/Users/kyle/dev/relay-ide",
  "worktreePath": "/Users/kyle/dev/relay-ide/.worktrees/444-vocabulary-docs",
  "cwd": "/Users/kyle/dev/relay-ide/.worktrees/444-vocabulary-docs"
}
```

The current node-side `sessions.create` parser reads `repoPath`, `worktreePath`, and `cwd`; it does not read `workspacePath`. Send `cwd` explicitly for remote repo/worktree tabs. If `cwd` is omitted, the node defaults to its host home directory until the #473 create-tab/modal split lands. In the six-layer model, `repoPath` and `worktreePath` remain compatibility fields while `cwd` maps toward the Bench anchor.

Preconditions checked by the hub:

1. Node is paired and not revoked
2. Node protocol version exactly matches hub (`RELAY_NODE_LINK_PROTOCOL_VERSION` = `1.0`)
3. Node `capabilities.core.tmux` is `available`
4. Node is `online` and has an active reverse link

If any precondition fails, the hub returns a typed error with `retryable` guidance:

| Error Code              | Meaning                               | Retryable |
| ----------------------- | ------------------------------------- | --------- |
| `NOT_FOUND`             | Node is not paired                    | No        |
| `PROTOCOL_INCOMPATIBLE` | Major version mismatch                | No        |
| `VERSION_SKEW`          | Exact version mismatch (same major)   | No        |
| `NODE_UNSUPPORTED`      | Node cannot host tmux-backed sessions | No        |
| `NODE_OFFLINE`          | Node has no live reverse link         | Yes       |

On success, the hub forwards the request as an RPC (`sessions.create`) over the node's reverse WebSocket, receives the node-local `SessionSummary`, and returns a **node-scoped** session that backs a user-visible Tab with:

- `globalSessionId`: `{encodeURIComponent(nodeId)}:{encodeURIComponent(localSessionId)}` for internal stream/routing identity
- `repoInstanceId`: `{encodeURIComponent(nodeId)}:{encodeURIComponent(repoPath)}` as a repo-kind Instance compatibility id (when applicable)
- `worktreeInstanceId`: `{encodeURIComponent(nodeId)}:{encodeURIComponent(worktreePath)}` as a git Bench compatibility id (when applicable)

### Attaching to a PTY on a node

The browser opens:

```http
GET /nodes/{nodeId}/ws/sessions/{sessionId}
```

This upgrades to a WebSocket. The hub proxies PTY I/O between the browser and the node's reverse-link `pty` channel. Resize events are sent as JSON (`{ type: 'resize', cols, rows }`) and forwarded to the node.

### Closing a remote session

Remote tab close/delete uses the hub route:

```http
DELETE /hub/nodes/{nodeId}/sessions/{sessionId}
```

The hub forwards that request over the selected node's reverse WebSocket as the `sessions.kill` RPC. The `{sessionId}` is the node-local session id paired with the `{nodeId}` path segment; hub-local sessions still close through `DELETE /sessions/{id}`. After the node-side kill completes, aggregated `GET /sessions` results should no longer include the closed remote session.

### Node-Scoped Events

Session lifecycle events (idle changes, file changes, session ended) are scoped by node ID so the hub can broadcast them to clients with the correct environment context. The `shared/node-boundary.ts` module handles creating node-scoped event payloads.

### Cross-Node Terminal Panel (Lane A of #443)

A single hub UI can host terminal tabs attached to multiple paired nodes:

- `WorkspaceTab` (`frontend/src/lib/workspace-layout.ts`) session variant carries an optional `nodeId`. Hub-local sessions omit it; routed sessions populate it from `SessionSummary.nodeId`.
- The `+` control in `WorkspaceTabBar` is rendered by `TerminalNodePicker`, which fetches `/nodes` via `fetchHubNodes()` and lists `this host` plus paired nodes. Only `online` nodes are selectable; `stale`/`offline`/`revoked` rows are disabled and surface the heartbeat status as the tooltip reason.
- Selecting a node calls `createAgentSession({ type: 'terminal', nodeId })`, which routes through `POST /hub/nodes/{nodeId}/sessions` and returns a node-scoped `SessionSummary`. The layout reconciler picks the new session up; `sessionToWorkspaceTab` copies `session.nodeId` onto the tab.
- The PTY socket (`frontend/src/lib/ws.ts`) reads `nodeId` from the session (or parses it from a global session id) and opens `/nodes/{nodeId}/ws/sessions/{localSessionId}` instead of the local `/ws/{sessionId}` route.
- Tab chrome (`WorkspaceTabBar` + `workspace-summary.ts`) shows a node label + heartbeat dot for cross-node tabs, sourced from `SummaryContext.findNode` which `WorkspaceArea` populates from the `useQuery(['hub-nodes'], fetchHubNodes)` cache (15 s refetch interval).

Reload-resume is implemented as of #467: see [SessionAttachment Boundary](#sessionattachment-boundary). The two-node smoke harness remains a follow-up under sub-issues of #443.

### SessionAttachment Boundary

`server/session-attachment.ts` exports a stable `SessionAttachment` interface between `node-link-pty-host.ts` and the concrete backend that owns the PTY. The interface intentionally hides every implementation detail (tmux verbs, node-pty handles, socket paths) so phase 2 (#469, server-side canonical terminal state) can slot in beside, not under, the tmux feature.

```ts
interface SessionAttachment {
  readonly sessionId: string;
  readonly mode: 'tmux' | 'raw';
  onData(handler: (bytes: Buffer) => void): Disposable;
  onExit(
    handler: (event: { exitCode: number; signal?: number }) => void
  ): Disposable;
  write(bytes: Buffer): void;
  resize(cols: number, rows: number): void;
  close(reason?: string): Promise<void>;
  status(): 'attached' | 'detached' | 'closed';
}
```

Backends ship with the package:

| Factory                         | Mode   | When used                                                   |
| ------------------------------- | ------ | ----------------------------------------------------------- |
| `createTmuxAttachmentFactory()` | `tmux` | `sessionResume: 'tmux'`; reload reattaches to same shell    |
| `createRawAttachmentFactory()`  | `raw`  | `sessionResume: 'none'` or `'canonical-emulator'` (phase 1) |
| `createMockAttachmentFactory()` | `tmux` | Tests — replays scripted bytes, captures writes             |

**Non-blocking constraints (#467, must hold for phase 2):**

1. No tmux strings leak past `server/node-link-pty-host.ts`. Hub registry stores `relaySessionId` only; the node maps `relaySessionId → tmux target` internally.
2. Frontend never references tmux verbs. The resumable badge reads `node.capabilities.sessionResume`.
3. Wire format unchanged — opaque bytes over WS. No frontend assumes "this looks like tmux-wrapped VT100."
4. Tests use `MockAttachment`. Pre-push CI does **not** spawn real tmux.
5. `SessionAttachment` is exported from `server/`, not `features/tmux/`. Phase 2 lives beside, not under, tmux.
6. Detach handling: on hub disconnect, tmux sessions are **not** killed. On node-link reconnect, hub re-issues `pty.attach` and the node reattaches to the same tmux session.

The tmux config is baked in (`set -g status off`, `unbind-key -a`, `set -g mouse off`, `set -g escape-time 0`). Operators never see tmux UI — tmux is an attach-by-name primitive, not a multiplexer.

The tmux config file lives under `$XDG_CONFIG_HOME/relay-ide/tmux/relay.tmux.conf` (defaults to `~/.config/relay-ide/tmux/...`) with mode `0700` on the directory and `0600` on the file — `os.tmpdir()` is shared between local UIDs and tmux configs can `run-shell` arbitrary commands, so it is not used.

**Session lifecycle:** `attachment.close()` with no reason — or any reason other than `SESSION_ATTACHMENT_KILL_REASON` — terminates only the local attach client. The tmux session keeps running and is the resume target for the next attach. Explicitly destroying a session (kill-session) requires passing the `SESSION_ATTACHMENT_KILL_REASON` sentinel; the hub uses this when the operator explicitly closes a tab, distinct from a transient browser reload.

**Raw fallback scope:** `sessionResume: 'none'` ships a working raw shell, but the v1 hub session-routing preconditions (see [Session Routing](#session-routing)) still require `core.tmux === 'available'`. The terminal picker enforces the same gate; non-tmux nodes appear disabled with reason `no tmux`. Raw shells are wired so phase 2 can drop the gate without re-doing the attachment layer.

## Repo Identity and Inventory

### Canonical Repo Identity

`shared/repo-identity.ts` normalizes git remote URLs into a canonical identity:

- SSH and HTTPS variants collapse to the same `host/path` when safe
- Fork/upstream ambiguity is flagged with a warning label
- The `origin` remote is preferred; `upstream` is used as fallback

### Aggregated Repo Inventory

Each node reports its local repo inventory in the heartbeat payload. The hub aggregates inventories across all nodes plus its own local inventory:

```http
GET /hub/repo-inventory
Cookie: token={auth-cookie}
```

Response groups repo instances by canonical git identity, showing per-node paths, branch counts, worktree counts, and online status. In #444 terms this is a repo-kind Project inventory plus git-specific Instance/Bench metadata, not the complete future Project inventory.

## Bootstrap and Service Modes

### Supported Service Modes

| Mode           | Description                                       |
| -------------- | ------------------------------------------------- |
| `manual`       | Pair credentials and exit. No background service. |
| `launchd`      | macOS user agent via `launchctl`                  |
| `systemd-user` | Linux systemd `--user` unit                       |
| `wsl-systemd`  | WSL2 with systemd enabled                         |
| `wsl-manual`   | WSL2 fallback without systemd                     |

### Bootstrap Diagnostics

The hub returns a diagnostics taxonomy covering the full bootstrap lifecycle:

| Code                            | Stage             | Meaning                                         |
| ------------------------------- | ----------------- | ----------------------------------------------- |
| `BOOTSTRAP_UNREACHABLE`         | reachability      | Cannot SSH/Tailscale to target                  |
| `BOOTSTRAP_REMOTE_SHELL_FAILED` | remote-shell      | SSH connected but shell could not run bootstrap |
| `BOOTSTRAP_INSTALL_FAILED`      | install           | `relay-ide` install failed on target            |
| `SERVICE_MANAGER_UNSUPPORTED`   | service-detection | No supported service manager found              |
| `SERVICE_START_FAILED`          | service-start     | Service installed but did not stay running      |
| `PAIR_TOKEN_INVALID`            | pair-token        | Malformed, unknown, or already consumed         |
| `PAIR_TOKEN_EXPIRED`            | pair-token        | Token expired before exchange                   |
| `NODE_CREDENTIAL_REJECTED`      | node-auth         | Credential was revoked or rejected              |
| `NODE_CONNECT_FAILED`           | connect-back      | Node cannot reach hub for heartbeat             |
| `PROTOCOL_INCOMPATIBLE`         | protocol          | Hub/node protocol versions incompatible         |
| `NODE_STARTED_NO_HEARTBEAT`     | heartbeat         | Bootstrap exited but no heartbeat observed      |

### Diagnostics Commands

```bash
relay-ide node status            # Local node state and service status
relay-ide node logs              # Service logs (launchd/systemd)
relay-ide node doctor --hub URL  # Reachability and capability checks
```

All diagnostics redact secrets (pair tokens, bearer headers, credentials) before display.

## WSL Caveats

- WSL is supported as a **Linux-like node**, not as a native Windows node.
- `node-pty → tmux → shell/agent` behave normally inside WSL2 when systemd is enabled.
- `wsl-systemd` mode requires WSL systemd and the user bus to be enabled. Set `/etc/wsl.conf` to `[boot] systemd=true`, then run `wsl.exe --shutdown` to apply. A WSL distro shutdown stops the service.
- `wsl-manual` is a pair-only fallback; no background service is installed.
- Native Windows node support is explicitly **out of scope**.
- Windows-side clipboard image paste and browser automation may degrade under WSL.
- Paths under `/mnt/c/...` work but have performance implications compared to `/home/...`.

> Hands-on WSL validation of long-running systemd services and path edge cases was partially blocked by test-environment limitations. The documented behavior reflects manifest probes and service-manager detection logic; operators should verify systemd persistence in their specific WSL distro.

## Security Model

### Assumptions

- The hub runs on **private infrastructure**: Tailscale, private mesh, or a host-restricted network.
- There is **no multi-tenant SaaS** model. Every paired node is fully trusted.
- A paired node acts as the **local OS user** on that machine. This is a privileged trust boundary.

### Trust Levels

| Level                   | Description                                                                                                                                 |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `privileged-local-user` | Default for all paired nodes. The node can execute arbitrary shell commands, access local files, and run agent CLIs as the installing user. |

### Transport Security

- Reverse WebSocket uses the same TLS/WSS as the hub's HTTPS frontend.
- Pair tokens are short-lived and single-use.
- Node credentials are persistent but revocable.
- Tailscale/SSH are **bootstrap and reachability layers only**, not the steady-state product API.

## Runbook

Operator commands and per-platform service setup have moved to `docs/RELAY_NODE_BOOTSTRAP.md`. This section retains only high-level summaries.

### Adding a new node

1. Open the hub UI → Environment Picker → Add Node.
2. Copy the generated pair token.
3. On the target machine, run `relay-ide node connect` (pair-only) or `relay-ide node install --service <mode>`.
4. Verify the node appears online in the hub dashboard.

### Removing a node

Revoke from the hub UI/API (`DELETE /nodes/{nodeId}`). The credential is immediately rejected. Clean up the local credential file on the node manually if desired. See `docs/RELAY_NODE_BOOTSTRAP.md` for full unpairing steps.

### Diagnosing an offline node

Use `relay-ide node status`, `relay-ide node logs`, and `relay-ide node doctor --hub <url>` on the node. See `docs/RELAY_NODE_BOOTSTRAP.md` for platform-specific log commands and troubleshooting taxonomy.

## Architecture Decision Records

> These ADRs are normative. Regenerate with `/adr:update` if the table drifts.

| ADR     | Topic                           | Decision                                                                                                                              |
| ------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| ADR-009 | Hub/Node Federation             | Relay hub accepts node registrations via reverse WebSocket; nodes own the PTY/tmux/data plane; hub owns routing and aggregation.      |
| ADR-010 | Node-Initiated Outbound Links   | Nodes open outbound WebSocket to the hub to avoid NAT/firewall inbound issues.                                                        |
| ADR-012 | Pair-Token/Credential Lifecycle | One-time short-lived pair token → persistent revocable node credential. SHA256 storage, timing-safe comparison, immediate revocation. |
| ADR-013 | Capability Manifest             | Nodes self-report capability probes (tmux, git, agents, etc.). Hub gates session routing on capability state.                         |
| ADR-014 | Repo Identity Aggregation       | Repos are grouped by canonical git/GitHub remote identity across nodes; local paths remain node-specific.                             |

## Non-Goals (Explicitly Out of Scope)

These were considered during design but are **not implemented** and should not be assumed:

- **Live session migration** — Moving an active PTY/agent session from one node to another.
- **Automatic filesystem sync** — Mirroring `.relay` metadata or worktree state across nodes automatically.
- **Native Windows node** — WSL2 is the supported Windows path.
- **Hosted multi-tenant cloud** — Designed for private infrastructure, not a SaaS product.
- **Anonymous worker pools** — Every node requires explicit pairing and trust.
- **Cross-host tmux session transfer** — Sessions are node-local; re-creating on another node is a cold start.
- **Real-time workspace state sync** — No conflict-free replicated worktree state.
- **Full #444 IA migration** — This document maps federation terms to the six-layer vocabulary, but it does not implement Workspace/Project/Instance/Bench CRUD, #473 right-rail migration, #428 file RPC, or a Worker tree node.

## See Also

- `docs/RELAY_NODE_BOOTSTRAP.md` — Detailed pairing commands, per-platform service setup, and bootstrap diagnostics
- `docs/ARCHITECTURE.md` — Module boundaries, REST/WebSocket API tables, composition-root invariants
- `docs/DESIGN.md` — Backend patterns, PTY management, session types, config precedence
- `shared/relay-node-protocol.ts` — Wire protocol types and constants
- `shared/node-manifest.ts` — Node capability manifest schema
- `shared/bootstrap-diagnostics.ts` — Bootstrap command generation and diagnostics taxonomy
- `server/hub-node-registry.ts` — Node registry, pairing, heartbeat, revocation
- `server/hub-node-link.ts` — Reverse WebSocket link manager
- `server/hub-node-router.ts` — REST routes for hub/node API surface
