# Relay factory

A small, verifiable factory for the Relay reboot. This first slice intentionally contains no product workflows or legacy compatibility layer.

## What exists

- Rust workspace with separately addressable `relay-hub` and `relay-node` binaries.
- A bounded, unauthenticated liveness contract: `GET /health` and `relay-node probe`.
- A static PWA shell that reads only that liveness contract.
- Checked Rust and Node toolchains, deterministic local commands, and matching CI.
- A concise product/context map and one baseline boundary ADR.

## Start here

```sh
rustup toolchain install 1.88.0 --component clippy --component rustfmt
# Use Node 22.22.3 from .node-version.
npm ci
npm run lint
npm test
npm run build
npm run dev
```

`npm run dev` serves the PWA on `http://127.0.0.1:4173` and the hub health probe on `http://127.0.0.1:8787/health`.

## Contract

A successful health response contains only `api`, `service`, `status`, and `version`. Invalid or overlong `--identity` configuration is rejected with a typed, bounded JSON error and the input is never reflected. The smoke test proves both service identities and this rejection behavior.

No legacy Relay modules were ported. PTY/RMUX, provider adapters, Hermes, Codex, mail, files, authentication, Workspace persistence, layout, browser control, and cross-node behavior remain deferred.

See `AGENTS.md` for contributor rules, `docs/PRODUCT_CONTEXT.md` for reserved nouns and scope, and `docs/adrs/ADR-0001-factory-boundary.md` for the API boundary decision.
