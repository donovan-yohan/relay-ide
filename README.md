# Relay factory

A small, verifiable factory for the Relay reboot. The current slice proves a local Workspace can arrange opaque Session references without acquiring process authority or importing legacy Relay behavior.

## What exists

- Rust workspace with separately addressable `relay-hub` and `relay-node` binaries.
- A bounded, unauthenticated liveness contract: `GET /health` and `relay-node probe`.
- A PWA Workspace workbench bound to one local Node and one approved root (including valid non-repo roots).
- A versioned, bounded browser-persisted layout tree with tab/pane/recovery controls that only reference stable opaque Session IDs.
- A one-node supervised Codex `app-server --stdio` Session seam with no network transport or raw provider transcript storage.
- Checked Rust and Node toolchains, deterministic local commands, and matching CI.

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

## Contracts

A successful health response contains only `api`, `service`, `status`, and `version`. Invalid or overlong `--identity` configuration is rejected with a typed, bounded JSON error and the input is never reflected. The smoke test proves both service identities and this rejection behavior.

Workspace layout persistence contains only a versioned Workspace binding, bounded presentation tree, and opaque Session references. It has no Session control path: a split, move, hide, close, reopen, cap error, or deterministic layout recovery cannot start, duplicate, input to, or end a Session. When the one-node liveness check is unavailable, the PWA shows a typed unavailable state and does not substitute stale context.

See `AGENTS.md` for contributor rules, `docs/PRODUCT_CONTEXT.md` for current authority boundaries, and `docs/adrs/` for accepted decisions.
