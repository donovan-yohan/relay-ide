# Relay Node Bootstrap and Operator Runbook

Operator guide for pairing, installing, updating, diagnosing, and unpairing Relay nodes that connect to a Federated Relay hub. Covers macOS launchd, Linux systemd, WSL2 caveats, manual foreground operation, token redaction, and node trust boundaries.

Relay uses one npm package for both roles. The packaging decision is documented in [Relay Hub/Node Packaging Decision](RELAY_HUB_NODE_PACKAGING.md): operators install `relay-ide` once, run the web server as `relay-ide hub`, and pair or bootstrap nodes with `relay-ide node ...`. Bare `relay-ide` and top-level `install/status/uninstall` remain back-compat hub aliases.

Relay uses SSH and Tailscale SSH only for bootstrap, reachability checks, diagnostics, and emergency fallback. They are not the steady-state hub-node product API. Pairing and heartbeat bootstrap are implemented here; steady-state routed sessions still require a future persistent node-side client that opens `/hub/node-link` with the stored node credential. This bootstrap slice does not start or maintain `/hub/node-link`.

> This document is the runbook. For architecture and protocol details, see `docs/federated-relay.md`. For the generic Relay service install/uninstall (non-node), see `docs/references/deployment.md`.

## Prerequisites

- Node.js ≥ 24.0.0 (use `nvm use` from `.nvmrc` if developing)
- `relay-ide` installed globally: `npm install -g relay-ide`
- For SSH/Tailscale bootstrap: `ssh` or `tailscale` CLI on the machine that generates the pair token

## Quick Reference

| Task                           | Command                                                                                                  |
| ------------------------------ | -------------------------------------------------------------------------------------------------------- |
| Pair node (pair-only)          | `relay-ide node connect --hub <url> --pair-token <token>`                                                |
| Pair + install service         | `relay-ide node install --hub <url> --pair-token <token> --service <mode>`                               |
| Check node status              | `relay-ide node status`                                                                                  |
| Read service logs              | `relay-ide node logs`                                                                                    |
| Diagnose hub reachability      | `relay-ide node doctor --hub <url>`                                                                      |
| Update Relay + restart service | `relay-ide update`                                                                                       |
| Unpair from hub                | `DELETE /nodes/{nodeId}` from hub UI/API; then `rm ~/.config/relay-ide/node-credential.json` on the node |

## Pairing Lifecycle

### 1. Generate a pair token from the hub

An authenticated hub user creates a short-lived, one-time token:

```bash
curl -X POST https://hub.example.com/hub/pair-tokens \
  -H "Content-Type: application/json" \
  -b "token=<auth-cookie>" \
  -d '{"displayName":"dev-macbook","ttlSeconds":600}'
```

Response includes `pairToken` and suggested bootstrap commands for each supported service mode.

### 2. Bootstrap the node

On the target machine, run one of the following depending on the desired service mode:

```bash
# Pair-only: stores credential, sends one heartbeat, then exits
relay-ide node connect --hub https://hub.example.com --pair-token <token>

# Pair + install a persistent background service
relay-ide node install --hub https://hub.example.com --pair-token <token> --service launchd
```

Supported `--service` values:

| Value          | Platform             | Behavior                                                          |
| -------------- | -------------------- | ----------------------------------------------------------------- |
| `launchd`      | macOS                | Writes `~/Library/LaunchAgents/com.relay-ide.plist` and starts it |
| `systemd-user` | Linux                | Writes `~/.config/systemd/user/relay-ide.service` and enables it  |
| `wsl-systemd`  | WSL2 with systemd    | Same as `systemd-user` with WSL caveats                           |
| `wsl-manual`   | WSL2 without systemd | Pair-only; no background service                                  |
| `manual`       | Any                  | Pair-only; no background service                                  |
| `auto`         | Any                  | Detects platform and chooses the best supported mode              |

> **Important:** Current bootstrap diagnostics pair credentials and install/start the generic Relay service only; they do **not** start or maintain the reverse WebSocket link `/hub/node-link`. Routed sessions still require a persistent node-side client that opens the reverse link.

### 3. Credential storage

After successful pairing, the node writes its persistent credential to:

```text
~/.config/relay-ide/node-credential.json   (mode 0600)
```

Format:

```json
{
  "protocol": "relay-node-link",
  "protocolVersion": "1.0",
  "nodeId": "node_...",
  "credentialId": "cred_...",
  "token": "***",
  "issuedAt": "2026-05-12T..."
}
```

This file is required for the node to authenticate heartbeats and the reverse WebSocket. Do not copy it between machines.

### 4. Verify the node appears online

On the node:

```bash
relay-ide node status
```

On the hub, check the Environment Picker or call `GET /nodes`.

## Per-Platform Service Setup

### macOS (launchd)

The service is installed as a user agent under `~/Library/LaunchAgents/com.relay-ide.plist`.

```bash
# Pair + install + start
relay-ide node install --hub <url> --pair-token <token> --service launchd

# Check status
relay-ide node status
relay-ide status
launchctl print gui/$(id -u)/com.relay-ide

# Stop the service
launchctl stop com.relay-ide

# Start it again
launchctl start com.relay-ide

# Read logs
relay-ide node logs
log show --predicate 'subsystem == "com.relay-ide"'
```

The plist uses `RunAtLoad` + `KeepAlive`. Logs are written to `~/.config/relay-ide/logs/`.

### Linux (systemd --user)

The service is installed as a per-user unit under `~/.config/systemd/user/relay-ide.service`.

```bash
# Pair + install + start
relay-ide node install --hub <url> --pair-token <token> --service systemd-user

# Check status
relay-ide node status
systemctl --user status relay-ide

# Read logs
relay-ide node logs
journalctl --user -u relay-ide --no-pager -n 100

# Enable boot persistence (headless servers)
loginctl enable-linger $USER
```

On headless Linux, run `loginctl enable-linger $USER` so the user service survives logout.

### WSL2

WSL2 is a Tier 1.5 Linux-like node target, not native Windows node support. The detailed support matrix and real-host validation checklist live in [`docs/WSL2_RELAY_NODE_SUPPORT.md`](./WSL2_RELAY_NODE_SUPPORT.md). This slice adds simulated diagnostics/manifest coverage; #378 must remain open until the real-host matrix runs on a Windows/WSL2 machine.

1. **systemd must be explicitly enabled** in `/etc/wsl.conf`:

   ```ini
   [boot]
   systemd=true
   ```

   Then `wsl.exe --shutdown` to apply. The service runs only while the WSL distro is running.

2. **Without systemd**, use `wsl-manual` mode (pair-only foreground):

   ```bash
   relay-ide node install --hub <url> --pair-token <token> --service wsl-manual
   ```

WSL service lifetime is tied to the distro. A WSL shutdown stops the node. Native Windows relay-node support remains out of scope.

### Manual / Foreground

For machines where no background service manager is available, or when you want to run Relay interactively:

```bash
# Pair only
relay-ide node connect --hub <url> --pair-token <token>

# Then run Relay in the foreground
relay-ide --port 3456
```

Manual mode has no Relay-managed logs. Use terminal output or redirect to a file.

## Status Checks

WSL diagnostics are reported through the node manifest and `relay-ide node status` / `relay-ide node doctor` output:

- `wsl.supportTier`: `tier-1.5`.
- `wsl.lifecycleMode`: `wsl-systemd` or `wsl-manual`.
- `wsl.pathMode`: `wsl-native`, `windows-mount`, or `unknown`.
- `wsl.windowsPath`: display/open-in-Windows hint such as `\\wsl.localhost\Ubuntu\home\dev\repo` when the distro name is known.
- `wsl.caveats`: explicit notes for distro shutdown, outbound-only hub networking, native-Windows unsupported state, and degraded clipboard/browser/notification/port-preview behavior.

WSL limitations are explicit: distro shutdown stops WSL systemd services, `node connect` is only one-shot credential pairing, `node install --service wsl-systemd` does not establish `/hub/node-link` in this slice, and Relay does not install a Windows scheduled task in MVP. Keep execution paths as Linux paths inside WSL; treat `\\wsl.localhost\...` as a display/open-in-Windows hint only. Prefer repos under `/home`; repos under `/mnt/<drive>` are allowed but caveated for slower file watching and Windows filesystem permission/case semantics.

### Node-level status

```bash
relay-ide node status
```

Outputs:

- Hostname, platform, architecture
- Relay version
- Service manager kind and label
- Whether the local service is installed and running
- Manager-specific caveats

### Generic service status

```bash
relay-ide status
```

Reports the same service manager state, but from the generic `install`/`uninstall`/`status` path rather than the node-specific wrapper.

### Hub-side node list

```bash
curl https://hub.example.com/nodes -b "token=<auth-cookie>"
```

Returns all paired nodes with `online`/`stale`/`offline`/`revoked` status, last seen timestamp, and capability summary.

## Update

To update the node to the latest Relay version:

```bash
relay-ide update
```

This:

1. Reads the current `updateChannel` from config (`stable` or `nightly`)
2. Runs `npm install -g relay-ide@<latest|nightly>`
3. If a background service is detected, stops it, reinstalls with the new binary, and restarts it

> The `update` command updates the global npm package and restarts the local service. It does **not** re-pair the node; the existing `node-credential.json` remains valid.

To update a specific node from the hub side, you must SSH or otherwise access the node and run `relay-ide update` there. There is no remote forced-upgrade mechanism.

## Unpairing (Revocation)

Unpairing is initiated from the hub. It is immediate and permanent.

### Hub side

From the hub UI or API:

```bash
curl -X DELETE https://hub.example.com/nodes/{nodeId} \
  -b "token=<auth-cookie>"
```

Effects:

- The node record is marked `revoked`
- Active WebSocket links receive close code `4003` (`NODE_REVOKED`)
- Pending RPCs and PTY streams are cleaned up
- The credential hash is removed from the registry; subsequent authentication attempts with that token are rejected

### Node side cleanup

After revocation, clean up the local credential file:

```bash
rm ~/.config/relay-ide/node-credential.json
```

If a background service is still running, it will fail to authenticate on its next heartbeat or WebSocket reconnect. You may also want to uninstall the service:

```bash
relay-ide uninstall
```

> There is no `relay-ide node unpair` CLI command. Unpairing is always hub-driven. The node cannot revoke itself.

## Troubleshooting

### Diagnose from the node

```bash
# Full local diagnostic + hub reachability check
relay-ide node doctor --hub https://hub.example.com
```

This prints:

- Local capability manifest (tmux, git, agents, etc.)
- Service manager detection result
- Whether the hub `/version` endpoint is reachable

### Service logs by platform

| Platform      | Command                                                                        |
| ------------- | ------------------------------------------------------------------------------ |
| macOS launchd | `relay-ide node logs` or `log show --predicate 'subsystem == "com.relay-ide"'` |
| Linux systemd | `journalctl --user -u relay-ide --no-pager -n 100`                             |
| WSL systemd   | Same as Linux; may need `wsl.exe -d <distro> -u <user>`                        |
| Manual        | No persistent logs; run `relay-ide node doctor` in the terminal                |

### Common bootstrap diagnostics

| Code                          | Meaning                                      | Recovery                                                            |
| ----------------------------- | -------------------------------------------- | ------------------------------------------------------------------- |
| `PAIR_TOKEN_INVALID`          | Token malformed, consumed, or unknown        | Generate a new token from the hub                                   |
| `PAIR_TOKEN_EXPIRED`          | Token lifetime exceeded (default 10 min)     | Generate a new token and retry quickly                              |
| `SERVICE_MANAGER_UNSUPPORTED` | No launchd/systemd found                     | Use `--service manual` or fix the service manager                   |
| `NODE_CONNECT_FAILED`         | Node cannot reach hub URL                    | Check DNS, firewall, proxy, TLS                                     |
| `PROTOCOL_INCOMPATIBLE`       | Hub/node protocol version mismatch           | Update both hub and node to the same Relay version                  |
| `NODE_STARTED_NO_HEARTBEAT`   | Bootstrap finished but hub sees no heartbeat | Run `relay-ide node status` and `relay-ide node doctor` on the node |

All diagnostic output redacts secrets before display. See Token Redaction below.

### Credential rejected after revocation

If you see `NODE_CREDENTIAL_REJECTED`:

1. Confirm the node was revoked from the hub (`GET /nodes` shows `revoked`)
2. Delete `~/.config/relay-ide/node-credential.json`
3. Generate a new pair token and re-pair

## Node Trust Boundaries

### Assumptions

- The hub runs on **private infrastructure**: Tailscale, private mesh, or host-restricted network.
- There is **no multi-tenant SaaS** model. Every paired node is fully trusted.
- A paired node acts as the **local OS user** on that machine.

### Trust level

| Level                   | Description                                                                                                                                 |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `privileged-local-user` | Default for all paired nodes. The node can execute arbitrary shell commands, access local files, and run agent CLIs as the installing user. |

This is a privileged trust boundary. Do not pair nodes you do not fully trust. There is no sandboxing or privilege separation beyond the OS user boundary.

### Transport security

- Reverse WebSocket uses the same TLS/WSS as the hub's HTTPS frontend.
- Pair tokens are short-lived (default 10 minutes) and single-use.
- Node credentials are persistent but revocable.
- SSH/Tailscale are **bootstrap and reachability layers only**, not the steady-state product API.

## Token Redaction

All CLI output, diagnostics, and bootstrap command generation redact sensitive tokens before display:

| Pattern                                | Redacted form                     |
| -------------------------------------- | --------------------------------- |
| `--pair-token <value>`                 | `--pair-token pair_…redacted`     |
| `pair_...` tokens                      | `pair_…redacted`                  |
| `node_...._....secret_...` credentials | `node_…redacted.secret_…redacted` |
| `secret_...` fragments                 | `secret_…redacted`                |
| `Authorization: Bearer ***        | `Authorization: Bearer *** |
| `Bearer <token>`                       | `Bearer …redacted`                |

The redaction is applied by `redactBootstrapSecrets()` in `shared/bootstrap-diagnostics.ts`.

## Service File Locations

| Platform            | File                                                |
| ------------------- | --------------------------------------------------- |
| macOS               | `~/Library/LaunchAgents/com.relay-ide.plist`        |
| Linux systemd       | `~/.config/systemd/user/relay-ide.service`          |
| Logs (macOS)        | `~/.config/relay-ide/logs/stdout.log`, `stderr.log` |
| Config + credential | `~/.config/relay-ide/`                              |

## See Also

- `docs/federated-relay.md` — Hub/node architecture, reverse WebSocket protocol, session routing, ADRs
- `docs/references/deployment.md` — Generic Relay install/uninstall, npm publish, branching
- `docs/SELF_HOSTING.md` — Building Relay from inside Relay (dev mode isolation)
- `server/service.ts` — Service file generation, install/uninstall/status implementation
- `shared/bootstrap-diagnostics.ts` — Bootstrap command generation and diagnostics taxonomy