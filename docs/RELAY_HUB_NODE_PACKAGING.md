# Relay Hub/Node Packaging Decision

## Decision

Relay hub and node modes ship in the single existing `relay-ide` npm package. The command shape is role-oriented subcommands:

```bash
npm install -g relay-ide@nightly
relay-ide hub
relay-ide hub install
relay-ide hub status
relay-ide hub logs
relay-ide node connect --hub https://hub.example.com --pair-token <token>
relay-ide node install --hub https://hub.example.com --pair-token <token> --service auto
relay-ide update
```

Bare `relay-ide`, `relay-ide install`, `relay-ide status`, and `relay-ide uninstall` remain back-compat aliases for the hub/server lifecycle. New docs should prefer `relay-ide hub ...` when the operator is intentionally running the web hub, and `relay-ide node ...` when pairing a remote/local node.

No `relay-ide-hub`, `relay-ide-node`, `@relay-ide/hub`, or `@relay-ide/node` package split is planned for v1.

## Rationale

- Hub and node currently share the same TypeScript backend, service-manager abstraction, manifest probing, bootstrap diagnostics, protocol types, versioning, and update channel.
- One global install keeps bootstrap commands short and reduces the chance that a target host installs a hub/node version skew by accident.
- npm publishing already has the two channels Relay needs: pushes to `nightly` publish `relay-ide@nightly`; stable releases publish `relay-ide@latest` from tagged `master` releases.
- The node CLI currently performs pairing, stores credentials, sends one heartbeat, and delegates generic service setup. It does not yet ship a separate long-running node daemon that would justify separate lifecycle or dependency boundaries.
- Back-compat is simple: existing users can keep running `relay-ide` and `relay-ide install`, while docs can name the explicit hub role for federated setups.

## The case against

A split package would become attractive if the runtime boundary hardens enough that a node install should not carry the web hub/frontend bundle, or if hub and node need independent release cadences. Specific triggers:

- The persistent node-side `/hub/node-link` client grows into a separate daemon with materially different dependencies, permissions, security review, or OS service files.
- Hub and node protocol compatibility requires staged rollouts where nodes intentionally lag or lead hub releases.
- Package size or native dependency footprint becomes painful for small homelab/WSL nodes.
- The hub needs admin-only dependencies or frontend assets that should never be installed on untrusted nodes.

Until one of those boundaries is real, a split adds install confusion and version-skew risk without operational benefit.

## Command contract

### Hub

```bash
# Foreground hub, useful for local/manual operation.
relay-ide hub --host 0.0.0.0 --port 3456

# Background hub service using the local platform manager.
relay-ide hub install --host 0.0.0.0 --port 3456
# Back-compat shortcut accepted by the CLI; prefer `hub install` in new docs.
relay-ide hub --bg --host 0.0.0.0 --port 3456
relay-ide hub status
relay-ide hub logs
relay-ide hub uninstall
```

The service manager remains the existing Relay-managed macOS launchd or Linux systemd-user unit (`com.relay-ide` / `relay-ide.service`). Top-level `relay-ide install|status|uninstall` are aliases for the same hub service for compatibility.

### Node

```bash
# Pair-only fallback: stores node credentials and sends one heartbeat, then exits.
relay-ide node connect \
  --hub https://hub.example.com \
  --pair-token <token>

# Pair credentials, then install/start the local Relay-managed service.
relay-ide node install \
  --hub https://hub.example.com \
  --pair-token <token> \
  --service auto

relay-ide node status
relay-ide node logs
relay-ide node doctor --hub https://hub.example.com
```

`relay-ide node install` is still bootstrap/service setup only in this slice. It does not start or maintain a persistent `/hub/node-link`; routed sessions require the follow-up persistent reverse-link client.

## Publishing and updates

- Development/nightly users install with `npm install -g relay-ide@nightly`.
- Stable users install with `npm install -g relay-ide@latest` or plain `npm install -g relay-ide`.
- `relay-ide update` updates the same package for both hub and node commands, using the configured Relay update channel.
- There is one `package.json` `bin` entry for `relay-ide`; no extra binary names are required for hub/node roles.

## Compatibility risks

- Operators may expect `relay-ide hub install` and `relay-ide node install` to create distinct service units. They do not; both use the existing generic Relay service manager. Docs must call this out until the persistent node daemon exists.
- `relay-ide node connect` is pair-only and exits. Treat any wording that implies a steady-state node process as a bug.
- If a future split package is introduced, it needs an explicit migration plan for existing global installs, launchd/systemd unit commands, node credentials, and update-channel settings.
