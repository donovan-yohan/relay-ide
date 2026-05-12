# Federated Relay

Relay IDE can run as a **hub** that tracks multiple **relay-nodes** — personal machines running Relay as execution hosts. From any browser connected to the hub, a user sees which nodes are online, what repositories each node has checked out, and can start terminal/agent sessions on the chosen node. This document describes the architecture, pairing lifecycle, steady-state reverse WebSocket model, session routing, security model, operator runbook, and explicitly out-of-scope items.

> Terminology is deliberate: `hub` (control plane + UI), `node` (execution host), `client` (browser). A hub is just a `relay-ide` server that has accepted node registrations; a node is just a `relay-ide` install on another host.

## Overview

```
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

| Term | Definition |
| --- | --- |
| **Hub** | A `relay-ide` server configured to accept node registrations. May also host its own local sessions (the hub can act as its own node). |
| **Node** | A Relay install on a machine that pairs with a hub and executes sessions locally. |
| **Client UI** | The React 19 frontend running in a browser connected to the hub. |
| **Repo identity** | Canonical repository identity derived from git remotes (e.g. `github.com/donovan-yohan/relay-ide`). Same repo cloned on different nodes shares one identity. |
| **Repo instance** | A node-local checkout of a repo, identified by `(nodeId, repoPath)`. |
| **Worktree instance** | A node-local git worktree, identified by `(nodeId, worktreePath)`. |
| **Global session ID** | A node-scoped session identifier: `global:session:{nodeId}:{sessionId}`. |

## Reverse WebSocket Model

The steady-state transport is a **reverse WebSocket** opened by the node to the hub. This avoids NAT, firewall, and WSL inbound-port problems.

### Endpoint

```
GET /hub/node-link  (upgrade to WebSocket)
Authorization: Bearer {nodeId}.{secret}
```

The node presents its persistent credential as a Bearer token during the HTTP upgrade. The hub verifies it against `HubNodeRegistry` using a timing-safe SHA256 comparison.

### Link Channels

Once authenticated, the WebSocket carries multiplexed JSON envelopes:

| Channel | Direction | Purpose |
| --- | --- | --- |
| `control` | Node → Hub | `hello` on connect, periodic `heartbeat` with manifest and optional repo inventory. Hub replies with `hello.result` / `heartbeat.ack`. |
| `rpc` | Hub → Node / Node → Hub | Hub requests remote procedure calls (e.g. `sessions.create`) keyed by `requestId`. Node replies on the same `rpc` channel with the `requestId`. |
| `events` | Node → Hub | Node-to-hub async events (e.g. telemetry, session lifecycle). |
| `pty` | Bidirectional | Browser-to-node PTY byte relay. `pty.attach`, `pty.input`, `pty.resize` from hub; `pty.data`, `pty.exit`, `pty.error` from node. |
| `preview` | (future) | Port-forward / preview URL tunneling. Not implemented in v1. |

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

> Current bootstrap diagnostics pair credentials and install/start the generic Relay service only; this slice does not start or maintain `/hub/node-link`. Routed sessions still require a persistent node-side client that opens the reverse link.

### Step 3: Credential storage

The node writes its credential to:

```
~/.config/relay-ide/node-credential.json   (mode 0600)
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

A persistent node-side process reads `node-credential.json` and opens the reverse WebSocket to `/hub/node-link`, sending periodic `control.heartbeat` envelopes.

### Revocation

```http
DELETE /nodes/{nodeId}
```

Revoking a node:
- Marks the node `revoked` in the registry
- Notifies active WebSocket links (close code `4003`)
- Clears pending RPCs and PTY streams
- The credential is permanently rejected on subsequent authentication attempts

The registry is stored in `~/.config/relay-ide/node-registry.json` (mode `0600`) with a JSON schema version of `1`.

### Security Properties

| Property | Implementation |
| --- | --- |
| Pair token storage | SHA256 hash only; raw token is never stored |
| Node credential storage | SHA256 hash only; raw `token` is never stored |
| Comparison | `crypto.timingSafeEqual` on hex buffers |
| Pair token lifetime | Default 10 minutes; single-use; consumed on exchange |
| Registry file | Written with `0600` mode; atomic write via temp+rename |
| Revocation | Immediate; active links are killed; no grace period |

## Node Manifest and Capabilities

Nodes report a capability manifest during pairing and on every heartbeat. The manifest is produced locally by `server/node-manifest.ts` and `relay-ide manifest` CLI.

### Probed Capabilities

| Capability | Meaning |
| --- | --- |
| `tmux` | Tmux is installed and available for session substrate |
| `git` | Git CLI is available |
| `clipboard` | Clipboard image set is available (`osascript` / `xclip`) |
| `browserAutomation` | Playwright Chromium automation is available |
| `githubCli` | `gh` CLI is available |
| `tailscale` | `tailscale` CLI is available |
| `ssh` | `ssh` client is available |
| `agents` | Map of agent CLI IDs (e.g. `claude`, `codex`) to availability |

### Service Manager

The manifest also reports the detected service manager:

| Kind | Platform |
| --- | --- |
| `launchd` | macOS |
| `systemd-user` | Linux with systemd user manager |
| `systemd-system` | Linux with systemd system manager (not used for install) |
| `wsl-systemd` | WSL2 with systemd enabled |
| `wsl-manual` | WSL2 without systemd |
| `manual` | No supported service manager detected |
| `unsupported` | Unknown / unhandled platform |

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
Authorization: Bearer {user-cookie-token}
Content-Type: application/json

{ "type": "agent", "workspacePath": "/Users/kyle/dev/relay-ide", ... }
```

Preconditions checked by the hub:

1. Node is paired and not revoked
2. Node protocol version exactly matches hub (`RELAY_NODE_LINK_PROTOCOL_VERSION` = `1.0`)
3. Node `capabilities.core.tmux` is `available`
4. Node is `online` and has an active reverse link

If any precondition fails, the hub returns a typed error with `retryable` guidance:

| Error Code | Meaning | Retryable |
| --- | --- | --- |
| `NOT_FOUND` | Node is not paired | No |
| `PROTOCOL_INCOMPATIBLE` | Major version mismatch | No |
| `VERSION_SKEW` | Exact version mismatch (same major) | No |
| `NODE_UNSUPPORTED` | Node cannot host tmux-backed sessions | No |
| `NODE_OFFLINE` | Node has no live reverse link | Yes |

On success, the hub forwards the request as an RPC (`sessions.create`) over the node's reverse WebSocket, receives the node-local `SessionSummary`, and returns a **node-scoped** session with:

- `globalSessionId`: `global:session:{nodeId}:{sessionId}`
- `repoInstanceId`: `repo:instance:{nodeId}:{repoPath}` (when applicable)
- `worktreeInstanceId`: `worktree:instance:{nodeId}:{worktreePath}` (when applicable)

### Attaching to a PTY on a node

The browser opens:

```
GET /hub/node-link/pty/{sessionId}
```

This upgrades to a WebSocket. The hub proxies PTY I/O between the browser and the node's reverse-link `pty` channel. Resize events are sent as JSON (`{ type: 'resize', cols, rows }`) and forwarded to the node.

### Node-Scoped Events

Session lifecycle events (idle changes, file changes, session ended) are scoped by node ID so the hub can broadcast them to clients with the correct environment context. The `shared/node-boundary.ts` module handles creating node-scoped event payloads.

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
```

Response groups repo instances by canonical identity, showing per-node paths, branch counts, worktree counts, and online status.

## Bootstrap and Service Modes

### Supported Service Modes

| Mode | Description |
| --- | --- |
| `manual` | Pair credentials and exit. No background service. |
| `launchd` | macOS user agent via `launchctl` |
| `systemd-user` | Linux systemd `--user` unit |
| `wsl-systemd` | WSL2 with systemd enabled |
| `wsl-manual` | WSL2 fallback without systemd |

### Bootstrap Diagnostics

The hub returns a diagnostics taxonomy covering the full bootstrap lifecycle:

| Code | Stage | Meaning |
| --- | --- | --- |
| `BOOTSTRAP_UNREACHABLE` | reachability | Cannot SSH/Tailscale to target |
| `BOOTSTRAP_REMOTE_SHELL_FAILED` | remote-shell | SSH connected but shell could not run bootstrap |
| `BOOTSTRAP_INSTALL_FAILED` | install | `relay-ide` install failed on target |
| `SERVICE_MANAGER_UNSUPPORTED` | service-detection | No supported service manager found |
| `SERVICE_START_FAILED` | service-start | Service installed but did not stay running |
| `PAIR_TOKEN_INVALID` | pair-token | Malformed, unknown, or already consumed |
| `PAIR_TOKEN_EXPIRED` | pair-token | Token expired before exchange |
| `NODE_CREDENTIAL_REJECTED` | node-auth | Credential was revoked or rejected |
| `NODE_CONNECT_FAILED` | connect-back | Node cannot reach hub for heartbeat |
| `PROTOCOL_INCOMPATIBLE` | protocol | Hub/node protocol versions incompatible |
| `NODE_STARTED_NO_HEARTBEAT` | heartbeat | Bootstrap exited but no heartbeat observed |

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
- `wsl-systemd` mode requires WSL systemd and the user bus to be enabled. A WSL distro shutdown stops the service.
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

| Level | Description |
| --- | --- |
| `privileged-local-user` | Default for all paired nodes. The node can execute arbitrary shell commands, access local files, and run agent CLIs as the installing user. |

### Transport Security

- Reverse WebSocket uses the same TLS/WSS as the hub's HTTPS frontend.
- Pair tokens are short-lived and single-use.
- Node credentials are persistent but revocable.
- Tailscale/SSH are **bootstrap and reachability layers only**, not the steady-state product API.

## Runbook

### Adding a new node

1. Open the hub UI → Environment Picker → Add Node.
2. Copy the generated pair token (or the SSH/Tailscale command).
3. On the target machine, run `relay-ide node connect` (pair-only) or `relay-ide node install --service <mode>`.
4. Verify the node appears online in the hub dashboard.

### Removing a node

```bash
# From the hub UI or API
curl -X DELETE https://hub.example.com/nodes/{nodeId} -b "token=..."
```

Revocation is immediate. The node's credential is permanently rejected. Clean up the local credential file on the node manually if desired:

```bash
rm ~/.config/relay-ide/node-credential.json
```

### Diagnosing an offline node

```bash
# On the node
relay-ide node status
relay-ide node logs
relay-ide node doctor --hub https://hub.example.com

# On the hub
# Check the node registry for lastSeenAt and version state
```

### Protocol version mismatch

If the hub and node report incompatible protocol versions, upgrade both to the same Relay npm version. The hub rejects session routing to nodes with mismatched `relay-node-link` protocol versions.

### Service logs

| Platform | Command |
| --- | --- |
| macOS launchd | `relay-ide node logs` or `log show --predicate 'subsystem == "com.relay-ide"'` |
| Linux systemd | `journalctl --user -u relay-ide --no-pager -n 100` |
| WSL systemd | Same as Linux; may require `wsl.exe -d <distro> -u <user>` |
| Manual | No persistent logs; run `relay-ide node connect` in a terminal |

## Architecture Decision Records

> These ADRs are normative. Regenerate with `/adr:update` if the table drifts.

| ADR | Topic | Decision |
| --- | --- | --- |
| ADR-009 | Hub/Node Federation | Relay hub accepts node registrations via reverse WebSocket; nodes own the PTY/tmux/data plane; hub owns routing and aggregation. |
| ADR-010 | Node-Initiated Outbound Links | Nodes open outbound WebSocket to the hub to avoid NAT/firewall inbound issues. |
| ADR-011 | Pair-Token/Credential Lifecycle | One-time short-lived pair token → persistent revocable node credential. SHA256 storage, timing-safe comparison, immediate revocation. |
| ADR-012 | Capability Manifest | Nodes self-report capability probes (tmux, git, agents, etc.). Hub gates session routing on capability state. |
| ADR-013 | Repo Identity Aggregation | Repos are grouped by canonical git/GitHub remote identity across nodes; local paths remain node-specific. |

## Non-Goals (Explicitly Out of Scope)

These were considered during design but are **not implemented** and should not be assumed:

- **Live session migration** — Moving an active PTY/agent session from one node to another.
- **Automatic filesystem sync** — Mirroring `.relay` metadata or worktree state across nodes automatically.
- **Native Windows node** — WSL2 is the supported Windows path.
- **Hosted multi-tenant cloud** — Designed for private infrastructure, not a SaaS product.
- **Anonymous worker pools** — Every node requires explicit pairing and trust.
- **Cross-host tmux session transfer** — Sessions are node-local; re-creating on another node is a cold start.
- **Real-time workspace state sync** — No conflict-free replicated worktree state.

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
