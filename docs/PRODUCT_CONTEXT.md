# Product and context map

## Reserved nouns

Later issues may introduce these terms only with explicit ownership and storage decisions:

- **Operator session** — a scoped, revocable browser authority created only after WebAuthn passkey verification; never a node credential.
- **Node** — the current PWA binds one local Node identity and reports its bounded liveness signal; its credentials remain distinct from browser authority and it is not a remote control plane.
- **Workspace** — one local mission grouping, persisted only as bounded presentation metadata (Node binding, approved root, layout tree, and opaque content references).
- **Session** — a node-owned work execution identity. The Workspace layout may reference its opaque ID but has no lifecycle authority.
- **Message** — a future scoped communication record, not yet a mailbox.
- **TaskRun** — a future observable unit of work, not yet telemetry or analytics.

## Current surfaces

- `relay-hub` serves `GET /health` with a bounded liveness record.
- `relay-node probe` prints the same record for the node identity.
- The PWA renders one local Workspace bound to one Node and an approved local root. Non-repo roots are valid.
- The PWA persists a versioned, bounded layout tree in browser storage. Its tabs and panes contain only opaque Session references; local state never records Session runtime status or commands.
- The PWA shell renders liveness plus passkey enrollment, sign-in, typed unsupported/denied/recovery, and trusted-browser revoke controls.
- The hub validates WebAuthn at one configured HTTPS origin, issues revocable browser sessions for protected hub actions, and denies browser sessions at the node boundary.
- `relay-node codex-stdio-probe` owns a one-node, local `codex app-server --stdio` Session seam. Its explicit exercise mode creates, resumes, prompts, and cancels native Codex threads through bounded JSONL; it exposes neither a network transport nor raw provider transcripts.
- The authenticated CWD workbench binds approved local directories to native Hermes and Codex provider Sessions, stores only bounded provider-neutral events in hub memory, and restores recent opaque references after refresh without persisting credentials or raw provider frames.
- The accepted Claude terminal slice owns one bounded, local PTY per opaque Session. It launches only the fixed Claude Code executable in the explicit node-owner home, binds its separate control routes to an authenticated browser-device identity, and retains retryable teardown truth plus bounded output/scrollback. The CWD chat workbench does not yet render the combined Claude terminal UI.

## Authority and data path

The passkey client path is limited to server-side passkey ceremonies and browser-session revocation at the configured origin. Credentials, ceremonies, and session/device records are bounded in-memory state; no browser session becomes node authority.

The node owns the child-process identity and lifecycle for the Codex stdio seam and the fixed Claude PTY seam; the hub owns the bounded Hermes/Codex workbench adapters and provider-neutral event projection. None of these seams persists raw provider transcripts, credentials, approval grants, or unbounded thread data. Workspace layout persistence remains presentation-only: split, move, tab, close, reopen, and recovery mutations never create, input to, interrupt, or end a Session. Workbench Session operations use authenticated `/api/` routes, while the separate Claude PTY routes resolve the opaque browser-device identity server-side. Node liveness is checked afresh through `/health`; unavailable provider/runtime states remain explicit rather than falling back to historical data.

## Deferred scope

The combined Claude terminal workbench UI, RMUX, additional provider adapters, mailbox, files, generic Session-control APIs, browser-control grants, node credential rotation, cross-node behavior, approval-grant persistence, and legacy API compatibility remain deferred.
