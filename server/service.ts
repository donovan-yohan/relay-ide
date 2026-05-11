import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { DEFAULTS } from './config.js';
import type { Platform, ServicePaths, InstallOpts } from './types.js';
import type { NodeServiceManager, WslInfo } from '../shared/node-manifest.js';
import { createLogger } from './logger.js';
import { WORKTREE_DIRS } from './watcher.js';

const logger = createLogger('service');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SERVICE_LABEL = 'com.relay-ide';
const HOME = process.env.HOME || process.env.USERPROFILE || '~';
const CONFIG_DIR = path.join(HOME, '.config', 'relay-ide');
const SYSTEMD_UNIT_NAME = 'relay-ide.service';
const SERVICE_PROBE_TIMEOUT_MS = 2_000;

type ExecSyncLike = typeof execSync;

interface ServiceDetectionDeps {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  home?: string;
  fsExistsSync?: (p: string) => boolean;
  fsReadFileSync?: (p: string, encoding: BufferEncoding) => string;
  execSync?: ExecSyncLike;
  wsl?: WslInfo;
}

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
    return getLaunchdServicePaths(HOME);
  }
  return getSystemdUserServicePaths(HOME);
}

function getLaunchdServicePaths(home: string): ServicePaths {
  return {
    servicePath: path.join(
      home,
      'Library',
      'LaunchAgents',
      SERVICE_LABEL + '.plist'
    ),
    logDir: path.join(home, '.config', 'relay-ide', 'logs'),
    label: SERVICE_LABEL,
  };
}

function getSystemdUserServicePaths(home: string): ServicePaths {
  return {
    servicePath: path.join(
      home,
      '.config',
      'systemd',
      'user',
      SYSTEMD_UNIT_NAME
    ),
    logDir: null,
    label: 'relay-ide',
  };
}

function makeManager(
  manager: Omit<NodeServiceManager, 'caveats'> & { caveats?: string[] }
): NodeServiceManager {
  return {
    ...manager,
    caveats: manager.caveats ?? [],
  };
}

function commandSucceeds(command: string, exec: ExecSyncLike): boolean {
  try {
    exec(command, {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: SERVICE_PROBE_TIMEOUT_MS,
    });
    return true;
  } catch {
    return false;
  }
}

function readOptionalFile(
  filePath: string,
  readFileSync: (p: string, encoding: BufferEncoding) => string
): string {
  try {
    return readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

function detectWslInfo(deps: ServiceDetectionDeps = {}): WslInfo {
  const platform = deps.platform ?? process.platform;
  const env = deps.env ?? process.env;
  const exists = deps.fsExistsSync ?? fs.existsSync;
  const readFile = deps.fsReadFileSync ?? fs.readFileSync;
  if (platform !== 'linux') return { detected: false, version: null, systemd: false };

  const release = readOptionalFile('/proc/sys/kernel/osrelease', readFile);
  const versionText = readOptionalFile('/proc/version', readFile);
  const combined = `${release}\n${versionText}`;
  const envDistro = env['WSL_DISTRO_NAME'];
  const envInterop = env['WSL_INTEROP'];
  const detected = /microsoft|wsl/i.test(combined) || Boolean(envDistro || envInterop);
  if (!detected) return { detected: false, version: null, systemd: false };

  const version: 1 | 2 | null = /wsl2/i.test(combined) || Boolean(envInterop)
    ? 2
    : /microsoft/i.test(combined)
      ? 1
      : null;
  const systemd = exists('/run/systemd/system');
  const base = {
    detected: true,
    version,
    systemd,
    ...(envDistro ? { distroName: envDistro } : {}),
  };
  if (systemd) {
    return { ...base, message: 'WSL detected with systemd available.' };
  }
  return {
    ...base,
    message:
      'WSL detected without systemd. Use manual foreground startup or enable WSL systemd before installing a background service.',
  };
}

function detectServiceManager(
  deps: ServiceDetectionDeps = {}
): NodeServiceManager {
  const platform = deps.platform ?? process.platform;
  const home = deps.home ?? HOME;
  const exec = deps.execSync ?? execSync;
  const wsl = deps.wsl ?? detectWslInfo(deps);

  if (platform === 'darwin') {
    const paths = getLaunchdServicePaths(home);
    return makeManager({
      kind: 'launchd',
      label: 'launchd user agent',
      supported: true,
      installable: true,
      servicePath: paths.servicePath,
      unitName: SERVICE_LABEL,
      statusCommand: `launchctl list ${SERVICE_LABEL}`,
      installHint: 'relay-ide install writes a launchd user agent and starts it with launchctl.',
      uninstallHint: 'relay-ide uninstall unloads the launchd agent and removes the plist.',
      message: 'macOS launchd user agents are supported.',
    });
  }

  if (platform !== 'linux') {
    return makeManager({
      kind: 'unsupported',
      label: 'unsupported platform',
      supported: false,
      installable: false,
      installHint: 'Run relay-ide in the foreground or install your own process supervisor.',
      uninstallHint: 'No Relay-managed service is available on this platform.',
      message: `Unsupported service platform: ${platform}.`,
    });
  }

  const paths = getSystemdUserServicePaths(home);
  if (wsl.detected && !wsl.systemd) {
    return makeManager({
      kind: 'wsl-manual',
      label: 'WSL manual mode',
      supported: false,
      installable: false,
      servicePath: paths.servicePath,
      unitName: SYSTEMD_UNIT_NAME,
      installHint:
        'WSL without systemd cannot use relay-ide install. Start relay-ide in the foreground, or enable systemd in /etc/wsl.conf and restart WSL.',
      uninstallHint:
        'No Relay-managed WSL service is installed in manual mode; stop the foreground process or remove your own supervisor config.',
      message:
        'WSL detected without systemd; Relay cannot safely install a user service here.',
      caveats: [
        'WSL distributions often start without a real user service manager.',
        'Enable systemd explicitly before expecting background service semantics.',
      ],
    });
  }

  const hasSystemctl = commandSucceeds('command -v systemctl', exec);
  const userManagerAvailable =
    hasSystemctl && commandSucceeds('systemctl --user show-environment', exec);

  if (wsl.detected && wsl.systemd && userManagerAvailable) {
    return makeManager({
      kind: 'wsl-systemd',
      label: 'WSL systemd user service',
      supported: true,
      installable: true,
      servicePath: paths.servicePath,
      unitName: SYSTEMD_UNIT_NAME,
      statusCommand: 'systemctl --user status relay-ide',
      installHint:
        'relay-ide install writes a systemd --user unit. If it stops after logout, enable linger with `loginctl enable-linger $USER`.',
      uninstallHint:
        'relay-ide uninstall disables the systemd --user unit and removes it.',
      message: 'WSL systemd user services are available.',
      caveats: [
        'WSL service lifetime still depends on the distribution being running.',
        'Headless/background use may require `loginctl enable-linger $USER`.',
      ],
    });
  }

  if (userManagerAvailable) {
    return makeManager({
      kind: 'systemd-user',
      label: 'systemd user service',
      supported: true,
      installable: true,
      servicePath: paths.servicePath,
      unitName: SYSTEMD_UNIT_NAME,
      statusCommand: 'systemctl --user status relay-ide',
      installHint:
        'relay-ide install writes a systemd --user unit. On headless Linux, run `loginctl enable-linger $USER` so it survives logout.',
      uninstallHint:
        'relay-ide uninstall disables the systemd --user unit and removes it.',
      message: 'systemd --user is available.',
      caveats: [
        'Headless servers may require `loginctl enable-linger $USER` for boot/logout persistence.',
      ],
    });
  }

  if (wsl.detected && wsl.systemd) {
    return makeManager({
      kind: 'wsl-manual',
      label: 'WSL systemd without user manager',
      supported: false,
      installable: false,
      servicePath: paths.servicePath,
      unitName: SYSTEMD_UNIT_NAME,
      installHint:
        'WSL systemd is present, but `systemctl --user` is not available. Start relay-ide manually or fix the user bus before installing.',
      uninstallHint:
        'No Relay-managed user service is available until `systemctl --user` works.',
      message:
        'WSL systemd exists, but the per-user service manager is unavailable.',
      caveats: [
        'Do not assume normal Linux systemd-user behavior in this WSL distribution.',
      ],
    });
  }

  const systemManagerAvailable =
    hasSystemctl && commandSucceeds('systemctl is-system-running --quiet', exec);

  if (systemManagerAvailable) {
    return makeManager({
      kind: 'systemd-system',
      label: 'systemd system service only',
      supported: false,
      installable: false,
      servicePath: paths.servicePath,
      unitName: SYSTEMD_UNIT_NAME,
      statusCommand: 'systemctl status relay-ide',
      installHint:
        'Relay manages per-user units only. Enable the user manager (`loginctl enable-linger $USER`) or install a system unit manually.',
      uninstallHint:
        'relay-ide uninstall only manages per-user units; remove any manual system unit with systemctl as root.',
      message:
        'systemd is present, but the current user manager is unavailable.',
      caveats: [
        'Relay does not write root-owned system units automatically.',
      ],
    });
  }

  return makeManager({
    kind: hasSystemctl ? 'manual' : 'unsupported',
    label: hasSystemctl ? 'manual service mode' : 'unsupported service manager',
    supported: false,
    installable: false,
    servicePath: paths.servicePath,
    unitName: SYSTEMD_UNIT_NAME,
    installHint:
      'No supported user service manager is available. Run relay-ide in the foreground or install your own supervisor.',
    uninstallHint:
      'No Relay-managed service is available; remove any manual supervisor configuration yourself.',
    message: hasSystemctl
      ? 'systemctl exists, but no usable user or system service manager was detected.'
      : 'No supported service manager was detected.',
  });
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
  const manager = detectServiceManager();
  if (!manager.installable) {
    throw new Error(
      `${manager.message}\n${manager.installHint}`
    );
  }

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
  logger.info(manager.installHint);
  for (const caveat of manager.caveats) logger.info(caveat);
  if (logDir) {
    logger.info('Logs: ' + logDir);
  } else {
    logger.info('Logs: journalctl --user -u relay-ide -f');
  }
}

function uninstall(): void {
  const manager = detectServiceManager();
  if (!manager.supported && !manager.servicePath) {
    throw new Error(`${manager.message}\n${manager.uninstallHint}`);
  }

  const platform = getPlatform();
  const { servicePath } = getServicePaths();

  if (!isInstalled()) {
    throw new Error('Service is not installed. ' + manager.uninstallHint);
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
  logger.info(manager.uninstallHint);
}

type ServiceStatus =
  | { installed: false; running: false; manager: NodeServiceManager }
  | { installed: true; running: boolean; manager: NodeServiceManager };

function status(): ServiceStatus {
  const manager = detectServiceManager();
  if (!manager.supported && !manager.servicePath) {
    return { installed: false, running: false, manager };
  }

  if (!isInstalled()) {
    return { installed: false, running: false, manager };
  }

  const running = checkRunning(manager);
  return { installed: true, running, manager };
}

function checkRunning(managerOrPlatform: NodeServiceManager | Platform): boolean {
  if (managerOrPlatform === 'macos') {
    return checkLaunchdRunning();
  }
  if (managerOrPlatform === 'linux') {
    return checkSystemdUserRunning();
  }

  const manager = managerOrPlatform;
  if (manager.kind === 'launchd') return checkLaunchdRunning();
  if (manager.kind === 'systemd-user' || manager.kind === 'wsl-systemd') {
    return checkSystemdUserRunning();
  }
  if (manager.kind === 'systemd-system') {
    try {
      execSync('systemctl is-active relay-ide', {
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: SERVICE_PROBE_TIMEOUT_MS,
      });
      return true;
    } catch (_) {
      return false;
    }
  }
  return false;
}

function checkLaunchdRunning(): boolean {
  try {
    const out = execSync('launchctl list ' + SERVICE_LABEL, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: SERVICE_PROBE_TIMEOUT_MS,
    });
    return !out.includes('"LastExitStatus" = -1');
  } catch (_) {
    return false;
  }
}

function checkSystemdUserRunning(): boolean {
  try {
    execSync('systemctl --user is-active relay-ide', {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: SERVICE_PROBE_TIMEOUT_MS,
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
  detectWslInfo,
  detectServiceManager,
  isInstalled,
  isGlobalInstall,
  resolveGlobalScriptPath,
  install,
  uninstall,
  status,
  checkRunning,
  SERVICE_LABEL,
  CONFIG_DIR,
};
