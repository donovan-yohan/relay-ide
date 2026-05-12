# Relay Node Bootstrap

Relay uses SSH and Tailscale SSH only for bootstrap, reachability checks, diagnostics, and emergency fallback. They are not the steady-state hub-node product API. Pairing and heartbeat bootstrap are implemented here; steady-state routed sessions still require a future persistent node-side client that opens `/hub/node-link` with the stored node credential. This bootstrap slice does not start or maintain `/hub/node-link`.

## Flow

1. The hub creates a short-lived, one-time pair token with `POST /hub/pair-tokens`.
2. The response includes the raw `pairToken` for copy actions and redacted `suggestedCommands[*].redactedCommand` for safe display/logging.
3. A trusted target runs `relay-ide node connect` to pair credentials once, or `relay-ide node install` to pair credentials and install/start Relay's generic background service.
4. The node exchanges the pair token at `/hub/pairing/exchange` for a persistent revocable node credential, stores it locally with `0600` permissions, and sends an initial heartbeat. `node connect` exits after this one-shot pairing/heartbeat. `node install` then delegates service install/start to Relay's local service manager abstraction.
5. This slice stops there: installed services do not read `node-credential.json` or maintain `/hub/node-link` yet, so routed sessions still require the follow-up persistent reverse-link client.

Tokens and credentials must be redacted in logs, issue comments, and diagnostics. Use redacted command copies when rendering status or writing logs.

## Hub command generation

Authenticated request:

```http
POST /hub/pair-tokens
```

Useful body fields:

```json
{
  "displayName": "dev-macbook",
  "hubUrl": "https://hub.example.com",
  "sshTarget": "dev@example.internal",
  "tailscaleTarget": "dev@tail-host",
  "serviceModes": [
    "manual",
    "launchd",
    "systemd-user",
    "wsl-systemd",
    "wsl-manual"
  ],
  "ttlSeconds": 600
}
```

Response fields:

- `pairToken`: raw short-lived token; only use for copy-to-clipboard or process execution.
- `suggestedCommands`: command variants with `command` and `redactedCommand`.
- `diagnostics`: bootstrap failure taxonomy and user-facing hints.

## Local/manual pair-only setup

macOS or Linux one-shot pairing fallback:

```bash
relay-ide node connect \
  --hub https://hub.example.com \
  --pair-token <token>
```

This is the safest fallback for unsupported service managers when you only need to pair credentials. It is not a foreground node lifecycle: the command stores credentials, sends one initial heartbeat, then exits. A separate persistent `/hub/node-link` client is still required for steady-state routed sessions.

## macOS launchd

```bash
relay-ide node install \
  --hub https://hub.example.com \
  --pair-token <token> \
  --service launchd
```

Diagnostics/log hints (these confirm the generic Relay service; they do not prove a routed-session node link is online):

```bash
relay-ide node status
relay-ide node logs
launchctl print gui/$(id -u)/com.relay-ide
```

## Linux systemd user

```bash
relay-ide node install \
  --hub https://hub.example.com \
  --pair-token <token> \
  --service systemd-user
```

Headless Linux caveat: user services may require linger to survive logout/reboot. In this bootstrap slice, the service install does not start or maintain `/hub/node-link`:

```bash
loginctl enable-linger "$USER"
systemctl --user status relay-ide
journalctl --user -u relay-ide --no-pager -n 100
```

## Linux system service

Relay-managed node install currently writes per-user service files only. For root-owned host-level lifecycle, pair with `relay-ide node connect` or `relay-ide node install --service systemd-user` first, then create a site-specific system unit that runs the global `relay-ide` binary under the intended user. There is no `--user` flag on `relay-ide node install`. None of these commands establishes `/hub/node-link` in this slice.

## WSL

WSL2 is a Tier 1.5 Linux-like node target, not native Windows node support. The detailed support matrix and real-host validation checklist live in [`docs/WSL2_RELAY_NODE_SUPPORT.md`](./WSL2_RELAY_NODE_SUPPORT.md). This slice adds simulated diagnostics/manifest coverage, but the assigned worker did not have a reachable Windows/WSL2 host, so #378 must remain open until the real-host matrix is run.

Systemd-enabled WSL:

```bash
relay-ide node install \
  --hub https://hub.example.com \
  --pair-token <token> \
  --service wsl-systemd
```

Manual WSL one-shot pairing fallback:

```bash
relay-ide node connect \
  --hub https://hub.example.com \
  --pair-token <token>
```

WSL diagnostics are reported through the node manifest and `relay-ide node status` / `relay-ide node doctor` output:

- `wsl.supportTier`: `tier-1.5`.
- `wsl.lifecycleMode`: `wsl-systemd` or `wsl-manual`.
- `wsl.pathMode`: `wsl-native`, `windows-mount`, or `unknown`.
- `wsl.windowsPath`: display/open-in-Windows hint such as `\\wsl.localhost\Ubuntu\home\dev\repo` when the distro name is known.
- `wsl.caveats`: explicit notes for distro shutdown, outbound-only hub networking, native-Windows unsupported state, and degraded clipboard/browser/notification/port-preview behavior.

WSL limitations are explicit: distro shutdown stops WSL systemd services, `node connect` is only one-shot credential pairing, `node install --service wsl-systemd` does not establish `/hub/node-link` in this slice, and Relay does not install a Windows scheduled task in MVP. Keep execution paths as Linux paths inside WSL; treat `\\wsl.localhost\...` as a display/open-in-Windows hint only. Prefer repos under `/home`; repos under `/mnt/<drive>` are allowed but caveated for slower file watching and Windows filesystem permission/case semantics.

Native Windows relay-node support remains out of scope.

## SSH and Tailscale SSH

SSH example generated by the hub:

```bash
ssh 'dev@example.internal' 'bash -s' <<'RELAY_IDE_BOOTSTRAP'
set -euo pipefail
command -v relay-ide >/dev/null || npm install -g relay-ide
relay-ide node install --hub 'https://hub.example.com' --pair-token '<token>' --service auto
RELAY_IDE_BOOTSTRAP
```

Tailscale SSH example:

```bash
tailscale ssh 'dev@tail-host' 'bash -s' <<'RELAY_IDE_BOOTSTRAP'
set -euo pipefail
command -v relay-ide >/dev/null || npm install -g relay-ide
relay-ide node install --hub 'https://hub.example.com' --pair-token '<token>' --service auto
RELAY_IDE_BOOTSTRAP
```

Tailscale is the private reachability/trust layer. Relay does not manage tailnet ACLs in MVP. SSH/Tailscale generated commands install the same pairing/service bootstrap described above; they do not establish routed-session reverse-link traffic by themselves.

## Diagnostics taxonomy

| Code                            | Meaning                                                                                                                                                   |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BOOTSTRAP_UNREACHABLE`         | Cannot connect to host over SSH/Tailscale.                                                                                                                |
| `BOOTSTRAP_REMOTE_SHELL_FAILED` | SSH worked but the bootstrap script could not run.                                                                                                        |
| `BOOTSTRAP_INSTALL_FAILED`      | Relay install/update failed on the target.                                                                                                                |
| `SERVICE_MANAGER_UNSUPPORTED`   | No launchd/systemd/WSL service path; use `node connect` only to pair credentials, then install your own supervisor or enable a supported service manager. |
| `SERVICE_START_FAILED`          | Service installed but did not start or stay running.                                                                                                      |
| `PAIR_TOKEN_INVALID`            | Pair token is malformed, unknown, or already consumed.                                                                                                    |
| `PAIR_TOKEN_EXPIRED`            | Pair token expired before exchange.                                                                                                                       |
| `NODE_CREDENTIAL_REJECTED`      | Persistent node credential was revoked or rejected.                                                                                                       |
| `NODE_CONNECT_FAILED`           | Node cannot reach the hub for heartbeat/reverse WebSocket.                                                                                                |
| `PROTOCOL_INCOMPATIBLE`         | Hub/node protocol versions are incompatible.                                                                                                              |
| `NODE_STARTED_NO_HEARTBEAT`     | Bootstrap exited but no hub heartbeat was observed.                                                                                                       |

Use:

```bash
relay-ide node status
relay-ide node logs
relay-ide node doctor --hub https://hub.example.com
```

Do not paste raw pair tokens, bearer headers, or node credentials into logs or issue comments. Use redacted diagnostics output.
