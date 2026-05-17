# Devbox hub deploy and process hygiene runbook

Use this when a Relay change needs proof on the shared dogfood topology: the devbox hub on `dev` (`100.77.36.51:3456`) with the Mac node `macbook-relay-node` linked back to it. Use placeholders for auth-bearing values in public comments; never paste pair tokens, bearer tokens, cookies, node credentials, or private auth URLs.

This runbook is an operator checklist, not a live-deploy transcript. Only claim a command in an issue or PR comment after you ran it.

## Decision tree

| Need                                                  | Use                                                                                                              | Devbox proof required? |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ---------------------- |
| Type/lint/unit confidence only                        | Local worktree: `npm run check`, targeted `npm test -- <files>`, `npm run build` when relevant                   | No                     |
| Local source behavior without touching shared dogfood | `npm run dev:self` from an isolated worktree; open the printed self-host frontend URL                            | No                     |
| Hub-only dogfood behavior                             | Source deploy/restart on the devbox hub; Mac node can keep running if the node/protocol surface did not change   | Yes                    |
| Node-only behavior on the Mac                         | Update/restart the Mac `relay-ide node link`; hub can keep running if the hub/protocol surface did not change    | Yes                    |
| Protocol or shared hub/node envelope change           | Update hub and every affected node from the same source SHA or published package version before testing          | Yes                    |
| Post-merge package validation                         | Install/update `relay-ide@nightly`, restart the service, then verify package version and routed session behavior | Yes                    |

Prefer the cheapest path that proves the claim. Do not use a local self-host run as evidence that the devbox hub works; it proves only the local isolated instance.

## Source deploy to the devbox hub

Use source mode when testing an unmerged branch or a PR head before `nightly` publishes it.

1. SSH to the devbox and enter the Relay checkout that backs the service:

   ```bash
   ssh dev
   cd /path/to/relay-ide
   git status --short --branch
   ```

2. Move to the exact branch or SHA under test:

   ```bash
   git fetch origin
   git checkout <branch-or-sha>
   git pull --ff-only origin <branch>   # branch only; skip for detached SHA
   ```

3. Rebuild and relink the global binary to this checkout:

   ```bash
   scripts/dev-resync.sh
   relay-ide --version
   ```

   `relay-ide --version` should include the source short SHA. If it says only the package version, the global command is still resolving to an npm install instead of the source checkout.

4. Restart the hub service through the platform manager used on that host:

   ```bash
   relay-ide hub status
   systemctl --user restart relay-ide
   relay-ide hub status
   relay-ide hub logs --lines 80
   ```

   If the devbox is not using systemd-user, use the manager reported by `relay-ide hub status`. Do not uninstall/reinstall just to restart unless the service file itself is wrong.

## Nightly/package deploy to the devbox hub

Use package mode after the PR has merged to `nightly` and the publish workflow has produced `relay-ide@nightly`.

```bash
ssh dev
npm install -g relay-ide@nightly
relay-ide --version
relay-ide hub status
systemctl --user restart relay-ide
relay-ide hub status
relay-ide hub logs --lines 80
```

`relay-ide update` is also valid when the devbox config already has the desired update channel; it updates the global package and restarts a detected service without re-pairing nodes.

## Mac node-link update/restart

Restart the Mac node link when node-side code changed, the protocol version changed, or hub verification reports `macbook-relay-node` as offline, stale, or incompatible. A hub-only UI/routing change does not require a node restart.

For source testing on the Mac node checkout:

```bash
cd /path/to/relay-ide
scripts/dev-resync.sh
relay-ide --version
relay-ide node status
relay-ide node doctor --hub <devbox-hub-url>
relay-ide node link --hub <devbox-hub-url>
```

For package testing after `nightly` publishes:

```bash
npm install -g relay-ide@nightly
relay-ide --version
relay-ide node status
relay-ide node doctor --hub <devbox-hub-url>
relay-ide node link --hub <devbox-hub-url>
```

`relay-ide node link` is the persistent reverse WebSocket used for routed sessions. `relay-ide node connect` and `relay-ide node install` are bootstrap steps; they do not by themselves prove routed sessions are available.

If the node link is supervised by launchd or another wrapper, restart that exact wrapper. On macOS, first inspect the Relay label before touching it; prefer `kickstart -k` over a manual stop/start because `KeepAlive` agents can immediately restart between commands:

```bash
relay-ide node status
launchctl print gui/$(id -u)/com.relay-ide
launchctl kickstart -k gui/$(id -u)/com.relay-ide
relay-ide node logs
```

## Verification checklist

Run the applicable checks and record redacted evidence. Run service-manager and package-version commands on the host being verified: use SSH for devbox hub service checks, and run Mac launchd/node-link checks on the Mac. Remote HTTP health can be checked from any trusted operator machine. If you run hub CLI checks locally against the devbox instead of over SSH, pass the devbox hub URL through the supported CLI flag/env for that command rather than accidentally querying a local Relay daemon.

### Hub health and version

```bash
DEVBOX_HUB=http://100.77.36.51:3456
curl -fsS "$DEVBOX_HUB/health"
ssh dev 'relay-ide --version'
ssh dev 'systemctl --user status relay-ide --no-pager'
ssh dev 'relay-ide hub doctor'
```

`/health` is unauthenticated and should return `{"status":"ok"}`. `hub doctor` may require the scoped CLI/browser token available in the target environment for authenticated hub checks; do not paste that token or any auth-bearing URL.

### Node registry and protocol state

```bash
ssh dev 'relay-ide hub nodes'
ssh dev 'relay-ide hub nodes --json'
ssh dev 'relay-ide hub doctor'
```

Confirm `macbook-relay-node` is online/current and protocol-compatible. If `VERSION_SKEW` or `PROTOCOL_INCOMPATIBLE` appears, update both hub and node to the same source SHA or package channel before debugging higher-level behavior.

### Routed session proof

Use a safe remote terminal/session through the hub UI or CLI path that targets `macbook-relay-node`. The proof should show:

- the session is anchored to `macbook-relay-node`, not the local laptop hub;
- `pwd` or another harmless command runs on the expected node host;
- no secrets, private file contents, pair tokens, bearer tokens, or cookies appear in the captured output.

## Process hygiene

Stale local processes can make a devbox test look local-only. Identify before killing. Kill only a specific PID or tmux session after confirming its command, cwd, port, and role.

### Roles to distinguish

| Role                    | Typical signal                                                                                                                             | Safe action                                                                              |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| Production/global hub   | `relay-ide hub` or `node dist/server/index.js` on `0.0.0.0:3456`, config under `~/.config/relay-ide/config.json`, tmux prefix `relay-ide-` | Do not kill unless you intend to stop the hosted Relay service                           |
| Ordinary source dev hub | backend `127.0.0.1:3457`, Vite `127.0.0.1:5173`, config `./config.dev.json`, tmux prefix `relay-dev-`                                      | Stop the owning dev terminal, or kill the verified stale PID                             |
| Self-host source hub    | allocator ports usually `10000-11999`, config under `~/.config/relay-ide/self-host/`, tmux prefix `relay-self-`                            | Stop the owning self-host terminal, or kill only the verified stale PID/session          |
| Vite frontend           | `vite --config frontend/vite.config.ts` on the printed frontend port                                                                       | Kill only if it belongs to the stale self-host/dev run                                   |
| Node link               | `relay-ide node link --hub ...`                                                                                                            | Do not kill during federated proof unless you are intentionally restarting the node link |
| Test/fixture server     | Playwright/Vitest or sandbox command, often temporary port                                                                                 | Let the test own it unless it is orphaned and verified stale                             |

### Inspect listeners and commands

```bash
lsof -nP -iTCP:3456 -sTCP:LISTEN
lsof -nP -iTCP:3457 -sTCP:LISTEN
lsof -nP -iTCP:5173 -sTCP:LISTEN
ps -p <pid> -o pid,ppid,lstart,command
lsof -p <pid> | grep cwd
```

For self-host ports, use the startup output or `.env` managed block to identify the assigned ports, then inspect those ports with `lsof`.

### Inspect Relay tmux sessions

```bash
tmux ls | grep '^relay-ide-\|^relay-dev-\|^relay-self-'
tmux display-message -p -t <session-name> '#S #{session_created_string}'
```

Kill only the session you have identified:

```bash
tmux kill-session -t <session-name>
```

Never use `tmux kill-server` as a cleanup shortcut. It can kill production Relay sessions and active agent work.

### Kill a stale PID safely

```bash
ps -p <pid> -o pid,ppid,lstart,command
lsof -p <pid> | grep cwd
kill <pid>
sleep 2
ps -p <pid> -o pid,ppid,command || true
```

Escalate to `kill -KILL <pid>` only after the normal `SIGTERM` fails and you have rechecked that the PID has not been reused. Avoid `killall node`, broad `pkill -f relay-ide`, and broad process-name cleanup; they are how you murder the wrong fish in the tank.

## Evidence template

Paste a compact version into the PR or issue after deploy. Delete sections you did not run.

```markdown
Devbox deploy evidence for <PR/issue>:

- Scope: <local/self-host/devbox source/nightly package; hub-only/node-only/protocol>
- Hub host: dev / 100.77.36.51:3456
- Hub deploy path: <source branch + Git SHA OR relay-ide@nightly version>
- Hub restart: <command run; status/log result>
- Hub health: `curl /health` -> <status/body>
- Hub version: `relay-ide --version` -> <version and source SHA if available>
- Hub doctor: <pass/fail summary; include typed failure names only>
- Node update/restart: <not required OR command run + reason>
- Node version: <Mac `relay-ide --version` output, including source SHA if available>
- Node registry: `macbook-relay-node` <online/stale/offline>, protocol <compatible/skew/incompatible>
- Routed session proof: <safe command + where it ran; no secrets>
- Process hygiene: <listeners/tmux checked; stale PID/session killed or none found>
- Redaction: no pair tokens, bearer tokens, cookies, node credentials, or auth-bearing URLs included
```

## See also

- [`../FEDERATED_DEV.md`](../FEDERATED_DEV.md) — source dev across hub/node checkouts and protocol skew handling.
- [`../SELF_HOSTING.md`](../SELF_HOSTING.md) — isolated local self-host mode for testing Relay inside Relay.
- [`../RELAY_NODE_BOOTSTRAP.md`](../RELAY_NODE_BOOTSTRAP.md) — node pairing, persistent node link, status, logs, and diagnostics.
- [`deployment.md`](./deployment.md) — branch model, `@nightly` publish flow, and release verification.
