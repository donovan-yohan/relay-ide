# ADR-0002: passkey-first operator boundary

- **Status:** accepted
- **Date:** 2026-07-12

## Context

The factory now needs a human operator boundary without reintroducing repeated PIN prompts, anonymous browser control, or ambient browser-to-node authority. A passkey ceremony is only meaningful when the relying-party origin is stable and the server retains its challenge state.

## Decision

`relay-hub serve` accepts authentication only when both `--origin https://…` and `--recovery-code-hash <sha256hex>` are configured. The origin must be a single HTTPS origin with no path, credentials, query, or fragment; its host becomes the RP ID. State-changing authentication endpoints require the exact browser `Origin` header.

The hub uses `webauthn-rs` passkey ceremonies with required user verification. Registration and sign-in state remains server-side, expires after five minutes, and is removed before verification, making replay and concurrent duplicate verification fail closed. Credentials are capped at eight and are process-local in this MVP. A restart clears credentials and browser sessions; the out-of-band recovery code can authorize only replacement-passkey enrollment and never issues a session.

A successful assertion creates a fresh, opaque, 30-minute `__Host-relay_session` cookie. The server stores only a SHA-256 digest of that token and an independent CSRF-token digest. Cookies are Secure, SameSite=Strict, scoped to the host, and the session cookie is HttpOnly. State-changing session/device requests require exact-origin checks plus the double-submit CSRF token. Session records are capped at eight; the oldest is invalidated before a new session is issued. Revocation removes the server-side record, so later protected-hub calls fail closed. The recovery-code digest cannot prove input entropy, so operators must provision the raw recovery value from at least 32 random bytes and protect it from normal logs.

Browser session endpoints authorize hub actions only. The node route returns `node_authority_required`; no browser session is accepted as a node credential, and the PWA makes no node-identity or credential-rotation request.

## Consequences

The raw factory listener does not terminate TLS. A stable HTTPS reverse proxy must serve the PWA and proxy the auth endpoints at the configured origin; plaintext local development intentionally presents the unsupported browser state. This slice does not add durable credential storage, pairing, multi-node trust, provider credential sync, or a PIN-primary fallback.

The browser matrix uses Chromium's CDP virtual authenticator behind a test-only self-signed HTTPS proxy. It exercises the real PWA WebAuthn API and verifier while clearly remaining a virtual-authenticator seam rather than device-hardware evidence.
