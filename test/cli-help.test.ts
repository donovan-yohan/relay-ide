import { execFile, execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

const RELAY_BIN = path.resolve('dist/bin/relay-ide.js');

/**
 * #1471: `--help` used to short-circuit to root help no matter which command
 * preceded it, so `relay-ide login --help` and `relay-ide v1 --help` both
 * printed the root page. These run the real built CLI so the assertions cover
 * the shipped dispatch, not a re-implementation of it.
 */
function runHelp(args: string[]): Promise<{ stdout: string; code: number }> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [RELAY_BIN, ...args],
      { encoding: 'utf8', timeout: 15_000 },
      (error, stdout, stderr) => {
        const code =
          error && typeof (error as { code?: unknown }).code === 'number'
            ? ((error as { code: number }).code as number)
            : 0;
        if (error && code === 0) {
          reject(new Error(`CLI failed: ${stderr || stdout}`));
          return;
        }
        resolve({ stdout, code });
      }
    );
  });
}

beforeAll(() => {
  execFileSync('npm', ['run', 'build:server'], {
    cwd: path.resolve('.'),
    env: process.env,
    stdio: 'inherit',
  });
}, 60_000);

describe('relay-ide --help dispatch', () => {
  it('advertises login, logout, and v1 on the root help page', async () => {
    const { stdout, code } = await runHelp(['--help']);

    expect(code).toBe(0);
    expect(stdout).toContain('Usage: relay-ide [options]');
    // #1435 shipped `relay-ide login`; root help never listed it.
    expect(stdout).toMatch(/^\s+login /m);
    expect(stdout).toMatch(/^\s+logout /m);
    expect(stdout).toContain("Run 'relay-ide <command> --help'");
  });

  it.each([['--help'], ['-h']])(
    'prints login usage for `login %s` instead of root help',
    async (flag) => {
      const { stdout, code } = await runHelp(['login', flag]);

      expect(code).toBe(0);
      expect(stdout).toContain('Usage: relay-ide login');
      expect(stdout).toContain('relay-ide login status');
      expect(stdout).toContain('--no-browser');
      expect(stdout).not.toContain('Usage: relay-ide [options]');
    }
  );

  it('prints the login page for `logout --help` too', async () => {
    const { stdout } = await runHelp(['logout', '--help']);

    expect(stdout).toContain('Usage: relay-ide login');
    expect(stdout).not.toContain('Usage: relay-ide [options]');
  });

  it('prints the v1 verb list, --json rule, and credential order', async () => {
    const { stdout, code } = await runHelp(['v1', '--help']);

    expect(code).toBe(0);
    expect(stdout).toContain('Usage: relay-ide v1 <command> [options] --json');
    expect(stdout).not.toContain('Usage: relay-ide [options]');
    // #1472: every wired channels verb has to be discoverable, not just post.
    for (const verb of [
      'channels list',
      'channels get',
      'channels create',
      'channels history',
      'channels roster',
      'channels subscribe',
      'channels post',
      'workspace-topics create',
    ]) {
      expect(stdout).toContain(verb);
    }
    expect(stdout).toContain('requires --json');
    expect(stdout).toContain('Credential resolution, in order:');
    expect(stdout).toContain('RELAY_IDE_BROWSER_TOKEN');
    expect(stdout).toContain('relay-ide login');
  });

  it('scopes `v1 <group> --help` to that group', async () => {
    const { stdout } = await runHelp(['v1', 'channels', '--help']);

    expect(stdout).toContain('channels history');
    expect(stdout).not.toContain('sessions attach');
  });

  it('falls back to root help for a command with no dedicated page', async () => {
    const { stdout } = await runHelp(['manifest', '--help']);

    expect(stdout).toContain('Usage: relay-ide [options]');
  });

  it('does not treat an inherited Object member as a help topic', async () => {
    const { stdout } = await runHelp(['toString', '--help']);

    expect(stdout).toContain('Usage: relay-ide [options]');
    expect(stdout).not.toContain('[object Object]');
  });
});

describe('v1 usage line stays in sync with the dispatch table', () => {
  const source = readFileSync(path.resolve('bin/relay-ide.ts'), 'utf8');

  it('advertises exactly the groups the gateway dispatch table handles', () => {
    const usageBlock = source.slice(
      source.indexOf('const GATEWAY_USAGE_GROUPS'),
      source.indexOf('function gatewayUsageVerbs')
    );
    const advertised = new Set(
      [...usageBlock.matchAll(/^ {2}\[\s*'([a-z-]+)',/gm)].map(
        (m) => m[1] as string
      )
    );
    const table = source.slice(
      source.indexOf('const gatewayGroupHandlers'),
      source.indexOf('const groupHandler = top')
    );
    const dispatched = [...table.matchAll(/^\s+'?([a-z-]+)'?:\s*runGateway/gm)]
      .map((m) => m[1] as string)
      .filter((name) => name !== 'contract');

    expect(dispatched.length).toBeGreaterThan(20);
    for (const group of dispatched) {
      expect(advertised).toContain(group);
    }
  });
});
