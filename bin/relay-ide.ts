#!/usr/bin/env node
/* eslint-disable no-console -- CLI entry point, user-facing stdout/stderr output */
import path from 'node:path';
import fs from 'node:fs';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import * as service from '../server/service.js';
import { DEFAULTS, loadConfig } from '../server/config.js';
import { createLogger } from '../server/logger.js';
import { getNodeManifest } from '../server/node-manifest.js';
import {
  BOOTSTRAP_DIAGNOSTICS,
  redactBootstrapSecrets,
} from '../shared/bootstrap-diagnostics.js';
import { RELAY_NODE_LINK_PROTOCOL_VERSION } from '../shared/relay-node-protocol.js';
import type { NodeManifest } from '../shared/node-manifest.js';
import type { Config } from '../server/types.js';
import { createNodeLinkClient } from '../server/node-link-client.js';
import { createNodeLinkPtyHost } from '../server/node-link-pty-host.js';
import { createNodeLinkRpcHost } from '../server/node-link-rpc-host.js';
import { createLocalRelayNode } from '../server/local-node.js';
import { collectLocalRepoInventory } from '../server/repo-inventory.js';

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const logger = createLogger('cli');

function execErrorMessage(err: unknown, fallback: string): string {
  const e = err as { stderr?: string; message?: string };
  return (e.stderr || e.message || fallback).trimEnd();
}

// Parse CLI flags
const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  logger.info(`Usage: relay-ide [options]
       relay-ide <command>

Commands:
  dev [--self-host]  Run backend + Vite frontend with HMR (source checkout)
  update             Update this single relay-ide package from npm
  hub                Run the Relay hub web server (same as bare relay-ide)
    install                           Install/start the hub background service
    uninstall                         Stop and remove the hub background service
    status                            Show hub service status
    logs                              Print platform log commands for the hub service
  install            Back-compat alias for relay-ide hub install
  uninstall          Back-compat alias for relay-ide hub uninstall
  status             Back-compat alias for relay-ide hub status
  manifest           Print local node capability manifest as JSON
  node               Manage relay-node pairing and diagnostics
    status                             Show local node/service status
    logs                               Print platform log commands
    doctor --hub <url>                 Check hub reachability and local node capability
    connect --hub <url> --pair-token <token>
                                       Exchange a pair token and send one heartbeat
    install --hub <url> --pair-token <token> [--service auto|manual|launchd|systemd-user|wsl-systemd|wsl-manual]
                                       Pair the node, then install/start the local Relay-managed service when requested/available
    link --hub <url>                   Open and hold the persistent /hub/node-link reverse WebSocket (foreground)
  worktree           Manage git worktrees (wraps git worktree)
    add [path] [-b branch] [--yolo]   Create worktree and launch Claude
    remove <path>                      Forward to git worktree remove
    list                               Forward to git worktree list
  browser            Open an HTML file in the remote viewer
    <path>             Path to HTML file
  pin                Manage authentication PIN
    reset              Reset the PIN (interactive, requires TTY)

Options:
  --bg               Shortcut: install and start as background service
  --port <port>      Override server port (default: 3456)
  --host <host>      Override bind address (default: 0.0.0.0)
  --config <path>    Path to config.json (default: ~/.config/relay-ide/config.json)
  --compact          With 'manifest': print compact JSON
  --debug-log        Enable SDK event debug logging to ~/.config/relay-ide/debug/
  --yolo             With 'worktree add': pass --dangerously-skip-permissions to Claude
  --version, -v      Show version
  --help, -h         Show this help`);
  process.exit(0);
}

if (args.includes('--version') || args.includes('-v')) {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(__dirname, '../../package.json'), 'utf-8')
  ) as { version: string };
  const sourceTag = describeSourceCheckout();
  console.log(sourceTag ? `${pkg.version} (${sourceTag})` : pkg.version);
  process.exit(0);
}

function describeSourceCheckout(): string | undefined {
  // dist/bin/relay-ide.js -> repo root is two levels up
  const repoRoot = path.resolve(__dirname, '../..');
  const gitDir = path.join(repoRoot, '.git');
  if (!fs.existsSync(gitDir)) return undefined;
  try {
    const head = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: repoRoot,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
    }).trim();
    let dirty = '';
    try {
      const status = execFileSync(
        'git',
        ['status', '--porcelain', '--untracked-files=no'],
        {
          cwd: repoRoot,
          encoding: 'utf-8',
          stdio: ['ignore', 'pipe', 'ignore'],
          timeout: 2000,
        }
      );
      if (status.trim()) dirty = '-dirty';
    } catch {
      /* ignore */
    }
    return `source ${head}${dirty}`;
  } catch {
    return undefined;
  }
}

function getArg(flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

function resolveConfigPath(): string {
  const explicit = getArg('--config');
  if (explicit) return explicit;
  return path.join(service.CONFIG_DIR, 'config.json');
}

function runServiceCommand(fn: () => void): never {
  try {
    fn();
  } catch (e) {
    logger.error((e as Error).message);
    process.exit(1);
  }
  process.exit(0);
}

const command = args[0];
if (command === 'dev') {
  await import('../scripts/dev.js');
  await new Promise(() => {});
}

if (command === 'update') {
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(__dirname, '../../package.json'), 'utf-8')
    ) as { version: string };
    logger.info(`Current version: ${pkg.version}`);
    const configPath = resolveConfigPath();
    let channel = 'stable';
    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as {
        updateChannel?: string;
      };
      if (
        config.updateChannel === 'nightly' ||
        config.updateChannel === 'stable'
      ) {
        channel = config.updateChannel;
      }
    }
    const tag = channel === 'nightly' ? 'nightly' : 'latest';
    logger.info(`Updating relay-ide from ${channel} channel...`);
    await execFileAsync('npm', ['install', '-g', `relay-ide@${tag}`]);
    const updatedPkg = JSON.parse(
      fs.readFileSync(path.join(__dirname, '../../package.json'), 'utf-8')
    ) as { version: string };
    if (updatedPkg.version === pkg.version) {
      logger.info(`Already on the latest version (${pkg.version}).`);
    } else {
      logger.info(`Updated to ${updatedPkg.version}.`);
      if (service.isInstalled()) {
        logger.info('Background service detected — restarting...');
        service.uninstall();
        service.install({
          configPath: resolveConfigPath(),
          port: getArg('--port') ?? String(DEFAULTS.port),
          host: getArg('--host') ?? DEFAULTS.host,
        });
        logger.info('Service restarted.');
      }
    }
  } catch (e) {
    logger.error(`Update failed: ${(e as Error).message}`);
    process.exit(1);
  }
  process.exit(0);
}

if (command === 'manifest') {
  const configPath = resolveConfigPath();
  let config: Pick<Config, 'frameworks'> | undefined;
  if (fs.existsSync(configPath)) {
    try {
      config = loadConfig(configPath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(
        `[cli] Warning: could not load config for framework probes: ${message}\n`
      );
    }
  }

  const manifest = await getNodeManifest(config ? { config } : {});
  console.log(
    JSON.stringify(manifest, null, args.includes('--compact') ? 0 : 2)
  );
  process.exit(0);
}

function getNodeArg(nodeArgs: string[], flag: string): string | undefined {
  const idx = nodeArgs.indexOf(flag);
  if (idx === -1 || idx + 1 >= nodeArgs.length) return undefined;
  return nodeArgs[idx + 1];
}

function serviceLogHints(kind: string, mode: 'hub' | 'node'): string[] {
  if (kind === 'launchd') {
    return ['launchctl print gui/$(id -u)/com.relay-ide'];
  }
  if (kind === 'systemd-user' || kind === 'wsl-systemd') {
    return [
      'systemctl --user status relay-ide',
      'journalctl --user -u relay-ide --no-pager -n 100',
    ];
  }
  if (kind === 'systemd-system') {
    return [
      'sudo systemctl status relay-ide',
      'sudo journalctl -u relay-ide --no-pager -n 100',
    ];
  }
  if (mode === 'hub') {
    return [
      'manual mode has no Relay-managed service logs; run relay-ide hub in the foreground',
    ];
  }
  return [
    'manual mode has no Relay-managed service logs; node connect only pairs credentials and exits',
  ];
}

function printHubStatus(): void {
  const st = service.status();
  logger.info(`Hub service manager: ${st.manager.label} (${st.manager.kind})`);
  logger.info(st.manager.message);
  if (!st.installed) {
    logger.info('Hub service is not installed.');
  } else if (st.running) {
    logger.info('Hub service is installed and running.');
  } else {
    logger.info('Hub service is installed but not running.');
  }
  if (st.manager.statusCommand) {
    logger.info(`Status command: ${st.manager.statusCommand}`);
  }
  logger.info(st.installed ? st.manager.uninstallHint : st.manager.installHint);
  for (const caveat of st.manager.caveats) logger.info(caveat);
}

function printHubLogs(): void {
  const st = service.status();
  logger.info(`Log hints for ${st.manager.label} (${st.manager.kind}):`);
  for (const hint of serviceLogHints(st.manager.kind, 'hub')) logger.info(hint);
}

async function printNodeStatus(): Promise<void> {
  const manifest = await getNodeManifest();
  const st = service.status();
  logger.info(
    `Node host: ${manifest.hostname} (${manifest.platform}/${manifest.arch})`
  );
  logger.info(`Relay version: ${manifest.relayVersion}`);
  logger.info(
    `Service manager: ${manifest.serviceManager.label} (${manifest.serviceManager.kind})`
  );
  logger.info(manifest.serviceManager.message);
  logger.info(`Local service installed: ${st.installed ? 'yes' : 'no'}`);
  logger.info(`Local service running: ${st.running ? 'yes' : 'no'}`);
  for (const caveat of manifest.serviceManager.caveats) logger.info(caveat);
}

async function printNodeLogs(): Promise<void> {
  const manifest = await getNodeManifest();
  logger.info(
    `Log hints for ${manifest.serviceManager.label} (${manifest.serviceManager.kind}):`
  );
  for (const hint of serviceLogHints(manifest.serviceManager.kind, 'node'))
    logger.info(hint);
}

async function runNodeDoctor(hubUrl: string | undefined): Promise<void> {
  const manifest = await getNodeManifest();
  logger.info(
    `Local manifest: ${manifest.hostname} ${manifest.platform}/${manifest.arch}`
  );
  logger.info(`Service manager: ${manifest.serviceManager.kind}`);
  if (!manifest.serviceManager.supported) {
    const diagnostic = BOOTSTRAP_DIAGNOSTICS.find(
      (entry) => entry.code === 'SERVICE_MANAGER_UNSUPPORTED'
    );
    logger.info(`${diagnostic?.code}: ${diagnostic?.meaning}`);
    logger.info(manifest.serviceManager.installHint);
  }
  if (!hubUrl) {
    logger.info('No --hub supplied; skipping hub reachability check.');
    return;
  }
  try {
    const res = await fetch(new URL('/version', hubUrl));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    logger.info(`Hub reachable: ${hubUrl}`);
  } catch (error) {
    const diagnostic = BOOTSTRAP_DIAGNOSTICS.find(
      (entry) => entry.code === 'NODE_CONNECT_FAILED'
    );
    const message = error instanceof Error ? error.message : String(error);
    logger.error(
      redactBootstrapSecrets(
        `${diagnostic?.code}: ${diagnostic?.meaning} (${message})`
      )
    );
    process.exit(1);
  }
}

function nodeEndpoint(hubUrl: string, pathname: string): string {
  return new URL(pathname, hubUrl).toString();
}

type RequestedNodeServiceMode =
  | 'auto'
  | 'manual'
  | 'launchd'
  | 'systemd-user'
  | 'wsl-systemd'
  | 'wsl-manual';
const requestedNodeServiceModes: RequestedNodeServiceMode[] = [
  'auto',
  'manual',
  'launchd',
  'systemd-user',
  'wsl-systemd',
  'wsl-manual',
];

function parseNodeServiceMode(value: string): RequestedNodeServiceMode {
  if (requestedNodeServiceModes.includes(value as RequestedNodeServiceMode))
    return value as RequestedNodeServiceMode;
  logger.error(
    `Invalid --service ${value}. Expected one of: ${requestedNodeServiceModes.join(', ')}`
  );
  process.exit(1);
}

function validateNodeServiceMode(
  manifest: NodeManifest,
  mode: RequestedNodeServiceMode
): void {
  if (mode === 'auto' || mode === 'manual') return;
  if (mode === 'wsl-manual') {
    if (manifest.wsl.detected && manifest.wsl.version === 2) return;
    logger.error(
      'SERVICE_MANAGER_UNSUPPORTED: --service wsl-manual requires running relay-ide inside a WSL2 distro. Native Windows relay-node is unsupported.'
    );
    process.exit(1);
  }
  if (mode !== manifest.serviceManager.kind) {
    logger.error(
      `SERVICE_MANAGER_UNSUPPORTED: --service ${mode} requested, but this node reports ${manifest.serviceManager.kind}. ${manifest.serviceManager.installHint}`
    );
    process.exit(1);
  }
}

function loadNodeCredential(): { nodeId: string; token: string } {
  const credentialPath = path.join(service.CONFIG_DIR, 'node-credential.json');
  if (!fs.existsSync(credentialPath)) {
    logger.error(
      `NODE_LINK_FAILED: no node credential at ${credentialPath}. Run 'relay-ide node connect' first.`
    );
    process.exit(1);
  }
  try {
    const raw = JSON.parse(fs.readFileSync(credentialPath, 'utf8')) as unknown;
    if (typeof raw !== 'object' || raw === null) {
      logger.error(
        `NODE_LINK_FAILED: malformed credential at ${credentialPath}.`
      );
      process.exit(1);
    }
    const parsed = raw as { nodeId?: unknown; token?: unknown };
    if (
      typeof parsed.nodeId !== 'string' ||
      !parsed.nodeId ||
      typeof parsed.token !== 'string' ||
      !parsed.token
    ) {
      logger.error(
        `NODE_LINK_FAILED: malformed credential at ${credentialPath}.`
      );
      process.exit(1);
    }
    return { nodeId: parsed.nodeId, token: parsed.token };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(redactBootstrapSecrets(`NODE_LINK_FAILED: ${message}`));
    process.exit(1);
  }
}

async function runNodeLink(nodeArgs: string[]): Promise<void> {
  const hubUrl = getNodeArg(nodeArgs, '--hub');
  if (!hubUrl) {
    logger.error('Usage: relay-ide node link --hub <url>');
    process.exit(1);
  }
  const credential = loadNodeCredential();
  const configPath = resolveConfigPath();
  let config: Config | undefined;
  try {
    config = loadConfig(configPath) as Config;
  } catch {
    config = undefined;
  }
  // #467: ask the manifest probe which resume mode this host supports
  // so the pty host can pick tmux vs raw without re-probing.
  const initialManifest = await getNodeManifest();
  const sessionResume = initialManifest.capabilities.sessionResume ?? 'none';
  const ptyHost = createNodeLinkPtyHost({
    nodeId: credential.nodeId,
    sessionResume,
  });
  const localRelayNode = createLocalRelayNode({ nodeId: credential.nodeId });
  const rpcHost = createNodeLinkRpcHost({ localRelayNode });
  const client = createNodeLinkClient({
    hubUrl,
    credential,
    getManifest: () => getNodeManifest(),
    getRepoInventory: async () => {
      if (!config) return undefined;
      try {
        return await collectLocalRepoInventory({
          config,
          configPath,
          nodeId: credential.nodeId,
        });
      } catch {
        return undefined;
      }
    },
    onPtyEnvelope: (envelope, ctx) => ptyHost.handle(envelope, ctx),
    onRpcEnvelope: (envelope, ctx) => rpcHost.handle(envelope, ctx),
  });
  await new Promise<void>((resolve) => {
    let exiting = false;
    const finish = (exitCode: number): void => {
      if (exiting) return;
      exiting = true;
      ptyHost.closeAll('node-link client stopping');
      const safetyTimer = setTimeout(() => process.exit(exitCode), 5_000);
      safetyTimer.unref?.();
      void client.stop().then(() => {
        clearTimeout(safetyTimer);
        resolve();
        process.exit(exitCode);
      });
    };
    client.onStateChange((state) => {
      logger.info(`node-link state: ${state}`);
      if (state === 'stopped') finish(0);
    });
    const shutdown = (signal: string) => {
      logger.info(`received ${signal}; closing node-link`);
      finish(0);
    };
    process.once('SIGINT', () => shutdown('SIGINT'));
    process.once('SIGTERM', () => shutdown('SIGTERM'));
    client.start();
  });
}

type NodePairLifecycle = 'connect' | 'install';

async function pairNode(
  nodeArgs: string[],
  lifecycle: NodePairLifecycle = 'connect'
): Promise<void> {
  const hubUrl = getNodeArg(nodeArgs, '--hub');
  const pairToken = getNodeArg(nodeArgs, '--pair-token');
  if (!hubUrl || !pairToken) {
    logger.error(
      'Usage: relay-ide node connect --hub <url> --pair-token <token>'
    );
    process.exit(1);
  }

  try {
    const manifest = await getNodeManifest();
    const exchangeRes = await fetch(
      nodeEndpoint(hubUrl, '/hub/pairing/exchange'),
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          pairToken,
          manifest,
          protocolVersion: RELAY_NODE_LINK_PROTOCOL_VERSION,
        }),
      }
    );
    const exchange = (await exchangeRes.json()) as {
      credential?: { token: string; nodeId: string };
      node?: { displayName: string };
      error?: { code: string; message: string };
    };
    if (!exchangeRes.ok || !exchange.credential) {
      const code =
        exchange.error?.code === 'TOKEN_EXPIRED'
          ? 'PAIR_TOKEN_EXPIRED'
          : 'PAIR_TOKEN_INVALID';
      logger.error(
        redactBootstrapSecrets(
          `${code}: ${exchange.error?.message ?? 'pairing failed'}`
        )
      );
      process.exit(1);
    }

    fs.mkdirSync(service.CONFIG_DIR, { recursive: true });
    const credentialPath = path.join(
      service.CONFIG_DIR,
      'node-credential.json'
    );
    fs.writeFileSync(
      credentialPath,
      `${JSON.stringify(exchange.credential, null, 2)}\n`,
      {
        mode: 0o600,
      }
    );
    fs.chmodSync(credentialPath, 0o600);

    const heartbeatRes = await fetch(
      nodeEndpoint(hubUrl, '/hub/node-heartbeat'),
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${exchange.credential.token}`,
        },
        body: JSON.stringify({
          nodeId: exchange.credential.nodeId,
          protocolVersion: RELAY_NODE_LINK_PROTOCOL_VERSION,
          manifest,
        }),
      }
    );
    if (!heartbeatRes.ok) {
      const body = await heartbeatRes.text();
      logger.error(
        redactBootstrapSecrets(
          `NODE_CONNECT_FAILED: heartbeat rejected: ${body}`
        )
      );
      process.exit(1);
    }

    logger.info(
      `Node paired as ${exchange.node?.displayName ?? exchange.credential.nodeId}.`
    );
    logger.info(`Credential saved to ${credentialPath}.`);
    if (lifecycle === 'install') {
      logger.info(
        'Sent initial heartbeat; node install is pairing plus local service setup only and does not start or maintain /hub/node-link.'
      );
    } else {
      logger.info(
        'Sent initial heartbeat; node connect is pair-only and exits without starting /hub/node-link.'
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(redactBootstrapSecrets(`NODE_CONNECT_FAILED: ${message}`));
    process.exit(1);
  }
}

if (command === 'hub') {
  const hubArgs = args.slice(1);
  const subCommand = hubArgs[0];
  if (subCommand === 'install') {
    runServiceCommand(() => {
      process.env['RELAY_IDE_BACKGROUND'] = '1';
      service.install({
        configPath: resolveConfigPath(),
        port: getArg('--port') ?? String(DEFAULTS.port),
        host: getArg('--host') ?? DEFAULTS.host,
      });
    });
  } else if (subCommand === 'uninstall') {
    runServiceCommand(() => {
      service.uninstall();
    });
  } else if (subCommand === 'status') {
    runServiceCommand(printHubStatus);
  } else if (subCommand === 'logs') {
    runServiceCommand(printHubLogs);
  } else if (
    hubArgs.includes('--bg') &&
    (!subCommand || subCommand.startsWith('-'))
  ) {
    runServiceCommand(() => {
      process.env['RELAY_IDE_BACKGROUND'] = '1';
      service.install({
        configPath: resolveConfigPath(),
        port: getArg('--port') ?? String(DEFAULTS.port),
        host: getArg('--host') ?? DEFAULTS.host,
      });
    });
  } else if (!subCommand || subCommand.startsWith('-')) {
    logger.info('Starting Relay hub web server.');
    // Fall through to the default server startup path below. Keeping this as
    // an alias preserves bare `relay-ide` while making the runtime role explicit.
  } else {
    logger.error(
      'Usage: relay-ide hub [install|uninstall|status|logs] [--port <port>] [--host <host>] [--config <path>]'
    );
    process.exit(1);
  }
}

if (command === 'node') {
  const nodeArgs = args.slice(1);
  const subCommand = nodeArgs[0];
  if (subCommand === 'status') {
    await printNodeStatus();
    process.exit(0);
  }
  if (subCommand === 'logs') {
    await printNodeLogs();
    process.exit(0);
  }
  if (subCommand === 'doctor') {
    await runNodeDoctor(getNodeArg(nodeArgs, '--hub'));
    process.exit(0);
  }
  if (subCommand === 'link') {
    await runNodeLink(nodeArgs);
    process.exit(0);
  }
  if (subCommand === 'connect' || subCommand === 'install') {
    if (subCommand === 'install') {
      const serviceMode = parseNodeServiceMode(
        getNodeArg(nodeArgs, '--service') ?? 'auto'
      );
      const manifest = await getNodeManifest();
      validateNodeServiceMode(manifest, serviceMode);
      logger.info(`Bootstrap service mode requested: ${serviceMode}`);
      logger.info(
        'SSH/Tailscale are bootstrap transports only; current bootstrap does not establish a persistent /hub/node-link.'
      );
      await pairNode(nodeArgs, 'install');
      if (serviceMode === 'manual' || serviceMode === 'wsl-manual') {
        logger.info(
          'Manual service mode requested; paired credentials only. No foreground node process was started.'
        );
        process.exit(0);
      }
      runServiceCommand(() => {
        process.env['RELAY_IDE_BACKGROUND'] = '1';
        service.install({
          configPath: resolveConfigPath(),
          port: getArg('--port') ?? String(DEFAULTS.port),
          host: getArg('--host') ?? DEFAULTS.host,
        });
      });
    } else {
      await pairNode(nodeArgs, 'connect');
      process.exit(0);
    }
  }
  logger.error(
    'Usage: relay-ide node <status|logs|doctor|connect|install|link>'
  );
  process.exit(1);
}

if (command === 'worktree') {
  const wtArgs = args.slice(1);
  const subCommand = wtArgs[0];

  if (!subCommand) {
    logger.error('Usage: relay-ide worktree <add|remove|list> [options]');
    process.exit(1);
  }

  if (subCommand !== 'add') {
    try {
      const result = await execFileAsync('git', ['worktree', ...wtArgs]);
      if (result.stdout) console.log(result.stdout.trimEnd());
    } catch (err: unknown) {
      logger.error(execErrorMessage(err, 'git worktree failed'));
      process.exit(1);
    }
    process.exit(0);
  }

  // Handle 'add' -- strip --yolo, determine path, forward to git, then launch claude
  const hasYolo = wtArgs.includes('--yolo');
  const gitWtArgs = wtArgs.filter(function (a) {
    return a !== '--yolo';
  });
  const addSubArgs = gitWtArgs.slice(1);
  let targetDir: string | undefined;

  const bIdx = gitWtArgs.indexOf('-b');
  const branchForDefault =
    bIdx !== -1 && bIdx + 1 < gitWtArgs.length
      ? gitWtArgs[bIdx + 1]!
      : undefined;

  if (addSubArgs.length === 0 || addSubArgs[0]!.startsWith('-')) {
    let repoRoot: string;
    try {
      const result = await execFileAsync('git', [
        'rev-parse',
        '--show-toplevel',
      ]);
      repoRoot = result.stdout.trim();
    } catch {
      logger.error('Not inside a git repository.');
      process.exit(1);
    }
    const dirName = branchForDefault
      ? branchForDefault.replace(/\//g, '-')
      : 'worktree-' + Date.now().toString(36);
    targetDir = path.join(repoRoot, '.worktrees', dirName);
    gitWtArgs.splice(1, 0, targetDir);
  } else {
    targetDir = path.resolve(addSubArgs[0]!);
  }

  try {
    const result = await execFileAsync('git', ['worktree', ...gitWtArgs]);
    if (result.stdout) console.log(result.stdout.trimEnd());
  } catch (err: unknown) {
    logger.error(execErrorMessage(err, 'git worktree add failed'));
    process.exit(1);
  }

  logger.info(`Worktree created at ${targetDir}`);

  const claudeArgs: string[] = [];
  if (hasYolo) claudeArgs.push('--dangerously-skip-permissions');

  logger.info(
    `Launching claude${hasYolo ? ' (yolo mode)' : ''} in ${targetDir}...`
  );

  const child = spawn('claude', claudeArgs, {
    cwd: targetDir,
    stdio: 'inherit',
    env: { ...process.env, CLAUDECODE: undefined },
  });

  child.on('exit', (code) => {
    process.exit(code ?? 0);
  });

  // Block until child exits via the handler above
  await new Promise(() => {});
}

if (command === 'pin') {
  const subCommand = args[1];
  if (subCommand !== 'reset') {
    logger.error('Usage: relay-ide pin reset');
    process.exit(1);
  }

  if (!process.stdin.isTTY) {
    logger.error('PIN reset requires an interactive terminal.');
    process.exit(1);
  }

  const configPath = resolveConfigPath();
  if (!fs.existsSync(configPath)) {
    logger.error('No config file found. Run relay-ide first to create one.');
    process.exit(1);
  }

  const { loadConfig: loadCfg, saveConfig: saveCfg } =
    await import('../server/config.js');
  const { hashPin, verifyPin } = await import('../server/auth.js');

  const config = loadCfg(configPath);
  const readline = await import('node:readline');

  function prompt(query: string, hidden = false): Promise<string> {
    return new Promise((resolve) => {
      if (hidden) {
        process.stdout.write(query);
        const stdin = process.stdin;
        const wasRaw = stdin.isRaw;
        if (stdin.setRawMode) stdin.setRawMode(true);
        let value = '';
        const onData = (ch: Buffer) => {
          const c = ch.toString('utf8');
          if (c === '\n' || c === '\r') {
            if (stdin.setRawMode) stdin.setRawMode(wasRaw ?? false);
            stdin.removeListener('data', onData);
            process.stdout.write('\n');
            resolve(value);
          } else if (c === '\u007f' || c === '\b') {
            if (value.length > 0) {
              value = value.slice(0, -1);
              process.stdout.write('\b \b');
            }
          } else if (c >= ' ') {
            value += c;
            process.stdout.write('*');
          }
        };
        stdin.on('data', onData);
      } else {
        const rl = readline.createInterface({
          input: process.stdin,
          output: process.stdout,
        });
        rl.question(query, (answer) => {
          rl.close();
          resolve(answer);
        });
      }
    });
  }

  // If PIN exists, optionally verify current PIN.
  // Skipping is intentional: local shell access is proof of ownership
  // (the user could edit the config file directly to delete pinHash).
  if (config.pinHash) {
    const current = await prompt('Current PIN (press Enter to skip): ', true);
    if (current) {
      const valid = await verifyPin(current, config.pinHash);
      if (!valid) {
        logger.error('Current PIN is incorrect.');
        process.exit(1);
      }
    }
  }

  const newPin = await prompt('New PIN: ', true);
  if (!newPin || newPin.length < 4) {
    logger.error('PIN must be at least 4 characters.');
    process.exit(1);
  }

  const confirmPin = await prompt('Confirm new PIN: ', true);
  if (newPin !== confirmPin) {
    logger.error('PINs do not match.');
    process.exit(1);
  }

  config.pinHash = await hashPin(newPin);
  saveCfg(configPath, config);
  logger.info(
    'PIN updated successfully. All existing sessions will need to re-authenticate.'
  );
  process.exit(0);
}

if (
  command === 'install' ||
  command === 'uninstall' ||
  command === 'status' ||
  args.includes('--bg')
) {
  if (command === 'uninstall') {
    runServiceCommand(() => {
      service.uninstall();
    });
  } else if (command === 'status') {
    runServiceCommand(() => {
      const st = service.status();
      logger.info(`Service manager: ${st.manager.label} (${st.manager.kind})`);
      logger.info(st.manager.message);
      if (!st.installed) {
        logger.info('Service is not installed.');
      } else if (st.running) {
        logger.info('Service is installed and running.');
      } else {
        logger.info('Service is installed but not running.');
      }
      if (st.manager.statusCommand) {
        logger.info(`Status command: ${st.manager.statusCommand}`);
      }
      logger.info(
        st.installed ? st.manager.uninstallHint : st.manager.installHint
      );
      for (const caveat of st.manager.caveats) logger.info(caveat);
    });
  } else {
    runServiceCommand(() => {
      process.env['RELAY_IDE_BACKGROUND'] = '1';
      service.install({
        configPath: resolveConfigPath(),
        port: getArg('--port') ?? String(DEFAULTS.port),
        host: getArg('--host') ?? DEFAULTS.host,
      });
    });
  }
}

if (command === 'browser') {
  const browserArgs = args.slice(1);

  if (
    browserArgs.includes('--help') ||
    browserArgs.includes('-h') ||
    browserArgs.length === 0
  ) {
    logger.error(`Usage: relay-ide browser <path>

Opens an HTML file in the remote browser viewer tab.

Arguments:
  <path>    Path to HTML file (absolute or relative)

Environment:
  RELAY_IDE_PORT            Server port (default: 3456)
  RELAY_IDE_BROWSER_TOKEN   Auth token for browser tab API`);
    process.exit(
      browserArgs.includes('--help') || browserArgs.includes('-h') ? 0 : 1
    );
  }

  const filePath = path.resolve(browserArgs[0]!);

  if (!fs.existsSync(filePath)) {
    logger.error(`Error: file not found: ${filePath}`);
    process.exit(1);
  }

  const port = process.env['RELAY_IDE_PORT'] ?? String(DEFAULTS.port);
  const token = process.env['RELAY_IDE_BROWSER_TOKEN'] ?? '';

  if (!token) {
    logger.error(
      'Error: RELAY_IDE_BROWSER_TOKEN not set. Are you running inside a relay-ide session?'
    );
    process.exit(1);
  }

  try {
    const res = await fetch(`http://127.0.0.1:${port}/browser-tabs`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ path: filePath }),
    });

    if (!res.ok) {
      const body = await res.text();
      logger.error(`Error: server returned ${res.status}: ${body}`);
      process.exit(1);
    }

    const data = (await res.json()) as { token: string; refreshed: boolean };
    if (data.refreshed) {
      logger.info(`Refreshed: ${filePath}`);
    } else {
      logger.info(`Opened: ${filePath}`);
    }
    process.exit(0);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`Error: could not connect to server on port ${port}: ${msg}`);
    process.exit(1);
  }
}

const configPath = resolveConfigPath();
const configDir = path.dirname(configPath);

// Ensure config directory exists
if (!fs.existsSync(configDir)) {
  fs.mkdirSync(configDir, { recursive: true });
}

// Pass config path and CLI overrides to the server
process.env['RELAY_IDE_CONFIG'] = configPath;
const portArg = getArg('--port');
if (portArg !== undefined) process.env['RELAY_IDE_PORT'] = portArg;
const hostArg = getArg('--host');
if (hostArg !== undefined) process.env['RELAY_IDE_HOST'] = hostArg;
if (args.includes('--debug-log')) process.env['RELAY_IDE_DEBUG_LOG'] = '1';

await import('../server/index.js');
