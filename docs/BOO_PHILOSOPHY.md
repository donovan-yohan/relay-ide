# Boo-style session substrate audit

Status: current source-of-truth audit for the `coder/boo`-inspired direction. Verify against code/current docs before treating behavior as shipped.

## Philosophy

Relay should feel like a scriptable terminal multiplexer and an operator cockpit over real agent CLIs, not a browser-only terminal clone.

The durable rules are:

1. **CLI/API first.** Anything important in the web UI needs a stable `relay-ide v1 ... --json` command or documented API. Agents should never need browser scraping, private `/hub/node-link` messages, provider profile DB reads, or direct tmux/rmux commands when Relay can own the primitive.
2. **Session identity is not pane identity.** A terminal pane, browser tab, mobile card, command-palette result, or dashboard row is a view over a `Session` inside a `WorkContext`; it is not the product source of truth.
3. **Raw bytes are not rendered state.** PTY streaming is useful, but automation often needs a bounded rendered-screen snapshot, cursor/title/mode metadata, and wait predicates over that modeled screen.
4. **Terminals stay available, but cockpit comes first.** Operator surfaces should prioritize active `WorkContext`s, nodes, actors/control mode, latest bounded status, artifacts, approvals, stale/offline state, and safe actions; terminal attach is the fallback/deep-interaction surface.
5. **Capabilities and audit wrap control.** Sends, keys, attach, kill, approvals, hand-back, artifact reads, file operations, and future screen APIs must stay inside Relay's `CapabilityGrant`, `AuditEvent`, and scoped credential model.

## Boo primitive comparison

| Boo-style primitive | Relay current state | Source of truth / caveat |
| --- | --- | --- |
| `new` / detached session | **Partial.** `sessions.create` creates local or routed sessions and returns a descriptor; `sessions.detach` releases the CLI handle without killing the process. There is no explicit `--detached` terminal-multiplexer-style create flag because Relay sessions are already hub-owned handles once created. | `docs/CLI_GATEWAY.md`, `shared/cli-gateway-contract.ts` |
| `ls --json` | **Implemented.** `sessions.list` / `sessions.get` expose stable JSON descriptors. | `docs/CLI_GATEWAY.md` |
| `send --text` / `send --key` | **Partial.** Raw `sessions.input` can write bytes; typed `supervisor.sendText`, `supervisor.sendKey`, and `supervisor.submit` are auditable. Enter is covered by `supervisor.submit`; named keys cover Escape, Tab, arrows, Ctrl-C/Ctrl-D, Home/End, and Page Up/Down. Function keys and arbitrary keymaps remain out of scope. | `docs/CLI_GATEWAY.md` |
| `wait --text` / `wait --idle` | **Partial.** `sessions.input --wait-for` does bounded raw output substring waiting; `sessions.stream --idle-timeout-ms` detaches a stream after quiet. Missing: standalone wait command and rendered-screen/cursor/title/mode predicates. | `docs/CLI_GATEWAY.md` |
| `peek --json` / rendered screen | **Missing as stable API.** `relay-pty` maintains a libghostty-backed model internally for relay-pty sessions, and internal helpers can read visible text, but no stable gateway command exposes rendered screen JSON/scrollback. | `docs/TERMINAL_BACKENDS.md`, `server/terminal-model-backend.ts` |
| `attach` / optional UI | **Partial.** Browser attach and CLI descriptor attach exist; `sessions.stream` attaches to the PTY stream. Missing: power-user CLI/TUI cockpit comparable to `boo ui`; current cockpit is web-first. | `docs/CLI_GATEWAY.md`, `docs/WORKBENCH_BOUNDARY.md` |
| Session manager cockpit | **Partial.** Active Work, sidebar attention states, command palette, and Workbench blocks exist, but default desktop chrome is still repo/worktree/session heavy and Workbench canvas is not primary. | `docs/FRONTEND.md`, `docs/WORKBENCH_BOUNDARY.md` |

## What is actually built

### Built and stable enough to document as shipped

- Versioned JSON gateway discovery and schemas: `relay-ide v1 --list --json` and `relay-ide v1 schema --json`.
- Stable session descriptor/lifecycle commands: `sessions.list`, `sessions.get`, `sessions.create`, `sessions.attach`, `sessions.detach`, `sessions.kill`, `sessions.rename`.
- Raw PTY stream/input primitives: `sessions.stream --mode ndjson`, `sessions.input --data|--data-base64|--stdin` with `--wait-for`, `--timeout-ms`, and `--max-bytes`.
- Typed supervisor actions: `supervisor.sessions`, `supervisor.snapshot`, `supervisor.sendText`, `supervisor.sendKey`, and `supervisor.submit` with capability/error metadata.
- `relay-pty` as the default non-tmux PTY backend, with `tmux-compat` retained for legacy/import/resume cases.
- Internal libghostty-vt terminal model for relay-pty sessions, used by backend helpers and attention detection.
- Active Work / workbench/control-plane nouns: `WorkContext`, `Actor`, `Session`, `Node`, `Artifact`, `AuditEvent`, `CapabilityGrant`.
- Frontend attention state, unread tracking, sidebar metadata, Active Work grouping, and command-palette session navigation.

### Built, but not yet the public Boo-style contract

- The libghostty-backed terminal model is internal. It is not yet exposed through a stable `sessions.screen`, `sessions.peek`, or `sessions.wait` command.
- `sessions.input --wait-for` watches raw observed output. It is not a proof that a particular rendered screen/viewport/cursor state exists.
- Backend-neutral session helpers still carry tmux-shaped names internally (`sendTmuxText`, `sendTmuxKeys`, `captureTmuxPane`) even when they branch correctly for `relay-pty`.
- `RelayPtySession` exists as a class, but production session creation currently uses the `pty-handler` path with direct `node-pty` spawn plus terminal model. Docs should say `relay-pty` is the default direct PTY/libghostty-backed backend, not that the `RelayPtySession` class owns production sessions.
- Active Work is strong, but not the default/primary desktop cockpit; the default sidebar still exposes a repo/worktree-first organization.

### Not built / do not document as shipped

- Stable rendered-screen snapshot API with rows/cols/cursor/title/modes/viewport/scrollback JSON.
- Stable rendered-screen wait API (`wait --screen-text`, `wait --idle`, `wait --title`, etc.).
- Stable function-key/keymap API beyond the closed `supervisor.sendKey` MVP enum.
- Durable relay-pty live process reattach across server restart. Browser disconnect is fine; server restart durability is still where `tmux-compat` has the stronger story.
- A terminal-multiplexer-style power-user CLI/TUI session manager. Relay's richer cockpit is currently web/dashboard oriented.
- Workbench canvas as the primary integrated cockpit surface.

## Documentation rules

Use these rules when updating docs, issues, or UI copy:

- Say **terminal backend** unless the behavior is specifically `tmux-compat`.
- Say **raw PTY stream/input** for `sessions.stream` and `sessions.input`.
- Say **typed supervisor action** for `supervisor.sendText` / `supervisor.sendKey` / `supervisor.submit` command IDs, or `relay-ide v1 supervisor send-text` / `relay-ide v1 supervisor send-key` / `relay-ide v1 supervisor submit` CLI argv.
- Do not call raw stream/input a rendered-screen API.
- Do not imply `relay-pty` sessions survive server restart as the same live process.
- Do not tell adapters to use internal REST routes, browser WebSockets, node-link, tmux, or private provider stores as contracts.
- If a needed primitive is missing, add it to `shared/cli-gateway-contract.ts` and document it here/`CLI_GATEWAY.md` before adapters rely on it.

## Work tracking

Follow-up work belongs in GitHub Issues. This document records shipped/not-shipped boundaries and should link issues once they exist rather than carrying a parallel roadmap.
