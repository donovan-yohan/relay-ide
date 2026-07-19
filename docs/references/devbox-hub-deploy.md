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

**Shell npm prefix override (e.g. Hermes profile via `NPM_CONFIG_PREFIX`):** On hosts where a shell profile sets `NPM_CONFIG_PREFIX` to a non-default path, `npm i -g relay-ide@nightly` installs into that prefix instead of the node tree the systemd service uses. The hub service will keep running the old version. Target the service's node tree explicitly:

```bash
npm i -g --prefix ~/.local/opt/node-v24.16.0-linux-x64 relay-ide@nightly
grep '"version"' ~/.local/opt/node-v24.16.0-linux-x64/lib/node_modules/relay-ide/package.json
```

Confirm the version matches the expected nightly before restarting the service.

## Daily-driver hub (channel chat era)

Since the channel-chat era (issue #1202, epic #1163) a dedicated **daily-driver hub** runs on this box alongside the dogfood devbox hub. It is a separate deployment with its own port (`3459`), config dir (`~/.config/relay-ide/daily-hub/`), and `systemd --user` unit — do not confuse it with the `:3456` dogfood hub in the sections above. Every command in this section targets the daily driver. Treat `config.json` (it holds `pinHash`) as auth-bearing: never paste it into an issue or PR comment.

### Service unit

The daily driver runs as a `systemd --user` service so it survives logout and reboot. Unit file: `~/.config/systemd/user/relay-daily-hub.service`.

```ini
[Unit]
Description=Relay daily-driver hub (channel chat)
After=network-online.target

[Service]
Type=simple
Environment=NODE_OPTIONS=--max-old-space-size=4096
ExecStart=%h/.local/opt/node-v24.16.0-linux-x64/bin/relay-ide hub --port 3459 --host 0.0.0.0 --config %h/.config/relay-ide/daily-hub/config.json
Restart=on-failure

[Install]
WantedBy=default.target
```

- `NODE_OPTIONS=--max-old-space-size=4096` is the #1196 heap-leak mitigation; keep it.
- `Restart=on-failure` restarts after a crash but not after a clean `stop`.
- Enable linger once so the service runs without an active login session and comes back after reboot:

```bash
loginctl enable-linger donovanyohan
systemctl --user daemon-reload
systemctl --user enable --now relay-daily-hub.service
systemctl --user status relay-daily-hub.service --no-pager
```

### Install / update

Install or update the package into the **node-24 opt prefix the service runs from**, then restart:

```bash
PREFIX=/home/donovanyohan/.local/opt/node-v24.16.0-linux-x64
npm i -g --prefix "$PREFIX" relay-ide@nightly
systemctl --user restart relay-daily-hub.service
# verify the version the service will actually run:
node -e "console.log(require('$PREFIX/lib/node_modules/relay-ide/package.json').version)"
```

The `--prefix` is not optional. A plain `npm i -g` installs into the Hermes profile prefix (`NPM_CONFIG_PREFIX`) instead of the node-24 opt tree, so the package updates but the service keeps running the old version. Always confirm the printed version before claiming the update landed.

### Config dir

`~/.config/relay-ide/daily-hub/` holds `config.json` (with `pinHash`) plus all runtime SQLite:

- `channel-chat.db`
- `workspace-topics.db`
- `ia.db`
- `agent-presence.db`
- `work-context-messages.db`
- `work-contexts.db`
- `context-packets.db`

This was migrated out of the old `/tmp` dev dirs, which did not survive reboot. Keep the config dir on durable storage; do not point the daily driver at a `/tmp` path again.

### Health check

```bash
curl -s http://127.0.0.1:3459/healthz
```

A healthy hub returns HTTP 200 with `{"status":"ok","lagMs":N,"rss":BYTES}` — the #1200 endpoint. When `lagMs` exceeds the threshold the endpoint returns HTTP 503 with `"status":"degraded"`. Poll `/healthz` rather than checking the port alone: a wedged hub can still hold `:3459` while serving nothing (see #1196), so a port-only check reports a false green.

### Recovery — wedged or dead-session hub

If the hub wedges on boot (event loop blocked ~60s while restoring dead sessions, #1196), or a mention post hangs with `Auth(AuthorizationRequired)` in the log:

```bash
DAILY_HUB=~/.config/relay-ide/daily-hub
systemctl --user stop relay-daily-hub.service
# only if stale bindings are the cause:
sqlite3 "$DAILY_HUB/channel-chat.db" "DELETE FROM channel_agent_bindings;"
systemctl --user start relay-daily-hub.service
curl -s http://127.0.0.1:3459/healthz
```

The #1200 lazy-restore usually prevents the boot wedge now. The last resort is the fresh-config-dir workaround: start from a clean config dir carrying only `config.json` and the channel/workspace/presence DBs (`channel-chat.db`, `workspace-topics.db`, `agent-presence.db`) with zero serialized sessions.

### Duplicate-row healing (channel-chat v1 → v2)

The v1 → v2 `channel-chat` migration (#1207) heals historical Claude echo duplicates on the first boot at schema v2 (it logs `channel schema v2 healed N historical Claude echo duplicate row(s)`). If it heals 0 rows in-situ but duplicates are still visible (hot-WAL state, #1209), force the heal to re-run against the flushed database:

```bash
DAILY_HUB=~/.config/relay-ide/daily-hub
systemctl --user stop relay-daily-hub.service
sqlite3 "$DAILY_HUB/channel-chat.db" "SELECT version FROM schema_version;"   # confirm it reads 2
sqlite3 "$DAILY_HUB/channel-chat.db" "UPDATE schema_version SET version = 1;" # reset to 1
systemctl --user start relay-daily-hub.service   # reopen re-runs the v1 -> v2 heal
systemctl --user status relay-daily-hub.service --no-pager
```

`schema_version` is a single-row table in `channel-chat.db`; the heal pass runs whenever the recorded version is below 2, so resetting it to 1 and reopening re-runs the dedupe and lands back at v2.

### npm publish lag (#1215)

A `nightly` merge occasionally does not trigger the Publish-to-npm workflow, so the `@nightly` npm channel lags the git head. The next merge self-heals it. Before updating the daily driver, confirm the channel actually advanced to the commit you want:

```bash
npm view relay-ide@nightly version
```

Compare that against the target commit's expected version. If `@nightly` still points at the old version, wait for the next publish (or the next merge) rather than deploying a stale package and assuming it is current.

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

Stale local processes can make a devbox test look local-only. Identify before killing. Kill only a specific PID after confirming its command, cwd, port, and role.

### Roles to distinguish

| Role                    | Typical signal                                                                                                   | Safe action                                                                              |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Production/global hub   | `relay-ide hub` or `node dist/server/index.js` on `0.0.0.0:3456`, config under `~/.config/relay-ide/config.json` | Do not kill unless you intend to stop the hosted Relay service                           |
| Ordinary source dev hub | backend `127.0.0.1:3457`, Vite `127.0.0.1:5173`, config under `~/.config/relay-ide/dev/`                         | Stop the owning dev terminal, or kill the verified stale PID                             |
| Self-host source hub    | allocator ports usually `10000-11999`, config under `~/.config/relay-ide/self-host/`                             | Stop the owning self-host terminal, or kill only the verified stale PID                  |
| Vite frontend           | `vite --config frontend/vite.config.ts` on the printed frontend port                                             | Kill only if it belongs to the stale self-host/dev run                                   |
| Node link               | `relay-ide node link --hub ...`                                                                                  | Do not kill during federated proof unless you are intentionally restarting the node link |
| Test/fixture server     | Playwright/Vitest or sandbox command, often temporary port                                                       | Let the test own it unless it is orphaned and verified stale                             |

### Inspect listeners and commands

```bash
lsof -nP -iTCP:3456 -sTCP:LISTEN
lsof -nP -iTCP:3457 -sTCP:LISTEN
lsof -nP -iTCP:5173 -sTCP:LISTEN
ps -p <pid> -o pid,ppid,lstart,command
lsof -p <pid> | grep cwd
```

For self-host ports, use the startup output or `.env` managed block to identify the assigned ports, then inspect those ports with `lsof`.

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
- Process hygiene: <listeners checked; stale PID killed or none found>
- Redaction: no pair tokens, bearer tokens, cookies, node credentials, or auth-bearing URLs included
```

## Recovery / verification — routed PTY hardening (May 2026)

A series of routed-PTY fixes landed against the dogfood loop. After a hub redeploy on devbox (or a Mac node-link restart), re-run the matching checks to confirm none of these regressions returned. Run hub-side commands over `ssh dev`; run launchd/node-link commands on the Mac. Capture redacted evidence per the template above.

### #583 series — routed Active Work live controls

- Failure mode on devbox: mobile/desktop Active Work showed a routed session as live, but Attach silently did nothing and Send hit the wrong session. Routing went through unscoped session ids and never invalidated on `session`/`control`/`node` events, so already-mounted surfaces stayed stale after a routed create. Some Mac-node routed terminals also booted with `controlMode: unknown`, which downgraded controls to read-only. CI also lacked a default `tab-mode` capability in the legacy policy, so policy-evaluated routed creates flapped between agent and human control state.
- Verification after hub redeploy:
  - Create a routed terminal against `macbook-relay-node` from desktop and mobile; confirm both surface it as `controlFreshness: fresh` with `controlMode: human-driven` (terminal) or `agent-driven` (agent) — never `unknown`.
  - From the mobile Active Work card, press Attach: the PTY should mount with the existing scrollback. Send a small input (`pwd`) and confirm it lands on the routed node.
  - Trigger a `session`/`control` event (open a second tab on the same routed session) and confirm the first surface refreshes without a manual reload.
- Mac node-link sequence: no node restart needed for the #583 fixes — they live on the hub. Only restart the node-link if `relay-ide hub nodes` reports `VERSION_SKEW` or `PROTOCOL_INCOMPATIBLE` against the redeployed hub.

### #585 — routed terminal shell liveness (commit `7fdfc3b4`)

- Failure mode on devbox: routed terminal creates from the browser arrived at the node-link RPC host without an explicit `command`. node-pty would spawn with no shell, exit immediately, and Active Work would fall back to last-known-only. Mobile users saw a dead tab almost instantly after creation.
- Verification: create a routed terminal from the browser with no custom command; confirm `relay-ide v1 sessions list --json` (versioned CLI gateway, requires `RELAY_IDE_BROWSER_TOKEN`) still shows the session as live, and the PTY shows the user's shell prompt (or `/bin/sh` on hosts without `SHELL`). The session must stay `controlFreshness: fresh` after the first PTY frame.
- Mac node-link sequence: the fallback (`defaultTerminalCommand()`) is implemented in `server/node-link-rpc-host.ts`, which runs inside `relay-ide node link` on the Mac node — not on the hub. A hub-only redeploy leaves an old node-link without the fix, so the liveness regression persists. Update the node package and restart the node-link before validating:

  ```bash
  npm install -g relay-ide@nightly   # or scripts/dev-resync.sh for source mode
  relay-ide --version                # confirm node SHA matches the hub
  launchctl kickstart -k gui/$(id -u)/com.relay-ide
  relay-ide node status
  relay-ide node logs
  ```

### #587 / #588 — routed agent runtime spawn (commits `d2ffe567`, `083ec3be`)

- Failure mode on devbox: routed `type: agent` / `agent: codex|hermes|claude` sessions reported the right metadata in Active Work and the resume snapshot, but the attached PTY rendered the user's zsh startup (e.g. `[oh-my-zsh] Would you like to update?`) instead of the selected native runtime. A stray `command` from the browser was sneaking through node-link create, and the routed attach path was re-opening a fresh PTY instead of binding to the already-spawned native session.
- Verification after hub redeploy:
  - POST a routed agent create against `macbook-relay-node` (`type: agent`, `agent: codex` — substitute whichever agent `relay-ide hub doctor` reports as `available` for that node).
  - Confirm Active Work shows `type: agent`, `controlMode: agent-driven`, `controlFreshness: fresh`, with a WorkContext linked.
  - Attach from desktop AND mobile. The bounded PTY frame must be the agent runtime UI (Codex/Hermes/Claude banner), not a shell prompt. Re-attach from a second client and confirm both clients see the same live session — that exercises the `node-link-pty-host` "attach to live native sessions" path.
- Mac node-link sequence: both halves of #587/#588 live on the Mac node. `node-link-rpc-host` command suppression for agent creates is in `server/node-link-rpc-host.ts`; `node-link-pty-host` live-session attach is in `server/node-link-pty-host.ts`. Both run inside `relay-ide node link`, so a hub-only redeploy is insufficient. If the Mac node is on an older nightly than the hub, the routed agent will spawn a shell again. Update and restart the node-link:

  ```bash
  npm install -g relay-ide@nightly   # or scripts/dev-resync.sh for source mode
  relay-ide --version
  launchctl kickstart -k gui/$(id -u)/com.relay-ide
  relay-ide node doctor --hub <devbox-hub-url>
  ```

  Then re-run the routed agent create above and confirm Codex/Hermes/Claude UI in the bounded PTY frame before claiming the regression is gone.

### Cross-fix invariants to re-prove

When a regression looks routed-PTY shaped, these are the cheapest invariants to recheck before opening a new bug:

1. Hub `/health` returns `{"status":"ok"}` and `relay-ide --version` on the devbox matches the SHA/package channel under test.
2. `relay-ide hub nodes --json` shows the target node online, protocol-compatible, on the same channel/SHA.
3. A routed terminal and a routed agent session both reach `controlFreshness: fresh` with the expected `controlMode`, and the bounded PTY frame matches the requested kind (shell prompt for terminal, runtime banner for agent).
4. Re-attaching from a second client lands on the same live session, not a fresh PTY.
5. No raw bytes, pair tokens, bearer tokens, or auth-bearing URLs appear in evidence — only ids, statuses, redacted summaries, screenshots, and artifact paths.

## See also

- [`../FEDERATED_DEV.md`](../FEDERATED_DEV.md) — source dev across hub/node checkouts and protocol skew handling.
- [`dogfood-recovery.md`](./dogfood-recovery.md) — Relay-develops-Relay proof loop, stuck-session/node/work-context/plugin recovery, diagnostics capture, and no-force-merge release gate policy.
- [`../SELF_HOSTING.md`](../SELF_HOSTING.md) — isolated local self-host mode for testing Relay inside Relay.
- [`../RELAY_NODE_BOOTSTRAP.md`](../RELAY_NODE_BOOTSTRAP.md) — node pairing, persistent node link, status, logs, and diagnostics.
- [`deployment.md`](./deployment.md) — branch model, `@nightly` publish flow, and release verification.
