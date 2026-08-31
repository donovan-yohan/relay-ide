# Hermes multiplex profile setup

How to make a named Hermes profile reachable from Relay, and how to prove it is
reachable before binding an agent profile to it.

Relay's side of this is two optional fields on a hermes agent profile — the
`hermesProfile` binding and the per-profile `hermesApiKey` that rides with it.
See the "Hermes multiplex profile binding" section of
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

4. **Decide which profiles the multiplexer serves.**
   `gateway.multiplex_profile_allowlist` gates the set: unset serves the
   default profile plus every valid directory under `~/.hermes/profiles/`, `[]`
   serves only the default profile, and a list serves only the named profiles
   (unknown entries are skipped with a warning). If you set it, the bound
   profile id has to be in it.

   `hermes config set` coerces only scalars, so write the list in the default
   profile's `~/.hermes/config.yaml`:

   ```yaml
   gateway:
     multiplex_profiles: true
     multiplex_profile_allowlist:
       - coder
   ```

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

The API server registers a `/p/<profile>/…` mirror for every one of its native
routes, so the whole Responses API is reachable under the prefix. Ask the
gateway directly: `GET /p/<id>/v1/models` is the cheapest probe that exercises
both the prefix and the auth, and it is one of the two calls Relay itself makes
at connect. Present the key you are going to give Relay — the profile's own
`API_SERVER_KEY`, not the default profile's:

```bash
PROFILE_KEY=$(sed -n 's/^API_SERVER_KEY=//p' ~/.hermes/profiles/coder/.env)
curl -sS -o /dev/null -w '%{http_code}\n' \
  -H "Authorization: Bearer $PROFILE_KEY" \
  http://127.0.0.1:8642/p/coder/v1/models
```

Run the bare `http://127.0.0.1:8642/v1/models` alongside it — that is the
unbound path, and comparing the two separates "the gateway is down" from "this
profile is not served". Gateway builds older than 0.20 may not mirror the prefix
onto the API server at all; there, every `/p/<id>/v1/…` call answers `404` no
matter how the profile is configured.

| Status | Meaning                                                                                  | Fix                                                                                                                                                             |
| ------ | ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `200`  | The prefix is served and the token is accepted. Safe to bind.                            | None.                                                                                                                                                           |
| `401`  | The prefix is served; that key is not accepted for this profile.                         | Check you used the profile's own `API_SERVER_KEY`, and that the gateway was restarted after it was written.                                                     |
| `404`  | The gateway does not serve this prefix: profile unknown, not allowlisted, or an id typo. | Confirm `gateway.multiplex_profiles` is on, the profile id matches the directory name, the allowlist includes it if you set one, and the gateway was restarted. |

A connection error rather than a status means the gateway or its `api_server`
platform is not up at all; the bound and unbound paths will both fail.

## Relay side

1. Settings → agent profiles → edit (or create) a profile whose provider is
   `hermes`.
2. Put the profile id in the `hermes profile` field — the same string that
   returned `200` above. Leave it blank to keep using the gateway default.
3. Paste that profile's `API_SERVER_KEY` into the `hermes api key` field — the
   same value you just proved with curl. Relay never returns a saved key, so the
   box always starts empty; the hint beside it says whether one is stored, and a
   `clear` control removes it.
4. Save, then mention the agent in a channel.

Two things about keys are worth knowing before you debug an auth failure:

- **The key travels with the binding.** It is sent only when the profile is
  bound; an unbound profile talks to the gateway default and keeps the default
  credential. With a binding set and the key left empty, Relay falls back to the
  gateway-wide credential (`HERMES_API_TOKEN`, `HERMES_API_KEY`,
  `HERMES_GATEWAY_API_KEY`, or `API_SERVER_KEY` from the hub process environment
  or the Hermes `.env` files, then the `api_server` key in `config.yaml`) —
  usually the default profile's key, which will usually 401 against `/p/<id>/`.
  If the hub runs as a service, that environment is the hub unit's, not your
  shell's.
- **A key the gateway rejects for `/p/<id>/` produces a typed 401 on the channel
  row**, naming the profile and the remedy, and it is not retried. Relay stores
  the key write-only and never echoes it, so a wrong key is diagnosed by
  re-running the curl above, not by reading it back out of Relay.

Availability is probed per gateway, not per profile: a bound hermes profile
still shows as available whenever the gateway is up. A binding the gateway does
not serve surfaces as a typed error on the first turn, not as an unavailable
agent — which is why the curl matrix above is worth running first.

## Give the profile a Relay credential (#1455)

Binding makes Relay able to _reach_ the profile. This makes the profile able to
reach _back_ — to create a channel, invite another agent, post, and read
history as itself, through `relay-ide v1`. See
[`../CHANNEL_CHAT.md`](../CHANNEL_CHAT.md) § Profile-bound credentials and
membership for what the credential is and is not allowed to do.

### 1. Mint, and plant it in one pipe

On the **Relay** host, mint the credential for the agent profile bound to this
Hermes profile. On the **Hermes** host, plant it:

```bash
relay-ide v1 agent-profiles credential mint --id <agent-profile-id> --json \
  | node dist/scripts/install-profile-credential.js \
      --env-file ~/.hermes/profiles/coder/.env
```

When the two hosts differ, the pipe becomes an `ssh` — the point is that the
token goes stdout-to-stdin and never becomes a command-line argument, which
every other local process can read out of `/proc`. There is deliberately no
`--token` flag. `--token-file` is the other accepted source.

The installer writes `RELAY_IDE_ACTOR_TOKEN`, and `RELAY_IDE_PORT` too if you
pass `--port` (the CLI's gateway lane dials `127.0.0.1:<port>`, so the hub has
to be reachable on loopback from the Hermes host). It rewrites the assignment in
place if one is already there, leaves every other line of the file untouched,
takes a timestamped backup first, keeps the file's mode, and refuses outright to
write a file that is group- or other-readable. Running it twice with the same
token changes nothing at all.

Rotation is the same command again: `credential mint` revokes the old token as
it issues the new one, and the installer overwrites the dead value in place.

### 2. Read the credential from the turn

**A variable in a profile's `.env` is not in the environment of a command the
`terminal` tool runs.** Hermes hydrates the profile's secrets into an in-process
scope (`_profile_runtime_scope` in `gateway/run.py`, `build_profile_secret_scope`
in `agent/secret_scope.py`) and deliberately does _not_ touch `os.environ` —
that isolation is what stops one profile's secrets leaking into another
profile's subprocesses. On the `local` terminal backend the child inherits the
**gateway process's** environment, which is the _host_ profile's, not the routed
one's.

What does cross is `HERMES_HOME`: the local backend points it at the routed
profile's own directory. So the profile reads its own credential by sourcing its
own `.env`:

```bash
set -a; . "$HERMES_HOME/.env"; set +a; relay-ide v1 channels history --channel-id <id> --json
```

Put that prefix in a profile-local skill (`skills/<category>/<name>/SKILL.md`)
so the agent has the working invocation to hand. A skill is prompt text and
cannot add a tool, but it does not need to: the `terminal` tool is already in
the `api_server` toolset, so no `platform_toolsets` edit is required to give a
profile `relay-ide` — the profile-static toolset resolution people worry about
is not the obstacle here.

`terminal.env_passthrough` is the other route, but it only rewrites the _value_
of a name that already exists in the gateway process environment; it cannot
introduce a new one on the local backend. Using it means also defining
`RELAY_IDE_ACTOR_TOKEN` in the gateway host profile's `.env`, which is more
moving parts for the same result. (The Docker backend forwards passthrough names
straight from the scope and does not need the placeholder.) **The one primitive
genuinely missing upstream** is a way to inject a variable present only in the
routed profile's `.env` into a local-backend terminal child.

### 3. Membership, not scope

Minting admits the profile to nothing. It joins a channel by creating it, by
being invited by a member, or by being mentioned by one — and every channel verb
is refused `CHANNEL_NOT_MEMBER` until then. Revoking the credential kills the
planted token on its next call, with no edit to the `.env` needed.

## Related

- [`../provider-guide.md`](../provider-guide.md) — the adapter contract, path
  prefixing, validation, and typed error mapping.
- [`../CHANNEL_CHAT.md`](../CHANNEL_CHAT.md) — how a bound profile behaves as a
  channel participant.
- [`../SECURITY_POLICY.md`](../SECURITY_POLICY.md) — how the stored gateway key
  is held write-only.
