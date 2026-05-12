# WSL2 relay-node support matrix

WSL2 is a Tier 1.5 Linux-like `relay-node` target. It is not native Windows node support, and it is not advertised as fully validated until the #378 real-host matrix runs on a Windows/WSL2 machine.

## Current validation status

| Area                               | Status                                               | Evidence                                                                                                                                                 | Product stance                                                                                                   |
| ---------------------------------- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Real WSL2 host smoke               | Blocked                                              | This slice ran from macOS 15.7.5 (`Darwin arm64`), `wsl`/`wsl.exe` were absent, and `ssh -o BatchMode=yes -o ConnectTimeout=3 wsl 'uname -a'` timed out. | Keep #378 open/blocked for empirical validation.                                                                 |
| WSL detection                      | Simulated/tested                                     | `detectWslInfo()` tests simulate WSL2 with and without systemd.                                                                                          | Capability manifest may mark `wsl.detected`, `version`, `distroName`, `supportTier`, and lifecycle/path caveats. |
| Lifecycle: systemd enabled         | Simulated/tested                                     | Unit coverage for `wsl-systemd`; docs include install/status/log commands.                                                                               | Supported when WSL systemd and the user bus are available, but distro shutdown still stops the node.             |
| Lifecycle: systemd disabled/manual | Simulated/tested                                     | Unit coverage for `wsl-manual`; bootstrap commands use `node connect` only.                                                                              | Pair-only/manual fallback. Relay does not install a Windows scheduled task in MVP.                               |
| Repo under `/home`                 | Simulated/tested                                     | Manifest path mode test for `wsl-native`.                                                                                                                | Preferred WSL execution path. PTY/git/fs paths stay Linux-native.                                                |
| Repo under `/mnt/c`                | Simulated/tested                                     | Manifest path mode test for `windows-mount`.                                                                                                             | Allowed with explicit caveats for slower file watching and Windows filesystem permission/case semantics.         |
| Native Windows node                | Explicitly unsupported                               | Docs and manifest caveats state this boundary.                                                                                                           | Out of MVP scope; run Relay inside the WSL distro instead.                                                       |
| Outbound hub link                  | Architecture-supported, not real-host validated here | Node-initiated WebSocket posture inherited from the federated node protocol.                                                                             | Do not require inbound hub-to-WSL networking.                                                                    |
| PTY/tmux/session restore           | Not real-host validated here                         | No WSL2 host was reachable from this worker.                                                                                                             | Expected Linux-like, but #378 remains open until validated.                                                      |
| Hook callback to relay-node        | Not real-host validated here                         | No WSL2 host or pair token was available.                                                                                                                | Must be validated before claiming WSL is fully supported.                                                        |
| Clipboard image paste              | Capability-gated/degraded                            | Manifest caveats call this out; no bridge is assumed.                                                                                                    | Degraded unless a distro/Windows bridge is explicitly configured.                                                |
| Browser automation                 | Capability-gated/degraded                            | Manifest reports Playwright availability separately.                                                                                                     | Available only if Linux/WSL browser deps are present.                                                            |
| Notifications                      | Unsupported/degraded                                 | No native Windows notification bridge is assumed.                                                                                                        | Do not promise notifications from WSL MVP.                                                                       |
| Port previews                      | Future/diagnostic only                               | WSL NAT/mirrored networking behavior is environment-specific.                                                                                            | Diagnose separately; avoid inbound assumptions.                                                                  |

## Runtime model

`relay-node` runs inside the WSL distro:

```text
relay-node in WSL distro
  -> node-pty Linux backend
  -> tmux
  -> shell/agent CLI inside the distro
  -> git/fs paths inside the distro
```

Use Linux paths for execution:

- Preferred: `/home/<user>/src/relay-ide`
- Allowed/caveated: `/mnt/c/Users/<user>/src/relay-ide`
- Display/open-in-Windows hint only: `\\wsl.localhost\<Distro>\...`

## Manifest fields

WSL capability state appears under `manifest.wsl`:

```json
{
  "detected": true,
  "version": 2,
  "distroName": "Ubuntu",
  "systemd": false,
  "supportTier": "tier-1.5",
  "lifecycleMode": "wsl-manual",
  "pathMode": "windows-mount",
  "windowsPath": "\\wsl.localhost\Ubuntu\mnt\c\Users\dev\relay-ide",
  "caveats": [
    "WSL is a Tier 1.5 Linux-like relay-node environment, not native Windows node support.",
    "Use outbound node-to-hub WebSocket traffic; do not require inbound hub-to-WSL networking."
  ]
}
```

`lifecycleMode` values:

- `wsl-systemd`: WSL detected, systemd detected, and the user service manager is usable.
- `wsl-manual`: WSL detected but no installable Relay-managed user service is available.

`pathMode` values:

- `wsl-native`: current working directory is under `/home`.
- `windows-mount`: current working directory is under `/mnt/<drive>`.
- `unknown`: WSL path is outside the recognized support matrix.

## Minimum real-host matrix for #378

Run this on a Windows 11/WSL2 machine before closing #378:

| Case | Distro/service             | Repo path                | Required checks                                                                   |
| ---- | -------------------------- | ------------------------ | --------------------------------------------------------------------------------- |
| A    | systemd enabled            | `/home/<user>/relay-ide` | pair node, heartbeat, create PTY, tmux restore, hook callback, git diff/file read |
| B    | systemd disabled/manual    | `/home/<user>/relay-ide` | same checks, plus foreground/manual reconnect behavior                            |
| C    | systemd enabled or manual  | `/mnt/c/.../relay-ide`   | same checks, plus watcher/path/perf caveats                                       |
| D    | NAT vs mirrored networking | any                      | outbound WebSocket connects; port preview diagnostics only if implemented         |

Minimum command transcript from the WSL distro:

```bash
uname -a
cat /proc/version
printf 'WSL_DISTRO_NAME=%s\n' "$WSL_DISTRO_NAME"
printf 'WSL_INTEROP=%s\n' "$WSL_INTEROP"
mount | grep -E ' /mnt/c |type 9p|drvfs' || true
systemctl --user status relay-ide || true
tmux -V
node -v
git --version
relay-ide manifest
relay-ide node status || true
relay-ide node doctor --hub <hub-url> || true
```

Do not paste pair tokens, bearer headers, or node credentials into public issues. Use an ephemeral pair token only through a private operator channel.
