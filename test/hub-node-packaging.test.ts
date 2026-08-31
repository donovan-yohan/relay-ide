import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const serviceMocks = vi.hoisted(() => ({
  install: vi.fn(),
  uninstall: vi.fn(),
  getServicePaths: vi.fn(() => ({
    servicePath: '/tmp/relay-ide-test-service',
    logDir: '/tmp/relay-ide-test-config/logs',
    label: 'relay-ide-test',
  })),
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

const serverStartMocks = vi.hoisted(() => ({
  imported: vi.fn(),
}));

vi.mock('../server/service.js', () => ({
  CONFIG_DIR: '/tmp/relay-ide-test-config',
  install: serviceMocks.install,
  uninstall: serviceMocks.uninstall,
  getServicePaths: serviceMocks.getServicePaths,
  status: serviceMocks.status,
}));

vi.mock('../server/logger.js', () => ({
  createLogger: () => loggerMocks,
}));

vi.mock('../server/index.js', () => {
  serverStartMocks.imported();
  return {};
});

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
  serviceMocks.getServicePaths.mockClear();
  serviceMocks.status.mockClear();
  loggerMocks.info.mockClear();
  loggerMocks.error.mockClear();
  serverStartMocks.imported.mockClear();

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

function resetCliLogDir(): void {
  fs.rmSync('/tmp/relay-ide-test-config', { recursive: true, force: true });
}

function writeHubConfig(
  pathName = '/tmp/relay-ide-test-config/config.json'
): string {
  fs.mkdirSync(path.dirname(pathName), { recursive: true });
  fs.writeFileSync(pathName, JSON.stringify({ port: 3456 }));
  return pathName;
}

function sampleHubNode(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    nodeId: 'node_alpha',
    displayName: 'Alpha MacBook',
    hostname: 'alpha.local',
    platform: 'darwin',
    arch: 'arm64',
    relayVersion: '0.1.0',
    protocolVersion: '1.0',
    status: 'online',
    connection: { route: 'reverse-link', status: 'connected' },
    trust: { state: 'trusted', level: 'standard' },
    credentialState: 'active',
    version: {
      state: 'compatible',
      nodeProtocolVersion: '1.0',
      hubProtocolVersion: '1.0',
    },
    capabilities: {
      totals: { available: 3, degraded: 0, unavailable: 0, unknown: 0 },
      core: {
        shell: 'available',
        git: 'available',
        browserAutomation: 'unknown',
        clipboardImage: 'unknown',
        ssh: 'unknown',
        tailscale: 'unknown',
      },
      terminalBackends: { 'relay-pty': 'available' },
      agents: { claude: 'available' },
      serviceManager: 'launchd',
      wsl: false,
      sessionResume: 'canonical-emulator',
    },
    createdAt: '2026-01-01T00:00:00.000Z',
    pairedAt: '2026-01-01T00:00:00.000Z',
    lastSeenAt: '2026-01-01T00:00:10.000Z',
    credentialId: 'cred_alpha',
    ...overrides,
  };
}

interface FetchFixture {
  pathName: string;
  status?: number;
  body: unknown;
}

function stubHubFetch(fixtures: FetchFixture[]): string[] {
  const paths: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: URL | RequestInfo) => {
      const url = new URL(String(input));
      const fixture =
        fixtures.find(
          (candidate) => candidate.pathName === `${url.pathname}${url.search}`
        ) ?? fixtures.find((candidate) => candidate.pathName === url.pathname);
      paths.push(`${url.pathname}${url.search}`);
      if (!fixture) {
        return new Response(
          JSON.stringify({
            error: { code: 'NOT_FOUND', message: 'missing fixture' },
          }),
          {
            status: 404,
            headers: { 'content-type': 'application/json' },
          }
        );
      }
      return new Response(JSON.stringify(fixture.body), {
        status: fixture.status ?? 200,
        headers: { 'content-type': 'application/json' },
      });
    })
  );
  return paths;
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
      'Run the Relay hub web server (same as bare relay-ide)'
    );
    expect(cliSource).toContain(
      'node               Manage relay-node pairing and diagnostics'
    );
    expect(cliSource).toContain('--allow-degraded');
    expect(bootstrapDoc).toContain('run the web server as `relay-ide hub`');
    expect(bootstrapDoc).toContain('relay-ide node install');
  });

  it('documents and forwards --allow-degraded before hub startup', async () => {
    const previous = process.env['RELAY_IDE_ALLOW_DEGRADED'];
    const cliSource = readRepoFile('bin/relay-ide.ts');
    const configPath = writeHubConfig();
    delete process.env['RELAY_IDE_ALLOW_DEGRADED'];

    try {
      const bareResult = await runCli([
        '--allow-degraded',
        '--config',
        configPath,
      ]);
      expect(bareResult.exitCode).toBeUndefined();
      expect(process.env['RELAY_IDE_ALLOW_DEGRADED']).toBe('1');
      expect(serverStartMocks.imported).toHaveBeenCalledTimes(1);

      delete process.env['RELAY_IDE_ALLOW_DEGRADED'];
      const hubResult = await runCli([
        'hub',
        '--allow-degraded',
        '--config',
        configPath,
      ]);
      expect(hubResult.exitCode).toBeUndefined();
      expect(process.env['RELAY_IDE_ALLOW_DEGRADED']).toBe('1');
      expect(
        cliSource.indexOf("process.env['RELAY_IDE_ALLOW_DEGRADED'] = '1'")
      ).toBeLessThan(cliSource.indexOf("await import('../server/index.js')"));

      process.env['RELAY_IDE_ALLOW_DEGRADED'] = 'already-set';
      const envOptInResult = await runCli(['--config', configPath]);
      expect(envOptInResult.exitCode).toBeUndefined();
      expect(process.env['RELAY_IDE_ALLOW_DEGRADED']).toBe('already-set');

      const helpResult = await runCli(['--help']);
      expect(helpResult.exitCode).toBe(0);
      expect(loggerMocks.info).toHaveBeenCalledWith(
        expect.stringContaining(
          '--allow-degraded   Permit the hub to start with failed persistence stores'
        )
      );
    } finally {
      resetCliLogDir();
      if (previous === undefined)
        delete process.env['RELAY_IDE_ALLOW_DEGRADED'];
      else process.env['RELAY_IDE_ALLOW_DEGRADED'] = previous;
    }
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
    const bgFallbackMatch = hubSource.match(
      /hubArgs\.includes\('--bg'\)\s*&&\s*\(!subCommand\s*\|\|\s*subCommand\.startsWith\('-'\)\)/
    );
    const bgFallbackIndex = bgFallbackMatch?.index ?? -1;

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

    const bgFallbackMatch = hubSource.match(
      /hubArgs\.includes\('--bg'\)\s*&&\s*\(!subCommand\s*\|\|\s*subCommand\.startsWith\('-'\)\)/
    );
    const bgFallbackIndex = bgFallbackMatch?.index ?? -1;
    const foregroundHubIndex = hubSource.indexOf(
      "} else if (!subCommand || subCommand.startsWith('-')) {",
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

  it('prints a useful hub nodes table and keeps --json parity', async () => {
    resetCliLogDir();
    const configPath = writeHubConfig();
    const oldToken = process.env['RELAY_IDE_BROWSER_TOKEN'];
    process.env['RELAY_IDE_BROWSER_TOKEN'] = 'browser-secret-token';
    const node = sampleHubNode({
      debug: {
        authHeader: 'Bearer upstream-bearer-secret',
        token: 'node-token-secret',
        pin: '123456',
        pairToken: 'pair_node_secret',
        password: 'password-secret',
        secret: 'secret_should-not-log',
      },
    });
    const requests = stubHubFetch([
      { pathName: '/nodes', body: { nodes: [node] } },
    ]);
    let stdout = '';
    const stdoutSpy = vi
      .spyOn(globalThis.console, 'log')
      .mockImplementation((message?: unknown) => {
        stdout += `${String(message ?? '')}\n`;
      });

    try {
      const tableResult = await runCli([
        'hub',
        'nodes',
        '--config',
        configPath,
      ]);
      expect(tableResult.exitCode).toBe(0);
      expect(loggerMocks.info).toHaveBeenCalledWith(
        expect.stringContaining('STATUS')
      );
      expect(loggerMocks.info).toHaveBeenCalledWith(
        expect.stringContaining('node_alpha')
      );
      expect(loggerMocks.info).toHaveBeenCalledWith(
        expect.stringContaining('pty:available')
      );

      loggerMocks.info.mockClear();
      const jsonResult = await runCli([
        'hub',
        'nodes',
        '--json',
        '--config',
        configPath,
      ]);
      expect(jsonResult.exitCode).toBe(0);
      const payload = JSON.parse(stdout) as {
        count: number;
        nodes: Array<Record<string, unknown>>;
      };
      const parsedNode = payload.nodes[0] as {
        debug?: Record<string, unknown>;
      };
      expect(payload.count).toBe(1);
      expect(payload.nodes[0]?.['nodeId']).toBe('node_alpha');
      expect(parsedNode.debug).toMatchObject({
        authHeader: 'Bearer …redacted',
        token: '…redacted',
        pin: '…redacted',
        pairToken: '…redacted',
        password: '…redacted',
        secret: '…redacted',
      });
      expect(stdout).not.toContain('browser-secret-token');
      expect(stdout).not.toContain('upstream-bearer-secret');
      expect(stdout).not.toContain('node-token-secret');
      expect(stdout).not.toContain('pair_node_secret');
      expect(stdout).not.toContain('password-secret');
      expect(stdout).not.toContain('secret_should-not-log');
      expect(requests).toEqual(['/nodes', '/nodes']);
    } finally {
      stdoutSpy.mockRestore();
      vi.unstubAllGlobals();
      resetCliLogDir();
      if (oldToken === undefined) delete process.env['RELAY_IDE_BROWSER_TOKEN'];
      else process.env['RELAY_IDE_BROWSER_TOKEN'] = oldToken;
    }
  });

  it('reports missing config/auth and hub unreachable as typed hub doctor failures', async () => {
    resetCliLogDir();
    const oldToken = process.env['RELAY_IDE_BROWSER_TOKEN'];
    delete process.env['RELAY_IDE_BROWSER_TOKEN'];
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('connection refused token=super-secret');
      })
    );
    let stdout = '';
    const stdoutSpy = vi
      .spyOn(globalThis.console, 'log')
      .mockImplementation((message?: unknown) => {
        stdout += `${String(message ?? '')}\n`;
      });

    try {
      const result = await runCli(['hub', 'doctor', '--json']);
      expect(result.exitCode).toBe(1);
      const payload = JSON.parse(stdout) as {
        ok: boolean;
        checks: Array<{ reason?: string }>;
      };
      expect(payload.ok).toBe(false);
      expect(payload.checks.map((check) => check.reason)).toEqual(
        expect.arrayContaining([
          'CONFIG_MISSING',
          'AUTH_TOKEN_MISSING',
          'HUB_UNREACHABLE',
          'CHECK_SKIPPED',
        ])
      );
      expect(stdout).not.toContain('super-secret');
    } finally {
      stdoutSpy.mockRestore();
      vi.unstubAllGlobals();
      resetCliLogDir();
      if (oldToken === undefined) delete process.env['RELAY_IDE_BROWSER_TOKEN'];
      else process.env['RELAY_IDE_BROWSER_TOKEN'] = oldToken;
    }
  });

  it('bounds hub doctor probes that connect but never answer', async () => {
    resetCliLogDir();
    const configPath = writeHubConfig();
    const oldToken = process.env['RELAY_IDE_BROWSER_TOKEN'];
    delete process.env['RELAY_IDE_BROWSER_TOKEN'];
    vi.useFakeTimers();
    const fetchMock = vi.fn((_input: URL | RequestInfo, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        expect(signal).toBeInstanceOf(AbortSignal);
        signal?.addEventListener(
          'abort',
          () => {
            const error = new Error(
              'abort should not leak token=timeout-secret'
            );
            error.name = 'AbortError';
            reject(error);
          },
          { once: true }
        );
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    let stdout = '';
    const stdoutSpy = vi
      .spyOn(globalThis.console, 'log')
      .mockImplementation((message?: unknown) => {
        stdout += `${String(message ?? '')}\n`;
      });

    try {
      const resultPromise = runCli([
        'hub',
        'doctor',
        '--json',
        '--config',
        configPath,
      ]);
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
      await vi.advanceTimersByTimeAsync(2500);
      const result = await resultPromise;
      expect(result.exitCode).toBe(1);
      const payload = JSON.parse(stdout) as {
        ok: boolean;
        checks: Array<{ name: string; reason?: string; message: string }>;
      };
      const reachability = payload.checks.find(
        (check) => check.name === 'hub.reachable'
      );
      expect(payload.ok).toBe(false);
      expect(reachability).toMatchObject({
        reason: 'HUB_UNREACHABLE',
        message: expect.stringContaining('timed out after 2500ms'),
      });
      expect(stdout).not.toContain('timeout-secret');
    } finally {
      stdoutSpy.mockRestore();
      vi.unstubAllGlobals();
      vi.useRealTimers();
      resetCliLogDir();
      if (oldToken === undefined) delete process.env['RELAY_IDE_BROWSER_TOKEN'];
      else process.env['RELAY_IDE_BROWSER_TOKEN'] = oldToken;
    }
  });

  it('reports unauthenticated degraded persistence health as a typed hub doctor failure', async () => {
    resetCliLogDir();
    const configPath = writeHubConfig();
    const oldToken = process.env['RELAY_IDE_BROWSER_TOKEN'];
    process.env['RELAY_IDE_BROWSER_TOKEN'] = 'browser-secret-token';
    const fetchMock = vi.fn(
      async (input: URL | RequestInfo, _init?: RequestInit) => {
        const pathname = new URL(String(input)).pathname;
        if (pathname === '/version') {
          return new Response(JSON.stringify({ version: '0.1.0' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (pathname === '/healthz') {
          return new Response(
            JSON.stringify({
              status: 'degraded',
              lagMs: 3,
              rss: 1024,
              disabledStores: ['channelMessages', 'workContexts'],
            }),
            {
              status: 503,
              headers: { 'content-type': 'application/json' },
            }
          );
        }
        return new Response(JSON.stringify({ nodes: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
    );
    vi.stubGlobal('fetch', fetchMock);
    let stdout = '';
    const stdoutSpy = vi
      .spyOn(globalThis.console, 'log')
      .mockImplementation((message?: unknown) => {
        stdout += `${String(message ?? '')}\n`;
      });

    try {
      const result = await runCli([
        'hub',
        'doctor',
        '--json',
        '--config',
        configPath,
      ]);
      expect(result.exitCode).toBe(1);
      const payload = JSON.parse(stdout) as {
        ok: boolean;
        checks: Array<{
          name: string;
          reason?: string;
          details?: { status?: string; disabledStores?: string[] };
        }>;
      };
      const persistence = payload.checks.find(
        (check) => check.name === 'persistence.health'
      );
      expect(payload.ok).toBe(false);
      expect(persistence).toMatchObject({
        reason: 'PERSISTENCE_DEGRADED',
        details: {
          status: 'degraded',
          disabledStores: ['channelMessages', 'workContexts'],
        },
      });
      const healthCall = fetchMock.mock.calls.find(
        ([input]) => new URL(String(input)).pathname === '/healthz'
      );
      expect(healthCall?.[1]).toMatchObject({
        headers: { 'x-relay-cli-gateway': 'v1' },
      });
      expect(
        (healthCall?.[1] as RequestInit | undefined)?.headers
      ).not.toHaveProperty('Authorization');
    } finally {
      stdoutSpy.mockRestore();
      vi.unstubAllGlobals();
      resetCliLogDir();
      if (oldToken === undefined) delete process.env['RELAY_IDE_BROWSER_TOKEN'];
      else process.env['RELAY_IDE_BROWSER_TOKEN'] = oldToken;
    }
  });

  it('keeps lag-only health degradation as a hub health failure', async () => {
    resetCliLogDir();
    const configPath = writeHubConfig();
    const oldToken = process.env['RELAY_IDE_BROWSER_TOKEN'];
    process.env['RELAY_IDE_BROWSER_TOKEN'] = 'browser-secret-token';
    stubHubFetch([
      { pathName: '/version', body: { version: '0.1.0' } },
      {
        pathName: '/healthz',
        status: 503,
        body: { status: 'degraded', lagMs: 125, rss: 2048 },
      },
      { pathName: '/nodes', body: { nodes: [] } },
    ]);
    let stdout = '';
    const stdoutSpy = vi
      .spyOn(globalThis.console, 'log')
      .mockImplementation((message?: unknown) => {
        stdout += `${String(message ?? '')}\n`;
      });

    try {
      const result = await runCli([
        'hub',
        'doctor',
        '--json',
        '--config',
        configPath,
      ]);
      expect(result.exitCode).toBe(1);
      const payload = JSON.parse(stdout) as {
        checks: Array<{
          name: string;
          reason?: string;
          details?: { status?: number; body?: Record<string, unknown> };
        }>;
      };
      expect(
        payload.checks.find((check) => check.name === 'persistence.health')
      ).toBeUndefined();
      expect(
        payload.checks.find((check) => check.name === 'hub.health')
      ).toMatchObject({
        status: 'fail',
        reason: 'HUB_HTTP_ERROR',
        details: {
          status: 503,
          body: { status: 'degraded', lagMs: 125, rss: 2048 },
        },
      });
    } finally {
      stdoutSpy.mockRestore();
      vi.unstubAllGlobals();
      resetCliLogDir();
      if (oldToken === undefined) delete process.env['RELAY_IDE_BROWSER_TOKEN'];
      else process.env['RELAY_IDE_BROWSER_TOKEN'] = oldToken;
    }
  });

  it('reports node availability, version, capability, and log support diagnostics', async () => {
    resetCliLogDir();
    const configPath = writeHubConfig();
    const oldToken = process.env['RELAY_IDE_BROWSER_TOKEN'];
    process.env['RELAY_IDE_BROWSER_TOKEN'] = 'browser-secret-token';
    const baseCapabilities = sampleHubNode()['capabilities'] as {
      core: Record<string, string>;
    };
    const nodes = [
      sampleHubNode({
        nodeId: 'node_stale',
        displayName: 'Stale Node',
        status: 'stale',
      }),
      sampleHubNode({
        nodeId: 'node_skew',
        displayName: 'Skew Node',
        version: {
          state: 'version-skew',
          nodeProtocolVersion: '0.9',
          hubProtocolVersion: '1.0',
        },
      }),
      sampleHubNode({
        nodeId: 'node_no_relay_pty',
        displayName: 'No Relay PTY Node',
        capabilities: {
          ...baseCapabilities,
          terminalBackends: { 'relay-pty': 'unavailable' },
        },
      }),
      sampleHubNode({ nodeId: 'node_no_logs', displayName: 'No Logs Node' }),
    ];
    stubHubFetch([
      { pathName: '/version', body: { version: '0.1.0' } },
      { pathName: '/healthz', body: { status: 'ok', lagMs: 0, rss: 0 } },
      { pathName: '/nodes', body: { nodes } },
      {
        pathName: '/hub/nodes/node_no_relay_pty/logs?lines=0',
        body: { log: { message: 'ok' } },
      },
      {
        pathName: '/hub/nodes/node_no_logs/logs?lines=0',
        status: 404,
        body: {
          error: {
            code: 'NODE_UNSUPPORTED',
            message: 'logs.tail missing',
            authHeader: 'Bearer upstream-doctor-bearer-secret',
            token: 'node-secret',
            pin: '654321',
            pairToken: 'pair_doctor_secret',
            password: 'doctor-password-secret',
            secret: 'secret_doctor_should-not-log',
          },
        },
      },
    ]);
    let stdout = '';
    const stdoutSpy = vi
      .spyOn(globalThis.console, 'log')
      .mockImplementation((message?: unknown) => {
        stdout += `${String(message ?? '')}\n`;
      });

    try {
      const result = await runCli([
        'hub',
        'doctor',
        '--json',
        '--config',
        configPath,
      ]);
      expect(result.exitCode).toBe(1);
      const payload = JSON.parse(stdout) as {
        checks: Array<{
          reason?: string;
          details?: { body?: { error?: Record<string, unknown> } };
        }>;
      };
      const reasons = payload.checks.map((check) => check.reason);
      const missingLogError = payload.checks.find(
        (check) => check.reason === 'MISSING_LOG_SUPPORT'
      )?.details?.body?.error;
      expect(reasons).toEqual(
        expect.arrayContaining([
          'NODE_STALE',
          'VERSION_SKEW',
          'UNSUPPORTED_CAPABILITY',
          'MISSING_LOG_SUPPORT',
        ])
      );
      expect(missingLogError).toMatchObject({
        authHeader: 'Bearer …redacted',
        token: '…redacted',
        pin: '…redacted',
        pairToken: '…redacted',
        password: '…redacted',
        secret: '…redacted',
      });
      expect(stdout).not.toContain('browser-secret-token');
      expect(stdout).not.toContain('upstream-doctor-bearer-secret');
      expect(stdout).not.toContain('node-secret');
      expect(stdout).not.toContain('pair_doctor_secret');
      expect(stdout).not.toContain('doctor-password-secret');
      expect(stdout).not.toContain('secret_doctor_should-not-log');
    } finally {
      stdoutSpy.mockRestore();
      vi.unstubAllGlobals();
      resetCliLogDir();
      if (oldToken === undefined) delete process.env['RELAY_IDE_BROWSER_TOKEN'];
      else process.env['RELAY_IDE_BROWSER_TOKEN'] = oldToken;
    }
  });

  it('tails local hub logs with --lines without platform log commands', async () => {
    resetCliLogDir();
    const logDir = '/tmp/relay-ide-test-config/logs';
    fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(
      path.join(logDir, 'relay-ide.log'),
      ['first', 'second', 'third'].join('\n') + '\n'
    );
    let stdout = '';
    const stdoutSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: string | Uint8Array) => {
        stdout += String(chunk);
        return true;
      });

    try {
      const result = await runCli(['hub', 'logs', '--lines', '2']);

      expect(result.exitCode).toBe(0);
      expect(stdout).toBe('second\nthird\n');
      expect(loggerMocks.info).not.toHaveBeenCalledWith(
        expect.stringContaining('journalctl')
      );
      expect(serviceMocks.getServicePaths).toHaveBeenCalled();
    } finally {
      stdoutSpy.mockRestore();
      resetCliLogDir();
    }
  });

  it('reports missing local node logs from the CLI without systemd or journalctl', async () => {
    resetCliLogDir();

    const result = await runCli(['node', 'logs']);

    expect(result.exitCode).toBe(0);
    expect(loggerMocks.info).toHaveBeenCalledWith(
      expect.stringContaining('No local Relay node log files were found')
    );
    expect(loggerMocks.info).not.toHaveBeenCalledWith(
      expect.stringContaining('journalctl')
    );
    expect(loggerMocks.info).not.toHaveBeenCalledWith(
      expect.stringContaining('systemctl')
    );
  });

  it('rejects unknown node install --service values before pairing or service install', () => {
    const cliSource = readRepoFile('bin/relay-ide.ts');
    const serviceModeDefinitionIndex = cliSource.indexOf(
      'type RequestedNodeServiceMode'
    );
    const serviceModeParserIndex = cliSource.indexOf(
      'function parseNodeServiceMode',
      serviceModeDefinitionIndex
    );
    const serviceModeUsageMatch = cliSource
      .slice(serviceModeParserIndex)
      .match(
        /const serviceMode = parseNodeServiceMode\(\s*getNodeArg\(nodeArgs,\s*'--service'\)\s*\?\?\s*'auto'\s*\);/
      );
    const serviceModeUsageIndex = serviceModeUsageMatch
      ? serviceModeParserIndex + (serviceModeUsageMatch.index ?? 0)
      : -1;
    const pairNodeIndex = cliSource.indexOf(
      "await pairNode(nodeArgs, 'install');",
      serviceModeUsageIndex
    );
    const validationSource = cliSource.slice(
      serviceModeDefinitionIndex,
      pairNodeIndex
    );

    expect(serviceModeDefinitionIndex).toBeGreaterThanOrEqual(0);
    expect(serviceModeParserIndex).toBeGreaterThan(serviceModeDefinitionIndex);
    expect(serviceModeUsageIndex).toBeGreaterThan(serviceModeParserIndex);
    expect(validationSource).toContain('auto');
    expect(validationSource).toContain('launchd');
    expect(validationSource).toContain('systemd-user');
    expect(validationSource).toContain('wsl-systemd');
    expect(validationSource).toContain('manual');
    expect(validationSource).toContain('requestedNodeServiceModes.includes');
    expect(validationSource).toContain('Invalid --service');
    expect(validationSource).toContain('process.exit(1)');
  });

  it('uses USERNAME as the Windows CLI actor fallback before relay-ide-cli', () => {
    const cliSource = readRepoFile('bin/relay-ide.ts');
    const actorFallbackStart = cliSource.indexOf(
      "getNodeArg(nodeArgs, '--actor-id')"
    );
    const actorFallbackEnd = cliSource.indexOf(
      'const body: Record<string, unknown> = {};',
      actorFallbackStart
    );
    const actorFallbackSource = cliSource.slice(
      actorFallbackStart,
      actorFallbackEnd
    );

    expect(actorFallbackStart).toBeGreaterThanOrEqual(0);
    expect(actorFallbackEnd).toBeGreaterThan(actorFallbackStart);
    expect(actorFallbackSource).toMatch(
      /process\.env\['RELAY_IDE_ACTOR_ID'\][\s\S]*process\.env\['USER'\][\s\S]*process\.env\['USERNAME'\][\s\S]*'relay-ide-cli'/
    );
  });
});
