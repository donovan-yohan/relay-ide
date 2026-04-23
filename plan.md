# Fix #151: --bg first-run crash loop (no PIN configured)

## Problem
Running `relay-ide --bg` on first run (no config/PIN yet) causes a crash loop. The background service gets installed but then repeatedly crashes and restarts.

## Investigation Notes
- `bin/relay-ide.ts` handles `--bg` by calling `service.install()` which creates a launchd/systemd service file pointing to the config path
- The service starts relay-ide with `--config <path>`
- `server/index.ts` tries to load config, falls back to DEFAULTS if missing, saves it
- `initializePinConfig()` then runs: if no TTY and no pinHash, it logs a message and continues — but something causes the process to exit or crash
- Need to trace what happens when the server starts headless with no PIN and no prior config
- Check: does the server bind to the port before PIN init? does some early-exit condition trigger? does the service file KeepAlive cause restart on non-zero exit?

## Fix Approach
Find the root cause in `server/index.ts` or `bin/relay-ide.ts` that makes the headless first-run server exit. Likely candidates:
- `ensureFrontendBuilt` failing because frontend hasn't been built and there's no build tool available in the service context
- Analytics init failure causing uncaught exception
- Port allocator failing due to missing config state
- The process exits because `initializePinConfig` throws or some other startup step fails

Add defensive error handling or skip steps that require interactive TTY when running as a service. Ensure the server stays alive and serves the PIN-setup page.

## Files to Investigate
- `bin/relay-ide.ts` — service install flow
- `server/index.ts` — startup sequence, especially `ensureFrontendBuilt`, `initializePinConfig`, `initAnalytics`
- `server/service.ts` — service file generation

## Acceptance Criteria
- [ ] `relay-ide --bg` on a fresh machine installs the service and it stays running
- [ ] The web UI is accessible on the configured port to set the initial PIN
- [ ] No crash loop in launchd/systemd logs
