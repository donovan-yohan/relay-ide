# Hermes multiplex profile setup

How to make a named Hermes profile reachable from Relay, and how to prove it is
reachable before binding an agent profile to it.

Relay's side of this is the optional `hermesProfile` field on a hermes agent
profile — see the "Hermes multiplex profile binding" section of
[`../provider-guide.md`](../provider-guide.md) for the contract. This page is
the Hermes-side and operator-side work.

## What binding buys you

Unbound, every Relay hermes profile talks to one Hermes gateway's default
profile: one config, one SOUL, one memory store, one session namespace. Bound,
each Relay profile addresses `/p/<profile>` on the same listener, and Hermes
resolves that turn against the named profile's own config, model routing, SOUL,
memory, skills, and session namespace. Two Relay agents can therefore be two
genuinely different Hermes agents on one gateway process.

## Hermes side

1. **Create the profile** if it does not exist, and configure it as usual:

   ```bash
   hermes profile create coder
   coder setup
   ```

2. **Enable multiplexing on the default profile.** The default profile owns the
   multiplexer; it is opt-in and off by default.

   ```bash
   hermes config set gateway.multiplex_profiles true
   hermes gateway restart
   ```

   The default gateway then serves every profile. Do not start a gateway for
   the secondary profiles — with the multiplexer running, a named-profile
   `hermes gateway start` is a hard error.

3. **Keep port-binding platforms on the default profile only.** `api_server`,
   `webhook`, and the other listeners are configured once, on the default
   profile; every profile is reached through its `/p/<id>/` prefix on that one
   listener. A secondary profile that enables a port-binding platform is a
   config error and the gateway refuses to start, naming the profile and the
   platform.

4. **Check whether your build gates the served set.** Some gateway builds
   restrict multiplexing to an explicit `gateway.multiplex_profile_allowlist`;
   others serve the default profile plus every valid directory under
   `~/.hermes/profiles/`. If your build has the key, add the profile id to it.
   Either way the `/p/<id>/v1/models` check below is the authority — do not
   assume from the config file that the prefix is served.

5. **Provision the API key.** The API server refuses to start without
   `API_SERVER_KEY`, including on a loopback bind, and on a network-accessible
   bind it also refuses a placeholder or a key shorter than 16 characters. Put
   the profile's key in that profile's own `.env`:

   ```bash
   umask 077
   printf 'API_SERVER_KEY=%s\n' "$(openssl rand -hex 32)" \
     >> ~/.hermes/profiles/coder/.env
   chmod 600 ~/.hermes/profiles/coder/.env
   ```

6. **Restart the unit** so the multiplexer picks up the new profile and key:

   ```bash
   hermes gateway restart
   # or, on a systemd host, restart the default profile's gateway unit
   systemctl --user restart hermes-gateway.service
   ```

## Verify before you bind

Ask the gateway directly. `GET /p/<id>/v1/models` is the cheapest probe that
exercises both the prefix and the auth, and it is one of the two calls Relay
itself makes at connect.

```bash
curl -sS -o /dev/null -w '%{http_code}\n' \
  -H "Authorization: Bearer $HERMES_API_TOKEN" \
  http://127.0.0.1:8642/p/coder/v1/models
```

Run the bare `http://127.0.0.1:8642/v1/models` alongside it — that is the
unbound path, and comparing the two separates "the gateway is down" from "this
profile is not served".

| Status | Meaning                                                                               | Fix                                                                                                                                                                      |
| ------ | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `200`  | The prefix is served and the token is accepted. Safe to bind.                         | None.                                                                                                                                                                    |
| `401`  | The prefix is served; the token Relay would present is not accepted for this profile. | Provision an `API_SERVER_KEY` for the profile and make that key the one Relay presents (see "Relay side" below).                                                         |
| `404`  | The gateway does not serve this prefix: profile unknown, not enabled, or an id typo.  | Confirm `gateway.multiplex_profiles` is on, the profile id matches the directory name, the allowlist (if your build has one) includes it, and the gateway was restarted. |

A connection error rather than a status means the gateway or its `api_server`
platform is not up at all; the bound and unbound paths will both fail.

## Relay side

1. Settings → agent profiles → edit (or create) a profile whose provider is
   `hermes`.
2. Put the profile id in the `hermes profile` field — the same string that
   returned `200` above. Leave it blank to keep using the gateway default.
3. Save, then mention the agent in a channel.

Two things about keys are worth knowing before you debug an auth failure:

- **Relay presents one token per gateway, not one per binding.** It resolves it
  from `HERMES_API_TOKEN`, `HERMES_API_KEY`, `HERMES_GATEWAY_API_KEY`, or
  `API_SERVER_KEY` in the hub process environment, then from `~/.hermes/.env`
  merged with the _active_ profile's `.env`, then from the `api_server` key in
  `config.yaml`. It does not read the bound profile's `.env`, and an agent
  profile's `envVars` do not feed this path. If the hub runs as a service, that
  environment is the hub unit's, not your shell's.
- **A key the gateway rejects for `/p/<id>/` produces a typed 401 on the channel
  row**, naming the profile and the remedy, and it is not retried.

Availability is probed per gateway, not per profile: a bound hermes profile
still shows as available whenever the gateway is up. A binding the gateway does
not serve surfaces as a typed error on the first turn, not as an unavailable
agent — which is why the curl matrix above is worth running first.

## Related

- [`../provider-guide.md`](../provider-guide.md) — the adapter contract, path
  prefixing, validation, and typed error mapping.
- [`../CHANNEL_CHAT.md`](../CHANNEL_CHAT.md) — how a bound profile behaves as a
  channel participant.
