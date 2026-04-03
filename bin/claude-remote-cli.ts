#!/usr/bin/env node
/* eslint-disable no-console -- CLI entry point, user-facing stdout/stderr output */
import path from 'node:path';
import fs from 'node:fs';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import * as service from '../server/service.js';
import { DEFAULTS } from '../server/config.js';
import { createLogger } from '../server/logger.js';

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
  logger.info(`Usage: claude-remote-cli [options]
       claude-remote-cli <command>

Commands:
  update             Update to the latest version from npm
  install            Install as a background service (survives reboot)
  uninstall          Stop and remove the background service
  status             Show whether the service is running
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
  --config <path>    Path to config.json (default: ~/.config/claude-remote-cli/config.json)
  --debug-log        Enable SDK event debug logging to ~/.config/claude-remote-cli/debug/
  --yolo             With 'worktree add': pass --dangerously-skip-permissions to Claude
  --version, -v      Show version
  --help, -h         Show this help`);
  process.exit(0);
}

if (args.includes('--version') || args.includes('-v')) {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(__dirname, '../../package.json'), 'utf-8')
  ) as { version: string };
  console.log(pkg.version);
  process.exit(0);
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
    logger.info(`Updating claude-remote-cli from ${channel} channel...`);
    await execFileAsync('npm', ['install', '-g', `claude-remote-cli@${tag}`]);
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

if (command === 'worktree') {
  const wtArgs = args.slice(1);
  const subCommand = wtArgs[0];

  if (!subCommand) {
    logger.error(
      'Usage: claude-remote-cli worktree <add|remove|list> [options]'
    );
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
    logger.error('Usage: claude-remote-cli pin reset');
    process.exit(1);
  }

  if (!process.stdin.isTTY) {
    logger.error('PIN reset requires an interactive terminal.');
    process.exit(1);
  }

  const configPath = resolveConfigPath();
  if (!fs.existsSync(configPath)) {
    logger.error(
      'No config file found. Run claude-remote-cli first to create one.'
    );
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
      if (!st.installed) {
        logger.info('Service is not installed.');
      } else if (st.running) {
        logger.info('Service is installed and running.');
      } else {
        logger.info('Service is installed but not running.');
      }
    });
  } else {
    runServiceCommand(() => {
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
    logger.error(`Usage: claude-remote-cli browser <path>

Opens an HTML file in the remote browser viewer tab.

Arguments:
  <path>    Path to HTML file (absolute or relative)

Environment:
  CLAUDE_REMOTE_PORT            Server port (default: 3456)
  CLAUDE_REMOTE_BROWSER_TOKEN   Auth token for browser tab API`);
    process.exit(
      browserArgs.includes('--help') || browserArgs.includes('-h') ? 0 : 1
    );
  }

  const filePath = path.resolve(browserArgs[0]!);

  if (!fs.existsSync(filePath)) {
    logger.error(`Error: file not found: ${filePath}`);
    process.exit(1);
  }

  const port = process.env['CLAUDE_REMOTE_PORT'] ?? String(DEFAULTS.port);
  const token = process.env['CLAUDE_REMOTE_BROWSER_TOKEN'] ?? '';

  if (!token) {
    logger.error(
      'Error: CLAUDE_REMOTE_BROWSER_TOKEN not set. Are you running inside a claude-remote-cli session?'
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
process.env['CLAUDE_REMOTE_CONFIG'] = configPath;
const portArg = getArg('--port');
if (portArg !== undefined) process.env['CLAUDE_REMOTE_PORT'] = portArg;
const hostArg = getArg('--host');
if (hostArg !== undefined) process.env['CLAUDE_REMOTE_HOST'] = hostArg;
if (args.includes('--debug-log')) process.env['CLAUDE_REMOTE_DEBUG_LOG'] = '1';

await import('../server/index.js');
