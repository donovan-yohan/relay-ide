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
- The PWA persists a versioned, bounded layout tree in browser storage. Its tabs and panes contain only opaque Session references. Bounded recent Claude metadata may retain a status hint, but runtime polling remains authoritative and no terminal bytes or commands enter persisted metadata.
- The PWA shell renders liveness plus passkey enrollment, sign-in, typed unsupported/denied/recovery, and trusted-browser revoke controls.
- The hub validates WebAuthn at one configured HTTPS origin, issues revocable browser sessions for protected hub actions, and denies browser sessions at the node boundary.
- `relay-node codex-stdio-probe` owns a one-node, local `codex app-server --stdio` Session seam. Its explicit exercise mode creates, resumes, prompts, and cancels native Codex threads through bounded JSONL; it exposes neither a network transport nor raw provider transcripts.
- The authenticated CWD workbench browses only canonical approved node directories, binds a selected folder to a Project, and runs native Hermes and Codex provider Sessions from that CWD.
- Claude Code uses the same recent-Session and tab/pane workbench, but renders real xterm instead of chat. Creation accepts only an opaque Workspace id; the hub resolves and revalidates its approved CWD before the fixed executable is spawned with the node-owner HOME/PATH/auth context.
- Claude input, bounded incremental output, status, resize, interrupt, and explicit close use the authenticated Relay-owned PTY routes. Refresh reattaches by opaque PTY id; a missing prior runtime stays a typed stale Session rather than simulated output.

## Authority and data path

The passkey client path is limited to server-side passkey ceremonies and browser-session revocation at the configured origin. Credentials, ceremonies, and session/device records are bounded in-memory state; no browser session becomes node authority.

The node owns the child-process identity and lifecycle for the Codex stdio seam and fixed Claude PTY seam; the hub owns approved Workspace bindings, bounded Hermes/Codex adapters, provider-neutral chat events, and bounded Claude Session metadata. None of these seams persists raw provider transcripts, terminal bytes, credentials, approval grants, or unbounded thread data. Workspace layout persistence remains presentation-only: split, move, tab, and view close never create, input to, interrupt, or end a Session. Explicit Claude process close remains a separate labeled action. Workbench operations use authenticated `/api/` routes, while Claude PTY routes resolve browser-device ownership and Workspace CWD server-side.

## Deferred scope

RMUX, additional provider adapters, mailbox, files, generic Session-control APIs, browser-control grants, node credential rotation, cross-node behavior, approval-grant persistence, and legacy API compatibility remain deferred.
