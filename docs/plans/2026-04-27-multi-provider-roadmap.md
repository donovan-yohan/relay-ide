# Multi-Provider Web UI Roadmap

> **Purpose:** capture the rationale and ordering for porting all four providers to AgentPatchV2 + the chat.html UI, so future sessions can pick this up without re-deriving the architectural decisions.
>
> **Context anchor:** brainstorm 2026-04-27. Read this first when resuming any provider port work.
>
> **Companion:** `docs/plans/2026-04-27-claude-web-ui-v2-design.md` (the active design for the first port).

---

## Locked Decisions

These are settled. Do not re-litigate without strong new evidence.

### 1. Architecture: normalize core, progressively enhance

`AgentPatchV2` is the integration boundary. Adapters emit normalized patches; provider-native quirks land in `AgentProviderExtensionItemV2 { namespace, payload }` with a registered renderer per namespace.

**Rejected alternatives:**

- **Pure thin envelope (Conductor-style):** wire is `{ type, id, agentType, data: unknown }` with provider-native payloads. UI forks per provider for rich rendering. Conductor (decompiled 2026-04-27) chose this with 2 providers; we reject it for 4 because chrome (queue, approvals, live-state, composer, slash) MUST be unified or the multi-provider value prop dies.
- **Full normalize (no extension hatch):** every provider event has a V2 schema entry. Rejected because new providers would block on schema PRs for every native event; iteration would crawl.

### 2. Conductor reference (decompiled findings)

Source: `/Applications/Conductor.app/Contents/Resources/bin/conductor-runtime` (Bun-compiled JS bundle, version 0.49.5, captured 2026-04-27). Worth reading the strings dump if you're working on adapter abstraction questions.

**Conductor's wire schema (Zod):**

- Outer envelope: `{ type: 'message'|'error'|..., id, agentType, data: unknown, turnId? }`
- `data` is **provider-native, not normalized**. Claude SDK msgs go raw, Codex events go raw.
- `agentType`: `"claude" | "codex" | "unknown"` — only 2 providers.
- Persistent log keeps `rawPayload: unknown` — never normalized.

**Conductor's command surface:**

- Common verbs: `query`, `cancel`, `warm_agent`, `update_permission_mode`, `fetch_available_mcp`, `fetch_slash_commands`, `context_usage`.
- Provider-specific commands first-class on the wire: `claude_auth`, `set_claude_edit_auto_accept`, `reset_generator` (claude); `codex_rollback` (codex).
- Provider-specific events first-class: `enter_plan_mode_notification`, `fast_mode_unavailable_notification`, `exit_plan_mode_request`, `checkpoint_created_notification`.
- `agentParams`: discriminated union per provider; each provider keeps its own option shape end-to-end.
- `context_usage`: discriminated by agentType — Claude returns `unknown`, Codex returns typed shape.

**Conductor's runtime choice:**

- Claude via Agent SDK (`@anthropic-ai/claude-agent-sdk`, `CLAUDE_CODE_ENTRYPOINT="sdk-ts"`).
- Codex via app-server JSON-RPC (`CodexAppServer`, `host.initializeSession({ agentType: "codex" })`).
- Telemetry: `sidecar.<provider>.<verb>` event names.
- Two sidecars (`sidecar` v1 / `sidecar-v2`) ride the same wire — `useSidecarV2: boolean` flag — wire is stable across rewrites.

**What we're borrowing:**

- Claude Agent SDK as transport (we used spawned CLI + stream-json in V1; SDK is cleaner and Conductor-validated).
- Codex `app-server` JSON-RPC as transport (same as our existing V1 plan).
- Provider-keyed telemetry pattern is a good idea once we cross-cut events.

**What we're rejecting:**

- Provider-specific events as first-class wire types. We collapse them into `providerExtension` items and gate rendering via the renderer registry. Net: fewer top-level types; renderer module per provider absorbs the variance.

### 3. Transport per provider

| Provider | Transport                                                                          | Why                                                                                                                       |
| -------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Claude   | `@anthropic-ai/claude-agent-sdk` (`CLAUDE_CODE_ENTRYPOINT="sdk-ts"`)               | Typed, kills stream-json parser, Conductor-validated.                                                                     |
| Codex    | `codex app-server` JSON-RPC                                                        | Native event stream, cleanest mapping per V1 prior plan.                                                                  |
| OpenCode | OpenCode public server (SSE-style events with `parts[]`)                           | Public repo includes web UI we can read for mapping inspiration; do **not** import their renderers — couples bug-for-bug. |
| Hermes   | Hermes gateway client (`hermes-webui` reference: github.com/nesquena/hermes-webui) | Gateway assumed running. Read their web UI for protocol shape; do not embed.                                              |

### 4. Scope sequencing: claude first, then ship others fast

Drives the brainstorm decision in `2026-04-27-claude-web-ui-v2-design.md`. We are explicitly **breaking** codex / opencode / hermes web sessions during the claude port and accepting that regression because:

- Web sessions for those three shipped recently (commits `04f967d`, `c8ec9ae`, `391639b`); not long-stable surface.
- PTY mode is unaffected for all.
- Forces immediate follow-up urgency rather than indefinite "we'll get to it" drift.
- The dogfood loop for claude produces the empirical mapping patterns that make the next three ports mechanical.

### 5. UI is rebuilt, not refactored

V1 chat components are deleted in the same branch as the claude port. `chat.html` (in `docs/design-system/ui_kits/relay-web/`) is the design target. Rationale = anti-context-poisoning (saved memory `feedback_delete_replaced_code`).

### 6. Deletion is an objective, not a cleanup phase

Every change that replaces existing code lists explicit deletion targets up-front in its design doc. Stale code poisons agent context (saved memory `feedback_delete_replaced_code`).

---

## Roadmap

### Done

- V2 protocol contract (`shared/agent-chat-protocol-v2.ts`).
- V2 adapter interface (`server/protocol-adapter-v2.ts`).
- Reference V2 adapter (`server/protocol-adapters/mock-v2-adapter.ts`).
- Frontend WS hook (`frontend/src/hooks/useAgentChatSocket.ts`).
- chat.html design (`docs/design-system/ui_kits/relay-web/chat.html`).

### In progress (this design)

- Claude V2 adapter + UI rebuild + V1 deletion. See `2026-04-27-claude-web-ui-v2-design.md`.

### Next: extract `provider-guide.md`

Written from the empirical patterns in the claude port. Sections (provisional):

1. **Native mapping table** — required event → V2 patch table format.
2. **providerExtension policy** — when to map natively vs use the escape hatch (rule of thumb: shape exists in V2 schema → map; doesn't → extension).
3. **Renderer registration** — how to add a `<namespace>` renderer module to `frontend/src/components/chat/extensions/`.
4. **Capability declaration** — semantics of each `AgentCapabilitySetV2` flag and how UI gates on it.
5. **Lifecycle integration** — `connect → sendMessage → patches → interrupt → respondToApproval` per-transport adaptation.
6. **Item ID conventions** — required correlation rules for delta updates.
7. **Testing pattern** — golden trace tests + capability gating tests.

Source materials when writing it: the claude adapter, its tests, the renderer registry pattern, the dogfood log of unmapped events.

### Next: provider-add SKILL

Mechanical wrapper around `provider-guide.md`. Inputs: provider name + transport type. Outputs: skeleton adapter file, skeleton mapping table, registry hook, test scaffolding. Lives at `.chalk/skills/add-provider/SKILL.md` (per repo skill convention).

### Provider port order

After provider-guide + SKILL exist, port providers in order:

1. **Codex** — cleanest mapping (native turn-shaped event stream); confidence-builder. Existing V1 adapter is most rigorous of the three remaining; reuse spawn / lifecycle code wholesale.
2. **OpenCode** — heaviest V1 adapter (964 lines); their public web UI is a reference. Heavier refactor; do once codex proves the SKILL works.
3. **Hermes** — gateway-attached, smallest variance from other patterns once gateway protocol is mapped.

Each port = one branch, one PR, one design doc (small — provider-guide + SKILL do most of the work). Each removes its `gateUnavailable` block in the registry.

### Polish (post-all-providers)

- Capability surface — telemetry events, rate limit display, compact UX, slash command list per provider.
- Provider-extension renderers — fill in as needed from dogfood logs.
- Migration of telemetry / agentlytics integration to V2 events (open question).

---

## Cross-cutting items

- **Telemetry blackout**: V1 telemetry feeds agentlytics. V2 doesn't emit equivalent events yet. Open question for the claude design's writing-plans phase.
- **Session resume across reconnect**: V2 has `resume: true` capability but the wire pattern (replay vs delta-since-last-seen) needs nailing. Punt to first follow-up port that exercises long-running sessions (likely codex).
- **PTY parity**: this whole roadmap is web-chat only. PTY mode for all providers is out of scope and unaffected. Don't conflate.

---

## When to revisit this doc

Revisit after each provider port lands. Update locked decisions only if a new port surfaces evidence that contradicts them — and document the contradiction. Otherwise, this is reference-only.
