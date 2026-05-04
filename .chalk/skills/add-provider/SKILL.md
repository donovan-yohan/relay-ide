---
name: add-provider
description: Add or port a relay-ide web-chat provider to AgentPatchV2. Use when implementing Codex, OpenCode, Hermes, or any new provider adapter for the web UI.
---

# Add AgentPatchV2 Provider

Use this skill to port a provider to the normalized Agent Chat Protocol V2 web-chat path.

## Required reading

Before touching code, read:

1. `docs/provider-guide.md`
2. `docs/plans/2026-04-27-multi-provider-roadmap.md`
3. `shared/agent-chat-protocol-v2.ts`
4. `server/protocol-adapter-v2.ts`
5. The most recent working provider adapter, currently `server/protocol-adapters/claude-adapter.ts`

## Inputs

Collect these facts:

- Provider name and registry key.
- Native transport: SDK, JSON-RPC, SSE, gateway, or process.
- Native event inventory.
- Capability set.
- Approval/permission mechanism.
- Interrupt mechanism.
- Queue/cancel support.
- Session resume identifier.

## Mapping table

Write a provider-specific mapping table before implementation:

```markdown
| Native event | V2 patch | Item type | Correlation key | Notes |
| ------------ | -------- | --------- | --------------- | ----- |
```

Every native event must either map to a core V2 item/patch or to `providerExtension`.

## Implementation steps

1. Create `test/server/protocol-adapters/<provider>-adapter.test.ts`.
2. Write failing golden trace tests for capabilities, init, text, tools, approvals, errors, queue, and unknown events.
3. Implement `server/protocol-adapters/<provider>-adapter.ts` as a `BaseProtocolAdapterV2` subclass.
4. Add a deterministic transport seam so tests never spawn the real CLI/server.
5. Register the provider in `v2Adapters` in `server/protocol-adapters/index.ts`.
6. Add provider extension renderers under `frontend/src/components/chat/extensions/<provider>/` only for provider-specific payloads.
7. Restore/rewrite provider web-session tests to assert V2 patches, not V1 `ChatEvent`s.
8. Delete replaced V1 code in the same PR when the adapter is fully native.

## Verification

Run:

```bash
npm test -- test/server/protocol-adapters/<provider>-adapter.test.ts
npm test -- test/web-session-handler.test.ts test/web-session-v2.test.ts
npm run check
npm run build
```

Before opening PR, also run the pre-push hook by pushing from the provider worktree.

## PR requirements

The PR body must include:

- Provider transport and event source.
- Mapping coverage summary.
- Capability set.
- Verification output.
- Any temporary bridge/deletion debt.
- Stack base and next stack branch.
