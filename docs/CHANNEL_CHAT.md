# Channel Chat — Slack-style workspace interface

> **Status: mostly PLANNED (epic #1163).** This doc is the direction, not a
> shipped contract. It marks each claim **SHIPPED** (verified in current code)
> or **PLANNED** (epic/slice target). It replaces the retired `WEB_CHAT.md`,
> which described the session-centric v1 chat surface now being torn out.

## Vision (PLANNED)

Relay's UI becomes a Slack-style workspace. Workspaces live in a left rail;
channels live in a per-workspace sidebar; each channel is a durable, multi-party
conversation where humans and agents (`@claude` / `@codex` / `@hermes`) talk in
one shared timeline. Two surfaces, one substrate:

- **Desktop** — full working suite: terminal, file browser, editor, embedded
  browser, chat, and deep pane integrations, arranged around the conversation.
- **Mobile** — mission control: watch runs, nudge agents, triage attention. Not
  a code editor; a cockpit.

All-dark, black theme only (see `DESIGN.md`, owned separately — do not restyle
here).

## Architecture pivot (PLANNED)

The old model was **session = conversation** (one chat bound to one agent
process). The pivot inverts it:

- **Channel = conversation.** Agents are _participants_ in a channel, not the
  channel itself.
- **DM = a 2-member channel** (one human, one agent). No separate DM primitive.
- **@-mention routes** a message into an adapter session bound to
  `(channel, agent)`. The session is **spawned on first mention** and its
  streamed replies are attributed to that agent inside the channel timeline.
- **Single-node first.** Cross-node chat routing is deferred; channel + agents
  live on one node for the initial slices.

## Mapping to existing primitives (SHIPPED substrate, PLANNED wiring)

The substrate below already exists in code; the channel-chat product is new
wiring over it. Verified 2026-07-17 against source:

| Concept         | Primitive (SHIPPED)                                                                 | Notes                                                                                                                                                                                                                                                      |
| --------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workspace       | `ia_workspaces` (`server/ia-store.ts`, epic #1021)                                  | Rail entries: `status`, `pinned`, `color`, `icon`, `default_repo_path`, `default_node_id`.                                                                                                                                                                 |
| Channel         | `workspace_topics` (`server/workspace-topics.ts`)                                   | Record carries `routingDefaults`, `promptDefaults`, and channel `kind` = repo/product-area/journal/ops/research/topic. Channel identity = topic id.                                                                                                        |
| Message store   | `channel_messages` (`server/channel-message-store.ts`, #1165 SHIPPED)               | New durable `channel-chat.db`: per-channel gap-free `seq`, streaming lifecycle, `sender_kind`/`sender_id`, `thread_id`/`parent_message_id`, `source_*` bridge provenance. `work_context_messages` is agent-mail (#945), a deliberately separate substrate. |
| Mention targets | Agent roster (`shared/agent-roster.ts`, #952/#953)                                  | `RosterEntry.provider` = framework id (`claude`/`codex`/`hermes`); derived per live session.                                                                                                                                                               |
| Agent transport | `ProtocolAdapterV2` (`server/protocol-adapter-v2.ts`, `protocol-adapters/index.ts`) | v2 registry: `mock`, `claude`, `codex` (native), `opencode`/`hermes` via legacy bridge.                                                                                                                                                                    |

**Verification nuance:** the roster is _derived from live sessions_ and keyed by
`sessionId` + `provider`, not a persistent per-agent handle registry. So
`@claude` resolves to a framework/provider id, and spawn-on-first-mention must
bind `(channel, agent-framework)` and create the session — it cannot assume a
roster row already exists. This is new wiring, not a contradiction.

## Claude integration decision (HARD — do not soften)

**No Anthropic Agent SDK.** Claude participation is a **persistent
`claude --input-format stream-json --output-format stream-json` subprocess per
conversation**, following the pattern in
[dkapo88/claude-code-openai-server](https://github.com/dkapo88/claude-code-openai-server)
(`feat/native-image-passthrough`) — but **re-implemented natively in the Relay
TypeScript backend**. No Python sidecar, no OpenAI-shaped shim.

- **Warm process across turns** — keep the subprocess alive so OAuth CLI billing
  applies (not per-request API billing).
- **Warm pool + idle eviction** — pooled subprocesses, evicted when idle.
- **`--resume` cold recovery** — reattach a conversation after eviction/restart.
- **Image passthrough** — native image input through the stream-json channel.
- **Later:** MCP loopback so the subprocess gets channel-native tools — read
  channel history, read the roster, post back into the thread.

This replaces the current `ClaudeProtocolAdapter` (`claude-adapter.ts`), which
drives Claude through the Anthropic Agent SDK (`@anthropic-ai/claude-agent-sdk`
`query()`) and is de-advertised for web sessions under #300.

## Slice 2 — Channel core (SHIPPED, #1165)

The conversation substrate is live and fully additive (`web_sessions`, `/ws/:sessionId`,
agent mail, and every adapter are untouched):

- **Durable store** `server/channel-message-store.ts` (`channel-chat.db`): atomic
  single-statement `seq` allocation with a `UNIQUE(channel_id, seq)` backstop,
  streaming rows (begin → debounced partial-text flush → finalize in place),
  boot sweep of stale `streaming` → `interrupted` (+ system message), orphan GC
  against the topic store, source-triple and `clientMessageId` idempotency, 256KB
  per-message cap. **Unread arithmetic must count by seq range; catch-up is always
  DB-backed** (the durable seq log is the replay buffer — there is no event ring).
- **Wire protocol** `shared/channel-chat-protocol.ts`: `ChannelEventV1` (snapshot /
  created / delta / completed / resync-required), a runtime validator, a pure
  self-diagnosing reducer (gap → `needsCatchup`, `deltaIndex` + quarantine per
  message), and `parseMentions`. **`AgentPatchV2` is not extended** — a server-side
  bridge translates instead, so no adapter changes.
- **Fan-out** `server/channel-hub.ts` + `GET /ws/channels/:channelId?sinceSeq=N`:
  server→client only, register-before-snapshot connect with snapshot/live dedupe,
  50ms delta coalescing, per-socket backpressure (suppress deltas → resync → 4409),
  and coarse `channel-activity` sidebar badges on `/ws/events`.
- **Verbs** `server/channel-chat-router.ts`: `channels.list/get/history/post`
  (REST-only writes, one internal `postToChannel`). **Sender is server-derived from
  the auth lane, never the request body**; derived/archived topics are rejected;
  the verbs are wired into the CLI-gateway capability map.
- **Slice-4 seam** `server/channel-agent-bridge.ts`: `AgentPatchV2` → channel
  lifecycle translation, shipped and contract-tested but unwired until #1167.

**Privacy note:** channel message bodies are stored **raw**, with no redaction
pipeline (unlike the `work_context_messages` sanitizer,
`shared/work-context-message.ts`). This is consistent with `agent_session_v2_json`
today, but is a standing privacy posture decision to revisit before any
`visibility:'shared'` / multi-user channel.

## Live proof gate (PLANNED)

Token-frugal testing against **real** Claude / Codex accounts — hello-world
prompts only, no burn. Proof matrix:

1. DM each agent (2-member channel round-trip).
2. Agent-to-agent mention (one agent `@`-mentions another in a channel).
3. Multiple agents live in one channel at once.

## Ladder (epic #1163)

| Slice | Scope                                                                      |
| ----- | -------------------------------------------------------------------------- |
| #1164 | Debt clear — retire v1 chat surface / kill-list items below.               |
| #1165 | Channel core — channel = conversation model over the substrate.            |
| #1166 | Channel UI + DM-as-channel.                                                |
| #1167 | `@`-mentions — route mention → `(channel, agent)` session, spawn-on-first. |
| #1168 | Claude subprocess adapter (native stream-json, warm pool, `--resume`).     |
| #1169 | Multi-agent live proof + Codex revive.                                     |
| #1170 | Threads (`parent_message_id` / `thread_id`).                               |
| #1171 | Mobile cockpit (mission control).                                          |
| #1172 | Tauri desktop suite (backlog).                                             |

## Kill list (PLANNED removal)

- Session-centric chat UI (one chat ↔ one agent process).
- v1 chat protocol remnants (`ChatEvent` v1 path, `ProtocolAdapter` v1 surface).
- Legacy sidebar surfaces: `ViewSpineTree`, `WorkspaceBar`.
- Light theme (black-only).
- `docs/WEB_CHAT.md` itself (retired by this doc).
