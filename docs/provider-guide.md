# Agent provider guide

Provider adapters connect an agent CLI/runtime to Relay's private
`ChannelAgentRuntime`. They emit normalized patches; the channel binder and
bridge turn those patches into durable participant messages.

Providers do not own conversation identity, history, routing, or frontend
navigation.

## Contract

Every channel-capable provider implements `ProtocolAdapterV2` from
`server/protocol-adapter-v2.ts` and emits `AgentPatchV2` from
`shared/agent-chat-protocol-v2.ts`.

Required lifecycle:

1. `connect(config)` prepares the provider without submitting a prompt.
2. `sendMessage({ turnId, content, attachments })` starts a turn when idle or
   queues according to declared capability.
3. `interrupt(turnId)` stops active work and emits an honest terminal state.
4. `disconnect()` releases subprocess, socket, and listener resources.
5. `onPatch(handler)` may register multiple consumers; one consumer is the
   channel bridge and another is the binder's lifecycle controller.

Optional methods cover approval, questions, resume, and runtime environment
refresh. Capabilities must describe only implemented behavior.

## Built-in native transports

| Provider         | Provider id   | Native channel transport                             |
| ---------------- | ------------- | ---------------------------------------------------- |
| Claude Code      | `claude`      | persistent subprocess over stream JSON               |
| Codex            | `codex`       | `codex app-server` JSON-RPC                          |
| OpenCode         | `opencode`    | native SDK/events                                    |
| Hermes           | `hermes`      | Responses API/SSE                                    |
| Prime Agent      | `prime-agent` | `prime-agent` RPC                                    |
| Pi               | `pi`          | `pi --mode rpc` JSONL                                |
| Antigravity      | `antigravity` | `agy` stream-json NDJSON over stdin/stdout           |
| DeepSeek Harness | `dsh`         | `dsh --profile acp` Agent Client Protocol over stdio |
| Cursor           | `cursor`      | `cursor-agent acp` Agent Client Protocol over stdio  |

### Agent Client Protocol (ACP): shared base + harness profiles

Relay has one shared ACP choreography layer:

- `server/acp-client.ts`: provider-neutral newline-delimited JSON-RPC 2.0 stdio transport with bidirectional peer requests.
- `server/protocol-adapters/acp-adapter.ts`: `AcpProtocolAdapter`, which implements the ACP turn choreography once and delegates harness quirks to an `AcpHarnessProfile`.

**Quirk containment rule:** anything that depends on a specific harness’s ACP behavior stays in the `AcpHarnessProfile` (not a second adapter copy). The base owns the sequencing, queueing, replay suppression (no-active-turn guard), prompt boundaries, teardown, and the canonical item mapping defaults.

The base also supports one liveness guard for harnesses that can wedge after
accepting a prompt: `AcpHarnessProfile.firstUpdateTimeoutMs` fails the turn if
no `session/update` notification arrives within the configured window
(defaults to 120,000 ms).

Hooks used by shipped ACP harnesses today:

- **dsh (`dsh --profile acp`)**:
  - `resumeStrategy: 'resume'` (ACP `session/resume` lane).
  - `buildEnv` (translates Relay permission mode into `DSH_PERMISSION_MODE`, and preserves env-only credentials).
  - `selectPermissionOptionId` (dsh hard-codes `allow-once` / `reject-once` option ids).
  - `commandToolNames` / `fileToolNames` (dsh tool titles map directly to canonical command/file cards).
  - `extensionNamespace` (dynamic tools render under the `dsh` namespace).
  - `onNotification` (surfaces `config_option_update` as a debug provider extension).
- **cursor (`cursor-agent acp`)**:
  - `authMethodId: 'cursor_login'`.
  - `resumeStrategy: 'load'` (ACP `session/load` lane; history replay suppressed by the base no-active-turn guard).
  - `permissionPolicy` (Cursor `--yolo` is inert on the ACP lane, so yolo auto-approval happens in the adapter).
  - `selectPermissionOptionId` (permission selection is by `options[].kind` with fail-closed once-scope).
  - `otherKindHeuristics` + `commandToolNames` / `fileToolNames` (Cursor tool calls often arrive as `kind: other`; the base maps them into canonical cards via harness-provided name sets and diff/location heuristics).
  - `extensionNamespace` (Cursor dynamic tools render under the `cursor` namespace).
  - `onPeerRequest` / `onNotification` (Cursor vendor extension methods `cursor/*`).

### Prime Agent

Prime Agent 0.9.1 is a first-class channel provider. Relay launches
`prime-agent --mode rpc --no-extensions`; depending on profile and session
state, it also supplies `--provider <name>`, `--model <id>`,
`--thinking <level>`, `--append-system-prompt <text>`, and either
`--resume [path|id]` or `--fork <path|id>`. These flag spellings are verified
against `prime-agent --help` in 0.9.1. Relay does not use the advertised
`--mode acp` or `--mode daemon` modes. It leaves `--daemon-socket <path>`
unset.

The adapter maps the RPC stream as follows:

| Prime RPC input or event                                             | Relay mapping                                                                                                            | Lifecycle and fidelity rule                                                                                                                                               |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prompt`                                                             | Started turn plus completed `userMessage`; `images` contains base64 image data                                           | The response means accepted or queued, not completed                                                                                                                      |
| `agent_start`                                                        | Debug diagnostic                                                                                                         | Relay already started the turn when it submitted `prompt`                                                                                                                 |
| `turn_start`, `turn_end`                                             | No Relay patch                                                                                                           | Recognized and ignored as redundant with Relay/native boundaries                                                                                                          |
| Assistant-role `message_start`                                       | Sequence bookkeeping                                                                                                     | Advances the assistant block sequence; other roles do not                                                                                                                 |
| `message_update` text/thinking deltas                                | `assistantMessage` / `reasoning` start and delta patches                                                                 | Stable IDs combine the Relay turn, assistant sequence, and content index; out-of-turn updates are debug-only                                                              |
| `message_update` `toolcall_end`, `tool_execution_start\|update\|end` | `commandExecution`, `fileChange`, or `dynamicToolCall`                                                                   | `toolcall_end` creates a running preview; only `tool_execution_end` terminalizes it; out-of-turn events are debug-only                                                    |
| `message_update` error                                               | Error patch and turn failure, or interrupted state for `aborted`                                                         | Applied only to the active turn                                                                                                                                           |
| `message_end`                                                        | Usage plus terminal assistant/reasoning status                                                                           | `aborted` marks interruption; native errors fail the turn; Prime does not supply a total context-window figure here                                                       |
| `session_action_update`                                              | Live queue depth                                                                                                         | Combines Prime's finite non-negative `queuedCount` with Relay's local queue                                                                                               |
| `auto_retry_start\|end`                                              | `autoRetry` provider extension                                                                                           | A failed retry sets the turn error; out-of-turn success is diagnostic only                                                                                                |
| `compaction_start\|end`                                              | `contextCompaction` provider extension                                                                                   | Surfaced only when an active Relay turn can own it; otherwise logged at debug level                                                                                       |
| `extension_error`                                                    | Debug `extensionError` provider extension                                                                                | Surfaced only during an active turn; otherwise no Relay patch                                                                                                             |
| `extension_ui_request`                                               | Dialogs emit an error and interrupt an active turn; active-turn non-dialog updates become debug `extensionUi` extensions | `select`, `confirm`, `input`, and `editor` cannot block a channel; an out-of-turn dialog emits a session error, while an out-of-turn non-dialog request produces no patch |
| `agent_end`                                                          | Terminal turn and live-state patch                                                                                       | Completes, interrupts, or fails the turn, then starts the next locally queued prompt; an out-of-turn event returns live state to idle                                     |
| Any other event                                                      | Debug diagnostic                                                                                                         | Observed native data is not misrepresented as a supported Relay concept                                                                                                   |

The adapter advertises text, reasoning, tools, command execution, file changes,
slash commands, queueing, interrupt, resume, telemetry, and streaming. Approval,
question, plan, native steering, queue cancellation, fork, rollback, manual
compaction, and rate-limit capabilities remain false. Relay queues concurrent
messages locally and submits a new `prompt` after `agent_end`, preserving one
durable Relay turn per message.

**Daemon boundary.** In 0.9.1, `--mode rpc` is a thin client of Prime's
supervisor daemon; the daemon-owned session worker runs the model and tools.
Relay applies `buildChildEnv` to the client. A newly created worker receives the
client environment as an overlay on the daemon environment, but an omitted
variable is not a deletion marker, and attaching to an existing worker does not
replace that worker's environment. Relay's client-side environment denylist is
therefore not a sandbox for commands run by Prime. In particular, a denylisted
key already present in the daemon environment can remain in the worker.

The RPC client's correlated `get_state` call is the 10-second readiness barrier.
All stderr and any pre-readiness stdout line that is not a JSON object are
retained in a bounded diagnostic tail. A failed resume follows this one-step
ladder:

| Classified reason | Evidence recognized by the adapter                       | Resume behavior                                        | Channel-visible result                                     |
| ----------------- | -------------------------------------------------------- | ------------------------------------------------------ | ---------------------------------------------------------- |
| `stale-session`   | `No session found matching`                              | Retry once without `--resume`                          | First turn gets a `resumeFallback` notice                  |
| `cwd-missing`     | `MissingSessionCwd` or missing session working directory | Retry once without `--resume`                          | First turn gets a `resumeFallback` notice                  |
| `cwd-mismatch`    | `Session found in different project`                     | Retry once with `--fork <path\|id>` in the channel cwd | First turn gets a `resumeFallback` notice                  |
| `lease-held`      | `Session is already active`                              | No fallback                                            | Fail with guidance to close or attach to the other process |
| `auth`            | `No models available`                                    | No fallback                                            | Fail with `/login` guidance                                |
| `timeout`         | `get_state` does not answer within 10 seconds            | No fallback                                            | Fail with the bounded diagnostic tail when available       |
| `unknown`         | Any other launch failure                                 | No fallback                                            | Fail with the native error and bounded diagnostic tail     |

A fallback is attempted only for an initial `--resume` launch. If the fresh or
fork launch also fails, that classified failure is final. Reconnect uses the
provider session ID learned from `get_state`: it first tears down the client and
then tries that ID.

The connected command palette calls `get_available_models` and exposes `model`,
plus `thinking`/`effort` only when the selected live model supplies supported
thinking levels. The adapter executes these through `set_model` and
`set_thinking_level`, then refreshes with `get_state`. Missing or malformed
model discovery produces no guessed catalog, and a native unsupported response
retracts that control for the current runtime generation.

Prime 0.9.1 also documents `new_session`, `compact`, and `steer`, but their
existence is not enough to advertise the corresponding Relay capabilities:

- `new_session` changes native session identity. Relay does not expose it until
  the adapter can switch and publish the durable provider binding as one
  controlled operation.
- `compact` is a session mutation with its own asynchronous start/end/failure
  lifecycle. The adapter observes compaction events during an attributed turn,
  but has no manual control that owns and reports an idle compaction.
- `steer` injects into the current native run and has no separate `agent_end`
  boundary. Relay instead preserves attribution by queueing the message as a
  distinct turn and sending a fresh `prompt` after the current `agent_end`.

Model and thinking controls run on Relay's authenticated control lane. They are
not persisted as chat messages and do not consume a prompt. Prime skills,
prompt templates, TUI-only commands, and the three controls above are not
exposed in the channel palette. The 0.9.1 compatibility assumptions used here
are line-delimited JSON records, a correlated `get_state` response,
`agent_end` as the settled run boundary, and a finite non-negative
`sessionActions.queuedCount`.

The `prime-agent` executable is also available as a normal terminal launch, but
that surface stays a generic PTY: Relay does not parse terminal output or infer
channel capabilities from it.

Pi is a first-class channel provider. Its adapter maps accepted prompts and `agent_settled` boundaries to Relay turn
lifecycle, `message_update` text and
thinking deltas to assistant and reasoning items, and
`tool_execution_start|update|end` to canonical command, file-change, or dynamic
tool items. It advertises text, reasoning, tools, command execution, file
changes, queueing, interrupt, resume, compaction, telemetry, and streaming; unsupported
approval, question, plan, and queue-cancellation operations remain false. Because Pi steering stays within one native run, Relay queues concurrent
messages locally and sends a fresh RPC prompt after each `agent_settled`, preserving
one durable Relay turn per message. Channel subprocesses currently launch with
`--no-extensions` because blocking `extension_ui_request` dialogs are not mapped
to Relay approvals/questions yet.

The Pi channel transport is installed-tested with Pi 0.83.0. It assumes
strict-LF JSONL records, a correlated `get_state` readiness response,
`agent_settled` as the settled run boundary, and a finite non-negative
`pendingMessageCount`. These are protocol compatibility assumptions rather than
an assertion that every earlier or later provider version behaves identically.

The `pi` executable is also available as a normal terminal launch, but
that surface stays a generic PTY: Relay does not parse terminal output or infer
channel capabilities from it.

Antigravity is a first-class channel provider (#1508). Its adapter drives the
`agy` CLI in headless mode over stream-json (`--input-format stream-json --output-format stream-json -p ''`). It maps `step_update` agent response text deltas to streaming assistant items, tool execution steps to canonical `commandExecution` (for `run_command`), `fileChange` (for `write_to_file`, `replace_file_content`, `multi_replace_file_content`, `sed_file`, `notebook_edit`), and `dynamicToolCall` items with step-index IDs. Cumulative usage is folded across turn steps. It advertises text, tools, command execution, file changes, queueing, interrupt, resume, telemetry, and streaming; unsupported reasoning streaming, approvals, questions, plans, and slash commands remain false. Sessions resume across respawns via `--conversation <id>`.

DeepSeek Harness is a first-class channel provider. Its adapter boots the
harness's automation-only ACP server (`dsh --profile acp`) and speaks the
standard [Agent Client Protocol](https://agentclientprotocol.com) over
newline-delimited JSON-RPC on stdio. That wire is BIDIRECTIONAL in a way no
other Relay stdio harness is: besides answering Relay's requests and pushing
`session/update` notifications, the server sends Relay a REQUEST
(`session/request_permission`) and blocks the agent until Relay answers.
`server/acp-client.ts` therefore exposes `respond`/`respondError` next to
`request`, and every branch of the adapter's peer-request handler answers —
including the unknown-method one, which replies `-32601` rather than leaving a
turn wedged.

Lifecycle: `initialize` is the readiness barrier and advertises what the server
actually mounts (`sessionCapabilities: close/list/resume`,
`promptCapabilities.image: false`). Relay then opens ONE session per runtime —
`session/new`, or `session/resume` when a resume id is stored — with the
Relay-assigned cwd as its workspace. A resume the server refuses does not
strand the channel: the adapter opens a fresh session and says so on the
transcript.

**The turn boundary is the `session/prompt` RESPONSE.** The server answers it
only after agent idle and ordered update delivery, so its `stopReason` is the
turn outcome: `end_turn` completes, `cancelled` interrupts, and `max_tokens` /
`max_turn_requests` / `refusal` fail the turn with an operator-facing message.
Relay does not await that response before resolving `sendMessage` — the binder
treats send resolution as its delivery boundary, so awaiting a whole turn there
would hold every message undelivered and stall the queue behind it.

| Native `session/update`                             | Relay item                                                 |
| --------------------------------------------------- | ---------------------------------------------------------- |
| `agent_message_chunk`                               | `assistantMessage`, keyed `<turnId>-assistant-<messageId>` |
| `agent_thought_chunk`                               | `reasoning`, keyed `<turnId>-reasoning-<messageId>`        |
| `tool_call` (`bash`, `pwsh`, `terminal_bash`)       | `commandExecution`, keyed by `toolCallId`                  |
| `tool_call` (`write`, `edit`, `str_replace_editor`) | `fileChange`, keyed by `toolCallId`                        |
| `tool_call` (anything else)                         | `dynamicToolCall` in the `dsh` namespace                   |
| `tool_call_update`                                  | terminalizes that item; `status: 'failed'` fails it        |
| `usage_update`                                      | folded into the turn total, published on turn-completed    |
| `config_option_update`                              | debug provider extension                                   |

Honest capabilities: text, reasoning, tools, command execution, file changes,
queueing, interrupt, resume, approvals, telemetry, and streaming are true.
Questions, plans, slash commands, steering, queue cancellation, fork, rollback,
compaction, and rate limits are false — that is the ACP server's own documented
non-surface (it omits or rejects `session/load`, deletion, fork, modes,
commands, plans, terminals, client filesystem operations, and elicitation).
Three of the trues deserve their reason stated:

- **Interrupt is a real cancel.** `session/cancel` settles the in-flight prompt
  with `stopReason: 'cancelled'`; nothing is killed and the conversation
  survives for the next turn.
- **Resume is a real resume.** `session/resume` reopens a closed session by id
  with its history intact, so `resumeStateKey` is `dshSessionId` and a
  transport reconnect continues the same conversation.
- **Approvals are real, but off under the yolo default** (see the permission
  paragraph below). A permission request becomes a pending approval card;
  `respondToApproval` answers it with the harness's own `allow-once` /
  `reject-once` option ids. Only the `once` scope is advertised, because the
  harness offers one-shot choices and infers no durable grant. An approval left
  outstanding when the turn ends or the transport dies is answered `cancelled`
  on the wire before its card is terminalized.

`usage_update` reports context OCCUPANCY (`used` of `size`), not per-turn input
and output tokens, so Relay publishes the LAST reading as `totalTokens` plus
`contextWindowSize`/`contextPercent` rather than summing.

The adapter states `DSH_PERMISSION_MODE` on the child env — the ACP composition
derives BOTH its sandbox mode and its approval policy from that one variable —
translating Relay's `permissionMode` (`danger-full-access` is the yolo word) and
letting a named profile override it outright. **In practice that means approvals
are off by default:** channel bindings spawn in yolo mode hub-wide
(`CHANNEL_BINDING_YOLO_DEFAULT` in `server/channel-agent-binder.ts`), so dsh
starts in `danger-full-access`, whose approval policy is `never` — the ACP
server auto-approves every tool itself and Relay blocks nothing, because no
`session/request_permission` is ever sent. An operator who wants the cards sets
`DSH_PERMISSION_MODE` to `workspace-write` (or `read-only`) in the dsh agent
profile's `envVars`, which wins over the yolo mode and flips the server's policy
back to `ask`. Credentials are env-only:
`DEEPSEEK_API_KEY` and `DEEPSEEK_BASE_URL` on the agent profile's `envVars`. A
missing key is not caught by preflight; it surfaces as a failed turn with the
provider's own message.

The dsh channel transport is installed-tested with dsh 0.1.2-alpha.4
(`agentInfo.version` 0.0.1). Real redacted captures are committed under
`test/fixtures/dsh/` and are the only source of the conformance fixture's
payloads.

The `dsh` executable is also available as a normal terminal launch, but that
surface stays a generic PTY: Relay does not parse terminal output or infer
channel capabilities from it.

The Antigravity channel transport is installed-tested with Antigravity CLI (`agy`) 1.1.23. The `agy` executable is also available as a normal terminal launch, but that surface stays a generic PTY: Relay does not parse terminal output or infer channel capabilities from it.

Cursor is a first-class channel provider (#1552). Its adapter boots the Cursor CLI ACP server (`cursor-agent acp`) and speaks the Agent Client Protocol over stdio.

The Cursor channel transport is installed-tested with `cursor-agent` 2026.08.31-4057e58. The `cursor-agent` executable is also available as a normal terminal launch, but that surface stays a generic PTY: Relay does not parse terminal output or infer channel capabilities from it.

Lifecycle: `initialize` is the readiness barrier (`clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }`), followed by an authentication request (`authenticate { methodId: 'cursor_login' }`). Authentication is a connect gate: if it fails, Relay disconnects and reports the error rather than starting an unauthenticated session. Relay then opens a session with `session/new`, or `session/load` when resuming an existing session id (`cursorSessionId`). `session/new` must return a `sessionId`, or connect fails closed; Cursor’s captured `session/load` success response can omit it, in which case Relay treats the requested resume id as the provider session id. Historical notifications emitted during `session/load` replay are dropped because no turn is active while a session loads: every notification handler returns early without an `activeTurnId`, and `reconnect`/`resumeSession` complete the in-flight turn before reconnecting.

The adapter maps:

- `session/update` notifications (`agent_message_chunk` -> `assistantMessage`, `agent_thought_chunk` -> `reasoning`, `tool_call` -> `commandExecution`/`fileChange`/`dynamicToolCall`, `usage_update` -> context occupancy telemetry)
- `session/request_permission` peer requests -> Relay approval cards with `allow-once`/`allow-always`/`reject-once` outcomes. `--yolo` does not suppress these on the ACP lane (probed 2026-09-02: the `--yolo` and no-flag requests are byte-identical), so `permissionMode: 'yolo'` auto-approves in the adapter — only ever with the `allow_once` option, and only when Cursor offers one. Every auto-grant is recorded as a debug-visibility `cursor` provider extension (`kind: 'permission_auto_approved'`) plus a hub log line. That extension lives in the agent session mechanics only -- `providerExtension` has no detail card, so the channel bridge does not mirror it to a durable channel row. With no `allow_once` on the wire the request falls through to a normal approval card. Reject decisions are symmetric: a one-time reject never widens to `reject_always`.
- `cursor/ask_question` peer requests -> Relay question cards, answered with structured `{ questionId, selectedOptionIds }` selections
- `cursor/create_plan` peer requests -> canonical Relay plan items, auto-accepted so execution proceeds without blocking
- Provider extensions for `cursor/update_todos`, `cursor/task`, and `cursor/generate_image`
- Command arguments pass root options (`--model <id>`, `--yolo`) before the `acp` subcommand.

The `cursor-agent` executable is also available as a normal terminal launch, but that surface stays a generic PTY.

### Live Pi and Prime RPC smoke

Run the opt-in, model-backed protocol probe with an explicit provider:

```bash
RELAY_AGENT_RPC_SMOKE_LIVE=1 \
RELAY_AGENT_RPC_SMOKE_CREDENTIALS=1 \
RELAY_AGENT_RPC_SMOKE_PI_MODEL=<provider/model> \
npm run smoke:agent-rpc -- --provider pi
```

Use `--provider prime-agent` with
`RELAY_AGENT_RPC_SMOKE_PRIME_MODEL`, or `--provider both` with both model
variables. `RELAY_AGENT_RPC_SMOKE_MODEL` is the shared model fallback; optional
command overrides are `RELAY_AGENT_RPC_SMOKE_PI_COMMAND` and
`RELAY_AGENT_RPC_SMOKE_PRIME_COMMAND`. The harness skips only when an explicit
live/credential gate, executable, model selection, provider model
configuration, or credential is missing. Transport, readiness, protocol,
unsupported-capability, timeout, and temporary-provider failures exit nonzero.

This smoke makes real model calls, but runs each provider in disposable cwd and
session directories with tools, extensions, skills, templates, themes, context
files, and Pi telemetry disabled. Cleanup removes those directories, and output
omits prompts, provider stderr, credentials, and raw session identifiers.

### Hermes multiplex profile binding

A Relay agent profile whose provider is `hermes` may carry an optional
`hermesProfile` binding: the id of a Hermes profile served by that gateway's
multiplex listener. Settings → agent profiles shows it as a plain text
`hermes profile` field on hermes profiles only. There is no roster discovery —
Relay never enumerates or reconciles the Hermes profile list, so the value is
operator-typed and Relay's only check is that it is a legal id.

- **Unbound** (field blank, `hermesProfile` absent or `null`) — the adapter
  calls the gateway at bare `/v1/...`, which is the gateway's default/active
  profile. Byte-identical to pre-binding behavior.
- **Bound** — every gateway call that runtime makes is prefixed with
  `/p/<profile>`: the connect-time `health` and `/v1/models` probes, the turn at
  `/v1/responses`, the abort at `/session/<id>/abort`, and the approval response
  at `/permission/<id>/<action>`. All of them are built from one `baseUrl()` in
  `server/protocol-adapters/hermes-adapter.ts`, so a call site that skipped it
  would land in the default profile while the runtime believed it was bound.

The binding is a URL path segment, so it is constrained rather than free-form:
`HERMES_PROFILE_PATTERN` in `shared/agent-profile.ts` is
`^[A-Za-z0-9._-]{1,64}$`, and `.` and `..` are rejected outright. The Settings
editor, the agent-profile router, and the store guard all run that one
predicate, and the adapter re-checks it at connect. A malformed binding
**throws** instead of falling back to the gateway default; a silent fallback is
exactly the cross-profile leak the binding exists to prevent. The empty string
is not a clear — `null` is, and the router answers `''` with a typed 400.

Which agent-profile field a provider consumes as a gateway binding is one
`PROVIDER_DESCRIPTORS` row (`agentProfileGatewayBindingKey`), not a
provider-name branch in the binder, so a stray `hermesProfile` on a codex
profile never reaches the codex adapter's `extra`.

**Typed profile errors.** Hermes answers an unknown or unserved profile prefix
with `404` (the multiplex router's "unknown or unconfigured profile"), and a
profile whose `API_SERVER_KEY` the presented token does not satisfy with `401`.
Relay keys on the status, not the body. The two have different fixes, so a
bound runtime maps them to a `HermesProfileError` naming the profile and the
remedy and raises a non-retryable `chat:error` — `auth` for 401, `protocol` for 404. Connect fails with the same profile-specific reason
when the gateway does not serve the prefix at all, so a bad binding surfaces on
the channel row instead of quietly running somewhere else. An unbound runtime's
error mapping is unchanged and still retryable.

**The gateway key travels with the binding.** Hermes multiplex gives each named
profile its own `API_SERVER_KEY`, so a bound runtime has to present that
profile's key rather than the gateway default's. A hermes agent profile
therefore carries an optional `hermesApiKey` beside its binding, entered as the
`hermes api key` field in Settings → agent profiles.

The key is stored write-only by construction: it lives in its own
`agent_profiles.hermes_api_key` column outside the readable `profile_json`
blob, and every profile read statement selects `hermes_api_key IS NOT NULL`
rather than the value, so an `AgentProfile` can only ever carry a
`hermesApiKeySet` boolean. `AgentProfileStore.getGatewaySecret` is the single
value read path, and which adapter `extra` key carries it is one more
`PROVIDER_DESCRIPTORS` row (`agentProfileGatewaySecretKey`). See
[`SECURITY_POLICY.md`](SECURITY_POLICY.md) for the handling rules.

The secret rides only alongside a present binding. An unbound runtime talks to
the gateway default and keeps the default credential, so a stored per-profile
key is never sent where it cannot work. With no per-profile key stored, a bound
runtime falls back to the same gateway-wide resolution an unbound one uses:
`extra.apiToken`/`extra.apiKey`, then `HERMES_API_TOKEN`, `HERMES_API_KEY`,
`HERMES_GATEWAY_API_KEY`, or `API_SERVER_KEY` from the hub process environment
or the Hermes `.env` files, then the `api_server` key in `config.yaml`.

The value becomes an `Authorization: Bearer` header verbatim, so
`HERMES_API_KEY_PATTERN` restricts it to printable non-space US-ASCII, at most
4096 characters — CR, LF, and NUL are excluded by construction rather than
escaped. A malformed stored key throws `hermes_profile_key_invalid` instead of
falling back to the default credential, and no message or log line echoes the
value: operator-facing text names the profile and the field only. Operator steps
and the verification matrix live in
[`references/hermes-multiplex-setup.md`](references/hermes-multiplex-setup.md).

**Availability stays global.** `server/frameworks.ts` probes the gateway with no
binding, so a hermes profile reads as available whenever the gateway is up,
whether or not the bound profile is served. Per-profile health is not claimed
anywhere in the UI.

## Native session state adapters (read-only)

Separate from the channel lane, `AgentHarnessStateAdapter` implementations
(`server/provider-state/`) expose a provider's local session store read-only:
list native sessions, snapshot provider state, import a transcript into an
`AgentSessionV2` read model, report a copyable resume argv, and — where the
store is appended plaintext JSONL or framed zstd — stream live tail events onto
the scoped `native-sessions` gateway topic with durable byte cursors (#1426,
#1428). Adapters never mutate provider stores and never execute resume
commands themselves. Providers currently covered: `claude`, `codex`,
`prime-agent`, `pi`, `dsh` (framed-zstd tailer), and `antigravity`.

`dsh` now also has a full channel adapter (above), so a dsh transcript can be
read here and a live dsh conversation held there. Its state adapter reports NO
resume argv and `canResumeNative: false` (#1520): no shipped dsh app parses
`--resume`, so the previously advertised `dsh --resume <id>` was a command that
fails. Resuming a dsh conversation is the channel adapter's job — it reopens a
session over ACP with `session/resume`, which needs no argv at all.

### Read-path performance contract (#1449)

`sessions native list` fans out over every registered adapter, and each adapter
walks up to 500 transcripts. Summaries must therefore be cheap on repeat calls:

- Derive each file's summary behind `FileDerivedCache`
  (`server/provider-state/file-summary-cache.ts`), keyed on the
  `(mtimeMs, ctimeMs, size, ino)` stamp from one `stat`. All four matter: size
  catches appends, mtime catches in-place rewrites, ino catches a replacement by
  rename, and ctime catches a restore that forges mtime. Re-stat after the read
  and only cache when the stamp still matches, so a transcript appended to
  mid-parse is never cached, and share concurrent reads of one path with
  `SingleFlight`.
- Fan the per-file work out with `runWithConcurrency`, which preserves input
  order — the summary sort is stable, so pre-sort order is part of the response.
- Collect summary facts while streaming the file. Do not materialize the parsed
  record array on the list path; the import and read paths may.
- Resolve a `nativeId` to a path before reading anything (Claude and Codex name
  the canonical transcript `<nativeId>.jsonl`). The by-name walk must use the
  same traversal order and the same `maxFiles` budget as the list walk, or it
  resolves ids to a different transcript than the list shows — or to ids the
  capped list can never return. The fast path is best effort: honour `ref.cwd`,
  verify the parsed id, and fall back to the full walk on any mismatch or read
  failure.

The registry lists providers concurrently, so an adapter's list path must not
assume it is the only one running.

`claude` and `codex` implement this contract today; `pi`, `prime-agent`, `dsh`,
and `antigravity` still re-read their whole store per request. Those stores are
small enough that the concurrent registry hides the cost (~75 ms combined on a
real machine), but a new adapter should follow the contract from the start.

#### Restart-surviving layer (#1459)

The in-memory cache above only helps a warm process. A summary carries
`hashSha256`, `lineCount` and `eventTypes`, which all need the whole file, so a
fresh process paid the entire walk once (~730 MB / 4.9 s at 989 sessions).
`FileDerivedCache` therefore takes an optional durable backing —
`server/provider-state/summary-cache-store.ts`, a SQLite table in the **hub
config directory** (`native-session-summaries.db`; never the checkout, see
`server/runtime-state-paths.ts`). Rules for an adapter that opts in:

- Persistence changes _where_ the cache lives, never _what_ it may answer. A
  rehydrated row is served only through the same `get(filePath, stamp)`
  comparison, so all four stamp fields still have to match a fresh `stat`. There
  is no separate staleness policy to keep in sync.
- Pass a `fingerprintInput` covering everything outside the file's bytes that
  shapes a summary: a format version, the adapter's `capabilities`, and its
  parse limits. Rows under a different fingerprint are deleted, not served, so
  tuning a limit or changing capabilities self-invalidates. Bump
  `SUMMARY_CACHE_FORMAT_VERSION` for a change the fingerprint inputs do not
  already cover;
  `test/server/provider-state/summary-cache-persistence.test.ts` pins the
  `NativeSessionSummary` field set and fails when it drifts.
- Call `persistWalk(seenPaths)` at the end of the list walk to write what was
  derived and prune rows for files that are gone. Pass `undefined` whenever the
  walk hit its `maxFiles` budget — pruning against a partial walk would evict
  rows for transcripts the walk simply never reached.
- One adapter owns one namespace in the store; the namespace is the provider id.
- The store is a cache and nothing else: it opens best effort, discards and
  rebuilds a corrupt file, contains every error rather than throwing into the
  request path, and is bounded by both a row count and a byte budget so it can
  never grow without limit.

Cold `GET /sessions/native` at 989 sessions: **4.94 s → 0.28 s**, byte-identical
payload. The very first list on a machine with no cache file still pays the full
walk; only restarts are free.

### Antigravity CLI (`agy`) state adapter

The Antigravity CLI is wired as both a native-session provider (`#1439`) and a
first-class channel adapter (`#1508`). State root: `~/.gemini/antigravity-cli/`.

- Listing reads `history.jsonl` (one row per user prompt) grouped by
  `conversationId`; the first prompt's text is the bounded, redacted title.
- Import parses `brain/<id>/.system_generated/logs/transcript.jsonl`:
  `USER_INPUT` opens turns, `PLANNER_RESPONSE` folds thinking evidence, named
  tool calls, and the final answer into them, typed tool steps map to
  provider-extension items with honest status, and unknown record types become
  attributed gaps on the audit marker — never silent drops.
- Conversations whose only artifacts are opaque `.pb` blobs still list with
  `metadata.transcriptAvailable: false`; importing one yields the real user
  turns from history plus an explicit degradation marker rather than
  fabricated assistant content.
- Live watch tails the canonical `transcript.jsonl`; long conversations may
  roll into `chunks/transcript/*.jsonl`, which are not tailed.
- Resume argv: `agy --conversation <id>` (flag verified against agy v1.1.20).

## Identity boundary

Keep these identities distinct:

| Identity                      | Owner                   | Purpose                               |
| ----------------------------- | ----------------------- | ------------------------------------- |
| Profile actor id              | Relay profile store     | Durable channel participant           |
| Provider id                   | Adapter registry        | Chooses runtime implementation        |
| Runtime id                    | Channel runtime manager | Private process handle                |
| Provider session id           | Provider                | Resume opaque vendor context          |
| Channel/message/turn/item ids | Relay                   | Conversation ordering and idempotency |

The bridge attributes output to the profile actor id. Never derive the visible
participant from a transient runtime or vendor session id.

## Patch mapping

Document each native provider event in a deterministic mapping table:

| Native event    | Relay patch       | Item type          | Identity rule                              | Terminal behavior            |
| --------------- | ----------------- | ------------------ | ------------------------------------------ | ---------------------------- |
| prompt accepted | turn/item started | `userMessage`      | Relay turn id                              | none                         |
| assistant delta | item delta/update | `assistantMessage` | stable native id or deterministic fallback | final update                 |
| reasoning       | item start/update | `reasoning`        | stable per block                           | completed/failed             |
| tool call       | item start/update | `toolCall`         | native call id                             | completed/failed             |
| command output  | item update       | `commandExecution` | owning call id                             | completed/failed             |
| file diff       | item start/update | `fileChange`       | path plus native id                        | completed/failed             |
| approval        | item start/update | `approval`         | provider request id                        | answered/cancelled           |
| turn result     | turn completed    | —                  | Relay turn id                              | completed/interrupted/failed |

Mapping rules:

- Never silently drop an observed native event.
- Map shared concepts to canonical item types.
- Put genuinely provider-specific data in a bounded `providerExtension`.
- Preserve native ids when stable.
- Use deterministic, collision-resistant fallback ids when native ids are
  absent.
- Emit explicit terminal updates; do not leave cards running after a turn
  ends.

## Detail cards

`ProtocolAdapterV2` normalizes rich items into `AgentDetailCardV2`. The channel
bridge bounds and persists those cards beside channel messages.

## Command catalogs and channel control lane

Adapters may expose `getSlashCommands()` and `executeControlCommand()` from
`ProtocolAdapterV2`. A catalog entry declares its dispatch: `relay-control`
commands are safe for Relay to execute; `agent` commands remain provider-native
prompt/skill input. The channel binder never branches on a provider name: it
uses an adapter's live catalog after connecting, and may use a redaction-safe
static catalog only for pre-bind previews.

Channel controls are addressed by the exact profile actor ID, never by
display name. This keeps same-provider named profiles and their mention
disambiguators isolated. The dedicated `POST /channels/:id/agent-commands`
lane requires `context:write`, rejects archived channels, requires explicit
confirmation for destructive catalog entries, and does not persist a channel
message or create a mention context packet. Normal posts that look like a
targeted control (`@agent/command` or `@agent /command`) are rejected so they
cannot accidentally route as prose.

In a Codex direct message, Relay has one provider target, so its main and thread
composers also accept bare `/model` and `/effort` through that same control lane.
The palette resolves the exact current default profile from the live roster and
then reads that profile's catalog: models and effort choices are never
reconstructed from a UI display name or assumed built-in profile id. Unknown
Codex slash input, including native `/skill` syntax, and all non-Codex DM slash
input remain ordinary prompt text. A raw bare Codex control posted to a DM is
rejected before persistence with `CHANNEL_COMMAND_REQUIRES_CONTROL_LANE`; a bare
slash input in a group channel remains ordinary prose because it has no
unambiguous target.

Only advertise controls the live provider can execute. Where provider metadata
lists models, service tiers, or reasoning efforts, derive command arguments
from that metadata and refresh the catalog on a model change. A missing catalog
may use a documented static fallback; an available catalog must reject values
it does not support. Codex model, reasoning-effort, and Fast Mode changes use
the stable `turn/start` override fields; Relay does not negotiate
`experimentalApi` or call `thread/settings/update` for them. Claude profile
model and effort values are launch-time CLI settings, not live channel
controls. Claude, OpenCode, and Hermes must not be presented as supporting a
channel control until their own adapters expose and execute it.

Codex model and effort choices are subsequent-turn overrides on the current
channel runtime/thread. Relay does not create durable cross-runtime profile
preferences for these controls; after the runtime or thread is replaced, the
provider and current session configuration again determine the effective values.

The #1375 provider audit found no equivalent advertise-then-fail path in Pi or
OpenCode: Pi exposes no Relay-owned channel controls, and OpenCode exposes no
control catalog. Prime Agent has no pre-bind control preview: its connected
catalog remains empty until the current RPC runtime has completed discovery.
The available-model catalog proves only model selection; reasoning depth appears
only when the selected model explicitly returns supported thinking levels.
Prime's `new_session`, `compact`, and `steer` methods remain omitted for the
identity, lifecycle, and turn-attribution reasons documented above; RPC method
existence alone is not an advertised Relay capability.
A missing live-evidenced native control retracts only that control for the
active runtime generation and returns a typed unavailable result; reconnect
invalidates the prior discovery result.

## Provider extension policy

Use:

- `reasoning` for thinking/analysis summaries;
- `tool` for tool calls and tool results;
- `code` for source/config snippets;
- `output` for command or process output;
- `diff` for patches and file changes.

Titles, commands, paths, language labels, content, and item ids are bounded.
Diff additions/deletions should be supplied when the provider has authoritative
counts; otherwise the bridge derives them.

## Images and attachments

`sendMessage` receives validated attachment descriptors/bytes through the
adapter boundary. Provider-produced images must pass through the channel
attachment store before appearing in a message. Do not place local file paths,
data URLs, or unbounded binary payloads in channel Markdown.

Adapters must declare whether image input is supported. A missing capability
must fail explicitly rather than silently dropping the image.

## Provider resume state

Provider session ids are opaque strings stored in the channel/profile binding.
The runtime manager passes the matching id to a replacement adapter when
resume is supported.

Relay's channel history remains authoritative for display. Provider resume
continues model context; it does not replace or replay the channel transcript.
If resume fails, the binder/runtime surfaces failure and starts no hidden
parallel conversation.

## Runtime environment

The runtime manager supplies cwd, optional repo/worktree context, model,
permission mode, system prompt, profile configuration, scoped actor
credentials, and approved environment fields.

An adapter must not read profile secrets from browser payloads or write
credentials into messages. Orchestrator-capable adapters must support bounded
runtime environment refresh so scoped credentials can rotate fail-closed.

## Queue, approval, and interruption

- Report queue capability honestly.
- Emit live-state patches when work starts, waits, resumes, or becomes idle.
- Approval ids must remain stable across the request/response round trip.
- `interrupt` must terminate the owning turn and release binder watchdog state.
- A provider error must emit both useful error context and a terminal turn
  state.

The channel UI owns approval controls. Provider-specific approval UIs are not
separate product surfaces.

## Provider extensions

Use `providerExtension` only when a payload cannot be represented by a canonical
item without losing important meaning.

Every extension needs:

- a namespaced schema/type;
- a strict size bound;
- a registered renderer or an explicit generic fallback;
- a fixture with redacted payloads;
- tests proving unknown extensions do not crash the channel.

Do not fork the channel timeline or composer per provider.

## Tests

Minimum provider proof:

1. native event → exact patch unit tests;
2. stable identity and replay/dedup tests;
3. start/delta/final/error/interrupt lifecycle;
4. capabilities and unsupported-operation failures;
5. provider resume behavior when advertised;
6. channel binder/bridge integration proving mention → runtime → durable row;
7. live `ChannelMessageRow` rendering for any new item/card shape;
8. real provider smoke when the installed provider is available.

Common commands:

```bash
npm test -- test/server/protocol-adapters/<provider>-adapter.test.ts
npm test -- test/channel-agent-binder.test.ts test/channel-agent-bridge.test.ts
npm run check
npm run build
```

## Add-provider checklist

1. Inspect one real native event stream and redact a structural fixture.
2. Implement or update the `ProtocolAdapterV2` adapter.
3. Register it in `server/protocol-adapters/index.ts` — the adapter factory AND
   its `PROVIDER_DESCRIPTORS` row, which is where every provider fact the rest of
   the server reads by name lives. An adapter without a descriptor (or the
   reverse) is a compile error.
4. Declare exact capabilities.
5. Add mapping, lifecycle, resume, and error tests.
6. Prove the channel binder/bridge path.
7. Add a provider extension renderer only when canonical cards are
   insufficient.
8. Remove replaced compatibility code and tests in the same change.
9. Run check, targeted tests, build, and a real-provider smoke where possible.

## Collaboration roles

Provider prompts may include Relay's shared collaboration appendix. Roles such
as orchestrator and implementer are Relay control metadata, not provider
identity. The operator-authenticated channel designation owns the persistent
orchestrator role; a provider cannot self-promote by emitting text or private
runtime status.
