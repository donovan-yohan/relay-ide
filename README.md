# Relay factory

A small, verifiable factory for the Relay reboot. The current slice is a one-node browser workbench for native Hermes and Codex chat plus Relay-owned Claude Code PTY Sessions.

## What exists

- Rust workspace with separately addressable `relay-hub` and `relay-node` binaries.
- A bounded, unauthenticated liveness contract: `GET /health` and `relay-node probe`.
- A PWA Project workbench with a bounded node-backed picker for approved local roots and subdirectories, including valid non-repo roots.
- A versioned, bounded browser-persisted layout tree with tab/pane/recovery controls that only reference stable opaque Session IDs.
- A passkey-first owner flow with code-free private first claim, typed unsupported/denied/recovery states, and bounded browser-session/passkey revocation.
- A stable-origin WebAuthn boundary that issues revocable Secure/HttpOnly browser sessions for hub-only protected actions.
- A one-node supervised Codex `app-server --stdio` Session seam with no network transport or raw provider transcript storage.
- A real xterm Claude Code surface backed by the authenticated Relay-owned PTY API, with bounded incremental output, queued input recovery, resize, interrupt, refresh reattach, and explicit process close.
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

`npm run dev` serves the PWA on `http://127.0.0.1:4173` and the hub health probe on `http://127.0.0.1:8787/health`. Plaintext development is intentionally an unsupported passkey environment. A real passkey flow requires a stable HTTPS reverse-proxy origin and this hub configuration:

```sh
relay-hub owner-store init \
  --owner-store /absolute/private/relay-state/owner.json \
  --origin https://relay.example

relay-hub serve --bind 127.0.0.1:8787 \
  --origin https://relay.example \
  --recovery-code-hash <sha256-of-out-of-band-recovery-code> \
  --owner-store /absolute/private/relay-state/owner.json \
  --first-owner-exposure private
```

Only literal `private` exposure allows the code-free first-owner claim; `public`, `funnel`, and `unknown` fail closed. The store directory and files are private (0700/0600), the hub locks the store for its lifetime, and `serve` never creates missing state. The recovery hash, not its raw code, is separately configured on each authenticated hub start and never enters the owner record. Provision the raw recovery code from at least 32 random bytes and keep it out of normal logs. Recovery is claimed-state break-glass authorization for replacement enrollment only; it neither claims an unowned Relay nor creates a browser session.

An offline owner reset requires the live hub lock to be free and an explicit destructive confirmation:

```sh
relay-hub owner-store reset \
  --owner-store /absolute/private/relay-state/owner.json \
  --origin https://relay.example \
  --confirm-reset-owner
```

## Contracts

A successful health response contains only `api`, `service`, `status`, and `version`. Invalid or overlong `--identity` configuration is rejected with a typed, bounded JSON error and the input is never reflected. The health smoke test proves both service identities and this rejection behavior.

Workspace layout persistence contains only a versioned Workspace binding, bounded presentation tree, and opaque Session references. It has no Session control path: a split, move, hide, close, reopen, cap error, or deterministic layout recovery cannot start, duplicate, input to, or end a Session. When the one-node liveness check is unavailable, the PWA shows a typed unavailable state and does not substitute stale context.

The passkey boundary validates one exact HTTPS origin/RP ID, keeps active ceremony and session state only in RAM, and durably persists owner identity, generation, credentials, enrollment timestamps, assertion updates, and revocations before success. Restart invalidates browser cookies but retained passkeys can sign in again. Browser sessions are never node credentials. `npm run auth:smoke` exercises raw HTTP origin/replay/redaction behavior; `npm run auth:browser` covers first-owner race, sign-in, restart, reset, exposure denial, and revocation with Chromium's CDP virtual authenticator.

No legacy Relay modules were ported. RMUX, provider adapters beyond Claude Code/Codex/Hermes, mail, files, generalized Session-control APIs, browser-control grants, node credential rotation, and cross-node behavior remain deferred.

See `AGENTS.md` for contributor rules, `docs/PRODUCT_CONTEXT.md` for reserved nouns and authority boundaries, and `docs/adrs/` for accepted decisions.
