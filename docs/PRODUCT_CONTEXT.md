# Product and context map

## Reserved nouns

Later issues may introduce these terms only with explicit ownership and storage decisions:

- **Node** — the current PWA binds one local Node identity and reports its bounded liveness signal; it is not a remote control plane.
- **Workspace** — one local mission grouping, persisted only as bounded presentation metadata (Node binding, approved root, layout tree, and opaque content references).
- **Session** — a node-owned work execution identity. The Workspace layout may reference its opaque ID but has no lifecycle authority.
- **Message** — a future scoped communication record, not yet a mailbox.
- **TaskRun** — a future observable unit of work, not yet telemetry or analytics.

## Current surfaces

- `relay-hub` serves `GET /health` with a bounded liveness record.
- `relay-node probe` prints the same record for the node identity.
- The PWA renders one local Workspace bound to one Node and an approved local root. Non-repo roots are valid.
- The PWA persists a versioned, bounded layout tree in browser storage. Its tabs and panes contain only opaque Session references; local state never records Session runtime status or commands.
- `relay-node codex-stdio-probe` owns a one-node, local `codex app-server --stdio` Session seam. Its explicit exercise mode creates, resumes, prompts, and cancels native Codex threads through bounded JSONL; it exposes neither a network transport nor raw provider transcripts.

## Authority and data path

The node owns the child process identity/lifecycle for the Codex stdio seam. The adapter bounds/redacts event previews and does not persist raw provider transcripts, credentials, approval grants, or thread data. The PWA's Workspace layout is presentation-only: split, move, tab, hide, close, reopen, and recovery mutations never launch, duplicate, input to, or end a Session. Node liveness is checked afresh through `/health`; an unavailable or unknown state disables live-session affordances without historical/local fallback.

## Deferred scope

PTY/RMUX, Hermes, other provider adapters, mailbox, passkeys, files, multi-node Workspaces, Session-control API wiring, browser control, cross-node behavior, approval-grant persistence, and legacy API compatibility remain deferred.
