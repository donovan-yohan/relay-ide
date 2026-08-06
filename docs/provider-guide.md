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

Only advertise controls the live provider can execute. Where provider metadata
lists models, service tiers, or reasoning efforts, derive command arguments
from that metadata and refresh the catalog on a model change. A missing catalog
may use a documented static fallback; an available catalog must reject values
it does not support. Codex currently implements Relay-owned controls including
Fast Mode through this contract. Claude, OpenCode, and Hermes must not be
presented as supporting a channel control until their own adapters expose and
execute it.

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
