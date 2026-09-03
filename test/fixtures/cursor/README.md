# cursor runtime captures

Real, redacted stdio traffic from the Cursor CLI ACP server
(`agentInfo` = `cursor-agent`, version `2026.08.31`, booted as `cursor-agent acp`).
These are the source of the native payloads in
`test/server/protocol-adapters/conformance/fixtures/cursor.fixture.ts` and
`test/server/protocol-adapters/cursor-adapter.test.ts` — fixture grammar is
transcribed from real wire interactions, never invented (`conformance/fixture-types.ts`).

| File                                          | What it is                                                                                                                                                                                                                                                                                                                               |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `acp-turn-capture.redacted.ndjson`            | `initialize`, `authenticate`, `session/new`, a tool-assisted turn answering `CURSOR_LIVE_OK`, a second prompt in the same session (continuity), and a cancelled prompt.                                                                                                                                                                  |
| `acp-resume-capture.redacted.ndjson`          | `initialize`, `authenticate`, `session/new`, a file-write turn, then a separate process invocation with `session/load` on the saved session ID and a prompt proving continuity.                                                                                                                                                          |
| `acp-yolo-permission-capture.redacted.ndjson` | `cursor-agent --yolo acp` driven end to end. Proves `--yolo` is inert on the ACP lane: the agent still raises `session/request_permission` (line 30) for `echo YOLO_PROBE` with `content[0].content.text: "Not in allowlist: echo"` and the same three options. A no-flag run of the identical prompt produced a byte-identical request. |

The approval request in `acp-turn-capture.redacted.ndjson` (line 15: `session/request_permission` with `allow-once`/`allow-always`/`reject-once`) is real wire traffic captured when Cursor requested permission for an unlisted bash command. Question and plan shapes (`cursor/ask_question`, `cursor/create_plan`) are transcribed from the Cursor CLI ACP specification and server schemas.

## How they were captured

A Node driver spawned `cursor-agent acp` (plus root flags, e.g. `--yolo`), drove the ACP protocol handshake, and recorded all traffic on stdio.

## Redaction

User email (`user@example.com`), workspace directory (`/workspace`), and user home (`/redacted`) were redacted. The yolo capture's probe cwd was rewritten to `/workspace` and the user home to `/redacted`. No credentials or sensitive data are preserved.

## Protocol facts these captures pin

1. `initialize` advertises `agentCapabilities` (including `loadSession: true`, `image: true`) and `authMethods: [{ id: 'cursor_login' }]`.
2. `authenticate` with `{ methodId: 'cursor_login' }` completes the ACP handshake before opening sessions.
3. `session/new` returns the session id along with available modes, models, and config options.
4. `session/load` reloads an existing session and replays history updates before accepting new prompts.
5. `session/prompt` is answered when the turn settles with `stopReason` (`end_turn`, `cancelled`, etc.).
6. `session/cancel` gracefully cancels an in-flight prompt with `stopReason: 'cancelled'`.
7. `--yolo` does not disable ACP permission prompting; the adapter, not the flag, is what auto-approves under `permissionMode: 'yolo'`.
