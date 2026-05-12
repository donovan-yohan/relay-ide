import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const serviceMocks = vi.hoisted(() => ({
  install: vi.fn(),
  uninstall: vi.fn(),
  status: vi.fn(() => ({
    installed: false,
    running: false,
    manager: {
      label: 'test service manager',
      kind: 'manual',
      message: 'mocked service manager',
      installHint: 'install hint',
      uninstallHint: 'uninstall hint',
      caveats: [],
    },
  })),
}));

const loggerMocks = vi.hoisted(() => ({
  info: vi.fn(),
  error: vi.fn(),
}));

vi.mock('../server/service.js', () => ({
  CONFIG_DIR: '/tmp/relay-ide-test-config',
  install: serviceMocks.install,
  uninstall: serviceMocks.uninstall,
  status: serviceMocks.status,
}));

vi.mock('../server/logger.js', () => ({
  createLogger: () => loggerMocks,
}));

type CliExitError = Error & { code: number; relayCliExit: true };

function isCliExitError(error: unknown): error is CliExitError {
  return Boolean(
    error &&
    typeof error === 'object' &&
    'relayCliExit' in error &&
    (error as { relayCliExit: unknown }).relayCliExit === true
  );
}

async function runCli(
  args: string[]
): Promise<{ exitCode: number | undefined }> {
  const originalArgv = process.argv;
  serviceMocks.install.mockClear();
  serviceMocks.uninstall.mockClear();
  serviceMocks.status.mockClear();
  loggerMocks.info.mockClear();
  loggerMocks.error.mockClear();

  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((
    code?: number | string | null
  ) => {
    const exitCode = typeof code === 'number' ? code : Number(code ?? 0);
    const exitError = new Error(`process.exit(${exitCode})`) as CliExitError;
    exitError.code = exitCode;
    exitError.relayCliExit = true;
    throw exitError;
  }) as never);

  process.argv = ['node', 'relay-ide', ...args];
  vi.resetModules();

  try {
    await import('../bin/relay-ide.ts');
    return { exitCode: undefined };
  } catch (error) {
    if (isCliExitError(error)) return { exitCode: error.code };
    throw error;
  } finally {
    process.argv = originalArgv;
    exitSpy.mockRestore();
  }
}

function readRepoFile(relativePath: string): string {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

describe('hub/node packaging decision', () => {
  it('keeps hub and node roles in the single relay-ide npm package', () => {
    const packageJson = JSON.parse(readRepoFile('package.json')) as {
      name: string;
      bin: Record<string, string>;
    };
    const packagingDoc = readRepoFile('docs/RELAY_HUB_NODE_PACKAGING.md');
    const deploymentDoc = readRepoFile('docs/references/deployment.md');

    expect(packageJson.name).toBe('relay-ide');
    expect(packageJson.bin['relay-ide']).toBe('dist/bin/relay-ide.js');
    expect(packageJson.bin['relay-ide-hub']).toBeUndefined();
    expect(packageJson.bin['relay-ide-node']).toBeUndefined();
    expect(packagingDoc).toContain('single existing `relay-ide` npm package');
    expect(packagingDoc).toContain('No `relay-ide-hub`, `relay-ide-node`');
    expect(deploymentDoc).toContain(
      'there is no separate `relay-ide-node` package'
    );
  });

  it('documents the rationale, case against, publishing channel, and command contract', () => {
    const packagingDoc = readRepoFile('docs/RELAY_HUB_NODE_PACKAGING.md');

    expect(packagingDoc).toContain('## Rationale');
    expect(packagingDoc).toContain('## The case against');
    expect(packagingDoc).toContain('npm install -g relay-ide@nightly');
    expect(packagingDoc).toContain('relay-ide hub install');
    expect(packagingDoc).toContain('relay-ide hub --bg');
    expect(packagingDoc).toContain('relay-ide node install');
    expect(packagingDoc).toContain('relay-ide update');
    expect(packagingDoc).toContain(
      'does not start or maintain a persistent `/hub/node-link`'
    );
  });

  it('keeps CLI help and bootstrap docs aligned on hub/node commands', () => {
    const cliSource = readRepoFile('bin/relay-ide.ts');
    const packagingDoc = readRepoFile('docs/RELAY_HUB_NODE_PACKAGING.md');
    const bootstrapDoc = readRepoFile('docs/RELAY_NODE_BOOTSTRAP.md');

    for (const command of [
      'relay-ide hub',
      'relay-ide hub install',
      'relay-ide hub status',
      'relay-ide hub logs',
      'relay-ide node connect',
      'relay-ide node install',
      'relay-ide node status',
      'relay-ide node logs',
      'relay-ide node doctor',
    ]) {
      expect(packagingDoc).toContain(command);
    }

    expect(cliSource).toContain(
      'hub                Run the Relay hub web server'
    );
    expect(cliSource).toContain(
      'node               Manage relay-node pairing and diagnostics'
    );
    expect(bootstrapDoc).toContain('run the web server as `relay-ide hub`');
    expect(bootstrapDoc).toContain('relay-ide node install');
  });

  it('keeps explicit hub subcommands ahead of the --bg shorthand fallback', () => {
    const cliSource = readRepoFile('bin/relay-ide.ts');
    const hubStart = cliSource.indexOf("if (command === 'hub')");
    const hubEnd = cliSource.indexOf("if (command === 'node')", hubStart);
    const hubSource = cliSource.slice(hubStart, hubEnd);

    const installIndex = hubSource.indexOf("subCommand === 'install'");
    const uninstallIndex = hubSource.indexOf("subCommand === 'uninstall'");
    const statusIndex = hubSource.indexOf("subCommand === 'status'");
    const logsIndex = hubSource.indexOf("subCommand === 'logs'");
    const bgFallbackIndex = hubSource.indexOf(
      "hubArgs.includes('--bg') && (!subCommand || subCommand.startsWith('-'))"
    );

    expect(installIndex).toBeGreaterThanOrEqual(0);
    expect(uninstallIndex).toBeGreaterThan(installIndex);
    expect(statusIndex).toBeGreaterThan(uninstallIndex);
    expect(logsIndex).toBeGreaterThan(statusIndex);
    expect(bgFallbackIndex).toBeGreaterThan(logsIndex);
  });

  it('does not route unknown hub subcommands with --bg through service install', () => {
    const cliSource = readRepoFile('bin/relay-ide.ts');
    const hubStart = cliSource.indexOf("if (command === 'hub')");
    const hubEnd = cliSource.indexOf("if (command === 'node')", hubStart);
    const hubSource = cliSource.slice(hubStart, hubEnd);

    const bgFallbackIndex = hubSource.indexOf(
      "hubArgs.includes('--bg') && (!subCommand || subCommand.startsWith('-'))"
    );
    const foregroundHubIndex = hubSource.indexOf(
      "!subCommand || subCommand.startsWith('-')",
      bgFallbackIndex + 1
    );
    const usageIndex = hubSource.indexOf(
      'Usage: relay-ide hub',
      foregroundHubIndex
    );

    expect(bgFallbackIndex).toBeGreaterThanOrEqual(0);
    expect(foregroundHubIndex).toBeGreaterThan(bgFallbackIndex);
    expect(usageIndex).toBeGreaterThan(foregroundHubIndex);
    expect(hubSource).not.toContain("} else if (hubArgs.includes('--bg')) {");
  });

  it('rejects an unknown hub subcommand with --bg at runtime before service install', async () => {
    const result = await runCli(['hub', 'unstal', '--bg']);

    expect(result.exitCode).toBe(1);
    expect(serviceMocks.install).not.toHaveBeenCalled();
    expect(loggerMocks.error).toHaveBeenCalledWith(
      expect.stringContaining('Usage: relay-ide hub')
    );
  });

  it('rejects unknown node install --service values before pairing or service install', () => {
    const cliSource = readRepoFile('bin/relay-ide.ts');
    const serviceModeIndex = cliSource.indexOf(
      "const serviceMode = getNodeArg(nodeArgs, '--service') ?? 'auto';"
    );
    const pairNodeIndex = cliSource.indexOf(
      "await pairNode(nodeArgs, 'install');",
      serviceModeIndex
    );
    const validationSource = cliSource.slice(serviceModeIndex, pairNodeIndex);

    expect(validationSource).toContain('auto');
    expect(validationSource).toContain('launchd');
    expect(validationSource).toContain('systemd-user');
    expect(validationSource).toContain('wsl-systemd');
    expect(validationSource).toContain('manual');
    expect(validationSource).toContain('includes(serviceMode)');
    expect(validationSource).toContain('Invalid --service value');
    expect(validationSource).toContain('process.exit(1)');
  });
});
