# QA Guide

Manual QA pass for the channel product surface. For automated browser checks
driven by an agent, see
[`agent-browser-verification.md`](agent-browser-verification.md).

## Local QA instance

Use `npm run dev`. It builds the backend, starts an isolated instance on
`127.0.0.1:3457`, runs Vite on `127.0.0.1:5173`, and — critically — puts config
and every runtime SQLite store under `~/.config/relay-ide/dev/<slug>-<hash>/`
rather than the checkout.

```bash
npm run dev
```

**Never point `--config` at a path inside the repo.** Runtime SQLite must stay
out of tracked working trees (#961). If you need a package-mode instance rather
than a dev instance, give it an explicit config directory outside the checkout:

```bash
npm run build
node dist/bin/relay-ide.js --port 3457 --config ~/.config/relay-ide/qa/config.json
```

Only `dist/bin/relay-ide.js` parses `--port` and `--config`;
`dist/server/index.js` does not.

The default install runs on 3456. Always use a different port for QA so you do
not collide with it.

### PIN

Relay refuses browser traffic until a PIN is set. Delete `pinHash` from the QA
config and restart to get the setup prompt, or run `relay-ide pin reset` against
that config. Do not paste a pre-generated hash — the scrypt salt is generated at
runtime.

## Checklist

### First run

- [ ] Fresh config directory → PIN setup appears before any content
- [ ] Set a PIN → lands in the app, sidebar is empty
- [ ] Reload → still authenticated
- [ ] Wrong PIN is rejected and rate-limited

### Projects and channels

- [ ] `+ add project` is visible in the empty sidebar
- [ ] Add a project → its lane appears and persists across reload
- [ ] `new chat` creates a channel in the selected lane, not the previous one
- [ ] `new chat` still works immediately after adding a project (#1302)
- [ ] Channel rows show title, last activity, and unread state
- [ ] Collapse/expand state persists across reload
- [ ] Archive a channel → leaves the active list; restore returns it

### Conversation

- [ ] Post a human message → appears once, no duplicate row
- [ ] `@claude` / `@codex` → profile spawns, presence row shows status
- [ ] Reply streams into the timeline and finalizes complete
- [ ] Reasoning, tool, code, output, and diff cards render and expand
- [ ] Code cards syntax-highlight; diff cards show addition/deletion tint
- [ ] Attach an image → renders inline, survives reload
- [ ] Interrupt an in-flight turn → partial reply finalizes `interrupted`
- [ ] DM a profile with no mention → routes to that profile
- [ ] Scroll up to load older history → anchor row does not jump

### Threads

- [ ] Open a thread on a message → panel opens beside the timeline
- [ ] Reply in thread → agent reply stays in the thread
- [ ] Thread reply count updates on the root row
- [ ] Close and reopen the thread → replies persist

### Search

- [ ] Type a query → two sections appear (channels, messages)
- [ ] Message result shows a snippet with the match
- [ ] Select a message result → opens that channel and jumps to the row
- [ ] Query shorter than the minimum says so, rather than "no matches"
- [ ] Archived channels appear when included
- [ ] Cmd+K → same query works as a palette category

### Messages

- [ ] Hover a message → toolbar appears (copy link, edit, delete)
- [ ] Copy link → pasting the URL opens that channel scrolled to the message
- [ ] Deep link to an old message → walks history, or toasts if unreachable
- [ ] Edit a message → body updates in place, no new row, no agent re-trigger
- [ ] Delete a message → row reflects deletion
- [ ] Fail a send (stop the server mid-post) → row shows failed, retry works
- [ ] Archived channel refuses edit/delete/retry

### Read state and notifications

- [ ] Read a channel on one browser → unread clears on a second browser
- [ ] A channel read on device A never returns to unread from device B
- [ ] Hide the tab, receive a message → OS notification (once, not per tab)
- [ ] Favicon badge and title count update while hidden
- [ ] Focus the tab → badge and title clear
- [ ] Two tabs open → exactly one notification per event
- [ ] Notification settings toggle persists across reload

### Steering

- [ ] Send while an agent is mid-turn → `queued` chip on the message
- [ ] Presence row shows `(n queued)`
- [ ] Turn completes → queued messages drain into one next turn
- [ ] `cmd/ctrl`+`enter` mid-turn → live turn finalizes `interrupted`, new message runs
- [ ] With no live turn, `cmd/ctrl`+`enter` is a plain send
- [ ] Chip clears when the queue drains

### Settings

- [ ] Sections render: general, notifications, agent profiles, integrations, nodes, advanced, about
- [ ] Section headings are lowercase (per `DESIGN.md`)
- [ ] Change default coding agent → persists on reopen
- [ ] Create an agent profile → appears in the roster and in `@` autocomplete
- [ ] Two profiles from one vendor are visually distinct participants
- [ ] `@claude` resolves to the vendor default profile
- [ ] TOC drawer, search filter, and Cmd+K deep-link into a section still work

### Update toast

- [ ] With an update available → toast appears bottom-right
- [ ] One click updates and reloads when the server returns
- [ ] Dismiss → does not reappear that session

### Mobile (narrow viewport or real device)

- [ ] Channel list → channel → back navigation works
- [ ] Composer stays visible with the virtual keyboard open
- [ ] Timeline stays anchored when the keyboard opens
- [ ] Detail cards are readable and expandable at narrow width
- [ ] Thread panel is usable full-width
- [ ] Interrupt and steering controls are tappable

Mobile terminal input changes need a fixture under
`test/fixtures/mobile-input/` and real-device proof.

## Automated QA with gstack browse

For `/design-review` and `/qa`, the browse tool needs a running server. Pick one
of the two lanes and browse the URL that lane actually serves the UI on —
mixing them is how a design review silently reviews stale assets.

**Dev lane (`npm run dev`).** The backend listens on `127.0.0.1:3457`; the UI
you must browse is Vite on `127.0.0.1:5173`, which proxies the REST routes and
`/ws` back to 3457. Frontend edits are live over HMR, no build step. Both
processes bind `127.0.0.1` only — use that literal, not `localhost`.

1. Start: `npm run dev`
2. Verify: `curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:5173/` returns `200`
3. Browse `http://127.0.0.1:5173`

**Package lane (built assets).** Browse 3457 directly, but only after a build —
the server serves `dist/frontend` and returns early the moment `index.html`
exists, so it never rebuilds an edited TSX/CSS change for you.

1. Start: `npm run build && node dist/bin/relay-ide.js --port 3457 --config ~/.config/relay-ide/qa/config.json`
2. Verify: `curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3457/` returns `200`
3. Browse `http://127.0.0.1:3457`

Then authenticate against whichever URL you started with:

```bash
B=~/.claude/skills/gstack/browse/dist/browse
$B goto "http://127.0.0.1:5173"   # package lane: http://127.0.0.1:3457
$B fill @e1 "<pin>"     # PIN input (first textbox on the login page)
$B click @e2            # Unlock button
```

The cookie persists for the session.

### Common gotchas

- **Reviewing stale assets** — on the package lane, an unbuilt frontend change
  is invisible: `ensureFrontendBuilt` returns early when
  `dist/frontend/index.html` already exists. Rebuild, or use the dev lane.
- **Port 3456 in use** — that is the default install. Use 3457 for QA.
- **PIN hash mismatch** — generate at runtime; the scrypt salt is per-run.
- **Multiple dialog instances** — `document.querySelector('.dialog-shell')` may
  return the wrong one. Target `.dialog-shell--fullscreen` or
  `.dialog-shell--compact`.
- **Scroll containers** — the fullscreen settings body is
  `.dialog-shell--fullscreen .dialog-shell__body`. Scroll via `body.scrollTop = N`.
- **Channel timeline scrolling** — the timeline is its own scroll container
  (`role="log"`, `aria-label="channel timeline"`), not the page.
