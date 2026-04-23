# Agent Browser Verification — Implementation Plan

## Goal
Enable agents working in relay-ide PTY sessions to launch browsers, screenshot, and validate UI changes without colliding with globally installed relay-ide or other worktrees.

## Context
- Port allocator already gives each worktree unique ports (10000-11999 range)
- `RELAY_IDE_URL` is already injected into PTY env for OpenCode hooks
- Playwright is already a dev dependency
- Basic e2e tests exist but use hardcoded port 3456

## Tasks

### Task 1: Sandbox Mode for relay-ide
**File**: `server/sandbox.ts` (new)
**What**: Module that starts an isolated relay-ide instance:
- Creates ephemeral config dir in `/tmp/relay-ide-sandbox-<uuid>/`
- Copies minimal config with no PIN, single workspace pointing to cwd
- Finds free port via get-port (respecting allocated ports if in worktree)
- Starts server process, waits for health
- Returns { url, port, configPath, pid }
- teardown() kills process and cleans up config dir

**File**: `scripts/sandbox-cli.ts` (new)
**What**: CLI entry point for `npm run sandbox`:
- Parses args: `--port`, `--workspace`, `--no-build`
- Calls sandbox module
- Prints URL to stdout for agent consumption
- Handles SIGINT/SIGTERM for clean teardown

**File**: `package.json`
**What**: Add `"sandbox": "node dist/scripts/sandbox-cli.js"` script

### Task 2: Agent Browser Bridge
**File**: `server/agent-browser.ts` (new)
**What**: Browser automation helper for agents:
- `launchBrowser(url, options)` — launches Playwright Chromium, returns page
- `screenshot(page, path)` — takes screenshot
- `closeBrowser(browser)` — clean teardown
- Reads `RELAY_IDE_URL` from env if url not provided

**File**: `scripts/agent-browser-cli.ts` (new)
**What**: CLI for agents to use from PTY sessions:
- `relay-ide-browser open [url]` — launches Chrome at URL or RELAY_IDE_URL
- `relay-ide-browser screenshot [url] --out path` — takes screenshot
- `relay-ide-browser validate [url]` — loads page, checks no console errors, returns pass/fail

### Task 3: Server API for Browser Discovery
**File**: `server/index.ts` (modify)
**What**: Add endpoint `GET /agent/browser-info`:
- Returns { url: `http://127.0.0.1:${port}`, sessionId, worktreePorts }
- Useful for agents to discover their relay-ide instance

### Task 4: Worktree Dev Script Port Awareness
**File**: `package.json` (modify)
**What**: Update dev script to respect allocated PORT env:
- `"dev": "RELAY_IDE_PORT=\${RELAY_IDE_PORT:-3457} node dist/server/index.js"`
- Actually: `"dev": "cross-env RELAY_IDE_PORT=${RELAY_IDE_PORT:-3457} NO_PIN=1 node dist/server/index.js"` ... simpler: just use shell default
- Better: keep it simple, the sandbox script handles port allocation

### Task 5: E2E Foundation Using Sandbox
**File**: `test/e2e/global-setup.ts` (new)
**What**: Playwright globalSetup that uses sandbox module to start backend

**File**: `test/e2e/global-teardown.ts` (new)
**What**: Cleans up sandbox instance

**File**: `playwright.config.ts` (modify)
**What**: Use globalSetup/globalTeardown, point webServer at sandbox if not using globalSetup

**File**: `test/e2e/helpers/sandbox.ts` (new)
**What**: Helper for e2e tests to interact with sandbox backend

### Task 6: Tests
**File**: `test/sandbox.test.ts` (new)
**What**: Unit tests for sandbox module

**File**: `test/agent-browser.test.ts` (new)
**What**: Unit tests for agent browser bridge

## Acceptance Criteria
- [ ] `npm run sandbox` starts isolated relay-ide on unique port
- [ ] Agents can run `npx relay-ide-browser open` from PTY to launch Chrome
- [ ] Agents can run `npx relay-ide-browser screenshot --out file.png` 
- [ ] Multiple worktrees can run dev servers without port collisions
- [ ] E2E tests use sandbox backend instead of hardcoded port
- [ ] Global relay-ide on 3456 is unaffected by sandbox instances
