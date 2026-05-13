# Federated Relay — Development Workflow

How to develop relay-ide when more than one machine is involved (hub on one
box, paired relay-node on another, browser on a third). The single-machine
self-host flow is documented in [`SELF_HOSTING.md`](./SELF_HOSTING.md); this
doc covers cross-machine iteration.

End-user installs (`npm install -g relay-ide@nightly` / `@latest`) are
documented in [`RELAY_NODE_BOOTSTRAP.md`](./RELAY_NODE_BOOTSTRAP.md) and
[`RELAY_HUB_NODE_PACKAGING.md`](./RELAY_HUB_NODE_PACKAGING.md). Those flows
are the production shape. Federated dev uses the same package, different
source.

## TL;DR

- One package: `relay-ide`. Hub vs node is a subcommand role, not a separate
  install.
- For development: **synced git checkout per machine**. Each box clones the
  repo. After a protocol-affecting change, every machine runs
  `scripts/dev-resync.sh` (pull + `npm ci` + `npm run build` + `npm link`).
- `relay-ide --version` prints the git short SHA when run from a source
  checkout, so version skew across the fleet is visible in logs and on the
  hub UI.
- `npm run dev:node -- --hub <url>` is the node-side equivalent of
  `npm run dev` for the hub. Builds + runs `relay-ide node link` from
  `dist/`.
- The `@nightly` npm dist-tag is the production fast-channel. **There is no
  `@dev` tag.** Cross-machine dev uses source, not extra npm publishes.

## Dev scenarios

Pick the cheapest path per scenario; do not pay protocol-skew tax when only
one side changed.

| Scenario              | What changes                                  | Cross-machine action                                                                                                     |
| --------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Hub-only              | Routing, registry, repo aggregation, hub UI   | Restart hub on the devbox. Paired nodes keep running stable nightly. No node-side changes.                               |
| Frontend-only         | React UI, styles, frontend state              | `npm run dev` (or `dev:self`) on the hub host. Vite HMR. Nodes untouched.                                                |
| Node-only             | `node-link-pty-host`, node manifest probes    | Pull + build + restart `relay-ide node link` on the affected node host(s). Hub keeps running.                            |
| Protocol (both sides) | Envelope shape, channels, capability manifest | Resync every machine. Match git SHAs before bringing the link back up. `relay-ide --version` exposes any skew in output. |

## Path of least resistance

For multi-developer work or anything that touches the wire protocol, treat
the fleet as multiple checkouts of the same branch:

1. Each machine clones the repo once into its own working dir.
2. After any protocol-affecting commit:
   ```bash
   scripts/dev-resync.sh
   ```
   This wraps `git pull --ff-only` → `npm ci` → `npm run build` →
   `npm link --force`. Run it on every host you want to keep in step.
3. Restart whichever role each host is playing (`relay-ide hub` /
   `relay-ide node link --hub <url>`).
4. Confirm version match with `relay-ide --version` on each host. A clean
   checkout prints `0.1.x (source <sha>)`; uncommitted edits print
   `<sha>-dirty`. Skew between hosts is the first thing to suspect when a
   link refuses to come up.

Flags:

- `scripts/dev-resync.sh --no-pull` — skip the `git pull` (already pulled).
- `scripts/dev-resync.sh --no-link` — skip `npm link` (keep the global
  install pointing at npm-installed `@nightly`).

## Running the hub from source

The hub-side flows are unchanged from [`SELF_HOSTING.md`](./SELF_HOSTING.md):

```bash
# Foreground hub on isolated config/ports, source dev outside production Relay.
npm run dev

# Foreground hub on allocator-chosen ports, for nesting Relay inside Relay.
npm run dev:self

# Split: backend only, frontend served by Vite.
npm run dev:backend
npm run dev:vite

# Production-shape startup: build + run the same compiled binary the npm
# package ships, but from this checkout.
npm start
```

All hub modes serve the browser at the configured port. The hub stays
running while you iterate on a node host.

## Running the node from source

Pair the node host once against the dev hub (this writes the credential):

```bash
relay-ide node connect --hub http://<hub>:3456 --pair-token <pair-token>
```

Then run the persistent reverse link from this checkout:

```bash
npm run dev:node -- --hub http://<hub>:3456
```

The script builds the server (`npm run build:server`) and execs
`node dist/bin/relay-ide.js node link --hub <url>`. It runs in the
foreground; `SIGINT`/`SIGTERM` close the link cleanly.

Equivalent without the npm wrapper:

```bash
npm run build
node dist/bin/relay-ide.js node link --hub http://<hub>:3456
```

If you want `relay-ide` itself (anywhere on the PATH) to resolve to this
checkout, run `npm link --force` once. `scripts/dev-resync.sh` does this
for you.

## Source-version visibility

When `relay-ide` is run from a source checkout (i.e. `.git` exists at the
package root), `--version` reports `<version> (source <short-sha>)` and
appends `-dirty` if `git status --porcelain` shows uncommitted edits. Use
it on every host before debugging a link issue:

```bash
relay-ide --version
# 0.1.0 (source a1b2c3d)
# 0.1.0 (source a1b2c3d-dirty)
# 0.1.0                          ← installed from npm, no .git nearby
```

Hub-side logs surface the node-reported `relayVersion` on link
establishment, so the asymmetric case (one side from npm, other from
source) is recoverable from logs even without shelling in.

## Protocol-skew note

The hub enforces an exact-string match on
`RELAY_NODE_LINK_PROTOCOL_VERSION` (`shared/relay-node-protocol.ts`). If
you bump that constant in a protocol-affecting commit, every host must
rebuild before the link comes back up. Symptoms of skew:

- Node-side log: `terminal error from hub (PROTOCOL_INCOMPATIBLE): …`
- Hub-side log: typed `PROTOCOL_INCOMPATIBLE` error in the audit stream.
- `relay-ide node doctor --hub <url>` flags the mismatch.

Resync every host before chasing other causes.

## When to publish, not link

`npm link` and `scripts/dev-resync.sh` are right for fast iteration on
your own fleet. Publish through the existing flow (`@nightly` dist-tag,
documented in [`docs/references/deployment.md`](./references/deployment.md))
when:

- You need a fleet-wide install that survives a reboot without a checkout.
- You want to verify the real install path (npm tarball shape, postinstall
  prebuilt binary handling, etc.).
- A non-developer host needs to participate (no git/node toolchain).

`@nightly` is fast enough for this. There is intentionally no `@dev`
dist-tag.

## See also

- [`SELF_HOSTING.md`](./SELF_HOSTING.md) — single-machine self-host (Relay
  inside Relay).
- [`RELAY_NODE_BOOTSTRAP.md`](./RELAY_NODE_BOOTSTRAP.md) — pair / install /
  doctor flows for nodes (npm-installed shape).
- [`RELAY_HUB_NODE_PACKAGING.md`](./RELAY_HUB_NODE_PACKAGING.md) — packaging
  decision, hub/node command shape.
- [`federated-relay.md`](./federated-relay.md) — hub/node architecture,
  pairing, routing, ADRs.
