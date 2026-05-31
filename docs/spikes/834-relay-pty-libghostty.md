# Spike: RelayPtySession + libghostty-vt non-tmux TUI parity

> **Status:** Spike complete — prototype path, tests, and smoke evidence
> **Scope:** Relay-owned PTY path without tmux, backed by a server-side terminal model
> **Date:** 2026-05-31
> **Issue:** [#834](https://github.com/donovan-yohan/relay-ide/issues/834)
> **Epic:** [#832](https://github.com/donovan-yohan/relay-ide/issues/832)

---

## tl;dr

**Recommendation: go, but keep tmux as compatibility until durability/control gaps close.**

`RelayPtySession` can become the next candidate default behind a feature flag. The spike proves that Relay can spawn a command directly with `node-pty`, feed PTY bytes into `libghostty-vt`, read modeled screen text/JSON/cells/cursor/alt-screen state without `tmux capture-pane`, send typed input bytes without `tmux send-keys`, track idle/activity from PTY timing, and resize both the PTY and terminal model.

Do **not** delete the tmux runtime yet. The prototype does not solve durable reattach after Relay process restart, tmux copy-mode/mobile selection parity, full DEC/private mode reporting, tmux session naming/operator recovery, or persistent process ownership. Those are the remaining tmux assumptions.

---

## Prototype files

- `server/terminal-model-backend.ts`
  - `TerminalModelBackend` interface.
  - `LibghosttyTerminalModelBackend` implementation using `@coder/libghostty-vt-node`.
  - screen text/json snapshots, cursor, title tracking from OSC `0/2`, alt-screen mode, cells, resize, and typed input encoding.
- `server/relay-pty-session.ts`
  - `RelayPtySession` owner that directly spawns `command + args` under `node-pty`, not tmux.
  - feeds output into the terminal model.
  - sends typed text/keys (`Enter`, `Escape`, `Tab`, arrows, `Ctrl-C`) as terminal bytes.
  - exposes snapshot timing (`startedAt`, `lastActivityAt`, `lastOutputAt`, `lastInputAt`, `lastResizeAt`, `idleMs`).
  - injects Relay identity env (`RELAY_IDE_SESSION_ID`, `RELAY_IDE_SESSION_RUNTIME`, `RELAY_IDE_CLI_PATH`, optional work context/task refs).
- `test/relay-pty-session.test.ts`
  - unit coverage for libghostty snapshots, title tracking, alt-screen, input encoding, direct non-tmux spawn, resize, timing, and env injection.

The existing production `sessions.ts` / `pty-handler.ts` path is untouched. This is deliberate: #834 is a deletion-gate spike, not a runtime migration hidden in a research PR.

---

## libghostty-vt binding result

Primary binding tested: `@coder/libghostty-vt-node@0.1.0-beta.1`.

Local install/import smoke:

```bash
npm install @coder/libghostty-vt-node@0.1.0-beta.1
node --input-type=module -e "import('@coder/libghostty-vt-node').then(m=>{ const t=m.createTerminal({cols:80,rows:24,scrollbackLimit:100}); t.feed('hello\\n'); console.log(t.getVisibleText()); })"
```

Result: import worked on devbox Linux x64 and rendered `hello`.

Runtime metadata from the prototype smoke:

```json
{
  "napiVersion": 10,
  "ghosttyVersion": "0.1.0-dev",
  "packageVersion": "0.1.0-beta.1",
  "platform": "linux",
  "arch": "x64"
}
```

Binding/build notes:

- The npm tarball includes prebuilds for Linux x64, Linux arm64, and macOS arm64.
- Windows is unsupported by the package today.
- The package install script does not build native code automatically; local native rebuild is explicit via `npm run build:libghostty` then `npm run build:native` inside the package.
- Native build requires fetching a pinned Ghostty commit and building static `libghostty-vt`; that adds Zig/Ghostty C API/platform risk if a prebuild is missing.
- The exposed beta API gives visible text, structured visible lines/cells, cursor, resize, and `isAltScreen`; it does not expose every private terminal mode Relay may eventually want. The prototype therefore reports unavailable mode booleans as `null` and lists them in `unsupported`.

No fallback was needed for the implemented prototype because the libghostty binding worked locally. If future CI/platforms reject the native addon, `@xterm/headless` is the named fallback to validate the same interface before deciding whether to keep the abstraction.

---

## Smoke evidence

### Provider-like CLI smoke: Codex auth TUI

Command: `codex` under `RelayPtySession`, dimensions `100x30`, resized to `120x32`.

Important caveat: standalone `codex` in this process opened its sign-in picker instead of an authenticated agent session. Hermes has OpenAI Codex auth in the profile, but the external Codex CLI did not see usable CLI auth here. So this is evidence for a real provider CLI interactive TUI, not evidence that a paid Codex coding session ran. annoying, but honest.

Evidence artifact: `/tmp/relay-pty-codex-smoke.json`.

Observed:

- spawned command was `codex` directly, not tmux.
- visible modeled screen text included `Welcome to Codex, OpenAI's command-line coding agent`.
- text/key input was sent through `RelayPtySession`: text, `Tab`, arrows, `Escape`, `Ctrl-C`.
- selection moved from option 1 to option 3 after typed key input.
- resize was applied and timing updated.
- modeled cell sample included styled `Codex` cells with `bold: true`.
- `altScreen` was `false`; Codex used cursor-addressed full-screen rendering without DEC alt-screen in this auth picker.

Sample modeled text after input:

```text
Welcome to Codex, OpenAI's command-line coding agent

Sign in with ChatGPT to use Codex as part of your paid plan
or connect an API key for usage-based billing

1. Sign in with ChatGPT
   Usage included with Plus, Pro, Business, and Enterprise plans

2. Sign in with Device Code
   Sign in from another device with a one-time code

> 3. Provide your own API key
   Pay for what you use

Press enter to continue
```

### Alternate-screen smoke: Vim

Command: `vim -Nu NONE -n /tmp/relay-pty-vim-smoke.txt` under `RelayPtySession`, dimensions `90x24`, resized to `100x28`.

Evidence artifact: `/tmp/relay-pty-vim-smoke.json`.

Observed:

- `initial.terminal.modes.altScreen === true`.
- after `:q!` + `Enter`, `after.terminal.modes.altScreen === false`.
- visible modeled screen text included file contents and Vim status text.
- typed input exercised text, `Escape`, arrows, resize, and `Enter` without tmux.

Sample initial modeled text:

```text
relay pty vim smoke
~
~
~
"/tmp/relay-pty-vim-smoke.txt" 1L, 20B
```

---

## Input mapping

`TerminalInput` is intentionally small and typed:

| Action | Bytes |
| --- | --- |
| text | UTF-8 text bytes |
| Enter | `\r` |
| Escape | `\x1b` |
| Tab | `\t` |
| ArrowUp | `\x1b[A` |
| ArrowDown | `\x1b[B` |
| ArrowRight | `\x1b[C` |
| ArrowLeft | `\x1b[D` |
| Ctrl-C | `\x03` |

This is not a replacement for raw debug writes. It is the product/control vocabulary Relay can audit and route without exposing `tmux send-keys` or terminal-substrate-specific names.

---

## Remaining tmux assumptions

Keep tmux compatibility until these are resolved:

1. **Durability / reattach:** tmux currently keeps the process alive when browser/server attachments churn. `RelayPtySession` owns the child directly, so a Relay process restart kills or orphans it unless a runtime daemon/process-owner layer lands.
2. **Operator recovery:** tmux session names are human-discoverable and killable with standard tools. The prototype needs equivalent process registry/diagnostics.
3. **Mobile selection/copy-mode:** current mobile copy-mode depends on tmux behavior. A non-tmux path needs a xterm/model-backed selection/copy story.
4. **Mode coverage:** libghostty beta exposes `isAltScreen`, cursor, cells, and text. Application cursor mode, mouse tracking, bracketed paste, and other private modes are not exposed through the Node binding yet.
5. **Control/audit integration:** typed input exists in the prototype, but production supervisor/control-state/audit paths still need policy wiring.
6. **Session persistence:** scrollback/model state is in memory only; it needs serialization if Relay wants hot restart or daemon migration parity.
7. **Platform support:** Linux x64 is green here. macOS arm64 likely works via prebuild. Windows and missing-prebuild platforms need fallback or native build proof.

---

## Next slice

Feature-flag the prototype as an internal/local-only runtime candidate, wire it behind a narrow create option, and add a real runtime-owner decision before replacing tmux defaults. The next PR should keep the invariant explicit: `tmux` remains the stable production substrate until non-tmux sessions can survive the same lifecycle surfaces.
