# Relay Node Bootstrap and Operator Runbook

Operator guide for pairing, installing, updating, diagnosing, and unpairing Relay nodes that connect to a Federated Relay hub. Covers macOS launchd, Linux systemd, WSL2 caveats, manual foreground operation, token redaction, and node trust boundaries.

Relay uses one npm package for both roles. The packaging decision is documented in [Relay Hub/Node Packaging Decision](RELAY_HUB_NODE_PACKAGING.md): operators install `relay-ide` once, run the web server as `relay-ide hub`, and pair or bootstrap nodes with `relay-ide node ...`. Bare `relay-ide` and top-level `install/status/uninstall` remain back-compat hub aliases.

Relay uses SSH and Tailscale SSH only for bootstrap, reachability checks, diagnostics, emergency fallback, and optional host-binding evidence. They are not the steady-state hub-node product API and do not authorize browser, CLI, or routed session actions. Pairing and heartbeat bootstrap are handled by `relay-ide node pair` / `relay-ide node install`; the persistent steady-state reverse WebSocket `/hub/node-link` is opened by `relay-ide node link --hub <url>` (foreground), which can be wrapped by your platform service manager. Bootstrap commands (`node pair`, `node install`) themselves do not open or maintain `/hub/node-link`.

> This document is the runbook. For architecture and protocol details, see `docs/federated-relay.md`. For the generic Relay service install/uninstall (non-node), see `docs/references/deployment.md`.

## Prerequisites

- Node.js ≥ 24.0.0 (use `nvm use` from `.nvmrc` if developing)
- `relay-ide` installed globally: `npm install -g relay-ide`
- For SSH/Tailscale bootstrap: `ssh` or `tailscale` CLI on the machine that generates the pair token

## Quick Reference

| Task                             | Command                                                                                                  |
| -------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Install relay-ide binary on node | `relay-ide node install --hub <url> [--service <mode>]`                                                  |
| Pair node with hub (pair-only)   | `relay-ide node pair --hub <url> --pair-token <token>`                                                   |
| Mint pair token from grant       | `relay-ide node mint-pair-token --hub <url> --operator-grant <relay-ohg-v1...> --display-name <name>`    |
| Pair node (back-compat alias)    | `relay-ide node connect --hub <url> --pair-token <token>`                                                |
| Generate SSH bootstrap script    | `relay-ide node ssh-bootstrap --target <host> --hub <url>`                                               |
| Hold reverse node link           | `relay-ide node link --hub <url>`                                                                        |
| Check node status                | `relay-ide node status`                                                                                  |
| Read service logs                | `relay-ide node logs`                                                                                    |
| Diagnose local node health       | `relay-ide node doctor [--hub <url>] [--json]`                                                           |
| Update node helper binary        | `relay-ide node update [--hub <url>]`                                                                    |
| Check if update is available     | `relay-ide node update --check [--hub <url>]`                                                            |
| Update Relay + restart service   | `relay-ide update`                                                                                       |
| Unpair from hub                  | `DELETE /nodes/{nodeId}` from hub UI/API; then `rm ~/.config/relay-ide/node-credential.json` on the node |

## Pairing Lifecycle

### Step 1: Install the binary on the node

On the target machine (either directly or via the generated SSH bootstrap script):

```bash
# Install relay-ide globally and optionally set up the platform service.
# No pair token needed at this step.
relay-ide node install --hub https://hub.example.com --service launchd
```

If you omit `--service`, the default is `manual` (binary installed, no service unit). You can set up the service later with `relay-ide hub install`.

Supported `--service` values:

| Value          | Platform             | Behavior                                                          |
| -------------- | -------------------- | ----------------------------------------------------------------- |
| `launchd`      | macOS                | Writes `~/Library/LaunchAgents/com.relay-ide.plist` and starts it |
| `systemd-user` | Linux                | Writes `~/.config/systemd/user/relay-ide.service` and enables it  |
| `wsl-systemd`  | WSL2 with systemd    | Same as `systemd-user` with WSL caveats                           |
| `wsl-manual`   | WSL2 without systemd | Pair-only; no background service                                  |
| `manual`       | Any                  | Binary only; no background service                                |
| `auto`         | Any                  | Detects platform and chooses the best supported mode              |

### Step 2: Mint a pair token from the hub

Automation should mint a short-lived, one-time token through a previously approved operator handshake grant. The grant must use audience `relay:node-pair-token:v1`, include capability `node:pair-token:create`, and match the safe scope fields supplied with the mint request (for example `taskRef`, session/work-context binding, device id, or actor id). Browser cookies/PIN state, scoped actor tokens, node credentials, and existing pair tokens are not accepted on this automation lane.

```bash
relay-ide node mint-pair-token \
  --hub https://hub.example.com \
  --operator-grant <relay-ohg-v1...> \
  --display-name dev-macbook \
  --platform macos \
  --task-ref bootstrap-work-mac \
  --ttl-seconds 600
```

Equivalent API call:

```bash
curl -X POST https://hub.example.com/hub/pair-tokens \
  -H "Content-Type: application/json" \
  -H "X-Relay-Operator-Grant: <relay-ohg-v1...>" \
  -H "X-Relay-Actor-Type: cli" \
  -H "X-Relay-Actor-Id: ebi-cli" \
  -d '{"displayName":"dev-macbook","platform":"macos","taskRef":"bootstrap-work-mac","ttlSeconds":600,"trustTier":"sandbox"}'
```

Response includes `pairToken` and suggested bootstrap commands for each supported service mode. The grant is consumed on successful mint. The pair token remains separate bootstrap material and is accepted only by `POST /hub/pairing/exchange`.

Human fallback: an authenticated browser/PIN session may still create a pair token through the hub UI/API for manual operation. Treat that as a separate operator path, not as a reusable automation grant. Do not scrape or borrow browser cookies for Ebi/Hermes/CLI automation.

Auth lane boundary: the operator grant only authorizes minting this one pair token. The pair token is accepted only by `POST /hub/pairing/exchange`, and the resulting `node-credential.json` is accepted only by node heartbeat and `/hub/node-link`. A browser PIN/cookie is not a node credential, and a node credential does not log in to browser-only routes. Processes already running as the same OS user may still read local Relay state or run local CLIs, so the PIN should be described as browser/UI auth, not as a same-user process boundary.

### Step 3: Pair the node

On the node machine, exchange the pair token:

```bash
# Pair-only: stores credential, sends one heartbeat, then exits
relay-ide node pair --hub https://hub.example.com --pair-token <token>

# If --pair-token is omitted, the CLI prints instructions for getting one
relay-ide node pair --hub https://hub.example.com
```

`relay-ide node connect` is a back-compat alias for `pair`. Both sub-commands call the same pairing flow.

> **Important:** `node install` and `node pair` do **not** start the reverse WebSocket link `/hub/node-link`. Use `relay-ide node link --hub <url>` to hold the persistent reverse link in the foreground (or run it from your platform service manager).

### Alternative: SSH bootstrap script (one-shot remote install+pair)

To bootstrap a remote host in one step, generate a paste-able script:

```bash
relay-ide node ssh-bootstrap --target user@remote.internal --hub https://hub.example.com
```

This prints a bash script that:

1. Checks for `relay-ide` on the remote and installs it via `npm install -g relay-ide` if missing.
2. Runs `relay-ide node install --hub <url> --pair-token ... --service auto` on the remote.

The script uses a `PAIR_TOKEN` shell variable placeholder — set it at runtime before running the script. This is a **generation utility**, not an SSH product API. No SSH connection is made by the CLI itself; copy the script and run it on the remote.

Legacy combined pair+service command (still supported):

```bash
# Pair + install generic service setup in one command (legacy, requires --pair-token)
relay-ide node install --hub https://hub.example.com --pair-token <token> --service launchd
```

### Persistent /hub/node-link

```bash
relay-ide node link --hub https://hub.example.com
```

Behavior:

- Loads the credential at `~/.config/relay-ide/node-credential.json` (run `node connect` first).
- Opens an authenticated WebSocket to `<hub>/hub/node-link` and sends `control.hello` with the local manifest and repo inventory.
- Sends a `control.heartbeat` every 20s over the same link. Hub reports the node as `online` while the link is up.
- Reconnects with jittered exponential backoff (starts at 1s, caps at 60s) on transient close or socket error.
- Exits permanently when the hub returns `NODE_REVOKED`, `UNAUTHORIZED`, or `PROTOCOL_INCOMPATIBLE`.
- `SIGINT` / `SIGTERM` close the link cleanly.

`node link` also handles routed PTY traffic. When the hub calls `attachPty` for this node, it sends `pty.attach` over the link; the node spawns a real `node-pty` shell, forwards stdout/stderr as `pty.data` envelopes, and accepts inbound `pty.input` / `pty.resize` / `pty.detach`. Browser → hub → node-link → node PTY round-trips do not go through the local-mode PTY path. RPC method handlers (manifest refresh, repo listing) and file/git RPC remain follow-ups. Local Relay mode (no hub configured) still boots without attempting `/hub/node-link`.

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

#### Key-bound node identity (#981)

When pairing, the node also creates or reuses a local ed25519 identity key at:

```text
~/.config/relay-ide/node-identity-key.json   (mode 0600)
```

Only the **public** key is sent to the hub at pairing (`POST /hub/pairing/exchange`, `publicKey` field); the private key never leaves the node and is reused across re-pairs and rotations. The hub binds the public-key fingerprint (`nkey_…`) to the issued credential. For a key-bound credential, the node must prove private-key possession on `/hub/node-link` and the HTTP heartbeat: it signs a fresh, audience-bound, single-use assertion sent in the `X-Relay-Node-Proof` header on every (re)connect. A captured bearer token alone cannot keep a key-bound node online without its private key. Delete `node-identity-key.json` only if you intend to abandon the node identity; re-pairing then mints a new key and a new node identity. Legacy nodes paired before #981 (no identity key) continue on the bearer-only path.

### 4. Node identity lifecycle

The hub now separates stable node identity from credential records. The stable identity anchor is the `nodeId` and pairing timestamps; operator-facing identity metadata such as `displayName` and `hostname` describes that identity and may be refreshed by later heartbeats. The active credential is replaceable bearer material tied to that identity. `GET /nodes` returns both the identity summary and a redacted credential summary (`credentialId`, `issuedAt`, and state), never the live token or token hash.

| State            | What it means                                                                                                                                                                                                                 | Operator action                                                                                                                                                                                          |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Paired           | A one-time pair token was exchanged, the hub created a node identity, and the node stored `node-credential.json`.                                                                                                             | Start or supervise `relay-ide node link --hub <url>` for routed sessions.                                                                                                                                |
| Reconnected      | The node proves the stored credential on heartbeat or `/hub/node-link` reconnect.                                                                                                                                             | No browser cookie is involved; the node credential alone authenticates the node lane.                                                                                                                    |
| Rotating         | An operator-triggered or scheduled rotation has issued a next credential. The hub accepts the previous credential and the next credential until the node proves possession with a heartbeat carrying the next `credentialId`. | Deliver the new credential if manual; let online delivery write it over the active link if available. Do not clear a failed/delivered rotation if the node may already have written the next credential. |
| Rotated/stable   | The node proved the next credential. The hub swaps the active credential, invalidates the previous token, updates the ACL peer credential id, and preserves the same node identity.                                           | Continue normal operation.                                                                                                                                                                               |
| Revoked          | `DELETE /nodes/{nodeId}` marks the identity revoked, kills active links, and permanently rejects its credential.                                                                                                              | Remove `node-credential.json` from the node before disposal or re-pairing. The old `nodeId` remains revoked in hub history.                                                                              |
| Re-pair required | The credential is missing, malformed, mismatched with hub state, expired, revoked, protocol-incompatible, or otherwise returns `REPAIR_REQUIRED`.                                                                             | Generate a new pair token and run `relay-ide node pair`/`connect` again. Re-pairing creates a new node identity; it does not resurrect a revoked identity.                                               |

Browser auth is deliberately not part of node reconnect. A browser PIN/cookie can authorize an operator to create a pair token or initiate rotation/revocation through browser routes, but it is never accepted as a node credential. Conversely, `node-credential.json` cannot log in to browser-only routes.

Redaction rule: logs, diagnostics, node summaries, registry snapshots, audit entries, and issue comments may include `nodeId`, `credentialId`, `rotationId`, lifecycle state, node source diagnostics, the stable public-key fingerprint (`nkey_…`), and hashed/redacted scope metadata. They must not include pair tokens, raw node credential tokens, token hashes, node private keys or any PEM key block, raw proof signatures, browser cookies, raw forwarded headers, raw environment values, raw terminal bytes, full path inventories, or secret-bearing command output.

### 5. Tailscale/MagicDNS source diagnostics

When a node pairs or authenticates with its node credential, the hub records a redacted source diagnostic for that node credential lane. The signal is used for operator visibility and optional strict enforcement only; it is not a replacement for node credentials, hub ACLs, browser auth, or scoped actor credentials. Normal credential failures still fail normally; source diagnostics only annotate those failures.

Public node summaries and audit rows may expose only:

- `state`
- `policy` (`audit` or `strict-deny`)
- `reasonCode`
- `observedAt`
- stable `sourceFingerprint` such as `src_<32 hex chars>` when a usable source is present
- lossy `displayHint` such as `tailscale-ip:100.x.x.x`, `magicdns:ts.net:<suffix>`, `hostname:<suffix>`, or `no tailscale/magicdns signal`

They must not expose raw credentials, pair tokens, bearer headers, browser cookies, raw forwarded headers, raw env values, raw terminal bytes, full path inventories, full hostnames, full MagicDNS names, arbitrary unredacted DNS/host strings, or raw tailnet IPs. Treat `sourceFingerprint` as a stable correlation handle and `displayHint` as a human hint, not as the underlying source tuple.

Diagnostic states:

| State                              | Operational meaning                                                                                                                                                  | Default behavior                                                                                                                                                                                                                                       |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `signal-unavailable`               | The request did not include a usable socket/Tailscale source signal. Caller-provided source headers are not trusted as authoritative source evidence.                | Allowed and audited in default mode. With strict-deny enabled, this is denied when the credential already has a Tailscale/MagicDNS source binding, because an untrusted or missing signal cannot prove the credential is still on the expected source. |
| `source-match`                     | The observed source matches the source bound to the node credential from pairing or a prior valid reconnect.                                                         | Allowed and audited.                                                                                                                                                                                                                                   |
| `source-mismatch`                  | A usable source signal was observed, but it does not match the credential's expected source.                                                                         | If the credential otherwise validates, default audit mode allows it and surfaces the mismatch for investigation. With strict-deny mode enabled, this becomes `strict-deny`.                                                                            |
| `same-credential-multiple-sources` | The same node credential has been observed from more than one redacted source fingerprint.                                                                           | If the credential otherwise validates, default audit mode allows it as a high-suspicion warning that usually means a credential was copied or replayed. With strict-deny mode enabled, this becomes `strict-deny`.                                     |
| `strict-deny`                      | Strict source enforcement is enabled and the request either mismatched the expected source or lacked trusted source evidence for an already source-bound credential. | The node credential auth attempt is rejected with a typed `FORBIDDEN` response carrying redacted `sourceDiagnostics`.                                                                                                                                  |

By default Relay runs source diagnostics in warn/audit mode. To opt in to enforcement for node credential traffic, start the hub with:

```bash
RELAY_NODE_SOURCE_STRICT_DENY=1 relay-ide hub
```

Strict source denial is scoped to node credential authentication for heartbeat and `/hub/node-link`. It does not change browser-session routes, scoped actor credentials, pair-token exchange semantics, CLI actor-token behavior, ACL policy, or any future approval UX.

### 6. Verify the node appears online

On the node, hold the steady-state reverse link:

```bash
relay-ide node link --hub https://hub.example.com
```

Then check local diagnostics from another shell if needed:

```bash
relay-ide node status
```

On the hub, check the Environment Picker or call `GET /nodes`. A pair-only `node connect`/`node install` run sends one heartbeat, but routed sessions require the live `/hub/node-link` connection; if `node link` is not running the hub should treat the node as unavailable for remote PTY attachment.

## Per-Platform Service Setup

### macOS (launchd)

The service is installed as a user agent under `~/Library/LaunchAgents/com.relay-ide.plist`.

```bash
# Pair + install generic service setup
relay-ide node install --hub <url> --pair-token <token> --service launchd

# Hold the steady-state reverse link for routed sessions
relay-ide node link --hub <url>

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
# Pair + install generic service setup
relay-ide node install --hub <url> --pair-token <token> --service systemd-user

# Hold the steady-state reverse link for routed sessions
relay-ide node link --hub <url>

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

WSL2 is a Tier 1.5 Linux-like node target, not native Windows node support. The detailed support matrix and real-host validation checklist live in [`docs/WSL2_RELAY_NODE_SUPPORT.md`](./WSL2_RELAY_NODE_SUPPORT.md). This slice adds simulated diagnostics/manifest coverage; real-host validation is pending (#378), and #378 must remain open until the real-host matrix runs on a Windows/WSL2 machine.

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

# Then hold the reverse node link in the foreground
relay-ide node link --hub <url>
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
# Human table from the hub host
relay-ide hub nodes

# Machine-readable parity for scripts
relay-ide hub nodes --json

# Raw API equivalent
curl https://hub.example.com/nodes -b "token=<browser-session-cookie>"
```

Returns all paired nodes with `online`/`stale`/`offline`/`revoked` status, last seen timestamp, protocol/version state, and capability summary. The CLI reads the local hub port/config and requires `RELAY_IDE_BROWSER_TOKEN` for the same scoped hub API access as other CLI-gateway operations.

## Update

### Node helper update (`relay-ide node update`)

To update the helper binary on a paired node, run this command **on the node machine**:

```bash
# Install the latest version and restart the managed service if present.
relay-ide node update

# Optional: notify the hub while updating so it blocks new sessions during drain.
relay-ide node update --hub https://hub.example.com

# Non-destructive check: reports whether an update is available.
relay-ide node update --check
relay-ide node update --check --hub https://hub.example.com
```

The command:

1. Reads the current `updateChannel` from config (`stable` or `nightly`).
2. Queries `npm view relay-ide@<tag> version` to get the latest published version.
3. If already at that version, prints "already at latest" and exits 0 (idempotent).
4. If `--hub` is provided, signals `POST /hub/nodes/:nodeId/updating` — the hub marks the node as `updating` and returns HTTP 503 + `Retry-After: 60` for any new session-create requests while the update runs. Existing sessions drain naturally.
5. Runs `npm install -g relay-ide@<tag>`.
6. If `--hub` is provided, signals `DELETE /hub/nodes/:nodeId/updating` to clear the drain gate.
7. If a managed platform service is detected, stops and restarts it.

> `relay-ide node update` replaces the binary on the node and restarts the local service. It does **not** re-pair the node; the existing `node-credential.json` and hub registration remain valid.

### Hub-only `relay-ide update`

The top-level `relay-ide update` command updates the hub's own binary. It is not node-aware:

```bash
relay-ide update
```

This follows the same npm + service-restart pattern but applies to the machine it is run on, not to any paired nodes.

### Version skew model (#655)

The hub detects helper-binary version skew on every heartbeat and pair exchange. The skew category is exposed in the `helperSkew` field of each node summary (`GET /nodes`) and in the hub node dashboard.

| Category           | Condition                                 | Effect                                                                          |
| ------------------ | ----------------------------------------- | ------------------------------------------------------------------------------- |
| `compatible`       | Same major, `helperMinor >= hubMinor - 2` | No restriction                                                                  |
| `minor-skew-warn`  | Same major, minor gap > 0                 | Sessions allowed; update recommended                                            |
| `major-skew-error` | Different major version                   | New session-create returns **503** + `Retry-After: 60`; existing sessions drain |

The compatibility rule is: **same major version, node helper minor within 2 of hub minor** (or node is ahead). Nodes on a different major are fully blocked until `relay-ide node update` is run.

When a node is being updated (`status: updating`), the hub also returns 503 for new session-create requests on that node. This drain window is temporary; the hub automatically clears it when the node signals completion via `DELETE /hub/nodes/:nodeId/updating`.

To update a specific node from the hub side, you must SSH or otherwise access the node and run `relay-ide node update` there. Auto-update from the hub UI is out of scope.

## Unpairing (Revocation)

Unpairing is initiated from the hub. It is immediate and permanent.

### Hub side

From the hub UI or API:

```bash
curl -X DELETE https://hub.example.com/nodes/{nodeId} \
  -b "token=<browser-session-cookie>"
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

### Diagnose from the hub

```bash
# Human pass/fail checklist from the hub host
relay-ide hub doctor

# Machine-readable diagnostics for automation
relay-ide hub doctor --json
```

Hub doctor is intentionally cheap and read-only. It checks local config readability, scoped CLI auth token presence, hub `/version` reachability, paired node registry shape, node availability, protocol/version compatibility, `relay-pty` terminal backend availability, and hub-mediated node-log snapshot support. It reports typed reasons such as `CONFIG_MISSING`, `AUTH_TOKEN_MISSING`, `HUB_UNREACHABLE`, `NODE_OFFLINE`, `NODE_STALE`, `NODE_REVOKED`, `VERSION_SKEW`, `PROTOCOL_INCOMPATIBLE`, `UNSUPPORTED_CAPABILITY`, `MISSING_LOG_SUPPORT`, and `CHECK_SKIPPED`. It does not remediate nodes, mutate files, run arbitrary commands, or prove multi-machine topology.

### Diagnose from the node

```bash
# Full local diagnostic + hub reachability check
relay-ide node doctor --hub https://hub.example.com

# Structured JSON output for scripts and automation
relay-ide node doctor --hub https://hub.example.com --json
```

This prints (human-readable):

- Host info: hostname, platform, arch, relay version, protocol version
- Service manager kind and whether it is supported
- Whether the local service is installed and running
- All degraded reasons from the node manifest (every `warn` or `error` reason)
- Hub `/version` reachability result

`--json` output shape:

```json
{
  "ok": true,
  "hostname": "dev-macbook",
  "platform": "darwin",
  "arch": "arm64",
  "helperVersion": "0.4.2",
  "serviceManager": { "kind": "launchd", "supported": true, "message": "..." },
  "degradedReasons": [],
  "hubUrl": "https://hub.example.com",
  "hubReachable": true
}
```

Exit code is 0 when `ok` is true (no `warn` or `error` degraded reasons and hub reachable if `--hub` supplied), 1 otherwise.

### Optional rmux capability probe

`relay-ide manifest` and node diagnostics may include an `rmux` capability record when an `rmux` binary or `RMUX_SDK_DAEMON_BINARY` helper override is visible on the node. This is diagnostic-only: Relay does not bundle rmux, install rmux, supervise an rmux daemon, or switch the terminal/session backend to rmux by default.

If `RMUX_SDK_DAEMON_BINARY` is set, the probe executes that explicit helper override rather than silently falling back to a different `rmux` found on `PATH`. A bad override is reported as a non-fatal `probe-failed` capability so bootstrap and doctor output can show the configuration problem without blocking the existing Relay backend.

### Service logs by platform

| Platform      | Command                                                                        |
| ------------- | ------------------------------------------------------------------------------ |
| macOS launchd | `relay-ide node logs` or `log show --predicate 'subsystem == "com.relay-ide"'` |
| Linux systemd | `journalctl --user -u relay-ide --no-pager -n 100`                             |
| WSL systemd   | Same as Linux; may need `wsl.exe -d <distro> -u <user>`                        |
| Manual        | No persistent logs; run `relay-ide node doctor` in the terminal                |

### Common bootstrap diagnostics

| Code                             | Meaning                                                                                  | Recovery                                                                                 |
| -------------------------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `PAIR_TOKEN_INVALID`             | Token malformed, consumed, or unknown                                                    | Generate a new token from the hub                                                        |
| `PAIR_TOKEN_EXPIRED`             | Token lifetime exceeded (default 10 min)                                                 | Generate a new token and retry quickly                                                   |
| `SERVICE_MANAGER_UNSUPPORTED`    | No launchd/systemd found                                                                 | Use `--service manual` or fix the service manager                                        |
| `NODE_CONNECT_FAILED`            | Node cannot reach hub URL                                                                | Check DNS, firewall, proxy, TLS                                                          |
| `PROTOCOL_INCOMPATIBLE`          | Hub/node protocol version mismatch                                                       | Update both hub and node to the same Relay version                                       |
| `NODE_STARTED_NO_HEARTBEAT`      | Bootstrap finished but hub sees no heartbeat                                             | Run `relay-ide node status` and `relay-ide node doctor` on the node                      |
| `NODE_SOURCE_SIGNAL_UNAVAILABLE` | No usable Tailscale/MagicDNS source signal was available for node credential diagnostics | Check proxy/Tailscale topology if you expected a signal; authentication still proceeds   |
| `NODE_SOURCE_MISMATCH`           | Node credential was presented from a different source fingerprint than expected          | Investigate copied credentials or topology changes; strict mode denies this path         |
| `NODE_SOURCE_MULTIPLE_SOURCES`   | Same node credential has appeared from multiple source fingerprints                      | Treat as suspicious credential reuse; rotate/revoke/re-pair if unexpected                |
| `NODE_SOURCE_STRICT_DENY`        | `RELAY_NODE_SOURCE_STRICT_DENY=1` rejected a mismatched reachable source                 | Re-pair from the intended source or disable strict mode if topology legitimately changed |

All diagnostic output redacts secrets and source material before display. See Token Redaction and Tailscale/MagicDNS source diagnostics above.

### Credential rejected after revocation

If you see `NODE_CREDENTIAL_REJECTED`:

1. Confirm the node was revoked from the hub (`GET /nodes` shows `revoked`)
2. Delete `~/.config/relay-ide/node-credential.json`
3. Generate a new pair token and re-pair

## Node Trust Boundaries

### Assumptions

- The hub runs on **private infrastructure**: Tailscale, private mesh, or host-restricted network.
- There is **no multi-tenant SaaS** model; every node still requires explicit pairing and a revocable credential.
- A paired node acts as the **local OS user** on that machine. The hub ACL constrains Relay protocol surfaces; it does not sandbox the OS user.

### Trust tiers and default ACL

| Tier      | Blast radius                                                                                                   |
| --------- | -------------------------------------------------------------------------------------------------------------- |
| `sandbox` | Experimental/constrained node. Keep grants narrow.                                                             |
| `dev`     | Default legacy private-infra node. Read/session-safe bits are granted by migration; destructive bits stay off. |
| `prod`    | Sensitive node. High-risk allowed bits may require confirmation and must never be silently widened.            |

Legacy paired nodes receive a default `dev` ACL on upgrade. Session/read-safe bits are allowed; file write/delete, git write, arbitrary exec, and preview/port-forward remain off unless explicitly granted. Node manifest capabilities are availability probes only, not grants. See `docs/SECURITY_POLICY.md`.

To grant `rpc:fs:write` on a paired node (e.g. for an agent brain that needs to write files):

```bash
relay-ide hub node acl --node-id <node-id> --grant rpc:fs:write
```

Prod-tier nodes additionally require a human-approved exact-operation confirmation challenge on each high-risk write request; dev/sandbox-tier nodes execute immediately once the capability is granted unless the hub ACL explicitly marks the bit as confirmation-required.

Approval is per operation, not per node and not per agent. When a routed request pauses, the operator should inspect the challenge metadata: action, target node, session/work-context ids, required and challenged bits, policy/ACL refs, expiry, reason code, canonical params hash, and operation-specific params such as path/mode/byte count/content SHA-256 for file writes. The approval token is one-time and must be redeemed by the original requester for the same operation. Deny, expiry, mismatch, wrong requester, wrong approval target, self-approval, audit failure, or token reuse all fail closed; a retry starts with a new command and a fresh challenge.

The safe public fields are node/session/work-context ids, challenge id/status, capability bits, timestamps, reason codes, redacted identity hashes/display names, params hashes, and operation summaries. Do not put raw confirmation tokens, browser cookies, node credentials, actor bearer tokens, pair tokens, raw file bytes, full environment values, or secret-looking command text into tickets, logs, screenshots, or chat handoffs.

The current MVP uses the existing authenticated hub confirmation endpoints and UI path. Passkey/WebAuthn/TOTP, stronger approval auth, broad approval-center UX, and multi-approver policy are future work behind the same exact-operation contract, not part of this runbook slice.

This is a privileged local-user blast radius. Do not pair nodes you do not control.

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
| `Authorization: Bearer <value>`        | `Authorization: Bearer …redacted` |
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
