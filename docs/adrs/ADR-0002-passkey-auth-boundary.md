# ADR-0002: passkey-first operator boundary

- **Status:** accepted
- **Date:** 2026-07-12

## Context

The factory now needs a human operator boundary without reintroducing repeated PIN prompts, anonymous browser control, or ambient browser-to-node authority. A passkey ceremony is only meaningful when the relying-party origin is stable and the server retains its challenge state.

## Decision

`relay-hub owner-store init --owner-store ABSOLUTE_PATH --origin HTTPS_ORIGIN` creates only a new private V1 unclaimed record. Authenticated `serve` requires that explicit store plus the origin, recovery digest, and `--first-owner-exposure private|public|funnel|unknown`; it never creates missing or bad state. The origin must be one canonical HTTPS origin with no path, credentials, query, or fragment; its host becomes the RP ID. State-changing authentication endpoints require the exact browser `Origin` header.

The hub uses `webauthn-rs` passkey ceremonies with required user verification. Registration and sign-in state remains server-side, expires after five minutes, and is removed before verification. An unclaimed store permits code-free first-owner registration only when exposure is literally `private`. The first valid verifier atomically persists the owner UUID and credential and returns `owner_claimed` without a session; raced valid losers receive `already_claimed`. The browser must then perform an explicit assertion. Recovery is available only after claim, can enroll a replacement, and never claims or issues a session.

The V1 JSON owner record contains a positive generation, exact origin, claim state, opaque owner UUID only when claimed, and at most eight passkeys with enrollment timestamps. The recovery-code digest stays separately configured launcher state. A stable adjacent lock is held for hub lifetime because the data inode is replaced during updates. The state directory is mode 0700 and files are mode 0600; unsafe ownership, symlinks, hard links, corrupt/unsupported schema, origin mismatch, and missing state fail as typed unavailable without reflecting paths. Updates write a same-directory private temporary file, sync it, rename it over the record, then sync the directory. RAM and success advance only after this completes; uncertain post-rename durability failure makes the running boundary unavailable. Assertion counter changes, enrollment, and credential revocation use the same ordering.

Offline `owner-store reset ... --confirm-reset-owner` requires the exclusive lock, advances generation to a fresh unclaimed record, and removes credentials. The recovery-code digest remains launcher configuration outside the owner record. A live hub therefore refuses reset. Restart keeps owner credentials but clears all browser sessions; reset invalidates the old credentials as well.

A successful assertion creates a fresh, opaque, 30-minute `__Host-relay_session` cookie. The server stores only a SHA-256 digest of that token and an independent CSRF-token digest. Cookies are Secure, SameSite=Strict, scoped to the host, and the session cookie is HttpOnly. State-changing session/device requests require exact-origin checks plus the double-submit CSRF token. Session records are capped at eight; the oldest is invalidated before a new session is issued. Revocation removes the server-side record, so later protected-hub calls fail closed. The recovery-code digest cannot prove input entropy, so operators must provision the raw recovery value from at least 32 random bytes and protect it from normal logs.

Browser session endpoints authorize hub actions only. The node route returns `node_authority_required`; no browser session is accepted as a node credential, and the PWA makes no node-identity or credential-rotation request.

## Consequences

The raw factory listener does not terminate TLS. A stable HTTPS reverse proxy must serve the PWA and proxy the auth endpoints at the configured origin; plaintext local development intentionally presents the unsupported browser state. Operators must place the owner store outside ephemeral preview artifacts and back it up as private authority state. This slice does not add pairing, multi-node trust, provider credential sync, or any PIN/anonymous fallback.

The browser matrix uses Chromium's CDP virtual authenticator behind a test-only self-signed HTTPS proxy. It exercises the real PWA WebAuthn API and verifier while clearly remaining a virtual-authenticator seam rather than device-hardware evidence.
