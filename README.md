# Relay factory

A small, verifiable factory for the Relay reboot. This first slice intentionally contains no product workflows or legacy compatibility layer.

## What exists

- Rust workspace with separately addressable `relay-hub` and `relay-node` binaries.
- A bounded, unauthenticated liveness contract: `GET /health` and `relay-node probe`.
- A static PWA shell with a passkey-first operator flow, typed unsupported/denied/recovery states, and session-device revoke controls.
- A stable-origin WebAuthn boundary that issues revocable Secure/HttpOnly browser sessions for hub-only protected actions.
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

`npm run dev` serves the PWA on `http://127.0.0.1:4173` and the hub health probe on `http://127.0.0.1:8787/health`. Plaintext development is intentionally an unsupported passkey environment. A real passkey flow requires a stable HTTPS reverse-proxy origin and this hub configuration:

```sh
relay-hub serve --bind 127.0.0.1:8787 \
  --origin https://relay.example \
  --recovery-code-hash <sha256-of-out-of-band-recovery-code>
```

The recovery hash, not its raw code, is accepted on the command line. Provision the raw recovery code from at least 32 random bytes and keep it out of normal logs; the hub cannot establish its entropy from the configured digest. Recovery can authorize replacement-passkey enrollment only; it never creates a browser session.

## Contract

A successful health response contains only `api`, `service`, `status`, and `version`. Invalid or overlong `--identity` configuration is rejected with a typed, bounded JSON error and the input is never reflected. The health smoke test proves both service identities and this rejection behavior.

The passkey boundary validates one exact HTTPS origin/RP ID, stores active ceremony state only server-side, requires user verification, and consumes each ceremony before verification. Sessions are opaque, Secure, HttpOnly, SameSite=Strict host cookies with separate CSRF tokens; revocation removes their server record and protected hub calls then fail closed. Browser sessions are never node credentials. The credentials and session records are deliberately bounded, process-local MVP state; restart clears them and requires recovery enrollment. `npm run auth:smoke` exercises raw HTTP origin/replay/redaction behavior; `npm run auth:browser` runs the real PWA flow against Chromium's standards-compatible CDP virtual authenticator.

No legacy Relay modules were ported. PTY/RMUX, provider adapters, Hermes, Codex, mail, files, durable Workspace persistence, layout, browser-control grants, node credential rotation, and cross-node behavior remain deferred.

See `AGENTS.md` for contributor rules, `docs/PRODUCT_CONTEXT.md` for reserved nouns and scope, and `docs/adrs/ADR-0001-factory-boundary.md` plus `docs/adrs/ADR-0002-passkey-auth-boundary.md` for boundary decisions.
