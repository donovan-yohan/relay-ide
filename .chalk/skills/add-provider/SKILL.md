---
name: add-provider
description: Add or port an agent provider into Relay channels through ProtocolAdapterV2, ChannelAgentRuntime, the channel binder, and the channel bridge.
---

# Add a channel agent provider

Use this skill when adding Claude, Codex, OpenCode, Hermes, or a custom agent
provider to Relay's channel-first product.

## Required reading

1. `docs/provider-guide.md`
2. `docs/CHANNEL_CHAT.md`
3. `server/protocol-adapter-v2.ts`
4. `shared/agent-chat-protocol-v2.ts`
5. `server/channel-agent-runtime.ts`
6. `server/channel-agent-binder.ts`
7. `server/channel-agent-bridge.ts`

## Workflow

1. Capture and redact one real native event stream.
2. Write a deterministic native-event → `AgentPatchV2` mapping table.
3. Implement or update the `ProtocolAdapterV2` adapter.
4. Preserve stable native ids; use deterministic fallback ids only when needed.
5. Declare exact capabilities for resume, queue, approvals, questions, images,
   and runtime environment refresh.
6. Register the adapter in `server/protocol-adapters/index.ts`.
7. Map common output to canonical detail cards.
8. Add a bounded provider extension only when canonical items are insufficient.
9. Prove mention → private runtime → durable channel row through binder/bridge
   integration tests.
10. Delete replaced compatibility code and tests in the same change.

## Identity rules

- The agent profile actor id is the channel participant.
- The provider id chooses the adapter.
- The private runtime id is not a conversation or public session.
- Provider session ids are opaque resume state.
- Never attribute visible messages to a transient runtime id.

## Editing existing adapters

Roughly half of `server/protocol-adapters/` is choreography repeated across
adapters, so any edit to shared-looking logic is a classification decision
before it is a code change.

1. Grep the sibling adapters for the same concern before you change it.
2. Classify the change:
   - **QUIRK** — harness-specific: event vocabulary, protocol handshake,
     resume-id name, permission-mode flag. Stays adapter-local. Never copy it
     into another harness, and say why it is local in the PR.
   - **CHOREOGRAPHY** — the same shape in three or more adapters: lifecycle
     ordering, patch emission, id fallbacks, env sanitizing. Extend the shared
     utils layer (`server/protocol-adapters/adapter-utils.ts`) instead of
     writing copy N+1.
3. When the shared shape almost fits, add a hook, not a fork. `reconnect()`
   matches in claude/codex-native/hermes/opencode apart from the not-connected
   wording, which the shared helper takes as a parameter; pi-agent and
   prime-agent fold `providerSessionId` into config first — that is a
   config-transform hook, not a reason to duplicate.
4. Renaming or adding a provider also touches sites outside this directory: the
   resume-id ladder in `server/channel-agent-runtime.ts` and the launch
   contracts plus capability sets in `server/protocol-adapters/index.ts`.
5. Every PR touching `server/protocol-adapters/**` starts a PR-body line with
   `Adapter generality:` stating the classification and its reason. CI requires
   the line (or the `adapter-generality-reviewed` label); the `adapter-review`
   skill checks that it is true.

Mass extraction of the repeated choreography is sequenced behind an adapter
conformance suite. Until that lands, extend shared utils only for the concern
you are already touching.

## Verification

```bash
npm test -- test/server/protocol-adapters/<provider>-adapter.test.ts
npm test -- test/channel-agent-binder.test.ts test/channel-agent-bridge.test.ts
npm run check
npm run build
```

Exercise a real installed provider when possible. Any new row/card shape also
needs proof through `ChannelMessageRow` or the live channel fixture.
