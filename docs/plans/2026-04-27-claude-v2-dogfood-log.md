# Claude V2 Dogfood Log

This log starts with the implementation-session findings from the Claude Web UI V2 stack. Continue adding entries while using real Claude web sessions.

## Initial implementation findings

- `@anthropic-ai/claude-agent-sdk` version pinned: `0.2.119`.
- SDK `query()` supports an async-generator seam suitable for deterministic tests.
- Permission handling is best represented through `options.canUseTool`; relay bridges that promise with `respondToApproval()`.
- Claude queue support is adapter-local FIFO; `cancelQueued` remains `false`.
- Unknown SDK messages are visible as `providerExtension { namespace: 'claude' }` so dogfood can identify new renderer needs.

## Events to exercise manually

- [ ] text response
- [ ] thinking/reasoning block
- [ ] Bash tool use
- [ ] Edit/Write/MultiEdit tool use
- [ ] dynamic/non-core tool use
- [ ] approval allow
- [ ] approval allow-always
- [ ] approval deny
- [ ] interrupt active turn
- [ ] queued message while active
- [ ] SDK error/result failure
- [ ] Claude-specific provider extension event

## Unmapped event inventory

| Date       | Raw signature | Namespace | Decision         | Follow-up         |
| ---------- | ------------- | --------- | ---------------- | ----------------- |
| 2026-04-27 | none yet      | claude    | continue dogfood | update this table |
