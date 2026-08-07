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

## Verification

```bash
npm test -- test/server/protocol-adapters/<provider>-adapter.test.ts
npm test -- test/channel-agent-binder.test.ts test/channel-agent-bridge.test.ts
npm run check
npm run build
```

Exercise a real installed provider when possible. Any new row/card shape also
needs proof through `ChannelMessageRow` or the live channel fixture.
