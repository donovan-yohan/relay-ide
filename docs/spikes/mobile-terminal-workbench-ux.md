# Mobile terminal/workbench UX spike (#827)

Status: research spike, proposed direction only.
Checked: 2026-05-30 UTC.

## Decision

Relay should make mobile an agent conversation and workbench control surface first, with raw PTY attach as an escape hatch. The first dogfood slice should let Kyle open Relay on a phone, see active Ebi/Hermes work that needs attention, continue or start a bounded agent conversation under a `WorkContext`, and use a small set of terminal controls only when the conversation needs an exact shell key.

Do not try to make a phone-sized generic SSH SaaS. The durable product value is Relay's hub/node/workbench model: task/session identity, agent attention, approvals, artifacts, notifications, safe attach, and audit. The raw terminal still matters, but it should be one view inside a richer mobile work card, not the default landing surface.

## Current Relay baseline

Relevant local code/docs inspected on branch `docs/827-mobile-terminal-workbench-ux` at Relay base `2dcf626`:

- `docs/WORKBENCH_BOUNDARY.md` already defines mobile as status/control/artifact/approval oriented, not a full phone IDE.
- `docs/WEB_CHAT.md` describes the structured web chat protocol and `ChatView`/`Composer`/approval components.
- `frontend/src/components/MobileInput.tsx` already captures mobile IME input through a hidden in-viewport input, handles composition, beforeinput ranges, autocorrect replacement, Gboard cursor-0 cases, Enter/Escape/Tab/ArrowUp/ArrowDown, and debug logs.
- `frontend/src/components/MobileInput.css` documents the important Android/Gboard constraint: keep the input in viewport at 1x1px; offscreen or clipped inputs break cursor tracking.
- `frontend/src/components/Terminal.tsx` already contains mobile-specific touch scroll, long-press selection/copy mode, a 44px scrollbar thumb, alternate-buffer scroll translation, zoom controls, and paused inactive rendering with a 256KB ring buffer.
- `package.json` uses Relay's xterm fork: `@xterm/xterm` from `github:donovan-yohan/xterm.js#v6.0.0-relay.1`.
- `test/fixtures/mobile-input/` already has fixtures for paste, iOS replacement text, Gboard autocorrect, Gboard delete-word swipe, normal typing, and unknown input fallbacks.

Implication: the next mobile slice should not start by swapping terminal libraries. Keep xterm.js plus Relay's existing mobile input layer, then add a workbench-first mobile shell around it.

## Prior-art matrix

| Source                | Evidence inspected                                                                                                                                                                                                                              | Useful patterns for Relay                                                                                                                                                                                                                                                                                                                                  | Do not copy                                                                                                                                                                                                                                            |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| cmux                  | `manaflow-ai/cmux` `4afeef69dea51621b86288944b6728a0227d7ee7`, `README.md`; GitHub: <https://github.com/manaflow-ai/cmux/blob/4afeef69dea51621b86288944b6728a0227d7ee7/README.md>                                                               | Vertical session/workspace list; tab rows carrying branch, PR, cwd, port, and latest notification text; blue attention rings for panes needing operator input; notification panel and jump-to-latest-unread; scriptable command palette/custom commands; in-app browser pane with scriptable agent-browser API; session restore with explicit limitations. | cmux is native macOS/Ghostty, not web/mobile. Treat the README as product evidence, not proof of all internals. Do not copy the macOS shortcut model or assume side-by-side panes fit phones.                                                          |
| xterm.js mobile issue | `xtermjs/xterm.js` `43e8365f0e20402ce9744e3770a97dd7a78ef877`; issue #5377 <https://github.com/xtermjs/xterm.js/issues/5377>; `src/browser/CoreBrowserTerminal.ts`                                                                              | Upstream maintainers explicitly call mobile/touch support a blind spot. Treat touch selection, gesture scrolling, virtual keyboard integration, and special-key input as app-layer responsibilities. DOM renderer/screenReaderMode may be required for some touch work.                                                                                    | Do not expect upstream xterm.js to solve mobile UX soon. Do not rely on mouse-event translation for touch. Do not make WebGL/canvas selection the only path.                                                                                           |
| swell.sh              | `wcchoi/swell.sh` `1b86f1c36c8b195b21c161ee42fe0b9ad672b724`, `README.md`, `static/app.js`; GitHub: <https://github.com/wcchoi/swell.sh/blob/1b86f1c36c8b195b21c161ee42fe0b9ad672b724/README.md>                                                | Mobile terminal should have suggestion chips, not just a text field. Bash/path completion and swipe/gesture input show how much friction drops when mobile input predicts commands. It also documents realistic limitations clearly.                                                                                                                       | Do not adopt the package. It is old, AGPL, bash-only, Linux/ptrace-dependent, single-session, security-sensitive, and its autocomplete model is tied to inspecting shell process state. Copy the interaction ideas only.                               |
| WeTTY virtual keys    | `butlerx/wetty` `da9844015bb10ce2afcaf688669e2d979c6583fb`; issue #557 <https://github.com/butlerx/wetty/issues/557>; merged PR #560 <https://github.com/butlerx/wetty/pull/560>; `src/client/wetty/term.ts`, `src/server/socketServer/html.ts` | A collapsible on-screen function layer with Esc, Tab, Ctrl, and arrows is the minimum viable raw-terminal accessory. Ctrl as a one-shot/toggle state is understandable on touch.                                                                                                                                                                           | WeTTY's implementation uses globals and inline HTML callbacks; use it as a behavior reference, not a component dependency. The Ctrl workaround that sends backspace after composed characters is brittle; Relay's existing input pipeline is stronger. |
| ttyd mobile limits    | `tsl0922/ttyd` `647d55ad865f5ad85ad89ba5e1b28d9b6ac8fd55`; issue #191 <https://github.com/tsl0922/ttyd/issues/191>; open PR #1493 <https://github.com/tsl0922/ttyd/pull/1493>; `html/src/components/terminal/xterm/index.ts`                    | FitAddon/window resize is necessary but not sufficient. Users hit overflow/zoom problems under mobile browser keyboards. The open toolbar PR confirms that even mature web terminal servers still need app-level mobile keybars.                                                                                                                           | Do not use ttyd as the mobile surface. Current source is still mostly generic xterm + fit + resize; mobile toolbar is not merged as of inspection.                                                                                                     |
| Blink Shell           | Docs: <https://docs.blink.sh/basics/customize>, <https://docs.blink.sh/advanced/advanced-mosh>                                                                                                                                                  | Mobile terminal apps treat keyboard customization as first-class: remappable modifiers, on-screen Ctrl/Esc/Alt, custom presses, and Mosh/tmux for network resilience.                                                                                                                                                                                      | Native iOS affordances do not map 1:1 to browser PWAs. Mosh is an SSH transport pattern, not Relay's hub/node session model.                                                                                                                           |
| Termius               | Docs: <https://docs.termius.com/terminal/autocomplete-and-shell-integration>, <https://docs.termius.com/terminal/snippets>; blog: <https://termius.com/blog/8-tips-for-using-ai-agents-on-mobile-in-termius>                                    | Autocomplete combines history, paths, snippets, command arguments, and identity prompts. Mobile side panels/snippets/startup commands make repeated agent workflows one tap. Blog guidance reinforces tmux/Mosh/session persistence, file upload, port forwarding, shortcut bar customization, voice dictation, and gesture arrows.                        | Termius stores SSH identities/vaults and opens extra SSH exec channels. Relay should not become a credentials vault or scrape shells for autocomplete without explicit grants.                                                                         |
| Termux                | Termux wiki was bot-gated during extraction, so I used Mobile Coding Hub's Termux extra-keys doc and Termux issue #12: <https://mobile-coding-hub.github.io/termux/customisation/extra_keys/>, <https://github.com/termux/termux-app/issues/12> | Extra key rows are configurable because CLI-essential keys are absent on mobile keyboards. Common defaults: Esc, Tab, Ctrl, Alt, arrows, Home/End, PgUp/PgDn. Hardware volume-key shortcuts show users accept alternate modifier channels when discoverable.                                                                                               | Do not make Relay require external keyboard apps or device hardware buttons. Avoid overfitting to Android-only Termux mechanics.                                                                                                                       |

## Product patterns worth adapting from cmux

### 1. Mobile work/session list as the home screen

Phone landing should be a dense list of active `WorkContext` cards, not a terminal canvas. Each row should answer the scanning user's questions in this order:

1. What needs me? `waiting for input`, `approval requested`, `blocked`, `failed`, `running`, `idle`, `stale/offline`.
2. What work is this? GitHub issue/PR/Kanban ref, repo/project if available, branch/worktree/cwd, node.
3. Who is acting? Ebi/Hermes/Claude/Codex/OpenCode, control mode, last actor.
4. What happened last? Latest bounded status/output line, artifact link, or approval prompt summary.
5. What can I safely do? Continue conversation, approve/deny, send small input, open artifact, attach terminal, pause/kill/retry if granted.

Use cmux's vertical tab metadata idea, but map it to Relay nouns: `WorkContext` row -> `Session`/`Tab` chips -> node/cwd/kind metadata. Repo badges are optional decoration only when the tab is actually repo-bound.

### 2. Agent attention model

Mobile should have explicit attention states instead of generic unread badges:

- `needs input`: agent is waiting for a user message or terminal prompt.
- `approval`: permission/action approval pending.
- `blocked`: task cannot proceed without operator decision.
- `failed`: crashed/timed out/reconnect failed.
- `running`: active work with no operator action.
- `stale/offline`: node/session unavailable; controls disabled.
- `done`: completed with artifact/ref.

Visual treatment should follow `DESIGN.md`: pure black, monospace, outline/tint only, status dots or left border accents, no rounded SaaS cards. On mobile, each status target must be at least 44px high.

### 3. Notification center + jump-to-attention

Copy cmux's notification panel and jump-to-latest-unread concept, but scope notifications to Relay events:

- approval requested;
- task blocked;
- agent input requested;
- PR/artifact produced;
- session failed/disconnected;
- node changed online/stale/offline;
- latest run completed.

Mobile home needs one persistent `attention` filter and one `jump next` action. Browser push can notify, but the in-app source of truth should be a sorted attention queue with freshness timestamps and WorkContext links.

### 4. Browser panes become mobile preview/artifact panes

cmux's browser pane is a power pattern on desktop. On phones it should become a full-screen switchable preview/artifact tab:

- open dev server preview URL or artifact screenshot/log from the work card;
- preserve back stack and last preview URL per WorkContext;
- allow copy URL / refresh / open external browser;
- never hide the conversation composer behind a side-by-side split on narrow widths.

### 5. Command palette as mobile action sheet

Desktop can keep a command palette. Mobile should expose the same action registry as a bottom sheet/action sheet with command search and safe defaults:

- `continue in Ebi` / `continue in Hermes`;
- `send short input`;
- `approve` / `deny` pending request;
- `attach terminal`;
- `open PR` / `open logs` / `open preview`;
- `copy summary`;
- `pause` / `kill` / `retry` only when grants allow.

Commands should be WorkContext-aware and state-gated. Disabled actions must explain the missing grant, offline node, or non-terminal session.

## Mobile terminal interaction recommendations

### Accessory key bar

Add a Relay mobile terminal accessory layer only when raw terminal attach is active. It should be compact, configurable later, and initially include:

- row 1: `esc`, `tab`, `ctrl`, `↑`, `↓`, `←`, `→`;
- row 2 or overflow: `home`, `end`, `pgup`, `pgdn`, `paste`, `copy`, `font -/+`;
- one-shot/toggle modifier states for `ctrl` and later `alt`/`meta`;
- visible active state for modifier buttons;
- 44px touch targets, no filled buttons, no emoji, square TUI styling.

This should call Relay's existing PTY send path (`sendPtyData`) rather than trying to synthesize browser key events.

### Suggestions/chips

Do not build shell introspection in v1. Start with safe, Relay-owned suggestion chips:

- previous prompts/messages in this WorkContext;
- common agent actions: `status`, `continue`, `summarize`, `run tests`, `show blockers`, `open PR`;
- slash/action registry entries from the chat surface;
- snippets explicitly saved by the operator or repo-owned workflow config;
- current artifact refs: PR URL, issue URL, logs, screenshot paths.

Later, consider shell/path completion only behind node capability grants. Termius and swell.sh prove suggestions are useful; they also prove shell scraping and extra channels create security and compatibility risk.

### Gesture/touch/selection

Keep and harden the existing custom touch layer in `Terminal.tsx`:

- drag scrollback in normal buffer;
- translate alternate-buffer drags into wheel-like terminal sequences;
- long-press enters selection/copy mode;
- expose an explicit `copy mode` exit affordance;
- use 44px scrollbar thumb minimum;
- prefer DOM/text selection when available; canvas/WebGL should not be the only copy path.

Do not attempt full mobile text selection handles in the first dogfood slice. The first slice only needs reliable scrollback, long-press-copy, and a visible escape from copy mode.

### Virtual keyboard and viewport resize

The mobile composer/terminal must treat `visualViewport` changes as first-class:

- bottom composer/action bar sticks above the virtual keyboard using `visualViewport.height`/`offsetTop` where available;
- terminal and chat timeline fit on viewport change, not only `window.resize`;
- keep focused mobile input in viewport; do not move it offscreen or clip it to zero visible area, because Gboard cursor tracking breaks;
- avoid iOS input zoom by keeping focused input font size at least 16px;
- when keyboard opens, preserve the latest conversation/terminal line above the composer;
- use `env(safe-area-inset-bottom)` for iPhone home indicator.

### Scrollback

Mobile should default to conversation timeline first, terminal scrollback second:

- show latest bounded terminal output/status in WorkContext row;
- raw PTY attach keeps current 256KB inactive buffer behavior;
- add `latest`, `copy visible`, `copy last 200 lines`, and `open full scrollback` actions later;
- never store or expose unbounded raw transcript/log history in the mobile work list.

## Recommended first dogfood slice

Goal: Kyle can initiate or continue Ebi/Hermes conversations in Relay mobile without Discord for the common “check status / approve / nudge / continue” loop.

### Scope

1. Mobile `active work` view
   - One-column WorkContext/session list.
   - Sorted by attention state first, then most recently updated.
   - Rows show task/PR/issue ref, repo/project, node, session kind, actor, latest bounded status, and attention state.

2. Mobile conversation view
   - Open a structured Ebi/Hermes web chat session under the selected WorkContext.
   - Timeline shows turns, tool cards collapsed by default, approval cards, artifact refs, and errors.
   - Composer supports multi-line paste/dictation-friendly text, send, interrupt if supported, and “attach terminal” secondary action.

3. Attention and notifications
   - In-app attention queue with filter chips: `needs me`, `running`, `done`, `stale`.
   - Browser push only for high-signal states: input requested, approval requested, blocked, failed, completed with artifact.
   - Tapping a push opens the exact WorkContext/session if auth is valid.

4. Raw terminal escape hatch
   - Existing `Terminal` mobile touch scroll/selection stays available.
   - Add minimal accessory key bar for Esc/Tab/Ctrl/arrows.
   - Composer/chat remains the default for agent conversations; terminal attach is one tap away.

5. Preview/artifacts
   - WorkContext detail shows PR/issue/log/screenshot/preview links as rows.
   - Dev preview opens full-screen in-app or external browser; no side-by-side phone split in v1.

### Non-goals for this slice

- No generic public SSH hosting.
- No public unauthenticated terminal URLs.
- No Relay-owned credentials vault.
- No raw Hermes profile DB sync.
- No raw unbounded transcript/scrollback export to mobile work cards.
- No broad file editing UX.
- No full shell autocomplete from process inspection.
- No browser-pane automation UI on mobile beyond opening preview/artifact links.
- No full #444 IA migration or #428 write-capable File RPC hidden inside this slice.

### Security constraints

- Relay remains the hub/node/workbench control plane. Nodes own process execution; Relay routes and audits bounded control.
- Every destructive action (`kill`, `retry`, `pause`, write/execute, approve) requires an explicit `CapabilityGrant` and emits an `AuditEvent`.
- Mobile clients see only bounded latest output, summaries, artifacts, and state by default.
- Raw PTY attach requires a session-specific grant and should visibly show node, cwd, session kind, and control mode.
- Stale/offline nodes must disable live controls rather than silently routing to a different node/session.
- Suggestions/chips must be Relay-owned or explicitly granted; no hidden shell scraping or identity/password prompts in v1.

## UI shape

### Mobile active work row

```
[!] approval          #827 mobile terminal ux       relay-ide / devbox
    Hermes waiting: approve posting spike doc PR
    ebi · web-chat · docs/827-mobile-terminal... · 2m ago
    [continue] [approve] [artifact]
```

Hierarchy:

1. status + work title;
2. latest bounded status/attention text;
3. metadata line (actor, session kind, cwd/node, freshness);
4. two or three state-valid actions.

Use row dividers and a fixed metadata grid. Avoid generic card blobs. Long text should marquee or truncate with accessible title; do not expand every row by default.

### Mobile conversation view

Top bar:

- back to active work;
- compact WorkContext title;
- status dot/text;
- action sheet trigger.

Timeline:

- latest turn at bottom;
- tool cards collapsed with one-line status;
- approval cards full-width with clear `allow`/`deny`/`details` buttons;
- artifact refs as rows with type, timestamp, and source.

Composer:

- bottom sticky above keyboard;
- `send`, `attach terminal`, and action sheet;
- suggestion chips above the input when available;
- supports paste/dictation as one-shot text, not per-character terminal stream unless raw terminal is active.

### Raw terminal attach

- Full-screen terminal, not split, on phones.
- Top metadata bar: node, cwd, session, control mode, stale/online.
- Bottom accessory key bar above OS keyboard.
- Long-press copy mode and visible `exit copy` action.
- `return to chat` sticky action so users do not get trapped in raw PTY land.

## Package/library recommendation

Use Relay's current xterm.js fork plus custom app-layer mobile UX.

- Keep `@xterm/xterm` for terminal rendering; Relay already carries mobile-specific input/touch work.
- Keep `@xterm/addon-fit`, but add/verify `visualViewport`-aware refit where keyboard resize does not fire standard resize events.
- Do not import WeTTY/ttyd/swell.sh components. Their value is design evidence, not dependency fit.
- Consider extracting a small internal `MobileTerminalAccessoryBar` React component that calls `sendPtyData` and can be tested without xterm.
- Put suggestion chips behind Relay's chat/action registry first; defer shell-aware completion to a separate security/product issue.

## QA acceptance scenarios

Minimum mobile QA matrix for first dogfood slice:

1. iPhone Safari, 390x844-ish viewport
   - open Relay mobile;
   - see active WorkContext list;
   - tap `needs me` item;
   - keyboard opens and composer remains visible above keyboard;
   - send a short Ebi/Hermes message;
   - open and close raw terminal attach;
   - Esc/Tab/Ctrl/arrows accessory buttons send expected PTY bytes.

2. Android Chrome/Gboard, 412x915-ish viewport
   - type normal text, autocorrected text, delete-word swipe, and paste into composer/terminal input;
   - verify no cursor-0 prepend regression;
   - rotate or keyboard-open/close and verify terminal/chat refit;
   - touch-scroll scrollback and alternate-buffer app; long-press copy works or exposes copy-mode fallback.

3. PWA/home-screen install if supported
   - safe-area bottom padding works;
   - no browser toolbar assumptions;
   - push tap opens the correct WorkContext/session.

4. Stale/offline node
   - row remains readable with last-seen timestamp;
   - live controls disabled with explanation;
   - artifacts and latest bounded summary remain accessible.

5. Security/action gating
   - approval prompt shows exact action/grant scope;
   - destructive actions require explicit confirmation;
   - audit event is emitted for approve/deny/pause/kill/retry;
   - no raw env/token/transcript fields appear in mobile cards.

6. Accessibility
   - all touch targets at least 44px;
   - status is not color-only;
   - buttons have labels, not icon-only glyphs;
   - focus remains in composer after send unless navigating;
   - reduced motion disables non-essential scanline/cipher effects.

## Implementation slices to create after this spike

1. `koi-product`: refine acceptance for mobile active-work + Ebi/Hermes dogfood conversation, including exact attention states and notification thresholds.
2. `hotate-design` or `ika-frontend`: produce a mobile mock/spec for active work list, conversation view, and raw terminal accessory bar against `DESIGN.md` tokens.
3. `ika-frontend`: implement `MobileTerminalAccessoryBar` using existing `sendPtyData`, with tests for emitted byte sequences.
4. `ika-frontend` + `kani-backend`: expose mobile WorkContext/session summaries from existing session/task/artifact data without raw transcript storage.
5. `kame-qa`: run iPhone/Android browser scenarios using the existing mobile-input fixture discipline.

## Verdict

PARTIAL / product-validated. Prior art strongly supports the direction: mobile terminals need custom keybars, custom touch/selection, viewport handling, and suggestions; cmux shows the more important product layer is session metadata and attention routing. Relay already has unusually strong terminal-mobile primitives, so the first valuable slice should be workbench-first mobile conversation/attention, not another attempt to make xterm.js behave like a native terminal on its own.
