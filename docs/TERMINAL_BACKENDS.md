# Terminal backend: relay-pty only

Relay now has one supported PTY execution backend for local and routed node sessions:

- `relay-pty`: Relay's direct PTY/libghostty-vt-backed pipeline. It is the default and the only accepted terminal backend for interactive agent and terminal sessions.

`tmux-compat` is removed as a runtime backend. New session requests, repo/workspace defaults, node manifests, and CLI gateway inputs must treat `tmux-compat` as unsupported/rejected instead of selecting a compatibility path.

## Configuration

`terminalBackend` remains the public create/config knob for compatibility with existing clients and saved config, but the only valid value is:

```json
{ "terminalBackend": "relay-pty" }
```

Behavior by input:

- omitted or `"relay-pty"` => create/restore with `relay-pty`;
- `"tmux-compat"` => reject as an unsupported legacy backend;
- any other value => reject as invalid/unsupported.

`RELAY_IDE_TERMINAL_BACKEND`, global config, workspace settings, repo settings, and per-session input can no longer opt back into tmux. Operators should remove old `tmux-compat` defaults rather than expecting Relay to fall back to tmux.

Legacy `useTmux` fields are not part of the v1 `sessions.create` surface. If old serialized data still contains `useTmux: true` or a tmux session name, treat that state as legacy/tombstoned metadata, not as an instruction to restore a tmux-backed process.

## Reconnect, replay, and cold resume

`relay-pty` owns a direct child PTY while the Relay server process is alive. It is **not** a process supervisor or daemon.

What survives today:

- **Browser refresh / browser reconnect:** the same live Relay server can reattach the browser/WebSocket handle to the existing `relay-pty` child process and replay bounded in-memory scrollback.
- **Hub/node reverse-link reconnect:** if the owning Relay node process stayed alive, the hub can reconnect to the node and reattach through the node's live session registry.
- **Relay server process restart:** this is a cold resume. Relay can read saved session metadata and persisted scrollback, reconstruct session rows, and start a new PTY/session according to the saved metadata. It cannot reattach to the exact child process that belonged to the old server process.

Live child-process continuity across a Relay server restart requires future daemon/supervisor work. Do not document current `relay-pty` as tmux-style process persistence across server restarts.

## Legacy tmux-backed state

Old serialized tmux-backed state is unsupported:

- saved `terminalBackend: "tmux-compat"`, `useTmux: true`, `tmuxSessionName`, or tmux-prefixed runtime names are tombstones for historical state;
- Relay should not spawn `tmux`, run `tmux attach-session`, or attempt `tmux capture-pane` to recover that state;
- adapters and operators should create a new `relay-pty` session if work needs to continue;
- provider-native resume data, when available, remains a separate read-only provider boundary and is not a tmux restoration path.

## Automation and rendered-screen boundary

`relay-pty` keeps Relay on the path toward Boo-style terminal automation: Relay owns the PTY process path, maintains a libghostty-backed terminal model, and exposes backend-neutral control primitives without depending on tmux pane scraping.

Public stable adapter contract today:

- raw stream/input through `relay-ide v1 sessions stream` and `relay-ide v1 sessions input`;
- bounded raw-output waits through `relay-ide v1 sessions wait`;
- rendered-screen snapshots through `relay-ide v1 sessions screen` for live `relay-pty` sessions;
- typed supervisor actions through `relay-ide v1 supervisor send-text`, `relay-ide v1 supervisor send-key`, and `relay-ide v1 supervisor submit`.

Not stable adapter API:

- direct access to libghostty state, browser xterm.js internals, private `/hub/node-link` frames, or any tmux/rmux command;
- pretending raw PTY bytes are the same as rendered viewport/cursor/title state;
- live process recovery across Relay server restarts without a future supervisor/daemon.

Promote any new screen/read/wait primitive through `shared/cli-gateway-contract.ts` and `docs/CLI_GATEWAY.md` before external adapters rely on it. See `BOO_PHILOSOPHY.md` for the current audit and boundary rules.

## Backend-neutral terminal helpers

Internal session control code should prefer backend-neutral terminal names:

- `sendTerminalText` writes literal terminal input text to the active PTY backend.
- `sendTerminalKeys` writes key/control input such as `Enter`, arrows, or `CtrlC`.
- `captureTerminalVisibleText` captures the currently rendered/visible terminal text from Relay's terminal model.

Legacy tmux-shaped helper names should not appear in new code paths. If compatibility aliases still exist during migration, treat them as internal cleanup debt, not as a supported backend boundary.
