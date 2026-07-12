# Hermes rich-client Session adapter

## Purpose and boundary

`relay-hermes-session` is the native, one-node adapter for Hermes's authenticated dashboard rich-client JSON-RPC WebSocket. It targets only:

```text
ws://127.0.0.1:<dashboard-port>/api/ws?token=<ephemeral-dashboard-token>
```

The endpoint is supplied by an operator and is never logged or rendered by Relay. The adapter rejects `wss`, non-loopback hosts, non-dashboard paths, the OpenAI-compatible `/v1/*` API server, bare messaging-gateway ports, and any credential shape other than the local dashboard `token` query parameter.

This is intentionally not a generic Relay gateway bridge or a remote Hermes transport. Hermes's messaging/API gateway is distinct from the dashboard's `/api/ws` TUI JSON-RPC surface; pointing this adapter at the former is unsupported and visibly rejected.

## Authority separation

- **Browser human authentication:** browser cookies, login flows, OAuth grants, and dashboard tickets are not accepted or replayed by this adapter.
- **Hermes rich-client credential:** a loopback dashboard's ephemeral session token is supplied directly in the operator-provided local WebSocket URL. It is redacted from errors, diagnostics, event previews, CLI output, and PR evidence.
- **Relay node identity:** Relay neither sends nor derives a node identity from a Hermes credential. No profile database, provider credential, browser session, or transcript is copied into Relay.

For a publicly bound dashboard, Hermes requires its browser auth gate and ticket flow. That is outside this one-node MVP; use a loopback dashboard instead.

## Verified gateway contract

This adapter is verified against the installed **Hermes Agent v0.18.2
(2026.7.7.2)** rich-client implementation. `/api/ws` authenticates first, then
uses one JSON-RPC object per WebSocket text message; it emits `gateway.ready`
on accept and routes `session.create`, `session.list`, `session.resume`,
`prompt.submit`, `session.interrupt`, and `approval.respond` through the same
gateway handlers used by the TUI and dashboard. The installed gateway's
`clarify.request` frame does not expose the `request_id` required by
`clarify.respond`, so Relay observes that frame as a visible unsupported
correlation gap rather than guessing a response target.

The accepted Relay credential shape is intentionally narrower than every
Hermes auth shape: only the loopback dashboard `token` query parameter is
accepted. Browser OAuth cookies and short-lived browser tickets remain browser
authority, and the server-internal credential remains server-child authority;
Relay never mints, stores, or reuses either of them.

The adapter accepts control calls only for live IDs it created or resumed on
that connection. A listed stored ID must be resumed before it can receive a
prompt, interrupt, or approval response; arbitrary live IDs fail as typed
`unknown_session` without a transport write.

## Supported-event ledger

The adapter assigns monotonic arrival sequences and emits only provider-neutral categories plus a short redacted preview. It does not preserve raw JSON-RPC payloads, model messages, reasoning, command arguments, tool results, clarification text, or approval command text.

| Hermes rich-client event | Neutral category | Stable label | Preview policy |
| --- | --- | --- | --- |
| `gateway.ready`, `session.info` | lifecycle | `gateway_ready`, `session_info` | fixed text |
| `message.start`, `message.delta`, `message.complete` | status | `message_started`, `message_delta`, `message_complete` | fixed text; no transcript |
| `thinking.delta`, `reasoning.delta`, `reasoning.available` | status | `reasoning` | always `redacted reasoning` |
| `status.update` | status | `status_update` | fixed text |
| `tool.start`, `tool.generating`, `tool.complete`, `tool.output_risk` | tool | `tool_started`, `tool_progress`, `tool_complete`, `tool_output_risk` | safe ASCII tool name only; otherwise `tool activity` |
| `approval.request` | approval request | `approval_request` | fixed text; a response is session-scoped with one-shot `once` or `deny`; Hermes's persistent `session`/`always` grants are deliberately unsupported |
| `error` | diagnostic | `gateway_error` | fixed text |

Hermes 0.18.2 emits `clarify.request` without the `request_id` its
`clarify.respond` handler requires. Relay therefore emits the request as the
visible unsupported `clarification_without_id` marker, leaves the Session
degraded, and never guesses a response target. If a future gateway adds an
opaque response id, Relay exposes only that id as `clarification_id` and permits
one response; it still retains no question, choices, or transcript content.
Each emitted event retains the live gateway session id so Relay never attributes
a shared-gateway event to the wrong Session.

The table records event types the installed gateway can emit, not a promise that
every turn emits every type: tool rows depend on the Hermes progress display
mode, and reasoning/interaction rows depend on the active provider and turn.

## Provider-neutral compatibility seam

This crate intentionally does not reuse the merged `relay-session`
`ProcessTransport`/`Supervisor` from PR #1147: that implementation owns a
local Codex stdio child and explicitly rejects network transports, while Hermes
needs an authenticated loopback dashboard WebSocket. Its mapping remains
category-compatible with the provider-neutral seam: Hermes lifecycle events map
to lifecycle; status and tool events map to progress; approval requests map to
approval requests; and malformed, unsupported, pressure, and gateway errors
remain diagnostics. The Hermes-only live-session attribution and clarification
correlation require an additive neutral-contract decision before a later
integration exposes them beyond this adapter.

## Unsupported ledger

The adapter never pretends to support persistent approval grants (`session` or
`always`), `sudo.request`, `secret.request`, `terminal.read.request`,
`background.complete`, `skin.changed`, `config.set`, `command.dispatch`,
`cli.exec`, `process.stop`, `terminal.resize`, `image.attach`,
`session.branch`, or `session.compress`. Any unknown event becomes a visible
`unsupported_event` and increments `StreamSignals.unsupported`; an unsupported
method returns typed `unsupported` before it touches the transport.

## Bounded recovery and data handling

| Condition | Bounded behavior |
| --- | --- |
| Auth upgrade rejected | typed `auth_failed`; no retry and no credential echo |
| Connection or dashboard restart | typed `gateway_lost`; connection setup retries at most three times, then reports `retry_exhausted` |
| Malformed RPC or non-text frame | typed `malformed_rpc`, cumulative signal, Session becomes degraded |
| Control-RPC deadline | typed `timeout` and Session degradation; no automatic retry of create, prompt, approval, clarification, or interrupt because they are not safely idempotent |
| Passive observation deadline | typed `timeout` but retains the prior Session state; a quiet bounded observation window is normal |
| Queue pressure | queue holds at most 128 events; oldest event is dropped, `dropped` increments, `replay_gap=true`, Session becomes degraded |
| Foreign session event | not queued or allowed to alter this adapter's status; `foreign` increments without retaining a provider payload |
| Replay request before retained history | typed `replay_gap`; replay retention is at most 64 events |
| Oversize RPC/frame | 8 KiB request and 64 KiB frame limits; typed `payload_too_large` |
| Interrupt/approval response races | a `4009` server race or missing pending request becomes typed `raced`; other server failures remain typed `remote_failure` and Session becomes degraded |
| Clarification correlation gap | a `clarify.request` without an opaque response id becomes visible `clarification_without_id`; no response is sent |

The adapter emits no normal logs. `relay-node hermes-smoke` prints only booleans, counts, and a coarse status; it does not print endpoint URLs, tokens, session IDs, prompts, event payloads, transcripts, or private reasoning.

## Local contract smoke

Start a loopback-only dashboard with an ephemeral token supplied through its environment, then invoke the Relay harness with the URL held in a shell variable. Do not paste the token into issue comments, shell history, logs, or PR evidence.

```bash
relay-node hermes-smoke --gateway-url "$HERMES_RICH_CLIENT_URL" --cwd "$PWD"
```

The harness uses the native `/api/ws` protocol to list sessions, create one, submit a prompt, and resume its stored session. It observes any immediately available lifecycle/tool/status events through the bounded stream.

## Verification

```bash
sh scripts/cargo.sh test -p relay-hermes-session
sh scripts/cargo.sh test -p relay-node --test hermes_smoke_cli
npm test
npm run lint
npm run build
npm run bench
```
