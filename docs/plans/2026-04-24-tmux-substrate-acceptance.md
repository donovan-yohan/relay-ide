# Tmux Substrate Acceptance Notes

Issue: [#264](https://github.com/donovan-yohan/relay-ide/issues/264)

Historical note: this plan records the pre-#837 tmux-first acceptance contract. Current source-of-truth behavior lives in `docs/TERMINAL_BACKENDS.md`: `relay-pty` is the default for new sessions, and `tmux-compat` is legacy/import/fallback only.

## Acceptance Contract

- xterm.js remains the browser terminal renderer. It owns display, input capture, fit/resize, renderer fallback, and browser-specific terminal behavior.
- The pre-#837 contract treated tmux as the server-side PTY/session/process substrate for interactive agent and terminal sessions. Current behavior is documented in `docs/TERMINAL_BACKENDS.md`: `relay-pty` is the default, and `tmux-compat` preserves legacy tmux-backed restore/import behavior.
- `node-pty` remains the server adapter between WebSocket I/O and tmux. It should not be treated as the durable session owner.
- Documentation and UI text should not describe `launchInTmux` or tmux wrapping as an optional launch mode for interactive sessions. Any remaining config field is compatibility/migration surface, not a product choice.

## Naming And Restore

Stable tmux names are part of the restore contract:

```text
<prefix><sanitized repo-or-repo-branch slug>-<first 8 chars of session id>
```

- Production prefix: `relay-ide-`
- Dev prefix: `relay-dev-` when `RELAY_IDE_DEV_INSTANCE=1`
- The slug is sanitized to alphanumeric/hyphen characters and capped before the id suffix.
- Agent sessions should prefer repo/branch-oriented slugs for readable `tmux ls` output. Browser display names such as `Agent 1` remain separate from tmux names.
- Restore should preserve the original session id and tmux session name.
- On restart, Relay first checks whether the named tmux session still exists and reattaches with `tmux -u attach-session -t <name>`.
- If the tmux session is gone, Relay may fall back to agent-specific continue args and create a fresh tmux-backed process.
- The session registry exposes targeted tmux helpers for sending keys/text and capturing a pane by Relay session id, so future pane layouts can address the process substrate without depending on the currently active browser PTY socket.

## Why This Unblocks #263

Workspace, tab, and pane customization needs a stable server-side process identity that is independent of browser layout. With tmux as the substrate, Relay can let users rearrange browser tabs, split panes, file viewers, and workspace surfaces while preserving the same underlying process for reconnect, restore, resize, copy-mode, and cleanup.
