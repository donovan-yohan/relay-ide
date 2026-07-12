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
- `relay-node codex-stdio-probe` owns a one-node, local `codex app-server
  --stdio` Session seam. Its explicit exercise mode creates, resumes, prompts,
  and cancels native Codex threads through bounded JSONL; it exposes neither a
  network transport nor raw provider transcripts.

## Authority and data path

The node owns the child process identity/lifecycle for the Codex stdio seam.
The adapter bounds/redacts event previews and does not persist raw provider
transcripts, credentials, approval grants, or thread data. The web shell still
reads the hub health endpoint only; it has no client write path or persistence.

## Deferred scope

PTY/RMUX, Hermes, other provider adapters, mailbox, passkeys, files, Workspace
persistence, layout, browser control, cross-node behavior, approval-grant
persistence, and legacy API compatibility remain deferred.
