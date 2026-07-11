# Product and context map

## Reserved nouns

Later issues may introduce these terms only with explicit ownership and storage decisions:

- **Node** — a future execution location, not yet a remote control plane.
- **Workspace** — a future mission grouping, not yet persisted.
- **Session** — a future work execution identity, not yet a process or provider adapter.
- **Message** — a future scoped communication record, not yet a mailbox.
- **TaskRun** — a future observable unit of work, not yet telemetry or analytics.

## Current surfaces

- `relay-hub` serves `GET /health` with a bounded liveness record.
- `relay-node probe` prints the same record for the node identity.
- The PWA shell renders that record and nothing else.

## Authority and data path

The factory owns no process, provider, filesystem, authentication, browser-control, cross-node, or product-state authority. The web shell reads the hub health endpoint only. No client write path or persistence exists.

## Deferred scope

PTY/RMUX, Codex, Hermes, provider adapters, mailbox, passkeys, files, Workspace persistence, layout, browser control, cross-node behavior, and legacy API compatibility are outside #1137.
