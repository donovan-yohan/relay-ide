# Relay reboot factory

This repository is deliberately a greenfield factory. Work only from the active GitHub issue and its acceptance criteria; legacy Relay files and documents are not design authority.

## Commands

- `npm run dev` — build the minimal PWA and run the hub plus static shell.
- `npm test` — checked toolchains, Rust tests, PWA structure tests, and the liveness smoke.
- `npm run lint` — Rust formatting/clippy plus bounded PWA structural lint.
- `npm run build` — Rust workspace and PWA distribution build.
- `npm run bench` — compile the benchmark placeholder.

## Boundaries

The implemented runtime boundaries are `GET /health` on the hub, the matching `relay-node probe` command, and the #1143 passkey-first browser boundary. Do not add process, provider, filesystem beyond #1143's bounded in-memory auth state, PTY, mailbox, browser-control grants, cross-node control, or layout behavior without a later accepted issue.

Product nouns and deferred scope live in `docs/PRODUCT_CONTEXT.md`; design decisions live in `docs/adrs/`. GitHub issues are the source of truth for product scope. Child reboot PRs preserve ancestry, target `reboot/relay-next`, and use `Refs #1136` until a later milestone says otherwise.

## Toolchains

Rust is pinned in `rust-toolchain.toml`; Node is pinned in `.node-version` and checked by the commands above. Do not rely on an inherited ambient version.
