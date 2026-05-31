# Agent Browser Verification Pipeline

Verified end-to-end pipeline for agents working in git worktrees to launch an isolated Relay IDE instance, screenshot the UI, and validate changes without colliding with the globally installed `relay-ide`.

## Prerequisites

- Node.js >= 24.0.0
- `npm install` has been run in the main repo (so `node_modules` and Playwright browsers exist)
- The main repo has a built frontend at `dist/frontend/` (run `npm run build` there once)

## Quick Start

From any worktree:

```bash
# 1. Build the server (fast — no frontend needed)
npm run build:server

# 2. Start an isolated sandbox
npm run sandbox:dev
# → Sandbox ready at http://127.0.0.1:3457

# 3. In another shell, screenshot the app
RELAY_IDE_URL=http://127.0.0.1:3457 npx relay-ide-browser screenshot --out before.png

# 4. Make your code changes, then screenshot again
RELAY_IDE_URL=http://127.0.0.1:3457 npx relay-ide-browser screenshot --out after.png

# 5. Validate for console errors
RELAY_IDE_URL=http://127.0.0.1:3457 npx relay-ide-browser validate
# → {"ok": true, "errors": []}
```

## How It Works

### Sandbox Mode (`server/sandbox.ts`)

`startSandbox()` spawns a completely isolated Relay IDE backend:

1. Creates an ephemeral config dir in `os.tmpdir()`
2. Discovers a free port (3456-3556 range) or uses the one you specify
3. Writes a config JSON with `host: 127.0.0.1` and your `workspacePath` as the only repo
4. **Bootstraps the frontend build** from the main repo if the worktree doesn't have one (see below)
5. Spawns `node dist/server/index.js` with `RELAY_IDE_DEV_INSTANCE=1`, `RELAY_IDE_TMUX_PREFIX=relay-sandbox-`, and the ephemeral config
6. Polls `/health` every 200ms until the server is ready (30s timeout)
7. Returns `{ url, port, configPath, dataDir, process, teardown }`

### Frontend Build Bootstrapping

Worktrees share `node_modules` with the main repo via git-worktree mechanics, but **build artifacts in `dist/` are not shared**. If a worktree doesn't have `dist/frontend/index.html`, `sandbox.ts` automatically copies the main repo's `dist/frontend/` into the worktree before starting the server.

**Important:** This is a convenience fallback. If you modify frontend source files in the worktree, you **must** run `npm run build` in the worktree to see your changes. The bootstrap only copies the main repo's build once; it won't overwrite an existing `dist/frontend/`.

### Browser Bridge (`server/agent-browser.ts` + `relay-ide-browser` CLI)

The `relay-ide-browser` binary (registered in `package.json` `bin`) provides three commands:

| Command | Purpose |
|---|---|
| `open [url]` | Launch Chrome and keep it open until Ctrl+C |
| `screenshot [url] --out <path>` | Full-page screenshot via Playwright |
| `validate [url]` | Load page, wait 500ms, report console errors as JSON |

Environment:
- `RELAY_IDE_URL` — default URL if none provided on the command line
- Falls back to `http://127.0.0.1:3456` if neither is set

### Why No Collision

- **Port:** Each sandbox gets its own ephemeral port. The global `relay-ide` (if running) typically uses 3456; sandboxes use 3457+.
- **Config:** Each sandbox writes its own `config.json` in a temp dir, so there's no conflict over `~/.config/relay-ide/config.json`.
- **Tmux:** The sandbox runs with an explicit `relay-sandbox-` tmux prefix, keeping sessions isolated from production `relay-ide-` and ordinary dev `relay-dev-` prefixes.

## API Reference

### `startSandbox(options)`

```typescript
import { startSandbox } from './server/sandbox.js';

const sandbox = await startSandbox({
  port: 19997,        // optional — uses this exact port
  workspacePath: '.', // optional — defaults to process.cwd()
});

console.log(sandbox.url);     // http://127.0.0.1:19997
console.log(sandbox.port);    // 19997

// later
await sandbox.teardown(); // kills process, removes temp dir
```

### Browser automation

```typescript
import { launchBrowser, screenshot, validatePage, closeBrowser } from './server/agent-browser.js';

const session = await launchBrowser('http://127.0.0.1:3457', { headless: true });
await screenshot(session, 'out.png');
const result = await validatePage(session); // { ok: boolean, errors: string[] }
await closeBrowser(session);
```

## CI / Testing

The test suite covers both modules:

```bash
npx vitest run test/sandbox.test.ts test/agent-browser.test.ts
```

- Sandbox tests verify port allocation, server startup, config generation, and teardown.
- Agent-browser tests verify module exports, Playwright availability, screenshot/validation against `data:` URLs, and console-error capture.

Tests skip gracefully when Playwright Chromium binaries are missing (run `npx playwright install` if needed).

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Frontend build failed: Could not load .../addon-webgpu` | This is expected in worktrees. The sandbox auto-copies the main repo's `dist/frontend/`. If you changed frontend code, run `npm run build` in the main repo first, or build in the worktree after fixing node_modules. |
| `Sandbox server did not start within 30000ms` | Check that `dist/server/index.js` exists (`npm run build:server`). Verify the port isn't already bound. |
| `Playwright is unavailable` | Run `npm install` then `npx playwright install` to download Chromium binaries. |
| Screenshot is blank / white | The page may still be loading. `validate` waits 500ms; for screenshots you may want to add an explicit `page.waitForSelector()` call in your script. |

## Future Work

- **Visual diffing:** Integrate pixelmatch or odiff to compare `before.png` and `after.png` automatically.
- **Agent loop:** A higher-level script that watches for file changes, rebuilds, restarts the sandbox, and re-screenshots.
- **Port allocator integration:** Tie sandbox ports into `server/port-allocator.ts` for durable, worktree-scoped assignments instead of ephemeral discovery.
