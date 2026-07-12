# Product and context map

## Reserved nouns

Later issues may introduce these terms only with explicit ownership and storage decisions:

- **Operator session** — a scoped, revocable browser authority created only after WebAuthn passkey verification; never a node credential.
- **Node** — an execution location whose identity/credentials remain distinct from browser authority and are not remotely controlled by this slice.
- **Workspace** — a future mission grouping, not yet persisted.
- **Session** — a future work execution identity, not yet a process or provider adapter.
- **Message** — a future scoped communication record, not yet a mailbox.
- **TaskRun** — a future observable unit of work, not yet telemetry or analytics.

## Current surfaces

- `relay-hub` serves `GET /health` with a bounded liveness record.
- `relay-node probe` prints the same record for the node identity.
- The PWA shell renders liveness plus passkey enrollment, sign-in, typed unsupported/denied/recovery, and trusted-browser revoke controls.
- The hub validates WebAuthn at one configured HTTPS origin, issues revocable browser sessions for protected hub actions, and denies browser sessions at the node boundary.
- `relay-node codex-stdio-probe` owns a one-node, local `codex app-server
  --stdio` Session seam. Its explicit exercise mode creates, resumes, prompts,
  and cancels native Codex threads through bounded JSONL; it exposes neither a
  network transport nor raw provider transcripts.

## Authority and data path

The #1143 client write path is limited to server-side passkey ceremonies and
browser-session revocation at the configured origin. Credentials, ceremonies,
and session/device records are bounded in-memory state; no browser session
becomes node authority.

The node owns the child-process identity and lifecycle for the Codex stdio
seam. The adapter bounds and redacts event previews and does not persist raw
provider transcripts, credentials, approval grants, or thread data. The PWA
does not expose Codex control or persistence.

## Deferred scope

PTY/RMUX, Hermes, other provider adapters, mailbox, files, durable Workspace
persistence, layout, browser-control grants, node credential rotation,
cross-node behavior, approval-grant persistence, and legacy API compatibility
remain deferred.
