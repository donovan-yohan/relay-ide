# QA Guide

Quick setup for local testing and visual QA of claude-remote-cli.

## Local Dev Server

The production instance runs on port 3456. Use a different port for QA:

```bash
# Build and start on port 3457 (must use CLI entry point for --port flag)
npm run build && node dist/bin/claude-remote-cli.js --port 3457 --config "$(pwd)/config.json"
```

**Important:** Use `dist/bin/claude-remote-cli.js` (not `dist/server/index.js`) — only the CLI entry point parses `--port` and `--config` flags.

## Test PIN Setup

To set or reset PIN to `8888` for QA, run this one-liner (generates a fresh scrypt hash):

```bash
node -e "
const crypto = require('crypto');
const { promisify } = require('util');
const scrypt = promisify(crypto.scrypt);
async function main() {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = await scrypt('8888', salt, 64);
  const hash = 'scrypt:' + salt + ':' + derived.toString('hex');
  const fs = require('fs');
  const config = JSON.parse(fs.readFileSync('config.json', 'utf8'));
  config.pinHash = hash;
  fs.writeFileSync('config.json', JSON.stringify(config, null, 2));
  console.log('PIN set to 8888');
}
main();
"
```

Or delete `pinHash` entirely from `config.json` and restart — you'll be prompted to set a new PIN.

**Note:** Don't paste a pre-generated hash — the scrypt salt must match the runtime. Always generate fresh.

## Test URL

```
http://localhost:3457
```

PIN: `8888`

## QA Checklist — Settings & Webhooks Feature

### Settings Modal

- [ ] Open Settings (gear icon in sidebar footer)
- [ ] Verify full-screen modal with slide-up animation
- [ ] Verify 4 sections visible: GENERAL, INTEGRATIONS, ADVANCED, ABOUT
- [ ] Verify section headings are UPPERCASE with terminal aesthetic
- [ ] Scroll through all sections
- [ ] Click hamburger (☰) — verify TOC drawer slides from left
- [ ] Click a TOC item — verify smooth scroll to section
- [ ] Verify accent highlight bar moves in TOC as you scroll
- [ ] Type in search bar — verify sections dim/collapse for non-matches
- [ ] Clear search — verify all sections restore
- [ ] Close modal — verify fade-out animation
- [ ] Cmd+K → type "webhook" — verify settings result appears in Spotlight
- [ ] Select a Spotlight settings result — verify Settings opens scrolled to section

### Settings — GENERAL Section

- [ ] Change Default Coding Agent — verify persists on reopen
- [ ] Toggle Continue/YOLO/Tmux/Notifications — verify each persists
- [ ] Verify each setting has name + description + right-aligned action

### Settings — INTEGRATIONS Section

- [ ] GitHub row shows connection status (connected/not connected)
- [ ] Click GitHub row — verify accordion expands
- [ ] If connected: verify username shown + Disconnect button
- [ ] Webhooks row shows configuration status
- [ ] Click Webhooks row — verify accordion expands with setup/status
- [ ] Jira row shows CLI status
- [ ] Click Jira row — verify install instructions shown

### Settings — Webhook Setup Flow (requires GitHub connected)

- [ ] Click "Setup Webhooks" — verify loading state
- [ ] Verify smee channel + secret generated
- [ ] Verify health indicator shows connection status
- [ ] Verify backfill banner appears if workspaces exist
- [ ] Click "Test Connection" — verify ping result
- [ ] Verify auto-provision toggle works
- [ ] Click "Remove Setup" — verify confirmation dialog
- [ ] Confirm removal — verify return to unconfigured state

### Compact Dialogs (verify DialogShell migration)

- [ ] Open Customize Session — verify fade+scale animation, terminal aesthetic
- [ ] Open Delete Worktree — verify same animation, outlined danger button
- [ ] Open Add Workspace — verify same animation, file browser works
- [ ] All dialogs: verify border-radius 0, monospace buttons, backdrop click closes

### Mobile (resize browser to <600px)

- [ ] Settings modal goes full-screen
- [ ] TOC drawer works as hamburger flyout
- [ ] Setting rows stack vertically for wide actions
- [ ] Integration accordions still work
- [ ] Compact dialogs fill width

### Responsive (between 600px–1200px)

- [ ] Settings modal fills viewport
- [ ] Content area centered with max-width 640px

### Large screens (>1200px)

- [ ] Settings modal has 24px inset from edges

## Automated QA with gstack browse

For `/design-review` and `/qa` skills, the browse tool needs a running server.

### Setup steps

1. **Build**: `npm run build`
2. **Set PIN**: Run the PIN setup script above
3. **Start server**: `node dist/bin/claude-remote-cli.js --port 3457 --config "$(pwd)/config.json"`
   - Must use `dist/bin/claude-remote-cli.js` (CLI entry point), NOT `dist/server/index.js`
   - `dist/server/index.js` does not parse `--port` or `--config` flags
   - The `&` backgrounding works but the process must stay alive
4. **Verify**: `curl -s -o /dev/null -w "%{http_code}" http://localhost:3457/` should return `200`

### Browse tool authentication

The browse tool needs to authenticate with PIN:

```bash
B=~/.claude/skills/gstack/browse/dist/browse
$B goto "http://localhost:3457"
$B fill @e1 "8888"      # PIN input (first textbox on login page)
$B click @e2             # Unlock button
```

After auth, the cookie persists for the session.

### Common gotchas

- **Port 3456 in use**: The production instance (installed via `npm install -g`) runs on 3456. Always use `--port 3457` for QA.
- **PIN hash mismatch**: Generate the hash at runtime (not pre-computed). The scrypt salt must be generated on the same machine.
- **Multiple dialog instances**: `document.querySelector('.dialog-shell')` may return the wrong dialog. Use `.dialog-shell--fullscreen` or `.dialog-shell--compact` to target specific variants. There are 4 DialogShell instances in the DOM (Settings + 3 compact dialogs).
- **Scroll containers**: The fullscreen settings body is `.dialog-shell--fullscreen .dialog-shell__body`. Scroll via `body.scrollTop = N`.
