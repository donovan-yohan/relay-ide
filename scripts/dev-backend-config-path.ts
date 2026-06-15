#!/usr/bin/env node
// Prints the per-checkout app-data config path that `npm run dev` (the
// supervised dev runner, scripts/dev.ts) uses for ordinary source dev. The
// split-dev `dev:backend` npm script consumes this so it shares the exact same
// runtime-state directory as `npm run dev` instead of pinning a repo-relative
// `./config.dev.json` (which spilled config + every SQLite store into the
// checkout root — #961). Keep the fileName/namespace in sync with the
// non-self-host branch of scripts/dev-mode.ts.
import path from 'node:path';

import { resolveSourceLaunchConfigPath } from '../server/runtime-state-paths.js';

const packageRoot = path.resolve(import.meta.dirname, '..', '..');
process.stdout.write(
  resolveSourceLaunchConfigPath(packageRoot, {
    fileName: 'config.dev.json',
    namespace: 'dev',
  }).configPath
);
