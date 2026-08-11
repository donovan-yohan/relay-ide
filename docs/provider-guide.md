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

| Provider    | Provider id   | Native channel transport               |
| ----------- | ------------- | -------------------------------------- |
| Claude Code | `claude`      | persistent subprocess over stream JSON |
| Codex       | `codex`       | `codex app-server` JSON-RPC            |
| OpenCode    | `opencode`    | native SDK/events                      |
| Hermes      | `hermes`      | Responses API/SSE                      |
| Prime Agent | `prime-agent` | `prime-agent` RPC                      |
| Pi          | `pi`          | `pi --mode rpc` JSONL                  |

Prime Agent is a first-class channel provider. Its adapter maps accepted prompts and `agent_end` boundaries to Relay turn
lifecycle, `message_update` text and
thinking deltas to assistant and reasoning items, and
`tool_execution_start|update|end` to canonical command, file-change, or dynamic
tool items. It advertises text, reasoning, tools, command execution, file
changes, queueing, interrupt, resume, telemetry, and streaming; unsupported
approval, question, plan, and queue-cancellation operations remain false. Because Prime steering stays within one native run, Relay queues concurrent
messages locally and sends a fresh RPC prompt after each `agent_end`, preserving
one durable Relay turn per message. Channel subprocesses currently launch with
`--no-extensions` because blocking `extension_ui_request` dialogs are not mapped
to Relay approvals/questions yet.

The channel command palette discovers Prime models from the connected RPC
runtime and exposes `model`, plus `thinking`/`effort` only when the selected
live model explicitly supplies supported thinking levels. These execute on
Relay's authenticated control lane, not as persisted chat messages or
token-consuming prompts. Fresh-session and compaction controls are intentionally
hidden until Prime supplies an authoritative non-mutating capability source for
their RPC methods. Model and thinking arguments are validated against live Prime
metadata; if discovery is unavailable, the adapter fails closed instead of
guessing. Prime skills, prompt templates, and TUI-only commands are not exposed
as channel controls. This control surface is installed-tested with Prime Agent
0.7.0. It assumes strict-LF JSONL records, a correlated `get_state` readiness
response, `agent_end` as the settled run boundary, and
`sessionActions.queuedCount` as a finite non-negative integer; a runtime that
cannot return a valid live model catalog publishes no connected command catalog.

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
Fresh-session and compaction controls remain hidden because the current RPC
contract has no authoritative non-mutating capability source for those methods.
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
3. Register it in `server/protocol-adapters/index.ts`.
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
