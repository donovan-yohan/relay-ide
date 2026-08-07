// Runtime-state path resolution (#961).
//
// All Relay runtime SQLite stores (`work-contexts.db`, `context-packets.db`,
// `workflow-runs.db`, `analytics.db`, ...) live in the *config directory* —
// `path.dirname(CONFIG_PATH)`. So wherever the config file lands, the runtime
// DBs land beside it.
//
// The published CLI bin and `dev:self` already point the config at app-data
// (`~/.config/relay-ide/...`), but two from-source launch paths historically
// defaulted the config into the repo checkout root:
//   - `npm run dev`          → `<repo>/config.dev.json`
//   - `node dist/server/index.js` (raw) → `<repo>/config.json`
// Both spilled the runtime DBs into the checkout. This module relocates those
// defaults to a stable per-checkout directory under app-data so source dev
// never pollutes the working tree, while still letting explicit
// `RELAY_IDE_CONFIG` / `--config` win.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * Relay's app-data root for from-source launches: `$XDG_CONFIG_HOME/relay-ide`
 * when that var is an absolute path, else `~/.config/relay-ide`.
 *
 * `~/.config/relay-ide` matches the production root the CLI bin uses
 * (`server/service.ts`), except service.ts hardcodes `~/.config` and does NOT
 * honor `$XDG_CONFIG_HOME` — so when XDG is set, prod and from-source roots
 * intentionally differ rather than spilling source state into prod.
 *
 * A *relative* `XDG_CONFIG_HOME` is ignored per the XDG Base Directory spec:
 * honoring it would make the config path (and the runtime DBs beside it)
 * resolve against `process.cwd()` — i.e. back into the checkout — defeating the
 * point of #961. Mirrors the guard in `server/session-attachment.ts`
 * (security review #472).
 */
export function relayAppDataDir(
  env: Record<string, string | undefined> = process.env,
  homedir: string = os.homedir()
): string {
  const xdgConfigHome = env.XDG_CONFIG_HOME?.trim();
  const base =
    xdgConfigHome && path.isAbsolute(xdgConfigHome)
      ? xdgConfigHome
      : path.join(homedir, '.config');
  return path.join(base, 'relay-ide');
}

/** Filesystem-safe, human-readable slug for a checkout path's basename. */
export function safePathSlug(inputPath: string): string {
  return (
    path
      .basename(path.resolve(inputPath))
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'workspace'
  );
}

/** Short stable hash of the absolute checkout path (disambiguates same-named worktrees). */
export function pathHash(inputPath: string): string {
  return crypto
    .createHash('sha256')
    .update(path.resolve(inputPath))
    .digest('hex')
    .slice(0, 12);
}

export interface SourceLaunchConfigOptions {
  /** Config file name to use, e.g. `config.dev.json` or `config.json`. */
  fileName: string;
  /** App-data sub-namespace that isolates this launch mode, e.g. `dev` or `source`. */
  namespace: string;
  env?: Record<string, string | undefined> | undefined;
  homedir?: string | undefined;
}

export interface SourceLaunchConfigResolution {
  /** Resolved config path under app-data, keyed per checkout. */
  configPath: string;
  /**
   * The legacy in-checkout config path **if it still exists on disk**, else
   * `null`. Callers should warn (not silently honor) so users can migrate the
   * old file or pin it via `RELAY_IDE_CONFIG`. We never auto-read or delete it.
   */
  legacyConfigPath: string | null;
}

/**
 * Resolve the default config path for a from-source launch to a stable
 * per-checkout directory under app-data: `<app-data>/<namespace>/<slug>-<hash>/<fileName>`.
 *
 * This is only the *default*; callers must still let an explicit
 * `RELAY_IDE_CONFIG` / `--config` take precedence before calling this.
 */
export function resolveSourceLaunchConfigPath(
  checkoutRoot: string,
  options: SourceLaunchConfigOptions
): SourceLaunchConfigResolution {
  const env = options.env ?? process.env;
  const home = options.homedir ?? os.homedir();
  const resolvedCheckout = path.resolve(checkoutRoot);
  const legacyConfigPath = path.join(resolvedCheckout, options.fileName);
  const stateDir = path.join(
    relayAppDataDir(env, home),
    options.namespace,
    `${safePathSlug(resolvedCheckout)}-${pathHash(resolvedCheckout)}`
  );
  return {
    configPath: path.join(stateDir, options.fileName),
    legacyConfigPath: fs.existsSync(legacyConfigPath) ? legacyConfigPath : null,
  };
}
