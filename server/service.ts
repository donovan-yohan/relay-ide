import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { DEFAULTS } from './config.js';
import type { Platform, ServicePaths, InstallOpts } from './types.js';
import { createLogger } from './logger.js';

const logger = createLogger('service');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SERVICE_LABEL = 'com.claude-remote-cli';
const HOME = process.env.HOME || process.env.USERPROFILE || '~';
const CONFIG_DIR = path.join(HOME, '.config', 'claude-remote-cli');

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
      'claude-remote-cli.service'
    ),
    logDir: null,
    label: 'claude-remote-cli',
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
Description=Claude Remote CLI
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
      'Service is already installed. Run `claude-remote-cli uninstall` first.'
    );
  }

  const nodePath = process.execPath;
  const scriptPath = path.resolve(
    __dirname,
    '..',
    'bin',
    'claude-remote-cli.js'
  );
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
    execSync('systemctl --user enable --now claude-remote-cli', {
      stdio: 'inherit',
    });
  }

  logger.info('Service installed and started.');
  if (logDir) {
    logger.info('Logs: ' + logDir);
  } else {
    logger.info('Logs: journalctl --user -u claude-remote-cli -f');
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
      execSync('systemctl --user disable --now claude-remote-cli', {
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
    execSync('systemctl --user is-active claude-remote-cli', {
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
  install,
  uninstall,
  status,
  SERVICE_LABEL,
  CONFIG_DIR,
};
