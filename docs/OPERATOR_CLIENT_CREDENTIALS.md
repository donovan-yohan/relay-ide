# Operator-client credentials

Operator-client credentials let a non-browser client used by a human operator,
such as a desktop integration backend, call Relay's existing stable channel
surface without a browser cookie. This is a Relay product credential, not a
provider, plugin, agent, node, or session credential.

## Contract

- Audience: `relay:operator-client:v1`.
- Credential family: `relay-occ-v1.<credential-id>.<secret>`.
- Principal: every accepted credential is server-attributed as
  `human:operator` / `Operator`. Callers cannot provide a sender, source, or
  principal field.
- Capability allowlist: only `context:read` and `context:write`.
- Scope: `scope.channelIds` is optional. When present it is an exact allowlist.
  Browser-authenticated issuance without it retains the authenticated operator's
  normal channel reach. Grant-backed issuance without it inherits the exact
  `channelIds` allowlist from an otherwise channel-only grant; grants without
  channel ids, with another scope dimension, or with wildcard channel ids fail
  closed. Actor credentials remain separately fail-closed without a channel
  scope.
- Metadata: records retain client id/display name/platform and optional hashed
  device id/display name. Raw device ids and raw credential secrets are not
  listed or returned by revoke operations.
- Supported commands: `channels.list`, `channels.get`, `channels.history`,
  `channels.post`, and `channels.subscribe`. The stable request and response
  schemas are unchanged.

The channel client recognizes this family through
`RELAY_IDE_OPERATOR_CLIENT_TOKEN` or `createRelayChannelClient({ token })` and
adds `x-relay-operator-client-token: v1` plus the normal versioned command
marker. Actor markers (`x-relay-cli-actor-token`) and `relay-sac-v1...` token
substitution are rejected, not reinterpreted.

## Issuance and revocation

`POST /operator-client-credentials` is the only response that returns the raw
token, once, as `{ token, credential }`. It accepts either the authenticated
operator browser lane or a previously approved one-time handshake grant.
`GET /operator-client-credentials` and both revocation responses return
metadata-only `{ credentials }` or `{ credential }` objects. The registry is
process-local, matching the existing scoped actor registry: a hub restart drops
operator-client credentials and therefore fails them closed rather than
silently retaining an unverified token.

A grant-backed issue body contains:

```json
{
  "grantHandle": "relay-ohg-v1.<redacted>",
  "client": {
    "id": "desktop-plugin-backend",
    "displayName": "Desktop plugin backend",
    "platform": "linux"
  },
  "device": { "id": "device-local-id", "displayName": "Operator desktop" },
  "capabilities": ["context:read", "context:write"],
  "scope": { "channelIds": ["topic:general"] },
  "ttlMs": 600000
}
```

The matching handshake grant must use the same audience, a `cli:<client.id>`
actor binding, requested capability subset, optional device binding, and any
requested channel scope. If the issue body omits `scope`, a channel-only grant's
exact channel allowlist is inherited before normal grant validation; an explicit
scope retains the existing exact/subset validation. It is consumed before the
credential is returned. Revoking an originating handshake grant revokes
credentials minted from it.

The operator browser lane can revoke with:

```text
DELETE /operator-client-credentials/:credentialId
```

A non-browser client can redeem a fresh grant for revocation instead:

```text
POST /operator-client-credentials/:credentialId/revoke
```

The latter accepts `grantHandle`, matching `client` metadata, optional matching
`device`, and optional revocation `reason`; it returns metadata only.

## Renewal / rotation

A still-valid credential can mint its own successor:

```text
POST /operator-client-credentials/renew
Authorization: Bearer relay-occ-v1.<id>.<secret>
x-relay-operator-client-token: v1
x-relay-cli-gateway: v1
```

Body is `{ "ttlMs": <positive number> }` (optional; defaults to the 15-minute
standard) or empty. The response is the same once-only raw-token shape as
issuance. The new credential copies the old one's client, device binding,
capabilities, channel scope, and originating `grantId`, so grant revocation
still cascades across every renewed descendant.

The old credential is deliberately **not** revoked at renewal. It expires
naturally within its own TTL window, so a lost renew response can never lock a
client out, and each individual token's blast radius stays unchanged.
Continuous possession therefore means continuous access — but revocation
(browser `DELETE`, grant-backed revoke, or originating-grant cascade) cuts
access immediately regardless of unexpired tokens.

Renewal fails closed like every other lane: expired, revoked, malformed, or
actor-marker-substituted tokens are rejected with the same failure envelope as
the command lanes (401/403 with `OPERATOR_CLIENT_*` reason codes). A requested
`ttlMs` beyond the registry maximum is rejected, not silently clamped.

## CLI onboarding

Request and approve an operator handshake grant with audience
`relay:operator-client:v1` and the exact requested `context:*` capability bits,
client actor id, device binding, and channel scope. Then mint once:

```sh
relay-ide operator-client issue \
  --hub https://relay.example \
  --operator-grant '<relay-ohg-v1...>' \
  --client-id desktop-plugin-backend \
  --client-display-name 'Desktop plugin backend' \
  --platform linux \
  --device-id device-local-id \
  --channel-id topic:general \
  --capabilities context:read,context:write
```

Without `--json`, issue writes only the raw token to stdout. Store it in the
client's secret store or `RELAY_IDE_OPERATOR_CLIENT_TOKEN`; never put it in a
configuration file, prompt, artifact, diagnostic, URL, or message body. The
CLI defaults the requested credential TTL to 900 seconds, bounded by the grant
and server maximum.

To revoke with a new one-time grant:

```sh
relay-ide operator-client revoke \
  --hub https://relay.example \
  --operator-grant '<relay-ohg-v1...>' \
  --credential-id '<credential-id>' \
  --client-id desktop-plugin-backend \
  --reason 'device retired' --json
```

## Channel behavior

Posts resolve through Relay's normal server-side human sender derivation and
have no provider runtime, turn, item, or source identifiers. A caller-supplied
`sender` or `source` is rejected. Scoped clients cannot use a sibling channel.
Subscriptions validate the credential before opening and before every streamed
frame or heartbeat; expiry or revocation closes the NDJSON stream with
`authorization-revoked` and a safe reconnect cursor. Private channel controls,
attachments, read-state, runtime operations, and new provider/session endpoints
remain outside this credential family.
