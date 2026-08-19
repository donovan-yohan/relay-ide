/**
 * Resolver for the local stdio Relay MCP facade (#1410).
 *
 * The spec this produces is written into provider argv/config, so the tests
 * below pin two things: that it points at a file that actually exists, and that
 * it never grows a field that could carry a credential.
 */
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  relayMcpLaunchSpec,
  resolveRelayMcpLaunch,
} from '../server/relay-mcp-launch.js';

const PACKAGE_MODULE = pathToFileURL(
  '/opt/relay/dist/server/relay-mcp-launch.js'
).href;
const SOURCE_MODULE = pathToFileURL(
  '/work/relay-ide/server/relay-mcp-launch.ts'
).href;

describe('relay MCP facade launch resolution', () => {
  it('runs the compiled bin next to itself in package mode', () => {
    const spec = resolveRelayMcpLaunch({
      moduleUrl: PACKAGE_MODULE,
      execPath: '/usr/bin/node',
      exists: (candidate) => candidate === '/opt/relay/dist/bin/relay-mcp.js',
      isExecutableFile: () => false,
      pathEnv: '/usr/bin',
    });
    expect(spec).toEqual({
      command: '/usr/bin/node',
      args: ['/opt/relay/dist/bin/relay-mcp.js'],
    });
  });

  it('finds the build output from a source checkout', () => {
    const spec = resolveRelayMcpLaunch({
      moduleUrl: SOURCE_MODULE,
      execPath: '/usr/bin/node',
      exists: (candidate) =>
        candidate === '/work/relay-ide/dist/bin/relay-mcp.js',
      isExecutableFile: () => false,
      pathEnv: '/usr/bin',
    });
    expect(spec).toEqual({
      command: '/usr/bin/node',
      args: ['/work/relay-ide/dist/bin/relay-mcp.js'],
    });
  });

  it('falls back to an installed relay-mcp on PATH', () => {
    const spec = resolveRelayMcpLaunch({
      moduleUrl: PACKAGE_MODULE,
      execPath: '/usr/bin/node',
      exists: () => false,
      isExecutableFile: (candidate) =>
        candidate === '/home/dev/.local/bin/relay-mcp',
      pathEnv: ['/usr/bin', '/home/dev/.local/bin'].join(path.delimiter),
    });
    expect(spec).toEqual({
      command: '/home/dev/.local/bin/relay-mcp',
      args: [],
    });
  });

  it('skips relative PATH entries instead of mounting a cwd-relative command', () => {
    // The PROVIDER spawns this command, and it resolves a relative command
    // against the AGENT's cwd (a workspace repo), not the hub's — so a `.` or
    // `node_modules/.bin` entry would be checked here and executed somewhere
    // else entirely. Skipped, never resolved against the hub's cwd.
    const spec = resolveRelayMcpLaunch({
      moduleUrl: PACKAGE_MODULE,
      execPath: '/usr/bin/node',
      exists: () => false,
      isExecutableFile: (candidate) =>
        candidate === path.join('.', 'relay-mcp') ||
        candidate === path.join('node_modules/.bin', 'relay-mcp') ||
        candidate === '/home/dev/.local/bin/relay-mcp',
      pathEnv: ['.', 'node_modules/.bin', '/home/dev/.local/bin'].join(
        path.delimiter
      ),
    });
    expect(spec).toEqual({
      command: '/home/dev/.local/bin/relay-mcp',
      args: [],
    });

    // With only relative entries there is no mountable facade at all.
    expect(
      resolveRelayMcpLaunch({
        moduleUrl: PACKAGE_MODULE,
        execPath: '/usr/bin/node',
        exists: () => false,
        isExecutableFile: () => true,
        pathEnv: ['', '.', 'bin'].join(path.delimiter),
      })
    ).toBeUndefined();
  });

  it('resolves to nothing rather than a path that does not exist', () => {
    // An unbuilt checkout is a normal state. Callers mount nothing; they must
    // never point a provider at a facade that cannot start.
    expect(
      resolveRelayMcpLaunch({
        moduleUrl: SOURCE_MODULE,
        execPath: '/usr/bin/node',
        exists: () => false,
        isExecutableFile: () => false,
        pathEnv: '/usr/bin',
      })
    ).toBeUndefined();
    expect(
      resolveRelayMcpLaunch({
        moduleUrl: SOURCE_MODULE,
        execPath: '/usr/bin/node',
        exists: () => false,
        isExecutableFile: () => false,
        pathEnv: undefined,
      })
    ).toBeUndefined();
  });

  it('carries a command and arguments and nothing that could hold a token', () => {
    const spec = resolveRelayMcpLaunch({
      moduleUrl: PACKAGE_MODULE,
      execPath: '/usr/bin/node',
      exists: () => true,
      isExecutableFile: () => false,
      pathEnv: '/usr/bin',
    });
    expect(Object.keys(spec ?? {}).sort()).toEqual(['args', 'command']);
  });

  it('resolves this checkout to a real executable facade when one is built', () => {
    const spec = relayMcpLaunchSpec();
    // A source checkout without `npm run build` legitimately has no facade.
    if (!spec) return;
    expect(spec.command.length).toBeGreaterThan(0);
    expect(relayMcpLaunchSpec()).toBe(spec); // memoized
  });
});
