import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { DEFAULTS } from './config.js';
import type { Platform, ServicePaths, InstallOpts } from './types.js';
import { createLogger } from './logger.js';
import { WORKTREE_DIRS } from './watcher.js';

const logger = createLogger('service');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SERVICE_LABEL = 'com.relay-ide';
const HOME = process.env.HOME || process.env.USERPROFILE || '~';
const CONFIG_DIR = path.join(HOME, '.config', 'relay-ide');

/**
 * Detect whether the current process is running from a global npm install.
 * Returns false for worktrees, local dev builds, and npm link.
 */
function isGlobalInstall(): boolean {
  // Worktree paths contain /.worktrees/ or /.claude/worktrees/
  for (const dir of WORKTREE_DIRS) {
    if (__dirname.includes(path.sep + dir + path.sep)) return false;
  }
  // Global installs live under node's prefix/lib/node_modules/relay-ide
  const nodePrefix = path.resolve(process.execPath, '..', '..');
  const globalModules = path.join(
    nodePrefix,
    'lib',
    'node_modules',
    'relay-ide'
  );
  return __dirname.startsWith(globalModules);
}

/**
 * Resolve the script path for the service file.
 * Always uses the global npm binary to prevent worktrees/dev builds from
 * hijacking the production service. Returns null if no global install found.
 */
function resolveGlobalScriptPath(): string | null {
  // Try to find the global relay-ide binary via node's prefix
  const nodePrefix = path.resolve(process.execPath, '..', '..');
  const globalScript = path.join(
    nodePrefix,
    'lib',
    'node_modules',
    'relay-ide',
    'dist',
    'bin',
    'relay-ide.js'
  );
  if (fs.existsSync(globalScript)) return globalScript;

  // Fallback: use `npm prefix -g` to find the global root
  try {
    const npmPrefix = execSync('npm prefix -g', {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    const npmGlobalScript = path.join(
      npmPrefix,
      'lib',
      'node_modules',
      'relay-ide',
      'dist',
      'bin',
      'relay-ide.js'
    );
    if (fs.existsSync(npmGlobalScript)) return npmGlobalScript;
  } catch (_) {
    // npm not available
  }

  return null;
}

function getPlatform(): Platform {
  if (process.platform === 'darwin') return 'macos';
  if (process.platform === 'linux') return 'linux';
  throw new Error(
    'Unsupported platform: ' +
      process.platform +
      '. Only macOS and Linux are supported.'
  );
}

function getServicePaths(): ServicePaths {
  const platform = getPlatform();
  if (platform === 'macos') {
    return {
      servicePath: path.join(
        HOME,
        'Library',
        'LaunchAgents',
        SERVICE_LABEL + '.plist'
      ),
      logDir: path.join(CONFIG_DIR, 'logs'),
      label: SERVICE_LABEL,
    };
  }
  return {
    servicePath: path.join(
      HOME,
      '.config',
      'systemd',
      'user',
      'relay-ide.service'
    ),
    logDir: null,
    label: 'relay-ide',
  };
}

type ServiceFileOpts = {
  nodePath: string;
  scriptPath: string;
  configPath: string;
  port: string;
  host: string;
  logDir: string | null;
};

function generateServiceFile(
  platform: Platform,
  opts: ServiceFileOpts
): string {
  const { nodePath, scriptPath, configPath, port, host, logDir } = opts;

  if (platform === 'macos') {
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${SERVICE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodePath}</string>
    <string>${scriptPath}</string>
    <string>--config</string>
    <string>${configPath}</string>
    <string>--port</string>
    <string>${port}</string>
    <string>--host</string>
    <string>${host}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${path.join(logDir as string, 'stdout.log')}</string>
  <key>StandardErrorPath</key>
  <string>${path.join(logDir as string, 'stderr.log')}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${process.env.PATH}</string>
  </dict>
</dict>
</plist>`;
  }

  return `[Unit]
Description=Relay IDE
After=network.target

[Service]
Type=simple
ExecStart=${nodePath} ${scriptPath} --config ${configPath} --port ${port} --host ${host}
Restart=on-failure
RestartSec=5
Environment=PATH=${process.env.PATH}

[Install]
WantedBy=default.target`;
}

function isInstalled(): boolean {
  const { servicePath } = getServicePaths();
  return fs.existsSync(servicePath);
}

function install(opts: InstallOpts): void {
  const platform = getPlatform();
  const { servicePath, logDir } = getServicePaths();

  if (isInstalled()) {
    throw new Error(
      'Service is already installed. Run `relay-ide uninstall` first.'
    );
  }

  // Resolve the global binary path once and validate it.
  // The service plist/unit must always point to the global npm binary.
  const scriptPath = resolveGlobalScriptPath();
  if (!scriptPath) {
    throw new Error(
      'Cannot install service: no global relay-ide installation found. ' +
        'Install globally first: npm install -g relay-ide'
    );
  }

  // Validate the resolved path is not inside a worktree
  for (const dir of WORKTREE_DIRS) {
    if (scriptPath.includes(path.sep + dir + path.sep)) {
      throw new Error(
        'Cannot install service: resolved script path is inside a worktree (' +
          scriptPath +
          '). Install relay-ide globally first: npm install -g relay-ide'
      );
    }
  }

  if (!isGlobalInstall()) {
    logger.warn(
      'Running from a non-global path — service will use the global binary at ' +
        scriptPath
    );
  }

  const nodePath = process.execPath;
  const configPath = opts.configPath || path.join(CONFIG_DIR, 'config.json');
  const port = opts.port || String(DEFAULTS.port);
  const host = opts.host || DEFAULTS.host;

  const content = generateServiceFile(platform, {
    nodePath,
    scriptPath,
    configPath,
    port,
    host,
    logDir,
  });

  fs.mkdirSync(path.dirname(servicePath), { recursive: true });
  if (logDir) fs.mkdirSync(logDir, { recursive: true });

  fs.writeFileSync(servicePath, content, 'utf8');

  if (platform === 'macos') {
    execSync('launchctl load -w ' + servicePath, { stdio: 'inherit' });
  } else {
    execSync('systemctl --user daemon-reload', { stdio: 'inherit' });
    execSync('systemctl --user enable --now relay-ide', {
      stdio: 'inherit',
    });
  }

  logger.info('Service installed and started.');
  if (logDir) {
    logger.info('Logs: ' + logDir);
  } else {
    logger.info('Logs: journalctl --user -u relay-ide -f');
  }
}

function uninstall(): void {
  const platform = getPlatform();
  const { servicePath } = getServicePaths();

  if (!isInstalled()) {
    throw new Error('Service is not installed.');
  }

  if (platform === 'macos') {
    try {
      execSync('launchctl unload ' + servicePath, { stdio: 'inherit' });
    } catch (_) {
      // Ignore errors from already-unloaded services
    }
  } else {
    try {
      execSync('systemctl --user disable --now relay-ide', {
        stdio: 'inherit',
      });
    } catch (_) {
      // Ignore errors from already-disabled services
    }
  }

  fs.unlinkSync(servicePath);
  logger.info('Service uninstalled.');
}

type ServiceStatus =
  | { installed: false; running: false }
  | { installed: true; running: boolean };

function status(): ServiceStatus {
  const platform = getPlatform();

  if (!isInstalled()) {
    return { installed: false, running: false };
  }

  const running = checkRunning(platform);
  return { installed: true, running };
}

function checkRunning(platform: Platform): boolean {
  if (platform === 'macos') {
    try {
      const out = execSync('launchctl list ' + SERVICE_LABEL, {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return !out.includes('"LastExitStatus" = -1');
    } catch (_) {
      return false;
    }
  }

  try {
    execSync('systemctl --user is-active relay-ide', {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return true;
  } catch (_) {
    return false;
  }
}

export {
  getPlatform,
  getServicePaths,
  generateServiceFile,
  isInstalled,
  isGlobalInstall,
  resolveGlobalScriptPath,
  install,
  uninstall,
  status,
  SERVICE_LABEL,
  CONFIG_DIR,
};
