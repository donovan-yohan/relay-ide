# mobile terminal/workbench UX spike

Date: 2026-05-30
Issue: https://github.com/donovan-yohan/relay-ide/issues/827
Status: spike recommendation, not shipped behavior

## summary

Relay should make mobile a conversation/control surface first and a raw PTY second. The first dogfood slice should let Kyle open Relay on a phone, see Ebi/Hermes work needing attention, start or resume one bounded Hermes conversation under a `WorkContext`, send short messages/approvals, and fall back to a mobile-hardened terminal only when the structured chat surface is insufficient.

Do not build a generic browser SSH product. Keep Relay as the hub/node/workbench control plane: native CLIs, tmux, Hermes, GitHub, and Kanban keep owning execution and durable records; Relay owns work context, routing, inspection, bounded input, artifacts, and audit.

Design completeness: 8/10 for a first implementation plan. To reach 10/10, the implementation lane should add visual mocks for the mobile inbox/detail/terminal fallback, confirm the current Hermes web-chat adapter path, and run device proof on at least one iPhone Safari and one Android Chrome viewport with the virtual keyboard open.

## evidence hygiene

This spike inspected source where available and cites pinned repository SHAs. README-only findings are labeled as README evidence. GitHub issue findings are issue evidence, not proof of current package internals.

| project/source | pinned evidence | mobile/workbench finding | Relay read |
|---|---|---|---|
| cmux | `manaflow-ai/cmux` at `4afeef69dea51621b86288944b6728a0227d7ee7`; README features at `README.md` lines 28-90 and rationale at lines 119-129 | cmux is a native macOS terminal/workbench, not a web/mobile component. README evidence shows vertical/horizontal tabs, notification rings/panel, in-app browser panes, sidebar metadata for branch/PR/cwd/ports/latest notification, Claude teams splits, custom commands, and CLI/socket automation. | Copy the product model, not the stack: mobile needs an attention-first session list with actionable metadata, not just a list of PTYs. |
| cmux session index | same SHA; `Sources/SessionIndexModels.swift` lines 255-313 | source models sessions by agent, native session id, title, cwd, git branch, PR link, modified time, file URL, agent-specific resume data, and a cwd-guarded resume command. | Relay session rows should be `WorkContext`/`Session` cards with node, actor, cwd, repo/branch/PR when available, and safe resume/attach affordances. |
| cmux command palette | same SHA; `Sources/CommandPalette/CommandPaletteSearch.swift` lines 3-62 | command-palette search indexes directories, branches, ports, and descriptions in addition to names. | Relay mobile command palette should search task/repo/branch/cwd/node/actor/status, not just visible labels. |
| cmux browser panes | same SHA; README lines 51-55 and 127-129 | README evidence describes split browser panes and a scriptable browser API for agents. | On phone, do not split terminal+browser side by side. Open browser previews/artifacts as a full-screen sheet tied to the active `WorkContext`. |
| xterm.js | `xtermjs/xterm.js` at `43e8365f0e20402ce9744e3770a97dd7a78ef877`; README lines 3-18, 96-118 | xterm.js remains the right browser terminal primitive: full terminal emulation, mouse/curses apps, IME, addons, fit, web links, search, serialize/headless. It is not a terminal app or session manager. | Keep xterm.js for raw attach, but wrap it in Relay-specific mobile input, viewport, scrollback, and attention UI. |
| xterm.js mobile issue | https://github.com/xtermjs/xterm.js/issues/5377 | open issue states mobile touch support is weak: touch gestures, pinch/zoom, selection, context menu, and virtual keyboard/accessory integration are problematic. | Do not assume upstream xterm.js solves mobile UX. Relay must own mobile layer behavior and tests. |
| xterm.js older mobile issues | https://github.com/xtermjs/xterm.js/issues/1101, https://github.com/xtermjs/xterm.js/issues/945, https://github.com/xtermjs/xterm.js/issues/4279 | historical issues show iOS keyboard event weirdness, inability to type on mobile, and Android rendering failures in xterm-based web terminals. | Treat mobile terminal as fragile; QA must include real browser/device or equivalent remote device testing, not only desktop responsive mode. |
| Swell.sh | `wcchoi/swell.sh` at `1b86f1c36c8b195b21c161ee42fe0b9ad672b724`; README lines 1-62, 111-137, 213-220 | README describes a mobile web terminal with autocomplete suggestions, gesture typing keyboard, Bash/tmux/Termux support, and explicit security/limitation notes. It is old, Bash-oriented, single-session, US-QWERTY, and uses ptrace-style process inspection. | Copy suggestion-chip and gesture-keyboard ideas; do not copy its process model, security stance, or Bash-only autocomplete assumptions. |
| WeTTY | `butlerx/wetty` at `da9844015bb10ce2afcaf688669e2d979c6583fb`; README lines 12-20 and 118-121 | WeTTY is an xterm.js-based terminal-over-HTTP/HTTPS project. | Useful as implementation reference for xterm wrapper patterns, but not as Relay's product layer. |
| WeTTY virtual keys | issue https://github.com/butlerx/wetty/issues/557, PR https://github.com/butlerx/wetty/pull/560, source at same SHA `src/server/socketServer/html.ts` lines 25-41 and `src/client/wetty/term.ts` lines 51-249 | issue requested optional Ctrl/Tab/Esc/arrows for smartphone keyboards; merged PR added onscreen ESC/TAB/Ctrl/arrows. Source shows simple escape-sequence injection and a Ctrl toggle. | Relay needs an accessory bar, but it should be context-aware and safer than a static row: default to Esc, Tab, Ctrl, arrows, interrupt, paste, submit, palette; expose advanced keys behind a drawer. |
| ttyd | `tsl0922/ttyd` at `647d55ad865f5ad85ad89ba5e1b28d9b6ac8fd55`; README lines 8-23 and 50-88 | ttyd is a simple command-line tool for sharing a terminal over the web with SSL/auth/options. | Great server-side inspiration for small terminal sharing, not enough for Relay's mobile workbench. |
| ttyd mobile limitation | https://github.com/tsl0922/ttyd/issues/191 | issue reports Android Chrome mobile layout/scaling overflow when keyboard/zoom changes; closed without making mobile the core product direction. | Viewport resize under virtual keyboard is a first-class Relay acceptance criterion. |
| Blink Shell | https://docs.blink.sh/ and https://docs.blink.sh/advanced/advanced-mosh | docs describe iOS gestures, Smart Keys visible only for onscreen keyboard, chained modifiers, tab/shell gestures, selection drag, context bar, SSH/Mosh, and mosh resilience on changing networks. | Relay should borrow adaptive key rows, gesture discoverability, and resilience expectations, but Relay should not become SSH/mosh itself. |
| Termius | https://termius.com/blog/new-touch-terminal-on-ios, https://docs.termius.com/terminal/autocomplete-and-shell-integration, https://docs.termius.com/terminal/snippets | docs/blog describe touch-based arrow key emulation, extra keyboard, command/snippet/history/path autocomplete, snippets, shell integration, and natural-language command generation. | Relay should use suggestion chips for safe actions and snippets; AI command generation is later, not v1. |
| Termux | `termux/termux-tools` `termux.properties` page; Mobile Coding Hub secondary doc for behavior | Termux supports configurable extra key rows, popup macros, terminal scrollback rows, fullscreen workaround, soft-keyboard toggle, and external-app command execution disabled by default for security. | Relay's key bar should be configurable per user/session later, but v1 should ship a minimal fixed safe set. Security defaults must remain conservative. |
| Relay current terminal | Relay `frontend/src/components/Terminal.tsx` at base `2dcf626`; lines 10-24, 82-113, 155-220, 241-481 | Relay already uses xterm.js, Fit/WebLinks/WebGPU/WebGL addons, PTY websocket routing, mobile detection, custom scrollbar with 44px mobile thumb, touch scroll, long-press selection/copy mode, and tmux alternate-buffer scroll handling. | The raw terminal has a useful start, but it is not enough. Build the mobile conversation layer above it and use the existing terminal improvements as fallback substrate. |
| Relay workbench boundary | `docs/WORKBENCH_BOUNDARY.md` lines 1-18, 19-29, 68-118, 122-145 | current docs already say mobile is first-class for status/control/artifacts/approval/small input, not a full phone IDE; Relay is control plane, not runtime/task tracker/source host/memory. | This spike should reinforce, not replace, that boundary. |
| Relay web chat | `docs/WEB_CHAT.md` lines 1-18, 20-87, 123-179 | existing docs define a structured web-chat protocol with chat events, adapters, message send, interrupt, approvals, input responses, and chat components. | The first mobile conversation should use structured chat events where available; PTY input is fallback and emergency control. |

## what to adapt from cmux

1. Session list as the primary workbench surface.
   - Mobile first screen should be an Active Work inbox, not a full desktop layout squeezed into 390px.
   - Sort by attention state: waiting for Kyle, running/streaming, failed/blocked, recently updated, stale/offline.
   - Each row should expose: WorkContext title/task ref, agent/runtime, node, cwd/repo/branch/PR if known, control mode, last meaningful event, freshness, and artifact count.

2. Metadata density with restraint.
   - cmux proves branch/PR/cwd/ports/latest notification are the right class of sidebar metadata.
   - Relay mapping: task ref, repo/project, node, cwd, actor, session state, PR/check/artifact summary, pending approval/input.
   - Do not show raw path/repo badges on free/non-git or remote tabs unless the binding is explicit.

3. Attention model.
   - Copy notification rings conceptually: persistent attention state belongs on both list rows and detail header.
   - Attention should be semantic, not just unread bytes: `needs input`, `approval requested`, `blocked`, `failed`, `node stale`, `artifact ready`, `destructive control armed`.
   - Notifications should jump to the needing-work item, not dump the user into the bottom of a terminal.

4. Browser panes as artifacts/previews.
   - Desktop can split browser next to terminal.
   - Phone should open browser/dev-server/PR/log/artifact as a sheet or full-screen route with a clear return affordance to the session.

5. Command palette.
   - Mobile palette should be a bottom sheet opened from the thumb zone.
   - Search should index action names and metadata: issue number, repo, branch, cwd, node, actor, port, status.
   - Initial actions: start Hermes conversation, continue selected conversation, send message, interrupt current turn, open terminal fallback, open PR/artifact, copy latest summary, pause/kill where allowed.

6. Agent attention over raw terminals.
   - cmux is valuable because it treats agent sessions as things that need attention, not anonymous shells.
   - Relay should go further: show structured Hermes/Ebi conversation state when possible, with PTY bytes hidden behind a fallback tab.

## mobile terminal patterns to adopt

### accessory key bar

V1 fixed bar:

- left cluster: `esc`, `tab`, `ctrl` toggle, arrow cluster
- center cluster: suggestion chips/actions from current context
- right cluster: `send`, `interrupt`, `paste`, `palette`

Rules:

- 44px minimum touch targets.
- Bar sticks above the virtual keyboard and respects safe-area insets.
- Modifier keys have visible latched state and auto-unlatch after the next key unless held by explicit long-press.
- Advanced keys (`fn`, `pgup`, `pgdn`, `home`, `end`, `alt`) live in a drawer, not the default strip.
- Do not rely on hover.

### autocomplete and suggestion chips

Use chips for safe, high-confidence actions rather than pretending mobile can type full shell commands comfortably.

Suggested v1 chips by context:

- Conversation idle: `summarize latest`, `continue`, `what needs me?`, `open terminal`.
- Approval pending: `allow once`, `deny`, `explain risk`, `open diff/artifact`.
- Terminal focused: recently used snippets, detected command completions only when reliable, `ctrl-c`, `tab`, `paste path`.
- WorkContext with PR: `open PR`, `copy PR link`, `show checks`, `ask Ebi status`.

Do not implement Swell-style Bash introspection in v1. It has security/process assumptions Relay should avoid.

### gestures, touch, and selection

- Single tap focuses composer or terminal depending on active mode.
- Horizontal swipe between sibling work surfaces only when it will not conflict with text selection or browser back.
- Long-press in terminal enters selection/copy mode; Relay already has long-press selection/copy scaffolding in `Terminal.tsx`.
- Scrollback is a separate interaction from shell input: normal-buffer swipe scrolls history; alternate-buffer swipe maps carefully to app scroll events.
- Provide an explicit copy-mode exit/escape visible on mobile.

### viewport resize and virtual keyboard

Acceptance rule: opening the virtual keyboard must never leave the prompt/composer hidden under the keyboard or trigger page zoom/sideways overflow.

Implementation notes:

- Use `visualViewport` resize/scroll events where available.
- Resize xterm with FitAddon after keyboard open/close settles; debounce but keep feedback under 400ms.
- Keep composer/accessory bar in the visual viewport, not layout viewport.
- Disable accidental input zoom by using >=16px form/composer text on iOS even if the surrounding terminal font is smaller.
- Recompute terminal rows after keyboard changes; preserve scrollback position unless user is at bottom.

### scrollback

- Show a mobile scrollbar/thumb with at least 44px hit target.
- Provide jump-to-bottom and jump-to-attention controls.
- Preserve bounded latest output/summary separately from raw scrollback so phone users can answer "what happened?" without scrubbing thousands of lines.
- Do not expose unbounded transcripts by default; respect Relay's redaction/audit boundary.

## recommended first dogfood slice

Goal: Kyle can initiate or continue Ebi/Hermes conversations through Relay mobile instead of Discord for the common "check work, answer prompt, continue task" loop.

### slice shape

1. Mobile Active Work route
   - Route can be `/mobile` or a responsive mode of the existing workbench.
   - It shows WorkContext/session cards sorted by attention.
   - It has one primary action: `new Hermes conversation`.

2. Conversation detail
   - Header: task/title, actor/runtime, node, cwd/repo if bound, control mode, freshness.
   - Body: structured chat timeline from web-chat events when available; otherwise a bounded terminal-output summary plus raw terminal fallback.
   - Composer: multi-line text area, send, interrupt, approval/input response controls.
   - Attachment/artifact strip: PR, issue, logs, screenshots, diagnostics when known.

3. Terminal fallback
   - Opens inside the same WorkContext detail, not as the default landing screen.
   - Includes accessory key bar, explicit copy mode, scrollback controls, and virtual-keyboard-safe resizing.
   - Warns when raw keystrokes will be sent to a live shell/agent session.

4. Notifications/attention
   - Browser notification or in-app badge for `needs input`, `approval requested`, `blocked/failed`, and `node stale`.
   - Tapping notification opens the WorkContext detail, focused on the pending prompt/action.

5. Capability and audit guardrails
   - Read/status/artifact viewing is lower risk.
   - Sending text, approving tool calls, interrupting, pause/kill/retry require visible capability state and audit events.
   - Destructive actions require confirmation and cannot be hidden behind suggestion chips.

### non-goals for the first slice

- No generic public SSH SaaS.
- No public unauthenticated terminal URL sharing.
- No broad file editing or full phone IDE.
- No raw Hermes profile DB sync, memory sync, provider auth sync, env sync, or transcript dump.
- No Swell-style ptrace autocomplete or shell introspection.
- No mosh/SSH replacement inside Relay.
- No AI-generated shell commands as v1; safe command snippets can come later.
- No side-by-side split panes on phone.
- No relying on desktop responsive simulation as the only QA evidence.

## package/component recommendation

1. Keep `@xterm/xterm` for PTY rendering.
   - Relay already uses it and has mobile scroll/selection scaffolding.
   - Add a Relay mobile input/accessory layer rather than replacing the terminal engine.

2. Do not adopt WeTTY or ttyd wholesale.
   - WeTTY's virtual keys are useful reference code, but Relay already has session/node/control-plane concepts that WeTTY does not.
   - ttyd is intentionally simple terminal sharing; Relay needs WorkContext, actors, artifacts, and grants.

3. Borrow Swell.sh ideas only at UX level.
   - Suggestion chips and gesture typing are relevant.
   - Its Bash/ptrace/single-session model is a security and product mismatch.

4. Prefer structured web chat for Ebi/Hermes.
   - Use the existing web-chat protocol/adapters where they are working.
   - Raw PTY attach remains necessary for shell programs, fallback control, and debugging.

5. Consider xterm add-ons later.
   - `addon-fit` is already used and is central for keyboard resize.
   - `addon-search` may help scrollback find.
   - `addon-serialize`/headless can be considered for bounded previews, but do not let it become transcript storage.

## UX specification

### mobile active work list

Scan order:

1. what needs Kyle now
2. which work/session it belongs to
3. what action is safe from phone
4. where to inspect deeper

Row content:

- left: status/attention marker and actor/runtime label
- primary text: WorkContext title or task ref
- secondary text: latest meaningful event, not raw byte tail
- metadata: node, cwd/repo/branch/PR when explicit, freshness, artifact count
- right action: `open`, `reply`, or `approve` depending on state

Empty state:

- copy: `no active Relay work`
- action: `start Hermes conversation`
- secondary: `Relay will create a WorkContext on the selected node. Use Tailscale/private access; do not expose the hub publicly.`

### conversation detail

Sections:

- sticky header: WorkContext identity and freshness
- attention card: pending prompt/approval/blocker, if any
- timeline: structured messages/tool cards/summaries
- artifact strip: PR, issue, logs, screenshots, diagnostics
- composer: text input plus send/interrupt/palette
- terminal fallback tab/sheet

Loading state:

- show card skeletons matching the list/detail shape, not random shimmer bars.
- if node is stale/offline, show last-known state immediately and disable live controls.

Error state:

- name the failing surface: `node offline`, `web chat adapter unavailable`, `terminal attach failed`, `permission required`.
- provide next action: retry, open stale summary, open terminal fallback, or request capability.

### mobile terminal fallback

Required controls:

- accessory key bar
- visible copy-mode state
- jump bottom
- scrollback thumb
- keyboard-safe resize
- connection/freshness banner
- warning/confirmation for destructive controls

The terminal fallback should inherit Relay's TUI aesthetic: black background, monospace, compact metadata, square controls, outline-only buttons, no emoji, no decorative mobile-app chrome.

## QA acceptance scenarios

Test these on at least iPhone Safari and Android Chrome before claiming the slice dogfoodable. If real devices are unavailable, mark that explicitly and run responsive browser evidence as a weaker fallback.

1. iPhone narrow viewport, keyboard closed
   - Open Active Work.
   - List rows fit without horizontal scroll.
   - Primary attention item is visible above the fold.

2. iPhone narrow viewport, keyboard open
   - Open conversation composer.
   - Type and send a short message.
   - Composer and send button remain above the keyboard.
   - Page does not zoom or hide the prompt.

3. Android Chrome, raw terminal fallback
   - Open a tmux-backed session.
   - Use accessory `ctrl` + `c`, `tab`, arrows, and `esc`.
   - Scroll normal buffer and alternate-buffer app without losing input focus.

4. Approval/input prompt
   - Trigger or fixture an approval/input request.
   - Notification/list row opens the exact pending prompt.
   - Allow/deny/input response records a visible event and returns to the session.

5. Node stale/offline
   - Simulate node disconnect.
   - List/detail show last-known state and freshness.
   - Live controls are disabled; safe artifact/summary viewing still works.

6. Artifact/browser preview
   - Open PR/log/dev-server artifact from conversation detail.
   - It opens as a sheet/full route with a clear return path.
   - No desktop split layout is forced on the phone.

7. Security guardrails
   - Attempt destructive pause/kill/retry without the needed grant.
   - UI blocks with clear capability copy.
   - With grant, destructive action requires confirmation and emits/records an audit-visible event.

## implementation risks

- xterm mobile support remains uneven upstream; Relay-owned tests are mandatory.
- iOS virtual keyboard and VisualViewport behavior can differ between Safari versions and installed keyboard apps.
- Structured Hermes web-chat adapter availability may lag the desired product surface; fallback must be honest and bounded.
- Suggestion chips can become dangerous if they run commands too eagerly. Default to paste/preview/explain unless an action is explicitly safe.
- Notification permission prompts can be noisy on mobile; in-app attention state must work without OS notifications.
- Any public ingress story risks turning Relay into a terminal SaaS. Keep tailnet/private-network defaults prominent.

## decision

Build the first mobile slice as a Relay workbench conversation inbox/detail with terminal fallback:

- adopt cmux's attention-rich session/workspace metadata model;
- use xterm.js only for raw attach, with Relay-owned accessory keys and viewport handling;
- borrow Swell/WeTTY/Termux/Blink/Termius input patterns selectively;
- keep WorkContext, capability grants, artifacts, and audit as the product spine;
- explicitly reject generic public SSH/browser-terminal scope.
