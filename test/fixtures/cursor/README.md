# cursor runtime captures

Real, redacted stdio traffic from the Cursor CLI ACP server
(`agentInfo` = `cursor-agent`, version `2026.08.31`, booted as `cursor-agent acp`).
These are the source of the native payloads in
`test/server/protocol-adapters/conformance/fixtures/cursor.fixture.ts` and
`test/server/protocol-adapters/cursor-adapter.test.ts` — fixture grammar is
transcribed from real wire interactions, never invented (`conformance/fixture-types.ts`).

| File                                 | What it is                                                                                                                                                                      |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `acp-turn-capture.redacted.ndjson`   | `initialize`, `authenticate`, `session/new`, a tool-assisted turn answering `CURSOR_LIVE_OK`, a second prompt in the same session (continuity), and a cancelled prompt.         |
| `acp-resume-capture.redacted.ndjson` | `initialize`, `authenticate`, `session/new`, a file-write turn, then a separate process invocation with `session/load` on the saved session ID and a prompt proving continuity. |

The approval and question shapes (`session/request_permission`, `cursor/ask_question`, `cursor/create_plan`) are transcribed from the Cursor CLI ACP specification and server schemas.

## How they were captured

A Node driver spawned `cursor-agent acp`, drove the ACP protocol handshake, and recorded all traffic on stdio.

## Redaction

User email (`user@example.com`), workspace directory (`/workspace`), and user home (`/redacted`) were redacted. No credentials or sensitive data are preserved.

## Protocol facts these captures pin

1. `initialize` advertises `agentCapabilities` (including `loadSession: true`, `image: true`) and `authMethods: [{ id: 'cursor_login' }]`.
2. `authenticate` with `{ methodId: 'cursor_login' }` completes the ACP handshake before opening sessions.
3. `session/new` returns the session id along with available modes, models, and config options.
4. `session/load` reloads an existing session and replays history updates before accepting new prompts.
5. `session/prompt` is answered when the turn settles with `stopReason` (`end_turn`, `cancelled`, etc.).
6. `session/cancel` gracefully cancels an in-flight prompt with `stopReason: 'cancelled'`.
