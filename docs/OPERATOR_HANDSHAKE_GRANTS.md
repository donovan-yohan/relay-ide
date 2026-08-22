# Operator handshake grants

Issue #813 adds the foundation for a one-time operator handshake grant. The grant is a short-lived, revocable, auditable approval record for a named actor/device/session/work-context. It is not a browser login, scoped actor credential, pair token, or node credential.

## Ceremony copy contract

Operator approval surfaces should say all of this before approval:

- What is delegated: the exact Relay capability bits, such as `session:read` or `logs:read`.
- Who receives it: actor type and actor id/display name.
- Audience: the expected grant audience, for example `relay:operator-handshake:v1` for generic ceremony handoffs or `relay:node-pair-token:v1` for node pair-token minting.
- TTL: the grant expiry timestamp; the default foundation TTL is 10 minutes and the maximum is 30 minutes.
- Scope: node/session/global-session/work-context/repo/path/task dimensions.
- Bindings: optional device id hash and session binding.
- Revoke path: `DELETE /operator/handshake-grants/:grantId` for future API wiring.

Suggested minimal approval copy:

> Approve one-time Relay handshake grant for `<actor>`.
> Delegates `<capabilities>` to `<actor type>:<actor id>` for audience `<audience>` until `<expiresAt>`. This is a one-time handshake grant, not a browser login, pair token, node credential, or reusable scoped actor token. Revoke it at `DELETE /operator/handshake-grants/<grantId>`.

## Lane separation

The browser session may authorize the approval ceremony, but the returned `relay-ohg-v1.<grant-id>.<secret>` handle is the only grant material for this lane and is consumed once by validation. It must not be accepted as any other credential type.

| Presented material                           | Accepted as handshake grant?                           | Notes                                                               |
| -------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------- |
| Browser PIN/session cookie                   | No                                                     | May authorize ceremony routes only; never reusable automation auth. |
| `relay-ohg-v1...` handshake grant            | Yes, once, if audience/capability/scope/bindings match | Consumed on successful validation.                                  |
| `relay-occ-v1...` operator-client credential | No                                                     | Separate human operator-client channel lane.                        |
| `relay-sac-v1...` scoped actor token         | No                                                     | Separate scoped actor credential lane.                              |
| Pair token                                   | No                                                     | Node bootstrap only.                                                |
| Node credential                              | No                                                     | Node heartbeat/link only.                                           |

## Node pair-token minting grant

The node bootstrap automation lane uses a dedicated audience and capability:

- Audience: `relay:node-pair-token:v1`
- Capability: `node:pair-token:create`
- Mint endpoint: `POST /hub/pair-tokens` with `X-Relay-Operator-Grant: <relay-ohg-v1...>` plus safe context in the JSON body (`displayName`, `platform`, `ttlSeconds`, `trustTier`, `capabilityEnvelope`, `taskRef` or session/work-context bindings, actor summary, and correlation id).

The browser/PIN session may authorize creating or approving a grant, and may remain as a human fallback pair-token creation path, but it is not accepted as the automation grant. Scoped actor tokens, node credentials, existing pair tokens, and bearer headers from other lanes fail closed instead of minting node pair tokens.

Successful mint validation consumes the operator grant and creates a separate short-lived pair token. That pair token is still one-time bootstrap material accepted only by `POST /hub/pairing/exchange`; it does not become a browser session, scoped actor credential, node credential, or reusable grant.

## Validation failure contract

Validation fails closed with stable typed reasons for malformed grant handles, lane mixing, unknown/wrong audience, not-approved grants, expiry, revocation, replay/reuse, actor/device/session mismatch, missing or wrong scope, unknown requested capability, and insufficient capability.

High-risk capability grants, such as `node:lifecycle:destructive`, require existing #807 approval contract evidence before approval. Without that evidence, approval is denied instead of minting a grant handle.

## Audit and redaction

The foundation records audit events for request, approve, deny, issue, validate, expiry, revoke, and replay. Audit payloads include only safe metadata: grant id/jti, actor summary, issuer hash/display name, audience, capability bits, scope/params hashes, and correlation id.

Raw grant handles, browser cookies, scoped actor tokens, pair tokens, node credentials, bearer headers, and secret-looking strings must not appear in logs, diagnostics, registry snapshots, audit payloads, CLI JSON, or browser JSON.
