#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Post-install script for relay-ide
 *
 * 1. Fixes node-pty permissions (macOS ARM64)
 * 2. Auto-restarts background service if running (picks up new code after npm update)
 */

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── Step 1: Fix node-pty permissions (existing behavior) ──

try {
  execSync(
    'chmod +x node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper 2>/dev/null || true',
    {
      cwd: path.join(__dirname, '..'),
      stdio: 'ignore',
    }
  );
} catch {
  // Ignore errors - this is best-effort
}

// ── Step 2: Auto-restart background service if running ──

// When the update is triggered via the server's POST /update API, the server
// handles its own graceful restart (serialize sessions, broadcast, exit for
// launchd KeepAlive). Postinstall must NOT kill the server mid-request.
const skipRestart = process.env.RELAY_IDE_SKIP_SERVICE_RESTART === '1';

async function restartServiceIfRunning() {
  try {
    // Import service module from compiled dist
    // Note: This runs after npm install, so dist/ should be available
    const servicePath = path.join(__dirname, '../dist/server/service.js');

    if (!fs.existsSync(servicePath)) {
      // Dist not built yet (e.g., during development), skip restart
      return;
    }

    const service = await import(servicePath);

    // Check if service is installed
    if (!service.isInstalled()) {
      // Service not installed, nothing to restart
      return;
    }

    // Check if service is running
    const status = service.status();
    if (!status.running) {
      // Service installed but not running, nothing to restart
      return;
    }

    // Service is installed and running - restart it to pick up new code
    console.log(
      '[postinstall] Background service detected - restarting to apply update...'
    );

    try {
      // Get config path
      const home = process.env.HOME || process.env.USERPROFILE || '~';
      const configDir = path.join(home, '.config', 'relay-ide');
      const configPath = path.join(configDir, 'config.json');

      // Load config to get port/host
      let port = '3456';
      let host = '0.0.0.0';
      if (fs.existsSync(configPath)) {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        port = String(config.port || 3456);
        host = config.host || '0.0.0.0';
      }

      // Uninstall the service (stops it)
      service.uninstall();

      // Re-install the service (starts it with new code)
      service.install({ configPath, port, host });

      console.log('[postinstall] Service restarted successfully.');
    } catch (err) {
      console.warn('[postinstall] Failed to restart service:', err.message);
      console.warn(
        '[postinstall] You may need to restart manually: relay-ide install'
      );
    }
  } catch (err) {
    // Don't fail the install if restart fails
    console.warn('[postinstall] Could not check service status:', err.message);
  }
}

// Skip restart if triggered from a worktree or local dev build — only global
// installs should touch the production service.
const WORKTREE_MARKERS = [
  path.sep + '.worktrees' + path.sep,
  path.sep + '.claude' + path.sep + 'worktrees' + path.sep,
  path.sep + '.belayer' + path.sep + 'worktrees' + path.sep,
];
const isWorktreeInstall = WORKTREE_MARKERS.some((m) => __dirname.includes(m));
if (isWorktreeInstall) {
  console.log(
    '[postinstall] Running inside a worktree — skipping service restart.'
  );
}

// Run restart check (skipped when the server's POST /update API handles its own restart)
if (!skipRestart && !isWorktreeInstall) {
  restartServiceIfRunning();
}
