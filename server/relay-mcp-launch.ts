import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * How to start the local stdio Relay MCP facade (`bin/relay-mcp.ts`).
 *
 * This is a launch spec, never a credential carrier: the facade reads Relay's
 * URL and token exclusively from the environment it inherits from the agent
 * process Relay spawned (`RELAY_IDE_ACTOR_TOKEN` / `RELAY_IDE_PORT`). Nothing
 * here may ever be widened to carry a token — an MCP mount is written into
 * provider argv/config, which is world-readable through `ps`.
 */
export interface RelayMcpLaunchSpec {
  command: string;
  args: string[];
}

interface RelayMcpLaunchDeps {
  /** Location of THIS module, used to find the sibling compiled bin. */
  moduleUrl?: string;
  execPath?: string;
  exists?: (candidate: string) => boolean;
  isExecutableFile?: (candidate: string) => boolean;
  pathEnv?: string | undefined;
  pathSeparator?: string;
}

function defaultIsExecutableFile(candidate: string): boolean {
  try {
    if (!fs.statSync(candidate).isFile()) return false;
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the facade launch spec, or `undefined` when this installation has no
 * built facade.
 *
 * Three layouts, checked in order:
 *  1. package/dist mode — this module is `dist/server/relay-mcp-launch.js`, so
 *     the compiled bin is `../bin/relay-mcp.js` (the `resolveRelayctlBinaryPath`
 *     pattern in `server/pty-handler.ts`).
 *  2. source-dev mode — this module is `server/relay-mcp-launch.ts` under tsx,
 *     and a build output may sit at `../dist/bin/relay-mcp.js`.
 *  3. an installed `relay-mcp` on PATH (the package `bin` entry).
 *
 * Returning `undefined` is a normal outcome (a source checkout that was never
 * built): callers mount nothing rather than pointing a provider at a path that
 * does not exist.
 *
 * Every candidate this returns is ABSOLUTE. The provider — not Relay — spawns
 * the command, and it resolves a relative command against the AGENT's cwd (a
 * workspace repo), not the hub's, so a relative `PATH` entry such as `.` would
 * be checked here and executed somewhere else. Relative entries are skipped
 * rather than resolved, because resolving them would mount whatever happens to
 * sit in the hub's working directory.
 */
export function resolveRelayMcpLaunch(
  deps: RelayMcpLaunchDeps = {}
): RelayMcpLaunchSpec | undefined {
  const execPath = deps.execPath ?? process.execPath;
  const exists = deps.exists ?? ((candidate) => fs.existsSync(candidate));
  const isExecutableFile = deps.isExecutableFile ?? defaultIsExecutableFile;
  let here: string;
  try {
    here = path.dirname(fileURLToPath(deps.moduleUrl ?? import.meta.url));
  } catch {
    return undefined;
  }
  for (const candidate of [
    path.join(here, '..', 'bin', 'relay-mcp.js'),
    path.join(here, '..', 'dist', 'bin', 'relay-mcp.js'),
  ]) {
    if (exists(candidate)) return { command: execPath, args: [candidate] };
  }
  const separator = deps.pathSeparator ?? path.delimiter;
  const pathEnv =
    deps.pathEnv !== undefined ? deps.pathEnv : process.env['PATH'];
  for (const entry of (pathEnv ?? '').split(separator)) {
    // Relative `PATH` entries (`.`, `node_modules/.bin`, `''` for cwd) are
    // skipped, not resolved: the mounted command string is handed to the
    // provider, which resolves it against the agent's cwd rather than the one
    // `isExecutableFile` just checked.
    if (!entry || !path.isAbsolute(entry)) continue;
    const candidate = path.join(entry, 'relay-mcp');
    if (isExecutableFile(candidate)) return { command: candidate, args: [] };
  }
  return undefined;
}

let cached: { spec: RelayMcpLaunchSpec | undefined } | undefined;

/**
 * Process-memoized `resolveRelayMcpLaunch`. Runtime spawn is a hot-ish path and
 * the answer cannot change while the server is running.
 */
export function relayMcpLaunchSpec(): RelayMcpLaunchSpec | undefined {
  cached ??= { spec: resolveRelayMcpLaunch() };
  return cached.spec;
}
