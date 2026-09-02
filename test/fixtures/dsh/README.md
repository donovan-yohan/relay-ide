# dsh runtime captures

Real, redacted stdio traffic from the DeepSeek Harness ACP server
(`agentInfo` = `deepseek-harness-acp` 0.0.1, shipped by dsh 0.1.2-alpha.4,
booted as `dsh --profile acp`). These are the source of the native payloads in
`test/server/protocol-adapters/conformance/fixtures/dsh.fixture.ts`,
`test/server/protocol-adapters/dsh-adapter.test.ts`, and
`test/server/dsh-acp-client.test.ts` — fixture grammar is transcribed, never
invented (`conformance/fixture-types.ts`).

| File                                 | What it is                                                                                                                                                                 |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `acp-turn-capture.redacted.ndjson`   | `initialize`, `session/new`, a `bash` turn answering `DSH_LIVE_OK`, a second prompt in the same session (continuity), a cancelled prompt, `session/list`, `session/close`. |
| `acp-resume-capture.redacted.ndjson` | A `write` turn, a second turn, `session/close`, then `session/resume` on the same id and a prompt proving the reopened session still remembers the file it created.        |

The one payload NOT from these captures is `session/request_permission`. Its
shape is transcribed from the harness's own source — `packages/acp/acp/src/
index.ts`, the `approval/request` bridge — which hard-codes exactly two
one-shot options (`allow-once` / `reject-once`) and no durable grant. The
captures ran under sandbox settings that never triggered it.

## How they were captured

A Node driver spawned the server, drove the ACP handshake, and recorded every
stdout frame:

```
DSH_HOME=<scratch> DSH_TELEMETRY_DISABLED=1 \
DEEPSEEK_API_KEY=<key> DEEPSEEK_BASE_URL=<endpoint> \
dsh --profile acp
```

## Redaction

Absolute home paths, the workspace path, and nothing else needed replacing
(`/redacted`, `/workspace`). No credential appears in either file; the server
never echoes one. Every remaining line is byte-faithful to what the server
wrote.

## Four protocol facts these captures pin

1. `session/prompt` is answered only when the WHOLE turn has settled — its
   `stopReason` (`end_turn` / `cancelled` / `max_tokens` / …) IS the turn
   outcome. There is no separate settled notification.
2. `session/cancel` is a real cancellation: the same pending prompt settles
   with `stopReason: 'cancelled'` and the session stays usable.
3. `session/resume` reopens a CLOSED session by id with its history intact —
   the reopened agent named the file it had created before the close.
4. `usage_update` reports context OCCUPANCY (`used` of `size`), not per-turn
   input and output tokens, and the readings go down as well as up.
