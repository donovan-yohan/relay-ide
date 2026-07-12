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

## Authority and data path

The factory owns no process, provider, browser-control grant, cross-node, or product-state authority. The #1143 client write path is limited to server-side passkey ceremonies and browser-session revocation at the configured origin. Credentials, ceremonies, and session/device records are bounded in-memory state; no browser session becomes node authority.

## Deferred scope

PTY/RMUX, Codex, Hermes, provider adapters, mailbox, files, durable Workspace persistence, layout, browser-control grants, node credential rotation, cross-node behavior, and legacy API compatibility remain deferred.
